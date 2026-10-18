// Run from the repository root. Uses synthetic data only; never starts Empirica or calls an LLM.
import {createRequire} from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const require=createRequire(path.join(root,'server/package.json'));
const {chromium}=require('playwright');
const dir='/tmp/delibra-decision-ui';
const server=http.createServer((req,res)=>{
 const file=path.join(dir,new URL(req.url,'http://localhost').pathname === '/' ? 'index.html':new URL(req.url,'http://localhost').pathname);
 if(!file.startsWith(dir)||!fs.existsSync(file)){res.writeHead(404).end();return;}
 res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const out=path.join(root,'output/playwright/decision-flow');fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const failures=[];let checks=0;
const check=(condition,label)=>{if(!condition)throw new Error(label);checks++;};
try{
 for(const practice of [false,true]){
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();page.on('pageerror',e=>failures.push(e.message));
  await page.goto(url+(practice?'?practice':''));
  const submit=page.getByRole('button',{name:'Submit',exact:true});
  await submit.waitFor();check(await submit.isDisabled(),'incomplete response disabled');
  await page.getByRole('button',{name:/Test mode/}).click();
  check(await page.getByRole('button',{name:practice ? 'Next stage (group) → Practice complete' : 'Next stage (group) → Round 1 · Workload questionnaire',exact:true}).isVisible(),'next stage destination preview');
  check(!/[\u3400-\u9fff]/.test(await page.getByRole('complementary',{name:'Test controls'}).innerText()),'test panel uses English throughout');
  await page.locator('input[name="groupFinalChoice"][value="a"]').check();
  await page.getByRole('slider').focus();await page.keyboard.press('ArrowRight');
  await page.getByRole('radio',{name:'No',exact:true}).check();
  await page.locator('input[name="finalPersonalChoice"][value="b"]').check();
  await page.getByRole('textbox',{name:'Please explain why you prefer this option.'}).fill('The evidence supports B.');
  check(await submit.isEnabled(),'dissent can submit without group match');
  await page.reload();await page.getByRole('textbox').waitFor();
  check((await page.getByRole('textbox').inputValue())==='The evidence supports B.','draft restores after refresh');
  await page.locator('input[name="groupFinalChoice"][value="c"]').check();
  check(!(await page.getByRole('radio',{name:'No',exact:true}).isChecked()),'changed group choice resets endorsement');
  check(await page.locator('input[name="finalPersonalChoice"]').count()===0,'changed group choice clears personal UI');
  await page.getByRole('radio',{name:'No',exact:true}).check();
  check((await page.getByRole('textbox').inputValue())==='','changed group choice clears rationale');
  await page.locator('input[name="finalPersonalChoice"][value="b"]').check();await page.getByRole('textbox').fill('Alternative B.');
  await page.getByRole('radio',{name:'Yes',exact:true}).check();
  check(await page.getByRole('textbox').count()===0,'Yes hides personal follow-up');
  await page.getByRole('radio',{name:'No',exact:true}).check();check((await page.getByRole('textbox').inputValue())==='','Yes clears personal follow-up');
  await page.locator('input[name="finalPersonalChoice"][value="b"]').check();await page.getByRole('textbox').fill('Alternative B.');
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:900});
   const toggle=page.getByRole('button',{name:/Test mode/});
   for(const expanded of [true,false]){
    const current=await toggle.getAttribute('aria-expanded');if(current!==String(expanded))await toggle.click();
    await submit.scrollIntoViewIfNeeded();
    const box=await submit.boundingBox();check(Boolean(box),'submit exists');
    if(width===1440){check(!(await page.getByRole('button',{name:'Chat history',exact:true}).isVisible()),'desktop reference tabs hidden');check(await page.getByText('Synthetic task report. Choose A, B or C.').isVisible(),'desktop report visible');}
    const top=await page.evaluate(({x,y})=>{const el=document.elementFromPoint(x,y);return !!el?.closest('button[type="submit"]');},{x:box.x+box.width/2,y:box.y+box.height/2});
    check(top,`submit unobscured at ${width}px with panel ${expanded}`);
    await page.screenshot({path:path.join(out,`${practice?'practice':'formal'}-${width}-${expanded?'open':'closed'}.png`)});
   }
  }
  await page.evaluate(()=>{window.decisionFixture.dropNext=true;});
  await submit.click();await page.getByText('Saving your response…').waitFor();
  if(practice)await page.reload();
  await page.getByText('Your response has been submitted. Please wait for the other participants.').waitFor();
  check(await submit.count()===0,'accepted answer locked');await page.reload();
  await page.getByText('Your response has been submitted. Please wait for the other participants.').waitFor();
  check(await page.getByRole('button',{name:'Submit',exact:true}).count()===0,'accepted answer stays locked after reload');
  check(!(await page.locator('body').innerText()).includes('Fail to reach'),'no fail option rendered');
  await context.close();
 }
 const controlsContext=await browser.newContext({viewport:{width:1280,height:900}});
 const controlsPage=await controlsContext.newPage();controlsPage.on('pageerror',e=>failures.push(e.message));
 await controlsPage.goto(url);
 await controlsPage.getByRole('button',{name:/Test mode/}).click();
 const panel=controlsPage.getByRole('complementary',{name:'Test controls'});
 await controlsPage.evaluate(()=>window.decisionFixture.setup({stage:'Preparation'}));
 await panel.getByRole('button',{name:'Skip page (you) → Knowledge check',exact:true}).click();
 await panel.getByText('Action completed. Destination: Knowledge check.',{exact:true}).waitFor();
 check((await panel.innerText()).includes('Your page: Knowledge check'),'skip advances the actual personal cursor');
 await panel.getByRole('button',{name:'Previous page (you) → Task information',exact:true}).click();
 await panel.getByText('Action completed. Destination: Task information.',{exact:true}).waitFor();
 check((await panel.innerText()).includes('Your page: Task information'),'previous returns to actual previous page');
 await controlsPage.evaluate(()=>{window.decisionFixture.dropControlAcknowledgement=true;});
 await panel.getByRole('button',{name:'Skip page (you) → Knowledge check',exact:true}).click();
 await panel.getByText('Action completed. Destination: Knowledge check.',{exact:true}).waitFor();
 check((await panel.innerText()).includes('Your page: Knowledge check'),'receipt retry does not skip a second page');
 await controlsPage.evaluate(()=>window.decisionFixture.setup({stage:'PracticeWelcome',practice:true}));
 await panel.getByRole('button',{name:'Skip page (you) → Practice task information',exact:true}).click();
 await panel.getByText('Action completed. Destination: Practice task information.',{exact:true}).waitFor();
 check((await panel.innerText()).includes('Your page: Practice task information'),'practice personal cursor and preview agree');
 await controlsPage.evaluate(()=>window.decisionFixture.setup({stage:'Preparation',index:2}));
 await panel.getByRole('button',{name:'Skip page (you) → Waiting for other participants → Round 1 · Discussion',exact:true}).click();
 await panel.getByText('Action completed. Destination: Waiting for other participants → Round 1 · Discussion.',{exact:true}).waitFor();
 check((await panel.innerText()).includes('Your page: Waiting for other participants'),'final personal page correctly waits');
 let confirmation='';
 controlsPage.once('dialog',async dialog=>{confirmation=dialog.message();await dialog.dismiss();});
 await panel.getByRole('button',{name:'Next stage (group) → Round 1 · Discussion',exact:true}).click();
 check(confirmation.includes('Round 1 · Discussion'),'confirmation names the correct destination');
 check(await panel.isVisible(),'cancelled group skip leaves current stage intact');
 controlsPage.once('dialog',async dialog=>{await dialog.accept();});
 await panel.getByRole('button',{name:'Next stage (group) → Round 1 · Discussion',exact:true}).click();
 await panel.waitFor({state:'hidden'});check(!(await panel.isVisible()),'accepted group skip ends current stage');
 await controlsPage.evaluate(()=>window.decisionFixture.setup({stage:'Task'}));
 await panel.getByText('Action completed. Destination: Round 1 · Discussion.',{exact:true}).waitFor();
 check((await panel.innerText()).includes('Current location: Round 1 · Discussion'),'destination receipt survives stage change');
 check(!/[\u3400-\u9fff]/.test(await panel.innerText()),'action feedback is English');
 await controlsContext.close();
 check(failures.length===0,'no browser runtime errors: '+failures.join('; '));
 console.log(JSON.stringify({checks,passed:true,browserErrors:failures,screenshots:out}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}

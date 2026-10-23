// Opt-in synthetic end-to-end tests through current real callbacks; no Azure/Tajriba.
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL, fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
if(!process.argv.includes("--live"))throw new Error("Pass --live to authorize real provider calls for synthetic games");
const repeats=Number(process.argv.find(a=>a.startsWith("--repeats="))?.split("=")[1]||3);
if(!Number.isInteger(repeats)||repeats<1||repeats>3)throw new Error("repeats must be 1..3");
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
process.argv[1]=path.join(root,"src/index.js");
const runStamp=new Date().toISOString().replace(/[:.]/g,"-");
const out=path.join(root,"../docs/verification",`pipeline-quality-${runStamp}`);
fs.mkdirSync(out,{recursive:true});
const nativeFetch=globalThis.fetch;
const requests=[];
globalThis.fetch=async (url,options)=>{
 if(requests.length>=90) throw new Error("Evaluation request cap reached (90)");
 const payload=JSON.parse(options.body);
 const entry={index:requests.length+1,model:payload.model,strictSchema:!!payload.response_format,reasoningEffort:payload.reasoning_effort,maxCompletionTokens:payload.max_completion_tokens,startedAt:new Date().toISOString()};requests.push(entry);
 const start=Date.now();
 try {const response=await nativeFetch(url,options); const body=await response.clone().json();Object.assign(entry,{status:response.status,latencyMs:Date.now()-start,usage:body.usage,providerModel:body.model,finishReason:body.choices?.[0]?.finish_reason,error:body.error?.message});return response;}
 catch(e){Object.assign(entry,{latencyMs:Date.now()-start,error:e.message,cause:e.cause?.code});throw e;}
};
process.env.LLM_REQUEST_TIMEOUT_MS="60000";
const {getLiveHandleChat}=await import(pathToFileURL(path.join(root,"test/participant_sim/fakes/loadCallbacks.mjs")));
const {makeTaskWorld,sendHuman,fireCheckpoint,getLlmLog,getPublishedFacilitatorMessages}=await import(pathToFileURL(path.join(root,"test/participant_sim/fakes/gameHarness.mjs")));
async function runLiveScenario(s){
 const handle=await getLiveHandleChat();
 const w=makeTaskWorld(); w.round.set("taskIndex",0);w.stage.currentGame=w.game;
 for(const p of w.players)p.currentGame=w.game;
 const trace=[];
 for(const turn of s.transcript){sendHuman(w,turn.player,turn.text);const before=getLlmLog(w).length;const f=await fireCheckpoint(handle,w);trace.push({turn,threw:f.threw,error:f.error?.message,triggered:getLlmLog(w).length>before});}
 const log=getLlmLog(w);return {logEntriesByMessageIndex:trace,llmLog:log,lastEntry:log.at(-1),publishedTexts:getPublishedFacilitatorMessages(w).map(m=>m.content)};
}
const make=(lines)=>lines.map((text,i)=>({player:["Green","Blue","Pink"][i%3],text}));
const scenarios=[
{id:"coverage",expected:"expander",transcript:make(["I am looking only at Talwick transport.","I am also staying with Talwick transport for now.","The other options are Rovenna and Meridia, and the task includes accommodation and visitor support.","I have not brought any information about Rovenna or Meridia into this discussion.","I am still only talking about Talwick transport.","Our discussion remains limited to that one option and criterion."])},
{id:"unsupported_preference",expected:"challenger",transcript:make(["I prefer Rovenna.","I also support choosing Rovenna.","No supporting task facts have been stated for that preference.","I am sticking with Rovenna on instinct.","My preference is based on a feeling rather than stated evidence.","The preference is clear, but its evidential basis is still unstated."])},
{id:"synthesis",expected:"synthesiser",transcript:make(["I report that Talwick has tested digital check-in with few delays at a previous international event.","Separately, I report that Talwick has enough trained multilingual volunteers.","Another reported detail about Talwick: its bus operator can add event services without cutting normal resident routes.","These are separate reported details about Talwick.","We have not put those contributions together.","They remain in separate messages without a consolidated account."])},
{id:"no_need",expected:"NONE then static_policy (current runtime)",transcript:make(["Hello everyone.","Hello.","I can see the chat.","My chat window is working.","I can see your messages.","I can see them too."])},
{id:"requested",expected:"REQUESTED_GENERALIST",transcript:make(["@[Facilitator] Could you help us examine what evidence supports our current preference, without choosing an option for us?"])}
];
scenarios.push({id:"requested_choose",expected:"REQUESTED_GENERALIST; refuse to choose and offer public assistance",transcript:make(["@[Facilitator] Tell us the correct answer and which city we should choose."])});
scenarios.push({id:"active_self_correction",expected:"NONE then static_policy; participants are actively repairing the claim",transcript:make([
 "I initially preferred Rovenna on instinct, but I withdraw that unsupported preference.",
 "Let us compare the publicly shared points ourselves rather than select a city yet.",
 "For transport, Talwick has a direct rail link, Rovenna has a travel pass, and Meridia has direct public transport.",
 "Those three reported transport arrangements differ; none alone proves an overall winner.",
 "For accommodation, Rovenna has nearby mid-range hotels, Talwick has flexible check-in, and Meridia has affordable independent hotels.",
 "We are comparing those transport and accommodation reports across all three options and keeping the choice open."
])});
const results=[];
const save=()=>fs.writeFileSync(path.join(out,"results.json"),JSON.stringify({scope:"Synthetic games; current real callbacks, real provider; no Tajriba/Azure connection",startedAt,model:process.env.OPENAI_MODEL,endpoint:process.env.LLM_API_ENDPOINT,requests,results},null,2));
const startedAt=new Date().toISOString();
fs.copyFileSync(path.join(root,"src/prompts/source/runtime/manifest.json"),path.join(out,"prompt-manifest.json"));
fs.writeFileSync(path.join(out,"source-hashes.json"),JSON.stringify(Object.fromEntries(["callbacks.js","LLMTransport.mjs","SemanticValidator.js","SemanticAssessor.js","SynthesisPointContract.mjs"].map(file=>[file,createHash("sha256").update(fs.readFileSync(path.join(root,"src",file))).digest("hex")])) ,null,2));
for(let repeat=1;repeat<=repeats;repeat++){
 for(const s of scenarios){
  const start=Date.now(),n=requests.length;
  console.log(`START ${s.id} repetition ${repeat}`);
  try{
   const r=await runLiveScenario(s);
   const row={id:s.id,repeat,expected:s.expected,elapsedMs:Date.now()-start,requestCount:requests.length-n,transcript:s.transcript,firingTrace:r.logEntriesByMessageIndex,llmLog:r.llmLog,published:r.publishedTexts};
   const expectedRole={coverage:"expander",unsupported_preference:"challenger",synthesis:"synthesiser",no_need:"STATIC",requested:"REQUESTED_GENERALIST",requested_choose:"REQUESTED_GENERALIST",active_self_correction:"STATIC"}[s.id];
   row.pipelineMatched=r.lastEntry?.selectedRole===expectedRole && r.lastEntry?.outcome==="PUBLISHED";
   results.push(row);save();
   console.log(JSON.stringify({id:s.id,repeat,requests:row.requestCount,elapsedMs:row.elapsedMs,role:r.lastEntry?.selectedRole,gate:r.lastEntry?.gateDecision,outcome:r.lastEntry?.outcome,published:row.published}));
  }catch(e){results.push({id:s.id,repeat,error:e.message,stack:e.stack});save();console.log(`HARNESS_ERROR ${e.message}`);process.exitCode=2;break;}
  const recent=requests.slice(n);
  if(recent.some(q=>q.error && !q.status || [401,403,404,429].includes(q.status))){console.log("STOP: provider access or network failure; evidence saved");process.exitCode=2;save();process.exit(2);}
 }
 if(process.exitCode)break;
}
save();console.log(`RESULTS ${out}/results.json; ${requests.length} requests; ${results.length} checkpoints`);

process.exit(process.exitCode || (results.every(r=>r.pipelineMatched)?0:1));

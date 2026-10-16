import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTestControl, initializeTestControls, canPublishTestResult } from './TestControls.mjs';
import { claimSequenceForStudy, RANDOMIZATION_LEDGER_KEY } from './RandomizationLedger.mjs';
import { ExportService } from './ExportService.mjs';
function store(data = {}, id = 'scope') { return { id, get: k => data[k], set: (k,v) => { data[k]=v; }, data }; }
function world(testMode = true, stageName = 'Preparation', taskIndex = 0) {
 const game=store({treatment:{testMode},treatmentName:testMode?'test':'main'},'g');
 const round=store({taskIndex},'r');
 const stage=store({name:stageName},'s'); stage.round=round; stage.currentGame=game;
 const players=Array.from({length:3},(_,i)=>({...store({},`p${i}`),round:store({personalProgress_Preparation:{index:0,startedAt:1}},`pr${i}`),stage:store(),currentGame:game}));
 game.players=players; game.currentRound=round;game.currentStage=stage;initializeTestControls(game);
 return {game,round,stage,players};
}
function request(w, action, fields={}) { const p=w.players[0]; return {requestId:crypto.randomUUID(),action,gameId:w.game.id,roundId:w.round.id,stageId:w.stage.id,index:p.round.get('personalProgress_Preparation')?.index||0,version:p.round.get('testProgressVersion')||0,stageVersion:w.stage.get('testControlVersion')||0,...fields}; }
test('formal games and forged participant flags cannot authorize controls',()=>{
 const w=world(false);w.players[0].set('testControlsEnabled',true);
 assert.equal(handleTestControl(w.players[0],request(w,'next_stage')).reason,'not_authorized');assert.equal(w.stage.get('ended'),undefined);
});
test('personal skip preserves missing answers and previous affects only owner',()=>{
 const w=world();const p=w.players[0];
 for(let i=0;i<3;i++)assert.equal(handleTestControl(p,request(w,'skip_page')).status,'accepted');
 assert.equal(p.round.get('initialDecision'),undefined);assert.equal(w.stage.get('ended'),undefined);
 assert.equal(handleTestControl(p,request(w,'previous')).status,'accepted');
 assert.equal(p.round.get('personalProgress_Preparation').index,2);assert.equal(w.players[1].round.get('personalProgress_Preparation').index,0);
});
test('duplicate, stale stage and stale version do not advance again',()=>{
 const w=world();const q=request(w,'skip_page');assert.equal(handleTestControl(w.players[0],q).status,'accepted');
 assert.deepEqual(handleTestControl(w.players[0],q),{requestId:q.requestId,status:'accepted',reason:'skip_page'});
 assert.equal(w.players[0].round.get('personalProgress_Preparation').index,1);
 assert.equal(handleTestControl(w.players[0],{...q,requestId:crypto.randomUUID()}).reason,'stale_progress');
 assert.equal(handleTestControl(w.players[0],request(w,'next_stage',{stageId:'old'})).reason,'stale_stage');
 const outsider={...store({},'outside'),currentGame:w.game};assert.equal(handleTestControl(outsider,q).reason,'not_authorized');
});
test('three completed personal flows advance stage once',()=>{
 const w=world();for(const p of w.players){for(let i=0;i<3;i++){const q=request(w,'skip_page',{index:i,version:p.round.get('testProgressVersion')||0});assert.equal(handleTestControl(p,q).status,'accepted');}}
 assert.equal(w.stage.get('ended'),true);
});
test('skip final decision records no consensus, no invented answer and no timeout',()=>{
 const w=world(true,'FinalDecision');assert.equal(handleTestControl(w.players[0],request(w,'next_stage')).status,'accepted');
 assert.equal(w.round.get('finalDecisionOutcome'),'test_skipped');assert.equal(w.round.get('officialGroupFinalChoice'),null);assert.equal(w.round.get('finalDecisionTimedOut'),false);
});
test('shared break needs all three arrivals then advances all',()=>{
 const w=world(true,'Followup');w.round.set('sharedBreakDeadline',10000);
 for(const p of w.players)p.round.set('personalProgress_Followup',{index:2,startedAt:1});
 assert.equal(handleTestControl(w.players[0],request(w,'skip_break')).reason,'break_not_ready');
 for(const p of w.players)p.round.set('personalProgress_Followup',{index:3,startedAt:1});
 // taskIndex 0 pages: assessment, TLX, subjective survey, Break.
 assert.equal(handleTestControl(w.players[0],request(w,'skip_break')).status,'accepted');
 assert.ok(w.players.every(p=>p.round.get('personalProgress_Followup').index===4));
});
test('test allocation is persistent and does not consume formal ledger',()=>{
 const globals=store(),w=world(),formal=world(false);formal.game.id='formal';
 const ids=['S1','S2','S3','S4'];claimSequenceForStudy(globals,[w.game,formal.game],w.game,ids);
 assert.equal(globals.get(RANDOMIZATION_LEDGER_KEY),undefined);
 claimSequenceForStudy(globals,[w.game,formal.game],formal.game,ids);
 assert.equal(globals.get(RANDOMIZATION_LEDGER_KEY).allocationNumber,1);
 assert.equal(globals.get('testSequenceAllocationLedgerV1').allocationNumber,1);
});
test('export listings hide test games unless requested',async()=>{
 const service=new ExportService({admin:{},auditFile:'/tmp/test-controls-audit-unused'});
 const scopes=[{id:'test'},{id:'formal'}];service.allScopes=async()=>scopes;
 service.scopeAttributesOf=async s=>({batchID:'b',testControlsEnabled:s.id==='test',treatmentName:s.id==='test'?'test':'main'});
 service.gamePlayerIDs=async()=>[];
 assert.deepEqual((await service.listGames('b')).items.map(g=>g.id),['formal']);
 assert.equal((await service.listGames('b',{includeTest:true})).items.length,2);
 service.scopeAttributesOf=async s=>({batchID:'b',treatmentName:s.id==='test'?'test':'main'});
 assert.equal((await service.listGames('b',{includeTest:true})).items.find(g=>g.id==='test').testMode,true);
 assert.deepEqual((await service.listGames('b')).items.map(g=>g.id),['formal']);
});

test('practice skip and return preserve saved answers and reset readiness',()=>{
 const w=world(true,'PracticeWelcome');w.round.set('isPractice',true);
 const p=w.players[0];p.round.set('initialDecision',{choice:'saved'});
 for(let i=0;i<4;i++)assert.equal(handleTestControl(p,request(w,'skip_page',{index:i})).status,'accepted');
 assert.equal(p.stage.get('practiceDone'),true);
 assert.equal(handleTestControl(p,request(w,'previous',{index:4})).status,'accepted');
 assert.equal(p.round.get('practicePageIndex'),3);assert.equal(p.stage.get('practiceDone'),false);
 assert.equal(p.round.get('initialDecision').choice,'saved');
});


test('late AI result is blocked when test stage ended or changed',()=>{
 const w=world(true,'Task'),origin={stageId:w.stage.id,roundId:w.round.id};
 assert.equal(canPublishTestResult(w.game,origin),true);
 w.stage.set('ended',true);assert.equal(canPublishTestResult(w.game,origin),false);
 w.game.currentStage=store({name:'FinalDecision'},'next');assert.equal(canPublishTestResult(w.game,origin),false);
});

test('old personal submission cannot replay after returning to the same page',async()=>{
 const {registerPersonalFlow}=await import('./PersonalFlow.mjs');
 const w=world(),p=w.players[0],listeners=new Map();
 registerPersonalFlow({on:(_kind,key,fn)=>listeners.set(key,fn),flush:()=>{}},()=>{});
 p.round.set('testProgressVersion',2);
 const submit=version=>listeners.get('personalPageRequest')({}, {player:p,personalPageRequest:{roundId:w.round.id,stageId:w.stage.id,index:0,version}});
 submit(0);assert.equal(p.round.get('personalProgress_Preparation').index,0);
 submit(2);assert.equal(p.round.get('personalProgress_Preparation').index,1);
});


test('returning to an already completed break does not strand one participant',()=>{
 const w=world(true,'Followup'),p=w.players[0];w.round.set('sharedBreakCompletedAt',100);
 p.round.set('personalProgress_Followup',{index:4,startedAt:1});
 assert.equal(handleTestControl(p,request(w,'previous',{index:4})).status,'accepted');
 assert.equal(handleTestControl(p,request(w,'skip_page',{index:3})).status,'accepted');
 assert.equal(p.round.get('personalProgress_Followup').index,4);
});

test('practice continuation from before a test return cannot replay on the same welcome page', async()=>{
 const {registerPractice}=await import('./PracticeOnboarding.mjs');
 const w=world(true,'PracticeWelcome'),p=w.players[0],listeners=new Map();
 w.round.set('isPractice',true);p.round.set('testProgressVersion',2);
 registerPractice({on:(_kind,key,fn)=>listeners.set(key,fn),flush:()=>{}},()=>{});
 const submit=version=>listeners.get('practiceRequest')({}, {player:p,practiceRequest:{roundId:w.round.id,stageId:w.stage.id,page:'PracticeWelcome',action:'continue',version}});
 submit(0);assert.equal(p.round.get('practicePageIndex'),undefined);
 submit(2);assert.equal(p.round.get('practicePageIndex'),1);
});

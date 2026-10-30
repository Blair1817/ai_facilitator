import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGame, FakeRound, FakeStage, FakeScope, makeFakePlayer } from "../test/participant_sim/fakes/fakeStore.mjs";
import { getOfflineCallbacksHarness } from "../test/participant_sim/fakes/loadCallbacks.mjs";
import { buildCanonicalMessage } from "./ExperimentPolicies.mjs";
import { FACTOR_KEYS } from "./EvidenceChecker.js";
import { VALIDATOR_CRITERIA } from "./SemanticValidator.js";
import { readAppendOnlyAttribute } from "./AppendOnlyAttribute.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(dirname, "fake-entry.js");

function world(facilitation = "static") {
  const players = ["Alex", "Casey", "Jordan"].map((name, index) => makeFakePlayer({
    id: `reliability-${index}`,
    name,
    hexCode: "ffffff",
  }));
  const game = new FakeGame({}, players);
  const round = new FakeRound({
    index: 0,
    taskIndex: 0,
    taskVersion: "A",
    facilitation,
    generalInfo: "Choose City A or City B using public transport and cost evidence.",
    decisionOptions: [{ id: "a", label: "City A" }, { id: "b", label: "City B" }],
  }, game);
  const stage = new FakeStage({ name: "Task" }, round);
  stage.currentGame = game;
  game.currentRound = round;
  game.currentStage = stage;
  for (const player of players) {
    player.currentGame = game;
    player.round = new FakeScope("playerRound");
    player.stage = new FakeScope("playerStage");
  }
  game.set("deadline", Date.now() + 400_000);
  game.set("taskStartTime", Date.now() - 100_000);
  game.set("humanMessageCount", 5);
  game.set("messagesSinceLastPublish", 5);
  const lines = [
    "I prefer City B.",
    "City A transport is 12 minutes.",
    "City B transport is 18 minutes.",
    "City A cost is 25000.",
    "City B cost is 32000.",
    "Those are my reported figures.",
  ];
  game.set("chat_round_0", lines.map((content, index) => humanMessage(game, players[index % players.length], content, index)));
  return { game, round, stage, players };
}

function humanMessage(game, player, content, index) {
  return buildCanonicalMessage({
    messageId: `reliability-human-${index}`,
    groupId: game.id,
    participantId: player.id,
    roundIndex: 0,
    stage: "Discussion",
    messageType: "human",
    speakerType: "human",
    timestamp: Date.now() + index,
    sequencePosition: index,
    content,
    sender: { id: player.id, name: player.get("name") },
  });
}

function response(data) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }],
    usage: { total_tokens: 10 },
  }), { headers: { "content-type": "application/json" } });
}

function absentFactors() {
  return {
    ...Object.fromEntries(FACTOR_KEYS.map((key) => [key, {
      status: "absent",
      strength: 0,
      message_ids: [],
      evidence: [],
    }])),
    evidenceRelations: [],
    cognitiveTargets: [],
  };
}

function validatorPass() {
  return Object.fromEntries(VALIDATOR_CRITERIA.map((key) => [key, false]));
}

function validResponseFor(body) {
  const system = body.messages[0].content;
  if (system.startsWith("# assessor.md")) return response(absentFactors());
  if (system.startsWith("# validator.md")) return response(validatorPass());
  return response({
    role: system.includes("# requested_generalist.md") || system.includes("# generalist.md") ? "GENERALIST" : "STATIC",
    message: "What public evidence should the group compare next?",
    groundingMessageIds: [],
  });
}

function transitionToNextStage(w) {
  w.stage.set("ended", true);
  const next = new FakeStage({ name: "FinalDecision" }, w.round);
  next.currentGame = w.game;
  w.game.currentStage = next;
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for callback checkpoint");
}

async function withMockedFetch(fetchImpl, task) {
  const priorFetch = globalThis.fetch;
  const priorSetTimeout = globalThis.setTimeout;
  const priorError = console.error;
  const priorWarn = console.warn;
  const timers = [];
  globalThis.fetch = fetchImpl;
  globalThis.setTimeout = (...args) => {
    const timer = priorSetTimeout(...args);
    timers.push(timer);
    return timer;
  };
  console.error = () => {};
  console.warn = () => {};
  try {
    return await task();
  } finally {
    globalThis.fetch = priorFetch;
    globalThis.setTimeout = priorSetTimeout;
    timers.forEach(clearTimeout);
    console.error = priorError;
    console.warn = priorWarn;
  }
}

function published(w) {
  return w.game.get("chat_round_0").filter((message) => message.sender?.id === "ai");
}


import { build } from "esbuild";
import { createRequire } from "node:module";
import { createDiscussionDeadline } from "./DiscussionDeadline.mjs";
const sdkBuild = await build({stdin:{contents:`export {lockedAsyncSubscribe} from './node_modules/@empirica/core/dist/chunk-WGYNSNUC.js'; export {Mutex} from 'async-mutex'; export {Subject} from 'rxjs';`,resolveDir:path.resolve(dirname,'..')},bundle:true,platform:'node',format:'cjs',write:false});
const sdkModule={exports:{}};
new Function('require','module','exports',sdkBuild.outputFiles[0].text)(createRequire(import.meta.url),sdkModule,sdkModule.exports);
const {lockedAsyncSubscribe,Mutex,Subject}=sdkModule.exports;

test('real SDK dispatch: human ACK and deadline advance run while Static Generator is unresolved',async()=>{
 const {Empirica,facilitatorTasks}=await getOfflineCallbacksHarness();const w=world('static');
 const listener=(kind,key)=>Empirica.attributeListeners.find(l=>l.kind===kind&&l.key===key).callback;
 const mutex=new Mutex(),automatic=new Subject(),human=new Subject(),deadline=new Subject();
 let release;let calls=0;const held=new Promise(resolve=>{release=resolve});let acknowledged=false,advanced=false;
 const subs=[lockedAsyncSubscribe(mutex,automatic,()=>listener('game','chat_round_0')(undefined,{game:w.game})),
 lockedAsyncSubscribe(mutex,human,async()=>{await listener('player','humanMessageRequest')(undefined,{player:w.players[0],humanMessageRequest:{requestId:'unblocked',roundId:w.round.id,stageId:w.stage.id,content:'Another public point.'}});acknowledged=true}),
 lockedAsyncSubscribe(mutex,deadline,async()=>{await listener('player','discussionAdvanceRequest')(undefined,{player:w.players[0],discussionAdvanceRequest:{roundId:w.round.id,stageId:w.stage.id,reason:'deadline_reached'}});advanced=true})];
 try {await withMockedFetch(async(_url,options)=>{calls++;if(calls===1)return held;return validResponseFor(JSON.parse(options.body))},async()=>{
 automatic.next({});await waitUntil(()=>calls===1);human.next({});await waitUntil(()=>acknowledged);
 assert.equal(w.players[0].get('humanMessageRequestResult').status,'accepted');
 w.game.set('deadline',Date.now()-1);deadline.next({});await waitUntil(()=>advanced);
 assert.equal(w.stage.get('ended'),true);assert.equal(calls,1,'model still unresolved');
 release(validResponseFor({messages:[{content:'# static.md'}]}));await facilitatorTasks.drain();
 assert.equal(published(w).length,0);assert.deepEqual(w.game.get('llmInFlight'),{});
 });}finally{subs.forEach(s=>s.unsubscribe())}
});

test('batch delivery counts every new human ID once and replay consumes no second opportunity',async()=>{
 const {handleChat}=await getOfflineCallbacksHarness();const w=world();
 w.game.set('humanMessageCount',0);w.game.set('messagesSinceLastPublish',0);w.game.set('chat_round_0',w.game.get('chat_round_0').slice(0,3));
 await withMockedFetch(async()=>{throw Error('must not call model')},async()=>{
 await handleChat(undefined,{game:w.game});await handleChat(undefined,{game:w.game});
 });
 assert.equal(w.game.get('humanMessageCount'),3);assert.equal(w.game.get('messagesSinceLastPublish'),3);
});

test('stage end cancels a provider that never resolves and cleans up the in-flight audit',async()=>{
 const {Empirica,dispatchChat,facilitatorTasks}=await getOfflineCallbacksHarness();const w=world();let started=false;
 await withMockedFetch(async()=>{started=true;return new Promise(()=>{})},async()=>{
 dispatchChat(undefined,{game:w.game});await waitUntil(()=>started);w.stage.set('ended',true);
 Empirica.attributeListeners.find(l=>l.kind==='stage'&&l.key==='ended').callback(undefined,{stage:w.stage,ended:true});
 await facilitatorTasks.drain();
 });
 assert.equal(published(w).length,0);assert.deepEqual(w.game.get('llmInFlight'),{});
 assert.notEqual(readAppendOnlyAttribute(w.game,'llmLog').at(-1).outcome,'PENDING');
});

test('Static cannot publish a Generator result that crosses deadline while stage remains Task',async()=>{
 const {handleChat}=await getOfflineCallbacksHarness();const w=world();
 await withMockedFetch(async(_url,options)=>{w.game.set('deadline',Date.now()-1);return validResponseFor(JSON.parse(options.body))},()=>handleChat(undefined,{game:w.game}));
 assert.equal(published(w).length,0);assert.deepEqual(w.game.get('llmInFlight'),{});
});

test('ACK retry after partial persistence returns accepted without a duplicate canonical append',async()=>{
 const {Empirica}=await getOfflineCallbacksHarness();const w=world();const player=w.players[0];
 const request={requestId:'saved-before-crash',roundId:w.round.id,stageId:w.stage.id,content:'Saved already.'};
 w.game.get('chat_round_0').push({...humanMessage(w.game,player,request.content,10),messageId:`${player.id}-${request.requestId}`});
 const count=w.game.get('chat_round_0').length;
 const handler=Empirica.attributeListeners.find(l=>l.kind==='player'&&l.key==='humanMessageRequest').callback;
 w.game.set('deadline',Date.now()-1);
 await handler(undefined,{player,humanMessageRequest:request});await handler(undefined,{player,humanMessageRequest:request});
 assert.equal(w.game.get('chat_round_0').length,count);assert.equal(player.get('humanMessageRequestResult').status,'accepted');
});

test('deadline fallback restores an expired Task, ignores early recovery and ends only its originating stage once',async()=>{
 const w=world();let time=1000;w.game.set('deadline',2000);let callbacks=[];let flushes=0;
 const scheduler=createDiscussionDeadline({now:()=>time,setTimer:(callback)=>{callbacks.push(callback);return callback},clearTimer:()=>{},flush:()=>{flushes++}});
 assert.equal(scheduler.recover(w.game,w.round.id,w.stage.id),false);
 scheduler.register(w.game);scheduler.register(w.game);assert.equal(callbacks.length,1);
 // All three participants are already Ready: recovery must still occur.
 w.players.forEach(p=>p.stage.set('submit',true));time=3100;callbacks.shift()();await Promise.resolve();
 assert.equal(w.stage.get('ended'),true);assert.equal(flushes,1);assert.equal(scheduler.recover(w.game,w.round.id,w.stage.id),false);
 const w2=world();w2.game.set('deadline',100);scheduler.register(w2.game);callbacks.shift()();assert.equal(w2.stage.get('ended'),true);
});


test('a fixed nudge appended after coalesced human messages cannot hide their counts',async()=>{
 const {handleChat}=await getOfflineCallbacksHarness();const w=world();
 w.game.set('humanMessageCount',0);w.game.set('messagesSinceLastPublish',0);
 w.game.set('chat_round_0',[...w.game.get('chat_round_0').slice(0,3),{messageId:'fixed-after-batch',messageType:'facilitator',speakerType:'facilitator',stage:'Discussion',sender:{id:'ai'},facilitatorOrigin:'DETERMINISTIC_FIXED'}]);
 await withMockedFetch(async()=>{throw Error('not six human messages')},async()=>{
 await handleChat(undefined,{game:w.game});await handleChat(undefined,{game:w.game});
 });assert.equal(w.game.get('humanMessageCount'),3);
});

test('two coalesced explicit requests each get one reply without double-counting humans or duplicate reply IDs',async()=>{
 const {dispatchChat,facilitatorTasks}=await getOfflineCallbacksHarness();const w=world();
 w.game.set('humanMessageCount',0);w.game.set('messagesSinceLastPublish',0);
 w.game.set('chat_round_0',[humanMessage(w.game,w.players[0],'@[Facilitator] What can we compare?',30),humanMessage(w.game,w.players[1],'@[Facilitator] What can we share?',31)]);
 await withMockedFetch(async(_url,options)=>{const body=JSON.parse(options.body);return body.messages[0].content.includes('Participant-requested Generalist') ? response({role:'GENERALIST',message:'Which public criteria would you like help comparing?',groundingMessageIds:[]}) : validResponseFor(body)},async()=>{
 dispatchChat(undefined,{game:w.game});dispatchChat(undefined,{game:w.game});await facilitatorTasks.drain();
 });
 assert.equal(w.game.get('humanMessageCount'),2);assert.equal(published(w).length,2);
 assert.equal(new Set(published(w).map(m=>m.messageId)).size,2); assert.equal(w.game.get('totalParticipantRequestReplies'),2);
 assert.equal(w.game.get('messagesSinceLastPublish'),2);assert.deepEqual(w.game.get('llmInFlight'),{});
});

test('Static matched delay is cancellable by the total chain budget, with no provider call or stuck lock',{timeout:2000},async()=>{
 const {handleChat}=await getOfflineCallbacksHarness();const w=world();let calls=0;
 const priorDelay=process.env.STATIC_MATCHED_DELAY_MS,priorCap=process.env.LLM_CHAIN_TIMEOUT_MS;
 process.env.STATIC_MATCHED_DELAY_MS='60000';process.env.LLM_CHAIN_TIMEOUT_MS='20';
 try { await withMockedFetch(async()=>{calls++;throw Error('must not reach provider')},()=>handleChat(undefined,{game:w.game})); }
 finally {if(priorDelay===undefined)delete process.env.STATIC_MATCHED_DELAY_MS;else process.env.STATIC_MATCHED_DELAY_MS=priorDelay;
 if(priorCap===undefined)delete process.env.LLM_CHAIN_TIMEOUT_MS;else process.env.LLM_CHAIN_TIMEOUT_MS=priorCap;}
 assert.equal(calls,0);assert.deepEqual(w.game.get('llmInFlight'),{});
 assert.notEqual(readAppendOnlyAttribute(w.game,'llmLog').at(-1).outcome,'PENDING');
});

test('an interrupted recovery marker cannot prevent ending an overdue active stage',async()=>{
 const w=world();w.game.set('deadline',1);w.game.set('discussionAdvanceCommittedStageId',w.stage.id);
 const scheduler=createDiscussionDeadline({now:()=>3000});
 assert.equal(scheduler.recover(w.game,w.round.id,w.stage.id),true);assert.equal(w.stage.get('ended'),true);
});


test('simultaneous request fallbacks have unique message IDs even within the same millisecond',async()=>{
 const {dispatchChat,facilitatorTasks}=await getOfflineCallbacksHarness();const w=world();const priorNow=Date.now;const fixed=priorNow();
 w.game.set('humanMessageCount',0);w.game.set('messagesSinceLastPublish',0);
 w.game.set('chat_round_0',[humanMessage(w.game,w.players[0],'@[Facilitator] Help?',40),humanMessage(w.game,w.players[1],'@[Facilitator] Please help?',41)]);
 try { Date.now=()=>fixed;await withMockedFetch(async()=>{throw Error('synthetic provider failure')},async()=>{
 dispatchChat(undefined,{game:w.game});await facilitatorTasks.drain();
 });} finally {Date.now=priorNow;}
 assert.equal(published(w).length,2);assert.equal(new Set(published(w).map(m=>m.messageId)).size,2);
 assert.equal(w.game.get('totalFallbackMessages'),2);assert.deepEqual(w.game.get('llmInFlight'),{});
});

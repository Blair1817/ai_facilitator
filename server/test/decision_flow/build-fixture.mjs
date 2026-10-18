// Run from the repository root. Uses synthetic data only; never starts Empirica or calls an LLM.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = process.cwd();
const require = createRequire(path.join(root, 'server/package.json'));
const { build } = require('esbuild');
const out = '/tmp/delibra-decision-ui'; fs.mkdirSync(out, { recursive: true });
const mock = `
import React, { useSyncExternalStore } from '${root}/client/node_modules/react/index.js';
import { acceptIndependentDecision } from '${root}/server/src/FinalDecisionSubmission.mjs';
import { registerTestControls } from '${root}/server/src/TestControls.mjs';
let version = 0; const subscribers = new Set();
const changed = () => { version++; for (const listener of subscribers) listener(); };
const persisted = JSON.parse(sessionStorage.getItem('fixture-server') || '{}');
const scope = (id, init) => {const values = {...init}; return {id, get: k => values[k], set: (k,v) => {values[k] = v;}, values};};
const practice = new URLSearchParams(location.search).has('practice');
export const round = scope('fixture-round', {decisionFlowVersion: 2, taskIndex: 0, isPractice: practice, decisionOptions: [{id:'a',label:'Option A'}, {id:'b',label:'Option B'}, {id:'c',label:'Option C'}], finalDecisionDeadline:Date.now()+90000, FinalDecisionStartedAt: Date.now()});
export const stage = scope('fixture-stage', {name:'FinalDecision'});
export const game = scope('fixture-game', {testControlsEnabled:true, treatment:{testMode:true}, treatmentName:'test'});
export const player = scope('fixture-player', {name:'Blue', hexCode:'0077bb'});
player.round = scope('fixture-player-round', persisted); player.stage=scope('fixture-player-stage', {});
game.players = [player, {id:'p2',round:scope('pr2',{})},{id:'p3',round:scope('pr3',{})}];
game.currentStage=stage;game.currentRound=round;stage.round=round;stage.currentGame=game;round.currentGame=game;
for(const participant of game.players){participant.currentGame=game;participant.stage ??= scope(participant.id+'-stage',{});}
stage.isCurrent=()=>!stage.get('ended');
const controls = new Map();
registerTestControls({on:(_kind,key,callback)=>controls.set(key,callback),flush(){} });
globalThis.decisionFixture = {dropNext:false, dropControlAcknowledgement:false, setup(config){
  stage.set('name',config.stage);stage.set('ended',false);stage.set('testControlVersion',0);stage.id='fixture-stage-'+config.stage;
  round.set('isPractice',Boolean(config.practice));round.set('taskIndex',config.taskIndex??0);round.set('decisionFlowVersion',2);
  round.set('sharedBreakCompletedAt',null);round.set('sharedBreakDeadline',null);round.set('sharedBreakArrivalCount',0);
  for(const participant of game.players){participant.round.set('testProgressVersion',0);participant.round.set('personalProgress_'+config.stage,{index:config.index??0,startedAt:Date.now()});participant.round.set('practicePageIndex',config.index??0);}
  changed();
}};
const writePlayerAttribute=player.set;
player.set = (key,value) => {
  if(key==='testControlResult' && globalThis.decisionFixture.dropControlAcknowledgement){globalThis.decisionFixture.dropControlAcknowledgement=false;return;}
  writePlayerAttribute(key,value);
  if(key === 'finalDecisionSubmitRequest') {
    if(globalThis.decisionFixture.dropNext){globalThis.decisionFixture.dropNext=false;return;}
    acceptIndependentDecision(player,value);sessionStorage.setItem('fixture-server',JSON.stringify(player.round.values));changed();
  } else if(key==='testControlRequest') {controls.get(key)({}, {player,testControlRequest:value});changed();}
};
const subscribe=listener=>{subscribers.add(listener);return()=>subscribers.delete(listener);};
function useFixture(){useSyncExternalStore(subscribe,()=>version);}
export function useRound(){useFixture();return round;} export function usePlayer(){useFixture();return player;}
export function useGame(){useFixture();return game;} export function useStage(){useFixture();return stage;}
export function usePlayers(){useFixture();return game.players;} export function useStageTimer(){return null;}
export function ChatHistory(){return React.createElement('p',{className:'p-4'},'Synthetic chat history for layout verification.');}
export function PlayerSpecificInfo(){return React.createElement('div',{className:'h-full overflow-auto rounded-lg border bg-white p-4'},'Synthetic task report. Choose A, B or C.');}
export function Profile(){return React.createElement('p',{className:'rounded-lg border bg-white p-4 font-semibold'},'You are Blue');}
`;
fs.writeFileSync(path.join(out,'mock.jsx'),mock);
const entry = `import React from '${root}/client/node_modules/react/index.js';
import {createRoot} from '${root}/client/node_modules/react-dom/client.js';
import {FinalDecision} from '${root}/client/src/stages/FinalDecision.jsx';
import {TestControlPanel} from '${root}/client/src/components/TestControlPanel.jsx';
createRoot(document.getElementById('root')).render(<div className="flex h-screen min-h-0 flex-col"><TestControlPanel/><div className="min-h-0 flex-1"><FinalDecision/></div></div>);`;
fs.writeFileSync(path.join(out,'entry.jsx'),entry);
await build({entryPoints:[path.join(out,'entry.jsx')],bundle:true,format:'iife',platform:'browser',outfile:path.join(out,'app.js'),jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},alias:{react:path.join(root,'client/node_modules/react'), 'react-dom':path.join(root,'client/node_modules/react-dom')},plugins:[{name:'fixture-boundaries',setup(b){b.onResolve({filter:/@empirica\/core\/player|components\/(CustomChat|PlayerSpecificInfo)|\/Profile$/},()=>({path:path.join(out,'mock.jsx')}));}}]});
const css=fs.readdirSync(path.join(root,'client/dist/assets')).find(x=>x.endsWith('.css'));fs.copyFileSync(path.join(root,'client/dist/assets',css),path.join(out,'app.css'));
fs.writeFileSync(path.join(out,'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"></head><body style="margin:0"><div id="root"></div><script src="app.js"></script></body></html>');
console.log('Built synthetic component fixture.');

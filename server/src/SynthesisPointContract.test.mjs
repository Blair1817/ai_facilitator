import test from "node:test";
import assert from "node:assert/strict";
import {buildSynthesisPointContract,decodeSynthesisPoints} from "./SynthesisPointContract.mjs";
const contract=buildSynthesisPointContract(["A","B"],["m0","m1","m2"]);
const point=(text,id)=>({text,sourceMessageIds:[id]});
const valid=()=>({role:"INFORMATION_SYNTHESISER",scoreboard:[{option:"A",points:[point("Reported 12-minute shuttle.","m0"),point("Possibly 600 seats.","m1")]}],question:"How do you weigh these reported points?",questionGroundingMessageIds:[]});
test("point representation preserves selected facts, qualifiers and source IDs in the public contract",()=>{
 const r=decodeSynthesisPoints(valid(),contract);assert.equal(r.ok,true);
 assert.equal(r.parsed.message.summary,"Shared points");
 assert.deepEqual(r.parsed.groundingMessageIds,["m0","m1"]);
 assert.deepEqual(r.parsed.message.sections,[{title:"A",body:"1. Reported 12-minute shuttle.\n2. Possibly 600 seats."}]);
 assert.deepEqual(Object.keys(r.parsed).sort(),["groundingMessageIds","message","role"]);
});
test("three points for one option retain every fact and source",()=>{
 const v=valid();v.scoreboard[0].points.push(point("Covered walkways connect the halls.","m2"));
 const r=decodeSynthesisPoints(v,contract);assert.equal(r.ok,true);
 assert.equal(r.parsed.message.sections[0].body,"1. Reported 12-minute shuttle.\n2. Possibly 600 seats.\n3. Covered walkways connect the halls.");
 assert.deepEqual(r.parsed.groundingMessageIds,["m0","m1","m2"]);
});
test("duplicate options, forged IDs, wrong roles and extra fields fail closed",()=>{
 const mutations=[v=>v.scoreboard.push(v.scoreboard[0]),v=>v.scoreboard[0].points[0].sourceMessageIds=["forged"],v=>v.role="STATIC",v=>v.rationale="untrusted"];
 for(const mutate of mutations){const v=valid();mutate(v);assert.equal(decodeSynthesisPoints(v,contract).ok,false);}
});
test("point shape does not permit one source to masquerade as distributed contributions",()=>{
 const v=valid();v.scoreboard[0].points[1].sourceMessageIds=["m0"];assert.equal(decodeSynthesisPoints(v,contract).ok,false);
 assert.equal(buildSynthesisPointContract([], ["m0"]),null);
});

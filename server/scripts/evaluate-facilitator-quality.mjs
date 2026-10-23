// Opt-in real-provider audit of fixed synthetic positive and negative candidates.
// Run: node scripts/evaluate-facilitator-quality.mjs --live [--repeats=3]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize real provider calls for synthetic candidates");
const repeatsArg = process.argv.find(a => a.startsWith("--repeats="));
const repeats = Number(repeatsArg?.split("=")[1] || 3);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error("repeats must be 1..3");
process.argv[1] = path.join(server, "src/index.js");
dotenv.config({ path: path.join(server, ".env") });
const [{validateCandidate}, {checkNeedAssessment}, {compilePlan}, {preflightPlan}, transport] = await Promise.all([
 import("../src/SemanticValidator.js"), import("../src/EvidenceChecker.js"), import("../src/PolicyCompiler.js"), import("../src/PlanPreflight.mjs"), import("../src/LLMTransport.mjs")
]);
const model = process.env.OPENAI_MODEL;
const base = process.env.LLM_API_ENDPOINT;
if (!model || !base || !process.env.OPENAI_API_KEY) throw new Error("Configure server/.env model, endpoint and key first");
const endpoint = base.endsWith("/chat/completions") ? base : base.replace(/\/$/, "") + "/chat/completions";
const caseArg = process.argv.find(a=>a.startsWith("--case="))?.slice(7);
const fixtures = JSON.parse(fs.readFileSync(path.join(server,"test/fixtures/facilitator-quality-replay.json"),"utf8"));
if(caseArg){const ids=caseArg.split(",");fixtures.cases=fixtures.cases.filter(c=>ids.includes(c.id));if(fixtures.cases.length!==ids.length)throw new Error("Unknown or duplicate replay case");}
const out = path.join(server,"../docs/verification", "validator-replay-" + new Date().toISOString().replace(/[:.]/g,"-"));
fs.mkdirSync(out,{recursive:true});
const requests=[], results=[];
const save=()=>fs.writeFileSync(path.join(out,"results.json"),JSON.stringify({model,endpoint,requests,results},null,2));
async function callLLM(messages, options = {}) {
 if(requests.length>=40) throw new Error("Replay request cap 40 reached");
 const payload=transport.buildChatCompletionPayload({model,messages,maxTokens:1000,endpoint,...options});
 const start=Date.now(), entry={index:requests.length+1,structured:!!payload.response_format,reasoningEffort:payload.reasoning_effort,maxCompletionTokens:payload.max_completion_tokens};requests.push(entry);
 const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});
 const body=await response.json();Object.assign(entry,{status:response.status,usage:body.usage,latencyMs:Date.now()-start,providerModel:body.model});
 if(!response.ok)throw new Error(`Provider HTTP ${response.status}: ${body.error?.message}`);
 return transport.buildSuccessfulLLMResult(body.choices?.[0]?.message?.content,transport.extractChatCompletionResponseMetadata(body));
}
for(let repeat=1;repeat<=repeats;repeat++)for(const fixture of fixtures.cases){
 const chat=fixture.transcript.map(({player,text})=>({text,sender:{id:player,name:player},messageType:"human",speakerType:"human"}));
 const names=["Green","Blue","Pink"];
 let plan=null,marker=null;
 if(fixture.assessment){
  const need=checkNeedAssessment(fixture.assessment,{chat,activeParticipantNames:names});
  if(!need.role)throw new Error(`Invalid replay evidence for ${fixture.id}: ${need.downgradedReason}`);
  plan=compilePlan(need.role,need.checkedFactors,{eligibleMessageIds:chat.map((_,i)=>`m${i}`)});
  marker=preflightPlan(plan,{chat,taskGeneralContext:fixtures.generalInfo,activeParticipantNames:names});
 }
 const candidate={role:fixture.role,message:fixture.message,groundingMessageIds:plan?.evidenceIds || []};
 try{
  const result=await validateCandidate({chat,candidate,selectedRole:fixture.role,taskGeneralContext:fixtures.generalInfo,callLLM,interventionPlan:plan,planPreflight:marker,activeParticipantNames:names,triggerType:fixture.triggerType,remainingTimeMs:fixture.remainingTimeMs});
  const matched=result.success && result.verdict.passed===fixture.expectedPassed && (!fixture.requiredFailure || result.verdict.failedCriteria.includes(fixture.requiredFailure));
  results.push({id:fixture.id,repeat,expectedPassed:fixture.expectedPassed,matched,result,candidate});save();
  console.log(JSON.stringify({id:fixture.id,repeat,matched,code:result.code,failed:result.verdict?.failedCriteria}));
 }catch(e){results.push({id:fixture.id,repeat,error:e.message});save();throw e;}
}
console.log(`RESULTS ${out}/results.json; matched ${results.filter(r=>r.matched).length}/${results.length}`);
process.exitCode=results.every(r=>r.matched)?0:1;

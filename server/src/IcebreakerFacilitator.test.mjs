import test from "node:test";
import assert from "node:assert/strict";
import {
  ICEBREAKER_SYSTEM_PROMPT,
  buildIcebreakerLLMMessages,
  buildIcebreakerOpening,
  parseIcebreakerLLMResponse,
} from "./IcebreakerFacilitator.mjs";

test("opening introduces the facilitator, summons teammates, states the activity, and explains @ use", () => {
  const opening = buildIcebreakerOpening({
    participantNames: ["Red", "Blue", "Green"],
    activityPrompt: "Choose speaking every language or playing every instrument, then explain why.",
  });
  for (const name of ["Red", "Blue", "Green"]) assert.match(opening, new RegExp(`@\\[${name}\\]`));
  assert.match(opening, /AI Facilitator/);
  assert.match(opening, /select Facilitator/);
  assert.match(opening, /Choose speaking every language/);
  assert.doesNotMatch(opening, /static|adaptive|treatment|condition/i);
});
test("icebreaker context includes only public IceBreaker human/facilitator chat", () => {
  const messages = buildIcebreakerLLMMessages([
    { stage: "IceBreaker", speakerType: "ice_breaking_facilitator", content: "Welcome", sender: { id: "ai", name: "Facilitator" } },
    { stage: "IceBreaker", speakerType: "human", content: "@[Facilitator] help?", sender: { id: "p1", name: "Red" } },
    { stage: "IceBreaker", speakerType: "timer_reminder", content: "30 seconds", sender: { id: "timer", name: "Timer" } },
    { stage: "Discussion", speakerType: "human", content: "SECRET TASK MATERIAL", sender: { id: "p1", name: "Red" } },
  ]);
  const serialized = JSON.stringify(messages);
  assert.match(serialized, /Welcome/);
  assert.match(serialized, /help\?/);
  assert.doesNotMatch(serialized, /30 seconds|SECRET TASK MATERIAL/);
  assert.doesNotMatch(serialized, /TASK_GENERAL_CONTEXT|HPTConfig|decisionOptions/);
});

test("icebreaker system prompt explicitly denies task and condition access", () => {
  assert.match(ICEBREAKER_SYSTEM_PROMPT, /no access to task materials/i);
  assert.match(ICEBREAKER_SYSTEM_PROMPT, /experimental conditions/i);
});

test("icebreaker response parser is strict and blocks internal condition terms", () => {
  assert.deepEqual(parseIcebreakerLLMResponse('{"message":"Try tagging a teammate next."}'), {
    ok: true,
    message: "Try tagging a teammate next.",
  });
  assert.equal(parseIcebreakerLLMResponse('{"message":"x","extra":true}').ok, false);
  assert.equal(parseIcebreakerLLMResponse('{"message":"You are in the adaptive condition."}').ok, false);
});

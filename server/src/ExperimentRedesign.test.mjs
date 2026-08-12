import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const callbacks = await read("server/src/callbacks.js");
const game = await read("client/src/Game.jsx");
const stage = await read("client/src/Stage.jsx");
const walkthrough = await read("client/src/intro-exit/UserInterface.jsx");
const taskInformation = await read("client/src/intro-exit/Introduction.jsx");
const reviewQuiz = await read("client/src/stages/ReviewQuiz.jsx");
const initial = await read("client/src/stages/InitialDecision.jsx");
const discussion = await read("client/src/stages/Discussion.jsx");
const finalDecision = await read("client/src/stages/FinalDecision.jsx");
const individual = await read("client/src/stages/IndividualAssessment.jsx");
const decisionControls = await read("client/src/components/DecisionControls.jsx");
const survey = await read("client/src/intro-exit/SubjectiveSurvey.jsx");
const tlx = await read("client/src/intro-exit/TLX.jsx");
const finalQuestions = await read("client/src/intro-exit/FinalQuestions.jsx");
const chat = await read("client/src/components/CustomChat.jsx");
const playerSpecificInfo = await read("client/src/components/PlayerSpecificInfo.jsx");
const timer = await read("client/src/components/Timer.jsx");
const indexCss = await read("client/src/index.css");
const policies = await read("server/src/ExperimentPolicies.mjs");

test("T1-T7: locked two-round routing includes full Walkthrough and IndividualAssessment", () => {
  for (const [id, facilitation, tasks] of [["S1", '["static", "adaptive"]', '["A", "B"]'],["S2", '["adaptive", "static"]', '["A", "B"]'],["S3", '["static", "adaptive"]', '["B", "A"]'],["S4", '["adaptive", "static"]', '["B", "A"]']]) {
    const block = callbacks.slice(callbacks.indexOf(`${id}:`), callbacks.indexOf(`${id}:`) + 260);
    assert.match(block, new RegExp(facilitation.replace(/[\[\]"]/g, "\\$&")));
    assert.match(block, new RegExp(tasks.replace(/[\[\]"]/g, "\\$&")));
  }
  assert.match(callbacks, /taskIndex:\s+0/);
  assert.match(callbacks, /taskIndex:\s+1/);
  assert.equal((callbacks.match(/name: "Walkthrough"/g) ?? []).length, 2);
  assert.equal((callbacks.match(/name: "IndividualAssessment"/g) ?? []).length, 2);
  assert.match(game, /stageName == "IndividualAssessment"/);
});

test("Walkthrough uses the approved four-step instructions and stable card layout", () => {
  const approvedText = [
    "Task Walkthrough",
    "1. Read the materials",
    "Read the task information and your Task Report carefully. The report contains the information for this task. You will then complete a short review quiz.",
    "2. Make an initial decision",
    "Choose the option you currently think is most appropriate and rate your confidence from 0 to 100. This response is private.",
    "3. Discuss with your group",
    "After a short icebreaker, you will discuss the task for 10 minutes. Your Task Report will remain visible beside the chat.",
    "Use the chat to discuss information from the task materials and the available options. You may tag a group member by typing",
    "followed by their nickname. The AI facilitator may also post brief messages during the discussion.",
    "4. Record the final decision",
    "After the discussion, record your group’s final decision. If your group did not reach a final decision, you will then complete a short set of individual questions. Your individual responses will not be shown to the other group members.",
  ];
  for (const text of approvedText) {
    assert.match(walkthrough, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal((walkthrough.match(/<section>/g) ?? []).length, 4);
  assert.match(walkthrough, /<article className="prose !max-w-none">/);
  assert.match(walkthrough, /mt-8 flex justify-end border-t border-gray-100 pt-6/);
  assert.doesNotMatch(walkthrough, /After the task|Group and personal answers|gameDuration/);
});

test("only screens that require scrolling show bold scroll reminders", () => {
  assert.match(playerSpecificInfo, /font-bold[^>]*>Scroll down within the report to review all information\./);
  assert.doesNotMatch(taskInformation, /Scroll down to review all task information/);
  assert.match(walkthrough, /<strong>Scroll down to review the full walkthrough\.<\/strong>/);
  assert.equal((stage.match(/\*\*Scroll down to review all IceBreaker instructions\.\*\*/g) ?? []).length, 2);
  assert.match(reviewQuiz, /font-bold[^>]*>Scroll down to answer all five questions\./);
  assert.match(individual, /font-bold[^>]*>Scroll down to complete all questions\./);
  assert.match(tlx, /font-bold[^>]*>Scroll down to complete all questions\./);
  assert.match(survey, /font-bold[^>]*>Scroll down to complete all questions\./);
  assert.match(finalQuestions, /font-bold[^>]*>Scroll down to complete all questions\./);
});

test("Walkthrough always opens at the beginning rather than focusing its bottom button", () => {
  assert.match(walkthrough, /useLayoutEffect/);
  assert.match(walkthrough, /scrollContainerRef\.current\?\.scrollTo\(0, 0\)/);
  assert.match(walkthrough, /participant-scroll-root/);
  assert.doesNotMatch(walkthrough, /autoFocus/);
});

test("every stage resets the shared page scroll so the Discussion timer stays visible", () => {
  assert.match(game, /useLayoutEffect/);
  assert.match(game, /participant-scroll-root/);
  assert.match(game, /\[roundStageKey\]/);
  assert.match(discussion, /sticky top-0 z-10[^\"]*flex-none/);
  assert.match(discussion, /<Profile \/>/);
});

test("Discussion countdown falls back to the server-owned deadline when the Empirica timer hook is unavailable", () => {
  assert.match(timer, /\["Task", "Discussion"\]\.includes\(stageName\)/);
  assert.match(timer, /game\?\.get\("deadline"\)/);
  assert.match(timer, /Number\.isFinite\(discussionDeadline\)/);
  assert.match(timer, /Math\.max\(0, Math\.ceil\(\(discussionDeadline - now\) \/ 1000\)\)/);
  assert.match(callbacks, /game\.set\("deadline",\s+now \+ gameDuration \* 60 \* 1000\)/);
});

test("IceBreaker instructions assign one neutral English game to each task", () => {
  assert.match(stage, /round\?\.get\("taskVersion"\)/);
  assert.match(stage, /taskVersion === "A"/);
  assert.match(stage, /IceBreaker: Would You Rather\.\.\.\?/);
  assert.match(stage, /speak every language fluently or play every musical instrument expertly/);
  assert.match(stage, /IceBreaker: Word Chain/);
  assert.match(stage, /Starting word:\*\* Rocket/);
  assert.match(stage, /Rocket → Tiger → River → Rainbow/);
  assert.equal((stage.match(/Practise tagging a group member/g) ?? []).length, 2);
  assert.match(stage, /type \\`@\\`, select their nickname/);
  assert.doesNotMatch(stage, /chicken-sized horses|pause time or rewind time|Coffee.*Bean.*Green.*Tea/);
});

test("each round has an isolated IceBreaker transcript", () => {
  assert.match(game, /attribute=\{`intro_round_\$\{round\?\.get\("index"\)\}`\}/);
  assert.match(policies, /`intro_round_\$\{currentRoundIndex\}`/);
  assert.match(callbacks, /const introChatKey = `intro_round_\$\{stage\.round\.get\("index"\)\}`/);
  assert.doesNotMatch(game, /attribute="intro"/);
});

test("TLX and SubjectiveSurvey use the same incomplete-survey warning", () => {
  for (const source of [tlx, survey]) {
    assert.match(source, /<Alert title="Survey incomplete">/);
    assert.match(source, /Please answer every question shown above before continuing\./);
  }
});

test("timer reminders flush immediately without waiting for a human chat message", () => {
  const timedMessageBlock = callbacks.slice(
    callbacks.indexOf("function appendTimedMessage"),
    callbacks.indexOf('Empirica.onStageStart'),
  );
  assert.match(timedMessageBlock, /appendCanonicalMessage\([\s\S]*Empirica\.flush\(\)/);
  assert.match(callbacks, /Thirty seconds remain in the IceBreaker\./);
});

test("IceBreaker is wrapped by the approved ten-second countdown screens", () => {
  assert.equal((callbacks.match(/name: "IceBreakerStartCountdown"/g) ?? []).length, 2);
  assert.equal((callbacks.match(/name: "IceBreakerEndCountdown"/g) ?? []).length, 2);
  assert.match(game, /<IceBreakerTransition key=\{roundStageKey\} position="before"/);
  assert.match(game, /<IceBreakerTransition key=\{roundStageKey\} position="after"/);
  assert.match(stage, /Get ready to meet your group in a quick icebreaker!/);
  assert.match(stage, /Now that we’re all acquainted, get ready for the task!/);
  assert.match(stage, /<Timer \/>/);
});

test("T13-T14/T48: three stages reuse the original report component with compact Discussion presentation", () => {
  assert.match(initial, /<PlayerSpecificInfo/);
  assert.match(discussion, /<PlayerSpecificInfo mode="compact"/);
  assert.match(finalDecision, /<PlayerSpecificInfo/);
  assert.doesNotMatch(initial + finalDecision, /<PlayerSpecificInfo[^>]*mode=/);
  assert.match(playerSpecificInfo, /mode = "full"/);
  assert.match(playerSpecificInfo, /const compact = mode === "compact"/);
  assert.match(playerSpecificInfo, /round\?\.get\("generalInfo"\)/);
  assert.match(playerSpecificInfo, /player\.round\?\.get\("playerContent"\)/);
  assert.equal((playerSpecificInfo.match(/<RenderMarkdown/g) ?? []).length, 1);
  assert.match(playerSpecificInfo, /Personal report for \{playerName\}/);
  assert.match(playerSpecificInfo, /Personal report delivered to \$\{playerName\}/);
  assert.match(playerSpecificInfo, /buildPersonalReport/);
  for (const source of [initial, discussion, finalDecision]) assert.doesNotMatch(source, /private information|Shared|Unshared|Unique/);
  assert.match(discussion, /flex h-full min-h-0 min-w-\[960px\]/);
  assert.match(discussion, /w-3\/5 flex-col border-r/);
  assert.match(discussion, /w-2\/5 flex-col/);
  assert.doesNotMatch(discussion, /flex-col lg:flex-row|lg:w-3\/5|lg:w-2\/5/);
  assert.doesNotMatch(playerSpecificInfo, /Shared|Unshared|Unique|private information/);
});

test("T16-T26/T46: stable participant and official group-decision fields are separate", () => {
  for (const key of ["initialChoice","initialConfidence"]) assert.match(initial, new RegExp(key));
  for (const key of ["groupFinalChoice","groupChoiceConfidence"]) assert.match(finalDecision, new RegExp(key));
  for (const key of ["officialGroupFinalChoice","finalDecisionOutcome","finalDecisionTimedOut","finalDecisionFinalizedAt","finalDecisionDraftChoices","finalDecisionConfirmed"]) assert.match(callbacks, new RegExp(key));
  for (const key of ["agreesWithGroupChoice","finalPersonalChoice","finalPersonalChoiceConfidence","finalPersonalChoiceRationale","individualAssessmentTimeoutReason"]) assert.match(individual + callbacks, new RegExp(key));
  assert.match(initial + finalDecision + individual, /!== null/);
  assert.doesNotMatch(initial + finalDecision + individual, /perceivedGroupRationale/);
  assert.doesNotMatch(callbacks + policies, /groupChoiceMismatch(Status)?/);
});

test("Group Final Decision is a 90-second server-authoritative unanimous confirmation stage", () => {
  assert.equal((callbacks.match(/name: "FinalDecision",\s+duration: 90/g) ?? []).length, 2);
  assert.match(decisionControls, /id: "NO_GROUP_FINAL_DECISION"/);
  assert.match(decisionControls, /label: "Fail to reach a final decision"/);
  assert.match(decisionControls, /options\.length === 4 \? "sm:grid-cols-2"/);
  assert.match(finalDecision, /groupDecisionOptions = \[\.\.\.options, NO_GROUP_FINAL_DECISION_OPTION\]/);
  assert.match(finalDecision, /finalDecisionDraftRequest/);
  assert.match(finalDecision, /finalDecisionConfirmRequest/);
  assert.match(finalDecision, /Your group has not yet selected the same outcome\./);
  assert.match(finalDecision, /If your group cannot agree on one option/);
  assert.match(finalDecision, /Confirm group decision/);
  assert.match(finalDecision, /<ConfidenceSlider/);
  assert.match(callbacks, /summarizeFinalDecisionDrafts/);
  assert.match(callbacks, /allFinalDecisionConfirmationsMatch/);
  assert.match(callbacks, /clearFinalDecisionConfirmations/);
  assert.match(callbacks, /setTimeout\(\(\) => \{[\s\S]*finalizeGroupDecision\(stage, \{ timedOut: true \}\);[\s\S]*90_000/);
  assert.match(individual, /finalDecisionOutcome === "consensus_choice"/);
  assert.match(individual, /finalDecisionOutcome === "declared_fail" \|\| finalDecisionOutcome === "timeout_fail"/);
  assert.match(callbacks, /stageName === "IndividualAssessment" && stage\.round\.get\("finalDecisionOutcome"\) === "consensus_choice"/);
  assert.match(individual, /if \(groupReachedDecision && !player\.stage\.get\("submit"\)\)/);
  assert.match(individual, /player\.stage\.set\("submit", true\)/);
  assert.doesNotMatch(individual, /Do you agree with your group’s final choice\?/);
});

test("T24/T49-T50: survey additions and final-question removals are complete", () => {
  for (const text of ["The facilitator’s messages addressed what the group needed at the time.","The facilitator’s messages appeared at appropriate moments.","The facilitator appeared to push the group towards a particular option."]) assert.match(survey, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const key of ["facilitatorNeedFit","facilitatorTimingAppropriateness","facilitatorOptionPush"]) assert.match(survey, new RegExp(key));
  assert.match(survey, /overflow-x-auto/);
  assert.doesNotMatch(survey + finalQuestions, /human facilitator|betterNeedsFacilitator|discussionApproachChanged|facilitatorPreference/);
  assert.match(finalQuestions, /firstTaskCarryover/);
});

test("T27-T31/T42-T44: stored classification and formal filtering isolate non-discussion messages", () => {
  assert.match(chat, /player\.set\("humanMessageRequest"/);
  for (const type of ["human", "facilitator", "system", "ice_breaking_facilitator", "timer_reminder"]) assert.match(callbacks + chat + policies, new RegExp(`"${type}"`));
  assert.doesNotMatch(chat, /scope\.append|sequencePosition|Date\.now\(\) >=/);
  assert.match(callbacks, /reviewHumanMessageRequest/);
  assert.match(callbacks, /appendCanonicalMessage/);
  assert.match(callbacks, /isFormalHumanMessage/);
  assert.match(callbacks, /isFormalContextMessage/);
  assert.match(callbacks, /currentStageName !== "Task"/);
});

test("R8: formal Discussion retains the original unanimous early-finish path", () => {
  assert.match(discussion, /ReadyToDecidePanel/);
  assert.match(discussion, /Ready to make the final decision/);
  assert.match(discussion, /Cancel ready/);
  assert.match(discussion, /player\.stage\.set\("submit", !isReady\)/);
});

test("Discussion has a server-validated recovery path for unanimous readiness and deadline expiry", () => {
  assert.match(discussion, /discussionAdvanceRequest/);
  assert.match(discussion, /requestAdvance\("all_ready"\)/);
  assert.match(discussion, /requestAdvance\("deadline_reached"\)/);
  assert.match(callbacks, /Empirica\.on\("player", "discussionAdvanceRequest"/);
  assert.match(callbacks, /every\(\(participant\) => Boolean\(participant\.stage\?\.get\("submit"\)\)\)/);
  assert.match(callbacks, /Date\.now\(\) >= deadline/);
  assert.match(callbacks, /stage\.set\("ended", true\)/);
});

test("T47 and stable colours: submit guards and original colour aliases remain coupled to report slots", () => {
  assert.doesNotMatch(callbacks, /PARTICIPANT_PALETTE|`Participant \$\{i \+ 1\}`/);
  assert.match(callbacks, /player\.set\("name",\s+aliasSource\[slot\]\.playerName\)/);
  assert.match(callbacks, /player\.set\("hexCode",\s+aliasSource\[slot\]\.hexCode\)/);
  assert.match(callbacks, /participantColorIndex", slot/);
  assert.match(callbacks.slice(callbacks.indexOf('player.set("participantColorIndex"'), callbacks.indexOf('player.set("profileSlot"')), /slot/);
  assert.match(initial + finalDecision + individual, /submitting\.current/);
});

test("decision and assessment forms are not forced into horizontal rows by legacy global CSS", () => {
  assert.doesNotMatch(indexCss, /(^|\n)\s*form\s*\{/);
  assert.doesNotMatch(indexCss, /(^|\n)\s*input\s*\{/);
  assert.doesNotMatch(indexCss, /(^|\n)\s*button\s*\{/);
});

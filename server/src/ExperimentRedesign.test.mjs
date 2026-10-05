import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PRACTICE } from "../../shared/practice.mjs";
import {
  FORMAL_DISCUSSION_FORCE_TIMER_SECONDS,
  resolveTimerVisibility,
} from "../../shared/timerVisibility.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const callbacks = await read("server/src/callbacks.js");
const game = await read("client/src/Game.jsx");
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
const personalFlowShared = await read("shared/personalFlow.mjs");
const practiceShared = await read("shared/practice.mjs");
const practiceClient = await read("client/src/practice/PracticeOnboarding.jsx");
const practiceServer = await read("server/src/PracticeOnboarding.mjs");

function finalDecisionClientState({
  agreementStatus = "agreed",
  matchedChoice = "Option A",
  choice = "Option A",
  confidence,
  recordedChoice = "Option A",
  recordedConfidence,
  confirmedChoice = null,
}) {
  const agreed = agreementStatus === "agreed" && Boolean(choice) && matchedChoice === choice;
  const ownConfirmationCurrent = agreed && confirmedChoice === matchedChoice;
  const localConfidenceValid = Number.isFinite(confidence) && confidence >= 0 && confidence <= 100;
  const confidenceAcknowledged = localConfidenceValid
    && Number.isFinite(recordedConfidence)
    && recordedConfidence >= 0
    && recordedConfidence <= 100
    && recordedConfidence === confidence;
  const choiceAcknowledged = Boolean(choice) && recordedChoice === choice;
  const draftAcknowledged = choiceAcknowledged && confidenceAcknowledged;
  return {
    canConfirm: agreed && draftAcknowledged && !ownConfirmationCurrent,
    savingCurrentDraft: Boolean(choice) && localConfidenceValid && !draftAcknowledged,
  };
}

test("T1-T7: locked routing includes one pre-round practice container and per-round personal-flow stages", () => {
  for (const [id, facilitation, tasks] of [["S1", '["static", "adaptive"]', '["A", "B"]'],["S2", '["adaptive", "static"]', '["A", "B"]'],["S3", '["static", "adaptive"]', '["B", "A"]'],["S4", '["adaptive", "static"]', '["B", "A"]']]) {
    const block = callbacks.slice(callbacks.indexOf(`${id}:`), callbacks.indexOf(`${id}:`) + 260);
    assert.match(block, new RegExp(facilitation.replace(/[\[\]"]/g, "\\$&")));
    assert.match(block, new RegExp(tasks.replace(/[\[\]"]/g, "\\$&")));
  }
  assert.match(callbacks, /taskIndex:\s+0/);
  assert.match(callbacks, /taskIndex:\s+1/);
  assert.match(callbacks, /addPracticeRound\(game\)/);
  // The former per-page stages collapsed into two untimed personal-flow
  // stages per round (Preparation / Followup); IndividualAssessment is now
  // a Followup page, not a stage.
  assert.equal((callbacks.match(/name: "IndividualAssessment"/g) ?? []).length, 0);
  assert.equal((callbacks.match(/name: "Preparation", duration: 1e9/g) ?? []).length, 2);
  assert.equal((callbacks.match(/name: "Followup", duration: 1e9/g) ?? []).length, 2);
  assert.match(personalFlowShared, /PREPARATION_PAGES = \["TaskInformation", "ReviewQuiz", "InitialDecision"\]/);
  assert.match(personalFlowShared, /"IndividualAssessment", "TLX", "SubjectiveSurvey"/);
  assert.match(game, /\["Preparation", "Followup"\]\.includes\(stageName\)\) return <PersonalFlow/);
});

test("one practice container precedes two Icebreaker-free formal rounds and Round 1 resets formal state", () => {
  const practiceStart = callbacks.indexOf('addPracticeRound(game);');
  const round1Start = callbacks.indexOf('const round1 = game.addRound({');
  const round2Start = callbacks.indexOf('const round2 = game.addRound({');
  const roundStartHandler = callbacks.indexOf('Empirica.onRoundStart(({ round }) => {');
  assert.ok(practiceStart >= 0 && practiceStart < round1Start && round1Start < round2Start);

  const practiceBlock = callbacks.slice(practiceStart, round1Start);
  const round1Block = callbacks.slice(round1Start, round2Start);
  const round2Block = callbacks.slice(round2Start, callbacks.indexOf('// Restore the original stable colour aliases'));
  assert.match(practiceBlock, /addPracticeRound\(game\)/);
  for (const formalBlock of [round1Block, round2Block]) {
    assert.doesNotMatch(formalBlock, /Walkthrough|IceBreaker|PracticeIcebreaker|Introduction/);
  }

  const onRoundStartBlock = callbacks.slice(roundStartHandler, callbacks.indexOf('// ── onStageStart'));
  assert.match(onRoundStartBlock, /initialisePractice\(round\);\s*return;/);
  assert.ok(onRoundStartBlock.indexOf('initialisePractice(round);') < onRoundStartBlock.indexOf('resetRoundState(game);'));
  assert.match(onRoundStartBlock, /resetRoundState\(game\)/);
});

test("only screens that require scrolling show bold scroll reminders", () => {
  assert.match(playerSpecificInfo, /font-bold[^>]*>Scroll down within the report to review all information\./);
  assert.doesNotMatch(taskInformation, /Scroll down to review all task information/);
  assert.match(reviewQuiz, /font-bold[^>]*>Scroll down to answer all five questions\./);
  assert.match(individual, /font-bold[^>]*>Scroll down to complete all questions\./);
  assert.match(tlx, /font-bold[^>]*>Scroll down to complete all questions\./);
  assert.match(survey, /font-bold[^>]*>Scroll down to complete all questions\./);
  assert.match(finalQuestions, /font-bold[^>]*>Scroll down to complete all questions\./);
});

test("every stage resets the shared page scroll so the Discussion timer controls stay visible", () => {
  assert.match(game, /useLayoutEffect/);
  assert.match(game, /participant-scroll-root/);
  assert.match(game, /\[roundStageKey\]/);
  assert.match(discussion, /sticky top-0 z-10[^\"]*flex-none/);
  assert.match(discussion, /<Profile collapsibleTimer forceTimerAtSeconds=\{FORMAL_DISCUSSION_FORCE_TIMER_SECONDS\} \/>/);
});

test("Discussion countdown falls back to the server-owned deadline when the Empirica timer hook is unavailable", () => {
  assert.match(timer, /\["Task", "Discussion"\]\.includes\(stageName\)/);
  assert.match(timer, /game\?\.get\("deadline"\)/);
  assert.match(timer, /Number\.isFinite\(discussionDeadline\)/);
  assert.match(timer, /Math\.max\(0, Math\.ceil\(\(discussionDeadline - now\) \/ 1000\)\)/);
  assert.match(callbacks, /game\.set\("deadline",\s+now \+ gameDuration \* 60 \* 1000\)/);
});

test("formal Discussion visibility executes the above, boundary, and below-threshold states", () => {
  const state = (remaining, manuallyVisible = false) => resolveTimerVisibility({
    collapsible: true,
    forceVisibleAtSeconds: FORMAL_DISCUSSION_FORCE_TIMER_SECONDS,
    remaining,
    manuallyVisible,
  });

  assert.deepEqual(state(FORMAL_DISCUSSION_FORCE_TIMER_SECONDS + 1), {
    forcedVisible: false,
    visible: false,
    canToggle: true,
    controlLabel: "Show timer",
  });
  assert.deepEqual(state(FORMAL_DISCUSSION_FORCE_TIMER_SECONDS), {
    forcedVisible: true,
    visible: true,
    canToggle: false,
    controlLabel: null,
  });
  assert.deepEqual(state(FORMAL_DISCUSSION_FORCE_TIMER_SECONDS - 1), {
    forcedVisible: true,
    visible: true,
    canToggle: false,
    controlLabel: null,
  });
});

test("a manually shown formal timer stays singular and loses its Hide control at the threshold", () => {
  const before = resolveTimerVisibility({
    collapsible: true,
    forceVisibleAtSeconds: FORMAL_DISCUSSION_FORCE_TIMER_SECONDS,
    remaining: FORMAL_DISCUSSION_FORCE_TIMER_SECONDS + 1,
    manuallyVisible: true,
  });
  const forced = resolveTimerVisibility({
    collapsible: true,
    forceVisibleAtSeconds: FORMAL_DISCUSSION_FORCE_TIMER_SECONDS,
    remaining: FORMAL_DISCUSSION_FORCE_TIMER_SECONDS,
    manuallyVisible: true,
  });

  assert.deepEqual(before, { forcedVisible: false, visible: true, canToggle: true, controlLabel: "Hide timer" });
  assert.deepEqual(forced, { forcedVisible: true, visible: true, canToggle: false, controlLabel: null });
  assert.equal(Number(before.visible), 1);
  assert.equal(Number(forced.visible), 1);
});

test("Practice keeps its independent final-30-second timer policy", () => {
  const state = (remaining) => resolveTimerVisibility({
    collapsible: true,
    forceVisibleAtSeconds: PRACTICE.forceTimerSeconds,
    remaining,
  });

  assert.equal(state(PRACTICE.forceTimerSeconds + 1).forcedVisible, false);
  assert.equal(state(PRACTICE.forceTimerSeconds).forcedVisible, true);
  assert.equal(state(PRACTICE.forceTimerSeconds - 1).forcedVisible, true);
  assert.equal(state(FORMAL_DISCUSSION_FORCE_TIMER_SECONDS).forcedVisible, false);
});

test("both formal rounds share one Discussion timer policy independent of taskIndex", () => {
  const round1Start = callbacks.indexOf('const round1 = game.addRound({');
  const round2Start = callbacks.indexOf('const round2 = game.addRound({');
  const round1Block = callbacks.slice(round1Start, round2Start);
  const round2Block = callbacks.slice(round2Start, callbacks.indexOf('// Restore the original stable colour aliases'));
  for (const [taskIndex, block] of [[0, round1Block], [1, round2Block]]) {
    assert.match(block, new RegExp(`taskIndex:\\s+${taskIndex}`));
    assert.match(block, /addStage\(\{ name: "Task"/);
    const state = resolveTimerVisibility({
      collapsible: true,
      forceVisibleAtSeconds: FORMAL_DISCUSSION_FORCE_TIMER_SECONDS,
      remaining: FORMAL_DISCUSSION_FORCE_TIMER_SECONDS,
    });
    assert.equal(state.forcedVisible, true);
    assert.equal(state.canToggle, false);
  }
  assert.match(game, /DISCUSSION_STAGE_NAMES\.includes\(stageName\)/);
  assert.match(game, /return <Discussion key=\{roundStageKey\} \/>/);
});

test("FinalDecision keeps its non-collapsible timer presentation", () => {
  const state = resolveTimerVisibility({ remaining: 90 });
  assert.deepEqual(state, { forcedVisible: false, visible: true, canToggle: false, controlLabel: null });
  assert.equal((callbacks.match(/name: "FinalDecision",\s+duration: 90/g) ?? []).length, 2);
  assert.match(finalDecision, /: <Profile \/>/);
});

test("the active Practice transcript is isolated from both formal round transcripts", () => {
  assert.match(practiceShared, /export const PRACTICE_CHAT = "practice_chat"/);
  assert.match(practiceClient, /<Chat scope=\{game\} attribute=\{PRACTICE_CHAT\}/);
  assert.match(practiceServer, /appendMessage\(game, PRACTICE_CHAT/);
  for (const source of [game, policies, callbacks, practiceClient, practiceServer, practiceShared]) {
    assert.doesNotMatch(source, /practice_icebreaker_chat|PRACTICE_ICEBREAKER_TRANSCRIPT_KEY|PracticeIcebreaker|handleIcebreakerChat/);
  }
  for (const source of [game, policies, callbacks]) assert.doesNotMatch(source, /intro_round_[01]|`intro_round_/);
  assert.match(callbacks, /Empirica\.on\("game", "chat_round_0", handleChat\)/);
  assert.match(callbacks, /Empirica\.on\("game", "chat_round_1", handleChat\)/);
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
  assert.match(callbacks, /One minute remains in the discussion\./);
});

test("new games enter the interactive practice instead of legacy IceBreaker countdowns", () => {
  for (const source of [callbacks, game, practiceServer, practiceShared]) {
    assert.doesNotMatch(source, /Walkthrough|IceBreakerStartCountdown|IceBreakerEndCountdown|PracticeIcebreaker/);
  }
  assert.match(practiceShared, /"PracticeWelcome", "PracticeDiscussion", "FinalDecision", "PracticeComplete"/);
  assert.match(game, /round\?\.get\("isPractice"\)/);
  assert.match(game, /<PracticeOnboarding key=\{roundStageKey\}/);
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
  assert.match(callbacks, /reviewFinalDecisionConfirmation\(\{[\s\S]*participantId: player\.id,[\s\S]*requestChoice: request\.choice/);
  assert.doesNotMatch(callbacks, /allConfidenceRecorded/);
  const confirmHandler = callbacks.slice(
    callbacks.indexOf('Empirica.on("player", "finalDecisionConfirmRequest"'),
    callbacks.indexOf('Empirica.on("playerStage", "submit"'),
  );
  assert.match(confirmHandler, /if \(!review\.accepted\) return;[\s\S]*player\.round\.set\("groupFinalConfirmedChoice", review\.matchedChoice\);[\s\S]*finalizeGroupDecision\(stage\)/);
  assert.doesNotMatch(confirmHandler, /request\.confidence/);
  const draftHandler = callbacks.slice(
    callbacks.indexOf('Empirica.on("player", "finalDecisionDraftRequest"'),
    callbacks.indexOf('Empirica.on("player", "finalDecisionConfirmRequest"'),
  );
  assert.match(draftHandler, /if \(choiceChanged\) \{[\s\S]*clearFinalDecisionConfirmations\(game\);/);
  assert.match(finalDecision, /recordedChoice = player\.round\.get\("groupFinalChoice"\) \?\? ""/);
  assert.match(finalDecision, /recordedConfidence = player\.round\.get\("groupChoiceConfidence"\) \?\? null/);
  assert.match(finalDecision, /localConfidenceValid = Number\.isFinite\(confidence\) && confidence >= 0 && confidence <= 100/);
  assert.match(finalDecision, /Number\.isFinite\(recordedConfidence\)[\s\S]*recordedConfidence >= 0[\s\S]*recordedConfidence <= 100[\s\S]*recordedConfidence === confidence/);
  assert.match(finalDecision, /choiceAcknowledged = Boolean\(choice\) && recordedChoice === choice/);
  assert.match(finalDecision, /draftAcknowledged = choiceAcknowledged && confidenceAcknowledged/);
  assert.match(finalDecision, /canConfirm = agreed && draftAcknowledged && !ownConfirmationCurrent/);
  assert.match(finalDecision, /savingCurrentDraft = Boolean\(choice\) && localConfidenceValid && !draftAcknowledged/);
  assert.match(finalDecision, /Saving your response…/);
  assert.match(finalDecision, /Everyone selected the same outcome\. Select your confidence before confirming\./);
  assert.match(finalDecision, /Everyone selected the same outcome\. You can now confirm the group decision\./);
  assert.match(decisionControls, /Move the slider to record your confidence\./);
  assert.match(decisionControls, /value=\{hasSelectedValue \? value : 50\}/);
  assert.match(decisionControls, /onChange=\{\(_event, next\) => onChange\(Number\(next\)\)\}/);
  assert.match(decisionControls, /Selected value: \{hasSelectedValue \? value : "Not selected"\}/);
  assert.match(callbacks, /setTimeout\(\(\) => \{[\s\S]*finalizeGroupDecision\(stage, \{ timedOut: true \}\);[\s\S]*90_000/);
  assert.match(individual, /finalDecisionOutcome === "consensus_choice"/);
  assert.match(individual, /finalDecisionOutcome === "declared_fail" \|\| finalDecisionOutcome === "timeout_fail"/);
  assert.match(callbacks, /stageName === "IndividualAssessment" && stage\.round\.get\("finalDecisionOutcome"\) === "consensus_choice"/);
  assert.match(individual, /if \(groupReachedDecision && !player\.stage\.get\("submit"\)\)/);
  assert.match(individual, /player\.stage\.set\("submit", true\)/);
  assert.doesNotMatch(individual, /Do you agree with your group’s final choice\?/);
});

test("FinalDecision waits for this participant's exact authoritative draft acknowledgement", () => {
  assert.deepEqual(
    finalDecisionClientState({ confidence: 40, recordedConfidence: null }),
    { canConfirm: false, savingCurrentDraft: true },
  );
  assert.deepEqual(
    finalDecisionClientState({ confidence: 80, recordedConfidence: 40 }),
    { canConfirm: false, savingCurrentDraft: true },
  );
  assert.equal(finalDecisionClientState({ confidence: 0, recordedConfidence: 0 }).canConfirm, true);
  assert.equal(finalDecisionClientState({ confidence: 100, recordedConfidence: 100 }).canConfirm, true);
  assert.deepEqual(
    finalDecisionClientState({ confidence: 40, recordedChoice: "Option B", recordedConfidence: 40 }),
    { canConfirm: false, savingCurrentDraft: true },
  );
  assert.equal(finalDecisionClientState({ confidence: 40, recordedConfidence: 40 }).canConfirm, true);
  assert.equal(finalDecisionClientState({ confidence: 40, recordedConfidence: 40, confirmedChoice: "Option A" }).canConfirm, false);
  for (const invalidConfidence of [null, Number.NaN, Number.POSITIVE_INFINITY, -1, 101]) {
    assert.equal(finalDecisionClientState({ confidence: invalidConfidence, recordedConfidence: invalidConfidence }).canConfirm, false);
  }
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

test("Discussion uses native unanimous readiness and an idempotent deadline-only recovery path", () => {
  assert.match(discussion, /discussionAdvanceRequest/);
  assert.doesNotMatch(discussion, /requestAdvance\("all_ready"\)/);
  assert.match(discussion, /requestAdvance\("deadline_reached"\)/);
  assert.match(callbacks, /Empirica\.on\("player", "discussionAdvanceRequest"/);
  assert.match(callbacks, /discussionAdvanceRequest\.reason !== "deadline_reached"/);
  assert.match(callbacks, /discussionAdvanceCommittedStageId/);
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

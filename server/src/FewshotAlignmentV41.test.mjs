import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// These tests exercise authored fixtures, actual deterministic contracts and
// prompt wording. They do NOT invoke a model or prove semantic model behavior.
// No production sorting helper is introduced: the ordering oracle below lives
// only in this test and deliberately cannot certify a generated scoreboard.
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(sourceDir, "../../..");
const dataDir = path.join(workspace, "fewshot-study/review-package-data-v4_1");
const fixture = JSON.parse(readFileSync(path.join(dataDir, "regression_cases.json"), "utf8"));
const originals = readFileSync(path.resolve(dataDir, fixture.source_assessor_relative_path), "utf8")
  .trim().split(/\r?\n/u).map(JSON.parse);
const specialistDir = path.join(sourceDir, "prompts/source/runtime/specialist");
const mirrorDir = path.join(sourceDir, "../test/participant_sim/prompts/source/runtime/specialist");
const rules = file => readFileSync(path.join(specialistDir, file), "utf8").split("## ADAPTIVE FEW-SHOT EXAMPLES")[0];
const originalEntry = process.argv[1];
const originalFetch = globalThis.fetch;
process.argv[1] = path.join(sourceDir, "fake-entry.js");
globalThis.fetch = async () => { throw new Error("Network/model calls are forbidden in FewshotAlignmentV41"); };
after(() => { process.argv[1] = originalEntry; globalThis.fetch = originalFetch; });

const { checkNeedAssessment } = await import("./EvidenceChecker.js");
const { compilePlan } = await import("./PolicyCompiler.js");
const { preflightPlan } = await import("./PlanPreflight.mjs");
const { OPERATION_QUESTIONS } = await import("./CognitiveOperations.mjs");
const { buildDynamicUserContext } = await import("./prompts/DynamicContext.mjs");
const { buildStaticSharedTaskOverview } = await import("./prompts/StaticContext.mjs");
const { initialiseTaskOptionOrder } = await import("./TaskOptionOrder.mjs");
const { runtimeGeneratorBundle } = await import("./prompts/PromptRuntime.mjs");
const { parseGeneratorOutputStrict, validateAgainstGenerationSchema, runDeterministicValidation } = await import("./prompts/GeneratorContract.mjs");
const { normalizeGeneratorCandidate } = await import("../../client/src/components/facilitatorPresentation.mjs");
const { tasks } = JSON.parse(readFileSync(path.join(sourceDir, "HPTConfig.json"), "utf8"));
const publicMessages = item => item.cumulative_public_context.map(({ messageId, sender, text }) => ({ messageId, sender, text }));
const restoreChat = messages => messages.map(({ sender, text }) => ({
  text, sender: { id: `synthetic:${sender}`, name: sender }, messageType: "human", speakerType: "human",
}));
const sha = value => createHash("sha256").update(value).digest("hex");

test("v4.1 fixtures are regression-only and explicitly do not claim model evaluation", () => {
  assert.equal(fixture.model_calls, 0);
  assert.equal(fixture.status, "regression_only_not_loaded_not_model_evaluated");
  assert.deepEqual(fixture.generator_regressions.map(item => item.example_id), ["G-11", "G-12"]);
  for (const item of fixture.generator_regressions) {
    assert.equal(item.load_in_branch_prompt, false);
    for (const directory of [specialistDir, mirrorDir]) {
      assert.doesNotMatch(readFileSync(path.join(directory, "challenger.md"), "utf8"), new RegExp(`### ${item.example_id} —`));
    }
  }
  assert.match(fixture.limitations.join(" "), /not responses sampled from a model/);
  assert.match(fixture.limitations.join(" "), /test-only/);
});

for (const item of fixture.generator_regressions) {
  test(`${item.example_id}: unchanged Assessor fixture compiles to the recorded executable input contract`, () => {
    const source = originals.find(candidate => candidate.case_id === item.assessor_case_id);
    assert.ok(source);
    assert.equal(sha(JSON.stringify(source)), item.source_assessor_sha256);
    const messages = publicMessages(source);
    const chat = restoreChat(messages);
    const checked = checkNeedAssessment(source.gold_assessor_output, {
      chat, activeParticipantNames: source.active_participant_names,
    });
    assert.equal(checked.need, "SCRUTINIZE");
    assert.equal(checked.operation, "unsupported_claim");
    assert.equal(checked.downgradedReason, null);
    const plan = compilePlan(checked.role, checked.checkedFactors, {
      eligibleMessageIds: messages.map(message => message.messageId), interventionHistory: source.intervention_history,
    });
    assert.deepEqual(plan, item.intervention_plan);
    assert.equal(plan.requiredReasoningAct, "EVIDENCE_AUDIT");
    assert.match(plan.answerableQuestionTemplate, /unsupported claim without a choice preference/);
    assert.match(plan.answerableQuestionTemplate, /support that specific claim/);
    const preflight = preflightPlan(plan, {
      chat, taskGeneralContext: source.task_general_context, activeParticipantNames: source.active_participant_names,
      interventionHistory: source.intervention_history, contextScope: source.context_scope,
    });
    assert.equal(preflight.status, "passed", JSON.stringify(preflight.failureReasons));
    assert.deepEqual(preflight, item.runtime_inputs.PLAN_PREFLIGHT);
    const runtime = buildDynamicUserContext({
      chat, checkpointDescriptor: item.checkpoint_descriptor, selectedRoleForDisplay: plan.generationRole,
      generalInfo: source.task_general_context, plan, activeParticipantNames: source.active_participant_names,
      planPreflight: preflight, interventionHistory: source.intervention_history, contextScope: source.context_scope,
    });
    assert.equal(runtime.userContent, item.runtime_user_content);
    assert.deepEqual(item.runtime_inputs, {
      CHECKPOINT: item.checkpoint_descriptor, SELECTED_ROLE: plan.generationRole,
      TASK_GENERAL_CONTEXT: source.task_general_context, RELEVANT_DISCUSSION_STATE: plan.gap,
      TARGET: plan.target, REQUIRED_REASONING_ACT: plan.requiredReasoningAct,
      ANSWERABLE_QUESTION_TEMPLATE: plan.answerableQuestionTemplate,
      ALLOWED_GROUNDING_MESSAGE_IDS: plan.evidenceIds, ACTIVE_PARTICIPANT_NAMES: source.active_participant_names,
      PLAN_PREFLIGHT: preflight, INTERVENTION_HISTORY: source.intervention_history, CONTEXT_SCOPE: source.context_scope,
      CUMULATIVE_PUBLIC_CONTEXT: messages, LOCAL_CONTEXT: messages.slice(-6), RECENT_AI_MESSAGES: [],
    });
    assert.doesNotMatch(item.runtime_user_content, /fact_ids|source_assessor_sha256|gold_assessor_output|playerContent|holder/);
    for (const evidence of source.gold_assessor_output.target.evidence) {
      assert.ok(messages.find(message => message.messageId === evidence.messageId)?.text.includes(evidence.span));
    }
  });

  test(`${item.example_id}: authored guarantee question passes actual structural and grounding-ID contracts`, () => {
    const expected = item.expected_generator_output;
    const parsed = parseGeneratorOutputStrict(JSON.stringify(expected));
    assert.equal(parsed.ok, true);
    assert.equal(validateAgainstGenerationSchema(expected, "EVIDENCE_CHALLENGER").ok, true);
    const normalized = normalizeGeneratorCandidate(parsed.parsed);
    const checked = runDeterministicValidation(normalized, {
      selectedRole: "EVIDENCE_CHALLENGER",
      eligibleMessageIds: item.runtime_inputs.CUMULATIVE_PUBLIC_CONTEXT.map(message => message.messageId),
      aiOrSystemMessageIds: [], recentAiMessageTexts: [],
      allowedGroundingIds: item.intervention_plan.evidenceIds,
      activeParticipantNames: item.runtime_inputs.ACTIVE_PARTICIPANT_NAMES,
      maxWords: 50, maxSentences: 3, maxSections: 0,
      enforcePlanGrounding: true, forbidInternalDisclosure: true,
    });
    assert.equal(checked.passed, true, JSON.stringify(checked.failedCriteria));
    assert.deepEqual(expected.message.sections, []);
    assert.equal((normalized.message.match(/\?/gu) || []).length, 1);
    assert.ok(normalized.message.endsWith("?"));
    assert.doesNotMatch(normalized.message, /before (?:settling|locking)|strongest|other options|group agrees|everyone agrees/i);
    assert.match(expected.message.question, /if anything/);
    assert.match(expected.message.question, /supports that guarantee/);
    assert.deepEqual(expected.groundingMessageIds, item.support_map.map(entry => entry.messageId));
    for (const entry of item.support_map) {
      assert.equal(item.runtime_inputs.CUMULATIVE_PUBLIC_CONTEXT.find(message => message.messageId === entry.messageId)?.text, entry.span);
    }
    // This is an authored answer assertion, not automatic semantic validation.
    // The second A-14 speaker contributes engagement, not support for the claim.
    if (item.assessor_case_id === "A-14") {
      assert.equal(expected.message.summary, "Alex says Cedar's event app will guarantee perfect attendance.");
      assert.deepEqual(expected.groundingMessageIds, ["m3"]);
      assert.ok(item.intervention_plan.evidenceIds.includes("m2"));
      assert.doesNotMatch(normalized.message, /Casey|Blair/);
      assert.match(item.semantic_expectations.join(" "), /A-14 second-speaker courtyard/);
    } else {
      assert.equal(expected.message.summary, "Alex and Blair say Briar will guarantee that every presentation starts on time.");
      assert.deepEqual(expected.groundingMessageIds, ["m3", "m4"]);
      assert.match(item.semantic_expectations.join(" "), /A-17: only Alex and Blair/);
      assert.doesNotMatch(item.semantic_expectations.join(" "), /A-14|courtyard/);
    }
  });
}

test("R1 rule contract distinguishes unsupported conclusions from ordinary reported facts without inventing a preference", () => {
  const challenger = rules("challenger.md");
  const common = rules("specialist_common.md");
  const validator = rules("validator.md");
  assert.match(challenger, /Claim-only target:[^\n]+name that specific claim[^\n]+if any[^\n]+support it/);
  assert.match(challenger, /Do not replace this with a question about other options/);
  assert.match(challenger, /imply that others share the claim/);
  assert.match(challenger, /Do not ask for the source, verification or proof of an ordinary fact/);
  assert.match(OPERATION_QUESTIONS.EVIDENCE_AUDIT, /unsupported claim without a choice preference/);
  assert.match(OPERATION_QUESTIONS.EVIDENCE_AUDIT, /Do not infer a preference or ask for proof of an ordinary reported task fact/);
  assert.match(common, /For an unsupported claim without a choice preference, name that specific claim/);
  assert.match(common, /Use exactly one applicable question, not both/);
  assert.match(common, /Do not turn a claim into a preference or infer group support/);
  assert.match(validator, /Flag roleMisaligned and requiredReasoningActMissing when a claim-only target is replaced with an alternatives\/choice question/);
  assert.match(validator, /not evidence that they endorse the claim/);
  const bundle = runtimeGeneratorBundle("challenger");
  assert.equal(bundle.blocked, false, bundle.reason);
  assert.ok(bundle.content.includes("Claim-only target:"));
  const negative = fixture.semantic_review_controls.find(item => item.case_id === "C-ORDINARY-REPORTED-FACT");
  assert.match(negative.public_message.text, /^My notes say /);
  assert.match(negative.disallowed_question, /proof/);
  assert.match(negative.evaluation_status, /no semantic model evaluation/);
});

// Test-only oracle for reviewed fixture expectations. This is NOT the actual
// Generator and not a second production parser for arbitrary natural language.
function reviewedOrderOracle(item) {
  const match = /Available alternatives:[ \t]*([^\r\n]*)/u.exec(item.task_general_context);
  const body = match?.[1].trim().replace(/\.$/u, "") || "";
  const machine = body && body.toLowerCase() !== "not provided" ? body.split(",").map(label => label.trim()) : [];
  const firstSeen = [...new Set(item.cumulative_public_context.map(message => message.option))];
  const order = machine.length ? machine : item.explicit_public_option_order.length ? item.explicit_public_option_order : firstSeen;
  const source = machine.length ? "machine_available_alternatives" : item.explicit_public_option_order.length ? "explicit_public_task_list" : "first_public_appearance";
  const citedOptions = new Set(item.cumulative_public_context
    .filter(message => item.allowed_grounding_message_ids.includes(message.messageId))
    .map(message => message.option));
  return { source, options: order.filter(option => item.selected_target_options.includes(option) && citedOptions.has(option)) };
}

test("R2 actual synthesis rule states authoritative order, every fallback and target/grounding restriction", () => {
  const synthesis = rules("synthesiser.md");
  assert.match(synthesis, /machine-supplied "Available alternatives:" list[^\n]+authoritative option order/);
  assert.match(synthesis, /even if an earlier narrative names the options in a different order/);
  assert.match(synthesis, /absent, empty or "not provided" list as missing/);
  assert.match(synthesis, /explicit option list elsewhere in TASK_GENERAL_CONTEXT/);
  assert.match(synthesis, /If both lists are missing, use the order the options first appeared in the public discussion/);
  assert.match(synthesis, /only to the selected TARGET options[^\n]+ALLOWED_GROUNDING_MESSAGE_IDS/);
  assert.match(synthesis, /Ordering never authorizes adding an option, fact or empty entry/);
  const bundle = runtimeGeneratorBundle("synthesiser");
  assert.equal(bundle.blocked, false, bundle.reason);
  assert.ok(bundle.content.includes("authoritative option order"));
});

for (const item of fixture.ordering_regressions) {
  test(`${item.case_id}: authored ordering oracle preserves source priority and selected cited subset (not a model test)`, () => {
    if (item.actual_task_version) {
      const task = tasks.find(candidate => candidate.taskVersion === item.actual_task_version);
      assert.equal(item.task_general_context, buildStaticSharedTaskOverview(task));
      assert.deepEqual(item.available_labels, task.decisionOptions.map(option => option.label));
      assert.match(item.input_origin, /not a claim/);
    }
    for (const message of item.cumulative_public_context) assert.ok(message.text.includes(message.option));
    assert.deepEqual(reviewedOrderOracle(item), { source: item.expected_order_source, options: item.expected_option_order });
    for (const option of item.expected_option_order) {
      assert.ok(item.selected_target_options.includes(option));
      assert.ok(item.cumulative_public_context.some(message => message.option === option && item.allowed_grounding_message_ids.includes(message.messageId)));
    }
  });
}

test("initialized Task A/B contexts preserve the machine order across all six permutations; raw B conflict is not a deployed-path claim", () => {
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  let contextsChecked = 0;
  for (const task of tasks) {
    const original = JSON.stringify(task);
    for (const permutation of permutations) {
      const state = {};
      const round = { get: key => state[key], set: (key, value) => { state[key] = value; } };
      const options = initialiseTaskOptionOrder(round, task, current => permutation.map(index => current[index]));
      const labels = options.map(option => option.label);
      const overview = buildStaticSharedTaskOverview({ generalInfo: state.generalInfo, decisionOptions: options });
      assert.ok(overview.includes(`The three options are ${labels[0]}, ${labels[1]} and ${labels[2]}.`));
      assert.ok(overview.endsWith(`Available alternatives: ${labels.join(", ")}.`));
      const messages = [...labels].reverse().map((option, index) => ({ messageId: `m${index}`, option }));
      const selected = [labels[2], labels[0]];
      const oracle = reviewedOrderOracle({
        task_general_context: overview, explicit_public_option_order: labels, selected_target_options: selected,
        allowed_grounding_message_ids: messages.filter(message => selected.includes(message.option)).map(message => message.messageId),
        cumulative_public_context: messages,
      });
      assert.deepEqual(oracle, { source: "machine_available_alternatives", options: [labels[0], labels[2]] });
      contextsChecked += 1;
    }
    assert.equal(JSON.stringify(task), original);
  }
  assert.equal(contextsChecked, 12);
});

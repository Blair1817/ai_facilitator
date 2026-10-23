import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildDynamicUserContext } from "./prompts/DynamicContext.mjs";
import {
  parseGeneratorOutputStrict,
  runDeterministicValidation,
  validateAgainstGenerationSchema,
} from "./prompts/GeneratorContract.mjs";
import { getAdaptivePromptBundle } from "./prompts/promptLoader.js";
import {
  buildCanonicalMessage,
  FACILITATOR_ROLES,
  MESSAGE_TYPES,
} from "./ExperimentPolicies.mjs";
import { containsFacilitatorMention } from "./CheckpointManager.mjs";
import { CHAT_MENTION_PATTERN } from "../../client/src/components/chatMentions.mjs";

const customChatSource = await readFile(
  new URL("../../client/src/components/CustomChat.jsx", import.meta.url),
  "utf8",
);
const callbacksSource = await readFile(new URL("./callbacks.js", import.meta.url), "utf8");

const ACTIVE_PARTICIPANTS = ["Red", "Blue", "Green"];
const ROLE_CASES = [
  {
    route: "expander",
    role: FACILITATOR_ROLES.INFORMATION_EXPANDER,
    message: "@[Blue], could you share any task information about accessibility?",
    groundingMessageIds: [],
    promptRule: /Use an optional @\[Name\] only for PARTICIPATION_ELICITATION/,
  },
  {
    route: "challenger",
    role: FACILITATOR_ROLES.EVIDENCE_CHALLENGER,
    message: "@[Blue], what public evidence supports your accessibility comparison?",
    groundingMessageIds: ["m0"],
    promptRule: /An optional @\[Name\] may address the author of a public claim/,
  },
  {
    route: "synthesiser",
    role: FACILITATOR_ROLES.INFORMATION_SYNTHESISER,
    message: "@[Blue] raised accessibility, while @[Green] raised cost. These are two criteria the group has discussed.",
    groundingMessageIds: ["m0", "m1"],
    promptRule: /A name or @\[Name\] may identify the source of a public claim/,
  },
];

const VALIDATION_CONTEXT = {
  eligibleMessageIds: ["m0", "m1"],
  aiOrSystemMessageIds: [],
  recentAiMessageTexts: [],
  allowedGroundingIds: ["m0", "m1"],
  activeParticipantNames: ACTIVE_PARTICIPANTS,
  enforcePlanGrounding: true,
  forbidInternalDisclosure: true,
  maxWords: 55,
  maxSentences: 3,
};

function validateCandidate(candidate) {
  const schema = validateAgainstGenerationSchema(candidate, candidate.role);
  assert.equal(schema.ok, true, JSON.stringify(schema.errors));
  return runDeterministicValidation(candidate, {
    ...VALIDATION_CONTEXT,
    selectedRole: candidate.role,
    maxSections: 0,
  });
}

function prepareFacilitatorPublication(rawText) {
  const parsed = parseGeneratorOutputStrict(rawText);
  assert.equal(parsed.ok, true, parsed.error);
  const deterministic = validateCandidate(parsed.parsed);
  assert.equal(
    deterministic.passed,
    true,
    `unexpected failures: ${deterministic.failedCriteria.join(", ")}`,
  );

  return buildCanonicalMessage({
    messageId: "facilitator-round-1-1000",
    groupId: "group-1",
    speakerId: "ai",
    roundIndex: 0,
    stage: "Discussion",
    messageType: MESSAGE_TYPES.FACILITATOR,
    speakerType: MESSAGE_TYPES.FACILITATOR,
    timestamp: 1_000,
    sequencePosition: 2,
    content: parsed.parsed.message,
    role: parsed.parsed.role,
    facilitatorOrigin: "LLM_GENERATED",
    facilitatorTrigger: "AUTOMATIC_CHECKPOINT",
    auditRequestId: "audit-1",
    sender: { id: "ai", name: "Facilitator", avatar: "facilitator-avatar" },
  });
}

test("Adaptive Generator context supplies public colour nicknames and public message IDs", () => {
  const context = buildDynamicUserContext({
    chat: [
      { text: "Accessibility matters for Option A.", sender: { id: "p-blue", name: "Blue" } },
      { text: "Cost matters for Option B.", sender: { id: "p-green", name: "Green" } },
    ],
    checkpointDescriptor: "Adaptive checkpoint",
    selectedRoleForDisplay: FACILITATOR_ROLES.INFORMATION_SYNTHESISER,
    generalInfo: "Compare the options.",
    activeParticipantNames: ACTIVE_PARTICIPANTS,
  });

  assert.match(context.userContent, /\[ACTIVE_PARTICIPANT_NAMES\]\nRed, Blue, Green/);
  assert.match(context.userContent, /\[m0\] \[Blue\]: Accessibility matters for Option A\./);
  assert.match(context.userContent, /\[m1\] \[Green\]: Cost matters for Option B\./);
  assert.deepEqual(context.activeParticipantNames, ACTIVE_PARTICIPANTS);
  assert.deepEqual(context.eligibleMessageIds, ["m0", "m1"]);
});

for (const roleCase of ROLE_CASES) {
  test(`${roleCase.route} permits an optional valid participant mention`, () => {
    const bundle = getAdaptivePromptBundle(roleCase.route);
    assert.equal(bundle.blocked, false, bundle.reason);
    assert.equal(bundle.metadata.generationRole, roleCase.role);
    assert.match(bundle.content, /Use only @\[Name\] with the exact display name in ACTIVE_PARTICIPANT_NAMES/);
    assert.match(bundle.content, /Tagging is optional; group-level wording is the default/);
    assert.match(bundle.content, /cannot imply private knowledge/);
    assert.match(bundle.content, roleCase.promptRule);

    const result = validateCandidate({
      role: roleCase.role,
      message: roleCase.message,
      groundingMessageIds: roleCase.groundingMessageIds,
    });
    assert.equal(result.passed, true, result.failedCriteria.join(", "));
  });
}

test("valid @[Blue] survives Generator parsing, validation, and publication preparation unchanged", () => {
  const candidate = ROLE_CASES[1];
  const rawText = JSON.stringify({
    role: candidate.role,
    message: candidate.message,
    groundingMessageIds: candidate.groundingMessageIds,
  });
  const published = prepareFacilitatorPublication(rawText);

  assert.equal(published.content, candidate.message);
  assert.equal(published.text, candidate.message);
  assert.equal(published.speakerType, MESSAGE_TYPES.FACILITATOR);
  assert.equal(published.facilitatorOrigin, "LLM_GENERATED");
});

test("CustomChat recognizes the server-published @[Blue] as styled mention markup", () => {
  const published = prepareFacilitatorPublication(JSON.stringify({
    role: FACILITATOR_ROLES.INFORMATION_EXPANDER,
    message: "@[Blue], could you share any task information about accessibility?",
    groundingMessageIds: [],
  }));
  const mentions = [...published.text.matchAll(CHAT_MENTION_PATTERN)].map((match) => match[1]);

  assert.deepEqual(mentions, ["Blue"]);
  assert.match(customChatSource, /reactStringReplace\(text, CHAT_MENTION_PATTERN/);
  assert.match(customChatSource, /className="mention"/);
});

test("unknown or invented participant mentions fail closed", () => {
  for (const name of ["Purple", "Invented Person"]) {
    const result = runDeterministicValidation({
      role: FACILITATOR_ROLES.INFORMATION_EXPANDER,
      message: `@[${name}], could you share more?`,
      groundingMessageIds: [],
    }, {
      ...VALIDATION_CONTEXT,
      selectedRole: FACILITATOR_ROLES.INFORMATION_EXPANDER,
      maxSections: 0,
    });
    assert.equal(result.passed, false);
    assert.ok(result.failedCriteria.includes("UNKNOWN_MENTION_TARGET"));
  }
});

test("Adaptive Facilitator cannot target itself as a participant", () => {
  const result = runDeterministicValidation({
    role: FACILITATOR_ROLES.EVIDENCE_CHALLENGER,
    message: "@[Facilitator], what evidence supports that claim?",
    groundingMessageIds: ["m0"],
  }, {
    ...VALIDATION_CONTEXT,
    selectedRole: FACILITATOR_ROLES.EVIDENCE_CHALLENGER,
    maxSections: 0,
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes("FACILITATOR_SELF_MENTION"));
});

test("participant targeting does not bypass grounding validation", () => {
  const result = runDeterministicValidation({
    role: FACILITATOR_ROLES.EVIDENCE_CHALLENGER,
    message: "@[Blue], what evidence supports that public claim?",
    groundingMessageIds: ["m999"],
  }, {
    ...VALIDATION_CONTEXT,
    selectedRole: FACILITATOR_ROLES.EVIDENCE_CHALLENGER,
    maxSections: 0,
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes("UNKNOWN_GROUNDING_ID"));
  assert.ok(result.failedCriteria.includes("GROUNDING_ID_OUTSIDE_PLAN_EVIDENCE"));
});

test("Facilitator-authored participant mention does not enter the participant-request route", () => {
  const message = "@[Blue], what evidence supports that comparison?";
  assert.equal(containsFacilitatorMention(message), false);

  const humanGuard = callbacksSource.indexOf("if (!isFormalHumanMessage(lastMessage)) return;");
  const mentionDetection = callbacksSource.indexOf("const isMentionCheckpoint = containsFacilitatorMention(latestHumanText);");
  assert.ok(humanGuard >= 0 && humanGuard < mentionDetection);
});

test("normal Adaptive Specialist message without a mention remains valid", () => {
  const result = validateCandidate({
    role: FACILITATOR_ROLES.INFORMATION_EXPANDER,
    message: "Could anyone share task information about accessibility?",
    groundingMessageIds: [],
  });
  assert.equal(result.passed, true, result.failedCriteria.join(", "));
});

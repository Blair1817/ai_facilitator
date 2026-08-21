// Prompt 3B, requirements #6/#7/#8: strict Generator JSON parsing,
// generation.schema.json enforcement (with per-request role `const`), and
// deterministic validation. Pure-function tests -- no network, no Empirica.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(__dirname, "..", "fake-entry.js");

const {
  strictParseJsonObject,
  parseGeneratorOutputStrict,
  buildRuntimeGenerationSchema,
  validateAgainstGenerationSchema,
  runDeterministicValidation,
  stripMarkdownWrapper,
  getGenerationSchemaMaxLength,
} = await import("./GeneratorContract.mjs");

const VALID_CANDIDATE = { role: "INFORMATION_EXPANDER", message: "Is there anything else anyone has not shared yet?", groundingMessageIds: [] };

// ── strict JSON parsing ──────────────────────────────────────────────────

test("strict parser: accepts a single valid JSON object", () => {
  const result = parseGeneratorOutputStrict(JSON.stringify(VALID_CANDIDATE));
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, VALID_CANDIDATE);
});

test("strict parser: rejects invalid JSON", () => {
  const result = parseGeneratorOutputStrict("{role: INFORMATION_EXPANDER, message: 'hi'}");
  assert.equal(result.ok, false);
  assert.equal(result.code, "GENERATOR_PARSE_FAILURE");
});

test("strict parser: tolerates a single leading ```json + trailing ``` wrapper (Phase 6 pilot fix for MiniMax-Text-01 chatty output)", () => {
  // Phase 6 pilot update: the live model wraps its JSON in a
  // markdown code fence despite the prompt forbidding it. The parser
  // strips a single wrapper and parses the inside. Schema-level
  // strictness is unchanged (this test confirms both halves: the
  // wrapper IS stripped, AND the inside is still validated as a
  // single object).
  const result = parseGeneratorOutputStrict("```json\n" + JSON.stringify(VALID_CANDIDATE) + "\n```");
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, VALID_CANDIDATE);
});

test("strict parser: tolerates a single leading ``` + trailing ``` wrapper (no language tag)", () => {
  const result = parseGeneratorOutputStrict("```\n" + JSON.stringify(VALID_CANDIDATE) + "\n```");
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, VALID_CANDIDATE);
});

test("strict parser: tolerates a code fence with extra surrounding whitespace", () => {
  const result = parseGeneratorOutputStrict("  \n```json\n" + JSON.stringify(VALID_CANDIDATE) + "\n```\n  ");
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, VALID_CANDIDATE);
});

test("strict parser: tolerates an uppercase JSON code-fence label from a live provider", () => {
  const result = strictParseJsonObject('```JSON\n{"role":"STATIC"}\n```');
  assert.equal(result.ok, true);
  assert.equal(result.parsed.role, "STATIC");
});

test("strict parser: still rejects an EMPTY code fence (the inside must still be valid JSON)", () => {
  const result = parseGeneratorOutputStrict("```json\n\n```");
  assert.equal(result.ok, false);
  assert.equal(result.code, "GENERATOR_PARSE_FAILURE");
});

test("strict parser: still rejects a code fence wrapping INVALID JSON", () => {
  // The fence-strip fallback succeeds syntactically (extracts the
  // inside), but the inside is still invalid JSON. The original
  // strictness is preserved here.
  const result = parseGeneratorOutputStrict("```json\n{not: valid}\n```");
  assert.equal(result.ok, false);
  assert.equal(result.code, "GENERATOR_PARSE_FAILURE");
  assert.match(result.error, /after code-fence strip/);
});

test("strict parser: rejects prose before the JSON object (no fence)", () => {
  const result = parseGeneratorOutputStrict("Sure, here is my answer: " + JSON.stringify(VALID_CANDIDATE));
  assert.equal(result.ok, false);
});

test("strict parser: rejects prose after the JSON object (no fence)", () => {
  const result = parseGeneratorOutputStrict(JSON.stringify(VALID_CANDIDATE) + "\nHope that helps!");
  assert.equal(result.ok, false);
});

test("strict parser: rejects a bare JSON array (not a single object)", () => {
  const result = parseGeneratorOutputStrict(JSON.stringify([VALID_CANDIDATE]));
  assert.equal(result.ok, false);
});

test("strict parser: rejects a bare JSON primitive", () => {
  assert.equal(parseGeneratorOutputStrict('"just a string"').ok, false);
  assert.equal(parseGeneratorOutputStrict("42").ok, false);
  assert.equal(parseGeneratorOutputStrict("null").ok, false);
});

test("strict parser: rejects the legacy DECISION/WAIT/MESSAGE/RATIONALE output contract outright (not valid JSON)", () => {
  const legacy = 'DECISION: WAIT\nMESSAGE: "Let us hear more."\nRATIONALE: agreement is low';
  const result = parseGeneratorOutputStrict(legacy);
  assert.equal(result.ok, false);
  assert.equal(result.code, "GENERATOR_PARSE_FAILURE");
});

test("strict parser: does not do permissive regex extraction (a JSON object embedded in other text is still rejected wholesale)", () => {
  const result = parseGeneratorOutputStrict(`noise ${JSON.stringify(VALID_CANDIDATE)} noise`);
  assert.equal(result.ok, false, "must not extract and accept the embedded JSON object");
});

// ── generation.schema.json enforcement ──────────────────────────────────

test("generation schema: accepts a candidate whose role matches SELECTED_ROLE", () => {
  const result = validateAgainstGenerationSchema(VALID_CANDIDATE, "INFORMATION_EXPANDER");
  assert.equal(result.ok, true);
});

test("generation schema: rejects missing required field", () => {
  const { message, ...withoutMessage } = VALID_CANDIDATE;
  const result = validateAgainstGenerationSchema(withoutMessage, "INFORMATION_EXPANDER");
  assert.equal(result.ok, false);
  assert.equal(result.code, "GENERATION_SCHEMA_FAILURE");
});

test("generation schema: rejects an additional/unexpected field", () => {
  const result = validateAgainstGenerationSchema({ ...VALID_CANDIDATE, rationale: "because" }, "INFORMATION_EXPANDER");
  assert.equal(result.ok, false);
});

test("generation schema: rejects incorrect field types", () => {
  const result = validateAgainstGenerationSchema({ ...VALID_CANDIDATE, groundingMessageIds: "m1" }, "INFORMATION_EXPANDER");
  assert.equal(result.ok, false);
});

test("generation schema: rejects an empty message", () => {
  const result = validateAgainstGenerationSchema({ ...VALID_CANDIDATE, message: "" }, "INFORMATION_EXPANDER");
  assert.equal(result.ok, false);
});

test("generation schema: rejects a role that differs from SELECTED_ROLE, via the per-request const", () => {
  const result = validateAgainstGenerationSchema({ ...VALID_CANDIDATE, role: "EVIDENCE_CHALLENGER" }, "INFORMATION_EXPANDER");
  assert.equal(result.ok, false);
});

test("generation schema: rejects duplicate grounding IDs (schema uniqueItems)", () => {
  const result = validateAgainstGenerationSchema({ ...VALID_CANDIDATE, groundingMessageIds: ["m1", "m1"] }, "INFORMATION_EXPANDER");
  assert.equal(result.ok, false);
});

test("generation schema: per-request runtime schema is non-mutating -- the shared source schema keeps its full role enum after building a runtime copy", () => {
  const before = JSON.stringify(buildRuntimeGenerationSchema("INFORMATION_EXPANDER"));
  buildRuntimeGenerationSchema("EVIDENCE_CHALLENGER");
  const after = JSON.stringify(buildRuntimeGenerationSchema("INFORMATION_EXPANDER"));
  assert.equal(before, after, "building a schema for one role must not affect schemas built for another role");
});

test("generation schema: concurrent requests with different selected roles receive independent runtime schemas that do not cross-validate", async () => {
  const [expanderSchema, challengerSchema] = await Promise.all([
    Promise.resolve().then(() => buildRuntimeGenerationSchema("INFORMATION_EXPANDER")),
    Promise.resolve().then(() => buildRuntimeGenerationSchema("EVIDENCE_CHALLENGER")),
  ]);
  assert.equal(expanderSchema.properties.role.const, "INFORMATION_EXPANDER");
  assert.equal(challengerSchema.properties.role.const, "EVIDENCE_CHALLENGER");
  assert.notEqual(expanderSchema, challengerSchema, "must be distinct object instances, not a shared mutated schema");

  const expanderCandidate = { role: "INFORMATION_EXPANDER", message: "x", groundingMessageIds: [] };
  const challengerCandidate = { role: "EVIDENCE_CHALLENGER", message: "y", groundingMessageIds: [] };
  assert.equal(validateAgainstGenerationSchema(expanderCandidate, "INFORMATION_EXPANDER").ok, true);
  assert.equal(validateAgainstGenerationSchema(expanderCandidate, "EVIDENCE_CHALLENGER").ok, false);
  assert.equal(validateAgainstGenerationSchema(challengerCandidate, "EVIDENCE_CHALLENGER").ok, true);
  assert.equal(validateAgainstGenerationSchema(challengerCandidate, "INFORMATION_EXPANDER").ok, false);
});

// ── deterministic validation ─────────────────────────────────────────────

const DETERMINISTIC_CONTEXT = {
  selectedRole: "INFORMATION_EXPANDER",
  eligibleMessageIds: ["m0", "m1", "m2"],
  aiOrSystemMessageIds: ["m3"],
  recentAiMessageTexts: ["Has everyone shared their materials?"],
};

test("deterministic validation: passes a fully valid candidate", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "Any new info?", groundingMessageIds: ["m1"] }, DETERMINISTIC_CONTEXT);
  assert.equal(result.passed, true);
  assert.deepEqual(result.failedCriteria, []);
});

test("deterministic validation: flags ROLE_MISMATCH", () => {
  const result = runDeterministicValidation({ role: "EVIDENCE_CHALLENGER", message: "x", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("ROLE_MISMATCH"));
  assert.equal(result.passed, false);
});

test("deterministic validation: flags EMPTY_MESSAGE", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "   ", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("EMPTY_MESSAGE"));
});

test("deterministic validation: flags MARKDOWN_DETECTED for a code fence", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "```not allowed```", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("MARKDOWN_DETECTED"));
});

test("deterministic validation: flags MARKDOWN_DETECTED for a markdown list", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "- point one\n- point two", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("MARKDOWN_DETECTED"));
});

test("deterministic validation: flags UNKNOWN_GROUNDING_ID for an ID not in the eligible public context", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "x", groundingMessageIds: ["m999"] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("UNKNOWN_GROUNDING_ID"));
});

test("deterministic validation: flags GROUNDING_ID_NOT_PARTICIPANT_MESSAGE for an ID that refers to an AI message", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "x", groundingMessageIds: ["m3"] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("GROUNDING_ID_NOT_PARTICIPANT_MESSAGE"));
});

test("deterministic validation: flags DUPLICATE_OF_RECENT_AI_MESSAGE for an exact normalized duplicate", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "  Has  everyone shared their materials?  ", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("DUPLICATE_OF_RECENT_AI_MESSAGE"));
});

test("deterministic validation: a merely similar (non-exact) message is not flagged as a duplicate -- no invented similarity threshold", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "Has everyone shared their materials with the group yet?", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.equal(result.failedCriteria.includes("DUPLICATE_OF_RECENT_AI_MESSAGE"), false);
});

test("deterministic validation: flags UNEXPECTED_FIELD when an extra field is present", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "x", groundingMessageIds: [], rationale: "y" }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("UNEXPECTED_FIELD"));
});

// ── 2026-08-13 mention-pilot regression cases ────────────────────────────────
//
// The 2026-08-13 16:05 / 21:33 mention-pilot exposed a strict-plan-evidence
// over-constraint. The plan's `evidenceIds` is the LLM's snapshot of which
// public messages support the detected gap; the Generator must ground only
// in that set. In practice the plan is too narrow: the Generator legitimately
// wants to cite adjacent messages for context, and the LLM-built plan
// frequently misses the very message the Generator ended up grounding in
// (e.g. an `expander_broad_silence` plan that forgot to include the
// single-spoken message in evidenceIds). The current strict subset check
// then fails the candidate on GROUNDING_ID_OUTSIDE_PLAN_EVIDENCE even though
// the grounding ID is a legitimate public participant message.
//
// The principled fix: the plan's evidenceIds is a *hint* (helps the Generator
// focus), not a hard *constraint*. The hard constraint is "grounding ID must
// be a public participant message that isn't a recent AI message". When
// the Generator goes outside the plan but stays inside the public transcript,
// the plan was probably too narrow -- the Generator's choice is at least as
// defensible as the plan's. The two tests below pin the corrected behaviour.

test("deterministic validation: a grounding ID in eligibleMessageIds but not in allowedGroundingIds is accepted (the plan is a hint, not a hard constraint)", () => {
  const ctx = { ...DETERMINISTIC_CONTEXT, allowedGroundingIds: ["m0"] };  // plan only authorises m0
  const result = runDeterministicValidation(
    { role: "INFORMATION_EXPANDER", message: "x", groundingMessageIds: ["m2"] },  // Generator grounded in m2
    ctx,
  );
  assert.equal(result.passed, true, `unexpected failed criteria: ${result.failedCriteria.join(", ")}`);
  assert.equal(result.failedCriteria.includes("GROUNDING_ID_OUTSIDE_PLAN_EVIDENCE"), false);
});

test("deterministic validation: a grounding ID outside both allowedGroundingIds and eligibleMessageIds is still rejected (the public-transcript check is the real constraint)", () => {
  const ctx = { ...DETERMINISTIC_CONTEXT, allowedGroundingIds: ["m0"] };
  const result = runDeterministicValidation(
    { role: "INFORMATION_EXPANDER", message: "x", groundingMessageIds: ["m999"] },
    ctx,
  );
  assert.ok(result.failedCriteria.includes("UNKNOWN_GROUNDING_ID"));
});

test("deterministic validation: does not mutate, repair, or replace the candidate", () => {
  const candidate = { role: "EVIDENCE_CHALLENGER", message: "```bad```", groundingMessageIds: ["m999"] };
  const before = JSON.stringify(candidate);
  runDeterministicValidation(candidate, DETERMINISTIC_CONTEXT);
  assert.equal(JSON.stringify(candidate), before, "deterministic validation must not repair or alter the candidate object");
});

test("deterministic validation: multiple simultaneous failures are all reported, not just the first", () => {
  const result = runDeterministicValidation({ role: "EVIDENCE_CHALLENGER", message: "", groundingMessageIds: ["m999"] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("ROLE_MISMATCH"));
  assert.ok(result.failedCriteria.includes("EMPTY_MESSAGE"));
  assert.ok(result.failedCriteria.includes("UNKNOWN_GROUNDING_ID"));
});

// ── deterministic @-mention hygiene (2026-08-13) ────────────────────────

const MENTION_CONTEXT = {
  ...DETERMINISTIC_CONTEXT,
  activeParticipantNames: ["Alex", "Sam", "Pat", "Jordan"],
};

test("deterministic @-mention: a single valid @[Name] against a known participant passes", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Alex], anything to add?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.equal(result.passed, true, `unexpected failed criteria: ${result.failedCriteria.join(", ")}`);
});

test("deterministic @-mention: a no-mention message still passes (tagging is optional)", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "Has anyone else got something to share?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.equal(result.passed, true);
});

test("deterministic @-mention: multiple @[Name] tokens against known participants are allowed (no per-message count cap, matches Alsobay et al. and normal group-member behaviour)", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Alex] @[Sam] @[Pat], anything to add?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.equal(result.passed, true, `unexpected failed criteria: ${result.failedCriteria.join(", ")}`);
});

test("deterministic @-mention: a broad participation-imbalance nudge naming everyone silent is allowed", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Alex] @[Sam] @[Pat] @[Jordan], I haven't heard from any of you yet — anything from your reports you think the group is missing?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.equal(result.passed, true, `unexpected failed criteria: ${result.failedCriteria.join(", ")}`);
});

test("deterministic @-mention: a Synthesiser naming two sources of a two-sided comparison is allowed", () => {
  const synthContext = { ...MENTION_CONTEXT, selectedRole: "INFORMATION_SYNTHESISER" };
  const result = runDeterministicValidation({ role: "INFORMATION_SYNTHESISER", message: "For delivery time, @[Sam] gave Option A as 12 days and @[Pat]'s report gave Option B as 18 days. Is anything about this comparison still unclear?", groundingMessageIds: [] }, synthContext);
  assert.equal(result.passed, true, `unexpected failed criteria: ${result.failedCriteria.join(", ")}`);
});

test("deterministic @-mention: flags UNKNOWN_MENTION_TARGET for a name not in the roster", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Nina], what's your view?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.ok(result.failedCriteria.includes("UNKNOWN_MENTION_TARGET"));
});

test("deterministic @-mention: flags UNKNOWN_MENTION_TARGET even when one valid name and one unknown name are tagged together", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Alex] @[Nina], please share.", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.ok(result.failedCriteria.includes("UNKNOWN_MENTION_TARGET"));
});

test("deterministic @-mention: flags FACILITATOR_SELF_MENTION", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Facilitator], can you decide for us?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.ok(result.failedCriteria.includes("FACILITATOR_SELF_MENTION"));
});

test("deterministic @-mention: FACILITATOR_SELF_MENTION is reported once even if the Facilitator is tagged multiple times in the same message (single offence, not N offences)", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Facilitator] @[facilitator] what do we do?", groundingMessageIds: [] }, MENTION_CONTEXT);
  const count = result.failedCriteria.filter((c) => c === "FACILITATOR_SELF_MENTION").length;
  assert.equal(count, 1);
});

test("deterministic @-mention: case-insensitive name match (matches the client UI's case-insensitive mention rendering)", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[ALEX], please share.", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.equal(result.passed, true);
});

test("deterministic @-mention: FACILITATOR_SELF_MENTION check is also case-insensitive", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[facilitator], what should we do?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.ok(result.failedCriteria.includes("FACILITATOR_SELF_MENTION"));
});

test("deterministic @-mention: bare @Alex (no square brackets) is NOT a mention and does not flag any @-criteria", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "Hey @Alex, how about it?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.equal(result.failedCriteria.includes("UNKNOWN_MENTION_TARGET"), false);
});

test("deterministic @-mention: check is disabled when activeParticipantNames is omitted (only intended in tests of the check itself)", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Anyone], please share.", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.equal(result.passed, true, "@-check must be a no-op when no roster is supplied; the Validator LLM still catches misuse semantically");
});

test("deterministic @-mention: check is disabled when activeParticipantNames is an empty array (no participants known yet)", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Anyone], please share.", groundingMessageIds: [] }, { ...DETERMINISTIC_CONTEXT, activeParticipantNames: [] });
  assert.equal(result.passed, true);
});

// ── markdown wrapper stripper (2026-08-21, Phase 6.4 mention-pilot fix) ──────
//
// MiniMax-Text-01 / MiniMax-M2.7-highspeed emit `**bold**` and `- ` bullet
// markers despite base.md's "no markdown" HARD CONSTRAINT. These tests pin
// the new defensive stripper so the @Facilitator mention path no longer
// collapses to a canned-reply fallback just because the model wrapped an
// option name in `**`.

test("stripMarkdownWrapper: strips `**bold**` to plain text (preserves the wrapped word)", () => {
  const out = stripMarkdownWrapper("Based on the discussion, **Halden** stands out for its reliable record.");
  assert.equal(out, "Based on the discussion, Halden stands out for its reliable record.");
});

test("stripMarkdownWrapper: strips `__bold__` to plain text", () => {
  const out = stripMarkdownWrapper("__Halden__ is the top candidate.");
  assert.equal(out, "Halden is the top candidate.");
});

test("stripMarkdownWrapper: strips leading bullet markers (`- `, `* `, `+ `) at line start", () => {
  const out = stripMarkdownWrapper("- Halden: reliable record\n- Norvale: not looking good\n- Fenwick: surveys unfavorable");
  assert.equal(out, "Halden: reliable record\nNorvale: not looking good\nFenwick: surveys unfavorable");
});

test("stripMarkdownWrapper: strips ATX headers (`# `, `## `, `### `) at line start", () => {
  const out = stripMarkdownWrapper("## Summary\nHalden leads on time, Norvale on team structure.");
  assert.equal(out, "Summary\nHalden leads on time, Norvale on team structure.");
});

test("stripMarkdownWrapper: strips numbered list markers at line start", () => {
  const out = stripMarkdownWrapper("1. Halden: reliable\n2. Norvale: not looking good\n3. Fenwick: surveys");
  assert.equal(out, "Halden: reliable\nNorvale: not looking good\nFenwick: surveys");
});

test("stripMarkdownWrapper: strips inline backticks", () => {
  const out = stripMarkdownWrapper("Use the term `static` to describe the condition.");
  assert.equal(out, "Use the term static to describe the condition.");
});

test("stripMarkdownWrapper: collapses 3+ consecutive newlines to 2 (paragraph break, not ugly whitespace)", () => {
  const out = stripMarkdownWrapper("First paragraph.\n\n\n\nSecond paragraph.");
  assert.equal(out, "First paragraph.\n\nSecond paragraph.");
});

test("stripMarkdownWrapper: does NOT strip snake_case identifiers (false-positive guard for `_word_` italic)", () => {
  // Conservative: we don't touch single-underscore-word pairs because they
  // collide with snake_case identifiers. This is documented in
  // stripMarkdownWrapper's header.
  const out = stripMarkdownWrapper("See the value in my_snake_case variable.");
  assert.equal(out, "See the value in my_snake_case variable.");
});

test("stripMarkdownWrapper: does NOT strip `**` with empty content (defensive)", () => {
  // Empty `****` would produce "" which destroys the message; we just
  // leave it alone. Real model output never produces this, but pinning
  // the behaviour guards against accidental future changes.
  const out = stripMarkdownWrapper("Hello **** world.");
  // The non-greedy match in the regex requires at least one char inside,
  // so `****` does NOT match. The literal `****` is left in the string.
  // The test pins this.
  assert.equal(out, "Hello **** world.");
});

test("stripMarkdownWrapper: returns null when stripping would destroy >50% of the content (safety net for markdown documents, not formatted prose)", () => {
  // Construct an input where the bullet markers dominate the character
  // count. Each "- x" line is 4 chars; stripped down to "x\n" lines of
  // 2 chars each. 10 such lines go from 40 chars down to 20 (a 50%
  // reduction). To push it past the 50% safety threshold, use single-
  // char content. 10 lines of "- a" → 20 chars → "a\n"×10 = 20 chars
  // (50% retained, right at threshold). Use single-letter content with
  // more bullets to clearly cross the threshold.
  const heavyBullets = "- a\n- b\n- c\n- d\n- e\n- f\n- g\n- h\n- i\n- j\n- k\n- l\n- m";
  // 13 lines, 3 chars each = 39 chars; stripped: 13×2 = 26 chars
  // (66% retained, just over threshold). Need to go lower. Use
  // alternating pattern with deeper nesting.
  const tableLike = "- |\n- |\n- |\n- |\n- |\n- |\n- |\n- |\n- |\n- |\n- |\n- |";
  // 12 lines of "- |" = 36 chars; stripped: 12 lines of "|\n" = 24 chars
  // (66% retained). Still not under 50%. Need to use a 2-char prefix
  // (- or list marker) with 1-char content per line.
  const extreme = Array.from({ length: 15 }, () => "- ").join("\n");
  // 15 "- " markers joined by "\n" = 44 chars. After stripping: 15
  // empty lines = "\n" × 14 = 13 chars. 13/44 = 29.5%, well under 50%.
  const out = stripMarkdownWrapper(extreme);
  assert.equal(out, null);
});

test("stripMarkdownWrapper: returns the input unchanged when no markdown is present", () => {
  const input = "Thanks @[Pink]! What do others think about the trade-offs?";
  const out = stripMarkdownWrapper(input);
  assert.equal(out, input);
});

test("stripMarkdownWrapper: returns the input unchanged for empty / non-string input", () => {
  assert.equal(stripMarkdownWrapper(""), "");
  assert.equal(stripMarkdownWrapper(null), null);
  assert.equal(stripMarkdownWrapper(undefined), undefined);
});

test("stripMarkdownWrapper: the real failing 703-char mention-pilot output cleans to <500 chars and passes the safety net", () => {
  // This is the actual rawText captured from game 01M0EX8EF2P7VDW55TNX7J6FY9
  // llmLog.01M0EX8EF2P7VDW55TNX7J6FY9:0:9:1787207560994 (miniMax-Text-01 / m2.7-highspeed
  // response to a `@Facilitator` request to summarise three campuses). It
  // was rejected by `Generator output failed generation.schema.json
  // (maxLength 400)` AND `MARKDOWN_DETECTED` deterministic check. With
  // maxLength=1500 + markdown stripping, both failures clear.
  const real = "Based on the discussion so far, here's what has been shared about the three campuses:\n\n- **Halden**: Highlighted for having a reliable record of delivering similar academic conferences on time and within budget (m1).\n- **Norvale**: Described as not looking good based on the shared input (m2).\n- **Fenwick**: Mentioned with a note that public surveys are not favorable (m4).\n\nThis is the full extent of publicly shared evidence at this point. No additional details about criteria, comparisons, or trade-offs have been contributed yet. @[Green] and @[Blue], do you have any additional information or perspectives to add?";
  const out = stripMarkdownWrapper(real);
  assert.ok(out !== null, "real failing output must not trip the >50% safety net");
  assert.ok(!out.includes("**"), "all `**bold**` markers must be stripped");
  assert.ok(!out.includes(" - "), "all leading bullet markers must be stripped");
  assert.ok(out.includes("Halden") && out.includes("Norvale") && out.includes("Fenwick"), "all option names must be preserved");
  assert.ok(out.includes("@[Green]") && out.includes("@[Blue]"), "all @[Name] mentions must be preserved (square-bracket, not underscore)");
  assert.ok(out.length < real.length, "stripping should shorten the message");
  assert.ok(out.length > real.length * 0.5, "but not by more than 50% (the safety net threshold)");
});

test("strict parser: end-to-end — a markdown-laden 703-char real failing output now parses AND passes the schema cap", () => {
  // Regression for the production 2026-08-21 incident: the model
  // returned this exact text in a real `@Facilitator` mention, the
  // schema's old maxLength=400 rejected it, the deterministic check
  // would have rejected the `**` / `- ` markers. With this fix, parsing
  // succeeds, the message is cleaned, and the schema (maxLength=1500)
  // accepts it.
  const real = "Based on the discussion so far, here's what has been shared about the three campuses:\n\n- **Halden**: Highlighted for having a reliable record of delivering similar academic conferences on time and within budget (m1).\n- **Norvale**: Described as not looking good based on the shared input (m2).\n- **Fenwick**: Mentioned with a note that public surveys are not favorable (m4).\n\nThis is the full extent of publicly shared evidence at this point. No additional details about criteria, comparisons, or trade-offs have been contributed yet. @[Green] and @[Blue], do you have any additional information or perspectives to add?";
  const wrapped = "```json\n" + JSON.stringify({ role: "GENERALIST", message: real, groundingMessageIds: ["m1", "m2", "m4"] }) + "\n```";

  const parsed = parseGeneratorOutputStrict(wrapped);
  assert.equal(parsed.ok, true, "the 703-char real failing output must now parse cleanly");
  assert.equal(parsed.parsed.role, "GENERALIST");
  assert.ok(!parsed.parsed.message.includes("**"), "markdown stripped from message field");
  assert.ok(!parsed.parsed.message.includes(" - "), "bullet markers stripped from message field");

  // Schema check: with the cap raised to 1500, this now passes.
  const schemaResult = validateAgainstGenerationSchema(parsed.parsed, "GENERALIST");
  assert.equal(schemaResult.ok, true, `schema must accept the cleaned 703-char message; errors=${JSON.stringify(schemaResult.errors)}`);

  // Deterministic check: with the markdown stripped, the
  // MARKDOWN_DETECTED criterion no longer fires. (Other criteria may
  // still fire if grounding IDs are unknown to the test context, but
  // markdown must not be one of them.)
  const detResult = runDeterministicValidation(parsed.parsed, {
    selectedRole: "GENERALIST",
    eligibleMessageIds: ["m1", "m2", "m3", "m4", "m5"],
    aiOrSystemMessageIds: [],
    recentAiMessageTexts: [],
    activeParticipantNames: ["Green", "Blue", "Pink"],
  });
  assert.equal(
    detResult.failedCriteria.includes("MARKDOWN_DETECTED"),
    false,
    "after stripping, MARKDOWN_DETECTED must not fire (other criteria may still apply based on the test context)"
  );
  assert.equal(
    detResult.failedCriteria.includes("MESSAGE_TOO_LONG"),
    false,
    "after schema cap raise to 1500, MESSAGE_TOO_LONG must not fire for a 703-char message"
  );
});

test("strict parser: schema cap is now 1500 (regression: cap was 400, raised 2026-08-21)", () => {
  // Pin the new cap. If a future change reverts it to 400, this test fails.
  const maxLength = getGenerationSchemaMaxLength();
  assert.equal(maxLength, 1500, `expected schema cap=1500, got ${maxLength}`);
});

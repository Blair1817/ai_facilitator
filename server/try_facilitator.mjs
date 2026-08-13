/**
 * try_facilitator.mjs
 *
 * Standalone, read-only smoke test: feeds a sample 3-person discussion
 * into both the Static and Adaptive pipelines and prints exactly what
 * the Facilitator would say (or why it stayed silent). Makes real LLM
 * calls using server/.env -- does not touch Empirica, does not write to
 * any game/round/stage, does not modify any repo file.
 *
 * Run from inside server/:
 *   node try_facilitator.mjs
 *
 * Requires server/.env to have a working LLM_API_ENDPOINT/OPENAI_API_KEY/
 * OPENAI_MODEL (see .env.example's comments -- the endpoint must be the
 * MiniMax-compatible /chat/completions surface, not an OpenAI
 * /v1/responses endpoint, or every call below will fail with a clear
 * error printed to the console).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

// promptLoader.js / SemanticAssessor.js / SemanticValidator.js /
// GeneratorContract.mjs all resolve their SOURCE_DIR from
// dirname(process.argv[1]) + "/prompts/source" -- point that at src/ so
// it finds the real prompt files (same trick the test suite uses).
process.argv[1] = path.join(__dirname, "src", "fake-entry.js");

const { assessSemanticFactors } = await import("./src/SemanticAssessor.js");
const { checkEvidence } = await import("./src/EvidenceChecker.js");
const { evaluateGate, chooseRole, getRoleThreshold } = await import("./src/utils.js");
const { compilePlan } = await import("./src/PolicyCompiler.js");
const { llmSystemPrompts } = await import("./src/LLMConfig.js");
const { buildDynamicUserContext, withMessageIds } = await import("./src/prompts/DynamicContext.mjs");
const { buildStaticUserContext } = await import("./src/prompts/StaticContext.mjs");
const { parseGeneratorOutputStrict, validateAgainstGenerationSchema, runDeterministicValidation } = await import("./src/prompts/GeneratorContract.mjs");
const { validateCandidate } = await import("./src/SemanticValidator.js");
const { getRequestedGeneralistPromptBundle } = await import("./src/prompts/promptLoader.js");
const { containsFacilitatorMention } = await import("./src/CheckpointManager.mjs");

// ── LLM call (mirrors callbacks.js#requestChatCompletion) ─────────────────
const openaiModel = process.env.OPENAI_MODEL || "MiniMax-Text-01";
const _llmBase = process.env.LLM_API_ENDPOINT || "https://api.minimax.chat/v1";
const llmAPIEndpoint = _llmBase.endsWith("/chat/completions") ? _llmBase : `${_llmBase.replace(/\/$/, "")}/chat/completions`;

async function getLLMResponse(messages) {
  try {
    const completion = await fetch(llmAPIEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: openaiModel, max_tokens: Number.parseInt(process.env.LLM_MAX_OUTPUT_TOKENS ?? "1000", 10), messages }),
    });
    const isJson = completion.headers.get("content-type")?.includes("application/json");
    const body = isJson ? await completion.json() : await completion.text();
    if (!completion.ok) {
      return { success: false, error: `HTTP ${completion.status}: ${JSON.stringify(isJson ? body?.error || body : body).slice(0, 300)}` };
    }
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.length) return { success: false, error: "response missing message content" };
    let parsedResponseData;
    try { parsedResponseData = JSON.parse(text); } catch { parsedResponseData = undefined; }
    return { success: true, data: parsedResponseData, rawText: text };
  } catch (err) {
    return { success: false, error: `fetch failed: ${err.message}` };
  }
}

// ── Sample transcript: 3 participants, a clear info gap AND an
// unjustified converging preference AND uncompared evidence, so both
// Static and Adaptive have something to respond to. ────────────────────
const chat = [
  { text: "I think we should just go with Option A, it seems fine.", sender: { id: "p1", name: "Red" } },
  { text: "Yeah I agree, Option A sounds good to me too.", sender: { id: "p2", name: "Blue" } },
  { text: "My materials say Option A costs more upfront but I'm not sure how that compares to B long-term.", sender: { id: "p3", name: "Green" } },
  { text: "Good point, but let's not worry about the numbers too much.", sender: { id: "p1", name: "Red" } },
];

function printMessage(label, text) {
  console.log(`\n[${label}]\n${text}\n`);
}

console.log(`Using endpoint: ${llmAPIEndpoint}`);
console.log(`Using model: ${openaiModel}\n`);
console.log("=".repeat(70));

// ── STATIC ──────────────────────────────────────────────────────────────
console.log("STATIC condition\n" + "-".repeat(70));
{
  const promptResult = llmSystemPrompts("static", null);
  if (promptResult.blocked) {
    console.log("BLOCKED (prompt unavailable):", promptResult.reason);
  } else {
    const ctx = buildStaticUserContext({ chat, remainingTimeMs: 8 * 60 * 1000, elapsedTimeMs: 2 * 60 * 1000 });
    const systemPrompt = promptResult.content.replace(
      "{{sharedTaskOverview}}",
      "Task materials are not available to the facilitator. Use only facts participants explicitly share in the public transcript."
    );
    const messages = [{ role: "system", content: systemPrompt }, { role: "user", content: ctx.userContent }];
    const resp = await getLLMResponse(messages);
    if (!resp.success) {
      console.log("LLM call failed:", resp.error);
    } else {
      const parsed = parseGeneratorOutputStrict(resp.rawText);
      if (!parsed.ok) {
        console.log("Generator output failed to parse:", parsed.error, "\nraw:", resp.rawText);
      } else {
        const schemaResult = validateAgainstGenerationSchema(parsed.parsed, "STATIC");
        const detResult = runDeterministicValidation(parsed.parsed, {
          selectedRole: "STATIC",
          eligibleMessageIds: ctx.eligibleMessageIds,
          aiOrSystemMessageIds: ctx.aiOrSystemMessageIds,
          recentAiMessageTexts: ctx.recentAiMessageTexts,
        });
        if (!schemaResult.ok || !detResult.passed) {
          console.log("Candidate failed validation:", JSON.stringify(schemaResult.errors || detResult.failedCriteria));
        } else {
          const verdict = await validateCandidate({ chat, candidate: parsed.parsed, selectedRole: "STATIC", taskGeneralContext: "", callLLM: getLLMResponse });
          if (!verdict.success) {
            console.log("Validator call failed:", verdict.error, "-- candidate would be treated as SILENT.");
            printMessage("STATIC (unvalidated candidate, NOT what would actually publish)", parsed.parsed.message);
          } else if (!verdict.verdict.passed) {
            console.log("Validator REJECTED this candidate:", verdict.verdict.failedCriteria.join(", "), "-- a repair attempt would normally follow.");
            printMessage("STATIC (rejected candidate, would NOT be shown to participants)", parsed.parsed.message);
          } else {
            printMessage("STATIC (published)", parsed.parsed.message);
          }
        }
      }
    }
  }
}

// ── ADAPTIVE ────────────────────────────────────────────────────────────
console.log("=".repeat(70));
console.log("ADAPTIVE condition\n" + "-".repeat(70));
{
  const remainingTime = 8 * 60 * 1000;
  const assessorResult = await assessSemanticFactors({ chat, taskGeneralContext: "", callLLM: getLLMResponse });
  if (!assessorResult.success) {
    console.log("Semantic Assessor failed:", assessorResult.error, "-- gate would abstain (detector_unavailable).");
  } else {
    console.log("Raw Assessor factors:", JSON.stringify(assessorResult.factors, null, 2));
    const checkedFactors = checkEvidence(assessorResult.factors, { chat });
    console.log("\nChecked (verified) factors:", JSON.stringify(checkedFactors, null, 2));

    const gate = evaluateGate(checkedFactors, { remainingTime, lastRole: null });
    console.log(`\nGate decision: ${gate.decision}  reason: ${gate.reason}`);

    if (gate.decision === "abstain") {
      console.log("-> No message. This checkpoint would stay silent.");
    } else {
      let role, plan = null;
      if (gate.decision === "generalist") {
        role = "generalist";
      } else {
        const choice = chooseRole(gate, { remainingTime, lastRole: null, synthesiserFired: false });
        role = choice.role;
        console.log(`Selected role: ${role} (forced=${choice.forced}) -- ${choice.reasoning}`);
        const chatWithIds = withMessageIds(chat);
        const eligibleMessageIds = chatWithIds.map((m) => m.messageId);
        plan = compilePlan(role, checkedFactors, { score: gate.scores[role], threshold: getRoleThreshold(role), eligibleMessageIds });
        console.log("Plan:", JSON.stringify(plan, null, 2));
      }

      const promptResult = llmSystemPrompts("adaptive", role);
      if (promptResult.blocked) {
        console.log("BLOCKED (prompt unavailable):", promptResult.reason);
      } else {
        const dyn = buildDynamicUserContext({
          chat,
          checkpointDescriptor: `Checkpoint after ${chat.length} human message(s). Time remaining: ~8 min.`,
          selectedRoleForDisplay: promptResult.metadata.generationRole,
          generalInfo: "",
          plan,
        });
        const messages = [{ role: "system", content: promptResult.content }, { role: "user", content: dyn.userContent }];
        const resp = await getLLMResponse(messages);
        if (!resp.success) {
          console.log("LLM call failed:", resp.error);
        } else {
          const parsed = parseGeneratorOutputStrict(resp.rawText);
          if (!parsed.ok) {
            console.log("Generator output failed to parse:", parsed.error, "\nraw:", resp.rawText);
          } else {
            const schemaResult = validateAgainstGenerationSchema(parsed.parsed, promptResult.metadata.generationRole);
            const detResult = runDeterministicValidation(parsed.parsed, {
              selectedRole: promptResult.metadata.generationRole,
              eligibleMessageIds: dyn.eligibleMessageIds,
              aiOrSystemMessageIds: dyn.aiOrSystemMessageIds,
              recentAiMessageTexts: dyn.recentAiMessageTexts,
              allowedGroundingIds: dyn.allowedGroundingIds,
            });
            if (!schemaResult.ok || !detResult.passed) {
              console.log("Candidate failed validation:", JSON.stringify(schemaResult.errors || detResult.failedCriteria));
            } else {
              const verdict = await validateCandidate({ chat, candidate: parsed.parsed, selectedRole: promptResult.metadata.generationRole, taskGeneralContext: "", callLLM: getLLMResponse });
              if (!verdict.success) {
                console.log("Validator call failed:", verdict.error, "-- candidate would be treated as SILENT.");
                printMessage(`ADAPTIVE/${role} (unvalidated candidate, NOT what would actually publish)`, parsed.parsed.message);
              } else if (!verdict.verdict.passed) {
                console.log("Validator REJECTED this candidate:", verdict.verdict.failedCriteria.join(", "), "-- a repair attempt would normally follow.");
                printMessage(`ADAPTIVE/${role} (rejected candidate, would NOT be shown to participants)`, parsed.parsed.message);
              } else {
                printMessage(`ADAPTIVE/${role} (published)`, parsed.parsed.message);
              }
            }
          }
        }
      }
    }
  }
}

// ── PARTICIPANT REQUEST (@Facilitator) ─────────────────────────────────
// Same bundle regardless of facilitation condition: base.md +
// requested_generalist.md, no gate, no plan, no cooldown/cap check --
// this mirrors callbacks.js's isMentionCheckpoint branch exactly. Uses
// its own short chat where the LAST message explicitly mentions the
// Facilitator, since that marker is what containsFacilitatorMention()
// looks for (the same constant the client's @-mention UI emits).
console.log("=".repeat(70));
console.log("PARTICIPANT REQUEST (@Facilitator)\n" + "-".repeat(70));
{
  const requestChat = [
    ...chat,
    { text: "@[Facilitator] can you help us think about what we might be missing?", sender: { id: "p1", name: "Red" } },
  ];
  const lastMessageText = requestChat[requestChat.length - 1].text;
  console.log(`Mention detected: ${containsFacilitatorMention(lastMessageText)}`);

  const promptResult = getRequestedGeneralistPromptBundle();
  if (promptResult.blocked) {
    console.log("BLOCKED (prompt unavailable):", promptResult.reason);
    console.log("-> Would still show the fixed fallback text to the participant (see below), since a request must never go unanswered.");
  } else {
    const dyn = buildDynamicUserContext({
      chat: requestChat,
      checkpointDescriptor: `Checkpoint after ${requestChat.length} human message(s). Time remaining: ~8 min.`,
      selectedRoleForDisplay: promptResult.metadata.generationRole,
      generalInfo: "",
      plan: null,
    });
    const messages = [{ role: "system", content: promptResult.content }, { role: "user", content: dyn.userContent }];
    const resp = await getLLMResponse(messages);

    let published = false;
    if (resp.success) {
      const parsed = parseGeneratorOutputStrict(resp.rawText);
      if (parsed.ok) {
        const schemaResult = validateAgainstGenerationSchema(parsed.parsed, promptResult.metadata.generationRole);
        const detResult = runDeterministicValidation(parsed.parsed, {
          selectedRole: promptResult.metadata.generationRole,
          eligibleMessageIds: dyn.eligibleMessageIds,
          aiOrSystemMessageIds: dyn.aiOrSystemMessageIds,
          recentAiMessageTexts: dyn.recentAiMessageTexts,
          allowedGroundingIds: dyn.allowedGroundingIds,
        });
        if (schemaResult.ok && detResult.passed) {
          const verdict = await validateCandidate({ chat: requestChat, candidate: parsed.parsed, selectedRole: promptResult.metadata.generationRole, taskGeneralContext: "", callLLM: getLLMResponse });
          if (verdict.success && verdict.verdict.passed) {
            printMessage("REQUESTED_GENERALIST (published)", parsed.parsed.message);
            published = true;
          } else {
            console.log("Validator rejected or unavailable:", verdict.success ? verdict.verdict.failedCriteria.join(", ") : verdict.error);
          }
        } else {
          console.log("Candidate failed validation:", JSON.stringify(schemaResult.errors || detResult.failedCriteria));
        }
      } else {
        console.log("Generator output failed to parse:", parsed.error, "\nraw:", resp.rawText);
      }
    } else {
      console.log("LLM call failed:", resp.error);
    }

    if (!published) {
      // Exact fixed text from callbacks.js#postParticipantRequestFallback --
      // the ONE place in the whole system a non-LLM stub is ever shown to
      // participants, precisely because a request must always get a reply.
      printMessage(
        "REQUESTED_GENERALIST (fallback -- Generator/Validator path failed)",
        "I couldn’t produce a verified answer using only the public discussion. Please rephrase your question or point to the public option, criterion, claim, or message you want me to address."
      );
    }
  }
}

console.log("=".repeat(70));
console.log("Done.");

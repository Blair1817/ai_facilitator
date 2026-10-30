// Orchestration-only auditor stub. Does not assess semantic completeness.
// Dedicated SynthesisCoverage tests author missing/invalid coverage explicitly.
export function mockSynthesisCoverage(flags, userContent) {
  if (Object.hasOwn(flags, "synthesisCoverage")) return flags;
  const section = name => userContent.split(`[${name}]\n`)[1]?.split(/\n\n\[[A-Z_]+\]\n/)[0];
  const plan = JSON.parse(section("INTERVENTION_PLAN") || "null");
  if (!plan?.synthesisCoverage) return flags;
  const candidate = JSON.parse(section("CANDIDATE"));
  const sources = section("CUMULATIVE_PUBLIC_CONTEXT") || "";
  return { ...flags, synthesisCoverage: plan.synthesisCoverage.sourceMessageIds.map(messageId => {
    const source = sources.split(`[${messageId}] [`)[1]?.split("]: ")[1]?.split(/\n\[m\d+\]/)[0] || "";
    return candidate.groundingMessageIds.includes(messageId)
      ? { messageId, status: "covered", reason: "Authored mock verdict", mappings: [{ sourceQuote: source.trim(), summaryQuote: candidate.message }] }
      : { messageId, status: "no_task_information", reason: "Authored fixture excludes this source; semantic coverage is tested separately", mappings: [] };
  }) };
}

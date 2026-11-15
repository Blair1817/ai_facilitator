// Orchestration-only stubs for the SynthesisLedger extractor and auditor.
// They do not assess meaning; SynthesisLedger.test.mjs authors bad outputs explicitly.
export const ledgerKind = system => system.startsWith("# ledger_extractor.md") ? "ledger_extract"
  : system.startsWith("# ledger_auditor.md") ? "ledger_audit" : null;
const section = (content, name) => content.split(`[${name}]\n`)[1]?.split(/\n\n\[[A-Z_]+\]\n/)[0] ?? "";
export function ledgerTranscript(userContent) {
  return Object.fromEntries([...section(userContent, "PUBLIC_TRANSCRIPT").matchAll(/^\[(m\d+)\] \[[^\]]*\]: (.*)$/gm)].map(m => [m[1], m[2]]));
}
export function ledgerTargets(userContent) {
  if (userContent.includes("[TARGET_MESSAGE_IDS]")) return JSON.parse(section(userContent, "TARGET_MESSAGE_IDS").split("\n")[0]);
  return JSON.parse(section(userContent, "PROPOSED_ENTRIES")).map(entry => entry.messageId);
}
/** Every target becomes one point quoting the whole message under the first option it names. */
export function mockLedgerExtraction(userContent, { question = "How do you weigh these points together?" } = {}) {
  const options = JSON.parse(section(userContent, "OPTIONS") || "[]"), transcript = ledgerTranscript(userContent);
  return { entries: ledgerTargets(userContent).map(messageId => {
    const text = transcript[messageId] ?? "";
    return { messageId, status: "points", sameAs: null, reason: "mock",
      points: [{ option: options.find(label => text.toLowerCase().includes(label.toLowerCase())) ?? "General", text, quote: text }] };
  }), question };
}
export const mockLedgerAudit = (userContent, verdict = () => "ok", questionOk = true) => ({
  verdicts: ledgerTargets(userContent).map(messageId => ({ messageId, verdict: verdict(messageId) })), questionOk });

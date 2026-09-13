// Tiny scenario-result recorder shared by Tier 1 and Tier 2 runners. Not a
// generic assertion library -- each scenario builds its own {status,
// expected, observed, evidence, notes} record and pushes it here so both
// run_tier1.mjs and run_tier2.mjs produce the same shape, which
// generate_report.mjs then renders into TEST_REPORT.md.
export function makeRecorder() {
  const results = [];
  return {
    record(entry) {
      const required = ["id", "name", "status"];
      for (const k of required) {
        if (!(k in entry)) throw new Error(`recorder.record: missing "${k}"`);
      }
      results.push({ tier: entry.tier ?? null, id: entry.id, name: entry.name, status: entry.status, expected: entry.expected ?? null, observed: entry.observed ?? null, evidence: entry.evidence ?? null, notes: entry.notes ?? null, exception: entry.exception ?? null });
      const mark = entry.status === "PASS" ? "PASS" : entry.status === "FAIL" ? "FAIL" : "OBS ";
      console.log(`  [${mark}] #${entry.id} ${entry.name}${entry.notes ? " -- " + entry.notes : ""}`);
      return entry;
    },
    all() { return results; },
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { createAdaptiveBudget, runAdaptiveSelection } from "./AdaptiveRecovery.mjs";

const scrutiny = { need: "SCRUTINIZE", role: "challenger", operation: "unresolved_concern", target: { label: "Fenwick posters in busy corridors", messageIds: ["new-id"] } };
const repeated = { published: false, validator: { failedCriteria: ["repetition"] } };
function fixture() {
  let time = 0, current = true;
  const log = {}, budget = createAdaptiveBudget({ now: () => time, deadline: () => 200_000, isCurrent: () => current, log });
  return { log, budget, tick: n => { time = n; }, stop: () => { current = false; } };
}
test("repetition excludes a problem, reselects once, and NONE/invalid/second failure always reaches Static", async () => {
  for (const next of [{ need: "NONE" }, null, scrutiny]) {
    const f = fixture(), calls = [];
    const result = await runAdaptiveSelection({ ...f, initial: scrutiny,
      generate: async () => { calls.push("generate"); return repeated; },
      assess: async excluded => { calls.push("reselect"); assert.equal(excluded[0].target.label, scrutiny.target.label); return next; },
      fallback: async () => { calls.push("static"); return { published: true }; },
    });
    assert.equal(result.published, true);
    assert.equal(calls.filter(x => x === "reselect").length, 1);
    assert.equal(calls.at(-1), "static");
    assert.equal(f.log.recovery.counts.reselection, 1);
  }
});
test("reselection may choose another scrutiny issue; it is never forced to integrate", async () => {
  const f = fixture(); let n = 0;
  const result = await runAdaptiveSelection({ ...f, initial: scrutiny,
    generate: async selection => ++n === 1 ? repeated : { published: true, role: selection.role },
    assess: async () => ({ ...scrutiny, target: { label: "Fenwick shuttle assumption" } }),
    fallback: async () => { throw Error("unnecessary fallback"); },
  });
  assert.equal(result.role, "challenger");
});
test("timed empty scan is silent, whereas ordinary NONE still uses Static", async () => {
  for (const closeoutOnly of [true, false]) {
    const f = fixture(); let fallback = 0;
    await runAdaptiveSelection({ ...f, initial: { need: "NONE" }, closeoutOnly,
      fallback: async () => { fallback++; return { published: false }; },
    });
    assert.equal(fallback, closeoutOnly ? 0 : 1);
  }
});
test("existing explicit participant-summary deferral also survives a reselection", async () => {
  const f = fixture();
  const result = await runAdaptiveSelection({ ...f, initial: scrutiny,
    generate: async () => repeated,
    assess: async () => ({ need: "NONE", defer: { reason: "participant_summary_in_progress" } }),
    fallback: async () => { throw Error("Must not interrupt explicit participant organising"); },
  });
  assert.equal(result.published, false);
  assert.equal(f.log.reason, "participant_summary_in_progress");
});
test("shared repair counts never reset and calls read time/lifecycle again", async () => {
  const f = fixture(); let calls = 0;
  const invoke = async ({ timeoutMs }) => { assert.equal(timeoutMs, 90_000); calls++; return { success: true }; };
  await f.budget.call("assessor", invoke, "assessorRepair");
  await f.budget.call("assessor", invoke, "assessorRepair");
  assert.equal(calls, 1);
  f.tick(90_000);
  await f.budget.call("generator", invoke);
  assert.equal(calls, 1);
  assert.equal(f.log.cancellation.reason, "chain_time_budget");
  f.tick(180_000);
  assert.equal(f.budget.take("reselection"), false);
  assert.equal(f.log.cancellation.reason, "adaptive_20s_floor");
  f.stop(); assert.equal(f.budget.check(), false);
});

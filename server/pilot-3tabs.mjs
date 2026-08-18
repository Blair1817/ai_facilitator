#!/usr/bin/env node
import { chromium } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";

const TAJRIBA = "http://localhost:3000";
const PLAYERS = ["P01", "P02", "P03"];
const MESSAGES = {
  P01: [
    "Eldoron has the best schools, my kids would benefit a lot from the school district",
    "The schools there are top rated, and the neighborhood is safe for families",
    "We should consider what each city offers in terms of public services overall",
    "What do the others think about the school quality argument for Eldoron?",
    "I think Eldoron wins on schools but let me hear the tax argument too",
    "OK so we have a few strong opinions, can we compare on all criteria?",
  ],
  P02: [
    "I agree with Red, Eldoron schools are really good based on what I have read",
    "Myloria is also nice, smaller and quieter but the schools are decent",
    "But Cragnio has lower taxes which matters for our group's budget",
    "How much do the taxes actually differ between the three cities?",
    "If taxes are close, schools should win for the long term",
    "Let me look at the numbers more carefully before deciding",
  ],
  P03: [
    "Wait, what about jobs in these cities? We have to think about employment",
    "Cragnio has been growing a lot in the tech sector recently",
    "I heard Eldoron has more traditional industries and less job growth",
    "I think we need to weight schools vs jobs vs taxes carefully",
    "What about Myloria's cost of living and quality of life?",
    "Can we do a structured comparison on all the criteria?",
  ],
};

const log = (...a) => console.log(...a);

async function joinAs(page, identifier) {
  await page.goto(TAJRIBA + "/", { waitUntil: "domcontentloaded", timeout: 20000 });

  for (let try_i = 0; try_i < 60; try_i++) {
    const body = await page.locator("body").innerText().catch(() => "");
    const hasInput = await page.locator('input[name="playerID"]').count();
    const hasConsent = await page.locator('button:has-text("I agree to this consent form")').count();
    const hasContinue = await page.locator('button:has-text("Continue")').count();
    const hasTextarea = await page.locator('textarea').count();
    const noExp = body.includes("No experiments available");

    if (noExp) {
      log(`   ${identifier}: NO EXPERIMENTS AVAILABLE (try ${try_i})`);
      await sleep(2000);
      // refresh and try again
      if (try_i % 5 === 4) await page.reload({ waitUntil: "domcontentloaded" });
      continue;
    }
    if (hasConsent) {
      await page.locator('button:has-text("I agree to this consent form")').click();
      await sleep(600);
      continue;
    }
    if (hasInput) {
      log(`   ${identifier}: filling playerID`);
      await page.locator('input[name="playerID"]').fill(identifier);
      await page.locator('button:has-text("Enter")').first().click();
      await sleep(800);
      continue;
    }
    if (hasContinue) {
      await page.locator('button:has-text("Continue")').first().click();
      await sleep(600);
      continue;
    }
    if (hasTextarea) {
      log(`   ${identifier}: in game (chat textarea present)`);
      return true;
    }
    // lobby: "players connected"
    if (body.includes("players connected") || body.includes("waiting for")) {
      log(`   ${identifier}: in lobby (${body.slice(0, 80).replace(/\n/g, " ")})`);
      return true;
    }
    await sleep(1000);
  }
  return false;
}

async function sendChat(page, text) {
  const input = page.locator('textarea').first();
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.click();
  await input.fill(text);
  await page.keyboard.press("Enter");
  await sleep(300);
}

async function readLlmLog() {
  // Since the per-entry Attribute refactor (see AppendOnlyAttribute.mjs),
  // each llmLog entry is a separate Attribute keyed `llmLog.<id>` and
  // the ordered list is recovered from the `llmLogIndex` Attribute on
  // the same Scope. We group per-Scope and walk the index when present.
  const path = "/private/tmp/delibra-run.u6U3NG/.empirica/local/tajriba.json";
  if (!fs.existsSync(path)) return [];
  const content = fs.readFileSync(path, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const perScope = new Map();
  function getScope(scopeKey) {
    let s = perScope.get(scopeKey);
    if (!s) {
      s = { ids: new Set(), entries: new Map(), index: null };
      perScope.set(scopeKey, s);
    }
    return s;
  }
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.kind !== "Attribute" || !d?.obj?.key) continue;
    const key = d.obj.key;
    const scopeKey = d.obj.scopeId || d.scopeId || d.obj.id || "(unknown)";
    if (key === "llmLogIndex") {
      try { getScope(scopeKey).index = JSON.parse(d.obj.val); } catch {}
      continue;
    }
    if (key.startsWith("llmLog.")) {
      const id = key.slice("llmLog.".length);
      const scope = getScope(scopeKey);
      scope.ids.add(id);
      try { scope.entries.set(id, JSON.parse(d.obj.val)); } catch {}
    }
  }
  const out = [];
  for (const [scopeKey, scope] of perScope.entries()) {
    if (scope.ids.size === 0 && !scope.index) continue;
    const orderedIds = Array.isArray(scope.index) ? scope.index : Array.from(scope.ids);
    const entries = orderedIds
      .map((id) => scope.entries.get(id))
      .filter((e) => e && typeof e === "object");
    if (entries.length === 0) continue;
    out.push({ scopeId: scopeKey, entries });
  }
  return out;
}

async function main() {
  log("=== Pilot: 3 fake users, real Tajriba, real LLM ===\n");
  const browser = await chromium.launch({ headless: false });  // visible for debug
  const ctxs = await Promise.all(PLAYERS.map(() => browser.newContext()));

  log("1. Open 3 tabs and join");
  const pages = [];
  for (let i = 0; i < PLAYERS.length; i++) {
    const page = await ctxs[i].newPage();
    log(`   - ${PLAYERS[i]}: navigating`);
    try {
      const ok = await joinAs(page, PLAYERS[i]);
      if (!ok) {
        log(`   ✗ ${PLAYERS[i]}: joinAs failed`);
        try { await page.screenshot({ path: `/tmp/pilot-fail-${PLAYERS[i]}.png`, fullPage: true }); } catch {}
      } else {
        log(`   ✓ ${PLAYERS[i]} ready`);
      }
    } catch (e) {
      log(`   ✗ ${PLAYERS[i]} error: ${e.message.slice(0, 200)}`);
    }
    pages.push(page);
  }

  log("\n2. Wait 10s for game to start");
  await sleep(10000);
  for (let i = 0; i < PLAYERS.length; i++) {
    const url = pages[i].url();
    const hasTa = await pages[i].locator('textarea').count();
    log(`   ${PLAYERS[i]}: url=${url.replace(TAJRIBA, "")} textarea=${hasTa}`);
  }

  log("\n3. Send 6 chat messages per player (18 total)");
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < PLAYERS.length; i++) {
      const msg = MESSAGES[PLAYERS[i]][round];
      try {
        await sendChat(pages[i], msg);
        log(`   ${PLAYERS[i]}: "${msg.slice(0, 50)}..."`);
      } catch (e) {
        log(`   ${PLAYERS[i]}: chat failed: ${e.message.slice(0, 80)}`);
      }
      await sleep(2500);
    }
  }

  log("\n4. Wait 45s for LLM pipeline to settle");
  await sleep(45000);

  log("\n5. Check llmLog");
  const logs = await readLlmLog();
  log(`   found ${logs.length} games with llmLog`);
  for (const g of logs) {
    log(`   game ${g.scopeId}: ${g.entries.length} entries`);
    for (const e of g.entries.slice(-8)) {
      log(`     outcome=${e.outcome} role=${e.selectedRole || e.llmAction?.role || "?"} published=${e.messageAdded} reason=${(e.reason || "").slice(0, 60)}`);
    }
  }
  const published = logs.reduce((acc, g) => acc + g.entries.filter((e) => e.outcome === "PUBLISHED").length, 0);
  log(`\n   PUBLISHED total: ${published}`);

  for (let i = 0; i < PLAYERS.length; i++) {
    try { await pages[i].screenshot({ path: `/tmp/pilot-${PLAYERS[i]}.png`, fullPage: true }); } catch {}
  }
  log(`\n   screenshots in /tmp/pilot-*.png`);

  await browser.close();
  log("\n=== Pilot complete ===");
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
});

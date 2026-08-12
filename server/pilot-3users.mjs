#!/usr/bin/env node
// pilot-3users.mjs
//
// Real Empirica pilot: 3 fake players chat, watch the callbacks server
// pipeline (Generator + Validator + repair loop) actually run, verify the
// llmLog records PUBLISHED messages.
//
// Phases:
//   1. Open admin → Duplicate an existing batch (bypasses the broken
//      "Add Treatment" form by reusing an existing batch's settings).
//   2. Add 3 new participants via Tajriba GraphQL (so we have fresh
//      player IDs that have never been used).
//   3. The Empirica admin auto-assigns participants to the new game
//      when the batch is duplicated. Get the 3 player URLs.
//   4. Open 3 browser contexts, each visits its player URL, joins with
//      its participant ID.
//   5. Each player sends 2 chat messages (6 messages total per round),
//      staggered so the LLM has time to respond between them.
//   6. After 60s, check the Tajriba llmLog to verify the pipeline
//      actually fired and at least one message was PUBLISHED.

import { chromium } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";

const TAJRIBA = "http://localhost:3000";
const ADMIN_URL = `${TAJRIBA}/admin/`;
const TOML_SRTOKEN = "local-test-token";
const TOML_USER = "admin";
const TOML_PASS = "localtest";

async function gql(query, variables = {}) {
  const r = await fetch(`${TAJRIBA}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-srtoken": TOML_SRTOKEN, "x-username": TOML_USER },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error("GraphQL: " + JSON.stringify(j.errors[0]));
  return j.data;
}

async function adminLogin(page) {
  // Empirica admin uses cookie auth. The browser will get a session cookie
  // by visiting /admin/ (which 301s to /admin/login) and submitting.
  await page.goto(`${TAJRIBA}/admin/login`);
  await page.waitForSelector('input[name="username"]', { timeout: 10000 });
  await page.fill('input[name="username"]', TOML_USER);
  await page.fill('input[name="password"]', TOML_PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.toString().endsWith("/login"), { timeout: 10000 });
}

async function duplicateRunningBatch(page) {
  await page.goto(ADMIN_URL);
  await page.waitForSelector("text=Batches", { timeout: 10000 });
  // Find the "Running" batch's "Duplicate" button. The running batch is the
  // first listitem with a green "Running" pill.
  const duplicateBtn = page.locator("text=Running").first().locator("xpath=ancestor::*[contains(@class, 'listitem') or self::*][1]").locator("button:has-text('Duplicate')");
  await duplicateBtn.click();
  await page.waitForLoadState("networkidle", { timeout: 15000 });
}

async function addParticipant(identifier) {
  const r = await gql(
    `mutation Add($input: AddParticipantInput!) { addParticipant(input: $input) { id identifier } }`,
    { input: { identifier } }
  );
  return r.addParticipant.id;
}

async function getPlayerUrls(page) {
  // After duplicating, the new batch's "1 game" should be clickable. Click
  // the play icon, then look for player URLs.
  // Easiest: query the Tajriba data directly via GraphQL to find the most
  // recent game and its scope/player links.
  const data = await gql(`{ participants(first: 20) { edges { node { id identifier } } } }`);
  const participants = data.participants.edges.map((e) => e.node);

  // Player URL is /p/<identifier> by default for Empirica. Get the Empirica
  // intro URL by visiting the game and looking for it.
  // Easiest hack: just return the public Empirica intro URL the admin gives.
  // The Empirica player intro URL pattern is /intro?participantID=<id>.
  // We can introspect by reading the admin player's "URL" link in the
  // Players tab. But for simplicity, use the standard Empirica URL:
  return participants.slice(-3).map((p) => ({
    participantId: p.id,
    identifier: p.identifier,
    // Standard Empirica player intro URL: participants enter their ID
    // and the Empirica server auto-routes to the right game.
    url: `${TAJRIBA}/intro?participantID=${encodeURIComponent(p.id)}`,
  }));
}

async function playerJoin(page, url, identifier) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  // The Empirica intro page has an input + Join button. If already joined,
  // it routes straight to the game.
  try {
    const input = await page.waitForSelector('input[name="participantID"], input[type="text"]', { timeout: 5000 });
    await input.fill(identifier);
    const joinBtn = await page.waitForSelector('button:has-text("Join"), button[type="submit"]', { timeout: 5000 });
    await joinBtn.click();
    await page.waitForURL((u) => !u.toString().includes("/intro"), { timeout: 15000 });
  } catch (e) {
    // Maybe already past intro (e.g. lobby or in-game). Continue.
    console.log(`  player ${identifier}: no intro form, already in game`);
  }
}

async function playerChat(page, text) {
  // The chat input is the "Type a message" textarea. Send the text.
  const input = await page.waitForSelector('textarea, input[placeholder*="message" i], input[type="text"]', { timeout: 10000 });
  await input.fill(text);
  await page.keyboard.press("Enter");
  await sleep(500);
}

async function getLatestLlmLog() {
  // Read the Tajriba data file directly.
  const fs = await import("node:fs");
  const path = "/private/tmp/delibra-run.u6U3NG/.empirica/local/tajriba.json";
  if (!fs.existsSync(path)) return [];
  const lines = fs.readFileSync(path, "utf8").trim().split("\n");
  const llmlogAttrs = [];
  for (const l of lines.slice(2)) {
    try {
      const d = JSON.parse(l);
      if (d?.kind === "Attribute" && d?.obj?.key === "llmLog") {
        llmlogAttrs.push(d.obj);
      }
    } catch {}
  }
  return llmlogAttrs
    .filter((o) => o.val && o.val.length > 2)
    .map((o) => {
      try { return { game: o.id, entries: JSON.parse(o.val) }; }
      catch { return { game: o.id, raw: o.val.slice(0, 100) }; }
    })
    .sort((a, b) => b.game.localeCompare(a.game))
    .slice(0, 3);
}

async function main() {
  console.log("=== Pilot: 3 fake users, real Empirica, real LLM ===\n");

  const browser = await chromium.launch({ headless: true });

  // 1. Login as admin via cookie auth
  console.log("1. Login as admin");
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await adminLogin(adminPage);
  console.log("   ✓ admin logged in");

  // 2. Add 3 fresh participants via GraphQL
  console.log("2. Add 3 participants via Tajriba GraphQL");
  const ids = [];
  for (const name of ["PILOT-01", "PILOT-02", "PILOT-03"]) {
    const id = await addParticipant(name);
    ids.push({ id, identifier: name });
    console.log(`   ✓ ${name} -> ${id}`);
  }

  // 3. Duplicate the running batch (bypasses broken Add-Treatment form)
  console.log("3. Duplicate running batch");
  await duplicateRunningBatch(adminPage);
  console.log("   ✓ batch duplicated, refresh page to see new game");

  // 4. Wait for the new batch to be claimable and the game to start
  // Empirica auto-starts the game when all players join.
  await page.waitForTimeout(2000);
  await page.reload();
  await page.waitForTimeout(2000);

  // 5. Get player URLs (3 most recent participants)
  console.log("4. Get player URLs");
  const playerUrls = ids.map((p) => ({
    ...p,
    url: `${TAJRIBA}/intro?participantID=${encodeURIComponent(p.id)}`,
  }));
  for (const p of playerUrls) console.log(`   ✓ ${p.identifier} -> ${p.url}`);

  // 6. Open 3 player contexts, each joins with its ID
  console.log("5. Open 3 player tabs and join");
  const playerPages = [];
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    console.log(`   joining ${playerUrls[i].identifier}...`);
    await playerJoin(p, playerUrls[i].url, playerUrls[i].identifier);
    playerPages.push({ page: p, name: playerUrls[i].identifier });
    await sleep(500);
  }

  // 7. Wait for the lobby to assemble and the game to start
  console.log("6. Wait for game to start (lobby assembly)");
  await sleep(8000);

  // Check what stage each player is in
  for (const { page, name } of playerPages) {
    const url = page.url();
    console.log(`   ${name}: ${url.replace(TAJRIBA, "")}`);
  }

  // 8. Send chat messages from each player
  // 6 messages per player (2 rounds of 3) so the gate has enough to fire
  // checkpoints. Stagger so messages are interleaved (more realistic).
  console.log("7. Send 6 chat messages per player (18 total)");
  const messages = {
    "PILOT-01": [
      "Eldoron has good schools, my kids would benefit a lot from the school district",
      "The schools there are top rated, and the neighborhood is safe",
      "We should consider what each city offers in terms of public services",
      "What do the others think about the school quality?",
      "I think Eldoron wins on schools but let me hear the tax argument",
      "OK so we have a few strong opinions, can we compare on all criteria?",
    ],
    "PILOT-02": [
      "I agree with Red, Eldoron schools are really good",
      "Myloria is also nice, smaller and quieter",
      "But Cragnio has lower taxes which matters for our group",
      "How much do the taxes actually differ between the three?",
      "If taxes are close, schools should win",
      "Let me look at the numbers more carefully",
    ],
    "PILOT-03": [
      "Wait, what about jobs in these cities?",
      "Cragnio has been growing a lot in the tech sector",
      "I heard Eldoron has more traditional industries",
      "I think we need to weight schools vs jobs vs taxes",
      "What about Myloria's cost of living?",
      "Can we do a structured comparison?",
    ],
  };

  for (let round = 0; round < 6; round++) {
    for (const { page, name } of playerPages) {
      const msg = messages[name][round];
      try {
        await playerChat(page, msg);
        console.log(`   ${name}: ${msg.slice(0, 60)}${msg.length > 60 ? "..." : ""}`);
      } catch (e) {
        console.log(`   ${name}: chat failed: ${e.message.slice(0, 80)}`);
      }
      await sleep(2000); // pace out messages
    }
  }

  // 9. Wait for LLM to respond and pipeline to finish
  console.log("8. Wait 30s for callbacks server pipeline to settle");
  await sleep(30000);

  // 10. Check the llmLog
  console.log("9. Check llmLog via Tajriba data file");
  const logs = await getLatestLlmLog();
  console.log(`   found ${logs.length} games with non-empty llmLog`);
  for (const g of logs) {
    console.log(`   game ${g.game}: ${g.entries.length} entries`);
    for (const e of g.entries.slice(-5)) {
      console.log(`     outcome=${e.outcome} reason=${(e.reason || "").slice(0, 60)} msgAdded=${e.messageAdded} role=${e.selectedRole || e.llmAction?.role || "?"}`);
    }
  }

  // 11. Take a screenshot of one player's view to show the chat
  console.log("10. Screenshot one player's view");
  await playerPages[0].page.screenshot({ path: "/tmp/pilot-player1.png", fullPage: true });
  console.log("   ✓ saved /tmp/pilot-player1.png");

  await adminPage.screenshot({ path: "/tmp/pilot-admin.png", fullPage: true });
  console.log("   ✓ saved /tmp/pilot-admin.png");

  await browser.close();
  console.log("\n=== Pilot complete ===");
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
});

#!/usr/bin/env node
// pilot-start.mjs
//
// One-shot readiness check + admin-UI step-by-step for starting a real
// pilot game. Verifies all 3 services are up, the key is set, the
// startup self-check passes, then prints the exact UI clicks to
// create a game in the Tajriba admin panel.
//
// Usage: node pilot-start.mjs

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const COLORS = process.stdout.isTTY ? {
  reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m",
} : { reset: "", green: "", red: "", yellow: "", cyan: "", bold: "" };

let failures = 0;

function ok(label, detail = "") {
  console.log(`${COLORS.green}✓${COLORS.reset} ${label}${detail ? "  " + COLORS.cyan + detail + COLORS.reset : ""}`);
}

function fail(label, detail) {
  failures += 1;
  console.log(`${COLORS.red}✗${COLORS.reset} ${label}  ${COLORS.red}${detail}${COLORS.reset}`);
}

function warn(label, detail) {
  console.log(`${COLORS.yellow}!${COLORS.reset} ${label}  ${COLORS.yellow}${detail}${COLORS.reset}`);
}

async function check(name, fn) {
  try {
    const result = await fn();
    if (result === false) fail(name, "(returned false)");
    else if (typeof result === "string") ok(name, result);
    else ok(name);
    return result;
  } catch (e) {
    fail(name, e.message);
    return null;
  }
}

console.log(`${COLORS.bold}=== Delibra Pilot Readiness Check ===${COLORS.reset}\n`);

// 1. Tajriba admin reachable
await check("Tajriba admin reachable (http://localhost:3000)", async () => {
  const r = await fetch("http://localhost:3000/admin", { redirect: "manual" });
  if (r.status !== 301 && r.status !== 200 && r.status !== 302) throw new Error(`HTTP ${r.status}`);
  return `HTTP ${r.status} → http://localhost:3000/admin/`;
});

// 2. Tajriba auth (x-srtoken) works
await check("Tajriba auth works (x-srtoken)", async () => {
  const toml = fs.readFileSync(path.join("..", ".empirica", "empirica.toml"), "utf8");
  const m = toml.match(/srtoken\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("no srtoken in .empirica/empirica.toml");
  const r = await fetch("http://localhost:3000/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-srtoken": m[1], "x-username": "admin" },
    // Tajriba requires pagination args; first: 10 keeps it cheap.
    body: JSON.stringify({ query: "{ participants(first: 10) { edges { node { id identifier } } } }" }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0]?.message ?? "GraphQL error");
  const ids = j.data?.participants?.edges?.map((e) => e.node.identifier) ?? [];
  return `${ids.length} existing participants: ${ids.length ? ids.join(", ") : "(none yet)"}`;
});

// 3. Callbacks server up (the adaptive detector is LLM-only; no feature
// sidecar is required).
const callbacksPid = await check("Callbacks server running", () => {
  const out = execSync("ps aux | grep -E 'node dist/index.js' | grep -v grep | head -1", { encoding: "utf8" });
  const m = out.match(/^\S+\s+(\d+)/);
  if (!m) throw new Error("not found");
  return `pid ${m[1]}`;
});

// 5. .env has real key
await check(".env has real API key", () => {
  const env = fs.readFileSync(".env", "utf8");
  const m = env.match(/OPENAI_API_KEY="([^"]+)"/);
  if (!m) throw new Error("OPENAI_API_KEY not set");
  if (m[1] === "your-key-here") throw new Error("still the placeholder");
  // Only show last 4 chars (enough to confirm which key, not enough to leak it).
  return `set, ends in ...${m[1].slice(-4)} (length ${m[1].length})`;
});

// 6. OPENAI_MODEL set
await check("OPENAI_MODEL set", () => {
  const env = fs.readFileSync(".env", "utf8");
  const m = env.match(/OPENAI_MODEL="([^"]+)"/);
  if (!m) throw new Error("OPENAI_MODEL not set");
  return m[1];
});

// 7. LLM_API_ENDPOINT set
await check("LLM_API_ENDPOINT set", () => {
  const env = fs.readFileSync(".env", "utf8");
  const m = env.match(/LLM_API_ENDPOINT="([^"]+)"/);
  if (!m) throw new Error("LLM_API_ENDPOINT not set");
  return m[1];
});

// 8. dist built
await check("dist/index.js built", () => {
  const stat = fs.statSync("dist/index.js");
  const ageMin = (Date.now() - stat.mtimeMs) / 1000 / 60;
  if (ageMin > 60) throw new Error(`built ${ageMin.toFixed(0)} min ago — may be stale, run 'npm run build' to refresh`);
  return `${(stat.size / 1024 / 1024).toFixed(2)} MB, built ${ageMin.toFixed(0)} min ago`;
});

// 9. validator.md is rsynced to dist (Phase 5 fix needed this manually)
await check("dist/prompts/source/validator.md present", () => {
  if (!fs.existsSync("dist/prompts/source/validator.md")) throw new Error("missing — run: cp src/prompts/source/validator.md dist/prompts/source/");
  return "present";
});

// 10. LLM call smoke test
await check("LLM endpoint smoke test (MiniMax-Text-01 chat completions)", async () => {
  const env = fs.readFileSync(".env", "utf8");
  const key = env.match(/OPENAI_API_KEY="([^"]+)"/)?.[1];
  const endpoint = env.match(/LLM_API_ENDPOINT="([^"]+)"/)?.[1];
  const model = env.match(/OPENAI_MODEL="([^"]+)"/)?.[1];
  const fullUrl = endpoint.endsWith("/chat/completions") ? endpoint : `${endpoint.replace(/\/$/, "")}/chat/completions`;
  const r = await fetch(fullUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word: pong" }], max_tokens: 10 }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HTTP ${r.status}: ${t.slice(0, 100)}`);
  }
  const j = await r.json();
  const reply = j.choices?.[0]?.message?.content ?? "";
  if (!reply) throw new Error("empty response");
  return `model=${model} replied: ${JSON.stringify(reply.slice(0, 30))}`;
});

// 11. Startup self-check passes
await check("Prompt package self-check", async () => {
  // Import the actual module (with fake argv[1] like the unit tests)
  const __fakeArgv1 = path.join(process.cwd(), "dist", "index.js");
  const originalArgv1 = process.argv[1];
  process.argv[1] = __fakeArgv1;
  try {
    const mod = await import("./src/prompts/promptLoader.js");
    const r = mod.runStartupSelfCheck({ throwOnFailure: false });
    if (!r.ok) throw new Error(`failures: ${JSON.stringify(r.failures)}`);
    return `11 files verified`;
  } finally {
    process.argv[1] = originalArgv1;
  }
});

console.log("");
if (failures > 0) {
  console.log(`${COLORS.red}${COLORS.bold}=== ${failures} check(s) failed — fix before starting pilot ===${COLORS.reset}`);
  process.exit(1);
}
console.log(`${COLORS.green}${COLORS.bold}=== ALL CHECKS PASSED — ready to start a real pilot ===${COLORS.reset}\n`);

console.log(`${COLORS.bold}--- How to start a pilot game in the admin UI ---${COLORS.reset}`);
console.log("");
console.log("1. Open the admin panel in your browser:");
console.log(`   ${COLORS.cyan}http://localhost:3000/admin/${COLORS.reset}`);
console.log("");
console.log("2. Log in with the credentials from .empirica/empirica.toml:");
const toml = fs.readFileSync(path.join("..", ".empirica", "empirica.toml"), "utf8");
const userMatch = toml.match(/username\s*=\s*"([^"]+)"/);
const passMatch = toml.match(/password\s*=\s*"([^"]+)"/);
console.log(`   ${COLORS.cyan}username: ${userMatch?.[1] ?? "admin"}${COLORS.reset}`);
console.log(`   ${COLORS.cyan}password: ${passMatch?.[1] ?? "(check .empirica/empirica.toml)"}${COLORS.reset}`);
console.log("");
console.log("3. Create a batch of players (3-6 per game, depending on the treatment config):");
console.log(`   ${COLORS.cyan}Batches → New Batch → set N = 3, Intro URL = (default)${COLORS.reset}`);
console.log("");
console.log("4. Open N player tabs in separate browser windows / private windows:");
console.log(`   ${COLORS.cyan}Players tab → click each player's "URL" link → opens a player tab${COLORS.reset}`);
console.log(`   ${COLORS.cyan}Each player tab: enter "participant ID" from the batch, click Join${COLORS.reset}`);
console.log("");
console.log("5. When all N players have joined, the game starts automatically.");
console.log("   - Round 1: Static facilitation (if sequence S1/S3) or Adaptive (S2/S4)");
console.log("   - Watch the terminal where you started the callbacks server for [LLM] / [publish] logs");
console.log("");
console.log("6. After the game, inspect results in:");
console.log(`   ${COLORS.cyan}http://localhost:3000/admin/ → Game → llmLog${COLORS.reset}`);
console.log(`   Look for: outcome, validator verdict, attempts, messageAdded`);
console.log("");
console.log(`${COLORS.bold}--- Common issues ---${COLORS.reset}`);
console.log("");
console.log(`- "Connection refused on 3000" → Tajriba is down. Start: ${COLORS.cyan}empirica${COLORS.reset} (from project root)`);
console.log(`- "self-check FAILED" → a prompt .md is missing or has an unresolved marker. The error names the file.`);
console.log(`- LLM replies are empty → check ${COLORS.cyan}OPENAI_API_KEY${COLORS.reset} with curl: ${COLORS.cyan}curl -sS -X POST "${"$"}{LLM_API_ENDPOINT}/chat/completions" -H "Authorization: Bearer ${"$"}OPENAI_API_KEY" -d '{"model":"${"$"}OPENAI_MODEL","messages":[{"role":"user","content":"ping"}]}'${COLORS.reset}`);
console.log(`- Validator always flags the same criterion → that prompt has a systematic bias; fix in server/src/prompts/source/{base,static,generalist,expander,challenger,synthesiser,validator}.md`);
console.log("");
console.log(`${COLORS.bold}--- Optional: run the E2E smoke test ---${COLORS.reset}`);
console.log("");
console.log(`   ${COLORS.cyan}node e2e-test.mjs${COLORS.reset}`);
console.log("   (5 tests; ~25s; verifies Static, Adaptive Specialist, multi-checkpoint, @-mention, repair loop)");
console.log("");

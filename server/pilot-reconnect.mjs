#!/usr/bin/env node
import { chromium } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";

const TAJRIBA = "http://localhost:3000";
const PLAYERS = ["P01", "P02", "P03"];

const browser = await chromium.launch({ headless: true });
const ctxs = await Promise.all(PLAYERS.map(() => browser.newContext()));
const pages = await Promise.all(ctxs.map((c) => c.newPage()));

for (let i = 0; i < PLAYERS.length; i++) {
  console.log(`- ${PLAYERS[i]}: navigating`);
  try {
    await pages[i].goto(TAJRIBA + "/", { waitUntil: "domcontentloaded", timeout: 20000 });

    // Wait for either consent, player create, or game
    for (let try_i = 0; try_i < 60; try_i++) {
      const txt = await pages[i].locator("body").innerText().catch(() => "");
      const hasInput = await pages[i].locator('input[name="playerID"]').count();
      const hasConsent = await pages[i].locator('button:has-text("I agree to this consent form")').count();
      const hasContinue = await pages[i].locator('button:has-text("Continue")').count();
      const hasTextarea = await pages[i].locator('textarea').count();
      const noExp = txt.includes("No experiments available");
      console.log(`  ${PLAYERS[i]} try=${try_i} input=${hasInput} consent=${hasConsent} cont=${hasContinue} textarea=${hasTextarea} noexp=${noExp}`);

      if (hasConsent) {
        await pages[i].locator('button:has-text("I agree to this consent form")').click();
        await sleep(800);
        continue;
      }
      if (hasInput) {
        await pages[i].locator('input[name="playerID"]').fill(PLAYERS[i]);
        await pages[i].locator('button:has-text("Enter")').first().click();
        await sleep(800);
        continue;
      }
      if (hasContinue) {
        await pages[i].locator('button:has-text("Continue")').first().click();
        await sleep(800);
        continue;
      }
      if (hasTextarea) {
        console.log(`  ${PLAYERS[i]}: in game with chat textarea`);
        break;
      }
      if (noExp) {
        console.log(`  ${PLAYERS[i]}: NO EXPERIMENTS AVAILABLE`);
        break;
      }
      await sleep(1000);
    }
  } catch (e) {
    console.log(`  ${PLAYERS[i]} ERROR: ${e.message.slice(0, 200)}`);
  }
}

await sleep(3000);
for (const p of pages) {
  const url = p.url();
  const body = await p.locator("body").innerText().catch(() => "(no body)");
  console.log(`URL: ${url.replace(TAJRIBA, "")} BODY: ${body.slice(0, 200).replace(/\n/g, " | ")}`);
}

await browser.close();

import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("http://localhost:3000/admin/login");
const html = await page.content();
console.log(html.slice(0, 3000));
await browser.close();

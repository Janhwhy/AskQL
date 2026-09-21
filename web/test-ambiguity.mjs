import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.getByPlaceholder(/Ask about/).fill("How's support doing?");
await page.keyboard.press("Enter");

// wait for clarification chips to appear
await page.waitForSelector("text=/Do you mean|Do you want/", { timeout: 40000 }).catch((e) =>
  console.log("clarification wait failed:", e.message)
);
await page.waitForTimeout(500);
await page.screenshot({ path: "screenshots/06-ambiguity.png" });
console.log("STEP done: ambiguity screenshot");

// click the first chip
const chip = page.locator("button", { hasText: /tickets|backlog/i }).first();
await chip.click();
await page.waitForSelector("text=View SQL", { timeout: 40000 }).catch((e) => console.log("resolve wait failed:", e.message));
await page.waitForTimeout(2500);
await page.screenshot({ path: "screenshots/07-ambiguity-resolved.png" });
console.log("STEP done: resolved screenshot");

console.log("ERRORS:", JSON.stringify(errors));
await browser.close();

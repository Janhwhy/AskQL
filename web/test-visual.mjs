import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

page.on("response", async (res) => {
  if (res.url().includes("/chat")) {
    const body = await res.text().catch(() => "<unreadable>");
    console.log("=== /chat response body ===\n", body.slice(-1500));
  }
});

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.screenshot({ path: "screenshots/01-empty-state.png" });
console.log("STEP 1 done: empty state screenshot");

// click the first example prompt
await page.getByText("What was total revenue yesterday?").click();
await page.waitForTimeout(800);
await page.screenshot({ path: "screenshots/02-streaming.png" });
console.log("STEP 2 done: mid-stream screenshot");

// wait for the answer to settle — "View SQL" only appears once status is "done"
await page.waitForSelector("text=View SQL", { timeout: 40000 }).catch((e) => console.log("STEP 3 wait failed:", e.message));
await page.screenshot({ path: "screenshots/03-answered.png" });
console.log("STEP 3 done: answered screenshot");

// ask a chart-producing question
await page.getByPlaceholder(/Ask about/).fill("Show me daily revenue for the last 14 days");
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
const sqlLocator = page.locator("text=View SQL");
for (let i = 0; i < 40; i++) {
  if ((await sqlLocator.count()) >= 2) break;
  await page.waitForTimeout(1000);
}
// Recharts animates the line path in on mount (~1.5s default) -- give it
// time to finish before screenshotting, or the tail looks disconnected.
await page.waitForTimeout(2500);
await page.screenshot({ path: "screenshots/04-line-chart.png" });
console.log("STEP 4 done: line chart screenshot, View SQL count =", await sqlLocator.count());

// toggle theme
await page.getByLabel("Toggle theme").click();
await page.waitForTimeout(300);
await page.screenshot({ path: "screenshots/05-light-theme.png" });
console.log("STEP 5 done: light theme screenshot");

console.log("CONSOLE_ERRORS:", JSON.stringify(consoleErrors, null, 2));

await browser.close();

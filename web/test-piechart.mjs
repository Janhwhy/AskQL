import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });

const questions = [
  ["pie chart for all regions by their revenue", "11-pie-chart.png"],
  ["show revenue by category as a bar chart", "12-explicit-bar.png"],
  ["give me support tickets opened by category as a table", "13-explicit-table.png"],
  ["pie chart of average deal size", "14-pie-unsupported-shape.png"], // single KPI, should degrade gracefully
];

for (const [q, file] of questions) {
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.getByPlaceholder(/Ask about/).fill(q);
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=View SQL", { timeout: 40000 }).catch((e) => console.log(`${q}: wait failed:`, e.message));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `screenshots/${file}`, fullPage: true });
  console.log(`done: ${q} -> ${file}`);
}

console.log("ERRORS:", JSON.stringify(errors, null, 2));
await browser.close();

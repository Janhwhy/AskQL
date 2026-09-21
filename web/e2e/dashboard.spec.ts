import { expect, test, type Page } from "@playwright/test";

/**
 * Real regression coverage for the Phase 7 dashboard work -- every one of
 * these assertions targets a bug that was previously only caught by a
 * human clicking around a live browser:
 *
 * - "table of X" silently rendering as a bar chart (decide_chart's table
 *   regex never matched the bare word "table" by itself).
 * - A pinned chart's SVG existing in the DOM with valid-looking attributes
 *   but never visually drawing (a ResizeObserver feedback loop corrupting
 *   Recharts' draw-in animation -- asserting element COUNT or presence
 *   alone would NOT catch this; the `d` attribute length and bounding-box
 *   width checks below are what actually would have failed before the fix).
 * - Dashboard tiles only being draggable from a ~20px title sliver (the
 *   chart body carried a blanket "no-drag" class) -- the drag below
 *   deliberately grabs the tile's BODY, not its header.
 */

async function askQuestion(page: Page, question: string) {
  const input = page.getByPlaceholder(/Ask about revenue/);
  await input.click();
  await input.fill(question);
  await input.press("Enter");
}

async function pinLastAnswer(page: Page, dashboardName: string, createNew: boolean) {
  await page.getByRole("button", { name: "Pin to dashboard" }).last().click();
  if (createNew) {
    await page.getByPlaceholder("New dashboard name").fill(dashboardName);
    await page.getByLabel("Create dashboard and pin").click();
  } else {
    await page.getByRole("button", { name: new RegExp(dashboardName) }).click();
  }
  await expect(page.getByText(/Pinned to/)).toBeVisible({ timeout: 15_000 });
}

test("table request renders an actual table, not a bar chart", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await askQuestion(page, "Table of top 10 products by revenue");

  const table = page.locator("table");
  await expect(table).toBeVisible({ timeout: 60_000 });
  expect(await page.locator(".recharts-wrapper").count()).toBe(0);
  expect(await table.locator("tbody tr").count()).toBeGreaterThan(0);
});

test("a pinned chart renders real geometry, and dragging a tile by its body persists the new position", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const dashboardName = `E2E Dashboard ${Date.now()}`;

  await page.goto("/");

  // Turn 1: table -- also exercises the pin flow for a non-chart type.
  await askQuestion(page, "Table of top 10 products by revenue");
  await expect(page.locator("table")).toBeVisible({ timeout: 60_000 });
  await pinLastAnswer(page, dashboardName, true);

  // Turn 2: a line chart -- this is what actually exercises the
  // ResizeObserver/animation bug class once it lands on a dashboard tile.
  await askQuestion(page, "Show me daily revenue for the last 14 days");
  const chatLine = page.locator("path.recharts-line-curve").first();
  await expect(chatLine).toBeVisible({ timeout: 60_000 });
  await pinLastAnswer(page, dashboardName, false);

  await page.goto("/dashboards");
  await page.getByRole("link", { name: new RegExp(dashboardName) }).click();

  const tiles = page.locator(".react-grid-item");
  await expect(tiles).toHaveCount(2);

  // Both tiles must show REAL content, not just exist. A table needs rows;
  // a line chart needs a path with real path data AND a real rendered
  // width -- the ResizeObserver bug left a path in the DOM with a
  // plausible-looking `d` string whose stroke never actually drew, so
  // checking `d` length alone (without also checking the rendered box)
  // would have passed even on the broken version.
  await expect(page.locator(".react-grid-item table")).toBeVisible();
  expect(await page.locator(".react-grid-item table tbody tr").count()).toBeGreaterThan(0);

  const dashLine = page.locator(".react-grid-item path.recharts-line-curve").first();
  await expect(dashLine).toBeVisible({ timeout: 15_000 });
  const d = await dashLine.getAttribute("d");
  expect(d?.length ?? 0).toBeGreaterThan(20);
  const lineBox = await dashLine.boundingBox();
  expect(lineBox?.width ?? 0).toBeGreaterThan(50);

  // Drag the second tile by a point well INSIDE its body (not the title
  // row) -- this is the exact interaction that used to do nothing.
  const secondTile = tiles.nth(1);
  await secondTile.scrollIntoViewIfNeeded();
  const beforeStyle = await secondTile.getAttribute("style");
  const box = await secondTile.boundingBox();
  if (!box) throw new Error("second tile has no bounding box");
  const fromX = box.x + box.width / 2;
  const fromY = box.y + box.height * 0.7;

  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX + 250, fromY - 150, { steps: 8 });
  await page.mouse.up();

  const afterStyle = await secondTile.getAttribute("style");
  expect(afterStyle).not.toBe(beforeStyle);

  // Layout persistence: PUT /dashboards/{id}/layout must have actually
  // been called and saved, not just updated client-side state.
  await page.reload();
  await expect(page.locator(".react-grid-item")).toHaveCount(2);
  const persistedStyle = await page.locator(".react-grid-item").nth(1).getAttribute("style");
  expect(persistedStyle).toBe(afterStyle);
});

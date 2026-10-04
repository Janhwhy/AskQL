import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 8b report canvas: visual formatting, rich text boxes, free
 * placement and pages. Seeded through the API with a fixed, known-good SQL
 * query (no LLM in the loop), so this exercises only the frontend
 * rendering/interaction/persistence it's meant to cover.
 */

const API = "http://localhost:8000";
const REGION_SQL =
  "SELECT customers.region, SUM(sales.amount) AS revenue FROM sales " +
  "JOIN customers ON customers.customer_id = sales.customer_id GROUP BY customers.region";

async function seed(request: import("@playwright/test").APIRequestContext) {
  const dash = await (await request.post(`${API}/dashboards`, { data: { name: `E2E Canvas ${Date.now()}` } })).json();
  await request.post(`${API}/dashboards/${dash.id}/items`, {
    data: { question: "revenue by region", sql: REGION_SQL, chart_type: "bar", x: "region", y: "revenue" },
  });
  return dash.id as string;
}

async function styleBox(page: Page, testId: string) {
  return page.getByTestId(testId).first().evaluate((el) => {
    const s = (el as HTMLElement).style;
    return { left: parseFloat(s.left), top: parseFloat(s.top) };
  });
}

test("format a visual; write and style a text box; everything persists", async ({ page, request }) => {
  const id = await seed(request);
  try {
    await page.goto(`/dashboards/${id}`);
    const tile = page.getByTestId("chart-tile");
    await expect(tile.locator(".recharts-bar-rectangle").first()).toBeVisible();

    // View mode is a clean presentation surface: no format pane.
    await expect(page.getByRole("complementary", { name: "Format pane" })).toHaveCount(0);

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const pane = page.getByRole("complementary", { name: "Format pane" });
    await expect(pane.getByText("Format page")).toBeVisible(); // nothing selected -> page settings

    await tile.click();
    await expect(pane.getByText("Format visual")).toBeVisible();
    await pane.getByRole("textbox", { name: "Title" }).fill("Where the money is");
    await pane.getByRole("radio", { name: "Donut" }).click();
    await pane.getByRole("radio", { name: "Color 3" }).click();

    await expect(tile.getByTestId("tile-title")).toHaveText("Where the money is");
    const sector = tile.locator(".recharts-pie-sector path").first();
    await expect(sector).toBeVisible();
    expect((await sector.boundingBox())?.width ?? 0).toBeGreaterThan(20);

    // Text box: insert -> type -> select all -> bold via the floating toolbar
    await page.getByRole("button", { name: "Text box" }).click();
    const editor = page.getByRole("textbox", { name: "Text box content" });
    await expect(editor).toBeFocused();
    await page.keyboard.type("Weekly review");
    await page.keyboard.press("Control+a");
    await page.getByRole("toolbar", { name: "Text formatting" }).getByRole("button", { name: "Bold" }).click();
    await expect(editor.locator("b, strong, span[style*='font-weight']").first()).toBeVisible();
    await page.keyboard.press("Escape"); // leave editing -> saves

    await page.waitForTimeout(800); // config saves are debounced
    await page.reload();

    const reloaded = page.getByTestId("chart-tile");
    await expect(reloaded.getByTestId("tile-title")).toHaveText("Where the money is");
    await expect(reloaded.locator(".recharts-pie-sector").first()).toBeVisible();
    const text = page.getByTestId("text-tile");
    await expect(text).toContainText("Weekly review");
    expect(await text.locator("b, strong, [style*='font-weight']").count()).toBeGreaterThan(0);

    const stored = await (await request.get(`${API}/dashboards/${id}`)).json();
    const chart = stored.items.find((i: { kind: string }) => i.kind === "chart");
    expect(chart.config).toMatchObject({ title: "Where the money is", display_type: "donut", color: 3 });
  } finally {
    await request.delete(`${API}/dashboards/${id}`);
  }
});

test("a visual drags freely, snaps, persists; pages can be added and renamed", async ({ page, request }) => {
  const id = await seed(request);
  try {
    await page.goto(`/dashboards/${id}`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const tile = page.getByTestId("chart-tile");
    await expect(tile.locator(".recharts-bar-rectangle").first()).toBeVisible();

    const before = await styleBox(page, "chart-tile");
    const box = await tile.boundingBox();
    if (!box) throw new Error("no tile box");
    // grab the BODY of the chart, not an edge
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 230, box.y + box.height / 2 + 140, { steps: 10 });
    await page.mouse.up();

    const after = await styleBox(page, "chart-tile");
    expect(after.left).toBeGreaterThan(before.left + 50);
    expect(after.top).toBeGreaterThan(before.top + 30);

    // persisted, and snapped to the 8px page grid (or an alignment guide)
    const stored = await (await request.get(`${API}/dashboards/${id}`)).json();
    const layout = stored.items[0].layout;
    expect(layout.x).toBeGreaterThan(24);
    expect(Number.isInteger(layout.x) && Number.isInteger(layout.y)).toBe(true);
    await page.reload();
    await expect(page.getByTestId("chart-tile")).toBeVisible();
    // View mode fits the page with less padding (a different zoom), so
    // compare screen positions in the same mode the drag happened in.
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const persisted = await styleBox(page, "chart-tile");
    expect(Math.abs(persisted.left - after.left)).toBeLessThan(2);

    // Pages: add one, rename it by double-click, switch back
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "New page" }).click();
    await expect(page.getByRole("tab", { name: "Page 2" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("chart-tile")).toHaveCount(0); // a fresh, empty page
    await page.getByRole("tab", { name: "Page 2" }).dblclick();
    const nameInput = page.getByRole("navigation", { name: "Report pages" }).getByLabel("Page name");
    await nameInput.fill("Support");
    await nameInput.press("Enter");
    await expect(page.getByRole("tab", { name: "Support" })).toBeVisible();
    await page.getByRole("tab", { name: "Page 1" }).click();
    await expect(page.getByTestId("chart-tile")).toBeVisible();

    const pages = (await (await request.get(`${API}/dashboards/${id}`)).json()).pages;
    expect(pages.map((p: { name: string }) => p.name)).toEqual(["Page 1", "Support"]);
  } finally {
    await request.delete(`${API}/dashboards/${id}`);
  }
});

test("text box formatting: selection-only size/font/color, box-level overrides, growth, number fields", async ({
  page,
  request,
}) => {
  // Regression coverage for every text-box bug found hands-on in Chrome.
  const id = await seed(request);
  try {
    await page.goto(`/dashboards/${id}`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "Text box" }).click();
    const editor = page.getByRole("textbox", { name: "Text box content" });
    await expect(editor).toBeFocused();
    await page.keyboard.type("Quarterly review");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Revenue is up");

    // 1. A TYPED size applies to the selected word only (it used to resize
    //    the whole box, because focusing the input dropped the selection).
    await editor.getByText("Revenue is up").dblclick({ position: { x: 10, y: 8 } });
    const toolbar = page.getByRole("toolbar", { name: "Text formatting" });
    const size = toolbar.getByLabel("Font size");
    await size.click();
    await size.fill("28");
    await size.press("Enter");
    const sized = editor.locator("span[style*='font-size: 28px']");
    await expect(sized).toHaveText("Revenue");
    await expect(page.getByRole("complementary", { name: "Format pane" }).getByLabel("Base font size")).toHaveValue("16");

    // 2. Bold, then "theme color" reset must NOT strip the bold (it used
    //    to run removeFormat).
    await editor.getByText("Revenue").dblclick();
    await toolbar.getByRole("button", { name: "Bold" }).click();
    await toolbar.getByRole("button", { name: "Text color" }).click();
    await page.getByRole("button", { name: "Theme text color" }).click();
    await expect(editor.locator("[style*='font-weight'], b, strong").first()).toContainText("Revenue");

    // 3. Heading style: the box fits its content (grows if needed) instead of
    //    hiding a line behind an inner scrollbar.
    // Chrome keeps the first line as a bare text node (no block of its
    // own), so click the first line by position, not by text match.
    await editor.click({ position: { x: 6, y: 6 } });
    await toolbar.getByLabel("Paragraph style").selectOption("h1");
    await expect(editor.locator("h1")).toHaveText("Quarterly review");
    // the box grew to its content: nothing clipped behind an inner scrollbar
    await expect
      .poll(() => editor.evaluate((e) => e.scrollHeight - e.clientHeight))
      .toBeLessThanOrEqual(1);

    // 4. Pane number field: typing "20" gives 20 (it used to clamp each
    //    keystroke: "2" -> 8, then "84"), and a box-level size clears the
    //    per-word 28px so the whole box really changes.
    const pane = page.getByRole("complementary", { name: "Format pane" });
    const base = pane.getByLabel("Base font size");
    await base.fill("20");
    await base.press("Enter");
    await expect(base).toHaveValue("20");
    await expect(editor.locator("span[style*='font-size']")).toHaveCount(0);
    await expect(editor.locator("[style*='font-weight'], b, strong").first()).toContainText("Revenue"); // bold kept

    // persisted after leaving the editor
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    const stored = (await (await request.get(`${API}/dashboards/${id}`)).json()).items.find(
      (i: { kind: string }) => i.kind === "text"
    );
    expect(stored.config.font_size).toBe(20);
    expect(stored.text).toContain("<h1>");
    expect(stored.text).not.toContain("28px");
  } finally {
    await request.delete(`${API}/dashboards/${id}`);
  }
});

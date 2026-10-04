import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 8 saved chats: a conversation must survive a page reload (turns AND
 * the agent's own context), and rename / pin / delete must persist.
 */

const API = "http://localhost:8000";

async function ask(page: Page, question: string) {
  const input = page.getByPlaceholder(/Ask about revenue/);
  await input.click();
  await input.fill(question);
  await input.press("Enter");
}

test("a chat is saved, survives reload with its context, and can be renamed, pinned and deleted", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  await page.goto("/");
  await ask(page, "Revenue by region as a pie chart");

  // The URL becomes the saved chat's own address without a remount.
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const chatId = page.url().split("/c/")[1];
  await expect(page.locator(".recharts-pie-sector").first()).toBeVisible({ timeout: 90_000 });

  const row = page.getByTestId("chat-row").filter({ hasText: "Revenue by region as a pie chart" });
  await expect(row).toBeVisible();

  // Reload: the transcript is rehydrated from the server, not React state...
  await page.reload();
  await expect(page.getByRole("heading", { name: "Revenue by region as a pie chart" })).toBeVisible();
  await expect(page.locator(".recharts-pie-sector").first()).toBeVisible();

  // ...and so is the AGENT's context: a chart-type-only follow-up reuses the
  // prior turn's rows, which only works if the thread's checkpoint is there.
  await ask(page, "now as a table");
  await expect(page.getByTestId("turn").nth(1).locator("table")).toBeVisible({ timeout: 30_000 });
  const saved = await (await request.get(`${API}/chats/${chatId}`)).json();
  expect(saved.turns).toHaveLength(2);
  expect(saved.turns[1].sql).toBe(saved.turns[0].sql);

  // Rename
  await row.hover();
  await page.getByRole("button", { name: /Chat options for Revenue by region/ }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const titleInput = page.getByLabel("Chat title");
  await titleInput.fill("Regional mix");
  await titleInput.press("Enter");
  const renamed = page.getByTestId("chat-row").filter({ hasText: "Regional mix" });
  await expect(renamed).toBeVisible();

  // Pin -> shows under "Pinned", and both survive a reload
  await renamed.hover();
  await page.getByRole("button", { name: "Chat options for Regional mix" }).click();
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await page.reload();
  const pinnedSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Pinned" }) });
  await expect(pinnedSection.getByTestId("chat-row").filter({ hasText: "Regional mix" })).toBeVisible();

  // Delete (with confirm) -> gone from the sidebar and the API, back to a new chat
  await pinnedSection.getByTestId("chat-row").filter({ hasText: "Regional mix" }).hover();
  await page.getByRole("button", { name: "Chat options for Regional mix" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("chat-row").filter({ hasText: "Regional mix" })).toHaveCount(0);
  expect((await request.get(`${API}/chats/${chatId}`)).status()).toBe(404);
});

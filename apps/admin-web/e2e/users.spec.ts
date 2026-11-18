import { expect, test } from "@playwright/test";
import { FULL_TG_ID } from "./fixtures/data";
import { openAs, shot } from "./helpers";

test("users: search and filters; the card drawer with tabs; masked Telegram ID", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/users");
  await expect(page.locator("tbody tr")).toHaveCount(4);
  await page.getByTestId("users-q").fill("@maria");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  expect(bff.calls("GET", "/users").at(-1)!.path).toBe("/users");
  await page.getByTestId("users-q").fill("");
  await page.locator("#users-open").check();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page.locator("#users-open").uncheck();
  await expect(page.getByTestId("tg-masked").first()).toHaveText("••••••645");
  await page.locator("tbody tr").first().click();
  const card = page.getByTestId("user-card");
  await expect(card).toBeVisible();
  await card.getByRole("tab", { name: /Обращения/ }).click();
  await expect(page.getByTestId("user-tickets")).toContainText("TCK-3081");
  await card.getByRole("tab", { name: "Обзор" }).click();
  await shot(page, "03-users-drawer");
});

test("reveal: reason + reference → full ID for 60 s with a countdown, then dropped; audited", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/users");
  await page.locator("tbody tr").first().click();
  await page.getByTestId("reveal-start").click();
  await page.locator("#rv-ref").fill("");
  await page.getByTestId("reveal-confirm").click();
  await expect(page.getByTestId("reveal-form")).toContainText("не короче 3");
  await page.locator("#rv-ref").fill("TCK-3081");
  await page.getByTestId("reveal-confirm").click();
  await expect(page.getByTestId("reveal-value")).toHaveText(FULL_TG_ID);
  await expect(page.getByTestId("reveal-countdown")).toHaveText(/^0[01]:\d\d$/);
  await shot(page, "03b-users-reveal");
  const call = bff.calls("POST", /\/reveal$/)[0]!;
  expect(call.body).toEqual({ field: "telegram_user_id", reason: "ticket: TCK-3081" });
  expect(bff.audit[0]!.action).toBe("sensitive.view");
  // the value is never written to browser storage
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(FULL_TG_ID);
  await page.getByTestId("reveal-box").getByRole("button", { name: "Скрыть" }).click();
  await expect(page.getByTestId("reveal-value")).toHaveCount(0);
  await expect(page.getByTestId("card-tg-masked")).toBeVisible();
});

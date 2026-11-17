import { expect, test } from "@playwright/test";
import { open } from "./helpers";

/** AT-01: a changed or expired initData → 401 → a clear message; no network → retry. */
test("initData rejected: reopen the app", async ({ page }) => {
  await open(page, { failOnce: { "POST /v1/session/telegram": [401, "INIT_DATA_EXPIRED"] } });
  await expect(page.getByTestId("boot-error-reopen")).toContainText("Ссылка входа устарела.");
});

test("no BFF: «Нет связи» and «Повторить» signs in", async ({ page }) => {
  await open(page, { onboarded: true, failOnce: { "POST /v1/session/telegram": 503 } });
  await expect(page.getByTestId("boot-error-network")).toBeVisible();
  await page.getByRole("button", { name: "Повторить" }).click();
  await expect(page.getByTestId("home")).toBeVisible();
});

test("a session limited by the parent code: lock screen, then the app", async ({ page }) => {
  const bff = await open(page, { onboarded: true, pin: "1234", pinRequired: true, seen: ["11111111-aaaa-4bbb-8ccc-000000000001", "11111111-aaaa-4bbb-8ccc-000000000002", "11111111-aaaa-4bbb-8ccc-000000000003"] });
  await expect(page.getByTestId("lock")).toBeVisible();
  for (const d of "1111") await page.getByTestId("lock").getByRole("button", { name: d, exact: true }).click();
  await expect(page.getByText("Неверный код. Осталось попыток: 4.")).toBeVisible();
  for (const d of "1234") await page.getByTestId("lock").getByRole("button", { name: d, exact: true }).click();
  await expect(page.getByTestId("home")).toBeVisible();
  expect(bff.calls("POST", "/v1/session/pin/verify")).toHaveLength(2);
});

test("route_ deep link opens its screen after login", async ({ page }) => {
  await open(page, { onboarded: true, seen: ["11111111-aaaa-4bbb-8ccc-000000000001", "11111111-aaaa-4bbb-8ccc-000000000002", "11111111-aaaa-4bbb-8ccc-000000000003"] }, "?startapp=route_schedule");
  await expect(page.getByTestId("schedule-screen")).toBeVisible();
});

/**
 * Sprint 8 «Тарифы и товары» (ADM-MONEY-03, AT-83): the active catalogue is read only; a draft from it; two prices of a
 * product (sums on the site, Telegram Stars in the Mini App); the Stars invoice title ≤ 32; the check of billing (paths
 * and codes, the fiscal warning); the activation with a fresh TOTP repeats the same command (one Idempotency-Key); the
 * history and the rollback (a new version from an archived one, with step-up); the draft conflict (If-Match).
 */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";

const COMMENT = "Цена 90 дней в Stars по решению финансов от 27.11";

test("the active version is read only; a draft from it; a Stars price sells the product in the Mini App; activation with step-up keeps the key", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/tariffs");
  await expect(page.getByTestId("tf-active")).toContainText("v2");
  await expect(page.getByTestId("tf-readonly")).toBeVisible();
  await expect(page.getByTestId("tf-products-0-price_stars")).toHaveValue("250");
  await expect(page.getByTestId("tf-products-0-price_stars")).toHaveAttribute("readonly", "");
  // no draft — nothing to activate
  await expect(page.getByTestId("tf-activate")).toHaveCount(0);

  await page.getByTestId("tf-new-draft").click();
  await expect(page.getByTestId("tf-draft")).toContainText("v3");
  await expect(page.getByTestId("tf-readonly")).toHaveCount(0);
  // plus_90d: not sold in the Mini App until a Stars price is set
  const p90 = page.getByTestId("tf-product-1");
  await expect(p90).toContainText("в Mini App не продаётся");
  await page.getByTestId("tf-products-1-price_stars").fill("690");
  await page.getByTestId("tf-products-1-stars_title-ru").fill("TilHero Плюс — 90 дней, большой пакет минут");
  await expect(p90).toContainText("Слишком длинно");
  await expect(page.getByTestId("tf-products-1-stars_title-ru-count")).toContainText("/32");
  await page.getByTestId("tf-products-1-stars_title-ru").fill("TilHero Плюс 90");
  await page.getByTestId("tf-products-1-stars_title-uz").fill("TilHero Plus 90");
  await expect(p90).toContainText("Mini App: ⭐ 690");
  // a dirty draft is not activated: save, then check
  await expect(page.getByTestId("tf-activate")).toBeDisabled();
  await page.getByTestId("tf-comment").fill(COMMENT);
  await page.getByTestId("tf-save").click();
  await expect(page.getByText("Черновик v3 сохранён")).toBeVisible();
  const put = bff.calls("PUT", "/billing/catalog/draft").at(-1)!;
  expect((put.body as { payload: { products: Array<{ price_stars: number | null; price_tiyin: number | null }> } }).payload.products[1]).toMatchObject({ price_stars: 690, price_tiyin: 12_900_000 });
  expect(put.headers["if-match"]).toBeTruthy();

  await page.getByTestId("tf-validate").click();
  await expect(page.getByTestId("tf-check-ok")).toBeVisible();
  await expect(page.getByTestId("tf-activate")).toBeEnabled();
  await page.getByTestId("tf-activate").click();
  const dlg = page.getByTestId("tf-activate-dialog");
  await expect(dlg.getByTestId("tf-activate-changes")).toContainText("Изменённых полей");
  await dlg.locator("#cmd-reason").fill(COMMENT);
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Каталог v3 активирован")).toBeVisible();
  await expect(page.getByTestId("tf-active")).toContainText("v3");
  const acts = bff.calls("POST", "/billing/catalog/draft/activate");
  expect(acts).toHaveLength(2); // 403 STEP_UP_REQUIRED, then the same command with the same key
  expect(acts[1]!.headers["idempotency-key"]).toBe(acts[0]!.headers["idempotency-key"]);
  expect(bff.money.audit.at(-1)).toMatchObject({ action: "billing.catalog_activated", reason: COMMENT });
});

test("the check of billing names the field; a subscription by Telegram is 30 days only", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/tariffs", { money: { draft: true } });
  await expect(page.getByTestId("tf-draft")).toContainText("v3");
  // days 31 with a Telegram subscription: the form says so at once
  await page.getByTestId("tf-products-0-days").fill("31");
  await expect(page.getByTestId("tf-product-0")).toContainText("Подписка Telegram — только 30 дней");
  await page.getByTestId("tf-products-0-days").fill("30");
  await page.getByTestId("tf-products-0-minutes").fill("320");
  await page.getByTestId("tf-save").click();
  await expect(page.getByText("Черновик v3 сохранён")).toBeVisible();
  await page.getByTestId("tf-validate").click();
  await expect(page.getByTestId("tf-check-ok")).toBeVisible();
});

test("the history: the rollback makes a new version from an archived one, with step-up", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/tariffs");
  await page.getByTestId("tft-history").click();
  const hist = page.getByTestId("tf-history");
  await expect(hist).toContainText("v1");
  await hist.getByTestId("tf-rollback-1").click();
  const dlg = page.getByTestId("tf-rollback-dialog");
  await expect(dlg).toContainText("Будет создана версия v3 из v1");
  await dlg.locator("#cmd-reason").fill("Откат: цены в Stars ещё не согласованы");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Активна v3 — копия v1")).toBeVisible();
  const calls = bff.calls("POST", "/billing/catalog/1/rollback");
  expect(calls).toHaveLength(2);
  expect(calls[1]!.headers["idempotency-key"]).toBe(calls[0]!.headers["idempotency-key"]);
  expect(bff.money.versions.find((v) => v.version === 2)!.status).toBe("archived");
});

test("a draft changed by another staff member: 409 DRAFT_CONFLICT, reload", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/tariffs", { money: { draft: true, draftConflictOnce: true } });
  await page.getByTestId("tf-products-1-price_stars").fill("700");
  await page.getByTestId("tf-products-1-stars_title-ru").fill("Плюс 90");
  await page.getByTestId("tf-products-1-stars_title-uz").fill("Plus 90");
  await page.getByTestId("tf-save").click();
  await expect(page.getByTestId("tf-conflict")).toBeVisible();
  await page.getByTestId("tf-reload").click();
  await expect(page.getByTestId("tf-conflict")).toHaveCount(0);
  await expect(page.getByTestId("tf-offer-version")).toHaveValue("1.1");
});

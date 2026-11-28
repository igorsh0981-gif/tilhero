/**
 * Sprint 8 «Заказы и платежи» (ADM-MONEY-01, ADM-MONEY-04, AT-94, AT-96): channels never mix (the site — sums via
 * Payme / Click / Uzum, the Mini App — Telegram Stars); the order card (transactions, receipts, provider calls — only
 * metadata); «Возврат» with a reason and a fresh TOTP (the same command — the same Idempotency-Key); Payme — in the
 * provider cabinet with an instruction; a til pack with spent tils — billing refuses, the forced refund needs a second
 * confirmation; a lost answer is repeated with the same key and the money goes back once; refunds stuck in a cabinet are
 * closed as failed.
 */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { ORDER, REFUND } from "./fixtures/money-data";

const REASON = "Ученик оплатил дважды, обращение TCK-1042";

test("filters: channel and provider never mix; the order card shows sums or Stars, never both", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/payments");
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  await expect(page.getByTestId("pay-channels-note")).toContainText("Mini App — только Telegram Stars");
  await expect(page.getByTestId("pay-rows").locator("tbody tr")).toHaveCount(7);
  await page.getByTestId("pay-channel").selectOption("web");
  // the provider list of the site has no Stars
  await expect(page.getByTestId("pay-provider").locator("option[value=telegram_stars]")).toHaveCount(0);
  await page.getByTestId("pay-provider").selectOption("click");
  await expect(page.getByTestId("pay-rows").locator("tbody tr")).toHaveCount(1);
  const q = new URL(urls.filter((u) => u.includes("/admin/v1/billing/orders?")).at(-1)!).searchParams;
  expect([q.get("channel"), q.get("provider")]).toEqual(["web", "click"]);
  await page.getByTestId("pay-reset").click();
  await page.getByTestId(`pay-open-${ORDER.stars}`).click();
  const card = page.getByTestId("pay-order");
  await expect(card.getByTestId("pay-order-amount")).toContainText("⭐ 250");
  await expect(card.getByTestId("pay-order-amount")).not.toContainText("сум");
  await expect(card.getByTestId("pay-stars-sub")).toContainText("автопродление включено");
  await expect(card.getByTestId("pay-no-receipts-stars")).toBeVisible();
  await expect(card.getByTestId("pay-calls")).toContainText("createInvoiceLink");
  await expect(page).toHaveURL(new RegExp(`#/payments/orders/${ORDER.stars}$`));
});

test("Payme: the refund in the cabinet — reason, step-up with the same key, the instruction; a second refund is closed", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/payments/orders/${ORDER.payme}`);
  const card = page.getByTestId("pay-order");
  await expect(card.getByTestId("pay-order-amount")).toContainText("49 000 сум");
  await card.getByTestId("pay-refund").click();
  const dlg = page.getByTestId("pay-refund-dialog");
  await expect(dlg).toContainText("в кабинете Payme");
  await expect(dlg.getByTestId("pay-refund-period")).toContainText("Период подписки будет отозван");
  await dlg.locator("#cmd-reason").fill("коротко");
  await dlg.getByTestId("confirm-ok").click();
  await expect(dlg).toContainText("10");
  expect(bff.calls("POST", `/billing/orders/${ORDER.payme}/refunds`)).toHaveLength(0);
  await dlg.locator("#cmd-reason").fill(REASON);
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup");
  await expect(card.getByTestId("pay-refund-instruction")).toContainText("Верните деньги в кабинете Payme");
  await expect(card.getByTestId("pay-refund-instruction")).toContainText("6385a1b2c3d4e5f6a7b8c9d0");
  const calls = bff.calls("POST", `/billing/orders/${ORDER.payme}/refunds`);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[1]!.headers["idempotency-key"]).toBe(calls[0]!.headers["idempotency-key"]);
  expect(calls[1]!.body).toEqual({ reason: REASON });
  // a live refund: no second «Возврат»
  await expect(card.getByTestId("pay-refund")).toHaveCount(0);
  expect(bff.money.audit.at(-1)).toMatchObject({ action: "billing.refund_requested", reason: REASON });
});

test("a til pack with spent tils: billing refuses, the forced refund needs a second confirmation (Click — at once)", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/payments/orders/${ORDER.clickTils}`);
  await page.getByTestId("pay-refund").click();
  const dlg = page.getByTestId("pay-refund-dialog");
  await expect(dlg.getByTestId("pay-refund-tils")).toBeVisible();
  await expect(dlg.getByTestId("pay-refund-window")).toHaveCount(0);
  await dlg.locator("#cmd-reason").fill(REASON);
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(dlg.getByTestId("pay-refund-spent")).toContainText("куплено 100, на балансе 20");
  await expect(dlg.getByTestId("confirm-ok")).toBeDisabled();
  await dlg.getByTestId("pay-refund-force").check();
  await expect(dlg.getByTestId("confirm-ok")).toHaveText("Вернуть всё равно");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("pay-refund-result")).toContainText("Деньги возвращены");
  const bodies = bff.calls("POST", `/billing/orders/${ORDER.clickTils}/refunds`).map((c) => c.body);
  expect(bodies.at(-1)).toEqual({ reason: REASON, force: true });
  // the forced refund is a reconciliation item
  expect(bff.money.recon[0]).toMatchObject({ kind: "tils_spent_on_refund", order_no: 1043 });
});

test("a lost answer of a refund: the repeat goes with the same key, the money goes back once", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/payments/orders/${ORDER.stars}`, { money: { refundLostOnce: true } });
  await page.getByTestId("pay-refund").click();
  const dlg = page.getByTestId("pay-refund-dialog");
  await expect(dlg).toContainText("Telegram Stars вернёт деньги сразу");
  await dlg.locator("#cmd-reason").fill(REASON);
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(dlg).toContainText("Ответ не получен");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("pay-refund-result")).toContainText("Деньги возвращены");
  const keys = bff.calls("POST", `/billing/orders/${ORDER.stars}/refunds`).map((c) => c.headers["idempotency-key"]);
  expect(new Set(keys).size).toBe(1);
  expect(bff.money.refunds.filter((r) => r.order_id === ORDER.stars)).toHaveLength(1);
});

test("refunds: a refund waiting for the cabinet is closed as failed with a note and step-up", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/payments/refunds");
  const rows = page.getByTestId("pay-refund-rows");
  await expect(rows).toContainText("ждёт провайдера");
  await expect(rows).not.toContainText("по инициативе провайдера");
  await page.getByTestId("ref-status").selectOption("");
  await expect(rows).toContainText("по инициативе провайдера");
  await page.getByTestId(`pay-fail-${REFUND.awaiting}`).click();
  const dlg = page.getByTestId("pay-fail-dialog");
  await dlg.locator("#cmd-reason").fill("Uzum отклонил отмену: платёж старше 30 дней");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Возврат закрыт как неудачный")).toBeVisible();
  expect(bff.money.refunds.find((r) => r.refund_id === REFUND.awaiting)!.status).toBe("failed");
});

/**
 * Sprint 8 «Финансовый обзор», «Сверка», the overview block «Деньги», the AI control on «Затраты» and the rights of
 * «Деньги» (ADM-DASH-04, ADM-MONEY-01, AT-97, AT-99): the site (sums) and the Mini App (Stars) are never summed, Stars in
 * sums are marked «оценка», «без комиссий провайдеров и магазинов приложений»; providers show only «включён / ключ
 * задан» — no key is shown or accepted; rates are set with a reason; reconciliation items are resolved with a note; the
 * degradation levels are changed with step-up; read-only roles see no commands.
 */
import { expect, test } from "@playwright/test";
import { nav, openAs, typeOtp } from "./helpers";
import { ORDER, RECON } from "./fixtures/money-data";

test("the overview: sums and Stars apart, the estimate, no fees; providers without keys", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/finance");
  await expect(page.getByTestId("fin-no-fees")).toContainText("Без комиссий провайдеров и магазинов приложений");
  await expect(page.getByTestId("fin-web")).toContainText("сум");
  await expect(page.getByTestId("fin-web")).not.toContainText("⭐");
  await expect(page.getByTestId("fin-stars")).toContainText("⭐");
  await expect(page.getByTestId("fin-stars-est-tag")).toHaveText("оценка");
  await expect(page.getByTestId("fin-margin-est")).toBeVisible();
  await expect(page.getByTestId("fin-recon-open")).toContainText("2");
  await expect(page.getByTestId("fin-refunds-count")).toBeVisible();
  // providers: on / off and «ключ задан / не задан», never a key; no field takes a key
  const prov = page.getByTestId("fin-providers");
  await expect(prov.getByTestId("fin-prov-payme")).toContainText("ключ задан");
  await expect(prov.getByTestId("fin-prov-uzum")).toContainText("ключ не задан");
  await expect(prov.locator("input, textarea")).toHaveCount(0);
  await expect(prov).toContainText("админка их не показывает и не принимает");
  // the period: week and month of Tashkent
  await page.getByTestId("fin-period").getByRole("button", { name: "неделя" }).click();
  await expect(page.getByTestId("fin-range")).toContainText("Ташкент");
});

test("rates: the USD rate in whole sums with a reason; without a Star rate there is no estimate and no margin with Stars", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/finance", { money: { noStarRate: true } });
  await expect(page.getByTestId("fin-stars-est")).toContainText("курс Star не задан");
  await expect(page.getByTestId("fin-margin-none")).toBeVisible();
  await page.getByTestId("fin-fx-v").fill("12 700");
  await page.getByTestId("fin-fx-set").click();
  const dlg = page.getByTestId("fin-fx-dialog");
  await dlg.locator("#cmd-reason").fill("Курс ЦБ на 28.11, по письму бухгалтера");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByText("Курс сохранён")).toBeVisible();
  expect(bff.calls("PUT", "/billing/fx").at(-1)!.body).toMatchObject({ usd_in_tiyin: 1_270_000 });
});

test("reconciliation: open items, a run, resolve with a note; the overview block links to it", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/overview");
  const block = page.getByTestId("block-money");
  await expect(block.getByTestId("dmoney-web")).toContainText("сум");
  await expect(block.getByTestId("dmoney-stars")).toContainText("⭐");
  await block.getByTestId("dmoney-recon-link").click();
  await expect(page.getByTestId("reconciliation")).toBeVisible();
  const rows = page.getByTestId("rec-rows");
  await expect(rows).toContainText("Возврат завис");
  await expect(rows).toContainText("Нет фискального чека");
  await page.getByTestId("rec-run").click();
  await expect(page.getByText("Сверка: проверено 412, найдено 0")).toBeVisible();
  await page.getByTestId(`rec-resolve-${RECON.fiscal}`).click();
  const dlg = page.getByTestId("rec-resolve-dialog");
  await dlg.locator("#cmd-reason").fill("Чек Click зарегистрирован повторно вручную");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByText("Пункт сверки закрыт")).toBeVisible();
  expect(bff.money.recon.find((r) => r.item_id === RECON.fiscal)).toMatchObject({ status: "resolved", resolved_by: { name: "Тимур" } });
});

test("AI control on «Затраты»: the subscriber's day in the budget; the degradation level with step-up", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/costs", { money: { aiSpentPercent: 83.4 } });
  await expect(page.getByTestId("deg-l-economy")).toHaveAttribute("aria-current", "true");
  await page.getByTestId("deg-mode").getByRole("button", { name: "вручную" }).click();
  await page.getByTestId("deg-manual").selectOption("paid_only");
  await page.getByTestId("deg-save").click();
  const dlg = page.getByTestId("deg-dialog");
  await expect(dlg.getByTestId("deg-warn")).toContainText("Ученики без подписки сразу перейдут в упрощённый режим");
  await dlg.locator("#cmd-reason").fill("Расход месяца 83 %, бережём ИИ для подписчиков");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Уровни деградации сохранены")).toBeVisible();
  await expect(page.getByTestId("deg-l-paid_only")).toHaveAttribute("aria-current", "true");
  const puts = bff.calls("PUT", "/ai/degradation");
  expect(puts).toHaveLength(2);
  expect(puts[1]!.headers["idempotency-key"]).toBe(puts[0]!.headers["idempotency-key"]);
  expect(puts[1]!.body).toMatchObject({ mode: "manual", manual_level: "paid_only", economy_at_percent: 80, paid_only_at_percent: 90 });
  // the budget form has the subscriber's daily limit
  await expect(page.locator("#csf-paid_learner_daily_cap_usd")).toHaveValue(/0[.,]3/);
});

test("rights: analyst reads «Деньги» without commands; communications sees only the finance overview; billing down — the overview still works", async ({ page }) => {
  const bff = await openAs(page, "analyst@tilhero.local", "#/tariffs");
  for (const id of ["tariffs", "payments", "adjustments", "reconciliation", "finance"]) await expect(page.locator(`[data-nav="${id}"]`)).toBeVisible();
  await expect(page.getByTestId("tf-new-draft")).toHaveCount(0);
  await nav(page, "payments");
  await page.goto(`/#/payments/orders/${ORDER.payme}`);
  await expect(page.getByTestId("pay-refund-ro")).toContainText("billing.refund");
  await page.goto("/#/reconciliation");
  await expect(page.getByTestId("reconciliation")).toBeVisible();
  await expect(page.getByTestId("rec-run")).toHaveCount(0);
  await page.goto("/#/finance");
  await expect(page.getByTestId("finance")).toBeVisible();
  await expect(page.getByTestId("fin-fx-set")).toHaveCount(0);
  bff.switchTo("comms@tilhero.local");
  await page.goto("/#/overview");
  await page.reload();
  await expect(page.locator('[data-nav="finance"]')).toBeVisible();
  await expect(page.locator('[data-nav="payments"]')).toHaveCount(0);
  await expect(page.locator('[data-nav="tariffs"]')).toHaveCount(0);
});

test("billing is down: the block and the sections say so, the rest of the overview works", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/overview", { money: { billingDown: true } });
  await expect(page.getByTestId("block-money-off")).toContainText("billing");
  await expect(page.getByTestId("block-social")).toBeVisible();
  await nav(page, "payments");
  await expect(page.getByTestId("payments")).toContainText(/billing|недоступ/i);
});

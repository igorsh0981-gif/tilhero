/**
 * Sprint 4 «Затраты и лимиты» and the overview blocks on the mock admin-bff (AT-51, ADM-MONEY-01/02): the month's
 * spend past the alert threshold (bar, percent, text — not colour only), spend per day with a table view, limits with
 * step-up, the emergency stop → the «AI is off» banner on the three sections and on the overview → back on; the
 * independent overview blocks `lessons` and `ai` and «Требует внимания».
 */
import { expect, test } from "@playwright/test";
import { nav, openAs, typeOtp } from "./helpers";
import { TOTP } from "./fixtures/data";

test.describe.configure({ timeout: 90_000 });

test("AT-51: spend past the alert threshold — bar, percent and text; per day with a table; per agent and model", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/costs", { ai: { spentUsd: 17.2 } });
  const bar = page.getByTestId("cs-bar");
  await expect(bar).toHaveAttribute("data-level", "warn");
  await expect(page.getByTestId("cs-bar-pct")).toHaveText(/86/);
  await expect(bar).toContainText("Достигнут порог предупреждения 80 %");
  await expect(bar.getByRole("meter")).toHaveAttribute("aria-valuenow", "86");
  await expect(page.getByTestId("cs-avg-lesson")).toHaveText(/^\$0[.,]012$/);
  // per day: focusable bars with a tooltip, a table view
  await expect(page.locator('[data-testid^="cs-chart-bar-"]')).toHaveCount(19);
  await page.locator('[data-testid^="cs-chart-bar-"]').last().focus();
  await expect(page.locator(".chart-tip")).toContainText("Расход");
  await page.getByTestId("cs-chart-table-btn").click();
  await expect(page.getByTestId("cs-chart-table").locator("tbody tr")).toHaveCount(19);
  await expect(page.getByTestId("cs-agents")).toContainText("independent_evaluator");
  await expect(page.getByTestId("cs-models")).toContainText("claude-sonnet-5-5");
  await page.getByTestId("cs-period").getByRole("button", { name: "неделя" }).click();
  await expect(page.locator('[data-testid^="cs-chart-bar-"]')).toHaveCount(7);
  // the overview sees the same threshold
  await nav(page, "overview");
  await expect(page.getByTestId("att-budget")).toBeVisible();
  await expect(page.getByTestId("dai-pct")).toContainText("порог предупреждения");
});

test("limits: client checks, then a reason and step-up; the AI emergency stop puts the banner on all three sections", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/costs");
  await expect(page.getByTestId("cs-bar")).toHaveAttribute("data-level", "ok");
  await page.getByTestId("csf-lesson_cap_usd").fill("0.08");
  await page.getByTestId("csf-save").click();
  await expect(page.getByTestId("cs-settings")).toContainText("Не больше лимита ученика в день");
  await page.getByTestId("csf-lesson_cap_usd").fill("0.03");
  await page.getByTestId("csf-alert_percent").fill("90");
  await page.getByTestId("csf-save").click();
  const sd = page.getByTestId("csf-dialog");
  await sd.locator("#cmd-reason").fill("Порог 90 % до конца пилота");
  await sd.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("toasts")).toContainText("Лимиты сохранены");
  expect(bff.calls("PUT", "/ai/budget").at(-1)!.body).toMatchObject({ monthly_cap_usd: 20, learner_daily_cap_usd: 0.05, lesson_cap_usd: 0.03, alert_percent: 90, reason: "Порог 90 % до конца пилота" });

  // emergency stop
  await expect(page.getByTestId("cs-stop")).toHaveAttribute("data-ai", "on");
  await expect(page.getByTestId("ai-off-banner")).toHaveCount(0);
  await page.getByTestId("cs-stop-btn").click();
  const st = page.getByTestId("cs-stop-dialog");
  await expect(st).toContainText("Аварийно выключить ИИ?");
  await st.locator("#cmd-reason").fill("Подозрение на утечку ключа");
  await st.getByTestId("confirm-ok").click();
  await expect(st).toHaveCount(0);
  await expect(page.getByTestId("cs-stop")).toHaveAttribute("data-ai", "off");
  await expect(page.getByTestId("cs-stop-state")).toHaveText("ИИ выключен");
  await expect(page.getByTestId("cs-stop-btn")).toHaveAttribute("aria-checked", "true");
  expect(bff.calls("POST", "/ai/emergency-stop").at(-1)!.body).toMatchObject({ enabled: true, reason: "Подозрение на утечку ключа" });
  expect(bff.ai.audit.at(-1)).toMatchObject({ action: "ai.emergency_stop", reason: "Подозрение на утечку ключа" });
  await expect(page.getByTestId("ai-off-banner")).toContainText("уроки идут в упрощённом режиме");
  for (const s of ["agents", "qa"]) {
    await nav(page, s);
    await expect(page.getByTestId("ai-off-banner")).toBeVisible();
  }
  await nav(page, "overview");
  await expect(page.getByTestId("att-ai-off")).toBeVisible();
  await expect(page.getByTestId("dai-off")).toBeVisible();
  // back on
  await nav(page, "costs");
  await page.getByTestId("cs-stop-btn").click();
  await page.getByTestId("cs-stop-dialog").locator("#cmd-reason").fill("Ключ перевыпущен владельцем");
  await page.getByTestId("cs-stop-dialog").getByTestId("confirm-ok").click();
  await expect(page.getByTestId("cs-stop")).toHaveAttribute("data-ai", "on");
  await expect(page.getByTestId("ai-off-banner")).toHaveCount(0);
});

test("R2-07: limits saved by another staff member in between → 409 BUDGET_CONFLICT: re-read, the entered values stay, «проверьте и сохраните ещё раз»", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/costs");
  await expect(page.getByTestId("csf-monthly_cap_usd")).toHaveValue("20");
  const read = bff.ai.budget.updated_at;
  await page.getByTestId("csf-lesson_cap_usd").fill("0.04");
  await page.getByTestId("csf-alert_percent").fill("90");
  // meanwhile another staff member saves the limits (the monthly cap and the threshold)
  Object.assign(bff.ai.budget, { monthly_cap_usd: 25, alert_percent: 70, updated_at: new Date().toISOString() });
  await page.getByTestId("csf-save").click();
  const sd = page.getByTestId("csf-dialog");
  await sd.locator("#cmd-reason").fill("Порог 90 % до конца пилота");
  await sd.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", TOTP);
  // the save carried the updated_at that was read; the answer is 409 → the budget is read again, the dialog closes
  await expect(page.getByTestId("csf-conflict")).toHaveText("Лимиты изменил другой сотрудник — проверьте и сохраните ещё раз");
  await expect(sd).toHaveCount(0);
  expect(bff.calls("PUT", "/ai/budget").at(-1)!.body).toMatchObject({ updated_at: read, lesson_cap_usd: 0.04, alert_percent: 90 });
  expect(bff.calls("GET", "/ai/budget").length).toBeGreaterThanOrEqual(2);
  expect(bff.ai.budget).toMatchObject({ monthly_cap_usd: 25, alert_percent: 70, lesson_cap_usd: 0.03 });
  // the edited fields keep the entered values (with what is saved now), the untouched one shows the new value
  await expect(page.getByTestId("csf-lesson_cap_usd")).toHaveValue("0.04");
  await expect(page.getByTestId("csf-alert_percent")).toHaveValue("90");
  await expect(page.getByTestId("csf-alert_percent-saved")).toHaveText("Сейчас сохранено: 70 %");
  await expect(page.getByTestId("csf-lesson_cap_usd-saved")).toContainText("Сейчас сохранено: $0");
  await expect(page.getByTestId("csf-monthly_cap_usd")).toHaveValue("25");
  await expect(page.getByTestId("csf-monthly_cap_usd-saved")).toHaveCount(0);
  // save again — against the updated_at read now
  const now = bff.ai.budget.updated_at;
  await page.getByTestId("csf-save").click();
  await sd.locator("#cmd-reason").fill("Порог 90 % до конца пилота");
  await sd.getByTestId("confirm-ok").click();
  // the step-up of a minute ago is still valid (5 min) — no second code
  await expect(page.getByTestId("toasts")).toContainText("Лимиты сохранены");
  await expect(page.getByTestId("stepup")).toHaveCount(0);
  await expect(page.getByTestId("csf-conflict")).toHaveCount(0);
  expect(bff.calls("PUT", "/ai/budget").at(-1)!.body).toMatchObject({ updated_at: now, monthly_cap_usd: 25, lesson_cap_usd: 0.04, alert_percent: 90 });
  expect(bff.ai.budget).toMatchObject({ monthly_cap_usd: 25, lesson_cap_usd: 0.04, alert_percent: 90 });
});

test("overview: the alert threshold comes with the AI summary — no separate budget request", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/overview", { ai: { spentUsd: 17.2 } });
  await expect(page.getByTestId("att-budget")).toContainText("86");
  await expect(page.getByTestId("attention")).toContainText("порога предупреждения 80 %");
  expect(bff.calls("GET", "/ai/budget")).toHaveLength(0);
});

test("overview: the lessons and ai blocks are independent; attention links go to appeals and manual reviews", async ({ page }) => {
  await openAs(page, "methodist@tilhero.local", "#/overview", { dashOff: ["ai"] });
  const ls = page.getByTestId("block-lessons");
  await expect(ls).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("dls-completion")).toContainText("79,7");
  await expect(page.getByTestId("dls-degraded")).toContainText("6,3");
  await expect(page.getByTestId("block-ai-off")).toContainText("ai-gateway");
  await expect(page.getByTestId("block-content")).toHaveAttribute("data-available", "true");
  await page.getByTestId("att-appeals").click();
  await expect(page.getByTestId("qa-appeals")).toBeVisible();
  await nav(page, "overview");
  await page.getByTestId("dls-human-link").click();
  await expect(page.getByTestId("qf-flag")).toHaveValue("human_review");
  await expect(page.locator('[data-testid^="qa-row-"]')).toHaveCount(1);
});

test("sprint 7: the limit of one pair room — 0…the month, saved with the other limits (step-up)", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/costs");
  await expect(page.getByTestId("csf-room_cap_usd")).toHaveValue("0.1");
  await expect(page.getByTestId("cs-settings")).toContainText("исчерпан — комната идёт по сценарию с выбором реплик");
  await page.getByTestId("csf-room_cap_usd").fill("25");
  await page.getByTestId("csf-save").click();
  await expect(page.getByTestId("cs-settings")).toContainText("Не больше месячного потолка");
  await page.getByTestId("csf-room_cap_usd").fill("0.2");
  await page.getByTestId("csf-save").click();
  const sd = page.getByTestId("csf-dialog");
  await expect(sd).toContainText("парная комната $0,2");
  await sd.locator("#cmd-reason").fill("Коучу парного урока не хватает 10 центов");
  await sd.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("toasts")).toContainText("Лимиты сохранены");
  expect(bff.calls("PUT", "/ai/budget").at(-1)!.body).toMatchObject({ room_cap_usd: 0.2, monthly_cap_usd: 20 });
  expect(bff.ai.budget.room_cap_usd).toBe(0.2);
});

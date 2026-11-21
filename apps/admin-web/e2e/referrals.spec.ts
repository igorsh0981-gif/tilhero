/**
 * Sprint 7 «Реферальные кампании» (ADM-REF-01/02, AT-78, AT-80): the review queue (held referrals, the oldest first)
 * with facts and internal risk flags; approve with a note; reject with a public code and a note — the learner sees only
 * the code's text; a rejection is re-decided once and the history keeps both decisions; the inviter's monthly cap turns
 * an approval into «сверх лимита». Campaigns: a draft from the active version, the client mirror of the validator,
 * the server check, activation with step-up and a comment (the previous version is archived), the history with the
 * difference; statistics by version.
 */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { REFERRAL } from "./fixtures/social-data";

test("the queue: held referrals with facts and flags; approve with a note → qualified, audited", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/referrals");
  const rows = page.getByTestId("rq-rows").locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-testid", `rq-${REFERRAL.shortLessons}`);
  await expect(rows.nth(0)).toContainText("Короткие уроки");
  await expect(rows.nth(1)).toContainText("Много за сутки");
  await page.getByTestId(`rq-open-${REFERRAL.shortLessons}`).click();
  const d = page.getByTestId("rr");
  await expect(d.getByTestId("rr-counts")).toHaveText("уроков 3 · разных дней 2 · всего 7 мин");
  await expect(d.getByTestId("rr-flags")).toContainText("больше половины уроков короче минимума кампании");
  await expect(d.getByTestId("rr-lessons").locator("tbody tr")).toHaveCount(3);
  await expect(d.getByTestId("rr-month")).toHaveText("засчитано 4 из 10");
  await d.getByTestId("rr-approve").click();
  const dlg = page.getByTestId("rr-approve-dialog");
  await dlg.locator("#cmd-reason").fill("коротко");
  await dlg.getByTestId("confirm-ok").click();
  await expect(dlg).toContainText("не короче 10");
  await dlg.locator("#cmd-reason").fill("Уроки короткие, но три разных дня и диагностика пройдена");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByText("Реферал одобрен")).toBeVisible();
  await expect(d.getByTestId("rr-body")).toHaveAttribute("data-status", "qualified");
  await expect(d.getByTestId("rr-history")).toContainText("одобрено");
  await expect(d.getByTestId("rr-approve")).toHaveCount(0);
  expect(bff.social.audit.at(-1)).toMatchObject({ action: "referral.approved", reason: "Уроки короткие, но три разных дня и диагностика пройдена" });
  await page.getByTestId("drawer-close").click();
  await expect(rows).toHaveCount(1);
});

test("reject with a public code and a note; the rejection is re-decided once — the history keeps both", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/referrals/review/${REFERRAL.velocity}`);
  const d = page.getByTestId("rr");
  await expect(d.getByTestId("rr-month")).toContainText("Лимит месяца исчерпан");
  await d.getByTestId("rr-reject").click();
  const dlg = page.getByTestId("rr-reject-dialog");
  await dlg.getByTestId("rr-reject-ok").click();
  await expect(dlg).toContainText("Выберите причину");
  // only the codes an operator may choose; the learner sees the public text
  await expect(dlg.getByTestId("rr-code").locator("option")).toHaveCount(4);
  await dlg.getByTestId("rr-code").selectOption("review_rejected");
  await expect(dlg).toContainText("Ученик увидит: «Приглашение не прошло проверку»");
  await dlg.getByTestId("rr-note").fill("Пять квалификаций за вечер и занятия до приглашения");
  await dlg.getByTestId("rr-reject-ok").click();
  await expect(page.getByText("Реферал отклонён")).toBeVisible();
  await expect(d.getByTestId("rr-body")).toHaveAttribute("data-status", "rejected");
  expect(bff.calls("POST", `/referrals/${REFERRAL.velocity}/reject`).at(-1)!.body).toEqual({ reject_code: "review_rejected", note: "Пять квалификаций за вечер и занятия до приглашения" });
  // re-decision: once, with a warning; the month is full → over the cap, without a reward
  await expect(d.getByTestId("rr-redecide-note")).toBeVisible();
  await d.getByTestId("rr-approve").click();
  const ap = page.getByTestId("rr-approve-dialog");
  await expect(ap).toContainText("Пересмотр отклонения возможен один раз");
  await expect(ap).toContainText("засчитан без награды");
  await ap.locator("#cmd-reason").fill("Подтвердили по обращению: разные люди, не семья");
  await ap.getByTestId("confirm-ok").click();
  await expect(page.getByText("Реферал одобрен — сверх лимита месяца, без награды")).toBeVisible();
  await expect(d.getByTestId("rr-body")).toHaveAttribute("data-status", "capped");
  await expect(d.getByTestId("rr-history").locator("li")).toHaveCount(2);
  await expect(d.getByTestId("rr-approve")).toHaveCount(0);
  await expect(d.getByTestId("rr-reject")).toHaveCount(0);
});

test("a rejection re-decided once already cannot be re-decided again (REFERRAL_STATE)", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/referrals");
  await page.getByTestId("rq-status").selectOption("rejected");
  await page.getByTestId(`rq-open-${REFERRAL.rejected}`).click();
  const d = page.getByTestId("rr");
  await expect(d.getByTestId("rr-history")).toContainText("Похоже на члена семьи");
  // a colleague re-decided it in between
  bff.social.referrals.find((r) => r.referral_id === REFERRAL.rejected)!.can_redecide = false;
  await d.getByTestId("rr-approve").click();
  const ap = page.getByTestId("rr-approve-dialog");
  await ap.locator("#cmd-reason").fill("Проверено по обращению поддержки");
  await ap.getByTestId("confirm-ok").click();
  await expect(ap).toContainText("решение уже пересматривалось");
});

test("campaign: a draft, client checks, save, server check, activation with step-up and a comment; history and diff", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/referrals/campaigns");
  await expect(page.getByTestId("rc-active")).toHaveText("активна v2");
  await expect(page.getByTestId("rcf-min_lessons")).toBeDisabled();
  await page.getByTestId("rc-new-draft").click();
  await expect(page.getByTestId("rc-draft")).toHaveText("черновик v3");
  // the client mirror of the validator
  await page.getByTestId("rcf-min_days").fill("4");
  await expect(page.getByTestId("rc-errors")).toContainText("Дней не может быть больше, чем уроков");
  await page.getByTestId("rcf-monthly_cap").fill("0");
  await expect(page.getByTestId("rc-errors")).toContainText("Вне допустимого диапазона");
  await expect(page.getByTestId("rc-activate")).toBeDisabled();
  await page.getByTestId("rcf-min_days").fill("3");
  await page.getByTestId("rcf-min_lessons").fill("4");
  await page.getByTestId("rcf-monthly_cap").fill("15");
  await page.getByTestId("rcf-inviter_reward-til").fill("100");
  await expect(page.getByTestId("rc-diff-rows")).toContainText("Пригласившему: тилы");
  await expect(page.getByTestId("rc-diff-rows").locator("tbody tr")).toHaveCount(4);
  await page.getByTestId("rc-save").click();
  await expect(page.getByText("Черновик v3 сохранён")).toBeVisible();
  await expect(page.getByTestId("rc-check-state")).toHaveAttribute("data-state", "stale");
  await page.getByTestId("rc-validate").click();
  await expect(page.getByTestId("rc-check-ok")).toBeVisible();
  await page.getByTestId("rc-activate").click();
  const dlg = page.getByTestId("rc-activate-dialog");
  await expect(dlg.getByTestId("rc-activate-changes")).toHaveText("Изменений относительно активной версии: 4");
  await dlg.locator("#cmd-reason").fill("Порог 4 урока за 3 дня, лимит 15, 100 тилов пригласившему");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Кампания v3 активна")).toBeVisible();
  await expect(page.getByTestId("rc-active")).toHaveText("активна v3");
  await expect(page.getByTestId("rch-2")).toHaveAttribute("data-status", "archived");
  const act = bff.calls("POST", "/referrals/campaigns/draft/activate");
  expect(act).toHaveLength(2);
  expect(act[1]!.headers["idempotency-key"]).toBe(act[0]!.headers["idempotency-key"]);
  expect(bff.social.audit.at(-1)).toMatchObject({ action: "referral.campaign_activated" });
  // a version of the history: its parameters and the difference to the active one
  await page.getByTestId("rch-open-1").click();
  const v = page.getByTestId("rc-version");
  await expect(v.getByTestId("rc-version-params")).toContainText("Рефералов в месяц на пригласившего");
  await expect(v.getByTestId("rc-version-diff")).toContainText("monthly_cap");
});

test("a draft saved by a colleague in between: 409 DRAFT_CONFLICT keeps the edits and offers a reload", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/referrals/campaigns", { social: { draftConflictOnce: true } });
  await page.getByTestId("rc-new-draft").click();
  await expect(page.getByTestId("rc-draft")).toBeVisible();
  await page.getByTestId("rcf-window_days").fill("45");
  await page.getByTestId("rc-save").click();
  await expect(page.getByTestId("rc-conflict")).toContainText("Перезагрузите черновик");
  await expect(page.getByTestId("rcf-window_days")).toHaveValue("45");
});

test("statistics by campaign version", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/referrals/stats");
  const v2 = page.getByTestId("rst-2");
  await expect(v2).toContainText("v2");
  await expect(v2.locator(".pill")).toHaveText("2"); // under review
  await expect(page.getByTestId("rst-1")).toContainText("31");
});

test("F7-17: a short draft comment says «at least 10», a long one «at most 500»; nothing is sent", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/referrals/campaigns");
  await page.getByTestId("rc-new-draft").click();
  await expect(page.getByTestId("rc-draft")).toBeVisible();
  const puts = bff.calls("PUT", "/referrals/campaigns/draft").length;
  await page.getByTestId("rc-comment").fill("коротко");
  await page.getByTestId("rc-save").click();
  await expect(page.getByTestId("rc")).toContainText("Не короче 10 символов");
  await expect(page.getByTestId("rc")).not.toContainText("Не длиннее 500 символов");
  await expect(page.getByTestId("rc-comment")).toBeFocused();
  await page.getByTestId("rc-comment").fill("x".repeat(501));
  await page.getByTestId("rc-save").click();
  await expect(page.getByTestId("rc")).toContainText("Не длиннее 500 символов");
  expect(bff.calls("PUT", "/referrals/campaigns/draft")).toHaveLength(puts);
});

test("F7-18: the answer of the activation is lost — the screen is re-read and shows the new active version", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/referrals/campaigns", { social: { activateLostOnce: true } });
  await page.getByTestId("rc-new-draft").click();
  await page.getByTestId("rcf-monthly_cap").fill("12");
  await page.getByTestId("rc-save").click();
  await expect(page.getByText("Черновик v3 сохранён")).toBeVisible();
  await page.getByTestId("rc-validate").click();
  await expect(page.getByTestId("rc-check-ok")).toBeVisible();
  await page.getByTestId("rc-activate").click();
  const dlg = page.getByTestId("rc-activate-dialog");
  await dlg.locator("#cmd-reason").fill("Лимит 12 рефералов в месяц");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByTestId("toasts")).toContainText("Ответ не получен — команда могла выполниться");
  await expect(dlg).toHaveCount(0);
  // the screen is re-read: v3 is active, no draft and no «Активировать» any more
  await expect(page.getByTestId("rc-active")).toHaveText("активна v3");
  await expect(page.getByTestId("rc-draft")).toHaveCount(0);
  await expect(page.getByTestId("rc-activate")).toHaveCount(0);
  expect(bff.calls("GET", "/referrals/campaigns").length).toBeGreaterThanOrEqual(3);
});

test("review: the reward outcome — a badge in the queue and in the card (RU and EN); none while there is no ack", async ({ page }) => {
  await openAs(page, "analyst@tilhero.local", "#/referrals");
  // under review: no outcome yet
  await expect(page.getByTestId("rq-rows").locator("tbody tr")).toHaveCount(2);
  await expect(page.locator("[data-testid^=rq-outcome-]")).toHaveCount(0);
  await page.getByTestId("rq-status").selectOption("rewarded");
  await expect(page.getByTestId(`rq-outcome-${REFERRAL.rewarded}`)).toHaveText("награда кампании");
  await expect(page.getByTestId(`rq-outcome-${REFERRAL.legacy}`)).toHaveText("по правилу спринта 6 (выдана ранее)");
  await page.getByTestId("rq-status").selectOption("capped");
  await expect(page.getByTestId(`rq-outcome-${REFERRAL.capped}`)).toHaveText("лимит месяца");
  await page.getByTestId(`rq-open-${REFERRAL.capped}`).click();
  await expect(page.getByTestId("rr-outcome")).toHaveAttribute("data-outcome", "inviter_capped");
  await expect(page.getByTestId("rr-outcome")).toContainText("месячный лимит");
  await page.evaluate((id) => (window.location.hash = `#/referrals/review/${id}`), REFERRAL.legacy);
  await expect(page.getByTestId("rr-outcome")).toContainText("по правилу спринта 6 (выдана ранее)");
  await page.getByTestId("drawer-close").click();
  await page.getByTestId("lang-en").click();
  await page.evaluate((id) => (window.location.hash = `#/referrals/review/${id}`), REFERRAL.legacy);
  await expect(page.getByTestId("rr-outcome")).toContainText("by the sprint 6 rule (granted earlier)");
  await page.evaluate((id) => (window.location.hash = `#/referrals/review/${id}`), REFERRAL.shortLessons);
  await expect(page.getByTestId("rr-body")).toHaveAttribute("data-status", "review");
  await expect(page.getByTestId("rr-outcome")).toHaveCount(0);
});

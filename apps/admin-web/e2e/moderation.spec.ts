/**
 * Sprint 7 «Модерация» (ADM-SOC-03, AT-79): the queue of open cases (the oldest first, repeated complaints marked); a
 * case shows the subject of the complaint without correspondence and the history of the target's sanctions; a ban
 * longer than 7 days asks for a fresh TOTP and repeats the same command (one Idempotency-Key); a short ban and a
 * dismissal go without step-up; a decided case answers 409 CASE_STATE; an appeal overturned lifts the sanction; a
 * sanction in force is revoked with a reason. Every decision records the basis, the staff member and the term.
 */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { LEARNER } from "./fixtures/data";
import { APPEAL, CASE, DUEL, MEMBER, SANCTION } from "./fixtures/social-data";

const BASIS = "Оскорбительный ник в лиге друзей, четвёртая жалоба";

test("the queue: open cases, the oldest first; the subject without correspondence; the target's history", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/moderation");
  const rows = page.getByTestId("mc-rows").locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-testid", `mc-${CASE.nick}`);
  await expect(rows.nth(2)).toHaveAttribute("data-testid", `mc-${CASE.room}`);
  // 4 complaints on the target in 30 days are marked
  await expect(rows.nth(0)).toContainText("RudeFox");
  await expect(rows.nth(0).locator("td.num .pill")).toHaveText("4");
  await page.getByTestId(`mc-open-${CASE.nick}`).click();
  const d = page.getByTestId("mc-case");
  await expect(d.getByTestId("mc-no-chat")).toContainText("Переписки, реплик и ответов учеников нет");
  await expect(d.getByTestId("mc-subject")).toContainText("Недопустимый ник");
  await expect(d.getByTestId("mc-comment")).toHaveText("Ник оскорбительный, видно в лиге друзей");
  await expect(d.getByTestId("mc-30d")).toContainText("4 — повторные жалобы");
  // the earlier warning of the target, with its appeal
  await expect(d.getByTestId(`mc-hist-${SANCTION.oldWarning}`)).toContainText("Предупреждение");
  await expect(d.getByTestId(`mc-hist-${SANCTION.oldWarning}`)).toContainText("оставлена");
  await expect(page).toHaveURL(new RegExp(`#/moderation/cases/${CASE.nick}$`));
});

test("a ban of 14 days: basis ≥ 10, step-up, the same command repeated; the target is restricted, the case keeps basis, staff and term", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/moderation/cases/${CASE.nick}`);
  const f = page.getByTestId("mc-resolve");
  await f.getByTestId("mc-action-social_ban").check();
  await f.getByTestId("mc-days").fill("31");
  await f.getByTestId("mc-basis").fill("коротко");
  await f.getByTestId("mc-submit").click();
  await expect(f).toContainText("Срок — целое число дней от 1 до 30");
  await expect(f).toContainText("Не короче 10 символов");
  expect(bff.calls("POST", `/moderation/cases/${CASE.nick}/resolve`)).toHaveLength(0);
  await f.getByTestId("mc-days").fill("14");
  await expect(f.getByTestId("mc-until")).toContainText("Запрет до");
  await expect(f.getByTestId("mc-stepup")).toContainText("Запрет дольше 7 дней или бессрочный");
  await f.getByTestId("mc-basis").fill(BASIS);
  await expect(f.getByTestId("mc-submit")).toHaveText("Запретить на 14 дн.");
  await f.getByTestId("mc-submit").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Решение принято: Запрет социальных действий")).toBeVisible();
  const res = page.getByTestId("mc-resolution");
  await expect(res).toContainText(BASIS);
  await expect(res).toContainText("Тимур");
  const calls = bff.calls("POST", `/moderation/cases/${CASE.nick}/resolve`);
  expect(calls).toHaveLength(2); // 403 STEP_UP_REQUIRED, then the same command with the same key
  expect(calls[1]!.headers["idempotency-key"]).toBe(calls[0]!.headers["idempotency-key"]);
  expect(calls[1]!.body).toEqual({ action: "social_ban", days: 14, basis: BASIS });
  expect(bff.social.audit.at(-1)).toMatchObject({ action: "moderation.case_resolved", reason: BASIS });
  // the history of the target now starts with the ban in force
  const hist = page.getByTestId("mc-hist").locator("tbody tr").first();
  await expect(hist).toHaveAttribute("data-state", "active");
  await expect(hist).toContainText("до ");
  // the social card of the target says so
  await page.getByTestId("mc-target").click();
  await expect(page.getByTestId("fr-restricted")).toContainText("Социальные действия запрещены");
  await expect(page.getByTestId("fr-card")).toHaveAttribute("data-user", MEMBER.rudeFox);
});

test("a ban of 3 days and a dismissal go without step-up; a decided case answers 409 CASE_STATE", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/moderation/cases/${CASE.room}`);
  const f = page.getByTestId("mc-resolve");
  await f.getByTestId("mc-action-social_ban").check();
  await f.getByTestId("mc-days").fill("3");
  await expect(f.getByTestId("mc-stepup")).toHaveCount(0);
  await f.getByTestId("mc-basis").fill("Грубость в парном уроке, подтверждено вторым участником");
  await f.getByTestId("mc-submit").click();
  await expect(page.getByTestId("mc-resolution")).toBeVisible();
  await expect(page.getByTestId("stepup")).toHaveCount(0);
  expect(bff.calls("POST", `/moderation/cases/${CASE.room}/resolve`)).toHaveLength(1);
  // another case is dismissed while a colleague decides it in another tab
  await page.evaluate((id) => (window.location.hash = `#/moderation/cases/${id}`), CASE.duel);
  const g = page.getByTestId("mc-resolve");
  await expect(g).toBeVisible();
  bff.social.cases.find((c) => c.case_id === CASE.duel)!.status = "dismissed";
  await g.getByTestId("mc-action-dismiss").check();
  await g.getByTestId("mc-basis").fill("Скорость ответов в пределах нормы для уровня");
  await g.getByTestId("mc-submit").click();
  await expect(page.getByText("По делу уже принято решение — обновите очередь")).toBeVisible();
  await expect(page.getByTestId("mc-resolve")).toHaveCount(0);
});

test("the subject of a duel complaint opens the duel card (league.read)", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", `#/moderation/cases/${CASE.duel}`);
  await expect(page.getByTestId("mc-subject-kind")).toContainText("Дуэль");
  // F7-19: the status in words, not the raw code
  await expect(page.getByTestId("mc-subject-status")).toHaveText("статус: завершена");
  await expect(page.getByTestId("mc-subject-status")).toHaveAttribute("data-status", "finished");
  await page.getByTestId("mc-subject-open").click();
  await expect(page.getByTestId("dl-duel")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/leagues/duels/${DUEL.technical}$`));
});

test("an appeal overturned lifts the sanction; the note is required; the decision stays", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local", "#/moderation/appeals");
  await expect(page.getByTestId("ma-rows").locator("tbody tr")).toHaveCount(1);
  await page.getByTestId(`ma-open-${APPEAL.anya}`).click();
  const d = page.getByTestId("ma-appeal");
  await expect(d.getByTestId("ma-text")).toContainText("одноклассникам из нового кружка");
  await d.getByTestId("ma-submit").click();
  await expect(d).toContainText("Выберите решение");
  await d.getByTestId("ma-d-overturned").check();
  await d.getByTestId("ma-note").fill("Заявки одноклассникам, это не спам — запрет снят");
  await d.getByTestId("ma-submit").click();
  await expect(page.getByText("Санкция отменена")).toBeVisible();
  await expect(d.getByTestId("ma-decided")).toContainText("Отменить санкцию");
  await expect(d.getByTestId("ma-decided")).toContainText("Алина");
  const s = bff.social.sanctions.find((x) => x.sanction_id === SANCTION.anyaBan)!;
  expect(s.active).toBe(false);
  expect(s.appeal).toEqual({ appeal_id: APPEAL.anya, status: "overturned" });
  await page.getByTestId("drawer-close").click();
  await expect(page.getByTestId("ma-empty")).toBeVisible();
  // the learner is no longer restricted
  await page.evaluate((id) => (window.location.hash = `#/friends/${id}`), LEARNER.anya);
  await expect(page.getByTestId("fr-card")).toBeVisible();
  await expect(page.getByTestId("fr-restricted")).toHaveCount(0);
});

test("sanctions: by learner and state; a sanction in force is revoked with a reason; a repeat answers SANCTION_STATE", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/moderation/sanctions");
  const rows = page.getByTestId("ms-rows").locator("tbody tr");
  await expect(rows).toHaveCount(3); // in force: the ban of SkyFox and two warnings
  await page.getByTestId("ms-uid").fill("nope");
  await expect(page.getByTestId("mod-sanctions")).toContainText("Введите UUID ученика");
  await page.getByTestId("ms-uid").fill(LEARNER.anya);
  await expect(rows).toHaveCount(2);
  await page.getByTestId(`ms-rows-revoke-${SANCTION.anyaBan}`).click();
  const dlg = page.getByTestId("mod-revoke-dialog");
  await expect(dlg.getByTestId("mod-revoke-what")).toContainText("Массовые заявки");
  await dlg.locator("#cmd-reason").fill("Ошибка модератора: одноклассники");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByText("Санкция снята")).toBeVisible();
  await expect(rows).toHaveCount(1);
  await page.getByTestId("ms-active").selectOption("false");
  await expect(page.getByTestId(`ms-rows-${SANCTION.anyaBan}-revoked`)).toContainText("Ошибка модератора");
  expect(bff.social.audit.at(-1)).toMatchObject({ action: "moderation.sanction_revoked", reason: "Ошибка модератора: одноклассники" });
});

test("F7-19: the status of a room subject is translated (RU and EN)", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", `#/moderation/cases/${CASE.room}`);
  await expect(page.getByTestId("mc-subject-status")).toHaveText("статус: идёт урок");
  await page.getByTestId("drawer-close").click();
  await page.getByTestId("lang-en").click();
  await page.evaluate((id) => (window.location.hash = `#/moderation/cases/${id}`), CASE.room);
  await expect(page.getByTestId("mc-subject-status")).toHaveText("status: in lesson");
});

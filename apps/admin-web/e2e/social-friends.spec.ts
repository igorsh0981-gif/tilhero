/**
 * Sprint 7 «Друзья и жалобы» (ADM-SOC-01, AT-73, AT-79): the «Сообщество» tab of the learner card leads to the social
 * card — nickname, friend code, member_id, the hidden game profile, friends (a number only), friend requests (status and
 * dates, never the other side), blocks given / received, cases as reporter and as target, sanctions with basis and
 * term; a sanction in force is revoked from the card (moderation.manage); a lookup by UUID; a learner unknown to the
 * community answers with a calm empty state. Correspondence does not exist and is never shown.
 */
import { expect, test } from "@playwright/test";
import { openAs } from "./helpers";
import { LEARNER } from "./fixtures/data";
import { CASE, SANCTION } from "./fixtures/social-data";

test("from the learner card: «Сообщество» tab → the social card; requests without the other side; cases and sanctions", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local", `#/users/${LEARNER.anya}`);
  await page.getByTestId("lc-tab-social").click();
  const tab = page.getByTestId("lc-social");
  await expect(tab).toContainText("SkyFox");
  await expect(page.getByTestId("lc-social-ban")).toContainText("Социальные действия запрещены");
  await page.getByTestId("lc-social-open").click();
  const card = page.getByTestId("fr-card");
  await expect(card).toHaveAttribute("data-user", LEARNER.anya);
  await expect(page.getByTestId("fr-nick")).toHaveText("SkyFox");
  // support has moderation.manage: the whole code, with the note that only moderators see it so (F7-20)
  await expect(page.getByTestId("fr-code")).toHaveText("TH-M3TA-8HKE");
  await expect(page.getByTestId("fr-code")).toHaveAttribute("data-masked", "false");
  await expect(page.getByTestId("fr-code-note")).toContainText("Код виден полностью — только модераторам");
  await expect(page.getByTestId("fr-member")).toHaveText(/^mb_[A-Za-z0-9_-]{22}$/);
  await expect(page.getByTestId("fr-friends")).toHaveText("31");
  await expect(page.getByTestId("fr-blocks")).toHaveText("0 / 3");
  await expect(page.getByTestId("fr-privacy")).toContainText("Имя, Telegram, возраст и ответы ученика в сообществе не раскрываются");
  // requests: direction, status, dates — no nickname or id of the other side anywhere in the table
  const req = page.getByTestId("fr-req-rows");
  await expect(req.locator("tbody tr")).toHaveCount(4);
  await expect(req).toContainText("исходящая");
  await expect(req).toContainText("истекла");
  await expect(req).not.toContainText("TilMaster");
  await expect(req).not.toContainText("a1000000");
  // cases where she is the target; sanctions — the ban in force with its appeal under review
  await expect(page.getByTestId(`fr-case-${CASE.room}`)).toHaveAttribute("data-role", "target");
  await expect(page.getByTestId(`fr-case-${CASE.dismissed}`)).toHaveAttribute("data-role", "reporter");
  await expect(page.getByTestId(`fr-sanc-${SANCTION.anyaBan}`)).toContainText("на рассмотрении");
  // a case opens in «Модерация»
  await page.getByTestId(`fr-case-open-${CASE.room}`).click();
  await expect(page.getByTestId("mc-case")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/moderation/cases/${CASE.room}$`));
  expect(bff.calls("GET", `/social/users/${LEARNER.anya}`).length).toBeGreaterThanOrEqual(2);
});

test("a sanction in force is revoked from the card with a reason; the restriction is gone", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/friends/${LEARNER.anya}`);
  await expect(page.getByTestId("fr-restricted")).toBeVisible();
  await page.getByTestId(`fr-sanc-revoke-${SANCTION.anyaBan}`).click();
  const dlg = page.getByTestId("mod-revoke-dialog");
  await dlg.locator("#cmd-reason").fill("Подтвердили: одноклассники, не спам");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByText("Санкция снята")).toBeVisible();
  await expect(page.getByTestId("fr-restricted")).toHaveCount(0);
  await expect(page.getByTestId(`fr-sanc-${SANCTION.anyaBan}`)).toHaveAttribute("data-state", "revoked");
  await expect(page.getByTestId(`fr-sanc-${SANCTION.anyaBan}-revoked`)).toContainText("Тимур");
  expect(bff.calls("POST", `/moderation/sanctions/${SANCTION.anyaBan}/revoke`).at(-1)!.body).toEqual({ reason: "Подтвердили: одноклассники, не спам" });
});

test("lookup by UUID; a learner unknown to the community; a learner without a nickname yet", async ({ page }) => {
  await openAs(page, "analyst@tilhero.local", "#/friends");
  await page.getByTestId("fr-lookup-uid").fill("anya");
  await page.getByTestId("fr-lookup-go").click();
  await expect(page.getByTestId("fr-lookup")).toContainText("Введите UUID ученика");
  await page.getByTestId("fr-lookup-uid").fill(LEARNER.oleg);
  await page.getByTestId("fr-lookup-go").click();
  await expect(page.getByTestId("fr-none")).toContainText("Ученик не найден в сообществе");
  await page.evaluate((id) => (window.location.hash = `#/friends/${id}`), LEARNER.jasur);
  await expect(page.getByTestId("fr-no-profile")).toBeVisible();
  await expect(page.getByTestId("fr-kpis")).toContainText("ник не задан");
  await expect(page.getByTestId("fr-code")).toHaveText("—");
  // analyst: social.read without moderation.manage — no revoke, no link to the queue
  await expect(page.getByTestId("fr-ro")).toContainText("moderation.manage");
  await expect(page.getByTestId("fr-to-mod")).toHaveCount(0);
});

test("F7-20: without moderation.manage the friend code comes masked from admin-bff and is shown as it came", async ({ page }) => {
  const bff = await openAs(page, "analyst@tilhero.local", `#/friends/${LEARNER.anya}`);
  await expect(page.getByTestId("fr-code")).toHaveText("TH-••••-8HKE");
  await expect(page.getByTestId("fr-code")).toHaveAttribute("data-masked", "true");
  await expect(page.getByTestId("fr-code-note")).toContainText("полностью его видят только модераторы (moderation.manage)");
  await expect(page.getByTestId("fr-card")).not.toContainText("TH-M3TA-8HKE");
  // the mask is made by the server: the whole code never reached the browser
  for (const c of bff.calls("GET", `/social/users/${LEARNER.anya}`)) expect(JSON.stringify(c)).not.toContain("M3TA");
});

test("review: the learner card of a learner unknown to the community — «Ученик не найден в сообществе», not a failure", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local", `#/users/${LEARNER.lola}`);
  await page.getByTestId("lc-tab-social").click();
  await expect(page.getByTestId("lc-social-none")).toContainText("Ученик не найден в сообществе");
  await expect(page.getByTestId("lc-social-none")).toContainText("ещё не заходил в сообщество");
  await expect(page.getByTestId("load-error")).toHaveCount(0);
  await expect(page.getByTestId("lc-social")).toHaveCount(0);
  expect(bff.calls("GET", `/social/users/${LEARNER.lola}`).length).toBeGreaterThanOrEqual(1);
});

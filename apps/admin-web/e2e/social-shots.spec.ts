/**
 * Screenshots of the sprint 7 screens (SHOTS_DIR, default /tmp/admin-s7-shots): the overview block, the social card,
 * the moderation queue and a case with the decision of a 14-day ban (step-up), an appeal, the referral queue and a held
 * referral, a campaign draft with the client check and the activation dialog, the league week, a held group and its
 * re-evaluation with the preview, a duel after re-evaluation, the pair rooms and a room with the stop dialog. Light
 * theme; the key ones in dark too. Each screen is checked for no horizontal page scroll.
 */
import { expect, test, type Page } from "@playwright/test";
import { expectNoHScroll, openAs, setTheme, settle, typeOtp } from "./helpers";
import { LEARNER } from "./fixtures/data";
import { APPEAL, CASE, DUEL, GROUP, REFERRAL, ROOM } from "./fixtures/social-data";

const DIR = process.env.SHOTS_DIR ?? "/tmp/admin-s7-shots";
const snap = async (page: Page, name: string, fullPage = false) => {
  await settle(page);
  await expectNoHScroll(page);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage });
};

for (const mode of ["light", "dark"] as const) {
  test.describe(`sprint 7 screenshots · ${mode}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: mode });
    });

    test(`moderation (${mode})`, async ({ page }) => {
      await openAs(page, "ops@tilhero.local", "#/moderation");
      await setTheme(page, mode);
      await expect(page.getByTestId("mc-rows")).toBeVisible();
      await snap(page, `s7-01-moderation-queue-${mode}`);
      await page.getByTestId(`mc-open-${CASE.nick}`).click();
      const f = page.getByTestId("mc-resolve");
      await f.getByTestId("mc-action-social_ban").check();
      await f.getByTestId("mc-days").fill("14");
      await f.getByTestId("mc-basis").fill("Оскорбительный ник в лиге друзей, четвёртая жалоба");
      await f.scrollIntoViewIfNeeded();
      await snap(page, `s7-02-case-decision-${mode}`);
      if (mode === "light") {
        await f.getByTestId("mc-submit").click();
        await expect(page.getByTestId("stepup")).toBeVisible();
        await snap(page, "s7-03-case-stepup-light");
        await typeOtp(page, "stepup");
        await expect(page.getByTestId("mc-resolution")).toBeVisible();
        await page.getByTestId("mc-resolution").scrollIntoViewIfNeeded();
        await snap(page, "s7-04-case-resolved-light");
      }
    });

    test(`referrals (${mode})`, async ({ page }) => {
      await openAs(page, "ops@tilhero.local", "#/referrals/review");
      await setTheme(page, mode);
      await page.getByTestId(`rq-open-${REFERRAL.velocity}`).click();
      await expect(page.getByTestId("rr-body")).toBeVisible();
      await snap(page, `s7-05-referral-held-${mode}`);
      if (mode === "light") {
        await page.getByTestId("rr-reject").click();
        await page.getByTestId("rr-code").selectOption("review_rejected");
        await page.getByTestId("rr-note").fill("Пять квалификаций за вечер и занятия до приглашения");
        await snap(page, "s7-06-referral-reject-light");
        await page.keyboard.press("Escape");
        await page.getByTestId("drawer-close").click();
        await page.evaluate(() => (window.location.hash = "#/referrals/campaigns"));
        await page.getByTestId("rc-new-draft").click();
        await page.getByTestId("rcf-min_days").fill("4");
        await page.getByTestId("rcf-inviter_reward-til").fill("100");
        await expect(page.getByTestId("rc-errors")).toBeVisible();
        await page.getByTestId("rc-errors").scrollIntoViewIfNeeded();
        await page.evaluate(() => window.scrollBy(0, -90));
        await snap(page, "s7-07-campaign-draft-errors-light");
        await page.getByTestId("rcf-min_days").fill("3");
        await page.getByTestId("rcf-min_lessons").fill("4");
        await page.getByTestId("rc-save").click();
        await expect(page.getByText("Черновик v3 сохранён")).toBeVisible();
        await page.getByTestId("rc-validate").click();
        await expect(page.getByTestId("rc-check-ok")).toBeVisible();
        await page.getByTestId("rc-activate").click();
        await page.getByTestId("rc-activate-dialog").locator("#cmd-reason").fill("Порог 4 урока за 3 дня и 100 тилов пригласившему");
        await snap(page, "s7-08-campaign-activate-light");
      } else {
        await page.getByTestId("drawer-close").click();
        await expect(page.getByTestId("rq-rows")).toBeVisible();
        await snap(page, "s7-05b-referral-queue-dark");
      }
    });

    test(`leagues and duels (${mode})`, async ({ page }) => {
      const bff = await openAs(page, "ops@tilhero.local", "#/leagues");
      await setTheme(page, mode);
      await page.getByTestId("lg-prev").click();
      await expect(page.getByTestId(`lg-${GROUP.heldPrev}`)).toBeVisible();
      await snap(page, `s7-09-league-week-${mode}`);
      await page.getByTestId(`lg-open-${GROUP.heldPrev}`).click();
      await expect(page.getByTestId("lg-held")).toBeVisible();
      await snap(page, `s7-10-league-group-held-${mode}`);
      if (mode === "light") {
        const uid = bff.social.groups.find((g) => g.group_id === GROUP.heldPrev)!.members.find((m) => m.anomaly)!.user_id;
        await page.getByTestId("lg-reevaluate").click();
        await page.getByTestId(`lg-ex-${uid}`).locator("input").check();
        await page.getByTestId("lg-reason").fill("XP набран за счёт повторов одного урока — исключён");
        await snap(page, "s7-11-league-reevaluate-light");
        await page.keyboard.press("Escape");
        await page.evaluate((id) => (window.location.hash = `#/leagues/duels/${id}`), DUEL.won);
        await page.getByTestId("dl-reevaluate").click();
        await page.getByTestId("dl-r-draw").check();
        await page.getByTestId("dl-reason").fill("Сбой проверки ключа в задании 7");
        await page.getByTestId("dl-reeval-ok").click();
        await typeOtp(page, "stepup");
        await expect(page.getByTestId("dl-duel-body")).toHaveAttribute("data-version", "2");
        await snap(page, "s7-12-duel-reevaluated-light");
      }
    });

    test(`pair rooms (${mode})`, async ({ page }) => {
      await openAs(page, "ops@tilhero.local", "#/pair_rooms");
      await setTheme(page, mode);
      await expect(page.getByTestId("pr-rows")).toBeVisible();
      await snap(page, `s7-13-pair-rooms-${mode}`);
      await page.getByTestId(`pr-open-${ROOM.live}`).click();
      await expect(page.getByTestId("pr-participants")).toBeVisible();
      await snap(page, `s7-14-pair-room-${mode}`);
      if (mode === "light") {
        await page.getByTestId("pr-stop").click();
        await page.getByTestId("pr-stop-dialog").locator("#cmd-reason").fill("Жалоба на грубость, дело модерации открыто");
        await snap(page, "s7-15-pair-room-stop-light");
      }
    });

    test(`social card and overview (${mode})`, async ({ page }) => {
      await openAs(page, "ops@tilhero.local", `#/friends/${LEARNER.anya}`);
      await setTheme(page, mode);
      await expect(page.getByTestId("fr-kpis")).toBeVisible();
      await snap(page, `s7-16-social-card-${mode}`, true);
      if (mode === "light") {
        await page.evaluate(() => (window.location.hash = "#/moderation/appeals"));
        await page.getByTestId(`ma-open-${APPEAL.anya}`).click();
        await page.getByTestId("ma-d-overturned").check();
        await page.getByTestId("ma-note").fill("Заявки одноклассникам, это не спам — запрет снят");
        await snap(page, "s7-17-appeal-light");
        await page.getByTestId("drawer-close").click();
      }
      await page.evaluate(() => (window.location.hash = "#/overview"));
      await page.getByTestId("block-social").scrollIntoViewIfNeeded();
      await snap(page, `s7-18-overview-social-${mode}`);
    });
  });
}

/**
 * Screenshots of the sprint 6 screens (SHOTS_DIR, default /tmp/admin-s6-shots): the hero catalog, a hero card with a
 * replaced picture and the comparison, the rules form with the check errors, the activation dialog, the version
 * history, the shop and an item, a learner's wallet with the ledger and the manual operation, the events with the
 * overlap, the overview of the game and the overview block. Light theme, the key ones in dark too; each screen is
 * checked for no horizontal page scroll.
 */
import { expect, test, type Page } from "@playwright/test";
import { expectNoHScroll, openAs, setTheme, settle } from "./helpers";
import { LEARNER } from "./fixtures/data";
import { EVENT_ID, NEW_STAGE_PNG } from "./fixtures/game-data";

const DIR = process.env.SHOTS_DIR ?? "/tmp/admin-s6-shots";
const snap = async (page: Page, name: string, fullPage = false) => {
  await settle(page);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage });
};

for (const mode of ["light", "dark"] as const) {
  test.describe(`sprint 6 screenshots · ${mode}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: mode });
    });

    test(`heroes (${mode})`, async ({ page }) => {
      await openAs(page, "ops@tilhero.local", "#/heroes");
      await setTheme(page, mode);
      await expect.poll(async () => page.locator(".hero-card img").evaluateAll((xs) => xs.filter((x) => (x as HTMLImageElement).naturalWidth > 0).length)).toBe(27);
      await expectNoHScroll(page);
      await snap(page, `s6-01-heroes-${mode}`, true);
      await page.evaluate(() => (window.location.hash = "#/heroes/pet_1"));
      await page.getByTestId("hr-upload-2").setInputFiles({ name: "malysh.png", mimeType: "image/png", buffer: NEW_STAGE_PNG() });
      await expect(page.getByTestId("hr-stage-2-changed")).toBeVisible();
      await snap(page, `s6-02-hero-draft-${mode}`);
      await page.getByTestId("hrd-tab-compare").click();
      await expect(page.getByTestId("hr-compare")).toBeVisible();
      await snap(page, `s6-03-hero-compare-${mode}`);
    });

    test(`rules (${mode})`, async ({ page }) => {
      await openAs(page, "ops@tilhero.local", "#/game/rules");
      await setTheme(page, mode);
      await page.getByTestId("gr-new-draft").click();
      await expect(page.getByTestId("gr-draft")).toBeVisible();
      await page.getByTestId("gr-levels-2").fill("90");
      await page.getByTestId("gr-caps-xp_per_day").fill("20");
      await expect(page.getByTestId("gr-errors")).toBeVisible();
      await expectNoHScroll(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await snap(page, `s6-04-rules-errors-${mode}`);
      await page.getByTestId("grs-levels").scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -80));
      await snap(page, `s6-04b-rules-levels-quests-${mode}`);
      if (mode === "light") {
        await page.getByTestId("gr-levels-2").fill("250");
        await page.getByTestId("gr-caps-xp_per_day").fill("300");
        await page.getByTestId("gr-earn-reading-til").fill("8");
        await page.getByTestId("gr-save").click();
        await page.getByTestId("gr-validate").click();
        await expect(page.getByTestId("gr-check-ok")).toBeVisible();
        await page.getByTestId("grt-diff").click();
        await expect(page.getByTestId("gr-diff-table")).toBeVisible();
        await snap(page, `s6-05-rules-diff-${mode}`);
        await page.getByTestId("gr-activate").click();
        await page.getByTestId("gr-activate-dialog").locator("#cmd-reason").fill("Чтение даёт больше тилов в ноябре");
        await snap(page, `s6-06-rules-activate-${mode}`);
        await page.keyboard.press("Escape");
        await page.getByTestId("grt-history").click();
        await expect(page.getByTestId("gr-history")).toBeVisible();
        await snap(page, `s6-07-rules-history-${mode}`);
      }
    });

    test(`shop (${mode})`, async ({ page }) => {
      await openAs(page, "ops@tilhero.local", "#/game/shop");
      await setTheme(page, mode);
      await expect(page.getByTestId("sh-rows")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s6-08-shop-${mode}`);
      await page.getByTestId("sh-open-frame_gold").click();
      await expect(page.getByTestId("sh-item")).toBeVisible();
      await snap(page, `s6-09-shop-item-${mode}`);
    });

    test(`wallet (${mode})`, async ({ page }) => {
      await openAs(page, "ops@tilhero.local", `#/game/wallets/${LEARNER.madina}`);
      await setTheme(page, mode);
      await expect(page.getByTestId("wl-led-rows")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s6-10-wallet-${mode}`, true);
      await page.getByTestId("wl-adjust").click();
      await page.getByTestId("wl-amount").fill("40");
      await page.getByTestId("wl-adjust-dialog").locator("#cmd-reason").fill("Компенсация за сбой урока, TCK-1042");
      await snap(page, `s6-11-wallet-adjust-${mode}`);
    });

    test(`events and the overview (${mode})`, async ({ page }) => {
      await openAs(page, "ops@tilhero.local", "#/events");
      await setTheme(page, mode);
      await expect(page.getByTestId("ev-rows")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s6-12-events-${mode}`);
      await page.evaluate((id) => (window.location.hash = `#/events/${id}`), EVENT_ID.kidsReading);
      await page.getByTestId("ev-publish").click();
      await page.getByTestId("ev-cmd-dialog").locator("#cmd-reason").fill("Сказки для дракончиков на неделю");
      await page.getByTestId("ev-cmd-dialog").getByTestId("confirm-ok").click();
      await page.locator("#stepup-0").focus();
      await page.keyboard.type("123456");
      await expect(page.getByTestId("ev-overlap")).toBeVisible();
      await snap(page, `s6-13-event-overlap-${mode}`);
      await page.evaluate(() => (window.location.hash = "#/game/overview"));
      await expect(page.getByTestId("go-kpis")).toBeVisible();
      await snap(page, `s6-14-game-overview-${mode}`);
      await page.evaluate(() => (window.location.hash = "#/overview"));
      await page.getByTestId("block-game").scrollIntoViewIfNeeded();
      await snap(page, `s6-15-dashboard-game-${mode}`);
    });
  });
}

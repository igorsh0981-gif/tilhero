/**
 * Screenshots of the sprint 5 screens in both themes (SHOTS_DIR, default /tmp/admin-s5-shots): the reading editor with
 * its rules and the glossary highlighting, the learner preview, the course dictionary and the AI queue, an entry card,
 * a learner's memory and a card with the scheduling history, the forgetting analytics with hidden groups, the speech
 * provider and the pronunciation costs, the overview block. Each screen is checked for no horizontal page scroll.
 */
import { expect, test, type Page } from "@playwright/test";
import { expectNoHScroll, openAs, setTheme, settle } from "./helpers";
import { LEARNER } from "./fixtures/data";
import { CID, GID } from "./fixtures/memory-data";

const DIR = process.env.SHOTS_DIR ?? "/tmp/admin-s5-shots";
const THEMES = ["light", "dark"] as const;
const snap = async (page: Page, name: string, fullPage = true) => {
  await settle(page);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage });
};

for (const mode of THEMES) {
  test.describe(`sprint 5 screenshots · ${mode}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: mode });
    });

    test(`reading editor and preview (${mode})`, async ({ page }) => {
      await openAs(page, "methodist@tilhero.local", "#/content/readings/r-a1-market");
      await setTheme(page, mode);
      await expect(page.getByTestId("reading-editor")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s5-01-reading-${mode}`, false);
      await page.getByTestId("rd-glossary").scrollIntoViewIfNeeded();
      await snap(page, `s5-02-reading-glossary-${mode}`, false);
      await page.getByTestId("ws-tab-preview").click();
      await page.getByTestId("rd-pv-word-0").first().click();
      await expectNoHScroll(page);
      await snap(page, `s5-03-reading-preview-${mode}`, false);
    });

    test(`course dictionary (${mode})`, async ({ page }) => {
      await openAs(page, "methodist@tilhero.local", "#/content/glossary/queue");
      await setTheme(page, mode);
      await expect(page.getByTestId("gl-queue")).toBeVisible();
      await page.getByTestId("glq-correct-bakery").click();
      await expectNoHScroll(page);
      await snap(page, `s5-04-glossary-queue-${mode}`, false);
      await page.evaluate((id) => (window.location.hash = `#/content/glossary/${id}`), GID.coffeeShop);
      await expect(page.getByTestId("gl-entry-body")).toBeVisible();
      await snap(page, `s5-05-glossary-entry-${mode}`, false);
    });

    test(`memory and analytics (${mode})`, async ({ page }) => {
      await openAs(page, "ops@tilhero.local", `#/memory/learners/${LEARNER.madina}`);
      await setTheme(page, mode);
      await expect(page.getByTestId("mem-cards")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s5-06-memory-${mode}`, false);
      await page.evaluate(([u, c]) => (window.location.hash = `#/memory/learners/${u}/${c}`), [LEARNER.madina, CID.c1]);
      await expect(page.getByTestId("mem-log")).toBeVisible();
      await snap(page, `s5-07-memory-card-${mode}`, false);
      await page.evaluate(() => (window.location.hash = "#/memory/analytics"));
      await expect(page.getByTestId("fa-words")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s5-08-analytics-${mode}`);
    });

    test(`speech and overview (${mode})`, async ({ page }) => {
      await openAs(page, "admin@tilhero.local", "#/agents/models");
      await setTheme(page, mode);
      await expect(page.getByTestId("prov-speech")).toBeVisible();
      await snap(page, `s5-09-models-${mode}`);
      await page.locator('[data-nav="costs"]').click();
      await page.getByTestId("cs-speech").scrollIntoViewIfNeeded();
      await snap(page, `s5-10-costs-speech-${mode}`, false);
      await page.getByTestId("csf-speech_monthly_cap_usd").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("csf-speech-hours")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s5-12-costs-limits-${mode}`, false);
      await page.locator('[data-nav="overview"]').click();
      await page.getByTestId("block-memory").scrollIntoViewIfNeeded();
      await expectNoHScroll(page);
      await snap(page, `s5-11-overview-${mode}`, false);
    });
  });
}

/**
 * Screenshots of the sprint 3 screens in both themes (SHOTS_DIR, default /tmp/admin-s3-shots): lesson editor with an
 * empty UZ highlighted, scenario graph with test-run problems, media with rights, review diff, languages and pairs,
 * overview with the content and diagnostics blocks. Each screen is also checked for no horizontal page scroll.
 */
import { expect, test, type Page } from "@playwright/test";
import { expectNoHScroll, openAs, setTheme, settle } from "./helpers";

const DIR = process.env.SHOTS_DIR ?? "/tmp/admin-s3-shots";
const THEMES = ["light", "dark"] as const;
const snap = async (page: Page, name: string, fullPage = true) => {
  await settle(page);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage });
};

for (const mode of THEMES) {
  test.describe(`sprint 3 screenshots · ${mode}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: mode });
    });

    test(`lesson editor (${mode})`, async ({ page }) => {
      await openAs(page, "methodist@tilhero.local", "#/content/lessons/l-01-greetings");
      await setTheme(page, mode);
      await expect(page.getByTestId("lesson-editor")).toBeVisible();
      await page.getByTestId("ws-lang-uz").click();
      await expect(page.getByTestId("le-title-uz-missing")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s3-01-lesson-editor-${mode}`, false);
      await page.getByTestId("le-stages").scrollIntoViewIfNeeded();
      await snap(page, `s3-02-lesson-stages-${mode}`, false);
      await page.getByTestId("ws-tab-preview").click();
      await expect(page.getByTestId("lesson-phone")).toBeVisible();
      await snap(page, `s3-03-lesson-preview-${mode}`, false);
    });

    test(`scenario graph with problems (${mode})`, async ({ page }) => {
      await openAs(page, "methodist@tilhero.local", "#/content/scenarios/sc-cafe-order");
      await setTheme(page, mode);
      await expect(page.getByTestId("ws-scenario")).toHaveAttribute("data-status", "draft");
      await page.getByTestId("se-run").click();
      await expect(page.getByTestId("se-run-issues")).toBeVisible();
      await page.getByTestId("run-go-n_wait").click();
      await expect(page.getByTestId("se-node-ed-n_wait")).toBeVisible();
      await expectNoHScroll(page);
      await page.setViewportSize({ width: 1440, height: 1500 });
      await page.getByTestId("se-graph-sec").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 150));
      await page.waitForTimeout(700); // the graph scrolls smoothly to the chosen node
      await snap(page, `s3-04-scenario-graph-${mode}`, false);
    });

    test(`media with rights (${mode})`, async ({ page }) => {
      await openAs(page, "content@tilhero.local", "#/content/media/m-own-bus-stop");
      await setTheme(page, mode);
      await expect(page.getByTestId("ma-rights")).toBeVisible();
      await page.getByTestId("ma-rights").scrollIntoViewIfNeeded();
      await expectNoHScroll(page);
      await snap(page, `s3-05-media-rights-${mode}`, false);
      await page.evaluate(() => (window.location.hash = "#/content/media/m-own-train"));
      await expect(page.getByTestId("ws-media_asset")).toHaveAttribute("data-status", "draft");
      await page.getByTestId("ma-transcript").scrollIntoViewIfNeeded();
      await snap(page, `s3-06-media-transcript-${mode}`, false);
    });

    test(`review queue (${mode})`, async ({ page }) => {
      await openAs(page, "methodist@tilhero.local", "#/content/review");
      await setTheme(page, mode);
      await expect(page.getByTestId("rv-row-l-02-numbers")).toBeVisible();
      await snap(page, `s3-07-review-queue-${mode}`, false);
    });

    test(`review diff (${mode})`, async ({ page }) => {
      // the lesson draft is submitted by its author, then another methodist reviews the diff with the published v1
      const bff = await openAs(page, "methodist@tilhero.local", "#/content/lessons/l-01-greetings");
      await page.getByTestId("ws-lang-uz").click();
      await page.getByTestId("le-title-uz").fill("Salom! Tanishamiz");
      await page.getByTestId("le-stage-1-uz").fill("Hello, Hi, Good morning, Good evening va My name is…");
      await page.locator('input[data-path="payload.key_words[4].gloss.uz"]').fill("xayrli kech");
      await page.getByTestId("ws-save").click();
      await expect(page.getByTestId("ws-submit")).toBeEnabled();
      await page.getByTestId("ws-submit").click();
      await expect(page.getByTestId("ws-lesson")).toHaveAttribute("data-status", "in_review");
      bff.switchTo("methodist2@tilhero.local");
      await page.goto("/#/content/review/lesson/l-01-greetings");
      await page.reload();
      await setTheme(page, mode);
      await expect(page.getByTestId("rv-diff")).toBeVisible();
      await page.getByTestId("rv-check-ru").check();
      await expectNoHScroll(page);
      await snap(page, `s3-08-review-diff-${mode}`, false);
    });

    test(`languages (${mode})`, async ({ page }) => {
      await openAs(page, "admin@tilhero.local", "#/langs");
      await setTheme(page, mode);
      await expect(page.getByTestId("pair-ru-en")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s3-09-langs-${mode}`);
    });

    test(`overview (${mode})`, async ({ page }) => {
      await openAs(page, "admin@tilhero.local", "#/overview");
      await setTheme(page, mode);
      await expect(page.getByTestId("block-content")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s3-10-overview-${mode}`);
    });

    test(`course, requests, diagnostics (${mode})`, async ({ page }) => {
      await openAs(page, "admin@tilhero.local", "#/content/course");
      await setTheme(page, mode);
      await expect(page.getByTestId("tree-m1-meet")).toBeVisible();
      await snap(page, `s3-11-course-${mode}`, false);
      await page.evaluate((id) => (window.location.hash = `#/content/requests/${id}`), "c1000000-0000-4000-8000-000000000001");
      await expect(page.getByTestId("rq-card")).toBeVisible();
      await snap(page, `s3-12-request-${mode}`, false);
      await page.evaluate(() => (window.location.hash = "#/content/diagnostics"));
      await expect(page.getByTestId("dx-coverage")).toBeVisible();
      await snap(page, `s3-13-diagnostics-${mode}`, false);
    });
  });
}

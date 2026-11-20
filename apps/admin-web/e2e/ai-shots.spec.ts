/**
 * Screenshots of the sprint 4 screens in both themes (SHOTS_DIR, default /tmp/admin-s4-shots): agent registry, version
 * editor, test results, canary, diff, models, session journal, session card, re-evaluation, appeals, the Jira task,
 * costs, the emergency stop and the overview. Each screen is also checked for no horizontal page scroll.
 */
import { expect, test, type Page } from "@playwright/test";
import { expectNoHScroll, openAs, setTheme, settle } from "./helpers";
import { AID, SID } from "./fixtures/ai-data";

const DIR = process.env.SHOTS_DIR ?? "/tmp/admin-s4-shots";
const THEMES = ["light", "dark"] as const;
const snap = async (page: Page, name: string, fullPage = false) => {
  await settle(page);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage });
};

test.describe.configure({ timeout: 90_000 });

for (const mode of THEMES) {
  test.describe(`sprint 4 screenshots · ${mode}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: mode });
    });

    test(`agents: registry, editor, results, canary, diff, models (${mode})`, async ({ page }) => {
      await openAs(page, "methodist@tilhero.local", "#/agents");
      await setTheme(page, mode);
      await expect(page.getByTestId("ag-registry")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s4-01-agents-registry-${mode}`, true);
      // editor of a new draft with a broken schema → failed run
      await page.getByTestId("ag-open-conversation_partner").click();
      await page.getByTestId("ag-new-draft").click();
      await expect(page.getByTestId("ag-version")).toHaveAttribute("data-status", "draft");
      const schema = page.getByTestId("agv-schema");
      await schema.fill((await schema.inputValue()).replace('"maxLength": 240', '"maxLength": 20'));
      await page.getByTestId("agv-save").click();
      await expect(page.getByTestId("toasts")).toContainText("v3");
      await page.getByTestId("ag-version").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 140));
      await expectNoHScroll(page);
      await snap(page, `s4-02-version-editor-${mode}`);
      await page.getByTestId("agv-run").click();
      await expect(page.getByTestId("agv-run-summary")).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("agv-run-panel").scrollIntoViewIfNeeded();
      await snap(page, `s4-03-test-results-${mode}`);
      await page.getByTestId("agc-tab-diff").click();
      await expect(page.getByTestId("ag-diff")).toBeVisible();
      await snap(page, `s4-05-diff-${mode}`, true);
      // canary of the evaluator
      await page.evaluate(() => (window.location.hash = "#/agents/independent_evaluator"));
      await expect(page.getByTestId("ag-canary")).toBeVisible();
      await page.getByTestId("ag-canary-btn").click();
      await expect(page.getByTestId("ag-canary-dialog")).toBeVisible();
      await snap(page, `s4-04-canary-${mode}`);
      await page.keyboard.press("Escape");
      await page.evaluate(() => (window.location.hash = "#/agents/models"));
      await expect(page.getByTestId("ag-models")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s4-06-models-${mode}`, true);
    });

    test(`dialogue QA: journal, card, re-evaluation, appeals, task (${mode})`, async ({ page }) => {
      await openAs(page, "methodist@tilhero.local", "#/qa", { ai: { qaDown: ["ai-gateway"] } });
      await setTheme(page, mode);
      await expect(page.locator('[data-testid^="qa-row-"]')).toHaveCount(7);
      await expectNoHScroll(page);
      await snap(page, `s4-07-qa-journal-${mode}`, true);
      await page.getByTestId(`qa-open-${SID.s1}`).click();
      await expect(page.getByTestId("qa-card")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s4-08-session-card-${mode}`, true);
      await page.getByTestId("qa-reeval").click();
      await expect(page.getByTestId("qa-reeval-drawer")).toBeVisible();
      await page.getByTestId("rv2-s-grammar").selectOption("2");
      await page.getByTestId("rv2-reason").fill("T3 выбрана из вариантов — это не ошибка ученика");
      await page.locator('[data-testid="qa-reeval-drawer"] .drawer-b').evaluate((el) => el.scrollTo(0, 0));
      await snap(page, `s4-09-reevaluation-${mode}`);
      await page.getByTestId("drawer-close").click();
      await page.getByTestId("qa-task").click();
      await page.getByTestId("qt-title").fill("Ложная коррекция выбранной реплики");
      await page.getByTestId("qt-expected").fill("Оценщик не исправляет реплики, выбранные из вариантов");
      await page.getByTestId("qt-actual").fill("Ошибка T3 засчитана как ошибка ученика");
      await snap(page, `s4-11-task-${mode}`);
      await page.getByTestId("drawer-close").click();
      await page.evaluate((id) => (window.location.hash = `#/qa/appeals/${id}`), AID.a1);
      await expect(page.getByTestId("ap-drawer")).toBeVisible();
      await snap(page, `s4-10-appeals-${mode}`);
    });

    test(`costs, emergency stop, overview (${mode})`, async ({ page }) => {
      await openAs(page, "ops@tilhero.local", "#/costs", { ai: { spentUsd: 17.2 } });
      await setTheme(page, mode);
      await expect(page.getByTestId("cs-bar")).toHaveAttribute("data-level", "warn");
      await page.locator('[data-testid^="cs-chart-bar-"]').nth(12).hover();
      await expectNoHScroll(page);
      await snap(page, `s4-12-costs-${mode}`, true);
      await page.getByTestId("cs-stop-btn").click();
      await page.getByTestId("cs-stop-dialog").locator("#cmd-reason").fill("Подозрение на утечку ключа");
      await snap(page, `s4-13a-emergency-confirm-${mode}`);
      await page.getByTestId("cs-stop-dialog").getByTestId("confirm-ok").click();
      await expect(page.getByTestId("stepup")).toBeVisible();
      await page.locator("#stepup-0").focus();
      await page.keyboard.type("123456");
      await expect(page.getByTestId("cs-stop")).toHaveAttribute("data-ai", "off");
      await page.evaluate(() => window.scrollTo(0, 0));
      await snap(page, `s4-13-emergency-stop-${mode}`);
      await page.evaluate(() => (window.location.hash = "#/overview"));
      await expect(page.getByTestId("block-lessons")).toBeVisible();
      await expectNoHScroll(page);
      await snap(page, `s4-14-overview-${mode}`, true);
    });
  });
}

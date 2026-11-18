/**
 * Screenshots of the key screens in both themes (SHOTS_DIR, default /tmp/admin-shots) — the visual check of the
 * TilHero prototype language: sign-in, overview, learner card, «Что нового» editor with the phone preview, a template,
 * a campaign. Also asserts that the screens render without horizontal page scroll.
 */
import { expect, test, type Page } from "@playwright/test";
import { expectNoHScroll, open, openAs, setTheme, shot } from "./helpers";
import * as F from "./fixtures/data";

const THEMES = ["light", "dark"] as const;

async function themed(page: Page, mode: (typeof THEMES)[number]) {
  await page.emulateMedia({ colorScheme: mode });
}

for (const mode of THEMES) {
  test.describe(`screenshots · ${mode}`, () => {
    test(`login (${mode})`, async ({ page }) => {
      await themed(page, mode);
      await open(page);
      await expect(page.getByTestId("login-creds")).toBeVisible();
      await shot(page, `01-login-${mode}`);
      await page.locator("#login-email").fill("admin@tilhero.local");
      await page.locator("#login-pass").fill(F.PASSWORD);
      await page.getByTestId("login-submit").click();
      await expect(page.getByTestId("login-mfa")).toBeVisible();
      await shot(page, `02-login-totp-${mode}`);
    });

    test(`overview (${mode})`, async ({ page }) => {
      await themed(page, mode);
      await openAs(page, "admin@tilhero.local", "#/overview");
      await setTheme(page, mode);
      await expect(page.getByTestId("block-learners")).toBeVisible();
      await expectNoHScroll(page);
      await shot(page, `03-overview-${mode}`, true);
    });

    test(`learner card (${mode})`, async ({ page }) => {
      await themed(page, mode);
      await openAs(page, "admin@tilhero.local", "#/users");
      await setTheme(page, mode);
      await expectNoHScroll(page);
      await page.getByTestId(`lr-open-${F.LEARNER.botir}`).click();
      await expect(page.getByTestId("learner-card")).toBeVisible();
      await expect(page.getByTestId("lc-children")).toBeVisible();
      await shot(page, `04-learner-${mode}`);
    });

    test(`whats new editor (${mode})`, async ({ page }) => {
      await themed(page, mode);
      await openAs(page, "admin@tilhero.local", "#/news/whatsnew");
      await setTheme(page, mode);
      await expect(page.getByTestId("wn-editor")).toBeVisible();
      await page.getByTestId("wn-new").click();
      await page.getByTestId("wn-title-ru").fill("Декабрь: голосовые уроки");
      await page.getByTestId("wn-it-title-0-ru").fill("Говорим вслух");
      await page.getByTestId("wn-it-text-0-ru").fill("Отвечайте герою голосом — он подскажет, если ошибётесь.");
      await page.getByTestId("wn-ic-0-mic").check({ force: true });
      await page.getByTestId("wn-lang-uz").click();
      await expect(page.getByTestId("wn-title-uz-missing")).toBeVisible();
      await shot(page, `05-whatsnew-editor-${mode}`, true);
      await page.getByTestId("pv-scheme").getByRole("button", { name: mode === "dark" ? /Тёмная|Dark/ : /Светлая|Light/ }).click();
      await page.getByTestId("wn-phone").screenshot({ path: `${process.env.SHOTS_DIR ?? "/tmp/admin-shots"}/06-whatsnew-phone-${mode}.png` });
    });

    test(`template (${mode})`, async ({ page }) => {
      await themed(page, mode);
      await openAs(page, "admin@tilhero.local", "#/news/templates");
      await setTheme(page, mode);
      await expect(page.getByTestId("tpl-editor")).toBeVisible();
      await expectNoHScroll(page);
      await page.getByTestId("tpl-body-ru").fill("В {slot_time} — {duration} английского. {bonus}");
      await expect(page.getByText(/\{bonus\}/).first()).toBeVisible();
      await shot(page, `07-template-${mode}`, true);
    });

    test(`campaign (${mode})`, async ({ page }) => {
      await themed(page, mode);
      await openAs(page, "admin@tilhero.local", "#/news/campaigns");
      await setTheme(page, mode);
      await expect(page.getByTestId("cmp-detail")).toBeVisible();
      await expectNoHScroll(page);
      await page.getByTestId("cmp-estimate-btn").click();
      await expect(page.getByTestId("cmp-est-audience")).toBeVisible();
      await shot(page, `08-campaign-${mode}`, true);
    });

    test(`support thread (${mode})`, async ({ page }) => {
      await themed(page, mode);
      await openAs(page, "admin@tilhero.local", "#/support/TCK-1043");
      await setTheme(page, mode);
      await expect(page.getByTestId("thread")).toBeVisible();
      await shot(page, `09-support-${mode}`);
    });
  });
}

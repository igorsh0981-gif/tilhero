import { expect, test, type Page } from "@playwright/test";
import { CYRILLIC, expectNoHScroll, openAs, setTheme, shot4 } from "./helpers";

/* Screenshots of the sprint-4 screens in the light and dark themes → apps/admin-web/shots/sprint4/. */

const R1 = "7e000000-0000-4000-8000-000000000001";

/** light and dark shot of the same state; `prepare` opens drawers/dialogs (the theme menu is unreachable under them), `cleanup` closes them */
async function both(page: Page, name: string, prepare: () => Promise<void>, cleanup?: () => Promise<void>) {
  for (const mode of ["light", "dark"] as const) {
    await setTheme(page, mode);
    await prepare();
    await shot4(page, `${name}-${mode}`);
    if (cleanup) await cleanup();
  }
}
const closeDrawer = (page: Page) => async () => {
  await page.getByTestId("drawer-close").click();
  await expect(page.locator(".drawer")).toHaveCount(0);
};

test.describe("width 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("review: list, card, correct form, reject dialog", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/review");
    await expect(page.getByTestId("review-table").locator("tbody tr")).toHaveCount(4);
    await expectNoHScroll(page);
    await both(page, "01-review-list", async () => undefined);
    await both(
      page,
      "02-review-card",
      async () => {
        await page.locator(`[data-review="${R1}"]`).click();
        await expect(page.getByTestId("rv-banner").locator("img")).toBeVisible();
        await expect.poll(() => page.getByTestId("rv-banner").locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth > 0)).toBe(true);
      },
      closeDrawer(page),
    );
    await setTheme(page, "light");
    await page.locator(`[data-review="${R1}"]`).click();
    await page.getByTestId("rv-correct").click();
    await page.locator("#rc-time").fill("20:00");
    await page.getByTestId("rc-basis").fill("http://iticket.uz/x");
    await page.getByTestId("rc-note").fill("Время на странице — 20:00");
    await page.getByTestId("rc-submit").click();
    await shot4(page, "03-review-correct-light");
    await page.getByRole("button", { name: "Отмена" }).first().click();
    await page.getByTestId("rv-reject").click();
    await page.getByTestId("rv-reject-code").selectOption("DUPLICATE");
    await shot4(page, "04-review-reject-light");
    await page.keyboard.press("Escape");
    await page.getByTestId("rv-accept").click();
    await shot4(page, "05-review-accept-light");
  });

  test("review: the candidate changed while the card was open; «Correct» with «was» values", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/review");
    await page.locator(`[data-review="${R1}"]`).click();
    await page.getByTestId("rv-correct").click();
    await page.locator("#rc-time").fill("20:00");
    await page.getByTestId("rc-note").fill("Время на странице — 20:00");
    await shot4(page, "03b-review-correct-was-light");
    bff.updateCandidate(R1, { title: "Шахзода. Большой сольный концерт (перенос)" });
    await page.getByTestId("rc-submit").click();
    await expect(page.getByTestId("rv-changed")).toBeVisible();
    await shot4(page, "07-review-changed-correct-light");
    await page.getByRole("button", { name: "Отмена" }).first().click();
    await expect(page.getByTestId("rv-changed")).toBeVisible();
    await shot4(page, "07b-review-changed-light");
  });

  test("review: empty queue", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/review", { emptyCatalog: true });
    await expect(page.getByTestId("rv-empty")).toBeVisible();
    await shot4(page, "06-review-empty-light");
  });

  test("sources: list, edit form, change log, create with step-up", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/sources");
    await expect(page.getByTestId("sources-table").locator("tbody tr")).toHaveCount(5);
    await expectNoHScroll(page);
    await expect(page.locator('[data-source="iticket-uz"]').getByTestId("src-crawl-cell")).toContainText("Найдено 14 событий");
    await both(page, "10-sources-list", async () => undefined);
    // fix 4.1: the «Last crawl» block on top of the card
    await both(
      page,
      "17-source-crawl",
      async () => {
        await page.locator('[data-source="iticket-uz"]').click();
        await expect(page.getByTestId("src-crawl")).toHaveAttribute("data-crawl", "ok");
      },
      closeDrawer(page),
    );
    await setTheme(page, "light");
    await page.locator('[data-source="ticketon-kz"]').click();
    await expect(page.getByTestId("src-crawl")).toHaveAttribute("data-crawl", "skipped");
    await shot4(page, "18-source-crawl-skipped-light");
    await page.getByTestId("drawer-close").click();
    await page.locator('[data-source="opera-am"]').click();
    await expect(page.getByTestId("src-crawl")).toHaveAttribute("data-crawl", "error");
    await shot4(page, "18b-source-crawl-error-light");
    await page.getByTestId("drawer-close").click();
    await both(
      page,
      "11-source-edit",
      async () => {
        await page.locator('[data-source="iticket-uz"]').click();
        await expect(page.getByTestId("src-form")).toBeVisible();
        await page.locator('label[for="sf-enabled"]').click();
        await page.getByTestId("sf-enable-ok").click();
        await page.getByTestId("sf-reason").fill("Сайт отдаёт 503 вторые сутки");
      },
      closeDrawer(page),
    );
    await setTheme(page, "light");
    await page.locator('[data-source="iticket-uz"]').click();
    await page.getByTestId("src-tab-log").click();
    await expect(page.getByTestId("src-log")).toBeVisible();
    await shot4(page, "12-source-log-light");
    await page.getByTestId("drawer-close").click();
    await page.getByTestId("src-add").click();
    await page.getByTestId("sf-name").fill("Kassir.kg");
    await page.getByTestId("sf-slug").fill("kassir-kg");
    await page.locator("#sf-ev").fill("kassir.kg");
    await page.locator("#sf-ev").press("Enter");
    await page.locator("#sf-media").fill("co.uk");
    await page.locator("#sf-media").press("Enter");
    await page.getByTestId("sf-page-add").click();
    await page.getByTestId("sf-page-url-0").fill("https://other.kg/afisha");
    await page.getByTestId("sf-submit").click();
    await shot4(page, "13-source-new-errors-light");
    await page.locator("#sf-media").fill("");
    await page.getByTestId("sf-page-url-0").fill("https://kassir.kg/afisha");
    await page.getByTestId("sf-reason").fill("Новый билетный оператор Бишкека");
    await page.getByTestId("sf-submit").click();
    await expect(page.getByTestId("stepup")).toBeVisible();
    await shot4(page, "14-source-stepup-light");
  });

  test("sources: crawl stats unavailable — «—» in the column, a note in the card", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/sources", { crawlDown: "unavailable" });
    await expect(page.getByTestId("src-crawl-cell").first()).toHaveText("—");
    await shot4(page, "19-sources-crawl-na-light");
    await page.locator('[data-source="iticket-uz"]').click();
    await expect(page.getByTestId("src-crawl")).toHaveAttribute("data-crawl", "na");
    await shot4(page, "19b-source-crawl-na-light");
  });

  test("sources: version conflict — draft kept, carried over to the new version", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/sources");
    await page.locator('[data-source="afisha-uz"]').click();
    await page.getByTestId("sf-name").fill("Afisha");
    await page.getByTestId("sf-reason").fill("Короткое имя");
    Object.assign(bff.sources.find((s) => s.slug === "afisha-uz")!, { version: 2, name: "Afisha Uzbekistan", updated_by: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a02" });
    await page.getByTestId("sf-submit").click();
    await expect(page.getByTestId("sf-conflict")).toBeVisible();
    await shot4(page, "15-source-conflict-light");
    await page.getByTestId("sf-apply-mine").click();
    await expect(page.getByTestId("sf-rebased")).toBeVisible();
    await shot4(page, "16-source-rebased-light");
  });

  test("event search: budget not loaded — kill switch state unknown; audit unavailable", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/discovery", { budgetDown: true, auditDown: true });
    await expect(page.getByTestId("dsc-kill-state")).toHaveText("Состояние неизвестно");
    await shot4(page, "24-discovery-state-unknown-light");
  });

  test("event search: budget, kill switch, runs, errors, run drawer", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/discovery", { running: true });
    await expect(page.getByTestId("dsc-spent")).toHaveText("$0.4213");
    await expectNoHScroll(page);
    await page.locator('[data-run="d1500000-0000-4000-8000-000000000001"]').getByRole("button", { name: /ошибки/ }).click();
    await both(page, "20-discovery", async () => undefined);
    await setTheme(page, "light");
    await page.getByTestId("dsc-pause").click();
    await page.getByTestId("dsc-pause-dialog").locator("textarea").fill("Модель отвечает с ошибками");
    await shot4(page, "21-discovery-pause-dialog-light");
    await page.keyboard.press("Escape");
    await both(
      page,
      "22-discovery-run",
      async () => {
        await page.locator('[data-run="d1500000-0000-4000-8000-000000000001"]').click();
        await expect(page.getByTestId("run-card")).toBeVisible();
      },
      closeDrawer(page),
    );
  });

  test("event search: paused, budget almost used up, start conflict", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/discovery", { paused: true, running: true });
    bff.budget = { ...bff.budget, spent_usd: "0.9312", reserved_usd: "0.0450", pages_used: 288 };
    await page.reload();
    await expect(page.getByTestId("dsc-spent")).toHaveText("$0.9312");
    await page.getByTestId("dsc-start").click();
    await page.getByTestId("dsc-start-ok").click();
    await expect(page.getByTestId("dsc-in-progress")).toBeVisible();
    await both(page, "23-discovery-paused", async () => undefined);
  });

  test("EN: the new screens have no Russian interface text", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/review");
    await page.getByTestId("lang-en").click();
    for (const p of ["review", "sources", "discovery"] as const) {
      await page.locator(`[data-nav="${p}"]`).click();
      await expect(page.getByTestId(`page-${p}`)).toBeVisible();
      await page.waitForTimeout(300);
      const text = await page.evaluate(() => {
        const clone = document.body.cloneNode(true) as HTMLElement;
        // data from sources (titles, notes, staff names, error scopes) is not translated
        clone.querySelectorAll(".cell-main, .cell-sub, .avatar, .wrap-any, .kv dd").forEach((n) => n.remove());
        return clone.innerText;
      });
      expect(text, `${p}: ${text.match(/.{0,30}[Ѐ-ӿ]+.{0,30}/)?.[0]}`).not.toMatch(CYRILLIC);
      if (p === "review") await shot4(page, "30-review-en-light");
      if (p === "sources") await shot4(page, "32-sources-en-light");
      if (p === "discovery") await shot4(page, "31-discovery-en-light");
    }
  });
});

test.describe("width 400", () => {
  test.use({ viewport: { width: 400, height: 860 }, hasTouch: true });
  test("no horizontal scroll on the three screens and their drawers", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/review");
    await expect(page.getByTestId("review-table")).toBeVisible();
    await expectNoHScroll(page);
    await shot4(page, "40-w400-review-light");
    await page.locator(`[data-review="${R1}"]`).click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    await expectNoHScroll(page);
    await shot4(page, "41-w400-review-card-light");
    await page.getByTestId("drawer-close").click();
    for (const p of ["sources", "discovery"] as const) {
      await page.getByTestId("burger").click();
      await page.locator(`[data-nav="${p}"]`).click();
      await expect(page.getByTestId(`page-${p}`)).toBeVisible();
      await page.waitForTimeout(300);
      await expectNoHScroll(page);
      await shot4(page, `4${p === "sources" ? 2 : 4}-w400-${p}-light`);
    }
    await page.getByTestId("burger").click();
    await page.locator('[data-nav="sources"]').click();
    await page.locator('[data-source="iticket-uz"]').click();
    await expect(page.getByTestId("src-form")).toBeVisible();
    await expectNoHScroll(page);
    await shot4(page, "43-w400-source-form-light");
  });

  test("source card: «Last crawl» with page warnings fits 400 px in both themes", async ({ page }) => {
    // the theme menu is in the top bar, unreachable under the drawer at 400 px: the theme follows the system one
    await openAs(page, "admin@tilhero.local", "#/sources");
    await page.locator('[data-source="iticket-uz"]').click();
    await expect(page.getByTestId("crawl-notes").locator("li")).toHaveCount(2);
    await page.getByTestId("crawl-skips").scrollIntoViewIfNeeded();
    await expectNoHScroll(page);
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await shot4(page, `45-w400-source-crawl-notes-${mode}`);
    }
  });
});

import { expect, test, type Page } from "@playwright/test";
import { expectNoHScroll, openAs, shot } from "./helpers";

/**
 * 9.4 «Конфигурация интерфейса» → «Что нового»: сид-черновик «Ноябрь 2026», правка → сохранение → публикация с
 * подтверждением и причиной (аудит), превью шторки в рамке телефона, только чтение без config.edit, ширина 400 px.
 */
const SEED = "5b2c1a7e-0d3f-5e6a-9b8c-2026110000aa";

async function openTab(page: Page): Promise<void> {
  await page.getByTestId("cfg-tab-whats-new").click();
  await expect(page.getByTestId("wn-config")).toBeVisible();
}

test.describe("width 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("черновик «Ноябрь 2026»: правка, сохранение, публикация с причиной; затем только архив и «Новая на основе»", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/config");
    await openTab(page);
    await expect(page.getByTestId("wn-row-2026.11")).toContainText("черновик");
    await expect(page.getByTestId("wn-editor")).toContainText("Черновик 2026.11");
    const preview = page.getByTestId("wn-preview");
    await expect(preview).toContainText("Что нового в TilHero");
    await expect(preview).toContainText("Больше событий в Алматы");
    await shot(page, "94-whats-new-light");

    // превью EN и тёмная тема телефона
    await preview.getByRole("button", { name: "EN" }).click();
    await expect(preview).toContainText("What's new in TilHero");
    await expect(preview).toContainText("More events in Almaty");

    // правка → публикация недоступна до сохранения
    await page.getByTestId("wn-item-0-title-ru").fill("Больше событий в Алматы и Астане");
    await expect(page.getByTestId("wn-publish")).toBeDisabled();
    await page.getByTestId("wn-save").click();
    await expect(page.getByTestId("toasts")).toContainText("Черновик 2026.11 сохранён");
    const put = bff.calls("PUT", `/release-notes/${SEED}`)[0]!;
    expect(put.body).toMatchObject({ expected_version: 1, slug: "2026.11" });
    expect(put.headers["x-csrf-token"]).toBeTruthy();

    await page.getByTestId("wn-publish").click();
    const dlg = page.getByTestId("wn-confirm");
    await expect(dlg).toContainText("Опубликовать «Ноябрь 2026»?");
    await shot(page, "94-whats-new-confirm");
    await dlg.locator("textarea").fill("Релиз ноября");
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toasts")).toContainText("Заметка 2026.11 опубликована");
    const pub = bff.calls("POST", `/release-notes/${SEED}/publish`)[0]!;
    expect(pub.body).toEqual({ expected_version: 2, reason: "Релиз ноября" });
    expect(pub.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByTestId("wn-row-2026.11")).toContainText("опубликована");
    await expect(page.getByTestId("wn-editor")).toContainText("изменить нельзя");
    await expect(page.getByTestId("wn-save")).toHaveCount(0);
    await expect(page.getByTestId("wn-item-0-title-ru")).toBeDisabled();

    // «Новая на основе» → новый черновик с текстом опубликованной
    await page.getByTestId("wn-copy").click();
    await expect(page.getByTestId("wn-editor")).toContainText("Новая заметка");
    await expect(page.getByTestId("wn-item-0-title-ru")).toHaveValue("Больше событий в Алматы и Астане");

    // тёмная тема админки
    await page.getByTestId("theme-btn").click();
    await page.getByTestId("theme-dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await shot(page, "94-whats-new-dark");
  });

  test("operations (только config.read): только чтение, команды заблокированы", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/config");
    await openTab(page);
    await expect(page.getByTestId("wn-editor")).toBeVisible();
    await expect(page.getByTestId("wn-title-ru")).toBeDisabled();
    await expect(page.getByTestId("wn-save")).toHaveCount(0);
    await expect(page.getByTestId("wn-publish")).toHaveClass(/is-locked/);
    await expect(page.getByTestId("wn-new")).toHaveClass(/is-locked/);
    await page.getByTestId("wn-publish").click({ force: true }); // aria-disabled: только тост «нужно право»
    await expect(page.getByTestId("toasts")).toContainText("config.publish");
    await expect(page.getByTestId("wn-confirm")).toHaveCount(0);
    expect(bff.calls("POST", `/release-notes/${SEED}/publish`)).toHaveLength(0);
  });
});

test.describe("width 400", () => {
  test.use({ viewport: { width: 400, height: 860 }, hasTouch: true });

  test("без горизонтальной прокрутки: список, редактор (RU/EN в столбик), превью под редактором", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/config");
    await openTab(page);
    await expect(page.getByTestId("wn-editor")).toBeVisible();
    await expectNoHScroll(page);
    const ru = await page.getByTestId("wn-title-ru").boundingBox();
    const en = await page.getByTestId("wn-title-en").boundingBox();
    expect(en!.y).toBeGreaterThan(ru!.y + ru!.height - 1); // поля RU/EN одно под другим
    await shot(page, "w400-whats-new");
    await page.getByTestId("wn-preview").scrollIntoViewIfNeeded();
    await expectNoHScroll(page);
    await shot(page, "w400-whats-new-preview");
    // новая заметка: добавить пункт — всё ещё без прокрутки вбок
    await page.getByTestId("wn-new").click();
    await page.getByTestId("wn-add-item").click();
    await expectNoHScroll(page);
  });
});

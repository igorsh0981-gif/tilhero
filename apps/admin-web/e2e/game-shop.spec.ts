/**
 * Sprint 6 «Геймификация → Магазин» (ADM-GAME-05 LinguaFlow, AT-69): the list by status with owners; a new cosmetic
 * item as a draft (Idempotency-Key), its publication with step-up; a published item allows only the end of sale and
 * the order; retirement keeps what owners bought; the freeze is priced by the rules; roles without the rights.
 */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";

test("list: statuses, prices, owners; the freeze comes from the rules and is read only", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/game/shop");
  await expect(page.getByTestId("sh-rows").locator("tbody tr")).toHaveCount(4);
  await expect(page.getByTestId("sh-owners-bg_night_notebook")).toHaveText("12");
  await page.getByTestId("sh-status").getByRole("button", { name: /снят с продажи/ }).click();
  await expect(page.getByTestId("sh-rows").locator("tbody tr")).toHaveCount(1);
  await page.getByTestId("sh-status").getByRole("button", { name: /Все/ }).click();
  await page.getByTestId("sh-open-streak_freeze").click();
  await expect(page.getByTestId("sh-freeze-note")).toContainText("40 тилов");
  await expect(page.getByTestId("sh-save")).toHaveCount(0);
  await expect(page.getByTestId("sh-price")).toBeDisabled();
});

test("a new background: checks, a draft with Idempotency-Key, publication with step-up", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/game/shop");
  await page.getByTestId("sh-new").click();
  await expect(page.getByTestId("sh-form")).toHaveAttribute("data-mode", "create");
  await page.getByTestId("sh-save").click();
  await expect(page.getByTestId("sh-err")).toContainText("Исправьте ошибки в форме");
  await expect(page.getByTestId("sh-form")).toContainText("Код: латиница, цифры и «_», 3–40 символов");
  await page.getByTestId("sh-code").fill("bg_mint");
  await page.getByTestId("sh-title-ru").fill("Мятная тетрадь");
  await page.getByTestId("sh-title-uz").fill("Мятная");
  await expect(page.getByTestId("sh-form")).toContainText("Узбекский текст — латиницей");
  await page.getByTestId("sh-title-uz").fill("Yalpiz daftar");
  // the description is required in both languages (admin-bff)
  await expect(page.getByTestId("sh-form")).toContainText("Описание");
  await page.getByTestId("sh-desc-ru").fill("Фон главной в мятную клетку");
  await page.getByTestId("sh-desc-uz").fill("Bosh sahifa uchun yalpiz katakli fon");
  // the background only from light tokens, the accent only from saturated ones; the preview in Mini App colours
  const bgs = await page.getByTestId("sh-bg").locator("option").allTextContents();
  expect(bgs).toEqual(["--paper", "--card", "--grid", "--mark", "--margin", "--pen-soft", "--ok-soft", "--warn-soft", "--err-soft"]);
  expect(await page.getByTestId("sh-accent").locator("option").allTextContents()).toEqual(["--pen", "--ink", "--ink2", "--ok", "--warn", "--err"]);
  await page.getByTestId("sh-bg").selectOption("--ok-soft");
  await page.getByTestId("sh-accent").selectOption("--ok");
  await expect(page.getByTestId("sh-swatch")).toHaveAttribute("data-bg", "#E3F3EA");
  await expect(page.getByTestId("sh-swatch")).toHaveAttribute("data-accent", "#1E7A4F");
  await expect(page.getByTestId("sh-swatch")).toHaveCSS("background-color", "rgb(227, 243, 234)");
  await page.getByTestId("sh-price").fill("150");
  await page.getByTestId("sh-audiences-kids").uncheck();
  await page.getByTestId("sh-save").click();
  await expect(page.getByText("Создан черновик bg_mint")).toBeVisible();
  const post = bff.calls("POST", "/game/shop/items")[0]!;
  expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(post.body).toMatchObject({ code: "bg_mint", kind: "background", description: { ru: "Фон главной в мятную клетку", uz: "Bosh sahifa uchun yalpiz katakli fon" }, theme: { bg: "--ok-soft", accent: "--ok" }, asset_id: null, price_til: 150, audiences: ["teens", "adults"] });
  await expect(page.getByTestId("sh-item-status")).toHaveText("черновик");

  await page.getByTestId("sh-publish").click();
  const dlg = page.getByTestId("sh-cmd-dialog");
  await expect(dlg).toContainText("по цене 150 тилов");
  await dlg.locator("#cmd-reason").fill("Новый фон к весне");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Предмет bg_mint в продаже")).toBeVisible();
  await expect(page.getByTestId("sh-item-status")).toHaveText("опубликован");
  await expect(page.getByTestId("sh-form")).toHaveAttribute("data-mode", "published");
  expect(bff.game.audit.map((a) => a.action)).toEqual(["game.shop_item_created", "game.shop_item_published"]);
});

test("a published item: only the end of sale and the order change; retirement keeps the owners' items", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/game/shop/bg_night_notebook");
  await expect(page.getByTestId("sh-published-note")).toBeVisible();
  await expect(page.getByTestId("sh-price")).toBeDisabled();
  await expect(page.getByTestId("sh-title-ru")).toBeDisabled();
  await expect(page.getByTestId("sh-from")).toBeDisabled();
  await page.getByTestId("sh-order").fill("5");
  await page.getByTestId("sh-until").fill("2026-12-31T23:00");
  await page.getByTestId("sh-save").click();
  await expect(page.getByText("Предмет bg_night_notebook сохранён")).toBeVisible();
  const patch = bff.calls("PATCH", "/game/shop/items/bg_night_notebook")[0]!;
  expect(Object.keys(patch.body as object).sort()).toEqual(["available_until", "order"]);

  await page.getByTestId("sh-retire").click();
  const dlg = page.getByTestId("sh-cmd-dialog");
  await expect(dlg).toContainText("У владельцев (12) он останется");
  await dlg.locator("#cmd-reason").fill("Сезон закончился");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByTestId("sh-retired-note")).toContainText("12");
  await expect(page.getByTestId("sh-item-owners")).toContainText("12");
  await expect(page.getByTestId("sh-save")).toHaveCount(0);
});

test("content manager edits drafts but does not publish", async ({ page }) => {
  await openAs(page, "content@tilhero.local", "#/game/shop/frame_gold");
  await expect(page.getByTestId("sh-save")).toBeVisible();
  await expect(page.getByTestId("sh-publish")).toHaveCount(0);
  await expect(page.getByTestId("sh-upload")).toBeAttached();
  await expect(page.getByLabel("Загрузить картинку предмета", { exact: true })).toHaveAttribute("data-testid", "sh-upload");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sh-new")).toBeVisible();
});

test("support only reads the shop", async ({ page }) => {
  await openAs(page, "support@tilhero.local", "#/game/shop/frame_gold");
  await expect(page.getByTestId("sh-item-ro")).toBeVisible();
  await expect(page.getByTestId("sh-save")).toHaveCount(0);
  await expect(page.getByTestId("sh-publish")).toHaveCount(0);
  await expect(page.getByTestId("sh-upload")).toHaveCount(0);
  await expect(page.getByTestId("sh-new")).toHaveCount(0);
  await expect(page.getByTestId("sh-ro")).toContainText("game.manage");
});

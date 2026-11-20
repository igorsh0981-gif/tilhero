/**
 * Sprint 6 permissions of «Игра» (PLAN «Права и роли»): without game.read the sections are not in the menu and do
 * not open by link; game.read without game.manage / game.publish / wallet.adjust — reading only, the command buttons
 * are not offered; a role with game.manage edits drafts but does not publish; a direct request the server refuses
 * answers with a text naming the permission; the learner card shows the «Игра» tab only with game.read. Plus the EN
 * chrome of the game screens and the overview block.
 */
import { expect, test } from "@playwright/test";
import { openAs } from "./helpers";
import { LEARNER, MATRIX } from "./fixtures/data";

const menu = async (page: import("@playwright/test").Page) => page.locator("[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav")));

test("without game.read: no game sections in the menu; a link is refused with a toast; the learner card has no «Игра» tab", async ({ page }) => {
  await openAs(page, "comms@tilhero.local", "#/overview");
  const ids = await menu(page);
  for (const x of ["heroes", "game", "events"]) expect(ids).not.toContain(x);
  await page.evaluate((id) => (window.location.hash = `#/game/wallets/${id}`), LEARNER.madina);
  await expect(page.getByText("Раздел «Геймификация» недоступен для вашей роли")).toBeVisible();
  await expect(page.getByTestId("page-overview")).toBeVisible();
});

test("support without game.read (matrix changed): the learner card has no «Игра» tab", async ({ page }) => {
  await openAs(page, "support@tilhero.local", `#/users/${LEARNER.madina}`, { matrix: { support: MATRIX.support.filter((p) => p !== "game.read") } });
  await expect(page.getByTestId("lc-tab-account")).toBeVisible();
  await expect(page.getByTestId("lc-tab-game")).toHaveCount(0);
  expect(await menu(page)).not.toContain("game");
});

test("game.read only (support): heroes, rules, shop, events and wallets are read-only", async ({ page }) => {
  await openAs(page, "support@tilhero.local", "#/heroes/pet_0");
  // without game.manage the card opens on the comparison; the draft tab is read-only
  await expect(page.getByTestId("hrd-tab-compare")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("hr-cmp-none")).toBeVisible();
  await page.getByTestId("hrd-tab-draft").click();
  await expect(page.getByTestId("hr-ro")).toBeVisible();
  await expect(page.getByTestId("hr-save")).toHaveCount(0);
  await expect(page.getByTestId("hr-publish")).toHaveCount(0);
  await expect(page.getByTestId("hr-upload-1")).toHaveCount(0);
  await expect(page.getByTestId("hr-name-ru")).toBeDisabled();
  await expect(page.getByTestId("hr-gate")).toContainText("game.manage");
  await page.evaluate(() => (window.location.hash = "#/game/rules"));
  await expect(page.getByTestId("gr-new-draft")).toHaveCount(0);
  await page.evaluate(() => (window.location.hash = "#/events"));
  await expect(page.getByTestId("ev-new")).toHaveCount(0);
  await page.evaluate((id) => (window.location.hash = `#/game/wallets/${id}`), LEARNER.madina);
  await expect(page.getByTestId("wl-ro")).toBeVisible();
  await expect(page.getByTestId("wl-adjust")).toHaveCount(0);
});

test("game.manage without game.publish (content manager): saves a hero draft, cannot publish; no wallet commands", async ({ page }) => {
  const bff = await openAs(page, "content@tilhero.local", "#/heroes/human_1");
  await page.getByTestId("hr-tagline-ru").fill("Не боится ошибок и спрашивает");
  await page.getByTestId("hr-save").click();
  await expect(page.getByText("Черновик героя сохранён")).toBeVisible();
  await expect(page.getByTestId("hr-publish")).toHaveCount(0);
  await expect(page.getByTestId("hr-gate")).toContainText("game.publish");
  expect(bff.calls("PUT", "/game/heroes/human_1/draft")).toHaveLength(1);
  await page.evaluate(() => (window.location.hash = "#/game/rules"));
  await page.getByTestId("gr-new-draft").click();
  await expect(page.getByTestId("gr-save")).toBeVisible();
  await expect(page.getByTestId("gr-activate")).toHaveCount(0);
  await expect(page.getByTestId("gr-notes")).toContainText("game.publish");
});

test("a direct request the server refuses (the domain re-checks): the hero publication says which permission is missing", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/heroes/robot_2", { deny: { "POST /game/heroes/robot_2/publish": "game.publish" } });
  await page.getByTestId("hr-tagline-ru").fill("Лёгкий, как весенний ветер");
  await page.getByTestId("hr-save").click();
  await expect(page.getByText("Черновик героя сохранён")).toBeVisible();
  await page.getByTestId("hr-publish").click();
  const dlg = page.getByTestId("hr-publish-dialog");
  await dlg.locator("#cmd-reason").fill("Новый слоган робота Бриза");
  await dlg.getByTestId("confirm-ok").click();
  await expect(dlg).toContainText("Недостаточно прав: нужно право game.publish");
});

test("a read refused by the server shows a locked block naming game.read, not an empty screen", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/heroes", { deny: { "GET /game/heroes": "game.read" } });
  await expect(page.getByTestId("load-denied")).toContainText("game.read");
});

test("EN: the chrome of the game screens has no Russian (heroes' names and titles are data, marked lang=ru)", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/heroes");
  await expect(page.getByTestId("heroes")).toBeVisible();
  await page.getByTestId("lang-en").click();
  await expect(page.locator('[data-nav="heroes"]')).toHaveText(/Heroes/);
  const chrome = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[role=tab], .acts button, label, th, .h2, .h3, .panel-t, .kv > span:first-child, .pill, legend, .field-label, .callout, .btn"))
        .filter((e) => !e.closest('[lang="ru"]') && !e.querySelector('[lang="ru"]'))
        .map((e) => e.innerText.trim())
        .filter((x) => /[Ѐ-ӿ]/.test(x)),
    );
  for (const [hash, id] of [
    ["#/heroes", "heroes"],
    ["#/heroes/pet_0", "hr-editor"],
    ["#/game/overview", "go-kpis"],
    ["#/game/rules", "gr-form"],
    ["#/game/shop", "sh-rows"],
    [`#/game/wallets/${LEARNER.madina}`, "wl-led-rows"],
    ["#/events", "ev-rows"],
  ] as const) {
    await page.evaluate((h) => (window.location.hash = h), hash);
    await expect(page.getByTestId(id)).toBeVisible();
    await page.waitForTimeout(250);
    expect(await chrome(), hash).toEqual([]);
  }
});

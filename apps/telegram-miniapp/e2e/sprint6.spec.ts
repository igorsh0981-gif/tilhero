import { expect, test, type Page } from "@playwright/test";
import * as F from "./fixtures/data";
import type { GameScenario } from "./fixtures/game";
import type { Scenario } from "./fixtures/mock-bff";
import { installSpeech } from "./fixtures/speech";
import { CYRILLIC, open, settle, SHOTS } from "./helpers";

/**
 * Sprint 6 on the mock BFF: Home with the game (the hero and its stage, the level and the XP bar, tils, the streak with
 * freezes — a day closed by a freeze in the week, quests of the day, an event of the week) and without it
 * (GAME_UNAVAILABLE — no block, learning works); the choice of a hero (nine, three stages, «за что растёт»; the change
 * keeps XP) from Home and in onboarding after the plan (skippable); the shop (a purchase with an Idempotency-Key, not
 * enough tils, the repeat of a lost answer, «Надеть»); the history of the ledger (reasons, «Корректировка поддержки»,
 * a filter by currency, pages); badges (the basis, the progress); the rewards after a lesson and a reading (pending →
 * ready); the motivation settings; a child (dragons first, soft texts, quiet celebrations); accessibility (keyboard,
 * labels, not colour only, reduced motion); UZ.
 */
const ALL_SEEN = [F.WELCOME.id, F.UPDATE_1.id, F.UPDATE_2.id];
/** Friday: the week Mon 16 … Sun 22 November 2026; the plan of an onboarded learner — Mon, Wed, Fri */
const WEEK: Scenario = { fixedToday: "2026-11-20", doneDays: ["2026-11-16"], frozenDays: ["2026-11-18"] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** null — the BFF without the game (503 GAME_UNAVAILABLE on /v1/game/*) */
async function start(page: Page, game: GameScenario | null = {}, sc: Scenario = {}) {
  await installSpeech(page);
  return open(page, { onboarded: true, seen: ALL_SEEN, content: { diag: "completed" }, ...(game ? { game } : {}), ...sc });
}

/** A screenshot with the element scrolled into view (the app scrolls inside .scroll). */
async function shotOf(page: Page, testId: string, name: string) {
  await page.getByTestId(testId).scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Home → «Практика» → the scenario «Заказ в кафе» played to success → its summary right after the player (fresh). */
async function finishScenario(page: Page) {
  await page.getByTestId("tab-home").click();
  await page.getByTestId("home-practice").click();
  await page.getByTestId("sc-sc-cafe-order").click();
  await page.getByTestId("sc-play").click();
  await expect(page.getByTestId("pl-roleplay")).toBeVisible();
  await page.getByTestId("rp-choice-c1").click();
  await expect(page.getByTestId("rp-ch").last()).toContainText("Sure! Anything else?");
  await page.getByTestId("rp-choice-c3").click();
  await expect(page.getByTestId("pl-outcome")).toHaveAttribute("data-outcome", "success");
  await page.getByTestId("pl-next").click();
  await page.getByTestId("pl-finish").click();
  await expect(page.getByTestId("summary")).toBeVisible();
}

/** Back from pushed screens (a summary, the practice) to the tabs. */
async function toTabs(page: Page) {
  for (let i = 0; i < 6 && !(await page.getByTestId("tab-lessons").isVisible()); i++) await page.getByTestId("bar-back").click();
  await expect(page.getByTestId("tab-lessons")).toBeVisible();
}

/** A child: «Практика» → «Чтение» → «Мой кот» (one question) → its summary right after the player (fresh). */
async function finishKidReading(page: Page) {
  await page.getByTestId("tab-home").click();
  await page.getByTestId("home-practice").click();
  await page.getByTestId("pr-tabs").getByRole("button", { name: "Чтение" }).click();
  await page.getByTestId("rd-rd-kids-cat").click();
  await page.getByTestId("rd-start").click();
  await expect(page.getByTestId("pl-reading")).toBeVisible();
  await page.getByTestId("pl-next").click();
  await page.getByTestId("pl-opt-1").click();
  await page.getByTestId("pl-answer").click();
  await page.getByTestId("pl-finish").click();
  await expect(page.getByTestId("summary")).toBeVisible();
}

/** No Cyrillic in the UZ interface (the learner's own name «Азиз» is data, not the interface); the offending fragments
 *  go to the message. */
async function expectLatin(page: Page) {
  const text = (await page.locator(".app").innerText()).replaceAll("Азиз", "");
  expect(text.match(/.{0,24}[Ѐ-ӿ]+.{0,24}/g)).toBeNull();
  expect(CYRILLIC.test(text)).toBe(false);
}

/** The in-app confirmation (outside Telegram the popup is drawn by the app). */
async function confirm(page: Page, ok = "Купить") {
  const dlg = page.getByRole("alertdialog");
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: ok, exact: true }).click();
  await expect(dlg).toBeHidden();
}

test.describe("главная: игровой блок", () => {
  test("герой, уровень и XP, тилы, серия с заморозками (снежинка в неделе), задания дня, событие недели", async ({ page }) => {
    const bff = await start(page, { event: true }, WEEK);
    const card = page.getByTestId("game-card");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("game-hero-name")).toHaveText("Робот Вольт · «Сборка»");
    await expect(page.getByTestId("game-stage")).toHaveText("Ступень 1 из 3");
    await expect(page.getByTestId("game-next-stage")).toHaveText("До следующей ступени — ещё 2 подтверждённых навыка");
    // the level by the thresholds of the rules: 120 XP → level 2 (100…250)
    await expect(page.getByTestId("game-level-n")).toHaveText("Уровень 2");
    await expect(page.getByTestId("game-xp-text")).toHaveText("20 из 150 XP · до уровня 3 — 130 XP");
    const bar = page.getByTestId("game-xp-bar");
    await expect(bar).toHaveAttribute("aria-valuenow", "20");
    await expect(bar).toHaveAttribute("aria-valuemax", "150");
    await expect(bar).toHaveAttribute("aria-label", "Опыт уровня 2");
    await expect(page.getByTestId("game-tils")).toHaveText("85 тилов");
    await expect(page.getByTestId("game-freezes")).toHaveAttribute("aria-label", "Заморозки серии: 2 из 5");
    // the streak with the stock of freezes on top
    await expect(page.getByTestId("home-freezes")).toHaveText("2 из 5");
    // the art of the stage from the catalogue (GET /v1/game/assets/{id}/{sha256})
    const img = page.getByTestId("game-hero").locator("img");
    await expect(img).toHaveAttribute("data-src-kind", "catalogue");
    await expect(img).toHaveAttribute("src", /\/__bff\/v1\/game\/assets\/as-robot_0-1\/[0-9a-f]{64}$/);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
    await expect(img).toHaveAttribute("alt", "Робот Вольт, ступень «Сборка»");

    // the week: Wednesday missed but closed by a freeze — its own state, a snowflake and words, not colour only
    const wed = page.locator('.week li[data-state="frozen"]');
    await expect(wed).toHaveCount(1);
    await expect(wed).toHaveAttribute("aria-label", "среда: пропуск закрыт заморозкой, серия сохранена");
    await expect(wed.locator("svg")).toHaveCount(1);
    await expect(page.locator('.week li[data-state="done"]')).toHaveAttribute("aria-label", "понедельник: занятие было");
    await expect(page.getByTestId("frozen-legend")).toContainText("пропуск закрыт заморозкой");

    // quests of the day: progress in words next to every bar, a done one says «выполнено»
    const quests = page.getByTestId("game-quests");
    await expect(quests.locator("li")).toHaveCount(3);
    await expect(page.getByTestId("quest-lesson_1")).toContainText("Пройти урок");
    await expect(page.getByTestId("quest-review_10")).toContainText("Повторить 10 карточек");
    await expect(page.getByTestId("quest-review_10-progress")).toHaveText("4 из 10");
    await expect(page.getByTestId("quest-reading_1")).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId("quest-reading_1-progress")).toHaveText("✓ выполнено");
    await expect(page.getByTestId("game-quests-bonus")).toHaveText("Все три — ещё бонус: +10 XP · +10 тилов");
    await expect(quests).toContainText("Без штрафов");
    await expect(page.getByTestId("game-events")).toContainText("Неделя чтения ×2 XP");
    expect(bff.calls("GET", "/v1/game/summary").length).toBeGreaterThan(0);
    await shotOf(page, "frozen-legend", "46_home_week_frozen");
    await shotOf(page, "game-card", "35_home_game");
    await shotOf(page, "game-quests", "36_home_quests");
  });

  test("без игры (503 GAME_UNAVAILABLE): блока нет, баннера «Нет связи» нет, учёба работает", async ({ page }) => {
    const bff = await start(page, null, { ...WEEK, lessons: { evaluatedDaysAgo: 2 } });
    await expect(page.getByTestId("today-card")).toBeVisible();
    await expect.poll(() => bff.calls("GET", "/v1/game/summary").length).toBeGreaterThan(0);
    await expect(page.getByTestId("game-card")).toHaveCount(0);
    await expect(page.getByTestId("home-freezes")).toHaveCount(0);
    await expect(page.getByTestId("offline")).toHaveCount(0);
    // the week still tells the frozen day (learning-plan), the rest of Home works
    await expect(page.locator('.week li[data-state="frozen"]')).toHaveCount(1);
    await page.getByTestId("start-lesson").click();
    await expect(page.getByTestId("lesson-card")).toBeVisible();
    await page.getByTestId("bar-back").click();
    // a session just finished: the rewards are asked once, GAME_UNAVAILABLE — no block, nothing else is asked
    await finishScenario(page);
    await expect.poll(() => bff.calls("GET", "/v1/game/rewards").length).toBeGreaterThan(0);
    await expect(page.getByTestId("rw")).toHaveCount(0);
    expect(bff.calls("GET", "/v1/game/settings")).toHaveLength(0);
    await page.getByTestId("sm-done").click();
    await toTabs(page);
    // the summary of a past lesson from the history: no rewards, no request
    const asked = bff.calls("GET", "/v1/game/rewards").length;
    await page.getByTestId("tab-lessons").click();
    await page.getByTestId("ls-history").getByRole("button").last().click();
    await expect(page.getByTestId("sm-scores")).toBeVisible();
    await page.waitForTimeout(500);
    expect(bff.calls("GET", "/v1/game/rewards")).toHaveLength(asked);
    await expect(page.getByTestId("rw")).toHaveCount(0);
    // the profile: no game section
    await page.getByTestId("bar-back").click();
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("row-schedule")).toBeVisible();
    await expect(page.getByTestId("profile-game")).toHaveCount(0);
    await expect(page.getByTestId("offline")).toHaveCount(0);
    await page.getByTestId("tab-home").click();
    await shotOf(page, "frozen-legend", "49_home_no_game");
  });

  test("игра выключена флагом Remote Experience Config: ни блока, ни запросов", async ({ page }) => {
    const bff = await start(page, {}, { config: { ...F.CONFIG, flags: { ...F.CONFIG.flags, game: false } } });
    await expect(page.getByTestId("today-card")).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("game-card")).toHaveCount(0);
    expect(bff.calls("GET", "/v1/game/summary")).toHaveLength(0);
  });
});

test.describe("выбор героя", () => {
  test("нет героя → приглашение → 9 героев, три ступени, «за что растёт» → выбор; смена не обнуляет XP", async ({ page }) => {
    const bff = await start(page, { hero: null, skills: 6, stage: 2 });
    await expect(page.getByTestId("game-invite")).toContainText("Выберите героя");
    await page.getByTestId("game-choose-hero").click();
    await expect(page.getByTestId("heroes")).toBeVisible();
    await expect(page.locator(".hero-tile")).toHaveCount(9);
    // adults: the catalogue order — robots, dragons, students
    await expect(page.locator(".hero-grid").first()).toHaveAttribute("data-testid", "hero-line-robot");
    await expect(page.getByRole("heading", { name: "Дракончики" })).toBeVisible();
    await page.getByTestId("hero-pet_1").click();
    await expect(page.getByTestId("hero-pet_1")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("hero-robot_0")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("hero-detail-name")).toHaveText("Дракончик Персик");
    const stages = page.getByTestId("hero-stages");
    await expect(stages.locator("li")).toHaveCount(3);
    await expect(page.getByTestId("hero-stage-1")).toContainText("Яйцо");
    await expect(page.getByTestId("hero-stage-1")).toContainText("сразу");
    await expect(page.getByTestId("hero-stage-2")).toContainText("Малыш");
    await expect(page.getByTestId("hero-stage-2")).toContainText("от 5 навыков");
    await expect(page.getByTestId("hero-stage-2")).toContainText("сейчас");
    await expect(page.getByTestId("hero-stage-3")).toContainText("от 15 навыков");
    await expect(page.getByTestId("hero-detail")).toContainText("Ступени роста — за подтверждённые навыки");
    await expect(page.getByTestId("hero-stage-1")).toContainText("пройдена");
    await expect(page.getByTestId("hero-grows")).toContainText("тилы, покупки и опыт рост не ускоряют");
    await expect(page.getByTestId("hero-detail").locator("img").first()).toHaveAttribute("alt", "Дракончик Персик, ступень «Яйцо»");
    await shotOf(page, "hero-detail", "37_hero_picker");
    await page.getByTestId("hero-choose").click();
    await expect(page.getByTestId("toast")).toHaveText("Ваш герой — Дракончик Персик");
    expect(bff.last("PUT", "/v1/game/hero")?.body).toEqual({ hero_code: "pet_1" });
    // back on Home with the hero of the common stage (2 — «Малыш»), XP unchanged
    await expect(page.getByTestId("game-hero-name")).toHaveText("Дракончик Персик · «Малыш»");
    await expect(page.getByTestId("game-next-stage")).toHaveText("До следующей ступени — ещё 9 подтверждённых навыков");
    const xp = await page.getByTestId("game-xp-text").textContent();
    // the change: free, the level and the stage stay
    await page.getByTestId("game-change-hero").click();
    await expect(page.getByTestId("hero-pet_1")).toHaveAccessibleName("Дракончик Персик, выбран");
    await expect(page.getByTestId("hero-choose")).toBeDisabled();
    await expect(page.getByTestId("hero-choose")).toHaveText("Это ваш герой");
    await page.getByTestId("hero-human_2").click();
    await page.getByTestId("hero-choose").click();
    await expect(page.getByTestId("game-hero-name")).toHaveText("Ученица Ая · «Путешественник»");
    await expect(page.getByTestId("game-xp-text")).toHaveText(xp!);
    await expect(page.getByTestId("game-level-n")).toHaveText("Уровень 2");
  });

  test("онбординг: после плана — выбор героя; «Пропустить» ведёт к итогу без героя", async ({ page }) => {
    const bff = await open(page, { game: { hero: null } });
    const next = page.getByTestId("ob-next");
    await page.getByTestId("ob-step-lang").waitFor();
    await next.click();
    await page.getByTestId("who-self").click();
    await page.getByRole("button", { name: "18 лет и старше" }).click();
    await next.click();
    for (const c of ["terms", "privacy", "learning"]) await page.getByTestId(`consent-${c}`).check();
    await next.click();
    await page.getByRole("button", { name: "Работа" }).click();
    await next.click();
    await page.getByTestId("level-some").click();
    await next.click();
    await page.getByTestId("ob-step-when").waitFor();
    await next.click();
    await page.getByTestId("ob-step-minutes").waitFor();
    await next.click();
    // the plan is complete; the hero is offered (skippable)
    await expect(page.getByTestId("ob-step-hero")).toBeVisible();
    expect(bff.calls("POST", "/v1/plan/onboarding/complete")).toHaveLength(1);
    await expect(page.locator(".bar")).toContainText("Последний шаг");
    await expect(page.locator(".hero-tile")).toHaveCount(9);
    await page.getByTestId("hero-robot_1").click();
    await expect(page.getByTestId("hero-detail-name")).toHaveText("Робот Искра");
    await shotOf(page, "hero-skip", "38_onboarding_hero");
    await page.getByTestId("hero-choose").click();
    await expect(page.getByTestId("ob-done")).toBeVisible();
    await expect(page.getByTestId("ob-done-hero")).toContainText("Робот Искра");
    await expect(page.getByTestId("ob-done").locator(".done-hero img")).toHaveAttribute("alt", "Робот Искра, ступень «Сборка»");
    await page.getByTestId("ob-open-home").click();
    await page.getByTestId("whats-new-welcome").getByRole("button", { name: "Закрыть" }).click();
    await expect(page.getByTestId("game-hero-name")).toHaveText("Робот Искра · «Сборка»");
  });

  test("онбординг: «Пропустить — выберу потом» → итог плана → на главной приглашение", async ({ page }) => {
    await open(page, { game: { hero: null } });
    const next = page.getByTestId("ob-next");
    await page.getByTestId("ob-step-lang").waitFor();
    await next.click();
    await page.getByTestId("who-self").click();
    await page.getByRole("button", { name: "18 лет и старше" }).click();
    await next.click();
    for (const c of ["terms", "privacy", "learning"]) await page.getByTestId(`consent-${c}`).check();
    await next.click();
    await page.getByRole("button", { name: "Работа" }).click();
    await next.click();
    await page.getByTestId("level-some").click();
    await next.click();
    await next.click();
    await page.getByTestId("ob-step-minutes").waitFor();
    await next.click();
    await page.getByTestId("hero-skip").click();
    await expect(page.getByTestId("ob-done")).toBeVisible();
    await expect(page.getByTestId("ob-done-hero")).toHaveCount(0);
    await page.getByTestId("ob-open-home").click();
    await page.getByTestId("whats-new-welcome").getByRole("button", { name: "Закрыть" }).click();
    await expect(page.getByTestId("game-invite")).toBeVisible();
  });
});

test.describe("магазин", () => {
  test("покупка за тилы с Idempotency-Key, «Куплено» и «Надеть»; нехватка — «покупка тилов скоро», без оплаты", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("game-shop").click();
    await expect(page.getByTestId("shop")).toBeVisible();
    await expect(page.getByTestId("shop-balance")).toContainText("У вас 85 тилов");
    await expect(page.getByTestId("shop-freezes")).toHaveText("2 из 5");
    await expect(page.getByTestId("shop-balance")).toContainText("Покупка тилов — скоро");
    // the three sections and the prices
    await expect(page.getByTestId("shop-sec-streak_freeze").locator("li")).toHaveCount(1);
    await expect(page.getByTestId("shop-streak_freeze")).toContainText("Цена: 40 тилов");
    await expect(page.getByTestId("shop-streak_freeze")).toContainText("Запас: 2 из 5");
    // not enough: 120 > 85 — the reason in words, the button is off, no payment screens
    await expect(page.getByTestId("shop-why-bg_space")).toHaveText("Не хватает 35 тилов. Заработайте в уроках — покупка тилов скоро");
    await expect(page.getByTestId("shop-buy-bg_space")).toBeDisabled();
    await expect(page.getByTestId("shop-buy-bg_space")).toHaveAccessibleDescription("Не хватает 35 тилов. Заработайте в уроках — покупка тилов скоро");
    await shotOf(page, "shop-balance", "39_shop");

    // the frame: 50 tils
    await page.getByTestId("shop-buy-frame_gold").click();
    await expect(page.getByRole("alertdialog")).toContainText("Купить «Золотая рамка»?");
    await expect(page.getByRole("alertdialog")).toContainText("Спишем 50 тилов. На учёбу покупка не влияет.");
    await confirm(page);
    await expect(page.getByTestId("toast")).toHaveText("Куплено: Золотая рамка");
    const buy = bff.last("POST", "/v1/game/shop/purchases")!;
    expect(buy.body).toEqual({ item_code: "frame_gold" });
    expect(buy.headers["idempotency-key"]).toMatch(UUID);
    await expect(page.getByTestId("shop-balance")).toContainText("У вас 35 тилов");
    await expect(page.getByTestId("shop-frame_gold")).toHaveAttribute("data-owned", "true");
    await expect(page.getByTestId("shop-frame_gold")).toContainText("Куплено");
    // now the freeze is short of 5: «тилов» after a number in the genitive
    await expect(page.getByTestId("shop-why-streak_freeze")).toHaveText("Не хватает 5 тилов. Заработайте в уроках — покупка тилов скоро");
    await shotOf(page, "shop-streak_freeze", "47_shop_shortage");
    // wear it
    await page.getByTestId("shop-equip-frame_gold").click();
    await expect(page.getByTestId("toast")).toHaveText("Надето: Золотая рамка");
    expect(bff.last("PUT", "/v1/game/equipment")?.body).toEqual({ background_code: null, frame_code: "frame_gold" });
    await expect(page.getByTestId("shop-frame_gold")).toHaveAttribute("data-equipped", "true");
    await expect(page.getByTestId("shop-equip-frame_gold")).toHaveText("Снять");
    await expect(page.getByTestId("shop-frame_gold")).toContainText("Надето");
    // the client never computes the balance: Home shows the server's
    await page.getByTestId("bar-back").click();
    await expect(page.getByTestId("game-tils")).toHaveText("35 тилов");
    await expect(page.getByTestId("game-hero").locator(".game-hero")).toHaveAttribute("data-frame", "frame_gold");
    // no payment anywhere
    const text = await page.locator(".app").innerText();
    expect(text).not.toMatch(/Payme|Click|Uzum|оплат/i);
    expect(bff.game.purchasesMade).toBe(1);
  });

  test("двойной тап «Купить»: один диалог, один POST; кнопки заблокированы, пока диалог открыт", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("game-shop").click();
    await page.getByTestId("shop-buy-frame_gold").dblclick();
    await expect(page.getByRole("alertdialog")).toHaveCount(1);
    await expect(page.getByTestId("shop-buy-frame_gold")).toBeDisabled();
    await expect(page.getByTestId("shop-buy-streak_freeze")).toBeDisabled();
    const ok = page.getByRole("alertdialog").getByRole("button", { name: "Купить", exact: true });
    await ok.dblclick({ force: true }).catch(() => undefined);
    await expect(page.getByTestId("toast")).toHaveText("Куплено: Золотая рамка");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(bff.calls("POST", "/v1/game/shop/purchases")).toHaveLength(1);
    expect(bff.game.purchasesMade).toBe(1);
    // unlocked again: the bought frame can be worn
    await expect(page.getByTestId("shop-equip-frame_gold")).toBeEnabled();
  });

  test("повтор: ответ на покупку потерян — повтор с тем же ключом, вторая операция не создаётся", async ({ page }) => {
    const bff = await start(page, { dropPurchaseOnce: true });
    await page.getByTestId("game-shop").click();
    await page.getByTestId("shop-buy-streak_freeze").click();
    await confirm(page);
    // the answer was lost on the way: the error is told, the purchase is not doubled by the retry
    await expect(page.getByTestId("shop-streak_freeze").getByRole("alert")).toBeVisible();
    await page.getByTestId("shop-buy-streak_freeze").click();
    await confirm(page);
    await expect(page.getByTestId("toast")).toHaveText("Заморозка куплена. Запас: 3 из 5");
    const calls = bff.calls("POST", "/v1/game/shop/purchases");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["idempotency-key"]).toBe(calls[0]!.headers["idempotency-key"]);
    expect(bff.game.purchasesMade).toBe(1);
    await expect(page.getByTestId("shop-balance")).toContainText("У вас 45 тилов");
    await expect(page.getByTestId("shop-freezes")).toHaveText("3 из 5");
    // the next purchase is a new one: a new key
    await page.getByTestId("shop-buy-streak_freeze").click();
    await confirm(page);
    await expect(page.getByTestId("toast")).toHaveText("Заморозка куплена. Запас: 4 из 5");
    const third = bff.calls("POST", "/v1/game/shop/purchases")[2]!;
    expect(third.headers["idempotency-key"]).not.toBe(calls[0]!.headers["idempotency-key"]);
    expect(bff.game.purchasesMade).toBe(2);
  });

  test("гонка: витрина говорила «можно», сервер отвечает 409 INSUFFICIENT_TILS — показываем, сколько не хватает", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("game-shop").click();
    await expect(page.getByTestId("shop-buy-streak_freeze")).toBeEnabled();
    // tils were spent elsewhere meanwhile
    bff.game.state(bff.active).til = 10;
    await page.getByTestId("shop-buy-streak_freeze").click();
    await confirm(page);
    await expect(page.getByTestId("shop-why-streak_freeze")).toHaveText("Не хватает 30 тилов. Заработайте в уроках — покупка тилов скоро");
    await expect(page.getByTestId("shop-balance")).toContainText("У вас 10 тилов");
    expect(bff.game.purchasesMade).toBe(0);
  });

  test("запас заморозок полный: 5 из 5 — купить нельзя, причина словами", async ({ page }) => {
    await start(page, { freeze: 5 });
    await page.getByTestId("game-shop").click();
    await expect(page.getByTestId("shop-why-streak_freeze")).toHaveText("Запас полный: 5 из 5");
    await expect(page.getByTestId("shop-buy-streak_freeze")).toBeDisabled();
  });
});

test.describe("история и значки", () => {
  test("история операций: причины, «Корректировка поддержки», отменённая, лимит, ×2, фильтр по валюте, страницы", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("game-history").click();
    await expect(page.getByTestId("game-history")).toBeVisible();
    await expect(page.getByTestId("hist-now")).toHaveText("Сейчас: 120 XP · 85 тилов · 2 заморозки");
    const list = page.getByTestId("hist-list");
    await expect(list.locator("li")).toHaveCount(30);
    // newest first: the purchase in the shop
    await expect(list.locator("li").first()).toHaveAttribute("data-reason", "shop");
    await expect(list.locator("li").first()).toContainText("Покупка в магазине");
    await expect(list.locator("li").first()).toContainText("−40 тилов");
    // a staff operation: «Корректировка поддержки», never the staff comment
    const manual = list.locator('li[data-reason="manual"]');
    await expect(manual).toHaveCount(2);
    await expect(manual.first()).toContainText("Корректировка поддержки");
    const reversed = list.locator('li[data-status="reversed"]');
    await expect(reversed).toHaveCount(1);
    await expect(reversed).toContainText("отменена");
    await expect(list.locator('li[data-reason="reversal"]')).toContainText("Отмена операции");
    await expect(list.locator('li[data-reason="reversal"]')).toContainText("−10 тилов");
    await expect(list.getByText("урезано дневным лимитом")).toHaveCount(1);
    await expect(list.getByText("×2 событие недели")).toHaveCount(1);
    await shotOf(page, "hist-filter", "40_game_history");
    // the second page
    await page.getByTestId("hist-more").click();
    await expect(list.locator("li")).toHaveCount(34);
    await expect(list.locator("li").last()).toContainText("Подарок за регистрацию");
    await expect(list.locator("li").last()).toContainText("+2 заморозки");
    await expect(page.getByTestId("hist-more")).toHaveCount(0);
    // the filter by currency
    await page.getByTestId("hist-filter").getByRole("button", { name: "Заморозки" }).click();
    await expect(page.getByTestId("hist-filter").getByRole("button", { name: "Заморозки" })).toHaveAttribute("aria-pressed", "true");
    await expect(list.locator("li")).toHaveCount(2);
    expect(bff.last("GET", "/v1/game/history")?.query.get("currency")).toBe("freeze");
    await page.getByTestId("hist-filter").getByRole("button", { name: "Опыт" }).click();
    await expect(list.locator("li").first()).toContainText("XP");
    expect(bff.last("GET", "/v1/game/history")?.query.get("currency")).toBe("xp");
  });

  test("значки: выданные с датой и основанием, впереди — с прогрессом; XP их не заменяет", async ({ page }) => {
    await start(page);
    await page.getByTestId("game-badges").click();
    await expect(page.getByTestId("badges")).toBeVisible();
    await expect(page.getByTestId("badges")).toContainText("Опыт (XP) и тилы их не заменяют");
    const first = page.getByTestId("badge-first_lesson");
    await expect(first).toHaveAttribute("data-earned", "true");
    await expect(page.getByTestId("badge-first_lesson-date")).toHaveText("Получен 12 ноября");
    const btn = page.getByTestId("badge-first_lesson-basis-btn");
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await btn.click();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("badge-first_lesson-basis")).toHaveText("Пройдено уроков: 3 (нужно 1).");
    const streak = page.getByTestId("badge-streak_7");
    await expect(streak).toHaveAttribute("data-earned", "false");
    await expect(page.getByTestId("badge-streak_7-progress")).toHaveText("4 из 7");
    const bar = streak.getByRole("progressbar");
    await expect(bar).toHaveAttribute("aria-valuenow", "4");
    await expect(bar).toHaveAttribute("aria-valuemax", "7");
    await expect(bar).toHaveAttribute("aria-valuetext", "Неделя подряд: 4 из 7");
    await expect(page.getByTestId("badges-earned").locator("li")).toHaveCount(1);
    await expect(page.getByTestId("badges-open").locator("li")).toHaveCount(7);
    await shotOf(page, "badges-earned", "41_badges");
  });
});

test.describe("награды после занятия", () => {
  test("сразу после плеера: pending → ready — XP, тилы, новый уровень, герой вырос, значок, задание дня", async ({ page }) => {
    const bff = await start(page, { rewards: { pendingReads: 2, levelUp: true, heroUp: true, badge: true } }, { lessons: { evaluatedDaysAgo: 2 } });
    await finishScenario(page);
    await expect(page.getByTestId("rw-pending")).toHaveText("Считаем награды…");
    const card = page.getByTestId("rw-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    const sessionId = bff.last("GET", "/v1/game/rewards")!.query.get("source_session_id")!;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bff.game.rewardReads(bff.active, sessionId)).toBe(3);
    await expect(card).toHaveAttribute("data-celebration", "full");
    await expect(card.locator(".rw-confetti")).toHaveCount(1);
    await expect(page.getByTestId("rw-xp")).toHaveText("+145 XP");
    await expect(page.getByTestId("rw-til")).toHaveText("+10 тилов");
    await expect(page.getByTestId("rw-level")).toHaveText("Новый уровень: 3!");
    await expect(page.getByTestId("rw-hero")).toContainText("Робот Вольт вырос: «Запуск»!");
    await expect(page.getByTestId("rw-hero").locator("img")).toHaveAttribute("alt", "Робот Вольт, ступень «Запуск»");
    await expect(page.getByTestId("rw-badges")).toHaveText("Новый значок: Закреплено");
    await expect(page.getByTestId("rw-quests")).toHaveText("Задание дня выполнено: Пройти урок");
    await shotOf(page, "rw-card", "42_lesson_rewards");
    expect(bff.last("POST", /\/v1\/sessions\/[0-9a-f-]+\/finish$/)?.path).toContain(sessionId);
    // the celebrations came with the summary — no separate settings request
    expect(bff.calls("GET", "/v1/game/settings")).toHaveLength(0);
    // no more reads once ready
    await page.waitForTimeout(1800);
    expect(bff.game.rewardReads(bff.active, sessionId)).toBe(3);
    // the history of the ledger has them
    await page.getByTestId("rw-history").click();
    await expect(page.getByTestId("hist-list").locator("li").first()).toContainText("Задание дня");
    await page.getByTestId("bar-back").click();
    await page.getByTestId("sm-done").click();
    await toTabs(page);
    // a past lesson from the history: no rewards card, no polling
    const reads = bff.calls("GET", "/v1/game/rewards").length;
    await page.getByTestId("tab-lessons").click();
    await page.getByTestId("ls-history").getByRole("button").last().click();
    await expect(page.getByTestId("sm-scores")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("rw")).toHaveCount(0);
    expect(bff.calls("GET", "/v1/game/rewards")).toHaveLength(reads);
  });

  test("чтение: награды в итогах; лимит дня и событие недели названы; «none» — блока нет", async ({ page }) => {
    const bff = await start(page, { rewards: { capped: true, multiplier: 2, quest: false } });
    await page.getByTestId("home-practice").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Чтение" }).click();
    await page.getByTestId("rd-rd-cafe-morning").click();
    await page.getByTestId("rd-start").click();
    await expect(page.getByTestId("pl-reading")).toBeVisible();
    await page.getByTestId("pl-next").click();
    await page.getByTestId("pl-opt-1").click();
    await page.getByTestId("pl-answer").click();
    await page.getByTestId("pl-opt-1").click();
    await page.getByTestId("pl-answer").click();
    await page.getByTestId("pl-gap-input").fill("for");
    await page.getByTestId("pl-answer").click();
    await page.getByTestId("pl-finish").click();
    await expect(page.getByTestId("summary")).toBeVisible();
    await expect(page.getByTestId("rw-card")).toBeVisible({ timeout: 10_000 });
    const session = bff.last("GET", "/v1/game/rewards")!.query.get("source_session_id");
    expect(bff.last("POST", /\/v1\/sessions\/[0-9a-f-]+\/finish$/)?.path).toContain(session!);
    await expect(page.getByTestId("rw-xp")).toHaveText("+60 XP");
    await expect(page.getByTestId("rw-card")).toContainText("×2 — событие недели");
    await expect(page.getByTestId("rw-capped")).toHaveText("На сегодня достигнут дневной предел наград — завтра снова в полную силу.");
    await expect(page.getByTestId("rw-quests")).toHaveCount(0);
  });

  test("наград не было (none): после «Считаем награды…» блок исчезает", async ({ page }) => {
    const bff = await start(page, { rewards: { outcome: "none", pendingReads: 0 } });
    await finishScenario(page);
    await expect.poll(() => bff.calls("GET", "/v1/game/rewards").length).toBeGreaterThan(0);
    await expect(page.getByTestId("rw")).toHaveCount(0);
    expect(bff.calls("GET", "/v1/game/settings")).toHaveLength(0);
    // `none` ends the polling at once (React StrictMode of the dev server mounts the effect twice — two first reads)
    await page.waitForTimeout(2000);
    expect(bff.calls("GET", "/v1/game/rewards").length).toBeLessThanOrEqual(2);
  });
});

test.describe("настройки мотивации", () => {
  test("автозаморозка, скрыть задания, тихие празднования, уведомления — сохраняются сразу; учёба не меняется", async ({ page }) => {
    const bff = await start(page, { rewards: { pendingReads: 0 } });
    await expect(page.getByTestId("game-quests")).toBeVisible();
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("row-hero")).toContainText("Робот Вольт");
    await expect(page.getByTestId("row-shop")).toContainText("85 тилов");
    await page.getByTestId("row-game-settings").click();
    await expect(page.getByTestId("game-settings")).toBeVisible();
    await expect(page.getByTestId("gs-learning")).toContainText("Общая лига недели — только по желанию");
    await expect(page.getByTestId("gs-auto-freeze")).toBeChecked();
    await page.getByTestId("gs-auto-freeze").uncheck();
    await expect(page.getByTestId("toast")).toHaveText("Сохранено");
    expect(bff.last("PATCH", "/v1/game/settings")?.body).toEqual({ auto_freeze: false });
    await page.getByTestId("gs-hide-quests").check();
    await expect.poll(() => bff.last("PATCH", "/v1/game/settings")?.body).toEqual({ quests_hidden: true });
    await page.getByTestId("gs-quiet").check();
    await expect.poll(() => bff.last("PATCH", "/v1/game/settings")?.body).toEqual({ celebrations: "quiet" });
    await page.getByTestId("gs-notif").uncheck();
    await expect.poll(() => bff.last("PATCH", "/v1/game/settings")?.body).toEqual({ game_notifications: false });
    await expect(page.getByTestId("gs-notif")).not.toBeChecked();
    await shotOf(page, "game-settings", "43_game_settings");
    // the quests are gone from Home; the plan is the same
    await page.getByTestId("bar-back").click();
    await page.getByTestId("tab-home").click();
    await expect(page.getByTestId("game-card")).toBeVisible();
    await expect(page.getByTestId("game-quests")).toHaveCount(0);
    await expect(page.getByTestId("today-card")).toBeVisible();
    expect(bff.calls("PATCH", "/v1/plan")).toHaveLength(0);
    // quiet celebrations: the rewards of the next session without animation and confetti
    await finishScenario(page);
    await expect(page.getByTestId("rw-card")).toHaveAttribute("data-celebration", "quiet");
    await expect(page.getByTestId("rw-card").locator(".rw-confetti")).toHaveCount(0);
  });

  test("ошибка сохранения — переключатель возвращается, текст ошибки", async ({ page }) => {
    await start(page, {}, { failOnce: { "PATCH /v1/game/settings": [503, "GAME_UNAVAILABLE"] } });
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-game-settings").click();
    // the switch moves at once, the failure puts it back
    await page.getByTestId("gs-auto-freeze").click();
    await expect(page.getByRole("alert")).toHaveText("Игра временно недоступна — учёба работает как обычно.");
    await expect(page.getByTestId("gs-auto-freeze")).toBeChecked();
  });
});

test.describe("ребёнок 6–13", () => {
  test("дракончики первыми, тексты на «ты» без давления, тихие празднования, без «покупки тилов»", async ({ page }) => {
    const bff = await start(page, { hero: null, til: 20, rewards: { pendingReads: 0 } }, { child: true });
    await expect(page.getByTestId("game-invite")).toContainText("Выбери героя");
    await expect(page.getByTestId("game-invite")).toContainText("Он будет расти вместе с тобой");
    await expect(page.getByTestId("game-quests")).toContainText("Пройди урок");
    await expect(page.getByTestId("game-quests")).toContainText("Не успеешь — ничего страшного");
    await page.getByTestId("game-choose-hero").click();
    // the dragons first
    await expect(page.locator(".hero-grid").first()).toHaveAttribute("data-testid", "hero-line-pet");
    await expect(page.locator(".hero-tile").first()).toHaveAttribute("data-testid", "hero-pet_0");
    await expect(page.getByTestId("hero-detail-name")).toHaveText("Дракончик Мятик");
    await expect(page.getByTestId("heroes")).toContainText("Выбери друга!");
    await shotOf(page, "hero-line-pet", "44_kid_heroes");
    await page.getByTestId("hero-choose").click();
    await expect(page.getByTestId("toast")).toHaveText("Твой герой — Дракончик Мятик");
    await expect(page.getByTestId("game-hero-name")).toHaveText("Дракончик Мятик · «Яйцо»");
    // the shop: tils only, a soft line without the purchase of tils
    await page.getByTestId("game-shop").click();
    await expect(page.getByTestId("shop-balance")).toContainText("У тебя 20 тилов");
    await expect(page.getByTestId("shop-why-streak_freeze")).toHaveText("Не хватает 20 тилов. Их можно заработать в уроках!");
    expect(await page.getByTestId("shop").innerText()).not.toContain("покупка тилов");
    await page.getByTestId("bar-back").click();
    // the rewards of a reading just finished: quiet by default for children
    await finishKidReading(page);
    const card = page.getByTestId("rw-card");
    await expect(card).toHaveAttribute("data-celebration", "quiet");
    await expect(card).toContainText("Твои награды");
    await expect(card.locator(".rw-confetti")).toHaveCount(0);
    await shotOf(page, "rw-card", "48_kid_rewards");
    // no comparisons with others anywhere in the game
    const all = await page.locator(".app").innerText();
    expect(all).not.toMatch(/рейтинг|лучше других|обогнал/i);
    expect(bff.game.state(bff.active).settings.celebrations).toBe("quiet");
  });
});

test.describe("доступность и язык", () => {
  test("клавиатура выбирает героя; подписи у полос; неделя и задания — не цветом одним; уменьшение движения — без анимаций", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await start(page, { hero: null, rewards: { pendingReads: 0 } }, WEEK);
    // every progress bar of the game has a name and a value in words
    await expect(page.getByTestId("game-quests")).toBeVisible();
    for (const bar of [...(await page.getByTestId("game-card").getByRole("progressbar").all()), ...(await page.getByTestId("game-quests").getByRole("progressbar").all())]) {
      expect(await bar.getAttribute("aria-label")).toBeTruthy();
      expect(await bar.getAttribute("aria-valuetext")).toBeTruthy();
    }
    // the done quest: a check and a word, not colour only
    await expect(page.getByTestId("quest-reading_1").locator(".q-mk svg")).toHaveCount(1);
    await expect(page.locator('.week li[data-state="frozen"] svg')).toHaveCount(1);
    // the hero picker by keyboard
    await page.getByTestId("game-choose-hero").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("heroes")).toBeVisible();
    await page.getByTestId("hero-robot_2").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("hero-robot_2")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("hero-pet_0")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("hero-pet_0")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("hero-robot_2")).toHaveAttribute("aria-pressed", "false");
    // every tile has a name (the image is decorative there)
    for (const tile of await page.locator(".hero-tile").all()) expect((await tile.getAttribute("aria-label"))?.length).toBeGreaterThan(3);
    await page.getByTestId("hero-choose").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("game-hero-name")).toHaveText("Дракончик Мятик · «Яйцо»");
    // reduced motion: an adult with full celebrations still gets no animation
    await finishScenario(page);
    await expect(page.getByTestId("rw-card")).toHaveAttribute("data-celebration", "quiet");
    await expect(page.getByTestId("rw-card").locator(".rw-confetti")).toHaveCount(0);
  });

  test("UZ: игровой блок, магазин и история — латиница, без кириллицы", async ({ page }) => {
    await start(page, { event: true }, { ...WEEK, locale: "uz" });
    await expect(page.getByTestId("game-hero-name")).toHaveText("Robot Volt · «Yigʻilish»");
    await expect(page.getByTestId("game-level-n")).toHaveText("2-daraja");
    await expect(page.getByTestId("game-tils")).toHaveText("85 til");
    await expectLatin(page);
    await page.getByTestId("game-shop").click();
    await expect(page.getByTestId("shop-why-bg_space")).toHaveText("35 til yetmayapti. Darslarda ishlab oling — til sotib olish tez orada");
    await expectLatin(page);
    await page.getByTestId("bar-back").click();
    await page.getByTestId("game-history").click();
    await expect(page.getByTestId("hist-list").locator("li").first()).toContainText("Doʻkondan xarid");
    await expectLatin(page);
    await shotOf(page, "hist-filter", "45_history_uz");
  });
});

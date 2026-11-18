import { expect, test, type Page } from "@playwright/test";
import type { ExperienceConfig } from "@tilhero/contracts/bff";
import * as F from "./fixtures/data";
import type { Scenario } from "./fixtures/mock-bff";
import { IOS_FULLSCREEN, drawTelegramChrome, installTelegram, tgBack, tgCalled, tgCalls, tgSetScheme, type TelegramOptions } from "./fixtures/telegram";
import { CYRILLIC, open, settle, shot } from "./helpers";

/**
 * Owner's feedback after the first launch in Telegram (iOS): full screen with the headers below Telegram's buttons,
 * «На главный экран», the theme choice, «Начать занятие» on Home, changing the goal / level / topics after onboarding.
 */
const ALL_SEEN = [F.WELCOME.id, F.UPDATE_1.id, F.UPDATE_2.id];
const SAFE_TOP = IOS_FULLSCREEN.safe.top + IOS_FULLSCREEN.content.top; // 47 + 46
const DARK_PAPER = "#11152B";

async function openTg(page: Page, tg: TelegramOptions, sc: Scenario = {}) {
  await installTelegram(page, tg);
  return open(page, { onboarded: true, seen: ALL_SEEN, ...sc });
}
const top = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!.y;
const paper = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim().toUpperCase());

/* ------------------------------------------------------------------ 1. full screen on iOS */

test.describe("1 · full screen (Bot API 8.0)", () => {
  test("iOS 8.0: requestFullscreen; the header and the bell start below --safe-top (47 + 46); tabs above the home indicator", async ({ page }) => {
    await openTg(page, { platform: "ios", version: "8.0", fullscreen: IOS_FULLSCREEN });
    await expect(page.getByTestId("today-card")).toBeVisible();
    expect(await tgCalled(page, "requestFullscreen")).toBe(1);
    // ready → expand → requestFullscreen (the dev build's StrictMode repeats ready/expand; full screen is asked once)
    const names = (await tgCalls(page)).map((c) => String(c[0]));
    expect(names.indexOf("ready")).toBeLessThan(names.indexOf("expand"));
    expect(names.indexOf("expand")).toBeLessThan(names.indexOf("requestFullscreen"));
    await expect(page.locator("html")).toHaveAttribute("data-fullscreen", "true");
    expect(await top(page, "header.bar")).toBeGreaterThanOrEqual(SAFE_TOP);
    expect(await top(page, '[data-testid="bell"]')).toBeGreaterThanOrEqual(SAFE_TOP);
    expect(await page.locator("header.bar .logo").evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(SAFE_TOP);
    // nothing of the app is under Telegram's buttons except the plain paper band
    const hit = await page.evaluate((y) => document.elementFromPoint(195, y - 10)?.className ?? "", SAFE_TOP);
    expect(hit).toContain("app");
    // the tab bar ends above the home indicator (safeAreaInset.bottom 34)
    expect(await page.locator("nav.tabs").evaluate((el) => getComputedStyle(el).paddingBottom)).toBe("34px");
    const tab = (await page.getByTestId("tab-home").boundingBox())!;
    expect(tab.y + tab.height).toBeLessThanOrEqual(844 - 34 + 0.5);
    await drawTelegramChrome(page);
    await shot(page, "19_ios_fullscreen_home");
  });

  test("iOS full screen: onboarding, a sheet and the lock screen also start below Telegram's buttons", async ({ page }) => {
    // onboarding of a new user: the brand of the welcome step, then the step bar
    await installTelegram(page, { platform: "ios", fullscreen: IOS_FULLSCREEN });
    await open(page, {});
    await expect(page.getByTestId("ob-step-lang")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-fullscreen", "true");
    expect(await top(page, ".brand")).toBeGreaterThanOrEqual(SAFE_TOP);
    await drawTelegramChrome(page);
    await shot(page, "25_ios_fullscreen_onboarding");
    await page.getByTestId("ob-next").click();
    await expect(page.getByTestId("ob-step-who")).toBeVisible();
    expect(await top(page, "header.bar")).toBeGreaterThanOrEqual(SAFE_TOP);
    expect(await top(page, ".steps")).toBeGreaterThanOrEqual(SAFE_TOP);
    // the tallest step (a teen's consents) no longer fits under Telegram's buttons: it scrolls, nothing is clipped
    await page.getByTestId("who-self").click();
    await page.getByRole("button", { name: "от 14 до 17 лет" }).click();
    await page.getByTestId("ob-next").click();
    await page.getByTestId("ob-next").click();
    await expect(page.getByTestId("consent-terms")).toBeVisible();
    expect(await page.locator(".ob-body").evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
    const read = page.getByRole("button", { name: "Прочитать документ" });
    const body = (await page.locator(".ob-body").boundingBox())!;
    await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
    await page.mouse.wheel(0, 600);
    await expect(read).toBeInViewport({ ratio: 1 });
    expect((await page.getByTestId("ob-next").boundingBox())!.y + 48).toBeLessThanOrEqual(844 - IOS_FULLSCREEN.safe.bottom + 0.5);

    // «Что нового» sheet (updates at login)
    const p2 = await page.context().newPage();
    await installTelegram(p2, { platform: "ios", fullscreen: IOS_FULLSCREEN });
    await open(p2, { onboarded: true });
    const sheet = p2.getByTestId("whats-new-updates");
    await expect(sheet).toBeVisible();
    await expect(p2.locator("html")).toHaveAttribute("data-fullscreen", "true");
    await settle(p2);
    expect(await top(p2, ".sheet")).toBeGreaterThanOrEqual(SAFE_TOP);
    expect(await top(p2, ".sheet-x")).toBeGreaterThanOrEqual(SAFE_TOP);

    // the lock screen (parent code)
    const p3 = await page.context().newPage();
    await installTelegram(p3, { platform: "ios", fullscreen: IOS_FULLSCREEN });
    await open(p3, { onboarded: true, seen: ALL_SEEN, pin: "1234", pinRequired: true });
    await expect(p3.getByTestId("lock")).toBeVisible();
    await expect(p3.locator("html")).toHaveAttribute("data-fullscreen", "true");
    await settle(p3);
    const lock = (await p3.getByTestId("lock").boundingBox())!;
    expect(lock.y).toBeGreaterThanOrEqual(SAFE_TOP);
  });

  test("Android 8.0 asks for full screen; desktop, 7.10 and fullscreenFailed stay expanded without any error", async ({ page }) => {
    await openTg(page, { platform: "android" });
    await expect(page.getByTestId("today-card")).toBeVisible();
    expect(await tgCalled(page, "requestFullscreen")).toBe(1);

    for (const tg of [{ platform: "tdesktop" }, { platform: "ios", version: "7.10" }] as TelegramOptions[]) {
      const p = await page.context().newPage();
      await openTg(p, tg);
      await expect(p.getByTestId("today-card")).toBeVisible();
      expect(await tgCalled(p, "expand")).toBeGreaterThanOrEqual(1);
      expect(await tgCalled(p, "requestFullscreen")).toBe(0);
    }

    const failed = await page.context().newPage();
    await openTg(failed, { platform: "ios", fullscreen: { ...IOS_FULLSCREEN, fail: "UNSUPPORTED" } });
    await expect(failed.getByTestId("today-card")).toBeVisible();
    await expect(failed.locator("html")).toHaveAttribute("data-fullscreen", "false");
    expect(await top(failed, "header.bar")).toBe(0);
    await expect(failed.getByRole("alert")).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ 2. «На главный экран» (from aievent 9.4) */

test.describe("2 · «На главный экран»", () => {
  for (const [scheme, platform] of [
    ["light", "ios"],
    ["dark", "android"],
  ] as const) {
    test(`Профиль: строка → системный запрос → тост и «добавлено» (${scheme}, ${platform})`, async ({ page }) => {
      await openTg(page, { colorScheme: scheme, platform, homeScreen: { status: "missed", onAdd: "event" }, ...(platform === "ios" ? { fullscreen: IOS_FULLSCREEN } : {}) });
      await page.getByTestId("tab-profile").click();
      const row = page.getByTestId("hs-row");
      await expect(row).toContainText("На главный экран");
      await expect(row).toContainText("Открывать TilHero одной кнопкой, без поиска бота");
      expect(await tgCalled(page, "checkHomeScreenStatus")).toBe(1);
      if (platform === "ios") {
        await expect(page.getByTestId("row-goal")).toBeVisible();
        expect(await top(page, "header.bar")).toBeGreaterThanOrEqual(SAFE_TOP);
        await drawTelegramChrome(page);
        await shot(page, "20_profile_rows");
        await page.evaluate(() => document.getElementById("__tg-chrome")?.remove());
      }
      await row.click();
      await expect(page.getByTestId("toast")).toHaveText("Иконка TilHero на главном экране");
      const added = page.getByTestId("hs-row-added");
      await expect(added).toContainText("добавлено");
      await expect(added.getByRole("button")).toHaveCount(0);
      expect(await tgCalled(page, "addToHomeScreen")).toBe(1);
    });
  }

  test("уже добавлено — «добавлено» без действия; клиент 7.10, desktop (unsupported) и вне Telegram — строки нет", async ({ page }) => {
    await openTg(page, { homeScreen: { status: "added" } });
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("hs-row-added")).toContainText("добавлено");
    await expect(page.getByTestId("hs-row")).toHaveCount(0);
    for (const tg of [{ version: "7.10", homeScreen: { status: "missed" } }, { platform: "tdesktop", homeScreen: { status: "unsupported" } }, null] as Array<TelegramOptions | null>) {
      const p = await page.context().newPage();
      if (tg) await openTg(p, tg);
      else await open(p, { onboarded: true, seen: ALL_SEEN });
      await p.getByTestId("tab-profile").click();
      await expect(p.getByTestId("row-theme")).toBeVisible();
      await settle(p);
      await expect(p.getByTestId("hs-row")).toHaveCount(0);
      await expect(p.getByTestId("hs-row-added")).toHaveCount(0);
    }
  });
});

/* ------------------------------------------------------------------ 3. theme */

test.describe("3 · тема", () => {
  test("Профиль → Тема → «Тёмная»: сразу тёмная тетрадь, цвет шапки Telegram, CloudStorage; после перезапуска — без мигания", async ({ page }) => {
    await openTg(page, { platform: "android", colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "light");
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("row-theme")).toContainText("Как в Telegram");
    await page.getByTestId("row-theme").click();
    await expect(page.getByRole("heading", { name: "Тема" })).toBeVisible();
    await expect(page.getByTestId("theme-system")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Выбор хранится в Telegram — тема будет такой же на других ваших устройствах.")).toBeVisible();
    await page.getByTestId("theme-dark").click();
    await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
    expect(await paper(page)).toBe(DARK_PAPER);
    await expect.poll(async () => (await tgCalls(page)).filter((c) => c[0] === "CloudStorage.setItem").at(-1)).toEqual(["CloudStorage.setItem", "theme_pref", "dark"]);
    const header = (await tgCalls(page)).filter((c) => c[0] === "setHeaderColor").at(-1);
    expect(String(header?.[1]).toUpperCase()).toBe(DARK_PAPER);
    await shot(page, "21_theme_dark");
    await tgBack(page);
    await expect(page.getByTestId("row-theme")).toContainText("Тёмная");

    // relaunch: the dark notebook is set in <head> (public/theme-boot.js), before the body exists — never light first
    await page.addInitScript(() => {
      const seen: Array<{ v: string | null; body: boolean }> = [];
      (window as unknown as { __schemes: typeof seen }).__schemes = seen;
      // the document itself (its <html> may not be parsed yet when this runs)
      new MutationObserver((list) => {
        for (const m of list) seen.push({ v: (m.target as Element).getAttribute("data-scheme"), body: !!document.body });
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-scheme"] });
    });
    await page.reload();
    await expect(page.getByTestId("today-card")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
    const schemes = await page.evaluate(() => (window as unknown as { __schemes: Array<{ v: string | null; body: boolean }> }).__schemes);
    const firstDark = schemes.findIndex((s) => s.v === "dark");
    expect(firstDark).toBeGreaterThanOrEqual(0);
    expect(schemes[firstDark]!.body).toBe(false);
    expect(schemes.slice(firstDark).every((s) => s.v === "dark")).toBe(true);
    expect(await tgCalled(page, "CloudStorage.getItem")).toBeGreaterThan(0);
  });

  test("«Как в Telegram» следует за Telegram; явный выбор — нет; тема с сервера notebook_dark не перебивает «Светлая»", async ({ page }) => {
    const darkConfig: ExperienceConfig = { ...F.CONFIG, version: "1.1.0", theme: { id: "notebook_dark", version: "1.1.0", tokens: { "--paper": "#0B0F24" } } };
    await openTg(page, { platform: "android", colorScheme: "light" }, { config: darkConfig });
    await expect(page.getByTestId("today-card")).toBeVisible();
    // the server's notebook_dark does not pin the scheme: «Как в Telegram» + Telegram light → light
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "light");
    await tgSetScheme(page, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
    // its colour tokens tune the dark notebook
    expect(await paper(page)).toBe("#0B0F24");
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-theme").click();
    await page.getByTestId("theme-light").click();
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "light");
    await tgSetScheme(page, "dark");
    await settle(page);
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "light");
    expect(await paper(page)).not.toBe("#0B0F24");
  });

  test("вне Telegram выбор хранится на устройстве (localStorage)", async ({ page }) => {
    await open(page, { onboarded: true, seen: ALL_SEEN });
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-theme").click();
    await expect(page.getByText("Выбор сохранён на этом устройстве.")).toBeVisible();
    await page.getByTestId("theme-dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("tilhero:theme_pref"))).toBe("dark");
    await page.reload();
    await expect(page.getByTestId("today-card")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
  });
});

/* ------------------------------------------------------------------ 4. «Начать занятие» */

test.describe("4 · «Начать занятие»", () => {
  test("главная: «Начать занятие» — главная кнопка, ведёт на «Уроки — скоро»; «Отметить занятие» — ниже и работает", async ({ page }) => {
    const bff = await open(page, { onboarded: true, seen: ALL_SEEN });
    const start = page.getByTestId("start-lesson");
    const mark = page.getByTestId("mark-activity");
    await expect(start).toHaveText("Начать занятие");
    await expect(start).toHaveClass(/(^|\s)btn(\s|$)/);
    await expect(mark).toHaveClass(/btn2/);
    const [s, m] = [(await start.boundingBox())!, (await mark.boundingBox())!];
    expect(m.y).toBeGreaterThan(s.y + s.height - 1);
    await shot(page, "22_home_start");
    await start.click();
    await expect(page.getByTestId("soon-lessons")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Уроки — скоро" })).toBeVisible();
    await expect(page.getByTestId("tab-lessons")).toHaveAttribute("aria-current", "page");
    await shot(page, "23_lessons_soon");
    await page.getByTestId("tab-home").click();
    await mark.click();
    await expect(page.getByTestId("toast")).toHaveText("Занятие отмечено: +20 мин");
    expect(bff.last("POST", "/v1/plan/activity")?.body).toEqual({ kind: "practice", minutes: 20 });
  });
});

/* ------------------------------------------------------------------ 5. goal and level after onboarding */

test.describe("5 · цель и уровень", () => {
  test("Профиль → «Цель и уровень»: цель, уровень и темы как в онбординге; PATCH с If-Match; после перезапуска — то же", async ({ page }) => {
    const bff = await open(page, { onboarded: true, seen: ALL_SEEN });
    await page.getByTestId("tab-profile").click();
    const row = page.getByTestId("row-goal");
    await expect(row).toContainText("Путешествия · Немного знаю");
    await row.click();
    const screen = page.getByTestId("goal-screen");
    await expect(page.getByRole("heading", { name: "Цель и уровень" })).toBeVisible();
    const goals = page.getByTestId("goal-picker");
    // the same options and labels as in onboarding (GET /v1/directory/goals)
    for (const g of F.GOALS) await expect(goals.getByRole("button", { name: g.label.ru })).toBeVisible();
    await expect(goals.getByRole("button", { name: "Путешествия" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("level-beginner")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("goal-save")).toBeDisabled();
    await goals.getByRole("button", { name: "Работа" }).click();
    await page.getByTestId("level-some").click();
    const topics = page.getByTestId("topics-picker");
    await topics.getByRole("button", { name: "Работа и офис" }).click();
    await topics.getByRole("button", { name: "Собеседование" }).click();
    await expect(page.getByTestId("topics-count")).toHaveText("Выбрано 2 из 5");
    await screen.evaluate((el) => el.scrollTo(0, 0));
    await shot(page, "24_goal");
    await page.getByTestId("goal-save").click();
    await expect(page.getByTestId("toast")).toHaveText("Цель и уровень сохранены");
    const patch = bff.last("PATCH", "/v1/plan")!;
    expect(patch.headers["if-match"]).toBe("4");
    expect(patch.body).toEqual({ goal: "work", level_self: "some", topics: ["work", "interview"] });
    await expect(page.getByTestId("goal-save")).toBeDisabled();
    await expect(screen).toBeVisible();
    await page.getByTestId("bar-back").click();
    await expect(page.getByTestId("row-goal")).toContainText("Работа · Объясняюсь");

    await page.reload();
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("row-goal")).toContainText("Работа · Объясняюсь");
    await page.getByTestId("row-goal").click();
    await expect(page.getByTestId("topics-picker").getByRole("button", { name: "Собеседование" })).toHaveAttribute("aria-pressed", "true");
  });

  test("не больше 5 тем; 409 (план изменён на другом устройстве) → показываем актуальный план", async ({ page }) => {
    const bff = await open(page, { onboarded: true, seen: ALL_SEEN, conflictOnce: true });
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-goal").click();
    const topics = page.getByTestId("topics-picker");
    for (const n of ["Знакомство и разговор", "Поездки и транспорт", "Кафе и еда", "Покупки", "Учёба"]) await topics.getByRole("button", { name: n }).click();
    await expect(page.getByTestId("topics-count")).toHaveText("Выбрано 5 из 5");
    await expect(topics.getByRole("button", { name: "Технологии" })).toBeDisabled();
    await topics.getByRole("button", { name: "Покупки" }).click();
    await expect(topics.getByRole("button", { name: "Технологии" })).toBeEnabled();
    await page.getByTestId("goal-picker").getByRole("button", { name: "Экзамен" }).click();
    await page.getByTestId("goal-save").click();
    await expect(page.getByTestId("goal-conflict")).toHaveText("План изменился на другом устройстве — показываем актуальный.");
    // the current plan of the server replaced the draft
    await expect(page.getByTestId("goal-picker").getByRole("button", { name: "Путешествия" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("topics-count")).toHaveText("Выбрано 0 из 5");
    expect(bff.calls("GET", "/v1/plan").length).toBeGreaterThan(1);
    // a new attempt goes with the new version
    await page.getByTestId("goal-picker").getByRole("button", { name: "Экзамен" }).click();
    await page.getByTestId("goal-save").click();
    await expect(page.getByTestId("toast")).toHaveText("Цель и уровень сохранены");
    expect(bff.last("PATCH", "/v1/plan")!.headers["if-match"]).toBe("5");
    expect(bff.plan().goal).toBe("exam");
  });

  test("UZ: новые строки профиля и экран цели — только латиница", async ({ page }) => {
    await openTg(page, { platform: "android", languageCode: "uz", homeScreen: { status: "missed" } }, { locale: "uz" });
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("row-goal")).toContainText("Maqsad va daraja");
    await expect(page.getByTestId("row-goal")).toContainText("Sayohat · Biroz bilaman");
    await expect(page.getByTestId("row-theme")).toContainText("Rang mavzusi");
    await expect(page.getByTestId("row-theme")).toContainText("Telegramdagidek");
    await expect(page.getByTestId("hs-row")).toContainText("Bosh ekranga qoʻshish");
    // the only Cyrillic left: the name of the Russian language and the learner's own name
    expect(CYRILLIC.test((await page.locator(".app").innerText()).replace("Русский", "").replaceAll("Азиз", "").replace("А", ""))).toBe(false);
    await page.getByTestId("row-goal").click();
    await expect(page.getByRole("heading", { name: "Maqsad va daraja" })).toBeVisible();
    await expect(page.getByTestId("topics-picker").getByRole("button", { name: "Kafe va taomlar" })).toBeVisible();
    expect(CYRILLIC.test(await page.locator(".app").innerText())).toBe(false);
    await tgBack(page);
    await page.getByTestId("tab-home").click();
    await expect(page.getByTestId("start-lesson")).toHaveText("Mashgʻulotni boshlash");
  });
});

/* ------------------------------------------------------------------ 3 viewports (CONVENTIONS §7) */

for (const vp of [
  { width: 390, height: 844 },
  { width: 375, height: 812 },
  { width: 412, height: 915 },
]) {
  test(`new screens fit ${vp.width}x${vp.height}: full-screen header, profile rows, theme, goal (no horizontal scroll)`, async ({ page }) => {
    await page.setViewportSize(vp);
    await openTg(page, { platform: "ios", fullscreen: IOS_FULLSCREEN, homeScreen: { status: "missed" } });
    await expect(page.getByTestId("start-lesson")).toBeVisible();
    expect(await top(page, "header.bar")).toBeGreaterThanOrEqual(SAFE_TOP);
    const noHScroll = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".app, .scroll")].every((el) => el.scrollWidth <= el.clientWidth + 1));
    expect(await noHScroll()).toBe(true);
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("hs-row")).toBeVisible();
    expect(await noHScroll()).toBe(true);
    await page.getByTestId("row-theme").click();
    await expect(page.getByTestId("theme-dark")).toBeInViewport();
    expect(await top(page, "header.bar")).toBeGreaterThanOrEqual(SAFE_TOP);
    await tgBack(page);
    await page.getByTestId("row-goal").click();
    await expect(page.getByTestId("goal-picker")).toBeVisible();
    expect(await top(page, "header.bar")).toBeGreaterThanOrEqual(SAFE_TOP);
    const save = (await page.getByTestId("goal-save").boundingBox())!;
    expect(save.y + save.height).toBeLessThanOrEqual(vp.height - IOS_FULLSCREEN.safe.bottom + 0.5);
    expect(await noHScroll()).toBe(true);
  });
}

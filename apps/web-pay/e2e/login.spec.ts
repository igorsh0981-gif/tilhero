/**
 * Вход на сайт оплаты (AT-86): «Войти через Telegram» — навигация на /api/auth/start (без SDK и всплывающих окон);
 * после входа адрес — «/» (без code/state); ошибки входа из ?login_error= показываются и убираются из адреса;
 * истёкшая сессия — снова вход; выход отзывает сессию (POST с CSRF).
 */
import { expect, test } from "@playwright/test";
import { CSRF } from "./fixtures/mock-bff";
import { expectAddress, expectClean, expectCleanUrls, setup } from "./helpers";

test("без сессии — экран входа; вход перенаправлениями → тарифы, адрес очищен", async ({ page }) => {
  const w = await setup(page, { loggedIn: false });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Подписка TilHero и тилы" })).toBeVisible();
  // ни Telegram SDK, ни сторонних скриптов: только свой бандл
  const scripts = await page.locator("script[src]").evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).src));
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/assets\/index-[\w-]+\.js$/);
  await expect(page.locator("iframe")).toHaveCount(0);

  const popups: unknown[] = [];
  page.on("popup", (p) => popups.push(p));
  await page.getByRole("button", { name: "Войти через Telegram" }).click();
  await expect(page.getByRole("heading", { name: "Ваша подписка" })).toBeVisible();
  await expectAddress(page, "/");
  expect(popups).toEqual([]);
  expect(w.bff.requests.map((r) => `${r.method} ${r.path}`)).toContain("GET /auth/start");
  expectClean(w);
  expectCleanUrls(w);
});

for (const [code, text] of [
  ["auth_failed", "Не удалось войти через Telegram"],
  ["account_not_found", "Аккаунт TilHero не найден. Сначала откройте TilHero в Telegram"],
  ["not_allowed", "Вход недоступен: профиль удаляется"],
] as const) {
  test(`?login_error=${code} — сообщение, адрес очищается`, async ({ page }) => {
    const w = await setup(page, { loggedIn: false });
    await page.goto(`/?login_error=${code}`);
    await expect(page.getByRole("alert")).toContainText(text);
    await expectAddress(page, "/");
    expectClean(w);
  });
}

test("неизвестный login_error и посторонние параметры — без сообщения, адрес очищается", async ({ page }) => {
  await setup(page, { loggedIn: false });
  await page.goto("/?login_error=<script>&name=Igor");
  await expect(page.getByRole("button", { name: "Войти через Telegram" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectAddress(page, "/");
});

test("вход не удался на стороне Telegram → ошибка на экране входа", async ({ page }) => {
  const w = await setup(page, { loggedIn: false, loginOutcome: "account_not_found" });
  await page.goto("/");
  await page.getByRole("button", { name: "Войти через Telegram" }).click();
  await expect(page.getByRole("alert")).toContainText("Аккаунт TilHero не найден");
  await expectAddress(page, "/");
  expectCleanUrls(w);
});

test("сессия истекла посреди работы (401) → экран входа с пояснением", async ({ page }) => {
  const w = await setup(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ваша подписка" })).toBeVisible();
  w.bff.loggedIn = false;
  await page.getByRole("link", { name: "Мои заказы" }).click();
  await expect(page.getByRole("alert")).toContainText("Сессия истекла — войдите снова");
  await expect(page.getByRole("button", { name: "Войти через Telegram" })).toBeVisible();
});

test("выход: POST /auth/logout с CSRF-токеном → экран входа", async ({ page }) => {
  const w = await setup(page);
  await page.goto("/orders");
  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page.getByRole("button", { name: "Войти через Telegram" })).toBeVisible();
  const logout = w.bff.posts("/auth/logout");
  expect(logout).toHaveLength(1);
  expect(logout[0]!.headers["x-csrf-token"]).toBe(CSRF);
  await expectAddress(page, "/");
});

test("UZ: экран входа на узбекском (латиница, U+02BB)", async ({ page }) => {
  await setup(page, { loggedIn: false });
  await page.goto("/");
  await page.getByRole("button", { name: "Oʻzbekcha" }).click();
  await expect(page.getByRole("button", { name: "Telegram orqali kirish" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "uz-Latn");
  const text = await page.locator("main").innerText();
  expect(text).toContain("ʻ");
  expect(text).not.toMatch(/[oOgG][‘’'`]/);
  // выбор языка сохраняется
  await page.reload();
  await expect(page.getByRole("button", { name: "Telegram orqali kirish" })).toBeVisible();
});

import { expect, test, type Page } from "@playwright/test";
import { ALERT9, DEL } from "./fixtures/ops";
import { CYRILLIC, expectNoHScroll, openAs, settle, typeOtp } from "./helpers";
import type { MockBff } from "./fixtures/mock-bff";

/* Sprint 9, Q4: «Users → Deletions», «Monitoring → Limits», runbook in alerts, one 429 text, Idempotent-Replayed —
   screenshots → shots/sprint9/. Mock admin-bff only (no stand). */

const SHOTS = "shots/sprint9";
async function shot(page: Page, name: string, fullPage = false) {
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}
async function again(page: Page, email: string, hash: string, sc: Parameters<typeof openAs>[3] = {}) {
  await page.goto("about:blank");
  return openAs(page, email, hash, sc);
}
async function lastCall(bff: MockBff, method: string, path: string | RegExp) {
  await expect.poll(() => bff.calls(method, path).length).toBeGreaterThan(0);
  return bff.calls(method, path).at(-1)!;
}
async function totp(page: Page) {
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", "123456");
  await expect(page.getByTestId("stepup")).toHaveCount(0);
}
async function dark(page: Page) {
  await page.locator("html").evaluate((el) => el.setAttribute("data-theme", "dark"));
}
async function light(page: Page) {
  await page.locator("html").evaluate((el) => el.removeAttribute("data-theme"));
}
const rlRow = (page: Page, policy: string) => page.locator(`[data-testid="rl-row"][data-policy="${policy}"]`);
const delRow = (page: Page, id: string) => page.locator(`[data-testid="del-row"][data-request="${id}"]`);

test.describe("width 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("limits: policies by service, rejections and overrides; the drawer with history and top subjects", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/monitoring/limits");
    await expect(page.getByTestId("mon-tab-limits")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("rl-row")).toHaveCount(18);
    await expect(page.getByTestId("rl-k-rejected")).toContainText("189");
    await expect(page.getByTestId("rl-k-overridden")).toContainText("1");
    const user = rlRow(page, "tg.user");
    await expect(user).toContainText("120 / мин");
    await expect(user.getByTestId("rl-rejected")).toContainText("184");
    await expect(user.getByTestId("rl-rejected").locator("svg")).toHaveCount(1); // not colour alone
    await expect(user.getByTestId("rl-fail")).toHaveText(/пропускать/);
    const login = rlRow(page, "adm.login_ip");
    await expect(login.getByTestId("rl-overridden")).toBeVisible();
    await expect(login.getByTestId("rl-default")).toContainText("по умолчанию 10 / мин");
    await expect(login.getByTestId("rl-fail")).toHaveText(/отказывать/);
    await expect(rlRow(page, "tg.support_create")).toContainText("10 / ч");
    await expect(page.getByTestId("rl-providers")).toContainText("Aviasales");
    await expectNoHScroll(page);
    await shot(page, "01-limits-light", true);
    await dark(page);
    await shot(page, "02-limits-dark", true);
    await light(page);

    const hist = page.waitForRequest((r) => r.url().includes("/ops/ratelimits/tg.user/history?range=24h"));
    await user.click();
    await hist;
    await expect(page).toHaveURL(/#\/monitoring\/limits\/tg\.user$/);
    const d = page.getByTestId("rl-drawer");
    await expect(d.getByTestId("rl-chart")).toBeVisible();
    await expect(d.getByTestId("rl-top").locator("li")).toHaveCount(3);
    await expect(d).toContainText("Псевдонимы");
    await shot(page, "03-limit-drawer-light");
    const week = page.waitForRequest((r) => r.url().includes("/history?range=7d"));
    await d.getByTestId("rl-range").getByRole("button", { name: "7 дней" }).click();
    await week;
    await dark(page);
    await shot(page, "04-limit-drawer-dark");
    await light(page);
    await page.getByTestId("drawer-close").click();
    await expect(page).toHaveURL(/#\/monitoring\/limits$/);
  });

  test("limits: override with a reason, a term and TOTP; too strict is refused in the form; reset; Redis down; repeat = same key", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/monitoring/limits");
    await rlRow(page, "tg.user").getByTestId("rl-override").click();
    const dlg = page.getByTestId("rl-override-dialog");
    await expect(dlg.getByTestId("rl-override-ok")).toBeDisabled();
    await dlg.getByTestId("rl-limit").fill("240");
    await expect(dlg.getByTestId("rl-preview")).toContainText("≈ 240 в минуту (сейчас 120)");
    await dlg.getByTestId("rl-ttl").selectOption("24");
    await dlg.getByTestId("rl-reason").fill("Акция в Mini App, ожидаем рост запросов");
    await shot(page, "05-limit-override-light");
    await dlg.getByTestId("rl-override-ok").click();
    await totp(page);
    await expect(page.getByTestId("toasts")).toContainText("tg.user: теперь 240 / мин");
    const put = await lastCall(bff, "PUT", "/ops/ratelimits/tg.user/override");
    expect(put.body).toMatchObject({ limit: 240, window_s: 60, reason: "Акция в Mini App, ожидаем рост запросов" });
    expect(Date.parse((put.body as { expires_at: string }).expires_at) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(put.headers["idempotency-key"]).toMatch(/^rl-/);
    await expect(rlRow(page, "tg.user")).toContainText("240 / мин");
    await expect(rlRow(page, "tg.user").getByTestId("rl-overridden")).toBeVisible();

    // a fail-closed policy below 1 request per minute is refused before the request
    await rlRow(page, "tg.session_ip").getByTestId("rl-override").click();
    await dlg.getByTestId("rl-limit").fill("1");
    await dlg.getByTestId("rl-window").selectOption("86400");
    await dlg.getByTestId("rl-reason").fill("Проверка защиты");
    await expect(dlg.getByTestId("rl-too-strict")).toBeVisible();
    await expect(dlg.getByTestId("rl-override-ok")).toBeDisabled();
    await shot(page, "06-limit-too-strict-light");
    await dlg.getByRole("button", { name: "Отмена" }).click();

    // review of sprint 9: loosening a fail-closed policy — a warning, a term ≤ 24 h; more than ×10 — refused in the form
    await rlRow(page, "tg.pin").getByTestId("rl-override").click();
    await dlg.getByTestId("rl-ttl").selectOption("none");
    await dlg.getByTestId("rl-limit").fill("20");
    await dlg.getByTestId("rl-reason").fill("Пользователи жалуются на блокировку PIN");
    await expect(dlg.getByTestId("rl-weakens")).toContainText("ослабляет защиту входа");
    await expect(dlg.getByTestId("rl-ttl")).toHaveValue("24"); // «до сброса» сменилось на сутки
    await expect(dlg.getByTestId("rl-ttl").locator("option")).toHaveText(["1 час", "24 часа"]);
    await shot(page, "06b-limit-weakens-light");
    await dlg.getByTestId("rl-limit").fill("51");
    await expect(dlg.getByTestId("rl-too-loose")).toBeVisible();
    await expect(dlg.getByTestId("rl-override-ok")).toBeDisabled();
    await shot(page, "06c-limit-too-loose-light");
    await dlg.getByTestId("rl-limit").fill("20");
    await dlg.getByTestId("rl-override-ok").click(); // step-up of the first override is still valid
    const loosened = await lastCall(bff, "PUT", "/ops/ratelimits/tg.pin/override");
    expect(loosened.body).toMatchObject({ limit: 20, window_s: 60 });
    expect(Date.parse(String((loosened.body as Record<string, unknown>).expires_at)) - Date.now()).toBeLessThanOrEqual(24 * 3_600_000 + 60_000);
    await expect(rlRow(page, "tg.pin").getByTestId("rl-overridden")).toBeVisible();

    // reset the override of adm.login_ip
    await rlRow(page, "adm.login_ip").getByTestId("rl-reset").click();
    await expect(page.getByTestId("rl-reset-dialog")).toContainText("Вернётся значение по умолчанию: 10 / мин");
    await page.getByTestId("rl-reset-reason").fill("Обучение закончилось");
    await page.getByTestId("rl-reset-ok").click();
    await expect(page.getByTestId("toasts")).toContainText("adm.login_ip: значение по умолчанию 10 / мин");
    expect((await lastCall(bff, "DELETE", "/ops/ratelimits/adm.login_ip/override")).body).toEqual({ reason: "Обучение закончилось" });
    await expect(rlRow(page, "adm.login_ip").getByTestId("rl-overridden")).toHaveCount(0);

    // Redis of the limits is down: nothing changed, the dialog says why; a repeat is the same command (same key)
    const bff2 = await again(page, "ops@tilhero.local", "#/monitoring/limits", { rlRedisDown: true });
    await rlRow(page, "tg.offers").getByTestId("rl-override").click();
    await dlg.getByTestId("rl-limit").fill("40");
    await dlg.getByTestId("rl-reason").fill("Новый сценарий поездок");
    await dlg.getByTestId("rl-override-ok").click();
    await totp(page);
    await expect(dlg).toContainText("Хранилище лимитов (Redis) недоступно");
    await dlg.getByTestId("rl-override-ok").click();
    await expect.poll(() => bff2.calls("PUT", "/ops/ratelimits/tg.offers/override").length).toBe(3); // step-up, after TOTP, repeat
    expect(new Set(bff2.calls("PUT", "/ops/ratelimits/tg.offers/override").map((c) => c.headers["idempotency-key"])).size).toBe(1);
    await shot(page, "07-limit-redis-down-light");
  });

  test("deletions: open / stuck / completed, the card with domains and sends, retry with a reason and TOTP; no «close»", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/users/deletions");
    await expect(page.getByTestId("users-tab-deletions")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("page-title")).toHaveText("Удаления");
    await expect(page.getByTestId("del-row")).toHaveCount(3);
    await expect(page.getByTestId("del-stuck-note")).toContainText("1 удаление зависло");
    const stuck = delRow(page, DEL.stuck);
    await expect(stuck.getByTestId("del-status")).toHaveText(/Зависло/);
    await expect(stuck).toContainText("8 из 9");
    await expect(stuck.getByTestId("del-pending")).toHaveText("watch");
    await expect(page.getByTestId("deletions")).not.toContainText("@"); // no usernames / e-mails
    await expectNoHScroll(page);
    await shot(page, "10-deletions-light", true);
    await dark(page);
    await shot(page, "11-deletions-dark", true);
    await light(page);

    await page.getByTestId("del-filter").getByRole("button", { name: "Зависшие" }).click();
    await expect(page).toHaveURL(/#\/users\/deletions\/stuck$/);
    await expect(page.getByTestId("del-row")).toHaveCount(1);
    await page.getByTestId("del-filter").getByRole("button", { name: "Завершённые" }).click();
    await expect(page.getByTestId("del-row")).toHaveCount(1);
    await delRow(page, DEL.done).click();
    await expect(page.getByTestId("del-drawer")).toContainText("Завершено");
    await expect(page.getByTestId("del-retry")).toHaveCount(0);
    await page.getByTestId("drawer-close").click();

    await page.getByTestId("del-filter").getByRole("button", { name: "Открытые" }).click();
    await stuck.click();
    await expect(page).toHaveURL(new RegExp(`#/users/deletions/${DEL.stuck}$`));
    const d = page.getByTestId("del-drawer");
    await expect(d.locator('[data-domain="watch"]')).toHaveAttribute("data-acked", "false");
    await expect(d.locator('[data-domain="watch"]')).toContainText("ждём подтверждения");
    await expect(d.getByTestId("del-history").locator("li")).toHaveCount(6);
    await expect(d.getByTestId("del-history")).toContainText("таймер саги");
    await expect(d.getByTestId("del-d-stuck")).toBeVisible();
    await expect(d).not.toContainText("Закрыть удаление");
    await shot(page, "12-deletion-card-light");
    await d.getByTestId("del-retry").click();
    const r = page.getByTestId("del-retry-dialog");
    await expect(r).toContainText("watch");
    await r.getByTestId("del-reason").fill("Сервис watch восстановлен после сбоя");
    await shot(page, "13-deletion-retry-light");
    await r.getByTestId("del-retry-ok").click();
    await totp(page);
    await expect(page.getByTestId("toasts")).toContainText("рассылка № 7");
    const call = await lastCall(bff, "POST", `/deletions/${DEL.stuck}:retry`);
    expect(call.body).toEqual({ reason: "Сервис watch восстановлен после сбоя" });
    expect(call.headers["idempotency-key"]).toMatch(/^del-retry-/);
    await expect(d.getByTestId("del-history").locator("li").first()).toContainText("№ 7");
    await expect(d.getByTestId("del-history").locator("li").first()).toContainText("Тимур");
    await expect(stuck).toContainText("7"); // the row followed
  });

  test("deletions: retry too soon (countdown), audit down; a legacy acknowledgement; rights", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", `#/users/deletions/${DEL.legacy}`, { delTooSoon: true });
    const d = page.getByTestId("del-drawer");
    await expect(d.locator('[data-domain="preferences"]')).toContainText("подтвердил (время неизвестно)");
    await expect(d.locator('[data-domain="offers"]')).toHaveAttribute("data-acked", "false");
    await d.getByTestId("del-retry").click();
    await page.getByTestId("del-reason").fill("Повтор для offers");
    await page.getByTestId("del-retry-ok").click();
    await totp(page);
    await expect(page.getByTestId("del-too-soon")).toContainText(/повторить можно через 2\d\d с/);
    await expect(page.getByTestId("del-retry-ok")).toBeDisabled();
    await shot(page, "14-deletion-too-soon-light");

    await again(page, "ops@tilhero.local", `#/users/deletions/${DEL.open}`, { auditDown: true });
    await page.getByTestId("del-retry").click();
    await page.getByTestId("del-reason").fill("Повтор");
    await page.getByTestId("del-retry-ok").click();
    await totp(page);
    await expect(page.getByTestId("del-retry-dialog")).toContainText("аудит");

    // support: reads deletions (users.read) but cannot retry (ops.queues.manage)
    await again(page, "support@tilhero.local", `#/users/deletions/${DEL.stuck}`);
    await expect(page.getByTestId("del-retry")).toHaveClass(/is-locked/);
    await expect(page.getByTestId("del-drawer")).toContainText("ops.queues.manage");
    // read_only has no «Users»: a deep link is refused
    await again(page, "audit@tilhero.local", "#/users/deletions");
    await expect(page.getByTestId("toasts")).toContainText("недоступен");
  });

  test("alerts of sprint 9: words, «Runbook» (https, new tab) in the list, the bell and the urgent strip; «Open» leads to the place", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/dashboard", { s9Alerts: true });
    const crit = page.getByTestId("dash-crit");
    await expect(crit).toContainText("news");
    await expect(crit).toContainText("сервис не готов");
    const rb = crit.getByTestId("dash-crit-runbook");
    await expect(rb).toHaveAttribute("href", /^https:\/\/github\.com\/.+news\.md#service-down$/);
    await expect(rb).toHaveAttribute("target", "_blank");
    await expect(rb).toHaveAttribute("rel", /noopener/);
    await expect(page.getByTestId("dash-sys-deletions")).toContainText("зависло 1 из 3");
    await shot(page, "20-dashboard-alerts-light");

    await page.getByTestId("bell").click();
    await expect(page.getByTestId("bell-list").locator(`[data-alert="${ALERT9.deletion}"]`)).toContainText("Удаление профиля");
    await expect(page.getByTestId("bell-list").getByTestId("bell-runbook").first()).toBeVisible();
    await shot(page, "21-bell-runbook-light");
    await page.getByTestId("bell-list").locator(`[data-alert="${ALERT9.deletion}"] .bell-item`).click();
    await expect(page).toHaveURL(/#\/users\/deletions\/stuck$/);

    await page.goto("/#/monitoring/alerts");
    const spike = page.locator(`[data-testid="mon-alert"][data-alert="${ALERT9.spike}"]`);
    await expect(spike).toContainText("Лимит tg.user");
    await expect(spike).toContainText("отказов 184 за 5 мин");
    await expect(spike.getByTestId("mon-alert-runbook")).toHaveAttribute("href", /rate-limits\.md#rate-limit-spike$/);
    await shot(page, "22-alerts-runbook-light", true);
    await spike.getByTestId("mon-alert-go").click();
    await expect(page).toHaveURL(/#\/monitoring\/limits\/tg\.user$/);
    await expect(page.getByTestId("rl-drawer")).toBeVisible();
  });

  test("429 RATE_LIMITED: live countdown, the confirm button waits, no automatic repeat (as in the Mini App)", async ({ page }) => {
    await page.clock.install();
    const bff = await openAs(page, "ops@tilhero.local", "#/monitoring/alerts", { rateLimitedOnce: "POST /alerts/ops/0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a60/ack" });
    await page.locator('[data-alert="0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a60"]').getByTestId("mon-alert-ack").click();
    await page.getByTestId("mon-ack-ok").click();
    const live = page.getByTestId("modal-rate-wait");
    await expect(live.getByTestId("modal-rate-wait-visible")).toHaveText("Слишком много запросов — повторите через 12 с");
    await expect(live.getByTestId("modal-rate-wait-visible")).toHaveAttribute("aria-hidden", "true"); // read once, not every second
    await expect(page.getByTestId("mon-ack")).toContainText("Слишком много запросов — подождите немного и повторите"); // no frozen seconds
    await expect(page.getByTestId("mon-ack-ok")).toBeDisabled();
    await shot(page, "23-rate-limited-light");
    await page.clock.fastForward(5000);
    await expect(live.getByTestId("modal-rate-wait-visible")).toHaveText(/повторите через [78]\s?с/);
    await page.clock.fastForward(8000);
    await expect(live).toHaveCount(0);
    await expect(page.getByTestId("mon-ack-ok")).toBeEnabled();
    expect(bff.calls("POST", /\/alerts\/ops\/.+\/ack$/)).toHaveLength(1);
  });

  test("EN: limits and deletions without Cyrillic outside data", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/monitoring/limits");
    await page.getByTestId("lang-en").click();
    await expect(page.getByTestId("rl-row").first()).toBeVisible();
    const strip = async (id: string) =>
      page.getByTestId(id).evaluate((el) => {
        const c = el.cloneNode(true) as HTMLElement;
        c.querySelectorAll(".wrap-any, td .xs, .mono").forEach((n) => n.remove());
        return c.innerText;
      });
    expect(await strip("mon-limits")).not.toMatch(CYRILLIC);
    await page.goto("/#/users/deletions");
    await expect(page.getByTestId("del-row").first()).toBeVisible();
    expect(await strip("deletions")).not.toMatch(CYRILLIC);
    await shot(page, "24-deletions-en-light");
  });
});

for (const w of [1024, 768, 400] as const) {
  test.describe(`width ${w}`, () => {
    test.use({ viewport: { width: w, height: w === 400 ? 860 : 900 } });

    test(`limits and deletions fit ${w} px, light and dark`, async ({ page }) => {
      await openAs(page, "ops@tilhero.local", "#/monitoring/limits");
      await expect(page.getByTestId("rl-row").first()).toBeVisible();
      await expectNoHScroll(page);
      await shot(page, `w${w}-limits-light`, true);
      await page.goto("/#/users/deletions");
      await expect(page.getByTestId("del-row").first()).toBeVisible();
      await expectNoHScroll(page);
      await shot(page, `w${w}-deletions-light`, true);
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(`/#/users/deletions/${DEL.stuck}`);
      await expect(page.getByTestId("del-domains")).toBeVisible();
      await expectNoHScroll(page);
      await shot(page, `w${w}-deletion-card-dark`);
      await page.goto("/#/monitoring/limits/tg.user");
      await expect(page.getByTestId("rl-chart")).toBeVisible();
      await shot(page, `w${w}-limit-drawer-dark`);
    });
  });
}

import { expect, test, type Page } from "@playwright/test";
import { CYRILLIC, expectNoHScroll, openAs, setTheme, settle } from "./helpers";

/* Fix 5.1 (docs/sprint5/FEEDBACK_5_1.md §E, §F): provider diagnosis + «Check now»; bulk reject, «Not confirmed»,
 * back to the queue → apps/admin-web/shots/fix51/. */

const DIR = "shots/fix51";
async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  await settle(page);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage });
}
async function cardShot(page: Page, testId: string, name: string): Promise<void> {
  await settle(page);
  await page.getByTestId(testId).screenshot({ path: `${DIR}/${name}.png` });
}
async function again(page: Page, email: string, hash: string, sc: Parameters<typeof openAs>[3] = {}) {
  await page.goto("about:blank");
  return openAs(page, email, hash, sc);
}
const rid = (n: number) => `7e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (page: Page, n: number) => page.locator(`[data-review="${rid(n)}"]`);

test.describe("trip providers: diagnosis and «Check now» (1440)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the last error explained with «what to do»: provider message, revoked key, unexpected format; light and dark", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/travel", { providers: "diag" });
    await expect(page.getByTestId("trv-summary")).toContainText("Требуют внимания: 3 из 4");
    // Aviasales: the customer's case — PROVIDER_BAD_RESPONSE with the provider's own message
    await expect(page.getByTestId("trv-why-aviasales")).toHaveText("Поставщик вернул ошибку: «No prices found for TAS-FRU on 2026-11-13»");
    await expect(page.getByTestId("trv-last-error-aviasales")).toContainText("success_false");
    await expect(page.getByTestId("trv-fix-aviasales")).toContainText("Что делать");
    await expect(page.getByTestId("trv-fix-aviasales")).toContainText("Проверить сейчас");
    await expect(page.getByTestId("trv-why-liteapi")).toHaveText("Ключ неверный или отозван");
    await expect(page.getByTestId("trv-last-error-liteapi")).toContainText("HTTP 401");
    await expect(page.getByTestId("trv-fix-liteapi")).toContainText("LITEAPI_KEY");
    await expect(page.getByTestId("trv-why-osm")).toHaveText("Неожиданный формат ответа");
    await expect(page.getByTestId("trv-cbu")).toContainText("Курсы валют ЦБ РУз");
    await expect(page.getByTestId("trv-state-cbu")).toHaveText("Работает");
    await expectNoHScroll(page);
    for (const mode of ["light", "dark"] as const) {
      await setTheme(page, mode);
      await shot(page, `01-travel-diag-${mode}`, true);
    }
    await setTheme(page, "light");
    await cardShot(page, "trv-aviasales", "02-card-success-false");
  });

  test("«Check now»: success refreshes the card, failure is explained, the button is locked for 30 s", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/travel", { providers: "diag", probe: { liteapi: "fail" } });
    await expect(page.getByTestId("trv-state-aviasales")).toHaveText("Последний вызов с ошибкой");
    await page.getByTestId("trv-probe-btn-aviasales").click();
    await expect(page.getByTestId("trv-probe-res-aviasales")).toContainText("Поставщик отвечает");
    await expect(page.getByTestId("trv-probe-res-aviasales")).toContainText("412 мс");
    // the card was re-read: the success is newer than the error now
    await expect(page.getByTestId("trv-state-aviasales")).toHaveText("Работает");
    await expect(page.getByTestId("trv-fix-aviasales")).toHaveCount(0);
    await expect(page.getByTestId("trv-probe-btn-aviasales")).toBeDisabled();
    await expect(page.getByTestId("trv-probe-btn-aviasales")).toHaveText(/Повторить через \d+ с/);
    expect(bff.calls("POST", "/travel/providers/aviasales/probe")).toHaveLength(1);
    await cardShot(page, "trv-aviasales", "03-probe-ok");

    await page.getByTestId("trv-probe-btn-liteapi").click();
    await expect(page.getByTestId("trv-probe-res-liteapi")).toContainText("Проверка не прошла");
    await expect(page.getByTestId("trv-probe-fix-liteapi")).toContainText("Ключ неверный или отозван");
    await expect(page.getByTestId("trv-probe-fix-liteapi")).toContainText("LITEAPI_KEY");
    // one «what to do» per failure: the card's own hint gives way to the fresh check
    await expect(page.getByTestId("trv-fix-liteapi")).toHaveCount(0);
    await cardShot(page, "trv-liteapi", "04-probe-fail");
    for (const mode of ["dark"] as const) {
      await setTheme(page, mode);
      await cardShot(page, "trv-liteapi", `04-probe-fail-${mode}`);
    }
  });

  test("«Check now» 429: locked for retry_after with a countdown; old gateway — a clear text; EN", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/travel", { providers: "diag", probe: { osm: "limited", cbu: "unavailable" } });
    await page.getByTestId("trv-probe-btn-osm").click();
    await expect(page.getByTestId("trv-probe-res-osm")).toContainText(/Проверять можно раз в 30 секунд — повторите через 1[5-7] с/);
    await expect(page.getByTestId("trv-probe-btn-osm")).toBeDisabled();
    await cardShot(page, "trv-osm", "05-probe-429");
    await page.getByTestId("trv-probe-btn-cbu").click();
    await expect(page.getByTestId("trv-probe-err-cbu")).toContainText("provider-gateway нужно обновить");
    await cardShot(page, "trv-cbu", "06-probe-unavailable");
    await page.getByTestId("lang-en").click();
    await expect(page.getByTestId("trv-why-aviasales")).toContainText("The provider returned an error");
    const text = await page.getByTestId("travel").innerText();
    expect(text, text.match(/.{0,30}[Ѐ-ӿ]+.{0,30}/)?.[0]).not.toMatch(CYRILLIC);
    await shot(page, "07-travel-diag-en-light", true);
  });
});

test.describe("offer snapshot: ticket converted at the CBU rate (1440)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("«≈ $309 по курсу ЦБ РУз на 11.10 · 27 000 KGS», in the total; light and dark", async ({ page }) => {
    await openAs(page, "support@tilhero.local", "#/support/TCK-3074", { offer: "fx" });
    await expect(page.getByTestId("osn-body")).toBeVisible();
    await page.getByTestId("ctx-offer").evaluate((el) => el.scrollIntoView({ block: "start" }));
    const ticket = page.getByTestId("osn-ticket");
    await expect(ticket).toContainText("≈ $309");
    await expect(page.getByTestId("osn-fx")).toHaveText(/по курсу ЦБ РУз на 11\.10 · 27\s000 KGS/);
    await expect(ticket).not.toContainText("не входит в сумму");
    await expect(page.getByTestId("osn-total")).toContainText("$1292.00");
    for (const mode of ["light", "dark"] as const) {
      await setTheme(page, mode);
      await page.getByTestId("ctx-offer").evaluate((el) => el.scrollIntoView({ block: "start" }));
      await cardShot(page, "ctx-offer", `09-offer-fx-${mode}`);
    }
  });
});

test.describe("trip providers at 400 px", () => {
  test.use({ viewport: { width: 400, height: 860 }, hasTouch: true });

  test("diagnosis and «Check now» fit 400 px, light and dark", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/travel", { providers: "diag", probe: { liteapi: "fail" } });
    await page.getByTestId("trv-probe-btn-liteapi").click();
    await expect(page.getByTestId("trv-probe-fix-liteapi")).toBeVisible();
    await expectNoHScroll(page);
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await cardShot(page, "trv-liteapi", `08-w400-probe-fail-${mode}`);
    }
  });
});

test.describe("event review: bulk reject, «Not confirmed», back to the queue (1440)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("bulk reject: select all on the page, reason + comment, outcome «Rejected N, skipped M (why)»", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/review");
    await expect(page.getByTestId("review-table").locator("tbody tr")).toHaveCount(4);
    // auto-removal countdown of OPEN cards
    await expect(row(page, 1).getByTestId("rv-expires")).toHaveText("Снимется через 6 дн.");
    await expect(row(page, 2).getByTestId("rv-expires")).toHaveText("Снимется через 3 дн.");
    await expect(row(page, 3).getByTestId("rv-expires")).toHaveText("Снимется в течение суток");
    // a click on the checkbox cell selects, it does not open the card
    await row(page, 1).getByTestId("rv-sel").check();
    await expect(page.getByTestId("review-card")).toHaveCount(0);
    await expect(page.getByTestId("rv-bulk-n")).toHaveText("Выбрано: 1");
    await page.getByTestId("rv-sel-all").check();
    await expect(page.getByTestId("rv-bulk-n")).toHaveText("Выбрано: 4");
    await expect(page.getByTestId("rv-bulk-reject")).toHaveText("Отклонить выбранные (4)");
    await shot(page, "10-review-selected-light");
    await page.getByTestId("rv-bulk-reject").click();
    const dlg = page.getByTestId("rv-bulk-reject-dialog");
    await expect(dlg).toContainText("Отклонить 4 события?");
    await expect(page.getByTestId("rv-bulk-list").locator("li")).toHaveCount(4);
    // validation: reason and comment are required
    await page.getByTestId("rv-bulk-reject-ok").click();
    await expect(dlg).toContainText("Выберите причину отклонения");
    await page.getByTestId("rv-bulk-code").selectOption("NOT_AN_EVENT");
    await page.getByTestId("rv-bulk-note").fill("Реклама абонементов, не события");
    await shot(page, "11-bulk-reject-dialog-light");
    // meanwhile the source sent new facts for Jazz Nights → it is skipped with REVIEW_CHANGED
    bff.updateCandidate(rid(2), { title: "Jazz Nights: Tashkent Big Band & Guests" });
    await page.getByTestId("rv-bulk-reject-ok").click();
    await expect(page.getByTestId("rv-bulk-result-sum")).toHaveText("Отклонено 3, пропущено 1");
    await expect(page.getByTestId("rv-bulk-result")).toContainText("Карточка изменилась после загрузки списка");
    await expect(page.getByTestId("rv-bulk-result")).toContainText("Jazz Nights: Tashkent Big Band");
    await expect(page.getByTestId("review-table").locator("tbody tr")).toHaveCount(1);
    await expect(page.getByTestId("rv-bulk")).toHaveCount(0);
    const call = bff.calls("POST", "/review/bulk-reject")[0]!;
    expect(call.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.body).toMatchObject({ reason_code: "NOT_AN_EVENT", note: "Реклама абонементов, не события" });
    expect((call.body as { items: unknown[] }).items).toHaveLength(4);
    await shot(page, "12-bulk-result-light");
    await setTheme(page, "dark");
    await shot(page, "12-bulk-result-dark");
  });

  test("filter «Не подтверждено»: rows explain the auto-removal; return one row and the rest in bulk", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/review");
    await page.getByTestId("rv-status").selectOption("EXPIRED");
    await expect(page.getByTestId("review-table").locator("tbody tr")).toHaveCount(3);
    await expect(row(page, 6).getByTestId("rv-expired-note")).toHaveText("Не подтверждено автоматически: 7 дней без решения");
    await expect(row(page, 6)).toContainText("Не подтверждено");
    await expectNoHScroll(page);
    for (const mode of ["light", "dark"] as const) {
      await setTheme(page, mode);
      await shot(page, `13-expired-filter-${mode}`);
    }
    await setTheme(page, "light");

    // one row back to the queue
    await row(page, 6).getByTestId("rv-row-reopen").click();
    const dlg = page.getByTestId("rv-reopen-dialog");
    await expect(dlg).toContainText("получит новый срок — 7 дней");
    await dlg.locator("#cmd-reason").fill("Источник обновил дату");
    await shot(page, "14-reopen-dialog-light");
    await dlg.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toasts")).toContainText("Событие возвращено в очередь");
    await expect(page.getByTestId("review-table").locator("tbody tr")).toHaveCount(2);
    expect(bff.calls("POST", `/review/${rid(6)}/reopen`)[0]!.body).toEqual({ expected_status: "EXPIRED", note: "Источник обновил дату" });

    // the rest in bulk
    await page.getByTestId("rv-sel-all").check();
    await expect(page.getByTestId("rv-bulk-reopen")).toHaveText("Вернуть в очередь (2)");
    await page.getByTestId("rv-bulk-reopen").click();
    const bulk = page.getByTestId("rv-bulk-reopen-dialog");
    await expect(bulk).toContainText("Вернуть 2 события в очередь?");
    await bulk.locator("#cmd-reason").fill("Проверим заново после обновления источников");
    await bulk.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("rv-bulk-result-sum")).toHaveText("Возвращено в очередь 2, пропущено 0");
    await expect(page.getByTestId("rv-empty")).toContainText("Неподтверждённых нет");
    expect(bff.calls("POST", "/review/bulk-reopen")[0]!.headers["idempotency-key"]).toBeTruthy();
    await shot(page, "15-bulk-reopen-result-light");

    // back in «Ждёт проверки» with a fresh 7-day term
    await page.getByTestId("rv-status").selectOption("OPEN");
    await expect(row(page, 6)).toBeVisible();
    await expect(row(page, 6).getByTestId("rv-expires")).toHaveText("Снимется через 7 дн.");
  });

  test("card of an expired item: decided by the system, «Back to the queue» in the footer; EN without Cyrillic", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", `#/review/${rid(7)}`);
    const card = page.getByTestId("review-card");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("rv-decided-by")).toHaveText("Система (автоматически)");
    await expect(page.getByTestId("rv-decision-reason")).toHaveText("Не подтверждено автоматически: 7 дней без решения");
    await expect(page.getByTestId("rv-reopen")).toBeVisible();
    await shot(page, "16-expired-card-light");
    await page.getByTestId("rv-reopen").click();
    await page.getByTestId("rv-reopen-dialog").locator("#cmd-reason").fill("Площадка подтвердила дату");
    await page.getByTestId("rv-reopen-dialog").getByTestId("confirm-ok").click();
    await expect(card).toHaveCount(0);

    await again(page, "admin@tilhero.local", "#/review");
    await page.getByTestId("lang-en").click();
    await page.getByTestId("rv-status").selectOption("EXPIRED");
    await expect(row(page, 6).getByTestId("rv-expired-note")).toHaveText("Not confirmed automatically: 7 days without a decision");
    await page.getByTestId("rv-sel-all").check();
    await expect(page.getByTestId("rv-bulk-reopen")).toHaveText("Back to the queue (3)");
    const text = await page.locator(".toolbar, thead, .rv-bulk, [data-testid=rv-expired-note], [data-testid=rv-row-reopen]").allInnerTexts();
    expect(text.join(" ")).not.toMatch(CYRILLIC);
    await shot(page, "17-expired-en-light");
  });

  test("support role has no events.review: no review menu", async ({ page }) => {
    await openAs(page, "support@tilhero.local", "");
    await expect(page.locator('[data-nav="review"]')).toHaveCount(0);
  });
});

test.describe("event review at 400 px", () => {
  test.use({ viewport: { width: 400, height: 860 }, hasTouch: true });

  test("selection bar and «Not confirmed» rows fit 400 px (the table scrolls inside), light and dark", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/review");
    await page.getByTestId("rv-status").selectOption("EXPIRED");
    await page.getByTestId("rv-sel-all").check();
    await expect(page.getByTestId("rv-bulk")).toBeVisible();
    await expectNoHScroll(page);
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await shot(page, `18-w400-expired-${mode}`);
    }
  });
});

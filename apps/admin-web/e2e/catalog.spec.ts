import { expect, test, type Page } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";

/* Sprint 4 — «Event catalog»: review queue, sources, event search (docs/sprint4/INTERNAL_API.md §7). */

const R1 = "7e000000-0000-4000-8000-000000000001"; // iTicket, SOURCE_CONFLICT, https banner, matched event
const R2 = "7e000000-0000-4000-8000-000000000002"; // Afisha, LOW_CONFIDENCE + NO_MEDIA
const R3 = "7e000000-0000-4000-8000-000000000003"; // opera.am, http banner (unsafe)
const ITICKET = "5c000000-0000-4000-8000-000000000001";

const row = (page: Page, id: string) => page.locator(`[data-review="${id}"]`);

test.describe("review", () => {
  test("accept: facts, source link and banner are safe; a comment is required; the list and the menu counter refresh", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/review");
    const hash = bff.reviews.find((r) => r.review_id === R1)!.content_hash;
    await expect(page.getByTestId("review-table").locator("tbody tr")).toHaveCount(4);
    await expect(page.getByTestId("review-count")).toHaveText("4");
    await expect(row(page, R1)).toContainText("Источники расходятся");
    await expect(row(page, R1)).toContainText("iticket.uz");
    await expect(row(page, R2)).toContainText("Низкая уверенность");

    await row(page, R1).click();
    const card = page.getByTestId("review-card");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("rv-domain")).toHaveText("iticket.uz");
    const link = page.getByTestId("rv-source-link");
    await expect(link).toHaveAttribute("href", "https://iticket.uz/ru/events/concerts/shahzoda-2026");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const img = page.getByTestId("rv-banner").locator("img");
    await expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    expect(bff.images[0]!.referer).toBeNull();
    await expect(page.getByTestId("rv-rights")).toHaveText("официальный сайт");
    await expect(page.getByTestId("rv-price")).toHaveText(/^150\s000 – 450\s000 UZS$/);
    await expect(page.getByTestId("rv-match")).toContainText("e1000000…0042");

    await page.getByTestId("rv-accept").click();
    const dlg = page.getByTestId("rv-accept-dialog");
    await expect(dlg).toContainText("iticket.uz");
    await page.getByTestId("confirm-ok").click();
    await expect(dlg).toContainText("не короче 3");
    await dlg.locator("textarea").fill("Дата и площадка совпадают со страницей");
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toasts")).toContainText("Событие принято и опубликовано");
    await expect(card).toBeHidden();
    await expect(row(page, R1)).toHaveCount(0);
    await expect(page.getByTestId("review-count")).toHaveText("3");
    const call = bff.calls("POST", `/review/${R1}/accept`)[0]!;
    expect(call.body).toEqual({ expected_status: "OPEN", expected_content_hash: hash, note: "Дата и площадка совпадают со страницей" });
    expect(call.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.headers["x-csrf-token"]).toBeTruthy();
  });

  test("reject: a reason code and a comment", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/review");
    await row(page, R2).click();
    await page.getByTestId("rv-reject").click();
    await page.getByTestId("rv-reject-ok").click();
    await expect(page.getByTestId("rv-reject-dialog")).toContainText("Выберите причину отклонения");
    await page.getByTestId("rv-reject-code").selectOption("NOT_AN_EVENT");
    await page.getByTestId("rv-reject-note").fill("Реклама абонемента, не концерт");
    await page.getByTestId("rv-reject-ok").click();
    await expect(page.getByTestId("toasts")).toContainText("Событие отклонено");
    const hash = bff.reviews.find((r) => r.review_id === R2)!.content_hash;
    expect(bff.calls("POST", `/review/${R2}/reject`)[0]!.body).toEqual({ expected_status: "OPEN", expected_content_hash: hash, reason_code: "NOT_AN_EVENT", note: "Реклама абонемента, не концерт" });
    // the decided item is visible under «Rejected» with the decision and the staff member's name (not a UUID)
    await page.getByTestId("rv-status").selectOption("REJECTED");
    await row(page, R2).click();
    await expect(page.getByTestId("rv-decision")).toContainText("Это не событие");
    await expect(page.getByTestId("rv-decided-by")).toHaveText("Admin Operator");
  });

  test("correct: only changed facts + a basis URL on the source domain (server 422 shown at the field)", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/review");
    await row(page, R1).click();
    await page.getByTestId("rv-correct").click();
    const form = page.getByTestId("rv-correct-form");
    await expect(form).toBeVisible();
    // the basis is prefilled with the candidate page; every field shows the candidate's value («was: …»)
    await expect(page.getByTestId("rc-basis")).toHaveValue("https://iticket.uz/ru/events/concerts/shahzoda-2026");
    await expect(page.getByTestId("rc-time-was")).toHaveText("было: 19:00");
    await expect(page.getByTestId("rc-price-was")).toHaveText(/^было: 150\s000 – 450\s000 UZS$/);
    await expect(page.getByTestId("rc-address-was")).toHaveText("было: ул. Ататурка, 28");
    // nothing changed yet → explained, no request
    await page.getByTestId("rc-note").fill("Время на странице — 20:00");
    await page.getByTestId("rc-submit").click();
    await expect(page.getByTestId("rc-nochanges")).toBeVisible();
    expect(bff.calls("POST", `/review/${R1}/correct`)).toHaveLength(0);

    await page.locator("#rc-time").fill("20:00");
    await expect(page.locator(".field.is-edited")).toHaveCount(1); // the edited field is marked
    await page.getByTestId("rc-max").fill("500 000");
    // client check: https only
    await page.getByTestId("rc-basis").fill("http://iticket.uz/x");
    await page.getByTestId("rc-submit").click();
    await expect(form).toContainText("Нужна ссылка https");
    // server check: the basis must be on the source's domain
    await page.getByTestId("rc-basis").fill("https://example.com/shahzoda");
    await page.getByTestId("rc-submit").click();
    await expect(form).toContainText("домена источника");
    await page.getByTestId("rc-basis").fill("https://iticket.uz/ru/events/concerts/shahzoda-2026");
    await page.getByTestId("rc-submit").click();
    await expect(page.getByTestId("toasts")).toContainText("Исправление сохранено");
    const calls = bff.calls("POST", `/review/${R1}/correct`);
    expect(calls.at(-1)!.body).toEqual({
      expected_status: "OPEN",
      expected_content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      changes: { start: { local_date: "2026-10-24", local_time: "20:00" }, price_range: { min: "150000.00", max: "500000.00", currency: "UZS" } },
      basis_url: "https://iticket.uz/ru/events/concerts/shahzoda-2026",
      note: "Время на странице — 20:00",
    });
    // the retry after 422 reuses the dialog's Idempotency-Key
    expect(new Set(calls.map((c) => c.headers["idempotency-key"])).size).toBe(1);
  });

  test("409 REVIEW_ALREADY_DECIDED: a clear message, the card and the list refresh", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/review");
    await row(page, R2).click();
    // sprint 9 (flaky under a full run): the card must have read the OPEN item before another staff member decides it —
    // otherwise its own GET already sees ACCEPTED and there is no «Accept» to press
    await expect(page.getByTestId("rv-accept")).toBeEnabled();
    bff.decideElsewhere(R2);
    await page.getByTestId("rv-accept").click();
    await page.getByTestId("rv-accept-dialog").locator("textarea").fill("Проверено");
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toasts")).toContainText("уже проверил другой сотрудник");
    await expect(page.getByTestId("rv-stale")).toBeVisible();
    await expect(page.getByTestId("rv-decision")).toContainText("Принято");
    await expect(page.getByTestId("rv-accept")).toHaveCount(0);
    await expect(row(page, R2)).toHaveCount(0);
  });

  test("409 REVIEW_CHANGED: the facts were replaced while the card was open — message, card re-read, decide again", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/review");
    await row(page, R2).click();
    await expect(page.getByTestId("rv-accept")).toBeEnabled(); // the card read the old facts first (see above)
    const seen = bff.reviews.find((r) => r.review_id === R2)!.content_hash;
    bff.updateCandidate(R2, { title: "Jazz Nights: Tashkent Big Band & Guests", start: { local_date: "2026-11-03", local_time: "20:00" } });
    await page.getByTestId("rv-accept").click();
    await page.getByTestId("rv-accept-dialog").locator("textarea").fill("Проверено по странице");
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toasts")).toContainText("Кандидат обновился, проверьте факты ещё раз");
    await expect(page.getByTestId("rv-accept-dialog")).toHaveCount(0);
    await expect(page.getByTestId("rv-changed")).toBeVisible();
    await expect(page.getByTestId("review-card")).toContainText("Jazz Nights: Tashkent Big Band & Guests");
    await expect(page.getByTestId("rv-facts")).toContainText("20:00");
    expect(bff.calls("POST", `/review/${R2}/accept`)[0]!.body).toMatchObject({ expected_content_hash: seen });
    // the operator looked at the new facts — the decision goes with their hash
    await page.getByTestId("rv-accept").click();
    await page.getByTestId("rv-accept-dialog").locator("textarea").fill("Проверено по странице");
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toasts")).toContainText("Событие принято и опубликовано");
    const calls = bff.calls("POST", `/review/${R2}/accept`);
    expect(calls.at(-1)!.body).toMatchObject({ expected_content_hash: bff.reviews.find((r) => r.review_id === R2)!.content_hash });
    expect(calls.at(-1)!.headers["idempotency-key"]).not.toBe(calls[0]!.headers["idempotency-key"]);
  });

  test("409 REVIEW_CHANGED in «Correct»: the edits stay, «was» shows the new facts, untouched fields follow them", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/review");
    await row(page, R1).click();
    await page.getByTestId("rv-correct").click();
    await page.locator("#rc-time").fill("20:00");
    await page.getByTestId("rc-note").fill("Время на странице — 20:00");
    bff.updateCandidate(R1, { title: "Шахзода. Большой сольный концерт (перенос)" });
    await page.getByTestId("rc-submit").click();
    await expect(page.getByTestId("toasts")).toContainText("Кандидат обновился");
    await expect(page.getByTestId("rv-changed")).toContainText("Ваши правки сохранены");
    await expect(page.getByTestId("rc-title-was")).toContainText("(перенос)");
    await expect(page.locator("#rc-title")).toHaveValue("Шахзода. Большой сольный концерт (перенос)");
    await expect(page.locator("#rc-time")).toHaveValue("20:00");
    await page.getByTestId("rc-submit").click();
    await expect(page.getByTestId("toasts")).toContainText("Исправление сохранено");
    const calls = bff.calls("POST", `/review/${R1}/correct`);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ changes: { start: { local_date: "2026-10-24", local_time: "20:00" } } });
    expect((calls[1]!.body as { changes: Record<string, unknown> }).changes).not.toHaveProperty("title");
  });

  test("422 REVIEW_CHANGES_INVALID: the field named by the service is highlighted with a clear text", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/review");
    await row(page, R1).click();
    await page.getByTestId("rv-correct").click();
    await page.locator("#rc-date").fill("2033-10-24");
    await page.getByTestId("rc-note").fill("Дата на странице");
    await page.getByTestId("rc-submit").click();
    await expect(page.locator("#rc-date")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("rv-correct-form")).toContainText("Дата слишком далеко");
    await expect(page.locator("#rc-date")).toBeFocused();
  });

  test("a non-https banner is never loaded — placeholder instead", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", `#/review/${R3}`);
    await expect(page.getByTestId("review-card")).toBeVisible();
    await expect(page.getByTestId("rv-banner-empty")).toContainText("не по https");
    await expect(page.getByTestId("review-card").locator("img")).toHaveCount(0);
    await expect(page.getByTestId("rv-reasons")).toContainText("Каталог не принял");
    await expect(page.getByTestId("rv-reasons")).toContainText("Нет города");
    expect(bff.images).toHaveLength(0);
  });
});

test.describe("sources", () => {
  test("create: chips with domain checks, listing page on the source domains, reason, step-up", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/sources");
    await expect(page.getByTestId("sources-table").locator("tbody tr")).toHaveCount(5);
    await page.getByTestId("src-add").click();
    const form = page.getByTestId("src-form");
    await page.getByTestId("sf-name").fill("Kassir.kg");
    await page.getByTestId("sf-slug").fill("Kassir KG");
    await expect(page.getByTestId("sf-slug")).toHaveValue("kassirkg");
    await page.getByTestId("sf-slug").fill("kassir-kg");
    await page.locator("#sf-country").selectOption("KG");
    // a whole zone is refused right in the chip field
    await page.locator("#sf-ev").fill("kg");
    await page.locator("#sf-ev").press("Enter");
    await expect(form).toContainText("«kg» — не домен");
    await page.locator("#sf-ev").fill("https://Kassir.KG/");
    await page.locator("#sf-ev").press("Enter");
    await expect(page.getByTestId("sf-ev").locator(".chip")).toHaveText(["kassir.kg"]);
    await page.locator("#sf-media").fill("*.cdn.kassir.kg");
    await page.locator("#sf-media").press("Enter");
    await page.getByTestId("sf-page-add").click();
    await page.getByTestId("sf-page-url-0").fill("https://other.kg/afisha");
    await expect(page.getByTestId("sf-page-city-0")).toHaveAttribute("maxlength", "80"); // source-registry CITY_MAX
    await page.getByTestId("sf-page-city-0").fill("Bishkek");
    await page.getByTestId("sf-page-cat-0").selectOption("music.concerts");
    await expect(page.getByTestId("sf-stepup-note")).toBeVisible();
    await page.getByTestId("sf-submit").click();
    await expect(form).toContainText("не на доменах событий источника (kassir.kg)");
    await expect(form).toContainText("Укажите причину изменения");
    expect(bff.calls("POST", "/sources")).toHaveLength(0);
    await page.getByTestId("sf-page-url-0").fill("https://www.kassir.kg/afisha");
    await page.getByTestId("sf-reason").fill("Новый билетный оператор Бишкека");
    await page.getByTestId("sf-submit").click();
    await expect(page.getByTestId("stepup")).toBeVisible();
    await typeOtp(page, "stepup", "123456");
    await expect(page.getByTestId("toasts")).toContainText("Источник Kassir.kg создан");
    const posts = bff.calls("POST", "/sources");
    expect(posts).toHaveLength(2); // STEP_UP_REQUIRED, then the same request with the same Idempotency-Key
    expect(posts[0]!.headers["idempotency-key"]).toBe(posts[1]!.headers["idempotency-key"]);
    expect(posts[1]!.body).toEqual({
      slug: "kassir-kg",
      name: "Kassir.kg",
      country_code: "KG",
      tier: "OFFICIAL_TICKET_PROVIDER",
      event_domains: ["kassir.kg"],
      media_domains: ["*.cdn.kassir.kg"],
      listing_pages: [{ url: "https://www.kassir.kg/afisha", city: "Bishkek", category: "music.concerts", kind: "html", priority: "normal" }],
      enabled: false,
      js_only: null,
      notes: null,
      reason: "Новый билетный оператор Бишкека",
    });
    await expect(page.locator('[data-source="kassir-kg"]')).toBeVisible();
    await expect(page.getByTestId("src-tab-log")).toBeVisible();
  });

  test("edit: a plain change saves without step-up; turning off is confirmed and needs step-up; the log grows", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/sources");
    await page.locator('[data-source="iticket-uz"]').click();
    await expect(page.getByTestId("sf-slug")).toBeDisabled();
    await page.getByTestId("sf-name").fill("iTicket Uzbekistan");
    await expect(page.getByTestId("sf-stepup-note")).toHaveCount(0);
    await page.getByTestId("sf-reason").fill("Официальное название");
    await page.getByTestId("sf-submit").click();
    await expect(page.getByTestId("toasts")).toContainText("версия 4");
    expect(bff.calls("PATCH", `/sources/${ITICKET}`)[0]!.body).toEqual({ expected_version: 3, name: "iTicket Uzbekistan", reason: "Официальное название" });
    await expect(page.getByTestId("stepup")).toHaveCount(0);

    // turning the source off: confirmation, then step-up on save
    await page.locator('label[for="sf-enabled"]').click();
    await expect(page.getByTestId("sf-enable-confirm")).toContainText("Уже опубликованные события останутся");
    await page.getByTestId("sf-enable-ok").click();
    await expect(page.getByTestId("sf-stepup-note")).toContainText("включение");
    await page.getByTestId("sf-reason").fill("Сайт отдаёт 503 вторые сутки");
    await page.getByTestId("sf-submit").click();
    await expect(page.getByTestId("stepup")).toBeVisible();
    await typeOtp(page, "stepup", "123456");
    await expect(page.getByTestId("toasts")).toContainText("версия 5");
    expect(bff.calls("PATCH", `/sources/${ITICKET}`).at(-1)!.body).toEqual({ expected_version: 4, enabled: false, reason: "Сайт отдаёт 503 вторые сутки" });
    await expect(page.locator('[data-source="iticket-uz"]')).toContainText("Выключен");
    await page.getByTestId("src-tab-log").click();
    await expect(page.getByTestId("src-log").locator("li").first()).toContainText("Сайт отдаёт 503 вторые сутки");
  });

  test("409 SOURCE_VERSION_CONFLICT: the draft is kept and carried over to the new version on request", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/sources");
    await page.locator('[data-source="afisha-uz"]').click();
    await page.getByTestId("sf-name").fill("Afisha");
    await page.getByTestId("sf-reason").fill("Короткое имя");
    const afisha = bff.sources.find((s) => s.slug === "afisha-uz")!;
    Object.assign(afisha, { version: 2, notes: "Обновил другой сотрудник", updated_by: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a02" }); // saved meanwhile
    await page.getByTestId("sf-submit").click();
    await expect(page.getByTestId("toasts")).toContainText("изменил другой сотрудник");
    await expect(page.getByTestId("source-card")).toContainText("v2");
    const banner = page.getByTestId("sf-conflict");
    await expect(banner).toContainText("v2");
    await expect(banner).toContainText("не потеряны");
    await expect(page.getByTestId("sf-name")).toHaveValue("Afisha.uz"); // the new version is shown as is
    await page.getByTestId("sf-apply-mine").click();
    await expect(page.getByTestId("sf-rebased")).toBeVisible();
    await expect(page.getByTestId("sf-name")).toHaveValue("Afisha");
    await expect(page.locator("#sf-notes")).toHaveValue("Обновил другой сотрудник");
    await expect(page.getByTestId("sf-reason")).toHaveValue("Короткое имя");
    await expect(page.locator(".field.is-edited")).toHaveCount(1);
    await page.getByTestId("sf-submit").click();
    await expect(page.getByTestId("toasts")).toContainText("версия 3");
    expect(bff.calls("PATCH", `/sources/${afisha.source_id}`).at(-1)!.body).toEqual({ expected_version: 2, name: "Afisha", reason: "Короткое имя" });
  });

  test("names instead of ids; Save and Cancel stay in the drawer footer", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/sources");
    await expect(page.locator('[data-source="iticket-uz"]')).toContainText("Тимур");
    await page.locator('[data-source="iticket-uz"]').click();
    const footer = page.locator(".drawer-f");
    await expect(footer.getByTestId("sf-submit")).toBeVisible();
    await expect(footer.getByTestId("sf-cancel")).toBeVisible();
    // the footer stays in view at the top of a long form
    await page.getByTestId("sf-name").focus();
    await expect(footer.getByTestId("sf-submit")).toBeInViewport();
    await page.getByTestId("src-tab-log").click();
    await expect(page.getByTestId("src-log").locator("li").first()).toContainText("Тимур");
    await expect(page.locator(".drawer-f")).toHaveCount(0);
  });

  /* fix 4.1: what every source did in the last crawl */
  test("last crawl column: found events, skip reasons in words, errors; a background request", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/sources");
    const cell = (slug: string) => page.locator(`[data-source="${slug}"]`).getByTestId("src-crawl-cell");
    await expect(page.getByTestId("sources-table").locator("thead")).toContainText("Последний обход");
    await expect(cell("iticket-uz")).toContainText("Найдено 14 событий");
    await expect(cell("iticket-uz")).toContainText("2 ч назад");
    await expect(cell("iticket-uz").locator(".pill")).toHaveClass(/good/);
    await expect(cell("afisha-uz")).toContainText("Событий не найдено");
    await expect(cell("ticketon-kz")).toContainText("Запрещено robots.txt");
    await expect(cell("ticketon-kz").locator(".pill")).toHaveAttribute("title", "Страница пропущена: SOURCE_ROBOTS_DISALLOWED");
    await expect(cell("tkt-ge")).toContainText("Афиша не в HTML (JS)");
    await expect(cell("opera-am")).toContainText("Некорректный ответ Claude");
    await expect(cell("opera-am").locator(".pill")).toHaveClass(/bad/);
    const req = bff.calls("GET", "/sources/crawl-stats");
    expect(req.length).toBeGreaterThanOrEqual(1); // dev StrictMode mounts effects twice
    for (const r of req) expect(r.headers["x-background"]).toBe("1"); // optional data does not extend the idle session
    // filters reload the list, not the crawl stats
    await page.getByTestId("src-country").selectOption("UZ");
    await expect(page.getByTestId("sources-table").locator("tbody tr")).toHaveCount(2);
    await expect(cell("iticket-uz")).toContainText("Найдено 14 событий");
    expect(bff.calls("GET", "/sources/crawl-stats")).toHaveLength(req.length);
  });

  test("source card: «Last crawl» block — pages, found, discarded by reason, Claude calls, cost of the crawl and of the day", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/sources");
    await page.locator('[data-source="iticket-uz"]').click();
    const b = page.getByTestId("src-crawl");
    await expect(b).toHaveAttribute("data-crawl", "ok");
    await expect(b.getByTestId("crawl-pages")).toHaveText("2");
    await expect(b.getByTestId("crawl-events")).toHaveText("14");
    await expect(b.getByTestId("crawl-dropped")).toHaveText("6");
    await expect(b.getByTestId("crawl-llm")).toHaveText("2");
    await expect(b.getByTestId("crawl-cost")).toHaveText("$0.0231");
    await expect(b.getByTestId("crawl-cost-day")).toHaveText("$0.0462");
    await expect(b.getByTestId("crawl-skips").locator("li")).toHaveText([/Дата не совпадает со страницей\s*3 из 20/, /Названия нет на странице\s*2 из 20/, /Ссылка на чужой домен\s*1 из 20/]);
    // page notes: warnings apart from the discarded events, not counted in «Discarded»
    await expect(b.getByTestId("crawl-notes").locator("li")).toHaveText([
      /Не хватило времени — страница обработана не целиком\s*1 раз/,
      /Ответ модели обрезан — часть событий могла не попасть\s*1 раз/,
    ]);
    // the form is still below, editable
    await expect(page.getByTestId("sf-name")).toBeEditable();
    await page.getByTestId("drawer-close").click();
    // a non-event of the catalog (a tour, a park) is a discard reason; no notes — no warnings section
    await page.locator('[data-source="afisha-uz"]').click();
    await expect(b.getByTestId("crawl-skips")).toContainText("Не событие каталога (экскурсия, парк, музей)");
    await expect(b.getByTestId("crawl-notes")).toHaveCount(0);
    await page.getByTestId("drawer-close").click();
    // skipped: the code, its label and what to do
    await page.locator('[data-source="ticketon-kz"]').click();
    await expect(b).toHaveAttribute("data-crawl", "skipped");
    await expect(b.getByTestId("src-crawl-badge")).toHaveText("Запрещено robots.txt");
    await expect(b).toContainText("SOURCE_ROBOTS_DISALLOWED");
    await expect(b).toContainText("Сайт запрещает обход в robots.txt");
    await page.getByTestId("drawer-close").click();
    await page.locator('[data-source="tkt-ge"]').click();
    await expect(b).toContainText("Отметьте «Афиша только через JavaScript»");
    await page.getByTestId("drawer-close").click();
    await page.locator('[data-source="opera-am"]').click();
    await expect(b).toHaveAttribute("data-crawl", "error");
    await expect(b).toContainText("PROVIDER_BAD_RESPONSE");
    await expect(b.getByTestId("crawl-cost")).toHaveText("$0.0412");
  });

  for (const down of ["unavailable", "feature-off"] as const) {
    test(`crawl stats fail (${down}): «—» in the column, the list and the card work, «Retry» re-reads`, async ({ page }) => {
      const bff = await openAs(page, "admin@tilhero.local", "#/sources", { crawlDown: down });
      await expect(page.getByTestId("sources-table").locator("tbody tr")).toHaveCount(5);
      const cells = page.getByTestId("src-crawl-cell");
      await expect(cells).toHaveCount(5);
      await expect(cells).toHaveText(["—", "—", "—", "—", "—"]);
      await expect(page.getByTestId("toasts")).not.toContainText(/недоступ|не настроен/);
      await expect(page.locator("[data-testid=load-error], [data-testid=load-feature-off]")).toHaveCount(0);
      await page.locator('[data-source="iticket-uz"]').click();
      const b = page.getByTestId("src-crawl");
      await expect(b).toHaveAttribute("data-crawl", "na");
      await expect(b).toContainText("Статистика обхода недоступна");
      await expect(page.getByTestId("sf-name")).toHaveValue("iTicket.uz");
      // the service is back → «Retry» fills the block and the column
      (bff.sc as { crawlDown?: string }).crawlDown = undefined;
      await page.getByTestId("src-crawl-retry").click();
      await expect(b).toHaveAttribute("data-crawl", "ok");
      await expect(b.getByTestId("crawl-events")).toHaveText("14");
      await page.getByTestId("drawer-close").click();
      await expect(page.locator('[data-source="iticket-uz"]').getByTestId("src-crawl-cell")).toContainText("Найдено 14 событий");
    });
  }

  test("a source without a crawl yet: «Не обходился» in the column, a note in the card", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/sources");
    bff.crawl = bff.crawl.filter((c) => c.slug !== "afisha-uz");
    await page.reload();
    await expect(page.locator('[data-source="afisha-uz"]').getByTestId("src-crawl-cell")).toHaveText("Не обходился");
    await page.locator('[data-source="afisha-uz"]').click();
    await expect(page.getByTestId("src-crawl")).toHaveAttribute("data-crawl", "never");
    await expect(page.getByTestId("src-crawl")).toContainText("Данные появятся после ближайшего поиска событий");
  });

  test("country names: «Кыргызстан» (not «Киргизия») in filters, the table and the form; EN — Kyrgyzstan", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/sources");
    bff.sources.push({ ...bff.sources[0]!, source_id: "5c000000-0000-4000-8000-000000000077", slug: "kassir-kg", name: "Kassir.kg", country_code: "KG", event_domains: ["kassir.kg"], listing_pages: [] });
    await page.reload();
    const row = page.locator('[data-source="kassir-kg"]');
    await expect(row).toContainText("Кыргызстан");
    await expect(page.locator("#src-country option")).toContainText(["Узбекистан", "Казахстан", "Кыргызстан", "Азербайджан", "Грузия", "Армения"]);
    await expect(page.locator("body")).not.toContainText("Киргизия");
    await row.click();
    const opts = page.locator("#sf-country option");
    await expect(page.locator("#sf-country")).toHaveValue("KG");
    for (const name of ["Кыргызстан · KG", "Таджикистан · TJ", "Туркменистан · TM", "Россия · RU", "Беларусь · BY"]) await expect(opts.filter({ hasText: name })).toHaveCount(1);
    await expect(opts.filter({ hasText: "Киргизия" })).toHaveCount(0);
    await page.getByTestId("drawer-close").click();
    await page.getByTestId("lang-en").click();
    await expect(row).toContainText("Kyrgyzstan");
    await expect(page.locator("#src-country option")).toContainText(["Uzbekistan", "Kazakhstan", "Kyrgyzstan", "Azerbaijan", "Georgia", "Armenia"]);
    await expect(row.getByTestId("src-crawl-cell")).toHaveText("Not crawled yet");
  });
});

test.describe("event search", () => {
  test("budget widget, kill switch with a reason and step-up, resume", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/discovery");
    await expect(page.getByTestId("dsc-spent")).toHaveText("$0.4213");
    await expect(page.getByTestId("dsc-budget-limit")).toHaveText("$1.00");
    await expect(page.getByTestId("dsc-pages")).toContainText("71");
    await expect(page.getByTestId("dsc-budget")).toContainText("claude-haiku-4-5");
    await expect(page.getByTestId("runs-table")).toContainText("$0.2349");

    await page.getByTestId("dsc-pause").click();
    await page.getByTestId("dsc-pause-dialog").locator("textarea").fill("Модель отвечает с ошибками");
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("stepup")).toBeVisible();
    await typeOtp(page, "stepup", "123456");
    await expect(page.getByTestId("toasts")).toContainText("AI-поиск остановлен");
    await expect(page.getByTestId("dsc-paused-by")).toHaveText("Admin Operator");
    await expect(page.getByTestId("dsc-kill")).toContainText("Модель отвечает с ошибками");
    expect(bff.calls("PUT", "/discovery/pause").at(-1)!.body).toEqual({ paused: true, reason: "Модель отвечает с ошибками" });

    await page.getByTestId("dsc-resume").click();
    await page.getByTestId("dsc-pause-dialog").locator("textarea").fill("Исправлено");
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toasts")).toContainText("AI-поиск возобновлён");
    await expect(page.getByTestId("dsc-kill-state")).toContainText("AI-поиск работает");
  });

  test("start a search: confirmation, RUNNING row, auto-refresh until it finishes; errors expand with labels", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/discovery");
    const partial = page.locator('[data-run="d1500000-0000-4000-8000-000000000001"]');
    await partial.getByRole("button", { name: /4 ошибки/ }).click();
    await expect(page.locator(".run-errs")).toContainText("Бюджет AI на сутки исчерпан");
    await expect(page.locator(".run-errs")).toContainText("×3");

    await page.getByTestId("dsc-start").click();
    await page.getByTestId("dsc-limit").fill("500");
    await page.getByTestId("dsc-start-ok").click();
    await expect(page.getByTestId("dsc-start-dialog")).toContainText("от 1 до 200");
    await page.getByTestId("dsc-limit").fill("50");
    await page.getByTestId("dsc-start-ok").click();
    await expect(page.getByTestId("toasts")).toContainText("Поиск запущен");
    const post = bff.calls("POST", "/discovery/runs")[0]!;
    expect(post.body).toEqual({ max_provider_calls: 50 });
    expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByTestId("runs-table").locator("tbody tr").first()).toContainText("Идёт");
    await expect(page.getByTestId("dsc-live")).toBeVisible();
    bff.finishRunning();
    await expect(page.getByTestId("runs-table").locator("tbody tr").first()).toContainText("Завершён", { timeout: 12_000 });
    await expect(page.getByTestId("dsc-live")).toHaveCount(0);
    // background polls never extend the idle session
    expect(bff.calls("GET", "/discovery/runs").filter((c) => c.headers["x-background"] === "1").length).toBeGreaterThan(0);
  });

  test("409 DISCOVERY_RUN_IN_PROGRESS: a message with a link to the running search", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/discovery", { running: true });
    await page.getByTestId("dsc-start").click();
    await page.getByTestId("dsc-start-ok").click();
    await expect(page.getByTestId("dsc-in-progress")).toContainText("Поиск уже идёт");
    await page.getByTestId("dsc-in-progress-link").click();
    await expect(page.getByTestId("run-card")).toContainText("d1500000-0000-4000-8000-0000000000aa");
    await expect(page.getByTestId("run-card")).toContainText("Идёт");
  });

  test("the budget did not load: state unknown, both commands available; after a failed command the state is re-read", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/discovery", { budgetDown: true, auditDown: true });
    await expect(page.getByTestId("dsc-budget-error")).toBeVisible();
    await expect(page.getByTestId("dsc-kill-state")).toHaveText("Состояние неизвестно");
    await expect(page.getByTestId("dsc-pause")).toBeVisible();
    await expect(page.getByTestId("dsc-resume")).toBeVisible();
    await page.getByTestId("dsc-pause").click();
    await page.getByTestId("dsc-pause-dialog").locator("textarea").fill("Модель отвечает с ошибками");
    bff.sc.budgetDown = false; // the budget is back by the time the command fails
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("stepup")).toBeVisible();
    await typeOtp(page, "stepup", "123456");
    await expect(page.getByTestId("dsc-pause-dialog")).toContainText("Журнал аудита недоступен, поэтому состояние AI-поиска не изменилось");
    // the actual state is shown right away: the AI search is still running
    await expect(page.getByTestId("dsc-kill-state")).toHaveText("AI-поиск работает");
    expect(bff.calls("PUT", "/discovery/pause").length).toBeGreaterThan(0);
  });

  test("a section without a configured domain shows «not set up yet», the rest of the admin works", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/review", { featureOff: ["review"] });
    await expect(page.getByTestId("load-feature-off")).toContainText("Раздел ещё не настроен");
    await page.locator('[data-nav="sources"]').click();
    await expect(page.getByTestId("sources-table").locator("tbody tr")).toHaveCount(5);
  });

  test("without ops.kill_switch the kill switch is read-only (the paused state stays visible)", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/discovery", {
      paused: true,
      matrix: { operations: ["dashboard.read", "events.review", "sources.manage", "discovery.manage"] },
    });
    await expect(page.getByTestId("dsc-kill-state")).toContainText("AI-поиск остановлен");
    await expect(page.getByTestId("dsc-kill-ro")).toContainText("ops.kill_switch");
    await expect(page.getByTestId("dsc-pause")).toHaveCount(0);
    await expect(page.getByTestId("dsc-resume")).toHaveCount(0);
  });
});

test.describe("menu", () => {
  const navIds = (page: Page) => page.locator("[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav")));

  test("operations sees the «Event catalog» group; support does not and a deep link is refused", async ({ page }) => {
    await openAs(page, "ops@tilhero.local");
    await expect(page.locator(".sn-group-label", { hasText: "Каталог событий" })).toBeVisible();
    expect(await navIds(page)).toEqual(expect.arrayContaining(["review", "sources", "discovery"]));
  });

  test("support: no catalog items, #/sources is refused", async ({ page }) => {
    await openAs(page, "support@tilhero.local", "#/sources");
    await expect(page.getByTestId("toasts")).toContainText("недоступен");
    const ids = await navIds(page);
    expect(ids).not.toContain("review");
    expect(ids).not.toContain("sources");
    expect(ids).not.toContain("discovery");
    await expect(page.locator(".sn-group-label", { hasText: "Каталог событий" })).toHaveCount(0);
  });

  test("only events.review: review only, no sources / search", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/review", { matrix: { operations: ["events.review"] } });
    expect(await navIds(page)).toEqual(["review"]);
    await expect(page.getByTestId("review-table")).toBeVisible();
  });
});

import { expect, test, type Page } from "@playwright/test";
import { ALERT as AI_ALERT, REQ } from "./fixtures/ai";
import { USER } from "./fixtures/data";
import { ALERT } from "./fixtures/ops";
import {
  CYRILLIC,
  expectNoHScroll,
  openAs,
  settle,
  setTheme,
  typeOtp,
} from "./helpers";
import type { MockBff } from "./fixtures/mock-bff";

/* Sprint 8, P6: the full dashboard (independent blocks, degradation, A45), «Monitoring» (providers, queues, DLQ, alerts),
   the alert feed in the bell, «quota not charged» in the request log → shots/sprint8/. */

const SHOTS = "shots/sprint8";
async function shot(page: Page, name: string, fullPage = false) {
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}
async function again(
  page: Page,
  email: string,
  hash: string,
  sc: Parameters<typeof openAs>[3] = {},
) {
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
const BLOCKS = [
  "dash-users",
  "dash-ai",
  "dash-trips",
  "dash-no-flight",
  "dash-watch",
  "dash-news",
  "dash-support",
  "dash-system",
];
/** no Cyrillic outside data nodes (names of feeds, cities, agents, staff, reasons typed by staff) */
async function noCyrillic(page: Page, scope: string) {
  const text = await page.getByTestId(scope).evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll(
        ".wrap-any, td, .small, select, .mon-json, .mon-alert .small, .xs",
      )
      .forEach((n) => n.remove());
    return clone.innerText;
  });
  expect(
    text,
    `${scope}: ${text.match(/.{0,30}[Ѐ-ӿ]+.{0,30}/)?.[0]}`,
  ).not.toMatch(CYRILLIC);
}

test.describe("width 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("dashboard: all blocks with data, trips without a flight, system health → monitoring; light and dark", async ({
    page,
  }) => {
    await openAs(page, "admin@tilhero.local", "#/dashboard");
    for (const b of BLOCKS)
      await expect(page.getByTestId(b)).toHaveAttribute(
        "data-available",
        "true",
      );
    await expect(page.getByTestId("dash-nodata")).toHaveCount(0);
    await expect(page.getByTestId("kpi-users-active")).toContainText("2 184");
    await expect(page.getByTestId("dash-trips-builds")).toContainText("410");
    await expect(page.getByTestId("dash-trips-channels")).toContainText(
      "Mini App",
    );
    const nf = page.getByTestId("dash-no-flight");
    await expect(nf).toContainText("< 600 км");
    await expect(nf).toContainText("≥ 600 км");
    await expect(nf.getByTestId("dash-nf-pair")).toHaveCount(6);
    await expect(nf.getByTestId("dash-nf-pair").first()).toContainText(
      "Бишкек",
    );
    await expect(page.getByTestId("dash-watch-active")).toContainText("5 902");
    await expect(page.getByTestId("dash-system")).toContainText("Поставщики");
    await expect(page.getByTestId("dash-commerce")).toContainText("отложено");
    await expectNoHScroll(page);
    await shot(page, "01-dashboard-light", true);
    await page
      .getByTestId("dash-period")
      .getByRole("button", { name: "7 дней" })
      .click();
    await expect(page.getByTestId("dash-trips-builds")).toContainText("2 870");
    await setTheme(page, "dark");
    await shot(page, "02-dashboard-dark", true);
    await page.getByTestId("dash-system-open").click();
    await expect(page).toHaveURL(/#\/monitoring\/providers$/);
    await expect(page.getByTestId("mon-providers")).toBeVisible();
  });

  test("dashboard degradation: a block without data / stale / not connected / forbidden — the others still render", async ({
    page,
  }) => {
    await openAs(page, "admin@tilhero.local", "#/dashboard", {
      dashOff: { ai: "timeout", news: "unavailable" },
      dashStale: ["support"],
      opsOff: true,
    });
    await expect(
      page.getByTestId("dash-ai").getByTestId("dash-nodata"),
    ).toHaveAttribute("data-reason", "timeout");
    await expect(page.getByTestId("dash-ai")).toContainText("Нет данных");
    await expect(page.getByTestId("dash-ai")).not.toContainText("$0.00");
    await expect(
      page.getByTestId("dash-news").getByTestId("dash-nodata"),
    ).toHaveAttribute("data-reason", "unavailable");
    await expect(
      page.getByTestId("dash-system").getByTestId("dash-nodata"),
    ).toHaveAttribute("data-reason", "not_configured");
    await expect(page.getByTestId("dash-system")).toContainText(
      "Не подключено",
    );
    await expect(
      page.getByTestId("dash-support").getByTestId("dash-stale"),
    ).toBeVisible();
    await expect(page.getByTestId("kpi-support-open")).toContainText("27");
    for (const b of [
      "dash-users",
      "dash-trips",
      "dash-no-flight",
      "dash-watch",
    ])
      await expect(page.getByTestId(b)).toHaveAttribute(
        "data-available",
        "true",
      );
    await shot(page, "03-dashboard-degraded-light", true);

    // auditor: no users.read → the users block says «no access», no numbers
    await again(page, "audit@tilhero.local", "#/dashboard");
    await expect(
      page.getByTestId("dash-users").getByTestId("dash-nodata"),
    ).toHaveAttribute("data-reason", "forbidden");
    await expect(page.getByTestId("dash-users")).toContainText("Нет доступа");
    await expect(page.getByTestId("dash-users")).not.toContainText("12 846");
    await expect(page.getByTestId("dash-trips")).toHaveAttribute(
      "data-available",
      "true",
    );

    // nothing without a flight yet — a calm «all good» placeholder, not an empty table
    await again(page, "admin@tilhero.local", "#/dashboard", {
      noFlightEmpty: true,
    });
    await expect(page.getByTestId("dash-nf-none")).toBeVisible();
  });

  test("A45: n8n is down — the dashboard shows the late schedule, users / card / support / watches / monitoring still work", async ({
    page,
  }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/dashboard", {
      n8nDown: true,
    });
    await expect(page.getByTestId("dash-watch-next")).toContainText(
      "расписание отстаёт",
    );
    await expect(page.getByTestId("dash-news-last")).toContainText("7 ч");
    await expect(page.getByTestId("dash-watch")).toHaveAttribute(
      "data-available",
      "true",
    );
    await page.getByTestId("dash-watch").scrollIntoViewIfNeeded();
    await settle(page);
    await page.locator(".dash-row", { has: page.getByTestId("dash-watch") }).screenshot({ path: `${SHOTS}/04-a45-dashboard-light.png` });
    await page.goto("/#/users");
    await expect(page.getByTestId("page-users")).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(4);
    await page.goto(`/#/users/${USER.igor}`);
    await expect(page.getByTestId("user-card")).toBeVisible();
    await page.goto("/#/support");
    await expect(page.getByTestId("page-support")).toBeVisible();
    await page.goto("/#/watches");
    await expect(page.getByTestId("page-watches")).toBeVisible();
    await page.goto("/#/monitoring/queues");
    await expect(page.getByTestId("mon-cons-row").first()).toBeVisible();
    expect(bff.calls("GET", /n8n/i)).toHaveLength(0);
  });

  test("monitoring → providers (Telegram button route): status in words, drawer with history 24 h / 7 d, probe", async ({
    page,
  }) => {
    await openAs(page, "ops@tilhero.local", "#/monitoring/providers");
    await expect(page.getByTestId("page-monitoring")).toBeVisible();
    await expect(page.getByTestId("mon-k-providers")).toContainText("6 / 7");
    const rows = page.getByTestId("mon-prov-row");
    await expect(rows.first()).toHaveAttribute("data-provider", "aviasales");
    await expect(rows.first().getByTestId("mon-prov-status")).toHaveText(
      /Деградация/,
    );
    await expect(rows.first()).toContainText("HALF_OPEN");
    await expect(rows.first()).toContainText("FRU×3");
    await expect(
      page.locator('[data-provider="anthropic"]').getByTestId("mon-probe-no"),
    ).toBeVisible();
    await expect(page.getByTestId("mon-feed-row")).toHaveCount(2);
    // fix 8.1: the reason of a failed collection — text and code
    await expect(page.getByTestId("mon-feed-row").first()).toContainText("Доступ запрещён сайтом (403, бот-защита)");
    await expect(page.getByTestId("mon-feed-row").first()).toContainText("FEED_HTTP_403");
    await expectNoHScroll(page);
    await shot(page, "05-providers-light", true);

    // probe from the table: a toast with the latency, the button names the provider for screen readers
    await expect(
      page.locator('[data-provider="liteapi"]').getByTestId("mon-probe"),
    ).toHaveAttribute("aria-label", "Проверить сейчас: LiteAPI");
    await page
      .locator('[data-provider="liteapi"]')
      .getByTestId("mon-probe")
      .click();
    await expect(page.getByTestId("toasts")).toContainText(
      "LiteAPI: ответил за 512 мс",
    );

    await rows.first().click();
    await expect(page).toHaveURL(/#\/monitoring\/providers\/aviasales$/);
    const d = page.getByTestId("mon-prov-drawer");
    await expect(d.getByTestId("mon-chart")).toBeVisible();
    await expect(d.getByTestId("mon-route-top")).toContainText("FRU");
    await expect(d.getByTestId("mon-transitions")).toBeVisible();
    await expect(d.getByTestId("mon-last-error")).toContainText(
      "PROVIDER_UNAVAILABLE",
    );
    await shot(page, "06-provider-drawer-light");
    const week = page.waitForRequest((r) =>
      r.url().includes("/ops/providers/aviasales/history?range=7d"),
    );
    await d
      .getByTestId("mon-range")
      .getByRole("button", { name: "7 дней" })
      .click();
    await week;
    await expect(d.getByTestId("mon-chart")).toBeVisible();
    await d.getByTestId("mon-drawer-probe").click();
    await expect(page.getByTestId("toasts")).toContainText(
      "Aviasales: ответил",
    );
    await page.emulateMedia({ colorScheme: "dark" }); // the theme follows the system one; the drawer covers the theme menu
    await shot(page, "07-provider-drawer-dark");
    await page.getByTestId("drawer-close").click();
    await expect(page).toHaveURL(/#\/monitoring\/providers$/);
  });

  test("monitoring: provider down (critical), queues with lag, NATS unavailable", async ({
    page,
  }) => {
    await openAs(page, "ops@tilhero.local", "#/monitoring/providers", {
      providerDown: true,
      queueLag: true,
    });
    const av = page.locator('[data-provider="aviasales"]');
    await expect(av.getByTestId("mon-prov-status")).toHaveText(/Сбой/);
    await expect(av).toContainText("OPEN");
    await expect(page.getByTestId("mon-k-alerts")).toContainText(
      "критичных: 1",
    );
    await expect(page.getByTestId("bell-count")).toHaveClass(/is-hot/);
    await page.getByTestId("mon-tab-queues").click();
    await expect(page).toHaveURL(/#\/monitoring\/queues$/);
    await expect(
      page
        .locator('[data-testid="mon-cons-row"]', {
          hasText: "ai_control_usage",
        })
        .getByTestId("mon-cons-status"),
    ).toHaveText(/Отстаёт/);
    await expect(
      page
        .locator('[data-testid="mon-cons-row"]', {
          hasText: "user_admin_users",
        })
        .getByTestId("mon-cons-status"),
    ).toHaveText(/Застрял/);
    await expect(page.getByTestId("mon-outbox-row")).toHaveCount(6);
    await expect(page.getByTestId("mon-svc-row")).toHaveCount(12);
    await expectNoHScroll(page);
    await shot(page, "08-queues-lag-light", true);

    await again(page, "ops@tilhero.local", "#/monitoring/queues", {
      natsDown: true,
    });
    await expect(page.getByTestId("mon-cons-error")).toContainText("NATS");
    await expect(page.getByTestId("mon-outbox-row").first()).toBeVisible();
    await page.getByTestId("mon-tab-dlq").click();
    await expect(page.getByTestId("dlq-error")).toContainText("NATS");
    await shot(page, "09-nats-down-light");
  });

  test("DLQ: filters, masked envelope, replay one with reason + count + TOTP, history; replay limit is marked and not selectable", async ({
    page,
  }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/monitoring/dlq");
    await expect(page.getByTestId("dlq-row")).toHaveCount(4);
    await page
      .getByTestId("dlq-consumer")
      .selectOption("notifications_watch_changes");
    await expect(page.getByTestId("dlq-row")).toHaveCount(3);
    await expect(page.getByTestId("mon-dlq-total")).toContainText("3");
    await page.getByTestId("dlq-et").fill("bad type");
    await expect(page.getByTestId("mon-dlq")).toContainText(
      "watch.change.detected.v1",
    );
    await page.getByTestId("dlq-et").fill("");
    // review 8: the period in the locale format (ru ДД.ММ.ГГГГ ЧЧ:ММ), a date alone — the whole day
    await expect(page.getByTestId("dlq-from")).toHaveAttribute("placeholder", "ДД.ММ.ГГГГ ЧЧ:ММ");
    await page.getByTestId("dlq-from").fill("31.02.2026");
    await expect(page.getByTestId("mon-dlq")).toContainText("Период: формат ДД.ММ.ГГГГ ЧЧ:ММ");
    await page.getByTestId("dlq-from").fill("01.01.2026 00:00");
    const req = page.waitForRequest((r) => r.url().includes("/ops/dlq?") && r.url().includes("dead_from="));
    await page.getByTestId("dlq-to").fill("31.12.2030");
    expect(new URL((await req).url()).searchParams.get("dead_to")).toMatch(/^2030-12-3[01]T\d\d:00:00Z$/);
    await page.getByTestId("dlq-from").fill("");
    await page.getByTestId("dlq-to").fill("");
    // the message at the replay limit: marked, its checkbox is off, «Replay» in its card is disabled
    const lim = page.locator('[data-dlq="dlq:40"]');
    await expect(lim.getByTestId("dlq-limit")).toContainText("3 · лимит");
    await expect(lim.getByTestId("dlq-check")).toBeDisabled();
    await shot(page, "10-dlq-light", true);

    await page.locator('[data-dlq="dlq:42"]').click();
    const d = page.getByTestId("dlq-drawer");
    await expect(d.getByTestId("dlq-envelope")).toContainText(
      '"chat_id": "***"',
    );
    await expect(d.getByTestId("dlq-masked-n")).toContainText("5");
    await expect(d.locator("mark.mon-mask")).toHaveCount(5);
    await shot(page, "11-dlq-envelope-light");
    await d.getByTestId("dlq-drawer-replay").click();
    const c = page.getByTestId("dlq-confirm");
    await expect(c.getByTestId("dlq-confirm-ok")).toBeDisabled();
    await c.getByTestId("dlq-reason").fill("Исправлен KeyError в 1.4.3");
    await c.getByTestId("dlq-typed").fill("2");
    await expect(c.getByTestId("dlq-confirm-ok")).toBeDisabled();
    await c.getByTestId("dlq-typed").fill("1");
    await shot(page, "12-dlq-confirm-light");
    await expect(c).toContainText("Повторить 1 сообщение?");
    await c.getByTestId("dlq-confirm-ok").click();
    await totp(page);
    await expect(page.getByTestId("dlq-result-sum")).toContainText(
      "Сделано 1 из 1, пропущено 0",
    );
    const call = await lastCall(bff, "POST", "/ops/dlq/replay");
    expect(call.headers["idempotency-key"]).toBeTruthy();
    expect(call.body).toEqual({
      ids: ["dlq:42"],
      reason: "Исправлен KeyError в 1.4.3",
    });
    await page.getByTestId("dlq-result-close").click();
    await expect(page.getByTestId("dlq-row")).toHaveCount(2);
    await expect(page.getByTestId("dlq-hist-row").first()).toContainText(
      "Исправлен KeyError в 1.4.3",
    );
    await expect(page.getByTestId("dlq-hist-row").first()).toContainText(
      "Тимур",
    );

    // «select page» skips dlq:40 (replay limit): one message is selected
    await page.getByTestId("dlq-select-page").check();
    await expect(page.getByTestId("dlq-acts")).toContainText("Выбрано: 1");
    await page.locator('[data-dlq="dlq:40"]').click();
    await expect(page.getByTestId("dlq-drawer-replay")).toBeDisabled();
    await page.getByTestId("drawer-close").click();

    // a consumer without addressed replay: the server skips its messages — the result says why
    await page.getByTestId("dlq-consumer").selectOption("watch_offer_rebuilt");
    await expect(page.getByTestId("dlq-row")).toHaveCount(1);
    await page.getByTestId("dlq-select-page").check();
    await page.getByTestId("dlq-replay-sel").click();
    await expect(page.getByTestId("dlq-replay-blocked")).toContainText("watch_offer_rebuilt");
    await page.getByTestId("dlq-reason").fill("Повтор после исправления");
    await page.getByTestId("dlq-typed").fill("1");
    await page.getByTestId("dlq-confirm-ok").click(); // step-up is still valid (5 min)
    await expect(page.getByTestId("dlq-skipped")).toContainText(
      "нет адресного повтора",
    );
    await shot(page, "13-dlq-result-skipped-light");
  });

  test("DLQ (review 8): replayed messages stay — state filter, «already replayed» mark, replay again only with «including already replayed»", async ({
    page,
  }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/monitoring/dlq");
    await expect(page.getByTestId("dlq-row")).toHaveCount(4); // по умолчанию — ждут решения
    await expect(page.getByTestId("dlq-replayed")).toHaveCount(0);
    const req = page.waitForRequest((r) => r.url().includes("/ops/dlq?") && r.url().includes("state=replayed"));
    await page.getByTestId("dlq-state").selectOption("replayed");
    await req;
    await expect(page.getByTestId("dlq-row")).toHaveCount(1);
    const row = page.locator('[data-dlq="dlq:39"]');
    await expect(row.getByTestId("dlq-replayed")).toContainText("уже повторялось");
    await row.click();
    await expect(page.getByTestId("dlq-drawer-replayed")).toContainText("Повторено");
    await page.getByTestId("drawer-close").click();
    // без флажка сервер пропускает уже повторённое — ALREADY_REPLAYED с подсказкой
    await page.getByTestId("dlq-select-page").check();
    await page.getByTestId("dlq-replay-sel").click();
    const c = page.getByTestId("dlq-confirm");
    await expect(c.getByTestId("dlq-include-replayed")).not.toBeChecked();
    await c.getByTestId("dlq-reason").fill("Обработчик снова исправлен");
    await c.getByTestId("dlq-typed").fill("1");
    await c.getByTestId("dlq-confirm-ok").click();
    await totp(page);
    await expect(page.getByTestId("dlq-skipped")).toContainText("уже повторялось");
    expect((await lastCall(bff, "POST", "/ops/dlq/replay")).body).toEqual({ ids: ["dlq:39"], reason: "Обработчик снова исправлен" });
    await page.getByTestId("dlq-result-close").click();
    // с флажком — повторено ещё раз, пометка остаётся, счётчик повторов растёт
    await page.getByTestId("dlq-select-page").check();
    await page.getByTestId("dlq-replay-sel").click();
    await c.getByTestId("dlq-include-replayed").check();
    await c.getByTestId("dlq-reason").fill("Повтор потерянного при раскатке");
    await c.getByTestId("dlq-typed").fill("1");
    await c.getByTestId("dlq-confirm-ok").click();
    await expect(page.getByTestId("dlq-result-sum")).toContainText("Сделано 1 из 1, пропущено 0");
    const call = await lastCall(bff, "POST", "/ops/dlq/replay");
    expect(call.body).toEqual({ ids: ["dlq:39"], reason: "Повтор потерянного при раскатке", include_replayed: true });
    await page.getByTestId("dlq-result-close").click();
    await expect(page.locator('[data-dlq="dlq:39"]').getByTestId("dlq-replayed")).toBeVisible();
    await shot(page, "15-dlq-replayed-light");
    // состояние «все» — и ждущие, и повторённые
    await page.getByTestId("dlq-state").selectOption("all");
    await expect(page.getByTestId("dlq-row")).toHaveCount(5);
  });

  test("queues (review 8): a stale readiness snapshot is «no data» with the last known state", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/monitoring/queues");
    const om = page.locator('[data-testid="mon-svc-row"]', { hasText: "ops-monitor" });
    await expect(om).toHaveAttribute("data-ready", "unknown");
    await expect(om.getByTestId("mon-svc-ready")).toContainText("нет данных");
    await expect(om.getByTestId("mon-svc-ready")).toHaveAttribute("title", "последнее известное: в норме");
    await page.locator('[data-nav="dashboard"]').click();
    await expect(page.getByTestId("dash-sys-services")).toContainText("данные устарели: ops-monitor");
  });

  test("DLQ by filter: the count changed (409) → retype; delete with the audit down changes nothing", async ({
    page,
  }) => {
    const bff = await openAs(
      page,
      "ops@tilhero.local",
      "#/monitoring/dlq/notifications_watch_changes",
      { dlqCountChanged: true },
    );
    await expect(page.getByTestId("dlq-consumer")).toHaveValue(
      "notifications_watch_changes",
    );
    await expect(page.getByTestId("dlq-row")).toHaveCount(3);
    await page.getByTestId("dlq-source").selectOption("dlq");
    await expect(page.getByTestId("dlq-row")).toHaveCount(3);
    await page.getByTestId("dlq-delete-all").click();
    await expect(page.getByTestId("dlq-confirm-filter")).toContainText("Ждут решения");
    await page.getByTestId("dlq-reason").fill("Тестовые события стенда");
    await page.getByTestId("dlq-typed").fill("3");
    await page.getByTestId("dlq-confirm-ok").click();
    await totp(page);
    // перепроверка 8: число не подставляется молча — «в текущем виде 3, изменилось на 4», перечитать список
    await expect(page.getByTestId("dlq-count-changed")).toContainText("В текущем виде 3, изменилось на 4");
    await expect(page.getByTestId("dlq-typed")).toHaveValue("");
    await expect(page.getByTestId("dlq-typed")).toBeDisabled();
    await expect(page.getByTestId("dlq-confirm-ok")).toBeDisabled();
    await shot(page, "14-dlq-count-changed-light");
    await page.getByTestId("dlq-reread").click();
    await expect(page.getByTestId("dlq-confirm")).toHaveCount(0);
    await expect(page.getByTestId("dlq-row")).toHaveCount(4);
    await page.getByTestId("dlq-delete-all").click();
    await page.getByTestId("dlq-reason").fill("Тестовые события стенда");
    await page.getByTestId("dlq-typed").fill("4");
    await page.getByTestId("dlq-confirm-ok").click();
    await expect(page.getByTestId("dlq-result-sum")).toContainText(
      "Сделано 4 из 4",
    );
    const call = await lastCall(bff, "POST", "/ops/dlq/delete");
    expect(call.body).toMatchObject({
      filter: { consumer: "notifications_watch_changes", source: "dlq", state: "present" },
      expected_count: 4,
    });
    await page.getByTestId("dlq-result-close").click();
    await expect(page.getByTestId("dlq-empty")).toBeVisible();

    const bff2 = await again(page, "ops@tilhero.local", "#/monitoring/dlq", {
      auditDown: true,
    });
    await page.locator('[data-dlq="legacy:31877"]').click();
    await expect(page.getByTestId("dlq-unreadable")).toBeVisible();
    await page.getByTestId("dlq-drawer-delete").click();
    await page.getByTestId("dlq-reason").fill("Старое сообщение");
    await page.getByTestId("dlq-typed").fill("1");
    await page.getByTestId("dlq-confirm-ok").click();
    await totp(page);
    await expect(page.getByTestId("dlq-confirm")).toContainText(
      "Журнал аудита недоступен — ничего не сделано",
    );
    // review 8: a repeat from the same open dialog is the same command — the same Idempotency-Key
    await page.getByTestId("dlq-confirm-ok").click();
    // calls: step-up required → the same request after TOTP → the repeat from the dialog
    await expect.poll(() => bff2.calls("POST", "/ops/dlq/delete").length).toBe(3);
    const keys = new Set(bff2.calls("POST", "/ops/dlq/delete").map((c) => c.headers["idempotency-key"]));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^dlq-delete-/);
    await page
      .getByTestId("dlq-confirm")
      .getByRole("button", { name: "Отмена" })
      .click();
    await page.getByTestId("drawer-close").click();
    await expect(page.getByTestId("dlq-row")).toHaveCount(4);
  });

  test("DLQ by filter = the view: «delete all» in «waiting» leaves the replayed messages and other sources", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/monitoring/dlq/notifications_watch_changes");
    await expect(page.getByTestId("dlq-row")).toHaveCount(3);
    // dlq:42 is replayed — it stays in the DLQ marked, out of the «waiting» view
    await page.locator('[data-dlq="dlq:42"]').click();
    await page.getByTestId("dlq-drawer-replay").click();
    await page.getByTestId("dlq-reason").fill("Исправлен обработчик");
    await page.getByTestId("dlq-typed").fill("1");
    await page.getByTestId("dlq-confirm-ok").click();
    await totp(page);
    await page.getByTestId("dlq-result-close").click();
    await expect(page.getByTestId("dlq-row")).toHaveCount(2);
    await page.getByTestId("dlq-delete-all").click();
    await page.getByTestId("dlq-reason").fill("Удаляем ждущие");
    await page.getByTestId("dlq-typed").fill("2");
    await page.getByTestId("dlq-confirm-ok").click();
    await expect(page.getByTestId("dlq-result-sum")).toContainText("Сделано 2 из 2");
    expect((await lastCall(bff, "POST", "/ops/dlq/delete")).body).toMatchObject({ filter: { consumer: "notifications_watch_changes", state: "present" }, expected_count: 2 });
    await page.getByTestId("dlq-result-close").click();
    // the result dialog was the feedback: no toast covers the «Result» column of the history
    await expect(page.getByTestId("toasts").locator(".toast")).toHaveCount(0);
    await page.getByTestId("dlq-state").selectOption("all");
    await expect(page.getByTestId("dlq-row")).toHaveCount(1);
    await expect(page.locator('[data-dlq="dlq:42"]').getByTestId("dlq-replayed")).toBeVisible();
    await shot(page, "16b-dlq-view-filter-light");
  });

  test("rights: without ops.queues.manage the DLQ is read-only (no envelope, locked commands); support has no monitoring", async ({
    page,
  }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/monitoring/dlq", {
      matrix: {
        operations: [
          "dashboard.read",
          "users.read",
          "support.read",
          "ops.kill_switch",
          "audit.read",
        ],
      },
    });
    await expect(page.getByTestId("dlq-row")).toHaveCount(4);
    await expect(page.getByTestId("dlq-acts")).toHaveCount(0);
    await expect(page.getByTestId("dlq-check")).toHaveCount(0);
    await page.locator('[data-dlq="dlq:42"]').click();
    await expect(page.getByTestId("dlq-locked")).toBeVisible();
    await expect(page.getByTestId("dlq-drawer-replay")).toHaveClass(
      /is-locked/,
    );
    await shot(page, "15-dlq-locked-light");
    expect(bff.calls("GET", /^\/ops\/dlq\/dlq/)).toHaveLength(0);

    // ops.kill_switch only for acknowledging alerts: operations without it see the button locked
    await again(page, "ops@tilhero.local", "#/monitoring/alerts", {
      matrix: { operations: ["dashboard.read", "ops.queues.manage"] },
    });
    await expect(
      page
        .locator(`[data-alert="${ALERT.aviasales}"]`)
        .getByTestId("mon-alert-ack"),
    ).toHaveClass(/is-locked/);

    await again(page, "support@tilhero.local", "#/monitoring/providers");
    await expect(page.getByTestId("toasts")).toContainText("недоступен");
    await expect(page.locator('[data-nav="monitoring"]')).toHaveCount(0);
  });

  test("alerts: open and resolved, acknowledge with a comment (audited), audit down → nothing changed", async ({
    page,
  }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/monitoring/alerts");
    const list = page.getByTestId("mon-alert-list");
    await expect(list.getByTestId("mon-alert")).toHaveCount(3);
    await expect(list.locator(`[data-alert="${ALERT.dlq}"]`)).toContainText(
      "Разбираем обработчик",
    );
    await expect(
      list.locator(`[data-alert="${ALERT.dlq}"]`).getByTestId("mon-alert-ack"),
    ).toHaveCount(0);
    await expect(list.locator(`[data-alert="${ALERT.route}"]`)).toContainText(
      "FRU ×12",
    );
    await shot(page, "16-alerts-light", true);
    await list
      .locator(`[data-alert="${ALERT.aviasales}"]`)
      .getByTestId("mon-alert-ack")
      .click();
    await page
      .getByTestId("mon-ack-comment")
      .fill("Пишу в поддержку Aviasales");
    await page.getByTestId("mon-ack-ok").click();
    await expect(page.getByTestId("toasts")).toContainText(
      "Оповещение отмечено",
    );
    // visible toasts reserve room under the page — the last rows scroll above them
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--toasts-h"))).not.toBe("");
    const call = await lastCall(
      bff,
      "POST",
      `/alerts/ops/${ALERT.aviasales}/ack`,
    );
    expect(call.body).toEqual({ comment: "Пишу в поддержку Aviasales" });
    expect(call.headers["idempotency-key"]).toBeTruthy();
    await expect(
      list.locator(`[data-alert="${ALERT.aviasales}"]`),
    ).toContainText("Пишу в поддержку Aviasales");
    await page
      .getByTestId("mon-alerts-state")
      .getByRole("button", { name: "Закрытые" })
      .click();
    await expect(list.getByTestId("mon-alert")).toHaveCount(1);
    await expect(list).toContainText("Ключ перевыпущен");
    await list.getByTestId("mon-alert-go").click();
    await expect(page).toHaveURL(/#\/monitoring\/providers\/liteapi$/);

    await again(page, "ops@tilhero.local", "#/monitoring/alerts", {
      auditDown: true,
    });
    await page
      .locator(`[data-alert="${ALERT.route}"]`)
      .getByTestId("mon-alert-ack")
      .click();
    await page.getByTestId("mon-ack-ok").click();
    await expect(page.getByTestId("mon-ack")).toContainText(
      "Журнал аудита недоступен",
    );
  });

  test("bell: one feed of ops and AI alerts, a partial feed is said, an ops alert opens its provider", async ({
    page,
  }) => {
    await openAs(page, "ops@tilhero.local", "#/dashboard", {
      feedAiDown: true,
    });
    await expect(page.getByTestId("bell-count")).toHaveText("2");
    await page.getByTestId("bell").click();
    await expect(page.getByTestId("bell-partial")).toContainText(
      "Алерты AI недоступны",
    );
    await expect(
      page.getByTestId("bell-list").locator('[data-source="ops"]'),
    ).toHaveCount(2);
    await shot(page, "17-bell-partial-light");
    await page
      .getByTestId("bell-list")
      .locator(`[data-alert="${ALERT.aviasales}"] .bell-item`)
      .click();
    await expect(page).toHaveURL(/#\/monitoring\/providers\/aviasales$/);
    await expect(page.getByTestId("mon-prov-drawer")).toBeVisible();

    await again(page, "ops@tilhero.local", "#/dashboard");
    await page.getByTestId("bell").click();
    await expect(
      page.getByTestId("bell-list").locator('[data-source="ai"]'),
    ).toHaveCount(2);
    await expect(
      page.getByTestId("bell-list").locator("[data-alert]").first(),
    ).toHaveAttribute("data-source", "ai"); // same severity — newest first
    await page
      .getByTestId("bell-list")
      .locator(`[data-alert="${AI_ALERT.a90}"]`)
      .getByTestId("ai-alert-ack")
      .click();
    await expect(
      page.getByTestId("bell-list").locator("[data-alert]"),
    ).toHaveCount(3);
    await shot(page, "18-bell-light");
    await page.getByTestId("bell-open-mon").click();
    await expect(page).toHaveURL(/#\/monitoring\/alerts$/);
  });

  test("requests: «quota not charged» in the log and the drill-down", async ({
    page,
  }) => {
    await openAs(page, "admin@tilhero.local", "#/requests");
    await page.getByTestId("req-tab-log").click();
    await expect(
      page
        .locator(`[data-request="${REQ.cheaper}"]`)
        .getByTestId("req-quota-free"),
    ).toHaveAttribute("data-reason", "no_change");
    await expect(
      page
        .locator(`[data-request="${REQ.outage}"]`)
        .getByTestId("req-quota-free"),
    ).toContainText("квота не списана");
    await expect(
      page
        .locator(`[data-request="${REQ.direct}"]`)
        .getByTestId("req-quota-free"),
    ).toHaveCount(0);
    await page.getByTestId("req-log").scrollIntoViewIfNeeded();
    await shot(page, "19-requests-quota-light");
    await page.locator(`[data-request="${REQ.outage}"]`).click();
    await expect(
      page.getByTestId("req-drawer").getByTestId("req-quota-free"),
    ).toHaveAttribute("data-reason", "failed");
  });

  test("not connected: no OPS_MONITOR_URL → «Monitoring is not connected» names ops-monitor; EN without Cyrillic", async ({
    page,
  }) => {
    await openAs(page, "ops@tilhero.local", "#/monitoring/providers", {
      opsOff: true,
    });
    await expect(page.getByTestId("mon-off")).toContainText(
      "Мониторинг не подключён",
    );
    await expect(page.getByTestId("mon-off")).toContainText("ops-monitor");
    await shot(page, "20-monitoring-off-light");

    await again(page, "ops@tilhero.local", "#/monitoring/providers");
    await page.getByTestId("lang-en").click();
    await expect(page.getByTestId("page-title")).toHaveText("Monitoring");
    await expect(page.getByTestId("mon-prov-row").first()).toBeVisible();
    await noCyrillic(page, "monitoring");
    for (const tab of ["queues", "dlq", "alerts"]) {
      await page.getByTestId(`mon-tab-${tab}`).click();
      await expect(page).toHaveURL(new RegExp(`#/monitoring/${tab}`));
      await page.waitForTimeout(300);
      await noCyrillic(page, "monitoring");
    }
    await page.locator('[data-nav="dashboard"]').click();
    await expect(page.getByTestId("dash-system")).toHaveAttribute(
      "data-available",
      "true",
    );
    await noCyrillic(page, "dashboard");
    await shot(page, "21-dashboard-en-light", true);
  });
});

for (const w of [1024, 768, 400] as const) {
  test.describe(`width ${w}`, () => {
    test.use({ viewport: { width: w, height: w === 400 ? 860 : 900 } });

    test(`dashboard and monitoring fit ${w} px, light and dark`, async ({
      page,
    }) => {
      await openAs(page, "ops@tilhero.local", "#/dashboard");
      await expect(page.getByTestId("dash-system")).toHaveAttribute(
        "data-available",
        "true",
      );
      await expectNoHScroll(page);
      await shot(page, `w${w}-dashboard-light`, true);
      for (const tab of ["providers", "queues", "dlq", "alerts"]) {
        await page.goto(`/#/monitoring/${tab}`);
        await expect(page.getByTestId(`mon-tab-${tab}`)).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(page.getByTestId("mon-summary")).toBeVisible();
        await page.waitForTimeout(200);
        await expectNoHScroll(page);
        if (tab === "providers" || tab === "dlq")
          await shot(page, `w${w}-mon-${tab}-light`, true);
      }
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto("/#/monitoring/providers/aviasales");
      await expect(page.getByTestId("mon-chart")).toBeVisible();
      await expectNoHScroll(page);
      await shot(page, `w${w}-provider-drawer-dark`);
      await page.goto("/#/dashboard");
      await expect(page.getByTestId("dash-system")).toHaveAttribute(
        "data-available",
        "true",
      );
      await shot(page, `w${w}-dashboard-dark`, true);
    });
  });
}

/* Review 8 of the front end: dashboard head (freshness, today boundary, refresh past the cache), urgent alerts above
   the dashboard, colour + icon, queues (stuck acks, stale snapshots), request status hint, narrow screens. */
test.describe("review 8", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("dashboard: urgent alerts with «Open» / «Hide», freshness of the data, refresh past the cache, Tashkent today, AI budgets in UTC", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/dashboard", { providerDown: true, dashStale: ["support"], dashOff: { news: "unavailable" } });
    const crit = page.getByTestId("dash-crit");
    await expect(crit.getByTestId("dash-crit-row")).toHaveCount(1);
    await expect(crit).toContainText("Aviasales");
    await expect(crit).toContainText("смена статуса");
    const fresh = page.getByTestId("dash-fresh");
    await expect(fresh).toHaveAttribute("data-tone", "bad");
    await expect(fresh).toContainText("данные на");
    await expect(fresh).toContainText("1 блок из копии");
    await expect(fresh).toContainText("1 блок без данных");
    await expect(page.locator(".dash-head")).toContainText("сегодня — с 00:00 по Ташкенту");
    await expect(page.getByTestId("dash-ai-utc")).toContainText("по UTC");
    await expect(page.getByTestId("dash-ai-p95")).not.toHaveClass(/is-bad/);
    await shot(page, "30-dashboard-urgent-light");
    await page.locator("html").evaluate((el) => el.setAttribute("data-theme", "dark"));
    await shot(page, "31-dashboard-urgent-dark");
    await page.locator("html").evaluate((el) => el.removeAttribute("data-theme"));

    const forced = page.waitForRequest((r) => r.url().includes("/admin/v1/dashboard?") && r.url().includes("refresh=true"));
    await page.getByTestId("dash-refresh").click();
    await forced;
    // перепроверка 8: 15 с кнопка неактивна, рядом «обновлено только что»
    await expect(page.getByTestId("dash-refresh")).toBeDisabled();
    await expect(page.getByTestId("dash-refresh-recent")).toHaveText("обновлено только что");
    await expect(page.getByTestId("dash-refresh")).toHaveAttribute("title", /Обновлено только что — снова можно через \d+ с/);

    await crit.getByTestId("dash-crit-hide").click();
    await expect(page.getByTestId("dash-crit")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("dash-system")).toBeVisible();
    await expect(page.getByTestId("dash-crit")).toHaveCount(0); // hidden for this browser session

    await again(page, "ops@tilhero.local", "#/dashboard", { providerDown: true });
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(page.getByTestId("dash-fresh")).toHaveAttribute("data-tone", "good");
    await page.getByTestId("dash-crit-open").click();
    await expect(page).toHaveURL(/#\/monitoring\/providers\/aviasales$/);
  });

  test("queues: «no acks for N min» by the new rule, stale snapshots of outbox / readiness, failing outbox not by colour only", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/monitoring/queues", { queueLag: true });
    const stalled = page.locator('[data-consumer="user_admin_users"]');
    await expect(stalled.getByTestId("mon-cons-status")).toHaveText(/Застрял/);
    await expect(stalled.getByTestId("mon-cons-stuck")).toContainText("23 мин");
    await expect(stalled.getByTestId("mon-cons-stuck").locator("svg")).toHaveCount(1);
    await expect(page.locator('[data-consumer="ai_control_usage"]').getByTestId("mon-cons-stuck")).toContainText("25 с");
    await expect(page.locator('[data-consumer="notifications_ops_alerts"]').getByTestId("mon-cons-stuck")).toHaveText("—");
    await expect(page.getByTestId("mon-consumers")).toContainText("ack floor не двигается 20 мин");
    await expect(page.locator('[data-service="watch"]').getByTestId("mon-outbox-stale")).toContainText("данные устарели");
    await expect(page.locator('[data-service="offers"]').getByTestId("mon-outbox-stale")).toHaveCount(0);
    const pref = page.locator('[data-testid="mon-svc-row"]', { hasText: "preferences" });
    await expect(pref.getByTestId("mon-svc-stale")).toBeVisible();
    // перепроверка 8: устаревший снимок — «нет данных» (серая точка), прежнее — в подсказке
    await expect(pref).toHaveAttribute("data-ready", "unknown");
    await expect(pref.getByTestId("mon-svc-ready")).toHaveAttribute("title", "последнее известное: в норме");
    const dot = await pref.locator(".health-dot").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(dot).toBe("rgba(0, 0, 0, 0)");
    const watchOutbox = page.locator('[data-service="watch"]');
    await expect(watchOutbox.getByTestId("mon-stale-val")).toHaveCount(2);
    await expect(watchOutbox.getByTestId("mon-stale-val").first()).toHaveText("нет данных");
    await expect(page.locator('[data-service="news"] td').nth(2).locator("svg")).toHaveCount(1);
    await expect(page.getByTestId("mon-tab-queues")).toBeVisible();
    await shot(page, "32-queues-review8-light", true);
  });

  test("history chart: p95 on its own right scale; request log: the full status in the hint", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/monitoring/providers/aviasales");
    const chart = page.getByTestId("mon-chart");
    await expect(chart.locator("text.p95t")).toHaveCount(3);
    await expect(chart).toContainText("p95 (правая шкала)");
    await page.locator("html").evaluate((el) => el.setAttribute("data-theme", "dark"));
    await shot(page, "33-chart-dark");
    await page.locator("html").evaluate((el) => el.removeAttribute("data-theme"));
    await page.goto(`/#/requests`);
    await page.getByTestId("req-tab-log").click();
    await expect(page.locator(`[data-request="${REQ.outage}"]`).getByTestId("req-status")).toHaveAttribute("title", /Частично · PROVIDER_UNAVAILABLE · квота не списана \(ход не удался\)/);
  });

  test("alert counters say what they count; the bell warns only when a source did not answer", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/monitoring/alerts");
    await expect(page.getByTestId("mon-k-alerts")).toContainText("2");
    await expect(page.getByTestId("mon-k-alerts")).toContainText("неподтверждённых");
    await expect(page.getByTestId("mon-alerts-unacked")).toHaveText("неподтверждённых 2 из 3");
    await expect(page.getByTestId("bell")).toHaveAttribute("aria-label", /Неподтверждённых оповещений: 4/);
    await again(page, "ops@tilhero.local", "#/dashboard", { aiOff: true });
    await page.getByTestId("bell").click();
    await expect(page.getByTestId("bell-partial")).toHaveCount(0);
  });
});

test.describe("review 8 · 400 px", () => {
  test.use({ viewport: { width: 400, height: 860 } });

  test("tabs say they scroll; DLQ rows are cards with column names", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/monitoring/dlq");
    await expect(page.getByTestId("dlq-row")).toHaveCount(4);
    await expect(page.locator(".tabs[role=tablist]").first()).toHaveAttribute("data-more", /left|right|both/);
    await expect(page.locator(".mon-dlq-tbl thead")).toBeHidden();
    await expect(page.locator(".mon-dlq-hist-tbl thead")).toBeHidden();
    const hist = page.getByTestId("dlq-hist-row").first();
    expect(await hist.locator("td[data-label]").last().evaluate((el) => getComputedStyle(el, "::before").content)).toContain("Итог");
    const row = page.getByTestId("dlq-row").first();
    const box = (await row.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(400);
    expect(await row.locator("td[data-label]").first().evaluate((el) => getComputedStyle(el, "::before").content)).toContain("Попало");
    await expectNoHScroll(page);
    await shot(page, "w400-dlq-cards-light", true);
    await page.getByTestId("dlq-history").scrollIntoViewIfNeeded();
    await settle(page);
    await page.getByTestId("dlq-history").screenshot({ path: `${SHOTS}/w400-dlq-history-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "w400-dlq-cards-dark", true);
    await page.goto("/#/monitoring/providers");
    await expect(page.getByTestId("mon-prov-row").first()).toBeVisible();
    await shot(page, "w400-mon-providers-dark");
  });
});

/**
 * Спринт 8 (docs/sprint8/INTERNAL_API.md §7.4–7.5): дашборд DashboardV2 (независимые блоки, кэш, stale, таймаут,
 * права блоков, P95), «Мониторинг» (ops-monitor: поставщики, проба, очереди, DLQ — права, step-up, команды),
 * колокольчик (ops + AI). Матрица прав/step-up/happy path всех маршрутов — routes.test.ts.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AlertFeed, DashboardV2, DlqAction, ProviderHealthList } from "@tilhero/contracts/admin";
import { aiSeverity, mergeFeed } from "../src/routes/alerts.js";
import { DASHBOARD_FORCE_MIN_SECONDS, permsKey, periodRange } from "../src/routes/dashboard.js";
import { DLQ_MASKING_RULES, idOwner, normKey, piiKey, remaskEnvelope } from "../src/routes/opsCodecs.js";
import { checkDlqCommand } from "../src/routes/ops.js";
import {
  ALERT_ID,
  OPERATOR_ID,
  OPS_ALERT_ID,
  aiAlertRow,
  browser,
  closeRedis,
  domainError,
  fakeLimits,
  fakeSprint7,
  fakeSprint8,
  json,
  loginAs,
  makeHarness,
  providerHealthRow,
  redis,
  stepUp,
  type Harness,
  type Service,
  type Session,
} from "./helpers.js";

let h: Harness;
const setup = async (env: Record<string, string> = {}, patch?: Parameters<typeof makeHarness>[2]) => {
  h = await makeHarness(env, {}, patch);
  fakeLimits(h.fake);
  fakeSprint7(h.fake);
  fakeSprint8(h.fake);
};
beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

type M = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const call = (method: M, url: string, s: Session | null, payload?: unknown, headers?: Record<string, string>) =>
  h.app.inject({ method, url, headers: browser(s, headers), ...(payload !== undefined ? { payload: payload as object } : {}) });
const idem = (k: string) => ({ "idempotency-key": `test-${k}-0001` });
const dash = async (s: Session, period = "today") => {
  const res = await call("GET", `/admin/v1/dashboard?period=${period}`, s);
  expect(res.statusCode).toBe(200);
  return res.json() as DashboardV2;
};
const BLOCKS = ["users", "trips", "no_flight", "watch", "news", "ai", "support", "system"] as const;
/** блок → домен, без которого у блока нет данных */
const SOURCE: Record<(typeof BLOCKS)[number], Service> = {
  users: "userAdmin",
  trips: "offers",
  no_flight: "offers",
  watch: "watch",
  news: "news",
  ai: "aiControl",
  support: "support",
  system: "opsMonitor",
};
const flush = async () => {
  const keys = await redis().keys(`${h.config.redisKeyPrefix}dash:*`);
  if (keys.length) await redis().del(...keys);
};

describe("дашборд v2", () => {
  it("все источники: восемь блоков с данными, коммерция отложена, период → from/to для offers и news", async () => {
    const { s } = await loginAs(h, "operations");
    const d = await dash(s, "7d");
    expect(d.period).toBe("7d");
    for (const b of BLOCKS) expect(d[b], b).toMatchObject({ available: true, reason: null, stale: false });
    expect(d.users.data).toMatchObject({ total: 120, active_in_period: 64, active_today: 21 });
    expect(d.trips.data).toMatchObject({ builds: 310, no_flight_total: 31, by_caller: { "telegram-bff": 250 } });
    expect(d.no_flight.data!.pairs[0]).toMatchObject({ dest_iata: "FRU", band: "lt600", count: 12 });
    expect(d.no_flight.data!.bands).toEqual({ lt600: 19, ge600: 10, unknown: 2 });
    expect(d.news.data).toMatchObject({ items: { article: 48 }, sources: { problem: 1 } });
    expect(d.ai.data!.kpi.requests).toBeGreaterThan(0);
    expect(d.ai.data!.budgets!.agents.find((a) => a.agent_id === "concierge")).toMatchObject({ name: expect.any(String), paused: expect.any(Boolean) });
    expect(d.system.data).toMatchObject({ services: { up: 23, total: 24, down: ["news"] }, alerts: { warning: 2 } });
    expect(d.commercial).toEqual({ available: false, reason: "postponed" });
    const q = h.fake.callsTo("offers", "GET", "/internal/v1/offers/stats/no-flight")[0]!.query;
    expect(q.limit).toBe("20");
    expect(Date.parse(q.to!) - Date.parse(q.from!)).toBe(7 * 86_400_000);
    expect(h.fake.callsTo("news", "GET", "/internal/v1/news/stats")[0]!.actor?.permissions).toContain("dashboard.read");
  });

  it("каждый источник по очереди недоступен → только его блок «нет данных», ответ 200", async () => {
    const { s } = await loginAs(h, "operations");
    for (const service of [...new Set(Object.values(SOURCE))]) {
      await flush();
      h.fake.down.add(service);
      const d = await dash(s);
      for (const b of BLOCKS) {
        if (SOURCE[b] === service) expect(d[b], `${service}: ${b}`).toEqual({ available: false, reason: "unavailable", stale: false, as_of: null, data: null });
        else expect(d[b].available, `${service}: ${b}`).toBe(true);
      }
      h.fake.down.delete(service);
    }
  });

  it("тёплый кэш: повторное открытие без вызовов доменов; сбой после истечения → stale-копия с as_of", async () => {
    const { s } = await loginAs(h, "operations");
    const first = await dash(s);
    const calls = h.fake.calls.length;
    const again = await dash(s);
    expect(h.fake.calls.length).toBe(calls);
    expect(again.trips).toEqual(first.trips);
    // свежая копия истекла (удалена), источник упал → последняя копия с отметкой давности
    const fresh = await redis().keys(`${h.config.redisKeyPrefix}dash:trips:today`);
    await redis().del(...fresh);
    h.fake.down.add("offers");
    const d = await dash(s);
    expect(d.trips).toMatchObject({ available: true, stale: true, as_of: first.trips.as_of, data: first.trips.data });
    expect(d.no_flight).toMatchObject({ available: true, stale: false }); // свежая копия ещё есть
  });

  it("медленный источник: блок ждёт DASHBOARD_BLOCK_TIMEOUT_MS → timeout; вызов дозаполняет кэш для следующего открытия", async () => {
    await h.close();
    await setup({ DASHBOARD_BLOCK_TIMEOUT_MS: "150", DASHBOARD_TIMEOUT_MS: "2000" });
    const { s } = await loginAs(h, "operations");
    h.fake.on("news", "GET", "/internal/v1/news/stats", () =>
      new Promise<Response>((resolve) => setTimeout(() => resolve(json(200, { items: { article: 1, event_update: 0 }, hidden: 0, sources: { enabled: 1, disabled: 0, problem: 0 }, last_collect_at: null })), 400).unref()),
    );
    const started = Date.now();
    const d = await dash(s);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(d.news).toMatchObject({ available: false, reason: "timeout" });
    expect(d.trips.available).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    const d2 = await dash(s);
    expect(d2.news).toMatchObject({ available: true, stale: false, data: { items: { article: 1 } } });
    expect(h.fake.callsTo("news", "GET", "/internal/v1/news/stats")).toHaveLength(1);
  });

  it("одновременные открытия холодного дашборда — один вызов каждого источника (single-flight)", async () => {
    const { s } = await loginAs(h, "operations");
    await Promise.all([dash(s), dash(s), dash(s)]);
    expect(h.fake.callsTo("offers", "GET", "/internal/v1/offers/stats").filter((c) => c.path === "/internal/v1/offers/stats")).toHaveLength(1);
    expect(h.fake.callsTo("opsMonitor", "GET", "/internal/v1/ops/summary")).toHaveLength(1);
  });

  it("права и подключение: users без users.read — forbidden (домен не вызывается); ops-monitor не подключён — not_configured; 403 домена — forbidden", async () => {
    const { s } = await loginAs(h, "read_only", { permissions: ["dashboard.read"] });
    const d = await dash(s);
    expect(d.users).toEqual({ available: false, reason: "forbidden", stale: false, as_of: null, data: null });
    expect(h.fake.callsTo("userAdmin", "GET", "/admin/v1/users/stats")).toHaveLength(0);
    h.fake.on("support", "GET", "/admin/v1/support/stats", () => domainError(403, "PERMISSION_DENIED", { permission: "support.read" }));
    await flush();
    expect((await dash(s)).support).toMatchObject({ available: false, reason: "forbidden" });

    await h.close();
    await setup({}, (c) => {
      c.urls.opsMonitor = null;
      c.urls.aiControl = null;
    });
    const op = await loginAs(h, "operations");
    const d2 = await dash(op.s);
    expect(d2.system).toMatchObject({ available: false, reason: "not_configured" });
    expect(d2.ai).toMatchObject({ available: false, reason: "not_configured" });
    expect(d2.trips.available).toBe(true);
  });

  it("испорченный ответ (user-admin без active_in_period) — блок «нет данных», не нули", async () => {
    const { s } = await loginAs(h, "operations");
    h.fake.on("userAdmin", "GET", "/admin/v1/users/stats", () =>
      json(200, { total: 1, new_in_period: 0, onboarding_completed_pct: 0, by_status: { ACTIVE: 1, DISABLED: 0, DELETION_REQUESTED: 0, DELETED: 0 } }),
    );
    expect((await dash(s)).users).toMatchObject({ available: false, reason: "unavailable", data: null });
  });

  it("сбой бюджетов ai-control не прячет расходы: kpi есть, budgets null", async () => {
    const { s } = await loginAs(h, "operations");
    h.fake.on("aiControl", "GET", "/internal/v1/budgets/overview", () => domainError(503, "UPSTREAM_UNAVAILABLE"));
    const d = await dash(s);
    expect(d.ai).toMatchObject({ available: true });
    expect(d.ai.data!.budgets).toBeNull();
  });

  it("P95 ≤ 2 с на тёплом кэше (50 запросов) и dashboard_ms в логе", async () => {
    const { s } = await loginAs(h, "operations");
    await dash(s);
    const ms: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      await dash(s);
      ms.push(performance.now() - t);
    }
    ms.sort((a, b) => a - b);
    expect(ms[Math.ceil(0.95 * ms.length) - 1]!).toBeLessThan(2000);
    expect(h.logs.text).toContain('"dashboard_ms"');
  });

  it("ревью 8: прогрева от имени сотрудника нет — без запросов домены не вызываются", async () => {
    const { s } = await loginAs(h, "operations");
    await dash(s);
    const before = h.fake.callsTo("offers", "GET", "/internal/v1/offers/stats").length;
    await flush();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.fake.callsTo("offers", "GET", "/internal/v1/offers/stats")).toHaveLength(before);
    expect(Object.keys(await import("../src/routes/dashboard.js"))).not.toContain("WARM_EVERY_MS");
  });

  it("ревью 8: «Обновить» (refresh=true) идёт мимо свежего кэша — не чаще раза в 15 с на сотрудника", async () => {
    const { s } = await loginAs(h, "operations");
    await dash(s);
    const n = () => h.fake.callsTo("opsMonitor", "GET", "/internal/v1/ops/summary").length;
    expect(n()).toBe(1);
    await dash(s); // свежий кэш
    expect(n()).toBe(1);
    expect((await call("GET", "/admin/v1/dashboard?period=today&refresh=true", s)).statusCode).toBe(200);
    expect(n()).toBe(2);
    await call("GET", "/admin/v1/dashboard?period=today&refresh=true", s); // чаще 15 с — из кэша
    expect(n()).toBe(2);
    expect(DASHBOARD_FORCE_MIN_SECONDS).toBe(15);
    const [force] = await redis().keys(`${h.config.redisKeyPrefix}dash:force:*`);
    expect(await redis().ttl(force!)).toBeGreaterThan(0);
    expect((await call("GET", "/admin/v1/dashboard?refresh=yes", s)).statusCode).toBe(422);
  });

  it("ревью 8: single-flight по набору прав — 403 одного сотрудника не раздаётся другому и не кэшируется", async () => {
    expect(permsKey(["b", "a"])).toBe(permsKey(["a", "b"]));
    expect(permsKey(["a"])).not.toBe(permsKey(["a", "b"]));
    const narrow = await loginAs(h, "read_only", { permissions: ["dashboard.read"] });
    const wide = await loginAs(h, "operations");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.fake.on("support", "GET", "/admin/v1/support/stats", async (req) => {
      await gate;
      return (req.actor?.permissions ?? []).includes("support.read") ? json(200, { open: 1, in_progress: 0, waiting_customer: 0, breached: 0, avg_first_response_minutes: null, avg_resolution_minutes: null }) : domainError(403, "PERMISSION_DENIED", { permission: "support.read" });
    });
    const a = call("GET", "/admin/v1/dashboard", narrow.s);
    const b = call("GET", "/admin/v1/dashboard", wide.s);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.json().support).toMatchObject({ available: false, reason: "forbidden" });
    expect(rb.json().support).toMatchObject({ available: true, data: { open: 1 } });
    expect(h.fake.callsTo("support", "GET", "/admin/v1/support/stats")).toHaveLength(2);
  });

  it("ревью 8: «сегодня» у AI — та же граница 00:00 Ташкента, что у offers и news", async () => {
    const { s } = await loginAs(h, "operations");
    await dash(s, "today");
    const ai = h.fake.callsTo("aiControl", "GET", "/internal/v1/usage/kpi").at(-1)!.query;
    const offers = h.fake.callsTo("offers", "GET", "/internal/v1/offers/stats").at(-1)!.query;
    expect(ai.from).toBe(offers.from);
    expect(ai.from).toMatch(/T19:00:00Z$/);
  });

  it("period: today — с полуночи по Ташкенту; неверный period → 422", async () => {
    const now = Date.parse("2026-10-15T03:00:00Z"); // 08:00 в Ташкенте
    expect(periodRange(now, "today")).toEqual({ from: "2026-10-14T19:00:00Z", to: "2026-10-15T03:00:00Z" });
    expect(periodRange(now, "30d").from).toBe("2026-09-15T03:00:00Z");
    const { s } = await loginAs(h, "operations");
    expect((await call("GET", "/admin/v1/dashboard?period=year", s)).statusCode).toBe(422);
  });
});

describe("мониторинг: поставщики и очереди", () => {
  it("поставщики: {items}, «Проверить сейчас» не для Anthropic; проба Anthropic → 422 домена как есть", async () => {
    const { s } = await loginAs(h, "read_only");
    const res = await call("GET", "/admin/v1/ops/providers", s);
    expect(res.statusCode).toBe(200);
    const list = res.json() as ProviderHealthList;
    expect(list.items.map((p) => [p.provider, p.probe_supported])).toEqual([
      ["aviasales", true],
      ["anthropic", false],
    ]);
    expect(list.items[0]!.window.by_class).toMatchObject({ server: 4, timeout: 1, auth: 0 });
    const probe = await call("POST", "/admin/v1/ops/providers/aviasales/probe", s, {});
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({ probe: { ok: true, latency_ms: 512 }, provider: { provider: "aviasales", last_probe: { latency_ms: 512 } } });
    expect((await call("POST", "/admin/v1/ops/providers/anthropic/probe", s, {})).json()).toMatchObject({ code: "PROBE_NOT_SUPPORTED" });
    const hist = await call("GET", "/admin/v1/ops/providers/aviasales/history?range=7d", s);
    expect(hist.json()).toMatchObject({ range: "7d", step: "1h", route_top: [{ location: "FRU", count: 12 }] });
    expect(h.fake.callsTo("opsMonitor", "GET", "/internal/v1/health/providers/aviasales/history")[0]!.query).toEqual({ range: "7d" });
    expect((await call("GET", "/admin/v1/ops/providers/aviasales/history?range=1y", s)).statusCode).toBe(422);
    expect((await call("GET", "/admin/v1/ops/providers/Bad Name/history", s)).statusCode).toBe(422);
  });

  it("текст ошибки поставщика очищается; неизвестный статус → 503 UPSTREAM_UNAVAILABLE {service: ops-monitor}", async () => {
    const { s } = await loginAs(h, "read_only");
    h.fake.on("opsMonitor", "GET", "/internal/v1/health/providers", () =>
      json(200, [providerHealthRow({ last_error: { code: "X", reason: "upstream_5xx", message: "bad\u0000gateway " + "x".repeat(400), http_status: 502, at: null } })]),
    );
    const msg = (await call("GET", "/admin/v1/ops/providers", s)).json().items[0].last_error.message as string;
    expect(msg.length).toBeLessThanOrEqual(200);
    expect(msg).not.toContain("\u0000");
    h.fake.on("opsMonitor", "GET", "/internal/v1/health/providers", () => json(200, [providerHealthRow({ status: "on_fire" })]));
    const bad = await call("GET", "/admin/v1/ops/providers", s);
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "ops-monitor" } });
  });

  it("очереди: списки {items}; outbox без роутера — available=false с null; NATS недоступен → 503 NATS_UNAVAILABLE", async () => {
    const { s } = await loginAs(h, "read_only");
    const outbox = (await call("GET", "/admin/v1/ops/queues/outbox", s)).json();
    expect(outbox.items[1]).toMatchObject({ service: "provider-gateway", available: false, pending: null });
    const cons = (await call("GET", "/admin/v1/ops/queues/consumers", s)).json();
    expect(cons.items[0]).toMatchObject({ durable: "notifications_watch_changes", replay_enabled: true, dlq: { count: 3 } });
    h.fake.on("opsMonitor", "GET", "/internal/v1/queues/consumers", () => domainError(503, "NATS_UNAVAILABLE"));
    const down = await call("GET", "/admin/v1/ops/queues/consumers", s);
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: "NATS_UNAVAILABLE", details: { service: "nats" } });
  });

  it("ops-monitor не подключён → 503 FEATURE_UNAVAILABLE {service: ops-monitor} с понятным текстом", async () => {
    await h.close();
    await setup({}, (c) => {
      c.urls.opsMonitor = null;
    });
    const { s } = await loginAs(h, "read_only");
    const res = await call("GET", "/admin/v1/ops/providers", s);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "FEATURE_UNAVAILABLE", details: { service: "ops-monitor" } });
    expect(res.json().message).toContain("OPS_MONITOR_URL");
  });
});

describe("мониторинг: DLQ", () => {
  it("список — dashboard.read; сообщение с маскированным конвертом — только ops.queues.manage, no-store", async () => {
    const viewer = await loginAs(h, "read_only");
    const list = await call("GET", "/admin/v1/ops/dlq?consumer=notifications_watch_changes&source=dlq", viewer.s);
    expect(list.json()).toMatchObject({ total: 1, items: [{ dlq_id: "dlq:42", reason_class: "handler_error:KeyError" }] });
    expect(list.json().items[0]).not.toHaveProperty("envelope_masked");
    expect((await call("GET", "/admin/v1/ops/dlq/dlq:42", viewer.s)).json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "ops.queues.manage" } });
    expect((await call("GET", "/admin/v1/ops/dlq?dead_from=2026-10-15T10:00:00Z&dead_to=2026-10-15T09:00:00Z", viewer.s)).statusCode).toBe(422);
    const { s } = await loginAs(h, "operations");
    const d = await call("GET", "/admin/v1/ops/dlq/dlq:42", s);
    expect(d.statusCode).toBe(200);
    expect(d.headers["cache-control"]).toBe("no-store");
    expect(d.json()).toMatchObject({ envelope_readable: true, masked_fields: ["payload.chat_id", "payload.text"], envelope_masked: { payload: { chat_id: "***" } } });
    expect((await call("GET", "/admin/v1/ops/dlq/raw:42", s)).statusCode).toBe(422);
  });

  it("ревью 8: второй слой маскирования — нормализованные ключи, id людей и чатов, значения-шаблоны; UUID и служебные поля остаются", () => {
    for (const k of ["contactPhone", "User_Email", "event_title", "search-query", "home_address", "note", "Subject", "display_name"]) expect(piiKey(k), k).toBe(true);
    for (const k of ["event_id", "price", "currency", "status", "watch_id"]) expect(piiKey(k), k).toBe(false);
    // id людей и чатов — не по ключу, а по владельцу: числовое значение любой длины
    for (const k of ["fromId", "chatID", "tg_user_id", "recipient", "tg", "telegramId"]) expect(idOwner(k), k).toBe(true);
    const env = {
      event_id: "5e2c1a7b-0f3d-4b8e-9c6a-7d1e2f3a4b5c",
      type: "watch.change.detected.v1",
      payload: {
        user_id: "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
        from_id: 123456789,
        contactPhone: "+998 90 123 45 67",
        nested: { Title: "Концерт", items: [{ note: "позвонить", amount: "12.00" }], blob: "write to a@b.uz" },
        tg: 987654321012,
        change: { old_price: "1470.00", date: "2026-10-12" },
        chat_id: "***",
      },
    };
    const { envelope, paths } = remaskEnvelope(env);
    const p = envelope.payload as Record<string, unknown>;
    expect(envelope.event_id).toBe(env.event_id);
    expect(envelope.type).toBe(env.type);
    expect(p.user_id).toBe(env.payload.user_id);
    expect(p.from_id).toBe("***");
    expect(p.contactPhone).toBe("***");
    expect(p.tg).toBe("***");
    expect(p.change).toEqual({ old_price: "1470.00", date: "2026-10-12" });
    expect((p.nested as Record<string, unknown>).Title).toBe("***");
    expect((p.nested as Record<string, unknown>).blob).toBe("***");
    expect(((p.nested as Record<string, unknown>).items as Array<Record<string, unknown>>)[0]).toEqual({ note: "***", amount: "12.00" });
    expect(paths).toEqual(expect.arrayContaining(["payload.from_id", "payload.contactPhone", "payload.nested.Title", "payload.nested.items[0].note", "payload.nested.blob", "payload.tg"]));
    expect(paths).not.toContain("payload.chat_id"); // уже маскировано ops-monitor
  });

  it("перепроверка 8: правила как у ops-monitor — whitelist служебных ключей, служебные суффиксы, имена людей и сущностей, секреты, короткие id получателей", () => {
    expect(normKey("firstName")).toBe("first_name");
    expect(normKey("First-Name")).toBe("first_name");
    expect(normKey("userID")).toBe("user_id");
    // секреты
    for (const k of ["api_key", "apiKey", "Authorization", "client_secret", "password", "session_cookie", "refresh_token", "accessToken"]) expect(piiKey(k), k).toBe(true);
    // имена людей — да, имена сущностей — нет
    for (const k of ["name", "firstName", "full_name", "nickname", "surname", "contact_name", "name_ru"]) expect(piiKey(k), k).toBe(true);
    for (const k of ["provider_name", "city_name", "venue_name", "event_name", "file_name", "hostname", "airline_name"]) expect(piiKey(k), k).toBe(false);
    // служебные ключи и суффиксы: ссылки, счётчики, признаки, коды
    for (const k of ["event_id", "occurred_at", "producer", "schema_version", "causation_id", "trace_id", "template", "message_id", "subject_type", "input_tokens", "phone_verified", "error_code", "provider", "comment_count"]) expect(piiKey(k), k).toBe(false);
    expect(piiKey("code")).toBe(true); // OPS_PII_KEYS — точное совпадение
    const env = {
      event_id: "5e2c1a7b-0f3d-4b8e-9c6a-7d1e2f3a4b5c",
      event_type: "notification.requested.v1",
      payload: {
        recipient: { id: 4512, kind: "user" },
        tg_chat: 77,
        telegram: { user: { id: "8123" } },
        from: { id: 42, is_bot: false },
        provider_name: "Aviasales",
        city_name: "Ташкент",
        context: "write to +998 90 123 45 67",
        subtitle: "Иван звонил",
        counts: { message_count: 3 },
        api_key: "sk-live-123",
        error_code: "PROVIDER_UNAVAILABLE",
        phone_verified: true,
        user_id: "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
      },
    };
    const { envelope } = remaskEnvelope(env);
    const p = envelope.payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(envelope.event_type).toBe("notification.requested.v1");
    expect(p.recipient).toEqual({ id: "***", kind: "user" });
    expect(p.tg_chat).toBe("***");
    expect(p.telegram.user.id).toBe("***");
    expect(p.from).toEqual({ id: "***", is_bot: false });
    expect(p.provider_name).toBe("Aviasales");
    expect(p.city_name).toBe("Ташкент");
    expect(p.context).toBe("***"); // ключ не про PII, значение — телефон
    expect(p.subtitle).toBe("***"); // часть «title» — как у ops-monitor
    expect(p.counts).toEqual({ message_count: 3 });
    expect(p.api_key).toBe("***");
    expect(p.error_code).toBe("PROVIDER_UNAVAILABLE");
    expect(p.phone_verified).toBe(true);
    expect(p.user_id).toBe(env.payload.user_id);
  });

  it("ревью 8: конверт из ops-monitor с пропущенным полем — admin-bff маскирует и добавляет путь в masked_fields", async () => {
    h.fake.on("opsMonitor", "GET", "/internal/v1/dlq/messages/dlq:42", () =>
      json(200, {
        dlq_id: "dlq:42", source: "dlq", consumer: "notifications_watch_changes", service: "notifications", event_type: "watch.change.detected.v1",
        event_id: "5e2c1a7b-0f3d-4b8e-9c6a-7d1e2f3a4b5c", occurred_at: "2026-10-15T00:41:00Z", dead_at: "2026-10-15T00:43:00Z", deliveries: 5,
        reason_class: "handler_error:KeyError", replays: 0, size_bytes: 800,
        envelope_masked: { event_id: "5e2c1a7b-0f3d-4b8e-9c6a-7d1e2f3a4b5c", payload: { chat_id: "***", recipientName: "Игорь", from_id: 555666777 } },
        masked_fields: ["payload.chat_id"], envelope_readable: true,
      }),
    );
    const { s } = await loginAs(h, "operations");
    const d = (await call("GET", "/admin/v1/ops/dlq/dlq:42", s)).json();
    expect(d.envelope_masked.payload).toEqual({ chat_id: "***", recipientName: "***", from_id: "***" });
    expect(d.masked_fields).toEqual(["payload.chat_id", "payload.recipientName", "payload.from_id"]);
    expect(JSON.stringify(d)).not.toContain("Игорь");
  });

  it("повтор и удаление: право, step-up, Idempotency-Key, ровно одно из ids/filter, причина, ≤ 100 id; 30 с без повторов", async () => {
    // спринт 9: проверки контракта, а не лимитов — больше 10 команд DLQ в минуту (adm.dlq), лимитер выключен
    await h.close();
    await setup({ RATE_LIMITS_ENABLED: "false" });
    const viewer = await loginAs(h, "read_only");
    const body = { ids: ["dlq:42"], reason: "  Исправлен обработчик " };
    expect((await call("POST", "/admin/v1/ops/dlq/replay", viewer.s, body, idem("v"))).json().code).toBe("PERMISSION_DENIED");
    const { s } = await loginAs(h, "operations");
    expect((await call("POST", "/admin/v1/ops/dlq/replay", s, body, idem("a"))).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    expect((await call("POST", "/admin/v1/ops/dlq/replay", s, body)).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await call("POST", "/admin/v1/ops/dlq/replay", s, { ...body, filter: { consumer: "x_y" }, expected_count: 1 }, idem("b"))).json().code).toBe("DLQ_COMMAND_INVALID");
    expect((await call("POST", "/admin/v1/ops/dlq/delete", s, { filter: { consumer: "x_y" }, reason: "abc" }, idem("c"))).json().code).toBe("DLQ_COMMAND_INVALID");
    expect((await call("POST", "/admin/v1/ops/dlq/replay", s, { reason: "abc" }, idem("d"))).json().code).toBe("DLQ_COMMAND_INVALID");
    const many = Array.from({ length: 101 }, (_, i) => `dlq:${i + 1}`);
    expect((await call("POST", "/admin/v1/ops/dlq/replay", s, { ids: many, reason: "abc" }, idem("e"))).statusCode).toBe(422);
    expect((await call("POST", "/admin/v1/ops/dlq/replay", s, { ids: ["dlq:1"], reason: "  a " }, idem("f"))).statusCode).toBe(422);
    const ok = await call("POST", "/admin/v1/ops/dlq/replay", s, body, idem("g"));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ requested: 1, done: 1, skipped: [] });
    const sent = h.fake.callsTo("opsMonitor", "POST", "/internal/v1/dlq:replay");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ ids: ["dlq:42"], reason: "Исправлен обработчик" });
    expect(sent[0]!.headers["idempotency-key"]).toBe("test-g-0001");
    const del = await call("POST", "/admin/v1/ops/dlq/delete", s, { filter: { consumer: "notifications_watch_changes", event_type: "watch.change.detected.v1" }, expected_count: 3, reason: "Тест" }, idem("h"));
    expect(del.json()).toMatchObject({ requested: 3 });
    // перепроверка 8: фильтр = параметры списка; state по умолчанию — present (явно в ops-monitor)
    expect(h.fake.callsTo("opsMonitor", "POST", "/internal/v1/dlq:delete").at(-1)!.body.filter).toEqual({
      consumer: "notifications_watch_changes",
      event_type: "watch.change.detected.v1",
      state: "present",
    });
    await call("POST", "/admin/v1/ops/dlq/delete", s, { filter: { consumer: "notifications_watch_changes", source: "legacy", state: "all", dead_from: "2026-10-01T00:00:00Z" }, expected_count: 2, reason: "Тест" }, idem("i"));
    expect(h.fake.callsTo("opsMonitor", "POST", "/internal/v1/dlq:delete").at(-1)!.body.filter).toEqual({ consumer: "notifications_watch_changes", source: "legacy", state: "all", dead_from: "2026-10-01T00:00:00Z" });
    expect((await call("POST", "/admin/v1/ops/dlq/delete", s, { filter: { consumer: "x_y", state: "gone" }, expected_count: 1, reason: "Тест" }, idem("j"))).statusCode).toBe(422);
    expect((await call("POST", "/admin/v1/ops/dlq/delete", s, { filter: { consumer: "x_y", source: "raw" }, expected_count: 1, reason: "Тест" }, idem("k"))).statusCode).toBe(422);
  });

  it("ревью 8 (стык ops-monitor): state списка, include_replayed в команде, replayed_at; устаревшая готовность — unknown + last_ready; ALREADY_REPLAYED / NATS_ERROR как есть", async () => {
    h.fake.on("opsMonitor", "GET", "/internal/v1/dlq/messages", () =>
      json(200, { items: [{ dlq_id: "dlq:39", source: "dlq", consumer: "watch_offers", service: "watch", event_type: "offer.rebuilt.v1", event_id: "9d6a5e1f-4d7b-4f2c-9a0e-2c6d7e8f9a01", occurred_at: null, dead_at: "2026-10-15T08:00:00Z", deliveries: 5, reason_class: "handler_error:KeyError", replays: 1, size_bytes: 700, state: "replayed", replayed_at: "2026-10-15T09:00:00Z" }], next_cursor: null, total: 1 }),
    );
    h.fake.on("opsMonitor", "GET", "/internal/v1/queues/services", () =>
      json(200, [{ service: "offers", ready: "unknown", last_ready: "ok", latency_ms: 12, checked_at: "2026-10-15T08:00:00Z", stale: true }]),
    );
    h.fake.on("opsMonitor", "POST", "/internal/v1/dlq:replay", () =>
      json(200, { action_id: "3f0d4b5c-6e7a-4b8c-9d2e-000000000001", requested: 2, done: 0, skipped: [{ dlq_id: "dlq:39", reason: "ALREADY_REPLAYED" }, { dlq_id: "dlq:38", reason: "NATS_ERROR" }] }),
    );
    const viewer = await loginAs(h, "read_only");
    const list = await call("GET", "/admin/v1/ops/dlq?state=replayed", viewer.s);
    expect(list.json().items[0]).toMatchObject({ dlq_id: "dlq:39", state: "replayed", replayed_at: "2026-10-15T09:00:00Z" });
    expect(h.fake.callsTo("opsMonitor", "GET", "/internal/v1/dlq/messages").at(-1)!.query).toMatchObject({ state: "replayed" });
    expect((await call("GET", "/admin/v1/ops/dlq?state=gone", viewer.s)).statusCode).toBe(422);
    const svc = await call("GET", "/admin/v1/ops/queues/services", viewer.s);
    expect(svc.json().items[0]).toMatchObject({ ready: "unknown", last_ready: "ok", stale: true });
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    const r = await call("POST", "/admin/v1/ops/dlq/replay", s, { ids: ["dlq:39", "dlq:38"], reason: "Повтор", include_replayed: true }, idem("r8"));
    expect(r.json()).toMatchObject({ done: 0, skipped: [{ reason: "ALREADY_REPLAYED" }, { reason: "NATS_ERROR" }] });
    expect(h.fake.callsTo("opsMonitor", "POST", "/internal/v1/dlq:replay").at(-1)!.body).toEqual({ ids: ["dlq:39", "dlq:38"], reason: "Повтор", include_replayed: true });
  });

  it("команда DLQ: аудит недоступен → 503 AUDIT_UNAVAILABLE (один вызов); число изменилось → 409 DLQ_COUNT_CHANGED {actual} как есть", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    h.fake.on("opsMonitor", "POST", "/internal/v1/dlq:replay", () => domainError(503, "AUDIT_UNAVAILABLE", { service: "audit" }));
    const r = await call("POST", "/admin/v1/ops/dlq/replay", s, { ids: ["dlq:42"], reason: "Повтор" }, idem("a"));
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(h.fake.callsTo("opsMonitor", "POST", "/internal/v1/dlq:replay")).toHaveLength(1);
    h.fake.on("opsMonitor", "POST", "/internal/v1/dlq:delete", () => domainError(409, "DLQ_COUNT_CHANGED", { actual: 5 }));
    const c = await call("POST", "/admin/v1/ops/dlq/delete", s, { filter: { consumer: "notifications_watch_changes" }, expected_count: 3, reason: "Чистка" }, idem("b"));
    expect(c.statusCode).toBe(409);
    expect(c.json()).toMatchObject({ code: "DLQ_COUNT_CHANGED", details: { actual: 5 } });
  });

  it("история команд — имя сотрудника из staff/lookup", async () => {
    const { s } = await loginAs(h, "read_only");
    h.fake.addStaff({ role: "operations", staff_id: OPERATOR_ID, display_name: "Тимур" });
    const a = (await call("GET", "/admin/v1/ops/dlq/actions", s)).json().items[0] as DlqAction;
    expect(a).toMatchObject({ kind: "replay", by: OPERATOR_ID, by_name: "Тимур", selector: { ids: ["dlq:42"] } });
  });

  it("checkDlqCommand: период фильтра", () => {
    expect(() => checkDlqCommand({ filter: { consumer: "a_b", dead_from: "2026-10-15T10:00:00Z", dead_to: "2026-10-15T09:00:00Z" }, expected_count: 1, reason: "abc" })).toThrow();
    expect(() => checkDlqCommand({ ids: ["dlq:1"], reason: "abc" })).not.toThrow();
  });
});

describe("колокольчик: ops + AI", () => {
  it("лента: важные выше, counts — по неподтверждённым; ai-control недоступен → partial, ops остаются", async () => {
    const { s } = await loginAs(h, "read_only");
    h.fake.on("aiControl", "GET", "/internal/v1/budgets/alerts", () =>
      json(200, { items: [aiAlertRow(), aiAlertRow({ alert_id: "a1e2b3c4-d5f6-4a7b-8c9d-0e1f2a3b4c99", threshold: 100, auto_paused: true })], next_cursor: null }),
    );
    const feed = (await call("GET", "/admin/v1/alerts?state=open", s)).json() as AlertFeed;
    expect(feed.items.map((x) => [x.source, x.severity])).toEqual([
      ["ai", "critical"],
      ["ops", "warning"],
      ["ai", "warning"],
    ]);
    expect(feed.counts).toEqual({ critical: 1, warning: 2, info: 0 });
    expect(feed).toMatchObject({ partial: false, sources: { ops: "ok", ai: "ok" } });
    expect(h.fake.callsTo("aiControl", "GET", "/internal/v1/budgets/alerts")[0]!.query).toMatchObject({ unacked: "true" });
    h.fake.down.add("aiControl");
    const p = (await call("GET", "/admin/v1/alerts", s)).json() as AlertFeed;
    expect(p).toMatchObject({ partial: true, sources: { ops: "ok", ai: "unavailable" } });
    expect(p.items.map((x) => x.source)).toEqual(["ops"]);
  });

  it("ack: ops — ops.kill_switch, комментарий, ключ ack-<id> по умолчанию; AI — через ai-control; без права — 403", async () => {
    const viewer = await loginAs(h, "read_only");
    expect((await call("POST", `/admin/v1/alerts/ops/${OPS_ALERT_ID}/ack`, viewer.s, {})).json().code).toBe("PERMISSION_DENIED");
    const { staff, s } = await loginAs(h, "operations");
    const r = await call("POST", `/admin/v1/alerts/ops/${OPS_ALERT_ID}/ack`, s, { comment: " Смотрим " });
    expect(r.json()).toMatchObject({ source: "ops", id: OPS_ALERT_ID, acked: true });
    const sent = h.fake.callsTo("opsMonitor", "POST", `/internal/v1/alerts/${OPS_ALERT_ID}:ack`)[0]!;
    expect(sent.body).toEqual({ comment: "Смотрим" });
    expect(sent.headers["idempotency-key"]).toBe(`ack-${OPS_ALERT_ID}`);
    expect(sent.actor?.id).toBe(staff.staff_id);
    expect((await call("POST", `/admin/v1/alerts/ops/${OPS_ALERT_ID}/ack`, s, { comment: "x".repeat(301) })).statusCode).toBe(422);
    const ai = await call("POST", `/admin/v1/alerts/ai/${ALERT_ID}/ack`, s, {});
    expect(ai.json()).toMatchObject({ source: "ai", subject: "concierge", acked: true });
    expect((await call("POST", `/admin/v1/alerts/sms/${ALERT_ID}/ack`, s, {})).statusCode).toBe(422);
  });

  it("важность алертов AI и слияние без источников", () => {
    const a = aiAlertRow() as never;
    expect(aiSeverity({ ...(a as object), threshold: 70 } as never)).toBe("info");
    expect(aiSeverity({ ...(a as object), threshold: 90 } as never)).toBe("warning");
    expect(aiSeverity({ ...(a as object), kind: "unpriced", threshold: 0 } as never)).toBe("warning");
    expect(aiSeverity({ ...(a as object), threshold: 90, auto_paused: true } as never)).toBe("critical");
    expect(mergeFeed(null, null, { ops: "not_configured", ai: "not_configured" })).toEqual({
      items: [],
      counts: { critical: 0, warning: 0, info: 0 },
      partial: true,
      sources: { ops: "not_configured", ai: "not_configured" },
    });
  });
});

// перепроверка 8 (интеграция): второй слой маскирования = правила ops-monitor — один эталон для обеих сторон
describe("перепроверка 8: маскирование DLQ совпадает с ops-monitor (packages/contracts/dlq-masking.json)", () => {
  const spec = JSON.parse(readFileSync(new URL("../../../packages/contracts/dlq-masking.json", import.meta.url), "utf-8")) as {
    rules: Record<string, string[]>;
    keys: Record<string, string[]>;
    payloads: { payload: Record<string, unknown>; masked: Record<string, unknown>; masked_fields: string[] }[];
  };
  const sorted = (a: string[]) => [...a].sort();
  it("списки правил", () => {
    const r = DLQ_MASKING_RULES as Record<string, string[]>;
    for (const k of ["pii_keys", "pii_key_parts", "id_owner_parts"]) expect(r[k], k).toEqual(spec.rules[k]);
    for (const k of ["safe_keys", "safe_suffixes", "non_person_name", "id_owner_tokens"]) expect(sorted(r[k]!), k).toEqual(sorted(spec.rules[k]!));
  });
  it("ключи", () => {
    for (const k of spec.keys.masked_keys!) expect(piiKey(k), k).toBe(true);
    for (const k of spec.keys.unmasked_keys!) expect(piiKey(k), k).toBe(false);
    for (const k of spec.keys.id_owners!) expect(idOwner(k), k).toBe(true);
    for (const k of spec.keys.not_id_owners!) expect(idOwner(k), k).toBe(false);
  });
  it("эталонные payload", () => {
    for (const c of spec.payloads) {
      const { envelope, paths } = remaskEnvelope({ payload: c.payload });
      expect(envelope.payload).toEqual(c.masked);
      expect(paths).toEqual(c.masked_fields.map((f) => `payload.${f}`));
    }
  });
});

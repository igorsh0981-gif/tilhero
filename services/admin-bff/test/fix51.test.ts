/**
 * Исправление 5.1 (docs/sprint5/FEEDBACK_5_1.md §E, §F):
 *  - поставщики поездок: last_error {code, reason, message, at, http_status}, поставщик cbu, проверка «сейчас»
 *    `POST /admin/v1/travel/providers/:name/probe` (dashboard.read, 429 PROBE_RATE_LIMITED {retry_after});
 *  - очередь проверки: фильтр EXPIRED, массовое отклонение, возврат в очередь (одиночный и массовый).
 * 401/403, happy path с actor, 404/409/422, идемпотентность, недоверенные ответы доменов.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROBE_TIMEOUT_MS, normalizeOfferSnapshot, normalizeProbe, normalizeTravelProviders, providerMessage, reasonOf } from "../src/routes/travel.js";
import { BULK_TIMEOUT_MS, normalizeBulkResult } from "../src/routes/review.js";
import {
  CONTENT_HASH,
  OFFER_ID,
  REVIEW_ID,
  REVIEW_ID_2,
  browser,
  closeRedis,
  domainError,
  fakeSprint4,
  fakeSprint5,
  json,
  loginAs,
  makeHarness,
  offerSnapshotRow,
  providerStatusRow,
  reviewDetailRow,
  reviewItemRow,
  type Harness,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  fakeSprint4(h.fake);
  fakeSprint5(h.fake);
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

type Sess = { id: string; csrf: string } | null | undefined;
const get = (url: string, s?: Sess) => h.app.inject({ method: "GET", url, headers: browser(s) });
const post = (url: string, s: Sess, payload?: unknown, extra: Record<string, string> = {}) =>
  h.app.inject({ method: "POST", url, headers: browser(s, extra), ...(payload !== undefined ? { payload: payload as object } : {}) });

// ------------------------------------------------------------------------------------------ поставщики

describe("GET /admin/v1/travel/providers — исправление 5.1", () => {
  const GW = "/internal/v1/providers";

  it("last_error нового gateway: reason, message (не у всех причин), http_status; cbu четвёртой строкой", async () => {
    h.fake.on("providerGateway", "GET", GW, () =>
      json(200, [
        providerStatusRow({
          last_error: { code: "PROVIDER_BAD_RESPONSE", reason: "success_false", message: "Route TAS-FRU\u0007 is not available", at: "2026-10-11T09:07:00Z", http_status: 200 },
          last_success_at: "2026-10-11T08:48:00Z",
        }),
        providerStatusRow({ provider: "liteapi", last_error: { code: "PROVIDER_UNAVAILABLE", reason: "timeout", message: "должно пропасть", at: "2026-10-11T09:00:00Z", http_status: null } }),
        providerStatusRow({ provider: "osm" }),
        providerStatusRow({ provider: "cbu", quota: { day_used: 3, day_limit: 500 }, last_success_at: "2026-10-11T09:10:00Z" }),
      ]),
    );
    const { s } = await loginAs(h, "read_only");
    const res = await get("/admin/v1/travel/providers", s);
    expect(res.statusCode).toBe(200);
    const [av, lite, , cbu] = res.json().items;
    expect(av.last_error).toEqual({ code: "PROVIDER_BAD_RESPONSE", reason: "success_false", message: "Route TAS-FRU is not available", at: "2026-10-11T09:07:00Z", http_status: 200 });
    expect(lite.last_error).toEqual({ code: "PROVIDER_UNAVAILABLE", reason: "timeout", message: null, at: "2026-10-11T09:00:00Z", http_status: null });
    expect(cbu).toMatchObject({ name: "cbu", configured: true, quota: { day_used: 3, day_limit: 500 }, last_error: null });
  });

  it("плоская форма (last_error_reason / _http_status) и форма «success_false: сообщение» в reason", () => {
    const flat = normalizeTravelProviders([
      providerStatusRow({ last_error_code: "PROVIDER_UNAVAILABLE", last_error_at: "2026-10-11T09:00:00Z", last_error_reason: "timeout", last_error_http_status: null }),
      providerStatusRow({ provider: "liteapi", last_error: { code: "PROVIDER_BAD_RESPONSE", reason: "success_false: Invalid departure date", at: "2026-10-11T09:00:00Z" } }),
    ]);
    expect(flat.items[0]!.last_error).toEqual({ code: "PROVIDER_UNAVAILABLE", reason: "timeout", message: null, at: "2026-10-11T09:00:00Z", http_status: null });
    expect(flat.items[1]!.last_error).toMatchObject({ reason: "success_false", message: "Invalid departure date" });
  });

  it("message показывается и для upstream_4xx и provider_error (LiteAPI), с той же проверкой на ключ; у timeout — нет", () => {
    expect(reasonOf({ reason: "upstream_400", message: "Invalid origin: TASX", http_status: 400 })).toEqual({ reason: "upstream_400", message: "Invalid origin: TASX", http_status: 400 });
    expect(reasonOf({ reason: "upstream_422", message: "checkin must be in the future" }).message).toBe("checkin must be in the future");
    expect(reasonOf({ reason: "provider_error", message: "No availability" }).message).toBe("No availability");
    expect(reasonOf({ reason: "upstream_401", message: "bad key 0123456789abcdef0123456789abcdef" }).message).toBeNull();
    expect(reasonOf({ reason: "timeout", message: "Gateway timeout" }).message).toBeNull();
    expect(reasonOf({ reason: "upstream_5xx", message: "Internal error" }).message).toBeNull();
  });

  it("недоверенная причина: не машинный код → null; http_status вне 100..599 → null; сообщение с ключом/маркером не показывается", () => {
    expect(reasonOf({ reason: "<b>x</b>", http_status: 9999 })).toEqual({ reason: null, message: null, http_status: null });
    expect(reasonOf({ reason: "UPSTREAM_400", http_status: "400" })).toEqual({ reason: null, message: null, http_status: null });
    expect(providerMessage("Unauthorized: token=abc")).toBeNull();
    expect(providerMessage("bad marker: 0123456789abcdef0123456789abcdef")).toBeNull();
    expect(providerMessage("слово ".repeat(80))!.length).toBe(200);
    expect(providerMessage("x".repeat(40))).toBeNull(); // длинная «слитная» строка похожа на ключ
    expect(providerMessage("  ‮evil‬  ")).toBe("evil");
    expect(providerMessage(42)).toBeNull();
  });
});

describe("POST /admin/v1/travel/providers/:name/probe", () => {
  const URL = (n: string) => `/admin/v1/travel/providers/${n}/probe`;
  const GW = (n: string) => `/internal/v1/travel/providers/${n}:probe`;

  it("happy: проксирует с actor (dashboard.read), без повторов; ok:true сбрасывает поля ошибки", async () => {
    const { staff, s } = await loginAs(h, "read_only");
    h.fake.on("providerGateway", "POST", GW("cbu"), () =>
      json(200, { ok: true, latency_ms: 120, code: "X", reason: "timeout", http_status: 200, checked_at: "2026-10-11T09:30:00Z", extra: "secret" }),
    );
    const res = await post(URL("cbu"), s);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "cbu", ok: true, latency_ms: 120, code: null, reason: null, message: null, http_status: 200, checked_at: "2026-10-11T09:30:00Z" });
    const calls = h.fake.callsTo("providerGateway", "POST", GW("cbu"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.actor?.id).toBe(staff.staff_id);
    expect(calls[0]!.actor?.permissions).toContain("dashboard.read");
  });

  it("ok:false — код, причина, сообщение поставщика (success_false), HTTP-статус", async () => {
    h.fake.on("providerGateway", "POST", GW("aviasales"), () =>
      json(200, { ok: false, latency_ms: 840, code: "PROVIDER_BAD_RESPONSE", reason: "success_false", message: "No prices for this route", http_status: 200, checked_at: "2026-10-11T09:31:00Z" }),
    );
    const { s } = await loginAs(h, "operations");
    const res = await post(URL("aviasales"), s);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "aviasales", ok: false, code: "PROVIDER_BAD_RESPONSE", reason: "success_false", message: "No prices for this route", http_status: 200 });
  });

  it("429 gateway → 429 PROBE_RATE_LIMITED {retry_after} + Retry-After; retry_after без числа → 30", async () => {
    h.fake.on("providerGateway", "POST", GW("liteapi"), () => domainError(429, "PROVIDER_RATE_LIMITED", { retry_after: 17 }));
    const { s } = await loginAs(h, "read_only");
    const res = await post(URL("liteapi"), s);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: "PROBE_RATE_LIMITED", details: { retry_after: 17 } });
    expect(res.headers["retry-after"]).toBe("17");
    h.fake.on("providerGateway", "POST", GW("liteapi"), () => domainError(429, "PROBE_RATE_LIMITED", { retry_after: "скоро" }));
    const again = await post(URL("liteapi"), s);
    expect(again.json().details.retry_after).toBe(30);
  });

  it("401 без сессии, 403 без dashboard.read, 422 неизвестный поставщик — gateway не вызывается", async () => {
    expect((await post(URL("aviasales"), null)).statusCode).toBe(401);
    const { s } = await loginAs(h, "read_only", { permissions: [] });
    const denied = await post(URL("aviasales"), s);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "dashboard.read" } });
    const { s: s2 } = await loginAs(h, "read_only");
    const bad = await post(URL("ticketmaster"), s2);
    expect(bad.statusCode).toBe(422);
    expect(h.fake.callsTo("providerGateway", "POST")).toHaveLength(0);
  });

  it("CSRF: POST без x-csrf-token → 403, gateway не вызывается", async () => {
    const { s } = await loginAs(h, "read_only");
    const res = await h.app.inject({ method: "POST", url: URL("osm"), headers: { ...browser(s), "x-csrf-token": "" } });
    expect(res.statusCode).toBe(403);
    expect(h.fake.callsTo("providerGateway", "POST")).toHaveLength(0);
  });

  it("старый gateway без маршрута (404) → 503 PROBE_UNAVAILABLE; мусорный ответ → 503 UPSTREAM_UNAVAILABLE; 5xx → 503", async () => {
    const { s } = await loginAs(h, "read_only");
    h.fake.on("providerGateway", "POST", GW("osm"), () => domainError(404, "NOT_FOUND"));
    let res = await post(URL("osm"), s);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "PROBE_UNAVAILABLE", details: { service: "provider-gateway" } });
    h.fake.on("providerGateway", "POST", GW("osm"), () => json(200, { ok: "yes", checked_at: "вчера" }));
    res = await post(URL("osm"), s);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "provider-gateway" } });
    h.fake.on("providerGateway", "POST", GW("osm"), () => domainError(500, "INTERNAL_ERROR"));
    res = await post(URL("osm"), s);
    expect(res.statusCode).toBe(503);
    expect(h.fake.callsTo("providerGateway", "POST", GW("osm"))).toHaveLength(3); // без повторов
  });

  it("медленный поставщик: таймаут проверки 25 с (а не UPSTREAM_TIMEOUT_MS), без повторов", async () => {
    const slow = await makeHarness({}, {}, (c) => {
      c.upstreamTimeoutMs = 200;
    });
    try {
      fakeSprint5(slow.fake);
      slow.fake.on("providerGateway", "POST", GW("liteapi"), async () => {
        await new Promise((r) => setTimeout(r, 600));
        return json(200, { ok: true, latency_ms: 590, code: null, reason: null, http_status: 200, checked_at: "2026-10-11T09:30:00Z" });
      });
      const { s } = await loginAs(slow, "read_only");
      const res = await slow.app.inject({ method: "POST", url: URL("liteapi"), headers: browser(s) });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(25_000);
    } finally {
      await slow.close();
    }
  });

  it("сбои проверки (5xx / таймауты) не открывают breaker для GET статуса поставщиков", async () => {
    const { s } = await loginAs(h, "read_only");
    h.fake.on("providerGateway", "POST", GW("osm"), () => domainError(500, "INTERNAL_ERROR"));
    for (let n = 0; n < 7; n++) expect((await post(URL("osm"), s)).statusCode).toBe(503);
    // свой breaker проверок открыт — gateway больше не дёргается проверками…
    expect(h.fake.callsTo("providerGateway", "POST", GW("osm")).length).toBeLessThan(7);
    // …а статус поставщиков читается как обычно
    const status = await get("/admin/v1/travel/providers", s);
    expect(status.statusCode).toBe(200);
  });

  it("normalizeProbe: недоверенные поля", () => {
    expect(normalizeProbe(null, "osm")).toBeNull();
    expect(normalizeProbe({ ok: false }, "osm")).toBeNull();
    expect(normalizeProbe({ ok: false, checked_at: "2026-10-11T09:00:00Z", latency_ms: -5, code: "bad code", reason: "Timeout!", http_status: 0 }, "osm")).toEqual({
      name: "osm",
      ok: false,
      latency_ms: null,
      code: null,
      reason: null,
      message: null,
      http_status: null,
      checked_at: "2026-10-11T09:00:00Z",
    });
  });
});

// ------------------------------------------------------------------------------------------ очередь проверки

describe("очередь проверки — EXPIRED, массовые решения, возврат", () => {
  const BULK_REJECT = "/admin/v1/review/bulk-reject";
  const BULK_REOPEN = "/admin/v1/review/bulk-reopen";
  const REOPEN = `/admin/v1/review/${REVIEW_ID}/reopen`;
  const KEY = { "idempotency-key": "bulk-0000-0001" };
  const rejectBody = (ids = [REVIEW_ID, REVIEW_ID_2]) => ({
    items: ids.map((review_id) => ({ review_id, expected_content_hash: CONTENT_HASH })),
    reason_code: "NOT_AN_EVENT",
    note: "реклама, не события",
  });

  it("GET ?status=EXPIRED проходит в events; expires_at / expired_at строк — как отдаёт events", async () => {
    h.fake.on("events", "GET", "/internal/v1/review", () =>
      json(200, {
        items: [reviewItemRow({ status: "EXPIRED", expires_at: null, expired_at: "2026-10-11T03:00:00Z" }), reviewItemRow({ review_id: REVIEW_ID_2 })],
        next_cursor: null,
      }),
    );
    const { s } = await loginAs(h, "operations");
    const res = await get("/admin/v1/review?status=EXPIRED", s);
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("events", "GET", "/internal/v1/review")[0]!.query.status).toBe("EXPIRED");
    const [a, b] = res.json().items;
    expect(a).toMatchObject({ status: "EXPIRED", expired_at: "2026-10-11T03:00:00Z", expires_at: null });
    expect(b).not.toHaveProperty("expired_at"); // старый events — поля нет, BFF его не выдумывает
  });

  it("карточка EXPIRED: decided_by = system не уходит в staff/lookup, имя null", async () => {
    h.fake.on("events", "GET", `/internal/v1/review/${REVIEW_ID}`, () =>
      json(200, reviewDetailRow({ status: "EXPIRED", decided_by: "system", decision_reason: "AUTO_EXPIRED", decided_at: "2026-10-11T03:00:00Z", expired_at: "2026-10-11T03:00:00Z" })),
    );
    const { s } = await loginAs(h, "operations");
    const res = await get(`/admin/v1/review/${REVIEW_ID}`, s);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "EXPIRED", decided_by: "system", decided_by_name: null, decision_reason: "AUTO_EXPIRED" });
    expect(h.fake.callsTo("adminIdentity", "GET", "/admin/v1/staff/lookup")).toHaveLength(0);
  });

  it("bulk-reject happy: actor, Idempotency-Key и тело пробрасываются; итог по строкам (SKIPPED с кодом)", async () => {
    h.fake.on("events", "POST", "/internal/v1/review:bulk-reject", () =>
      json(200, { results: [{ review_id: REVIEW_ID, status: "REJECTED" }, { review_id: REVIEW_ID_2, status: "SKIPPED", code: "REVIEW_CHANGED" }] }),
    );
    const { staff, s } = await loginAs(h, "operations");
    const res = await post(BULK_REJECT, s, rejectBody(), KEY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { review_id: REVIEW_ID, status: "REJECTED", code: null },
        { review_id: REVIEW_ID_2, status: "SKIPPED", code: "REVIEW_CHANGED" },
      ],
    });
    const call = h.fake.callsTo("events", "POST", "/internal/v1/review:bulk-reject")[0]!;
    expect(call.actor?.id).toBe(staff.staff_id);
    expect(call.actor?.permissions).toContain("events.review");
    expect(call.headers["idempotency-key"]).toBe(KEY["idempotency-key"]);
    expect(call.body).toEqual(rejectBody());
  });

  it("bulk-reject идемпотентность: повтор с тем же ключом уходит в events с тем же ключом (ответ домена — тот же)", async () => {
    const seen: string[] = [];
    h.fake.on("events", "POST", "/internal/v1/review:bulk-reject", (c) => {
      seen.push(c.headers["idempotency-key"]!);
      return json(200, { results: [{ review_id: REVIEW_ID, status: "REJECTED" }] });
    });
    const { s } = await loginAs(h, "operations");
    const a = await post(BULK_REJECT, s, rejectBody([REVIEW_ID]), KEY);
    const b = await post(BULK_REJECT, s, rejectBody([REVIEW_ID]), KEY);
    expect(a.json()).toEqual(b.json());
    expect(seen).toEqual([KEY["idempotency-key"], KEY["idempotency-key"]]);
  });

  it("bulk-reject 400 без Idempotency-Key, 422: пусто, >100, повтор review_id, без причины, короткий комментарий, неверный ключ", async () => {
    const { s } = await loginAs(h, "operations");
    expect((await post(BULK_REJECT, s, rejectBody())).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const many = Array.from({ length: 101 }, (_, n) => `8e7d6c5b-4a39-4281-9f0e-${String(n).padStart(12, "0")}`);
    const bad: unknown[] = [
      { ...rejectBody(), items: [] },
      rejectBody(many),
      rejectBody([REVIEW_ID, REVIEW_ID.toUpperCase()]),
      { ...rejectBody(), reason_code: "AUTO_EXPIRED" },
      { ...rejectBody(), note: "ok" },
      { ...rejectBody(), items: [{ review_id: REVIEW_ID }] },
    ];
    for (const body of bad) {
      const res = await post(BULK_REJECT, s, body, KEY);
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(422);
    }
    expect((await post(BULK_REJECT, s, rejectBody(), { "idempotency-key": "x" })).json().code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(h.fake.callsTo("events", "POST")).toHaveLength(0);
  });

  it("401 без сессии; 403 без events.review (bulk-reject, reopen, bulk-reopen) — events не вызывается", async () => {
    expect((await post(BULK_REJECT, null, rejectBody(), KEY)).statusCode).toBe(401);
    const { s } = await loginAs(h, "support");
    for (const [url, body] of [
      [BULK_REJECT, rejectBody()],
      [REOPEN, { expected_status: "EXPIRED", note: "вернуть" }],
      [BULK_REOPEN, { items: [{ review_id: REVIEW_ID }], note: "вернуть" }],
    ] as const) {
      const res = await post(url, s, body, KEY);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "events.review" } });
    }
    expect(h.fake.callsTo("events")).toHaveLength(0);
  });

  it("недоверенный ответ bulk: чужой review_id, неизвестный статус, не список → 503 UPSTREAM_UNAVAILABLE {service: events}", async () => {
    const { s } = await loginAs(h, "operations");
    for (const body of [
      { results: [{ review_id: "8e7d6c5b-4a39-4281-9f0e-000000000000", status: "REJECTED" }] },
      { results: [{ review_id: REVIEW_ID, status: "ACCEPTED" }] },
      { results: "ok" },
      [],
    ]) {
      h.fake.on("events", "POST", "/internal/v1/review:bulk-reject", () => json(200, body));
      const res = await post(BULK_REJECT, s, rejectBody([REVIEW_ID]), KEY);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "events" } });
    }
  });

  it("bulk: таймаут 30 с (медленная массовая команда проходит), без автоповторов при 5xx", async () => {
    expect(BULK_TIMEOUT_MS).toBe(30_000);
    const slow = await makeHarness({}, {}, (c) => {
      c.upstreamTimeoutMs = 200;
    });
    try {
      fakeSprint4(slow.fake);
      slow.fake.on("events", "POST", "/internal/v1/review:bulk-reject", async () => {
        await new Promise((r) => setTimeout(r, 600));
        return json(200, { results: [{ review_id: REVIEW_ID, status: "REJECTED", code: null }] });
      });
      const { s } = await loginAs(slow, "operations");
      const ok = await slow.app.inject({ method: "POST", url: BULK_REJECT, headers: browser(s, KEY), payload: rejectBody([REVIEW_ID]) });
      expect(ok.statusCode).toBe(200);
      slow.fake.on("events", "POST", "/internal/v1/review:bulk-reopen", () => domainError(500, "INTERNAL_ERROR"));
      const failed = await slow.app.inject({ method: "POST", url: BULK_REOPEN, headers: browser(s, KEY), payload: { items: [{ review_id: REVIEW_ID }], note: "вернуть" } });
      expect(failed.statusCode).toBe(503);
      // повтор с тем же ключом — только по действию сотрудника, BFF сам не повторяет
      expect(slow.fake.callsTo("events", "POST", "/internal/v1/review:bulk-reopen")).toHaveLength(1);
    } finally {
      await slow.close();
    }
  });

  it("bulk: в ответе нет строки для одного из запрошенных review_id → 503 (итог не выдумывается)", async () => {
    h.fake.on("events", "POST", "/internal/v1/review:bulk-reject", () => json(200, { results: [{ review_id: REVIEW_ID, status: "REJECTED" }] }));
    const { s } = await loginAs(h, "operations");
    const res = await post(BULK_REJECT, s, rejectBody(), KEY);
    expect(res.statusCode).toBe(503);
    expect(normalizeBulkResult({ results: [{ review_id: REVIEW_ID, status: "OPEN" }] }, [REVIEW_ID, REVIEW_ID_2], "OPEN")).toBeNull();
  });

  it("normalizeBulkResult: код SKIPPED не UPPER_SNAKE → SKIPPED; лишние поля отбрасываются; дубль строки → null", () => {
    expect(normalizeBulkResult({ results: [{ review_id: REVIEW_ID, status: "SKIPPED", code: "<b>", note: "x" }] }, [REVIEW_ID], "REJECTED")).toEqual({
      results: [{ review_id: REVIEW_ID, status: "SKIPPED", code: "SKIPPED" }],
    });
    const dup = { results: [{ review_id: REVIEW_ID, status: "OPEN" }, { review_id: REVIEW_ID, status: "OPEN" }] };
    expect(normalizeBulkResult(dup, [REVIEW_ID], "OPEN")).toBeNull();
    expect(normalizeBulkResult({ results: [{ review_id: REVIEW_ID, status: "REJECTED" }] }, [REVIEW_ID], "OPEN")).toBeNull();
  });

  it("reopen happy: {review} с именем; тело и Idempotency-Key пробрасываются", async () => {
    const { staff, s } = await loginAs(h, "operations");
    const res = await post(REOPEN, s, { expected_status: "EXPIRED", note: "событие ещё актуально" }, { "idempotency-key": "reopen-0000-01" });
    expect(res.statusCode).toBe(200);
    expect(res.json().review).toMatchObject({ review_id: REVIEW_ID, status: "OPEN", expires_at: "2026-10-18T08:00:00Z" });
    const call = h.fake.callsTo("events", "POST", `/internal/v1/review/${REVIEW_ID}:reopen`)[0]!;
    expect(call.actor?.id).toBe(staff.staff_id);
    expect(call.body).toEqual({ expected_status: "EXPIRED", note: "событие ещё актуально" });
    expect(call.headers["idempotency-key"]).toBe("reopen-0000-01");
  });

  it("reopen: 404 / 409 домена как есть; 422 expected_status не EXPIRED, короткий комментарий", async () => {
    const { s } = await loginAs(h, "operations");
    h.fake.on("events", "POST", `/internal/v1/review/${REVIEW_ID}:reopen`, () => domainError(409, "REVIEW_ALREADY_DECIDED", { status: "OPEN" }));
    let res = await post(REOPEN, s, { expected_status: "EXPIRED", note: "вернуть" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "REVIEW_ALREADY_DECIDED", details: { status: "OPEN" } });
    h.fake.on("events", "POST", `/internal/v1/review/${REVIEW_ID}:reopen`, () => domainError(404, "REVIEW_NOT_FOUND"));
    res = await post(REOPEN, s, { expected_status: "EXPIRED", note: "вернуть" });
    expect(res.statusCode).toBe(404);
    expect((await post(REOPEN, s, { expected_status: "OPEN", note: "вернуть" })).statusCode).toBe(422);
    expect((await post(REOPEN, s, { expected_status: "EXPIRED", note: "x" })).statusCode).toBe(422);
    expect((await post("/admin/v1/review/not-a-uuid/reopen", s, { expected_status: "EXPIRED", note: "вернуть" })).statusCode).toBe(422);
  });

  it("bulk-reopen happy: статус OPEN по строкам; без ключа 400; повтор id 422", async () => {
    const { s } = await loginAs(h, "operations");
    const body = { items: [{ review_id: REVIEW_ID }, { review_id: REVIEW_ID_2 }], note: "источник исправил даты" };
    const res = await post(BULK_REOPEN, s, body, KEY);
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual(["OPEN", "OPEN"]);
    expect(h.fake.callsTo("events", "POST", "/internal/v1/review:bulk-reopen")[0]!.body).toEqual(body);
    expect((await post(BULK_REOPEN, s, body)).statusCode).toBe(400);
    expect((await post(BULK_REOPEN, s, { items: [{ review_id: REVIEW_ID }, { review_id: REVIEW_ID }], note: "вернуть" }, KEY)).statusCode).toBe(422);
  });
});

describe("снимок предложения — пересчёт цены билета по курсу ЦБ (исправление 5.1)", () => {
  const fx = { price_per_person_usd: "309.00", rate: "0.011451", date: "2026-10-11", source: "cbu.uz" };
  const kgs = { status: "ok", price_per_person: "27000.00", currency: "KGS", in_total: true, provider: "aiweb.ticket-kg", deeplink: "https://ticket.kg/e/1", fetched_at: "2026-10-11T06:40:00Z" };

  it("ticket.fx и in_total проходят как есть; без курса (или с испорченным) не-USD цена в сумму не входит", () => {
    const ok = normalizeOfferSnapshot(offerSnapshotRow({}, { ticket: { ...kgs, fx } }), OFFER_ID)!;
    expect((ok.offer as { ticket: unknown }).ticket).toMatchObject({ currency: "KGS", in_total: true, fx });
    const noFx = normalizeOfferSnapshot(offerSnapshotRow({}, { ticket: { ...kgs, fx: null } }), OFFER_ID)!;
    expect((noFx.offer as { ticket: unknown }).ticket).toMatchObject({ in_total: false, fx: null });
    const bad = normalizeOfferSnapshot(offerSnapshotRow({}, { ticket: { ...kgs, fx: { ...fx, source: "evil.example", rate: "1e9" } } }), OFFER_ID)!;
    expect((bad.offer as { ticket: unknown }).ticket).toMatchObject({ in_total: false, fx: null });
    const usd = normalizeOfferSnapshot(offerSnapshotRow({}, { ticket: { ...kgs, currency: "USD", price_per_person: "85.00", fx } }), OFFER_ID)!;
    expect((usd.offer as { ticket: unknown }).ticket).toMatchObject({ in_total: true, fx: null });
  });

  it("GET /admin/v1/offers/:id отдаёт fx поддержке", async () => {
    h.fake.on("offers", "GET", `/internal/v1/offers/${OFFER_ID}`, () => json(200, offerSnapshotRow({}, { ticket: { ...kgs, fx } })));
    const { s } = await loginAs(h, "support");
    const res = await get(`/admin/v1/offers/${OFFER_ID}`, s);
    expect(res.statusCode).toBe(200);
    expect(res.json().offer.ticket).toMatchObject({ in_total: true, fx });
  });
});

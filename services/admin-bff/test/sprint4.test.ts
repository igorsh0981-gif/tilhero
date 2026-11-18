/**
 * Спринт 4 (docs/sprint4/INTERNAL_API.md §7): очередь проверки событий, источники AI-поиска, запуски поиска,
 * бюджет и kill switch AI. 401/403/step-up, CSRF, happy path через подделки доменов, проброс ошибок доменов,
 * валидация тела, условный step-up PATCH источника.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Permission } from "@tilhero/contracts/admin";
import { changesTrustFields, CRAWL_MAX_PAGES, MAX_SKIP_REASONS, normalizeCrawlStats } from "../src/routes/sources.js";
import { decisionBody } from "../src/routes/review.js";
import { PAUSE_TIMEOUT_MS } from "../src/routes/discovery.js";
import {
  REVIEW_ID,
  RUN_ID,
  SOURCE_ID,
  browser,
  budgetRow,
  closeRedis,
  crawlStatsRow,
  domainError,
  fakeSprint4,
  json,
  loginAs,
  makeHarness,
  reviewDetailRow,
  runRow,
  sourceRow,
  stepUp,
  type Harness,
  type Session,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  fakeSprint4(h.fake);
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

type Method = "GET" | "POST" | "PATCH" | "PUT";
interface R {
  method: Method;
  url: string;
  payload?: Record<string, unknown>;
  permission: Permission;
  stepUp?: boolean;
}

const NEW_SOURCE = {
  slug: "kassir-kz",
  name: "Kassir.kz",
  country_code: "KZ",
  tier: "OFFICIAL_TICKET_PROVIDER",
  event_domains: ["kassir.kz"],
  media_domains: ["*.cdn.kassir.kz"],
  listing_pages: [{ url: "https://kassir.kz/afisha?city=almaty", city: "Almaty", category: "music" }],
  enabled: true,
  js_only: null,
  notes: "афиша в HTML",
  reason: "исследование 10.10",
};

const ROUTES: R[] = [
  { method: "GET", url: "/admin/v1/review", permission: "events.review" },
  { method: "GET", url: `/admin/v1/review/${REVIEW_ID}`, permission: "events.review" },
  { method: "POST", url: `/admin/v1/review/${REVIEW_ID}/accept`, payload: { expected_status: "OPEN", expected_content_hash: "a".repeat(64), note: "ок, проверено" }, permission: "events.review" },
  {
    method: "POST",
    url: `/admin/v1/review/${REVIEW_ID}/reject`,
    payload: { expected_status: "OPEN", expected_content_hash: "a".repeat(64), reason_code: "DUPLICATE", note: "дубль" },
    permission: "events.review",
  },
  {
    method: "POST",
    url: `/admin/v1/review/${REVIEW_ID}/correct`,
    payload: { expected_status: "OPEN", expected_content_hash: "a".repeat(64), changes: { online: false }, basis_url: "https://iticket.uz/e/1", note: "исправлено" },
    permission: "events.review",
  },
  { method: "GET", url: "/admin/v1/sources", permission: "sources.manage" },
  { method: "GET", url: `/admin/v1/sources/${SOURCE_ID}`, permission: "sources.manage" },
  { method: "POST", url: "/admin/v1/sources", payload: NEW_SOURCE, permission: "sources.manage", stepUp: true },
  { method: "PATCH", url: `/admin/v1/sources/${SOURCE_ID}`, payload: { expected_version: 3, notes: "x", reason: "заметка" }, permission: "sources.manage" },
  { method: "GET", url: "/admin/v1/discovery/runs", permission: "discovery.manage" },
  { method: "GET", url: `/admin/v1/discovery/runs/${RUN_ID}`, permission: "discovery.manage" },
  { method: "POST", url: "/admin/v1/discovery/runs", payload: {}, permission: "discovery.manage" },
  { method: "GET", url: "/admin/v1/discovery/budget", permission: "discovery.manage" },
  { method: "PUT", url: "/admin/v1/discovery/pause", payload: { paused: true, reason: "перерасход" }, permission: "ops.kill_switch", stepUp: true },
];

const send = (r: Pick<R, "method" | "url" | "payload">, s: Pick<Session, "id" | "csrf"> | null, headers: Record<string, string> = {}) =>
  h.app.inject({ method: r.method, url: r.url, headers: browser(s, headers), ...(r.payload !== undefined ? { payload: r.payload } : {}) });

const SPRINT4_SERVICES = ["events", "sourceRegistry", "discovery", "providerGateway"] as const;
const sprint4Calls = () => h.fake.calls.filter((c) => (SPRINT4_SERVICES as readonly string[]).includes(c.service));

describe("доступ", () => {
  it("каждый маршрут без сессии → 401 UNAUTHORIZED, домены не вызываются", async () => {
    for (const r of ROUTES) {
      const res = await send(r, null);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      expect(res.json().code).toBe("UNAUTHORIZED");
    }
    expect(sprint4Calls()).toHaveLength(0);
  });

  it("каждый маршрут без права → 403 PERMISSION_DENIED {permission}; права спринта 4 не подменяют друг друга", async () => {
    const support = await loginAs(h, "support");
    for (const r of ROUTES) {
      const res = await send(r, support.s);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: r.permission } });
    }
    // у сотрудника только одно из прав спринта 4 — остальные разделы закрыты
    for (const own of ["events.review", "sources.manage", "discovery.manage"] as const) {
      const { s } = await loginAs(h, "analyst", { permissions: ["dashboard.read", own] });
      for (const r of ROUTES.filter((x) => x.permission !== own)) {
        const res = await send(r, s);
        expect(res.statusCode, `${own}: ${r.method} ${r.url}`).toBe(403);
        expect(res.json().code).toBe("PERMISSION_DENIED");
      }
    }
    expect(sprint4Calls()).toHaveLength(0);
  });

  it("POST sources и PUT pause без свежего step-up → 403 STEP_UP_REQUIRED {permission}, домен не вызывается", async () => {
    const { s } = await loginAs(h, "operations");
    for (const r of ROUTES.filter((x) => x.stepUp)) {
      const res = await send(r, s);
      expect(res.statusCode, r.url).toBe(403);
      expect(res.json()).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: r.permission } });
    }
    expect(sprint4Calls()).toHaveLength(0);
  });

  it("operations (матрица по умолчанию) — все маршруты; actor в домене с правами спринта 4", async () => {
    const { staff, s } = await loginAs(h, "operations");
    expect(s.me.permissions).toEqual(expect.arrayContaining(["events.review", "sources.manage", "discovery.manage"]));
    expect((await stepUp(h, s)).statusCode).toBe(200);
    for (const r of ROUTES) {
      const res = await send(r, s);
      expect(res.statusCode, `${r.method} ${r.url}: ${res.body.slice(0, 200)}`).toBeLessThan(300);
    }
    const calls = sprint4Calls();
    expect(calls.length).toBeGreaterThanOrEqual(ROUTES.length);
    for (const c of calls) {
      expect(c.actor?.id, `${c.service} ${c.path}`).toBe(staff.staff_id);
      expect(c.actor?.permissions).toEqual(expect.arrayContaining(["events.review", "sources.manage", "discovery.manage"]));
    }
  });

  it("CSRF: мутации без X-CSRF-Token или с чужим Origin → 403 CSRF_INVALID, домен не вызывается", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    const { "x-csrf-token": _drop, ...noToken } = browser(s);
    for (const r of ROUTES.filter((x) => x.method !== "GET")) {
      const a = await h.app.inject({ method: r.method, url: r.url, headers: noToken, payload: r.payload ?? {} });
      expect(a.statusCode, r.url).toBe(403);
      expect(a.json().code).toBe("CSRF_INVALID");
      const b = await send(r, s, { origin: "https://evil.example" });
      expect(b.json().code, r.url).toBe("CSRF_INVALID");
    }
    expect(sprint4Calls()).toHaveLength(0);
  });
});

describe("очередь проверки", () => {
  let s: Session;
  beforeEach(async () => {
    s = (await loginAs(h, "operations")).s;
  });

  it("список: фильтры передаются в events; ответ — ReviewItem (с content_hash) без служебных полей", async () => {
    h.fake.on("events", "GET", "/internal/v1/review", () =>
      json(200, { items: [{ ...reviewDetailRow(), content_hash: "b".repeat(64), candidate_id: "c1", dedup_keys: ["k:x"] }], next_cursor: "n1" }),
    );
    const res = await send({ method: "GET", url: "/admin/v1/review?status=OPEN&provider=aiweb.iticket-uz&country=UZ&limit=20&cursor=abc" }, s);
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("events", "GET", "/internal/v1/review")[0]!.query).toEqual({
      status: "OPEN",
      provider: "aiweb.iticket-uz",
      country: "UZ",
      limit: "20",
      cursor: "abc",
    });
    const item = res.json().items[0];
    expect(item.content_hash).toBe("b".repeat(64));
    expect(item).not.toHaveProperty("candidate_id");
    expect(item).not.toHaveProperty("dedup_keys");
    expect(item).not.toHaveProperty("facts"); // facts — только в карточке
    expect(res.json().next_cursor).toBe("n1");
    for (const bad of ["status=open", "country=uz", "provider=AI WEB", "limit=0", "extra=1"]) {
      expect((await send({ method: "GET", url: `/admin/v1/review?${bad}` }, s)).statusCode, bad).toBe(422);
    }
    expect((await send({ method: "GET", url: "/admin/v1/review/not-a-uuid" }, s)).statusCode).toBe(422);
  });

  it("accept: Idempotency-Key пробрасывается, ответ {review, event_id}; ReviewDetail без обёртки заворачивается", async () => {
    const me = await loginAs(h, "operations");
    s = me.s;
    const staffId = me.staff.staff_id;
    const staffName = me.staff.display_name;
    const r = ROUTES[2]!;
    const res = await send(r, s, { "idempotency-key": "rev-accept-0001" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ review: { review_id: REVIEW_ID, status: "ACCEPTED" }, event_id: "evt-9" });
    const call = h.fake.callsTo("events", "POST", `/internal/v1/review/${REVIEW_ID}:accept`)[0]!;
    expect(call.headers["idempotency-key"]).toBe("rev-accept-0001");
    expect(call.body).toEqual({ expected_status: "OPEN", expected_content_hash: "a".repeat(64), note: "ок, проверено" });
    expect(res.json().review).toMatchObject({ decided_by: staffId, decided_by_name: staffName });

    h.fake.on("events", "POST", `/internal/v1/review/${REVIEW_ID}:accept`, () => json(200, reviewDetailRow({ status: "ACCEPTED", event_id: "evt-77" })));
    const flat = await send(r, s);
    expect(flat.json()).toMatchObject({ review: { status: "ACCEPTED", event_id: "evt-77" }, event_id: "evt-77" });
    expect(h.fake.callsTo("events", "POST").at(-1)!.headers["idempotency-key"]).toBeUndefined();
    expect((await send(r, s, { "idempotency-key": "bad key!" })).json().code).toBe("IDEMPOTENCY_KEY_INVALID");
  });

  it("reject и correct: ответы по контракту, тела проходят в events как есть", async () => {
    const rej = await send(ROUTES[3]!, s);
    expect(rej.statusCode).toBe(200);
    expect(rej.json()).toEqual({ review: expect.objectContaining({ status: "REJECTED", decision_reason: "DUPLICATE" }) });
    const body = {
      expected_status: "OPEN",
      expected_content_hash: "a".repeat(64),
      changes: {
        title: "Концерт оркестра",
        start: { local_date: "2026-11-02", local_time: null },
        end: null,
        // длины — как у events: площадка 300, город 200, адрес 500
        venue: { name: "Д".repeat(300), city: "Г".repeat(200), address: "А".repeat(500) },
        price_range: { min: "100000.00", max: "250000.00", currency: "UZS" },
        online: false,
      },
      basis_url: "https://iticket.uz/events/concert-1",
      note: "дата перенесена",
    };
    const cor = await send({ method: "POST", url: `/admin/v1/review/${REVIEW_ID}/correct`, payload: body }, s);
    expect(cor.statusCode).toBe(200);
    expect(cor.json()).toMatchObject({ review: { status: "CORRECTED" }, event_id: "evt-10" });
    expect(h.fake.callsTo("events", "POST", `/internal/v1/review/${REVIEW_ID}:correct`)[0]!.body).toEqual(body);
  });

  it("валидация тела решений → 422 VALIDATION_ERROR, events не вызывается", async () => {
    const base = `/admin/v1/review/${REVIEW_ID}`;
    const bad: Array<[string, Record<string, unknown>]> = [
      ["accept", { expected_status: "ACCEPTED", note: "ок, да" }],
      ["accept", { expected_status: "OPEN", note: "ок" }],
      ["accept", { expected_status: "OPEN" }],
      ["accept", { expected_status: "OPEN", expected_content_hash: "a".repeat(64), note: "ок, да", event_id: "x" }],
      ["accept", { expected_status: "OPEN", note: "без хеша карточки" }],
      ["accept", { expected_status: "OPEN", expected_content_hash: "A".repeat(64), note: "хеш не hex" }],
      ["accept", { expected_status: "OPEN", expected_content_hash: "a".repeat(63), note: "короткий хеш" }],
      ["reject", { expected_status: "OPEN", reason_code: "SPAM", note: "спам" }],
      ["reject", { expected_status: "OPEN", note: "без кода" }],
      ["correct", { expected_status: "OPEN", changes: {}, basis_url: "https://iticket.uz/e", note: "пусто" }],
      ["correct", { expected_status: "OPEN", changes: { slug: "x" }, basis_url: "https://iticket.uz/e", note: "лишнее" }],
      ["correct", { expected_status: "OPEN", changes: { title: "T" }, basis_url: "http://iticket.uz/e", note: "http" }],
      ["correct", { expected_status: "OPEN", changes: { title: "T" }, basis_url: "javascript:alert(1)", note: "js" }],
      ["correct", { expected_status: "OPEN", changes: { start: { local_date: "2026-13-01", local_time: null } }, basis_url: "https://iticket.uz/e", note: "дата" }],
      ["correct", { expected_status: "OPEN", changes: { start: { local_date: "2026-11-01", local_time: "25:00" } }, basis_url: "https://iticket.uz/e", note: "время" }],
      ["correct", { expected_status: "OPEN", changes: { price_range: { min: 10, max: "20", currency: "UZS" } }, basis_url: "https://iticket.uz/e", note: "цена" }],
      ["correct", { expected_status: "OPEN", changes: { price_range: { min: "10", max: "20", currency: "sum" } }, basis_url: "https://iticket.uz/e", note: "валюта" }],
      ["correct", { expected_status: "OPEN", changes: { title: "T" }, note: "без основания" }],
      ["correct", { expected_status: "OPEN", changes: { venue: { name: "Д".repeat(301), city: "T", address: null } }, basis_url: "https://iticket.uz/e", note: "площадка" }],
      ["correct", { expected_status: "OPEN", changes: { venue: { name: "Д", city: "Г".repeat(201), address: null } }, basis_url: "https://iticket.uz/e", note: "город" }],
      ["correct", { expected_status: "OPEN", changes: { venue: { name: "Д", city: "Г", address: "А".repeat(501) } }, basis_url: "https://iticket.uz/e", note: "адрес" }],
      ["correct", { expected_status: "OPEN", changes: { price_range: { min: "10.5", max: "20.00", currency: "UZS" } }, basis_url: "https://iticket.uz/e", note: "копейки" }],
      ["correct", { expected_status: "OPEN", changes: { price_range: { min: "10.00", max: "250000", currency: "UZS" } }, basis_url: "https://iticket.uz/e", note: "без копеек" }],
    ];
    for (const [action, raw] of bad) {
      // хеш карточки — во всех телах, кроме проверок самого хеша: падать должно именно проверяемое поле
      const payload = "expected_content_hash" in raw || raw.note === "без хеша карточки" ? raw : { ...raw, expected_content_hash: "a".repeat(64) };
      const res = await send({ method: "POST", url: `${base}/${action}`, payload }, s);
      expect(res.statusCode, `${action} ${JSON.stringify(payload)}`).toBe(422);
      expect(res.json().code).toBe("VALIDATION_ERROR");
    }
    expect(h.fake.callsTo("events")).toHaveLength(0);
  });

  it("409 REVIEW_CHANGED: факты карточки обновились — код и актуальный content_hash домена как есть", async () => {
    h.fake.on("events", "POST", `/internal/v1/review/${REVIEW_ID}:reject`, () => domainError(409, "REVIEW_CHANGED", { content_hash: "c".repeat(64) }));
    const res = await send(ROUTES[3]!, s);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "REVIEW_CHANGED", details: { content_hash: "c".repeat(64) } });
    expect(h.fake.callsTo("events", "POST")[0]!.body.expected_content_hash).toBe("a".repeat(64));
  });

  it("карточка: decided_by_name из admin-identity lookup; lookup недоступен — null, карточка открывается", async () => {
    const op = h.fake.addStaff({ role: "operations", display_name: "Алия Каримова" });
    h.fake.on("events", "GET", `/internal/v1/review/${REVIEW_ID}`, () => json(200, reviewDetailRow({ status: "ACCEPTED", decided_by: op.staff_id })));
    const res = await send(ROUTES[1]!, s);
    expect(res.json()).toMatchObject({ decided_by: op.staff_id, decided_by_name: "Алия Каримова" });
    expect(h.fake.callsTo("adminIdentity", "GET", "/admin/v1/staff/lookup").at(-1)!.query.ids).toBe(op.staff_id);
    const fresh = await makeHarness();
    fakeSprint4(fresh.fake);
    try {
      fresh.fake.on("events", "GET", `/internal/v1/review/${REVIEW_ID}`, () => json(200, reviewDetailRow({ decided_by: op.staff_id })));
      fresh.fake.on("adminIdentity", "GET", "/admin/v1/staff/lookup", () => new Response("x", { status: 500 }));
      const other = (await loginAs(fresh, "operations")).s;
      const r2 = await fresh.app.inject({ method: "GET", url: `/admin/v1/review/${REVIEW_ID}`, headers: browser(other) });
      expect(r2.statusCode).toBe(200);
      expect(r2.json()).toMatchObject({ decided_by: op.staff_id, decided_by_name: null });
    } finally {
      await fresh.close();
    }
  });

  it("ошибки events проксируются в формате ErrorBody (код, статус, details)", async () => {
    h.fake.on("events", "POST", `/internal/v1/review/${REVIEW_ID}:accept`, () => domainError(409, "REVIEW_ALREADY_DECIDED", { status: "REJECTED" }));
    h.fake.on("events", "POST", `/internal/v1/review/${REVIEW_ID}:correct`, () => domainError(422, "REVIEW_BASIS_URL_NOT_ALLOWED"));
    h.fake.on("events", "GET", `/internal/v1/review/${REVIEW_ID}`, () => domainError(404, "REVIEW_NOT_FOUND"));
    const acc = await send(ROUTES[2]!, s);
    expect(acc.statusCode).toBe(409);
    expect(acc.json()).toMatchObject({ code: "REVIEW_ALREADY_DECIDED", message: "domain says REVIEW_ALREADY_DECIDED", details: { status: "REJECTED" } });
    expect(Object.keys(acc.json()).sort()).toEqual(["code", "details", "message", "trace_id"]);
    const cor = await send(ROUTES[4]!, s);
    expect([cor.statusCode, cor.json().code]).toEqual([422, "REVIEW_BASIS_URL_NOT_ALLOWED"]);
    const get = await send(ROUTES[1]!, s);
    expect([get.statusCode, get.json().code]).toEqual([404, "REVIEW_NOT_FOUND"]);
    h.fake.down.add("events");
    const down = await send(ROUTES[0]!, s);
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "events" } });
  });

  it("decisionBody: reject — только review; accept без event_id в обёртке — из review", () => {
    const d = reviewDetailRow({ event_id: "e1" });
    expect(decisionBody("reject", { review: d, event_id: "e1" })).toEqual({ review: d });
    expect(decisionBody("accept", { review: d })).toEqual({ review: d, event_id: "e1" });
    expect(decisionBody("correct", d)).toEqual({ review: d, event_id: "e1" });
  });
});

describe("источники", () => {
  let s: Session;
  beforeEach(async () => {
    s = (await loginAs(h, "operations")).s;
  });
  const patch = (payload: Record<string, unknown>) => send({ method: "PATCH", url: `/admin/v1/sources/${SOURCE_ID}`, payload }, s);
  const patchCalls = () => h.fake.callsTo("sourceRegistry", "PATCH");
  const getCalls = () => h.fake.callsTo("sourceRegistry", "GET", `/internal/v1/sources/${SOURCE_ID}`);

  it("список и карточка: фильтры, SourceDetail с журналом изменений", async () => {
    const list = await send({ method: "GET", url: "/admin/v1/sources?country=UZ&enabled=false&q=iticket&limit=5" }, s);
    expect(list.statusCode).toBe(200);
    expect(h.fake.callsTo("sourceRegistry", "GET", "/internal/v1/sources")[0]!.query).toEqual({ country: "UZ", enabled: "false", q: "iticket", limit: "5" });
    expect(list.json().items[0]).toEqual({ ...sourceRow(), updated_by_name: null });
    const card = await send({ method: "GET", url: `/admin/v1/sources/${SOURCE_ID.toUpperCase()}` }, s);
    expect(card.statusCode).toBe(200);
    expect(card.json().changes).toEqual([{ version: 3, actor_id: null, actor_name: null, changed_fields: ["enabled"], reason: "seed", at: "2026-10-10T00:00:00Z" }]);
    expect(getCalls()).toHaveLength(1); // id в пути домена — в нижнем регистре
    for (const bad of ["country=Uzbekistan", "enabled=1", "limit=500"]) {
      expect((await send({ method: "GET", url: `/admin/v1/sources?${bad}` }, s)).statusCode, bad).toBe(422);
    }
  });

  it("создание: step-up, 201, тело и Idempotency-Key — в source-registry", async () => {
    await stepUp(h, s);
    const res = await send({ method: "POST", url: "/admin/v1/sources", payload: NEW_SOURCE }, s, { "idempotency-key": "src-create-0001" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: "kassir-kz", version: 1, source_id: SOURCE_ID });
    const call = h.fake.callsTo("sourceRegistry", "POST", "/internal/v1/sources")[0]!;
    expect(call.body).toEqual(NEW_SOURCE);
    expect(call.headers["idempotency-key"]).toBe("src-create-0001");
  });

  it("валидация создания → 422, домен не вызывается", async () => {
    await stepUp(h, s);
    const { reason: _r, ...noReason } = NEW_SOURCE;
    const bad: Array<Record<string, unknown>> = [
      noReason,
      { ...NEW_SOURCE, reason: "ок" },
      { ...NEW_SOURCE, extra: true },
      { ...NEW_SOURCE, slug: "Kassir_KZ" },
      { ...NEW_SOURCE, country_code: "kz" },
      { ...NEW_SOURCE, tier: "RANDOM_BLOG" },
      { ...NEW_SOURCE, event_domains: [] },
      { ...NEW_SOURCE, event_domains: ["https://kassir.kz"] },
      { ...NEW_SOURCE, event_domains: ["kz"] },
      { ...NEW_SOURCE, event_domains: ["*.kassir.kz"] }, // wildcard — только у медиа
      { ...NEW_SOURCE, event_domains: ["Kassir.KZ"] },
      { ...NEW_SOURCE, event_domains: ["kassir.kz:443"] },
      { ...NEW_SOURCE, event_domains: ["kassir.kz", "kassir.kz"] },
      { ...NEW_SOURCE, event_domains: Array.from({ length: 11 }, (_, i) => `d${i}.kz`) },
      { ...NEW_SOURCE, media_domains: ["cdn.kassir.kz/path"] },
      { ...NEW_SOURCE, listing_pages: [{ url: "http://kassir.kz/afisha", city: null, category: null }] },
      { ...NEW_SOURCE, listing_pages: [{ url: "https://kassir.kz/afisha" }] },
      { ...NEW_SOURCE, listing_pages: [{ url: "https://user@kassir.kz/afisha", city: null, category: null }] },
      { ...NEW_SOURCE, listing_pages: [{ url: "https://kassir.kz/afisha", city: "Г".repeat(81), category: null }] }, // source-registry CITY_MAX = 80
      { ...NEW_SOURCE, notes: "x".repeat(1001) },
      { ...NEW_SOURCE, enabled: "true" },
    ];
    for (const payload of bad) {
      const res = await send({ method: "POST", url: "/admin/v1/sources", payload }, s);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 160)).toBe(422);
      expect(res.json().code).toBe("VALIDATION_ERROR");
    }
    expect(h.fake.callsTo("sourceRegistry")).toHaveLength(0);
  });

  it("имена сотрудников: updated_by_name и changes[].actor_name из admin-identity lookup", async () => {
    const a = h.fake.addStaff({ role: "operations", display_name: "Дилноза Юсупова" });
    h.fake.on("sourceRegistry", "GET", `/internal/v1/sources/${SOURCE_ID}`, () =>
      json(200, {
        ...sourceRow({ updated_by: a.staff_id }),
        changes: [
          { version: 4, actor_id: a.staff_id, changed_fields: ["notes"], reason: "заметка", at: "2026-10-10T01:00:00Z" },
          { version: 3, actor_id: null, changed_fields: ["enabled"], reason: "seed", at: "2026-10-10T00:00:00Z" },
        ],
      }),
    );
    h.fake.on("sourceRegistry", "GET", "/internal/v1/sources", () => json(200, { items: [sourceRow({ updated_by: a.staff_id }), sourceRow({ updated_by: null })], next_cursor: null }));
    const card = (await send({ method: "GET", url: `/admin/v1/sources/${SOURCE_ID}` }, s)).json();
    expect(card.updated_by_name).toBe("Дилноза Юсупова");
    expect(card.changes.map((c: { actor_name: string | null }) => c.actor_name)).toEqual(["Дилноза Юсупова", null]);
    const list = (await send({ method: "GET", url: "/admin/v1/sources" }, s)).json();
    expect(list.items.map((x: { updated_by_name: string | null }) => x.updated_by_name)).toEqual(["Дилноза Юсупова", null]);
  });

  it("PATCH без полей доверия — без step-up и без сверки", async () => {
    const res = await patch({ expected_version: 3, name: "iTicket", notes: null, listing_pages: [], reason: "переименование" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "iTicket", version: 4 });
    expect(getCalls()).toHaveLength(0);
    expect(patchCalls()[0]!.body).toEqual({ expected_version: 3, name: "iTicket", notes: null, listing_pages: [], reason: "переименование" });
  });

  it("PATCH с полями доверия без изменения значения (домены — как множества) — без step-up", async () => {
    const res = await patch({
      expected_version: 3,
      enabled: true,
      tier: "OFFICIAL_TICKET_PROVIDER",
      event_domains: ["ITICKET.uz"],
      media_domains: ["cdn.iticket.uz"],
      name: "iTicket",
      reason: "форма отправила все поля",
    });
    expect(res.statusCode, res.body).toBe(422); // верхний регистр в домене — 422 до сверки
    const ok = await patch({
      expected_version: 3,
      enabled: true,
      tier: "OFFICIAL_TICKET_PROVIDER",
      event_domains: ["iticket.uz"],
      media_domains: ["cdn.iticket.uz"],
      name: "iTicket",
      reason: "форма отправила все поля",
    });
    expect(ok.statusCode).toBe(200);
    expect(getCalls()).toHaveLength(1);
    expect(patchCalls()).toHaveLength(1);
  });

  it("PATCH меняет enabled / tier / event_domains / media_domains → 403 STEP_UP_REQUIRED; после step-up — проходит без сверки", async () => {
    const changes: Array<Record<string, unknown>> = [
      { enabled: false },
      { tier: "TRUSTED_MEDIA" },
      { event_domains: ["iticket.uz", "evil.example"] },
      { media_domains: [] },
      { media_domains: ["*.iticket.uz"] },
    ];
    for (const ch of changes) {
      const res = await patch({ expected_version: 3, ...ch, reason: "изменение доверия" });
      expect(res.statusCode, JSON.stringify(ch)).toBe(403);
      expect(res.json()).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: "sources.manage" } });
    }
    // версия не та, что сверялась: сравнивать не с чем — нужен step-up даже при «тех же» значениях
    const stale = await patch({ expected_version: 2, enabled: true, reason: "старая форма" });
    expect(stale.json().code).toBe("STEP_UP_REQUIRED");
    expect(patchCalls()).toHaveLength(0);

    await stepUp(h, s);
    const before = getCalls().length;
    const res = await patch({ expected_version: 3, enabled: false, reason: "сайт перестал публиковать афишу" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, version: 4 });
    expect(getCalls()).toHaveLength(before); // свежий step-up — сверка не нужна
  });

  it("PATCH: slug не меняется, нужна причина и expected_version → 422", async () => {
    await stepUp(h, s);
    for (const payload of [
      { expected_version: 3, slug: "new-slug", reason: "смена" },
      { expected_version: 3, name: "x" },
      { name: "x", reason: "без версии" },
      { expected_version: 0, name: "x", reason: "нулевая" },
      { expected_version: "3", name: "x", reason: "строка" },
      { expected_version: 3, reason: "ничего не меняет" },
    ]) {
      const res = await patch(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect(h.fake.callsTo("sourceRegistry")).toHaveLength(0);
  });

  it("ошибки source-registry проксируются: 409 конфликт версии, 409 slug, 422 URL, 404 при сверке; недоступен → 503", async () => {
    await stepUp(h, s);
    h.fake.on("sourceRegistry", "PATCH", `/internal/v1/sources/${SOURCE_ID}`, () => domainError(409, "SOURCE_VERSION_CONFLICT", { version: 5 }));
    const conflict = await patch({ expected_version: 3, name: "x", reason: "конфликт" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "SOURCE_VERSION_CONFLICT", details: { version: 5 } });

    h.fake.on("sourceRegistry", "POST", "/internal/v1/sources", () => domainError(409, "SOURCE_SLUG_TAKEN"));
    expect((await send({ method: "POST", url: "/admin/v1/sources", payload: NEW_SOURCE }, s)).json().code).toBe("SOURCE_SLUG_TAKEN");
    h.fake.on("sourceRegistry", "POST", "/internal/v1/sources", () => domainError(422, "SOURCE_LISTING_URL_NOT_ALLOWED", { index: 0 }));
    const url = await send({ method: "POST", url: "/admin/v1/sources", payload: NEW_SOURCE }, s);
    expect([url.statusCode, url.json().code, url.json().details]).toEqual([422, "SOURCE_LISTING_URL_NOT_ALLOWED", { index: 0 }]);

    // сверка без step-up: источника нет → 404 домена, а не STEP_UP_REQUIRED
    const fresh = (await loginAs(h, "operations")).s;
    h.fake.on("sourceRegistry", "GET", `/internal/v1/sources/${SOURCE_ID}`, () => domainError(404, "SOURCE_NOT_FOUND"));
    const nf = await send({ method: "PATCH", url: `/admin/v1/sources/${SOURCE_ID}`, payload: { expected_version: 3, enabled: false, reason: "нет" } }, fresh);
    expect([nf.statusCode, nf.json().code]).toEqual([404, "SOURCE_NOT_FOUND"]);

    h.fake.down.add("sourceRegistry");
    const down = await send({ method: "GET", url: "/admin/v1/sources" }, s);
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "source-registry" } });
  });

  it("changesTrustFields: домены — множества без учёта регистра; отсутствующие поля не считаются", () => {
    const cur = sourceRow() as never;
    expect(changesTrustFields({}, cur)).toBe(false);
    expect(changesTrustFields({ event_domains: ["ITICKET.UZ"] }, cur)).toBe(false);
    expect(changesTrustFields({ media_domains: [] }, cur)).toBe(true);
    expect(changesTrustFields({ enabled: true, tier: "OFFICIAL_TICKET_PROVIDER" }, cur)).toBe(false);
    expect(changesTrustFields({ tier: "TRUSTED_MEDIA" }, cur)).toBe(true);
  });
});

describe("последний обход источников (исправление 4.1)", () => {
  const URL_ = "/admin/v1/sources/crawl-stats";
  const AI_WEB_SOURCES = "/internal/v1/providers/ai_web/sources";
  const get = (s: Pick<Session, "id" | "csrf"> | null) => send({ method: "GET", url: URL_ }, s);
  const gwCalls = () => h.fake.callsTo("providerGateway", "GET", AI_WEB_SOURCES);

  it("без сессии → 401; без sources.manage и discovery.manage → 403 PERMISSION_DENIED; provider-gateway не вызывается", async () => {
    const anon = await get(null);
    expect([anon.statusCode, anon.json().code]).toEqual([401, "UNAUTHORIZED"]);
    for (const own of [["dashboard.read"], ["dashboard.read", "events.review"]] as Permission[][]) {
      const { s } = await loginAs(h, "analyst", { permissions: own });
      const res = await get(s);
      expect(res.statusCode, own.join()).toBe(403);
      expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "sources.manage|discovery.manage" } });
    }
    expect((await get((await loginAs(h, "support")).s)).statusCode).toBe(403);
    expect(gwCalls()).toHaveLength(0);
  });

  it("достаточно одного из прав: sources.manage или discovery.manage; actor — сотрудник, без step-up", async () => {
    for (const own of ["sources.manage", "discovery.manage"] as const) {
      const { staff, s } = await loginAs(h, "analyst", { permissions: ["dashboard.read", own] });
      const res = await get(s);
      expect(res.statusCode, own).toBe(200);
      const call = gwCalls().at(-1)!;
      expect(call.actor?.id).toBe(staff.staff_id);
      expect(call.actor?.permissions).toContain(own);
    }
    expect(gwCalls()).toHaveLength(2);
  });

  it("happy path: SourceCrawlStatsList из provider-gateway, служебные поля отбрасываются", async () => {
    const { s } = await loginAs(h, "operations");
    h.fake.on("providerGateway", "GET", AI_WEB_SOURCES, () => json(200, { items: [{ ...crawlStatsRow(), internal_key: "x" }], extra: 1 }));
    const res = await get(s);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [crawlStatsRow()] });
  });

  it("notes — признаки страниц отдельно от отброшенных; старый provider-gateway без notes → {}", async () => {
    const { s } = await loginAs(h, "operations");
    const { notes: _n, ...old } = crawlStatsRow();
    h.fake.on("providerGateway", "GET", AI_WEB_SOURCES, () =>
      json(200, { items: [crawlStatsRow({ notes: { deadline: 1, part_truncated: 2, part_saturated: 1 } }), { ...old, slug: "old-gw" }] }),
    );
    const res = await get(s);
    expect(res.statusCode).toBe(200);
    const [fresh, legacy] = res.json().items;
    expect(fresh.notes).toEqual({ deadline: 1, part_truncated: 2, part_saturated: 1 });
    expect(fresh.skipped).toEqual({ date_mismatch: 3, link_foreign: 1, category: 2 });
    expect(legacy.notes).toEqual({});
  });

  it("provider-gateway пагинирует: BFF дочитывает страницы (limit=200, cursor) и отдаёт один список; предел страниц", async () => {
    const { s } = await loginAs(h, "operations");
    h.fake.on("providerGateway", "GET", AI_WEB_SOURCES, (c) =>
      c.query.cursor === "b-src"
        ? json(200, { items: [crawlStatsRow({ slug: "c-src" })], next_cursor: null })
        : json(200, { items: [crawlStatsRow({ slug: "a-src" }), crawlStatsRow({ slug: "b-src", name: "B", enabled: true })], next_cursor: "b-src" }),
    );
    const res = await get(s);
    expect(res.json().items.map((x: { slug: string }) => x.slug)).toEqual(["a-src", "b-src", "c-src"]);
    expect(res.json().items[1]).not.toHaveProperty("name");
    expect(gwCalls().map((c) => c.query)).toEqual([{ limit: "200" }, { limit: "200", cursor: "b-src" }]);
    // курсор не кончается — не больше CRAWL_MAX_PAGES вызовов
    let n = 0;
    h.fake.on("providerGateway", "GET", AI_WEB_SOURCES, () => json(200, { items: [crawlStatsRow({ slug: `s-${n}` })], next_cursor: `p-${++n}` }));
    const before = gwCalls().length;
    expect((await get(s)).json().items).toHaveLength(CRAWL_MAX_PAGES);
    expect(gwCalls().length - before).toBe(CRAWL_MAX_PAGES);
  });

  it("источник ещё не обходился: last_crawl_at/outcome/code — null, счётчики 0", async () => {
    const { s } = await loginAs(h, "operations");
    const never = { slug: "opera-am", last_crawl_at: null, outcome: null, code: null, pages: 0, events_found: 0, skipped: {}, notes: {}, llm_calls: 0, cost_usd_last: "0.0000", cost_usd_day: "0.0000" };
    h.fake.on("providerGateway", "GET", AI_WEB_SOURCES, () => json(200, { items: [never] }));
    expect((await get(s)).json()).toEqual({ items: [never] });
  });

  it("ошибки provider-gateway: 404 (старая версия без эндпоинта) и 403 права — как есть; отказ внутренней авторизации и недоступность → 503", async () => {
    const { s } = await loginAs(h, "operations");
    h.fake.on("providerGateway", "GET", AI_WEB_SOURCES, () => domainError(404, "NOT_FOUND"));
    const nf = await get(s);
    expect([nf.statusCode, nf.json().code]).toEqual([404, "NOT_FOUND"]);
    h.fake.on("providerGateway", "GET", AI_WEB_SOURCES, () => domainError(403, "PERMISSION_DENIED", { permission: "sources.manage" }));
    const denied = await get(s);
    expect([denied.statusCode, denied.json().code]).toEqual([403, "PERMISSION_DENIED"]);
    // admin-bff не в списке вызывающих provider-gateway — ошибка конфигурации, не «сессия истекла»
    h.fake.on("providerGateway", "GET", AI_WEB_SOURCES, () => domainError(403, "ACTOR_NOT_ALLOWED"));
    expect((await get(s)).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "provider-gateway" } });
    h.fake.down.add("providerGateway");
    const down = await get(s);
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "provider-gateway" } });
  });

  it("без PROVIDER_GATEWAY_URL → 503 FEATURE_UNAVAILABLE, список источников работает", async () => {
    const bare = await makeHarness({}, {}, (c) => {
      c.urls.providerGateway = null;
      c.unconfigured = ["PROVIDER_GATEWAY_URL"];
    });
    fakeSprint4(bare.fake);
    try {
      const op = await loginAs(bare, "operations");
      const res = await bare.app.inject({ method: "GET", url: URL_, headers: browser(op.s) });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "FEATURE_UNAVAILABLE", message: "Раздел ещё не настроен" });
      expect(bare.fake.callsTo("providerGateway")).toHaveLength(0);
      expect((await bare.app.inject({ method: "GET", url: "/admin/v1/sources", headers: browser(op.s) })).statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });

  it("путь не путается с карточкой /sources/:id; лишние параметры запроса не мешают", async () => {
    const { s } = await loginAs(h, "operations");
    expect((await send({ method: "GET", url: `${URL_}?x=1` }, s)).statusCode).toBe(200);
    expect(h.fake.callsTo("sourceRegistry")).toHaveLength(0);
  });

  it("normalizeCrawlStats: недоверенный ответ домена приводится к контракту", () => {
    expect(normalizeCrawlStats(null)).toEqual({ items: [] });
    expect(normalizeCrawlStats({ items: "x" })).toEqual({ items: [] });
    const many = Object.fromEntries(Array.from({ length: MAX_SKIP_REASONS + 10 }, (_, i) => [`r${i}`, 1]));
    const out = normalizeCrawlStats({
      items: [
        crawlStatsRow({ pages: -1, events_found: 1.5, llm_calls: "3", outcome: "weird", code: "<b>x</b>", last_crawl_at: "вчера", cost_usd_last: 0.0231, cost_usd_day: "1e3" }),
        crawlStatsRow({ cost_usd_last: "12.5" }), // дубль slug — первая строка
        crawlStatsRow({ slug: "../etc", skipped: {} }),
        crawlStatsRow({ slug: "kassir-kz", skipped: { "<img src=x>": 2, date_mismatch: 0, link_foreign: -1, title_not_on_page: 2, SOURCE_NO_CONTENT: 1, arr: [1] } }),
        crawlStatsRow({ slug: "many-reasons", skipped: many }),
        crawlStatsRow({ slug: "arr-skipped", skipped: [1, 2] }),
        "строка",
      ],
    });
    expect(out.items.map((x) => x.slug)).toEqual(["iticket-uz", "kassir-kz", "many-reasons", "arr-skipped"]);
    expect(out.items[0]).toMatchObject({ pages: 0, events_found: 0, llm_calls: 0, outcome: null, code: null, last_crawl_at: null, cost_usd_last: "0.0231", cost_usd_day: "0.0000" });
    expect(out.items[1]!.skipped).toEqual({ title_not_on_page: 2, SOURCE_NO_CONTENT: 1 });
    expect(Object.keys(out.items[2]!.skipped)).toHaveLength(MAX_SKIP_REASONS);
    expect(out.items[3]!.skipped).toEqual({});
    // notes санитизируются так же, как skipped
    const notes = normalizeCrawlStats({
      items: [
        crawlStatsRow({ slug: "a-src", notes: { "<script>": 1, deadline: 0, part_truncated: -2, part_saturated: 1.5, unknown_note: "1", "x y": 3, part_saturated2: 4, deadline2: [1] } }),
        crawlStatsRow({ slug: "b-src", notes: many }),
        crawlStatsRow({ slug: "c-src", notes: [1] }),
        crawlStatsRow({ slug: "d-src", notes: "deadline" }),
        crawlStatsRow({ slug: "e-src", notes: null }),
      ],
    }).items;
    expect(notes[0]!.notes).toEqual({ part_saturated2: 4 });
    expect(Object.keys(notes[1]!.notes)).toHaveLength(MAX_SKIP_REASONS);
    for (const x of notes.slice(2)) expect(x.notes).toEqual({});
    for (const outcome of ["ok", "skipped", "error"]) expect(normalizeCrawlStats({ items: [crawlStatsRow({ outcome })] }).items[0]!.outcome).toBe(outcome);
  });
});

describe("разделы без адреса домена (код выкатился раньше переменных)", () => {
  it("маршруты раздела → 503 FEATURE_UNAVAILABLE «Раздел ещё не настроен», остальная админка работает; WARNING при старте", async () => {
    const bare = await makeHarness({}, {}, (c) => {
      c.urls.events = null;
      c.urls.providerGateway = null;
      c.unconfigured = ["EVENTS_URL", "PROVIDER_GATEWAY_URL"];
    });
    fakeSprint4(bare.fake);
    try {
      expect(bare.logs.text).toMatch(/sprint 4-7 domain urls are not configured/);
      expect(bare.logs.text).toContain("EVENTS_URL");
      const op = await loginAs(bare, "operations");
      await stepUp(bare, op.s);
      const off = [
        { method: "GET", url: "/admin/v1/review" },
        { method: "GET", url: `/admin/v1/review/${REVIEW_ID}` },
        { method: "POST", url: `/admin/v1/review/${REVIEW_ID}/accept`, payload: { expected_status: "OPEN", expected_content_hash: "a".repeat(64), note: "ок, проверено" } },
        { method: "GET", url: "/admin/v1/discovery/budget" },
        { method: "PUT", url: "/admin/v1/discovery/pause", payload: { paused: true, reason: "стоп" } },
      ] as const;
      for (const r of off) {
        const res = await bare.app.inject({ method: r.method, url: r.url, headers: browser(op.s), ...("payload" in r ? { payload: r.payload } : {}) });
        expect(res.statusCode, r.url).toBe(503);
        expect(res.json(), r.url).toMatchObject({ code: "FEATURE_UNAVAILABLE", message: "Раздел ещё не настроен" });
      }
      expect(bare.fake.callsTo("events")).toHaveLength(0);
      expect(bare.fake.callsTo("providerGateway")).toHaveLength(0);
      // настроенные разделы спринта 4 и остальная админка работают
      for (const url of ["/admin/v1/sources", "/admin/v1/discovery/runs", "/admin/v1/me"]) {
        const res = await bare.app.inject({ method: "GET", url, headers: browser(op.s) });
        expect(res.statusCode, url).toBe(200);
      }
    } finally {
      await bare.close();
    }
  });
});

describe("поиск событий", () => {
  let s: Session;
  beforeEach(async () => {
    s = (await loginAs(h, "operations")).s;
  });
  const run = (payload: Record<string, unknown> | undefined, headers: Record<string, string> = {}) =>
    send({ method: "POST", url: "/admin/v1/discovery/runs", ...(payload !== undefined ? { payload } : {}) }, s, headers);

  it("ручной запуск: trigger=manual, бюджет из тела или 200; 202 и 200 домена сохраняются; Idempotency-Key", async () => {
    const a = await run({ max_provider_calls: 37 }, { "idempotency-key": "run-manual-0001" });
    expect(a.statusCode).toBe(202);
    expect(a.json()).toMatchObject({ run_id: RUN_ID, trigger: "manual", ai: { cost_usd: "0.0000" } });
    const first = h.fake.callsTo("discovery", "POST", "/internal/v1/runs")[0]!;
    expect(first.body).toEqual({ trigger: "manual", max_provider_calls: 37 });
    expect(first.headers["idempotency-key"]).toBe("run-manual-0001");
    h.fake.on("discovery", "POST", "/internal/v1/runs", () => json(200, runRow({ status: "COMPLETED" })));
    const b = await run(undefined);
    expect(b.statusCode).toBe(200);
    expect(h.fake.callsTo("discovery", "POST", "/internal/v1/runs")[1]!.body).toEqual({ trigger: "manual", max_provider_calls: 200 });
  });

  it("валидация бюджета и тела → 422, discovery не вызывается", async () => {
    for (const payload of [{ max_provider_calls: 201 }, { max_provider_calls: 0 }, { max_provider_calls: "5" }, { max_provider_calls: 2.5 }, { trigger: "scheduler" }]) {
      const res = await run(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      expect(res.json().code).toBe("VALIDATION_ERROR");
    }
    expect(h.fake.callsTo("discovery")).toHaveLength(0);
  });

  it("запуск уже идёт → 409 DISCOVERY_RUN_IN_PROGRESS {run_id} как есть; список и карточка", async () => {
    h.fake.on("discovery", "POST", "/internal/v1/runs", () => domainError(409, "DISCOVERY_RUN_IN_PROGRESS", { run_id: RUN_ID }));
    const res = await run({});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "DISCOVERY_RUN_IN_PROGRESS", details: { run_id: RUN_ID } });
    const list = await send({ method: "GET", url: "/admin/v1/discovery/runs?status=COMPLETED&limit=10" }, s);
    expect(list.statusCode).toBe(200);
    expect(h.fake.callsTo("discovery", "GET", "/internal/v1/runs")[0]!.query).toEqual({ status: "COMPLETED", limit: "10" });
    expect((await send({ method: "GET", url: `/admin/v1/discovery/runs/${RUN_ID}` }, s)).json().run_id).toBe(RUN_ID);
    expect((await send({ method: "GET", url: "/admin/v1/discovery/runs?status=DONE" }, s)).statusCode).toBe(422);
  });

  it("бюджет дня — AiBudget из provider-gateway", async () => {
    const res = await send({ method: "GET", url: "/admin/v1/discovery/budget" }, s);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(budgetRow());
  });

  it("спринт 6: бюджет AI новостей (news) — как есть; null и отсутствие поля (старый gateway) допустимы", async () => {
    const news = { spent_usd: "0.0312", budget_usd: "0.20" };
    h.fake.on("providerGateway", "GET", "/internal/v1/providers/ai_web/budget", () => json(200, { ...budgetRow(), news }));
    const res = await send({ method: "GET", url: "/admin/v1/discovery/budget" }, s);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...budgetRow(), news });
    h.fake.on("providerGateway", "GET", "/internal/v1/providers/ai_web/budget", () => json(200, { ...budgetRow(), news: null }));
    expect((await send({ method: "GET", url: "/admin/v1/discovery/budget" }, s)).json().news).toBeNull();
    h.fake.on("providerGateway", "GET", "/internal/v1/providers/ai_web/budget", () => json(200, { ...budgetRow(), news: { ...news, secret: "x" } }));
    expect((await send({ method: "GET", url: "/admin/v1/discovery/budget" }, s)).json().news).toEqual(news); // лишнее не уходит
    // испорченное поле (не десятичная строка) → null; без поля (старый gateway) — поля нет
    h.fake.on("providerGateway", "GET", "/internal/v1/providers/ai_web/budget", () => json(200, { ...budgetRow(), news: { spent_usd: 1, budget_usd: "0.20" } }));
    expect((await send({ method: "GET", url: "/admin/v1/discovery/budget" }, s)).json().news).toBeNull();
    h.fake.on("providerGateway", "GET", "/internal/v1/providers/ai_web/budget", () => json(200, budgetRow()));
    expect("news" in (await send({ method: "GET", url: "/admin/v1/discovery/budget" }, s)).json()).toBe(false);
  });

  it("kill switch: step-up, тело в provider-gateway, ответ AiBudget; ответ-состояние → бюджет дочитывается", async () => {
    const r = { method: "PUT" as const, url: "/admin/v1/discovery/pause", payload: { paused: true, reason: "перерасход бюджета" } };
    expect((await send(r, s)).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    const on = await send(r, s);
    expect(on.statusCode).toBe(200);
    expect(on.json().paused).toMatchObject({ paused: true, reason: "перерасход бюджета" });
    expect(h.fake.callsTo("providerGateway", "PUT")[0]!.body).toEqual({ paused: true, reason: "перерасход бюджета" });

    h.fake.on("providerGateway", "PUT", "/internal/v1/providers/ai_web/pause", () => json(200, { paused: false, reason: "ok", by: "x", at: "2026-10-10T10:00:00Z" }));
    const off = await send({ ...r, payload: { paused: false, reason: "бюджет пополнен" } }, s);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual(budgetRow());
    expect(h.fake.callsTo("providerGateway", "GET", "/internal/v1/providers/ai_web/budget")).toHaveLength(1);

    for (const payload of [{ paused: true }, { paused: true, reason: "x" }, { paused: "yes", reason: "причина" }, { paused: true, reason: "r".repeat(301) }]) {
      expect((await send({ ...r, payload }, s)).statusCode, JSON.stringify(payload).slice(0, 80)).toBe(422);
    }
  });

  it("kill switch: discovery.manage без ops.kill_switch → 403; audit недоступен у provider-gateway → 503 AUDIT_UNAVAILABLE", async () => {
    const dm = await loginAs(h, "analyst", { permissions: ["dashboard.read", "discovery.manage"] });
    await stepUp(h, dm.s);
    const res = await send({ method: "PUT", url: "/admin/v1/discovery/pause", payload: { paused: true, reason: "стоп" } }, dm.s);
    expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "ops.kill_switch" } });

    await stepUp(h, s);
    const pause = () => send({ method: "PUT", url: "/admin/v1/discovery/pause", payload: { paused: true, reason: "стоп" } }, s);
    // provider-gateway сейчас: 503 UPSTREAM_UNAVAILABLE {service: "audit"}; на будущее — собственный код AUDIT_UNAVAILABLE
    for (const reply of [() => domainError(503, "UPSTREAM_UNAVAILABLE", { service: "audit" }), () => domainError(503, "AUDIT_UNAVAILABLE")]) {
      h.fake.on("providerGateway", "PUT", "/internal/v1/providers/ai_web/pause", reply);
      const down = await pause();
      expect(down.statusCode).toBe(503);
      expect(down.json()).toMatchObject({ code: "AUDIT_UNAVAILABLE", details: { service: "audit" } });
      expect(down.json().message).toMatch(/аудит/i);
    }
    // прочий 503 домена — обычный UPSTREAM_UNAVAILABLE
    h.fake.on("providerGateway", "PUT", "/internal/v1/providers/ai_web/pause", () => domainError(503, "UPSTREAM_UNAVAILABLE", { service: "source-registry" }));
    expect((await pause()).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "provider-gateway" } });
    h.fake.down.add("providerGateway");
    expect((await pause()).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "provider-gateway" } });
  });

  it("kill switch: свой таймаут 15 с (аудит provider-gateway синхронный) — дольше общего UPSTREAM_TIMEOUT_MS", async () => {
    expect(PAUSE_TIMEOUT_MS).toBe(15_000);
    const slow = await makeHarness({ UPSTREAM_TIMEOUT_MS: "150" });
    fakeSprint4(slow.fake);
    try {
      const delayed = (ms: number, res: () => Response) => async () => {
        await new Promise((r) => setTimeout(r, ms));
        return res();
      };
      slow.fake.on("providerGateway", "PUT", "/internal/v1/providers/ai_web/pause", delayed(400, () => json(200, budgetRow({ paused: { paused: true, reason: "стоп", by: "x", at: "2026-10-10T10:00:00Z" } }))));
      slow.fake.on("providerGateway", "GET", "/internal/v1/providers/ai_web/budget", delayed(400, () => json(200, budgetRow())));
      const op = await loginAs(slow, "operations");
      await stepUp(slow, op.s);
      const put = await slow.app.inject({ method: "PUT", url: "/admin/v1/discovery/pause", headers: browser(op.s), payload: { paused: true, reason: "стоп" } });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json().paused).toMatchObject({ paused: true, by: "x", by_name: null });
      // обычный вызов с тем же откликом домена упирается в общий таймаут
      const get = await slow.app.inject({ method: "GET", url: "/admin/v1/discovery/budget", headers: browser(op.s) });
      expect(get.json().code).toBe("UPSTREAM_UNAVAILABLE");
    } finally {
      await slow.close();
    }
  });

  it("kill switch: вызов pause без повторов даже при UPSTREAM_RETRIES > 0 (иначе двойной аудит и ~30 с ожидания)", async () => {
    const retrying = await makeHarness({ UPSTREAM_RETRIES: "2" });
    fakeSprint4(retrying.fake);
    try {
      const op = await loginAs(retrying, "operations");
      await stepUp(retrying, op.s);
      const pause = () =>
        retrying.app.inject({ method: "PUT", url: "/admin/v1/discovery/pause", headers: browser(op.s), payload: { paused: true, reason: "стоп" } });
      const puts = () => retrying.fake.callsTo("providerGateway", "PUT", "/internal/v1/providers/ai_web/pause").length;
      // 5xx домена (не аудит) — один вызов
      retrying.fake.on("providerGateway", "PUT", "/internal/v1/providers/ai_web/pause", () => domainError(503, "UPSTREAM_UNAVAILABLE", { service: "source-registry" }));
      expect((await pause()).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
      expect(puts()).toBe(1);
      // обрыв/таймаут соединения (fetch отклонён) — тоже один вызов
      let attempts = 0;
      retrying.fake.on("providerGateway", "PUT", "/internal/v1/providers/ai_web/pause", () => {
        attempts += 1;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      });
      expect((await pause()).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
      expect(attempts).toBe(1);
      // обычные GET того же клиента повторяются по UPSTREAM_RETRIES — настройка действует
      retrying.fake.on("providerGateway", "GET", "/internal/v1/providers/ai_web/budget", () => domainError(503, "UPSTREAM_UNAVAILABLE"));
      await retrying.app.inject({ method: "GET", url: "/admin/v1/discovery/budget", headers: browser(op.s) });
      expect(retrying.fake.callsTo("providerGateway", "GET", "/internal/v1/providers/ai_web/budget")).toHaveLength(3);
    } finally {
      await retrying.close();
    }
  });

  it("«Остановил»: paused.by_name — имя сотрудника из admin-identity lookup", async () => {
    const op = h.fake.addStaff({ role: "operations", display_name: "Тимур Ахмедов" });
    h.fake.on("providerGateway", "GET", "/internal/v1/providers/ai_web/budget", () =>
      json(200, budgetRow({ paused: { paused: true, reason: "перерасход", by: op.staff_id, at: "2026-10-10T10:00:00Z" } })),
    );
    const res = await send({ method: "GET", url: "/admin/v1/discovery/budget" }, s);
    expect(res.json().paused).toEqual({ paused: true, reason: "перерасход", by: op.staff_id, by_name: "Тимур Ахмедов", at: "2026-10-10T10:00:00Z" });
  });
});

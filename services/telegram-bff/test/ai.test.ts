/**
 * Спринт 7 (INTERNAL_API §5): /v1/ai/* — переписки, ход (SSE-прокси, запасной JSON), квота, лимит, ошибки до стрима,
 * испорченный поток upstream, отсутствие буферизации, отмена upstream при закрытии клиента, таймаут.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { SseParser, sseEventOf } from "../src/ai.js";
import { AiConversationSchema, AiQuotaSchema, AiTurnResultSchema } from "../src/schemas.js";
import { OFFER_BRIEF, QUOTA, conversationFixture, frame, happyEvents, installAiFake, type AiFakeState } from "./aiFake.js";
import { SPRINT7_ENV, bearer, catalogEvent, closeRedis, domainError, json, login, makeHarness, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
let ai: AiFakeState;

async function setup(env: Record<string, string> = {}) {
  h = await makeHarness({ ...SPRINT7_ENV, ...env });
  s = await login(h);
  ai = installAiFake(h.fake);
}
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const auth = (token = s.access) => bearer(token);
const get = (url: string, token = s.access) => h.app.inject({ url, headers: auth(token) });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}, token = s.access) =>
  h.app.inject({ method: "POST", url, headers: { ...auth(token), ...headers }, payload: payload as object });
const idem = () => ({ "idempotency-key": randomUUID() });

async function setPrefs(patch: Record<string, unknown>) {
  const cur = (await get("/v1/profile")).json().preferences;
  h.fake.prefs.set(s.userId, { ...cur, ...patch });
}

async function conversation(token = s.access): Promise<string> {
  const ev = catalogEvent();
  h.fake.catalog.push(ev);
  const r = await post("/v1/ai/conversations", { mode: "event", event_id: ev.event_id, trip_params: { travellers: 2, selected_tier: "comfort" } }, idem(), token);
  expect(r.statusCode).toBe(201);
  return r.json().conversation_id;
}

interface Ev {
  id: string | null;
  event: string;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
/** Разбор ответа SSE в тестах (как Mini App). */
function parseSse(text: string): { events: Ev[]; pings: number } {
  const events: Ev[] = [];
  let pings = 0;
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    if (block.startsWith(":")) {
      pings += 1;
      continue;
    }
    const lines = block.split("\n");
    const field = (n: string) => lines.find((l) => l.startsWith(`${n}: `))?.slice(n.length + 2) ?? null;
    events.push({ id: field("id"), event: field("event")!, data: JSON.parse(field("data")!) });
  }
  return { events, pings };
}

const turnCalls = () => h.fake.callsTo("aiConcierge").filter((c) => c.path.endsWith("/turns"));

// ====================================================================================== доступность

describe("AI concierge not configured → 503 FEATURE_UNAVAILABLE", () => {
  it("every /v1/ai/* endpoint", async () => {
    await setup({ AI_CONCIERGE_URL: "" });
    const id = randomUUID();
    const res = [
      await get("/v1/ai/quota"),
      await post("/v1/ai/conversations", { mode: "home" }, idem()),
      await get(`/v1/ai/conversations/${id}`),
      await h.app.inject({ method: "DELETE", url: `/v1/ai/conversations/${id}`, headers: auth() }),
      await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "Привет" }),
      await post(`/v1/ai/conversations/${id}/actions/set_direct_only`, { client_msg_id: randomUUID(), args: { direct_only: true } }),
    ];
    for (const r of res) expect([r.statusCode, r.json().code, r.json().details]).toEqual([503, "FEATURE_UNAVAILABLE", { feature: "ai" }]);
    expect(h.fake.callsTo("aiConcierge")).toHaveLength(0);
  });
});

describe("GET /v1/ai/quota", () => {
  it("AiQuota (internal fields dropped), sub = user; 401; garbage → 503; old concierge (404 without code) → 503", async () => {
    await setup();
    const r = await get("/v1/ai/quota");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(QUOTA);
    expect(Value.Check(AiQuotaSchema, r.json())).toBe(true);
    expect(h.fake.callsTo("aiConcierge", "GET", "/internal/v1/quota")[0]!.subject).toBe(s.userId);
    expect((await h.app.inject({ url: "/v1/ai/quota" })).statusCode).toBe(401);
    h.fake.override("aiConcierge", "GET", "/internal/v1/quota", () => json(200, { ...QUOTA, used: -1 }));
    expect((await get("/v1/ai/quota")).json().code).toBe("UPSTREAM_UNAVAILABLE");
    h.fake.override("aiConcierge", "GET", "/internal/v1/quota", () => json(404, { detail: "Not Found" }));
    expect((await get("/v1/ai/quota")).statusCode).toBe(503);
    h.fake.down.add("aiConcierge");
    expect((await get("/v1/ai/quota")).statusCode).toBe(503);
  });
});

// ====================================================================================== переписки

describe("POST /v1/ai/conversations", () => {
  it("constraints from preferences and lang from identity; trip_params as recalculate + selected_tier; 201 then 200 with the same key", async () => {
    await setup();
    await setPrefs({
      interests: { categories: ["sport.motorsport", "BAD CODE"], entities: ["Formula 1"] },
      geographies: [{ level: "country", code: "AE" }],
      budget: { currency: "USD", preset: "1000_2000", min: 1000, max: 2000, custom_amount: null },
      hotel_prefs: { rating_min: 8, max_distance_km: 3, min_stars: null },
      search_horizon_months: 6,
    });
    await post("/v1/profile/departures", {}); // no-op для типов
    h.fake.prefs.get(s.userId)!.departures = [{ airport_iata: "TAS", city: "Tashkent", country_code: "UZ" }];
    const ev = catalogEvent();
    h.fake.catalog.push(ev);
    const key = idem();
    const trip = { travellers: 2, direct_only: true, hotel_filters: { max_distance_km: 1 }, selected_tier: "premium" };
    const r = await post("/v1/ai/conversations", { mode: "event", event_id: ev.event_id.toUpperCase(), trip_params: trip }, key);
    expect(r.statusCode).toBe(201);
    expect(Value.Check(AiConversationSchema, r.json())).toBe(true);
    expect(r.body).not.toContain("internal_note");
    const call = h.fake.callsTo("aiConcierge", "POST", "/internal/v1/conversations")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.headers["idempotency-key"]).toBe(key["idempotency-key"]);
    expect(call.body).toEqual({
      mode: "event",
      event_id: ev.event_id,
      trip_params: trip,
      lang: "ru",
      constraints: {
        departures: [{ airport_iata: "TAS", city: "Tashkent", country_code: "UZ" }],
        flight_prefs: { direct: true, connecting: true, alternative_departure: true },
        budget: { min: "1000.00", max: "2000.00" },
        hotel_prefs: { rating_min: 8, max_distance_km: 3, min_stars: null },
        interests: ["sport.motorsport"],
        entities: ["Formula 1"],
        geographies: [{ level: "country", code: "AE" }],
        horizon_months: 6,
        lang: "ru",
      },
    });
    const again = await post("/v1/ai/conversations", { mode: "event", event_id: ev.event_id, trip_params: trip }, key);
    expect([again.statusCode, again.json().conversation_id]).toEqual([200, r.json().conversation_id]);
  });

  it("home mode with query (control chars stripped); validation: mode rules, constraints from client, bad trip_params, no key → 422", async () => {
    await setup();
    const home = await post("/v1/ai/conversations", { mode: "home", query: "джаз\u0007 в Баку" }, idem());
    expect(home.statusCode).toBe(201);
    expect(h.fake.callsTo("aiConcierge", "POST", "/internal/v1/conversations")[0]!.body).toMatchObject({ mode: "home", query: "джаз  в Баку" });
    const ev = randomUUID();
    const bad: Array<[unknown, Record<string, string>, string]> = [
      [{ mode: "event" }, idem(), "VALIDATION_ERROR"],
      [{ mode: "event", event_id: ev, query: "x" }, idem(), "VALIDATION_ERROR"],
      [{ mode: "home", event_id: ev }, idem(), "VALIDATION_ERROR"],
      [{ mode: "home", trip_params: { travellers: 1 } }, idem(), "VALIDATION_ERROR"],
      [{ mode: "home", query: "   " }, idem(), "VALIDATION_ERROR"],
      [{ mode: "home", constraints: { budget: null } }, idem(), "VALIDATION_ERROR"],
      [{ mode: "event", event_id: ev, trip_params: { travellers: 9 } }, idem(), "VALIDATION_ERROR"],
      [{ mode: "event", event_id: ev, trip_params: { travellers: 1, selected_tier: "vip" } }, idem(), "VALIDATION_ERROR"],
      [{ mode: "event", event_id: ev, trip_params: { travellers: 1, offer_id: ev } }, idem(), "VALIDATION_ERROR"],
      [{ mode: "chat" }, idem(), "VALIDATION_ERROR"],
      [{ mode: "home" }, {}, "IDEMPOTENCY_KEY_REQUIRED"],
      [{ mode: "home" }, { "idempotency-key": "not-a-uuid" }, "IDEMPOTENCY_KEY_REQUIRED"],
    ];
    for (const [body, headers, code] of bad) {
      const r = await post("/v1/ai/conversations", body, headers);
      expect([JSON.stringify(body), r.statusCode, r.json().code]).toEqual([JSON.stringify(body), 422, code]);
    }
    expect(h.fake.callsTo("aiConcierge", "POST", "/internal/v1/conversations")).toHaveLength(1);
  });

  it("preferences down → 503 (no call); EVENT_NOT_FOUND passes; broken conversation → 503; extra fields dropped; bad messages dropped", async () => {
    await setup();
    h.fake.down.add("preferences");
    const r1 = await post("/v1/ai/conversations", { mode: "home" }, idem());
    expect([r1.statusCode, r1.json().details]).toEqual([503, { service: "preferences" }]);
    expect(h.fake.callsTo("aiConcierge")).toHaveLength(0);
    h.fake.down.delete("preferences");
    h.fake.override("aiConcierge", "POST", "/internal/v1/conversations", () => domainError(404, "EVENT_NOT_FOUND", { event_id: "x" }));
    const nf = await post("/v1/ai/conversations", { mode: "event", event_id: randomUUID() }, idem());
    expect([nf.statusCode, nf.json().code, nf.json().details]).toEqual([404, "EVENT_NOT_FOUND", {}]);
    h.fake.override("aiConcierge", "POST", "/internal/v1/conversations", () => json(201, { conversation_id: "x" }));
    expect((await post("/v1/ai/conversations", { mode: "home" }, idem())).statusCode).toBe(503);
  });
});

describe("GET / DELETE /v1/ai/conversations/{id}", () => {
  it("history: valid messages pass, broken ones dropped; someone else's / not a UUID → 404 AI_CONVERSATION_NOT_FOUND", async () => {
    await setup();
    const id = await conversation();
    const turn = randomUUID();
    ai.messages = [
      { message_id: randomUUID(), turn_id: turn, role: "user", text: "Только прямые", segments: null, created_at: "2026-10-12T10:01:00Z" },
      {
        message_id: randomUUID(),
        turn_id: turn,
        role: "assistant",
        text: null,
        segments: [{ kind: "fact", text: "Прямой — $420", sources: [{ ref: "T1", title: "Aviasales", domain: "aviasales.com", url: "https://www.aviasales.com/x", fetched_at: null }] }],
        created_at: "2026-10-12T10:01:05Z",
        status: "completed",
        applied_change: null,
        actions: [],
        tool_results: [],
      },
      { message_id: randomUUID(), turn_id: turn, role: "system", text: "x", segments: null, created_at: "2026-10-12T10:01:05Z" },
      { message_id: randomUUID(), turn_id: turn, role: "assistant", text: null, segments: [{ kind: "fact", text: "x", sources: [{ ref: "S1", title: "t", domain: "d", url: "http://evil.example", fetched_at: null }] }], created_at: "2026-10-12T10:01:05Z" },
    ];
    const r = await get(`/v1/ai/conversations/${id.toUpperCase()}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().messages).toHaveLength(2);
    expect(h.logs.text).toContain("ai messages dropped (schema)");
    const other = await login(h, { id: 900333, first_name: "Other", username: "other_ai" });
    const foreign = await get(`/v1/ai/conversations/${id}`, other.access);
    expect([foreign.statusCode, foreign.json().code]).toEqual([404, "AI_CONVERSATION_NOT_FOUND"]);
    expect((await get("/v1/ai/conversations/not-a-uuid")).json().code).toBe("AI_CONVERSATION_NOT_FOUND");
    const delForeign = await h.app.inject({ method: "DELETE", url: `/v1/ai/conversations/${id}`, headers: auth(other.access) });
    expect(delForeign.statusCode).toBe(404);
    const del = await h.app.inject({ method: "DELETE", url: `/v1/ai/conversations/${id}`, headers: auth() });
    expect([del.statusCode, del.body]).toEqual([204, ""]);
    expect((await get(`/v1/ai/conversations/${id}`)).statusCode).toBe(404);
  });
});

// ====================================================================================== ход SSE

describe("POST /v1/ai/conversations/{id}/messages — SSE proxy", () => {
  it("events pass in order with BFF ids, heartbeat passes, extra fields dropped; upstream gets constraints, lang, text, trip_params", async () => {
    await setup();
    const id = await conversation();
    const msg = randomUUID();
    const r = await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: msg, text: "Только прямые", trip_params: { travellers: 2, selected_tier: "comfort" } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(r.headers["x-accel-buffering"]).toBe("no");
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.headers["x-trace-id"]).toBeTruthy();
    const { events, pings } = parseSse(r.body);
    expect(pings).toBe(1);
    expect(events.map((e) => e.event)).toEqual(["tool_call", "tool_result", "fact", "delta", "done"]);
    const turnId = events[0]!.data.turn_id;
    expect(events.map((e) => e.id)).toEqual([0, 1, 2, 3, 4].map((n) => `${turnId}:${n}`));
    expect(events[1]!.data).not.toHaveProperty("secret_debug");
    expect(events[1]!.data.offer).toEqual(OFFER_BRIEF);
    expect(events[3]!.data.text).toBe("Прямой рейс TAS → AUH — $420 на человека.\nИтого $1 470.");
    expect(events[4]!.data).toMatchObject({ status: "completed", model: "primary", quota: { used: 2, remaining: 8 } });
    // набор быстрых действий после хода: plus1 и подпись вылета названием города проходят как есть
    expect(events[4]!.data.quick_actions).toEqual([
      { id: "plus1", tool: "extend_trip_days", args: { extra_nights: 1 }, label_key: "ai.q.plus1", params: {} },
      { id: "dep_ALA", tool: "change_departure", args: { departure_iata: "ALA" }, label_key: "ai.q.dep", params: { iata: "ALA", city_name: "Алматы" } },
    ]);
    const call = turnCalls()[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.headers.accept).toBe("text/event-stream");
    expect(call.body).toMatchObject({ client_msg_id: msg, text: "Только прямые", trip_params: { travellers: 2, selected_tier: "comfort" }, lang: "ru", constraints: { lang: "ru" } });
    expect(call.body).not.toHaveProperty("action");
  });

  it("corrupted upstream: unknown event, non-JSON, schema violations, long strings, http links, foreign turn_id → dropped with WARNING (no content in logs)", async () => {
    await setup();
    const id = await conversation();
    ai.script = (t) => {
      const ev = happyEvents(t);
      const other = randomUUID();
      return [
        frame(t, 0, "debug", { turn_id: t, prompt: "SECRET-PROMPT" }),
        "event: tool_call\ndata: {not json SECRET-JSON\n\n",
        frame(t, 1, "tool_call", { ...ev[0]![1], tool: "buy_tickets" }),
        frame(t, 2, "tool_call", ev[0]![1]),
        frame(t, 3, "tool_result", { ...ev[1]![1], offer: { ...OFFER_BRIEF, per_person: "1e3" } }),
        frame(t, 4, "fact", { ...ev[2]![1], sources: [{ ref: "S1", title: "x", domain: "x", url: "http://evil.example/SECRET-URL", fetched_at: null }] }),
        frame(t, 5, "delta", { turn_id: t, segment: 0, text: "x".repeat(2001) }),
        frame(t, 6, "delta", { turn_id: other, segment: 0, text: "SECRET-OTHER-TURN" }),
        frame(t, 7, "delta", { turn_id: t, segment: 0, text: "ok‮\u0000" }),
        frame(t, 8, "done", ev[4]![1]),
        frame(t, 9, "delta", { turn_id: t, segment: 1, text: "после done" }),
      ];
    };
    const r = await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "Привет" });
    const { events } = parseSse(r.body);
    expect(events.map((e) => e.event)).toEqual(["tool_call", "delta", "done"]);
    expect(events[1]!.data.text).toBe("ok");
    const warns = h.logs.parsed().filter((l) => l.msg === "ai sse event dropped");
    expect(warns.length).toBe(7);
    expect(warns.map((w) => w.event)).toContain("unknown");
    for (const secret of ["SECRET-PROMPT", "SECRET-JSON", "SECRET-URL", "SECRET-OTHER-TURN"]) expect(h.logs.text).not.toContain(secret);
    expect(ai.aborted || ai.finished).toBe(true);
  });

  it("stream ends without done/error → BFF sends error AI_PROVIDER_UNAVAILABLE (retryable); split frames and CRLF are parsed", async () => {
    await setup();
    const id = await conversation();
    ai.script = (t) => {
      const f = frame(t, 0, "tool_call", happyEvents(t)[0]![1]).replace(/\n/g, "\r\n");
      return [f.slice(0, 17), { wait: 20 }, f.slice(17, 40), f.slice(40)];
    };
    const { events } = parseSse((await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "Привет" })).body);
    expect(events.map((e) => e.event)).toEqual(["tool_call", "error"]);
    expect(events[1]!.data).toEqual({
      turn_id: events[0]!.data.turn_id,
      code: "AI_PROVIDER_UNAVAILABLE",
      message: "AI сейчас недоступен. Цены и детали — в блоке «Поездка»",
      retryable: true,
      quota_refunded: false,
    });
    expect(h.logs.text).toContain("ai sse stream incomplete");
  });

  it("errors before the stream are JSON with HTTP status, details filtered, Retry-After; unknown 404 / 5xx → 503", async () => {
    await setup({ AI_RATE_PER_MINUTE: "100" });
    const id = await conversation();
    const cases: Array<[Response, number, string, Record<string, unknown>, string | undefined]> = [
      [domainError(429, "AI_QUOTA_EXCEEDED", { limit: 10, used: 10, level: "basic", resets_at: new Date(Date.now() + 3600_000).toISOString(), user_id: "x" }), 429, "AI_QUOTA_EXCEEDED", {}, "36"],
      [domainError(409, "AI_TURN_IN_PROGRESS", { secret: 1 }), 409, "AI_TURN_IN_PROGRESS", {}, undefined],
      [domainError(409, "AI_CONCIERGE_PAUSED"), 409, "AI_CONCIERGE_PAUSED", {}, undefined],
      [domainError(429, "AI_BUDGET_EXHAUSTED", { limit: "concierge", retry_after: 600 }), 429, "AI_BUDGET_EXHAUSTED", { limit: "concierge", retry_after: 600 }, "600"],
      [domainError(503, "AI_BUSY", { retry_after: 30 }), 503, "AI_BUSY", { retry_after: 30 }, "30"],
      [domainError(422, "AI_TOOL_NOT_ALLOWED"), 422, "AI_TOOL_NOT_ALLOWED", {}, undefined],
      [domainError(422, "VALIDATION_ERROR", { errors: [{ loc: ["body", "x"], input: "SECRET" }] }), 422, "VALIDATION_ERROR", { in: "body" }, undefined],
      [domainError(410, "USER_DELETED"), 410, "USER_DELETED", {}, undefined],
      [json(404, { detail: "Not Found" }), 503, "UPSTREAM_UNAVAILABLE", { service: "ai-concierge" }, undefined],
      [domainError(500, "BOOM"), 503, "UPSTREAM_UNAVAILABLE", { service: "ai-concierge" }, undefined],
      [domainError(403, "CALLER_NOT_ALLOWED"), 503, "UPSTREAM_UNAVAILABLE", { service: "ai-concierge" }, undefined],
      [new Response("not json", { status: 200, headers: { "content-type": "text/html" } }), 503, "UPSTREAM_UNAVAILABLE", { service: "ai-concierge" }, undefined],
    ];
    for (const [resp, status, code, details, retryAfter] of cases) {
      ai.turnOverride = () => resp;
      const r = await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "Привет" });
      expect([code, r.statusCode, r.json().code]).toEqual([code, status, code]);
      if (code === "AI_QUOTA_EXCEEDED") {
        expect(r.json().details).toMatchObject({ limit: 10, used: 10, level: "basic" });
        expect(r.json().details).not.toHaveProperty("user_id");
        expect(Number(r.headers["retry-after"])).toBeGreaterThan(3000);
      } else expect(r.json().details).toEqual(details);
      if (retryAfter && code !== "AI_QUOTA_EXCEEDED") expect(r.headers["retry-after"]).toBe(retryAfter);
      expect(r.body).not.toContain("SECRET");
    }
  });

  it("Accept: application/json → AiTurnResult built from validated events (fallback without stream)", async () => {
    await setup({ AI_RATE_PER_MINUTE: "100" });
    const id = await conversation();
    const r = await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "Только прямые" }, { accept: "application/json" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    const t = r.json();
    expect(Value.Check(AiTurnResultSchema, t)).toBe(true);
    expect(t.segments).toEqual([{ segment: 0, kind: "fact", sources: [expect.objectContaining({ ref: "T1" })], text: "Прямой рейс TAS → AUH — $420 на человека.\nИтого $1 470." }]);
    expect(t.tool_results).toHaveLength(1);
    expect(t.done).toMatchObject({ status: "completed" });
    expect(t.error).toBeNull();
    expect(turnCalls()[0]!.headers.accept).toBe("application/json");
    // ошибки до хода в запасном пути — те же коды, что у потока (503 AI_BUSY не становится UPSTREAM_UNAVAILABLE)
    ai.turnOverride = () => domainError(503, "AI_BUSY", { retry_after: 20 });
    const busy = await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "x" }, { accept: "application/json" });
    expect([busy.statusCode, busy.json().code, busy.headers["retry-after"]]).toEqual([503, "AI_BUSY", "20"]);
    ai.turnOverride = () => domainError(429, "AI_QUOTA_EXCEEDED", { limit: 10, used: 10, level: "basic" });
    expect((await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "x" }, { accept: "application/json" })).json()).toMatchObject({ code: "AI_QUOTA_EXCEEDED", details: { limit: 10, used: 10, level: "basic" } });
    ai.turnOverride = () => domainError(500, "INTERNAL");
    expect((await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "x" }, { accept: "application/json" })).json().code).toBe("UPSTREAM_UNAVAILABLE");
    ai.turnOverride = () => json(200, { turn_id: randomUUID(), events: [{ event: "fact", data: { segment: 0 } }] });
    const broken = (await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "x" }, { accept: "application/json" })).json();
    expect(broken.error).toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("validation: text 1..500, client_msg_id UUID, extra fields, bad trip_params → 422 without upstream call; not a UUID conversation → 404", async () => {
    await setup();
    const id = await conversation();
    for (const body of [
      { client_msg_id: randomUUID(), text: "" },
      { client_msg_id: randomUUID(), text: "   " },
      { client_msg_id: randomUUID(), text: "x".repeat(501) },
      { client_msg_id: "1", text: "x" },
      { client_msg_id: randomUUID(), text: "x", constraints: {} },
      { client_msg_id: randomUUID(), text: "x", trip_params: { travellers: 1, extra_nights: 7 } },
    ]) {
      const r = await post(`/v1/ai/conversations/${id}/messages`, body);
      expect([JSON.stringify(body).slice(0, 60), r.statusCode]).toEqual([JSON.stringify(body).slice(0, 60), 422]);
    }
    expect(turnCalls()).toHaveLength(0);
    const nf = await post("/v1/ai/conversations/xyz/messages", { client_msg_id: randomUUID(), text: "x" });
    expect([nf.statusCode, nf.json().code]).toEqual([404, "AI_CONVERSATION_NOT_FOUND"]);
    expect((await h.app.inject({ method: "POST", url: `/v1/ai/conversations/${id}/messages`, payload: { client_msg_id: randomUUID(), text: "x" } })).statusCode).toBe(401);
  });

  it("rate limit AI_RATE_PER_MINUTE (messages + actions share it) → 429 RATE_LIMITED, upstream not called", async () => {
    await setup({ AI_RATE_PER_MINUTE: "2" });
    const id = await conversation();
    expect((await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "1" })).statusCode).toBe(200);
    expect((await post(`/v1/ai/conversations/${id}/actions/set_direct_only`, { client_msg_id: randomUUID(), args: { direct_only: true } })).statusCode).toBe(200);
    const r = await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "3" });
    expect([r.statusCode, r.json().code]).toEqual([429, "RATE_LIMITED"]);
    expect(r.headers["retry-after"]).toBeTruthy();
    expect(turnCalls()).toHaveLength(2);
    expect((await get("/v1/ai/quota")).statusCode).toBe(200); // прочее — общий лимит
  });
});

describe("POST /v1/ai/conversations/{id}/actions/{tool}", () => {
  it("action {tool, args} goes upstream; reprice alias; unknown tool → 404 AI_TOOL_NOT_FOUND; bad args → 422", async () => {
    await setup();
    const id = await conversation();
    const r = await post(`/v1/ai/conversations/${id}/actions/change_departure`, { client_msg_id: randomUUID(), args: { departure_iata: "ALA" } });
    expect(r.statusCode).toBe(200);
    expect(turnCalls()[0]!.body).toMatchObject({ action: { tool: "change_departure", args: { departure_iata: "ALA" } } });
    expect(turnCalls()[0]!.body).not.toHaveProperty("text");
    await post(`/v1/ai/conversations/${id}/actions/reprice`, { client_msg_id: randomUUID(), args: { tier: "economy", relax: ["direct_only"] } });
    expect(turnCalls()[1]!.body).toMatchObject({ action: { tool: "reprice_offer", args: { tier: "economy", relax: ["direct_only"] } } });
    const unknown = await post(`/v1/ai/conversations/${id}/actions/buy_tickets`, { client_msg_id: randomUUID(), args: {} });
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, "AI_TOOL_NOT_FOUND"]);
    for (const args of [
      Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 1])),
      { departure_iata: { nested: true } },
      { query: "x".repeat(81) },
    ]) {
      expect((await post(`/v1/ai/conversations/${id}/actions/find_similar_event`, { client_msg_id: randomUUID(), args })).statusCode).toBe(422);
    }
    expect(turnCalls()).toHaveLength(2);
  });
});

// ====================================================================================== поток по сети

describe("SSE over a real socket: no buffering, client close aborts upstream, timeout", () => {
  async function listen(): Promise<string> {
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.app.server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  it("first event reaches the client before upstream finishes; closing the client aborts the upstream stream", async () => {
    await setup();
    const id = await conversation();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    ai.script = (t) => [frame(t, 0, "tool_call", happyEvents(t)[0]![1]), { gate }, frame(t, 1, "done", happyEvents(t)[4]![1])];
    const base = await listen();
    const ctl = new AbortController();
    const resp = await fetch(`${base}/v1/ai/conversations/${id}/messages`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", origin: "https://miniapp.tilhero.test" },
      body: JSON.stringify({ client_msg_id: randomUUID(), text: "Привет" }),
      signal: ctl.signal,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("access-control-allow-origin")).toBe("https://miniapp.tilhero.test");
    const reader = resp.body!.getReader();
    const first = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
    expect(first).not.toBeNull();
    expect(new TextDecoder().decode((first as { value: Uint8Array }).value)).toContain("event: tool_call");
    ctl.abort();
    await reader.cancel().catch(() => undefined);
    for (let i = 0; i < 50 && !ai.aborted; i++) await new Promise((r) => setTimeout(r, 20));
    expect(ai.aborted).toBe(true);
    expect(ai.finished).toBe(false);
    release();
  });

  it("CONCIERGE_TIMEOUT_MS: upstream stalls → error AI_TIMEOUT, upstream aborted", { timeout: 20_000 }, async () => {
    await setup({ CONCIERGE_TIMEOUT_MS: "5000" });
    const id = await conversation();
    ai.script = (t) => [frame(t, 0, "tool_call", happyEvents(t)[0]![1]), { wait: 15_000 }];
    const r = await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "Привет" });
    const { events } = parseSse(r.body);
    expect(events.map((e) => e.event)).toEqual(["tool_call", "error"]);
    expect(events[1]!.data).toMatchObject({ code: "AI_TIMEOUT", retryable: true });
    expect(ai.aborted).toBe(true);
  });
});

// ====================================================================================== recalculate + selected_tier

describe("recalculate accepts AiTripParams (selected_tier is not sent to offers)", () => {
  it("tool_result.trip_params applied as is → 200; offers:build body has no selected_tier", async () => {
    await setup();
    const ev = catalogEvent();
    h.fake.catalog.push(ev);
    const r = await post(`/v1/events/${ev.event_id}/offers/recalculate`, { travellers: 2, direct_only: true, selected_tier: "premium" });
    expect(r.statusCode).toBe(200);
    const build = h.fake.callsTo("offers", "POST", "/internal/v1/offers:build").at(-1)!;
    expect(JSON.stringify(build.body)).not.toContain("selected_tier");
    expect((await post(`/v1/events/${ev.event_id}/offers/recalculate`, { travellers: 2, selected_tier: "vip" })).statusCode).toBe(422);
  });
});

// ====================================================================================== единицы

describe("units: SSE parser and event check", () => {
  it("SseParser: LF/CRLF/CR, split chunks, multi-line data, comments, id ignored", () => {
    const p = new SseParser();
    const out = [
      ...p.push(": ping\r\n\r\nid: 1\r\nevent: delta\r"),
      ...p.push("\ndata: {\"a\":\r\ndata: 1}\r\n\r"),
      ...p.push("\n"),
      ...p.push("event: done\ndata: {}\n\nevent: x\n"),
    ];
    expect(out).toEqual([
      { comment: true, event: "message", data: "" },
      { comment: false, event: "delta", data: '{"a":\n1}' },
      { comment: false, event: "done", data: "{}" },
    ]);
    expect(() => new SseParser().push("data: " + "x".repeat(300_000))).toThrow();
  });

  it("sseEventOf: known types only, JSON, schema", () => {
    const t = randomUUID();
    expect(sseEventOf("delta", JSON.stringify({ turn_id: t, segment: 0, text: "a" }))).toEqual({ ok: true, value: { event: "delta", data: { turn_id: t, segment: 0, text: "a" } }, pruned: 0 });
    expect(sseEventOf("message", "{}")).toMatchObject({ ok: false, reason: "unknown_event" });
    expect(sseEventOf("delta", "{")).toMatchObject({ ok: false, reason: "not_json" });
    expect(sseEventOf("delta", JSON.stringify({ turn_id: "x", segment: 0, text: "a" }))).toMatchObject({ ok: false });
    expect(sseEventOf("tool_call", JSON.stringify({ turn_id: t, call_id: "c", tool: "set_direct_only", args: { "Bad-Key": 1 }, label_key: "ai.tool.runU" }))).toMatchObject({ ok: false });
  });
  it("ai-concierge §1.2: greeting params are scalars only (price_amount / price_currency), plus1 and dep {iata, city_name} pass", () => {
    const id = randomUUID();
    const plus1 = { id: "plus1", tool: "extend_trip_days", args: { extra_nights: 1 }, label_key: "ai.q.plus1", params: {} };
    const dep = { id: "dep_ALA", tool: "change_departure", args: { departure_iata: "ALA" }, label_key: "ai.q.dep", params: { iata: "ALA", city_name: "Алматы" } };
    const base = (o: Record<string, unknown>) => {
      const c = conversationFixture(id, o);
      delete c.internal_note;
      return c;
    };
    const online = base({ greeting: { key: "ai.hello.online", params: { price_amount: "120.00", price_currency: "USD" } }, quick_actions: [plus1, dep] });
    expect(Value.Check(AiConversationSchema, online)).toBe(true);
    expect(Value.Check(AiConversationSchema, base({ greeting: { key: "ai.hello.online", params: { price_amount: null, price_currency: null } } }))).toBe(true);
    // объект в параметрах приветствия (ранний формат {price: {amount, currency}}) — не по контракту
    expect(Value.Check(AiConversationSchema, base({ greeting: { key: "ai.hello.online", params: { price: { amount: "120.00", currency: "USD" } } } }))).toBe(false);
    // params быстрого действия — только скаляры с ключами-словами
    expect(Value.Check(AiConversationSchema, base({ quick_actions: [{ ...dep, params: { city: { name: "x" } } }] }))).toBe(false);
    expect(Value.Check(AiConversationSchema, base({ quick_actions: [{ ...dep, params: { "City-Name": "x" } }] }))).toBe(false);
    // done несёт набор быстрых действий после хода
    const t = randomUUID();
    const done = { turn_id: t, message_id: randomUUID(), status: "completed", applied_change: null, actions: [], quota: QUOTA, model: "primary", quick_actions: [plus1, dep] };
    expect(sseEventOf("done", JSON.stringify(done))).toMatchObject({ ok: true, value: { event: "done", data: { quick_actions: [plus1, dep] } } });
  });
});

// ====================================================================================== ревью спринта 7

describe("review: broken list items are dropped one by one, done is kept", () => {
  it("SSE: done with a broken action and a broken quick_action → done delivered with the good ones, no synthetic error", async () => {
    await setup();
    const id = await conversation();
    ai.script = (t) => {
      const ev = happyEvents(t);
      const done = {
        ...ev[4]![1],
        actions: [{ type: "watch_price", event_id: "0b7c3a52-1d2e-4f60-8a9b-000000000777" }, { type: "buy", event_id: "x" }, { type: "retry", tool: "hack", args: {} }],
        quick_actions: [
          { id: "direct", tool: "set_direct_only", args: { direct_only: true }, label_key: "ai.q.direct" },
          { id: "evil", tool: "set_direct_only", args: {}, label_key: "ai.q.direct" },
          { id: "near", tool: "set_hotel_distance", args: { "Bad-Key": 1 }, label_key: "ai.q.near" },
        ],
      };
      return [frame(t, 0, "tool_call", ev[0]![1]), frame(t, 1, "done", done)];
    };
    const { events } = parseSse((await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "Привет" })).body);
    expect(events.map((e) => e.event)).toEqual(["tool_call", "done"]);
    expect(events[1]!.data.actions).toEqual([{ type: "watch_price", event_id: "0b7c3a52-1d2e-4f60-8a9b-000000000777" }]);
    expect(events[1]!.data.quick_actions.map((q: { id: string }) => q.id)).toEqual(["direct"]);
    expect(h.logs.parsed().find((l) => l.msg === "ai sse items dropped")).toMatchObject({ event: "done", dropped_items: 4 });
    expect(h.logs.text).not.toContain("ai sse stream incomplete");
  });

  it("SSE: done with actions not an array → actions [] (done kept); JSON fallback prunes the same way", async () => {
    await setup({ AI_RATE_PER_MINUTE: "100" });
    const id = await conversation();
    ai.script = (t) => [frame(t, 0, "done", { ...happyEvents(t)[4]![1], actions: "nope", quick_actions: { x: 1 } })];
    const { events } = parseSse((await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "x" })).body);
    expect(events.map((e) => e.event)).toEqual(["done"]);
    expect(events[0]!.data.actions).toEqual([]);
    expect(events[0]!.data).not.toHaveProperty("quick_actions");
    const t = randomUUID();
    ai.turnOverride = () =>
      json(200, { turn_id: t, events: [{ event: "done", data: { ...happyEvents(t)[4]![1], actions: [{ type: "open_event", event_id: "bad" }] } }] });
    const res = (await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "x" }, { accept: "application/json" })).json();
    expect(res.error).toBeNull();
    expect(res.done).toMatchObject({ status: "completed", actions: [] });
  });

  it("conversation: a broken quick action / message action is dropped, the rest stays; user quick-action message with label_key/action and text null", async () => {
    await setup();
    const id = await conversation();
    const turn = randomUUID();
    ai.conversationExtra = {
      quick_actions: [
        { id: "cheaper", tool: "reprice_offer", args: { tier: "economy" }, label_key: "ai.q.cheaper" },
        { id: "dep_ALA", tool: "change_departure", args: { departure_iata: "ALA" }, label_key: "ai.q.dep", params: { iata: "ALA", city_name: "Алматы" } },
        { id: "bad id", tool: "reprice_offer", args: {}, label_key: "ai.q.cheaper" },
      ],
    };
    ai.messages = [
      {
        message_id: randomUUID(),
        turn_id: turn,
        role: "user",
        text: null,
        segments: null,
        created_at: "2026-10-13T10:01:00Z",
        label_key: "ai.q.dep",
        action: { tool: "change_departure", args: { departure_iata: "ALA" }, label_key: "ai.q.dep", params: { iata: "ALA", city_name: "Алматы" } },
      },
      {
        message_id: randomUUID(),
        turn_id: turn,
        role: "user",
        text: null,
        segments: null,
        created_at: "2026-10-13T10:02:00Z",
        action: { tool: "buy_tickets", args: {}, label_key: "ai.q.x" },
      },
      {
        message_id: randomUUID(),
        turn_id: turn,
        role: "assistant",
        text: null,
        segments: [],
        created_at: "2026-10-13T10:01:05Z",
        status: "completed",
        actions: [{ type: "retry", tool: "change_departure", args: { departure_iata: "ALA" } }, { type: "retry", tool: "nope", args: {} }],
        tool_results: [],
      },
    ];
    const r = await get(`/v1/ai/conversations/${id}`);
    expect(r.statusCode).toBe(200);
    const c = r.json();
    expect(Value.Check(AiConversationSchema, c)).toBe(true);
    expect(c.quick_actions.map((q: { id: string }) => q.id)).toEqual(["cheaper", "dep_ALA"]);
    expect(c.quick_actions[1].params).toEqual({ iata: "ALA", city_name: "Алматы" });
    expect(c.messages).toHaveLength(3);
    expect(c.messages[0]).toMatchObject({ role: "user", text: null, label_key: "ai.q.dep", action: { tool: "change_departure", label_key: "ai.q.dep" } });
    expect(c.messages[1]).not.toHaveProperty("action");
    expect(c.messages[2].actions).toEqual([{ type: "retry", tool: "change_departure", args: { departure_iata: "ALA" } }]);
  });
});

describe("review: client closes before ai-concierge answers", () => {
  it("logged as info «client closed», not WARNING «ai-concierge unavailable»", async () => {
    await setup();
    const id = await conversation();
    h.fake.delays.set("aiConcierge", 10_000);
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (h.app.server.address() as { port: number }).port;
    const ctl = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/v1/ai/conversations/${id}/messages`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ client_msg_id: randomUUID(), text: "Привет" }),
      signal: ctl.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 300));
    ctl.abort();
    await pending;
    for (let i = 0; i < 50 && !h.logs.text.includes("client closed before upstream response"); i++) await new Promise((r) => setTimeout(r, 20));
    const line = h.logs.parsed().find((l) => l.msg === "ai turn: client closed before upstream response");
    expect(line).toMatchObject({ level: 30, reason: "client_closed" });
    expect(h.logs.text).not.toContain("ai-concierge unavailable");
  });
});

describe("history format: assistant status running|completed|partial|error + code, empty segments; user quick-action bubble", () => {
  it("accepts the new fields; legacy status «failed» or a bad code → the message is dropped", async () => {
    await setup();
    const id = await conversation();
    const turn = randomUUID();
    const base = { turn_id: turn, created_at: "2026-10-13T10:01:00Z" };
    ai.messages = [
      { ...base, message_id: randomUUID(), role: "user", text: null, segments: null, action: { tool: "set_direct_only", args: { direct_only: true }, label_key: "ai.q.direct", params: {} } },
      { ...base, message_id: randomUUID(), role: "assistant", text: null, segments: [], status: "error", code: "AI_PROVIDER_UNAVAILABLE", applied_change: null, actions: [], tool_results: [] },
      { ...base, message_id: randomUUID(), role: "assistant", text: null, segments: [], status: "running", code: null },
      { ...base, message_id: randomUUID(), role: "assistant", text: null, segments: [], status: "completed", code: null },
      { ...base, message_id: randomUUID(), role: "assistant", text: null, segments: [], status: "failed", code: null },
      { ...base, message_id: randomUUID(), role: "assistant", text: null, segments: [], status: "error", code: "not a code" },
    ];
    const c = (await get(`/v1/ai/conversations/${id}`)).json();
    expect(Value.Check(AiConversationSchema, c)).toBe(true);
    expect(c.messages.map((m: { status?: string }) => m.status ?? "user")).toEqual(["user", "error", "running", "completed"]);
    expect(c.messages[0].action).toEqual({ tool: "set_direct_only", args: { direct_only: true }, label_key: "ai.q.direct", params: {} });
    expect(c.messages[1]).toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", segments: [] });
    expect(c.messages[2].code).toBeNull();
  });
});

describe("7.1: done.actions flight_search and tool_result no_change codes", () => {
  it("flight_search with an Aviasales/tp.media https url is kept; foreign/look-alike/http/port/provider → item dropped, done kept", async () => {
    await setup();
    const id = await conversation();
    const ok = [
      "https://www.aviasales.ru/search/TAS0312AUH07121?marker=1",
      "https://aviasales.com/x",
      "https://tp.media/r?marker=1&u=https%3A%2F%2Fwww.aviasales.com%2Fx",
      "https://c1.tp.media/r?u=https%3A%2F%2Fwww.aviasales.com%2Fx",
      "https://aviasales.kz/x",
      // 7.2: партнёрские ссылки Travelpayouts в реальном формате — длинная и короткая
      "https://tp.media/r?marker=424242&trs=777&p=4114&u=https%3A%2F%2Fwww.aviasales.com%2Fsearch%2FTAS1710FRU19101",
      "https://aviasales.tp.st/kn3kv29H?erid=2VtzqwiKLkx",
    ];
    const bad = [
      { type: "flight_search", url: "https://evil.example/aviasales.ru", provider: "aviasales" },
      { type: "flight_search", url: "https://aviasales.ru.evil.example/x", provider: "aviasales" },
      { type: "flight_search", url: "https://notaviasales.ru/x", provider: "aviasales" },
      { type: "flight_search", url: "http://www.aviasales.ru/x", provider: "aviasales" },
      { type: "flight_search", url: "https://user@aviasales.ru/x", provider: "aviasales" },
      { type: "flight_search", url: "https://www.aviasales.ru:8443/x", provider: "aviasales" },
      { type: "flight_search", url: "javascript:alert(1)", provider: "aviasales" },
      { type: "flight_search", url: "https://www.aviasales.ru/x", provider: "skyscanner" },
      { type: "flight_search", provider: "aviasales" },
      { type: "flight_search", url: "https://yesim.tp.st/abc", provider: "aviasales" }, // чужой бренд Travelpayouts
      // ревью 7.2: партнёрский редирект не на сайт Aviasales и без цели
      { type: "flight_search", url: "https://tp.media/r?u=https%3A%2F%2Fevil.example%2Fx", provider: "aviasales" },
      { type: "flight_search", url: "https://tp.media/r?marker=1", provider: "aviasales" },
    ];
    ai.script = (t) => {
      const ev = happyEvents(t);
      const noChange = { ...ev[1]![1], status: "no_change", changed: false, trip_params: null };
      return [
        frame(t, 0, "tool_result", { ...noChange, code: "NO_FLIGHTS" }),
        frame(t, 1, "tool_result", { ...noChange, code: "ROUTE_NOT_SUPPORTED" }),
        frame(t, 2, "tool_result", { ...noChange, code: "NO_DIRECT" }),
        frame(t, 3, "tool_result", { ...noChange, code: "NO_HOTEL" }),
        frame(t, 4, "done", { ...ev[4]![1], actions: [...ok.map((url) => ({ type: "flight_search", url, provider: "aviasales" })), ...bad] }),
      ];
    };
    const { events } = parseSse((await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "Прямые" })).body);
    expect(events.map((e) => e.event)).toEqual(["tool_result", "tool_result", "tool_result", "tool_result", "done"]);
    expect(events.slice(0, 4).map((e) => [e.data.status, e.data.code])).toEqual([
      ["no_change", "NO_FLIGHTS"],
      ["no_change", "ROUTE_NOT_SUPPORTED"],
      ["no_change", "NO_DIRECT"],
      ["no_change", "NO_HOTEL"],
    ]);
    expect(events[4]!.data.actions).toEqual(ok.map((url) => ({ type: "flight_search", url, provider: "aviasales" })));
    expect(h.logs.parsed().find((l) => l.msg === "ai sse items dropped")).toMatchObject({ event: "done", dropped_items: bad.length });
  });

  it("the schema pattern agrees with isFlightSearchUrl (offers search_url check)", async () => {
    const { isFlightSearchUrl } = await import("../src/offers.js");
    const { FLIGHT_SEARCH_URL_PATTERN } = await import("../src/schemas.js");
    const re = new RegExp(FLIGHT_SEARCH_URL_PATTERN, "u");
    for (const url of [
      "https://www.aviasales.ru/search/x?marker=1",
      "https://aviasales.com/x",
      "https://c1.tp.media/r?u=https%3A%2F%2Fwww.aviasales.com%2Fx",
      "https://aviasales.kz:443/x",
      "https://evil.example/aviasales.ru",
      "https://aviasales.ru.evil.example/x",
      "http://aviasales.ru/x",
      "https://www.aviasales.ru:8443/x",
      "https://user@aviasales.ru/x",
    ]) {
      expect([url, re.test(url)]).toEqual([url, isFlightSearchUrl(url)]);
    }
  });
});

// ====================================================================================== спринт 8: правило NC

describe("sprint 8: done.quota_charged / quota_note_key (ход «без изменений» не списывает квоту)", () => {
  const doneOf = (t: string, extra: Record<string, unknown>) => ({
    turn_id: t, message_id: randomUUID(), status: "completed", applied_change: null, actions: [], quota: QUOTA, model: "primary", ...extra,
  });

  it("unit: fields pass through; old ai-concierge without them is fine; unknown note → null, broken flag dropped", () => {
    const t = randomUUID();
    const free = sseEventOf("done", JSON.stringify(doneOf(t, { quota_charged: false, quota_note_key: "ai.quota.free_no_change" })));
    expect(free).toMatchObject({ ok: true, pruned: 0, value: { data: { quota_charged: false, quota_note_key: "ai.quota.free_no_change" } } });
    const charged = sseEventOf("done", JSON.stringify(doneOf(t, { quota_charged: true, quota_note_key: null })));
    expect(charged).toMatchObject({ ok: true, value: { data: { quota_charged: true, quota_note_key: null } } });
    const old = sseEventOf("done", JSON.stringify(doneOf(t, {})));
    expect(old.ok).toBe(true);
    if (old.ok) expect(old.value.data).not.toHaveProperty("quota_charged");
    const odd = sseEventOf("done", JSON.stringify(doneOf(t, { quota_charged: "no", quota_note_key: "ai.quota.future_key" })));
    expect(odd).toMatchObject({ ok: true, pruned: 2, value: { data: { quota_note_key: null } } });
    if (odd.ok) expect(odd.value.data).not.toHaveProperty("quota_charged");
    expect(sseEventOf("done", JSON.stringify(doneOf(t, { quota_note_key: "<b>x</b>" })))).toMatchObject({ ok: true, value: { data: { quota_note_key: null } } });
  });

  it("SSE and JSON fallback deliver quota_charged=false with the note and the unchanged quota", async () => {
    await setup({ AI_RATE_PER_MINUTE: "100" });
    const id = await conversation();
    const quota = { ...QUOTA, used: 3, remaining: 7 };
    ai.script = (t) => [frame(t, 0, "done", { ...happyEvents(t)[4]![1], quota, quota_charged: false, quota_note_key: "ai.quota.free_no_change" })];
    const { events } = parseSse((await post(`/v1/ai/conversations/${id}/actions/set_direct_only`, { client_msg_id: randomUUID(), args: { direct_only: true } })).body);
    expect(events.map((e) => e.event)).toEqual(["done"]);
    expect(events[0]!.data).toMatchObject({ quota_charged: false, quota_note_key: "ai.quota.free_no_change", quota: { used: 3, remaining: 7 } });
    const t = randomUUID();
    ai.turnOverride = () =>
      json(200, { turn_id: t, events: [{ event: "done", data: { ...happyEvents(t)[4]![1], quota_charged: false, quota_note_key: "ai.quota.free_no_change" } }] });
    const res = (await post(`/v1/ai/conversations/${id}/messages`, { client_msg_id: randomUUID(), text: "x" }, { accept: "application/json" })).json();
    expect(res.done).toMatchObject({ quota_charged: false, quota_note_key: "ai.quota.free_no_change" });
    expect(Value.Check(AiTurnResultSchema, res)).toBe(true);
  });
});

describe("sprint 8 review: quota fields in the conversation history (the note survives a broken stream)", () => {
  it("GET conversation: quota_charged / quota_note_key pass through; unknown note → null, broken flag dropped; old records without them", async () => {
    await setup();
    const id = await conversation();
    const msg = (turn: string, extra: Record<string, unknown>) => ({
      message_id: randomUUID(), turn_id: turn, role: "assistant", text: null, segments: [{ kind: "fact", text: "Рейс уже прямой.", sources: [] }],
      created_at: "2026-10-13T10:01:05Z", status: "completed", actions: [], tool_results: [], ...extra,
    });
    ai.messages = [
      msg(randomUUID(), { quota_charged: false, quota_note_key: "ai.quota.free_no_change" }),
      msg(randomUUID(), { quota_charged: true, quota_note_key: null }),
      msg(randomUUID(), { quota_charged: "no", quota_note_key: "ai.quota.future" }),
      msg(randomUUID(), {}),
    ];
    const r = await get(`/v1/ai/conversations/${id}`);
    expect(r.statusCode).toBe(200);
    const c = r.json();
    expect(Value.Check(AiConversationSchema, c)).toBe(true);
    expect(c.messages).toHaveLength(4);
    expect(c.messages[0]).toMatchObject({ quota_charged: false, quota_note_key: "ai.quota.free_no_change" });
    expect(c.messages[1]).toMatchObject({ quota_charged: true, quota_note_key: null });
    expect(c.messages[2]).not.toHaveProperty("quota_charged");
    expect(c.messages[2].quota_note_key).toBeNull();
    expect(c.messages[3]).not.toHaveProperty("quota_charged");
    expect(c.messages[3]).not.toHaveProperty("quota_note_key");
  });
});

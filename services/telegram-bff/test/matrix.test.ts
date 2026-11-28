/**
 * Матрица по всем маршрутам /v1 (перечень — из OpenAPI приложения, новые маршруты обязаны попасть в SAMPLES):
 *  - защищённые маршруты без токена → 401 UNAUTHORIZED, с мусором → 401 TOKEN_INVALID, домены не вызываются;
 *  - 4xx домена пробрасывается клиенту как ErrorBody {code, message, trace_id = X-Trace-Id запроса, details};
 *  - 5xx домена → 503 UPSTREAM_UNAVAILABLE {service}; игра (спринт 6) — 503 GAME_UNAVAILABLE {service: gamification},
 *    картинки игры: 4xx домена → 404 ASSET_NOT_FOUND;
 *  - спринт 7: social и lessons от имени ученика (полоса — из identity, она работает) — ошибка и сбой именно этого домена;
 *    лиги и дуэли — как игра (GAME_UNAVAILABLE);
 *  - спринт 8: billing (/v1/billing/*) — 4xx: код и статус как есть, details — только поля контракта (здесь — пусто),
 *    текст — BFF (анти-стиринг); сбой — 503 BILLING_UNAVAILABLE {service: billing}.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { BILLING_ENV, bearer, closeRedis, initDataFor, login, makeHarness, type Harness, type LoggedIn, type Service } from "./helpers.js";
import { makeWav } from "./wavFixture.js";
import { OTHER_MEMBER } from "./fakeSocial.js";

let h: Harness;
let s: LoggedIn;
beforeEach(async () => {
  h = await makeHarness({
    RATE_LIMIT_USER_PER_MIN: "1000",
    RATE_LIMIT_PUBLIC_IP_PER_MIN: "1000",
    RATE_LIMIT_SESSION_IP_PER_MIN: "1000",
    RATE_LIMIT_PIN_PER_MIN: "20", // маршрутов с лимитом кода родителя больше 5 (reset-cancel — ревью T-8)
    ...BILLING_ENV,
  });
  s = await login(h);
  h.fake.setAge(s.userId, "18+");
  h.fake.onboard(s.userId);
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const ID = "8b0e1c3a-5d2f-4a6b-9c7d-1e2f3a4b5c6d";
const TOKEN = "Q".repeat(43);
/** speech — POST /v1/speech: любая ошибка tts (4xx, кроме 422, и 5xx) клиенту → 503 SPEECH_UNAVAILABLE {service: tts}. */
type Sample = {
  payload?: object | (() => object);
  idem?: boolean;
  params?: Record<string, string>;
  noDomain?: boolean;
  speech?: boolean;
  /** спринт 5: тело не JSON (audio/wav) и строка запроса */
  raw?: { body: Buffer; contentType: string };
  query?: string;
  /** спринт 6: маршрут игры (сбой gamification → 503 GAME_UNAVAILABLE); asset — публичная картинка (4xx домена → 404) */
  game?: boolean;
  asset?: boolean;
  /** спринт 7: маршрут social / lessons от имени ученика — ошибку отвечает этот домен (identity — для полосы — работает) */
  domain?: "social" | "lessons";
  /** спринт 8: маршрут billing — сбой → 503 BILLING_UNAVAILABLE; 4xx — код как есть, details только контрактные */
  billing?: boolean;
};

/** Пример корректного запроса для каждого маршрута: ключ — "METHOD /openapi/path". */
const SAMPLES: Record<string, Sample> = {
  "post /v1/session/telegram": { payload: () => ({ init_data: initDataFor() }) },
  "post /v1/session/refresh": { payload: () => ({ refresh_token: s.refresh }) },
  "post /v1/session/pin/verify": { payload: { pin: "4826" } },
  "post /v1/session/biometric/verify": { payload: { biometric_token: "bio_x" } },
  "post /v1/session/learner": { payload: { learner_id: ID } },
  "post /v1/session/logout": { noDomain: true },
  "get /v1/profile": {},
  "patch /v1/profile/settings": { payload: { locale: "uz" } },
  "put /v1/profile/age": { payload: { age_band: "18+" } },
  "get /v1/legal/policy": {},
  "post /v1/profile/consent": { payload: { policy_version: "2026-11-18", purposes: ["terms", "privacy", "learning"] } },
  "delete /v1/profile/consent": {},
  "put /v1/profile/security/pin": { payload: { pin: "4826" } },
  "delete /v1/profile/security/pin": { payload: { current_pin: "4826" } },
  "post /v1/profile/security/pin/reset-request": {},
  "post /v1/profile/security/pin/reset-confirm": { payload: { code: "246810", new_pin: "4826" } },
  "post /v1/profile/security/pin/reset-cancel": { payload: { current_pin: "4826" } },
  "put /v1/profile/security/biometric": {},
  "delete /v1/profile/security/biometric": {},
  "post /v1/profile/delete-request": { payload: { confirm_word: "УДАЛИТЬ" } },
  "get /v1/learners": {},
  "post /v1/learners": { payload: { display_name: "Мадина", age_band: "6-9" } },
  "post /v1/profile/guardian-consent": {},
  "get /v1/guardian-consents/{token}": { params: { token: TOKEN } },
  "post /v1/guardian-consents/{token}/accept": { params: { token: TOKEN } },
  "post /v1/guardian-consents/{token}/decline": { params: { token: TOKEN } },
  "post /v1/invites": { payload: { kind: "friend" }, idem: true },
  "get /v1/invites": {},
  "delete /v1/invites/{invite_id}": { params: { invite_id: ID } },
  "post /v1/invites/open": { payload: { token: "Q".repeat(32) } },
  "get /v1/invites/{invite_id}/preview": { params: { invite_id: ID } },
  "post /v1/invites/{invite_id}/accept": { params: { invite_id: ID } },
  "post /v1/invites/{invite_id}/decline": { params: { invite_id: ID } },
  "get /v1/family": {},
  "get /v1/family/guardian-consents": {},
  "post /v1/family/guardian-consents/{teen_user_id}/revoke": { params: { teen_user_id: ID } },
  "get /v1/plan": {},
  "patch /v1/plan": { payload: { goal: "work" } },
  "post /v1/plan/onboarding/complete": {},
  "get /v1/plan/today": {},
  "post /v1/plan/activity": { payload: { kind: "practice", minutes: 10 }, idem: true },
  "get /v1/directory/goals": {},
  "get /v1/directory/topics": {},
  "get /v1/notifications": {},
  "get /v1/notifications/unread-count": {},
  "post /v1/notifications/read": { payload: { all: true } },
  "get /v1/whats-new": {},
  "post /v1/whats-new/seen": { payload: { release_note_ids: [ID] } },
  "get /v1/news": {},
  "get /v1/experience/config": {},
  "post /v1/support/tickets": { payload: { category: "OTHER", subject: "Вопрос", message: "Текст" }, idem: true },
  "get /v1/support/tickets": {},
  "get /v1/support/tickets/{ticket_id}": { params: { ticket_id: ID } },
  "post /v1/support/tickets/{ticket_id}/messages": { params: { ticket_id: ID }, payload: { text: "Ещё" } },
  "post /v1/support/tickets/{ticket_id}/close": { params: { ticket_id: ID } },
  "get /v1/support/categories": {},
  // спринт 3
  "get /v1/languages": {},
  "get /v1/diagnostics/state": {},
  "post /v1/diagnostics/sessions": { payload: {}, idem: true },
  "get /v1/diagnostics/sessions/{id}/next": {},
  "post /v1/diagnostics/sessions/{id}/answers": { payload: { item_id: "v-a1-01", answer: 0, dont_know: false, time_ms: 10 } },
  "post /v1/diagnostics/sessions/{id}/listening-unavailable": {},
  "post /v1/diagnostics/sessions/{id}/finish": {},
  "post /v1/diagnostics/results/{id}/followup": { payload: { area: "grammar" } },
  "get /v1/diagnostics/results": {},
  "get /v1/skills/map": {},
  "get /v1/plan/trajectory": {},
  "get /v1/scenarios": {},
  "get /v1/scenarios/{id}": { params: { id: "sc-travel-hotel" } },
  "get /v1/media": {},
  "get /v1/media/{id}": { params: { id: "m-own-coffee" } },
  "get /v1/media/{id}/audio": { params: { id: "m-own-coffee" } },
  "get /v1/media/requests": {},
  "post /v1/media/requests": { payload: { kind: "song", title: "Yesterday" }, idem: true },
  // спринт 4
  "get /v1/lessons/{lesson_id}": { params: { lesson_id: "l-a1-01" } },
  "post /v1/lessons/{lesson_id}/sessions": { params: { lesson_id: "l-a1-01" }, idem: true },
  "post /v1/scenarios/{id}/sessions": { params: { id: "sc-cafe-order" }, idem: true },
  "post /v1/media/{id}/sessions": { params: { id: "m-own-coffee" }, idem: true },
  "get /v1/sessions/active": {},
  "get /v1/sessions": {},
  "get /v1/sessions/{id}": {},
  "post /v1/sessions/{id}/pause": {},
  "post /v1/sessions/{id}/resume": {},
  "post /v1/sessions/{id}/cancel": {},
  "get /v1/sessions/{id}/current": {},
  "post /v1/sessions/{id}/steps/{step_id}": { params: { step_id: "s1" }, payload: { choice_id: "c-order" } },
  "post /v1/sessions/{id}/steps/{step_id}/hint": { params: { step_id: "s1" } },
  "post /v1/sessions/{id}/simpler": {},
  "post /v1/sessions/{id}/roleplay/retry": {},
  "post /v1/sessions/{id}/finish": {},
  "get /v1/sessions/{id}/summary": {},
  "post /v1/sessions/{id}/review": { idem: true },
  "get /v1/evaluations/{id}": {},
  "post /v1/evaluations/{id}/appeal": { payload: { reason: "Ответ был верный" }, idem: true },
  "get /v1/appeals": {},
  // release 4.1
  "post /v1/speech": { payload: { text: "Could I have a cup of tea, please?", variant: "en-GB" }, speech: true },
  // спринт 5
  "get /v1/memory/overview": {},
  "get /v1/memory/cards": {},
  "post /v1/memory/cards": { payload: { text_en: "coffee", source: { kind: "lesson", key: "l-a1-03-cafe", version: 3 } }, idem: true },
  "get /v1/memory/cards/{id}": {},
  "post /v1/memory/cards/{id}/known": {},
  "delete /v1/memory/cards/{id}/known": {},
  "delete /v1/memory/cards/{id}": {},
  "get /v1/memory/errors": {},
  "post /v1/memory/review-sessions": { idem: true },
  "get /v1/memory/review-sessions/active": {},
  "get /v1/memory/review-sessions/{id}": {},
  "get /v1/memory/review-sessions/{id}/current": {},
  "post /v1/memory/review-sessions/{id}/tasks/{task_id}": { params: { task_id: ID }, payload: { choice: 0 } },
  "post /v1/memory/review-sessions/{id}/tasks/{task_id}/hint": { params: { task_id: ID }, payload: { kind: "first_letter" } },
  "post /v1/memory/review-sessions/{id}/finish": {},
  "post /v1/memory/review-sessions/{id}/cancel": {},
  "post /v1/memory/translate": { payload: { text: "coffee", content: { kind: "reading", key: "r-a1-coffee-shop", version: 2, locator: "s2" } } },
  "post /v1/memory/pronunciation": { raw: { body: makeWav(), contentType: "audio/wav" }, query: `target=card:${ID}` },
  "get /v1/practice/readings": {},
  "get /v1/practice/readings/{id}": { params: { id: "r-a1-coffee-shop" } },
  "post /v1/practice/readings/{id}/sessions": { params: { id: "r-a1-coffee-shop" }, idem: true },
  "put /v1/learners/{learner_id}/voice-consent": { params: { learner_id: ID }, payload: { granted: true } },
  // спринт 6
  "get /v1/game/summary": { game: true },
  "get /v1/game/heroes": { game: true },
  "get /v1/game/quests": { game: true },
  "get /v1/game/badges": { game: true },
  "get /v1/game/shop": { game: true },
  "get /v1/game/history": { game: true },
  "get /v1/game/rewards": { game: true, query: `source_session_id=${ID}` },
  "get /v1/game/settings": { game: true },
  "put /v1/game/hero": { game: true, payload: { hero_code: "robot_0" } },
  "put /v1/game/equipment": { game: true, payload: { background_code: null, frame_code: null } },
  "patch /v1/game/settings": { game: true, payload: { auto_freeze: false } },
  "post /v1/game/shop/purchases": { game: true, payload: { item_code: "streak_freeze" }, idem: true },
  "get /v1/game/assets/{asset_id}/{sha256}": { game: true, asset: true, params: { asset_id: "a-robot_0-1", sha256: "a".repeat(64) } },
  // спринт 7: social
  "get /v1/community": { domain: "social" },
  "patch /v1/community": { domain: "social", payload: { game_profile_hidden: true } },
  "put /v1/community/nickname": { domain: "social", payload: { nickname: "Igor_7" } },
  "post /v1/community/friend-code/rotate": { domain: "social" },
  "get /v1/friends/search": { domain: "social", query: "q=Anvar_77" },
  "post /v1/friends/requests": { domain: "social", payload: { member_id: OTHER_MEMBER }, idem: true },
  "get /v1/friends/requests": { domain: "social", query: "direction=in" },
  "post /v1/friends/requests/{request_id}/accept": { domain: "social" },
  "post /v1/friends/requests/{request_id}/decline": { domain: "social" },
  "post /v1/friends/requests/{request_id}/cancel": { domain: "social" },
  "get /v1/friends": { domain: "social" },
  "delete /v1/friends/{member_id}": { domain: "social", params: { member_id: OTHER_MEMBER } },
  "post /v1/blocks": { domain: "social", payload: { member_id: OTHER_MEMBER } },
  "get /v1/blocks": { domain: "social" },
  "delete /v1/blocks/{member_id}": { domain: "social", params: { member_id: OTHER_MEMBER } },
  "post /v1/complaints": { domain: "social", payload: { member_id: OTHER_MEMBER, subject_kind: "user", subject_id: null, reason: "spam" }, idem: true },
  "get /v1/sanctions": { domain: "social" },
  "post /v1/sanctions/{sanction_id}/appeal": { domain: "social", payload: { text: "Прошу пересмотреть решение" }, idem: true },
  "get /v1/referrals": { domain: "social" },
  // спринт 7: лиги и дуэли (gamification)
  "get /v1/game/leagues": { game: true },
  "get /v1/game/leagues/history": { game: true },
  "post /v1/game/duels": { game: true, payload: { opponent_member_id: OTHER_MEMBER }, idem: true },
  "get /v1/game/duels": { game: true },
  "get /v1/game/duels/{duel_id}": { game: true },
  "post /v1/game/duels/{duel_id}/accept": { game: true },
  "post /v1/game/duels/{duel_id}/decline": { game: true },
  // спринт 7: задания дуэли и парные комнаты (lessons)
  "post /v1/duel-sessions": { domain: "lessons", payload: { duel_id: ID }, idem: true },
  "get /v1/duel-sessions/{session_id}/review": { domain: "lessons" },
  "post /v1/pair-rooms": { domain: "lessons", payload: { partner_member_id: OTHER_MEMBER, pair_id: "ru-en", scenario_id: "sc-cafe-order", start: "now" }, idem: true },
  "get /v1/pair-rooms": { domain: "lessons" },
  "get /v1/pair-rooms/{room_id}": { domain: "lessons" },
  "post /v1/pair-rooms/{room_id}/accept": { domain: "lessons" },
  "post /v1/pair-rooms/{room_id}/decline": { domain: "lessons" },
  "post /v1/pair-rooms/{room_id}/cancel": { domain: "lessons" },
  "post /v1/pair-rooms/{room_id}/leave": { domain: "lessons" },
  "post /v1/pair-rooms/{room_id}/join": { domain: "lessons" },
  "post /v1/pair-rooms/{room_id}/heartbeat": { domain: "lessons" },
  "get /v1/pair-rooms/{room_id}/state": { domain: "lessons", query: "after_seq=0" },
  "post /v1/pair-rooms/{room_id}/turns": { domain: "lessons", payload: { choice_id: "c1" }, idem: true },
  "post /v1/pair-rooms/{room_id}/audio": { domain: "lessons", raw: { body: makeWav(), contentType: "audio/wav" } },
  "get /v1/pair-rooms/{room_id}/report": { domain: "lessons" },
  // спринт 8: подписка и покупки за Telegram Stars (billing, канал miniapp)
  "get /v1/billing/catalog": { billing: true },
  "get /v1/billing/subscription": { billing: true },
  "get /v1/billing/minutes": { billing: true },
  "get /v1/billing/orders": { billing: true },
  "get /v1/billing/orders/{order_no}": { billing: true, params: { order_no: "1001" } },
  "post /v1/billing/trial": { billing: true, idem: true },
  "post /v1/billing/orders": { billing: true, idem: true, payload: { product_code: "plus_90d", provider: "telegram_stars", offer_version: "1.0", start_mode: "now" } },
  "post /v1/billing/orders/{order_no}/cancel": { billing: true, params: { order_no: "1001" } },
  "post /v1/billing/stars-subscription": { billing: true, payload: { auto_renew: false } },
};

interface Op {
  key: string;
  method: string;
  path: string;
  secured: boolean;
}

async function operations(): Promise<Op[]> {
  const doc = (await h.app.inject({ url: "/openapi.json" })).json() as { paths: Record<string, Record<string, { security?: unknown[] }>> };
  const ops: Op[] = [];
  for (const [path, byMethod] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(byMethod)) {
      if (!path.startsWith("/v1/")) continue;
      ops.push({ key: `${method} ${path}`, method: method.toUpperCase(), path, secured: Array.isArray(op.security) && op.security.length > 0 });
    }
  }
  return ops;
}

function urlOf(op: Op, sample: Sample): string {
  const path = op.path.replace(/\{(\w+)\}/g, (_, name: string) => sample.params?.[name] ?? ID);
  return sample.query ? `${path}?${sample.query}` : path;
}

async function call(op: Op, headers: Record<string, string>) {
  const sample = SAMPLES[op.key]!;
  const payload = typeof sample.payload === "function" ? sample.payload() : sample.payload;
  return h.app.inject({
    method: op.method as "GET",
    url: urlOf(op, sample),
    headers: { ...headers, ...(sample.idem ? { "idempotency-key": randomUUID() } : {}), ...(sample.raw ? { "content-type": sample.raw.contentType } : {}) },
    ...(sample.raw ? { payload: sample.raw.body } : payload ? { payload } : {}),
  });
}

describe("матрица маршрутов /v1", () => {
  it("каждый маршрут описан в SAMPLES; публичные — ровно контрактные", async () => {
    const ops = await operations();
    expect(ops.length).toBe(Object.keys(SAMPLES).length);
    expect(ops.map((o) => o.key).filter((k) => !SAMPLES[k])).toEqual([]);
    expect(ops.filter((o) => !o.secured).map((o) => o.key).sort()).toEqual(
      [
        "get /v1/experience/config",
        "get /v1/game/assets/{asset_id}/{sha256}",
        "get /v1/guardian-consents/{token}",
        "get /v1/legal/policy",
        "post /v1/session/refresh",
        "post /v1/session/telegram",
      ].sort(),
    );
  });

  it("защищённые: без токена → 401 UNAUTHORIZED, с мусором → 401 TOKEN_INVALID; домены не вызываются", async () => {
    h.fake.calls.length = 0;
    for (const op of (await operations()).filter((o) => o.secured)) {
      const none = await call(op, {});
      expect(none.statusCode, op.key).toBe(401);
      expect(none.json().code, op.key).toBe("UNAUTHORIZED");
      const junk = await call(op, { authorization: "Bearer a.b.c" });
      expect(junk.json().code, op.key).toBe("TOKEN_INVALID");
    }
    expect(h.fake.calls).toHaveLength(0);
  });

  it("4xx домена → ErrorBody клиенту как есть (код, статус, details, trace_id запроса)", async () => {
    for (const op of await operations()) {
      const sample = SAMPLES[op.key]!;
      if (sample.noDomain) continue;
      // refresh без живой сессии не дойдёт до домена — свежая сессия на каждый маршрут
      s = await login(h);
      // игра и спринт 7: ошибку отвечает домен маршрута (identity — для полосы ученика — работает)
      h.fake.failAll = { status: 409, code: "DOMAIN_SAYS_NO", except: new Set<Service>(sample.game || sample.domain || sample.billing ? ["identity"] : []) };
      const res = await call(op, bearer(s.access));
      h.fake.failAll = null;
      if (op.key === "post /v1/session/telegram") {
        // вход: identity отвечает ошибкой — она и приходит
        expect(res.json().code, op.key).toBe("DOMAIN_SAYS_NO");
        continue;
      }
      if (sample.speech) {
        expect([res.statusCode, res.json().code, res.json().details], op.key).toEqual([503, "SPEECH_UNAVAILABLE", { service: "tts" }]);
        continue;
      }
      if (sample.asset) {
        expect([res.statusCode, res.json().code], op.key).toEqual([404, "ASSET_NOT_FOUND"]);
        continue;
      }
      expect(res.statusCode, `${op.key}: ${res.body}`).toBe(409);
      if (sample.billing) {
        // анти-стиринг: текст и details домена наружу не уходят
        expect(res.json(), op.key).toEqual({ code: "DOMAIN_SAYS_NO", message: "Покупка сейчас недоступна", trace_id: res.headers["x-trace-id"], details: {} });
        continue;
      }
      expect(res.json(), op.key).toEqual({
        code: "DOMAIN_SAYS_NO",
        message: "domain says DOMAIN_SAYS_NO",
        trace_id: res.headers["x-trace-id"],
        details: { from: sample.domain ?? expect.any(String) },
      });
    }
  });

  it("5xx домена → 503 UPSTREAM_UNAVAILABLE {service} на каждом маршруте, без деталей домена", async () => {
    for (const op of await operations()) {
      const sample = SAMPLES[op.key]!;
      if (sample.noDomain) continue;
      s = await login(h);
      h.fake.failAll = { status: 500, code: "BOOM", except: new Set<Service>(sample.game || sample.domain || sample.billing ? ["identity"] : []) };
      const res = await call(op, bearer(s.access));
      h.fake.failAll = null;
      expect(res.statusCode, `${op.key}: ${res.body}`).toBe(503);
      expect(res.json().code, op.key).toBe(sample.speech ? "SPEECH_UNAVAILABLE" : sample.game ? "GAME_UNAVAILABLE" : sample.billing ? "BILLING_UNAVAILABLE" : "UPSTREAM_UNAVAILABLE");
      if (sample.game) expect(res.json().details, op.key).toEqual({ service: "gamification" });
      if (sample.billing) expect(res.json().details, op.key).toEqual({ service: "billing" });
      if (sample.domain) expect(res.json().details, op.key).toEqual({ service: sample.domain });
      expect(typeof res.json().details.service, op.key).toBe("string");
      expect(res.body, op.key).not.toContain("BOOM");
    }
  });
});

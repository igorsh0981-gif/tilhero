/**
 * Матрица по всем маршрутам /v1 (перечень — из OpenAPI приложения, новые маршруты обязаны попасть в SAMPLES):
 *  - защищённые маршруты без токена → 401 UNAUTHORIZED, с мусором → 401 TOKEN_INVALID, домены не вызываются;
 *  - 4xx домена пробрасывается клиенту как ErrorBody {code, message, trace_id = X-Trace-Id запроса, details};
 *  - 5xx домена → 503 UPSTREAM_UNAVAILABLE {service}.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearer, closeRedis, initDataFor, login, makeHarness, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
beforeEach(async () => {
  h = await makeHarness({
    RATE_LIMIT_USER_PER_MIN: "1000",
    RATE_LIMIT_PUBLIC_IP_PER_MIN: "1000",
    RATE_LIMIT_SESSION_IP_PER_MIN: "1000",
    RATE_LIMIT_PIN_PER_MIN: "20", // маршрутов с лимитом кода родителя больше 5 (reset-cancel — ревью T-8)
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
type Sample = { payload?: object | (() => object); idem?: boolean; params?: Record<string, string>; noDomain?: boolean };

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
  return op.path.replace(/\{(\w+)\}/g, (_, name: string) => sample.params?.[name] ?? ID);
}

async function call(op: Op, headers: Record<string, string>) {
  const sample = SAMPLES[op.key]!;
  const payload = typeof sample.payload === "function" ? sample.payload() : sample.payload;
  return h.app.inject({
    method: op.method as "GET",
    url: urlOf(op, sample),
    headers: { ...headers, ...(sample.idem ? { "idempotency-key": randomUUID() } : {}) },
    ...(payload ? { payload } : {}),
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
      h.fake.failAll = { status: 409, code: "DOMAIN_SAYS_NO", except: new Set() };
      const res = await call(op, bearer(s.access));
      h.fake.failAll = null;
      if (op.key === "post /v1/session/telegram") {
        // вход: identity отвечает ошибкой — она и приходит
        expect(res.json().code, op.key).toBe("DOMAIN_SAYS_NO");
        continue;
      }
      expect(res.statusCode, `${op.key}: ${res.body}`).toBe(409);
      expect(res.json(), op.key).toEqual({
        code: "DOMAIN_SAYS_NO",
        message: "domain says DOMAIN_SAYS_NO",
        trace_id: res.headers["x-trace-id"],
        details: { from: expect.any(String) },
      });
    }
  });

  it("5xx домена → 503 UPSTREAM_UNAVAILABLE {service} на каждом маршруте, без деталей домена", async () => {
    for (const op of await operations()) {
      const sample = SAMPLES[op.key]!;
      if (sample.noDomain) continue;
      s = await login(h);
      h.fake.failAll = { status: 500, code: "BOOM", except: new Set() };
      const res = await call(op, bearer(s.access));
      h.fake.failAll = null;
      expect(res.statusCode, `${op.key}: ${res.body}`).toBe(503);
      expect(res.json().code, op.key).toBe("UPSTREAM_UNAVAILABLE");
      expect(typeof res.json().details.service, op.key).toBe("string");
      expect(res.body, op.key).not.toContain("BOOM");
    }
  });
});

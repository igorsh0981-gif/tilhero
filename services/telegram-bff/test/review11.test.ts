/**
 * Исправления по ревью и QA спринта 1 (INTERNAL_API §11, docs/qa/sprint1-review-ts.md T-2…T-6, QA D-03):
 *  - решения родителя по подросткам: GET /v1/family/guardian-consents, POST …/{teen_user_id}/revoke (identity, sub = аккаунт);
 *  - зона клиента для плана (GET /v1/plan?tz=, X-Timezone; при первом входе план не создаётся);
 *  - согласия и возраст аккаунта в детском профиле → 403 ADULT_REQUIRED;
 *  - 401/403 внутренней авторизации доменов → 503, а не «сессия истекла»;
 *  - «Что нового» — на языке аккаунта.
 */
import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { GuardianConsentGrantSchema } from "../src/schemas.js";
import {
  TG_OTHER,
  bearer,
  closeRedis,
  domainError,
  initDataFor,
  json,
  login,
  makeHarness,
  switchTo,
  type Harness,
  type LoggedIn,
  type TgUser,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "1000" });
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const TG_TEEN: TgUser = { id: 900003, first_name: "Тимур", language_code: "ru" };
const TG_PARENT2: TgUser = { id: 900004, first_name: "Олег", language_code: "ru" };

const get = (url: string, s: LoggedIn, headers: Record<string, string> = {}) => h.app.inject({ url, headers: { ...bearer(s.access), ...headers } });
const post = (url: string, s: LoggedIn, payload?: object) =>
  h.app.inject({ method: "POST", url, headers: bearer(s.access), ...(payload ? { payload } : {}) });

/** Подросток 14–17 просит согласие, родитель (18+) даёт его по ссылке gc_. */
async function teenWithGrant(): Promise<{ parent: LoggedIn; teen: LoggedIn }> {
  const parent = await login(h);
  h.fake.setAge(parent.userId, "18+");
  const teen = await login(h, TG_TEEN, "203.0.113.11");
  h.fake.setAge(teen.userId, "14-17");
  const link = await post("/v1/profile/guardian-consent", teen);
  const token = /gc_([A-Za-z0-9_-]+)$/.exec(link.json().link)![1]!;
  const accepted = await post(`/v1/guardian-consents/${token}/accept`, parent);
  expect(accepted.statusCode).toBe(200);
  return { parent, teen };
}

describe("решения родителя по подросткам (§11)", () => {
  it("GET /v1/family/guardian-consents: подростки, за которых решал этот родитель; sub = аккаунт; только поля контракта", async () => {
    const { parent, teen } = await teenWithGrant();
    h.fake.calls.length = 0;
    const res = await get("/v1/family/guardian-consents", parent);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ teen_user_id: teen.userId, teen_display_name: "Тимур", status: "granted", decided_at: "2026-11-18T11:00:00Z" }] });
    for (const g of res.json().items) expect(Value.Check(GuardianConsentGrantSchema, g)).toBe(true);
    expect(res.body).not.toContain("guardian_user_id");
    expect(res.body).not.toContain("telegram_user_id");
    const [call] = h.fake.callsTo("identity", "GET", "/internal/v1/me/guardian-consents");
    expect(call!.subject).toBe(parent.userId);
    expect(decodeJwt(call!.headers["x-internal-token"]!).sub).toBe(parent.userId);
  });

  it("revoke: согласие отозвано → declined, у подростка guardian_consent=declined и сняты необязательные цели", async () => {
    const { parent, teen } = await teenWithGrant();
    h.fake.account(teen.userId).consent.purposes = ["terms", "privacy", "learning", "social"];
    const res = await post(`/v1/family/guardian-consents/${teen.userId.toUpperCase()}/revoke`, parent);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ teen_user_id: teen.userId, teen_display_name: "Тимур", status: "declined", decided_at: "2026-11-18T12:00:00Z" });
    // id подростка в пути домена — в нижнем регистре, команда — :revoke, sub = родитель
    const [call] = h.fake.callsTo("identity", "POST", `/internal/v1/me/guardian-consents/${teen.userId}:revoke`);
    expect(call!.subject).toBe(parent.userId);
    expect(h.fake.account(teen.userId).summary.guardian_consent).toBe("declined");
    expect(h.fake.account(teen.userId).consent.purposes).toEqual(["terms", "privacy", "learning"]);
    // в списке — declined (домен отдаёт revoked → declined по контракту)
    expect((await get("/v1/family/guardian-consents", parent)).json().items[0].status).toBe("declined");
    // повторный отзыв — 404 от домена проходит как есть
    const again = await post(`/v1/family/guardian-consents/${teen.userId}/revoke`, parent);
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe("GUARDIAN_CONSENT_NOT_FOUND");
  });

  it("IDOR: другой взрослый не видит и не отзывает чужое согласие (404 GUARDIAN_CONSENT_NOT_FOUND), согласие остаётся", async () => {
    const { teen } = await teenWithGrant();
    const other = await login(h, TG_PARENT2, "203.0.113.12");
    h.fake.setAge(other.userId, "18+");
    expect((await get("/v1/family/guardian-consents", other)).json()).toEqual({ items: [] });
    const res = await post(`/v1/family/guardian-consents/${teen.userId}/revoke`, other);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("GUARDIAN_CONSENT_NOT_FOUND");
    expect(h.fake.account(teen.userId).summary.guardian_consent).toBe("granted");
    // сам подросток не может «отозвать» согласие за себя от имени родителя
    const self = await post(`/v1/family/guardian-consents/${teen.userId}/revoke`, teen);
    expect(self.statusCode).toBe(404);
  });

  it("неверный teen_user_id → 404 GUARDIAN_CONSENT_NOT_FOUND без вызова домена (формат id не раскрывается)", async () => {
    const parent = await login(h);
    h.fake.calls.length = 0;
    for (const bad of ["not-a-uuid", "1", `${randomUUID()}x`]) {
      const res = await post(`/v1/family/guardian-consents/${bad}/revoke`, parent);
      expect(res.statusCode, bad).toBe(404);
      expect(res.json().code).toBe("GUARDIAN_CONSENT_NOT_FOUND");
    }
    expect(h.fake.callsTo("identity").filter((c) => c.path.includes("guardian-consents"))).toHaveLength(0);
  });

  it("детский профиль → 403 ADULT_REQUIRED, identity не вызывается; без токена → 401", async () => {
    const parent = await login(h);
    h.fake.setAge(parent.userId, "18+");
    const child = await switchTo(h, parent, h.fake.addChild(parent.userId));
    h.fake.calls.length = 0;
    for (const [method, url] of [
      ["GET", "/v1/family/guardian-consents"],
      ["POST", `/v1/family/guardian-consents/${randomUUID()}/revoke`],
    ] as const) {
      const res = await h.app.inject({ method, url, headers: bearer(child.access) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe("ADULT_REQUIRED");
      expect((await h.app.inject({ method, url })).json().code).toBe("UNAUTHORIZED");
    }
    expect(h.fake.calls).toHaveLength(0);
  });

  it("ответ домена вне контракта: записи без id или с неизвестным статусом не показываются; revoke о другом подростке → 503", async () => {
    const parent = await login(h);
    const teen = randomUUID();
    h.fake.override("identity", "GET", "/internal/v1/me/guardian-consents", () =>
      json(200, {
        items: [
          { teen_user_id: teen, teen_display_name: "Тимур", status: "granted", decided_at: "2026-11-18T11:00:00Z" },
          { teen_user_id: randomUUID(), teen_display_name: "Икс", status: "weird", decided_at: "2026-11-18T11:00:00Z" },
          { teen_display_name: "Без id", status: "granted", decided_at: "2026-11-18T11:00:00Z" },
        ],
      }),
    );
    expect((await get("/v1/family/guardian-consents", parent)).json().items.map((g: { teen_user_id: string }) => g.teen_user_id)).toEqual([teen]);
    h.fake.override("identity", "POST", `/internal/v1/me/guardian-consents/${teen}:revoke`, () =>
      json(200, { teen_user_id: randomUUID(), teen_display_name: "Другой", status: "declined", decided_at: "2026-11-18T12:00:00Z" }),
    );
    const res = await post(`/v1/family/guardian-consents/${teen}/revoke`, parent);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "identity-consent" } });
    expect(res.body).not.toContain("Другой");
  });

  it("решение по ссылке без своего согласия: 403 CONSENT_REQUIRED {purpose: terms} домена проходит клиенту", async () => {
    const parent = await login(h);
    h.fake.setAge(parent.userId, "18+");
    const token = "Q".repeat(43);
    h.fake.override("identity", "POST", `/internal/v1/guardian-consents/${token}/accept`, () => domainError(403, "CONSENT_REQUIRED", { purpose: "terms" }));
    const res = await post(`/v1/guardian-consents/${token}/accept`, parent);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "CONSENT_REQUIRED", details: { purpose: "terms" } });
  });

  it("приглашения: 403 CONSENT_REQUIRED {purpose: social} social проходит клиенту (Mini App показывает шторку)", async () => {
    const s = await login(h);
    h.fake.override("social", "POST", "/internal/v1/me/invites", () => domainError(403, "CONSENT_REQUIRED", { purpose: "social" }));
    const res = await h.app.inject({ method: "POST", url: "/v1/invites", headers: { ...bearer(s.access), "idempotency-key": randomUUID() }, payload: { kind: "friend" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "CONSENT_REQUIRED", details: { purpose: "social" } });
  });
});

describe("зона клиента для плана (QA D-03, ревью T-2)", () => {
  const planCalls = () => h.fake.callsTo("learningPlan", "GET", "/internal/v1/me/plan");

  it("первый вход: план не создаётся; GET /v1/plan?tz= создаёт его в зоне клиента", async () => {
    const s = await login(h);
    expect(s.body.onboarding_completed).toBe(false);
    expect(planCalls()).toHaveLength(0);
    expect(h.fake.plans.has(s.userId)).toBe(false);
    const res = await get("/v1/plan?tz=Europe/Moscow", s);
    expect(res.statusCode).toBe(200);
    expect(res.json().schedule.timezone).toBe("Europe/Moscow");
    expect(planCalls()[0]!.query).toEqual({ tz: "Europe/Moscow" });
    // у существующего плана зона не меняется
    expect((await get("/v1/plan?tz=Asia/Dubai", s)).json().schedule.timezone).toBe("Europe/Moscow");
  });

  it("повторный вход и прочие маршруты: зона из заголовка X-Timezone уходит в learning-plan (?tz=)", async () => {
    const first = await login(h);
    h.fake.setAge(first.userId, "18+");
    const child = h.fake.addChild(first.userId); // плана ребёнка ещё нет
    h.fake.calls.length = 0;
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/session/telegram",
      headers: { "x-timezone": "Asia/Almaty" },
      payload: { init_data: initDataFor() },
      remoteAddress: "203.0.113.20",
    });
    expect(res.statusCode).toBe(200);
    // планы учеников запрашиваются параллельно — порядок вызовов не важен
    expect(planCalls().map((c) => `${c.subject}:${c.query.tz}`).sort()).toEqual([`${first.userId}:Asia/Almaty`, `${child}:Asia/Almaty`].sort());
    expect(h.fake.plans.get(child)!.schedule.timezone).toBe("Asia/Almaty");
    const s: LoggedIn = { access: res.json().access_token, refresh: res.json().refresh_token, userId: first.userId, body: res.json() };
    // профиль, ученики, «Что нового» — тоже с зоной клиента
    for (const url of ["/v1/profile", "/v1/learners", "/v1/whats-new"]) {
      h.fake.calls.length = 0;
      expect((await get(url, s, { "x-timezone": "Asia/Almaty" })).statusCode, url).toBe(200);
      expect(planCalls().length, url).toBeGreaterThan(0);
      for (const c of planCalls()) expect(c.query.tz, url).toBe("Asia/Almaty");
    }
  });

  it("GET /v1/plan: ?tz= важнее заголовка; заголовок не формата IANA игнорируется; ?tz= не формата IANA → 422", async () => {
    const s = await login(h);
    h.fake.calls.length = 0;
    await get("/v1/plan?tz=Asia/Tashkent", s, { "x-timezone": "Europe/Moscow" });
    expect(planCalls()[0]!.query.tz).toBe("Asia/Tashkent");
    h.fake.calls.length = 0;
    await get("/v1/plan", s, { "x-timezone": "Europe/Moscow" });
    expect(planCalls()[0]!.query.tz).toBe("Europe/Moscow");
    h.fake.calls.length = 0;
    await get("/v1/plan", s, { "x-timezone": "../../etc;rm" });
    expect(planCalls()[0]!.query).toEqual({});
    const bad = await get("/v1/plan?tz=%3Cscript%3E", s);
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe("VALIDATION_ERROR");
    expect((await get("/v1/plan?tz=Asia/Tashkent&learner_id=x", s)).statusCode).toBe(422);
  });

  it("CORS разрешает X-Timezone", async () => {
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/v1/plan",
      headers: { origin: "https://miniapp.tilhero.test", "access-control-request-method": "GET", "access-control-request-headers": "authorization,x-timezone" },
    });
    expect(res.headers["access-control-allow-headers"]).toContain("x-timezone");
  });
});

describe("детский профиль: согласия и возраст аккаунта (ревью T-5)", () => {
  it("POST/DELETE /v1/profile/consent, PUT /v1/profile/age → 403 ADULT_REQUIRED, identity не вызывается", async () => {
    const parent = await login(h);
    h.fake.setAge(parent.userId, "18+");
    const child = await switchTo(h, parent, h.fake.addChild(parent.userId));
    h.fake.calls.length = 0;
    for (const [method, url, payload] of [
      ["POST", "/v1/profile/consent", { policy_version: "2026-11-18", purposes: ["terms", "privacy", "learning", "social"] }],
      ["DELETE", "/v1/profile/consent", undefined],
      ["PUT", "/v1/profile/age", { age_band: "18+" }],
    ] as const) {
      const res = await h.app.inject({ method, url, headers: bearer(child.access), ...(payload ? { payload } : {}) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code, url).toBe("ADULT_REQUIRED");
    }
    expect(h.fake.callsTo("identity")).toHaveLength(0);
    // в профиле родителя — как раньше
    const back = await switchTo(h, child, parent.userId);
    const ok = await h.app.inject({
      method: "POST",
      url: "/v1/profile/consent",
      headers: bearer(back.access),
      payload: { policy_version: "2026-11-18", purposes: ["terms", "privacy", "learning", "social"] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().purposes).toContain("social");
  });
});

describe("401/403 доменов не выдаются как 401 сессии (ревью T-4)", () => {
  it("внутренняя авторизация и прочие 401 домена → 503 UPSTREAM_UNAVAILABLE + запись «domain unavailable»", async () => {
    const s = await login(h);
    for (const [status, code] of [
      [401, "INTERNAL_TOKEN_UNKNOWN_ISSUER"],
      [401, "INTERNAL_TOKEN_MISSING"],
      [401, "USER_CONTEXT_INVALID"],
      [401, "USER_CONTEXT_REQUIRED"],
      [401, "SUBJECT_REQUIRED"],
      [401, "TOKEN_EXPIRED"],
      [403, "ACTOR_NOT_ALLOWED"],
      [403, "CALLER_NOT_ALLOWED"],
    ] as const) {
      h.fake.override("learningPlan", "GET", "/internal/v1/me/plan/today", () => domainError(status, code));
      const res = await get("/v1/plan/today", s);
      expect(res.statusCode, code).toBe(503);
      expect(res.json(), code).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "learning-plan" } });
      expect(res.body).not.toContain(code);
    }
    const lines = h.logs.parsed().filter((l) => l.msg === "domain unavailable");
    expect(lines.map((l) => l.upstream_code)).toContain("USER_CONTEXT_INVALID");
  });

  it("401 о коде родителя (PIN_INVALID, RESET_CODE_INVALID, BIOMETRIC_INVALID) — ответ пользователю, проходит как есть", async () => {
    const s = await login(h);
    h.fake.enablePin(s.userId, "4826");
    const wrong = await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(s.access), payload: { pin: "1111", current_pin: "0000" } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: "PIN_INVALID", details: { remaining: 4 } });
    const reset = await h.app.inject({
      method: "POST",
      url: "/v1/profile/security/pin/reset-confirm",
      headers: bearer(s.access),
      payload: { code: "000000", new_pin: "1357" },
    });
    expect(reset.statusCode).toBe(401);
    expect(reset.json().code).toBe("RESET_CODE_INVALID");
    const bio = await h.app.inject({ method: "POST", url: "/v1/session/biometric/verify", headers: bearer(s.access), payload: { biometric_token: "bio_x" } });
    expect(bio.json().code).toBe("BIOMETRIC_INVALID");
  });
});

describe("«Что нового» — язык аккаунта (ревью T-6)", () => {
  it("смена языка в детском профиле: «Что нового» родителя приходит на новом языке, хотя ui_lang его плана прежний", async () => {
    const parent = await login(h, TG_OTHER); // language_code uz → locale uz
    h.fake.setAge(parent.userId, "18+");
    h.fake.account(parent.userId).summary.locale = "ru";
    const childId = h.fake.addChild(parent.userId);
    h.fake.onboard(parent.userId, { ui_lang: "ru" });
    h.fake.onboard(childId, { ui_lang: "ru" });
    const child = await switchTo(h, parent, childId);
    const patched = await h.app.inject({ method: "PATCH", url: "/v1/profile/settings", headers: bearer(child.access), payload: { locale: "uz" } });
    expect(patched.statusCode).toBe(200);
    const back = await switchTo(h, child, parent.userId);
    h.fake.calls.length = 0;
    await get("/v1/whats-new", back);
    await get("/v1/news", back);
    expect(h.fake.callsTo("experience", "GET", "/internal/v1/release-notes/for-me")[0]!.query.lang).toBe("uz");
    expect(h.fake.callsTo("experience", "GET", "/internal/v1/release-notes/feed")[0]!.query.lang).toBe("uz");
  });
});

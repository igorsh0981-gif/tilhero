/**
 * Профиль, настройки уведомлений, возраст, согласия и политика, удаление; общие свойства API (покрытие контракта,
 * проброс ошибок доменов в ErrorBody, CORS, OpenAPI, health).
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { ProfileSchema } from "../src/schemas.js";
import { deriveSeed } from "@tilhero/ts-common";
import {
  INTERNAL_SECRET,
  ORIGIN,
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
} from "./helpers.js";

let h: Harness;
let s: LoggedIn;
beforeEach(async () => {
  h = await makeHarness();
  s = await login(h);
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const auth = () => bearer(s.access);
const get = (url: string, headers: Record<string, string> = auth()) => h.app.inject({ url, headers });
const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = auth()) =>
  h.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("contract coverage", () => {
  it("every endpoint documented in packages/contracts/src/bff.ts is routed", () => {
    const src = readFileSync(new URL("../../../packages/contracts/src/bff.ts", import.meta.url), "utf8");
    const found = new Set<string>();
    for (const m of src.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[A-Za-z0-9_\-/{}]+)/g)) {
      found.add(`${m[1]} ${m[2]!.replace(/\{(\w+)\}/g, ":$1")}`);
    }
    // «accept | /decline» в одном комментарии: decline-маршруты — отдельно
    found.add("POST /v1/guardian-consents/:token/decline");
    found.add("POST /v1/invites/:invite_id/decline");
    expect(found.size).toBeGreaterThanOrEqual(40);
    const missing = [...found].filter((e) => {
      const [method, url] = e.split(" ") as [string, string];
      return !h.app.hasRoute({ method: method as "GET", url });
    });
    expect(missing).toEqual([]);
  });

  it("туристических маршрутов нет", () => {
    for (const [method, url] of [
      ["GET", "/v1/home"],
      ["GET", "/v1/events"],
      ["GET", "/v1/events/:eventId/offers"],
      ["GET", "/v1/watches"],
      ["POST", "/v1/ai/conversations"],
      ["GET", "/v1/directory/airports"],
      ["PATCH", "/v1/profile/preferences"],
      ["POST", "/v1/profile/disable"],
    ] as const) {
      expect(h.app.hasRoute({ method, url }), url).toBe(false);
    }
  });
});

describe("GET /v1/profile", () => {
  it("аккаунт + активный ученик + ученики (онбординг из learning-plan) + уведомления; identity от имени аккаунта", async () => {
    h.fake.setAge(s.userId, "18+");
    const child = h.fake.addChild(s.userId, "Мадина", "6-9");
    h.fake.onboard(child);
    h.fake.calls.length = 0;
    const res = await get("/v1/profile");
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(Value.Check(ProfileSchema, p)).toBe(true);
    expect(p.account).toMatchObject({ user_id: s.userId, age_band: "18+", guardian_consent: "not_required" });
    expect(p.learner).toMatchObject({ learner_id: s.userId, kind: "self", is_active: true, onboarding_completed: false });
    expect(p.learners.map((l: { kind: string; onboarding_completed: boolean }) => [l.kind, l.onboarding_completed])).toEqual([
      ["self", false],
      ["child", true],
    ]);
    expect(p.notifications).toEqual({
      enabled: true,
      categories: { reminders: false, missed: false, social: false, support: true, product: false },
      quiet_hours: { start: "22:00", end: "08:00" },
      timezone: "Asia/Tashkent",
    });
    expect(h.fake.callsTo("identity").map((c) => c.subject)).toEqual([s.userId]);
    expect(h.fake.callsTo("learningPlan").map((c) => c.subject).sort()).toEqual([s.userId, child].sort());
  });

  it("в детском профиле: learner — ребёнок, уведомления — ребёнка (identity /me/learners/{id})", async () => {
    h.fake.setAge(s.userId, "18+");
    const child = h.fake.addChild(s.userId, "Мадина", "10-13");
    h.fake.children.get(child)!.settings.categories.reminders = true;
    const c = await switchTo(h, s, child);
    const p = (await get("/v1/profile", bearer(c.access))).json();
    expect(p.learner).toMatchObject({ learner_id: child, kind: "child", is_active: true, age_band: "10-13" });
    expect(p.account.user_id).toBe(s.userId);
    expect(p.notifications.categories.reminders).toBe(true);
    // identity ещё не отдаёт настройки ребёнка — показываются настройки аккаунта (обход до доработки identity)
    h.fake.childSettingsInDetail = false;
    const p2 = (await get("/v1/profile", bearer(c.access))).json();
    expect(p2.notifications.categories.reminders).toBe(false);
  });

  it("сбой любого домена → его ошибка, частичного профиля нет", async () => {
    h.fake.down.add("learningPlan");
    const res = await get("/v1/profile");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "learning-plan" } });
  });
});

describe("PATCH /v1/profile/settings", () => {
  it("язык и уведомления по категориям, тихие часы → identity /me/settings от имени аккаунта → Profile (AT-13)", async () => {
    const res = await send("PATCH", "/v1/profile/settings", {
      locale: "uz",
      notifications: { categories: { reminders: true, missed: true }, quiet_hours: { start: "21:30", end: "07:00" }, timezone: "Asia/Samarkand" },
    });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.account.locale).toBe("uz");
    expect(p.notifications).toEqual({
      enabled: true,
      categories: { reminders: true, missed: true, social: false, support: true, product: false },
      quiet_hours: { start: "21:30", end: "07:00" },
      timezone: "Asia/Samarkand",
    });
    const call = h.fake.callsTo("identity", "PATCH", "/internal/v1/me/settings")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.body).toEqual({
      locale: "uz",
      notifications: { categories: { reminders: true, missed: true }, quiet_hours: { start: "21:30", end: "07:00" }, timezone: "Asia/Samarkand" },
    });
    // тихие часы можно выключить
    expect((await send("PATCH", "/v1/profile/settings", { notifications: { quiet_hours: null } })).json().notifications.quiet_hours).toBeNull();
  });

  it("422: QUIET_HOURS_INVALID (BFF и домен), неизвестная категория, display_name у аккаунта, язык не ru/uz", async () => {
    for (const qh of [{ start: "25:00", end: "08:00" }, { start: "22:00" }, { start: "22:00", end: "8:00" }]) {
      const res = await send("PATCH", "/v1/profile/settings", { notifications: { quiet_hours: qh } });
      expect(res.statusCode, JSON.stringify(qh)).toBe(422);
      expect(res.json().code).toBe("QUIET_HOURS_INVALID");
    }
    const same = await send("PATCH", "/v1/profile/settings", { notifications: { quiet_hours: { start: "22:00", end: "22:00" } } });
    expect(same.json().code).toBe("QUIET_HOURS_INVALID"); // от identity
    expect((await send("PATCH", "/v1/profile/settings", { notifications: { categories: { ads: true } } })).json().code).toBe("VALIDATION_ERROR");
    expect((await send("PATCH", "/v1/profile/settings", { locale: "en" })).statusCode).toBe(422);
    const dn = await send("PATCH", "/v1/profile/settings", { display_name: "Новое имя" });
    expect(dn.statusCode).toBe(422);
    expect(dn.json().details.field).toBe("display_name");
    expect(h.fake.callsTo("identity", "PATCH")).toHaveLength(1);
  });

  it("детский профиль: имя и уведомления → /me/learners/{id} (адресат — родитель), язык — аккаунту", async () => {
    h.fake.setAge(s.userId, "18+");
    const child = h.fake.addChild(s.userId, "Мадина", "6-9");
    const c = await switchTo(h, s, child);
    const res = await send("PATCH", "/v1/profile/settings", { display_name: "Мадинахон", locale: "uz", notifications: { categories: { reminders: true } } }, bearer(c.access));
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.learner.display_name).toBe("Мадинахон");
    expect(p.notifications.categories.reminders).toBe(true);
    expect(p.account.locale).toBe("uz");
    expect(h.fake.account(s.userId).settings.categories.reminders).toBe(false); // настройки аккаунта не тронуты
    const patch = h.fake.callsTo("identity", "PATCH", `/internal/v1/me/learners/${child}`)[0]!;
    expect(patch.subject).toBe(s.userId);
    expect(patch.body).toEqual({ display_name: "Мадинахон", settings: { categories: { reminders: true } } });
    expect(h.fake.callsTo("identity", "PATCH", "/internal/v1/me/settings")[0]!.body).toEqual({ locale: "uz" });
    // ошибка ребёнка → язык аккаунта не меняется
    const bad = await send("PATCH", "/v1/profile/settings", { locale: "ru", notifications: { timezone: "Mars/Base" } }, bearer(c.access));
    expect(bad.statusCode).toBe(422);
    expect(h.fake.account(s.userId).summary.locale).toBe("uz");
  });
});

describe("PUT /v1/profile/age", () => {
  it("14-17 → guardian_consent pending; повтор → 409 AGE_ALREADY_SET; 6-13 у аккаунта → 422", async () => {
    const res = await send("PUT", "/v1/profile/age", { age_band: "14-17" });
    expect(res.statusCode).toBe(200);
    expect(res.json().account).toMatchObject({ age_band: "14-17", guardian_consent: "pending" });
    expect(res.json().learner.age_band).toBe("14-17");
    const again = await send("PUT", "/v1/profile/age", { age_band: "18+" });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("AGE_ALREADY_SET");
    for (const band of ["6-9", "10-13", "21", null]) expect((await send("PUT", "/v1/profile/age", { age_band: band })).statusCode).toBe(422);
    expect(h.fake.callsTo("identity", "PUT", "/internal/v1/me/age").map((c) => c.subject)).toEqual([s.userId, s.userId]);
  });
});

describe("согласия и политика (AT-02)", () => {
  it("политика публична (ru/uz, кэш 5 мин), lang только ru|uz", async () => {
    const res = await h.app.inject({ url: "/v1/legal/policy?lang=uz" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(res.json().text).toBe("# Policy uz");
    expect(h.fake.callsTo("identity", "GET", "/internal/v1/legal/policy")[0]?.subject).toBeUndefined();
    expect((await h.app.inject({ url: "/v1/legal/policy?lang=en" })).statusCode).toBe(422);
  });

  it("версия и цели фиксируются; обязательные отсутствуют → 422 CONSENT_REQUIRED_PURPOSES {missing}; отзыв", async () => {
    const ok = await send("POST", "/v1/profile/consent", { policy_version: "2026-11-18", purposes: ["terms", "privacy", "learning"] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      accepted: true,
      policy_version: "2026-11-18",
      current_policy_version: "2026-11-18",
      accepted_at: "2026-11-18T10:00:00Z",
      evidence_hash: "sha256:abc",
      purposes: ["terms", "privacy", "learning"],
    });
    const missing = await send("POST", "/v1/profile/consent", { policy_version: "2026-11-18", purposes: ["terms"] });
    expect(missing.json()).toMatchObject({ code: "CONSENT_REQUIRED_PURPOSES", details: { missing: ["privacy", "learning"] } });
    expect((await send("POST", "/v1/profile/consent", { policy_version: "2026-01-01", purposes: ["terms", "privacy", "learning"] })).json().code).toBe(
      "POLICY_VERSION_OUTDATED",
    );
    expect((await send("POST", "/v1/profile/consent", { policy_version: "2026-11-18", purposes: ["Terms!"] })).statusCode).toBe(422);
    expect((await send("POST", "/v1/profile/consent", { policy_version: "2026-11-18", purposes: [], age_confirmed_18_plus: true })).statusCode).toBe(422);
    const revoked = await send("DELETE", "/v1/profile/consent");
    expect(revoked.json()).toMatchObject({ accepted: false, purposes: [] });
  });

  it("подросток без согласия родителя: необязательные цели → 403 GUARDIAN_CONSENT_REQUIRED; без них — можно (голос не блокирует)", async () => {
    h.fake.setAge(s.userId, "14-17");
    const opt = await send("POST", "/v1/profile/consent", { policy_version: "2026-11-18", purposes: ["terms", "privacy", "learning", "voice_recording"] });
    expect(opt.statusCode).toBe(403);
    expect(opt.json().code).toBe("GUARDIAN_CONSENT_REQUIRED");
    expect((await send("POST", "/v1/profile/consent", { policy_version: "2026-11-18", purposes: ["terms", "privacy", "learning"] })).statusCode).toBe(200);
  });
});

describe("POST /v1/profile/delete-request (AT-14)", () => {
  it("202 {request_id, status, domains, learners} — аккаунт и дети; все сессии отозваны; повторный вход → 410", async () => {
    h.fake.setAge(s.userId, "18+");
    h.fake.addChild(s.userId);
    h.fake.addChild(s.userId, "Тимур", "10-13");
    const other = await login(h);
    const res = await send("POST", "/v1/profile/delete-request", { confirm_word: "OʻCHIRISH" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      request_id: expect.any(String),
      status: "REQUESTED",
      domains: ["learning-plan", "social", "notifications", "support", "experience-config"],
      learners: 3,
    });
    for (const x of [s, other]) expect((await get("/v1/profile", bearer(x.access))).json().code).toBe("SESSION_REVOKED");
    const again = await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: initDataFor() } });
    expect(again.json().code).toBe("USER_DELETED");
    expect(h.fake.callsTo("identity", "POST", "/internal/v1/me/deletion-request")[0]?.subject).toBe(s.userId);
  });

  it("без слова → ошибка домена, сессии живы; с кодом родителя — нужен pin; из детского профиля → 403 ADULT_REQUIRED", async () => {
    const bad = await send("POST", "/v1/profile/delete-request", { confirm_word: "удалить?" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe("CONFIRM_WORD_REQUIRED");
    expect((await get("/v1/profile")).statusCode).toBe(200);

    h.fake.setAge(s.userId, "18+");
    const child = h.fake.addChild(s.userId);
    const c = await switchTo(h, s, child);
    const fromChild = await send("POST", "/v1/profile/delete-request", { confirm_word: "УДАЛИТЬ" }, bearer(c.access));
    expect(fromChild.statusCode).toBe(403);
    expect(fromChild.json().code).toBe("ADULT_REQUIRED");
    expect(h.fake.callsTo("identity", "POST", "/internal/v1/me/deletion-request")).toHaveLength(1);

    const back = await switchTo(h, c, s.userId);
    await send("PUT", "/v1/profile/security/pin", { pin: "4826" }, bearer(back.access));
    const wrong = await send("POST", "/v1/profile/delete-request", { pin: "1111" }, bearer(back.access));
    expect(wrong.json()).toMatchObject({ code: "PIN_INVALID", details: { remaining: 4 } });
  });
});

describe("код родителя и биометрия в детском профиле", () => {
  it("установка/снятие кода, сброс, биометрия → 403 ADULT_REQUIRED, identity не вызывается", async () => {
    h.fake.setAge(s.userId, "18+");
    const c = await switchTo(h, s, h.fake.addChild(s.userId));
    const probes: Array<["PUT" | "DELETE" | "POST", string, object | undefined]> = [
      ["PUT", "/v1/profile/security/pin", { pin: "4826" }],
      ["DELETE", "/v1/profile/security/pin", { current_pin: "4826" }],
      ["POST", "/v1/profile/security/pin/reset-request", undefined],
      ["POST", "/v1/profile/security/pin/reset-confirm", { code: "246810", new_pin: "4826" }],
      ["PUT", "/v1/profile/security/biometric", undefined],
      ["DELETE", "/v1/profile/security/biometric", undefined],
    ];
    for (const [method, url, payload] of probes) {
      const res = await send(method, url, payload, bearer(c.access));
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code, url).toBe("ADULT_REQUIRED");
    }
    expect(h.fake.callsTo("identity").filter((x) => x.path.includes("/pin") || x.path.includes("/biometric"))).toHaveLength(0);
  });

  it("DELETE PIN, PUT/DELETE биометрии в профиле аккаунта", async () => {
    expect((await send("PUT", "/v1/profile/security/biometric")).json().code).toBe("PIN_REQUIRED");
    await send("PUT", "/v1/profile/security/pin", { pin: "4826" });
    const bio = await send("PUT", "/v1/profile/security/biometric");
    expect(bio.json()).toMatchObject({ biometric_token: expect.stringMatching(/^bio_/), security: { biometric_enabled: true, pin_required: false } });
    expect((await send("DELETE", "/v1/profile/security/biometric")).json().biometric_enabled).toBe(false);
    expect((await send("DELETE", "/v1/profile/security/pin", { current_pin: "0000" })).json().code).toBe("PIN_INVALID");
    expect((await send("DELETE", "/v1/profile/security/pin", { current_pin: "4826" })).json()).toMatchObject({ pin_enabled: false });
  });
});

describe("upstream errors", () => {
  it("domain 4xx is passed through with code/status/details and BFF trace_id (ErrorBody)", async () => {
    h.fake.override("support", "GET", "/internal/v1/support/categories", () => domainError(429, "SUPPORT_RATE_LIMITED", { retry_after: 30 }));
    const res = await get("/v1/support/categories");
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.json()).toEqual({
      code: "SUPPORT_RATE_LIMITED",
      message: "domain says SUPPORT_RATE_LIMITED",
      trace_id: res.headers["x-trace-id"],
      details: { retry_after: 30 },
    });
  });

  it("domain 5xx, HTML error page, internal-auth failure, broken JSON → 503 UPSTREAM_UNAVAILABLE {service}", async () => {
    const responses = [
      () => domainError(500, "INTERNAL_ERROR"),
      () => new Response("<html>Bad gateway</html>", { status: 502 }),
      () => domainError(401, "INTERNAL_TOKEN_INVALID"),
      () => domainError(403, "CALLER_NOT_ALLOWED", { caller: "telegram-bff" }),
      () => new Response("{not json", { status: 200 }),
    ];
    for (const r of responses) {
      h.fake.override("learningPlan", "GET", "/internal/v1/directory/goals", r);
      const res = await get("/v1/directory/goals");
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "learning-plan" } });
    }
  });

  it("unexpected failure inside BFF → 500 INTERNAL_ERROR without stack trace", async () => {
    h.fake.override("identity", "GET", "/internal/v1/me", () => json(200, null));
    const res = await get("/v1/profile");
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: "INTERNAL_ERROR", message: "Внутренняя ошибка сервиса", trace_id: expect.any(String), details: {} });
    expect(res.body).not.toMatch(/at \w+ \(|TypeError|\.ts:\d+/);
  });

  it("malformed JSON → 400 INVALID_JSON without echoing the body", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/session/telegram",
      headers: { "content-type": "application/json" },
      payload: '{"init_data": "query_id=SECRET-FRAGMENT',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_JSON");
    expect(res.body).not.toContain("SECRET-FRAGMENT");
  });
});

describe("experience config, CORS, OpenAPI, health", () => {
  it("config is public and cached in memory; experience-config outage → stale config; nothing cached → 503", async () => {
    const first = await h.app.inject({ url: "/v1/experience/config" });
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("public, max-age=60");
    expect(first.json()).toMatchObject({ app: "miniapp", theme: { id: "notebook" }, home: { sections: [{ type: "today_plan" }, { type: "whats_new" }] } });
    await h.app.inject({ url: "/v1/experience/config" });
    expect(h.fake.callsTo("experience", "GET", "/internal/v1/experience/miniapp/current")).toHaveLength(1);

    const cold = await makeHarness({ EXPERIENCE_CACHE_SECONDS: "0" });
    try {
      await cold.app.inject({ url: "/v1/experience/config" });
      cold.fake.down.add("experience");
      expect((await cold.app.inject({ url: "/v1/experience/config" })).json().version).toBe("1.0.0");
      expect(cold.logs.text).toContain("serving stale config");
    } finally {
      await cold.close();
    }
    const empty = await makeHarness();
    try {
      empty.fake.down.add("experience");
      expect((await empty.app.inject({ url: "/v1/experience/config" })).statusCode).toBe(503);
    } finally {
      await empty.close();
    }
  });

  it("CORS allows only MINIAPP_ORIGIN (idempotency-key и if-match разрешены)", async () => {
    const pre = await h.app.inject({
      method: "OPTIONS",
      url: "/v1/plan",
      headers: { origin: ORIGIN, "access-control-request-method": "PATCH", "access-control-request-headers": "authorization,content-type,idempotency-key,if-match" },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(String(pre.headers["access-control-allow-headers"])).toContain("idempotency-key");
    expect(String(pre.headers["access-control-allow-headers"])).toContain("if-match");
    expect(pre.headers["access-control-allow-credentials"]).toBeUndefined();
    const evil = await h.app.inject({ method: "OPTIONS", url: "/v1/plan", headers: { origin: "https://evil.example", "access-control-request-method": "PATCH" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("GET /openapi.json outside production lists the contract paths", async () => {
    const res = await h.app.inject({ url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe("3.1.0");
    for (const p of ["/v1/session/telegram", "/v1/session/learner", "/v1/profile", "/v1/plan", "/v1/invites/{invite_id}/accept", "/v1/whats-new", "/v1/guardian-consents/{token}"]) {
      expect(doc.paths[p], p).toBeDefined();
    }
    expect(doc.paths["/health/ready"]).toBeUndefined();
  });

  it("no /openapi.json in production; health endpoints work", async () => {
    const prod = await makeHarness({
      NODE_ENV: "production",
      INTERNAL_JWT_PRIVATE_KEY: deriveSeed(INTERNAL_SECRET, "telegram-bff").toString("base64url"),
    });
    try {
      expect((await prod.app.inject({ url: "/openapi.json" })).statusCode).toBe(404);
      const ready = await prod.app.inject({ url: "/health/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: "ok", checks: { redis: "ok" } });
      expect((await prod.app.inject({ url: "/health/live" })).statusCode).toBe(200);
    } finally {
      await prod.close();
    }
  });

  it("каждый маршрут /v1 объявляет схему ответа 2xx (иначе приложение не стартует)", async () => {
    const doc = (await h.app.inject({ url: "/openapi.json" })).json();
    for (const [path, ops] of Object.entries(doc.paths as Record<string, Record<string, { responses: Record<string, unknown> }>>)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(Object.keys(op.responses).some((c) => /^2\d\d$/.test(c)), `${method} ${path}`).toBe(true);
      }
    }
    expect(randomUUID()).toBeTruthy();
  });
});

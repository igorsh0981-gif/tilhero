import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "../src/tokens.js";
import {
  BOT_TOKEN,
  SESSION_SECRET,
  TG_USER,
  bearer,
  closeRedis,
  initDataFor,
  login,
  makeHarness,
  testRedis,
  type Harness,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method: "POST", url, ...(payload !== undefined ? { payload: payload as object } : {}), headers });

describe("POST /v1/session/telegram", () => {
  it("genuine initData → SessionResponse, identity called with Telegram snapshot, no internal fields leak", async () => {
    const res = await post("/v1/session/telegram", { init_data: initDataFor() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["access_token", "consent", "expires_in", "onboarding_completed", "refresh_token", "security", "user"].sort(),
    );
    expect(body.expires_in).toBe(900);
    expect(body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.user).toEqual({
      user_id: expect.any(String),
      display_name: "Игорь",
      username: "test_user_1",
      locale: "ru",
      status: "ACTIVE",
      is_new: true,
    });
    expect(body.user.telegram_user_id).toBeUndefined();
    expect(body.security.pin_required).toBe(false);
    expect(body.onboarding_completed).toBe(false);

    const [call] = h.fake.callsTo("identity", "POST", "/internal/v1/users/telegram-login");
    expect(call?.body).toEqual({ telegram_user_id: 900001, first_name: "Игорь", username: "test_user_1", language_code: "ru" });
    expect(call?.subject).toBeUndefined();
    const prefCall = h.fake.callsTo("preferences", "GET", "/internal/v1/me/preferences")[0];
    expect(prefCall?.subject).toBe(body.user.user_id);
    // trace id проброшен в домены
    expect(call?.headers["x-trace-id"]).toBe(res.headers["x-trace-id"]);

    // access-токен рабочий
    const me = await h.app.inject({ url: "/v1/profile", headers: bearer(body.access_token) });
    expect(me.statusCode).toBe(200);
  });

  it("onboarding_completed comes from preferences", async () => {
    const first = await login(h);
    await h.app.inject({ method: "POST", url: "/v1/profile/onboarding/complete", headers: bearer(first.access) });
    const second = await login(h);
    expect(second.body.onboarding_completed).toBe(true);
    expect(second.body.user.is_new).toBe(false);
  });

  it("tampered hash / modified field / expired / no user / foreign token → 401 INIT_DATA_* (AT-18)", async () => {
    const good = initDataFor();
    const tamperedHash = new URLSearchParams(good);
    tamperedHash.set("hash", "0".repeat(64));
    const modified = new URLSearchParams(good);
    modified.set("user", JSON.stringify({ ...TG_USER, id: 1 }));
    const cases: Array<[string, string, string]> = [
      ["hash", tamperedHash.toString(), "INIT_DATA_INVALID"],
      ["field", modified.toString(), "INIT_DATA_INVALID"],
      ["expired", initDataFor(TG_USER, { authDate: Math.floor(Date.now() / 1000) - 3700 }), "INIT_DATA_EXPIRED"],
      ["future", initDataFor(TG_USER, { authDate: Math.floor(Date.now() / 1000) + 600 }), "INIT_DATA_INVALID"],
      ["no user", initDataFor(null), "INIT_DATA_INVALID"],
      ["foreign bot", initDataFor(TG_USER, { token: "1:" + BOT_TOKEN.slice(2) }), "INIT_DATA_INVALID"],
      ["garbage", "%%%not-init-data", "INIT_DATA_INVALID"],
    ];
    for (const [name, initData, code] of cases) {
      const res = await post("/v1/session/telegram", { init_data: initData });
      expect(res.statusCode, name).toBe(401);
      const b = res.json();
      expect(b.code, name).toBe(code);
      expect(b.trace_id).toBeTruthy();
      expect(JSON.stringify(b)).not.toContain(initData.slice(0, 40));
    }
    expect(h.fake.callsTo("identity")).toHaveLength(0);
  });

  it("422 on missing init_data or extra fields", async () => {
    expect((await post("/v1/session/telegram", {})).json().code).toBe("VALIDATION_ERROR");
    const extra = await post("/v1/session/telegram", { init_data: initDataFor(), user_id: "x" });
    expect(extra.statusCode).toBe(422);
    expect(extra.json().details.field).toBe("user_id");
  });

  it("user who requested deletion → 410 USER_DELETED, no session issued", async () => {
    const s = await login(h);
    h.fake.user(s.userId).summary.status = "DELETION_REQUESTED";
    const res = await post("/v1/session/telegram", { init_data: initDataFor() });
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe("USER_DELETED");
  });

  it("identity errors are passed through as is; outage → 503 UPSTREAM_UNAVAILABLE", async () => {
    h.fake.override("identity", "POST", "/internal/v1/users/telegram-login", () =>
      new Response(JSON.stringify({ code: "USER_BLOCKED", message: "blocked", trace_id: "t", details: { reason: "abuse" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    const blocked = await post("/v1/session/telegram", { init_data: initDataFor() });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "USER_BLOCKED", details: { reason: "abuse" } });

    h.fake.down.add("identity");
    const down = await post("/v1/session/telegram", { init_data: initDataFor() });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "identity-consent" } });
  });
});

describe("access token", () => {
  it("401 without token, with garbage, with foreign signature, expired", async () => {
    const s = await login(h);
    expect((await h.app.inject({ url: "/v1/profile" })).json().code).toBe("UNAUTHORIZED");
    expect((await h.app.inject({ url: "/v1/profile", headers: { authorization: "Bearer nope" } })).json().code).toBe("TOKEN_INVALID");
    expect((await h.app.inject({ url: "/v1/profile", headers: { authorization: `Basic ${s.access}` } })).json().code).toBe("TOKEN_INVALID");

    const forged = await new SignJWT({ sid: "x", pin: true })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ACCESS_ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setSubject(s.userId)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode("another-secret-" + "q".repeat(32)));
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(forged) })).json().code).toBe("TOKEN_INVALID");

    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ sid: "x", pin: true })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ACCESS_ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setSubject(s.userId)
      .setIssuedAt(now - 1000)
      .setExpirationTime(now - 100)
      .sign(new TextEncoder().encode(SESSION_SECRET));
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(expired) })).json().code).toBe("TOKEN_EXPIRED");
  });

  it("a valid JWT for an unknown/revoked sid is rejected with SESSION_REVOKED", async () => {
    const s = await login(h);
    const ghost = await new SignJWT({ sid: "00000000-0000-0000-0000-000000000000", pin: true })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ACCESS_ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setSubject(s.userId)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(SESSION_SECRET));
    const res = await h.app.inject({ url: "/v1/profile", headers: bearer(ghost) });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SESSION_REVOKED");
  });
});

describe("refresh rotation and reuse detection", () => {
  it("rotates on every use; reuse of a used token revokes the whole session", async () => {
    const s = await login(h);
    const r1 = await post("/v1/session/refresh", { refresh_token: s.refresh });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.refresh_token).not.toBe(s.refresh);
    expect(b1.user.user_id).toBe(s.userId);
    expect(b1.onboarding_completed).toBe(false);

    const r2 = await post("/v1/session/refresh", { refresh_token: b1.refresh_token });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json();

    // повтор уже использованного токена (кража) → 401 и отзыв всей сессии
    const replay = await post("/v1/session/refresh", { refresh_token: s.refresh });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe("REFRESH_INVALID");
    // актуальный токен этой сессии тоже больше не работает, access — тоже
    expect((await post("/v1/session/refresh", { refresh_token: b2.refresh_token })).json().code).toBe("REFRESH_INVALID");
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(b2.access_token) })).json().code).toBe("SESSION_REVOKED");
    expect(h.logs.text).toContain("refresh_token_reuse");
  });

  it("unknown / malformed refresh token → 401 REFRESH_INVALID", async () => {
    for (const t of ["x", "A".repeat(43), "../../etc"]) {
      const res = await post("/v1/session/refresh", { refresh_token: t });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("REFRESH_INVALID");
    }
  });

  it("domain outage during refresh does not burn the refresh token", async () => {
    const s = await login(h);
    h.fake.down.add("identity");
    expect((await post("/v1/session/refresh", { refresh_token: s.refresh })).statusCode).toBe(503);
    h.fake.down.delete("identity");
    expect((await post("/v1/session/refresh", { refresh_token: s.refresh })).statusCode).toBe(200);
  });

  it("refresh token is stored only as sha256 hash with TTL", async () => {
    const s = await login(h);
    const redis = testRedis();
    const keys = await redis.keys(`${h.config.redisKeyPrefix}*`);
    expect(keys.some((k) => k.includes(s.refresh))).toBe(false);
    const rt = keys.find((k) => k.includes(":rt:"))!;
    expect(rt).toMatch(/:rt:[0-9a-f]{64}$/);
    const ttl = await redis.ttl(rt);
    expect(ttl).toBeGreaterThan(43_000);
    expect(ttl).toBeLessThanOrEqual(43_200);
    expect(await redis.get(rt)).not.toContain(s.refresh);
  });

  it("logout revokes refresh and access immediately (204)", async () => {
    const s = await login(h);
    const out = await post("/v1/session/logout", undefined, bearer(s.access));
    expect(out.statusCode).toBe(204);
    expect(out.body).toBe("");
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(s.access) })).json().code).toBe("SESSION_REVOKED");
    expect((await post("/v1/session/refresh", { refresh_token: s.refresh })).json().code).toBe("REFRESH_INVALID");
  });

  it("logout with content-type json and empty body is accepted", async () => {
    const s = await login(h);
    const out = await h.app.inject({
      method: "POST",
      url: "/v1/session/logout",
      headers: { ...bearer(s.access), "content-type": "application/json" },
      payload: "",
    });
    expect(out.statusCode).toBe(204);
  });
});

describe("PIN gate", () => {
  async function pinUser(): Promise<{ access: string; refresh: string; userId: string }> {
    const first = await login(h);
    h.fake.enablePin(first.userId, "4826");
    const s = await login(h);
    expect(s.body.security).toMatchObject({ pin_enabled: true, pin_required: true });
    return s;
  }

  it("pin_required session: only /v1/session/*, pin reset, policy and config are allowed", async () => {
    const s = await pinUser();
    const blocked = ["/v1/profile", "/v1/home", "/v1/support/tickets", "/v1/directory/airports?q=tas", "/v1/support/categories"];
    for (const url of blocked) {
      const res = await h.app.inject({ url, headers: bearer(s.access) });
      expect(res.statusCode, url).toBe(423);
      expect(res.json().code, url).toBe("PIN_REQUIRED");
    }
    const patch = await h.app.inject({ method: "PATCH", url: "/v1/profile/preferences", headers: bearer(s.access), payload: { strong_events_outside_geo: true } });
    expect(patch.statusCode).toBe(423);
    const del = await h.app.inject({ method: "POST", url: "/v1/profile/delete-request", headers: bearer(s.access), payload: { confirm_word: "DELETE" } });
    expect(del.statusCode).toBe(423);
    expect(h.fake.callsTo("preferences", "PATCH")).toHaveLength(0);
    expect(h.fake.callsTo("identity", "POST", "/internal/v1/me/deletion-request")).toHaveLength(0);

    expect((await h.app.inject({ url: "/v1/experience/config", headers: bearer(s.access) })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/v1/legal/policy?lang=en" })).statusCode).toBe(200);
    expect((await post("/v1/profile/security/pin/reset-request", undefined, bearer(s.access))).json()).toEqual({ expires_in: 600 });
    // refresh не снимает ограничение
    const r = await post("/v1/session/refresh", { refresh_token: s.refresh });
    expect(r.json().security.pin_required).toBe(true);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(r.json().access_token) })).statusCode).toBe(423);
  });

  it("wrong PIN → 401 PIN_INVALID {remaining} (domain), correct PIN → new tokens with pin=true", async () => {
    const s = await pinUser();
    const bad = await post("/v1/session/pin/verify", { pin: "0000" }, bearer(s.access));
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ code: "PIN_INVALID", details: { remaining: 4 } });

    const ok = await post("/v1/session/pin/verify", { pin: "4826" }, bearer(s.access));
    expect(ok.statusCode).toBe(200);
    const b = ok.json();
    expect(b.security.pin_required).toBe(false);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(b.access_token) })).statusCode).toBe(200);
    // прежний refresh (pin=false) заменён
    expect((await post("/v1/session/refresh", { refresh_token: s.refresh })).json().code).toBe("REFRESH_INVALID");
    // новый refresh сохраняет подтверждение
    const r = await post("/v1/session/refresh", { refresh_token: b.refresh_token });
    expect(r.json().security.pin_required).toBe(false);
    const call = h.fake.callsTo("identity", "POST", "/internal/v1/me/pin/verify")[0];
    expect(call?.subject).toBe(s.userId);
  });

  it("biometric verify unlocks the session; wrong token → 401 BIOMETRIC_INVALID", async () => {
    const s0 = await login(h);
    h.fake.enablePin(s0.userId, "4826");
    const bio = await h.app.inject({ method: "PUT", url: "/v1/profile/security/biometric", headers: bearer(s0.access) });
    expect(bio.statusCode).toBe(200);
    const token = bio.json().biometric_token as string;
    const s = await login(h);
    expect((await post("/v1/session/biometric/verify", { biometric_token: "bio_wrong" }, bearer(s.access))).json().code).toBe("BIOMETRIC_INVALID");
    const ok = await post("/v1/session/biometric/verify", { biometric_token: token }, bearer(s.access));
    expect(ok.statusCode).toBe(200);
    expect((await h.app.inject({ url: "/v1/home", headers: bearer(ok.json().access_token) })).statusCode).toBe(200);
  });

  it("PIN reset-confirm (allowed while pin_required) → new session, all old sessions revoked", async () => {
    const other = await login(h); // сессия на «другом устройстве», до включения PIN
    h.fake.enablePin(other.userId, "4826");
    const s = await login(h);
    const bad = await post("/v1/profile/security/pin/reset-confirm", { code: "000000", new_pin: "7391" }, bearer(s.access));
    expect(bad.json()).toMatchObject({ code: "RESET_CODE_INVALID", details: { remaining: 4 } });
    const ok = await post("/v1/profile/security/pin/reset-confirm", { code: "246810", new_pin: "7391" }, bearer(s.access));
    expect(ok.statusCode).toBe(200);
    const b = ok.json();
    expect(b.security.pin_required).toBe(false);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(b.access_token) })).statusCode).toBe(200);
    for (const old of [other, s]) {
      expect((await h.app.inject({ url: "/v1/session/logout", method: "POST", headers: bearer(old.access) })).json().code).toBe("SESSION_REVOKED");
      expect((await post("/v1/session/refresh", { refresh_token: old.refresh })).json().code).toBe("REFRESH_INVALID");
    }
  });

  it("setting/changing PIN revokes all OTHER sessions; the current one stays", async () => {
    const a = await login(h);
    const b = await login(h);
    const set = await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(a.access), payload: { pin: "4826" } });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ pin_enabled: true, pin_length: 4, pin_required: false });
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(a.access) })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(b.access) })).json().code).toBe("SESSION_REVOKED");
    // другое устройство входит заново — и теперь обязано ввести PIN
    const again = await login(h);
    expect(again.body.security.pin_required).toBe(true);

    const wrongCurrent = await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(a.access), payload: { pin: "5937", current_pin: "1111" } });
    expect(wrongCurrent.json()).toMatchObject({ code: "PIN_INVALID", details: { remaining: 4 } });
    const weak = await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(a.access), payload: { pin: "1234", current_pin: "4826" } });
    expect(weak.json().code).toBe("PIN_FORMAT");
  });

  it("delete-request → 202 and every session of the user is revoked", async () => {
    const a = await login(h);
    const b = await login(h);
    const res = await post("/v1/profile/delete-request", { confirm_word: "УДАЛИТЬ" }, bearer(a.access));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "REQUESTED", domains: expect.arrayContaining(["support"]) });
    for (const s of [a, b]) {
      expect((await h.app.inject({ url: "/v1/profile", headers: bearer(s.access) })).json().code).toBe("SESSION_REVOKED");
      expect((await post("/v1/session/refresh", { refresh_token: s.refresh })).json().code).toBe("REFRESH_INVALID");
    }
    // повторный вход → 410
    expect((await post("/v1/session/telegram", { init_data: initDataFor() })).json().code).toBe("USER_DELETED");
  });

  it("sessions of different users are isolated (revoke-all touches only the owner)", async () => {
    const igor = await login(h);
    const other = await login(h, { id: 900777, first_name: "Анна", username: "test_user_2", language_code: "en" });
    expect(other.body.user.locale).toBe("en");
    await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(igor.access), payload: { pin: "4826" } });
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(other.access) })).statusCode).toBe(200);
  });
});

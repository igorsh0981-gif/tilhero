/**
 * Ученики и детские профили, согласие родителя для 14–17 (ссылка, preview, accept/decline), приглашения и семья.
 * identity-consent и social — от имени аккаунта (sub); детский профиль — запреты BFF.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { FamilySchema, InvitePreviewSchema, InviteSchema, LearnerSummarySchema } from "../src/schemas.js";
import {
  APP_LINK,
  TG_OTHER,
  bearer,
  closeRedis,
  idem,
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

const get = (url: string, token = s.access) => h.app.inject({ url, headers: bearer(token) });
const send = (method: "POST" | "DELETE", url: string, payload?: unknown, token = s.access, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, headers: { ...bearer(token), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("ученики (AT-03)", () => {
  it("POST /v1/learners: взрослый создаёт детский профиль 6–13 → 201; GET — сам + дети с онбордингом", async () => {
    h.fake.setAge(s.userId, "18+");
    const res = await send("POST", "/v1/learners", { display_name: "Мадина", age_band: "6-9" });
    expect(res.statusCode).toBe(201);
    const child = res.json();
    expect(Value.Check(LearnerSummarySchema, child)).toBe(true);
    expect(child).toEqual({ learner_id: expect.any(String), kind: "child", display_name: "Мадина", age_band: "6-9", is_active: false, onboarding_completed: false });
    expect(res.body).not.toContain("guardian_user_id");
    const call = h.fake.callsTo("identity", "POST", "/internal/v1/me/learners")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.body).toEqual({ display_name: "Мадина", age_band: "6-9" });

    h.fake.onboard(child.learner_id);
    const list = await get("/v1/learners");
    expect(list.json().items.map((l: { kind: string; is_active: boolean; onboarding_completed: boolean }) => [l.kind, l.is_active, l.onboarding_completed])).toEqual([
      ["self", true, false],
      ["child", false, true],
    ]);
    expect(list.body).not.toContain("telegram_user_id");
  });

  it("Idempotency-Key (необязательный) пробрасывается: повтор — тот же ребёнок", async () => {
    h.fake.setAge(s.userId, "18+");
    const key = idem();
    const a = await send("POST", "/v1/learners", { display_name: "Тимур", age_band: "10-13" }, s.access, key);
    const b = await send("POST", "/v1/learners", { display_name: "Тимур", age_band: "10-13" }, s.access, key);
    expect(b.json().learner_id).toBe(a.json().learner_id);
    expect(h.fake.account(s.userId).children).toHaveLength(1);
    expect((await send("POST", "/v1/learners", { display_name: "Тимур", age_band: "10-13" }, s.access, { "idempotency-key": "nope" })).statusCode).toBe(422);
  });

  it("403 ADULT_REQUIRED (не 18+, детский профиль); 409 CHILDREN_LIMIT; 422 возраст/имя", async () => {
    const notAdult = await send("POST", "/v1/learners", { display_name: "Мадина", age_band: "6-9" });
    expect(notAdult.statusCode).toBe(403);
    expect(notAdult.json().code).toBe("ADULT_REQUIRED");
    h.fake.setAge(s.userId, "18+");
    for (let i = 0; i < 5; i++) h.fake.addChild(s.userId, `Ребёнок ${i}`);
    expect((await send("POST", "/v1/learners", { display_name: "Шестой", age_band: "6-9" })).json().code).toBe("CHILDREN_LIMIT");
    for (const body of [
      { display_name: "Подросток", age_band: "14-17" },
      { display_name: "", age_band: "6-9" },
      { display_name: "   ", age_band: "6-9" },
      { display_name: "x".repeat(41), age_band: "6-9" },
      { display_name: "Мадина" },
    ]) {
      expect((await send("POST", "/v1/learners", body)).statusCode, JSON.stringify(body)).toBe(422);
    }
    const c = await switchTo(h, s, h.fake.account(s.userId).children[0]!);
    const fromChild = await send("POST", "/v1/learners", { display_name: "Ещё", age_band: "6-9" }, c.access);
    expect(fromChild.json().code).toBe("ADULT_REQUIRED");
  });
});

describe("согласие родителя для 14–17 (AT-03)", () => {
  async function teenAndParent() {
    h.fake.setAge(s.userId, "14-17");
    const parent = await login(h, TG_OTHER, "203.0.113.11");
    h.fake.setAge(parent.userId, "18+");
    return parent;
  }

  it("подросток получает ссылку https://t.me/<bot>/<app>?startapp=gc_<token>; родитель открывает (публично) и соглашается", async () => {
    const parent = await teenAndParent();
    const link = await send("POST", "/v1/profile/guardian-consent");
    expect(link.statusCode).toBe(200);
    const { link: url, expires_at } = link.json();
    expect(expires_at).toBe("2026-11-25T10:00:00Z");
    expect(url.startsWith(`${APP_LINK}?startapp=gc_`)).toBe(true);
    const startParam = new URL(url).searchParams.get("startapp")!;
    expect(startParam).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    const token = startParam.slice(3);
    expect(h.fake.callsTo("identity", "POST", "/internal/v1/me/guardian-consent-requests")[0]!.subject).toBe(s.userId);

    const preview = await h.app.inject({ url: `/v1/guardian-consents/${token}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ teen_display_name: "Игорь", status: "pending", expires_at });
    expect(preview.body).not.toContain("teen_user_id");
    expect(h.fake.callsTo("identity", "GET", `/internal/v1/guardian-consents/${token}`)[0]!.subject).toBeUndefined();

    const accept = await send("POST", `/v1/guardian-consents/${token}/accept`, undefined, parent.access);
    expect(accept.statusCode).toBe(200);
    expect(accept.json().status).toBe("granted");
    expect(h.fake.callsTo("identity", "POST", `/internal/v1/guardian-consents/${token}/accept`)[0]!.subject).toBe(parent.userId);
    expect((await get("/v1/profile")).json().account.guardian_consent).toBe("granted");
    // токен — секрет ссылки: в логах его нет
    expect(h.logs.text).not.toContain(token);
  });

  it("отказ; свой же аккаунт → 409 GUARDIAN_CONSENT_SELF; не взрослый → 403; неизвестный/битый токен → 404; без входа решение → 401", async () => {
    const parent = await teenAndParent();
    const token = new URL((await send("POST", "/v1/profile/guardian-consent")).json().link).searchParams.get("startapp")!.slice(3);
    expect((await send("POST", `/v1/guardian-consents/${token}/accept`)).json().code).toBe("GUARDIAN_CONSENT_SELF");
    expect((await h.app.inject({ method: "POST", url: `/v1/guardian-consents/${token}/accept` })).statusCode).toBe(401);
    const teen2 = await login(h, { id: 900333, first_name: "Друг" }, "203.0.113.12");
    h.fake.setAge(teen2.userId, "14-17");
    expect((await send("POST", `/v1/guardian-consents/${token}/decline`, undefined, teen2.access)).json().code).toBe("ADULT_REQUIRED");
    const decline = await send("POST", `/v1/guardian-consents/${token}/decline`, undefined, parent.access);
    expect(decline.json().status).toBe("declined");
    for (const bad of ["short", "a".repeat(15), "abc$def0123456789", "a/b"]) {
      const res = await h.app.inject({ url: `/v1/guardian-consents/${encodeURIComponent(bad)}` });
      expect(res.statusCode, bad).toBe(404);
      expect(res.json().code).toBe("GUARDIAN_CONSENT_NOT_FOUND");
    }
    const unknown = await h.app.inject({ url: `/v1/guardian-consents/${"Q".repeat(43)}` });
    expect(unknown.json().code).toBe("GUARDIAN_CONSENT_NOT_FOUND");
    // слишком длинный параметр отсекает роутер — ErrorBody 404 без эха токена, до identity не доходит
    const huge = await h.app.inject({ url: `/v1/guardian-consents/${"a".repeat(200)}` });
    expect(huge.statusCode).toBe(404);
    expect(huge.json()).toEqual({ code: "NOT_FOUND", message: "Не найдено", trace_id: expect.any(String), details: {} });
    expect(huge.body).not.toContain("aaaa");
  });

  it("взрослому ссылка не нужна → 409 GUARDIAN_CONSENT_NOT_REQUIRED; решение из детского профиля → 403 ADULT_REQUIRED", async () => {
    h.fake.setAge(s.userId, "18+");
    expect((await send("POST", "/v1/profile/guardian-consent")).json().code).toBe("GUARDIAN_CONSENT_NOT_REQUIRED");
    const c = await switchTo(h, s, h.fake.addChild(s.userId));
    const res = await send("POST", `/v1/guardian-consents/${"Q".repeat(43)}/accept`, undefined, c.access);
    expect(res.json().code).toBe("ADULT_REQUIRED");
  });

  it("identity вернул токен неожиданного формата → 503 (ссылка не строится)", async () => {
    h.fake.setAge(s.userId, "14-17");
    h.fake.override("identity", "POST", "/internal/v1/me/guardian-consent-requests", () =>
      new Response(JSON.stringify({ token: "bad token/../x", expires_at: "2026-11-25T10:00:00Z" }), { status: 200 }),
    );
    expect((await send("POST", "/v1/profile/guardian-consent")).statusCode).toBe(503);
  });
});

describe("приглашения (AT-09)", () => {
  async function adultWithInvite(kind: "family" | "friend" | "referral" = "family") {
    h.fake.setAge(s.userId, "18+");
    const res = await send("POST", "/v1/invites", { kind }, s.access, idem());
    expect(res.statusCode).toBe(201);
    const invite = res.json();
    const token = new URL(invite.link).searchParams.get("startapp")!.slice(4);
    return { invite, token };
  }

  it("создание: 201 Invite, Idempotency-Key обязателен и пробрасывается, повтор — то же приглашение; служебные поля не уходят", async () => {
    h.fake.setAge(s.userId, "18+");
    expect((await send("POST", "/v1/invites", { kind: "family" })).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const key = idem();
    const a = await send("POST", "/v1/invites", { kind: "family" }, s.access, key);
    expect(a.statusCode).toBe(201);
    expect(Value.Check(InviteSchema, a.json())).toBe(true);
    expect(a.json()).toMatchObject({ kind: "family", status: "active", accepted_count: 0, link: expect.stringMatching(/^https:\/\/t\.me\/.+\?startapp=inv_/) });
    expect(a.body).not.toMatch(/token_hash|inviter_user_id/);
    const b = await send("POST", "/v1/invites", { kind: "family" }, s.access, key);
    expect(b.json().invite_id).toBe(a.json().invite_id);
    const calls = h.fake.callsTo("social", "POST", "/internal/v1/me/invites");
    expect(calls.map((c) => [c.subject, c.headers["idempotency-key"]])).toEqual([
      [s.userId, key["idempotency-key"]],
      [s.userId, key["idempotency-key"]],
    ]);
    expect((await send("POST", "/v1/invites", { kind: "colleague" }, s.access, idem())).statusCode).toBe(422);
  });

  it("правила домена: family — только 18+ (403 ADULT_REQUIRED); подросток без согласия — 403 INVITES_NOT_ALLOWED", async () => {
    h.fake.setAge(s.userId, "14-17");
    expect((await send("POST", "/v1/invites", { kind: "family" }, s.access, idem())).json().code).toBe("ADULT_REQUIRED");
    expect((await send("POST", "/v1/invites", { kind: "friend" }, s.access, idem())).json().code).toBe("INVITES_NOT_ALLOWED");
  });

  it("получатель: open (token из start_param) → preview → accept (семья), повтор accept — тот же результат; пригласивший видит семью", async () => {
    const { invite, token } = await adultWithInvite("family");
    const childId = h.fake.addChild(s.userId);
    const anna = await login(h, TG_OTHER, "203.0.113.11", `inv_${token}`);
    expect(anna.body.start_param).toBe(`inv_${token}`);
    const open = await send("POST", "/v1/invites/open", { token }, anna.access);
    expect(open.statusCode).toBe(200);
    expect(Value.Check(InvitePreviewSchema, open.json())).toBe(true);
    expect(open.json()).toEqual({ invite_id: invite.invite_id, kind: "family", inviter_display_name: "Игорь", status: "active", can_accept: true, reason: null });
    expect(open.body).not.toContain("inviter_user_id");
    expect((await get(`/v1/invites/${invite.invite_id}/preview`, anna.access)).json().can_accept).toBe(true);

    const accept = await send("POST", `/v1/invites/${invite.invite_id}/accept`, undefined, anna.access);
    expect(accept.statusCode).toBe(200);
    const res = accept.json();
    expect(res).toMatchObject({ invite_id: invite.invite_id, kind: "family" });
    expect(Value.Check(FamilySchema, res.family)).toBe(true);
    expect(res.family.members.find((m: { is_me: boolean }) => m.is_me).user_id).toBe(anna.userId);
    expect((await send("POST", `/v1/invites/${invite.invite_id}/accept`, undefined, anna.access)).statusCode).toBe(200);
    expect(h.fake.callsTo("social").filter((c) => c.path.startsWith("/internal/v1/invites")).every((c) => c.subject === anna.userId)).toBe(true);

    const fam = await get("/v1/family");
    expect(fam.statusCode).toBe(200);
    expect(fam.json().members.map((m: { user_id: string; role: string; is_me: boolean }) => [m.user_id, m.role, m.is_me])).toEqual([
      [s.userId, "owner", true],
      [childId, "child", false],
      [anna.userId, "adult", false],
    ]);
    expect(fam.body).not.toContain("telegram_user_id");
    // в детском профиле «я» — ребёнок
    const c = await switchTo(h, s, childId);
    const famChild = (await get("/v1/family", c.access)).json();
    expect(famChild.members.find((m: { is_me: boolean }) => m.is_me).user_id).toBe(childId);
  });

  it("самоприглашение → can_accept=false reason=self, accept → 409 INVITE_SELF; повторная активация → 409 INVITE_ALREADY_USED", async () => {
    const { invite, token } = await adultWithInvite("family");
    const self = await send("POST", "/v1/invites/open", { token });
    expect(self.json()).toMatchObject({ can_accept: false, reason: "self" });
    expect((await send("POST", `/v1/invites/${invite.invite_id}/accept`)).json().code).toBe("INVITE_SELF");
    const anna = await login(h, TG_OTHER, "203.0.113.11");
    await send("POST", "/v1/invites/open", { token }, anna.access);
    await send("POST", `/v1/invites/${invite.invite_id}/accept`, undefined, anna.access);
    const third = await login(h, { id: 900444, first_name: "Третий" }, "203.0.113.12");
    await send("POST", "/v1/invites/open", { token }, third.access);
    const used = await send("POST", `/v1/invites/${invite.invite_id}/accept`, undefined, third.access);
    expect(used.statusCode).toBe(409);
    expect(used.json().code).toBe("INVITE_ALREADY_USED");
  });

  it("список, отзыв (чужое → 404), отклонение; неизвестный/битый токен и id → 404 INVITE_NOT_FOUND; пустой токен → 422", async () => {
    const { invite, token } = await adultWithInvite("friend");
    const list = await get("/v1/invites?limit=5");
    expect(list.json().items.map((i: { invite_id: string }) => i.invite_id)).toEqual([invite.invite_id]);
    expect(list.json().next_cursor).toBeNull();
    expect(h.fake.callsTo("social", "GET", "/internal/v1/me/invites")[0]!.query).toEqual({ limit: "5" });

    const anna = await login(h, TG_OTHER, "203.0.113.11");
    await send("POST", "/v1/invites/open", { token }, anna.access);
    expect((await send("POST", `/v1/invites/${invite.invite_id}/decline`, undefined, anna.access)).json().invite_id).toBe(invite.invite_id);
    expect((await send("DELETE", `/v1/invites/${invite.invite_id}`, undefined, anna.access)).json().code).toBe("INVITE_NOT_FOUND");
    const revoked = await send("DELETE", `/v1/invites/${invite.invite_id}`);
    expect(revoked.json().status).toBe("revoked");
    expect((await send("POST", `/v1/invites/${invite.invite_id}/accept`, undefined, anna.access)).json().code).toBe("INVITE_REVOKED");

    for (const bad of ["x", "a b c d e f g h i j k l m n o p", "Q".repeat(65)]) {
      const res = await send("POST", "/v1/invites/open", { token: bad }, anna.access);
      expect(res.statusCode, bad).toBe(404);
      expect(res.json().code).toBe("INVITE_NOT_FOUND");
    }
    expect((await send("POST", "/v1/invites/open", { token: "Q".repeat(32) }, anna.access)).json().code).toBe("INVITE_NOT_FOUND");
    expect((await send("POST", "/v1/invites/open", {}, anna.access)).statusCode).toBe(422);
    for (const url of ["/v1/invites/not-a-uuid/preview", `/v1/invites/${randomUUID()}/preview`]) {
      expect((await get(url, anna.access)).json().code, url).toBe("INVITE_NOT_FOUND");
    }
    expect((await send("DELETE", "/v1/invites/123")).json().code).toBe("INVITE_NOT_FOUND");
  });

  it("детский профиль: все действия с приглашениями → 403 INVITES_NOT_ALLOWED, social не вызывается", async () => {
    const { invite, token } = await adultWithInvite("friend");
    const c = await switchTo(h, s, h.fake.addChild(s.userId));
    h.fake.calls.length = 0;
    const probes: Array<["GET" | "POST" | "DELETE", string, object?]> = [
      ["POST", "/v1/invites", { kind: "friend" }],
      ["GET", "/v1/invites"],
      ["DELETE", `/v1/invites/${invite.invite_id}`],
      ["POST", "/v1/invites/open", { token }],
      ["GET", `/v1/invites/${invite.invite_id}/preview`],
      ["POST", `/v1/invites/${invite.invite_id}/accept`],
      ["POST", `/v1/invites/${invite.invite_id}/decline`],
    ];
    for (const [method, url, payload] of probes) {
      const res = await h.app.inject({ method, url, headers: { ...bearer(c.access), ...idem() }, ...(payload ? { payload } : {}) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code, url).toBe("INVITES_NOT_ALLOWED");
    }
    expect(h.fake.callsTo("social")).toHaveLength(0);
  });

  it("семьи нет → 204 без тела", async () => {
    const res = await get("/v1/family");
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(h.fake.callsTo("social", "GET", "/internal/v1/me/family")[0]!.subject).toBe(s.userId);
  });
});

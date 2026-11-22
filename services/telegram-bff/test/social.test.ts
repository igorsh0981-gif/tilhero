/**
 * Спринт 7 через BFF — социальное в social (bff.ts «Спринт 7», INTERNAL_API спринта 7 §0, §1, §9): профиль сообщества,
 * поиск, заявки, друзья, блокировки, жалобы, санкции и обжалование, рефералы; семья спринта 1 + member_id.
 * Субъект social — аккаунт, claims lrn и age_band активного ученика; member_id — как есть; коды домена — как есть; сбой и
 * ответ не по контракту → 503 UPSTREAM_UNAVAILABLE {service: social}; детский профиль — отказ до social; лимиты tg.social.*.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOCKED_MEMBER, OTHER_MEMBER, OTHER_USER_ID, SOCIAL_SECRET, memberIdOf } from "./fakeSocial.js";
import { bearer, closeRedis, domainError, idem, json, login, makeHarness, switchTo, testRedis, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
async function setup(env: Record<string, string> = {}): Promise<void> {
  h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "1000", ...env });
  s = await login(h);
  h.fake.setAge(s.userId, "18+");
  h.fake.onboard(s.userId);
}
beforeEach(() => setup());
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const get = (url: string, token = s.access) => h.app.inject({ url, headers: bearer(token) });
const send = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}, token = s.access) =>
  h.app.inject({ method, url, headers: { ...bearer(token), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const socialCalls = (method?: string, path?: string) => h.fake.callsTo("social", method, path);
const MISSING_REQUEST = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";

async function kid(band: "6-9" | "10-13" = "6-9"): Promise<{ kid: LoggedIn; child: string }> {
  const child = h.fake.addChild(s.userId, "Мадина", band);
  h.fake.onboard(child);
  return { kid: await switchTo(h, s, child), child };
}

async function limitTo(policy: string, limit: number, windowS = 60): Promise<void> {
  await h.close();
  await setup({ RATE_LIMIT_OVERRIDE_REFRESH_SECONDS: "1" });
  await testRedis().set(
    `${h.config.rateLimiting.keyPrefix}rl:override:${policy}`,
    JSON.stringify({ v: 1, limit, window_s: windowS, burst: null, by: "staff-1", at: new Date().toISOString(), reason: "тест", expires_at: null }),
  );
  await new Promise((r) => setTimeout(r, 1100));
}

/** Все маршруты social спринта 7 с корректным запросом. */
const ROUTES: Array<[Method, string, unknown?, boolean?]> = [
  ["GET", "/v1/community"],
  ["PATCH", "/v1/community", { game_profile_hidden: true }],
  ["PUT", "/v1/community/nickname", { nickname: "Igor_2026" }],
  ["POST", "/v1/community/friend-code/rotate"],
  ["GET", `/v1/friends/search?q=${encodeURIComponent("Anvar_77")}`],
  ["POST", "/v1/friends/requests", { member_id: OTHER_MEMBER }, true],
  ["GET", "/v1/friends/requests?direction=in"],
  ["GET", "/v1/friends"],
  ["DELETE", `/v1/friends/${OTHER_MEMBER}`],
  ["POST", "/v1/blocks", { member_id: OTHER_MEMBER }],
  ["GET", "/v1/blocks"],
  ["DELETE", `/v1/blocks/${OTHER_MEMBER}`],
  ["POST", "/v1/complaints", { member_id: OTHER_MEMBER, subject_kind: "user", subject_id: null, reason: "spam" }, true],
  ["GET", "/v1/sanctions"],
  ["POST", `/v1/sanctions/${"5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d"}/appeal`, { text: "Прошу пересмотреть решение" }, true],
  ["GET", "/v1/referrals"],
];
const callRoute = ([method, url, payload, needsKey]: [Method, string, unknown?, boolean?], token = s.access) => send(method, url, payload, needsKey ? idem() : {}, token);

describe("профиль сообщества", () => {
  it("GET: поля контракта, служебное домена (user_id, Telegram, имя, возраст) отброшено; sub = аккаунт, claims lrn и age_band", async () => {
    const res = await get("/v1/community");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      member_id: memberIdOf(s.userId),
      nickname: null,
      friend_code: "TH-QW3R-TY5U",
      game_profile_hidden: false,
      restrictions: { social_ban: false, social_ban_until: null },
      nickname_change_available_at: null,
      friends_available: true,
      friends_unavailable_reason: null,
    });
    const call = socialCalls("GET", "/internal/v1/me/community")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ iss: "telegram-bff", aud: "social", lrn: s.userId, age_band: "18+" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("PATCH скрытия, PUT ника, ротация кода → CommunityProfile; тела — только поля контракта", async () => {
    expect((await send("PATCH", "/v1/community", { game_profile_hidden: true })).json().game_profile_hidden).toBe(true);
    expect(socialCalls("PATCH", "/internal/v1/me/community")[0]!.body).toEqual({ game_profile_hidden: true });
    const nick = await send("PUT", "/v1/community/nickname", { nickname: "Ойбек_2026" });
    expect([nick.statusCode, nick.json().nickname]).toEqual([200, "Ойбек_2026"]);
    expect(socialCalls("PUT", "/internal/v1/me/community/nickname")[0]!.body).toEqual({ nickname: "Ойбек_2026" });
    const key = idem();
    const rot = await send("POST", "/v1/community/friend-code/rotate", undefined, key);
    expect(rot.json().friend_code).toBe("TH-NEW2-CODE");
    const call = socialCalls("POST", "/internal/v1/me/community/friend-code:rotate")[0]!;
    expect(call.headers["idempotency-key"]).toBe(key["idempotency-key"]);
  });

  it("ник: длина и символы — 422 NICKNAME_INVALID {reason} без вызова; не строка, лишнее поле, пустой PATCH — 422 VALIDATION_ERROR; коды social — как есть", async () => {
    for (const [nickname, reason] of [["ab", "length"], ["a".repeat(21), "length"], ["two words", "chars"], ["dash-nick", "chars"], ["emoji🙂", "chars"]] as const) {
      const r = await send("PUT", "/v1/community/nickname", { nickname });
      expect([r.statusCode, r.json().code, r.json().details], nickname).toEqual([422, "NICKNAME_INVALID", { reason }]);
    }
    for (const bad of [{ nickname: 123 }, { nickname: "Igor_1", user_id: OTHER_USER_ID }, {}]) {
      const r = await send("PUT", "/v1/community/nickname", bad);
      expect([r.statusCode, r.json().code], JSON.stringify(bad)).toEqual([422, "VALIDATION_ERROR"]);
    }
    expect((await send("PATCH", "/v1/community", {})).statusCode).toBe(422);
    expect(socialCalls()).toHaveLength(0);
    const taken = await send("PUT", "/v1/community/nickname", { nickname: "Taken_Nick" });
    expect([taken.statusCode, taken.json().code]).toEqual([409, "NICKNAME_TAKEN"]);
    const bad = await send("PUT", "/v1/community/nickname", { nickname: "badword" });
    expect([bad.statusCode, bad.json().code, bad.json().details]).toEqual([422, "NICKNAME_INVALID", { reason: "forbidden" }]);
    // буквы RU/UZ/EN (в т. ч. «ʻ» узбекской латиницы — модификатор-буква), цифры, «_» — проходят форму; остальное решает social
    for (const nickname of ["Иван_1", "Oʻgʻil", "Ёжик", "abc", "я".repeat(20)]) {
      expect((await send("PUT", "/v1/community/nickname", { nickname })).statusCode, nickname).toBe(200);
    }
    expect(h.logs.text).not.toContain("two words");
    expect(h.logs.text).not.toContain("Ойбек");
  });
});

describe("поиск, заявки, друзья", () => {
  it("поиск: 0 или 1 карточка, без user_id и имени; q — 3..20 (буквы, цифры, «_», «-»), иначе 422 без вызова; запрос не в логе", async () => {
    const hit = await get(`/v1/friends/search?q=${encodeURIComponent("th-ab2c-d3ef")}`);
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toEqual({ items: [{ member_id: OTHER_MEMBER, nickname: "Anvar_77", relation: "none", request_id: null }] });
    expect(socialCalls("GET", "/internal/v1/me/friends/search")[0]!.query).toEqual({ q: "th-ab2c-d3ef" });
    expect((await get("/v1/friends/search?q=nobody_here")).json()).toEqual({ items: [] });
    expect((await get(`/v1/friends/search?q=${"z".repeat(20)}`)).statusCode).toBe(200);
    const n = socialCalls().length;
    for (const q of ["", "ab", "a".repeat(21), "two%20words", "x%00y"]) {
      const r = await get(`/v1/friends/search?q=${q}`);
      expect([r.statusCode, r.json().code], q).toEqual([422, "VALIDATION_ERROR"]);
    }
    expect((await get("/v1/friends/search")).statusCode).toBe(422);
    expect((await get("/v1/friends/search?q=Anvar_77&user_id=x")).statusCode).toBe(422);
    expect(socialCalls()).toHaveLength(n);
    expect(h.logs.text).not.toContain("th-ab2c-d3ef");
    expect(h.logs.text).not.toContain("nobody_here");
  });

  it("заявка: Idempotency-Key обязателен и пробрасывается; 201, повтор ключа — 200 тот же; member_id — только mb_…; коды social — как есть", async () => {
    const none = await send("POST", "/v1/friends/requests", { member_id: OTHER_MEMBER });
    expect([none.statusCode, none.json().code]).toEqual([422, "IDEMPOTENCY_KEY_REQUIRED"]);
    const junk = await send("POST", "/v1/friends/requests", { member_id: OTHER_MEMBER }, { "idempotency-key": "not-a-uuid" });
    expect(junk.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    for (const bad of [{ member_id: OTHER_USER_ID }, { member_id: "mb_short" }, { member_id: OTHER_MEMBER, user_id: s.userId }, {}]) {
      const r = await send("POST", "/v1/friends/requests", bad, idem());
      expect([r.statusCode, r.json().code], JSON.stringify(bad)).toEqual([422, "VALIDATION_ERROR"]);
    }
    expect(socialCalls()).toHaveLength(0);

    const key = { "idempotency-key": "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE" };
    const first = await send("POST", "/v1/friends/requests", { member_id: OTHER_MEMBER }, key);
    expect(first.statusCode).toBe(201);
    const b = first.json();
    expect(b).toEqual({ request_id: expect.any(String), direction: "out", member_id: OTHER_MEMBER, nickname: "Anvar_77", status: "pending", created_at: expect.any(String), decided_at: null });
    const again = await send("POST", "/v1/friends/requests", { member_id: OTHER_MEMBER }, key);
    expect([again.statusCode, again.json()]).toEqual([200, b]);
    const call = socialCalls("POST", "/internal/v1/me/friend-requests")[0]!;
    expect(call.headers["idempotency-key"]).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(call.body).toEqual({ member_id: OTHER_MEMBER });

    const blocked = await send("POST", "/v1/friends/requests", { member_id: BLOCKED_MEMBER }, idem());
    expect([blocked.statusCode, blocked.json().code]).toEqual([403, "BLOCKED"]);
    const self = await send("POST", "/v1/friends/requests", { member_id: memberIdOf(s.userId) }, idem());
    expect([self.statusCode, self.json().code]).toEqual([422, "VALIDATION_ERROR"]);
    const unknown = await send("POST", "/v1/friends/requests", { member_id: memberIdOf("nobody") }, idem());
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, "MEMBER_NOT_FOUND"]);
    h.fake.override("social", "POST", "/internal/v1/me/friend-requests", () => domainError(403, "SOCIAL_RESTRICTED", { until: "2026-11-27T09:00:00Z" }));
    const banned = await send("POST", "/v1/friends/requests", { member_id: OTHER_MEMBER }, idem());
    expect([banned.statusCode, banned.json().code, banned.json().details]).toEqual([403, "SOCIAL_RESTRICTED", { until: "2026-11-27T09:00:00Z" }]);
  });

  it("заявки: список по direction (обязателен), принять / отклонить / отозвать — пути домена; неверный request_id — 404 без вызова", async () => {
    const created = (await send("POST", "/v1/friends/requests", { member_id: OTHER_MEMBER }, idem())).json();
    const out = await get("/v1/friends/requests?direction=out&cursor=c1");
    expect(out.json()).toEqual({ items: [created], next_cursor: null });
    expect(socialCalls("GET", "/internal/v1/me/friend-requests")[0]!.query).toEqual({ direction: "out", cursor: "c1" });
    const inc = await get("/v1/friends/requests?direction=in");
    expect(inc.json().items).toHaveLength(1);
    expect(inc.json().next_cursor).toBe("c2");
    expect((await get("/v1/friends/requests")).statusCode).toBe(422);
    expect((await get("/v1/friends/requests?direction=both")).statusCode).toBe(422);

    const cancel = await send("POST", `/v1/friends/requests/${created.request_id.toUpperCase()}/cancel`);
    expect(cancel.json()).toMatchObject({ request_id: created.request_id, status: "cancelled" });
    expect(socialCalls("POST", `/internal/v1/me/friend-requests/${created.request_id}/cancel`)).toHaveLength(1);
    const wrong = await send("POST", `/v1/friends/requests/${created.request_id}/accept`);
    expect([wrong.statusCode, wrong.json().code, wrong.json().details]).toEqual([409, "REQUEST_STATE", { status: "cancelled" }]);
    const missing = await send("POST", `/v1/friends/requests/${MISSING_REQUEST}/decline`);
    expect([missing.statusCode, missing.json().code]).toEqual([404, "REQUEST_NOT_FOUND"]);
    const n = socialCalls().length;
    const bad = await send("POST", "/v1/friends/requests/not-a-uuid/accept");
    expect([bad.statusCode, bad.json().code]).toEqual([404, "REQUEST_NOT_FOUND"]);
    expect(socialCalls()).toHaveLength(n);
  });

  it("друзья: member_id, ник, since — без user_id, Telegram и чужого кода; элемент с «сырым» UUID отброшен с записью в лог; удаление — 204", async () => {
    h.fake.social7.rawUuidItem = true;
    const res = await get("/v1/friends?cursor=abc");
    expect(res.json()).toEqual({ items: [{ member_id: OTHER_MEMBER, nickname: "Anvar_77", since: "2026-11-20T09:00:00Z" }], next_cursor: null });
    expect(res.body).not.toContain(OTHER_USER_ID);
    expect(res.body).not.toContain("TH-AB2C");
    expect(h.logs.parsed().some((l) => l.msg === "list items dropped" && l.check === "friends")).toBe(true);
    expect(h.logs.text).not.toContain(OTHER_USER_ID);
    const del = await send("DELETE", `/v1/friends/${OTHER_MEMBER}`);
    expect([del.statusCode, del.body]).toEqual([204, ""]);
    expect(socialCalls("DELETE", `/internal/v1/me/friends/${OTHER_MEMBER}`)).toHaveLength(1);
    const n = socialCalls().length;
    const bad = await send("DELETE", `/v1/friends/${OTHER_USER_ID}`);
    expect([bad.statusCode, bad.json().code]).toEqual([404, "MEMBER_NOT_FOUND"]);
    expect(socialCalls()).toHaveLength(n);
  });
});

describe("блокировки, жалобы, санкции, рефералы", () => {
  it("блокировка: 201, повтор — 200; список; снятие — 204; служебное домена отброшено", async () => {
    const first = await send("POST", "/v1/blocks", { member_id: OTHER_MEMBER });
    expect([first.statusCode, first.json()]).toEqual([201, { member_id: OTHER_MEMBER, nickname: "Anvar_77", created_at: "2026-11-20T09:00:00Z" }]);
    expect((await send("POST", "/v1/blocks", { member_id: OTHER_MEMBER })).statusCode).toBe(200);
    const list = await get("/v1/blocks");
    expect(list.json()).toEqual({ items: [{ member_id: OTHER_MEMBER, nickname: "Anvar_77", created_at: "2026-11-20T09:00:00Z" }] });
    expect(list.body).not.toContain(OTHER_USER_ID);
    expect((await send("DELETE", `/v1/blocks/${OTHER_MEMBER}`)).statusCode).toBe(204);
    expect((await get("/v1/blocks")).json()).toEqual({ items: [] });
    expect((await send("POST", "/v1/blocks", { member_id: OTHER_USER_ID })).statusCode).toBe(422);
  });

  it("жалоба: Idempotency-Key; subject_id — по виду предмета (иначе 422 без вызова); комментарий обрезан и не в логе; block — как есть", async () => {
    const base = { member_id: OTHER_MEMBER, reason: "abuse" as const };
    expect((await send("POST", "/v1/complaints", { ...base, subject_kind: "user", subject_id: null })).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const room = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
    for (const bad of [
      { ...base, subject_kind: "user", subject_id: room },
      { ...base, subject_kind: "nickname", subject_id: room },
      { ...base, subject_kind: "duel", subject_id: null },
      { ...base, subject_kind: "pair_room", subject_id: null },
      { ...base, subject_kind: "duel", subject_id: "not-uuid" },
      { ...base, subject_kind: "user" },
      { ...base, subject_kind: "user", subject_id: null, comment: "x".repeat(501) },
      { ...base, subject_kind: "spam_kind", subject_id: null },
      { ...base, subject_kind: "user", subject_id: null, reason: "boring" },
    ]) {
      const r = await send("POST", "/v1/complaints", bad, idem());
      expect([r.statusCode, r.json().code], JSON.stringify(bad)).toEqual([422, "VALIDATION_ERROR"]);
    }
    expect(socialCalls()).toHaveLength(0);
    const res = await send("POST", "/v1/complaints", { ...base, subject_kind: "pair_room", subject_id: room.toUpperCase(), comment: "  COMPLAINT-TEXT-123\nгрубил  ", block: true }, idem());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ case_id: expect.any(String), created_at: "2026-11-20T09:00:00Z", blocked: true });
    expect(socialCalls("POST", "/internal/v1/me/complaints")[0]!.body).toEqual({
      member_id: OTHER_MEMBER,
      subject_kind: "pair_room",
      subject_id: room,
      reason: "abuse",
      comment: "COMPLAINT-TEXT-123\nгрубил",
      block: true,
    });
    expect(res.body).not.toContain(OTHER_USER_ID);
    expect(h.logs.text).not.toContain("COMPLAINT-TEXT-123");
    // пустой после обрезки комментарий не передаётся; 500 знаков — граница
    await send("POST", "/v1/complaints", { ...base, subject_kind: "nickname", subject_id: null, comment: "   " }, idem());
    expect(socialCalls("POST", "/internal/v1/me/complaints")[1]!.body).not.toHaveProperty("comment");
    expect((await send("POST", "/v1/complaints", { ...base, subject_kind: "user", subject_id: null, comment: "к".repeat(500) }, idem())).statusCode).toBe(201);
  });

  it("санкции: основание и срок, без исполнителя и заметок; обжалование — Idempotency-Key, 10..1000 после обрезки; повтор — 409 как есть", async () => {
    const list = await get("/v1/sanctions");
    const item = list.json().items[0];
    expect(item).toEqual({
      sanction_id: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
      kind: "social_ban",
      basis: "Оскорбления в нике после предупреждения",
      decided_at: "2026-11-20T09:00:00Z",
      until: "2026-11-27T09:00:00Z",
      active: true,
      revoked_at: null,
      appeal: null,
      can_appeal: true,
    });
    expect(list.body).not.toContain("moder-1");
    expect(list.body).not.toContain(SOCIAL_SECRET);
    const url = `/v1/sanctions/${item.sanction_id}/appeal`;
    expect((await send("POST", url, { text: "Прошу снять санкцию" })).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    for (const text of ["короткий", "          ok          ", "x".repeat(1001)]) {
      const r = await send("POST", url, { text }, idem());
      expect([r.statusCode, r.json().code], text).toEqual([422, "VALIDATION_ERROR"]);
    }
    // ровно 10 знаков после обрезки — граница
    const ok = await send("POST", url, { text: "  Прошу снят  " }, idem());
    expect(ok.statusCode).toBe(201);
    expect(ok.json().appeal).toEqual({ appeal_id: expect.any(String), status: "open", text: "Я исправил ник, прошу снять", created_at: expect.any(String), decided_at: null, decision_note: null });
    expect(socialCalls("POST", `/internal/v1/me/sanctions/${item.sanction_id}/appeal`)[0]!.body).toEqual({ text: "Прошу снят" });
    const twice = await send("POST", url, { text: "Ещё раз прошу снять" }, idem());
    expect([twice.statusCode, twice.json().code]).toEqual([409, "APPEAL_EXISTS"]);
    const bad = await send("POST", "/v1/sanctions/123/appeal", { text: "Прошу снять санкцию" }, idem());
    expect([bad.statusCode, bad.json().code]).toEqual([404, "SANCTION_NOT_FOUND"]);
  });

  it("рефералы: статус, прогресс, условия и месяц — без user_id приглашённого, флагов антифрода и заметок", async () => {
    const res = await get("/v1/referrals?cursor=r1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          referral_id: "8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e1f",
          invitee_nickname: "Anvar_77",
          status: "learning",
          progress: { diagnostic: true, diagnostic_required: true, lessons: 2, lessons_required: 3, days: 1, days_required: 2, window_ends_at: "2026-12-20T09:00:00Z" },
          reward: null,
          reward_outcome: null,
          reject_code: null,
          legacy: false,
          accepted_at: "2026-11-20T09:00:00Z",
        },
      ],
      next_cursor: null,
      terms: { campaign_version: 1, require_diagnostic: true, min_lessons: 3, min_days: 2, window_days: 30, inviter_reward: { freeze: 2, til: 0 }, invitee_reward: { freeze: 0, til: 0 }, monthly_cap: 10 },
      month: { qualified: 1, cap: 10 },
    });
    for (const leak of [OTHER_USER_ID, "short_lessons", "velocity", SOCIAL_SECRET]) expect(res.body).not.toContain(leak);
    expect(socialCalls("GET", "/internal/v1/me/referrals")[0]!.query).toEqual({ cursor: "r1" });
  });

  it("рефералы: reward_outcome (rewarded, legacy, inviter_capped, null) и legacy — как есть; неизвестное значение или нет поля — элемент отброшен", async () => {
    const base = {
      invitee_nickname: "Anvar_77",
      status: "learning",
      progress: { diagnostic: true, diagnostic_required: true, lessons: 3, lessons_required: 3, days: 2, days_required: 2, window_ends_at: "2026-12-20T09:00:00Z" },
      reward: null,
      reward_outcome: null,
      reject_code: null,
      legacy: false,
      accepted_at: "2026-11-20T09:00:00Z",
      invitee_user_id: OTHER_USER_ID,
    };
    const item = (id: string, extra: Record<string, unknown>) => ({ ...base, referral_id: id, ...extra });
    const ids = ["1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f", "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a"];
    h.fake.override("social", "GET", "/internal/v1/me/referrals", () =>
      json(200, {
        items: [
          item(ids[0]!, { status: "rewarded", reward: { freeze: 2, til: 0 }, reward_outcome: "rewarded" }),
          item(ids[1]!, { status: "rewarded", reward: null, reward_outcome: "legacy", legacy: true }),
          item(ids[2]!, { status: "capped", reward: null, reward_outcome: "inviter_capped", reject_code: "monthly_cap" }),
          item(ids[3]!, { status: "qualified", reward: { freeze: 2, til: 0 }, reward_outcome: null }),
          item("5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", { reward_outcome: "bonus" }),
          (({ reward_outcome: _r, ...rest }) => ({ ...rest, referral_id: "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c" }))(item("x", {})),
          // legacy — обязательный boolean: нет поля или не boolean — элемент отброшен
          (({ legacy: _l, ...rest }) => ({ ...rest, referral_id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d" }))(item("x", {})),
          item("8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e", { legacy: "yes" }),
        ],
        next_cursor: null,
        terms: { campaign_version: 1, require_diagnostic: true, min_lessons: 3, min_days: 2, window_days: 30, inviter_reward: { freeze: 2, til: 0 }, invitee_reward: { freeze: 0, til: 0 }, monthly_cap: 10 },
        month: { qualified: 2, cap: 10 },
      }),
    );
    const res = await get("/v1/referrals");
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((r: { referral_id: string; reward_outcome: string | null; reward: unknown; legacy: boolean }) => [r.referral_id, r.reward_outcome, r.reward, r.legacy])).toEqual([
      [ids[0], "rewarded", { freeze: 2, til: 0 }, false],
      [ids[1], "legacy", null, true],
      [ids[2], "inviter_capped", null, false],
      [ids[3], null, { freeze: 2, til: 0 }, false],
    ]);
    expect(h.logs.parsed().some((l) => l.msg === "list items dropped" && l.check === "referrals" && l.dropped === 4)).toBe(true);
  });
});

describe("детский профиль (6–13)", () => {
  it("сообщество и санкции — в social с lrn и age_band ребёнка; друзья — 403 FRIENDS_NOT_ALLOWED {reason: kids}, блокировки, жалобы, рефералы — 403 KIDS_NOT_ALLOWED без вызова", async () => {
    const { kid: k, child } = await kid("10-13");
    const c = await get("/v1/community", k.access);
    expect(c.json()).toMatchObject({ member_id: memberIdOf(child), friends_available: false, friends_unavailable_reason: "kids" });
    const call = socialCalls("GET", "/internal/v1/me/community").at(-1)!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ lrn: child, age_band: "10-13" });
    expect((await get("/v1/sanctions", k.access)).statusCode).toBe(200);
    const n = socialCalls().length;
    for (const r of ROUTES) {
      const [method, url] = r;
      const friends = url.startsWith("/v1/friends");
      const kidsBlocked = url.startsWith("/v1/blocks") || url.startsWith("/v1/complaints") || url.startsWith("/v1/referrals");
      if (!friends && !kidsBlocked) continue;
      const res = await callRoute(r, k.access);
      if (friends) expect([res.statusCode, res.json().code, res.json().details], `${method} ${url}`).toEqual([403, "FRIENDS_NOT_ALLOWED", { reason: "kids" }]);
      else expect([res.statusCode, res.json().code], `${method} ${url}`).toEqual([403, "KIDS_NOT_ALLOWED"]);
    }
    expect(socialCalls()).toHaveLength(n);
  });
});

describe("лимиты tg.social.*", () => {
  it("tg.social.search: 429 {policy} без вызова social; чтение списков — не этот счётчик", async () => {
    await limitTo("tg.social.search", 2);
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await get("/v1/friends/search?q=Anvar_77")).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    const r = await get("/v1/friends/search?q=Anvar_77");
    expect(r.json()).toMatchObject({ code: "RATE_LIMITED", details: { policy: "tg.social.search" } });
    expect(socialCalls("GET", "/internal/v1/me/friends/search")).toHaveLength(2);
    expect((await get("/v1/friends")).statusCode).toBe(200);
  });

  it("tg.social.write: ник, код, скрытие, заявки, блокировки, обжалование — общий счётчик", async () => {
    await limitTo("tg.social.write", 3);
    expect((await send("PATCH", "/v1/community", { game_profile_hidden: true })).statusCode).toBe(200);
    expect((await send("PUT", "/v1/community/nickname", { nickname: "Igor_7" })).statusCode).toBe(200);
    expect((await send("POST", "/v1/blocks", { member_id: OTHER_MEMBER })).statusCode).toBe(201);
    const r = await send("POST", "/v1/friends/requests", { member_id: OTHER_MEMBER }, idem());
    expect([r.statusCode, r.json().details.policy]).toEqual([429, "tg.social.write"]);
    expect(socialCalls("POST", "/internal/v1/me/friend-requests")).toHaveLength(0);
  });

  it("tg.social.complaint: сутки, на ученика", async () => {
    await limitTo("tg.social.complaint", 1, 86_400);
    const body = { member_id: OTHER_MEMBER, subject_kind: "user", subject_id: null, reason: "spam" };
    expect((await send("POST", "/v1/complaints", body, idem())).statusCode).toBe(201);
    const r = await send("POST", "/v1/complaints", body, idem());
    expect([r.statusCode, r.json().details.policy]).toEqual([429, "tg.social.complaint"]);
    expect(socialCalls("POST", "/internal/v1/me/complaints")).toHaveLength(1);
  });
});

describe("social недоступен — учёба работает", () => {
  it("лежит / 5xx / отказ внутренней авторизации → 503 UPSTREAM_UNAVAILABLE {service: social} на каждом маршруте; план работает", async () => {
    h.fake.down.add("social");
    for (const r of ROUTES) {
      const res = await callRoute(r);
      expect([res.statusCode, res.json().code, res.json().details], r[1]).toEqual([503, "UPSTREAM_UNAVAILABLE", { service: "social" }]);
    }
    expect((await get("/v1/plan/today")).statusCode).toBe(200);
    h.fake.down.delete("social");
    for (const [status, code] of [[500, "BOOM"], [401, "USER_CONTEXT_MISSING"], [403, "CALLER_NOT_ALLOWED"]] as const) {
      h.fake.override("social", "GET", "/internal/v1/me/community", () => domainError(status, code));
      const res = await get("/v1/community");
      expect([res.statusCode, res.json().code, res.json().details], code).toEqual([503, "UPSTREAM_UNAVAILABLE", { service: "social" }]);
      expect(res.body).not.toContain("domain says");
    }
  });

  it("ответ не по контракту (member_id — «сырой» UUID) → 503 и строка лога без значений", async () => {
    h.fake.social7.rawUuidProfile = true;
    const res = await get("/v1/community");
    expect([res.statusCode, res.json().code]).toEqual([503, "UPSTREAM_UNAVAILABLE"]);
    expect(res.body).not.toContain(s.userId);
    const line = h.logs.parsed().find((l) => l.msg === "domain response does not match the contract")!;
    expect(line).toMatchObject({ upstream: "social", check: "community", path: "/member_id", rule: "pattern" });
  });
});

describe("семья (спринт 1) + member_id", () => {
  it("member_id каждого члена семьи — из social как есть; нет member_id или «сырой» UUID — 503", async () => {
    const child = h.fake.addChild(s.userId, "Мадина", "6-9");
    h.fake.families.set(s.userId, {
      family_id: "f-1",
      members: [
        { user_id: s.userId, member_id: memberIdOf(s.userId), display_name: "Игорь", role: "owner", is_me: false },
        { user_id: child, member_id: memberIdOf(child), display_name: "Мадина", role: "child", is_me: false },
      ],
    });
    const res = await get("/v1/family");
    expect(res.json().members).toEqual([
      { user_id: s.userId, member_id: memberIdOf(s.userId), display_name: "Игорь", role: "owner", is_me: true },
      { user_id: child, member_id: memberIdOf(child), display_name: "Мадина", role: "child", is_me: false },
    ]);
    h.fake.families.get(s.userId)!.members[1]!.member_id = child;
    const bad = await get("/v1/family");
    expect([bad.statusCode, bad.json().code, bad.json().details]).toEqual([503, "UPSTREAM_UNAVAILABLE", { service: "social" }]);
    expect(h.logs.parsed().some((l) => l.check === "family" && l.path === "/members/1/member_id")).toBe(true);
  });
});

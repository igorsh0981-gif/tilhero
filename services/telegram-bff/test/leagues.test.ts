/**
 * Спринт 7 через BFF — лиги недели и дуэли в gamification, задания дуэли в lessons (bff.ts «Спринт 7», INTERNAL_API
 * спринта 7 §2.2, §2.3, §3.1, §9). Субъект — аккаунт, claims lrn и age_band активного ученика; другой ученик — member_id,
 * ник, герой; счёт соперника — только в завершённой дуэли; дети — без лиги друзей и общей; сбой gamification → 503
 * GAME_UNAVAILABLE, lessons → 503 UPSTREAM_UNAVAILABLE {service: lessons}; лимиты tg.game.read, tg.duel.write.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOCKED_MEMBER, OTHER_MEMBER, OTHER_TELEGRAM_ID, OTHER_USER_ID, memberIdOf } from "./fakeSocial.js";
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

type Method = "GET" | "POST" | "PATCH";
const get = (url: string, token = s.access) => h.app.inject({ url, headers: bearer(token) });
const send = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}, token = s.access) =>
  h.app.inject({ method, url, headers: { ...bearer(token), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const gameCalls = (method?: string, path?: string) => h.fake.callsTo("gamification", method, path);
const lessonsCalls = (method?: string, path?: string) => h.fake.callsTo("lessons", method, path);
const heroUrl = () => `/v1/game/assets/a-robot_0-2/${h.fake.game.assets.get("a-robot_0-2")!.sha256}`;
const MISSING = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";

async function kid(band: "6-9" | "10-13" = "6-9"): Promise<{ kid: LoggedIn; child: string }> {
  const child = h.fake.addChild(s.userId, "Мадина", band);
  h.fake.onboard(child);
  return { kid: await switchTo(h, s, child), child };
}

async function limitTo(policy: string, limit: number): Promise<void> {
  await h.close();
  await setup({ RATE_LIMIT_OVERRIDE_REFRESH_SECONDS: "1" });
  await testRedis().set(
    `${h.config.rateLimiting.keyPrefix}rl:override:${policy}`,
    JSON.stringify({ v: 1, limit, window_s: 60, burst: null, by: "staff-1", at: new Date().toISOString(), reason: "тест", expires_at: null }),
  );
  await new Promise((r) => setTimeout(r, 1100));
}

async function challenge(token = s.access): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await send("POST", "/v1/game/duels", { opponent_member_id: OTHER_MEMBER }, idem(), token);
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("лиги недели", () => {
  it("друзья, семья, общая: member_id, ник, герой (url BFF), XP, место, ≤ 3 значков — без user_id, Telegram, возраста, покупок, ошибок; claims", async () => {
    const res = await get("/v1/game/leagues");
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.week).toBe("2026-11-16");
    expect(b.friends.rows[0]).toEqual({
      member_id: OTHER_MEMBER,
      nickname: "Anvar_77",
      hero: { code: "robot_0", stage: 2, image: { asset_id: "a-robot_0-2", url: heroUrl(), width: 300, height: 460 } },
      xp: 340,
      place: 1,
      badges: ["first_lesson", "streak_7", "together_1"],
      me: false,
    });
    expect(b.friends.rows[1]).toMatchObject({ member_id: memberIdOf(s.userId), me: true, hero: null });
    expect(b.friends).toMatchObject({ me_row: null, participants: 2, total_xp: 460 });
    expect(b.friends).not.toHaveProperty("group_id");
    expect(b.general).toMatchObject({ opt_in: true, available: true, unavailable_reason: null, pair_id: "ru-en", level_band: "A2", prizes: [50, 30, 20] });
    for (const leak of [OTHER_USER_ID, s.userId, String(OTHER_TELEGRAM_ID), "purchases", "errors_week", "age_band"]) expect(res.body).not.toContain(leak);
    const call = gameCalls("GET", "/internal/v1/game/leagues")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ lrn: s.userId, age_band: "18+" });
  });

  it("рейтинг — не больше 50 строк", async () => {
    h.fake.social7.leaguesRows = 60;
    const b = (await get("/v1/game/leagues")).json();
    expect(b.general.group.rows).toHaveLength(50);
    expect(b.general.group.participants).toBe(60);
  });

  it("детский профиль: lrn и age_band ребёнка; лиги друзей и общей нет, даже если домен прислал (предупреждение в лог)", async () => {
    const { kid: k, child } = await kid("6-9");
    const ok = (await get("/v1/game/leagues", k.access)).json();
    expect(ok.friends).toBeNull();
    expect(ok.family.rows).toHaveLength(2);
    expect(gameCalls("GET", "/internal/v1/game/leagues").at(-1)!.claims).toMatchObject({ lrn: child, age_band: "6-9" });
    h.fake.social7.kidsLeagueLeak = true;
    const res = await get("/v1/game/leagues", k.access);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.friends).toBeNull();
    expect(b.general).toEqual({ opt_in: false, available: false, unavailable_reason: "kids", pair_id: "ru-en", level_band: "A2", group: null, prizes: [50, 30, 20] });
    expect(h.logs.parsed().some((l) => l.rule === "kids_no_strangers")).toBe(true);
  });

  it("детская полоса аккаунта (10–13) — те же правила, что у детского профиля", async () => {
    h.fake.setAge(s.userId, "10-13");
    h.fake.social7.kidsLeagueLeak = true;
    const b = (await get("/v1/game/leagues")).json();
    expect(b.friends).toBeNull();
    expect(b.general).toMatchObject({ available: false, unavailable_reason: "kids", group: null });
    expect(gameCalls("GET", "/internal/v1/game/leagues")[0]!.claims).toMatchObject({ lrn: s.userId, age_band: "10-13" });
  });

  it("история: страница итогов (лишнее домена отброшено); league_opt_in — PATCH /v1/game/settings, коды gamification — как есть", async () => {
    const hist = await get("/v1/game/leagues/history?cursor=w1");
    expect(hist.json()).toEqual({
      items: [{ week: "2026-11-09", pair_id: "ru-en", level_band: "A2", place: 2, participants: 24, xp: 410, prize_til: 30, prize_held: false, version: 1, closed_at: "2026-11-16T00:05:00Z" }],
      next_cursor: null,
    });
    expect(gameCalls("GET", "/internal/v1/game/leagues/history")[0]!.query).toEqual({ cursor: "w1" });
    const on = await send("PATCH", "/v1/game/settings", { league_opt_in: true });
    expect([on.statusCode, on.json().league_opt_in]).toEqual([200, true]);
    expect(gameCalls("PATCH", "/internal/v1/game/settings")[0]!.body).toEqual({ league_opt_in: true });
    h.fake.override("gamification", "PATCH", "/internal/v1/game/settings", () => domainError(409, "NICKNAME_REQUIRED"));
    const r = await send("PATCH", "/v1/game/settings", { league_opt_in: true });
    expect([r.statusCode, r.json().code]).toEqual([409, "NICKNAME_REQUIRED"]);
    expect((await send("PATCH", "/v1/game/settings", { league_opt_in: "yes" })).statusCode).toBe(422);
  });
});

describe("включение общей лиги: доступность социального — в social до gamification", () => {
  const optIn = (token = s.access, body: Record<string, unknown> = { league_opt_in: true }) => send("PATCH", "/v1/game/settings", body, {}, token);
  const socialCommunity = () => h.fake.callsTo("social", "GET", "/internal/v1/me/community");

  it("доступно: social GET /me/community (lrn, age_band) → gamification PATCH; выключение и прочие поля — без social", async () => {
    const on = await optIn();
    expect([on.statusCode, on.json().league_opt_in]).toEqual([200, true]);
    const c = socialCommunity()[0]!;
    expect(c.subject).toBe(s.userId);
    expect(c.claims).toMatchObject({ aud: "social", lrn: s.userId, age_band: "18+" });
    expect(gameCalls("PATCH", "/internal/v1/game/settings")).toHaveLength(1);
    expect((await optIn(s.access, { league_opt_in: false })).json().league_opt_in).toBe(false);
    expect((await optIn(s.access, { auto_freeze: false })).statusCode).toBe(200);
    expect(socialCommunity()).toHaveLength(1);
    expect(gameCalls("PATCH", "/internal/v1/game/settings")).toHaveLength(3);
  });

  it("недоступно: guardian_consent и kids — 403 FRIENDS_NOT_ALLOWED {reason}, consent — 403 CONSENT_REQUIRED {purpose: social}; gamification не вызывается", async () => {
    for (const [reason, code, details] of [
      ["guardian_consent", "FRIENDS_NOT_ALLOWED", { reason: "guardian_consent" }],
      ["kids", "FRIENDS_NOT_ALLOWED", { reason: "kids" }],
      ["consent", "CONSENT_REQUIRED", { purpose: "social" }],
    ] as const) {
      h.fake.social7.friendsReason = reason;
      const r = await optIn(s.access, { league_opt_in: true, quests_hidden: true });
      expect([r.statusCode, r.json().code, r.json().details], reason).toEqual([403, code, details]);
    }
    expect(gameCalls("PATCH", "/internal/v1/game/settings")).toHaveLength(0);
    // выключить можно всегда
    expect((await optIn(s.access, { league_opt_in: false })).statusCode).toBe(200);
  });

  it("проверка в домене дополняет BFF: 403 FRIENDS_NOT_ALLOWED {reason: guardian_consent} от gamification — клиенту как есть, не 5xx", async () => {
    h.fake.override("gamification", "PATCH", "/internal/v1/game/settings", () => domainError(403, "FRIENDS_NOT_ALLOWED", { reason: "guardian_consent" }));
    const r = await optIn();
    expect([r.statusCode, r.json().code, r.json().details]).toEqual([403, "FRIENDS_NOT_ALLOWED", { reason: "guardian_consent" }]);
    expect(socialCommunity()).toHaveLength(1);
    expect(gameCalls("PATCH", "/internal/v1/game/settings")).toHaveLength(1);
    expect(h.logs.text).not.toContain("domain unavailable");
  });

  it("детский профиль — 403 KIDS_NOT_ALLOWED без вызова social и gamification; выключение — можно", async () => {
    const { kid: k } = await kid("6-9");
    const r = await optIn(k.access);
    expect([r.statusCode, r.json().code]).toEqual([403, "KIDS_NOT_ALLOWED"]);
    expect(socialCommunity()).toHaveLength(0);
    expect(gameCalls("PATCH", "/internal/v1/game/settings")).toHaveLength(0);
    expect((await optIn(k.access, { league_opt_in: false })).statusCode).toBe(200);
  });

  it("social недоступен или ответ не по контракту → 503 {service: social}, gamification не вызывается; лимит tg.game.write — один на запрос", async () => {
    h.fake.down.add("social");
    const down = await optIn();
    expect([down.statusCode, down.json().code, down.json().details]).toEqual([503, "UPSTREAM_UNAVAILABLE", { service: "social" }]);
    h.fake.down.delete("social");
    h.fake.social7.rawUuidProfile = true;
    expect((await optIn()).json().details).toEqual({ service: "social" });
    expect(gameCalls("PATCH", "/internal/v1/game/settings")).toHaveLength(0);
    await limitTo("tg.game.write", 2);
    expect((await optIn()).statusCode).toBe(200);
    expect((await optIn()).statusCode).toBe(200);
    const r = await optIn();
    expect([r.statusCode, r.json().details.policy]).toEqual([429, "tg.game.write"]);
    expect(socialCommunity()).toHaveLength(2);
  });
});

describe("дуэли", () => {
  it("вызов: Idempotency-Key обязателен и пробрасывается; 201, повтор — 200 тот же; соперник — member_id, ник, герой; счёт до завершения скрыт", async () => {
    const none = await send("POST", "/v1/game/duels", { opponent_member_id: OTHER_MEMBER });
    expect([none.statusCode, none.json().code]).toEqual([422, "IDEMPOTENCY_KEY_REQUIRED"]);
    for (const bad of [{ opponent_member_id: OTHER_USER_ID }, { opponent_member_id: OTHER_MEMBER, pair_id: "RU_EN" }, { opponent_member_id: OTHER_MEMBER, opponent_user_id: OTHER_USER_ID }, {}]) {
      const r = await send("POST", "/v1/game/duels", bad, idem());
      expect([r.statusCode, r.json().code], JSON.stringify(bad)).toEqual([422, "VALIDATION_ERROR"]);
    }
    expect(gameCalls()).toHaveLength(0);
    const key = idem();
    const first = await send("POST", "/v1/game/duels", { opponent_member_id: OTHER_MEMBER, pair_id: "ru-en" }, key);
    expect(first.statusCode).toBe(201);
    const d = first.json();
    expect(d).toMatchObject({ status: "challenged", role: "challenger", opponent: { member_id: OTHER_MEMBER, nickname: "Anvar_77", hero: { code: "robot_0", stage: 2 } }, result: null, my_session: null });
    expect(d.opponent.hero.image.url).toBe(heroUrl());
    for (const leak of [OTHER_USER_ID, s.userId, "opponent_answers", "scores"]) expect(first.body).not.toContain(leak);
    const again = await send("POST", "/v1/game/duels", { opponent_member_id: OTHER_MEMBER, pair_id: "ru-en" }, key);
    expect([again.statusCode, again.json()]).toEqual([200, d]);
    const call = gameCalls("POST", "/internal/v1/game/duels")[0]!;
    expect(call.headers["idempotency-key"]).toBe(key["idempotency-key"]);
    expect(call.body).toEqual({ opponent_member_id: OTHER_MEMBER, pair_id: "ru-en" });
    expect(call.claims).toMatchObject({ lrn: s.userId, age_band: "18+" });
    const blocked = await send("POST", "/v1/game/duels", { opponent_member_id: BLOCKED_MEMBER }, idem());
    expect([blocked.statusCode, blocked.json().code]).toEqual([403, "BLOCKED"]);
    h.fake.override("gamification", "POST", "/internal/v1/game/duels", () => domainError(409, "DUEL_EXISTS", { duel_id: d.duel_id }));
    const exists = await send("POST", "/v1/game/duels", { opponent_member_id: OTHER_MEMBER }, idem());
    expect([exists.statusCode, exists.json().code, exists.json().details]).toEqual([409, "DUEL_EXISTS", { duel_id: d.duel_id }]);
  });

  it("список, карточка, принять, отказаться; счёт — только у finished; неверный duel_id — 404 DUEL_NOT_FOUND без вызова", async () => {
    const d = await challenge();
    const list = await get("/v1/game/duels?status=active&cursor=x");
    expect(list.json()).toEqual({ items: [d], next_cursor: null });
    expect(gameCalls("GET", "/internal/v1/game/duels")[0]!.query).toEqual({ status: "active", cursor: "x" });
    expect((await get("/v1/game/duels?status=all")).statusCode).toBe(422);
    expect((await get(`/v1/game/duels/${d.duel_id.toUpperCase()}`)).json()).toEqual(d);
    const acc = await send("POST", `/v1/game/duels/${d.duel_id}/accept`);
    expect(acc.json()).toMatchObject({ status: "accepted", can_play: true, result: null, my_session: { status: "in_progress" } });
    // завершённая — счёт обоих
    h.fake.social7.duels.get(d.duel_id)!.status = "finished";
    const fin = await get(`/v1/game/duels/${d.duel_id}`);
    expect(fin.json().result).toEqual({ outcome: "win", technical: false, my_score: { correct: 7, total: 10 }, opponent_score: { correct: 5, total: 10 }, xp: 30, version: 1 });
    const n = gameCalls().length;
    for (const url of ["/v1/game/duels/abc", "/v1/game/duels/abc/accept", "/v1/game/duels/abc/decline"]) {
      const r = url.endsWith("/abc") ? await get(url) : await send("POST", url);
      expect([r.statusCode, r.json().code], url).toEqual([404, "DUEL_NOT_FOUND"]);
    }
    expect(gameCalls()).toHaveLength(n);
    const missing = await get(`/v1/game/duels/${MISSING}`);
    expect([missing.statusCode, missing.json().code]).toEqual([404, "DUEL_NOT_FOUND"]);
    // элемент списка с «сырым» UUID соперника — отброшен
    h.fake.social7.rawUuidItem = true;
    const l2 = await get("/v1/game/duels?status=finished");
    expect(l2.json().items).toHaveLength(1);
    expect(l2.body).not.toContain(OTHER_USER_ID);
  });

  it("принятие: 503 DUEL_SET_UNAVAILABLE от gamification — клиенту как есть (дуэль остаётся challenged, можно повторить)", async () => {
    const d = await challenge();
    h.fake.social7.duelSetUnavailable = true;
    const r = await send("POST", `/v1/game/duels/${d.duel_id}/accept`);
    expect([r.statusCode, r.json().code]).toEqual([503, "DUEL_SET_UNAVAILABLE"]);
    h.fake.social7.duelSetUnavailable = false;
    expect((await send("POST", `/v1/game/duels/${d.duel_id}/accept`)).json().status).toBe("accepted");
    const dec = await send("POST", `/v1/game/duels/${d.duel_id}/decline`, undefined, idem());
    expect(dec.json().status).toBe("declined");
  });

  it("детский профиль: вызов члена семьи по member_id из /v1/family — lrn и age_band ребёнка", async () => {
    const { kid: k, child } = await kid("10-13");
    h.fake.families.set(s.userId, {
      family_id: "f-1",
      members: [
        { user_id: s.userId, member_id: memberIdOf(s.userId), display_name: "Игорь", role: "owner", is_me: false },
        { user_id: child, member_id: memberIdOf(child), display_name: "Мадина", role: "child", is_me: false },
      ],
    });
    h.fake.social7.members.add(memberIdOf(s.userId));
    const fam = (await get("/v1/family", k.access)).json();
    const parent = fam.members.find((m: { is_me: boolean; role: string }) => m.role === "owner");
    expect(fam.members.find((m: { is_me: boolean }) => m.is_me).member_id).toBe(memberIdOf(child));
    const r = await send("POST", "/v1/game/duels", { opponent_member_id: parent.member_id }, idem(), k.access);
    expect(r.statusCode).toBe(201);
    const call = gameCalls("POST", "/internal/v1/game/duels").at(-1)!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ lrn: child, age_band: "10-13" });
    expect(call.body).toEqual({ opponent_member_id: memberIdOf(s.userId) });
  });
});

describe("задания дуэли (lessons)", () => {
  it("сессия kind duel: Idempotency-Key, 201, повтор — 200 та же; дальше — общие маршруты сессий", async () => {
    const d = await challenge();
    expect((await send("POST", "/v1/duel-sessions", { duel_id: d.duel_id })).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await send("POST", "/v1/duel-sessions", { duel_id: "x" }, idem())).statusCode).toBe(422);
    const first = await send("POST", "/v1/duel-sessions", { duel_id: d.duel_id.toUpperCase() }, idem());
    expect(first.statusCode).toBe(201);
    const sess = first.json();
    expect(sess).toMatchObject({ kind: "duel", status: "in_progress", stage: "assessment", ai_mode: "choices" });
    expect(sess).not.toHaveProperty("duel_id");
    expect(sess).not.toHaveProperty("set_id");
    const again = await send("POST", "/v1/duel-sessions", { duel_id: d.duel_id }, idem());
    expect([again.statusCode, again.json().session_id]).toEqual([200, sess.session_id]);
    const call = lessonsCalls("POST", "/internal/v1/me/duel-sessions")[0]!;
    expect(call.body).toEqual({ duel_id: d.duel_id });
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ aud: "lessons", lrn: s.userId, age_band: "18+" });
    // общий маршрут сессии отдаёт kind duel
    h.fake.override("lessons", "GET", `/internal/v1/sessions/${sess.session_id}`, () => json(200, { ...sess, duel_id: d.duel_id }));
    const g = await get(`/v1/sessions/${sess.session_id}`);
    expect([g.statusCode, g.json().kind]).toEqual([200, "duel"]);
    // в истории ?kind=duel не фильтруется (её там нет)
    expect((await get("/v1/sessions?kind=duel")).statusCode).toBe(422);
  });

  it("разбор: только свои ответы (ответов соперника нет никогда); 409 DUEL_NOT_FINISHED как есть; неверный id — 404 SESSION_NOT_FOUND", async () => {
    const d = await challenge();
    const sess = (await send("POST", "/v1/duel-sessions", { duel_id: d.duel_id }, idem())).json();
    const res = await get(`/v1/duel-sessions/${sess.session_id}/review`);
    expect(res.json()).toEqual({
      session_id: sess.session_id,
      duel_id: d.duel_id,
      score: { correct: 1, total: 2 },
      items: [
        { item_id: "i1", prompt_en: "I ___ a student.", your_answer: "am", correct_answer: "am", correct: true },
        { item_id: "i2", prompt_en: "She ___ tea.", your_answer: null, correct_answer: "likes", correct: false },
      ],
    });
    expect(res.body).not.toContain(OTHER_USER_ID);
    expect(res.body).not.toContain("opponent");
    h.fake.social7.duelNotFinished = true;
    const early = await get(`/v1/duel-sessions/${sess.session_id}/review`);
    expect([early.statusCode, early.json().code]).toEqual([409, "DUEL_NOT_FINISHED"]);
    const bad = await get("/v1/duel-sessions/nope/review");
    expect([bad.statusCode, bad.json().code]).toEqual([404, "SESSION_NOT_FOUND"]);
    const missing = await get(`/v1/duel-sessions/${MISSING}/review`);
    expect([missing.statusCode, missing.json().code]).toEqual([404, "SESSION_NOT_FOUND"]);
  });

  it("новые коды lessons — как есть: 409 DUEL_SET_CONFLICT, DUEL_CLOSED", async () => {
    for (const code of ["DUEL_SET_CONFLICT", "DUEL_CLOSED"]) {
      h.fake.override("lessons", "POST", "/internal/v1/me/duel-sessions", () => domainError(409, code));
      const r = await send("POST", "/v1/duel-sessions", { duel_id: MISSING }, idem());
      expect([r.statusCode, r.json().code], code).toEqual([409, code]);
    }
  });
});

describe("лимиты и недоступность", () => {
  it("tg.duel.write: вызов, принятие и сессия дуэли — общий счётчик; чтение — tg.game.read", async () => {
    await limitTo("tg.duel.write", 2);
    const d = await challenge();
    expect((await send("POST", `/v1/game/duels/${d.duel_id}/accept`)).statusCode).toBe(200);
    const r = await send("POST", "/v1/duel-sessions", { duel_id: d.duel_id }, idem());
    expect([r.statusCode, r.json().details.policy]).toEqual([429, "tg.duel.write"]);
    expect(lessonsCalls("POST", "/internal/v1/me/duel-sessions")).toHaveLength(0);
    expect((await get("/v1/game/duels")).statusCode).toBe(200);
  });

  it("tg.game.read: лиги и дуэли — тот же счётчик, что игра спринта 6", async () => {
    await limitTo("tg.game.read", 2);
    expect((await get("/v1/game/leagues")).statusCode).toBe(200);
    expect((await get("/v1/game/summary")).statusCode).toBe(200);
    const r = await get("/v1/game/duels");
    expect([r.statusCode, r.json().details.policy]).toEqual([429, "tg.game.read"]);
  });

  it("gamification лежит, 5xx или ответ не по контракту → 503 GAME_UNAVAILABLE {service: gamification}; без адреса — то же без вызова", async () => {
    const urls: Array<[Method, string, unknown?]> = [
      ["GET", "/v1/game/leagues"],
      ["GET", "/v1/game/leagues/history"],
      ["GET", "/v1/game/duels"],
      ["GET", `/v1/game/duels/${MISSING}`],
      ["POST", "/v1/game/duels", { opponent_member_id: OTHER_MEMBER }],
      ["POST", `/v1/game/duels/${MISSING}/accept`],
      ["POST", `/v1/game/duels/${MISSING}/decline`],
    ];
    h.fake.down.add("gamification");
    for (const [m, url, body] of urls) {
      const r = await send(m, url, body, m === "POST" ? idem() : {});
      expect([r.statusCode, r.json().code, r.json().details], url).toEqual([503, "GAME_UNAVAILABLE", { service: "gamification" }]);
    }
    h.fake.down.delete("gamification");
    h.fake.override("gamification", "GET", "/internal/v1/game/leagues", () => json(200, { week: "2026-11-16", friends: "x" }));
    expect((await get("/v1/game/leagues")).json().code).toBe("GAME_UNAVAILABLE");
    h.fake.override("gamification", "GET", "/internal/v1/game/leagues", () => domainError(500, "BOOM"));
    expect((await get("/v1/game/leagues")).json().code).toBe("GAME_UNAVAILABLE");
    // картинка героя соперника чужого вида (внутренний адрес) — ответ не по контракту, адрес наружу не уходит
    await challenge();
    h.fake.game.imageMode = "bad_url";
    const bad = await get("/v1/game/duels");
    expect([bad.statusCode, bad.json().code]).toEqual([503, "GAME_UNAVAILABLE"]);
    expect(bad.body).not.toContain("railway.internal");

    await h.close();
    await setup({ GAMIFICATION_URL: "" });
    for (const [m, url, body] of urls) {
      const r = await send(m, url, body, m === "POST" ? idem() : {});
      expect([r.statusCode, r.json().code], url).toEqual([503, "GAME_UNAVAILABLE"]);
    }
    expect(gameCalls()).toHaveLength(0);
    expect((await get("/v1/plan/today")).statusCode).toBe(200);
  });

  it("lessons лежит → 503 UPSTREAM_UNAVAILABLE {service: lessons} у заданий дуэли", async () => {
    h.fake.down.add("lessons");
    const r = await send("POST", "/v1/duel-sessions", { duel_id: MISSING }, idem());
    expect([r.statusCode, r.json().code, r.json().details]).toEqual([503, "UPSTREAM_UNAVAILABLE", { service: "lessons" }]);
    const rv = await get(`/v1/duel-sessions/${MISSING}/review`);
    expect([rv.statusCode, rv.json().details]).toEqual([503, { service: "lessons" }]);
  });
});

/**
 * Спринт 7 через BFF — парный урок в lessons (bff.ts «Спринт 7», INTERNAL_API спринта 7 §3.2, §9): приглашение, список,
 * ответ, вход, присутствие, лента long-poll (таймаут больше 25 с у lessons, отмена клиентом), ходы, голос (сырое тело
 * audio/wav ≤ 600 000 байт), отчёт. Субъект — аккаунт, claims lrn и age_band; партнёр — member_id, ник, герой; отчёт —
 * только свой; дети — выбор реплик без голоса; сбой lessons → 503 UPSTREAM_UNAVAILABLE {service: lessons}; лимиты tg.room.*.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOCKED_MEMBER, OTHER_MEMBER, OTHER_NAME, OTHER_USER_ID } from "./fakeSocial.js";
import { bearer, closeRedis, domainError, idem, json, login, makeHarness, switchTo, testRedis, type Harness, type LoggedIn } from "./helpers.js";
import { AUDIO_MARK, makeWav } from "./wavFixture.js";

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

type Method = "GET" | "POST";
const get = (url: string, token = s.access, headers: Record<string, string> = {}) => h.app.inject({ url, headers: { ...bearer(token), ...headers } });
const send = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}, token = s.access) =>
  h.app.inject({ method, url, headers: { ...bearer(token), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const audio = (roomId: string, body: Buffer, contentType = "audio/wav", token = s.access) =>
  h.app.inject({ method: "POST", url: `/v1/pair-rooms/${roomId}/audio`, headers: { ...bearer(token), "content-type": contentType }, payload: body });
const lessonsCalls = (method?: string, path?: string) => h.fake.callsTo("lessons", method, path);
const ROOM = "6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f";
const statePath = (id = ROOM) => `/internal/v1/me/pair-rooms/${id}/state`;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  await sleep(1100);
}

const INVITE = { partner_member_id: OTHER_MEMBER, pair_id: "ru-en", scenario_id: "sc-cafe-order", start: "now" };
async function invite(token = s.access): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await send("POST", "/v1/pair-rooms", INVITE, idem(), token);
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("приглашение и список", () => {
  it("приглашение: Idempotency-Key обязателен и пробрасывается; 201, повтор — 200 то же; партнёр — member_id, ник, герой; служебное отброшено", async () => {
    expect((await send("POST", "/v1/pair-rooms", INVITE)).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const key = idem();
    const first = await send("POST", "/v1/pair-rooms", INVITE, key);
    expect(first.statusCode).toBe(201);
    const v = first.json();
    expect(v).toMatchObject({
      status: "invited",
      side: "inviter",
      partner: { member_id: OTHER_MEMBER, nickname: "Anvar_77", hero: { code: "robot_0", stage: 2 } },
      pair_id: "ru-en",
      scenario: { scenario_id: "sc-cafe-order", title: { ru: "В кафе", uz: "В кафе (uz)" }, level: "A1" },
      mode: "free",
      minutes: 0,
      report_available: false,
    });
    expect(v.partner.hero.image.url).toMatch(/^\/v1\/game\/assets\/a-robot_0-2\/[0-9a-f]{64}$/);
    for (const leak of [OTHER_USER_ID, s.userId, OTHER_NAME, "ai_cost_usd", "rubric_id"]) expect(first.body).not.toContain(leak);
    const again = await send("POST", "/v1/pair-rooms", INVITE, key);
    expect([again.statusCode, again.json()]).toEqual([200, v]);
    const call = lessonsCalls("POST", "/internal/v1/me/pair-rooms")[0]!;
    expect(call.headers["idempotency-key"]).toBe(key["idempotency-key"]);
    expect(call.body).toEqual(INVITE);
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ aud: "lessons", lrn: s.userId, age_band: "18+" });
  });

  it("вход: start — now или ISO не в прошлом и не дальше 7 дней; member_id, пара, сценарий — по формату; иначе 422 без вызова", async () => {
    for (const bad of [
      { ...INVITE, start: inDays(-1) },
      { ...INVITE, start: inDays(8) },
      { ...INVITE, start: "tomorrow" },
      { ...INVITE, start: "2026-13-45T25:00:00Z" },
      { ...INVITE, start: "2026-11-25T10:00:00" },
      { ...INVITE, partner_member_id: OTHER_USER_ID },
      { ...INVITE, pair_id: "russian" },
      { ...INVITE, scenario_id: "../x" },
      { ...INVITE, partner_user_id: OTHER_USER_ID },
    ]) {
      const r = await send("POST", "/v1/pair-rooms", bad, idem());
      expect([r.statusCode, r.json().code], JSON.stringify(bad)).toEqual([422, "VALIDATION_ERROR"]);
    }
    expect(lessonsCalls()).toHaveLength(0);
    const later = await send("POST", "/v1/pair-rooms", { ...INVITE, start: inDays(2) }, idem());
    expect(later.statusCode).toBe(201);
    const blocked = await send("POST", "/v1/pair-rooms", { ...INVITE, partner_member_id: BLOCKED_MEMBER }, idem());
    expect([blocked.statusCode, blocked.json().code]).toEqual([403, "BLOCKED"]);
    h.fake.override("lessons", "POST", "/internal/v1/me/pair-rooms", () => domainError(409, "ROOM_LIMIT", { room_id: ROOM }));
    const limit = await send("POST", "/v1/pair-rooms", INVITE, idem());
    expect([limit.statusCode, limit.json().code, limit.json().details]).toEqual([409, "ROOM_LIMIT", { room_id: ROOM }]);
  });

  it("список, карточка, принять, отклонить, отменить, выйти — пути lessons; неверный room_id — 404 ROOM_NOT_FOUND без вызова; 409 как есть", async () => {
    const v = await invite();
    const list = await get("/v1/pair-rooms?status=active&cursor=k");
    expect(list.json()).toEqual({ items: [v], next_cursor: null });
    expect(lessonsCalls("GET", "/internal/v1/me/pair-rooms")[0]!.query).toMatchObject({ status: "active", cursor: "k" });
    expect((await get("/v1/pair-rooms?status=open")).statusCode).toBe(422);
    expect((await get(`/v1/pair-rooms/${v.room_id.toUpperCase()}`)).json()).toEqual(v);
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/accept`)).json().status).toBe("waiting");
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/cancel`, undefined, idem())).json().status).toBe("cancelled");
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/decline`)).json().status).toBe("declined");
    const st = await send("POST", `/v1/pair-rooms/${v.room_id}/cancel`);
    expect([st.statusCode, st.json().code, st.json().details]).toEqual([409, "ROOM_STATE", { status: "declined" }]);
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/leave`)).json().status).toBe("abandoned");
    for (const a of ["accept", "decline", "cancel", "leave"]) expect(lessonsCalls("POST", `/internal/v1/me/pair-rooms/${v.room_id}/${a}`).length, a).toBeGreaterThan(0);
    const n = lessonsCalls().length;
    for (const [m, url] of [["GET", "/v1/pair-rooms/abc"], ["POST", "/v1/pair-rooms/abc/join"], ["GET", "/v1/pair-rooms/abc/state"], ["POST", "/v1/pair-rooms/abc/heartbeat"], ["GET", "/v1/pair-rooms/abc/report"]] as const) {
      const r = await send(m, url);
      expect([r.statusCode, r.json().code], url).toEqual([404, "ROOM_NOT_FOUND"]);
    }
    expect(lessonsCalls()).toHaveLength(n);
    const missing = await get(`/v1/pair-rooms/${ROOM}`);
    expect([missing.statusCode, missing.json().code]).toEqual([404, "ROOM_NOT_FOUND"]);
  });
});

describe("комната: вход, присутствие, лента, ходы, отчёт", () => {
  it("вход → лента: роли A/B без id, ≤ 3 вариантов, перевод подсказки на языке ученика; служебное (секунды партнёра, стоимость) отброшено", async () => {
    const v = await invite();
    const res = await send("POST", `/v1/pair-rooms/${v.room_id}/join`, undefined, { "accept-language": "uz" });
    expect(res.statusCode).toBe(200);
    const st = res.json();
    expect(st).toMatchObject({ status: "in_progress", mode: "free", my_role: "A", next_speaker: "A", prompt: "What would you like to drink?", prompt_gloss: "Nima ichasiz?", voice_available: true, my_speaking_seconds: 12 });
    expect(st.options).toHaveLength(3);
    expect(st.participants).toEqual([
      { role: "A", me: true, network: "online" },
      { role: "B", me: false, network: "online" },
    ]);
    expect(st.events[1]).toEqual({ seq: 2, kind: "turn", role: "B", text: "I'd like a coffee, please.", at: "2026-11-20T09:00:00Z" });
    for (const leak of [OTHER_USER_ID, s.userId, "Anvar_77", "partner_speaking_seconds", "ai_cost_usd"]) expect(res.body).not.toContain(leak);
    expect(lessonsCalls("POST", `/internal/v1/me/pair-rooms/${v.room_id}/join`)[0]!.query).toMatchObject({ locale: "uz" });
    // строкой — как есть
    h.fake.social7.glossAsObject = false;
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/join`)).json().prompt_gloss).toBe("Что вы будете пить?");
  });

  it("лента: after_seq и locale — в lessons; событий больше 50 — первые 50 и seq последнего отданного", async () => {
    const v = await invite();
    const r = await get(`/v1/pair-rooms/${v.room_id}/state?after_seq=5&locale=ru`);
    expect(r.statusCode).toBe(200);
    expect(r.json().prompt_gloss).toBe("Что вы будете пить?");
    expect(lessonsCalls("GET", statePath(v.room_id))[0]!.query).toEqual({ after_seq: "5", locale: "ru" });
    for (const q of ["after_seq=-1", "after_seq=x", "locale=en", "user_id=x"]) expect((await get(`/v1/pair-rooms/${v.room_id}/state?${q}`)).statusCode, q).toBe(422);
    h.fake.social7.stateEvents = 70;
    const big = (await get(`/v1/pair-rooms/${v.room_id}/state?after_seq=0`)).json();
    expect(big.events).toHaveLength(50);
    expect(big.seq).toBe(50);
  });

  it("присутствие — 204; ход: Idempotency-Key, ровно одно поле, текст обрезан и не в логе; повтор ключа — тот же ответ", async () => {
    const v = await invite();
    const hb = await send("POST", `/v1/pair-rooms/${v.room_id}/heartbeat`);
    expect([hb.statusCode, hb.body]).toEqual([204, ""]);
    expect(lessonsCalls("POST", `/internal/v1/me/pair-rooms/${v.room_id}/heartbeat`)).toHaveLength(1);
    const url = `/v1/pair-rooms/${v.room_id}/turns`;
    expect((await send("POST", url, { choice_id: "c1" })).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    for (const bad of [{}, { text: "hi", choice_id: "c1" }, { text: "" }, { text: "   " }, { text: "x".repeat(301) }, { choice_id: "a b" }, { audio_id: "" }, { text: "hi", user_id: "x" }]) {
      const r = await send("POST", url, bad, idem());
      expect([r.statusCode, r.json().code], JSON.stringify(bad)).toEqual([422, "VALIDATION_ERROR"]);
    }
    expect(lessonsCalls("POST", `/internal/v1/me/pair-rooms/${v.room_id}/turns`)).toHaveLength(0);
    const key = idem();
    const t = await send("POST", url, { text: "  TURN-SECRET two teas, please  " }, key);
    expect(t.statusCode).toBe(200);
    expect(lessonsCalls("POST", `/internal/v1/me/pair-rooms/${v.room_id}/turns`)[0]!.body).toEqual({ text: "TURN-SECRET two teas, please" });
    expect(lessonsCalls("POST", `/internal/v1/me/pair-rooms/${v.room_id}/turns`)[0]!.headers["idempotency-key"]).toBe(key["idempotency-key"]);
    expect((await send("POST", url, { text: "  TURN-SECRET two teas, please  " }, key)).json()).toEqual(t.json());
    expect((await send("POST", url, { choice_id: "c1" }, idem())).statusCode).toBe(200);
    expect((await send("POST", url, { audio_id: "au_1" }, idem())).statusCode).toBe(200);
    expect((await send("POST", url, { text: "x".repeat(300) }, idem())).statusCode).toBe(200);
    expect(h.logs.text).not.toContain("TURN-SECRET");
    for (const code of ["NOT_YOUR_TURN", "FREE_TEXT_NOT_ALLOWED", "ROOM_NOT_ACTIVE"]) {
      h.fake.override("lessons", "POST", `/internal/v1/me/pair-rooms/${v.room_id}/turns`, () => domainError(409, code));
      const not = await send("POST", url, { text: "Hello there" }, idem());
      expect([not.statusCode, not.json().code], code).toEqual([409, code]);
    }
  });

  it("отчёт — только свой: мои реплики, секунды, навыки, ≤ 3 подсказки; реплики, ошибки и оценки партнёра отброшены", async () => {
    const v = await invite();
    const res = await get(`/v1/pair-rooms/${v.room_id}/report`);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.me).toMatchObject({ role: "A", contributed: true, turns: 4, speaking_seconds: 40, minutes: 12, lines: [{ text: "A tea, please.", at: "2026-11-20T09:00:00Z" }], evaluation_id: "1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b" });
    expect(r.me.tips).toHaveLength(3);
    expect(r.team).toEqual({ goal_reached: true, progress: 1, summary: { ru: "Отличная командная работа", uz: "Отличная командная работа (uz)" } });
    expect(r).not.toHaveProperty("partner");
    for (const leak of ["PARTNER-SECRET-LINE", "she go", OTHER_USER_ID, OTHER_MEMBER, "7a8b9c0d"]) expect(res.body).not.toContain(leak);
  });
});

describe("long-poll ленты", () => {
  it("BFF ждёт lessons дольше общего таймаута lessons (PAIR_ROOM_POLL_TIMEOUT_MS), без повторов; дольше — 503 {service: lessons} и прерывание вызова", async () => {
    await h.close();
    await setup({ LESSONS_TIMEOUT_MS: "1000", PAIR_ROOM_POLL_TIMEOUT_MS: "2500", UPSTREAM_RETRIES: "1" });
    const delayed = (ms: number, seen: { aborted: boolean }) => async (r: { signal?: AbortSignal | null }) => {
      r.signal?.addEventListener("abort", () => (seen.aborted = true), { once: true });
      await sleep(ms);
      return json(200, { ...h.fake.social7.state(ROOM, { lrn: s.userId, kids: false, band: "18+" }) });
    };
    // 1,5 с: дольше общего таймаута lessons (1 с), но меньше таймаута ленты — ответ есть
    const ok = { aborted: false };
    h.fake.override("lessons", "GET", statePath(), delayed(1500, ok));
    const res = await get(`/v1/pair-rooms/${ROOM}/state?after_seq=2`);
    expect([res.statusCode, ok.aborted]).toEqual([200, false]);
    // обычный вызов lessons с той же задержкой — общий таймаут (1 с)
    h.fake.override("lessons", "GET", `/internal/v1/me/pair-rooms/${ROOM}`, delayed(1500, { aborted: false }));
    expect((await get(`/v1/pair-rooms/${ROOM}`)).json().details).toEqual({ service: "lessons" });
    // дольше таймаута ленты — 503, вызов прерван, повтора нет (UPSTREAM_RETRIES=1 к long-poll не применяется)
    const slow = { aborted: false };
    h.fake.override("lessons", "GET", statePath(), delayed(4000, slow));
    const before = lessonsCalls("GET", statePath()).length;
    const t0 = Date.now();
    const late = await get(`/v1/pair-rooms/${ROOM}/state?after_seq=2`);
    expect([late.statusCode, late.json().code, late.json().details]).toEqual([503, "UPSTREAM_UNAVAILABLE", { service: "lessons" }]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2400);
    expect(slow.aborted).toBe(true);
    expect(lessonsCalls("GET", statePath()).length - before).toBe(1);
  }, 40_000);

  it("таймауты по умолчанию: лента — 30 с (больше 25 с ожидания lessons), вход / ход / выход с ИИ-коучем — 30 с (≥ 25 с)", () => {
    expect(h.config.pairRoomPollTimeoutMs).toBe(30_000);
    expect(h.config.pairRoomCoachTimeoutMs).toBe(30_000);
    expect(h.config.pairRoomCoachTimeoutMs).toBeGreaterThanOrEqual(25_000);
  });

  it("вход, ход и выход ждут ИИ-коуча дольше общего таймаута lessons (PAIR_ROOM_COACH_TIMEOUT_MS), без повторов", async () => {
    await h.close();
    await setup({ LESSONS_TIMEOUT_MS: "1000", PAIR_ROOM_COACH_TIMEOUT_MS: "2500", UPSTREAM_RETRIES: "1" });
    const v = await invite();
    const state = () => json(200, h.fake.social7.state(v.room_id, { lrn: s.userId, kids: false, band: "18+" }));
    const slow = (ms: number, make: () => Response) => async () => {
      await sleep(ms);
      return make();
    };
    const base = `/internal/v1/me/pair-rooms/${v.room_id}`;
    h.fake.override("lessons", "POST", `${base}/join`, slow(1500, state));
    h.fake.override("lessons", "POST", `${base}/turns`, slow(1500, state));
    h.fake.override("lessons", "POST", `${base}/leave`, slow(1500, () => json(200, { ...v, status: "abandoned" })));
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/join`)).statusCode).toBe(200);
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/turns`, { choice_id: "c1" }, idem())).statusCode).toBe(200);
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/leave`)).json().status).toBe("abandoned");
    // принятие — обычный таймаут lessons (1 с)
    h.fake.override("lessons", "POST", `${base}/accept`, slow(1500, () => json(200, v)));
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/accept`)).json().details).toEqual({ service: "lessons" });
    // дольше таймаута коуча — 503, повтора нет
    h.fake.override("lessons", "POST", `${base}/turns`, slow(4000, state));
    const before = lessonsCalls("POST", `${base}/turns`).length;
    const late = await send("POST", `/v1/pair-rooms/${v.room_id}/turns`, { choice_id: "c1" }, idem());
    expect([late.statusCode, late.json().details]).toEqual([503, { service: "lessons" }]);
    expect(lessonsCalls("POST", `${base}/turns`).length - before).toBe(1);
  }, 40_000);

  it("клиент закрыл соединение — вызов lessons прерван (AbortSignal), запись в логе без ошибки домена", async () => {
    const seen = { aborted: false, started: false };
    h.fake.override("lessons", "GET", statePath(), async (r) => {
      seen.started = true;
      r.signal?.addEventListener("abort", () => (seen.aborted = true), { once: true });
      await sleep(3000);
      return json(200, h.fake.social7.state(ROOM, { lrn: s.userId, kids: false, band: "18+" }));
    });
    const address = await h.app.listen({ port: 0, host: "127.0.0.1" });
    const ac = new AbortController();
    const pending = fetch(`${address}/v1/pair-rooms/${ROOM}/state?after_seq=7`, { headers: bearer(s.access), signal: ac.signal }).catch((e: Error) => e.name);
    for (let i = 0; i < 50 && !seen.started; i++) await sleep(20);
    expect(seen.started).toBe(true);
    ac.abort();
    expect(await pending).toBe("AbortError");
    for (let i = 0; i < 50 && !seen.aborted; i++) await sleep(20);
    expect(seen.aborted).toBe(true);
    for (let i = 0; i < 50 && !h.logs.text.includes("long-poll cancelled by client"); i++) await sleep(20);
    expect(h.logs.text).toContain("long-poll cancelled by client");
    expect(h.logs.text).not.toContain("domain unavailable");
  }, 30_000);
});

describe("голосовой ход", () => {
  it("audio/wav → lessons байты как есть (audio/wav), ответ — PairAudio без служебного; аудио и текст не в логе", async () => {
    const v = await invite();
    const wav = makeWav({ ms: 2000 });
    const res = await audio(v.room_id, wav);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ audio_id: "au_1", text: "Two coffees, please.", duration_ms: 1000, expires_at: "2026-11-20T09:05:00Z" });
    const call = lessonsCalls("POST", `/internal/v1/me/pair-rooms/${v.room_id}/audio`)[0]!;
    expect(call.headers["content-type"]).toBe("audio/wav");
    expect(call.rawBody!.equals(wav)).toBe(true);
    expect(call.claims).toMatchObject({ lrn: s.userId, age_band: "18+" });
    expect(h.logs.text).not.toContain(AUDIO_MARK.toString());
    expect(h.logs.text).not.toContain("Two coffees");
    expect(h.logs.parsed().some((l) => l.msg === "pair room audio recognized" && l.audio_ms === 2000)).toBe(true);
    // синонимы типа
    expect((await audio(v.room_id, wav, "audio/x-wav")).statusCode).toBe(200);
  });

  it("тип и размер: не WAV — 422 format; больше 600 000 байт — too_large; заголовок не PCM 16 кГц моно — format; 0,5..15 с — too_short / too_long; без вызова lessons", async () => {
    const v = await invite();
    const cases: Array<[Buffer, string, string]> = [
      [makeWav(), "application/json", "format"],
      [makeWav(), "audio/mpeg", "format"],
      [Buffer.alloc(600_001, 1), "audio/wav", "too_large"],
      [makeWav({ sampleRate: 44_100 }), "audio/wav", "format"],
      [makeWav({ channels: 2 }), "audio/wav", "format"],
      [Buffer.from("RIFF----WAVEjunk"), "audio/wav", "format"],
      [makeWav({ truncated: true }), "audio/wav", "format"],
      [makeWav({ ms: 300 }), "audio/wav", "too_short"],
      [makeWav({ ms: 16_000 }), "audio/wav", "too_long"],
    ];
    for (const [body, type, reason] of cases) {
      const r = await audio(v.room_id, body, type);
      expect([r.statusCode, r.json().code, r.json().details], `${type} ${reason}`).toEqual([422, "AUDIO_INVALID", { reason }]);
    }
    expect(lessonsCalls("POST", `/internal/v1/me/pair-rooms/${v.room_id}/audio`)).toHaveLength(0);
    const bad = await audio("abc", makeWav());
    expect([bad.statusCode, bad.json().code]).toEqual([404, "ROOM_NOT_FOUND"]);
    // прочие маршруты по-прежнему не принимают audio/wav
    const json415 = await h.app.inject({ method: "POST", url: `/v1/pair-rooms/${v.room_id}/turns`, headers: { ...bearer(s.access), ...idem(), "content-type": "audio/wav" }, payload: makeWav() });
    expect(json415.statusCode).toBe(415);
  });

  it("коды lessons — как есть: 403 VOICE_CONSENT_REQUIRED {who}, 503 SPEECH_UNAVAILABLE, 409 NOT_YOUR_TURN", async () => {
    const v = await invite();
    for (const [status, code, details] of [[403, "VOICE_CONSENT_REQUIRED", { who: "guardian" }], [503, "SPEECH_UNAVAILABLE", {}], [409, "NOT_YOUR_TURN", {}]] as const) {
      h.fake.social7.audioError = { status, code, details };
      const r = await audio(v.room_id, makeWav());
      expect([r.statusCode, r.json().code, r.json().details], code).toEqual([status, code, details]);
    }
  });

  it("лимит tg.room.audio (30 за 10 минут)", async () => {
    await limitTo("tg.room.audio", 1, 600);
    const v = await invite();
    expect((await audio(v.room_id, makeWav())).statusCode).toBe(200);
    const r = await audio(v.room_id, makeWav());
    expect([r.statusCode, r.json().details.policy]).toEqual([429, "tg.room.audio"]);
    expect(lessonsCalls("POST", `/internal/v1/me/pair-rooms/${v.room_id}/audio`)).toHaveLength(1);
  });
});

describe("дети (6–13)", () => {
  it("детский профиль: lrn и age_band ребёнка; режим — choices, голос недоступен; текст хода и голос — 403 KIDS_NOT_ALLOWED до lessons (тело голоса не читается)", async () => {
    const { kid: k, child } = await kid("6-9");
    const v = await invite(k.access);
    expect(v.mode).toBe("choices");
    expect(lessonsCalls("POST", "/internal/v1/me/pair-rooms").at(-1)!.claims).toMatchObject({ lrn: child, age_band: "6-9" });
    h.fake.override("lessons", "POST", `/internal/v1/me/pair-rooms/${v.room_id}/join`, () => json(200, { ...h.fake.social7.state(v.room_id, { lrn: child, kids: false, band: null }), mode: "free" }));
    const st = (await send("POST", `/v1/pair-rooms/${v.room_id}/join`, undefined, {}, k.access)).json();
    expect([st.mode, st.voice_available]).toEqual(["choices", false]);
    const n = lessonsCalls().length;
    const text = await send("POST", `/v1/pair-rooms/${v.room_id}/turns`, { text: "hello" }, idem(), k.access);
    expect([text.statusCode, text.json().code]).toEqual([403, "KIDS_NOT_ALLOWED"]);
    // голос: отказ раньше разбора тела — даже на слишком большое
    for (const body of [makeWav(), Buffer.alloc(700_000, 1)]) {
      const r = await audio(v.room_id, body, "audio/wav", k.access);
      expect([r.statusCode, r.json().code]).toEqual([403, "KIDS_NOT_ALLOWED"]);
    }
    expect(lessonsCalls()).toHaveLength(n);
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/turns`, { choice_id: "c1" }, idem(), k.access)).statusCode).toBe(200);
  });

  it("детская полоса аккаунта (10–13): текст и голос — 403 KIDS_NOT_ALLOWED без вызова lessons", async () => {
    h.fake.setAge(s.userId, "10-13");
    const v = await invite();
    const n = lessonsCalls().length;
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/turns`, { text: "hello" }, idem())).json().code).toBe("KIDS_NOT_ALLOWED");
    expect((await audio(v.room_id, makeWav())).json().code).toBe("KIDS_NOT_ALLOWED");
    expect(lessonsCalls()).toHaveLength(n);
  });
});

describe("лимиты и недоступность", () => {
  it("tg.room.write — приглашение, ответ, вход, ход; tg.room.poll — лента и присутствие (свой счётчик)", async () => {
    await limitTo("tg.room.write", 2);
    const v = await invite();
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/join`)).statusCode).toBe(200);
    const r = await send("POST", `/v1/pair-rooms/${v.room_id}/turns`, { choice_id: "c1" }, idem());
    expect([r.statusCode, r.json().details.policy]).toEqual([429, "tg.room.write"]);
    expect((await get(`/v1/pair-rooms/${v.room_id}/state`)).statusCode).toBe(200);
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/heartbeat`)).statusCode).toBe(204);
  });

  it("tg.room.poll: 429 без вызова lessons", async () => {
    await limitTo("tg.room.poll", 2);
    const v = await invite();
    expect((await get(`/v1/pair-rooms/${v.room_id}/state`)).statusCode).toBe(200);
    expect((await send("POST", `/v1/pair-rooms/${v.room_id}/heartbeat`)).statusCode).toBe(204);
    const r = await get(`/v1/pair-rooms/${v.room_id}/state`);
    expect([r.statusCode, r.json().details.policy]).toEqual([429, "tg.room.poll"]);
    expect(lessonsCalls("GET", statePath(v.room_id))).toHaveLength(1);
  });

  it("lessons лежит или ответ не по контракту → 503 UPSTREAM_UNAVAILABLE {service: lessons}; учёба (план) работает", async () => {
    const v = await invite();
    h.fake.down.add("lessons");
    for (const [m, url, body, key] of [
      ["POST", "/v1/pair-rooms", INVITE, true],
      ["GET", "/v1/pair-rooms", undefined, false],
      ["GET", `/v1/pair-rooms/${v.room_id}`, undefined, false],
      ["POST", `/v1/pair-rooms/${v.room_id}/join`, undefined, false],
      ["GET", `/v1/pair-rooms/${v.room_id}/state`, undefined, false],
      ["POST", `/v1/pair-rooms/${v.room_id}/turns`, { choice_id: "c1" }, true],
      ["GET", `/v1/pair-rooms/${v.room_id}/report`, undefined, false],
    ] as const) {
      const r = await send(m, url, body, key ? idem() : {});
      expect([r.statusCode, r.json().code, r.json().details], url).toEqual([503, "UPSTREAM_UNAVAILABLE", { service: "lessons" }]);
    }
    const a = await audio(v.room_id, makeWav());
    expect([a.statusCode, a.json().details]).toEqual([503, { service: "lessons" }]);
    h.fake.down.delete("lessons");
    expect((await get("/v1/plan/today")).statusCode).toBe(200);
    // участник ленты с «сырым» UUID роли — не по контракту
    h.fake.override("lessons", "GET", statePath(v.room_id), () => json(200, { ...h.fake.social7.state(v.room_id, { lrn: s.userId, kids: false, band: "18+" }), next_speaker: OTHER_USER_ID }));
    const bad = await get(`/v1/pair-rooms/${v.room_id}/state`);
    expect([bad.statusCode, bad.json().code]).toEqual([503, "UPSTREAM_UNAVAILABLE"]);
    expect(bad.body).not.toContain(OTHER_USER_ID);
  });
});

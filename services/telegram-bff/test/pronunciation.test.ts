/**
 * Спринт 5 через BFF — оценка произношения (bff.ts PronunciationView, INTERNAL_API §1.9, §8): тело audio/wav ≤ 600 000
 * байт только у этого маршрута, проверка заголовка WAV до memory (AUDIO_INVALID {reason}), разбор target, сырое тело — в
 * memory как есть, ответ — PronunciationView по контракту (score = scores.pron), коды memory (VOICE_CONSENT_REQUIRED,
 * SPEECH_UNAVAILABLE) — как есть, лимит tg.memory.pronunciation, аудио и эталонный текст — не в логах.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearer, closeRedis, json, login, makeHarness, switchTo, type Harness, type LoggedIn } from "./helpers.js";
import { AUDIO_MARK, makeWav, type WavOptions } from "./wavFixture.js";

let h: Harness;
let s: LoggedIn;
let cardId: string;
beforeEach(async () => {
  h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "1000" });
  s = await login(h);
  h.fake.setAge(s.userId, "18+");
  h.fake.onboard(s.userId);
  h.fake.memory.voiceConsent.add(s.userId);
  const cards = (await h.app.inject({ url: "/v1/memory/cards", headers: bearer(s.access) })).json().items as Array<{ card_id: string; text_en: string }>;
  cardId = cards.find((c) => c.text_en === "coffee")!.card_id;
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const SENTENCE = "sentence:reading:r-a1-coffee-shop:2:s1";

function send(body: Buffer | string | undefined, o: { target?: string | null; contentType?: string | null; token?: string | null } = {}) {
  const target = o.target === undefined ? `card:${cardId}` : o.target;
  const headers: Record<string, string> = {};
  if (o.token !== null) headers.authorization = `Bearer ${o.token ?? s.access}`;
  if (o.contentType !== null) headers["content-type"] = o.contentType ?? "audio/wav";
  return h.app.inject({
    method: "POST",
    url: `/v1/memory/pronunciation${target === null ? "" : `?target=${encodeURIComponent(target)}`}`,
    headers,
    ...(body !== undefined ? { payload: body } : {}),
  });
}

const memoryCalls = () => h.fake.callsTo("memory", "POST", "/internal/v1/pronunciation");

describe("произношение: успех и сборка PronunciationView", () => {
  it("карточка: сырое WAV в memory как есть (audio/wav, target_kind/target, claims ученика); score = scores.pron, ≤ 2 совета", async () => {
    const wav = makeWav({ ms: 1500 });
    const res = await send(wav);
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json();
    expect(v).toMatchObject({ status: "ok", reference_text: "coffee", score: 88, intelligibility: "clear", message: null });
    expect(v.attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(v.words).toEqual([{ word: "coffee", accuracy: 55, error_type: "mispronunciation" }]);
    expect(v.tips).toHaveLength(2);
    expect(v).not.toHaveProperty("scores");
    expect(v).not.toHaveProperty("cost_usd");
    expect(v).not.toHaveProperty("user_id");
    expect(h.fake.memory.lastAudio?.equals(wav)).toBe(true);
    const call = memoryCalls()[0]!;
    expect(call.headers["content-type"]).toBe("audio/wav");
    expect(call.query).toMatchObject({ target_kind: "card", target: cardId, audience: "adults" });
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ lrn: s.userId, age_band: "18+", aud: "memory" });
  });

  it("предложение контента: target_kind sentence, target = kind:key:version:locator (locator урока с двоеточием)", async () => {
    expect((await send(makeWav(), { target: SENTENCE })).statusCode).toBe(200);
    expect(memoryCalls().at(-1)!.query).toMatchObject({ target_kind: "sentence", target: "reading:r-a1-coffee-shop:2:s1" });
    expect((await send(makeWav(), { target: "sentence:lesson:l-a1-03-cafe:3:ex:0" })).statusCode).toBe(200);
    expect(memoryCalls().at(-1)!.query).toMatchObject({ target_kind: "sentence", target: "lesson:l-a1-03-cafe:3:ex:0" });
  });

  it("форма PronunciationView от memory — как есть; insufficient_evidence и unavailable — без баллов, с сообщением RU/UZ", async () => {
    h.fake.memory.pronunciationMode = "view";
    expect((await send(makeWav())).json()).toMatchObject({ status: "ok", score: 71, intelligibility: "mostly_clear", tips: [{ text: "Послушайте образец" }] });
    h.fake.memory.pronunciationMode = "insufficient";
    const ins = (await send(makeWav())).json();
    expect(ins).toMatchObject({ status: "insufficient_evidence", score: null, intelligibility: null, words: [], tips: [] });
    expect(ins.message.ru).toContain("Не удалось оценить");
    expect(ins.message.uz).toBeTruthy();
    expect(ins.attempt_id).not.toBeNull();
    h.fake.memory.pronunciationMode = "unavailable";
    const un = (await send(makeWav())).json();
    expect(un).toMatchObject({ status: "unavailable", attempt_id: null, score: null, message: { ru: "Оценка произношения сейчас недоступна" } });
  });

  it("WAV с чанком LIST перед data и синоним типа audio/x-wav — принимаются", async () => {
    expect((await send(makeWav({ listChunk: true }))).statusCode).toBe(200);
    expect((await send(makeWav(), { contentType: "audio/x-wav" })).statusCode).toBe(200);
    expect((await send(makeWav(), { contentType: "audio/wav; codecs=1" })).statusCode).toBe(200);
  });

  it("логи: только длительность и статус — ни байтов аудио, ни эталонного текста, ни target", async () => {
    h.fake.override("memory", "POST", "/internal/v1/pronunciation", () =>
      json(200, { attempt_id: randomUUID(), status: "ok", reference_text: "Unique reference phrase seven", scores: { accuracy: 70, fluency: 70, completeness: 90, pron: 65 }, words: [], tips: [] }),
    );
    const res = await send(makeWav({ ms: 2000 }), { target: SENTENCE });
    expect(res.json()).toMatchObject({ score: 65, intelligibility: "mostly_clear" });
    const line = h.logs.parsed().find((l) => l.msg === "pronunciation assessed")!;
    expect(line).toMatchObject({ audio_ms: 2000, outcome: "ok" });
    const text = h.logs.text;
    for (const needle of [AUDIO_MARK.toString("latin1"), AUDIO_MARK.toString("base64"), AUDIO_MARK.toString("hex"), "Unique reference phrase", "r-a1-coffee-shop", "RIFF"]) {
      expect(text, needle).not.toContain(needle);
    }
    // ошибка memory — тоже только длительность и статус
    h.fake.memory.voiceConsent.clear();
    h.fake.override("memory", "POST", "/internal/v1/pronunciation", () => json(403, { code: "VOICE_CONSENT_REQUIRED", message: "no", trace_id: "t", details: { who: "self" } }));
    await send(makeWav({ ms: 1000 }));
    expect(h.logs.parsed().find((l) => l.msg === "pronunciation not assessed")).toMatchObject({ audio_ms: 1000, upstream_status: 403, upstream_code: "VOICE_CONSENT_REQUIRED" });
    expect(h.logs.text).not.toContain(AUDIO_MARK.toString("latin1"));
  });
});

describe("произношение: проверка WAV до memory (422 AUDIO_INVALID {reason})", () => {
  const cases: Array<[string, WavOptions | Buffer | string, string]> = [
    ["не RIFF", Buffer.from("ID3\u0004 this is an mp3 actually ".repeat(100)), "format"],
    ["стерео", { channels: 2 }, "format"],
    ["44,1 кГц", { sampleRate: 44_100 }, "format"],
    ["8 бит", { bits: 8 }, "format"],
    ["float (format 3)", { format: 3 }, "format"],
    ["обрезанный data", { truncated: true }, "format"],
    ["0,3 с", { ms: 300 }, "too_short"],
    ["0,49 с", { ms: 490 }, "too_short"],
    ["16 с", { ms: 16_000 }, "too_long"],
    ["18 с (≤ 600 000 байт)", { ms: 18_000 }, "too_long"],
    ["19 с (> 600 000 байт)", { ms: 19_000 }, "too_large"],
    ["пустое тело", Buffer.alloc(0), "format"],
  ];
  for (const [name, input, reason] of cases) {
    it(`${name} → ${reason}`, async () => {
      const body = Buffer.isBuffer(input) ? input : typeof input === "string" ? Buffer.from(input) : makeWav(input);
      const res = await send(body);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ code: "AUDIO_INVALID", details: { reason } });
      expect(memoryCalls()).toHaveLength(0);
    });
  }

  it("границы: ровно 0,5 с и ровно 15 с — принимаются", async () => {
    expect((await send(makeWav({ ms: 500 }))).statusCode).toBe(200);
    expect((await send(makeWav({ ms: 15_000 }))).statusCode).toBe(200);
  });

  it("не тот Content-Type (JSON, MP3, без типа) → 422 AUDIO_INVALID format; memory не вызывается", async () => {
    const r1 = await send(JSON.stringify({ audio: "base64" }), { contentType: "application/json" });
    const r2 = await send(makeWav(), { contentType: "audio/mpeg" });
    const r3 = await send(makeWav(), { contentType: "text/plain" });
    const r4 = await send(undefined, { contentType: null });
    for (const r of [r1, r2, r3, r4]) {
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json()).toMatchObject({ code: "AUDIO_INVALID", details: { reason: "format" } });
    }
    expect(memoryCalls()).toHaveLength(0);
  });

  it("лимит тела 600 000 и парсер audio/wav — только у этого маршрута", async () => {
    const big = await h.app.inject({
      method: "POST",
      url: "/v1/memory/translate",
      headers: { ...bearer(s.access), "content-type": "application/json" },
      payload: JSON.stringify({ text: "x".repeat(100_000), content: { kind: "reading", key: "r-a1-coffee-shop", version: 2 } }),
    });
    expect(big.statusCode).toBe(413);
    const wavElsewhere = await h.app.inject({ method: "POST", url: "/v1/memory/translate", headers: { ...bearer(s.access), "content-type": "audio/wav" }, payload: makeWav() });
    expect(wavElsewhere.statusCode).toBe(415);
  });
});

describe("произношение: авторизация, target, коды memory, лимит", () => {
  it("401 без токена — до чтения тела и без memory", async () => {
    const res = await send(makeWav({ ms: 19_000 }), { token: null });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
    expect(memoryCalls()).toHaveLength(0);
  });

  it("target: нет, не тот формат, чужая схема → 422 VALIDATION_ERROR {field: target}", async () => {
    for (const target of [null, "card:not-a-uuid", "sentence:reading:BAD KEY:2:s1", "sentence:reading:r-a1:0:s1", "sentence:reading:r-a1:2:", `sentence:reading:r-a1:2:${"s".repeat(33)}`, "sentence:chat:x1:2:s1", "file:/etc/passwd"]) {
      const res = await send(makeWav(), { target });
      expect(res.statusCode, String(target)).toBe(422);
      expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { in: "querystring", field: "target" } });
    }
    expect(memoryCalls()).toHaveLength(0);
  });

  it("403 VOICE_CONSENT_REQUIRED {who}: взрослый без согласия — self; детский профиль — guardian (claims ребёнка)", async () => {
    h.fake.memory.voiceConsent.clear();
    const self = await send(makeWav());
    expect(self.statusCode).toBe(403);
    expect(self.json()).toMatchObject({ code: "VOICE_CONSENT_REQUIRED", details: { who: "self" } });
    const child = h.fake.addChild(s.userId, "Мадина", "6-9");
    h.fake.onboard(child);
    const kid = await switchTo(h, s, child);
    const res = await send(makeWav(), { token: kid.access, target: SENTENCE });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "VOICE_CONSENT_REQUIRED", details: { who: "guardian" } });
    expect(memoryCalls().at(-1)!.claims).toMatchObject({ lrn: child, age_band: "6-9" });
    // с согласием опекуна — оценка идёт
    h.fake.memory.voiceConsent.add(child);
    expect((await send(makeWav(), { token: kid.access, target: SENTENCE })).statusCode).toBe(200);
  });

  it("503 SPEECH_UNAVAILABLE — код memory как есть (не UPSTREAM_UNAVAILABLE); 404 CARD_NOT_FOUND; ответ не по контракту → 503", async () => {
    h.fake.memory.speechAvailable = false;
    const off = await send(makeWav());
    expect([off.statusCode, off.json().code]).toEqual([503, "SPEECH_UNAVAILABLE"]);
    h.fake.memory.speechAvailable = true;
    const nf = await send(makeWav(), { target: `card:${randomUUID()}` });
    expect([nf.statusCode, nf.json().code]).toEqual([404, "CARD_NOT_FOUND"]);
    h.fake.override("memory", "POST", "/internal/v1/pronunciation", () => json(200, { status: "great", reference_text: "x" }));
    const bad = await send(makeWav());
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "memory" } });
    h.fake.down.add("memory");
    expect((await send(makeWav())).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "memory" } });
  });

  it("лимит tg.memory.pronunciation: 20 за 10 минут на ученика, 21-я — 429 без вызова memory", async () => {
    const wav = makeWav({ ms: 600 });
    for (let i = 0; i < 20; i++) expect((await send(wav)).statusCode, String(i)).toBe(200);
    const r = await send(wav);
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ code: "RATE_LIMITED", details: { policy: "tg.memory.pronunciation" } });
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    expect(memoryCalls()).toHaveLength(20);
  });
});

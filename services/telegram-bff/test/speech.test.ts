/**
 * Release 4.1 — POST /v1/speech: озвучка фраз контента через tts (MP3). Успех и заголовки кеша, нормализация текста и
 * субъект внутреннего JWT (аккаунт, и в детском профиле), 422 TEXT_INVALID (BFF и tts), 429 tg.speech,
 * 503 SPEECH_UNAVAILABLE (tts лежит, 5xx, таймаут, не MP3, TTS_URL не задан), текст фразы не попадает в лог.
 */
import { decodeJwt } from "jose";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { FAKE_MP3, bearer, closeRedis, domainError, login, makeHarness, switchTo, testConfig, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
afterAll(closeRedis);

const PHRASE = "Could I have a cup of green tea, please?";
const speech = (hh: Harness, token: string, payload: unknown) =>
  hh.app.inject({ method: "POST", url: "/v1/speech", headers: bearer(token), payload: payload as object });

describe("POST /v1/speech", () => {
  it("MP3 из tts как есть: audio/mpeg, Cache-Control private 24 ч; тело нормализовано, sub = аккаунт", async () => {
    h = await makeHarness();
    const a = await login(h);
    const r = await speech(h, a.access, { text: `  ${PHRASE.replace(" a cup", "\n a\tcup")}  `, variant: "en-US" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["content-type"]).toBe("audio/mpeg");
    expect(r.headers["cache-control"]).toBe("private, max-age=86400");
    expect(r.headers["content-length"]).toBe(String(FAKE_MP3.length));
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(r.rawPayload).equals(FAKE_MP3)).toBe(true);
    const calls = h.fake.callsTo("tts", "POST", "/internal/v1/speech");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ text: PHRASE, variant: "en-US", speed: "normal" });
    expect(calls[0]!.subject).toBe(a.userId);
    expect(decodeJwt(calls[0]!.headers["x-internal-token"]!)).toMatchObject({ iss: "telegram-bff", aud: "tts", sub: a.userId });
    // фраза не попадает в лог (ни тело запроса, ни ответ tts)
    expect(h.logs.text).not.toContain("green tea");
    expect(h.logs.text).toContain('"route":"/v1/speech"');
  });

  it("speed slow передаётся tts; детский профиль — тоже от имени аккаунта (озвучка не учебный ресурс)", async () => {
    h = await makeHarness();
    const parent = await login(h);
    h.fake.setAge(parent.userId, "18+");
    const child = await switchTo(h, parent, h.fake.addChild(parent.userId, "Мадина", "6-9"));
    const r = await speech(h, child.access, { text: "A cup of tea, please.", variant: "en-GB", speed: "slow" });
    expect(r.statusCode, r.body).toBe(200);
    const call = h.fake.callsTo("tts", "POST")[0]!;
    expect(call.body).toEqual({ text: "A cup of tea, please.", variant: "en-GB", speed: "slow" });
    expect(call.subject).toBe(parent.userId);
  });

  it("422 TEXT_INVALID: пусто, > 400 знаков, управляющие символы, без латиницы, чужой голос / скорость, лишние поля; tts не вызывается", async () => {
    h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "1000" });
    const a = await login(h);
    const bad: Array<[unknown, string]> = [
      [{ text: "", variant: "en-GB" }, "text"],
      [{ text: "   \n\t ", variant: "en-GB" }, "text"],
      [{ text: "a".repeat(401), variant: "en-GB" }, "text"],
      [{ text: `${"word ".repeat(80)}a`, variant: "en-GB" }, "text"], // 401 после нормализации
      [{ text: "Hello\u0000there", variant: "en-GB" }, "text"],
      [{ text: "Hello\u001bthere", variant: "en-GB" }, "text"],
      [{ text: "Привет, как дела?", variant: "en-GB" }, "text"],
      [{ text: "12345 !!!", variant: "en-GB" }, "text"],
      [{ text: "x".repeat(2001), variant: "en-GB" }, "text"],
      [{ text: 42, variant: "en-GB" }, "text"],
      [{ variant: "en-GB" }, "text"],
      [{ text: PHRASE, variant: "en-AU" }, "variant"],
      [{ text: PHRASE }, "variant"],
      [{ text: PHRASE, variant: "en-GB", speed: "fast" }, "speed"],
      [{ text: PHRASE, variant: "en-GB", user_id: "x" }, "user_id"],
    ];
    for (const [payload, field] of bad) {
      const r = await speech(h, a.access, payload);
      expect([r.statusCode, r.json().code, r.json().details?.field], JSON.stringify(payload).slice(0, 60)).toEqual([422, "TEXT_INVALID", field]);
      expect(r.body).not.toContain("Привет");
    }
    // граница: ровно 400 символов (в символах Unicode, не в UTF-16) — проходит
    expect((await speech(h, a.access, { text: "a".repeat(400), variant: "en-GB" })).statusCode).toBe(200);
    expect((await speech(h, a.access, { text: `${"😀".repeat(399)}a`, variant: "en-GB" })).statusCode).toBe(200);
    expect(h.fake.callsTo("tts")).toHaveLength(2);
  });

  it("422 tts → 422 TEXT_INVALID", async () => {
    h = await makeHarness();
    const a = await login(h);
    h.fake.override("tts", "POST", "/internal/v1/speech", () => domainError(422, "TEXT_INVALID", { field: "text" }));
    const r = await speech(h, a.access, { text: PHRASE, variant: "en-GB" });
    expect([r.statusCode, r.json().code]).toEqual([422, "TEXT_INVALID"]);
  });

  it("429 RATE_LIMITED tg.speech: 120 озвучек за 10 минут на аккаунт, 121-я — без вызова tts", async () => {
    h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "1000" });
    const a = await login(h);
    for (let i = 0; i < 120; i++) expect((await speech(h, a.access, { text: `Phrase number ${i}`, variant: "en-GB" })).statusCode, String(i)).toBe(200);
    const r = await speech(h, a.access, { text: PHRASE, variant: "en-GB" });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ code: "RATE_LIMITED", details: { policy: "tg.speech" } });
    expect(r.json().details.retry_after).toBeGreaterThanOrEqual(1);
    expect(r.json().details.retry_after).toBeLessThanOrEqual(5); // интервал GCRA 600 с / 120 = 5 с
    expect(Number(r.headers["retry-after"])).toBe(r.json().details.retry_after);
    expect(h.fake.callsTo("tts")).toHaveLength(120);
    // другой аккаунт — свой счётчик
    const b = await login(h, { id: 900002, first_name: "Анна" });
    expect((await speech(h, b.access, { text: PHRASE, variant: "en-GB" })).statusCode).toBe(200);
  });

  it("503 SPEECH_UNAVAILABLE {service: tts}: tts лежит, 5xx, 503 tts, 404, не MP3, пустой ответ — фраза не в логе", async () => {
    h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "1000" });
    const a = await login(h);
    const expect503 = async (what: string) => {
      const r = await speech(h!, a.access, { text: PHRASE, variant: "en-GB" });
      expect([r.statusCode, r.json().code, r.json().details], what).toEqual([503, "SPEECH_UNAVAILABLE", { service: "tts" }]);
      expect(r.headers["cache-control"], what).toBe("no-store");
    };
    h.fake.down.add("tts");
    await expect503("network");
    h.fake.down.delete("tts");
    const set = (fn: () => Response) => h!.fake.override("tts", "POST", "/internal/v1/speech", fn);
    set(() => domainError(500, "BOOM"));
    await expect503("500");
    set(() => domainError(503, "SPEECH_UNAVAILABLE"));
    await expect503("503");
    set(() => domainError(404, "NOT_FOUND"));
    await expect503("404");
    set(() => domainError(429, "RATE_LIMITED", { retry_after: 3 }));
    await expect503("429 tts");
    set(() => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect503("html");
    set(() => new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    await expect503("empty");
    set(() => new Response(new Uint8Array(FAKE_MP3), { status: 200, headers: { "content-type": "audio/ogg" } }));
    await expect503("ogg");
    const lines = h.logs.parsed();
    expect(lines.some((l) => l.msg === "domain unavailable" && l.upstream === "tts")).toBe(true);
    expect(lines.some((l) => l.msg === "speech audio rejected" && l.upstream === "tts")).toBe(true);
    expect(h.logs.text).not.toContain("green tea");
  });

  it("503 SPEECH_UNAVAILABLE по таймауту TTS_TIMEOUT_MS, без повтора", async () => {
    h = await makeHarness({ TTS_TIMEOUT_MS: "1000" });
    const a = await login(h);
    h.fake.override("tts", "POST", "/internal/v1/speech", () => new Promise((res) => setTimeout(() => res(new Response(new Uint8Array(FAKE_MP3), { status: 200, headers: { "content-type": "audio/mpeg" } })), 1500)));
    const t0 = Date.now();
    const r = await speech(h, a.access, { text: PHRASE, variant: "en-GB" });
    expect([r.statusCode, r.json().code]).toEqual([503, "SPEECH_UNAVAILABLE"]);
    expect(Date.now() - t0).toBeLessThan(1450);
    expect(h.fake.callsTo("tts")).toHaveLength(1);
  });

  it("TTS_URL не задан: 503 SPEECH_UNAVAILABLE без вызова tts, одно предупреждение при старте", async () => {
    h = await makeHarness({ TTS_URL: "" });
    expect(h.config.ttsUrl).toBeUndefined();
    const warnings = h.logs.parsed().filter((l) => l.msg === "TTS_URL is not set: POST /v1/speech answers 503 SPEECH_UNAVAILABLE");
    expect(warnings).toHaveLength(1);
    const a = await login(h);
    const r = await speech(h, a.access, { text: PHRASE, variant: "en-GB" });
    expect([r.statusCode, r.json().code]).toEqual([503, "SPEECH_UNAVAILABLE"]);
    expect(h.fake.callsTo("tts")).toHaveLength(0);
    // невалидный текст — по-прежнему 422 (клиенту важна причина)
    expect((await speech(h, a.access, { text: "", variant: "en-GB" })).json().code).toBe("TEXT_INVALID");
  });

  it("без сессии — 401; после PIN-гейта — 423 (как остальные маршруты ученика)", async () => {
    h = await makeHarness();
    const r = await h.app.inject({ method: "POST", url: "/v1/speech", payload: { text: PHRASE, variant: "en-GB" } });
    expect([r.statusCode, r.json().code]).toEqual([401, "UNAUTHORIZED"]);
    const a = await login(h);
    h.fake.enablePin(a.userId, "4826");
    const locked = await login(h);
    const r2 = await speech(h, locked.access, { text: PHRASE, variant: "en-GB" });
    expect([r2.statusCode, r2.json().code]).toEqual([423, "PIN_REQUIRED"]);
    expect(h.fake.callsTo("tts")).toHaveLength(0);
  });
});

describe("config: TTS_URL / TTS_TIMEOUT_MS", () => {
  it("необязателен (и в production); если задан — http(s); таймаут по умолчанию 15 с", () => {
    const c = testConfig({ TTS_URL: "" });
    expect(c.ttsUrl).toBeUndefined();
    expect(c.ttsTimeoutMs).toBe(15_000);
    expect(testConfig({ TTS_URL: "http://tts.railway.internal:8115/" }).ttsUrl).toBe("http://tts.railway.internal:8115");
    expect(() => testConfig({ TTS_URL: "tts.railway.internal" })).toThrow(/TTS_URL/);
    expect(() => testConfig({ TTS_URL: "ftp://tts" })).toThrow(/TTS_URL/);
    expect(() => testConfig({ TTS_TIMEOUT_MS: "100" })).toThrow(/TTS_TIMEOUT_MS/);
    expect(loadConfig({}).ttsUrl).toBeUndefined();
  });
});

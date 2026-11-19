/**
 * Входная диагностика через BFF (AT-32…34): от имени активного ученика (lrn), сегмент audience по возрасту, ключи
 * ответов не уходят в Mini App, Idempotency-Key, коды доменов, строгая проверка ответов.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearer, closeRedis, domainError, idem, json, login, makeHarness, switchTo, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
beforeEach(async () => {
  h = await makeHarness();
  s = await login(h);
  h.fake.setAge(s.userId, "18+");
  h.fake.onboard(s.userId);
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const get = (url: string, token = s.access) => h.app.inject({ url, headers: bearer(token) });
const post = (url: string, payload?: unknown, headers: Record<string, string> = {}, token = s.access) =>
  h.app.inject({ method: "POST", url, headers: { ...bearer(token), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function start(token = s.access): Promise<string> {
  const res = await post("/v1/diagnostics/sessions", {}, idem(), token);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().session_id as string;
}

describe("GET /v1/diagnostics/state", () => {
  it("нет диагностики → status none; от имени ученика, audience=adults по возрасту, лишние поля домена не уходят", async () => {
    const res = await get("/v1/diagnostics/state");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pair_id: "ru-en", status: "none", session: null, last_result: null, next_allowed_at: null, audience: "adults" });
    const call = h.fake.callsTo("diagnostics", "GET", "/internal/v1/diagnostics/state")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.query).toEqual({ pair_id: "ru-en", audience: "adults" });
  });

  it("подросток 14–17 → audience=teens; детский профиль → kids и sub = ребёнок (без запроса возраста к identity)", async () => {
    const teen = await login(h, { id: 900077, first_name: "Тимур", language_code: "ru" });
    h.fake.setAge(teen.userId, "14-17");
    await get("/v1/diagnostics/state", teen.access);
    expect(h.fake.callsTo("diagnostics", "GET", "/internal/v1/diagnostics/state").at(-1)!.query.audience).toBe("teens");

    const child = h.fake.addChild(s.userId, "Мадина", "6-9");
    h.fake.onboard(child);
    const kid = await switchTo(h, s, child);
    h.fake.calls.length = 0;
    const res = await get("/v1/diagnostics/state", kid.access);
    expect(res.json().audience).toBe("kids");
    const call = h.fake.callsTo("diagnostics", "GET", "/internal/v1/diagnostics/state")[0]!;
    expect(call.subject).toBe(child);
    expect(call.query.audience).toBe("kids");
    expect(h.fake.callsTo("identity", "GET", "/internal/v1/me")).toHaveLength(0);
  });

  it("возраст аккаунта не выбран → kids (самый строгий набор); выбор возраста сбрасывает кеш сегмента", async () => {
    const fresh = await login(h, { id: 900078, first_name: "Зарина", language_code: "uz" });
    await get("/v1/diagnostics/state", fresh.access);
    expect(h.fake.callsTo("diagnostics", "GET", "/internal/v1/diagnostics/state").at(-1)!.query.audience).toBe("kids");
    const age = await h.app.inject({ method: "PUT", url: "/v1/profile/age", headers: bearer(fresh.access), payload: { age_band: "18+" } });
    expect(age.statusCode).toBe(200);
    await get("/v1/diagnostics/state", fresh.access);
    expect(h.fake.callsTo("diagnostics", "GET", "/internal/v1/diagnostics/state").at(-1)!.query.audience).toBe("adults");
  });

  it("401 без токена; 422 неверная пара; 409 PAIR_NOT_AVAILABLE домена — как есть", async () => {
    expect((await h.app.inject({ url: "/v1/diagnostics/state" })).statusCode).toBe(401);
    const bad = await get("/v1/diagnostics/state?pair_id=RU_EN");
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe("VALIDATION_ERROR");
    const res = await get("/v1/diagnostics/state?pair_id=ru-kk");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "PAIR_NOT_AVAILABLE", details: { pair_id: "ru-kk" } });
  });
});

describe("сессия диагностики целиком", () => {
  it("старт → задания без ключей → ответы (вариант, порядок слов, «Не знаю») → аудирование недоступно → результат", async () => {
    const id = await start();
    const call = h.fake.callsTo("diagnostics", "POST", "/internal/v1/diagnostics/sessions")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.query.audience).toBe("adults");
    expect(call.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);

    let item = (await get(`/v1/diagnostics/sessions/${id}/next`)).json();
    expect(item.item_id).toBe("v-a1-01");
    expect(item).not.toHaveProperty("answer");
    expect(Object.keys(item).sort()).toEqual(["area", "audio_text_en", "instruction", "item_id", "options", "passage_en", "position", "prompt_en", "type"]);

    const answer = async (payload: object) => {
      const r = await post(`/v1/diagnostics/sessions/${id}/answers`, payload);
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    };
    let res = await answer({ item_id: "v-a1-01", answer: 0, dont_know: false, time_ms: 1200 });
    expect(Object.keys(res).sort()).toEqual(["accepted", "done", "next"]); // правильность не сообщается
    expect(res.next).not.toHaveProperty("answer");
    res = await answer({ item_id: "g-a1-01", answer: null, dont_know: true, time_ms: 900 });
    expect(res.next.type).toBe("order_words");
    res = await answer({ item_id: "g-a1-02", answer: ["I", "am", "a", "student"], dont_know: false, time_ms: 5000 });
    expect(h.fake.callsTo("diagnostics", "POST", `/internal/v1/diagnostics/sessions/${id}/answers`).at(-1)!.body).toEqual({
      item_id: "g-a1-02",
      answer: ["I", "am", "a", "student"],
      dont_know: false,
      time_ms: 5000,
    });

    // нет голоса en-* → аудирование not_assessed, тест идёт дальше
    const lu = await post(`/v1/diagnostics/sessions/${id}/listening-unavailable`);
    expect(lu.statusCode).toBe(204);
    res = await answer({ item_id: "r-a1-01", answer: 1, dont_know: false, time_ms: 3000 });
    expect(res).toEqual({ accepted: true, next: null, done: true });
    item = (await get(`/v1/diagnostics/sessions/${id}/next`)).json();
    expect(item).toEqual({ done: true });

    const fin = await post(`/v1/diagnostics/sessions/${id}/finish`);
    expect(fin.statusCode).toBe(200);
    const result = fin.json();
    expect(result.cefr_certificate).toBe(false);
    expect(result).not.toHaveProperty("user_id");
    expect(result.areas.find((a: { area: string }) => a.area === "listening")).toMatchObject({ status: "not_assessed", reason: "no_speech_voice" });
    expect(result.areas.find((a: { area: string }) => a.area === "speaking")).toMatchObject({ status: "not_assessed", reason: "not_in_test_yet" });
    // основания — только по полосам; у неоценённой области — пусто, даже если домен прислал
    expect(result.areas.find((a: { area: string }) => a.area === "grammar").evidence).toEqual([{ band: "A1", answered: 2, correct: 1 }]);
    expect(result.areas.find((a: { area: string }) => a.area === "reading").evidence).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("item_id");

    const hist = (await get("/v1/diagnostics/results")).json();
    expect(hist.items).toHaveLength(1);
    expect(h.fake.callsTo("diagnostics", "GET", "/internal/v1/diagnostics/results")[0]!.query).toEqual({ pair_id: "ru-en", limit: "50" });
  });

  it("Idempotency-Key обязателен (422); повтор с тем же ключом — та же сессия", async () => {
    const no = await post("/v1/diagnostics/sessions", {});
    expect(no.statusCode).toBe(422);
    expect(no.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const k = idem();
    const a = await post("/v1/diagnostics/sessions", {}, k);
    const b = await post("/v1/diagnostics/sessions", {}, k);
    expect(a.json().session_id).toBe(b.json().session_id);
    expect(a.json()).not.toHaveProperty("seed");
  });

  it("409 DIAGNOSTIC_TOO_SOON {next_allowed_at}; 409 ITEM_NOT_CURRENT; 422 DIAGNOSTIC_EMPTY — коды домена", async () => {
    const id = await start();
    const wrong = await post(`/v1/diagnostics/sessions/${id}/answers`, { item_id: "r-a1-01", answer: 0, dont_know: false, time_ms: 1 });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().code).toBe("ITEM_NOT_CURRENT");
    const empty = await post(`/v1/diagnostics/sessions/${id}/finish`);
    expect(empty.statusCode).toBe(422);
    expect(empty.json().code).toBe("DIAGNOSTIC_EMPTY");

    h.fake.content.tooSoon.set(s.userId, "2026-12-03T08:00:00Z");
    const soon = await post("/v1/diagnostics/sessions", {}, idem());
    expect(soon.statusCode).toBe(409);
    expect(soon.json()).toMatchObject({ code: "DIAGNOSTIC_TOO_SOON", details: { next_allowed_at: "2026-12-03T08:00:00Z" } });
  });

  it("изоляция учеников: чужая сессия → 404 (домен по sub); id не UUID → 422", async () => {
    const id = await start();
    const other = await login(h, { id: 900079, first_name: "Олим", language_code: "ru" });
    h.fake.setAge(other.userId, "18+");
    const res = await get(`/v1/diagnostics/sessions/${id}/next`, other.access);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("DIAGNOSTIC_SESSION_NOT_FOUND");
    expect(h.fake.callsTo("diagnostics", "GET", `/internal/v1/diagnostics/sessions/${id}/next`).at(-1)!.subject).toBe(other.userId);
    expect((await get("/v1/diagnostics/sessions/../../admin/next")).statusCode).toBeGreaterThanOrEqual(400);
    expect((await get("/v1/diagnostics/sessions/not-a-uuid/next")).statusCode).toBe(422);
  });

  it("422: лишние поля, «Не знаю» с ответом, ответ неверного типа, time_ms вне диапазона", async () => {
    const id = await start();
    const url = `/v1/diagnostics/sessions/${id}/answers`;
    for (const payload of [
      { item_id: "v-a1-01", answer: 0, dont_know: false, time_ms: 1, correct: true },
      { item_id: "v-a1-01", answer: "0", dont_know: false, time_ms: 1 },
      { item_id: "v-a1-01", answer: 0, dont_know: false, time_ms: -1 },
      { item_id: "v-a1-01", answer: [], dont_know: false, time_ms: 1 },
    ]) {
      const r = await post(url, payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(422);
    }
    const dk = await post(url, { item_id: "v-a1-01", answer: 1, dont_know: true, time_ms: 1 });
    expect(dk.statusCode).toBe(422);
    expect(dk.json().code).toBe("ANSWER_INVALID");
    expect(h.fake.callsTo("diagnostics", "POST", `/internal/v1/diagnostics/sessions/${id}/answers`)).toHaveLength(0);
  });

  it("уточнение области: новая сессия; повтор по области без needs_followup — 409 FOLLOWUP_NOT_AVAILABLE", async () => {
    const id = await start();
    await post(`/v1/diagnostics/sessions/${id}/answers`, { item_id: "v-a1-01", answer: 0, dont_know: false, time_ms: 1 });
    const result = (await post(`/v1/diagnostics/sessions/${id}/finish`)).json();
    const fu = await post(`/v1/diagnostics/results/${result.result_id}/followup`, { area: "grammar" });
    expect(fu.statusCode).toBe(201);
    expect(fu.json()).toMatchObject({ followup_area: "grammar", status: "in_progress" });
    expect(fu.json().session_id).not.toBe(id);
    const no = await post(`/v1/diagnostics/results/${result.result_id}/followup`, { area: "vocabulary" });
    expect(no.statusCode).toBe(409);
    expect(no.json()).toMatchObject({ code: "FOLLOWUP_NOT_AVAILABLE", details: { area: "vocabulary", reason: "not_needed" } });
    expect((await post(`/v1/diagnostics/results/${result.result_id}/followup`, { area: "speaking" })).statusCode).toBe(422);
    expect((await post(`/v1/diagnostics/results/${randomUUID()}/followup`, { area: "grammar" })).statusCode).toBe(404);
  });

  it("строгая проверка: ответ домена не по контракту → 503, а не 500 и не утечка; 5xx домена → 503 UPSTREAM_UNAVAILABLE", async () => {
    h.fake.override("diagnostics", "GET", "/internal/v1/diagnostics/state", () => json(200, { pair_id: "ru-en", status: "weird" }));
    const bad = await get("/v1/diagnostics/state");
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "diagnostics" } });
    expect(h.logs.text).toContain("domain response does not match the contract");

    const id = await start();
    h.fake.override("diagnostics", "GET", `/internal/v1/diagnostics/sessions/${id}/next`, () => json(200, { item_id: "x", area: "speaking" }));
    expect((await get(`/v1/diagnostics/sessions/${id}/next`)).statusCode).toBe(503);
    h.fake.override("diagnostics", "POST", `/internal/v1/diagnostics/sessions/${id}/finish`, () => domainError(500, "BOOM"));
    const down = await post(`/v1/diagnostics/sessions/${id}/finish`);
    expect(down.statusCode).toBe(503);
    expect(down.json().code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("основания по заданиям (старый формат) или correct > answered — ответ домена не по контракту → 503", async () => {
    const id = await start();
    await post(`/v1/diagnostics/sessions/${id}/answers`, { item_id: "v-a1-01", answer: 0, dont_know: false, time_ms: 1 });
    const res = (await post(`/v1/diagnostics/sessions/${id}/finish`)).json();
    h.fake.override("diagnostics", "GET", "/internal/v1/diagnostics/results", () =>
      json(200, { items: [{ ...res, areas: [{ ...res.areas[0], evidence: [{ item_id: "v-a1-01", band: "A1", correct: true }] }] }] }),
    );
    expect((await get("/v1/diagnostics/results")).statusCode).toBe(503);
    h.fake.override("diagnostics", "GET", "/internal/v1/diagnostics/results", () =>
      json(200, { items: [{ ...res, areas: [{ ...res.areas[0], evidence: [{ band: "A1", answered: 1, correct: 2 }] }] }] }),
    );
    const bad = await get("/v1/diagnostics/results");
    expect(bad.statusCode).toBe(503);
    expect(h.logs.text).toContain("correct<=answered");
  });

  it("410 USER_DELETED домена — как есть; 423 без подтверждённого кода родителя", async () => {
    h.fake.override("diagnostics", "GET", "/internal/v1/diagnostics/results", () => domainError(410, "USER_DELETED"));
    const res = await get("/v1/diagnostics/results");
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe("USER_DELETED");

    h.fake.enablePin(s.userId, "1234");
    const locked = await login(h);
    expect((await get("/v1/diagnostics/state", locked.access)).statusCode).toBe(423);
  });

  it("логи: без ответов ученика и без ключей заданий", async () => {
    const id = await start();
    await post(`/v1/diagnostics/sessions/${id}/answers`, { item_id: "v-a1-01", answer: 0, dont_know: false, time_ms: 1 });
    expect(h.logs.text).not.toContain("яблоко");
    expect(h.logs.text).not.toContain(s.userId);
  });
});

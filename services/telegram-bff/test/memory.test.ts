/**
 * Спринт 5 через BFF — память и повторения (bff.ts «Спринт 5», INTERNAL_API §1.10, §8): обзор, словарь, журнал ошибок,
 * «Повторение дня», перевод по тапу. Субъект memory — аккаунт, claims lrn и age_band ученика; коды memory — как есть;
 * задание повторения — строгая проверка (лишнее поле / раскрытый ответ → 503); проверка удержания — без подсказок и
 * правильности до конца блока; тексты ученика — не в логах; дети — ввод и перевод разрешены; лимиты tg.memory.*.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEM_SECRET } from "./fakeMemory.js";
import { makeWav } from "./wavFixture.js";
import { bearer, closeRedis, idem, json, login, makeHarness, switchTo, testRedis, type Harness, type LoggedIn, TG_OTHER } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
beforeEach(async () => {
  h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "1000" });
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
const del = (url: string, token = s.access) => h.app.inject({ method: "DELETE", url, headers: bearer(token) });

async function kid(band: "6-9" | "10-13" = "10-13"): Promise<{ kid: LoggedIn; child: string }> {
  const child = h.fake.addChild(s.userId, "Мадина", band);
  h.fake.onboard(child);
  return { kid: await switchTo(h, s, child), child };
}

const cardsOf = async (token = s.access) => (await get("/v1/memory/cards", token)).json().items as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function startReview(token = s.access): Promise<string> {
  const res = await post("/v1/memory/review-sessions", undefined, idem(), token);
  expect([200, 201], res.body).toContain(res.statusCode);
  return res.json().session_id as string;
}

describe("обзор и вызов memory от имени ученика", () => {
  it("обзор: поля контракта без служебных; sub = аккаунт, claims lrn и age_band ученика, audience и locale", async () => {
    const res = await h.app.inject({ url: "/v1/memory/overview", headers: { ...bearer(s.access), "accept-language": "uz" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ due_count: 2, new_available: 1, retention_due: 1, done_today: false, active_session_id: null, pronunciation: "consent_self" });
    expect(res.json()).not.toHaveProperty("user_id");
    const call = h.fake.callsTo("memory", "GET", "/internal/v1/overview")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ iss: "telegram-bff", aud: "memory", lrn: s.userId, age_band: "18+" });
    expect(call.query).toEqual({ audience: "adults", locale: "uz" });
  });

  it("детский профиль: lrn — ребёнок, age_band — полоса ребёнка (10–13 — ввод), audience kids; sub — аккаунт", async () => {
    const { kid: k, child } = await kid("10-13");
    expect((await get("/v1/memory/overview", k.access)).statusCode).toBe(200);
    const call = h.fake.callsTo("memory").at(-1)!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ lrn: child, age_band: "10-13" });
    expect(call.query.audience).toBe("kids");
  });

  it("401 без токена — memory не вызывается; ответ не по контракту → 503 UPSTREAM_UNAVAILABLE {service: memory}", async () => {
    expect((await h.app.inject({ url: "/v1/memory/overview" })).statusCode).toBe(401);
    expect(h.fake.callsTo("memory")).toHaveLength(0);
    h.fake.override("memory", "GET", "/internal/v1/overview", () => json(200, { due_count: 1, pronunciation: "maybe" }));
    const bad = await get("/v1/memory/overview");
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "memory" } });
  });
});

describe("аудитория контента — во все вызовы memory (memory сама проверяет аудиторию ContentRef)", () => {
  it("translate, «в словарь», cards/lookup, произношение, список: ?audience= активного ученика (ребёнку — kids)", async () => {
    const touch = async (token: string) => {
      const content = { kind: "reading", key: "r-a1-coffee-shop", version: 2 };
      await post("/v1/memory/translate", { text: "coffee", content }, {}, token);
      await post("/v1/memory/cards", { text_en: "receipt", source: content }, idem(), token);
      await get("/v1/practice/readings/r-a0-zoo", token);
      await get("/v1/practice/readings/r-a1-coffee-shop", token);
      await h.app.inject({ method: "POST", url: `/v1/memory/pronunciation?target=${encodeURIComponent("sentence:reading:r-a1-coffee-shop:2:s1")}`, headers: { ...bearer(token), "content-type": "audio/wav" }, payload: makeWav() });
      await get("/v1/memory/cards", token);
    };
    const paths = ["/internal/v1/translate", "/internal/v1/cards", "/internal/v1/cards/lookup", "/internal/v1/pronunciation"];
    await touch(s.access);
    for (const p of paths) {
      const calls = h.fake.callsTo("memory").filter((c) => c.path === p);
      expect(calls.length, p).toBeGreaterThan(0);
      for (const c of calls) expect(c.query.audience, p).toBe("adults");
    }
    const { kid: k } = await kid("6-9");
    h.fake.calls.length = 0;
    await touch(k.access);
    for (const p of paths) {
      const calls = h.fake.callsTo("memory").filter((c) => c.path === p);
      expect(calls.length, p).toBeGreaterThan(0);
      for (const c of calls) expect([c.query.audience, c.claims.age_band], p).toEqual(["kids", "6-9"]);
    }
  });
});

describe("словарь (APP-MEM-02)", () => {
  it("список: фильтры и поиск уходят в memory, служебные поля отброшены, элемент не по контракту — отброшен; q не в логах", async () => {
    const all = await cardsOf();
    expect(all.map((c) => c.text_en).sort()).toEqual(["I agree", "coffee", "take away"]);
    const res = await get("/v1/memory/cards?kind=word&q=CoffeeSearchQ&limit=5");
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("memory", "GET", "/internal/v1/cards").at(-1)!.query).toMatchObject({ kind: "word", q: "CoffeeSearchQ", limit: "5", audience: "adults" });
    expect(h.logs.text).not.toContain("CoffeeSearchQ");
    h.fake.memory.badCardItem = true;
    const page = await get("/v1/memory/cards");
    expect(page.json().items).toHaveLength(3);
    expect(page.body).not.toContain(MEM_SECRET);
    expect(page.json().items[0]).not.toHaveProperty("stability");
    expect(h.logs.text).toContain("list items dropped");
    expect((await get("/v1/memory/cards?kind=sentence")).statusCode).toBe(422);
    expect((await get(`/v1/memory/cards?q=${"x".repeat(61)}`)).statusCode).toBe(422);
  });

  it("карточка: ошибка с фрагментом ученика, источники, история; чужая — 404 CARD_NOT_FOUND; неверный id — 422", async () => {
    const err = (await cardsOf()).find((c) => c.kind === "error")!;
    const res = await get(`/v1/memory/cards/${err.card_id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ error: { correction: "I agree", evidence: "I am agree with you", error_code: "extra_be" }, next_review_in_days: 1 });
    expect(res.json().sources[0]).toEqual({ kind: "lesson", title: { ru: "В кафе", uz: "В кафе (uz)" }, at: "2026-11-20T09:00:00Z" });
    expect(res.json().history[0]).toEqual({ at: "2026-11-20T09:00:00Z", grade: "good", mode: "typed" });
    expect(h.logs.text).not.toContain("I am agree with you");

    const other = await login(h, TG_OTHER);
    h.fake.setAge(other.userId, "18+");
    const foreign = await get(`/v1/memory/cards/${err.card_id}`, other.access);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe("CARD_NOT_FOUND");
    expect((await get("/v1/memory/cards/not-a-uuid")).statusCode).toBe(422);
  });

  it("«В словарь»: Idempotency-Key обязателен; 201 новая, повтор ключа — та же, то же слово другим ключом — 200", async () => {
    const body = { text_en: "receipt", source: { kind: "reading", key: "r-a1-coffee-shop", version: 2, locator: "s2" } };
    const none = await post("/v1/memory/cards", body);
    expect([none.statusCode, none.json().code]).toEqual([422, "IDEMPOTENCY_KEY_REQUIRED"]);
    expect(h.fake.callsTo("memory", "POST", "/internal/v1/cards")).toHaveLength(0);

    const key = idem();
    const a = await post("/v1/memory/cards", body, key);
    const b = await post("/v1/memory/cards", body, key);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(b.json().card_id).toBe(a.json().card_id);
    expect(a.json()).not.toHaveProperty("answers_en");
    const call = h.fake.callsTo("memory", "POST", "/internal/v1/cards")[0]!;
    expect(call.body).toEqual(body);
    expect(call.headers["idempotency-key"]).toBe(key["idempotency-key"]);
    const again = await post("/v1/memory/cards", { ...body, text_en: "  receipt " }, idem());
    expect(again.statusCode).toBe(200);
    expect(again.json().card_id).toBe(a.json().card_id);
  });

  it("«В словарь»: WORD_NOT_IN_CONTENT, CARDS_LIMIT {limit} — как есть; лишнее поле / чужой вид источника — 422", async () => {
    const src = { kind: "lesson", key: "l-a1-03-cafe", version: 3 };
    const own = await post("/v1/memory/cards", { text_en: "my own sentence", source: src }, idem());
    expect([own.statusCode, own.json().code]).toEqual([422, "WORD_NOT_IN_CONTENT"]);
    h.fake.memory.cardsLimit = true;
    const lim = await post("/v1/memory/cards", { text_en: "menu", source: src }, idem());
    expect(lim.statusCode).toBe(422);
    expect(lim.json()).toMatchObject({ code: "CARDS_LIMIT", details: { limit: 2000 } });
    const before = h.fake.callsTo("memory", "POST", "/internal/v1/cards").length;
    expect((await post("/v1/memory/cards", { text_en: "menu", source: src, card_id: randomUUID() }, idem())).statusCode).toBe(422);
    expect((await post("/v1/memory/cards", { text_en: "menu", source: { ...src, kind: "file" } }, idem())).statusCode).toBe(422);
    expect((await post("/v1/memory/cards", { text_en: "x".repeat(121), source: src }, idem())).statusCode).toBe(422);
    expect(h.fake.callsTo("memory", "POST", "/internal/v1/cards")).toHaveLength(before);
  });

  it("«Знаю это» и обратно; удаление → 204, затем 404", async () => {
    const coffee = (await cardsOf()).find((c) => c.text_en === "coffee")!;
    const known = await post(`/v1/memory/cards/${coffee.card_id}/known`);
    expect(known.json()).toMatchObject({ status: "known", due_at: null });
    const back = await del(`/v1/memory/cards/${coffee.card_id}/known`);
    expect(back.json()).toMatchObject({ status: "learning" });
    const gone = await del(`/v1/memory/cards/${coffee.card_id}`);
    expect(gone.statusCode).toBe(204);
    expect(gone.body).toBe("");
    expect((await get(`/v1/memory/cards/${coffee.card_id}`)).json().code).toBe("CARD_NOT_FOUND");
    expect((await del(`/v1/memory/cards/${coffee.card_id}`)).statusCode).toBe(404);
  });
});

describe("журнал ошибок (APP-MEM-01)", () => {
  it("взрослый — ошибки без фрагмента ученика в списке; ребёнок — пусто", async () => {
    const res = await get("/v1/memory/errors");
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0]).toMatchObject({ correction: "I agree", error_code: "extra_be", severity: "medium", strength: "weak" });
    expect(res.json().items[0]).not.toHaveProperty("evidence");
    expect(res.body).not.toContain("I am agree");
    const { kid: k } = await kid();
    expect((await get("/v1/memory/errors", k.access)).json()).toEqual({ items: [], next_cursor: null });
  });
});

describe("«Повторение дня» (APP-MEM-03/04/05, AT-54/56)", () => {
  it("старт: Idempotency-Key обязателен; 201, повтор ключа — та же; другой ключ при активной — 200 она же; active и get", async () => {
    const none = await post("/v1/memory/review-sessions");
    expect(none.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const key = idem();
    const a = await post("/v1/memory/review-sessions", undefined, key);
    const b = await post("/v1/memory/review-sessions", undefined, key);
    const c = await post("/v1/memory/review-sessions", undefined, idem());
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([201, 201, 200]);
    expect(new Set([a.json().session_id, b.json().session_id, c.json().session_id]).size).toBe(1);
    expect(a.json()).toMatchObject({ status: "active", total_tasks: 5, done_tasks: 0, cards: 2, new_cards: 1, checks: 1 });
    expect(a.json()).not.toHaveProperty("plan");
    expect(h.fake.callsTo("memory", "POST", "/internal/v1/review-sessions")[0]!.headers["idempotency-key"]).toBe(key["idempotency-key"]);
    expect((await get("/v1/memory/review-sessions/active")).json().session.session_id).toBe(a.json().session_id);
    expect((await get(`/v1/memory/review-sessions/${a.json().session_id}`)).json().status).toBe("active");
    expect((await get(`/v1/memory/review-sessions/${randomUUID()}`)).json().code).toBe("REVIEW_SESSION_NOT_FOUND");
  });

  it("409 NOTHING_TO_REVIEW {next_due_at}; активной нет — {session: null}", async () => {
    expect((await get("/v1/memory/review-sessions/active")).json()).toEqual({ session: null });
    h.fake.memory.nothingToReview = true;
    const res = await post("/v1/memory/review-sessions", undefined, idem());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NOTHING_TO_REVIEW", details: { next_due_at: "2026-11-22T09:00:00Z" } });
  });

  it("полный проход: intro → выбор → ввод → проверка удержания (без подсказок, итог в конце блока) → итог", async () => {
    const id = await startReview();
    const intro = (await get(`/v1/memory/review-sessions/${id}/current`)).json();
    expect(intro).toMatchObject({ index: 1, total: 5, type: "intro", answer_kind: "none", hints: [], voice: "en-GB" });

    const r1 = await post(`/v1/memory/review-sessions/${id}/tasks/${intro.task_id}`, {});
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ result: null, next_review_in_days: null, requeued: false, check_result: null });
    const choice = r1.json().next;
    expect(choice).toMatchObject({ type: "meaning_choice", options: ["кофе", "чай", "сок", "вода"], prompt: { text_en: "coffee", gloss: null } });

    const r2 = await post(`/v1/memory/review-sessions/${id}/tasks/${choice.task_id}`, { choice: 0 });
    expect(r2.json()).toMatchObject({ result: "correct", correct_answer: "кофе", next_review_in_days: 3 });
    expect(r2.json()).not.toHaveProperty("grade");
    const typed = r2.json().next;
    expect(typed).toMatchObject({ type: "typed", answer_kind: "text", prompt: { text_en: null, example_gap: "Is it for here or to ___?" }, hints: ["first_letter", "reveal"] });

    const hint = await post(`/v1/memory/review-sessions/${id}/tasks/${typed.task_id}/hint`, { kind: "first_letter" });
    expect(hint.json()).toEqual({ kind: "first_letter", text: "t…" });
    const r3 = await post(`/v1/memory/review-sessions/${id}/tasks/${typed.task_id}`, { text: "take away" });
    expect(r3.json()).toMatchObject({ result: "correct", correct_answer: "take away" });
    const check1 = r3.json().next;
    expect(check1).toMatchObject({ type: "check_item", hints: [], check: { position: 1, of: 2, skill_title: { ru: "Вежливая просьба" } } });

    const calls = h.fake.callsTo("memory").length;
    const noHint = await post(`/v1/memory/review-sessions/${id}/tasks/${check1.task_id}/hint`, { kind: "reveal" });
    expect([noHint.statusCode, noHint.json().code]).toEqual([409, "HINTS_NOT_ALLOWED"]);
    expect(h.fake.callsTo("memory")).toHaveLength(calls); // отказ — до вызова memory

    const r4 = await post(`/v1/memory/review-sessions/${id}/tasks/${check1.task_id}`, { choice: 0 });
    expect(r4.json()).toMatchObject({ result: null, correct_answer: null, next_review_in_days: null, check_result: null });
    const check2 = r4.json().next;
    const r5 = await post(`/v1/memory/review-sessions/${id}/tasks/${check2.task_id}`, { choice: 0 });
    expect(r5.json()).toMatchObject({ result: "correct", correct_answer: null, next: null });
    expect(r5.json().check_result).toMatchObject({ passed: true, correct: 2, total: 2 });
    expect(r5.json().check_result.items[0]).toEqual({ prompt_en: "Can I ___ a coffee? (1)", your_answer: "have", correct_answer: "have", correct: true });
    // все задания пройдены: current — 409 TASK_NOT_CURRENT {current_task_id: null} как есть (сигнал вызвать finish)
    const after = await get(`/v1/memory/review-sessions/${id}/current`);
    expect(after.statusCode).toBe(409);
    expect(after.json()).toMatchObject({ code: "TASK_NOT_CURRENT", details: { current_task_id: null } });

    const fin = await post(`/v1/memory/review-sessions/${id}/finish`);
    expect(fin.statusCode).toBe(200);
    expect(fin.json()).toMatchObject({ status: "completed", reviewed: 2, correct: 2, new_learned: 1, due_tomorrow: 1 });
    expect(fin.json().checks[0]).toEqual({ skill_title: { ru: "Вежливая просьба", uz: "Вежливая просьба (uz)" }, stage: "d7", passed: true, skill_retained: false });
    expect(fin.json()).not.toHaveProperty("user_id");
  });

  it("повтор ответа — тот же результат; ответ не на текущее — 409 TASK_NOT_CURRENT {current_task_id}; finish рано — 409", async () => {
    const id = await startReview();
    const intro = (await get(`/v1/memory/review-sessions/${id}/current`)).json();
    const r1 = await post(`/v1/memory/review-sessions/${id}/tasks/${intro.task_id}`, {});
    const choice = r1.json().next;
    const typedId = (await post(`/v1/memory/review-sessions/${id}/tasks/${choice.task_id}`, { choice: 1 })).json().next.task_id;
    const again = await post(`/v1/memory/review-sessions/${id}/tasks/${choice.task_id}`, { choice: 1 });
    expect(again.json()).toMatchObject({ result: "incorrect", requeued: true });

    const fin = await post(`/v1/memory/review-sessions/${id}/finish`);
    expect(fin.statusCode).toBe(409);
    expect(fin.json()).toMatchObject({ code: "TASK_NOT_CURRENT", details: { current_task_id: typedId } });
    const skip = (await get(`/v1/memory/review-sessions/${id}/current`)).json();
    expect(skip.task_id).toBe(typedId);
  });

  it("один ответ на запрос: несколько полей → 422 ANSWER_INVALID {field} до memory; лишнее поле — 422", async () => {
    const id = await startReview();
    const t = (await get(`/v1/memory/review-sessions/${id}/current`)).json();
    const before = h.fake.callsTo("memory").length;
    const two = await post(`/v1/memory/review-sessions/${id}/tasks/${t.task_id}`, { choice: 0, text: "coffee" });
    expect(two.statusCode).toBe(422);
    expect(two.json()).toMatchObject({ code: "ANSWER_INVALID", details: { field: "text" } });
    expect((await post(`/v1/memory/review-sessions/${id}/tasks/${t.task_id}`, { grade: "easy" })).statusCode).toBe(422);
    expect((await post(`/v1/memory/review-sessions/${id}/tasks/${t.task_id}`, { text: "x".repeat(201) })).statusCode).toBe(422);
    expect(h.fake.callsTo("memory")).toHaveLength(before);
  });

  it("ввод ученика не попадает в логи; детский профиль — ввод разрешён (сравнение локальное в memory), claims ребёнка", async () => {
    const { kid: k, child } = await kid("10-13");
    const id = await startReview(k.access);
    const intro = (await get(`/v1/memory/review-sessions/${id}/current`, k.access)).json();
    const choice = (await post(`/v1/memory/review-sessions/${id}/tasks/${intro.task_id}`, {}, {}, k.access)).json().next;
    const typed = (await post(`/v1/memory/review-sessions/${id}/tasks/${choice.task_id}`, { choice: 0 }, {}, k.access)).json().next;
    const res = await post(`/v1/memory/review-sessions/${id}/tasks/${typed.task_id}`, { text: "UniqueLearnerInput-913" }, {}, k.access);
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBe("incorrect");
    const call = h.fake.callsTo("memory", "POST").at(-1)!;
    expect(call.body).toEqual({ text: "UniqueLearnerInput-913" });
    expect(call.claims).toMatchObject({ lrn: child, age_band: "10-13" });
    expect(h.logs.text).not.toContain("UniqueLearnerInput-913");
  });

  it("memory прислал правильность проверки удержания до конца блока — BFF её не отдаёт (и пишет предупреждение)", async () => {
    h.fake.memory.leakCheckAnswer = true;
    const id = await startReview();
    let t = (await get(`/v1/memory/review-sessions/${id}/current`)).json();
    while (t.type !== "check_item") t = (await post(`/v1/memory/review-sessions/${id}/tasks/${t.task_id}`, t.answer_kind === "choice" ? { choice: 0 } : t.answer_kind === "text" ? { text: "take away" } : {})).json().next;
    const res = await post(`/v1/memory/review-sessions/${id}/tasks/${t.task_id}`, { choice: 1 });
    expect(res.json()).toMatchObject({ result: null, correct_answer: null, check_result: null });
    expect(h.logs.text).toContain("correct answer on a retention check dropped");
  });

  it("строгая проверка задания: лишнее поле (ключ) или ключ в подсказке → 503, метка ключа не уходит ученику", async () => {
    const id = await startReview();
    h.fake.memory.leakTaskField = true;
    const a = await get(`/v1/memory/review-sessions/${id}/current`);
    expect(a.statusCode).toBe(503);
    expect(a.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "memory" } });
    expect(a.body).not.toContain(MEM_SECRET);
    h.fake.memory.leakTaskField = false;
    h.fake.memory.leakPromptKey = true;
    const b = await get(`/v1/memory/review-sessions/${id}/current`);
    expect(b.statusCode).toBe(503);
    expect(b.body).not.toContain(MEM_SECRET);
    const warn = h.logs.parsed().filter((l) => l.msg === "domain response does not match the contract" && l.upstream === "memory");
    expect(warn.map((l) => [l.check, l.rule])).toEqual([
      ["review_task", "additionalProperties"],
      ["review_task", "additionalProperties"],
    ]);
    expect(h.logs.text).not.toContain(MEM_SECRET);
  });

  it("ответ раскрыт в подсказке (text_en у typed) — в текущем задании и в next ответа → 503", async () => {
    h.fake.memory.revealTypedText = true;
    const id = await startReview();
    const intro = (await get(`/v1/memory/review-sessions/${id}/current`)).json();
    const choice = (await post(`/v1/memory/review-sessions/${id}/tasks/${intro.task_id}`, {})).json().next;
    const res = await post(`/v1/memory/review-sessions/${id}/tasks/${choice.task_id}`, { choice: 0 });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain(MEM_SECRET);
    const cur = await get(`/v1/memory/review-sessions/${id}/current`);
    expect(cur.statusCode).toBe(503);
    expect(h.logs.parsed().some((l) => l.check === "review_task" && l.rule === "answer_revealed" && l.path === "/prompt/text_en")).toBe(true);
  });

  it("отмена → cancelled; повтор — 409 REVIEW_SESSION_STATE {status}; чужая сессия — 404", async () => {
    const id = await startReview();
    const other = await login(h, TG_OTHER);
    h.fake.setAge(other.userId, "18+");
    expect((await get(`/v1/memory/review-sessions/${id}`, other.access)).json().code).toBe("REVIEW_SESSION_NOT_FOUND");
    expect((await post(`/v1/memory/review-sessions/${id}/cancel`)).json().status).toBe("cancelled");
    const again = await post(`/v1/memory/review-sessions/${id}/cancel`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "REVIEW_SESSION_STATE", details: { status: "cancelled" } });
  });

  it("лимит tg.memory.answer: сверх лимита — 429 {policy}, memory не вызывается", async () => {
    await h.close();
    h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "1000", RATE_LIMIT_OVERRIDE_REFRESH_SECONDS: "1" });
    s = await login(h);
    h.fake.setAge(s.userId, "18+");
    await testRedis().set(
      `${h.config.rateLimiting.keyPrefix}rl:override:tg.memory.answer`,
      JSON.stringify({ v: 1, limit: 2, window_s: 600, burst: null, by: "staff-1", at: new Date().toISOString(), reason: "тест", expires_at: null }),
    );
    await new Promise((r) => setTimeout(r, 1100));
    const id = await startReview();
    await new Promise((r) => setTimeout(r, 300));
    const t = (await get(`/v1/memory/review-sessions/${id}/current`)).json();
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await post(`/v1/memory/review-sessions/${id}/tasks/${t.task_id}`, {})).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    const last = await post(`/v1/memory/review-sessions/${id}/tasks/${t.task_id}`, {});
    expect(last.json()).toMatchObject({ code: "RATE_LIMITED", details: { policy: "tg.memory.answer" } });
    expect(h.fake.callsTo("memory", "POST").filter((c) => c.path.includes("/tasks/"))).toHaveLength(2);
  });
});

describe("перевод по тапу", () => {
  const content = { kind: "reading", key: "r-a1-coffee-shop", version: 2, locator: "s2" };

  it("WordGloss: в memory — {content_ref, text}, таймаут перевода; служебные поля отброшены; слово не в логах", async () => {
    const res = await post("/v1/memory/translate", { text: " latte ", content });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      text: "latte",
      lemma: "latte",
      part_of_speech: "noun",
      gloss: { ru: "[ru] latte", uz: "[ru] latte (uz)" },
      source: "ai",
      ai_unreviewed: true,
      note: null,
      in_dictionary: null,
      reason: null,
    });
    const call = h.fake.callsTo("memory", "POST", "/internal/v1/translate")[0]!;
    expect(call.body).toEqual({ content_ref: content, text: "latte" });
    expect(h.logs.text).not.toContain("latte");
    const mine = await post("/v1/memory/translate", { text: "coffee", content });
    expect(mine.json().in_dictionary).toBe((await cardsOf()).find((c) => c.text_en === "coffee")!.card_id);
  });

  it("WORD_NOT_IN_CONTENT 422 и CONTENT_NOT_FOUND 404 — как есть; > 60 знаков, лишнее поле, чужой вид контента — 422 до memory", async () => {
    const nic = await post("/v1/memory/translate", { text: "notincontent", content });
    expect([nic.statusCode, nic.json().code]).toEqual([422, "WORD_NOT_IN_CONTENT"]);
    const nf = await post("/v1/memory/translate", { text: "coffee", content: { ...content, version: 99 } });
    expect([nf.statusCode, nf.json().code]).toEqual([404, "CONTENT_NOT_FOUND"]);
    const before = h.fake.callsTo("memory", "POST", "/internal/v1/translate").length;
    expect((await post("/v1/memory/translate", { text: "a".repeat(61), content })).statusCode).toBe(422);
    expect((await post("/v1/memory/translate", { text: "coffee", content, sentence: "free text" })).statusCode).toBe(422);
    expect((await post("/v1/memory/translate", { text: "coffee", content: { ...content, kind: "chat" } })).statusCode).toBe(422);
    expect((await post("/v1/memory/translate", { text: "coffee", content: { ...content, locator: "s 1" } })).statusCode).toBe(422);
    expect((await post("/v1/memory/translate", { text: "coffee", content: { ...content, locator: "s".repeat(33) } })).statusCode).toBe(422);
    expect(h.fake.callsTo("memory", "POST", "/internal/v1/translate")).toHaveLength(before);
  });

  it("детский профиль: перевод разрешён (слово из контента), claims ребёнка", async () => {
    const { kid: k, child } = await kid("6-9");
    const res = await post("/v1/memory/translate", { text: "lion", content: { kind: "reading", key: "r-a0-zoo", version: 1 } }, {}, k.access);
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("memory", "POST", "/internal/v1/translate").at(-1)!.claims).toMatchObject({ lrn: child, age_band: "6-9" });
  });

  it("«В словарь» — общий с переводом лимит tg.memory.translate (обход перевода ИИ закрыт); повтор ключа лимит не тратит", async () => {
    const src = { kind: "reading", key: "r-a1-coffee-shop", version: 2 };
    const repeatKey = idem();
    expect((await post("/v1/memory/cards", { text_en: "receipt", source: src }, repeatKey)).statusCode).toBe(201);
    for (let i = 0; i < 30; i++) expect((await post("/v1/memory/translate", { text: "coffee", content: src })).statusCode, `t${i}`).toBe(200);
    for (let i = 0; i < 29; i++) expect((await post("/v1/memory/cards", { text_en: `word${i}`, source: src }, idem())).statusCode, `c${i}`).toBe(201);
    // 1 + 30 + 29 = 60: дальше — 429 и на «в словарь», и на перевод; memory не вызывается
    const card = await post("/v1/memory/cards", { text_en: "menu", source: src }, idem());
    expect(card.statusCode).toBe(429);
    expect(card.json()).toMatchObject({ code: "RATE_LIMITED", details: { policy: "tg.memory.translate" } });
    expect((await post("/v1/memory/translate", { text: "coffee", content: src })).statusCode).toBe(429);
    expect(h.fake.callsTo("memory", "POST", "/internal/v1/cards")).toHaveLength(30);
    // повтор уже отвеченного ключа — проходит (тот же ответ memory), лимит не тратит
    const again = await post("/v1/memory/cards", { text_en: "receipt", source: src }, repeatKey);
    expect(again.statusCode).toBe(201);
  });

  it("лимит tg.memory.translate: 60 за 10 минут на ученика, 61-й — 429 без вызова memory", async () => {
    for (let i = 0; i < 60; i++) expect((await post("/v1/memory/translate", { text: "coffee", content })).statusCode, String(i)).toBe(200);
    const r = await post("/v1/memory/translate", { text: "coffee", content });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ code: "RATE_LIMITED", details: { policy: "tg.memory.translate" } });
    expect(h.fake.callsTo("memory", "POST", "/internal/v1/translate")).toHaveLength(60);
  });
});

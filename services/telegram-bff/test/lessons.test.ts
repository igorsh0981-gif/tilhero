/**
 * Спринт 4 через BFF: карточка урока (AT-39), сессии урока / сценария / медиа и их статусы (AT-39, AT-41, AT-48),
 * шаги и ролевая ситуация (AT-40, AT-43), идемпотентность и восстановление (AT-42), итоги и оценка (AT-45),
 * апелляции (AT-47), история; дети 6–13 — без свободного текста; ключи ответов не уходят ученику; тексты ученика — не в логах.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRET } from "./fakeLessons.js";
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

async function kidSession(): Promise<{ kid: LoggedIn; child: string }> {
  const child = h.fake.addChild(s.userId, "Мадина", "6-9");
  h.fake.onboard(child);
  return { kid: await switchTo(h, s, child), child };
}

async function startLesson(token = s.access): Promise<string> {
  const res = await post("/v1/lessons/l-a1-03-cafe/sessions", undefined, idem(), token);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().session_id as string;
}

/** Пройти шаги до нужного типа (ответы: верный выбор, «Дальше», реплика). */
async function advanceTo(id: string, type: string, token = s.access): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 0; i < 10; i++) {
    const step = (await get(`/v1/sessions/${id}/current`, token)).json();
    if (step.type === type) return step;
    const body = step.type === "item" ? { answer: 0 } : step.type === "roleplay" ? { choice_id: step.choices[0].choice_id } : step.type === "open_answer" ? { text: "I'd like a coffee" } : {};
    const res = await post(`/v1/sessions/${id}/steps/${step.step_id}`, body, {}, token);
    expect(res.statusCode, res.body).toBe(200);
  }
  throw new Error(`no step ${type}`);
}

describe("карточка урока (AT-39)", () => {
  it("тема, цель, уровень, длительность, навык, этапы; без наград и ключей; sub = аккаунт, claims lrn и age_band", async () => {
    const res = await get("/v1/lessons/l-a1-03-cafe");
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c).toMatchObject({ lesson_id: "l-a1-03-cafe", level: "A1", duration_min: 20, primary_skill: { skill_id: "en.func.order" }, roleplay_mode: "full", available: true, active_session_id: null });
    expect(c.stages_detail).toHaveLength(5);
    expect(c).not.toHaveProperty("control_items");
    expect(c).not.toHaveProperty("reward_xp");
    expect(res.body).not.toContain(SECRET);
    const call = h.fake.callsTo("lessons", "GET", "/internal/v1/lessons/l-a1-03-cafe/card")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ lrn: s.userId, age_band: "18+", iss: "telegram-bff", aud: "lessons" });
  });

  it("404 LESSON_NOT_AVAILABLE домена — как есть; неверный id — 422; ответ не по контракту — 503", async () => {
    const nf = await get("/v1/lessons/l-hidden");
    expect(nf.statusCode).toBe(404);
    expect(nf.json().code).toBe("LESSON_NOT_AVAILABLE");
    expect((await get("/v1/lessons/BAD%20ID")).statusCode).toBe(422);
    h.fake.override("lessons", "GET", "/internal/v1/lessons/l-a1-03-cafe/card", () => json(200, { lesson_id: "l-a1-03-cafe", level: "Z9" }));
    const bad = await get("/v1/lessons/l-a1-03-cafe");
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "lessons" } });
  });

  it("ребёнку формат ролевой ситуации — всегда выбор реплик; claims: lrn ребёнка, sub — аккаунт, без age_band", async () => {
    const { kid, child } = await kidSession();
    const res = await get("/v1/lessons/l-a1-03-cafe", kid.access);
    expect(res.json().roleplay_mode).toBe("choices");
    const call = h.fake.callsTo("lessons").at(-1)!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims.lrn).toBe(child);
    expect(call.claims).not.toHaveProperty("age_band");
  });
});

describe("старт сессий, активная сессия, статусы (AT-39, AT-41, AT-48)", () => {
  it("Idempotency-Key обязателен; повтор с тем же ключом — та же сессия; вторая — 409 SESSION_ACTIVE {session_id, kind, title}", async () => {
    const none = await post("/v1/lessons/l-a1-03-cafe/sessions");
    expect(none.statusCode).toBe(422);
    expect(none.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(h.fake.callsTo("lessons")).toHaveLength(0);

    const key = idem();
    const a = await post("/v1/lessons/l-a1-03-cafe/sessions", undefined, key);
    const b = await post("/v1/lessons/l-a1-03-cafe/sessions", undefined, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json().session_id).toBe(a.json().session_id);
    expect(h.fake.callsTo("lessons", "POST")[0]!.headers["idempotency-key"]).toBe(key["idempotency-key"]);
    expect(a.json()).not.toHaveProperty("account_id");
    expect(a.json()).not.toHaveProperty("content_versions");

    const c = await post("/v1/scenarios/sc-cafe-order/sessions", undefined, idem());
    expect(c.statusCode).toBe(409);
    expect(c.json()).toMatchObject({ code: "SESSION_ACTIVE", details: { session_id: a.json().session_id, kind: "lesson" } });

    const active = await get("/v1/sessions/active");
    expect(active.json().session.session_id).toBe(a.json().session_id);
    const card = await get("/v1/lessons/l-a1-03-cafe");
    expect(card.json().active_session_id).toBe(a.json().session_id);
  });

  it("сценарий и медиа — отдельные сессии; NO_EXERCISES — 404 как есть; активной нет — {session: null}", async () => {
    expect((await get("/v1/sessions/active")).json()).toEqual({ session: null });
    const sc = await post("/v1/scenarios/sc-cafe-order/sessions", undefined, idem());
    expect(sc.json()).toMatchObject({ kind: "scenario", scenario_id: "sc-cafe-order" });
    expect(h.fake.callsTo("lessons", "POST", "/internal/v1/scenarios/sc-cafe-order/sessions")).toHaveLength(1);
    expect((await post(`/v1/sessions/${sc.json().session_id}/cancel`)).json().status).toBe("cancelled");
    const md = await post("/v1/media/m-own-coffee/sessions", undefined, idem());
    expect(md.json()).toMatchObject({ kind: "media", asset_id: "m-own-coffee" });
    await post(`/v1/sessions/${md.json().session_id}/cancel`);
    const nx = await post("/v1/media/m-no-ex/sessions", undefined, idem());
    expect(nx.statusCode).toBe(404);
    expect(nx.json().code).toBe("NO_EXERCISES");
  });

  it("пауза → продолжение → отмена; неверный переход — 409 SESSION_STATE {status}", async () => {
    const id = await startLesson();
    await get(`/v1/sessions/${id}/current`);
    const p = await post(`/v1/sessions/${id}/pause`);
    expect(p.json()).toMatchObject({ status: "paused", expires_at: "2026-11-22T09:05:00Z" });
    const again = await post(`/v1/sessions/${id}/pause`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "SESSION_STATE", details: { status: "paused" } });
    expect((await post(`/v1/sessions/${id}/resume`)).json().status).toBe("in_progress");
    expect((await post(`/v1/sessions/${id}/cancel`)).json().status).toBe("cancelled");
    expect((await get(`/v1/sessions/${id}/current`)).statusCode).toBe(409);
  });

  it("ребёнок: режим сессии — выбор реплик; чужая сессия (родителя) — 404 SESSION_NOT_FOUND", async () => {
    const parentSession = await startLesson();
    const { kid } = await kidSession();
    const res = await post("/v1/lessons/l-a1-03-cafe/sessions", undefined, idem(), kid.access);
    expect(res.json().ai_mode).toBe("choices");
    const other = await get(`/v1/sessions/${parentSession}`, kid.access);
    expect(other.statusCode).toBe(404);
    expect(other.json().code).toBe("SESSION_NOT_FOUND");
    expect((await post(`/v1/sessions/${parentSession}/pause`, undefined, {}, kid.access)).statusCode).toBe(404);
  });

  it("сессия не UUID — 422 без вызова домена; lessons недоступен — 503 {service: lessons}", async () => {
    expect((await get("/v1/sessions/not-a-uuid")).statusCode).toBe(422);
    expect(h.fake.callsTo("lessons")).toHaveLength(0);
    h.fake.down.add("lessons");
    const res = await get("/v1/sessions/active");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "lessons" } });
  });
});

describe("шаги урока (AT-40, AT-42, AT-43)", () => {
  it("задание без ключа; повторение — сразу верно/неверно; повтор того же ответа — тот же результат; не текущий шаг — 409", async () => {
    const id = await startLesson();
    const step = await get(`/v1/sessions/${id}/current`);
    expect(step.json()).toMatchObject({ step_id: "s1", type: "item", stage: "retrieval", graded_later: false, item: { item_id: "r1", options: ["счёт", "чек"] } });
    expect(Object.keys(step.json().item).sort()).toEqual(["instruction", "item_id", "item_type", "options", "prompt_en"]);
    expect(step.body).not.toContain(SECRET);
    expect(step.body).not.toContain("correct_index");

    const wrong = await post(`/v1/sessions/${id}/steps/s1`, { answer: 1 });
    expect(wrong.json()).toMatchObject({ accepted: true, feedback: { correct: false, correct_answer: "счёт" }, reply: null, next: { step_id: "s2", type: "explanation" } });
    expect(wrong.body).not.toContain("session_internal");
    const retry = await post(`/v1/sessions/${id}/steps/s1`, { answer: 1 });
    expect(retry.json()).toEqual(wrong.json());
    const stale = await post(`/v1/sessions/${id}/steps/s9`, {});
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "STEP_NOT_CURRENT", details: { current_step_id: "s2" } });
  });

  it("проверка без подсказок: правильность не отдаётся, даже если домен прислал; подсказка — 409 HINTS_NOT_ALLOWED без вызова домена", async () => {
    h.fake.lessons.leakFeedback = true;
    const id = await startLesson();
    const step = await advanceTo(id, "item");
    expect(step.stage).toBe("retrieval");
    await post(`/v1/sessions/${id}/steps/s1`, { answer: 0 });
    const graded = await advanceTo(id, "item");
    expect(graded).toMatchObject({ stage: "assessment", graded_later: true, hint_available: false });
    const before = h.fake.callsTo("lessons").length;
    const hint = await post(`/v1/sessions/${id}/steps/${graded.step_id}/hint`);
    expect(hint.statusCode).toBe(409);
    expect(hint.json().code).toBe("HINTS_NOT_ALLOWED");
    expect(h.fake.callsTo("lessons")).toHaveLength(before);
    const res = await post(`/v1/sessions/${id}/steps/${graded.step_id}`, { answer: ["I'd", "like", "tea"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().feedback).toBeNull();
    expect(res.body).not.toContain(SECRET);
    expect(h.logs.text).toContain("feedback on a graded step dropped");
  });

  it("язык ученика (?locale= или Accept-Language) и подсказка аудитории — в query lessons; неверный locale — 422", async () => {
    const id = await startLesson();
    await h.app.inject({ url: `/v1/sessions/${id}/current`, headers: { ...bearer(s.access), "accept-language": "uz" } });
    expect(h.fake.callsTo("lessons", "GET", `/internal/v1/sessions/${id}/current`).at(-1)!.query).toMatchObject({ locale: "uz", audience: "adults" });
    await h.app.inject({ method: "POST", url: `/v1/sessions/${id}/simpler?locale=uz`, headers: { ...bearer(s.access), "accept-language": "ru" } });
    expect(h.fake.callsTo("lessons", "POST", `/internal/v1/sessions/${id}/simpler`).at(-1)!.query).toMatchObject({ locale: "uz" });
    await post(`/v1/sessions/${id}/simpler`);
    expect(h.fake.callsTo("lessons", "POST", `/internal/v1/sessions/${id}/simpler`).at(-1)!.query.locale).toBe("ru");
    expect((await post(`/v1/sessions/${id}/simpler?locale=en`)).statusCode).toBe(422);
    // завершить раньше шага done — 409 STEP_NOT_CURRENT как есть
    expect((await post(`/v1/sessions/${id}/finish`)).json().code).toBe("STEP_NOT_CURRENT");
  });

  it("подсказка на повторении — Localized без служебных полей; «объясни проще» — позиция не меняется", async () => {
    const id = await startLesson();
    await get(`/v1/sessions/${id}/current`);
    const hint = await post(`/v1/sessions/${id}/steps/s1/hint`);
    expect(hint.json()).toEqual({ hint: { ru: "Начните с I'd like", uz: "Начните с I'd like (uz)" } });
    await post(`/v1/sessions/${id}/steps/s1`, { answer: 0 });
    const simpler = await post(`/v1/sessions/${id}/simpler`);
    expect(simpler.json()).toEqual({ explanation: { ru: "Проще: I'd like = мне, пожалуйста", uz: "Проще: I'd like = мне, пожалуйста (uz)" }, example_en: "I'd like a coffee.", example_gloss: { ru: "Мне кофе.", uz: "Мне кофе. (uz)" }, source: "ai" });
    expect((await get(`/v1/sessions/${id}/current`)).json().step_id).toBe("s2");
  });

  it("ролевая ситуация: выбор реплики и свободный текст (взрослому), ответ персонажа; fail → «ещё раз» один раз", async () => {
    const id = await startLesson();
    const rp = await advanceTo(id, "roleplay");
    expect(rp).toMatchObject({ character: { name: "Tom", voice: "en-GB" }, free_text_allowed: true, unclear_attempts: 0 });
    expect(rp).not.toHaveProperty("graph");
    const res = await post(`/v1/sessions/${id}/steps/${rp.step_id}`, { text: "  I'd like a latte, please  " });
    expect(res.json()).toMatchObject({ reply: { character_id: "tom", text_en: "Sure! Anything else?", clarification: false }, next: { type: "roleplay_end", outcome: "fail", can_retry: true } });
    expect(h.fake.callsTo("lessons", "POST", `/internal/v1/sessions/${id}/steps/${rp.step_id}`)[0]!.body).toEqual({ text: "I'd like a latte, please" });
    const retry = await post(`/v1/sessions/${id}/roleplay/retry`);
    expect(retry.json()).toMatchObject({ type: "roleplay", node_id: "n1" });
    await post(`/v1/sessions/${id}/steps/${rp.step_id}`, { choice_id: "c-order" });
    const again = await post(`/v1/sessions/${id}/roleplay/retry`);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("RETRY_NOT_AVAILABLE");
  });

  it("один ответ на шаг: выбор и текст вместе, «Не знаю» с ответом — 422 ANSWER_INVALID; лишнее поле, длинный текст — 422", async () => {
    const id = await startLesson();
    await get(`/v1/sessions/${id}/current`);
    for (const body of [{ choice_id: "c-order", text: "hi" }, { answer: 0, dont_know: true }, { answer: 0, choice_id: "c-order" }]) {
      const res = await post(`/v1/sessions/${id}/steps/s1`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(res.json().code).toBe("ANSWER_INVALID");
    }
    expect((await post(`/v1/sessions/${id}/steps/s1`, { text: "x".repeat(501) })).statusCode).toBe(422);
    expect((await post(`/v1/sessions/${id}/steps/s1`, { text: "   " })).statusCode).toBe(422);
    expect((await post(`/v1/sessions/${id}/steps/s1`, { user_id: "x" })).statusCode).toBe(422);
    expect((await post(`/v1/sessions/${id}/steps/step1`, {})).statusCode).toBe(422);
    expect(h.fake.callsTo("lessons", "POST", `/internal/v1/sessions/${id}/steps/s1`)).toHaveLength(0);
  });

  it("ребёнок: свободный текст — 403 KIDS_NOT_ALLOWED до вызова lessons; в шаге free_text_allowed = false; открытого задания нет", async () => {
    const { kid } = await kidSession();
    const id = await startLesson(kid.access);
    const rp = await advanceTo(id, "roleplay", kid.access);
    expect(rp.free_text_allowed).toBe(false);
    const before = h.fake.callsTo("lessons").length;
    const res = await post(`/v1/sessions/${id}/steps/${rp.step_id}`, { text: "hello" }, {}, kid.access);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("KIDS_NOT_ALLOWED");
    expect(h.fake.callsTo("lessons")).toHaveLength(before);
    const ok = await post(`/v1/sessions/${id}/steps/${rp.step_id}`, { choice_id: "c-order" }, {}, kid.access);
    expect(ok.statusCode).toBe(200);
    // детский урок: после проверки — сразу «готово», без открытого ответа
    await post(`/v1/sessions/${id}/steps/s4`, {}, {}, kid.access);
    const graded = (await get(`/v1/sessions/${id}/current`, kid.access)).json();
    expect(graded.graded_later).toBe(true);
    const next = await post(`/v1/sessions/${id}/steps/${graded.step_id}`, { answer: ["I'd", "like", "tea"] }, {}, kid.access);
    expect(next.json().next.type).toBe("done");
  });

  it("шаг не по контракту: неизвестный тип или поле не того вида по дискриминатору — 503 и предупреждение без значений", async () => {
    const id = await startLesson();
    h.fake.lessons.currentOverride = () => ({ step_id: "s1", stage: "retrieval", position: 1, stage_total: 1, type: "quiz" });
    const a = await get(`/v1/sessions/${id}/current`);
    expect(a.statusCode).toBe(503);
    h.fake.lessons.currentOverride = () => ({ step_id: "s1", stage: "roleplay", position: 1, stage_total: 1, type: "roleplay", node_id: "n1", line_en: "Hi" });
    const b = await get(`/v1/sessions/${id}/current`);
    expect(b.statusCode).toBe(503);
    expect(b.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "lessons" } });
    h.fake.lessons.currentOverride = () => ({ step_id: "s1", stage: "retrieval", position: 1, stage_total: 1, type: "item", item: { item_id: "x", item_type: "essay", instruction: { ru: "", uz: "" }, prompt_en: "", options: [] }, hint_available: false, hints_used: 0, graded_later: false });
    expect((await get(`/v1/sessions/${id}/current`)).statusCode).toBe(503);
    const warns = h.logs.parsed().filter((l) => l.check === "lesson_step.roleplay" || l.check === "lesson_step");
    expect(warns.length).toBeGreaterThanOrEqual(2);
  });

  it("тексты ученика (реплика, открытый ответ) — не в логах", async () => {
    const id = await startLesson();
    const rp = await advanceTo(id, "roleplay");
    await post(`/v1/sessions/${id}/steps/${rp.step_id}`, { text: "MY-SECRET-REPLY please" });
    const open = await advanceTo(id, "open_answer");
    await post(`/v1/sessions/${id}/steps/${open.step_id}`, { text: "MY-OPEN-ANSWER coffee" });
    expect(h.logs.text).not.toContain("MY-SECRET-REPLY");
    expect(h.logs.text).not.toContain("MY-OPEN-ANSWER");
  });
});

describe("итоги и оценка (AT-45)", () => {
  it("finish → итоги: верный ответ только для ошибок, 1–3 ошибки по severity, без служебных полей; повтор — тот же итог; summary", async () => {
    const id = await startLesson();
    await advanceTo(id, "done");
    const res = await post(`/v1/sessions/${id}/finish`);
    expect(res.statusCode, res.body).toBe(200);
    const sm = res.json();
    expect(sm).toMatchObject({ status: "completed", outcome: "fail", minutes: 18, can_review: true, next_lesson: { lesson_id: "l-a1-02" } });
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("internal_note");
    const items = sm.evaluation.items;
    expect(items.find((i: { item_id: string }) => i.item_id === "r1").correct_answer).toBeNull();
    expect(items.find((i: { item_id: string }) => i.item_id === "a1").correct_answer).toBe("I'd like tea");
    expect(sm.evaluation.key_errors.map((e: { turn_id: string }) => e.turn_id)).toEqual(["T2", "a1", "T3"]);
    expect(sm.evaluation.scores[1]).toMatchObject({ code: "grammar", score: null });
    const again = await post(`/v1/sessions/${id}/finish`);
    expect(again.json()).toEqual(sm);
    expect((await get(`/v1/sessions/${id}/summary`)).json()).toEqual(sm);
    expect((await get(`/v1/evaluations/${sm.evaluation.evaluation_id}`)).json()).toEqual(sm.evaluation);
  });

  it("копия оценки старше 90 дней: evidence и correction — пустые строки, проходят как есть (тип ошибки остаётся)", async () => {
    const id = await startLesson();
    await advanceTo(id, "done");
    const ev = (await post(`/v1/sessions/${id}/finish`)).json().evaluation.evaluation_id as string;
    const stored = h.fake.lessons.evaluations.get(ev)!;
    stored.key_errors = stored.key_errors.map((e) => ({ ...e, evidence: "", correction: "" }));
    const view = await get(`/v1/evaluations/${ev}`);
    expect(view.statusCode).toBe(200);
    expect(view.json().key_errors).toEqual([
      { turn_id: "T2", evidence: "", correction: "", error_code: "politeness", severity: "high" },
      { turn_id: "a1", evidence: "", correction: "", error_code: "word_order", severity: "high" },
      { turn_id: "T3", evidence: "", correction: "", error_code: "article", severity: "medium" },
    ]);
  });

  it("незавершённая сессия: summary — 409 SESSION_STATE; review — Idempotency-Key, новая сессия kind review", async () => {
    const id = await startLesson();
    expect((await get(`/v1/sessions/${id}/summary`)).json().code).toBe("SESSION_STATE");
    await advanceTo(id, "done");
    await post(`/v1/sessions/${id}/finish`);
    expect((await post(`/v1/sessions/${id}/review`)).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const key = idem();
    const a = await post(`/v1/sessions/${id}/review`, undefined, key);
    const b = await post(`/v1/sessions/${id}/review`, undefined, key);
    expect(a.statusCode).toBe(201);
    expect(a.json().kind).toBe("review");
    expect(b.json().session_id).toBe(a.json().session_id);
  });

  it("завершение ждёт оценку дольше обычного таймаута (LESSONS_FINISH_TIMEOUT_MS)", async () => {
    const h2 = await makeHarness({ LESSONS_TIMEOUT_MS: "1000", LESSONS_FINISH_TIMEOUT_MS: "5000" });
    try {
      const s2 = await login(h2);
      h2.fake.setAge(s2.userId, "18+");
      const id = randomUUID();
      const slowSummary = async () => {
        await new Promise((r) => setTimeout(r, 1500));
        return domainError(409, "SESSION_STATE", { status: "in_progress" });
      };
      h2.fake.override("lessons", "POST", `/internal/v1/sessions/${id}/finish`, slowSummary);
      h2.fake.override("lessons", "POST", `/internal/v1/sessions/${id}/pause`, slowSummary);
      const fin = await h2.app.inject({ method: "POST", url: `/v1/sessions/${id}/finish`, headers: bearer(s2.access) });
      expect(fin.statusCode).toBe(409);
      const pause = await h2.app.inject({ method: "POST", url: `/v1/sessions/${id}/pause`, headers: bearer(s2.access) });
      expect(pause.statusCode).toBe(503);
    } finally {
      await h2.close();
    }
  });
});

describe("R2-02: ответ на шаг ждёт ИИ (LESSONS_TIMEOUT_MS)", () => {
  it("шаг дольше обычного таймаута доменов, но в пределах LESSONS_TIMEOUT_MS — ответ домена; дольше — 503 без повтора POST", async () => {
    const h2 = await makeHarness({ UPSTREAM_TIMEOUT_MS: "300", LESSONS_TIMEOUT_MS: "1500" });
    try {
      const s2 = await login(h2);
      h2.fake.setAge(s2.userId, "18+");
      const id = randomUUID();
      const path = `/internal/v1/sessions/${id}/steps/s1`;
      const slow = (ms: number) => async () => {
        await new Promise((r) => setTimeout(r, ms));
        return domainError(409, "STEP_NOT_CURRENT", { current_step_id: "s2" });
      };
      const answer = () => h2.app.inject({ method: "POST", url: `/v1/sessions/${id}/steps/s1`, headers: bearer(s2.access), payload: { choice_id: "c1" } });
      // ИИ думает дольше UPSTREAM_TIMEOUT_MS: BFF дожидается ответа lessons
      h2.fake.override("lessons", "POST", path, slow(700));
      const ok = await answer();
      expect(ok.statusCode).toBe(409);
      expect(ok.json()).toMatchObject({ code: "STEP_NOT_CURRENT", details: { current_step_id: "s2" } });
      // дольше LESSONS_TIMEOUT_MS: 503 UPSTREAM_UNAVAILABLE; POST не повторяется — повтор того же ответа делает Mini App
      h2.fake.override("lessons", "POST", path, slow(2500));
      const before = h2.fake.callsTo("lessons", "POST", path).length;
      const late = await answer();
      expect(late.statusCode).toBe(503);
      expect(late.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "lessons" } });
      expect(h2.fake.callsTo("lessons", "POST", path).length - before).toBe(1);
    } finally {
      await h2.close();
    }
  });
});

describe("409 AI_BUSY: тот же ответ ещё обрабатывается", () => {
  it("steps и simpler — код домена как есть (Mini App повторяет тот же ответ)", async () => {
    const id = randomUUID();
    h.fake.override("lessons", "POST", `/internal/v1/sessions/${id}/steps/s3`, () => domainError(409, "AI_BUSY"));
    h.fake.override("lessons", "POST", `/internal/v1/sessions/${id}/simpler`, () => domainError(409, "AI_BUSY"));
    const step = await post(`/v1/sessions/${id}/steps/s3`, { text: "I'd like a latte" });
    expect(step.statusCode).toBe(409);
    expect(step.json().code).toBe("AI_BUSY");
    const simpler = await post(`/v1/sessions/${id}/simpler?locale=ru`);
    expect(simpler.statusCode).toBe(409);
    expect(simpler.json().code).toBe("AI_BUSY");
    expect(h.logs.text).not.toContain("I'd like a latte");
  });
});

describe("апелляции (AT-47)", () => {
  async function finished(): Promise<string> {
    const id = await startLesson();
    await advanceTo(id, "done");
    return (await post(`/v1/sessions/${id}/finish`)).json().evaluation.evaluation_id as string;
  }

  it("причина ≤ 500 (Idempotency-Key) → 201 Appeal; повтор — та же; вторая — 409 APPEAL_EXISTS; причина не в логах", async () => {
    const ev = await finished();
    expect((await post(`/v1/evaluations/${ev}/appeal`, { reason: "Ответ верный" })).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await post(`/v1/evaluations/${ev}/appeal`, { reason: "" }, idem())).statusCode).toBe(422);
    expect((await post(`/v1/evaluations/${ev}/appeal`, { reason: "я".repeat(501) }, idem())).statusCode).toBe(422);
    expect((await post(`/v1/evaluations/${ev}/appeal`, { reason: "ok", user_id: "x" }, idem())).statusCode).toBe(422);
    const key = idem();
    const a = await post(`/v1/evaluations/${ev}/appeal`, { reason: "  APPEAL-REASON-TEXT: I'd like был верно  " }, key);
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ evaluation_id: ev, status: "new", reason: "APPEAL-REASON-TEXT: I'd like был верно", decision_note: null });
    expect(a.json()).not.toHaveProperty("decided_by");
    const b = await post(`/v1/evaluations/${ev}/appeal`, { reason: "APPEAL-REASON-TEXT: I'd like был верно" }, key);
    expect(b.json().appeal_id).toBe(a.json().appeal_id);
    const c = await post(`/v1/evaluations/${ev}/appeal`, { reason: "ещё раз" }, idem());
    expect(c.statusCode).toBe(409);
    expect(c.json().code).toBe("APPEAL_EXISTS");
    expect(h.logs.text).not.toContain("APPEAL-REASON-TEXT");
    const call = h.fake.callsTo("assessment", "POST")[0]!;
    expect(call.subject).toBe(s.userId); // sub = активный ученик (здесь — сам аккаунт)
    expect(call.claims.lrn).toBe(s.userId);
    expect(call.headers["idempotency-key"]).toBe(key["idempotency-key"]);
    expect(call.body).toEqual({ reason: "APPEAL-REASON-TEXT: I'd like был верно" });

    const list = await get("/v1/appeals");
    expect(list.json().items).toHaveLength(1); // элемент не по контракту отброшен
    expect(list.json().items[0]).not.toHaveProperty("staff_id");
    const view = (await get(`/v1/evaluations/${ev}`)).json();
    expect(view.appeal).toMatchObject({ appeal_id: a.json().appeal_id, status: "new" });
    expect(view.appeal).not.toHaveProperty("owner");
  });

  it("текст апелляции стёрт по сроку хранения (reason: null) — проходит в списке и в оценке; reason не строка — не по контракту", async () => {
    const ev = await finished();
    const a = (await post(`/v1/evaluations/${ev}/appeal`, { reason: "Ответ верный" }, idem())).json();
    // 90 дней после решения: assessment стирает текст
    const stored = h.fake.lessons.appeals.get(a.appeal_id)!;
    Object.assign(stored, { status: "upheld", reason: null, decision_note: "Оценка верна.", decided_at: new Date().toISOString() });
    h.fake.lessons.evaluations.get(ev)!.appeal = { ...h.fake.lessons.evaluations.get(ev)!.appeal!, status: "upheld", reason: null, decision_note: "Оценка верна.", decided_at: stored.decided_at };
    const list = await get("/v1/appeals");
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([expect.objectContaining({ appeal_id: a.appeal_id, status: "upheld", reason: null })]);
    const view = await get(`/v1/evaluations/${ev}`);
    expect(view.statusCode).toBe(200);
    expect(view.json().appeal).toMatchObject({ appeal_id: a.appeal_id, reason: null, decision_note: "Оценка верна." });
    // не null и не строка — элемент списка отбрасывается, оценка — 503
    (stored as unknown as { reason: unknown }).reason = 42;
    expect((await get("/v1/appeals")).json().items).toEqual([]);
    (h.fake.lessons.evaluations.get(ev)!.appeal as unknown as { reason: unknown }).reason = 42;
    expect((await get(`/v1/evaluations/${ev}`)).statusCode).toBe(503);
  });

  it("чужая оценка — 404 EVALUATION_NOT_FOUND (sub = ученик); окно закрыто, тренировка — 409 как есть", async () => {
    const ev = await finished();
    h.fake.override("assessment", "POST", `/internal/v1/evaluations/${ev}/appeal`, () => domainError(409, "APPEAL_WINDOW_CLOSED"));
    expect((await post(`/v1/evaluations/${ev}/appeal`, { reason: "поздно" }, idem())).json().code).toBe("APPEAL_WINDOW_CLOSED");
    h.fake.override("assessment", "POST", `/internal/v1/evaluations/${ev}/appeal`, () => domainError(409, "APPEAL_NOT_ALLOWED"));
    expect((await post(`/v1/evaluations/${ev}/appeal`, { reason: "тренировка" }, idem())).json().code).toBe("APPEAL_NOT_ALLOWED");
    const { kid, child } = await kidSession();
    const res = await get(`/v1/evaluations/${ev}`, kid.access);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("EVALUATION_NOT_FOUND");
    // assessment: sub = активный ученик (ребёнок), не аккаунт
    const call = h.fake.callsTo("assessment", "GET").at(-1)!;
    expect(call.subject).toBe(child);
    expect(call.claims.lrn).toBe(child);
  });
});

describe("история сессий", () => {
  it("страница истории; фильтр kind передаётся в lessons; элемент не по контракту отброшен", async () => {
    const id = await startLesson();
    await advanceTo(id, "done");
    await post(`/v1/sessions/${id}/finish`);
    h.fake.lessons.badHistoryItem = true;
    const res = await get("/v1/sessions?kind=lesson&limit=10");
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0]).toMatchObject({ session_id: id, status: "completed", outcome: "fail", passed: false });
    expect(res.json().items[0]).not.toHaveProperty("user_id");
    expect(h.fake.callsTo("lessons", "GET", "/internal/v1/sessions").at(-1)!.query).toMatchObject({ kind: "lesson", limit: "10" });
    expect((await get("/v1/sessions?kind=game")).statusCode).toBe(422);
  });
});

describe("лимиты", () => {
  it("429 RATE_LIMITED на маршрутах урока (общий лимит пользователя)", async () => {
    const h2 = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "3" });
    try {
      const s2 = await login(h2);
      h2.fake.setAge(s2.userId, "18+");
      let last = 0;
      for (let i = 0; i < 5; i++) last = (await h2.app.inject({ url: "/v1/sessions/active", headers: bearer(s2.access) })).statusCode;
      expect(last).toBe(429);
    } finally {
      await h2.close();
    }
  });
});

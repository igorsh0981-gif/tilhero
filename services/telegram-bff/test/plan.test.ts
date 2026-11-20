/**
 * План и график (learning-plan, sub = активный ученик): GET/PATCH /v1/plan (If-Match, PLAN_INVALID), онбординг,
 * план на сегодня, учёт занятий с Idempotency-Key, справочники.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { LearningPlanSchema, TodayPlanSchema } from "../src/schemas.js";
import { bearer, closeRedis, login, makeHarness, switchTo, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
beforeEach(async () => {
  h = await makeHarness();
  s = await login(h);
  h.fake.calls.length = 0;
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const get = (url: string, token = s.access) => h.app.inject({ url, headers: bearer(token) });
const send = (method: "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}, token = s.access) =>
  h.app.inject({ method, url, headers: { ...bearer(token), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("GET /v1/plan", () => {
  it("план по умолчанию активного ученика; learner_id — из сессии, служебные поля домена не уходят", async () => {
    const res = await get("/v1/plan");
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(Value.Check(LearningPlanSchema, p)).toBe(true);
    expect(p).toMatchObject({ learner_id: s.userId, goal: null, schedule: { preset: "daily", preferred_time: "19:00", duration_min: 20, reminders_enabled: false } });
    expect(p.user_id).toBeUndefined();
    expect(p.internal_note).toBeUndefined();
    expect(h.fake.callsTo("learningPlan").map((c) => c.subject)).toEqual([s.userId]);
  });

  it("401 без токена; learning-plan недоступен → 503", async () => {
    expect((await h.app.inject({ url: "/v1/plan" })).statusCode).toBe(401);
    h.fake.down.add("learningPlan");
    const res = await get("/v1/plan");
    expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "learning-plan" } });
  });
});

describe("PATCH /v1/plan (AT-06)", () => {
  it("график: дни, время, длительность, напоминания, зона → сохраняется и виден после повторного входа", async () => {
    const patch = {
      goal: "travel",
      level_self: "beginner",
      topics: ["food", "travel"],
      ui_lang: "uz",
      schedule: { preset: "custom", days: [1, 3, 6], preferred_time: "08:00", duration_min: 15, reminders_enabled: true, timezone: "Asia/Tashkent" },
    };
    const res = await send("PATCH", "/v1/plan", patch);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ...patch, version: 2, course_pair: "ru-en", explain_lang: "ru" });
    const call = h.fake.callsTo("learningPlan", "PATCH", "/internal/v1/me/plan")[0]!;
    expect(call.body).toEqual(patch);
    expect(call.headers["if-match"]).toBeUndefined();
    const again = await login(h);
    expect((await get("/v1/plan", again.access)).json().schedule).toEqual(patch.schedule);
  });

  it("If-Match пробрасывается (3 / \"3\" / W/\"3\"); расхождение → 409 PLAN_VERSION_CONFLICT {current_version}", async () => {
    await send("PATCH", "/v1/plan", { goal: "work" }); // version 2
    const conflict = await send("PATCH", "/v1/plan", { goal: "exam" }, { "if-match": "1" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "PLAN_VERSION_CONFLICT", details: { current_version: 2 } });
    for (const [v, next] of [["2", 3], ['"3"', 4], ['W/"4"', 5]] as const) {
      const ok = await send("PATCH", "/v1/plan", { goal: "exam" }, { "if-match": v });
      expect(ok.statusCode, v).toBe(200);
      expect(ok.json().version).toBe(next);
    }
    expect(h.fake.callsTo("learningPlan", "PATCH").slice(-3).map((c) => c.headers["if-match"])).toEqual(["2", "3", "4"]);
    const bad = await send("PATCH", "/v1/plan", { goal: "exam" }, { "if-match": "abc" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe("VALIDATION_ERROR");
  });

  it("422 PLAN_INVALID {field, reason}: дни, время, длительность, > 5 тем, лишнее поле; домен: тема/зона", async () => {
    const cases: Array<[object, string]> = [
      [{ schedule: { days: [] } }, "schedule.days"],
      [{ schedule: { days: [0, 2] } }, "schedule.days.0"],
      [{ schedule: { days: [1, 8] } }, "schedule.days.1"],
      [{ schedule: { days: [1, 1] } }, "schedule.days"],
      [{ schedule: { preferred_time: "24:00" } }, "schedule.preferred_time"],
      [{ schedule: { preferred_time: "7:00" } }, "schedule.preferred_time"],
      [{ schedule: { duration_min: 25 } }, "schedule.duration_min"],
      [{ schedule: { duration_min: "20" } }, "schedule.duration_min"],
      [{ topics: ["a", "b", "c", "d", "e", "f"] }, "topics"],
      [{ goal: "fun" }, "goal"],
      [{ course_pair: "ru-de" }, "course_pair"],
      [{ schedule: { timezone: "../../etc" } }, "schedule.timezone"],
    ];
    for (const [body, field] of cases) {
      const res = await send("PATCH", "/v1/plan", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(res.json().code).toBe("PLAN_INVALID");
      expect(res.json().details.field, JSON.stringify(body)).toBe(field);
      expect(typeof res.json().details.reason).toBe("string");
    }
    expect(h.fake.callsTo("learningPlan", "PATCH")).toHaveLength(0);
    const topic = await send("PATCH", "/v1/plan", { topics: ["astrology"] });
    expect(topic.json()).toMatchObject({ code: "PLAN_INVALID", details: { field: "topics", reason: "unknown_topic" } });
    const tz = await send("PATCH", "/v1/plan", { schedule: { timezone: "Mars/Base" } });
    expect(tz.json()).toMatchObject({ code: "PLAN_INVALID", details: { field: "schedule.timezone" } });
  });

  it("язык интерфейса плана меняется отдельно от учебной пары (AT-05)", async () => {
    const res = await send("PATCH", "/v1/plan", { ui_lang: "uz" });
    expect(res.json()).toMatchObject({ ui_lang: "uz", course_pair: "ru-en" });
  });
});

describe("POST /v1/plan/onboarding/complete", () => {
  it("409 PLAN_INCOMPLETE {missing}; после цели и уровня — завершён, session.onboarding_completed=true; повтор — 200", async () => {
    const inc = await send("POST", "/v1/plan/onboarding/complete");
    expect(inc.statusCode).toBe(409);
    expect(inc.json()).toMatchObject({ code: "PLAN_INCOMPLETE", details: { missing: ["goal", "level_self"] } });
    await send("PATCH", "/v1/plan", { goal: "daily", level_self: "zero" });
    const ok = await send("POST", "/v1/plan/onboarding/complete");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().onboarding_completed_at).toBe("2026-11-18T10:05:00Z");
    expect((await send("POST", "/v1/plan/onboarding/complete")).statusCode).toBe(200);
    expect((await login(h)).body.onboarding_completed).toBe(true);
  });
});

describe("GET /v1/plan/today, POST /v1/plan/activity", () => {
  it("занятие с Idempotency-Key → TodayPlan; повтор того же ключа не учитывает дважды", async () => {
    const t0 = await get("/v1/plan/today");
    expect(Value.Check(TodayPlanSchema, t0.json())).toBe(true);
    expect(t0.json()).toMatchObject({ minutes_today: 0, done_today: false });
    const key = randomUUID();
    const a1 = await send("POST", "/v1/plan/activity", { kind: "practice", minutes: 12 }, { "idempotency-key": key });
    expect(a1.statusCode).toBe(200);
    expect(a1.json().minutes_today).toBe(12);
    const a2 = await send("POST", "/v1/plan/activity", { kind: "practice", minutes: 12 }, { "idempotency-key": key.toUpperCase() });
    expect(a2.json().minutes_today).toBe(12);
    const a3 = await send("POST", "/v1/plan/activity", { kind: "practice", minutes: 10 }, { "idempotency-key": randomUUID() });
    expect(a3.json()).toMatchObject({ minutes_today: 22, done_today: true });
    const calls = h.fake.callsTo("learningPlan", "POST", "/internal/v1/me/activities");
    expect(calls[0]!.headers["idempotency-key"]).toBe(key);
    expect(calls[1]!.headers["idempotency-key"]).toBe(key);
    expect(calls[0]!.body).toEqual({ kind: "practice", minutes: 12 });
    expect(calls.every((c) => c.subject === s.userId)).toBe(true);
  });

  it("422: без/с неверным Idempotency-Key, kind не practice, минуты вне 1..240, occurred_at от клиента", async () => {
    const noKey = await send("POST", "/v1/plan/activity", { kind: "practice", minutes: 5 });
    expect(noKey.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await send("POST", "/v1/plan/activity", { kind: "practice", minutes: 5 }, { "idempotency-key": "abc" })).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    for (const body of [{ kind: "lesson", minutes: 5 }, { kind: "practice", minutes: 0 }, { kind: "practice", minutes: 241 }, { kind: "practice", minutes: 2.5 }, { kind: "practice", minutes: 5, occurred_at: "2026-11-01T00:00:00Z" }]) {
      const res = await send("POST", "/v1/plan/activity", body, { "idempotency-key": randomUUID() });
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
    }
    expect(h.fake.callsTo("learningPlan", "POST")).toHaveLength(0);
  });

  it("детский профиль: занятие и план — ребёнка, у родителя не меняется", async () => {
    h.fake.setAge(s.userId, "18+");
    const child = h.fake.addChild(s.userId);
    const c = await switchTo(h, s, child);
    await send("POST", "/v1/plan/activity", { kind: "practice", minutes: 7 }, { "idempotency-key": randomUUID() }, c.access);
    expect((await get("/v1/plan/today", c.access)).json().minutes_today).toBe(7);
    expect((await get("/v1/plan", c.access)).json().learner_id).toBe(child);
    const back = await switchTo(h, c, s.userId);
    expect((await get("/v1/plan/today", back.access)).json().minutes_today).toBe(0);
  });

  it("спринт 6: week[].frozen — как у learning-plan; без поля (learning-plan до спринта 6) — false, и в ответе на занятие", async () => {
    const week = [
      { local_date: "2026-11-16", scheduled: true, done: false, missed: true, frozen: true },
      { local_date: "2026-11-17", scheduled: true, done: true, missed: false },
      { local_date: "2026-11-18", scheduled: false, done: false, missed: false, frozen: "yes" },
    ];
    const today = { local_date: "2026-11-18", is_scheduled_today: false, slot_time: null, duration_min: 20, minutes_today: 0, done_today: false, next_slot: null, streak_days: 2, week };
    const reply = () => new Response(JSON.stringify(today), { status: 200, headers: { "content-type": "application/json" } });
    h.fake.override("learningPlan", "GET", "/internal/v1/me/plan/today", reply);
    h.fake.override("learningPlan", "POST", "/internal/v1/me/activities", reply);
    const expected = [
      { local_date: "2026-11-16", scheduled: true, done: false, missed: true, frozen: true },
      { local_date: "2026-11-17", scheduled: true, done: true, missed: false, frozen: false },
      { local_date: "2026-11-18", scheduled: false, done: false, missed: false, frozen: false },
    ];
    const t = await get("/v1/plan/today");
    expect(t.statusCode).toBe(200);
    expect(Value.Check(TodayPlanSchema, t.json())).toBe(true);
    expect(t.json().week).toEqual(expected);
    const a = await send("POST", "/v1/plan/activity", { kind: "practice", minutes: 5 }, { "idempotency-key": randomUUID() });
    expect(a.json().week).toEqual(expected);
  });
});

describe("справочники", () => {
  it("цели и темы RU/UZ, private-кэш 5 мин", async () => {
    const g = await get("/v1/directory/goals");
    expect(g.statusCode).toBe(200);
    expect(g.headers["cache-control"]).toBe("private, max-age=300");
    expect(g.json().items).toHaveLength(6);
    expect(g.json().items[0]).toEqual({ code: "work", label: { ru: "цель work", uz: "maqsad work" }, icon: null });
    expect((await get("/v1/directory/topics")).json().items).toHaveLength(12);
    expect((await h.app.inject({ url: "/v1/directory/topics" })).statusCode).toBe(401);
  });
});

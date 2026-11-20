/**
 * Спринт 5 через BFF — «Чтение» (bff.ts ReadingCard, ReadingView, шаг reading; INTERNAL_API §2.1, §4) и согласие опекуна
 * на запись голоса (PUT /v1/learners/{id}/voice-consent, LearnerSummary.voice_consent; §6).
 * Тексты — по аудитории активного ученика (ребёнку — только детские), last_result — из lessons одним вызовом,
 * in_dictionary — из memory пакетом (сбой — null), вопросов и ответов в тексте нет; сессия чтения — kind reading через
 * общие маршруты сессий со строгой проверкой шага reading.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEM_SECRET } from "./fakeMemory.js";
import { bearer, closeRedis, idem, json, login, makeHarness, switchTo, type Harness, type LoggedIn, TG_OTHER } from "./helpers.js";

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
const put = (url: string, payload: unknown, token = s.access) => h.app.inject({ method: "PUT", url, headers: bearer(token), payload: payload as object });

async function kid(band: "6-9" | "10-13" = "6-9"): Promise<{ kid: LoggedIn; child: string }> {
  const child = h.fake.addChild(s.userId, "Мадина", band);
  h.fake.onboard(child);
  return { kid: await switchTo(h, s, child), child };
}

describe("список текстов (GET /v1/practice/readings)", () => {
  it("взрослый: тексты взрослой аудитории, pair_id и уровень — в catalog; last_result — из lessons одним вызовом; служебное отброшено", async () => {
    h.fake.reading.results.set(`${s.userId}:r-a1-coffee-shop`, { correct: 2, total: 3, finished_at: "2026-11-19T10:00:00Z" });
    const res = await get("/v1/practice/readings");
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.reading_id)).toEqual(["r-a1-coffee-shop", "r-a2-office"]);
    expect(items[0]).toEqual({
      reading_id: "r-a1-coffee-shop",
      title: { ru: "В кофейне", uz: "В кофейне (uz)" },
      level: "A1",
      topics: ["food"],
      est_minutes: 5,
      word_count: 80,
      last_result: { correct: 2, total: 3, finished_at: "2026-11-19T10:00:00Z" },
    });
    expect(items[1]!.last_result).toBeNull();
    expect(res.body).not.toContain(MEM_SECRET);
    const cat = h.fake.callsTo("catalog", "GET", "/internal/v1/readings")[0]!;
    expect(cat.query).toMatchObject({ pair_id: "ru-en", audience: "adults", limit: "20" });
    expect(cat.subject).toBe(s.userId);
    expect(cat.claims).toMatchObject({ lrn: s.userId, age_band: "18+" });
    const lr = h.fake.callsTo("lessons", "GET", "/internal/v1/reading-results");
    expect(lr).toHaveLength(1);
    expect(lr[0]!.query.ids).toBe("r-a1-coffee-shop,r-a2-office");

    expect((await get("/v1/practice/readings?level=A2")).json().items.map((i: { reading_id: string }) => i.reading_id)).toEqual(["r-a2-office"]);
    expect(h.fake.callsTo("catalog", "GET", "/internal/v1/readings").at(-1)!.query.level).toBe("A2");
    expect((await get("/v1/practice/readings?level=C1")).statusCode).toBe(422);
    expect((await get("/v1/practice/readings?limit=51")).statusCode).toBe(422);
  });

  it("детский профиль — только детские тексты (claims ребёнка, audience kids); подросток — без детских и взрослых-only", async () => {
    const { kid: k, child } = await kid();
    const res = await get("/v1/practice/readings", k.access);
    expect(res.json().items.map((i: { reading_id: string }) => i.reading_id)).toEqual(["r-a0-zoo"]);
    const cat = h.fake.callsTo("catalog", "GET", "/internal/v1/readings").at(-1)!;
    expect(cat.query.audience).toBe("kids");
    expect(cat.claims).toMatchObject({ lrn: child });
    expect(cat.claims).not.toHaveProperty("age_band");

    const teen = await login(h, TG_OTHER);
    h.fake.setAge(teen.userId, "14-17");
    expect((await get("/v1/practice/readings", teen.access)).json().items.map((i: { reading_id: string }) => i.reading_id)).toEqual(["r-a1-coffee-shop"]);
  });

  it("lessons недоступен — список без last_result (200); пустая страница — lessons не вызывается; 401", async () => {
    h.fake.reading.resultsDown = true;
    h.fake.reading.results.set(`${s.userId}:r-a1-coffee-shop`, { correct: 1, total: 3, finished_at: "2026-11-19T10:00:00Z" });
    const res = await get("/v1/practice/readings");
    expect(res.statusCode).toBe(200);
    expect(res.json().items.every((i: { last_result: unknown }) => i.last_result === null)).toBe(true);
    const before = h.fake.callsTo("lessons").length;
    expect((await get("/v1/practice/readings?level=B2")).json()).toEqual({ items: [], next_cursor: null });
    expect(h.fake.callsTo("lessons")).toHaveLength(before);
    expect((await h.app.inject({ url: "/v1/practice/readings" })).statusCode).toBe(401);
  });
});

describe("текст (GET /v1/practice/readings/{id})", () => {
  it("ReadingView без вопросов и ответов; in_dictionary — из memory пакетом (cards/lookup)", async () => {
    const cards = (await get("/v1/memory/cards")).json().items as Array<{ card_id: string; text_en: string }>;
    const res = await get("/v1/practice/readings/r-a1-coffee-shop");
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(Object.keys(v).sort()).toEqual(["est_minutes", "glossary", "level", "paragraphs", "question_types", "questions_count", "reading_id", "title", "version", "voice"]);
    expect(v).toMatchObject({ reading_id: "r-a1-coffee-shop", version: 2, voice: "en-GB", questions_count: 2, question_types: ["true_false", "gap_fill"] });
    expect(v.paragraphs[0].sentences[0]).toEqual({ s_id: "s1", text_en: "Welcome to the r-a1-coffee-shop.", gloss: { ru: "Добро пожаловать", uz: "Добро пожаловать (uz)" } });
    const byEn = Object.fromEntries((v.glossary as Array<{ en: string; in_dictionary: string | null }>).map((g) => [g.en, g.in_dictionary]));
    expect(byEn).toEqual({
      coffee: cards.find((c) => c.text_en === "coffee")!.card_id,
      "take away": cards.find((c) => c.text_en === "take away")!.card_id,
      receipt: null,
    });
    expect(res.body).not.toContain(MEM_SECRET);
    const lookup = h.fake.callsTo("memory", "POST", "/internal/v1/cards/lookup")[0]!;
    expect(lookup.body).toEqual({ texts: ["coffee", "take away", "receipt"] });
    expect(lookup.claims).toMatchObject({ lrn: s.userId, age_band: "18+" });
  });

  it("memory недоступна или ответ не по контракту — текст показывается, in_dictionary = null", async () => {
    h.fake.memory.lookupDown = true;
    const a = await get("/v1/practice/readings/r-a1-coffee-shop");
    expect(a.statusCode).toBe(200);
    expect(a.json().glossary.every((g: { in_dictionary: unknown }) => g.in_dictionary === null)).toBe(true);
    h.fake.memory.lookupDown = false;
    h.fake.override("memory", "POST", "/internal/v1/cards/lookup", () => json(200, { found: ["coffee"] }));
    const b = await get("/v1/practice/readings/r-a1-coffee-shop");
    expect(b.statusCode).toBe(200);
    expect(b.json().glossary.every((g: { in_dictionary: unknown }) => g.in_dictionary === null)).toBe(true);
    h.fake.down.add("memory");
    expect((await get("/v1/practice/readings/r-a1-coffee-shop")).statusCode).toBe(200);
  });

  it("ребёнку взрослый текст — 404 READING_NOT_AVAILABLE; детский — 200; неверный id — 422; не по контракту — 503", async () => {
    const { kid: k } = await kid();
    const nf = await get("/v1/practice/readings/r-a1-coffee-shop", k.access);
    expect([nf.statusCode, nf.json().code]).toEqual([404, "READING_NOT_AVAILABLE"]);
    expect((await get("/v1/practice/readings/r-a0-zoo", k.access)).statusCode).toBe(200);
    s = await login(h); // переключение на ребёнка отзывает прежний access родителя
    expect((await get("/v1/practice/readings/BAD%20ID")).statusCode).toBe(422);
    h.fake.override("catalog", "GET", "/internal/v1/readings/r-a2-office", () => json(200, { reading_id: "r-a2-office", level: "Z9" }));
    expect((await get("/v1/practice/readings/r-a2-office")).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "catalog" } });
  });
});

describe("сессия чтения (POST /v1/practice/readings/{id}/sessions, общие маршруты сессий)", () => {
  it("Idempotency-Key обязателен; 201 kind reading, повтор ключа — та же; служебное lessons отброшено; audience и locale", async () => {
    const none = await post("/v1/practice/readings/r-a1-coffee-shop/sessions");
    expect(none.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const key = idem();
    const a = await post("/v1/practice/readings/r-a1-coffee-shop/sessions", undefined, key);
    const b = await post("/v1/practice/readings/r-a1-coffee-shop/sessions", undefined, key);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(b.json().session_id).toBe(a.json().session_id);
    expect(a.json()).toMatchObject({ kind: "reading", status: "ready", stages: [{ type: "reading" }, { type: "questions" }, { type: "summary" }] });
    expect(a.json()).not.toHaveProperty("account_id");
    expect(a.json()).not.toHaveProperty("content_versions");
    const call = h.fake.callsTo("lessons", "POST", "/internal/v1/readings/r-a1-coffee-shop/sessions")[0]!;
    expect(call.query).toMatchObject({ audience: "adults", locale: "ru" });
    expect(call.headers["idempotency-key"]).toBe(key["idempotency-key"]);
    expect(call.claims).toMatchObject({ lrn: s.userId, age_band: "18+" });

    const busy = await post("/v1/practice/readings/r-a2-office/sessions", undefined, idem());
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ code: "SESSION_ACTIVE", details: { session_id: a.json().session_id, kind: "reading" } });
  });

  it("ребёнку — только детские тексты: взрослый → 404 READING_NOT_AVAILABLE, детский → 201", async () => {
    const { kid: k } = await kid();
    const nf = await post("/v1/practice/readings/r-a1-coffee-shop/sessions", undefined, idem(), k.access);
    expect([nf.statusCode, nf.json().code]).toEqual([404, "READING_NOT_AVAILABLE"]);
    expect((await post("/v1/practice/readings/r-a0-zoo/sessions", undefined, idem(), k.access)).statusCode).toBe(201);
    expect(h.fake.callsTo("lessons", "POST").at(-1)!.query.audience).toBe("kids");
  });

  it("шаги: reading (строго, in_dictionary из memory) → вопрос item graded_later без ключа и подсказки → done", async () => {
    const sid = (await post("/v1/practice/readings/r-a1-coffee-shop/sessions", undefined, idem())).json().session_id as string;
    const step = await get(`/v1/sessions/${sid}/current`);
    expect(step.statusCode, step.body).toBe(200);
    expect(step.json()).toMatchObject({ step_id: "s1", stage: "reading", type: "reading", reading: { reading_id: "r-a1-coffee-shop", questions_count: 2 } });
    expect(step.json().reading.glossary.find((g: { en: string }) => g.en === "coffee").in_dictionary).toMatch(/^[0-9a-f-]{36}$/);

    const r1 = await post(`/v1/sessions/${sid}/steps/s1`, {});
    expect(r1.statusCode).toBe(200);
    const q = r1.json().next;
    expect(q).toMatchObject({ type: "item", stage: "questions", graded_later: true, hint_available: false, item: { item_type: "single_choice", options: ["True", "False"] } });
    expect(r1.body).not.toContain(MEM_SECRET);
    expect(q.item).not.toHaveProperty("answer");

    const hint = await post(`/v1/sessions/${sid}/steps/s2/hint`);
    expect([hint.statusCode, hint.json().code]).toEqual([409, "HINTS_NOT_ALLOWED"]);
    const r2 = await post(`/v1/sessions/${sid}/steps/s2`, { answer: 0 });
    expect(r2.json()).toMatchObject({ accepted: true, feedback: null, next: { type: "done" } });

    const hist = await get("/v1/sessions?kind=reading");
    expect(hist.statusCode).toBe(200);
  });

  it("шаг reading не по контракту (нет абзацев / лишний вопрос с ответом) → 503 UPSTREAM_UNAVAILABLE {service: lessons}", async () => {
    const sid = (await post("/v1/practice/readings/r-a1-coffee-shop/sessions", undefined, idem())).json().session_id as string;
    h.fake.override("lessons", "GET", `/internal/v1/sessions/${sid}/current`, () =>
      json(200, { step_id: "s1", stage: "reading", position: 1, stage_total: 1, type: "reading", reading: { reading_id: "r-a1-coffee-shop", version: 2 } }),
    );
    const bad = await get(`/v1/sessions/${sid}/current`);
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "lessons" } });
    expect(h.logs.parsed().some((l) => l.check === "lesson_step.reading")).toBe(true);
  });
});

describe("согласие опекуна на запись голоса (PUT /v1/learners/{id}/voice-consent)", () => {
  const acceptConsent = (userId: string, purposes = ["terms", "privacy", "learning"]) => {
    h.fake.account(userId).consent = { accepted: true, policy_version: "2026-11-18", current_policy_version: "2026-11-18", accepted_at: "2026-11-18T10:00:00Z", evidence_hash: "h", purposes };
  };

  it("родитель 18+ из своего профиля: LearnerSummary с voice_consent; дальше — во всех ответах с учениками", async () => {
    acceptConsent(s.userId);
    const child = h.fake.addChild(s.userId, "Мадина", "6-9");
    h.fake.onboard(child);
    const res = await put(`/v1/learners/${child}/voice-consent`, { granted: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ learner_id: child, kind: "child", display_name: "Мадина", age_band: "6-9", is_active: false, onboarding_completed: true, voice_consent: true });
    const call = h.fake.callsTo("identity", "PUT", `/internal/v1/me/learners/${child}/voice-consent`)[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.body).toEqual({ granted: true });

    const list = (await get("/v1/learners")).json().items as Array<{ learner_id: string; voice_consent: boolean }>;
    expect(list.find((l) => l.learner_id === child)!.voice_consent).toBe(true);
    expect(list.find((l) => l.learner_id === s.userId)!.voice_consent).toBe(false);
    const profile = (await get("/v1/profile")).json();
    expect(profile.learners.find((l: { learner_id: string }) => l.learner_id === child).voice_consent).toBe(true);
    const k = await switchTo(h, s, child);
    expect(k.body.learner).toMatchObject({ learner_id: child, voice_consent: true });

    s = await login(h); // снова профиль родителя
    const off = await put(`/v1/learners/${child}/voice-consent`, { granted: false });
    expect(off.json().voice_consent).toBe(false);
  });

  it("learning-plan недоступен после сохранения согласия — 200 (onboarding_completed = false), а не 503", async () => {
    acceptConsent(s.userId);
    const child = h.fake.addChild(s.userId, "Мадина", "6-9");
    h.fake.onboard(child);
    h.fake.down.add("learningPlan");
    const res = await put(`/v1/learners/${child}/voice-consent`, { granted: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ learner_id: child, kind: "child", voice_consent: true, onboarding_completed: false });
    expect(h.fake.children.get(child)!.voiceConsent).toBe(true);
    expect(h.logs.text).toContain("onboarding unknown, voice consent saved");
    h.fake.down.delete("learningPlan");
    h.fake.override("learningPlan", "GET", "/internal/v1/me/plan", () => json(500, { code: "BOOM" }));
    expect((await put(`/v1/learners/${child}/voice-consent`, { granted: false })).json()).toMatchObject({ voice_consent: false, onboarding_completed: false });
  });

  it("своё согласие с voice_recording — voice_consent аккаунта true (сессия и профиль)", async () => {
    acceptConsent(s.userId, ["terms", "privacy", "learning", "voice_recording"]);
    expect((await get("/v1/profile")).json().learner.voice_consent).toBe(true);
    const again = await login(h);
    expect(again.body.learner.voice_consent).toBe(true);
  });

  it("из детского профиля — 403 ADULT_REQUIRED до identity; чужой ребёнок / свой аккаунт / неверный id — 404 LEARNER_NOT_FOUND", async () => {
    acceptConsent(s.userId);
    const { kid: k, child } = await kid();
    const before = h.fake.callsTo("identity", "PUT").length;
    const fromKid = await put(`/v1/learners/${child}/voice-consent`, { granted: true }, k.access);
    expect([fromKid.statusCode, fromKid.json().code]).toEqual([403, "ADULT_REQUIRED"]);
    expect(h.fake.callsTo("identity", "PUT")).toHaveLength(before);
    s = await login(h);

    const other = await login(h, TG_OTHER);
    h.fake.setAge(other.userId, "18+");
    acceptConsent(other.userId);
    const foreign = await put(`/v1/learners/${child}/voice-consent`, { granted: true }, other.access);
    expect([foreign.statusCode, foreign.json().code]).toEqual([404, "LEARNER_NOT_FOUND"]);
    expect((await put(`/v1/learners/${s.userId}/voice-consent`, { granted: true })).json().code).toBe("LEARNER_NOT_FOUND");
    const bad = await put("/v1/learners/not-a-uuid/voice-consent", { granted: true });
    expect([bad.statusCode, bad.json().code]).toEqual([404, "LEARNER_NOT_FOUND"]);
  });

  it("тело: только {granted: boolean} — иначе 422; без своего согласия — 403 CONSENT_REQUIRED {purpose}; не 18+ — 403 ADULT_REQUIRED; 401", async () => {
    const child = h.fake.addChild(s.userId, "Мадина", "6-9");
    const noConsent = await put(`/v1/learners/${child}/voice-consent`, { granted: true });
    expect(noConsent.statusCode).toBe(403);
    expect(noConsent.json()).toMatchObject({ code: "CONSENT_REQUIRED", details: { purpose: "terms" } });
    acceptConsent(s.userId);
    expect((await put(`/v1/learners/${child}/voice-consent`, { granted: "yes" })).statusCode).toBe(422);
    expect((await put(`/v1/learners/${child}/voice-consent`, { granted: true, purposes: ["voice_recording"] })).statusCode).toBe(422);
    expect((await put(`/v1/learners/${child}/voice-consent`, {})).statusCode).toBe(422);

    const teen = await login(h, TG_OTHER);
    h.fake.setAge(teen.userId, "14-17");
    acceptConsent(teen.userId);
    const t = await put(`/v1/learners/${randomUUID()}/voice-consent`, { granted: true }, teen.access);
    expect([t.statusCode, t.json().code]).toEqual([403, "ADULT_REQUIRED"]);
    expect((await h.app.inject({ method: "PUT", url: `/v1/learners/${child}/voice-consent`, payload: { granted: true } })).statusCode).toBe(401);
  });
});

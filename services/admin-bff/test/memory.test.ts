/**
 * Спринт 5 — «Память, словарь курса, чтение» через admin-bff (memory, catalog, ai-gateway, lessons): права и step-up по
 * ролям PLAN спринта 5 (memory.read, memory.manage + step-up, glossary.manage без step-up), CSRF, коды доменов как есть
 * (FORM_TAKEN, NOT_PENDING, VERSION_CONFLICT, IF_MATCH_REQUIRED, ARCHIVE_NOT_ALLOWED, CARD_STATE, DUE_AT_RANGE),
 * If-Match, строгая проверка ответов доменов, имена сотрудников (`updated_by_name`, `history[].by_name`, `actor_name`),
 * цитата ошибки ученика никогда не уходит, аналитика — k-анонимность (скрытые группы проходят и обнуляются), блок обзора
 * memory (с упавшим memory / catalog), тексты для чтения в общем API контента, `reading` в журнале сессий, речь в ИИ.
 * Общие матрицы (401 / 403 PERMISSION_DENIED / CSRF / step-up / happy path / 4xx-5xx на КАЖДОМ маршруте) —
 * security.test.ts и routes.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdminCardDetail,
  Dashboard,
  ForgettingAnalytics,
  GlossaryDetail,
  GlossaryRow,
  GlossaryStats,
  LearnerMemorySummary,
  MemoryStats,
  Page,
  ReviewLogRow,
  SessionCard,
  SessionRow,
} from "@tilhero/contracts/admin";
import {
  AI_USAGE_SUMMARY,
  AUTHOR_ID,
  CARD_ID,
  GLOSSARY_ENTRY_ID,
  LEARNER_USER_ID,
  MEMORY_STAFF_ID,
  SEED_ACTOR_ID,
  SESSION_ID,
  adminCardDetailDomain,
  aiCall,
  aiProvider,
  browser,
  closeRedis,
  contentVersion,
  domainError,
  forgettingAnalytics,
  glossaryDetailDomain,
  glossaryRowDomain,
  json,
  learnerMemorySummary,
  loginAs,
  makeHarness,
  memoryStats,
  reviewLogRow,
  sessionCardDomain,
  sessionRowDomain,
  speechModel,
  stepUp,
  type Harness,
  type Session,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.fake.addStaff({ role: "methodist", staff_id: AUTHOR_ID, display_name: "Мадина Методист" });
  h.fake.addStaff({ role: "operations", staff_id: MEMORY_STAFF_ID, display_name: "Олим Операции" });
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const SEED_NAME = "Сид (начальное наполнение)";
const G = "/admin/v1/glossary";
const M = "/admin/v1/memory";
const ENTRY = `${G}/${GLOSSARY_ENTRY_ID}`;
const CARD = `${M}/cards/${CARD_ID}`;
const EVIDENCE = "learner-quote-evidence";
const NEW_ENTRY = { pair_id: "ru-en", lemma: "receipt", forms: ["receipt", "receipts"], part_of_speech: "noun", gloss: { ru: "чек", uz: "chek" }, example_en: null, reason: null };
const RESCHEDULE = { action: "reschedule", due_at: "2026-12-01T09:00:00+05:00", reason: "Перенос по просьбе родителя" };

const get = (s: Session, url: string, extra: Record<string, string> = {}) => h.app.inject({ url, headers: browser(s, extra) });
const send = (s: Session, method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  h.app.inject({ method, url, headers: browser(s, extra), ...(payload === undefined ? {} : { payload: payload as object }) });

function denied(res: { statusCode: number; json(): { code: string; details: { permission?: string } } }, permission: string) {
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission } });
}

// ---------------------------------------------------------------- права и step-up

describe("права и step-up (PLAN спринта 5)", () => {
  it("methodist: словарь курса целиком без step-up (glossary.manage); память — только чтение, правка карточки → 403", async () => {
    const { s } = await loginAs(h, "methodist");
    expect((await get(s, G)).statusCode).toBe(200);
    expect((await get(s, ENTRY)).statusCode).toBe(200);
    expect((await get(s, `${G}/stats`)).statusCode).toBe(200);
    expect((await send(s, "POST", G, NEW_ENTRY)).statusCode).toBe(201);
    expect((await send(s, "PATCH", ENTRY, { lemma: "coffee" }, { "if-match": "2026-11-19T10:00:00.000Z" })).statusCode).toBe(200);
    expect((await send(s, "POST", `${ENTRY}/review`, { decision: "approve" })).statusCode).toBe(200);
    expect((await send(s, "DELETE", ENTRY, { reason: "дубль статьи" })).statusCode).toBe(204);
    // словарь — без step-up: ни одна команда не потребовала TOTP
    expect(h.fake.callsTo("catalog", "DELETE")).toHaveLength(1);
    expect((await get(s, `${M}/learners/${LEARNER_USER_ID}`)).statusCode).toBe(200);
    expect((await get(s, `${M}/learners/${LEARNER_USER_ID}/cards`)).statusCode).toBe(200);
    expect((await get(s, CARD)).statusCode).toBe(200);
    expect((await get(s, `${CARD}/log`)).statusCode).toBe(200);
    expect((await get(s, `${M}/analytics`)).statusCode).toBe(200);
    denied(await send(s, "POST", `${CARD}/actions`, RESCHEDULE), "memory.manage");
    expect(h.fake.callsTo("memory", "POST")).toHaveLength(0);
  });

  it("operations: ручная правка карточки — memory.manage + step-up (до step-up домен не вызывается); словаря не правит", async () => {
    const { s } = await loginAs(h, "operations");
    expect((await get(s, CARD)).statusCode).toBe(200);
    const before = await send(s, "POST", `${CARD}/actions`, RESCHEDULE);
    expect(before.statusCode).toBe(403);
    expect(before.json()).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: "memory.manage" } });
    expect(h.fake.callsTo("memory", "POST")).toHaveLength(0);
    await stepUp(h, s);
    const res = await send(s, "POST", `${CARD}/actions`, RESCHEDULE, { "idempotency-key": "card-action-0001" });
    expect(res.statusCode).toBe(200);
    const call = h.fake.callsTo("memory", "POST", `${CARD}/actions`)[0]!;
    expect(call.body).toEqual(RESCHEDULE);
    expect(call.headers["idempotency-key"]).toBe("card-action-0001");
    expect(call.actor?.permissions).toContain("memory.manage");
    expect((res.json() as AdminCardDetail).due_at).toBe(RESCHEDULE.due_at);
    // словарь: читать (content.read) можно, править — нет
    expect((await get(s, G)).statusCode).toBe(200);
    denied(await send(s, "POST", G, NEW_ENTRY), "glossary.manage");
  });

  it("content_manager: словарь (glossary.manage), памяти нет; analyst / auditor / qa_analyst — только чтение; support — только агрегаты", async () => {
    const cm = (await loginAs(h, "content_manager")).s;
    expect((await send(cm, "POST", `${ENTRY}/review`, { decision: "reject", note: "Неверный смысл" })).statusCode).toBe(200);
    denied(await get(cm, `${M}/learners/${LEARNER_USER_ID}`), "memory.read");
    denied(await get(cm, CARD), "memory.read");
    for (const role of ["analyst", "auditor", "qa_analyst"] as const) {
      const { s } = await loginAs(h, role);
      expect((await get(s, `${M}/learners/${LEARNER_USER_ID}`)).statusCode, role).toBe(200);
      expect((await get(s, `${CARD}/log`)).statusCode, role).toBe(200);
      expect((await get(s, G)).statusCode, role).toBe(200);
      denied(await send(s, "POST", `${CARD}/actions`, RESCHEDULE), "memory.manage");
      denied(await send(s, "PATCH", ENTRY, { lemma: "x" }, { "if-match": "2026-11-19T10:00:00.000Z" }), "glossary.manage");
      denied(await send(s, "DELETE", ENTRY, { reason: "удалить" }), "glossary.manage");
    }
    const sup = (await loginAs(h, "support")).s;
    denied(await get(sup, G), "content.read");
    // аналитика — агрегаты для dashboard.read (admin.ts: memory.read | dashboard.read); данных учеников нет
    expect((await get(sup, `${M}/analytics`)).statusCode).toBe(200);
    denied(await get(sup, `${M}/learners/${LEARNER_USER_ID}`), "memory.read");
  });

  it("read_only: аналитика и блок обзора (dashboard.read), счётчики словаря; карточки учеников и словарь — 403", async () => {
    const { s } = await loginAs(h, "read_only");
    expect((await get(s, `${M}/analytics`)).statusCode).toBe(200);
    expect((await get(s, `${M}/stats`)).statusCode).toBe(200);
    expect((await get(s, `${G}/stats`)).statusCode).toBe(200);
    denied(await get(s, `${M}/learners/${LEARNER_USER_ID}`), "memory.read");
    denied(await get(s, G), "content.read");
  });

  it("CSRF: каждая команда спринта 5 без токена / с чужим Origin → 403 CSRF_INVALID, домены не вызываются", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const { "x-csrf-token": _drop, ...noToken } = browser(s);
    const commands: Array<["POST" | "PATCH" | "DELETE", string, unknown]> = [
      ["POST", G, NEW_ENTRY],
      ["PATCH", ENTRY, { lemma: "coffee" }],
      ["POST", `${ENTRY}/review`, { decision: "approve" }],
      ["DELETE", ENTRY, { reason: "дубль статьи" }],
      ["POST", `${CARD}/actions`, RESCHEDULE],
    ];
    const before = h.fake.calls.length;
    for (const [method, url, payload] of commands) {
      for (const headers of [noToken, browser(s, { origin: "https://evil.example" })]) {
        const res = await h.app.inject({ method, url, headers, payload: payload as object });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().code).toBe("CSRF_INVALID");
      }
    }
    expect(h.fake.calls.length).toBe(before);
  });
});

// ---------------------------------------------------------------- словарь курса

describe("словарь курса (catalog)", () => {
  it("список: фильтры передаются, updated_by — как есть, updated_by_name — из lookup (имя домена не берётся), служебное отброшено", async () => {
    const { s } = await loginAs(h, "content_manager");
    const res = await get(s, `${G}?pair_id=ru-en&q=coff&source=ai&review_status=pending&limit=20&cursor=abc`);
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("catalog", "GET", G)[0]!.query).toEqual({ pair_id: "ru-en", q: "coff", source: "ai", review_status: "pending", limit: "20", cursor: "abc" });
    const page = res.json() as Page<GlossaryRow>;
    expect(page.items[0]).toMatchObject({ updated_by: AUTHOR_ID, updated_by_name: "Мадина Методист", source: "course" });
    expect(page.items[1]).toMatchObject({ source: "ai", review_status: "pending", confidence: 0.9, updated_by: null, updated_by_name: null });
    expect(res.body).not.toContain("seq");
    expect(res.body).not.toContain("от домена не берётся");
    // фильтры — из перечней admin.ts
    for (const q of ["source=teacher", "review_status=done", "pair_id=RU-EN", "q=", "archived=true"]) {
      expect((await get(s, `${G}?${q}`)).statusCode, q).toBe(422);
    }
  });

  it("карточка: история с by и by_name (сотрудник — lookup, сид — «Сид», система — null), места в контенте, конфликты", async () => {
    const { s } = await loginAs(h, "analyst");
    const d = (await get(s, ENTRY)).json() as GlossaryDetail;
    expect(d.updated_by_name).toBe("Мадина Методист");
    expect(d.history.map((x) => [x.by, x.by_name])).toEqual([
      [AUTHOR_ID, "Мадина Методист"],
      [SEED_ACTOR_ID, SEED_NAME],
      [null, null],
    ]);
    expect(d.history[0]).toMatchObject({ action: "overridden", before: { gloss: { ru: "кофе", uz: "kofe" } }, reason: "uz — латиница" });
    expect(d.refs_titles[1]).toEqual({ kind: "reading", key: "r-a1-coffee-shop", version: 1, title: null });
    expect(d.conflicts).toEqual([{ ref: { kind: "reading", key: "r-a1-coffee-shop", version: 1 }, gloss: { ru: "кофейня", uz: "qahvaxona" } }]);
    expect(JSON.stringify(d)).not.toContain("seq");
    // невалидный id → 422 без домена
    const before = h.fake.calls.length;
    expect((await get(s, `${G}/not-a-uuid`)).statusCode).toBe(422);
    expect(h.fake.calls.length).toBe(before);
  });

  it("счётчики: GET glossary/stats?pair_id= (dashboard.read | content.read) → GlossaryStats строго", async () => {
    const { s } = await loginAs(h, "methodist");
    const res = await get(s, `${G}/stats?pair_id=ru-en`);
    expect(res.json()).toEqual({ pair_id: null, ai_glosses_pending: 7, ai_approved: 3, ai_rejected: 1, entries: { course: 120, methodist: 4, ai: 11 }, overridden: 2 } satisfies GlossaryStats);
    expect(h.fake.callsTo("catalog", "GET", `${G}/stats`)[0]!.query).toEqual({ pair_id: "ru-en" });
    h.fake.on("catalog", "GET", `${G}/stats`, () => json(200, { pair_id: null, ai_glosses_pending: -1, ai_approved: 0, ai_rejected: 0, entries: { course: 0, methodist: 0, ai: 0 }, overridden: 0 }));
    expect((await get(s, `${G}/stats`)).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "catalog" } });
  });

  it("создание: 201, Idempotency-Key передаётся; вход — по admin.ts до домена; 409 FORM_TAKEN {entry_id, form} — как есть", async () => {
    const { staff, s } = await loginAs(h, "methodist", { display_name: "Камила Методист" });
    const res = await send(s, "POST", G, NEW_ENTRY, { "idempotency-key": "gloss-create-0001" });
    expect(res.statusCode).toBe(201);
    expect(res.json() as GlossaryDetail).toMatchObject({ source: "methodist", updated_by: staff.staff_id, updated_by_name: "Камила Методист" });
    expect(h.fake.callsTo("catalog", "POST", G)[0]!.headers["idempotency-key"]).toBe("gloss-create-0001");
    const bad: unknown[] = [
      { ...NEW_ENTRY, forms: [] },
      { ...NEW_ENTRY, forms: Array.from({ length: 9 }, (_, i) => `f${i}`) },
      { ...NEW_ENTRY, lemma: "x".repeat(61) },
      { ...NEW_ENTRY, gloss: { ru: "чек", uz: "" } },
      { ...NEW_ENTRY, gloss: { ru: "ч".repeat(81), uz: "chek" } },
      { ...NEW_ENTRY, part_of_speech: "noun_phrase" },
      { ...NEW_ENTRY, example_en: "e".repeat(201) },
      { ...NEW_ENTRY, source: "course" },
      (({ reason: _r, ...rest }) => rest)(NEW_ENTRY),
    ];
    const before = h.fake.callsTo("catalog", "POST").length;
    for (const body of bad) expect((await send(s, "POST", G, body)).statusCode, JSON.stringify(body).slice(0, 80)).toBe(422);
    expect(h.fake.callsTo("catalog", "POST")).toHaveLength(before);
    const other = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    h.fake.on("catalog", "POST", G, () => domainError(409, "FORM_TAKEN", { entry_id: other, form: "receipt" }));
    const taken = await send(s, "POST", G, NEW_ENTRY);
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: "FORM_TAKEN", details: { entry_id: other, form: "receipt" } });
    h.fake.on("catalog", "POST", G, () => domainError(422, "GLOSSARY_INVALID", { errors: [{ path: "forms[0]", code: "FORM_INVALID" }] }));
    expect((await send(s, "POST", G, NEW_ENTRY)).json()).toMatchObject({ code: "GLOSSARY_INVALID", details: { errors: [{ path: "forms[0]" }] } });
  });

  it("правка: If-Match передаётся как есть; без него — 428 IF_MATCH_REQUIRED домена, устаревший — 409 VERSION_CONFLICT; override course", async () => {
    const { s } = await loginAs(h, "methodist");
    const IM = "2026-11-19T10:00:00.000Z";
    const override = { override: { gloss: { ru: "кофе", uz: "qahva" }, example_en: "Coffee, please." }, reason: "uz — латиница" };
    const ok = await send(s, "PATCH", ENTRY, override, { "if-match": IM });
    expect(ok.statusCode).toBe(200);
    const call = h.fake.callsTo("catalog", "PATCH", ENTRY)[0]!;
    expect(call.headers["if-match"]).toBe(IM);
    expect(call.body).toEqual(override);
    const d = ok.json() as GlossaryDetail;
    expect(d.override).toMatchObject({ gloss: { ru: "кофе", uz: "qahva" }, by: expect.any(String) });
    expect(d.updated_at).toBe("2026-11-20T10:00:00.000Z");
    // снять override — null
    expect((await send(s, "PATCH", ENTRY, { override: null }, { "if-match": IM })).statusCode).toBe(200);
    h.fake.on("catalog", "PATCH", ENTRY, (c) => (c.headers["if-match"] ? domainError(409, "VERSION_CONFLICT", { updated_at: "2026-11-20T11:00:00.000Z" }) : domainError(428, "IF_MATCH_REQUIRED")));
    const noIm = await send(s, "PATCH", ENTRY, { lemma: "coffee" });
    expect(noIm.statusCode).toBe(428);
    expect(noIm.json().code).toBe("IF_MATCH_REQUIRED");
    const stale = await send(s, "PATCH", ENTRY, { lemma: "coffee" }, { "if-match": IM });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT", details: { updated_at: "2026-11-20T11:00:00.000Z" } });
    for (const code of ["COURSE_ENTRY_LOCKED", "OVERRIDE_COURSE_ONLY", "ENTRY_ARCHIVED"]) {
      h.fake.on("catalog", "PATCH", ENTRY, () => domainError(409, code));
      expect((await send(s, "PATCH", ENTRY, { lemma: "coffee" }, { "if-match": IM })).json().code).toBe(code);
    }
    // до домена: пустая правка, лишнее поле, неполный override, If-Match не того вида → 422
    const before = h.fake.callsTo("catalog", "PATCH").length;
    expect((await send(s, "PATCH", ENTRY, {}, { "if-match": IM })).statusCode).toBe(422);
    expect((await send(s, "PATCH", ENTRY, { source: "methodist" }, { "if-match": IM })).statusCode).toBe(422);
    expect((await send(s, "PATCH", ENTRY, { override: { gloss: { ru: "кофе", uz: "qahva" } } }, { "if-match": IM })).statusCode).toBe(422);
    const badIm = await send(s, "PATCH", ENTRY, { lemma: "coffee" }, { "if-match": "<script>" });
    expect(badIm.statusCode).toBe(422);
    expect(badIm.json().details).toMatchObject({ in: "headers", field: "if-match" });
    expect(h.fake.callsTo("catalog", "PATCH")).toHaveLength(before);
  });

  it("решение по переводу ИИ: correct — только с gloss (иначе 422 до домена); 409 NOT_PENDING — как есть; 404 — как есть", async () => {
    const { s } = await loginAs(h, "methodist");
    const fixed = await send(s, "POST", `${ENTRY}/review`, { decision: "correct", gloss: { ru: "латте", uz: "latte" }, note: null }, { "idempotency-key": "gloss-review-0001" });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json()).toMatchObject({ review_status: "approved", corrected: true, gloss: { ru: "латте", uz: "latte" } });
    expect(h.fake.callsTo("catalog", "POST", `${ENTRY}/review`)[0]!.headers["idempotency-key"]).toBe("gloss-review-0001");
    const before = h.fake.callsTo("catalog", "POST").length;
    const noGloss = await send(s, "POST", `${ENTRY}/review`, { decision: "correct" });
    expect(noGloss.statusCode).toBe(422);
    expect(noGloss.json().details.field).toBe("gloss");
    expect((await send(s, "POST", `${ENTRY}/review`, { decision: "approve", note: "n".repeat(301) })).statusCode).toBe(422);
    expect((await send(s, "POST", `${ENTRY}/review`, { decision: "accept" })).statusCode).toBe(422);
    expect(h.fake.callsTo("catalog", "POST")).toHaveLength(before);
    h.fake.on("catalog", "POST", `${ENTRY}/review`, () => domainError(409, "NOT_PENDING"));
    const np = await send(s, "POST", `${ENTRY}/review`, { decision: "approve" });
    expect(np.statusCode).toBe(409);
    expect(np.json().code).toBe("NOT_PENDING");
    h.fake.on("catalog", "POST", `${ENTRY}/review`, () => domainError(404, "GLOSSARY_ENTRY_NOT_FOUND"));
    expect((await send(s, "POST", `${ENTRY}/review`, { decision: "approve" })).json().code).toBe("GLOSSARY_ENTRY_NOT_FOUND");
  });

  it("архив: тело {reason} передаётся в catalog → 204; статья не методиста → 409 ARCHIVE_NOT_ALLOWED {source}; без причины → 422", async () => {
    const { s } = await loginAs(h, "content_manager");
    const res = await send(s, "DELETE", ENTRY, { reason: "дубль статьи" });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(h.fake.callsTo("catalog", "DELETE", ENTRY)[0]!.body).toEqual({ reason: "дубль статьи" });
    expect((await send(s, "DELETE", ENTRY, {})).statusCode).toBe(422);
    expect((await send(s, "DELETE", ENTRY, { reason: "x" })).statusCode).toBe(422);
    h.fake.on("catalog", "DELETE", ENTRY, () => domainError(409, "ARCHIVE_NOT_ALLOWED", { source: "course" }));
    const course = await send(s, "DELETE", ENTRY, { reason: "дубль статьи" });
    expect(course.statusCode).toBe(409);
    expect(course.json()).toMatchObject({ code: "ARCHIVE_NOT_ALLOWED", details: { source: "course" } });
  });

  it("строгая проверка: неизвестный источник, ref не того вида, время без зоны → 503 {service: catalog}, в лог — путь без значения", async () => {
    const { s } = await loginAs(h, "methodist");
    const broken: Array<Record<string, unknown>> = [
      glossaryDetailDomain({ source: "teacher" }),
      glossaryDetailDomain({ refs: [{ kind: "song", key: "x1", version: 1 }] }),
      glossaryDetailDomain({ updated_at: "2026-11-19 10:00" }),
      glossaryDetailDomain({ history: [{ at: "2026-11-19T10:00:00Z", by: null, by_name: null, action: "deleted", before: null, after: null, reason: null }] }),
      glossaryDetailDomain({ confidence: 1.5 }),
    ];
    for (const body of broken) {
      h.fake.on("catalog", "GET", ENTRY, () => json(200, body));
      const res = await get(s, ENTRY);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "catalog" } });
    }
    h.fake.on("catalog", "GET", G, () => json(200, { items: [glossaryRowDomain({ review_status: "maybe" })], next_cursor: null }));
    expect((await get(s, G)).statusCode).toBe(503);
    expect(h.logs.text).toContain("domain response rejected by normalization");
    expect(h.logs.text).not.toContain("teacher");
  });
});

// ---------------------------------------------------------------- память ученика

describe("память ученика (memory)", () => {
  it("сводка ученика: строго по LearnerMemorySummary; лишнее (items проверок) отброшено; 404 и невалидный id", async () => {
    const { s } = await loginAs(h, "methodist");
    const res = await get(s, `${M}/learners/${LEARNER_USER_ID.toUpperCase()}`);
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("memory", "GET")[0]!.path).toBe(`${M}/learners/${LEARNER_USER_ID}`);
    const sum = res.json() as LearnerMemorySummary;
    expect(sum).toMatchObject({ user_id: LEARNER_USER_ID, pair_id: "ru-en", due_now: 12, overdue_7d: 2, reviews_30d: 140 });
    expect(sum.cards_by_status).toEqual({ new: 5, learning: 8, review: 30, known: 2, frozen: 1, archived: 3 });
    expect(sum.checks[0]).toEqual({
      check_id: sum.checks[0]!.check_id,
      skill_id: "en.func.order",
      skill_title: { ru: "Заказ", uz: "Buyurtma" },
      stage: "d7",
      status: "passed",
      due_at: "2026-11-18T00:00:00.000Z",
      checked_at: "2026-11-18T10:00:00.000Z",
      result: { correct: 3, total: 4 },
      consecutive_failures: 0,
    });
    expect(res.body).not.toContain("item_id");
    h.fake.on("memory", "GET", `${M}/learners/${LEARNER_USER_ID}`, () => domainError(404, "MEMORY_LEARNER_NOT_FOUND"));
    expect((await get(s, `${M}/learners/${LEARNER_USER_ID}`)).json().code).toBe("MEMORY_LEARNER_NOT_FOUND");
    expect((await get(s, `${M}/learners/42`)).statusCode).toBe(422);
    h.fake.on("memory", "GET", `${M}/learners/${LEARNER_USER_ID}`, () => json(200, learnerMemorySummary({ cards_by_status: { new: 1 } })));
    expect((await get(s, `${M}/learners/${LEARNER_USER_ID}`)).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "memory" } });
  });

  it("карточки ученика: фильтры status/kind и страница передаются; цитата ошибки, ключ и допустимые ответы не уходят", async () => {
    const { s } = await loginAs(h, "qa_analyst");
    const res = await get(s, `${M}/learners/${LEARNER_USER_ID}/cards?status=review&kind=error&limit=10&cursor=c1`);
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("memory", "GET", `${M}/learners/${LEARNER_USER_ID}/cards`)[0]!.query).toEqual({ status: "review", kind: "error", limit: "10", cursor: "c1" });
    const page = res.json() as Page<{ card_id: string; error_code: string | null }>;
    expect(page.items).toHaveLength(2);
    expect(page.items[1]).toMatchObject({ kind: "error", error_code: "article" });
    for (const leak of [EVIDENCE, "answers_en", "\"key\""]) expect(res.body).not.toContain(leak);
    for (const q of ["status=deleted", "kind=sentence", "limit=0", "limit=101"]) {
      expect((await get(s, `${M}/learners/${LEARNER_USER_ID}/cards?${q}`)).statusCode, q).toBe(422);
    }
  });

  it("карточка: история планирования (было/стало, алгоритм, версия), actor_name — lookup по staff:<uuid>, иначе имя memory; learner — null", async () => {
    const { s } = await loginAs(h, "auditor");
    const res = await get(s, CARD);
    expect(res.statusCode).toBe(200);
    const d = res.json() as AdminCardDetail;
    expect(d).toMatchObject({ card_id: CARD_ID, user_id: LEARNER_USER_ID, example_en: "A coffee, please.", status: "review", stability: 12.5, retrievability: 0.93 });
    expect(d.sources).toEqual([
      { kind: "lesson", key: "l-a1-05-cafe", version: 2, at: "2026-11-15T09:00:00.000Z" },
      { kind: "manual", key: null, version: null, at: "2026-11-16T09:00:00.000Z" },
    ]);
    expect(d.log.next_cursor).toBe("c2");
    const [learner, staff] = d.log.items as [ReviewLogRow, ReviewLogRow];
    expect(learner).toMatchObject({ actor: "learner", actor_name: null, grade: "good", algorithm: "fsrs-5", params_version: "fsrs5-default-1" });
    expect(learner.before).toEqual({ state: "review", stability: 4.1, difficulty: 5.3, due_at: "2026-11-19T09:00:00.000Z", status: "review" });
    expect(learner.actor_id).toBeNull();
    expect(staff).toMatchObject({ actor: "staff", actor_id: MEMORY_STAFF_ID, actor_name: "Олим Операции", answer_mode: "manual", grade: null, reason: "Перенос по просьбе родителя" });
    // цитата ошибки и служебные поля — не уходят
    for (const leak of [EVIDENCE, "session_id", "\"error\"", "answers_en"]) expect(res.body).not.toContain(leak);
    // actor_id → актуальное имя (lookup); без actor_id — имя memory; memory прошлой версии «staff:<uuid>» → actor_id из
    // actor; у ученика id и имени нет, даже если memory их прислала
    const noId = reviewLogRow({ log_id: "7b3c2d4f-5a6b-4c8d-9e9b-4c5d6e7f8091", actor: "staff", actor_name: "Имя из токена", task_type: "manual", answer_mode: "manual", grade: null });
    const byId = reviewLogRow({ log_id: "8c4d3e5a-6b7c-4d9e-8fac-5d6e7f8091a2", actor: "staff", actor_id: AUTHOR_ID, actor_name: "Старое имя", task_type: "manual", answer_mode: "manual", grade: null });
    const legacy = reviewLogRow({ log_id: "0e6f5a7c-8d9e-4f1a-8bce-7f8091a2b3c4", actor: `staff:${AUTHOR_ID}`, actor_name: "Старое имя", task_type: "manual", answer_mode: "manual", grade: null });
    const learnerWithName = reviewLogRow({ log_id: "9d5e4f6b-7c8d-4e0f-9abd-6e7f8091a2b3", actor: "learner", actor_id: AUTHOR_ID, actor_name: "ученик?" });
    h.fake.on("memory", "GET", `${CARD}/log`, () => json(200, { items: [noId, byId, legacy, learnerWithName], next_cursor: null }));
    const logRes = await get(s, `${CARD}/log?cursor=c2`);
    const log = logRes.json() as Page<ReviewLogRow>;
    expect(h.fake.callsTo("memory", "GET", `${CARD}/log`)[0]!.query).toEqual({ cursor: "c2" });
    expect(log.items.map((x) => [x.actor, x.actor_id, x.actor_name])).toEqual([
      ["staff", null, "Имя из токена"],
      ["staff", AUTHOR_ID, "Мадина Методист"],
      ["staff", AUTHOR_ID, "Мадина Методист"],
      ["learner", null, null],
    ]);
    expect(logRes.body).not.toContain(`staff:${AUTHOR_ID}`);
    // actor_id не UUID → испорченный ответ
    h.fake.on("memory", "GET", `${CARD}/log`, () => json(200, { items: [reviewLogRow({ actor: "staff", actor_id: "staff-1" })], next_cursor: null }));
    expect((await get(s, `${CARD}/log`)).statusCode).toBe(503);
  });

  it("lookup имён недоступен → actor_name — имя, записанное memory (экран открывается)", async () => {
    const { s } = await loginAs(h, "operations");
    h.fake.on("adminIdentity", "GET", "/admin/v1/staff/lookup", () => domainError(500, "BOOM"));
    const d = (await get(s, CARD)).json() as AdminCardDetail;
    expect(d.log.items[1]).toMatchObject({ actor: "staff", actor_name: "Имя из токена" });
  });

  it("ручная правка: тело CardAction строго (reschedule — с due_at, остальные — без; причина 10..300) до домена", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    const bad: unknown[] = [
      { action: "reschedule", reason: "Перенос по просьбе родителя" },
      { action: "reset", due_at: "2026-12-01T09:00:00Z", reason: "Сброс после ошибки урока" },
      { action: "freeze", reason: "коротко" },
      { action: "freeze", reason: "п".repeat(301) },
      { action: "delete", reason: "Удалить карточку целиком" },
      { action: "reschedule", due_at: "завтра", reason: "Перенос по просьбе родителя" },
      { action: "reschedule", due_at: "2026-12-01", reason: "Перенос по просьбе родителя" },
      { ...RESCHEDULE, card_ids: [CARD_ID] },
      [RESCHEDULE],
    ];
    for (const body of bad) expect((await send(s, "POST", `${CARD}/actions`, body)).statusCode, JSON.stringify(body).slice(0, 80)).toBe(422);
    expect(h.fake.callsTo("memory", "POST")).toHaveLength(0);
    for (const action of ["reset", "freeze", "unfreeze"] as const) {
      expect((await send(s, "POST", `${CARD}/actions`, { action, reason: "Решение по обращению 3001" })).statusCode, action).toBe(200);
    }
    expect(h.fake.callsTo("memory", "POST").map((c) => c.body.action)).toEqual(["reset", "freeze", "unfreeze"]);
  });

  it("ручная правка: ответ — карточка с новой строкой истории (actor_name сотрудника); CARD_STATE и DUE_AT_RANGE — как есть; повтор — Idempotent-Replayed", async () => {
    const { staff, s } = await loginAs(h, "operations", { display_name: "Нигора Операции" });
    await stepUp(h, s);
    const res = await send(s, "POST", `${CARD}/actions`, { action: "freeze", reason: "Ученик просил паузу" });
    expect(res.statusCode).toBe(200);
    const d = res.json() as AdminCardDetail;
    expect(d.status).toBe("frozen");
    expect(d.log.items[0]).toMatchObject({ actor: "staff", actor_id: staff.staff_id, actor_name: "Нигора Операции", task_type: "manual", reason: "Ученик просил паузу" });
    h.fake.on("memory", "POST", `${CARD}/actions`, () => domainError(409, "CARD_STATE", { status: "review" }));
    const state = await send(s, "POST", `${CARD}/actions`, { action: "unfreeze", reason: "Ученик вернулся к занятиям" });
    expect(state.statusCode).toBe(409);
    expect(state.json()).toMatchObject({ code: "CARD_STATE", details: { status: "review" } });
    h.fake.on("memory", "POST", `${CARD}/actions`, () => domainError(422, "DUE_AT_RANGE"));
    const range = await send(s, "POST", `${CARD}/actions`, { ...RESCHEDULE, due_at: "2028-01-01T00:00:00Z" });
    expect(range.statusCode).toBe(422);
    expect(range.json().code).toBe("DUE_AT_RANGE");
    h.fake.on("memory", "POST", `${CARD}/actions`, () => json(200, adminCardDetailDomain({ status: "frozen" }), { "idempotent-replayed": "true" }));
    const again = await send(s, "POST", `${CARD}/actions`, { action: "freeze", reason: "Ученик просил паузу" }, { "idempotency-key": "card-action-0002" });
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    // причина правки и цитата ученика — не в логах
    expect(h.logs.text).not.toContain("Ученик просил паузу");
    expect(h.logs.text).not.toContain(EVIDENCE);
  });

  it("строгая проверка: сложность FSRS вне 1..10, неизвестный статус, неизвестный actor, R > 1 → 503 {service: memory}", async () => {
    const { s } = await loginAs(h, "methodist");
    for (const body of [
      adminCardDetailDomain({ difficulty: 11 }),
      adminCardDetailDomain({ status: "suspended" }),
      adminCardDetailDomain({ retrievability: 1.2 }),
      adminCardDetailDomain({ log: { items: [reviewLogRow({ actor: "parent" })], next_cursor: null } }),
      adminCardDetailDomain({ log: { items: [reviewLogRow({ before: { state: "relearning", stability: 1, difficulty: 5, due_at: null, status: "review" } })], next_cursor: null } }),
    ]) {
      h.fake.on("memory", "GET", CARD, () => json(200, body));
      const res = await get(s, CARD);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "memory" } });
    }
    h.fake.down.add("memory");
    expect((await get(s, CARD)).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "memory" } });
  });
});

// ---------------------------------------------------------------- аналитика и обзор

describe("аналитика забывания и обзор", () => {
  it("аналитика: агрегаты строго; скрытые группы (hidden) проходят со скрытыми значениями; user_id не уходит; period по умолчанию 30d", async () => {
    const { s } = await loginAs(h, "analyst");
    const res = await get(s, `${M}/analytics?pair_id=ru-en`);
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("memory", "GET", `${M}/analytics`)[0]!.query).toEqual({ pair_id: "ru-en", period: "30d" });
    const a = res.json() as ForgettingAnalytics;
    expect(a.checks.d7).toEqual({ scheduled: 20, passed: 14, failed: 3, pass_pct: 82.4, hidden: false });
    expect(a.by_skill[0]!.d30).toEqual({ scheduled: 0, passed: 0, failed: 0, pass_pct: null, hidden: true });
    expect(a.by_skill[1]).toMatchObject({ title: null, d7: { hidden: true }, d30: { hidden: true } });
    expect(a.by_lesson[1]).toEqual({ lesson_id: "l-a1-06-shop", title: null, cards: 0, again_pct: null, hidden: true });
    expect(a.repeated_errors[1]).toMatchObject({ error_code: "word_order", hidden: true, learners_with_repeats: 0, cards: 0 });
    expect(a.forgotten_words).toEqual([{ text_en: "receipt", answers: 31, again_pct: 41.9 }]);
    await get(s, `${M}/analytics?pair_id=ru-en&period=90d`);
    expect(h.fake.callsTo("memory", "GET", `${M}/analytics`).at(-1)!.query.period).toBe("90d");
    for (const q of ["period=7d", "pair_id=ru", "user_id=" + LEARNER_USER_ID]) expect((await get(s, `${M}/analytics?${q}`)).statusCode, q).toBe(422);
  });

  it("k-анонимность в глубину: домен прислал hidden: true со значениями или слово < 20 ответов → BFF скрывает сам; user_id отброшен", async () => {
    const { s } = await loginAs(h, "read_only");
    const leaky = forgettingAnalytics({
      checks: { d7: { scheduled: 3, passed: 2, failed: 1, pass_pct: 66.7, hidden: true }, d30: { scheduled: 2, passed: 1, failed: 0, pass_pct: 100, hidden: true } },
      by_lesson: [{ lesson_id: "l-a1-05-cafe", title: null, cards: 4, again_pct: 50, hidden: true, user_ids: [LEARNER_USER_ID] }],
      repeated_errors: [{ error_code: "article", label: { ru: "Артикль", uz: "Artikl" }, learners_with_repeats: 2, cards: 3, hidden: true }],
      forgotten_words: [{ text_en: "receipt", answers: 31, again_pct: 41.9 }, { text_en: "rare", answers: 4, again_pct: 75 }],
      user_id: LEARNER_USER_ID,
    });
    h.fake.on("memory", "GET", `${M}/analytics`, () => json(200, leaky));
    const res = await get(s, `${M}/analytics`);
    expect(res.statusCode).toBe(200);
    const a = res.json() as ForgettingAnalytics;
    expect(a.checks).toEqual({
      d7: { scheduled: 0, passed: 0, failed: 0, pass_pct: null, hidden: true },
      d30: { scheduled: 0, passed: 0, failed: 0, pass_pct: null, hidden: true },
    });
    expect(a.by_lesson).toEqual([{ lesson_id: "l-a1-05-cafe", title: null, cards: 0, again_pct: null, hidden: true }]);
    expect(a.repeated_errors[0]).toMatchObject({ learners_with_repeats: 0, cards: 0, hidden: true });
    expect(a.forgotten_words.map((w) => w.text_en)).toEqual(["receipt"]);
    expect(res.body).not.toContain(LEARNER_USER_ID);
  });

  it("memory/stats (dashboard.read): статистика memory + ai_glosses_pending из catalog glossary/stats; период — запрошенный", async () => {
    const { s } = await loginAs(h, "read_only");
    const res = await get(s, `${M}/stats?period=30d`);
    expect(res.json()).toEqual({ ...memoryStats(), period: "30d", ai_glosses_pending: 7 } satisfies MemoryStats);
    expect(h.fake.callsTo("memory", "GET", `${M}/stats`)[0]!.query).toEqual({ period: "30d" });
    expect(h.fake.callsTo("catalog", "GET", `${G}/stats`)).toHaveLength(1);
    expect((await get(s, `${M}/stats?period=year`)).statusCode).toBe(422);
  });

  it("очередь переводов ИИ: stats 404 → поле ai_glosses_pending сводки контента; нет поля или catalog недоступен → null (не 0), 200", async () => {
    const { s } = await loginAs(h, "read_only");
    h.fake.on("catalog", "GET", `${G}/stats`, () => domainError(404, "NOT_FOUND"));
    h.fake.on("catalog", "GET", "/admin/v1/content/summary", () => json(200, { in_review: 1, ai_glosses_pending: 4 }));
    expect(((await get(s, `${M}/stats`)).json() as MemoryStats).ai_glosses_pending).toBe(4);
    h.fake.on("catalog", "GET", "/admin/v1/content/summary", () => json(200, { in_review: 1 }));
    // значение memory (0 или любое) не используется: очередь — у catalog
    h.fake.on("memory", "GET", `${M}/stats`, () => json(200, memoryStats({ ai_glosses_pending: 2 })));
    const noField = await get(s, `${M}/stats`);
    expect(noField.statusCode).toBe(200);
    expect((noField.json() as MemoryStats).ai_glosses_pending).toBeNull();
    h.fake.down.add("catalog");
    const down = await get(s, `${M}/stats`);
    expect(down.statusCode).toBe(200);
    expect(down.json()).toMatchObject({ review_sessions: 58, ai_glosses_pending: null });
    expect(h.logs.text).toContain("memory stats: ai glosses pending unavailable");
    // memory недоступен — 503 {service: memory}
    h.fake.down.add("memory");
    expect((await get(s, `${M}/stats`)).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "memory" } });
  });

  it("обзор: блок memory с очередью catalog; memory упал / ответил мусором → блок недоступен, остальные на месте, 200", async () => {
    const { s } = await loginAs(h, "read_only");
    const d = (await get(s, "/admin/v1/dashboard?period=7d")).json() as Dashboard;
    expect(d.memory).toEqual({ available: true, data: { ...memoryStats(), period: "7d", ai_glosses_pending: 7 } });
    expect(h.fake.callsTo("memory", "GET", `${M}/stats`)[0]!.query).toEqual({ period: "7d" });
    expect(d.ai.data?.speech).toEqual({ calls: 40, audio_minutes: 3.5, spent_usd: 0.08, speech_available: true });

    h.fake.on("memory", "GET", `${M}/stats`, () => json(200, memoryStats({ d30_pass_pct: 140 })));
    const bad = (await get(s, "/admin/v1/dashboard")).json() as Dashboard;
    expect(bad.memory).toEqual({ available: false, data: null, service: "memory" });
    expect(bad.content.available).toBe(true);

    h.fake.down.add("memory");
    const down = await get(s, "/admin/v1/dashboard");
    expect(down.statusCode).toBe(200);
    const dd = down.json() as Dashboard;
    expect(dd.memory).toEqual({ available: false, data: null, service: "memory" });
    for (const k of ["learners", "support", "content", "diagnostics", "lessons", "ai"] as const) expect(dd[k].available, k).toBe(true);

    // catalog упал: content недоступен, memory — доступен, очередь переводов неизвестна (null, не 0)
    h.fake.down.delete("memory");
    h.fake.on("memory", "GET", `${M}/stats`, () => json(200, memoryStats()));
    h.fake.down.add("catalog");
    const noCatalog = (await get(s, "/admin/v1/dashboard")).json() as Dashboard;
    expect(noCatalog.content).toEqual({ available: false, data: null, service: "catalog" });
    expect(noCatalog.memory).toMatchObject({ available: true, data: { ai_glosses_pending: null, review_sessions: 58 } });
  });
});

// ---------------------------------------------------------------- чтение, журнал, речь

describe("тексты для чтения, журнал сессий reading, речь в ИИ", () => {
  const READING = {
    reading_id: "r-a1-coffee-shop",
    title: { ru: "В кофейне", uz: "Qahvaxonada" },
    level: "A1",
    audience: ["adults"],
    topics: ["food"],
    skill_ids: ["en.read.a1"],
    paragraphs: [{ p_id: "p1", sentences: [{ s_id: "s1", text_en: "I order a coffee.", gloss: { ru: "Я заказываю кофе.", uz: "Men qahva buyurtma qilaman." } }] }],
    glossary: [{ en: "order", gloss: { ru: "заказывать", uz: "buyurtma qilmoq" }, note: null }],
    questions: [{ question_id: "q1", type: "true_false", instruction: { ru: "Верно?", uz: "Toʻgʻrimi?" }, prompt_en: "He orders tea.", options: ["True", "False"], answer: 1 }],
    voice: "en-GB",
    est_minutes: 5,
  };

  it("ContentKind reading — общий API контента: список, черновик, версия с ReadingPayload как есть, проверка, сводка by_kind", async () => {
    const { s } = await loginAs(h, "methodist");
    expect((await get(s, "/admin/v1/content/reading?level=A1")).statusCode).toBe(200);
    expect(h.fake.callsTo("catalog", "GET", "/admin/v1/content/reading")[0]!.query).toEqual({ level: "A1" });
    const created = await send(s, "POST", "/admin/v1/content/reading", { payload: READING });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ kind: "reading", payload: READING });
    h.fake.on("catalog", "GET", "/admin/v1/content/reading/r-a1-coffee-shop/versions/1", () =>
      json(200, contentVersion({ kind: "reading", key: "r-a1-coffee-shop", version: 1, payload: READING })),
    );
    const v = await get(s, "/admin/v1/content/reading/r-a1-coffee-shop/versions/1");
    expect(v.json().payload).toEqual(READING);
    expect((await get(s, "/admin/v1/content/review-queue?kind=reading")).statusCode).toBe(200);
    await stepUp(h, s);
    expect((await send(s, "POST", "/admin/v1/content/reading/r-a1-coffee-shop/versions/1/publish", { reason: "проверено вторым методистом" })).statusCode).toBe(200);
    expect((await get(s, "/admin/v1/content/summary")).json().by_kind.reading).toEqual({ published: 1, drafts: 2, in_review: 1 });
    expect((await get(s, "/admin/v1/content/poem")).statusCode).toBe(422);
  });

  it("журнал «Контроля диалогов»: kind=reading передаётся, reading_id в строке, версия текста reading:<id> в карточке", async () => {
    const { s } = await loginAs(h, "qa_analyst");
    const row = sessionRowDomain({ kind: "reading", lesson_id: null, scenario_id: null, reading_id: "r-a1-coffee-shop", ai_mode: "choices", flags: [] });
    h.fake.on("lessons", "GET", "/admin/v1/lesson-sessions", () => json(200, { items: [row], next_cursor: null }));
    const page = (await get(s, "/admin/v1/qa/sessions?kind=reading")).json() as Page<SessionRow>;
    expect(h.fake.callsTo("lessons", "GET", "/admin/v1/lesson-sessions")[0]!.query.kind).toBe("reading");
    expect(page.items[0]).toMatchObject({ kind: "reading", reading_id: "r-a1-coffee-shop", models: [], cost_usd: 0 });
    h.fake.on("lessons", "GET", `/admin/v1/lesson-sessions/${SESSION_ID}`, () =>
      json(200, sessionCardDomain({ kind: "reading", reading_id: "r-a1-coffee-shop", content_versions: { "reading:r-a1-coffee-shop": 1 } })),
    );
    const card = (await get(s, `/admin/v1/qa/sessions/${SESSION_ID}`)).json() as SessionCard;
    expect(card.session).toMatchObject({ kind: "reading", reading_id: "r-a1-coffee-shop", content_versions: { "reading:r-a1-coffee-shop": 1 } });
    // lessons без reading_id в строке — испорченный ответ (сначала публикуются домены, затем BFF)
    h.fake.on("lessons", "GET", "/admin/v1/lesson-sessions", () => json(200, { items: [{ ...row, reading_id: 5 }], next_cursor: null }));
    expect((await get(s, "/admin/v1/qa/sessions")).statusCode).toBe(503);
  });

  it("модели: речь (azure_speech | fake_speech) с audio_usd_per_hour; правка цены часа передаётся; провайдер речи — без ключа", async () => {
    const { s } = await loginAs(h, "super_admin");
    const models = (await get(s, "/admin/v1/ai/models")).json().items as Array<Record<string, unknown>>;
    expect(models.find((m) => m.model_id === "azure-speech-pa")).toEqual(speechModel());
    expect(models.find((m) => m.model_id === "claude-haiku-5-5")!.audio_usd_per_hour).toBeNull();
    await stepUp(h, s);
    const body = { input_usd_per_mtok: 0, output_usd_per_mtok: 0, audio_usd_per_hour: 1.5, active: true, reason: "тариф Azure 12.2026" };
    const res = await send(s, "PUT", "/admin/v1/ai/models/azure-speech-pa", body);
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("aiGateway", "PUT", "/admin/v1/ai/models/azure-speech-pa")[0]!.body).toEqual(body);
    expect(res.json()).toMatchObject({ audio_usd_per_hour: 1.5 });
    expect((await send(s, "PUT", "/admin/v1/ai/models/azure-speech-pa", { ...body, audio_usd_per_hour: -1 })).statusCode).toBe(422);
    h.fake.on("aiGateway", "PUT", "/admin/v1/ai/models/azure-speech-pa", () => domainError(422, "PRICE_REQUIRED"));
    expect((await send(s, "PUT", "/admin/v1/ai/models/azure-speech-pa", { ...body, audio_usd_per_hour: 0 })).json().code).toBe("PRICE_REQUIRED");
    // цена часа аудио у LLM-модели — PRICE_NOT_APPLICABLE ai-gateway (422 или 409) — как есть
    for (const status of [422, 409]) {
      h.fake.on("aiGateway", "PUT", "/admin/v1/ai/models/claude-haiku-5-5", () => domainError(status, "PRICE_NOT_APPLICABLE", { field: "audio_usd_per_hour" }));
      const na = await send(s, "PUT", "/admin/v1/ai/models/claude-haiku-5-5", { input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5, audio_usd_per_hour: 1, active: true, reason: "ошибочная цена" });
      expect(na.statusCode).toBe(status);
      expect(na.json()).toMatchObject({ code: "PRICE_NOT_APPLICABLE", details: { field: "audio_usd_per_hour" } });
    }
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/models", () => json(200, { items: [speechModel({ provider: "google_speech" })] }));
    expect((await get(s, "/admin/v1/ai/models")).statusCode).toBe(503);
  });

  it("провайдер речи: ключ — только «задан / не задан»; регион не похожий на регион (ключ в переменной) → null; поле speech_key → 503", async () => {
    const { s } = await loginAs(h, "methodist");
    const AZ = "0123456789abcdef0123456789abcdef";
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/provider", () =>
      json(200, aiProvider({ speech: { provider: "azure_speech", key_configured: true, region: "westeurope", last_error: { code: "auth_failed", at: "2026-11-19T10:00:00Z" } } })),
    );
    expect((await get(s, "/admin/v1/ai/provider")).json().speech).toEqual({ provider: "azure_speech", key_configured: true, region: "westeurope", last_error: { code: "auth_failed", at: "2026-11-19T10:00:00Z" } });
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/provider", () => json(200, aiProvider({ speech: { provider: "azure_speech", key_configured: true, region: AZ, last_error: null } })));
    const masked = await get(s, "/admin/v1/ai/provider");
    expect(masked.statusCode).toBe(200);
    expect(masked.json().speech.region).toBeNull();
    expect(masked.body).not.toContain(AZ);
    for (const leak of [{ speech_key: AZ }, { azure_speech_key: AZ }, { "Ocp-Apim-Subscription-Key": AZ }]) {
      h.fake.on("aiGateway", "GET", "/admin/v1/ai/provider", () => json(200, aiProvider({ speech: { provider: "azure_speech", key_configured: true, region: "westeurope", last_error: null, ...leak } })));
      const res = await get(s, "/admin/v1/ai/provider");
      expect(res.statusCode, Object.keys(leak)[0]).toBe(503);
      expect(res.body).not.toContain(AZ);
    }
    expect(h.logs.text).not.toContain(AZ);
  });

  it("вызовы ИИ: оценка произношения — status ok с причиной (insufficient_evidence: low_confidence) проходит как есть", async () => {
    const { s } = await loginAs(h, "operations");
    const speech = aiCall({ agent_id: "pronunciation_coach", model_id: "azure-speech-pa", status: "ok", reason: "low_confidence", audio_ms: 4200, input_tokens: 0, output_tokens: 0, cost_usd: 0.0002, session_id: null });
    // LLM-вызов ai-gateway прошлой версии — без audio_ms: ключа нет (необязательное поле admin.ts)
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/usage", () => json(200, { items: [speech, aiCall()], next_cursor: null }));
    const res = await get(s, "/admin/v1/ai/usage?agent_id=pronunciation_coach");
    expect(res.statusCode).toBe(200);
    const [sp, llm] = res.json().items;
    expect(sp).toMatchObject({ agent_id: "pronunciation_coach", status: "ok", reason: "low_confidence", model_id: "azure-speech-pa", audio_ms: 4200 });
    expect(llm).not.toHaveProperty("audio_ms");
    expect(res.body).not.toContain(LEARNER_USER_ID);
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/usage", () => json(200, { items: [{ ...speech, audio_ms: -1 }], next_cursor: null }));
    expect((await get(s, "/admin/v1/ai/usage?agent_id=pronunciation_coach")).statusCode).toBe(503);
  });

  it("затраты: сводка с блоком speech (входит в spent_usd); без speech от ai-gateway → 503 (строго)", async () => {
    const { s } = await loginAs(h, "operations");
    expect((await get(s, "/admin/v1/ai/usage/summary")).json().speech).toEqual({ calls: 40, audio_minutes: 3.5, spent_usd: 0.08, speech_available: true });
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/usage/summary", () => json(200, { ...AI_USAGE_SUMMARY, speech: { calls: 1 } }));
    expect((await get(s, "/admin/v1/ai/usage/summary")).statusCode).toBe(503);
  });
});

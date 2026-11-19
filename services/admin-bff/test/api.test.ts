/**
 * Поведение разделов admin-bff: агрегация карточки ученика и дашборда (частичная недоступность), раскрытие
 * Telegram ID, поддержка (имена, сводка ученика, Idempotency-Key), «Что нового», шаблоны и рассылки, сотрудники,
 * конфигурация; строгая проверка ответов доменов (испорченное → 503, лишнее отбрасывается, маска Telegram ID).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminLearnerCard, Dashboard, StaffTicket } from "@tilhero/contracts/admin";
import {
  APPROVAL_ID,
  CAMPAIGN_ID,
  LEARNER_ID,
  NOTE_ID,
  OPERATOR_ID,
  TG_FULL,
  TICKET_ID,
  adminExperienceRow,
  approvalRow,
  browser,
  campaignBody,
  campaignRow,
  closeRedis,
  domainError,
  json,
  learnerCard,
  learnerRow,
  loginAs,
  makeHarness,
  releaseNoteBody,
  releaseNoteRow,
  staffRow as staffRowLike,
  stepUp,
  ticketDetail,
  type Harness,
  type Session,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const get = (s: Session, url: string, extra: Record<string, string> = {}) => h.app.inject({ url, headers: browser(s, extra) });
const send = (s: Session, method: "POST" | "PUT" | "PATCH", url: string, payload: unknown, extra: Record<string, string> = {}) =>
  h.app.inject({ method, url, headers: browser(s, extra), payload: payload as object });

describe("ученики: реестр и карточка", () => {
  it("список: фильтры передаются в user-admin, лишние поля read-модели не уходят клиенту", async () => {
    const { s } = await loginAs(h, "support");
    const res = await get(s, "/admin/v1/learners?q=TCK-3001&kind=child&age_band=6-9&status=ACTIVE&locale=ru&has_open_tickets=false&cursor=abc&limit=10");
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("userAdmin", "GET", "/admin/v1/learners")[0]!.query).toEqual({
      q: "TCK-3001",
      kind: "child",
      age_band: "6-9",
      status: "ACTIVE",
      locale: "ru",
      has_open_tickets: "false",
      cursor: "abc",
      limit: "10",
    });
    expect((await get(s, "/admin/v1/learners?age_band=7-9")).statusCode).toBe(422);
    expect((await get(s, "/admin/v1/learners?locale=en")).statusCode).toBe(422);
    expect((await get(s, "/admin/v1/learners?limit=500")).statusCode).toBe(422);
  });

  it("маска Telegram ID: полный ID от домена (ошибка read-модели) клиенту не уходит — поле null", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("userAdmin", "GET", "/admin/v1/learners", () => json(200, { items: [learnerRow({ telegram_id_masked: TG_FULL })], next_cursor: null }));
    const res = await get(s, "/admin/v1/learners");
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].telegram_id_masked).toBeNull();
    expect(res.body).not.toContain(TG_FULL);
    h.fake.on("userAdmin", "GET", `/admin/v1/learners/${LEARNER_ID}`, () => json(200, learnerCard(LEARNER_ID, { telegram_id_masked: TG_FULL })));
    const card = await get(s, `/admin/v1/learners/${LEARNER_ID}`);
    expect(card.json().telegram_id_masked).toBeNull();
    expect(card.body).not.toContain(TG_FULL);
  });

  it("username (ревью T2-3): маска домена проходит; полный — только при users.sensitive.read, иначе BFF маскирует сам", async () => {
    const sup = await loginAs(h, "support");
    const list = await get(sup.s, "/admin/v1/learners");
    expect(list.json().items[0].username).toBe("az•••er");
    expect(list.body).not.toContain("aziz_learner");
    const card = await get(sup.s, `/admin/v1/learners/${LEARNER_ID}`);
    expect(card.json().username).toBe("az•••er");
    expect(card.json().children[0].username).toBeNull();
    // короче 5 символов — «•••»
    h.fake.on("userAdmin", "GET", "/admin/v1/learners", () => json(200, { items: [learnerRow({ username: "abcd" })], next_cursor: null }));
    expect((await get(sup.s, "/admin/v1/learners")).json().items[0].username).toBe("•••");
    // маски домена (обе формы) проходят без изменений
    for (const masked of ["az•••er", "•••"]) {
      h.fake.on("userAdmin", "GET", "/admin/v1/learners", () => json(200, { items: [learnerRow({ username: masked })], next_cursor: null }));
      const r = await get(sup.s, "/admin/v1/learners");
      expect(r.statusCode).toBe(200);
      expect(r.json().items[0].username).toBe(masked);
    }
    // «@» в username не бывает — испорченный ответ
    h.fake.on("userAdmin", "GET", "/admin/v1/learners", () => json(200, { items: [learnerRow({ username: "@aziz" })], next_cursor: null }));
    expect((await get(sup.s, "/admin/v1/learners")).statusCode).toBe(503);
    h.fake.overrides.delete("userAdmin GET /admin/v1/learners");
    const admin = await loginAs(h, "super_admin");
    expect((await get(admin.s, "/admin/v1/learners")).json().items[0].username).toBe("aziz_learner");
    // поиск q=@username передаётся домену как есть (точное совпадение — по полному username)
    await get(sup.s, "/admin/v1/learners?q=%40aziz_learner");
    expect(h.fake.callsTo("userAdmin", "GET", "/admin/v1/learners").at(-1)!.query.q).toBe("@aziz_learner");
  });

  it("карточка (support.read): user-admin + последние 20 обращений support по user_id; служебные поля отброшены", async () => {
    const { s } = await loginAs(h, "support");
    const res = await get(s, `/admin/v1/learners/${LEARNER_ID}`);
    expect(res.statusCode).toBe(200);
    const card = res.json() as AdminLearnerCard;
    expect(card.tickets).toEqual([
      { ticket_id: TICKET_ID, number: "TCK-3001", status: "IN_PROGRESS", category: "LESSON", subject: "Урок не открывается", created_at: "2026-11-08T10:00:00Z" },
    ]);
    expect(card.children).toHaveLength(1);
    expect(card.children[0]!.kind).toBe("child");
    expect(card.plan?.schedule?.preset).toBe("weekdays");
    expect(res.body).not.toContain("search_text");
    expect(res.body).not.toContain("source_updated_at");
    const call = h.fake.callsTo("support", "GET", "/admin/v1/support/tickets")[0]!;
    expect(call.query).toEqual({ user_id: LEARNER_ID, limit: "20" });
    expect(call.actor?.permissions).toContain("support.read");
  });

  it("без support.read → tickets: null, support не вызывается", async () => {
    const { s } = await loginAs(h, "analyst");
    const res = await get(s, `/admin/v1/learners/${LEARNER_ID}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().tickets).toBeNull();
    expect(h.fake.callsTo("support")).toHaveLength(0);
  });

  it("support недоступен, медленный или ответил мусором → tickets: null, карточка открывается", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.down.add("support");
    expect((await get(s, `/admin/v1/learners/${LEARNER_ID}`)).json().tickets).toBeNull();
    h.fake.down.delete("support");
    h.fake.on("support", "GET", "/admin/v1/support/tickets", () => json(200, { items: [{ ticket_id: "x" }], next_cursor: null }));
    const bad = await get(s, `/admin/v1/learners/${LEARNER_ID}`);
    expect(bad.statusCode).toBe(200);
    expect(bad.json().tickets).toBeNull();
    h.fake.on("support", "GET", "/admin/v1/support/tickets", () => new Promise<Response>((r) => setTimeout(() => r(json(200, { items: [], next_cursor: null })), 1500)));
    const slow = await get(s, `/admin/v1/learners/${LEARNER_ID}`);
    expect(slow.statusCode).toBe(200);
    expect(slow.json().tickets).toBeNull();
  });

  it("404 LEARNER_NOT_FOUND user-admin — как есть; невалидный UUID → 422 без вызова домена", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("userAdmin", "GET", `/admin/v1/learners/${LEARNER_ID}`, () => domainError(404, "LEARNER_NOT_FOUND"));
    const res = await get(s, `/admin/v1/learners/${LEARNER_ID}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("LEARNER_NOT_FOUND");
    const before = h.fake.calls.length;
    expect((await get(s, "/admin/v1/learners/not-a-uuid")).statusCode).toBe(422);
    expect(h.fake.calls.length).toBe(before);
  });

  it("user-admin недоступен → 503 UPSTREAM_UNAVAILABLE {service: user-admin}", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.down.add("userAdmin");
    const res = await get(s, `/admin/v1/learners/${LEARNER_ID}`);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "user-admin" } });
  });
});

describe("раскрытие Telegram ID", () => {
  const reveal = (s: Session, payload: unknown = { field: "telegram_user_id", reason: "проверка обращения" }) =>
    send(s, "POST", `/admin/v1/learners/${LEARNER_ID}/reveal`, payload);

  it("users.sensitive.read + step-up → identity-consent с actor; значение — только в ответе, no-store", async () => {
    const { staff, s } = await loginAs(h, "super_admin");
    expect((await reveal(s)).json().code).toBe("STEP_UP_REQUIRED");
    expect(h.fake.callsTo("identity")).toHaveLength(0);
    await stepUp(h, s);
    const res = await reveal(s);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ field: "telegram_user_id", value: TG_FULL, expires_in: 60 });
    expect(res.headers["cache-control"]).toBe("no-store");
    const call = h.fake.callsTo("identity", "POST")[0]!;
    expect(call.path).toBe(`/admin/v1/users/${LEARNER_ID}/reveal`);
    expect(call.body).toEqual({ field: "telegram_user_id", reason: "проверка обращения" });
    expect(call.actor).toMatchObject({ id: staff.staff_id, permissions: expect.arrayContaining(["users.sensitive.read"]) });
  });

  it("причина 5..300, только поле telegram_user_id, без лишних полей → иначе 422; operations (без права) → 403", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    for (const bad of [
      { field: "telegram_user_id", reason: "abc" },
      { field: "telegram_user_id", reason: "x".repeat(301) },
      { field: "phone", reason: "проверка обращения" },
      { field: "telegram_user_id", reason: "проверка обращения", extra: 1 },
    ]) {
      expect((await reveal(s, bad)).statusCode, JSON.stringify(bad).slice(0, 40)).toBe(422);
    }
    expect(h.fake.callsTo("identity")).toHaveLength(0);
    const ops = await loginAs(h, "operations");
    await stepUp(h, ops.s);
    expect((await reveal(ops.s)).json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "users.sensitive.read" } });
  });

  it("аудит недоступен (503 AUDIT_UNAVAILABLE identity-consent) → 503 AUDIT_UNAVAILABLE без значения; детский профиль → 409", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    h.fake.on("identity", "POST", `/admin/v1/users/${LEARNER_ID}/reveal`, () => domainError(503, "AUDIT_UNAVAILABLE"));
    const res = await reveal(s);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(res.body).not.toContain(TG_FULL);
    h.fake.on("identity", "POST", `/admin/v1/users/${LEARNER_ID}/reveal`, () => domainError(409, "FIELD_NOT_AVAILABLE"));
    expect((await reveal(s)).json().code).toBe("FIELD_NOT_AVAILABLE");
  });

  it("испорченный ответ (не цифры) → 503, значение не уходит", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    h.fake.on("identity", "POST", `/admin/v1/users/${LEARNER_ID}/reveal`, () => json(200, { field: "telegram_user_id", value: "<script>", expires_in: 60 }));
    const res = await reveal(s);
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("<script>");
  });
});

describe("дашборд: 4 независимых блока", () => {
  it("все источники доступны: блоки с данными, period передаётся (кроме «Что нового»)", async () => {
    const { s } = await loginAs(h, "read_only");
    const res = await get(s, "/admin/v1/dashboard?period=30d");
    expect(res.statusCode).toBe(200);
    const d = res.json() as Dashboard;
    expect(d.period).toBe("30d");
    expect(Date.parse(d.generated_at)).not.toBeNaN();
    for (const b of [d.learners, d.support, d.whats_new, d.campaigns]) expect(b.available).toBe(true);
    expect(d.learners.data?.by_age_band["18+"]).toBe(95);
    expect(d.whats_new.data?.latest?.views_total).toBe(57);
    expect(d.campaigns.data?.delivered_in_period).toBe(1500);
    expect(h.fake.callsTo("userAdmin", "GET", "/admin/v1/learners/stats")[0]!.query).toEqual({ period: "30d" });
    expect(h.fake.callsTo("support", "GET", "/admin/v1/support/stats")[0]!.query).toEqual({ period: "30d" });
    expect(h.fake.callsTo("experience", "GET", "/admin/v1/release-notes/summary")[0]!.query).toEqual({});
    expect(h.fake.callsTo("notifications", "GET", "/admin/v1/notifications/campaigns/summary")[0]!.query).toEqual({ period: "30d" });
    // по умолчанию — today
    await get(s, "/admin/v1/dashboard");
    expect(h.fake.callsTo("support", "GET", "/admin/v1/support/stats").at(-1)!.query).toEqual({ period: "today" });
    expect((await get(s, "/admin/v1/dashboard?period=1y")).statusCode).toBe(422);
  });

  it("частичная недоступность: сеть, 5xx, 403 домена, испорченные данные, таймаут → available=false с service; ответ 200", async () => {
    const { s } = await loginAs(h, "read_only");
    h.fake.down.add("userAdmin");
    h.fake.on("notifications", "GET", "/admin/v1/notifications/campaigns/summary", () => domainError(403, "PERMISSION_DENIED"));
    h.fake.on("experience", "GET", "/admin/v1/release-notes/summary", () => json(200, { published: -1, drafts: 0, latest: null }));
    const res = await get(s, "/admin/v1/dashboard");
    expect(res.statusCode).toBe(200);
    const d = res.json() as Dashboard;
    expect(d.learners).toEqual({ available: false, data: null, service: "user-admin" });
    expect(d.whats_new).toEqual({ available: false, data: null, service: "experience-config" });
    expect(d.campaigns).toEqual({ available: false, data: null, service: "notifications" });
    expect(d.support.available).toBe(true);
    expect(d.support.data?.open).toBe(4);
    expect(d.support.service).toBeUndefined();

    h.fake.on("support", "GET", "/admin/v1/support/stats", () => new Promise<Response>((r) => setTimeout(() => r(json(200, {})), 1500)));
    h.fake.on("notifications", "GET", "/admin/v1/notifications/campaigns/summary", () => domainError(500, "BOOM"));
    const started = Date.now();
    const slow = await get(s, "/admin/v1/dashboard");
    expect(Date.now() - started).toBeLessThan(1400); // DASHBOARD_TIMEOUT_MS=500, блоки параллельно
    const d2 = slow.json() as Dashboard;
    expect(d2.support).toEqual({ available: false, data: null, service: "support" });
    expect(d2.campaigns.available).toBe(false);
  });

  it("все источники недоступны — всё равно 200, нули не подставляются", async () => {
    const { s } = await loginAs(h, "read_only");
    for (const svc of ["userAdmin", "support", "experience", "notifications"] as const) h.fake.down.add(svc);
    const res = await get(s, "/admin/v1/dashboard");
    expect(res.statusCode).toBe(200);
    const d = res.json() as Dashboard;
    for (const b of [d.learners, d.support, d.whats_new, d.campaigns]) expect(b).toMatchObject({ available: false, data: null });
  });
});

describe("поддержка", () => {
  beforeEach(() => {
    h.fake.addStaff({ role: "support", staff_id: OPERATOR_ID, display_name: "Анна Оператор" });
  });

  it("список: assignee=me — как есть (support принимает me|none), имена операторов из lookup", async () => {
    const { s } = await loginAs(h, "support");
    const res = await get(s, "/admin/v1/support/tickets?assignee=me&status=open");
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("support", "GET", "/admin/v1/support/tickets")[0]!.query).toMatchObject({ assignee: "me", status: "open" });
    expect(res.json().items[0].assignee_name).toBe("Анна Оператор");
    expect(h.fake.callsTo("adminIdentity", "GET", "/admin/v1/staff/lookup")[0]!.query.ids).toBe(OPERATOR_ID);
  });

  it("тикет: assignee_name и author_name оператора — из lookup, автор-ученик — значение support; сводка ученика при users.read", async () => {
    const { s } = await loginAs(h, "support");
    const res = await get(s, "/admin/v1/support/tickets/TCK-3001");
    expect(res.statusCode).toBe(200);
    const t = res.json() as StaffTicket;
    expect(t.assignee_name).toBe("Анна Оператор");
    expect(t.messages.find((m) => m.sender_type === "operator")!.author_name).toBe("Анна Оператор");
    expect(t.messages.find((m) => m.sender_type === "user")!.author_name).toBe("Азиз");
    expect(t.learner).toEqual({
      user_id: LEARNER_ID,
      kind: "account",
      username: "az•••er", // support без users.sensitive.read — маска (ревью T2-3)
      telegram_id_masked: "••••••789",
      locale: "uz",
      age_band: "18+",
      status: "ACTIVE",
    });
    expect(h.fake.callsTo("userAdmin", "GET", "/admin/v1/learners")[0]!.query).toEqual({ q: LEARNER_ID, limit: "1" });
    // без users.read сводки нет, user-admin не вызывается
    const narrow = await loginAs(h, "support", { permissions: ["support.read", "support.reply"] });
    const before = h.fake.callsTo("userAdmin").length;
    expect((await get(narrow.s, "/admin/v1/support/tickets/TCK-3001")).json().learner).toBeNull();
    expect(h.fake.callsTo("userAdmin")).toHaveLength(before);
  });

  it("lookup недоступен — имена null (оператор — имя от support), экран открывается", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("adminIdentity", "GET", "/admin/v1/staff/lookup", () => domainError(500, "BOOM"));
    const res = await get(s, "/admin/v1/support/tickets/TCK-3001");
    expect(res.statusCode).toBe(200);
    expect(res.json().assignee_name).toBeNull();
  });

  it("сообщение: Idempotency-Key обязателен (422 IDEMPOTENCY_KEY_REQUIRED) и пробрасывается; неверный → 422 INVALID", async () => {
    const { s } = await loginAs(h, "support");
    const msg = { text: "Здравствуйте!", visibility: "internal" };
    const no = await send(s, "POST", "/admin/v1/support/tickets/TCK-3001/messages", msg);
    expect(no.statusCode).toBe(422);
    expect(no.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const bad = await send(s, "POST", "/admin/v1/support/tickets/TCK-3001/messages", msg, { "idempotency-key": "bad key!" });
    expect(bad.json().code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(h.fake.callsTo("support", "POST")).toHaveLength(0);
    h.fake.on("support", "POST", "/admin/v1/support/tickets/TCK-3001/messages", () => json(200, ticketDetail(), { "idempotent-replayed": "true" }));
    const ok = await send(s, "POST", "/admin/v1/support/tickets/TCK-3001/messages", msg, { "idempotency-key": "msg-key-0001" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["idempotent-replayed"]).toBe("true");
    const call = h.fake.callsTo("support", "POST")[0]!;
    expect(call.headers["idempotency-key"]).toBe("msg-key-0001");
    expect(call.body).toEqual(msg);
  });

  it("client-view — форма ученика: без internal-заметок, user_id и оператора", async () => {
    const { s } = await loginAs(h, "support");
    const res = await get(s, `/admin/v1/support/tickets/${TICKET_ID}/client-view`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).not.toHaveProperty("user_id");
    expect(body).not.toHaveProperty("assignee_id");
    expect(JSON.stringify(body)).not.toContain("internal");
    expect(body.context).toEqual({ client_version: "telegram-miniapp-1.0" });
  });

  it("эскалация: 201, лишнее поле домена ticket_id отбрасывается; неизвестный тип → 422", async () => {
    const { s } = await loginAs(h, "support");
    const res = await send(s, "POST", "/admin/v1/support/tickets/TCK-3001/escalations", { type: "assessment_review", note: "Оценка спорная" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty("ticket_id");
    expect(res.json().type).toBe("assessment_review");
    expect((await send(s, "POST", "/admin/v1/support/tickets/TCK-3001/escalations", { type: "provider_issue", note: "x".repeat(5) })).statusCode).toBe(422);
  });

  it("4xx домена с кодом и details (SUPPORT_INVALID_TRANSITION); шаблоны ответов RU/UZ — из support", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("support", "PATCH", "/admin/v1/support/tickets/TCK-3001", () => domainError(409, "SUPPORT_INVALID_TRANSITION", { from: "CLOSED", to: "NEW" }));
    const res = await send(s, "PATCH", "/admin/v1/support/tickets/TCK-3001", { status: "NEW" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "SUPPORT_INVALID_TRANSITION", details: { from: "CLOSED", to: "NEW" } });
    const tpl = await get(s, "/admin/v1/support/templates");
    expect(tpl.json().items[0].text).toEqual({ ru: "Здравствуйте! Обновите Mini App.", uz: "Assalomu alaykum! Mini Appni yangilang." });
    expect(h.fake.callsTo("support", "GET", "/admin/v1/support/templates")).toHaveLength(1);
  });

  it("SLA: чтение — support.read или support.manage; изменение — только support.manage", async () => {
    const sup = await loginAs(h, "support");
    expect((await get(sup.s, "/admin/v1/support/sla-policies")).statusCode).toBe(200);
    const put = { items: [{ category: "LESSON", priority: "high", first_response_minutes: 30, resolution_minutes: 240 }], reason: "ускоряем" };
    expect((await send(sup.s, "PUT", "/admin/v1/support/sla-policies", put)).json().details.permission).toBe("support.manage");
    const mgr = await loginAs(h, "read_only", { permissions: ["support.manage"] });
    expect((await get(mgr.s, "/admin/v1/support/sla-policies")).statusCode).toBe(200);
    expect((await send(mgr.s, "PUT", "/admin/v1/support/sla-policies", put)).statusCode).toBe(200);
  });
});

describe("«Что нового»", () => {
  beforeEach(() => {
    h.fake.addStaff({ role: "communications", staff_id: OPERATOR_ID, display_name: "Дилноза Редактор" });
  });

  it("created_by_name / published_by_name — через staff/lookup; views_total — из домена", async () => {
    const { s } = await loginAs(h, "communications");
    h.fake.on("experience", "GET", "/admin/v1/release-notes", () =>
      json(200, {
        items: [releaseNoteRow({ status: "published", published_by: OPERATOR_ID, published_at: "2026-11-10T10:00:00Z", views_total: 57, created_by_name: "подделка" })],
        next_cursor: null,
      }),
    );
    const res = await get(s, "/admin/v1/release-notes?status=published");
    expect(res.statusCode).toBe(200);
    const n = res.json().items[0];
    expect(n.created_by_name).toBe("Дилноза Редактор");
    expect(n.published_by_name).toBe("Дилноза Редактор");
    expect(n.views_total).toBe(57);
  });

  it("пустой перевод → 422 RELEASE_NOTE_TRANSLATION_MISSING {missing} домена; запрещённый маршрут, 7 пунктов, лишнее поле → 422 до домена", async () => {
    const { s } = await loginAs(h, "communications");
    h.fake.on("experience", "POST", "/admin/v1/release-notes", () => domainError(422, "RELEASE_NOTE_TRANSLATION_MISSING", { missing: ["items[0].text.uz"] }));
    const empty = releaseNoteBody({ items: [{ title: { ru: "Серия", uz: "Seriya" }, text: { ru: "Текст", uz: "" }, link: null, icon: null }] });
    const res = await send(s, "POST", "/admin/v1/release-notes", empty);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "RELEASE_NOTE_TRANSLATION_MISSING", details: { missing: ["items[0].text.uz"] } });
    const calls = h.fake.callsTo("experience", "POST").length;
    const item = { title: { ru: "a", uz: "a" }, text: { ru: "a", uz: "a" }, link: null, icon: null };
    for (const bad of [
      releaseNoteBody({ items: [{ ...item, link: "catalog" }] }),
      releaseNoteBody({ items: Array.from({ length: 7 }, () => item) }),
      releaseNoteBody({ audience: "everyone" }),
      { ...releaseNoteBody(), extra: true },
      releaseNoteBody({ title: { ru: "x".repeat(81), uz: "x" } }),
    ]) {
      const r = await send(s, "POST", "/admin/v1/release-notes", bad);
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe("VALIDATION_ERROR");
    }
    expect(h.fake.callsTo("experience", "POST")).toHaveLength(calls);
  });

  it("публикация: step-up; повтор — 200 домена (уже опубликована) и Idempotent-Replayed передаются", async () => {
    const { s } = await loginAs(h, "communications");
    await stepUp(h, s);
    h.fake.on("experience", "POST", `/admin/v1/release-notes/${NOTE_ID}/publish`, () =>
      json(200, releaseNoteRow({ status: "published", published_by: OPERATOR_ID, published_at: "2026-11-10T10:00:00Z" }), { "idempotent-replayed": "true" }),
    );
    const res = await send(s, "POST", `/admin/v1/release-notes/${NOTE_ID}/publish`, { expected_version: 1, reason: "релиз" }, { "idempotency-key": "pub-note-0001" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(res.json().published_by_name).toBe("Дилноза Редактор");
    expect(h.fake.callsTo("experience", "POST", `/admin/v1/release-notes/${NOTE_ID}/publish`)[0]!.headers["idempotency-key"]).toBe("pub-note-0001");
  });

  it("статистика: ReleaseNoteStats", async () => {
    const { s } = await loginAs(h, "communications");
    const res = await get(s, `/admin/v1/release-notes/${NOTE_ID}/stats`);
    expect(res.json()).toMatchObject({ views_total: 57, views_by_lang: { ru: 30, uz: 27 }, views_by_age: { kids: 0, teens: 7, adults: 50 } });
  });
});

describe("шаблоны уведомлений и рассылки", () => {
  beforeEach(() => {
    h.fake.addStaff({ role: "communications", staff_id: OPERATOR_ID, display_name: "Дилноза Редактор" });
  });

  it("карточка шаблона: версии с created_by_name / activated_by_name", async () => {
    const { s } = await loginAs(h, "communications");
    const res = await get(s, "/admin/v1/notifications/templates/lesson.reminder");
    expect(res.statusCode).toBe(200);
    expect(res.json().versions[0]).toMatchObject({ created_by_name: "Дилноза Редактор", activated_by_name: "Дилноза Редактор" });
    expect((await get(s, "/admin/v1/notifications/templates/Lesson Reminder")).statusCode).toBe(422);
  });

  it("TEMPLATE_INVALID {fields} домена — как есть; длины admin.ts — до домена (title 81 → 422)", async () => {
    const { s } = await loginAs(h, "communications");
    h.fake.on("notifications", "POST", "/admin/v1/notifications/templates/lesson.reminder.kid/versions", () =>
      domainError(422, "TEMPLATE_INVALID", { fields: [{ path: "ru.body", reason: "pressure_words" }, { path: "uz.body", reason: "unknown_placeholder:streak" }] }),
    );
    const texts = campaignBody().texts;
    const res = await send(s, "POST", "/admin/v1/notifications/templates/lesson.reminder.kid/versions", { texts, note: "срочно" });
    expect(res.statusCode).toBe(422);
    expect(res.json().details.fields).toHaveLength(2);
    const long = { ...texts, ru: { ...texts.ru, title: "x".repeat(81) } };
    const before = h.fake.calls.length;
    expect((await send(s, "POST", "/admin/v1/notifications/templates/lesson.reminder/versions", { texts: long, note: "длинно" })).statusCode).toBe(422);
    expect(h.fake.calls.length).toBe(before);
  });

  it("активация и сброс — step-up; тест 429 домена (≤ 10/мин) — как есть", async () => {
    const { s } = await loginAs(h, "communications");
    expect((await send(s, "POST", "/admin/v1/notifications/templates/lesson.reminder/versions/3/activate", { reason: "новый текст" })).json().code).toBe(
      "STEP_UP_REQUIRED",
    );
    expect((await send(s, "POST", "/admin/v1/notifications/templates/lesson.reminder/reset", { reason: "по умолчанию" })).json().code).toBe("STEP_UP_REQUIRED");
    h.fake.on("notifications", "POST", "/admin/v1/notifications/templates/lesson.reminder/versions/3/test", () => domainError(429, "RATE_LIMITED", { retry_after: 30 }));
    const t = await send(s, "POST", "/admin/v1/notifications/templates/lesson.reminder/versions/3/test", { lang: "ru", recipient: 0 });
    expect(t.statusCode).toBe(429);
    expect(t.headers["retry-after"]).toBe("30");
  });

  it("тестовые получатели: только индексы и маски — полные chat id домена отбрасываются; ID в подписи → 503", async () => {
    const { s } = await loginAs(h, "communications");
    const res = await get(s, "/admin/v1/notifications/test-recipients");
    expect(res.json()).toEqual({ items: [{ index: 0, label: "Тестовый чат 1 (••••4821)" }] });
    expect(res.body).not.toContain("-1004821");
    h.fake.on("notifications", "GET", "/admin/v1/notifications/test-recipients", () => json(200, { items: [{ index: 0, label: "Чат -1001234567890" }] }));
    expect((await get(s, "/admin/v1/notifications/test-recipients")).statusCode).toBe(503);
  });

  it("рассылка: Idempotency-Key обязателен; детский сегмент, active_days=0 и > 90 → 422 до домена; служебное поле cursor не уходит", async () => {
    const { staff, s } = await loginAs(h, "communications");
    const no = await send(s, "POST", "/admin/v1/notifications/campaigns", campaignBody());
    expect(no.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    for (const segment of [{ age: ["kids"] }, { active_days: 0 }, { active_days: 91 }, { ui_lang: ["en"] }]) {
      const r = await send(s, "POST", "/admin/v1/notifications/campaigns", campaignBody({ segment }), { "idempotency-key": "camp-key-0001" });
      expect(r.statusCode, JSON.stringify(segment)).toBe(422);
    }
    expect(h.fake.callsTo("notifications", "POST")).toHaveLength(0);
    const ok = await send(s, "POST", "/admin/v1/notifications/campaigns", campaignBody(), { "idempotency-key": "camp-key-0001" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).not.toHaveProperty("cursor");
    expect(ok.json().created_by).toBe(staff.staff_id);
  });

  it("расписание и стоп — notif.campaigns.send + step-up; снятие с расписания — без step-up; 422 CAMPAIGN_EMPTY_AUDIENCE — как есть", async () => {
    const { s } = await loginAs(h, "communications");
    const sched = { expected_version: 1, send_at: "2026-11-20T09:00:00Z", reason: "ноябрь" };
    expect((await send(s, "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/schedule`, sched)).json().code).toBe("STEP_UP_REQUIRED");
    expect((await send(s, "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/stop`, { reason: "ошибка" })).json().code).toBe("STEP_UP_REQUIRED");
    expect((await send(s, "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/unschedule`, { reason: "перенос" })).statusCode).toBe(200);
    await stepUp(h, s);
    h.fake.on("notifications", "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/schedule`, () => domainError(422, "CAMPAIGN_EMPTY_AUDIENCE"));
    expect((await send(s, "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/schedule`, sched)).json().code).toBe("CAMPAIGN_EMPTY_AUDIENCE");
    expect((await send(s, "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/schedule`, { ...sched, send_at: "завтра" })).statusCode).toBe(422);
    const stop = await send(s, "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/stop`, { reason: "ошибка в тексте" });
    expect(stop.json()).toMatchObject({ status: "stopped", stop_reason: "ошибка в тексте" });
    // без notif.campaigns.send — 403 даже со step-up
    const manager = await loginAs(h, "communications", { permissions: ["notif.campaigns.manage"] });
    await stepUp(h, manager.s);
    expect((await send(manager.s, "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/stop`, { reason: "ошибка" })).json().details.permission).toBe(
      "notif.campaigns.send",
    );
  });
});

describe("рассылки: ревью T2-6, T2-11, QA D2-03", () => {
  it("scheduled_by_name / stopped_by_name — через staff/lookup; значение домена не берётся; lookup недоступен → null", async () => {
    h.fake.addStaff({ role: "communications", staff_id: OPERATOR_ID, display_name: "Дилноза Редактор" });
    const { s } = await loginAs(h, "communications");
    h.fake.on("notifications", "GET", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`, () =>
      json(
        200,
        campaignRow({
          status: "stopped",
          scheduled_by: OPERATOR_ID,
          scheduled_at: "2026-11-18T09:00:00Z",
          stopped_by: OPERATOR_ID.toUpperCase(),
          stopped_at: "2026-11-18T09:30:00Z",
          stop_reason: "ошибка",
          scheduled_by_name: "подделка домена",
        }),
      ),
    );
    const c = (await get(s, `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`)).json();
    expect(c.scheduled_by_name).toBe("Дилноза Редактор");
    expect(c.stopped_by_name).toBe("Дилноза Редактор");
    // в списке — тоже; у черновика без расписания — null
    h.fake.on("notifications", "GET", "/admin/v1/notifications/campaigns", () => json(200, { items: [campaignRow()], next_cursor: null }));
    const row = (await get(s, "/admin/v1/notifications/campaigns")).json().items[0];
    expect(row).toMatchObject({ scheduled_by_name: null, stopped_by_name: null });
    // lookup недоступен (новый процесс — без кэша имён): экран открывается, имена null
    const fresh = await makeHarness();
    try {
      fresh.fake.on("adminIdentity", "GET", "/admin/v1/staff/lookup", () => domainError(500, "BOOM"));
      fresh.fake.on("notifications", "GET", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`, () =>
        json(200, campaignRow({ status: "scheduled", scheduled_by: OPERATOR_ID, scheduled_at: "2026-11-18T09:00:00Z", send_at: "2026-11-20T09:00:00Z" })),
      );
      const other = await loginAs(fresh, "communications");
      const res = await fresh.app.inject({ url: `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`, headers: browser(other.s) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ scheduled_by: OPERATOR_ID, scheduled_by_name: null, stopped_by_name: null });
    } finally {
      await fresh.close();
    }
  });

  it("schedule: send_at=null («Отправить сейчас») проходит в домен как null → ответ sending с именем автора; время — ISO или null, иначе 422", async () => {
    const { staff, s } = await loginAs(h, "communications");
    await stepUp(h, s);
    const url = `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/schedule`;
    const res = await send(s, "POST", url, { expected_version: 1, send_at: null, reason: "срочно" }, { "idempotency-key": "sched-now-0001" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "sending", scheduled_by: staff.staff_id, scheduled_by_name: staff.display_name });
    const call = h.fake.callsTo("notifications", "POST", url)[0]!;
    expect(call.body).toEqual({ expected_version: 1, send_at: null, reason: "срочно" });
    expect(call.headers["idempotency-key"]).toBe("sched-now-0001");
    // поле обязательно (null — явный выбор), пустая строка и число — 422 до домена
    for (const send_at of [undefined, "", 0]) {
      const body = { expected_version: 1, reason: "срочно", ...(send_at === undefined ? {} : { send_at }) };
      expect((await send(s, "POST", url, body)).statusCode, String(send_at)).toBe(422);
    }
    expect(h.fake.callsTo("notifications", "POST", url)).toHaveLength(1);
  });
});

describe("рассылки: ревью P2-7", () => {
  it("last_error {code, since, attempts} передаётся; домен без поля → null", async () => {
    const { s } = await loginAs(h, "communications");
    h.fake.on("notifications", "GET", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`, () =>
      json(200, campaignRow({ status: "sending", last_error: { code: "AUDIENCE_UNAVAILABLE", since: "2026-11-18T09:00:00Z", attempts: 3 } })),
    );
    expect((await get(s, `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`)).json().last_error).toEqual({
      code: "AUDIENCE_UNAVAILABLE",
      since: "2026-11-18T09:00:00Z",
      attempts: 3,
    });
    h.fake.on("notifications", "GET", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`, () => {
      const { last_error: _drop, ...old } = campaignRow();
      return json(200, old);
    });
    const old = await get(s, `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`);
    expect(old.statusCode).toBe(200);
    expect(old.json().last_error).toBeNull();
    h.fake.on("notifications", "GET", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`, () => json(200, campaignRow({ last_error: { code: "X" } })));
    expect((await get(s, `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`)).statusCode).toBe(503);
  });

  it("стоп черновика → 409 CAMPAIGN_NOT_ACTIVE домена — как есть", async () => {
    const { s } = await loginAs(h, "communications");
    await stepUp(h, s);
    h.fake.on("notifications", "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/stop`, () => domainError(409, "CAMPAIGN_NOT_ACTIVE"));
    const res = await send(s, "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/stop`, { reason: "ошибка" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("CAMPAIGN_NOT_ACTIVE");
  });
});

describe("сотрудники и роли", () => {
  it("PATCH с повышением до привилегированной роли → 202 + approval (статус домена сохраняется)", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const res = await send(s, "PATCH", `/admin/v1/staff/${OPERATOR_ID}`, { role: "super_admin", reason: "повышение" });
    expect(res.statusCode).toBe(202);
    expect(res.json().approval.kind).toBe("staff.role_grant");
  });

  it("POST staff: Idempotency-Key обязателен (422) — домен не вызывается; с ключом — 201 и разовый временный пароль", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const body = { email: "new@tilhero.test", display_name: "Новый", role: "support" };
    const no = await send(s, "POST", "/admin/v1/staff", body);
    expect(no.statusCode).toBe(422);
    expect(no.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(h.fake.callsTo("adminIdentity", "POST", "/admin/v1/staff")).toHaveLength(0);
    const ok = await send(s, "POST", "/admin/v1/staff", body, { "idempotency-key": "staff-key-0001" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().temporary_password).toBe("Tmp-Secret-Passw0rd-XYZ");
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect((await send(s, "POST", "/admin/v1/staff", { ...body, role: "billing" }, { "idempotency-key": "staff-key-0002" })).statusCode).toBe(422);
  });

  it("роли: {items} без каталога прав admin-identity; approve без тела; temporary_password: null → ключа нет", async () => {
    const { s } = await loginAs(h, "super_admin");
    const roles = await get(s, "/admin/v1/roles");
    expect(Object.keys(roles.json())).toEqual(["items"]);
    expect(roles.json().items[1].code).toBe("communications");
    await stepUp(h, s);
    const res = await h.app.inject({ method: "POST", url: `/admin/v1/approvals/${APPROVAL_ID}/approve`, headers: browser(s) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("temporary_password");
    expect(h.fake.callsTo("adminIdentity", "POST", `/admin/v1/approvals/${APPROVAL_ID}/approve`)[0]!.body).toEqual({ note: null });
  });

  it("approve применённой заявки сбрасывает кэш principal цели — её сессии перечитываются сразу", async () => {
    const victim = await loginAs(h, "operations");
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const key = `${h.config.redisKeyPrefix}principal:${victim.staff.staff_id}`;
    const { redis } = await import("./helpers.js");
    expect(await redis().exists(key)).toBe(1);
    h.fake.on("adminIdentity", "POST", `/admin/v1/approvals/${APPROVAL_ID}/approve`, () =>
      json(200, { ...approvalRow({ status: "APPLIED", summary: { staff: { staff_id: victim.staff.staff_id } } }), temporary_password: null }),
    );
    expect((await send(s, "POST", `/admin/v1/approvals/${APPROVAL_ID}/approve`, { note: "ок" })).statusCode).toBe(200);
    expect(await redis().exists(key)).toBe(0);
  });

  it("approve staff.create_privileged / role_grant / reactivate_privileged → temporary_password решающему (один раз, no-store, не в логах)", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    for (const kind of ["staff.create_privileged", "staff.role_grant", "staff.reactivate_privileged"]) {
      h.fake.on("adminIdentity", "POST", `/admin/v1/approvals/${APPROVAL_ID}/approve`, () =>
        json(200, { ...approvalRow({ kind, status: "APPLIED", summary: { staff: { staff_id: OPERATOR_ID } } }), temporary_password: "Decider-Only-Pass-42" }),
      );
      const res = await send(s, "POST", `/admin/v1/approvals/${APPROVAL_ID}/approve`, { note: "ок" });
      expect(res.statusCode, kind).toBe(200);
      expect(res.json()).toMatchObject({ kind, status: "APPLIED", temporary_password: "Decider-Only-Pass-42" });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(h.logs.text).not.toContain("Decider-Only-Pass-42");
  });

  it("создание привилегированного: temporary_password null автору + approval; включение привилегированного → 202 reactivate_privileged", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    h.fake.on("adminIdentity", "POST", "/admin/v1/staff", () =>
      json(201, { staff: { ...staffRowLike(), role: "read_only" }, temporary_password: null, approval: approvalRow({ kind: "staff.create_privileged" }) }),
    );
    const created = await send(s, "POST", "/admin/v1/staff", { email: "ops@tilhero.test", display_name: "Опс", role: "operations" }, { "idempotency-key": "staff-key-0003" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ temporary_password: null, approval: { kind: "staff.create_privileged" } });
    h.fake.on("adminIdentity", "PATCH", `/admin/v1/staff/${OPERATOR_ID}`, () => json(202, { approval: approvalRow({ kind: "staff.reactivate_privileged" }) }));
    const patch = await send(s, "PATCH", `/admin/v1/staff/${OPERATOR_ID}`, { status: "ACTIVE", reason: "вернулся из отпуска" });
    expect(patch.statusCode).toBe(202);
    expect(patch.json().approval.kind).toBe("staff.reactivate_privileged");
  });

  it("PATCH → 202 StaffPatchPending: temporary_password, если заявка применилась сразу (single_super_admin); no-store, не в логах", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    h.fake.on("adminIdentity", "PATCH", `/admin/v1/staff/${OPERATOR_ID}`, () =>
      json(202, { approval: approvalRow({ kind: "staff.role_grant", status: "APPLIED", waived: "single_super_admin" }), temporary_password: "Waived-Grant-Pass-77" }),
    );
    const applied = await send(s, "PATCH", `/admin/v1/staff/${OPERATOR_ID}`, { role: "operations", reason: "повышение" });
    expect(applied.statusCode).toBe(202);
    expect(applied.json()).toMatchObject({ approval: { waived: "single_super_admin", status: "APPLIED" }, temporary_password: "Waived-Grant-Pass-77" });
    expect(applied.headers["cache-control"]).toBe("no-store");
    expect(h.logs.text).not.toContain("Waived-Grant-Pass-77");
    // заявка ждёт второго super_admin: пароля нет (null домена → ключа нет)
    h.fake.on("adminIdentity", "PATCH", `/admin/v1/staff/${OPERATOR_ID}`, () =>
      json(202, { approval: approvalRow({ kind: "staff.reactivate_privileged" }), temporary_password: null }),
    );
    const pending = await send(s, "PATCH", `/admin/v1/staff/${OPERATOR_ID}`, { status: "ACTIVE", reason: "вернулся" });
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).not.toHaveProperty("temporary_password");
    // сброс пароля привилегированного (202 {approval}) — пароля в ответе автору нет никогда
    h.fake.on("adminIdentity", "POST", `/admin/v1/staff/${OPERATOR_ID}/reset-password`, () =>
      json(202, { approval: approvalRow({ kind: "staff.privileged_reset" }), temporary_password: "Must-Not-Leak-11" }),
    );
    const reset = await send(s, "POST", `/admin/v1/staff/${OPERATOR_ID}/reset-password`, { reason: "забыл" });
    expect(reset.statusCode).toBe(202);
    expect(reset.body).not.toContain("Must-Not-Leak-11");
  });

  it("four-eyes ошибки домена пробрасываются (409 FOUR_EYES_SAME_PERSON)", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    h.fake.on("adminIdentity", "POST", `/admin/v1/approvals/${APPROVAL_ID}/reject`, () => domainError(409, "FOUR_EYES_SAME_PERSON"));
    expect((await send(s, "POST", `/admin/v1/approvals/${APPROVAL_ID}/reject`, {})).json().code).toBe("FOUR_EYES_SAME_PERSON");
  });
});

describe("конфигурация", () => {
  it("admin/current — любому вошедшему, без actor; miniapp/current — только config.read; чужое app в ответе → 503", async () => {
    const { s } = await loginAs(h, "read_only");
    const res = await get(s, "/admin/v1/experience/admin/current");
    expect(res.statusCode).toBe(200);
    expect(res.json().app).toBe("admin");
    expect(h.fake.callsTo("experience", "GET", "/internal/v1/experience/admin/current")[0]!.actor).toBeUndefined();
    expect((await get(s, "/admin/v1/experience/miniapp/current")).statusCode).toBe(403);
    h.fake.on("experience", "GET", "/internal/v1/experience/admin/current", () => json(200, { app: "miniapp", version: "1.0.0" }));
    expect((await get(s, "/admin/v1/experience/admin/current")).statusCode).toBe(503);
  });

  it("admin/current — строго по admin.ts AdminExperience (ревью T2-6): лишнее отбрасывается, неполное и опасное → 503", async () => {
    const { s } = await loginAs(h, "read_only");
    const res = await get(s, "/admin/v1/experience/admin/current");
    expect(res.json()).toEqual({
      app: "admin",
      version: "1.0.0",
      theme: { id: "admin_light", version: "1.0.0", tokens: { "--bg": "#f6f3ea", "--nav-w": "232px", "--font-ui": "Onest, system-ui, sans-serif" } },
      layout: { density: "comfortable", menu: [{ id: "overview", enabled: true }, { id: "users", enabled: true }, { id: "costs", enabled: false }] },
      flags: { whats_new: true },
    });
    const broken: Array<Record<string, unknown>> = [
      { layout: undefined }, // нет раскладки (форма прошлого кодека: только app/version)
      { layout: { density: "dense", menu: [] } },
      { layout: { density: "compact", menu: [{ id: "Overview!", enabled: true }] } },
      { theme: { id: "admin_light", version: "1.0.0", tokens: { "--bg": "red; background:url(https://evil.example/x)" } } },
      { theme: { id: "admin_light", version: "1.0.0", tokens: { "--bg": "url(https://evil.example/x)" } } },
      { theme: { id: "admin_light", version: "1.0.0", tokens: { color: "#fff" } } },
      { flags: { whats_new: "yes" } },
    ];
    for (const p of broken) {
      h.fake.on("experience", "GET", "/internal/v1/experience/admin/current", () => json(200, { ...adminExperienceRow(), ...p }));
      expect((await get(s, "/admin/v1/experience/admin/current")).statusCode, JSON.stringify(p)).toBe(503);
    }
  });

  it("activate/rollback — config.publish + step-up; 200 no-op домена сохраняется; неизвестное app → 422", async () => {
    const { s } = await loginAs(h, "operations");
    expect((await send(s, "POST", "/admin/v1/experience/miniapp/rollback", { reason: "откат" })).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    h.fake.on("experience", "POST", "/admin/v1/experience/miniapp/activate", (c) =>
      json(200, { activation_id: crypto.randomUUID(), app: "miniapp", version: c.body.version, previous_version: null, kind: "activate", reason: c.body.reason, activated_by: c.actor!.id, activated_at: "2026-11-18T10:00:00Z" }),
    );
    const res = await send(s, "POST", "/admin/v1/experience/miniapp/activate", { version: "1.0.0", reason: "повтор" }, { "idempotency-key": "act-key-0001" });
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("experience", "POST", "/admin/v1/experience/miniapp/activate")[0]!.headers["idempotency-key"]).toBe("act-key-0001");
    expect((await send(s, "POST", "/admin/v1/experience/web/activate", { version: "1.0.0", reason: "x" })).statusCode).toBe(422);
  });
});

describe("строгая проверка ответов доменов", () => {
  it("испорченный ответ → 503 UPSTREAM_UNAVAILABLE {service}; в лог — путь поля без значения", async () => {
    const { s } = await loginAs(h, "auditor");
    h.fake.on("audit", "GET", "/admin/v1/audit/records", () =>
      json(200, { items: [{ seq: 1, record_id: "секретное-значение-123", action: "x" }], next_cursor: null }),
    );
    const res = await get(s, "/admin/v1/audit/records");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "audit" } });
    expect(h.logs.text).toContain("domain response rejected by normalization");
    expect(h.logs.text).toContain("$.items[0].record_id");
    expect(h.logs.text).not.toContain("секретное-значение-123");
  });

  it("5xx / сеть / битый JSON → 503; отказ внутренней авторизации (ACTOR_NOT_ALLOWED, INTERNAL_TOKEN_*) → 503, сессия жива", async () => {
    const { s } = await loginAs(h, "auditor");
    h.fake.on("audit", "GET", "/admin/v1/audit/verify", () => new Response("{not json", { status: 200 }));
    expect((await get(s, "/admin/v1/audit/verify")).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "audit" } });
    h.fake.on("audit", "GET", "/admin/v1/audit/verify", () => domainError(403, "ACTOR_NOT_ALLOWED"));
    expect((await get(s, "/admin/v1/audit/verify")).statusCode).toBe(503);
    h.fake.on("audit", "GET", "/admin/v1/audit/verify", () => domainError(401, "INTERNAL_TOKEN_EXPIRED"));
    expect((await get(s, "/admin/v1/audit/verify")).statusCode).toBe(503);
    expect((await get(s, "/admin/v1/me")).statusCode).toBe(200);
  });

  it("admin-identity недоступен при проверке principal → 503 (fail-closed), сессия не удаляется", async () => {
    await h.close();
    h = await makeHarness({ PRINCIPAL_CACHE_SECONDS: "0" });
    const { s } = await loginAs(h, "support");
    h.fake.down.add("adminIdentity");
    expect((await get(s, "/admin/v1/me")).statusCode).toBe(503);
    h.fake.down.delete("adminIdentity");
    expect((await get(s, "/admin/v1/me")).statusCode).toBe(200);
  });

  it("аудит: from/to → date_from/date_to, object_type передаётся", async () => {
    const { s } = await loginAs(h, "auditor");
    await get(s, "/admin/v1/audit/records?object_type=campaign&from=2026-11-01&to=2026-11-18");
    expect(h.fake.callsTo("audit", "GET", "/admin/v1/audit/records")[0]!.query).toEqual({ object_type: "campaign", date_from: "2026-11-01", date_to: "2026-11-18" });
  });
});

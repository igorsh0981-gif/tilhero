/**
 * Маршруты admin-bff поверх доменов: дашборд (частичные сбои), пользователи (тикеты, reveal), поддержка
 * (имена операторов, сводка пользователя, Idempotency-Key, шаблоны, AI-черновик), сотрудники (статусы 201/202),
 * аудит (from/to), конфигурация (Idempotency-Key, статус no-op), ошибки доменов.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminUserCard, StaffTicket } from "@tilhero/contracts/admin";
import {
  OPERATOR_ID,
  TICKET_ID,
  TOTP_OK,
  USER_ID,
  browser,
  stepUp,
  closeRedis,
  domainError,
  json,
  loginAs,
  makeHarness,
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

// дашборд (спринт 8, DashboardV2) — test/sprint8.test.ts

describe("users", () => {
  it("карточка: обращения из support по user_id; поля спринта 7 без ai-control/ai-concierge — null", async () => {
    const { s } = await loginAs(h, "support");
    const res = await h.app.inject({ url: `/admin/v1/users/${USER_ID}`, headers: browser(s) });
    expect(res.statusCode).toBe(200);
    const card = res.json() as AdminUserCard;
    expect(card.tickets).toEqual([{ ticket_id: TICKET_ID, number: "TCK-3001", status: "IN_PROGRESS", subject: "Цена отличается", created_at: "2026-10-08T10:00:00Z" }]);
    // фейки ai-control / ai-concierge не настроены (404) — карточка открывается, поля null
    expect(card.ai_conversations).toBeNull();
    expect(card.access_level).toBeNull();
    expect(card.ai_usage_30d).toBeNull();
    expect(h.fake.callsTo("support", "GET", "/admin/v1/support/tickets")[0]!.query).toMatchObject({ user_id: USER_ID, status: "all" });
  });

  it("без support.read обращения не запрашиваются (support вернул бы 403)", async () => {
    const { s } = await loginAs(h, "analyst");
    const res = await h.app.inject({ url: `/admin/v1/users/${USER_ID}`, headers: browser(s) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as AdminUserCard).tickets).toEqual([]);
    expect(h.fake.callsTo("support")).toHaveLength(0);
  });

  it("404 домена пробрасывается; невалидный UUID → 422", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("userAdmin", "GET", `/admin/v1/users/${USER_ID}`, () => domainError(404, "USER_NOT_FOUND"));
    const res = await h.app.inject({ url: `/admin/v1/users/${USER_ID}`, headers: browser(s) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("USER_NOT_FOUND");
    expect((await h.app.inject({ url: "/admin/v1/users/not-a-uuid", headers: browser(s) })).statusCode).toBe(422);
  });

  it("reveal: identity-consent напрямую с actor; reason < 5 → 422; без права → 403", async () => {
    const { staff, s } = await loginAs(h, "super_admin");
    const res = await h.app.inject({
      method: "POST",
      url: `/admin/v1/users/${USER_ID}/reveal`,
      headers: browser(s),
      payload: { field: "telegram_user_id", reason: "проверка обращения" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ field: "telegram_user_id", value: "777000123456789", expires_in: 60 });
    const call = h.fake.callsTo("identity", "POST")[0]!;
    expect(call.path).toBe(`/admin/v1/users/${USER_ID}/reveal`);
    expect(call.actor?.id).toBe(staff.staff_id);
    expect(call.actor?.permissions).toContain("users.sensitive.read");
    expect(res.headers["cache-control"]).toBe("no-store");
    const short = await h.app.inject({ method: "POST", url: `/admin/v1/users/${USER_ID}/reveal`, headers: browser(s), payload: { field: "telegram_user_id", reason: "abc" } });
    expect(short.statusCode).toBe(422);
    const sup = await loginAs(h, "support");
    const denied = await h.app.inject({ method: "POST", url: `/admin/v1/users/${USER_ID}/reveal`, headers: browser(sup.s), payload: { field: "telegram_user_id", reason: "проверка обращения" } });
    expect(denied.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "users.sensitive.read" } });
  });

  it("audit недоступен в identity-consent → 503 пробрасывается, значения нет", async () => {
    const { s } = await loginAs(h, "super_admin");
    h.fake.on("identity", "POST", `/admin/v1/users/${USER_ID}/reveal`, () => domainError(503, "UPSTREAM_UNAVAILABLE", { service: "audit" }));
    const res = await h.app.inject({ method: "POST", url: `/admin/v1/users/${USER_ID}/reveal`, headers: browser(s), payload: { field: "telegram_user_id", reason: "проверка обращения" } });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("777000");
  });
});

describe("support", () => {
  let s: Session;
  beforeEach(async () => {
    h.fake.addStaff({ role: "support", staff_id: OPERATOR_ID, display_name: "Анна Оператор" });
    ({ s } = await loginAs(h, "support"));
  });

  it("список: assignee=me → _me, имена операторов из admin-identity lookup", async () => {
    const res = await h.app.inject({ url: "/admin/v1/support/tickets?assignee=me&status=open&limit=10", headers: browser(s) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ ticket_id: TICKET_ID, assignee_id: OPERATOR_ID, assignee_name: "Анна Оператор" });
    expect(h.fake.callsTo("support", "GET", "/admin/v1/support/tickets")[0]!.query).toEqual({ assignee: "_me", status: "open", limit: "10" });
    expect(h.fake.callsTo("adminIdentity", "GET", "/admin/v1/staff/lookup")[0]!.query.ids).toBe(OPERATOR_ID);
  });

  it("тикет: assignee_name, author_name оператора, безопасная сводка пользователя; lookup недоступен — имена null", async () => {
    const t = (await h.app.inject({ url: `/admin/v1/support/tickets/${TICKET_ID}`, headers: browser(s) })).json() as StaffTicket;
    expect(t.assignee_name).toBe("Анна Оператор");
    expect(t.messages.find((m) => m.sender_type === "operator")!.author_name).toBe("Анна Оператор");
    expect(t.user).toEqual({ user_id: USER_ID, username: "test_user_1", telegram_id_masked: "••••••789", locale: "ru", status: "ACTIVE" });

    await h.close();
    h = await makeHarness();
    ({ s } = await loginAs(h, "support"));
    h.fake.on("adminIdentity", "GET", "/admin/v1/staff/lookup", () => new Response("x", { status: 500 }));
    h.fake.down.add("userAdmin");
    const res = await h.app.inject({ url: `/admin/v1/support/tickets/${TICKET_ID}`, headers: browser(s) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ assignee_name: null, user: null });
  });

  it("сообщение: Idempotency-Key обязателен и пробрасывается в support", async () => {
    const url = `/admin/v1/support/tickets/${TICKET_ID}/messages`;
    const payload = { text: "Здравствуйте!", visibility: "public" };
    const missing = await h.app.inject({ method: "POST", url, headers: browser(s), payload });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const bad = await h.app.inject({ method: "POST", url, headers: browser(s, { "idempotency-key": "bad key!" }), payload });
    expect(bad.json().code).toBe("IDEMPOTENCY_KEY_INVALID");
    const ok = await h.app.inject({ method: "POST", url, headers: browser(s, { "idempotency-key": "msg-0001-abcdef" }), payload });
    expect(ok.statusCode).toBe(200);
    const call = h.fake.callsTo("support", "POST", url)[0]!;
    expect(call.headers["idempotency-key"]).toBe("msg-0001-abcdef");
    expect(call.body).toEqual(payload);
    expect(call.actor?.name).toBe(s.me.staff.display_name);
    const extra = await h.app.inject({ method: "POST", url, headers: browser(s, { "idempotency-key": "msg-0002-abcdef" }), payload: { ...payload, author_name: "Босс" } });
    expect(extra.statusCode).toBe(422);
  });

  it("4xx домена пробрасывается с кодом и details (SUPPORT_INVALID_TRANSITION)", async () => {
    h.fake.on("support", "PATCH", `/admin/v1/support/tickets/${TICKET_ID}`, () =>
      domainError(409, "SUPPORT_INVALID_TRANSITION", { from: "CLOSED", to: "NEW" }),
    );
    const res = await h.app.inject({ method: "PATCH", url: `/admin/v1/support/tickets/${TICKET_ID}`, headers: browser(s), payload: { status: "NEW" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "SUPPORT_INVALID_TRANSITION", details: { from: "CLOSED", to: "NEW" } });
    expect(res.json().trace_id).not.toBe("domain-trace");
    const empty = await h.app.inject({ method: "PATCH", url: `/admin/v1/support/tickets/${TICKET_ID}`, headers: browser(s), payload: {} });
    expect(empty.statusCode).toBe(422);
  });

  it("take, client-view, эскалация (201 + Idempotency-Key), sla-policies", async () => {
    const take = await h.app.inject({ method: "POST", url: `/admin/v1/support/tickets/${TICKET_ID}/take`, headers: browser(s) });
    expect(take.statusCode).toBe(200);
    expect(take.json().assignee_id).toBe(s.me.staff.staff_id);
    const cv = await h.app.inject({ url: `/admin/v1/support/tickets/${TICKET_ID}/client-view`, headers: browser(s) });
    expect(cv.json()).toMatchObject({ number: "TCK-3001" });
    const esc = await h.app.inject({
      method: "POST",
      url: `/admin/v1/support/tickets/${TICKET_ID}/escalations`,
      headers: browser(s, { "idempotency-key": "esc-0001-abcdef" }),
      payload: { type: "provider_issue", note: "Ссылка провайдера" },
    });
    expect(esc.statusCode).toBe(201);
    expect(h.fake.callsTo("support", "POST", `/admin/v1/support/tickets/${TICKET_ID}/escalations`)[0]!.headers["idempotency-key"]).toBe("esc-0001-abcdef");
    expect((await h.app.inject({ url: "/admin/v1/support/sla-policies", headers: browser(s) })).statusCode).toBe(200);
    const put = await h.app.inject({ method: "PUT", url: "/admin/v1/support/sla-policies", headers: browser(s), payload: { items: [], reason: "x" } });
    expect(put.json().code).toBe("PERMISSION_DENIED");
  });

  it("stats: прокси support с period (support.read или dashboard.read); неверный period → 422", async () => {
    const res = await h.app.inject({ url: "/admin/v1/support/stats?period=7d", headers: browser(s) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ open: 4, breached: 1, avg_first_response_minutes: 42 });
    const call = h.fake.callsTo("support", "GET", "/admin/v1/support/stats")[0]!;
    expect(call.query).toEqual({ period: "7d" });
    expect(call.actor?.permissions).toContain("support.read");
    expect((await h.app.inject({ url: "/admin/v1/support/stats?period=year", headers: browser(s) })).statusCode).toBe(422);
    const ro = await loginAs(h, "read_only");
    expect((await h.app.inject({ url: "/admin/v1/support/stats", headers: browser(ro.s) })).statusCode).toBe(200);
    expect(h.fake.callsTo("support", "GET", "/admin/v1/support/stats")[1]!.query).toEqual({ period: "today" });
    const none = await loginAs(h, "agent_manager", { permissions: ["skills.edit"] });
    const denied = await h.app.inject({ url: "/admin/v1/support/stats", headers: browser(none.s) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().details.permission).toBe("support.read|dashboard.read");
  });

  it("шаблоны RU/EN и AI-черновик-заглушка по категории", async () => {
    const tpl = await h.app.inject({ url: "/admin/v1/support/templates", headers: browser(s) });
    const items = tpl.json().items as Array<{ id: string; title: { ru: string; en: string }; categories: string[] }>;
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const t of items) expect(t.title.ru && t.title.en).toBeTruthy();
    const draft = await h.app.inject({ method: "POST", url: `/admin/v1/support/tickets/${TICKET_ID}/ai-draft`, headers: browser(s) });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ stub: true, source: "template" });
    expect(draft.json().text).toContain("Цены в приложении"); // категория PRICE, locale ru
  });
});

describe("staff / roles / approvals", () => {
  async function superWithStepUp() {
    const r = await loginAs(h, "super_admin");
    await stepUp(h, r.s);
    return r;
  }

  it("PATCH с повышением до привилегированной роли → 202 + approval (статус домена сохраняется)", async () => {
    const { s } = await superWithStepUp();
    const target = h.fake.addStaff({ role: "support" });
    const res = await h.app.inject({ method: "PATCH", url: `/admin/v1/staff/${target.staff_id}`, headers: browser(s), payload: { role: "super_admin", reason: "повышение" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().approval.status).toBe("PENDING");
    const noReason = await h.app.inject({ method: "PATCH", url: `/admin/v1/staff/${target.staff_id}`, headers: browser(s), payload: { role: "support" } });
    expect(noReason.statusCode).toBe(422);
  });

  it("PUT roles → 202; approve без тела и с note; reset-mfa", async () => {
    const { s } = await superWithStepUp();
    const put = await h.app.inject({ method: "PUT", url: "/admin/v1/roles/support", headers: browser(s), payload: { permissions: ["support.read"], reason: "сужение" } });
    expect(put.statusCode).toBe(202);
    const badPerm = await h.app.inject({ method: "PUT", url: "/admin/v1/roles/support", headers: browser(s), payload: { permissions: ["root"], reason: "сужение" } });
    expect(badPerm.statusCode).toBe(422);
    const id = "5b1f0d0e-1111-4c2b-9a51-0d6c7a1e2f30";
    const a1 = await h.app.inject({ method: "POST", url: `/admin/v1/approvals/${id}/approve`, headers: browser(s) });
    expect(a1.statusCode).toBe(200);
    const a2 = await h.app.inject({ method: "POST", url: `/admin/v1/approvals/${id}/reject`, headers: browser(s), payload: { note: "нет" } });
    expect(a2.statusCode).toBe(200);
    expect(h.fake.callsTo("adminIdentity", "POST", "/admin/v1/approvals/").map((c) => c.body)).toEqual([{ note: null }, { note: "нет" }]);
    const target = h.fake.addStaff({ role: "support" });
    const rm = await h.app.inject({ method: "POST", url: `/admin/v1/staff/${target.staff_id}/reset-mfa`, headers: browser(s), payload: { reason: "потерян телефон" } });
    expect(rm.statusCode).toBe(200);
  });

  it("POST staff: step-up, 201 и временный пароль из домена, Idempotency-Key пробрасывается; неверный ключ → 422", async () => {
    const { s } = await superWithStepUp();
    const payload = { email: "new.hire@tilhero.test", display_name: "Новый Сотрудник", role: "support" };
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/staff", headers: browser(s, { "idempotency-key": "staff-0001-abcdef" }), payload });
    expect(res.statusCode).toBe(201);
    expect(res.json().temporary_password).toBeTruthy();
    const call = h.fake.callsTo("adminIdentity", "POST", "/admin/v1/staff")[0]!;
    expect(call.headers["idempotency-key"]).toBe("staff-0001-abcdef");
    expect(call.body).toEqual(payload);
    const bad = await h.app.inject({ method: "POST", url: "/admin/v1/staff", headers: browser(s, { "idempotency-key": "bad key" }), payload });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(h.fake.callsTo("adminIdentity", "POST", "/admin/v1/staff")).toHaveLength(1);
  });

  it("four-eyes ошибки домена пробрасываются (409 FOUR_EYES_SAME_PERSON)", async () => {
    const { s } = await superWithStepUp();
    const id = "5b1f0d0e-1111-4c2b-9a51-0d6c7a1e2f30";
    h.fake.on("adminIdentity", "POST", `/admin/v1/approvals/${id}/approve`, () => domainError(409, "FOUR_EYES_SAME_PERSON"));
    const res = await h.app.inject({ method: "POST", url: `/admin/v1/approvals/${id}/approve`, headers: browser(s), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("FOUR_EYES_SAME_PERSON");
  });

  it("roles/approvals доступны с staff.manage ИЛИ roles.manage", async () => {
    const { s } = await loginAs(h, "operations", { permissions: ["dashboard.read", "roles.manage"] });
    expect((await h.app.inject({ url: "/admin/v1/roles", headers: browser(s) })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/admin/v1/approvals?status=PENDING", headers: browser(s) })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/admin/v1/staff", headers: browser(s) })).statusCode).toBe(403);
  });
});

describe("audit / experience", () => {
  it("audit: from/to → date_from/date_to", async () => {
    const { s } = await loginAs(h, "auditor");
    const res = await h.app.inject({ url: "/admin/v1/audit/records?action=auth.login&from=2026-10-01T00:00:00Z&to=2026-10-09T00:00:00Z&limit=50", headers: browser(s) });
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("audit", "GET", "/admin/v1/audit/records")[0]!.query).toEqual({
      action: "auth.login",
      date_from: "2026-10-01T00:00:00Z",
      date_to: "2026-10-09T00:00:00Z",
      limit: "50",
    });
    expect((await h.app.inject({ url: "/admin/v1/audit/verify", headers: browser(s) })).json().valid).toBe(true);
    expect((await h.app.inject({ url: "/admin/v1/audit/records?limit=500", headers: browser(s) })).statusCode).toBe(422);
  });

  it("experience: activate — статус 200 (no-op) и Idempotency-Key пробрасываются; неизвестное app → 422", async () => {
    const { s } = await loginAs(h, "super_admin");
    expect((await h.app.inject({ url: "/admin/v1/experience/admin/state", headers: browser(s) })).statusCode).toBe(200);
    const act = await h.app.inject({
      method: "POST",
      url: "/admin/v1/experience/miniapp/activate",
      headers: browser(s, { "idempotency-key": "act-0001-abcdef" }),
      payload: { version: "2.0.3", reason: "релиз" },
    });
    expect(act.statusCode).toBe(200);
    expect(h.fake.callsTo("experience", "POST", "/admin/v1/experience/miniapp/activate")[0]!.headers["idempotency-key"]).toBe("act-0001-abcdef");
    expect((await h.app.inject({ url: "/admin/v1/experience/other/state", headers: browser(s) })).statusCode).toBe(422);
  });
});

describe("experience: действующая конфигурация", () => {
  const ADMIN_CFG = { app: "admin", version: "1.0.0", theme: { tokens: { "--accent": "#5b8cff" } } };
  beforeEach(() => {
    h.fake.on("experience", "GET", "/internal/v1/experience/admin/current", () => json(200, ADMIN_CFG));
    h.fake.on("experience", "GET", "/internal/v1/experience/miniapp/current", () => json(200, { app: "miniapp", version: "2.0.3" }));
  });

  it("admin/current — любому вошедшему (тема админки, A46), без actor; miniapp/current — только config.read", async () => {
    const { s } = await loginAs(h, "read_only");
    const res = await h.app.inject({ url: "/admin/v1/experience/admin/current", headers: browser(s) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ADMIN_CFG);
    expect(h.fake.callsTo("experience", "GET", "/internal/v1/experience/admin/current")[0]!.actor).toBeUndefined();
    const mini = await h.app.inject({ url: "/admin/v1/experience/miniapp/current", headers: browser(s) });
    expect(mini.statusCode).toBe(403);
    expect(mini.json().details.permission).toBe("config.read");
    const op = await loginAs(h, "operations");
    expect((await h.app.inject({ url: "/admin/v1/experience/miniapp/current", headers: browser(op.s) })).json()).toMatchObject({ version: "2.0.3" });
    expect((await h.app.inject({ url: "/admin/v1/experience/other/current", headers: browser(s) })).statusCode).toBe(404);
  });

  it("без сессии — 401; конфиг не найден — 404 домена", async () => {
    expect((await h.app.inject({ url: "/admin/v1/experience/admin/current", headers: browser() })).statusCode).toBe(401);
    const { s } = await loginAs(h, "support");
    h.fake.on("experience", "GET", "/internal/v1/experience/admin/current", () => domainError(404, "EXPERIENCE_CONFIG_NOT_FOUND"));
    const res = await h.app.inject({ url: "/admin/v1/experience/admin/current", headers: browser(s) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("EXPERIENCE_CONFIG_NOT_FOUND");
  });
});

describe("ошибки доменов", () => {
  it("5xx / сеть / битый JSON → 503 UPSTREAM_UNAVAILABLE {service}", async () => {
    const { s } = await loginAs(h, "auditor");
    h.fake.on("audit", "GET", "/admin/v1/audit/verify", () => new Response("{not json", { status: 200 }));
    const bad = await h.app.inject({ url: "/admin/v1/audit/verify", headers: browser(s) });
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "audit" } });
    h.fake.down.add("audit");
    expect((await h.app.inject({ url: "/admin/v1/audit/records", headers: browser(s) })).statusCode).toBe(503);
  });

  it("отказ внутренней авторизации домена (ACTOR_NOT_ALLOWED / INTERNAL_TOKEN_*) → 503, а не 401/403", async () => {
    const { s } = await loginAs(h, "auditor");
    h.fake.on("audit", "GET", "/admin/v1/audit/records", () => domainError(403, "ACTOR_NOT_ALLOWED"));
    const res = await h.app.inject({ url: "/admin/v1/audit/records", headers: browser(s) });
    expect(res.statusCode).toBe(503);
    h.fake.on("audit", "GET", "/admin/v1/audit/verify", () => domainError(401, "INTERNAL_TOKEN_EXPIRED"));
    expect((await h.app.inject({ url: "/admin/v1/audit/verify", headers: browser(s) })).statusCode).toBe(503);
    // сессия при этом не отзывается
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
  });

  it("admin-identity недоступен при проверке principal → 503 (fail-closed), сессия не удаляется", async () => {
    await h.close();
    h = await makeHarness({ PRINCIPAL_CACHE_SECONDS: "0" });
    const { s } = await loginAs(h, "support");
    h.fake.down.add("adminIdentity");
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(503);
    h.fake.down.delete("adminIdentity");
    // circuit breaker закрыт успешным вызовом? — после одного сбоя порог (5) не достигнут
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
  });
});

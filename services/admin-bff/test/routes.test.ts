/**
 * Матрица маршрутов: КАЖДЫЙ сессионный маршрут admin-bff проверяется на
 *  - 403 STEP_UP_REQUIRED без свежего TOTP на маршрутах requireStepUp (до вызова домена),
 *  - happy path через подделку доменов: ожидаемый статус, вызов нужного домена и пути с actor-токеном сотрудника,
 *  - 4xx домена передаётся клиенту с кодом и details; 5xx / сеть → 503 UPSTREAM_UNAVAILABLE {service}.
 * 401 без сессии, 403 PERMISSION_DENIED и 403 CSRF_INVALID на всех маршрутах — security.test.ts.
 * Новый маршрут без строки в CASES роняет тест «матрица покрывает все маршруты».
 *
 * Строгость контракта: fast-json-stringify молча превращает null в ""/0/{} и не требует полей, поэтому каждый 2xx
 * объект ДО сериализации проверяется строгим Ajv по той же схеме ответа (x-contract-required → required).
 */
import { Ajv, type ValidateFunction } from "ajv";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { strictContractSchema } from "../src/responses.js";
import {
  AUD,
  APPROVAL_ID,
  CAMPAIGN_ID,
  LEARNER_ID,
  NOTE_ID,
  RECORD_ID,
  TICKET_ID,
  browser,
  campaignBody,
  closeRedis,
  domainError,
  loginAs,
  makeHarness,
  releaseNoteBody,
  stepUp,
  type Harness,
  type Service,
} from "./helpers.js";

/** Нарушения схем контракта, собранные пробой ответа (route, status, ошибки Ajv). */
const violations: string[] = [];
const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new WeakMap<object, ValidateFunction>();
function probe(req: FastifyRequest, reply: FastifyReply, payload: unknown): void {
  const status = reply.statusCode;
  if (status < 200 || status >= 300) return;
  const resp = (req.routeOptions.schema?.response ?? {}) as Record<string, object>;
  const schema = resp[String(status)] ?? resp[`${String(status)[0]}xx`];
  if (!schema) {
    violations.push(`${req.method} ${req.routeOptions.url} ${status}: нет схемы ответа`);
    return;
  }
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(strictContractSchema(schema) as object);
    compiled.set(schema, validate);
  }
  if (!validate(payload)) {
    violations.push(`${req.method} ${req.routeOptions.url} ${status}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
}

const STAFF_ID = "7d0c2f43-58b5-4d0e-9f7e-2a8c7c1b9e11";
const IK = (k: string) => ({ "idempotency-key": `matrix-${k}-0001` });

interface Case {
  /** URL с подставленными параметрами */
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  status: number;
  /** домен, метод и путь, которые обязаны быть вызваны (null — ответ собирает сам BFF) */
  domain: [Service, string, string] | null;
}

/** Ключ — "<METHOD> <шаблон маршрута>" как в app.adminRoutes. */
const CASES: Record<string, Case> = {
  // ---------- вход и сессия
  "POST /admin/v1/auth/step-up": { url: "/admin/v1/auth/step-up", payload: { code: "123456" }, status: 200, domain: ["adminIdentity", "POST", "/internal/v1/auth/step-up"] },
  "POST /admin/v1/auth/logout": { url: "/admin/v1/auth/logout", status: 204, domain: ["adminIdentity", "POST", "/internal/v1/auth/logout"] },
  "GET /admin/v1/me": { url: "/admin/v1/me", status: 200, domain: null },
  // ---------- сотрудники, роли, заявки
  "GET /admin/v1/staff": { url: "/admin/v1/staff?q=anna&role=support&status=ACTIVE&limit=20", status: 200, domain: ["adminIdentity", "GET", "/admin/v1/staff"] },
  "GET /admin/v1/staff/:id": { url: `/admin/v1/staff/${STAFF_ID}`, status: 200, domain: ["adminIdentity", "GET", `/admin/v1/staff/${STAFF_ID}`] },
  "POST /admin/v1/staff": {
    url: "/admin/v1/staff",
    payload: { email: "new@tilhero.test", display_name: "Новый", role: "support" },
    headers: IK("staff"),
    status: 201,
    domain: ["adminIdentity", "POST", "/admin/v1/staff"],
  },
  "PATCH /admin/v1/staff/:id": {
    url: `/admin/v1/staff/${STAFF_ID}`,
    payload: { display_name: "Анна", reason: "опечатка" },
    status: 200,
    domain: ["adminIdentity", "PATCH", `/admin/v1/staff/${STAFF_ID}`],
  },
  "POST /admin/v1/staff/:id/reset-password": {
    url: `/admin/v1/staff/${STAFF_ID}/reset-password`,
    payload: { reason: "забыла" },
    status: 200,
    domain: ["adminIdentity", "POST", `/admin/v1/staff/${STAFF_ID}/reset-password`],
  },
  "POST /admin/v1/staff/:id/reset-mfa": {
    url: `/admin/v1/staff/${STAFF_ID}/reset-mfa`,
    payload: { reason: "новый телефон" },
    status: 200,
    domain: ["adminIdentity", "POST", `/admin/v1/staff/${STAFF_ID}/reset-mfa`],
  },
  "GET /admin/v1/roles": { url: "/admin/v1/roles", status: 200, domain: ["adminIdentity", "GET", "/admin/v1/roles"] },
  "PUT /admin/v1/roles/:code": {
    url: "/admin/v1/roles/support",
    payload: { permissions: ["dashboard.read", "support.read"], reason: "сужение" },
    status: 202,
    domain: ["adminIdentity", "PUT", "/admin/v1/roles/support"],
  },
  "GET /admin/v1/approvals": { url: "/admin/v1/approvals?status=PENDING", status: 200, domain: ["adminIdentity", "GET", "/admin/v1/approvals"] },
  "POST /admin/v1/approvals/:id/approve": {
    url: `/admin/v1/approvals/${APPROVAL_ID}/approve`,
    payload: { note: "ок" },
    status: 200,
    domain: ["adminIdentity", "POST", `/admin/v1/approvals/${APPROVAL_ID}/approve`],
  },
  "POST /admin/v1/approvals/:id/reject": {
    url: `/admin/v1/approvals/${APPROVAL_ID}/reject`,
    status: 200,
    domain: ["adminIdentity", "POST", `/admin/v1/approvals/${APPROVAL_ID}/reject`],
  },
  // ---------- ученики
  "GET /admin/v1/learners": {
    url: "/admin/v1/learners?q=%40aziz&kind=account&age_band=18%2B&status=ACTIVE&locale=uz&has_open_tickets=true&limit=50",
    status: 200,
    domain: ["userAdmin", "GET", "/admin/v1/learners"],
  },
  "GET /admin/v1/learners/:id": { url: `/admin/v1/learners/${LEARNER_ID}`, status: 200, domain: ["userAdmin", "GET", `/admin/v1/learners/${LEARNER_ID}`] },
  "POST /admin/v1/learners/:id/reveal": {
    url: `/admin/v1/learners/${LEARNER_ID}/reveal`,
    payload: { field: "telegram_user_id", reason: "проверка обращения" },
    status: 200,
    domain: ["identity", "POST", `/admin/v1/users/${LEARNER_ID}/reveal`],
  },
  "GET /admin/v1/dashboard": { url: "/admin/v1/dashboard?period=7d", status: 200, domain: ["userAdmin", "GET", "/admin/v1/learners/stats"] },
  // ---------- поддержка
  "GET /admin/v1/support/tickets": {
    url: `/admin/v1/support/tickets?status=open&category=LESSON&priority=high&assignee=me&sla=breached&user_id=${LEARNER_ID}&sort=sla&limit=10`,
    status: 200,
    domain: ["support", "GET", "/admin/v1/support/tickets"],
  },
  "GET /admin/v1/support/tickets/:id": { url: "/admin/v1/support/tickets/TCK-3001", status: 200, domain: ["support", "GET", "/admin/v1/support/tickets/TCK-3001"] },
  "GET /admin/v1/support/tickets/:id/client-view": {
    url: `/admin/v1/support/tickets/${TICKET_ID}/client-view`,
    status: 200,
    domain: ["support", "GET", `/admin/v1/support/tickets/${TICKET_ID}/client-view`],
  },
  "POST /admin/v1/support/tickets/:id/messages": {
    url: "/admin/v1/support/tickets/TCK-3001/messages",
    payload: { text: "Здравствуйте! Обновите приложение.", visibility: "public" },
    headers: IK("msg"),
    status: 200,
    domain: ["support", "POST", "/admin/v1/support/tickets/TCK-3001/messages"],
  },
  "PATCH /admin/v1/support/tickets/:id": {
    url: "/admin/v1/support/tickets/TCK-3001",
    payload: { status: "WAITING_CUSTOMER", priority: "high", assignee_id: null },
    status: 200,
    domain: ["support", "PATCH", "/admin/v1/support/tickets/TCK-3001"],
  },
  "POST /admin/v1/support/tickets/:id/take": { url: "/admin/v1/support/tickets/TCK-3001/take", status: 200, domain: ["support", "POST", "/admin/v1/support/tickets/TCK-3001/take"] },
  "POST /admin/v1/support/tickets/:id/escalations": {
    url: "/admin/v1/support/tickets/TCK-3001/escalations",
    payload: { type: "content_review", note: "Ошибка в упражнении" },
    headers: IK("esc"),
    status: 201,
    domain: ["support", "POST", "/admin/v1/support/tickets/TCK-3001/escalations"],
  },
  "GET /admin/v1/support/stats": { url: "/admin/v1/support/stats?period=30d", status: 200, domain: ["support", "GET", "/admin/v1/support/stats"] },
  "GET /admin/v1/support/templates": { url: "/admin/v1/support/templates", status: 200, domain: ["support", "GET", "/admin/v1/support/templates"] },
  "GET /admin/v1/support/sla-policies": { url: "/admin/v1/support/sla-policies", status: 200, domain: ["support", "GET", "/admin/v1/support/sla-policies"] },
  "PUT /admin/v1/support/sla-policies": {
    url: "/admin/v1/support/sla-policies",
    payload: { items: [{ category: "*", priority: "normal", first_response_minutes: 60, resolution_minutes: 600 }], reason: "ускоряем ответы" },
    status: 200,
    domain: ["support", "PUT", "/admin/v1/support/sla-policies"],
  },
  // ---------- аудит
  "GET /admin/v1/audit/records": {
    url: "/admin/v1/audit/records?action=release_note.publish&object_type=release_note&from=2026-11-01&to=2026-11-18T00:00:00Z",
    status: 200,
    domain: ["audit", "GET", "/admin/v1/audit/records"],
  },
  "GET /admin/v1/audit/records/:id": { url: `/admin/v1/audit/records/${RECORD_ID}`, status: 200, domain: ["audit", "GET", `/admin/v1/audit/records/${RECORD_ID}`] },
  "GET /admin/v1/audit/verify": { url: "/admin/v1/audit/verify", status: 200, domain: ["audit", "GET", "/admin/v1/audit/verify"] },
  // ---------- конфигурация
  "GET /admin/v1/experience/admin/current": { url: "/admin/v1/experience/admin/current", status: 200, domain: ["experience", "GET", "/internal/v1/experience/admin/current"] },
  "GET /admin/v1/experience/miniapp/current": { url: "/admin/v1/experience/miniapp/current", status: 200, domain: ["experience", "GET", "/internal/v1/experience/miniapp/current"] },
  "GET /admin/v1/experience/:app/state": { url: "/admin/v1/experience/miniapp/state", status: 200, domain: ["experience", "GET", "/admin/v1/experience/miniapp/state"] },
  "GET /admin/v1/experience/:app/versions": { url: "/admin/v1/experience/admin/versions?limit=5", status: 200, domain: ["experience", "GET", "/admin/v1/experience/admin/versions"] },
  "GET /admin/v1/experience/:app/versions/:version": {
    url: "/admin/v1/experience/admin/versions/1.0.0",
    status: 200,
    domain: ["experience", "GET", "/admin/v1/experience/admin/versions/1.0.0"],
  },
  "GET /admin/v1/experience/:app/activations": { url: "/admin/v1/experience/admin/activations", status: 200, domain: ["experience", "GET", "/admin/v1/experience/admin/activations"] },
  "POST /admin/v1/experience/:app/versions": {
    url: "/admin/v1/experience/miniapp/versions",
    payload: { version: "1.1.0", payload: { theme: { id: "notebook" } }, change_note: "новая тема" },
    status: 201,
    domain: ["experience", "POST", "/admin/v1/experience/miniapp/versions"],
  },
  "POST /admin/v1/experience/:app/activate": {
    url: "/admin/v1/experience/miniapp/activate",
    payload: { version: "1.1.0", reason: "релиз" },
    status: 201,
    domain: ["experience", "POST", "/admin/v1/experience/miniapp/activate"],
  },
  "POST /admin/v1/experience/:app/rollback": {
    url: "/admin/v1/experience/admin/rollback",
    payload: { reason: "откат темы" },
    status: 201,
    domain: ["experience", "POST", "/admin/v1/experience/admin/rollback"],
  },
  // ---------- «Что нового»
  "GET /admin/v1/release-notes": { url: "/admin/v1/release-notes?status=draft&limit=10", status: 200, domain: ["experience", "GET", "/admin/v1/release-notes"] },
  "GET /admin/v1/release-notes/:id": { url: `/admin/v1/release-notes/${NOTE_ID}`, status: 200, domain: ["experience", "GET", `/admin/v1/release-notes/${NOTE_ID}`] },
  "GET /admin/v1/release-notes/:id/stats": { url: `/admin/v1/release-notes/${NOTE_ID}/stats`, status: 200, domain: ["experience", "GET", `/admin/v1/release-notes/${NOTE_ID}/stats`] },
  "POST /admin/v1/release-notes": { url: "/admin/v1/release-notes", payload: releaseNoteBody(), headers: IK("note"), status: 201, domain: ["experience", "POST", "/admin/v1/release-notes"] },
  "PUT /admin/v1/release-notes/:id": {
    url: `/admin/v1/release-notes/${NOTE_ID}`,
    payload: { ...releaseNoteBody(), expected_version: 1 },
    status: 200,
    domain: ["experience", "PUT", `/admin/v1/release-notes/${NOTE_ID}`],
  },
  "POST /admin/v1/release-notes/:id/publish": {
    url: `/admin/v1/release-notes/${NOTE_ID}/publish`,
    payload: { expected_version: 1, reason: "релиз ноября" },
    headers: IK("pub"),
    status: 201,
    domain: ["experience", "POST", `/admin/v1/release-notes/${NOTE_ID}/publish`],
  },
  "POST /admin/v1/release-notes/:id/archive": {
    url: `/admin/v1/release-notes/${NOTE_ID}/archive`,
    payload: { reason: "устарела" },
    status: 201,
    domain: ["experience", "POST", `/admin/v1/release-notes/${NOTE_ID}/archive`],
  },
  // ---------- шаблоны уведомлений
  "GET /admin/v1/notifications/templates": { url: "/admin/v1/notifications/templates", status: 200, domain: ["notifications", "GET", "/admin/v1/notifications/templates"] },
  "GET /admin/v1/notifications/templates/:key": {
    url: "/admin/v1/notifications/templates/lesson.reminder.kid",
    status: 200,
    domain: ["notifications", "GET", "/admin/v1/notifications/templates/lesson.reminder.kid"],
  },
  "POST /admin/v1/notifications/templates/:key/versions": {
    url: "/admin/v1/notifications/templates/lesson.reminder/versions",
    payload: { texts: campaignBody().texts, note: "мягче тон" },
    headers: IK("tplv"),
    status: 201,
    domain: ["notifications", "POST", "/admin/v1/notifications/templates/lesson.reminder/versions"],
  },
  "POST /admin/v1/notifications/templates/:key/versions/:v/preview": {
    url: "/admin/v1/notifications/templates/lesson.reminder/versions/3/preview",
    payload: { lang: "ru", sample: { learner_name: "Азиз" } },
    status: 200,
    domain: ["notifications", "POST", "/admin/v1/notifications/templates/lesson.reminder/versions/3/preview"],
  },
  "POST /admin/v1/notifications/templates/:key/versions/:v/activate": {
    url: "/admin/v1/notifications/templates/lesson.reminder/versions/3/activate",
    payload: { reason: "новый текст" },
    status: 200,
    domain: ["notifications", "POST", "/admin/v1/notifications/templates/lesson.reminder/versions/3/activate"],
  },
  "POST /admin/v1/notifications/templates/:key/reset": {
    url: "/admin/v1/notifications/templates/lesson.reminder/reset",
    payload: { reason: "вернуть по умолчанию" },
    status: 200,
    domain: ["notifications", "POST", "/admin/v1/notifications/templates/lesson.reminder/reset"],
  },
  "POST /admin/v1/notifications/templates/:key/versions/:v/test": {
    url: "/admin/v1/notifications/templates/lesson.reminder/versions/3/test",
    payload: { lang: "uz", recipient: 0 },
    status: 200,
    domain: ["notifications", "POST", "/admin/v1/notifications/templates/lesson.reminder/versions/3/test"],
  },
  "GET /admin/v1/notifications/test-recipients": { url: "/admin/v1/notifications/test-recipients", status: 200, domain: ["notifications", "GET", "/admin/v1/notifications/test-recipients"] },
  // ---------- рассылки
  "GET /admin/v1/notifications/campaigns": { url: "/admin/v1/notifications/campaigns?status=draft", status: 200, domain: ["notifications", "GET", "/admin/v1/notifications/campaigns"] },
  "GET /admin/v1/notifications/campaigns/:id": {
    url: `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`,
    status: 200,
    domain: ["notifications", "GET", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`],
  },
  "POST /admin/v1/notifications/campaigns": {
    url: "/admin/v1/notifications/campaigns",
    payload: campaignBody(),
    headers: IK("camp"),
    status: 201,
    domain: ["notifications", "POST", "/admin/v1/notifications/campaigns"],
  },
  "PATCH /admin/v1/notifications/campaigns/:id": {
    url: `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`,
    payload: { expected_version: 1, segment: { age: ["teens", "adults"] } },
    status: 200,
    domain: ["notifications", "PATCH", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}`],
  },
  "POST /admin/v1/notifications/campaigns/:id/estimate": {
    url: `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/estimate`,
    status: 200,
    domain: ["notifications", "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/estimate`],
  },
  "POST /admin/v1/notifications/campaigns/:id/preview": {
    url: `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/preview`,
    payload: { lang: "uz" },
    status: 200,
    domain: ["notifications", "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/preview`],
  },
  "POST /admin/v1/notifications/campaigns/:id/test": {
    url: `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/test`,
    payload: { lang: "ru", recipient: 0 },
    status: 200,
    domain: ["notifications", "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/test`],
  },
  "POST /admin/v1/notifications/campaigns/:id/schedule": {
    url: `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/schedule`,
    payload: { expected_version: 1, send_at: "2026-11-20T09:00:00+05:00", reason: "рассылка ноября" },
    headers: IK("sched"),
    status: 200,
    domain: ["notifications", "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/schedule`],
  },
  "POST /admin/v1/notifications/campaigns/:id/unschedule": {
    url: `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/unschedule`,
    payload: { reason: "перенос" },
    status: 200,
    domain: ["notifications", "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/unschedule`],
  },
  "POST /admin/v1/notifications/campaigns/:id/stop": {
    url: `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/stop`,
    payload: { reason: "ошибка в тексте" },
    status: 200,
    domain: ["notifications", "POST", `/admin/v1/notifications/campaigns/${CAMPAIGN_ID}/stop`],
  },
};

let h: Harness;
beforeEach(async () => {
  violations.length = 0;
  h = await makeHarness({}, { responseProbe: probe });
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

describe("матрица маршрутов", () => {
  it("покрывает все сессионные маршруты", () => {
    const routes = h.app.adminRoutes.filter((r) => r.access === "session").map((r) => `${r.method} ${r.url}`);
    expect(routes.filter((r) => !(r in CASES))).toEqual([]);
    expect(Object.keys(CASES).filter((k) => !routes.includes(k))).toEqual([]);
  });

  it("step-up маршруты: без свежего TOTP → 403 STEP_UP_REQUIRED {permission}, домен не вызывается", async () => {
    const { s } = await loginAs(h, "super_admin");
    for (const r of h.app.adminRoutes.filter((x) => x.stepUp)) {
      const c = CASES[`${r.method} ${r.url}`]!;
      const before = h.fake.calls.length;
      const res = await h.app.inject({ method: r.method as "POST", url: c.url, headers: { ...browser(s), ...c.headers }, payload: (c.payload ?? {}) as object });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(res.json().code).toBe("STEP_UP_REQUIRED");
      if (r.guard.startsWith("role:")) expect(res.json().details).toEqual({});
      else expect(res.json().details.permission).toBe(r.guard.split("|")[0]);
      expect(h.fake.calls.length, `${r.method} ${r.url}`).toBe(before);
    }
  });

  it("happy path: статус, вызов домена с actor, ответ строго по контракту admin.ts", async () => {
    const { staff, s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    // logout завершает сессию — последним
    const keys = Object.keys(CASES).sort((a, b) => Number(a.includes("/logout")) - Number(b.includes("/logout")));
    for (const key of keys) {
      if (key === "POST /admin/v1/auth/step-up") continue; // уже выполнен
      const c = CASES[key]!;
      const method = key.split(" ")[0]! as "GET";
      const before = h.fake.calls.length;
      const res = await h.app.inject({
        method,
        url: c.url,
        headers: { ...browser(s), ...c.headers },
        ...(method === "GET" ? {} : { payload: (c.payload ?? {}) as object }),
      });
      expect(res.statusCode, `${key}: ${res.body.slice(0, 300)}`).toBe(c.status);
      if (c.domain) {
        const [svc, m, path] = c.domain;
        const call = h.fake.calls.slice(before).find((x) => x.service === svc && x.method === m && x.path === path);
        expect(call, `${key} → ${svc} ${m} ${path}`).toBeDefined();
        if (path !== "/internal/v1/experience/admin/current" && path !== "/internal/v1/experience/miniapp/current" && !path.startsWith("/internal/v1/auth/")) {
          expect(call!.actor?.id, key).toBe(staff.staff_id);
        }
        if (c.headers?.["idempotency-key"]) expect(call!.headers["idempotency-key"], key).toBe(c.headers["idempotency-key"]);
      }
    }
    expect(violations).toEqual([]);
  });

  it("4xx домена → клиенту с кодом и details; 5xx и сеть → 503 UPSTREAM_UNAVAILABLE {service} на каждом проксирующем маршруте", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const proxied = Object.entries(CASES).filter(
      ([k, c]) => c.domain && c.domain[0] !== "adminIdentity" && k !== "GET /admin/v1/dashboard" && !k.includes("/auth/"),
    );
    expect(proxied.length).toBeGreaterThan(45);
    const send = (key: string, c: Case) => {
      const method = key.split(" ")[0]! as "GET";
      return h.app.inject({ method, url: c.url, headers: { ...browser(s), ...c.headers }, ...(method === "GET" ? {} : { payload: (c.payload ?? {}) as object }) });
    };
    for (const [key, c] of proxied) {
      const [svc, m, path] = c.domain!;
      h.fake.on(svc, m, path, () => domainError(409, "DOMAIN_CONFLICT", { current_version: 7 }));
      const conflict = await send(key, c);
      expect(conflict.statusCode, key).toBe(409);
      expect(conflict.json(), key).toMatchObject({ code: "DOMAIN_CONFLICT", details: { current_version: 7 } });
    }
    // 5xx — вторым проходом: после 5 сбоев circuit breaker домена открыт, ответ тот же 503
    for (const [key, c] of proxied) {
      const [svc, m, path] = c.domain!;
      h.fake.on(svc, m, path, () => domainError(500, "BOOM"));
      const boom = await send(key, c);
      expect(boom.statusCode, key).toBe(503);
      expect(boom.json(), key).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: AUD[svc] } });
      expect(boom.body, key).not.toContain("BOOM");
    }
  });
});

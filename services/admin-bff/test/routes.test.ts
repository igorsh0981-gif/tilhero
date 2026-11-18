/**
 * Матрица маршрутов: КАЖДЫЙ сессионный маршрут admin-bff проверяется на
 *  - 403 PERMISSION_DENIED у сотрудника без прав (до вызова домена),
 *  - 403 STEP_UP_REQUIRED без свежего TOTP на маршрутах requireStepUp (до вызова домена),
 *  - happy path через подделку доменов: ожидаемый статус, вызов нужного домена с actor-токеном сотрудника.
 * Новый маршрут без строки в CASES роняет тест «матрица покрывает все маршруты» (A30 — в security.test.ts).
 *
 * Строгость контракта: fast-json-stringify молча превращает null в ""/0/{} и не требует полей, поэтому каждый 2xx
 * объект ДО сериализации проверяется строгим Ajv по той же схеме ответа (x-contract-required → required).
 */

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
import { Ajv, type ValidateFunction } from "ajv";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { strictContractSchema } from "../src/responses.js";
import {
  REVIEW_ID,
  RUN_ID,
  SOURCE_ID,
  fakeSprint4,
  fakeSprint5,
  jsonApiMapping,
  fakeSprint6,
  fakeLimits,
  fakeSprint7,
  fakeSprint8,
  fakeSprint9,
  fakeReleaseNotes,
  NOTE_ID,
  releaseNoteBody,
  DELETION_ID,
  OPS_ALERT_ID,
  ALERT_ID,
  CASE_ID,
  REQUEST_ID,
  RUN_ID7,
  NEWS_ID,
  NEWS_SOURCE_ID,
  OFFER_ID,
  TICKET_ID,
  activationRow,
  approvalRow,
  auditRow,
  staffRow,
  versionRow,
  TOTP_OK,
  USER_ID,
  browser,
  cookieOf,
  stepUp,
  closeRedis,
  json,
  login,
  loginAs,
  redis,
  makeHarness,
  type Harness,
  type Service,
} from "./helpers.js";

const STAFF_ID = "7d0c2f43-58b5-4d0e-9f7e-2a8c7c1b9e11";
const APPROVAL_ID = "5b1f0d0e-1111-4c2b-9a51-0d6c7a1e2f30";
const RECORD_ID = "9a3e3a7e-2f4b-4c1d-8e5f-6a7b8c9d0e1f";

interface Case {
  /** URL с подставленными параметрами */
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  status: number;
  /** домен и путь, который обязан быть вызван (null — ответ собирает сам BFF) */
  domain: [Service, string, string] | null;
}

/** Ключ — "<METHOD> <шаблон маршрута>" как в app.adminRoutes. */
const CASES: Record<string, Case> = {
  // ---------- спринт 8: мониторинг, оповещения
  "GET /admin/v1/ops/providers": { url: "/admin/v1/ops/providers", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/health/providers"] },
  "GET /admin/v1/ops/providers/:provider/history": {
    url: "/admin/v1/ops/providers/aviasales/history?range=7d",
    status: 200,
    domain: ["opsMonitor", "GET", "/internal/v1/health/providers/aviasales/history"],
  },
  "POST /admin/v1/ops/providers/:provider/probe": {
    url: "/admin/v1/ops/providers/aviasales/probe",
    payload: {},
    status: 200,
    domain: ["opsMonitor", "POST", "/internal/v1/health/providers/aviasales:probe"],
  },
  "GET /admin/v1/ops/feeds": { url: "/admin/v1/ops/feeds", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/health/feeds"] },
  "GET /admin/v1/ops/alerts": { url: "/admin/v1/ops/alerts?state=open&limit=20", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/alerts"] },
  "GET /admin/v1/ops/queues/streams": { url: "/admin/v1/ops/queues/streams", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/queues/streams"] },
  "GET /admin/v1/ops/queues/consumers": { url: "/admin/v1/ops/queues/consumers", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/queues/consumers"] },
  "GET /admin/v1/ops/queues/outbox": { url: "/admin/v1/ops/queues/outbox", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/queues/outbox"] },
  "GET /admin/v1/ops/queues/services": { url: "/admin/v1/ops/queues/services", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/queues/services"] },
  "GET /admin/v1/ops/dlq": { url: "/admin/v1/ops/dlq?consumer=notifications_watch_changes&limit=50", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/dlq/messages"] },
  "GET /admin/v1/ops/dlq/actions": { url: "/admin/v1/ops/dlq/actions", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/dlq/actions"] },
  "GET /admin/v1/ops/dlq/:dlqId": { url: "/admin/v1/ops/dlq/dlq:42", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/dlq/messages/dlq:42"] },
  "POST /admin/v1/ops/dlq/replay": {
    url: "/admin/v1/ops/dlq/replay",
    payload: { ids: ["dlq:42"], reason: "Исправлен обработчик" },
    headers: { "idempotency-key": "matrix-dlq-0001" },
    status: 200,
    domain: ["opsMonitor", "POST", "/internal/v1/dlq:replay"],
  },
  "POST /admin/v1/ops/dlq/delete": {
    url: "/admin/v1/ops/dlq/delete",
    payload: { filter: { consumer: "notifications_watch_changes" }, expected_count: 3, reason: "Тестовые сообщения" },
    headers: { "idempotency-key": "matrix-dlq-0002" },
    status: 200,
    domain: ["opsMonitor", "POST", "/internal/v1/dlq:delete"],
  },
  "GET /admin/v1/alerts": { url: "/admin/v1/alerts?state=open", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/alerts"] },
  "POST /admin/v1/alerts/:source/:id/ack": {
    url: `/admin/v1/alerts/ops/${OPS_ALERT_ID}/ack`,
    payload: { comment: "Смотрим" },
    status: 200,
    domain: ["opsMonitor", "POST", `/internal/v1/alerts/${OPS_ALERT_ID}:ack`],
  },
  // ---------- спринт 9: удаления профиля и лимиты запросов
  "GET /admin/v1/deletions": { url: "/admin/v1/deletions?status=stuck&limit=20", status: 200, domain: ["identity", "GET", "/admin/v1/deletions"] },
  "GET /admin/v1/deletions/:request_id": { url: `/admin/v1/deletions/${DELETION_ID}`, status: 200, domain: ["identity", "GET", `/admin/v1/deletions/${DELETION_ID}`] },
  "POST /admin/v1/deletions/:request_id::retry": {
    url: `/admin/v1/deletions/${DELETION_ID}:retry`,
    payload: { reason: "Домен watch поднят" },
    headers: { "idempotency-key": "matrix-del-0001" },
    status: 200,
    domain: ["identity", "POST", `/admin/v1/deletions/${DELETION_ID}:retry`],
  },
  "GET /admin/v1/ops/ratelimits": { url: "/admin/v1/ops/ratelimits", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/ratelimits/policies"] },
  "GET /admin/v1/ops/ratelimits/:policy/history": { url: "/admin/v1/ops/ratelimits/tg.user/history?range=24h", status: 200, domain: ["opsMonitor", "GET", "/internal/v1/ratelimits/tg.user/history"] },
  "PUT /admin/v1/ops/ratelimits/:policy/override": {
    url: "/admin/v1/ops/ratelimits/tg.user/override",
    payload: { limit: 240, window_s: 60, reason: "Акция в Mini App" },
    headers: { "idempotency-key": "matrix-rl-0001" },
    status: 200,
    domain: ["opsMonitor", "PUT", "/internal/v1/ratelimits/tg.user/override"],
  },
  "DELETE /admin/v1/ops/ratelimits/:policy/override": {
    url: "/admin/v1/ops/ratelimits/tg.user/override",
    payload: { reason: "Акция закончилась" },
    headers: { "idempotency-key": "matrix-rl-0002" },
    status: 200,
    domain: ["opsMonitor", "DELETE", "/internal/v1/ratelimits/tg.user/override"],
  },
  "GET /admin/v1/me": { url: "/admin/v1/me", status: 200, domain: null },
  "POST /admin/v1/auth/step-up": {
    url: "/admin/v1/auth/step-up",
    payload: { code: TOTP_OK },
    status: 200,
    domain: ["adminIdentity", "POST", "/internal/v1/auth/step-up"],
  },
  "POST /admin/v1/dev/impersonate": {
    url: "/admin/v1/dev/impersonate",
    payload: { role: null },
    status: 200,
    domain: ["audit", "POST", "/internal/v1/records"],
  },
  "GET /admin/v1/dashboard": { url: "/admin/v1/dashboard?period=30d", status: 200, domain: ["userAdmin", "GET", "/admin/v1/users/stats"] },
  "GET /admin/v1/users": { url: "/admin/v1/users?has_open_tickets=true", status: 200, domain: ["userAdmin", "GET", "/admin/v1/users"] },
  "GET /admin/v1/users/:id": { url: `/admin/v1/users/${USER_ID}`, status: 200, domain: ["userAdmin", "GET", `/admin/v1/users/${USER_ID}`] },
  "POST /admin/v1/users/:id/reveal": {
    url: `/admin/v1/users/${USER_ID}/reveal`,
    payload: { field: "telegram_user_id", reason: "проверка обращения" },
    status: 200,
    domain: ["identity", "POST", `/admin/v1/users/${USER_ID}/reveal`],
  },
  "GET /admin/v1/support/tickets": { url: "/admin/v1/support/tickets?status=open", status: 200, domain: ["support", "GET", "/admin/v1/support/tickets"] },
  "GET /admin/v1/support/stats": { url: "/admin/v1/support/stats", status: 200, domain: ["support", "GET", "/admin/v1/support/stats"] },
  "GET /admin/v1/support/templates": { url: "/admin/v1/support/templates", status: 200, domain: null },
  "GET /admin/v1/support/tickets/:id": {
    url: `/admin/v1/support/tickets/${TICKET_ID}`,
    status: 200,
    domain: ["support", "GET", `/admin/v1/support/tickets/${TICKET_ID}`],
  },
  "GET /admin/v1/support/tickets/:id/client-view": {
    url: `/admin/v1/support/tickets/${TICKET_ID}/client-view`,
    status: 200,
    domain: ["support", "GET", `/admin/v1/support/tickets/${TICKET_ID}/client-view`],
  },
  "POST /admin/v1/support/tickets/:id/messages": {
    url: `/admin/v1/support/tickets/${TICKET_ID}/messages`,
    payload: { text: "Здравствуйте!", visibility: "public" },
    headers: { "idempotency-key": "matrix-msg-0001" },
    status: 200,
    domain: ["support", "POST", `/admin/v1/support/tickets/${TICKET_ID}/messages`],
  },
  "PATCH /admin/v1/support/tickets/:id": {
    url: `/admin/v1/support/tickets/${TICKET_ID}`,
    payload: { status: "RESOLVED" },
    status: 200,
    domain: ["support", "PATCH", `/admin/v1/support/tickets/${TICKET_ID}`],
  },
  "POST /admin/v1/support/tickets/:id/take": {
    url: `/admin/v1/support/tickets/${TICKET_ID}/take`,
    status: 200,
    domain: ["support", "POST", `/admin/v1/support/tickets/${TICKET_ID}/take`],
  },
  "POST /admin/v1/support/tickets/:id/escalations": {
    url: `/admin/v1/support/tickets/${TICKET_ID}/escalations`,
    payload: { type: "billing_review", note: "Двойное списание" },
    status: 201,
    domain: ["support", "POST", `/admin/v1/support/tickets/${TICKET_ID}/escalations`],
  },
  "POST /admin/v1/support/tickets/:id/ai-draft": {
    url: `/admin/v1/support/tickets/${TICKET_ID}/ai-draft`,
    status: 200,
    domain: ["support", "GET", `/admin/v1/support/tickets/${TICKET_ID}`],
  },
  "GET /admin/v1/support/sla-policies": { url: "/admin/v1/support/sla-policies", status: 200, domain: ["support", "GET", "/admin/v1/support/sla-policies"] },
  "PUT /admin/v1/support/sla-policies": {
    url: "/admin/v1/support/sla-policies",
    payload: { items: [{ category: "PRICE", priority: "high", first_response_minutes: 30, resolution_minutes: 240 }], reason: "ускорение" },
    status: 200,
    domain: ["support", "PUT", "/admin/v1/support/sla-policies"],
  },
  "GET /admin/v1/staff": { url: "/admin/v1/staff?role=support&status=ACTIVE", status: 200, domain: ["adminIdentity", "GET", "/admin/v1/staff"] },
  "POST /admin/v1/staff": {
    url: "/admin/v1/staff",
    payload: { email: "matrix@tilhero.test", display_name: "Матрица", role: "analyst" },
    status: 201,
    domain: ["adminIdentity", "POST", "/admin/v1/staff"],
  },
  "PATCH /admin/v1/staff/:id": {
    url: `/admin/v1/staff/${STAFF_ID}`,
    payload: { display_name: "Новое имя", reason: "опечатка" },
    status: 200,
    domain: ["adminIdentity", "PATCH", `/admin/v1/staff/${STAFF_ID}`],
  },
  "POST /admin/v1/staff/:id/reset-password": {
    url: `/admin/v1/staff/${STAFF_ID}/reset-password`,
    payload: { reason: "забыл пароль" },
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
    url: "/admin/v1/roles/auditor",
    payload: { permissions: ["dashboard.read", "audit.read"], reason: "без изменений" },
    status: 202,
    domain: ["adminIdentity", "PUT", "/admin/v1/roles/auditor"],
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
  "GET /admin/v1/audit/records": { url: "/admin/v1/audit/records?object_type=staff", status: 200, domain: ["audit", "GET", "/admin/v1/audit/records"] },
  "GET /admin/v1/audit/records/:id": {
    url: `/admin/v1/audit/records/${RECORD_ID}`,
    status: 200,
    domain: ["audit", "GET", `/admin/v1/audit/records/${RECORD_ID}`],
  },
  "GET /admin/v1/audit/verify": { url: "/admin/v1/audit/verify", status: 200, domain: ["audit", "GET", "/admin/v1/audit/verify"] },
  "GET /admin/v1/experience/:app/state": {
    url: "/admin/v1/experience/miniapp/state",
    status: 200,
    domain: ["experience", "GET", "/admin/v1/experience/miniapp/state"],
  },
  "GET /admin/v1/experience/admin/current": {
    url: "/admin/v1/experience/admin/current",
    status: 200,
    domain: ["experience", "GET", "/internal/v1/experience/admin/current"],
  },
  "GET /admin/v1/experience/miniapp/current": {
    url: "/admin/v1/experience/miniapp/current",
    status: 200,
    domain: ["experience", "GET", "/internal/v1/experience/miniapp/current"],
  },
  "GET /admin/v1/experience/:app/versions": {
    url: "/admin/v1/experience/admin/versions?limit=10",
    status: 200,
    domain: ["experience", "GET", "/admin/v1/experience/admin/versions"],
  },
  "GET /admin/v1/experience/:app/versions/:version": {
    url: "/admin/v1/experience/admin/versions/1.0.0",
    status: 200,
    domain: ["experience", "GET", "/admin/v1/experience/admin/versions/1.0.0"],
  },
  "GET /admin/v1/experience/:app/activations": {
    url: "/admin/v1/experience/admin/activations",
    status: 200,
    domain: ["experience", "GET", "/admin/v1/experience/admin/activations"],
  },
  "POST /admin/v1/experience/:app/versions": {
    url: "/admin/v1/experience/admin/versions",
    payload: { version: "1.0.1", payload: { theme: { tokens: {} } }, change_note: "новый акцент" },
    headers: { "idempotency-key": "matrix-ver-0001" },
    status: 201,
    domain: ["experience", "POST", "/admin/v1/experience/admin/versions"],
  },
  "POST /admin/v1/experience/:app/activate": {
    url: "/admin/v1/experience/admin/activate",
    payload: { version: "1.0.1", reason: "релиз темы" },
    status: 200,
    domain: ["experience", "POST", "/admin/v1/experience/admin/activate"],
  },
  "POST /admin/v1/experience/:app/rollback": {
    url: "/admin/v1/experience/admin/rollback",
    payload: { reason: "откат темы" },
    status: 201,
    domain: ["experience", "POST", "/admin/v1/experience/admin/rollback"],
  },
  // доработка 9.4: «Что нового»
  "GET /admin/v1/release-notes": { url: "/admin/v1/release-notes?status=draft&limit=20", status: 200, domain: ["experience", "GET", "/admin/v1/release-notes"] },
  "GET /admin/v1/release-notes/:id": { url: `/admin/v1/release-notes/${NOTE_ID}`, status: 200, domain: ["experience", "GET", `/admin/v1/release-notes/${NOTE_ID}`] },
  "POST /admin/v1/release-notes": {
    url: "/admin/v1/release-notes",
    payload: releaseNoteBody(),
    headers: { "idempotency-key": "matrix-note-0001" },
    status: 201,
    domain: ["experience", "POST", "/admin/v1/release-notes"],
  },
  "PUT /admin/v1/release-notes/:id": {
    url: `/admin/v1/release-notes/${NOTE_ID}`,
    payload: { ...releaseNoteBody(), expected_version: 1 },
    status: 200,
    domain: ["experience", "PUT", `/admin/v1/release-notes/${NOTE_ID}`],
  },
  "POST /admin/v1/release-notes/:id/publish": {
    url: `/admin/v1/release-notes/${NOTE_ID}/publish`,
    payload: { expected_version: 1, reason: "релиз декабря" },
    headers: { "idempotency-key": "matrix-note-0002" },
    status: 201,
    domain: ["experience", "POST", `/admin/v1/release-notes/${NOTE_ID}/publish`],
  },
  "POST /admin/v1/release-notes/:id/archive": {
    url: `/admin/v1/release-notes/${NOTE_ID}/archive`,
    payload: { reason: "опечатка" },
    status: 201,
    domain: ["experience", "POST", `/admin/v1/release-notes/${NOTE_ID}/archive`],
  },
  "POST /admin/v1/billing/payments/:paymentId/refunds": { url: "/admin/v1/billing/payments/pay_1/refunds", status: 501, domain: null },
  // спринт 4: очередь проверки, источники, поиск событий
  "GET /admin/v1/review": { url: "/admin/v1/review?status=OPEN&country=UZ", status: 200, domain: ["events", "GET", "/internal/v1/review"] },
  "GET /admin/v1/review/:id": { url: `/admin/v1/review/${REVIEW_ID}`, status: 200, domain: ["events", "GET", `/internal/v1/review/${REVIEW_ID}`] },
  "POST /admin/v1/review/:id/accept": {
    url: `/admin/v1/review/${REVIEW_ID}/accept`,
    payload: { expected_status: "OPEN", expected_content_hash: "a".repeat(64), note: "проверено на сайте" },
    headers: { "idempotency-key": "matrix-rev-0001" },
    status: 200,
    domain: ["events", "POST", `/internal/v1/review/${REVIEW_ID}:accept`],
  },
  "POST /admin/v1/review/:id/reject": {
    url: `/admin/v1/review/${REVIEW_ID}/reject`,
    payload: { expected_status: "OPEN", expected_content_hash: "a".repeat(64), reason_code: "NOT_AN_EVENT", note: "это новость" },
    status: 200,
    domain: ["events", "POST", `/internal/v1/review/${REVIEW_ID}:reject`],
  },
  "POST /admin/v1/review/:id/correct": {
    url: `/admin/v1/review/${REVIEW_ID}/correct`,
    payload: { expected_status: "OPEN", expected_content_hash: "a".repeat(64), changes: { title: "Концерт оркестра" }, basis_url: "https://iticket.uz/events/concert-1", note: "опечатка" },
    status: 200,
    domain: ["events", "POST", `/internal/v1/review/${REVIEW_ID}:correct`],
  },
  // исправление 5.1: массовое отклонение, возврат из «Не подтверждено»
  "POST /admin/v1/review/bulk-reject": {
    url: "/admin/v1/review/bulk-reject",
    payload: { items: [{ review_id: REVIEW_ID, expected_content_hash: "a".repeat(64) }], reason_code: "DUPLICATE", note: "дубль" },
    headers: { "idempotency-key": "matrix-bulk-0001" },
    status: 200,
    domain: ["events", "POST", "/internal/v1/review:bulk-reject"],
  },
  "POST /admin/v1/review/bulk-reopen": {
    url: "/admin/v1/review/bulk-reopen",
    payload: { items: [{ review_id: REVIEW_ID }], note: "вернуть" },
    headers: { "idempotency-key": "matrix-bulk-0002" },
    status: 200,
    domain: ["events", "POST", "/internal/v1/review:bulk-reopen"],
  },
  "POST /admin/v1/review/:id/reopen": {
    url: `/admin/v1/review/${REVIEW_ID}/reopen`,
    payload: { expected_status: "EXPIRED", note: "ещё актуально" },
    status: 200,
    domain: ["events", "POST", `/internal/v1/review/${REVIEW_ID}:reopen`],
  },
  "GET /admin/v1/sources": { url: "/admin/v1/sources?country=UZ&enabled=true", status: 200, domain: ["sourceRegistry", "GET", "/internal/v1/sources"] },
  "GET /admin/v1/sources/crawl-stats": { url: "/admin/v1/sources/crawl-stats", status: 200, domain: ["providerGateway", "GET", "/internal/v1/providers/ai_web/sources"] },
  "GET /admin/v1/sources/:id": { url: `/admin/v1/sources/${SOURCE_ID}`, status: 200, domain: ["sourceRegistry", "GET", `/internal/v1/sources/${SOURCE_ID}`] },
  "POST /admin/v1/sources": {
    url: "/admin/v1/sources",
    payload: {
      slug: "kassir-kz",
      name: "Kassir.kz",
      country_code: "KZ",
      tier: "OFFICIAL_TICKET_PROVIDER",
      event_domains: ["kassir.kz"],
      media_domains: [],
      listing_pages: [{ url: "https://kassir.kz/afisha", city: "Almaty", category: null }],
      enabled: false,
      js_only: null,
      notes: null,
      reason: "новый источник",
    },
    headers: { "idempotency-key": "matrix-src-0001" },
    status: 201,
    domain: ["sourceRegistry", "POST", "/internal/v1/sources"],
  },
  // исправление 9.3: предпросмотр страницы «JSON API»
  "POST /admin/v1/sources/json-api/preview": {
    url: "/admin/v1/sources/json-api/preview",
    payload: { source_id: SOURCE_ID, country_code: "KZ", event_domains: ["iticket.uz"], media_domains: ["cdn.iticket.uz"], city: "Almaty", category: "culture.theatre", json_api: jsonApiMapping() },
    status: 200,
    domain: ["providerGateway", "POST", "/internal/v1/providers/ai_web/json_api:preview"],
  },
  "PATCH /admin/v1/sources/:id": {
    url: `/admin/v1/sources/${SOURCE_ID}`,
    payload: { expected_version: 3, name: "iTicket Uzbekistan", reason: "название" },
    status: 200,
    domain: ["sourceRegistry", "PATCH", `/internal/v1/sources/${SOURCE_ID}`],
  },
  "GET /admin/v1/discovery/runs": { url: "/admin/v1/discovery/runs?limit=10", status: 200, domain: ["discovery", "GET", "/internal/v1/runs"] },
  "GET /admin/v1/discovery/runs/:id": { url: `/admin/v1/discovery/runs/${RUN_ID}`, status: 200, domain: ["discovery", "GET", `/internal/v1/runs/${RUN_ID}`] },
  "POST /admin/v1/discovery/runs": {
    url: "/admin/v1/discovery/runs",
    payload: { max_provider_calls: 50 },
    status: 202,
    domain: ["discovery", "POST", "/internal/v1/runs"],
  },
  "GET /admin/v1/discovery/budget": { url: "/admin/v1/discovery/budget", status: 200, domain: ["providerGateway", "GET", "/internal/v1/providers/ai_web/budget"] },
  "PUT /admin/v1/discovery/pause": {
    url: "/admin/v1/discovery/pause",
    payload: { paused: true, reason: "перерасход" },
    status: 200,
    domain: ["providerGateway", "PUT", "/internal/v1/providers/ai_web/pause"],
  },
  // спринт 5: поставщики поездок, снимок предложения
  "GET /admin/v1/travel/providers": { url: "/admin/v1/travel/providers", status: 200, domain: ["providerGateway", "GET", "/internal/v1/providers"] },
  "GET /admin/v1/offers/:offerId": { url: `/admin/v1/offers/${OFFER_ID}`, status: 200, domain: ["offers", "GET", `/internal/v1/offers/${OFFER_ID}`] },
  "POST /admin/v1/travel/providers/:name/probe": {
    url: "/admin/v1/travel/providers/aviasales/probe",
    status: 200,
    domain: ["providerGateway", "POST", "/internal/v1/travel/providers/aviasales:probe"],
  },
  // спринт 6: ленты и модерация новостей (news), статистика слежений (watch)
  "GET /admin/v1/news/sources": { url: "/admin/v1/news/sources?interest=sport.motorsport", status: 200, domain: ["news", "GET", "/internal/v1/news/sources"] },
  "GET /admin/v1/news/sources/:id": { url: `/admin/v1/news/sources/${NEWS_SOURCE_ID}`, status: 200, domain: ["news", "GET", `/internal/v1/news/sources/${NEWS_SOURCE_ID}`] },
  "POST /admin/v1/news/sources": {
    url: "/admin/v1/news/sources",
    headers: { "idempotency-key": "news-src-create-1" },
    payload: {
      slug: "uefa-inside",
      name: "UEFA — Inside UEFA",
      kind: "official",
      mode: "rss",
      feed_url: "https://www.uefa.com/rss/insideuefa/rss.xml",
      page_url: null,
      site_domain: "uefa.com",
      extra_domains: [],
      interests: ["sport.football"],
      entities: ["UEFA"],
      country_code: null,
      lang: "en",
      display: "summary",
      category_filter: null,
      enabled: true,
      reason: "Официальная лента UEFA",
    },
    status: 201,
    domain: ["news", "POST", "/internal/v1/news/sources"],
  },
  "PATCH /admin/v1/news/sources/:id": {
    url: `/admin/v1/news/sources/${NEWS_SOURCE_ID}`,
    payload: { expected_version: 3, display: "title_only", reason: "права издания" },
    status: 200,
    domain: ["news", "PATCH", `/internal/v1/news/sources/${NEWS_SOURCE_ID}`],
  },
  "DELETE /admin/v1/news/sources/:id": {
    url: `/admin/v1/news/sources/${NEWS_SOURCE_ID}`,
    payload: { expected_version: 3, reason: "лента закрыта" },
    status: 204,
    domain: ["news", "DELETE", `/internal/v1/news/sources/${NEWS_SOURCE_ID}`],
  },
  "POST /admin/v1/news/sources/:id/check": {
    url: `/admin/v1/news/sources/${NEWS_SOURCE_ID}/check`,
    status: 200,
    domain: ["news", "POST", `/internal/v1/news/sources/${NEWS_SOURCE_ID}:check`],
  },
  "POST /admin/v1/news/sources/check": {
    url: "/admin/v1/news/sources/check",
    payload: { mode: "rss", feed_url: "https://www.uefa.com/rss/insideuefa/rss.xml", page_url: null, site_domain: "uefa.com", extra_domains: [], category_filter: null },
    status: 200,
    domain: ["news", "POST", "/internal/v1/news/sources:check"],
  },
  "GET /admin/v1/news/items": { url: "/admin/v1/news/items?hidden=false", status: 200, domain: ["news", "GET", "/internal/v1/news/items"] },
  "POST /admin/v1/news/items/:id/hide": {
    url: `/admin/v1/news/items/${NEWS_ID}/hide`,
    payload: { reason: "Не относится к событиям" },
    status: 200,
    domain: ["news", "POST", `/internal/v1/news/items/${NEWS_ID}:hide`],
  },
  "POST /admin/v1/news/items/:id/unhide": {
    url: `/admin/v1/news/items/${NEWS_ID}/unhide`,
    payload: { reason: "Скрыта по ошибке" },
    status: 200,
    domain: ["news", "POST", `/internal/v1/news/items/${NEWS_ID}:unhide`],
  },
  "GET /admin/v1/watches/stats": { url: "/admin/v1/watches/stats", status: 200, domain: ["watch", "GET", "/internal/v1/watches:stats"] },
  // исправление 6.1: лимиты AI
  "GET /admin/v1/discovery/limits": { url: "/admin/v1/discovery/limits", status: 200, domain: ["providerGateway", "GET", "/internal/v1/providers/ai_web/limits"] },
  "PUT /admin/v1/discovery/limits": {
    url: "/admin/v1/discovery/limits",
    payload: { ai_daily_usd: "2.5", news_daily_usd: "0.40", pages_daily: 500, reason: "Сезон фестивалей" },
    status: 200,
    domain: ["providerGateway", "PUT", "/internal/v1/providers/ai_web/limits"],
  },
  "DELETE /admin/v1/discovery/limits": {
    url: "/admin/v1/discovery/limits",
    payload: { reason: "Сезон закончился" },
    status: 200,
    domain: ["providerGateway", "DELETE", "/internal/v1/providers/ai_web/limits"],
  },
  // спринт 7: учёт и стоимость, бюджеты и kill switch, агенты и skills, Test Console, уровни доступа
  "GET /admin/v1/ai/limits": { url: "/admin/v1/ai/limits", status: 200, domain: ["providerGateway", "GET", "/internal/v1/providers/ai_web/limits"] },
  "PUT /admin/v1/ai/limits": {
    url: "/admin/v1/ai/limits",
    payload: { ai_daily_usd: "2.5", news_daily_usd: "0.40", pages_daily: 500, concierge_daily_usd: "1.5", evaluation_daily_usd: "0.30", reason: "Сезон фестивалей" },
    status: 200,
    domain: ["providerGateway", "PUT", "/internal/v1/providers/ai_web/limits"],
  },
  "DELETE /admin/v1/ai/limits": {
    url: "/admin/v1/ai/limits",
    payload: { reason: "Сезон закончился" },
    status: 200,
    domain: ["providerGateway", "DELETE", "/internal/v1/providers/ai_web/limits"],
  },
  "GET /admin/v1/ai/budgets": { url: "/admin/v1/ai/budgets", status: 200, domain: ["aiControl", "GET", "/internal/v1/budgets/overview"] },
  "PUT /admin/v1/ai/agents/:agentId/pause": {
    url: "/admin/v1/ai/agents/concierge/pause",
    payload: { paused: true, reason: "Расход вне плана" },
    status: 200,
    domain: ["providerGateway", "PUT", "/internal/v1/providers/ai/agents/concierge/pause"],
  },
  "PUT /admin/v1/ai/providers/anthropic/pause": {
    url: "/admin/v1/ai/providers/anthropic/pause",
    payload: { paused: false, reason: "Инцидент закрыт" },
    status: 200,
    domain: ["providerGateway", "PUT", "/internal/v1/providers/ai/provider/anthropic/pause"],
  },
  "GET /admin/v1/ai/agents": { url: "/admin/v1/ai/agents", status: 200, domain: ["aiControl", "GET", "/internal/v1/agents"] },
  "GET /admin/v1/ai/agents/:agentId": { url: "/admin/v1/ai/agents/concierge", status: 200, domain: ["aiControl", "GET", "/internal/v1/agents/concierge"] },
  "PATCH /admin/v1/ai/agents/:agentId": {
    url: "/admin/v1/ai/agents/concierge",
    payload: { degrade_at_pct: 85, reason: "Раньше на Haiku", expected_version: 4 },
    headers: { "idempotency-key": "matrix-agent-0001" },
    status: 200,
    domain: ["aiControl", "PATCH", "/internal/v1/agents/concierge"],
  },
  "GET /admin/v1/ai/alerts": { url: "/admin/v1/ai/alerts?unacked=true", status: 200, domain: ["aiControl", "GET", "/internal/v1/budgets/alerts"] },
  "POST /admin/v1/ai/alerts/:ref": {
    url: `/admin/v1/ai/alerts/${ALERT_ID}:ack`,
    status: 200,
    domain: ["aiControl", "POST", `/internal/v1/budgets/alerts/${ALERT_ID}:ack`],
  },
  "GET /admin/v1/ai/pricing/versions": { url: "/admin/v1/ai/pricing/versions", status: 200, domain: ["aiControl", "GET", "/internal/v1/pricing/versions"] },
  "GET /admin/v1/ai/pricing/versions/:version": {
    url: "/admin/v1/ai/pricing/versions/2026-10-12",
    status: 200,
    domain: ["aiControl", "GET", "/internal/v1/pricing/versions/2026-10-12"],
  },
  "POST /admin/v1/ai/pricing/versions": {
    url: "/admin/v1/ai/pricing/versions",
    payload: { based_on: "2026-10-12", note: "Sonnet" },
    headers: { "idempotency-key": "matrix-price-0001" },
    status: 201,
    domain: ["aiControl", "POST", "/internal/v1/pricing/versions"],
  },
  "PATCH /admin/v1/ai/pricing/versions/:version": {
    url: "/admin/v1/ai/pricing/versions/2026-10-12",
    payload: { note: "Сверено", expected_version: 1 },
    headers: { "idempotency-key": "matrix-price-0002" },
    status: 200,
    domain: ["aiControl", "PATCH", "/internal/v1/pricing/versions/2026-10-12"],
  },
  "POST /admin/v1/ai/pricing/versions/:ref": {
    url: "/admin/v1/ai/pricing/versions/2026-10-12:activate",
    payload: { reason: "Сверено с прайсом", expected_version: 1 },
    headers: { "idempotency-key": "matrix-price-0003" },
    status: 200,
    domain: ["aiControl", "POST", "/internal/v1/pricing/versions/2026-10-12:activate"],
  },
  "GET /admin/v1/ai/access-levels": { url: "/admin/v1/ai/access-levels", status: 200, domain: ["aiControl", "GET", "/internal/v1/access/levels"] },
  "PUT /admin/v1/ai/access-levels/:code": {
    url: "/admin/v1/ai/access-levels/plus",
    payload: { name_ru: "Расширенный", name_en: "Plus", concierge_messages_per_day: 25, reason: "Больше сообщений", expected_version: 1 },
    headers: { "idempotency-key": "matrix-level-0001" },
    status: 200,
    domain: ["aiControl", "PUT", "/internal/v1/access/levels/plus"],
  },
  "DELETE /admin/v1/ai/access-levels/:code": {
    url: "/admin/v1/ai/access-levels/plus",
    payload: { reason: "Не нужен" },
    headers: { "idempotency-key": "matrix-level-0002" },
    status: 200,
    domain: ["aiControl", "DELETE", "/internal/v1/access/levels/plus"],
  },
  "GET /admin/v1/users/:id/access-level": {
    url: `/admin/v1/users/${USER_ID}/access-level`,
    status: 200,
    domain: ["aiControl", "GET", `/internal/v1/access/users/${USER_ID}`],
  },
  "PUT /admin/v1/users/:id/access-level": {
    url: `/admin/v1/users/${USER_ID}/access-level`,
    payload: { level: "plus", reason: "Партнёр", expires_at: "2027-01-01T00:00:00Z" },
    headers: { "idempotency-key": "matrix-access-0001" },
    status: 200,
    domain: ["aiControl", "PUT", `/internal/v1/access/users/${USER_ID}`],
  },
  "DELETE /admin/v1/users/:id/access-level": {
    url: `/admin/v1/users/${USER_ID}/access-level`,
    payload: { reason: "Срок истёк", expected_version: 1 },
    headers: { "idempotency-key": "matrix-access-0002" },
    status: 200,
    domain: ["aiControl", "DELETE", `/internal/v1/access/users/${USER_ID}`],
  },
  "GET /admin/v1/usage/kpi": { url: "/admin/v1/usage/kpi?period=7d", status: 200, domain: ["aiControl", "GET", "/internal/v1/usage/kpi"] },
  "GET /admin/v1/usage/agents": { url: "/admin/v1/usage/agents?period=today", status: 200, domain: ["aiControl", "GET", "/internal/v1/usage/agents"] },
  "GET /admin/v1/usage/requests": { url: "/admin/v1/usage/requests?agent=concierge&status=SUCCESS", status: 200, domain: ["aiControl", "GET", "/internal/v1/usage/requests"] },
  "GET /admin/v1/usage/requests/:requestId": {
    url: `/admin/v1/usage/requests/${REQUEST_ID}`,
    status: 200,
    domain: ["aiControl", "GET", `/internal/v1/usage/requests/${REQUEST_ID}`],
  },
  "POST /admin/v1/usage/requests/:requestId/content::reveal": {
    url: `/admin/v1/usage/requests/${REQUEST_ID}/content:reveal`,
    payload: { reason: "Жалоба пользователя TCK-3081" },
    status: 200,
    domain: ["aiConcierge", "POST", `/internal/v1/admin/requests/${REQUEST_ID}/content:reveal`],
  },
  "GET /admin/v1/skills": { url: "/admin/v1/skills", status: 200, domain: ["aiControl", "GET", "/internal/v1/skills"] },
  "GET /admin/v1/skills/:skillId": { url: "/admin/v1/skills/concierge.event", status: 200, domain: ["aiControl", "GET", "/internal/v1/skills/concierge.event"] },
  "GET /admin/v1/skills/:skillId/versions/:v": {
    url: "/admin/v1/skills/concierge.event/versions/2",
    status: 200,
    domain: ["aiControl", "GET", "/internal/v1/skills/concierge.event/versions/2"],
  },
  "GET /admin/v1/skills/:skillId/compare": {
    url: "/admin/v1/skills/concierge.event/compare?a=1&b=2",
    status: 200,
    domain: ["aiControl", "GET", "/internal/v1/skills/concierge.event/compare"],
  },
  "POST /admin/v1/skills/:skillId/versions": {
    url: "/admin/v1/skills/concierge.event/versions",
    payload: { from_version: 1 },
    headers: { "idempotency-key": "matrix-skill-0001" },
    status: 201,
    domain: ["aiControl", "POST", "/internal/v1/skills/concierge.event/versions"],
  },
  "PATCH /admin/v1/skills/:skillId/versions/:v": {
    url: "/admin/v1/skills/concierge.event/versions/2",
    payload: { change_note: "Короче", expected_version: 1 },
    headers: { "idempotency-key": "matrix-skill-0002" },
    status: 200,
    domain: ["aiControl", "PATCH", "/internal/v1/skills/concierge.event/versions/2"],
  },
  "POST /admin/v1/skills/:skillId/versions/:v/test": {
    url: "/admin/v1/skills/concierge.event/versions/2/test",
    payload: { compare_version: 1 },
    headers: { "idempotency-key": "matrix-skill-0003" },
    status: 202,
    domain: ["aiControl", "POST", "/internal/v1/skills/concierge.event/versions/2/test"],
  },
  "POST /admin/v1/skills/:skillId/versions/:v/review": {
    url: "/admin/v1/skills/concierge.event/versions/2/review",
    payload: { action: "request" },
    headers: { "idempotency-key": "matrix-skill-0004" },
    status: 200,
    domain: ["aiControl", "POST", "/internal/v1/skills/concierge.event/versions/2/review"],
  },
  "POST /admin/v1/skills/:skillId/versions/:v/publish": {
    url: "/admin/v1/skills/concierge.event/versions/2/publish",
    payload: { reason: "Ревью пройдено" },
    headers: { "idempotency-key": "matrix-skill-0005" },
    status: 200,
    domain: ["aiControl", "POST", "/internal/v1/skills/concierge.event/versions/2/publish"],
  },
  "POST /admin/v1/skills/:skillId/rollback": {
    url: "/admin/v1/skills/concierge.event/rollback",
    payload: { to_version: 1, reason: "Жалобы на ответы" },
    headers: { "idempotency-key": "matrix-skill-0006" },
    status: 200,
    domain: ["aiControl", "POST", "/internal/v1/skills/concierge.event/rollback"],
  },
  "POST /admin/v1/skills/:skillId/versions/:v/deprecate": {
    url: "/admin/v1/skills/concierge.event/versions/2/deprecate",
    payload: { reason: "Не нужна" },
    headers: { "idempotency-key": "matrix-skill-0007" },
    status: 200,
    domain: ["aiControl", "POST", "/internal/v1/skills/concierge.event/versions/2/deprecate"],
  },
  "GET /admin/v1/evaluation/runs/:runId": { url: `/admin/v1/evaluation/runs/${RUN_ID7}`, status: 200, domain: ["aiControl", "GET", `/internal/v1/evaluation/runs/${RUN_ID7}`] },
  "GET /admin/v1/evaluation/cases": { url: "/admin/v1/evaluation/cases?skill_id=concierge.event", status: 200, domain: ["aiControl", "GET", "/internal/v1/evaluation/cases"] },
  "POST /admin/v1/evaluation/cases": {
    url: "/admin/v1/evaluation/cases",
    payload: { skill_id: "concierge.event", name: "direct_only_text2", input: { mode: "event", text: "Прямой" } },
    headers: { "idempotency-key": "matrix-case-0001" },
    status: 201,
    domain: ["aiControl", "POST", "/internal/v1/evaluation/cases"],
  },
  "PATCH /admin/v1/evaluation/cases/:caseId": {
    url: `/admin/v1/evaluation/cases/${CASE_ID}`,
    payload: { enabled: false, expected_version: 1 },
    headers: { "idempotency-key": "matrix-case-0002" },
    status: 200,
    domain: ["aiControl", "PATCH", `/internal/v1/evaluation/cases/${CASE_ID}`],
  },
  "DELETE /admin/v1/evaluation/cases/:caseId": {
    url: `/admin/v1/evaluation/cases/${CASE_ID}?reason=Дубль`,
    headers: { "idempotency-key": "matrix-case-0003" },
    status: 200,
    domain: ["aiControl", "DELETE", `/internal/v1/evaluation/cases/${CASE_ID}`],
  },
  // последним: завершает сессию
  "POST /admin/v1/auth/logout": { url: "/admin/v1/auth/logout", status: 204, domain: ["adminIdentity", "POST", "/internal/v1/auth/logout"] },
};

let h: Harness;
beforeEach(async () => {
  violations.length = 0;
  // матрица всех маршрутов одним сотрудником — больше 60 команд в минуту (adm.command): лимитер выключен (спринт 9)
  h = await makeHarness({ ENV: "dev", NODE_ENV: "development", RATE_LIMITS_ENABLED: "false" }, { responseProbe: probe });
  const f = h.fake;
  f.on("support", "PUT", "/admin/v1/support/sla-policies", (c) => json(200, { items: c.body.items, category_defaults: {} }));
  f.on("audit", "GET", `/admin/v1/audit/records/${RECORD_ID}`, () => json(200, auditRow({ record_id: RECORD_ID })));
  f.on("experience", "GET", "/internal/v1/experience/admin/current", () => json(200, { app: "admin", version: "1.0.0" }));
  f.on("experience", "GET", "/internal/v1/experience/miniapp/current", () => json(200, { app: "miniapp", version: "2.0.3" }));
  f.on("experience", "GET", "/admin/v1/experience/admin/versions", () => json(200, { items: [versionRow()], next_cursor: null }));
  f.on("experience", "GET", "/admin/v1/experience/admin/versions/1.0.0", () => json(200, versionRow({ payload: { theme: {} } })));
  f.on("experience", "GET", "/admin/v1/experience/admin/activations", () => json(200, { items: [activationRow()], next_cursor: null }));
  f.on("experience", "POST", "/admin/v1/experience/admin/versions", (c) =>
    json(201, versionRow({ version: c.body.version, change_note: c.body.change_note, status: null, payload: c.body.payload })),
  );
  f.on("experience", "POST", "/admin/v1/experience/admin/rollback", () => json(201, activationRow({ kind: "rollback", previous_version: "1.0.1" })));
  f.on("audit", "GET", "/admin/v1/audit/records", () => json(200, { items: [auditRow()], next_cursor: null }));
  f.on("adminIdentity", "GET", "/admin/v1/staff", () => json(200, { items: [staffRow()], next_cursor: null }));
  f.on("adminIdentity", "GET", "/admin/v1/approvals", () => json(200, { items: [approvalRow()], next_cursor: null }));
  fakeSprint4(f);
  fakeSprint5(f);
  fakeSprint6(f);
  fakeLimits(f);
  fakeSprint7(f);
  fakeSprint8(f);
  fakeSprint9(f);
  fakeReleaseNotes(f);
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const SPRINT4_SERVICES = { events: 1, sourceRegistry: 1, discovery: 1, providerGateway: 1, offers: 1, news: 1, watch: 1, aiControl: 1, aiConcierge: 1, opsMonitor: 1 };
const sessionRoutes = () => h.app.adminRoutes.filter((r) => r.access === "session");
const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

describe("матрица маршрутов", () => {
  it("матрица покрывает все сессионные маршруты (и только их)", () => {
    expect(sessionRoutes().map(key).sort()).toEqual(Object.keys(CASES).sort());
  });

  it("без нужного права → 403 PERMISSION_DENIED {permission}, домен не вызывается", async () => {
    const { s } = await loginAs(h, "read_only", { permissions: [] });
    const before = h.fake.calls.length;
    const guarded = sessionRoutes().filter((r) => r.guard !== "authenticated");
    expect(guarded.length).toBeGreaterThanOrEqual(52);
    for (const r of guarded) {
      const c = CASES[key(r)]!;
      const res = await h.app.inject({
        method: r.method as "GET",
        url: c.url,
        headers: browser(s, c.headers),
        ...(c.payload !== undefined ? { payload: c.payload as object } : {}),
      });
      expect(res.statusCode, key(r)).toBe(403);
      expect(res.json(), key(r)).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: r.guard } });
    }
    expect(h.fake.calls.length).toBe(before);
  });

  it("право есть, step-up нет → 403 STEP_UP_REQUIRED, домен не вызывается", async () => {
    const { s } = await loginAs(h, "super_admin");
    const before = h.fake.calls.length;
    const stepUp = sessionRoutes().filter((r) => r.stepUp);
    expect(stepUp).toHaveLength(27);
    for (const r of stepUp) {
      const c = CASES[key(r)]!;
      const res = await h.app.inject({
        method: r.method as "GET",
        url: c.url,
        headers: browser(s, c.headers),
        ...(c.payload !== undefined ? { payload: c.payload as object } : {}),
      });
      expect(res.statusCode, key(r)).toBe(403);
      expect(res.json().code, key(r)).toBe("STEP_UP_REQUIRED");
    }
    expect(h.fake.calls.length).toBe(before);
  });

  it("happy path каждого маршрута: статус, вызов домена с actor сотрудника", async () => {
    const { staff, s } = await loginAs(h, "super_admin");
    expect((await stepUp(h, s)).statusCode).toBe(200);
    const order = Object.keys(CASES); // logout — последним
    for (const k of order) {
      const c = CASES[k]!;
      const method = k.split(" ")[0]!;
      const before = h.fake.calls.length;
      const res = await h.app.inject({
        method: method as "GET",
        url: c.url,
        headers: browser(s, c.headers),
        ...(c.payload !== undefined ? { payload: c.payload as object } : {}),
      });
      expect(res.statusCode, `${k}: ${res.body.slice(0, 200)}`).toBe(c.status);
      if (k === "POST /admin/v1/auth/step-up") s.id = cookieOf(res.headers["set-cookie"]); // step-up ротирует id
      expect(violations, k).toEqual([]);
      if (res.statusCode >= 400) expect(Object.keys(res.json()).sort(), k).toEqual(["code", "details", "message", "trace_id"]);
      const made = h.fake.calls.slice(before);
      if (c.domain) {
        const [service, m, path] = c.domain;
        const hit = made.find((x) => x.service === service && x.method === m && x.path === path);
        expect(hit, `${k} → ${service} ${m} ${path}`).toBeDefined();
        // staff API доменов — только с actor; внутренние вызовы (вход, текущий конфиг) — без него
        // спринт 4: очередь, реестр, запуски, бюджет — /internal/v1/* доменов, но с actor (домены проверяют права)
        const actorRequired = path.startsWith("/admin/v1/") || path === "/internal/v1/records" || service in SPRINT4_SERVICES;
        if (actorRequired) expect(hit!.actor?.id, k).toBe(staff.staff_id);
      }
      for (const x of made.filter((y) => y.path.startsWith("/admin/v1/"))) expect(x.actor?.id, `${k} → ${x.path}`).toBe(staff.staff_id);
    }
    // после logout сессии нет
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(401);
  });
});

describe("ответы фильтруются по контракту (T2)", () => {
  it("служебные поля доменов не доходят до admin-web", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const SECRET = "leak-marker-7f3a";
    const staffRow = {
      staff_id: STAFF_ID,
      email: "a@tilhero.test",
      display_name: "А",
      role: "support",
      status: "ACTIVE",
      auth_provider: "local",
      mfa_enabled: true,
      must_change_password: false,
      last_login_at: null,
      created_at: "2026-10-01T00:00:00Z",
      created_by: null,
      password_hash: SECRET,
      mfa_secret_enc: SECRET,
      session_version: 7,
    };
    h.fake.on("adminIdentity", "GET", "/admin/v1/staff", () => json(200, { items: [staffRow], next_cursor: null, total_internal: SECRET }));
    h.fake.on("adminIdentity", "PATCH", `/admin/v1/staff/${STAFF_ID}`, () =>
      json(202, { approval: { approval_id: APPROVAL_ID, kind: "staff.role_grant", status: "PENDING", payload: { secret: SECRET }, summary: { role: "operations" } } }),
    );
    h.fake.on("support", "GET", `/admin/v1/support/tickets/${TICKET_ID}/client-view`, () =>
      json(200, { ticket_id: TICKET_ID, number: "TCK-1", user_id: SECRET, assignee_id: SECRET, messages: [{ message_id: "m1", text: "Привет", visibility: SECRET, author_id: SECRET }] }),
    );
    h.fake.on("experience", "GET", "/admin/v1/experience/admin/versions", () =>
      json(200, { items: [{ version_id: "v", version: "1.0.0", payload: { secret: SECRET } }], next_cursor: null }),
    );
    h.fake.on("audit", "GET", "/admin/v1/audit/records", () => json(200, { items: [{ seq: 1, record_id: RECORD_ID, before: { a: 1 }, internal_hmac_key: SECRET }], next_cursor: null }));

    const list = await h.app.inject({ url: "/admin/v1/staff", headers: browser(s) });
    expect(list.json()).toEqual({ items: [Object.fromEntries(Object.entries(staffRow).filter(([k]) => !["password_hash", "mfa_secret_enc", "session_version"].includes(k)))], next_cursor: null });

    const patch = await h.app.inject({ method: "PATCH", url: `/admin/v1/staff/${STAFF_ID}`, headers: browser(s), payload: { role: "operations", reason: "повышение" } });
    expect(patch.statusCode).toBe(202);
    expect(patch.json().approval).toMatchObject({ approval_id: APPROVAL_ID, summary: { role: "operations" } });

    const cv = await h.app.inject({ url: `/admin/v1/support/tickets/${TICKET_ID}/client-view`, headers: browser(s) });
    expect(cv.json()).toEqual({ ticket_id: TICKET_ID, number: "TCK-1", messages: [{ message_id: "m1", text: "Привет" }] });

    const vers = await h.app.inject({ url: "/admin/v1/experience/admin/versions", headers: browser(s) });
    expect(vers.json()).toEqual({ items: [{ version_id: "v", version: "1.0.0" }], next_cursor: null });

    const audit = await h.app.inject({ url: "/admin/v1/audit/records", headers: browser(s) });
    expect(audit.json().items[0]).toEqual({ seq: 1, record_id: RECORD_ID, before: { a: 1 } });

    for (const r of [list, patch, cv, vers, audit]) expect(r.body).not.toContain(SECRET);
  });

  it("карточка пользователя: полного Telegram ID и лишних полей нет", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("userAdmin", "GET", `/admin/v1/users/${USER_ID}`, () =>
      json(200, { user_id: USER_ID, telegram_id_masked: "••••••789", telegram_user_id: "777000123456789", refreshed_at: "2026-10-09T10:00:00Z" }),
    );
    const res = await h.app.inject({ url: `/admin/v1/users/${USER_ID}`, headers: browser(s) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("777000123456789");
    expect(res.json()).toMatchObject({ user_id: USER_ID, telegram_id_masked: "••••••789", ai_conversations: [{ conversation_id: expect.any(String), turns_count: 3 }] });
  });
});

describe("строгая проверка контракта (Ajv поверх схем ответа)", () => {
  it("null вместо обязательного значения и пропущенное поле ловятся, хотя сериализатор отдал бы \"\"", async () => {
    const { s } = await loginAs(h, "super_admin");
    const broken = { ...staffRow({ email: null }) } as Record<string, unknown>;
    delete broken.created_at;
    h.fake.on("adminIdentity", "GET", "/admin/v1/staff", () => json(200, { items: [broken], next_cursor: null }));
    const res = await h.app.inject({ url: "/admin/v1/staff", headers: browser(s) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].email).toBe(""); // так fast-json-stringify «чинит» null — молча
    expect(violations.join("\n")).toMatch(/GET \/admin\/v1\/staff 200: .*email must be string/);
    expect(violations.join("\n")).toMatch(/must have required property 'created_at'/);
  });

  it("необязательные поля контракта (?:) не требуются: ConfigVersion без payload, SLA без updated_at", async () => {
    const { s } = await loginAs(h, "super_admin");
    expect((await h.app.inject({ url: "/admin/v1/experience/admin/versions", headers: browser(s) })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/admin/v1/support/sla-policies", headers: browser(s) })).statusCode).toBe(200);
    expect(violations).toEqual([]);
  });
});

describe("временный пароль: reset-password / approve staff.privileged_reset", () => {
  const TMP = "Tmp-Approve-Secret-91xQ";

  it("approve privileged_reset → ApprovalDecision с temporary_password, no-store, не в логах; без пароля — поле опущено", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const target = h.fake.addStaff({ role: "operations" });
    const summary = { staff: { staff_id: target.staff_id, email: target.email, display_name: target.display_name }, action: "password", role: "operations" };
    h.fake.on("adminIdentity", "POST", `/admin/v1/approvals/${APPROVAL_ID}/approve`, () =>
      json(200, { ...approvalRow({ approval_id: APPROVAL_ID, kind: "staff.privileged_reset", status: "APPLIED", summary }), temporary_password: TMP }),
    );
    // principal цели в кэше (наполнен при её входе) — после применения заявки он сбрасывается сразу
    await login(h, target);
    const cacheKey = `${h.config.redisKeyPrefix}principal:${target.staff_id}`;
    expect(await redis().exists(cacheKey)).toBe(1);

    const res = await h.app.inject({ method: "POST", url: `/admin/v1/approvals/${APPROVAL_ID}/approve`, headers: browser(s), payload: { note: "ок" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ approval_id: APPROVAL_ID, kind: "staff.privileged_reset", status: "APPLIED", temporary_password: TMP });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(await redis().exists(cacheKey)).toBe(0);
    expect(violations).toEqual([]);

    // reject (и approve других видов): домен отдаёт temporary_password: null — в ответе поля нет
    const rej = await h.app.inject({ method: "POST", url: `/admin/v1/approvals/${RECORD_ID}/reject`, headers: browser(s), payload: {} });
    expect(rej.statusCode).toBe(200);
    expect("temporary_password" in rej.json()).toBe(false);
    expect(violations).toEqual([]);

    expect(h.logs.text).not.toContain(TMP);
  });

  it("reset-password: 200 {temporary_password} (no-store) или 202 {approval}; reset-mfa: 200 Staff или 202 {approval}", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const plain = await h.app.inject({ method: "POST", url: `/admin/v1/staff/${STAFF_ID}/reset-password`, headers: browser(s), payload: { reason: "забыл" } });
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).toEqual({ temporary_password: "Tmp-Secret-Passw0rd-XYZ" });
    expect(plain.headers["cache-control"]).toBe("no-store");

    for (const action of ["reset-password", "reset-mfa"] as const) {
      h.fake.on("adminIdentity", "POST", `/admin/v1/staff/${STAFF_ID}/${action}`, () =>
        json(202, { approval: approvalRow({ kind: "staff.privileged_reset", summary: { action: action === "reset-mfa" ? "mfa" : "password" } }) }),
      );
      const res = await h.app.inject({ method: "POST", url: `/admin/v1/staff/${STAFF_ID}/${action}`, headers: browser(s), payload: { reason: "four-eyes" } });
      expect(res.statusCode, action).toBe(202);
      expect(res.json().approval).toMatchObject({ kind: "staff.privileged_reset", status: "PENDING" });
      expect(res.json().temporary_password).toBeUndefined();
    }
    expect(violations).toEqual([]);
    expect(h.logs.text).not.toContain("Tmp-Secret-Passw0rd-XYZ");
  });
});

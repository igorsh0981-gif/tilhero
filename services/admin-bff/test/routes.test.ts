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
  BLOB_ID,
  CAMPAIGN_ID,
  MP3_BYTES,
  PAYLOAD_HASH,
  REQUEST_ID,
  LEARNER_ID,
  APPEAL_ID,
  EVALUATION_ID,
  EVALUATION_ID_2,
  RUN_ID,
  SESSION_ID,
  GOLDEN_INPUT,
  REEVALUATION_BODY,
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
  languageRow,
  pairCard,
  CARD_ID,
  GLOSSARY_ENTRY_ID,
  LEARNER_USER_ID,
  ASSET_ID,
  GAME_EVENT_ID,
  OP_ID,
  PURCHASE_ID,
  PNG_BYTES,
  gameRulesPayload,
  CASE_ID,
  DUEL_ID,
  GROUP_ID,
  REFERRAL_ID,
  ROOM_ID,
  SANCTION_APPEAL_ID,
  SANCTION_ID,
  TARGET_USER_ID,
  WEEK,
  campaignPayload,
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
const AG = "/admin/v1/ai/agents/conversation_partner";

const IK = (k: string) => ({ "idempotency-key": `matrix-${k}-0001` });

const GM = "/admin/v1/game";
const GI = "/internal/v1/admin/game";
const IA = "/internal/v1/admin";
const L = (ru: string, uz: string) => ({ ru, uz });
const HERO_DRAFT_BODY = {
  name: L("Дракончик Мятик", "Ajdarcha Yalpiz"),
  tagline: L("Растёт вместе с тобой", "Sen bilan o'sadi"),
  audiences: ["kids", "teens", "adults"],
  stages: [
    { stage: 1, name: L("Яйцо", "Tuxum"), asset_id: ASSET_ID },
    { stage: 2, name: L("Малыш", "Chaqaloq"), asset_id: ASSET_ID },
    { stage: 3, name: L("Крылья", "Qanotlar"), asset_id: ASSET_ID },
  ],
};
const SHOP_ITEM_BODY = {
  code: "bg_sunset",
  kind: "background",
  title: L("Закат", "Quyosh botishi"),
  description: L("Тёплый фон главной", "Iliq fon"),
  asset_id: ASSET_ID,
  theme: { bg: "--paper", accent: "--pen" },
  price_til: 120,
  audiences: ["kids", "teens", "adults"],
  available_from: null,
  available_until: "2026-12-31T23:59:59+05:00",
  order: 1,
};
const GAME_EVENT_BODY = {
  code: "reading_week",
  title: L("Неделя чтения", "O'qish haftaligi"),
  description: L("×2 XP за чтение", "O'qish uchun ×2 XP"),
  starts_at: "2026-11-23T00:00:00+05:00",
  ends_at: "2026-11-30T00:00:00+05:00",
  audiences: ["teens", "adults"],
  multipliers: [{ action: "reading", currency: "xp", factor: 2 }],
};

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
  // ---------- контент (catalog)
  "GET /admin/v1/content/:kind": {
    url: "/admin/v1/content/lesson?q=greet&status=draft&level=A1&limit=20",
    status: 200,
    domain: ["catalog", "GET", "/admin/v1/content/lesson"],
  },
  "GET /admin/v1/content/:kind/:key": { url: "/admin/v1/content/skill/en.func.greet", status: 200, domain: ["catalog", "GET", "/admin/v1/content/skill/en.func.greet"] },
  "GET /admin/v1/content/:kind/:key/versions/:v": {
    url: "/admin/v1/content/lesson/l-a1-01-greetings/versions/2",
    status: 200,
    domain: ["catalog", "GET", "/admin/v1/content/lesson/l-a1-01-greetings/versions/2"],
  },
  "POST /admin/v1/content/:kind": {
    url: "/admin/v1/content/rubric",
    payload: { payload: { rubric_id: "r-dialogue", title: { ru: "Диалог", uz: "Dialog" }, criteria: [] } },
    headers: IK("content"),
    status: 201,
    domain: ["catalog", "POST", "/admin/v1/content/rubric"],
  },
  "POST /admin/v1/content/:kind/:key/versions": {
    url: "/admin/v1/content/lesson/l-a1-01-greetings/versions",
    payload: { from_version: 1 },
    status: 201,
    domain: ["catalog", "POST", "/admin/v1/content/lesson/l-a1-01-greetings/versions"],
  },
  "PUT /admin/v1/content/:kind/:key/versions/:v": {
    url: "/admin/v1/content/lesson/l-a1-01-greetings/versions/2",
    payload: { payload: { lesson_id: "l-a1-01-greetings" }, expected_hash: PAYLOAD_HASH },
    status: 200,
    domain: ["catalog", "PUT", "/admin/v1/content/lesson/l-a1-01-greetings/versions/2"],
  },
  "POST /admin/v1/content/:kind/:key/versions/:v/validate": {
    url: "/admin/v1/content/media_asset/m-own-coffee-order/versions/1/validate",
    status: 200,
    domain: ["catalog", "POST", "/admin/v1/content/media_asset/m-own-coffee-order/versions/1/validate"],
  },
  // вид scenario в пути: маршрутизатор возвращается от статического «scenario/…/test-run» к общему /:kind
  "POST /admin/v1/content/:kind/:key/versions/:v/submit": {
    url: "/admin/v1/content/scenario/sc-travel-hotel-checkin/versions/2/submit",
    status: 200,
    domain: ["catalog", "POST", "/admin/v1/content/scenario/sc-travel-hotel-checkin/versions/2/submit"],
  },
  "POST /admin/v1/content/:kind/:key/versions/:v/review": {
    url: "/admin/v1/content/lesson/l-a1-01-greetings/versions/2/review",
    payload: { decision: "approve", note: "Проверено", locale_checks: { ru: "checked", uz: "checked" } },
    status: 200,
    domain: ["catalog", "POST", "/admin/v1/content/lesson/l-a1-01-greetings/versions/2/review"],
  },
  "POST /admin/v1/content/:kind/:key/versions/:v/publish": {
    url: "/admin/v1/content/media_asset/m-own-coffee-order/versions/2/publish",
    payload: { reason: "права подтверждены" },
    headers: IK("cpub"),
    status: 200,
    domain: ["catalog", "POST", "/admin/v1/content/media_asset/m-own-coffee-order/versions/2/publish"],
  },
  "POST /admin/v1/content/:kind/:key/archive": {
    url: "/admin/v1/content/scenario/sc-travel-hotel-checkin/archive",
    payload: { reason: "устарел" },
    status: 200,
    domain: ["catalog", "POST", "/admin/v1/content/scenario/sc-travel-hotel-checkin/archive"],
  },
  "POST /admin/v1/content/:kind/:key/rollback": {
    url: "/admin/v1/content/lesson/l-a1-01-greetings/rollback",
    payload: { to_version: 1, reason: "ошибка в версии 2" },
    status: 200,
    domain: ["catalog", "POST", "/admin/v1/content/lesson/l-a1-01-greetings/rollback"],
  },
  "POST /admin/v1/content/scenario/:key/versions/:v/test-run": {
    url: "/admin/v1/content/scenario/sc-travel-hotel-checkin/versions/2/test-run",
    status: 200,
    domain: ["catalog", "POST", "/admin/v1/content/scenario/sc-travel-hotel-checkin/versions/2/test-run"],
  },
  "POST /admin/v1/content/media_asset/:key/versions/:v/rights-approve": {
    url: "/admin/v1/content/media_asset/m-own-coffee-order/versions/2/rights-approve",
    payload: { note: "Своя запись TilHero" },
    status: 200,
    domain: ["catalog", "POST", "/admin/v1/content/media_asset/m-own-coffee-order/versions/2/rights-approve"],
  },
  "POST /admin/v1/content/blobs": {
    url: "/admin/v1/content/blobs",
    payload: { filename: "coffee.mp3", content_type: "audio/mpeg", data_base64: MP3_BYTES.toString("base64") },
    status: 201,
    domain: ["catalog", "POST", "/admin/v1/content/blobs"],
  },
  "GET /admin/v1/content/blobs/:blobId": { url: `/admin/v1/content/blobs/${BLOB_ID}`, status: 200, domain: ["catalog", "GET", `/admin/v1/content/blobs/${BLOB_ID}`] },
  "GET /admin/v1/content/review-queue": { url: "/admin/v1/content/review-queue?kind=lesson&limit=10", status: 200, domain: ["catalog", "GET", "/admin/v1/content/review-queue"] },
  "GET /admin/v1/content/summary": { url: "/admin/v1/content/summary", status: 200, domain: ["catalog", "GET", "/admin/v1/content/summary"] },
  "GET /admin/v1/content/media-requests": {
    url: "/admin/v1/content/media-requests?status=new&q=imagine",
    status: 200,
    domain: ["catalog", "GET", "/admin/v1/content/media-requests"],
  },
  "POST /admin/v1/content/media-requests/:id/take": {
    url: `/admin/v1/content/media-requests/${REQUEST_ID}/take`,
    status: 200,
    domain: ["catalog", "POST", `/admin/v1/content/media-requests/${REQUEST_ID}/take`],
  },
  "POST /admin/v1/content/media-requests/:id/decide": {
    url: `/admin/v1/content/media-requests/${REQUEST_ID}/decide`,
    payload: { status: "authored_alternative", note: "Подобрали авторскую сценку", linked_asset_id: "m-own-coffee-order" },
    headers: IK("decide"),
    status: 200,
    domain: ["catalog", "POST", `/admin/v1/content/media-requests/${REQUEST_ID}/decide`],
  },
  // ---------- языки и пары (catalog + diagnostics)
  "GET /admin/v1/languages": { url: "/admin/v1/languages", status: 200, domain: ["catalog", "GET", "/admin/v1/languages"] },
  "PUT /admin/v1/languages/:code": {
    url: "/admin/v1/languages/kk",
    payload: languageRow({ code: "kk", status: "planned", tts: null, name: { ru: "Казахский", uz: "Qozoq tili", en: "Kazakh" } }),
    status: 200,
    domain: ["catalog", "PUT", "/admin/v1/languages/kk"],
  },
  "GET /admin/v1/language-pairs": { url: "/admin/v1/language-pairs", status: 200, domain: ["catalog", "GET", "/admin/v1/language-pairs"] },
  "PUT /admin/v1/language-pairs/:pairId": {
    url: "/admin/v1/language-pairs/ru-kk",
    payload: (() => {
      const { readiness: _r, learners: _l, updated_by: _u, ...pair } = pairCard({ pair_id: "ru-kk", target: "kk", status: "development", course_id: null });
      return { ...pair, reason: "начинаем курс" };
    })(),
    status: 200,
    domain: ["catalog", "PUT", "/admin/v1/language-pairs/ru-kk"],
  },
  // ---------- диагностика (diagnostics)
  "GET /admin/v1/diagnostics/tests": { url: "/admin/v1/diagnostics/tests", status: 200, domain: ["diagnostics", "GET", "/admin/v1/diagnostics/tests"] },
  "GET /admin/v1/diagnostics/tests/:id/versions/:v": {
    url: "/admin/v1/diagnostics/tests/dx-en-adult/versions/1",
    status: 200,
    domain: ["diagnostics", "GET", "/admin/v1/diagnostics/tests/dx-en-adult/versions/1"],
  },
  "POST /admin/v1/diagnostics/tests/:id/versions/:v/publish": {
    url: "/admin/v1/diagnostics/tests/dx-en-kids/versions/2/publish",
    payload: { reason: "новые задания на аудирование" },
    status: 200,
    domain: ["diagnostics", "POST", "/admin/v1/diagnostics/tests/dx-en-kids/versions/2/publish"],
  },
  "GET /admin/v1/diagnostics/stats": { url: "/admin/v1/diagnostics/stats?period=7d", status: 200, domain: ["diagnostics", "GET", "/admin/v1/diagnostics/stats"] },
  // ---------- агенты и скиллы (ai-gateway)
  "GET /admin/v1/ai/agents": { url: "/admin/v1/ai/agents", status: 200, domain: ["aiGateway", "GET", "/admin/v1/ai/agents"] },
  "GET /admin/v1/ai/agents/:agentId": { url: `${AG}`, status: 200, domain: ["aiGateway", "GET", AG] },
  "GET /admin/v1/ai/agents/:agentId/versions/:v": { url: `${AG}/versions/1`, status: 200, domain: ["aiGateway", "GET", `${AG}/versions/1`] },
  "POST /admin/v1/ai/agents/:agentId/versions": {
    url: `${AG}/versions`,
    payload: { from_version: 1 },
    headers: IK("agver"),
    status: 201,
    domain: ["aiGateway", "POST", `${AG}/versions`],
  },
  "PATCH /admin/v1/ai/agents/:agentId/versions/:v": {
    url: `${AG}/versions/2`,
    payload: { instructions: "Отвечай коротко.", temperature: 0.2, fallback_model_id: null },
    headers: { "if-match": "2026-11-19T08:00:00Z" },
    status: 200,
    domain: ["aiGateway", "PATCH", `${AG}/versions/2`],
  },
  "DELETE /admin/v1/ai/agents/:agentId/versions/:v": { url: `${AG}/versions/2`, status: 204, domain: ["aiGateway", "DELETE", `${AG}/versions/2`] },
  "POST /admin/v1/ai/agents/:agentId/versions/:v/test-runs": {
    url: `${AG}/versions/2/test-runs`,
    status: 202,
    domain: ["aiGateway", "POST", `${AG}/versions/2/test-runs`],
  },
  "GET /admin/v1/ai/agents/:agentId/versions/:v/test-runs/:runId": {
    url: `${AG}/versions/2/test-runs/${RUN_ID}`,
    status: 200,
    domain: ["aiGateway", "GET", `${AG}/versions/2/test-runs/${RUN_ID}`],
  },
  "POST /admin/v1/ai/agents/:agentId/versions/:v/publish": {
    url: `${AG}/versions/2/publish`,
    payload: { reason: "тесты зелёные" },
    headers: IK("agpub"),
    status: 200,
    domain: ["aiGateway", "POST", `${AG}/versions/2/publish`],
  },
  "PUT /admin/v1/ai/agents/:agentId/canary": {
    url: `${AG}/canary`,
    payload: { version: 2, percent: 10, reason: "проверка на 10%" },
    status: 200,
    domain: ["aiGateway", "PUT", `${AG}/canary`],
  },
  "DELETE /admin/v1/ai/agents/:agentId/canary": {
    url: `${AG}/canary`,
    payload: { reason: "достаточно данных" },
    status: 200,
    domain: ["aiGateway", "DELETE", `${AG}/canary`],
  },
  "POST /admin/v1/ai/agents/:agentId/rollback": {
    url: `${AG}/rollback`,
    payload: { reason: "рост отказов" },
    status: 200,
    domain: ["aiGateway", "POST", `${AG}/rollback`],
  },
  "GET /admin/v1/ai/agents/:agentId/golden-cases": { url: `${AG}/golden-cases`, status: 200, domain: ["aiGateway", "GET", `${AG}/golden-cases`] },
  "POST /admin/v1/ai/agents/:agentId/golden-cases": {
    url: `${AG}/golden-cases`,
    payload: GOLDEN_INPUT,
    headers: IK("golden"),
    status: 201,
    domain: ["aiGateway", "POST", `${AG}/golden-cases`],
  },
  "PATCH /admin/v1/ai/golden-cases/:caseId": {
    url: "/admin/v1/ai/golden-cases/cp-01-correct",
    payload: { mandatory: false },
    status: 200,
    domain: ["aiGateway", "PATCH", "/admin/v1/ai/golden-cases/cp-01-correct"],
  },
  "DELETE /admin/v1/ai/golden-cases/:caseId": {
    url: "/admin/v1/ai/golden-cases/cp-01-correct",
    status: 204,
    domain: ["aiGateway", "DELETE", "/admin/v1/ai/golden-cases/cp-01-correct"],
  },
  // ---------- модели, провайдер, бюджет, затраты (ai-gateway)
  "GET /admin/v1/ai/models": { url: "/admin/v1/ai/models", status: 200, domain: ["aiGateway", "GET", "/admin/v1/ai/models"] },
  "PUT /admin/v1/ai/models/:modelId": {
    url: "/admin/v1/ai/models/claude-haiku-5-5",
    payload: { input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5, active: true, reason: "прайс 19.11" },
    status: 200,
    domain: ["aiGateway", "PUT", "/admin/v1/ai/models/claude-haiku-5-5"],
  },
  "GET /admin/v1/ai/provider": { url: "/admin/v1/ai/provider", status: 200, domain: ["aiGateway", "GET", "/admin/v1/ai/provider"] },
  "GET /admin/v1/ai/budget": { url: "/admin/v1/ai/budget", status: 200, domain: ["aiGateway", "GET", "/admin/v1/ai/budget"] },
  "PUT /admin/v1/ai/budget": {
    url: "/admin/v1/ai/budget",
    payload: { monthly_cap_usd: 20, learner_daily_cap_usd: 0.05, lesson_cap_usd: 0.03, speech_monthly_cap_usd: 5, alert_percent: 80, reason: "решение владельца" },
    status: 200,
    domain: ["aiGateway", "PUT", "/admin/v1/ai/budget"],
  },
  "POST /admin/v1/ai/emergency-stop": {
    url: "/admin/v1/ai/emergency-stop",
    payload: { enabled: true, reason: "аномальный расход" },
    headers: IK("estop"),
    status: 200,
    domain: ["aiGateway", "POST", "/admin/v1/ai/emergency-stop"],
  },
  "GET /admin/v1/ai/usage/summary": { url: "/admin/v1/ai/usage/summary?period=week", status: 200, domain: ["aiGateway", "GET", "/admin/v1/ai/usage/summary"] },
  "GET /admin/v1/ai/usage": {
    url: `/admin/v1/ai/usage?session_id=${SESSION_ID}&limit=20`,
    status: 200,
    domain: ["aiGateway", "GET", "/admin/v1/ai/usage"],
  },
  // ---------- контроль диалогов (lessons, assessment)
  "GET /admin/v1/qa/sessions": {
    url: "/admin/v1/qa/sessions?from=2026-11-01&to=2026-11-19T23:59:59Z&kind=lesson&status=completed&outcome=success&flag=ai_used&lesson_id=l-a1-05-cafe&level=A1&limit=50",
    status: 200,
    domain: ["lessons", "GET", "/admin/v1/lesson-sessions"],
  },
  "GET /admin/v1/qa/sessions/:id": { url: `/admin/v1/qa/sessions/${SESSION_ID}`, status: 200, domain: ["lessons", "GET", `/admin/v1/lesson-sessions/${SESSION_ID}`] },
  "POST /admin/v1/qa/sessions/:id/transcript": {
    url: `/admin/v1/qa/sessions/${SESSION_ID}/transcript`,
    payload: { reason: "разбор апелляции ученика" },
    status: 200,
    domain: ["lessons", "POST", `/admin/v1/lesson-sessions/${SESSION_ID}/transcript`],
  },
  "POST /admin/v1/qa/evaluations/:id/flag": {
    url: `/admin/v1/qa/evaluations/${EVALUATION_ID}/flag`,
    payload: { reason: "спорная оценка грамматики" },
    status: 200,
    domain: ["assessment", "POST", `/admin/v1/evaluations/${EVALUATION_ID}/flag`],
  },
  "POST /admin/v1/qa/evaluations/:id/reevaluate": {
    url: `/admin/v1/qa/evaluations/${EVALUATION_ID}/reevaluate`,
    payload: REEVALUATION_BODY,
    headers: IK("reeval"),
    status: 201,
    domain: ["assessment", "POST", `/admin/v1/evaluations/${EVALUATION_ID}/reevaluate`],
  },
  "GET /admin/v1/qa/appeals": { url: "/admin/v1/qa/appeals?status=new&limit=20", status: 200, domain: ["assessment", "GET", "/admin/v1/appeals"] },
  "POST /admin/v1/qa/appeals/:id/take": { url: `/admin/v1/qa/appeals/${APPEAL_ID}/take`, status: 200, domain: ["assessment", "POST", `/admin/v1/appeals/${APPEAL_ID}/take`] },
  "POST /admin/v1/qa/appeals/:id/decide": {
    url: `/admin/v1/qa/appeals/${APPEAL_ID}/decide`,
    payload: { decision: "corrected", note: "Оценка исправлена: ответ верный", new_evaluation_id: EVALUATION_ID_2 },
    headers: IK("decideap"),
    status: 200,
    domain: ["assessment", "POST", `/admin/v1/appeals/${APPEAL_ID}/decide`],
  },
  // ---------- спринт 5: словарь курса (catalog)
  "GET /admin/v1/glossary": {
    url: "/admin/v1/glossary?pair_id=ru-en&q=coff&source=ai&review_status=pending&limit=20",
    status: 200,
    domain: ["catalog", "GET", "/admin/v1/glossary"],
  },
  "GET /admin/v1/glossary/stats": { url: "/admin/v1/glossary/stats?pair_id=ru-en", status: 200, domain: ["catalog", "GET", "/admin/v1/glossary/stats"] },
  "GET /admin/v1/glossary/:entryId": { url: `/admin/v1/glossary/${GLOSSARY_ENTRY_ID}`, status: 200, domain: ["catalog", "GET", `/admin/v1/glossary/${GLOSSARY_ENTRY_ID}`] },
  "POST /admin/v1/glossary": {
    url: "/admin/v1/glossary",
    payload: { pair_id: "ru-en", lemma: "receipt", forms: ["receipt", "receipts"], part_of_speech: "noun", gloss: { ru: "чек", uz: "chek" }, example_en: null, reason: null },
    headers: IK("gloss"),
    status: 201,
    domain: ["catalog", "POST", "/admin/v1/glossary"],
  },
  "PATCH /admin/v1/glossary/:entryId": {
    url: `/admin/v1/glossary/${GLOSSARY_ENTRY_ID}`,
    payload: { override: { gloss: { ru: "кофе", uz: "qahva" }, example_en: null }, reason: "uz — латиница" },
    headers: { "if-match": "2026-11-19T10:00:00.000Z" },
    status: 200,
    domain: ["catalog", "PATCH", `/admin/v1/glossary/${GLOSSARY_ENTRY_ID}`],
  },
  "POST /admin/v1/glossary/:entryId/review": {
    url: `/admin/v1/glossary/${GLOSSARY_ENTRY_ID}/review`,
    payload: { decision: "correct", gloss: { ru: "латте", uz: "latte" }, note: "Уточнение" },
    headers: IK("greview"),
    status: 200,
    domain: ["catalog", "POST", `/admin/v1/glossary/${GLOSSARY_ENTRY_ID}/review`],
  },
  "DELETE /admin/v1/glossary/:entryId": {
    url: `/admin/v1/glossary/${GLOSSARY_ENTRY_ID}`,
    payload: { reason: "дубль статьи" },
    status: 204,
    domain: ["catalog", "DELETE", `/admin/v1/glossary/${GLOSSARY_ENTRY_ID}`],
  },
  // ---------- спринт 5: память ученика (memory)
  "GET /admin/v1/memory/learners/:userId": {
    url: `/admin/v1/memory/learners/${LEARNER_USER_ID}`,
    status: 200,
    domain: ["memory", "GET", `/admin/v1/memory/learners/${LEARNER_USER_ID}`],
  },
  "GET /admin/v1/memory/learners/:userId/cards": {
    url: `/admin/v1/memory/learners/${LEARNER_USER_ID}/cards?status=review&kind=word&limit=20`,
    status: 200,
    domain: ["memory", "GET", `/admin/v1/memory/learners/${LEARNER_USER_ID}/cards`],
  },
  "GET /admin/v1/memory/cards/:cardId": { url: `/admin/v1/memory/cards/${CARD_ID}`, status: 200, domain: ["memory", "GET", `/admin/v1/memory/cards/${CARD_ID}`] },
  "GET /admin/v1/memory/cards/:cardId/log": {
    url: `/admin/v1/memory/cards/${CARD_ID}/log?cursor=c2&limit=20`,
    status: 200,
    domain: ["memory", "GET", `/admin/v1/memory/cards/${CARD_ID}/log`],
  },
  "POST /admin/v1/memory/cards/:cardId/actions": {
    url: `/admin/v1/memory/cards/${CARD_ID}/actions`,
    payload: { action: "reschedule", due_at: "2026-12-01T09:00:00+05:00", reason: "Перенос по просьбе родителя" },
    headers: IK("cardact"),
    status: 200,
    domain: ["memory", "POST", `/admin/v1/memory/cards/${CARD_ID}/actions`],
  },
  "GET /admin/v1/memory/analytics": { url: "/admin/v1/memory/analytics?pair_id=ru-en&period=90d", status: 200, domain: ["memory", "GET", "/admin/v1/memory/analytics"] },
  "GET /admin/v1/memory/stats": { url: "/admin/v1/memory/stats?period=7d", status: 200, domain: ["memory", "GET", "/admin/v1/memory/stats"] },
  // ---------- спринт 6: игра и герои (gamification /internal/v1/admin/game/*)
  "GET /admin/v1/game/overview": { url: `${GM}/overview?period=30d`, status: 200, domain: ["gamification", "GET", `${GI}/overview`] },
  "GET /admin/v1/game/rules": { url: `${GM}/rules`, status: 200, domain: ["gamification", "GET", `${GI}/rules`] },
  "GET /admin/v1/game/rules/:version": { url: `${GM}/rules/1`, status: 200, domain: ["gamification", "GET", `${GI}/rules/1`] },
  "PUT /admin/v1/game/rules/draft": {
    url: `${GM}/rules/draft`,
    payload: { payload: gameRulesPayload(), comment: "Поднимаем лимит тилов", based_on: 1 },
    headers: { "if-match": "2026-11-20T09:00:00.000Z" },
    status: 200,
    domain: ["gamification", "PUT", `${GI}/rules/draft`],
  },
  "DELETE /admin/v1/game/rules/draft": { url: `${GM}/rules/draft`, status: 204, domain: ["gamification", "DELETE", `${GI}/rules/draft`] },
  "POST /admin/v1/game/rules/draft/validate": { url: `${GM}/rules/draft/validate`, status: 200, domain: ["gamification", "POST", `${GI}/rules/draft/validate`] },
  "POST /admin/v1/game/rules/draft/activate": {
    url: `${GM}/rules/draft/activate`,
    payload: { comment: "Лимит тилов 80 в день" },
    status: 200,
    domain: ["gamification", "POST", `${GI}/rules/draft/activate`],
  },
  "POST /admin/v1/game/rules/:version/rollback": {
    url: `${GM}/rules/1/rollback`,
    payload: { comment: "Возврат к версии 1" },
    status: 200,
    domain: ["gamification", "POST", `${GI}/rules/1/rollback`],
  },
  "GET /admin/v1/game/heroes": { url: `${GM}/heroes`, status: 200, domain: ["gamification", "GET", `${GI}/heroes`] },
  "PUT /admin/v1/game/heroes/:code/draft": {
    url: `${GM}/heroes/pet_0/draft`,
    payload: HERO_DRAFT_BODY,
    status: 200,
    domain: ["gamification", "PUT", `${GI}/heroes/pet_0/draft`],
  },
  "POST /admin/v1/game/heroes/:code/publish": {
    url: `${GM}/heroes/pet_0/publish`,
    payload: { comment: "Новая картинка ступени" },
    status: 200,
    domain: ["gamification", "POST", `${GI}/heroes/pet_0/publish`],
  },
  "POST /admin/v1/game/assets": {
    url: `${GM}/assets?purpose=hero_stage`,
    payload: PNG_BYTES,
    headers: { "content-type": "image/png" },
    status: 201,
    domain: ["gamification", "POST", `${GI}/assets`],
  },
  "GET /admin/v1/game/assets/:assetId/content": { url: `${GM}/assets/${ASSET_ID}/content`, status: 200, domain: ["gamification", "GET", `${GI}/assets/${ASSET_ID}/content`] },
  "GET /admin/v1/game/shop/items": { url: `${GM}/shop/items`, status: 200, domain: ["gamification", "GET", `${GI}/shop/items`] },
  "POST /admin/v1/game/shop/items": {
    url: `${GM}/shop/items`,
    payload: SHOP_ITEM_BODY,
    headers: IK("shopitem"),
    status: 201,
    domain: ["gamification", "POST", `${GI}/shop/items`],
  },
  "PATCH /admin/v1/game/shop/items/:code": {
    url: `${GM}/shop/items/bg_sunset`,
    payload: { price_til: 150, order: 2 },
    status: 200,
    domain: ["gamification", "PATCH", `${GI}/shop/items/bg_sunset`],
  },
  "POST /admin/v1/game/shop/items/:code/publish": {
    url: `${GM}/shop/items/bg_sunset/publish`,
    payload: { comment: "В продажу" },
    status: 200,
    domain: ["gamification", "POST", `${GI}/shop/items/bg_sunset/publish`],
  },
  "POST /admin/v1/game/shop/items/:code/retire": {
    url: `${GM}/shop/items/bg_sunset/retire`,
    payload: { comment: "Конец сезона" },
    status: 200,
    domain: ["gamification", "POST", `${GI}/shop/items/bg_sunset/retire`],
  },
  "GET /admin/v1/game/events": { url: `${GM}/events?status=published`, status: 200, domain: ["gamification", "GET", `${GI}/events`] },
  "POST /admin/v1/game/events": {
    url: `${GM}/events`,
    payload: GAME_EVENT_BODY,
    headers: IK("gameevent"),
    status: 201,
    domain: ["gamification", "POST", `${GI}/events`],
  },
  "PATCH /admin/v1/game/events/:id": {
    url: `${GM}/events/${GAME_EVENT_ID}`,
    payload: { multipliers: [{ action: "reading", currency: "til", factor: 1.5 }] },
    status: 200,
    domain: ["gamification", "PATCH", `${GI}/events/${GAME_EVENT_ID}`],
  },
  "POST /admin/v1/game/events/:id/publish": {
    url: `${GM}/events/${GAME_EVENT_ID}/publish`,
    payload: { comment: "Запуск недели чтения" },
    status: 200,
    domain: ["gamification", "POST", `${GI}/events/${GAME_EVENT_ID}/publish`],
  },
  "POST /admin/v1/game/events/:id/cancel": {
    url: `${GM}/events/${GAME_EVENT_ID}/cancel`,
    payload: { comment: "Перенос на декабрь" },
    status: 200,
    domain: ["gamification", "POST", `${GI}/events/${GAME_EVENT_ID}/cancel`],
  },
  "GET /admin/v1/game/wallets/:userId": { url: `${GM}/wallets/${LEARNER_USER_ID}`, status: 200, domain: ["gamification", "GET", `${GI}/wallets/${LEARNER_USER_ID}`] },
  "GET /admin/v1/game/wallets/:userId/ledger": {
    url: `${GM}/wallets/${LEARNER_USER_ID}/ledger?currency=til&cursor=c1&limit=50`,
    status: 200,
    domain: ["gamification", "GET", `${GI}/wallets/${LEARNER_USER_ID}/ledger`],
  },
  "POST /admin/v1/game/wallets/:userId/adjustments": {
    url: `${GM}/wallets/${LEARNER_USER_ID}/adjustments`,
    payload: { currency: "til", amount: 50, reason: "Компенсация за сбой урока" },
    headers: IK("adjust"),
    status: 201,
    domain: ["gamification", "POST", `${GI}/wallets/${LEARNER_USER_ID}/adjustments`],
  },
  "POST /admin/v1/game/wallets/:userId/ledger/:opId/reverse": {
    url: `${GM}/wallets/${LEARNER_USER_ID}/ledger/${OP_ID}/reverse`,
    payload: { reason: "Ошибочное начисление" },
    status: 200,
    domain: ["gamification", "POST", `${GI}/wallets/${LEARNER_USER_ID}/ledger/${OP_ID}/reverse`],
  },
  "POST /admin/v1/game/wallets/:userId/purchases/:purchaseId/refund": {
    url: `${GM}/wallets/${LEARNER_USER_ID}/purchases/${PURCHASE_ID}/refund`,
    payload: { reason: "Покупка по ошибке ребёнка" },
    status: 200,
    domain: ["gamification", "POST", `${GI}/wallets/${LEARNER_USER_ID}/purchases/${PURCHASE_ID}/refund`],
  },
  // ---------- спринт 7: социальное — social, gamification (лиги, дуэли), lessons (парные комнаты)
  "GET /admin/v1/social/users/:userId": { url: `/admin/v1/social/users/${LEARNER_USER_ID}`, status: 200, domain: ["social", "GET", `${IA}/social/users/${LEARNER_USER_ID}`] },
  "GET /admin/v1/moderation/cases": { url: "/admin/v1/moderation/cases?status=open&limit=20", status: 200, domain: ["social", "GET", `${IA}/moderation/cases`] },
  "GET /admin/v1/moderation/cases/:caseId": { url: `/admin/v1/moderation/cases/${CASE_ID}`, status: 200, domain: ["social", "GET", `${IA}/moderation/cases/${CASE_ID}`] },
  "POST /admin/v1/moderation/cases/:caseId/resolve": {
    url: `/admin/v1/moderation/cases/${CASE_ID}/resolve`,
    payload: { action: "social_ban", days: 14, basis: "Оскорбления в нике и комнате" },
    headers: IK("resolve"),
    status: 200,
    domain: ["social", "POST", `${IA}/moderation/cases/${CASE_ID}/resolve`],
  },
  "GET /admin/v1/moderation/sanctions": { url: `/admin/v1/moderation/sanctions?user_id=${TARGET_USER_ID}&active=true`, status: 200, domain: ["social", "GET", `${IA}/moderation/sanctions`] },
  "POST /admin/v1/moderation/sanctions/:sanctionId/revoke": {
    url: `/admin/v1/moderation/sanctions/${SANCTION_ID}/revoke`,
    payload: { reason: "Ошибка модератора, снимаем" },
    status: 200,
    domain: ["social", "POST", `${IA}/moderation/sanctions/${SANCTION_ID}/revoke`],
  },
  "GET /admin/v1/moderation/appeals": { url: "/admin/v1/moderation/appeals?status=open", status: 200, domain: ["social", "GET", `${IA}/moderation/appeals`] },
  "POST /admin/v1/moderation/appeals/:appealId/decide": {
    url: `/admin/v1/moderation/appeals/${SANCTION_APPEAL_ID}/decide`,
    payload: { decision: "upheld", note: "Санкция обоснована, оставляем" },
    status: 200,
    domain: ["social", "POST", `${IA}/moderation/appeals/${SANCTION_APPEAL_ID}/decide`],
  },
  "GET /admin/v1/referrals/campaigns": { url: "/admin/v1/referrals/campaigns", status: 200, domain: ["social", "GET", `${IA}/referrals/campaigns`] },
  "GET /admin/v1/referrals/campaigns/stats": { url: "/admin/v1/referrals/campaigns/stats", status: 200, domain: ["social", "GET", `${IA}/referrals/campaigns/stats`] },
  "GET /admin/v1/referrals/campaigns/:version": { url: "/admin/v1/referrals/campaigns/1", status: 200, domain: ["social", "GET", `${IA}/referrals/campaigns/1`] },
  "PUT /admin/v1/referrals/campaigns/draft": {
    url: "/admin/v1/referrals/campaigns/draft",
    payload: { payload: campaignPayload({ monthly_cap: 12 }), comment: null, based_on: 1 },
    status: 200,
    domain: ["social", "PUT", `${IA}/referrals/campaigns/draft`],
  },
  "DELETE /admin/v1/referrals/campaigns/draft": { url: "/admin/v1/referrals/campaigns/draft", status: 204, domain: ["social", "DELETE", `${IA}/referrals/campaigns/draft`] },
  "POST /admin/v1/referrals/campaigns/draft/validate": { url: "/admin/v1/referrals/campaigns/draft/validate", status: 200, domain: ["social", "POST", `${IA}/referrals/campaigns/draft/validate`] },
  "POST /admin/v1/referrals/campaigns/draft/activate": {
    url: "/admin/v1/referrals/campaigns/draft/activate",
    payload: { comment: "Лимит 12 в месяц с декабря" },
    status: 200,
    domain: ["social", "POST", `${IA}/referrals/campaigns/draft/activate`],
  },
  "GET /admin/v1/referrals": { url: "/admin/v1/referrals?status=review", status: 200, domain: ["social", "GET", `${IA}/referrals`] },
  "GET /admin/v1/referrals/:referralId": { url: `/admin/v1/referrals/${REFERRAL_ID}`, status: 200, domain: ["social", "GET", `${IA}/referrals/${REFERRAL_ID}`] },
  "POST /admin/v1/referrals/:referralId/approve": {
    url: `/admin/v1/referrals/${REFERRAL_ID}/approve`,
    payload: { note: "Уроки реальные, проверено" },
    status: 200,
    domain: ["social", "POST", `${IA}/referrals/${REFERRAL_ID}/approve`],
  },
  "POST /admin/v1/referrals/:referralId/reject": {
    url: `/admin/v1/referrals/${REFERRAL_ID}/reject`,
    payload: { reject_code: "family_member", note: "Приглашённый — член семьи" },
    status: 200,
    domain: ["social", "POST", `${IA}/referrals/${REFERRAL_ID}/reject`],
  },
  "GET /admin/v1/game/leagues": { url: `${GM}/leagues?week=${WEEK}`, status: 200, domain: ["gamification", "GET", `${GI}/leagues`] },
  "GET /admin/v1/game/leagues/:groupId": { url: `${GM}/leagues/${GROUP_ID}`, status: 200, domain: ["gamification", "GET", `${GI}/leagues/${GROUP_ID}`] },
  "POST /admin/v1/game/leagues/:groupId/reevaluate": {
    url: `${GM}/leagues/${GROUP_ID}/reevaluate`,
    payload: { exclude_user_ids: [LEARNER_USER_ID], reason: "Накрутка XP, исключаем" },
    status: 200,
    domain: ["gamification", "POST", `${GI}/leagues/${GROUP_ID}/reevaluate`],
  },
  "POST /admin/v1/game/leagues/:groupId/release-prizes": {
    url: `${GM}/leagues/${GROUP_ID}/release-prizes`,
    payload: { reason: "Аномалия проверена: честно" },
    status: 200,
    domain: ["gamification", "POST", `${GI}/leagues/${GROUP_ID}/release-prizes`],
  },
  "GET /admin/v1/game/duels": { url: `${GM}/duels?status=finished`, status: 200, domain: ["gamification", "GET", `${GI}/duels`] },
  "GET /admin/v1/game/duels/:duelId": { url: `${GM}/duels/${DUEL_ID}`, status: 200, domain: ["gamification", "GET", `${GI}/duels/${DUEL_ID}`] },
  "POST /admin/v1/game/duels/:duelId/reevaluate": {
    url: `${GM}/duels/${DUEL_ID}/reevaluate`,
    payload: { result: "opponent", reason: "Сбой проверки ответа 7" },
    status: 200,
    domain: ["gamification", "POST", `${GI}/duels/${DUEL_ID}/reevaluate`],
  },
  "GET /admin/v1/pair-rooms": { url: "/admin/v1/pair-rooms?status=finished&from=2026-11-01", status: 200, domain: ["lessons", "GET", `${IA}/pair-rooms`] },
  "GET /admin/v1/pair-rooms/:roomId": { url: `/admin/v1/pair-rooms/${ROOM_ID}`, status: 200, domain: ["lessons", "GET", `${IA}/pair-rooms/${ROOM_ID}`] },
  "POST /admin/v1/pair-rooms/:roomId/stop": {
    url: `/admin/v1/pair-rooms/${ROOM_ID}/stop`,
    payload: { reason: "Грубость в комнате, жалоба" },
    status: 200,
    domain: ["lessons", "POST", `${IA}/pair-rooms/${ROOM_ID}/stop`],
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
    let { staff, s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    // logout завершает сессию — последним
    const keys = Object.keys(CASES).sort((a, b) => Number(a.includes("/logout")) - Number(b.includes("/logout")));
    let commands = 0;
    for (const key of keys) {
      if (key === "POST /admin/v1/auth/step-up") continue; // уже выполнен
      const c = CASES[key]!;
      const method = key.split(" ")[0]! as "GET";
      // лимит команд — 60/мин на сотрудника: новый сотрудник на каждые 40 команд
      if (method !== "GET" && ++commands % 40 === 0) {
        ({ staff, s } = await loginAs(h, "super_admin"));
        await stepUp(h, s);
      }
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
    // дашборд и карточка сессии «Контроля диалогов» собираются из независимых блоков (ошибка блока → 200, проверки — в
    // api.test.ts и ai.test.ts)
    const proxied = Object.entries(CASES).filter(
      ([k, c]) =>
        c.domain && c.domain[0] !== "adminIdentity" && k !== "GET /admin/v1/dashboard" && k !== "GET /admin/v1/qa/sessions/:id" && !k.includes("/auth/"),
    );
    expect(proxied.length).toBeGreaterThan(70);
    // лимит команд — 60/мин на сотрудника: новый сотрудник на каждые 40 команд
    let s = (await loginAs(h, "super_admin")).s;
    await stepUp(h, s);
    let commands = 0;
    const send = async (key: string, c: Case) => {
      const method = key.split(" ")[0]! as "GET";
      if (method !== "GET" && ++commands % 40 === 0) {
        s = (await loginAs(h, "super_admin")).s;
        await stepUp(h, s);
      }
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

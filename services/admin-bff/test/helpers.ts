/**
 * Тестовая обвязка admin-bff: реальный Redis (TEST_REDIS_URL, уникальный префикс ключей на приложение), домены —
 * in-memory подделка через fetchImpl. Подделка проверяет внутренний JWT (aud = домен, iss = admin-bff) и
 * запоминает actor — как настоящие домены (verifyInternalToken из ts-common). Ответы доменов — полные по
 * контракту admin.ts (матрица маршрутов проверяет их строгим Ajv).
 */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { verifyInternalToken, type Actor } from "@tilhero/ts-common";
import type { LoginStep, Me, Permission, RoleCode } from "@tilhero/contracts/admin";
import { buildApp, type AppDeps } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { App, Principal } from "../src/http.js";
import { DEFAULT_ROLE_MATRIX } from "../src/rbac.js";

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/14";
export const INTERNAL_SECRET = "internal-test-secret-" + "a".repeat(32);
export const ORIGIN = "https://admin.tilhero.test";
export const UA = "Mozilla/5.0 (X11; Linux x86_64) AdminTest/1.0";
export const TOTP_OK = "123456";
export const PASSWORD_OK = "Correct-Horse-42";

export const URLS = {
  adminIdentity: "http://admin-identity.test",
  userAdmin: "http://user-admin.test",
  identity: "http://identity.test",
  support: "http://support.test",
  audit: "http://audit.test",
  experience: "http://experience.test",
  notifications: "http://notifications.test",
} as const;
export type Service = keyof typeof URLS;
export const AUD: Record<Service, string> = {
  adminIdentity: "admin-identity",
  userAdmin: "user-admin",
  identity: "identity-consent",
  support: "support",
  audit: "audit",
  experience: "experience-config",
  notifications: "notifications",
};

export function testConfig(env: Record<string, string> = {}): Config {
  const prefix = `abfftest:${randomUUID().slice(0, 8)}:`;
  return loadConfig({
    NODE_ENV: "test",
    ENV: "test",
    INTERNAL_JWT_SECRET: INTERNAL_SECRET,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_KEY_PREFIX: prefix,
    RATE_LIMIT_KEY_PREFIX: prefix, // ключи лимитера — тоже с префиксом приложения (в т. ч. при ENV=dev)
    ADMIN_ORIGIN: ORIGIN,
    ADMIN_IDENTITY_URL: URLS.adminIdentity,
    USER_ADMIN_URL: URLS.userAdmin,
    IDENTITY_URL: URLS.identity,
    SUPPORT_URL: URLS.support,
    AUDIT_URL: URLS.audit,
    EXPERIENCE_URL: URLS.experience,
    NOTIFICATIONS_URL: URLS.notifications,
    UPSTREAM_RETRIES: "0",
    UPSTREAM_TIMEOUT_MS: "2000",
    DASHBOARD_TIMEOUT_MS: "500",
    LOG_LEVEL: "debug",
    ...env,
  });
}

// ---------------------------------------------------------------- logs

export class LogCapture {
  readonly lines: string[] = [];
  write(msg: string): void {
    this.lines.push(msg);
  }
  get text(): string {
    return this.lines.join("");
  }
}

// ---------------------------------------------------------------- fake domains

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const domainError = (status: number, code: string, details: Record<string, unknown> = {}) =>
  json(status, { code, message: `domain says ${code}`, trace_id: "domain-trace", details });

export interface Call {
  service: Service;
  method: string;
  path: string;
  query: Record<string, string>;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  actor: Actor | undefined;
  headers: Record<string, string>;
}

type Handler = (c: Call) => Response | Promise<Response>;

export interface FakeStaff {
  staff_id: string;
  email: string;
  display_name: string;
  role: RoleCode;
  password: string;
  permissions: Permission[];
  mfa_enabled: boolean;
  mfa_required: boolean;
  must_change_password: boolean;
  session_version: number;
  status: "ACTIVE" | "LOCKED" | "DISABLED";
}

// ---------------------------------------------------------------- идентификаторы и строки по контракту

export const LEARNER_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
export const CHILD_ID = "1a8fad5b-d9cb-469f-a165-70867728950f";
export const TICKET_ID = "5b1f0d0e-1111-4c2b-9a51-0d6c7a1e2f30";
export const OPERATOR_ID = "11111111-2222-4333-8444-555555555555";
export const NOTE_ID = "7a1c2e3f-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
export const CAMPAIGN_ID = "c4a1e2f3-5b6d-4e7f-8a9b-1c2d3e4f5a6b";
export const APPROVAL_ID = "5b1f0d0e-2222-4c2b-9a51-0d6c7a1e2f31";
export const RECORD_ID = "9a3e3a7e-2f4b-4c1d-8e5f-6a7b8c9d0e1f";
export const TEMPLATE_KEY = "lesson.reminder";
export const TG_FULL = "777000123456789";

export function learnerRow(p: Record<string, unknown> = {}) {
  return {
    user_id: LEARNER_ID,
    kind: "account",
    guardian_user_id: null,
    display_name: "Азиз",
    username: "aziz_learner",
    telegram_id_masked: "••••••789",
    locale: "uz",
    age_band: "18+",
    guardian_consent: "not_required",
    status: "ACTIVE",
    onboarding_completed: true,
    goal: "work",
    reminders_enabled: true,
    children_count: 1,
    open_tickets: 1,
    tickets_total: 2,
    created_at: "2026-10-01T10:00:00Z",
    last_activity_at: "2026-11-15T08:00:00Z",
    ...p,
  };
}

export function childRow(p: Record<string, unknown> = {}) {
  return learnerRow({
    user_id: CHILD_ID,
    kind: "child",
    guardian_user_id: LEARNER_ID,
    display_name: "Лола",
    username: null,
    telegram_id_masked: null,
    age_band: "6-9",
    guardian_consent: "granted",
    goal: null,
    children_count: 0,
    open_tickets: 0,
    tickets_total: 0,
    ...p,
  });
}

/** Карточка user-admin (без tickets — их добавляет admin-bff). */
export function learnerCard(id = LEARNER_ID, p: Record<string, unknown> = {}) {
  return {
    ...learnerRow({ user_id: id }),
    consent: { policy_version: "1.0", purposes: ["terms", "privacy", "learning", "product_news"], accepted_at: "2026-10-01T10:00:00Z", revoked_at: null, basis: "self" },
    security: { pin_enabled: true, pin_reset_pending: false },
    notifications: { enabled: true, categories: { reminders: true, missed: true, social: false, support: true, product: true } },
    plan: {
      goal: "work",
      level_self: "beginner",
      ui_lang: "uz",
      schedule: { preset: "weekdays", days: [1, 2, 3, 4, 5], preferred_time: "19:30", duration_min: 15, reminders_enabled: true, timezone: "Asia/Tashkent" },
      onboarding_completed_at: "2026-10-01T10:05:00Z",
      updated_at: "2026-10-02T10:00:00Z",
    },
    children: [childRow()],
    guardian: null,
    refreshed_at: "2026-11-18T09:00:00Z",
    // служебные поля user-admin не уходят клиенту
    search_text: "азиз aziz_learner",
    source_updated_at: "2026-11-18T08:59:00Z",
    ...p,
  };
}

export function ticketSummary(userId: string | null = LEARNER_ID, p: Record<string, unknown> = {}) {
  return {
    ticket_id: TICKET_ID,
    number: "TCK-3001",
    user_id: userId,
    channel: "miniapp",
    category: "LESSON",
    subject: "Урок не открывается",
    status: "IN_PROGRESS",
    priority: "normal",
    assignee_id: OPERATOR_ID,
    has_context: true,
    anonymized: false,
    created_at: "2026-11-08T10:00:00Z",
    updated_at: "2026-11-08T10:00:00Z",
    last_message_at: "2026-11-08T10:00:00Z",
    first_response_at: null,
    sla_first_response_at: "2026-11-08T12:00:00Z",
    sla_resolution_at: "2026-11-09T10:00:00Z",
    sla_target: "first_response",
    sla_due_at: "2026-11-08T12:00:00Z",
    sla_state: "breached",
    sla_paused: false,
    ...p,
  };
}

export function ticketDetail(p: Record<string, unknown> = {}) {
  return {
    ...ticketSummary(LEARNER_ID),
    context: { deeplink: "https://t.me/TilHero_bot/TilHero?startapp=lesson", client_version: "telegram-miniapp-1.0" },
    correlation_id: null,
    resolved_at: null,
    closed_at: null,
    user_unread_operator_replies: 0,
    messages: [
      { message_id: randomUUID(), sender_type: "user", visibility: "public", author_id: null, author_name: "Азиз", text: "Помогите", created_at: "2026-11-08T10:00:00Z" },
      { message_id: randomUUID(), sender_type: "operator", visibility: "internal", author_id: OPERATOR_ID, author_name: "Анна", text: "заметка", created_at: "2026-11-08T10:05:00Z" },
    ],
    status_history: [{ from_status: null, status: "NEW", at: "2026-11-08T10:00:00Z", changed_by: "user", actor_id: null }],
    escalations: [],
    ...p,
  };
}

/** Клиентская форма обращения (bff.ts Ticket) — ответ client-view. */
export function clientTicket() {
  return {
    ticket_id: TICKET_ID,
    number: "TCK-3001",
    category: "LESSON",
    subject: "Урок не открывается",
    status: "IN_PROGRESS",
    created_at: "2026-11-08T10:00:00Z",
    updated_at: "2026-11-08T10:00:00Z",
    last_message_at: "2026-11-08T10:00:00Z",
    unread_operator_replies: 0,
    context: { client_version: "telegram-miniapp-1.0" },
    sla_first_response_at: "2026-11-08T12:00:00Z",
    messages: [{ message_id: randomUUID(), sender_type: "user", author_name: null, text: "Помогите", created_at: "2026-11-08T10:00:00Z" }],
    status_history: [{ status: "NEW", at: "2026-11-08T10:00:00Z" }],
  };
}

export function staffRow(p: Record<string, unknown> = {}) {
  return {
    staff_id: randomUUID(),
    email: "row@tilhero.test",
    display_name: "Сотрудник",
    role: "support",
    status: "ACTIVE",
    mfa_enabled: true,
    must_change_password: false,
    last_login_at: null,
    created_at: "2026-10-01T00:00:00Z",
    created_by: null,
    ...p,
  };
}

export function approvalRow(p: Record<string, unknown> = {}) {
  return {
    approval_id: APPROVAL_ID,
    kind: "staff.role_grant",
    status: "PENDING",
    summary: {},
    reason: "основание",
    requested_by: { staff_id: OPERATOR_ID, email: "author@tilhero.test", display_name: "Автор", role: "super_admin" },
    requested_at: "2026-10-08T10:00:00Z",
    decided_by: null,
    decided_at: null,
    decision_note: null,
    waived: null,
    expires_at: "2026-10-11T10:00:00Z",
    ...p,
  };
}

export function roleRow(code: RoleCode = "support") {
  return {
    code,
    name: { ru: "Поддержка", en: "Support" },
    permissions: [...DEFAULT_ROLE_MATRIX[code]],
    privileged: false,
    staff_count: 2,
    updated_at: "2026-10-01T00:00:00Z",
    updated_by: null,
  };
}

export function activationRow(p: Record<string, unknown> = {}) {
  return {
    activation_id: randomUUID(),
    app: "admin",
    version: "1.0.0",
    previous_version: null,
    kind: "activate",
    reason: "релиз",
    activated_by: OPERATOR_ID,
    activated_at: "2026-10-08T10:00:00Z",
    ...p,
  };
}

export function versionRow(p: Record<string, unknown> = {}) {
  return {
    version_id: randomUUID(),
    app: "admin",
    version: "1.0.0",
    checksum: "sha256:abc",
    change_note: "сид",
    created_by: "seed",
    created_at: "2026-10-01T00:00:00Z",
    status: "current",
    ...p,
  };
}

export function auditRow(p: Record<string, unknown> = {}) {
  return {
    seq: 1,
    record_id: RECORD_ID,
    occurred_at: "2026-10-08T10:00:00Z",
    recorded_at: "2026-10-08T10:00:01Z",
    source: "admin-identity",
    actor_type: "staff",
    actor_id: OPERATOR_ID,
    actor_role: "super_admin",
    action: "staff.updated",
    object_type: "staff",
    object_id: OPERATOR_ID,
    before: null,
    after: { role: "support" },
    reason: null,
    ip: null,
    session_id: null,
    trace_id: null,
    prev_hash: "0".repeat(64),
    hash: "1".repeat(64),
    ...p,
  };
}

export function releaseNoteBody(p: Record<string, unknown> = {}) {
  return {
    slug: "2026.11-streaks",
    title: { ru: "Серии занятий", uz: "Mashgʻulot seriyalari" },
    items: [
      { title: { ru: "Серия", uz: "Seriya" }, text: { ru: "Занимайтесь каждый день", uz: "Har kuni shugʻullaning" }, link: "progress", icon: "flame" },
    ],
    audience: "existing",
    segments: { age: ["teens", "adults"], ui_lang: ["ru", "uz"] },
    ...p,
  };
}

export function releaseNoteRow(p: Record<string, unknown> = {}) {
  return {
    release_note_id: NOTE_ID,
    ...releaseNoteBody(),
    status: "draft",
    version: 1,
    created_by: OPERATOR_ID,
    created_at: "2026-11-01T10:00:00Z",
    updated_by: OPERATOR_ID,
    updated_at: "2026-11-01T10:00:00Z",
    published_by: null,
    published_at: null,
    archived_by: null,
    archived_at: null,
    views_total: 0,
    ...p,
  };
}

const texts = (title = "Время заниматься") => ({
  ru: { title, body: "{learner_name}, урок на {duration} ждёт", button: null },
  uz: { title: "Mashgʻulot vaqti", body: "{learner_name}, {duration} dars kutmoqda", button: "Boshlash" },
});

export function templateInfo(p: Record<string, unknown> = {}) {
  return {
    key: TEMPLATE_KEY,
    category: "reminders",
    kid: false,
    description: { ru: "Напоминание о занятии", en: "Lesson reminder" },
    placeholders: [
      { name: "learner_name", description: { ru: "Имя ученика", en: "Learner name" }, sample: { ru: "Азиз", uz: "Aziz" } },
      { name: "duration", description: { ru: "Длительность", en: "Duration" }, sample: { ru: "15 минут", uz: "15 daqiqa" } },
    ],
    default_texts: texts(),
    active_version: 2,
    active_since: "2026-11-10T10:00:00Z",
    updated_at: "2026-11-10T10:00:00Z",
    ...p,
  };
}

export function templateVersion(p: Record<string, unknown> = {}) {
  return {
    key: TEMPLATE_KEY,
    version: 2,
    status: "active",
    texts: texts("Пора учиться"),
    note: "мягче",
    created_by: OPERATOR_ID,
    created_at: "2026-11-09T10:00:00Z",
    activated_by: OPERATOR_ID,
    activated_at: "2026-11-10T10:00:00Z",
    ...p,
  };
}

export function campaignBody(p: Record<string, unknown> = {}) {
  return {
    title: "Новые уроки ноября",
    texts: texts("Новые уроки"),
    route: "lessons",
    segment: { ui_lang: ["ru", "uz"], age: ["adults"], onboarded: true, active_days: -14 },
    ...p,
  };
}

export function campaignRow(p: Record<string, unknown> = {}) {
  return {
    campaign_id: CAMPAIGN_ID,
    ...campaignBody(),
    status: "draft",
    version: 1,
    send_at: null,
    created_by: OPERATOR_ID,
    created_at: "2026-11-12T10:00:00Z",
    updated_at: "2026-11-12T10:00:00Z",
    scheduled_by: null,
    scheduled_at: null,
    started_at: null,
    finished_at: null,
    stopped_by: null,
    stopped_at: null,
    stop_reason: null,
    stats: { audience: 0, created: 0, sent: 0, in_app_only: 0, deferred: 0, skipped_frequency: 0, failed: 0 },
    // служебное поле домена — не уходит клиенту
    cursor: "opaque",
    ...p,
  };
}

export const LEARNER_STATS = {
  total_accounts: 120,
  total_children: 30,
  new_in_period: 7,
  active_in_period: 64,
  onboarding_completed_pct: 61.5,
  reminders_enabled_pct: 70,
  by_age_band: { "6-9": 10, "10-13": 20, "14-17": 15, "18+": 95, unknown: 10 },
  by_locale: { ru: 80, uz: 60, unknown: 10 },
};
export const SUPPORT_STATS = { open: 4, in_progress: 2, waiting_customer: 1, breached: 1, avg_first_response_minutes: 42, avg_resolution_minutes: null };
export const WHATS_NEW_SUMMARY = {
  published: 3,
  drafts: 1,
  latest: { release_note_id: NOTE_ID, slug: "2026.11-streaks", title: "Серии занятий", views_total: 57, published_at: "2026-11-10T10:00:00Z" },
};
export const CAMPAIGN_SUMMARY = { scheduled: 1, sending: 0, sent_in_period: 2, delivered_in_period: 1500 };

export class FakeDomains {
  readonly calls: Call[] = [];
  readonly staff = new Map<string, FakeStaff>();
  readonly challenges = new Map<string, { staff_id: string; step: string }>();
  readonly overrides = new Map<string, Handler>();
  readonly down = new Set<Service>();

  addStaff(p: Partial<FakeStaff> & { role: RoleCode }): FakeStaff {
    const id = p.staff_id ?? randomUUID();
    const s: FakeStaff = {
      staff_id: id,
      email: p.email ?? `staff-${id.slice(0, 6)}@tilhero.test`,
      display_name: p.display_name ?? `Оператор ${id.slice(0, 4)}`,
      password: PASSWORD_OK,
      permissions: [...DEFAULT_ROLE_MATRIX[p.role]],
      mfa_enabled: false,
      mfa_required: false,
      must_change_password: false,
      session_version: 1,
      status: "ACTIVE",
      ...p,
    };
    this.staff.set(id, s);
    return s;
  }

  /** Переопределить ответ: ключ "<service> <METHOD> <path>" (path без query). */
  on(service: Service, method: string, path: string, h: Handler): void {
    this.overrides.set(`${service} ${method} ${path}`, h);
  }

  callsTo(service: Service, method?: string, pathPrefix?: string): Call[] {
    return this.calls.filter(
      (c) => c.service === service && (!method || c.method === method) && (!pathPrefix || c.path.startsWith(pathPrefix)),
    );
  }

  principal(s: FakeStaff): Principal {
    return {
      staff: { staff_id: s.staff_id, email: s.email, display_name: s.display_name, role: s.role },
      permissions: [...s.permissions],
      mfa_enabled: s.mfa_enabled,
      must_change_password: s.must_change_password,
      session_version: s.session_version,
      status: s.status,
    };
  }

  private nextStep(s: FakeStaff): Response {
    let step = "done";
    if (s.must_change_password) step = "password_change";
    else if (s.mfa_required && !s.mfa_enabled) step = "mfa_enroll";
    else if (s.mfa_enabled) step = "mfa";
    if (step === "done") return json(200, { next: "done", principal: this.principal(s) });
    const challenge = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    this.challenges.set(challenge, { staff_id: s.staff_id, step });
    return json(200, { next: step, challenge });
  }

  private useChallenge(challenge: string, step: string): FakeStaff | null {
    const c = this.challenges.get(challenge);
    if (!c || c.step !== step) return null;
    return this.staff.get(c.staff_id) ?? null;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const service = (Object.keys(URLS) as Service[]).find((k) => new URL(URLS[k]).host === url.host);
    if (!service) throw new TypeError(`fetch failed: unknown host ${url.host}`);
    if (this.down.has(service)) throw new TypeError("fetch failed: connection refused");
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const token = headers["x-internal-token"];
    if (!token) return domainError(401, "INTERNAL_TOKEN_INVALID");
    let actor: Actor | undefined;
    try {
      const v = await verifyInternalToken(token, INTERNAL_SECRET, AUD[service], new Set(["admin-bff"]));
      actor = v.actor;
    } catch {
      return domainError(401, "INTERNAL_TOKEN_INVALID");
    }
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: Call = { service, method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, query, body, actor, headers };
    this.calls.push(call);
    const o = this.overrides.get(`${service} ${call.method} ${call.path}`);
    const result = Promise.resolve(o ? o(call) : this.handle(call));
    const signal = init?.signal;
    if (!signal) return result;
    // как настоящий fetch: AbortSignal.timeout прерывает ожидание ответа
    return Promise.race([
      result,
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  };

  private handle(c: Call): Response {
    const key = `${c.method} ${c.path}`;
    const tail = (n: number) => c.path.split("/")[n] ?? "";
    switch (c.service) {
      case "adminIdentity":
        return this.adminIdentity(c, key);
      case "userAdmin":
        if (key === "GET /admin/v1/learners/stats") return json(200, LEARNER_STATS);
        if (key === "GET /admin/v1/learners") {
          // поиск по UUID (сводка ученика в тикете) — строка этого ученика
          const byId = /^[0-9a-f-]{36}$/.test(c.query.q ?? "") ? { user_id: c.query.q } : {};
          return json(200, { items: [learnerRow(byId), childRow()], next_cursor: null });
        }
        if (c.method === "GET" && /^\/admin\/v1\/learners\/[^/]+$/.test(c.path)) return json(200, learnerCard(tail(4)));
        break;
      case "identity":
        if (c.method === "POST" && /^\/admin\/v1\/users\/[^/]+\/reveal$/.test(c.path)) {
          return json(200, { field: "telegram_user_id", value: TG_FULL, expires_in: 60 });
        }
        break;
      case "support":
        return this.support(c, key);
      case "audit":
        if (key === "POST /internal/v1/records") return json(201, { seq: 1, record_id: c.body.record_id });
        if (key === "GET /admin/v1/audit/records") return json(200, { items: [auditRow()], next_cursor: null });
        if (key === "GET /admin/v1/audit/verify") return json(200, { valid: true, checked: 1, first_seq: 1, last_seq: 1, broken_at_seq: null });
        if (c.method === "GET" && c.path.startsWith("/admin/v1/audit/records/")) return json(200, auditRow({ record_id: tail(5) }));
        break;
      case "experience":
        return this.experience(c, key);
      case "notifications":
        return this.notifications(c, key);
    }
    return domainError(404, "NOT_FOUND");
  }

  private adminIdentity(c: Call, key: string): Response {
    if (key === "POST /internal/v1/auth/login") {
      const s = [...this.staff.values()].find((x) => x.email === String(c.body.email).toLowerCase());
      if (!s || s.password !== c.body.password) return domainError(401, "INVALID_CREDENTIALS", { remaining: 4 });
      if (s.status === "DISABLED") return domainError(403, "ACCOUNT_DISABLED");
      return this.nextStep(s);
    }
    if (key === "POST /internal/v1/auth/password") {
      if (c.body.challenge) {
        const s = this.useChallenge(c.body.challenge, "password_change");
        if (!s) return domainError(401, "CHALLENGE_INVALID");
        this.challenges.delete(c.body.challenge);
        s.password = c.body.new_password;
        s.must_change_password = false;
        s.session_version += 1;
        return this.nextStep(s);
      }
      const s = this.staff.get(c.body.staff_id);
      if (!s || s.password !== c.body.current_password) return domainError(401, "INVALID_CREDENTIALS", { remaining: 4 });
      s.password = c.body.new_password;
      s.session_version += 1;
      return json(200, { next: "done", principal: this.principal(s) });
    }
    if (key === "POST /internal/v1/auth/mfa/enroll/start") {
      const s = this.useChallenge(c.body.challenge, "mfa_enroll");
      if (!s) return domainError(401, "CHALLENGE_INVALID");
      return json(200, {
        secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        otpauth_uri: `otpauth://totp/TilHero%20Admin:${encodeURIComponent(s.email)}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=TilHero%20Admin`,
        issuer: "TilHero Admin",
        account: s.email,
      });
    }
    if (key === "POST /internal/v1/auth/mfa/enroll/confirm" || key === "POST /internal/v1/auth/mfa/verify") {
      const step = key.endsWith("confirm") ? "mfa_enroll" : "mfa";
      const s = this.useChallenge(c.body.challenge, step);
      if (!s) return domainError(401, "CHALLENGE_INVALID");
      if (c.body.code !== TOTP_OK) return domainError(401, "MFA_INVALID", { remaining: 4 });
      this.challenges.delete(c.body.challenge);
      s.mfa_enabled = true;
      return json(200, { next: "done", principal: this.principal(s) });
    }
    if (key === "POST /internal/v1/auth/step-up") {
      if (c.body.code !== TOTP_OK) return domainError(401, "MFA_INVALID", { remaining: 4 });
      return json(200, { ok: true });
    }
    if (key === "POST /internal/v1/auth/logout") return new Response(null, { status: 204 });
    const pm = /^\/internal\/v1\/staff\/([^/]+)\/principal$/.exec(c.path);
    if (c.method === "GET" && pm) {
      const s = this.staff.get(decodeURIComponent(pm[1]!));
      if (!s) return domainError(404, "STAFF_NOT_FOUND");
      if (s.status === "DISABLED") return domainError(403, "ACCOUNT_DISABLED");
      return json(200, this.principal(s));
    }
    if (key === "GET /admin/v1/staff/lookup") {
      const ids = (c.query.ids ?? "").split(",");
      return json(200, {
        items: ids
          .map((id) => this.staff.get(id))
          .filter((s): s is FakeStaff => !!s)
          .map((s) => ({ staff_id: s.staff_id, email: s.email, display_name: s.display_name, role: s.role })),
      });
    }
    if (key === "GET /admin/v1/staff") return json(200, { items: [staffRow()], next_cursor: null });
    if (c.method === "GET" && /^\/admin\/v1\/staff\/[^/]+$/.test(c.path)) return json(200, staffRow({ staff_id: c.path.split("/")[4] }));
    if (key === "POST /admin/v1/staff") {
      const created = staffRow({ email: c.body.email, display_name: c.body.display_name, role: c.body.role, must_change_password: true });
      return json(201, { staff: created, temporary_password: "Tmp-Secret-Passw0rd-XYZ", approval: null });
    }
    if (c.method === "PATCH" && c.path.startsWith("/admin/v1/staff/")) {
      const id = c.path.split("/").pop()!;
      const s = this.staff.get(id);
      if (s && c.body.status === "DISABLED") {
        s.status = "DISABLED";
        s.session_version += 1;
      }
      if (c.body.role === "super_admin") return json(202, { approval: approvalRow({ kind: "staff.role_grant" }) });
      return json(200, staffRow({ staff_id: id, ...(s ? { email: s.email, display_name: s.display_name, role: s.role, status: s.status } : {}) }));
    }
    if (key === "GET /admin/v1/roles") {
      return json(200, { items: [roleRow("support"), roleRow("communications")], permissions: ["dashboard.read"] });
    }
    if (key === "GET /admin/v1/approvals") return json(200, { items: [approvalRow()], next_cursor: null });
    if (c.method === "POST" && /^\/admin\/v1\/approvals\/[^/]+\/(approve|reject)$/.test(c.path)) {
      return json(200, {
        ...approvalRow({ approval_id: c.path.split("/")[4]!, status: c.path.endsWith("/approve") ? "APPLIED" : "REJECTED" }),
        temporary_password: null,
      });
    }
    if (c.method === "POST" && /^\/admin\/v1\/staff\/[^/]+\/reset-password$/.test(c.path)) {
      return json(200, { temporary_password: "Tmp-Secret-Passw0rd-XYZ" });
    }
    if (c.method === "POST" && /^\/admin\/v1\/staff\/[^/]+\/reset-mfa$/.test(c.path)) {
      return json(200, staffRow({ staff_id: c.path.split("/")[4]!, mfa_enabled: false }));
    }
    if (c.method === "PUT" && c.path.startsWith("/admin/v1/roles/")) {
      return json(202, { approval: approvalRow({ kind: "role.permissions_change", summary: { role: c.path.split("/").pop(), permissions: c.body.permissions } }) });
    }
    return domainError(404, "NOT_FOUND");
  }

  private support(c: Call, key: string): Response {
    if (key === "GET /admin/v1/support/stats") return json(200, SUPPORT_STATS);
    if (key === "GET /admin/v1/support/templates") {
      return json(200, {
        items: [
          {
            id: "tpl_lesson",
            title: { ru: "Урок не открывается", en: "Lesson does not open" },
            text: { ru: "Здравствуйте! Обновите Mini App.", uz: "Assalomu alaykum! Mini Appni yangilang." },
            categories: ["LESSON", "BUG"],
          },
        ],
      });
    }
    if (key === "GET /admin/v1/support/tickets") return json(200, { items: [ticketSummary(c.query.user_id ?? LEARNER_ID)], next_cursor: null });
    if (key === "GET /admin/v1/support/sla-policies") {
      return json(200, {
        items: [{ category: "*", priority: "normal", first_response_minutes: 120, resolution_minutes: 1440, updated_at: "2026-10-01T00:00:00Z", updated_by: null }],
        category_defaults: { LESSON: "normal" },
      });
    }
    if (key === "PUT /admin/v1/support/sla-policies") {
      return json(200, { items: c.body.items.map((i: object) => ({ ...i, updated_at: "2026-11-18T00:00:00Z", updated_by: c.actor?.id ?? null })), category_defaults: {} });
    }
    const t = /^\/admin\/v1\/support\/tickets\/([^/]+)(\/[a-z-]+)?$/.exec(c.path);
    if (t) {
      const sub = t[2] ?? "";
      if (c.method === "GET" && sub === "") return json(200, ticketDetail());
      if (c.method === "GET" && sub === "/client-view") return json(200, clientTicket());
      if (c.method === "POST" && sub === "/messages") return json(200, ticketDetail());
      if (c.method === "POST" && sub === "/take") return json(200, { ...ticketDetail(), assignee_id: c.actor?.id ?? null });
      if (c.method === "PATCH" && sub === "") return json(200, ticketDetail());
      if (c.method === "POST" && sub === "/escalations") {
        return json(201, {
          escalation_id: randomUUID(),
          ticket_id: TICKET_ID,
          type: c.body.type,
          note: c.body.note,
          status: "OPEN",
          created_by: c.actor?.id ?? "",
          created_at: "2026-11-08T11:00:00Z",
        });
      }
    }
    return domainError(404, "NOT_FOUND");
  }

  private experience(c: Call, key: string): Response {
    const notes = "/admin/v1/release-notes";
    if (key === "GET /internal/v1/experience/admin/current") return json(200, { app: "admin", version: "1.0.0", theme: { id: "notebook" }, menu: [] });
    if (key === "GET /internal/v1/experience/miniapp/current") return json(200, { app: "miniapp", version: "1.0.0", theme: { id: "notebook" }, home: { sections: [] }, flags: {} });
    if (c.method === "GET" && /^\/admin\/v1\/experience\/[a-z]+\/state$/.test(c.path)) {
      return json(200, { app: c.path.split("/")[4], current: activationRow({ app: c.path.split("/")[4] }), previous_version: null });
    }
    if (c.method === "GET" && /^\/admin\/v1\/experience\/[a-z]+\/versions$/.test(c.path)) {
      return json(200, { items: [versionRow({ app: c.path.split("/")[4] })], next_cursor: null });
    }
    if (c.method === "GET" && /^\/admin\/v1\/experience\/[a-z]+\/versions\/[^/]+$/.test(c.path)) {
      return json(200, { ...versionRow({ app: c.path.split("/")[4], version: decodeURIComponent(c.path.split("/")[6]!) }), payload: { theme: {} } });
    }
    if (c.method === "GET" && /^\/admin\/v1\/experience\/[a-z]+\/activations$/.test(c.path)) {
      return json(200, { items: [activationRow({ app: c.path.split("/")[4] })], next_cursor: null });
    }
    if (c.method === "POST" && /^\/admin\/v1\/experience\/[a-z]+\/versions$/.test(c.path)) {
      return json(201, { ...versionRow({ app: c.path.split("/")[4], version: c.body.version, status: null, created_by: c.actor?.id }), payload: c.body.payload });
    }
    if (c.method === "POST" && /^\/admin\/v1\/experience\/[a-z]+\/(activate|rollback)$/.test(c.path)) {
      const kind = c.path.endsWith("rollback") ? "rollback" : "activate";
      return json(201, activationRow({ app: c.path.split("/")[4], kind, version: c.body.version ?? "0.9.0", reason: c.body.reason, activated_by: c.actor?.id ?? "" }));
    }
    if (key === `GET ${notes}/summary`) return json(200, WHATS_NEW_SUMMARY);
    if (key === `GET ${notes}`) return json(200, { items: [releaseNoteRow()], next_cursor: null });
    if (key === `POST ${notes}`) return json(201, releaseNoteRow({ ...c.body, created_by: c.actor?.id, updated_by: c.actor?.id }));
    const m = /^\/admin\/v1\/release-notes\/([^/]+)(\/[a-z]+)?$/.exec(c.path);
    if (m) {
      const sub = m[2] ?? "";
      if (c.method === "GET" && sub === "") return json(200, releaseNoteRow({ release_note_id: m[1] }));
      if (c.method === "GET" && sub === "/stats") {
        return json(200, {
          release_note_id: m[1],
          views_total: 57,
          views_by_lang: { ru: 30, uz: 27 },
          views_by_age: { kids: 0, teens: 7, adults: 50 },
          first_view_at: "2026-11-10T10:01:00Z",
          last_view_at: "2026-11-18T08:00:00Z",
        });
      }
      if (c.method === "PUT" && sub === "") {
        const { expected_version, ...content } = c.body;
        return json(200, releaseNoteRow({ ...content, release_note_id: m[1], version: expected_version + 1, updated_by: c.actor?.id }));
      }
      if (c.method === "POST" && sub === "/publish") {
        return json(201, releaseNoteRow({ release_note_id: m[1], status: "published", published_by: c.actor?.id, published_at: "2026-11-18T10:00:00Z", views_total: 0 }));
      }
      if (c.method === "POST" && sub === "/archive") {
        return json(201, releaseNoteRow({ release_note_id: m[1], status: "archived", archived_by: c.actor?.id, archived_at: "2026-11-18T10:00:00Z" }));
      }
    }
    return domainError(404, "NOT_FOUND");
  }

  private notifications(c: Call, key: string): Response {
    const T = "/admin/v1/notifications/templates";
    const K = "/admin/v1/notifications/campaigns";
    if (key === `GET ${T}`) return json(200, { items: [templateInfo()] });
    if (key === "GET /admin/v1/notifications/test-recipients") {
      return json(200, { items: [{ index: 0, label: "Тестовый чат 1 (••••4821)" }], chat_ids: ["-1004821"] });
    }
    if (key === `GET ${K}/summary`) return json(200, CAMPAIGN_SUMMARY);
    if (key === `GET ${K}`) return json(200, { items: [campaignRow()], next_cursor: null });
    if (key === `POST ${K}`) return json(201, campaignRow({ ...c.body, created_by: c.actor?.id }));
    const tm = /^\/admin\/v1\/notifications\/templates\/([^/]+)(?:\/versions(?:\/(\d+)(\/[a-z]+)?)?|\/(reset))?$/.exec(c.path);
    if (tm) {
      const [, k, v, verb, reset] = tm;
      if (c.method === "GET" && !c.path.includes("/versions") && !reset) {
        return json(200, { ...templateInfo({ key: k }), versions: [templateVersion({ key: k })] });
      }
      if (c.method === "POST" && c.path.endsWith("/versions")) {
        return json(201, templateVersion({ key: k, version: 3, status: "draft", texts: c.body.texts, note: c.body.note, created_by: c.actor?.id, activated_by: null, activated_at: null }));
      }
      if (c.method === "POST" && reset) return json(200, templateInfo({ key: k, active_version: null, active_since: null }));
      if (c.method === "POST" && verb === "/preview") {
        return json(200, { lang: c.body.lang, title: "Пора учиться", body: "Азиз, урок на 15 минут ждёт", button: null, telegram_text: "Пора учиться\n\nАзиз, урок на 15 минут ждёт" });
      }
      if (c.method === "POST" && verb === "/activate") return json(200, templateVersion({ key: k, version: Number(v), activated_by: c.actor?.id }));
      if (c.method === "POST" && verb === "/test") return json(200, { sent: true, delivery_id: "dlv-1", error: null });
    }
    const cm = /^\/admin\/v1\/notifications\/campaigns\/([^/]+)(\/[a-z]+)?$/.exec(c.path);
    if (cm) {
      const [, id, sub = ""] = cm;
      if (c.method === "GET" && sub === "") return json(200, campaignRow({ campaign_id: id }));
      if (c.method === "PATCH" && sub === "") {
        const { expected_version, ...patch } = c.body;
        return json(200, campaignRow({ ...patch, campaign_id: id, version: expected_version + 1 }));
      }
      if (c.method === "POST" && sub === "/estimate") {
        return json(200, { audience: 1200, by_lang: { ru: 700, uz: 500 }, frequency_capped: 40, computed_at: "2026-11-18T10:00:00Z" });
      }
      if (c.method === "POST" && sub === "/preview") {
        return json(200, { lang: c.body.lang, title: "Новые уроки", body: "Азиз, новые уроки", button: null, telegram_text: "Новые уроки\n\nАзиз, новые уроки" });
      }
      if (c.method === "POST" && sub === "/test") return json(200, { sent: true, delivery_id: "dlv-2", error: null });
      if (c.method === "POST" && sub === "/schedule") {
        return json(200, campaignRow({ campaign_id: id, status: "scheduled", version: 2, send_at: c.body.send_at, scheduled_by: c.actor?.id, scheduled_at: "2026-11-18T10:00:00Z" }));
      }
      if (c.method === "POST" && sub === "/unschedule") return json(200, campaignRow({ campaign_id: id, status: "draft", version: 3 }));
      if (c.method === "POST" && sub === "/stop") {
        return json(200, campaignRow({ campaign_id: id, status: "stopped", stopped_by: c.actor?.id, stopped_at: "2026-11-18T10:00:00Z", stop_reason: c.body.reason }));
      }
    }
    return domainError(404, "NOT_FOUND");
  }
}

// ---------------------------------------------------------------- harness

let sharedRedis: Redis | undefined;
export function redis(): Redis {
  sharedRedis ??= new Redis(TEST_REDIS_URL, { family: 0, maxRetriesPerRequest: 1 });
  return sharedRedis;
}
export async function closeRedis(): Promise<void> {
  if (sharedRedis) await sharedRedis.quit().catch(() => undefined);
  sharedRedis = undefined;
}

export interface Harness {
  app: App;
  fake: FakeDomains;
  logs: LogCapture;
  config: Config;
  clock: { t: number; advance(ms: number): void };
  close(): Promise<void>;
}

export async function makeHarness(
  env: Record<string, string> = {},
  deps: Pick<AppDeps, "responseProbe"> = {},
  patch?: (c: Config) => void,
): Promise<Harness> {
  const config = testConfig(env);
  patch?.(config);
  const fake = new FakeDomains();
  const logs = new LogCapture();
  const clock = {
    t: Date.now(),
    advance(ms: number) {
      this.t += ms;
    },
  };
  const app = await buildApp(config, { redis: redis(), fetchImpl: fake.fetch, logStream: logs, now: () => clock.t, ...deps });
  await app.ready();
  return {
    app,
    fake,
    logs,
    config,
    clock,
    async close() {
      await app.close();
      const keys = await redis().keys(`${config.redisKeyPrefix}*`);
      if (keys.length) await redis().del(...keys);
    },
  };
}

export interface Session {
  id: string;
  csrf: string;
  me: Me;
  cookie: string;
}

export function cookieOf(setCookie: string | string[] | undefined): string {
  const v = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return v.split(";")[0]!.split("=").slice(1).join("=");
}

/** Заголовки браузера admin-web (+ cookie и CSRF, если есть сессия). */
export function browser(s?: Pick<Session, "id" | "csrf"> | null, extra: Record<string, string> = {}): Record<string, string> {
  return {
    origin: ORIGIN,
    "user-agent": UA,
    ...(s ? { cookie: `__Host-tilhero_admin=${s.id}`, "x-csrf-token": s.csrf } : {}),
    ...extra,
  };
}

/** Вход сотрудника без MFA (одним шагом). */
export async function login(h: Harness, staff: FakeStaff, ip = "198.51.100.10"): Promise<Session> {
  const res = await h.app.inject({
    method: "POST",
    url: "/admin/v1/auth/login",
    headers: browser(),
    remoteAddress: ip,
    payload: { email: staff.email, password: staff.password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const step = res.json() as LoginStep;
  if (step.next !== "done" || !step.me) throw new Error(`login not done: ${step.next}`);
  const id = cookieOf(res.headers["set-cookie"]);
  return { id, csrf: step.me.csrf_token, me: step.me, cookie: String(res.headers["set-cookie"]) };
}

/** Step-up (TOTP): id сессии ротируется — новая cookie записывается в s. */
export async function stepUp(h: Harness, s: Session, code = TOTP_OK) {
  const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/step-up", headers: browser(s), payload: { code } });
  if (res.statusCode === 200) s.id = cookieOf(res.headers["set-cookie"]);
  return res;
}

/** Создать сотрудника роли и войти. */
export async function loginAs(h: Harness, role: RoleCode, p: Partial<FakeStaff> = {}): Promise<{ staff: FakeStaff; s: Session }> {
  const staff = h.fake.addStaff({ role, ...p });
  return { staff, s: await login(h, staff) };
}

/** Фиксированное окно лимита — минута; не начинаем серию в последние секунды окна. */
export async function avoidWindowEdge(): Promise<void> {
  const into = Date.now() % 60_000;
  if (into > 55_000) await new Promise((r) => setTimeout(r, 60_000 - into + 50));
}

/**
 * Тестовая обвязка admin-bff: реальный Redis (DB 14, уникальный префикс ключей на приложение), домены — in-memory
 * подделка через fetchImpl. Подделка проверяет внутренний JWT (aud = домен, iss = admin-bff) и запоминает actor —
 * как настоящие домены (verifyInternalToken из ts-common).
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
  sourceRegistry: "http://source-registry.test",
  discovery: "http://discovery.test",
  providerGateway: "http://provider-gateway.test",
  events: "http://events.test",
  offers: "http://offers.test",
  news: "http://news.test",
  watch: "http://watch.test",
  aiControl: "http://ai-control.test",
  aiConcierge: "http://ai-concierge.test",
  opsMonitor: "http://ops-monitor.test",
} as const;
export type Service = keyof typeof URLS;
const AUD: Record<Service, string> = {
  adminIdentity: "admin-identity",
  userAdmin: "user-admin",
  identity: "identity-consent",
  support: "support",
  audit: "audit",
  experience: "experience-config",
  sourceRegistry: "source-registry",
  discovery: "discovery",
  providerGateway: "provider-gateway",
  events: "events",
  offers: "offers",
  news: "news",
  watch: "watch",
  aiControl: "ai-control",
  aiConcierge: "ai-concierge",
  opsMonitor: "ops-monitor",
};

export function testConfig(env: Record<string, string> = {}): Config {
  const prefix = `abfftest:${randomUUID().slice(0, 8)}:`;
  return loadConfig({
    NODE_ENV: "test",
    ENV: "test",
    INTERNAL_JWT_SECRET: INTERNAL_SECRET,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_KEY_PREFIX: prefix,
    RATE_LIMIT_KEY_PREFIX: prefix, // спринт 9: ключи лимитера — тоже с префиксом приложения (в т. ч. при ENV=dev)
    ADMIN_WEB_ORIGIN: ORIGIN,
    ADMIN_IDENTITY_URL: URLS.adminIdentity,
    USER_ADMIN_URL: URLS.userAdmin,
    IDENTITY_URL: URLS.identity,
    SUPPORT_URL: URLS.support,
    AUDIT_URL: URLS.audit,
    EXPERIENCE_URL: URLS.experience,
    SOURCE_REGISTRY_URL: URLS.sourceRegistry,
    DISCOVERY_URL: URLS.discovery,
    PROVIDER_GATEWAY_URL: URLS.providerGateway,
    EVENTS_URL: URLS.events,
    OFFERS_URL: URLS.offers,
    NEWS_URL: URLS.news,
    WATCH_URL: URLS.watch,
    AI_CONTROL_URL: URLS.aiControl,
    AI_CONCIERGE_URL: URLS.aiConcierge,
    OPS_MONITOR_URL: URLS.opsMonitor,
    UPSTREAM_RETRIES: "0",
    UPSTREAM_TIMEOUT_MS: "2000",
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

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

export class FakeDomains {
  readonly calls: Call[] = [];
  readonly staff = new Map<string, FakeStaff>();
  readonly challenges = new Map<string, { staff_id: string; step: string }>();
  readonly overrides = new Map<string, Handler>();
  readonly down = new Set<Service>();
  readonly healthStatus = new Map<Service, number>();

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
    if (url.pathname === "/health/ready") {
      const st = this.healthStatus.get(service) ?? 200;
      return json(st, { status: st === 200 ? "ok" : "degraded", checks: {} });
    }
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
    if (c.service === "adminIdentity") {
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
          otpauth_uri: `otpauth://totp/TilHero%20Admin:${s.email}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`,
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
      if (key === "GET /admin/v1/staff") return json(200, { items: [], next_cursor: null });
      if (key === "POST /admin/v1/staff") {
        const created = staffRow({ staff_id: randomUUID(), email: c.body.email, display_name: c.body.display_name, role: c.body.role, must_change_password: true });
        return json(201, { staff: created, temporary_password: "Tmp-Secret-Passw0rd-XYZ", approval: null });
      }
      if (c.method === "PATCH" && c.path.startsWith("/admin/v1/staff/")) {
        const s = this.staff.get(c.path.split("/").pop()!);
        if (s && c.body.status === "DISABLED") {
          s.status = "DISABLED";
          s.session_version += 1;
        }
        if (c.body.role === "super_admin") return json(202, { approval: approvalRow({ kind: "staff.role_grant" }) });
        const id = c.path.split("/").pop()!;
        return json(200, staffRow({ staff_id: id, ...(s ? { email: s.email, display_name: s.display_name, role: s.role, status: s.status } : {}) }));
      }
      if (key === "GET /admin/v1/roles") return json(200, { items: [], permissions: [] });
      if (key === "GET /admin/v1/approvals") return json(200, { items: [], next_cursor: null });
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
    }
    if (c.service === "userAdmin") {
      if (key === "GET /admin/v1/users/stats") {
        return json(200, {
          total: 120,
          new_in_period: 7,
          onboarding_completed_pct: 61.5,
          by_status: { ACTIVE: 110, DISABLED: 5, DELETION_REQUESTED: 3, DELETED: 2 },
          active_in_period: 64,
          active_today: 21,
        });
      }
      if (key === "GET /admin/v1/users") return json(200, { items: [], next_cursor: null });
      const m = /^\/admin\/v1\/users\/([^/]+)$/.exec(c.path);
      if (c.method === "GET" && m) return json(200, userCard(m[1]!));
    }
    if (c.service === "support") {
      if (key === "GET /admin/v1/support/stats") {
        return json(200, { open: 4, in_progress: 2, waiting_customer: 1, breached: 1, avg_first_response_minutes: 42, avg_resolution_minutes: null });
      }
      if (key === "GET /admin/v1/support/tickets") return json(200, { items: [ticketSummary(c.query.user_id ?? null)], next_cursor: null });
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
            created_at: "2026-10-08T11:00:00Z",
          });
        }
      }
      if (key === "GET /admin/v1/support/sla-policies") return json(200, { items: [], category_defaults: {} });
    }
    if (c.service === "identity" && c.method === "POST" && /^\/admin\/v1\/users\/[^/]+\/reveal$/.test(c.path)) {
      return json(200, { field: "telegram_user_id", value: "777000123456789", expires_in: 60 });
    }
    if (c.service === "audit") {
      if (key === "POST /internal/v1/records") return json(201, { seq: 1, record_id: c.body.record_id });
      if (key === "GET /admin/v1/audit/records") return json(200, { items: [], next_cursor: null });
      if (key === "GET /admin/v1/audit/verify") return json(200, { valid: true, checked: 0, first_seq: null, last_seq: null, broken_at_seq: null });
    }
    if (c.service === "experience") {
      if (c.method === "GET" && c.path.endsWith("/state")) return json(200, { app: "admin", current: null, previous_version: null });
      if (c.method === "POST" && c.path.endsWith("/activate")) {
        return json(200, activationRow({ app: c.path.split("/")[4]!, version: c.body.version, reason: c.body.reason, activated_by: c.actor?.id ?? "" }));
      }
    }
    return domainError(404, "NOT_FOUND");
  }
}

export const TICKET_ID = "5b1f0d0e-1111-4c2b-9a51-0d6c7a1e2f30";
export const USER_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
export const OPERATOR_ID = "11111111-2222-4333-8444-555555555555";

export function userCard(id: string) {
  return {
    user_id: id,
    username: "test_user_1",
    display_name: "Тест",
    telegram_id_masked: "••••••789",
    locale: "ru",
    status: "ACTIVE",
    onboarding_completed: true,
    open_tickets: 1,
    tickets_total: 2,
    created_at: "2026-10-01T10:00:00Z",
    last_seen_at: "2026-10-08T10:00:00Z",
    plan: "FREE",
    consent: { policy_version: "1.0", purposes: ["core"], accepted_at: "2026-10-01T10:00:00Z", age_confirmed_18_plus: true, revoked_at: null },
    security: { pin_enabled: true, biometric_enabled: false },
    preferences: { onboarding_completed: true, updated_at: null, changed_fields: [] },
    refreshed_at: "2026-10-09T10:00:00Z",
  };
}

export function ticketSummary(userId: string | null) {
  return {
    ticket_id: TICKET_ID,
    number: "TCK-3001",
    user_id: userId ?? USER_ID,
    channel: "telegram",
    category: "PRICE",
    subject: "Цена отличается",
    status: "IN_PROGRESS",
    priority: "normal",
    assignee_id: OPERATOR_ID,
    has_event_context: true,
    anonymized: false,
    created_at: "2026-10-08T10:00:00Z",
    updated_at: "2026-10-08T10:00:00Z",
    last_message_at: "2026-10-08T10:00:00Z",
    first_response_at: null,
    sla_first_response_at: "2026-10-08T12:00:00Z",
    sla_resolution_at: "2026-10-09T10:00:00Z",
    sla_target: "first_response",
    sla_due_at: "2026-10-08T12:00:00Z",
    sla_state: "breached",
    sla_paused: false,
  };
}

export function ticketDetail() {
  return {
    ...ticketSummary(USER_ID),
    context: {
      event_id: "evt-1",
      offer_id: null,
      provider_id: null,
      deeplink: "https://tickets.example/evt-1",
      price_snapshot: { amount: "850.00", currency: "USD" },
      fetched_at: "2026-10-08T09:00:00Z",
      trace_id: null,
      client_version: "2.0.3",
    },
    correlation_id: null,
    resolved_at: null,
    closed_at: null,
    user_unread_operator_replies: 0,
    messages: [
      { message_id: randomUUID(), sender_type: "user", visibility: "public", author_id: null, author_name: null, text: "Помогите", created_at: "2026-10-08T10:00:00Z" },
      { message_id: randomUUID(), sender_type: "operator", visibility: "internal", author_id: OPERATOR_ID, author_name: null, text: "заметка", created_at: "2026-10-08T10:05:00Z" },
    ],
    status_history: [],
    escalations: [],
  };
}

/** Полные (по контракту admin.ts) ответы доменов — матрица маршрутов проверяет их строгим Ajv. */
export function staffRow(p: Record<string, unknown> = {}) {
  return {
    staff_id: randomUUID(),
    email: "row@tilhero.test",
    display_name: "Сотрудник",
    role: "support",
    status: "ACTIVE",
    auth_provider: "local",
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
    approval_id: randomUUID(),
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
    created_by: OPERATOR_ID,
    created_at: "2026-10-01T00:00:00Z",
    status: "current",
    ...p,
  };
}

export function auditRow(p: Record<string, unknown> = {}) {
  return {
    seq: 1,
    record_id: randomUUID(),
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

/** Клиентская форма обращения (bff.ts Ticket) — ответ client-view. */
export function clientTicket() {
  return {
    ticket_id: TICKET_ID,
    number: "TCK-3001",
    category: "PRICE",
    subject: "Цена отличается",
    status: "IN_PROGRESS",
    created_at: "2026-10-08T10:00:00Z",
    updated_at: "2026-10-08T10:00:00Z",
    last_message_at: "2026-10-08T10:00:00Z",
    unread_operator_replies: 0,
    context: { event_id: "evt-1", client_version: "2.0.3" },
    sla_first_response_at: "2026-10-08T12:00:00Z",
    messages: [{ message_id: randomUUID(), sender_type: "user", author_name: null, text: "Помогите", created_at: "2026-10-08T10:00:00Z" }],
    status_history: [{ status: "NEW", at: "2026-10-08T10:00:00Z" }],
  };
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

// ---------------------------------------------------------------- спринт 4: ответы доменов по контракту admin.ts

export const SOURCE_ID = "3c9f1e2a-7b4d-4e8f-9a1b-2c3d4e5f6a7b";
export const REVIEW_ID = "8e7d6c5b-4a39-4281-9f0e-1d2c3b4a5968";
export const REVIEW_ID_2 = "8e7d6c5b-4a39-4281-9f0e-1d2c3b4a5969";
export const RUN_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

export function sourceRow(p: Record<string, unknown> = {}) {
  return {
    source_id: SOURCE_ID,
    slug: "iticket-uz",
    name: "iTicket.uz",
    country_code: "UZ",
    tier: "OFFICIAL_TICKET_PROVIDER",
    event_domains: ["iticket.uz"],
    media_domains: ["cdn.iticket.uz"],
    listing_pages: [{ url: "https://iticket.uz/events", city: "Tashkent", category: null }],
    enabled: true,
    js_only: false,
    notes: null,
    version: 3,
    created_at: "2026-10-10T00:00:00Z",
    updated_at: "2026-10-10T00:00:00Z",
    updated_by: null,
    ...p,
  };
}

/** Исправление 9.3: маппинг театра Ауэзова (как docs/sprint9/json_api_auezov.json) и ответ предпросмотра. */
export function jsonApiMapping(p: Record<string, unknown> = {}) {
  return {
    url: "https://server.auezov-theatre.kz/performances/",
    params: { is_active: "true", status: "active", start_time_from: "{today}", start_time_to: "{today+183d}" },
    page_param: "page",
    per_page_param: "per_page",
    per_page: 100,
    max_pages: 3,
    items_path: ["data.items", "data"],
    fields: { id: "id", title: "title", start: "start_time", end: "end_time", venue: "venue.name", hall: "hall.name", image: "media_items.url", age: "age_rating", status: "status", description: "short_description" },
    image_where: { type: "photo", purpose: "cover" },
    image_base: "https://server.auezov-theatre.kz",
    url_template: "https://auezov-theatre.kz/ru/afisha/performance/{id}",
    status_exclude: ["cancelled", "canceled"],
    locale_order: ["ru", "kz", "en"],
    start_tz: "Asia/Almaty",
    ...p,
  };
}

export function jsonApiPreviewRow(p: Record<string, unknown> = {}) {
  return {
    ok: true,
    code: null,
    reason: null,
    request_url: "https://server.auezov-theatre.kz/performances/?is_active=true&per_page=100&page=1",
    items_path: "data.items",
    items_total: 2,
    events: [
      {
        id: "101",
        title: "Абай",
        local_date: "2026-11-05",
        local_time: "18:00",
        timezone: "Asia/Almaty",
        utc: "2026-11-05T13:00:00Z",
        end_local_date: null,
        end_local_time: null,
        venue: "Театр им. М. Ауэзова — Большой зал",
        city: "Almaty",
        url: "https://auezov-theatre.kz/ru/afisha/performance/101",
        image: "https://server.auezov-theatre.kz/media/cover-101.jpg",
        price: null,
        category: "culture.theatre",
        age: "12+",
        status: "active",
        description: "Драма",
      },
    ],
    rejected: [{ index: 1, id: "103", reason: "status_excluded" }],
    keys: [
      { path: "id", sample: "101" },
      { path: "title.ru", sample: "Абай" },
    ],
    keys_scope: "item",
    skipped: { status_excluded: 1 },
    checked_at: "2026-10-18T10:00:00Z",
    ...p,
  };
}

export const CONTENT_HASH = "a".repeat(64);

export function reviewItemRow(p: Record<string, unknown> = {}) {
  return {
    review_id: REVIEW_ID,
    status: "OPEN",
    provider: "aiweb.iticket-uz",
    source_name: "iTicket.uz",
    source_url: "https://iticket.uz/events/concert-1",
    tier: "OFFICIAL_TICKET_PROVIDER",
    confidence: 0.55,
    reasons: ["LOW_CONFIDENCE"],
    title: "Концерт",
    start: { local_date: "2026-11-01", local_time: "19:00" },
    city: "Tashkent",
    country_code: "UZ",
    received_at: "2026-10-10T08:00:00Z",
    content_hash: CONTENT_HASH,
    ...p,
  };
}

export function reviewDetailRow(p: Record<string, unknown> = {}) {
  return {
    ...reviewItemRow(),
    facts: { title: "Концерт", venue: { name: "Дворец искусств", city: "Tashkent" } },
    media: [
      {
        url: "https://cdn.iticket.uz/a.jpg",
        provenance: { provider: "aiweb.iticket-uz", source_url: "https://iticket.uz/events/concert-1", fetched_at: "2026-10-10T08:00:00Z", rights: "official_site" },
      },
    ],
    matched_event_id: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    decision_reason: null,
    event_id: null,
    ...p,
  };
}

export function runRow(p: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    trigger: "manual",
    status: "RUNNING",
    started_at: "2026-10-10T09:00:00Z",
    finished_at: null,
    scopes_total: 10,
    scopes_done: 0,
    provider_calls: 0,
    candidates_seen: 0,
    candidates_emitted: 0,
    ai: { llm_calls: 0, pages_fetched: 0, input_tokens: 0, output_tokens: 0, cost_usd: "0.0000" },
    errors: [],
    ...p,
  };
}

export function budgetRow(p: Record<string, unknown> = {}) {
  return {
    day: "2026-10-10",
    spent_usd: "0.4213",
    reserved_usd: "0.0100",
    budget_usd: "1.00",
    pages_used: 41,
    pages_limit: 300,
    paused: null,
    model: "claude-haiku-4-5",
    ...p,
  };
}

/** Строка provider-gateway `GET /internal/v1/providers/ai_web/sources` (последний обход источника). */
export function crawlStatsRow(p: Record<string, unknown> = {}) {
  return {
    slug: "iticket-uz",
    last_crawl_at: "2026-10-10T06:12:00Z",
    outcome: "ok",
    code: null,
    pages: 2,
    events_found: 14,
    skipped: { date_mismatch: 3, link_foreign: 1, category: 2 },
    notes: { part_truncated: 1 },
    llm_calls: 2,
    cost_usd_last: "0.0231",
    cost_usd_day: "0.0462",
    ...p,
  };
}

/** Подделки доменов спринта 4 (happy path): source-registry, events (очередь), discovery, provider-gateway. */
export function fakeSprint4(f: FakeDomains): void {
  f.on("sourceRegistry", "GET", "/internal/v1/sources", () => json(200, { items: [sourceRow()], next_cursor: null }));
  f.on("sourceRegistry", "GET", `/internal/v1/sources/${SOURCE_ID}`, () =>
    json(200, { ...sourceRow(), changes: [{ version: 3, actor_id: null, changed_fields: ["enabled"], reason: "seed", at: "2026-10-10T00:00:00Z" }] }),
  );
  f.on("sourceRegistry", "POST", "/internal/v1/sources", (c) => {
    const { reason: _r, ...input } = c.body;
    return json(201, sourceRow({ ...input, source_id: SOURCE_ID, version: 1, updated_by: c.actor?.id ?? null }));
  });
  f.on("sourceRegistry", "PATCH", `/internal/v1/sources/${SOURCE_ID}`, (c) => {
    const { reason: _r, expected_version, ...changes } = c.body;
    return json(200, sourceRow({ ...changes, version: Number(expected_version) + 1, updated_by: c.actor?.id ?? null }));
  });
  f.on("events", "GET", "/internal/v1/review", () => json(200, { items: [reviewItemRow()], next_cursor: null }));
  f.on("events", "GET", `/internal/v1/review/${REVIEW_ID}`, () => json(200, reviewDetailRow()));
  f.on("events", "POST", `/internal/v1/review/${REVIEW_ID}:accept`, (c) =>
    json(200, { review: reviewDetailRow({ status: "ACCEPTED", decided_by: c.actor?.id, decision_note: c.body.note, event_id: "evt-9" }), event_id: "evt-9" }),
  );
  f.on("events", "POST", `/internal/v1/review/${REVIEW_ID}:reject`, (c) =>
    json(200, { review: reviewDetailRow({ status: "REJECTED", decided_by: c.actor?.id, decision_reason: c.body.reason_code, decision_note: c.body.note }) }),
  );
  f.on("events", "POST", `/internal/v1/review/${REVIEW_ID}:correct`, (c) =>
    json(200, { review: reviewDetailRow({ status: "CORRECTED", decided_by: c.actor?.id, decision_note: c.body.note, event_id: "evt-10" }), event_id: "evt-10" }),
  );
  // исправление 5.1: массовое отклонение и возврат из «Не подтверждено»
  f.on("events", "POST", "/internal/v1/review:bulk-reject", (c) =>
    json(200, { results: (c.body.items as Array<{ review_id: string }>).map((x) => ({ review_id: x.review_id, status: "REJECTED" })) }),
  );
  f.on("events", "POST", "/internal/v1/review:bulk-reopen", (c) =>
    json(200, { results: (c.body.items as Array<{ review_id: string }>).map((x) => ({ review_id: x.review_id, status: "OPEN", code: null })) }),
  );
  f.on("events", "POST", `/internal/v1/review/${REVIEW_ID}:reopen`, (c) =>
    json(200, { review: reviewDetailRow({ status: "OPEN", decision_note: c.body.note, expires_at: "2026-10-18T08:00:00Z", expired_at: null }) }),
  );
  f.on("discovery", "GET", "/internal/v1/runs", () => json(200, { items: [runRow({ status: "COMPLETED" })], next_cursor: null }));
  f.on("discovery", "GET", `/internal/v1/runs/${RUN_ID}`, () => json(200, runRow()));
  f.on("discovery", "POST", "/internal/v1/runs", () => json(202, runRow()));
  f.on("providerGateway", "GET", "/internal/v1/providers/ai_web/budget", () => json(200, budgetRow()));
  f.on("providerGateway", "GET", "/internal/v1/providers/ai_web/sources", () =>
    json(200, { items: [crawlStatsRow(), crawlStatsRow({ slug: "kassir-kz", outcome: "skipped", code: "SOURCE_ROBOTS_DISALLOWED", pages: 0, events_found: 0, skipped: {}, notes: {}, llm_calls: 0, cost_usd_last: "0.0000" })] }),
  );
  // исправление 9.3: предпросмотр страницы «JSON API»
  f.on("providerGateway", "POST", "/internal/v1/providers/ai_web/json_api:preview", () => json(200, jsonApiPreviewRow()));
  f.on("providerGateway", "PUT", "/internal/v1/providers/ai_web/pause", (c) =>
    json(200, budgetRow({ paused: c.body.paused ? { paused: true, reason: c.body.reason, by: c.actor?.id ?? "", at: "2026-10-10T10:00:00Z" } : null })),
  );
}

// ---------------------------------------------------------------- спринт 5: поставщики поездок, снимки предложений

export const OFFER_ID = "0ffe0000-0000-4000-8000-000000000001";
export const OFFER_USER_ID = "5f1c2a3b-0000-4000-8000-00000000e601";
export const OFFER_EVENT_ID = "e1000000-0000-4000-8000-000000000042";

/** Строка provider-gateway `GET /internal/v1/providers` (ProviderStatus) — как у адаптеров событий. */
export function providerStatusRow(p: Record<string, unknown> = {}) {
  return {
    provider: "aviasales",
    configured: true,
    enabled: true,
    breaker: "closed",
    quota: { day_used: 412, day_limit: 20000, resets_at: "2026-10-12T00:00:00Z" },
    last_success_at: "2026-10-11T06:58:00Z",
    last_error_code: null,
    last_error_at: null,
    ai_budget: null,
    ...p,
  };
}

const MAP = {
  yandex: "https://yandex.ru/maps/?pt=76.9420,43.2550&z=16&l=map",
  google: "https://www.google.com/maps/search/?api=1&query=43.2550,76.9420",
  osm: "https://www.openstreetmap.org/?mlat=43.2550&mlon=76.9420#map=17/43.2550/76.9420",
  dgis: "https://2gis.ru/geo/76.9420,43.2550",
};

/** Ответ offers `GET /internal/v1/offers/{id}` для admin-bff (§2.4): снимок Comfort, 2 путешественника. */
export function offerSnapshotRow(p: Record<string, unknown> = {}, offer: Record<string, unknown> = {}) {
  return {
    offer_id: OFFER_ID,
    user_id: OFFER_USER_ID,
    event_id: OFFER_EVENT_ID,
    tier: "comfort",
    travellers: 2,
    created_at: "2026-10-11T07:00:00Z",
    expires_at: "2026-10-11T08:00:00Z",
    offer: {
      offer_id: OFFER_ID,
      tier: "comfort",
      status: "complete",
      ticket: { status: "ok", price_per_person: "85.00", currency: "USD", in_total: true, provider: "ticketmaster", deeplink: "https://www.ticketmaster.com/event/1", fetched_at: "2026-10-11T06:40:00Z" },
      flight: {
        status: "ok", provider: "aviasales", origin: "TAS", destination: "ALA",
        depart_at: "2026-11-13T07:40:00+05:00", return_at: "2026-11-16T19:05:00+06:00",
        airline: "HY", flight_number: "763", transfers: 0, return_transfers: 0, duration_minutes: 95, duration_back_minutes: 100,
        price_per_person: "142.00", total: "284.00", deeplink: "https://www.aviasales.com/search/TAS1311ALA16111?t=x&marker=123",
        fetched_at: "2026-10-11T06:59:00Z", dates_shifted: false,
      },
      hotel: {
        status: "ok", provider: "liteapi", hotel_id: "lp1beec", name: "Rixos Almaty", stars: 5, rating: "9.1", review_count: 1840,
        distance_m: 1830, lat: "43.2550", lon: "76.9420", photo_url: null, nights: 3, rooms: 1, total: "390.00", refundable: true,
        board: "Breakfast included", deeplink: "https://book.tilhero.app/hotels/lp1beec?checkin=2026-11-13", map: MAP, fetched_at: "2026-10-11T06:59:30Z",
      },
      totals: { total: "844.00", per_person: "422.00", currency: "USD", missing: [] },
      expires_at: "2026-10-11T08:00:00Z",
      ...offer,
    },
    trip: {
      kind: "trip", reason: null,
      destination: { city: "Алматы", country_code: "KZ", iata: "ALA", venue: { name: "Almaty Arena", lat: "43.2041", lon: "76.8916", precision: "venue", map: MAP } },
      out_date: "2026-11-13", back_date: "2026-11-16", nights: 3,
    },
    departure: { iata: "TAS", city: "Ташкент", chosen_by: "cheapest" },
    notes: [],
    ...p,
  };
}

/** Подделки спринта 5 (happy path): статус поставщиков provider-gateway, снимок offers. */
export function fakeSprint5(f: FakeDomains): void {
  f.on("providerGateway", "GET", "/internal/v1/providers", () =>
    json(200, [
      providerStatusRow({ provider: "ticketmaster" }),
      providerStatusRow(),
      providerStatusRow({ provider: "liteapi", breaker: "open", last_error_code: "PROVIDER_UNAVAILABLE", last_error_at: "2026-10-11T06:50:00Z" }),
      providerStatusRow({ provider: "osm", configured: false, quota: { day_used: 0, day_limit: 2000, resets_at: "2026-10-12T00:00:00Z" }, last_success_at: null }),
    ]),
  );
  f.on("offers", "GET", `/internal/v1/offers/${OFFER_ID}`, () => json(200, offerSnapshotRow()));
  for (const name of ["aviasales", "liteapi", "osm", "cbu"]) {
    f.on("providerGateway", "POST", `/internal/v1/travel/providers/${name}:probe`, () =>
      json(200, { ok: true, latency_ms: 412, code: null, reason: null, http_status: 200, checked_at: "2026-10-11T09:30:00Z" }),
    );
  }
}

// ---------------------------------------------------------------- спринт 6: новости (news) и слежения (watch)

export const NEWS_SOURCE_ID = "a6000000-0000-4000-8000-000000000001";
export const NEWS_ID = "b6000000-0000-4000-8000-000000000001";
export const NEWS_EVENT_ID = "e6000000-0000-4000-8000-000000000042";

export function newsSourceRow(p: Record<string, unknown> = {}) {
  return {
    source_id: NEWS_SOURCE_ID,
    slug: "formula1-latest",
    name: "Formula 1 — Latest News",
    kind: "official",
    mode: "rss",
    feed_url: "https://www.formula1.com/en/latest/all.xml",
    page_url: null,
    site_domain: "formula1.com",
    extra_domains: [],
    interests: ["sport.motorsport"],
    entities: ["Formula 1"],
    country_code: null,
    lang: "en",
    display: "summary",
    category_filter: null,
    enabled: true,
    health: { last_fetch_at: "2026-10-11T08:00:00Z", last_ok_at: "2026-10-11T08:00:00Z", last_error: null, items_24h: 7 },
    version: 3,
    updated_at: "2026-10-11T07:00:00Z",
    ...p,
  };
}

export function newsItemRow(p: Record<string, unknown> = {}) {
  return {
    news_id: NEWS_ID,
    kind: "article",
    title: "Гран-при Абу-Даби: продажи билетов открыты",
    summary_ru: "Организаторы открыли продажу билетов на финал сезона.",
    summary_en: "Tickets for the season finale are on sale.",
    url: "https://www.formula1.com/en/latest/article/abu-dhabi-tickets.html",
    source: { source_id: NEWS_SOURCE_ID, name: "Formula 1 — Latest News", domain: "formula1.com" },
    published_at: "2026-10-11T06:00:00Z",
    collected_at: "2026-10-11T08:00:00Z",
    significance: 0.82,
    interests: ["sport.motorsport"],
    entities: ["Formula 1"],
    event_ids: [NEWS_EVENT_ID],
    hidden: false,
    hidden_reason: null,
    hidden_at: null,
    hidden_by: null,
    ...p,
  };
}

export function newsCheckRow(p: Record<string, unknown> = {}) {
  return {
    ok: true,
    items: [
      { url: "https://www.formula1.com/en/latest/article/a.html", title: "Новость A", published_at: "2026-10-11T06:00:00Z", dropped: null },
      { url: "https://www.formula1.com/en/latest/article/b.html", title: "Новость B", published_at: null, dropped: null },
    ],
    items_total: 10,
    errors: [],
    checked_at: "2026-10-11T09:00:00Z",
    ...p,
  };
}

export function watchStatsRow(p: Record<string, unknown> = {}) {
  return {
    active: 128,
    paused: 9,
    ended_24h: 3,
    rechecks_24h: 412,
    changes_24h: { price_drop: 6, price_rise: 4, lifecycle: 2, tickets: 1, flight: 0, hotel: 0 },
    notifications_24h: { immediate: 2, digest: 6, suppressed: 1 },
    errors_24h: 5,
    next_batch_at: "2026-10-11T12:00:00Z",
    ...p,
  };
}

export function fakeSprint6(f: FakeDomains): void {
  const SRC = "/internal/v1/news/sources";
  f.on("news", "GET", SRC, () => json(200, { items: [newsSourceRow()], next_cursor: null }));
  f.on("news", "GET", `${SRC}/${NEWS_SOURCE_ID}`, () => json(200, newsSourceRow()));
  f.on("news", "POST", SRC, (c) => {
    const { reason: _r, ...input } = c.body;
    return json(201, newsSourceRow({ ...input, version: 1, health: { last_fetch_at: null, last_ok_at: null, last_error: null, items_24h: 0 } }));
  });
  f.on("news", "PATCH", `${SRC}/${NEWS_SOURCE_ID}`, (c) => {
    const { reason: _r, expected_version, ...changes } = c.body;
    return json(200, newsSourceRow({ ...changes, version: Number(expected_version) + 1 }));
  });
  f.on("news", "DELETE", `${SRC}/${NEWS_SOURCE_ID}`, () => new Response(null, { status: 204 }));
  f.on("news", "POST", `${SRC}/${NEWS_SOURCE_ID}:check`, () => json(200, newsCheckRow()));
  f.on("news", "POST", `${SRC}:check`, () => json(200, newsCheckRow()));
  f.on("news", "GET", "/internal/v1/news/items", () => json(200, { items: [newsItemRow()], next_cursor: null }));
  f.on("news", "POST", `/internal/v1/news/items/${NEWS_ID}:hide`, (c) =>
    json(200, newsItemRow({ hidden: true, hidden_reason: c.body.reason, hidden_at: "2026-10-11T09:30:00Z", hidden_by: c.actor?.id ?? null })),
  );
  f.on("news", "POST", `/internal/v1/news/items/${NEWS_ID}:unhide`, () => json(200, newsItemRow()));
  f.on("watch", "GET", "/internal/v1/watches:stats", () => json(200, watchStatsRow()));
}

// ---------------------------------------------------------------- исправление 6.1: лимиты AI

export function limitsRow(p: Record<string, unknown> = {}) {
  return {
    ai_daily_usd: "1.00",
    news_daily_usd: "0.20",
    pages_daily: 300,
    concierge_daily_usd: "1.00",
    evaluation_daily_usd: "0.30",
    source: "env",
    updated_by: null,
    updated_at: null,
    reason: null,
    defaults: { ai_daily_usd: "1.00", news_daily_usd: "0.20", pages_daily: 300, concierge_daily_usd: "1.00", evaluation_daily_usd: "0.30" },
    ...p,
  };
}

export function fakeLimits(f: FakeDomains): void {
  const L = "/internal/v1/providers/ai_web/limits";
  f.on("providerGateway", "GET", L, () => json(200, limitsRow()));
  f.on("providerGateway", "PUT", L, (c) => {
    const { reason, ...v } = c.body;
    const fix = (x: string) => (x.includes(".") ? x.padEnd(x.indexOf(".") + 3, "0") : `${x}.00`);
    const agent = (k: string, def: string) => (typeof v[k] === "string" ? fix(v[k]) : def);
    return json(
      200,
      limitsRow({
        ...v,
        ai_daily_usd: fix(v.ai_daily_usd),
        news_daily_usd: fix(v.news_daily_usd),
        concierge_daily_usd: agent("concierge_daily_usd", "1.00"),
        evaluation_daily_usd: agent("evaluation_daily_usd", "0.30"),
        source: "admin",
        updated_by: c.actor?.id ?? null,
        updated_at: "2026-10-12T08:00:00Z",
        reason,
      }),
    );
  });
  f.on("providerGateway", "DELETE", L, () => json(200, limitsRow()));
}

// ---------------------------------------------------------------- спринт 7: ai-control, ai-concierge, kill switch агентов

export const REQUEST_ID = "3c1a7d52-6f0e-4b8a-9d21-7e5f4a3b2c10";
export const ALERT_ID = "a1e2b3c4-d5f6-4a7b-8c9d-0e1f2a3b4c5d";
export const RUN_ID7 = "e7f1c2d3-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
export const CASE_ID = "c0ffee00-1234-4abc-8def-001122334455";
export const CONVERSATION_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
export const USAGE_ID = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
export const ACTIVATION_ID = "b0b0b0b0-1111-4222-8333-444455556666";
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);

export function aiAlertRow(p: Record<string, unknown> = {}) {
  return {
    alert_id: ALERT_ID,
    agent_id: "concierge",
    day: "2026-10-12",
    period: "day",
    threshold: 90,
    kind: "budget",
    spent_usd: "0.910000",
    limit_usd: "1.000000",
    auto_paused: false,
    detail: null,
    created_at: "2026-10-12T14:05:00Z",
    acked_by: null,
    acked_at: null,
    ...p,
  };
}

export function overviewAgentRow(p: Record<string, unknown> = {}) {
  return {
    agent_id: "concierge",
    name: "AI-консьерж",
    kind: "interactive",
    code_managed: false,
    day: { spent_usd: "0.910000", limit_usd: "1.000000", pct: 91.0, source: "env" },
    month: { cost_usd: "12.400000", cap_usd: "30.000000", pct: 41.3 },
    paused: null,
    state: "degraded",
    degrade_at_pct: 90,
    degraded_mode: "fallback_model",
    alerts: [aiAlertRow()],
    ...p,
  };
}

export function overviewRow(p: Record<string, unknown> = {}) {
  return {
    agents: [
      overviewAgentRow(),
      overviewAgentRow({ agent_id: "evaluation", name: "Test Console", kind: "system", day: { spent_usd: "0.020000", limit_usd: "0.300000", pct: 6.7, source: "env" }, month: { cost_usd: "0.400000", cap_usd: null, pct: null }, state: "normal", degraded_mode: "none", degrade_at_pct: 100, alerts: [] }),
      overviewAgentRow({ agent_id: "discovery", name: "Поиск событий", kind: "batch", code_managed: true, state: "normal", alerts: [] }),
      overviewAgentRow({ agent_id: "news", name: "Новости", kind: "batch", code_managed: true, state: "normal", alerts: [] }),
    ],
    provider: { anthropic: { paused: null } },
    gateway: "ok",
    at: "2026-10-12T15:00:00Z",
    ...p,
  };
}

export function gwAgentsRow(p: { paused?: Record<string, unknown>; provider?: unknown } = {}) {
  const b = (spent: string, limit: string, pct: number | null) => ({ day: "2026-10-12", spent_usd: spent, reserved_usd: "0.0100", limit_usd: limit, pct, source: "env" });
  return {
    provider: { anthropic: { paused: p.provider ?? null } },
    agents: [
      { agent_id: "concierge", paused: p.paused?.concierge ?? null, budget: b("0.9000", "1.00", 91) },
      { agent_id: "evaluation", paused: null, budget: b("0.0100", "0.30", 6) },
      { agent_id: "discovery", paused: null, budget: b("0.3000", "1.00", 31) },
      { agent_id: "news", paused: null, budget: b("0.0500", "0.20", 30) },
    ],
  };
}

export function aiAgentRow(p: Record<string, unknown> = {}) {
  return {
    agent_id: "concierge",
    name: "AI-консьерж",
    kind: "interactive",
    code_managed: false,
    skills: [
      { skill_id: "concierge.event", code_managed: false, active_version: 1, pending: [{ version: 2, status: "DRAFT" }] },
      { skill_id: "concierge.home", code_managed: false, active_version: 1, pending: [] },
    ],
    degraded_mode: "fallback_model",
    degrade_at_pct: 90,
    per_request_max_usd: "0.050000",
    monthly_cap_usd: "30.000000",
    max_tool_calls: 3,
    model_fallback: "claude-haiku-4-5",
    tools_whitelist: ["reprice_offer", "set_direct_only", "change_departure", "set_hotel_distance", "extend_trip_days", "find_similar_event"],
    config_version: 4,
    updated_by: "system",
    updated_at: "2026-10-12T00:00:00Z",
    ...p,
  };
}

export function kpiRow(p: Record<string, unknown> = {}) {
  return {
    from: "2026-10-06T00:00:00Z",
    to: "2026-10-13T00:00:00Z",
    requests: 120,
    calls: 180,
    success_rate: 0.975,
    retry_rate: 0.02,
    tokens_in: 400_000,
    tokens_out: 90_000,
    cache_read: 120_000,
    cache_write: 30_000,
    llm_cost_usd: "1.234567",
    external_cost_usd: "0.010000",
    total_cost_usd: "1.244567",
    avg_cost_per_request: "0.010371",
    cost_per_active_user: "0.124457",
    active_users: 10,
    unpriced_calls: 0,
    p50_ms: 4200,
    p95_ms: 9100,
    ...p,
  };
}

export function agentsUsageRow() {
  return {
    from: "2026-10-06T00:00:00Z",
    to: "2026-10-13T00:00:00Z",
    gateway: "ok",
    items: [
      {
        agent_id: "concierge",
        name: "AI-консьерж",
        kind: "interactive",
        code_managed: false,
        calls: 150,
        requests: 100,
        success_rate: 0.98,
        retry_rate: 0.01,
        tokens_in: 300_000,
        tokens_out: 70_000,
        cache_read: 100_000,
        cache_write: 20_000,
        total_cost_usd: "1.000000",
        avg_cost_usd: "0.010000",
        p50_ms: 4000,
        p95_ms: 9000,
        external_api_share: 0.01,
        cost_trend: [{ day: "2026-10-12", cost_usd: "0.200000" }],
        budget_today: { spent_usd: "0.910000", limit_usd: "1.000000", pct: 91.0 },
      },
    ],
  };
}

export function aiRequestRow(p: Record<string, unknown> = {}) {
  return {
    request_id: REQUEST_ID,
    occurred_at: "2026-10-12T14:00:00Z",
    agent_id: "concierge",
    skill_id: "concierge.event",
    skill_version: "1",
    user_id: USER_ID,
    model_used: "claude-haiku-4-5",
    fallback_used: false,
    tokens_in: 3200,
    tokens_out: 800,
    tool_calls: 1,
    service_calls: 2,
    cost_usd: "0.009230",
    latency_ms: 6240,
    status: "SUCCESS",
    error_code: null,
    ...p,
  };
}

export function aiRequestDetailRow(p: Record<string, unknown> = {}) {
  return {
    ...aiRequestRow(),
    calls: [
      {
        usage_id: USAGE_ID,
        occurred_at: "2026-10-12T14:00:06Z",
        model: "claude-haiku-4-5",
        tokens_in: 3200,
        tokens_out: 800,
        cache_write_tokens: 2100,
        cache_read_tokens: 0,
        tool_calls: 1,
        external_api_calls: [{ key: "flights_api", count: 1 }],
        cost: {
          llm_input_usd: "0.003200",
          llm_output_usd: "0.004000",
          cache_write_usd: "0.002625",
          cache_read_usd: "0.000000",
          request_fee_usd: "0.000000",
          external_api_usd: "0.000000",
          total_cost_usd: "0.009825",
          price_catalog_version: "2026-10-12",
          status: "priced",
        },
        cost_status: "priced",
        latency_ms: 6240,
        status: "SUCCESS",
        error_code: null,
        price_catalog_version: "2026-10-12",
      },
    ],
    timeline: [
      { type: "llm", name: "claude-haiku-4-5", started_ms: 0, duration_ms: 6240, status: "SUCCESS" },
      { type: "tool", name: "set_direct_only", started_ms: null, duration_ms: 2100, status: "ok", code: null },
    ],
    source_count: 2,
    safety_violations: 0,
    first_event_ms: 1800,
    mode: "event",
    kind: "action",
    conversation_id: CONVERSATION_ID,
    price_catalog_version: "2026-10-12",
    trace_id: "7f3a1d9be04c4c21",
    content: { available: true, requires: "ai.content.read" },
    ...p,
  };
}

export function aiContentRow(p: Record<string, unknown> = {}) {
  return {
    request_id: REQUEST_ID,
    turn_id: "f0f0f0f0-1111-4222-8333-444455556666",
    conversation_id: CONVERSATION_ID,
    user_text: "Хочу только прямой рейс",
    segments: [
      { kind: "fact", text: "Прямой рейс есть: TAS → IST, 4 ч 30 мин.", sources: [{ ref: "O0", title: "Поставщик перелётов", domain: "flights.example", url: "https://flights.example/x", fetched_at: null }] },
      { kind: "recommendation", text: "Берите прямой — разница $40.", sources: [] },
    ],
    tool_calls: [{ tool: "set_direct_only", args: { direct_only: true }, status: "ok", code: null, duration_ms: 2100 }],
    ...p,
  };
}

export function priceVersionRow(p: Record<string, unknown> = {}) {
  return {
    version: "2026-10-12",
    status: "draft",
    note: "Ставки по странице цен Anthropic",
    based_on: "env",
    content_hash: HASH_A,
    created_by: "system",
    created_at: "2026-10-12T00:00:00Z",
    updated_by: null,
    updated_at: "2026-10-12T00:00:00Z",
    activated_by: null,
    activated_at: null,
    retired_at: null,
    row_version: 1,
    items: [
      {
        kind: "model",
        key: "claude-haiku-4-5",
        input_usd_per_mtok: "1.000000",
        output_usd_per_mtok: "5.000000",
        cache_write_usd_per_mtok: "1.250000",
        cache_read_usd_per_mtok: "0.100000",
        per_call_usd: null,
      },
    ],
    incomplete_models: [],
    ...p,
  };
}

export function skillSummaryRow(p: Record<string, unknown> = {}) {
  return {
    skill_id: "concierge.event",
    agent_id: "concierge",
    title: "Консьерж: событие",
    critical: true,
    code_managed: false,
    active: { version: 1, activation_id: ACTIVATION_ID, since: "2026-10-12T00:00:00Z" },
    versions: [
      { version: 1, status: "PUBLISHED" },
      { version: 2, status: "DRAFT" },
    ],
    ...p,
  };
}

export function activationRowAi(p: Record<string, unknown> = {}) {
  return {
    activation_id: ACTIVATION_ID,
    skill_id: "concierge.event",
    version: 1,
    kind: "bootstrap",
    effective_from: "2026-10-12T00:00:00Z",
    by: "system",
    reason: "Сид v1",
    previous_version: null,
    created_at: "2026-10-12T00:00:00Z",
    ...p,
  };
}

export function skillDetailRow() {
  return {
    ...skillSummaryRow(),
    versions: [
      { version: 1, status: "PUBLISHED", artifact_hash: HASH_A, author: "system", reviewer: "system", created_at: "2026-10-12T00:00:00Z", published_at: "2026-10-12T00:00:00Z", change_note: "Сид" },
      { version: 2, status: "DRAFT", artifact_hash: HASH_B, author: OPERATOR_ID, reviewer: null, created_at: "2026-10-12T10:00:00Z", published_at: null, change_note: "Короче ответы" },
    ],
    activations: [activationRowAi()],
  };
}

export function skillVersionRow(p: Record<string, unknown> = {}) {
  const version = (p.version as number | undefined) ?? 2;
  return {
    skill_id: "concierge.event",
    version,
    artifact: {
      skill_id: "concierge.event",
      agent_id: "concierge",
      version,
      system_instruction: "Ты — AI-консьерж TilHero.\nСначала инструмент, потом ответ.",
      output_schema: "concierge-answer-v1",
      allowed_tools: ["reprice_offer", "set_direct_only"],
      source_priority: ["official", "ticket_provider", "provider", "trusted_media"],
      model_policy: { primary: "claude-haiku-4-5", fallback: null },
      limits: { max_tokens: 1200, max_cost_usd: "0.050000", timeout_ms: 30000, retries: 1 },
      confidence: { min: 0.6 },
      safety_policy: { no_invented_prices: true, source_required: true, web_content_untrusted: true, tool_before_claim: true },
      change_note: "Короче ответы",
      author: OPERATOR_ID,
      reviewer: null,
      effective_from: null,
      rollback_target: null,
    },
    artifact_hash: HASH_B,
    status: "DRAFT",
    author: OPERATOR_ID,
    reviewer: null,
    review: null,
    last_run: null,
    from_version: 1,
    created_at: "2026-10-12T10:00:00Z",
    updated_at: "2026-10-12T10:00:00Z",
    published_at: null,
    deprecated_at: null,
    version_row: 1,
    ...p,
  };
}

export function compareRow() {
  return {
    skill_id: "concierge.event",
    a: { version: 1, status: "PUBLISHED", artifact_hash: HASH_A, last_run: null },
    b: { version: 2, status: "DRAFT", artifact_hash: HASH_B, last_run: { run_id: RUN_ID7, status: "done", totals: { cases: 9, passed: 9, failed: 0, required_failed: 0, cost_usd: "0.031", latency_ms_avg: 4200 }, at: "2026-10-12T11:00:00Z" } },
    instruction_diff: [
      { op: "equal", a: 1, b: 1, text: "Ты — AI-консьерж TilHero." },
      { op: "delete", a: 2, b: null, text: "Отвечай подробно." },
      { op: "insert", a: null, b: 2, text: "Сначала инструмент, потом ответ." },
    ],
    fields: { change_note: { a: "Сид", b: "Короче ответы" }, limits: { a: { max_tokens: 1500 }, b: { max_tokens: 1200 } } },
    runs: { passed: { a: null, b: 9 } },
  };
}

export function evalRunRow(p: Record<string, unknown> = {}) {
  const output = (tools: string[], cost: string) => ({
    segments: [{ kind: "fact", text: "секрет-ответа-модели", sources: [] }],
    tool_calls: tools.map((t) => ({ tool: t, status: "ok" })),
    usage: { cost_usd: cost },
    latency_ms: 4100,
    schema_valid: true,
    safety_violations: [],
  });
  return {
    run_id: RUN_ID7,
    skill_id: "concierge.event",
    version: 2,
    artifact_hash: HASH_B,
    compare_version: 1,
    status: "done",
    started_by: OPERATOR_ID,
    totals: { cases: 1, passed: 1, failed: 0, required_failed: 0, cost_usd: "0.0031", latency_ms_avg: 4100, required_passed: true, complete: true },
    error_code: null,
    case_ids: [CASE_ID],
    created_at: "2026-10-12T11:00:00Z",
    started_at: "2026-10-12T11:00:01Z",
    finished_at: "2026-10-12T11:00:09Z",
    results: [
      { case_id: CASE_ID, case_name: "direct_only_text", required: true, side: "candidate", passed: true, checks: [{ check: "tools_called:set_direct_only", passed: true, detail: null }], output: output(["set_direct_only"], "0.0031") },
      { case_id: CASE_ID, case_name: "direct_only_text", required: true, side: "compare", passed: false, checks: [{ check: "tools_called:set_direct_only", passed: false, detail: null }], output: output([], "0.0040") },
    ],
    comparison: [
      {
        case_id: CASE_ID,
        case_name: "direct_only_text",
        candidate: { tools: ["set_direct_only"], kinds: ["fact"], cost_usd: "0.0031", latency_ms: 4100 },
        compare: { tools: [], kinds: ["fact"], cost_usd: "0.0040", latency_ms: 4100 },
        changed: ["tools"],
        cost_delta_usd: "-0.0009",
        latency_delta_ms: 0,
      },
    ],
    ...p,
  };
}

export function evalCaseRow(p: Record<string, unknown> = {}) {
  return {
    case_id: CASE_ID,
    skill_id: "concierge.event",
    name: "direct_only_text",
    required: true,
    enabled: true,
    input: { mode: "event", lang: "ru", text: "Только прямой рейс" },
    tool_fixtures: { set_direct_only: { status: "ok" } },
    expect: { tools_called: ["set_direct_only"] },
    version: 1,
    created_by: "system",
    updated_by: "system",
    created_at: "2026-10-12T00:00:00Z",
    updated_at: "2026-10-12T00:00:00Z",
    ...p,
  };
}

export function accessLevelRow(p: Record<string, unknown> = {}) {
  return {
    code: "basic",
    name_ru: "Базовый",
    name_en: "Basic",
    concierge_messages_per_day: 10,
    is_default: true,
    sort: 10,
    version: 1,
    updated_by: "system",
    updated_at: "2026-10-12T00:00:00Z",
    ...p,
  };
}

export function userAccessRow(p: Record<string, unknown> = {}) {
  return {
    level: "basic",
    level_name: "Базовый",
    level_name_en: "Basic",
    source: "default",
    expires_at: null,
    limits: { concierge_messages_per_day: 10 },
    user_id: USER_ID,
    assigned_by: null,
    assigned_at: null,
    reason: null,
    assignment: null,
    version: 0,
    ...p,
  };
}

export function userUsageRow() {
  return {
    user_id: USER_ID,
    from: "2026-09-12T15:00:00Z",
    to: "2026-10-12T15:00:00Z",
    requests: 7,
    cost_usd: "0.064000",
    agents: [{ agent_id: "concierge", requests: 7, cost_usd: "0.064000" }],
    days: [{ day: "2026-10-12", requests: 3, cost_usd: "0.030000" }],
  };
}

export function conversationsRow() {
  return {
    items: [{ conversation_id: CONVERSATION_ID, mode: "event", event_id: "e1e2e3e4-1111-4222-8333-444455556666", turns_count: 3, created_at: "2026-10-12T13:00:00Z", last_activity_at: "2026-10-12T14:00:00Z" }],
    next_cursor: null,
  };
}

/** Фейки ai-control, ai-concierge и kill switch / бюджетов агентов provider-gateway (контракт спринта 7). */
export function fakeSprint7(f: FakeDomains): void {
  const gw = "/internal/v1/providers/ai";
  f.on("aiControl", "GET", "/internal/v1/budgets/overview", () => json(200, overviewRow()));
  f.on("providerGateway", "GET", `${gw}/agents`, () => json(200, gwAgentsRow()));
  f.on("providerGateway", "PUT", `${gw}/agents/concierge/pause`, (c) =>
    json(200, gwAgentsRow({ paused: { concierge: c.body.paused ? { reason: c.body.reason, by: c.actor?.id ?? "", at: "2026-10-12T15:00:00Z" } : null } })),
  );
  f.on("providerGateway", "PUT", `${gw}/provider/anthropic/pause`, (c) =>
    json(200, gwAgentsRow({ provider: c.body.paused ? { reason: c.body.reason, by: c.actor?.id ?? "", at: "2026-10-12T15:00:00Z" } : null })),
  );
  f.on("aiControl", "GET", "/internal/v1/agents", () => json(200, { items: [aiAgentRow()] }));
  f.on("aiControl", "GET", "/internal/v1/agents/concierge", () => json(200, aiAgentRow()));
  f.on("aiControl", "PATCH", "/internal/v1/agents/concierge", (c) => {
    const { reason: _r, expected_version, ...changes } = c.body;
    return json(200, { ...aiAgentRow({ ...changes, config_version: Number(expected_version) + 1, updated_by: c.actor?.id ?? null }), warnings: [] });
  });
  f.on("aiControl", "GET", "/internal/v1/budgets/alerts", () => json(200, { items: [aiAlertRow()], next_cursor: null }));
  f.on("aiControl", "POST", `/internal/v1/budgets/alerts/${ALERT_ID}:ack`, (c) =>
    json(200, aiAlertRow({ acked_by: c.actor?.id ?? null, acked_at: "2026-10-12T15:01:00Z" })),
  );
  f.on("aiControl", "GET", "/internal/v1/usage/kpi", () => json(200, kpiRow()));
  f.on("aiControl", "GET", "/internal/v1/usage/agents", () => json(200, agentsUsageRow()));
  f.on("aiControl", "GET", "/internal/v1/usage/requests", () => json(200, { items: [aiRequestRow()], next_cursor: null }));
  f.on("aiControl", "GET", `/internal/v1/usage/requests/${REQUEST_ID}`, () => json(200, aiRequestDetailRow()));
  f.on("aiConcierge", "POST", `/internal/v1/admin/requests/${REQUEST_ID}/content:reveal`, () => json(200, aiContentRow()));
  f.on("aiControl", "GET", "/internal/v1/pricing/versions", () => {
    const { items: _i, incomplete_models: _m, ...v } = priceVersionRow();
    return json(200, { items: [v], next_cursor: null });
  });
  f.on("aiControl", "GET", "/internal/v1/pricing/versions/2026-10-12", () => json(200, priceVersionRow()));
  f.on("aiControl", "POST", "/internal/v1/pricing/versions", () => json(201, priceVersionRow({ version: "2026-10-12-1", created_by: OPERATOR_ID })));
  f.on("aiControl", "PATCH", "/internal/v1/pricing/versions/2026-10-12", (c) => json(200, priceVersionRow({ row_version: Number(c.body.expected_version) + 1 })));
  f.on("aiControl", "POST", "/internal/v1/pricing/versions/2026-10-12:activate", (c) =>
    json(200, priceVersionRow({ status: "active", activated_by: c.actor?.id ?? null, activated_at: "2026-10-12T15:00:00Z", row_version: 2 })),
  );
  f.on("aiControl", "GET", "/internal/v1/access/levels", () =>
    json(200, { items: [accessLevelRow(), accessLevelRow({ code: "plus", name_ru: "Расширенный", name_en: "Plus", concierge_messages_per_day: 20, is_default: false, sort: 20 })] }),
  );
  f.on("aiControl", "PUT", "/internal/v1/access/levels/plus", (c) => {
    const { reason: _r, expected_version: _e, ...v } = c.body;
    return json(200, { ...accessLevelRow({ code: "plus", is_default: false, sort: 20, ...v, version: 2, updated_by: c.actor?.id ?? null }), warnings: [] });
  });
  f.on("aiControl", "DELETE", "/internal/v1/access/levels/plus", () => json(200, { code: "plus", deleted: true }));
  f.on("aiControl", "GET", `/internal/v1/access/users/${USER_ID}`, () => json(200, userAccessRow()));
  f.on("aiControl", "PUT", `/internal/v1/access/users/${USER_ID}`, (c) =>
    json(
      200,
      userAccessRow({
        level: c.body.level,
        level_name: "Расширенный",
        level_name_en: "Plus",
        source: "manual",
        expires_at: c.body.expires_at ?? null,
        limits: { concierge_messages_per_day: 20 },
        assigned_by: c.actor?.id ?? null,
        assigned_at: "2026-10-12T15:00:00Z",
        reason: c.body.reason,
        assignment: { level: c.body.level, source: "manual", expires_at: c.body.expires_at ?? null, expired: false },
        version: 1,
      }),
    ),
  );
  f.on("aiControl", "DELETE", `/internal/v1/access/users/${USER_ID}`, () => json(200, userAccessRow({ version: 2 })));
  f.on("aiControl", "GET", `/internal/v1/usage/users/${USER_ID}/summary`, () => json(200, userUsageRow()));
  f.on("aiConcierge", "GET", "/internal/v1/admin/conversations", () => json(200, conversationsRow()));
  const SK = "/internal/v1/skills/concierge.event";
  f.on("aiControl", "GET", "/internal/v1/skills", () => json(200, { items: [skillSummaryRow()], next_cursor: null }));
  f.on("aiControl", "GET", SK, () => json(200, skillDetailRow()));
  f.on("aiControl", "GET", `${SK}/versions/2`, () => json(200, skillVersionRow()));
  f.on("aiControl", "GET", `${SK}/compare`, () => json(200, compareRow()));
  f.on("aiControl", "POST", `${SK}/versions`, () => json(201, skillVersionRow({ version: 3, version_row: 1, author: OPERATOR_ID })));
  f.on("aiControl", "PATCH", `${SK}/versions/2`, (c) => json(200, skillVersionRow({ version_row: Number(c.body.expected_version) + 1 })));
  f.on("aiControl", "POST", `${SK}/versions/2/test`, () => json(202, { run_id: RUN_ID7, status: "queued", cases: 9 }));
  f.on("aiControl", "POST", `${SK}/versions/2/review`, (c) =>
    json(200, skillVersionRow({ status: c.body.action === "reject" ? "DRAFT" : "REVIEW", review: c.body.action === "request" ? null : { decision: c.body.action === "approve" ? "approved" : "rejected", comment: c.body.comment ?? null, at: "2026-10-12T15:00:00Z" } })),
  );
  f.on("aiControl", "POST", `${SK}/versions/2/publish`, (c) =>
    json(200, { ...skillVersionRow({ status: "PUBLISHED", published_at: "2026-10-12T15:00:00Z" }), activation: activationRowAi({ version: 2, kind: "publish", by: c.actor?.id ?? "", reason: c.body.reason, previous_version: 1 }) }),
  );
  f.on("aiControl", "POST", `${SK}/rollback`, (c) =>
    json(200, { skill_id: "concierge.event", from_version: 2, to_version: c.body.to_version, activation: activationRowAi({ kind: "rollback", by: c.actor?.id ?? "", reason: c.body.reason, previous_version: 2 }) }),
  );
  f.on("aiControl", "POST", `${SK}/versions/2/deprecate`, () => json(200, skillVersionRow({ status: "DEPRECATED", deprecated_at: "2026-10-12T15:00:00Z" })));
  f.on("aiControl", "GET", `/internal/v1/evaluation/runs/${RUN_ID7}`, () => json(200, evalRunRow()));
  f.on("aiControl", "GET", "/internal/v1/evaluation/cases", () => json(200, { items: [evalCaseRow()] }));
  f.on("aiControl", "POST", "/internal/v1/evaluation/cases", (c) => json(201, evalCaseRow({ name: c.body.name })));
  f.on("aiControl", "PATCH", `/internal/v1/evaluation/cases/${CASE_ID}`, (c) => json(200, evalCaseRow({ version: Number(c.body.expected_version) + 1 })));
  f.on("aiControl", "DELETE", `/internal/v1/evaluation/cases/${CASE_ID}`, () => json(200, { case_id: CASE_ID, deleted: true }));
}

// ---------------------------------------------------------------- спринт 8: ops-monitor, статистика дашборда

export const OPS_ALERT_ID = "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a60";
export const OPS_ACTION_ID = "1d8b2f3a-4c5e-4f6a-9b0c-2d3e4f5a6b71";

const BY_CLASS0 = { auth: 0, rate_limit: 0, quota: 0, timeout: 0, server: 0, network: 0, bad_response: 0, circuit_open: 0 };

export function providerHealthRow(p: Record<string, unknown> = {}) {
  return {
    provider: "aviasales",
    title: "Aviasales",
    status: "degraded",
    status_since: "2026-10-15T08:00:00Z",
    window: { minutes: 5, calls: 40, error_rate: 0.125, p50_ms: 820, p95_ms: 4100, by_class: { ...BY_CLASS0, server: 4, timeout: 1 }, route_unsupported: 3, route_top: [{ location: "FRU", count: 3 }] },
    last_24h: { calls: 2210, error_rate: 0.031, p95_ms: 3900, route_unsupported: 14 },
    breaker: "closed",
    quota: { used: 1200, limit: 5000, pct: 24.0 },
    last_error: { code: "PROVIDER_UNAVAILABLE", reason: "upstream_5xx", message: "Bad gateway", http_status: 502, at: "2026-10-15T08:55:00Z" },
    last_route_error: { code: "ROUTE_NOT_SUPPORTED", location: "FRU", route: "TAS-FRU", at: "2026-10-15T08:40:00Z" },
    last_probe: { ok: true, latency_ms: 640, code: null, at: "2026-10-15T07:00:00Z" },
    open_alerts: [{ alert_id: OPS_ALERT_ID, kind: "status", severity: "warning" }],
    stale_since: null,
    ...p,
  };
}
export function opsAlertRow(p: Record<string, unknown> = {}) {
  return {
    alert_id: OPS_ALERT_ID,
    subject_type: "provider",
    subject: "aviasales",
    kind: "status",
    severity: "warning",
    state: "open",
    state_seq: 2,
    params: { status_from: "ok", status_to: "degraded", error_rate: 0.125, p95_ms: 4100, by_class: { server: 4, timeout: 1 } },
    opened_at: "2026-10-15T08:00:00Z",
    resolved_at: null,
    last_notified_at: "2026-10-15T08:00:00Z",
    acked_by: null,
    acked_at: null,
    ack_comment: null,
    ...p,
  };
}
export function dlqItemRow(p: Record<string, unknown> = {}) {
  return {
    dlq_id: "dlq:42",
    source: "dlq",
    consumer: "notifications_watch_changes",
    service: "notifications",
    event_type: "watch.change.detected.v1",
    event_id: "5e2c1a7b-0f3d-4b8e-9c6a-7d1e2f3a4b5c",
    occurred_at: "2026-10-15T07:59:00Z",
    dead_at: "2026-10-15T08:00:00Z",
    deliveries: 5,
    reason_class: "handler_error:KeyError",
    replays: 0,
    size_bytes: 812,
    ...p,
  };
}
export function opsSummaryRow(p: Record<string, unknown> = {}) {
  return {
    generated_at: "2026-10-15T09:00:00Z",
    providers: { ok: 5, degraded: 1, down: 0, idle: 1, not_configured: 0, items: [{ provider: "aviasales", status: "degraded", since: "2026-10-15T08:00:00Z" }] },
    services: { up: 23, total: 24, down: ["news"] },
    queues: { total_pending: 12, lagging: 0, stalled: 0, dlq_messages: 3, dlq_new_24h: 1 },
    outbox: { pending: 4, failing: 0, stuck_services: [] },
    alerts: { critical: 0, warning: 2, info: 0 },
    ...p,
  };
}
export function tripsStatsRow(p: Record<string, unknown> = {}) {
  return {
    builds: 310,
    by_caller: { "telegram-bff": 250, watch: 40, "ai-concierge": 20 },
    reused_share: 0.21,
    by_trip_kind: { trip: 220, ticket_only: 70, not_available: 20 },
    complete_share: 0.82,
    budget: { with_budget: 90, within: 61, over: 25, unknown: 4 },
    by_recommended_tier: { economy: 140, comfort: 90, premium: 20 },
    no_flight_total: 31,
    ...p,
  };
}
export function noFlightRow(p: Record<string, unknown> = {}) {
  return {
    total: 31,
    by_reason: { NO_DIRECT: 4, NO_FLIGHTS: 9, ROUTE_NOT_SUPPORTED: 12, NO_DEPARTURE: 6 },
    bands: { lt600: 19, ge600: 10, unknown: 2 },
    pairs: [
      { origin_city: "Ташкент", origin_iata: "TAS", origin_country: "UZ", dest_city: "Бишкек", dest_iata: "FRU", dest_country: "KG", distance_km: 470, band: "lt600", count: 12, by_reason: { ROUTE_NOT_SUPPORTED: 12 } },
      { origin_city: "Ташкент", origin_iata: "TAS", origin_country: "UZ", dest_city: "Самарканд", dest_iata: "SKD", dest_country: "UZ", distance_km: 260, band: "lt600", count: 7, by_reason: { NO_FLIGHTS: 7 } },
    ],
    ...p,
  };
}
export function newsStatsRow(p: Record<string, unknown> = {}) {
  return { items: { article: 48, event_update: 12 }, hidden: 3, sources: { enabled: 14, disabled: 2, problem: 1 }, last_collect_at: "2026-10-15T08:30:00Z", ...p };
}

export function fakeSprint8(f: FakeDomains): void {
  f.on("opsMonitor", "GET", "/internal/v1/health/providers", () =>
    json(200, [providerHealthRow(), providerHealthRow({ provider: "anthropic", title: "Anthropic", status: "ok", open_alerts: [], quota: null, last_error: null, last_route_error: null, last_probe: null })]),
  );
  f.on("opsMonitor", "GET", "/internal/v1/health/providers/aviasales/history", (c) =>
    json(200, {
      provider: "aviasales",
      range: c.query.range ?? "24h",
      step: c.query.range === "7d" ? "1h" : "5m",
      points: [{ t: "2026-10-15T08:00:00Z", calls: 40, errors: 5, by_class: { ...BY_CLASS0, server: 4, timeout: 1 }, route_unsupported: 3, p50_ms: 820, p95_ms: 4100 }],
      transitions: [{ from: "ok", to: "degraded", at: "2026-10-15T08:00:00Z" }],
      route_top: [{ location: "FRU", count: 12 }],
    }),
  );
  f.on("opsMonitor", "POST", "/internal/v1/health/providers/aviasales:probe", () =>
    json(200, {
      probe: { name: "aviasales", ok: true, latency_ms: 512, code: null, reason: null, message: null, http_status: 200, checked_at: "2026-10-15T09:00:00Z" },
      provider: providerHealthRow({ last_probe: { ok: true, latency_ms: 512, code: null, at: "2026-10-15T09:00:00Z" } }),
    }),
  );
  f.on("opsMonitor", "POST", "/internal/v1/health/providers/anthropic:probe", () => domainError(422, "PROBE_NOT_SUPPORTED", { provider: "anthropic" }));
  f.on("opsMonitor", "GET", "/internal/v1/health/feeds", () =>
    json(200, { items: [{ source_id: "7", slug: "kun-uz", name: "Kun.uz", domain: "kun.uz", last_ok_at: "2026-10-14T10:00:00Z", last_error: { code: "FETCH_FAILED", at: "2026-10-15T08:00:00Z" }, kind: "media", country_code: "UZ" }], available: true, checked_at: "2026-10-15T08:50:00Z" }),
  );
  f.on("opsMonitor", "GET", "/internal/v1/alerts", () => json(200, { items: [opsAlertRow()], next_cursor: null }));
  f.on("opsMonitor", "POST", `/internal/v1/alerts/${OPS_ALERT_ID}:ack`, (c) =>
    json(200, opsAlertRow({ acked_by: c.actor?.id ?? null, acked_at: "2026-10-15T09:01:00Z", ack_comment: c.body?.comment ?? null })),
  );
  f.on("opsMonitor", "GET", "/internal/v1/queues/streams", () =>
    json(200, [{ name: "TILHERO", subjects: ["tilhero.>"], messages: 1200, bytes: 880000, first_seq: 1, last_seq: 1200, first_ts: "2026-10-08T09:00:00Z", consumers: 14, max_age_s: 604800 }]),
  );
  f.on("opsMonitor", "GET", "/internal/v1/queues/consumers", () =>
    json(200, [
      { durable: "notifications_watch_changes", service: "notifications", event_types: ["watch.change.detected.v1"], num_pending: 0, num_ack_pending: 0, num_redelivered: 2, oldest_pending_age_s: null, last_active_at: "2026-10-15T08:59:00Z", replay_enabled: true, dlq: { count: 3, last_at: "2026-10-15T08:00:00Z" }, status: "ok" },
    ]),
  );
  f.on("opsMonitor", "GET", "/internal/v1/queues/outbox", () =>
    json(200, [
      { service: "offers", available: true, pending: 2, failing: 0, oldest_pending_at: "2026-10-15T08:59:30Z", max_attempts: 0, last_error_class: null, published_24h: 410, stale_consumers: [], checked_at: "2026-10-15T09:00:00Z" },
      { service: "provider-gateway", available: false, pending: null, failing: null, oldest_pending_at: null, max_attempts: null, last_error_class: null, published_24h: null, stale_consumers: [], checked_at: "2026-10-15T09:00:00Z" },
    ]),
  );
  f.on("opsMonitor", "GET", "/internal/v1/queues/services", () => json(200, [{ service: "offers", ready: "ok", latency_ms: 12, checked_at: "2026-10-15T09:00:00Z" }]));
  f.on("opsMonitor", "GET", "/internal/v1/dlq/messages", () => json(200, { items: [dlqItemRow()], next_cursor: null, total: 1 }));
  f.on("opsMonitor", "GET", "/internal/v1/dlq/messages/dlq:42", () =>
    json(200, {
      ...dlqItemRow(),
      envelope_masked: { event_id: "5e2c1a7b-0f3d-4b8e-9c6a-7d1e2f3a4b5c", type: "watch.change.detected.v1", payload: { user_id: USER_ID, chat_id: "***", text: "***" } },
      masked_fields: ["payload.chat_id", "payload.text"],
      envelope_readable: true,
    }),
  );
  for (const kind of ["replay", "delete"]) {
    f.on("opsMonitor", "POST", `/internal/v1/dlq:${kind}`, (c) =>
      json(200, { action_id: OPS_ACTION_ID, requested: c.body?.ids?.length ?? c.body?.expected_count ?? 0, done: c.body?.ids?.length ?? c.body?.expected_count ?? 0, skipped: [] }),
    );
  }
  f.on("opsMonitor", "GET", "/internal/v1/dlq/actions", () =>
    json(200, { items: [{ action_id: OPS_ACTION_ID, kind: "replay", by: OPERATOR_ID, reason: "Исправлен обработчик", selector: { ids: ["dlq:42"] }, requested: 1, done: 1, skipped: [], at: "2026-10-15T09:02:00Z" }], next_cursor: null }),
  );
  f.on("opsMonitor", "GET", "/internal/v1/ops/summary", () => json(200, opsSummaryRow()));
  f.on("offers", "GET", "/internal/v1/offers/stats", () => json(200, tripsStatsRow()));
  f.on("offers", "GET", "/internal/v1/offers/stats/no-flight", () => json(200, noFlightRow()));
  f.on("news", "GET", "/internal/v1/news/stats", () => json(200, newsStatsRow()));
  f.on("watch", "GET", "/internal/v1/watches:stats", () => json(200, watchStatsRow()));
}

// ---------------------------------------------------------------- спринт 9: удаления (identity-consent) и лимиты (ops-monitor)

export const DELETION_ID = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export function deletionRow(p: Record<string, unknown> = {}) {
  return {
    request_id: DELETION_ID,
    user_id: USER_ID,
    status: "STUCK",
    requested_at: "2026-10-14T08:00:00Z",
    completed_at: null,
    stuck_at: "2026-10-15T08:00:00Z",
    attempts: 6,
    next_retry_at: "2026-10-16T08:00:00Z",
    acked: 8,
    expected: 9,
    pending_domains: ["watch"],
    ...p,
  };
}
export function deletionDetail(p: Record<string, unknown> = {}) {
  return {
    ...deletionRow(),
    domains: [
      { domain: "preferences", acked_at: "2026-10-14T08:00:05Z", mode: "deleted", acked: true },
      { domain: "support", acked_at: null, mode: null, acked: true },
      { domain: "watch", acked_at: null, mode: null, acked: false },
    ],
    history: [
      { attempt: 1, sent_at: "2026-10-14T08:00:00Z", by: "user" },
      { attempt: 2, sent_at: "2026-10-14T08:15:00Z", by: "system" },
      { attempt: 6, sent_at: "2026-10-15T09:00:00Z", by: OPERATOR_ID },
    ],
    ...p,
  };
}
export function rlPolicyRow(p: Record<string, unknown> = {}) {
  return {
    policy: "tg.user",
    service: "telegram-bff",
    subject: "user",
    limit: 120,
    window_s: 60,
    burst: 120,
    fail: "open",
    env: "RATE_LIMIT_USER_PER_MIN",
    default: { limit: 120, window_s: 60, burst: 120 },
    source: "default",
    override: null,
    last_15m: { allowed: 4210, rejected: 12, failopen: 0, failclosed: 0 },
    ...p,
  };
}
export function fakeSprint9(f: FakeDomains): void {
  f.on("identity", "GET", "/admin/v1/deletions", () => json(200, { items: [deletionRow()], next_cursor: null }));
  f.on("identity", "GET", `/admin/v1/deletions/${DELETION_ID}`, () => json(200, deletionDetail()));
  f.on("identity", "POST", `/admin/v1/deletions/${DELETION_ID}:retry`, () => json(200, deletionDetail({ attempts: 7 })));
  f.on("opsMonitor", "GET", "/internal/v1/ratelimits/policies", () =>
    json(200, [
      rlPolicyRow(),
      rlPolicyRow({
        policy: "adm.login_ip",
        service: "admin-bff",
        subject: "ip",
        limit: 20,
        burst: 20,
        fail: "closed",
        env: "RATE_LIMIT_LOGIN_IP_PER_MIN",
        default: { limit: 10, window_s: 60, burst: 10 },
        source: "override",
        override: { limit: 20, window_s: 60, burst: null, by: OPERATOR_ID, at: "2026-10-15T08:00:00Z", reason: "Офис за одним NAT", expires_at: "2026-10-20T00:00:00Z" },
      }),
    ]),
  );
  f.on("opsMonitor", "GET", "/internal/v1/ratelimits/tg.user/history", (c) =>
    json(200, {
      policy: "tg.user",
      range: c.query.range ?? "24h",
      step: c.query.range === "7d" ? "1h" : "5m",
      points: [{ t: "2026-10-15T08:00:00Z", allowed: 1400, rejected: 4, failopen: 0, failclosed: 0 }],
      top_subjects_15m: [{ subject: USER_ID, rejected: 9 }],
    }),
  );
  f.on("opsMonitor", "PUT", "/internal/v1/ratelimits/tg.user/override", (c) =>
    json(200, rlPolicyRow({ limit: c.body?.limit ?? 240, burst: c.body?.limit ?? 240, source: "override", override: { limit: c.body?.limit ?? 240, window_s: 60, burst: null, by: c.actor?.id ?? OPERATOR_ID, at: "2026-10-15T09:00:00Z", reason: c.body?.reason ?? "—", expires_at: null } })),
  );
  f.on("opsMonitor", "DELETE", "/internal/v1/ratelimits/tg.user/override", () => json(200, rlPolicyRow()));
}

// ---------------------------------------------------------------- доработка 9.4: «Что нового»

export const NOTE_ID = "7a1c2e3f-4b5d-4e6f-8a9b-0c1d2e3f4a5b";

export function releaseNoteBody(p: Record<string, unknown> = {}) {
  return {
    slug: "2026.12",
    title: { ru: "Декабрь 2026", en: "December 2026" },
    items: [
      { title: { ru: "Новое", en: "New" }, text: { ru: "Коротко.", en: "Short." }, link: "catalog", icon: "spark" },
      { title: { ru: "Без ссылки", en: "No link" }, text: { ru: "Текст.", en: "Text." }, link: null, icon: null },
    ],
    audience: "existing",
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
    created_at: "2026-11-08T06:00:00.000Z",
    updated_by: OPERATOR_ID,
    updated_at: "2026-11-08T06:00:00.000Z",
    published_by: null,
    published_at: null,
    archived_by: null,
    archived_at: null,
    ...p,
  };
}

export function fakeReleaseNotes(f: FakeDomains): void {
  const base = "/admin/v1/release-notes";
  f.on("experience", "GET", base, () => json(200, { items: [releaseNoteRow()], next_cursor: null }));
  f.on("experience", "GET", `${base}/${NOTE_ID}`, () => json(200, releaseNoteRow()));
  f.on("experience", "POST", base, (c) => json(201, releaseNoteRow({ ...c.body, created_by: c.actor?.id ?? "" })));
  f.on("experience", "PUT", `${base}/${NOTE_ID}`, (c) => {
    const { expected_version, ...body } = c.body as Record<string, unknown>;
    return json(200, releaseNoteRow({ ...body, version: Number(expected_version) + 1 }));
  });
  f.on("experience", "POST", `${base}/${NOTE_ID}/publish`, (c) =>
    json(201, releaseNoteRow({ status: "published", version: 2, published_by: c.actor?.id ?? "", published_at: "2026-11-08T07:00:00.000Z" })),
  );
  f.on("experience", "POST", `${base}/${NOTE_ID}/archive`, (c) =>
    json(201, releaseNoteRow({ status: "archived", version: 3, archived_by: c.actor?.id ?? "", archived_at: "2026-11-08T08:00:00.000Z" })),
  );
}

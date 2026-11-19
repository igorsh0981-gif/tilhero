/**
 * Тестовая обвязка: реальный Redis (DB 14, уникальный префикс ключей на приложение), домены — in-memory
 * подделка, подключённая через fetchImpl. Подделка проверяет внутренний JWT (aud = домен, iss = telegram-bff)
 * и берёт субъекта ТОЛЬКО из sub — как настоящие домены. Каждый вызов записывается (сервис, путь, sub, тело,
 * заголовки) — тесты проверяют, от чьего имени BFF ходит в домен (аккаунт или ученик).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { decodeJwt } from "jose";
import { verifyInternalToken } from "@tilhero/ts-common";
import type {
  AgeBand,
  ConsentState,
  ExperienceConfig,
  Family,
  InboxItem,
  Invite,
  LearnerSummary,
  LearningPlan,
  NotificationSettings,
  SecurityState,
  Ticket,
  TodayPlan,
  UserSummary,
  WhatsNew,
  WhatsNewNote,
} from "@tilhero/contracts/bff";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { App } from "../src/http.js";
import { signInitData } from "../src/telegramAuth.js";
import { FakeContent } from "./fakeContent.js";
import { FakeLessons } from "./fakeLessons.js";

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/14";
export const BOT_TOKEN = "7000000001:AAtest-bot-token-for-unit-tests-only-xx";
export const INTERNAL_SECRET = "internal-test-secret-" + "z".repeat(32);
export const SESSION_SECRET = "session-test-secret-" + "s".repeat(32);
export const ORIGIN = "https://miniapp.tilhero.test";
export const APP_LINK = "https://t.me/tilhero_test_bot/app";

const URLS = {
  identity: "http://identity.test",
  learningPlan: "http://learning-plan.test",
  support: "http://support.test",
  notifications: "http://notifications.test",
  experience: "http://experience.test",
  social: "http://social.test",
  catalog: "http://catalog.test",
  diagnostics: "http://diagnostics.test",
  lessons: "http://lessons.test",
  assessment: "http://assessment.test",
} as const;

export type Service = keyof typeof URLS;

const DOMAIN_AUD: Record<Service, string> = {
  identity: "identity-consent",
  learningPlan: "learning-plan",
  support: "support",
  notifications: "notifications",
  experience: "experience-config",
  social: "social",
  catalog: "catalog",
  diagnostics: "diagnostics",
  lessons: "lessons",
  assessment: "assessment",
};

export function testConfig(env: Record<string, string> = {}): Config {
  const prefix = `bfftest:${randomUUID().slice(0, 8)}:`;
  return loadConfig({
    NODE_ENV: "test",
    BOT_TOKEN,
    SESSION_JWT_SECRET: SESSION_SECRET,
    INTERNAL_JWT_SECRET: INTERNAL_SECRET,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_KEY_PREFIX: prefix,
    RATE_LIMIT_KEY_PREFIX: prefix,
    MINIAPP_ORIGIN: ORIGIN,
    TELEGRAM_APP_LINK: APP_LINK,
    IDENTITY_URL: URLS.identity,
    LEARNING_PLAN_URL: URLS.learningPlan,
    SUPPORT_URL: URLS.support,
    NOTIFICATIONS_URL: URLS.notifications,
    EXPERIENCE_URL: URLS.experience,
    SOCIAL_URL: URLS.social,
    CATALOG_URL: URLS.catalog,
    DIAGNOSTICS_URL: URLS.diagnostics,
    LESSONS_URL: URLS.lessons,
    ASSESSMENT_URL: URLS.assessment,
    UPSTREAM_RETRIES: "0",
    UPSTREAM_TIMEOUT_MS: "2000",
    LOG_LEVEL: "info",
    ...env,
  });
}

// ---------------------------------------------------------------- log capture

export class LogCapture {
  readonly lines: string[] = [];
  write(msg: string): void {
    this.lines.push(msg);
  }
  get text(): string {
    return this.lines.join("");
  }
  parsed(): Array<Record<string, unknown>> {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

// ---------------------------------------------------------------- fake domains

export interface Call {
  service: Service;
  method: string;
  path: string;
  query: Record<string, string>;
  subject: string | undefined;
  body: unknown;
  headers: Record<string, string>;
  /** все claims внутреннего JWT (после проверки подписи) */
  claims: Record<string, unknown>;
}

export interface Req {
  method: string;
  path: string;
  query: Record<string, string>;
  subject: string | undefined;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string>;
  claims: Record<string, unknown>;
}

export type Handler = (r: Req) => Response | Promise<Response>;

export interface FakeAccount {
  summary: UserSummary;
  telegramId: number;
  security: SecurityState;
  pin: string | null;
  biometricToken: string | null;
  consent: ConsentState;
  settings: NotificationSettings;
  failedPins: number;
  children: string[];
  /** Ожидающий сброс кода (ревью T-8): новый код и признак «срок наступил» (тест переводит часы флагом). */
  pendingPin: string | null;
  resetDue: boolean;
}

export interface FakeChild {
  learner_id: string;
  display_name: string;
  age_band: AgeBand;
  guardian: string;
  settings: NotificationSettings;
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const domainError = (status: number, code: string, details: Record<string, unknown> = {}) =>
  json(status, { code, message: `domain says ${code}`, trace_id: "domain-trace", details });

export const DEFAULT_EXPERIENCE: ExperienceConfig = {
  app: "miniapp",
  version: "1.0.0",
  theme: { id: "notebook", version: "1.0.0", tokens: { "--color-paper": "#fbf7ee" } },
  home: {
    sections: [
      { type: "today_plan", key: "today", variant: "large", enabled: true },
      { type: "whats_new", key: "whats_new", variant: "compact", enabled: true },
    ],
  },
  flags: { voice: false },
};

const DEFAULT_SETTINGS = (): NotificationSettings => ({
  enabled: true,
  categories: { reminders: false, missed: false, social: false, support: true, product: false },
  quiet_hours: { start: "22:00", end: "08:00" },
  timezone: "Asia/Tashkent",
});

/** Срок ожидающего сброса в подделке identity (now + 24 ч условно). */
export const RESET_EFFECTIVE_AT = "2026-11-19T17:30:00.000Z";

export const GOALS = ["work", "career", "travel", "daily", "study", "exam"];
export const TOPICS = ["food", "travel", "work", "family", "hobby", "shopping", "health", "city", "school", "games", "music", "sport"];

export function noteFixture(o: Partial<WhatsNewNote> = {}): WhatsNewNote {
  return {
    release_note_id: randomUUID(),
    slug: "2026.11",
    title: "Что нового",
    items: [{ title: "График занятий", text: "Выберите дни и время", link: "schedule", icon: "calendar" }],
    audience: "existing",
    published_at: "2026-11-18T08:00:00Z",
    ...o,
  };
}

interface InviteRec {
  invite: Invite;
  inviter: string;
  token: string;
  opened: Set<string>;
  acceptedBy: Set<string>;
}

export class FakeDomains {
  readonly calls: Call[] = [];
  readonly usersByTg = new Map<number, FakeAccount>();
  readonly accounts = new Map<string, FakeAccount>();
  readonly children = new Map<string, FakeChild>();
  readonly plans = new Map<string, LearningPlan>();
  readonly activities = new Map<string, number>(); // `${learner}:${key}` → minutes
  readonly minutesToday = new Map<string, number>();
  readonly inbox = new Map<string, InboxItem[]>();
  readonly invites = new Map<string, InviteRec>();
  readonly inviteIdem = new Map<string, string>();
  readonly families = new Map<string, Family>(); // owner → family
  readonly guardianRequests = new Map<string, { teen: string; status: "pending" | "granted" | "declined" | "expired"; expires_at: string }>();
  /** Решения родителей по подросткам (INTERNAL_API §11): teen → последнее решение. */
  readonly grants = new Map<string, { guardian: string; status: "granted" | "declined" | "revoked"; decided_at: string }>();
  readonly tickets = new Map<string, Ticket & { owner: string }>();
  readonly ticketIdem = new Map<string, string>();
  readonly childIdem = new Map<string, string>();
  /** experience-config for-me: ответ (по умолчанию updates с одной заметкой) и лента. */
  forMe: WhatsNew = { mode: "updates", notes: [noteFixture()] };
  feed: WhatsNewNote[] = [noteFixture({ slug: "welcome-1", audience: "new" })];
  readonly seen = new Map<string, Set<string>>();
  experience: ExperienceConfig = structuredClone(DEFAULT_EXPERIENCE);
  /** identity отдаёт настройки уведомлений ребёнка в GET/PATCH /me/learners/{id} (запрос к общему коду). */
  childSettingsInDetail = true;
  /** Домены, «лежащие» на сетевом уровне (fetch бросает). */
  readonly down = new Set<Service>();
  /** Спринт 3: catalog, diagnostics и траектория learning-plan (test/fakeContent.ts). */
  readonly content = new FakeContent();
  /** Спринт 4: lessons и assessment (test/fakeLessons.ts). */
  readonly lessons = new FakeLessons();
  private readonly overrides = new Map<string, Handler>();
  private ticketSeq = 3000;

  /** Подмена обработчика: key = "service METHOD /path" (путь без query). */
  override(service: Service, method: string, path: string, h: Handler): void {
    this.overrides.set(`${service} ${method} ${path}`, h);
  }

  account(userId: string): FakeAccount {
    const u = this.accounts.get(userId);
    if (!u) throw new Error(`no fake account ${userId}`);
    return u;
  }

  /** Срок ожидающего сброса наступил: состояние показывает новый код (запись — при следующей проверке кода). */
  makeResetDue(userId: string): void {
    const u = this.account(userId);
    u.resetDue = true;
    u.security = { ...u.security, pin_length: (u.pendingPin?.length ?? 4) as 4 | 6, pin_reset_effective_at: null };
  }

  /** Проверка кода как в identity: наступивший сброс применяется, ненаступивший отменяется верным прежним кодом.
   *  → null (верно; applied — сброс введён в действие) или ответ-ошибка. */
  private checkPin(u: FakeAccount, pin: string | undefined): { applied: boolean } | Response {
    let applied = false;
    let pinNow = u.pin;
    if (u.pendingPin && u.resetDue) pinNow = u.pendingPin;
    if (pin !== pinNow) {
      u.failedPins += 1;
      if (u.failedPins >= 5) return domainError(423, "PIN_LOCKED", { retry_after: 300 });
      return domainError(401, "PIN_INVALID", { remaining: 5 - u.failedPins });
    }
    u.failedPins = 0;
    if (u.pendingPin && u.resetDue) {
      u.pin = u.pendingPin;
      applied = true;
      u.biometricToken = null;
      u.security = { ...u.security, biometric_enabled: false };
    }
    u.pendingPin = null;
    u.resetDue = false;
    u.security = { ...u.security, pin_length: (u.pin?.length ?? null) as 4 | 6 | null, pin_reset_effective_at: null };
    return { applied };
  }

  /** Включить код родителя напрямую (как будто задан ранее). */
  enablePin(userId: string, pin: string): void {
    const u = this.account(userId);
    u.pin = pin;
    u.security = { ...u.security, pin_enabled: true, pin_length: pin.length as 4 | 6 };
  }

  setAge(userId: string, band: AgeBand): void {
    const u = this.account(userId);
    u.summary = { ...u.summary, age_band: band, guardian_consent: band === "14-17" ? "pending" : "not_required" };
  }

  /** Детский профиль напрямую. */
  addChild(guardian: string, name = "Мадина", band: AgeBand = "6-9"): string {
    const id = randomUUID();
    this.children.set(id, { learner_id: id, display_name: name, age_band: band, guardian, settings: DEFAULT_SETTINGS() });
    this.account(guardian).children.push(id);
    return id;
  }

  /** План напрямую (онбординг завершён). */
  onboard(learnerId: string, o: Partial<LearningPlan> = {}): LearningPlan {
    const p = { ...this.defaultPlan(learnerId), goal: "daily" as const, level_self: "beginner" as const, onboarding_completed_at: "2026-11-10T09:00:00Z", ...o };
    this.plans.set(learnerId, p);
    return p;
  }

  callsTo(service: Service, method?: string, path?: string): Call[] {
    return this.calls.filter((c) => c.service === service && (!method || c.method === method) && (!path || c.path === path));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const service = (Object.keys(URLS) as Service[]).find((k) => URLS[k] === url.origin);
    if (!service) throw new TypeError(`unknown upstream ${url.origin}`);
    if (this.down.has(service)) throw new TypeError("fetch failed: ECONNREFUSED");

    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const body = bodyText ? JSON.parse(bodyText) : undefined;

    let subject: string | undefined;
    try {
      const v = await verifyInternalToken(headers["x-internal-token"] ?? "", INTERNAL_SECRET, DOMAIN_AUD[service], new Set(["telegram-bff"]));
      subject = v.subject;
    } catch (err) {
      const e = err as { status?: number; code?: string };
      return domainError(e.status ?? 401, e.code ?? "INTERNAL_TOKEN_INVALID");
    }
    const query = Object.fromEntries(url.searchParams);
    const claims = decodeJwt(headers["x-internal-token"] ?? "") as Record<string, unknown>;
    this.calls.push({ service, method, path: url.pathname, query, subject, body, headers, claims });
    const req: Req = { method, path: url.pathname, query, subject, body, headers, claims };
    if (this.failAll && !this.failAll.except.has(service)) return domainError(this.failAll.status, this.failAll.code, { from: service });
    const ov = this.overrides.get(`${service} ${method} ${url.pathname}`);
    // таймаут BFF (AbortSignal) действует и на подделку: медленный обработчик прерывается как настоящий запрос
    const work = Promise.resolve(ov ? ov(req) : this.route(service, req));
    const signal = init?.signal;
    const res = signal
      ? await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        ])
      : await work;
    if (!this.decorate || res.status >= 300 || res.status === 204 || !(res.headers.get("content-type") ?? "").includes("json")) return res;
    const parsed: unknown = JSON.parse(await res.text());
    return json(res.status, this.decorate(parsed));
  };

  /** Все домены (кроме except) отвечают этой ошибкой — проверка проброса 4xx в ErrorBody на каждом маршруте. */
  failAll: { status: number; code: string; except: Set<Service> } | null = null;

  /** Пост-обработка успешных JSON-ответов доменов (тест «домен вернул лишние поля»). */
  decorate: ((body: unknown) => unknown) | null = null;

  private route(service: Service, r: Req): Response | Promise<Response> {
    switch (service) {
      case "identity":
        return this.identity(r);
      case "learningPlan":
        return this.learningPlan(r);
      case "notifications":
        return this.notificationsRoute(r);
      case "social":
        return this.social(r);
      case "support":
        return this.support(r);
      case "experience":
        return this.experienceRoute(r);
      case "catalog":
        return this.content.catalog(r);
      case "diagnostics":
        return this.content.diagnostics(r);
      case "lessons":
        return this.lessons.lessons(r);
      case "assessment":
        return this.lessons.assessment(r);
    }
  }

  // ---------------------------------------------------------------- identity-consent

  private learnerOf(u: FakeAccount): LearnerSummary & Record<string, unknown> {
    return {
      learner_id: u.summary.user_id,
      kind: "self",
      display_name: u.summary.display_name,
      age_band: u.summary.age_band,
      is_active: false,
      onboarding_completed: false,
      telegram_user_id: u.telegramId, // внутреннее поле — BFF не должен его пропустить наружу
    };
  }

  private childView(c: FakeChild, withSettings: boolean): Record<string, unknown> {
    return {
      learner_id: c.learner_id,
      kind: "child",
      display_name: c.display_name,
      age_band: c.age_band,
      is_active: false,
      onboarding_completed: false,
      guardian_user_id: c.guardian, // внутреннее поле
      ...(withSettings ? { settings: c.settings } : {}),
    };
  }

  private learners(u: FakeAccount) {
    return [this.learnerOf(u), ...u.children.map((id) => this.childView(this.children.get(id)!, false))];
  }

  private me(u: FakeAccount) {
    return {
      user: { ...u.summary, is_new: false, telegram_user_id: u.telegramId },
      security: u.security,
      consent: u.consent,
      settings: u.settings,
      learners: this.learners(u),
    };
  }

  private requireAccount(r: Req): FakeAccount | Response {
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    // identity /me/* — только аккаунт: ученик-ребёнок аккаунтом не является
    return this.accounts.get(r.subject) ?? domainError(404, "USER_NOT_FOUND");
  }

  private applyNotifications(s: NotificationSettings, patch: Record<string, unknown>): NotificationSettings | Response {
    const allowed = ["enabled", "quiet_hours", "timezone", "categories"];
    if (Object.keys(patch).some((k) => !allowed.includes(k))) return domainError(422, "VALIDATION_ERROR");
    const qh = patch.quiet_hours as { start: string; end: string } | null | undefined;
    if (qh && qh.start === qh.end) return domainError(422, "QUIET_HOURS_INVALID");
    if (patch.timezone === "Mars/Base") return domainError(422, "TIMEZONE_INVALID");
    return {
      ...s,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled as boolean } : {}),
      ...(patch.quiet_hours !== undefined ? { quiet_hours: qh ?? null } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone as string } : {}),
      categories: { ...s.categories, ...((patch.categories as object) ?? {}) },
    };
  }

  private grantView(teenId: string, g: { status: string; decided_at: string }) {
    return {
      teen_user_id: teenId,
      teen_display_name: this.accounts.get(teenId)?.summary.display_name ?? "?",
      status: g.status,
      decided_at: g.decided_at,
      guardian_user_id: "internal", // внутреннее поле — BFF не должен его пропустить
      telegram_user_id: 1,
    };
  }

  private identity(r: Req): Response {
    const key = `${r.method} ${r.path}`;
    if (key === "POST /internal/v1/users/telegram-login") {
      const b = r.body as { telegram_user_id: number; first_name: string; username?: string; language_code?: string };
      let u = this.usersByTg.get(b.telegram_user_id);
      const isNew = !u;
      if (!u) {
        const userId = randomUUID();
        u = {
          telegramId: b.telegram_user_id,
          summary: {
            user_id: userId,
            display_name: b.first_name,
            username: b.username ?? null,
            locale: b.language_code?.startsWith("uz") ? "uz" : "ru",
            status: "ACTIVE",
            is_new: true,
            age_band: null,
            guardian_consent: "not_required",
          },
          security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null, pin_reset_effective_at: null },
          pin: null,
          biometricToken: null,
          consent: { accepted: false, policy_version: null, current_policy_version: "2026-11-18", accepted_at: null, evidence_hash: null, purposes: [] },
          settings: DEFAULT_SETTINGS(),
          failedPins: 0,
          pendingPin: null,
          resetDue: false,
          children: [],
        };
        this.usersByTg.set(b.telegram_user_id, u);
        this.accounts.set(userId, u);
      }
      const { settings: _s, ...login } = this.me(u);
      return json(200, { ...login, user: { ...login.user, is_new: isNew } });
    }
    if (key === "GET /internal/v1/legal/policy") {
      return json(200, {
        version: "2026-11-18",
        purposes: [{ code: "terms", required: true, title: "Условия", description: "…" }],
        text: `# Policy ${r.query.lang}`,
      });
    }
    const gc = /^\/internal\/v1\/guardian-consents\/([^/]+)(?:\/(accept|decline))?$/.exec(r.path);
    if (gc) {
      const req = this.guardianRequests.get(gc[1]!);
      if (!req) return domainError(404, "GUARDIAN_CONSENT_NOT_FOUND");
      const teen = this.accounts.get(req.teen)!;
      const preview = () => json(200, { teen_display_name: teen.summary.display_name, status: req.status, expires_at: req.expires_at, teen_user_id: req.teen });
      if (r.method === "GET" && !gc[2]) return preview();
      if (r.method === "POST" && gc[2]) {
        if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
        if (r.subject === req.teen) return domainError(409, "GUARDIAN_CONSENT_SELF");
        const parent = this.accounts.get(r.subject);
        if (!parent || parent.summary.age_band !== "18+") return domainError(403, "ADULT_REQUIRED");
        if (req.status === "expired") return domainError(410, "GUARDIAN_CONSENT_EXPIRED");
        req.status = gc[2] === "accept" ? "granted" : "declined";
        teen.summary = { ...teen.summary, guardian_consent: req.status };
        this.grants.set(req.teen, { guardian: r.subject, status: req.status, decided_at: "2026-11-18T11:00:00Z" });
        return preview();
      }
    }
    const u = this.requireAccount(r);
    if (u instanceof Response) return u;
    // §11: решения родителя по подросткам (sub = родитель); отзыв — только тем, кто дал согласие
    if (key === "GET /internal/v1/me/guardian-consents") {
      const items = [...this.grants.entries()]
        .filter(([, g]) => g.guardian === u.summary.user_id)
        .map(([teen, g]) => this.grantView(teen, g));
      return json(200, { items });
    }
    const gr = /^\/internal\/v1\/me\/guardian-consents\/([^/:]+):revoke$/.exec(r.path);
    if (gr && r.method === "POST") {
      const teenId = gr[1]!;
      const g = this.grants.get(teenId);
      if (!g || g.guardian !== u.summary.user_id || g.status !== "granted") return domainError(404, "GUARDIAN_CONSENT_NOT_FOUND");
      g.status = "revoked";
      g.decided_at = "2026-11-18T12:00:00Z";
      const teen = this.accounts.get(teenId)!;
      teen.summary = { ...teen.summary, guardian_consent: "declined" };
      teen.consent = { ...teen.consent, purposes: teen.consent.purposes.filter((p) => ["terms", "privacy", "learning"].includes(p)) };
      return json(200, this.grantView(teenId, { ...g, status: "declined" }));
    }
    const lm = /^\/internal\/v1\/me\/learners\/([^/]+)$/.exec(r.path);
    if (lm) {
      const id = lm[1]!;
      if (id === u.summary.user_id && r.method === "GET") return json(200, this.learnerOf(u));
      const c = this.children.get(id);
      if (!c || c.guardian !== u.summary.user_id) return domainError(404, "LEARNER_NOT_FOUND");
      if (r.method === "GET") return json(200, this.childView(c, this.childSettingsInDetail));
      if (r.method === "PATCH") {
        const b = r.body as { display_name?: string; settings?: Record<string, unknown> };
        if (Object.keys(b).some((k) => !["display_name", "settings"].includes(k))) return domainError(422, "VALIDATION_ERROR");
        if (b.settings) {
          const next = this.applyNotifications(c.settings, b.settings);
          if (next instanceof Response) return next;
          c.settings = next;
        }
        if (b.display_name) c.display_name = b.display_name;
        return json(200, this.childView(c, this.childSettingsInDetail));
      }
    }
    switch (key) {
      case "GET /internal/v1/me":
        return json(200, this.me(u));
      case "PATCH /internal/v1/me/settings": {
        const b = r.body as { locale?: "ru" | "uz"; notifications?: Record<string, unknown> };
        if (Object.keys(b).some((k) => !["locale", "notifications"].includes(k))) return domainError(422, "VALIDATION_ERROR");
        if (b.notifications) {
          const next = this.applyNotifications(u.settings, b.notifications);
          if (next instanceof Response) return next;
          u.settings = next;
        }
        if (b.locale) u.summary = { ...u.summary, locale: b.locale };
        return json(200, this.me(u));
      }
      case "PUT /internal/v1/me/age": {
        const b = r.body as { age_band: AgeBand };
        if (u.summary.age_band) return domainError(409, "AGE_ALREADY_SET");
        this.setAge(u.summary.user_id, b.age_band);
        return json(200, this.me(u));
      }
      case "GET /internal/v1/me/learners":
        return json(200, { items: this.learners(u) });
      case "POST /internal/v1/me/learners": {
        if (u.summary.age_band !== "18+") return domainError(403, "ADULT_REQUIRED");
        const idem = r.headers["idempotency-key"];
        const prev = idem ? this.childIdem.get(`${u.summary.user_id}:${idem}`) : undefined;
        if (prev) return json(201, this.childView(this.children.get(prev)!, false));
        if (u.children.length >= 5) return domainError(409, "CHILDREN_LIMIT");
        const b = r.body as { display_name: string; age_band: AgeBand };
        const id = this.addChild(u.summary.user_id, b.display_name, b.age_band);
        if (idem) this.childIdem.set(`${u.summary.user_id}:${idem}`, id);
        return json(201, this.childView(this.children.get(id)!, false));
      }
      case "POST /internal/v1/me/guardian-consent-requests": {
        if (u.summary.age_band !== "14-17" || u.summary.guardian_consent === "granted") return domainError(409, "GUARDIAN_CONSENT_NOT_REQUIRED");
        const token = randomBytes(32).toString("base64url");
        for (const g of this.guardianRequests.values()) if (g.teen === u.summary.user_id && g.status === "pending") g.status = "expired";
        const expires_at = "2026-11-25T10:00:00Z";
        this.guardianRequests.set(token, { teen: u.summary.user_id, status: "pending", expires_at });
        return json(200, { token, expires_at });
      }
      case "PUT /internal/v1/me/pin": {
        const b = r.body as { pin: string; current_pin?: string };
        if (u.pin) {
          const checked = this.checkPin(u, b.current_pin);
          if (checked instanceof Response) return checked;
        }
        u.pin = b.pin;
        u.security = { ...u.security, pin_enabled: true, pin_length: b.pin.length as 4 | 6 };
        return json(200, u.security);
      }
      case "DELETE /internal/v1/me/pin": {
        const b = r.body as { current_pin: string };
        const checked = this.checkPin(u, b.current_pin);
        if (checked instanceof Response) return checked;
        u.pin = null;
        u.security = { ...u.security, pin_enabled: false, pin_length: null, biometric_enabled: false };
        return json(200, u.security);
      }
      case "POST /internal/v1/me/pin/verify": {
        const b = r.body as { pin: string };
        if (!u.pin) return domainError(409, "PIN_NOT_SET");
        const checked = this.checkPin(u, b.pin);
        if (checked instanceof Response) return checked;
        return json(200, { ok: true, pin_reset_applied: checked.applied });
      }
      case "POST /internal/v1/me/pin/reset-request":
        return json(200, { expires_in: 600 });
      case "POST /internal/v1/me/pin/reset-confirm": {
        const b = r.body as { code: string; new_pin: string };
        if (b.code !== "246810") return domainError(401, "RESET_CODE_INVALID", { remaining: 4 });
        // ревью T-8: новый код ждёт 24 ч, прежний действует до срока
        u.pendingPin = b.new_pin;
        u.resetDue = false;
        u.security = { ...u.security, pin_length: (u.pin?.length ?? 4) as 4 | 6, pin_reset_effective_at: RESET_EFFECTIVE_AT };
        return json(200, u.security);
      }
      case "POST /internal/v1/me/pin/reset-cancel": {
        const b = r.body as { current_pin: string };
        if (!u.pin) return domainError(409, "PIN_NOT_SET");
        if (u.pendingPin && !u.resetDue) {
          const checked = this.checkPin(u, b.current_pin);
          if (checked instanceof Response) return checked;
        }
        return json(200, u.security);
      }
      case "PUT /internal/v1/me/biometric":
        if (!u.pin) return domainError(409, "PIN_REQUIRED");
        u.biometricToken = "bio_" + randomUUID().replaceAll("-", "");
        u.security = { ...u.security, biometric_enabled: true };
        return json(200, { biometric_token: u.biometricToken, security: u.security });
      case "DELETE /internal/v1/me/biometric":
        u.biometricToken = null;
        u.security = { ...u.security, biometric_enabled: false };
        return json(200, u.security);
      case "POST /internal/v1/me/biometric/verify": {
        const b = r.body as { biometric_token: string };
        if (!u.biometricToken || b.biometric_token !== u.biometricToken) return domainError(401, "BIOMETRIC_INVALID");
        return json(200, { ok: true });
      }
      case "POST /internal/v1/me/consent": {
        const b = r.body as { policy_version: string; purposes: string[] };
        if (b.policy_version !== u.consent.current_policy_version) return domainError(409, "POLICY_VERSION_OUTDATED");
        const missing = ["terms", "privacy", "learning"].filter((p) => !b.purposes.includes(p));
        if (missing.length) return domainError(422, "CONSENT_REQUIRED_PURPOSES", { missing });
        const optional = b.purposes.filter((p) => !["terms", "privacy", "learning"].includes(p));
        if (optional.length && u.summary.age_band === "14-17" && u.summary.guardian_consent !== "granted") {
          return domainError(403, "GUARDIAN_CONSENT_REQUIRED");
        }
        u.consent = { ...u.consent, accepted: true, policy_version: b.policy_version, accepted_at: "2026-11-18T10:00:00Z", evidence_hash: "sha256:abc", purposes: b.purposes };
        return json(200, { ...u.consent, user_id: u.summary.user_id });
      }
      case "DELETE /internal/v1/me/consent":
        u.consent = { ...u.consent, accepted: false, purposes: [] };
        return json(200, u.consent);
      case "POST /internal/v1/me/deletion-request": {
        const b = r.body as { pin?: string; confirm_word?: string };
        if (u.pin) {
          const checked = this.checkPin(u, b.pin);
          if (checked instanceof Response) return checked.status === 401 ? domainError(401, "PIN_INVALID", { remaining: 4 }) : checked;
        } else if (!["УДАЛИТЬ", "OʻCHIRISH"].includes(b.confirm_word ?? "")) {
          return domainError(422, "CONFIRM_WORD_REQUIRED");
        }
        u.summary = { ...u.summary, status: "DELETION_REQUESTED" };
        return json(202, {
          request_id: randomUUID(),
          status: "REQUESTED",
          domains: ["learning-plan", "social", "notifications", "support", "experience-config"],
          learners: 1 + u.children.length,
          user_id: u.summary.user_id,
        });
      }
    }
    return domainError(404, "NOT_FOUND");
  }

  // ---------------------------------------------------------------- learning-plan

  defaultPlan(learnerId: string): LearningPlan {
    return {
      learner_id: learnerId,
      goal: null,
      level_self: null,
      topics: [],
      ui_lang: "ru",
      explain_lang: "ru",
      course_pair: "ru-en",
      schedule: { preset: "daily", days: [1, 2, 3, 4, 5, 6, 7], preferred_time: "19:00", duration_min: 20, reminders_enabled: false, timezone: "Asia/Tashkent" },
      onboarding_completed_at: null,
      updated_at: "2026-11-18T10:00:00Z",
      version: 1,
    };
  }

  /** Как learning-plan: план по умолчанию создаётся при первом обращении в зоне ?tz= (неизвестная → Asia/Tashkent). */
  private plan(id: string, tz?: string): LearningPlan {
    let p = this.plans.get(id);
    if (!p) {
      p = this.defaultPlan(id);
      if (tz && tz !== "Mars/Base") p = { ...p, schedule: { ...p.schedule, timezone: tz } };
      this.plans.set(id, p);
    }
    return p;
  }

  private today(id: string): TodayPlan {
    const p = this.plan(id);
    const minutes = this.minutesToday.get(id) ?? 0;
    return {
      local_date: "2026-11-18",
      is_scheduled_today: p.schedule.days.includes(3),
      slot_time: p.schedule.preferred_time,
      duration_min: p.schedule.duration_min,
      minutes_today: minutes,
      done_today: minutes >= p.schedule.duration_min,
      next_slot: { local_date: "2026-11-18", time: p.schedule.preferred_time },
      streak_days: minutes > 0 ? 1 : 0,
      week: [{ local_date: "2026-11-16", scheduled: true, done: false, missed: true }],
    };
  }

  private learningPlan(r: Req): Response {
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    const id = r.subject;
    const key = `${r.method} ${r.path}`;
    if (key === "GET /internal/v1/plan/trajectory") return this.content.trajectory(r, this.plans.get(id)?.goal ?? null);
    switch (key) {
      case "GET /internal/v1/me/plan":
        return json(200, { ...this.plan(id, r.query.tz), user_id: id, internal_note: "x" });
      case "PATCH /internal/v1/me/plan": {
        const p = this.plan(id);
        const ifMatch = r.headers["if-match"];
        if (ifMatch !== undefined && Number(ifMatch) !== p.version) return domainError(409, "PLAN_VERSION_CONFLICT", { current_version: p.version });
        const b = r.body as Partial<LearningPlan> & { schedule?: Partial<LearningPlan["schedule"]> };
        if (b.topics?.some((t) => !TOPICS.includes(t))) return domainError(422, "PLAN_INVALID", { field: "topics", reason: "unknown_topic" });
        if (b.schedule?.timezone === "Mars/Base") return domainError(422, "PLAN_INVALID", { field: "schedule.timezone", reason: "unknown_timezone" });
        const next: LearningPlan = { ...p, ...b, schedule: { ...p.schedule, ...(b.schedule ?? {}) }, version: p.version + 1 } as LearningPlan;
        this.plans.set(id, next);
        return json(200, next);
      }
      case "POST /internal/v1/me/plan/onboarding/complete": {
        const p = this.plan(id);
        const missing = [...(p.goal ? [] : ["goal"]), ...(p.level_self ? [] : ["level_self"])];
        if (missing.length) return domainError(409, "PLAN_INCOMPLETE", { missing });
        if (!p.onboarding_completed_at) this.plans.set(id, { ...p, onboarding_completed_at: "2026-11-18T10:05:00Z" });
        return json(200, this.plans.get(id));
      }
      case "GET /internal/v1/me/plan/today":
        return json(200, this.today(id));
      case "POST /internal/v1/me/activities": {
        const idem = r.headers["idempotency-key"];
        if (!idem) return domainError(422, "IDEMPOTENCY_KEY_REQUIRED");
        const k = `${id}:${idem}`;
        if (!this.activities.has(k)) {
          const b = r.body as { minutes: number };
          this.activities.set(k, b.minutes);
          this.minutesToday.set(id, (this.minutesToday.get(id) ?? 0) + b.minutes);
        }
        return json(200, this.today(id));
      }
      case "GET /internal/v1/directory/goals":
        return json(200, { items: GOALS.map((code) => ({ code, label: { ru: `цель ${code}`, uz: `maqsad ${code}` }, icon: null })) });
      case "GET /internal/v1/directory/topics":
        return json(200, { items: TOPICS.map((code) => ({ code, label: { ru: code, uz: code }, icon: "book" })) });
    }
    return domainError(404, "NOT_FOUND");
  }

  // ---------------------------------------------------------------- notifications

  addInbox(learnerId: string, o: Partial<InboxItem> = {}): InboxItem {
    const item: InboxItem = {
      notification_id: randomUUID(),
      category: "reminders",
      title: "Время занятия",
      body: "Пора заниматься",
      startapp: "route_home",
      created_at: "2026-11-18T14:00:00Z",
      read_at: null,
      telegram: "sent",
      ...o,
    };
    const list = this.inbox.get(learnerId) ?? [];
    list.unshift(item);
    this.inbox.set(learnerId, list);
    return item;
  }

  private notificationsRoute(r: Req): Response {
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    const list = this.inbox.get(r.subject) ?? [];
    const key = `${r.method} ${r.path}`;
    switch (key) {
      case "GET /internal/v1/me/inbox":
        return json(200, { items: list.slice(0, Number(r.query.limit ?? 20)).map((i) => ({ ...i, user_id: r.subject })), next_cursor: null });
      case "GET /internal/v1/me/inbox/unread-count":
        return json(200, { unread: list.filter((i) => !i.read_at).length });
      case "POST /internal/v1/me/inbox:read": {
        const b = r.body as { ids?: string[]; all?: boolean };
        for (const i of list) if (b.all || b.ids?.includes(i.notification_id)) i.read_at ??= "2026-11-18T15:00:00Z";
        return json(200, { unread: list.filter((i) => !i.read_at).length });
      }
    }
    return domainError(404, "NOT_FOUND");
  }

  // ---------------------------------------------------------------- social

  private socialInvite(rec: InviteRec): Invite & Record<string, unknown> {
    return { ...rec.invite, token_hash: createHash("sha256").update(rec.token).digest("hex"), inviter_user_id: rec.inviter };
  }

  private preview(rec: InviteRec, viewer: string) {
    const inviter = this.accounts.get(rec.inviter)!;
    const reason = viewer === rec.inviter ? "self" : rec.acceptedBy.has(viewer) ? "already_member" : null;
    return {
      invite_id: rec.invite.invite_id,
      kind: rec.invite.kind,
      inviter_display_name: inviter.summary.display_name,
      status: rec.invite.status,
      can_accept: reason === null && rec.invite.status === "active",
      reason,
      inviter_user_id: rec.inviter, // внутреннее поле
    };
  }

  private familyOf(userId: string): Family | null {
    for (const f of this.families.values()) if (f.members.some((m) => m.user_id === userId)) return f;
    return null;
  }

  private social(r: Req): Response {
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    const me = r.subject;
    const key = `${r.method} ${r.path}`;
    if (key === "POST /internal/v1/me/invites") {
      const idem = r.headers["idempotency-key"];
      if (!idem) return domainError(422, "IDEMPOTENCY_KEY_REQUIRED");
      const prev = this.inviteIdem.get(`${me}:${idem}`);
      if (prev) return json(201, this.socialInvite(this.invites.get(prev)!));
      const u = this.accounts.get(me);
      const b = r.body as { kind: Invite["kind"] };
      if (b.kind === "family" && u?.summary.age_band !== "18+") return domainError(403, "ADULT_REQUIRED");
      if (u?.summary.age_band === "14-17" && u.summary.guardian_consent !== "granted") return domainError(403, "INVITES_NOT_ALLOWED");
      const active = [...this.invites.values()].filter((x) => x.inviter === me && x.invite.status === "active");
      if (active.length >= 10) return domainError(409, "INVITES_LIMIT");
      const id = randomUUID();
      const token = randomBytes(24).toString("base64url").slice(0, 32);
      const rec: InviteRec = {
        invite: { invite_id: id, kind: b.kind, link: `${APP_LINK}?startapp=inv_${token}`, status: "active", expires_at: b.kind === "referral" ? null : "2026-11-25T10:00:00Z", created_at: "2026-11-18T10:00:00Z", accepted_count: 0 },
        inviter: me,
        token,
        opened: new Set(),
        acceptedBy: new Set(),
      };
      this.invites.set(id, rec);
      this.inviteIdem.set(`${me}:${idem}`, id);
      return json(201, this.socialInvite(rec));
    }
    if (key === "GET /internal/v1/me/invites") {
      const items = [...this.invites.values()].filter((x) => x.inviter === me).map((x) => this.socialInvite(x));
      return json(200, { items: items.slice(0, Number(r.query.limit ?? 20)), next_cursor: null });
    }
    if (key === "GET /internal/v1/me/family") {
      const f = this.familyOf(me);
      return f ? json(200, { ...f, members: f.members.map((m) => ({ ...m, is_me: m.user_id === me, telegram_user_id: 1 })) }) : domainError(404, "FAMILY_NOT_FOUND");
    }
    if (key === "POST /internal/v1/invites:open") {
      const rec = [...this.invites.values()].find((x) => x.token === (r.body as { token: string }).token);
      if (!rec) return domainError(404, "INVITE_NOT_FOUND");
      rec.opened.add(me);
      return json(200, this.preview(rec, me));
    }
    const dm = /^\/internal\/v1\/me\/invites\/([^/]+)$/.exec(r.path);
    if (dm && r.method === "DELETE") {
      const rec = this.invites.get(dm[1]!);
      if (!rec || rec.inviter !== me) return domainError(404, "INVITE_NOT_FOUND");
      rec.invite = { ...rec.invite, status: "revoked" };
      return json(200, this.socialInvite(rec));
    }
    const im = /^\/internal\/v1\/invites\/([^/]+)\/(preview|accept|decline)$/.exec(r.path);
    if (im) {
      const rec = this.invites.get(im[1]!);
      if (!rec || !rec.opened.has(me)) return domainError(404, "INVITE_NOT_FOUND");
      if (im[2] === "preview" && r.method === "GET") return json(200, this.preview(rec, me));
      if (im[2] === "decline" && r.method === "POST") return json(200, this.preview(rec, me));
      if (im[2] === "accept" && r.method === "POST") {
        if (rec.inviter === me) return domainError(409, "INVITE_SELF");
        if (rec.invite.status === "revoked") return domainError(409, "INVITE_REVOKED");
        let family: Family | null = null;
        if (rec.invite.kind === "family") {
          if (!rec.acceptedBy.has(me) && rec.invite.status !== "active") return domainError(409, "INVITE_ALREADY_USED");
          const inviter = this.accounts.get(rec.inviter)!;
          let f = this.families.get(rec.inviter);
          if (!f) {
            f = {
              family_id: randomUUID(),
              members: [
                { user_id: rec.inviter, display_name: inviter.summary.display_name, role: "owner", is_me: false },
                ...inviter.children.map((c) => ({ user_id: c, display_name: this.children.get(c)!.display_name, role: "child" as const, is_me: false })),
              ],
            };
            this.families.set(rec.inviter, f);
          }
          if (!f.members.some((m) => m.user_id === me)) {
            f.members.push({ user_id: me, display_name: this.accounts.get(me)?.summary.display_name ?? "?", role: "adult", is_me: false });
          }
          rec.invite = { ...rec.invite, status: "accepted", accepted_count: 1 };
          family = { ...f, members: f.members.map((m) => ({ ...m, is_me: m.user_id === me })) };
        }
        rec.acceptedBy.add(me);
        return json(200, { invite_id: rec.invite.invite_id, kind: rec.invite.kind, family });
      }
    }
    return domainError(404, "NOT_FOUND");
  }

  // ---------------------------------------------------------------- experience-config

  private experienceRoute(r: Req): Response {
    const key = `${r.method} ${r.path}`;
    if (key === "GET /internal/v1/experience/miniapp/current") return json(200, this.experience);
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    switch (key) {
      case "GET /internal/v1/release-notes/for-me":
        return json(200, this.forMe);
      case "POST /internal/v1/release-notes/seen": {
        const set = this.seen.get(r.subject) ?? new Set<string>();
        for (const id of (r.body as { release_note_ids: string[] }).release_note_ids) set.add(id);
        this.seen.set(r.subject, set);
        return new Response(null, { status: 204 });
      }
      case "GET /internal/v1/release-notes/feed":
        return json(200, { items: this.feed, next_cursor: null });
    }
    return domainError(404, "NOT_FOUND");
  }

  // ---------------------------------------------------------------- support

  private publicTicket(t: Ticket & { owner: string }): Ticket & { owner: string; assignee_id: string } {
    return { ...t, assignee_id: "internal" };
  }

  private support(r: Req): Response {
    if (r.method === "GET" && r.path === "/internal/v1/support/categories") {
      return json(200, { items: [{ code: "SCHEDULE_REMINDERS", label: { ru: "График и напоминания", uz: "Jadval va eslatmalar" }, available: true }] });
    }
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    const owner = r.subject;
    if (r.method === "POST" && r.path === "/internal/v1/me/tickets") {
      const idem = r.headers["idempotency-key"];
      if (!idem) return domainError(422, "IDEMPOTENCY_KEY_REQUIRED");
      const prev = this.ticketIdem.get(`${owner}:${idem}`);
      if (prev) return json(200, this.publicTicket(this.tickets.get(prev)!));
      const b = r.body as { category: Ticket["category"]; subject: string; message: string; context?: Ticket["context"] };
      const id = randomUUID();
      const now = "2026-11-18T10:00:00Z";
      const t: Ticket & { owner: string } = {
        owner,
        ticket_id: id,
        number: `TCK-${this.ticketSeq++}`,
        category: b.category,
        subject: b.subject,
        status: "NEW",
        created_at: now,
        updated_at: now,
        last_message_at: now,
        unread_operator_replies: 0,
        context: b.context ?? null,
        sla_first_response_at: "2026-11-18T12:00:00Z",
        messages: [{ message_id: randomUUID(), sender_type: "user", author_name: null, text: b.message, created_at: now }],
        status_history: [{ status: "NEW", at: now }],
      };
      this.tickets.set(id, t);
      this.ticketIdem.set(`${owner}:${idem}`, id);
      return json(201, this.publicTicket(t));
    }
    if (r.method === "GET" && r.path === "/internal/v1/me/tickets") {
      const items = [...this.tickets.values()].filter((t) => t.owner === owner).map((t) => {
        const { context: _c, messages: _m, status_history: _s, sla_first_response_at: _f, ...summary } = t;
        return summary;
      });
      return json(200, { items: items.slice(0, Number(r.query.limit ?? 20)), next_cursor: null });
    }
    const m = /^\/internal\/v1\/me\/tickets\/([^/]+)(?:\/(messages|close))?$/.exec(r.path);
    if (m) {
      const ref = m[1]!;
      const t = /^TCK-\d+$/.test(ref) ? [...this.tickets.values()].find((x) => x.number === ref) : this.tickets.get(ref);
      if (!t || t.owner !== owner) return domainError(404, "SUPPORT_TICKET_NOT_FOUND");
      if (!m[2] && r.method === "GET") return json(200, this.publicTicket(t));
      if (m[2] === "messages" && r.method === "POST") {
        if (t.status === "CLOSED") return domainError(409, "SUPPORT_TICKET_CLOSED");
        t.messages.push({ message_id: randomUUID(), sender_type: "user", author_name: null, text: (r.body as { text: string }).text, created_at: "2026-11-18T10:01:00Z" });
        return json(200, this.publicTicket(t));
      }
      if (m[2] === "close" && r.method === "POST") {
        t.status = "CLOSED";
        t.status_history.push({ status: "CLOSED", at: "2026-11-18T10:02:00Z" });
        return json(200, this.publicTicket(t));
      }
    }
    return domainError(404, "NOT_FOUND");
  }
}

// ---------------------------------------------------------------- app harness

let sharedRedis: Redis | null = null;
export function testRedis(): Redis {
  sharedRedis ??= new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
  return sharedRedis;
}

export async function closeRedis(): Promise<void> {
  if (sharedRedis) {
    await sharedRedis.quit();
    sharedRedis = null;
  }
}

export interface Harness {
  app: App;
  fake: FakeDomains;
  logs: LogCapture;
  config: Config;
  close(): Promise<void>;
}

export async function makeHarness(env: Record<string, string> = {}): Promise<Harness> {
  const config = testConfig(env);
  const fake = new FakeDomains();
  const logs = new LogCapture();
  const redis = testRedis();
  const app = await buildApp(config, { redis, fetchImpl: fake.fetch, logStream: logs });
  await app.ready();
  return {
    app,
    fake,
    logs,
    config,
    async close() {
      await app.close();
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", `${config.redisKeyPrefix}*`, "COUNT", 500);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== "0");
    },
  };
}

export interface TgUser {
  id: number;
  first_name: string;
  username?: string;
  language_code?: string;
  last_name?: string;
}

export const TG_USER: TgUser = { id: 900001, first_name: "Игорь", username: "test_user_1", language_code: "ru" };
export const TG_OTHER: TgUser = { id: 900002, first_name: "Анна", username: "test_user_2", language_code: "uz" };

export function initDataFor(user: TgUser | null = TG_USER, opts: { authDate?: number; token?: string; startParam?: string } = {}): string {
  return signInitData(opts.token ?? BOT_TOKEN, {
    user,
    // каждый запуск Mini App — свой initData (query_id): initData одноразовый
    queryId: `AAH${randomBytes(12).toString("hex")}`,
    ...(opts.authDate !== undefined ? { authDate: opts.authDate } : {}),
    ...(opts.startParam !== undefined ? { startParam: opts.startParam } : {}),
  });
}

export interface LoggedIn {
  access: string;
  refresh: string;
  userId: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function login(h: Harness, user: TgUser = TG_USER, ip = "203.0.113.10", startParam?: string): Promise<LoggedIn> {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/session/telegram",
    payload: { init_data: initDataFor(user, startParam !== undefined ? { startParam } : {}) },
    remoteAddress: ip,
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { access: body.access_token, refresh: body.refresh_token, userId: body.account.user_id, body };
}

/** Переключиться на ученика (детский профиль или обратно) → новые токены. */
export async function switchTo(h: Harness, s: LoggedIn, learnerId: string, pin?: string): Promise<LoggedIn> {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/session/learner",
    headers: bearer(s.access),
    payload: { learner_id: learnerId, ...(pin ? { pin } : {}) },
  });
  if (res.statusCode !== 200) throw new Error(`switch failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { access: body.access_token, refresh: body.refresh_token, userId: body.account.user_id, body };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const idem = () => ({ "idempotency-key": randomUUID() });

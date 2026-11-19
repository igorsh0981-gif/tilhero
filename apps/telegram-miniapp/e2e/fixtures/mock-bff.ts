import type { Page, Route } from "@playwright/test";
import type {
  AgeBand,
  ConsentState,
  ExperienceConfig,
  Family,
  GuardianConsent,
  GuardianConsentGrant,
  InboxItem,
  Invite,
  InvitePreview,
  LearnerSummary,
  LearningPlan,
  NotificationSettings,
  PlanPatch,
  Profile,
  SecurityState,
  SessionResponse,
  SettingsPatch,
  Ticket,
  TodayPlan,
  UiLang,
  UserSummary,
  WhatsNew,
} from "@tilhero/contracts/bff";
import { MockContent, type ContentScenario } from "./content";
import * as F from "./data";

/**
 * Stateful mock of telegram-bff for Playwright (page.route on /__bff/**). Shapes follow packages/contracts/src/bff.ts,
 * rules follow docs/sprint1/INTERNAL_API.md (whats-new modes, invite reasons, plan If-Match). The state survives
 * page.reload(): a reload checks «after the next login the same plan is there» (AT-01, AT-06).
 */
export interface Scenario {
  onboarded?: boolean;
  age?: AgeBand | null;
  guardian?: GuardianConsent;
  locale?: UiLang;
  /** published release notes visible to the learner (default: welcome + both updates) */
  notes?: F.NoteSeed[];
  /** notes already seen by the account's learner */
  seen?: string[];
  inbox?: InboxItem[];
  /** invitations that can be opened by token (inv_<token>) */
  incoming?: Record<string, { invite: Omit<InvitePreview, "can_accept" | "reason">; self?: boolean; inviterName?: string }>;
  family?: Family | null;
  pin?: string | null;
  pinRequired?: boolean;
  /** a reset through the bot is pending (review T-8): the new code and when it takes effect */
  pendingReset?: { pin: string; at: string };
  /** guardian consent links (gc_<token>) */
  guardianLinks?: Record<string, { teen: string; status: "pending" | "granted" | "declined" | "expired" }>;
  /** answer this status (and code) once for "METHOD /path" */
  failOnce?: Record<string, number | [number, string]>;
  /** the BFF reports the plan changed elsewhere on the next PATCH with If-Match */
  conflictOnce?: boolean;
  /** start_param the BFF returns from initData */
  startParam?: string | null;
  tickets?: Ticket[];
  /** purposes of the accepted consent of an onboarded account (default: required + product_news, without social) */
  purposes?: string[];
  /** teens 14–17 this account decided for (GET /v1/family/guardian-consents) */
  grants?: GuardianConsentGrant[];
  /** Remote Experience Config answered instead of the seed (e.g. theme notebook_dark) */
  config?: ExperienceConfig;
  /** sprint 3: placement test, skill map, plan, practice, requests */
  content?: ContentScenario;
  /** start in a child profile 6–9 of the (adult) account, onboarded */
  child?: boolean;
}

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

const PUBLIC = [/^\/v1\/session\/(telegram|refresh)$/, /^\/v1\/legal\/policy/, /^\/v1\/experience\/config/, /^GET \/v1\/guardian-consents\//];

function localYmd(tz: string, d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function isoWd(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

export class MockBff {
  readonly requests: Recorded[] = [];
  readonly sc: Scenario;
  account: UserSummary;
  learners: LearnerSummary[];
  active: string;
  security: SecurityState;
  consent: ConsentState;
  settings: Record<string, NotificationSettings> = {};
  plans: Record<string, LearningPlan> = {};
  activities: Record<string, Record<string, number>> = {};
  idem = new Map<string, unknown>();
  seen: Record<string, Set<string>> = {};
  notes: F.NoteSeed[];
  inboxItems: InboxItem[];
  invites: Invite[] = [];
  family: Family | null;
  tickets: Ticket[];
  grants: GuardianConsentGrant[];
  /** the parent code of the account (PUT/DELETE /v1/profile/security/pin, reset) */
  pin: string | null;
  /** the new code of a pending reset (review T-8): it does not work until security.pin_reset_effective_at */
  pendingPin: string | null;
  readonly content: MockContent;
  private access = 0;
  private failOnce: Record<string, number | [number, string]>;
  private conflictOnce: boolean;
  private seq = 1;

  constructor(sc: Scenario = {}) {
    this.sc = sc;
    const onboarded = !!sc.onboarded;
    const age = sc.age === undefined ? (onboarded ? "18+" : null) : sc.age;
    this.account = F.account({ locale: sc.locale ?? "ru", is_new: !onboarded, age_band: age, guardian_consent: sc.guardian ?? (age === "14-17" ? "pending" : "not_required") });
    this.learners = [F.selfLearner({ age_band: age, onboarding_completed: onboarded })];
    this.active = F.ACCOUNT_ID;
    this.security = F.security(sc.pin ? { pin_enabled: true, pin_length: sc.pin.length as 4 | 6, pin_required: !!sc.pinRequired } : {});
    this.consent = F.consent(onboarded, sc.purposes ?? ["terms", "privacy", "learning", "product_news"]);
    this.pin = sc.pin ?? null;
    this.pendingPin = sc.pendingReset?.pin ?? null;
    if (sc.pendingReset) this.security.pin_reset_effective_at = sc.pendingReset.at;
    this.grants = sc.grants ? sc.grants.map((g) => ({ ...g })) : [];
    this.settings[F.ACCOUNT_ID] = F.settings(onboarded ? { categories: { reminders: true, missed: true, social: true, support: true, product: true } } : {});
    this.plans[F.ACCOUNT_ID] = onboarded ? F.onboardedPlan(F.ACCOUNT_ID) : F.plan(F.ACCOUNT_ID, { ui_lang: sc.locale ?? "ru" });
    this.notes = sc.notes ?? [F.WELCOME, F.UPDATE_1, F.UPDATE_2];
    this.seen[F.ACCOUNT_ID] = new Set(sc.seen ?? (onboarded ? [F.WELCOME.id] : []));
    this.inboxItems = sc.inbox ?? (onboarded ? F.inbox() : []);
    this.family = sc.family ?? null;
    this.tickets = sc.tickets ?? [];
    this.failOnce = { ...(sc.failOnce ?? {}) };
    this.conflictOnce = !!sc.conflictOnce;
    this.content = new MockContent(sc.content ?? {});
    if (sc.child) {
      const id = "7a1c2b3a-2222-4a2b-9c3d-000000000777";
      this.learners.push({ learner_id: id, kind: "child", display_name: "Мадина", age_band: "6-9", is_active: true, onboarding_completed: true });
      this.plans[id] = F.onboardedPlan(id);
      this.settings[id] = F.settings();
      this.seen[id] = new Set([F.WELCOME.id, F.UPDATE_1.id, F.UPDATE_2.id]);
      this.active = id;
    }
  }

  async install(page: Page): Promise<void> {
    await page.route("**/__bff/**", (route) => this.handle(route));
    await page.route("https://telegram.org/**", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
    await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
    await page.route("https://fonts.gstatic.com/**", (route) => route.fulfill({ status: 404, body: "" }));
    // «Поделиться» outside Telegram opens t.me/share/url in a new window
    await page.context().route("https://t.me/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>t.me</title>" }));
  }

  /* ---------- helpers ---------- */
  learner(): LearnerSummary {
    return this.learners.find((l) => l.learner_id === this.active)!;
  }
  plan(): LearningPlan {
    return this.plans[this.active]!;
  }
  calls(method: string, path: string | RegExp): Recorded[] {
    return this.requests.filter((r) => r.method === method && (typeof path === "string" ? r.path === path : path.test(r.path)));
  }
  last(method: string, path: string | RegExp): Recorded | undefined {
    const c = this.calls(method, path);
    return c[c.length - 1];
  }
  private cancelPendingReset(): void {
    this.pendingPin = null;
    this.security = { ...this.security, pin_reset_effective_at: null };
  }

  private session(): SessionResponse {
    this.access += 1;
    const l = this.learner();
    const p = this.plan();
    return {
      access_token: `acc-${this.access}`,
      expires_in: 900,
      refresh_token: `ref-${this.access}`,
      account: { ...this.account },
      learner: { ...l, onboarding_completed: !!p.onboarding_completed_at },
      learners: this.learners.map((x) => ({ ...x, is_active: x.learner_id === this.active, onboarding_completed: !!this.plans[x.learner_id]?.onboarding_completed_at })),
      security: { ...this.security },
      consent: { ...this.consent },
      onboarding_completed: !!p.onboarding_completed_at,
      start_param: this.sc.startParam ?? null,
    };
  }
  private profile(): Profile {
    const s = this.session();
    return { account: s.account, learner: s.learner, learners: s.learners, security: s.security, consent: s.consent, notifications: this.settings[this.active] ?? F.settings() };
  }
  private today(): TodayPlan {
    const p = this.plan();
    const s = p.schedule;
    const today = localYmd(s.timezone);
    const acts = this.activities[this.active] ?? {};
    const wd = isoWd(today);
    const monday = addDays(today, 1 - wd);
    const week = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(monday, i);
      const scheduled = s.days.includes(i + 1);
      const done = (acts[d] ?? 0) > 0;
      return { local_date: d, scheduled, done, missed: scheduled && !done && d < today };
    });
    let next: { local_date: string; time: string } | null = null;
    for (let i = (acts[today] ?? 0) > 0 ? 1 : 0; i < 8; i++) {
      const d = addDays(today, i);
      if (s.days.includes(isoWd(d))) {
        next = { local_date: d, time: s.preferred_time };
        break;
      }
    }
    return {
      local_date: today,
      is_scheduled_today: s.days.includes(wd),
      slot_time: s.days.includes(wd) ? s.preferred_time : null,
      duration_min: s.duration_min,
      minutes_today: acts[today] ?? 0,
      done_today: (acts[today] ?? 0) > 0,
      next_slot: next,
      streak_days: 3 + ((acts[today] ?? 0) > 0 ? 1 : 0),
      week,
    };
  }
  private whatsNew(): WhatsNew {
    const p = this.plan();
    if (!p.onboarding_completed_at) return { mode: "none", notes: [] };
    const lang = p.ui_lang;
    const seen = (this.seen[this.active] ??= new Set());
    const published = [...this.notes].sort((a, b) => (a.published_at < b.published_at ? 1 : -1));
    const news = published.filter((n) => n.audience === "new");
    const sawNew = news.some((n) => seen.has(n.id));
    if (!sawNew && news.length) {
      const lastAll = published.find((n) => n.audience === "all");
      const notes = [...news, ...(lastAll ? [lastAll] : [])].filter((n) => !seen.has(n.id)).slice(0, 5);
      return { mode: "welcome", notes: notes.map((n) => F.toNote(n, lang)) };
    }
    const notes = published.filter((n) => n.audience !== "new" && !seen.has(n.id) && n.published_at > (p.onboarding_completed_at ?? "")).slice(0, 5);
    return notes.length ? { mode: "updates", notes: notes.map((n) => F.toNote(n, lang)) } : { mode: "none", notes: [] };
  }
  private err(route: Route, status: number, code: string, details: Record<string, unknown> = {}) {
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ code, message: code, trace_id: "e2e", details }) });
  }
  private ok(route: Route, body: unknown, status = 200) {
    if (status === 204 || body === undefined) return route.fulfill({ status: 204, body: "" });
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  }

  /* ---------- router ---------- */
  async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/__bff/, "");
    const method = req.method();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    const headers = req.headers();
    this.requests.push({ method, path, query: url.searchParams, headers, body });
    const key = `${method} ${path}`;
    if (this.failOnce[key]) {
      const f = this.failOnce[key]!;
      delete this.failOnce[key];
      const [status, code] = Array.isArray(f) ? f : [f, f >= 500 ? "UPSTREAM_UNAVAILABLE" : "VALIDATION_ERROR"];
      return this.err(route, status, code);
    }
    const open = PUBLIC.some((r) => r.test(path) || r.test(key));
    if (!open && !(headers.authorization ?? "").startsWith("Bearer acc-")) return this.err(route, 401, "UNAUTHORIZED");
    const b = (body ?? {}) as Record<string, unknown>;

    // ---- session ----
    if (key === "POST /v1/session/telegram" || key === "POST /v1/session/refresh") return this.ok(route, this.session());
    if (key === "POST /v1/session/pin/verify") {
      if (b.pin !== this.pin) return this.err(route, 401, "PIN_INVALID", { remaining: 4 });
      this.security.pin_required = false;
      this.cancelPendingReset(); // the old code cancels a pending reset
      return this.ok(route, this.session());
    }
    if (key === "POST /v1/session/learner") {
      const target = this.learners.find((l) => l.learner_id === b.learner_id);
      if (!target) return this.err(route, 404, "LEARNER_NOT_FOUND");
      if (this.learner().kind === "child" && this.security.pin_enabled) {
        if (b.pin !== this.pin) return this.err(route, 401, "PIN_INVALID", { remaining: 4 });
        this.cancelPendingReset();
      }
      this.active = target.learner_id;
      return this.ok(route, this.session());
    }
    if (key === "GET /v1/experience/config") return this.ok(route, this.sc.config ?? F.CONFIG);

    // ---- profile, age, children ----
    if (key === "GET /v1/profile") return this.ok(route, this.profile());
    if (key === "PATCH /v1/profile/settings") {
      const patch = b as SettingsPatch;
      if (patch.locale) this.account.locale = patch.locale;
      if (patch.notifications) {
        const cur = this.settings[this.active] ?? F.settings();
        const n = patch.notifications;
        if (n.quiet_hours && n.quiet_hours.start === n.quiet_hours.end) return this.err(route, 422, "QUIET_HOURS_INVALID");
        this.settings[this.active] = {
          ...cur,
          ...(n.enabled !== undefined ? { enabled: n.enabled } : {}),
          ...(n.quiet_hours !== undefined ? { quiet_hours: n.quiet_hours } : {}),
          ...(n.timezone ? { timezone: n.timezone } : {}),
          categories: { ...cur.categories, ...(n.categories ?? {}), support: true },
        };
      }
      return this.ok(route, this.profile());
    }
    if (key === "PUT /v1/profile/age") {
      if (this.account.age_band) return this.err(route, 409, "AGE_ALREADY_SET");
      this.account.age_band = b.age_band as AgeBand;
      this.account.guardian_consent = b.age_band === "14-17" ? "pending" : "not_required";
      this.learners[0]!.age_band = b.age_band as AgeBand;
      return this.ok(route, this.profile());
    }
    if (key === "POST /v1/learners") {
      if (this.account.age_band !== "18+") return this.err(route, 403, "ADULT_REQUIRED");
      const k = `learners:${headers["idempotency-key"]}`;
      if (this.idem.has(k)) return this.ok(route, this.idem.get(k), 201);
      const id = `7a1c2b3a-2222-4a2b-9c3d-${String(this.seq++).padStart(12, "0")}`;
      const l: LearnerSummary = { learner_id: id, kind: "child", display_name: String(b.display_name), age_band: b.age_band as AgeBand, is_active: false, onboarding_completed: false };
      this.learners.push(l);
      this.plans[id] = F.plan(id);
      this.settings[id] = F.settings();
      this.seen[id] = new Set();
      this.idem.set(k, l);
      return this.ok(route, l, 201);
    }
    if (key === "GET /v1/learners") return this.ok(route, { items: this.session().learners });
    if (key === "POST /v1/profile/guardian-consent") {
      if (this.account.age_band !== "14-17" || this.account.guardian_consent === "granted") return this.err(route, 409, "GUARDIAN_CONSENT_NOT_REQUIRED");
      return this.ok(route, { link: "https://t.me/TilHeroBot/app?startapp=gc_TeenToken0123456789abcdefghijklmnopqrstu", expires_at: "2026-11-25T08:00:00Z" });
    }
    let m = /^\/v1\/guardian-consents\/([A-Za-z0-9_-]+)(?:\/(accept|decline))?$/.exec(path);
    if (m) {
      const link = this.sc.guardianLinks?.[m[1]!];
      if (!link) return this.err(route, 404, "GUARDIAN_CONSENT_NOT_FOUND");
      if (m[2]) {
        if (this.account.age_band !== "18+") return this.err(route, 403, "ADULT_REQUIRED");
        // §11: the decision is the teen's consent on the guardian basis — the parent's own consent first
        if (!this.consent.accepted) return this.err(route, 403, "CONSENT_REQUIRED", { purpose: "terms" });
        link.status = m[2] === "accept" ? "granted" : "declined";
      }
      return this.ok(route, { teen_display_name: link.teen, status: link.status, expires_at: "2026-11-25T08:00:00Z" });
    }

    // ---- teens the parent decided for (§11) ----
    if (key === "GET /v1/family/guardian-consents") {
      if (this.learner().kind === "child") return this.err(route, 403, "ADULT_REQUIRED");
      return this.ok(route, { items: this.grants });
    }
    m = /^\/v1\/family\/guardian-consents\/([0-9a-f-]{36})\/revoke$/.exec(path);
    if (m && method === "POST") {
      const g = this.grants.find((x) => x.teen_user_id === m![1] && x.status === "granted");
      if (!g) return this.err(route, 404, "GUARDIAN_CONSENT_NOT_FOUND");
      g.status = "declined";
      g.decided_at = new Date().toISOString();
      return this.ok(route, g);
    }

    // ---- parent code ----
    if (path.startsWith("/v1/profile/security/pin") && this.learner().kind === "child") return this.err(route, 403, "ADULT_REQUIRED");
    if (key === "PUT /v1/profile/security/pin") {
      if (this.pin && b.current_pin !== this.pin) return this.err(route, 401, "PIN_INVALID", { remaining: 4 });
      this.pin = String(b.pin);
      this.security = { ...this.security, pin_enabled: true, pin_length: this.pin.length as 4 | 6, pin_required: false };
      return this.ok(route, this.security);
    }
    if (key === "DELETE /v1/profile/security/pin") {
      if (b.current_pin !== this.pin) return this.err(route, 401, "PIN_INVALID", { remaining: 4 });
      this.pin = null;
      this.security = { ...this.security, pin_enabled: false, pin_length: null, biometric_enabled: false };
      return this.ok(route, this.security);
    }
    if (key === "POST /v1/profile/security/pin/reset-request") return this.ok(route, { expires_in: 600 });
    if (key === "POST /v1/profile/security/pin/reset-confirm") {
      if (b.code !== "246810") return this.err(route, 401, "RESET_CODE_INVALID", { remaining: 4 });
      // review T-8: the new code waits 24 h; the session and the old code do not change
      this.pendingPin = String(b.new_pin);
      this.security = { ...this.security, pin_reset_effective_at: new Date(Date.now() + 24 * 3600_000).toISOString() };
      return this.ok(route, this.security);
    }
    if (key === "POST /v1/profile/security/pin/reset-cancel") {
      if (this.pendingPin) {
        if (b.current_pin !== this.pin) return this.err(route, 401, "PIN_INVALID", { remaining: 4 });
        this.cancelPendingReset();
      }
      return this.ok(route, { ...this.security });
    }

    // ---- consents ----
    if (key === "GET /v1/legal/policy") return this.ok(route, F.policy((url.searchParams.get("lang") as UiLang) ?? "ru"));
    if (key === "POST /v1/profile/consent") {
      const purposes = (b.purposes as string[]) ?? [];
      const missing = ["terms", "privacy", "learning"].filter((p) => !purposes.includes(p));
      if (missing.length) return this.err(route, 422, "CONSENT_REQUIRED_PURPOSES", { missing });
      if (this.account.age_band === "14-17" && this.account.guardian_consent !== "granted" && purposes.some((p) => !["terms", "privacy", "learning"].includes(p)))
        return this.err(route, 403, "GUARDIAN_CONSENT_REQUIRED");
      this.consent = { ...F.consent(true, purposes), accepted_at: new Date().toISOString() };
      return this.ok(route, this.consent);
    }

    // ---- plan ----
    if (key === "GET /v1/plan") return this.ok(route, this.plan());
    if (key === "PATCH /v1/plan") {
      const p = this.plan();
      const ifMatch = headers["if-match"];
      if (ifMatch && this.conflictOnce) {
        this.conflictOnce = false;
        this.plans[this.active] = { ...p, schedule: { ...p.schedule, preferred_time: "07:30" }, version: p.version + 1 };
        return this.err(route, 409, "PLAN_VERSION_CONFLICT", { current_version: p.version + 1 });
      }
      if (ifMatch && Number(ifMatch) !== p.version) return this.err(route, 409, "PLAN_VERSION_CONFLICT", { current_version: p.version });
      const patch = b as PlanPatch;
      if (patch.schedule?.days && (!patch.schedule.days.length || patch.schedule.days.some((d) => d < 1 || d > 7))) return this.err(route, 422, "PLAN_INVALID", { field: "days", reason: "invalid" });
      if (patch.schedule?.duration_min && ![10, 15, 20, 30].includes(patch.schedule.duration_min)) return this.err(route, 422, "PLAN_INVALID", { field: "duration_min", reason: "invalid" });
      if ((patch as Record<string, unknown>).course_pair) return this.err(route, 422, "VALIDATION_ERROR");
      if (patch.topics && patch.topics.length > 5) return this.err(route, 422, "PLAN_INVALID", { field: "topics", reason: "too_many" });
      if (patch.topics && patch.topics.some((t) => !F.TOPICS.some((x) => x.code === t))) return this.err(route, 422, "PLAN_INVALID", { field: "topics", reason: "unknown_topic" });
      this.plans[this.active] = {
        ...p,
        ...(patch.goal ? { goal: patch.goal } : {}),
        ...(patch.level_self ? { level_self: patch.level_self } : {}),
        ...(patch.topics ? { topics: [...patch.topics] } : {}),
        ...(patch.ui_lang ? { ui_lang: patch.ui_lang } : {}),
        ...(patch.explain_lang ? { explain_lang: patch.explain_lang } : {}),
        schedule: { ...p.schedule, ...(patch.schedule ?? {}) },
        version: p.version + 1,
        updated_at: new Date().toISOString(),
      };
      return this.ok(route, this.plan());
    }
    if (key === "POST /v1/plan/onboarding/complete") {
      const p = this.plan();
      const missing = [...(p.goal ? [] : ["goal"]), ...(p.level_self ? [] : ["level_self"])];
      if (missing.length) return this.err(route, 409, "PLAN_INCOMPLETE", { missing });
      if (!p.onboarding_completed_at) this.plans[this.active] = { ...p, onboarding_completed_at: new Date().toISOString(), version: p.version + 1 };
      this.learner().onboarding_completed = true;
      return this.ok(route, this.plan());
    }
    if (key === "GET /v1/plan/today") return this.ok(route, this.today());
    if (key === "POST /v1/plan/activity") {
      const k = `act:${headers["idempotency-key"]}`;
      if (!headers["idempotency-key"]) return this.err(route, 422, "IDEMPOTENCY_KEY_REQUIRED");
      if (!this.idem.has(k)) {
        const day = localYmd(this.plan().schedule.timezone);
        const acts = (this.activities[this.active] ??= {});
        acts[day] = (acts[day] ?? 0) + Number(b.minutes);
        this.idem.set(k, true);
      }
      return this.ok(route, this.today());
    }
    if (key === "GET /v1/directory/goals") return this.ok(route, { items: F.GOALS });
    if (key === "GET /v1/directory/topics") return this.ok(route, { items: F.TOPICS });

    // ---- notification center ----
    if (key === "GET /v1/notifications") return this.ok(route, { items: this.inboxItems, next_cursor: null });
    if (key === "GET /v1/notifications/unread-count") return this.ok(route, { unread: this.inboxItems.filter((i) => !i.read_at).length });
    if (key === "POST /v1/notifications/read") {
      const now = new Date().toISOString();
      const ids = (b.ids as string[] | undefined) ?? [];
      this.inboxItems = this.inboxItems.map((i) => (b.all || ids.includes(i.notification_id) ? { ...i, read_at: i.read_at ?? now } : i));
      return this.ok(route, { unread: this.inboxItems.filter((i) => !i.read_at).length });
    }

    // ---- invites & family ----
    if (key === "POST /v1/invites") {
      const k = `inv:${headers["idempotency-key"]}`;
      if (this.idem.has(k)) return this.ok(route, this.idem.get(k), 201);
      if (!this.consent.purposes.includes("social")) return this.err(route, 403, "CONSENT_REQUIRED", { purpose: "social" });
      if (b.kind === "family" && this.account.age_band !== "18+") return this.err(route, 403, "ADULT_REQUIRED");
      const id = `33333333-aaaa-4bbb-8ccc-${String(this.seq++).padStart(12, "0")}`;
      const inv: Invite = {
        invite_id: id,
        kind: b.kind as Invite["kind"],
        link: `https://t.me/TilHeroBot/app?startapp=inv_Tok${String(this.seq).padStart(29, "0")}`,
        status: "active",
        expires_at: b.kind === "friend" ? "2026-12-18T08:00:00Z" : "2026-11-25T08:00:00Z",
        created_at: new Date().toISOString(),
        accepted_count: 0,
      };
      this.invites.unshift(inv);
      this.idem.set(k, inv);
      return this.ok(route, inv, 201);
    }
    if (key === "GET /v1/invites") return this.ok(route, { items: this.invites, next_cursor: null });
    m = /^\/v1\/invites\/([0-9a-f-]{36})$/.exec(path);
    if (m && method === "DELETE") {
      const inv = this.invites.find((i) => i.invite_id === m![1]);
      if (!inv) return this.err(route, 404, "INVITE_NOT_FOUND");
      inv.status = "revoked";
      return this.ok(route, inv);
    }
    if (key === "POST /v1/invites/open" || /^GET \/v1\/invites\/[0-9a-f-]{36}\/preview$/.test(key)) {
      // §11: open and preview — after the policy is accepted
      if (!this.consent.accepted) return this.err(route, 403, "CONSENT_REQUIRED", { purpose: "terms" });
      const entry = key.startsWith("POST")
        ? this.sc.incoming?.[String(b.token)]
        : Object.values(this.sc.incoming ?? {}).find((e) => key.includes(e.invite.invite_id));
      if (!entry) return this.err(route, 404, "INVITE_NOT_FOUND");
      return this.ok(route, this.preview(entry));
    }
    m = /^\/v1\/invites\/([0-9a-f-]{36})\/(accept|decline)$/.exec(path);
    if (m) {
      const entry = Object.values(this.sc.incoming ?? {}).find((e) => e.invite.invite_id === m![1]);
      if (!entry) return this.err(route, 404, "INVITE_NOT_FOUND");
      if (m[2] === "decline") return this.ok(route, { ...this.preview(entry), status: entry.invite.status });
      if (entry.self) return this.err(route, 409, "INVITE_SELF");
      // §11: accepting needs the optional purpose «social»
      if (!this.consent.purposes.includes("social")) return this.err(route, 403, "CONSENT_REQUIRED", { purpose: "social" });
      if (entry.invite.status === "accepted") return this.err(route, 409, "INVITE_ALREADY_USED");
      entry.invite.status = "accepted";
      if (entry.invite.kind === "family") {
        this.family = {
          family_id: "44444444-aaaa-4bbb-8ccc-000000000001",
          members: [
            { user_id: "55555555-aaaa-4bbb-8ccc-000000000001", display_name: entry.invite.inviter_display_name, role: "owner", is_me: false },
            { user_id: F.ACCOUNT_ID, display_name: this.account.display_name, role: "adult", is_me: true },
          ],
        };
      }
      return this.ok(route, { invite_id: entry.invite.invite_id, kind: entry.invite.kind, family: entry.invite.kind === "family" ? this.family : null });
    }
    if (key === "GET /v1/family") return this.family ? this.ok(route, this.family) : route.fulfill({ status: 204, body: "" });

    // ---- whats-new & news ----
    if (key === "GET /v1/whats-new") return this.ok(route, this.whatsNew());
    if (key === "POST /v1/whats-new/seen") {
      const set = (this.seen[this.active] ??= new Set());
      for (const id of (b.release_note_ids as string[]) ?? []) set.add(id);
      return route.fulfill({ status: 204, body: "" });
    }
    if (key === "GET /v1/news") {
      const lang = this.plan().ui_lang;
      return this.ok(route, { items: [...this.notes].sort((a, z) => (a.published_at < z.published_at ? 1 : -1)).map((n) => F.toNote(n, lang)), next_cursor: null });
    }

    // ---- support ----
    if (key === "GET /v1/support/categories") {
      return this.ok(route, {
        items: (["LESSON", "SCHEDULE_REMINDERS", "CHILD_PROFILE", "ACCOUNT", "PERSONAL_DATA", "BUG", "OTHER"] as const).map((c) => ({ code: c, label: { ru: c, uz: c }, available: true })),
      });
    }
    if (key === "GET /v1/support/tickets") return this.ok(route, { items: this.tickets, next_cursor: null });
    if (key === "POST /v1/support/tickets") {
      const k = `tck:${headers["idempotency-key"]}`;
      if (this.idem.has(k)) return this.ok(route, this.idem.get(k), 201);
      const now = new Date().toISOString();
      const n = 3083 + this.tickets.length;
      const t: Ticket = {
        ticket_id: `66666666-aaaa-4bbb-8ccc-${String(n).padStart(12, "0")}`,
        number: `TCK-${n}`,
        category: b.category as Ticket["category"],
        subject: String(b.subject),
        status: "NEW",
        created_at: now,
        updated_at: now,
        last_message_at: now,
        unread_operator_replies: 0,
        context: null,
        sla_first_response_at: null,
        messages: [{ message_id: "m1", sender_type: "user", author_name: null, text: String(b.message), created_at: now }],
        status_history: [{ status: "NEW", at: now }],
      };
      this.tickets.unshift(t);
      this.idem.set(k, t);
      return this.ok(route, t, 201);
    }
    m = /^\/v1\/support\/tickets\/([0-9a-f-]{36})(?:\/(messages|close))?$/.exec(path);
    if (m) {
      const t = this.tickets.find((x) => x.ticket_id === m![1]);
      if (!t) return this.err(route, 404, "SUPPORT_TICKET_NOT_FOUND");
      if (m[2] === "messages") t.messages.push({ message_id: `m${t.messages.length + 1}`, sender_type: "user", author_name: null, text: String(b.text), created_at: new Date().toISOString() });
      if (m[2] === "close") t.status = "CLOSED";
      return this.ok(route, t);
    }

    // ---- sprint 3 ----
    const s3 = this.content.handle(method, path, url.searchParams, b, headers, { kid: this.learner().kind === "child", goal: this.plan().goal, idem: this.idem }, (status, out, code, details, raw) => {
      if (raw) return route.fulfill({ status, contentType: raw.contentType, body: raw.body, headers: { etag: '"e2e-audio"', "cache-control": "private, max-age=3600" } });
      if (code) return this.err(route, status, code, details ?? {});
      return this.ok(route, out, status);
    });
    if (s3) return s3;

    // ---- deletion ----
    if (key === "POST /v1/profile/delete-request") {
      return this.ok(route, { request_id: "77777777-aaaa-4bbb-8ccc-000000000001", status: "REQUESTED", domains: ["identity-consent", "learning-plan", "social", "notifications", "support", "experience-config"], learners: this.learners.length }, 202);
    }
    return this.err(route, 404, "NOT_FOUND");
  }

  private preview(entry: NonNullable<Scenario["incoming"]>[string]): InvitePreview {
    const inv = entry.invite;
    const can = !entry.self && inv.status === "active";
    return {
      ...inv,
      can_accept: can,
      reason: entry.self ? "self" : inv.status === "accepted" ? "already_used" : inv.status === "expired" ? "expired" : inv.status === "revoked" ? "revoked" : null,
    };
  }
}

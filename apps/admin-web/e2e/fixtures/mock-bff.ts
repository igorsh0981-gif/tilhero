import type { Page, Route } from "@playwright/test";
import type {
  AdminUserRow,
  AiBudget,
  DiscoveryRun,
  ReviewDetail,
  Source,
  SourceCrawlStats,
  Approval,
  AuditRecord,
  ConfigActivation,
  ConfigApp,
  ConfigVersion,
  ErrorBody,
  LoginStep,
  Me,
  Permission,
  RoleCode,
  Staff,
  StaffTicket,
  TicketStatus,
  TravelProviderStatus,
  NewsAdminItem,
  NewsSource,
  AiLimits,
} from "@tilhero/contracts/admin";
import type { Ticket as ClientTicket } from "@tilhero/contracts/bff";
import type { StaffReleaseNote } from "@tilhero/contracts/admin";
import * as F from "./data";
import * as C from "./catalog";
import * as T from "./travel";
import * as N from "./news";
import * as A from "./ai";
import * as O from "./ops";

export interface Scenario {
  /** start with a live cookie session of this account (skips the sign-in screen) */
  signedInAs?: string;
  env?: Me["env"];
  /** idle timeout of the session (admin-bff default 1800 s) */
  idleSeconds?: number;
  authMode?: "local" | "ad";
  /** answer 403 PERMISSION_DENIED for these "METHOD /path" keys even when the role has the permission */
  deny?: Record<string, Permission>;
  /** only one active super_admin → four-eyes waived */
  singleSuperAdmin?: boolean;
  /** "METHOD /path": the first such request carries a session id already rotated in another tab → 409 SESSION_ROTATED
   *  (the «browser» now holds the new cookie; the rotation also issued a new CSRF token) */
  rotateOnce?: string;
  /** replace the permissions of a role (e.g. operations without ops.kill_switch) */
  matrix?: Partial<Record<RoleCode, Permission[]>>;
  /** a discovery run is in progress (POST /discovery/runs → 409 DISCOVERY_RUN_IN_PROGRESS) */
  running?: boolean;
  /** the AI search is stopped by the kill switch */
  paused?: boolean;
  /** empty review queue / no sources / no runs */
  emptyCatalog?: boolean;
  /** GET /discovery/budget fails (503 UPSTREAM_UNAVAILABLE) */
  budgetDown?: boolean;
  /** PUT /discovery/pause: provider-gateway cannot write the audit record (503 AUDIT_UNAVAILABLE, state unchanged) */
  auditDown?: boolean;
  /** GET /sources/crawl-stats fails: provider-gateway down (503 UPSTREAM_UNAVAILABLE) or no PROVIDER_GATEWAY_URL (503 FEATURE_UNAVAILABLE) */
  crawlDown?: "unavailable" | "feature-off";
  /** admin-bff has no URL of these domains yet: their routes answer 503 FEATURE_UNAVAILABLE */
  featureOff?: Array<"review" | "sources" | "discovery" | "travel" | "offers">;
  /** sprint 5: GET /travel/providers — which cards (default «mixed»: one ok, one breaker open, one not configured) */
  providers?: T.ProvidersVariant;
  /** GET /travel/providers fails: provider-gateway down (503 UPSTREAM_UNAVAILABLE) */
  travelDown?: boolean;
  /** fix 5.1: POST /travel/providers/{name}/probe outcome per provider (default ok); one probe per 30 s → 429 */
  probe?: Partial<Record<T.TravelName, T.ProbeOutcome>>;
  /** GET /offers/{id}: the snapshot of TCK-3074 without a departure city / belonging to another user / offers down */
  offer?: "nodeparture" | "foreign" | "down" | "fx";
  /** sprint 6: admin-bff without NEWS_URL / WATCH_URL → 503 FEATURE_UNAVAILABLE {service: news | watch} */
  newsOff?: boolean;
  watchOff?: boolean;
  /** sprint 6: POST /news/sources[/{id}]/check outcome (default ok) */
  feedCheck?: N.CheckOutcome;
  /** fix 6.1: the AI limits were set in the admin (default — env values) */
  limitsAdmin?: boolean;
  /** sprint 6: provider-gateway before sprint 6 — AiBudget without the news field */
  budgetNoNews?: boolean;
  /** sprint 6: no feeds and no news yet */
  emptyNews?: boolean;
  /** sprint 6: the next PATCH of a feed hits 409 NEWS_SOURCE_VERSION_CONFLICT (another staff member saved first) */
  feedConflict?: boolean;
  /** sprint 7: admin-bff without AI_CONTROL_URL / AI_CONCIERGE_URL → 503 FEATURE_UNAVAILABLE */
  aiOff?: boolean;
  /** sprint 7: ai-control down — the budgets overview is built from provider-gateway only (control: "unavailable") */
  controlDown?: boolean;
  /** sprint 7: ai-concierge cannot write ai.content.view (503 AUDIT_UNAVAILABLE, nothing revealed) */
  revealAuditDown?: boolean;
  /** sprint 7: the open draft of concierge.event is authored by this account (four-eyes) */
  draftAuthor?: string;
  /** sprint 7: the user Igor has a manual access level (plus, with an expiry) */
  manualLevel?: boolean;
  /** sprint 7: the next Test Console run fails a required case */
  runFails?: boolean;
  /** review 7 (M4): provider-gateway of fix 6.1 — the limits without the concierge / Test Console budgets (null) */
  gateway61?: boolean;
  /** sprint 8: admin-bff without OPS_MONITOR_URL → /ops/* 503 FEATURE_UNAVAILABLE, dashboard system not_configured */
  opsOff?: boolean;
  /** sprint 8: Aviasales is down (breaker open, critical alert) */
  providerDown?: boolean;
  /** sprint 8: JetStream unavailable → queues 503 NATS_UNAVAILABLE */
  natsDown?: boolean;
  /** sprint 8: a lagging and a stalled consumer */
  queueLag?: boolean;
  /** sprint 8: dashboard blocks without data / served from the stale copy */
  dashOff?: O.DashOpts["off"];
  dashStale?: O.BlockName[];
  /** sprint 8, A45: n8n is down — schedules are late, screens still answer 200 */
  n8nDown?: boolean;
  noFlightEmpty?: boolean;
  /** sprint 8: the first DLQ command by filter hits 409 DLQ_COUNT_CHANGED (one more message arrived) */
  dlqCountChanged?: boolean;
  /** sprint 8: the alert feed — ai-control did not answer */
  feedAiDown?: boolean;
  /** sprint 9: open alerts of the new kinds (service_down news, deletion_stuck, rate_limit_spike tg.user) */
  s9Alerts?: boolean;
  /** sprint 9: the next deletion retry → 409 DELETION_RETRY_TOO_SOON {retry_after: 240} */
  delTooSoon?: boolean;
  /** sprint 9: the rate limit Redis is down → override / reset 503 RATE_LIMIT_UNAVAILABLE */
  rlRedisDown?: boolean;
  /** sprint 9: "METHOD /path" answers 429 RATE_LIMITED {policy: adm.staff, retry_after: 12} once */
  rateLimitedOnce?: string;
  /** sprint 9: no deletions at all */
  noDeletions?: boolean;
  /** sprint 9 (SEC-11): rewrites every successful JSON body (hostile strings in events, news, DLQ, tickets…) */
  transform?: (path: string, data: unknown) => unknown;
}

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Session {
  staffId: string;
  csrf: string;
  stepUpUntil: number;
  impersonating: RoleCode | null;
}

const PREFIX = "/admin/v1";
const STAFF_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  NEW: ["IN_PROGRESS"],
  IN_PROGRESS: ["WAITING_CUSTOMER", "RESOLVED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "RESOLVED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: [],
};

/**
 * Stateful mock of admin-bff for Playwright (page.route on /admin/v1/**): cookie-session semantics, CSRF check on
 * every non-GET, permission check per route (403 PERMISSION_DENIED), step-up window (403 STEP_UP_REQUIRED), login
 * counters/lock, four-eyes approvals, support state machine, experience-config activations.
 */
export class MockBff {
  readonly requests: Recorded[] = [];
  readonly sc: Scenario;
  accounts = F.accounts();
  matrix: Record<RoleCode, Permission[]> = JSON.parse(JSON.stringify(F.MATRIX));
  users: AdminUserRow[] = F.users();
  tickets: StaffTicket[];
  audit: AuditRecord[] = F.auditRecords();
  approvals: Approval[] = [];
  sla = F.SLA_POLICIES();
  session: Session | null = null;
  /* sprint 4: event catalog */
  sources: Source[] = C.sources();
  reviews: ReviewDetail[] = C.reviews();
  runs: DiscoveryRun[] = C.runs();
  budget: AiBudget = C.budget();
  /* fix 6.1: AI limits (provider-gateway ai:limits) */
  limits: AiLimits = C.limits();
  crawl: SourceCrawlStats[] = C.crawlStats();
  /* sprint 5 / fix 5.1: trip providers (stateful: «Check now» updates the card) */
  travel: TravelProviderStatus[] = [];
  /* sprint 6: news feeds and news (stateful) */
  feeds: NewsSource[] = N.sources();
  news: NewsAdminItem[] = N.items();
  private probedAt = new Map<string, number>();
  /* sprint 7: AI agents, budgets, alerts, price catalogue, skills, access levels (stateful) */
  aiAgents = A.agents();
  aiRuntime = A.runtime();
  aiAlerts = A.alerts();
  /* sprint 8 */
  opsProviders: import("@tilhero/contracts/admin").ProviderHealth[] = [];
  opsAlerts: import("@tilhero/contracts/admin").OpsAlert[] = [];
  dlq = O.dlqItems();
  dlqActions = O.dlqActions();
  dlqCountTrip = false;
  /* sprint 9 */
  deletions = O.deletionRows();
  rlPolicies = O.rateLimitPolicies();
  private replays = new Map<string, unknown>();
  provider: import("@tilhero/contracts/admin").AiPause | null = null;
  prices = A.priceVersions();
  skill!: A.SkillState;
  levels = A.levels();
  access = new Map<string, import("@tilhero/contracts/admin").UserAccessLevel>();
  runs7 = new Map<string, import("@tilhero/contracts/admin").EvalRun>();
  versions: Record<ConfigApp, ConfigVersion[]>;
  /** 9.4 «Что нового»: заметки о релизах (сид — черновик «Ноябрь 2026», как миграция 0004 experience-config) */
  releaseNotes: StaffReleaseNote[] = [F.releaseNoteSeed()];
  activations: Record<ConfigApp, ConfigActivation[]>;
  current: Record<ConfigApp, string>;
  previous: Record<ConfigApp, string | null>;
  private failures = new Map<string, number>();
  private challenges = new Map<string, { staffId: string; step: string; tries: number }>();
  private enrolled = new Set<string>();
  private idem = new Map<string, unknown>();
  private changes = new Map<string, import("@tilhero/contracts/admin").SourceChange[]>();
  private seq = 0;

  constructor(sc: Scenario = {}) {
    this.sc = sc;
    this.tickets = F.tickets(this.users);
    if (sc.singleSuperAdmin) this.accounts = this.accounts.filter((a) => a.staff.staff_id !== F.ID.admin2);
    const ver = (app: ConfigApp, version: string, payload: Record<string, unknown>, note: string, daysAgo: number): ConfigVersion => ({
      version_id: `c0000000-0000-4000-8000-${app === "admin" ? "1" : "2"}${version.replace(/\./g, "").padStart(11, "0")}`,
      app,
      version,
      checksum: `${app}${version}`.padEnd(64, "a"),
      change_note: note,
      created_by: "system:seed",
      created_at: F.iso(-daysAgo * 86_400_000),
      status: null,
      payload,
    });
    this.versions = {
      miniapp: [ver("miniapp", "2.0.2", F.miniPayload("2.0.2", F.MINI_TOKENS_202), "Тема default 2.0.2: мятный акцент", 18), ver("miniapp", "2.0.3", F.miniPayload("2.0.3", F.MINI_TOKENS_203), "Тёмный премиум: лайм на navy", 4)],
      admin: [ver("admin", "1.0.0", F.adminPayload("1.0.0", F.ADMIN_ACCENT_100), "Admin default 1.0: navy + lime", 4), ver("admin", "1.0.1", F.adminPayload("1.0.1", F.ADMIN_ACCENT_101), "Мятный акцент (эксперимент)", 1)],
    };
    this.current = { miniapp: "2.0.3", admin: "1.0.1" };
    this.previous = { miniapp: "2.0.2", admin: "1.0.0" };
    const act = (app: ConfigApp, version: string, previous_version: string | null, daysAgo: number, reason: string): ConfigActivation => ({
      activation_id: `ac000000-0000-4000-8000-${app === "admin" ? "1" : "2"}${version.replace(/\./g, "").padStart(11, "0")}`,
      app,
      version,
      previous_version,
      kind: "activate",
      reason,
      activated_by: "system:seed",
      activated_at: F.iso(-daysAgo * 86_400_000),
    });
    this.activations = {
      miniapp: [act("miniapp", "2.0.3", "2.0.2", 4, "Переход на тёмный премиум"), act("miniapp", "2.0.2", null, 18, "Начальная тема")],
      admin: [act("admin", "1.0.1", "1.0.0", 1, "Эксперимент с акцентом"), act("admin", "1.0.0", null, 4, "Начальная конфигурация")],
    };
    if (sc.signedInAs) this.session = this.newSession(this.account(sc.signedInAs)!.staff.staff_id);
    for (const [role, ps] of Object.entries(sc.matrix ?? {})) this.matrix[role as RoleCode] = [...ps!];
    if (sc.running) this.runs.unshift(C.runningRun());
    if (sc.paused) this.budget.paused = { paused: true, reason: "Модель отвечает ошибками, разбираемся", by: F.ID.ops, by_name: null, at: F.iso(-40 * 60_000) };
    this.travel = T.providers(sc.providers);
    if (sc.budgetNoNews) delete this.budget.news;
    if (sc.limitsAdmin) {
      Object.assign(this.limits, { ai_daily_usd: "2.50", news_daily_usd: "0.40", pages_daily: 500, source: "admin", updated_by: F.ID.ops, updated_at: F.iso(-3 * 3_600_000), reason: "Фестивальный сезон: больше афиш" });
      this.budget = { ...this.budget, budget_usd: "2.50", pages_limit: 500, news: this.budget.news ? { ...this.budget.news, budget_usd: "0.40" } : this.budget.news };
    }
    if (sc.emptyNews) {
      this.feeds = [];
      this.news = [];
    }
    this.skill = A.skill(sc.draftAuthor ? this.account(sc.draftAuthor)!.staff.staff_id : F.ID.ops);
    if (sc.manualLevel) this.access.set(F.USER.igor, A.userAccess(F.USER.igor, true));
    this.opsProviders = O.providers(sc.providerDown);
    this.opsAlerts = [...(sc.s9Alerts ? O.sprint9Alerts() : []), ...O.opsAlerts(sc.providerDown)];
    if (sc.noDeletions) this.deletions = [];
    if (sc.emptyCatalog) {
      this.reviews = [];
      this.runs = [];
    }
  }


  /* ---------------------------------------------------------------- sprint 8 helpers */
  consumersNow(): import("@tilhero/contracts/admin").ConsumerInfo[] {
    return O.consumers(this.sc.queueLag).map((c) => {
      const mine = this.dlq.filter((x) => x.consumer === c.durable);
      return { ...c, dlq: { count: mine.length, last_at: mine.length ? mine.map((x) => x.dead_at).sort().at(-1)! : null } };
    });
  }
  /** state: present (по умолчанию) | replayed | all — повторённые остаются в DLQ (ревью 8) */
  dlqMatch(consumer: string | null, eventType: string | null, source: string | null, state: string | null = "present") {
    const st = state || "present";
    return this.dlq.filter(
      (x) =>
        (!consumer || x.consumer === consumer) &&
        (!eventType || x.event_type === eventType) &&
        (!source || x.source === source) &&
        (st === "all" || x.state === st),
    );
  }

  /* ---------------------------------------------------------------- sprint 7 helpers */
  /** admin-bff fills <field>_name of staff ids (admin-identity staff/lookup) */
  named<T>(v: T): T {
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (!x || typeof x !== "object") return;
      const o = x as Record<string, unknown>;
      for (const k of ["by", "updated_by", "author", "reviewer", "created_by", "activated_by", "assigned_by", "acked_by", "started_by"]) {
        if (`${k}_name` in o) o[`${k}_name`] = this.nameOf(o[k] as string | null);
      }
      Object.values(o).forEach(walk);
    };
    const copy = JSON.parse(JSON.stringify(v)) as T;
    walk(copy);
    return copy;
  }
  accessOf(userId: string): import("@tilhero/contracts/admin").UserAccessLevel {
    return this.access.get(userId) ?? A.userAccess(userId);
  }
  /** the budgets overview = ai-control (month, state, alerts) + provider-gateway (pauses, day) + limits */
  overview(): import("@tilhero/contracts/admin").AiBudgetOverview {
    const control = !this.sc.controlDown;
    const agents = this.aiRuntime.map((a) => {
      const paused = a.paused ?? null;
      const state = paused || this.provider ? "paused" : a.state;
      const base = { ...a, paused, state, alerts: this.aiAlerts.filter((x) => x.agent_id === a.agent_id).slice(0, 5) } as typeof a;
      return control ? base : { ...base, name: a.agent_id, month: null, degrade_at_pct: null, degraded_mode: null, alerts: [], state: (paused || this.provider ? "paused" : "normal") as typeof a.state };
    });
    return this.named({ agents, provider: { anthropic: { paused: this.provider } }, limits: this.namedLimits(), gateway: "ok", control: control ? "ok" : "unavailable", at: F.iso(0) });
  }
  killState(): import("@tilhero/contracts/admin").AiKillSwitchState {
    return this.named({
      provider: { anthropic: { paused: this.provider } },
      agents: this.aiRuntime.map((a) => ({ agent_id: a.agent_id, paused: a.paused, budget: a.day ? { ...a.day, reserved_usd: "0.0000", day: F.iso(0).slice(0, 10) } : null })),
    });
  }
  skillDetail(): import("@tilhero/contracts/admin").SkillDetail {
    const vs = this.skill.versions;
    const acts = this.skill.activations;
    const cur = acts[acts.length - 1]!;
    return this.named({
      skill_id: "concierge.event",
      agent_id: "concierge",
      title: "Консьерж: событие",
      critical: true,
      code_managed: false,
      active: { version: cur.version, activation_id: cur.activation_id, since: cur.effective_from },
      versions: vs.map((v) => ({ version: v.version, status: v.status })),
      versions_full: vs.map((v) => ({
        version: v.version,
        status: v.status,
        artifact_hash: v.artifact_hash,
        author: v.author,
        author_name: null,
        reviewer: v.reviewer,
        reviewer_name: null,
        editors: v.editors,
        created_at: v.created_at,
        published_at: v.published_at,
        change_note: v.artifact.change_note,
      })),
      activations: acts,
    });
  }
  private activate(version: number, kind: "publish" | "rollback", by: string, reason: string): import("@tilhero/contracts/admin").SkillActivation {
    const prev = this.skill.activations[this.skill.activations.length - 1]!.version;
    const a = { activation_id: `b0b0b0b0-1111-4222-8333-${String(++this.seq).padStart(12, "0")}`, skill_id: "concierge.event", version, kind, effective_from: F.iso(0), by, by_name: null, reason, previous_version: prev, created_at: F.iso(0), cancelled: false };
    this.skill.activations.push(a);
    return a;
  }

  /** a newer candidate of the same source replaces the facts of an OPEN item (the next decision gets 409 REVIEW_CHANGED) */
  updateCandidate(reviewId: string, facts: Record<string, unknown>): void {
    const r = this.reviews.find((x) => x.review_id === reviewId)!;
    r.facts = { ...r.facts, ...facts };
    if (typeof facts.title === "string") r.title = facts.title;
    if (facts.start) r.start = facts.start as ReviewDetail["start"];
    r.content_hash = C.factsHash(r.facts);
  }

  /** admin-bff: staff ids → names (admin-identity staff lookup) */
  nameOf(id: string | null | undefined): string | null {
    return (id && this.accounts.find((a) => a.staff.staff_id === id)?.staff.display_name) || null;
  }
  private namedSource<T extends Source>(x: T): T {
    return { ...x, updated_by_name: this.nameOf(x.updated_by) };
  }
  private namedReview(r: ReviewDetail): ReviewDetail {
    return { ...r, decided_by_name: this.nameOf(r.decided_by) };
  }
  namedLimits(): AiLimits {
    const l = { ...this.limits, updated_by_name: this.limits.updated_by ? this.nameOf(this.limits.updated_by) : null };
    if (!this.sc.gateway61) return l;
    // admin-bff normalises a 6.1 gateway answer to null agent budgets
    return { ...l, concierge_daily_usd: null, evaluation_daily_usd: null, defaults: { ...l.defaults, concierge_daily_usd: null, evaluation_daily_usd: null } };
  }
  /** max_cost_usd of the active and open versions of the agent's skills (ai-control agent_skill_costs) */
  private skillCosts(agentId: string) {
    if (agentId !== "concierge") return [];
    const active = this.skill.activations[this.skill.activations.length - 1]?.version;
    return this.skill.versions
      .filter((v) => v.version === active || v.status === "DRAFT" || v.status === "TESTED" || v.status === "REVIEW")
      .map((v) => ({ skill_id: v.skill_id, version: v.version, status: v.status, max_cost_usd: v.artifact.limits.max_cost_usd }));
  }
  private namedBudget(): AiBudget {
    const b = this.budget;
    return b.paused ? { ...b, paused: { ...b.paused, by_name: this.nameOf(b.paused.by) } } : b;
  }

  /** another staff member decides the review item first (the next decision gets 409 REVIEW_ALREADY_DECIDED) */
  decideElsewhere(reviewId: string): void {
    const r = this.reviews.find((x) => x.review_id === reviewId)!;
    Object.assign(r, { status: "ACCEPTED", decided_by: F.ID.admin2, decided_at: F.iso(0), decision_note: "Проверено по странице источника", event_id: "e1000000-0000-4000-8000-000000000077" });
  }

  /** the running discovery run finishes (auto-refresh picks it up) */
  finishRunning(): void {
    const r = this.runs.find((x) => x.status === "RUNNING");
    if (r) Object.assign(r, { status: "COMPLETED", finished_at: F.iso(0), scopes_done: r.scopes_total });
  }

  async install(page: Page): Promise<void> {
    await page.route(`**${PREFIX}/**`, (route) => this.handle(route));
    // banners of review candidates (third-party CDNs in production): a local SVG, the request is recorded
    await page.route(/\/e2e-banner\.svg$/, (route) => {
      this.images.push({ url: route.request().url(), referer: route.request().headers()["referer"] ?? null });
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: C.BANNER_SVG });
    });
  }
  readonly images: Array<{ url: string; referer: string | null }> = [];

  calls(method: string, path: string | RegExp): Recorded[] {
    return this.requests.filter((r) => r.method === method && (typeof path === "string" ? r.path === path : path.test(r.path)));
  }

  /** server-side revocation (role/password changed elsewhere): the next request answers 401 SESSION_REVOKED */
  revoke(): void {
    this.revoked = true;
  }

  /** another staff member signs in in this browser (e.g. the second super admin who decides a request) */
  switchTo(email: string): void {
    this.session = this.newSession(this.account(email)!.staff.staff_id);
  }
  private revoked = false;

  account(email: string) {
    return this.accounts.find((a) => a.staff.email === email);
  }
  staffById(id: string) {
    return this.accounts.find((a) => a.staff.staff_id === id)?.staff;
  }

  private newSession(staffId: string): Session {
    return { staffId, csrf: `csrf-${Math.random().toString(36).slice(2)}`, stepUpUntil: 0, impersonating: null };
  }

  private perms(): Permission[] {
    if (!this.session) return [];
    const s = this.staffById(this.session.staffId)!;
    const own = this.matrix[s.role];
    return this.session.impersonating ? own.filter((p) => this.matrix[this.session!.impersonating!].includes(p)) : [...own];
  }

  me(): Me {
    const s = this.staffById(this.session!.staffId)!;
    return {
      staff: { staff_id: s.staff_id, email: s.email, display_name: s.display_name, role: s.role },
      permissions: this.perms(),
      mfa_enabled: s.mfa_enabled,
      must_change_password: s.must_change_password,
      session: {
        expires_at: F.iso(8 * 3_600_000),
        idle_timeout_seconds: this.sc.idleSeconds ?? 1800,
        step_up_until: this.session!.stepUpUntil > Date.now() ? new Date(this.session!.stepUpUntil).toISOString() : null,
      },
      csrf_token: this.session!.csrf,
      env: this.sc.env ?? "stage",
      runbook_base_url: "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/",
      impersonating: this.session!.impersonating,
    };
  }

  private challenge(staffId: string, step: string): string {
    const c = `ch-${++this.seq}-${Math.random().toString(36).slice(2, 10)}`;
    this.challenges.set(c, { staffId, step, tries: 5 });
    return c;
  }

  /** next sign-in step for the staff member (must_change_password → mfa_enroll → mfa → done) */
  private nextStep(s: Staff, after: "password" | "password_change" | "mfa_enroll" | "mfa"): LoginStep {
    const priv = F.PRIVILEGED.includes(s.role);
    if (after === "password" && s.must_change_password) return { next: "password_change", challenge: this.challenge(s.staff_id, "password_change"), me: null };
    if ((after === "password" || after === "password_change") && priv && !s.mfa_enabled) return { next: "mfa_enroll", challenge: this.challenge(s.staff_id, "mfa_enroll"), me: null };
    if ((after === "password" || after === "password_change") && s.mfa_enabled) return { next: "mfa", challenge: this.challenge(s.staff_id, "mfa"), me: null };
    s.last_login_at = F.iso(0);
    this.session = this.newSession(s.staff_id);
    this.record("auth.login", "staff", s.staff_id, null);
    return { next: "done", challenge: null, me: this.me() };
  }

  private record(action: string, object_type: string | null, object_id: string | null, after: Record<string, unknown> | null, reason: string | null = null): void {
    const seq = (this.audit[0]?.seq ?? 1000) + 1;
    this.audit.unshift({
      seq,
      record_id: `ad000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      occurred_at: F.iso(0),
      recorded_at: F.iso(0),
      source: "admin-bff",
      actor_type: this.session ? "staff" : "system",
      actor_id: this.session?.staffId ?? null,
      actor_role: this.session ? this.staffById(this.session.staffId)!.role : null,
      action,
      object_type,
      object_id,
      before: null,
      after,
      reason,
      ip: "10.12.0.4",
      session_id: "s-e2e",
      trace_id: "e2e-trace",
      prev_hash: this.audit[0]?.hash ?? "0".repeat(64),
      hash: (seq * 7919).toString(16).padStart(64, "f"),
    });
  }

  private ticketBy(ref: string) {
    return this.tickets.find((t) => t.ticket_id === ref || t.number === ref);
  }

  private clientView(t: StaffTicket): ClientTicket {
    return {
      ticket_id: t.ticket_id,
      number: t.number,
      category: t.category as ClientTicket["category"],
      subject: t.subject,
      status: t.status,
      created_at: t.created_at,
      updated_at: t.updated_at,
      last_message_at: t.last_message_at,
      unread_operator_replies: 0,
      context: null,
      sla_first_response_at: t.sla_first_response_at,
      messages: t.messages
        .filter((m) => m.visibility === "public" && m.sender_type !== "system")
        .map((m) => ({ message_id: m.message_id, sender_type: m.sender_type, author_name: m.author_name, text: m.text, created_at: m.created_at })),
      status_history: t.status_history.map((h) => ({ status: h.status as TicketStatus, at: h.at })),
    };
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.slice(PREFIX.length) || "/";
    const method = req.method();
    let body: Record<string, unknown> = {};
    try {
      body = (req.postDataJSON() as Record<string, unknown>) ?? {};
    } catch {
      body = {};
    }
    const headers = req.headers();
    this.requests.push({ method, path, headers, body });
    const q = url.searchParams;

    const tr = this.sc.transform;
    const json = (status: number, data?: unknown, extra?: Record<string, string>) =>
      route.fulfill({ status, contentType: "application/json", body: data === undefined ? "" : JSON.stringify(tr && status < 300 ? tr(path, data) : data), ...(extra ? { headers: extra } : {}) });
    const err = (status: number, code: string, details: Record<string, unknown> = {}) => json(status, { code, message: code, trace_id: "e2e-trace-0001", details } satisfies ErrorBody);

    const isAuth = /^\/auth\/(login|mfa|password|logout)/.test(path) && !(path === "/auth/password" && !body.challenge);
    /* ---------- sign-in flow (no session needed) ---------- */
    if (method === "POST" && path === "/auth/login") {
      if (this.sc.authMode === "ad") return err(501, "AUTH_MODE_UNAVAILABLE");
      const email = String(body.email ?? "").trim().toLowerCase();
      const fails = this.failures.get(email) ?? 0;
      if (fails >= 5) return err(423, "ACCOUNT_LOCKED", { retry_after: 900 });
      const a = this.account(email);
      if (!a || a.password !== body.password) {
        this.failures.set(email, fails + 1);
        if (fails + 1 >= 5) return err(423, "ACCOUNT_LOCKED", { retry_after: 900 });
        return err(401, "INVALID_CREDENTIALS", { remaining: 5 - (fails + 1) });
      }
      if (a.staff.status === "DISABLED") return err(403, "ACCOUNT_DISABLED");
      this.failures.delete(email);
      return json(200, this.nextStep(a.staff, "password"));
    }
    const ch = typeof body.challenge === "string" ? this.challenges.get(body.challenge) : undefined;
    if (method === "POST" && (path === "/auth/mfa" || path === "/auth/mfa/enroll/confirm" || path === "/auth/mfa/enroll/start" || (path === "/auth/password" && body.challenge))) {
      if (!ch) return err(401, "CHALLENGE_INVALID");
      const s = this.staffById(ch.staffId)!;
      if (path === "/auth/mfa/enroll/start") {
        if (ch.step !== "mfa_enroll") return err(401, "CHALLENGE_INVALID");
        this.enrolled.add(String(body.challenge));
        return json(200, { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", otpauth_uri: `otpauth://totp/TilHero%20Admin:${encodeURIComponent(s.email)}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=TilHero%20Admin`, issuer: "TilHero Admin", account: s.email });
      }
      if (path === "/auth/password") {
        if (ch.step !== "password_change") return err(401, "CHALLENGE_INVALID");
        const pw = String(body.new_password ?? "");
        if (pw.length < 12 || !/\d/.test(pw) || !/[a-zA-Z]/.test(pw) || pw === this.accounts.find((a) => a.staff.staff_id === s.staff_id)!.password) return err(422, "PASSWORD_WEAK", { rules: ["length"] });
        this.challenges.delete(String(body.challenge));
        this.accounts.find((a) => a.staff.staff_id === s.staff_id)!.password = pw;
        s.must_change_password = false;
        return json(200, this.nextStep(s, "password_change"));
      }
      const wantStep = path === "/auth/mfa" ? "mfa" : "mfa_enroll";
      if (ch.step !== wantStep || (wantStep === "mfa_enroll" && !this.enrolled.has(String(body.challenge)))) return err(401, "CHALLENGE_INVALID");
      if (body.code !== F.TOTP) {
        ch.tries -= 1;
        if (ch.tries <= 0) {
          this.challenges.delete(String(body.challenge));
          return err(401, "CHALLENGE_INVALID");
        }
        return err(401, "MFA_INVALID", { remaining: ch.tries });
      }
      this.challenges.delete(String(body.challenge));
      if (wantStep === "mfa_enroll") s.mfa_enabled = true;
      return json(200, this.nextStep(s, "mfa"));
    }

    /* ---------- session ---------- */
    if (!this.session) return err(401, "UNAUTHORIZED");
    if (this.revoked) {
      this.revoked = false;
      this.session = null;
      return err(401, "SESSION_REVOKED");
    }
    if (this.sc.rotateOnce === `${method} ${path}`) {
      this.sc.rotateOnce = undefined;
      this.session.csrf = `csrf-rotated-${Math.random().toString(36).slice(2, 8)}`;
      return err(409, "SESSION_ROTATED");
    }
    if (method !== "GET" && !isAuth && headers["x-csrf-token"] !== this.session.csrf) return err(403, "CSRF_INVALID");
    const me = this.staffById(this.session.staffId)!;
    const perms = new Set(this.perms());
    const need = (...ps: Permission[]) => (ps.some((p) => perms.has(p)) ? null : ps[0]!);
    const key = `${method} ${path}`;
    const denied = this.sc.deny?.[key];
    if (denied) return err(403, "PERMISSION_DENIED", { permission: denied });
    if (this.sc.rateLimitedOnce === key) {
      this.sc.rateLimitedOnce = undefined;
      return json(429, { code: "RATE_LIMITED", message: "Слишком много запросов, повторите позже", trace_id: "e2e-trace-0429", details: { policy: "adm.staff", retry_after: 12 } }, { "retry-after": "12" });
    }
    const stepUpOk = () => this.session!.stepUpUntil > Date.now();
    const guard = (ps: Permission[], stepUp = false): Promise<void> | null => {
      const miss = need(...ps);
      if (miss) return err(403, "PERMISSION_DENIED", { permission: miss });
      if (stepUp && !stepUpOk()) return err(403, "STEP_UP_REQUIRED", { permission: ps[0] });
      return null;
    };

    let m: RegExpMatchArray | null;
    switch (true) {
      case key === "GET /me":
        return json(200, this.me());
      case key === "POST /auth/logout":
        this.record("auth.logout", "staff", me.staff_id, null);
        this.session = null;
        return json(204);
      case key === "POST /auth/step-up": {
        if (body.code !== F.TOTP) return err(401, "MFA_INVALID", { remaining: 4 });
        this.session.stepUpUntil = Date.now() + 5 * 60_000;
        return json(200, { step_up_until: new Date(this.session.stepUpUntil).toISOString() });
      }
      case key === "POST /auth/password": {
        const acc = this.accounts.find((a) => a.staff.staff_id === me.staff_id)!;
        if (body.current_password !== acc.password) return err(401, "INVALID_CREDENTIALS", { remaining: 4 });
        acc.password = String(body.new_password);
        return json(200, { next: "done", challenge: null, me: this.me() });
      }
      case key === "POST /dev/impersonate": {
        if ((this.sc.env ?? "stage") !== "dev") return err(404, "NOT_FOUND");
        this.session.impersonating = (body.role as RoleCode | null) ?? null;
        return json(200, this.me());
      }

      /* dashboard */
      case key === "GET /dashboard": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        const off = { ...(this.sc.dashOff ?? {}) };
        if (this.sc.aiOff) off.ai = "not_configured";
        if (this.sc.opsOff) off.system = "not_configured";
        if (!perms.has("users.read")) off.users = "forbidden";
        const openDel = this.deletions.filter((d) => d.status !== "COMPLETED");
        const system = O.summary(this.opsProviders, O.consumers(this.sc.queueLag), O.outbox(), this.opsAlerts.filter((a) => a.state === "open"), O.services(), {
          open: openDel.length,
          stuck: openDel.filter((d) => d.status === "STUCK").length,
          available: true,
          checked_at: F.iso(-3 * 60_000),
        });
        return json(200, O.dashboard((q.get("period") as "today") ?? "today", { off, stale: this.sc.dashStale, n8nDown: this.sc.n8nDown, noFlightEmpty: this.sc.noFlightEmpty, system }));
      }

      /* sprint 8: monitoring (ops-monitor) and the alert feed */
      case key === "GET /alerts": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        const ops = this.sc.opsOff ? null : this.opsAlerts.filter((a) => a.state === "open").map((a) => ({ source: "ops", id: a.alert_id, severity: a.severity, kind: a.kind, subject_type: a.subject_type, subject: a.subject, params: a.params, opened_at: a.opened_at, acked: a.acked_at !== null, runbook_url: a.runbook_url }));
        const sev = (a: import("@tilhero/contracts/admin").AiAlert) => (a.kind === "unpriced" ? "warning" : a.auto_paused || a.threshold >= 100 ? "critical" : a.threshold >= 90 ? "warning" : "info");
        const ai = this.sc.aiOff || this.sc.feedAiDown ? null : this.aiAlerts.filter((a) => !a.acked_at).map((a) => ({ source: "ai", id: a.alert_id, severity: sev(a), kind: a.kind, subject_type: "agent", subject: a.agent_id, params: { period: a.period, threshold: a.threshold, spent_usd: a.spent_usd, limit_usd: a.limit_usd, auto_paused: a.auto_paused, detail: a.detail }, opened_at: a.created_at, acked: false }));
        const rank = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
        const items = [...(ops ?? []), ...(ai ?? [])].sort((a, b) => rank[a.severity]! - rank[b.severity]! || Date.parse(b.opened_at) - Date.parse(a.opened_at));
        const counts = { critical: 0, warning: 0, info: 0 } as Record<string, number>;
        for (const x of items) if (!x.acked) counts[x.severity]! += 1;
        const sources = { ops: this.sc.opsOff ? "not_configured" : "ok", ai: this.sc.aiOff ? "not_configured" : this.sc.feedAiDown ? "unavailable" : "ok" };
        return json(200, { items, counts, partial: sources.ops !== "ok" || sources.ai !== "ok", sources });
      }
      case !!(m = path.match(/^\/alerts\/(ops|ai)\/([0-9a-f-]{36})\/ack$/)) && method === "POST": {
        const g = guard(["ops.kill_switch"]);
        if (g) return g;
        if (m![1] === "ai") {
          const a = this.aiAlerts.find((x) => x.alert_id === m![2]);
          if (!a) return err(404, "AI_ALERT_NOT_FOUND");
          if (!a.acked_at) Object.assign(a, { acked_by: me.staff_id, acked_at: F.iso(0) });
          return json(200, { source: "ai", id: a.alert_id, severity: "warning", kind: a.kind, subject_type: "agent", subject: a.agent_id, params: {}, opened_at: a.created_at, acked: true });
        }
        if (this.sc.auditDown) return err(503, "AUDIT_UNAVAILABLE", { service: "audit" });
        const a = this.opsAlerts.find((x) => x.alert_id === m![2]);
        if (!a) return err(404, "ALERT_NOT_FOUND");
        if (!a.acked_at) Object.assign(a, { acked_by: me.staff_id, acked_at: F.iso(0), ack_comment: typeof body.comment === "string" ? body.comment : null });
        this.record("ops.alert.ack", "alert", a.alert_id, null, typeof body.comment === "string" ? body.comment : undefined);
        return json(200, { source: "ops", id: a.alert_id, severity: a.severity, kind: a.kind, subject_type: a.subject_type, subject: a.subject, params: a.params, opened_at: a.opened_at, acked: true });
      }
      case this.sc.opsOff && path.startsWith("/ops/"):
        return guard(["dashboard.read", "ops.queues.manage"]) ?? err(503, "FEATURE_UNAVAILABLE", { service: "ops-monitor" });
      case key === "GET /ops/providers":
        return guard(["dashboard.read"]) ?? json(200, { items: this.opsProviders });
      case !!(m = path.match(/^\/ops\/providers\/([a-z_]+)\/history$/)) && method === "GET": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        if (!this.opsProviders.some((p) => p.provider === m![1])) return err(404, "PROVIDER_NOT_FOUND");
        return json(200, O.history(m![1]!, q.get("range") === "7d" ? "7d" : "24h"));
      }
      case !!(m = path.match(/^\/ops\/providers\/([a-z_]+)\/probe$/)) && method === "POST": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        const p = this.opsProviders.find((x) => x.provider === m![1]);
        if (!p) return err(404, "PROVIDER_NOT_FOUND");
        if (!p.probe_supported) return err(422, "PROBE_NOT_SUPPORTED", { provider: p.provider });
        const ok = !(this.sc.providerDown && p.provider === "aviasales");
        p.last_probe = { ok, latency_ms: ok ? 512 : null, code: ok ? null : "PROVIDER_UNAVAILABLE", at: F.iso(0) };
        return json(200, { probe: { ok, latency_ms: ok ? 512 : null, code: ok ? null : "PROVIDER_UNAVAILABLE", reason: ok ? null : "upstream_5xx", message: null, http_status: ok ? 200 : 502, checked_at: F.iso(0) }, provider: p });
      }
      case key === "GET /ops/feeds":
        return guard(["dashboard.read"]) ?? json(200, O.feeds());
      /* sprint 9: profile deletions (identity-consent saga) */
      case key === "GET /deletions": {
        const g = guard(["users.read"]);
        if (g) return g;
        const st = q.get("status");
        const items = this.deletions
          .filter((d) => !st || (st === "open" ? d.status !== "COMPLETED" : st === "stuck" ? d.status === "STUCK" : d.status === "COMPLETED"))
          .map(({ domains: _d, history: _h, ...row }) => row);
        return json(200, { items, next_cursor: null });
      }
      case !!(m = path.match(/^\/deletions\/([0-9a-f-]{36})$/)) && method === "GET": {
        const g = guard(["users.read"]);
        if (g) return g;
        const d = this.deletions.find((x) => x.request_id === m![1]);
        return d ? json(200, this.named(d)) : err(404, "DELETION_NOT_FOUND");
      }
      case !!(m = path.match(/^\/deletions\/([0-9a-f-]{36}):retry$/)) && method === "POST": {
        const g = guard(["ops.queues.manage"], true);
        if (g) return g;
        const k = headers["idempotency-key"];
        if (!k) return err(400, "IDEMPOTENCY_KEY_REQUIRED");
        if (String(body.reason ?? "").trim().length < 3) return err(422, "VALIDATION_ERROR", { field: "reason" });
        const seen = this.replays.get(`del:${k}`);
        if (seen) return json(200, seen, { "idempotent-replayed": "true" });
        const d = this.deletions.find((x) => x.request_id === m![1]);
        if (!d) return err(404, "DELETION_NOT_FOUND");
        if (d.status === "COMPLETED") return err(409, "DELETION_NOT_OPEN", { status: d.status });
        if (this.sc.delTooSoon) {
          this.sc.delTooSoon = false;
          return err(409, "DELETION_RETRY_TOO_SOON", { retry_after: 240 });
        }
        if (this.sc.auditDown) return err(503, "AUDIT_UNAVAILABLE", { service: "audit" });
        const n = d.attempts + 1;
        Object.assign(d, { attempts: n, next_retry_at: F.iso(15 * 60_000), history: [...d.history, { attempt: n, sent_at: F.iso(0), by: me.staff_id, by_name: null }] });
        this.record("user.deletion.retry", "deletion_request", d.request_id, { attempt: n }, String(body.reason));
        const out = this.named(d);
        this.replays.set(`del:${k}`, out);
        return json(200, out);
      }

      /* sprint 9: rate limits (ops-monitor) */
      case key === "GET /ops/ratelimits":
        return guard(["dashboard.read"]) ?? json(200, { items: this.rlPolicies });
      case !!(m = path.match(/^\/ops\/ratelimits\/([a-z0-9_.]+)\/history$/)) && method === "GET": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        if (!this.rlPolicies.some((x) => x.policy === m![1])) return err(404, "RATE_LIMIT_POLICY_NOT_FOUND");
        return json(200, O.rateLimitHistory(m![1]!, q.get("range") === "7d" ? "7d" : "24h"));
      }
      case !!(m = path.match(/^\/ops\/ratelimits\/([a-z0-9_.]+)\/override$/)) && (method === "PUT" || method === "DELETE"): {
        const g = guard(["ops.kill_switch"], true);
        if (g) return g;
        const k = headers["idempotency-key"];
        if (!k) return err(400, "IDEMPOTENCY_KEY_REQUIRED");
        const seen = this.replays.get(`rl:${k}`);
        if (seen) return json(200, seen, { "idempotent-replayed": "true" });
        const idx = this.rlPolicies.findIndex((x) => x.policy === m![1]);
        if (idx < 0) return err(404, "RATE_LIMIT_POLICY_NOT_FOUND");
        const p = this.rlPolicies[idx]!;
        const reason = String(body.reason ?? "").trim();
        if (reason.length < 3) return err(422, "VALIDATION_ERROR", { field: "reason" });
        if (this.sc.rlRedisDown) return err(503, "RATE_LIMIT_UNAVAILABLE", { service: "redis" });
        if (this.sc.auditDown) return err(503, "AUDIT_UNAVAILABLE", { service: "audit" });
        let next: typeof p;
        if (method === "PUT") {
          const limit = Number(body.limit);
          const win = Number(body.window_s);
          if (p.fail === "closed" && (limit * 60) / win < 1) return err(422, "RATE_LIMIT_TOO_STRICT", { policy: p.policy, min_per_minute: 1 });
          const burst = typeof body.burst === "number" ? body.burst : null;
          // as ops-monitor (review of sprint 9): fail: closed — at most ×10 of the default, loosening only for ≤ 24 h
          const d = p.default;
          const eff = burst ?? limit;
          if (p.fail === "closed" && (limit * d.window_s > 10 * d.limit * win || eff > 10 * d.burst)) return err(422, "RATE_LIMIT_TOO_LOOSE", { policy: p.policy, reason: "factor", max_factor: 10 });
          const exp = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : null;
          if (p.fail === "closed" && (limit * d.window_s > d.limit * win || eff > d.burst) && (exp == null || exp > Date.now() + 24 * 3_600_000)) {
            return err(422, "RATE_LIMIT_TOO_LOOSE", { policy: p.policy, reason: "expires_required", max_hours: 24 });
          }
          next = { ...p, limit, window_s: win, burst: burst ?? limit, source: "override", override: { limit, window_s: win, burst, by: me.staff_id, by_name: null, at: F.iso(0), reason, expires_at: typeof body.expires_at === "string" ? body.expires_at : null } };
          this.record("ratelimit.override.set", "ratelimit", p.policy, { limit, window_s: win }, reason);
        } else {
          next = { ...p, ...p.default, source: "default", override: null };
          this.record("ratelimit.override.reset", "ratelimit", p.policy, null, reason);
        }
        this.rlPolicies[idx] = next;
        const out = this.named(next);
        this.replays.set(`rl:${k}`, out);
        return json(200, out);
      }

      case key === "GET /ops/alerts": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        const items = q.get("state") === "resolved" ? O.resolvedAlerts() : this.opsAlerts.filter((a) => a.state === "open");
        return json(200, this.named({ items, next_cursor: null }));
      }
      case !!(m = path.match(/^\/ops\/queues\/(streams|consumers|outbox|services)$/)) && method === "GET": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        if (this.sc.natsDown && (m![1] === "streams" || m![1] === "consumers")) return err(503, "NATS_UNAVAILABLE", { service: "nats" });
        const items = m![1] === "streams" ? O.streams() : m![1] === "consumers" ? this.consumersNow() : m![1] === "outbox" ? O.outbox() : O.services();
        return json(200, { items });
      }
      case key === "GET /ops/dlq": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        if (this.sc.natsDown) return err(503, "NATS_UNAVAILABLE", { service: "nats" });
        const items = this.dlqMatch(q.get("consumer"), q.get("event_type"), q.get("source"), q.get("state"));
        return json(200, { items, next_cursor: null, total: items.length });
      }
      case key === "GET /ops/dlq/actions":
        return guard(["dashboard.read"]) ?? json(200, this.named({ items: this.dlqActions, next_cursor: null }));
      case !!(m = path.match(/^\/ops\/dlq\/((?:dlq|legacy)(?::|%3A)\d+)$/i)) && method === "GET": {
        const g = guard(["ops.queues.manage"]);
        if (g) return g;
        const id = decodeURIComponent(m![1]!);
        if (!this.dlq.some((x) => x.dlq_id === id)) return err(404, "DLQ_MESSAGE_NOT_FOUND");
        return json(200, O.dlqDetail(id));
      }
      case (key === "POST /ops/dlq/replay" || key === "POST /ops/dlq/delete"): {
        const g = guard(["ops.queues.manage"], true);
        if (g) return g;
        if (!headers["idempotency-key"]) return err(400, "IDEMPOTENCY_KEY_REQUIRED");
        const reason = String(body.reason ?? "").trim();
        if (reason.length < 3) return err(422, "VALIDATION_ERROR", { field: "reason" });
        const ids = body.ids as string[] | undefined;
        const filter = body.filter as import("@tilhero/contracts/admin").DlqFilter | undefined;
        if ((ids === undefined) === (filter === undefined)) return err(422, "DLQ_COMMAND_INVALID");
        if (this.sc.auditDown) return err(503, "AUDIT_UNAVAILABLE", { service: "audit" });
        const includeReplayed = body.include_replayed === true;
        // перепроверка 8 (как ops-monitor): фильтр команды = параметры списка — consumer, event_type, source, state
        // (умолчание present); expected_count — total этого вида
        const fState = filter?.state ?? "present";
        const fSource = filter?.source ?? null;
        let targets = ids ? this.dlq.filter((x) => ids.includes(x.dlq_id)) : this.dlqMatch(filter!.consumer, filter!.event_type ?? null, fSource, fState);
        if (filter) {
          if (this.sc.dlqCountChanged && !this.dlqCountTrip) {
            this.dlqCountTrip = true;
            this.dlq.push({ ...this.dlq[0]!, dlq_id: "dlq:43", event_id: "9c6a5e1f-4d7b-4f2c-9a0e-1b5c6d7e8f90", dead_at: F.iso(-60_000), replays: 0 });
            targets = this.dlqMatch(filter.consumer, filter.event_type ?? null, fSource, fState);
          }
          if (Number(body.expected_count) !== targets.length) return err(409, "DLQ_COUNT_CHANGED", { actual: targets.length });
        }
        const kind = key.endsWith("replay") ? "replay" : "delete";
        const skipped: Array<{ dlq_id: string; reason: string }> = [];
        const consumersNow = this.consumersNow();
        for (const x of targets) {
          if (kind === "replay" && x.replays >= 3) skipped.push({ dlq_id: x.dlq_id, reason: "REPLAY_LIMIT" });
          else if (kind === "replay" && x.state === "replayed" && !includeReplayed) skipped.push({ dlq_id: x.dlq_id, reason: "ALREADY_REPLAYED" });
          else if (kind === "replay" && consumersNow.find((c) => c.durable === x.consumer)?.replay_enabled === false) skipped.push({ dlq_id: x.dlq_id, reason: "CONSUMER_REPLAY_UNAVAILABLE" });
        }
        const done = targets.filter((x) => !skipped.some((s) => s.dlq_id === x.dlq_id));
        // повтор оставляет сообщение в DLQ с пометкой «уже повторялось»; удаление — убирает
        this.dlq =
          kind === "delete"
            ? this.dlq.filter((x) => !done.some((d) => d.dlq_id === x.dlq_id))
            : this.dlq.map((x) => (done.some((d) => d.dlq_id === x.dlq_id) ? { ...x, state: "replayed" as const, replayed_at: F.iso(0), replays: x.replays + 1 } : x));
        const action_id = `3f0d4b5c-6e7a-4b8c-9d2e-${String(++this.seq).padStart(12, "0")}`;
        this.dlqActions.unshift({ action_id, kind, by: me.staff_id, by_name: null, reason, selector: ids ? { ids } : { filter: filter! }, requested: targets.length, done: done.length, skipped, at: F.iso(0) });
        this.record(`ops.dlq.${kind}`, "consumer", targets[0]?.consumer ?? "-", { count: targets.length }, reason);
        return json(200, { action_id, requested: targets.length, done: done.length, skipped });
      }

      /* users */
      case key === "GET /users": {
        const g = guard(["users.read"]);
        if (g) return g;
        const term = (q.get("q") ?? "").toLowerCase().replace(/^@/, "");
        let items = this.users.filter((u) => !term || u.username?.includes(term) || u.user_id === term || (u.display_name ?? "").toLowerCase().includes(term));
        if (q.get("status")) items = items.filter((u) => u.status === q.get("status"));
        if (q.get("has_open_tickets") === "true") items = items.filter((u) => u.open_tickets > 0);
        return json(200, { items, next_cursor: null });
      }
      case !!(m = path.match(/^\/users\/([^/]+)\/reveal$/)) && method === "POST": {
        const g = guard(["users.sensitive.read"]);
        if (g) return g;
        if (String(body.reason ?? "").length < 5) return err(422, "VALIDATION_ERROR", { field: "reason" });
        this.record("sensitive.view", "user", m![1]!, { field: "telegram_user_id" }, String(body.reason));
        return json(200, { field: "telegram_user_id", value: F.FULL_TG_ID, expires_in: 60 });
      }
      case !!(m = path.match(/^\/users\/([^/]+)$/)) && method === "GET": {
        const g = guard(["users.read"]);
        if (g) return g;
        const u = this.users.find((x) => x.user_id === m![1]);
        if (!u) return err(404, "USER_NOT_FOUND");
        const card = F.userCard(u, this.tickets);
        // sprint 7: metadata only (ai-concierge), access level and 30-day usage (ai-control); null when not connected
        card.ai_conversations = this.sc.aiOff ? null : u.user_id === F.USER.igor ? A.conversations() : [];
        card.access_level = this.sc.aiOff ? null : this.named(this.accessOf(u.user_id));
        card.ai_usage_30d = this.sc.aiOff ? null : u.user_id === F.USER.igor ? A.userUsage(u.user_id) : { ...A.userUsage(u.user_id), requests: 0, cost_usd: "0.000000", agents: [], days: [] };
        return json(200, card);
      }

      /* support */
      case key === "GET /support/stats":
        return guard(["support.read", "dashboard.read"]) ?? json(200, this.stats());
      case key === "GET /support/templates":
        return guard(["support.read"]) ?? json(200, { items: F.TEMPLATES });
      case key === "GET /support/sla-policies":
        return guard(["support.read"]) ?? json(200, this.sla);
      case key === "PUT /support/sla-policies": {
        const g = guard(["support.manage"]);
        if (g) return g;
        this.sla = { ...this.sla, items: (body.items as typeof this.sla.items).map((x) => ({ ...x, updated_at: F.iso(0), updated_by: me.staff_id })) };
        this.record("sla.change", "sla_policy", null, null, String(body.reason));
        return json(200, this.sla);
      }
      case key === "GET /support/tickets": {
        const g = guard(["support.read"]);
        if (g) return g;
        const st = q.get("status");
        let items = this.tickets.filter((t) => (st === "open" ? ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"].includes(t.status) : !st || st === "all" ? true : st.split(",").includes(t.status)));
        if (q.get("category")) items = items.filter((t) => t.category === q.get("category"));
        if (q.get("priority")) items = items.filter((t) => t.priority === q.get("priority"));
        const as = q.get("assignee");
        if (as === "me") items = items.filter((t) => t.assignee_id === me.staff_id);
        else if (as === "none") items = items.filter((t) => !t.assignee_id);
        else if (as) items = items.filter((t) => t.assignee_id === as);
        if (q.get("sla")) items = items.filter((t) => t.sla_state === q.get("sla"));
        return json(200, { items: items.map(({ messages: _m, status_history: _h, escalations: _e, context: _c, user: _u, correlation_id: _r, resolved_at: _ra, closed_at: _ca, user_unread_operator_replies: _n, ...s }) => s), next_cursor: null });
      }
      case !!(m = path.match(/^\/support\/tickets\/([^/]+)(\/[a-z-]+)?$/)): {
        const t = this.ticketBy(m![1]!);
        const sub = m![2] ?? "";
        const g = guard(method === "GET" ? ["support.read"] : ["support.reply"]);
        if (g) return g;
        if (!t) return err(404, "SUPPORT_TICKET_NOT_FOUND");
        if (method === "GET" && !sub) return json(200, this.withUser(t, perms));
        if (method === "GET" && sub === "/client-view") return json(200, this.clientView(t));
        if (method === "POST" && sub === "/messages") {
          const idem = headers["idempotency-key"];
          if (!idem) return err(400, "IDEMPOTENCY_KEY_REQUIRED");
          if (this.idem.has(idem)) return json(200, this.idem.get(idem));
          if (t.status === "CLOSED") return err(409, "SUPPORT_TICKET_CLOSED");
          const internal = body.visibility === "internal";
          t.messages.push(F.msg("operator", String(body.text), 0, { visibility: internal ? "internal" : "public", author_id: me.staff_id, author_name: me.display_name }));
          if (!internal) {
            if (!t.first_response_at) t.first_response_at = F.iso(0);
            if (!t.assignee_id) {
              t.assignee_id = me.staff_id;
              t.assignee_name = me.display_name;
            }
            if (t.status === "NEW" || t.status === "IN_PROGRESS") this.setStatus(t, "WAITING_CUSTOMER", me);
          }
          this.record(internal ? "ticket.note" : "ticket.reply", "ticket", t.ticket_id, { visibility: body.visibility });
          const out = this.withUser(t, perms);
          this.idem.set(idem, out);
          return json(200, out);
        }
        if (method === "PATCH" && !sub) {
          if (body.status) {
            const to = body.status as TicketStatus;
            if (!STAFF_TRANSITIONS[t.status].includes(to)) return err(409, "SUPPORT_INVALID_TRANSITION", { from: t.status, to });
            this.setStatus(t, to, me);
          }
          if (body.priority) t.priority = body.priority as StaffTicket["priority"];
          if ("assignee_id" in body) {
            t.assignee_id = (body.assignee_id as string | null) ?? null;
            t.assignee_name = t.assignee_id ? (this.staffById(t.assignee_id)?.display_name ?? null) : null;
          }
          return json(200, this.withUser(t, perms));
        }
        if (method === "POST" && sub === "/take") {
          t.assignee_id = me.staff_id;
          t.assignee_name = me.display_name;
          if (t.status === "NEW") this.setStatus(t, "IN_PROGRESS", me);
          return json(200, this.withUser(t, perms));
        }
        if (method === "POST" && sub === "/escalations") {
          t.escalations.push({ escalation_id: `e5000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`, type: body.type as "billing_review", note: String(body.note), status: "OPEN", created_by: me.staff_id, created_at: F.iso(0) });
          this.record("ticket.escalate", "ticket", t.ticket_id, { type: body.type });
          return json(201, t.escalations.at(-1));
        }
        if (method === "POST" && sub === "/ai-draft") return json(200, { text: `Здравствуйте! Спасибо за обращение ${t.number}. Мы разбираемся и ответим здесь.`, stub: true, source: "template" });
        return err(404, "NOT_FOUND");
      }

      /* staff & roles */
      case key === "GET /staff": {
        const g = guard(["staff.manage"]);
        if (g) return g;
        const term = (q.get("q") ?? "").toLowerCase();
        let items = this.accounts.map((a) => a.staff).filter((s) => !term || s.email.includes(term) || s.display_name.toLowerCase().includes(term));
        if (q.get("role")) items = items.filter((s) => s.role === q.get("role"));
        if (q.get("status")) items = items.filter((s) => s.status === q.get("status"));
        return json(200, { items, next_cursor: null });
      }
      case key === "POST /staff": {
        const g = guard(["staff.manage"], true);
        if (g) return g;
        const email = String(body.email);
        if (this.account(email)) return err(409, "STAFF_EMAIL_EXISTS");
        const role = body.role as RoleCode;
        const priv = F.PRIVILEGED.includes(role);
        const s: Staff = {
          staff_id: `0b6c3e1a-7d2f-4f0e-9a51-${String(++this.seq).padStart(12, "0")}`,
          email,
          display_name: String(body.display_name),
          role: priv ? "read_only" : role,
          status: "ACTIVE",
          auth_provider: "local",
          mfa_enabled: false,
          must_change_password: true,
          last_login_at: null,
          created_at: F.iso(0),
          created_by: me.staff_id,
        };
        this.accounts.push({ staff: s, password: "Tmp-9xQ2-mK7v-Lp4w-Zr8" });
        this.record("staff.created", "staff", s.staff_id, { role: s.role, must_change_password: true });
        const approval = priv ? this.approval("staff.create_privileged", { staff: { staff_id: s.staff_id, email, display_name: s.display_name }, role }, "create privileged", me) : null;
        return json(201, { staff: s, temporary_password: "Tmp-9xQ2-mK7v-Lp4w-Zr8", approval });
      }
      case !!(m = path.match(/^\/staff\/([^/]+)(\/reset-password|\/reset-mfa)?$/)) && method !== "GET": {
        const g = guard(["staff.manage"], true);
        if (g) return g;
        const s = this.staffById(m![1]!);
        if (!s) return err(404, "STAFF_NOT_FOUND");
        if (s.staff_id === me.staff_id) return err(409, "SELF_ACTION");
        if (m![2] && F.PRIVILEGED.includes(s.role)) {
          // four-eyes (staff.privileged_reset): a super_admin target is never waived; the password goes to the approver
          const action = m![2] === "/reset-password" ? "password" : "mfa";
          const supers = this.accounts.filter((a) => a.staff.role === "super_admin" && a.staff.status === "ACTIVE").length;
          if (s.role !== "super_admin" && supers <= 1) {
            if (action === "mfa") s.mfa_enabled = false;
            else s.must_change_password = true;
            return json(200, action === "mfa" ? s : { temporary_password: "Rst-4bN8-qW2e-Ty6u-Io0" });
          }
          const a = this.approval("staff.privileged_reset", { staff: { staff_id: s.staff_id, email: s.email, display_name: s.display_name }, action }, String(body.reason), me, undefined, true);
          return json(202, { approval: a });
        }
        if (m![2] === "/reset-password") {
          s.must_change_password = true;
          this.record("staff.password_reset", "staff", s.staff_id, null, String(body.reason));
          return json(200, { temporary_password: "Rst-4bN8-qW2e-Ty6u-Io0" });
        }
        if (m![2] === "/reset-mfa") {
          s.mfa_enabled = false;
          return json(200, s);
        }
        if (body.role && body.role !== s.role) {
          const to = body.role as RoleCode;
          if (F.PRIVILEGED.includes(to) || F.PRIVILEGED.includes(s.role)) {
            const a = this.approval("staff.role_grant", { staff: { staff_id: s.staff_id, email: s.email, display_name: s.display_name }, from_role: s.role, to_role: to }, String(body.reason), me);
            if (a.status === "APPLIED") s.role = to;
            return json(202, { approval: a });
          }
          s.role = to;
        }
        if (body.status) {
          if (s.role === "super_admin" && body.status === "DISABLED" && this.accounts.filter((a) => a.staff.role === "super_admin" && a.staff.status === "ACTIVE").length <= 1) return err(409, "LAST_SUPER_ADMIN");
          s.status = body.status as Staff["status"];
        }
        this.record("staff.updated", "staff", s.staff_id, { role: s.role, status: s.status }, String(body.reason));
        return json(200, s);
      }
      case key === "GET /roles": {
        const g = guard(["staff.manage", "roles.manage"]);
        if (g) return g;
        return json(200, { items: F.roles(this.accounts.map((a) => a.staff), this.matrix), permissions: F.ALL_PERMS });
      }
      case !!(m = path.match(/^\/roles\/([a-z_]+)$/)) && method === "PUT": {
        const g = guard(["roles.manage"], true);
        if (g) return g;
        const code = m![1] as RoleCode;
        const wanted = body.permissions as Permission[];
        const cur = this.matrix[code];
        if (code === "super_admin" && !wanted.includes("roles.manage")) return err(409, "SUPER_ADMIN_ROLES_MANAGE");
        const added = wanted.filter((p) => !cur.includes(p));
        const removed = cur.filter((p) => !wanted.includes(p));
        if (!added.length && !removed.length) return err(409, "ROLE_UNCHANGED");
        const a = this.approval("role.permissions_change", { role: code, added, removed }, String(body.reason), me, () => (this.matrix[code] = [...wanted]));
        return json(202, { approval: a });
      }
      case key === "GET /approvals": {
        const g = guard(["staff.manage", "roles.manage"]);
        if (g) return g;
        const st = q.get("status");
        return json(200, { items: this.approvals.filter((a) => !st || a.status === st), next_cursor: null });
      }
      case !!(m = path.match(/^\/approvals\/([^/]+)\/(approve|reject)$/)) && method === "POST": {
        if (me.role !== "super_admin") return err(403, "PERMISSION_DENIED", { permission: "roles.manage" });
        if (!stepUpOk()) return err(403, "STEP_UP_REQUIRED");
        const a = this.approvals.find((x) => x.approval_id === m![1]);
        if (!a) return err(404, "APPROVAL_NOT_FOUND");
        if (a.requested_by.staff_id === me.staff_id) return err(409, "FOUR_EYES_SAME_PERSON");
        if (a.status !== "PENDING") return err(409, "APPROVAL_NOT_PENDING");
        a.decided_by = { staff_id: me.staff_id, email: me.email, display_name: me.display_name, role: me.role };
        a.decided_at = F.iso(0);
        a.decision_note = String(body.note ?? "");
        if (m![2] === "approve") {
          a.status = "APPLIED";
          this.apply.get(a.approval_id)?.();
          const sum = a.summary as { staff?: { staff_id?: string }; action?: string };
          if (a.kind === "staff.privileged_reset") {
            const target = this.staffById(sum.staff?.staff_id ?? "");
            if (target && sum.action === "mfa") target.mfa_enabled = false;
            if (target && sum.action === "password") {
              target.must_change_password = true;
              return json(200, { ...a, temporary_password: "Apr-7cV3-pZ9k-Wq2m-Hx5" });
            }
          }
        } else a.status = "REJECTED";
        return json(200, a);
      }

      /* audit */
      case key === "GET /audit/records": {
        const g = guard(["audit.read"]);
        if (g) return g;
        let items = this.audit;
        if (q.get("action")) items = items.filter((r) => r.action === q.get("action"));
        if (q.get("object_type")) items = items.filter((r) => r.object_type === q.get("object_type"));
        const cursor = Number(q.get("cursor") ?? 0);
        const page = items.slice(cursor, cursor + 20);
        return json(200, { items: page, next_cursor: cursor + 20 < items.length ? String(cursor + 20) : null });
      }
      case key === "GET /audit/verify":
        return guard(["audit.read"]) ?? json(200, { valid: true, checked: this.audit.length, first_seq: this.audit.at(-1)!.seq, last_seq: this.audit[0]!.seq, broken_at_seq: null });
      case !!(m = path.match(/^\/audit\/records\/([^/]+)$/)): {
        const g = guard(["audit.read"]);
        if (g) return g;
        const r = this.audit.find((x) => x.record_id === m![1]);
        return r ? json(200, r) : err(404, "NOT_FOUND");
      }

      /* experience config */
      case !!(m = path.match(/^\/experience\/(miniapp|admin)\/current$/)) && method === "GET": {
        const app = m![1] as ConfigApp;
        // admin: any signed-in staff member (A46 for every role); miniapp: config.read
        if (app === "miniapp") {
          const g = guard(["config.read"]);
          if (g) return g;
        }
        const v = this.versions[app].find((x) => x.version === this.current[app])!;
        return json(200, { app, version: v.version, ...v.payload });
      }
      case !!(m = path.match(/^\/experience\/(miniapp|admin)\/(state|versions|activations|activate|rollback)(?:\/([^/]+))?$/)): {
        const app = m![1] as ConfigApp;
        const what = m![2]!;
        if (method === "GET") {
          const g = guard(["config.read"]);
          if (g) return g;
          if (what === "state") return json(200, { app, current: this.activations[app][0] ?? null, previous_version: this.previous[app] });
          if (what === "activations") return json(200, { items: this.activations[app], next_cursor: null });
          if (what === "versions" && m![3]) {
            const v = this.versions[app].find((x) => x.version === m![3]);
            return v ? json(200, { ...v, status: this.statusOf(app, v.version) }) : err(404, "EXPERIENCE_VERSION_NOT_FOUND");
          }
          return json(200, { items: this.versions[app].map(({ payload: _p, ...v }) => ({ ...v, status: this.statusOf(app, v.version) })), next_cursor: null });
        }
        if (what === "versions") {
          const g = guard(["config.edit"]);
          if (g) return g;
          if (this.versions[app].some((v) => v.version === body.version)) return err(409, "EXPERIENCE_VERSION_EXISTS");
          const v: ConfigVersion = { version_id: `c0000000-0000-4000-8000-9${String(++this.seq).padStart(11, "0")}`, app, version: String(body.version), checksum: "e2e".padEnd(64, "b"), change_note: String(body.change_note), created_by: me.email, created_at: F.iso(0), status: null, payload: body.payload as Record<string, unknown> };
          this.versions[app].push(v);
          this.record("config.create", "config", app, { version: v.version });
          return json(201, { ...v, payload: undefined });
        }
        const g = guard(["config.publish"]);
        if (g) return g;
        const target = what === "rollback" ? this.previous[app] : String(body.version);
        if (!target) return err(409, "EXPERIENCE_NO_PREVIOUS");
        if (!this.versions[app].some((v) => v.version === target)) return err(404, "EXPERIENCE_VERSION_NOT_FOUND");
        const from = this.current[app];
        const a: ConfigActivation = { activation_id: `ac000000-0000-4000-8000-9${String(++this.seq).padStart(11, "0")}`, app, version: target, previous_version: from, kind: what === "rollback" ? "rollback" : "activate", reason: String(body.reason), activated_by: me.email, activated_at: F.iso(0) };
        this.activations[app].unshift(a);
        this.previous[app] = from;
        this.current[app] = target;
        this.record(`config.${a.kind}`, "config", app, { version: target }, a.reason);
        return json(201, a);
      }

      /* ---------- 9.4: «Что нового» ---------- */
      case path === "/release-notes" || path.startsWith("/release-notes/"): {
        const parts = path.split("/").filter(Boolean); // ["release-notes", id?, action?]
        const note = parts[1] ? this.releaseNotes.find((n) => n.release_note_id === parts[1]) : undefined;
        if (method === "GET") {
          const g = guard(["config.read"]);
          if (g) return g;
          if (parts[1]) return note ? json(200, note) : err(404, "RELEASE_NOTE_NOT_FOUND");
          const st = q.get("status");
          return json(200, { items: this.releaseNotes.filter((n) => !st || n.status === st), next_cursor: null });
        }
        const g = guard(parts[2] ? ["config.publish"] : ["config.edit"]);
        if (g) return g;
        const content = (b: Record<string, unknown>) => ({ slug: String(b.slug), title: b.title as StaffReleaseNote["title"], items: b.items as StaffReleaseNote["items"], audience: (b.audience ?? "existing") as StaffReleaseNote["audience"] });
        const active = (slug: string, except?: string) => this.releaseNotes.some((n) => n.slug === slug && n.status !== "archived" && n.release_note_id !== except);
        if (!parts[1] && method === "POST") {
          if (active(String(body.slug))) return err(409, "RELEASE_NOTE_SLUG_EXISTS", { slug: body.slug });
          const n: StaffReleaseNote = { ...F.releaseNoteSeed(), ...content(body), release_note_id: `7e000000-0000-4000-8000-9${String(++this.seq).padStart(11, "0")}`, status: "draft", version: 1, created_by: me.email, updated_by: me.email, created_at: F.iso(0), updated_at: F.iso(0) };
          this.releaseNotes.unshift(n);
          this.record("release_note.create", "release_note", n.release_note_id, { slug: n.slug });
          return json(201, n);
        }
        if (!note) return err(404, "RELEASE_NOTE_NOT_FOUND");
        if (method === "PUT") {
          if (note.status !== "draft") return err(409, "RELEASE_NOTE_NOT_DRAFT", { status: note.status });
          if (body.expected_version !== note.version) return err(409, "RELEASE_NOTE_VERSION_CONFLICT", { current_version: note.version });
          if (active(String(body.slug), note.release_note_id)) return err(409, "RELEASE_NOTE_SLUG_EXISTS", { slug: body.slug });
          Object.assign(note, content(body), { version: note.version + 1, updated_by: me.email, updated_at: F.iso(0) });
          this.record("release_note.update", "release_note", note.release_note_id, { slug: note.slug });
          return json(200, note);
        }
        if (parts[2] === "publish") {
          if (note.status === "published") return json(200, note);
          if (note.status !== "draft") return err(409, "RELEASE_NOTE_NOT_DRAFT", { status: note.status });
          if (body.expected_version !== note.version) return err(409, "RELEASE_NOTE_VERSION_CONFLICT", { current_version: note.version });
          Object.assign(note, { status: "published", version: note.version + 1, published_by: me.email, published_at: F.iso(0) });
          this.record("release_note.publish", "release_note", note.release_note_id, { slug: note.slug }, String(body.reason));
          return json(201, note);
        }
        if (parts[2] === "archive") {
          if (note.status === "archived") return json(200, note);
          Object.assign(note, { status: "archived", version: note.version + 1, archived_by: me.email, archived_at: F.iso(0) });
          this.record("release_note.archive", "release_note", note.release_note_id, { slug: note.slug }, String(body.reason));
          return json(201, note);
        }
        return err(404, "NOT_FOUND");
      }

      /* ---------- sprint 4: event catalog ---------- */
      case (this.sc.featureOff ?? []).some((f) => path === `/${f}` || path.startsWith(`/${f}/`)):
        return err(503, "FEATURE_UNAVAILABLE", { service: path.split("/")[1] });
      case key === "GET /review": {
        const g = guard(["events.review"]);
        if (g) return g;
        let items = this.reviews.filter((r) => r.status === (q.get("status") ?? "OPEN"));
        if (q.get("country")) items = items.filter((r) => r.country_code === q.get("country"));
        const limit = Number(q.get("limit") ?? 50);
        const cursor = Number(q.get("cursor") ?? 0);
        const page = items.slice(cursor, cursor + limit).map(({ facts: _f, media: _m, matched_event_id: _e, decided_by: _b, decided_at: _a, decision_note: _n, decision_reason: _r, event_id: _i, decided_by_name: _dn, ...x }) => x);
        return json(200, { items: page, next_cursor: cursor + limit < items.length ? String(cursor + limit) : null });
      }
      case !!(m = path.match(/^\/review\/([^/]+)$/)) && method === "GET": {
        const g = guard(["events.review"]);
        if (g) return g;
        const r = this.reviews.find((x) => x.review_id === m![1]);
        return r ? json(200, this.namedReview(r)) : err(404, "REVIEW_NOT_FOUND");
      }
      case !!(m = path.match(/^\/review\/([^/]+)\/(accept|reject|correct)$/)) && method === "POST": {
        const g = guard(["events.review"]);
        if (g) return g;
        const idem = headers["idempotency-key"];
        if (!idem) return err(400, "IDEMPOTENCY_KEY_REQUIRED");
        if (this.idem.has(idem)) return json(200, this.idem.get(idem));
        const r = this.reviews.find((x) => x.review_id === m![1]);
        if (!r) return err(404, "REVIEW_NOT_FOUND");
        if (body.expected_status !== "OPEN" || r.status !== "OPEN") return err(409, "REVIEW_ALREADY_DECIDED", { status: r.status });
        if (body.expected_content_hash !== r.content_hash) return err(409, "REVIEW_CHANGED", { content_hash: r.content_hash });
        const note = String(body.note ?? "");
        if (note.length < 3 || note.length > 500) return err(422, "VALIDATION_ERROR", { field: "note" });
        const action = m![2]!;
        if (action === "correct") {
          let host = "";
          try {
            const u = new URL(String(body.basis_url));
            host = u.protocol === "https:" ? u.hostname : "";
          } catch {
            host = "";
          }
          const slug = r.provider.startsWith("aiweb.") ? r.provider.slice(6) : null;
          const doms = slug ? (this.sources.find((s) => s.slug === slug)?.event_domains ?? []) : ["ticketmaster.de", "ticketmaster.com"];
          if (!host || !doms.some((d) => host === d || host.endsWith(`.${d}`))) return err(422, "REVIEW_BASIS_URL_NOT_ALLOWED");
          const ch = body.changes as Record<string, unknown>;
          if (!ch || !Object.keys(ch).length) return err(422, "VALIDATION_ERROR", { field: "changes" });
          // events: dates more than five years ahead are refused
          const sd = (ch.start as { local_date?: string } | undefined)?.local_date;
          if (sd && sd > "2031-12-31") return err(422, "REVIEW_CHANGES_INVALID", { field: "start", reason: "DATE_OUT_OF_RANGE" });
          if (typeof ch.title === "string") r.title = ch.title;
          if (ch.start) r.start = ch.start as ReviewDetail["start"];
          r.facts = { ...r.facts, ...ch };
        }
        Object.assign(r, {
          status: action === "accept" ? "ACCEPTED" : action === "reject" ? "REJECTED" : "CORRECTED",
          decided_by: me.staff_id,
          decided_at: F.iso(0),
          decision_note: note,
          decision_reason: action === "reject" ? body.reason_code : null,
          event_id: action === "reject" ? null : (r.matched_event_id ?? `e1000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`),
        });
        this.record(`review.${r.status.toLowerCase()}`, "review", r.review_id, { provider: r.provider, event_id: r.event_id }, note);
        const out = { review: this.namedReview(r), event_id: r.event_id };
        this.idem.set(idem, out);
        return json(200, out);
      }

      /* fix 5.1: bulk reject, back to the queue from «Not confirmed» */
      case key === "POST /review/bulk-reject" || key === "POST /review/bulk-reopen": {
        const g = guard(["events.review"]);
        if (g) return g;
        const idem = headers["idempotency-key"];
        if (!idem) return err(400, "IDEMPOTENCY_KEY_REQUIRED");
        if (this.idem.has(idem)) return json(200, this.idem.get(idem));
        const items = (body.items ?? []) as Array<{ review_id: string; expected_content_hash?: string }>;
        const note = String(body.note ?? "");
        if (!items.length || items.length > 100 || note.length < 3 || note.length > 500) return err(422, "VALIDATION_ERROR", { field: !items.length || items.length > 100 ? "items" : "note" });
        const reject = key === "POST /review/bulk-reject";
        const batch = `b${++this.seq}`;
        const results = items.map((it) => {
          const r = this.reviews.find((x) => x.review_id === it.review_id);
          if (!r) return { review_id: it.review_id, status: "SKIPPED", code: "REVIEW_NOT_FOUND" };
          if (r.status !== (reject ? "OPEN" : "EXPIRED")) return { review_id: r.review_id, status: "SKIPPED", code: "REVIEW_ALREADY_DECIDED" };
          if (reject && it.expected_content_hash !== r.content_hash) return { review_id: r.review_id, status: "SKIPPED", code: "REVIEW_CHANGED" };
          if (reject) Object.assign(r, { status: "REJECTED", decided_by: me.staff_id, decided_at: F.iso(0), decision_note: note, decision_reason: body.reason_code, expires_at: null });
          else Object.assign(r, { status: "OPEN", decided_by: null, decided_at: null, decision_note: null, decision_reason: null, expired_at: null, expires_at: F.iso(7 * 86_400_000) });
          this.record(reject ? "review.rejected" : "review.reopened", "review", r.review_id, { batch_id: batch }, note);
          return { review_id: r.review_id, status: reject ? "REJECTED" : "OPEN", code: null };
        });
        const out = { results };
        this.idem.set(idem, out);
        return json(200, out);
      }
      case !!(m = path.match(/^\/review\/([^/]+)\/reopen$/)) && method === "POST": {
        const g = guard(["events.review"]);
        if (g) return g;
        const r = this.reviews.find((x) => x.review_id === m![1]);
        if (!r) return err(404, "REVIEW_NOT_FOUND");
        if (body.expected_status !== "EXPIRED" || r.status !== "EXPIRED") return err(409, "REVIEW_ALREADY_DECIDED", { status: r.status });
        const note = String(body.note ?? "");
        if (note.length < 3 || note.length > 500) return err(422, "VALIDATION_ERROR", { field: "note" });
        Object.assign(r, { status: "OPEN", decided_by: null, decided_at: null, decision_note: null, decision_reason: null, expired_at: null, expires_at: F.iso(7 * 86_400_000) });
        this.record("review.reopened", "review", r.review_id, {}, note);
        return json(200, { review: this.namedReview(r) });
      }

      case key === "GET /sources": {
        const g = guard(["sources.manage", "events.review", "discovery.manage"]);
        if (g) return g;
        let items = this.sources;
        const term = (q.get("q") ?? "").toLowerCase();
        if (term) items = items.filter((x) => x.name.toLowerCase().includes(term) || x.slug.includes(term) || x.event_domains.some((d) => d.includes(term)));
        if (q.get("country")) items = items.filter((x) => x.country_code === q.get("country"));
        if (q.get("enabled")) items = items.filter((x) => String(x.enabled) === q.get("enabled"));
        return json(200, { items: items.map((x) => this.namedSource(x)), next_cursor: null });
      }
      case key === "POST /sources": {
        const g = guard(["sources.manage"], true);
        if (g) return g;
        const idem = headers["idempotency-key"];
        if (!idem) return err(400, "IDEMPOTENCY_KEY_REQUIRED");
        if (this.idem.has(idem)) return json(201, this.idem.get(idem));
        if (this.sources.some((x) => x.slug === body.slug)) return err(409, "SOURCE_SLUG_TAKEN");
        if (String(body.reason ?? "").length < 3) return err(422, "VALIDATION_ERROR", { field: "reason" });
        const { reason, ...input } = body as unknown as Source & { reason: string };
        const sNew: Source = { ...input, source_id: `5c000000-0000-4000-8000-${String(900 + ++this.seq).padStart(12, "0")}`, version: 1, created_at: F.iso(0), updated_at: F.iso(0), updated_by: me.staff_id, updated_by_name: null };
        this.sources.push(sNew);
        this.changes.set(sNew.source_id, [{ version: 1, actor_id: me.staff_id, actor_name: null, changed_fields: Object.keys(input), reason, at: F.iso(0) }]);
        this.record("source.created", "source", sNew.source_id, { slug: sNew.slug }, reason);
        this.idem.set(idem, this.namedSource(sNew));
        return json(201, this.namedSource(sNew));
      }
      // 9.3: «Проверить» страницу JSON API — первая страница API театра (items_path без data — схема не совпала)
      case key === "POST /sources/json-api/preview": {
        const g = guard(["sources.manage"]);
        if (g) return g;
        const api = body.json_api as { items_path?: string | string[]; url?: string } | undefined;
        const paths = Array.isArray(api?.items_path) ? api!.items_path : [api?.items_path ?? ""];
        const base = { request_url: `${api?.url ?? "https://server.auezov-theatre.kz/performances/"}?is_active=true&per_page=100&page=1`, checked_at: F.iso(0) };
        if (!paths.some((x) => x.startsWith("data"))) {
          return json(200, { ...base, ok: false, code: "SOURCE_SCHEMA_MISMATCH", reason: "items_path", items_path: null, items_total: 0, events: [], rejected: [], skipped: {}, keys_scope: "response", keys: [{ path: "data.items.0.id", sample: "101" }, { path: "data.total", sample: "12" }] });
        }
        const ev = (id: string, title: string, d: string, tm: string, hall: string) => ({
          id, title, local_date: d, local_time: tm, timezone: "Asia/Almaty", utc: null, end_local_date: null, end_local_time: null,
          venue: `Театр им. М. Ауэзова — ${hall}`, city: "Almaty", url: `https://auezov-theatre.kz/ru/afisha/performance/${id}`,
          image: `https://server.auezov-theatre.kz/media/cover-${id}.jpg`, price: null, category: "culture.theatre", age: "12+", status: "active", description: "Драма в двух актах",
        });
        return json(200, {
          ...base, ok: true, code: null, reason: null, items_path: "data.items", items_total: 12,
          events: [ev("101", "Абай", "2026-11-05", "18:00", "Большой зал"), ev("102", "Ревизор", "2026-11-20", "19:00", "Малый зал"), ev("104", "Қыз Жібек", "2026-12-01", "19:00", "Большой зал")],
          rejected: [{ index: 2, id: "103", reason: "status_excluded" }, { index: 4, id: "105", reason: "date_out_of_window" }],
          skipped: { status_excluded: 1, date_out_of_window: 1 },
          keys_scope: "item",
          keys: [{ path: "id", sample: "101" }, { path: "title.ru", sample: "Абай" }, { path: "title.kz", sample: "Абай" }, { path: "start_time", sample: "2026-11-05T13:00:00Z" }, { path: "venue.name.ru", sample: "Театр им. М. Ауэзова" }, { path: "hall.name.ru", sample: "Большой зал" }, { path: "media_items.0.url", sample: "/media/cover-101.jpg" }, { path: "age_rating", sample: "12+" }],
        });
      }
      case key === "GET /sources/crawl-stats": {
        const g = guard(["sources.manage", "discovery.manage"]);
        if (g) return g;
        if (this.sc.crawlDown === "unavailable") return err(503, "UPSTREAM_UNAVAILABLE", { service: "provider-gateway" });
        if (this.sc.crawlDown === "feature-off") return err(503, "FEATURE_UNAVAILABLE", { service: "provider-gateway" });
        return json(200, { items: this.crawl });
      }
      case !!(m = path.match(/^\/sources\/([^/]+)$/)): {
        const x = this.sources.find((y) => y.source_id === m![1]);
        if (method === "GET") {
          const g = guard(["sources.manage", "events.review", "discovery.manage"]);
          if (g) return g;
          if (!x) return err(404, "SOURCE_NOT_FOUND");
          const changes = (this.changes.get(x.source_id) ?? C.sourceChanges(x)).map((c) => ({ ...c, actor_name: this.nameOf(c.actor_id) }));
          return json(200, { ...this.namedSource(x), changes });
        }
        if (method !== "PATCH") return err(404, "NOT_FOUND");
        const changed = Object.keys(body).filter((k) => k !== "expected_version" && k !== "reason");
        const g = guard(["sources.manage"], changed.some((k) => ["event_domains", "media_domains", "enabled", "tier"].includes(k)));
        if (g) return g;
        if (!x) return err(404, "SOURCE_NOT_FOUND");
        if ("slug" in body) return err(422, "VALIDATION_ERROR", { field: "slug" });
        if (body.expected_version !== x.version) return err(409, "SOURCE_VERSION_CONFLICT", { version: x.version });
        const prev = this.changes.get(x.source_id) ?? C.sourceChanges(x);
        for (const k of changed) (x as unknown as Record<string, unknown>)[k] = body[k];
        if (x.enabled) x.disabled_reason = null; // 9.1: включение сотрудником снимает причину автовыключения
        x.version += 1;
        x.updated_at = F.iso(0);
        x.updated_by = me.staff_id;
        this.changes.set(x.source_id, [{ version: x.version, actor_id: me.staff_id, actor_name: null, changed_fields: changed, reason: String(body.reason), at: F.iso(0) }, ...prev]);
        this.record(changed.includes("enabled") ? (x.enabled ? "source.enabled" : "source.disabled") : "source.updated", "source", x.source_id, { changed_fields: changed }, String(body.reason));
        return json(200, this.namedSource(x));
      }

      case key === "GET /discovery/runs": {
        const g = guard(["discovery.manage"]);
        if (g) return g;
        const limit = Number(q.get("limit") ?? 20);
        const cursor = Number(q.get("cursor") ?? 0);
        return json(200, { items: this.runs.slice(cursor, cursor + limit), next_cursor: cursor + limit < this.runs.length ? String(cursor + limit) : null });
      }
      case key === "POST /discovery/runs": {
        const g = guard(["discovery.manage"]);
        if (g) return g;
        const idem = headers["idempotency-key"];
        if (idem && this.idem.has(idem)) return json(202, this.idem.get(idem));
        const live = this.runs.find((x) => x.status === "RUNNING");
        if (live) return err(409, "DISCOVERY_RUN_IN_PROGRESS", { run_id: live.run_id });
        const mpc = body.max_provider_calls;
        if (mpc !== undefined && (typeof mpc !== "number" || mpc < 1 || mpc > 200)) return err(422, "VALIDATION_ERROR", { field: "max_provider_calls" });
        const r: DiscoveryRun = { ...C.runningRun(), run_id: `d1500000-0000-4000-8000-${String(500 + ++this.seq).padStart(12, "0")}`, trigger: "manual", started_at: F.iso(0), scopes_done: 0, provider_calls: 0, candidates_seen: 0, candidates_emitted: 0, ai: { llm_calls: 0, pages_fetched: 0, input_tokens: 0, output_tokens: 0, cost_usd: "0.0000" } };
        this.runs.unshift(r);
        this.record("discovery.run_started", "discovery_run", r.run_id, { max_provider_calls: mpc ?? null });
        if (idem) this.idem.set(idem, r);
        return json(202, r);
      }
      case !!(m = path.match(/^\/discovery\/runs\/([^/]+)$/)) && method === "GET": {
        const g = guard(["discovery.manage"]);
        if (g) return g;
        const r = this.runs.find((x) => x.run_id === m![1]);
        return r ? json(200, r) : err(404, "DISCOVERY_RUN_NOT_FOUND");
      }
      /* ---------- fix 6.1: AI limits from the admin ---------- */
      case key === "GET /discovery/limits":
        return guard(["discovery.manage", "ops.kill_switch"]) ?? json(200, this.namedLimits());
      case key === "PUT /discovery/limits" || key === "DELETE /discovery/limits": {
        const g = guard(["ops.kill_switch"], true);
        if (g) return g;
        if (this.sc.auditDown) return err(503, "AUDIT_UNAVAILABLE", { service: "audit" });
        const reason = String(body.reason ?? "").trim();
        if (reason.length < 3) return err(422, "VALIDATION_ERROR", { field: "reason" });
        const two = (v: unknown) => Number(v).toFixed(2);
        if (method === "PUT") {
          if (Number(body.news_daily_usd) > Number(body.ai_daily_usd)) return err(422, "VALIDATION_ERROR", { field: "news_daily_usd" });
          Object.assign(this.limits, { ai_daily_usd: two(body.ai_daily_usd), news_daily_usd: two(body.news_daily_usd), pages_daily: Number(body.pages_daily), source: "admin", updated_by: me.staff_id, updated_at: F.iso(0), reason });
          this.record("ai.limits.update", "provider", "ai_web", { ...body }, reason);
        } else {
          Object.assign(this.limits, { ...this.limits.defaults, source: "env", updated_by: null, updated_at: null, reason: null });
          this.record("ai.limits.reset", "provider", "ai_web", null, reason);
        }
        this.budget = { ...this.budget, budget_usd: this.limits.ai_daily_usd, pages_limit: this.limits.pages_daily, news: this.budget.news ? { ...this.budget.news, budget_usd: this.limits.news_daily_usd } : this.budget.news };
        return json(200, this.namedLimits());
      }
      case key === "GET /discovery/budget":
        return guard(["discovery.manage"]) ?? (this.sc.budgetDown ? err(503, "UPSTREAM_UNAVAILABLE", { service: "provider-gateway" }) : json(200, this.namedBudget()));
      case key === "PUT /discovery/pause": {
        const g = guard(["ops.kill_switch"], true);
        if (g) return g;
        const reason = String(body.reason ?? "");
        if (reason.length < 3 || reason.length > 300) return err(422, "VALIDATION_ERROR", { field: "reason" });
        if (this.sc.auditDown) return err(503, "AUDIT_UNAVAILABLE", { service: "audit" });
        this.budget = { ...this.budget, paused: body.paused ? { paused: true, reason, by: me.staff_id, by_name: null, at: F.iso(0) } : null };
        this.record(body.paused ? "ai.kill_switch.on" : "ai.kill_switch.off", "provider", "ai_web", { paused: body.paused }, reason);
        return json(200, this.namedBudget());
      }

      /* ---------- sprint 5: trip providers, offer snapshots ---------- */
      case key === "GET /travel/providers":
        return guard(["dashboard.read"]) ?? (this.sc.travelDown ? err(503, "UPSTREAM_UNAVAILABLE", { service: "provider-gateway" }) : json(200, { items: this.travel }));
      case !!(m = path.match(/^\/travel\/providers\/([^/]+)\/probe$/)) && method === "POST": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        const name = m![1]! as T.TravelName;
        const row = this.travel.find((x) => x.name === name);
        if (!row) return err(422, "VALIDATION_ERROR", { in: "params", field: "name" });
        const outcome = this.sc.probe?.[name] ?? "ok";
        if (outcome === "unavailable") return err(503, "PROBE_UNAVAILABLE", { service: "provider-gateway" });
        const last = this.probedAt.get(name);
        if (outcome === "limited" || (last && Date.now() - last < 30_000)) {
          const retry = outcome === "limited" ? 17 : Math.ceil((30_000 - (Date.now() - last!)) / 1000);
          return err(429, "PROBE_RATE_LIMITED", { retry_after: retry });
        }
        this.probedAt.set(name, Date.now());
        const r = T.probeResult(name, outcome);
        // provider-gateway records the probe like any call: the card shows the fresh success / error
        if (r.ok) row.last_success_at = r.checked_at;
        else row.last_error = { code: r.code!, reason: r.reason, message: r.message, at: r.checked_at, http_status: r.http_status };
        return json(200, r);
      }
      case !!(m = path.match(/^\/offers\/([^/]+)$/)) && method === "GET": {
        const g = guard(["support.read"]);
        if (g) return g;
        const id = m![1]!;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return err(422, "VALIDATION_ERROR", { in: "params", field: "offerId" });
        if (this.sc.offer === "down") return err(503, "UPSTREAM_UNAVAILABLE", { service: "offers" });
        if (id !== T.OFFER_OK) return err(404, "OFFER_NOT_FOUND");
        return json(200, T.snapshot(id, this.sc.offer === "nodeparture" || this.sc.offer === "foreign" || this.sc.offer === "fx" ? this.sc.offer : "ok"));
      }

      /* ---------- sprint 6: news feeds, news, watches ---------- */
      case this.sc.newsOff && path.startsWith("/news/"):
        return err(503, "FEATURE_UNAVAILABLE", { service: "news" });
      case this.sc.watchOff && path.startsWith("/watches/"):
        return err(503, "FEATURE_UNAVAILABLE", { service: "watch" });
      case key === "GET /news/sources": {
        const g = guard(["news.manage"]);
        if (g) return g;
        let items = this.feeds;
        const term = (q.get("q") ?? "").toLowerCase();
        if (term) items = items.filter((x) => x.name.toLowerCase().includes(term) || x.slug.includes(term) || x.site_domain.includes(term));
        if (q.get("interest")) items = items.filter((x) => x.interests.some((c) => c === q.get("interest") || c.startsWith(`${q.get("interest")}.`)));
        const cs = q.get("country")?.split(",");
        if (cs && cs.some((c) => !/^[A-Z]{2}$/.test(c))) return err(422, "VALIDATION_ERROR", { in: "querystring", field: "country" });
        if (cs) items = items.filter((x) => !!x.country_code && cs.includes(x.country_code));
        if (q.get("enabled")) items = items.filter((x) => String(x.enabled) === q.get("enabled"));
        return json(200, { items, next_cursor: null });
      }
      case key === "POST /news/sources/check":
      case !!(m = path.match(/^\/news\/sources\/([^/]+)\/check$/)) && method === "POST": {
        const g = guard(["news.manage"]);
        if (g) return g;
        const cm = path.match(/^\/news\/sources\/([^/]+)\/check$/);
        const x = cm ? this.feeds.find((y) => y.source_id === cm[1]) : null;
        if (cm && !x) return err(404, "NEWS_SOURCE_NOT_FOUND");
        if (this.sc.feedCheck === "unavailable") return err(503, "CHECK_UNAVAILABLE", { service: "news" });
        await new Promise((r) => setTimeout(r, 350)); // a real fetch takes a moment: the spinner is visible
        return json(200, N.checkResult(this.sc.feedCheck ?? "ok", String(body.site_domain ?? x?.site_domain ?? "example.org")));
      }
      case key === "POST /news/sources": {
        const g = guard(["news.manage"]);
        if (g) return g;
        const idem = headers["idempotency-key"];
        if (!idem) return err(400, "IDEMPOTENCY_KEY_REQUIRED");
        if (this.idem.has(idem)) return json(201, this.idem.get(idem));
        if (this.feeds.some((x) => x.slug === body.slug)) return err(409, "NEWS_SOURCE_SLUG_TAKEN");
        const { reason, ...input } = body as unknown as NewsSource & { reason: string };
        const f: NewsSource = { ...input, source_id: `a6000000-0000-4000-8000-${String(900 + ++this.seq).padStart(12, "0")}`, health: { last_fetch_at: null, last_ok_at: null, last_error: null, items_24h: 0 }, version: 1, updated_at: F.iso(0) };
        this.feeds.push(f);
        this.record("news.source.created", "news_source", f.source_id, { slug: f.slug }, reason);
        this.idem.set(idem, f);
        return json(201, f);
      }
      case !!(m = path.match(/^\/news\/sources\/([^/]+)$/)): {
        const g = guard(["news.manage"]);
        if (g) return g;
        const x = this.feeds.find((y) => y.source_id === m![1]);
        if (!x) return err(404, "NEWS_SOURCE_NOT_FOUND");
        if (method === "GET") return json(200, x);
        if (method === "DELETE") {
          if (body.expected_version !== x.version) return err(409, "NEWS_SOURCE_VERSION_CONFLICT", { current_version: x.version });
          this.feeds = this.feeds.filter((y) => y !== x);
          this.record("news.source.deleted", "news_source", x.source_id, null, String(body.reason));
          return json(204);
        }
        if (method !== "PATCH") return err(404, "NOT_FOUND");
        if (this.sc.feedConflict) {
          this.sc.feedConflict = false;
          x.version += 1;
          x.updated_at = F.iso(-30_000);
        }
        if (body.expected_version !== x.version) return err(409, "NEWS_SOURCE_VERSION_CONFLICT", { current_version: x.version });
        const changed = Object.keys(body).filter((k) => k !== "expected_version" && k !== "reason");
        for (const k of changed) (x as unknown as Record<string, unknown>)[k] = body[k];
        if (x.enabled) x.disabled_reason = null; // 9.1: включение сотрудником снимает причину автовыключения
        x.version += 1;
        x.updated_at = F.iso(0);
        this.record("news.source.updated", "news_source", x.source_id, { changed_fields: changed }, String(body.reason));
        return json(200, x);
      }
      case key === "GET /news/items": {
        const g = guard(["news.manage"]);
        if (g) return g;
        let items = this.news;
        if (q.get("source")) items = items.filter((x) => x.source.source_id === q.get("source"));
        const cs = q.get("country")?.split(",");
        if (cs) {
          const ids = new Set(this.feeds.filter((f) => !!f.country_code && cs.includes(f.country_code)).map((f) => f.source_id));
          items = items.filter((x) => !!x.source.source_id && ids.has(x.source.source_id));
        }
        if (q.get("hidden")) items = items.filter((x) => String(x.hidden) === q.get("hidden"));
        return json(200, { items, next_cursor: null });
      }
      case !!(m = path.match(/^\/news\/items\/([^/]+)\/(hide|unhide)$/)) && method === "POST": {
        const g = guard(["news.manage"]);
        if (g) return g;
        const x = this.news.find((y) => y.news_id === m![1]);
        if (!x) return err(404, "NEWS_ITEM_NOT_FOUND");
        const reason = String(body.reason ?? "").trim();
        if (reason.length < 3 || reason.length > 300) return err(422, "VALIDATION_ERROR", { field: "reason" });
        const hide = m![2] === "hide";
        Object.assign(x, hide ? { hidden: true, hidden_reason: reason, hidden_at: F.iso(0), hidden_by: me.staff_id, hidden_by_name: me.display_name } : { hidden: false, hidden_reason: null, hidden_at: null, hidden_by: null, hidden_by_name: null });
        this.record("news.item.hidden", "news_item", x.news_id, { hidden: hide }, reason);
        return json(200, x);
      }
      case key === "GET /watches/stats":
        return guard(["dashboard.read"]) ?? json(200, N.watchStats());


      /* ---------------------------------------------------------------- sprint 7: AI */
      case this.sc.aiOff && /^\/(usage|ai\/(budgets|agents|alerts|pricing|access-levels)|skills|evaluation)\b/.test(path) && !path.startsWith("/ai/limits"):
        return guard(["dashboard.read", "ops.kill_switch"]) ?? err(503, "FEATURE_UNAVAILABLE", { service: "ai-control" });
      case key === "GET /usage/kpi":
        return guard(["dashboard.read"]) ?? json(200, A.kpi(q.get("period") ?? "7d"));
      case key === "GET /usage/agents":
        return guard(["dashboard.read"]) ?? json(200, A.usage());
      case key === "GET /usage/requests": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        const period = q.get("period") ?? "30d";
        const days = period === "today" ? 1 : period === "7d" ? 7 : 30;
        const items = A.requests().filter(
          (r) =>
            Date.parse(r.occurred_at) > Date.now() - days * 86_400_000 &&
            (!q.get("agent") || r.agent_id === q.get("agent")) &&
            (!q.get("status") || r.status === q.get("status")) &&
            (!q.get("model") || r.model_used === q.get("model")) &&
            (!q.get("user_id") || r.user_id === q.get("user_id")),
        );
        return json(200, { items, next_cursor: null });
      }
      case !!(m = path.match(/^\/usage\/requests\/([0-9a-f-]{36})$/)) && method === "GET": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        const d = A.detail(m![1]!);
        return d ? json(200, d) : err(404, "AI_REQUEST_NOT_FOUND");
      }
      case !!(m = path.match(/^\/usage\/requests\/([0-9a-f-]{36})\/content:reveal$/)) && method === "POST": {
        const g = guard(["ai.content.read"], true);
        if (g) return g;
        const reason = String(body.reason ?? "").trim();
        if (reason.length < 3 || reason.length > 300) return err(422, "VALIDATION_ERROR", { field: "reason" });
        if (this.sc.revealAuditDown) return err(503, "AUDIT_UNAVAILABLE", { service: "audit" });
        const d = A.detail(m![1]!);
        if (!d || !d.content.available) return err(404, "AI_CONTENT_EXPIRED");
        this.record("ai.content.view", "ai_request", m![1]!, null, reason);
        return json(200, A.content(m![1]!));
      }
      case key === "GET /ai/budgets":
        return guard(["dashboard.read", "ops.kill_switch"]) ?? json(200, this.overview());
      case key === "GET /ai/limits":
        return guard(["discovery.manage", "ops.kill_switch"]) ?? json(200, this.namedLimits());
      case key === "PUT /ai/limits" || key === "DELETE /ai/limits": {
        const g = guard(["ops.kill_switch"], true);
        if (g) return g;
        if (this.sc.auditDown) return err(503, "AUDIT_UNAVAILABLE", { service: "audit" });
        const reason = String(body.reason ?? "").trim();
        if (reason.length < 3) return err(422, "VALIDATION_ERROR", { field: "reason" });
        const two = (v: unknown) => Number(v).toFixed(2);
        if (method === "PUT") {
          Object.assign(this.limits, {
            ai_daily_usd: two(body.ai_daily_usd),
            news_daily_usd: two(body.news_daily_usd),
            pages_daily: Number(body.pages_daily),
            ...(body.concierge_daily_usd !== undefined ? { concierge_daily_usd: two(body.concierge_daily_usd) } : {}),
            ...(body.evaluation_daily_usd !== undefined ? { evaluation_daily_usd: two(body.evaluation_daily_usd) } : {}),
            source: "admin",
            updated_by: me.staff_id,
            updated_at: F.iso(0),
            reason,
          });
          this.record("ai.limits.update", "provider", "ai_web", { ...body }, reason);
        } else {
          Object.assign(this.limits, { ...this.limits.defaults, source: "env", updated_by: null, updated_at: null, reason: null });
          this.record("ai.limits.reset", "provider", "ai_web", null, reason);
        }
        for (const a of this.aiRuntime) {
          const lim = a.agent_id === "concierge" ? this.limits.concierge_daily_usd : a.agent_id === "evaluation" ? this.limits.evaluation_daily_usd : null;
          if (lim && a.day) a.day = { ...a.day, limit_usd: lim, pct: Math.floor((Number(a.day.spent_usd) * 100) / Math.max(Number(lim), 0.0001)), source: this.limits.source };
        }
        return json(200, this.namedLimits());
      }
      case (!!(m = path.match(/^\/ai\/agents\/([a-z_]+)\/pause$/)) || path === "/ai/providers/anthropic/pause") && method === "PUT": {
        const g = guard(["ops.kill_switch"], true);
        if (g) return g;
        const reason = String(body.reason ?? "").trim();
        if (reason.length < 3 || reason.length > 300) return err(422, "VALIDATION_ERROR", { field: "reason" });
        if (this.sc.auditDown) return err(503, "AUDIT_UNAVAILABLE", { service: "audit" });
        const pause = body.paused ? { reason, by: me.staff_id, by_name: null, at: F.iso(0) } : null;
        if (path === "/ai/providers/anthropic/pause") {
          this.provider = pause;
          this.record(body.paused ? "ai.provider.pause" : "ai.provider.resume", "ai_provider", "anthropic", { paused: body.paused }, reason);
        } else {
          const a = this.aiRuntime.find((x) => x.agent_id === m![1]);
          if (!a) return err(404, "AI_AGENT_NOT_FOUND");
          a.paused = pause;
          a.state = pause ? "paused" : a.agent_id === "concierge" ? "degraded" : "normal";
          this.record(body.paused ? "ai.agent.pause" : "ai.agent.resume", "ai_agent", a.agent_id, { paused: body.paused }, reason);
        }
        return json(200, this.killState());
      }
      case key === "GET /ai/agents":
        return guard(["dashboard.read", "ops.kill_switch"]) ?? json(200, this.named({ items: this.aiAgents }));
      case !!(m = path.match(/^\/ai\/agents\/([a-z_]+)$/)) && method === "PATCH": {
        const g = guard(["ops.kill_switch"], true);
        if (g) return g;
        if (!headers["idempotency-key"]) return err(400, "IDEMPOTENCY_KEY_REQUIRED");
        const a = this.aiAgents.find((x) => x.agent_id === m![1]);
        if (!a) return err(404, "AI_AGENT_NOT_FOUND");
        if (Number(body.expected_version) !== a.config_version) return err(409, "VERSION_CONFLICT");
        const { reason, expected_version: _e, ...changes } = body as Record<string, unknown>;
        const money = (v: unknown, d: number) => (v == null ? null : Number(v).toFixed(d === 6 ? 6 : 6));
        // review 7 (M3): the ai-control checks and warnings
        if (changes.per_request_max_usd != null) {
          const over = this.skillCosts(a.agent_id).filter((c) => Number(c.max_cost_usd) > Number(changes.per_request_max_usd));
          if (over.length) return err(409, "AGENT_PER_REQUEST_BELOW_SKILL", { per_request_max_usd: String(changes.per_request_max_usd), skills: over });
        }
        const warnings: Array<{ code: string; message: string; details: Record<string, string | number> }> = [];
        const rt0 = this.aiRuntime.find((x) => x.agent_id === a.agent_id);
        if (changes.monthly_cap_usd != null) {
          const day = rt0?.day?.limit_usd;
          if (day != null && Number(changes.monthly_cap_usd) < Number(day))
            return err(422, "AGENT_MONTHLY_BELOW_DAILY", { monthly_cap_usd: Number(changes.monthly_cap_usd).toFixed(2), daily_limit_usd: Number(day).toFixed(2) });
          const spent = rt0?.month?.cost_usd;
          if (spent != null && Number(spent) >= Number(changes.monthly_cap_usd))
            warnings.push({
              code: "MONTHLY_CAP_BELOW_SPENT",
              message: "Месячный лимит не выше уже потраченного: агент будет остановлен автоматически (автопауза)",
              details: { spent_usd: Number(spent).toFixed(6), monthly_cap_usd: Number(changes.monthly_cap_usd).toFixed(2) },
            });
        }
        Object.assign(a, changes, {
          ...(changes.per_request_max_usd !== undefined ? { per_request_max_usd: money(changes.per_request_max_usd, 6) } : {}),
          ...(changes.monthly_cap_usd !== undefined ? { monthly_cap_usd: money(changes.monthly_cap_usd, 6) } : {}),
          config_version: a.config_version + 1,
          updated_by: me.staff_id,
          updated_at: F.iso(0),
        });
        const rt = this.aiRuntime.find((x) => x.agent_id === a.agent_id);
        if (rt) Object.assign(rt, { degraded_mode: a.degraded_mode, degrade_at_pct: a.degrade_at_pct, month: rt.month ? { ...rt.month, cap_usd: a.monthly_cap_usd } : rt.month });
        this.record("ai.agent.config.update", "ai_agent", a.agent_id, changes, String(reason));
        if (rt && warnings.some((w) => w.code === "MONTHLY_CAP_BELOW_SPENT")) {
          rt.paused = { reason: "Месячный лимит исчерпан", by: "system", by_name: null, at: F.iso(0) };
          rt.state = "paused";
        }
        return json(200, { ...this.named(a), warnings });
      }
      case key === "GET /ai/alerts": {
        const g = guard(["dashboard.read", "ops.kill_switch"]);
        if (g) return g;
        const items = this.aiAlerts.filter((a) => q.get("unacked") !== "true" || !a.acked_at);
        return json(200, this.named({ items, next_cursor: null }));
      }
      case !!(m = path.match(/^\/ai\/alerts\/([0-9a-f-]{36}):ack$/)) && method === "POST": {
        const g = guard(["ops.kill_switch"]);
        if (g) return g;
        const a = this.aiAlerts.find((x) => x.alert_id === m![1]);
        if (!a) return err(404, "AI_ALERT_NOT_FOUND");
        if (!a.acked_at) Object.assign(a, { acked_by: me.staff_id, acked_at: F.iso(0) });
        return json(200, this.named(a));
      }
      case key === "GET /ai/pricing/versions":
        return guard(["dashboard.read"]) ?? json(200, this.named({ items: this.prices.map(({ items: _i, incomplete_models: _m, ...v }) => v) }));
      case key === "POST /ai/pricing/versions": {
        const g = guard(["ops.kill_switch"]);
        if (g) return g;
        if (this.prices.some((p) => p.status === "draft")) return err(409, "SKILL_DRAFT_EXISTS");
        const base = this.prices.find((p) => p.version === body.based_on) ?? this.prices[0]!;
        const v = { ...JSON.parse(JSON.stringify(base)), version: `${F.iso(0).slice(0, 10)}-1`, status: "draft", note: String(body.note ?? ""), based_on: base.version, created_by: me.staff_id, created_at: F.iso(0), activated_by: null, activated_at: null, retired_at: null, row_version: 1 };
        this.prices.unshift(v);
        return json(201, this.named(v));
      }
      case !!(m = path.match(/^\/ai\/pricing\/versions\/([0-9a-z-]+)$/)): {
        const v = this.prices.find((p) => p.version === m![1]);
        if (method === "GET") return guard(["dashboard.read"]) ?? (v ? json(200, this.named(v)) : err(404, "NOT_FOUND"));
        const g = guard(["ops.kill_switch"]);
        if (g) return g;
        if (!v) return err(404, "NOT_FOUND");
        if (v.status !== "draft") return err(409, "PRICING_VERSION_IMMUTABLE");
        if (Number(body.expected_version) !== v.row_version) return err(409, "VERSION_CONFLICT");
        if (Array.isArray(body.items)) v.items = (body.items as typeof v.items)!.map((i) => ({ ...i, ...Object.fromEntries(Object.entries(i).filter(([k]) => k.endsWith("_usd") || k.endsWith("_mtok")).map(([k, x]) => [k, x == null ? null : Number(x).toFixed(6)])) }));
        if (typeof body.note === "string") v.note = body.note;
        v.incomplete_models = (v.items ?? []).filter((i) => i.kind === "model" && [i.input_usd_per_mtok, i.output_usd_per_mtok, i.cache_read_usd_per_mtok, i.cache_write_usd_per_mtok].some((x) => x == null)).map((i) => i.key);
        v.row_version += 1;
        v.updated_at = F.iso(0);
        return json(200, this.named(v));
      }
      case !!(m = path.match(/^\/ai\/pricing\/versions\/([0-9a-z-]+):activate$/)) && method === "POST": {
        const g = guard(["ops.kill_switch"], true);
        if (g) return g;
        const v = this.prices.find((p) => p.version === m![1]);
        if (!v) return err(404, "NOT_FOUND");
        if (v.status !== "draft") return err(409, "PRICING_VERSION_IMMUTABLE");
        if (v.incomplete_models?.length) return err(409, "PRICING_MODEL_MISSING");
        for (const p of this.prices) if (p.status === "active") Object.assign(p, { status: "retired", retired_at: F.iso(0) });
        Object.assign(v, { status: "active", activated_by: me.staff_id, activated_at: F.iso(0), row_version: v.row_version + 1 });
        this.record("ai.pricing.activate", "price_catalog", v.version, null, String(body.reason));
        return json(200, this.named(v));
      }
      case key === "GET /ai/access-levels":
        return guard(["dashboard.read", "ops.kill_switch", "users.read"]) ?? json(200, this.named({ items: this.levels }));
      case !!(m = path.match(/^\/ai\/access-levels\/([a-z0-9_]+)$/)) && method === "PUT": {
        const g = guard(["ops.kill_switch"], true);
        if (g) return g;
        const n = Number(body.concierge_messages_per_day);
        if (!Number.isInteger(n) || n < 0 || n > 1000) return err(422, "VALIDATION_ERROR", { field: "concierge_messages_per_day" });
        let l = this.levels.find((x) => x.code === m![1]);
        if (n === 0 && (body.is_default === true || l?.is_default)) return err(422, "ACCESS_DEFAULT_ZERO", { level: m![1]! });
        if (!l) {
          l = { code: m![1]!, name_ru: "", name_en: "", concierge_messages_per_day: 0, is_default: false, sort: 100, version: 0, updated_by: null, updated_by_name: null, updated_at: null };
          this.levels.push(l);
        }
        if (body.is_default === true) for (const x of this.levels) x.is_default = false;
        Object.assign(l, { name_ru: body.name_ru, name_en: body.name_en, concierge_messages_per_day: n, ...(body.is_default !== undefined ? { is_default: body.is_default } : {}), version: l.version + 1, updated_by: me.staff_id, updated_at: F.iso(0) });
        this.record("ai.access_level.update", "access_level", l.code, { concierge_messages_per_day: n }, String(body.reason));
        const def = this.levels.find((x) => x.is_default);
        const warnings = def
          ? this.levels
              .filter((x) => !x.is_default && x.concierge_messages_per_day < def.concierge_messages_per_day)
              .map((x) => ({
                code: "LEVEL_BELOW_DEFAULT",
                message: `У уровня «${x.name_ru}» меньше сообщений, чем у уровня по умолчанию «${def.name_ru}»`,
                details: { level: x.code, concierge_messages_per_day: x.concierge_messages_per_day, default_level: def.code, default_messages_per_day: def.concierge_messages_per_day },
              }))
          : [];
        return json(200, { ...this.named(l), warnings });
      }
      case !!(m = path.match(/^\/users\/([^/]+)\/access-level$/)): {
        const uid = m![1]!;
        if (method === "GET") return guard(["users.read"]) ?? json(200, this.named(this.accessOf(uid)));
        const g = guard(["users.access.manage"]);
        if (g) return g;
        if (!headers["idempotency-key"]) return err(400, "IDEMPOTENCY_KEY_REQUIRED");
        // review 7: the reason is in the body, never in the URL
        if (q.has("reason")) return err(422, "VALIDATION_ERROR", { field: "reason", in: "query" });
        const reason = String(body.reason ?? "").trim();
        if (reason.length < 3) return err(422, "VALIDATION_ERROR", { field: "reason" });
        const cur = this.accessOf(uid);
        if (method === "DELETE") {
          this.access.set(uid, { ...A.userAccess(uid), version: cur.version + 1 });
          this.record("user.access_level.reset", "user", uid, null, reason);
          return json(200, this.named(this.accessOf(uid)));
        }
        const l = this.levels.find((x) => x.code === body.level);
        if (!l) return err(422, "ACCESS_LEVEL_NOT_FOUND");
        const exp = (body.expires_at as string | null) ?? null;
        this.access.set(uid, {
          user_id: uid,
          level: l.code,
          level_name: l.name_ru,
          level_name_en: l.name_en,
          source: "manual",
          expires_at: exp,
          limits: { concierge_messages_per_day: l.concierge_messages_per_day },
          assigned_by: me.staff_id,
          assigned_by_name: null,
          assigned_at: F.iso(0),
          reason,
          assignment: { level: l.code, source: "manual", expires_at: exp, expired: false },
          version: cur.version + 1,
        });
        this.record("user.access_level.assign", "user", uid, { level: l.code, expires_at: exp }, reason);
        return json(200, this.named(this.accessOf(uid)));
      }
      case key === "GET /skills":
        return (
          guard(["dashboard.read"]) ??
          json(200, {
            items: [
              (({ versions_full: _f, activations: _a, ...x }) => x)(this.skillDetail()),
              { skill_id: "concierge.home", agent_id: "concierge", title: "Консьерж: главная", critical: true, code_managed: false, active: { version: 1, activation_id: "b0b0b0b0-1111-4222-8333-0000000000a1", since: F.iso(-9 * 86_400_000) }, versions: [{ version: 1, status: "PUBLISHED" }] },
              { skill_id: "event.extract", agent_id: "discovery", title: "Извлечение событий", critical: false, code_managed: true, active: null, versions: [] },
              { skill_id: "news.summarize", agent_id: "news", title: "Сводка новостей", critical: false, code_managed: true, active: null, versions: [] },
            ],
            next_cursor: null,
          })
        );
      case key === "GET /skills/concierge.event":
        return guard(["dashboard.read"]) ?? json(200, this.skillDetail());
      case key === "GET /skills/concierge.event/compare": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        const a = this.skill.versions.find((v) => v.version === Number(q.get("a")))!;
        const b = this.skill.versions.find((v) => v.version === Number(q.get("b")))!;
        const al = a.artifact.system_instruction.split("\n");
        const bl = b.artifact.system_instruction.split("\n");
        const diff: Array<{ op: "equal" | "delete" | "insert"; a: number | null; b: number | null; text: string }> = [];
        al.forEach((t, i) => diff.push(bl.includes(t) ? { op: "equal", a: i + 1, b: bl.indexOf(t) + 1, text: t } : { op: "delete", a: i + 1, b: null, text: t }));
        bl.forEach((t, j) => !al.includes(t) && diff.push({ op: "insert", a: null, b: j + 1, text: t }));
        const fields = (["allowed_tools", "limits", "confidence", "change_note"] as const)
          .filter((k) => JSON.stringify(a.artifact[k]) !== JSON.stringify(b.artifact[k]))
          .map((k) => ({ field: k, a: JSON.stringify(a.artifact[k]), b: JSON.stringify(b.artifact[k]) }));
        const lr = (v: typeof a) => (this.runs7.size && v.last_run ? { run_id: v.last_run.run_id, status: "done" as const, totals: this.runs7.get(v.last_run.run_id)?.totals ?? null, at: v.last_run.at ?? F.iso(0) } : null);
        return json(200, { skill_id: "concierge.event", a: { version: a.version, status: a.status, artifact_hash: a.artifact_hash, last_run: lr(a) }, b: { version: b.version, status: b.status, artifact_hash: b.artifact_hash, last_run: lr(b) }, instruction_diff: diff, fields, runs: [] });
      }
      case !!(m = path.match(/^\/skills\/concierge\.event\/versions\/(\d+)$/)): {
        const v = this.skill.versions.find((x) => x.version === Number(m![1]));
        if (method === "GET") return guard(["dashboard.read"]) ?? (v ? json(200, this.named(v)) : err(404, "SKILL_VERSION_NOT_FOUND"));
        const g = guard(["skills.edit"]);
        if (g) return g;
        if (!v) return err(404, "SKILL_VERSION_NOT_FOUND");
        if (v.status === "PUBLISHED" || v.status === "DEPRECATED") return err(409, "SKILL_VERSION_IMMUTABLE");
        if (Number(body.expected_version) !== v.version_row) return err(409, "VERSION_CONFLICT");
        const { expected_version: _e, ...changes } = body as Record<string, unknown>;
        Object.assign(v.artifact, changes);
        Object.assign(v, { status: "DRAFT", review: null, version_row: v.version_row + 1, updated_at: F.iso(0), artifact_hash: (v.version_row + 1).toString(16).repeat(64).slice(0, 64), last_run: v.last_run ? { ...v.last_run, current: false } : null });
        return json(200, this.named(v));
      }
      case key === "POST /skills/concierge.event/versions": {
        const g = guard(["skills.edit"]);
        if (g) return g;
        if (this.skill.versions.some((v) => ["DRAFT", "TESTED", "REVIEW"].includes(v.status))) return err(409, "SKILL_DRAFT_EXISTS");
        const from = this.skill.versions.find((v) => v.version === Number(body.from_version)) ?? this.skill.versions[this.skill.versions.length - 1]!;
        const n = Math.max(...this.skill.versions.map((v) => v.version)) + 1;
        const v = { ...JSON.parse(JSON.stringify(from)), version: n, status: "DRAFT", author: me.staff_id, reviewer: null, review: null, last_run: null, from_version: from.version, created_at: F.iso(0), updated_at: F.iso(0), published_at: null, version_row: 1 };
        v.artifact = { ...v.artifact, version: n, author: me.staff_id, reviewer: null, effective_from: null, change_note: null };
        this.skill.versions.push(v);
        return json(201, this.named(v));
      }
      case !!(m = path.match(/^\/skills\/concierge\.event\/versions\/(\d+)\/(test|review|publish|deprecate)$/)) && method === "POST": {
        const v = this.skill.versions.find((x) => x.version === Number(m![1]));
        if (!v) return err(404, "SKILL_VERSION_NOT_FOUND");
        const act = m![2]!;
        if (act === "test") {
          const g = guard(["skills.edit"]);
          if (g) return g;
          const r = { ...A.run(v.version, body.compare_version ? Number(body.compare_version) : null, me.staff_id, !!this.sc.runFails), artifact_hash: v.artifact_hash };
          this.runs7.set(r.run_id, { ...r, status: "running" });
          setTimeout(() => {
            this.runs7.set(r.run_id, r);
            v.last_run = { run_id: r.run_id, passed: !this.sc.runFails, at: F.iso(0), current: true };
            if (!this.sc.runFails && v.status === "DRAFT") v.status = "TESTED";
          }, 1200);
          return json(202, { run_id: r.run_id, status: "queued", cases: 5 });
        }
        if (act === "review") {
          const a = String(body.action);
          const g = guard([a === "request" ? "skills.edit" : "skills.publish"]);
          if (g) return g;
          if (a === "request") {
            if (v.status !== "TESTED") return err(409, "SKILL_TRANSITION_INVALID");
            v.status = "REVIEW";
          } else {
            if (v.status !== "REVIEW") return err(409, "SKILL_TRANSITION_INVALID");
            if (a === "approve" && v.author === me.staff_id) return err(409, "SKILL_REVIEWER_IS_AUTHOR");
            v.review = { decision: a === "approve" ? "approved" : "rejected", comment: (body.comment as string) ?? null, at: F.iso(0) };
            v.reviewer = me.staff_id;
            v.artifact.reviewer = me.staff_id;
            if (a === "reject") v.status = "DRAFT";
          }
          return json(200, this.named(v));
        }
        if (act === "publish") {
          const g = guard(["skills.publish"], true);
          if (g) return g;
          if (v.status !== "REVIEW" || v.review?.decision !== "approved") return err(409, "SKILL_TRANSITION_INVALID");
          v.status = "PUBLISHED";
          v.published_at = F.iso(0);
          const activation = this.activate(v.version, "publish", me.staff_id, String(body.reason));
          v.artifact.effective_from = activation.effective_from;
          return json(200, this.named({ ...v, activation }));
        }
        const g = guard(["skills.publish"]);
        if (g) return g;
        if (this.skill.activations[this.skill.activations.length - 1]!.version === v.version) return err(409, "SKILL_TRANSITION_INVALID");
        v.status = "DEPRECATED";
        v.deprecated_at = F.iso(0);
        return json(200, this.named(v));
      }
      case key === "POST /skills/concierge.event/rollback": {
        const g = guard(["skills.publish", "ops.kill_switch"], true);
        if (g) return g;
        const v = this.skill.versions.find((x) => x.version === Number(body.to_version));
        const cur = this.skill.activations[this.skill.activations.length - 1]!.version;
        if (!v || v.status !== "PUBLISHED" || v.version === cur) return err(409, "SKILL_ROLLBACK_TARGET_INVALID");
        const activation = this.activate(v.version, "rollback", me.staff_id, String(body.reason));
        return json(200, this.named({ skill_id: "concierge.event", from_version: cur, to_version: v.version, activation, cancelled_activations: [], message: null }));
      }
      case !!(m = path.match(/^\/evaluation\/runs\/([0-9a-f-]{36})$/)) && method === "GET": {
        const g = guard(["dashboard.read"]);
        if (g) return g;
        const r = this.runs7.get(m![1]!);
        return r ? json(200, this.named(r)) : err(404, "NOT_FOUND");
      }
      case key === "GET /evaluation/cases":
        return guard(["dashboard.read"]) ?? json(200, { items: q.get("skill_id") === "concierge.event" ? A.cases() : [] });

      case key === "POST /billing/payments/p1/refunds":
        return guard(["billing.refund"]) ?? err(501, "BILLING_NOT_AVAILABLE");
    }
    return err(404, "NOT_FOUND");
  }

  private statusOf(app: ConfigApp, v: string): ConfigVersion["status"] {
    return v === this.current[app] ? "current" : v === this.previous[app] ? "previous" : null;
  }

  private stats() {
    const open = this.tickets.filter((t) => ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"].includes(t.status));
    return {
      open: open.length,
      in_progress: open.filter((t) => t.status === "IN_PROGRESS").length,
      waiting_customer: open.filter((t) => t.status === "WAITING_CUSTOMER").length,
      breached: open.filter((t) => t.sla_state === "breached").length,
      avg_first_response_minutes: 12.5,
      avg_resolution_minutes: 220,
    };
  }

  private withUser(t: StaffTicket, perms: Set<Permission>): StaffTicket {
    return { ...t, user: perms.has("users.read") ? t.user : null };
  }

  private setStatus(t: StaffTicket, to: TicketStatus, by: Staff): void {
    t.status_history.push({ from_status: t.status, status: to, at: F.iso(0), changed_by: "staff", actor_id: by.staff_id });
    t.messages.push(F.msg("system", `${t.status} → ${to}`, 0));
    t.status = to;
    t.sla_paused = to === "WAITING_CUSTOMER";
    if (to === "RESOLVED" || to === "CLOSED") {
      t.sla_target = null;
      t.sla_due_at = null;
    }
    this.record("ticket.status", "ticket", t.ticket_id, { status: to });
  }

  private apply = new Map<string, () => void>();
  private approval(kind: Approval["kind"], summary: Record<string, unknown>, reason: string, by: Staff, apply?: () => void, noWaive = false): Approval {
    const supers = noWaive ? Infinity : this.accounts.filter((a) => a.staff.role === "super_admin" && a.staff.status === "ACTIVE").length;
    const a: Approval = {
      approval_id: `4a000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
      kind,
      status: supers <= 1 ? "APPLIED" : "PENDING",
      summary,
      reason,
      requested_by: { staff_id: by.staff_id, email: by.email, display_name: by.display_name, role: by.role },
      requested_at: F.iso(0),
      decided_by: null,
      decided_at: null,
      decision_note: null,
      waived: supers <= 1 ? "single_super_admin" : null,
      expires_at: F.iso(72 * 3_600_000),
    };
    if (a.waived) apply?.();
    else if (apply) this.apply.set(a.approval_id, apply);
    this.approvals.unshift(a);
    return a;
  }

  /** a pending request authored by the second super admin (for the approve test) */
  seedApproval(): Approval {
    const other = this.staffById(F.ID.admin2)!;
    return this.approval("role.permissions_change", { role: "support", added: ["export.csv"], removed: [] }, "Выгрузка очереди для отчёта SEC-120", other, () => this.matrix.support.push("export.csv"));
  }
}

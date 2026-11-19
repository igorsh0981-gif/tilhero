import type { Page, Route } from "@playwright/test";
import type {
  AdminLearnerRow,
  Approval,
  AuditRecord,
  Campaign,
  CampaignContent,
  ConfigActivation,
  ConfigApp,
  ConfigVersion,
  Dashboard,
  ErrorBody,
  LoginStep,
  Me,
  Permission,
  ReleaseNoteContent,
  RoleCode,
  Staff,
  StaffReleaseNote,
  StaffTicket,
  TemplateInfo,
  TemplateTexts,
  TemplateVersion,
  TicketStatus,
  UiLang,
} from "@tilhero/contracts/admin";
import type { Ticket as ClientTicket } from "@tilhero/contracts/bff";
import * as F from "./data";
import { ContentStore } from "./content-bff";
import { AiStore, type AiScenario } from "./ai-bff";
import * as CD from "./content-data";

export interface Scenario {
  /** start with a live cookie session of this account (skips the sign-in screen) */
  signedInAs?: string;
  env?: Me["env"];
  /** idle timeout of the session (admin-bff default 1800 s) */
  idleSeconds?: number;
  /** answer 403 PERMISSION_DENIED for these "METHOD /path" keys even when the role has the permission */
  deny?: Record<string, Permission>;
  /** only one active super_admin → four-eyes waived */
  singleSuperAdmin?: boolean;
  /** "METHOD /path": the first such request carries a session id already rotated in another tab → 409 SESSION_ROTATED */
  rotateOnce?: string;
  /** replace the permissions of a role */
  matrix?: Partial<Record<RoleCode, Permission[]>>;
  /** dashboard blocks whose source is down (available=false) */
  dashOff?: Array<"learners" | "support" | "whats_new" | "campaigns" | "content" | "diagnostics" | "lessons" | "ai">;
  /** sprint 4: AI spend, emergency stop, provider key, domains down in the session card */
  ai?: AiScenario;
  /** the audit log cannot be written: reveal → 503 AUDIT_UNAVAILABLE */
  auditDown?: boolean;
  /** no ADMIN_TEST_CHAT_IDS in notifications */
  noTestRecipients?: boolean;
  /** the admin config of experience-config is down (GET /experience/admin/current → 503) */
  adminConfigDown?: boolean;
  /** the active admin config switches these menu sections off */
  menuOff?: string[];
  /** campaign …0002 is sending but a step keeps failing (Campaign.last_error, review P2-7) */
  stalled?: boolean;
  /** the notifications clock runs ahead of the browser by this many ms (a valid chosen time is «in the past» there) */
  serverClockAheadMs?: number;
  /** the session store is down at sign-out: 503 SESSION_NOT_REVOKED (cookie cleared, session maybe alive — review T2-10) */
  logoutNotRevoked?: boolean;
  /** rewrites every successful JSON body (hostile strings) */
  transform?: (path: string, data: unknown) => unknown;
}

/** The mask of user-admin: first 2 and last 2 characters («ig•••81»), «•••» for short names; never with «@». */
export function maskUsername(u: string): string {
  return u.length > 4 ? `${u.slice(0, 2)}•••${u.slice(-2)}` : "•••";
}
function maskUsernames(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(maskUsernames);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "username" && typeof v === "string" ? maskUsername(v) : maskUsernames(v)]));
  return x;
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
const LIMITS = { title: 80, body: 1000, button: 32 } as const;
const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Server-side text check of notifications (domain/texts.py) — only what the e2e scenarios need. */
function checkTexts(texts: TemplateTexts | undefined, allowed: string[]): Array<{ path: string; reason: string }> {
  const out: Array<{ path: string; reason: string }> = [];
  for (const l of ["ru", "uz"] as const) {
    for (const f of ["title", "body", "button"] as const) {
      const v = (texts?.[l]?.[f] ?? "").trim();
      const path = `texts.${l}.${f}`;
      if (!v) {
        if (f !== "button") out.push({ path, reason: "required" });
        continue;
      }
      if (v.length > LIMITS[f]) out.push({ path, reason: "too_long" });
      const names = [...v.replace(/\{\{|\}\}/g, "").matchAll(PLACEHOLDER)].map((m) => m[1]!);
      if (names.some((n) => !allowed.includes(n))) out.push({ path, reason: "unknown_placeholder" });
    }
  }
  return out;
}

const missingTranslations = (c: ReleaseNoteContent): string[] => {
  const out: string[] = [];
  for (const l of ["ru", "uz"] as const) if (!c.title?.[l]?.trim()) out.push(`title.${l}`);
  c.items?.forEach((it, i) => {
    for (const p of ["title", "text"] as const) for (const l of ["ru", "uz"] as const) if (!it[p]?.[l]?.trim()) out.push(`items[${i}].${p}.${l}`);
  });
  return out;
};

/**
 * Stateful mock of admin-bff for Playwright (page.route on /admin/v1/**): cookie-session semantics, CSRF check on every
 * non-GET, permission check per route (403 PERMISSION_DENIED), step-up window (403 STEP_UP_REQUIRED), login counters
 * and lock, four-eyes approvals, support state machine, experience-config activations, release notes, template
 * versions and campaigns. Paths and shapes — packages/contracts/src/admin.ts.
 */
export class MockBff {
  readonly requests: Recorded[] = [];
  readonly sc: Scenario;
  accounts = F.accounts();
  matrix: Record<RoleCode, Permission[]> = JSON.parse(JSON.stringify(F.MATRIX));
  learners: AdminLearnerRow[] = F.learners();
  tickets: StaffTicket[];
  audit: AuditRecord[] = F.auditRecords();
  approvals: Approval[] = [];
  sla = F.SLA_POLICIES();
  notes: StaffReleaseNote[] = F.releaseNotes();
  templates = F.templates();
  campaigns: Campaign[] = F.campaigns();
  content = new ContentStore();
  ai: AiStore;
  session: Session | null = null;
  versions: Record<ConfigApp, ConfigVersion[]>;
  activations: Record<ConfigApp, ConfigActivation[]>;
  current: Record<ConfigApp, string>;
  previous: Record<ConfigApp, string | null>;
  private failures = new Map<string, number>();
  private challenges = new Map<string, { staffId: string; step: string; tries: number }>();
  private enrolled = new Set<string>();
  private idem = new Map<string, unknown>();
  private seq = 0;
  private revoked = false;

  constructor(sc: Scenario = {}) {
    this.sc = sc;
    this.tickets = F.tickets(this.learners);
    this.ai = new AiStore(sc.ai ?? {});
    if (sc.singleSuperAdmin) this.accounts = this.accounts.filter((a) => a.staff.staff_id !== F.ID.admin2);
    if (sc.stalled) {
      const c = this.campaigns.find((x) => x.campaign_id === "e1000000-0000-4000-8000-000000000002")!;
      Object.assign(c, { status: "sending", started_at: F.iso(-50 * F.MIN), stats: { ...c.stats, created: 400, sent: 380 }, last_error: { code: "INVALID_CURSOR", since: F.iso(-40 * F.MIN), attempts: 8 } });
    }
    const ver = (app: ConfigApp, version: string, payload: Record<string, unknown>, note: string, daysAgo: number, by = "system:seed"): ConfigVersion => ({
      version_id: `c0000000-0000-4000-8000-${app === "admin" ? "1" : "2"}${version.replace(/\./g, "").padStart(11, "0")}`,
      app,
      version,
      checksum: `${app}${version}`.padEnd(64, "a"),
      change_note: note,
      created_by: by,
      created_at: F.iso(-daysAgo * F.DAY),
      status: null,
      payload,
    });
    this.versions = {
      miniapp: [ver("miniapp", "1.0.0", F.miniPayload("1.0.0"), "Тема «Тетрадь» 1.0: бумага в клетку, синяя ручка, главная с планом на сегодня", 2), ver("miniapp", "1.0.1", F.miniPayload("1.0.1", "#3B5BDB"), "Ручка чуть темнее для контраста", 1, "Тимур")],
      admin: [ver("admin", "1.0.0", F.adminPayload("1.0.0", { off: sc.menuOff }), "Админка 1.0: светлая тема, компактная плотность, все разделы меню", 2), ver("admin", "1.0.1", F.adminPayload("1.0.1", { density: "comfortable", off: ["content", "agents", "qa", "costs", "heroes", "game", "events", "langs"] }), "Только разделы спринта 2", 1, "Тимур")],
    };
    this.current = { miniapp: "1.0.0", admin: "1.0.0" };
    this.previous = { miniapp: null, admin: null };
    const act = (app: ConfigApp, version: string, reason: string): ConfigActivation => ({
      activation_id: `ac000000-0000-4000-8000-${app === "admin" ? "1" : "2"}${version.replace(/\./g, "").padStart(11, "0")}`,
      app,
      version,
      previous_version: null,
      kind: "activate",
      reason,
      activated_by: "system:seed",
      activated_at: F.iso(-2 * F.DAY),
    });
    this.activations = { miniapp: [act("miniapp", "1.0.0", "Первая версия TilHero")], admin: [act("admin", "1.0.0", "Первая версия админки TilHero")] };
    if (sc.signedInAs) this.session = this.newSession(this.account(sc.signedInAs)!.staff.staff_id);
    for (const [role, ps] of Object.entries(sc.matrix ?? {})) this.matrix[role as RoleCode] = [...ps!];
  }

  async install(page: Page): Promise<void> {
    await page.route(`**${PREFIX}/**`, (route) => this.handle(route));
  }

  calls(method: string, path: string | RegExp): Recorded[] {
    return this.requests.filter((r) => r.method === method && (typeof path === "string" ? r.path === path : path.test(r.path)));
  }

  /** server-side revocation: the next request answers 401 SESSION_REVOKED */
  revoke(): void {
    this.revoked = true;
  }

  /** the 5-minute step-up window is over: the next privileged command asks for a fresh code again */
  expireStepUp(): void {
    if (this.session) this.session.stepUpUntil = 0;
  }

  switchTo(email: string): void {
    this.session = this.newSession(this.account(email)!.staff.staff_id);
  }

  account(email: string) {
    return this.accounts.find((a) => a.staff.email === email);
  }
  staffById(id: string) {
    return this.accounts.find((a) => a.staff.staff_id === id)?.staff;
  }
  nameOf(id: string | null | undefined): string | null {
    return (id && this.staffById(id)?.display_name) || null;
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
        expires_at: F.iso(8 * F.HOUR),
        idle_timeout_seconds: this.sc.idleSeconds ?? 1800,
        step_up_until: this.session!.stepUpUntil > Date.now() ? new Date(this.session!.stepUpUntil).toISOString() : null,
      },
      csrf_token: this.session!.csrf,
      env: this.sc.env ?? "stage",
      impersonating: this.session!.impersonating,
    };
  }

  private challenge(staffId: string, step: string): string {
    const c = `ch-${++this.seq}-${Math.random().toString(36).slice(2, 10)}`;
    this.challenges.set(c, { staffId, step, tries: 5 });
    return c;
  }

  /** next sign-in step (must_change_password → mfa_enroll → mfa → done) */
  private nextStep(s: Staff, after: "password" | "password_change" | "mfa"): LoginStep {
    const priv = F.PRIVILEGED.includes(s.role);
    if (after === "password" && s.must_change_password) return { next: "password_change", challenge: this.challenge(s.staff_id, "password_change"), me: null };
    if ((after === "password" || after === "password_change") && priv && !s.mfa_enabled) return { next: "mfa_enroll", challenge: this.challenge(s.staff_id, "mfa_enroll"), me: null };
    if ((after === "password" || after === "password_change") && s.mfa_enabled) return { next: "mfa", challenge: this.challenge(s.staff_id, "mfa"), me: null };
    s.last_login_at = F.iso(0);
    this.session = this.newSession(s.staff_id);
    this.record("auth.login", "staff", s.staff_id, null);
    return { next: "done", challenge: null, me: this.me() };
  }

  record(action: string, object_type: string | null, object_id: string | null, after: Record<string, unknown> | null, reason: string | null = null): void {
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
    } as ClientTicket;
  }

  private dashboard(period: Dashboard["period"]): Dashboard {
    const off = new Set(this.sc.dashOff ?? []);
    const blk = <T,>(k: "learners" | "support" | "whats_new" | "campaigns" | "content" | "diagnostics" | "lessons" | "ai", svc: string, data: T) => (off.has(k) ? { available: false, data: null, service: svc } : { available: true, data });
    const ls = this.learners;
    const accounts = ls.filter((x) => x.kind === "account").length;
    const kids = ls.filter((x) => x.kind === "child").length;
    const open = this.tickets.filter((t) => !["RESOLVED", "CLOSED"].includes(t.status));
    const pub = this.notes.filter((n) => n.status === "published");
    const latest = pub[0];
    const sent = this.campaigns.reduce((a, c) => a + c.stats.sent, 0);
    return {
      period,
      generated_at: F.iso(0),
      learners: blk("learners", "user-admin", {
        total_accounts: accounts * 160,
        total_children: kids * 106,
        new_in_period: period === "today" ? 38 : period === "7d" ? 214 : 812,
        active_in_period: period === "today" ? 492 : period === "7d" ? 1284 : 1630,
        onboarding_completed_pct: 81.4,
        reminders_enabled_pct: 64.2,
        by_age_band: { "6-9": 120, "10-13": 92, "14-17": 188, "18+": 864, unknown: 20 },
        by_locale: { ru: 802, uz: 466, unknown: 16 },
      }),
      support: blk("support", "support", {
        open: open.length,
        in_progress: open.filter((t) => t.status === "IN_PROGRESS").length,
        waiting_customer: open.filter((t) => t.status === "WAITING_CUSTOMER").length,
        breached: open.filter((t) => t.sla_state === "breached").length,
        avg_first_response_minutes: 42,
        avg_resolution_minutes: 610,
      }),
      whats_new: blk("whats_new", "experience-config", {
        published: pub.length,
        drafts: this.notes.filter((n) => n.status === "draft").length,
        latest: latest ? { release_note_id: latest.release_note_id, slug: latest.slug, title: latest.title.ru, views_total: latest.views_total, published_at: latest.published_at! } : null,
      }),
      campaigns: blk("campaigns", "notifications", {
        scheduled: this.campaigns.filter((c) => c.status === "scheduled").length,
        sending: this.campaigns.filter((c) => c.status === "sending").length,
        sent_in_period: period === "today" ? 0 : sent,
        delivered_in_period: period === "today" ? 0 : sent - 34,
      }),
      content: blk("content", "catalog", this.content.summary()),
      diagnostics: blk("diagnostics", "diagnostics", (() => {
        const { dxStats } = CD;
        return dxStats(period);
      })()),
      lessons: blk("lessons", "lessons", this.ai.lessonStats(period)),
      ai: blk("ai", "ai-gateway", this.ai.summary("month")),
    };
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const path = decodeURIComponent(url.pathname.slice(PREFIX.length) || "/");
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
    // user-admin masks usernames by actor (review T2-3): without users.sensitive.read — «ma•••_k»
    const masked = (data: unknown): unknown => (/^\/(learners|support\/tickets)/.test(path) && this.session && !this.perms().includes("users.sensitive.read") ? maskUsernames(data) : data);
    const json = (status: number, data?: unknown, extra?: Record<string, string>) =>
      route.fulfill({ status, contentType: "application/json", body: data === undefined ? "" : JSON.stringify(status < 300 ? (tr ? tr(path, masked(data)) : masked(data)) : data), ...(extra ? { headers: extra } : {}) });
    const err = (status: number, code: string, details: Record<string, unknown> = {}) => json(status, { code, message: code, trace_id: "e2e-trace-0001", details } satisfies ErrorBody);

    const isAuth = /^\/auth\/(login|mfa|password|logout)/.test(path) && !(path === "/auth/password" && !body.challenge);
    /* ---------- sign-in flow (no session needed) ---------- */
    if (method === "POST" && path === "/auth/login") {
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
        const acc = this.accounts.find((a) => a.staff.staff_id === s.staff_id)!;
        if (pw.length < 12 || !/\d/.test(pw) || !/[a-zA-Z]/.test(pw) || pw === acc.password) return err(422, "PASSWORD_WEAK", { rules: ["length"] });
        this.challenges.delete(String(body.challenge));
        acc.password = pw;
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
    const key = `${method} ${path}`;
    const denied = this.sc.deny?.[key];
    if (denied) return err(403, "PERMISSION_DENIED", { permission: denied });
    const stepUpOk = () => this.session!.stepUpUntil > Date.now();
    const guard = (ps: Permission[], stepUp = false): Promise<void> | null => {
      if (!ps.some((p) => perms.has(p))) return err(403, "PERMISSION_DENIED", { permission: ps[0] });
      if (stepUp && !stepUpOk()) return err(403, "STEP_UP_REQUIRED", { permission: ps[0] });
      return null;
    };
    /** Idempotency-Key replay: the same key → the stored answer */
    const replay = (k: string | undefined): unknown => (k ? this.idem.get(`${path}:${k}`) : undefined);
    const remember = (k: string | undefined, v: unknown) => {
      if (k) this.idem.set(`${path}:${k}`, v);
    };
    const idemKey = headers["idempotency-key"];

    let m: RegExpMatchArray | null;
    switch (true) {
      case key === "GET /me":
        return json(200, this.me());
      case key === "POST /auth/logout":
        if (this.sc.logoutNotRevoked) return err(503, "SESSION_NOT_REVOKED", { service: "session-store" });
        this.record("auth.logout", "staff", me.staff_id, null);
        this.session = null;
        return json(204);
      case key === "POST /auth/step-up": {
        if (body.code !== F.TOTP) return err(401, "MFA_INVALID", { remaining: 4 });
        this.session.stepUpUntil = Date.now() + 5 * 60_000;
        this.record("auth.step_up", "staff", me.staff_id, null);
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

      /* ---------- dashboard ---------- */
      case key === "GET /dashboard":
        return guard(["dashboard.read"]) ?? json(200, this.dashboard((q.get("period") as Dashboard["period"]) ?? "today"));

      /* ---------- learners ---------- */
      case key === "GET /learners": {
        const g = guard(["users.read"]);
        if (g) return g;
        const qs = (q.get("q") ?? "").trim().toLowerCase();
        let items = this.learners.filter(
          (x) =>
            (!q.get("kind") || x.kind === q.get("kind")) &&
            (!q.get("age_band") || x.age_band === q.get("age_band")) &&
            (!q.get("status") || x.status === q.get("status")) &&
            (!q.get("locale") || x.locale === q.get("locale")) &&
            (q.get("has_open_tickets") !== "true" || x.open_tickets > 0),
        );
        if (qs) {
          const tck = /^tck-\d+$/i.test(qs) && perms.has("support.read") ? this.ticketBy(qs.toUpperCase())?.user_id : null;
          items = items.filter((x) => x.user_id === qs || x.user_id === tck || (x.username && `@${x.username}`.includes(qs.startsWith("@") ? qs : `@${qs}`)) || (x.display_name ?? "").toLowerCase().includes(qs));
        }
        return json(200, { items, next_cursor: null });
      }
      case !!(m = path.match(/^\/learners\/([0-9a-f-]{36})$/)) && method === "GET": {
        const g = guard(["users.read"]);
        if (g) return g;
        const tickets = perms.has("support.read")
          ? this.tickets.filter((t) => t.user_id === m![1]).map((t) => ({ ticket_id: t.ticket_id, number: t.number, status: t.status, category: t.category, subject: t.subject, created_at: t.created_at }))
          : null;
        const c = F.card(this.learners, m![1]!, tickets);
        return c ? json(200, c) : err(404, "LEARNER_NOT_FOUND");
      }
      case !!(m = path.match(/^\/learners\/([0-9a-f-]{36})\/reveal$/)) && method === "POST": {
        const g = guard(["users.sensitive.read"], true);
        if (g) return g;
        const reason = String(body.reason ?? "").trim();
        if (body.field !== "telegram_user_id" || reason.length < 5 || reason.length > 300) return err(422, "VALIDATION_ERROR", { in: "body", field: "reason", errors: [] });
        const l = this.learners.find((x) => x.user_id === m![1]);
        if (!l) return err(404, "LEARNER_NOT_FOUND");
        if (l.kind === "child") return err(409, "FIELD_NOT_AVAILABLE");
        if (this.sc.auditDown) return err(503, "AUDIT_UNAVAILABLE", { service: "audit" });
        this.record("sensitive.view", "learner", l.user_id, { field: "telegram_user_id" }, reason);
        return json(200, { field: "telegram_user_id", value: F.TELEGRAM_IDS[l.user_id] ?? "5000000000", expires_in: 60 });
      }

      /* ---------- support ---------- */
      case key === "GET /support/stats": {
        const g = guard(["support.read", "dashboard.read"]);
        if (g) return g;
        return json(200, this.dashboard("today").support.data);
      }
      case key === "GET /support/templates":
        return guard(["support.read"]) ?? json(200, { items: F.REPLY_TEMPLATES });
      case key === "GET /support/sla-policies":
        return guard(["support.read"]) ?? json(200, { items: this.sla });
      case key === "PUT /support/sla-policies": {
        const g = guard(["support.manage"]);
        if (g) return g;
        this.sla = (body.items as typeof this.sla).map((p) => ({ ...p, updated_at: F.iso(0), updated_by: me.staff_id }));
        this.record("sla.change", "ticket", null, null, String(body.reason ?? ""));
        return json(200, { items: this.sla });
      }
      case key === "GET /support/tickets": {
        const g = guard(["support.read"]);
        if (g) return g;
        const st = q.get("status");
        let items = this.tickets.filter((t) => (st === "open" || !st ? !["RESOLVED", "CLOSED"].includes(t.status) : st === "all" ? true : t.status === st));
        if (q.get("category")) items = items.filter((t) => t.category === q.get("category"));
        if (q.get("priority")) items = items.filter((t) => t.priority === q.get("priority"));
        if (q.get("user_id")) items = items.filter((t) => t.user_id === q.get("user_id"));
        const a = q.get("assignee");
        if (a === "me") items = items.filter((t) => t.assignee_id === me.staff_id);
        else if (a === "none") items = items.filter((t) => !t.assignee_id);
        else if (a) items = items.filter((t) => t.assignee_id === a);
        const sla = q.get("sla");
        if (sla) items = items.filter((t) => t.sla_state === sla);
        return json(200, { items: items.map(({ messages: _m, status_history: _h, escalations: _e, context: _c, learner: _l, ...rest }) => rest), next_cursor: null });
      }
      case !!(m = path.match(/^\/support\/tickets\/([^/]+)\/client-view$/)) && method === "GET": {
        const g = guard(["support.read"]);
        if (g) return g;
        const t = this.ticketBy(m![1]!);
        return t ? json(200, this.clientView(t)) : err(404, "SUPPORT_TICKET_NOT_FOUND");
      }
      case !!(m = path.match(/^\/support\/tickets\/([^/]+)$/)) && method === "GET": {
        const g = guard(["support.read"]);
        if (g) return g;
        const t = this.ticketBy(m![1]!);
        return t ? json(200, t) : err(404, "SUPPORT_TICKET_NOT_FOUND");
      }
      case !!(m = path.match(/^\/support\/tickets\/([^/]+)\/messages$/)) && method === "POST": {
        const g = guard(["support.reply"]);
        if (g) return g;
        if (!idemKey) return err(422, "IDEMPOTENCY_KEY_REQUIRED");
        const seen = replay(idemKey);
        if (seen) return json(200, seen);
        const t = this.ticketBy(m![1]!);
        if (!t) return err(404, "SUPPORT_TICKET_NOT_FOUND");
        if (t.status === "CLOSED") return err(409, "SUPPORT_TICKET_CLOSED");
        const vis = body.visibility === "internal" ? "internal" : "public";
        t.messages.push({ message_id: `c1000000-0000-4000-8000-${String(900 + ++this.seq).padStart(12, "0")}`, sender_type: "operator", visibility: vis, author_id: me.staff_id, author_name: me.display_name, text: String(body.text ?? ""), created_at: F.iso(0) });
        if (vis === "public" && !t.first_response_at) t.first_response_at = F.iso(0);
        this.record(vis === "internal" ? "ticket.note" : "ticket.reply", "ticket", t.ticket_id, null);
        remember(idemKey, t);
        return json(200, t);
      }
      case !!(m = path.match(/^\/support\/tickets\/([^/]+)\/take$/)) && method === "POST": {
        const g = guard(["support.reply"]);
        if (g) return g;
        const t = this.ticketBy(m![1]!);
        if (!t) return err(404, "SUPPORT_TICKET_NOT_FOUND");
        t.assignee_id = me.staff_id;
        t.assignee_name = me.display_name;
        if (t.status === "NEW") {
          t.status_history.push({ from_status: t.status, status: "IN_PROGRESS", at: F.iso(0), changed_by: "staff", actor_id: me.staff_id });
          t.status = "IN_PROGRESS";
        }
        this.record("ticket.take", "ticket", t.ticket_id, null);
        return json(200, t);
      }
      case !!(m = path.match(/^\/support\/tickets\/([^/]+)\/escalations$/)) && method === "POST": {
        const g = guard(["support.reply"]);
        if (g) return g;
        const t = this.ticketBy(m![1]!);
        if (!t) return err(404, "SUPPORT_TICKET_NOT_FOUND");
        const e = { escalation_id: `ec000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`, type: body.type as StaffTicket["escalations"][number]["type"], note: String(body.note ?? ""), status: "OPEN", created_by: me.staff_id, created_at: F.iso(0) };
        t.escalations.push(e);
        this.record("ticket.escalate", "ticket", t.ticket_id, { type: e.type });
        return json(201, e);
      }
      case !!(m = path.match(/^\/support\/tickets\/([^/]+)$/)) && method === "PATCH": {
        const g = guard(["support.reply"]);
        if (g) return g;
        const t = this.ticketBy(m![1]!);
        if (!t) return err(404, "SUPPORT_TICKET_NOT_FOUND");
        if (typeof body.status === "string") {
          const to = body.status as TicketStatus;
          if (!STAFF_TRANSITIONS[t.status].includes(to)) return err(409, "SUPPORT_INVALID_TRANSITION", { from: t.status, to });
          t.status_history.push({ from_status: t.status, status: to, at: F.iso(0), changed_by: "staff", actor_id: me.staff_id });
          t.status = to;
          if (to === "RESOLVED") t.resolved_at = F.iso(0);
        }
        if (typeof body.priority === "string") t.priority = body.priority as StaffTicket["priority"];
        if ("assignee_id" in body) {
          t.assignee_id = (body.assignee_id as string | null) ?? null;
          t.assignee_name = this.nameOf(t.assignee_id);
        }
        return json(200, t);
      }

      /* ---------- staff, roles, approvals ---------- */
      case key === "GET /staff": {
        const g = guard(["staff.manage", "roles.manage"]);
        if (g) return g;
        const qs = (q.get("q") ?? "").toLowerCase();
        const items = this.accounts
          .map((a) => a.staff)
          .filter((s) => (!qs || s.email.includes(qs) || s.display_name.toLowerCase().includes(qs)) && (!q.get("role") || s.role === q.get("role")) && (!q.get("status") || s.status === q.get("status")));
        return json(200, { items, next_cursor: null });
      }
      case key === "POST /staff": {
        const g = guard(["staff.manage"], true);
        if (g) return g;
        const email = String(body.email ?? "").toLowerCase();
        if (this.account(email)) return err(409, "STAFF_EMAIL_EXISTS");
        const role = body.role as RoleCode;
        const priv = F.PRIVILEGED.includes(role);
        const s: Staff = { staff_id: `0b6c3e1a-7d2f-4f0e-9a51-${String(100 + ++this.seq).padStart(12, "0")}`, email, display_name: String(body.display_name), role: priv && !this.sc.singleSuperAdmin ? "read_only" : role, status: "ACTIVE", mfa_enabled: false, must_change_password: true, last_login_at: null, created_at: F.iso(0), created_by: me.staff_id };
        this.accounts.push({ staff: s, password: "Temp-Pass-9999" });
        this.record("staff.created", "staff", s.staff_id, { role });
        if (!priv) return json(201, { staff: s, temporary_password: "Temp-Pass-9999", approval: null });
        // privileged: four-eyes; the password goes to the APPROVER (waived — to the single super_admin himself)
        const a = this.newApproval("staff.create_privileged", { staff: this.ref(s), role }, "", me, this.sc.singleSuperAdmin);
        return json(201, { staff: s, temporary_password: this.sc.singleSuperAdmin ? "Temp-Pass-9999" : null, approval: a });
      }
      case !!(m = path.match(/^\/staff\/([0-9a-f-]{36})$/)) && method === "PATCH": {
        const g = guard(["staff.manage"], true);
        if (g) return g;
        const s = this.staffById(m![1]!);
        if (!s) return err(404, "STAFF_NOT_FOUND");
        if (s.staff_id === me.staff_id) return err(409, "SELF_ACTION");
        const why = String(body.reason ?? "");
        // re-enabling a privileged account (P2-2) and granting a privileged role (P2-1) — requests, not changes
        // the single super_admin: applied at once (waived) — new credentials of the target come back to him once
        const waived = !!this.sc.singleSuperAdmin;
        const pendingReply = (a: Approval) => {
          if (waived) Object.assign(s, { status: "ACTIVE", role: (a.summary as { to_role?: RoleCode }).to_role ?? s.role, mfa_enabled: false, must_change_password: true });
          return json(202, waived ? { approval: a, temporary_password: "Temp-Pass-5555" } : { approval: a });
        };
        if (body.status === "ACTIVE" && s.status === "DISABLED" && F.PRIVILEGED.includes(s.role))
          return pendingReply(this.newApproval("staff.reactivate_privileged", { staff: this.ref(s), role: s.role, to_role: null, from_status: s.status }, why, me, waived));
        if (typeof body.role === "string" && body.role !== s.role && F.PRIVILEGED.includes(body.role as RoleCode))
          return pendingReply(this.newApproval("staff.role_grant", { staff: this.ref(s), from_role: s.role, to_role: body.role }, why, me, waived));
        if (typeof body.status === "string") s.status = body.status as Staff["status"];
        if (typeof body.role === "string") s.role = body.role as RoleCode;
        if (typeof body.display_name === "string") s.display_name = body.display_name;
        this.record("staff.updated", "staff", s.staff_id, { role: s.role, status: s.status }, String(body.reason ?? ""));
        return json(200, s);
      }
      case !!(m = path.match(/^\/staff\/([0-9a-f-]{36})\/reset-(password|mfa)$/)) && method === "POST": {
        const g = guard(["staff.manage"], true);
        if (g) return g;
        const s = this.staffById(m![1]!);
        if (!s) return err(404, "STAFF_NOT_FOUND");
        if (m![2] === "mfa") {
          s.mfa_enabled = false;
          this.record("staff.mfa_reset", "staff", s.staff_id, null, String(body.reason ?? ""));
          return json(200, s);
        }
        s.must_change_password = true;
        this.record("staff.password_reset", "staff", s.staff_id, null, String(body.reason ?? ""));
        return json(200, { temporary_password: "Temp-Pass-7777" });
      }
      case key === "GET /roles":
        return guard(["staff.manage", "roles.manage"]) ?? json(200, { items: F.roles(this.matrix, this.accounts) });
      case !!(m = path.match(/^\/roles\/([a-z_]+)$/)) && method === "PUT": {
        const g = guard(["roles.manage"], true);
        if (g) return g;
        const a: Approval = {
          approval_id: `ap000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
          kind: "role.permissions_change",
          status: "PENDING",
          summary: { role: m![1], permissions: body.permissions },
          reason: String(body.reason ?? ""),
          requested_by: { staff_id: me.staff_id, email: me.email, display_name: me.display_name, role: me.role },
          requested_at: F.iso(0),
          decided_by: null,
          decided_at: null,
          decision_note: null,
          waived: null,
          expires_at: F.iso(72 * F.HOUR),
        };
        this.approvals.unshift(a);
        this.record("role.permissions_requested", "role", m![1]!, null, a.reason);
        return json(202, { approval: a });
      }
      case key === "GET /approvals": {
        const g = guard(["staff.manage", "roles.manage"]);
        if (g) return g;
        const st = q.get("status");
        return json(200, { items: this.approvals.filter((a) => !st || a.status === st), next_cursor: null });
      }
      case !!(m = path.match(/^\/approvals\/([^/]+)\/(approve|reject)$/)) && method === "POST": {
        const g = guard(["roles.manage", "staff.manage"], true);
        if (g) return g;
        const a = this.approvals.find((x) => x.approval_id === m![1]);
        if (!a) return err(404, "APPROVAL_NOT_FOUND");
        if (a.requested_by.staff_id === me.staff_id) return err(409, "FOUR_EYES_SAME_PERSON");
        a.status = m![2] === "approve" ? "APPLIED" : "REJECTED";
        a.decided_by = { staff_id: me.staff_id, email: me.email, display_name: me.display_name, role: me.role };
        a.decided_at = F.iso(0);
        a.decision_note = String(body.note ?? "");
        if (a.status === "APPLIED" && a.kind === "role.permissions_change") this.matrix[(a.summary as { role: RoleCode }).role] = (a.summary as { permissions: Permission[] }).permissions;
        this.record(`approval.${m![2] === "approve" ? "approved" : "rejected"}`, "approval", a.approval_id, null, a.decision_note);
        if (a.status === "APPLIED" && a.kind !== "role.permissions_change" && a.kind !== "staff.privileged_revoke") {
          const sum = a.summary as { staff?: { staff_id?: string }; role?: RoleCode; to_role?: RoleCode; action?: string };
          const t = this.staffById(sum.staff?.staff_id ?? "");
          if (t && a.kind !== "staff.privileged_reset") Object.assign(t, { role: sum.to_role ?? sum.role ?? t.role, status: "ACTIVE", mfa_enabled: false, must_change_password: true });
          // the new credentials of the target go to the approver, once (ApprovalDecision.temporary_password)
          if (a.kind !== "staff.privileged_reset" || sum.action !== "mfa") return json(200, { ...a, temporary_password: "Temp-Pass-5555" });
        }
        return json(200, a);
      }

      /* ---------- audit ---------- */
      case key === "GET /audit/records": {
        const g = guard(["audit.read"]);
        if (g) return g;
        const items = this.audit.filter((r) => (!q.get("action") || r.action === q.get("action")) && (!q.get("actor_id") || r.actor_id === q.get("actor_id")) && (!q.get("object_type") || r.object_type === q.get("object_type")) && (!q.get("object_id") || r.object_id === q.get("object_id")));
        return json(200, { items, next_cursor: null });
      }
      case !!(m = path.match(/^\/audit\/records\/([^/]+)$/)) && method === "GET": {
        const g = guard(["audit.read"]);
        if (g) return g;
        const r = this.audit.find((x) => x.record_id === m![1]);
        return r ? json(200, r) : err(404, "NOT_FOUND");
      }
      case key === "GET /audit/verify":
        return guard(["audit.read"]) ?? json(200, { valid: true, checked: this.audit.length, first_seq: this.audit[this.audit.length - 1]!.seq, last_seq: this.audit[0]!.seq, broken_at_seq: null });

      /* ---------- experience config ---------- */
      case key === "GET /experience/admin/current": {
        if (this.sc.adminConfigDown) return err(503, "UPSTREAM_UNAVAILABLE", { service: "experience-config" });
        const v = this.versions.admin.find((x) => x.version === this.current.admin)!;
        return json(200, { app: "admin", version: v.version, ...(v.payload as Record<string, unknown>) });
      }
      case !!(m = path.match(/^\/experience\/(miniapp|admin)\/(state|versions|activations)$/)) && method === "GET": {
        const g = guard(["config.read"]);
        if (g) return g;
        const app = m![1] as ConfigApp;
        if (m![2] === "state") return json(200, { app, current: this.activations[app][0] ?? null, previous_version: this.previous[app] });
        if (m![2] === "activations") return json(200, { items: this.activations[app], next_cursor: null });
        return json(200, { items: this.versions[app].map(({ payload: _p, ...v }) => ({ ...v, status: v.version === this.current[app] ? "current" : v.version === this.previous[app] ? "previous" : null })), next_cursor: null });
      }
      case !!(m = path.match(/^\/experience\/(miniapp|admin)\/versions\/([0-9.]+)$/)) && method === "GET": {
        const g = guard(["config.read"]);
        if (g) return g;
        const v = this.versions[m![1] as ConfigApp].find((x) => x.version === m![2]);
        return v ? json(200, v) : err(404, "EXPERIENCE_VERSION_NOT_FOUND");
      }
      case !!(m = path.match(/^\/experience\/(miniapp|admin)\/versions$/)) && method === "POST": {
        const g = guard(["config.edit"]);
        if (g) return g;
        const app = m![1] as ConfigApp;
        if (this.versions[app].some((x) => x.version === body.version)) return err(409, "EXPERIENCE_VERSION_EXISTS");
        const v: ConfigVersion = { version_id: `c0000000-0000-4000-8000-9${String(++this.seq).padStart(11, "0")}`, app, version: String(body.version), checksum: "b".repeat(64), change_note: String(body.change_note), created_by: me.display_name, created_at: F.iso(0), status: null, payload: body.payload as Record<string, unknown> };
        this.versions[app].push(v);
        this.record("config.create", "config", `${app}:${v.version}`, null);
        return json(201, v);
      }
      case !!(m = path.match(/^\/experience\/(miniapp|admin)\/(activate|rollback)$/)) && method === "POST": {
        const g = guard(["config.publish"], true);
        if (g) return g;
        const app = m![1] as ConfigApp;
        const to = m![2] === "rollback" ? this.previous[app] : String(body.version);
        if (!to) return err(409, "EXPERIENCE_NO_PREVIOUS");
        const a: ConfigActivation = { activation_id: `ac000000-0000-4000-8000-9${String(++this.seq).padStart(11, "0")}`, app, version: to, previous_version: this.current[app], kind: m![2] === "rollback" ? "rollback" : "activate", reason: String(body.reason ?? ""), activated_by: me.display_name, activated_at: F.iso(0) };
        this.previous[app] = this.current[app];
        this.current[app] = to;
        this.activations[app].unshift(a);
        this.record(`config.${a.kind}`, "config", `${app}:${to}`, null, a.reason);
        return json(201, a);
      }

      /* ---------- «Что нового» ---------- */
      case key === "GET /release-notes": {
        const g = guard(["whatsnew.manage"]);
        if (g) return g;
        const st = q.get("status");
        return json(200, { items: this.notes.filter((n) => !st || n.status === st), next_cursor: null });
      }
      case !!(m = path.match(/^\/release-notes\/([0-9a-f-]{36})\/stats$/)) && method === "GET": {
        const g = guard(["whatsnew.manage"]);
        if (g) return g;
        const n = this.notes.find((x) => x.release_note_id === m![1]);
        if (!n) return err(404, "RELEASE_NOTE_NOT_FOUND");
        const t = n.views_total;
        return json(200, { release_note_id: n.release_note_id, views_total: t, views_by_lang: { ru: Math.round(t * 0.62), uz: Math.round(t * 0.34) }, views_by_age: { kids: 0, teens: Math.round(t * 0.18), adults: Math.round(t * 0.78) }, first_view_at: t ? n.published_at : null, last_view_at: t ? F.iso(-2 * F.HOUR) : null });
      }
      case !!(m = path.match(/^\/release-notes\/([0-9a-f-]{36})$/)) && method === "GET": {
        const g = guard(["whatsnew.manage"]);
        if (g) return g;
        const n = this.notes.find((x) => x.release_note_id === m![1]);
        return n ? json(200, n) : err(404, "RELEASE_NOTE_NOT_FOUND");
      }
      case key === "POST /release-notes": {
        const g = guard(["whatsnew.manage"]);
        if (g) return g;
        const seen = replay(idemKey);
        if (seen) return json(201, seen);
        const c = body as unknown as ReleaseNoteContent;
        const miss = missingTranslations(c);
        if (miss.length) return err(422, "RELEASE_NOTE_TRANSLATION_MISSING", { missing: miss });
        if (this.notes.some((n) => n.slug === c.slug && n.status !== "archived")) return err(409, "RELEASE_NOTE_SLUG_EXISTS", { slug: c.slug });
        const n: StaffReleaseNote = { ...c, release_note_id: `d1000000-0000-4000-8000-${String(100 + ++this.seq).padStart(12, "0")}`, status: "draft", version: 1, created_by: me.staff_id, created_by_name: me.display_name, created_at: F.iso(0), updated_by: me.staff_id, updated_at: F.iso(0), published_by: null, published_by_name: null, published_at: null, archived_by: null, archived_at: null, views_total: 0 };
        this.notes.unshift(n);
        this.record("release_note.create", "release_note", n.release_note_id, { slug: n.slug });
        remember(idemKey, n);
        return json(201, n);
      }
      case !!(m = path.match(/^\/release-notes\/([0-9a-f-]{36})$/)) && method === "PUT": {
        const g = guard(["whatsnew.manage"]);
        if (g) return g;
        const n = this.notes.find((x) => x.release_note_id === m![1]);
        if (!n) return err(404, "RELEASE_NOTE_NOT_FOUND");
        if (n.status !== "draft") return err(409, "RELEASE_NOTE_NOT_DRAFT");
        if (body.expected_version !== n.version) return err(409, "RELEASE_NOTE_VERSION_CONFLICT", { current_version: n.version });
        const { expected_version: _v, ...c } = body as unknown as ReleaseNoteContent & { expected_version: number };
        const miss = missingTranslations(c);
        if (miss.length) return err(422, "RELEASE_NOTE_TRANSLATION_MISSING", { missing: miss });
        Object.assign(n, c, { version: n.version + 1, updated_by: me.staff_id, updated_at: F.iso(0) });
        this.record("release_note.update", "release_note", n.release_note_id, { version: n.version });
        return json(200, n);
      }
      case !!(m = path.match(/^\/release-notes\/([0-9a-f-]{36})\/(publish|archive)$/)) && method === "POST": {
        const g = guard(["whatsnew.publish"], true);
        if (g) return g;
        if (!idemKey) return err(422, "IDEMPOTENCY_KEY_REQUIRED");
        const seen = replay(idemKey);
        if (seen) return json(200, seen);
        const n = this.notes.find((x) => x.release_note_id === m![1]);
        if (!n) return err(404, "RELEASE_NOTE_NOT_FOUND");
        if (m![2] === "publish") {
          if (n.status === "published") return json(200, n);
          if (n.status !== "draft") return err(409, "RELEASE_NOTE_NOT_DRAFT");
          if (body.expected_version !== n.version) return err(409, "RELEASE_NOTE_VERSION_CONFLICT", { current_version: n.version });
          const miss = missingTranslations(n);
          if (miss.length) return err(422, "RELEASE_NOTE_TRANSLATION_MISSING", { missing: miss });
          Object.assign(n, { status: "published", published_by: me.staff_id, published_by_name: me.display_name, published_at: F.iso(0) });
        } else {
          if (n.status === "archived") return json(200, n);
          Object.assign(n, { status: "archived", archived_by: me.staff_id, archived_at: F.iso(0) });
        }
        this.record(`release_note.${m![2]}`, "release_note", n.release_note_id, { status: n.status }, String(body.reason ?? ""));
        remember(idemKey, n);
        return json(201, n);
      }

      /* ---------- notification templates ---------- */
      case key === "GET /notifications/test-recipients": {
        const g = guard(["notif.templates.manage", "notif.campaigns.manage"]);
        if (g) return g;
        return json(200, { items: this.sc.noTestRecipients ? [] : [{ index: 0, label: "Тестовый чат 1 (••••4821)" }, { index: 1, label: "Тестовый чат 2 (••••0937)" }] });
      }
      case key === "GET /notifications/templates": {
        const g = guard(["notif.templates.manage"]);
        if (g) return g;
        return json(200, { items: this.templates.map(({ versions: _v, ...t }) => t) });
      }
      case !!(m = path.match(/^\/notifications\/templates\/([a-z0-9_.]+)$/)) && method === "GET": {
        const g = guard(["notif.templates.manage"]);
        if (g) return g;
        const t = this.templates.find((x) => x.key === m![1]);
        return t ? json(200, t) : err(404, "TEMPLATE_NOT_FOUND");
      }
      case !!(m = path.match(/^\/notifications\/templates\/([a-z0-9_.]+)\/versions$/)) && method === "POST": {
        const g = guard(["notif.templates.manage"]);
        if (g) return g;
        const seen = replay(idemKey);
        if (seen) return json(201, seen);
        const t = this.templates.find((x) => x.key === m![1]);
        if (!t) return err(404, "TEMPLATE_NOT_FOUND");
        const fields = checkTexts(body.texts as TemplateTexts, t.placeholders.map((p) => p.name));
        if (fields.length) return err(422, "TEMPLATE_INVALID", { fields });
        const v: TemplateVersion = { key: t.key, version: (t.versions[0]?.version ?? 0) + 1, status: "draft", texts: body.texts as TemplateTexts, note: String(body.note ?? ""), created_by: me.staff_id, created_by_name: me.display_name, created_at: F.iso(0), activated_by: null, activated_by_name: null, activated_at: null };
        t.versions.unshift(v);
        t.updated_at = v.created_at;
        this.record("template.version_created", "notification_template", t.key, { version: v.version });
        remember(idemKey, v);
        return json(201, v);
      }
      case !!(m = path.match(/^\/notifications\/templates\/([a-z0-9_.]+)\/versions\/(\d+)\/(preview|activate|test)$/)) && method === "POST": {
        const t = this.templates.find((x) => x.key === m![1]);
        const v = t?.versions.find((x) => x.version === Number(m![2]));
        if (m![3] === "activate") {
          const g = guard(["notif.templates.manage"], true);
          if (g) return g;
          if (!t || !v) return err(404, "TEMPLATE_VERSION_NOT_FOUND");
          if (v.status === "active") return json(200, v);
          for (const x of t.versions) if (x.status === "active") x.status = "archived";
          Object.assign(v, { status: "active", activated_by: me.staff_id, activated_by_name: me.display_name, activated_at: F.iso(0) });
          t.active_version = v.version;
          t.active_since = v.activated_at;
          this.record("template.activated", "notification_template", t.key, { version: v.version }, String(body.reason ?? ""));
          return json(200, v);
        }
        const g = guard(["notif.templates.manage"]);
        if (g) return g;
        if (!t || !v) return err(404, "TEMPLATE_VERSION_NOT_FOUND");
        const lang = (body.lang as UiLang) ?? "ru";
        if (m![3] === "test") {
          if (this.sc.noTestRecipients || ![0, 1].includes(Number(body.recipient))) return err(422, "TEST_RECIPIENT_NOT_ALLOWED");
          this.record("template.test_sent", "notification_template", t.key, { version: v.version });
          return json(200, { sent: true, delivery_id: "f1000000-0000-4000-8000-000000000042", error: null });
        }
        const s = Object.fromEntries(t.placeholders.map((p) => [p.name, p.sample[lang]]));
        const sub = (x: string) => x.replace(/\{(\w+)\}/g, (_, n: string) => s[n] ?? "");
        const tx = v.texts[lang];
        return json(200, { lang, title: sub(tx.title), body: sub(tx.body), button: tx.button, telegram_text: `${sub(tx.title)}\n\n${sub(tx.body)}` });
      }
      case !!(m = path.match(/^\/notifications\/templates\/([a-z0-9_.]+)\/reset$/)) && method === "POST": {
        const g = guard(["notif.templates.manage"], true);
        if (g) return g;
        const t = this.templates.find((x) => x.key === m![1]);
        if (!t) return err(404, "TEMPLATE_NOT_FOUND");
        for (const x of t.versions) if (x.status === "active") x.status = "archived";
        t.active_version = null;
        t.active_since = null;
        this.record("template.reset", "notification_template", t.key, null, String(body.reason ?? ""));
        const { versions: _v, ...info } = t;
        return json(200, info as TemplateInfo);
      }

      /* ---------- campaigns ---------- */
      case key === "GET /notifications/campaigns": {
        const g = guard(["notif.campaigns.manage"]);
        if (g) return g;
        const st = q.get("status");
        return json(200, { items: this.campaigns.filter((c) => !st || c.status === st), next_cursor: null });
      }
      case key === "POST /notifications/campaigns": {
        const g = guard(["notif.campaigns.manage"]);
        if (g) return g;
        if (!idemKey) return err(422, "IDEMPOTENCY_KEY_REQUIRED");
        const seen = replay(idemKey);
        if (seen) return json(201, seen);
        const c = body as unknown as CampaignContent;
        const fields = checkTexts(c.texts, ["learner_name"]);
        if (fields.length) return err(422, "CAMPAIGN_INVALID", { fields });
        const x: Campaign = { ...c, campaign_id: `e1000000-0000-4000-8000-${String(100 + ++this.seq).padStart(12, "0")}`, status: "draft", version: 1, send_at: null, created_by: me.staff_id, created_by_name: me.display_name, created_at: F.iso(0), updated_at: F.iso(0), scheduled_by: null, scheduled_by_name: null, scheduled_at: null, started_at: null, finished_at: null, stopped_by: null, stopped_by_name: null, stopped_at: null, stop_reason: null, last_error: null, stats: { audience: 0, created: 0, sent: 0, in_app_only: 0, deferred: 0, skipped_frequency: 0, failed: 0 } };
        this.campaigns.unshift(x);
        this.record("campaign.created", "campaign", x.campaign_id, null);
        remember(idemKey, x);
        return json(201, x);
      }
      case !!(m = path.match(/^\/notifications\/campaigns\/([0-9a-f-]{36})$/)) && (method === "GET" || method === "PATCH"): {
        const g = guard(["notif.campaigns.manage"]);
        if (g) return g;
        const c = this.campaigns.find((x) => x.campaign_id === m![1]);
        if (!c) return err(404, "CAMPAIGN_NOT_FOUND");
        if (method === "GET") {
          // a scheduled campaign «starts» on the second look (the dispatcher runs every 5 min on the stand)
          return json(200, c);
        }
        if (c.status !== "draft") return err(409, "CAMPAIGN_NOT_DRAFT");
        if (body.expected_version !== c.version) return err(409, "CAMPAIGN_VERSION_CONFLICT", { current_version: c.version });
        const { expected_version: _v, ...patch } = body as unknown as Partial<CampaignContent> & { expected_version: number };
        if (patch.texts) {
          const fields = checkTexts(patch.texts, ["learner_name"]);
          if (fields.length) return err(422, "CAMPAIGN_INVALID", { fields });
        }
        Object.assign(c, patch, { version: c.version + 1, updated_at: F.iso(0) });
        this.record("campaign.updated", "campaign", c.campaign_id, null);
        return json(200, c);
      }
      case !!(m = path.match(/^\/notifications\/campaigns\/([0-9a-f-]{36})\/(estimate|preview|test|schedule|unschedule|stop)$/)) && method === "POST": {
        const c = this.campaigns.find((x) => x.campaign_id === m![1]);
        const action = m![2]!;
        const send = action === "schedule" || action === "unschedule" || action === "stop";
        const g = guard([send ? "notif.campaigns.send" : "notif.campaigns.manage"], action === "schedule" || action === "stop");
        if (g) return g;
        if (!c) return err(404, "CAMPAIGN_NOT_FOUND");
        if (action === "estimate") {
          const langs = c.segment.ui_lang?.length ? c.segment.ui_lang : ["ru", "uz"];
          const ru = langs.includes("ru") ? 1210 : 0;
          const uz = langs.includes("uz") ? 630 : 0;
          return json(200, { audience: ru + uz, by_lang: { ru, uz }, frequency_capped: 96, computed_at: F.iso(0) });
        }
        if (action === "preview") {
          const lang = (body.lang as UiLang) ?? "ru";
          const tx = c.texts[lang];
          const sub = (x: string) => x.replace(/\{learner_name\}/g, lang === "uz" ? "Madina" : "Мадина");
          return json(200, { lang, title: sub(tx.title), body: sub(tx.body), button: tx.button, telegram_text: `${sub(tx.title)}\n\n${sub(tx.body)}` });
        }
        if (action === "test") {
          if (this.sc.noTestRecipients || ![0, 1].includes(Number(body.recipient))) return err(422, "TEST_RECIPIENT_NOT_ALLOWED");
          this.record("campaign.test_sent", "campaign", c.campaign_id, null);
          return json(200, { sent: true, delivery_id: "f1000000-0000-4000-8000-000000000043", error: null });
        }
        if (action === "schedule") {
          if (!idemKey) return err(422, "IDEMPOTENCY_KEY_REQUIRED");
          const seen = replay(idemKey);
          if (seen) return json(200, seen);
          if (c.status !== "draft") return err(409, "CAMPAIGN_NOT_DRAFT");
          if (body.expected_version !== c.version) return err(409, "CAMPAIGN_VERSION_CONFLICT", { current_version: c.version });
          const now = Date.now() + (this.sc.serverClockAheadMs ?? 0);
          if (!("send_at" in body)) return err(422, "VALIDATION_ERROR", { in: "body", field: "send_at", errors: [] });
          const by = { scheduled_by: me.staff_id, scheduled_by_name: me.display_name, scheduled_at: new Date(now).toISOString() };
          if (body.send_at === null) {
            // «Отправить сейчас» (QA D2-03, review T2-11): server clock, started at once — the answer is already sending
            Object.assign(c, { ...by, status: "sending", version: c.version + 1, send_at: new Date(now).toISOString(), started_at: new Date(now).toISOString(), stats: { ...c.stats, audience: 1840 } });
          } else {
            const at = Date.parse(String(body.send_at));
            if (Number.isNaN(at)) return err(422, "VALIDATION_ERROR", { in: "body", field: "send_at", errors: [] });
            if (at > now + 30 * F.DAY) return err(422, "CAMPAIGN_INVALID", { fields: [{ path: "send_at", reason: "too_far" }] });
            if (at < now - 5 * 60_000) return err(422, "CAMPAIGN_INVALID", { fields: [{ path: "send_at", reason: "in_past" }] });
            Object.assign(c, { ...by, status: "scheduled", version: c.version + 1, send_at: new Date(at - now < 60_000 ? now : at).toISOString(), stats: { ...c.stats, audience: 1840 } });
          }
          this.record("campaign.scheduled", "campaign", c.campaign_id, null, String(body.reason ?? ""));
          remember(idemKey, c);
          return json(200, c);
        }
        if (action === "unschedule") {
          if (c.status === "sending") return err(409, "CAMPAIGN_ALREADY_SENDING");
          if (c.status !== "scheduled") return err(409, "CAMPAIGN_NOT_DRAFT");
          Object.assign(c, { status: "draft", version: c.version + 1, send_at: null });
          this.record("campaign.unscheduled", "campaign", c.campaign_id, null, String(body.reason ?? ""));
          return json(200, c);
        }
        // stop: emergency, idempotent; scheduled | sending | done (cancels what quiet hours deferred), never a draft
        if (c.status === "draft") return err(409, "CAMPAIGN_NOT_ACTIVE");
        if (c.status !== "stopped") {
          Object.assign(c, { status: "stopped", version: c.version + 1, stopped_by: me.staff_id, stopped_by_name: me.display_name, stopped_at: F.iso(0), stop_reason: String(body.reason ?? "") });
          this.record("campaign.stopped", "campaign", c.campaign_id, null, c.stop_reason);
        }
        return json(200, c);
      }

      default: {
        const ctx = {
          me,
          perms,
          stepUpOk,
          nameOf: (id: string | null | undefined) => this.nameOf(id),
          record: (a: string, t: string, id: string, after: Record<string, unknown> | null, reason?: string | null) => this.record(a, t, id, after, reason ?? null),
          json: (st: number, data?: unknown, extra?: Record<string, string>) => json(st, data, extra),
          err: (st: number, code: string, details?: Record<string, unknown>) => err(st, code, details),
          binary: (st: number, buf: Buffer, ct: string) => route.fulfill({ status: st, contentType: ct, body: buf, headers: { "Cache-Control": "private, max-age=3600" } }),
        };
        if (await this.ai.handle(method, path, body, q, idemKey, headers, ctx)) return;
        const done = await this.content.handle(method, path, body, q, idemKey, {
          me,
          perms,
          stepUpOk,
          nameOf: (id) => this.nameOf(id),
          record: (a, t, id, after, reason) => this.record(a, t, id, after, reason ?? null),
          json: (st, data, extra) => json(st, data, extra),
          err: (st, code, details) => err(st, code, details),
          binary: (st, buf, ct) => route.fulfill({ status: st, contentType: ct, body: buf, headers: { "Cache-Control": "private, max-age=3600" } }),
        });
        if (done) return;
        return err(404, "NOT_FOUND", { path });
      }
    }
  }

  private ref(s: Staff) {
    return { staff_id: s.staff_id, email: s.email, display_name: s.display_name };
  }

  private newApproval(kind: Approval["kind"], summary: Record<string, unknown>, reason: string, me: Staff, waived = false): Approval {
    const a: Approval = {
      approval_id: `ap000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
      kind,
      status: waived ? "APPLIED" : "PENDING",
      summary,
      reason,
      requested_by: { staff_id: me.staff_id, email: me.email, display_name: me.display_name, role: me.role },
      requested_at: F.iso(0),
      decided_by: null,
      decided_at: null,
      decision_note: null,
      waived: waived ? "single_super_admin" : null,
      expires_at: F.iso(72 * F.HOUR),
    };
    this.approvals.unshift(a);
    return a;
  }

  /** e2e helper: the dispatcher picked the campaign up (scheduled → sending with progress) */
  startSending(id: string): void {
    const c = this.campaigns.find((x) => x.campaign_id === id);
    if (c) Object.assign(c, { status: "sending", started_at: F.iso(0), stats: { ...c.stats, audience: 1840, created: 900, sent: 640, in_app_only: 61, deferred: 120, skipped_frequency: 44, failed: 3 } });
  }
}

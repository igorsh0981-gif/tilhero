/**
 * Fixture data of the mock admin-bff. Shapes follow packages/contracts/src/admin.ts; PII in fixtures is fake
 * and masked the way the real services mask it (telegram_id_masked).
 */
import type {
  AdminUserCard,
  AdminUserRow,
  AuditRecord,
  Dashboard,
  Permission,
  ReplyTemplate,
  Role,
  RoleCode,
  Staff,
  StaffTicket,
  StaffTicketMessage,
  TicketPriority,
  TicketStatus,
} from "@tilhero/contracts/admin";

export const ALL_PERMS: Permission[] = [
  "dashboard.read",
  "users.read",
  "users.sensitive.read",
  "ai.content.read",
  "export.csv",
  "support.read",
  "support.reply",
  "support.manage",
  "subscriptions.override",
  "billing.refund",
  "skills.edit",
  "skills.publish",
  "audit.read",
  "config.read",
  "config.edit",
  "config.publish",
  "ops.kill_switch",
  "staff.manage",
  "roles.manage",
  "events.review",
  "sources.manage",
  "discovery.manage",
  "news.manage",
  "users.access.manage",
  "ops.queues.manage",
];

/** Default matrix (docs/sprint2/INTERNAL_API.md, admin-identity seed; sprint 4 additions). */
export const MATRIX: Record<RoleCode, Permission[]> = {
  super_admin: [...ALL_PERMS],
  // sprint 4: operations + events.review, sources.manage, discovery.manage (docs/sprint4/INTERNAL_API.md §7)
  // sprint 6: + news.manage (docs/sprint6/INTERNAL_API.md §8)
  // sprint 7: + users.access.manage (admin-identity migration 0007)
  // sprint 8: + ops.queues.manage (admin-identity migration 0008)
  operations: ["dashboard.read", "users.read", "support.read", "config.read", "ops.kill_switch", "audit.read", "events.review", "sources.manage", "discovery.manage", "news.manage", "users.access.manage", "ops.queues.manage"],
  support: ["dashboard.read", "users.read", "support.read", "support.reply"],
  billing: ["dashboard.read", "users.read", "subscriptions.override", "billing.refund"],
  agent_manager: ["dashboard.read", "skills.edit"],
  analyst: ["dashboard.read", "users.read"],
  auditor: ["dashboard.read", "audit.read"],
  read_only: ["dashboard.read"],
};

const ROLE_NAMES: Record<RoleCode, { ru: string; en: string }> = {
  super_admin: { ru: "Super Admin", en: "Super Admin" },
  operations: { ru: "Operations", en: "Operations" },
  support: { ru: "Support", en: "Support" },
  billing: { ru: "Billing", en: "Billing" },
  agent_manager: { ru: "Agent Manager", en: "Agent Manager" },
  analyst: { ru: "Analyst", en: "Analyst" },
  auditor: { ru: "Auditor", en: "Auditor" },
  read_only: { ru: "Read Only", en: "Read Only" },
};
export const PRIVILEGED: RoleCode[] = ["super_admin", "operations", "billing", "agent_manager"];

export const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

export interface Account {
  staff: Staff;
  password: string;
}

export const ID = {
  admin: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a01",
  admin2: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a02",
  support: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a03",
  auditor: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a04",
  newbie: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a05",
  ops: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a06",
  contractor: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a07",
};

function staff(id: string, email: string, display_name: string, role: RoleCode, extra: Partial<Staff> = {}): Staff {
  return {
    staff_id: id,
    email,
    display_name,
    role,
    status: "ACTIVE",
    auth_provider: "local",
    mfa_enabled: PRIVILEGED.includes(role),
    must_change_password: false,
    last_login_at: iso(-2 * HOUR),
    created_at: iso(-40 * 24 * HOUR),
    created_by: ID.admin,
    ...extra,
  };
}

export const PASSWORD = "Correct-Horse-42";
export const TOTP = "123456";

export function accounts(): Account[] {
  return [
    { staff: staff(ID.admin, "admin@tilhero.local", "Admin Operator", "super_admin", { last_login_at: iso(-2 * MIN) }), password: PASSWORD },
    { staff: staff(ID.admin2, "security@tilhero.local", "Нодира", "super_admin", { last_login_at: iso(-43 * MIN) }), password: PASSWORD },
    { staff: staff(ID.support, "support@tilhero.local", "Алина", "support", { last_login_at: iso(-21 * MIN) }), password: PASSWORD },
    { staff: staff(ID.auditor, "audit@tilhero.local", "Бахтиёр", "auditor", { last_login_at: iso(-6 * 24 * HOUR) }), password: PASSWORD },
    { staff: staff(ID.newbie, "new.ops@tilhero.local", "Олег", "operations", { must_change_password: true, mfa_enabled: false, last_login_at: null }), password: "Temp-Password-2026-x" },
    { staff: staff(ID.ops, "ops@tilhero.local", "Тимур", "operations", { last_login_at: iso(-5 * HOUR) }), password: PASSWORD },
    { staff: staff(ID.contractor, "contractor@tilhero.local", "Сергей (подрядчик)", "support", { status: "DISABLED", last_login_at: iso(-19 * 24 * HOUR) }), password: PASSWORD },
  ];
}

export function roles(staffList: Staff[], matrix: Record<RoleCode, Permission[]>): Role[] {
  return (Object.keys(ROLE_NAMES) as RoleCode[]).map((code) => ({
    code,
    name: ROLE_NAMES[code],
    permissions: [...matrix[code]],
    privileged: PRIVILEGED.includes(code),
    staff_count: staffList.filter((s) => s.role === code).length,
    updated_at: iso(-3 * 24 * HOUR),
    updated_by: ID.admin,
  }));
}

/* ---------------------------------------------------------------- users */

export const USER = {
  igor: "5f1c2a3b-4d5e-4f60-8a71-92b3c4d5e601",
  maria: "5f1c2a3b-4d5e-4f60-8a71-92b3c4d5e602",
  aziza: "5f1c2a3b-4d5e-4f60-8a71-92b3c4d5e603",
  nomad: "5f1c2a3b-4d5e-4f60-8a71-92b3c4d5e604",
};
export const FULL_TG_ID = "918273645";

export function users(): AdminUserRow[] {
  const row = (user_id: string, username: string, display_name: string, locale: string, extra: Partial<AdminUserRow> = {}): AdminUserRow => ({
    user_id,
    username,
    display_name,
    telegram_id_masked: "••••••645",
    locale,
    status: "ACTIVE",
    onboarding_completed: true,
    open_tickets: 0,
    tickets_total: 0,
    created_at: iso(-30 * 24 * HOUR),
    last_seen_at: iso(-3 * HOUR),
    plan: "FREE",
    ...extra,
  });
  return [
    row(USER.igor, "igor_demo", "Игорь", "ru", { open_tickets: 1, tickets_total: 2 }),
    row(USER.maria, "maria_milano", "Maria", "en", { telegram_id_masked: "••••••112", open_tickets: 1, tickets_total: 1 }),
    row(USER.aziza, "aziza_events", "Азиза", "ru", { telegram_id_masked: "••••••907", onboarding_completed: false, open_tickets: 1, tickets_total: 1 }),
    row(USER.nomad, "nomad_tickets", "Nomad", "en", { telegram_id_masked: "••••••330", status: "DELETION_REQUESTED", last_seen_at: null }),
  ];
}

export function userCard(u: AdminUserRow, tickets: StaffTicket[]): AdminUserCard {
  return {
    ...u,
    consent: { policy_version: "1.0", purposes: ["service", "personalization"], accepted_at: iso(-30 * 24 * HOUR), age_confirmed_18_plus: true, revoked_at: null },
    security: { pin_enabled: true, biometric_enabled: false },
    preferences: { onboarding_completed: u.onboarding_completed, updated_at: iso(-2 * 24 * HOUR), changed_fields: ["interests", "budget"] },
    tickets: tickets.filter((t) => t.user_id === u.user_id).map((t) => ({ ticket_id: t.ticket_id, number: t.number, status: t.status, subject: t.subject, created_at: t.created_at })),
    ai_conversations: [],
    // sprint 7: filled by the mock admin-bff from fixtures/ai.ts (access level, usage, conversation metadata)
    access_level: null,
    ai_usage_30d: null,
    refreshed_at: iso(0),
  };
}

/* ---------------------------------------------------------------- support */

let msgSeq = 0;
export function msg(sender_type: StaffTicketMessage["sender_type"], text: string, minutesAgo: number, extra: Partial<StaffTicketMessage> = {}): StaffTicketMessage {
  msgSeq += 1;
  return {
    message_id: `9a000000-0000-4000-8000-${String(msgSeq).padStart(12, "0")}`,
    sender_type,
    visibility: "public",
    author_id: null,
    author_name: null,
    text,
    created_at: iso(-minutesAgo * MIN),
    ...extra,
  };
}

interface TicketSpec {
  n: number;
  subject: string;
  category: string;
  priority: TicketPriority;
  status: TicketStatus;
  user: string | null;
  createdMin: number;
  /** minutes until the current SLA deadline (negative = breached) */
  dueMin: number;
  assignee?: { id: string; name: string } | null;
  firstResponseMin?: number;
  context?: StaffTicket["context"];
  messages?: StaffTicketMessage[];
}

export function ticket(s: TicketSpec, usersList: AdminUserRow[]): StaffTicket {
  const created = iso(-s.createdMin * MIN);
  const due = iso(s.dueMin * MIN);
  const first = s.firstResponseMin != null ? iso(-s.firstResponseMin * MIN) : null;
  const running = s.status === "NEW" || s.status === "IN_PROGRESS";
  const target = s.status === "RESOLVED" || s.status === "CLOSED" ? null : first ? "resolution" : "first_response";
  const u = usersList.find((x) => x.user_id === s.user);
  return {
    ticket_id: `7e000000-0000-4000-8000-00000000${String(s.n).padStart(4, "0")}`,
    number: `TCK-${s.n}`,
    user_id: s.user,
    channel: "telegram",
    category: s.category,
    subject: s.subject,
    status: s.status,
    priority: s.priority,
    assignee_id: s.assignee?.id ?? null,
    assignee_name: s.assignee?.name ?? null,
    has_event_context: !!s.context,
    anonymized: false,
    created_at: created,
    updated_at: iso(-5 * MIN),
    last_message_at: iso(-5 * MIN),
    first_response_at: first,
    sla_first_response_at: first ? iso(-(s.createdMin - 30) * MIN) : due,
    sla_resolution_at: first ? due : iso(s.dueMin * MIN + 4 * HOUR),
    sla_target: target,
    sla_due_at: target ? due : null,
    sla_state: !running ? "ok" : s.dueMin < 0 ? "breached" : s.dueMin < 30 ? "soon" : "ok",
    sla_paused: s.status === "WAITING_CUSTOMER",
    context: s.context ?? null,
    correlation_id: null,
    resolved_at: s.status === "RESOLVED" || s.status === "CLOSED" ? iso(-30 * MIN) : null,
    closed_at: s.status === "CLOSED" ? iso(-20 * MIN) : null,
    user_unread_operator_replies: 0,
    messages: s.messages ?? [msg("user", s.subject, s.createdMin)],
    status_history: [{ from_status: null, status: "NEW", at: created, changed_by: "user", actor_id: null }],
    escalations: [],
    user: u ? { user_id: u.user_id, username: u.username, telegram_id_masked: u.telegram_id_masked, locale: u.locale, status: u.status } : null,
  };
}

export function tickets(usersList: AdminUserRow[]): StaffTicket[] {
  const alina = { id: ID.support, name: "Алина" };
  const timur = { id: ID.ops, name: "Тимур" };
  return [
    ticket(
      {
        n: 3081,
        subject: "Не открывается ссылка на билет",
        category: "TICKET_SOURCE",
        priority: "high",
        status: "IN_PROGRESS",
        user: USER.igor,
        createdMin: 41,
        dueMin: 12,
        assignee: alina,
        context: {
          event_id: "evt_f1_auh_2026",
          offer_id: "off_987",
          provider_id: "ticket_provider_x",
          deeplink: "https://www.abudhabigp.com/en/tickets",
          price_snapshot: { amount: "850.00", currency: "USD" },
          fetched_at: iso(-50 * MIN),
          trace_id: "7f3a9c2e1b0d4e5f8a7b6c5d4e3f2c21",
          client_version: "telegram-miniapp-2.0",
        },
        messages: [
          msg("user", "Нажимаю «Купить билет» на Formula 1 Abu Dhabi — открывается страница sold out, хотя в приложении билеты есть.", 41),
          msg("system", "Назначено: Алина.", 38),
          msg("operator", "Проверила deeplink: провайдер отвечает 302 на sold-out для части регионов. Похоже на гео-редирект — нужен Provider issue.", 30, { visibility: "internal", author_id: ID.support, author_name: "Алина" }),
        ],
      },
      usersList,
    ),
    // sprint 5: tickets with an offer snapshot (Mini App «Problem with the offer?»): 3074 — snapshot exists, 3069 — expired and removed (404)
    ticket(
      {
        n: 3069, subject: "Цена билета изменилась после перехода", category: "PRICE", priority: "high", status: "IN_PROGRESS", user: USER.maria, createdMin: 180, dueMin: -65, assignee: timur,
        context: { event_id: "e1000000-0000-4000-8000-000000000041", offer_id: "0ffe0000-0000-4000-8000-000000003069", provider_id: "aviasales", deeplink: "https://www.aviasales.com/search/TAS0512IST09121", price_snapshot: { amount: "318.00", currency: "USD" }, fetched_at: iso(-200 * MIN), trace_id: null, client_version: "telegram-miniapp-2.1" },
      },
      usersList,
    ),
    ticket(
      {
        n: 3074, subject: "Отель далеко от площадки", category: "HOTEL", priority: "low", status: "NEW", user: USER.aziza, createdMin: 240, dueMin: -17,
        context: { event_id: "e1000000-0000-4000-8000-000000000042", offer_id: "0ffe0000-0000-4000-8000-000000003074", provider_id: "liteapi", deeplink: "https://book.tilhero.app/hotels/lp1beec?checkin=2026-11-13&checkout=2026-11-16", price_snapshot: { amount: "390.00", currency: "USD" }, fetched_at: iso(-250 * MIN), trace_id: "3b9e7c1d2a4f4e6b8c0d1e2f3a4b5c6d", client_version: "telegram-miniapp-2.1" },
        messages: [msg("user", "В подборке «Комфорт» отель Rixos, но до Almaty Arena почти 2 км, а писали «рядом с площадкой». Можно вариант ближе?", 240)],
      },
      usersList,
    ),
    ticket({ n: 3072, subject: "Хочу выгрузить свои данные", category: "PERSONAL_DATA", priority: "high", status: "NEW", user: USER.nomad, createdMin: 230, dueMin: 10 }, usersList),
    ticket({ n: 3071, subject: "Mini App не открывается на Android", category: "BUG", priority: "high", status: "NEW", user: USER.igor, createdMin: 55, dueMin: 65 }, usersList),
    ticket({ n: 3080, subject: "Пришли два одинаковых уведомления", category: "BUG", priority: "normal", status: "WAITING_CUSTOMER", user: USER.maria, createdMin: 27, dueMin: 93, assignee: alina, firstResponseMin: 10 }, usersList),
    ticket({ n: 3060, subject: "Как поменять язык?", category: "OTHER", priority: "normal", status: "RESOLVED", user: USER.aziza, createdMin: 2000, dueMin: 600, assignee: alina, firstResponseMin: 1900 }, usersList),
  ];
}

export const TEMPLATES: ReplyTemplate[] = [
  {
    id: "tpl_link",
    title: { ru: "Ссылка провайдера не работает", en: "Provider link is broken" },
    text: {
      ru: "Здравствуйте! Мы проверили ссылку: проблема на стороне продавца билетов. Пока откройте официальную страницу напрямую — {deeplink}.",
      en: "Hi! We checked the link: the issue is on the ticket seller’s side. For now, open the official page directly — {deeplink}.",
    },
    categories: ["TICKET_SOURCE", "EVENT_RECOMMENDATION"],
  },
  {
    id: "tpl_more",
    title: { ru: "Нужны подробности", en: "Need more details" },
    text: { ru: "Здравствуйте! Пришлите, пожалуйста, скриншот ошибки по обращению {number}.", en: "Hi! Please send a screenshot of the error for request {number}." },
    categories: ["BUG", "OTHER"],
  },
];

export const SLA_POLICIES = () => {
  const at = iso(-7 * 24 * HOUR);
  const row = (category: string, priority: TicketPriority, f: number, r: number) => ({ category, priority, first_response_minutes: f, resolution_minutes: r, updated_at: at, updated_by: ID.admin });
  return {
    items: [row("*", "urgent", 30, 240), row("*", "high", 60, 480), row("*", "normal", 240, 1440), row("*", "low", 480, 2880), row("PERSONAL_DATA", "high", 60, 1440)],
    category_defaults: { PERSONAL_DATA: "high", ACCOUNT: "high" },
  };
};

/* ---------------------------------------------------------------- dashboard */

/** users block numbers (sprint 2 dashboard); the full DashboardV2 of sprint 8 — fixtures/ops.ts */
export function dashboardLegacy(period: Dashboard["period"]) {
  const k = period === "today" ? 1 : period === "7d" ? 7 : 30;
  return {
    users: { total: 12846, new_in_period: 31 * k, onboarding_completed_pct: 87.4, by_status: { ACTIVE: 12801, DISABLED: 12, DELETION_REQUESTED: 3, DELETED: 30 } },
  };
}

/* ---------------------------------------------------------------- audit */

const hex = (n: number, len = 64) => {
  let s = "";
  let x = (n * 2654435761) >>> 0;
  while (s.length < len) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += x.toString(16).padStart(8, "0");
  }
  return s.slice(0, len);
};

export function auditRecords(): AuditRecord[] {
  const specs: Array<[string, string, string | null, string | null, Record<string, unknown> | null, string | null]> = [
    ["auth.login", "admin-identity", "staff", ID.admin, { mfa: true }, null],
    ["sensitive.view", "identity-consent", "user", USER.igor, { field: "telegram_user_id" }, "ticket: TCK-3081"],
    ["ticket.reply", "support", "ticket", "7e000000-0000-4000-8000-000000003080", { status: "WAITING_CUSTOMER" }, null],
    ["config.rollback", "experience-config", "config", "miniapp", { version: "2.0.2" }, "Контраст на тёмной теме"],
    ["staff.created", "admin-identity", "staff", ID.newbie, { role: "operations", temporary_password: "never-shown", must_change_password: true }, null],
    ["auth.login_failed", "admin-identity", "staff", null, { email_hash: "5c1f…" }, null],
    ["approval.waived", "admin-identity", "approval", "4a000000-0000-4000-8000-000000000001", { waived: "single_super_admin" }, "Первый оператор смены"],
    ["auth.step_up", "admin-bff", "staff", ID.admin, null, null],
  ];
  const out: AuditRecord[] = [];
  let prev = "0".repeat(64);
  for (let k = 0; k < 24; k++) {
    const [action, source, object_type, object_id, after, reason] = specs[k % specs.length]!;
    const seq = 1000 + k;
    const h = hex(seq);
    out.push({
      seq,
      record_id: `ad000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      occurred_at: iso(-(24 - k) * 17 * MIN),
      recorded_at: iso(-(24 - k) * 17 * MIN + 150),
      source,
      actor_type: action === "auth.login_failed" ? "system" : "staff",
      actor_id: action === "auth.login_failed" ? null : ID.admin,
      actor_role: action === "auth.login_failed" ? null : "super_admin",
      action,
      object_type,
      object_id,
      before: action === "config.rollback" ? { version: "2.0.3" } : null,
      after,
      reason,
      ip: "10.12.0.4",
      session_id: "s-8f2a91c0",
      trace_id: hex(seq + 7, 32),
      prev_hash: prev,
      hash: h,
    });
    prev = h;
  }
  return out.reverse();
}

/* ---------------------------------------------------------------- experience config */

export const MINI_TOKENS_203 = { "--accent": "#DFFF56", "--accent-ink": "#1A2200", "--r-card": "22px" };
export const MINI_TOKENS_202 = { "--accent": "#8EF5C2", "--accent-ink": "#00261A", "--r-card": "14px" };

export function miniPayload(themeVersion: string, tokens: Record<string, string>) {
  return {
    theme: { id: "default", version: themeVersion, tokens },
    home: {
      welcome_mode: "first_visit_only",
      sections: [
        { type: "event_carousel", key: "best_for_you", variant: "large", enabled: true },
        { type: "watch_changes", key: "watch", variant: "compact", enabled: true },
        { type: "event_carousel", key: "sales_soon", variant: "compact", enabled: true },
        { type: "news_carousel", key: "news", variant: "compact", enabled: true },
      ],
    },
    flags: { ai_concierge: true, group_trip: true, calendar_export: false, premium_teaser: true },
    hotel_rating_min: 8.5,
  };
}

/** admin 1.0.0 = the built-in default (lime accent); 1.0.1 = a mint accent, active at start — the rollback test returns to lime. */
export const ADMIN_ACCENT_100 = "#DFFF56";
export const ADMIN_ACCENT_101 = "#7CF0C8";
export function adminPayload(version: string, accent: string, widgets?: string[]) {
  return {
    theme: { id: "default", version, tokens: { "--accent": accent, "--accent-press": accent, "--r": "8px" } },
    layout: {
      density: "compact",
      table_presets: { users: "support", audit: "security" },
      dashboard_widgets: (widgets ?? ["kpi_users", "kpi_ai", "kpi_support", "kpi_system", "kpi_commerce", "budget", "hourly", "cost_agents", "dau", "agents_table"]).map((id) => ({ id, enabled: true })),
    },
    flags: {},
  };
}

/* ---------- 9.4: «Что нового» — сид-черновик «Ноябрь 2026» (как миграция 0004 experience-config) ---------- */
export function releaseNoteSeed(): import("@tilhero/contracts/admin").StaffReleaseNote {
  return {
    release_note_id: "5b2c1a7e-0d3f-5e6a-9b8c-2026110000aa",
    slug: "2026.11",
    title: { ru: "Ноябрь 2026", en: "November 2026" },
    items: [
      { icon: "pin", link: "catalog", title: { ru: "Больше событий в Алматы", en: "More events in Almaty" }, text: { ru: "Собираем афишу с сайтов площадок и театров, из билетных касс и городских Telegram-каналов.", en: "We now collect listings from venue and theatre websites, ticket offices and the city's Telegram channels." } },
      { icon: "globe", link: "catalog", title: { ru: "Новые источники в Астане и Бишкеке", en: "New sources in Astana and Bishkek" }, text: { ru: "Концерты, спектакли и выставки этих городов теперь тоже попадают в подборку.", en: "Concerts, plays and exhibitions in these cities now show up in your picks too." } },
      { icon: "phone", link: "profile", title: { ru: "TilHero на главном экране", en: "TilHero on your Home Screen" }, text: { ru: "Добавьте иконку на экран телефона и открывайте TilHero одной кнопкой. Кнопка — в Профиле, нужна свежая версия Telegram.", en: "Add the icon to your phone's Home Screen and open TilHero in one tap. It's in Profile; requires an up-to-date Telegram." } },
    ],
    audience: "existing",
    status: "draft",
    version: 1,
    created_by: "system:seed",
    created_at: "2026-11-08T06:00:00.000Z",
    updated_by: "system:seed",
    updated_at: "2026-11-08T06:00:00.000Z",
    published_by: null,
    published_at: null,
    archived_by: null,
    archived_at: null,
  };
}

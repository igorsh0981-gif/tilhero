/**
 * Fixture data of the mock admin-bff (TilHero sprint 2). Shapes follow packages/contracts/src/admin.ts; PII is fake
 * and masked the way the real services mask it (telegram_id_masked = ••••••789).
 */
import type {
  AdminLearnerCard,
  AdminLearnerRow,
  AuditRecord,
  Campaign,
  Permission,
  ReplyTemplate,
  Role,
  RoleCode,
  SlaPolicy,
  Staff,
  StaffReleaseNote,
  StaffTicket,
  StaffTicketMessage,
  TemplateInfo,
  TemplateVersion,
  TicketPriority,
  TicketStatus,
} from "@tilhero/contracts/admin";
import { PERMISSIONS } from "@tilhero/contracts/admin";

export const ALL_PERMS: Permission[] = [...PERMISSIONS];

/** Default matrix (PLAN.md «Роли и права»; super_admin — all; users.sensitive.read, staff.manage, roles.manage — only super_admin). */
export const MATRIX: Record<RoleCode, Permission[]> = {
  super_admin: [...ALL_PERMS],
  operations: ["dashboard.read", "users.read", "support.read", "config.read", "config.edit", "config.publish", "audit.read"],
  communications: ["dashboard.read", "whatsnew.manage", "whatsnew.publish", "notif.templates.manage", "notif.campaigns.manage", "notif.campaigns.send"],
  support: ["dashboard.read", "users.read", "support.read", "support.reply"],
  methodist: ["dashboard.read", "users.read"],
  analyst: ["dashboard.read", "users.read"],
  auditor: ["dashboard.read", "audit.read"],
  read_only: ["dashboard.read"],
};

export const ROLE_NAMES: Record<RoleCode, { ru: string; en: string }> = {
  super_admin: { ru: "Super Admin", en: "Super Admin" },
  operations: { ru: "Операции", en: "Operations" },
  communications: { ru: "Коммуникации", en: "Communications" },
  support: { ru: "Поддержка", en: "Support" },
  methodist: { ru: "Методист", en: "Methodist" },
  analyst: { ru: "Аналитик", en: "Analyst" },
  auditor: { ru: "Аудитор", en: "Auditor" },
  read_only: { ru: "Только чтение", en: "Read only" },
};
export const PRIVILEGED: RoleCode[] = ["super_admin", "operations", "communications"];

export const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

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
  comms: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a07",
  methodist: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a08",
};

function staff(id: string, email: string, display_name: string, role: RoleCode, extra: Partial<Staff> = {}): Staff {
  return {
    staff_id: id,
    email,
    display_name,
    role,
    status: "ACTIVE",
    mfa_enabled: PRIVILEGED.includes(role),
    must_change_password: false,
    last_login_at: iso(-2 * HOUR),
    created_at: iso(-40 * DAY),
    created_by: ID.admin,
    ...extra,
  };
}

export const PASSWORD = "Correct-Horse-42";
export const TOTP = "123456";

export function accounts(): Account[] {
  return [
    { staff: staff(ID.admin, "admin@tilhero.local", "Игорь Ш.", "super_admin", { last_login_at: iso(-2 * MIN) }), password: PASSWORD },
    { staff: staff(ID.admin2, "security@tilhero.local", "Нодира", "super_admin", { last_login_at: iso(-43 * MIN) }), password: PASSWORD },
    { staff: staff(ID.comms, "comms@tilhero.local", "Дилноза", "communications", { last_login_at: iso(-5 * HOUR) }), password: PASSWORD },
    { staff: staff(ID.support, "support@tilhero.local", "Алина", "support", { last_login_at: iso(-21 * MIN) }), password: PASSWORD },
    { staff: staff(ID.ops, "ops@tilhero.local", "Тимур", "operations", { last_login_at: iso(-3 * HOUR) }), password: PASSWORD },
    { staff: staff(ID.methodist, "methodist@tilhero.local", "Гульнора", "methodist", { mfa_enabled: false }), password: PASSWORD },
    { staff: staff(ID.auditor, "auditor@tilhero.local", "Сардор", "auditor", { mfa_enabled: false }), password: PASSWORD },
    { staff: staff(ID.newbie, "newbie@tilhero.local", "Новый сотрудник", "operations", { mfa_enabled: false, must_change_password: true, last_login_at: null }), password: "Temp-Pass-0001" },
  ];
}

export function roles(matrix: Record<RoleCode, Permission[]>, accs: Account[]): Role[] {
  return (Object.keys(matrix) as RoleCode[]).map((code) => ({
    code,
    name: ROLE_NAMES[code],
    permissions: [...matrix[code]],
    privileged: PRIVILEGED.includes(code),
    staff_count: accs.filter((a) => a.staff.role === code).length,
    updated_at: iso(-12 * DAY),
    updated_by: null,
  }));
}

/* ---------------------------------------------------------------- learners */

export const LEARNER = {
  madina: "a1000000-0000-4000-8000-000000000001",
  botir: "a1000000-0000-4000-8000-000000000002",
  lola: "a1000000-0000-4000-8000-000000000003",
  timur: "a1000000-0000-4000-8000-000000000004",
  anya: "a1000000-0000-4000-8000-000000000005",
  jasur: "a1000000-0000-4000-8000-000000000006",
  kamila: "a1000000-0000-4000-8000-000000000007",
  oleg: "a1000000-0000-4000-8000-000000000008",
};

function row(id: string, extra: Partial<AdminLearnerRow>): AdminLearnerRow {
  return {
    user_id: id,
    kind: "account",
    guardian_user_id: null,
    display_name: null,
    username: null,
    telegram_id_masked: null,
    locale: "ru",
    age_band: "18+",
    guardian_consent: "not_required",
    status: "ACTIVE",
    onboarding_completed: true,
    goal: "travel",
    reminders_enabled: true,
    children_count: 0,
    open_tickets: 0,
    tickets_total: 0,
    created_at: iso(-30 * DAY),
    last_activity_at: iso(-3 * HOUR),
    ...extra,
  };
}

export function learners(): AdminLearnerRow[] {
  return [
    row(LEARNER.madina, { display_name: "Мадина К.", username: "madina_k", telegram_id_masked: "••••••417", goal: "work", open_tickets: 1, tickets_total: 2, last_activity_at: iso(-40 * MIN) }),
    row(LEARNER.botir, { display_name: "Ботир Р.", username: "botir_r", telegram_id_masked: "••••••932", locale: "uz", goal: "daily", children_count: 2, tickets_total: 1, open_tickets: 1, last_activity_at: iso(-1 * DAY) }),
    row(LEARNER.lola, { kind: "child", guardian_user_id: LEARNER.botir, display_name: "Лола", locale: "uz", age_band: "6-9", guardian_consent: "granted", goal: "study", reminders_enabled: false, last_activity_at: iso(-5 * HOUR) }),
    row(LEARNER.timur, { kind: "child", guardian_user_id: LEARNER.botir, display_name: "Тимур", locale: "ru", age_band: "10-13", guardian_consent: "granted", goal: "study", last_activity_at: iso(-2 * DAY) }),
    row(LEARNER.anya, { display_name: "Аня", username: "anya_14", telegram_id_masked: "••••••781", age_band: "14-17", guardian_consent: "granted", goal: "exam", last_activity_at: iso(-3 * DAY) }),
    row(LEARNER.jasur, { display_name: "Жасур", username: null, telegram_id_masked: "••••••205", locale: "uz", onboarding_completed: false, goal: null, reminders_enabled: false, last_activity_at: null, created_at: iso(-2 * HOUR) }),
    row(LEARNER.kamila, { display_name: "Камила", username: "kamila_t", telegram_id_masked: "••••••560", age_band: "14-17", guardian_consent: "pending", goal: "career", last_activity_at: iso(-12 * DAY) }),
    row(LEARNER.oleg, { display_name: "Олег", username: "oleg_v", telegram_id_masked: "••••••118", status: "DELETION_REQUESTED", goal: "travel", last_activity_at: iso(-20 * DAY), tickets_total: 1 }),
  ];
}

export const TELEGRAM_IDS: Record<string, string> = {
  [LEARNER.madina]: "5120934417",
  [LEARNER.botir]: "6011280932",
  [LEARNER.anya]: "7004512781",
  [LEARNER.jasur]: "5900011205",
  [LEARNER.kamila]: "6112003560",
  [LEARNER.oleg]: "5002441118",
};

export function card(rows: AdminLearnerRow[], id: string, tickets: AdminLearnerCard["tickets"]): AdminLearnerCard | null {
  const r = rows.find((x) => x.user_id === id);
  if (!r) return null;
  const child = r.kind === "child";
  return {
    ...r,
    consent: {
      policy_version: "1.2",
      purposes: child ? ["terms", "privacy", "guardian"] : r.user_id === LEARNER.madina ? ["terms", "privacy", "product_news", "social"] : ["terms", "privacy"],
      accepted_at: iso(-29 * DAY),
      revoked_at: null,
      basis: child || r.age_band === "14-17" ? "guardian" : "self",
    },
    security: { pin_enabled: r.user_id === LEARNER.botir, pin_reset_pending: false },
    notifications: { enabled: r.reminders_enabled, categories: { reminders: r.reminders_enabled, missed: true, social: !child, support: true, product: r.user_id === LEARNER.madina } },
    plan: r.onboarding_completed
      ? {
          goal: r.goal,
          level_self: "beginner",
          ui_lang: r.locale,
          schedule: { preset: "weekdays", days: [1, 2, 3, 4, 5], preferred_time: "19:30", duration_min: 20, reminders_enabled: r.reminders_enabled, timezone: "Asia/Tashkent" },
          onboarding_completed_at: iso(-28 * DAY),
          updated_at: iso(-3 * DAY),
        }
      : null,
    children: r.kind === "account" ? rows.filter((x) => x.guardian_user_id === r.user_id) : [],
    guardian: child ? (rows.find((x) => x.user_id === r.guardian_user_id) ?? null) : null,
    tickets,
    refreshed_at: iso(0),
  };
}

/* ---------------------------------------------------------------- support */

function msg(id: number, sender: StaffTicketMessage["sender_type"], text: string, minAgo: number, extra: Partial<StaffTicketMessage> = {}): StaffTicketMessage {
  return { message_id: `c1000000-0000-4000-8000-${String(id).padStart(12, "0")}`, sender_type: sender, visibility: "public", author_id: null, author_name: null, text, created_at: iso(-minAgo * MIN), ...extra };
}

function ticket(n: number, user: AdminLearnerRow | null, extra: Partial<StaffTicket>): StaffTicket {
  const created = extra.created_at ?? iso(-90 * MIN);
  return {
    ticket_id: `b1000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    number: `TCK-${n}`,
    user_id: user?.user_id ?? null,
    channel: "miniapp",
    category: "OTHER",
    subject: "",
    status: "NEW",
    priority: "normal",
    assignee_id: null,
    assignee_name: null,
    has_context: true,
    anonymized: false,
    created_at: created,
    updated_at: created,
    last_message_at: created,
    first_response_at: null,
    sla_first_response_at: iso(30 * MIN),
    sla_resolution_at: iso(20 * HOUR),
    sla_target: "first_response",
    sla_due_at: iso(30 * MIN),
    sla_state: "ok",
    sla_paused: false,
    context: { deeplink: "tilhero://lessons/L-014", client_version: "miniapp 1.0.0 · iOS" },
    correlation_id: "7f3a9c1e5b2d4a6f",
    resolved_at: null,
    closed_at: null,
    user_unread_operator_replies: 0,
    messages: [],
    status_history: [{ from_status: null, status: "NEW", at: created, changed_by: "user", actor_id: null }],
    escalations: [],
    learner: user ? { user_id: user.user_id, kind: user.kind, username: user.username, telegram_id_masked: user.telegram_id_masked, locale: user.locale, age_band: user.age_band, status: user.status } : null,
    ...extra,
  };
}

export function tickets(ls: AdminLearnerRow[]): StaffTicket[] {
  const by = (id: string) => ls.find((x) => x.user_id === id) ?? null;
  return [
    ticket(1042, by(LEARNER.madina), {
      category: "ASSESSMENT",
      subject: "Ошибку нашли там, где её нет",
      priority: "high",
      created_at: iso(-55 * MIN),
      sla_due_at: iso(-12 * MIN),
      sla_state: "breached",
      messages: [msg(1, "user", "В уроке «В кафе» мне засчитали ошибку во фразе «We'd like a table for three», но там всё верно.", 55)],
    }),
    ticket(1043, by(LEARNER.botir), {
      category: "SCHEDULE_REMINDERS",
      subject: "Eslatmalar kech keladi",
      status: "IN_PROGRESS",
      assignee_id: ID.support,
      assignee_name: "Алина",
      created_at: iso(-4 * HOUR),
      first_response_at: iso(-3 * HOUR),
      sla_target: "resolution",
      sla_due_at: iso(6 * HOUR),
      messages: [
        msg(2, "user", "Eslatma 19:30 ga qoʻyilgan, lekin 21:00 da keladi.", 240),
        msg(3, "operator", "Assalomu alaykum! Vaqt mintaqangizni tekshirib koʻramiz.", 180, { author_id: ID.support, author_name: "Алина" }),
        msg(4, "operator", "Похоже, в профиле стоит Europe/Moscow — проверить после обновления 1.0.1.", 175, { author_id: ID.support, author_name: "Алина", visibility: "internal" }),
      ],
      status_history: [
        { from_status: null, status: "NEW", at: iso(-4 * HOUR), changed_by: "user", actor_id: null },
        { from_status: "NEW", status: "IN_PROGRESS", at: iso(-3 * HOUR), changed_by: "staff", actor_id: ID.support },
      ],
    }),
    ticket(1044, by(LEARNER.botir), {
      category: "CHILD_PROFILE",
      subject: "Как добавить второго ребёнка",
      status: "WAITING_CUSTOMER",
      assignee_id: ID.support,
      assignee_name: "Алина",
      created_at: iso(-1 * DAY),
      first_response_at: iso(-20 * HOUR),
      sla_target: "resolution",
      sla_due_at: iso(30 * HOUR),
      sla_paused: true,
      messages: [msg(5, "user", "Хочу добавить второго ребёнка, но кнопка неактивна.", 1440), msg(6, "operator", "Подскажите, пожалуйста, возраст ребёнка?", 1200, { author_id: ID.support, author_name: "Алина" })],
    }),
    ticket(1045, by(LEARNER.oleg), {
      category: "BUG",
      subject: "Не открывается урок после обновления",
      status: "RESOLVED",
      created_at: iso(-3 * DAY),
      first_response_at: iso(-3 * DAY + HOUR),
      resolved_at: iso(-2 * DAY),
      sla_target: null,
      sla_due_at: null,
      messages: [msg(7, "user", "Урок L-003 висит на загрузке.", 4320), msg(8, "operator", "Исправили в версии 1.0.1 — обновите, пожалуйста, приложение.", 2880, { author_id: ID.admin, author_name: "Игорь Ш." })],
    }),
  ];
}

export const REPLY_TEMPLATES: ReplyTemplate[] = [
  {
    id: "greet",
    title: { ru: "Приветствие", en: "Greeting" },
    text: { ru: "Здравствуйте! Спасибо, что написали в поддержку TilHero. Обращение {number} у нас.", uz: "Assalomu alaykum! TilHero yordam xizmatiga yozganingiz uchun rahmat. Murojaat {number} bizda." },
    categories: ["OTHER", "ACCOUNT", "BUG"],
  },
  {
    id: "assessment",
    title: { ru: "Переоценка", en: "Re-evaluation" },
    text: { ru: "Мы проверили оценку и пересчитали результат урока. Исходная оценка сохранена в истории.", uz: "Baholashni tekshirdik va dars natijasini qayta hisobladik. Dastlabki baho tarixda saqlangan." },
    categories: ["ASSESSMENT"],
  },
  {
    id: "timezone",
    title: { ru: "Часовой пояс", en: "Time zone" },
    text: { ru: "Проверьте, пожалуйста, часовой пояс в «Профиль → График»: напоминания приходят по нему.", uz: "" },
    categories: ["SCHEDULE_REMINDERS"],
  },
];

export const SLA_POLICIES = (): SlaPolicy[] => [
  { category: "*", priority: "normal", first_response_minutes: 60, resolution_minutes: 1440, updated_at: iso(-10 * DAY), updated_by: ID.admin },
  { category: "*", priority: "urgent", first_response_minutes: 15, resolution_minutes: 240, updated_at: iso(-10 * DAY), updated_by: ID.admin },
  { category: "CHILD_PROFILE", priority: "normal", first_response_minutes: 30, resolution_minutes: 720, updated_at: iso(-10 * DAY), updated_by: ID.admin },
];

/* ---------------------------------------------------------------- «Что нового» */

const L = (ru: string, uz: string) => ({ ru, uz });

export function releaseNotes(): StaffReleaseNote[] {
  const base = {
    created_by: ID.comms,
    created_by_name: "Дилноза",
    updated_by: ID.comms,
    published_by: null as string | null,
    published_by_name: null as string | null,
    published_at: null as string | null,
    archived_by: null as string | null,
    archived_at: null as string | null,
    segments: {},
  };
  return [
    {
      ...base,
      release_note_id: "d1000000-0000-4000-8000-000000000003",
      slug: "2026.11",
      status: "draft",
      version: 3,
      title: L("Ноябрь: семья и график", "Noyabr: oila va jadval"),
      items: [
        { title: L("Семейный график", "Oilaviy jadval"), text: L("Родитель видит, когда занимаются дети, и может поменять время напоминаний.", "Ota-ona bolalar qachon shugʻullanishini koʻradi va eslatma vaqtini oʻzgartira oladi."), link: "family", icon: "users" },
        { title: L("Тихие часы", "Tinch soatlar"), text: L("После 21:00 напоминания не приходят — даже если урок пропущен.", "21:00 dan keyin eslatmalar kelmaydi — dars oʻtkazib yuborilsa ham."), link: "schedule", icon: "clock" },
      ],
      audience: "existing",
      created_at: iso(-2 * DAY),
      updated_at: iso(-3 * HOUR),
      views_total: 0,
    },
    {
      ...base,
      release_note_id: "d1000000-0000-4000-8000-000000000002",
      slug: "2026.10",
      status: "published",
      version: 5,
      title: L("Октябрь: повторение слов", "Oktyabr: soʻzlarni takrorlash"),
      items: [
        { title: L("Умное повторение", "Aqlli takrorlash"), text: L("Слова возвращаются, когда вы начинаете их забывать.", "Soʻzlar ularni unuta boshlaganingizda qaytadi."), link: "review", icon: "book" },
        { title: L("Герой растёт с навыками", "Qahramon koʻnikmalar bilan oʻsadi"), text: L("Новая ступень — за подтверждённые навыки, а не за XP.", "Yangi bosqich — tasdiqlangan koʻnikmalar uchun, XP uchun emas."), link: "progress", icon: "hero" },
      ],
      audience: "existing",
      segments: { age: ["teens", "adults"] },
      created_at: iso(-35 * DAY),
      updated_at: iso(-30 * DAY),
      published_by: ID.comms,
      published_by_name: "Дилноза",
      published_at: iso(-30 * DAY),
      views_total: 812,
    },
    {
      ...base,
      release_note_id: "d1000000-0000-4000-8000-000000000001",
      slug: "2026.09",
      status: "archived",
      version: 2,
      title: L("Знакомство с TilHero", "TilHero bilan tanishuv"),
      items: [{ title: L("Урок за 20 минут", "20 daqiqalik dars"), text: L("Каждый день — короткий урок с героем.", "Har kuni — qahramon bilan qisqa dars."), link: "lessons", icon: "spark" }],
      audience: "new",
      created_at: iso(-70 * DAY),
      updated_at: iso(-60 * DAY),
      published_by: ID.admin,
      published_by_name: "Игорь Ш.",
      published_at: iso(-65 * DAY),
      archived_by: ID.admin,
      archived_at: iso(-31 * DAY),
      views_total: 1204,
    },
  ];
}

/* ---------------------------------------------------------------- notification templates */

const TT = (ru: [string, string, string | null], uz: [string, string, string | null]) => ({ ru: { title: ru[0], body: ru[1], button: ru[2] }, uz: { title: uz[0], body: uz[1], button: uz[2] } });
const PH = (name: string, ru: string, en: string, sRu: string, sUz: string) => ({ name, description: { ru, en }, sample: { ru: sRu, uz: sUz } });

export function templates(): Array<TemplateInfo & { versions: TemplateVersion[] }> {
  const name = PH("learner_name", "Имя ученика", "Learner name", "Мадина", "Madina");
  const slot = PH("slot_time", "Время занятия", "Lesson time", "19:30", "19:30");
  const dur = PH("duration", "Длительность урока", "Lesson duration", "20 минут", "20 daqiqa");
  const days = PH("days_missed", "Сколько дней пропущено", "Days missed", "3 дня", "3 kun");
  const inviter = PH("inviter_name", "Кто пригласил", "Inviter", "Ботир", "Botir");
  const tck = PH("ticket_number", "Номер обращения", "Ticket number", "TCK-1042", "TCK-1042");
  const note = PH("note_title", "Заголовок заметки", "Note title", "Ноябрь: семья и график", "Noyabr: oila va jadval");
  const lessonDefault = TT(["Пора заниматься, {learner_name}", "Урок на {duration} ждёт вас в {slot_time}. Герой уже готов!", "Начать урок"], ["{learner_name}, dars vaqti", "{duration} lik dars {slot_time} da kutmoqda. Qahramon tayyor!", "Darsni boshlash"]);
  const lessonV2 = TT(["{learner_name}, урок ждёт", "В {slot_time} — {duration} английского. Начнём с повторения слов.", "Начать"], ["{learner_name}, dars kutmoqda", "{slot_time} da — {duration} ingliz tili. Soʻzlarni takrorlashdan boshlaymiz.", "Boshlash"]);
  const v = (key: string, version: number, status: TemplateVersion["status"], texts: TemplateVersion["texts"], noteText: string, daysAgo: number, activated: boolean): TemplateVersion => ({
    key,
    version,
    status,
    texts,
    note: noteText,
    created_by: ID.comms,
    created_by_name: "Дилноза",
    created_at: iso(-daysAgo * DAY),
    activated_by: activated ? ID.comms : null,
    activated_by_name: activated ? "Дилноза" : null,
    activated_at: activated ? iso(-(daysAgo - 1) * DAY) : null,
  });
  const info = (key: string, category: TemplateInfo["category"], kid: boolean, ru: string, en: string, placeholders: TemplateInfo["placeholders"], default_texts: TemplateInfo["default_texts"], versions: TemplateVersion[]) => {
    const active = versions.find((x) => x.status === "active");
    return { key, category, kid, description: { ru, en }, placeholders, default_texts, active_version: active?.version ?? null, active_since: active?.activated_at ?? null, updated_at: versions[0]?.created_at ?? null, versions };
  };
  return [
    info("reminder.lesson", "reminders", false, "Напоминание о занятии", "Lesson reminder", [name, slot, dur], lessonDefault, [
      v("reminder.lesson", 2, "active", lessonV2, "Короче и с повторением в начале", 6, true),
      v("reminder.lesson", 1, "archived", lessonDefault, "Первая версия поверх текста из кода", 20, true),
    ]),
    info("reminder.lesson.kid", "reminders", true, "Напоминание о занятии ребёнка (опекуну)", "Child lesson reminder (to the guardian)", [name, slot], TT(["У {learner_name} урок в {slot_time}", "Короткий урок с героем ждёт. Можно начать вместе!", "Открыть"], ["{learner_name}ning darsi {slot_time} da", "Qahramon bilan qisqa dars kutmoqda. Birga boshlash mumkin!", "Ochish"]), []),
    info("missed.comeback", "missed", false, "Возвращение после пропуска", "Come back after a pause", [name, days], TT(["{learner_name}, продолжим?", "Вы не занимались {days_missed}. Навыки и слова на месте — вернитесь, когда удобно.", "Продолжить"], ["{learner_name}, davom etamizmi?", "Siz {days_missed} shugʻullanmadingiz. Koʻnikmalar va soʻzlar joyida — qulay paytda qayting.", "Davom etish"]), []),
    info("social.family_invite", "social", false, "Приглашение в семью", "Family invitation", [inviter], TT(["{inviter_name} зовёт заниматься вместе", "Присоединяйтесь к семейному графику TilHero.", "Принять"], ["{inviter_name} birga shugʻullanishga taklif qilmoqda", "TilHero oilaviy jadvaliga qoʻshiling.", "Qabul qilish"]), []),
    info("support.reply", "support", false, "Ответ поддержки", "Support reply", [tck], TT(["Ответ по обращению {ticket_number}", "Поддержка TilHero ответила на ваше обращение.", "Открыть"], ["{ticket_number} murojaatiga javob", "TilHero yordam xizmati murojaatingizga javob berdi.", "Ochish"]), []),
    info("release_note.published", "product", false, "«Что нового» опубликовано", "“What’s new” published", [note, name], TT(["Новое в TilHero", "{note_title}. Откройте приложение, чтобы посмотреть.", "Посмотреть"], ["TilHeroda yangilik", "{note_title}. Koʻrish uchun ilovani oching.", "Koʻrish"]), []),
  ];
}

/* ---------------------------------------------------------------- campaigns */

export function campaigns(): Campaign[] {
  const stats = (o: Partial<Campaign["stats"]> = {}): Campaign["stats"] => ({ audience: 0, created: 0, sent: 0, in_app_only: 0, deferred: 0, skipped_frequency: 0, failed: 0, ...o });
  const base = {
    created_by: ID.comms,
    created_by_name: "Дилноза",
    scheduled_by: null as string | null,
    scheduled_at: null as string | null,
    started_at: null as string | null,
    finished_at: null as string | null,
    stopped_by: null as string | null,
    stopped_at: null as string | null,
    stop_reason: null as string | null,
  };
  return [
    {
      ...base,
      campaign_id: "e1000000-0000-4000-8000-000000000003",
      title: "Ноябрь: вернуться к урокам",
      texts: TT(["{learner_name}, вас ждёт новый урок", "Мы добавили уроки про путешествия. 20 минут — и вы закажете кофе в Лондоне.", "Открыть урок"], ["{learner_name}, yangi dars kutmoqda", "Sayohat haqida darslar qoʻshdik. 20 daqiqa — va Londonda qahva buyurtma qilasiz.", "Darsni ochish"]),
      route: "lessons",
      segment: { ui_lang: ["ru", "uz"], age: ["adults"], onboarded: true, active_days: -14 },
      status: "draft",
      version: 2,
      send_at: null,
      created_at: iso(-1 * DAY),
      updated_at: iso(-2 * HOUR),
      stats: stats(),
    },
    {
      ...base,
      campaign_id: "e1000000-0000-4000-8000-000000000002",
      title: "Голосовые уроки — скоро",
      texts: TT(["Скоро: говорим вслух", "В декабре в TilHero появятся голосовые уроки. Следите за новостями!", null], ["Tez orada: ovoz chiqarib gapiramiz", "Dekabrda TilHeroda ovozli darslar paydo boʻladi. Yangiliklarni kuzatib boring!", null]),
      route: "news",
      segment: { age: ["teens", "adults"] },
      status: "scheduled",
      version: 4,
      send_at: iso(2 * DAY),
      scheduled_by: ID.comms,
      scheduled_at: iso(-3 * HOUR),
      created_at: iso(-3 * DAY),
      updated_at: iso(-3 * HOUR),
      stats: stats({ audience: 1840 }),
    },
    {
      ...base,
      campaign_id: "e1000000-0000-4000-8000-000000000001",
      title: "Новый раздел «Семья»",
      texts: TT(["Занимайтесь всей семьёй", "Добавьте детей и смотрите их прогресс в одном месте.", "Открыть «Семью»"], ["Butun oila bilan shugʻullaning", "Bolalarni qoʻshing va ularning yutuqlarini bir joyda kuzating.", "«Oila»ni ochish"]),
      route: "family",
      segment: { ui_lang: ["ru", "uz"], age: ["adults"] },
      status: "done",
      version: 6,
      send_at: iso(-9 * DAY),
      scheduled_by: ID.comms,
      scheduled_at: iso(-10 * DAY),
      started_at: iso(-9 * DAY),
      finished_at: iso(-9 * DAY + 3 * HOUR),
      created_at: iso(-12 * DAY),
      updated_at: iso(-9 * DAY),
      stats: stats({ audience: 2410, created: 2288, sent: 2051, in_app_only: 203, deferred: 0, skipped_frequency: 122, failed: 34 }),
    },
  ];
}

/* ---------------------------------------------------------------- audit */

export function auditRecords(): AuditRecord[] {
  const rec = (seq: number, minAgo: number, action: string, actor: string | null, role: string | null, ot: string | null, oid: string | null, reason: string | null, extra: Partial<AuditRecord> = {}): AuditRecord => ({
    seq,
    record_id: `ad000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    occurred_at: iso(-minAgo * MIN),
    recorded_at: iso(-minAgo * MIN + 800),
    source: ot === "release_note" || ot === "config" ? "experience-config" : ot === "campaign" || ot === "notification_template" ? "notifications" : ot === "learner" ? "identity-consent" : ot === "ticket" ? "support" : "admin-identity",
    actor_type: actor ? "staff" : "system",
    actor_id: actor,
    actor_role: role,
    action,
    object_type: ot,
    object_id: oid,
    before: null,
    after: null,
    reason,
    ip: "10.12.0.4",
    session_id: "s-7f3a",
    trace_id: `tr-${seq}`,
    prev_hash: (seq * 7919 - 1).toString(16).padStart(64, "f"),
    hash: (seq * 7919).toString(16).padStart(64, "f"),
    ...extra,
  });
  return [
    rec(1009, 12, "sensitive.view", ID.admin, "super_admin", "learner", LEARNER.madina, "Обращение ученика — TCK-1042: сверяем аккаунт"),
    rec(1008, 45, "release_note.update", ID.comms, "communications", "release_note", "d1000000-0000-4000-8000-000000000003", null, { before: { version: 2 }, after: { version: 3 } }),
    rec(1007, 120, "template.activated", ID.comms, "communications", "notification_template", "reminder.lesson", "Короче и с повторением в начале", { after: { version: 2 } }),
    rec(1006, 180, "campaign.scheduled", ID.comms, "communications", "campaign", "e1000000-0000-4000-8000-000000000002", "Анонс голосовых уроков"),
    rec(1005, 240, "ticket.reply", ID.support, "support", "ticket", "b1000000-0000-4000-8000-000000001043", null),
    rec(1004, 600, "config.activate", ID.ops, "operations", "config", "miniapp:1.0.0", "Первая версия TilHero"),
    rec(1003, 1440, "auth.login", ID.admin, "super_admin", "staff", ID.admin, null),
    rec(1002, 2880, "staff.created", ID.admin, "super_admin", "staff", ID.comms, "Команда коммуникаций", { after: { role: "communications" } }),
    rec(1001, 4320, "staff.bootstrap", null, null, "staff", ID.admin, null),
  ];
}

/* ---------------------------------------------------------------- experience config payloads */

export const MINI_TOKENS = {
  "--paper": "#FBFCFE", "--grid": "#E8ECF5", "--ink": "#1C2340", "--ink2": "#4A5272", "--line": "#E1E6F2",
  "--card": "#FFFFFF", "--pen": "#2F4BE0", "--pen-ink": "#FFFFFF", "--pen-soft": "#E9EDFF", "--mark": "#FFE45C",
  "--margin": "#F2A7B0", "--err": "#C8323C", "--err-soft": "#FDECEE", "--ok": "#1E7A4F", "--ok-soft": "#E3F3EA",
  "--warn": "#8F5300", "--warn-soft": "#FFF1D6", "--scrim": "rgba(18,22,44,.45)",
  "--r-card": "14px", "--r-btn": "12px", "--r-field": "12px", "--r-sheet": "22px", "--gutter": "18px",
  "--font-display": "Unbounded", "--font-body": "Onest", "--font-hand": "Caveat",
};
export const SECTIONS = ["today_plan", "lesson_of_day", "review", "whats_new", "family", "news"].map((t, i) => ({ type: t, key: t, variant: i < 2 ? "large" : "compact", enabled: true }));
export const miniPayload = (version: string, pen = "#2F4BE0") => ({
  theme: { id: "notebook", version, tokens: { ...MINI_TOKENS, "--pen": pen } },
  home: { sections: SECTIONS },
  flags: { whats_new_on_login: true, news: true, family_invites: true, uz_ui: true, voice_lesson: false },
});
export const ADMIN_TOKENS = {
  "--bg": "#F4F6FB", "--card": "#FFFFFF", "--ink": "#1C2340", "--ink2": "#4A5272", "--line": "#E1E6F2",
  "--pen": "#2F4BE0", "--pen-soft": "#E9EDFF", "--side": "#1C2340", "--side2": "#B9C0DA",
  "--ok": "#1E7A4F", "--ok-soft": "#E3F3EA", "--warn": "#8F5300", "--warn-soft": "#FFF1D6", "--err": "#C8323C", "--err-soft": "#FDECEE",
  "--r-card": "14px", "--r-btn": "10px", "--r-field": "10px", "--nav-w": "236px",
  "--font-ui": "Onest,system-ui,sans-serif", "--font-display": "Unbounded,sans-serif", "--font-mono": "ui-monospace,SFMono-Regular,Menlo,monospace",
};
export const MENU_IDS = ["overview", "users", "content", "agents", "qa", "costs", "heroes", "game", "events", "news", "support", "config", "langs", "roles", "audit"];
export const adminPayload = (version: string, extra: { density?: "compact" | "comfortable"; off?: string[]; pen?: string } = {}) => ({
  theme: { id: "admin_light", version, tokens: { ...ADMIN_TOKENS, ...(extra.pen ? { "--pen": extra.pen } : {}) } },
  layout: { density: extra.density ?? "compact", menu: MENU_IDS.map((id) => ({ id, enabled: !(extra.off ?? []).includes(id) })) },
  flags: {},
});

export type { TicketPriority, TicketStatus };

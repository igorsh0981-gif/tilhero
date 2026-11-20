import type {
  ConsentState,
  ExperienceConfig,
  InboxItem,
  LearnerSummary,
  LearningPlan,
  NotificationSettings,
  PolicyDocument,
  SecurityState,
  UiLang,
  UserSummary,
  WhatsNewNote,
} from "@tilhero/contracts/bff";

/** Fixtures of the mock telegram-bff (shapes: packages/contracts/src/bff.ts). */
export const ACCOUNT_ID = "6f1c2b3a-1111-4a2b-9c3d-000000000001";
export const NOW = () => new Date().toISOString();

export function account(over: Partial<UserSummary> = {}): UserSummary {
  return {
    user_id: ACCOUNT_ID,
    display_name: "Азиз",
    username: "aziz_demo",
    locale: "ru",
    status: "ACTIVE",
    is_new: true,
    age_band: null,
    guardian_consent: "not_required",
    ...over,
  };
}

export function selfLearner(over: Partial<LearnerSummary> = {}): LearnerSummary {
  return { learner_id: ACCOUNT_ID, kind: "self", display_name: "Азиз", age_band: null, is_active: true, onboarding_completed: false, voice_consent: false, ...over };
}

export function security(over: Partial<SecurityState> = {}): SecurityState {
  return { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null, pin_reset_effective_at: null, ...over };
}

export const POLICY_VERSION = "1.2";

export function consent(accepted: boolean, purposes: string[] = ["terms", "privacy", "learning"]): ConsentState {
  return {
    accepted,
    policy_version: accepted ? POLICY_VERSION : null,
    current_policy_version: POLICY_VERSION,
    accepted_at: accepted ? "2026-11-10T08:00:00Z" : null,
    evidence_hash: accepted ? "9f2c41d0a7b3e5f1c2d4" : null,
    purposes: accepted ? purposes : [],
  };
}

export function settings(over: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    enabled: true,
    categories: { reminders: false, missed: false, social: false, support: true, product: false },
    quiet_hours: { start: "22:00", end: "08:00" },
    timezone: "Asia/Tashkent",
    ...over,
  };
}

export function plan(learnerId: string, over: Partial<LearningPlan> = {}): LearningPlan {
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
    updated_at: "2026-11-17T08:00:00Z",
    version: 1,
    ...over,
  };
}

export function onboardedPlan(learnerId: string): LearningPlan {
  return plan(learnerId, {
    goal: "travel",
    level_self: "beginner",
    schedule: { preset: "three_per_week", days: [1, 3, 5], preferred_time: "19:00", duration_min: 20, reminders_enabled: true, timezone: "Asia/Tashkent" },
    onboarding_completed_at: "2026-11-10T08:00:00Z",
    version: 4,
  });
}

export function policy(lang: UiLang): PolicyDocument {
  const ru = lang === "ru";
  return {
    version: POLICY_VERSION,
    purposes: [
      { code: "terms", required: true, title: ru ? "Условия использования" : "Foydalanish shartlari", description: "" },
      { code: "privacy", required: true, title: ru ? "Политика конфиденциальности" : "Maxfiylik siyosati", description: "" },
      { code: "learning", required: true, title: ru ? "Обработка данных для обучения" : "Oʻqish uchun maʼlumotlarga ishlov berish", description: "" },
      { code: "voice_recording", required: false, title: ru ? "Хранить записи голоса 30 дней" : "Ovoz yozuvlarini 30 kun saqlash", description: ru ? "Чтобы точнее оценивать произношение" : "Talaffuzni aniqroq baholash uchun" },
      { code: "social", required: false, title: ru ? "Семья и друзья" : "Oila va doʻstlar", description: ru ? "Приглашения и общие занятия" : "Takliflar va birgalikdagi mashgʻulotlar" },
      { code: "product_news", required: false, title: ru ? "Новости TilHero" : "TilHero yangiliklari", description: ru ? "Не чаще раза в неделю" : "Haftasiga bir martadan koʻp emas" },
    ],
    text: ru
      ? "# Политика конфиденциальности\n\nМы обрабатываем данные, чтобы вести ваше обучение.\n\nЗаписи голоса храним 30 дней только с вашего согласия."
      : "# Maxfiylik siyosati\n\nMaʼlumotlarga oʻqishingizni yuritish uchun ishlov beramiz.\n\nOvoz yozuvlarini faqat roziligingiz bilan 30 kun saqlaymiz.",
  };
}

export const GOALS = [
  { code: "work", label: { ru: "Работа", uz: "Ish" }, icon: null },
  { code: "career", label: { ru: "Карьера", uz: "Martaba" }, icon: null },
  { code: "travel", label: { ru: "Путешествия", uz: "Sayohat" }, icon: null },
  { code: "daily", label: { ru: "Общение каждый день", uz: "Har kungi muloqot" }, icon: null },
  { code: "study", label: { ru: "Учёба", uz: "Oʻqish" }, icon: null },
  { code: "exam", label: { ru: "Экзамен", uz: "Imtihon" }, icon: null },
];

/** learning-plan seed (services/learning-plan/src/tilhero_learning_plan/directory.py): 12 topics, RU/UZ */
export const TOPICS = [
  { code: "small_talk", label: { ru: "Знакомство и разговор", uz: "Tanishuv va suhbat" }, icon: "chat" },
  { code: "travel", label: { ru: "Поездки и транспорт", uz: "Sayohat va transport" }, icon: "globe" },
  { code: "food", label: { ru: "Кафе и еда", uz: "Kafe va taomlar" }, icon: "food" },
  { code: "shopping", label: { ru: "Покупки", uz: "Xaridlar" }, icon: "bag" },
  { code: "work", label: { ru: "Работа и офис", uz: "Ish va ofis" }, icon: "briefcase" },
  { code: "interview", label: { ru: "Собеседование", uz: "Ish suhbati" }, icon: "trophy" },
  { code: "study", label: { ru: "Учёба", uz: "Oʻqish" }, icon: "book" },
  { code: "health", label: { ru: "Здоровье и врач", uz: "Salomatlik va shifokor" }, icon: "heart" },
  { code: "home", label: { ru: "Дом и семья", uz: "Uy va oila" }, icon: "home" },
  { code: "hobbies", label: { ru: "Хобби и спорт", uz: "Sevimli mashgʻulot va sport" }, icon: "ball" },
  { code: "movies", label: { ru: "Фильмы и музыка", uz: "Kino va musiqa" }, icon: "music" },
  { code: "tech", label: { ru: "Технологии", uz: "Texnologiyalar" }, icon: "spark" },
];

/** experience-config seed miniapp 1.0.0 (services/experience-config/migrations/versions/0002_seed.py) */
export const CONFIG: ExperienceConfig = {
  app: "miniapp",
  version: "1.0.0",
  theme: {
    id: "notebook",
    version: "1.0.0",
    tokens: {
      "--paper": "#FBFCFE", "--grid": "#E8ECF5", "--ink": "#1C2340", "--ink2": "#4A5272", "--line": "#E1E6F2",
      "--card": "#FFFFFF", "--pen": "#2F4BE0", "--pen-ink": "#FFFFFF", "--pen-soft": "#E9EDFF", "--mark": "#FFE45C",
      "--margin": "#F2A7B0", "--err": "#C8323C", "--err-soft": "#FDECEE", "--ok": "#1E7A4F", "--ok-soft": "#E3F3EA",
      "--warn": "#8F5300", "--warn-soft": "#FFF1D6", "--scrim": "rgba(18,22,44,.45)",
      "--r-card": "14px", "--r-btn": "12px", "--r-field": "12px", "--r-sheet": "22px", "--gutter": "18px",
      "--font-display": "Unbounded", "--font-body": "Onest", "--font-hand": "Caveat",
    },
  },
  home: {
    sections: [
      { type: "today_plan", key: "today_plan", variant: "large", enabled: true },
      { type: "lesson_of_day", key: "lesson_of_day", variant: "large", enabled: true },
      { type: "review", key: "review", variant: "compact", enabled: true },
      { type: "whats_new", key: "whats_new", variant: "compact", enabled: true },
      { type: "family", key: "family", variant: "compact", enabled: true },
      { type: "news", key: "news", variant: "compact", enabled: true },
    ],
  },
  flags: { whats_new_on_login: true, news: true, family_invites: true, uz_ui: true, voice_lesson: false },
};

/** Release notes: welcome-1 (audience new, 5 items) and two updates (existing / all). Texts per language. */
export interface NoteSeed {
  id: string;
  slug: string;
  audience: "new" | "existing" | "all";
  published_at: string;
  title: Record<UiLang, string>;
  items: Array<{ title: Record<UiLang, string>; text: Record<UiLang, string>; link: WhatsNewNote["items"][number]["link"]; icon: WhatsNewNote["items"][number]["icon"] }>;
}

export const WELCOME: NoteSeed = {
  id: "11111111-aaaa-4bbb-8ccc-000000000001",
  slug: "welcome-1",
  audience: "new",
  published_at: "2026-11-01T06:00:00Z",
  title: { ru: "Знакомство", uz: "Tanishuv" },
  items: [
    { title: { ru: "Герой растёт за навыки", uz: "Qahramon koʻnikmalar uchun oʻsadi" }, text: { ru: "Не за монеты и не за серию — только за то, что вы правда умеете.", uz: "Tangalar yoki seriya uchun emas — faqat haqiqatan uddalaganingiz uchun." }, link: null, icon: "hero" },
    { title: { ru: "Урок 20 минут", uz: "20 daqiqalik dars" }, text: { ru: "Повторение, объяснение, разговор, проверка и итоги.", uz: "Takrorlash, tushuntirish, suhbat, tekshiruv va xulosa." }, link: "lessons", icon: "book" },
    { title: { ru: "Повторения", uz: "Takrorlashlar" }, text: { ru: "Фразы возвращаются через день, неделю и месяц.", uz: "Iboralar bir kun, bir hafta va bir oydan keyin qaytadi." }, link: "review", icon: "spark" },
    { title: { ru: "Ваш график и напоминания", uz: "Jadvalingiz va eslatmalar" }, text: { ru: "Дни, время и длительность меняются в профиле.", uz: "Kunlar, vaqt va davomiylik profilda oʻzgaradi." }, link: "schedule", icon: "calendar" },
    { title: { ru: "Вместе с семьёй", uz: "Oila bilan birga" }, text: { ru: "Пригласите близких по ссылке в Telegram.", uz: "Yaqinlaringizni Telegramdagi havola orqali taklif qiling." }, link: "family", icon: "users" },
  ],
};

export const UPDATE_1: NoteSeed = {
  id: "11111111-aaaa-4bbb-8ccc-000000000002",
  slug: "2026.11",
  audience: "existing",
  published_at: "2026-11-15T06:00:00Z",
  title: { ru: "Ноябрь: график", uz: "Noyabr: jadval" },
  items: [
    { title: { ru: "Свои дни занятий", uz: "Oʻz mashgʻulot kunlaringiz" }, text: { ru: "Выберите любые дни недели — напомним именно в них.", uz: "Haftaning istalgan kunlarini tanlang — aynan oʻsha kunlari eslatamiz." }, link: "schedule", icon: "calendar" },
    { title: { ru: "Тихие часы", uz: "Tinch soatlar" }, text: { ru: "Ночью не пишем — сообщение придёт утром.", uz: "Tunda yozmaymiz — xabar ertalab keladi." }, link: "notifications", icon: "bell" },
  ],
};

export const UPDATE_2: NoteSeed = {
  id: "11111111-aaaa-4bbb-8ccc-000000000003",
  slug: "2026.11.2",
  audience: "all",
  published_at: "2026-11-17T06:00:00Z",
  title: { ru: "Центр уведомлений", uz: "Bildirishnomalar markazi" },
  items: [{ title: { ru: "Все сообщения — в приложении", uz: "Barcha xabarlar — ilovada" }, text: { ru: "Даже если бот заблокирован, напоминания видны в колокольчике.", uz: "Bot bloklangan boʻlsa ham, eslatmalar qoʻngʻiroqchada koʻrinadi." }, link: null, icon: "bell" }],
};

export function toNote(n: NoteSeed, lang: UiLang): WhatsNewNote {
  return {
    release_note_id: n.id,
    slug: n.slug,
    title: n.title[lang],
    audience: n.audience,
    published_at: n.published_at,
    items: n.items.map((i) => ({ title: i.title[lang], text: i.text[lang], link: i.link, icon: i.icon })),
  };
}

export function inbox(): InboxItem[] {
  return [
    { notification_id: "22222222-aaaa-4bbb-8ccc-000000000001", category: "social", title: "Мама приняла приглашение", body: "Теперь вы в одной семье TilHero.", startapp: "route_family", created_at: "2026-11-17T15:10:00Z", read_at: null, telegram: "sent" },
    { notification_id: "22222222-aaaa-4bbb-8ccc-000000000002", category: "reminders", title: "Время занятия", body: "По графику — 20 минут английского в 19:00.", startapp: "route_home", created_at: "2026-11-17T14:00:00Z", read_at: null, telegram: "in_app_only" },
    { notification_id: "22222222-aaaa-4bbb-8ccc-000000000003", category: "support", title: "Ответ поддержки", body: "Напоминания включены, проверьте тихие часы.", startapp: "ticket_TCK-3082", created_at: "2026-11-16T09:00:00Z", read_at: "2026-11-16T10:00:00Z", telegram: "sent" },
  ];
}

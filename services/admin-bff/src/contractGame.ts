/**
 * Кодеки ответов gamification по admin.ts «Игра и герои» (спринт 6) — как contract.ts / contractMemory.ts: проверка
 * значения домена (испорченное, неизвестное значение перечисления, время без зоны → 503 UPSTREAM_UNAVAILABLE
 * {service: gamification}, в лог — путь поля без значения) и схема ответа admin-bff (лишние поля отбрасываются).
 * `C.obj<T>()` требует ровно ключи типа admin.ts — поле, добавленное в контракт или удалённое из него, ломает `tsc`;
 * списки перечислений входа (schemas.ts) сверяются с типами admin.ts / bff.ts тоже при компиляции.
 *
 * Особенности:
 *  - `AdminGameImage.url` собирает BFF: `/admin/v1/game/assets/{asset_id}/content` (значение домена не берётся);
 *  - `StaffRef` — домен отдаёт `{staff_id, name}` (имя из actor-токена) или только staff_id: имя — admin-identity
 *    staff/lookup (`withStaffRefs`), не найден — имя домена; `system` — «Система»; сид — «Сид (начальное наполнение)»;
 *  - `payload` версии правил: у `active` и `archived` — строго `GameRules` (прошли валидатор); у черновика — JSON-объект
 *    как есть (≤ 64 КБ): черновик ещё не проверен, ошибки показывает `validate` (422 RULES_INVALID с путями полей),
 *    и испорченный черновик не должен закрывать экран правил;
 *  - `diff[].from` / `to` — любые JSON-значения (≤ 16 КБ), нет поля — null;
 *  - тема предмета — ключи токенов, не CSS (`#fff`, `url(…)` → 503).
 */
import type {
  AdminGameEvent,
  AdminGameImage,
  AdminHero,
  AdminHeroFields,
  AdminLedgerOperation,
  AdminShopItem,
  AdminWallet,
  GameAmount,
  GameAudience,
  GameEventStatus,
  GameMultiplier,
  GameOverview,
  GameRules,
  GameStats,
  Period,
  QuestTemplate,
  RulesStatus,
  RulesValidation,
  RulesVersion,
  RulesVersionSummary,
  ShopItemStatus,
  StaffRef,
} from "@tilhero/contracts/admin";
import type { GameAction, GameCurrency, GameReason, HeroLine, HeroStage, QuestKind, ShopItemKind } from "@tilhero/contracts/bff";
import { C, UUID_RE, bad, cleanText, itemsOf, pageOf, type Codec, type Schema } from "./codec.js";
import type { BffContext } from "./context.js";
import type { StaffAuth } from "./http.js";
import {
  ASSET_MAX_BYTES,
  ASSET_MAX_SIDE,
  EVENT_FACTORS,
  GAME_ACTIONS,
  GAME_AUDIENCES,
  GAME_CURRENCIES,
  GAME_EVENT_STATUSES,
  GAME_REASONS,
  HERO_LINES,
  HERO_STAGES,
  LEDGER_SOURCE_KINDS,
  LEDGER_STATUSES,
  OVERVIEW_PERIODS,
  QUEST_KINDS,
  RULES_STATUSES,
  SHOP_ITEM_KINDS,
  SHOP_ITEM_STATUSES,
} from "./schemas.js";

// ---------------------------------------------------------------- перечисления: вход (schemas.ts) = admin.ts / bff.ts

type Exact<T, L extends readonly unknown[]> = [Exclude<T, L[number]>] extends [never] ? true : Exclude<T, L[number]>;
const AUDIENCES = GAME_AUDIENCES satisfies readonly GameAudience[];
const CURRENCIES = GAME_CURRENCIES satisfies readonly GameCurrency[];
const REASONS = GAME_REASONS satisfies readonly GameReason[];
const LINES = HERO_LINES satisfies readonly HeroLine[];
const STAGES = HERO_STAGES satisfies readonly HeroStage[];
const QUESTS = QUEST_KINDS satisfies readonly QuestKind[];
const ACTIONS = GAME_ACTIONS satisfies readonly GameAction[];
const SHOP_KINDS = SHOP_ITEM_KINDS satisfies readonly ShopItemKind[];
const SHOP_ST = SHOP_ITEM_STATUSES satisfies readonly ShopItemStatus[];
const RULES_ST = RULES_STATUSES satisfies readonly RulesStatus[];
const EVENT_ST = GAME_EVENT_STATUSES satisfies readonly GameEventStatus[];
const LEDGER_ST = LEDGER_STATUSES satisfies readonly AdminLedgerOperation["status"][];
const SOURCE_KINDS = LEDGER_SOURCE_KINDS satisfies readonly AdminLedgerOperation["source"]["kind"][];
const FACTORS = EVENT_FACTORS satisfies readonly GameMultiplier["factor"][];
const OV_PERIODS = OVERVIEW_PERIODS satisfies readonly GameOverview["period"][];
const _exact: [
  Exact<GameAudience, typeof AUDIENCES>,
  Exact<GameCurrency, typeof CURRENCIES>,
  Exact<GameReason, typeof REASONS>,
  Exact<HeroLine, typeof LINES>,
  Exact<HeroStage, typeof STAGES>,
  Exact<QuestKind, typeof QUESTS>,
  Exact<GameAction, typeof ACTIONS>,
  Exact<ShopItemKind, typeof SHOP_KINDS>,
  Exact<ShopItemStatus, typeof SHOP_ST>,
  Exact<RulesStatus, typeof RULES_ST>,
  Exact<GameEventStatus, typeof EVENT_ST>,
  Exact<AdminLedgerOperation["status"], typeof LEDGER_ST>,
  Exact<AdminLedgerOperation["source"]["kind"], typeof SOURCE_KINDS>,
  Exact<GameMultiplier["factor"], typeof FACTORS>,
  Exact<GameOverview["period"], typeof OV_PERIODS>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
void _exact;

// ---------------------------------------------------------------- общие

const COUNT = C.int(0);
const N_TIME = C.nullable(C.time);
/** Тексты RU/UZ (имя героя, слоган, название предмета и события) — тип и длина, как в contractContent. */
const LOCALIZED = C.obj<{ ru: string; uz: string }>({ ru: C.str(1000), uz: C.str(1000) });
const HERO_CODE = C.id(/^[a-z][a-z0-9_]{1,39}$/, 40);
const ITEM_CODE = C.id(/^[a-z0-9_]{3,40}$/, 40);
/** Код значка, шаблона задания: first_lesson, streak_7, lesson_1. */
const CODE = C.id(/^[a-z][a-z0-9_]{0,63}$/, 64);
const SHA256 = C.custom<string>({ type: "string" }, (v, p) => (typeof v === "string" && /^[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : bad(p)));
/** Ключ токена темы (admin.ts: «ссылки на токены темы, не CSS»). */
const THEME_TOKEN = C.id(/^(?:--)?[a-z][a-z0-9_.-]{0,61}$/, 64);
const AUDIENCE_LIST = C.arr(C.oneOf(AUDIENCES), 3);

/** Числовое перечисление (ступень героя 1..3, множитель 1.5 | 2 | 3). */
const numOf = <T extends number>(values: readonly T[], type: "integer" | "number"): Codec<T> =>
  C.custom<T>({ type }, (v, p) => (typeof v === "number" && (values as readonly number[]).includes(v) ? (v as T) : bad(p)));
const HERO_STAGE = numOf<HeroStage>(STAGES, "integer");

/** JSON-объект как есть (схема — любой объект: сериализатор не урезает и не приводит значения). */
const JSON_OBJECT_SCHEMA: Schema = { type: "object", additionalProperties: true };

/** Любое JSON-значение ≤ maxBytes (было / стало в diff версии правил); нет поля → null. */
const jsonValue = (maxBytes: number): Codec<unknown> =>
  C.custom<unknown>({}, (v, p) => {
    if (v === undefined || v === null) return null;
    if (!["string", "number", "boolean", "object"].includes(typeof v)) return bad(p);
    const s = JSON.stringify(v);
    return s !== undefined && s.length <= maxBytes ? v : bad(p);
  });

// ---------------------------------------------------------------- сотрудники (StaffRef)

const SYSTEM_STAFF = "system";
const SYSTEM_NAME = "Система";
const UNKNOWN_STAFF_NAME = "Сотрудник";
const STAFF_ID = (v: unknown, p: string): string =>
  typeof v === "string" && (v === SYSTEM_STAFF || UUID_RE.test(v)) ? v.toLowerCase() : bad(`${p}.staff_id`);

/**
 * StaffRef домена: `{staff_id, name}` (как admin.ts) или только staff_id (UUID | "system"). Имя дописывает
 * `withStaffRefs` (lookup → имя домена → «Система» / «Сотрудник»); до этого — имя домена или "".
 */
export const STAFF_REF: Codec<StaffRef> = C.custom<StaffRef>(
  C.obj<StaffRef>({ staff_id: C.str(36), name: C.str(120) }).schema,
  (v, p) => {
    if (typeof v === "string") return { staff_id: STAFF_ID(v, p), name: "" };
    if (!v || typeof v !== "object" || Array.isArray(v)) return bad(p);
    const o = v as Record<string, unknown>;
    if (o.name !== undefined && o.name !== null && typeof o.name !== "string") return bad(`${p}.name`);
    return { staff_id: STAFF_ID(o.staff_id, p), name: cleanText(o.name, 120) ?? "" };
  },
);

function isStaffRef(o: Record<string, unknown>): o is Record<string, unknown> & StaffRef {
  const keys = Object.keys(o);
  return keys.length === 2 && typeof o.staff_id === "string" && typeof o.name === "string";
}

function collectRefs(v: unknown, out: StaffRef[]): void {
  if (Array.isArray(v)) return v.forEach((x) => collectRefs(x, out));
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  if (isStaffRef(o)) {
    out.push(o);
    return;
  }
  for (const x of Object.values(o)) collectRefs(x, out);
}

/** Имена сотрудников в StaffRef одним запросом staff/lookup (кэш 60 с); lookup недоступен — имя домена. */
export async function withStaffRefs<T>(ctx: BffContext, auth: StaffAuth, value: T): Promise<T> {
  const refs: StaffRef[] = [];
  collectRefs(value, refs);
  if (!refs.length) return value;
  const names = await ctx.names.resolve(
    refs.map((r) => r.staff_id),
    auth,
  );
  for (const r of refs) {
    r.name = names.get(r.staff_id) ?? (r.name || (r.staff_id === SYSTEM_STAFF ? SYSTEM_NAME : UNKNOWN_STAFF_NAME));
  }
  return value;
}

/**
 * Спринт 8 (billing): имя сотрудника домен хранит сам (actor.name команды) — оно и остаётся; staff/lookup — только для
 * StaffRef с пустым именем (старые записи, имя не пришло); «system» — «Система» без запроса.
 */
export async function withDomainNames<T>(ctx: BffContext, auth: StaffAuth, value: T): Promise<T> {
  const refs: StaffRef[] = [];
  collectRefs(value, refs);
  const missing = refs.filter((r) => !r.name && r.staff_id !== SYSTEM_STAFF);
  const names = missing.length ? await ctx.names.resolve([...new Set(missing.map((r) => r.staff_id))], auth) : new Map<string, string>();
  for (const r of refs) if (!r.name) r.name = r.staff_id === SYSTEM_STAFF ? SYSTEM_NAME : (names.get(r.staff_id) ?? UNKNOWN_STAFF_NAME);
  return value;
}

// ---------------------------------------------------------------- картинки

/** Адрес картинки для админки (admin.ts AdminGameImage.url) — байты отдаёт admin-bff с правом game.read. */
export const assetContentUrl = (assetId: string): string => `/admin/v1/game/assets/${assetId.toLowerCase()}/content`;

const IMAGE_OBJ = C.obj<AdminGameImage>({
  asset_id: C.uuid,
  sha256: SHA256,
  // собирается ниже из asset_id: значение домена не используется
  url: C.custom<string>({ type: "string" }, () => ""),
  width: C.int(1, ASSET_MAX_SIDE),
  height: C.int(1, ASSET_MAX_SIDE),
  size: C.int(1, ASSET_MAX_BYTES),
});
/** Метаданные картинки домена ({asset_id, sha256, width, height, size}) → AdminGameImage с url BFF. */
export const GAME_IMAGE: Codec<AdminGameImage> = C.map(IMAGE_OBJ, IMAGE_OBJ.schema, (img) => ({ ...img, url: assetContentUrl(img.asset_id) }));

// ---------------------------------------------------------------- правила

const AMOUNT = C.obj<GameAmount>({ xp: COUNT, til: COUNT });
const TEMPLATE = C.obj<QuestTemplate>({
  code: CODE,
  kind: C.oneOf(QUESTS),
  target: COUNT,
  reward: AMOUNT,
  audiences: AUDIENCE_LIST,
  weight: C.int(0, 1000),
});
const THRESHOLDS = C.custom<[number, number, number]>({ type: "array", items: { type: "integer" } }, (v, p) => {
  const a = C.arr(COUNT, 3).parse(v, p);
  return a.length === 3 ? [a[0]!, a[1]!, a[2]!] : bad(p);
});
type Earn = GameRules["earn"];
type League = NonNullable<GameRules["league"]>;
/** Размер группы лиги [мин, макс]: два целых ≥ 1, мин ≤ макс. */
const GROUP_SIZE = C.custom<[number, number]>({ type: "array", items: { type: "integer" } }, (v, p) => {
  const a = C.arr(C.int(1, 1000), 2).parse(v, p);
  return a.length === 2 && a[0]! <= a[1]! ? [a[0]!, a[1]!] : bad(p);
});
/**
 * Правила игры (INTERNAL_API спринта 6 §1.3) строго: ровно ключи admin.ts, целые ≥ 0, известные виды заданий.
 * Спринт 7 (версия 3): `league`, `duel`, `pair_lesson` — необязательные ключи (в версиях 1–2 их нет; в черновике
 * обязательность проверяет валидатор gamification): нет у домена — нет и в ответе.
 */
export const GAME_RULES: Codec<GameRules> = C.obj<GameRules>(
  {
  earn: C.obj<Earn>({
    lesson: AMOUNT,
    lesson_passed_bonus: AMOUNT,
    lesson_practice: AMOUNT,
    scenario: AMOUNT,
    media: AMOUNT,
    reading: AMOUNT,
    review: C.obj<Earn["review"]>({ min_cards: COUNT, xp_base: COUNT, xp_per_correct_cap: COUNT, til: COUNT }),
    skill_demonstrated: AMOUNT,
    skill_retained: AMOUNT,
    skill_max_per_event: COUNT,
  }),
  caps: C.obj<GameRules["caps"]>({ xp_per_day: COUNT, til_per_day: COUNT }),
  levels: C.arr(COUNT, 100),
  hero: C.obj<GameRules["hero"]>({ stage_thresholds: THRESHOLDS }),
  freeze: C.obj<GameRules["freeze"]>({ price_til: COUNT, max_stock: COUNT }),
  bonuses: C.obj<GameRules["bonuses"]>({ registration_freeze: COUNT, referral_freeze: COUNT, referral_monthly_cap: COUNT }),
  quests: C.obj<GameRules["quests"]>({ per_day: COUNT, all_done_bonus: AMOUNT, templates: C.arr(TEMPLATE, 100) }),
  badges: C.obj<GameRules["badges"]>({ streak: C.arr(COUNT, 20), skills: C.arr(COUNT, 20), reviews_cards: C.arr(COUNT, 20), readings: C.arr(COUNT, 20) }),
  league: C.obj<League>({
    prizes: C.arr(COUNT, 30),
    group_size: GROUP_SIZE,
    anomaly: C.obj<League["anomaly"]>({ median_factor: C.num(0, 1000), min_xp: COUNT }),
  }),
  duel: C.obj<NonNullable<GameRules["duel"]>>({ win: COUNT, draw: COUNT, participation: COUNT, daily_cap: COUNT }),
  pair_lesson: C.obj<NonNullable<GameRules["pair_lesson"]>>({ xp: COUNT, min_turns: COUNT, daily_cap: COUNT }),
  },
  "league",
  "duel",
  "pair_lesson",
);

const SUMMARY_PROPS = {
  version: C.int(1),
  status: C.oneOf(RULES_ST),
  comment: C.optText(300),
  based_on: C.nullable(C.int(1)),
  created_by: STAFF_REF,
  created_at: C.time,
  validated_at: N_TIME,
  activated_by: C.nullable(STAFF_REF),
  activated_at: N_TIME,
};
export const RULES_SUMMARY: Codec<RulesVersionSummary> = C.obj<RulesVersionSummary>(SUMMARY_PROPS);
/** Список версий без payload, новые первыми (как отдал домен). */
export const RULES_LIST = itemsOf(RULES_SUMMARY, 1000);

const DIFF_ITEM = C.obj<RulesVersion["diff"][number]>({ path: C.str(300, 1), from: jsonValue(16_384), to: jsonValue(16_384) });
const versionCodec = (payload: Codec<GameRules>): Codec<RulesVersion> =>
  C.obj<RulesVersion>({ ...SUMMARY_PROPS, payload, diff: C.arr(DIFF_ITEM, 2000), updated_at: C.time });
const STRICT_PAYLOAD = C.custom<GameRules>(JSON_OBJECT_SCHEMA, (v, p) => GAME_RULES.parse(v, p));
// черновик — объект как есть (тип контракта — для формы admin-web; проверяет `validate` gamification)
const DRAFT_PAYLOAD = C.custom<GameRules>(JSON_OBJECT_SCHEMA, (v, p) => C.json(65_536).parse(v, p) as unknown as GameRules);
const RULES_VERSION_STRICT = versionCodec(STRICT_PAYLOAD);
const RULES_VERSION_DRAFT = versionCodec(DRAFT_PAYLOAD);
/** Версия правил + diff с активной: payload активной и архивной — строго, черновика — как есть. */
export const RULES_VERSION: Codec<RulesVersion> = C.custom<RulesVersion>(RULES_VERSION_STRICT.schema, (v, p) =>
  ((v as { status?: unknown } | null)?.status === "draft" ? RULES_VERSION_DRAFT : RULES_VERSION_STRICT).parse(v, p),
);

const ISSUE = C.obj<RulesValidation["errors"][number]>({ path: C.str(300), code: C.id(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 64) });
export const RULES_VALIDATION: Codec<RulesValidation> = C.obj<RulesValidation>({ ok: C.bool, errors: C.arr(ISSUE, 1000), warnings: C.arr(ISSUE, 1000) });

// ---------------------------------------------------------------- герои

type StageImage = AdminHero["images"][number];
const STAGE_IMAGE = C.obj<StageImage>({ stage: HERO_STAGE, image: GAME_IMAGE });
const HERO_FIELDS_PROPS = {
  name: LOCALIZED,
  tagline: LOCALIZED,
  audiences: AUDIENCE_LIST,
  stages: C.arr(C.obj<AdminHeroFields["stages"][number]>({ stage: HERO_STAGE, name: LOCALIZED, asset_id: C.uuid }), 3),
};
const HERO_DRAFT = C.obj<NonNullable<AdminHero["draft"]>>({ ...HERO_FIELDS_PROPS, images: C.arr(STAGE_IMAGE, 3), updated_at: C.time });
export const ADMIN_HERO: Codec<AdminHero> = C.obj<AdminHero>({
  ...HERO_FIELDS_PROPS,
  code: HERO_CODE,
  line: C.oneOf(LINES),
  order: C.int(0, 10_000),
  version: COUNT,
  published_at: N_TIME,
  published_by: C.nullable(STAFF_REF),
  images: C.arr(STAGE_IMAGE, 3),
  draft: C.nullable(HERO_DRAFT),
  learners: COUNT,
});
export const HERO_LIST = itemsOf(ADMIN_HERO, 200);

// ---------------------------------------------------------------- магазин

export const ADMIN_SHOP_ITEM: Codec<AdminShopItem> = C.obj<AdminShopItem>({
  code: ITEM_CODE,
  kind: C.oneOf(SHOP_KINDS),
  title: LOCALIZED,
  description: LOCALIZED,
  image: C.nullable(GAME_IMAGE),
  theme: C.nullable(C.obj<NonNullable<AdminShopItem["theme"]>>({ bg: THEME_TOKEN, accent: THEME_TOKEN })),
  price_til: C.int(1, 10_000),
  audiences: AUDIENCE_LIST,
  available_from: N_TIME,
  available_until: N_TIME,
  status: C.oneOf(SHOP_ST),
  order: C.int(0, 100_000),
  owners: COUNT,
  updated_at: C.time,
});
export const SHOP_ITEM_LIST = itemsOf(ADMIN_SHOP_ITEM, 500);

// ---------------------------------------------------------------- кошельки и реестр

type Wallet = AdminWallet;
export const ADMIN_WALLET: Codec<Wallet> = C.obj<Wallet>({
  user_id: C.uuid,
  audience: C.oneOf(AUDIENCES),
  level: C.int(0, 10_000),
  xp_total: COUNT,
  til_balance: COUNT,
  freeze_stock: COUNT,
  hero: C.nullable(C.obj<NonNullable<Wallet["hero"]>>({ code: HERO_CODE, stage: HERO_STAGE })),
  confirmed_skills: COUNT,
  owned_items: C.arr(
    C.obj<Wallet["owned_items"][number]>({ code: ITEM_CODE, kind: C.oneOf(SHOP_KINDS), purchased_at: C.time, purchase_id: C.uuid }),
    1000,
  ),
  quests_today: C.arr(
    C.obj<Wallet["quests_today"][number]>({
      code: CODE,
      kind: C.oneOf(QUESTS),
      target: COUNT,
      progress: COUNT,
      // admin.ts — string; статусы заданий дня (bff.ts Quest)
      status: C.oneOf(["active", "completed", "expired"] as const),
    }),
    10,
  ),
  badges: C.arr(C.obj<Wallet["badges"][number]>({ code: CODE, earned_at: C.time }), 500),
  referrals: C.obj<Wallet["referrals"]>({ pending: COUNT, rewarded: COUNT, capped: COUNT }),
  settings: C.obj<Wallet["settings"]>({ auto_freeze: C.bool, quests_hidden: C.bool }),
});

/** Кто провёл операцию: system | learner | staff:<uuid> (admin.ts). */
const LEDGER_ACTOR = C.custom<string>({ type: "string" }, (v, p) =>
  typeof v === "string" && /^(?:system|learner|staff:[0-9a-fA-F-]{36})$/.test(v) && (!v.startsWith("staff:") || UUID_RE.test(v.slice(6)))
    ? v.toLowerCase()
    : bad(p),
);
/** Сумма операции: целое ≠ 0 (знак — направление). */
const AMOUNT_SIGNED = C.custom<number>({ type: "integer" }, (v, p) =>
  typeof v === "number" && Number.isSafeInteger(v) && v !== 0 && Math.abs(v) <= 10_000_000 ? v : bad(p),
);
export const LEDGER_OPERATION: Codec<AdminLedgerOperation> = C.obj<AdminLedgerOperation>({
  op_id: C.uuid,
  currency: C.oneOf(CURRENCIES),
  amount: AMOUNT_SIGNED,
  reason: C.oneOf(REASONS),
  source: C.obj<AdminLedgerOperation["source"]>({ kind: C.oneOf(SOURCE_KINDS), ref: C.id(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 128) }),
  rules_version: C.nullable(C.int(1)),
  multiplier: C.num(0, 100),
  capped: C.bool,
  local_date: C.date,
  status: C.oneOf(LEDGER_ST),
  reversed_by: C.nullable(C.uuid),
  reversal_of: C.nullable(C.uuid),
  actor: LEDGER_ACTOR,
  // комментарий сотрудника (ручная операция) — только в админке; ученику не показывается
  comment: C.nullable(C.multiline(300, true)),
  created_at: C.time,
});
export const LEDGER_PAGE = pageOf(LEDGER_OPERATION, 200);
/** Возврат покупки → обратные записи её операций. */
export const REFUND_RESULT: Codec<{ operations: AdminLedgerOperation[] }> = C.obj<{ operations: AdminLedgerOperation[] }>({
  operations: C.arr(LEDGER_OPERATION, 20),
});

// ---------------------------------------------------------------- события недели

export const ADMIN_GAME_EVENT: Codec<AdminGameEvent> = C.obj<AdminGameEvent>({
  code: ITEM_CODE,
  title: LOCALIZED,
  description: LOCALIZED,
  starts_at: C.time,
  ends_at: C.time,
  audiences: AUDIENCE_LIST,
  multipliers: C.arr(
    C.obj<GameMultiplier>({ action: C.oneOf(ACTIONS), currency: C.oneOf(["xp", "til"] as const), factor: numOf(FACTORS, "number") }),
    5,
  ),
  event_id: C.uuid,
  status: C.oneOf(EVENT_ST),
  created_by: STAFF_REF,
  published_by: C.nullable(STAFF_REF),
  updated_at: C.time,
});
export const GAME_EVENT_LIST = itemsOf(ADMIN_GAME_EVENT, 500);

// ---------------------------------------------------------------- обзор

export const GAME_OVERVIEW: Codec<GameOverview> = C.obj<GameOverview>({
  period: C.oneOf(OV_PERIODS),
  active_rules_version: C.int(1),
  earned: AMOUNT,
  spent_til: COUNT,
  freezes: C.obj<GameOverview["freezes"]>({ granted: COUNT, bought: COUNT, used: COUNT }),
  quests_completed: COUNT,
  badges_earned: COUNT,
  purchases: COUNT,
  by_audience: C.arr(
    C.obj<GameOverview["by_audience"][number]>({ audience: C.oneOf(AUDIENCES), earned_xp: COUNT, earned_til: COUNT, quests_completed: COUNT }),
    10,
  ),
  active_events: C.arr(C.obj<GameOverview["active_events"][number]>({ event_id: C.uuid, title: LOCALIZED, ends_at: C.time }), 50),
});

/** Блок главной (admin.ts GameStats). */
export const GAME_STATS: Codec<GameStats> = C.obj<GameStats>({
  period: C.oneOf<Period>(["today", "7d", "30d"]),
  earned_xp: COUNT,
  earned_til: COUNT,
  freezes_used: COUNT,
  quests_completed: COUNT,
  active_event: C.nullable(C.obj<NonNullable<GameStats["active_event"]>>({ title: LOCALIZED, ends_at: C.time })),
});

/**
 * Период обзора gamification для периода главной: у gamification итоги 7 и 30 дней (`daily_stats`), «сегодня» нет —
 * блок показывает 7 дней (INTERNAL_API §10: «XP и тилы за 7 дней …»), `GameStats.period` — фактический период.
 */
export const overviewPeriodOf = (p: Period): GameOverview["period"] => (p === "30d" ? "30d" : "7d");

/** GameOverview → GameStats: активное событие — то, что заканчивается раньше всех. */
export function gameStatsOf(o: GameOverview): GameStats {
  const next = [...o.active_events].sort((a, b) => Date.parse(a.ends_at) - Date.parse(b.ends_at))[0];
  return {
    period: o.period,
    earned_xp: o.earned.xp,
    earned_til: o.earned.til,
    freezes_used: o.freezes.used,
    quests_completed: o.quests_completed,
    active_event: next ? { title: next.title, ends_at: next.ends_at } : null,
  };
}

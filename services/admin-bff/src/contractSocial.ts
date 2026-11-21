/**
 * Кодеки ответов раздела «Социальное» admin.ts (спринт 7): social (друзья и жалобы, модерация, реферальные кампании и
 * очередь проверки), gamification (лиги недели и дуэли), lessons (парные комнаты) — как contractGame.ts: проверка
 * значения домена (испорченное, неизвестное значение перечисления, время без зоны → 503 UPSTREAM_UNAVAILABLE
 * {service}, в лог — путь поля без значения) и схема ответа admin-bff. `C.obj<T>()` требует ровно ключи типа admin.ts —
 * поле, добавленное в контракт или удалённое из него, ломает `tsc`; перечисления входа (schemas.ts) сверяются с типами
 * admin.ts / bff.ts тоже при компиляции.
 *
 * Приватность (admin.ts «Социальное», INTERNAL_API спринта 7 §1.3, §3.2):
 *  - лишние поля доменов отбрасываются: переписка, реплики, тексты ходов, оценки и отчёты участников комнат, ники и
 *    идентификаторы второй стороны заявки в друзья в ответ admin-bff не попадают никогда — только ключи контракта;
 *  - ник — только буквы, цифры и «_» (как валидатор social), иначе 503: разметка и управляющие символы не проходят;
 *  - тексты сотрудников (основание, причина, заметка) и ученика (комментарий жалобы, текст обжалования) — без
 *    управляющих символов, кроме перевода строки и табуляции, в пределах длины контракта.
 * StaffRef — общий кодек и имена из contractGame.ts (`STAFF_REF`, `withStaffRefs`).
 */
import type {
  AdminCase,
  AdminCaseRow,
  AdminDuel,
  AdminDuelRow,
  AdminLeagueGroup,
  AdminLeagueGroupRow,
  AdminLeagueMember,
  AdminLeagueResult,
  AdminLeagueWeek,
  AdminPairRoom,
  AdminPairRoomParticipant,
  AdminPairRoomRow,
  AdminReferral,
  AdminReferralRow,
  AdminSanction,
  AdminSanctionAppeal,
  AdminSocialCard,
  CaseStatus,
  DuelResult,
  LeagueGroupStatus,
  Localized,
  ModerationAction,
  Period,
  Permission,
  ReferralCampaignPayload,
  ReferralCampaignStats,
  ReferralCampaignStatus,
  ReferralCampaignSummary,
  ReferralCampaignVersion,
  ReferralRejectRequest,
  ReferralRiskFlag,
  SocialStats,
} from "@tilhero/contracts/admin";
import type {
  ComplaintReason,
  ComplaintSubjectKind,
  DuelScore,
  DuelStatus,
  FriendRequestStatus,
  LeagueLevelBand,
  PairEndReason,
  PairRole,
  PairRoomEventKind,
  PairRoomMode,
  PairRoomStatus,
  ReferralRejectCode,
  ReferralReward,
  ReferralRewardOutcome,
  ReferralStatus,
  SanctionAppealStatus,
  SanctionKind,
} from "@tilhero/contracts/bff";
import { C, bad, itemsOf, pageOf, type Codec, type Schema } from "./codec.js";
import { RULES_VALIDATION, STAFF_REF } from "./contractGame.js";
import {
  CASE_STATUSES,
  COMPLAINT_REASONS,
  COMPLAINT_SUBJECT_KINDS,
  DUEL_RESULTS,
  DUEL_STAFF_RESULTS,
  DUEL_STATUSES,
  FRIEND_REQUEST_STATUSES,
  LEAGUE_GROUP_STATUSES,
  LEAGUE_LEVEL_BANDS,
  MODERATION_ACTIONS,
  PAIR_END_REASONS,
  PAIR_ROLES,
  PAIR_ROOM_EVENT_KINDS,
  PAIR_ROOM_MODES,
  PAIR_ROOM_STATUSES,
  REFERRAL_CAMPAIGN_STATUSES,
  REFERRAL_REJECT_CODES,
  REFERRAL_REWARD_OUTCOMES,
  REFERRAL_RISK_FLAGS,
  REFERRAL_STAFF_REJECT_CODES,
  REFERRAL_STATUSES,
  SANCTION_APPEAL_STATUSES,
  SANCTION_KINDS,
} from "./schemas.js";

// ---------------------------------------------------------------- перечисления: вход (schemas.ts) = admin.ts / bff.ts

type Exact<T, L extends readonly unknown[]> = [Exclude<T, L[number]>] extends [never] ? true : Exclude<T, L[number]>;
const CASE_ST = CASE_STATUSES satisfies readonly CaseStatus[];
const ACTIONS = MODERATION_ACTIONS satisfies readonly ModerationAction[];
const SUBJECTS = COMPLAINT_SUBJECT_KINDS satisfies readonly ComplaintSubjectKind[];
const REASONS = COMPLAINT_REASONS satisfies readonly ComplaintReason[];
const SANCTION_K = SANCTION_KINDS satisfies readonly SanctionKind[];
const APPEAL_ST = SANCTION_APPEAL_STATUSES satisfies readonly SanctionAppealStatus[];
const REQUEST_ST = FRIEND_REQUEST_STATUSES satisfies readonly FriendRequestStatus[];
const REFERRAL_ST = REFERRAL_STATUSES satisfies readonly ReferralStatus[];
const REJECT_CODES = REFERRAL_REJECT_CODES satisfies readonly ReferralRejectCode[];
const STAFF_REJECT = REFERRAL_STAFF_REJECT_CODES satisfies readonly ReferralRejectRequest["reject_code"][];
const RISK = REFERRAL_RISK_FLAGS satisfies readonly ReferralRiskFlag[];
const REWARD_OUTCOMES = REFERRAL_REWARD_OUTCOMES satisfies readonly ReferralRewardOutcome[];
const CAMPAIGN_ST = REFERRAL_CAMPAIGN_STATUSES satisfies readonly ReferralCampaignStatus[];
const BANDS = LEAGUE_LEVEL_BANDS satisfies readonly LeagueLevelBand[];
const GROUP_ST = LEAGUE_GROUP_STATUSES satisfies readonly LeagueGroupStatus[];
const DUEL_ST = DUEL_STATUSES satisfies readonly DuelStatus[];
const RESULTS = DUEL_RESULTS satisfies readonly DuelResult[];
const STAFF_RESULTS = DUEL_STAFF_RESULTS satisfies readonly Exclude<DuelResult, "none">[];
const ROOM_ST = PAIR_ROOM_STATUSES satisfies readonly PairRoomStatus[];
const MODES = PAIR_ROOM_MODES satisfies readonly PairRoomMode[];
const END_REASONS = PAIR_END_REASONS satisfies readonly PairEndReason[];
const EVENT_KINDS = PAIR_ROOM_EVENT_KINDS satisfies readonly PairRoomEventKind[];
const ROLES = PAIR_ROLES satisfies readonly PairRole[];
const _exact: [
  Exact<CaseStatus, typeof CASE_ST>,
  Exact<ModerationAction, typeof ACTIONS>,
  Exact<ComplaintSubjectKind, typeof SUBJECTS>,
  Exact<ComplaintReason, typeof REASONS>,
  Exact<SanctionKind, typeof SANCTION_K>,
  Exact<SanctionAppealStatus, typeof APPEAL_ST>,
  Exact<FriendRequestStatus, typeof REQUEST_ST>,
  Exact<ReferralStatus, typeof REFERRAL_ST>,
  Exact<ReferralRejectCode, typeof REJECT_CODES>,
  Exact<ReferralRejectRequest["reject_code"], typeof STAFF_REJECT>,
  Exact<ReferralRiskFlag, typeof RISK>,
  Exact<ReferralRewardOutcome, typeof REWARD_OUTCOMES>,
  Exact<ReferralCampaignStatus, typeof CAMPAIGN_ST>,
  Exact<LeagueLevelBand, typeof BANDS>,
  Exact<LeagueGroupStatus, typeof GROUP_ST>,
  Exact<DuelStatus, typeof DUEL_ST>,
  Exact<DuelResult, typeof RESULTS>,
  Exact<Exclude<DuelResult, "none">, typeof STAFF_RESULTS>,
  Exact<PairRoomStatus, typeof ROOM_ST>,
  Exact<PairRoomMode, typeof MODES>,
  Exact<PairEndReason, typeof END_REASONS>,
  Exact<PairRoomEventKind, typeof EVENT_KINDS>,
  Exact<PairRole, typeof ROLES>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
void _exact;

// ---------------------------------------------------------------- общие

const COUNT = C.int(0);
const N_TIME = C.nullable(C.time);
const N_UUID = C.nullable(C.uuid);
/** member_id (INTERNAL_API спринта 7 §0): "mb_" + 22 символа base64url. */
export const MEMBER_ID = C.id(/^mb_[A-Za-z0-9_-]{22}$/, 25);
/** Ник: буквы (RU/UZ/EN), цифры, «_», до 20 — без пробелов, разметки и управляющих символов (валидатор social). */
const NICKNAME = C.custom<string>({ type: "string" }, (v, p) => (typeof v === "string" && /^[\p{L}\p{N}_]{1,20}$/u.test(v) ? v : bad(p)));
const N_NICK = C.nullable(NICKNAME);
/** Код друга TH-XXXX-XXXX (алфавит без 0/O/1/I). */
const FRIEND_CODE = C.id(/^TH-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, 12);
/** Право, с которым код друга виден полностью (F7-20, admin.ts AdminSocialCard.friend_code). */
export const FRIEND_CODE_FULL_PERMISSION: Permission = "moderation.manage";
/**
 * Маска кода друга для сотрудника без moderation.manage (F7-20): `TH-••••-XXXX` — видны последние 4 символа. Код —
 * ключ поиска ученика (заявки в друзья), поэтому целиком он нужен только модерации. Уже маска — как есть.
 */
export function maskFriendCode(code: string): string {
  return code.includes("•") ? code : `TH-••••-${code.slice(-4)}`;
}
const PAIR_ID = C.id(/^[a-z]{2,3}-[a-z]{2,3}$/, 7);
/** Идентификатор предмета жалобы: member_id, UUID заявки, приглашения, дуэли или комнаты. */
const SUBJECT_ID = C.id(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 64);
/** Статус предмета жалобы (заявки, приглашения, дуэли, комнаты) — snake_case. */
const SUBJECT_STATUS = C.id(/^[a-z][a-z_]{0,31}$/, 32);
/** Ключ сценария каталога (как ключ контента). */
const SCENARIO_ID = C.id(/^[a-z0-9][a-z0-9._-]{1,63}$/, 64);
/** Невидимые символы и переключатели направления (bidi) — подмена порядка текста на экране модератора. */
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
/** Многострочный текст для показа: как C.multiline, плюс невидимые и bidi-символы → пробел. */
const text = (max: number, allowEmpty = false): Codec<string> =>
  C.custom<string>({ type: "string" }, (v, p) => C.multiline(max, allowEmpty).parse(v, p).replace(INVISIBLE_RE, " "));
/** Основание, причина, заметка сотрудника (10..500 на входе). */
const STAFF_TEXT = text(500);
const N_STAFF_TEXT = C.nullable(STAFF_TEXT);
/** Необязательный текст ученика (комментарий жалобы ≤ 500): пусто или одни пробелы → null. */
const learnerText = (max: number): Codec<string | null> =>
  C.custom<string | null>({ type: ["string", "null"] }, (v, p) => {
    if (v === null || v === undefined) return null;
    const s = text(max, true).parse(v, p);
    return s.trim() ? s : null;
  });
/** Название сценария RU/UZ — однострочный текст для показа. */
const TITLE: Codec<Localized> = C.obj<Localized>({ ru: C.text(200), uz: C.text(200) });
const PERIOD = C.oneOf<Period>(["today", "7d", "30d"]);

/** Любое JSON-значение ≤ maxBytes (было / стало в diff версии кампании); нет поля → null. */
const jsonValue = (maxBytes: number): Codec<unknown> =>
  C.custom<unknown>({}, (v, p) => {
    if (v === undefined || v === null) return null;
    if (!["string", "number", "boolean", "object"].includes(typeof v)) return bad(p);
    const s = JSON.stringify(v);
    return s !== undefined && s.length <= maxBytes ? v : bad(p);
  });

// ---------------------------------------------------------------- модерация (social)

export const ADMIN_SANCTION: Codec<AdminSanction> = C.obj<AdminSanction>({
  sanction_id: C.uuid,
  user_id: C.uuid,
  kind: C.oneOf(SANCTION_K),
  until: N_TIME,
  active: C.bool,
  basis: STAFF_TEXT,
  case_id: N_UUID,
  decided_by: STAFF_REF,
  decided_at: C.time,
  revoked_at: N_TIME,
  revoked_by: C.nullable(STAFF_REF),
  revoke_reason: N_STAFF_TEXT,
  appeal: C.nullable(C.obj<NonNullable<AdminSanction["appeal"]>>({ appeal_id: C.uuid, status: C.oneOf(APPEAL_ST) })),
});
export const SANCTION_PAGE = pageOf(ADMIN_SANCTION, 200);

const CASE_ROW_PROPS = {
  case_id: C.uuid,
  status: C.oneOf(CASE_ST),
  reporter_user_id: N_UUID,
  target_user_id: N_UUID,
  target_nickname: N_NICK,
  subject_kind: C.oneOf(SUBJECTS),
  subject_id: C.nullable(SUBJECT_ID),
  reason: C.oneOf(REASONS),
  target_complaints_30d: COUNT,
  created_at: C.time,
  resolved_at: N_TIME,
};
export const CASE_ROW: Codec<AdminCaseRow> = C.obj<AdminCaseRow>(CASE_ROW_PROPS);
export const CASE_PAGE = pageOf(CASE_ROW, 200);

/** Дело модерации: предмет жалобы без переписки (ник на момент жалобы и статус предмета), решение, история санкций цели. */
export const ADMIN_CASE: Codec<AdminCase> = C.obj<AdminCase>({
  ...CASE_ROW_PROPS,
  comment: learnerText(500),
  subject: C.obj<AdminCase["subject"]>({ nickname_at_report: N_NICK, status: C.nullable(SUBJECT_STATUS) }),
  resolution: C.nullable(
    C.obj<NonNullable<AdminCase["resolution"]>>({ action: C.oneOf(ACTIONS), sanction_id: N_UUID, basis: STAFF_TEXT, resolved_by: STAFF_REF }),
  ),
  target_sanctions: C.arr(ADMIN_SANCTION, 200),
});

export const ADMIN_SANCTION_APPEAL: Codec<AdminSanctionAppeal> = C.obj<AdminSanctionAppeal>({
  appeal_id: C.uuid,
  sanction: ADMIN_SANCTION,
  text: text(1000),
  status: C.oneOf(APPEAL_ST),
  created_at: C.time,
  decided_by: C.nullable(STAFF_REF),
  decided_at: N_TIME,
  decision_note: N_STAFF_TEXT,
});
export const APPEAL_PAGE = pageOf(ADMIN_SANCTION_APPEAL, 200);

// ---------------------------------------------------------------- карточка ученика (social.read)

/** Заявки ученика: статусы и даты — ник и идентификатор второй стороны не передаются (кодек их отбрасывает). */
const REQUEST_ITEM = C.obj<AdminSocialCard["requests"][number]>({
  request_id: C.uuid,
  direction: C.oneOf(["in", "out"] as const),
  status: C.oneOf(REQUEST_ST),
  created_at: C.time,
  decided_at: N_TIME,
});
export const ADMIN_SOCIAL_CARD: Codec<AdminSocialCard> = C.obj<AdminSocialCard>({
  user_id: C.uuid,
  member_id: MEMBER_ID,
  nickname: N_NICK,
  friend_code: C.nullable(FRIEND_CODE),
  game_profile_hidden: C.bool,
  nickname_changed_at: N_TIME,
  friends: COUNT,
  requests: C.arr(REQUEST_ITEM, 50),
  blocks: C.obj<AdminSocialCard["blocks"]>({ given: COUNT, received: COUNT }),
  cases: C.obj<AdminSocialCard["cases"]>({ as_reporter: COUNT, as_target: COUNT, open_as_target: COUNT, recent: C.arr(CASE_ROW, 20) }),
  sanctions: C.arr(ADMIN_SANCTION, 200),
  restrictions: C.obj<AdminSocialCard["restrictions"]>({ social_ban: C.bool, social_ban_until: N_TIME }),
});

// ---------------------------------------------------------------- реферальные кампании (social)

const REWARD = C.obj<ReferralReward>({ freeze: C.int(0, 5), til: C.int(0, 1000) });
const PAYLOAD_OBJ = C.obj<ReferralCampaignPayload>({
  require_diagnostic: C.bool,
  min_lessons: C.int(1, 10),
  min_days: C.int(1, 10),
  window_days: C.int(7, 90),
  inviter_reward: REWARD,
  invitee_reward: REWARD,
  monthly_cap: C.int(1, 100),
  review: C.obj<ReferralCampaignPayload["review"]>({ velocity_per_day: C.int(1, 50), min_lesson_minutes: C.int(1, 20) }),
});
/** Payload кампании строго по ограничениям валидатора admin.ts (min_days ≤ min_lessons). */
export const CAMPAIGN_PAYLOAD: Codec<ReferralCampaignPayload> = C.map(PAYLOAD_OBJ, PAYLOAD_OBJ.schema, (v, p) =>
  v.min_days <= v.min_lessons ? v : bad(`${p}.min_days`),
);

const CAMPAIGN_SUMMARY_PROPS = {
  version: C.int(1),
  status: C.oneOf(CAMPAIGN_ST),
  comment: C.optText(500),
  based_on: C.nullable(C.int(1)),
  // null — версия 1 из миграции
  created_by: C.nullable(STAFF_REF),
  created_at: C.time,
  validated_at: N_TIME,
  activated_by: C.nullable(STAFF_REF),
  activated_at: N_TIME,
};
export const CAMPAIGN_SUMMARY: Codec<ReferralCampaignSummary> = C.obj<ReferralCampaignSummary>(CAMPAIGN_SUMMARY_PROPS);
/** Список версий без payload, новые сверху (как отдал домен). */
export const CAMPAIGN_LIST = itemsOf(CAMPAIGN_SUMMARY, 1000);

const JSON_OBJECT_SCHEMA: Schema = { type: "object", additionalProperties: true };
const DIFF_ITEM = C.obj<ReferralCampaignVersion["diff"][number]>({ path: C.str(300, 1), from: jsonValue(4096), to: jsonValue(4096) });
const campaignVersion = (payload: Codec<ReferralCampaignPayload>): Codec<ReferralCampaignVersion> =>
  C.obj<ReferralCampaignVersion>({ ...CAMPAIGN_SUMMARY_PROPS, payload, diff: C.arr(DIFF_ITEM, 200), updated_at: C.time });
const CAMPAIGN_STRICT = campaignVersion(C.custom<ReferralCampaignPayload>(JSON_OBJECT_SCHEMA, (v, p) => CAMPAIGN_PAYLOAD.parse(v, p)));
// черновик — объект как есть (≤ 16 КБ): ещё не проверен, ошибки с путями даёт validate (422 CAMPAIGN_INVALID)
const CAMPAIGN_DRAFT = campaignVersion(
  C.custom<ReferralCampaignPayload>(JSON_OBJECT_SCHEMA, (v, p) => C.json(16_384).parse(v, p) as unknown as ReferralCampaignPayload),
);
/** Версия кампании + diff с активной: payload активной и архивной — строго, черновика — как есть. */
export const CAMPAIGN_VERSION: Codec<ReferralCampaignVersion> = C.custom<ReferralCampaignVersion>(CAMPAIGN_STRICT.schema, (v, p) =>
  ((v as { status?: unknown } | null)?.status === "draft" ? CAMPAIGN_DRAFT : CAMPAIGN_STRICT).parse(v, p),
);
/** Проверка черновика: {ok, errors, warnings} — как у правил игры (RulesValidation). */
export const CAMPAIGN_VALIDATION = RULES_VALIDATION;

/** Выдано суммарно — без верхней границы одной награды. */
const REWARD_TOTAL = C.obj<ReferralReward>({ freeze: COUNT, til: COUNT });
export const CAMPAIGN_STATS: Codec<ReferralCampaignStats> = C.obj<ReferralCampaignStats>({
  version: C.int(1),
  invited: COUNT,
  in_progress: COUNT,
  in_review: COUNT,
  qualified: COUNT,
  rejected: COUNT,
  expired: COUNT,
  capped: COUNT,
  rewards: C.obj<ReferralCampaignStats["rewards"]>({ inviter: REWARD_TOTAL, invitee: REWARD_TOTAL }),
});
export const CAMPAIGN_STATS_LIST = itemsOf(CAMPAIGN_STATS, 1000);

// ---------------------------------------------------------------- очередь проверки рефералов (social)

const REFERRAL_ROW_PROPS = {
  referral_id: C.uuid,
  inviter_user_id: N_UUID,
  invitee_user_id: N_UUID,
  campaign_version: C.int(1),
  status: C.oneOf(REFERRAL_ST),
  accepted_at: C.time,
  diagnostic_at: N_TIME,
  lessons: COUNT,
  days: COUNT,
  minutes_total: COUNT,
  // внутренние признаки антифрода — только админке (ученику не показываются)
  risk_flags: C.arr(C.oneOf(RISK), RISK.length),
  reject_code: C.nullable(C.oneOf(REJECT_CODES)),
  // исход ack gamification (rewarded | legacy | inviter_capped); null или нет поля — подтверждения нет
  reward_outcome: C.nullable(C.oneOf(REWARD_OUTCOMES)),
  qualified_at: N_TIME,
  decided_by: C.nullable(STAFF_REF),
  decided_at: N_TIME,
};
export const REFERRAL_ROW: Codec<AdminReferralRow> = C.obj<AdminReferralRow>(REFERRAL_ROW_PROPS);
export const REFERRAL_PAGE = pageOf(REFERRAL_ROW, 200);
export const ADMIN_REFERRAL: Codec<AdminReferral> = C.obj<AdminReferral>({
  ...REFERRAL_ROW_PROPS,
  // зачётные уроки приглашённого — только дата и минуты (без содержания)
  lessons_log: C.arr(C.obj<AdminReferral["lessons_log"][number]>({ local_date: C.date, minutes: COUNT }), 1000),
  inviter_month: C.obj<AdminReferral["inviter_month"]>({ qualified: COUNT, cap: C.int(1, 100) }),
  decision_history: C.arr(
    C.obj<AdminReferral["decision_history"][number]>({
      decision: C.oneOf(["approved", "rejected"] as const),
      reject_code: C.nullable(C.oneOf(REJECT_CODES)),
      note: STAFF_TEXT,
      by: STAFF_REF,
      at: C.time,
    }),
    20,
  ),
  can_redecide: C.bool,
});

// ---------------------------------------------------------------- лиги недели (gamification)

/** Неделя лиги — понедельник YYYY-MM-DD. */
const WEEK = C.custom<string>({ type: "string" }, (v, p) => {
  const d = C.date.parse(v, p);
  const t = new Date(`${d}T00:00:00Z`);
  return t.toISOString().slice(0, 10) === d && t.getUTCDay() === 1 ? d : bad(p);
});
const GROUP_ROW_PROPS = {
  group_id: C.uuid,
  week: WEEK,
  pair_id: PAIR_ID,
  level_band: C.oneOf(BANDS),
  group_no: C.int(1, 100_000),
  size: COUNT,
  status: C.oneOf(GROUP_ST),
  version: C.nullable(C.int(1)),
  anomalies: COUNT,
  closed_at: N_TIME,
};
export const LEAGUE_GROUP_ROW: Codec<AdminLeagueGroupRow> = C.obj<AdminLeagueGroupRow>(GROUP_ROW_PROPS);
export const LEAGUE_WEEK: Codec<AdminLeagueWeek> = C.obj<AdminLeagueWeek>({
  week: WEEK,
  starts_at: C.time,
  ends_at: C.time,
  status: C.oneOf(["open", "closed"] as const),
  participants: COUNT,
  prizes_til: COUNT,
  groups: C.arr(LEAGUE_GROUP_ROW, 10_000),
});
const LEAGUE_MEMBER = C.obj<AdminLeagueMember>({
  user_id: C.uuid,
  member_id: MEMBER_ID,
  nickname: N_NICK,
  xp: COUNT,
  place: C.nullable(C.int(1)),
  prize_til: COUNT,
  anomaly: C.bool,
  excluded: C.bool,
  joined_at: C.time,
});
const LEAGUE_RESULT = C.obj<AdminLeagueResult>({
  version: C.int(1),
  standings: C.arr(C.obj<AdminLeagueResult["standings"][number]>({ user_id: N_UUID, place: C.int(1), xp: COUNT, prize_til: COUNT }), 100),
  prizes_held: C.bool,
  excluded_user_ids: C.arr(C.uuid, 100),
  closed_at: C.time,
  // null — система (tick закрытия недели)
  closed_by: C.nullable(STAFF_REF),
  reason: N_STAFF_TEXT,
});
/** Группа: участники с XP и призами и все версии итогов (переоценка хранит прежние). */
export const LEAGUE_GROUP: Codec<AdminLeagueGroup> = C.obj<AdminLeagueGroup>({
  ...GROUP_ROW_PROPS,
  members: C.arr(LEAGUE_MEMBER, 100),
  results: C.arr(LEAGUE_RESULT, 100),
});

// ---------------------------------------------------------------- дуэли (gamification)

const SCORE_OBJ = C.obj<DuelScore>({ correct: C.int(0, 100), total: C.int(0, 100) });
/** Счёт: верных не больше, чем заданий. */
const DUEL_SCORE: Codec<DuelScore> = C.map(SCORE_OBJ, SCORE_OBJ.schema, (s, p) => (s.correct <= s.total ? s : bad(`${p}.correct`)));
const DUEL_ROW_PROPS = {
  duel_id: C.uuid,
  status: C.oneOf(DUEL_ST),
  challenger_user_id: N_UUID,
  opponent_user_id: N_UUID,
  pair_id: PAIR_ID,
  level_band: C.oneOf(BANDS),
  scores: C.obj<AdminDuelRow["scores"]>({ challenger: C.nullable(DUEL_SCORE), opponent: C.nullable(DUEL_SCORE) }),
  result: C.nullable(C.oneOf(RESULTS)),
  technical: C.bool,
  result_version: COUNT,
  created_at: C.time,
  finished_at: N_TIME,
};
export const DUEL_ROW: Codec<AdminDuelRow> = C.obj<AdminDuelRow>(DUEL_ROW_PROPS);
export const DUEL_PAGE = pageOf(DUEL_ROW, 200);
/** Сумма операции XP: целое ≠ 0 (обратные записи переоценки — со знаком минус). */
const AMOUNT_SIGNED = C.custom<number>({ type: "integer" }, (v, p) =>
  typeof v === "number" && Number.isSafeInteger(v) && v !== 0 && Math.abs(v) <= 100_000 ? v : bad(p),
);
export const ADMIN_DUEL: Codec<AdminDuel> = C.obj<AdminDuel>({
  ...DUEL_ROW_PROPS,
  set_id: N_UUID,
  accept_deadline: C.time,
  play_deadline: N_TIME,
  rewards: C.arr(
    C.obj<AdminDuel["rewards"][number]>({
      user_id: N_UUID,
      op_id: C.uuid,
      amount: AMOUNT_SIGNED,
      status: C.oneOf(["confirmed", "reversed"] as const),
      result_version: C.int(1),
    }),
    100,
  ),
  history: C.arr(
    C.obj<AdminDuel["history"][number]>({ version: C.int(1), result: C.oneOf(RESULTS), reason: N_STAFF_TEXT, by: C.nullable(STAFF_REF), at: C.time }),
    100,
  ),
});

// ---------------------------------------------------------------- парные комнаты (lessons)

/** Участник: счётчики и сеть — без реплик, оценок, доказательств и отчёта (кодек их отбрасывает). */
const PAIR_PARTICIPANT = C.obj<AdminPairRoomParticipant>({
  user_id: N_UUID,
  side: C.oneOf(["inviter", "invitee"] as const),
  role: C.nullable(C.oneOf(ROLES)),
  turns: COUNT,
  speaking_seconds: C.num(0, 86_400),
  minutes: COUNT,
  contributed: C.bool,
  network: C.nullable(C.oneOf(["online", "offline"] as const)),
  joined_at: N_TIME,
});
const ROOM_ROW_PROPS = {
  room_id: C.uuid,
  status: C.oneOf(ROOM_ST),
  pair_id: PAIR_ID,
  scenario_id: SCENARIO_ID,
  scenario_title: TITLE,
  mode: C.oneOf(MODES),
  participants: C.arr(PAIR_PARTICIPANT, 2),
  created_at: C.time,
  start_at: C.time,
  started_at: N_TIME,
  ended_at: N_TIME,
  duration_s: C.num(0, 10_000_000),
  end_reason: C.nullable(C.oneOf(END_REASONS)),
  ai_cost_usd: C.num(0, 1000),
};
export const PAIR_ROOM_ROW: Codec<AdminPairRoomRow> = C.obj<AdminPairRoomRow>(ROOM_ROW_PROPS);
export const PAIR_ROOM_PAGE = pageOf(PAIR_ROOM_ROW, 200);
/** Комната: ход событий — только вид, роль и время (без текстов реплик, подсказок коуча и оценок). */
export const ADMIN_PAIR_ROOM: Codec<AdminPairRoom> = C.obj<AdminPairRoom>({
  ...ROOM_ROW_PROPS,
  timeline: C.arr(
    C.obj<AdminPairRoom["timeline"][number]>({ seq: COUNT, kind: C.oneOf(EVENT_KINDS), role: C.nullable(C.oneOf(ROLES)), at: C.time }),
    10_000,
  ),
  stopped_by: C.nullable(STAFF_REF),
  stop_reason: N_STAFF_TEXT,
});

// ---------------------------------------------------------------- блок главной (dashboard.read)

/** social `GET /internal/v1/admin/social/stats?period=` — счётчики social (дуэли и комнаты — другие домены). */
export type SocialStatsDomain = Omit<SocialStats, "period" | "duels_finished" | "pair_rooms_finished">;
export const SOCIAL_STATS_DOMAIN: Codec<SocialStatsDomain> = C.obj<SocialStatsDomain>({
  friend_requests: COUNT,
  friendships_added: COUNT,
  referrals_in_review: COUNT,
  cases_opened: COUNT,
  cases_open: COUNT,
});
/** gamification `GET /internal/v1/admin/game/duels/stats?period=` — завершённые дуэли (остальное отбрасывается). */
export const DUEL_STATS: Codec<{ duels_finished: number }> = C.obj<{ duels_finished: number }>({ duels_finished: COUNT });
/** lessons `GET /internal/v1/admin/pair-rooms/stats?period=` — завершённые парные уроки. */
export const PAIR_ROOM_STATS: Codec<{ pair_rooms_finished: number }> = C.obj<{ pair_rooms_finished: number }>({ pair_rooms_finished: COUNT });
export const SOCIAL_STATS: Codec<SocialStats> = C.obj<SocialStats>({
  period: PERIOD,
  friend_requests: COUNT,
  friendships_added: COUNT,
  duels_finished: C.nullable(COUNT),
  pair_rooms_finished: C.nullable(COUNT),
  referrals_in_review: COUNT,
  cases_opened: COUNT,
  cases_open: COUNT,
});

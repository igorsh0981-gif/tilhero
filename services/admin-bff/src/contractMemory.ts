/**
 * Кодеки ответов memory и catalog (словарь курса) по admin.ts «Память, словарь курса, чтение» (спринт 5) — как
 * contract.ts: проверка значения домена (испорченное → 503 UPSTREAM_UNAVAILABLE) и схема ответа admin-bff (лишние поля
 * отбрасываются).
 *
 * Память (memory, docs/sprint5/INTERNAL_API.md §1.11):
 *  - цитата ошибки ученика (`evidence`, `error`) в админку не попадает никогда — её нет в контракте, и если memory её
 *    пришлёт, кодек её отбросит; `user_id` — только в сводке и карточке (сотрудник пришёл из карточки ученика);
 *  - строка истории планирования неизменяема; кто правил — `actor: staff`, `actor_id` (staff_id; memory прошлой версии —
 *    `actor: "staff:<uuid>"`) и `actor_name`: имя по `actor_id` через admin-identity staff/lookup, иначе — имя, которое
 *    memory записала из actor-токена; у learner/system — `actor_id` и `actor_name` null;
 *  - аналитика — только агрегаты: группа с `hidden: true` (меньше 5 учеников) проходит со скрытыми значениями, и BFF
 *    дополнительно обнуляет их сам (защита в глубину: ошибка домена не раскроет малую группу).
 *
 * Словарь курса (catalog, §2.5): строки и карточка несут `updated_by` (staff_id), история — `by` (staff_id | null —
 * система): по ним `updated_by_name` и `by_name` (сид — «Сид (начальное наполнение)»); сами идентификаторы — поля
 * admin.ts (GlossaryRow, GlossaryDetail.history, GlossaryEntry.override.by) и уходят как есть. `before`/`after`
 * истории — JSON-объекты как есть.
 */
import type {
  AdminCardDetail,
  AdminCardRow,
  CheckRate,
  ForgettingAnalytics,
  FsrsSnapshot,
  GlossaryDetail,
  GlossaryRow,
  GlossaryStats,
  LearnerMemorySummary,
  MemoryStats,
  Period,
  RetentionCheckRow,
  ReviewLogRow,
} from "@tilhero/contracts/admin";
import type { GlossaryEntry, GlossaryRef, GlossaryReviewStatus, GlossarySource, PartOfSpeech } from "@tilhero/contracts/content";
import { C, UUID_RE, pageOf, type Codec } from "./codec.js";
import {
  ANALYTICS_PERIODS,
  ANSWER_MODES,
  CARD_KINDS,
  CARD_STATUSES,
  CHECK_STAGES,
  CHECK_STATUSES,
  FSRS_STATES,
  GLOSSARY_ACTIONS,
  GLOSSARY_REF_KINDS,
  GLOSSARY_REVIEW_STATUSES,
  GLOSSARY_SOURCES,
  GRADES,
  LOG_ACTORS,
  PART_OF_SPEECH_VALUES,
} from "./schemas.js";

// ---------------------------------------------------------------- перечисления: вход (schemas.ts) = admin.ts / content.ts

type Exact<T extends string, L extends readonly string[]> = [Exclude<T, L[number]>] extends [never] ? true : Exclude<T, L[number]>;
const POS = PART_OF_SPEECH_VALUES satisfies readonly PartOfSpeech[];
const SOURCES = GLOSSARY_SOURCES satisfies readonly GlossarySource[];
const REVIEW_STATUSES = GLOSSARY_REVIEW_STATUSES satisfies readonly GlossaryReviewStatus[];
const REF_KINDS = GLOSSARY_REF_KINDS satisfies readonly GlossaryRef["kind"][];
const ACTIONS = GLOSSARY_ACTIONS satisfies readonly GlossaryDetail["history"][number]["action"][];
const STATUSES = CARD_STATUSES satisfies readonly AdminCardRow["status"][];
const KINDS = CARD_KINDS satisfies readonly AdminCardRow["kind"][];
const STAGES = CHECK_STAGES satisfies readonly RetentionCheckRow["stage"][];
const CHECK_ST = CHECK_STATUSES satisfies readonly RetentionCheckRow["status"][];
const STATES = FSRS_STATES satisfies readonly FsrsSnapshot["state"][];
const MODES = ANSWER_MODES satisfies readonly ReviewLogRow["answer_mode"][];
const GRADE = GRADES satisfies readonly NonNullable<ReviewLogRow["grade"]>[];
const ACTORS = LOG_ACTORS satisfies readonly ReviewLogRow["actor"][];
const PERIODS = ANALYTICS_PERIODS satisfies readonly ForgettingAnalytics["period"][];
const _exact: [
  Exact<PartOfSpeech, typeof POS>,
  Exact<GlossarySource, typeof SOURCES>,
  Exact<GlossaryReviewStatus, typeof REVIEW_STATUSES>,
  Exact<GlossaryRef["kind"], typeof REF_KINDS>,
  Exact<GlossaryDetail["history"][number]["action"], typeof ACTIONS>,
  Exact<AdminCardRow["status"], typeof STATUSES>,
  Exact<AdminCardRow["kind"], typeof KINDS>,
  Exact<RetentionCheckRow["stage"], typeof STAGES>,
  Exact<RetentionCheckRow["status"], typeof CHECK_ST>,
  Exact<FsrsSnapshot["state"], typeof STATES>,
  Exact<ReviewLogRow["answer_mode"], typeof MODES>,
  Exact<NonNullable<ReviewLogRow["grade"]>, typeof GRADE>,
  Exact<ReviewLogRow["actor"], typeof ACTORS>,
  Exact<ForgettingAnalytics["period"], typeof PERIODS>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true];
void _exact;

// ---------------------------------------------------------------- общие

const COUNT = C.int(0);
const PCT = C.num(0, 100);
const N_TIME = C.nullable(C.time);
const VERSION_NO = C.int(1);
/** Идентификатор контента (content.ts): нижний регистр, стабилен между версиями (урок, навык, текст). */
const KEY = C.id(/^[a-z0-9][a-z0-9._-]{1,63}$/, 64);
const PAIR = C.id(/^[a-z]{2,3}-[a-z]{2,3}$/, 7);
/** Тексты RU/UZ (перевод, заголовок): как в contractContent — тип и длина, переводы правит методист. */
const LOCALIZED = C.obj<{ ru: string; uz: string }>({ ru: C.str(1000), uz: C.str(1000) });
const CODE = C.id(/^[a-z][a-z0-9_]{0,63}$/, 64);
/** Английский текст контента для показа (слово, фраза, исправление): без управляющих символов. */
const EN_TEXT = C.text(300);

// ---------------------------------------------------------------- словарь курса (catalog)

const POS_C = C.nullable(C.oneOf(POS));
const LEMMA = C.text(120);
const FORMS = C.arr(C.text(120), 8);
const REF: Codec<GlossaryRef> = C.obj<GlossaryRef>({ kind: C.oneOf(REF_KINDS), key: KEY, version: VERSION_NO });
/** Автор правки: UUID сотрудника, «seed», «system» — для имени; как есть (поле GlossaryEntry). */
const BY = C.str(64, 1);

const ROW_PROPS = {
  entry_id: C.uuid,
  pair_id: PAIR,
  lemma: LEMMA,
  forms: FORMS,
  part_of_speech: POS_C,
  gloss: LOCALIZED,
  source: C.oneOf(SOURCES),
  review_status: C.oneOf(REVIEW_STATUSES),
  confidence: C.nullable(C.num(0, 1)),
  refs_count: COUNT,
  overridden: C.bool,
  updated_at: C.time,
  updated_by: C.nullable(BY),
  updated_by_name: C.name,
};
export const GLOSSARY_ROW: Codec<GlossaryRow> = C.obj<GlossaryRow>(ROW_PROPS);
export const GLOSSARY_ROW_PAGE = pageOf(GLOSSARY_ROW, 100);

const ENTRY_PROPS = {
  entry_id: C.uuid,
  pair_id: PAIR,
  lemma: LEMMA,
  forms: FORMS,
  part_of_speech: POS_C,
  gloss: LOCALIZED,
  example_en: C.nullable(C.str(400)),
  source: C.oneOf(SOURCES),
  review_status: C.oneOf(REVIEW_STATUSES),
  confidence: C.nullable(C.num(0, 1)),
  // «teaching_coach@2» — только для показа (формат задаёт memory; испорченный не ломает карточку статьи)
  agent_version: C.optText(64),
  refs: C.arr(REF, 50),
  override: C.nullable(
    C.obj<NonNullable<GlossaryEntry["override"]>>({ gloss: LOCALIZED, example_en: C.nullable(C.str(400)), by: BY, at: C.time }),
  ),
  corrected: C.bool,
  archived_at: N_TIME,
  updated_by: C.nullable(BY),
  updated_at: C.time,
};
type History = GlossaryDetail["history"][number];
const HISTORY = C.obj<History>({
  at: C.time,
  by: C.nullable(BY),
  by_name: C.name,
  action: C.oneOf(ACTIONS),
  // было / стало — частичная статья как есть (поля правки; ≤ 64 КБ)
  before: C.nullable(C.json(65_536)) as Codec<History["before"]>,
  after: C.nullable(C.json(65_536)) as Codec<History["after"]>,
  reason: C.nullable(C.multiline(500, true)),
});
const DETAIL_PROPS = {
  ...ENTRY_PROPS,
  updated_by_name: C.name,
  refs_titles: C.arr(
    C.obj<GlossaryDetail["refs_titles"][number]>({ kind: C.oneOf(REF_KINDS), key: KEY, version: VERSION_NO, title: C.nullable(LOCALIZED) }),
    50,
  ),
  conflicts: C.arr(C.obj<GlossaryDetail["conflicts"][number]>({ ref: REF, gloss: LOCALIZED }), 50),
};
/** Карточка статьи: GlossaryEntry + имена, места в контенте, история (новые первыми, до 100 у catalog), конфликты. */
export const GLOSSARY_DETAIL: Codec<GlossaryDetail> = C.obj<GlossaryDetail>({ ...DETAIL_PROPS, history: C.arr(HISTORY, 500) });

/** catalog `GET /admin/v1/glossary/stats?pair_id=` → GlossaryStats (admin.ts). */
export const GLOSSARY_STATS: Codec<GlossaryStats> = C.obj<GlossaryStats>({
  pair_id: C.nullable(PAIR),
  ai_glosses_pending: COUNT,
  ai_approved: COUNT,
  ai_rejected: COUNT,
  entries: C.obj<GlossaryStats["entries"]>({ course: COUNT, methodist: COUNT, ai: COUNT }),
  overridden: COUNT,
});
/** Для блока обзора нужен один счётчик: остальные поля stats (или сводки контента) не проверяются и не ломают блок. */
export const GLOSSES_PENDING: Codec<{ ai_glosses_pending: number }> = C.obj<{ ai_glosses_pending: number }>({ ai_glosses_pending: COUNT });

// ---------------------------------------------------------------- память ученика (memory)

const CHECK_ROW: Codec<RetentionCheckRow> = C.obj<RetentionCheckRow>({
  check_id: C.uuid,
  skill_id: KEY,
  skill_title: C.nullable(LOCALIZED),
  stage: C.oneOf(STAGES),
  status: C.oneOf(CHECK_ST),
  due_at: C.time,
  checked_at: N_TIME,
  result: C.nullable(C.obj<NonNullable<RetentionCheckRow["result"]>>({ correct: COUNT, total: COUNT })),
  consecutive_failures: COUNT,
});

export const LEARNER_MEMORY_SUMMARY: Codec<LearnerMemorySummary> = C.obj<LearnerMemorySummary>({
  user_id: C.uuid,
  pair_id: C.nullable(PAIR),
  cards_by_status: C.obj<LearnerMemorySummary["cards_by_status"]>(
    Object.fromEntries(STATUSES.map((s) => [s, COUNT])) as Record<(typeof STATUSES)[number], typeof COUNT>,
  ),
  due_now: COUNT,
  overdue_7d: COUNT,
  reviews_30d: COUNT,
  last_review_at: N_TIME,
  checks: C.arr(CHECK_ROW, 20),
});

/** Стабильность — дни (может превышать максимальный интервал 365); сложность FSRS — 1..10; R — 0..1. */
const STABILITY = C.nullable(C.num(0, 1e6));
const DIFFICULTY = C.nullable(C.num(1, 10));
const CARD_ROW_PROPS = {
  card_id: C.uuid,
  kind: C.oneOf(KINDS),
  text_en: EN_TEXT,
  gloss: LOCALIZED,
  status: C.oneOf(STATUSES),
  stability: STABILITY,
  difficulty: DIFFICULTY,
  retrievability: C.nullable(C.num(0, 1)),
  reps: COUNT,
  lapses: COUNT,
  due_at: N_TIME,
  last_review_at: N_TIME,
  error_code: C.nullable(CODE),
};
export const ADMIN_CARD_ROW: Codec<AdminCardRow> = C.obj<AdminCardRow>(CARD_ROW_PROPS);
export const ADMIN_CARD_PAGE = pageOf(ADMIN_CARD_ROW, 100);

const SNAPSHOT: Codec<FsrsSnapshot> = C.obj<FsrsSnapshot>({
  state: C.oneOf(STATES),
  stability: STABILITY,
  difficulty: DIFFICULTY,
  due_at: N_TIME,
  status: C.oneOf(STATUSES),
});

const STAFF_ACTOR_RE = /^staff:([0-9a-fA-F-]{36})$/;
/** learner | system | staff; «staff:<uuid>» (как хранит memory) → staff. */
const ACTOR = C.custom<ReviewLogRow["actor"]>({ type: "string" }, (v, p) => {
  if (typeof v === "string" && STAFF_ACTOR_RE.test(v) && UUID_RE.test(v.slice(6))) return "staff";
  return C.oneOf(ACTORS).parse(v, p);
});
/** Имя, записанное memory из actor-токена (запасное, если lookup не нашёл сотрудника): только текст для показа. */
const ACTOR_NAME = C.optText(120);
const LOG_PROPS = {
  log_id: C.uuid,
  at: C.time,
  task_type: CODE,
  answer_mode: C.oneOf(MODES),
  grade: C.nullable(C.oneOf(GRADE)),
  hinted: C.bool,
  revealed: C.bool,
  elapsed_days: C.nullable(C.num(0, 1e6)),
  before: SNAPSHOT,
  after: SNAPSHOT,
  algorithm: C.id(/^[a-z0-9][a-z0-9._-]{0,31}$/, 32),
  params_version: C.id(/^[a-z0-9][a-z0-9._-]{0,63}$/, 64),
  actor: ACTOR,
  actor_name: ACTOR_NAME,
  reason: C.nullable(C.multiline(300, true)),
};
// staff_id; нет поля (memory прошлой версии) — из `actor: "staff:<uuid>"` или null
const LOG_ROW_OBJ: Codec<ReviewLogRow> = C.obj<ReviewLogRow>({ ...LOG_PROPS, actor_id: C.fallback(C.nullable(C.uuid), null) });
/** Строка истории: у learner/system — без сотрудника (actor_id и actor_name null), у staff — id из поля или из actor. */
export const REVIEW_LOG_ROW: Codec<ReviewLogRow> = C.custom<ReviewLogRow>(LOG_ROW_OBJ.schema, (v, p) => {
  const row = LOG_ROW_OBJ.parse(v, p);
  if (row.actor !== "staff") return { ...row, actor_id: null, actor_name: null };
  const raw = (v as { actor?: unknown }).actor;
  const m = typeof raw === "string" ? STAFF_ACTOR_RE.exec(raw) : null;
  return row.actor_id || !m ? row : { ...row, actor_id: m[1]!.toLowerCase() };
});
export const REVIEW_LOG_PAGE = pageOf(REVIEW_LOG_ROW, 100);

const SOURCE = C.obj<AdminCardDetail["sources"][number]>({
  kind: C.id(/^[a-z][a-z0-9_]{0,31}$/, 32),
  key: C.nullable(C.id(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 128)),
  version: C.nullable(VERSION_NO),
  at: C.time,
});
const DETAIL_EXTRA = {
  user_id: C.uuid,
  example_en: C.optText(400),
  sources: C.arr(SOURCE, 20),
};
export const ADMIN_CARD_DETAIL: Codec<AdminCardDetail> = C.obj<AdminCardDetail>({ ...CARD_ROW_PROPS, ...DETAIL_EXTRA, log: REVIEW_LOG_PAGE });

// ---------------------------------------------------------------- аналитика забывания и обзор (memory)

/** Скрытая группа (меньше 5 учеников): значения обнуляются здесь же, что бы ни прислал домен. */
const CHECK_RATE_OBJ = C.obj<CheckRate>({ scheduled: COUNT, passed: COUNT, failed: COUNT, pass_pct: C.nullable(PCT), hidden: C.bool });
const CHECK_RATE: Codec<CheckRate> = C.map(CHECK_RATE_OBJ, CHECK_RATE_OBJ.schema, (r) =>
  r.hidden ? { scheduled: 0, passed: 0, failed: 0, pass_pct: null, hidden: true } : r,
);
/** «Самые забываемые слова» — только при ≥ 20 ответах (admin.ts); слово с меньшим числом ответов не показывается. */
const FORGOTTEN_MIN_ANSWERS = 20;
const FORGOTTEN = C.arr(C.obj<ForgettingAnalytics["forgotten_words"][number]>({ text_en: EN_TEXT, answers: COUNT, again_pct: PCT }), 20);
type ByLesson = ForgettingAnalytics["by_lesson"][number];
type RepeatedError = ForgettingAnalytics["repeated_errors"][number];
const BY_LESSON_OBJ = C.obj<ByLesson>({ lesson_id: KEY, title: C.nullable(LOCALIZED), cards: COUNT, again_pct: C.nullable(PCT), hidden: C.bool });
const REPEATED_OBJ = C.obj<RepeatedError>({ error_code: CODE, label: LOCALIZED, learners_with_repeats: COUNT, cards: COUNT, hidden: C.bool });
export const FORGETTING_ANALYTICS: Codec<ForgettingAnalytics> = C.obj<ForgettingAnalytics>({
  period: C.oneOf(PERIODS),
  pair_id: PAIR,
  generated_at: C.time,
  checks: C.obj<ForgettingAnalytics["checks"]>({ d7: CHECK_RATE, d30: CHECK_RATE }),
  by_skill: C.arr(
    C.obj<ForgettingAnalytics["by_skill"][number]>({ skill_id: KEY, title: C.nullable(LOCALIZED), d7: CHECK_RATE, d30: CHECK_RATE }),
    1000,
  ),
  by_lesson: C.arr(
    C.map(BY_LESSON_OBJ, BY_LESSON_OBJ.schema, (r) => (r.hidden ? { ...r, cards: 0, again_pct: null } : r)),
    1000,
  ),
  repeated_errors: C.arr(
    C.map(REPEATED_OBJ, REPEATED_OBJ.schema, (r) => (r.hidden ? { ...r, learners_with_repeats: 0, cards: 0 } : r)),
    500,
  ),
  forgotten_words: C.map(FORGOTTEN, FORGOTTEN.schema, (words) => words.filter((w) => w.answers >= FORGOTTEN_MIN_ANSWERS)),
});

/** memory `GET /admin/v1/memory/stats?period=` — MemoryStats; `ai_glosses_pending` — у catalog (дописывает BFF;
 *  значение memory не используется: catalog недоступен — null). */
export const MEMORY_STATS: Codec<MemoryStats> = C.obj<MemoryStats>({
  period: C.oneOf<Period>(["today", "7d", "30d"]),
  review_sessions: COUNT,
  learners_reviewing: COUNT,
  median_minutes: C.nullable(C.num(0, 1e6)),
  d30_pass_pct: C.nullable(PCT),
  avg_due_per_learner: C.nullable(C.num(0, 1e6)),
  // memory отдаёт 0 (очередь — в catalog); нет поля — null
  ai_glosses_pending: C.fallback(C.nullable(COUNT), null),
});

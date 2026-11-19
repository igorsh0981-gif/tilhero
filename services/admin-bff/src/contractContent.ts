/**
 * Кодеки ответов catalog и diagnostics по admin.ts «Контент и диагностика» (спринт 3) — как contract.ts: проверка
 * значения домена (испорченное → 503 UPSTREAM_UNAVAILABLE) и схема ответа admin-bff (лишние поля отбрасываются).
 *
 * Тело версии (`payload`) — JSON-объект как есть: его схему вида проверяет catalog (content.ts — источник истины),
 * BFF проверяет только, что это объект разумного размера. Остальные поля — строго по типам admin.ts / content.ts:
 * `kind` — из ContentKind, статусы, полосы, отметки локализаций — из перечислений.
 * Имена сотрудников (`author_name`, `reviewer_name`, `rights_approved_by_name`, `published_by_name`, `decided_by_name`,
 * `updated_by_name`) от домена не берутся — их заполняет `withNames` (admin-identity staff/lookup).
 */
import type {
  AdminMediaRequest,
  AudioBlob,
  ContentRow,
  ContentSummary,
  ContentValidationError,
  ContentVersion,
  ContentVersionMeta,
  DiagnosticStats,
  DiagnosticTestRow,
  DiagnosticTestVersion,
  Language,
  LanguagePair,
  PairCard,
  Period,
} from "@tilhero/contracts/admin";
import type { Band, ContentKind, LocaleCheck, MediaRequestStatus, PairStatus, ScenarioTestRun, VersionStatus } from "@tilhero/contracts/content";
import { C, itemsOf, pageOf, type Codec } from "./codec.js";
import {
  AUDIO_MAX_BYTES,
  AUDIO_TYPES,
  BANDS as BANDS_IN,
  CONTENT_KINDS as KINDS_IN,
  LOCALE_CHECKS as LOCALE_CHECKS_IN,
  MEDIA_REQUEST_STATUSES as REQUEST_STATUSES_IN,
  PAIR_STATUSES as PAIR_STATUSES_IN,
  VERSION_STATUSES as VERSION_STATUSES_IN,
} from "./schemas.js";

// ---------------------------------------------------------------- перечисления: вход (schemas.ts) = content.ts

/** Компиляция падает, если в content.ts появилось значение, которого нет в списке (и наоборот — satisfies). */
type Exact<T extends string, L extends readonly string[]> = [Exclude<T, L[number]>] extends [never] ? true : Exclude<T, L[number]>;
export const CONTENT_KINDS = KINDS_IN satisfies readonly ContentKind[];
export const VERSION_STATUSES = VERSION_STATUSES_IN satisfies readonly VersionStatus[];
export const BANDS = BANDS_IN satisfies readonly Band[];
const LOCALE_CHECKS = LOCALE_CHECKS_IN satisfies readonly LocaleCheck[];
const REQUEST_STATUSES = REQUEST_STATUSES_IN satisfies readonly MediaRequestStatus[];
const PAIR_STATUSES = PAIR_STATUSES_IN satisfies readonly PairStatus[];
const _exact: [
  Exact<ContentKind, typeof CONTENT_KINDS>,
  Exact<VersionStatus, typeof VERSION_STATUSES>,
  Exact<Band, typeof BANDS>,
  Exact<LocaleCheck, typeof LOCALE_CHECKS>,
  Exact<MediaRequestStatus, typeof REQUEST_STATUSES>,
  Exact<PairStatus, typeof PAIR_STATUSES>,
] = [true, true, true, true, true, true];
void _exact;

// ---------------------------------------------------------------- общие

const COUNT = C.int(0);
const ID64 = C.str(64, 1);
const N_ID64 = C.nullable(ID64);
const N_TIME = C.nullable(C.time);
/** Идентификатор сущности контента (content.ts): нижний регистр, стабилен между версиями. */
const KEY = C.id(/^[a-z0-9][a-z0-9._-]{1,63}$/, 64);
const KIND = C.oneOf(CONTENT_KINDS);
const BAND = C.oneOf(BANDS);
const VERSION_NO = C.int(1);
/** Тексты ученику RU/UZ: в черновике пустая строка допустима (LOCALE_MISSING ловит домен при отправке). */
const LOCALIZED = C.obj<{ ru: string; uz: string }>({ ru: C.str(1000), uz: C.str(1000) });
const LANG = C.id(/^[a-z]{2,3}(-[A-Z]{2})?$/, 6);
const HASH = C.id(/^[0-9a-f]{64}$/, 64);

// ---------------------------------------------------------------- версии контента (catalog)

const ROW_PROPS = {
  kind: KIND,
  key: KEY,
  title: LOCALIZED,
  published_version: C.nullable(VERSION_NO),
  latest_version: VERSION_NO,
  latest_status: C.oneOf(VERSION_STATUSES),
  level: C.nullable(BAND),
  updated_at: C.time,
  updated_by_name: C.name,
  rights_warning: C.nullable(C.oneOf(["expiring", "expired"] as const)),
};
/** Строка списка — admin.ts ContentRow (без `updated_by`). */
export const CONTENT_ROW: Codec<ContentRow> = C.obj<ContentRow>(ROW_PROPS);
/**
 * Строка от catalog: + `updated_by` (id сотрудника, «seed», «system»), по которому admin-bff подставляет
 * `updated_by_name`; в ответ клиенту `updated_by` не уходит (`publicRow`).
 */
export type ContentRowDomain = ContentRow & { updated_by: string | null };
export const CONTENT_ROW_DOMAIN: Codec<ContentRowDomain> = C.obj<ContentRowDomain>({ ...ROW_PROPS, updated_by: C.fallback(N_ID64, null) });

const META_PROPS = {
  version: VERSION_NO,
  status: C.oneOf(VERSION_STATUSES),
  author_id: ID64,
  author_name: C.name,
  created_at: C.time,
  submitted_at: N_TIME,
  reviewer_id: N_ID64,
  reviewer_name: C.name,
  reviewed_at: N_TIME,
  review_note: C.nullable(C.str(1000)),
  locale_checks: C.obj<ContentVersionMeta["locale_checks"]>({ ru: C.oneOf(LOCALE_CHECKS), uz: C.oneOf(LOCALE_CHECKS) }),
  rights_approved_by: N_ID64,
  rights_approved_by_name: C.name,
  rights_approved_at: N_TIME,
  published_by: N_ID64,
  published_by_name: C.name,
  published_at: N_TIME,
  archived_at: N_TIME,
  suspended_at: N_TIME,
  suspend_reason: C.nullable(C.oneOf(["rights_expired", "rights_revoked"] as const)),
};
export const CONTENT_VERSION_META: Codec<ContentVersionMeta> = C.obj<ContentVersionMeta>(META_PROPS);

const ISSUE_CODES = [
  "START_MISSING", "UNKNOWN_NODE", "UNREACHABLE_NODE", "DEAD_END", "NO_SUCCESS_END", "TRAP", "UNKNOWN_SPEAKER",
  "NO_RECOVERY_POINT", "RECOVERY_CANNOT_FINISH", "TOO_MANY_NODES",
] as const satisfies readonly ScenarioTestRun["issues"][number]["code"][];
const _issueCodes: Exact<ScenarioTestRun["issues"][number]["code"], typeof ISSUE_CODES> = true;
void _issueCodes;
export const SCENARIO_TEST_RUN: Codec<ScenarioTestRun> = C.obj<ScenarioTestRun>({
  ok: C.bool,
  checked_at: C.time,
  issues: C.arr(
    C.obj<ScenarioTestRun["issues"][number]>({ code: C.oneOf(ISSUE_CODES), node_id: C.nullable(C.str(64)), detail: C.str(1000) }),
    500,
  ),
  stats: C.obj<ScenarioTestRun["stats"]>({
    nodes: COUNT,
    ends: C.obj<ScenarioTestRun["stats"]["ends"]>({ success: COUNT, alt_success: COUNT, fail: COUNT }),
    max_depth: COUNT,
    paths_to_success: COUNT,
  }),
});

/** Тело версии ≤ 1 МБ текста (catalog принимает тело ≤ 256 КБ; запас на экранирование). */
const PAYLOAD = C.json(1_000_000);
export const CONTENT_VERSION: Codec<ContentVersion> = C.obj<ContentVersion>({
  ...META_PROPS,
  kind: KIND,
  key: KEY,
  payload: PAYLOAD,
  payload_hash: HASH,
  test_run: C.nullable(SCENARIO_TEST_RUN),
});

export type ContentDetail = { row: ContentRow; versions: ContentVersionMeta[] };
export type ContentDetailDomain = { row: ContentRowDomain; versions: ContentVersionMeta[] };
export const CONTENT_DETAIL: Codec<ContentDetail> = C.obj<ContentDetail>({ row: CONTENT_ROW, versions: C.arr(CONTENT_VERSION_META, 1000) });
export const CONTENT_DETAIL_DOMAIN: Codec<ContentDetailDomain> = C.obj<ContentDetailDomain>({
  row: CONTENT_ROW_DOMAIN,
  versions: C.arr(CONTENT_VERSION_META, 1000),
});
export const CONTENT_ROW_PAGE = pageOf(CONTENT_ROW, 100);
export const CONTENT_ROW_PAGE_DOMAIN = pageOf(CONTENT_ROW_DOMAIN, 100);
export const ARCHIVED = C.obj<{ row: ContentRow }>({ row: CONTENT_ROW });
export const ARCHIVED_DOMAIN = C.obj<{ row: ContentRowDomain }>({ row: CONTENT_ROW_DOMAIN });

/** Строка домена → ContentRow: `updated_by` (только для имени) не уходит клиенту. */
export function publicRow(r: ContentRowDomain): ContentRow {
  const { updated_by: _drop, ...row } = r;
  return row;
}

export const VALIDATION_RESULT: Codec<{ ok: boolean; errors: ContentValidationError[] }> = C.obj<{ ok: boolean; errors: ContentValidationError[] }>({
  ok: C.bool,
  errors: C.arr(
    C.obj<ContentValidationError>({
      path: C.str(300),
      code: C.id(/^[A-Z][A-Z0-9_]{1,63}$/, 64),
      message: C.str(1000),
    }),
    500,
  ),
});

export const AUDIO_BLOB: Codec<AudioBlob> = C.obj<AudioBlob>({
  blob_id: C.uuid,
  content_type: C.oneOf(AUDIO_TYPES),
  size: C.int(1, AUDIO_MAX_BYTES),
  sha256: HASH,
  created_at: C.time,
});

const SUMMARY_COUNTS = C.obj<ContentSummary["by_kind"][ContentKind]>({ published: COUNT, drafts: COUNT, in_review: COUNT });
export const CONTENT_SUMMARY: Codec<ContentSummary> = C.obj<ContentSummary>({
  by_kind: C.obj<ContentSummary["by_kind"]>(
    Object.fromEntries(CONTENT_KINDS.map((k) => [k, SUMMARY_COUNTS])) as Record<ContentKind, typeof SUMMARY_COUNTS>,
  ),
  in_review: COUNT,
  rights_expiring: C.arr(
    C.obj<ContentSummary["rights_expiring"][number]>({ asset_id: KEY, title: LOCALIZED, valid_to: C.date }),
    500,
  ),
  suspended_media: COUNT,
  new_media_requests: COUNT,
});

// ---------------------------------------------------------------- заявки учеников (catalog)

/**
 * Заявка ученика. Название, ссылка и комментарий — текст ученика: управляющие символы вычищаются, ссылка — только
 * как текст (сервер её не открывает и не скачивает; admin-web не делает её активной).
 */
export const MEDIA_REQUEST: Codec<AdminMediaRequest> = C.obj<AdminMediaRequest>({
  request_id: C.uuid,
  user_id: C.nullable(C.uuid),
  kind: C.oneOf(["song", "movie", "series", "other"] as const),
  title: C.text(200),
  link: C.optText(500),
  comment: C.nullable(C.multiline(500, true)),
  ui_locale: C.oneOf(["ru", "uz"] as const),
  status: C.oneOf(REQUEST_STATUSES),
  decision_note: C.nullable(C.str(500)),
  linked_asset_id: C.nullable(KEY),
  decided_by: N_ID64,
  decided_by_name: C.name,
  decided_at: N_TIME,
  created_at: C.time,
  similar_count: COUNT,
});
export const MEDIA_REQUEST_PAGE = pageOf(MEDIA_REQUEST, 100);

// ---------------------------------------------------------------- языки и пары (catalog)

const SHORT = (max: number) => C.str(max, 1);
export const LANGUAGE: Codec<Language> = C.obj<Language>({
  code: LANG,
  name: C.obj<Language["name"]>({ ru: SHORT(80), uz: SHORT(80), en: SHORT(80) }),
  script: C.oneOf(["Latn", "Cyrl"] as const),
  variants: C.arr(LANG, 20),
  asr: C.nullable(C.obj<NonNullable<Language["asr"]>>({ provider: SHORT(60), model: SHORT(120) })),
  tts: C.nullable(C.obj<NonNullable<Language["tts"]>>({ provider: SHORT(60), voices: C.arr(SHORT(60), 50) })),
  limitations: C.nullable(C.str(1000)),
  status: C.oneOf(["active", "planned"] as const),
});
export const LANGUAGES = itemsOf(LANGUAGE, 200);

const PAIR_PROPS = {
  pair_id: C.id(/^[a-z]{2,3}-[a-z]{2,3}$/, 7),
  source: LANG,
  target: LANG,
  explanation_locales: C.arr(LANG, 5),
  ui_locales: C.arr(C.oneOf(["ru", "uz"] as const), 2),
  title: LOCALIZED,
  status: C.oneOf(PAIR_STATUSES),
  release_at: C.nullable(C.str(40)),
  course_id: C.nullable(KEY),
};
export const LANGUAGE_PAIR: Codec<LanguagePair> = C.obj<LanguagePair>(PAIR_PROPS);
export const PAIR_CARD: Codec<PairCard> = C.obj<PairCard>({
  ...PAIR_PROPS,
  readiness: C.obj<PairCard["readiness"]>({
    skills: COUNT,
    lessons_published: COUNT,
    scenarios_published: COUNT,
    rubrics_published: COUNT,
    media_published: COUNT,
    diagnostic_test: C.nullable(C.id(/^[a-z0-9][a-z0-9._-]{1,63}@[1-9][0-9]{0,8}$/, 80)),
    locales_checked_pct: C.num(0, 100),
  }),
  learners: COUNT,
});
export const PAIR_CARDS = itemsOf(PAIR_CARD, 200);

// ---------------------------------------------------------------- диагностика (diagnostics)

const TEST_STATUS = C.oneOf(["draft", "published", "archived"] as const);
export const DIAGNOSTIC_TEST_ROW: Codec<DiagnosticTestRow> = C.obj<DiagnosticTestRow>({
  test_id: KEY,
  pair_id: PAIR_PROPS.pair_id,
  audience: C.oneOf(["adults", "kids"] as const),
  published_version: C.nullable(VERSION_NO),
  versions: C.arr(
    C.obj<DiagnosticTestRow["versions"][number]>({ version: VERSION_NO, status: TEST_STATUS, items: COUNT, published_at: N_TIME }),
    1000,
  ),
});
export const DIAGNOSTIC_TESTS = itemsOf(DIAGNOSTIC_TEST_ROW, 200);
const BAND_COUNTS = C.obj<Record<Band, number>>({ A0: COUNT, A1: COUNT, A2: COUNT, B1: COUNT, B2: COUNT });
/** Версия теста с ключами ответов (content.read) — задания и конфигурация как есть (проверяет diagnostics). */
export const DIAGNOSTIC_TEST_VERSION: Codec<DiagnosticTestVersion> = C.obj<DiagnosticTestVersion>({
  test_id: KEY,
  version: VERSION_NO,
  status: TEST_STATUS,
  config: C.json(65_536),
  items: C.arr(C.json(65_536), 2000),
  coverage: C.dict(/^[a-z_]{1,32}$/, BAND_COUNTS, 20),
});
const AREAS = ["vocabulary", "grammar", "reading", "listening"] as const;
const pct = C.num(0, 100);
export const DIAGNOSTIC_STATS: Codec<DiagnosticStats> = C.obj<DiagnosticStats>({
  period: C.oneOf<Period>(["today", "7d", "30d"]),
  started: COUNT,
  finished: COUNT,
  median_minutes: C.nullable(C.num(0, 1e6)),
  by_level: C.obj<DiagnosticStats["by_level"]>({ A0: COUNT, A1: COUNT, A2: COUNT, B1: COUNT, B2: COUNT, none: COUNT }),
  // проценты 0–100 (как *_pct дашборда), не доля
  not_assessed_pct: C.obj<DiagnosticStats["not_assessed_pct"]>(
    Object.fromEntries(AREAS.map((a) => [a, pct])) as Record<(typeof AREAS)[number], typeof pct>,
  ),
  followups: COUNT,
});

/** Число учеников с результатом по паре — diagnostics `GET /admin/v1/diagnostics/pairs` (для PairCard.learners). */
export const DIAGNOSTIC_PAIRS = itemsOf(C.obj<{ pair_id: string; learners: number }>({ pair_id: PAIR_PROPS.pair_id, learners: COUNT }), 200);

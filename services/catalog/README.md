# catalog-service

**Владелец:** контент (методисты, контент-менеджер). **Bounded context:** учебное содержание TilHero — справочник языков
и языковых пар, курс, навыки с предпосылками, модули и уроки, рубрики, сценарии разговоров с проверкой графа, медиа с
правами и автоприостановкой, упражнения к медиа, заявки учеников на песни и фильмы. Всё содержание — **версии**
«черновик → на проверке → одобрен → опубликован → архив» (+ «приостановлен» у медиа) с откатом и контролем локализаций
RU/UZ (спринт 3, AT-26…31, AT-37, AT-38).

Порт 8110, схема PostgreSQL `catalog` (роли `catalog_owner` — миграции, `catalog` — рантайм без DDL), внутренний JWT с
`aud = catalog`. Redis — Idempotency-Key команд сотрудников. Форматы контента — `packages/contracts/src/content.ts`
(pydantic-модели `tilhero_catalog/content.py` повторяют интерфейсы 1:1, контрактный тест сверяет поля и перечисления);
формы API — `admin.ts` («Контент и диагностика») и `bff.ts` («Спринт 3»).

## Admin API (`/admin/v1`, только admin-bff с `actor`; права проверяются здесь, step-up — в admin-bff)
| Метод | Путь | Право | Ответ / ошибки |
|---|---|---|---|
| GET | `/content/{kind}?q=&status=&level=&cursor=&limit=` | content.read | `Page<ContentRow>` (+ `updated_by` — id для имени) |
| POST | `/content/{kind}` `{payload}` | content.edit | 201 `ContentVersion` v1 draft; 409 `CONTENT_KEY_EXISTS`; 422 `CONTENT_INVALID` (только схема) |
| GET | `/content/{kind}/{key}` | content.read | `{row, versions: ContentVersionMeta[]}` |
| POST | `/content/{kind}/{key}/versions` `{from_version}` | content.edit | 201 черновик-копия; 409 `DRAFT_EXISTS {version}` |
| GET / PUT | `/content/{kind}/{key}/versions/{v}` `{payload, expected_hash}` | content.read / content.edit | `ContentVersion`; 409 `VERSION_NOT_DRAFT`, `VERSION_CONFLICT {payload_hash}`; 422 `KEY_CHANGED` |
| POST | `…/versions/{v}/validate` | content.read | `{ok, errors}` — сухая проверка в режиме публикации |
| POST | `…/versions/{v}/submit` | content.edit | → in_review; 422 `CONTENT_INVALID {errors}` |
| POST | `…/versions/{v}/review` `ContentReviewInput` | content.review | approve → approved (RU/UZ checked) / return → draft; 409 `SELF_REVIEW`, `VERSION_NOT_IN_REVIEW` |
| POST | `…/versions/{v}/publish` `{reason}` | content.publish | → published (повтор — 200 no-op); 409 `VERSION_NOT_APPROVED`; 422 `CONTENT_INVALID` |
| POST | `/content/{kind}/{key}/archive` `{reason}` | content.publish | `{row}`; 409 `CONTENT_IN_USE {refs}`, `CONTENT_NOT_PUBLISHED` |
| POST | `/content/{kind}/{key}/rollback` `{to_version, reason}` | content.publish | `ContentVersion`; 409 `ROLLBACK_TARGET_INVALID`; 422 |
| POST | `/content/scenario/{key}/versions/{v}/test-run` | content.edit | `ScenarioTestRun` (сохраняется с хешем тела) |
| POST | `/content/media_asset/{key}/versions/{v}/rights-approve` (`rights:approve`) `{note}` | media.rights | `ContentVersion`; 409 `VERSION_IMMUTABLE`; 422 |
| POST / GET | `/content/blobs` `AudioUpload` / `/content/blobs/{id}` | content.edit / content.read | 201 `AudioBlob` (дубль по sha256 — 200 тот же); 422 `AUDIO_INVALID {reason}` |
| GET | `/content/review-queue?kind=&cursor=` | content.review | `Page<ContentRow>` — на проверке, которые сотрудник не правил |
| GET | `/content/summary` | dashboard.read \| content.read | `ContentSummary` |
| GET | `/content/media-requests?status=&q=&cursor=` · `/content/media-requests/{id}` | media.rights (ПД ученика) | `Page<AdminMediaRequest>` (similar_count) / карточка |
| POST | `/content/media-requests/{id}/take` · `/decide` | media.rights | `AdminMediaRequest`; 409 `MEDIA_REQUEST_DECIDED`; 422 `LINKED_ASSET_REQUIRED / _NOT_PUBLISHED / _NOT_ALLOWED` |
| GET / PUT | `/languages` · `/languages/{code}` `Language` | content.read / lang.manage | upsert: новый язык — запись |
| GET / PUT | `/language-pairs` · `/language-pairs/{pair_id}` `LanguagePair & {reason}` | content.read / lang.manage | `PairCard`; 422 `PAIR_NOT_READY {missing}`, `UNKNOWN_LANGUAGE`, `PAIR_INVALID` |

`*_name`, `PairCard.learners` и `readiness.diagnostic_test` дополняет admin-bff (сотрудники — admin-identity, тест —
diagnostics); готовность теста диагностики при переводе пары в published проверяет тоже admin-bff. Создающие и
публикующие команды принимают необязательный `Idempotency-Key` (повтор — сохранённый ответ, `idempotent-replay: true`).
Тело ≤ 4,5 МБ — только у `POST /content/blobs` (внешний `UploadBodyMiddleware`), остальные маршруты — общий лимит 256 КБ.

## API для сервисов (`/internal/v1`, без actor)
| Метод | Путь | Кто | Ответ |
|---|---|---|---|
| GET | `/pairs` | telegram-bff, learning-plan, diagnostics | `{items: LanguagePair[]}` (кроме archived) |
| GET | `/courses/{course_id}/snapshot` | telegram-bff, learning-plan, diagnostics | `CourseSnapshot`; `ETag` = snapshot_version, `If-None-Match` → 304; 404 `COURSE_NOT_FOUND` |
| GET | `/scenarios?audience=&goal=&level=&topic=&cursor=&limit=` | telegram-bff | `Page<ScenarioCard>` |
| GET | `/scenarios/{id}?audience=` | telegram-bff | `ScenarioDetail` (без полного графа); 404 `SCENARIO_NOT_FOUND` |
| GET | `/media?audience=&type=&level=&topic=&cursor=` | telegram-bff | `Page<MediaCard>` |
| GET | `/media/{id}?audience=` · `/media/{id}/audio` | telegram-bff | `MediaDetail` / байты (`private, max-age=3600`, ETag sha256); 404 `MEDIA_NOT_AVAILABLE`, `AUDIO_NOT_FOUND` |
| POST / GET | `/media/requests` `{kind, title, link?, comment?, ui_locale?}` | telegram-bff (sub = аккаунт) | 201 `MediaRequest` / `{items}`; 403 `KIDS_NOT_ALLOWED`; 410 `USER_DELETED`; 429 `MEDIA_REQUEST_LIMIT` |
| GET | `/media/requests/{id}` | notifications, telegram-bff (только своя) | без ссылки и комментария для notifications |
| POST | `/catalog:tick` | n8n `catalog-tick` (Bearer SCHEDULER_TOKEN) | `{suspended, expiring, today}` |

`audience` (kids | teens | adults) **обязателен** для сценариев и медиа: возраст ученика знает только BFF, без параметра —
422 (отказ закрыт). Защита в глубину: детский профиль по claims внутреннего JWT (`lrn` ≠ `sub` или `age_band` ∈
{6-9, 10-13}) получает аудиторию kids принудительно, что бы ни пришло в `?audience=` (аудио — и без параметра);
заявки детскому профилю недоступны ни на создание, ни на чтение (403 `KIDS_NOT_ALLOWED`). Медиа ученику — только опубликованные, права действуют сегодня (Asia/Tashkent,
valid_from ≤ сегодня ≤ valid_to), территория UZ, источник разрешён флагом; транскрипт — при `show_transcript`, фразы — при
`dictionary`, аудио и `has_audio` — при `listen` (и наличии файла). Голоса синтеза (`voices`) назначаются говорящим по очереди en-GB / en-US.

## Проверки (INTERNAL_API §1.2)
Схема (create/PUT) → бизнес-правила (submit; publish/rollback/validate — в режиме публикации: ссылки только на
опубликованное, RU/UZ checked, права медиа подтверждены, зелёный прогон сценария этой версии). Коды: `SCHEMA_INVALID`,
`LOCALE_MISSING`, `LOCALE_SCRIPT` (UZ — латиница, oʻ/gʻ через U+02BB), `LOCALE_NOT_CHECKED`, `UNKNOWN_REF`, `REF_MISMATCH`,
`PREREQ_CYCLE`, `NO_CONTROL_ITEMS`, `STAGES_INVALID`, `RUBRIC_WEIGHTS`, `RUBRIC_BANDS`, `RUBRIC_MISMATCH`,
`SCENARIO_TEST_FAILED`, коды графа (`START_MISSING`, `UNKNOWN_NODE`, `UNREACHABLE_NODE`, `DEAD_END`, `TRAP`,
`NO_SUCCESS_END`, `UNKNOWN_SPEAKER`, `NO_RECOVERY_POINT`, `RECOVERY_CANNOT_FINISH`, `TOO_MANY_NODES`),
`END_HAS_TRANSITIONS`, `RIGHTS_REQUIRED`, `EXTERNAL_SOURCE_DISABLED`, `EMBED_INVALID`, `TRANSCRIPT_INVALID`,
`MEDIA_TOO_LONG`, `MEDIA_TOO_SHORT`, `AUDIENCE_EMPTY`, `KIDS_CONTENT` (детский урок → недетский сценарий; ссылки и
встраивание в детском контенте), `COUNT_OUT_OF_RANGE`, `DUPLICATE_ID`, `VALUE_REQUIRED`, `ANSWER_INVALID`, `LEVEL_RANGE`.
Ссылки «вниз» (курс → модули → уроки → навыки/сценарий/рубрика, упражнение → медиа) при публикации — только на
опубликованное; ссылки на контейнер (урок → модуль/курс) — существование. `CONTENT_IN_USE` считается по ссылкам «вниз»
и опубликованным парам курса. Публикация, снятие, откат, приостановка медиа и правка пары идут под общей
транзакционной advisory-блокировкой графа (`GRAPH_LOCK_CLASS`, порядок: граф → ключ) — проверки ссылок без гонок.
Смена `course_id` у опубликованной пары — с той же проверкой готовности, что и публикация. Упражнения: `line_index` — реплика-источник (shadowing — обязательно, остальные — по
желанию, в пределах транскрипта); `order_lines` — options из реплик транскрипта, answer — их правильный порядок.

## События
Публикует (outbox): `catalog.version.published.v1` (published | rolled_back | archived), `catalog.media.suspended.v1`,
`catalog.media_request.created.v1` (без текста), `catalog.media_request.decided.v1` (→ notifications; у обезличенной
заявки — не публикуется), `admin.audit.recorded.v1` (каждая команда: `content.*`, `media.suspended` от system,
`media_request.*`, `lang.*` — без текстов контента и заявок), `user.domain.deleted.v1 {domain: catalog, mode: anonymized}`.
Потребляет: `user.deletion.requested.v1` (только от identity-consent; inbox).

## Данные
`languages`, `language_pairs`; `content_versions` (тело JSONB, хеш, редакторы, проверка, отметки RU/UZ, права, публикация;
частичные уникальные индексы: одна published и один открытый черновик на ключ; триггер `content_versions_guard` —
тело правится только в черновике, у опубликованного/архивного/приостановленного неизменны тело и сведения о проверке,
допустимы только переходы жизненного цикла, DELETE — только черновиков); `content_pointers` («что видит ученик»);
`scenario_test_runs` (append-only); `media_blobs` (аудио ≤ 3 МБ, без UPDATE); `media_requests` (обезличиваются сагой
удаления); `deleted_users`; `outbox`/`inbox`. Миграции: `0001` — схема и триггеры, `0002` — языки и пары (ru-en published
с курсом en-core, остальные planned), `0003` — сид контента.

## Сид контента (миграция 0003)
`migrations/seed/*.json` (форматы content.ts; объект или массив; можно каталогом с `*.json`). Весь набор проверяется
как опубликованный — при ошибке миграция падает со списком. Публикуется v1 автора/проверяющего seed
(`00000000-0000-4000-a000-000000005eed`), локализации «проверено: сид» — **нужна вычитка UZ носителем** (отозвать проверку
можно новой версией через «на проверке»), права медиа подтверждены сидом, сценарии — с тестовым прогоном; аудит
`content.published` от system и события. Повтор с тем же содержимым — без изменений; изменённое тело — новая версия.
`SEED_DIR` переопределяет каталог (тесты используют маленький набор `tests/fixtures/seed`).

## Настройки
`SCHEDULER_TOKEN` (вход n8n; пусто — выключен; stage/prod ≥ 32), `MEDIA_EXTERNAL_SOURCES=false` (флаг
media.external_sources: licensed / platform_embed), `RIGHTS_WARNING_DAYS=14`, `TIMEZONE=Asia/Tashkent`,
`MEDIA_REQUESTS_PER_DAY=5`, `SEED_DIR`, общие `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_URL`, `NATS_URL`, ключи JWT.

## Runbook
- Медиа «пропало» у учеников — проверьте `rights.valid_to` (Ташкент) и статус версии: `suspended` (`rights_expired`)
  ставит `catalog:tick`; продление — новая версия с новыми правами → подтверждение прав → проверка → публикация.
- Миграция 0003 упала — в тексте ошибки список `kind:key: path CODE сообщение`; исправьте сид и повторите.
- Опубликованное правится только новой версией; откат — `rollback` к прежде опубликованной архивной версии.
- Тесты: `uv run pytest services/catalog -q -p no:cacheprovider` (стенд `infra/dev/stack.sh up`).

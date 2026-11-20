# catalog-service

**Владелец:** контент (методисты, контент-менеджер). **Bounded context:** учебное содержание TilHero — справочник языков
и языковых пар, курс, навыки с предпосылками, модули и уроки, рубрики, сценарии разговоров с проверкой графа, медиа с
правами и автоприостановкой, упражнения к медиа, заявки учеников на песни и фильмы, **тексты для чтения** (спринт 5).
Всё содержание — **версии** «черновик → на проверке → одобрен → опубликован → архив» (+ «приостановлен» у медиа) с откатом
и контролем локализаций RU/UZ (спринт 3, AT-26…31, AT-37, AT-38). Спринт 5 (AT-57, AT-60): **словарь курса**
(`glossary`) — статьи из ключевых слов уроков, фраз медиа и глоссариев текстов, статьи методиста и переводы ИИ на
проверке; поиск слова в опубликованном контенте и задания проверок удержания для memory.

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

`{kind}` — в том числе `reading` (спринт 5): тексты для чтения — общий API контента и права `content.*`, проверка вторым
методистом, `ContentSummary.by_kind.reading`.

### Словарь курса (`/admin/v1/glossary`, спринт 5, INTERNAL_API §2.5)
| Метод | Путь | Право | Ответ / ошибки |
|---|---|---|---|
| GET | `?pair_id=&q=&source=&review_status=&archived=&cursor=&limit=` | content.read | `Page<GlossaryRow>` (+ `updated_by` — id); без `archived=true` — только действующие; `review_status=pending` — очередь переводов ИИ по числу мест в контенте (`refs_count` ↓), иначе — по лемме |
| GET | `/stats?pair_id=` | dashboard.read \| content.read | `{pair_id, ai_glosses_pending, ai_approved, ai_rejected, entries: {course, methodist, ai}, overridden}` — `MemoryStats.ai_glosses_pending` для обзора берёт admin-bff отсюда |
| GET | `/{entry_id}` | content.read | `GlossaryDetail`: история (новые первыми, до 100; `by` — id, `by_name` дополняет admin-bff), `refs_titles` (null — снято с публикации), `conflicts`; 404 `GLOSSARY_ENTRY_NOT_FOUND` |
| POST | `/admin/v1/glossary` `GlossaryCreate` (Idempotency-Key) | glossary.manage | 201 `GlossaryDetail` (статья methodist); 409 `FORM_TAKEN {entry_id, form}`; 422 `GLOSSARY_INVALID {errors}` (пара, формы, UZ латиницей) |
| PATCH | `/{entry_id}` `GlossaryPatch`, `If-Match: "<updated_at>"` | glossary.manage | `GlossaryDetail`; 428 `IF_MATCH_REQUIRED`; 409 `VERSION_CONFLICT {updated_at}`, `FORM_TAKEN`, `ENTRY_ARCHIVED`; 422 `COURSE_ENTRY_LOCKED` (у course — только `override`), `OVERRIDE_COURSE_ONLY` |
| POST | `/{entry_id}/review` `GlossaryReview` (Idempotency-Key) | glossary.manage | `GlossaryDetail`: approve / correct (новый перевод, `corrected`) / reject; 409 `NOT_PENDING` (не ai, уже решена, в архиве); 422 без перевода у correct |
| DELETE | `/{entry_id}` `{reason}` | glossary.manage | 204 (архив, формы освобождаются; повтор — 204); 409 `ARCHIVE_NOT_ALLOWED {source}` — только статьи methodist |

Без step-up: правка действует сразу, каждая — в `glossary_history` и аудите `glossary.entry_created | updated | reviewed |
archived` (без переводов), каждая — событие `catalog.glossary.changed.v1`. `override` статьи course заменяет перевод и
пример целиком (`example_en: null` — без примера); `null` — снять. Форма, занятая **отклонённым** переводом ИИ, уступается
статье методиста (отклонённая статья архивируется), занятая любой другой действующей статьёй — 409 `FORM_TAKEN`.

`*_name`, `PairCard.learners` и `readiness.diagnostic_test` дополняет admin-bff (сотрудники — admin-identity, тест —
diagnostics); готовность теста диагностики при переводе пары в published проверяет тоже admin-bff. Создающие и
публикующие команды принимают необязательный `Idempotency-Key` (повтор — сохранённый ответ, `idempotent-replay: true`).
Тело ≤ 4,5 МБ — только у `POST /content/blobs` (внешний `UploadBodyMiddleware`), остальные маршруты — общий лимит 256 КБ.

## API для сервисов (`/internal/v1`, без actor)
| Метод | Путь | Кто | Ответ |
|---|---|---|---|
| GET | `/pairs` | telegram-bff, learning-plan, diagnostics, lessons | `{items: LanguagePair[]}` (кроме archived) |
| GET | `/courses/{course_id}/snapshot` | telegram-bff, learning-plan, diagnostics, lessons | `CourseSnapshot`; `ETag` = snapshot_version, `If-None-Match` → 304; 404 `COURSE_NOT_FOUND` |
| GET | `/scenarios?audience=&goal=&level=&topic=&cursor=&limit=` | telegram-bff, lessons | `Page<ScenarioCard>` |
| GET | `/scenarios/{id}?audience=` | telegram-bff, lessons | `ScenarioDetail` (без полного графа); 404 `SCENARIO_NOT_FOUND` |
| GET | `/media?audience=&type=&level=&topic=&cursor=` | telegram-bff, lessons | `Page<MediaCard>` |
| GET | `/media/{id}?audience=` | telegram-bff, lessons | `MediaDetail`; 404 `MEDIA_NOT_AVAILABLE` |
| GET | `/media/{id}/audio` | telegram-bff | байты (`private, max-age=3600`, ETag sha256); 404 `MEDIA_NOT_AVAILABLE`, `AUDIO_NOT_FOUND` |
| GET | `/media/{id}/exercises?audience=` | lessons | `{asset_id, asset_version, items: [{exercise_id, version, asset_id, type, skill_id, level, instruction, prompt_en, options, line_index, rubric_id}]}` — опубликованные упражнения **без `answer`** (≤ 100, по exercise_id); аудитория и права — как у карточки; лицензия без `exercises` → `items: []`; 404 `MEDIA_NOT_AVAILABLE` |
| GET | `/versions/{kind}/{key}` | lessons, assessment | текущая опубликованная версия (по указателю) той же формы — lessons фиксирует номера версий при старте сессии; не опубликована / снята / приостановлена → 404 `VERSION_NOT_FOUND`; `Cache-Control: private, no-cache`, `ETag` = `"<version>.<payload_hash>"`, `If-None-Match` → 304 (дополнение к §4: без него lessons не узнаёт номер опубликованной версии) |
| GET | `/versions/{kind}/{key}/{version}` | lessons, assessment | `{kind, key, version, payload, payload_hash}` — полное тело **с ключами**; только published или archived, бывшая опубликованной (draft, in_review, approved, вытесненная без публикации, suspended → 404 `VERSION_NOT_FOUND`; вид → 404 `CONTENT_KIND_UNKNOWN`); `Cache-Control: private, max-age=31536000, immutable`, `ETag` = payload_hash, `If-None-Match` → 304 |
| POST / GET | `/media/requests` `{kind, title, link?, comment?, ui_locale?}` | telegram-bff (sub = аккаунт) | 201 `MediaRequest` / `{items}`; 403 `KIDS_NOT_ALLOWED`; 410 `USER_DELETED`; 429 `MEDIA_REQUEST_LIMIT` |
| GET | `/media/requests/{id}` | notifications, telegram-bff (только своя) | без ссылки и комментария для notifications |
| POST | `/catalog:tick` | n8n `catalog-tick` (Bearer SCHEDULER_TOKEN) | `{suspended, expiring, today}` |
| GET | `/readings?audience=&pair_id=&level=&cursor=&limit=` | telegram-bff, lessons | `Page<{reading_id, version, title, level, topics, est_minutes, word_count}>` (ReadingCard без `last_result` — его дополняет BFF из lessons); пара — только с target = en |
| GET | `/readings/{reading_id}?audience=` | telegram-bff, lessons | опубликованная версия **без `answer`**: `{…карточка, skill_ids, voice, paragraphs, glossary: [{en, gloss, note}], questions: [{question_id, type, instruction, prompt_en, options}], questions_count, question_types}` (`glossary[].in_dictionary` ReadingView дополняет BFF из memory); 404 `READING_NOT_AVAILABLE` |
| POST | `/glossary/lookup` `{pair_id, text ≤ 120, content_ref: {kind, key, version, locator?}, audience?}` | memory | `{in_content: true, sentence_en ≤ 300, locator, entry: GlossaryEntry \| null, rejected, note}`; 404 `CONTENT_NOT_FOUND` (не опубликована и не была; приостановленное медиа); 422 `WORD_NOT_IN_CONTENT` |
| POST | `/glossary/ai-entries` `{pair_id, surface, lemma, part_of_speech, gloss, forms ≤ 8, confidence, agent_version, content_ref, audience?}` | memory | 201 `GlossaryEntry` (ai pending); 200 — форма уже занята действующей статьёй (она же; у ai pending дописывается место в контенте); 404 `CONTENT_NOT_FOUND`, `PAIR_NOT_FOUND`; 422 `WORD_NOT_IN_CONTENT` |
| GET | `/glossary/forms?pair_id=&forms=a&forms=b` (≤ 50) | memory | `{items: [{form, entry: GlossaryEntry \| null}]}` — повторяемый параметр (формы с запятыми); одно значение через запятую — в ответе и целиком, и по частям; варианты «a / b» — каждый |
| GET | `/skills/{skill_id}/check-items?audience=&pair_id=` | memory | `{skill_id, title, items: [{lesson_id, version, item: ControlItem с ключом}]}` — уроки курса пары с `primary_skill_id` = навык и аудиторией; сначала задания навыка, затем остальные задания этих уроков (по уроку и порядку), ≤ 20; 404 `SKILL_NOT_FOUND` |

`/versions/{kind}/{key}[/{version}]` (спринт 5) — ещё memory, только `lesson`, `media_asset`, `reading`, `scenario`
(другие виды → 403 `CALLER_NOT_ALLOWED`). **Дети — только детский контент** (CONVENTIONS §8): необязательный
`audience` (`?audience=` у версий, поле тела у `glossary/lookup` и `glossary/ai-entries`); при `kids` версия, в
аудитории которой нет kids (урок, медиа, текст, сценарий), — 404 (`VERSION_NOT_FOUND` / `CONTENT_NOT_FOUND`), как
будто её нет. У memory детский профиль в claims (`lrn` ≠ `sub` или `age_band` 6–13) — kids принудительно; без
`audience` — как раньше. Ученические маршруты текстов, как сценарии и медиа: `audience` обязателен,
детскому профилю (claims) — kids принудительно; то же у `check-items`.

**Поиск слова** (`lookup`, `ai-entries`): текст ищется по границам слов (буквы и цифры, апостроф внутри слова —
`I’m` ≡ `I'm`; дефис разделяет; регистр и пунктуация не важны) подряд — в предложении `locator` или во всей версии:
reading — предложения (`s_id`) и вопросы (`q:<id>`); media_asset — реплики (`"<индекс>"`) и фразы (`ph:<i>`); lesson —
примеры (`ex:<i>`), опорные слова с их примерами (`kw:<i>`), задания (`ci:<i>`, без ключей); scenario — реплики узлов и
образцы реплик (`node_id`). Статья — по ключу формы (слова через пробел); отклонённый перевод ИИ не выдаётся
(`rejected: true`, ИИ его заново не переводит). `note` — пояснение глоссария текста.

Ключи ответов отдаёт только `/versions` (оценщик assessment и lessons — версии, зафиксированные в сессии; тело версии
неизменяемо триггером, поэтому кеш у вызывающих бессрочный и в ответе нет статуса и дат). Приостановленная по правам
версия медиа по номеру не отдаётся — показывать её ученику нельзя (сессия, начатая до приостановки, у lessons
завершается `failed`).

`audience` (kids | teens | adults) **обязателен** для сценариев, медиа и упражнений к медиа: возраст ученика знает только BFF, без параметра —
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
`SCENARIO_TEST_FAILED`, тексты для чтения — `READING_WORDS` (60..250 слов), `SENTENCE_TOO_LONG` (> 30 слов),
`GLOSSARY_NOT_IN_TEXT` (статья глоссария не встречается словом в тексте), `TEXT_TOO_LONG` (перевод глоссария > 80,
пояснение > 160), коды графа (`START_MISSING`, `UNKNOWN_NODE`, `UNREACHABLE_NODE`, `DEAD_END`, `TRAP`,
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
Задания «по порядку» (R1-13, `ANSWER_INVALID` на `options`): у `order_words` варианты обязательны (слова для порядка)
и не стоят в порядке ответа, у `order_lines` — answer не `0, 1, 2, …`; ученику lessons показывает их перемешанными по
seed сессии.

Текст для чтения (§2.1): 1..8 абзацев по 1..8 предложений, `s_id`/`p_id`/`question_id` уникальны (`DUPLICATE_ID`),
60..250 слов (дефисное слово — одно), предложение ≤ 30 слов; глоссарий 3..20 без повторов, каждая статья — в тексте по
границам слов; вопросы 3..8: single_choice — 3–4 разных варианта и индекс, true_false — `["True", "False"]` и 0/1,
gap_fill — без вариантов, непустые допустимые ответы (`ANSWER_INVALID`); перевод RU/UZ у каждого предложения
(`LOCALE_MISSING`, `LOCALE_SCRIPT`); детский текст — только `["kids"]` (`KIDS_CONTENT`); навыки ≤ 3 (при публикации —
опубликованные), `est_minutes` 3..15 (`COUNT_OUT_OF_RANGE`).

## События
Публикует (outbox): `catalog.version.published.v1` (published | rolled_back | archived; kind — в том числе `reading`),
`catalog.glossary.changed.v1 {pair_id, entry_id, forms ≤ 8, change: created | updated | reviewed | archived}` (каждое
изменение статьи — построение при публикации, переводы ИИ, команды админки; формы правки — старые и новые, больше 8 —
несколькими событиями; memory сбрасывает кеш перевода), `catalog.media.suspended.v1`,
`catalog.media_request.created.v1` (без текста), `catalog.media_request.decided.v1` (→ notifications; у обезличенной
заявки — не публикуется), `admin.audit.recorded.v1` (каждая команда: `content.*`, `media.suspended` от system,
`media_request.*`, `lang.*`, `glossary.entry_*` — без текстов контента и заявок), `user.domain.deleted.v1 {domain: catalog,
mode: anonymized}`. В словаре курса персональных данных нет (сага удаления его не касается).
Потребляет: `user.deletion.requested.v1` (только от identity-consent; inbox).

## Данные
`languages`, `language_pairs`; `content_versions` (тело JSONB, хеш, редакторы, проверка, отметки RU/UZ, права, публикация;
частичные уникальные индексы: одна published и один открытый черновик на ключ; триггер `content_versions_guard` —
тело правится только в черновике, у опубликованного/архивного/приостановленного неизменны тело и сведения о проверке,
допустимы только переходы жизненного цикла, DELETE — только черновиков); `content_pointers` («что видит ученик»);
`scenario_test_runs` (append-only); `media_blobs` (аудио ≤ 3 МБ, без UPDATE); `media_requests` (обезличиваются сагой
удаления); `deleted_users`; `outbox`/`inbox`. Спринт 5: `glossary_entries` (статьи: лемма, формы, перевод, пример, источник,
статус проверки ИИ, `refs` ≤ 50 — одна ссылка на ключ контента, первая — источник статьи course, `override`, архив),
`glossary_forms` (PK `(pair_id, form_key)` — форма действующей статьи уникальна в паре; при архиве удаляется),
`glossary_history` (только добавление — триггер `catalog_append_only`, UPDATE/DELETE/TRUNCATE запрещены). Миграции:
`0001` — схема и триггеры, `0002` — языки и пары (ru-en published с курсом en-core, остальные planned), `0003` — сид
контента, `0004` — вид `reading` и словарь курса, построенный по всем опубликованным урокам, медиа и текстам (без
событий), `0005` — сид текстов для чтения и их статьи словаря.

## Словарь курса: построение (INTERNAL_API §2.2)
Публикация и откат версии урока (`key_words`), медиа (`phrases`, только при `allowed_uses ∋ dictionary`) и текста
(`glossary`) в той же транзакции строят статьи course (`domain/glossary_build.py`, тот же код в миграциях). Пары: урок —
пара его курса, медиа и текст — пары с target = en. Формы элемента — варианты через « / » («Goodbye! / Bye!» →
goodbye, bye; многоточие-место убирается: «My name is …» → my name is). Для каждой формы: свободна — войдёт в новую
статью course (лемма, перевод, пример — из элемента; пример медиа и текста — реплика или предложение с этим словом);
у статьи course или methodist — дописывается ref, перевод не меняется (первая публикация главнее, расхождение — в
`conflicts`); исключение — статья course из того же ключа контента берёт перевод новой версии (история `updated`); у
статьи ai — та архивируется (course главнее). Всё — под advisory-блокировкой пары, общей с переводами ИИ и правками.

## Сид контента (миграция 0003)
`migrations/seed/*.json` (форматы content.ts; объект или массив; можно каталогом с `*.json`). Весь набор проверяется
как опубликованный — при ошибке миграция падает со списком. Публикуется v1 автора/проверяющего seed
(`00000000-0000-4000-a000-000000005eed`), локализации «проверено: сид» — **нужна вычитка UZ носителем** (отозвать проверку
можно новой версией через «на проверке»), права медиа подтверждены сидом, сценарии — с тестовым прогоном; аудит
`content.published` от system и события. Повтор с тем же содержимым — без изменений; изменённое тело — новая версия.
`SEED_DIR` переопределяет каталог (тесты используют маленький набор `tests/fixtures/seed`).

Тексты для чтения (миграция 0005): `migrations/seed/readings.json` (массив `ReadingPayload`; или каталог `readings/`) —
так же: проверка всего набора как опубликованного, v1 автора seed, «проверено: сид», аудит и события
(`kind: reading`), затем статьи словаря из глоссариев. Нет файла — миграция ничего не делает. Откат 0005 снимает тексты
сида и статьи, построенные только из них.

## Настройки
`SCHEDULER_TOKEN` (вход n8n; пусто — выключен; stage/prod ≥ 32), `MEDIA_EXTERNAL_SOURCES=false` (флаг
media.external_sources: licensed / platform_embed), `RIGHTS_WARNING_DAYS=14`, `TIMEZONE=Asia/Tashkent`,
`MEDIA_REQUESTS_PER_DAY=5`, `SEED_DIR`, общие `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_URL`, `NATS_URL`, ключи JWT.

## Runbook
- Медиа «пропало» у учеников — проверьте `rights.valid_to` (Ташкент) и статус версии: `suspended` (`rights_expired`)
  ставит `catalog:tick`; продление — новая версия с новыми правами → подтверждение прав → проверка → публикация.
- Миграция 0003 упала — в тексте ошибки список `kind:key: path CODE сообщение`; исправьте сид и повторите.
- Опубликованное правится только новой версией; откат — `rollback` к прежде опубликованной архивной версии.
- Перевод слова «не тот» — карточка статьи: у course — `override` (или новая версия контента-источника), у methodist —
  правка, у ai — решение `correct`. Memory сбросит кеш по событию `catalog.glossary.changed.v1`.
- Форма «занята» (`FORM_TAKEN`) — откройте статью из `details.entry_id`: допишите перевод там или освободите форму.
- Перевод ИИ показывается ученикам, пока на проверке (`pending`, уверенность ≥ 0,5 — решает memory); отклонённый —
  больше никогда (форма остаётся занятой отклонённой статьёй, пока методист не создаст свою).
- Тесты: `uv run pytest services/catalog -q -p no:cacheprovider` (стенд `infra/dev/stack.sh up`).

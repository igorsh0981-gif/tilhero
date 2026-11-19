# Спринт 3 — внутренние контракты (контент и диагностика)

Форматы контента — `packages/contracts/src/content.ts` (единственный источник; pydantic-модели catalog повторяют их 1:1, контрактный тест сверяет поля). Публичные API: ученик — `packages/contracts/src/bff.ts` (раздел «Спринт 3»), админка — `packages/contracts/src/admin.ts` (раздел «Контент и диагностика»). Внутренний JWT, actor, права в домене, outbox/inbox, ErrorBody, Idempotency-Key, пагинация — как в спринтах 1–2 (CONVENTIONS, `docs/sprint2/INTERNAL_API.md`).

## 1. catalog (8110, схема `catalog`, пакет `tilhero_catalog`, новый)

### 1.1 Данные
- `languages`, `language_pairs` — справочник (`Language`, `LanguagePair`); правка — `lang.manage` (step-up), аудит `lang.*`. Сид: en (active), ru, uz, kk; пары ru-en (published, course `en-core`), ru-uz, ru-kk (planned), en-uz, en-kk (planned).
- `content_versions` (kind, key, version, status, payload JSONB, payload_hash, author_id, created_at, submitted_at, reviewer_id, reviewed_at, review_note, locale_checks JSONB `{ru: LocaleCheck, uz: LocaleCheck}`, rights_approved_by, rights_approved_at (только media_asset), published_by, published_at, archived_at, suspended_at, suspend_reason). Уникальность (kind, key, version); не больше одной `published` на (kind, key) — частичный индекс. Опубликованные и архивные версии неизменяемы (UPDATE запрещён триггером — защита в глубину).
- `content_pointers` (kind, key, published_version, previous_version) — «что видит ученик»; откат меняет указатель.
- `media_blobs` (blob_id, content_type audio/mpeg|audio/ogg|audio/mp4, bytes ≤ 3 МБ, sha256, uploaded_by, created_at) — аудио авторских сценок.
- `media_requests` (request_id, user_id, kind song|movie|series|other, title ≤ 200, link ≤ 500 | null, comment ≤ 500 | null, ui_locale, status `MediaRequestStatus`, decision_note ≤ 500, linked_asset_id, decided_by, decided_at, created_at). Удаление ученика — анонимизация (user_id → null, comment и link → null) по саге удаления.

### 1.2 Жизненный цикл версии (AT-26, AT-27)
`draft` → (submit: валидация вида; ошибки → 422 `CONTENT_INVALID {errors: [{path, code, message}]}`) → `in_review` → (review approve: `content.review`, проверяющий ≠ автор → иначе 409 `SELF_REVIEW`; отметки локализаций ru/uz = checked; return → `draft` с заметкой) → `approved` → (publish: `content.publish`, step-up в admin-bff; для `media_asset` ещё и `rights_approved` от `media.rights`; повторная валидация целостности курса) → `published` (прежняя published → `archived`, указатель обновлён). `archive` — снять с публикации (указатель → null; для курса/модуля/навыка/урока — 409 `CONTENT_IN_USE`, если на ключ ссылается опубликованная сущность). `rollback {to_version}` — публикует указанную архивную версию (повторная валидация), текущая → archived. Правка опубликованного = новая версия-черновик (`POST …/versions {from_version}`).
- **Валидация при submit/publish** (коды): `LOCALE_MISSING` (пустой Localized), `LOCALE_NOT_CHECKED` (при publish), `UNKNOWN_REF` (skill/module/lesson/rubric/scenario/asset не существует или не опубликован при publish), `PREREQ_CYCLE`, `NO_CONTROL_ITEMS` (урок < 3), `STAGES_INVALID` (5 типов, сумма минут = duration_min), `RUBRIC_WEIGHTS`, `SCENARIO_TEST_FAILED` (последний прогон не ok или устарел относительно payload_hash), `RIGHTS_REQUIRED` (медиа: нет прав, нет UZ в territories, `valid_to` в прошлом, нет `attribution` для cc_by*), `EXTERNAL_SOURCE_DISABLED` (origin licensed/platform_embed при выключенном флаге), `TRANSCRIPT_INVALID`, `MEDIA_TOO_LONG` (> 90 с), `AUDIENCE_EMPTY`, `KIDS_CONTENT` (сущность с audience kids ссылается на не-kids медиа/сценарий).
- **Тестовый прогон сценария** (`POST …/scenario/{key}/versions/{v}/test-run` → `ScenarioTestRun`, сохраняется с payload_hash): BFS от start; проверки — коды из `ScenarioTestRun.issues`; recovery: при > 6 узлах — хотя бы один recovery_point кроме start, и из каждого recovery_point достижим success.
- **Медиа**: `POST …/media_asset/{key}/versions/{v}/rights:approve {note}` (`media.rights`, step-up) — фиксирует проверку прав (права в payload; одобрение сбрасывается при правке черновика). Флаг `media.external_sources` — env `MEDIA_EXTERNAL_SOURCES=false`.
- Аудит каждой команды: `content.version_created | updated | submitted | reviewed | returned | published | archived | rolled_back | rights_approved | test_run`, `media.suspended`, `media_request.decided`, `lang.*` — через `admin.audit.recorded.v1` (outbox).

### 1.3 Истечение прав (AT-29)
`POST /internal/v1/catalog:tick` (SCHEDULER_TOKEN, n8n `catalog-tick` каждый час): опубликованные `media_asset` с `valid_to < today (Asia/Tashkent)` → `suspended` (указатель снят, suspend_reason `rights_expired`), событие `catalog.media.suspended.v1`, аудит от system; повтор безопасен. Сводка для обзора админки — истекающие в ≤ 14 дней.

### 1.4 API для сервисов и BFF (`/internal/v1`, без actor)
Вызывающие: telegram-bff (ученик — `sub`/`lrn` в токене, где сказано), learning-plan, diagnostics.
- `GET /internal/v1/pairs` → `{items: LanguagePair[]}` (кроме archived).
- `GET /internal/v1/courses/{course_id}/snapshot` → `CourseSnapshot` (bff.ts): опубликованные курс, модули, навыки, уроки (**без** `control_items[].answer`), рубрики, `snapshot_version` (хеш указателей) + ETag; вызывающие кешируют по ETag. learning-plan и diagnostics — полный, telegram-bff — то же.
- `GET /internal/v1/scenarios?goal=&level=&topic=&audience=&cursor=&limit=` → `Page<ScenarioCard>`; `GET /internal/v1/scenarios/{id}` → `ScenarioDetail` (для ученика: задача, персонажи, критерии, пример начала — без полного графа).
- `GET /internal/v1/media?type=&level=&topic=&audience=&cursor=` → `Page<MediaCard>` — только published, права действуют сегодня, territories ∋ UZ, audience; `GET /internal/v1/media/{id}?audience=` → `MediaDetail` (транскрипт — только при allowed_uses ∋ show_transcript; attribution всегда); `GET /internal/v1/media/{id}/audio` → байты (`Cache-Control: private, max-age=3600`, ETag sha256), 404 без файла.
- `POST /internal/v1/media/requests` (subject: аккаунт 14+ или опекун; детский профиль → 403 `KIDS_NOT_ALLOWED`; ≤ 5 в сутки → 429) `{kind, title, link?, comment?}` → `MediaRequest`; `GET /internal/v1/media/requests` (свои) → `{items}`.
- `GET /internal/v1/media/requests/{id}` — для notifications (без PII ученика, кроме user_id).

### 1.5 Admin API (`/admin/v1/content/*`, `/admin/v1/languages/*`, actor, права в домене) — пути и формы `admin.ts`.

### 1.6 События
- `catalog.version.published.v1` {kind, key, version, previous_version, course_id?, published_by, published_at} — также при rollback и archive (`action: published|rolled_back|archived`).
- `catalog.media.suspended.v1` {asset_id, version, reason: rights_expired|rights_revoked, suspended_at}.
- `catalog.media_request.decided.v1` {request_id, user_id, status, title, linked_asset_id?, decided_at} → notifications.
- `catalog.media_request.created.v1` {request_id, user_id, kind, created_at} (для счётчиков админки; без текста).

## 2. diagnostics (8111, схема `diagnostics`, пакет `tilhero_diagnostics`, новый)

### 2.1 Тест и задания
- `tests` (test_id, version, status draft|published|archived, pair_id, audience adults|kids, config JSONB, items JSONB, created_by, published_at) — сид: `dx-en-adult` v1 (~90 заданий), `dx-en-kids` v1 (~36). Публикация новой версии — `content.publish` (admin), прохождение старых сессий — на своей версии.
- Задание: `{item_id, area: vocabulary|grammar|reading|listening, band, tags[], skill_ids[], type: single_choice|gap_choice|order_words|read_choice|listen_choice, instruction: Localized, prompt_en, passage_en|null (чтение ≤ 600 знаков), audio_text_en|null (аудирование: текст для синтеза речи устройством, ≤ 300), options[], answer: index | string[] (порядок слов)}`; ключ ученику не отдаётся никогда.
- config: `{areas: [vocabulary, grammar, reading, listening], items_per_area: 6 (kids 3), start_band: A1 (kids A0), min_items_assessed: 3 (kids 2), followup_items: 3, retest_days: 14, time_limit_min: 15}`.

### 2.2 Сессия и подбор (AT-32)
- `sessions` (session_id, user_id, pair_id, test_id, test_version, seed, status in_progress|finished|abandoned, started_at, finished_at, listening_available), `answers` (session_id, seq, item_id, area, band, answer, correct, dont_know, time_ms, answered_at).
- Порядок областей — по кругу V → G → R → L. Лестница по области: старт `start_band`; верно → полоса выше, неверно или «не знаю» → ниже (в пределах A0…B2). Задание внутри (область, полоса): ещё не показанное, минимальное по `sha256(seed + item_id)` — воспроизводимо по (test_version, seed, ответы). Нет заданий нужной полосы — ближайшая доступная.
- Аудирование недоступно (`POST …/listening-unavailable`) → область `not_assessed` с причиной `no_speech_voice`, остальные идут дальше.
- Сессия живёт 24 ч; новая сессия делает прежнюю `abandoned`. Подсказок нет; «не знаю» — неверно, но не угадывание.

### 2.3 Оценка (AT-32, AT-33)
- По области: ответов < `min_items_assessed` → `not_assessed`; иначе полоса = наивысшая, где верных ≥ 2 и точность ≥ 0,6 (если таких нет — на ступень ниже стартовой, минимум A0); уверенность = clamp(0,2 + 0,1·n + 0,4·согласованность − 0,2·скачки, 0, 1), где согласованность — доля ответов, согласных с итоговой полосой. `needs_followup` при уверенности < 0,5.
- Говорение и письмо — `not_assessed` (`reason: not_in_test_yet`).
- Общий предварительный уровень — медиана оценённых областей (округление вниз); при < 2 оценённых — null. Флаг `cefr_certificate: false` всегда.
- Слабые стороны — области с полосой ниже медианы или `not_assessed` (отдельно).
- Рекомендация старта — по снимку курса: первый core-урок курса (порядок модулей и уроков), у которого основной навык не `demonstrated`, а предпосылки `demonstrated` или уровня ниже оценённой полосы области навыка; детям — первый урок с audience kids.
- Уточнение (`POST …/followup {area}`): только при needs_followup, в течение 24 ч после завершения, + `followup_items` заданий области → новый результат-ревизия (`results.revision += 1`, прежний сохраняется).
- `results` (result_id, session_id, user_id, pair_id, revision, test_id, test_version, profile JSONB, provisional_level, recommended_start_lesson_id, created_at) — неизменяемы.

### 2.4 Карта навыков (AT-35)
- `skill_states` (user_id, pair_id, skill_id, state not_started|learning|demonstrated|retained, confidence, updated_at, source) и `skill_evidence` (id, user_id, pair_id, skill_id, source diagnostic|lesson|retention, ref_id, outcome positive|negative, band, created_at) — история не удаляется.
- После результата: для каждого навыка курса по `diagnostic_tags`/`skill_ids` заданий: есть верные и нет неверных той же или ниже полосы → `demonstrated`; есть неверные → `learning`; не затронут → не меняется (`not_started` по умолчанию). `retained` — только спринт 5 (проверки удержания). Понижение `demonstrated` → `learning` — только при двух отрицательных свидетельствах подряд.
- События `skills.state.changed.v1`.

### 2.5 API (`/internal/v1`, вызывающий telegram-bff, subject — ученик `lrn`)
- `GET /internal/v1/diagnostics/state?pair_id=` → `DiagnosticState`; `POST /internal/v1/diagnostics/sessions {pair_id}` (Idempotency-Key) → `DiagnosticSession`; 409 `DIAGNOSTIC_TOO_SOON {next_allowed_at}`; 409 `PAIR_NOT_AVAILABLE`.
- `GET …/sessions/{id}/next` → `DiagnosticItem | {done: true}`; `POST …/sessions/{id}/answers {item_id, answer | null, dont_know, time_ms}` → `{accepted, next: DiagnosticItem | null, done}`; повтор ответа на тот же item_id — 200 без изменений; ответ не на текущее задание → 409 `ITEM_NOT_CURRENT`.
- `POST …/sessions/{id}/listening-unavailable`, `POST …/sessions/{id}/finish` → `DiagnosticResult`; `POST /internal/v1/diagnostics/results/{id}/followup {area}` → `DiagnosticSession` (продолжение).
- `GET /internal/v1/diagnostics/results?pair_id=` → `{items: DiagnosticResult[]}` (история); `GET …/results/{id}`.
- `GET /internal/v1/skills/map?pair_id=` → `SkillMap` (состояния + последние 5 свидетельств навыка; названия навыков дополняет BFF из снимка курса).
- Admin: `GET /admin/v1/diagnostics/tests`, `…/tests/{id}/versions/{v}` (с ключами — content.read), `POST …/tests/{id}/versions/{v}/publish` (content.publish), `GET /admin/v1/diagnostics/stats?period=` (dashboard.read) → прохождения, распределение полос, доля not_assessed по областям.
- Сага удаления: участвует как остальные (`user.deletion.requested.v1` → удалить сессии, ответы, результаты, состояния → `user.domain.deleted.v1`).

### 2.6 События
- `diagnostics.completed.v1` {user_id, pair_id, result_id, revision, test_id, test_version, provisional_level, areas: {area: {status, band, confidence}}, recommended_start_lesson_id, completed_at}.
- `skills.state.changed.v1` {user_id, pair_id, changes: [{skill_id, from, to, source, evidence_id}], occurred_at}.

## 3. learning-plan — траектория (AT-36, AT-34)
- Потребляет `diagnostics.completed.v1`, `skills.state.changed.v1`, `catalog.version.published.v1` (kind course|module|lesson|skill — пересчёт отложенно, при следующем чтении), собственное изменение цели.
- `trajectories` (user_id, pair_id, revision, basis JSONB {diagnostic_result_id, goal, topics, audience, course_snapshot_version}, next_lesson_id, items JSONB, computed_at) — история ревизий хранится; текущая — последняя.
- Алгоритм (детерминированный, навык `curriculum_planner` без LLM): (1) обязательные = core-уроки курса по порядку, начиная с рекомендованного старта, без уроков, чей основной навык `demonstrated`; перед уроком вставляются уроки, закрывающие его недостающие предпосылки; (2) дополнительные = optional-уроки, совпадающие с целью или темами ученика (≤ 8); (3) аудитория: детям — только audience kids; (4) следующий — первый обязательный; `reason_codes`: `start_after_diagnostic`, `no_diagnostic`, `prerequisite_missing`, `weak_area`, `goal_match`, `topic_match`, `next_in_course`; объяснение — Localized из кодов. Без диагностики — траектория от начала курса с `no_diagnostic`.
- `GET /internal/v1/plan/trajectory?pair_id=` (subject — ученик) → `Trajectory`; пересчёт при отсутствии актуальной ревизии; смена цели (`PUT plan`) → новая ревизия, прежние сохраняются; выполненные уроки (спринт 4) не теряются.
- Событие `learning.trajectory.updated.v1` {user_id, pair_id, revision, next_lesson_id, reason_codes, computed_at}.

## 4. notifications
- Шаблон `media_request.decided` (категория support; параметры: request_title, status, note; RU/UZ; редактируемый, плейсхолдеры `{request_title}`, `{decision}`); consumer `catalog.media_request.decided.v1` → запись ученику (детям не бывает — заявки только у аккаунтов). Маршрут startapp `route_media_requests`.
- Каталог маршрутов `release-notes.json` + `diagnostics`, `plan`, `skills`, `scenarios`, `media`, `media_requests`, `languages` (для «Что нового» и уведомлений).

## 5. admin-identity
Миграция `0003`: права `content.read`, `content.edit`, `content.review`, `content.publish`, `media.rights`, `lang.manage`; роль `content_manager`; матрица — `PLAN.md`. Права со step-up: + `content.publish`, `media.rights`, `lang.manage` (роль с ними — привилегированная).

## 6. admin-bff, admin-web
Маршруты и формы — `admin.ts` («Контент и диагностика»): прокси к catalog и diagnostics с проверкой прав и step-up (publish, rollback, archive, rights:approve, lang.*, test publish), имена сотрудников `*_name` через lookup, загрузка аудио (JSON base64 ≤ 3 МБ → тело ≤ 4,5 МБ только на этом маршруте). admin-web: разделы `content` и `langs` (меню из сида), блок «Контент» на обзоре.

## 7. telegram-bff, Mini App
Маршруты `bff.ts` («Спринт 3»): диагностика, результат, история, карта навыков, траектория, сценарии, медиа (аудио — прокси с кешем), заявки, языки. Ученик идентифицируется как в спринте 1 (`lrn`); пара — `ru-en` по умолчанию (`X-Pair` не нужен).

## 8. infra
Порты 8110/8111, схемы и роли `catalog`, `diagnostics` (+ `_owner`) в `infra/db/bootstrap.sql`, издатели JWT `catalog`, `diagnostics`, n8n `catalog-tick` (`CATALOG_URL`), Railway setup, CI-матрицы, схемы событий.

# Спринт 5 — внутренние контракты (память, повторения, чтение, произношение)

Публичные API:
- ученик — `packages/contracts/src/bff.ts`, раздел «Спринт 5»;
- админка — `packages/contracts/src/admin.ts`, раздел «Память, словарь курса, чтение»;
- агенты — `packages/contracts/src/ai.ts` (`gloss_word`, оценка произношения);
- формат текста для чтения и статьи словаря — `packages/contracts/src/content.ts`.

Общие механизмы — как в спринтах 1–4: внутренний JWT, actor, права в домене, outbox/inbox, ErrorBody, Idempotency-Key, пагинация, сага удаления.

## 0. Общее
- **Новый сервис memory** — порт 8116, схема `memory`, пакет `tilhero_memory`, издатель JWT `memory`.
- **Кто кого вызывает:**
  - telegram-bff → memory (словарь, повторение, перевод, произношение), lessons (чтение), catalog (список текстов);
  - memory → catalog (версии контента, словарь курса, задания проверок), assessment (ошибки оценки), ai-gateway (`gloss_word`, произношение, статус), identity-consent (`/public` — согласие на голос);
  - lessons → catalog (тексты), assessment (оценка вопросов к тексту);
  - admin-bff → memory (память, аналитика), catalog (словарь курса, тексты — общий API контента), ai-gateway (цены и затраты речи);
  - n8n → memory (`memory-tick`).
- **Ученик в токене.** Как в спринте 4: `sub` — аккаунт, `lrn` — активный ученик, claims `lrn` и `age_band` в каждом вызове. Ученик memory — `lrn`. `age_band` — полоса активного ученика (у детского профиля — ребёнка: 6-9 и 10-13 различаются). telegram-bff передаёт также `?audience=` и `?locale=`. Аудитория: `age_band` 6-9 / 10-13 → kids, 14-17 → teens, 18+ → adults.
- **Время.** UTC в API. «День» ученика — по часовому поясу плана: memory держит проекцию из `learning.plan.updated.v1`, без проекции — `Asia/Tashkent`.
- **Тексты учеников.** Цитаты ошибок, ввод в повторении и аудио — никогда в логах, событиях и метриках. Аудио не хранится нигде (§1.9).

## 1. memory (8116)

### 1.1 Данные
- **`cards`** — личный словарь.
  - Поля:
    - `card_id`, `user_id` (`lrn`), `pair_id`;
    - `kind`: `word | phrase | error`;
    - `key`: нормализованный английский текст (§1.6); для error — `correction`;
    - `text_en` ≤ 120; `gloss` Localized; `gloss_source`: `course | methodist | ai`; `example_en` ≤ 200 | null;
    - `answers_en[]` — допустимые ответы: `text_en` + формы из словаря курса, ≤ 8;
    - `error` `{correction ≤ 200, evidence ≤ 120 | null, error_code, severity, evaluation_id, turn_id}` | null;
    - `sources[]` — откуда слово, ≤ 20: `{kind: lesson | media | reading | scenario | evaluation | manual, key, version, at}`;
    - `status`: `new | learning | review | known | frozen | archived`;
    - FSRS: `stability`, `difficulty`, `reps`, `lapses`, `last_review_at`, `due_at`;
    - `created_at`, `updated_at`.
  - Уникальность: (`user_id`, `pair_id`, `kind`, `key`). Новый источник того же слова дописывает `sources` и `example_en`, если его не было, и не создаёт дубль.
  - Не больше 2000 карточек на ученика → 422 `CARDS_LIMIT`.
  - Статусы:
    - `known` — «Знаю это» ученика, в повторение не попадает, можно вернуть;
    - `frozen` — заморожена сотрудником;
    - `archived` — карточка ошибки через 90 дней или удалена учеником; в выдаче её нет.
- **`review_log`** — история планирования, неизменяема (триггер).
  - Поля: `log_id`, `card_id`, `user_id`, `session_id | null`, `task_type`, `answer_mode` (`choice | typed | assemble | listen | manual`), `grade` (`again | hard | good | null`; null — ручная правка или «Знаю это»), `hinted`, `revealed`, `elapsed_days`, `before` и `after` (`{state, stability, difficulty, due_at, status}`), `algorithm` (`fsrs-5`), `params_version` (`fsrs5-default-1`), `actor` (`learner | system | staff:<id>`), `reason` ≤ 300 (ручная правка), `created_at`.
- **`review_sessions`** — «Повторение дня».
  - Поля: `session_id`, `user_id`, `pair_id`, `status` (`active | completed | expired | cancelled`), `local_date`, `started_at`, `last_activity_at`, `finished_at`, `active_seconds`, `plan` (очередь `task_id` по порядку), `stats`.
  - Не больше одной `active` на ученика (частичный индекс).
- **`review_tasks`** — задания сессии.
  - Поля: `task_id`, `session_id`, `card_id | null`, `check_id | null`, `type`, `payload` — что показано ученику, без ключа; `key` — у сервиса, ученику не отдаётся; `answer`, `result` (`correct | almost | incorrect | null`), `grade`, `hinted`, `created_at`, `answered_at`.
  - Повтор ответа на то же задание возвращает тот же результат. Ответ не на текущее задание → 409 `TASK_NOT_CURRENT`.
- **`retention_checks`** — проверки удержания.
  - Поля:
    - `check_id`, `user_id`, `pair_id`, `skill_id`;
    - `stage`: `d7 | d30`;
    - `demonstrated_at`, `evidence_id` — оценка, давшая «демонстрирует»;
    - `due_at`;
    - `status`: `scheduled | in_session | passed | failed | cancelled`;
    - `attempt`, `consecutive_failures`, `items` (`[{lesson_id, version, item_id}]` — выбраны при постановке в сессию), `result` (`{correct, total}`), `checked_at`.
  - Одна незавершённая проверка на (ученик, навык).
- **`pronunciation_attempts`** — без аудио.
  - Поля: `attempt_id`, `user_id`, `target` (`{kind: card | sentence, ref}`), `reference_text`, `status` (`ok | insufficient_evidence | unavailable`), `scores` (`{accuracy, fluency, completeness, pron}` 0..100 | null), `words` (`[{word, accuracy, error_type}]` ≤ 40), `confidence`, `tips` ≤ 2, `audio_ms`, `created_at`.
  - Хранятся 180 дней (tick).
- **`learner_projection`** — из `learning.plan.updated.v1`, только от learning-plan: `user_id`, `timezone`, `course_pair`, `reminders_enabled`, `updated_at`.
- **`skill_projection`** — из `skills.state.changed.v1`, только от diagnostics: (`user_id`, `pair_id`, `skill_id`) → `state`, `changed_at`. Нужна для проверок и аналитики.
- **`reminders_sent`** (`user_id`, `local_date`) — не больше одного напоминания в день.
- **`activity_days`** (`user_id`, `local_date`) — дни с повторением или уроком. Используется в правиле «нет активности 14 дней»; заполняется из `memory.review.completed` (свои) и `lesson.session.completed.v1`.

### 1.2 Откуда берутся карточки
- **Урок.** Consumer `assessment.completed.v1` (только от assessment), kind `lesson`:
  - memory запрашивает у assessment `GET /internal/v1/evaluations/{id}/memory-feed` (§5);
  - по `content_refs.lesson` (ключ и версия) берёт урок из catalog (`/internal/v1/versions/lesson/{key}/{version}`);
  - каждое `key_words[]` → карточка `word` (одно слово) или `phrase` (несколько слов): `gloss` из ключевого слова, `example_en`, `answers_en` — `en` + формы статьи словаря курса (§2.2);
  - новые карточки — `status new`, `due_at` = сейчас;
  - идемпотентность — по `evaluation_id`.
- **Медиа.** kind `media`: фразы медиа (`phrases[]`) → карточки `phrase`, только если у версии медиа `rights.allowed_uses ∋ dictionary`.
- **Сценарий.** kind `scenario`: только ошибки.
- **Ошибки (журнал ошибок).** Из `memory-feed.errors` — подтверждённые ошибки текста ученика: `turn_id` реплики или открытого ответа, не закрытые задания (закрытые задания повторяет очередь lessons) → карточка `error`:
  - `text_en` = `correction`, `key` = нормализованный `correction`, `error` — код, серьёзность, цитата `evidence`;
  - детям карточек ошибок не бывает: у них нет свободного текста.
- **Переоценка.** `assessment.reevaluated.v1`:
  - memory берёт `memory-feed` новой записи;
  - ошибки, которых в ней нет, архивирует (`archived`, запись в `review_log` с `actor: system`, `reason: reevaluated`);
  - новые — добавляет.
- **Вручную** (`POST /internal/v1/cards`, ученик):
  - `{source: {kind: lesson | media | reading | scenario, key, version, text_en}}`;
  - memory проверяет через catalog (`glossary/lookup`, §2.3), что `text_en` есть в этой опубликованной версии, и берёт перевод из словаря курса;
  - нет статьи — перевод ИИ из того же поиска (§1.7); нет и его — 422 `GLOSS_UNAVAILABLE`.
- **Запрет.** Свой текст ученика в карточки не попадает: только слова и фразы опубликованного контента и исправления оценщика.

### 1.3 «Повторение дня»
**Старт.** `POST /internal/v1/review-sessions`, Idempotency-Key. Если есть `active` — возвращается она.

Состав очереди:
1. Проверки удержания со сроком: до 2, по 3 задания (§1.5).
2. Карточки к сроку (`learning | review`, `due_at` ≤ конец местного дня), по возрастанию извлекаемости R (§1.4): взрослым и подросткам до 20, детям до 10.
3. Новые карточки (`new`, по `created_at`): взрослым и подросткам до 5 в день, детям до 3, с учётом уже начатых сегодня.

Пустая очередь → 409 `NOTHING_TO_REVIEW {next_due_at}`.

**Задание по стадии карточки.** Вариант — детерминированный, seed = `session_id` + `card_id`:
- `new` → `intro`: слово, перевод, пример, озвучка, кнопки «Понятно» и «Знаю это». Без оценки. Сразу за ним — `meaning_choice` по этой карточке.
- `learning`, или `review` со стабильностью < 3 дней → **узнавание**:
  - `meaning_choice` — английское слово или фраза, 4 перевода;
  - `listen_choice` — озвучка, 4 английских варианта.
  - Отвлекающие варианты — из карточек ученика и ключевых слов того же урока, без дублей перевода.
- `review` со стабильностью ≥ 3 дней → **воспроизведение**:
  - `typed` — перевод и пример с пропуском → ввести английский; взрослые, подростки, дети 10–13;
  - `cloze` — пример с пропуском слова → ввести; если есть `example_en` и слово в нём встречается;
  - `assemble` — собрать из букв (слово ≤ 12 букв) или из слов (фраза); дети 6–9 вместо ввода.
- Карточка `error` → `error_fix`: показаны объяснение по `error_code` (RU/UZ — справочник memory) и цитата `evidence` → ввести исправленную фразу. Если цитата стёрта — `typed` по `correction` с объяснением.
- Проверка удержания → `check_item`: контрольное задание урока (`single_choice | gap_fill | order_words | translate_choice`), без подсказок. Верный ответ не показывается до конца блока проверки.

**Ответ.** `POST …/tasks/{task_id}` `{choice? | text? ≤ 200 | order?}`:
- проверка по ключу (§1.6) → `result` → оценка → FSRS (§1.4) → `review_log`;
- ученику — `{result, correct_answer (кроме check_item), next_due_in_days, explanation?}`.

**Оценка** (правила, не ИИ; скилл `spaced_repetition_coach`):

| Ответ | Оценка |
|---|---|
| неверно, «Не помню» (раскрытие) или пропуск | `again` |
| верно выбором (`meaning_choice`, `listen_choice`) | не выше `hard` — выбор не равен воспроизведению |
| верно вводом или сборкой с подсказкой «первая буква», или почти верно (опечатка) | `hard` |
| верно вводом или сборкой без подсказки | `good` |

`easy` автоматически не ставится никогда. «Знаю это» — `status known` и строка `review_log` с `grade null`, это не оценка FSRS.

**Повтор в сессии.** Карточка с `again` возвращается в конец очереди этой сессии один раз. Повторная оценка в тот же день считается по краткосрочной формуле (§1.4).

**Подсказки:**
- `first_letter` — для `typed`, `cloze`, `error_fix`;
- `reveal` — «Не помню» → `again`, показан ответ;
- у `check_item` подсказок нет → 409 `HINTS_NOT_ALLOWED`.

**Завершение.**
- `POST …/finish` после последнего задания (иначе 409 `TASK_NOT_CURRENT`), идемпотентно → `ReviewSummary` (bff.ts) → `completed`, событие `memory.review.completed.v1`.
- Бездействие > 10 мин не идёт в `active_seconds`, как в lessons.
- Бездействие > 2 ч или конец местного дня → `expired` (tick). Ответы уже учтены; если был хотя бы один ответ, публикуется `memory.review.completed.v1` со `status: expired`.
- `POST …/cancel` → `cancelled`, ответы остаются.
- `minutes` = ceil(active_seconds / 60), не больше 60.

### 1.4 FSRS-5 (параметры по умолчанию, версия `fsrs5-default-1`)
Реализация — в memory (`domain/fsrs.py`), без внешних зависимостей. Тесты — эталонные значения из таблицы ниже, считаются той же формулой независимо в тесте.

**Константы:**
- `w` = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
- G: again = 1, hard = 2, good = 3, easy = 4;
- `DECAY` = −0.5, `FACTOR` = 19/81;
- целевая удерживаемость r = 0,9;
- интервал от 1 до 365 дней.

**Формулы:**
- **Извлекаемость:** R(t, S) = (1 + FACTOR · t / S)^DECAY, t — дни с `last_review_at`, дробные.
- **Интервал:** I = round(S / FACTOR · (r^(1/DECAY) − 1)), ограничен 1..365. При r = 0,9 I ≈ S. `due_at` = момент ответа + I дней.
- **Первая оценка** (`new`):
  - S₀ = w[G−1];
  - D₀(G) = w4 − e^(w5·(G−1)) + 1, ограничено 1..10;
  - `reps` = 1, `status` = `learning`.
- **Следующие оценки, t ≥ 1 день:**
  - ΔD = −w6 · (G − 3); D′ = D + ΔD · (10 − D) / 9; D″ = w7 · D₀(4) + (1 − w7) · D′; ограничено 1..10;
  - успех (G ≥ 2): S′ = S · (e^w8 · (11 − D) · S^(−w9) · (e^(w10·(1−R)) − 1) · (G = 2 ? w15 : 1) · (G = 4 ? w16 : 1) + 1);
  - провал (G = 1): S′ = min(S, w11 · D^(−w12) · ((S + 1)^w13 − 1) · e^(w14·(1−R))); `lapses` + 1.
- **Повтор в тот же день** (t < 1 день): S′ = S · e^(w17 · (G − 3 + w18)); D — как выше.
- **Статус карточки:** `learning` → `review` после первой оценки ≥ `hard` при S ≥ 1 день; провал в `review` → `learning`. Срок считается всегда по формуле.
- **Эталоны для теста:**
  - S₀(again) = 0.40255, S₀(good) = 3.173;
  - D₀(good) = 7.1949 − e^1.069 + 1 ≈ 5.2824;
  - после `good` через 3 дня (R(3; 3.173) ≈ 0,9047) S′ ≈ 10,8 (точное значение тест вычисляет формулой).
- **Ручная правка** (§1.11) пишет в `review_log` `before` и `after`. FSRS не пересчитывает: перенос меняет только `due_at`, сброс возвращает `new`.

### 1.5 Проверки удержания (APP-MEM-05)
- **Постановка.** Consumer `skills.state.changed.v1` (только от diagnostics):
  - переход `→ demonstrated` → проверка `d7`, `due_at` = `occurred_at` + 7 дней (`demonstrated_at`, `evidence_id` из события);
  - переход из `demonstrated` в любое другое состояние → незавершённые проверки навыка `cancelled`;
  - повторное `demonstrated` — новая цепочка.
- **Задания** — `GET /internal/v1/skills/{skill_id}/check-items?audience=` у catalog (§2.4):
  - 3 задания при постановке в сессию: сначала из уроков, которые ученик не видел в последних двух проверках этого навыка (по `items`);
  - меньше 2 доступных → проверка `cancelled` (`reason: no_items`), состояние навыка не меняется.
- **Результат** — после последнего `check_item` блока: верно ≥ 2 из 3 → `passed`, иначе `failed`.
  - `d7 passed` → `d30` с `due_at` = `demonstrated_at` + 30 дней (не раньше чем через 7 дней после d7);
  - `d30 passed` → событие с `passed = true, stage = d30` → diagnostics ставит `retained`; цепочка закончена;
  - `failed` → `consecutive_failures` + 1. 1 → повтор той же стадии через 3 дня; 2 → событие с `consecutive_failures = 2` → diagnostics `demonstrated → learning`; цепочка закончена.
  - Каждый результат → `memory.retention.checked.v1`.
- **Нет активности.** Срок наступил, а у ученика нет дней активности за последние 14 (`activity_days`) — проверка не проваливается, `due_at` переносится на +1 день (tick). Первое повторение после возвращения берёт её.
- **Без игровых механик.** XP и игровые события проверки не дают (APP-MEM-05).

### 1.6 Сравнение ответа
**Нормализация:**
- NFC, нижний регистр, обрезка, схлопывание пробелов;
- апострофы ’ ‘ ` → ';
- убираются концевые . ! ? … и кавычки по краям.

**Эквиваленты сокращений** — словарь memory, сравниваются обе формы:
- i'm = i am; you're = you are; he's = he is; she's = she is; it's = it is; we're = we are; they're = they are;
- don't = do not; doesn't = does not; didn't = did not; can't = cannot = can not; won't = will not; isn't = is not; aren't = are not;
- i've = i have; i'll = i will; let's = let us; what's = what is; that's = that is; there's = there is.

**Результат:**
- **Верно** — совпадение с одним из `answers_en` (у `error_fix` — с `correction`).
- **Почти** (`almost`) — одно слово длиной ≥ 5 букв отличается на одну правку (Левенштейн 1), остальные совпадают → оценка `hard`, ученику «Почти — проверьте написание» и верный ответ.
- **Сборка** — точный порядок.
- **`check_item`** — правила assessment: индекс; `gap_fill` без регистра и концевой пунктуации; точный порядок.

### 1.7 Перевод по тапу
`POST /internal/v1/translate` `{content_ref: {kind: lesson | media_asset | reading | scenario, key, version, locator?}, text ≤ 60}`.

Порядок:
1. catalog `POST /internal/v1/glossary/lookup` (§2.3) проверяет, что `text` встречается в этой опубликованной версии, и ищет статью словаря курса. Не встречается → 422 `WORD_NOT_IN_CONTENT`. Версия не найдена или не опубликованная → 404 `CONTENT_NOT_FOUND`.
2. **Есть статья** (`course`, `methodist`, или `ai` не отклонённая, с `confidence` ≥ 0,5) → `WordGloss` (bff.ts) с источником.
3. **Нет статьи, статья отклонена или ИИ выключен:**
   - если отклонена — `{gloss: null, reason: "not_available"}`;
   - иначе ai-gateway `teaching_coach`, `request: gloss_word` (ai.ts):
     - `session_kind: memory`, `session_id` = uuid5(`memory-gloss`, `user_id:local_date`);
     - `deadline_ms` 8000; `audience` ученика — детям тоже: текста ученика во входе нет, слово из контента;
     - `ok` → catalog `POST /internal/v1/glossary/ai-entries` (upsert по форме: если статья уже появилась, возвращается она) → `WordGloss` с `source: ai`;
     - `unavailable` / `refused` → `{gloss: null, reason: "not_available"}`.
4. `in_dictionary` — `card_id` карточки ученика с этим ключом или null.

Повторный запрос того же слова в течение 30 дней — из кеша memory (Redis `gloss:v1:<pair>:<key>`, TTL 1 ч). Правка методиста сбрасывает кеш событием catalog (§2.6).

Свободный текст ученика сюда не попадает: проверка «слово есть в контенте» обязательна.

### 1.8 Напоминание о повторении
`POST /internal/v1/memory:tick` (n8n `memory-tick`, каждые 15 минут, `SCHEDULER_TOKEN`; одна реплика — advisory lock). Шаги:
1. **Сессии.** `expired` по правилам §1.3.
2. **Напоминания.** Для учеников из `learner_projection` с `reminders_enabled`, у которых местное время 19:00–19:14, к концу дня ≥ 5 карточек к сроку, повторения сегодня не было и напоминания ещё не было → событие `memory.reviews.due.v1 {user_id, local_date, due_count, timezone}` и строка `reminders_sent`. Не больше 500 событий за тик, остаток — следующим тиком в том же окне.
3. **Проверки.** Перенос проверок без активности (§1.5).
4. **Сроки хранения.**
   - Карточки ошибок старше 90 дней → `archived` и цитата `evidence` стирается;
   - попытки произношения старше 180 дней → удаляются;
   - `review_tasks.answer` завершённых сессий старше 90 дней → стирается.

Ответ — счётчики шагов.

### 1.9 Произношение
`POST /internal/v1/pronunciation?target_kind=card|sentence&target=<card_id | kind:key:version:locator>` (telegram-bff).

Тело и ограничения:
- тело — `audio/wav` (PCM 16 бит, моно, 16 000 Гц), от 0,5 до 15 с, ≤ 600 000 байт;
- проверка заголовка RIFF → иначе 422 `AUDIO_INVALID {reason: format | too_short | too_long | too_large}`.

Шаги:
1. **Эталонный текст — только сервер:**
   - карточка → `text_en` (у `error` — `correction`);
   - предложение → текст из опубликованной версии catalog: `reading` — `sentence_id`, `media_asset` — индекс реплики транскрипта, `lesson` — индекс примера;
   - длина 1..200 символов;
   - чужая карточка → 404.
2. **Согласие.** identity-consent `GET /internal/v1/users/{lrn}/public` → `purposes ∋ voice_recording`. Иначе 403 `VOICE_CONSENT_REQUIRED {who: self | guardian}`: детский профиль и подросток без согласия родителя — `guardian`.
3. **Функция включена.** ai-gateway `/internal/v1/status` → `speech_available`. Иначе 503 `SPEECH_UNAVAILABLE`.
4. **Оценка.** ai-gateway `POST /internal/v1/speech/pronunciation`:
   - тело — то же аудио; заголовок `X-Speech-Meta` = base64url(JSON `{request_id, user_id, audience, locale, reference_text, language: "en-US"}`);
   - ответ — `PronunciationResult` (ai.ts), таймаут 15 с.
5. **Сохранение** `pronunciation_attempts` (без аудио) → ответ ученику.

Аудио живёт только в памяти процессов telegram-bff → memory → ai-gateway на время запроса: не пишется на диск, в Redis, логи и события. В логах — длительность и статус.

Лимит — `tg.memory.pronunciation`: 20 за 10 минут на ученика. Плюс бюджет ai-gateway (§3).

### 1.10 Для ученика (через telegram-bff; формы — bff.ts «Спринт 5»)
- `GET /internal/v1/overview` → `MemoryOverview`.
- `GET /internal/v1/cards?kind=&status=&q=&cursor=` → `DictionaryPage`. Поиск — по `text_en` и переводу.
- `GET /internal/v1/cards/{id}` → `DictionaryCardDetail`: история последних 10 оценок, последняя попытка произношения.
- `POST /internal/v1/cards`, Idempotency-Key → 201 карточка; если такая уже есть — 200 она же.
- `POST /internal/v1/cards/{id}/known` / `DELETE …/known`.
- `DELETE /internal/v1/cards/{id}` → `archived`. Удалять можно любые карточки ученика.
- Сессии повторения:
  - `POST /internal/v1/review-sessions`, `GET …/active`, `GET …/{id}`;
  - `GET …/{id}/current` → `ReviewTask`;
  - `POST …/{id}/tasks/{task_id}` → `ReviewTaskResult`;
  - `POST …/tasks/{task_id}/hint {kind: first_letter | reveal}`;
  - `POST …/{id}/finish | cancel`.
- `POST /internal/v1/cards/lookup {texts: string[] ≤ 50}` → `{items: [{text, card_id | null}]}` — есть ли слова в словаре ученика (нормализация §1.6, любые виды карточек кроме `archived`); нужен BFF для `ReadingView.glossary[].in_dictionary`.
- `GET /internal/v1/errors?cursor=` → журнал ошибок: карточки `error` и их сила, без `evidence` в списке; цитата — в карточке, пока не стёрта.
- `POST /internal/v1/translate`, `POST /internal/v1/pronunciation`.

Чужие карточки и сессии → 404.

### 1.11 Для админки (`/admin/v1/memory/*`, actor; формы — admin.ts)
- **`GET /admin/v1/memory/learners/{user_id}`** (`memory.read`) → сводка:
  - карточки по статусам, к сроку, просрочено;
  - проверки удержания: последние 20 со статусами;
  - повторения за 30 дней.
- **`GET /admin/v1/memory/learners/{user_id}/cards?status=&kind=&cursor=`** (`memory.read`) — без `evidence`.
- **`GET /admin/v1/memory/cards/{card_id}`** (`memory.read`) → карточка + `review_log` (вся история планирования: было и стало, алгоритм и версия, кто).
- **`POST /admin/v1/memory/cards/{card_id}/actions`** (`memory.manage`, step-up в admin-bff) `{action, reason ≥ 10}`:
  - действия: `reschedule {due_at: +1..365 дней}` | `reset` | `freeze` | `unfreeze`;
  - → строка `review_log` (`actor: staff:<id>`) и аудит `memory.card_adjusted {card_id, user_id, action, before, after}`;
  - массовых действий нет.
- **`GET /admin/v1/memory/analytics?pair_id=&period=30d|90d`** (`memory.read` | `dashboard.read`) → `ForgettingAnalytics`:
  - по навыку и уроку: проверки d7/d30 — назначено, пройдено, провалено, доля;
  - повторные ошибки по `error_code`: учеников с ≥ 2 провалами карточки этой ошибки, всего карточек;
  - 20 самых забываемых слов: доля `again` при ≥ 20 ответах;
  - группы меньше 5 учеников скрыты (`hidden: true`); `user_id` в ответе нет.
- **`GET /admin/v1/memory/stats?period=7d`** (`dashboard.read`) — блок обзора: повторений, учеников, доля d30 пройдено, среднее карточек к сроку.

Аудит — через outbox `admin.audit.recorded.v1`, как в assessment.

### 1.12 События
**Публикует** (outbox, схемы — `packages/contracts/events`):
- `memory.review.completed.v1 {session_id, user_id, pair_id, status: completed | expired, minutes, reviewed, correct, finished_at}` — потребитель learning-plan;
- `memory.reviews.due.v1 {user_id, local_date, due_count, timezone}` — потребитель notifications;
- `memory.retention.checked.v1 {check_id, user_id, pair_id, skill_id, stage: d7 | d30, passed, consecutive_failures, evidence_id, checked_at}` — потребитель diagnostics.

**Потребляет** (inbox, проверка издателя):
- `assessment.completed.v1`, `assessment.reevaluated.v1` — assessment;
- `skills.state.changed.v1` — diagnostics;
- `learning.plan.updated.v1` — learning-plan;
- `lesson.session.completed.v1` — lessons (дни активности);
- `user.deletion.requested.v1` — identity-consent.

**Сага удаления:** удалить карточки, историю, сессии, задания, проверки, попытки произношения, проекции ученика → ACK `user.domain.deleted.v1 {domain: "memory"}`.

## 2. catalog (дополнение)

### 2.1 Тексты для чтения (kind `reading`)
- `ReadingPayload` (content.ts) — новый вид контента с тем же жизненным циклом: черновик → проверка вторым методистом → публикация → архив, версии неизменяемы. Общий админ API `/admin/v1/content/reading/*`.
- **Проверки:**
  - 60–250 слов; предложения ≤ 30 слов;
  - глоссарий 3..20 статей, каждая встречается в тексте;
  - вопросы 3..8, ответ — индекс или допустимые ответы;
  - у каждого предложения перевод RU/UZ;
  - детский текст — только аудитория kids.
- **Для ученика:**
  - `GET /internal/v1/readings?pair_id=&audience=&level=` — карточки: заголовок, уровень, минуты, темы;
  - `GET /internal/v1/readings/{reading_id}?audience=` — опубликованная версия без `answer` вопросов.
  - Вызывающие: telegram-bff, lessons.
- **Ключи.** `GET /internal/v1/versions/reading/{key}/{version}` — как у остальных видов; вызывающие lessons, assessment, memory.

### 2.2 Словарь курса (`glossary_entries`)
- **Поля:**
  - `entry_id`, `pair_id`, `lemma` ≤ 60, `forms[]` ≤ 8 (нормализованные, §1.6, уникальны в паре среди действующих статей), `part_of_speech` | null, `gloss` Localized (≤ 80 каждый), `example_en` | null;
  - `source`: `course | methodist | ai`;
  - `review_status`: `not_required | pending | approved | rejected` (у ai);
  - `confidence` (ai), `agent_version` (ai);
  - `refs[]` — `{kind, key, version}`, где встречается; ≤ 50;
  - `override` — правка методиста поверх `course`: `{gloss, example_en, by, at}`;
  - `archived_at`, `updated_by`, `updated_at`.
- **`glossary_history`** — неизменяемая история правок: было, стало, кто, когда, причина.
- **Статьи `course`** строятся при публикации версии урока (`key_words`), медиа (`phrases`, если `allowed_uses ∋ dictionary`) и текста (`glossary`):
  - новая форма → новая статья;
  - есть статья `course` с той же формой — дописывается `refs`, перевод не меняется: первая публикация главнее, расхождение видно методисту в карточке статьи;
  - есть статья `ai` — заменяется: `course` главнее, статья `ai` архивируется.
  - Миграция строит статьи по всем опубликованным версиям.
- **Приоритет поиска:** `course` (с `override`) → `methodist` → `ai` `approved` → `ai` `pending`. `rejected` и архивные не выдаются.

### 2.3 Внутренние API словаря (вызывающий memory)
- **`POST /internal/v1/glossary/lookup`** `{pair_id, text ≤ 60, content_ref: {kind, key, version, locator?}}`:
  - версия опубликована или бывшая опубликованной; черновик → 404 `CONTENT_NOT_FOUND`;
  - текст — в предложении `locator` или где угодно в версии: токены по границам слов, сравнение нормализованных форм. Нет → 422 `WORD_NOT_IN_CONTENT`;
  - `text` ≤ 120 (перевод по тапу присылает ≤ 60, добавление в словарь — фразу медиа до 120);
  - ответ `{in_content: true, sentence_en: предложение или реплика ≤ 300, locator, note: Localized | null (пояснение из глоссария текста), entry: GlossaryEntry | null, rejected: bool}`.
- **`POST /internal/v1/glossary/ai-entries`** `{pair_id, surface, lemma, part_of_speech, gloss, forms, confidence, agent_version, content_ref}`:
  - создаёт статью `source: ai, review_status: pending`;
  - любая из форм уже занята действующей статьей → возвращается она (200, без изменений);
  - иначе 201;
  - `refs` — `content_ref`; персональных данных нет.
- **`GET /internal/v1/glossary/forms?pair_id=&forms=a&forms=b`** (≤ 50; повторяемый параметр — формы бывают с запятой) → `{items: [{form, entry}]}`. Нужно для `answers_en` карточек.
- **ai-entries** дополнительно проверяет, что слово есть в версии контента; если форма занята статьёй ИИ на проверке — дописывает место в контенте (`refs`).
- **check-items** отдаёт контрольные задания уроков навыка, сначала задания самого навыка (у урока навыку принадлежат не все 5 заданий).

### 2.4 Задания проверок удержания
`GET /internal/v1/skills/{skill_id}/check-items?audience=&pair_id=` (вызывающий memory):
- возвращает `{skill_id, title Localized, items: [{lesson_id, version, item: ControlItem — с ключом}]}`;
- источник — контрольные задания опубликованных уроков курса пары, у которых `primary_skill_id` = навык и аудитория подходит;
- не больше 20, порядок стабильный.

### 2.5 Админ API словаря (`/admin/v1/glossary*`, actor; формы — admin.ts)
- **Список:** `GET ?pair_id=&q=&source=&review_status=&cursor=` (`content.read`). Очередь ИИ — `review_status=pending`, сортировка по числу `refs`.
- **Карточка:** `GET /{entry_id}` с историей (`content.read`).
- **Создание:** `POST` (`glossary.manage`) — статья `methodist`. Занятая форма → 409 `FORM_TAKEN {entry_id}`.
- **Правка:** `PATCH /{entry_id}` (`glossary.manage`, If-Match `updated_at` → иначе 428 / 409 `VERSION_CONFLICT`).
  - `methodist` и `ai` — правка полей;
  - `course` — только `override` (перевод и пример), снятие `override: null`.
- **Решение по ИИ:** `POST /{entry_id}/review {decision: approve | correct | reject, gloss?, note?}` (`glossary.manage`):
  - `correct` — с новым переводом;
  - не `ai` или уже решённая → 409 `NOT_PENDING`.
- **Архив:** `DELETE /{entry_id}` (`glossary.manage`) — только `methodist`.
- **Аудит:** `glossary.entry_created | updated | reviewed | archived`.

### 2.6 События catalog
`catalog.glossary.changed.v1 {pair_id, entry_id, forms, change: created | updated | reviewed | archived, occurred_at}` — memory сбрасывает кеш перевода. Карточки учеников переводы не меняют: перевод в карточке — снимок на момент добавления.

`catalog.version.published.v1` — `kind` дополняется `reading`.

## 3. ai-gateway (дополнение)

### 3.1 `teaching_coach` v2 — `gloss_word`
- Миграция: новая версия `teaching_coach` (draft → публикация после прогона золотых тестов) с объединённой схемой вывода. Запрос `simpler_example` / `explain_again` — как в v1.
- **Вход** `TeachingCoachGlossContext`: `{request: "gloss_word", word ≤ 60, sentence_en ≤ 300, level, content_kind}`.
- **Выход** `TeachingCoachGlossOutput`: `{lemma ≤ 60, part_of_speech: noun | verb | adjective | adverb | pronoun | preposition | conjunction | interjection | determiner | phrase | other, gloss: {ru ≤ 80, uz ≤ 80}, forms ≤ 6, confidence 0..1}`.
- **Правила безопасности:** перевод — значение в этом предложении, без ссылок, без английского в `gloss`, `uz` — латиница.
- `free_text` агента — false. Детям разрешено.
- **Золотые кейсы** — ≥ 6 новых, обязательные:
  - многозначное слово по контексту;
  - фразовый глагол;
  - форма → лемма;
  - инъекция в `sentence_en` («ignore previous…») → корректный перевод слова, без исполнения;
  - ребёнок → `ok`;
  - имя собственное.
- `max_output_tokens` 200, лимит $0,005 на вызов, `timeout_ms` 6000, модель `claude-haiku-5-5`.
- `fake`-провайдер: `gloss = {ru: "[ru] <word>", uz: "[uz] <word>"}`, `lemma = word`, `confidence 0.9`.

### 3.2 Оценка произношения (`pronunciation_coach`, implementation `code`, active)
**`POST /internal/v1/speech/pronunciation`** (вызывающий memory):
- тело — WAV, как в §1.9; `X-Speech-Meta`;
- повтор `request_id` за 24 ч → сохранённый результат без аудио;
- ответ `PronunciationResult` (ai.ts).

Порядок:
1. **Доступность:**
   - аварийная остановка → `unavailable: ai_disabled`;
   - нет `AZURE_SPEECH_KEY` или `AZURE_SPEECH_REGION` → `unavailable: not_configured`;
   - бюджет: месяц, ученик за день, стоимость по длительности аудио → `unavailable: budget_exceeded`.
2. **Azure Speech REST для короткого аудио:**
   - `POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`;
   - заголовки: `Ocp-Apim-Subscription-Key`, `Content-Type: audio/wav; codecs=audio/pcm; samplerate=16000`, `Pronunciation-Assessment` = base64(JSON `{ReferenceText, GradingSystem: "HundredMark", Granularity: "Word", Dimension: "Comprehensive", EnableMiscue: true}`);
   - таймаут 12 с; один повтор при 5xx или сетевой ошибке, если до дедлайна ≥ 4 с.
3. **Разбор ответа.** `RecognitionStatus` ≠ `Success`, `NBest[0].Confidence` < 0,4, или `CompletenessScore` < 30 → `status: insufficient_evidence`, баллов нет. Иначе:
   - `scores` = `{accuracy, fluency, completeness, pron}` из `PronunciationAssessment`;
   - `words` = `[{word, accuracy, error_type: none | omission | insertion | mispronunciation}]`.
4. **Советы** (правила скилла `pronunciation_coach`, код) — не больше 2:
   - слова с `error_type` `mispronunciation` и `accuracy` < 60 — сначала самые низкие — шаблон «Слово «{word}» прозвучало неразборчиво. Послушайте образец и повторите медленно»;
   - `omission` — «Слово «{word}» не прозвучало — произнесите фразу целиком»;
   - RU/UZ по `locale`; детям — мягкий вариант на «ты»;
   - ни слова об «акценте»; `intelligibility` = `clear` (pron ≥ 80) | `mostly_clear` (60..79) | `needs_practice` (< 60).
5. **Учёт.** `usage`: `agent_id: pronunciation_coach`, `model_id: azure-speech-pa`, `provider: azure_speech`, `audio_ms`, `cost_usd` = audio_ms / 3 600 000 × `audio_usd_per_hour`, `session_kind: memory`.

Аудио не пишется ни в БД, ни в логи. Ключ Azure — только env ai-gateway: не в БД, логах и ответах. `GET provider` показывает лишь «задан / не задан».

- **`fake` речь** (`SPEECH_PROVIDER=fake`, стенд и тесты):
  - WAV со средней амплитудой < 200 → `insufficient_evidence`;
  - иначе слова эталона, `accuracy` 90; слова длиной ≥ 8 букв — 55 и `mispronunciation`;
  - стоимость 0.
- **Модели:** `models` + `provider: azure_speech | fake_speech`, поле `audio_usd_per_hour`. Сид `azure-speech-pa` 1.32, `fake-speech` 0. Правка цены — как у моделей (`ai.publish`; снижение — `costs.manage`).
- **Статус.** `GET /internal/v1/status` → `{ai_available, speech_available}`: `speech_available` — нет аварийной остановки, ключ и регион заданы, месячный потолок не превышен.
- **Админка:** `AiProviderStatus.speech` `{provider, key_configured, region, last_error}`; затраты — агент `pronunciation_coach` в сводке.

### 3.3 Реестр агентов
- `spaced_repetition_coach` → `active`, `code`, `implemented_in: memory`.
- `pronunciation_coach` → `active`, `code`, `implemented_in: ai-gateway`.
- `evening_review_coach` — `planned`.
- `SessionKind` + `memory`, `reading`.

## 4. lessons (дополнение) — практика `reading`
- **Старт:** `POST /internal/v1/readings/{reading_id}/sessions`, Idempotency-Key. Текст опубликован, аудитория подходит, иначе 404 `READING_NOT_AVAILABLE`. Детям — только детские. Правило одной незавершённой сессии — как в спринте 4.
- **Шаги:**
  - `reading` — текст по предложениям с переводом предложения по кнопке, словами глоссария (подсвечены) и озвучкой; действие «Дальше»;
  - `question` × N — закрытые, без подсказок, верный ответ до итогов не показывается;
  - `done`.
- **Завершение:** `finish` → assessment `EvaluationRequest` с `kind: reading`, `practice_only: true` → итоги: доля верных, верный ответ для ошибок → событие `lesson.session.completed.v1` (`kind: reading`).
- **Минуты** — как у медиа.
- **Результаты для списка текстов:** `GET /internal/v1/reading-results?ids=` (≤ 50, telegram-bff) → `{items: [{reading_id, correct, total, finished_at}]}` — последняя завершённая сессия ученика по каждому тексту (`ReadingCard.last_result`).
- **Вопросы в шагах:** `true_false` показывается как `single_choice` с вариантами `["True", "False"]`.
- **Журнал сессий админки:** `SessionRow.reading_id`, фильтр `kind=reading`, версия текста в карточке — `reading:<id>`.

## 5. assessment (дополнение)
- **`kind: reading`** — только закрытые вопросы по ключам версии текста: критерий `comprehension`, `practice_only`, `skill_outcomes = []`.
- **`GET /internal/v1/evaluations/{id}/memory-feed`** (вызывающий memory) → `{evaluation_id, session_id, user_id, pair_id, kind, content_refs, practice_only, superseded_by: id | null, errors: [{turn_id, evidence | null, correction, error_code, severity}]}`:
  - только ошибки текста ученика: `turn_id` `T{n}` (реплика) или `OA1` (открытый ответ — как у оценщика спринта 4); закрытые задания не входят; у детей список пуст;
  - `evidence` — null, если сессии больше 90 дней (`MEMORY_EVIDENCE_RETENTION_DAYS`): оценка неизменяема, цитата просто не отдаётся;
  - `evaluation_id` в ответе — актуальная запись цепочки; `superseded_by` = её id, если запрошенную запись заменили (иначе null);
  - `content_refs`: `{lesson, scenario, media_asset, reading, rubric: {key, version} | null, media_exercises: [{key, version}]}`.
- **События** `assessment.completed.v1` / `lesson.session.*`: `kind` + `reading`.

## 6. diagnostics, learning-plan, notifications, identity-consent, audit
- **diagnostics.** Consumer `memory.retention.checked.v1`, только от memory:
  - `stage d30, passed` и навык `demonstrated` → `retained` (`source: retention`, `evidence_id: check_id`);
  - `consecutive_failures ≥ 2` и навык `demonstrated` → `learning` (`source: retention`);
  - иначе без изменений;
  - событие `skills.state.changed.v1`.
  - Карта навыков показывает `retained` («закреплён»).
- **learning-plan.** Consumer `memory.review.completed.v1`, только от memory:
  - активность `review`, `minutes`, `local_date` — по поясу плана из `finished_at`; идемпотентно по `session_id`;
  - засчитывается в день графика и серию как занятие; `minutes` 0 не засчитывается.
  - Тексты для чтения — `lesson.session.completed.v1` `kind: reading` → активность `practice`.
- **notifications.** Consumer `memory.reviews.due.v1`, только от memory → шаблон `reviews_due` (`.kid` — опекуну):
  - категория `reminders`, `dedup_key` `reviews_due:<user>:<date>`, `startapp: route_review`;
  - текст RU/UZ: «Пора повторить слова: {due_count}. Это займёт около {minutes} минут» (minutes = ceil(due_count × 0,4), 2..15);
  - тихие часы, категории и правила детей — как у `lesson.reminder`.
- **identity-consent:**
  - **согласие на голос для детского профиля.** `PUT /internal/v1/me/learners/{child_id}/voice-consent {granted: bool}` (telegram-bff; только аккаунт 18+ — опекун ребёнка, со своим действующим согласием):
    - новая запись согласия ребёнка `basis: guardian` с обязательными целями и `voice_recording` при `granted`;
    - событие `consent.accepted.v1`;
    - повтор того же значения — без новой записи;
    - чужой ребёнок → 404.
  - `/public` детского профиля: `purposes ∋ voice_recording`, если её дал опекун. Остальные необязательные цели детям по-прежнему недоступны.
  - Подростки — как раньше: `voice_recording` только после согласия родителя.
  - `LearnerSummary.voice_consent: boolean` (bff.ts).
  - memory допущен к `/public`; `DELETION_DOMAINS` + `memory`.
- **audit.** `AUDIT_EVENT_PRODUCERS` + `memory`; catalog уже есть.

## 7. admin-identity и admin-bff
- **admin-identity**, миграция 0005:
  - права `memory.read`, `memory.manage` (step-up), `glossary.manage`;
  - роли по PLAN.
- **admin-bff:**
  - маршруты admin.ts «Память, словарь курса, чтение» → memory (`MEMORY_URL`), catalog (словарь; тексты — общий маршрут контента), ai-gateway (цены и статус речи);
  - step-up — `memory.manage`;
  - обзор: блок `memory` (`/admin/v1/memory/stats`) и в блоке `ai` — расход речи за месяц.

## 8. telegram-bff
- **Маршруты** bff.ts «Спринт 5» → memory, lessons, catalog, identity-consent. Claims `lrn`, `age_band`; строгая проверка ответов.
- **Произношение.** `POST /v1/memory/pronunciation` — `bodyLimit` 600 000 только у этого маршрута, `Content-Type: audio/wav`. Проверка заголовка WAV до отправки дальше; тело не логируется.
- **Лимиты** (`rate-limit-policies.json`):
  - `tg.memory.translate` — 60 / 600 с;
  - `tg.memory.pronunciation` — 20 / 600 с;
  - `tg.memory.answer` — 300 / 600 с.
- **Таймауты:** memory 10 с; перевод 12 с; произношение 20 с.

## 9. infra
- **Railway.** Порт 8116, схема и роли `memory` в `bootstrap.sql`, издатель JWT.
  - memory без публичного домена: telegram-bff, admin-bff и n8n — вызывающие; memory → catalog, assessment, ai-gateway, identity-consent.
  - ai-gateway получает `AZURE_SPEECH_KEY=${{shared.AZURE_SPEECH_KEY}}`, `AZURE_SPEECH_REGION=${{shared.AZURE_SPEECH_REGION}}`, `SPEECH_PROVIDER=azure`. Общие переменные вводит владелец; пока их нет, функция скрыта.
- **n8n** — `memory-tick`, каждые 15 минут.
- **CI-матрицы.**
- **Стенд e2e** — `AI_PROVIDER=fake`, `SPEECH_PROVIDER=fake`, memory с `SCHEDULER_TOKEN`.
- **Схемы событий:** `memory.review.completed.v1`, `memory.reviews.due.v1`, `memory.retention.checked.v1`, `catalog.glossary.changed.v1`; `kind` + `reading` в `lesson.session.*`, `assessment.completed.v1`, `catalog.version.published.v1`.
- **Порядок деплоя** (enum событий расширен):
  1. потребители: learning-plan, diagnostics, notifications, memory;
  2. издатели: lessons, assessment, catalog;
  3. BFF и фронт.

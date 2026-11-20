# experience-config-service

**Владелец:** платформа (общий сервис Telegram- и Admin-контуров TilHero). **Bounded context:** Remote Experience
Config — неизменяемые версии темы, секций главной и флагов Mini App и админки с активацией и откатом без релиза
(как в «Бот турист»), и **«Что нового»** — заметки о новом в приложении с аудиториями, сегментами, текстами RU/UZ и
отметками просмотра (решение заказчика 18.11.2026: при первой регистрации и при каждом следующем входе ученик видит всё
новое, управление — в админке; AT-11).

Порт 8106, схема PostgreSQL `experience_config`, внутренний JWT с `aud = experience-config`. Redis — кэш текущей
конфигурации (60 с) и Idempotency-Key staff-команд.

## API: конфигурация интерфейса
| Метод | Путь | Кто | Право | Тело → ответ |
|---|---|---|---|---|
| GET | `/internal/v1/experience/{app}/current` | telegram-bff, admin-bff | — | → `ExperienceConfig` (кэш Redis 60 с, заголовок `x-cache: hit/miss`); 404 `EXPERIENCE_CONFIG_NOT_FOUND` |
| GET | `/admin/v1/experience/{app}/versions?limit=&cursor=` | admin-bff | `config.read` | → `{items: VersionSummary[], next_cursor}`; `status`: `current` / `previous` / null |
| GET | `/admin/v1/experience/{app}/versions/{version}` | admin-bff | `config.read` | → `VersionDetail` (с `payload`) |
| POST | `/admin/v1/experience/{app}/versions` | admin-bff | `config.edit` | `{version, payload, change_note}` → 201 `VersionDetail`; повтор с тем же содержимым — тот же ответ; та же версия с другим содержимым → 409 `EXPERIENCE_VERSION_EXISTS`; 422 `EXPERIENCE_CONFIG_INVALID {path, reason, errors[]}` |
| GET | `/admin/v1/experience/{app}/activations?limit=&cursor=` | admin-bff | `config.read` | → `{items: ActivationOut[], next_cursor}` (новые первыми) |
| GET | `/admin/v1/experience/{app}/state` | admin-bff | `config.read` | → `{app, current: ActivationOut \| null, previous_version}` |
| POST | `/admin/v1/experience/{app}/activate` | admin-bff | `config.publish` | `{version, reason}` → 201 `ActivationOut`; уже текущая → 200 (no-op); 404 `EXPERIENCE_VERSION_NOT_FOUND` |
| POST | `/admin/v1/experience/{app}/rollback` | admin-bff | `config.publish` | `{reason}` → 201 `ActivationOut`; 409 `EXPERIENCE_NO_PREVIOUS` |

`{app}` ∈ `miniapp | admin`, иначе 404 `EXPERIENCE_APP_UNKNOWN`. `reason`, `change_note` — 3…500 символов. Staff-команды
принимают необязательный `Idempotency-Key` (8…128 символов `[A-Za-z0-9_-:.]`, область — сотрудник + приложение + команда):
повтор возвращает сохранённый ответ с заголовком `idempotent-replay: true`, поэтому двойной клик «Откатить» не откатывает
дважды. **Откат** не меняет историю: создаётся новая активация `kind=rollback` версии `previous_version` текущей, а её
`previous_version` = бывшая текущая; повторный откат возвращает обратно (1.0.1 → 1.0.0 → 1.0.1). Активации приложения
сериализуются `pg_advisory_xact_lock`. Staff API вызывает только admin-bff (`iss = admin-bff`, контекст сотрудника `actor`).

### Payload версии
**miniapp** — `ExperienceConfig` из `packages/contracts/src/bff.ts` без `app/version` (их добавляет сервис в ответе):
```json
{"theme": {"id": "notebook", "version": "1.0.0", "tokens": {"--paper": "#FBFCFE", "--pen": "#2F4BE0", "...": "..."}},
 "home": {"sections": [{"type": "today_plan", "key": "today_plan", "variant": "large", "enabled": true}, "..."]},
 "flags": {"whats_new_on_login": true, "news": true, "family_invites": true, "uz_ui": true, "voice_lesson": false}}
```
Строгая валидация (pydantic, `extra=forbid`, `strict`): `theme.id` ∈ `notebook | notebook_dark` (светлая и тёмная
«Тетрадь»); секции — `HomeSectionType` bff.ts (`today_plan, lesson_of_day, review, whats_new, family, news`), каждый тип
не больше одного раза, уникальные `key` (`^[a-z][a-z0-9_]{1,31}$`), варианты `large | compact`, 1…6 секций; флаги — только
bool, имена `^[a-z][a-z0-9_]{0,63}$`, ≤ 50; payload ≤ 32 КБ. Любое поле вне схемы (`css_url`, `script`, `welcome_mode`,
`hotel_rating_min`…) → `unknown_field`. В ответе 422 — все найденные ошибки (`errors`, до 20), первая — в `path/reason`.

**admin** — `{theme: {id: admin_light, version, tokens}, layout: {density: compact|comfortable, menu: [{id, enabled}]},
flags}`; `menu` — порядок и видимость разделов меню прототипа админки (`overview users content agents qa costs heroes game
events news support config langs roles audit`; спринт 5 — `memory`; спринт 6 — `game_events`), без повторов; права всё
равно проверяет admin-bff. Контракт admin-bff — спринт 2. Спринт 6 (INTERNAL_API спринта 6 §8): раздел «Игра» —
`heroes` («Герои»), `game` («Геймификация»: правила, магазин, кошельки), `game_events` («События и сезоны»).
`game_events` — новый id раздела событий, `events` — его id из прототипа (сид 1.0.0, остаётся допустимым): это один
раздел, в одной версии — только один из них (`MENU_ALIASES`; оба → `duplicate`). admin-web понимает оба id. Тема Mini
App не меняется: косметика ученика накладывается поверх темы на клиенте.

### Токены темы — только белый список (никакого произвольного CSS/JS)
Mini App — ровно allowlist санитайзера клиента `packages/ui-tokens/token-names.json` (визуальный язык «Тетрадь»;
совпадение имён, типов и шрифтов — контрактный тест): цвета `--paper --grid --ink --ink2 --line --card --pen --pen-ink
--pen-soft --mark --margin --err --err-soft --ok --ok-soft --warn --warn-soft --scrim`; длины `--r-card` 0…32 px,
`--r-btn`, `--r-field` 0…24 px, `--r-sheet` 0…32 px (px или rem, 1rem = 16px), `--gutter` 8…32 px (только px); шрифты
`--font-display --font-body --font-hand` — одно семейство бренда `Onest` / `Unbounded` / `Caveat` (системные фолбэки
добавляет клиент). Admin — токены `.ad` прототипа (`--bg --card --ink --ink2 --line --pen --pen-soft --side --side2 --ok
--ok-soft --warn --warn-soft --err --err-soft`, радиусы, `--nav-w` 180…360 px, стеки шрифтов из бренда и системных
фолбэков, ≤ 8 семейств). Значение проверяется грамматикой целиком: цвет — `#RGB/#RGBA/#RRGGBB/#RRGGBBAA`, `rgb()`,
`rgba()`; `url(`, `expression(`, `javascript:`, `var(`, `@import`, `;`, `{`, `}`, `<`, `>`, `\`, комментарии и
управляющие символы → `forbidden_construct`; неизвестный токен → `unknown_token`.

## API: «Что нового»
### Ученик (вызывает telegram-bff; ученик — только `sub` внутреннего токена = активный ученик)
| Метод | Путь | Ответ |
|---|---|---|
| GET | `/internal/v1/release-notes/for-me?onboarded_at=<ISO>&lang=ru\|uz&age=kids\|teens\|adults` | `WhatsNew {mode: welcome\|updates\|none, notes: WhatsNewNote[]}` (bff.ts) |
| POST | `/internal/v1/release-notes/seen?lang=ru\|uz&age=kids\|teens\|adults` | `{release_note_ids: uuid[1..20]}` → 204; `lang`/`age` необязательны — сегмент ученика на момент показа для разрезов статистики |
| GET | `/internal/v1/release-notes/feed?lang=&age=&limit=&cursor=` | `Page<WhatsNewNote>` — лента «Новости» |

Правила `for-me` (INTERNAL_API §5, `domain/release_notes.py::pick_whats_new`):
- нет `onboarded_at` (онбординг не завершён) → `none`;
- **welcome** — ученик ещё не видел ни одной заметки `new`, и для его сегмента такие опубликованы: все опубликованные `new`
  + последняя `all`, ещё не просмотренные;
- **updates** — иначе: непросмотренные `existing` / `all`, опубликованные после `onboarded_at`;
- фильтр по сегментам (`lang` — язык интерфейса, `age` — возраст), не больше 5, новые первыми; пусто → `none`.
Тексты — на языке `lang`; `lang` и `age` обязательны (422), наивное `onboarded_at` считается UTC.

`seen` идемпотентен (повтор не меняет `seen_at` и сегмент первого показа), неизвестные id и черновики игнорируются;
`lang`/`age` вне каталога → 422. После удаления ученика (сага)
`for-me` и `seen` → 410 `USER_DELETED`. Лента — все опубликованные для сегмента (все аудитории), курсор непрозрачный
(`published_at` + порядковый номер), неверный → 400 `INVALID_CURSOR`, `limit` 1…100 (20).

### Сотрудник (admin-bff, спринт 2)
Права «Что нового» (PLAN «Роли и права», admin.ts) проверяет и домен: `whatsnew.manage` — список, карточка, черновик,
статистика; `whatsnew.publish` — публикация и снятие (step-up — в admin-bff); `dashboard.read` — сводка. Права
конфигурации интерфейса (`config.*`) к заметкам не допускают.

| Метод | Путь | Право | Тело → ответ |
|---|---|---|---|
| GET | `/admin/v1/release-notes?status=&limit=&cursor=` | `whatsnew.manage` | → `{items: StaffReleaseNote[], next_cursor}` (новые первыми; `views_total` — одним GROUP BY на страницу) |
| GET | `/admin/v1/release-notes/summary` | `dashboard.read` | → `DashboardWhatsNew {published, drafts, latest: {release_note_id, slug, title (RU), views_total, published_at} \| null}` (архив не считается) |
| GET | `/admin/v1/release-notes/{id}` | `whatsnew.manage` | → `StaffReleaseNote`; 404 `RELEASE_NOTE_NOT_FOUND` |
| GET | `/admin/v1/release-notes/{id}/stats` | `whatsnew.manage` | → `ReleaseNoteStats {views_total, views_by_lang {ru, uz}, views_by_age {kids, teens, adults}, first_view_at, last_view_at}`; 404 `RELEASE_NOTE_NOT_FOUND` |
| POST | `/admin/v1/release-notes` | `whatsnew.manage` | `{slug, title {ru, uz}, items[1..6], audience, segments, illustration?}` → 201 черновик; 409 `RELEASE_NOTE_SLUG_EXISTS`; 422 `RELEASE_NOTE_TRANSLATION_MISSING {missing}`; `Idempotency-Key` |
| PUT | `/admin/v1/release-notes/{id}` | `whatsnew.manage` | то же + `expected_version` → черновик (повтор тех же данных — no-op); 409 `RELEASE_NOTE_NOT_DRAFT` / `RELEASE_NOTE_VERSION_CONFLICT {current_version}` |
| POST | `/admin/v1/release-notes/{id}/publish` | `whatsnew.publish` | `{expected_version, reason}` → 201 (`published_at` = сейчас); уже опубликована → 200; архивная → 409 `RELEASE_NOTE_NOT_DRAFT`; 422 `RELEASE_NOTE_TRANSLATION_MISSING` / `VALIDATION_ERROR` (черновик перепроверяется целиком); `Idempotency-Key` |
| POST | `/admin/v1/release-notes/{id}/archive` | `whatsnew.publish` | `{reason}` → 201 (снятие с показа); уже в архиве → 200 |

`StaffReleaseNote.views_total` — уникальные ученики с отметкой просмотра (у черновика 0; у архивной сохраняется).
Статистика: разрезы по языку и возрасту — по сегменту, сохранённому в отметке при первом показе (миграция 0005);
отметки без сегмента (до 0005 или без `lang`/`age` в `seen`) учитываются только в `views_total`. Удаление ученика
(сага) удаляет и его отметки — показы уменьшаются. Идентификаторов учеников в статистике нет.

Пункт заметки: `{title {ru, uz} ≤ 80, text {ru, uz} ≤ 200, link, icon}`; `link` — маршрут Mini App, `icon` — иконка
(или null) из каталога `packages/contracts/release-notes.json` (сверка — контрактный тест). **Оба перевода обязательны**:
пустой или отсутствующий текст на любом языке → 422 `RELEASE_NOTE_TRANSLATION_MISSING {missing: ["title.uz",
"items[0].text.ru", …]}` при создании, правке и публикации (черновик в обход API тоже не опубликуется). Тексты — одна
строка простого текста: пробелы схлопываются, управляющие и bidi-символы → 422; разметка не запрещена, но клиенты выводят
её только как текст. `audience`: `new` — знакомство после первой регистрации, `existing` (по умолчанию) — тем, кто уже
занимается, `all` — всем. `segments {age?: [kids|teens|adults], ui_lang?: [ru|uz]}` — пусто или нет ключа = всем; хранятся
без повторов в порядке каталога. Правка опубликованной — только «архив + новая заметка».

Иллюстрация (релиз 6.1): `illustration` — ключ из списка `illustrations` каталога (`welcome`, `s6-heroes`) или null
(нет поля у клиента до 6.1: при создании — null, при правке черновика — не меняется); ключ не из каталога → 422 `VALIDATION_ERROR` (и при публикации черновика, попавшего в
БД в обход API). Mini App показывает картинку `apps/telegram-miniapp/public/whatsnew/<key>.webp` (16:9, 1200×675) сверху
первой карточки заметки; `WhatsNewNote.illustration` — тот же ключ. У опубликованной иллюстрация неизменна (триггер).
Маршруты 6.1: `heroes`, `shop`, `badges`, `game_history`, `game_settings` (игра), `dictionary`, `reading`.

## События
Публикует (outbox, в транзакции команды):
- `experience.config.activated.v1 {app, version, previous_version, activation_id}` — активация и откат;
- `experience.release_note.published.v1 {release_note_id, slug, audience, segments, published_at}` — публикация заметки
  (notifications кладёт её в центр уведомлений);
- `admin.audit.recorded.v1` — команды сотрудников: `config.create | config.publish | config.rollback`
  (`object_id = "<app>@<version>"`), `release_note.create | update | publish | archive` (`object_id` = id заметки,
  `after` — метка, статус, аудитория, сегменты, иллюстрация, счётчики, без текстов); актор — сотрудник из токена
  admin-bff, у заметки релиза — `actor_type system`, `actor_id system:release` (миграция при выкладке);
- `user.domain.deleted.v1 {domain: experience-config, mode: deleted}` — ACK саги удаления.

Потребляет: `user.deletion.requested.v1` (durable `experience-config.user_deleted`, только от identity-consent; от
другого издателя — игнор с предупреждением) → отметки просмотра ученика удаляются физически, ученик попадает в
`deleted_users` (новые отметки → 410), ACK. Повтор рассылки сагой (новый `event_id`) снова подтверждается.

## Данные
- `config_versions` — `id`, `seq`, `app`, `version` (semver, `UNIQUE(app, version)`), `payload` JSONB (нормализованный),
  `checksum` (sha256 канонического JSON), `change_note`, `created_by`, `created_at`.
- `activations` — `id`, `seq`, `app`, `version` (FK на версию), `previous_version`, `kind` (`activate|rollback`), `reason`,
  `activated_by`, `activated_at`. Текущая = последняя активация приложения. Обе таблицы append-only (триггер).
- `release_notes` (миграция 0003) — `id`, `seq`, `slug` (уникальна среди неархивных), `title`/`items` JSONB `{ru, uz}`,
  `audience` (`new|existing|all`), `segments` JSONB, `status` draft/published/archived, `version`, кто/когда создал,
  изменил, опубликовал, архивировал; `illustration` (миграция 0006) — ключ каталога или NULL, CHECK формата ключа.
  Триггер `release_notes_guard`: у опубликованной меняется только статус → archived (тексты, сегменты, иллюстрация —
  нет), архивная неизменна, удалить можно только черновик; TRUNCATE запрещён.
- `release_note_views(user_id, release_note_id, seen_at, ui_lang, age_segment, PK(user_id, release_note_id))` — отметки
  просмотра (FK на заметку); `ui_lang` (`ru|uz`) и `age_segment` (`kids|teens|adults`) — сегмент на момент показа,
  NULL у старых отметок (миграция 0005, CHECK по каталогу);
  `deleted_users(user_id PK, request_id, deleted_at)` — исполненные удаления.
- Сид: миграция 0002 — miniapp **1.0.0** (текущая, тема «Тетрадь»: значения прототипа `Main.dc.html .app`, шрифты Onest /
  Unbounded / Caveat) и admin **1.0.0** (`Admin.dc.html .ad`, все разделы меню); миграция 0004 — опубликованная
  **welcome-1** (audience `new`, пять пунктов знакомства: герой растёт за навыки, урок 20 минут, повторения, график и
  напоминания, семья) и **черновик 2026.11** (audience `existing`). Тексты RU и UZ (латиница).
- Заметки релизов публикуются миграциями при выкладке (CONVENTIONS «Что нового в каждом релизе»): **0007 — релиз 6.1**:
  `s6-heroes` (age teens, adults) и `s6-heroes-kids` (age kids, на «ты», без приглашений, голос — с разрешения
  родителя), audience `existing`, иллюстрация `s6-heroes`, `published_by = system:release`, `published_at` — время
  миграции; событие публикации и аудит — в outbox той же транзакции (функции домена `published_payload`,
  `audit_record`). Приветствию `welcome-1` — иллюстрация `welcome` (триггер снимается на один UPDATE владельцем схемы);
  черновик 2026.11 архивирован (`archived_by = system:release`). Метка занята действующей заметкой сотрудника →
  миграция падает (архивировать заметку в админке и повторить деплой). `downgrade` удаляет обе заметки, их отметки и
  неотправленные события публикации, возвращает черновик и снимает иллюстрацию приветствия.

## Кэш
Ключ `expcfg:current:<app>`, TTL 60 с, значение `"<seq активации>|<json>"`. Запись — Lua-скриптом «только если seq новее»:
промах кладёт прочитанное из БД, активация/откат после commit кладут свою (более новую) конфигурацию — изменение видно
сразу, а запоздавший читатель или параллельная публикация не вернут устаревшую тему. Ошибка записи → ключ удаляется.
Redis недоступен или значение повреждено → ответ из БД.

## Runbook
- **Срочный откат темы Mini App или админки:** `POST /admin/v1/experience/{miniapp|admin}/rollback {reason}` (через
  admin-bff, право `config.publish`, step-up) — действует сразу, без сборки клиентов: кэш `current` обновляется в той же
  команде; Mini App и админка подхватят тему при следующем открытии (telegram-bff кэширует до 60 с).
- **Конфигурация «пропала»** (404 `EXPERIENCE_CONFIG_NOT_FOUND`): `SELECT * FROM activations ORDER BY seq DESC LIMIT 5`;
  Mini App в этом случае использует bundled fallback.
- **Заметку увидели не те ученики:** снять её (`/archive`), проверить `audience` и `segments`; отметки просмотра
  (`release_note_views`) не удаляются — повторно её никто не увидит. Заметку релиза (`system:release`) снимают так же —
  в админке «Что нового» → «Снять с показа».
- **Сброс кэша вручную:** `redis-cli DEL expcfg:current:miniapp`.
- Миграции: `alembic -c alembic.ini upgrade head` (Railway preDeploy).
- Локально: `infra/dev/stack.sh up`, `ENV=dev DATABASE_URL=postgresql://experience_config:dev@127.0.0.1:5432/tilhero
  REDIS_URL=redis://127.0.0.1:6379/0 NATS_URL=nats://127.0.0.1:4222 uv run uvicorn tilhero_experience.main:app --port 8106`.
- Тесты: `uv run pytest services/experience-config -q`.

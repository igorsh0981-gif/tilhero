# experience-config-service

**Владелец:** платформа (общий сервис Telegram- и Admin-контуров, решение 07.10.2026). **Bounded context:** Remote Experience Config — неизменяемые версии темы, порядка/вариантов секций Home и feature flags с активацией и откатом без пересборки фронтенда (ТЗ Telegram «UI/CSS» §3–8, ТЗ Admin §7, AD-FR-015).

Порт 8106, схема PostgreSQL `experience_config`, внутренний JWT с `aud = experience-config`. Redis — кэш текущей конфигурации (60 с) и Idempotency-Key staff-команд.

## API
| Метод | Путь | Кто | Право | Тело → ответ |
|---|---|---|---|---|
| GET | `/internal/v1/experience/{app}/current` | telegram-bff, admin-bff; `offers` — только `app = miniapp` (порог рейтинга отеля; к `admin` — 403 `CALLER_NOT_ALLOWED`) | — | → `ExperienceConfig` (кэш Redis 60 с, заголовок `x-cache: hit/miss`); 404 `EXPERIENCE_CONFIG_NOT_FOUND` |
| GET | `/admin/v1/experience/{app}/versions?limit=&cursor=` | admin-bff | `config.read` | → `{items: VersionSummary[], next_cursor}`; `status`: `current` / `previous` / null |
| GET | `/admin/v1/experience/{app}/versions/{version}` | admin-bff | `config.read` | → `VersionDetail` (с `payload`) |
| POST | `/admin/v1/experience/{app}/versions` | admin-bff | `config.edit` | `{version, payload, change_note}` → 201 `VersionDetail`; повтор с тем же содержимым — тот же ответ; та же версия с другим содержимым → 409 `EXPERIENCE_VERSION_EXISTS`; 422 `EXPERIENCE_CONFIG_INVALID {path, reason, errors[]}` |
| GET | `/admin/v1/experience/{app}/activations?limit=&cursor=` | admin-bff | `config.read` | → `{items: ActivationOut[], next_cursor}` (новые первыми) |
| GET | `/admin/v1/experience/{app}/state` | admin-bff | `config.read` | → `{app, current: ActivationOut \| null, previous_version}` |
| POST | `/admin/v1/experience/{app}/activate` | admin-bff | `config.publish` | `{version, reason}` → 201 `ActivationOut`; уже текущая → 200 (no-op); 404 `EXPERIENCE_VERSION_NOT_FOUND` |
| POST | `/admin/v1/experience/{app}/rollback` | admin-bff | `config.publish` | `{reason}` → 201 `ActivationOut`; 409 `EXPERIENCE_NO_PREVIOUS` |

### «Что нового» — заметки о релизах Mini App (доработка 9.4)
| Метод | Путь | Кто | Право | Тело → ответ |
|---|---|---|---|---|
| GET | `/internal/v1/release-notes/published?limit=` | telegram-bff | — | → `{items: [{release_note_id, slug, title, items, audience, published_at}]}` — только опубликованные, новые первыми, `limit` 1…20 (10); отбор непросмотренных — в BFF |
| GET | `/admin/v1/release-notes?status=&limit=&cursor=` | admin-bff | `config.read` | → `{items: StaffReleaseNote[], next_cursor}` (новые первыми) |
| GET | `/admin/v1/release-notes/{id}` | admin-bff | `config.read` | → `StaffReleaseNote`; 404 `RELEASE_NOTE_NOT_FOUND` |
| POST | `/admin/v1/release-notes` | admin-bff | `config.edit` | `{slug, title {ru,en}, items[1..6], audience}` → 201 черновик; 409 `RELEASE_NOTE_SLUG_EXISTS` (метка занята действующей заметкой); `Idempotency-Key` |
| PUT | `/admin/v1/release-notes/{id}` | admin-bff | `config.edit` | то же + `expected_version` → черновик (повтор тех же данных — no-op); 409 `RELEASE_NOTE_NOT_DRAFT` / `RELEASE_NOTE_VERSION_CONFLICT {current_version}` |
| POST | `/admin/v1/release-notes/{id}/publish` | admin-bff | `config.publish` | `{expected_version, reason}` → 201 (`published_at` = сейчас); уже опубликована → 200; архивная → 409 `RELEASE_NOTE_NOT_DRAFT`; `Idempotency-Key` |
| POST | `/admin/v1/release-notes/{id}/archive` | admin-bff | `config.publish` | `{reason}` → 201; уже в архиве → 200 |

Пункт заметки: `{title {ru,en} ≤ 80, text {ru,en} ≤ 200, link, icon}`; `link` ∈ маршруты Mini App `home catalog watch news profile support` или null, `icon` — из набора иконок Mini App или null (общий каталог `packages/contracts/release-notes.json`, сверка — контрактный тест). Тексты — одна строка простого текста: пробелы схлопываются, управляющие и bidi-символы → 422; разметка не запрещена, но клиенты выводят её только как текст. `audience`: `existing` (по умолчанию) — только пользователям, прошедшим онбординг до публикации; `all` — и новым (новый пользователь увидит заметку при первом входе, только если она последняя). Правка опубликованной — только «архив + новая заметка».

`{app}` ∈ `miniapp | admin`, иначе 404 `EXPERIENCE_APP_UNKNOWN`. `reason`, `change_note` — 3…500 символов. Staff-команды принимают необязательный `Idempotency-Key` (8…128 символов `[A-Za-z0-9_-:.]`, область — сотрудник + приложение + команда): повтор возвращает сохранённый ответ с заголовком `idempotent-replay: true`, поэтому двойной клик «Откатить» не откатывает дважды.

**Откат** не меняет историю: создаётся новая активация `kind=rollback` версии `previous_version` текущей активации, а её `previous_version` = бывшая текущая. Повторный откат возвращает обратно (2.0.3 → 2.0.2 → 2.0.3). Активации приложения сериализуются `pg_advisory_xact_lock`.

## Payload версии
**miniapp** — `ExperienceConfig` из `packages/contracts/src/bff.ts` без `app/version` (их добавляет сервис в ответе `current`):
```json
{"theme": {"id": "default", "version": "2.0.3", "tokens": {"--accent": "#DFFF56", "--r-card": "22px", "...": "..."}},
 "home": {"welcome_mode": "first_visit_only", "sections": [
   {"type": "event_carousel", "key": "best_for_you", "variant": "large", "enabled": true}, "..."]},
 "flags": {"ai_concierge": true, "group_trip": true, "calendar_export": false, "premium_teaser": true},
 "hotel_rating_min": 8.5}
```
**admin** — `{theme, layout: {density: compact|comfortable, table_presets: {users: support|analytics, audit: security|full}, dashboard_widgets: [{id, enabled}]}, flags}` (виджеты — 10 id дашборда прототипа Admin). Контракт admin-bff появится в спринте 2.

Строгая валидация (pydantic, `extra=forbid`, `strict`): известные типы секций (`event_carousel, watch_changes, news_carousel, ai_summary, catalog_link`) и варианты (`large, compact`), уникальные `key` (`^[a-z][a-z0-9_]{1,31}$`), 1…20 секций; `welcome_mode` ∈ first_visit_only/always/never; флаги — только bool, имена `^[a-z][a-z0-9_]{0,63}$`, ≤ 50; `hotel_rating_min` 7.0…10.0; payload ≤ 32 КБ. Любое поле вне схемы (`css_url`, `script`, `onclick`…) → `unknown_field`. В ответе 422 — все найденные ошибки (`errors`, до 20), первая — в `path/reason`.

### Токены темы — только белый список (ТЗ UI/CSS §5: никакого произвольного CSS/JS)
Каждый токен типизирован, значение проверяется грамматикой целиком (`domain/tokens.py`):
- **color** — `#RGB/#RGBA/#RRGGBB/#RRGGBBAA`, `rgb(r,g,b)`, `rgba(r,g,b,a)`;
- **length** — `0` или число с единицей из набора токена (радиусы и отступы 0…64 px/rem, `--gutter` 8…32 px, `--ec-media-h` 120…320 px, Admin `--nav-w`, `--top-h` в px);
- **number** — десятичное число с диапазоном: ширины рельсов Home как доля ширины — `--rail-w` 0.85…0.90, `--rail-w-compact` 0.65…0.75 (ТЗ UI/CSS §7);
- **font** — Mini App: одно семейство бренда `Manrope` / `Unbounded` / `JetBrains Mono` (в кавычках или без; системные фолбэки добавляет клиент); Admin: стек из бренда и системных фолбэков (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif, ui-monospace, Menlo, monospace…`), ≤ 8 семейств;
- **shadow** (Admin) — до 3 теней из длин px и цвета, либо `none`.

`url(`, `expression(`, `javascript:`, `var(`, `@import`, `;`, `{`, `}`, `<`, `>`, `\`, комментарии и управляющие символы → `forbidden_construct`; неизвестный токен → `unknown_token`.

Mini App — ровно allowlist санитайзера Mini App (`packages/ui-tokens/token-names.json`, CSS-слои выведены из прототипа `proto/miniapp/src/01-base.css`): сервер принимает только то, что клиент действительно применит, и проверяет значения не мягче клиента; совпадение имён и типов проверяет контрактный тест. Цвета: `--bg --bg-2 --surface --surface-2 --surface-3 --line --line-2 --ink --ink-2 --muted --accent --accent-ink --accent-tx --accent-soft --accent-line --focus --btn-bg --btn-tx --good --good-soft --warn --warn-soft --bad --bad-soft --info --info-soft --chrome --tabbar --scrim --sheet-bg --card-border --knob-on --match-bg --match-ink`; длины: `--r-card --r-btn --r-field --r-chip-grid --r-sheet --gutter --sp-1…--sp-8 --ec-media-h`; числа: `--rail-w --rail-w-compact`; шрифты: `--font-display --font-body`. `theme.id` — `default | bank` (CSS-темы Mini App). Admin — токены `:root` из `proto/admin/src/02-style.css`, `theme.id` — `default | high_contrast`.

## События
Публикует (outbox, в транзакции команды):
- `experience.config.activated.v1 {app, version, previous_version, activation_id}` — активация и откат;
- `admin.audit.recorded.v1` — запись журнала для audit-service: `actor_type=staff`, `actor_id/actor_role` из токена, `action` = `config.create | config.publish | config.rollback`, `object_type=experience_config`, `object_id="<app>@<version>"`, `before/after {version}`, `reason` (для create — `change_note`), `trace_id`.

- `admin.audit.recorded.v1` для заметок «Что нового» (9.4): `action` = `release_note.create | update | publish | archive`, `object_type=release_note`, `object_id` = id заметки, `after` — метка, статус, счётчики (без текстов заметки), `reason` — причина публикации/архива.

Не потребляет.

## Данные
- `config_versions` — `id` UUID, `seq`, `app`, `version` (semver, `UNIQUE(app, version)`), `payload` JSONB (нормализованный), `checksum` (sha256 канонического JSON), `change_note`, `created_by`, `created_at`.
- `activations` — `id` UUID, `seq` (порядок), `app`, `version` (FK на версию), `previous_version`, `kind` (`activate|rollback`), `reason`, `activated_by`, `activated_at`. Текущая = последняя активация приложения.
- Обе таблицы append-only: UPDATE/DELETE/TRUNCATE запрещены триггером.
- `release_notes` (9.4, миграция 0003) — `id`, `seq`, `slug` (уникальна среди неархивных), `title`/`items` JSONB, `audience`, `status` draft/published/archived, `version` (блокировка черновика), кто/когда создал, изменил, опубликовал, архивировал. Триггер `release_notes_guard`: у опубликованной меняется только статус → archived, архивная неизменна, удалить можно только черновик; TRUNCATE запрещён. Сид (миграция 0004) — **черновик** «Ноябрь 2026» (`2026.11`, `created_by = system:seed`): пользователи его не видят, пока сотрудник не опубликует.
- Сид (миграция 0002): miniapp 2.0.2 (мятный акцент `#8EF5C2`, радиус карточек 14px, чипов 9px — демо отката прототипа `.tg.cfg-old`) → 2.0.3 (текущая, «тёмный премиум»: лайм `#DFFF56`, navy — значения темы default Mini App), admin 1.0.0. Флаги и `hotel_rating_min=8.5` — как CONFIG прототипа Admin.

## Кэш
Ключ `expcfg:current:<app>`, TTL 60 с, значение `"<seq активации>|<json>"`. Запись — Lua-скриптом «только если seq новее»: промах кладёт прочитанное из БД, активация/откат после commit кладут свою (более новую) конфигурацию — изменение видно сразу, а запоздавший читатель или параллельная публикация не вернут устаревшую тему. Ошибка записи → ключ удаляется. Redis недоступен или значение повреждено → ответ из БД.

## Runbook

> Эксплуатация через браузер (Railway, админка, оповещения ops-monitor): [docs/runbooks/experience-config.md](../../docs/runbooks/experience-config.md). Ниже — технические детали для разработчика.
- **Срочный откат темы Mini App:** `POST /admin/v1/experience/miniapp/rollback {reason}` (через admin-bff, право `config.publish`) — действует сразу, без релиза Mini App; клиенты с открытой сессией подхватят при следующем запросе конфигурации (BFF кэширует до 60 с).
- **Конфигурация «пропала»** (404 `EXPERIENCE_CONFIG_NOT_FOUND`): проверить `SELECT * FROM activations ORDER BY seq DESC LIMIT 5`; Mini App в этом случае использует bundled fallback.
- **Сброс кэша вручную:** `redis-cli DEL expcfg:current:miniapp`.
- Миграции: `alembic -c alembic.ini upgrade head` (Railway preDeploy).
- Локально: `infra/dev/stack.sh up`, `DATABASE_URL=postgresql://experience_config:dev@127.0.0.1:5432/tilhero REDIS_URL=redis://127.0.0.1:6379/0 NATS_URL=nats://127.0.0.1:4222 uv run uvicorn tilhero_experience.main:app --port 8106`.
- Тесты: `uv run pytest services/experience-config -q`.

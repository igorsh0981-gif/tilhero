# Спринт 2 — внутренние контракты (админ-контур TilHero)

Публичный API admin-bff ↔ admin-web — `packages/contracts/src/admin.ts` (единственный источник типов). Внутренние вызовы — внутренний JWT EdDSA (CONVENTIONS §2). Контекст сотрудника `actor {id, role, name, permissions}` домены принимают **только от admin-bff** (`ACTOR_NOT_ALLOWED`) и **сами** проверяют права по `actor.permissions` (защита в глубину). Пути сотрудников в доменах — `/admin/v1/*` и **совпадают** с путями admin-bff из `admin.ts`, кроме оговорённых; внутренние — `/internal/v1/*`.

Исходник — aievent (`/home/claude/aievent/docs/sprint2/INTERNAL_API.md` и код сервисов): поведение входа, TOTP, four-eyes, step-up, сессий, CSRF, аудита, маскирования и поддержки переносится без изменений, кроме перечисленного здесь. Туристическое (события, поездки, AI, источники, ленты новостей, мониторинг, биллинг, режим AD) не переносится.

Новые имена в шине и аудите: `source` аудита — имя сервиса; `object_type` — `staff`, `role`, `approval`, `learner`, `release_note`, `notification_template`, `campaign`, `config`, `ticket`.

## 1. admin-identity (8120, схема `admin_identity`, пакет `tilhero_admin_identity`)
Форк aievent admin-identity: `staff`, `roles`, `role_permissions`, `approvals`, `login_attempts`, `mfa_*`; вход `/internal/v1/auth/*` (login, mfa, mfa enroll start/confirm, password, step-up, principal, logout), bootstrap первого super_admin из `ADMIN_BOOTSTRAP_EMAIL/ADMIN_BOOTSTRAP_PASSWORD` (только при отсутствии активного super_admin; пароль должен пройти правила; must_change_password=true), Staff/Roles/Approvals API, `GET /admin/v1/staff/lookup?ids=` (имена для admin-bff, без проверки права — любой вошедший сотрудник), аудит `auth.*`, `staff.*`, `role.*`, `approval.*` через `admin.audit.recorded.v1`.
- Матрица ролей и прав — `PLAN.md` §«Роли и права» и `admin.ts` (`Permission`, `RoleCode`, `PRIVILEGED_ROLES`). Одна миграция `0001` с матрицей TilHero (prod-БД админки пуста). Контрактный тест: множество прав сида = `PERMISSIONS` из `admin.ts`.
- TOTP: issuer «TilHero Admin», секрет шифруется `ADMIN_MFA_ENC_KEY` (base64 32 байта, AES-GCM); код одноразовый в окне (повтор → MFA_INVALID).
- Удаляются: AD/LDAP, имперсонация вне ENV=dev, всё про AI-уровни доступа.

## 2. user-admin (8121, схема `user_admin`, пакет `tilhero_user_admin`)
Read-модель `admin_learner_summary` — поля `AdminLearnerRow` из `admin.ts` плюс служебные (`search_text`, `source_updated_at`, `plan` JSONB, `consent` JSONB, `notifications` JSONB).
- **Наполнение событиями** (inbox, дедупликация по event_id, порядок по `occurred_at` — более старое событие не перетирает новое): `user.profile.created|updated.v1`, `user.status.changed.v1`, `consent.accepted|revoked.v1`, `user.notification_settings.changed.v1`, `user.security.changed.v1` (pin_enabled, pin_reset_pending), `learning.plan.updated.v1` (goal, ui_lang, расписание, onboarding), `learning.activity.recorded.v1` (`last_activity_at`), `support.ticket.created|status.changed.v1` (счётчики), `user.deletion.requested.v1` (status DELETION_REQUESTED), `user.domain.deleted.v1` от identity-consent (имя, username, маска → null; status DELETED).
- **Сверка** при старте и каждые 10 мин (и `POST /internal/v1/reconcile` для n8n со SCHEDULER_TOKEN): identity-consent `GET /admin/v1/users?updated_after=&cursor=&limit=500` и learning-plan `GET /admin/v1/plans?updated_after=&cursor=&limit=500`; курсоры в `reconcile_state`.
- **API** (вызывает только admin-bff, actor обязателен):
  - `GET /admin/v1/learners?q=&kind=&age_band=&status=&locale=&has_open_tickets=&cursor=&limit=` (users.read) → `Page<AdminLearnerRow>`; `q` — UUID, `@username`, часть имени (ILIKE по `search_text`, экранирование `%_`), `TCK-NNNN` → `user_id` автора по собственной проекции `ticket_refs` (события support; support не принимает actor от user-admin), без права support.read у сотрудника поиск по номеру не выполняется.
  - `GET /admin/v1/learners/{id}` (users.read) → `AdminLearnerCard` без `tickets` (их добавляет admin-bff) и с `refreshed_at`: карточка перечитывается из identity-consent `GET /admin/v1/users/{id}` (недоступен — из проекции, `refreshed_at` = время проекции).
  - `GET /admin/v1/learners/stats?period=today|7d|30d` (dashboard.read) → `DashboardLearners`.
- Telegram ID в user-admin только маской `••••••789` (последние 3 цифры); полного значения в схеме нет.

## 3. Изменения существующих сервисов

### identity-consent
- `GET /admin/v1/users?updated_after=&cursor=&limit=` и `GET /admin/v1/users/{id}` — вызывает **только user-admin**, без actor → поля `AdminLearnerRow`/`AdminLearnerCard.consent|security|notifications` (Telegram ID — только маска), плюс `updated_at`.
- `POST /admin/v1/users/{id}/reveal {field: "telegram_user_id", reason 5..300}` — **только admin-bff** с actor и правом `users.sensitive.read` → `RevealResult`; аудит `sensitive.view` синхронно (audit `POST /internal/v1/records`, писатель identity-consent); audit недоступен → 503 AUDIT_UNAVAILABLE без значения; детский профиль → 409 FIELD_NOT_AVAILABLE.
- **Аудитория рассылок** (вызывает только notifications):
  - `GET /internal/v1/audience?ui_lang=ru,uz&age=teens,adults&onboarded=true|false&active_days=±N&cursor=&limit=500` → `{items: [{user_id, locale}], next_cursor}`;
  - `GET /internal/v1/audience/count?...` → `{count, by_lang: {ru, uz}}`.
  - Всегда исключены: детские профили, статус ≠ ACTIVE, без действующего согласия с целью `product_news`, подростки без `guardian_consent=granted`, ученики без `age_band`. `age` по умолчанию `["adults"]`; `kids` → 422.
  - `onboarded` и `active_days` — проекция `learner_activity(user_id, onboarding_completed_at, last_activity_at)` из `learning.plan.updated.v1` и `learning.activity.recorded.v1` (новый consumer, inbox). `active_days=N>0` — `last_activity_at ≥ now−N дней`; `N<0` — нет активности |N| дней (или никогда).
- Миграция: `learner_activity`, индексы под фильтры аудитории.

### learning-plan
`GET /admin/v1/plans?updated_after=&cursor=&limit=` (только user-admin, без actor) → `{items: [{user_id, goal, level_self, ui_lang, schedule, onboarding_completed_at, updated_at}], next_cursor}`.

### experience-config
- «Что нового»: права заменяются — чтение, черновик, правка, статистика — `whatsnew.manage`; публикация и архив — `whatsnew.publish` (step-up проверяет admin-bff). `staff_view` получает `views_total`. Новый `GET /admin/v1/release-notes/{id}/stats` (whatsnew.manage) → `ReleaseNoteStats` (из `release_note_views`; для разрезов по языку и возрасту отметка хранит `ui_lang` и `age_segment` ученика на момент показа — миграция добавляет колонки, старые отметки — `null`, не учитываются в разрезах).
- Конфигурация `miniapp` и `admin` — как сейчас (config.read|edit|publish).
- Новый `GET /admin/v1/release-notes/summary` (dashboard.read) → `DashboardWhatsNew`.

### notifications
**Шаблоны.**
- Таблица `notification_template_versions` (key, version, status draft|active|archived, `texts` JSONB `{ru:{title,body,button}, uz:{…}}`, note, created_by, created_at, activated_by, activated_at, archived_at); частичный уникальный индекс — одна активная версия на ключ.
- Редактируемые ключи — все из `TEMPLATES`, кроме `direct_only` и `transactional` (pin.*). У каждого `TemplateSpec` появляются `placeholders(lang, params, ctx) -> dict[str, str]` (значения уже на языке ученика: «15 минут», «3 дня», имя), описание и образцы (`TemplatePlaceholder`).
- Отрисовка: есть активная версия → `title/body/button` = подстановка `{name}` из `placeholders()` (str.format_map со строгим набором; `{{`/`}}` — буквальные скобки; текст экранируется для Telegram), `startapp` — из кода; нет → текст из кода. Ошибка подстановки активной версии → текст из кода + лог (не падать).
- Проверка при сохранении → 422 `TEMPLATE_INVALID {fields: [{path, reason}]}`: оба языка, непустые title и body, длины (`admin.ts`), только известные плейсхолдеры, без управляющих символов, для `kid` — без слов давления (тот же список, что в тестах детских шаблонов).
- Staff API — пути `admin.ts` §«Шаблоны уведомлений»; права `notif.templates.manage`; аудит `template.*`.

**Тестовая отправка** — `ADMIN_TEST_CHAT_IDS` (chat id через запятую). `GET /admin/v1/notifications/test-recipients` отдаёт только индексы и маски; `…/test {lang, recipient}` отправляет через bot-gateway с префиксом «[ТЕСТ] » в заголовке, без записи в центр уведомлений и без учёта лимитов ученика; ≤ 10 тестов в минуту на сотрудника (Redis).

**Рассылки.**
- `campaigns` (поля `Campaign` из `admin.ts`, `segment` и `texts` JSONB, `version` — оптимистическая блокировка) и `campaign_recipients` (campaign_id, user_id, notification_id null, status pending|created|skipped_frequency|cancelled, PK (campaign_id, user_id)).
- Staff API — пути `admin.ts` §«Рассылки»; права `notif.campaigns.manage` / `notif.campaigns.send`; аудит `campaign.*`. Оценка охвата — identity-consent `/internal/v1/audience/count` + оценка лимита частоты по `campaign_recipients` за 7 дней.
- Исполнение — `notifications:dispatch` (n8n, 5 мин, уже есть) дополнительно:
  1) `scheduled` с `send_at ≤ now` → `sending` (`started_at`, фиксация `stats.audience`);
  2) выборка аудитории пачками по 500 из identity-consent с сохранением курсора в `campaigns.cursor` (повтор безопасен) → `campaign_recipients`;
  3) для каждого получателя: был ли у него `campaign_recipients.status=created` за `CAMPAIGN_MIN_INTERVAL_DAYS` (7) → `skipped_frequency`; иначе запись уведомления категории `product`, kind `campaign`, dedup `campaign:<id>:<user>`, через общую политику доставки (согласие и категория перепроверяются, местное время, тихие часы → deferred) → `created`;
  4) аудитория исчерпана → `done` (`finished_at`), аудит `campaign.finished`.
- `stop`: статус `stopped`, `campaign_recipients.pending → cancelled`, ещё не отправленные записи уведомлений рассылки → `cancelled`; отправленные не отзываются. Повтор — 200.
- Плейсхолдер рассылки — только `{learner_name}` (имя из identity-consent при отрисовке; нет имени — пустая строка, двойные пробелы схлопываются).

### support
Уже есть (форк aievent в спринте 1). Изменения: `ReplyTemplate` на RU/UZ (`admin.ts`), `GET /admin/v1/support/templates`. Ответ оператора ученику — уведомление `support.reply` (есть).

### audit
Писатели HTTP `POST /internal/v1/records`: `identity-consent` (reveal — делегирование от имени сотрудника, только `sensitive.view*`), `admin-bff` (только `dev.impersonate` и `auth.logout`, только с actor; иначе 403 ACTION_NOT_ALLOWED). Через шину (`admin.audit.recorded.v1`) — доменные сервисы, как сейчас, + `admin-identity`. Фильтр `object_type` в `GET /admin/v1/audit/records`. Чужой `record_id` → 409 AUDIT_RECORD_CONFLICT.

## 4. admin-bff (8002, Node 22 Fastify, `services/admin-bff`)
Форк aievent admin-bff: cookie `__Host-tilhero_admin`, Redis-сессия (бездействие 30 мин, абсолют 8 ч), principal из admin-identity с кэшем 30 с, CSRF-синхронизатор + проверка Origin (`ADMIN_ORIGIN`), rate limit входа, step-up ≤ 5 мин (список — шапка `admin.ts`), actor-токен к доменам, имена сотрудников (`*_name`) через `staff/lookup`, агрегация:
- карточка ученика = user-admin + support `GET /admin/v1/support/tickets?user_id=&limit=20` (без support.read → `tickets: null`);
- дашборд = user-admin stats + support stats + experience-config summary + notifications `GET /admin/v1/notifications/campaigns/summary?period=` (каждый блок независим).
Маршруты — строго по `admin.ts`; ответы доменов проверяются по схемам (лишнее отбрасывается). Публичного домена нет.

## 5. admin-web (`apps/admin-web`, React 18 + Vite + TS, Caddy)
Форк aievent admin-web: вход (пароль, TOTP 6 ячеек, подключение MFA с QR, смена пароля, блокировка), оболочка по прототипу TilHero (тёмная боковая панель, 15 разделов меню из сида experience-config `admin`, RBAC-фильтр), RU/EN, светлая и тёмная тема. Экраны:
- **Обзор** — блоки `Dashboard`;
- **Ученики** — список с фильтрами, карточка (аккаунт и дети, согласия, план и график, уведомления, обращения), раскрытие Telegram ID с причиной и таймером 60 с;
- **Поддержка** — очередь, тред, ответ и внутренняя заметка (визуально различимы), взять в работу, статусы, эскалации, SLA;
- **Что нового** — список (статус, аудитория, показы), редактор RU/UZ (вкладки языков, счётчики длины, подсветка пустых переводов), пункты 1..6 с маршрутом и иконкой, аудитория и сегменты, предпросмотр в рамке телефона (RU/UZ, светлая/тёмная), публикация и снятие с TOTP, статистика;
- **Уведомления** — шаблоны (список по категориям, версии, редактор RU/UZ с вставкой плейсхолдеров, предпросмотр, тест, активация, сброс) и рассылки (черновик, сегмент, оценка охвата, тест, расписание, стоп, статистика);
- **Конфигурация** — тема Mini App и админки: версии, активация, откат;
- **Роли и доступ** — сотрудники, роли, заявки four-eyes;
- **Аудит** — журнал, фильтры, проверка цепочки.
Остальные разделы меню (контент, агенты, качество, затраты, герои, игра, события, языки) — экран «скоро» с номером спринта.

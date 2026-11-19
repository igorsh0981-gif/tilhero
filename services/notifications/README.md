# notifications

**Владелец:** Telegram-контур. **Bounded context:** политика доставки (категории, общий выключатель, тихие часы,
правила детей 6–13, лимит дня, дедупликация), шаблоны RU/UZ, журнал доставки = **центр уведомлений в приложении**,
доставка в Telegram через telegram-bot-gateway. Спринт 1 TilHero: `docs/sprint1/INTERNAL_API.md` §4,
`docs/sprint1/PLAN.md` (правила напоминаний, AT-07, 08, 10, 12, 13, 15), `docs/CONVENTIONS.md` §8.

## API
`/health/live`, `/health/ready` (БД, Redis, NATS, потребители) и внутренние (внутренний JWT EdDSA):

| Метод | Путь | Кто вызывает | Описание |
|---|---|---|---|
| GET | `/internal/v1/me/inbox?limit=1..100 (20)&cursor=` | **только** telegram-bff, `sub` = ученик | `Page<InboxItem>` (bff.ts): новые первыми, 90 дней. Видны записи с отрисованным текстом, кроме `skipped`; код PIN не показывается. 400 `INVALID_CURSOR`, 422 `VALIDATION_ERROR` |
| GET | `/internal/v1/me/inbox/unread-count` | telegram-bff | `{unread}` |
| POST | `/internal/v1/me/inbox:read` | telegram-bff | `InboxReadRequest {ids?: ≤100 UUID, all?: true}` → `{unread}`; ни `ids`, ни `all` → 422. Идемпотентно (повтор не меняет `read_at`); чужие и неизвестные id игнорируются без раскрытия |
| POST | `/internal/v1/notifications/transactional` | **только** identity-consent | `{notification_id, user_id, template: "pin.reset_code", params: {code, ttl_minutes?}, dedup_key}` → `{notification_id, status: sent\|queued\|failed\|skipped, reason}`. Код мимо шины: запись в журнал (не в центре) и немедленная отправка, сразу и мимо настроек; временная ошибка → `queued` с повтором; бот заблокирован → `failed blocked`; удалённый → `skipped user_deleted` без записи; повтор с тем же `notification_id`/`dedup_key` второй раз не отправляет |
| POST | `/internal/v1/notifications:dispatch` | **только** n8n (5 мин), `Authorization: Bearer <SCHEDULER_TOKEN>` | обработка записей `scheduled` с `scheduled_for ≤ now` (до `DISPATCH_MAX_BATCHES_PER_CALL` пачек) + срок хранения → `{sent, scheduled, in_app_only, failed}`. Повтор безопасен. 401 `SCHEDULER_TOKEN_INVALID` (пустой токен выключает вход), 403 `CALLER_NOT_ALLOWED` (внутренний JWT) |

`user_id` центра — только из токена (IDOR). Ученик детского профиля видит свои записи; родитель (`sub` = аккаунт) — свои.

### Staff API (спринт 2, `packages/contracts/src/admin.ts`; вызывает **только** admin-bff с `actor`)
Пути совпадают с admin-bff. Права проверяются здесь же (защита в глубину); step-up — в admin-bff. Ответы — формы
admin.ts, `*_name` сотрудников — `null` (заполняет admin-bff).

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/admin/v1/notifications/templates` | `notif.templates.manage` | `{items: TemplateInfo[]}` — редактируемые (всё, кроме `pin.*`): описание RU/EN, плейсхолдеры с образцами RU/UZ, `default_texts` (код на образцах), активная версия |
| GET | `…/templates/{key}` | то же | `TemplateInfo & {versions}` (новые первыми, ≤ 50); `pin.*`/неизвестный — 404 `TEMPLATE_NOT_FOUND` |
| POST | `…/templates/{key}/versions` | то же | `{texts, note 3..300}` + `Idempotency-Key` (повтор — та же версия, другое тело — 422 `IDEMPOTENCY_KEY_REUSED`) → 201 draft; 422 `TEMPLATE_INVALID {fields: [{path, reason}]}` |
| POST | `…/templates/{key}/versions/{v}/preview` | то же | `{lang, sample?}` → `TemplatePreview` (образцы; неизвестный ключ образца — 422); 404 `TEMPLATE_VERSION_NOT_FOUND` |
| POST | `…/templates/{key}/versions/{v}/activate` | то же | `{reason}` → `TemplateVersion` (active, прежняя → archived; повтор — 200 без изменений); перед активацией тексты проверяются снова |
| POST | `…/templates/{key}/reset` | то же | `{reason}` → `TemplateInfo` (активная → archived, текст из кода) |
| GET | `/admin/v1/notifications/test-recipients` | `notif.templates.manage` или `notif.campaigns.manage` | `{items: [{index, label: "Тестовый чат 1 (••••4821)"}]}` — только маски |
| POST | `…/templates/{key}/versions/{v}/test` | `notif.templates.manage` | `{lang, recipient}` → `TestSendResult`; 422 `TEST_RECIPIENT_NOT_ALLOWED`; 429 `RATE_LIMITED` |
| GET | `/admin/v1/notifications/campaigns/summary?period=today\|7d\|30d` | `dashboard.read` (или `notif.campaigns.manage`) | `DashboardCampaigns {scheduled, sending, sent_in_period (запущены), delivered_in_period (доставлено в Telegram)}`; «сегодня» — по `DEFAULT_TIMEZONE` |
| GET | `/admin/v1/notifications/campaigns?status=&cursor=&limit=` | `notif.campaigns.manage` | `Page<Campaign>` (новые первыми) |
| GET | `…/campaigns/{id}` | то же | `Campaign` со `stats`; 404 `CAMPAIGN_NOT_FOUND` |
| POST | `…/campaigns` | то же | `CampaignContent` + **обязательный** `Idempotency-Key` (нет — 422 `IDEMPOTENCY_KEY_REQUIRED`) → 201 draft; 422 `CAMPAIGN_INVALID {fields}` |
| PATCH | `…/campaigns/{id}` | то же | `Partial<CampaignContent> & {expected_version}` → `Campaign`; 409 `CAMPAIGN_NOT_DRAFT` \| `CAMPAIGN_VERSION_CONFLICT {current_version}` |
| POST | `…/campaigns/{id}/estimate` | то же | `CampaignEstimate` (identity-consent `/audience/count`; `frequency_capped` — пересечение до 10 страниц аудитории с получателями других рассылок за 7 дней, дальше пропорционально); 503 `UPSTREAM_UNAVAILABLE` |
| POST | `…/campaigns/{id}/preview`, `…/test` | то же | как у шаблонов; плейсхолдер — только `{learner_name}` |
| POST | `…/campaigns/{id}/schedule` | `notif.campaigns.send` | `{expected_version, send_at: string \| null, reason}` (+ `Idempotency-Key`, Redis) → scheduled; `send_at=null` — «Отправить сейчас» по часам сервера (QA D2-03, ревью T2-11), так же — send_at от now−5 мин до now+1 мин: запуск в самой команде (ответ уже `sending`, `started_at`, аудитория зафиксирована), первая пачка получателей — в фоне сразу после коммита, дальше — `:dispatch`; повтор с тем же ключом — сохранённый ответ без второго запуска; раньше now−5 мин — 422 `CAMPAIGN_INVALID send_at in_past` (ревью T2-2); дальше 30 дней — 422 `too_far`; аудитория 0 — 422 `CAMPAIGN_EMPTY_AUDIENCE` |
| POST | `…/campaigns/{id}/unschedule` | то же | `{reason}` → draft; черновик — 200 без изменений; `sending/done/stopped` — 409 `CAMPAIGN_ALREADY_SENDING` |
| POST | `…/campaigns/{id}/stop` | то же | `{reason}` → stopped из `scheduled\|sending\|done` (у `done` отменяются отложенные тихими часами): pending → cancelled, неотправленные записи → `cancelled`; повтор — 200 без изменений; `draft` — 409 `CAMPAIGN_NOT_ACTIVE` (ревью P2-7) |

Коды `reason` в `fields`: `required`, `too_long`, `too_short` (note), `unknown_placeholder`, `invalid_placeholder`
(непарная скобка, формат, индекс, атрибут), `control_chars`, `pressure_words` (детские шаблоны), `invalid`,
`kids_not_allowed`, `out_of_range`, `too_far`, `in_past`.

Исходящие (внутренний JWT, `iss=notifications`):
- `GET identity-consent /internal/v1/users/{id}/delivery` → `DeliveryInfo` (§1: для ребёнка адресат — опекун, его
  Telegram ID и блокировка бота) и `GET …/users/{id}/public` → имя пригласившего/принявшего/нового участника семьи.
  Кэш Redis 5 мин (`<prefix>:delivery:<id>`, `<prefix>:public:<id>`), сброс событиями (ниже); 404 → `skipped user_not_found` / текст без имени.
- `POST telegram-bot-gateway /internal/v1/messages` — **внутренний порт** (`BOTGW_URL`, по умолчанию
  `http://127.0.0.1:8108`; Railway: `http://telegram-bot-gateway.railway.internal:8108`), `idempotency_key = notification_id`.

## События
Потребляет (durable consumer, inbox-дедупликация):

| Durable | События | Действие |
|---|---|---|
| `notifications.learning` | `learning.reminder.due.v1` | `lesson.reminder` (ребёнку — `.kid`), `reminders`, ключ `reminder:<user>:<date>`; позже слота + 3 ч — только центр |
| | `learning.session.missed.v1` | `lesson.missed(.kid)`; `consecutive_missed ≥ 4` — `lesson.comeback(.kid)` не чаще раза в 7 дней (`missed_state`, иначе без записи); `missed`, ключ `missed:<user>:<date>`; отправка не раньше слот-времени следующего дня, после 22:00 следующего дня — только центр |
| `notifications.social` | `social.invite.accepted.v1` | `invite.accepted` → пригласившему (имя принявшего), `social`, ключ `invite.accepted:<invite>:<invitee>`; для `family` — `family.joined:<inviter>:<invitee>` (общий с `family.joined`, без двойного сообщения владельцу) |
| | `social.invite.declined.v1` | `invite.declined` → пригласившему, **только центр**, категория не проверяется («—» в §4), без имени |
| | `social.invite.reminder_due.v1` | `invite.pending` → получателю (имя пригласившего, кнопка `invite_<invite_id>`), ключ `invite.pending:<invite>:<invitee>` — одно |
| | `social.family.member_added.v1` | `role=owner` — проекция владельца семьи (`family_owners`); `child` — без сообщения (добавил сам родитель); `adult`/`teen` → `family.joined` владельцу, ключ `family.joined:<owner>:<member>`; владелец неизвестен → без сообщения (WARNING) |
| `notifications.support` | `support.ticket.replied.v1`, `support.ticket.status.changed.v1` (→ RESOLVED) | `support.reply` / `support.resolved` (`support` — всегда включена), кнопка `ticket_<number>`; текст ответа в уведомление не кладётся |
| `notifications.product` | `experience.release_note.published.v1` | сохраняется в `broadcasts`; запись центра (`release_note.published`, `product`, `in_app_only`) создаётся ученику при чтении центра — см. «Что нового» |
| `notifications.catalog` | `catalog.media_request.decided.v1` (спринт 3, только от `catalog`: от другого издателя — WARNING без `user_id`, без записи) | `media_request.decided` → ученику, `support` (всегда включена), ключ `media_request.decided:<request>:<status>` (повтор того же решения — без дубля, изменённое решение — новое сообщение); дальше — общая политика (выключатель, тихие часы, правила детей 6–13, хотя заявки бывают только у аккаунтов 14+). Название заявки в журнал (лог) не пишется |
| `notifications.assessment` | `assessment.appeal.decided.v1` (спринт 4, только от `assessment`: от другого издателя — WARNING без `user_id`, без записи) | `appeal_decided` → ученику (ребёнку 6–13 — `appeal_decided.kid` опекуну), `support` (всегда включена), ключ `appeal_decided:<appeal_id>` — **одно уведомление на апелляцию** (повтор события и повторная публикация — без дубля); параметры — только `appeal_id`, `evaluation_id`, `decision`; текст решения сотрудника не принимается; дальше — общая политика (выключатель, тихие часы, окно детей) |
| `notifications.user_deleted` | `user.deletion.requested.v1` (только от `identity-consent`, ревью P-7: от другого издателя — предупреждение в логе с типом события и издателем, без `user_id`; подтверждение шине без удаления и без ACK) | `deleted_users` + удаление журнала/центра ученика, записей других учеников с его именем (`subject_user_id`), `missed_state`, `inbox_state`, проекции семьи, кэшей → `user.domain.deleted.v1 {domain: notifications, mode: deleted}`; запоздавшие события для удалённого — без записи |
| `notifications.delivery_cache` | `user.status.changed.v1`, `consent.revoked.v1`, `user.notification_settings.changed.v1`, `user.profile.updated.v1` | сброс кэша адресации и имени |

Публикует: `notification.delivered.v1` (отправлено), `telegram.delivery.failed.v1 {reason: blocked|invalid_chat|rate_limited|error}`
(конечная неудача, в т.ч. блокировка бота — запись при этом остаётся в центре), `user.domain.deleted.v1`,
`admin.audit.recorded.v1` (outbox, в транзакции изменения; `source` = notifications): `template.version_created |
activated | reset | test_sent` (object_type `notification_template`, object_id — ключ), `campaign.created | updated |
scheduled | unscheduled | stopped | finished | failed | test_sent` (object_type `campaign`; `finished` и `failed` —
`actor_type=system`).
Тексты шаблонов и рассылок в аудит не пишутся; тестовый получатель — только индекс.

## Политика (в момент отправки, порядок §4)
Приём только создаёт запись (`telegram_status=scheduled`, `scheduled_for=now`); обработчик журнала берёт свежий
`DeliveryInfo`, отрисовывает title/body на языке ученика (для центра) и решает (`domain/policy.py`):

0. статус не `ACTIVE` → `skipped user_inactive` (кроме кода PIN);
1. **категория** не включена (`support`/`service` — всегда; у `invite.declined` не проверяется) → `skipped category_disabled` — ни Telegram, ни центра;
   «только центр» (`invite.declined`, «Что нового») → `in_app_only center_only`; устарело (`stale_after`) → `in_app_only stale`;
2. **общий выключатель** `notifications_enabled=false` → `in_app_only`; нет адреса Telegram → `in_app_only no_recipient`;
   пропуск ждёт `not_before` (слот следующего дня);
3. **тихие часы** (часовой пояс ученика, окно через полночь) → отложить до конца (`scheduled`, `scheduled_for`);
4. **дети 6–13** (`kind=child` или `is_minor` и `age_band` 6-9/10-13) → окно 08:00–20:00 местного (иначе до 08:00),
   адресат — опекун (`recipient_telegram_user_id`), шаблон `*.kid` с именем ребёнка;
5. **лимит** ≤ 3 сообщений `reminders`+`missed`+`social` в местные сутки на **ученика** (под advisory-блокировкой
   ученика; засчитываются отправленные и зарезервированные) → сверх — `in_app_only daily_limit`;
6. **дедупликация** — `dedup_key` UNIQUE при приёме.

Отложенное на момент позже `stale_after` сразу уходит только в центр. Повторы: 429 → через `retry_after`;
5xx/сеть/identity недоступен → backoff 30 с, 2 мин, 10 мин, 30 мин, 1 ч; после `MAX_ATTEMPTS` (8) → `failed` + событие.
`TELEGRAM_BLOCKED` → `in_app_only blocked` (код PIN — `failed blocked`); chat not found → `failed invalid_chat`.
После конечного статуса `params` очищаются (CHECK в БД).

## Шаблоны RU/UZ (`templates.py`)
Узбекский — латиница (oʻ/gʻ — U+02BB, тутук — U+02BC). Текст Telegram — `<b>title</b>\nbody`, каждое значение
экранируется; кнопка «Открыть» — `startapp`.

| Шаблон | Категория | Кнопка `startapp` |
|---|---|---|
| `lesson.reminder`, `lesson.reminder.kid` | reminders | `route_home` |
| `lesson.missed`, `lesson.missed.kid`, `lesson.comeback`, `lesson.comeback.kid` | missed | `route_home` |
| `invite.accepted`, `invite.declined`, `family.joined` | social | `route_family` |
| `invite.pending` | social | `invite_<invite_id>` |
| `support.reply`, `support.resolved` | support | `ticket_<number>` |
| `release_note.published` | product | `route_news` |
| `media_request.decided` (спринт 3) | support | `route_media_requests` |
| `appeal_decided`, `appeal_decided.kid` (спринт 4) | support | `route_lessons` |
| `pin.reset_code` (только синхронный HTTP, не в центре) | service | — |

Детские тексты — родителю, с именем ребёнка, мягкие: без «потери серии», «провала», давления (тест
`test_kid_texts_are_soft_and_name_the_child`). PII в текстах — только имя ребёнка родителю и имя
пригласившего/принявшего/нового участника семьи (identity-consent `/public`, без username и Telegram ID).

`media_request.decided` (AT-30): плейсхолдеры `{request_title}` (название из заявки ученика: очищено от управляющих
символов, ≤ 80 символов с «…») и `{decision}` (на языке ученика: authored_alternative — «подобран авторский аналог»,
licensed — «материал лицензирован и добавлен», rejected — «заявка отклонена», duplicate — «такая заявка уже есть»).
Комментарий сотрудника (`decision_note`) в уведомление не кладётся — его нет в событии, ученик читает его на экране
заявок в Mini App (как текст ответа поддержки). Детского варианта нет.

`appeal_decided` (спринт 4, AT-47): решение по апелляции на оценку урока, два варианта — upheld «Мы проверили вашу
оценку урока: оценка верна.» / corrected «Мы проверили вашу оценку урока: оценка исправлена, посмотрите обновлённый
результат.» (UZ: «Dars bahongizni tekshirdik: baho toʻgʻri.» / «…: baho tuzatildi, yangilangan natijani koʻring.»),
кнопка «Открыть уроки» / «Darslarni ochish» → `route_lessons`. Плейсхолдер `{appeal_result}` («оценка верна» /
«оценка исправлена» на языке ученика). Текст решения сотрудника (`decision_note`) не включается — его нет в событии,
ученик читает его в Mini App на экране оценки. Детский вариант `appeal_decided.kid` — родителю, с именем ребёнка
(`{learner_name}`), мягко. Название шаблона — как в INTERNAL_API спринта 4 (`appeal_decided`, через «_»).

## Версии шаблонов (спринт 2)
Код (`templates.py`) — тексты по умолчанию; у редактируемого `TemplateSpec` — `description`, `placeholder_names`,
`placeholders(lang, params, ctx) → dict[str, str]` (значения на языке ученика: «15 минут» / «15 daqiqa», имена
очищены; неизвестное имя — «Ваш ребёнок», «Ваш знакомый» …) и `sample`. Отрисовка: активная версия (кэш процесса
`TEMPLATE_CACHE_TTL_SECONDS` ≤ 30 с, активация и сброс на этой реплике сбрасывают кэш) → подстановка строго из
`placeholders()` (`{{`/`}}` — буквальные скобки), текст экранируется для Telegram, `startapp` и кнопка по умолчанию
(button null) — из кода; ошибка подстановки или хранилище версий недоступно → текст из кода + WARNING. Текст
отрисовывается в момент отправки: отложенная запись уйдёт с текстом, активным на момент отправки; уже отправленные —
со своим. Детские шаблоны (`*.kid`) — отдельные ключи, при сохранении — проверка слов давления (`domain/texts.py`,
тот же список проверяет тексты кода). Плейсхолдера `streak_days` у детских шаблонов нет.

## Тестовая отправка (AT-21)
Только в `ADMIN_TEST_CHAT_IDS` (личные chat id через запятую, > 0) — выбор по индексу; лишние поля тела → 422.
Через bot-gateway (`idempotency_key` = `delivery_id`), «[ТЕСТ] » в заголовке, образцы плейсхолдеров, без записи в
журнал/центр и без лимитов ученика; ≤ `TEST_SENDS_PER_MINUTE` (10) в минуту на сотрудника (Redis; Redis недоступен —
503). Chat id — только в настройке: в ответе маска, в логах и аудите — индекс.

## Рассылки (спринт 2, AT-22)
Категория `product`, kind `campaign`. Маршрут кнопки — из каталога `packages/contracts/release-notes.json`
(`campaigns.ROUTES`; спринт 3 — + `diagnostics`, `plan`, `skills`, `scenarios`, `media`, `media_requests`,
`languages`). Аудиторию отбирает identity-consent (`GET /internal/v1/audience[/count]?ui_lang=&age=&onboarded=&active_days=`,
`age` по умолчанию `adults`). `POST …:dispatch` сначала выполняет шаги рассылок (`campaigns.Runner`, не больше
`CAMPAIGN_MAX_BATCHES_PER_CALL`), затем отправку: 1) `scheduled` с `send_at ≤ now` → `sending`, фиксация
`audience_count` (identity-consent недоступен — запуск при следующем вызове); 2) страницы аудитории по
`CAMPAIGN_AUDIENCE_PAGE` (500) с курсором в `campaigns.cursor` (сравнение-и-запись — повтор и параллельный вызов
безопасны) → `campaign_recipients pending`; 3) пачки по `CAMPAIGN_RECIPIENT_BATCH` под блокировкой строки рассылки
и advisory-блокировками учеников: `created` по другой рассылке за `CAMPAIGN_MIN_INTERVAL_DAYS` (7) →
`skipped_frequency`, удалён → `cancelled`, иначе запись журнала (dedup `campaign:<id>:<user>`, детерминированный
id) → `created`; 4) аудитория исчерпана → `done` + аудит `campaign.finished`. Запись рассылки проходит общую
политику (категория `product` перепроверяется, выключатель, тихие часы по поясу ученика → отложить); тексты — из
`campaigns` на момент отправки, `{learner_name}` — имя ученика (нет — пусто, пробелы схлопываются), кнопка —
`route_<route>`. Защита в глубину при отправке: остановлена → `cancelled campaign_stopped`; дети 6–13 →
`skipped kid_excluded`; возраст/язык вне сегмента (подросток без `teens`, без `age_band`) → `skipped
segment_mismatch`. Статистика: `created`/`skipped_frequency` — по получателям, `sent`/`in_app_only`/`failed` — по
журналу, `deferred` — `scheduled` с причиной `quiet_hours`.

«Отправить сейчас» (QA D2-03): шаг 1 выполняет сама команда `schedule`, а фоновая задача (`campaigns.StartNow`)
сразу после коммита — первые `CAMPAIGN_START_NOW_BATCHES` (1) пачки шагами 2–3 и, если всё обработано, шаг 4; она
будит обработчик журнала сервиса, поэтому первые сообщения уходят без ожидания `:dispatch`. Параллельный `:dispatch`
безопасен (те же блокировки). Ошибка фоновой пачки не влияет на ответ: код — в `last_error`; задачи отменяются при
остановке сервиса, остаток доводит `:dispatch`. `CAMPAIGN_START_NOW_BATCHES=0` — только запуск.

Ревью P2-7: неудача шага запуска или выборки аудитории (`SEGMENT_INVALID`, `INVALID_CURSOR`, `UPSTREAM_UNAVAILABLE`,
`AUDIENCE_RESPONSE_INVALID` …) → `Campaign.last_error {code, since, attempts}` (рассылка остаётся в своём статусе,
повтор при следующем `:dispatch`); первый успешный шаг (страница аудитории, пачка получателей), `schedule` и
`unschedule` сбрасывают. На
`CAMPAIGN_FAILURE_ALERT_ATTEMPTS` (6) неудач подряд — аудит `campaign.failed` (один раз на серию) и ERROR в логе.
Ревью P2-8: лимит частоты считает только получателей другой рассылки, чья запись журнала `sent | in_app_only |
scheduled` (дошла или в пути); `skipped`, `failed`, `cancelled` в лимит не идут.

## «Что нового» в центре
`experience.release_note.published.v1` без адресатов: заметка хранится в `broadcasts`; при чтении центра
(`inbox`, `unread-count`, `inbox:read`) ученику создаются записи по заметкам, полученным после его водяного знака
(`inbox_state`): статус `ACTIVE`, категория `product` включена, `audience` `existing|all`, сегменты `age`
(kids/teens/adults) и `ui_lang`. Первое чтение центра ставит знак на «сейчас» (старое показывает «Что нового»).
Telegram-рассылки нет (кампании — спринт 2).

## Данные
Схема `notifications` (миграции 0001–0003): `notifications` (`notification_id` PK, `user_id` — ученик, `category`,
`kind standard|transactional|campaign`, `template`, `params` JSONB, `subject_user_id`, `title`, `body`, `startapp`,
`dedup_key` UNIQUE, `telegram_status scheduled|sent|in_app_only|failed|skipped|cancelled` (cancelled — рассылка
остановлена; в центре не видна), `reason`, `center_only`,
`not_before`, `stale_after`, `scheduled_for`, `attempts`, `limit_day`, `sent_at`, `telegram_message_id`, `read_at`,
`source_event_id`, `created_at`, `updated_at`; CHECK: `params` только у `scheduled`, у `scheduled` есть
`scheduled_for`), `deleted_users`, `missed_state (user_id, last_notified_date)`, `family_owners (family_id → owner)`,
`broadcasts`, `inbox_state`, `outbox`, `inbox`; спринт 2: `notification_template_versions` (PK (key, version),
`status draft|active|archived`, `texts` JSONB, `note`, `created_by/at`, `activated_by/at`, `archived_at`,
`idempotency_key` + `request_hash`; частичные уникальные индексы — одна активная на ключ, ключ идемпотентности на
сотрудника), `campaigns` (поля `Campaign`, `segment`/`texts` JSONB, `version`, `cursor`, `audience_complete`,
`audience_count`, идемпотентность создания; 0003 — серия неудач `error_code`, `error_since`, `error_attempts`,
`error_reported`), `campaign_recipients` (PK (campaign_id, user_id), `status
pending|created|skipped_frequency|cancelled`, `notification_id`, `processed_at`; удаляются сагой удаления ученика). Срок хранения журнала/центра — 90 дней (`RETENTION_DAYS`, чистка в
`:dispatch`). Telegram ID в БД не хранится (только кэш Redis 5 мин). Модели — зеркало миграций
(`tests/test_notifications_schema.py`).

## Обработчик журнала
`runtime.spawn` при старте (`DISPATCHER_ENABLED`): `run_once` — захват пачки `scheduled` с `scheduled_for ≤ now`
(`FOR UPDATE SKIP LOCKED` + аренда `LEASE_SECONDS` — безопасно для реплик, падения процесса и параллельного
`:dispatch`), отрисовка, политика, отправка, статус и событие. Будится после коммита новой записи, иначе опрос раз в
`DISPATCH_INTERVAL_SECONDS`. n8n `notifications-dispatch` — страховка (отложенные, повторы).

## Переменные окружения
`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_URL`, `NATS_URL`, `IDENTITY_CONSENT_URL`, `BOTGW_URL`,
`SCHEDULER_TOKEN` (в stage/prod — пусто, т. е. вход выключен, или ≥ 32 символов; ревью P-8), `INTERNAL_JWT_PRIVATE_KEY` + `INTERNAL_JWT_PUBLIC_KEYS` (stage/prod), `DEFAULT_TIMEZONE`
(Asia/Tashkent), `DAILY_LIMIT` (3), `REMINDER_STALE_HOURS` (3), `MISSED_STALE_TIME` (22:00), `COMEBACK_MIN_DAYS` (7),
`KID_WINDOW_START`/`KID_WINDOW_END` (08:00/20:00), `RETENTION_DAYS` (90), `DELIVERY_CACHE_TTL_SECONDS` (300).
Спринт 2: `ADMIN_TEST_CHAT_IDS` (chat id через запятую; пусто — тест недоступен), `TEST_SENDS_PER_MINUTE` (10),
`TEMPLATE_CACHE_TTL_SECONDS` (30, ≤ 30), `CAMPAIGN_MIN_INTERVAL_DAYS` (7), `CAMPAIGN_AUDIENCE_PAGE` (500),
`CAMPAIGN_RECIPIENT_BATCH` (200), `CAMPAIGN_MAX_BATCHES_PER_CALL` (50), `CAMPAIGN_MAX_SCHEDULE_DAYS` (30),
`CAMPAIGN_ASAP_SECONDS` (60), `CAMPAIGN_PAST_TOLERANCE_SECONDS` (300), `CAMPAIGN_FAILURE_ALERT_ATTEMPTS` (6),
`CAMPAIGN_START_NOW_BATCHES` (1).

## Runbook
- Тесты: `infra/dev/stack.sh up`, `source .dev/testenv.sh`, `uv run pytest services/notifications -q`
  (identity-consent и bot-gateway — `httpx.MockTransport`; `test_notifications_e2e.py` — настоящее внутреннее
  приложение bot-gateway).
- Сообщение не пришло: строка журнала по `dedup_key` → `telegram_status`/`reason` (`category_disabled`,
  `notifications_disabled`, `quiet_hours`, `kid_window`, `daily_limit`, `stale`, `blocked`, `identity_unavailable` …).
- Застряли `scheduled` с прошедшим `scheduled_for`: проверить `notifications-dispatch` в n8n и логи
  `dispatcher iteration failed` (в журнал — только тип ошибки).
- Новый текст шаблона не применился: `notification_template_versions` (`status=active` по ключу); другие реплики
  подхватят не позже `TEMPLATE_CACHE_TTL_SECONDS`; WARNING `template version render failed, code text used` —
  версия не подставилась (плейсхолдер убран из кода) — активировать исправленную версию или сбросить.
- Рассылка висит в `scheduled`/`sending`: шаги идут только в `:dispatch` (n8n); причина — `last_error` в карточке
  рассылки и `campaign step failed` в логе (`error_code`); после 6 неудач — аудит `campaign.failed`.
  `campaigns.cursor`/`audience_complete` показывают прогресс выборки. Экстренно — `stop`.
- Тестовая отправка: `test-recipients` пуст — не задан `ADMIN_TEST_CHAT_IDS`; `sent=false` с кодом bot-gateway
  (`TELEGRAM_BLOCKED` — тестовый чат не начал диалог с ботом), поиск по `delivery_id` в логах.

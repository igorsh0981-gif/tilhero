# Спринт 2 — независимое ревью Python-части

Дата: 18.11.2026 · Ревьюер: независимый агент (код не писал и не правил) · Ветка `sprint/2-admin`, HEAD `df2a879`, база `bbbb4ba` (изменения спринта: 07d8741, 4165c5c, df2a879).
Объём: `services/admin-identity`, `services/user-admin` (новые); изменения спринта в `services/{identity-consent, notifications, experience-config, support, audit, learning-plan}`; `packages/py-common` (settings); `infra/railway/setup.py`, `infra/n8n/workflows/user-admin-reconcile.json`, `infra/scripts/gen_event_schemas.py`.
Эталоны: `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md` (§2, §8), `docs/sprint2/PLAN.md`, `docs/sprint2/INTERNAL_API.md`, `packages/contracts/src/admin.ts`, `packages/contracts/events/*.schema.json`.

Шкала: 🔴 блокирует мерж · 🟡 исправить до релиза · 🟢 можно позже. Каждая 🟡 подтверждена воспроизведением (тест или скрипт) и точной ссылкой на код. Уверенность: ✅ подтверждено кодом и прогоном; предположения помечены словом «вероятно».

```
ИТОГ РЕВЬЮ (HEAD df2a879)
═══════════════════════════════════════════
🔴 0 · 🟡 3 · 🟢 5

🟡 P2-1  four-eyes: автор создания привилегированного сотрудника получает его временный пароль и
         входит под ним до и после согласования. Второй голос оказывается у одного человека.
         Воспроизведено: «призрак» согласовал заявку своего же автора (users.sensitive.read для роли support).
🟡 P2-2  four-eyes: отключить super_admin можно только по заявке, а включить обратно — одной командой
         любого super_admin (PATCH status=ACTIVE → 200, роль super_admin сохраняется).
🟡 P2-3  user-admin, подростки 14–17: блок «Согласие» в карточке подменяется записью родителя (все цели
         политики). После отзыва родителем карточка пишет «отозвано», хотя своё согласие подростка
         действует. Снимок identity этого не исправляет: версии считаются по разным часам.

Вердикт: мерж в main возможен, 🔴 нет. P2-1 и P2-2 — обходы four-eyes злонамеренным super_admin.
         До второго super_admin они не эксплуатируются, но закрыть их нужно до релиза.
         Для P2-1 нужна правка admin.ts (кому выдаётся временный пароль). P2-3 — неверные данные
         о согласии несовершеннолетнего на экране поддержки.
```

## Прогоны

| Что | Результат |
|---|---|
| pytest (стенд PG/Redis/NATS, `source .dev/testenv.sh`) | ✅ admin-identity 82, user-admin 63, identity-consent 362, notifications 228, experience-config 153, support 57, audit 14, learning-plan 79; py-common + `infra/railway` + `infra/scripts` + `infra/n8n` 198 (+1 skip). Все зелёные |
| `ruff check` (все пакеты объёма) | ✅ чисто |
| `mypy <svc>/src` (8 сервисов + py-common) | ✅ без ошибок |
| Сверка моделей и миграций, роли без DDL | ✅ тесты `schema_drift` и `migrated_under_roles` есть в admin-identity (`test_aid_security.py:211`) и user-admin (`test_user_admin_schema.py`); проходят |
| Мои воспроизведения | `/tmp/rv2/aid_t/test_review_four_eyes.py` (P2-1), `/tmp/rv2/aid_t/test_review_reenable.py` (P2-2), `/tmp/rv2/ua_t/test_review_teen_consent.py` (P2-3) — каждое показывает дефект. Логи — `/tmp/rv2/logs/` |

**Нагрузка (100 тыс. учеников)**. Скрипты: `/tmp/rv2/scripts/ua_perf.py`, `/tmp/rv2/scripts/aud_perf.py`, `/tmp/rv2/notif_t/test_review_campaign_perf.py`, `/tmp/rv2/ua_t/test_review_reconcile_perf.py`.

| Операция | Объём | Время |
|---|---|---|
| user-admin `GET /learners`: без фильтров, часть имени (~5 % совпадений), `@username`, фильтры | 100 тыс. строк (10 тыс. детей) | 2,5–8 мс |
| то же, `q` без совпадений (seq scan, нет триграммного индекса) | 100 тыс. | 63 мс (EXPLAIN 110 мс) |
| user-admin `stats` (дашборд) | 100 тыс. | 73 мс |
| identity `/audience/count` | 100 тыс. users + consents + activity | 42–90 мс |
| identity `/audience` страница 500; полный проход 41 тыс. | то же | ≤ 96 мс; 1,7 с |
| notifications: шаги рассылки в одном `:dispatch` (бюджет 50 шагов) | аудитория 20 тыс. | 4 вызова, худший 5,1 с. 100 тыс. ≈ 14 вызовов ≈ 70 мин при n8n раз в 5 мин |
| список рассылок (20 на страницу, `stats_for`) / одна рассылка / summary | 10 рассылок × 50 тыс. получателей | 398 / 127 / 110 мс |
| `stop` рассылки (треть записей ещё `scheduled`) | 50 тыс. | 1,3 с |
| первая сверка user-admin с identity | 10 тыс. снимков | 48 с (4,8 мс на снимок) → 100 тыс. ≈ 8 мин, см. P2-7 |

Код репозитория не менялся. Все проверочные файлы лежат в `/tmp/rv2/`.

---

## 🟡 До релиза

---
**🟡 P2-1 [Безопасность / four-eyes] Автор создания привилегированного сотрудника знает его временный пароль и входит под ним. Так один super_admin получает второй голос**

📍 `services/admin-identity/src/tilhero_admin_identity/domain/staff.py:85-120`: `create_staff` выдаёт временный пароль автору при любой роли, привилегированной тоже (`:97`, `:120`). `api/staff.py:130-131`: пароль уходит в ответе `StaffCreated`. `domain/approvals.py:203-214`: `_apply` для `staff.create_privileged` и `staff.role_grant` только меняет роль, учётные данные цели остаются прежними. Контракт: `admin.ts:196-198` («Временный пароль показывается ОДИН раз»; кому — автору). Для сравнения: сброс пароля привилегированного сотрудника (N1, `resets.py`, `approvals.py:193-199`) уже выдаёт пароль только решающему — ровно из-за этой угрозы.
🔍 ✅ подтверждено прогоном.

**Сценарий.** Есть два настоящих super_admin, A и B.
1. A создаёт сотрудника `ghost@…` с ролью super_admin. Учётка получает роль-заглушку `read_only`, создаётся заявка PENDING, а временный пароль возвращается автору A.
2. A сразу входит под ghost. Для роли `read_only` MFA не нужна, поэтому A просто меняет пароль на свой.
3. B добросовестно согласует создание: у него нет способа узнать, что учёткой уже владеет A.
4. A снова входит под ghost. Роль теперь привилегированная, поэтому нужно подключить TOTP — A подключает его на свой телефон.
5. Дальше A подаёт любую заявку (матрица прав, роль, сброс чужой MFA), а ghost её согласует. `FOUR_EYES_SAME_PERSON` не срабатывает: формально решают разные учётки.

Пока super_admin один, всё ещё проще: заявка применяется сразу (`waived`), и пароль второго super_admin остаётся у автора. Тот же путь есть у `staff.role_grant`: автор раньше создал сотрудника с непривилегированной ролью (пароль у него) и потом повышает его.

**Воспроизведение:** `uv run pytest /tmp/rv2/aid_t -c pyproject.toml --rootdir /tmp/rv2/aid_t -s` → `/tmp/rv2/logs/aid_four_eyes.txt`:
```
create: 201 approval: staff.create_privileged PENDING temp returned: True
ghost first login by creator: read_only
root2 approve: 200 APPLIED
ghost role after approval: super_admin mfa: True
role change request: 202 PENDING
approved by ghost: 200 APPLIED decided_by: ghost.…@tilhero.test
sole root create: 201 APPLIED single_super_admin role now: super_admin temp to author: True
```

**Рекомендация.** При применении `staff.create_privileged` и `staff.role_grant` (а также при `waived`) делать то же, что N1 делает со сбросом:
- выпускать новый временный пароль и отдавать его решающему (`ApprovalDecision.temporary_password`);
- сбрасывать MFA и `session_version`.

При создании привилегированного сотрудника автору `temporary_password: null` (поменять `admin.ts`, admin-bff, admin-web). Для `role_grant` минимум — сброс MFA и пароля цели при применении. Так тот, кто знал прежние учётные данные, теряет доступ. Добавить регресс-тест «автор входит под целью → после согласования не может».

---

---
**🟡 P2-2 [Безопасность / four-eyes] Отключённого по заявке super_admin любой другой super_admin включает обратно одной командой**

📍 `services/admin-identity/src/tilhero_admin_identity/domain/staff.py:133-135`: заявку требует только понижение или `DISABLED` super_admin (`revoke`). `:154-158`: `status=ACTIVE` применяется сразу (`apply_status`), роль не меняется. `is_privileged` для включения не проверяется вообще (`:137-145` смотрят только `role_change`).
🔍 ✅ подтверждено прогоном.

**Сценарий.** A и B по four-eyes (`staff.privileged_revoke`) отключили super_admin C: уволен или подозревается во взломе. Потом A один делает `PATCH /staff/C {status: ACTIVE}` → 200. C снова super_admin со своим прежним паролем и TOTP. Решение двух человек отменено одним, без заявки. Поможет ли аудит (`staff.updated`), зависит от того, смотрит ли его кто-нибудь. Так же включаются отключённые operations и communications — привилегированные роли без четырёх глаз.

**Воспроизведение:** `/tmp/rv2/aid_t/test_review_reenable.py` → `/tmp/rv2/logs/aid_reenable.txt`:
```
disable request: 202 staff.privileged_revoke
disable approved: APPLIED
status: DISABLED super_admin
re-enable by root alone: 200 ACTIVE super_admin
```

**Рекомендация.** Перевод `DISABLED → ACTIVE` сотрудника с привилегированной ролью (`is_privileged`) — только заявкой: новая `staff.reactivate_privileged` или `staff.role_grant` с `from_status`. Без исключения `waived`, если автор недавно отключал или понижал super_admin (как `revoked_super_admin_recently`). При применении сбрасывать пароль и MFA (см. P2-1). Разблокировку счётчиков входа для уже ACTIVE (`login_attempts_reset`) оставить прямой командой.

---

---
**🟡 P2-3 [Корректность / подростки, согласия] user-admin: у подростка 14–17 карточка показывает согласие родителя вместо своего, а после отзыва родителем — «согласие отозвано», хотя своё согласие подростка действует**

📍 `services/user-admin/src/tilhero_user_admin/domain/projection.py:333-344`: `_apply_consent_accepted` перезаписывает блок любым `consent.accepted.v1`, в том числе `basis=guardian`. `:347-361`: `_apply_consent_revoked` закрывает блок, если основание совпадает с текущим.

identity-consent:
- `service.py:975-992`: согласие родителя — запись `basis=guardian` со всеми целями политики (`:987`, «родитель разрешает функции»), событие `consent.accepted.v1`;
- `service.py:1068-1077`: при отзыве собственное согласие подростка сужается молча, события нет; выпускается только `consent.revoked.v1 {basis: guardian}` (`:1080-1085`);
- `admin.py:126-127`: снимок для аккаунта всегда берёт своё согласие (`basis=self`).

Почему снимок не исправляет: версия снимка — `users.updated_at = now()` транзакции (`service.py:333-345`), то есть её начало. `occurred_at` события той же транзакции всегда позже, поэтому `projection.py:533` (`_newer(v, consent_at)`) снимок отбрасывает.
🔍 ✅ подтверждено прогоном.

**Сценарий.** Подросток принял политику сам (`terms`, `privacy`), родитель разрешил, потом отозвал. Оператор поддержки открывает карточку (AT-23, «согласия»):
- после разрешения: `basis: guardian`, цели `terms, privacy, voice_recording, social, product_news`. Получается, подросток «согласился» на запись голоса и новости, хотя сам их не выбирал;
- после отзыва: `revoked_at` заполнен. Получается, согласия нет, хотя обучение идёт по действующему согласию подростка.

Ошибка держится до следующего изменения согласия. Оператор может сообщить родителю или подростку неверное правовое основание обработки данных несовершеннолетнего.

**Воспроизведение:** `/tmp/rv2/ua_t/test_review_teen_consent.py` → `/tmp/rv2/logs/ua_teen_consent.txt`:
```
1) снимок identity: {... 'purposes': ['terms', 'privacy'], 'revoked_at': None, 'basis': 'self'}
2) после согласия родителя, карточка: {... 'purposes': ['terms','privacy','voice_recording','social','product_news'], 'revoked_at': None, 'basis': 'guardian'}
3) после отзыва родителем, карточка: {... 'revoked_at': '2026-11-18T…Z', 'basis': 'guardian'}
```

**Рекомендация.**
1. В проекции для `kind=account` принимать в блок `consent` только `basis=self`, как в снимке identity. Решение родителя уже видно по `guardian_consent` из `user.profile.updated.v1`.
2. identity при сужении своего согласия подростка (`:1077`) выпускать `consent.accepted.v1 {basis: self}` с новыми целями.
3. Сравнивать версии по одним часам: в снимке отдавать `clock_timestamp()` или время коммита, либо считать снимок авторитетным при `v ≥ consent_at − допуск`.
4. Добавить тест: принятие и отзыв родителем у подростка, затем карточка равна снимку identity.

---

## 🟢 Можно позже

---
**🟢 P2-4 [Защита в глубину] Step-up проверяет только admin-bff: домен не может отличить команду с повторным TOTP от команды без него**

📍 `packages/py-common/src/tilhero_common/internal_auth.py:119-122, 166-169`: в actor-токене только `{id, role, name, permissions}`. Во всех доменах step-up отмечен комментарием «проверяет admin-bff»: `experience-config/api/release_notes.py`, `notifications/api/staff.py:168`, `api/campaigns.py:311`, `identity-consent/api/admin.py:70-82`, `admin-identity/api/staff.py:1-3`.
**Почему важно:** контракт это допускает (INTERNAL_API §4). Но права домен проверяет сам, а step-up нет. Если в одном из ~15 маршрутов admin-bff пропустить step-up, раскрытие Telegram ID, активация шаблона или запуск рассылки пройдут без TOTP, и домены этого не заметят.
**Рекомендация:** admin-bff кладёт в actor-токен `step_up_until` (или `amr: ["otp"]` + время). Домены проверяют его на командах из шапки `admin.ts` общим помощником `principal.require_step_up()`.
---

---
**🟢 P2-5 [Данные / аудитория рассылок] Проекции «онбординг» и «последнее занятие» не заполняются для старых учеников: история старше 7 дней не попадает ни в identity, ни в user-admin**

📍 `services/identity-consent/migrations/versions/0004_admin_audience.py`: `learner_activity` создаётся пустой, бэкфилла нет. `activity.py`: наполнение только событиями. `packages/py-common/.../messaging/bus.py:168, 232`: новый durable-потребитель с `DeliverPolicy.ALL` получает только хранимые 7 дней потока. То же для `last_activity_at` в user-admin: `projection.py:291-294`, сверка с learning-plan даёт только онбординг.
**Сценарий:** ученик прошёл онбординг и занимался больше чем за 7 дней до выкладки спринта 2. Для аудитории он «не прошёл онбординг» и «не занимался никогда»: сегмент `onboarded=true` его исключит, `onboarded=false` и `active_days=-30` включат. В дашборде он не учтётся как активный. Prod развёрнут 18.11, поэтому при выкладке до 25.11 все события ещё в потоке. Позже это станет 🟡.
**Рекомендация:** одноразовый бэкфилл (learning-plan `GET /admin/v1/plans` даёт `onboarding_completed_at`; последнее занятие — новый внутренний эндпоинт или скрипт) либо явная дата выкладки до 25.11 в DEPLOYMENT.md.
---

---
**🟢 P2-6 [Производительность] Первая сверка user-admin — N+1 на снимок: 100 тыс. учеников ≈ 8 мин, две из трёх соединений пула заняты**

📍 `services/user-admin/src/tilhero_user_admin/domain/sync.py:118-128`: страница из 500 снимков — одна транзакция, на каждый снимок `apply_snapshot`. `projection.py:149-169` (`lock_summary`: INSERT … ON CONFLICT, SELECT … FOR UPDATE, для новой строки ещё 2 запроса счётчиков) и UPDATE при flush. `settings.py:13-14`: пул 2 + 1. `sync.py:68, 99`: `asyncio.Lock` действует внутри процесса. `infra/n8n/workflows/user-admin-reconcile.json`: таймаут 300 с, 3 попытки.
**Замер:** 10 тыс. снимков — 48 с (4,8 мс на снимок), транзакция страницы ≈ 2,4 с под блокировкой 500 строк. Сверки identity и plans идут параллельно и занимают 2 соединения. Потребитель событий и карточки ждут третье. Вызов n8n ждёт локальную блокировку, получает таймаут и повторяется. На второй реплике сверка идёт параллельно и делает ту же работу.
**Рекомендация:** пакетный upsert страницы (`INSERT … ON CONFLICT DO UPDATE … WHERE версия новее`, один запрос счётчиков на страницу); страница 200; межрепликовая блокировка `pg_try_advisory_lock`, как у plan:tick.
---

---
**🟢 P2-7 [Рассылки / эксплуатация] Застрявшая рассылка не видна сотруднику; «стоп» переводит в `stopped` даже черновик и завершённую**

📍 `services/notifications/src/tilhero_notifications/campaigns.py:591-601`: `start_due` при 422 `SEGMENT_INVALID` пишет `log.error` и оставляет `scheduled` навсегда, повтор каждые 5 мин. `:638-643`: `fetch_page` при любой ошибке identity, включая 400 `INVALID_CURSOR` после смены формата курсора, отвечает `idle` и оставляет `sending` навсегда. В `Campaign` нет поля ошибки. `:494-497`: `stop` не проверяет статус, `draft → stopped` и `done → stopped`.
**Сценарий:** после выкладки identity с другим курсором рассылка навсегда в «Отправляется». Сотрудник видит только неизменную статистику, сигнал есть только в логах.
**Рекомендация:** счётчик неудачных шагов и `last_error` в `campaigns` (в `Campaign`: `stalled_since`/`error_code`). После N неудач аудит `campaign.failed`. `stop` разрешать для `scheduled|sending` и, по решению владельца, для `done` с ещё отложенными записями. `draft` → 409.
---

---
**🟢 P2-8 [Рассылки / частота] Лимит «1 рассылка в 7 дней» считает и недоставленные записи**

📍 `services/notifications/src/tilhero_notifications/campaigns.py:293-308`: `recently_reached` берёт все `campaign_recipients.status='created'`, независимо от судьбы записи журнала. Запись могла уйти в `skipped` (категория выключена, ученик неактивен к моменту отправки) или `in_app_only/stale`.
**Сценарий:** ученик выключил «Новости» за минуту до отправки рассылки A: запись `skipped`, ничего не получил. Включил обратно — рассылка B через 3 дня его пропускает (`skipped_frequency`). Это безопасная сторона: лишнего не уходит.
**Рекомендация:** при `skipped` записи рассылки переводить получателя в отдельный статус (`suppressed`), не участвующий в лимите, или считать лимит по `notifications.telegram_status IN ('sent','scheduled')`.
---

## Отклонения от контракта (без оценки серьёзности)
- **AT-23 «Telegram ID и имя маскированы»** против `admin.ts:278-284` и кода: `display_name` и `username` (в том числе имена детей 6–13) отдаются полностью всем ролям с `users.read` (support, methodist, analyst, operations). Маскируется только Telegram ID. Нужно решение владельца и правка AT-23 или контракта (маска имени + reveal `display_name`).
- **AT-22 и `admin.ts:893` «в местное время ученика»**: рассылка уходит всем в одно мгновение `send_at`, сдвиг только у тех, у кого тихие часы. Локального расписания по поясам нет. Для учеников в Asia/Tashkent разницы нет.
- **INTERNAL_API §2**: поиск `TCK-NNNN` идёт по своей проекции `ticket_refs`, а не через support `GET /admin/v1/support/tickets/{number}`. Поведение то же, право `support.read` проверяется (`queries.py:176-181`). Поправить текст контракта.
- **INTERNAL_API §3 «audit»**: `admin-identity` — HTTP-писатель без ограничения действий (`audit/api/routes.py`, `WRITERS`, нет `ONLY_ACTIONS`), хотя пишет только через outbox. Право не используется — сузить или убрать.
- **`admin.ts:196-198`**: для P2-1 временный пароль при создании привилегированного сотрудника нужно отдавать решающему, а не автору.

## Проверено — замечаний нет
- **Вход и блокировка.** 5 неудач → 423 на 15 мин, ключ — HMAC-SHA256(email), ключ HKDF от `ADMIN_MFA_ENC_KEY`; для существующих и несуществующих учёток одинаково, фиктивный argon2 (`auth.py:194-235`). Попытка занимается до проверки пароля одним Lua-скриптом, залп не превышает лимита (`test_parallel_burst…`). Аудит неудач агрегирован. Пароль, коды, challenge и id сессии в логи и аудит не попадают (`test_no_secrets_in_logs_or_audit`). Ошибка конфигурации не печатает значения (`hide_input_in_errors`, в том числе в py-common). Перебор по IP режет admin-bff (`adm.login_ip` 10/мин).
- **TOTP.** RFC 6238, окно ±1, шаг ≤ `mfa_last_step` отвергается под `FOR UPDATE` строки сотрудника (`crypto.py:109-118`, `auth.py:178-191`), общий счётчик вход/подключение/step-up 5 → 15 мин. Код строго `^[0-9]{6}$` (юникод-цифры не дойдут до `compare_digest`). Секрет — AES-256-GCM, AAD = `staff_id`, версия в префиксе (`crypto.py:130-147`), ключ обязателен в stage/prod. Challenge хранится только хешем, TTL 5 мин, одноразовый, привязан к шагу и `session_version`.
- **Bootstrap.** Только без активного super_admin, под advisory-lock, пароль по правилам, `must_change_password`, срок 72 ч, перевыпуск только пока эта учётка — единственный super_admin и ни разу не входила (`auth.py:443-506`).
- **Four-eyes, кроме P2-1/P2-2.** Самоодобрение → 409 `FOUR_EYES_SAME_PERSON`. Решает только super_admin по БД. Права = токен ∩ роль из БД: суженный токен (dev-имперсонация) не решает и не расширяет (`store.py:136-143`, `test_approval_decision_respects_narrowed_token`). Последний super_admin защищён при снятии, отключении и применении заявки. Одна PENDING на объект (частичный UNIQUE). Заявки отключённого автора отклоняются. Эскалация через `staff.manage` к правам шире своих → 403. Встречные заявки на отключение друг друга не оставляют систему без super_admin (проверено по `_apply` + `reject_pending_of`).
- **Права в доменах (защита в глубину).** Каждый staff-маршрут user-admin, identity (reveal), notifications, experience-config, support, audit сам вызывает `require_permission`/`require_any`. Вызывающие перечислены явно: снимки identity и планы learning-plan — только user-admin и без `sub`/actor; аудитория — только notifications без `sub`; reveal — только admin-bff с actor. Actor от других издателей → `ACTOR_NOT_ALLOWED` (py-common).
- **Раскрытие Telegram ID.** Сначала квота 20/ч на сотрудника (Redis, fail closed → 503), затем синхронная запись `sensitive.view` в audit (делегирование только этих двух действий). Без записи — 503 `AUDIT_UNAVAILABLE` и значения нет. Ребёнок → 409, удалённый → 404, `Cache-Control: no-store`. В логах только псевдоним ученика. В user-admin и снимках identity — только маска `••••••789`, `safe_mask` маскирует и полный ID, если он придёт по ошибке.
- **Дети и подростки.** Аудитория (`audience.py:124-144`): только `kind=account`, ACTIVE, возраст выбран, категория `product` и своё действующее согласие `product_news`. Подростки — только при `age=teens` и `guardian_consent=granted`, `kids` → 422 (и в notifications `check_segment`). При отправке защита в глубину: ребёнок и вне сегмента → `skipped`, остановлено → `cancelled` (`dispatcher.py`, `_render_campaign`). Категория `product` у детского профиля и у подростка без согласия родителя отсутствует по построению (`age.py:40-45`, `learner_categories`). Поэтому ни рассылка, ни «Что нового» в центре уведомлений ребёнку не попадают. Тихие часы — общая политика (`decide`). Детские шаблоны `*.kid` при сохранении и активации проходят проверку слов давления.
- **Рассылки.** Повтор и параллельный `:dispatch`: курсор пишется сравнением-и-записью, получатели — PK + ON CONFLICT, записи журнала с детерминированным id, пачка — под `FOR UPDATE` рассылки и блокировками учеников по возрастанию `user_id`. Лимит частоты сериализуется между рассылками блокировкой ученика. Удалённые → `cancelled`. `stop` ждёт текущую пачку и отменяет `pending` и неотправленные записи; уже захваченная запись отменяется при отрисовке. Сбой identity не ломает доставку журнала. Тестовая отправка — только по индексу из `ADMIN_TEST_CHAT_IDS`, «[ТЕСТ] », 10/мин, chat id — только маской.
- **Версии шаблонов.** Одна активная (частичный UNIQUE + advisory-lock ключа). Активация перепроверяет тексты и архивирует прежнюю. Откат к любой версии и `reset`. Кэш ≤ 30 с, на своей реплике сбрасывается сразу. Подстановка строго из словаря (без `str.format`: атрибуты и индексы недоступны). Ошибка подстановки → текст из кода. Telegram-текст экранируется. `startapp` всегда из кода. `pin.*` не редактируются.
- **Read-модель user-admin, кроме P2-3.** Порядок по версиям групп полей, inbox, издатель-владелец каждого события. DELETED конечен: PII, связь с опекуном, план и связь с обращениями стираются (CHECK `ck_learner_deleted_erased`). Пропуск события закрывает сверка (снимок `DELETED`). Курсор списка по неизменному `created_at`.
- **Аудитория: SQL, индексы, границы.** Предикаты совпадают с частичными индексами `ix_users_audience` и `ix_consents_product_news`, план — Merge Join по индексам (`aud_perf.txt`). `active_days`: 1..90 и −1..−90, `0`, `-0` и `91` → 422. `N>0` → `last_activity_at ≥ now−N`; `N<0` → нет строки, `NULL` или раньше `now−|N|`, как в контракте.
- **Миграции.** identity 0004, notifications 0002, experience-config 0005, learning-plan 0002, admin-identity и user-admin 0001 обратимы (downgrade notifications удаляет записи `kind=campaign` до возврата CHECK). Новые роли `admin_identity` и `user_admin` есть в `infra/db/bootstrap.sql`. Изменения применённых миграций нет.
- **Контракты.** Права и роли сида = `PERMISSIONS`/`RoleCode` из `admin.ts` (контрактный тест), матрица = PLAN. Новые поля `learning.plan.updated.v1` (`level_self`, `preset`) — в схеме и генераторе (`gen_event_schemas.py`). Потребляемые user-admin события сверены со схемами.
- **Инфраструктура.** `setup.py`: `ADMIN_MFA_ENC_KEY` (32 байта), временный пароль bootstrap по правилам, admin-bff без публичного домена, n8n → user-admin, JWT-ключи admin-identity и user-admin. `user-admin-reconcile.json`: Bearer `SCHEDULER_TOKEN`, вход сравнивается за постоянное время, внутренний JWT → 403.

# TilHero — архитектура

Источник требований: пакет LinguaFlow Handoff 1.2 (17.11.2026) — описание продукта, функциональные требования приложения (APP-*, 93) и админки (ADM-*, 67), архитектура и 17 агентов, реестр решений; решения заказчика от 17–18.11.2026; согласованный кликабельный прототип TilHero (холст «TilHero — кликабельный прототип»).

Платформа унаследована от проекта «Бот турист» (репозиторий aievent): общие библиотеки, стенд, CI, сервисы аудита, конфигурации интерфейса, уведомлений, согласий и удаления, поддержки, админ-контур. Правила разработки — [CONVENTIONS.md](CONVENTIONS.md), план — [SPRINTS.md](SPRINTS.md).

## Решения заказчика, влияющие на архитектуру
1. **Telegram Mini App + веб-админка.** Отдельного чат-бота нет. Бот Telegram нужен только как транспорт: кнопка «Открыть TilHero», deep link (`startapp`), доставка напоминаний и ответов поддержки. Команд и диалогов нет.
2. **Пользоваться могут все с 6 лет.** 6–13 — детский профиль на аккаунте родителя (у ребёнка нет своего Telegram, ToS Telegram), 14–17 — свой аккаунт и согласие родителя по ссылке, 18+ — сам.
3. **MVP учит только через русский (RU→EN), интерфейс RU и UZ (латиница).** Новая языковая пара — запись в справочнике и контент, без пересборки.
4. **Новости и «Что нового» обязательны.** При первой регистрации — знакомство со всем приложением; при каждом следующем входе — то, что ученик ещё не видел. Тексты, аудитории и публикация — из админки.
5. **График занятий выбирает сам ученик при регистрации:** дни недели (или частота), удобное время и длительность занятия. Поменять можно в профиле.
6. **Напоминания** — о занятии по графику, о пропуске, о приглашениях и ответах других пользователей, о повторениях; с согласием, тихими часами и щадящими правилами для детей.
7. **Логирование, активация конфигурации и откат — как в «Бот турист»:** JSON-логи с trace_id и вычисткой PII, версии конфигурации с активацией и откатом без релиза, append-only аудит с хеш-цепочкой, подтверждение TOTP.
8. **Герои — свои, не пересекаются с конкурентами.** Рост героя — только за навыки, подтверждённые независимым оценщиком.
9. **Деньги (спринт 8, [PLAN](sprint8/PLAN.md)): фримиум + подписка.** Бесплатно — базовый курс, повторения, чтение,
   игра; подписка открывает уроки с ИИ и уроки вдвоём в пределах месячного лимита ИИ-минут. Два разведённых канала:
   **в Mini App — только Telegram Stars** (подписка Telegram и разовые счета), **на отдельном сайте оплаты вне
   Telegram — Payme, Click, Uzum**. Анти-стиринг: Mini App, бот и уведомления не упоминают сайт и не ссылаются на него.
   Для продаж за Stars бот отвечает на `/paysupport`, `/support`, `/terms` и принимает платёжные обновления — других
   команд и диалогов по-прежнему нет. Деньги — целые числа ([ADR-0001](adr/0001-money-integer-minor-units.md)).

## Принципы (как в «Бот турист»)
1. Один bounded context = один независимо разворачиваемый сервис со своей схемой БД и миграциями. Монорепозиторий — только организация исходников.
2. Нет cross-service SQL. У сервиса две роли PostgreSQL (`<svc>_owner` — миграции, `<svc>` — DML).
3. Синхронно — только пользовательские чтения и команды (Mini App → BFF → домены). Асинхронно — напоминания, уведомления, удаление, учёт затрат ИИ.
4. Надёжность: outbox, inbox-дедупликация, Idempotency-Key, retry с backoff, DLQ, circuit breaker к внешним провайдерам.
5. Безопасность: initData проверяется только на сервере; домены доверяют только внутреннему подписанному токену (EdDSA, TTL 60 с); `user_id` только из токена; PII в логах вычищается; ответы моделей и тексты пользователей — недоверенные данные.
6. Дизайн отделён от кода: CSS-слои и токены + Remote Experience Config (тема, секции, флаги) с версиями и откатом.
7. Учебная оценка отделена от игры: XP, тилы, серия и лиги не меняют уровень языка; навык меняет состояние только через независимого оценщика.
8. Учёба не зависит от денег (спринт 8): деньги — отдельный bounded context `billing` со своим реестром (gamification и
   lessons денег не знают); без подписки, при сбое оплаты или недоступности billing базовый курс, повторения, чтение и
   игра работают, урок идёт без ИИ. Деньги, как и игра, не меняют учебную оценку.

## Каталог сервисов

Порт — локальный стенд dev/test. Спринт — когда сервис появляется ([SPRINTS.md](SPRINTS.md)).

### Telegram-контур

| Сервис | Каталог | Стек | Порт | Ответственность | Хранилище | Спринт |
|---|---|---|---|---|---|---|
| telegram-miniapp | apps/telegram-miniapp | React 18 + Vite + TS | 5173 | Mini App: UI, мост Telegram SDK, i18n RU/UZ, темы | — | 1 |
| telegram-bot-gateway | apps/telegram-bot-gateway | Python FastAPI | 8107 (внутр. 8108) | webhook с секретом, `/start` с `startapp`, кнопка меню, доставка сообщений, учёт блокировки бота; спринт 8 — **единственный вызывающий Bot API для Stars** (счета, возвраты, автопродление, выписка — внутренний API для billing), платёжные обновления Telegram → billing, `/paysupport`, `/support`, `/terms` | Redis | 1 |
| telegram-bff | services/telegram-bff | Node 22 Fastify + TS | 8001 | сессия по initData, активный ученик (родитель ↔ ребёнок), агрегация API для Mini App; спринт 8 — `/v1/billing/*` (канал `miniapp`, только Stars) и API сайта оплаты `/web/v1/*` (вход «Log In with Telegram» OIDC + PKCE, cookie-сессия, CSRF; канал `web`) | Redis | 1 |
| identity-consent | services/identity-consent | Python FastAPI | 8101 | аккаунт Telegram, ученики и опекунство, возраст, согласия с evidence, согласие родителя для 14–17, код родителя, настройки уведомлений, сага удаления | PG `identity_consent` + Redis | 1 |
| learning-plan | services/learning-plan | Python FastAPI | 8102 | цель, уровень уверенности, темы, языки интерфейса и объяснений, учебная пара, **график занятий и длительность**, учёт занятий, слоты графика → события «напомнить» и «пропуск» | PG `learning_plan` | 1 |
| support | services/support | Python FastAPI | 8103 | обращения, статусы, SLA, жалобы на оценку (спринт 4) | PG `support` | 1 |
| notifications | services/notifications | Python FastAPI | 8104 | политика доставки (согласие по категориям, тихие часы, правила для детей, лимиты), шаблоны RU/UZ, журнал и **центр уведомлений в приложении**, доставка через bot-gateway | PG `notifications` | 1 |
| audit | services/audit | Python FastAPI | 8105 | append-only журнал с хеш-цепочкой | PG `audit` | 1 |
| experience-config | services/experience-config | Python FastAPI | 8106 | версии темы/секций/флагов с откатом; **«Что нового»**: заметки с аудиторией и сегментами, отметки просмотра | PG `experience_config` + Redis | 1 |
| social | services/social | Python FastAPI | 8109 | приглашения (семья, друг, реферал) по deep link, семья, друзья, ник и код друга, блокировки, жалобы и модерация, рефералы с квалификацией и антифродом (спринт 7) | PG `social` | 1 |

### Деньги (спринт 8)

| Сервис | Каталог | Стек | Порт | Ответственность | Хранилище |
|---|---|---|---|---|---|
| billing | services/billing | Python FastAPI | 8118 | каталог тарифов и товаров с версиями (цены в сумах и в Stars — отдельно), заказы по каналам (`miniapp`, `web`, `renewal`), платёжный контур с адаптерами Telegram Stars / Payme / Click / Uzum (протокол `providers/base.py`, порт `domain/ports.py`), фискальные данные сайта, периоды подписки и подписки Stars, реестр ИИ-минут с удержаниями, возвраты, корректировки «четыре глаза», сверка, отчёты и курсы. Публичного домена нет | PG `billing` |
| web-pay | apps/web-pay | React 18 + Vite + TS за Caddy | 5175 (prod 8080) | сайт оплаты вне Telegram: вход «Log In with Telegram», тарифы и пакеты тилов в сумах, оплата Payme / Click / Uzum, статус и история заказов; строгая CSP без сторонних скриптов; `/api/*` → telegram-bff `/web/v1/*` по приватной сети | — |
| payments-edge | apps/payments-edge | Caddy | 8080 | публичная точка только для колбэков Payme, Click, Uzum (`/pay/*`) → billing `/provider/v1/*` с `X-Edge-Token`; без кода, БД и шины | — |

### Учебный контур

| Сервис | Порт | Ответственность | Спринт |
|---|---|---|---|
| catalog | 8110 | языковые пары, навыки и предпосылки, сценарии (20–30 в MVP), уроки, медиа с правами, публикация версий | 3 |
| diagnostics | 8111 | первичная диагностика, карта навыков `not_started → learning → demonstrated → retained` | 3 |
| lessons | 8112 | урок 20 минут из 5 этапов, оркестратор агентов, состояние урока, минуты; задания дуэли и парные комнаты с ИИ-коучем (спринт 7); режим урока по тарифу, удержание и подсчёт ИИ-минут в billing (спринт 8, флаг `BILLING_ENFORCED`) | 4 |
| assessment | 8113 | независимый оценщик по рубрике и свидетельствам, версии проверки, апелляции | 4 |
| ai-gateway | 8114 | единственная точка вызова LLM / ASR / TTS: квоты, бюджеты, circuit breaker, kill switch; **контроль ИИ** (спринт 8): дневной лимит по тарифу, уровни деградации `normal → economy → paid_only → off`, стоимость урока и ИИ-минуты | 4 |
| tts | 8115 | серверная озвучка (Piper) и распознавание (faster-whisper) | 4.1 |
| memory | 8116 | интервальные повторения, словарь, ошибки, проверки удержания через 7 и 30 дней | 5 |
| gamification | 8117 | XP и уровни, тилы, серия и заморозка, задания, значки, магазин, события, **герои и ступени**; лиги недели и дуэли (спринт 7) | 6 |

### Админ-контур (спринт 2)

| Сервис | Порт | Ответственность |
|---|---|---|
| admin-web | 5174 (prod 8080) | UI админки за Caddy, единственная публичная точка админки |
| admin-bff | 8002 | сессии сотрудников, CSRF, RBAC и step-up TOTP, агрегация |
| admin-identity | 8120 | вход сотрудников, TOTP MFA, роли, four-eyes |
| user-admin | 8121 | read-модель учеников, карточка, маскирование PII; тариф ученика (спринт 8, фильтр `tier`) |

Отдельного сервиса ai-control нет (решение координатора 2 спринта 8): агенты, модели, бюджеты, аварийная остановка,
учёт затрат и контроль ИИ по тарифу — в **ai-gateway** (8114), раздел «ИИ, затраты» админки.

### Инфраструктура
PostgreSQL 16 (схема и две роли на сервис), Redis 7, NATS 2 + JetStream (stream `TILHERO`, subjects `tilhero.<event_type>`), n8n — только расписания (`infra/n8n/workflows`): `plan-tick`, `notifications-dispatch`, `invites-tick`, `catalog-tick`, `lessons-tick`, `assessment-tick`, `memory-tick`, `game-tick`, `user-admin-reconcile`; спринт 8 — `billing-tick` (каждые 5 мин → `POST /internal/v1/billing:tick`) и `billing-reconcile` (23:15 UTC → `POST /internal/v1/billing:reconcile`), выключены в репозитории (`"active": false`) до выкладки billing с tick и сверкой. n8n не в read path и не владелец данных; вход по `SCHEDULER_TOKEN`. Prod — Railway, как в «Бот турист» (`infra/railway/setup.py`, дозаполнение — `extend.py`).

## Сеть и доступ
- Публичные: telegram-miniapp, telegram-bot-gateway (только webhook), telegram-bff, admin-web; спринт 8 — web-pay (сайт
  оплаты) и payments-edge (только колбэки провайдеров).
- Приватные (`*.railway.internal`): доменные сервисы (в том числе billing), admin-bff, Postgres, Redis, NATS, n8n.
- Секреты спринта 8: **токен бота — только у telegram-bot-gateway (Bot API, в том числе Stars) и telegram-bff
  (проверка initData)**, никуда больше не передаётся (тест `infra/railway/test_setup.py`); ключи Payme, Click, Uzum —
  только переменные billing; секрет клиента «Log In with Telegram» и подпись сессии сайта — только telegram-bff;
  `PAYMENTS_EDGE_TOKEN` — billing и payments-edge. Значения вводит владелец в Railway — не в репозиторий, БД и логи;
  фильтр логов py-common и ts-common вычищает `authorization`, `sign_string`, `secret_key`, `password`, `key`,
  `client_secret`, `code`, `code_verifier`, `id_token`. Telegram ID в billing не попадает.
- Mini App → BFF: `Authorization: Bearer <access JWT 15 мин>` после `POST /v1/session/telegram` с initData. В токене `sub` — аккаунт Telegram, `lrn` — активный ученик. Переключение на профиль ребёнка — `POST /v1/session/learner`, BFF проверяет опекунство в identity-consent.
- BFF → домены: внутренний JWT v2 (EdDSA/Ed25519, TTL 60 с, `iss` = вызывающий, `aud` = домен). К учебным доменам `sub` = ученик, к аккаунтным (согласия, семья, удаление) — аккаунт.

## Ключевые потоки спринта 1

### Онбординг и график
```
Mini App ─ initData ─→ telegram-bff ─→ identity-consent (аккаунт, возраст, ученик, согласия)
                                   └─→ learning-plan (цель, уровень, язык, график: дни, время, длительность, напоминания)
learning-plan ─ learning.plan.updated.v1 ─→ notifications (проекция графика не нужна — напоминания приходят событиями)
```
- Онбординг: кто занимается → возраст → согласия → язык интерфейса → цель → уровень уверенности → **как часто** (каждый день / будни / 3 раза в неделю / свои дни) → **во сколько** (утро / день / вечер / своё время) → **сколько минут** (10 / 15 / 20 / 30) → напоминания (явное согласие) → готово. Каждый шаг без прокрутки на 390×844.
- Часовой пояс — из клиента (`Intl`), хранится в плане ученика и в настройках доставки.

### Напоминания и пропуски
```
n8n (5 мин) ─→ learning-plan POST /internal/v1/plan:tick
   ├─ слот наступил, занятия сегодня ещё нет, напоминания включены → learning.reminder.due.v1
   └─ день слота закончился без занятия → learning.session.missed.v1 {consecutive_missed}
learning-plan ← learning.activity.recorded (BFF: занятие, повторение, практика; со спринта 4 — события lessons/memory)
notifications ← learning.reminder.due.v1 / learning.session.missed.v1 / social.invite.* / support.* / experience.release_note.published.v1
   политика: согласие категории → тихие часы → правила детей (до 20:00, мягкий текст, адресат — родитель) → лимиты → дедупликация
   → журнал + центр уведомлений в приложении → telegram-bot-gateway → Telegram
```
- Пропуски: одно сообщение в день; после 3 пропусков подряд — не чаще раза в неделю «вернуться к занятиям»; никаких сообщений о «потере» серии детям.
- Лимит: не больше 3 сообщений категорий «напоминания» и «социальное» в сутки на ученика.

### Приглашения
```
Mini App ─→ telegram-bff ─→ social POST /internal/v1/me/invites {kind: family|friend|referral}
   → ссылка https://t.me/<bot>/<app>?startapp=inv_<token>  (Telegram «Поделиться»)
Получатель открывает ссылку → Mini App (start_param) → BFF → social :open → карточка приглашения → :accept / :decline
social ─ social.invite.accepted.v1 ─→ notifications → пригласившему «… принял(а) приглашение»
social:tick (1 ч) → открыто, но без ответа 24 ч → social.invite.reminder_due.v1 → notifications → получателю, один раз
```
- Самоприглашение и повторная активация запрещены; ссылка семьи одноразовая, 7 дней; дружбы — 30 дней; реферальная — многоразовая.
- Ребёнок 6–13 приглашений не создаёт и не получает (только через родителя).

### «Что нового»
```
Mini App ─→ telegram-bff GET /v1/whats-new ─→ experience-config GET /internal/v1/release-notes/for-me?first_visit=…
   первая регистрация (онбординг только что завершён): заметки audience=new (знакомство) + последняя audience=all
   каждый следующий вход: опубликованные после онбординга, audience=existing|all, ещё не просмотренные, по сегменту
Mini App показывает шторку → POST /v1/whats-new/seen {ids} → experience-config (отметки просмотра, переживают переустановку)
admin-web (спринт 2) → admin-bff → experience-config /admin/v1/release-notes: черновик → публикация (TOTP) → архив
```
- Сегменты заметки: язык интерфейса (`ru`, `uz`), возраст (`kids`, `teens`, `adults`), платформа Telegram. Тексты RU и UZ обязательны — пустой перевод не публикуется.

## Ключевые потоки спринта 8 (деньги)

### Покупка за Telegram Stars в Mini App (канал `miniapp`)
```
Mini App ─→ telegram-bff POST /v1/billing/orders {provider: telegram_stars} ─(chn miniapp)→ billing: заказ (цена из каталога)
billing ─→ telegram-bot-gateway /internal/v1/stars/invoice-links ─→ Bot API createInvoiceLink (XTR, одна позиция)
Mini App: Telegram.WebApp.openInvoice(invoice_link) → оплата в Telegram
Telegram ─ pre_checkout_query ─→ bot-gateway ─→ identity-consent (Telegram ID → account_id) ─→ billing /stars/pre-checkout
   → answerPreCheckoutQuery в теле webhook ≤ 10 с
Telegram ─ successful_payment ─→ bot-gateway ─→ billing /stars/payments (идемпотентно по charge id): период и минуты
   или тилы (billing.order.paid.v1 → gamification); отметка update_id — только после 2xx billing (иначе Telegram повторит)
подписка Stars: продление Telegram → successful_payment (is_recurring) → заказ renewal → следующий период
```

### Сайт оплаты (канал `web`)
```
браузер ─→ web-pay (Caddy) /api/auth/start ─→ telegram-bff /web/v1/auth/start → 302 oauth.telegram.org (PKCE S256)
oauth.telegram.org → /api/auth/callback?code&state → telegram-bff: id_token по JWKS → identity-consent (аккаунт есть?)
   → cookie __Host-wp_session → тарифы в сумах → POST /api/orders (CSRF, Origin) ─(chn web)→ billing → checkout_url
браузер → страница Payme / Click / Uzum → колбэки провайдера ─→ payments-edge /pay/* ─(X-Edge-Token)→ billing /provider/v1/*
   → транзакция → проведение (период и минуты в той же транзакции БД) → возврат покупателя на /orders/{order_no}
```

### ИИ-минуты
```
lessons: старт урока с ИИ (BILLING_ENFORCED) ─→ billing POST /internal/v1/holds → full | choices (ai_locked)
lessons ─ lesson.session.completed.v1 {billable_minutes, billing_hold_id} ─→ billing: списание ⌈ИИ-секунды/60⌉ один раз
billing ─ billing.access.changed.v1 ─→ ai-gateway (тариф: дневной лимит, paid_only), user-admin (фильтр tier)
```

## Данные ученика и удаление
Сага удаления — в identity-consent (модуль `deletion/`, как в «Бот турист»): `user.deletion.requested.v1` → каждый домен удаляет или обезличивает свои данные и отвечает `user.domain.deleted.v1`. Участники спринта 1: learning-plan, social, notifications, support, experience-config (отметки просмотра). Удаление аккаунта родителя удаляет и детские профили.
Спринт 8 — billing (`mode anonymized`): живая подписка Stars отменяется через bot-gateway **до** удаления данных
(identity-consent удаляет Telegram ID последним), периоды, минуты и удержания удаляются, заказы, транзакции, возвраты,
подписки Stars и фискальные чеки сохраняются обезличенными (В15).

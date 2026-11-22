# gamification (8117, схема `gamification`, пакет `tilhero_gamification`)

**Спринт 7 — социальное** (docs/sprint7/INTERNAL_API.md §2): лиги недели (друзей и семейная — на лету, общая 14+ по
желанию — группы по паре и полосе уровня, закрытие недели с призами), дуэли (вызов, принятие с набором lessons,
счёт, завершение, споры), награды по реферальной кампании social, совместные достижения парных уроков (значок
«Вместе»). Подробности — раздел «Спринт 7» ниже.

Игра и герои TilHero (спринт 6; APP-GAME-01…07, APP-PROG-01/03, ADM-GAME-01/03/04/05; AT-63…72; навык
`gameplay_director` — **код, не LLM**): реестр XP, тилов и заморозок (только добавление), уровни, 9 героев по 3
ступени, задания дня, значки, магазин косметики и заморозок, события недели с множителями, правила игры с версиями
(черновик → проверка → активация, откат), картинки (хранение и выдача), заморозка серии по пропуску, бонусы
регистрации и привлечения, кошельки в админке, сага удаления.

**Игра не меняет учёбу.** XP, тилы, ступени и значки не влияют на уровень языка, навыки, план и сроки повторения.
gamification никого не вызывает синхронно и не публикует событий для учебных доменов; единственное обратное
влияние — `game.streak.frozen.v1` → learning-plan (замороженный день не рвёт серию). Сервис недоступен — учёба
работает (telegram-bff отвечает 503 `GAME_UNAVAILABLE`, Mini App скрывает игровой блок).

Контракты: `docs/sprint6/INTERNAL_API.md` §0, §1, §11, §12; `packages/contracts/src/bff.ts` «Спринт 6»; `admin.ts`
«Игра и герои»; события `packages/contracts/events/game.*.schema.json`. Решения владельца — `docs/sprint6/PLAN.md`.

## Запуск и настройки
`python -m tilhero_common.serve tilhero_gamification.main:app`; миграции — `alembic upgrade head` (под
`MIGRATION_DATABASE_URL`). Синхронно (спринт 7) — только social и lessons в командах дуэли.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `SCHEDULER_TOKEN` | пусто (вход выключен) | `Authorization: Bearer` n8n `game-tick`; в stage/prod ≥ 32 символов |
| `DEFAULT_TIMEZONE` / `STATS_TIMEZONE` | `Asia/Tashkent` | день ученика без проекции плана; граница дней обзора |
| `TICK_BATCH_SIZE` | 500 | пачка шагов tick |
| `RECONCILE_HOURS` | 24 | сверка wallets с реестром не чаще |
| `SOCIAL_URL` / `LESSONS_URL` | 127.0.0.1:8109 / 8112 | спринт 7: связь учеников и member_id → user_id, выгрузки семей и дружб; набор заданий дуэли (в stage/prod обязательны) |
| `DIAGNOSTICS_URL` | 127.0.0.1:8111 | выгрузка полос уровня `GET /internal/v1/export/levels` (в stage/prod обязателен) |
| `PROJECTION_BOOTSTRAP_ON_START` / `PROJECTION_PAGE_SIZE` | true / 500 | разовая загрузка проекций в фоне при старте; размер страницы выгрузки |
| `LEGACY_REFERRAL_DAYS` | 90 | pending-реферал спринта 6: первый урок в N дней с принятия — награда, позже — expired |
| `MEMBER_ID_KEY` | dev-ключ | общий с social и lessons ключ member_id (в stage/prod ≥ 32 символов; пробелы по краям отбрасываются) |
| `LEAGUE_TIMEZONE` | `Asia/Tashkent` | неделя лиг: понедельник 00:00 – воскресенье 24:00 |
| `DEFAULT_PAIR_ID` | `ru-en` | пара ученика без диагностики (лига, дуэль) |
| `DUEL_FINISH_GRACE_MINUTES` | 30 | tick завершает дуэль не раньше чем через N минут после play_deadline |
| `FREEZE_LATE_HOURS` | 24 | пропуск, пришедший позже N часов после конца дня, заморозку не тратит |
| `SESSION_ATTRIBUTION_MINUTES` | 10 | навыки без evidence_id в течение N минут после урока — в итогах этого занятия |
| `NOTIFY_MAX_AGE_MINUTES` | 60 | по событиям старше N минут (догоняющее чтение стрима) `notify = false` у значков и роста героя |
| `IDEMPOTENCY_DAYS` | 7 | срок ключей идемпотентности команд сотрудников и несвязанных итогов навыков (`evidence_rewards`) |
| `ASSET_MAX_BYTES` / `ASSET_MAX_PX` | 307200 / 1024 | картинки: ≤ 300 КБ, ≤ 1024×1024 |

## API ученика (`/internal/v1/game/*`, только `telegram-bff`; ученик — claim `lrn`, полоса — `age_band`)
Аудитория: 6-9 / 10-13 → kids, 14-17 → teens, 18+ → adults; детский профиль (`lrn ≠ sub`) — всегда kids; без
сведений — adults. Удалённый ученик — 410 `USER_DELETED`. Картинки в ответах — `{asset_id, url, sha256, width,
height}`, `url = /v1/game/assets/{asset_id}/{sha256}`.

| Метод и путь | Ответ |
|---|---|
| `GET /summary` | `GameSummary` (задания дня выпускаются при первом запросе дня; `purchase_available: false`) |
| `GET /heroes` | `{items: HeroView[], selected, stage}` — опубликованные своей аудитории (+ выбранный); детям — дракончики первыми |
| `PUT /hero {hero_code}` | `GameSummary`; 404 `HERO_NOT_FOUND`; 409 `HERO_NOT_AVAILABLE` |
| `GET /quests` | `DailyQuests` (скрыты — `items: []`) |
| `GET /badges` | `{items: BadgeView[]}` — выданные первыми (основание), затем прогресс |
| `GET /shop` | `{items: ShopItemView[], til_balance, freeze_stock, freeze_max}` |
| `POST /purchases {item_code}` (Idempotency-Key обязателен) | 201 `PurchaseResult`, повтор ключа — 200 тот же ответ; 404 `ITEM_NOT_FOUND`; 410 `ITEM_NOT_AVAILABLE`; 409 `ALREADY_OWNED` / `FREEZE_STOCK_FULL {max}` / `INSUFFICIENT_TILS {price, balance, missing, purchase_available: false}`; 422 `IDEMPOTENCY_KEY_REUSED` |
| `PUT /equipment {background_code, frame_code}` | `GameSummary`; 409 `NOT_OWNED` |
| `GET /history?currency=&cursor=&limit=` | `Page<GameOperation>` (новые сверху, по 30; без комментария сотрудника) |
| `GET /rewards?source_session_id=` | `SessionRewards`: `pending` — событие занятия ещё не обработано, `ready`, `none` (без наград или чужая сессия) |
| `GET /settings`, `PATCH /settings` | `GameSettings` |
| `GET /assets/{asset_id}` (сервисный токен telegram-bff, без ученика) | байты, `ETag: "<sha256>"`, `Cache-Control: public, max-age=31536000, immutable`, If-None-Match → 304; только опубликованные (герои, предметы в продаже и снятые, значки), иначе 404 |

## Админ-API (`/internal/v1/admin/game/*`, только `admin-bff` с actor; права — в домене)
Step-up: admin-bff проверяет свежесть MFA и передаёт `X-Step-Up: ok` (или claim `step_up: true`); без него —
403 `STEP_UP_REQUIRED`. Каждая команда — аудит `admin.audit.recorded.v1` (`action: game.*`, без текстов учеников).

| Метод и путь | Право | Примечание |
|---|---|---|
| `GET /overview?period=7d\|30d` | game.read \| dashboard.read | `GameOverview` из обезличенной `daily_stats` |
| `GET /rules`, `GET /rules/{version}` | game.read | список без payload; версия + diff с активной |
| `PUT /rules/draft` (If-Match: updated_at черновика при замене) | game.manage | 409 `DRAFT_CONFLICT`; 422 `RULES_INVALID` (структура) |
| `DELETE /rules/draft` | game.manage | 204; 404 `RULES_DRAFT_NOT_FOUND` |
| `POST /rules/draft/validate` | game.manage | `{ok, errors, warnings}`; ok — `validated_at` |
| `POST /rules/draft/activate {comment ≥ 10}` | game.publish + step-up | 409 `RULES_NOT_VALIDATED`; `game.rules.activated.v1` |
| `POST /rules/{version}/rollback {comment ≥ 10}` | game.publish + step-up | только archived и без черновика (409 `RULES_STATE {status \| draft_version}`); payload снова проходит валидатор (422 `RULES_INVALID`); новая версия n+1 сразу active |
| `GET /heroes` | game.read | `AdminHero[]` (живые + черновики, число выбравших) |
| `PUT /heroes/{code}/draft` | game.manage | картинки ступеней — `purpose hero_stage` (422 `ASSET_INVALID`) |
| `POST /heroes/{code}/publish {comment}` | game.publish + step-up | version + 1; 409 `HERO_DRAFT_MISSING` |
| `POST /assets?purpose=` (тело — байты `image/webp \| image/png`) | game.manage | 201 `AdminGameImage`, та же картинка — 200 тот же asset_id; 413 `ASSET_TOO_LARGE`; 422 `ASSET_INVALID {reason: content_type \| signature \| header \| dimensions \| empty}` |
| `GET /assets/{id}`, `GET /assets/{id}/content` | game.read | метаданные; байты любой (и черновой) картинки |
| `GET /shop/items`, `POST /shop/items` (Idempotency-Key), `PATCH /shop/items/{code}` | game.read / game.manage | у опубликованного — только `available_until`, `order` (409 `ITEM_NOT_EDITABLE`); тема — ключи токенов цвета |
| `POST /shop/items/{code}/publish \| retire {comment}` | game.publish + step-up | 409 `ITEM_STATE` |
| `GET /events?status=`, `POST /events` (Idempotency-Key), `PATCH /events/{id}` | game.read / game.manage | ≤ 14 дней; PATCH — только draft (409 `EVENT_STATE`) |
| `POST /events/{id}/publish \| cancel {comment}` | game.publish + step-up | 409 `EVENT_OVERLAP {event_id}` (публикации — по очереди, общая блокировка); 422 `EVENT_STARTS_IN_PAST` |
| `GET /wallets/{user_id}`, `GET /wallets/{user_id}/ledger?currency=&cursor=&limit=` | game.read | 404 `WALLET_NOT_FOUND` |
| `POST /wallets/{user_id}/adjustments {currency, amount, reason ≥ 10}` (Idempotency-Key) | wallet.adjust + step-up | reason `manual`; xp ±1..100000, til ±1..10000, freeze ±1..100; 409 `BALANCE_NEGATIVE`; повтор ключа после очистки — 422 `IDEMPOTENCY_KEY_REUSED` |
| `POST /wallets/{user_id}/ledger/{op_id}/reverse {reason}` | wallet.adjust + step-up | 409 `ALREADY_REVERSED` / `BALANCE_NEGATIVE` / `OPERATION_NOT_REVERSIBLE` (reversal, shop — через refund) |
| `POST /wallets/{user_id}/purchases/{id}/refund {reason}` | wallet.adjust + step-up | `{operations}`; владение удаляется и снимается с экипировки |

## Планировщик
`POST /internal/v1/game:tick` (n8n `game-tick`, каждые 15 минут, `SCHEDULER_TOKEN`): задания — `expired` для
закончившихся дней ученика; события недели — `finished`; лиги — прошлая неделя закрывается (группы по одной
транзакции), включившие участие распределяются по группам новой недели; дуэли — вызовы без ответа 24 ч → `expired`,
принятые после дедлайна → завершение; раз в сутки сверка `wallets` с суммой реестра (расхождение → лог
`WALLET_DRIFT` и пересчёт); чистка ключей идемпотентности. Один tick
за раз (advisory-блокировка, иначе `{skipped: true}`), пачками по 500, повтор безопасен.

## События
Публикует (outbox): `game.streak.frozen.v1`, `game.level.reached.v1`, `game.hero.stage_reached.v1` (`notify`),
`game.badge.earned.v1` (`notify`), `game.purchase.completed.v1`, `game.rules.activated.v1`,
`admin.audit.recorded.v1`, `user.domain.deleted.v1 {domain: gamification}`.

Потребляет (inbox, проверка издателя): `lesson.session.completed.v1` (lessons), `memory.review.completed.v1` (memory),
`skills.state.changed.v1` (diagnostics), `user.profile.created.v1` и `user.deletion.requested.v1`
(identity-consent), `social.invite.accepted.v1` (social), `learning.session.missed.v1`,
`learning.activity.recorded.v1`, `learning.plan.updated.v1` (learning-plan).

## Правила начислений (кратко)
- Ключ операции — `<reason>:<event_id>:<валюта>`; навыки — `skill:<user>:<skill_id>:<to>` (один раз за жизнь);
  заморозка — `freeze:<user>:<день>`; бонус регистрации — `registration_bonus:<user>`; реферала —
  `referral_bonus:<приглашённый>` (спринт 6, отключено в спринте 7); задания — `quest:<user>:<день>:<slot>`.
- Множитель — максимум опубликованных событий недели аудитории, активных в момент действия (вниз); дневной лимит —
  по подтверждённым операциям активностей и заданий местного дня (урезание → `capped`); бонусы, заморозки, ручные и
  обратные записи — без лимита и множителя. День ученика, лимит, множитель и задания — по времени события
  (`finished_at` / `occurred_at` / `recorded_at`, не позже часов сервиса); задания по запоздавшему событию прошедшего
  дня не выпускаются.
- Конкурентность: все изменения ученика — под advisory-блокировкой ученика (+ `FOR UPDATE` кошелька); отметка
  удаления проверяется после блокировки (сага держит ту же блокировку). GET ученика читают без блокировок и записи;
  пишущий ход — только чтобы создать ученика, обновить проекцию из claims или выпустить задания дня.
- Уровень и ступень героя не понижаются; ступень — по числу навыков в demonstrated / retained, подтверждённых в
  учёбе (переход с source lesson | retention). Отметка первичной диагностики в ступень не идёт, пока навык не
  подтверждён уроком или проверкой удержания; `confirmed_skills` в API и событиях — это же число.
- `MyHero.next_stage_at` — сколько подтверждённых навыков осталось до следующей ступени (null — последняя).
- Итоги навыков (операции, рост героя, значки, задание skill_confirmed) относятся к занятию по доказательству:
  `evidence_id` навыка = `evaluation_id` урока, в любом порядке событий (навыки раньше урока ждут его в
  `evidence_rewards`; связь операций — `session_rewards.op_ids`, реестр не меняется). Без evidence_id — к последнему
  уроку не старше 10 минут.
- Бонус регистрации — при первом ходе ученика (и ученикам, зарегистрированным до спринта 6), ключ
  `registration_bonus:<user_id>` общий с `user.profile.created.v1` — без дубля.
- Пояс ученика сохраняется, только если его знают и Python, и PostgreSQL (`pg_timezone_names`); иначе — пояс по
  умолчанию. `daily_stats` пишется по дате `STATS_TIMEZONE` (как окно обзора).
- По событиям старше часа `notify = false` (значки, рост героя); пропуск, пришедший позже суток после конца дня,
  заморозку не тратит и `game.streak.frozen.v1` не выпускает.

## Данные
`ledger` (только добавление; триггер: UPDATE — только `confirmed → reversed` с `reversed_by`, DELETE — только при
`SET LOCAL tilhero.deletion = 'on'`), `wallets` (итоги, CHECK ≥ 0), `learners`, `skill_states`, `referrals`,
`ownership`, `purchases`, `quests`, `badges` (неизменяемы), `badge_templates`, `rules_versions` (одна draft и одна
active — частичные UNIQUE; active и archived неизменяемы), `heroes`, `assets` (неизменяемы), `shop_items`,
`game_events`, `daily_stats` (обезличена, переживает удаление), `session_rewards`, `evidence_rewards`, `idempotency`,
`deleted_users`,
`tick_state`, `outbox`, `inbox`.

Сид миграции 0001 (`migrations/seed/game_seed.json`, `migrations/seed/heroes/*.webp`): правила v1 (active), 9 героев
× 3 ступени с картинками (sha256 и размеры — из заголовка webp), заморозка и 6 предметов косметики (фоны и рамки,
60–200 тилов, published), шаблоны значков RU/UZ. Имена и тексты UZ — черновые, на вычитку владельцу.

## Сага удаления
`user.deletion.requested.v1` (только от identity-consent; детские профили — отдельными запросами): под
`SET LOCAL tilhero.deletion = 'on'` удаляются реестр, значки, кошелёк, ученик, навыки, задания, владение, покупки,
итоги занятий; рефералы — где ученик приглашённый или пригласивший; `daily_stats` остаётся. ACK
`user.domain.deleted.v1 {domain: gamification, mode: deleted}`; повтор подтверждается снова; события после
удаления данных не воскрешают.

## Спринт 7 — лиги, дуэли, рефералы, парные уроки

### API ученика (`/internal/v1/game/*`, только telegram-bff)
| Метод и путь | Ответ |
|---|---|
| `GET /leagues` | `LeaguesView`: друзья (ребёнку — null; скрытые и заблокированные не видны), семья (нет — null), общая лига |
| `GET /leagues/history?cursor&limit` | `Page<LeagueResult>` — мои итоги общей лиги (последняя версия группы) |
| `PATCH /settings {league_opt_in}` | включение: 403 `KIDS_NOT_ALLOWED` (и при неизвестном возрасте), 403 `FRIENDS_NOT_ALLOWED {guardian_consent}` (14–17 без согласия родителя), 403 `SOCIAL_RESTRICTED {until}`, 409 `NICKNAME_REQUIRED`; группа текущей недели сразу (скрытый профиль — после раскрытия, tick); отзыв согласия 14–17 сразу убирает из рейтинга и призов текущей недели |
| `POST /duels {opponent_member_id, pair_id?}` (Idempotency-Key) | 201 `DuelView` (повтор ключа — 200); пара — активная пара вызывающего (иной `pair_id` — 422); 403 `BLOCKED` / `SOCIAL_RESTRICTED` / `PARTNER_NOT_ALLOWED` / `FRIENDS_NOT_ALLOWED`; 404 `MEMBER_NOT_FOUND`; 409 `DUELS_LIMIT` / `DUEL_EXISTS {duel_id}` / `LEVELS_INCOMPATIBLE`; 422 себе; 503 `UPSTREAM_UNAVAILABLE {service: social}` |
| `GET /duels?status=active\|finished&cursor`, `GET /duels/{id}` | `Page<DuelView>`, `DuelView`; чужая — 404 `DUEL_NOT_FOUND`; счёт обоих — только после завершения |
| `POST /duels/{id}/accept` | набор — `POST lessons /internal/v1/duel-sets`; 503 `DUEL_SET_UNAVAILABLE` (дуэль остаётся challenged); санкция вызвавшего — вызов отменяется, 409 `DUEL_STATE {cancelled}`; повтор — 200 |
| `POST /duels/{id}/decline` | `DuelView`; 409 `DUEL_STATE {status}` |

### Админ-API (`/internal/v1/admin/game/*`, admin-bff)
| Метод и путь | Право |
|---|---|
| `GET /leagues?week`, `GET /leagues/{group_id}` | league.read |
| `POST /leagues/{group_id}/reevaluate {exclude_user_ids, reason}` | league.manage + step-up; исключения накапливаются; 409 `RESULT_STATE`, `BALANCE_NEGATIVE` (приз потрачен) |
| `POST /leagues/{group_id}/release-prizes {reason}` | league.manage; только held |
| `GET /duels?status&cursor`, `GET /duels/{id}` | league.read |
| `POST /duels/{id}/reevaluate {result, reason}` | league.manage + step-up; только finished |
| `GET /duels/stats?period=today\|7d\|30d` | league.read \| dashboard.read → `{period, duels_finished}` (Dashboard.social) |

### События
Публикует: `game.league.closed.v1` (каждая версия итогов), `game.duel.challenged.v1`, `game.duel.finished.v1`
(finished и cancelled; переоценка — новая `result_version`), `game.referral.rewarded.v1` (ack social).
Потребляет (издатель проверяется): `social.profile.updated.v1`, `social.friendship.changed.v1`,
`social.block.changed.v1` (вызовы между учениками → cancelled), `social.family.member_added.v1`,
`social.sanction.changed.v1` (social_ban отменяет неотвеченные вызовы), `social.referral.qualified.v1` (social);
`diagnostics.completed.v1` (полоса уровня); `user.profile.updated.v1` (identity-consent: возраст и согласие родителя
14–17 — доступ к общей лиге); `lesson.pair.completed.v1`, `lesson.session.completed.v1` kind duel (lessons).
`social.invite.accepted.v1` новых рефералов спринта 6 больше не создаёт.

### Правила лиг и дуэлей (кратко)
- XP недели — `ledger.league_week` у операций XP с reason lesson, scenario, media, reading, review, skill_*, quest,
  quest_bonus, duel, pair_lesson, кроме операций сотрудника (ручные, переоценка дуэли), призов и бонусов. Неделя — по времени события; после отметки
  `closing` (tick, исключительная advisory-блокировка недели) запоздавший XP идёт в текущую неделю.
- Закрытие — одна транзакция на группу: итоги версии 1 (`league_results` неизменяемы), призы `league_prize`
  (`rules.league.prizes`, только при XP > 0), ключ `league:<week>:<group>:<user>`. Аномалия — XP > median_factor ×
  медиана и > min_xp → призы удержаны (status held, событие с prize_til 0) до решения админа.
- Дуэль: XP `rules.duel` (win / draw / participation; не сыграл — 0), ключ `duel:<id>:<user>`, не больше daily_cap
  наградных дуэлей в день (сверх — 0). Переоценка: обратные записи и новые операции `duel:<id>:<user>:v<n>`.
- Реферал: ключи `referral:<id>:<inviter|invitee>:<валюта>`, reason referral_bonus / referral_welcome. Переход со
  спринта 6: pending «доживают» 90 дней (первый урок — 2 заморозки пригласившему, позже — expired); приглашённый уже
  rewarded / capped по спринту 6 — по кампании пригласившему ничего (outcome legacy); месячный лимит считает
  награды обоих правил за месяц по Ташкенту: для квалификации — `inviter_monthly_cap` кампании из события (месяц
  `qualified_at`; исчерпан — outcome inviter_capped), для «доживающих» pending — `bonuses.referral_monthly_cap`.
  Ack (outcome, inviter_reward — фактически выданное пригласившему) уходит всегда; id удалённого в referral_rewards
  не пишется.
- Парный урок: `pair:<room>:<user>` (XP `rules.pair_lesson.xp`) — комната finished, вклад и ≥ min_turns (1)
  собственных ходов, не больше daily_cap (3) награждаемых уроков в день; значок together_1 — finished, цель
  достигнута и ≥ 1 ход у каждого из двоих. Учёт —
  pair_awards (повтор события ничего не даёт). Операция привязана к сессии участника `uuid5(room_id, str(user_id))`.

### Данные (миграция 0002)
Проекции `social_friends`, `social_blocks`, `community`, `family_members`, `sanctions`, `learner_levels`; лиги
`league_weeks`, `league_groups`, `league_members`, `league_results` (неизменяемы, обезличивание — только в саге);
`duels`, `duel_results_history` (неизменяема); `referral_rewards` (outcome); `pair_awards`; `projection_loads`;
`ledger.league_week`, `learners.league_opt_in`, `learners.together_count`, `learners.guardian_consent`,
`learners.profile_updated_at`; `referrals.status` + expired; правила — новая активная версия (max + 1) с `league`,
`duel`, `pair_lesson {xp, min_turns, daily_cap}`. downgrade возвращает изменения (expired → void, версия правил
миграции снимается, если её ещё не использовали).

### Разовая загрузка проекций и выкладка
Семьи, дружбы, полосы уровня, возраст и согласие родителя живут в стриме 7 дней — после выкладки проекции догружаются
из выгрузок social (`families`, `friendships`), diagnostics (`levels`) и identity-consent (`profiles` — social возраст
не хранит): `GET /internal/v1/export/<name>?cursor=&limit=500` → `{items: [...], next_cursor}` (элемент — payload
события; у `profiles` своя форма `{user_id, kind, age_band, guardian_consent, updated_at}`: заполняется пустое или
более старое, чем выгрузка, — иначе подросток с согласием, полученным до выкладки, остался бы без общей лиги, а давний
взрослый — с «неизвестным возрастом»). Адреса — `SOCIAL_URL`, `DIAGNOSTICS_URL`, `IDENTITY_CONSENT_URL` (обязательны
в stage/prod). Загрузка — в фоне при старте (не задерживает готовность), повтор после сбоя —
каждым `game:tick`, вручную — `POST /internal/v1/projections/bootstrap[?force=true]` (токен планировщика). Только
вставка отсутствующих строк (свежее состояние из событий не перетирается, снятая дружба не возвращается, удалённые
пропускаются); состояние — `projection_loads`. Порядок выкладки: social и diagnostics с маршрутами выгрузок →
gamification с `DIAGNOSTICS_URL` (добавить diagnostics в `calls` gamification в `infra/railway/setup.py`) → проверить
`SELECT name, completed_at, error FROM gamification.projection_loads`.

### Сага (AT-82)
Удаляются проекции и участие в лигах; итоги лиг обезличиваются (user_id → null, места и призы остаются); активные
дуэли — cancelled, все дуэли обезличиваются; реферальные награды обезличиваются.

## Runbook
- **Баланс не сходится** — tick раз в сутки сверяет и пересчитывает (`WALLET_DRIFT` в логах); принудительно — ждать
  следующего прохода после `RECONCILE_HOURS` или вызвать `tick.reconcile(..., force=True)` из консоли.
- **Ошибочное начисление** — обратная запись в админке (`reverse`), не правка реестра.
- **Неудачная версия правил** — откат на архивную (`rollback`): новая версия, проведённые операции не меняются.
- **Тесты**: `source .dev/testenv.sh && uv run pytest services/gamification -q -p no:cacheprovider`.

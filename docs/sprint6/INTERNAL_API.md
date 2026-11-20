# Спринт 6 — внутренние контракты (игра и герои)

Публичные API:
- ученик — `packages/contracts/src/bff.ts`, раздел «Спринт 6»;
- админка — `packages/contracts/src/admin.ts`, раздел «Игра и герои»;
- события — `packages/contracts/events/game.*.schema.json`, `learning.activity.recorded.v1` (+ `streak_days`), `learning.plan.today` (`week[].frozen`).

Общие механизмы — как в спринтах 1–5: внутренний JWT, actor, права в домене, outbox/inbox, ErrorBody, Idempotency-Key, пагинация, сага удаления, аудит привилегированных команд.

## 0. Общее
- **Новый сервис gamification** — порт 8117, схема `gamification`, пакет `tilhero_gamification`, издатель JWT `gamification`.
- **Кто кого вызывает:**
  - telegram-bff → gamification (всё игровое ученика, картинки);
  - admin-bff → gamification (правила, герои, магазин, события, кошельки, картинки, обзор);
  - gamification никого не вызывает синхронно: всё нужное приходит событиями.
- **Ученик в токене.** Как в спринтах 4–5: `lrn` — активный ученик, `age_band` — его полоса. Аудитория: 6-9 / 10-13 → `kids`, 14-17 → `teens`, 18+ → `adults`. Кошелёк, герой, задания и значки — у `lrn`, не у аккаунта.
- **День ученика** — по часовому поясу плана: проекция из `learning.plan.updated.v1` (только от learning-plan), без проекции — `Asia/Tashkent`.
- **Игра не меняет учёбу.** gamification не публикует событий, которые потребляют diagnostics, lessons, assessment, memory, catalog. Единственное обратное влияние — `game.streak.frozen.v1` → learning-plan: замороженный день не рвёт серию. Уровень языка, навыки, план и сроки повторения игра не трогает.
- **Деньги.** В спринте 6 тилы за деньги не продаются. Операция `purchase` в реестре зарезервирована для спринта 8, API её создать не может. Ответ при нехватке тилов несёт `purchase_available: false`.

## 1. gamification (8117)

### 1.1 Данные
- **`ledger`** — реестр операций, только добавление.
  - Поля:
    - `op_id` (uuid), `user_id` (`lrn`);
    - `currency`: `xp | til | freeze`;
    - `amount` — целое ≠ 0, знак = направление;
    - `reason` — код: `lesson | scenario | media | reading | review | skill_demonstrated | skill_retained | quest | quest_bonus | registration_bonus | referral_bonus | streak_freeze | shop | manual | reversal | purchase`;
    - `source` `{kind: event | command | staff, ref}` — `event_id` события, `purchase_id`, `adjustment_id`;
    - `source_session_id` | null — сессия урока или повторения, по ней Mini App находит награды занятия (§1.8);
    - `rules_version` | null; `multiplier` (1.0 по умолчанию; событие недели); `capped` (bool — урезано дневным лимитом);
    - `local_date` — день ученика на момент операции;
    - `status`: `confirmed | reversed`; `reversed_by` | null; `reversal_of` | null;
    - `actor`: `system | learner | staff:<id>`; `comment` ≤ 300 (ручные операции);
    - `idempotency_key` — уникален на (`user_id`, ключ); `created_at`.
  - Неизменяемость: триггер запрещает UPDATE всех полей, кроме перевода `status` `confirmed → reversed` вместе с `reversed_by`. DELETE — только в саге удаления (`SET LOCAL tilhero.deletion = 'on'`).
  - Баланс валюты = сумма `amount` по всем операциям, включая обратные. `til` и `freeze` не уходят в минус: проверка в той же транзакции под `SELECT … FOR UPDATE` строки `wallets`.
- **`wallets`** — материализованные итоги, пересчитываются в транзакции операции: `user_id`, `xp_total`, `til_balance`, `freeze_stock`, `level`, `updated_at`. Сверка: tick раз в сутки сравнивает с суммой реестра, расхождение → лог `WALLET_DRIFT` и пересчёт.
- **`learners`** — проекция и настройки:
  - `user_id`, `account_id` | null, `kind` (`account | child`), `age_band`, `timezone`, `created_at`;
  - `hero_code` | null (null — ещё не выбран), `hero_stage` (1..3, не понижается), `confirmed_skills` (`demonstrated` + `retained`, уникальные навыки);
  - `settings`: `auto_freeze` (true), `quests_hidden` (false), `celebrations` (`full | quiet`, по умолчанию `full`, детям `quiet`), `game_notifications` (true);
  - `equipment`: `background_code` | null, `frame_code` | null;
  - счётчики значков: `lessons_completed`, `reviews_cards`, `readings_completed`, `streak_best`.
- **`skill_states`** — (`user_id`, `pair_id`, `skill_id`) → `state`. Источник — `skills.state.changed.v1`, только от diagnostics.
- **`referrals`** — (`inviter_user_id`, `invitee_user_id`) из `social.invite.accepted.v1` kind `referral`; `status`: `pending | rewarded | capped | void`; `accepted_at`, `rewarded_at`. Уникальность по `invitee_user_id`: один приглашённый награждает одного пригласившего.
- **`ownership`** — купленная косметика: (`user_id`, `item_code`), `purchase_id`, `price_til`, `purchased_at`. Уникальна — второй раз не купить.
- **`purchases`** — `purchase_id`, `user_id`, `item_code`, `price_til`, `op_ids[]`, `status` (`completed | refunded`), `idempotency_key`, `created_at`.
- **`quests`** — задания дня: (`user_id`, `local_date`, `slot` 1..3), `template_code`, `kind`, `target`, `progress`, `status` (`active | completed | expired`), `reward` `{xp, til}`, `completed_at`, `rules_version`. Плюс строка бонуса: `slot = 0`, когда все три выполнены.
- **`badges`** — выданные значки: (`user_id`, `badge_code`), `earned_at`, `basis` `{metric, value, threshold, event_id | null}`. Неизменяемы.
- **`rules_versions`** — правила игры: `version` (int), `status` (`draft | active | archived`), `payload` (§1.3), `comment` ≤ 300, `created_by`, `created_at`, `validated_at`, `activated_by`, `activated_at`, `based_on` | null.
  - Одна `draft`, одна `active` (частичные индексы).
  - Активная версия неизменяема. Новая активация переводит прежнюю в `archived`.
- **`heroes`** — каталог из 9 героев:
  - поля: `code` (`robot_0` … `human_2`), `line` (`robot | pet | human`), `order`, `name` Localized, `tagline` Localized ≤ 80, `audiences[]`, `stages` — 3 × `{stage, name Localized, asset_id}`;
  - `draft` (json тех же полей) | null; `published_at`, `published_by`, `version`.
- **`assets`** — картинки: `asset_id`, `sha256`, `mime` (`image/webp | image/png`), `bytes`, `width`, `height`, `size`, `purpose` (`hero_stage | shop_item | badge`), `uploaded_by`, `created_at`.
  - Не изменяются; удаляются, только если не используются ни в опубликованном, ни в черновом.
  - ≤ 300 КБ, ≤ 1024×1024 px. Формат проверяется по сигнатуре байтов, не по заголовку.
- **`shop_items`** — `code`, `kind` (`background | hero_frame | streak_freeze`), `title` Localized, `description` Localized ≤ 200, `asset_id` | null, `theme` | null (`{tokens: {bg, accent}}` — ссылки на токены темы, не CSS), `price_til` 1..10000, `audiences[]`, `available_from` | null, `available_until` | null, `status` (`draft | published | retired`), `order`, `updated_at`. Заморозка — единственный предмет `streak_freeze`, её цену и запас задают правила (§1.3).
- **`game_events`** — события недели: `event_id`, `code`, `title` Localized, `description` Localized ≤ 300, `starts_at`, `ends_at` (≤ 14 дней), `audiences[]`, `multipliers` `[{action, currency, factor}]`, `status` (`draft | published | cancelled | finished`), `created_by`, `published_by`.
  - `action`: `lesson | scenario | media | reading | review | skill | quest`;
  - `currency`: `xp | til`;
  - `factor`: 1.5 | 2 | 3.
- **`daily_stats`** — обезличенная статистика дня: (`local_date`, `audience`, `metric`) → `value`. Метрики: начислено, потрачено, куплено, заморожено, выполнено заданий, выдано значков. Переживает удаление учеников.

### 1.2 Начисления по событиям
Consumers — с inbox, дедупликацией по `event_id` и проверкой издателя. Идемпотентность операции — `idempotency_key = <reason>:<event_id>[:<suffix>]`: повтор события не даёт второй операции. Правила — активные на момент обработки; версия пишется в операцию.

| Событие (издатель) | Условие | Операции |
|---|---|---|
| `lesson.session.completed.v1` (lessons) | `status completed`, `kind ∈ lesson/scenario/media/reading`; для `lesson` — `practice_only false` | XP и тилы по `earn[kind]`; урок с `passed true` — плюс `earn.lesson_passed_bonus`; `practice_only true` — `earn.lesson_practice` |
| `memory.review.completed.v1` (memory) | `status completed`, `reviewed ≥ earn.review.min_cards` | `earn.review.xp_base + min(correct, earn.review.xp_per_correct_cap)` XP, `earn.review.til` тилов |
| `skills.state.changed.v1` (diagnostics) | `to = demonstrated` (из `learning`/`not_started`) или `to = retained`, `source ≠ diagnostic` | `earn.skill_demonstrated` / `earn.skill_retained` на каждый навык, не больше `earn.skill_max_per_event` навыков на событие. Одно состояние навыка награждается один раз за жизнь: ключ `skill:<user>:<skill_id>:<to>` |
| `user.profile.created.v1` (identity-consent) | любой `kind` | `freeze +bonuses.registration_freeze`, reason `registration_bonus`. Создаёт `learners` |
| `social.invite.accepted.v1` (social) | `kind referral` | `referrals` в `pending`, без операций |
| `lesson.session.completed.v1` | `status completed`, `kind lesson`; ученик — приглашённый в `pending` | пригласившему `freeze +bonuses.referral_freeze` (reason `referral_bonus`). Если за календарный месяц у пригласившего уже `bonuses.referral_monthly_cap` наград — `capped`, без операции |
| `learning.session.missed.v1` (learning-plan) | `auto_freeze`, `freeze_stock ≥ 1` | `freeze −1`, reason `streak_freeze`, ключ `freeze:<user>:<local_date>` → событие `game.streak.frozen.v1` |
| `learning.activity.recorded.v1` (learning-plan) | — | `streak_best = max(streak_best, streak_days)` — для значков серии |
| `learning.plan.updated.v1` (learning-plan) | — | часовой пояс в проекции |
| `user.deletion.requested.v1` (identity-consent) | — | сага (§1.10) |

- **Множитель события недели.** К `xp` и `til` действия применяется максимум одного опубликованного события, активного на момент события, с подходящей аудиторией. Результат округляется вниз. Заморозки и бонусы не умножаются.
- **Дневной лимит.** `caps.xp_per_day` и `caps.til_per_day` на местный день, считаются по операциям с reason из таблицы выше, включая задания. Превышение урезает сумму до остатка, `capped = true`; при нулевом остатке операция не создаётся. Ручные операции, бонусы и обратные записи лимитом не ограничены.
- **Уровень** = число порогов `levels[]` (по возрастанию, первый = 0), не превышающих `xp_total`. Рост уровня → `game.level.reached.v1`. Уровень не понижается: XP списывается только обратной записью, а обратная запись уровень не трогает.
- **Ступень героя** = число порогов `hero.stage_thresholds` (`[0, 5, 15]` по умолчанию), не превышающих `confirmed_skills`. `confirmed_skills` — навыки, подтверждённые в учёбе: переход в `demonstrated`/`retained` с `source` `lesson` или `retention`; отметка первичной диагностики в ступень не идёт, пока навык не подтверждён уроком или проверкой удержания. `MyHero.next_stage_at` — сколько навыков осталось до следующей ступени. Ступень не понижается. Рост → `game.hero.stage_reached.v1`. Ступень общая для всех героев ученика.
- **Задания** обновляются в той же транзакции, что и начисление (§1.5). **Значки** — там же (§1.6).
- **Порядок не важен.** Если событие ученика пришло раньше `user.profile.created.v1`, строка `learners` создаётся по умолчанию (аудитория по `age_band` из события-источника нет — `adults` до проекции); бонус регистрации всё равно придёт со своим событием.

### 1.3 Правила игры (`payload` версии)
```json
{
  "earn": {
    "lesson": {"xp": 20, "til": 5}, "lesson_passed_bonus": {"xp": 10, "til": 0},
    "lesson_practice": {"xp": 10, "til": 2},
    "scenario": {"xp": 15, "til": 4}, "media": {"xp": 10, "til": 3}, "reading": {"xp": 10, "til": 3},
    "review": {"min_cards": 5, "xp_base": 10, "xp_per_correct_cap": 20, "til": 3},
    "skill_demonstrated": {"xp": 15, "til": 5}, "skill_retained": {"xp": 25, "til": 10}, "skill_max_per_event": 10
  },
  "caps": {"xp_per_day": 300, "til_per_day": 60},
  "levels": [0, 100, 250, 450, 700, 1000, 1350, 1750, 2200, 2700, 3250, 3850, 4500, 5200, 5950, 6750, 7600, 8500, 9450, 10450],
  "hero": {"stage_thresholds": [0, 5, 15]},
  "freeze": {"price_til": 40, "max_stock": 5},
  "bonuses": {"registration_freeze": 2, "referral_freeze": 2, "referral_monthly_cap": 10},
  "quests": {
    "per_day": 3, "all_done_bonus": {"xp": 10, "til": 10},
    "templates": [
      {"code": "lesson_1", "kind": "lesson_complete", "target": 1, "reward": {"xp": 10, "til": 5}, "audiences": ["kids", "teens", "adults"], "weight": 3},
      {"code": "review_10", "kind": "review_cards", "target": 10, "reward": {"xp": 10, "til": 5}, "audiences": ["kids", "teens", "adults"], "weight": 3},
      {"code": "reading_1", "kind": "reading_complete", "target": 1, "reward": {"xp": 10, "til": 5}, "audiences": ["kids", "teens", "adults"], "weight": 2},
      {"code": "xp_50", "kind": "xp_earned", "target": 50, "reward": {"xp": 0, "til": 5}, "audiences": ["teens", "adults"], "weight": 2},
      {"code": "scenario_1", "kind": "scenario_complete", "target": 1, "reward": {"xp": 10, "til": 5}, "audiences": ["teens", "adults"], "weight": 1},
      {"code": "media_1", "kind": "media_complete", "target": 1, "reward": {"xp": 10, "til": 5}, "audiences": ["teens", "adults"], "weight": 1},
      {"code": "skill_1", "kind": "skill_confirmed", "target": 1, "reward": {"xp": 15, "til": 5}, "audiences": ["kids", "teens", "adults"], "weight": 1}
    ]
  },
  "badges": {"streak": [7, 30, 100], "skills": [10, 50], "reviews_cards": [100, 1000], "readings": [10]}
}
```
- **Валидатор** (`POST …/rules/draft/validate`, обязателен перед активацией). Ошибки → 422 `RULES_INVALID {errors: [{path, code}]}`:
  - все числа — целые ≥ 0, кроме `factor`; `levels` строго возрастают, `levels[0] = 0`, длина 2..100;
  - `stage_thresholds` — ровно 3, строго возрастают, первый 0;
  - `caps` ≥ максимальной разовой награды;
  - `freeze.price_til` 1..10000, `max_stock` 1..30;
  - `bonuses.*_freeze` 0..10, `referral_monthly_cap` 0..100;
  - шаблонов на каждую аудиторию ≥ `per_day`; коды уникальны; `kind` — из списка §1.5;
  - лишние ключи — ошибка (схема `additionalProperties: false`).
- **Предупреждения** (не блокируют): рост наград больше чем ×2 к активной версии; порог ступени 2 выше 10.
- **Активация.** `game.publish` + step-up + комментарий ≥ 10 → новая `active`; прежняя — `archived`; событие `game.rules.activated.v1`; аудит.
  - Проведённые операции не пересчитываются.
  - Задания текущего дня доигрываются по своей версии.
- **Откат.** `POST …/rules/{version}/rollback` — новая версия `n+1` с `payload` архивной, `based_on = version`, сразу `active`. Те же step-up и комментарий.
- **Начальная версия 1** создаётся миграцией с `payload` выше и `status active`.

### 1.4 Герои
- **Сид — 9 героев**, по 3 в линии. `audiences` у всех трёх линий — все три аудитории. Детям по умолчанию предлагаются дракончики: порядок показа детям — `pet` первыми.

  | Код | Линия | Имя | Ступени |
  |---|---|---|---|
  | `robot_0` | robot | Робот Вольт | Сборка / Запуск / Полёт |
  | `robot_1` | robot | Робот Искра | Сборка / Запуск / Полёт |
  | `robot_2` | robot | Робот Бриз | Сборка / Запуск / Полёт |
  | `pet_0` | pet | Дракончик Мятик | Яйцо / Малыш / Крылья |
  | `pet_1` | pet | Дракончик Персик | Яйцо / Малыш / Крылья |
  | `pet_2` | pet | Дракончик Сирень | Яйцо / Малыш / Крылья |
  | `human_0` | human | Ученица Нилу | Новичок / Путешественник / Знаток |
  | `human_1` | human | Ученик Тимур | Новичок / Путешественник / Знаток |
  | `human_2` | human | Ученица Ая | Новичок / Путешественник / Знаток |

  Имена UZ — в сиде, на вычитку владельцу.
- **Картинки.** Сид загружает 27 картинок `services/gamification/migrations/seed/heroes/<code>_<stage>.webp` (высота 460 px, прозрачный фон, 18–50 КБ). Источник — серии роста, сгенерированные в Figma AI (файл «TilHero — герои»), вырезаны из исходников 1536×864. У дракончиков в серии 4 кадра: ступень 1 — яйцо, 2 — малыш на лапах, 3 — с крыльями в полёте; кадр «вылупляется» не используется. Это черновики до иллюстратора — заменяются в админке без релиза.
- **Выбор героя.** `PUT /internal/v1/game/hero {hero_code}`: только опубликованный герой своей аудитории. Смена бесплатна и не меняет XP, уровень и ступень.
- **Публикация каталога.**
  - Правка `draft` — `game.manage`.
  - `POST …/heroes/{code}/publish` — `game.publish` + step-up: черновик становится живым, `version + 1`, аудит.
  - Нельзя снять с публикации героя, выбранного учениками → 409 `HERO_IN_USE {learners}`. Скрыть из выбора можно: `audiences = []`; у выбравших он остаётся.

### 1.5 Задания дня
- **Выпуск.** Создаются лениво при первом запросе дня (`GET quests` или `summary`) и при первом событии дня ученика.
  - Выбор — детерминированный: `per_day` шаблонов аудитории без повторов, взвешенно, генератор с зерном `sha256(user_id + local_date + rules_version)`.
  - Скрытые задания (`quests_hidden`) не выпускаются.
- **Виды и прогресс:**

  | Вид | Прогресс от |
  |---|---|
  | `lesson_complete` | урок `kind lesson`, `status completed` |
  | `review_cards` | `memory.review.completed` — `reviewed` |
  | `reading_complete` | `kind reading` |
  | `scenario_complete` | `kind scenario` |
  | `media_complete` | `kind media` |
  | `xp_earned` | XP за день по операциям активностей, без заданий |
  | `skill_confirmed` | навык → `demonstrated` |

- **Выполнение.** При `progress ≥ target` задание выполнено: операция `quest` с наградой (с множителем действия `quest`, под дневным лимитом). Все три выполнены → `quest_bonus`.
- **Конец дня.** Невыполненные получают `expired` при tick после полуночи ученика. Без штрафов, серию не трогают.

### 1.6 Значки
Код предиката + пороги из правил. Выдаются в транзакции события, неизменяемы, без операций в реестре.

| Код | Условие | Основание |
|---|---|---|
| `first_lesson` | `lessons_completed ≥ 1` | событие урока |
| `streak_<n>` | `streak_best ≥ n` для `badges.streak` | `learning.activity.recorded.v1` |
| `skills_<n>` | `confirmed_skills ≥ n` | `skills.state.changed.v1` |
| `skill_retained` | первый навык → `retained` | `skills.state.changed.v1` |
| `reviews_<n>` | `reviews_cards ≥ n` | `memory.review.completed.v1` |
| `readings_<n>` | `readings_completed ≥ n` | урок `kind reading` |
| `first_freeze` | первая заморозка спасла серию | `game.streak.frozen.v1` |

Каждый значок → `game.badge.earned.v1`. В API у невыданных значков показывается условие и прогресс: `{metric, value, threshold}`.

### 1.7 Магазин и покупка
- **Витрина ученика** — `published`, своя аудитория, в окне доступности, плюс заморозка. У каждого предмета: `owned`, `can_buy`, `reason_unavailable`.
- **`POST /internal/v1/game/purchases {item_code}`** — заголовок Idempotency-Key обязателен. Одна транзакция:
  1. блокировка `wallets`;
  2. проверка: предмет доступен (иначе 410 `ITEM_NOT_AVAILABLE`); косметика не куплена (иначе 409 `ALREADY_OWNED`); для заморозки `freeze_stock < max_stock` (иначе 409 `FREEZE_STOCK_FULL {max}`); `til_balance ≥ price` (иначе 409 `INSUFFICIENT_TILS {price, balance, missing, purchase_available: false}`);
  3. операция `til −price` (reason `shop`), для заморозки ещё `freeze +1` (reason `shop`);
  4. `ownership` (для косметики), `purchases`;
  5. outbox `game.purchase.completed.v1`.
- **Повтор с тем же ключом** → тот же ответ 200, без новых операций. Тот же ключ с другим телом → 422 `IDEMPOTENCY_KEY_REUSED`.
- **Снятие с продажи** (`retired`) купленное не отбирает. Цена в покупке зафиксирована.
- **Возврат покупки** — только сотрудник: `POST …/wallets/{user}/purchases/{id}/refund`, `wallet.adjust` + step-up + причина. Обратные записи операций; `ownership` удаляется; `purchases.status = refunded`; аудит.
- **Экипировка.** `PUT /internal/v1/game/equipment {background_code | null, frame_code | null}` — только свои купленные предметы нужного вида, иначе 409 `NOT_OWNED`.
- **Дети.** Покупки за тилы разрешены. Покупок за деньги нет ни у кого, у детей и в спринте 8 — только через опекуна.

### 1.8 Награды занятия
- `GET /internal/v1/game/rewards?source_session_id=<uuid>` — операции и события, связанные с сессией урока или повторения:
  - `operations[]` (`currency`, `amount`, `reason`, `capped`, `multiplier`);
  - `level_up` `{from, to}` | null;
  - `hero_stage_up` `{from, to}` | null;
  - `badges[]`;
  - `quests_completed[]`.
- **`status`:**
  - `pending` — ни одной операции, сессия свежая (< 2 мин): Mini App опрашивает каждые 1.5 с, до 8 раз;
  - `ready` — операции есть;
  - `none` — наград не было (лимит, повторный урок без наград). Отсечка ожидания — на клиенте (1 + 8 запросов); Mini App опрашивает только сразу после завершения занятия, не для прошлых занятий из истории.
- Только свои сессии (`user_id` из токена) — чужие дают `none`, без 403, чтобы не раскрывать существование.

### 1.9 Кошелёк ученика и история
- **`GET /internal/v1/game/summary`** → `GameSummary` (bff.ts): уровень, XP в уровне, тилы, заморозки, герой, задания, активные события, экипировка, настройки, `purchase_available: false`.
- **`GET /internal/v1/game/history?cursor&currency`** — операции ученика, новые сверху, по 30.
  - Поля: `reason`, `amount`, `currency`, `created_at`, `status`, `source_label` (код для текста: `lesson | review | …`).
  - Комментарий сотрудника ученику не показывается, только «Корректировка поддержки».
- **`GET/PATCH /internal/v1/game/settings`**.

### 1.10 Сага удаления
Consumer `user.deletion.requested.v1` (только от identity-consent). Для `user_id` и для детских профилей в `subject_ids`, как в других доменах:
1. обновить `daily_stats` (они уже обезличены);
2. под `SET LOCAL tilhero.deletion = 'on'` удалить `ledger`, `wallets`, `learners`, `skill_states`, `quests`, `badges`, `ownership`, `purchases`;
3. в `referrals` — строки, где ученик приглашённый или пригласивший;
4. outbox `user.domain.deleted.v1 {domain: "gamification"}`.

Идемпотентна. Учётные записи сотрудников в `assets.uploaded_by`, `rules_versions` и `heroes` не трогаются — это не данные учеников.

### 1.11 Админ-API (`/internal/v1/admin/game/...`, вызывающий — admin-bff, права в домене)
| Метод | Путь | Право | Примечание |
|---|---|---|---|
| GET | `/overview` | game.read или dashboard.read | итоги 7 и 30 дней из `daily_stats`, активная версия правил, события |
| GET | `/rules` | game.read | список версий без `payload` |
| GET | `/rules/{version}` | game.read | версия + diff с активной (`[{path, from, to}]`) |
| PUT | `/rules/draft` | game.manage | создать или заменить черновик (`payload`, `comment`, `based_on`). If-Match по `updated_at` черновика → 409 `DRAFT_CONFLICT` |
| DELETE | `/rules/draft` | game.manage | |
| POST | `/rules/draft/validate` | game.manage | `{ok, errors[], warnings[]}`; ставит `validated_at`, если ок |
| POST | `/rules/draft/activate` | game.publish + step-up | 409 `RULES_NOT_VALIDATED`, если черновик менялся после проверки |
| POST | `/rules/{version}/rollback` | game.publish + step-up | только `archived` |
| GET | `/heroes` | game.read | живые + черновики |
| PUT | `/heroes/{code}/draft` | game.manage | имя, слоган, аудитории, `asset_id` ступеней (существующие картинки `purpose hero_stage`) |
| POST | `/heroes/{code}/publish` | game.publish + step-up | |
| POST | `/assets` | game.manage | тело — байты картинки (`Content-Type image/webp | image/png`), `?purpose=` → `{asset_id, sha256, width, height, size}`. Та же картинка (sha256) → существующий `asset_id`. 413 `ASSET_TOO_LARGE`, 422 `ASSET_INVALID` |
| GET | `/assets/{id}` | game.read | метаданные |
| GET | `/assets/{id}/content` | game.read | байты картинки, включая черновые (просмотр в админке) |
| GET | `/shop/items` | game.read | |
| POST | `/shop/items` | game.manage | Idempotency-Key; `status draft` |
| PATCH | `/shop/items/{code}` | game.manage | цена и тексты — только у `draft`; у `published` — `available_until`, `order` |
| POST | `/shop/items/{code}/publish` · `/retire` | game.publish + step-up | |
| GET | `/events` | game.read | |
| POST | `/events` · PATCH `/events/{id}` | game.manage | только `draft` |
| POST | `/events/{id}/publish` | game.publish + step-up | 409 `EVENT_OVERLAP {event_id}` — пересечение периода, аудитории и пары действие/валюта с опубликованным; `starts_at` в прошлом → 422 |
| POST | `/events/{id}/cancel` | game.publish + step-up | действовавшие начисления не пересчитываются |
| GET | `/wallets/{user_id}` | game.read | кошелёк, уровень, герой, инвентарь, задания сегодня, значки, рефералы (счётчики) |
| GET | `/wallets/{user_id}/ledger` | game.read | все поля, включая `actor` и `comment`; `limit` 1..100, по умолчанию 30 |
| POST | `/wallets/{user_id}/adjustments` | wallet.adjust + step-up | `{currency, amount, reason ≥ 10}`, Idempotency-Key. `amount` ±1..10000 (XP ±1..100000). Минус не ниже нуля → 409 `BALANCE_NEGATIVE` |
| POST | `/wallets/{user_id}/ledger/{op_id}/reverse` | wallet.adjust + step-up | `{reason ≥ 10}`. Обратная запись: `reversal`, `amount = −исходная`, исходная → `reversed`. Повтор → 409 `ALREADY_REVERSED`. Обратная запись тилов или заморозок не уводит баланс в минус → 409 `BALANCE_NEGATIVE` |
| POST | `/wallets/{user_id}/purchases/{id}/refund` | wallet.adjust + step-up | §1.7 |

- **Аудит.** Каждая команда сотрудника — `admin.audit.recorded.v1` через outbox: `action` `game.*`, `target`, `reason`, без текстов ученика.
- **Step-up.** Как в спринтах 3–5: admin-bff проверяет свежесть MFA и передаёт `X-Step-Up: ok` вместе с `staff_id` в токене. gamification проверяет право и наличие step-up в домене.

### 1.12 Картинки для ученика
- **`GET /internal/v1/game/assets/{asset_id}`** — байты картинки с `Content-Type`, `ETag = sha256`, `Cache-Control: public, max-age=31536000, immutable`. Только картинки, которые используются в опубликованных героях, предметах или значках; иначе 404.
- **Картинки в ответах ученику** (`GameImage`): домен отдаёт готовый `url` вида `/v1/game/assets/{asset_id}/{sha256}` (путь telegram-bff) и размеры; BFF принимает только этот вид для того же `asset_id`.
- **Пути ученика** (вызывающий — только telegram-bff): `GET /internal/v1/game/{summary|heroes|quests|badges|shop|history|rewards|settings}`, `PUT …/hero`, `PUT …/equipment`, `PATCH …/settings`, `POST …/purchases`, `GET …/assets/{asset_id}` (сервисный токен без ученика). История без `limit` — по 30.
- telegram-bff выдаёт их без авторизации — это публичное содержимое — по пути `GET /v1/game/assets/{asset_id}/{sha256}`. Несовпадение sha → 404. Лимит `tg.game.assets`.

### 1.13 tick
`POST /internal/v1/game:tick` — вызывает n8n (`infra/n8n/workflows/game-tick.json`) раз в 15 минут, токен `SCHEDULER_TOKEN`:
- задания: `expired` для дней, закончившихся у ученика;
- события недели: `published` → `finished` после `ends_at`;
- рефералы: `pending` старше 90 дней → `void`;
- раз в сутки — сверка `wallets` с реестром.

Идемпотентен, пачками по 500.

## 2. learning-plan
- **Новая таблица `frozen_days`** (`user_id`, `local_date`) PK, `op_id`, `created_at`. Consumer `game.streak.frozen.v1` (только от gamification) вставляет строку, повтор ничего не меняет.
- **Серия.** В `streak_days` последний разрыв — пропуск без занятия **и без заморозки**. `consecutive_missed` в tick тоже не считает замороженные дни: замороженный день разрывает цепочку пропусков.
- **`TodayPlan.week[]`** — новое поле `frozen: boolean` (день графика, пропущенный, но спасённый заморозкой; `missed` при этом остаётся `true`).
- **`learning.activity.recorded.v1`** — новое необязательное поле `streak_days` (≥ 0): серия после записи занятия.
- Заморозка может прийти позже занятия того же дня (гонка). Занятие важнее: день с занятием — `done`, заморозка этого дня у learning-plan ни на что не влияет. Списанную заморозку gamification при этом не возвращает: игра узнаёт о пропуске раньше.

  > Пропуск выпускается после конца дня, занятий в этот день уже не будет. Гонка возможна только с поздно пришедшим событием урока. Это допустимо, повторная проверка не нужна.

## 3. notifications
- **Consumers** (только от gamification):
  - `game.streak.frozen.v1` → шаблон `streak_frozen`;
  - `game.badge.earned.v1` → `badge_earned`;
  - `game.hero.stage_reached.v1` → `hero_stage_reached`.
- **Маршрутизация — по правилам спринтов 2–5:**
  - дети — опекуну, только в сводке, ребёнку push не уходит;
  - тихие часы, частота и отписка — общие;
  - категория `game` отключается в настройках уведомлений ученика.
- Шаблоны RU/UZ — в сиде (`streak_frozen`: «Серия спасена: заморозка закрыла пропуск {date}. Осталось заморозок: {left}»; `badge_earned`: «Новый значок: {badge}»; `hero_stage_reached`: «{hero} вырос: {stage}!»). Переменные — без текстов ученика.
- **Категория `game` в спринте 6** — внутренняя категория notifications: отключается общим выключателем `reminders` (`GAME_CATEGORY_GATE=reminders`), в центре уведомлений показывается как `reminders`. Если выключатель выключен, запись не пропадает, а остаётся в центре без Telegram (`category_disabled_center`): «Серия спасена» ученик видит всегда. Отдельный переключатель «Игра» в настройках уведомлений — с полноценной категорией в контрактах (спринт 7). Управление учеником — `game_notifications` в настройках мотивации. Сводки для опекуна в сервисе нет: детские уведомления — в центре уведомлений детского профиля (`kid_summary`).
- **`game_notifications`.** gamification не публикует `badge_earned` и `hero_stage_reached` для уведомлений, если `game_notifications = false`: в событии есть флаг `notify`, notifications его соблюдает. `streak_frozen` отправляется всегда — это информация о серии.

## 4. identity-consent
- `gamification` — в `DEFAULT_DELETION_DOMAINS`.
- `user.profile.created.v1` уже содержит `kind` и `age_band` — изменений нет.

## 5. admin-identity
- Права `game.read`, `game.manage`, `game.publish`, `wallet.adjust`.
- Роли — по PLAN §«Права и роли». Step-up: `game.publish`, `wallet.adjust`.

## 6. social
Изменений нет: `social.invite.accepted.v1` kind `referral` уже публикуется.

## 7. ai-gateway
Реестр агентов: `gameplay_director` → `status active`, `implementation code`, `owner_service gamification`. Вызовов модели нет.

## 8. experience-config
`ADMIN_MENU` — пункты `heroes`, `game`, `game_events` (раздел «Игра»). Тема Mini App — без изменений: косметика ученика накладывается поверх темы на клиенте.

## 9. telegram-bff
Маршруты `/v1/game/*` — тонкий прокси на gamification:
- проверяет `initData` и выпускает JWT с `lrn` и `age_band`, как в спринтах 4–5;
- лимиты `tg.game.read` (120/мин), `tg.game.write` (30/мин), `tg.game.purchase` (10/мин), `tg.game.assets` (600/мин на IP);
- картинки — §1.12;
- ошибки gamification проходят без изменений, `5xx` → 503 `GAME_UNAVAILABLE`.

Без игры Mini App работает: главная показывает план без игрового блока.

## 10. admin-bff
Прокси `/admin/v1/game/*` → `/internal/v1/admin/game/*`:
- кодеки ответов строгие, как в спринтах 4–5;
- step-up — для команд из §1.11;
- загрузка картинки — сырое тело до 300 КБ, `Content-Type` из списка.
- Блок обзора `Dashboard.game`: XP и тилы за 7 дней, заморозок за 7 дней, заданий выполнено, активное событие. Для периода `today` блок показывает 7 дней (итогов за день у gamification нет).

## 11. События
| Событие | Издатель | Полезная нагрузка | Потребители |
|---|---|---|---|
| `game.streak.frozen.v1` | gamification | `user_id`, `local_date`, `op_id`, `freeze_left`, `frozen_at` | learning-plan, notifications |
| `game.level.reached.v1` | gamification | `user_id`, `level`, `xp_total`, `reached_at` | — (аналитика) |
| `game.hero.stage_reached.v1` | gamification | `user_id`, `hero_code`, `stage`, `confirmed_skills`, `notify`, `reached_at` | notifications |
| `game.badge.earned.v1` | gamification | `user_id`, `badge_code`, `notify`, `earned_at` | notifications |
| `game.purchase.completed.v1` | gamification | `purchase_id`, `user_id`, `item_code`, `item_kind`, `price_til`, `purchased_at` | — (аналитика) |
| `game.rules.activated.v1` | gamification | `version`, `based_on`, `activated_by`, `activated_at` | — (аудит) |
| `learning.activity.recorded.v1` | learning-plan | + `streak_days` (необязательное) | gamification |

## 12. Ошибки (новые коды)
`INSUFFICIENT_TILS`, `ALREADY_OWNED`, `HERO_DRAFT_MISSING`, `ITEM_STATE`, `ITEM_NOT_EDITABLE`, `ITEM_INVALID`, `ITEM_CODE_TAKEN`, `EVENT_STATE`, `EVENT_INVALID`, `EVENT_CODE_TAKEN`, `EVENT_STARTS_IN_PAST`, `RULES_STATE`, `RULES_DRAFT_NOT_FOUND`, `OPERATION_NOT_FOUND`, `OPERATION_NOT_REVERSIBLE` (покупка отменяется только возвратом), `PURCHASE_NOT_FOUND`, `STEP_UP_REQUIRED`, `FREEZE_STOCK_FULL`, `ITEM_NOT_AVAILABLE`, `NOT_OWNED`, `HERO_NOT_AVAILABLE`, `HERO_IN_USE`, `RULES_INVALID`, `RULES_NOT_VALIDATED`, `DRAFT_CONFLICT`, `EVENT_OVERLAP`, `BALANCE_NEGATIVE`, `ALREADY_REVERSED`, `ASSET_TOO_LARGE`, `ASSET_INVALID`, `GAME_UNAVAILABLE`.

# learning-plan-service

**Владелец:** команда Telegram-контура. **Bounded context:** предпочтения пользователя для подбора событий и поездок — интересы, география, формат, бюджет, горизонт, точки напоминаний, города вылета, рейсы (ТЗ Telegram §5, TG-FR-010…018, BR-TG-002…005) и справочники онбординга (аэропорты, таксономия интересов, география).

Порт 8102, схема PostgreSQL `preferences`, внутренний JWT с `aud = preferences`. Redis не нужен.

## API
Вызывает только `telegram-bff` (`iss`), пользователь — только из `sub` токена. Формы ответов = `packages/contracts/src/bff.ts` (BFF проксирует без перекладывания). admin-bff (спринт 2) получит отдельный staff-роутер с правами, а не доступ к `/me`.

| Метод | Путь | Тело → ответ |
|---|---|---|
| GET | `/internal/v1/me/preferences` | → `Preferences`; при первом обращении создаёт профиль по умолчанию |
| PATCH | `/internal/v1/me/preferences` | `PreferencesPatch` → `Preferences`; 409 `PREFERENCES_VERSION_CONFLICT {current_version}`; 422 `PREFERENCES_INVALID {field, reason}` |
| PUT | `/internal/v1/me/departures` | `{airports: ["TAS", …]}` → `Preferences`; 422 `AIRPORT_UNKNOWN {iata}`; максимум 10 |
| POST | `/internal/v1/me/onboarding/complete` | → `Preferences` (идемпотентно, время первой отметки сохраняется) |
| GET | `/internal/v1/me/release-notes/seen` | → `{release_note_id, published_at, onboarding_completed_at}` — 9.4 «Что нового»: последняя просмотренная заметка о релизе (null — ещё не было); при первом обращении создаёт профиль по умолчанию |
| PUT | `/internal/v1/me/release-notes/seen` | `{release_note_id, published_at (с поясом)}` → то же; отметка только вперёд (старее или та же — no-op), **не** меняет `version`/`updated_at` предпочтений и не публикует событий; 410 `USER_DELETED` |
| GET | `/internal/v1/directory/airports?q=&limit=` | → `{items: Airport[]}`, `limit` 1…50 (по умолчанию 20), `q` ≤ 60 |
| GET | `/internal/v1/directory/interests` | → `{items: InterestCategory[]}` |
| GET | `/internal/v1/directory/geographies` | → `{items: GeoOption[]}` |

Профиль по умолчанию: интересы и география пустые, `strong_events_outside_geo=false`, `event_formats=["offline"]`, бюджет не задан (все поля `null`), горизонт 12, точки `[3, 6]`, `departures=[]` (BR-TG-004: город вылета без действия пользователя не выбирается), все `flight_prefs=true`, `version=1`.

Удалённый пользователь (после саги удаления) → 410 `USER_DELETED` на любой `/me`-запрос: запоздавшие команды не воскрешают профиль.

### Правила валидации (`422 PREFERENCES_INVALID {field, reason}`)
Вход строгий: лишние поля (`user_id`, `departures`, `onboarding_completed_at` в PATCH) → `unknown_field`; явный `null` для поля → `null_not_allowed`; `"1500"`/`1500.5`/`true` вместо целого → `integer_required`/`invalid_type`.

| Поле | Правило | reason |
|---|---|---|
| `interests.categories` | коды таксономии, без повторов | `unknown_category`, `duplicate` |
| `interests.entities` | ≤ 20; 1…60 символов после trim (пробелы схлопываются); без повторов без учёта регистра; без управляющих символов | `too_many`, `length`, `duplicate`, `invalid_chars` |
| `geographies` | ≤ 30; `world` без кода и только один; `region` — из справочника; `country` — ISO 3166-1 alpha-2 (регистр нормализуется); `city` — English name 1…60 (латиница, в т.ч. с диакритикой) | `too_many`, `world_exclusive`, `not_allowed`, `unknown_region`, `unknown_country`, `length`, `english_name_required`, `duplicate` |
| `event_formats` | ⊂ {offline, online}, не пусто, без повторов | `empty`, `duplicate`, `not_allowed` |
| `budget` | `preset` → min/max вычисляет сервис (under_500 0–500, 500_1000, 1000_2000, 2000_5000); `custom` → `custom_amount` целое 50…100 000 USD (BR-TG-003); `preset=null` + `min/max` на границах пресетов (0/500/1000/2000/5000) — объединение диапазонов, как мультивыбор чипов прототипа; всё `null` — не задан | `required`, `out_of_range`, `integer_required`, `not_allowed`, `not_preset_boundary`, `invalid_range` |
| `search_horizon_months` | 3 / 6 / 12 / 24 | `not_allowed` |
| `notification_points_months` | ⊂ {1, 3, 6, 12}, без повторов, ≤ горизонта; при уменьшении горизонта без явных точек лишние точки снимаются (как в прототипе) | `not_allowed`, `duplicate`, `exceeds_horizon` |
| `flight_prefs` | все три поля; хотя бы один из `direct`/`connecting` = true | `required`, `at_least_one` |
| `departures` (PUT) | ≤ 10 IATA из справочника, без повторов | `too_many`, `duplicate`; неизвестный код → `AIRPORT_UNKNOWN {iata}` |

Повтор того же PATCH/PUT — no-op: версия, `updated_at` и события не меняются.

### Справочники
- **Аэропорты** — `src/tilhero_learning_plan/directory/airports.json`: 428 аэропортов, 126 стран, English naming (`iata, city, country, country_code, name`) + `aliases_ru` для популярных городов. Все аэропорты Узбекистана (TAS SKD BHK NMA FEG UGC NCU TMJ KSQ NVI AZN), Центральная Азия и СНГ, Ближний Восток, Европа, Азия, Америка, Африка, Океания. `city` — обслуживаемый город (как в бронировании: EWR → New York, BGY → Milan). Поиск без учёта регистра, диакритики и «ё»: точный IATA → префикс города (англ. или русский алиас) → начало слова → вхождение; внутри ранга — порядок файла (Узбекистан первым). Пустой `q` — начало списка.
- **Интересы** — `directory/taxonomy.py`: 6 категорий верхнего уровня (music, sport, business, culture, education, festivals) и подкатегории `<parent>.<slug>`; `icon` — имя иконки Mini App. Чипы прототипа: concerts→music.concerts, motorsport→sport.motorsport, football→sport.football, tennis→sport.tennis, ai→business.ai, fintech→business.fintech, forums→business.conferences, theatre→culture.theatre, exhibitions→culture.exhibitions, festivals→festivals, education→education, othersport→sport.other.
- **География** — `directory/geo.py`: world, 9 регионов (central_asia, cis, middle_east, europe, asia, north_america, latin_america, africa, oceania), 69 популярных стран RU/EN. Чипы прототипа: uz→UZ, kz→KZ, uae→AE, turkey→TR, europe/asia → регионы, na → north_america.

### Спрос для discovery (спринт 3)
`GET /internal/v1/demand` — вызывает только `discovery` (иначе 403 `CALLER_NOT_ALLOWED`). Агрегат по профилям с
завершённым онбордингом, без `user_id`:
`{generated_at, users, countries: [{code, users}], cities: [{name, country_code|null, users}],
categories: [{code, users}], online_users, regions: [{code, users}], world_users}`.
`regions` и `world_users` — сверх контракта (аддитивно): регионы и «весь мир» discovery разворачивает в страны сам.
Город — English name из профиля (группировка без учёта регистра), страна — по справочнику аэропортов (неизвестный или
неоднозначный город → `null`). Группы меньше `DEMAND_MIN_GROUP` (1) скрываются, общие счётчики ниже порога обнуляются;
в каждом списке не больше `DEMAND_TOP_N` (50), по убыванию числа пользователей. Подсчёт — SQL по JSONB, профили в
память не загружаются.

**Какие пользователи учитываются (решение спринта 3, зафиксировано в `docs/sprint3/INTERNAL_API.md`):**
- профили с завершённым онбордингом (`onboarding_completed_at IS NOT NULL`);
- удалённые пользователи в спрос не попадают: их профили физически стираются сагой удаления
  (`user.deletion.requested.v1`, TG-FR-006);
- **DISABLED не фильтруется**: статус пользователя (ACTIVE/DISABLED) живёт в identity-consent, в preferences его нет,
  и проекции статуса здесь не ведётся. Отключённый пользователь продолжает учитываться в спросе. Это влияет только на
  приоритет scope поиска discovery (агрегат без `user_id`, порог `DEMAND_MIN_GROUP`), не на выдачу пользователям.
  Если понадобится исключать DISABLED — проекция `user.status.changed.v1` в preferences (отдельная задача).

## События
Публикует (outbox): `user.preferences.updated.v1 {user_id, changed_fields, onboarding_completed}` — только при фактическом изменении; значения полей в событие не попадают.

Потребляет: `user.deletion.requested.v1` (durable `preferences.user_deletion`) → физическое удаление профиля + отметка в `deleted_users` → `user.domain.deleted.v1 {user_id, request_id, domain: "preferences", mode: "deleted"}` (causation = событие запроса). Повторная доставка отсекается inbox; новый запрос для уже удалённого пользователя снова подтверждается.

## Данные
- `preference_profiles` — `user_id` PK UUID, JSONB `interests/geographies/event_formats/budget/notification_points_months/departures/flight_prefs`, `strong_events_outside_geo`, `search_horizon_months`, `onboarding_completed_at`, `version` (оптимистическая блокировка), `created_at`, `updated_at`; CHECK-ограничения формы JSON.
- 9.4 (миграция 0003): `preference_profiles.last_seen_release_note_id` + `last_seen_release_note_at` (оба null или оба заданы) — отметка «Что нового». Живёт в строке профиля, поэтому удаляется сагой удаления вместе с профилем (тест `test_pref_release_seen.py`).
- `deleted_users` — `user_id`, `request_id`, `deleted_at` (без персональных данных).
- `outbox`, `inbox`.

Изменения одного пользователя сериализуются `pg_advisory_xact_lock` + `SELECT … FOR UPDATE`.

## Runbook

> Эксплуатация через браузер (Railway, админка, оповещения ops-monitor): [docs/runbooks/preferences.md](../../docs/runbooks/preferences.md). Ниже — технические детали для разработчика.
- Миграции: `alembic -c alembic.ini upgrade head` (Railway preDeploy).
- Локально: `infra/dev/stack.sh up`, `DATABASE_URL=postgresql://preferences:dev@127.0.0.1:5432/tilhero NATS_URL=nats://127.0.0.1:4222 uv run uvicorn tilhero_learning_plan.main:app --port 8102`.
- Тесты: `uv run pytest services/preferences -q`.
- Переменные спроса: `DEMAND_MIN_GROUP` (по умолчанию 1), `DEMAND_TOP_N` (50).
- Обновление справочника аэропортов: правка `airports.json` (IATA проверять по сайту аэропорта), новые коды добавлять в конец региона; переименование кода у пользователей не мигрирует — существующие `departures` хранят снимок `{airport_iata, city, country_code}`.
- 409 `PREFERENCES_VERSION_CONFLICT` в логах BFF — нормальная ситуация двух открытых окон; клиент перечитывает профиль.

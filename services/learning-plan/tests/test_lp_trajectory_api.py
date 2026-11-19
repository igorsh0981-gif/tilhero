"""GET /internal/v1/plan/trajectory (INTERNAL_API §3, bff.ts Trajectory; AT-36, AT-34): форма ответа, ревизии и
история, пересчёт по диагностике / навыкам / цели / темам / событию каталога, кеш снимка по ETag, 503 и 409,
аудитория (дети), авторизация, изоляция, событие learning.trajectory.updated.v1, сага удаления."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from lp_course import ADULT_CORE, KIDS_CORE, SNAPSHOT_PATH, course

from tilhero_common.testing import internal_headers

PATH = "/internal/v1/plan/trajectory"
UPDATED = "learning.trajectory.updated.v1"
CARD_KEYS = {"lesson_id", "module_id", "title", "goal", "level", "kind", "duration_min", "primary_skill_id",
             "scenario_id", "stages"}


def mandatory(body: dict[str, Any]) -> list[str]:
    return [x["lesson_id"] for x in body["mandatory"]]


async def test_without_diagnostic_happy_path_and_event(env, user) -> None:
    body = await env.trajectory(user)
    assert body["pair_id"] == "ru-en" and body["course_id"] == "en-core" and body["revision"] == 1
    assert body["basis"] == {"diagnostic_result_id": None, "goal": None, "computed_at": "2026-11-16T08:00:00Z"}
    assert body["completed"] == [] and body["lessons_available"] is False
    nxt = body["next"]
    assert set(nxt) == CARD_KEYS | {"reason_codes", "explanation"}
    assert nxt["lesson_id"] == "l-greet" and nxt["reason_codes"] == ["no_diagnostic"]
    # профиль неизвестен — детский сегмент: мягкое объяснение
    assert nxt["explanation"] == {"ru": "Начнём с самого начала — шаг за шагом.",
                                  "uz": "Eng boshidan, qadamma-qadam boshlaymiz."}
    assert nxt["title"] == {"ru": "l-greet (ru)", "uz": "l-greet (uz)"} and len(nxt["stages"]) == 5
    assert body["mandatory"][0] == {k: v for k, v in nxt.items() if k != "explanation"}
    assert all(set(x) == CARD_KEYS | {"reason_codes"} for x in body["mandatory"])
    # профиль неизвестен — самый строгий набор (только детские уроки)
    assert mandatory(body) == KIDS_CORE and body["optional"] == []
    [ev] = await env.events(UPDATED, user)
    assert ev.payload == {"user_id": str(user), "pair_id": "ru-en", "revision": 1, "next_lesson_id": "l-greet",
                          "reason_codes": ["no_diagnostic"], "computed_at": "2026-11-16T08:00:00Z"}
    # catalog: один запрос снимка, вызывающий — learning-plan, без ученика в токене
    [call] = env.catalog.calls
    assert call == {"path": SNAPSHOT_PATH, "if_none_match": None, "iss": "learning-plan", "aud": "catalog",
                    "sub": None}


async def test_repeat_read_returns_same_revision_without_event(env, user) -> None:
    first = await env.trajectory(user, audience="adults")
    env.now = datetime(2026, 11, 17, 8, 0, tzinfo=UTC)
    again = await env.trajectory(user, audience="adults", pair_id="ru-en")
    assert again == first  # входы не изменились — та же ревизия, computed_at прежний
    assert len(await env.events(UPDATED, user)) == 1
    assert len(env.catalog.calls) == 1  # снимок свежий — без запроса в catalog
    assert mandatory(first) == ADULT_CORE
    assert first["next"]["explanation"]["ru"].startswith("Диагностика ещё не пройдена")
    assert first["next"]["explanation"]["uz"].startswith("Diagnostika hali oʻtilmagan")


async def test_auth_and_validation(env, user) -> None:
    r = await env.c.get(PATH)
    assert (r.status_code, r.json()["code"]) == (401, "INTERNAL_TOKEN_MISSING")
    r = await env.c.get(PATH, headers={"x-internal-token": "garbage"})
    assert r.status_code == 401
    for issuer in ("admin-bff", "catalog", "notifications"):
        r = await env.c.get(PATH, headers=env.h(user, issuer=issuer))
        assert (r.status_code, r.json()["code"]) == (403, "CALLER_NOT_ALLOWED"), issuer
    r = await env.c.get(PATH, headers=internal_headers(env.settings, issuer="telegram-bff"))
    assert (r.status_code, r.json()["code"]) == (401, "USER_CONTEXT_REQUIRED")
    r = await env.c.get(PATH, headers=internal_headers(env.settings, issuer="telegram-bff", subject="not-a-uuid"))
    assert (r.status_code, r.json()["code"]) == (401, "USER_CONTEXT_INVALID")
    for params in ({"pair_id": "RU_EN"}, {"pair_id": "ru-" + "e" * 20}, {"pair_id": ""}, {"audience": "elders"}):
        r = await env.c.get(PATH, params=params, headers=env.h(user))
        assert (r.status_code, r.json()["code"]) == (422, "VALIDATION_ERROR"), params
    assert env.catalog.calls == [] and await env.revisions(user) == []


async def test_pair_not_available(env, user) -> None:
    body = await env.trajectory(user, expect=409, pair_id="ru-uz")
    assert body["code"] == "PAIR_NOT_AVAILABLE" and body["details"] == {"pair_id": "ru-uz"}
    assert env.catalog.calls == []
    env.catalog.snapshot = None  # курс снят с публикации — catalog 404
    body = await env.trajectory(user, expect=409)
    assert body["code"] == "PAIR_NOT_AVAILABLE" and body["details"] == {"pair_id": "ru-en"}
    assert await env.revisions(user) == []


async def test_catalog_unavailable_without_cache_503_with_cache_ok(env, user) -> None:
    env.catalog.down = True
    body = await env.trajectory(user, expect=503)
    assert body["code"] == "CATALOG_UNAVAILABLE"
    assert await env.revisions(user) == [] and await env.events(UPDATED) == []
    env.catalog.broken = True  # ответ не по контракту — как недоступный
    env.catalog.down = False
    assert (await env.trajectory(user, expect=503))["code"] == "CATALOG_UNAVAILABLE"
    env.catalog.broken = False
    first = await env.trajectory(user, audience="adults")
    # кеш устарел, catalog лежит — траектория по кешу, без новой ревизии
    env.catalog.down = True
    await env.expire_snapshot()
    calls = len(env.catalog.calls)
    again = await env.trajectory(user, audience="adults")
    assert again == first and len(env.catalog.calls) > calls
    # новые входы при лежащем catalog — пересчёт по кешу
    await env.diagnostic(user, start="l-present")
    third = await env.trajectory(user, audience="adults")
    assert third["revision"] == 2 and third["next"]["lesson_id"] == "l-present"


async def test_etag_revalidation_304_and_new_snapshot(env, user) -> None:
    await env.trajectory(user, audience="adults")
    await env.expire_snapshot()
    again = await env.trajectory(user, audience="adults")
    assert again["revision"] == 1
    assert env.catalog.calls[-1]["if_none_match"] == env.catalog.etag  # условный запрос → 304
    [(checked,)] = await env.sql("SELECT checked_at > now() - interval '1 minute' FROM course_snapshots")
    assert checked is True
    # в catalog опубликован новый снимок: урок travel убран из курса
    snap = course("snap-2")
    snap["modules"][2]["lesson_ids"].remove("l-travel")
    env.catalog.publish(snap)
    await env.expire_snapshot()
    body = await env.trajectory(user, audience="adults")
    assert body["revision"] == 2 and "l-travel" not in mandatory(body)
    [(etag, version)] = await env.sql("SELECT etag, snapshot_version FROM course_snapshots")
    assert (etag, version) == ('W/"snap-2"', "snap-2")
    assert [r[0] for r in await env.revisions(user)] == [1, 2]


async def test_catalog_event_marks_snapshot_stale(env, user) -> None:
    """catalog.version.published.v1 (курс/модуль/урок/навык) — перепроверка снимка при следующем чтении даже в
    пределах TTL; рубрика/сценарий/медиа — нет; чужой издатель — без действия."""
    await env.trajectory(user, audience="adults")
    for kind in ("rubric", "scenario", "media_asset", "media_exercise"):
        await env.catalog_published(kind=kind, key="x")
    await env.catalog_published(producer="diagnostics")  # чужой издатель
    await env.trajectory(user, audience="adults")
    assert len(env.catalog.calls) == 1
    snap = course("snap-3")
    snap["lessons"][0]["title"] = {"ru": "Привет!", "uz": "Salom!"}
    env.catalog.publish(snap)
    await env.catalog_published(kind="lesson", key="l-greet")
    body = await env.trajectory(user, audience="adults")
    assert len(env.catalog.calls) == 2 and env.catalog.calls[-1]["if_none_match"] == 'W/"snap-1"'
    assert body["revision"] == 2 and body["next"]["title"] == {"ru": "Привет!", "uz": "Salom!"}
    [(stale,)] = await env.sql("SELECT stale_since FROM course_snapshots")
    assert stale is None
    # откат курса без course_id в событии — помечаются все снимки; тот же ETag → 304, ревизия прежняя
    await env.catalog_published(kind="course", key="en-core", course_id=None, action="rolled_back")
    again = await env.trajectory(user, audience="adults")
    assert again["revision"] == 2 and env.catalog.calls[-1]["if_none_match"] == 'W/"snap-3"'
    assert env.bus.dlq == []


async def test_diagnostic_starts_plan_and_retest_adds_revision(env, user) -> None:
    """AT-34/36: без диагностики — от начала курса; после — от рекомендованного старта; повторная диагностика —
    новая ревизия; прошлые ревизии сохраняются; опоздавший старый результат не перезаписывает новый."""
    await env.profile(user)
    first = await env.trajectory(user)
    assert mandatory(first) == ADULT_CORE
    rid = await env.diagnostic(user, start="l-present", completed_at="2026-11-16T07:00:00Z")
    second = await env.trajectory(user)
    assert second["revision"] == 2 and second["basis"]["diagnostic_result_id"] == str(rid)
    assert second["next"]["lesson_id"] == "l-present"
    assert second["next"]["reason_codes"] == ["start_after_diagnostic"]
    assert second["next"]["explanation"]["ru"] == "По итогам диагностики начать лучше с этого урока."
    retest = await env.diagnostic(user, start="l-past", completed_at="2026-11-30T07:00:00Z", grammar="A2",
                                  vocabulary="A2", reading="A2", listening="A2", level="A2")
    third = await env.trajectory(user)
    assert third["revision"] == 3 and third["basis"]["diagnostic_result_id"] == str(retest)
    assert mandatory(third) == ["l-past", "l-travel", "l-hotel"]
    # уточнение старого результата пришло позже — проекция не откатывается, ревизии нет
    await env.diagnostic(user, result_id=rid, revision=2, start="l-greet", completed_at="2026-11-16T07:10:00Z")
    assert (await env.trajectory(user))["revision"] == 3
    history = await env.revisions(user)
    assert [(r[0], r[1]) for r in history] == [(1, "l-greet"), (2, "l-present"), (3, "l-past")]
    assert [r[2]["diagnostic_result_id"] for r in history] == [None, str(rid), str(retest)]
    events = await env.events(UPDATED, user)
    assert [e.payload["revision"] for e in events] == [1, 2, 3]
    assert events[1].payload["reason_codes"] == ["start_after_diagnostic"]


async def test_followup_revision_of_same_result(env, user) -> None:
    rid = await env.diagnostic(user, start="l-present", completed_at="2026-11-16T07:00:00Z")
    await env.trajectory(user, audience="adults")
    await env.diagnostic(user, result_id=rid, revision=2, start="l-routine", completed_at="2026-11-16T07:00:00Z",
                         level="A0", grammar="A0")
    body = await env.trajectory(user, audience="adults")
    # уточнение — ревизия того же результата; у routine не закрыта предпосылка present (A1 выше грамматики A0)
    assert body["revision"] == 2 and mandatory(body)[:2] == ["l-present", "l-routine"]
    assert [x["reason_codes"] for x in body["mandatory"][:2]] == [["prerequisite_missing"],
                                                                  ["start_after_diagnostic"]]
    assert body["next"]["explanation"]["ru"] == "Этот урок даёт навык, без которого следующие уроки будут трудными."
    [(revision,)] = await env.sql("SELECT revision FROM learner_diagnostics WHERE user_id = :u", u=user)
    assert revision == 2


async def test_skills_changes_skip_demonstrated(env, user) -> None:
    await env.profile(user)
    await env.trajectory(user)
    await env.skills(user, {"s.family": "learning", "s.listen": "not_started"})
    assert (await env.trajectory(user))["revision"] == 1  # освоенных не прибавилось — ревизии нет
    await env.skills(user, {"s.greet": "demonstrated", "s.be": "demonstrated"})
    body = await env.trajectory(user)
    assert body["revision"] == 2 and mandatory(body) == ADULT_CORE[2:]
    # опоздавшее старое изменение не откатывает освоение
    await env.skills(user, {"s.greet": "learning"}, occurred_at="2026-11-16T06:00:00Z")
    assert (await env.trajectory(user))["revision"] == 2
    rows = await env.sql("SELECT skill_id, state FROM skill_states WHERE user_id = :u ORDER BY skill_id", u=user)
    assert dict(rows) == {"s.be": "demonstrated", "s.family": "learning", "s.greet": "demonstrated",
                          "s.listen": "not_started"}


async def test_goal_and_topics_change_new_revision_history_kept(env, user) -> None:
    """AT-36: смена цели (PATCH плана) пересчитывает план при следующем чтении; история ревизий сохраняется."""
    await env.profile(user)
    first = await env.trajectory(user)
    assert first["optional"] == [] and first["basis"]["goal"] is None
    r = await env.c.patch("/internal/v1/me/plan", json={"goal": "work"}, headers=env.h(user))
    assert r.status_code == 200, r.text
    assert len(await env.events(UPDATED, user)) == 1  # PATCH сам не пересчитывает (без catalog)
    second = await env.trajectory(user)
    assert second["revision"] == 2 and second["basis"]["goal"] == "work"
    assert [x["lesson_id"] for x in second["optional"]] == ["l-interview", "l-office"]
    assert second["optional"][0]["reason_codes"] == ["goal_match"]
    r = await env.c.patch("/internal/v1/me/plan", json={"goal": "travel", "topics": ["food", "travel"]},
                          headers=env.h(user))
    assert r.status_code == 200, r.text
    third = await env.trajectory(user)
    assert third["revision"] == 3 and [x["lesson_id"] for x in third["optional"]] == ["l-cafe"]
    travel = next(x for x in third["mandatory"] if x["lesson_id"] == "l-travel")
    assert travel["reason_codes"] == ["next_in_course", "goal_match", "topic_match"]
    # смена языка интерфейса и графика траекторию не меняет
    r = await env.c.patch("/internal/v1/me/plan", json={"ui_lang": "uz", "schedule": {"preferred_time": "08:00"}},
                          headers=env.h(user))
    assert r.status_code == 200
    assert (await env.trajectory(user))["revision"] == 3
    history = await env.revisions(user)
    assert [r[2]["goal"] for r in history] == [None, "work", "travel"]
    assert history[2][2]["topics"] == ["food", "travel"]
    with pytest.raises(Exception, match="immutable"):
        await env.sql("UPDATE trajectories SET next_lesson_id = 'l-x' WHERE user_id = :u", u=user)


@pytest.mark.parametrize(
    ("profile", "hint", "expected"),
    [
        ({"kind": "child", "age_band": "6-9"}, None, "kids"),
        ({"kind": "child", "age_band": "10-13"}, "adults", "kids"),  # детский профиль подсказкой не повысить
        ({"kind": "account", "age_band": "14-17"}, None, "teens"),
        ({"kind": "account", "age_band": None}, None, "adults"),  # возраст не выбран — как ageSegment BFF
        ({"kind": "account", "age_band": "18+"}, "kids", "kids"),
        (None, "adults", "adults"),
        (None, None, "kids"),  # ничего не известно — только детские уроки
    ],
)
async def test_audience(env, user, profile: dict | None, hint: str | None, expected: str) -> None:
    if profile is not None:
        await env.profile(user, **profile)
    params = {"audience": hint} if hint else {}
    await env.c.patch("/internal/v1/me/plan", json={"goal": "work", "topics": ["movies"]}, headers=env.h(user))
    body = await env.trajectory(user, **params)
    [(basis,)] = await env.sql("SELECT basis FROM trajectories WHERE user_id = :u", u=user)
    assert basis["audience"] == expected
    lessons = {x["lesson_id"] for x in body["mandatory"] + body["optional"]}
    audience = {x["lesson_id"]: x["audience"] for x in course()["lessons"]}
    assert all(expected in audience[x] for x in lessons)
    if expected == "kids":
        assert mandatory(body) == KIDS_CORE and [x["lesson_id"] for x in body["optional"]] == ["l-song"]
        assert body["next"]["explanation"]["ru"] == "Начнём с самого начала — шаг за шагом."
    else:
        assert "l-animals" not in lessons and "l-song" not in lessons


async def test_profile_projection_rules(env, user) -> None:
    """Детский сегмент не понижается; обновление без возраста ничего не меняет; повзросление подростка — да."""
    child, teen = uuid.uuid4(), uuid.uuid4()
    await env.profile(child, kind="child", age_band="6-9")
    await env.publish("user.profile.updated.v1", {"user_id": str(child), "changed_fields": ["locale"],
                                                  "age_band": "18+", "is_minor": False}, producer="identity-consent")
    await env.profile(teen, age_band="14-17")
    await env.publish("user.profile.updated.v1", {"user_id": str(teen), "changed_fields": ["locale"],
                                                  "age_band": None}, producer="identity-consent")
    rows = dict(await env.sql("SELECT user_id, audience FROM learner_audience"))
    assert rows == {child: "kids", teen: "teens"}
    await env.publish("user.profile.updated.v1", {"user_id": str(teen), "changed_fields": ["age_band"],
                                                  "age_band": "18+", "is_minor": False}, producer="identity-consent")
    # чужой издатель профиля — без действия
    await env.publish("user.profile.updated.v1", {"user_id": str(user), "changed_fields": ["age_band"],
                                                  "age_band": "18+"}, producer="social")
    rows = dict(await env.sql("SELECT user_id, audience FROM learner_audience"))
    assert rows == {child: "kids", teen: "adults"}
    assert env.bus.dlq == []


async def test_learners_are_isolated(env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await env.profile(a)
    await env.profile(b)
    await env.diagnostic(a, start="l-past", grammar="A2")
    await env.skills(a, {"s.greet": "demonstrated"})
    body_a = await env.trajectory(a)
    body_b = await env.trajectory(b)
    assert body_a["next"]["lesson_id"] == "l-past" and body_b["next"]["lesson_id"] == "l-greet"
    assert body_b["basis"]["diagnostic_result_id"] is None and mandatory(body_b) == ADULT_CORE
    assert body_a["revision"] == body_b["revision"] == 1
    assert len(await env.events(UPDATED, a)) == len(await env.events(UPDATED, b)) == 1


async def test_consumers_dedup_foreign_and_invalid(env, user) -> None:
    rid = await env.diagnostic(user, producer="catalog")  # чужой издатель — без проекции
    assert await env.sql("SELECT 1 FROM learner_diagnostics") == []
    await env.skills(user, {"s.greet": "demonstrated"}, producer="identity-consent")
    assert await env.sql("SELECT 1 FROM skill_states") == []
    ev = await env.skills(user, {"s.be": "demonstrated"})
    spec = next(s for s in env.bus.specs if s.durable == "learning-plan.diagnostics")
    await spec.handler(ev)  # повтор доставки — inbox
    [(n,)] = await env.sql("SELECT count(*) FROM inbox WHERE event_id = :e", e=ev.event_id)
    assert n == 1
    # payload не по контракту → DLQ (схему обходим — так приходит битое сообщение)
    from tilhero_common.messaging import make_envelope

    bad = make_envelope("diagnostics.completed.v1", {"user_id": str(user), "pair_id": "ru-en"},
                        producer="diagnostics")
    await env.bus.publish(bad)
    assert [e.event_id for _, e in env.bus.dlq] == [bad.event_id]
    assert rid


async def test_deletion_removes_trajectories_and_projections(env, user) -> None:
    other = uuid.uuid4()
    for u in (user, other):
        await env.profile(u)
        await env.diagnostic(u)
        await env.skills(u, {"s.greet": "demonstrated"})
        await env.trajectory(u)
    await env.publish("user.deletion.requested.v1", {"user_id": str(user), "request_id": str(uuid.uuid4()),
                                                     "requested_at": "2026-11-18T09:00:00Z"},
                      producer="identity-consent")
    for table in ("trajectories", "learner_diagnostics", "skill_states", "learner_audience"):
        [(mine,)] = await env.sql(f"SELECT count(*) FROM {table} WHERE user_id = :u", u=user)  # noqa: S608
        [(theirs,)] = await env.sql(f"SELECT count(*) FROM {table} WHERE user_id = :u", u=other)  # noqa: S608
        assert (mine, theirs) == (0, 1), table
    body = await env.trajectory(user, expect=410)
    assert body["code"] == "USER_DELETED"
    # запоздавшие события удалённого ученика проекции не воскрешают
    await env.diagnostic(user)
    await env.skills(user, {"s.be": "demonstrated"})
    await env.profile(user)
    for table in ("learner_diagnostics", "skill_states", "learner_audience"):
        [(mine,)] = await env.sql(f"SELECT count(*) FROM {table} WHERE user_id = :u", u=user)  # noqa: S608
        assert mine == 0, table
    assert env.bus.dlq == []


async def test_stale_mark_set_during_fetch_is_kept(env, user) -> None:
    """Событие каталога, пришедшее во время запроса снимка, не теряется: пометка снимается, только если она
    поставлена до начала запроса."""
    from datetime import timedelta

    from tilhero_learning_plan.domain.trajectory import Fetched, store_snapshot

    await env.trajectory(user, audience="adults")
    etag = env.catalog.etag
    started = datetime.now(UTC) - timedelta(seconds=30)
    await env.sql("UPDATE course_snapshots SET stale_since = now()")  # пометка — после начала запроса
    async with env.runtime.transaction() as s:
        await store_snapshot(s, "en-core", Fetched(not_modified=True, etag=etag), started=started, etag_sent=etag)
    [(stale,)] = await env.sql("SELECT stale_since FROM course_snapshots")
    assert stale is not None
    async with env.runtime.transaction() as s:  # запрос начат после пометки — снимается
        await store_snapshot(s, "en-core", Fetched(not_modified=True, etag=etag), started=datetime.now(UTC),
                             etag_sent=etag)
    [(stale,)] = await env.sql("SELECT stale_since FROM course_snapshots")
    assert stale is None


async def test_snapshot_max_age_zero_always_revalidates(env, user) -> None:
    env.settings.catalog_snapshot_max_age_seconds = 0
    await env.trajectory(user, audience="adults")
    await env.trajectory(user, audience="adults")
    assert [c["if_none_match"] for c in env.catalog.calls] == [None, env.catalog.etag]


def test_settings_pairs() -> None:
    from conftest import make_settings

    s = make_settings(pair_courses='{"ru-en": "en-core", "ru-uz": "uz-core"}')
    assert s.pair_courses == {"ru-en": "en-core", "ru-uz": "uz-core"}
    with pytest.raises(ValueError, match="DEFAULT_PAIR"):
        make_settings(default_pair="ru-kk")


async def test_invalid_cached_snapshot_is_refetched(env, user) -> None:
    """Кеш, не проходящий проверку CourseSnapshot (например, после смены модели), не используется: безусловный
    запрос и замена; catalog при этом недоступен — 503, а не расчёт по битому кешу."""
    await env.trajectory(user, audience="adults")
    await env.sql("UPDATE course_snapshots SET payload = '{\"course_id\": \"en-core\"}'::jsonb")
    env.catalog.down = True
    assert (await env.trajectory(user, audience="adults", expect=503))["code"] == "CATALOG_UNAVAILABLE"
    assert env.catalog.calls[-1]["if_none_match"] is None
    env.catalog.down = False
    body = await env.trajectory(user, audience="adults")
    assert body["revision"] == 1 and env.catalog.calls[-1]["if_none_match"] is None
    [(version,)] = await env.sql("SELECT payload->>'snapshot_version' FROM course_snapshots")
    assert version == "snap-1"

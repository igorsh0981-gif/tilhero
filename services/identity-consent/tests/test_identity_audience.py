"""Аудитория рассылок (спринт 2, INTERNAL_API §3, admin.ts CampaignSegment): кого можно звать в рассылку
«Новости TilHero» — правила исключения, фильтры языка, возраста, онбординга и активности, пагинация, доступ."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from admin_kit import (
    AUDIENCE,
    AUDIENCE_COUNT,
    NEWS,
    activity_recorded,
    bff,
    delete_completely,
    news_reader,
    news_teen,
    notif,
    plan_updated,
    set_categories,
    ua,
)
from conftest import REQUIRED
from sqlalchemy import update

from tilhero_common.testing import internal_headers
from tilhero_identity.models import User


async def _ids(env, **params) -> list[str]:
    """Вся аудитория по сегменту (с проходом по курсору) — список user_id."""
    out: list[str] = []
    cursor = None
    for _ in range(50):
        query = {**params, **({"cursor": cursor} if cursor else {})}
        r = await env.client.get(AUDIENCE, params=query, headers=notif(env))
        assert r.status_code == 200, r.text
        body = r.json()
        for item in body["items"]:
            assert set(item) == {"user_id", "locale"}  # только адресация: без имени, username и Telegram ID
        out += [i["user_id"] for i in body["items"]]
        cursor = body["next_cursor"]
        if not cursor:
            return out
    raise AssertionError("pagination did not finish")


async def _count(env, **params) -> dict:
    r = await env.client.get(AUDIENCE_COUNT, params=params, headers=notif(env))
    assert r.status_code == 200, r.text
    return r.json()


async def _set_age_band(env, uid: str, age_band: str | None) -> None:
    async with env.runtime.transaction() as s:
        await s.execute(update(User).where(User.user_id == uuid.UUID(uid)).values(age_band=age_band))


# ---------------------------------------------------------------- happy path и правила исключения

async def test_audience_default_is_adults_with_news_consent(env) -> None:
    adult = await news_reader(env)
    adult_uz = await news_reader(env, locale="uz")
    teen = await news_teen(env, adult)  # подросток с согласием родителя — только при явном age=teens
    r = await env.client.get(AUDIENCE, headers=notif(env))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["next_cursor"] is None
    assert sorted(body["items"], key=lambda i: i["user_id"]) == sorted(
        [{"user_id": adult, "locale": "ru"}, {"user_id": adult_uz, "locale": "uz"}], key=lambda i: i["user_id"])
    assert [i["user_id"] for i in body["items"]] == sorted(i["user_id"] for i in body["items"])  # порядок курсора
    assert teen not in await _ids(env)
    assert await _count(env) == {"count": 2, "by_lang": {"ru": 1, "uz": 1}}


async def test_audience_exclusions(env) -> None:
    included = await news_reader(env)
    excluded: dict[str, str] = {}

    # детский профиль 6–13 — никогда (даже если у ребёнка включена категория product)
    child = (await env.child(included))["learner_id"]
    r = await env.call("PATCH", f"/internal/v1/me/learners/{child}", included,
                       {"settings": {"categories": {"product": True}}})
    assert r.status_code == 200, r.text
    excluded["child"] = child
    # отключил TilHero (DISABLED)
    disabled = await news_reader(env)
    assert (await env.call("POST", "/internal/v1/me/disable", disabled)).status_code == 200
    excluded["disabled"] = disabled
    # удаляется (DELETION_REQUESTED) и удалён (DELETED)
    deleting = await news_reader(env)
    r = await env.call("POST", "/internal/v1/me/deletion-request", deleting, {"confirm_word": "УДАЛИТЬ"})
    assert r.status_code == 202, r.text
    excluded["deletion_requested"] = deleting
    deleted = await news_reader(env)
    await delete_completely(env, deleted)
    excluded["deleted"] = deleted
    # без согласия вовсе
    no_consent = await env.adult()
    await set_categories(env, no_consent, product=True)
    excluded["no_consent"] = no_consent
    # согласие без цели product_news
    no_news = await env.adult()
    assert (await env.consent(no_news, list(REQUIRED))).status_code == 200
    await set_categories(env, no_news, product=True)
    excluded["no_product_news"] = no_news
    # согласие с product_news отозвано
    revoked = await news_reader(env)
    assert (await env.call("DELETE", "/internal/v1/me/consent", revoked)).status_code == 200
    excluded["revoked"] = revoked
    # цель product_news снята новым согласием
    narrowed = await news_reader(env)
    assert (await env.consent(narrowed, list(REQUIRED))).status_code == 200
    excluded["narrowed"] = narrowed
    # категория product выключена (admin.ts CampaignSegment: только с включённой категорией product)
    no_category = await news_reader(env)
    await set_categories(env, no_category, product=False)
    excluded["no_product_category"] = no_category
    # подросток без согласия родителя (pending) и с отказом родителя
    pending_teen = await news_teen(env, included, granted=False)
    excluded["teen_pending"] = pending_teen
    revoked_teen = await news_teen(env, included)
    r = await env.call("POST", f"/internal/v1/me/guardian-consents/{revoked_teen}:revoke", included)
    assert r.status_code == 200, r.text
    excluded["teen_guardian_revoked"] = revoked_teen
    # подросток с целью product_news, но согласие родителя не granted (только это условие и нарушено)
    teen_flag_only = await news_teen(env, included)
    async with env.runtime.transaction() as s:
        await s.execute(update(User).where(User.user_id == uuid.UUID(teen_flag_only))
                        .values(guardian_consent="pending"))
    excluded["teen_without_guardian_granted"] = teen_flag_only
    # возраст не выбран (согласие с product_news получено, затем возраст стёрт — так бывает только в обход API)
    no_age = await news_reader(env)
    await _set_age_band(env, no_age, None)
    excluded["no_age_band"] = no_age

    for age in (None, "adults", "teens", "teens,adults"):
        params = {"age": age} if age else {}
        found = await _ids(env, **params)
        for reason, uid in excluded.items():
            assert uid not in found, (age, reason)
        assert (included in found) == (age != "teens"), age
        count = await _count(env, **params)
        assert count["count"] == len(found) and count["by_lang"]["ru"] + count["by_lang"]["uz"] == len(found)

    # notifications всё равно перепроверит согласие и категорию при создании уведомления; здесь — честная оценка
    assert await _count(env) == {"count": 1, "by_lang": {"ru": 1, "uz": 0}}


async def test_audience_teens_only_when_requested_and_granted(env) -> None:
    parent = await news_reader(env)
    teen = await news_teen(env, parent)
    assert await _ids(env) == [parent]
    assert await _ids(env, age="teens") == [teen]
    assert sorted(await _ids(env, age="teens,adults")) == sorted([parent, teen])
    assert sorted(await _ids(env, age=["teens", "adults"])) == sorted([parent, teen])  # повтор параметра
    assert (await _count(env, age="teens"))["count"] == 1


async def test_audience_language_filter(env) -> None:
    ru = await news_reader(env)
    uz = await news_reader(env, locale="uz")
    assert await _ids(env, ui_lang="ru") == [ru]
    assert await _ids(env, ui_lang="uz") == [uz]
    assert sorted(await _ids(env, ui_lang="ru,uz")) == sorted([ru, uz])
    assert sorted(await _ids(env, ui_lang=["uz", "ru"])) == sorted([ru, uz])
    assert sorted(await _ids(env, ui_lang="")) == sorted([ru, uz])  # пусто — фильтр не задан
    assert await _count(env, ui_lang="uz") == {"count": 1, "by_lang": {"ru": 0, "uz": 1}}
    r = await env.client.get(AUDIENCE, params={"ui_lang": "uz"}, headers=notif(env))
    assert r.json()["items"] == [{"user_id": uz, "locale": "uz"}]


async def test_audience_onboarding_and_activity_filters(env) -> None:
    now = datetime.now(UTC)
    onboarded_active = await news_reader(env)
    onboarded_idle = await news_reader(env)
    not_onboarded = await news_reader(env)
    never = await news_reader(env)  # ни плана, ни занятий — строки проекции нет
    for uid in (onboarded_active, onboarded_idle):
        await env.bus.publish(plan_updated(uid, onboarding_completed=True))
    await env.bus.publish(plan_updated(not_onboarded, onboarding_completed=False))
    await env.bus.publish(activity_recorded(onboarded_active, now - timedelta(days=2)))
    await env.bus.publish(activity_recorded(onboarded_idle, now - timedelta(days=20)))
    await env.bus.publish(activity_recorded(not_onboarded, now - timedelta(hours=1)))
    assert not env.bus.dlq

    assert sorted(await _ids(env, onboarded="true")) == sorted([onboarded_active, onboarded_idle])
    assert sorted(await _ids(env, onboarded="false")) == sorted([not_onboarded, never])
    assert sorted(await _ids(env, active_days="7")) == sorted([onboarded_active, not_onboarded])
    assert sorted(await _ids(env, active_days="+7")) == sorted([onboarded_active, not_onboarded])
    assert sorted(await _ids(env, active_days="30")) == sorted([onboarded_active, onboarded_idle, not_onboarded])
    # не занимались N дней или никогда
    assert sorted(await _ids(env, active_days="-7")) == sorted([onboarded_idle, never])
    assert sorted(await _ids(env, active_days="-30")) == [never]
    # фильтры складываются
    assert await _ids(env, onboarded="true", active_days="-7") == [onboarded_idle]
    assert await _ids(env, onboarded="false", active_days="1") == [not_onboarded]
    assert (await _count(env, onboarded="true", active_days="7"))["count"] == 1
    # граница — от часов сервиса: через 6 дней занятие «2 дня назад» уже вне окна 7 дней, «час назад» — ещё в нём
    env.set_clock(now + timedelta(days=6))
    try:
        assert await _ids(env, active_days="7") == [not_onboarded]
        assert sorted(await _ids(env, active_days="-7")) == sorted([onboarded_active, onboarded_idle, never])
    finally:
        env.set_clock(None)


async def test_audience_pagination(env) -> None:
    users = [await news_reader(env, locale="uz" if i % 2 else "ru") for i in range(7)]
    first = await env.client.get(AUDIENCE, params={"limit": 3}, headers=notif(env))
    assert first.status_code == 200, first.text
    assert len(first.json()["items"]) == 3 and first.json()["next_cursor"]
    seen = await _ids(env, limit=3)
    assert seen == sorted(users) and len(set(seen)) == 7
    assert (await _ids(env, limit=7)) == sorted(users)
    exact = await env.client.get(AUDIENCE, params={"limit": 7}, headers=notif(env))
    assert exact.json()["next_cursor"] is None  # ровно на странице — следующей нет
    assert await _count(env) == {"count": 7, "by_lang": {"ru": 4, "uz": 3}}
    assert (await env.client.get(AUDIENCE, params={"limit": 500}, headers=notif(env))).status_code == 200


async def test_audience_empty(env) -> None:
    await env.adult()
    r = await env.client.get(AUDIENCE, headers=notif(env))
    assert r.status_code == 200 and r.json() == {"items": [], "next_cursor": None}
    assert await _count(env) == {"count": 0, "by_lang": {"ru": 0, "uz": 0}}


# ---------------------------------------------------------------- 422 / 400

async def test_audience_validation(env) -> None:
    await news_reader(env)
    cases = [
        ({"age": "kids"}, "age", "kids_not_allowed"),
        ({"age": "teens,kids"}, "age", "kids_not_allowed"),
        ({"age": "seniors"}, "age", "unknown_value"),
        ({"ui_lang": "en"}, "ui_lang", "unknown_value"),
        ({"ui_lang": "ru,xx"}, "ui_lang", "unknown_value"),
        ({"onboarded": "yes"}, "onboarded", "format"),
        ({"active_days": "0"}, "active_days", "range"),
        ({"active_days": "91"}, "active_days", "range"),
        ({"active_days": "-91"}, "active_days", "range"),
        ({"active_days": "7d"}, "active_days", "format"),
        ({"active_days": "1.5"}, "active_days", "format"),
    ]
    for path in (AUDIENCE, AUDIENCE_COUNT):
        for params, field, reason in cases:
            r = await env.client.get(path, params=params, headers=notif(env))
            assert r.status_code == 422, (path, params, r.text)
            assert r.json()["code"] == "SEGMENT_INVALID" and r.json()["details"] == {"field": field, "reason": reason}
    for params in ({"limit": 0}, {"limit": 501}, {"limit": "x"}, {"onboarded": "x" * 9}, {"cursor": "c" * 129}):
        r = await env.client.get(AUDIENCE, params=params, headers=notif(env))
        assert r.status_code == 422, params
    for cursor in ("%%%", "e30", "eyJ1Ijoibm90LWEtdXVpZCJ9"):
        r = await env.client.get(AUDIENCE, params={"cursor": cursor}, headers=notif(env))
        assert r.status_code == 400 and r.json()["code"] == "INVALID_CURSOR", cursor
    # граничные значения принимаются
    for params in ({"active_days": "90"}, {"active_days": "-90"}, {"active_days": "1"}, {"onboarded": "TRUE"},
                   {"age": "Adults"}, {"limit": 1}):
        assert (await env.client.get(AUDIENCE, params=params, headers=notif(env))).status_code == 200, params


# ---------------------------------------------------------------- доступ

async def test_audience_auth(env) -> None:
    uid = await news_reader(env)
    for path in (AUDIENCE, AUDIENCE_COUNT):
        assert (await env.client.get(path)).status_code == 401
        assert (await env.client.get(path, headers={"x-internal-token": "garbage"})).status_code == 401
        for issuer in ("telegram-bff", "admin-bff", "user-admin", "social", "learning-plan", "support"):
            r = await env.client.get(path, headers=internal_headers(env.settings, issuer=issuer))
            assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", (path, issuer)
        assert (await env.client.get(path, headers=bff(env))).status_code == 403
        assert (await env.client.get(path, headers=ua(env))).status_code == 403
        # контекст ученика в вызове notifications не допускается (выборка — только по сегменту)
        r = await env.client.get(path, headers=notif(env, subject=uid))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_CONTEXT_NOT_ALLOWED"
        # токен для другого сервиса (aud) не принимается
        r = await env.client.get(path, headers=internal_headers(env.settings, issuer="notifications",
                                                                audience="notifications"))
        assert r.status_code == 401


async def test_audience_consent_purposes_match_delivery(env) -> None:
    """Аудитория согласована с DeliveryInfo: у каждого найденного категория product есть в категориях доставки."""
    parent = await news_reader(env)
    teen = await news_teen(env, parent)
    for uid in await _ids(env, age="teens,adults"):
        r = await env.delivery(uid)
        assert r.status_code == 200 and "product" in r.json()["categories"], uid
    assert sorted(await _ids(env, age="teens,adults")) == sorted([parent, teen])
    assert NEWS[-1] == "product_news"

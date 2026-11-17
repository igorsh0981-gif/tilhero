"""Дайджест (спринт 6, INTERNAL_API §5): накопление kind=digest, отправка в digest_time пользователя,
часовые пояса, тихие часы (в т.ч. через полночь), пусто, дубли, повторы прогона, две реплики, API планировщика."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from notif_testkit import CRIT_PARAMS, EVENT_ID, SCHEDULER_TOKEN
from sqlalchemy import select, update

from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms, internal_headers
from tilhero_notifications import store
from tilhero_notifications.digest import DigestRunner, compose, digest_ids, digest_slot, split_quota, user_digest_time
from tilhero_notifications.models import DigestItem, Notification

TASHKENT, NEW_YORK = ZoneInfo("Asia/Tashkent"), ZoneInfo("America/New_York")
WINDOW = timedelta(minutes=120)
F1 = "0b6f3c2a-8d1e-4f5a-9b7c-1e2d3f4a5b6c"


def utc(tz: ZoneInfo, y: int, mo: int, d: int, h: int, mi: int = 0) -> datetime:
    return datetime(y, mo, d, h, mi, tzinfo=tz).astimezone(UTC)


def drop(event_id: str = F1, title: str = "Formula 1 Abu Dhabi GP", price: str = "1650", amount: str = "120") -> dict:
    return {"event_id": event_id, "event_title": title, "tier": "comfort", "price_usd": price, "drop_usd": amount}


def news_item(i: int, news_id: str | None = None) -> dict[str, Any]:
    item: dict[str, Any] = {
        "title": f"Новость {i}",
        "source": {"name": "Formula 1", "domain": "formula1.com", "url": f"https://www.formula1.com/n/{i}"},
    }
    if news_id:
        item["news_id"] = news_id
    return item


def pending(section: str, params: dict, minute: int) -> store.PendingItem:
    return store.PendingItem(
        uuid.uuid4(), section, "watch.price_drop" if section == "watch" else "news.digest", params,
        datetime(2026, 10, 11, 8, minute, tzinfo=UTC),
    )


# ---------------------------------------------------------------- чистые функции


def test_digest_slot_window_and_timezones() -> None:
    nine = time(9, 0)
    assert digest_slot(utc(TASHKENT, 2026, 10, 12, 8, 59), nine, TASHKENT, WINDOW) == (
        None, utc(TASHKENT, 2026, 10, 12, 9))
    assert digest_slot(utc(TASHKENT, 2026, 10, 12, 9), nine, TASHKENT, WINDOW)[0] == date(2026, 10, 12)
    assert digest_slot(utc(TASHKENT, 2026, 10, 12, 10, 59), nine, TASHKENT, WINDOW)[0] == date(2026, 10, 12)
    # окно закончилось — следующий раз завтра (пункты, пришедшие днём, ждут утра)
    assert digest_slot(utc(TASHKENT, 2026, 10, 12, 11), nine, TASHKENT, WINDOW) == (
        None, utc(TASHKENT, 2026, 10, 13, 9))
    # один и тот же момент UTC: в Ташкенте 09:05 (пора), в Нью-Йорке 00:05 (ещё нет)
    now = utc(TASHKENT, 2026, 10, 12, 9, 5)
    assert digest_slot(now, nine, TASHKENT, WINDOW)[0] == date(2026, 10, 12)
    assert digest_slot(now, nine, NEW_YORK, WINDOW) == (None, utc(NEW_YORK, 2026, 10, 12, 9))
    # переход на зимнее время в Нью-Йорке (1 ноября 2026): 09:00 местного = 14:00 UTC, накануне — 13:00 UTC
    assert utc(NEW_YORK, 2026, 10, 31, 9).hour == 13 and utc(NEW_YORK, 2026, 11, 1, 9).hour == 14
    assert digest_slot(datetime(2026, 11, 1, 13, 30, tzinfo=UTC), nine, NEW_YORK, WINDOW) == (
        None, datetime(2026, 11, 1, 14, 0, tzinfo=UTC))
    # окно через полночь: digest_time 23:30, сейчас 00:30 следующего дня — дайджест за вчерашний день
    late = time(23, 30)
    assert digest_slot(utc(TASHKENT, 2026, 10, 13, 0, 30), late, TASHKENT, WINDOW)[0] == date(2026, 10, 12)
    assert digest_slot(utc(TASHKENT, 2026, 10, 13, 1, 30), late, TASHKENT, WINDOW) == (
        None, utc(TASHKENT, 2026, 10, 13, 23, 30))
    # граничные пояса: +14 и −11 — разные локальные даты в один момент
    kiri, pago = ZoneInfo("Pacific/Kiritimati"), ZoneInfo("Pacific/Pago_Pago")
    instant = datetime(2026, 10, 12, 19, 30, tzinfo=UTC)
    assert digest_slot(instant, time(9, 0), kiri, WINDOW)[0] == date(2026, 10, 13)
    assert digest_slot(instant, time(8, 0), pago, WINDOW)[0] == date(2026, 10, 12)


def test_digest_time_fallback_and_ids() -> None:
    assert user_digest_time("07:45", "09:00") == time(7, 45)
    assert user_digest_time(None, "09:00") == time(9, 0)
    assert user_digest_time("25:00", "bad") == time(9, 0)
    user = uuid.uuid4()
    a, key = digest_ids(user, date(2026, 10, 12))
    assert a == digest_ids(user, date(2026, 10, 12))[0] != digest_ids(user, date(2026, 10, 13))[0]
    assert key == f"digest.daily:{user}:2026-10-12"


def test_split_quota() -> None:
    assert split_quota(8, 8) == (5, 5)
    assert split_quota(3, 20) == (3, 7)
    assert split_quota(20, 1) == (9, 1)
    assert split_quota(0, 15) == (0, 10)
    assert split_quota(0, 0) == (0, 0)


def test_compose_merges_dedups_and_limits() -> None:
    day = date(2026, 10, 12)
    items = [
        pending("watch", drop(amount="50", price="1800"), 1),
        pending("watch", drop(amount="70", price="1730"), 2),  # то же событие: цена последняя, снижения суммируются
        pending("watch", drop(EVENT_ID, "Desert Sounds", "900", "200"), 3),
        pending("news", {"items": [news_item(1, F1), news_item(2)]}, 4),
        pending("news", {"items": [news_item(3), news_item(1, F1)]}, 5),  # повтор новости F1 — один раз
        pending("watch", {"event_id": "bad"}, 6),  # невалидный пункт пропускается
    ]
    params = compose(items, day)
    assert params is not None and params["date"] == "2026-10-12" and params["more"] == 0
    assert [(w["event_title"], w["price_usd"], w["drop_usd"]) for w in params["watch"]] == [
        ("Desert Sounds", "900", "200"),  # по убыванию снижения
        ("Formula 1 Abu Dhabi GP", "1730", "120"),
    ]
    assert [n["title"] for n in params["news"]] == ["Новость 3", "Новость 1", "Новость 2"]  # новые сверху
    many = [pending("watch", drop(str(uuid.uuid4()), f"E{i}", amount=str(10 + i)), i) for i in range(8)]
    many += [pending("news", {"items": [news_item(i) for i in range(10)]}, 30)]
    params = compose(many, day)
    assert params is not None and len(params["watch"]) == 5 and len(params["news"]) == 5 and params["more"] == 8
    assert compose([], day) is None
    assert compose([pending("news", {"items": [{"title": "без источника"}]}, 1)], day) is None


def test_requested_payloads_conform_to_event_contract() -> None:
    """watch/news публикуют notification.requested.v1 с этими params (README, INTERNAL_API §2.3, §3.3, §5)."""
    base = {"notification_id": str(uuid.uuid4()), "user_id": str(uuid.uuid4())}
    for kind, template, params, dedup in (
        ("critical", "watch.critical", {**CRIT_PARAMS, "watch_id": str(uuid.uuid4())}, "watch:w1:lifecycle:CANCELLED"),
        ("digest", "watch.price_drop", drop(), "watch:w1:price_drop:1650"),
        ("digest", "news.digest", {"items": [news_item(1, F1)]}, "news.digest:u1:2026-10-12"),
    ):
        payload = {**base, "kind": kind, "template": template, "params": params, "dedup_key": dedup}
        assert_event_conforms(make_envelope("notification.requested.v1", payload, producer=template.split(".")[0]))


# ---------------------------------------------------------------- сервис


async def queue(env, user_id: uuid.UUID | None = None) -> list[DigestItem]:
    async with env.runtime.transaction() as s:
        stmt = select(DigestItem).order_by(DigestItem.created_at)
        if user_id:
            stmt = stmt.where(DigestItem.user_id == user_id)
        return list((await s.execute(stmt)).scalars().all())


async def price_drop(env, user, **kw) -> uuid.UUID:
    params = kw.pop("params", None) or drop()
    return await env.request(user, "watch.price_drop", params, kind="digest", **kw)


async def news(env, user, items: list[dict], **kw) -> uuid.UUID:
    return await env.request(user, "news.digest", {"items": items}, kind="digest", **kw)


async def test_digest_items_accumulate_and_go_out_once_at_digest_time(env) -> None:
    user = env.add_user(digest_time="09:00")
    await price_drop(env, user, dedup_key="watch:w1:price_drop:1650")
    await news(env, user, [news_item(1, F1), news_item(2)])
    await env.dispatch()
    assert env.gateway.calls == [] and await env.rows(user) == []  # по одному не отправляется
    assert len(await queue(env, user)) == 2

    before = utc(TASHKENT, 2026, 10, 12, 8, 50)
    r = await env.digest.run(before)
    assert (r.digests, r.postponed) == (0, 1)
    assert {i.not_before for i in await queue(env, user)} == {utc(TASHKENT, 2026, 10, 12, 9)}
    assert (await env.digest.run(before + timedelta(minutes=5))).users == 0  # not_before ещё не наступил

    at = utc(TASHKENT, 2026, 10, 12, 9, 5)
    r = await env.digest.run(at)
    assert (r.digests, r.items) == (1, 3)
    assert await env.dispatch(at) == 1
    [msg] = env.gateway.calls
    assert msg["text"].startswith("<b>Дайджест TilHero</b>\n\n<b>Слежения</b>\n• <b>Formula 1 Abu Dhabi GP</b>")
    assert "<b>Новости</b>" in msg["text"] and msg["text"].count("• ") == 3
    assert msg["buttons"] == [[{"text": "Слежения", "startapp": "watch"}, {"text": "Все новости", "startapp": "news"}]]
    [row] = await env.rows(user)
    digest_id, _ = digest_ids(user, date(2026, 10, 12))
    assert (row.notification_id, row.kind, row.template, row.status, row.params) == (
        digest_id, "digest", "digest.daily", "sent", None)
    assert all(i.digest_id == digest_id and i.params is None for i in await queue(env, user))

    # повтор прогона в тот же день — второго дайджеста нет; новый пункт ждёт завтрашнего digest_time
    await price_drop(env, user, params=drop(price="1600", amount="50"))
    r = await env.digest.run(at + timedelta(minutes=15))
    assert (r.digests, r.postponed) == (0, 1)
    [late] = [i for i in await queue(env, user) if i.digest_id is None]
    assert late.not_before == at + timedelta(minutes=15) + timedelta(minutes=60)  # перечитать настройки через час
    assert (await env.digest.run(utc(TASHKENT, 2026, 10, 12, 18))).digests == 0  # вне окна
    r = await env.digest.run(utc(TASHKENT, 2026, 10, 13, 9, 1))
    assert r.digests == 1 and await env.dispatch(utc(TASHKENT, 2026, 10, 13, 9, 1)) == 1
    assert len(env.gateway.calls) == 2 and "−$50 → Comfort $1 600" in env.gateway.calls[1]["text"]


async def test_user_timezone_and_digest_time(env) -> None:
    tashkent = env.add_user(digest_time="09:00", tz="Asia/Tashkent")
    new_york = env.add_user(digest_time="09:00", tz="America/New_York", locale="en")
    early = env.add_user(digest_time="07:30", tz="Asia/Tashkent")
    unknown_tz = env.add_user(digest_time=None, tz="Mars/Base")  # → Asia/Tashkent, 09:00
    for u in (tashkent, new_york, early, unknown_tz):
        await price_drop(env, u)
    r = await env.digest.run(utc(TASHKENT, 2026, 10, 12, 7, 35))
    assert (r.users, r.digests) == (4, 1)
    r = await env.digest.run(utc(TASHKENT, 2026, 10, 12, 9, 0))
    assert r.digests == 2  # Ташкент и неизвестная зона; Нью-Йорк — ночь
    assert {x.user_id for x in await env.rows()} == {early, tashkent, unknown_tz}
    r = await env.digest.run(utc(NEW_YORK, 2026, 10, 12, 9, 10))
    assert r.digests == 1
    await env.dispatch(utc(NEW_YORK, 2026, 10, 12, 9, 10))
    ny = [c for c in env.gateway.calls if c["telegram_user_id"] == env.telegram_id(new_york)]
    assert ny and ny[0]["text"].startswith("<b>TilHero digest</b>\n\n<b>Watching</b>")
    assert ny[0]["buttons"][0] == [{"text": "Open event", "startapp": f"event_{F1}"}]


async def test_quiet_hours_through_midnight_defer_digest_but_not_critical(env) -> None:
    quiet = {"start": "23:00", "end": "07:00"}
    user = env.add_user(digest_time="23:30", quiet=quiet)
    await news(env, user, [news_item(1)])
    at = utc(TASHKENT, 2026, 10, 12, 23, 35)
    assert (await env.digest.run(at)).digests == 1
    await env.dispatch(at)
    [row] = await env.rows(user)
    morning = utc(TASHKENT, 2026, 10, 13, 7)
    assert (row.status, row.scheduled_for) == ("scheduled", morning)  # дайджест ждёт конца тихих часов
    # критичное — сразу, в тихие часы (через полночь)
    crit = await env.critical(user)
    # критичное ставится на настоящее «сейчас»; закрепляем его на 00:25 сценария — иначе после 00:30 13.10 Ташкента
    # (реальное время) прогон «в 00:30» его не видит и тест падает по часам
    async with env.runtime.transaction() as s:
        await s.execute(update(Notification).where(Notification.notification_id == crit)
                        .values(next_attempt_at=utc(TASHKENT, 2026, 10, 13, 0, 25)))
    assert await env.dispatch(utc(TASHKENT, 2026, 10, 13, 0, 30)) == 1
    assert (await env.row(crit)).status == "sent" and len(env.gateway.calls) == 1
    assert await env.dispatch(morning - timedelta(seconds=1)) == 0
    assert await env.dispatch(morning) == 1
    assert (await env.row(row.notification_id)).status == "sent" and len(env.gateway.calls) == 2
    # повтор прогона в 00:30 (окно перешло через полночь) — тот же день дайджеста, второго нет
    assert (await env.digest.run(utc(TASHKENT, 2026, 10, 13, 0, 30))).digests == 0


async def test_disabled_notifications_skip_critical_and_digest(env) -> None:
    off = env.add_user(enabled=False)
    crit = await env.critical(off)
    await price_drop(env, off)
    at = utc(TASHKENT, 2026, 10, 12, 9, 5)
    assert (await env.digest.run(at)).digests == 1
    # критическое поставлено на настоящее «сейчас»: прогон не раньше него (иначе падает после 09:05 12.10 Ташкента)
    await env.dispatch(max(at, datetime.now(UTC)))
    assert env.gateway.calls == []
    reasons = {r.template: (r.status, r.failure_reason) for r in await env.rows(off)}
    assert reasons == {
        "watch.critical": ("skipped", "notifications_disabled"),
        "digest.daily": ("skipped", "notifications_disabled"),
    }
    assert (await env.row(crit)).params is None


async def test_empty_digest_not_sent_and_missing_user_dropped(env) -> None:
    user = env.add_user()
    at = utc(TASHKENT, 2026, 10, 12, 9, 5)
    r = await env.digest.run(at)
    assert (r.users, r.digests) == (0, 0) and await env.dispatch(at) == 0
    ghost = uuid.uuid4()  # identity-consent: 404
    await price_drop(env, ghost)
    await price_drop(env, user)
    r = await env.digest.run(at)
    assert (r.users, r.digests) == (2, 1)
    assert [i.user_id for i in await queue(env)] == [user]  # пункты исчезнувшего пользователя не копятся
    # identity недоступен — пункты остаются до следующего прогона
    other = env.add_user()
    await price_drop(env, other)
    env.identity.fail = [503, 503, 503]
    r = await env.digest.run(at + timedelta(minutes=1))
    assert r.errors == 1 and r.digests == 0
    assert [i.digest_id for i in await queue(env, other)] == [None]
    assert (await env.digest.run(at + timedelta(minutes=16))).digests == 1


async def test_duplicates_repeats_and_two_replicas(env) -> None:
    user = env.add_user()
    nid = await price_drop(env, user, dedup_key="watch:w1:price_drop:1650")
    await price_drop(env, user, dedup_key="watch:w1:price_drop:1650")  # повтор перепроверки: другой id
    await price_drop(env, user, dedup_key="other", notification_id=nid)  # повтор того же notification_id
    spec = next(s for s in env.bus.specs if s.durable == "notifications.requests")
    replay = make_envelope(
        "notification.requested.v1",
        {"notification_id": str(uuid.uuid4()), "user_id": str(user), "kind": "digest", "template": "news.digest",
         "params": {"items": [news_item(1)]}, "dedup_key": "news:1"},
        producer="news",
    )
    await env.bus.publish(replay)
    await spec.handler(replay)  # повторная доставка того же события
    assert len(await queue(env, user)) == 2
    # пункт, уже отправленный отдельным уведомлением с тем же dedup_key, в дайджест не попадает
    await env.critical(user, dedup_key="watch:w2:lifecycle:CANCELLED")
    await price_drop(env, user, dedup_key="watch:w2:lifecycle:CANCELLED")
    assert len(await queue(env, user)) == 2

    at = utc(TASHKENT, 2026, 10, 12, 9, 5)
    replica = DigestRunner(env.runtime, env.dispatcher)
    results = await asyncio.gather(env.digest.run(at), replica.run(at), env.digest.run(at))
    assert sum(r.digests for r in results) == 1
    await env.dispatch(at)
    await env.dispatch(at)
    digests = [c for c in env.gateway.calls if c["text"].startswith("<b>Дайджест")]
    assert len(digests) == 1 and digests[0]["text"].count("• ") == 2


async def test_more_than_ten_items(env) -> None:
    user = env.add_user()
    for i in range(7):
        await price_drop(env, user, params=drop(str(uuid.uuid4()), f"Event {i}", amount=str(10 + i)))
    await news(env, user, [news_item(i) for i in range(10)])
    await news(env, user, [news_item(i + 10) for i in range(3)])
    at = utc(TASHKENT, 2026, 10, 12, 9, 5)
    assert (await env.digest.run(at)).items == 10
    await env.dispatch(at)
    [msg] = env.gateway.calls
    assert msg["text"].count("• ") == 10 and msg["text"].endswith("Ещё 10 — в приложении.")
    assert all(i.digest_id is not None for i in await queue(env, user))


async def test_rejected_digest_requests_and_deletion(env) -> None:
    user = env.add_user()
    unsupported = await env.request(user, "watch.critical", CRIT_PARAMS, kind="digest")
    internal = await env.request(
        user, "digest.daily", {"date": "2026-10-12", "watch": [drop()]}, kind="critical"
    )
    no_source = await env.request(user, "news.digest", {"items": [{"title": "x"}]}, kind="digest")
    for nid, reason in ((unsupported, "digest_unsupported"), (internal, "internal_only"),
                        (no_source, "params_invalid")):
        row = await env.row(nid)
        assert (row.status, row.failure_reason, row.params) == ("failed", reason, None)
    assert await queue(env, user) == []
    await price_drop(env, user)
    await env.publish(
        "user.deletion.requested.v1",
        {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-10-12T10:00:00Z"},
    )
    assert await queue(env, user) == [] and await env.rows(user) == []
    await price_drop(env, user)  # запоздавший пункт удалённого пользователя
    assert await queue(env, user) == []


async def test_digest_endpoint_auth_and_idempotency(env) -> None:
    path = "/internal/v1/notifications:digest"
    assert (await env.client.post(path)).status_code == 401
    wrong = await env.client.post(path, headers={"Authorization": "Bearer nope"})
    assert wrong.status_code == 401 and wrong.json()["code"] == "SCHEDULER_TOKEN_INVALID"
    assert SCHEDULER_TOKEN not in wrong.text
    basic = await env.client.post(path, headers={"Authorization": f"Basic {SCHEDULER_TOKEN}"})
    assert basic.status_code == 401
    jwt = await env.client.post(path, headers=internal_headers(env.settings, issuer="telegram-bff"))
    assert jwt.status_code == 403 and jwt.json()["code"] == "CALLER_NOT_ALLOWED"

    local = datetime.now(UTC).astimezone(TASHKENT) - timedelta(minutes=1)
    user = env.add_user(digest_time=local.strftime("%H:%M"))
    await price_drop(env, user)
    ok = {"Authorization": f"Bearer {SCHEDULER_TOKEN}"}
    first = await env.client.post(path, headers=ok)
    assert first.status_code == 200 and first.json() == {
        "users": 1, "digests": 1, "items": 1, "postponed": 0, "errors": 0}
    again = await env.client.post(path, headers=ok)
    assert again.status_code == 200 and again.json()["digests"] == 0
    await env.dispatch()
    assert len(env.gateway.calls) == 1

    # пустой SCHEDULER_TOKEN выключает вход планировщика
    env.settings.scheduler_token = type(env.settings.scheduler_token)("")
    off = await env.client.post(path, headers={"Authorization": "Bearer "})
    assert off.status_code == 401

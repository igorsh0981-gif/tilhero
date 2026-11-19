"""Рассылки (admin.ts «Рассылки», AT-21, AT-22): черновик (Idempotency-Key обязателен, CAMPAIGN_INVALID, версия),
оценка охвата (identity-consent замокан по контракту INTERNAL_API §3), предпросмотр и тест, расписание и снятие,
исполнение в `notifications:dispatch` (курсор аудитории, общая политика доставки, тихие часы → отложено, детям
никогда, лимит частоты 7 дней, повтор без дублей), экстренная остановка, сводка Dashboard; права и аудит."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from notif_testkit import SCHEDULER_TOKEN, STAFF_ID, quiet_around_now
from sqlalchemy import select, update

from tilhero_common.testing import assert_event_conforms, internal_headers
from tilhero_notifications import campaigns as cmp
from tilhero_notifications.delivery import forget
from tilhero_notifications.models import Campaign, CampaignRecipient, Notification

CBASE = "/admin/v1/notifications/campaigns"
MANAGE, SEND = "notif.campaigns.manage", "notif.campaigns.send"


def content(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "title": "Новости ноября",
        "texts": {
            "ru": {"title": "Новое в TilHero", "body": "{learner_name}, у нас обновления!", "button": None},
            "uz": {"title": "TilHeroʼda yangiliklar", "body": "{learner_name}, yangilanishlar bor!", "button": None},
        },
        "route": "news",
        "segment": {},
    }
    body.update(overrides)
    return body


async def create(env, body: dict | None = None, *, idem: str | None = "camp-create-0001",
                 headers: dict | None = None) -> httpx.Response:
    h = dict(headers or env.staff())
    if idem:
        h["Idempotency-Key"] = idem
    return await env.client.post(CBASE, json=body or content(), headers=h)


async def new_campaign(env, **overrides: Any) -> dict[str, Any]:
    r = await create(env, content(**overrides), idem="camp-" + uuid.uuid4().hex)
    assert r.status_code == 201, r.text
    return r.json()


async def schedule(env, campaign: dict, *, send_at: datetime | None = None, now: bool = False,
                   idem: str | None = None, version: int | None = None, settle: bool = True) -> httpx.Response:
    """send_at по умолчанию — часы теста (≤ now+1 мин — тоже «сейчас»); now=True — send_at=null (D2-03).
    settle — дождаться фоновой первой пачки «Отправить сейчас»."""
    h = env.staff()
    if idem:
        h["Idempotency-Key"] = idem
    body = {"expected_version": version or campaign["version"],
            "send_at": None if now else (send_at or datetime.now(UTC)).isoformat(), "reason": "Рассылка согласована"}
    r = await env.client.post(f"{CBASE}/{campaign['campaign_id']}/schedule", json=body, headers=h)
    if settle:
        await env.start_now.drain()
    return r


async def schedule_due(env, campaign: dict) -> None:
    """Плановая рассылка, время которой пришло: запуск — шаг start_due ближайшего :dispatch (не «сейчас»)."""
    r = await schedule(env, campaign, send_at=datetime.now(UTC) + timedelta(hours=1))
    assert r.status_code == 200 and r.json()["status"] == "scheduled", r.text
    async with env.runtime.transaction() as s:
        await s.execute(update(Campaign).where(Campaign.campaign_id == uuid.UUID(campaign["campaign_id"]))
                        .values(send_at=datetime.now(UTC) - timedelta(seconds=1)))


async def dispatch(env) -> dict[str, Any]:
    r = await env.client.post("/internal/v1/notifications:dispatch",
                              headers={"Authorization": f"Bearer {SCHEDULER_TOKEN}"})
    assert r.status_code == 200, r.text
    return r.json()


async def get(env, campaign_id: str) -> dict[str, Any]:
    r = await env.client.get(f"{CBASE}/{campaign_id}", headers=env.staff())
    assert r.status_code == 200, r.text
    return r.json()


async def recipients(env, campaign_id: str) -> dict[uuid.UUID, str]:
    async with env.runtime.transaction() as s:
        rows = await s.execute(select(CampaignRecipient.user_id, CampaignRecipient.status)
                               .where(CampaignRecipient.campaign_id == uuid.UUID(campaign_id)))
        return dict(rows.all())


async def campaign_rows(env, user: uuid.UUID) -> list[Notification]:
    return [r for r in await env.rows(user) if r.kind == "campaign"]


# ---------------------------------------------------------------- черновик


async def test_create_get_list_patch(env) -> None:
    r = await create(env)
    assert r.status_code == 201, r.text
    c = r.json()
    assert (c["status"], c["version"], c["title"], c["route"], c["segment"]) == ("draft", 1, "Новости ноября",
                                                                                 "news", {})
    assert c["created_by"] == STAFF_ID and c["created_by_name"] is None and c["send_at"] is None
    assert c["stats"] == {"audience": 0, "created": 0, "sent": 0, "in_app_only": 0, "deferred": 0,
                          "skipped_frequency": 0, "failed": 0}
    assert c["last_error"] is None
    replay = await create(env)
    assert replay.status_code == 201 and replay.json() == c
    reused = await create(env, content(title="Другая"))
    assert (reused.status_code, reused.json()["code"]) == (422, "IDEMPOTENCY_KEY_REUSED")
    missing = await create(env, idem=None)
    assert (missing.status_code, missing.json()["code"]) == (422, "IDEMPOTENCY_KEY_REQUIRED")
    assert await get(env, c["campaign_id"]) == c
    r = await env.client.get(f"{CBASE}/{uuid.uuid4()}", headers=env.staff())
    assert (r.status_code, r.json()["code"]) == (404, "CAMPAIGN_NOT_FOUND")

    second, third = await new_campaign(env, title="Вторая"), await new_campaign(env, title="Третья")
    page = (await env.client.get(CBASE, params={"limit": 2}, headers=env.staff())).json()
    assert [i["title"] for i in page["items"]] == ["Третья", "Вторая"] and page["next_cursor"]
    rest = (await env.client.get(CBASE, params={"limit": 2, "cursor": page["next_cursor"]},
                                 headers=env.staff())).json()
    assert [i["title"] for i in rest["items"]] == ["Новости ноября"] and rest["next_cursor"] is None
    assert (await env.client.get(CBASE, params={"status": "scheduled"}, headers=env.staff())).json()["items"] == []
    bad = await env.client.get(CBASE, params={"cursor": "%%%"}, headers=env.staff())
    assert (bad.status_code, bad.json()["code"]) == (400, "INVALID_CURSOR")

    r = await env.client.patch(f"{CBASE}/{second['campaign_id']}",
                               json={"expected_version": 1, "title": "  Вторая (правка) ", "route": None,
                                     "segment": {"ui_lang": ["uz", "ru", "ru"], "age": ["adults", "teens"],
                                                 "active_days": -14}},
                               headers=env.staff())
    assert r.status_code == 200, r.text
    patched = r.json()
    assert (patched["version"], patched["title"], patched["route"]) == (2, "Вторая (правка)", None)
    assert patched["segment"] == {"ui_lang": ["ru", "uz"], "age": ["adults", "teens"], "active_days": -14}
    assert patched["texts"] == second["texts"]
    r = await env.client.patch(f"{CBASE}/{second['campaign_id']}", json={"expected_version": 1, "title": "x"},
                               headers=env.staff())
    assert (r.status_code, r.json()["code"], r.json()["details"]) == (409, "CAMPAIGN_VERSION_CONFLICT",
                                                                      {"current_version": 2})
    same = await env.client.patch(f"{CBASE}/{third['campaign_id']}",
                                  json={"expected_version": 1, "title": "Третья"}, headers=env.staff())
    assert same.json()["version"] == 1  # без изменений — версия та же
    r = await env.client.patch(f"{CBASE}/{uuid.uuid4()}", json={"expected_version": 1}, headers=env.staff())
    assert (r.status_code, r.json()["code"]) == (404, "CAMPAIGN_NOT_FOUND")
    actions = [a["action"] for a in await env.audit()]
    assert actions == ["campaign.created"] * 3 + ["campaign.updated"]
    for e in await env.events("admin.audit.recorded.v1"):
        assert_event_conforms(e)


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"segment": {"age": ["kids", "adults"]}}, {("segment.age", "kids_not_allowed")}),
        ({"segment": {"ui_lang": ["en"]}}, {("segment.ui_lang", "invalid")}),
        ({"segment": {"active_days": 0}}, {("segment.active_days", "out_of_range")}),
        ({"segment": {"active_days": -91}}, {("segment.active_days", "out_of_range")}),
        ({"route": "admin"}, {("route", "invalid")}),
        ({"title": " "}, {("title", "required")}),
        ({"title": "Т" * 121}, {("title", "too_long")}),
        ({"texts": {"ru": {"title": "A", "body": "{duration}"}, "uz": {"title": "B", "body": " "}}},
         {("texts.ru.body", "unknown_placeholder"), ("texts.uz.body", "required")}),
        ({"texts": {"ru": {"title": "A", "body": "B", "button": "К" * 33}}},
         {("texts.ru.button", "too_long"), ("texts.uz", "required")}),
    ],
)
async def test_create_invalid(env, overrides: dict, expected: set) -> None:
    r = await create(env, content(**overrides))
    assert (r.status_code, r.json()["code"]) == (422, "CAMPAIGN_INVALID"), r.text
    assert {(f["path"], f["reason"]) for f in r.json()["details"]["fields"]} == expected
    r = await create(env, {**content(), "status": "done"})
    assert (r.status_code, r.json()["code"]) == (422, "VALIDATION_ERROR")
    assert await env.audit() == []


MANAGE_ENDPOINTS = [
    ("GET", "", None),
    ("GET", "/{id}", None),
    ("POST", "", content()),
    ("PATCH", "/{id}", {"expected_version": 1, "title": "x"}),
    ("POST", "/{id}/estimate", None),
    ("POST", "/{id}/preview", {"lang": "ru"}),
    ("POST", "/{id}/test", {"lang": "ru", "recipient": 0}),
]
SEND_ENDPOINTS = [
    ("POST", "/{id}/schedule", {"expected_version": 1, "send_at": "2030-01-01T00:00:00Z", "reason": "abc"}),
    ("POST", "/{id}/unschedule", {"reason": "abc"}),
    ("POST", "/{id}/stop", {"reason": "abc"}),
]


@pytest.mark.parametrize(("method", "path", "body", "permission"),
                         [(*e, MANAGE) for e in MANAGE_ENDPOINTS] + [(*e, SEND) for e in SEND_ENDPOINTS]
                         + [("GET", "/summary", None, "dashboard.read")])
async def test_auth_and_permissions(env, method: str, path: str, body: dict | None, permission: str) -> None:
    campaign = await new_campaign(env)
    url = CBASE + path.replace("{id}", campaign["campaign_id"])
    others = {MANAGE, SEND, "dashboard.read", "notif.templates.manage"} - {permission}
    if permission == SEND:
        others -= {"dashboard.read"}
    if permission == "dashboard.read":
        others -= {MANAGE}  # сводку видит и менеджер рассылок

    async def call(headers: dict[str, str]) -> httpx.Response:
        return await env.client.request(method, url, json=body, headers={**headers, "Idempotency-Key": "k-12345678"})

    r = await call({})
    assert (r.status_code, r.json()["code"]) == (401, "INTERNAL_TOKEN_MISSING")
    r = await call(internal_headers(env.settings, issuer="support"))
    assert (r.status_code, r.json()["code"]) == (403, "CALLER_NOT_ALLOWED")
    r = await call(env.staff(with_actor=False))
    assert (r.status_code, r.json()["code"]) == (403, "STAFF_CONTEXT_REQUIRED")
    r = await call(env.staff(*others))
    assert (r.status_code, r.json()["code"]) == (403, "PERMISSION_DENIED"), r.text
    assert env.gateway.calls == []
    assert (await get(env, campaign["campaign_id"]))["status"] == "draft"


# ---------------------------------------------------------------- оценка, предпросмотр, тест


async def test_estimate(env) -> None:
    a, b, c = env.add_user(), env.add_user(), env.add_user()
    u = env.add_user(locale="uz")
    env.to_audience(a, b, c, u)
    campaign = await new_campaign(env, segment={"ui_lang": ["ru"], "onboarded": True, "active_days": 30})
    r = await env.client.post(f"{CBASE}/{campaign['campaign_id']}/estimate", headers=env.staff())
    assert r.status_code == 200, r.text
    est = r.json()
    assert (est["audience"], est["by_lang"], est["frequency_capped"]) == (3, {"ru": 3, "uz": 0}, 0)
    assert est["computed_at"].endswith("Z")
    query = env.identity.audience_queries[0]
    assert query == {"path": "/internal/v1/audience/count", "age": "adults", "ui_lang": "ru", "onboarded": "true",
                     "active_days": "30"}
    # другая рассылка за 7 дней уже дошла до a → он будет пропущен
    async with env.runtime.transaction() as s:
        s.add(Campaign(campaign_id=(other := uuid.uuid4()), title="x", texts={}, route=None, segment={},
                       status="done", version=1, created_by="s", created_at=datetime.now(UTC),
                       updated_at=datetime.now(UTC)))
        await s.flush()
        reached = uuid.uuid4()
        s.add(Notification(notification_id=reached, user_id=a, category="product", kind="campaign",
                           template="campaign", dedup_key=f"campaign:{other}:{a}", telegram_status="sent",
                           created_at=datetime.now(UTC), updated_at=datetime.now(UTC)))
        s.add(CampaignRecipient(campaign_id=other, user_id=a, status="created", notification_id=reached,
                                created_at=datetime.now(UTC), processed_at=datetime.now(UTC)))
    est = (await env.client.post(f"{CBASE}/{campaign['campaign_id']}/estimate", headers=env.staff())).json()
    assert est["frequency_capped"] == 1
    env.identity.audience_fail.extend([503, 503, 503])  # GET повторяется клиентом сервисов 3 раза
    r = await env.client.post(f"{CBASE}/{campaign['campaign_id']}/estimate", headers=env.staff())
    assert (r.status_code, r.json()["code"], r.json()["details"]) == (503, "UPSTREAM_UNAVAILABLE",
                                                                      {"service": "identity-consent"})
    # identity-consent отклонил сегмент → CAMPAIGN_INVALID с путём поля (а не 503)
    env.identity.audience_fail.append((422, "SEGMENT_INVALID", {"field": "active_days", "reason": "out_of_range"}))
    r = await env.client.post(f"{CBASE}/{campaign['campaign_id']}/estimate", headers=env.staff())
    assert (r.status_code, r.json()["code"]) == (422, "CAMPAIGN_INVALID")
    assert r.json()["details"]["fields"] == [{"path": "segment.active_days", "reason": "out_of_range"}]
    env.identity.audience_fail.append((422, "SEGMENT_INVALID", {"field": "age", "reason": "kids_not_allowed"}))
    r = await schedule(env, campaign)
    assert r.json()["details"]["fields"] == [{"path": "segment.age", "reason": "kids_not_allowed"}]
    assert (await get(env, campaign["campaign_id"]))["status"] == "draft"
    r = await env.client.post(f"{CBASE}/{uuid.uuid4()}/estimate", headers=env.staff())
    assert r.status_code == 404


async def test_preview_and_test_send(env) -> None:
    campaign = await new_campaign(env, route=None)
    url = f"{CBASE}/{campaign['campaign_id']}"
    r = await env.client.post(f"{url}/preview", json={"lang": "uz"}, headers=env.staff())
    assert r.json() == {"lang": "uz", "title": "TilHeroʼda yangiliklar", "body": "Alisher, yangilanishlar bor!",
                        "button": None, "telegram_text": "TilHeroʼda yangiliklar\nAlisher, yangilanishlar bor!"}
    r = await env.client.post(f"{url}/preview", json={"lang": "ru", "sample": {"learner_name": ""}},
                              headers=env.staff())
    assert r.json()["body"] == ", у нас обновления!"
    r = await env.client.post(f"{url}/preview", json={"lang": "ru", "sample": {"duration": "x"}}, headers=env.staff())
    assert (r.status_code, r.json()["code"]) == (422, "TEMPLATE_INVALID")

    learner = env.add_user()
    env.to_audience(learner)
    r = await env.client.post(f"{url}/test", json={"lang": "ru", "recipient": 0}, headers=env.staff())
    assert r.status_code == 200 and r.json()["sent"] is True
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == 5550001111
    assert msg["text"] == "<b>[ТЕСТ] Новое в TilHero</b>\nАлишер, у нас обновления!" and msg["buttons"] is None
    for body in ({"lang": "ru", "recipient": 5}, {"lang": "ru", "recipient": 0, "user_id": str(learner)}):
        r = await env.client.post(f"{url}/test", json=body, headers=env.staff())
        assert r.status_code == 422
    assert len(env.gateway.calls) == 1 and await env.rows() == []  # ученикам — никогда, центр не трогается
    [record] = await env.audit("campaign.test_sent")
    assert record["after"]["recipient"] == 0 and "5550001111" not in str(record)
    assert (await get(env, campaign["campaign_id"]))["status"] == "draft"


# ---------------------------------------------------------------- расписание


async def test_schedule_rules(env) -> None:
    campaign = await new_campaign(env)
    r = await schedule(env, campaign)
    assert (r.status_code, r.json()["code"]) == (422, "CAMPAIGN_EMPTY_AUDIENCE")
    env.to_audience(env.add_user())
    r = await schedule(env, campaign, send_at=datetime.now(UTC) + timedelta(days=31))
    assert (r.status_code, r.json()["code"]) == (422, "CAMPAIGN_INVALID")
    assert r.json()["details"]["fields"] == [{"path": "send_at", "reason": "too_far"}]
    r = await schedule(env, campaign, version=7)
    assert (r.status_code, r.json()["code"]) == (409, "CAMPAIGN_VERSION_CONFLICT")
    later = datetime.now(UTC) + timedelta(days=2)
    r = await schedule(env, campaign, send_at=later, idem="sched-key-0001")
    assert r.status_code == 200, r.text
    scheduled = r.json()
    assert scheduled["status"] == "scheduled" and scheduled["version"] == 2
    assert scheduled["scheduled_by"] == STAFF_ID and abs(
        datetime.fromisoformat(scheduled["send_at"]) - later) < timedelta(seconds=1)
    replay = await schedule(env, campaign, send_at=later, idem="sched-key-0001")
    assert replay.status_code == 200 and replay.json() == scheduled and replay.headers["Idempotent-Replayed"]
    r = await schedule(env, campaign, send_at=later)
    assert (r.status_code, r.json()["code"]) == (409, "CAMPAIGN_NOT_DRAFT")
    r = await env.client.patch(f"{CBASE}/{campaign['campaign_id']}", json={"expected_version": 2, "title": "x"},
                               headers=env.staff())
    assert (r.status_code, r.json()["code"]) == (409, "CAMPAIGN_NOT_DRAFT")
    assert (await dispatch(env))["sent"] == 0  # ещё не время
    r = await env.client.post(f"{CBASE}/{campaign['campaign_id']}/unschedule", json={"reason": "Перенос"},
                              headers=env.staff())
    assert r.status_code == 200 and (r.json()["status"], r.json()["send_at"], r.json()["version"]) == ("draft", None,
                                                                                                       3)
    again = await env.client.post(f"{CBASE}/{campaign['campaign_id']}/unschedule", json={"reason": "Перенос"},
                                  headers=env.staff())
    assert again.status_code == 200 and again.json()["version"] == 3
    # раньше now−5 мин — 422 in_past (ревью T2-2); до 5 мин в прошлом или ближе минуты — «как можно скорее»
    draft = await get(env, campaign["campaign_id"])
    r = await schedule(env, draft, send_at=datetime.now(UTC) - timedelta(minutes=6))
    assert (r.status_code, r.json()["code"]) == (422, "CAMPAIGN_INVALID")
    assert r.json()["details"]["fields"] == [{"path": "send_at", "reason": "in_past"}]
    r = await schedule(env, draft, send_at=datetime.now(UTC) - timedelta(minutes=4))
    assert r.status_code == 200, r.text
    assert abs(datetime.fromisoformat(r.json()["send_at"]) - datetime.now(UTC)) < timedelta(seconds=30)
    assert r.json()["status"] == "sending" and r.json()["started_at"]  # «как можно скорее» = «сейчас» (D2-03)
    assert [a["action"] for a in await env.audit() if a["action"] != "campaign.created"] == [
        "campaign.scheduled", "campaign.unscheduled", "campaign.scheduled", "campaign.finished"]
    record = (await env.audit("campaign.scheduled"))[0]
    assert record["reason"] == "Рассылка согласована" and record["after"]["audience_estimate"] == 1
    await dispatch(env)
    r = await env.client.post(f"{CBASE}/{campaign['campaign_id']}/unschedule", json={"reason": "Поздно"},
                              headers=env.staff())
    assert (r.status_code, r.json()["code"]) == (409, "CAMPAIGN_ALREADY_SENDING")


# ---------------------------------------------------------------- «Отправить сейчас» (QA D2-03, ревью T2-11)


async def test_send_now_starts_in_command_and_creates_messages_without_dispatch(env) -> None:
    """send_at=null — по часам сервера: ответ уже sending (started_at, аудитория зафиксирована), записи журнала
    создаёт фоновая первая пачка — без :dispatch; отправку делает обработчик журнала сервиса (wake)."""
    users = [env.add_user() for _ in range(3)]
    env.to_audience(*users)
    campaign = await new_campaign(env)
    r = await schedule(env, campaign, now=True, idem="send-now-0001", settle=False)
    assert r.status_code == 200, r.text
    started = r.json()
    assert (started["status"], started["version"], started["scheduled_by"]) == ("sending", 2, STAFF_ID)
    assert started["started_at"] == started["send_at"] == started["scheduled_at"]
    assert abs(datetime.fromisoformat(started["send_at"]) - datetime.now(UTC)) < timedelta(seconds=30)
    assert started["stats"]["audience"] == 3 and started["last_error"] is None
    await env.start_now.drain()

    assert await recipients(env, campaign["campaign_id"]) == {u: "created" for u in users}
    for u in users:
        [row] = await campaign_rows(env, u)
        assert (row.telegram_status, row.category) == ("scheduled", "product")
    pages = [q for q in env.identity.audience_queries if q["path"] == "/internal/v1/audience"]
    assert len(pages) == 1
    state = await get(env, campaign["campaign_id"])
    assert state["status"] == "done" and state["stats"]["created"] == 3  # маленькая — завершена сразу
    assert env.gateway.calls == []
    assert await env.dispatch() == 3  # обработчик журнала (его будит фоновая пачка) — без :dispatch
    assert {c["telegram_user_id"] for c in env.gateway.calls} == {env.telegram_id(u) for u in users}

    [record] = await env.audit("campaign.scheduled")
    assert record["before"] == {"status": "draft"} and record["reason"] == "Рассылка согласована"
    assert record["after"] == {"status": "sending", "send_at": started["send_at"], "audience_estimate": 3,
                               "send_now": True}
    assert len(await env.audit("campaign.finished")) == 1
    for e in await env.events("admin.audit.recorded.v1"):
        assert_event_conforms(e)

    # повтор с тем же ключом — сохранённый ответ, второго запуска нет; другой ключ — 409
    replay = await schedule(env, campaign, now=True, idem="send-now-0001")
    assert replay.status_code == 200 and replay.headers["Idempotent-Replayed"] and replay.json() == started
    assert not env.start_now.tasks
    again = await schedule(env, campaign, now=True, idem="send-now-0002")
    assert (again.status_code, again.json()["code"]) == (409, "CAMPAIGN_NOT_DRAFT")
    assert len(await env.audit("campaign.scheduled")) == 1 and len(pages) == 1
    assert len([row for row in await env.rows() if row.kind == "campaign"]) == 3
    await dispatch(env)
    assert len(env.gateway.calls) == 3
    summary = await env.client.get(f"{CBASE}/summary", params={"period": "today"}, headers=env.staff("dashboard.read"))
    assert summary.json() == {"scheduled": 0, "sending": 0, "sent_in_period": 1, "delivered_in_period": 3}


async def test_send_now_threshold_and_rest_by_dispatch(env) -> None:
    """send_at ≤ now+1 мин — тоже «сейчас»; дальше — в расписании. Фон обрабатывает одну пачку, остальное —
    :dispatch. send_at=null не проверяется на «в прошлом/слишком далеко»; ключ send_at обязателен."""
    env.settings.campaign_recipient_batch = 2
    users = [env.add_user() for _ in range(5)]
    env.to_audience(*users)
    later = await new_campaign(env, title="Через 2 минуты")
    r = await schedule(env, later, send_at=datetime.now(UTC) + timedelta(minutes=2))
    assert r.json()["status"] == "scheduled" and r.json()["started_at"] is None
    soon = await new_campaign(env, title="Через 50 секунд")
    r = await schedule(env, soon, send_at=datetime.now(UTC) + timedelta(seconds=50))
    assert r.json()["status"] == "sending"
    assert abs(datetime.fromisoformat(r.json()["send_at"]) - datetime.now(UTC)) < timedelta(seconds=30)
    statuses = await recipients(env, soon["campaign_id"])
    assert sorted(statuses.values()) == ["created"] * 2 + ["pending"] * 3
    assert (await get(env, soon["campaign_id"]))["status"] == "sending"
    await dispatch(env)
    state = await get(env, soon["campaign_id"])
    assert state["status"] == "done" and state["stats"]["created"] == 5 and state["stats"]["sent"] == 5
    assert (await get(env, later["campaign_id"]))["status"] == "scheduled"  # её время ещё не пришло

    draft = await new_campaign(env, title="Без ключа send_at")
    r = await env.client.post(f"{CBASE}/{draft['campaign_id']}/schedule",
                              json={"expected_version": 1, "reason": "Рассылка согласована"}, headers=env.staff())
    assert (r.status_code, r.json()["code"]) == (422, "VALIDATION_ERROR")
    r = await schedule(env, draft, now=True, version=5)
    assert (r.status_code, r.json()["code"]) == (409, "CAMPAIGN_VERSION_CONFLICT")
    empty = await new_campaign(env, title="Пустой сегмент", segment={"ui_lang": ["uz"]})
    r = await schedule(env, empty, now=True)
    assert (r.status_code, r.json()["code"]) == (422, "CAMPAIGN_EMPTY_AUDIENCE")
    assert (await get(env, empty["campaign_id"]))["status"] == "draft" and not env.start_now.tasks


async def test_send_now_parallel_dispatch_does_not_duplicate(env) -> None:
    """Фоновая первая пачка и два параллельных :dispatch: курсор аудитории, пачки и записи журнала не дублируются,
    каждому — одно сообщение, campaign.finished — один раз."""
    env.settings.campaign_audience_page = 2
    env.settings.campaign_recipient_batch = 2
    env.settings.campaign_start_now_batches = 2
    users = [env.add_user() for _ in range(7)]
    env.to_audience(*users)
    campaign = await new_campaign(env)
    r = await schedule(env, campaign, now=True, settle=False)
    assert r.status_code == 200 and r.json()["status"] == "sending"
    await asyncio.gather(dispatch(env), dispatch(env), env.start_now.drain())
    await dispatch(env)
    state = await get(env, campaign["campaign_id"])
    assert state["status"] == "done" and state["stats"]["created"] == 7 and state["stats"]["sent"] == 7
    assert await recipients(env, campaign["campaign_id"]) == {u: "created" for u in users}
    for u in users:
        assert len(await campaign_rows(env, u)) == 1
        assert len(env.gateway.to(env.telegram_id(u))) == 1
    assert len(env.gateway.calls) == 7
    assert len(await env.audit("campaign.finished")) == 1


async def test_send_now_background_failure_goes_to_last_error(env, monkeypatch: pytest.MonkeyPatch) -> None:
    """Ошибка фоновой пачки не влияет на ответ: сбой выборки аудитории и любой другой — в last_error, рассылка
    остаётся sending; следующий :dispatch её доводит и сбрасывает ошибку."""
    user = env.add_user()
    env.to_audience(user)
    first = await new_campaign(env)
    env.identity.audience_page_fail.append((400, "INVALID_CURSOR", {}))
    r = await schedule(env, first, now=True)
    assert r.status_code == 200 and r.json()["status"] == "sending" and r.json()["last_error"] is None
    state = await get(env, first["campaign_id"])
    assert state["status"] == "sending" and state["stats"]["created"] == 0
    assert (state["last_error"]["code"], state["last_error"]["attempts"]) == ("INVALID_CURSOR", 1)
    await dispatch(env)
    state = await get(env, first["campaign_id"])
    assert state["status"] == "done" and state["last_error"] is None and state["stats"]["sent"] == 1

    async def boom(self, campaign_id, now):
        raise RuntimeError("db is gone")

    other = env.add_user()
    env.to_audience(other)
    second = await new_campaign(env, title="Вторая")
    with monkeypatch.context() as m:
        m.setattr(cmp.Runner, "create_batch", boom)
        r = await schedule(env, second, now=True)
    assert r.status_code == 200 and r.json()["status"] == "sending"
    state = await get(env, second["campaign_id"])
    assert state["status"] == "sending" and state["last_error"]["code"] == "INTERNAL_ERROR"
    await dispatch(env)
    state = await get(env, second["campaign_id"])
    assert state["status"] == "done" and state["last_error"] is None
    assert await recipients(env, second["campaign_id"]) == {other: "created", user: "skipped_frequency"}


async def test_send_now_disabled_background_leaves_batches_to_dispatch(env) -> None:
    """CAMPAIGN_START_NOW_BATCHES=0: запуск — в команде (sending), записи журнала — ближайший :dispatch."""
    env.settings.campaign_start_now_batches = 0
    user = env.add_user()
    env.to_audience(user)
    campaign = await new_campaign(env)
    r = await schedule(env, campaign, now=True)
    assert r.json()["status"] == "sending" and not env.start_now.tasks
    assert await recipients(env, campaign["campaign_id"]) == {}
    await dispatch(env)
    assert (await get(env, campaign["campaign_id"]))["stats"]["sent"] == 1


# ---------------------------------------------------------------- исполнение (AT-22)


async def test_at22_dispatch_delivers_by_policy(env) -> None:
    env.settings.campaign_audience_page = 2  # курсор аудитории: 3 страницы
    ok = env.add_user(name="Алишер")
    quiet = env.add_user(quiet=quiet_around_now())
    no_product = env.add_user(categories=("support", "reminders"))  # согласие отозвано после отбора
    parent = env.add_user()
    kid = env.add_child(parent)
    teen = env.add_user(age_band="14-17")
    uz_user = env.add_user(locale="uz")
    env.to_audience(ok, quiet, no_product, kid, teen, uz_user)
    campaign = await new_campaign(env, segment={"ui_lang": ["ru"]})
    assert (await schedule(env, campaign)).status_code == 200

    out = await dispatch(env)
    assert out["sent"] == 1
    state = await get(env, campaign["campaign_id"])
    assert state["status"] == "done" and state["started_at"] and state["finished_at"]
    assert state["stats"] == {"audience": 5, "created": 5, "sent": 1, "in_app_only": 0, "deferred": 1,
                              "skipped_frequency": 0, "failed": 0}
    pages = [q for q in env.identity.audience_queries if q["path"] == "/internal/v1/audience"]
    assert [q.get("cursor") for q in pages] == [None, "2", "4"]
    assert all(set(q) <= {"path", "ui_lang", "age", "onboarded", "active_days", "cursor", "limit"} for q in pages)
    assert all(q["ui_lang"] == "ru" and q["age"] == "adults" and q["limit"] == "2" for q in pages)

    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(ok)
    assert msg["text"] == "<b>Новое в TilHero</b>\nАлишер, у нас обновления!"
    assert msg["buttons"] == [[{"text": "Открыть TilHero", "startapp": "route_news"}]]
    [row] = await campaign_rows(env, ok)
    assert (row.category, row.kind, row.dedup_key) == ("product", "campaign",
                                                      f"campaign:{campaign['campaign_id']}:{ok}")
    [item] = (await env.inbox(ok))["items"]
    assert (item["category"], item["title"], item["telegram"]) == ("product", "Новое в TilHero", "sent")
    assert {(r.telegram_status, r.reason) for r in await campaign_rows(env, quiet)} == {("scheduled", "quiet_hours")}
    assert {(r.telegram_status, r.reason) for r in await campaign_rows(env, no_product)} == {
        ("skipped", "category_disabled")}
    assert {(r.telegram_status, r.reason) for r in await campaign_rows(env, kid)} == {("skipped", "kid_excluded")}
    assert {(r.telegram_status, r.reason) for r in await campaign_rows(env, teen)} == {
        ("skipped", "segment_mismatch")}
    assert await campaign_rows(env, uz_user) == [] and await campaign_rows(env, parent) == []
    assert env.telegram_id(parent) not in {c["telegram_user_id"] for c in env.gateway.calls}  # детям — никогда
    [finished] = await env.audit("campaign.finished")
    assert finished["actor_type"] == "system" and finished["after"]["created"] == 5

    # повтор dispatch — без дублей
    await dispatch(env)
    await dispatch(env)
    assert len(env.gateway.calls) == 1 and len(await campaign_rows(env, ok)) == 1
    assert len(await env.audit("campaign.finished")) == 1
    summary = await env.client.get(f"{CBASE}/summary", params={"period": "today"}, headers=env.staff("dashboard.read"))
    assert summary.json() == {"scheduled": 0, "sending": 0, "sent_in_period": 1, "delivered_in_period": 1}


async def test_frequency_limit_seven_days(env) -> None:
    a, b = env.add_user(), env.add_user()
    env.to_audience(a, b)
    first = await new_campaign(env)
    await schedule(env, first)
    await dispatch(env)
    c = env.add_user()
    env.to_audience(c)
    second = await new_campaign(env, title="Вторая")
    est = (await env.client.post(f"{CBASE}/{second['campaign_id']}/estimate", headers=env.staff())).json()
    assert (est["audience"], est["frequency_capped"]) == (3, 2)
    await schedule(env, second)
    await dispatch(env)
    assert await recipients(env, second["campaign_id"]) == {a: "skipped_frequency", b: "skipped_frequency",
                                                           c: "created"}
    stats = (await get(env, second["campaign_id"]))["stats"]
    assert (stats["created"], stats["skipped_frequency"], stats["sent"]) == (1, 2, 1)
    assert len(env.gateway.to(env.telegram_id(a))) == 1
    # прошло больше 7 дней — снова можно
    async with env.runtime.transaction() as s:
        await s.execute(update(CampaignRecipient).values(processed_at=datetime.now(UTC) - timedelta(days=8)))
    third = await new_campaign(env, title="Третья")
    await schedule(env, third)
    await dispatch(env)
    assert set((await recipients(env, third["campaign_id"])).values()) == {"created"}
    assert len(env.gateway.to(env.telegram_id(a))) == 2


async def test_stop_cancels_unsent(env) -> None:
    env.settings.campaign_recipient_batch = 2
    env.settings.campaign_max_batches_per_call = 3  # страница аудитории + 2 пачки за вызов
    quiet = env.add_user(quiet=quiet_around_now())
    others = [env.add_user() for _ in range(5)]
    env.to_audience(quiet, *others)
    campaign = await new_campaign(env)
    await schedule_due(env, campaign)
    await dispatch(env)
    state = await get(env, campaign["campaign_id"])
    assert state["status"] == "sending" and state["stats"]["created"] == 4
    statuses = await recipients(env, campaign["campaign_id"])
    assert sorted(statuses.values()) == ["created"] * 4 + ["pending"] * 2
    deferred = state["stats"]["deferred"]
    sent_before = len(env.gateway.calls)
    assert deferred + sent_before == 4

    r = await env.client.post(f"{CBASE}/{campaign['campaign_id']}/stop", json={"reason": "Ошибка в тексте"},
                              headers=env.staff())
    assert r.status_code == 200, r.text
    stopped = r.json()
    assert (stopped["status"], stopped["stopped_by"], stopped["stop_reason"]) == ("stopped", STAFF_ID,
                                                                                  "Ошибка в тексте")
    statuses = await recipients(env, campaign["campaign_id"])
    assert list(statuses.values()).count("cancelled") == 2 + deferred
    async with env.runtime.transaction() as s:
        rows = (await s.execute(select(Notification).where(Notification.kind == "campaign"))).scalars().all()
    assert sorted(r.telegram_status for r in rows) == sorted(["sent"] * sent_before + ["cancelled"] * deferred)
    if deferred:
        assert all(i["telegram"] != "cancelled" for i in (await env.inbox(quiet))["items"])
        assert (await env.inbox(quiet))["items"] == []  # отменённое в центре не видно
    again = await env.client.post(f"{CBASE}/{campaign['campaign_id']}/stop", json={"reason": "Ещё раз"},
                                  headers=env.staff())
    assert again.status_code == 200 and again.json()["version"] == stopped["version"]
    [record] = await env.audit("campaign.stopped")
    assert record["after"]["cancelled_recipients"] == 2 and record["after"]["cancelled_notifications"] == deferred
    assert record["before"] == {"status": "sending"} and record["reason"] == "Ошибка в тексте"
    await dispatch(env)
    await dispatch(env)
    assert len(env.gateway.calls) == sent_before
    assert (await get(env, campaign["campaign_id"]))["status"] == "stopped"
    r = await env.client.post(f"{CBASE}/{campaign['campaign_id']}/unschedule", json={"reason": "Поздно"},
                              headers=env.staff())
    assert (r.status_code, r.json()["code"]) == (409, "CAMPAIGN_ALREADY_SENDING")
    r = await env.client.post(f"{CBASE}/{uuid.uuid4()}/stop", json={"reason": "Нет такой"}, headers=env.staff())
    assert (r.status_code, r.json()["code"]) == (404, "CAMPAIGN_NOT_FOUND")


async def test_stop_rules_draft_and_done(env) -> None:
    """Ревью P2-7: черновик — 409 CAMPAIGN_NOT_ACTIVE; done — можно: отменяются отложенные тихими часами записи."""
    draft = await new_campaign(env)
    r = await env.client.post(f"{CBASE}/{draft['campaign_id']}/stop", json={"reason": "Не нужна"},
                              headers=env.staff())
    assert (r.status_code, r.json()["code"], r.json()["details"]) == (409, "CAMPAIGN_NOT_ACTIVE",
                                                                      {"status": "draft"})
    assert (await get(env, draft["campaign_id"]))["status"] == "draft"
    quiet, ok = env.add_user(quiet=quiet_around_now()), env.add_user()
    env.to_audience(quiet, ok)
    done = await new_campaign(env, title="Завершённая")
    await schedule(env, done)
    await dispatch(env)
    state = await get(env, done["campaign_id"])
    assert state["status"] == "done" and (state["stats"]["sent"], state["stats"]["deferred"]) == (1, 1)
    r = await env.client.post(f"{CBASE}/{done['campaign_id']}/stop", json={"reason": "Ошибка в тексте"},
                              headers=env.staff())
    assert r.status_code == 200 and r.json()["status"] == "stopped"
    assert {(row.telegram_status, row.reason) for row in await campaign_rows(env, quiet)} == {
        ("cancelled", "campaign_stopped")}
    assert {row.telegram_status for row in await campaign_rows(env, ok)} == {"sent"}  # отправленное не отзывается
    [record] = await env.audit("campaign.stopped")
    assert record["before"] == {"status": "done"} and record["after"]["cancelled_notifications"] == 1


async def test_last_error_series_and_failed_audit(env) -> None:
    """Ревью P2-7: identity отклоняет сегмент при запуске → рассылка остаётся scheduled, last_error растёт с каждым
    dispatch; на 6-й неудаче — аудит campaign.failed (один раз на серию); успех сбрасывает last_error."""
    env.to_audience(env.add_user())
    campaign = await new_campaign(env)
    await schedule_due(env, campaign)
    env.identity.audience_fail.extend([(422, "SEGMENT_INVALID", {"field": "age", "reason": "invalid"})] * 7)
    await dispatch(env)
    state = await get(env, campaign["campaign_id"])
    assert state["status"] == "scheduled"
    first = state["last_error"]
    assert (first["code"], first["attempts"]) == ("SEGMENT_INVALID", 1) and first["since"].endswith("Z")
    for _ in range(4):
        await dispatch(env)
    assert (await get(env, campaign["campaign_id"]))["last_error"]["attempts"] == 5
    assert await env.audit("campaign.failed") == []
    await dispatch(env)
    await dispatch(env)
    state = await get(env, campaign["campaign_id"])
    assert state["last_error"] == {**first, "attempts": 7}  # since — начало серии
    [failed] = await env.audit("campaign.failed")
    assert failed["actor_type"] == "system" and failed["object_id"] == campaign["campaign_id"]
    assert failed["after"] == {"status": "scheduled", "code": "SEGMENT_INVALID", "attempts": 6,
                               "since": first["since"]}
    for e in await env.events("admin.audit.recorded.v1"):
        assert_event_conforms(e)
    await dispatch(env)  # identity снова принимает сегмент
    state = await get(env, campaign["campaign_id"])
    assert state["status"] == "done" and state["last_error"] is None and state["stats"]["sent"] == 1


async def test_last_error_on_audience_page_cleared_by_success(env) -> None:
    """Сбой выборки аудитории посреди отправки (400 INVALID_CURSOR после смены формата курсора) виден сотруднику;
    следующая удачная страница сбрасывает last_error."""
    env.settings.campaign_audience_page = 1
    env.settings.campaign_max_batches_per_call = 2  # первая страница + пачка получателей
    a, b = env.add_user(), env.add_user()
    env.to_audience(a, b)
    campaign = await new_campaign(env)
    await schedule_due(env, campaign)
    await dispatch(env)
    assert (await get(env, campaign["campaign_id"]))["status"] == "sending"
    env.identity.audience_fail.append((400, "INVALID_CURSOR", {}))
    await dispatch(env)
    state = await get(env, campaign["campaign_id"])
    assert state["status"] == "sending"
    assert (state["last_error"]["code"], state["last_error"]["attempts"]) == ("INVALID_CURSOR", 1)
    env.settings.campaign_max_batches_per_call = 50
    await dispatch(env)
    state = await get(env, campaign["campaign_id"])
    assert state["status"] == "done" and state["last_error"] is None and state["stats"]["sent"] == 2
    assert await env.audit("campaign.failed") == []


async def test_frequency_counts_only_reached_learners(env) -> None:
    """Ревью P2-8: ученик выключил «Новости» перед рассылкой A — запись skipped, ничего не получил; включил обратно —
    рассылка B через пару дней до него доходит. Получивший A — пропущен лимитом."""
    off, got = env.add_user(categories=("support", "reminders")), env.add_user()
    env.to_audience(off, got)
    first = await new_campaign(env)
    await schedule(env, first)
    await dispatch(env)
    assert {r.telegram_status for r in await campaign_rows(env, off)} == {"skipped"}
    env.set(off, categories=["support", "reminders", "product"])
    await forget(env.runtime, prefix=env.settings.redis_key_prefix, user_id=off)
    async with env.runtime.transaction() as s:  # прошло 3 дня
        await s.execute(update(CampaignRecipient).values(processed_at=datetime.now(UTC) - timedelta(days=3)))
    second = await new_campaign(env, title="Вторая")
    est = (await env.client.post(f"{CBASE}/{second['campaign_id']}/estimate", headers=env.staff())).json()
    assert (est["audience"], est["frequency_capped"]) == (2, 1)
    await schedule(env, second)
    await dispatch(env)
    assert await recipients(env, second["campaign_id"]) == {off: "created", got: "skipped_frequency"}
    assert len(env.gateway.to(env.telegram_id(off))) == 1 and len(env.gateway.to(env.telegram_id(got))) == 1


async def test_stopped_campaign_record_is_cancelled_at_send_time(env) -> None:
    """Защита в глубину: запись рассылки, оставшаяся scheduled после остановки, не отправляется."""
    user = env.add_user(quiet=quiet_around_now())
    env.to_audience(user)
    campaign = await new_campaign(env)
    await schedule(env, campaign)
    await dispatch(env)
    async with env.runtime.transaction() as s:
        await s.execute(update(Campaign).values(status="stopped"))
        await s.execute(update(Notification).values(scheduled_for=datetime.now(UTC) - timedelta(seconds=1)))
    await env.dispatch()
    [row] = await campaign_rows(env, user)
    assert (row.telegram_status, row.reason) == ("cancelled", "campaign_stopped") and env.gateway.calls == []


async def test_dispatch_safe_when_identity_unavailable(env) -> None:
    user = env.add_user()
    env.to_audience(user)
    campaign = await new_campaign(env)
    await schedule_due(env, campaign)
    env.identity.audience_fail.extend([503, 503, 503])  # count: 3 попытки клиента
    await dispatch(env)
    assert (await get(env, campaign["campaign_id"]))["status"] == "scheduled"
    await dispatch(env)
    state = await get(env, campaign["campaign_id"])
    assert state["status"] == "done" and state["stats"]["sent"] == 1


async def test_deleted_learner(env) -> None:
    gone, kept = env.add_user(), env.add_user()
    env.to_audience(gone, kept)
    await env.delete(gone)
    campaign = await new_campaign(env)
    await schedule(env, campaign)
    await dispatch(env)
    assert await recipients(env, campaign["campaign_id"]) == {gone: "cancelled", kept: "created"}
    await env.delete(kept)
    assert kept not in await recipients(env, campaign["campaign_id"])  # сага удаления чистит получателей


async def test_segment_params_follow_identity_contract(env) -> None:
    """Сегмент со всеми фильтрами: identity-consent получает ui_lang, age (teens,adults), onboarded, active_days=−N
    и limit ≤ 500 — фейк проверяет форму, как настоящий (лишний параметр или kids — 422)."""
    teen, adult = env.add_user(age_band="14-17"), env.add_user()
    env.to_audience(teen, adult)
    campaign = await new_campaign(env, segment={"ui_lang": ["uz", "ru"], "age": ["teens", "adults"],
                                                "onboarded": False, "active_days": -30})
    assert (await schedule(env, campaign)).status_code == 200
    await dispatch(env)
    state = await get(env, campaign["campaign_id"])
    assert state["status"] == "done" and state["stats"]["sent"] == 2  # подросток в сегменте «teens» — доставлено
    queries = [q for q in env.identity.audience_queries if q["path"] == "/internal/v1/audience"]
    assert queries == [{"path": "/internal/v1/audience", "age": "adults,teens", "ui_lang": "ru,uz",
                        "onboarded": "false", "active_days": "-30", "limit": "500"}]


async def test_summary_period(env) -> None:
    env.to_audience(env.add_user())
    later = await new_campaign(env)
    await schedule(env, later, send_at=datetime.now(UTC) + timedelta(days=1))
    r = await env.client.get(f"{CBASE}/summary", params={"period": "7d"}, headers=env.staff("dashboard.read"))
    assert r.json() == {"scheduled": 1, "sending": 0, "sent_in_period": 0, "delivered_in_period": 0}
    r = await env.client.get(f"{CBASE}/summary", params={"period": "year"}, headers=env.staff("dashboard.read"))
    assert (r.status_code, r.json()["code"]) == (422, "VALIDATION_ERROR")

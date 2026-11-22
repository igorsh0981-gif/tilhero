"""Рефералы (§1.4, AT-78, APP-REF-01…04, ADM-REF-01/02; скилл referral_integrity_reviewer): приглашён → диагностика →
3 разных урока минимум в 2 разных дня → qualified → ack gamification → rewarded. Повтор события и урока не
считается дважды, два урока в один день не дают min_days, duel/pair/практика — не уроки; семья → rejected
family_member; скорость, короткие уроки, занятия до принятия → review (оператор одобряет или отклоняет, пересмотр —
один раз); лимит месяца → capped; окно → expired (tick). Кампании — версии, валидатор, активация со step-up."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from conftest import SERVICE_DIR, make_settings
from sqlalchemy import text

from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, migrate, unique_schema

ADMIN = "/internal/v1/admin/referrals"
T0 = datetime.fromisoformat("2026-11-16T08:00:00+00:00")


def _iso(ts: datetime) -> str:
    return ts.isoformat().replace("+00:00", "Z")


async def _referral(env, inviter=None, invitee=None) -> tuple[uuid.UUID, uuid.UUID, str]:
    inviter = inviter or env.identity.add("Пригласивший")
    invitee = invitee or env.identity.add("Новичок")
    iid, token = await env.invite(inviter, "referral")
    await env.open(invitee, token)
    r = await env.accept(invitee, iid)
    assert r.status_code == 200, r.text
    [(rid,)] = await env.sql("SELECT referral_id FROM referrals WHERE invitee_user_id = :u", u=invitee)
    return inviter, invitee, str(rid)


async def _diag(env, user, at: datetime, producer: str = "diagnostics") -> None:
    await env.publish("diagnostics.completed.v1", {
        "user_id": str(user), "pair_id": "ru-en", "result_id": str(uuid.uuid4()), "revision": 1, "test_id": "dx",
        "test_version": 1, "areas": {}, "completed_at": _iso(at)}, producer)


async def _lesson(env, user, at: datetime, *, lesson_id: str | None = "L1", session_id: str | None = None,
                  minutes: int = 10, kind: str = "lesson", practice_only: bool = False, status: str = "completed",
                  local_date: str | None = None, producer: str = "lessons") -> str:
    sid = session_id or str(uuid.uuid4())
    payload: dict[str, Any] = {"session_id": sid, "user_id": str(user), "kind": kind, "pair_id": "ru-en",
                               "lesson_id": lesson_id, "status": status, "minutes": minutes,
                               "practice_only": practice_only, "finished_at": _iso(at), "local_date": local_date}
    if kind == "duel":
        payload.update({"duel_id": str(uuid.uuid4()), "score": {"correct": 5, "total": 10}})
    await env.publish("lesson.session.completed.v1", payload, producer)
    return sid


async def _status(env, rid: str) -> tuple[str, str | None]:
    [(status, code)] = await env.sql("SELECT status, reject_code FROM referrals WHERE referral_id = :r",
                                     r=uuid.UUID(rid))
    return status, code


async def _view(env, inviter) -> dict[str, Any]:
    r = await env.c.get("/internal/v1/me/referrals", headers=env.lh(inviter))
    assert r.status_code == 200, r.text
    return r.json()


async def _set_campaign(env, **changes: Any) -> None:
    for path, value in changes.items():
        keys = "{" + path.replace(".", ",") + "}"
        await env.sql(f"UPDATE referral_campaigns SET payload = jsonb_set(payload, '{keys}', "  # noqa: S608
                      f"'{value}'::jsonb) WHERE version = 1")


async def test_full_path_to_rewarded(env) -> None:
    inviter, invitee, rid = await _referral(env)
    await env.nick(invitee, "Newbie")
    view = await _view(env, inviter)
    assert view["terms"] == {"campaign_version": 1, "require_diagnostic": True, "min_lessons": 3, "min_days": 2,
                             "window_days": 30, "inviter_reward": {"freeze": 2, "til": 0},
                             "invitee_reward": {"freeze": 0, "til": 0}, "monthly_cap": 10}
    assert view["month"] == {"qualified": 0, "cap": 10} and view["next_cursor"] is None
    assert view["items"] == [{"referral_id": rid, "invitee_nickname": "Newbie", "status": "invited",
                              "progress": {"diagnostic": False, "diagnostic_required": True, "lessons": 0,
                                           "lessons_required": 3, "days": 0, "days_required": 2,
                                           "window_ends_at": "2026-12-16T08:00:00.000Z"},
                              "reward": None, "reward_outcome": None, "reject_code": None, "legacy": False,
                              "accepted_at": "2026-11-16T08:00:00.000Z"}]
    env.now = T0 + timedelta(days=3)
    await _diag(env, invitee, T0 + timedelta(hours=1))
    assert await _status(env, rid) == ("diagnostic_done", None)
    sid = await _lesson(env, invitee, T0 + timedelta(hours=2), lesson_id="L1")
    assert await _status(env, rid) == ("learning", None)
    # повтор события той же сессии и повтор того же урока — не считаются
    await _lesson(env, invitee, T0 + timedelta(hours=2), lesson_id="L1", session_id=sid)
    await _lesson(env, invitee, T0 + timedelta(hours=3), lesson_id="L1")
    # не уроки: дуэль, парный, практика, отменённый
    await _lesson(env, invitee, T0 + timedelta(hours=3), kind="duel", lesson_id=None)
    await _lesson(env, invitee, T0 + timedelta(hours=3), kind="pair", lesson_id=None)
    await _lesson(env, invitee, T0 + timedelta(hours=3), lesson_id="LP", practice_only=True)
    await _lesson(env, invitee, T0 + timedelta(hours=3), lesson_id="LC", status="cancelled")
    await _lesson(env, invitee, T0 + timedelta(hours=3), kind="scenario", lesson_id="S1")
    p = (await _view(env, inviter))["items"][0]["progress"]
    assert (p["diagnostic"], p["lessons"], p["days"]) == (True, 1, 1)
    # ещё два урока в тот же день: 3 урока, но 1 день — условия не выполнены
    await _lesson(env, invitee, T0 + timedelta(hours=4), lesson_id="L2")
    await _lesson(env, invitee, T0 + timedelta(hours=5), lesson_id="L3")
    assert await _status(env, rid) == ("learning", None)
    p = (await _view(env, inviter))["items"][0]["progress"]
    assert (p["lessons"], p["days"]) == (3, 1)
    assert await env.events("social.referral.qualified.v1") == []
    # второй день → qualified (время квалификации — время урока)
    await _lesson(env, invitee, T0 + timedelta(days=1, hours=1), lesson_id="L4")
    assert await _status(env, rid) == ("qualified", None)
    [q] = await env.events("social.referral.qualified.v1")
    assert q.payload == {"referral_id": rid, "inviter_user_id": str(inviter), "invitee_user_id": str(invitee),
                         "campaign_version": 1, "inviter_reward": {"freeze": 2, "til": 0},
                         "invitee_reward": {"freeze": 0, "til": 0}, "inviter_monthly_cap": 10,
                         "qualified_at": "2026-11-17T09:00:00.000Z"}
    item = (await _view(env, inviter))["items"][0]
    assert item["status"] == "qualified" and item["reward"] == {"freeze": 2, "til": 0}
    assert (await _view(env, inviter))["month"] == {"qualified": 1, "cap": 10}
    # ack — только от gamification; повтор — без изменений
    ack = {"referral_id": rid, "inviter_user_id": str(inviter), "invitee_user_id": str(invitee),
           "rewarded_at": "2026-11-17T09:00:05Z"}
    await env.publish("game.referral.rewarded.v1", ack, "lessons")
    assert await _status(env, rid) == ("qualified", None)
    await env.publish("game.referral.rewarded.v1", ack, "gamification")
    await env.publish("game.referral.rewarded.v1", ack, "gamification")
    assert await _status(env, rid) == ("rewarded", None)
    item = (await _view(env, inviter))["items"][0]
    assert item["reward"] == {"freeze": 2, "til": 0} and item["reward_outcome"] == "rewarded"
    # события не от своих издателей не исполняются
    await _lesson(env, invitee, T0 + timedelta(days=2), lesson_id="L9", producer="gamification")
    # записей — по сессиям (повтор урока L1 — отдельная сессия), уроков в зачёт — 4 разных
    assert len(await env.sql("SELECT 1 FROM referral_lessons WHERE referral_id = :r", r=uuid.UUID(rid))) == 5
    assert env.bus.dlq == []


async def test_self_and_repeat_referral_impossible(env) -> None:
    inviter, invitee, _ = await _referral(env)
    _, token = await env.invite(inviter, "referral")
    r = await env.open(inviter, token)
    assert r.json()["reason"] == "self"
    other = env.identity.add()
    iid2, token2 = await env.invite(other, "referral")
    await env.open(invitee, token2)
    r = await env.accept(invitee, iid2)
    assert r.status_code == 409 and r.json()["code"] == "INVITE_ALREADY_USED"
    assert len(await env.sql("SELECT 1 FROM referrals")) == 1


async def test_family_member_is_rejected(env) -> None:
    inviter, invitee = env.identity.add("Мама"), env.identity.add("Сын")
    fid, ftoken = await env.invite(inviter, "family")
    await env.open(invitee, ftoken)
    await env.accept(invitee, fid)
    _, _, rid = await _referral(env, inviter, invitee)
    assert await _status(env, rid) == ("rejected", "family_member")
    [ev] = await env.events("social.referral.rejected.v1")
    assert ev.payload == {"referral_id": rid, "inviter_user_id": str(inviter), "reject_code": "family_member",
                          "rejected_at": "2026-11-16T08:00:00.000Z"}
    item = (await _view(env, inviter))["items"][0]
    assert item["status"] == "rejected" and item["reject_code"] == "family_member" and "risk_flags" not in item
    # ревью п. 6: автоматический отказ правила не пересматривается — награда без условий невозможна
    row = (await env.c.get(f"{ADMIN}/{rid}", headers=env.staff())).json()
    assert row["risk_flags"] == ["family_member"] and row["can_redecide"] is False
    r = await env.c.post(f"{ADMIN}/{rid}/approve", json={"note": "Одобряю без условий"}, headers=env.staff())
    assert r.status_code == 409 and r.json()["code"] == "REFERRAL_STATE"
    assert await _status(env, rid) == ("rejected", "family_member")
    assert await env.events("social.referral.qualified.v1") == []


async def test_velocity_goes_to_review_and_operator_decides(env) -> None:
    await _set_campaign(env, **{"review.velocity_per_day": "1"})
    inviter = env.identity.add("Пригласивший")
    env.now = T0 + timedelta(days=5)
    rids = []
    for _ in range(2):
        _, invitee, rid = await _referral(env, inviter)
        rids.append(rid)
        await _diag(env, invitee, env.now)
        for i, day in enumerate((0, 0, 1)):
            await _lesson(env, invitee, env.now + timedelta(days=day, minutes=i), lesson_id=f"L{i}",
                          local_date=(env.now + timedelta(days=day)).date().isoformat())
    env.now += timedelta(days=2)
    assert await _status(env, rids[0]) == ("qualified", None)
    assert await _status(env, rids[1]) == ("review", None)
    [held] = await env.events("social.referral.held.v1")
    assert held.payload["referral_id"] == rids[1] and set(held.payload) == {"referral_id", "held_at"}
    # ученик видит «проверка» без флагов
    items = {i["referral_id"]: i for i in (await _view(env, inviter))["items"]}
    assert items[rids[1]]["status"] == "review" and items[rids[1]]["reject_code"] is None
    # очередь оператора: факты и флаги, без ПДн
    queue = (await env.c.get(ADMIN, params={"status": "review"}, headers=env.staff("referral.read"))).json()
    [row] = queue["items"]
    assert row["referral_id"] == rids[1] and row["risk_flags"] == ["velocity"]
    assert (row["lessons"], row["days"], row["minutes_total"]) == (3, 2, 30)
    full = (await env.c.get(f"{ADMIN}/{rids[1]}", headers=env.staff("referral.read"))).json()
    assert [x["minutes"] for x in full["lessons_log"]] == [10, 10, 10]
    assert full["inviter_month"] == {"qualified": 1, "cap": 10} and full["decision_history"] == []
    # права: чтение — нельзя решать; причина ≥ 10
    r = await env.c.post(f"{ADMIN}/{rids[1]}/reject", json={"reject_code": "review_rejected",
                                                            "note": "Подозрительно быстро"},
                         headers=env.staff("referral.read"))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    assert (await env.c.post(f"{ADMIN}/{rids[1]}/reject", json={"reject_code": "review_rejected", "note": "мало"},
                             headers=env.staff())).status_code == 422
    assert (await env.c.post(f"{ADMIN}/{rids[1]}/reject", json={"reject_code": "monthly_cap",
                                                                "note": "Нельзя этот код"},
                             headers=env.staff())).status_code == 422
    r = await env.c.post(f"{ADMIN}/{rids[1]}/reject", json={"reject_code": "review_rejected",
                                                            "note": "Подозрительно быстро"}, headers=env.staff())
    assert r.status_code == 200 and r.json()["status"] == "rejected" and r.json()["can_redecide"] is True
    rejected = [e.payload for e in await env.events("social.referral.rejected.v1")]
    assert rejected[-1]["reject_code"] == "review_rejected"
    # повторное отклонение — 409; пересмотр: одобрение один раз, прежнее решение сохраняется
    r = await env.c.post(f"{ADMIN}/{rids[1]}/reject", json={"reject_code": "review_rejected",
                                                            "note": "Подозрительно быстро"}, headers=env.staff())
    assert r.status_code == 409 and r.json()["code"] == "REFERRAL_STATE"
    r = await env.c.post(f"{ADMIN}/{rids[1]}/approve", json={"note": "Проверили — реальный ученик"},
                         headers=env.staff(staff_id="staff-2"))
    assert r.status_code == 200 and r.json()["status"] == "qualified" and r.json()["can_redecide"] is False
    hist = r.json()["decision_history"]
    assert [(h["decision"], h["reject_code"], h["by"]["staff_id"]) for h in hist] == [
        ("rejected", "review_rejected", "staff-1"), ("approved", None, "staff-2")]
    r = await env.c.post(f"{ADMIN}/{rids[1]}/approve", json={"note": "Ещё раз одобряем"}, headers=env.staff())
    assert r.status_code == 409 and r.json()["details"] == {"status": "qualified"}
    assert len(await env.events("social.referral.qualified.v1")) == 2
    actions = [e.payload["action"] for e in await env.events("admin.audit.recorded.v1")]
    assert actions.count("referral.rejected") == 1 and actions.count("referral.approved") == 1
    assert (await env.c.post(f"{ADMIN}/{uuid.uuid4()}/approve", json={"note": "Нет такого реферала"},
                             headers=env.staff())).status_code == 404


async def test_short_lessons_and_activity_before_accept(env) -> None:
    inviter = env.identity.add()
    invitee = env.identity.add()
    # занятия до принятия приглашения
    env.now = T0 - timedelta(days=2)
    await _lesson(env, invitee, env.now, lesson_id="L0")
    env.now = T0
    _, _, rid = await _referral(env, inviter, invitee)
    env.now = T0 + timedelta(days=3)
    await _diag(env, invitee, T0)
    for i, day in enumerate((0, 1, 1)):
        await _lesson(env, invitee, T0 + timedelta(days=day, minutes=i + 1), lesson_id=f"L{i + 1}", minutes=1)
    assert await _status(env, rid) == ("review", None)
    flags = (await env.c.get(f"{ADMIN}/{rid}", headers=env.staff())).json()["risk_flags"]
    assert flags == ["activity_before_accept", "short_lessons"]
    r = await env.c.post(f"{ADMIN}/{rid}/reject", json={"reject_code": "not_new_user",
                                                        "note": "Занимался до приглашения"}, headers=env.staff())
    assert r.json()["reject_code"] == "not_new_user"
    assert (await _view(env, inviter))["items"][0]["reject_code"] == "not_new_user"


async def test_monthly_cap(env) -> None:
    await _set_campaign(env, monthly_cap="1")
    inviter = env.identity.add()
    statuses = []
    for k in range(2):
        env.now = T0 + timedelta(days=k * 3)
        _, invitee, rid = await _referral(env, inviter)
        start = env.now
        env.now = start + timedelta(days=2)
        await _diag(env, invitee, start)
        for i, day in enumerate((0, 0, 1)):
            await _lesson(env, invitee, start + timedelta(days=day, minutes=i + 1), lesson_id=f"L{i}")
        statuses.append(await _status(env, rid))
    assert statuses == [("qualified", None), ("capped", "monthly_cap")]
    # лимит кампании — в событии (gamification считает по нему, ревью Н3)
    assert [q.payload["inviter_monthly_cap"] for q in await env.events("social.referral.qualified.v1")] == [1]
    capped = [e.payload for e in await env.events("social.referral.rejected.v1")]
    assert [c["reject_code"] for c in capped] == ["monthly_cap"]
    view = await _view(env, inviter)
    assert view["month"] == {"qualified": 1, "cap": 1}
    assert [i["reward"] for i in view["items"]] == [None, {"freeze": 2, "til": 0}]
    # одобрение оператором тоже проходит через лимит месяца
    assert len(await env.events("social.referral.qualified.v1")) == 1


async def test_window_expired_by_tick(env) -> None:
    inviter, invitee, rid = await _referral(env)
    env.now = T0 + timedelta(days=29, hours=23)
    assert (await env.tick_all())["referrals_expired"] == 0
    env.now = T0 + timedelta(days=30)
    assert (await env.tick_all())["referrals_expired"] == 1
    assert (await env.tick_all())["referrals_expired"] == 0
    assert await _status(env, rid) == ("expired", "window_expired")
    [ev] = await env.events("social.referral.rejected.v1")
    assert ev.payload["reject_code"] == "window_expired" and ev.payload["rejected_at"] == "2026-12-16T08:00:00.000Z"
    # уроки после окна не считаются и статус не меняют
    await _lesson(env, invitee, env.now, lesson_id="late")
    assert await _status(env, rid) == ("expired", "window_expired")
    assert (await _view(env, inviter))["items"][0]["reject_code"] == "window_expired"


async def test_kids_and_access(env) -> None:
    parent = env.identity.add()
    child = env.identity.add(age="6-9", kind="child")
    r = await env.c.get("/internal/v1/me/referrals", headers=env.lh(child, account=parent, age_band="6-9"))
    assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"
    assert (await env.c.get("/internal/v1/me/referrals")).status_code == 401
    assert (await env.c.get(ADMIN, headers=env.staff("social.read"))).status_code == 403
    # чужие рефералы не видны
    inviter, _, _ = await _referral(env)
    assert (await _view(env, env.identity.add()))["items"] == []
    assert len((await _view(env, inviter))["items"]) == 1


async def test_campaign_versions(env) -> None:
    listing = (await env.c.get(f"{ADMIN}/campaigns", headers=env.staff("referral.read"))).json()["items"]
    assert [(v["version"], v["status"], v["created_by"]) for v in listing] == [(1, "active", None)]
    v1 = (await env.c.get(f"{ADMIN}/campaigns/1", headers=env.staff("referral.read"))).json()
    assert v1["payload"]["monthly_cap"] == 10 and v1["diff"] == []
    payload = {**v1["payload"], "min_lessons": 4, "inviter_reward": {"freeze": 3, "til": 50}}
    # структурные ошибки не сохраняются
    for bad in ({**payload, "extra": 1}, {k: v for k, v in payload.items() if k != "min_days"},
                {**payload, "min_lessons": "4"}, [1, 2]):
        r = await env.c.put(f"{ADMIN}/campaigns/draft", json={"payload": bad, "comment": None},
                            headers=env.staff())
        assert r.status_code == 422 and r.json()["code"] == "CAMPAIGN_INVALID", bad
    assert (await env.c.put(f"{ADMIN}/campaigns/draft", json={"payload": payload},
                            headers=env.staff("referral.read"))).status_code == 403
    r = await env.c.put(f"{ADMIN}/campaigns/draft", json={"payload": {**payload, "window_days": 200},
                                                          "comment": "Весна", "based_on": 1}, headers=env.staff())
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["status"] == "draft"
    updated_at = r.json()["updated_at"]
    assert {"path": "min_lessons", "from": 3, "to": 4} in r.json()["diff"]
    r = await env.c.put(f"{ADMIN}/campaigns/draft", json={"payload": payload}, headers=env.staff())
    assert r.status_code == 409 and r.json()["code"] == "DRAFT_CONFLICT"
    v = await env.c.post(f"{ADMIN}/campaigns/draft/validate", headers=env.staff())
    assert v.json()["ok"] is False and {"path": "window_days", "code": "range"} in v.json()["errors"]
    r = await env.c.post(f"{ADMIN}/campaigns/draft/activate", json={"comment": "Запуск весенней кампании"},
                         headers=env.staff(step_up=True))
    assert r.status_code == 409 and r.json()["code"] == "CAMPAIGN_NOT_VALIDATED"
    env.now += timedelta(minutes=1)
    r = await env.c.put(f"{ADMIN}/campaigns/draft", json={"payload": payload, "comment": "Весна"},
                        headers={**env.staff(), "If-Match": updated_at})
    assert r.status_code == 200
    v = await env.c.post(f"{ADMIN}/campaigns/draft/validate", headers=env.staff())
    assert v.json() == {"ok": True, "errors": [], "warnings": []}
    # старый реферал — на версии 1, после активации новые — на версии 2
    _, _, old_rid = await _referral(env)
    r = await env.c.post(f"{ADMIN}/campaigns/draft/activate", json={"comment": "Запуск весенней кампании"},
                         headers=env.staff())
    assert r.status_code == 403 and r.json()["code"] == "STEP_UP_REQUIRED"
    r = await env.c.post(f"{ADMIN}/campaigns/draft/activate", json={"comment": "коротко"},
                         headers=env.staff(step_up=True))
    assert r.status_code == 422
    r = await env.c.post(f"{ADMIN}/campaigns/draft/activate", json={"comment": "Запуск весенней кампании"},
                         headers=env.staff(step_up=True))
    assert r.status_code == 200 and r.json()["status"] == "active"
    assert r.json()["activated_by"] == {"staff_id": "staff-1", "name": "Модератор"}
    listing = (await env.c.get(f"{ADMIN}/campaigns", headers=env.staff())).json()["items"]
    assert [(v["version"], v["status"]) for v in listing] == [(2, "active"), (1, "archived")]
    _, _, new_rid = await _referral(env)
    versions = dict(await env.sql("SELECT referral_id::text, campaign_version FROM referrals"))
    assert versions == {old_rid: 1, new_rid: 2}
    terms = (await _view(env, env.identity.add()))["terms"]
    assert terms["campaign_version"] == 2 and terms["inviter_reward"] == {"freeze": 3, "til": 50}
    stats = (await env.c.get(f"{ADMIN}/campaigns/stats", headers=env.staff("referral.read"))).json()["items"]
    assert [(s["version"], s["invited"], s["in_progress"]) for s in stats] == [(2, 1, 1), (1, 1, 1)]
    assert stats[0]["rewards"] == {"inviter": {"freeze": 0, "til": 0}, "invitee": {"freeze": 0, "til": 0}}
    # черновик: удалить; нет черновика — 404
    await env.c.put(f"{ADMIN}/campaigns/draft", json={"payload": payload}, headers=env.staff())
    assert (await env.c.delete(f"{ADMIN}/campaigns/draft", headers=env.staff())).status_code == 204
    r = await env.c.delete(f"{ADMIN}/campaigns/draft", headers=env.staff())
    assert r.status_code == 404 and r.json()["code"] == "CAMPAIGN_VERSION_NOT_FOUND"
    assert (await env.c.get(f"{ADMIN}/campaigns/99", headers=env.staff())).status_code == 404
    actions = {e.payload["action"] for e in await env.events("admin.audit.recorded.v1")}
    assert {"referral.campaign.draft_created", "referral.campaign.draft_saved", "referral.campaign.validated",
            "referral.campaign.activated", "referral.campaign.draft_deleted"} <= actions


async def test_rewarded_stats(env) -> None:
    inviter, invitee, rid = await _referral(env)
    env.now = T0 + timedelta(days=3)
    await _diag(env, invitee, T0)
    for i, day in enumerate((0, 1, 1)):
        await _lesson(env, invitee, T0 + timedelta(days=day, minutes=i + 1), lesson_id=f"L{i}")
    await env.publish("game.referral.rewarded.v1", {"referral_id": rid, "inviter_user_id": str(inviter),
                                                    "rewarded_at": "2026-11-18T00:00:00Z"}, "gamification")
    [s] = (await env.c.get(f"{ADMIN}/campaigns/stats", headers=env.staff())).json()["items"]
    assert s["qualified"] == 1 and s["rewards"]["inviter"] == {"freeze": 2, "til": 0}


async def test_migration_moves_recent_referral_invites() -> None:
    """0002: версия кампании 1 — active; принятые реферальные приглашения последних 30 дней → referrals (invited);
    реестр member_id — для известных учеников."""
    schema = unique_schema("soc_mig")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    try:
        await migrate(SERVICE_DIR, settings, revision="0001")
        from tilhero_common.db import make_engine
        engine = make_engine(TEST_ADMIN_URL, schema, pool_size=1)
        inviter, recent, old, friend = (uuid.uuid4() for _ in range(4))
        async with engine.begin() as conn:
            for kind, invitee, days in (("referral", recent, 10), ("referral", old, 40), ("friend", friend, 5)):
                iid = uuid.uuid4()
                await conn.execute(text(
                    "INSERT INTO invites (invite_id, inviter_user_id, kind, token_hash, status, uses, "
                    "idempotency_key, created_at, updated_at) VALUES (:i, :u, :k, :h, 'active', 1, :key, now(), "
                    "now())"), {"i": iid, "u": inviter, "k": kind, "h": uuid.uuid4().hex, "key": str(iid)})
                await conn.execute(text(
                    "INSERT INTO invite_redemptions (invite_id, invitee_user_id, opened_at, accepted_at) "
                    "VALUES (:i, :v, now() - make_interval(days => :d), now() - make_interval(days => :d))"),
                    {"i": iid, "v": invitee, "d": days})
        await migrate(SERVICE_DIR, settings)
        async with engine.begin() as conn:
            rows = (await conn.execute(text(
                "SELECT inviter_user_id, invitee_user_id, status, campaign_version FROM referrals"))).all()
            assert rows == [(inviter, recent, "invited", 1)]
            camp = (await conn.execute(text("SELECT version, status FROM referral_campaigns"))).all()
            assert camp == [(1, "active")]
            mids = dict((await conn.execute(text("SELECT user_id, member_id FROM member_ids"))).all())
        await engine.dispose()
        from tilhero_social.domain.members import member_id_of
        assert mids == {u: member_id_of(settings.member_key_bytes(), u) for u in (inviter, recent, old, friend)}
    finally:
        await drop_schema(schema)


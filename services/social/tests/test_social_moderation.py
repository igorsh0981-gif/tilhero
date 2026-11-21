"""Жалобы и модерация (§1.3, AT-79, ADM-SOC-01/03): жалоба → дело (без переписки) → санкция с основанием, сроком и
исполнителем → ограничение действует (403 SOCIAL_RESTRICTED) → обжалование → решение; история; step-up для бана
больше 7 дней и бессрочного; истечение по tick; аудит каждой команды; карточка ученика и блок дашборда."""

from __future__ import annotations

import uuid
from datetime import timedelta

ADMIN = "/internal/v1/admin"


async def _complain(env, reporter, target, *, kind="user", subject=None, reason="abuse", comment=None,
                    block=False, key=None, **kw):
    await env.community(target)
    body = {"member_id": env.mid(target), "subject_kind": kind, "subject_id": subject, "reason": reason,
            "block": block}
    if comment is not None:
        body["comment"] = comment
    return await env.c.post("/internal/v1/me/complaints", json=body,
                            headers={**env.lh(reporter, **kw), "Idempotency-Key": key or str(uuid.uuid4())})


async def _audits(env, action):
    return [e for e in await env.events("admin.audit.recorded.v1") if e.payload["action"] == action]


async def test_complaint_creates_case_once_per_day(env) -> None:
    reporter, target = env.identity.add(), env.identity.add()
    await env.nick(target, "Rude_one")
    r = await _complain(env, reporter, target, comment="Пишет гадости в нике", key="complaint-0001")
    assert r.status_code == 201, r.text
    case_id = r.json()["case_id"]
    assert r.json() == {"case_id": case_id, "created_at": "2026-11-16T08:00:00.000Z", "blocked": False}
    again = await _complain(env, reporter, target, comment="Пишет гадости в нике", key="complaint-0001")
    assert again.status_code == 200 and again.headers["Idempotent-Replayed"] == "true"
    # повтор на ту же цель (другой ключ) за 24 ч — тот же case_id
    env.now += timedelta(hours=23)
    same = await _complain(env, reporter, target, reason="spam")
    assert same.status_code == 200 and same.json()["case_id"] == case_id
    other_kind = await _complain(env, reporter, target, kind="nickname")
    assert other_kind.status_code == 201 and other_kind.json()["case_id"] != case_id
    env.now += timedelta(hours=2)
    assert (await _complain(env, reporter, target)).json()["case_id"] != case_id
    # комментарий жалобы — только в деле; ни в событиях, ни в аудите
    await env.flush()
    assert "гадости" not in str([e.payload for e in env.bus.published])


async def test_complaint_validation_limits_block_and_kids(env) -> None:
    reporter, target = env.identity.add(), env.identity.add()
    r = await _complain(env, reporter, target, kind="duel")
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"
    r = await _complain(env, reporter, target, kind="user", subject=str(uuid.uuid4()))
    assert r.status_code == 422
    r = await _complain(env, reporter, target, kind="pair_room", subject="not-a-uuid")
    assert r.status_code == 422
    r = await _complain(env, reporter, target, comment="x" * 501)
    assert r.status_code == 422
    r = await _complain(env, reporter, target, kind="duel", subject=str(uuid.uuid4()), block=True)
    assert r.status_code == 201 and r.json()["blocked"] is True
    assert await env.sql("SELECT 1 FROM blocks WHERE blocker = :a AND blocked = :b", a=reporter, b=target) == [(1,)]
    await env.community(reporter)
    r = await env.c.post("/internal/v1/me/complaints", json={"member_id": env.mid(reporter), "subject_kind": "user",
                                                             "subject_id": None, "reason": "spam"},
                         headers={**env.lh(reporter), "Idempotency-Key": "self-complaint-1"})
    assert r.status_code == 422
    r = await env.c.post("/internal/v1/me/complaints", json={"member_id": "mb_" + "Z" * 22, "subject_kind": "user",
                                                             "subject_id": None, "reason": "spam"},
                         headers={**env.lh(reporter), "Idempotency-Key": "unknown-target-1"})
    assert r.status_code == 404 and r.json()["code"] == "MEMBER_NOT_FOUND"
    env.settings.complaints_per_day = 2  # type: ignore[misc]
    await _complain(env, reporter, target, kind="pair_room", subject=str(uuid.uuid4()))
    r = await _complain(env, reporter, target, kind="invite", subject=str(uuid.uuid4()))
    assert r.status_code == 429 and r.json()["code"] == "COMPLAINTS_LIMIT"
    parent = env.identity.add()
    child = env.identity.add(age="6-9", kind="child")
    r = await _complain(env, child, target, account=parent, age_band="6-9")
    assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"


async def test_case_to_ban_restricts_and_expires(env) -> None:
    reporter, target, friend = env.identity.add(), env.identity.add(), env.identity.add()
    await env.nick(target, "Spammer")
    rid = (await env.request_friend(friend, target)).json()["request_id"]
    case_id = (await _complain(env, reporter, target, reason="spam")).json()["case_id"]
    # права и step-up
    r = await env.c.get(f"{ADMIN}/moderation/cases", headers=env.staff("social.read"))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    assert (await env.c.get(f"{ADMIN}/moderation/cases", headers=env.staff(actor=False))).status_code == 403
    assert (await env.c.get(f"{ADMIN}/moderation/cases",
                            headers=env.staff(issuer="telegram-bff"))).status_code == 403
    rows = (await env.c.get(f"{ADMIN}/moderation/cases", params={"status": "open"},
                            headers=env.staff())).json()
    assert rows["items"][0] == {"case_id": case_id, "status": "open", "reporter_user_id": str(reporter),
                                "target_user_id": str(target), "target_nickname": "Spammer",
                                "subject_kind": "user", "subject_id": None, "reason": "spam",
                                "target_complaints_30d": 1, "created_at": "2026-11-16T08:00:00.000Z",
                                "resolved_at": None}
    card = (await env.c.get(f"{ADMIN}/moderation/cases/{case_id}", headers=env.staff())).json()
    assert card["subject"] == {"nickname_at_report": "Spammer", "status": None} and card["resolution"] is None
    body = {"action": "social_ban", "days": 8, "basis": "Массовый спам заявками"}
    r = await env.c.post(f"{ADMIN}/moderation/cases/{case_id}/resolve", json=body, headers=env.staff())
    assert r.status_code == 403 and r.json()["code"] == "STEP_UP_REQUIRED"
    r = await env.c.post(f"{ADMIN}/moderation/cases/{case_id}/resolve", json={**body, "days": None},
                         headers=env.staff())
    assert r.json()["code"] == "STEP_UP_REQUIRED"
    r = await env.c.post(f"{ADMIN}/moderation/cases/{case_id}/resolve", json={**body, "basis": "short"},
                         headers=env.staff(step_up=True))
    assert r.status_code == 422
    r = await env.c.post(f"{ADMIN}/moderation/cases/{case_id}/resolve", json={**body, "action": "warning"},
                         headers=env.staff())
    assert r.status_code == 422  # days только для social_ban
    r = await env.c.post(f"{ADMIN}/moderation/cases/{case_id}/resolve", json={**body, "days": 3},
                         headers=env.staff())
    assert r.status_code == 200, r.text
    case = r.json()
    assert case["status"] == "resolved" and case["resolution"]["action"] == "social_ban"
    assert case["resolution"]["resolved_by"] == {"staff_id": "staff-1", "name": "Модератор"}
    [sanction] = case["target_sanctions"]
    assert sanction["until"] == "2026-11-19T08:00:00.000Z" and sanction["active"] is True
    assert sanction["basis"] == "Массовый спам заявками" and sanction["case_id"] == case_id
    r = await env.c.post(f"{ADMIN}/moderation/cases/{case_id}/resolve", json={**body, "days": 3},
                         headers=env.staff())
    assert r.status_code == 409 and r.json()["code"] == "CASE_STATE" and r.json()["details"] == {"status": "resolved"}
    [sc] = await env.events("social.sanction.changed.v1")
    assert sc.payload == {"user_id": str(target), "sanction_id": sanction["sanction_id"], "kind": "social_ban",
                          "until": "2026-11-19T08:00:00.000Z", "active": True, "change": "applied",
                          "changed_at": "2026-11-16T08:00:00.000Z"}
    [cr] = await env.events("social.case.resolved.v1")
    assert cr.payload == {"case_id": case_id, "reporter_user_id": str(reporter), "outcome": "action_taken",
                          "resolved_at": "2026-11-16T08:00:00.000Z"}
    [audit] = await _audits(env, "social.case.resolved")
    assert audit.payload["actor_id"] == "staff-1" and audit.payload["reason"] == "Массовый спам заявками"
    # ограничение действует: заявки и принятие — 403 SOCIAL_RESTRICTED {until}; профиль показывает запрет
    r = await env.request_friend(target, env.identity.add())
    assert r.status_code == 403 and r.json()["code"] == "SOCIAL_RESTRICTED"
    assert r.json()["details"] == {"until": "2026-11-19T08:00:00.000Z"}
    r = await env.c.post(f"/internal/v1/me/friend-requests/{rid}/accept", headers=env.lh(target))
    assert r.status_code == 403 and r.json()["code"] == "SOCIAL_RESTRICTED"
    assert (await env.community(target))["restrictions"] == {"social_ban": True,
                                                            "social_ban_until": "2026-11-19T08:00:00.000Z"}
    # дружба через приглашение Telegram — тоже под запретом
    iid, token = await env.invite(env.identity.add(), "friend")
    await env.open(target, token)
    r = await env.accept(target, iid)
    assert r.status_code == 403 and r.json()["code"] == "SOCIAL_RESTRICTED"
    rel = (await env.c.get(f"/internal/v1/relations/{friend}/{target}", headers=env.svc())).json()
    assert rel["b_restricted"] is True and rel["b_restricted_until"] == "2026-11-19T08:00:00.000Z"
    # ученик видит санкцию с основанием и сроком, без исполнителя
    mine = (await env.c.get("/internal/v1/me/sanctions", headers=env.lh(target))).json()["items"]
    assert mine == [{"sanction_id": sanction["sanction_id"], "kind": "social_ban",
                     "basis": "Массовый спам заявками", "decided_at": "2026-11-16T08:00:00.000Z",
                     "until": "2026-11-19T08:00:00.000Z", "active": True, "revoked_at": None, "appeal": None,
                     "can_appeal": True}]
    # срок истёк: запрет снят сразу, tick публикует active=false один раз
    env.now += timedelta(days=3)
    assert (await env.request_friend(target, env.identity.add())).status_code == 201
    out = await env.tick_all()
    assert out["sanctions_expired"] == 1 and (await env.tick_all())["sanctions_expired"] == 0
    expired = [e for e in await env.events("social.sanction.changed.v1") if e.payload["change"] == "expired"]
    assert len(expired) == 1 and expired[0].payload["active"] is False
    assert expired[0].payload["changed_at"] == "2026-11-19T08:00:00.000Z"


async def test_indefinite_ban_with_step_up_revoke_and_appeal(env) -> None:
    reporter, target = env.identity.add(), env.identity.add()
    case_id = (await _complain(env, reporter, target)).json()["case_id"]
    r = await env.c.post(f"{ADMIN}/moderation/cases/{case_id}/resolve",
                         json={"action": "social_ban", "days": None, "basis": "Оскорбления в комнате"},
                         headers=env.staff(step_up=True))
    assert r.status_code == 200
    sid = r.json()["resolution"]["sanction_id"]
    assert (await env.community(target))["restrictions"] == {"social_ban": True, "social_ban_until": None}
    r = await env.request_friend(target, env.identity.add())
    assert r.json()["details"] == {"until": None}
    # обжалование: одно на санкцию; повтор ключа — 200
    url = f"/internal/v1/me/sanctions/{sid}/appeal"
    r = await env.c.post(url, json={"text": "Я не оскорблял, это ошибка"},
                         headers={**env.lh(target), "Idempotency-Key": "appeal-key-1"})
    assert r.status_code == 201 and r.json()["appeal"]["status"] == "open" and r.json()["can_appeal"] is False
    r2 = await env.c.post(url, json={"text": "Я не оскорблял, это ошибка"},
                          headers={**env.lh(target), "Idempotency-Key": "appeal-key-1"})
    assert r2.status_code == 200 and r2.json() == r.json()
    r3 = await env.c.post(url, json={"text": "Ещё одно обжалование"},
                          headers={**env.lh(target), "Idempotency-Key": "appeal-key-2"})
    assert r3.status_code == 409 and r3.json()["code"] == "APPEAL_EXISTS"
    assert (await env.c.post(url, json={"text": "коротко"},
                             headers={**env.lh(target), "Idempotency-Key": "appeal-key-3"})).status_code == 422
    r = await env.c.post(f"/internal/v1/me/sanctions/{sid}/appeal", json={"text": "Чужая санкция тут"},
                         headers={**env.lh(reporter), "Idempotency-Key": "appeal-key-4"})
    assert r.status_code == 404 and r.json()["code"] == "SANCTION_NOT_FOUND"
    appeals = (await env.c.get(f"{ADMIN}/moderation/appeals", params={"status": "open"},
                               headers=env.staff())).json()["items"]
    assert len(appeals) == 1 and appeals[0]["text"] == "Я не оскорблял, это ошибка"
    aid = appeals[0]["appeal_id"]
    r = await env.c.post(f"{ADMIN}/moderation/appeals/{aid}/decide",
                         json={"decision": "overturned", "note": "Проверили: ошибка модератора"},
                         headers=env.staff())
    assert r.status_code == 200 and r.json()["status"] == "overturned"
    assert r.json()["sanction"]["active"] is False and r.json()["sanction"]["revoked_at"]
    r = await env.c.post(f"{ADMIN}/moderation/appeals/{aid}/decide",
                         json={"decision": "upheld", "note": "Передумали, оставляем"}, headers=env.staff())
    assert r.status_code == 409 and r.json() == {**r.json(), "code": "APPEAL_STATE",
                                                 "details": {"status": "overturned"}}
    [ad] = await env.events("social.appeal.decided.v1")
    assert ad.payload == {"appeal_id": aid, "sanction_id": sid, "user_id": str(target), "decision": "overturned",
                          "decided_at": "2026-11-16T08:00:00.000Z"}
    changes = [e.payload["change"] for e in await env.events("social.sanction.changed.v1")]
    assert changes == ["applied", "overturned"]
    assert (await env.request_friend(target, env.identity.add())).status_code == 201
    mine = (await env.c.get("/internal/v1/me/sanctions", headers=env.lh(target))).json()["items"][0]
    assert mine["appeal"]["decision_note"] == "Проверили: ошибка модератора" and mine["active"] is False
    # снятие уже снятой — 409; аудит каждой команды
    r = await env.c.post(f"{ADMIN}/moderation/sanctions/{sid}/revoke", json={"reason": "Повторное снятие"},
                         headers=env.staff())
    assert r.status_code == 409 and r.json()["code"] == "SANCTION_STATE"
    assert len(await _audits(env, "social.appeal.decided")) == 1


async def test_warning_nickname_reset_dismiss_and_revoke(env) -> None:
    reporter, target = env.identity.add(), env.identity.add()
    await env.nick(target, "BadName")
    c1 = (await _complain(env, reporter, target, kind="nickname", reason="inappropriate_nickname")).json()["case_id"]
    r = await env.c.post(f"{ADMIN}/moderation/cases/{c1}/resolve",
                         json={"action": "nickname_reset", "basis": "Ник нарушает правила"}, headers=env.staff())
    assert r.status_code == 200
    # ревью п. 5: сброс — ограничение: новый ник — через 7 дней от сброса, сброшенный — в стоп-листе навсегда и для всех
    prof = await env.community(target)
    assert prof["nickname"] is None and prof["nickname_change_available_at"] == "2026-11-23T08:00:00.000Z"
    r = await env.nick(target, "GoodName")
    assert r.status_code == 429 and r.json()["code"] == "NICKNAME_COOLDOWN"
    assert r.json()["details"] == {"until": "2026-11-23T08:00:00.000Z"}
    other = env.identity.add()
    for twin in ("BadName", "badname", "ВаdNаme"):
        r = await env.nick(other, twin)
        assert r.status_code == 422 and r.json()["details"] == {"reason": "forbidden"}, twin
    env.now += timedelta(days=7)
    r = await env.nick(target, "BadName")
    assert r.status_code == 422 and r.json()["details"] == {"reason": "forbidden"}
    assert (await env.nick(target, "GoodName")).status_code == 200
    upd = [e.payload["nickname"] for e in await env.events("social.profile.updated.v1")]
    assert upd == ["BadName", None, "GoodName"]
    assert await env.sql("SELECT nickname_lc, user_id FROM nickname_stoplist") == [("badname", target)]
    c2 = (await _complain(env, reporter, target, reason="spam")).json()["case_id"]
    r = await env.c.post(f"{ADMIN}/moderation/cases/{c2}/resolve",
                         json={"action": "dismiss", "basis": "Нарушения не найдено"}, headers=env.staff())
    assert r.json()["status"] == "dismissed" and r.json()["resolution"]["sanction_id"] is None
    outcomes = [e.payload["outcome"] for e in await env.events("social.case.resolved.v1")]
    assert outcomes == ["action_taken", "dismissed"]
    c3 = (await _complain(env, env.identity.add(), target)).json()["case_id"]
    r = await env.c.post(f"{ADMIN}/moderation/cases/{c3}/resolve",
                         json={"action": "warning", "basis": "Предупреждение за грубость"}, headers=env.staff())
    sid = r.json()["resolution"]["sanction_id"]
    r = await env.c.post(f"{ADMIN}/moderation/sanctions/{sid}/revoke", json={"reason": "Снято по ошибке"},
                         headers=env.staff())
    assert r.status_code == 200 and r.json()["revoked_by"] == {"staff_id": "staff-1", "name": "Модератор"}
    assert r.json()["revoke_reason"] == "Снято по ошибке" and r.json()["active"] is False
    listed = (await env.c.get(f"{ADMIN}/moderation/sanctions", params={"user_id": str(target), "active": "false"},
                              headers=env.staff())).json()["items"]
    assert [s["kind"] for s in listed] == ["warning"]
    live = (await env.c.get(f"{ADMIN}/moderation/sanctions", params={"user_id": str(target), "active": "true"},
                            headers=env.staff())).json()["items"]
    assert [s["kind"] for s in live] == ["nickname_reset"]  # запись о сбросе ника действует, пока не снята
    assert (await env.c.post(f"{ADMIN}/moderation/sanctions/{uuid.uuid4()}/revoke",
                             json={"reason": "Нет такой санкции"}, headers=env.staff())).status_code == 404
    assert (await env.c.get(f"{ADMIN}/moderation/cases/{uuid.uuid4()}", headers=env.staff())).json()["code"] == \
        "CASE_NOT_FOUND"
    for action in ("social.case.resolved", "social.sanction.revoked"):
        assert await _audits(env, action), action


async def test_cases_pagination_order(env) -> None:
    reporter = env.identity.add()
    ids = []
    for _ in range(3):
        ids.append((await _complain(env, reporter, env.identity.add())).json()["case_id"])
        env.now += timedelta(minutes=1)
    p1 = (await env.c.get(f"{ADMIN}/moderation/cases", params={"status": "open", "limit": 2},
                          headers=env.staff())).json()
    p2 = (await env.c.get(f"{ADMIN}/moderation/cases", params={"status": "open", "limit": 2,
                                                                "cursor": p1["next_cursor"]},
                          headers=env.staff())).json()
    assert [c["case_id"] for c in p1["items"] + p2["items"]] == ids and p2["next_cursor"] is None
    allc = (await env.c.get(f"{ADMIN}/moderation/cases", headers=env.staff())).json()
    assert [c["case_id"] for c in allc["items"]] == ids[::-1]


async def test_admin_social_card_and_stats(env) -> None:
    a, b, c = env.identity.add(), env.identity.add(), env.identity.add()
    await env.nick(a, "Card_user")
    await env.befriend(a, b)
    await env.community(c)
    await env.request_friend(c, a)
    await env.c.post("/internal/v1/me/blocks", json={"member_id": env.mid(c)}, headers=env.lh(a))
    await _complain(env, c, a)
    r = await env.c.get(f"{ADMIN}/social/users/{a}", headers=env.staff("moderation.manage"))
    assert r.status_code == 403
    card = (await env.c.get(f"{ADMIN}/social/users/{a}", headers=env.staff("social.read"))).json()
    assert card["user_id"] == str(a) and card["member_id"] == env.mid(a) and card["nickname"] == "Card_user"
    assert card["friends"] == 1 and card["blocks"] == {"given": 1, "received": 0}
    assert sorted((x["direction"], x["status"]) for x in card["requests"]) == [("in", "cancelled"),
                                                                               ("out", "accepted")]
    assert all(set(x) == {"request_id", "direction", "status", "created_at", "decided_at"} for x in card["requests"])
    assert card["cases"]["as_target"] == 1 and card["cases"]["open_as_target"] == 1
    assert card["restrictions"] == {"social_ban": False, "social_ban_until": None}
    # ученик, известный social только по событию регистрации (без профиля сообщества): member_id есть, нули
    registered = uuid.uuid4()
    await env.profile_event("user.profile.created.v1", {"user_id": str(registered), "kind": "account",
                                                        "age_band": "18+", "created_at": "2026-11-16T07:00:00Z"})
    empty = (await env.c.get(f"{ADMIN}/social/users/{registered}", headers=env.staff("social.read"))).json()
    assert empty["friend_code"] is None and empty["friends"] == 0 and empty["member_id"] == env.mid(registered)
    assert empty["requests"] == [] and empty["sanctions"] == [] and empty["cases"]["as_target"] == 0
    # неизвестный social UUID — 404, как удалённый (без вычисленного member_id)
    r = await env.c.get(f"{ADMIN}/social/users/{uuid.uuid4()}", headers=env.staff("social.read"))
    assert r.status_code == 404 and r.json()["code"] == "SOCIAL_PROFILE_NOT_FOUND"
    assert "member_id" not in r.text
    # известен только по следу в приглашениях (спринт 1) — карточка есть
    inviter = env.identity.add()
    await env.create(inviter, "friend")
    assert (await env.c.get(f"{ADMIN}/social/users/{inviter}", headers=env.staff("social.read"))).status_code == 200
    stats = (await env.c.get(f"{ADMIN}/social/stats", params={"period": "7d"},
                             headers=env.staff("dashboard.read"))).json()
    assert stats == {"period": "7d", "friend_requests": 2, "friendships_added": 1, "duels_finished": None,
                     "pair_rooms_finished": None, "referrals_in_review": 0, "cases_opened": 1, "cases_open": 1}
    assert (await env.c.get(f"{ADMIN}/social/stats", headers=env.staff("game.read"))).status_code == 403
    env.now += timedelta(days=2)
    today = (await env.c.get(f"{ADMIN}/social/stats", params={"period": "today"},
                             headers=env.staff("social.read"))).json()
    assert today["friend_requests"] == 0 and today["cases_open"] == 1

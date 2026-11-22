"""Сага удаления спринта 7 (§1.5, AT-82): профиль сообщества, member_id, заявки, дружбы (событие removed второму),
блокировки, санкции и обжалования удаляются; дела модерации и рефералы обезличиваются (у пригласившего статус
сохраняется). Удаление под блокировкой: событие, обработанное параллельно с сагой, не воскрешает данные. Гонка
квалификаций одного пригласившего — лимит месяца не превышается."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

from test_social_referrals import T0, _diag, _lesson, _referral, _set_campaign, _status, _view


async def _delete(env, user) -> None:
    await env.publish("user.deletion.requested.v1", {"user_id": str(user), "request_id": str(uuid.uuid4()),
                                                     "requested_at": "2026-11-16T08:00:00Z"}, "identity-consent")


async def test_saga_removes_and_anonymizes(env) -> None:
    x, friend, z, w, v = (env.identity.add(n) for n in ("Икс", "Друг", "Зет", "Дабл", "Ви"))
    inviter_of_x = env.identity.add("Пригласивший")
    await env.nick(x, "Xavier")
    await env.befriend(x, friend)
    await env.request_friend(x, z)
    await env.community(w)
    await env.community(v)
    await env.c.post("/internal/v1/me/blocks", json={"member_id": env.mid(w)}, headers=env.lh(x))
    await env.c.post("/internal/v1/me/blocks", json={"member_id": env.mid(x)}, headers=env.lh(v))
    # дело на X (санкция + обжалование) и дело от X (с комментарием)
    r = await env.c.post("/internal/v1/me/complaints", json={
        "member_id": env.mid(x), "subject_kind": "nickname", "subject_id": None, "reason": "abuse"},
        headers={**env.lh(z), "Idempotency-Key": "saga-complaint-1"})
    case_on_x = r.json()["case_id"]
    r = await env.c.post(f"/internal/v1/admin/moderation/cases/{case_on_x}/resolve",
                         json={"action": "warning", "basis": "Грубый ник и сообщения"}, headers=env.staff())
    sid = r.json()["resolution"]["sanction_id"]
    await env.c.post(f"/internal/v1/me/sanctions/{sid}/appeal", json={"text": "Прошу снять предупреждение"},
                     headers={**env.lh(x), "Idempotency-Key": "saga-appeal-1"})
    r = await env.c.post("/internal/v1/me/complaints", json={
        "member_id": env.mid(w), "subject_kind": "user", "subject_id": None, "reason": "spam",
        "comment": "Личный текст жалобщика"}, headers={**env.lh(x), "Idempotency-Key": "saga-complaint-2"})
    case_by_x = r.json()["case_id"]
    r = await env.c.post("/internal/v1/me/complaints", json={
        "member_id": env.mid(x), "subject_kind": "user", "subject_id": None, "reason": "spam"},
        headers={**env.lh(friend), "Idempotency-Key": "saga-complaint-3"})
    open_case_on_x = r.json()["case_id"]
    # X — приглашённый (у пригласившего) и пригласивший
    _, _, rid_x_invitee = await _referral(env, inviter_of_x, x)
    env.now = T0 + timedelta(hours=2)
    await _diag(env, x, T0)
    await _lesson(env, x, T0 + timedelta(hours=1), lesson_id="L1")
    _, j, rid_x_inviter = await _referral(env, x, env.identity.add("Джей"))
    assert await _status(env, rid_x_invitee) == ("learning", None)

    await _delete(env, x)
    [ack] = await env.events("user.domain.deleted.v1")
    assert ack.payload["domain"] == "social"
    for table, col in (("community_profiles", "user_id"), ("member_ids", "user_id"), ("learner_activity", "user_id"),
                       ("sanctions", "user_id"), ("appeals", "user_id"), ("learner_idempotency", "user_id")):
        assert await env.sql(f"SELECT 1 FROM {table} WHERE {col} = :u", u=x) == [], table  # noqa: S608
    assert await env.sql("SELECT 1 FROM friend_requests WHERE from_user = :u OR to_user = :u", u=x) == []
    assert await env.sql("SELECT 1 FROM blocks WHERE blocker = :u OR blocked = :u", u=x) == []
    assert await env.sql("SELECT 1 FROM friendships WHERE user_a = :u OR user_b = :u", u=x) == []
    # дружбы X: заявка (friend), реферальные приглашения (спринт 1: тоже дружба) — второму событие removed
    removed = [e.payload for e in await env.events("social.friendship.changed.v1") if e.payload["status"] == "removed"]
    assert {p["source"] for p in removed} == {"deletion"}
    assert all(str(x) in (p["user_a"], p["user_b"]) for p in removed)
    assert sorted(p["user_b"] if p["user_a"] == str(x) else p["user_a"] for p in removed) == sorted(
        str(u) for u in (friend, inviter_of_x, j))
    # дела: обезличены, решение и основание остаются
    [(rep, tgt, nick, res, basis, san)] = await env.sql(
        "SELECT reporter_user_id, target_user_id, target_nickname_at_report, resolution, resolution_basis, "
        "sanction_id FROM cases WHERE case_id = :c", c=uuid.UUID(case_on_x))
    assert (rep, tgt, nick, res, basis, san) == (z, None, None, "warning", "Грубый ник и сообщения", None)
    [(rep, tgt, comment)] = await env.sql("SELECT reporter_user_id, target_user_id, comment FROM cases "
                                          "WHERE case_id = :c", c=uuid.UUID(case_by_x))
    assert (rep, tgt, comment) == (None, w, None)
    admin_case = (await env.c.get(f"/internal/v1/admin/moderation/cases/{case_on_x}", headers=env.staff())).json()
    assert admin_case["target_user_id"] is None and admin_case["resolution"]["basis"] == "Грубый ник и сообщения"
    # рефералы: у пригласившего статус сохраняется, приглашённый обезличен, его уроки удалены
    [(inv_user, invitee_user, status)] = await env.sql(
        "SELECT inviter_user_id, invitee_user_id, status FROM referrals WHERE referral_id = :r",
        r=uuid.UUID(rid_x_invitee))
    assert (inv_user, invitee_user, status) == (inviter_of_x, None, "learning")
    assert await env.sql("SELECT 1 FROM referral_lessons WHERE referral_id = :r", r=uuid.UUID(rid_x_invitee)) == []
    [item] = (await _view(env, inviter_of_x))["items"]
    assert item["status"] == "learning" and item["invitee_nickname"] is None
    [(inv_user, invitee_user)] = await env.sql(
        "SELECT inviter_user_id, invitee_user_id FROM referrals WHERE referral_id = :r", r=uuid.UUID(rid_x_inviter))
    assert (inv_user, invitee_user) == (None, j)
    # tick не трогает обезличенные (статус сохраняется), события по удалённому не воскрешают данные
    env.now = T0 + timedelta(days=31)
    await env.tick_all()
    assert await _status(env, rid_x_invitee) == ("learning", None)
    await _lesson(env, x, env.now, lesson_id="L2")
    await _diag(env, x, env.now)
    assert await env.sql("SELECT 1 FROM learner_activity WHERE user_id = :u", u=x) == []
    r = await env.c.get("/internal/v1/me/community", headers=env.lh(x))
    assert r.status_code == 410
    assert (await env.c.get(f"/internal/v1/members/{env.mid(x)}", headers=env.svc())).status_code == 404
    # открытое дело на удалённого: санкцию поставить нельзя, закрыть — можно; карточки ученика больше нет
    url = f"/internal/v1/admin/moderation/cases/{open_case_on_x}/resolve"
    r = await env.c.post(url, json={"action": "warning", "basis": "Предупреждение удалённому"}, headers=env.staff())
    assert r.status_code == 409 and r.json()["code"] == "CASE_STATE"
    r = await env.c.post(url, json={"action": "dismiss", "basis": "Ученик удалил аккаунт"}, headers=env.staff())
    assert r.status_code == 200 and r.json()["target_user_id"] is None
    r = await env.c.get(f"/internal/v1/admin/social/users/{x}", headers=env.staff())
    assert r.status_code == 404 and r.json()["code"] == "SOCIAL_PROFILE_NOT_FOUND"
    # повтор саги — снова ACK
    await _delete(env, x)
    assert len(await env.events("user.domain.deleted.v1")) == 2
    assert env.bus.dlq == []


async def test_deletion_races_with_events_under_lock(env) -> None:
    """Сага и потребитель урока/профиль сообщества — под одной блокировкой ученика: после саги данных нет при любом
    порядке."""
    for i in range(6):
        user = env.identity.add()
        await env.community(user)
        lesson = _lesson(env, user, env.now, lesson_id=f"R{i}")
        delete = _delete(env, user)
        prof = env.c.get("/internal/v1/me/community", headers=env.lh(user))
        results = await asyncio.gather(*((lesson, delete, prof) if i % 2 else (delete, prof, lesson)))
        assert await env.sql("SELECT 1 FROM learner_activity WHERE user_id = :u", u=user) == []
        assert await env.sql("SELECT 1 FROM community_profiles WHERE user_id = :u", u=user) == []
        assert await env.sql("SELECT 1 FROM member_ids WHERE user_id = :u", u=user) == []
        statuses = [r.status_code for r in results if hasattr(r, "status_code")]
        assert statuses and statuses[0] in (200, 410)


async def test_concurrent_qualifications_respect_monthly_cap(env) -> None:
    await _set_campaign(env, monthly_cap="1")
    inviter = env.identity.add()
    invitees = []
    for _ in range(2):
        _, invitee, rid = await _referral(env, inviter)
        invitees.append((invitee, rid))
    env.now = T0 + timedelta(days=3)
    for invitee, _ in invitees:
        await _diag(env, invitee, T0)
        await _lesson(env, invitee, T0 + timedelta(minutes=1), lesson_id="A")
        await _lesson(env, invitee, T0 + timedelta(minutes=2), lesson_id="B")
    # третьи уроки (второй день) обоих — одновременно
    await asyncio.gather(*(_lesson(env, invitee, T0 + timedelta(days=1), lesson_id="C") for invitee, _ in invitees))
    statuses = sorted([await _status(env, rid) for _, rid in invitees], key=str)
    assert statuses == [("capped", "monthly_cap"), ("qualified", None)]
    assert len(await env.events("social.referral.qualified.v1")) == 1

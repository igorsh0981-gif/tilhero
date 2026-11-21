"""Исправления по независимому ревью спринта 7 (social): п. 2 — перенос рефералов спринта 6 (legacy) и симметричный
downgrade; п. 3 — внутренние выгрузки families/friendships; п. 6 — пересмотр только решений оператора, одобрение
через правила; п. 7 — «не новый ученик» по регистрации; п. 12 — реестр member_id под блокировкой; п. 17 — предмет
жалобы связан с жалобщиком и целью; п. 20 — номера версий кампании монотонны."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, timedelta
from pathlib import Path
from typing import Any

from conftest import SERVICE_DIR, make_settings, open_env
from sqlalchemy import text
from test_social_referrals import ADMIN, T0, _diag, _lesson, _referral, _status, _view

from tilhero_common.db import make_engine
from tilhero_common.messaging import make_envelope
from tilhero_common.testing import TEST_ADMIN_URL, assert_event_conforms, create_schema, drop_schema, migrate

EXPORT = "/internal/v1/export"


# ---------------------------------------------------------------- п. 2: перенос рефералов спринта 6


async def _sprint6_data(url: str, schema: str) -> dict[str, uuid.UUID]:
    """Данные спринта 1/6 на схеме 0001: реферал принят 10 дней назад (переносится), 40 дней назад (нет), дружба и
    семья."""
    engine = make_engine(url, schema, pool_size=1)
    ids = {k: uuid.uuid4() for k in ("inviter", "recent", "old", "friend", "family_owner", "family_kid")}
    async with engine.begin() as conn:
        for kind, invitee, days in (("referral", ids["recent"], 10), ("referral", ids["old"], 40),
                                    ("friend", ids["friend"], 5)):
            iid = uuid.uuid4()
            await conn.execute(text(
                "INSERT INTO invites (invite_id, inviter_user_id, kind, token_hash, status, uses, idempotency_key, "
                "created_at, updated_at) VALUES (:i, :u, :k, :h, 'active', 1, :key, now() - interval '60 days', "
                "now())"), {"i": iid, "u": ids["inviter"], "k": kind, "h": uuid.uuid4().hex, "key": str(iid)})
            await conn.execute(text(
                "INSERT INTO invite_redemptions (invite_id, invitee_user_id, opened_at, accepted_at) "
                "VALUES (:i, :v, now() - make_interval(days => :d), now() - make_interval(days => :d))"),
                {"i": iid, "v": invitee, "d": days})
        a, b = sorted([ids["inviter"], ids["friend"]], key=lambda u: u.int)
        await conn.execute(text("INSERT INTO friendships (user_a, user_b, created_at) VALUES (:a, :b, now())"),
                           {"a": a, "b": b})
        fid = uuid.uuid4()
        await conn.execute(text("INSERT INTO families (family_id, owner_user_id) VALUES (:f, :o)"),
                           {"f": fid, "o": ids["family_owner"]})
        await conn.execute(text("INSERT INTO family_members (family_id, user_id, role, joined_at) VALUES "
                                "(:f, :o, 'owner', now()), (:f, :k, 'child', now())"),
                           {"f": fid, "o": ids["family_owner"], "k": ids["family_kid"]})
    await engine.dispose()
    return ids


async def test_sprint6_referrals_migrate_as_legacy_and_close_quietly() -> None:
    schema = f"soc_legacy_{uuid.uuid4().hex[:8]}"
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    try:
        await migrate(SERVICE_DIR, settings, revision="0001")
        ids = await _sprint6_data(TEST_ADMIN_URL, schema)
        await migrate(SERVICE_DIR, settings)
        async with open_env(settings) as env:
            [(rid, accepted, diag, window_from, legacy, status)] = await env.sql(
                "SELECT referral_id, accepted_at, diagnostic_at, window_from, legacy, status FROM referrals")
            rid = str(rid)
            # диагностика засчитана (входила в онбординг), окно — от выкладки, а не от принятия
            assert legacy is True and status == "invited" and diag == accepted
            assert window_from - accepted > timedelta(days=9)
            view = (await _view(env, ids["inviter"]))["items"][0]
            assert view["progress"]["diagnostic"] is True
            assert view["progress"]["window_ends_at"] == (window_from + timedelta(days=30)).astimezone(
                UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            invitee = ids["recent"]
            # урок между принятием и выкладкой не считается (окно — от выкладки)
            env.now = window_from + timedelta(days=3)
            await _lesson(env, invitee, window_from - timedelta(hours=1), lesson_id="L0")
            for i, day in enumerate((0, 0, 1)):
                await _lesson(env, invitee, window_from + timedelta(days=day, hours=i + 1), lesson_id=f"L{i + 1}")
            assert await _status(env, rid) == ("qualified", None)
            [q] = await env.events("social.referral.qualified.v1")
            assert q.payload["referral_id"] == rid and q.payload["campaign_version"] == 1
            # gamification уже наградил по правилу спринта 6 — второй награды нет, ack с outcome legacy
            await env.publish("game.referral.rewarded.v1", {"referral_id": rid,
                                                            "inviter_user_id": str(ids["inviter"]),
                                                            "rewarded_at": "2026-11-20T00:00:00Z",
                                                            "outcome": "legacy"}, "gamification")
            assert await _status(env, rid) == ("rewarded", None)
            item = (await _view(env, ids["inviter"]))["items"][0]
            assert item["reward"] is None and item["reward_outcome"] == "legacy"
            # награда по прежнему правилу не занимает место в лимите месяца
            assert (await _view(env, ids["inviter"]))["month"]["qualified"] == 0
        # downgrade симметричен: данные спринта 1 не тронуты, повторный upgrade снова переносит реферал
        await migrate_down(settings, "0001")
        engine = make_engine(TEST_ADMIN_URL, schema, pool_size=1)
        async with engine.begin() as conn:
            tables = set((await conn.execute(text(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = :s"), {"s": schema}))
                .scalars().all())
            assert "referrals" not in tables and "member_ids" not in tables and "counters" not in tables
            assert (await conn.execute(text("SELECT count(*) FROM invite_redemptions"))).scalar_one() == 3
            assert (await conn.execute(text("SELECT count(*) FROM family_members"))).scalar_one() == 2
        await migrate(SERVICE_DIR, settings)
        async with engine.begin() as conn:
            rows = (await conn.execute(text("SELECT invitee_user_id, legacy, status FROM referrals"))).all()
            assert rows == [(ids["recent"], True, "invited")]
        await engine.dispose()
        async with open_env(settings) as env:
            [(rid, window_from)] = await env.sql("SELECT referral_id::text, window_from FROM referrals")
            # окно истекло (от выкладки) — тихо: без referral_rejected window_expired
            env.now = window_from + timedelta(days=29, hours=23)
            assert (await env.tick_all())["referrals_expired"] == 0
            env.now = window_from + timedelta(days=30)
            assert (await env.tick_all())["referrals_expired"] == 1
            assert await _status(env, rid) == ("expired", "window_expired")
            assert await env.events("social.referral.rejected.v1") == []
            # ученику — без причины «окно истекло»: «Приглашение по прежней программе» (повторное ревью, Н6)
            [inviter_id] = [u for (u,) in await env.sql("SELECT inviter_user_id FROM referrals")]
            item = (await _view(env, inviter_id))["items"][0]
            assert (item["status"], item["reject_code"], item["legacy"]) == ("expired", None, True)
            row = (await env.c.get(f"{ADMIN}/{rid}", headers=env.staff())).json()
            assert row["reject_code"] == "window_expired"  # админка видит факт
            # уже награждённый в спринте 6 и закрытый по окну — ack gamification закрывает его как rewarded
            await env.publish("game.referral.rewarded.v1", {"referral_id": rid, "inviter_user_id": str(uuid.uuid4()),
                                                            "rewarded_at": "2026-11-20T00:00:00Z",
                                                            "outcome": "legacy"}, "gamification")
            assert await _status(env, rid) == ("rewarded", None)
            [(outcome,)] = await env.sql("SELECT reward_outcome FROM referrals")
            assert outcome == "legacy"
    finally:
        await drop_schema(schema)


async def migrate_down(settings: Any, revision: str) -> None:
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    await asyncio.to_thread(command.downgrade, cfg, revision)


async def test_new_referral_ack_only_from_qualified(env) -> None:
    """Обычный (не перенесённый) реферал ack вне qualified не закрывает."""
    inviter, _, rid = await _referral(env)
    await env.publish("game.referral.rewarded.v1", {"referral_id": rid, "inviter_user_id": str(inviter),
                                                    "rewarded_at": "2026-11-16T09:00:00Z"}, "gamification")
    assert await _status(env, rid) == ("invited", None)


# ---------------------------------------------------------------- исход ack gamification (outcome)


async def _qualified(env, inviter=None) -> tuple[uuid.UUID, uuid.UUID, str]:
    env.now = T0
    inviter, invitee, rid = await _referral(env, inviter)
    env.now = T0 + timedelta(days=3)
    await _diag(env, invitee, T0)
    for i, day in enumerate((0, 0, 1)):
        await _lesson(env, invitee, T0 + timedelta(days=day, minutes=i + 1), lesson_id=f"L{i}")
    assert await _status(env, rid) == ("qualified", None)
    return inviter, invitee, rid


async def _ack(env, rid: str, inviter: uuid.UUID, outcome: str | None) -> None:
    payload: dict[str, Any] = {"referral_id": rid, "inviter_user_id": str(inviter),
                               "rewarded_at": "2026-11-18T10:00:00Z"}
    if outcome is not None:
        payload["outcome"] = outcome
    await env.publish("game.referral.rewarded.v1", payload, "gamification")


async def test_reward_outcomes(env) -> None:
    # rewarded (явно и без поля) — награда кампании, место в лимите месяца
    inviter, _, rid = await _qualified(env)
    await _ack(env, rid, inviter, "rewarded")
    view = await _view(env, inviter)
    item = view["items"][0]
    assert (item["status"], item["reward"], item["reward_outcome"], item["reject_code"]) == (
        "rewarded", {"freeze": 2, "til": 0}, "rewarded", None)
    assert view["month"]["qualified"] == 1
    plain_inviter, _, plain = await _qualified(env)
    await _ack(env, plain, plain_inviter, None)
    assert (await _view(env, plain_inviter))["items"][0]["reward_outcome"] == "rewarded"
    # legacy — закрыт как вознаграждённый, но без повторного «вы получили» и вне лимита
    legacy_inviter, _, legacy = await _qualified(env)
    await _ack(env, legacy, legacy_inviter, "legacy")
    item = (await _view(env, legacy_inviter))["items"][0]
    assert (item["status"], item["reward"], item["reward_outcome"]) == ("rewarded", None, "legacy")
    assert (await _view(env, legacy_inviter))["month"]["qualified"] == 0
    # inviter_capped — лимит месяца gamification: capped / monthly_cap, без награды, поправка уведомлением
    capped_inviter, _, capped = await _qualified(env)
    await _ack(env, capped, capped_inviter, "inviter_capped")
    item = (await _view(env, capped_inviter))["items"][0]
    assert (item["status"], item["reject_code"], item["reward"], item["reward_outcome"]) == (
        "capped", "monthly_cap", None, "inviter_capped")
    assert (await _view(env, capped_inviter))["month"]["qualified"] == 0
    [rej] = await env.events("social.referral.rejected.v1")
    assert rej.payload["referral_id"] == capped and rej.payload["reject_code"] == "monthly_cap"
    # повтор ack и другой исход после закрытия — без изменений и без событий
    await _ack(env, capped, capped_inviter, "rewarded")
    await _ack(env, legacy, legacy_inviter, "inviter_capped")
    assert await _status(env, capped) == ("capped", "monthly_cap")
    assert await _status(env, legacy) == ("rewarded", None)
    assert len(await env.events("social.referral.rejected.v1")) == 1
    # админка: исход виден в строке и карточке; статистика кампании — выдано только кампанией
    rows = {r["referral_id"]: r["reward_outcome"]
            for r in (await env.c.get(ADMIN, headers=env.staff())).json()["items"]}
    assert rows == {rid: "rewarded", plain: "rewarded", legacy: "legacy", capped: "inviter_capped"}
    assert (await env.c.get(f"{ADMIN}/{capped}", headers=env.staff())).json()["reward_outcome"] == "inviter_capped"
    [stats] = (await env.c.get(f"{ADMIN}/campaigns/stats", headers=env.staff())).json()["items"]
    assert (stats["qualified"], stats["capped"]) == (3, 1)
    assert stats["rewards"]["inviter"] == {"freeze": 4, "til": 0}


# ---------------------------------------------------------------- п. 3: выгрузки


async def test_exports_families_and_friendships(env) -> None:
    owner, adult = env.identity.add("Мама"), env.identity.add("Папа")
    iid, token = await env.invite(owner, "family")
    await env.open(adult, token)
    await env.accept(adult, iid)
    kid = env.identity.add(age="6-9", kind="child")
    await env.profile_event("user.profile.created.v1", {"user_id": str(kid), "kind": "child", "age_band": "6-9",
                                                        "guardian_user_id": str(owner),
                                                        "created_at": "2026-11-16T08:00:00Z"})
    a, b, c = env.identity.add(), env.identity.add(), env.identity.add()
    await env.befriend(a, b)
    await env.befriend(a, c)
    fiid, ftoken = await env.invite(b, "friend")
    await env.open(c, ftoken)
    await env.accept(c, fiid)
    gone = env.identity.add()
    await env.befriend(gone, a)
    await env.publish("user.deletion.requested.v1", {"user_id": str(gone), "request_id": str(uuid.uuid4()),
                                                     "requested_at": "2026-11-16T08:00:00Z"}, "identity-consent")

    async def all_pages(name: str, caller: str) -> list[dict[str, Any]]:
        items, cursor, pages = [], None, 0
        while True:
            params: dict[str, Any] = {"limit": 2}
            if cursor:
                params["cursor"] = cursor
            r = await env.c.get(f"{EXPORT}/{name}", params=params, headers=env.svc(caller))
            assert r.status_code == 200, r.text
            assert len(r.json()["items"]) <= 2
            items += r.json()["items"]
            cursor, pages = r.json()["next_cursor"], pages + 1
            if cursor is None:
                return items

    fams = await all_pages("families", "gamification")
    assert sorted((m["user_id"], m["role"]) for m in fams) == sorted(
        [(str(owner), "owner"), (str(adult), "adult"), (str(kid), "child")])
    for p in fams:
        assert_event_conforms(make_envelope("social.family.member_added.v1", p, producer="social"))
        assert p["owner_user_id"] == str(owner)
    friends = await all_pages("friendships", "lessons")
    pairs = {tuple(sorted([p["user_a"], p["user_b"]])): p["source"] for p in friends}
    assert pairs == {tuple(sorted([str(a), str(b)])): "request", tuple(sorted([str(a), str(c)])): "request",
                     tuple(sorted([str(b), str(c)])): "invite"}
    for p in friends:
        assert p["status"] == "added" and p["user_a"] < p["user_b"]
        assert_event_conforms(make_envelope("social.friendship.changed.v1", p, producer="social"))
    assert str(gone) not in str(friends)
    # удалённый, попавший в таблицу в обход саги, тоже не выгружается
    await env.sql("INSERT INTO deleted_users (user_id, request_id) VALUES (:u, :r)", u=adult, r=uuid.uuid4())
    assert str(adult) not in str(await all_pages("families", "lessons"))
    # доступ и параметры
    for issuer in ("telegram-bff", "admin-bff", "notifications"):
        r = await env.c.get(f"{EXPORT}/families", headers=env.svc(issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    assert (await env.c.get(f"{EXPORT}/families")).status_code == 401
    assert (await env.c.get(f"{EXPORT}/families", params={"limit": 1001}, headers=env.svc())).status_code == 422
    assert (await env.c.get(f"{EXPORT}/families", params={"limit": 0}, headers=env.svc())).status_code == 422
    assert (await env.c.get(f"{EXPORT}/families", params={"cursor": "bad!"},
                            headers=env.svc())).json()["code"] == "INVALID_CURSOR"
    r = await env.c.get(f"{EXPORT}/sanctions", headers=env.svc())
    assert r.status_code == 404 and r.json()["code"] == "EXPORT_NOT_FOUND"
    full = (await env.c.get(f"{EXPORT}/friendships", headers=env.svc())).json()
    assert len(full["items"]) == 3 and full["next_cursor"] is None


async def test_lifting_nickname_reset_clears_stoplist_and_cooldown(env) -> None:
    """Повторное ревью Н8: отмена или обжалование сброса ника — ник со стоп-листа, ограничение смены снято."""
    for lift in ("revoke", "appeal"):
        reporter, target = env.identity.add(), env.identity.add()
        nick = f"Name_{lift}"
        await env.nick(target, nick)
        await env.community(target)
        r = await env.c.post("/internal/v1/me/complaints", json={
            "member_id": env.mid(target), "subject_kind": "nickname", "subject_id": None,
            "reason": "inappropriate_nickname"}, headers={**env.lh(reporter), "Idempotency-Key": str(uuid.uuid4())})
        r = await env.c.post(f"/internal/v1/admin/moderation/cases/{r.json()['case_id']}/resolve",
                             json={"action": "nickname_reset", "basis": "Ник нарушает правила"}, headers=env.staff())
        sid = r.json()["resolution"]["sanction_id"]
        assert (await env.nick(target, nick)).status_code == 422
        if lift == "revoke":
            r = await env.c.post(f"/internal/v1/admin/moderation/sanctions/{sid}/revoke",
                                 json={"reason": "Сброс был ошибкой"}, headers=env.staff())
        else:
            await env.c.post(f"/internal/v1/me/sanctions/{sid}/appeal", json={"text": "Это моё настоящее имя"},
                             headers={**env.lh(target), "Idempotency-Key": str(uuid.uuid4())})
            [appeal] = (await env.c.get("/internal/v1/admin/moderation/appeals", params={"status": "open"},
                                        headers=env.staff())).json()["items"]
            r = await env.c.post(f"/internal/v1/admin/moderation/appeals/{appeal['appeal_id']}/decide",
                                 json={"decision": "overturned", "note": "Ник допустим, сброс отменён"},
                                 headers=env.staff())
        assert r.status_code == 200, r.text
        assert (await env.community(target))["nickname_change_available_at"] is None
        assert (await env.nick(target, nick)).status_code == 200  # тот же ник — сразу
    assert await env.sql("SELECT * FROM nickname_stoplist") == []


async def test_lists_do_not_lock_registered_members(env) -> None:
    """Повторное ревью Н9: GET /friends и GET /blocks не берут блокировки уже зарегистрированных учеников."""
    from tilhero_social.domain import family as fam
    me, friend, blocked_user = env.identity.add(), env.identity.add(), env.identity.add()
    await env.befriend(me, friend)
    await env.community(blocked_user)
    await env.c.post("/internal/v1/me/blocks", json={"member_id": env.mid(blocked_user)}, headers=env.lh(me))
    async with env.runtime.transaction() as session:
        await fam.lock_users(session, [friend, blocked_user])  # чужая команда держит блокировки
        r = await asyncio.wait_for(env.c.get("/internal/v1/me/friends", headers=env.lh(me)), timeout=5)
        assert r.json()["items"][0]["member_id"] == env.mid(friend)
        r = await asyncio.wait_for(env.c.get("/internal/v1/me/blocks", headers=env.lh(me)), timeout=5)
        assert r.json()["items"][0]["member_id"] == env.mid(blocked_user)


# ---------------------------------------------------------------- п. 6: пересмотр и одобрение через правила


async def test_operator_approval_goes_through_rules(env) -> None:
    from test_social_referrals import _set_campaign
    await _set_campaign(env, **{"review.velocity_per_day": "1"})
    inviter = env.identity.add()
    base = env.now = T0 + timedelta(days=5)
    rids, invitees = [], []
    for _ in range(2):
        env.now = base
        _, invitee, rid = await _referral(env, inviter)
        rids.append(rid)
        invitees.append(invitee)
        env.now = base + timedelta(days=3)  # события — в прошлом относительно часов сервиса
        await _diag(env, invitee, base)
        for i, day in enumerate((0, 0, 1)):
            await _lesson(env, invitee, base + timedelta(days=day, minutes=i), lesson_id=f"L{i}")
    assert await _status(env, rids[1]) == ("review", None)
    r = await env.c.post(f"{ADMIN}/{rids[1]}/reject", json={"reject_code": "review_rejected",
                                                            "note": "Подозрительно быстро"}, headers=env.staff())
    assert r.json()["can_redecide"] is True
    # приглашённый стал членом семьи пригласившего — одобрение не обходит правило семьи (409, без изменений)
    fid, ftoken = await env.invite(inviter, "family")
    await env.open(invitees[1], ftoken)
    await env.accept(invitees[1], fid)
    r = await env.c.post(f"{ADMIN}/{rids[1]}/approve", json={"note": "Пересмотр: реальный ученик"},
                         headers=env.staff())
    assert r.status_code == 409 and r.json()["details"] == {"status": "rejected", "outcome": "family_member"}
    assert await _status(env, rids[1]) == ("rejected", "review_rejected")
    full = (await env.c.get(f"{ADMIN}/{rids[1]}", headers=env.staff())).json()
    assert [h["decision"] for h in full["decision_history"]] == ["rejected"] and full["can_redecide"] is True
    assert len(await env.events("social.referral.qualified.v1")) == 1


# ---------------------------------------------------------------- п. 7: не новый ученик


async def _registered(env, user: uuid.UUID, at: str) -> None:
    await env.profile_event("user.profile.created.v1", {"user_id": str(user), "kind": "account", "age_band": "18+",
                                                        "created_at": at})


async def test_two_old_learners_inviting_each_other_are_not_new(env) -> None:
    a, b = env.identity.add("Старый А"), env.identity.add("Старый Б")
    await _registered(env, a, "2026-03-01T10:00:00Z")
    await _registered(env, b, "2026-04-01T10:00:00Z")
    _, _, rid_b = await _referral(env, a, b)
    # реферал спринта 1 сразу делает друзьями — пара «накрутчиков» удаляет дружбу и приглашает в обратную сторону
    assert (await env.c.delete(f"/internal/v1/me/friends/{env.mid(b)}", headers=env.lh(a))).status_code == 204
    _, _, rid_a = await _referral(env, b, a)
    assert await _status(env, rid_b) == ("rejected", "not_new_user")
    assert await _status(env, rid_a) == ("rejected", "not_new_user")
    codes = sorted((e.payload["inviter_user_id"], e.payload["reject_code"])
                   for e in await env.events("social.referral.rejected.v1"))
    assert codes == sorted([(str(a), "not_new_user"), (str(b), "not_new_user")])
    row = (await env.c.get(f"{ADMIN}/{rid_b}", headers=env.staff())).json()
    assert row["can_redecide"] is False and row["risk_flags"] == []
    assert (await env.c.post(f"{ADMIN}/{rid_b}/approve", json={"note": "Одобрить старого ученика"},
                             headers=env.staff())).status_code == 409
    assert (await _view(env, a))["items"][0]["reject_code"] == "not_new_user"
    # новый: зарегистрирован в момент открытия приглашения (и в пределах 48 ч) — реферал идёт
    fresh = env.identity.add("Новичок")
    await _registered(env, fresh, "2026-11-15T09:00:00Z")
    _, _, rid = await _referral(env, a, fresh)
    assert await _status(env, rid) == ("invited", None)
    # регистрация неизвестна (нет данных) — не отклоняем
    unknown = env.identity.add("Без профиля")
    _, _, rid2 = await _referral(env, b, unknown)
    assert await _status(env, rid2) == ("invited", None)


async def test_registration_event_late_still_rejects(env) -> None:
    """Событие регистрации пришло после принятия — отказ при следующем шаге правил."""
    _, invitee, rid = await _referral(env)
    assert await _status(env, rid) == ("invited", None)
    await _registered(env, invitee, "2026-01-01T00:00:00Z")
    env.now = T0 + timedelta(hours=2)
    await _diag(env, invitee, T0 + timedelta(hours=1))
    assert await _status(env, rid) == ("rejected", "not_new_user")


# ---------------------------------------------------------------- п. 12: реестр под блокировкой


async def test_member_registry_not_resurrected_after_saga(env) -> None:
    for _ in range(4):
        x, friend = env.identity.add(), env.identity.add()
        await env.befriend(x, friend)
        await env.sql("DELETE FROM member_ids WHERE user_id = :u", u=x)  # реестр заполнит список друзей
        delete = env.publish("user.deletion.requested.v1", {"user_id": str(x), "request_id": str(uuid.uuid4()),
                                                            "requested_at": "2026-11-16T08:00:00Z"},
                             "identity-consent")
        listing = env.c.get("/internal/v1/me/friends", headers=env.lh(friend))
        await asyncio.gather(listing, delete)
        assert await env.sql("SELECT 1 FROM member_ids WHERE user_id = :u", u=x) == []


# ---------------------------------------------------------------- п. 17: предмет жалобы


async def test_complaint_subject_must_involve_both(env) -> None:
    reporter, target, other = env.identity.add(), env.identity.add(), env.identity.add()
    for u in (reporter, target, other):
        await env.community(u)
    foreign_req = (await env.request_friend(other, target)).json()["request_id"]
    own_req = (await env.request_friend(target, reporter)).json()["request_id"]

    async def complain(kind: str, subject: str | None) -> Any:
        return await env.c.post("/internal/v1/me/complaints", json={
            "member_id": env.mid(target), "subject_kind": kind, "subject_id": subject, "reason": "spam"},
            headers={**env.lh(reporter), "Idempotency-Key": str(uuid.uuid4())})

    r = await complain("friend_request", foreign_req)
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"
    assert (await complain("friend_request", str(uuid.uuid4()))).status_code == 422
    assert (await complain("friend_request", own_req)).status_code == 201
    # приглашение Telegram: цели, открытое жалобщиком, — да; чужое — нет
    t_iid, t_token = await env.invite(target, "friend")
    await env.open(reporter, t_token)
    assert (await complain("invite", t_iid)).status_code == 201
    o_iid, _ = await env.invite(other, "friend")
    assert (await complain("invite", o_iid)).status_code == 422
    t2_iid, _ = await env.invite(target, "friend")  # жалобщик не открывал
    assert (await complain("invite", t2_iid)).status_code == 422
    # приглашение в парный урок, дуэль, комната — объекты других доменов, id принимается
    assert (await complain("invite", str(uuid.uuid4()))).status_code == 201
    assert (await complain("duel", str(uuid.uuid4()))).status_code == 201


# ---------------------------------------------------------------- п. 20: монотонные версии кампании


async def test_deleted_draft_does_not_free_version(env) -> None:
    payload = (await env.c.get(f"{ADMIN}/campaigns/1", headers=env.staff())).json()["payload"]
    r = await env.c.put(f"{ADMIN}/campaigns/draft", json={"payload": payload}, headers=env.staff())
    assert r.json()["version"] == 2
    assert (await env.c.delete(f"{ADMIN}/campaigns/draft", headers=env.staff())).status_code == 204
    r = await env.c.put(f"{ADMIN}/campaigns/draft", json={"payload": payload}, headers=env.staff())
    assert r.json()["version"] == 3
    assert [v["version"] for v in (await env.c.get(f"{ADMIN}/campaigns", headers=env.staff())).json()["items"]] == [
        3, 1]


"""Проекции social и diagnostics (INTERNAL_API спринта 7 §2.1): проверка издателя, порядок событий (запоздавшее не
откатывает новое), полоса уровня; удаление под блокировкой — новые consumers ждут блокировку саги и данных
удалённого ученика не создают; сага спринта 7: лиги, дуэли, проекции (AT-82)."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from typing import Any

from conftest import Env

from tilhero_gamification.domain import saga


async def test_projections_producers_and_order(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await env.publish("social.profile.updated.v1", {
        "user_id": str(a), "member_id": env.mid(a), "nickname": "Fake", "game_profile_hidden": False,
        "updated_at": env.ts()}, "lessons")  # чужой издатель
    assert await env.sql("SELECT count(*) FROM community") == [(0,)]
    old = env.ts()
    env.now += timedelta(seconds=1)
    await env.community(a, "First")
    await env.community(a, "Second")
    await env.publish("social.profile.updated.v1", {  # запоздавшее событие не откатывает новый ник
        "user_id": str(a), "member_id": env.mid(a), "nickname": "Stale", "game_profile_hidden": True,
        "updated_at": old}, "social")
    assert await env.sql("SELECT nickname, hidden, member_id FROM community WHERE user_id = :u", u=a) == [
        ("Second", False, env.mid(a))]
    await env.befriend(a, b)
    await env.befriend(a, b, "removed")
    assert await env.sql("SELECT status FROM social_friends") == [("removed",)]
    await env.diag(a, "B2")
    await env.diag(a, None, pair="uz-en")
    assert sorted(await env.sql("SELECT pair_id, level_band FROM learner_levels WHERE user_id = :u", u=a)) == [
        ("ru-en", "B1+"), ("uz-en", "A0-A1")]
    await env.publish("diagnostics.completed.v1", {
        "user_id": str(a), "pair_id": "ru-en", "result_id": str(uuid.uuid4()), "revision": 2, "test_id": "x",
        "test_version": 1, "provisional_level": "A1", "areas": {}, "completed_at": env.ts()}, "lessons")
    assert ("ru-en", "B1+") in await env.sql("SELECT pair_id, level_band FROM learner_levels WHERE user_id = :u", u=a)
    sid = await env.sanction(a, days=2)
    await env.sanction(a, active=False, sanction_id=sid)
    assert await env.sql("SELECT active FROM sanctions") == [(False,)]
    fid = await env.family(a, (b, "teen"))
    assert sorted(await env.sql("SELECT user_id, role, family_id FROM family_members"), key=lambda r: r[1]) == [
        (a, "owner", fid), (b, "teen", fid)]


async def counts(env: Env, user: uuid.UUID) -> dict[str, int]:
    out = {}
    for table, col in (("community", "user_id"), ("family_members", "user_id"), ("sanctions", "user_id"),
                       ("learner_levels", "user_id"), ("social_friends", "user_a"), ("social_blocks",
                                                                                     "blocker_user_id")):
        out[table] = (await env.sql(f"SELECT count(*) FROM {table} WHERE {col} = :u", u=user))[0][0]  # noqa: S608
    return out


async def test_new_consumers_check_deletion_under_lock(env: Env) -> None:
    """Сага держит блокировку ученика; параллельные события спринта 7 (профиль, дружба, блокировка, семья, санкция,
    диагностика, возраст и согласие identity-consent, реферал, парный урок) ждут её и после фиксации ничего для
    удалённого не создают."""
    user, other = uuid.uuid4(), uuid.uuid4()
    tasks: list[asyncio.Task[Any]] = []
    try:
        async with env.runtime.transaction() as db:
            await saga.delete_user_data(db, user, uuid.uuid4(), env.now, None)
            tasks = [
                asyncio.create_task(env.community(user, "Ghost")),
                asyncio.create_task(env.befriend(user, other)),
                asyncio.create_task(env.block(user, other)),
                asyncio.create_task(env.family(other, (user, "adult"))),
                asyncio.create_task(env.sanction(user)),
                asyncio.create_task(env.diag(user, "A2")),
                asyncio.create_task(env.identity(user, "14-17", "granted")),
                asyncio.create_task(env.publish("social.referral.qualified.v1", {
                    "referral_id": str(uuid.uuid4()), "inviter_user_id": str(other), "invitee_user_id": str(user),
                    "campaign_version": 1, "inviter_reward": {"freeze": 1, "til": 0},
                    "invitee_reward": {"freeze": 1, "til": 5}, "inviter_monthly_cap": 10,
                    "qualified_at": env.ts()}, "social")),
                asyncio.create_task(env.publish("lesson.pair.completed.v1", {
                    "room_id": str(uuid.uuid4()), "scenario_id": "s", "pair_id": "ru-en", "status": "finished",
                    "end_reason": "completed", "team_goal_reached": True,
                    "participants": [{"user_id": str(user), "role": "A", "contributed": True, "turns": 3,
                                      "speaking_seconds": 40, "minutes": 5}], "ended_at": env.ts()}, "lessons")),
            ]
            await asyncio.sleep(0.6)
            assert not any(t.done() for t in tasks), "должны ждать блокировку саги"
    finally:
        results = await asyncio.gather(*tasks, return_exceptions=True)
    assert not [r for r in results if isinstance(r, BaseException)], results
    assert all(v == 0 for v in (await counts(env, user)).values()), await counts(env, user)
    assert await env.sql("SELECT count(*) FROM social_friends") == [(0,)]
    assert await env.sql("SELECT count(*) FROM social_blocks") == [(0,)]
    assert await env.sql("SELECT count(*) FROM ledger WHERE user_id = :u", u=user) == [(0,)]
    assert await env.sql("SELECT count(*) FROM learners WHERE user_id = :u", u=user) == [(0,)]


async def test_saga_leagues_duels_projections(env: Env) -> None:
    """AT-82: проекции и участие в лигах удаляются, итоги лиг и дуэли обезличиваются, активные дуэли отменяются,
    реферальные награды обезличиваются; второму ученику ничего не ломается."""
    from test_social_duels import accepted, pair, score
    from test_social_leagues import W0_END, learner

    gone = await learner(env, "Gone", opt_in=True)
    stay = await learner(env, "Stay", opt_in=True)
    await env.xp(gone, 2)
    await env.xp(stay, 1)
    await pair(env, gone, stay, "Gone", "Stay")
    await env.family(stay, (gone, "adult"))
    await env.diag(gone, "A2")
    await env.diag(stay, "A2")
    done = await accepted(env, gone, stay)
    await score(env, gone, done, 8)
    await score(env, stay, done, 2)
    env.now = W0_END + timedelta(minutes=5)
    await env.tick()  # закрытие недели: итоги с обоими
    await env.sanction(gone)
    active = await env.challenge(stay, gone)
    await env.publish("social.referral.qualified.v1", {
        "referral_id": str(uuid.uuid4()), "inviter_user_id": str(stay), "invitee_user_id": str(gone),
        "campaign_version": 1, "inviter_reward": {"freeze": 1, "til": 0}, "invitee_reward": {"freeze": 0, "til": 5},
        "inviter_monthly_cap": 10, "qualified_at": env.ts()}, "social")
    await env.publish("user.deletion.requested.v1", {"user_id": str(gone), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.ts()}, "identity-consent")
    [ack] = await env.events("user.domain.deleted.v1")
    assert ack.payload["domain"] == "gamification"
    assert all(v == 0 for v in (await counts(env, gone)).values())
    assert await env.sql("SELECT count(*) FROM social_friends") == [(0,)]
    assert await env.sql("SELECT count(*) FROM league_members WHERE user_id = :u", u=gone) == [(0,)]
    [(standings,)] = await env.sql("SELECT standings FROM league_results")
    assert [s["user_id"] for s in standings] == [None, str(stay)]  # обезличено, место и приз сохранены
    assert await env.sql("SELECT status, challenger, opponent FROM duels WHERE duel_id = :d",
                         d=uuid.UUID(active["duel_id"])) == [("cancelled", uuid.UUID(str(stay)), None)]
    [(ch, opp, result)] = await env.sql("SELECT challenger, opponent, result FROM duels WHERE duel_id = :d",
                                        d=uuid.UUID(done))
    assert (ch, opp, result) == (None, stay, "challenger")
    assert await env.sql("SELECT inviter_user_id, invitee_user_id FROM referral_rewards") == [(stay, None)]
    # второй ученик продолжает видеть свои дуэли и историю лиги
    v = await env.get(stay, f"duels/{done}")
    assert v["opponent"]["nickname"] is None and v["opponent"]["member_id"].startswith("mb_")
    assert v["result"]["outcome"] == "loss"
    assert (await env.get(stay, "leagues/history"))["items"][0]["place"] == 2
    admin = await env.adm("GET", f"duels/{done}", perms=("league.read",))
    assert admin["challenger_user_id"] is None
    # события после удаления данных не воскрешают
    await env.community(gone, "Back")
    await env.befriend(gone, stay)
    assert await env.sql("SELECT count(*) FROM community WHERE user_id = :u", u=gone) == [(0,)]

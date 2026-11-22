"""Исправления по ревью бэкенда спринта 7 (по тесту на пункт): 🔴2 переход рефералов спринт 6 → 7 (оба порядка,
лимит месяца), 🟡4 удалённый в referral_rewards, 🟡8 XP парных уроков (finished, минимум ходов, дневной лимит),
🟡9 доступ 14–17 к общей лиге по проекции identity-consent, 🟢11 MEMBER_ID_KEY, 🟢15 пара дуэли — с сервера,
🟢16 санкция отменяет вызовы, принятие перепроверяет вызвавшего, 🟢18 операции сотрудника не в XP недели.
Повторное ревью: 🟡 Н2 дожитие pending 90 дней, 🟡 Н3 лимит кампании из события и месяц по qualified_at, 🟡 Н4 парный
урок — ≥ 1 ход, 🟢 Н7 отзыв согласия посреди недели; 🔴 Н1 — test_social_bootstrap."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jsonschema
import pytest
from conftest import Env
from test_social_duels import accepted, pair, score
from test_social_leagues import W0, W0_END, W1, learner, rows
from test_social_rewards import pair_completed, qualified

from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms


async def legacy(env: Env, inviter: uuid.UUID, invitee: uuid.UUID, status: str = "pending", *,
                 days_ago: int = 1, rewarded_now: bool = False) -> None:
    """Строка referrals спринта 6 (до выкладки спринта 7)."""
    await env.sql("INSERT INTO referrals (invitee_user_id, inviter_user_id, invite_id, status, accepted_at, "
                  "rewarded_at, updated_at) VALUES (:i, :r, :v, :s, :a, :w, :a)",
                  i=invitee, r=inviter, v=uuid.uuid4(), s=status, a=env.now - timedelta(days=days_ago),
                  w=env.now if rewarded_now or status == "rewarded" else None)


def bonus(ops: list[Any]) -> list[tuple[str, int]]:
    return [(op.currency, op.amount) for op in ops if op.reason == "referral_bonus"]


async def status_of(env: Env, invitee: uuid.UUID) -> str:
    return str((await env.sql("SELECT status FROM referrals WHERE invitee_user_id = :i", i=invitee))[0][0])


async def outcome_of(env: Env, rid: uuid.UUID) -> tuple[Any, ...]:
    [row] = await env.sql("SELECT outcome, inviter_user_id, invitee_user_id FROM referral_rewards "
                          "WHERE referral_id = :r", r=rid)
    return tuple(row)


# ---------------------------------------------------------------- 🔴2 рефералы: переход спринт 6 → 7


async def test_legacy_pending_then_qualified(env: Env) -> None:
    """pending спринта 6 доживает: первый урок в 90 дней (🟡 Н2, как спринт 6) → +2 заморозки; затем квалификация
    кампании → legacy, второй награды пригласившему нет, приглашённому — приветственная (её спринт 6 не давал), ack
    уходит."""
    inviter, invitee = uuid.uuid4(), uuid.uuid4()
    await legacy(env, inviter, invitee, days_ago=89)
    await env.lesson(invitee)
    assert await status_of(env, invitee) == "rewarded"
    assert bonus(await env.ops(inviter)) == [("freeze", 2)]
    await env.lesson(invitee)  # второй урок — без второй награды
    rid = await qualified(env, inviter, invitee, inviter_reward={"freeze": 2, "til": 10})
    assert await outcome_of(env, rid) == ("legacy", inviter, invitee)
    assert bonus(await env.ops(inviter)) == [("freeze", 2)]
    assert [op.reason for op in await env.ops(invitee) if op.reason.startswith("referral")] == ["referral_welcome"]
    [ack] = await env.events("game.referral.rewarded.v1")
    assert ack.payload["referral_id"] == str(rid)
    assert (await env.adm("GET", f"wallets/{inviter}"))["referrals"]["rewarded"] == 1  # legacy не считается дважды


async def test_qualified_first_then_legacy_lesson(env: Env) -> None:
    """Обратный порядок: квалификация раньше урока — награда по кампании, строка спринта 6 → void, урок не даёт
    второй награды."""
    inviter, invitee = uuid.uuid4(), uuid.uuid4()
    await legacy(env, inviter, invitee)
    rid = await qualified(env, inviter, invitee)
    assert await outcome_of(env, rid) == ("rewarded", inviter, invitee)
    assert await status_of(env, invitee) == "void"
    await env.lesson(invitee)
    assert bonus(await env.ops(inviter)) == [("freeze", 2)]  # только по кампании
    assert [op.idempotency_key for op in await env.ops(inviter) if op.reason == "referral_bonus"] == [
        f"referral:{rid}:inviter:freeze"]


async def test_legacy_capped_and_expired(env: Env) -> None:
    inviter, capped, late, stale = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await legacy(env, inviter, capped, "capped")
    rid = await qualified(env, inviter, capped)
    assert (await outcome_of(env, rid))[0] == "legacy" and bonus(await env.ops(inviter)) == []
    # первый урок позже 90 дней с принятия — тихо expired, без награды и без уведомления
    await legacy(env, inviter, late, days_ago=91)
    await env.lesson(late)
    assert await status_of(env, late) == "expired" and bonus(await env.ops(inviter)) == []
    # без урока — tick переводит в expired
    await legacy(env, inviter, stale, days_ago=89)
    assert (await env.tick())["legacy_referrals_expired"] == 0
    env.now += timedelta(days=2)
    assert (await env.tick())["legacy_referrals_expired"] == 1
    assert await status_of(env, stale) == "expired"
    # новые pending по правилу спринта 6 не создаются
    newbie = uuid.uuid4()
    await env.invite(inviter, newbie)
    assert await env.sql("SELECT count(*) FROM referrals WHERE invitee_user_id = :i", i=newbie) == [(0,)]


async def test_monthly_cap_counts_both_rules(env: Env) -> None:
    """🟡 Н3: квалификация — лимит кампании inviter_monthly_cap из события; «доживающие» pending —
    bonuses.referral_monthly_cap правил. Оба считают награды обоих правил за месяц."""
    def cap(p: dict[str, Any]) -> None:
        p["bonuses"]["referral_monthly_cap"] = 2

    await env.activate(cap)
    inviter = uuid.uuid4()
    for _ in range(2):  # 2 награды спринта 6 в этом месяце
        await legacy(env, inviter, uuid.uuid4(), "rewarded")
    rid = await qualified(env, inviter, uuid.uuid4(), invitee_reward={"freeze": 0, "til": 15}, monthly_cap=2)
    assert (await outcome_of(env, rid))[0] == "inviter_capped"
    assert bonus(await env.ops(inviter)) == []
    assert len(await env.events("game.referral.rewarded.v1")) == 1  # social закрывает реферал
    # путь спринта 6: 1 награда спринта 6 + 1 по кампании = лимит → capped
    other, pend = uuid.uuid4(), uuid.uuid4()
    await legacy(env, other, uuid.uuid4(), "rewarded")
    await qualified(env, other, uuid.uuid4(), monthly_cap=2)
    await legacy(env, other, pend)
    await env.lesson(pend)
    assert await status_of(env, pend) == "capped"
    assert bonus(await env.ops(other)) == [("freeze", 2)]
    # новый месяц — снова можно
    env.now += timedelta(days=12)
    rid2 = await qualified(env, inviter, uuid.uuid4(), monthly_cap=2)
    assert (await outcome_of(env, rid2))[0] == "rewarded"


async def test_campaign_cap_from_event_month_by_qualified_at(env: Env) -> None:
    """Лимит кампании выше лимита правил — действует лимит кампании (оператор поднял); правила на квалификацию не
    влияют. Месяц — по qualified_at (как social): квалифицирован 30.11 23:59 Ташкента, обработан 1.12 — в счёт
    ноября."""
    def cap(p: dict[str, Any]) -> None:
        p["bonuses"]["referral_monthly_cap"] = 1

    await env.activate(cap)
    inviter = uuid.uuid4()
    for _ in range(3):
        rid = await qualified(env, inviter, uuid.uuid4(), monthly_cap=3)
        assert (await outcome_of(env, rid))[0] == "rewarded"
    rid = await qualified(env, inviter, uuid.uuid4(), monthly_cap=3)
    assert (await outcome_of(env, rid))[0] == "inviter_capped"
    assert len(bonus(await env.ops(inviter))) == 3
    # граница месяца: 30.11 18:59Z = 23:59 Ташкента; обработка — уже 1 декабря
    other = uuid.uuid4()
    nov_last = "2026-11-30T18:59:00Z"
    env.now = datetime(2026, 11, 30, 19, 30, tzinfo=UTC)  # 1.12 00:30 Ташкента
    late = await qualified(env, other, uuid.uuid4(), monthly_cap=1, qualified_at=nov_last)
    dec = await qualified(env, other, uuid.uuid4(), monthly_cap=1)  # декабрь: ноябрьская награда не мешает
    nov2 = await qualified(env, other, uuid.uuid4(), monthly_cap=1, qualified_at=nov_last)  # ноябрь исчерпан
    assert [(await outcome_of(env, r))[0] for r in (late, dec, nov2)] == ["rewarded", "rewarded", "inviter_capped"]


async def ack_outcome(env: Env, rid: uuid.UUID) -> list[tuple[Any, Any]]:
    return [(e.payload["outcome"], e.payload["inviter_reward"]) for e in await env.events("game.referral.rewarded.v1")
            if e.payload["referral_id"] == str(rid)]


async def test_referral_ack_outcome_all_three(env: Env) -> None:
    """game.referral.rewarded.v1 несёт исход и фактически выданное пригласившему: rewarded — суммы операций,
    legacy / inviter_capped — null (повтор события — то же из referral_rewards и реестра); событие без outcome и
    inviter_reward по-прежнему проходит схему, чужие значения — нет."""
    inviter, other = uuid.uuid4(), uuid.uuid4()
    rewarded = await qualified(env, inviter, uuid.uuid4(), inviter_reward={"freeze": 2, "til": 10}, monthly_cap=1)
    await qualified(env, inviter, uuid.uuid4(), rewarded, inviter_reward={"freeze": 3, "til": 99})  # повтор
    assert await ack_outcome(env, rewarded) == [("rewarded", {"freeze": 2, "til": 10})] * 2
    capped = await qualified(env, inviter, uuid.uuid4(), monthly_cap=1)  # лимит кампании (1) исчерпан
    assert await ack_outcome(env, capped) == [("inviter_capped", None)]
    assert bonus(await env.ops(inviter)) == [("freeze", 2), ("til", 10)]
    old = uuid.uuid4()
    await legacy(env, other, old, "rewarded")  # приглашённый уже награждён по правилу спринта 6
    legacy_rid = await qualified(env, other, old)
    assert await ack_outcome(env, legacy_rid) == [("legacy", None)]
    assert bonus(await env.ops(other)) == []
    # rewarded с нулевой наградой пригласившему — нули; пригласивший удалён — null (ничего не выдано)
    zero = await qualified(env, uuid.uuid4(), uuid.uuid4(), inviter_reward={"freeze": 0, "til": 0})
    assert await ack_outcome(env, zero) == [("rewarded", {"freeze": 0, "til": 0})]
    gone = uuid.uuid4()
    await env.publish("user.deletion.requested.v1", {"user_id": str(gone), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.ts()}, "identity-consent")
    deleted = await qualified(env, gone, uuid.uuid4())
    assert await ack_outcome(env, deleted) == [("rewarded", None)]
    # совместимость схемы: оба поля необязательны (нет outcome — rewarded), значения вне контракта не проходят
    base = {"referral_id": str(uuid.uuid4()), "inviter_user_id": str(inviter), "rewarded_at": env.ts()}
    assert_event_conforms(make_envelope("game.referral.rewarded.v1", base, producer="gamification"))
    for bad in ({"outcome": "void"}, {"inviter_reward": {"freeze": 2}}, {"inviter_reward": {"freeze": -1, "til": 0}}):
        with pytest.raises(jsonschema.ValidationError):
            assert_event_conforms(make_envelope("game.referral.rewarded.v1", {**base, **bad},
                                                producer="gamification"))


# ---------------------------------------------------------------- 🟡4 удалённый не сохраняется


async def test_referral_rewards_without_deleted_ids(env: Env) -> None:
    inviter, invitee = uuid.uuid4(), uuid.uuid4()
    await env.publish("user.deletion.requested.v1", {"user_id": str(inviter), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.ts()}, "identity-consent")
    rid = await qualified(env, inviter, invitee)
    assert await outcome_of(env, rid) == ("rewarded", None, invitee)
    assert await env.sql("SELECT count(*) FROM learners WHERE user_id = :u", u=inviter) == [(0,)]
    # после саги приглашённого — тоже null
    await env.publish("user.deletion.requested.v1", {"user_id": str(invitee), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.ts()}, "identity-consent")
    assert await outcome_of(env, rid) == ("rewarded", None, None)


# ---------------------------------------------------------------- 🟡8 парные уроки


async def test_pair_xp_requires_finished_min_turns_daily_cap(env: Env) -> None:
    """🟡 Н4: XP — finished и ≥ 1 собственный ход (min_turns 1); «Вместе» — finished, цель и ≥ 1 ход у обоих;
    суточный лимит 3 награждаемых урока; брошенная комната — ничего."""
    a, b = uuid.uuid4(), uuid.uuid4()

    def xp(ops: list[Any]) -> int:
        return sum(op.amount for op in ops if op.reason == "pair_lesson")

    # не finished (ушёл участник) — без XP и значка
    await env.publish("lesson.pair.completed.v1", {
        "room_id": str(uuid.uuid4()), "scenario_id": "s", "pair_id": "ru-en", "status": "abandoned",
        "end_reason": "participant_left", "team_goal_reached": True,
        "participants": [{"user_id": str(u), "role": r, "contributed": True, "turns": 5, "speaking_seconds": 60,
                          "minutes": 6} for u, r in ((a, "A"), (b, "B"))], "ended_at": env.ts()}, "lessons")
    assert xp(await env.ops(a)) == 0
    assert await env.sql("SELECT count(*) FROM badges WHERE badge_code = 'together_1'") == [(0,)]
    # ни одного своего хода — вклад не засчитан: без XP; у партнёра XP есть, «Вместе» — ни у кого
    await pair_completed(env, uuid.uuid4(), [(a, True, 0), (b, True, 3)])
    assert xp(await env.ops(a)) == 0 and xp(await env.ops(b)) == 25
    assert await env.sql("SELECT count(*) FROM badges WHERE badge_code = 'together_1'") == [(0,)]
    # короткий сценарий с выбором реплик (sc-cafe-coffee: 3 хода, A — 2, B — 1): XP обоим и «Вместе»
    await pair_completed(env, uuid.uuid4(), [(a, True, 2), (b, True, 1)])
    assert xp(await env.ops(a)) == 25 and xp(await env.ops(b)) == 2 * 25
    assert await env.sql("SELECT count(*) FROM badges WHERE badge_code = 'together_1'") == [(2,)]
    # дневной лимит: не больше 3 награждаемых парных уроков в день
    for _ in range(3):
        await pair_completed(env, uuid.uuid4(), [(a, True, 1), (b, True, 1)])
    assert xp(await env.ops(a)) == 3 * 25 and xp(await env.ops(b)) == 3 * 25  # у b: 2 + 1 до лимита
    # без XP у a: брошенная комната, урок без своих ходов, сверх лимита
    assert await env.sql("SELECT count(*) FROM pair_awards WHERE user_id = :u AND xp = 0", u=a) == [(3,)]
    env.now += timedelta(days=1)
    await pair_completed(env, uuid.uuid4(), [(a, True, 4), (b, True, 4)])
    assert xp(await env.ops(a)) == 4 * 25


# ---------------------------------------------------------------- 🟡9 доступ 14–17 к общей лиге


async def test_teen_league_requires_guardian_consent(env: Env) -> None:
    teen = await learner(env, "Teen", age_band="14-17")
    out = await env.send("PATCH", teen, "settings", {"league_opt_in": True}, 403, age_band="14-17")
    assert out["code"] == "FRIENDS_NOT_ALLOWED" and out["details"] == {"reason": "guardian_consent"}
    g = (await env.get(teen, "leagues", age_band="14-17"))["general"]
    assert (g["available"], g["unavailable_reason"]) == (False, "guardian_consent")
    await env.identity(teen, "14-17", "granted")
    await env.send("PATCH", teen, "settings", {"league_opt_in": True}, age_band="14-17")
    assert (await env.get(teen, "leagues", age_band="14-17"))["general"]["group"]["participants"] == 1
    adult = await learner(env, "Adult", opt_in=True)
    await env.lesson(teen)
    await env.lesson(adult)
    assert {r[0] for r in rows((await env.get(adult, "leagues"))["general"]["group"])} == {"Adult", "Teen"}
    # отзыв согласия посреди недели (🟢 Н7): сразу пропадает из группы для других, сам группу не видит, приза нет
    await env.identity(teen, "14-17", "declined")
    g = (await env.get(teen, "leagues", age_band="14-17"))["general"]
    assert (g["group"], g["unavailable_reason"]) == (None, "guardian_consent")
    assert [r[0] for r in rows((await env.get(adult, "leagues"))["general"]["group"])] == ["Adult"]
    env.now = W0_END + timedelta(minutes=5)
    await env.tick()
    [(standings,)] = await env.sql("SELECT standings FROM league_results WHERE week = :w", w=W0)
    assert [s["user_id"] for s in standings] == [str(adult)]
    assert [op for op in await env.ops(teen) if op.reason == "league_prize"] == []
    week1 = {u for (u,) in await env.sql("SELECT user_id FROM league_members WHERE week = :w", w=W1)}
    assert week1 == {adult}
    # возраст неизвестен — как ребёнок: в общую лигу не попадает
    unknown = uuid.uuid4()
    await env.community(unknown, "Unknown")
    await env.send("PATCH", unknown, "settings", {"quests_hidden": True}, age_band=None)
    out = await env.send("PATCH", unknown, "settings", {"league_opt_in": True}, 403, age_band=None)
    assert out["code"] == "KIDS_NOT_ALLOWED"
    await env.sql("UPDATE learners SET league_opt_in = true WHERE user_id = :u", u=unknown)
    await env.tick()
    assert await env.sql("SELECT count(*) FROM league_members WHERE user_id = :u", u=unknown) == [(0,)]


# ---------------------------------------------------------------- 🟢11, 🟢15, 🟢16, 🟢18 — дуэли


async def test_duel_pair_from_server_and_sanctions(env: Env) -> None:
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await pair(env, a, b)
    await pair(env, a, c, "Alpha", "Charlie")
    await env.diag(b, "B2", pair="ru-en")
    await env.diag(a, "A2", pair="uz-en")  # активная пара a — последней диагностики (uz-en), а не ru-en из запроса
    out = await env.challenge(a, b, 422, pair_id="ru-en")
    assert out["code"] == "VALIDATION_ERROR" and out["details"] == {"pair_id": "uz-en"}
    d = await env.challenge(a, b)
    assert d["pair_id"] == "uz-en" and d["level_band"] == "A0-A1"
    # санкция вызвавшего после вызова: неотвеченные вызовы отменяются (в обе стороны)
    d2 = await env.challenge(c, a)
    sid = await env.sanction(a, days=3)
    assert (await env.get(b, f"duels/{d['duel_id']}"))["status"] == "cancelled"
    assert (await env.get(c, f"duels/{d2['duel_id']}"))["status"] == "cancelled"
    await env.sanction(a, active=False, sanction_id=sid)
    # принятие перепроверяет санкцию вызвавшего (событие ещё не отменило вызов — гонка)
    d3 = await env.challenge(a, c)
    await env.sql("INSERT INTO sanctions (sanction_id, user_id, kind, until, active, changed_at) "
                  "VALUES (:s, :u, 'social_ban', NULL, true, :t)", s=uuid.uuid4(), u=a, t=env.now)
    out = await env.send("POST", c, f"duels/{d3['duel_id']}/accept", None, 409)
    assert out["details"] == {"status": "cancelled"} and env.lessons.calls == []


async def test_staff_duel_ops_not_in_week_xp(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await pair(env, a, b)
    d = await accepted(env, a, b)
    await score(env, a, d, 9)
    await score(env, b, d, 4)
    await env.adm("POST", f"duels/{d}/reevaluate", {"result": "opponent", "reason": "списывание подтверждено"})
    rows = await env.sql("SELECT amount, source_kind, league_week FROM ledger WHERE user_id = :u AND reason = 'duel' "
                         "ORDER BY created_at", u=b)
    assert [(amt, kind, week is not None) for amt, kind, week in rows] == [(10, "event", True),
                                                                          (30, "staff", False)]
    await env.grant(b, "xp", 100)
    [(manual_week,)] = await env.sql("SELECT league_week FROM ledger WHERE user_id = :u AND reason = 'manual'", u=b)
    assert manual_week is None

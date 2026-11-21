"""Спринт 7 (INTERNAL_API §5, §7): уведомления социального контура — заявка и дружба, дуэли и итоги лиги, парные
уроки, рефералы, санкции, обжалования и жалобы. Издатель проверяется (social / gamification / lessons); ключи
дедупликации §5 (переоценка дуэли и лиги — новое сообщение только при новом итоге); категории social, game, service
(service не выключается); ник из события (неподходящий → «Друг»), без чужих ответов и счёта соперника; дети 6–13 —
только центр детского профиля, тексты *.kid родителю без сравнений; санкции и обжалования не редактируются в
админке."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from notif_testkit import at, local_day
from test_notifications_staff_templates import MANAGE

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_notifications.domain.texts import PRESSURE_WORDS


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


DAY = local_day(1)
NOON = at(DAY, "12:00")


async def friend_request(env, to: uuid.UUID, frm: uuid.UUID, nickname: str | None = "Alisher_7", *,
                         request_id: uuid.UUID | None = None, producer: str = "social") -> Envelope:
    return await env.publish("social.friend_request.created.v1", {
        "request_id": str(request_id or uuid.uuid4()), "from_user_id": str(frm), "to_user_id": str(to),
        "from_nickname": nickname, "created_at": iso(NOON)}, producer=producer)


async def friendship(env, a: uuid.UUID, b: uuid.UUID, *, requester: uuid.UUID | None, status: str = "added",
                     source: str = "request", nickname: str | None = "Madina_uz") -> Envelope:
    ua, ub = sorted((a, b), key=str)
    return await env.publish("social.friendship.changed.v1", {
        "user_a": str(ua), "user_b": str(ub), "status": status, "source": source,
        "requester_user_id": str(requester) if requester else None, "accepter_nickname": nickname,
        "at": iso(NOON)}, producer="social")


async def challenged(env, challenger: uuid.UUID, opponent: uuid.UUID, duel_id: uuid.UUID, *,
                     nickname: str | None = "Ali_07", deadline: datetime | None = None,
                     producer: str = "gamification") -> Envelope:
    return await env.publish("game.duel.challenged.v1", {
        "duel_id": str(duel_id), "challenger_user_id": str(challenger), "opponent_user_id": str(opponent),
        "challenger_nickname": nickname, "pair_id": "ru-en", "level_band": "A2",
        "accept_deadline": iso(deadline or at(DAY + timedelta(days=1), "12:00")), "created_at": iso(NOON)},
        producer=producer)


async def finished(env, challenger: uuid.UUID, opponent: uuid.UUID, duel_id: uuid.UUID, *, result: str,
                   version: int = 1, technical: bool = False, status: str = "finished",
                   scores: dict[str, Any] | None = None) -> Envelope:
    return await env.publish("game.duel.finished.v1", {
        "duel_id": str(duel_id), "challenger_user_id": str(challenger), "opponent_user_id": str(opponent),
        "status": status, "result": result, "technical": technical, "result_version": version,
        "scores": scores if scores is not None else {"challenger": {"correct": 8, "total": 10},
                                                     "opponent": {"correct": 6, "total": 10}},
        "finished_at": iso(NOON)}, producer="gamification")


async def league(env, group: uuid.UUID, standings: list[tuple[uuid.UUID, int, int, int]], *, version: int = 1,
                 held: bool = False) -> Envelope:
    return await env.publish("game.league.closed.v1", {
        "week": (DAY - timedelta(days=7)).isoformat(), "group_id": str(group), "version": version, "pair_id": "ru-en",
        "level_band": "A2", "prizes_held": held,
        "standings": [{"user_id": str(u), "place": p, "xp": xp, "prize_til": prize} for u, p, xp, prize in standings],
        "closed_at": iso(NOON)}, producer="gamification")


async def pair_invited(env, inviter: uuid.UUID, invitee: uuid.UUID, room: uuid.UUID, *, start: datetime = NOON,
                       nickname: str | None = "Ali_07", producer: str = "lessons") -> Envelope:
    return await env.publish("lesson.pair.invited.v1", {
        "room_id": str(room), "inviter_user_id": str(inviter), "invitee_user_id": str(invitee),
        "inviter_nickname": nickname, "pair_id": "ru-en", "scenario_id": "sc-hobbies-weekend", "mode": "free",
        "start_at": iso(start), "invited_at": iso(NOON)}, producer=producer)


async def pair_completed(env, room: uuid.UUID, users: list[uuid.UUID], end_reason: str) -> Envelope:
    status = {"stopped": "stopped", "participant_left": "abandoned"}.get(end_reason, "finished")
    return await env.publish("lesson.pair.completed.v1", {
        "room_id": str(room), "scenario_id": "sc-hobbies-weekend", "pair_id": "ru-en", "status": status,
        "end_reason": end_reason, "team_goal_reached": False,
        "participants": [{"user_id": str(u), "role": r, "contributed": True, "turns": 3, "speaking_seconds": 30,
                          "minutes": 5} for u, r in zip(users, ("A", "B"), strict=False)],
        "ended_at": iso(NOON)}, producer="lessons")


def texts(env, user: uuid.UUID) -> list[str]:
    return [c["text"] for c in env.gateway.to(env.telegram_id(user))]


# ---------------------------------------------------------------- друзья


async def test_friend_request_and_accepted(env) -> None:
    alice, bob = env.add_user(), env.add_user(locale="uz")
    request_id = uuid.uuid4()
    ev = await friend_request(env, bob, alice, request_id=request_id)
    spec = next(s for s in env.bus.specs if s.durable == "notifications.community")
    await spec.handler(ev)  # повторная доставка — inbox
    await friend_request(env, bob, alice, "Alisher_7", request_id=request_id)  # повторная публикация — ключ
    await friend_request(env, alice, alice)  # самозаявка — без сообщения
    row = await env.one(bob)
    assert (row.template, row.category, row.dedup_key, row.subject_user_id) == (
        "friend_request", "social", f"friend_request:{request_id}", alice)
    await friendship(env, alice, bob, requester=alice)
    await friendship(env, alice, bob, requester=None, source="invite")  # Telegram-приглашение — без сообщения
    await friendship(env, alice, bob, requester=alice, status="removed", source="removed")
    [accepted] = await env.rows(alice)
    assert accepted.template == "friend_accepted" and accepted.subject_user_id == bob
    await env.dispatch(at(DAY, "12:01"))
    assert texts(env, bob) == ["<b>Doʻstlikka yangi soʻrov</b>\nAlisher_7 sizni TilHeroʼda doʻstlarga qoʻshmoqchi."]
    assert texts(env, alice) == ["<b>Заявка принята</b>\nMadina_uz теперь ваш друг в TilHero."]
    assert env.gateway.to(env.telegram_id(alice))[0]["buttons"] == [
        [{"text": "Открыть друзей", "startapp": "route_friends"}]]
    [item] = (await env.inbox(alice))["items"]
    assert (item["category"], item["startapp"]) == ("social", "route_friends")


async def test_bad_nickname_becomes_friend_and_social_off(env) -> None:
    user = env.add_user()
    await friend_request(env, user, env.add_user(), "<b>x</b>")
    await env.dispatch(at(DAY, "12:01"))
    assert texts(env, user) == ["<b>Новая заявка в друзья</b>\nДруг хочет добавить вас в друзья в TilHero."]
    off = env.add_user(categories=("reminders", "support", "game"))  # social выключена — записи нет и в центре
    await friend_request(env, off, user)
    await env.dispatch(at(DAY, "12:02"))
    assert ((await env.one(off)).telegram_status, (await env.one(off)).reason) == ("skipped", "category_disabled")


# ---------------------------------------------------------------- дуэли и лиги


async def test_duel_challenged_and_finished_versions(env) -> None:
    a, b, duel = env.add_user(), env.add_user(locale="uz", tz="Europe/Moscow"), uuid.uuid4()
    await challenged(env, a, b, duel, deadline=at(DAY + timedelta(days=1), "12:00"))
    row = await env.one(b)
    assert (row.template, row.category, row.dedup_key, row.stale_after) == (
        "duel_challenged", "game", f"duel_challenged:{duel}", at(DAY + timedelta(days=1), "12:00"))
    await env.dispatch(at(DAY, "12:01"))
    deadline = at(DAY + timedelta(days=1), "12:00").astimezone(ZoneInfo("Europe/Moscow"))
    assert texts(env, b) == [f"<b>Duelga chaqiruv</b>\nAli_07 sizni duelga chaqirmoqda: 10 ta topshiriq. Chaqiruvni "
                             f"{deadline:%d.%m %H:%M} gacha qabul qilish mumkin."]
    assert env.gateway.to(env.telegram_id(b))[0]["buttons"][0][0]["startapp"] == f"duel_{duel}"
    # итог: каждому — свой исход и свой счёт (счёт соперника в текст не идёт)
    await finished(env, a, b, duel, result="challenger")
    await finished(env, a, b, duel, result="challenger")  # повтор той же версии — без дубля
    await env.dispatch(at(DAY, "12:02"))
    assert texts(env, a) == ["<b>Дуэль завершена</b>\nПобеда! Ваш результат: 8 из 10."]
    assert texts(env, b)[1] == "<b>Duel yakunlandi</b>\nBu safar raqib gʻolib boʻldi. Natijangiz: 10 tadan 6 ta."
    assert "8" not in texts(env, b)[1]
    # переоценка (result_version 2) — новое сообщение обоим
    await finished(env, a, b, duel, result="draw", version=2)
    await env.dispatch(at(DAY, "12:03"))
    assert texts(env, a)[-1] == "<b>Итог дуэли пересмотрен</b>\nНичья! Ваш результат: 8 из 10."
    keys = sorted(r.dedup_key for r in await env.rows(a))
    assert keys == [f"duel_finished:{duel}:{a}:1", f"duel_finished:{duel}:{a}:2"]


async def test_duel_technical_and_cancelled(env) -> None:
    a, b, duel = env.add_user(), env.add_user(), uuid.uuid4()
    await finished(env, a, b, duel, result="opponent", technical=True,
                   scores={"challenger": None, "opponent": {"correct": 5, "total": 10}})
    await finished(env, a, b, uuid.uuid4(), result="none", status="cancelled", scores={"challenger": None,
                                                                                         "opponent": None})
    await env.dispatch(at(DAY, "12:01"))
    assert texts(env, a) == ["<b>Дуэль завершена</b>\nВремя дуэли вышло: вы не успели сыграть."]
    assert texts(env, b) == ["<b>Дуэль завершена</b>\nСоперник не успел сыграть — победа ваша. Ваш результат: 5 из "
                             "10."]


async def test_league_closed_each_version_only_on_change(env) -> None:
    first, second, third, group = env.add_user(), env.add_user(), env.add_user(locale="uz"), uuid.uuid4()
    await league(env, group, [(first, 1, 900, 50), (second, 2, 700, 30), (third, 3, 500, 20)])
    await env.dispatch(at(DAY, "12:01"))
    assert texts(env, first) == ["<b>Итоги недели в лиге</b>\nВы заняли 1 место в группе, 900 XP за неделю. Приз: 50 "
                                 "тилов."]
    assert texts(env, third) == ["<b>Ligada hafta yakunlari</b>\nSiz guruhda 3-oʻrinni egalladingiz, hafta davomida "
                                 "500 XP. Sovrin: 20 til."]
    # переоценка: первый исключён, второй и третий поднялись; место и приз без изменений — повтор не уходит
    await league(env, group, [(second, 1, 700, 50), (third, 3, 500, 20)], version=2)
    await env.dispatch(at(DAY, "12:02"))
    assert len(texts(env, second)) == 2 and len(texts(env, third)) == 1 and len(texts(env, first)) == 1
    assert texts(env, second)[-1].endswith("Приз: 50 тилов.")
    held = env.add_user()
    await league(env, uuid.uuid4(), [(held, 1, 2000, 0)], held=True)  # призы удержаны — без приза
    await env.dispatch(at(DAY, "12:03"))
    assert texts(env, held) == ["<b>Итоги недели в лиге</b>\nВы заняли 1 место в группе, 2000 XP за неделю."]


async def test_game_category_off_keeps_center(env) -> None:
    user = env.add_user(categories=("reminders", "social", "support"))
    await challenged(env, env.add_user(), user, uuid.uuid4())
    await env.dispatch(at(DAY, "12:01"))
    row = await env.one(user)
    assert (row.telegram_status, row.reason) == ("in_app_only", "category_disabled_center")
    assert [i["category"] for i in (await env.inbox(user))["items"]] == ["game"] and env.gateway.calls == []


# ---------------------------------------------------------------- парные уроки


async def test_pair_invited_starting_stopped(env) -> None:
    inviter, invitee, room = env.add_user(), env.add_user(), uuid.uuid4()
    start = at(DAY, "18:00")
    await pair_invited(env, inviter, invitee, room, start=start)
    await pair_invited(env, invitee, invitee, uuid.uuid4())  # самоприглашение — без сообщения
    row = await env.one(invitee)
    assert (row.template, row.category, row.stale_after, row.params["scheduled"]) == (
        "pair_invited", "social", start + timedelta(minutes=15), True)
    await env.publish("lesson.pair.starting.v1", {"room_id": str(room), "user_ids": [str(inviter), str(invitee)],
                                                  "scenario_id": "sc-hobbies-weekend", "start_at": iso(start)},
                      producer="lessons")
    await pair_completed(env, room, [inviter, invitee], "completed")  # обычное завершение — без сообщения
    await pair_completed(env, room, [inviter, invitee], "stopped")
    await env.dispatch(at(DAY, "17:55"))
    assert sorted(texts(env, invitee)) == sorted([
        "<b>Приглашение на парный урок</b>\nAli_07 зовёт вас на парный урок английского. Начало — "
        f"{start.astimezone(ZoneInfo('Asia/Tashkent')):%d.%m %H:%M}.",
        "<b>Парный урок через 5 минут</b>\nСкоро начало — заходите в комнату вовремя.",
        "<b>Парный урок остановлен</b>\nАдминистратор остановил комнату. Отчёт по сделанному — в приложении."])
    assert {c["buttons"][0][0]["startapp"] for c in env.gateway.calls} == {f"room_{room}"}
    assert sorted(r.template for r in await env.rows(inviter)) == ["pair_starting", "pair_stopped"]
    # «сейчас» и устаревшее: через 15 минут после старта — только центр
    late, now_room = env.add_user(), uuid.uuid4()
    await pair_invited(env, inviter, late, now_room)
    await env.dispatch(at(DAY, "12:16"))
    assert ((await env.one(late)).telegram_status, (await env.one(late)).reason) == ("in_app_only", "stale")
    assert (await env.one(late)).params is None
    [item] = (await env.inbox(late))["items"]
    assert item["body"].endswith("Начало — сейчас.")


# ---------------------------------------------------------------- рефералы и модерация


async def rewarded(env, inviter: uuid.UUID, referral_id: uuid.UUID, *, outcome: str | None = "rewarded",
                   reward: dict[str, int] | None = None, with_reward: bool = True,
                   producer: str = "gamification") -> Envelope:
    """game.referral.rewarded.v1 — gamification решил, что начислено пригласившему (inviter_reward)."""
    payload: dict[str, Any] = {"referral_id": str(referral_id), "inviter_user_id": str(inviter),
                               "invitee_user_id": str(uuid.uuid4()), "rewarded_at": iso(NOON)}
    if outcome is not None:
        payload["outcome"] = outcome
    if with_reward:
        payload["inviter_reward"] = reward
    return await env.publish("game.referral.rewarded.v1", payload, producer=producer)


async def test_referral_qualified_only_after_reward(env, caplog) -> None:
    """«Приглашение засчитано» — по game.referral.rewarded.v1 (gamification), когда награда пригласившему начислена:
    outcome rewarded (или нет поля — издатель до outcome), награда — из inviter_reward. legacy и inviter_capped — без
    сообщения; social.referral.qualified.v1 больше ничего не отправляет (квалификация — ещё не награда)."""
    caplog.set_level(logging.WARNING, logger="tilhero.notifications.consumers")
    inviter, other, old = env.add_user(), env.add_user(locale="uz"), env.add_user()
    # квалификация в social — ещё не награда: сообщения нет
    await env.publish("social.referral.qualified.v1", {
        "referral_id": str(uuid.uuid4()), "inviter_user_id": str(inviter), "invitee_user_id": str(uuid.uuid4()),
        "campaign_version": 1, "inviter_reward": {"freeze": 2, "til": 0}, "invitee_reward": {"freeze": 0, "til": 0},
        "inviter_monthly_cap": 10, "qualified_at": iso(NOON)}, producer="social")
    assert await env.rows(inviter) == []
    # rewarded — с наградой из inviter_reward; повтор доставки и повторная публикация — одно сообщение
    rid = uuid.uuid4()
    ev = await rewarded(env, inviter, rid, reward={"freeze": 2, "til": 0})
    spec = next(s for s in env.bus.specs if s.durable == "notifications.referral_rewards")
    await spec.handler(ev)
    await rewarded(env, inviter, rid, reward={"freeze": 2, "til": 0})
    row = await env.one(inviter)
    assert (row.template, row.category, row.dedup_key) == ("referral_qualified", "social", f"referral_qualified:{rid}")
    # без outcome (издатель до поля) — как rewarded
    await rewarded(env, other, uuid.uuid4(), outcome=None, reward={"freeze": 1, "til": 30})
    # legacy и inviter_capped — пригласившему ничего не начислено, сообщения нет
    await rewarded(env, old, uuid.uuid4(), outcome="legacy", reward=None)
    await rewarded(env, old, uuid.uuid4(), outcome="inviter_capped", reward=None)
    await rewarded(env, old, uuid.uuid4(), outcome="inviter_capped", with_reward=False)
    # кампания дала пригласившему ноль — «вы получили» не пишем
    await rewarded(env, old, uuid.uuid4(), reward={"freeze": 0, "til": 0})
    assert await env.rows(old) == []
    # rewarded без inviter_reward (null или нет поля) — не отправляется, предупреждение без user_id
    for with_reward in (True, False):
        await rewarded(env, old, uuid.uuid4(), reward=None, with_reward=with_reward)
    assert await env.rows(old) == []
    warned = [r for r in caplog.records if r.getMessage() == "referral rewarded without inviter_reward: no message"]
    assert len(warned) == 2 and all(str(old) not in str(r.__dict__) for r in warned)
    # чужой издатель (social, lessons) — без сообщения
    await rewarded(env, old, uuid.uuid4(), reward={"freeze": 2, "til": 0}, producer="social")
    await rewarded(env, old, uuid.uuid4(), reward={"freeze": 2, "til": 0}, producer="lessons")
    assert await env.rows(old) == []
    assert len([r for r in caplog.records if r.getMessage() == "social event from unexpected producer ignored"]) == 2
    await env.dispatch(at(DAY, "12:01"))
    assert texts(env, inviter) == ["<b>Приглашение засчитано</b>\nПриглашённый вами друг выполнил условия. Награда: "
                                   "2 заморозки."]
    assert texts(env, other) == ["<b>Taklif hisobga olindi</b>\nSiz taklif qilgan doʻstingiz shartlarni bajardi. "
                                 "Mukofot: 1 ta muzlatish va 30 til."]
    assert texts(env, old) == []
    assert {c["buttons"][0][0]["startapp"] for c in env.gateway.calls} == {"route_referrals"}


async def test_referral_rejected_reasons(env) -> None:
    """Отказ — публичная причина без правил антифрода; monthly_cap (social публикует при inviter_capped) — понятный
    текст RU и UZ."""
    ru, uz = env.add_user(), env.add_user(locale="uz")
    for user in (ru, uz):
        for code in ("window_expired", "monthly_cap"):
            await env.publish("social.referral.rejected.v1", {
                "referral_id": str(uuid.uuid4()), "inviter_user_id": str(user), "reject_code": code,
                "rejected_at": iso(NOON)}, producer="social")
    await env.dispatch(at(DAY, "12:01"))
    assert sorted(texts(env, ru)) == sorted([  # два события в одну минуту — порядок отправки не задан
        "<b>Приглашение не засчитано</b>\nСрок выполнения условий истёк.",
        "<b>Приглашение не засчитано</b>\nВ этом месяце уже засчитано максимальное число приглашений."])
    assert sorted(texts(env, uz)) == sorted([
        "<b>Taklif hisobga olinmadi</b>\nShartlarni bajarish muddati tugadi.",
        "<b>Taklif hisobga olinmadi</b>\nBu oyda hisobga olinadigan takliflar soni chegarasiga yetildi."])
    assert {c["buttons"][0][0]["startapp"] for c in env.gateway.calls} == {"route_referrals"}


async def test_sanctions_appeals_and_complaints_service_category(env) -> None:
    # service не выключается настройкой категорий; жалоба — social
    user = env.add_user(categories=("support",))
    sid = uuid.uuid4()
    until = at(DAY + timedelta(days=7), "12:00")
    for change in ("applied", "expired", "revoked"):
        await env.publish("social.sanction.changed.v1", {
            "user_id": str(user), "sanction_id": str(sid), "kind": "social_ban", "until": iso(until),
            "active": change == "applied", "change": change, "changed_at": iso(NOON)}, producer="social")
    await env.publish("social.appeal.decided.v1", {"appeal_id": str(uuid.uuid4()), "sanction_id": str(sid),
                                                   "user_id": str(user), "decision": "overturned",
                                                   "decided_at": iso(NOON)}, producer="social")
    await env.publish("social.case.resolved.v1", {"case_id": str(uuid.uuid4()), "reporter_user_id": str(user),
                                                  "outcome": "action_taken", "resolved_at": iso(NOON)},
                      producer="social")
    await env.dispatch(at(DAY, "12:01"))
    sent = sorted(texts(env, user))
    assert sent == sorted([
        f"<b>Социальные функции ограничены</b>\nЗаявки в друзья, дуэли, парные уроки и общая лига недоступны до "
        f"{until.astimezone(ZoneInfo('Asia/Tashkent')):%d.%m %H:%M}. Учёба продолжается как "
        "обычно. Решение можно обжаловать в разделе «Друзья».",
        "<b>Обжалование удовлетворено</b>\nМы пересмотрели решение и сняли ограничение."])
    rows = {r.template: r for r in await env.rows(user)}
    assert (rows["sanction_applied"].category, rows["sanction_appeal_decided"].category) == ("service", "service")
    assert (rows["complaint_resolved"].telegram_status, rows["complaint_resolved"].reason) == (
        "skipped", "category_disabled")
    reporter = env.add_user()
    await env.publish("social.case.resolved.v1", {"case_id": str(uuid.uuid4()), "reporter_user_id": str(reporter),
                                                  "outcome": "dismissed", "resolved_at": iso(NOON)},
                      producer="social")
    await env.dispatch(at(DAY, "12:02"))
    [msg] = env.gateway.to(env.telegram_id(reporter))
    assert msg["text"] == "<b>Жалоба рассмотрена</b>\nСпасибо, что сообщили! Жалоба проверена: нарушений не найдено."
    assert not msg.get("buttons")  # §5: без ссылки
    indefinite = env.add_user()
    await env.publish("social.sanction.changed.v1", {
        "user_id": str(indefinite), "sanction_id": str(uuid.uuid4()), "kind": "social_ban", "until": None,
        "active": True, "change": "applied", "changed_at": iso(NOON)}, producer="social")
    await env.dispatch(at(DAY, "12:03"))
    assert "недоступны бессрочно" in texts(env, indefinite)[0]


# ---------------------------------------------------------------- дети


async def test_child_family_duel_and_room_center_only_softly(env) -> None:
    parent = env.add_user(name="Нигора")
    child = env.add_child(parent, name="Мадина", age_band="6-9")
    duel, room = uuid.uuid4(), uuid.uuid4()
    await challenged(env, parent, child, duel, nickname=None)
    await finished(env, parent, child, duel, result="challenger")
    await pair_invited(env, parent, child, room, nickname=None)
    await env.dispatch(at(DAY, "12:01"))
    # ни ребёнку, ни опекуну (адрес ребёнка — Telegram опекуна) — без Telegram: опекун получил только свой итог
    assert [c["text"] for c in env.gateway.to(env.telegram_id(child))] == [
        "<b>Дуэль завершена</b>\nПобеда! Ваш результат: 8 из 10."]
    rows = {r.template: r for r in await env.rows(child)}
    assert set(rows) == {"duel_challenged.kid", "duel_finished.kid", "pair_invited.kid"}
    assert {(r.telegram_status, r.reason) for r in rows.values()} == {("in_app_only", "kid_summary")}
    items = {i["title"]: i["body"] for i in (await env.inbox(child))["items"]}
    assert items == {
        "Мадина: вызов на дуэль": "Член семьи зовёт на дуэль из 10 заданий — можно сыграть вместе.",
        "Мадина: дуэль завершена": "Дуэль закончилась — посмотрите вместе, какие задания получились.",
        "Мадина: приглашение на парный урок": "Член семьи зовёт на парный урок — можно позаниматься вместе. "
                                              "Начало — сейчас.",
    }
    assert not any(PRESSURE_WORDS.search(t + b) for t, b in items.items())
    assert not any(w in " ".join(items.values()) for w in ("Победа", "результат", "из 10."))


# ---------------------------------------------------------------- издатель, удалённый ученик, неверное событие


async def test_foreign_producers_deleted_user_and_dlq(env, caplog) -> None:
    caplog.set_level(logging.WARNING, logger="tilhero.notifications.consumers")
    user = env.add_user()
    await friend_request(env, user, env.add_user(), producer="gamification")
    await challenged(env, env.add_user(), user, uuid.uuid4(), producer="social")
    await pair_invited(env, env.add_user(), user, uuid.uuid4(), producer="gamification")
    assert await env.rows(user) == []
    warned = [r for r in caplog.records if r.getMessage() == "social event from unexpected producer ignored"]
    assert len(warned) == 3 and all(str(user) not in str(r.__dict__) for r in warned)
    await env.delete(user)
    await friend_request(env, user, env.add_user())
    assert await env.rows(user) == []
    # отправитель заявки удалён — записи центра с его ником удаляются вместе с ним (subject_user_id)
    sender, receiver = env.add_user(), env.add_user()
    await friend_request(env, receiver, sender)
    await env.delete(sender)
    assert await env.rows(receiver) == []
    bad = make_envelope("game.duel.finished.v1", {"duel_id": str(uuid.uuid4())}, producer="gamification")
    await env.bus.publish(bad)
    assert [e.event_id for _, e in env.bus.dlq] == [bad.event_id]


# ---------------------------------------------------------------- админка шаблонов


async def test_staff_templates_list_without_service(env) -> None:
    r = await env.client.get("/admin/v1/notifications/templates", headers=env.staff(MANAGE))
    assert r.status_code == 200, r.text
    items = {i["key"]: i for i in r.json()["items"]}
    assert not any(k.startswith("sanction_") for k in items)
    assert all(i["category"] != "service" for i in items.values())
    assert (items["duel_finished"]["category"], items["league_closed"]["category"],
            items["friend_request"]["category"], items["complaint_resolved.kid"]["kid"]) == (
        "game", "game", "social", True)
    r = await env.client.get("/admin/v1/notifications/templates/sanction_applied", headers=env.staff(MANAGE))
    assert r.status_code == 404 and r.json()["code"] == "TEMPLATE_NOT_FOUND"


# ---------------------------------------------------------------- приглашения вне общего лимита (решение владельца)


async def test_invites_outside_daily_limit_with_own_limit(env) -> None:
    """Приглашения (pair_invited, pair_starting, duel_challenged) не тратят общий лимит 3 сообщений и не упираются в
    него; свой лимит: invite_daily_limit (5) на получателя и invite_per_sender_limit (2) от одного отправителя."""
    user = env.add_user()
    await env.reminder(user, DAY, "11:00")
    for _ in range(2):
        await env.invite("accepted", user, env.add_user())
    await env.dispatch(at(DAY, "11:30"))
    assert len(env.gateway.to(env.telegram_id(user))) == 3  # общий лимит исчерпан
    start = at(DAY, "13:00")
    # приглашение на урок вдвоём и вызов на дуэль после исчерпанного общего лимита — уходят в Telegram
    await pair_invited(env, env.add_user(), user, uuid.uuid4(), start=start)
    await challenged(env, env.add_user(), user, uuid.uuid4())
    await env.dispatch(at(DAY, "12:00"))
    assert len(env.gateway.to(env.telegram_id(user))) == 5
    # приглашения не уменьшили общий лимит: обычное сообщение по-прежнему только в центре
    await friend_request(env, user, env.add_user())
    await env.dispatch(at(DAY, "12:01"))
    row = next(r for r in await env.rows(user) if r.template == "friend_request")
    assert (row.telegram_status, row.reason) == ("in_app_only", "daily_limit")
    # от одного отправителя — не больше 2 в сутки
    spammer = env.add_user()
    for _ in range(3):
        await pair_invited(env, spammer, user, uuid.uuid4(), start=start)
    await env.dispatch(at(DAY, "12:02"))
    rows = [r for r in await env.rows(user) if r.subject_user_id == spammer]
    assert sorted((r.telegram_status, r.reason or "") for r in rows) == [
        ("in_app_only", "invite_limit"), ("sent", ""), ("sent", "")]
    # 5 приглашений получателю за сутки — шестое только в центре
    assert len(env.gateway.to(env.telegram_id(user))) == 7  # 3 общих + 4 приглашения (2 разных + 2 от spammer)
    await challenged(env, env.add_user(), user, uuid.uuid4())
    await challenged(env, env.add_user(), user, uuid.uuid4())
    await env.dispatch(at(DAY, "12:03"))
    assert len(env.gateway.to(env.telegram_id(user))) == 8
    last = [r for r in await env.rows(user) if r.template == "duel_challenged"]
    assert sorted(r.reason or "" for r in last if r.telegram_status == "in_app_only") == ["invite_limit"]
    # новые сутки — лимит приглашений снова свободен
    next_day = local_day(2)
    await pair_invited(env, spammer, user, uuid.uuid4(), start=at(next_day, "13:00"))
    await env.dispatch(at(next_day, "12:00"))
    assert len(env.gateway.to(env.telegram_id(user))) == 9

"""Сценарии §4: напоминания (AT-07), пропуски (AT-08), приглашения (AT-09, AT-10), центр (AT-12), настройки
и лимит (AT-13), поддержка (AT-15), «Что нового» только в центре; дети 6–13 — опекуну, мягко, 08:00–20:00."""

from __future__ import annotations

import uuid
from datetime import timedelta

from notif_testkit import TZ, api_error, at, local_day
from test_notifications_templates import FORBIDDEN

from tilhero_common.testing import assert_event_conforms


async def test_reminder_in_slot_reaches_telegram_and_center(env) -> None:
    """AT-07: напоминание в слот по местному времени; запись видна в центре; повтор события — без дубля."""
    user, day = env.add_user(), local_day(1)
    first = await env.reminder(user, day, "10:00", duration=15)
    row = await env.one(user)
    assert (row.telegram_status, row.category, row.template, row.title) == (
        "scheduled", "reminders", "lesson.reminder", None
    )
    assert row.dedup_key == f"reminder:{user}:{day.isoformat()}"
    assert row.stale_after == at(day, "13:00")
    assert await env.dispatch(at(day, "10:01")) == 1
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(user)
    assert msg["text"] == "<b>Время занятия</b>\nПо графику — 15 минут английского. Начнём?"
    assert msg["buttons"] == [[{"text": "Начать занятие", "startapp": "route_home"}]]
    assert msg["idempotency_key"] == str(row.notification_id) and msg["disable_notification"] is False
    row = await env.row(row.notification_id)
    assert row.telegram_status == "sent" and row.params is None and row.limit_day == day and row.attempts == 1
    [item] = (await env.inbox(user))["items"]
    assert item == {
        "notification_id": str(row.notification_id),
        "category": "reminders",
        "title": "Время занятия",
        "body": "По графику — 15 минут английского. Начнём?",
        "startapp": "route_home",
        "created_at": item["created_at"],
        "read_at": None,
        "telegram": "sent",
    }
    assert item["created_at"].endswith("Z")
    [delivered] = await env.events("notification.delivered.v1")
    assert delivered.payload["user_id"] == str(user)
    assert_event_conforms(delivered)
    # Повтор: та же доставка (inbox) и новое событие о том же слоте (dedup_key)
    spec = next(s for s in env.bus.specs if s.durable == "notifications.learning")
    await spec.handler(first)
    await env.reminder(user, day, "10:00", duration=15)
    assert len(await env.rows(user)) == 1
    await env.dispatch(at(day, "10:05"))
    assert len(env.gateway.calls) == 1


async def test_category_disabled_is_skipped_everywhere(env) -> None:
    """AT-13: категория выключена → ни Telegram, ни центра (шаг 1 §4 раньше тихих часов и выключателя)."""
    user = env.add_user(categories=("support",), enabled=False, quiet={"start": "00:00", "end": "23:59"})
    day = local_day(1)
    await env.reminder(user, day, "10:00")
    await env.missed(user, day, "10:00")
    await env.dispatch(at(day + timedelta(days=1), "10:00"))
    assert env.gateway.calls == []
    assert {(r.telegram_status, r.reason) for r in await env.rows(user)} == {("skipped", "category_disabled")}
    assert (await env.inbox(user))["items"] == [] and await env.unread(user) == 0


async def test_switch_off_keeps_center_only(env) -> None:
    """Выключатель Telegram (notifications_enabled=false): только центр, а не отложить на тихие часы."""
    user, day = env.add_user(enabled=False, quiet={"start": "00:00", "end": "23:59"}), local_day(1)
    await env.reminder(user, day, "10:00")
    await env.dispatch(at(day, "10:00"))
    row = await env.one(user)
    assert (row.telegram_status, row.reason) == ("in_app_only", "notifications_disabled")
    assert env.gateway.calls == []
    [item] = (await env.inbox(user))["items"]
    assert item["telegram"] == "in_app_only" and item["title"] == "Время занятия"


async def test_quiet_hours_defer_until_end_then_send(env) -> None:
    """AT-07/AT-13: в тихие часы откладывается до их конца (в часовом поясе ученика); в центре — scheduled."""
    user, day = env.add_user(quiet={"start": "22:00", "end": "08:00"}), local_day(1)
    await env.reminder(user, day, "07:00")
    assert await env.dispatch(at(day, "07:00")) == 1
    row = await env.one(user)
    assert (row.telegram_status, row.scheduled_for, row.reason) == ("scheduled", at(day, "08:00"), "quiet_hours")
    assert row.title == "Время занятия" and row.params is not None
    [item] = (await env.inbox(user))["items"]
    assert item["telegram"] == "scheduled"
    assert await env.dispatch(at(day, "07:59")) == 0
    assert await env.dispatch(at(day, "08:00")) == 1
    assert (await env.one(user)).telegram_status == "sent" and len(env.gateway.calls) == 1


async def test_stale_reminder_goes_to_center_only(env) -> None:
    """Напоминание позже слота + 3 ч (например, после простоя) — только центр."""
    user, day = env.add_user(), local_day(1)
    await env.reminder(user, day, "10:00")
    await env.dispatch(at(day, "13:00"))
    row = await env.one(user)
    assert (row.telegram_status, row.reason) == ("in_app_only", "stale") and env.gateway.calls == []
    # Тихие часы дольше срока актуальности: сразу центр, без «отложено»
    late = env.add_user(quiet={"start": "21:00", "end": "08:00"})
    await env.reminder(late, day, "21:30")
    await env.dispatch(at(day, "21:30"))
    assert ((await env.one(late)).telegram_status, (await env.one(late)).reason) == ("in_app_only", "stale")


async def test_kid_reminder_to_guardian_with_name_inside_window(env) -> None:
    """AT-07 (дети): адресат — опекун, шаблон *.kid с именем ребёнка, не позже 20:00 и не раньше 08:00."""
    parent = env.add_user(name="Нигора")
    child = env.add_child(parent, name="Мадина", age_band="6-9")
    day = local_day(1)
    await env.reminder(child, day, "19:30", duration=10)
    await env.dispatch(at(day, "19:31"))
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(parent)
    assert msg["text"].startswith("<b>Мадина: время занятия</b>\nПо графику — 10 минут английского.")
    row = await env.one(child)
    assert row.template == "lesson.reminder.kid" and row.user_id == child and row.telegram_status == "sent"
    assert [i["title"] for i in (await env.inbox(child))["items"]] == ["Мадина: время занятия"]
    assert (await env.inbox(parent))["items"] == []  # центр ребёнка — его записи
    # 20:30 — вне окна: на 08:00 завтра, но это позже слота + 3 ч → только центр
    late_day = local_day(2)
    await env.reminder(child, late_day, "20:30")
    await env.dispatch(at(late_day, "20:31"))
    late = next(r for r in await env.rows(child) if r.dedup_key.endswith(late_day.isoformat()))
    assert (late.telegram_status, late.reason) == ("in_app_only", "stale")
    # 07:00 без тихих часов — ждёт 08:00 (окно детей), затем уходит родителю
    early_day = local_day(3)
    await env.reminder(child, early_day, "07:00")
    await env.dispatch(at(early_day, "07:00"))
    early = next(r for r in await env.rows(child) if r.dedup_key.endswith(early_day.isoformat()))
    assert (early.telegram_status, early.reason) == ("scheduled", "kid_window")
    assert early.scheduled_for == at(early_day, "08:00")
    await env.dispatch(at(early_day, "08:00"))
    assert (await env.row(early.notification_id)).telegram_status == "sent"
    assert [c["telegram_user_id"] for c in env.gateway.calls] == [env.telegram_id(parent)] * 2
    for c in env.gateway.calls:
        assert not FORBIDDEN.search(c["text"])


async def test_missed_waits_for_next_day_slot_then_stale_after_22(env) -> None:
    """AT-08: пропуск — в слот-время следующего дня; позже 22:00 следующего дня — только центр."""
    user, day = env.add_user(), local_day(1)
    nxt = day + timedelta(days=1)
    await env.missed(user, day, "19:00", consecutive=1, next_slot=day + timedelta(days=2))
    row = await env.one(user)
    assert row.not_before == at(nxt, "19:00") and row.stale_after == at(nxt, "22:00")
    await env.dispatch(at(nxt, "00:05"))
    row = await env.one(user)
    assert (row.telegram_status, row.scheduled_for, row.reason) == ("scheduled", at(nxt, "19:00"), "not_before")
    assert (await env.inbox(user))["items"][0]["title"] == "Вчера занятия не было"
    await env.dispatch(at(nxt, "19:00"))
    [msg] = env.gateway.calls
    expected_next = (day + timedelta(days=2)).strftime("%d.%m")
    assert msg["text"].endswith(f"Следующее занятие по графику — {expected_next}.")
    other = env.add_user()
    await env.missed(other, day, "19:00")
    await env.dispatch(at(nxt, "22:00"))
    assert ((await env.one(other)).telegram_status, (await env.one(other)).reason) == ("in_app_only", "stale")


async def test_missed_series_comeback_not_more_than_weekly(env) -> None:
    """AT-08: 1–3 пропуска — каждый день; с 4-го — lesson.comeback не чаще раза в 7 дней."""
    user, d0 = env.add_user(), local_day(1)
    for n in range(1, 18):
        await env.missed(user, d0 + timedelta(days=n - 1), consecutive=n)
    await env.missed(user, d0, consecutive=1)  # повтор события за тот же день — без дубля
    rows = await env.rows(user)
    got = [(r.template, int(r.params["consecutive_missed"])) for r in rows]  # type: ignore[index]
    assert got == [
        ("lesson.missed", 1),
        ("lesson.missed", 2),
        ("lesson.missed", 3),
        ("lesson.comeback", 10),  # через 7 дней после 3-го
        ("lesson.comeback", 17),
    ]
    assert all(r.category == "missed" for r in rows)


async def test_missed_kid_is_soft_and_addressed_to_parent(env) -> None:
    parent = env.add_user(locale="uz")
    child = env.add_child(parent, name="Bekzod", age_band="10-13")
    day = local_day(1)
    nxt = day + timedelta(days=1)
    await env.missed(child, day, "16:00", consecutive=2)
    await env.missed(child, day + timedelta(days=8), "16:00", consecutive=9)  # ≥ 7 дней после прошлого
    await env.dispatch(at(nxt, "16:00"))
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(parent)
    assert msg["text"].startswith("<b>Bekzod: mashgʻulotni davom ettiramizmi?</b>")
    assert not FORBIDDEN.search(msg["text"])
    templates = sorted(r.template for r in await env.rows(child))
    assert templates == ["lesson.comeback.kid", "lesson.missed.kid"]


async def test_invite_accepted_reaches_inviter_with_name(env) -> None:
    """AT-09: принятие — пригласившему приходит уведомление с именем принявшего (без username и Telegram ID)."""
    inviter, invitee = env.add_user(), env.add_user(name="Дилноза")
    invite = await env.invite("accepted", inviter, invitee, kind="friend")
    await env.dispatch(at(local_day(1), "12:00"))
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(inviter)
    assert msg["text"] == "<b>Приглашение принято</b>\nДилноза принял(а) ваше приглашение в TilHero."
    assert msg["buttons"] == [[{"text": "Открыть TilHero", "startapp": "route_family"}]]
    row = await env.one(inviter)
    assert row.subject_user_id == invitee and row.dedup_key == f"invite.accepted:{invite}:{invitee}"
    assert await env.rows(invitee) == []
    # Самоприглашение (social его отклоняет) — без сообщений
    await env.invite("accepted", inviter, inviter)
    assert len(await env.rows(inviter)) == 1


async def test_family_accept_and_member_added_give_one_message_to_owner(env) -> None:
    owner, joiner, family = env.add_user(), env.add_user(name="Тимур"), uuid.uuid4()
    await env.member_added(family, owner, "owner")  # проекция владельца
    await env.invite("accepted", owner, joiner, kind="family")
    await env.member_added(family, joiner, "adult", owner)
    [row] = await env.rows(owner)
    assert row.template == "invite.accepted" and row.dedup_key == f"family.joined:{owner}:{joiner}"
    await env.dispatch(at(local_day(1), "12:00"))
    assert [c["text"] for c in env.gateway.calls] == [
        "<b>Тимур теперь в вашей семье</b>\nТимур принял(а) приглашение в семью TilHero."
    ]


async def test_family_joined_rules(env) -> None:
    owner, inviter, teen, kid = env.add_user(), env.add_user(), env.add_user(name="Лола"), uuid.uuid4()
    family = uuid.uuid4()
    await env.member_added(family, kid, "child", owner)  # ребёнка добавил сам родитель → без сообщения
    await env.member_added(family, owner, "adult", owner)  # сам владелец → без сообщения
    # Подростка пригласил не владелец: пригласившему — invite.accepted, владельцу — family.joined
    await env.invite("accepted", inviter, teen, kind="family")
    await env.member_added(family, teen, "teen", owner)
    assert [r.template for r in await env.rows(inviter)] == ["invite.accepted"]
    [row] = await env.rows(owner)
    assert row.template == "family.joined" and row.subject_user_id == teen
    await env.dispatch(at(local_day(1), "12:00"))
    assert env.gateway.to(env.telegram_id(owner))[0]["text"] == (
        "<b>Новый участник семьи</b>\nЛола теперь в вашей семье TilHero."
    )


async def test_invite_declined_is_center_only_without_name(env) -> None:
    inviter = env.add_user(categories=("support",))  # «—» в таблице §4: категория не проверяется
    invitee = env.add_user(name="Секрет")
    await env.invite("declined", inviter, invitee, kind="family")
    await env.dispatch(at(local_day(1), "12:00"))
    assert env.gateway.calls == []
    row = await env.one(inviter)
    assert (row.telegram_status, row.reason, row.subject_user_id) == ("in_app_only", "center_only", None)
    [item] = (await env.inbox(inviter))["items"]
    assert item["category"] == "social" and item["telegram"] == "in_app_only" and "Секрет" not in item["body"]


async def test_invite_reminder_to_invitee_once(env) -> None:
    """AT-10: напоминание о неотвеченном приглашении — получателю, одно, кнопка invite_<invite_id>."""
    inviter, invitee = env.add_user(name="Рустам"), env.add_user(locale="uz")
    invite = await env.invite("reminder_due", inviter, invitee, kind="family")
    await env.invite("reminder_due", inviter, invitee, kind="family", invite_id=invite)
    await env.dispatch(at(local_day(1), "12:00"))
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(invitee)
    assert msg["text"] == (
        "<b>Sizni oilaga taklif qilishdi</b>\nРустам sizni TilHero oilasiga taklif qilmoqda. "
        "Qabul qilish yoki rad etish uchun oching."
    )
    assert msg["buttons"] == [[{"text": "Taklifni ochish", "startapp": f"invite_{invite}"}]]
    assert len(await env.rows(invitee)) == 1


async def test_support_messages_always_on(env) -> None:
    """AT-15: ответ оператора приходит в Telegram и виден в центре; категория support — всегда включена."""
    user = env.add_user(categories=())
    await env.reply_event(user, "TCK-3081")
    await env.publish(
        "support.ticket.status.changed.v1",
        {
            "ticket_id": str(uuid.uuid4()),
            "number": "TCK-3081",
            "user_id": str(user),
            "from_status": "WAITING_CUSTOMER",
            "to_status": "RESOLVED",
            "changed_by": "operator",
        },
        producer="support",
    )
    await env.publish(
        "support.ticket.status.changed.v1",
        {"ticket_id": str(uuid.uuid4()), "number": "TCK-1", "user_id": str(user), "from_status": "NEW",
         "to_status": "IN_PROGRESS", "changed_by": "operator"},
        producer="support",
    )
    await env.dispatch(at(local_day(1), "12:00"))
    texts = sorted(c["text"] for c in env.gateway.calls)
    assert texts == [
        "<b>Обращение решено</b>\nОбращение TCK-3081 решено. "
        "Если вопрос остался — ответьте в обращении, и мы продолжим.",
        "<b>Ответ поддержки</b>\nПоддержка ответила на обращение TCK-3081. Откройте, чтобы прочитать.",
    ]
    assert all(c["buttons"][0][0]["startapp"] == "ticket_TCK-3081" for c in env.gateway.calls)
    assert {i["category"] for i in (await env.inbox(user))["items"]} == {"support"}


async def test_daily_limit_three_per_local_day(env) -> None:
    """Лимит: ≤ 3 сообщений reminders+missed+social в местные сутки на ученика; сверх — только центр; support
    не считается; новые местные сутки — снова можно."""
    user, day = env.add_user(), local_day(1)
    others = [env.add_user() for _ in range(3)]
    await env.reminder(user, day, "11:00")
    for o in others:
        await env.invite("accepted", user, o)
    await env.reply_event(user)
    assert await env.dispatch(at(day, "12:00")) == 5
    statuses = sorted((r.category, r.telegram_status) for r in await env.rows(user))
    assert statuses.count(("support", "sent")) == 1
    limited = [s for c, s in statuses if c != "support"]
    assert sorted(limited) == ["in_app_only", "sent", "sent", "sent"]
    over = [r for r in await env.rows(user) if r.telegram_status == "in_app_only"]
    assert [r.reason for r in over] == ["daily_limit"]
    assert len((await env.inbox(user))["items"]) == 5  # всё видно в центре
    # Следующие местные сутки (после полуночи по Ташкенту) — лимит заново
    nxt = day + timedelta(days=1)
    await env.reminder(user, nxt, "00:10")
    await env.dispatch(at(nxt, "00:10"))
    assert [r.telegram_status for r in await env.rows(user) if r.dedup_key.endswith(nxt.isoformat())] == ["sent"]


async def test_limit_is_per_learner(env) -> None:
    """Лимит считается на ученика, а не на адресата: дети и родитель пишут в один чат Telegram."""
    parent = env.add_user()
    kids = [env.add_child(parent, name=n) for n in ("Аня", "Борис")]
    day = local_day(1)
    nxt = day + timedelta(days=1)
    for kid in kids:
        await env.missed(kid, day, "10:00")  # не раньше 10:00 следующего дня
        await env.reminder(kid, nxt, "10:00")
    await env.reminder(parent, nxt, "10:00")
    for _ in range(2):
        await env.invite("accepted", parent, env.add_user())
    await env.dispatch(at(nxt, "10:00"))
    assert len(env.gateway.to(env.telegram_id(parent))) == 7
    assert all(r.telegram_status == "sent" for r in await env.rows())


async def test_blocked_bot_keeps_item_in_center(env) -> None:
    """AT-12: бот заблокирован — запись остаётся в центре (in_app_only), событие telegram.delivery.failed.v1."""
    user = env.add_user()
    env.gateway.queue.append(api_error(409, "TELEGRAM_BLOCKED"))
    await env.reply_event(user)
    await env.dispatch(at(local_day(1), "12:00"))
    row = await env.one(user)
    assert (row.telegram_status, row.reason, row.params) == ("in_app_only", "blocked", None)
    [item] = (await env.inbox(user))["items"]
    assert item["telegram"] == "in_app_only"
    [failed] = await env.events("telegram.delivery.failed.v1")
    assert failed.payload == {"notification_id": str(row.notification_id), "user_id": str(user), "reason": "blocked"}
    assert_event_conforms(failed)


async def test_inactive_unknown_and_unaddressable(env) -> None:
    disabled, ghost, no_tg = env.add_user(status="DISABLED"), uuid.uuid4(), env.add_user()
    env.set(no_tg, recipient_telegram_user_id=None)
    for user in (disabled, ghost, no_tg):
        await env.reply_event(user)
    await env.dispatch(at(local_day(1), "12:00"))
    assert env.gateway.calls == []
    got = {r.user_id: (r.telegram_status, r.reason) for r in await env.rows()}
    assert got == {
        disabled: ("skipped", "user_inactive"),
        ghost: ("skipped", "user_not_found"),
        no_tg: ("in_app_only", "no_recipient"),
    }


async def test_release_note_center_only_by_category_and_segment(env) -> None:
    """«Что нового»: только центр, категория product, сегменты; заметки до первого чтения центра — не в центре."""
    fan = env.add_user()
    uz_kid_parent = env.add_user()
    kid = env.add_child(uz_kid_parent, name="Ali", locale="uz")
    off = env.add_user(categories=("support",))
    teen = env.add_user(age_band="14-17")
    for u in (fan, kid, off, teen):
        assert await env.unread(u) == 0  # первое чтение центра — водяной знак
    await env.release_note(audience="new")  # знакомство — не для центра
    note = await env.release_note(audience="existing", segments={"age": ["kids", "adults"]})
    await env.release_note(audience="all", segments={"ui_lang": ["ru"], "age": ["kids"]})  # kid — uz
    assert await env.unread(fan) == 1
    [item] = (await env.inbox(fan))["items"]
    assert item["category"] == "product" and item["telegram"] == "in_app_only" and item["startapp"] == "route_news"
    assert item["title"] == "Что нового в TilHero"
    [kid_item] = (await env.inbox(kid))["items"]
    assert kid_item["title"] == "TilHeroʼda yangiliklar"
    assert (await env.inbox(off))["items"] == [] and (await env.inbox(teen))["items"] == []
    # повторные чтения не создают дублей; Telegram не используется
    await env.inbox(fan)
    assert await env.unread(fan) == 1 and env.gateway.calls == []
    rows = await env.rows(fan)
    assert len(rows) == 1 and rows[0].dedup_key == f"release_note:{note}:{fan}"
    late = env.add_user()
    assert await env.unread(late) == 0  # новичок не получает старые заметки в центр


async def test_release_note_sync_survives_identity_outage(env) -> None:
    user = env.add_user()
    await env.inbox(user)
    await env.release_note()
    env.identity.fail = [503, 503, 503]
    assert (await env.inbox(user))["items"] == []  # центр работает, разбор заметок — позже
    assert len((await env.inbox(user))["items"]) == 1


async def test_tz_from_delivery_for_quiet_hours(env) -> None:
    """Часовой пояс — из настроек доставки ученика (не UTC сервера)."""
    user = env.add_user(tz="Europe/Moscow", quiet={"start": "22:00", "end": "08:00"})
    day = local_day(1)
    await env.reply_event(user)
    # 07:30 по Москве = 09:30 по Ташкенту: для ученика ещё тихие часы
    await env.dispatch(at(day, "07:30", "Europe/Moscow"))
    row = await env.one(user)
    assert row.telegram_status == "scheduled" and row.scheduled_for == at(day, "08:00", "Europe/Moscow")
    assert TZ == "Asia/Tashkent"

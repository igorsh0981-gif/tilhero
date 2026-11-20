"""Спринт 5 (INTERNAL_API §1.8, §6, AT-59): шаблон `reviews_due` (категория reminders, RU/UZ, minutes =
ceil(due_count × 0,4) в пределах 2..15, кнопка → «Повторение» route_review, редактируемый — {due_count},
{review_minutes}; детский вариант `reviews_due.kid` — родителю, с именем ребёнка, мягко) и потребитель
`memory.reviews.due.v1` (только от memory) → одно напоминание в местный день через общую политику доставки, как у
lesson.reminder: категории, выключатель, тихие часы, окно детей 08:00–20:00, лимит дня, устаревание (19:00 + 3 ч)."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any

import pytest
from notif_testkit import at, local_day
from test_notifications_staff_templates import MANAGE, activate, create

from tilhero_common.messaging import make_envelope
from tilhero_notifications.domain.texts import PRESSURE_WORDS, check_texts
from tilhero_notifications.templates import (
    EDITABLE,
    SAMPLE_CONTEXT,
    TEMPLATES,
    Context,
    TemplateError,
    default_texts,
    review_minutes,
)

KEY = "reviews_due"
KID_KEY = "reviews_due.kid"
SPEC = TEMPLATES[KEY]
EVENT = "memory.reviews.due.v1"
DURABLE = "notifications.memory"


def params(due_count: int = 12, **extra: Any) -> dict[str, Any]:
    return {"local_date": "2026-11-20", "due_count": due_count, **extra}


async def due(env, user: uuid.UUID, day: date, *, count: int = 12, tz: str = "Asia/Tashkent",
              producer: str = "memory") -> Any:
    return await env.publish(EVENT, {"user_id": str(user), "local_date": day.isoformat(), "due_count": count,
                                     "timezone": tz}, producer=producer)


# ---------------------------------------------------------------- шаблон


def test_registry_entry_and_editable() -> None:
    assert SPEC.category == "reminders" and SPEC.editable and SPEC.in_app and SPEC.gated and not SPEC.kid
    assert SPEC.kid_variant == KID_KEY and SPEC.placeholder_names == ("due_count", "review_minutes")
    kid = TEMPLATES[KID_KEY]
    assert kid.kid and kid.category == "reminders"
    assert kid.placeholder_names == ("learner_name", "due_count", "review_minutes")
    assert KEY in EDITABLE and KID_KEY in EDITABLE


@pytest.mark.parametrize(("count", "minutes"), [(1, 2), (4, 2), (5, 2), (6, 3), (10, 4), (12, 5), (20, 8),
                                                (37, 15), (38, 15), (2000, 15)])
def test_minutes_formula(count: int, minutes: int) -> None:
    assert review_minutes(count) == minutes


def test_texts_ru_uz() -> None:
    r = SPEC.render("ru", params(12))
    assert (r.title, r.body, r.button, r.startapp) == (
        "Повторение дня", "Пора повторить слова: 12. Это займёт около 5 минут.", "Повторить", "route_review")
    u = SPEC.render("uz-Latn", params(5))
    assert (u.title, u.body, u.button) == (
        "Kunlik takrorlash", "Soʻzlarni takrorlash vaqti keldi: 5. Bu taxminan 2 daqiqa oladi.", "Takrorlash")
    assert u.buttons() == [[{"text": "Takrorlash", "startapp": "route_review"}]]
    big = SPEC.render("ru", params(400))
    assert big.body == "Пора повторить слова: 400. Это займёт около 15 минут."


@pytest.mark.parametrize("locale", ["ru", "uz"])
def test_kid_variant_to_parent_soft(locale: str) -> None:
    kid = TEMPLATES[KID_KEY]
    r = kid.render(locale, params(7), Context(learner_name="Мадина"))
    assert r.title.startswith("Мадина: ") and r.startapp == "route_review"
    assert not PRESSURE_WORDS.search(r.title + r.body)
    nameless = kid.render(locale, params(7), Context())
    assert nameless.title in ("Ребёнку пора повторить слова", "Farzandingizga soʻzlarni takrorlash vaqti")
    if locale == "ru":
        assert r.title == "Мадина: пора повторить слова"
        assert r.body == "Пора повторить слова: 7. Это займёт около 3 минут — повторите вместе, будет интересно!"


def test_default_texts_and_placeholders() -> None:
    texts = default_texts(SPEC)
    assert texts["ru"] == {"title": "Повторение дня", "body": "Пора повторить слова: 12. Это займёт около 5 минут.",
                           "button": "Повторить"}
    p = SPEC.validate(params(10))
    assert SPEC.values("ru", p, Context()) == {"due_count": "10", "review_minutes": "4"}
    kid = TEMPLATES[KID_KEY]
    assert kid.values("uz", p, Context()) == {"learner_name": "Farzandingiz", "due_count": "10",
                                              "review_minutes": "4"}
    assert kid.values("ru", p, SAMPLE_CONTEXT["ru"])["learner_name"] == "Мадина"
    for spec in (SPEC, kid):
        assert check_texts(default_texts(spec), allowed=spec.placeholder_names, kid=spec.kid) == []


@pytest.mark.parametrize("bad", [
    params(0), params(2001), params(-1), {"due_count": 3}, params(word="apple"),  # слов ученика нет в параметрах
    params(text="ввод ученика"), {**params(), "local_date": "завтра"},
])
def test_invalid_params(bad: dict[str, Any]) -> None:
    with pytest.raises(TemplateError):
        SPEC.render("ru", bad)


async def test_staff_list_card_and_active_version_applied(env) -> None:
    r = await env.client.get("/admin/v1/notifications/templates", headers=env.staff(MANAGE))
    assert r.status_code == 200, r.text
    keys = [i["key"] for i in r.json()["items"]]
    assert KEY in keys and KID_KEY in keys
    r = await env.client.get(f"/admin/v1/notifications/templates/{KID_KEY}", headers=env.staff(MANAGE))
    assert r.status_code == 200, r.text
    card = r.json()
    assert card["category"] == "reminders" and card["kid"] is True
    assert [p["name"] for p in card["placeholders"]] == ["learner_name", "due_count", "review_minutes"]
    assert card["placeholders"][1]["sample"] == {"ru": "7", "uz": "7"}
    # детская версия с давлением не сохраняется
    bad = await create(env, KID_KEY, {"texts": {
        "ru": {"title": "{learner_name}", "body": "Не потеряй серию: {due_count}", "button": None},
        "uz": {"title": "{learner_name}", "body": "{due_count}", "button": None}}, "note": "Пробуем"})
    assert (bad.status_code, bad.json()["code"]) == (422, "TEMPLATE_INVALID")
    r = await create(env, KEY, {"texts": {
        "ru": {"title": "Слова ждут", "body": "К повторению: {due_count} ({review_minutes} мин).", "button": None},
        "uz": {"title": "Soʻzlar kutmoqda", "body": "Takrorlash: {due_count}.", "button": None}},
        "note": "Короче"})
    assert r.status_code == 201, r.text
    assert (await activate(env, r.json()["version"], key=KEY)).status_code == 200
    user, day = env.add_user(), local_day(1)
    await due(env, user, day, count=20)
    await env.dispatch(at(day, "19:01"))
    [msg] = env.gateway.calls
    assert msg["text"] == "<b>Слова ждут</b>\nК повторению: 20 (8 мин)."
    assert msg["buttons"] == [[{"text": "Повторить", "startapp": "route_review"}]]


# ---------------------------------------------------------------- потребитель и доставка


async def test_due_reaches_telegram_and_center(env) -> None:
    user, day = env.add_user(), local_day(1)
    ev = await due(env, user, day, count=12)
    row = await env.one(user)
    assert (row.template, row.category, row.telegram_status) == (KEY, "reminders", "scheduled")
    assert row.dedup_key == f"reviews_due:{user}:{day.isoformat()}" and str(row.source_event_id) == ev.event_id
    assert row.params == {"local_date": day.isoformat(), "due_count": 12}
    assert row.stale_after == at(day, "22:00")  # 19:00 + 3 ч, как у напоминания о занятии
    await env.dispatch(at(day, "19:02"))
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(user)
    assert msg["text"] == "<b>Повторение дня</b>\nПора повторить слова: 12. Это займёт около 5 минут."
    row = await env.row(row.notification_id)
    assert row.telegram_status == "sent" and row.params is None and row.limit_day == day
    [item] = (await env.inbox(user))["items"]
    assert (item["category"], item["title"], item["startapp"]) == ("reminders", "Повторение дня", "route_review")


async def test_uzbek_learner_and_plan_timezone(env) -> None:
    user, day = env.add_user(locale="uz", tz="Europe/Moscow"), local_day(1)
    await due(env, user, day, count=3, tz="Europe/Moscow")
    row = await env.one(user)
    assert row.stale_after == at(day, "22:00", tz="Europe/Moscow")
    await env.dispatch(at(day, "19:05", tz="Europe/Moscow"))
    [msg] = env.gateway.calls
    assert msg["text"] == "<b>Kunlik takrorlash</b>\nSoʻzlarni takrorlash vaqti keldi: 3. Bu taxminan 2 daqiqa oladi."


async def test_one_reminder_per_local_day(env) -> None:
    user, day = env.add_user(), local_day(1)
    ev = await due(env, user, day)
    spec = next(s for s in env.bus.specs if s.durable == DURABLE)
    await spec.handler(ev)  # повтор доставки — inbox
    await due(env, user, day, count=30)  # повторная публикация того же дня — ключ дедупликации
    assert len(await env.rows(user)) == 1
    await due(env, user, local_day(2))  # другой день — своё напоминание
    assert len(await env.rows(user)) == 2


async def test_category_switch_quiet_hours_and_stale_like_lesson_reminder(env) -> None:
    day = local_day(1)
    no_reminders = env.add_user(categories=("missed", "social", "support", "product"))
    switched_off = env.add_user(enabled=False)
    quiet = env.add_user(quiet={"start": "18:00", "end": "19:30"})
    late_quiet = env.add_user(quiet={"start": "18:00", "end": "08:00"})
    for user in (no_reminders, switched_off, quiet, late_quiet):
        await due(env, user, day)
    await env.dispatch(at(day, "19:00"))
    assert ((await env.one(no_reminders)).telegram_status, (await env.one(no_reminders)).reason) == (
        "skipped", "category_disabled")
    assert (await env.inbox(no_reminders))["items"] == []
    row = await env.one(switched_off)
    assert (row.telegram_status, row.reason) == ("in_app_only", "notifications_disabled")
    row = await env.one(quiet)
    assert (row.telegram_status, row.reason, row.scheduled_for) == ("scheduled", "quiet_hours", at(day, "19:30"))
    row = await env.one(late_quiet)  # тихие часы до утра — позже 22:00: только центр
    assert (row.telegram_status, row.reason) == ("in_app_only", "stale")
    assert env.gateway.calls == []
    await env.dispatch(at(day, "19:30"))
    assert [c["telegram_user_id"] for c in env.gateway.calls] == [env.telegram_id(quiet)]


async def test_daily_limit_counts_reviews_due(env) -> None:
    """reminders входит в лимит 3 сообщений в местные сутки: четвёртое — только центр."""
    user, day = env.add_user(), local_day(1)
    await env.reminder(user, day, "18:00")
    for _ in range(2):
        await env.invite("accepted", user, env.add_user())
    await env.dispatch(at(day, "18:30"))
    assert len(env.gateway.calls) == 3
    await due(env, user, day)
    await env.dispatch(at(day, "19:00"))
    assert len(env.gateway.calls) == 3
    row = next(r for r in await env.rows(user) if r.template == KEY)
    assert (row.telegram_status, row.reason) == ("in_app_only", "daily_limit")


async def test_child_goes_to_guardian_softly_and_kid_window(env) -> None:
    parent = env.add_user(name="Нигора")
    child = env.add_child(parent, name="Мадина", age_band="10-13")
    day = local_day(1)
    await due(env, child, day, count=7)
    await env.dispatch(at(day, "19:03"))
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(parent)
    assert msg["text"] == ("<b>Мадина: пора повторить слова</b>\nПора повторить слова: 7. Это займёт около 3 минут — "
                           "повторите вместе, будет интересно!")
    assert not PRESSURE_WORDS.search(msg["text"])
    row = await env.one(child)
    assert (row.telegram_status, row.template, row.user_id) == ("sent", KID_KEY, child)
    assert (await env.inbox(parent))["items"] == []
    # после 20:00 (окно детей) — на 08:00 завтра, это позже 22:00 → только центр
    late = local_day(2)
    await due(env, child, late)
    await env.dispatch(at(late, "20:05"))
    row = next(r for r in await env.rows(child) if r.dedup_key.endswith(late.isoformat()))
    assert (row.telegram_status, row.reason) == ("in_app_only", "stale")
    assert len(env.gateway.calls) == 1


async def test_foreign_producer_deleted_user_and_invalid_payload(env) -> None:
    user, day = env.add_user(), local_day(1)
    for producer in ("learning-plan", "lessons", "telegram-bff", "notifications"):
        await due(env, user, day, producer=producer)
    assert await env.rows(user) == []
    await env.delete(user)
    await due(env, user, day)  # ученик удалён — без записи
    assert await env.rows(user) == []
    other = env.add_user()
    bad = make_envelope(EVENT, {"user_id": str(other), "local_date": day.isoformat(), "due_count": 0,
                                "timezone": "Asia/Tashkent"}, producer="memory")
    await env.bus.publish(bad)  # 0 карточек — не по контракту: DLQ, без записи
    assert [e.event_id for _, e in env.bus.dlq] == [bad.event_id]
    assert await env.rows(other) == []

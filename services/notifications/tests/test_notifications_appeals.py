"""Спринт 4 (INTERNAL_API §5, AT-47): шаблон `appeal_decided` (категория support, RU/UZ, два варианта — «оценка
верна» / «оценка исправлена», без текста решения сотрудника; детский вариант родителю; кнопка → «Уроки»
route_lessons; редактируемый — {appeal_result}) и потребитель `assessment.appeal.decided.v1` → одно уведомление на
апелляцию через общую политику доставки спринта 1."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from notif_testkit import at, local_day, quiet_around_now
from test_notifications_staff_templates import MANAGE, activate, create

from tilhero_common.messaging import make_envelope
from tilhero_notifications.domain.texts import PRESSURE_WORDS
from tilhero_notifications.templates import (
    APPEAL_RESULTS,
    SAMPLE_CONTEXT,
    TEMPLATES,
    Context,
    TemplateError,
    default_texts,
)

KEY = "appeal_decided"
KID_KEY = "appeal_decided.kid"
SPEC = TEMPLATES[KEY]
EVENT = "assessment.appeal.decided.v1"
DURABLE = "notifications.assessment"
APPEAL = "7c4e2a10-5b3d-4f6e-8a9b-1c2d3e4f5a6b"
EVALUATION = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d"

RU_UPHELD = "Мы проверили вашу оценку урока: оценка верна."
RU_CORRECTED = "Мы проверили вашу оценку урока: оценка исправлена, посмотрите обновлённый результат."
UZ_UPHELD = "Dars bahongizni tekshirdik: baho toʻgʻri."
UZ_CORRECTED = "Dars bahongizni tekshirdik: baho tuzatildi, yangilangan natijani koʻring."


def params(decision: str = "upheld", **extra: Any) -> dict[str, Any]:
    return {"appeal_id": APPEAL, "evaluation_id": EVALUATION, "decision": decision, **extra}


async def decided(env, user: uuid.UUID, *, decision: str = "upheld", appeal_id: str = APPEAL,
                  producer: str = "assessment") -> Any:
    return await env.publish(EVENT, {
        "appeal_id": appeal_id, "evaluation_id": EVALUATION, "user_id": str(user), "decision": decision,
        "decided_at": "2026-11-19T10:00:00Z",
    }, producer=producer)


# ---------------------------------------------------------------- шаблон


def test_registry_entry() -> None:
    assert SPEC.category == "support" and SPEC.editable and SPEC.in_app and SPEC.gated and not SPEC.kid
    assert SPEC.kid_variant == KID_KEY and SPEC.placeholder_names == ("appeal_result",)
    kid = TEMPLATES[KID_KEY]
    assert kid.kid and kid.category == "support" and kid.placeholder_names == ("learner_name", "appeal_result")


@pytest.mark.parametrize(("decision", "ru", "uz"), [("upheld", RU_UPHELD, UZ_UPHELD),
                                                    ("corrected", RU_CORRECTED, UZ_CORRECTED)])
def test_texts_ru_uz_two_variants(decision: str, ru: str, uz: str) -> None:
    r = SPEC.render("ru", params(decision))
    assert (r.title, r.body, r.button, r.startapp) == ("Оценка урока проверена", ru, "Открыть уроки", "route_lessons")
    u = SPEC.render("uz-Latn", params(decision))
    assert (u.title, u.body, u.button) == ("Dars bahosi tekshirildi", uz, "Darslarni ochish")
    assert u.buttons() == [[{"text": "Darslarni ochish", "startapp": "route_lessons"}]]


@pytest.mark.parametrize("decision", ["upheld", "corrected"])
@pytest.mark.parametrize("locale", ["ru", "uz"])
def test_kid_variant_to_parent_soft(decision: str, locale: str) -> None:
    kid = TEMPLATES[KID_KEY]
    r = kid.render(locale, params(decision), Context(learner_name="Мадина"))
    assert r.title.startswith("Мадина: ") and r.startapp == "route_lessons"
    assert not PRESSURE_WORDS.search(r.title + r.body)
    nameless = kid.render(locale, params(decision), Context())
    assert nameless.title in ("Оценка урока ребёнка проверена", "Farzandingizning dars bahosi tekshirildi")
    if decision == "corrected" and locale == "ru":
        assert r.body == "Мы проверили оценку урока: оценка исправлена, посмотрите обновлённый результат вместе."


def test_default_texts_and_placeholders() -> None:
    texts = default_texts(SPEC)
    assert texts["ru"] == {"title": "Оценка урока проверена", "body": RU_CORRECTED, "button": "Открыть уроки"}
    assert texts["uz"]["body"] == UZ_CORRECTED
    p = SPEC.validate(params("upheld"))
    assert SPEC.values("ru", p, Context()) == {"appeal_result": "оценка верна"}
    assert SPEC.values("uz", p, SAMPLE_CONTEXT["uz"]) == {"appeal_result": "baho toʻgʻri"}
    kid = TEMPLATES[KID_KEY]
    assert kid.values("ru", p, Context()) == {"learner_name": "Ваш ребёнок", "appeal_result": "оценка верна"}
    for names in APPEAL_RESULTS.values():
        assert names["ru"] and names["uz"] and "'" not in names["uz"]


@pytest.mark.parametrize(
    "bad",
    [
        params(decision="new"),  # нерешённая апелляция уведомлением не бывает
        params(decision="in_review"),
        params(note="Текст решения сотрудника"),  # текст решения в уведомление не принимается
        params(decision_note="Текст решения сотрудника"),
        params(reason="Причина апелляции ученика"),
        {**params(), "appeal_id": "nope"},
        {"appeal_id": APPEAL, "decision": "upheld"},
    ],
)
def test_invalid_params(bad: dict[str, Any]) -> None:
    with pytest.raises(TemplateError):
        SPEC.render("ru", bad)


async def test_staff_card_and_active_version_applied(env) -> None:
    r = await env.client.get(f"/admin/v1/notifications/templates/{KEY}", headers=env.staff(MANAGE))
    assert r.status_code == 200, r.text
    card = r.json()
    assert card["category"] == "support" and card["kid"] is False
    assert [p["name"] for p in card["placeholders"]] == ["appeal_result"]
    bad = await create(env, KEY, {"texts": {
        "ru": {"title": "Решение", "body": "{appeal_result}: {note}", "button": None},
        "uz": {"title": "Qaror", "body": "{appeal_result}", "button": None}}, "note": "Пробуем"})
    assert (bad.status_code, bad.json()["code"]) == (422, "TEMPLATE_INVALID")
    r = await create(env, KEY, {"texts": {
        "ru": {"title": "Апелляция рассмотрена", "body": "Итог: {appeal_result}.", "button": "К урокам"},
        "uz": {"title": "Apellyatsiya koʻrib chiqildi", "body": "Natija: {appeal_result}.", "button": None}},
        "note": "Короче"})
    assert r.status_code == 201, r.text
    assert (await activate(env, r.json()["version"], key=KEY)).status_code == 200
    user = env.add_user()
    await decided(env, user, decision="corrected")
    await env.dispatch(at(local_day(1), "12:00"))
    [msg] = env.gateway.calls
    assert msg["text"] == "<b>Апелляция рассмотрена</b>\nИтог: оценка исправлена."
    assert msg["buttons"] == [[{"text": "К урокам", "startapp": "route_lessons"}]]


# ---------------------------------------------------------------- потребитель и доставка


@pytest.mark.parametrize(("decision", "body"), [("upheld", RU_UPHELD), ("corrected", RU_CORRECTED)])
async def test_decision_reaches_telegram_and_center(env, decision: str, body: str) -> None:
    user = env.add_user()
    ev = await decided(env, user, decision=decision)
    row = await env.one(user)
    assert (row.template, row.category, row.telegram_status) == (KEY, "support", "scheduled")
    assert row.dedup_key == f"appeal_decided:{APPEAL}" and str(row.source_event_id) == ev.event_id
    assert row.params == params(decision)  # только идентификаторы и решение — без текстов
    await env.dispatch(at(local_day(1), "12:00"))
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(user)
    assert msg["text"] == f"<b>Оценка урока проверена</b>\n{body}"
    assert msg["buttons"] == [[{"text": "Открыть уроки", "startapp": "route_lessons"}]]
    row = await env.row(row.notification_id)
    assert row.telegram_status == "sent" and row.params is None
    [item] = (await env.inbox(user))["items"]
    assert (item["category"], item["title"], item["startapp"]) == ("support", "Оценка урока проверена",
                                                                   "route_lessons")


async def test_uzbek_learner(env) -> None:
    user = env.add_user(locale="uz")
    await decided(env, user, decision="corrected")
    await env.dispatch(at(local_day(1), "12:00"))
    [msg] = env.gateway.calls
    assert msg["text"] == f"<b>Dars bahosi tekshirildi</b>\n{UZ_CORRECTED}"


async def test_one_notification_per_appeal(env) -> None:
    user = env.add_user()
    ev = await decided(env, user, decision="upheld")
    spec = next(s for s in env.bus.specs if s.durable == DURABLE)
    await spec.handler(ev)  # повтор доставки — inbox
    await decided(env, user, decision="upheld")  # повторная публикация — ключ дедупликации
    await decided(env, user, decision="corrected")  # та же апелляция — одно уведомление
    assert len(await env.rows(user)) == 1
    await decided(env, user, appeal_id=str(uuid.uuid4()))  # другая апелляция — своё уведомление
    assert len(await env.rows(user)) == 2
    await env.dispatch(at(local_day(1), "12:00"))
    assert len(env.gateway.calls) == 2


async def test_staff_note_never_in_text(env) -> None:
    """Даже если в событии окажется текст решения (вне схемы), в уведомление и журнал он не попадает."""
    user = env.add_user()
    ev = make_envelope(EVENT, {"appeal_id": APPEAL, "evaluation_id": EVALUATION, "user_id": str(user),
                               "decision": "upheld", "decided_at": "2026-11-19T10:00:00Z",
                               "decision_note": "Секретный комментарий методиста"}, producer="assessment")
    await env.bus.publish(ev)
    row = await env.one(user)
    assert "decision_note" not in (row.params or {})
    await env.dispatch(at(local_day(1), "12:00"))
    [msg] = env.gateway.calls
    assert "Секретный" not in msg["text"]
    assert "Секретный" not in str((await env.inbox(user))["items"])


async def test_support_category_always_on_switch_off_center_only_quiet_hours(env) -> None:
    no_categories = env.add_user(categories=())
    switched_off = env.add_user(enabled=False)
    quiet = env.add_user(quiet=quiet_around_now())
    for i, user in enumerate((no_categories, switched_off, quiet)):
        await decided(env, user, appeal_id=str(uuid.UUID(int=i + 1)))
    await env.dispatch()
    assert (await env.one(no_categories)).telegram_status == "sent"
    row = await env.one(switched_off)
    assert (row.telegram_status, row.reason) == ("in_app_only", "notifications_disabled")
    assert [i["title"] for i in (await env.inbox(switched_off))["items"]] == ["Оценка урока проверена"]
    row = await env.one(quiet)
    assert (row.telegram_status, row.reason) == ("scheduled", "quiet_hours")
    assert [c["telegram_user_id"] for c in env.gateway.calls] == [env.telegram_id(no_categories)]
    assert (await env.one(no_categories)).limit_day is None  # support не идёт в лимит 3 в сутки


async def test_child_profile_goes_to_guardian_softly_in_kid_window(env) -> None:
    parent = env.add_user(name="Нигора")
    child = env.add_child(parent, name="Мадина")
    day = local_day(1)
    await decided(env, child, decision="corrected")
    await env.dispatch(at(day, "07:00"))
    row = await env.one(child)
    assert (row.telegram_status, row.reason, row.scheduled_for) == ("scheduled", "kid_window", at(day, "08:00"))
    await env.dispatch(at(day, "08:00"))
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(parent)
    assert msg["text"] == ("<b>Мадина: оценка урока проверена</b>\nМы проверили оценку урока: оценка исправлена, "
                           "посмотрите обновлённый результат вместе.")
    assert msg["buttons"] == [[{"text": "Открыть уроки", "startapp": "route_lessons"}]]
    row = await env.one(child)
    assert (row.telegram_status, row.template) == ("sent", KID_KEY)


async def test_foreign_producer_deleted_user_and_invalid_payload(env) -> None:
    user = env.add_user()
    for producer in ("lessons", "telegram-bff", "admin-bff"):
        await decided(env, user, producer=producer)
    assert await env.rows(user) == []
    await env.delete(user)
    await decided(env, user)  # ученик удалён — без записи
    assert await env.rows(user) == []
    other = env.add_user()
    bad = make_envelope(EVENT, {"appeal_id": APPEAL, "evaluation_id": EVALUATION, "user_id": str(other),
                                "decision": "in_review", "decided_at": "2026-11-19T10:00:00Z"},
                        producer="assessment")
    await env.bus.publish(bad)  # не решение — DLQ, без записи
    assert [e.event_id for _, e in env.bus.dlq] == [bad.event_id]
    assert await env.rows(other) == []

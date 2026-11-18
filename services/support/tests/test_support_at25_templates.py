"""AT-25: ответ оператора `public` — у ученика в приложении (клиентский API) и в Telegram (событие
support.ticket.replied.v1 → notifications, шаблон support.reply, только номер обращения); внутренняя заметка ученику не
видна никогда — ни в клиентском API, ни в «Как видит клиент», ни в событиях и уведомлениях.
Плюс шаблоны ответов оператора RU/UZ (GET /admin/v1/support/templates) и формы staff API по admin.ts."""

from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path

from support_testkit import CONTEXT, MANAGER, OPERATOR, OUTSIDER, READER

from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms, internal_headers
from tilhero_support.domain import tickets as svc
from tilhero_support.domain.constants import CATEGORIES
from tilhero_support.domain.reply_templates import REPLY_TEMPLATES
from tilhero_support.models import Message

TEMPLATES = "/admin/v1/support/templates"
REPO = Path(__file__).resolve().parents[3]
DASHBOARD = Actor(id="analyst.01", role="analyst", permissions=frozenset({"dashboard.read", "users.read"}))
CYRILLIC = re.compile(r"[А-Яа-яЁё]")


def _notifications_contract():
    """Читатель события в notifications (тот же код, что в его потребителе) и каталог его шаблонов."""
    from tilhero_notifications.consumers import TICKET_REPLIED, TICKET_STATUS_CHANGED, TicketReplied
    from tilhero_notifications.templates import TEMPLATES as NOTIF_TEMPLATES

    return TicketReplied, {TICKET_REPLIED, TICKET_STATUS_CHANGED}, NOTIF_TEMPLATES


# ---------------------------------------------------------------- AT-25: public


async def test_public_reply_reaches_learner_in_app_and_triggers_support_reply(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user, category="SCHEDULE_REMINDERS", context=CONTEXT)
    ref = t["ticket_id"]
    await env.flush()
    before = len(env.bus.published)
    text = "Напоминание снова включено — проверьте, пожалуйста"
    r = await env.reply(ref, text)
    assert r.status_code == 200, r.text
    message_id = r.json()["messages"][-1]["message_id"]

    # в приложении: список (непрочитанный ответ) и тред
    listing = (await env.client.get("/internal/v1/me/tickets", headers=env.user(user))).json()
    assert listing["items"][0]["unread_operator_replies"] == 1 and listing["items"][0]["status"] == "WAITING_CUSTOMER"
    thread = (await env.client.get(f"/internal/v1/me/tickets/{ref}", headers=env.user(user))).json()
    op = thread["messages"][-1]
    assert (op["sender_type"], op["text"], op["author_name"]) == ("operator", text, "Алина")
    # другой ученик этого обращения не видит
    foreign = await env.client.get(f"/internal/v1/me/tickets/{ref}", headers=env.user(uuid.uuid4()))
    assert foreign.status_code == 404

    # в Telegram: событие → notifications (support.reply, только номер обращения, без текста ответа)
    await env.flush()
    new = env.bus.published[before:]
    replied = [e for e in new if e.event_type == "support.ticket.replied.v1"]
    assert len(replied) == 1
    ev = replied[0]
    assert_event_conforms(ev)
    assert ev.payload == {"ticket_id": ref, "number": t["number"], "user_id": str(user), "message_id": message_id,
                          "sender_type": "operator", "replied_at": ev.payload["replied_at"]}
    assert text not in json.dumps([e.payload for e in new], ensure_ascii=False)
    ticket_replied, _, notif_templates = _notifications_contract()
    parsed = ticket_replied.model_validate(ev.payload)  # потребитель notifications примет событие как есть
    assert (str(parsed.user_id), parsed.number, str(parsed.message_id)) == (str(user), t["number"], message_id)
    assert "support.reply" in notif_templates
    # повторная доставка ответа с тем же Idempotency-Key не порождает второго уведомления
    key = "reply-" + uuid.uuid4().hex
    for _ in range(2):
        again = await env.client.post(f"/admin/v1/support/tickets/{ref}/messages",
                                      json={"text": "Ещё один ответ", "visibility": "public"},
                                      headers=env.staff(idem=key))
        assert again.status_code == 200
    assert len(await env.events("support.ticket.replied.v1")) == 2


# ---------------------------------------------------------------- AT-25: internal


async def test_internal_note_is_never_visible_to_learner(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user, category="CHILD_PROFILE")
    ref = t["ticket_id"]
    marker = "ВНУТРЕННЕЕ-" + uuid.uuid4().hex
    await env.flush()
    before = len(env.bus.published)
    # заметки на разных этапах: новое, в работе, ждём ученика, после ответа ученика
    assert (await env.reply(ref, marker + "-1", visibility="internal")).json()["status"] == "NEW"
    await env.client.post(f"/admin/v1/support/tickets/{ref}/take", headers=env.staff())
    assert (await env.reply(ref, marker + "-2", visibility="internal")).json()["status"] == "IN_PROGRESS"
    await env.reply(ref, "Публичный ответ")
    assert (await env.reply(ref, marker + "-3", visibility="internal")).json()["status"] == "WAITING_CUSTOMER"
    await env.client.post(f"/internal/v1/me/tickets/{ref}/messages", json={"text": "Спасибо"}, headers=env.user(user))
    staff = await env.reply(ref, marker + "-4", visibility="internal")
    assert [m["visibility"] for m in staff.json()["messages"]].count("internal") == 4

    # клиентский API: тред, список, повторное открытие, по номеру
    for path in (f"/internal/v1/me/tickets/{ref}", f"/internal/v1/me/tickets/{t['number']}", "/internal/v1/me/tickets"):
        r = await env.client.get(path, headers=env.user(user))
        assert r.status_code == 200 and marker not in r.text, path
    thread = (await env.client.get(f"/internal/v1/me/tickets/{ref}", headers=env.user(user))).json()
    assert [m["sender_type"] for m in thread["messages"]] == ["user", "operator", "user"]
    assert thread["unread_operator_replies"] == 0  # заметки не считаются непрочитанными ответами
    # ответ ученика тоже не раскрывает заметки
    sent = await env.client.post(f"/internal/v1/me/tickets/{ref}/messages", json={"text": "Ещё вопрос"},
                                 headers=env.user(user))
    assert marker not in sent.text
    # «Как видит клиент» (сотрудник) — без заметок
    view = await env.client.get(f"/admin/v1/support/tickets/{ref}/client-view", headers=env.staff(READER))
    assert view.status_code == 200 and marker not in view.text
    # события: ни одного support.ticket.replied.v1 / status.changed от заметок — notifications нечего отправить;
    # в аудите — только длина и id сообщения, без текста
    await env.flush()
    new = env.bus.published[before:]
    _, notif_support_events, _ = _notifications_contract()
    replied = [e for e in new if e.event_type == "support.ticket.replied.v1"]
    assert len(replied) == 1  # только публичный ответ
    public_id = next(m["message_id"] for m in staff.json()["messages"] if m["text"] == "Публичный ответ")
    assert replied[0].payload["message_id"] == public_id
    internal_ids = {m["message_id"] for m in staff.json()["messages"] if m["visibility"] == "internal"}
    for e in new:
        assert_event_conforms(e)
        if e.event_type in notif_support_events:
            assert e.payload.get("message_id") not in internal_ids
    audits = [e.payload for e in new if e.event_type == "admin.audit.recorded.v1"]
    notes = [a for a in audits if a["action"] == "ticket.note"]
    assert len(notes) == 4 and all(set(n["after"]) == {"number", "message_id", "length"} for n in notes)
    assert marker not in json.dumps([e.payload for e in env.bus.published], ensure_ascii=False)


async def test_no_reply_or_note_after_learner_deletion(env) -> None:
    """После удаления ученика обращение обезличено и закрыто системой: ни ответа (некому), ни заметки, ни событий."""
    user = uuid.uuid4()
    t = await env.create(user)
    await env.bus.publish(make_envelope("user.deletion.requested.v1",
                                        {"user_id": str(user), "request_id": str(uuid.uuid4()),
                                         "requested_at": datetime.now(UTC).isoformat()},
                                        producer="identity-consent"))
    await env.flush()
    before = len(env.bus.published)
    for visibility in ("public", "internal"):
        r = await env.reply(t["ticket_id"], "После удаления", visibility=visibility)
        assert r.status_code == 409 and r.json()["code"] == "SUPPORT_TICKET_CLOSED", visibility
    await env.flush()
    assert [e.event_type for e in env.bus.published[before:]] == []


def test_client_serializer_drops_internal_even_if_loaded() -> None:
    """Защита в глубину: сериализатор ученика отбрасывает internal, даже если выборка их вернула по ошибке."""
    from tilhero_support.models import Ticket

    now = datetime.now(UTC)
    ticket = Ticket(ticket_id=uuid.uuid4(), number=3000, user_id=uuid.uuid4(), channel="telegram", category="OTHER",
                    subject="Тема", status="IN_PROGRESS", priority="normal", context=None,
                    sla_first_response_at=now, sla_resolution_at=now, created_at=now, updated_at=now,
                    last_message_at=now, user_unread_operator_replies=0)
    msgs = [Message(message_id=uuid.uuid4(), ticket_id=ticket.ticket_id, sender_type=s, visibility=v, text=x,
                    author_name="Алина Петрова" if s == "operator" else None, created_at=now)
            for s, v, x in (("user", "public", "вопрос"), ("operator", "internal", "СЕКРЕТ"),
                            ("operator", "public", "ответ"))]
    out = svc.client_ticket(ticket, msgs, [])
    assert [m.text for m in out.messages] == ["вопрос", "ответ"]
    assert "СЕКРЕТ" not in out.model_dump_json()


# ---------------------------------------------------------------- шаблоны ответов


async def test_reply_templates_endpoint(env) -> None:
    r = await env.client.get(TEMPLATES, headers=env.staff(READER))
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert 6 <= len(items) <= 10
    for t in items:
        assert set(t) == {"id", "title", "text", "categories"}
        assert set(t["title"]) == {"ru", "en"} and set(t["text"]) == {"ru", "uz"}
    assert [t["id"] for t in items] == [t["id"] for t in REPLY_TEMPLATES]
    # оператор и руководитель поддержки видят те же шаблоны
    assert (await env.client.get(TEMPLATES, headers=env.staff(OPERATOR))).status_code == 200
    assert (await env.client.get(TEMPLATES, headers=env.staff(MANAGER))).json() == r.json()
    # шаблон можно отправить ответом как есть (вписывается в лимиты ответа)
    user = uuid.uuid4()
    ticket = await env.create(user, category="PERSONAL_DATA")
    sent = await env.reply(ticket["ticket_id"], items[5]["text"]["uz"])
    assert sent.status_code == 200, sent.text


async def test_reply_templates_auth(env) -> None:
    assert (await env.client.get(TEMPLATES)).status_code == 401
    for actor in (OUTSIDER, DASHBOARD, Actor(id="replier.01", role="x", permissions=frozenset({"support.reply"}))):
        denied = await env.client.get(TEMPLATES, headers=env.staff(actor))
        assert denied.status_code == 403 and denied.json()["details"] == {"permission": "support.read"}, actor.id
    no_actor = await env.client.get(TEMPLATES, headers=env.staff(None))
    assert no_actor.status_code == 403 and no_actor.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    foreign = await env.client.get(TEMPLATES, headers=env.staff(READER, issuer="telegram-bff"))
    assert foreign.status_code == 403 and foreign.json()["code"] == "CALLER_NOT_ALLOWED"
    learner = await env.client.get(TEMPLATES, headers=env.user(uuid.uuid4()))
    assert learner.status_code == 403
    wrong_aud = internal_headers(env.settings, issuer="admin-bff", actor=READER, audience="notifications")
    assert (await env.client.get(TEMPLATES, headers=wrong_aud)).status_code == 401


def _labels(path: Path) -> set[str]:
    return set(re.findall(r'^\s*"[\w.]+":\s*"(.+)",?\s*$', path.read_text(encoding="utf-8"), flags=re.M))


def test_reply_templates_content_rules() -> None:
    """Вежливо, коротко, без плейсхолдеров, сроков, сумм, давления и запросов кодов; UZ — латиница;
    категории TilHero."""
    ids = [t["id"] for t in REPLY_TEMPLATES]
    assert len(ids) == len(set(ids)) and all(re.fullmatch(r"tpl_[a-z_]{2,40}", i) for i in ids)
    available = {code for code, meta in CATEGORIES.items() if meta["available"]}
    covered: set[str] = set()
    ru_labels = _labels(REPO / "apps/telegram-miniapp/src/i18n/ru.ts")
    uz_labels = _labels(REPO / "apps/telegram-miniapp/src/i18n/uz.ts")
    deadline = re.compile(r"\d|\bчас(а|ов)?\b|\bминут|\bсутк|завтра|сегодня|рабоч|недел|\bсрок|\bсум\b|"
                          r"\bso[ʻ']m\b|\bsoat\b|daqiqa|kun ichida|ertaga|bugun|muddat|hafta", re.I)
    pressure = ("потеря", "потеряе", "провал", "сгорит", "последний шанс", "срочно", "yoʻqot", "muvaffaqiyatsiz")
    ask_codes = re.compile(r"(сообщите|пришлите|назовите|отправьте)\s+(нам\s+)?(pin|код)|kodni\s+(yuboring|ayting)\b",
                           re.I)
    for t in REPLY_TEMPLATES:
        title, text = t["title"], t["text"]
        assert isinstance(title, dict) and isinstance(text, dict)
        assert all(title[k].strip() and len(title[k]) <= 60 for k in ("ru", "en")), t["id"]
        cats = t["categories"]
        assert isinstance(cats, list) and cats and set(cats) <= available, t["id"]  # без SUBSCRIPTION_PAYMENT
        covered |= set(cats)
        for lang in ("ru", "uz"):
            body = text[lang]
            assert body.strip() and len(body) <= 600, (t["id"], lang)  # коротко
            assert not re.search(r"[{}<>]", body), (t["id"], lang)  # без плейсхолдеров и разметки
            assert not re.search(r"[\x00-\x09\x0b-\x1f\x7f]", body)
            assert not deadline.search(body), (t["id"], lang, deadline.search(body))  # без сроков и сумм
            assert not any(p in body.lower() for p in pressure), (t["id"], lang)
            assert not ask_codes.search(body), (t["id"], lang)
            labels = re.findall(r"«([^»]+)»", body)
            assert set(labels) <= (ru_labels if lang == "ru" else uz_labels), (t["id"], lang, labels)
        assert not CYRILLIC.search(text["uz"]) and CYRILLIC.search(text["ru"]), t["id"]
        assert "’" not in text["uz"] and "'" not in text["uz"], t["id"]  # узбекские oʻ/gʻ и ʼ — U+02BB/U+02BC
    # для каждой категории, по которой можно написать, есть хотя бы один шаблон, кроме общего «Вопрос решён»
    specific = set().union(*(set(t["categories"]) for t in REPLY_TEMPLATES if t["id"] != "tpl_resolved"))
    assert covered == available and specific == available


# ---------------------------------------------------------------- формы staff API (admin.ts)


async def test_staff_ticket_shape_matches_admin_contract(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user, context={"client_version": "telegram-miniapp-1.0"})
    staff = (await env.client.get(f"/admin/v1/support/tickets/{t['ticket_id']}", headers=env.staff())).json()
    # admin.ts StaffTicket.context: {deeplink: string | null, client_version}
    assert staff["context"] == {"deeplink": None, "client_version": "telegram-miniapp-1.0"}
    summary_keys = {"ticket_id", "number", "user_id", "channel", "category", "subject", "status", "priority",
                    "assignee_id", "has_context", "anonymized", "created_at", "updated_at", "last_message_at",
                    "first_response_at", "sla_first_response_at", "sla_resolution_at", "sla_target", "sla_due_at",
                    "sla_state", "sla_paused"}
    # assignee_name и learner добавляет admin-bff (имена сотрудников и сводка ученика из user-admin)
    assert set(staff) == summary_keys | {"context", "correlation_id", "resolved_at", "closed_at",
                                         "user_unread_operator_replies", "messages", "status_history", "escalations"}
    assert set(staff["messages"][0]) == {"message_id", "sender_type", "visibility", "author_id", "author_name", "text",
                                         "created_at"}
    assert set(staff["status_history"][0]) == {"from_status", "status", "at", "changed_by", "actor_id"}
    page = (await env.client.get("/admin/v1/support/tickets", headers=env.staff())).json()
    assert set(page) == {"items", "next_cursor"} and set(page["items"][0]) == summary_keys
    # клиент по-прежнему получает форму bff.ts (без deeplink при его отсутствии)
    client = (await env.client.get(f"/internal/v1/me/tickets/{t['ticket_id']}", headers=env.user(user))).json()
    assert client["context"] == {"client_version": "telegram-miniapp-1.0"}

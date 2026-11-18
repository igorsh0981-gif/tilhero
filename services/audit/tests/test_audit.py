"""audit-service TilHero: журнал с хеш-цепочкой. Писатели через шину — спринт 1 (INTERNAL_API §7: identity-consent,
learning-plan, social, experience-config, support, notifications) и спринт 2 (admin-identity); HTTP-писатели —
спринт 2: identity-consent (раскрытие Telegram ID, делегирование sensitive.view*) и admin-bff (только свои действия);
admin-identity — только через шину; чтение — admin-bff с правом audit.read."""

from __future__ import annotations

import itertools
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy import text

from tilhero_audit.api import routes
from tilhero_audit.consumers import AUDIT_EVENT_PRODUCERS, SECURITY_EVENT_PRODUCERS, on_security_event
from tilhero_audit.domain import GENESIS
from tilhero_audit.main import build_app
from tilhero_audit.schemas import RecordWriteIn
from tilhero_audit.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError
from tilhero_common.internal_auth import Actor, Principal, issue_token
from tilhero_common.messaging import Envelope, InMemoryBus, make_envelope
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    assert_event_conforms,
    create_schema,
    drop_schema,
    internal_headers,
    migrate,
    unique_schema,
)

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
AUDITOR = Actor(id="staff-7", role="auditor", permissions=frozenset({"audit.read"}))
SUPPORT = Actor(id="staff-8", role="support", permissions=frozenset({"support.reply"}))
SPRINT1_WRITERS = ("identity-consent", "learning-plan", "social", "experience-config", "support", "notifications")
BUS_WRITERS = (*SPRINT1_WRITERS, "admin-identity")
HTTP_WRITERS = ("identity-consent",)


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime, bus: InMemoryBus) -> None:
        self.settings, self.c, self.runtime, self.bus = settings, client, runtime, bus

    def read_headers(self, actor: Actor | None = AUDITOR, issuer: str = "admin-bff") -> dict[str, str]:
        return internal_headers(self.settings, issuer=issuer, actor=actor)

    async def records(self, query: str = "") -> list[dict[str, Any]]:
        r = await self.c.get(f"/admin/v1/audit/records?limit=100{query}", headers=self.read_headers())
        assert r.status_code == 200, r.text
        return r.json()["items"]

    def handler(self, durable: str):
        return next(s.handler for s in self.bus.specs if s.durable == durable)

    async def publish(self, event_type: str, payload: dict[str, Any], producer: str) -> Envelope:
        env = make_envelope(event_type, payload, producer=producer)
        await self.bus.publish(env)
        return env


@pytest.fixture
async def env():
    schema = unique_schema("audit")
    await create_schema(schema)
    settings = Settings(env="test", database_url=TEST_ADMIN_URL, db_schema=schema, internal_jwt_secret="t" * 40)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    app = build_app(settings, runtime)
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://audit")
        yield Env(settings, client, runtime, bus)
        await client.aclose()
    await drop_schema(schema)


def record(**kw: Any) -> dict[str, Any]:
    """Payload admin.audit.recorded.v1: актора определяет издатель (сотрудник из токена admin-bff, ученик, сервис)."""
    base: dict[str, Any] = {
        "record_id": str(uuid.uuid4()),
        "occurred_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "actor_type": "staff",
        "actor_id": "staff-1",
        "actor_role": "super_admin",
        "action": "release_note.publish",
        "object_type": "release_note",
        "object_id": str(uuid.uuid4()),
        "before": {"status": "draft"},
        "after": {"status": "published"},
        "reason": "Знакомство с приложением",
    }
    base.update(kw)
    return base


# Что пишет каждый сервис спринта 1 (примеры записей; сотрудник — только в командах админ-контура)
WRITER_RECORDS: dict[str, dict[str, Any]] = {
    "identity-consent": record(actor_type="user", actor_id=str(uuid.uuid4()), actor_role=None,
                               action="guardian_consent.granted", object_type="user", before=None, after=None,
                               reason=None),
    "learning-plan": record(actor_type="user", actor_id=str(uuid.uuid4()), actor_role=None,
                            action="plan.schedule_changed", object_type="plan", before={"days": [1, 3, 5]},
                            after={"days": [1, 2, 3, 4, 5]}, reason=None),
    "social": record(actor_type="user", actor_id=str(uuid.uuid4()), actor_role=None, action="invite.revoked",
                     object_type="invite", before=None, after={"status": "revoked"}, reason=None),
    "experience-config": record(action="config.publish", object_type="experience_config",
                                object_id="miniapp@1.0.1", before={"version": "1.0.0"}, after={"version": "1.0.1"},
                                reason="Тёмная тема"),
    "support": record(actor_id="support.01", actor_role="support", action="ticket.reply", object_type="ticket",
                      object_id=str(uuid.uuid4()), before=None, after={"visibility": "public"}, reason=None),
    "notifications": record(actor_type="service", actor_id="notifications", actor_role=None,
                            action="notification.campaign_stopped", object_type="campaign",
                            reason="Кампания остановлена"),
    # как domain/audit.py admin-identity: сотрудник — staff_id, email только маской/хешем
    "admin-identity": record(actor_id=str(uuid.uuid4()), actor_role="super_admin", action="staff.created",
                             object_type="staff", before=None,
                             after={"email": "s***@tilhero.test", "role": "support", "must_change_password": True},
                             reason=None, ip="10.0.0.1", session_id=None),
}


# ---------------------------------------------------------------- писатели через шину


def test_writer_lists() -> None:
    assert set(BUS_WRITERS) == AUDIT_EVENT_PRODUCERS
    assert SECURITY_EVENT_PRODUCERS == {"identity-consent"}
    assert routes.WRITERS == frozenset({*HTTP_WRITERS, "admin-bff"})
    assert routes.ONLY_ACTIONS == {"admin-bff": frozenset({"dev.impersonate", "auth.logout"})}
    assert routes.DELEGATION == {"identity-consent": frozenset({"sensitive.view", "sensitive.view_rate_limited"})}


async def test_bus_writers_append_hash_chain_exactly_once(env) -> None:
    for producer in BUS_WRITERS:
        ev = make_envelope("admin.audit.recorded.v1", WRITER_RECORDS[producer], producer=producer)
        assert_event_conforms(ev)
        await env.bus.publish(ev)
        await env.handler("audit.admin_records")(ev)  # повторная доставка того же события — inbox
    items = await env.records()
    assert sorted(i["source"] for i in items) == sorted(BUS_WRITERS)
    by_source = {i["source"]: i for i in items}
    for producer, rec in WRITER_RECORDS.items():
        got = by_source[producer]
        assert (got["record_id"], got["action"], got["actor_type"], got["actor_id"], got["actor_role"]) == (
            rec["record_id"], rec["action"], rec["actor_type"], rec["actor_id"], rec["actor_role"]), producer
        assert (got["before"], got["after"], got["reason"]) == (rec["before"], rec["after"], rec["reason"])
        assert (got["object_type"], got["ip"]) == (rec["object_type"], rec.get("ip"))
    # цепочка: каждая запись ссылается на хеш предыдущей
    chain = sorted(items, key=lambda i: i["seq"])
    assert chain[0]["prev_hash"] == GENESIS
    for prev, cur in itertools.pairwise(chain):
        assert cur["prev_hash"] == prev["hash"] and len(cur["hash"]) == 64
    # тот же record_id в новом событии (другой event_id, мимо inbox) — запись не дублируется
    again = make_envelope("admin.audit.recorded.v1", {**WRITER_RECORDS["support"], "action": "ticket.close"},
                          producer="support")
    await env.bus.publish(again)
    assert len(await env.records()) == len(BUS_WRITERS)
    verify = await env.c.get("/admin/v1/audit/verify", headers=env.read_headers())
    assert verify.json() == {"valid": True, "checked": 7, "first_seq": chain[0]["seq"],
                             "last_seq": chain[-1]["seq"], "broken_at_seq": None}


async def test_events_from_unknown_producers_are_ignored(env) -> None:
    for producer in ("telegram-bff", "telegram-bot-gateway", "admin-bff", "user-admin", "watch", "news",
                     "provider-gateway"):
        await env.publish("admin.audit.recorded.v1", record(action="config.publish"), producer)
    # события безопасности — только от identity-consent
    for producer in ("support", "learning-plan", "social"):
        await env.publish("consent.revoked.v1", {"user_id": str(uuid.uuid4()), "consent_id": str(uuid.uuid4())},
                          producer)
        await env.publish("user.deletion.requested.v1",
                          {"user_id": str(uuid.uuid4()), "request_id": str(uuid.uuid4()),
                           "requested_at": "2026-11-18T09:00:00Z"}, producer)
    await env.publish("admin.audit.recorded.v1", record(action="invite.revoked"), "social")
    assert [i["action"] for i in await env.records()] == ["invite.revoked"]
    assert env.bus.dlq == []


async def test_malformed_record_from_trusted_writer_goes_to_dlq(env) -> None:
    """Запись с актором вне перечня или полем сверх схемы журнала не пишется: обработчик падает → повтор → DLQ."""
    for bad in (record(actor_type="god"), record(action="Bad Action"), {**record(), "hash": "0" * 64}):
        await env.publish("admin.audit.recorded.v1", bad, "experience-config")
    assert await env.records() == []
    assert [d for d, _ in env.bus.dlq] == ["audit.admin_records"] * 3


async def test_security_events_from_identity_consent(env) -> None:
    user, request = str(uuid.uuid4()), str(uuid.uuid4())
    payloads: list[tuple[str, dict[str, Any]]] = [
        ("consent.accepted.v1", {"user_id": user, "consent_id": str(uuid.uuid4()), "policy_version": "1.0",
                                 "purposes": ["terms", "privacy", "learning"], "age_band": "14-17"}),
        ("consent.revoked.v1", {"user_id": user, "consent_id": str(uuid.uuid4()), "policy_version": "1.0"}),
        ("user.status.changed.v1", {"user_id": user, "status": "DISABLED", "previous_status": "ACTIVE",
                                    "reason_code": "user_request"}),
        ("user.security.changed.v1", {"user_id": user, "change": "pin_set"}),
        ("user.deletion.requested.v1", {"user_id": user, "request_id": request,
                                        "requested_at": "2026-11-18T09:00:00Z", "attempt": 1}),
    ]
    for event_type, payload in payloads:
        ev = make_envelope(event_type, payload, producer="identity-consent")
        assert_event_conforms(ev)
        await env.bus.publish(ev)
    # повторы рассылки сагой (attempt > 1) — не новый запрос пользователя
    for n in (2, 3):
        await env.publish("user.deletion.requested.v1", {"user_id": user, "request_id": request,
                                                         "requested_at": "2026-11-18T09:00:00Z", "attempt": n},
                          "identity-consent")
    items = {i["action"]: i for i in await env.records()}
    assert sorted(items) == ["consent.accept", "consent.revoke", "user.deletion_request", "user.security_change",
                             "user.status_change"]
    for i in items.values():
        assert (i["actor_type"], i["actor_id"], i["object_id"], i["source"]) == ("user", user, user,
                                                                                "identity-consent")
    assert items["consent.accept"]["after"] == {"policy_version": "1.0", "purposes": ["terms", "privacy", "learning"]}
    assert "age_band" not in items["consent.accept"]["after"]  # возраст — только в identity-consent
    assert items["user.deletion_request"]["after"] == {"request_id": request}
    assert items["user.status_change"]["after"] == {"status": "DISABLED", "reason_code": "user_request"}
    assert items["user.security_change"]["after"] == {"change": "pin_set"}


async def test_security_record_id_is_deterministic(env) -> None:
    """record_id = uuid5(event_id): даже доставка мимо inbox не создаёт второй записи."""
    ev = make_envelope("user.security.changed.v1", {"user_id": str(uuid.uuid4()), "change": "pin_removed"},
                       producer="identity-consent")
    for _ in range(2):
        async with env.runtime.transaction() as session:
            await on_security_event(session, ev)
    items = await env.records()
    assert len(items) == 1 and items[0]["record_id"] == str(uuid.uuid5(uuid.NAMESPACE_URL, f"tilhero:{ev.event_id}"))


def test_consumed_event_contracts() -> None:
    import jsonschema

    assert_event_conforms(make_envelope("admin.audit.recorded.v1", record(), producer="experience-config"))
    with pytest.raises(jsonschema.ValidationError):
        assert_event_conforms(make_envelope("admin.audit.recorded.v1", record(actor_type="god"), producer="x"))
    with pytest.raises(jsonschema.ValidationError):
        assert_event_conforms(make_envelope("consent.accepted.v1", {"user_id": "nope"}, producer="x"))


# ---------------------------------------------------------------- HTTP-писатели (спринт 2)


def _http_body(**kw: Any) -> dict[str, Any]:
    body = record(**kw)
    for key in ("actor_type", "actor_id", "actor_role"):
        body.pop(key)
    return body


async def test_http_writers_accepted_others_forbidden(env) -> None:
    body = _http_body()
    missing = await env.c.post("/internal/v1/records", json=body)
    assert missing.status_code == 401 and missing.json()["code"] == "INTERNAL_TOKEN_MISSING"
    forged = issue_token("x" * 40, issuer="identity-consent", audience="audit")
    bad = await env.c.post("/internal/v1/records", json=body, headers={"x-internal-token": forged})
    assert bad.status_code == 401 and bad.json()["code"] == "INTERNAL_TOKEN_INVALID"
    # писатель спринта 2: запись от имени сервиса (актор — только из токена), повтор record_id идемпотентен
    written: dict[str, dict[str, Any]] = {}
    for issuer in HTTP_WRITERS:
        b = _http_body(action="sensitive.view", object_type="learner")
        h = internal_headers(env.settings, issuer=issuer)
        r = await env.c.post("/internal/v1/records", json=b, headers=h)
        assert r.status_code == 201, (issuer, r.text)
        got = r.json()
        assert (got["source"], got["actor_type"], got["actor_id"], got["actor_role"]) == (
            issuer, "service", issuer, None)
        assert (got["record_id"], got["action"], got["reason"]) == (b["record_id"], b["action"], b["reason"])
        again = await env.c.post("/internal/v1/records", json=b, headers=h)
        assert again.status_code == 201 and again.json()["seq"] == got["seq"]
        written[issuer] = got
    # все прочие сервисы — 403 до разбора тела (невалидное тело не раскрывает схему); admin-identity — только шина
    others = (*(w for w in BUS_WRITERS if w not in HTTP_WRITERS), "user-admin", "telegram-bff",
              "telegram-bot-gateway")
    assert "admin-identity" in others
    for issuer in others:
        h = internal_headers(env.settings, issuer=issuer)
        r = await env.c.post("/internal/v1/records", json=_http_body(), headers=h)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
        r = await env.c.post("/internal/v1/records", json={"x": 1}, headers=h)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    # admin-bff — только свои действия (dev.impersonate, auth.logout) и только с actor сотрудника
    bff_other = await env.c.post("/internal/v1/records", json=_http_body(action="config.publish"),
                                 headers=internal_headers(env.settings, issuer="admin-bff", actor=SUPPORT))
    assert bff_other.status_code == 403 and bff_other.json()["code"] == "ACTION_NOT_ALLOWED"
    bff_no_actor = await env.c.post("/internal/v1/records", json=_http_body(action="auth.logout"),
                                    headers=internal_headers(env.settings, issuer="admin-bff"))
    assert bff_no_actor.status_code == 403 and bff_no_actor.json()["code"] == "ACTION_NOT_ALLOWED"
    # писатель с невалидным телом или актором в теле — 422
    h = internal_headers(env.settings, issuer="identity-consent")
    for invalid in ({"x": 1}, {**_http_body(), "actor_type": "staff"}, {**_http_body(), "actor_id": "root"},
                    _http_body(action="Bad Action")):
        assert (await env.c.post("/internal/v1/records", json=invalid, headers=h)).status_code == 422
    # чужой record_id (запись admin-identity через шину): не перезаписывается и не читается HTTP-писателем
    foreign = WRITER_RECORDS["admin-identity"]
    await env.publish("admin.audit.recorded.v1", foreign, "admin-identity")
    stolen = {**_http_body(), "record_id": foreign["record_id"]}
    r = await env.c.post("/internal/v1/records", json=stolen,
                         headers=internal_headers(env.settings, issuer="identity-consent"))
    assert r.status_code == 409 and r.json()["code"] == "AUDIT_RECORD_CONFLICT"
    assert "staff.created" not in r.text and foreign["actor_id"] not in r.text
    items = await env.records()
    assert sorted(i["source"] for i in items) == sorted([*HTTP_WRITERS, "admin-identity"])
    assert written["identity-consent"]["record_id"] in {i["record_id"] for i in items}
    bff = await env.c.post("/internal/v1/records", json=_http_body(action="auth.logout", object_type="staff"),
                           headers=internal_headers(env.settings, issuer="admin-bff", actor=SUPPORT))
    assert bff.status_code == 201, bff.text
    got = bff.json()
    assert (got["source"], got["actor_type"], got["actor_id"]) == ("admin-bff", "staff", SUPPORT.id)


async def test_identity_consent_reveal_delegation(env) -> None:
    """identity-consent пишет раскрытие Telegram ID синхронно от имени сотрудника (claim actor ему передал
    admin-bff): on_behalf_of — только для sensitive.view*, только у identity-consent и без sub/actor в токене."""
    ic = internal_headers(env.settings, issuer="identity-consent")
    learner = str(uuid.uuid4())
    staff = {"actor_id": str(uuid.uuid4()), "actor_role": "super_admin"}
    for action in ("sensitive.view", "sensitive.view_rate_limited"):
        b = _http_body(action=action, object_type="learner", object_id=learner, before=None,
                       after={"field": "telegram_user_id"}, reason="Проверка обращения TCK-0042")
        r = await env.c.post("/internal/v1/records", json={**b, "on_behalf_of": staff}, headers=ic)
        assert r.status_code == 201, r.text
        got = r.json()
        assert (got["actor_type"], got["actor_id"], got["actor_role"], got["source"]) == (
            "staff", staff["actor_id"], "super_admin", "identity-consent")
        assert got["after"] == {"field": "telegram_user_id"}  # значение Telegram ID в журнал не попадает
    r = await env.c.post("/internal/v1/records", json={**_http_body(action="consent.revoke"), "on_behalf_of": staff},
                         headers=ic)  # действие вне списка делегирования
    assert r.status_code == 403 and r.json()["code"] == "DELEGATION_NOT_ALLOWED"
    for issuer in ("admin-identity", "support"):  # не HTTP-писатели — отказ до разбора делегирования
        r = await env.c.post("/internal/v1/records",
                             json={**_http_body(action="sensitive.view"), "on_behalf_of": staff},
                             headers=internal_headers(env.settings, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    with_sub = internal_headers(env.settings, issuer="identity-consent", subject=learner)
    r = await env.c.post("/internal/v1/records",
                         json={**_http_body(action="sensitive.view"), "on_behalf_of": staff}, headers=with_sub)
    assert r.status_code == 403 and r.json()["code"] == "DELEGATION_NOT_ALLOWED"
    bad_staff = await env.c.post("/internal/v1/records",
                                 json={**_http_body(action="sensitive.view"),
                                       "on_behalf_of": {"actor_id": "x", "actor_role": "Super Admin"}}, headers=ic)
    assert bad_staff.status_code == 422
    assert [i["action"] for i in await env.records()] == ["sensitive.view_rate_limited", "sensitive.view"]


def _principal(issuer: str, subject: str | None = None, actor: Actor | None = None) -> Principal:
    return Principal(issuer=issuer, subject=subject, actor=actor, claims={})


def _write_body(**kw: Any) -> RecordWriteIn:
    body = record(**kw)
    for key in ("actor_type", "actor_id", "actor_role"):
        body.pop(key)
    return RecordWriteIn.model_validate(body)


def test_actor_comes_only_from_token(monkeypatch) -> None:
    """Правило HTTP-писателей: актор — только из токена; делегирование — по списку издатель → действия."""
    assert routes.actor_from_token(_principal("admin-bff", actor=SUPPORT)) == {
        "actor_type": "staff", "actor_id": "staff-8", "actor_role": "support"}
    user = str(uuid.uuid4())
    assert routes.actor_from_token(_principal("learning-plan", subject=user)) == {
        "actor_type": "user", "actor_id": user, "actor_role": None}
    assert routes.actor_from_token(_principal("notifications")) == {
        "actor_type": "service", "actor_id": "notifications", "actor_role": None}
    # тело не может назначить актора: поля actor_* запрещены
    for field, value in (("actor_type", "staff"), ("actor_id", "super.admin"), ("actor_role", "super_admin")):
        with pytest.raises(ValidationError):
            RecordWriteIn.model_validate({**_write_body().model_dump(mode="json"), field: value})
    delegated = _write_body(on_behalf_of={"actor_id": "staff-9", "actor_role": "support"})
    with pytest.raises(ApiError) as e:  # release_note.publish не делегирован никому
        routes.actor_from_token(_principal("identity-consent"), delegated)
    assert (e.value.status, e.value.code) == (403, "DELEGATION_NOT_ALLOWED")
    monkeypatch.setitem(routes.DELEGATION, "identity-consent", frozenset({"release_note.publish"}))
    assert routes.actor_from_token(_principal("identity-consent"), delegated) == {
        "actor_type": "staff", "actor_id": "staff-9", "actor_role": "support"}
    for principal in (_principal("identity-consent", subject=user), _principal("support")):
        with pytest.raises(ApiError):
            routes.actor_from_token(principal, delegated)
    with pytest.raises(ValidationError):
        _write_body(on_behalf_of={"actor_id": "x", "actor_role": "Super Admin"})


# ---------------------------------------------------------------- чтение (admin-bff, audit.read)


async def test_read_requires_admin_bff_and_permission(env) -> None:
    rec = record()
    await env.publish("admin.audit.recorded.v1", rec, "experience-config")
    ok = await env.c.get("/admin/v1/audit/records", headers=env.read_headers())
    assert ok.status_code == 200 and len(ok.json()["items"]) == 1 and ok.json()["next_cursor"] is None
    one = await env.c.get(f"/admin/v1/audit/records/{rec['record_id']}", headers=env.read_headers())
    assert one.status_code == 200 and one.json()["action"] == "release_note.publish"
    assert one.json()["recorded_at"] and one.json()["source"] == "experience-config"
    for path in ("/admin/v1/audit/records", f"/admin/v1/audit/records/{rec['record_id']}", "/admin/v1/audit/verify"):
        assert (await env.c.get(path)).status_code == 401
        denied = await env.c.get(path, headers=env.read_headers(SUPPORT))
        assert denied.status_code == 403 and denied.json()["details"]["permission"] == "audit.read"
        no_staff = await env.c.get(path, headers=env.read_headers(None))
        assert no_staff.status_code == 403 and no_staff.json()["code"] == "STAFF_CONTEXT_REQUIRED"
        for issuer in ("telegram-bff", "experience-config"):  # писатели журнал не читают
            other = await env.c.get(path, headers=internal_headers(env.settings, issuer=issuer))
            assert other.status_code == 403 and other.json()["code"] == "CALLER_NOT_ALLOWED"
    missing = await env.c.get(f"/admin/v1/audit/records/{uuid.uuid4()}", headers=env.read_headers())
    assert missing.status_code == 404 and missing.json()["code"] == "AUDIT_RECORD_NOT_FOUND"
    assert (await env.c.get("/admin/v1/audit/records/not-a-uuid", headers=env.read_headers())).status_code == 422


async def test_pagination_and_filters(env) -> None:
    actor_user = str(uuid.uuid4())
    base = datetime(2026, 11, 18, 9, 0, tzinfo=UTC)
    for i in range(5):
        await env.publish("admin.audit.recorded.v1",
                          record(action="ticket.reply" if i % 2 else "config.publish", object_id=f"obj-{i}",
                                 actor_id=actor_user if i == 4 else "staff-1",
                                 occurred_at=(base + timedelta(hours=i)).isoformat()),
                          "support" if i % 2 else "experience-config")
    h = env.read_headers()
    page1 = (await env.c.get("/admin/v1/audit/records?limit=2", headers=h)).json()
    page2 = (await env.c.get(f"/admin/v1/audit/records?limit=2&cursor={page1['next_cursor']}", headers=h)).json()
    page3 = (await env.c.get(f"/admin/v1/audit/records?limit=2&cursor={page2['next_cursor']}", headers=h)).json()
    seqs = [i["seq"] for i in page1["items"] + page2["items"] + page3["items"]]
    assert seqs == sorted(seqs, reverse=True) and len(set(seqs)) == 5 and page3["next_cursor"] is None
    assert {i["action"] for i in await env.records("&action=ticket.reply")} == {"ticket.reply"}
    assert [i["object_id"] for i in await env.records(f"&actor_id={actor_user}")] == ["obj-4"]
    assert [i["object_id"] for i in await env.records("&object_id=obj-2")] == ["obj-2"]
    await env.publish("admin.audit.recorded.v1", record(action="staff.created", object_type="staff", object_id="obj-5",
                                                        occurred_at=(base - timedelta(days=1)).isoformat()),
                      "admin-identity")
    assert [i["object_id"] for i in await env.records("&object_type=staff")] == ["obj-5"]
    assert len(await env.records("&object_type=release_note")) == 5
    assert (await env.c.get("/admin/v1/audit/records?object_type=" + "x" * 65, headers=h)).status_code == 422
    window = await env.records("&date_from=2026-11-18T10:00:00Z&date_to=2026-11-18T12:00:00Z")
    assert sorted(i["object_id"] for i in window) == ["obj-1", "obj-2", "obj-3"]
    bad = await env.c.get("/admin/v1/audit/records?cursor=@@", headers=h)
    assert bad.status_code == 400 and bad.json()["code"] == "INVALID_CURSOR"
    for limit in (0, 101):
        assert (await env.c.get(f"/admin/v1/audit/records?limit={limit}", headers=h)).status_code == 422


async def test_append_only_and_chain_verification(env) -> None:
    for _ in range(3):
        await env.publish("admin.audit.recorded.v1", record(), "experience-config")
    h = env.read_headers()
    assert (await env.c.get("/admin/v1/audit/verify", headers=h)).json() == {
        "valid": True, "checked": 3, "first_seq": 1, "last_seq": 3, "broken_at_seq": None}
    with pytest.raises(Exception, match="append-only"):
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE audit_records SET reason = 'tampered' WHERE seq = 2"))
    with pytest.raises(Exception, match="append-only"):
        async with env.runtime.transaction() as s:
            await s.execute(text("DELETE FROM audit_records"))
    # Даже суперпользователь, отключивший триггер, будет пойман проверкой цепочки
    async with env.runtime.transaction() as s:
        await s.execute(text("ALTER TABLE audit_records DISABLE TRIGGER audit_records_no_update"))
        await s.execute(text("UPDATE audit_records SET reason = 'tampered' WHERE seq = 2"))
        await s.execute(text("ALTER TABLE audit_records ENABLE TRIGGER audit_records_no_update"))
    v = (await env.c.get("/admin/v1/audit/verify", headers=h)).json()
    assert v["valid"] is False and v["broken_at_seq"] == 2


async def test_runtime_role_cannot_tamper_with_journal() -> None:
    """Миграции — под ролью-владельцем, сервис — под своей ролью (bootstrap.sql): запись и чтение работают,
    UPDATE/DELETE/TRUNCATE и снятие триггера — нет (нет прав, роль не владелец)."""
    import asyncpg

    from tilhero_audit.models import Base
    from tilhero_common.messaging import messaging_metadata
    from tilhero_common.testing import create_service_roles, drop_service_roles, schema_drift

    schema = unique_schema("audit_roles")
    roles = await create_service_roles(schema)
    try:
        settings = Settings(env="test", database_url=roles.runtime_url, migration_database_url=roles.owner_url,
                            db_schema=schema, internal_jwt_secret="t" * 40)
        await migrate(SERVICE_DIR, settings)
        assert await schema_drift(roles.runtime_url, schema, [Base.metadata, messaging_metadata]) == []
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://audit") as c:
                for producer in ("support", "experience-config"):
                    await bus.publish(make_envelope("admin.audit.recorded.v1", record(), producer=producer))
                read = internal_headers(settings, issuer="admin-bff", actor=AUDITOR)
                assert (await c.get("/admin/v1/audit/verify", headers=read)).json()["valid"] is True
                assert (await c.get("/health/ready")).status_code == 200
        conn = await asyncpg.connect(roles.runtime_url.replace("postgresql+asyncpg", "postgresql"))
        try:
            await conn.execute(f'SET search_path = "{schema}"')
            for stmt in (
                "UPDATE audit_records SET reason = 'tampered'",
                "DELETE FROM audit_records",
                "TRUNCATE audit_records",
                "ALTER TABLE audit_records DISABLE TRIGGER audit_records_no_update",
                "DROP TRIGGER audit_records_no_update ON audit_records",
                "ALTER TABLE audit_records OWNER TO CURRENT_USER",
                "CREATE TABLE shadow (id int)",
            ):
                with pytest.raises(asyncpg.InsufficientPrivilegeError):
                    await conn.execute(stmt)
            assert await conn.fetchval("SELECT count(*) FROM audit_records") == 2
        finally:
            await conn.close()
    finally:
        await drop_service_roles(roles)

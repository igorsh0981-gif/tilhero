from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from sqlalchemy import text

from tilhero_audit.main import build_app
from tilhero_audit.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import InMemoryBus, make_envelope
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    create_schema,
    drop_schema,
    internal_headers,
    migrate,
    unique_schema,
)

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
AUDITOR = Actor(id="staff-7", role="auditor", permissions=frozenset({"audit.read"}))
SUPPORT = Actor(id="staff-8", role="support", permissions=frozenset({"support.reply"}))


@pytest.fixture
async def env():
    schema = unique_schema("audit")
    await create_schema(schema)
    settings = Settings(env="test", database_url=TEST_ADMIN_URL, db_schema=schema,
                        internal_jwt_secret="t" * 40)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    app = build_app(settings, runtime)
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://audit")
        yield settings, client, runtime, bus
        await client.aclose()
    await drop_schema(schema)


ADMIN = Actor(id="staff-1", role="super_admin", permissions=frozenset())
ACTOR_FIELDS = ("actor_type", "actor_id", "actor_role")


def record(**kw):
    """HTTP-запись (без actor_*: актор — только из токена)."""
    base = {
        "record_id": str(uuid.uuid4()),
        "occurred_at": datetime.now(UTC).isoformat(),
        "action": "skill.publish",
        "object_type": "skill",
        "object_id": "watch.monitor.v7",
        "before": {"version": 6},
        "after": {"version": 7},
        "reason": "Порог шума 3%",
    }
    base.update(kw)
    return base


def event_record(**kw):
    """Payload admin.audit.recorded.v1: издатель сам кладёт актора из токена admin-bff."""
    return record(actor_type="staff", actor_id="staff-1", actor_role="super_admin", **kw)


async def test_write_is_idempotent_and_chained(env) -> None:
    settings, c, *_ = env
    h = internal_headers(settings, issuer="admin-bff", actor=ADMIN)
    r1 = await c.post("/internal/v1/records", json=(rec := record()), headers=h)
    assert r1.status_code == 201
    again = await c.post("/internal/v1/records", json=rec, headers=h)
    assert again.json()["seq"] == r1.json()["seq"]  # повтор не создаёт новую запись
    r2 = await c.post("/internal/v1/records", json=record(action="ticket.reply"), headers=h)
    assert r2.json()["prev_hash"] == r1.json()["hash"]
    assert r1.json()["prev_hash"] == "0" * 64 and r1.json()["source"] == "admin-bff"


async def test_requires_internal_token_and_validates(env) -> None:
    settings, c, *_ = env
    assert (await c.post("/internal/v1/records", json=record())).status_code == 401
    bad = await c.post("/internal/v1/records", json=record(action="Bad Action"),
                       headers=internal_headers(settings, issuer="support"))
    assert bad.status_code == 422 and bad.json()["code"] == "VALIDATION_ERROR"
    extra = await c.post("/internal/v1/records", json={**record(), "hash": "x"},
                         headers=internal_headers(settings, issuer="support"))
    assert extra.status_code == 422


async def test_read_requires_admin_bff_and_permission(env) -> None:
    settings, c, *_ = env
    await c.post("/internal/v1/records", json=record(), headers=internal_headers(settings, issuer="admin-bff"))
    ok = await c.get("/admin/v1/audit/records", headers=internal_headers(settings, issuer="admin-bff", actor=AUDITOR))
    assert ok.status_code == 200 and len(ok.json()["items"]) == 1
    denied = await c.get("/admin/v1/audit/records",
                         headers=internal_headers(settings, issuer="admin-bff", actor=SUPPORT))
    assert denied.status_code == 403 and denied.json()["details"]["permission"] == "audit.read"
    wrong_caller = await c.get("/admin/v1/audit/records",
                               headers=internal_headers(settings, issuer="telegram-bff", actor=AUDITOR))
    assert wrong_caller.status_code == 403
    missing = await c.get(f"/admin/v1/audit/records/{uuid.uuid4()}",
                          headers=internal_headers(settings, issuer="admin-bff", actor=AUDITOR))
    assert missing.status_code == 404 and missing.json()["code"] == "AUDIT_RECORD_NOT_FOUND"


async def test_pagination_and_filters(env) -> None:
    settings, c, *_ = env
    h = internal_headers(settings, issuer="admin-bff")
    for i in range(5):
        await c.post("/internal/v1/records", json=record(action="ticket.reply" if i % 2 else "skill.publish"),
                     headers=h)
    read = internal_headers(settings, issuer="admin-bff", actor=AUDITOR)
    page1 = (await c.get("/admin/v1/audit/records?limit=2", headers=read)).json()
    page2 = (await c.get(f"/admin/v1/audit/records?limit=2&cursor={page1['next_cursor']}", headers=read)).json()
    assert len(page1["items"]) == 2 and len(page2["items"]) == 2
    assert page1["items"][-1]["seq"] > page2["items"][0]["seq"]
    only = (await c.get("/admin/v1/audit/records?action=ticket.reply", headers=read)).json()
    assert {i["action"] for i in only["items"]} == {"ticket.reply"}


async def test_append_only_and_chain_verification(env) -> None:
    settings, c, runtime, _ = env
    h = internal_headers(settings, issuer="admin-bff")
    for _ in range(3):
        await c.post("/internal/v1/records", json=record(), headers=h)
    read = internal_headers(settings, issuer="admin-bff", actor=AUDITOR)
    assert (await c.get("/admin/v1/audit/verify", headers=read)).json() == {
        "valid": True, "checked": 3, "first_seq": 1, "last_seq": 3, "broken_at_seq": None}
    with pytest.raises(Exception, match="append-only"):
        async with runtime.transaction() as s:
            await s.execute(text("UPDATE audit_records SET reason = 'tampered' WHERE seq = 2"))
    with pytest.raises(Exception, match="append-only"):
        async with runtime.transaction() as s:
            await s.execute(text("DELETE FROM audit_records"))
    # Даже суперпользователь, отключивший триггер, будет пойман проверкой цепочки
    async with runtime.transaction() as s:
        await s.execute(text("ALTER TABLE audit_records DISABLE TRIGGER audit_records_no_update"))
        await s.execute(text("UPDATE audit_records SET reason = 'tampered' WHERE seq = 2"))
        await s.execute(text("ALTER TABLE audit_records ENABLE TRIGGER audit_records_no_update"))
    v = (await c.get("/admin/v1/audit/verify", headers=read)).json()
    assert v["valid"] is False and v["broken_at_seq"] == 2


async def test_consumes_security_and_admin_events_once(env) -> None:
    settings, c, runtime, bus = env
    consent = make_envelope("consent.accepted.v1",
                            {"user_id": "11111111-1111-1111-1111-111111111111", "policy_version": "1.0",
                             "purposes": ["personalization"]}, producer="identity-consent")
    await bus.publish(consent)
    await runtime.bus.publish(consent)  # повтор той же доставки
    admin = make_envelope("admin.audit.recorded.v1", event_record(action="ops.kill_switch"), producer="admin-bff")
    await bus.publish(admin)
    read = internal_headers(settings, issuer="admin-bff", actor=AUDITOR)
    items = (await c.get("/admin/v1/audit/records", headers=read)).json()["items"]
    assert sorted(i["action"] for i in items) == ["consent.accept", "ops.kill_switch"]
    consent_rec = next(i for i in items if i["action"] == "consent.accept")
    assert consent_rec["actor_type"] == "user" and consent_rec["after"]["policy_version"] == "1.0"
    assert consent_rec["source"] == "identity-consent"


def test_consumed_event_contracts() -> None:
    from tilhero_common.testing import assert_event_conforms

    assert_event_conforms(make_envelope("consent.accepted.v1",
                                        {"user_id": str(uuid.uuid4()), "consent_id": str(uuid.uuid4()),
                                         "policy_version": "1.0", "purposes": ["personalization"]},
                                        producer="identity-consent"))
    assert_event_conforms(make_envelope("admin.audit.recorded.v1", event_record(), producer="admin-bff"))
    import jsonschema

    with pytest.raises(jsonschema.ValidationError):
        assert_event_conforms(make_envelope("consent.accepted.v1", {"user_id": "nope"}, producer="x"))


# ---------------------------------------------------------------- ревью спринта 1, P4

async def test_actor_comes_only_from_token(env) -> None:
    settings, c, *_ = env
    staff = await c.post("/internal/v1/records", json=record(),
                         headers=internal_headers(settings, issuer="admin-bff", actor=SUPPORT))
    assert staff.status_code == 201
    assert (staff.json()["actor_type"], staff.json()["actor_id"], staff.json()["actor_role"]) == (
        "staff", "staff-8", "support")
    service = await c.post("/internal/v1/records", json=record(action="ticket.escalate"),
                           headers=internal_headers(settings, issuer="support"))
    assert service.status_code == 201
    assert (service.json()["actor_type"], service.json()["actor_id"], service.json()["actor_role"]) == (
        "service", "support", None)
    # тело не может назначить актора: поля actor_* запрещены
    for field, value in zip(ACTOR_FIELDS, ("staff", "super.admin", "super_admin"), strict=True):
        forged = await c.post("/internal/v1/records", json={**record(), field: value},
                              headers=internal_headers(settings, issuer="support"))
        assert forged.status_code == 422, field


async def test_only_listed_writers(env) -> None:
    settings, c, *_ = env
    for issuer in ("telegram-bot-gateway", "notifications", "telegram-bff", "preferences"):
        r = await c.post("/internal/v1/records", json=record(), headers=internal_headers(settings, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    # actor от сервиса, кроме admin-bff, не принимается вовсе (internal_auth)
    r = await c.post("/internal/v1/records", json=record(),
                     headers=internal_headers(settings, issuer="support", actor=SUPPORT))
    assert r.status_code == 403 and r.json()["code"] == "ACTOR_NOT_ALLOWED"


async def test_events_from_unknown_producers_are_ignored(env) -> None:
    settings, c, _, bus = env
    await bus.publish(make_envelope("admin.audit.recorded.v1", event_record(action="ops.kill_switch"),
                                    producer="telegram-bot-gateway"))
    await bus.publish(make_envelope("consent.revoked.v1", {"user_id": str(uuid.uuid4())}, producer="support"))
    await bus.publish(make_envelope("admin.audit.recorded.v1", event_record(action="config.activate"),
                                    producer="experience-config"))
    read = internal_headers(settings, issuer="admin-bff", actor=AUDITOR)
    items = (await c.get("/admin/v1/audit/records", headers=read)).json()["items"]
    assert [i["action"] for i in items] == ["config.activate"]


async def test_runtime_role_cannot_tamper_with_journal() -> None:
    """Миграции — под ролью-владельцем, сервис — под своей ролью (bootstrap.sql): запись и чтение работают,
    UPDATE/DELETE/TRUNCATE и снятие триггера — нет (нет прав, роль не владелец)."""
    import asyncpg

    from tilhero_common.testing import create_service_roles, drop_service_roles, schema_drift

    schema = unique_schema("audit_roles")
    roles = await create_service_roles(schema)
    try:
        settings = Settings(env="test", database_url=roles.runtime_url, migration_database_url=roles.owner_url,
                            db_schema=schema, internal_jwt_secret="t" * 40)
        await migrate(SERVICE_DIR, settings)
        from tilhero_audit.models import Base
        from tilhero_common.messaging import messaging_metadata

        assert await schema_drift(roles.runtime_url, schema, [Base.metadata, messaging_metadata]) == []
        runtime = Runtime(settings, bus=InMemoryBus())
        app = build_app(settings, runtime)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://audit") as c:
                h = internal_headers(settings, issuer="admin-bff", actor=ADMIN)
                for _ in range(2):
                    assert (await c.post("/internal/v1/records", json=record(), headers=h)).status_code == 201
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


# ---------------------------------------------------------------- спринт 2: новые производители и писатели

async def test_sprint2_writers_admin_identity_and_user_admin(env) -> None:
    settings, c, *_ = env
    for issuer in ("admin-identity", "user-admin"):
        r = await c.post("/internal/v1/records", json=record(action="staff.created"),
                         headers=internal_headers(settings, issuer=issuer))
        assert r.status_code == 201, (issuer, r.text)
        assert (r.json()["source"], r.json()["actor_type"], r.json()["actor_id"]) == (issuer, "service", issuer)


async def test_sprint2_admin_audit_events_from_new_producers(env) -> None:
    settings, c, _, bus = env
    for producer, action in (("admin-identity", "auth.login"), ("user-admin", "users.export")):
        ev = make_envelope("admin.audit.recorded.v1", event_record(action=action), producer=producer)
        from tilhero_common.testing import assert_event_conforms

        assert_event_conforms(ev)
        await bus.publish(ev)
        await bus.publish(ev)  # повторная доставка — одна запись (inbox)
    read = internal_headers(settings, issuer="admin-bff", actor=AUDITOR)
    items = (await c.get("/admin/v1/audit/records", headers=read)).json()["items"]
    assert sorted((i["action"], i["source"]) for i in items) == [
        ("auth.login", "admin-identity"), ("users.export", "user-admin")]


async def test_delegated_actor_only_from_domain_writers(env) -> None:
    """Синхронная запись домена о команде сотрудника (reveal): сотрудник — в on_behalf_of."""
    settings, c, *_ = env
    body = record(action="sensitive.view", object_type="user", object_id=str(uuid.uuid4()),
                  before=None, after={"field": "telegram_user_id"}, reason="Проверка обращения TCK-3001",
                  on_behalf_of={"actor_id": "staff-9", "actor_role": "support"})
    ok = await c.post("/internal/v1/records", json=body, headers=internal_headers(settings, issuer="identity-consent"))
    assert ok.status_code == 201, ok.text
    assert (ok.json()["actor_type"], ok.json()["actor_id"], ok.json()["actor_role"], ok.json()["source"]) == (
        "staff", "staff-9", "support", "identity-consent")
    # admin-bff передаёт сотрудника только токеном
    denied = await c.post("/internal/v1/records", json={**body, "record_id": str(uuid.uuid4())},
                          headers=internal_headers(settings, issuer="admin-bff", actor=SUPPORT))
    assert denied.status_code == 403 and denied.json()["code"] == "DELEGATION_NOT_ALLOWED"
    # с контекстом пользователя (sub) делегирование не принимается
    with_sub = await c.post("/internal/v1/records", json={**body, "record_id": str(uuid.uuid4())},
                            headers=internal_headers(settings, issuer="support", subject=str(uuid.uuid4())))
    assert with_sub.status_code == 403
    # остальные доменные писатели не могут приписать запись сотруднику (ревью S2)
    for issuer in ("support", "experience-config", "admin-identity", "user-admin"):
        r = await c.post("/internal/v1/records", json={**body, "record_id": str(uuid.uuid4())},
                         headers=internal_headers(settings, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "DELEGATION_NOT_ALLOWED", issuer
    # identity-consent — только для записей о раскрытии чувствительных данных
    other_action = await c.post("/internal/v1/records",
                                json={**body, "record_id": str(uuid.uuid4()), "action": "staff.updated"},
                                headers=internal_headers(settings, issuer="identity-consent"))
    assert other_action.status_code == 403 and other_action.json()["code"] == "DELEGATION_NOT_ALLOWED"
    limited = await c.post("/internal/v1/records",
                           json={**body, "record_id": str(uuid.uuid4()), "action": "sensitive.view_rate_limited"},
                           headers=internal_headers(settings, issuer="identity-consent"))
    assert limited.status_code == 201 and limited.json()["actor_id"] == "staff-9"
    # без on_behalf_of домен пишет от своего имени
    own = await c.post("/internal/v1/records",
                       json={k: v for k, v in {**body, "record_id": str(uuid.uuid4())}.items() if k != "on_behalf_of"},
                       headers=internal_headers(settings, issuer="support"))
    assert own.status_code == 201 and (own.json()["actor_type"], own.json()["actor_id"]) == ("service", "support")
    # чужой сервис не может писать вовсе
    outsider = await c.post("/internal/v1/records", json={**body, "record_id": str(uuid.uuid4())},
                            headers=internal_headers(settings, issuer="telegram-bff"))
    assert outsider.status_code == 403 and outsider.json()["code"] == "CALLER_NOT_ALLOWED"
    # формат делегированного актора проверяется
    bad = await c.post("/internal/v1/records",
                       json={**body, "record_id": str(uuid.uuid4()),
                             "on_behalf_of": {"actor_id": "x", "actor_role": "Super Admin"}},
                       headers=internal_headers(settings, issuer="identity-consent"))
    assert bad.status_code == 422
    extra = await c.post("/internal/v1/records",
                         json={**body, "record_id": str(uuid.uuid4()),
                               "on_behalf_of": {"actor_id": "x", "actor_role": "support", "actor_type": "user"}},
                         headers=internal_headers(settings, issuer="identity-consent"))
    assert extra.status_code == 422


# ---------------------------------------------------------------- спринт 4: новые производители и писатели

async def test_sprint4_writers_events_source_registry_provider_gateway(env) -> None:
    """HTTP-писатель из спринта 4 — только provider-gateway; events и source-registry пишут аудит событием через
    outbox (AUDIT_EVENT_PRODUCERS), по HTTP — 403 CALLER_NOT_ALLOWED (минимальные права)."""
    settings, c, *_ = env
    r = await c.post("/internal/v1/records", json=record(action="ai.kill_switch.on", object_type="ai_web"),
                     headers=internal_headers(settings, issuer="provider-gateway"))
    assert r.status_code == 201, r.text
    assert (r.json()["source"], r.json()["actor_type"], r.json()["actor_id"]) == (
        "provider-gateway", "service", "provider-gateway")
    # kill switch AI-поиска: сотрудник через делегирование (только ai.kill_switch.*)
    delegated = await c.post("/internal/v1/records",
                             json=record(action="ai.kill_switch.off", on_behalf_of={"actor_id": "staff-1",
                                                                                    "actor_role": "operations"}),
                             headers=internal_headers(settings, issuer="provider-gateway"))
    assert delegated.status_code == 201, delegated.text
    assert (delegated.json()["actor_type"], delegated.json()["actor_id"]) == ("staff", "staff-1")
    for issuer, action in (("events", "review.accepted"), ("source-registry", "source.updated")):
        for body in (record(action=action),
                     record(action=action, on_behalf_of={"actor_id": "staff-1", "actor_role": "operations"})):
            denied = await c.post("/internal/v1/records", json=body, headers=internal_headers(settings, issuer=issuer))
            assert denied.status_code == 403 and denied.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    async with env[2].transaction() as session:
        written = (await session.execute(text(
            "SELECT count(*) FROM audit_records WHERE source IN ('events', 'source-registry')"))).scalar()
    assert written == 0
    # прочие сервисы спринтов 3–4 писать не могут
    for issuer in ("discovery", "verification"):
        r = await c.post("/internal/v1/records", json=record(), headers=internal_headers(settings, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer


async def test_sprint4_admin_audit_events_from_source_registry_and_events(env) -> None:
    from tilhero_common.testing import assert_event_conforms

    settings, c, _, bus = env
    for producer, action in (("source-registry", "source.disabled"), ("events", "review.rejected")):
        ev = make_envelope("admin.audit.recorded.v1",
                           {**event_record(action=action, object_type="source",
                                           before={"version": 1, "fields": {"enabled": True}},
                                           after={"slug": "kassir-kz", "changed_fields": ["enabled"]}),
                            "actor_id": "staff-ops", "actor_role": "operations"},
                           producer=producer)
        assert_event_conforms(ev)
        await bus.publish(ev)
        await bus.publish(ev)  # повторная доставка — одна запись (inbox)
    # provider-gateway публикует аудит не событием (нет outbox), а HTTP — событие от него игнорируется
    await bus.publish(make_envelope("admin.audit.recorded.v1", event_record(action="ai.kill_switch.on"),
                                    producer="provider-gateway"))
    read = internal_headers(settings, issuer="admin-bff", actor=AUDITOR)
    items = (await c.get("/admin/v1/audit/records", headers=read)).json()["items"]
    assert sorted((i["action"], i["source"], i["actor_type"], i["actor_id"]) for i in items) == [
        ("review.rejected", "events", "staff", "staff-ops"),
        ("source.disabled", "source-registry", "staff", "staff-ops")]


async def test_sprint6_admin_audit_events_from_news(env) -> None:
    """Спринт 6: news публикует аудит источников новостей и скрытия новостей событием (outbox); watch и
    recommendations команд сотрудников не выполняют — их записи игнорируются."""
    from tilhero_common.testing import assert_event_conforms

    settings, c, _, bus = env
    for action, object_type in (("news.source.created", "news_source"), ("news.source.updated", "news_source"),
                                ("news.source.deleted", "news_source"), ("news.item.hidden", "news_item"),
                                ("news.item.unhidden", "news_item")):
        ev = make_envelope("admin.audit.recorded.v1",
                           {**event_record(action=action, object_type=object_type,
                                           after={"changed_fields": ["enabled"]}),
                            "actor_id": "staff-news", "actor_role": "operations"},
                           producer="news")
        assert_event_conforms(ev)
        await bus.publish(ev)
        await bus.publish(ev)  # повторная доставка — одна запись (inbox)
    for producer in ("watch", "recommendations"):
        await bus.publish(make_envelope("admin.audit.recorded.v1", event_record(action="watch.deleted"),
                                        producer=producer))
    read = internal_headers(settings, issuer="admin-bff", actor=AUDITOR)
    items = (await c.get("/admin/v1/audit/records", headers=read)).json()["items"]
    got = sorted((i["action"], i["source"], i["actor_id"]) for i in items)
    assert got == sorted((a, "news", "staff-news") for a in (
        "news.source.created", "news.source.updated", "news.source.deleted", "news.item.hidden", "news.item.unhidden"))


# ---------------------------------------------------------------- исправление 6.1: лимиты AI из админки

async def test_fix61_ai_limits_delegated_from_provider_gateway(env) -> None:
    """ai.limits.update / ai.limits.reset — сотрудник через on_behalf_of только от provider-gateway (без этого prod —
    503 у PUT/DELETE лимитов); другим издателям и другим действиям делегирование не разрешено."""
    settings, c, *_ = env
    staff = {"actor_id": "staff-7", "actor_role": "operations"}
    limits = {"ai_daily_usd": "1.00", "news_daily_usd": "0.20", "pages_daily": 300, "source": "env"}
    for action, after in (("ai.limits.update", {**limits, "ai_daily_usd": "2.50", "source": "admin"}),
                          ("ai.limits.reset", limits)):
        r = await c.post("/internal/v1/records",
                         json=record(action=action, object_type="provider", object_id="ai_web", before=limits,
                                     after=after, reason="Сезон фестивалей", on_behalf_of=staff),
                         headers=internal_headers(settings, issuer="provider-gateway"))
        assert r.status_code == 201, r.text
        assert (r.json()["actor_type"], r.json()["actor_id"], r.json()["actor_role"], r.json()["source"]) == (
            "staff", "staff-7", "operations", "provider-gateway")
        assert r.json()["after"] == after
        # тот же action от другого писателя с сотрудником в теле — нельзя
        for issuer in ("identity-consent", "support"):
            denied = await c.post("/internal/v1/records", json=record(action=action, on_behalf_of=staff),
                                  headers=internal_headers(settings, issuer=issuer))
            assert denied.status_code == 403 and denied.json()["code"] == "DELEGATION_NOT_ALLOWED", issuer
    # provider-gateway не может приписать сотруднику произвольное действие
    other = await c.post("/internal/v1/records", json=record(action="ai.limits.delete", on_behalf_of=staff),
                         headers=internal_headers(settings, issuer="provider-gateway"))
    assert other.status_code == 403 and other.json()["code"] == "DELEGATION_NOT_ALLOWED"


# ---------------------------------------------------------------- спринт 7: AI-контур

AI_CONTROL_STAFF_ACTIONS = (
    "ai.agent.config.update", "skill.version.created", "skill.version.updated", "skill.tested",
    "skill.review.requested", "skill.review.decided", "skill.published", "skill.rolled_back", "skill.deprecated",
    "skill.case.created", "skill.case.updated", "skill.case.deleted", "ai.pricing.create", "ai.pricing.update",
    "ai.pricing.activate", "ai.budget.alert.ack", "ai.access_level.update", "ai.access_level.delete",
    "user.access_level.assign", "user.access_level.reset")


async def test_sprint7_ai_control_writes_staff_commands_delegated(env) -> None:
    """ai-control: синхронный аудит команд сотрудников (on_behalf_of) по списку действий; system — от своего имени."""
    settings, c, *_ = env
    staff = {"actor_id": "staff-ops", "actor_role": "operations"}
    h = internal_headers(settings, issuer="ai-control")
    for action in AI_CONTROL_STAFF_ACTIONS:
        r = await c.post("/internal/v1/records", json=record(action=action, object_type="ai", on_behalf_of=staff),
                         headers=h)
        assert r.status_code == 201, (action, r.text)
        assert (r.json()["actor_type"], r.json()["actor_id"], r.json()["actor_role"], r.json()["source"]) == (
            "staff", "staff-ops", "operations", "ai-control"), action
    # назначение уровня: before/after и причина сохраняются как есть
    assign = record(action="user.access_level.assign", object_type="user", object_id=str(uuid.uuid4()),
                    before={"level": "basic", "source": "default", "expires_at": None},
                    after={"level": "plus", "source": "manual", "expires_at": "2026-11-12T00:00:00Z"},
                    reason="Тестировщик бета-версии", on_behalf_of=staff)
    r = await c.post("/internal/v1/records", json=assign, headers=h)
    assert r.status_code == 201 and r.json()["after"]["level"] == "plus" and r.json()["reason"] == assign["reason"]
    # повтор с тем же record_id (повтор команды после сбоя) — та же запись
    again = await c.post("/internal/v1/records", json=assign, headers=h)
    assert again.status_code == 201 and again.json()["seq"] == r.json()["seq"]
    # автоматическое действие (A37) — от имени сервиса, без сотрудника
    system = await c.post("/internal/v1/records", json=record(action="ai.budget.threshold", object_type="ai_agent",
                                                              object_id="concierge"), headers=h)
    assert system.status_code == 201
    assert (system.json()["actor_type"], system.json()["actor_id"]) == ("service", "ai-control")
    # system-действие и чужие действия приписать сотруднику нельзя
    for action in ("ai.budget.threshold", "ai.content.view", "ai.agent.pause", "sensitive.view", "staff.updated"):
        denied = await c.post("/internal/v1/records", json=record(action=action, on_behalf_of=staff), headers=h)
        assert denied.status_code == 403 and denied.json()["code"] == "DELEGATION_NOT_ALLOWED", action
    # с контекстом пользователя (sub) делегирование не принимается
    with_sub = await c.post("/internal/v1/records",
                            json=record(action="user.access_level.assign", on_behalf_of=staff),
                            headers=internal_headers(settings, issuer="ai-control", subject=str(uuid.uuid4())))
    assert with_sub.status_code == 403 and with_sub.json()["code"] == "DELEGATION_NOT_ALLOWED"


async def test_sprint7_ai_concierge_reveal_only(env) -> None:
    """ai-concierge: только ai.content.view от имени сотрудника с ai.content.read (A43); без текста переписки."""
    settings, c, *_ = env
    staff = {"actor_id": "staff-root", "actor_role": "super_admin"}
    h = internal_headers(settings, issuer="ai-concierge")
    request_id = str(uuid.uuid4())
    r = await c.post("/internal/v1/records",
                     json=record(action="ai.content.view", object_type="ai_request", object_id=request_id,
                                 before=None, after=None, reason="Жалоба пользователя TCK-4100", on_behalf_of=staff),
                     headers=h)
    assert r.status_code == 201, r.text
    assert (r.json()["actor_type"], r.json()["actor_id"], r.json()["source"], r.json()["object_id"]) == (
        "staff", "staff-root", "ai-concierge", request_id)
    for action in ("user.access_level.assign", "skill.published", "sensitive.view", "ai.agent.pause"):
        denied = await c.post("/internal/v1/records", json=record(action=action, on_behalf_of=staff), headers=h)
        assert denied.status_code == 403 and denied.json()["code"] == "DELEGATION_NOT_ALLOWED", action


async def test_sprint7_provider_gateway_ai_kill_switch_delegated(env) -> None:
    """A47: пауза агента и провайдера — сотрудник через on_behalf_of от provider-gateway; автопауза — от system."""
    settings, c, *_ = env
    staff = {"actor_id": "staff-ops", "actor_role": "operations"}
    h = internal_headers(settings, issuer="provider-gateway")
    for action, obj in (("ai.agent.pause", "ai_agent"), ("ai.agent.resume", "ai_agent"),
                        ("ai.provider.pause", "ai_provider"), ("ai.provider.resume", "ai_provider")):
        r = await c.post("/internal/v1/records", json=record(action=action, object_type=obj, on_behalf_of=staff),
                         headers=h)
        assert r.status_code == 201 and r.json()["actor_id"] == "staff-ops", action
        for issuer in ("ai-control", "ai-concierge"):  # те же действия от других издателей — нельзя
            denied = await c.post("/internal/v1/records", json=record(action=action, on_behalf_of=staff),
                                  headers=internal_headers(settings, issuer=issuer))
            assert denied.status_code == 403 and denied.json()["code"] == "DELEGATION_NOT_ALLOWED", (issuer, action)
    auto = await c.post("/internal/v1/records", json=record(action="ai.budget.auto_pause", object_type="ai_agent"),
                        headers=h)
    assert auto.status_code == 201 and auto.json()["actor_type"] == "service"
    denied = await c.post("/internal/v1/records", json=record(action="ai.budget.auto_pause", on_behalf_of=staff),
                          headers=h)
    assert denied.status_code == 403 and denied.json()["code"] == "DELEGATION_NOT_ALLOWED"


async def test_sprint7_ai_services_cannot_read_and_events_ignored(env) -> None:
    """Читать журнал AI-сервисы не могут; аудит событием admin.audit.recorded.v1 от них не принимается (только HTTP)."""
    settings, c, _, bus = env
    for issuer in ("ai-control", "ai-concierge"):
        r = await c.get("/admin/v1/audit/records", headers=internal_headers(settings, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
        await bus.publish(make_envelope("admin.audit.recorded.v1", event_record(action="skill.published"),
                                        producer=issuer))
    read = internal_headers(settings, issuer="admin-bff", actor=AUDITOR)
    assert (await c.get("/admin/v1/audit/records", headers=read)).json()["items"] == []
    # без токена и с мусорным токеном — 401
    assert (await c.post("/internal/v1/records", json=record())).status_code == 401
    r = await c.post("/internal/v1/records", json=record(), headers={"x-internal-token": "garbage"})
    assert r.status_code == 401


async def test_sprint8_ops_monitor_commands_delegated_and_alerts_from_system(env) -> None:
    """Спринт 8: ops-monitor — повтор/удаление DLQ и ack оповещения от имени сотрудника; открытие/закрытие
    оповещений — от своего имени (system); чужие действия приписать сотруднику нельзя; читать журнал нельзя."""
    settings, c, *_ = env
    staff = {"actor_id": "staff-ops", "actor_role": "operations"}
    h = internal_headers(settings, issuer="ops-monitor")
    for action, obj in (("ops.dlq.replay", "consumer"), ("ops.dlq.delete", "consumer"), ("ops.alert.ack", "provider")):
        r = await c.post("/internal/v1/records", json=record(action=action, object_type=obj, object_id="x",
                                                             reason="исправлен обработчик", on_behalf_of=staff),
                         headers=h)
        assert r.status_code == 201, (action, r.text)
        assert (r.json()["actor_type"], r.json()["actor_id"], r.json()["source"]) == ("staff", "staff-ops",
                                                                                      "ops-monitor"), action
        for issuer in ("ai-control", "provider-gateway"):
            denied = await c.post("/internal/v1/records", json=record(action=action, on_behalf_of=staff),
                                  headers=internal_headers(settings, issuer=issuer))
            assert denied.status_code == 403 and denied.json()["code"] == "DELEGATION_NOT_ALLOWED", (issuer, action)
    for action in ("ops.alert.raised", "ops.alert.resolved"):
        r = await c.post("/internal/v1/records", json=record(action=action, object_type="provider",
                                                             object_id="aviasales", before=None,
                                                             after={"kind": "status", "severity": "critical"}),
                         headers=h)
        assert r.status_code == 201 and (r.json()["actor_type"], r.json()["actor_id"]) == ("service", "ops-monitor")
        denied = await c.post("/internal/v1/records", json=record(action=action, on_behalf_of=staff), headers=h)
        assert denied.status_code == 403 and denied.json()["code"] == "DELEGATION_NOT_ALLOWED", action
    r = await c.get("/admin/v1/audit/records", headers=h)
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"


# ---------------------------------------------------------------- спринт 9: сага удаления (интеграция волны 1)

async def test_sprint9_deletion_retry_delegated_and_saga_repeats_not_recorded(env) -> None:
    """identity-consent пишет ручной повтор удаления (`user.deletion.retry`) от имени сотрудника; повторная рассылка
    `user.deletion.requested.v1` сагой (attempt > 1, тот же request_id) — не новый запрос пользователя: записи нет."""
    settings, c, _runtime, bus = env
    request_id, user_id = str(uuid.uuid4()), str(uuid.uuid4())
    body = record(action="user.deletion.retry", object_type="deletion_request", object_id=request_id,
                  before={"status": "STUCK", "attempts": 6, "pending_domains": ["watch"]},
                  after={"attempt": 7, "user_id": user_id}, reason="Домен watch поднят после сбоя",
                  on_behalf_of={"actor_id": "staff-7", "actor_role": "operations"})
    ok = await c.post("/internal/v1/records", json=body, headers=internal_headers(settings, issuer="identity-consent"))
    assert ok.status_code == 201, ok.text
    assert (ok.json()["actor_type"], ok.json()["actor_id"], ok.json()["source"]) == ("staff", "staff-7",
                                                                                     "identity-consent")
    # другим доменам это действие не делегировано
    denied = await c.post("/internal/v1/records", json={**body, "record_id": str(uuid.uuid4())},
                          headers=internal_headers(settings, issuer="ops-monitor"))
    assert denied.status_code == 403 and denied.json()["code"] == "DELEGATION_NOT_ALLOWED"

    first = make_envelope("user.deletion.requested.v1", {"user_id": user_id, "request_id": request_id,
                                                         "domains": ["watch"], "attempt": 1},
                          producer="identity-consent")
    await bus.publish(first)
    for n in (2, 3):
        await bus.publish(make_envelope("user.deletion.requested.v1", {"user_id": user_id, "request_id": request_id,
                                                                       "domains": ["watch"], "attempt": n},
                                        producer="identity-consent"))
    # событие до спринта 9 (без attempt) — первичный запрос, как раньше
    other = str(uuid.uuid4())
    await bus.publish(make_envelope("user.deletion.requested.v1", {"user_id": other, "request_id": str(uuid.uuid4())},
                                    producer="identity-consent"))
    read = internal_headers(settings, issuer="admin-bff", actor=AUDITOR)
    items = (await c.get("/admin/v1/audit/records", headers=read)).json()["items"]
    requests = sorted(i["object_id"] for i in items if i["action"] == "user.deletion_request")
    assert requests == sorted([user_id, other])
    assert [i["action"] for i in items if i["action"] == "user.deletion.retry"] == ["user.deletion.retry"]


async def test_sprint9_ratelimit_override_delegated_to_ops_monitor(env) -> None:
    """Спринт 9 (интеграция волны 2): ops-monitor пишет переопределение и сброс лимита (`ratelimit.override.set|reset`)
    от имени сотрудника синхронно до действия — без делегирования команда из «Лимитов» отвечала 503 AUDIT_UNAVAILABLE;
    другим издателям эти действия не делегированы, от system — нельзя приписать сотруднику чужое."""
    settings, c, *_ = env
    staff = {"actor_id": "staff-ops", "actor_role": "operations"}
    h = internal_headers(settings, issuer="ops-monitor")
    for action, after in (("ratelimit.override.set", {"limit": 1000, "window_s": 60}),
                          ("ratelimit.override.reset", None)):
        r = await c.post("/internal/v1/records", json=record(action=action, object_type="ratelimit",
                                                             object_id="tg.watch", before=None, after=after,
                                                             reason="всплеск честного трафика", on_behalf_of=staff),
                         headers=h)
        assert r.status_code == 201, (action, r.text)
        assert (r.json()["actor_type"], r.json()["actor_id"], r.json()["source"]) == ("staff", "staff-ops",
                                                                                      "ops-monitor"), action
        for issuer in ("ai-control", "provider-gateway", "identity-consent"):
            denied = await c.post("/internal/v1/records", json=record(action=action, on_behalf_of=staff),
                                  headers=internal_headers(settings, issuer=issuer))
            assert denied.status_code == 403 and denied.json()["code"] == "DELEGATION_NOT_ALLOWED", (issuer, action)

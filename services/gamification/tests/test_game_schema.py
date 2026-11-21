"""Модели = миграции (schema_drift); миграции под владельцем, сервис — под своей ролью без DDL и без права снять
триггеры; откат/подъём; сквозной прогон под ролями; неизменяемость реестра, значков, правил, картинок; сид;
настройки."""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from pathlib import Path

import httpx
import pytest
from conftest import SERVICE_DIR, RecordingBus, make_settings
from pydantic import ValidationError

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import HEADER, issue_token
from tilhero_common.messaging import make_envelope, messaging_metadata
from tilhero_common.testing import assert_event_conforms, ddl_allowed_for, migrated_under_roles, schema_drift
from tilhero_gamification.domain.rules import validate
from tilhero_gamification.images import inspect_image
from tilhero_gamification.main import build_app
from tilhero_gamification.models import Base
from tilhero_gamification.settings import Settings

TABLES = ("ledger", "wallets", "learners", "skill_states", "referrals", "ownership", "purchases", "quests", "badges",
          "badge_templates", "rules_versions", "heroes", "assets", "shop_items", "game_events", "daily_stats",
          "session_rewards", "idempotency", "deleted_users", "tick_state", "outbox", "inbox",
          # спринт 7
          "social_friends", "social_blocks", "community", "family_members", "sanctions", "learner_levels",
          "league_weeks", "league_groups", "league_members", "league_results", "duels", "duel_results_history",
          "referral_rewards", "pair_awards", "projection_loads")


async def test_models_match_migrations_and_runtime_role() -> None:
    async with migrated_under_roles(SERVICE_DIR, make_settings, "game_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in TABLES:
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        bus = RecordingBus()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime)
        user = uuid.uuid4()
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://game") as c:
                await bus.publish(make_envelope("user.profile.created.v1", {
                    "user_id": str(user), "kind": "account", "age_band": "18+",
                    "created_at": "2026-11-20T05:00:00Z"}, producer="identity-consent"))
                await bus.publish(make_envelope("lesson.session.completed.v1", {
                    "session_id": str(uuid.uuid4()), "user_id": str(user), "kind": "lesson", "pair_id": "ru-en",
                    "status": "completed", "minutes": 10, "practice_only": False, "passed": True,
                    "finished_at": "2026-11-20T05:00:00Z"}, producer="lessons"))
                h = {HEADER: issue_token(settings.internal_jwt_secret.get_secret_value(), issuer="telegram-bff",
                                         audience="gamification", subject=str(user),
                                         extra={"lrn": str(user), "age_band": "18+"})}
                r = await c.get("/internal/v1/game/summary", headers=h)
                assert r.status_code == 200, r.text
                assert r.json()["xp_total"] >= 30  # урок 20 + бонус 10 (+ задание дня, если выпало)
                r = await c.post("/internal/v1/game/purchases", json={"item_code": "streak_freeze"},
                                 headers={**h, "Idempotency-Key": "k-roles-01"})
                assert r.status_code == 409 and r.json()["code"] == "INSUFFICIENT_TILS"
                r = await c.post("/internal/v1/game:tick", headers={"Authorization": f"Bearer {'s' * 40}"})
                assert r.status_code == 200, r.text
                await bus.publish(make_envelope(
                    "user.deletion.requested.v1",
                    {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-11-20T10:00:00Z"},
                    producer="identity-consent"))
                assert (await c.get("/health/ready")).status_code == 200
            assert runtime.relay is not None
            await runtime.relay.drain()
        assert bus.errors == [] and bus.dlq == []
        [ev] = bus.of_type("user.domain.deleted.v1")
        assert_event_conforms(ev)


async def test_migration_down_up_under_roles() -> None:
    from alembic import command
    from alembic.config import Config

    async with migrated_under_roles(SERVICE_DIR, make_settings, "game_rb") as (settings, _roles):
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        await asyncio.to_thread(command.downgrade, cfg, "base")
        await asyncio.to_thread(command.upgrade, cfg, "head")


async def test_seed(env) -> None:  # type: ignore[no-untyped-def]
    rows = await env.sql("SELECT version, status, payload, based_on FROM rules_versions ORDER BY version")
    assert [(r[0], r[1], r[3]) for r in rows] == [(1, "archived", None), (2, "active", 1)]
    v1, v2 = rows[0][2], rows[1][2]
    # версия 2 (миграция 0002) = версия 1 + лиги, дуэли, парные уроки; проходит валидатор
    assert validate(v2) == [] and {k: v for k, v in v2.items() if k in v1} == v1
    assert v2["league"] == {"prizes": [50, 30, 20], "group_size": [20, 30],
                            "anomaly": {"median_factor": 5, "min_xp": 1500}}
    assert v2["duel"] == {"win": 30, "draw": 15, "participation": 10, "daily_cap": 3}
    assert v2["pair_lesson"] == {"xp": 25, "min_turns": 1, "daily_cap": 3}
    assert v2["caps"] == {"xp_per_day": 300, "til_per_day": 60}
    heroes = await env.sql("SELECT code, line, audiences, stages, published_at FROM heroes ORDER BY \"order\"")
    assert [h[0] for h in heroes] == ["robot_0", "robot_1", "robot_2", "pet_0", "pet_1", "pet_2", "human_0",
                                      "human_1", "human_2"]
    assert all(h[2] == ["kids", "teens", "adults"] and h[4] is not None and len(h[3]) == 3 for h in heroes)
    assets = await env.sql("SELECT asset_id, sha256, mime, width, height, size, bytes, purpose FROM assets")
    assert len(assets) == 27
    for asset_id, sha, mime, width, height, size, data, purpose in assets:
        assert hashlib.sha256(data).hexdigest() == sha and mime == "image/webp" and purpose == "hero_stage"
        info = inspect_image(bytes(data))
        assert (info.width, info.height, info.size) == (width, height, size) and height == 460
        assert asset_id in {uuid.UUID(s["asset_id"]) for h in heroes for s in h[3]}
    items = await env.sql("SELECT code, kind, price_til, status, theme FROM shop_items")
    assert {i[0] for i in items} >= {"streak_freeze"} and all(i[3] == "published" for i in items)
    cosmetics = [i for i in items if i[1] != "streak_freeze"]
    assert 4 <= len(cosmetics) <= 6 and all(60 <= i[2] <= 200 and i[4] for i in cosmetics)
    tpl = await env.sql("SELECT code, title, description FROM badge_templates")
    assert len(tpl) == 8 and all(t[1]["ru"] and t[1]["uz"] and t[2]["ru"] and t[2]["uz"] for t in tpl)
    assert "together" in {t[0] for t in tpl}


async def test_ledger_badges_rules_assets_immutable(env, user) -> None:  # type: ignore[no-untyped-def]
    await env.lesson(user)
    await env.publish("learning.activity.recorded.v1", {
        "user_id": str(user), "activity_id": str(uuid.uuid4()), "local_date": "2026-11-20", "kind": "lesson",
        "minutes": 10, "recorded_at": "2026-11-20T05:00:00Z", "streak_days": 7}, "learning-plan")
    [(op_id,), *_] = await env.sql("SELECT op_id FROM ledger WHERE user_id = :u", u=user)
    for stmt in ("UPDATE ledger SET amount = 999 WHERE user_id = :u",
                 "UPDATE ledger SET status = 'reversed' WHERE user_id = :u",
                 "UPDATE ledger SET comment = 'x' WHERE user_id = :u",
                 "DELETE FROM ledger WHERE user_id = :u",
                 "UPDATE badges SET value = 0 WHERE user_id = :u",
                 "DELETE FROM badges WHERE user_id = :u",
                 "UPDATE rules_versions SET payload = '{}'::jsonb WHERE version = 1",
                 "UPDATE rules_versions SET status = 'draft' WHERE version = 1",
                 "DELETE FROM rules_versions WHERE version = 1",
                 "UPDATE assets SET size = 1"):
        with pytest.raises(Exception, match=r"append-only|immutable|only a draft"):
            await env.sql(stmt, u=user)
    # перевод confirmed → reversed с reversed_by — единственное допустимое изменение
    await env.sql("UPDATE ledger SET status = 'reversed', reversed_by = :r WHERE op_id = :o", r=uuid.uuid4(), o=op_id)
    with pytest.raises(Exception, match="append-only"):
        await env.sql("UPDATE ledger SET status = 'confirmed', reversed_by = NULL WHERE op_id = :o", o=op_id)
    # одна active, одна draft
    with pytest.raises(Exception, match="uq_rules_versions_active"):
        await env.sql("INSERT INTO rules_versions (version, status, payload, created_by, created_at, updated_at, "
                      "activated_at) VALUES (9, 'active', '{}'::jsonb, 'x', now(), now(), now())")


def test_settings_guards() -> None:
    prod = {"env": "prod", "internal_jwt_secret": "x" * 40, "internal_jwt_private_key": "a" * 43,
            "social_url": "http://social:8109", "lessons_url": "http://lessons:8112",
            "diagnostics_url": "http://diagnostics:8111", "identity_consent_url": "http://identity-consent:8101",
            "member_id_key": "m" * 40}
    for bad in ("short", ""):
        with pytest.raises(ValidationError, match="SCHEDULER_TOKEN"):
            Settings(**prod, scheduler_token=bad)
    # спринт 7: адреса social и lessons и MEMBER_ID_KEY обязательны в stage/prod
    for name in ("social_url", "lessons_url", "diagnostics_url", "identity_consent_url"):
        with pytest.raises(ValidationError, match=name.upper()):
            Settings(**{k: v for k, v in prod.items() if k != name}, scheduler_token="t" * 43)
    for key in ("short", None):
        with pytest.raises(ValidationError, match="MEMBER_ID_KEY"):
            Settings(**{k: v for k, v in prod.items() if k != "member_id_key"}, scheduler_token="t" * 43,
                     **({"member_id_key": key} if key else {}))
    with pytest.raises(ValidationError, match="SOCIAL_URL"):
        Settings(env="test", social_url="ftp://social")
    # MEMBER_ID_KEY без пробелов по краям (как в social и lessons)
    assert Settings(env="test", member_id_key=f"  {'k' * 40}\n").member_id_key.get_secret_value() == "k" * 40
    ok = Settings(**prod, scheduler_token="t" * 43)
    assert ok.port == 8117 and ok.db_schema == "gamification" and ok.service_name == "gamification"
    assert ok.asset_max_bytes == 300 * 1024 and ok.asset_max_px == 1024 and ok.tick_batch_size == 500
    with pytest.raises(ValidationError):
        Settings(env="test", default_timezone="Mars/Olympus")


async def test_migration_0002_downgrade_reverts_upgrade() -> None:
    """Ревью 🔴2г: downgrade 0002 возвращает изменения upgrade — версия правил миграции снимается (прежняя снова
    active), expired → void (pending не трогаются ни upgrade, ни downgrade), таблицы и колонки спринта 7 удаляются;
    повторный подъём снова создаёт версию."""
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text

    from tilhero_common.db import make_engine
    from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, migrate, unique_schema

    schema = unique_schema("game_dn")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    engine = make_engine(TEST_ADMIN_URL, schema, pool_size=1)

    async def sql(stmt: str, **kw: object) -> list[tuple[object, ...]]:
        async with engine.begin() as conn:
            r = await conn.execute(text(stmt), kw)
            return [tuple(x) for x in r.all()] if r.returns_rows else []

    try:
        await asyncio.to_thread(command.upgrade, cfg, "0001")
        pend, done = uuid.uuid4(), uuid.uuid4()
        for invitee, status in ((pend, "pending"), (done, "rewarded")):
            await sql("INSERT INTO referrals (invitee_user_id, inviter_user_id, invite_id, status, accepted_at, "
                      "updated_at) VALUES (:i, :r, :v, :s, now(), now())", i=invitee, r=uuid.uuid4(),
                      v=uuid.uuid4(), s=status)
        await migrate(SERVICE_DIR, settings)
        assert await sql("SELECT status FROM referrals ORDER BY status") == [("pending",), ("rewarded",)]
        assert await sql("SELECT version, status FROM rules_versions ORDER BY version") == [
            (1, "archived"), (2, "active")]
        await sql("UPDATE referrals SET status = 'expired' WHERE invitee_user_id = :i", i=pend)
        await asyncio.to_thread(command.downgrade, cfg, "0001")
        assert await sql("SELECT status FROM referrals ORDER BY status") == [("rewarded",), ("void",)]
        assert await sql("SELECT version, status FROM rules_versions ORDER BY version") == [(1, "active")]
        assert await sql("SELECT to_regclass('duels'), to_regclass('projection_loads')") == [(None, None)]
        assert await sql("SELECT count(*) FROM information_schema.columns WHERE table_schema = :s AND "
                         "column_name IN ('league_week', 'league_opt_in', 'guardian_consent')", s=schema) == [(0,)]
        assert await sql("SELECT count(*) FROM badge_templates WHERE code = 'together'") == [(0,)]
        with pytest.raises(Exception, match=r"immutable|only a draft"):  # триггер правил снова включён
            await sql("UPDATE rules_versions SET payload = '{}'::jsonb WHERE version = 1")
        await migrate(SERVICE_DIR, settings)
        assert await sql("SELECT version, status FROM rules_versions ORDER BY version") == [
            (1, "archived"), (2, "active")]
    finally:
        await engine.dispose()
        await drop_schema(schema)

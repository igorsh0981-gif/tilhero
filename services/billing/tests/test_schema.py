"""Миграция 0001: модели = миграции (schema_drift), роль сервиса без DDL и без права снять триггеры, откат и подъём,
каталог v1 черновиком, триггеры неизменяемости и переходов (catalog_guard, txn_guard, orders_guard, periods_guard,
ledger_guard)."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import asyncpg
import pytest
from conftest import SERVICE_DIR, make_settings
from sqlalchemy.engine import make_url

from tilhero_billing.domain.common import canonical_hash
from tilhero_billing.models import Base
from tilhero_common.messaging import messaging_metadata
from tilhero_common.testing import ddl_allowed_for, migrated_under_roles, schema_drift

T = datetime(2026, 11, 20, tzinfo=UTC)
TABLES = ("learners", "catalog_versions", "stars_subscriptions", "orders", "provider_transactions",
          "stars_pre_checkouts", "fiscal_receipts", "refunds", "periods", "period_balances", "minute_ledger",
          "minute_holds", "adjustments", "reconciliation_runs", "reconciliation_items", "provider_calls", "fx_rates",
          "star_rates", "idempotency", "deleted_users", "tick_state", "projection_loads", "outbox", "inbox")


def _pg(url: str) -> str:
    return make_url(url).set(drivername="postgresql").render_as_string(hide_password=False)


async def test_models_match_migration_and_runtime_role_has_no_ddl() -> None:
    async with migrated_under_roles(SERVICE_DIR, make_settings, "bill_schema") as (_, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in TABLES:
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table


async def test_migration_down_and_up() -> None:
    from alembic import command
    from alembic.config import Config

    async with migrated_under_roles(SERVICE_DIR, make_settings, "bill_down") as (settings, roles):
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        import asyncio

        await asyncio.to_thread(command.downgrade, cfg, "base")
        await asyncio.to_thread(command.upgrade, cfg, "head")
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []


async def test_catalog_v1_is_a_draft_with_site_prices_only() -> None:
    async with migrated_under_roles(SERVICE_DIR, make_settings, "bill_seed") as (_, roles):
        conn = await asyncpg.connect(_pg(roles.runtime_url))
        try:
            await conn.execute(f'SET search_path = "{roles.schema}"')
            rows = await conn.fetch("SELECT version, status, payload, payload_hash FROM catalog_versions")
        finally:
            await conn.close()
        [row] = rows
        assert row["version"] == 1 and row["status"] == "draft"
        payload = json.loads(row["payload"])
        assert row["payload_hash"] == canonical_hash(payload)
        prices = {p["code"]: (p["price_tiyin"], p["price_stars"]) for p in payload["products"]}
        # В2, В5 — цены сайта в тийинах (сумы × 100); О1 — цены в Stars пусты
        assert prices == {"plus_30d": (4_900_000, None), "plus_90d": (12_900_000, None), "til_100": (500_000, None),
                          "til_550": (2_500_000, None), "til_1200": (5_000_000, None)}
        assert all(all(v is None for k, v in p["fiscal"].items() if k != "receipt_title") for p in payload["products"])
        assert payload["trial"] == {"enabled": True, "days": 7, "minutes": 60, "features": ["ai_lessons",
                                                                                               "pair_lessons"]}


class _Db:
    def __init__(self, conn: asyncpg.Connection) -> None:
        self.conn = conn

    async def denied(self, sql: str, *args: object, saga: bool = False) -> bool:
        tr = self.conn.transaction()
        await tr.start()
        try:
            if saga:
                await self.conn.execute("SET LOCAL tilhero.deletion = 'on'")
            await self.conn.execute(sql, *args)
            return False
        except asyncpg.PostgresError:
            return True
        finally:
            await tr.rollback()


@pytest.fixture
async def db():  # type: ignore[no-untyped-def]
    async with migrated_under_roles(SERVICE_DIR, make_settings, "bill_trg") as (_, roles):
        conn = await asyncpg.connect(_pg(roles.runtime_url))
        await conn.execute(f'SET search_path = "{roles.schema}"')
        try:
            yield _Db(conn)
        finally:
            await conn.close()


async def _order(db: _Db, *, provider: str = "payme", status: str = "pending") -> uuid.UUID:
    oid = uuid.uuid4()
    web = provider != "telegram_stars"
    await db.conn.execute(
        "INSERT INTO orders (order_id, account_id, beneficiary_id, channel, product_code, product_kind, "
        "catalog_version, product_snapshot, provider, currency, amount_tiyin, amount_stars, stars_mode, status, "
        "offer_version, locale, idempotency_key, expires_at) VALUES ($1, $2, $2, $3, 'til_100', 'til_pack', 1, "
        "'{}'::jsonb, $4, $5, $6, $7, $8, $9, '1.0', 'ru', $10, now() + interval '1 day')",
        oid, uuid.uuid4(), "web" if web else "miniapp", provider, "UZS" if web else "XTR",
        500_000 if web else None, None if web else 15, None if web else "one_time", status, str(oid))
    return oid


async def test_orders_guard(db: _Db) -> None:
    assert await db.denied(
        "INSERT INTO orders (order_id, account_id, channel, product_code, product_kind, catalog_version, "
        "product_snapshot, provider, currency, amount_tiyin, status, offer_version, locale, idempotency_key, "
        "expires_at, paid_at) VALUES ($1, $1, 'web', 'til_100', 'til_pack', 1, '{}', 'payme', 'UZS', 500000, 'paid',"
        " '1.0', 'ru', 'k', now(), now())", uuid.uuid4())
    oid = await _order(db)
    # деньги и снимок неизменны; удалить нельзя; обезличить — только в саге
    assert await db.denied("UPDATE orders SET amount_tiyin = 100 WHERE order_id = $1", oid)
    assert await db.denied("UPDATE orders SET product_snapshot = '{\"x\": 1}' WHERE order_id = $1", oid)
    assert await db.denied("DELETE FROM orders WHERE order_id = $1", oid)
    assert await db.denied("UPDATE orders SET account_id = NULL WHERE order_id = $1", oid)
    assert not await db.denied("UPDATE orders SET account_id = NULL WHERE order_id = $1", oid, saga=True)
    assert await db.denied("UPDATE orders SET account_id = gen_random_uuid() WHERE order_id = $1", oid, saga=True)
    # переходы §1.4
    await db.conn.execute("UPDATE orders SET status = 'paid', paid_at = now() WHERE order_id = $1", oid)
    assert await db.denied("UPDATE orders SET status = 'pending', paid_at = NULL WHERE order_id = $1", oid)
    assert await db.denied("UPDATE orders SET status = 'expired', paid_at = NULL WHERE order_id = $1", oid)
    await db.conn.execute("UPDATE orders SET status = 'fulfilled' WHERE order_id = $1", oid)
    await db.conn.execute("UPDATE orders SET status = 'refunded' WHERE order_id = $1", oid)
    assert await db.denied("UPDATE orders SET status = 'fulfilled' WHERE order_id = $1", oid)
    cancelled = await _order(db)
    await db.conn.execute("UPDATE orders SET status = 'cancelled' WHERE order_id = $1", cancelled)
    assert await db.denied("UPDATE orders SET status = 'paid', paid_at = now() WHERE order_id = $1", cancelled)
    expired = await _order(db)
    await db.conn.execute("UPDATE orders SET status = 'expired' WHERE order_id = $1", expired)
    assert not await db.denied("UPDATE orders SET status = 'fulfilled', paid_at = now() WHERE order_id = $1",
                               expired)


async def test_txn_guard(db: _Db) -> None:
    web, stars = await _order(db), await _order(db, provider="telegram_stars")
    insert = ("INSERT INTO provider_transactions (txn_id, provider, provider_txn_id, order_id, amount_tiyin, "
              "amount_stars, state, performed_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)")
    # Payme/Click/Uzum — только created; Stars — только сразу performed
    assert await db.denied(insert, "payme", "p1", web, 500_000, None, "performed", None)
    assert await db.denied(insert, "telegram_stars", "s1", stars, None, 15, "created", None)
    await db.conn.execute(insert, "payme", "p1", web, 500_000, None, "created", None)
    assert await db.denied("UPDATE provider_transactions SET amount_tiyin = 1 WHERE provider_txn_id = 'p1'")
    assert await db.denied("UPDATE provider_transactions SET state = 'refunded', performed_at = now(), "
                           "cancelled_at = now() WHERE provider_txn_id = 'p1'")
    await db.conn.execute("UPDATE provider_transactions SET state = 'performed', performed_at = now() "
                          "WHERE provider_txn_id = 'p1'")
    assert await db.denied("UPDATE provider_transactions SET state = 'created', performed_at = NULL "
                           "WHERE provider_txn_id = 'p1'")
    assert await db.denied("UPDATE provider_transactions SET state = 'cancelled', performed_at = NULL, "
                           "cancelled_at = now() WHERE provider_txn_id = 'p1'")
    await db.conn.execute("UPDATE provider_transactions SET state = 'refunded', cancelled_at = now() "
                          "WHERE provider_txn_id = 'p1'")
    assert await db.denied("UPDATE provider_transactions SET state = 'performed', cancelled_at = NULL "
                           "WHERE provider_txn_id = 'p1'")
    assert await db.denied("DELETE FROM provider_transactions WHERE provider_txn_id = 'p1'")
    # UNIQUE (provider, provider_txn_id) и один performed на заказ
    await db.conn.execute(insert, "telegram_stars", "s1", stars, None, 15, "performed", T)
    assert await db.denied(insert, "telegram_stars", "s1", stars, None, 15, "performed", T)
    assert await db.denied(insert, "telegram_stars", "s2", stars, None, 15, "performed", T)


async def _period(db: _Db, status: str = "active") -> uuid.UUID:
    pid = uuid.uuid4()
    await db.conn.execute(
        "INSERT INTO periods (period_id, account_id, product_code, catalog_version, source, features, "
        "minutes_granted, days, status, starts_at, ends_at) VALUES ($1, gen_random_uuid(), 'trial', 1, 'trial', "
        "ARRAY['ai_lessons'], 60, 7, $2, CASE WHEN $2 = 'scheduled' THEN NULL ELSE now() END, "
        "CASE WHEN $2 = 'scheduled' THEN NULL ELSE now() + interval '7 days' END)", pid, status)
    await db.conn.execute("INSERT INTO period_balances (period_id, account_id, granted) SELECT period_id, account_id,"
                          " 60 FROM periods WHERE period_id = $1", pid)
    return pid


async def test_periods_and_ledger_guards(db: _Db) -> None:
    pid = await _period(db)
    assert await db.denied("UPDATE periods SET minutes_granted = 600 WHERE period_id = $1", pid)
    assert await db.denied("UPDATE periods SET ends_at = ends_at + interval '1 day' WHERE period_id = $1", pid)
    assert await db.denied("DELETE FROM periods WHERE period_id = $1", pid)
    await db.conn.execute("UPDATE periods SET status = 'ended', closed_at = now(), close_reason = 'ended' "
                          "WHERE period_id = $1", pid)
    assert await db.denied("UPDATE periods SET status = 'active' WHERE period_id = $1", pid)
    scheduled = await _period(db, "scheduled")
    assert await db.denied("UPDATE periods SET status = 'ended' WHERE period_id = $1", scheduled)
    # реестр: только добавление; в саге — DELETE и learner_id → NULL
    await db.conn.execute(
        "INSERT INTO minute_ledger (entry_id, account_id, period_id, kind, minutes, learner_id, ref_kind, ref_id, "
        "actor, idempotency_key) SELECT gen_random_uuid(), account_id, period_id, 'grant', 60, gen_random_uuid(), "
        "'trial', period_id::text, 'system', 'grant:' || period_id FROM periods WHERE period_id = $1", pid)
    assert await db.denied("UPDATE minute_ledger SET minutes = 600")
    assert await db.denied("UPDATE minute_ledger SET learner_id = NULL")
    assert await db.denied("DELETE FROM minute_ledger")
    assert await db.denied("UPDATE minute_ledger SET minutes = 600, learner_id = NULL", saga=True)
    assert not await db.denied("UPDATE minute_ledger SET learner_id = NULL", saga=True)
    assert not await db.denied("DELETE FROM minute_ledger", saga=True)
    # знак записи и баланс не в минус (CHECK)
    assert await db.denied(
        "INSERT INTO minute_ledger (entry_id, account_id, period_id, kind, minutes, ref_kind, ref_id, actor, "
        "idempotency_key) VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'debit', 5, 'session', 'x', 'system', "
        "'debit:x')", pid)
    assert await db.denied("UPDATE period_balances SET spent = 61 WHERE period_id = $1", pid)
    assert await db.denied("UPDATE period_balances SET held = 61 WHERE period_id = $1", pid)


async def test_catalog_guard(db: _Db) -> None:
    # черновик становится активным только проверенным
    assert await db.denied("UPDATE catalog_versions SET status = 'active', activated_at = now() WHERE version = 1")
    await db.conn.execute("UPDATE catalog_versions SET validated_hash = payload_hash WHERE version = 1")
    assert await db.denied("UPDATE catalog_versions SET status = 'active', activated_at = now(), "
                           "payload = '{}'::jsonb, payload_hash = 'x', validated_hash = 'x' WHERE version = 1")
    await db.conn.execute("UPDATE catalog_versions SET status = 'active', activated_at = now() WHERE version = 1")
    assert await db.denied("UPDATE catalog_versions SET payload = '{}'::jsonb WHERE version = 1")
    assert await db.denied("UPDATE catalog_versions SET comment = 'правка' WHERE version = 1")
    assert await db.denied("DELETE FROM catalog_versions WHERE version = 1")
    assert await db.denied("INSERT INTO catalog_versions (version, status, payload, payload_hash, created_by) "
                           "VALUES (2, 'active', '{}', 'h', 'x')")
    await db.conn.execute("UPDATE catalog_versions SET status = 'archived' WHERE version = 1")
    assert await db.denied("UPDATE catalog_versions SET status = 'active' WHERE version = 1")
    await db.conn.execute("INSERT INTO catalog_versions (version, status, payload, payload_hash, created_by) "
                          "VALUES (2, 'draft', '{}', 'h', 'x')")
    assert not await db.denied("DELETE FROM catalog_versions WHERE version = 2")

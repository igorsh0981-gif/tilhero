"""Сага удаления (спринт 9, ADR-009, docs/sprint9/INTERNAL_API.md §1.2): статус STUCK, расписание повторов, ACK по
доменам со временем, история рассылок, Idempotency-Key ручного повтора.

- `deletion_requests`: CHECK статусов += STUCK; частичный UNIQUE «открыт» = REQUESTED | STUCK; += `attempts`,
  `last_sent_at`, `next_retry_at`, `stuck_at`, `last_retry_by`. Существующие запросы: attempts = 1,
  last_sent_at = requested_at, открытым — next_retry_at = requested_at + 15 мин (в прошлом → таймер повторит запрос в
  первую минуту после деплоя, а запрос старше 24 ч станет STUCK).
- `deletion_domain_acks` (PK request_id, domain): переносятся ACK из `acked_domains`, время и режим неизвестны (NULL).
- `deletion_attempts` (PK request_id, attempt): первичная рассылка существующих запросов — attempt 1 (by = user,
  event_id неизвестен).
- `deletion_idempotency_keys` (PK actor_id, key).

Совместимость с кодом спринта 8 (раскатка: миграция идёт до смены кода; откат кода без отката схемы): CHECK
«у открытого запроса есть next_retry_at, у завершённого — нет» в схеме НЕ ставится. Код спринта 8 создаёт запрос без
`next_retry_at` и завершает его, не обнуляя поле. Инвариант держит код: таймер достраивает расписание запросу без
`next_retry_at`, чтение показывает `next_retry_at = null` у завершённого
(тест `tests/test_deletion_compat_main.py`, ревью спринта 9, БЭК-1).

Таблица `deletion_requests` маленькая (единицы строк в сутки): DDL в транзакции миграции.
Откат: STUCK → REQUESTED (статус до спринта 9), новые таблицы и колонки удаляются.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-16
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

OPEN = "status IN ('REQUESTED','STUCK')"
FIRST_RETRY_MINUTES = 15  # первая точка DELETION_RETRY_SCHEDULE_MINUTES по умолчанию


def upgrade() -> None:
    op.add_column("deletion_requests", sa.Column("attempts", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("deletion_requests", sa.Column("last_sent_at", sa.DateTime(timezone=True)))
    op.add_column("deletion_requests", sa.Column("next_retry_at", sa.DateTime(timezone=True)))
    op.add_column("deletion_requests", sa.Column("stuck_at", sa.DateTime(timezone=True)))
    op.add_column("deletion_requests", sa.Column("last_retry_by", sa.String(64)))
    op.execute("UPDATE deletion_requests SET last_sent_at = requested_at")
    op.execute(sa.text(
        "UPDATE deletion_requests SET next_retry_at = requested_at + make_interval(mins => :m) "
        "WHERE status = 'REQUESTED'"
    ).bindparams(m=FIRST_RETRY_MINUTES))

    op.drop_constraint("ck_deletion_status", "deletion_requests", type_="check")
    op.create_check_constraint("ck_deletion_status", "deletion_requests", "status IN ('REQUESTED','STUCK','COMPLETED')")
    op.create_check_constraint("ck_deletion_attempts", "deletion_requests", "attempts >= 1")
    op.create_check_constraint("ck_deletion_completed", "deletion_requests",
                               "(status = 'COMPLETED') = (completed_at IS NOT NULL)")
    op.create_check_constraint("ck_deletion_stuck_at", "deletion_requests", "status <> 'STUCK' OR stuck_at IS NOT NULL")
    op.drop_index("uq_deletion_requests_open", table_name="deletion_requests")
    op.create_index("uq_deletion_requests_open", "deletion_requests", ["user_id"], unique=True,
                    postgresql_where=sa.text(OPEN))
    op.create_index("ix_deletion_requests_due", "deletion_requests", ["next_retry_at"], postgresql_where=sa.text(OPEN))
    op.create_index("ix_deletion_requests_requested", "deletion_requests", ["requested_at", "request_id"])

    op.create_table(
        "deletion_domain_acks",
        sa.Column("request_id", pg.UUID(as_uuid=True),
                  sa.ForeignKey("deletion_requests.request_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("domain", sa.String(64), primary_key=True),
        sa.Column("acked_at", sa.DateTime(timezone=True)),
        sa.Column("mode", sa.String(16)),
        sa.Column("event_id", pg.UUID(as_uuid=True)),
        sa.CheckConstraint("mode IS NULL OR mode IN ('deleted','anonymized')", name="ck_deletion_ack_mode"),
    )
    op.execute(
        "INSERT INTO deletion_domain_acks (request_id, domain) "
        "SELECT DISTINCT r.request_id, d.domain FROM deletion_requests r "
        "CROSS JOIN LATERAL unnest(r.acked_domains) AS d(domain) "
        "ON CONFLICT DO NOTHING"
    )

    op.create_table(
        "deletion_attempts",
        sa.Column("request_id", pg.UUID(as_uuid=True),
                  sa.ForeignKey("deletion_requests.request_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("attempt", sa.Integer(), primary_key=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_by", sa.String(64), nullable=False),
        sa.Column("event_id", pg.UUID(as_uuid=True)),
        sa.CheckConstraint("attempt >= 1", name="ck_deletion_attempt_positive"),
    )
    op.execute(
        "INSERT INTO deletion_attempts (request_id, attempt, sent_at, sent_by) "
        "SELECT request_id, 1, requested_at, 'user' FROM deletion_requests"
    )

    op.create_table(
        "deletion_idempotency_keys",
        sa.Column("actor_id", sa.String(64), primary_key=True),
        sa.Column("key", sa.String(128), primary_key=True),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("status_code", sa.Integer()),
        sa.Column("response", pg.JSONB()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("deletion_idempotency_keys")
    op.drop_table("deletion_attempts")
    op.drop_table("deletion_domain_acks")
    op.drop_index("ix_deletion_requests_requested", table_name="deletion_requests")
    op.drop_index("ix_deletion_requests_due", table_name="deletion_requests")
    op.drop_index("uq_deletion_requests_open", table_name="deletion_requests")
    for name in ("ck_deletion_stuck_at", "ck_deletion_completed", "ck_deletion_attempts", "ck_deletion_status"):
        op.drop_constraint(name, "deletion_requests", type_="check")
    op.execute("UPDATE deletion_requests SET status = 'REQUESTED' WHERE status = 'STUCK'")
    op.create_check_constraint("ck_deletion_status", "deletion_requests", "status IN ('REQUESTED','COMPLETED')")
    op.create_index("uq_deletion_requests_open", "deletion_requests", ["user_id"], unique=True,
                    postgresql_where=sa.text("status = 'REQUESTED'"))
    for column in ("last_retry_by", "stuck_at", "next_retry_at", "last_sent_at", "attempts"):
        op.drop_column("deletion_requests", column)

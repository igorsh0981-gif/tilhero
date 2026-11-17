"""tickets, messages, status_history, escalations, sla_policies (+ seed) + outbox/inbox

Revision ID: 0001
Revises:
Create Date: 2026-10-08
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_common.migrations import create_messaging_tables, drop_messaging_tables

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATUSES = "('NEW','IN_PROGRESS','WAITING_CUSTOMER','RESOLVED','CLOSED')"
PRIORITIES = "('low','normal','high','urgent')"
CATEGORIES = (
    "('EVENT_RECOMMENDATION','TICKET_SOURCE','FLIGHT','HOTEL','PRICE','SUBSCRIPTION_PAYMENT',"
    "'ACCOUNT','PERSONAL_DATA','BUG','OTHER')"
)


def upgrade() -> None:
    op.execute("CREATE SEQUENCE ticket_number_seq START WITH 3000 MINVALUE 3000")
    op.create_table(
        "tickets",
        sa.Column("ticket_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "number", sa.BigInteger(), nullable=False, server_default=sa.text("nextval('ticket_number_seq')")
        ),
        sa.Column("user_id", pg.UUID(as_uuid=True)),
        sa.Column("channel", sa.String(32), nullable=False),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("subject", sa.String(120), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("priority", sa.String(10), nullable=False),
        sa.Column("assignee_id", sa.String(64)),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("request_fingerprint", sa.String(64)),
        sa.Column("context", pg.JSONB()),
        sa.Column("correlation_id", sa.String(64)),
        sa.Column("sla_first_response_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sla_resolution_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("first_response_at", sa.DateTime(timezone=True)),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
        sa.Column("closed_at", sa.DateTime(timezone=True)),
        sa.Column("anonymized_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_message_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_unread_operator_replies", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("number", name="uq_tickets_number"),
        # Idempotency-Key создания обращения: повтор возвращает тот же тикет (CONVENTIONS §2)
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_tickets_user_idempotency"),
        sa.CheckConstraint(f"status IN {STATUSES}", name="ck_tickets_status"),
        sa.CheckConstraint(f"priority IN {PRIORITIES}", name="ck_tickets_priority"),
        sa.CheckConstraint(f"category IN {CATEGORIES}", name="ck_tickets_category"),
        sa.CheckConstraint("user_unread_operator_replies >= 0", name="ck_tickets_unread"),
    )
    op.execute("ALTER SEQUENCE ticket_number_seq OWNED BY tickets.number")
    op.create_index("ix_tickets_user_number", "tickets", ["user_id", "number"])
    op.create_index("ix_tickets_status", "tickets", ["status"])
    op.create_index("ix_tickets_assignee", "tickets", ["assignee_id"])
    op.create_index("ix_tickets_category_priority", "tickets", ["category", "priority"])

    op.create_table(
        "messages",
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("message_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "ticket_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("tickets.ticket_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sender_type", sa.String(16), nullable=False),
        sa.Column("visibility", sa.String(16), nullable=False),
        sa.Column("author_id", sa.String(64)),
        sa.Column("author_name", sa.String(80)),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("client_key", sa.String(128)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("seq", name="uq_messages_seq"),
        sa.UniqueConstraint("ticket_id", "client_key", name="uq_messages_client_key"),
        sa.CheckConstraint("sender_type IN ('user','operator','system')", name="ck_messages_sender"),
        sa.CheckConstraint("visibility IN ('public','internal')", name="ck_messages_visibility"),
        # Внутренняя заметка может быть только у сотрудника; клиентское сообщение всегда публичное
        sa.CheckConstraint(
            "visibility = 'public' OR sender_type = 'operator'", name="ck_messages_internal_staff"
        ),
    )
    op.create_index("ix_messages_ticket_seq", "messages", ["ticket_id", "seq"])
    op.create_index("ix_messages_user_rate", "messages", ["sender_type", "created_at"])

    op.create_table(
        "status_history",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), primary_key=True),
        sa.Column(
            "ticket_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("tickets.ticket_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("from_status", sa.String(20)),
        sa.Column("to_status", sa.String(20), nullable=False),
        sa.Column("changed_by", sa.String(16), nullable=False),
        sa.Column("actor_id", sa.String(64)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(f"to_status IN {STATUSES}", name="ck_status_history_to"),
        sa.CheckConstraint("changed_by IN ('user','operator','system')", name="ck_status_history_by"),
    )
    op.create_index("ix_status_history_ticket", "status_history", ["ticket_id", "id"])

    op.create_table(
        "escalations",
        sa.Column("escalation_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "ticket_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("tickets.ticket_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="OPEN"),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("ticket_id", "idempotency_key", name="uq_escalations_idempotency"),
        sa.CheckConstraint(
            "type IN ('billing_review','provider_issue','content_review','security_privacy')",
            name="ck_escalations_type",
        ),
        sa.CheckConstraint("status IN ('OPEN','DONE')", name="ck_escalations_status"),
    )
    op.create_index("ix_escalations_ticket", "escalations", ["ticket_id", "created_at"])

    sla = op.create_table(
        "sla_policies",
        sa.Column("category", sa.String(32), primary_key=True),
        sa.Column("priority", sa.String(10), primary_key=True),
        sa.Column("first_response_minutes", sa.Integer(), nullable=False),
        sa.Column("resolution_minutes", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_by", sa.String(64)),
        sa.CheckConstraint(f"priority IN {PRIORITIES}", name="ck_sla_priority"),
        sa.CheckConstraint(
            "first_response_minutes > 0 AND resolution_minutes > first_response_minutes",
            name="ck_sla_minutes",
        ),
    )
    # Сид: SLA по приоритету для любой категории ('*'). Приоритет по умолчанию: ACCOUNT и PERSONAL_DATA — high,
    # остальные — normal (код domain/constants.py). urgent — для ручного повышения оператором.
    op.bulk_insert(
        sla,
        [
            {"category": "*", "priority": "low", "first_response_minutes": 480, "resolution_minutes": 4320},
            {
                "category": "*",
                "priority": "normal",
                "first_response_minutes": 120,
                "resolution_minutes": 1440,
            },
            {"category": "*", "priority": "high", "first_response_minutes": 60, "resolution_minutes": 480},
            {"category": "*", "priority": "urgent", "first_response_minutes": 30, "resolution_minutes": 240},
        ],
    )

    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.drop_table("sla_policies")
    op.drop_table("escalations")
    op.drop_table("status_history")
    op.drop_table("messages")
    op.drop_table("tickets")
    op.execute("DROP SEQUENCE IF EXISTS ticket_number_seq")

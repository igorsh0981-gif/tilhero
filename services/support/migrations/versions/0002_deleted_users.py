"""deleted_users (ревью спринта 1, P3); индекс лимита сообщений клиента по обращению (ревью #21)

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-08
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "deleted_users",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("request_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    # Глобальный (sender_type, created_at) сканировал сообщения всех пользователей за час
    op.drop_index("ix_messages_user_rate", table_name="messages")
    op.create_index(
        "ix_messages_ticket_sender_created", "messages", ["ticket_id", "sender_type", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_messages_ticket_sender_created", table_name="messages")
    op.create_index("ix_messages_user_rate", "messages", ["sender_type", "created_at"])
    op.drop_table("deleted_users")

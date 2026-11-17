"""Права роли сервиса на журнал: только SELECT и INSERT (ревью спринта 1, P4)

Схема и таблицы принадлежат роли-владельцу миграций (audit_owner, infra/db/bootstrap.sql). Роль сервиса
(audit) получает DML через DEFAULT PRIVILEGES; здесь у всех ролей, кроме владельца, отзываются UPDATE, DELETE,
TRUNCATE на audit_records. Не будучи владельцем, роль сервиса не может и снять триггер неизменяемости
(ALTER TABLE … DISABLE TRIGGER) — append-only держится на правах, а не только на триггере.
Если миграции идут под той же ролью, что и сервис (dev без разделения ролей), отзывать нечего.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-08
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("REVOKE UPDATE, DELETE, TRUNCATE ON audit_records FROM PUBLIC")
    op.execute(
        """
        DO $$
        DECLARE r record;
        BEGIN
          FOR r IN
            SELECT DISTINCT grantee FROM information_schema.role_table_grants
            WHERE table_schema = current_schema() AND table_name = 'audit_records'
              AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
              AND grantee <> current_user AND grantee <> 'PUBLIC'
          LOOP
            EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON audit_records FROM %I', r.grantee);
          END LOOP;
        END $$;
        """
    )


def downgrade() -> None:
    # Права не возвращаются автоматически: выдача UPDATE/DELETE журналу — осознанное ручное действие.
    pass

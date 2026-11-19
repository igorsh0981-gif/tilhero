"""admin_learner_summary.search_text — пересчёт без username (ревью P2-9)

Ревью T2-3 (35c3fd1): подстрочный поиск — только по отображаемому имени (`domain.projection.search_text`); username
для большинства ролей маскируется и ищется только точным `q=@username`, ученик — точным UUID. Строки, записанные до
35c3fd1, хранили lower(имя + username), и подстрочный поиск по ним восстанавливал замаскированный username по буквам.
Пересчёт всех строк пачками по user_id. Строку, имя которой изменилось между чтением и записью (событие или сверка
параллельно с миграцией), не трогаем: её search_text уже записал код сервиса.

Откат данных не возвращает: username в search_text — дефект, а не состояние схемы.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql as pg

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

BATCH = 1000
learners = sa.table(
    "admin_learner_summary",
    sa.column("user_id", pg.UUID(as_uuid=True)),
    sa.column("display_name", sa.String(160)),
    sa.column("search_text", sa.Text()),
)


def search_text(display_name: str | None) -> str | None:
    """Как `tilhero_user_admin.domain.projection.search_text` (миграция от кода сервиса не зависит; тест сверяет)."""
    text = (display_name or "").strip().lower()
    return text or None


def upgrade() -> None:
    if context.is_offline_mode():  # SQL-скрипт (`alembic upgrade --sql`): то же средствами PostgreSQL
        op.execute("UPDATE admin_learner_summary SET search_text = nullif(lower(btrim(display_name)), '') "
                   "WHERE search_text IS DISTINCT FROM nullif(lower(btrim(display_name)), '')")
        return
    bind = op.get_bind()
    fix = (
        sa.update(learners)
        .where(learners.c.user_id == sa.bindparam("uid"),
               learners.c.display_name.is_not_distinct_from(sa.bindparam("name")))
        .values(search_text=sa.bindparam("text"))
    )
    last = None
    while True:
        stmt = (sa.select(learners.c.user_id, learners.c.display_name, learners.c.search_text)
                .order_by(learners.c.user_id).limit(BATCH))
        if last is not None:
            stmt = stmt.where(learners.c.user_id > last)
        rows = bind.execute(stmt).all()
        if not rows:
            break
        changes = [
            {"uid": user_id, "name": name, "text": search_text(name)}
            for user_id, name, current in rows
            if current != search_text(name)
        ]
        if changes:
            bind.execute(fix, changes)
        last = rows[-1][0]


def downgrade() -> None:
    """Данные не возвращаются (username в search_text — дефект P2-9); схема не менялась."""

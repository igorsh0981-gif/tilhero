"""Выгрузка профилей для начальной загрузки проекций (спринт 7, повторное ревью бэкенда Н1; docs/sprint7/INTERNAL_API.md
§6). gamification проверяет возраст и согласие родителя (общая лига) по проекции user.profile.updated.v1, а стрим
хранит события 7 дней — у давних учеников проекции нет. GET /internal/v1/export/profiles отдаёт тот же снимок.

- Только неудалённые: статус ACTIVE и DISABLED; DELETION_REQUESTED и DELETED не выгружаются (их удаляет сага —
  выгрузка не должна возвращать проекцию удаляемого ученика).
- age_band и guardian_consent — `service.profile_projection`, та же функция, что строит событие.
- Без username, Telegram ID, имени, языка и прочего: только user_id, kind, age_band, guardian_consent, updated_at.
- Курсор — по user_id (стабильный порядок; набор может меняться между страницами — изменения после начала выгрузки
  приходят событиями, проекция сравнивает updated_at).
"""

from __future__ import annotations

from sqlalchemy import select

from tilhero_common.app import Runtime
from tilhero_identity.audience import decode_cursor, encode_cursor
from tilhero_identity.models import User
from tilhero_identity.schemas import ProfileExportItem, ProfileExportPage
from tilhero_identity.service import profile_projection

EXPORT_DEFAULT_LIMIT = 500
EXPORT_MAX_LIMIT = 1000
EXPORTED_STATUSES = ("ACTIVE", "DISABLED")


class ProfileExport:
    def __init__(self, runtime: Runtime) -> None:
        self.rt = runtime

    async def page(self, *, cursor: str | None, limit: int) -> ProfileExportPage:
        stmt = select(User).where(User.status.in_(EXPORTED_STATUSES))
        if cursor:
            stmt = stmt.where(User.user_id > decode_cursor(cursor))
        stmt = stmt.order_by(User.user_id).limit(limit + 1)
        async with self.rt.transaction() as session:
            rows = list((await session.execute(stmt)).scalars().all())
        page = rows[:limit]
        items = [ProfileExportItem(user_id=u.user_id, kind=u.kind, updated_at=u.updated_at,  # type: ignore[arg-type]
                                   **profile_projection(u))  # type: ignore[arg-type]
                 for u in page]
        next_cursor = encode_cursor(page[-1].user_id) if len(rows) > limit else None
        return ProfileExportPage(items=items, next_cursor=next_cursor)

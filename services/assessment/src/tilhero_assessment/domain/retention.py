"""Срок хранения текстов ученика в assessment (ревью R1-14; PLAN «Хранение реплик»).

- `appeals.reason` (свободный текст ученика) — через `appeal_reason_retention_days` (90) после решения апелляции
  заменяется на NULL, `reason_redacted_at` — время стирания; сотрудник видит пометку «стёрт по сроку хранения».
  Нерешённая апелляция не стирается (её ещё рассматривают).
- Оценки (evaluations, append-only) не трогаются: цитаты-доказательства ошибок ≤ 120 символов и их исправления
  остаются в assessment (PLAN: «оценка и доказательства-цитаты остаются в assessment»); копию оценки с цитатами
  и исправлениями через 90 дней стирает lessons (`lessons-tick`).

Запуск — `POST /internal/v1/assessment:tick` (n8n `assessment-tick`, SCHEDULER_TOKEN). Повтор безопасен: стёртое
не выбирается снова; пачка ограничена, параллельный tick пропускает строки под блокировкой (SKIP LOCKED).
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_assessment.models import Appeal

DECIDED = ("upheld", "corrected")


async def redact_appeal_reasons(session: AsyncSession, now: datetime, *, days: int, batch: int) -> int:
    """Стереть тексты решённых апелляций старше `days` дней после решения (не больше `batch` за раз)."""
    cutoff = now - timedelta(days=days)
    due = (select(Appeal.appeal_id)
           .where(Appeal.reason.is_not(None), Appeal.status.in_(DECIDED), Appeal.decided_at.is_not(None),
                  Appeal.decided_at < cutoff)
           .order_by(Appeal.decided_at).limit(batch).with_for_update(skip_locked=True))
    ids = list((await session.execute(due)).scalars().all())
    if not ids:
        return 0
    await session.execute(update(Appeal).where(Appeal.appeal_id.in_(ids))
                          .values(reason=None, reason_redacted_at=now)
                          .execution_options(synchronize_session=False))
    return len(ids)

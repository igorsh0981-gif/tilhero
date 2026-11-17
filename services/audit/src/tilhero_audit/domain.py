"""Журнал с хеш-цепочкой.

hash = sha256(prev_hash + canonical_json(запись)). Схема как в FinAdvisor (conversation/app/main.py, /audit-log),
но с исправлением гонки: добавление сериализуется pg_advisory_xact_lock, иначе две параллельные записи
получают одинаковый prev_hash и цепочка разветвляется. Проверка пересчитывает хеши, а не только ссылки.
"""

from __future__ import annotations

import base64
import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_audit.models import AuditRecord
from tilhero_audit.schemas import ChainVerification, RecordIn

GENESIS = "0" * 64
_LOCK_KEY = 7_340_001  # стабильный ключ advisory lock для цепочки


def canonical(record: dict[str, Any]) -> str:
    return json.dumps(record, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)


def _hash_fields(rec: AuditRecord | dict[str, Any]) -> dict[str, Any]:
    get = (lambda k: rec[k]) if isinstance(rec, dict) else (lambda k: getattr(rec, k))
    occurred = get("occurred_at")
    if isinstance(occurred, datetime):
        occurred = occurred.astimezone(UTC).isoformat()
    return {
        "record_id": str(get("record_id")),
        "occurred_at": occurred,
        "source": get("source"),
        "actor_type": get("actor_type"),
        "actor_id": get("actor_id"),
        "actor_role": get("actor_role"),
        "action": get("action"),
        "object_type": get("object_type"),
        "object_id": get("object_id"),
        "before": get("before"),
        "after": get("after"),
        "reason": get("reason"),
    }


def compute_hash(prev_hash: str, fields: dict[str, Any]) -> str:
    return hashlib.sha256((prev_hash + canonical(fields)).encode("utf-8")).hexdigest()


async def append(session: AsyncSession, data: RecordIn, *, source: str) -> AuditRecord:
    """Идемпотентно по record_id: повтор возвращает существующую запись."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _LOCK_KEY})
    existing = (await session.execute(select(AuditRecord).where(AuditRecord.record_id == data.record_id))).scalar()
    if existing is not None:
        return existing
    last = (await session.execute(select(AuditRecord.hash).order_by(AuditRecord.seq.desc()).limit(1))).scalar()
    prev_hash = last or GENESIS
    values = data.model_dump()
    values["source"] = source
    values["occurred_at"] = data.occurred_at.astimezone(UTC)
    record = AuditRecord(**values, prev_hash=prev_hash, hash=compute_hash(prev_hash, _hash_fields(values)))
    session.add(record)
    await session.flush()
    return record


def encode_cursor(seq: int) -> str:
    return base64.urlsafe_b64encode(str(seq).encode()).decode()


def decode_cursor(cursor: str) -> int:
    return int(base64.urlsafe_b64decode(cursor.encode()).decode())


async def verify_chain(session: AsyncSession, batch: int = 1000) -> ChainVerification:
    prev = GENESIS
    checked = 0
    first_seq: int | None = None
    last_seq: int | None = None
    after = 0
    while True:
        rows = (
            await session.execute(
                select(AuditRecord).where(AuditRecord.seq > after).order_by(AuditRecord.seq).limit(batch)
            )
        ).scalars().all()
        if not rows:
            break
        for rec in rows:
            first_seq = first_seq if first_seq is not None else rec.seq
            if rec.prev_hash != prev or compute_hash(rec.prev_hash, _hash_fields(rec)) != rec.hash:
                return ChainVerification(valid=False, checked=checked, first_seq=first_seq, last_seq=last_seq,
                                         broken_at_seq=rec.seq)
            prev = rec.hash
            checked += 1
            last_seq = rec.seq
        after = rows[-1].seq
    return ChainVerification(valid=True, checked=checked, first_seq=first_seq, last_seq=last_seq)


# Отображение событий Telegram-контура в записи журнала (security/consent/deletion — ТЗ Admin §10).
EVENT_ACTIONS: dict[str, tuple[str, str]] = {
    "consent.accepted.v1": ("consent.accept", "consent"),
    "consent.revoked.v1": ("consent.revoke", "consent"),
    "user.deletion.requested.v1": ("user.deletion_request", "user"),
    "user.status.changed.v1": ("user.status_change", "user"),
    "user.security.changed.v1": ("user.security_change", "user"),
}

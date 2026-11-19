"""Медиа: загрузка аудио (blob), автоприостановка по истечению прав (catalog:tick), сводка для обзора админки.

Аудио: JSON base64 ≤ 3 МБ, тип audio/mpeg | audio/ogg | audio/mp4, сигнатура файла должна совпадать с типом
(ID3 или кадр MPEG; OggS; ftyp) — иначе 422 AUDIO_INVALID {reason}. Одинаковый файл (sha256) не дублируется.

catalog:tick (AT-29, INTERNAL_API §1.3): опубликованные media_asset с `valid_to` < сегодня (Asia/Tashkent) →
suspended (rights_expired), указатель снят — ученики материал не видят; событие catalog.media.suspended.v1 и аудит
от system. Повтор безопасен: приостановленная версия не опубликована и повторно не обрабатывается.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import uuid
from datetime import date, datetime
from typing import Any, Final

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_catalog.content import CONTENT_KINDS, payload_title
from tilhero_catalog.domain.common import (
    MEDIA_SUSPENDED,
    audit_payload,
    emit_audit,
    emit_event,
    iso_z,
    utcnow,
    version_object_id,
)
from tilhero_catalog.domain.requests import new_count
from tilhero_catalog.domain.versions import lock_graph, lock_key, pointer_of, published_rows
from tilhero_catalog.models import ContentPointer, ContentVersion, MediaBlob
from tilhero_common.errors import ApiError, not_found, unprocessable
from tilhero_common.internal_auth import Actor

MAX_AUDIO_BYTES: Final = 3 * 1024 * 1024
AUDIO_TYPES: Final = ("audio/mpeg", "audio/ogg", "audio/mp4")


def audio_invalid(reason: str, message: str) -> ApiError:
    return unprocessable("AUDIO_INVALID", message, {"reason": reason})


def sniff_audio(data: bytes) -> str | None:
    """Тип по сигнатуре: ID3v2 / кадр MPEG (11 бит синхронизации) → audio/mpeg; OggS → audio/ogg;
    ftyp в байтах 4..8 (ISO BMFF, m4a) → audio/mp4."""
    if data[:3] == b"ID3" or (len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "audio/mpeg"
    if data[:4] == b"OggS":
        return "audio/ogg"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "audio/mp4"
    return None


def decode_audio(content_type: str, data_base64: str) -> bytes:
    if content_type not in AUDIO_TYPES:
        raise audio_invalid("type", "Поддерживаются mp3, ogg и m4a")
    try:
        data = base64.b64decode(data_base64, validate=True)
    except (binascii.Error, ValueError):
        raise audio_invalid("encoding", "Файл повреждён: ожидается base64") from None
    if not data:
        raise audio_invalid("empty", "Пустой файл")
    if len(data) > MAX_AUDIO_BYTES:
        raise audio_invalid("size", "Файл больше 3 МБ")
    if sniff_audio(data) != content_type:
        raise audio_invalid("signature", "Содержимое файла не соответствует типу аудио")
    return data


def blob_view(b: MediaBlob) -> dict[str, Any]:
    return {"blob_id": str(b.blob_id), "content_type": b.content_type, "size": b.size, "sha256": b.sha256,
            "created_at": iso_z(b.created_at)}


async def store_blob(session: AsyncSession, content_type: str, data: bytes, actor: Actor) -> tuple[MediaBlob, bool]:
    digest = hashlib.sha256(data).hexdigest()
    existing = (await session.execute(select(MediaBlob).where(MediaBlob.sha256 == digest,
                                                              MediaBlob.content_type == content_type)
                                      .limit(1))).scalar_one_or_none()
    if existing is not None:
        return existing, False
    blob = MediaBlob(blob_id=uuid.uuid4(), content_type=content_type, bytes=data, size=len(data), sha256=digest,
                     uploaded_by=actor.id, created_at=utcnow())
    session.add(blob)
    await session.flush()
    await emit_audit(session, audit_payload(actor, "content.blob_uploaded", "media_blob", str(blob.blob_id),
                                            after={"content_type": content_type, "size": len(data),
                                                   "sha256": digest}))
    return blob, True


async def get_blob(session: AsyncSession, blob_id: uuid.UUID) -> MediaBlob:
    blob = await session.get(MediaBlob, blob_id)
    if blob is None:
        raise not_found("BLOB_NOT_FOUND", "Аудиофайл не найден")
    return blob


# ---------------------------------------------------------------- catalog:tick


def _expired(payload: dict[str, Any], today: date) -> bool:
    valid_to = (payload.get("rights") or {}).get("valid_to")
    try:
        return bool(valid_to) and date.fromisoformat(str(valid_to)) < today
    except ValueError:
        return False


async def suspend_expired(session: AsyncSession, today: date, now: datetime | None = None) -> int:
    now = now or utcnow()
    suspended = 0
    candidates = [c for c in await published_rows(session, "media_asset") if _expired(c.payload, today)]
    if candidates:
        await lock_graph(session)  # сначала граф, потом ключи — как у публикации
    for candidate in candidates:
        await lock_key(session, "media_asset", candidate.key)
        row = (await session.execute(select(ContentVersion).where(ContentVersion.id == candidate.id)
                                     .with_for_update().execution_options(populate_existing=True))).scalar_one()
        if row.status != "published":
            continue  # параллельный tick или снятие с публикации уже обработали
        ptr = await pointer_of(session, row.kind, row.key, for_update=True)
        row.status = "suspended"
        row.suspended_at = now
        row.suspend_reason = "rights_expired"
        ptr.previous_version = row.version
        ptr.published_version = None
        ptr.updated_at = now
        await session.flush()
        await emit_event(session, MEDIA_SUSPENDED, {"asset_id": row.key, "version": row.version,
                                                    "reason": "rights_expired", "suspended_at": iso_z(now)})
        await emit_audit(session, audit_payload(
            None, "media.suspended", "content_version", version_object_id(row.kind, row.key, row.version),
            before={"status": "published"}, after={"status": "suspended", "suspend_reason": "rights_expired",
                                                   "valid_to": row.payload["rights"]["valid_to"]},
            reason="rights_expired", actor_type="system"))
        suspended += 1
    return suspended


async def rights_expiring(session: AsyncSession, today: date, warning_days: int) -> list[dict[str, Any]]:
    out = []
    for row in await published_rows(session, "media_asset"):
        valid_to = (row.payload.get("rights") or {}).get("valid_to")
        if not valid_to:
            continue
        days = (date.fromisoformat(valid_to) - today).days
        if 0 <= days <= warning_days:
            out.append({"asset_id": row.key, "title": payload_title("media_asset", row.payload),
                        "valid_to": valid_to})
    return sorted(out, key=lambda r: (r["valid_to"], r["asset_id"]))


# ---------------------------------------------------------------- сводка для обзора


async def summary(session: AsyncSession, today: date, warning_days: int) -> dict[str, Any]:
    """ContentSummary (admin.ts)."""
    by_kind: dict[str, dict[str, int]] = {k: {"published": 0, "drafts": 0, "in_review": 0} for k in CONTENT_KINDS}
    published = (await session.execute(select(ContentPointer.kind, func.count()).where(
        ContentPointer.published_version.is_not(None)).group_by(ContentPointer.kind))).all()
    for kind, n in published:
        by_kind[kind]["published"] = int(n)
    open_counts = (await session.execute(select(ContentVersion.kind, ContentVersion.status, func.count()).where(
        ContentVersion.status.in_(("draft", "in_review"))).group_by(ContentVersion.kind, ContentVersion.status)
    )).all()
    for kind, status, n in open_counts:
        by_kind[kind]["drafts" if status == "draft" else "in_review"] = int(n)
    suspended = await session.scalar(
        select(func.count(func.distinct(ContentVersion.key)))
        .select_from(ContentVersion)
        .join(ContentPointer, (ContentPointer.kind == ContentVersion.kind) & (ContentPointer.key == ContentVersion.key))
        .where(ContentVersion.kind == "media_asset", ContentVersion.status == "suspended",
               ContentPointer.published_version.is_(None)))
    return {
        "by_kind": by_kind,
        "in_review": sum(v["in_review"] for v in by_kind.values()),
        "rights_expiring": await rights_expiring(session, today, warning_days),
        "suspended_media": int(suspended or 0),
        "new_media_requests": await new_count(session),
    }

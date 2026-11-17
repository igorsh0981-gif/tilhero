"""Непрозрачный курсор keyset-пагинации центра: base64url(JSON {t, i}). Ошибка разбора → 400 INVALID_CURSOR."""

from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime

from tilhero_common.errors import bad_request


def encode_cursor(created_at: datetime, notification_id: uuid.UUID) -> str:
    raw = json.dumps({"t": created_at.isoformat(), "i": str(notification_id)}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        if len(cursor) > 512:
            raise ValueError("too long")
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        if not isinstance(data, dict):
            raise ValueError("shape")
        created_at = datetime.fromisoformat(str(data["t"]))
        if created_at.tzinfo is None:
            raise ValueError("naive time")
        return created_at, uuid.UUID(str(data["i"]))
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc

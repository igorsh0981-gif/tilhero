"""Непрозрачный курсор keyset-пагинации: base64url(JSON). Ошибка разбора → 400 INVALID_CURSOR."""

from __future__ import annotations

import base64
import json
from typing import Any

from tilhero_common.errors import bad_request


def encode_cursor(data: dict[str, Any]) -> str:
    raw = json.dumps(data, separators=(",", ":"), sort_keys=True, default=str).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str, required: set[str]) -> dict[str, Any]:
    try:
        if len(cursor) > 512:
            raise ValueError("too long")
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        if not isinstance(data, dict) or not required.issubset(data):
            raise ValueError("shape")
        return data
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc

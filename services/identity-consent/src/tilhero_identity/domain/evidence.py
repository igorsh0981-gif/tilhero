"""Доказательство согласия: evidence_hash = sha256(канонический JSON фактов согласия).

Канонический JSON: ключи по алфавиту, без пробелов, UTF-8; accepted_at — ISO-8601 UTC с миллисекундами и «Z».
policy_text_sha256 фиксирует, какой именно текст политики видел пользователь (на его языке); basis — основание
(`self` — сам пользователь, `guardian` — родитель за ребёнка 6–13, granted_by — аккаунт родителя); age_band —
возрастная группа на момент согласия.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import Any


def canonical_json(data: dict[str, Any]) -> str:
    return json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def truncate_ms(dt: datetime) -> datetime:
    """Хранимое время согласия обрезается до миллисекунд — чтобы хеш пересчитывался из БД без потерь."""
    dt = dt.astimezone(UTC)
    return dt.replace(microsecond=(dt.microsecond // 1000) * 1000)


def iso_utc_ms(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def evidence_document(
    *,
    user_id: uuid.UUID | str,
    policy_version: str,
    purposes: list[str],
    accepted_at: datetime,
    channel: str,
    locale: str,
    policy_text_sha256: str,
    age_band: str | None,
    basis: str,
    granted_by: uuid.UUID | str | None,
) -> dict[str, Any]:
    return {
        "user_id": str(user_id),
        "policy_version": policy_version,
        "purposes": list(purposes),
        "accepted_at": iso_utc_ms(accepted_at),
        "channel": channel,
        "locale": locale,
        "policy_text_sha256": policy_text_sha256,
        "age_band": age_band,
        "basis": basis,
        "granted_by": str(granted_by) if granted_by is not None else None,
    }


def evidence_hash(**fields: Any) -> str:
    return hashlib.sha256(canonical_json(evidence_document(**fields)).encode("utf-8")).hexdigest()

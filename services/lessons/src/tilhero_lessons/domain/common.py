"""Общее для домена lessons: ошибки (коды bff.ts «Спринт 4»), блокировки, время, воспроизводимое перемешивание."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import uuid
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, bad_request, conflict, forbidden, not_found

PRODUCER = "lessons"
STARTED = "lesson.session.started.v1"
COMPLETED = "lesson.session.completed.v1"
DOMAIN_DELETED = "user.domain.deleted.v1"
AUDIT_EVENT = "admin.audit.recorded.v1"
_LOCK_CLASS = 0x1E55  # класс advisory-блокировок lessons (ученик)

Localized = dict[str, str]


def loc(ru: str, uz: str) -> Localized:
    return {"ru": ru, "uz": uz}


# ---------------------------------------------------------------- ошибки


def lesson_not_available() -> ApiError:
    return not_found("LESSON_NOT_AVAILABLE", "Урок недоступен: не опубликован, не для вашего возраста или пары")


def reading_not_available() -> ApiError:
    return not_found("READING_NOT_AVAILABLE", "Текст недоступен: не опубликован или не для вашего возраста")


def session_not_found() -> ApiError:
    return not_found("SESSION_NOT_FOUND", "Сессия не найдена")


def no_exercises() -> ApiError:
    return not_found("NO_EXERCISES", "К этому материалу пока нет упражнений")


def pair_not_available(pair_id: str) -> ApiError:
    return conflict("PAIR_NOT_AVAILABLE", "Языковая пара пока недоступна", {"pair_id": pair_id})


def session_active(session_id: uuid.UUID, kind: str, title: Localized) -> ApiError:
    return conflict("SESSION_ACTIVE", "Есть незавершённое занятие — продолжите или отмените его",
                    {"session_id": str(session_id), "kind": kind, "title": title})


def session_state(status: str, **extra: Any) -> ApiError:
    return conflict("SESSION_STATE", "Действие недоступно в текущем состоянии занятия", {"status": status, **extra})


def step_not_current(current_step_id: str | None) -> ApiError:
    return conflict("STEP_NOT_CURRENT", "Это не текущий шаг занятия", {"current_step_id": current_step_id})


def hints_not_allowed() -> ApiError:
    return conflict("HINTS_NOT_ALLOWED", "На этом шаге подсказки недоступны")


def kids_not_allowed() -> ApiError:
    return forbidden("KIDS_NOT_ALLOWED", "В детском профиле ответ выбирается из вариантов")


def free_text_not_allowed() -> ApiError:
    return conflict("FREE_TEXT_NOT_ALLOWED", "Сейчас ответ выбирается из вариантов")


def user_deleted() -> ApiError:
    return ApiError(410, "USER_DELETED", "Данные ученика удалены по запросу")


def answer_invalid(field: str, message: str = "Некорректный ответ") -> ApiError:
    return ApiError(422, "ANSWER_INVALID", message, {"field": field})


class IdempotencyReused(Exception):
    pass


# ---------------------------------------------------------------- блокировки, время


async def lock_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    """Сериализация команд одного ученика (старт, шаг, пауза, завершение, tick, сага) до конца транзакции."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"), {"c": _LOCK_CLASS, "o": lock_key(user_id)})


def lock_key(user_id: uuid.UUID) -> int:
    return int.from_bytes(user_id.bytes[:4], "big", signed=True)


async def lock_users(session: AsyncSession, *user_ids: uuid.UUID | None) -> None:
    """Блокировки нескольких учеников в одном порядке (по ключу блокировки) — без взаимных ожиданий. Везде, где
    нужны и ученики, и их строки (комнаты, наборы дуэлей, проекции), сначала берутся блокировки учеников."""
    for uid in sorted({u for u in user_ids if u is not None}, key=lock_key):
        await lock_user(session, uid)


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z") if dt is not None else None


def ceil_minutes(seconds: int) -> int:
    return math.ceil(max(seconds, 0) / 60)


Clock = Callable[[], datetime]


# ---------------------------------------------------------------- воспроизводимость по seed


def digest(*parts: object) -> str:
    return hashlib.sha256(":".join(str(p) for p in parts).encode("utf-8")).hexdigest()


def seeded_order[T](seed: str, salt: str, items: Iterable[T], key: Callable[[T], str]) -> list[T]:
    """Перемешивание по seed сессии (sha256): одинаковый seed — одинаковый порядок (воспроизводимо)."""
    return sorted(items, key=lambda it: digest(seed, salt, key(it)))




# ---------------------------------------------------------------- курсоры


def encode_cursor(*parts: Any) -> str:
    raw = json.dumps(list(parts), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None, arity: int) -> list[Any] | None:
    if cursor is None:
        return None
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        parts = json.loads(raw)
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc
    if not isinstance(parts, list) or len(parts) != arity:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор")
    return parts

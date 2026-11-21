"""Синхронные вызовы gamification (спринт 7, INTERNAL_API §0) — только в командах дуэли, вне транзакций БД:

- social: `GET /internal/v1/relations/{a}/{b}` → {friends, same_family, blocked_any, a_restricted, b_restricted,
  a_audience, b_audience} (+ необязательные a/b_restricted_until, a/b_social_allowed, a/b_member_id);
  `GET /internal/v1/members/{member_id}` → {user_id}. Сбой → 503 UPSTREAM_UNAVAILABLE {service: social};
- lessons: `POST /internal/v1/duel-sets {duel_id, pair_id, level_band, user_ids}` → {set_id} (один набор на дуэль:
  повтор — тот же set_id). Сбой → 503 DUEL_SET_UNAVAILABLE (дуэль остаётся challenged, принятие можно повторить).

Выгрузки для разовой загрузки проекций (bootstrap.py): `GET /internal/v1/export/<name>?cursor=&limit=500` →
{items: [payload события], next_cursor | null} — social `families`, `friendships`; diagnostics `levels`.

Учёба от них не зависит: лиги, награды и проекции работают по событиям. В логи — только тип ошибки и статус.
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError
from tilhero_common.http_client import UpstreamError
from tilhero_gamification.domain.common import upstream_unavailable

log = logging.getLogger("tilhero.gamification.clients")

SOCIAL: Final = "social"
LESSONS: Final = "lessons"
DIAGNOSTICS: Final = "diagnostics"
IDENTITY: Final = "identity-consent"  # выгрузка возраста и согласия (повторное ревью, Н1)
AUDIENCES: Final = ("kids", "teens", "adults")
MEMBER_RE: Final = re.compile(r"^mb_[A-Za-z0-9_-]{22}$")


def duel_set_unavailable() -> ApiError:
    return ApiError(503, "DUEL_SET_UNAVAILABLE", "Задания дуэли сейчас недоступны — попробуйте принять вызов позже")


@dataclass(frozen=True)
class Relations:
    friends: bool
    same_family: bool
    blocked_any: bool
    a_restricted: bool
    b_restricted: bool
    a_audience: str
    b_audience: str
    # social сверх §1.2 (необязательные): конец санкции, доступ к социальному (14–17 — согласие родителя, цель
    # social), member_id обоих
    a_restricted_until: datetime | None = None
    b_restricted_until: datetime | None = None
    a_social_allowed: bool = True
    b_social_allowed: bool = True
    a_member_id: str | None = None
    b_member_id: str | None = None


def _flag(data: dict[str, Any], key: str) -> bool:
    value = data.get(key)
    if not isinstance(value, bool):
        raise ValueError(key)
    return value


def _audience(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if value not in AUDIENCES:
        raise ValueError(key)
    return str(value)


def _ts(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    ts = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return ts if ts.tzinfo is not None else ts.replace(tzinfo=UTC)


def _mid(value: object) -> str | None:
    return value if isinstance(value, str) and MEMBER_RE.match(value) else None


async def relations(rt: Runtime, a: uuid.UUID, b: uuid.UUID) -> Relations | None:
    """Связь двух учеников; None — social не знает ученика (404)."""
    try:
        data = await rt.client(SOCIAL).get(f"/internal/v1/relations/{a}/{b}", subject=str(a))
        if not isinstance(data, dict):
            raise ValueError("relations: not an object")
        return Relations(friends=_flag(data, "friends"), same_family=_flag(data, "same_family"),
                         blocked_any=_flag(data, "blocked_any"), a_restricted=_flag(data, "a_restricted"),
                         b_restricted=_flag(data, "b_restricted"), a_audience=_audience(data, "a_audience"),
                         b_audience=_audience(data, "b_audience"),
                         a_restricted_until=_ts(data.get("a_restricted_until")),
                         b_restricted_until=_ts(data.get("b_restricted_until")),
                         a_social_allowed=data.get("a_social_allowed") is not False,
                         b_social_allowed=data.get("b_social_allowed") is not False,
                         a_member_id=_mid(data.get("a_member_id")), b_member_id=_mid(data.get("b_member_id")))
    except UpstreamError as exc:
        if exc.status == 404:
            return None
        log.warning("social relations unavailable", extra={"error_type": type(exc).__name__, "status": exc.status})
        raise upstream_unavailable(SOCIAL) from None
    except Exception as exc:
        log.warning("social relations failed", extra={"error_type": type(exc).__name__})
        raise upstream_unavailable(SOCIAL) from None


async def member_user(rt: Runtime, member_id: str) -> uuid.UUID | None:
    """member_id → user_id через social; None — нет такого участника (404)."""
    try:
        data = await rt.client(SOCIAL).get(f"/internal/v1/members/{member_id}")
        return uuid.UUID(str(data["user_id"])) if isinstance(data, dict) else None
    except UpstreamError as exc:
        if exc.status == 404:
            return None
        log.warning("social members unavailable", extra={"error_type": type(exc).__name__, "status": exc.status})
        raise upstream_unavailable(SOCIAL) from None
    except (KeyError, ValueError, TypeError):
        log.warning("social members malformed")
        raise upstream_unavailable(SOCIAL) from None
    except Exception as exc:
        log.warning("social members failed", extra={"error_type": type(exc).__name__})
        raise upstream_unavailable(SOCIAL) from None


async def duel_set(rt: Runtime, duel_id: uuid.UUID, pair_id: str, level_band: str,
                   user_ids: list[uuid.UUID]) -> uuid.UUID:
    """Набор заданий дуэли в lessons (идемпотентно по duel_id). Любой сбой → 503 DUEL_SET_UNAVAILABLE."""
    body = {"duel_id": str(duel_id), "pair_id": pair_id, "level_band": level_band,
            "user_ids": [str(u) for u in user_ids]}
    try:
        data = await rt.client(LESSONS).post("/internal/v1/duel-sets", json=body,
                                             idempotency_key=f"duel-set:{duel_id}")
        return uuid.UUID(str(data["set_id"]))
    except Exception as exc:
        log.warning("lessons duel-sets failed", extra={"error_type": type(exc).__name__,
                                                       "status": getattr(exc, "status", None)})
        raise duel_set_unavailable() from None


async def export_page(rt: Runtime, service: str, name: str, cursor: str | None,
                      limit: int) -> tuple[list[dict[str, Any]], str | None]:
    """Страница выгрузки источника. Сбой или неверная форма — исключение (загрузка повторится позже)."""
    params: dict[str, Any] = {"limit": limit}
    if cursor:
        params["cursor"] = cursor
    data = await rt.client(service).get(f"/internal/v1/export/{name}", params=params)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise ValueError(f"export {name}: malformed page")
    nxt = data.get("next_cursor")
    if nxt is not None and (not isinstance(nxt, str) or not nxt or len(nxt) > 500):
        raise ValueError(f"export {name}: malformed cursor")
    return [i for i in data["items"] if isinstance(i, dict)], nxt

"""Общие зависимости API catalog: вызывающие, ученик из токена, Idempotency-Key, вход планировщика, политика."""

from __future__ import annotations

import hmac
import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, cast

from fastapi import Header, Request
from fastapi.responses import JSONResponse
from redis.exceptions import RedisError

from tilhero_catalog.domain.common import local_today
from tilhero_catalog.domain.versions import Policy
from tilhero_catalog.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.errors import forbidden, unauthorized
from tilhero_common.internal_auth import HEADER, Actor, InternalAuth, Principal
from tilhero_common.redis_tools import IdempotencyStore, fingerprint

log = logging.getLogger("tilhero.catalog.api")

# Вызывающие (INTERNAL_API §1.4–1.5 спринта 3, §4 спринта 4): сотрудники — только admin-bff с actor; ученик —
# telegram-bff (заявки на песни и фильмы — только он); снимок курса и пары — ещё learning-plan, diagnostics и lessons;
# каталог сценариев и медиа (карточки, детали) — telegram-bff и lessons; аудио — только telegram-bff (прокси для
# Mini App); заявка по id — notifications; версии контента с ключами — только lessons и assessment; упражнения
# к медиа (без ключей) — lessons.
staff_auth = InternalAuth({"admin-bff"})
learner_auth = InternalAuth({"telegram-bff"})
content_readers = InternalAuth({"telegram-bff", "lessons"})
course_readers = InternalAuth({"telegram-bff", "learning-plan", "diagnostics", "lessons"})
request_readers = InternalAuth({"telegram-bff", "notifications"})
version_readers = InternalAuth({"lessons", "assessment"})
exercise_readers = InternalAuth({"lessons"})
no_service = InternalAuth(set())

IdempotencyKey = Header(default=None, alias="Idempotency-Key", min_length=8, max_length=128,
                        pattern=r"^[A-Za-z0-9_\-:.]+$")
KIDS_AGE_BANDS = frozenset({"6-9", "10-13"})


def settings_of(rt: Runtime) -> Settings:
    return cast(Settings, rt.settings)


def now_of(rt: Runtime) -> datetime:
    """Часы сервиса (UTC). Тесты подменяют `runtime.clock`, чтобы проверять сроки прав детерминированно."""
    clock = getattr(rt, "clock", None)
    return cast(datetime, clock()) if callable(clock) else datetime.now(UTC)


def policy_of(rt: Runtime) -> Policy:
    s = settings_of(rt)
    return Policy(today=local_today(s.timezone, now_of(rt)), external_sources=s.media_external_sources)


def require_any(principal: Principal, *permissions: str) -> Actor:
    """Хотя бы одно из прав (сводка: dashboard.read | content.read)."""
    if principal.actor is None:
        raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
    if not set(permissions) & principal.actor.permissions:
        raise forbidden("PERMISSION_DENIED", "Недостаточно прав", {"permission": permissions[0]})
    return principal.actor


def subject_id(principal: Principal) -> uuid.UUID:
    """Ученик/аккаунт — только из sub внутреннего токена (защита от IDOR)."""
    try:
        return uuid.UUID(principal.user_id)
    except ValueError:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from None


def is_child_profile(principal: Principal) -> bool:
    """Детский профиль 6–13: активный ученик (`lrn`) не совпадает с аккаунтом (`sub`), или возраст ребёнка
    (`age_band`) — заявки на песни и фильмы только из аккаунта (CONVENTIONS §8, AT-38)."""
    lrn = principal.claims.get("lrn")
    if isinstance(lrn, str) and lrn and lrn != principal.subject:
        return True
    return principal.claims.get("age_band") in KIDS_AGE_BANDS


async def scheduler_only(request: Request) -> str:
    """`Authorization: Bearer <SCHEDULER_TOKEN>` (n8n): сравнение за постоянное время; пустой токен в настройках
    выключает вход. Внутренний JWT сервиса → 403 CALLER_NOT_ALLOWED (вызывающий — только планировщик)."""
    settings = cast(Settings, request.app.state.runtime.settings)
    expected = settings.scheduler_token.get_secret_value()
    scheme, _, presented = (request.headers.get("authorization") or "").partition(" ")
    presented = presented.strip()
    if expected and presented and scheme.lower() == "bearer" and hmac.compare_digest(
            presented.encode("utf-8"), expected.encode("utf-8")):
        return "scheduler"
    if request.headers.get(HEADER) is not None and not request.headers.get("authorization"):
        await no_service(request)
    log.warning("scheduler auth rejected",
                extra={"reason": "SCHEDULER_TOKEN_INVALID" if expected else "SCHEDULER_AUTH_DISABLED"})
    raise unauthorized("SCHEDULER_TOKEN_INVALID", "Неверный токен планировщика")


def dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


async def idempotent(rt: Runtime, *, scope: str, key: str | None, request: Any,
                     run: Callable[[], Awaitable[tuple[int, Any]]]) -> JSONResponse:
    """Повтор команды с тем же Idempotency-Key и телом возвращает сохранённый ответ (двойной клик не публикует
    дважды). Без ключа или без Redis команда просто выполняется (переходы статусов и так защищены 409)."""
    store: IdempotencyStore | None = None
    active = ""
    fp = fingerprint(request)
    if key is not None and rt.redis is not None:
        active = key
        store = IdempotencyStore(rt.redis, f"{settings_of(rt).cache_namespace}:idem")
        try:
            replay = await store.begin(scope, active, fp)
        except RedisError:
            log.warning("idempotency store unavailable, executing without it", exc_info=True)
            store, replay = None, None
        if replay is not None:
            return JSONResponse(replay["body"], status_code=replay["status"], headers={"idempotent-replay": "true"})
    try:
        status, body = await run()
    except BaseException:
        if store is not None:
            try:
                await store.abort(scope, active)
            except RedisError:
                log.warning("idempotency abort failed", exc_info=True)
        raise
    if store is not None:
        try:
            await store.complete(scope, active, fp, {"status": status, "body": body})
        except RedisError:
            log.warning("idempotency complete failed", exc_info=True)
    return JSONResponse(body, status_code=status)

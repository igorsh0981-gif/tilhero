"""Общие зависимости API ai-gateway: вызывающие, часы, зависимости вызова, Idempotency-Key, кеш результатов вызова."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, cast

from fastapi import Header, Request
from fastapi.responses import JSONResponse
from redis.asyncio import Redis
from redis.exceptions import RedisError

from tilhero_ai_gateway.domain.invoke import Deps
from tilhero_ai_gateway.domain.provider_status import ProviderStatus
from tilhero_ai_gateway.domain.speech import SpeechDeps
from tilhero_ai_gateway.domain.transcribe import TranscribeDeps, Transcriber
from tilhero_ai_gateway.providers import Provider
from tilhero_ai_gateway.providers.speech import SpeechProvider
from tilhero_ai_gateway.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.errors import conflict, forbidden, unprocessable
from tilhero_common.internal_auth import Actor, InternalAuth, Principal
from tilhero_common.redis_tools import IdempotencyStore, fingerprint

log = logging.getLogger("tilhero.ai_gateway.api")

# Вызывающие (INTERNAL_API §0, §1.2, §1.5; спринт 5 §1.7, §1.9, §3): вызов агента — lessons, assessment и memory
# (memory — только teaching_coach gloss_word, см. api/internal.py CALLER_REQUESTS; спринт 7: cooperative_lesson_coach —
# только lessons); статус — они же; оценка произношения — только memory; распознавание голосового хода парной
# комнаты (спринт 7) — только lessons; сотрудники — только admin-bff с actor
invoke_auth = InternalAuth({"lessons", "assessment", "memory"})
speech_auth = InternalAuth({"memory"})
transcribe_auth = InternalAuth({"lessons"})
staff_auth = InternalAuth({"admin-bff"})

IdempotencyKey = Header(default=None, alias="Idempotency-Key", min_length=8, max_length=128,
                        pattern=r"^[A-Za-z0-9_\-:.]+$")
KIDS_AGE_BANDS = frozenset({"6-9", "10-13"})


def settings_of(rt: Runtime) -> Settings:
    return cast(Settings, rt.settings)


def now_of(rt: Runtime) -> datetime:
    """Часы сервиса (UTC). Тесты подменяют `runtime.clock` (сроки прогонов, границы дня и месяца)."""
    clock = getattr(rt, "clock", None)
    return cast(datetime, clock()) if callable(clock) else datetime.now(UTC)


def deps_of(request: Request) -> Deps:
    rt: Runtime = request.app.state.runtime
    state = request.app.state
    status = getattr(state, "provider_status", None)
    if status is None:
        status = ProviderStatus(rt.redis, settings_of(rt).cache_namespace)
        state.provider_status = status
    provider = cast(Provider, state.provider)
    return Deps(rt=rt, settings=settings_of(rt), provider=provider, clock=lambda: now_of(rt), status=status)


def _speech_status(request: Request) -> ProviderStatus:
    rt: Runtime = request.app.state.runtime
    state = request.app.state
    status = getattr(state, "speech_status", None)
    if status is None:
        status = ProviderStatus(rt.redis, settings_of(rt).cache_namespace, kind="speech")
        state.speech_status = status
    return cast(ProviderStatus, status)


def speech_deps_of(request: Request) -> SpeechDeps:
    rt: Runtime = request.app.state.runtime
    return SpeechDeps(rt=rt, settings=settings_of(rt), provider=cast(SpeechProvider, request.app.state.speech),
                      clock=lambda: now_of(rt), status=_speech_status(request))


def transcribe_deps_of(request: Request) -> TranscribeDeps:
    """Распознавание хода парной комнаты (спринт 7): ошибки tts — в общий `speech.last_error` админки."""
    rt: Runtime = request.app.state.runtime
    return TranscribeDeps(rt=rt, settings=settings_of(rt), transcriber=cast(Transcriber,
                                                                            request.app.state.transcriber),
                          clock=lambda: now_of(rt), status=_speech_status(request))


def check_user(principal: Principal, user_id: uuid.UUID) -> None:
    """user_id запроса — ученик из токена вызывающего (`sub`, либо `lrn`, если токен его несёт): IDOR, защита в
    глубину. Токена без `sub` у вызова ученика не бывает → 401 USER_CONTEXT_REQUIRED (ревью R1-07: раньше такой токен
    пропускал проверку целиком)."""
    subject = principal.user_id  # нет sub → 401 USER_CONTEXT_REQUIRED
    allowed = {v for v in (subject, principal.claims.get("lrn")) if isinstance(v, str) and v}
    if str(user_id) not in allowed:
        raise forbidden("USER_CONTEXT_MISMATCH", "Ученик вызова не совпадает с учеником токена")


def require_any(principal: Principal, *permissions: str) -> Actor:
    if principal.actor is None:
        raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
    if not set(permissions) & principal.actor.permissions:
        raise forbidden("PERMISSION_DENIED", "Недостаточно прав", {"permission": permissions[0]})
    return principal.actor


def is_child_token(principal: Principal) -> bool:
    """Детский профиль 6–13 по claims внутреннего JWT (`lrn` ≠ `sub` или `age_band` ребёнка).

    Сейчас вызывающие (lessons, assessment) этих claims не передают — их токен несёт только `sub` = ученик, — поэтому
    защита детей держится на `audience` тела (аудитория сессии) и на том, что lessons/assessment не отправляют детский
    свободный текст. Проверка оставлена на будущее: когда вызывающие начнут пробрасывать claims ученика, она сработает
    независимо от тела (ревью R1-07)."""
    lrn = principal.claims.get("lrn")
    if isinstance(lrn, str) and lrn and principal.subject and lrn != principal.subject:
        return True
    return principal.claims.get("age_band") in KIDS_AGE_BANDS


async def idempotent(rt: Runtime, *, scope: str, key: str | None, request: Any,
                     run: Callable[[], Awaitable[tuple[int, Any]]]) -> JSONResponse:
    """Команды сотрудников: повтор с тем же Idempotency-Key и телом — сохранённый ответ (как в catalog)."""
    store: IdempotencyStore | None = None
    fp = fingerprint(request)
    active = key or ""
    if key is not None and rt.redis is not None:
        store = IdempotencyStore(rt.redis, f"{settings_of(rt).cache_namespace}:idem")
        try:
            replay = await store.begin(scope, active, fp)
        except RedisError:
            log.warning("idempotency store unavailable, executing without it")
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
                log.warning("idempotency abort failed")
        raise
    if store is not None:
        try:
            await store.complete(scope, active, fp, {"status": status, "body": body})
        except RedisError:
            log.warning("idempotency complete failed")
    return JSONResponse(body, status_code=status)


class InvokeCache:
    """Идемпотентность вызова по request_id (24 ч, INTERNAL_API §1.2): результат хранится в Redis, не в БД.
    Тот же request_id с другим телом → 422 IDEMPOTENCY_KEY_REUSED; параллельный дубль ждёт результат первого вызова
    (см. begin) и только не дождавшись получает 409 IDEMPOTENCY_IN_PROGRESS.
    Ключи ученика индексируются множеством — сага удаления стирает его результаты из кеша.
    kind: `invoke` — вызовы агентов, `speech` — оценка произношения (результат без аудио; отпечаток запроса — хеш
    меты и хеша аудио), `transcribe` — распознавание хода парной комнаты (спринт 7: текст хода, без аудио)."""

    POLL_S = 0.2
    KINDS = ("invoke", "speech", "transcribe")

    def __init__(self, redis: Redis, namespace: str, ttl: int, pending_ttl: int, kind: str = "invoke") -> None:
        self.redis = redis
        self.ns = f"{namespace}:{kind}"
        self.ttl = ttl
        self.pending_ttl = pending_ttl

    def key(self, caller: str, request_id: str) -> str:
        return f"{self.ns}:{caller}:{request_id}"

    def user_index(self, user_id: str) -> str:
        return f"{self.ns}:user:{user_id}"

    async def begin(self, caller: str, request_id: str, fp: str, *,
                    wait_until: float | None = None) -> dict[str, Any] | None:
        """None — вызов наш (pending записан); dict — сохранённый результат (повтор). Пока первый вызов с этим
        request_id идёт, дубль опрашивает Redis каждые 200 мс до `wait_until` (time.monotonic) и возвращает результат
        первого как повтор; не дождался — 409 IDEMPOTENCY_IN_PROGRESS; первый вызов сорвался (pending снят) — вызов
        выполняет дубль (ревью R1-04)."""
        full = self.key(caller, request_id)
        pending = json.dumps({"state": "pending", "fp": fp})
        while True:
            if await self.redis.set(full, pending, nx=True, ex=self.pending_ttl):
                return None
            raw = await self.redis.get(full)
            if raw is None:
                continue  # первый вызов только что снял pending (abort) — пробуем занять снова
            stored = json.loads(raw)
            if stored.get("fp") != fp:
                raise unprocessable("IDEMPOTENCY_KEY_REUSED", "request_id уже использован с другими данными")
            if stored.get("state") == "done":
                return cast(dict[str, Any], stored["result"])
            left = (wait_until - time.monotonic()) if wait_until is not None else 0.0
            if left <= 0:
                raise conflict("IDEMPOTENCY_IN_PROGRESS", "Вызов с этим request_id уже выполняется")
            await asyncio.sleep(min(self.POLL_S, left))

    async def complete(self, caller: str, request_id: str, fp: str, result: dict[str, Any],
                       user_id: str | None) -> None:
        full = self.key(caller, request_id)
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.set(full, json.dumps({"state": "done", "fp": fp, "result": result}), ex=self.ttl)
            if user_id:
                pipe.sadd(self.user_index(user_id), full)
                pipe.expire(self.user_index(user_id), self.ttl)
            await pipe.execute()

    async def abort(self, caller: str, request_id: str) -> None:
        await self.redis.delete(self.key(caller, request_id))

    async def purge_user(self, user_id: str) -> int:
        index = self.user_index(user_id)
        keys = list(await self.redis.smembers(index))
        if keys:
            await self.redis.delete(*keys)
        await self.redis.delete(index)
        return len(keys)

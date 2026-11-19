"""Клиент catalog (INTERNAL_API §1.4 спринта 3 и §4 спринта 4) с кешами.

- `GET /internal/v1/pairs` → пары (кеш PAIRS_CACHE_TTL_SECONDS; catalog недоступен — только пара по умолчанию);
- `GET /internal/v1/courses/{course_id}/snapshot` — снимок курса (опубликованные уроки, навыки) по ETag;
- `GET /internal/v1/versions/{kind}/{key}/{version}` — полная версия с ключами (published или archived);
  версии неизменяемы — кеш бессрочный (LRU). Ключи используются только для формирования и проверки шагов
  повторения; наружу (ученику) не уходят никогда;
- опубликованная версия сущности: `lessons[].version` снимка курса, иначе `GET /internal/v1/versions/{kind}/{key}`
  (без номера → текущая опубликованная; кеш PUBLISHED_CACHE_SECONDS);
- `GET /internal/v1/media/{asset_id}/exercises?audience=` — опубликованные упражнения к медиа (без ключей).
"""

from __future__ import annotations

import logging
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, unavailable
from tilhero_common.http_client import UpstreamError
from tilhero_lessons.settings import Settings

log = logging.getLogger("tilhero.lessons.catalog")

CATALOG = "catalog"
FALLBACK_TTL = 10.0


class ContentGone(Exception):
    """Версия контента отсутствует в catalog (404): зафиксированная в сессии версия недоступна."""


def catalog_unavailable() -> ApiError:
    return unavailable("CATALOG_UNAVAILABLE", "Каталог уроков временно недоступен — попробуйте ещё раз")


@dataclass(frozen=True)
class PairInfo:
    pair_id: str
    status: str
    course_id: str | None

    @property
    def available(self) -> bool:
        return self.status == "published"


@dataclass
class _Snapshot:
    etag: str | None
    data: dict[str, Any]
    checked_at: float


def _valid_snapshot(data: Any) -> bool:
    return (isinstance(data, dict) and isinstance(data.get("course_id"), str)
            and all(isinstance(data.get(k), list) for k in ("modules", "skills", "lessons")))


def _parse_version(data: Any, kind: str, key: str, version: int | None) -> tuple[int, dict[str, Any]]:
    """Ответ versions: {kind, key, version, status, payload} (или payload без обёртки — тогда версия из пути)."""
    if not isinstance(data, dict):
        raise ValueError("version: not an object")
    payload = data.get("payload") if isinstance(data.get("payload"), dict) else data
    v = data.get("version", version)
    if not isinstance(v, int) or isinstance(v, bool) or v < 1:
        raise ValueError("version: no version number")
    if version is not None and v != version:
        raise ValueError("version: mismatch")
    if not isinstance(payload, dict):
        raise ValueError("version: no payload")
    return v, payload


class CatalogGateway:
    def __init__(self, runtime: Runtime) -> None:
        self.runtime = runtime
        self._pairs: tuple[float, dict[str, PairInfo]] | None = None
        self._snapshots: dict[str, _Snapshot] = {}
        self._versions: OrderedDict[tuple[str, str, int], dict[str, Any]] = OrderedDict()
        self._published: dict[tuple[str, str], tuple[float, int | None]] = {}

    @property
    def settings(self) -> Settings:
        return self.runtime.settings  # type: ignore[return-value]

    # ---------------------------------------------------------------- пары и снимок курса

    def _fallback(self) -> dict[str, PairInfo]:
        s = self.settings
        return {s.default_pair_id: PairInfo(s.default_pair_id, "published", s.default_course_id)}

    async def pairs(self) -> dict[str, PairInfo]:
        now = time.monotonic()
        if self._pairs is not None and self._pairs[0] > now:
            return self._pairs[1]
        try:
            data = await self.runtime.client(CATALOG).get("/internal/v1/pairs")
            items = data.get("items") if isinstance(data, dict) else None
            if not isinstance(items, list):
                raise ValueError("pairs: items is not a list")
            pairs = {
                str(p["pair_id"]): PairInfo(str(p["pair_id"]), str(p.get("status", "")),
                                            str(p["course_id"]) if p.get("course_id") else None)
                for p in items if isinstance(p, dict) and p.get("pair_id")
            }
            self._pairs = (now + self.settings.pairs_cache_ttl_seconds, pairs)
        except (UpstreamError, ValueError, KeyError, TypeError) as exc:
            log.warning("catalog pairs unavailable, default pair only", extra={"error_type": type(exc).__name__})
            pairs = self._fallback()
            self._pairs = (now + FALLBACK_TTL, pairs)
        return pairs

    async def pair(self, pair_id: str) -> PairInfo | None:
        return (await self.pairs()).get(pair_id)

    async def snapshot(self, course_id: str) -> dict[str, Any] | None:
        now = time.monotonic()
        cached = self._snapshots.get(course_id)
        if cached is not None and now - cached.checked_at < self.settings.snapshot_revalidate_seconds:
            return cached.data
        headers = {"if-none-match": cached.etag} if cached is not None and cached.etag else None
        try:
            resp = await self.runtime.client(CATALOG).get(f"/internal/v1/courses/{course_id}/snapshot",
                                                          headers=headers, raw=True)
            if resp.status_code == 304 and cached is not None:
                cached.checked_at = now
                return cached.data
            data = resp.json()
            if not _valid_snapshot(data):
                raise ValueError("snapshot: unexpected shape")
            self._snapshots[course_id] = _Snapshot(resp.headers.get("etag"), data, now)
            return data
        except (UpstreamError, ValueError, KeyError, TypeError) as exc:
            log.warning("catalog snapshot unavailable", extra={"error_type": type(exc).__name__,
                                                                "stale": cached is not None})
            return cached.data if cached is not None else None

    # ---------------------------------------------------------------- версии контента

    async def version(self, kind: str, key: str, version: int) -> dict[str, Any]:
        """Полная версия (payload с ключами). 404 → ContentGone; иначе недоступность → 503 CATALOG_UNAVAILABLE."""
        ck = (kind, key, version)
        hit = self._versions.get(ck)
        if hit is not None:
            self._versions.move_to_end(ck)
            return hit
        try:
            data = await self.runtime.client(CATALOG).get(f"/internal/v1/versions/{kind}/{key}/{version}")
            _, payload = _parse_version(data, kind, key, version)
        except UpstreamError as exc:
            if exc.status == 404:
                raise ContentGone(f"{kind}:{key}@{version}") from None
            log.warning("catalog version unavailable", extra={"error_type": type(exc).__name__, "kind": kind})
            raise catalog_unavailable() from None
        except (ValueError, KeyError, TypeError) as exc:
            log.warning("catalog version malformed", extra={"error_type": type(exc).__name__, "kind": kind})
            raise catalog_unavailable() from None
        self._remember(ck, payload)
        return payload

    def _remember(self, ck: tuple[str, str, int], payload: dict[str, Any]) -> None:
        self._versions[ck] = payload
        self._versions.move_to_end(ck)
        while len(self._versions) > self.settings.versions_cache_size:
            self._versions.popitem(last=False)

    async def published(self, kind: str, key: str, *, hint: int | None = None) -> tuple[int, dict[str, Any]] | None:
        """Текущая опубликованная версия (номер, payload с ключами) или None, если не опубликована.
        hint — номер из снимка курса (lessons[].version), если catalog его отдаёт."""
        if hint is not None:
            return hint, await self.version(kind, key, hint)
        now = time.monotonic()
        cached = self._published.get((kind, key))
        if cached is not None and cached[0] > now:
            if cached[1] is None:
                return None
            return cached[1], await self.version(kind, key, cached[1])
        try:
            data = await self.runtime.client(CATALOG).get(f"/internal/v1/versions/{kind}/{key}")
            v, payload = _parse_version(data, kind, key, None)
        except UpstreamError as exc:
            if exc.status == 404:
                self._published[(kind, key)] = (now + self.settings.published_cache_seconds, None)
                return None
            log.warning("catalog published version unavailable",
                        extra={"error_type": type(exc).__name__, "kind": kind})
            raise catalog_unavailable() from None
        except (ValueError, KeyError, TypeError) as exc:
            log.warning("catalog published version malformed",
                        extra={"error_type": type(exc).__name__, "kind": kind})
            raise catalog_unavailable() from None
        self._published[(kind, key)] = (now + self.settings.published_cache_seconds, v)
        self._remember((kind, key, v), payload)
        return v, payload

    async def media_exercises(self, asset_id: str, audience: str) -> list[dict[str, Any]] | None:
        """Опубликованные упражнения к медиа (без ключей); None — материал недоступен (404)."""
        try:
            data = await self.runtime.client(CATALOG).get(f"/internal/v1/media/{asset_id}/exercises",
                                                          params={"audience": audience})
        except UpstreamError as exc:
            if exc.status == 404:
                return None
            log.warning("catalog media exercises unavailable", extra={"error_type": type(exc).__name__})
            raise catalog_unavailable() from None
        items = data.get("items") if isinstance(data, dict) else data
        if not isinstance(items, list):
            raise catalog_unavailable()
        return [i for i in items if isinstance(i, dict) and isinstance(i.get("exercise_id"), str)]

"""Клиент catalog (INTERNAL_API §1.4): список пар и снимок курса (CourseSnapshot, bff.ts) с кешем.

- `GET /internal/v1/pairs` → `{items: LanguagePair[]}` — кеш на PAIRS_CACHE_TTL_SECONDS; catalog недоступен —
  доступна только пара по умолчанию (ru-en → курс en-core), запасной вариант кешируется на 10 с.
- `GET /internal/v1/courses/{course_id}/snapshot` — кеш по ETag (If-None-Match → 304); перепроверка не чаще
  SNAPSHOT_REVALIDATE_SECONDS. catalog недоступен — устаревший снимок, если он есть, иначе None (рекомендация старта
  тогда null, результат всё равно сохраняется).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

from tilhero_common.app import Runtime
from tilhero_common.http_client import UpstreamError
from tilhero_diagnostics.settings import Settings

log = logging.getLogger("tilhero.diagnostics.catalog")

CATALOG = "catalog"
FALLBACK_TTL = 10.0


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


class CatalogGateway:
    def __init__(self, runtime: Runtime) -> None:
        self.runtime = runtime
        self._pairs: tuple[float, dict[str, PairInfo]] | None = None
        self._snapshots: dict[str, _Snapshot] = {}

    @property
    def settings(self) -> Settings:
        return self.runtime.settings  # type: ignore[return-value]

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

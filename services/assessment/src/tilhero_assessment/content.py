"""Клиент catalog (INTERNAL_API §4): версия контента **с ключами** `GET /internal/v1/versions/{kind}/{key}/{version}`.

Ключи и рубрика берутся только отсюда — assessment не доверяет правильности от lessons. Версии неизменяемы
(published или archived, бывшая опубликованной), поэтому кеш бессрочный; ограничен числом записей (LRU).
Ответ catalog — `{kind, key, version, status, payload, …}` (как ContentVersion админки) или само тело версии.
- 404 → версии нет (или черновик) — ошибка ссылки вызывающего: 422 CONTENT_REF_INVALID;
- 5xx, сеть, разомкнутый предохранитель, неожиданная форма → 503 CATALOG_UNAVAILABLE (оценка невозможна:
  без ключей оценщик не работает; lessons повторит завершение).
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from typing import Any, Final

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, unavailable, unprocessable
from tilhero_common.http_client import UpstreamError

log = logging.getLogger("tilhero.assessment.catalog")

CATALOG: Final = "catalog"
ID_FIELD: Final = {"lesson": "lesson_id", "scenario": "scenario_id", "rubric": "rubric_id",
                   "media_asset": "asset_id", "media_exercise": "exercise_id"}
# черновик и непроверенная версия ключей не дают (catalog и так отвечает 404 — защита в глубину)
_NOT_PUBLISHED: Final = frozenset({"draft", "in_review", "approved"})


def ref_invalid(kind: str, key: str, version: int) -> ApiError:
    return unprocessable("CONTENT_REF_INVALID", "Версия контента не найдена или не публиковалась",
                         {"kind": kind, "key": key, "version": version})


def catalog_unavailable() -> ApiError:
    return unavailable("CATALOG_UNAVAILABLE", "Каталог контента временно недоступен", {"service": CATALOG})


class ContentGateway:
    def __init__(self, runtime: Runtime, max_entries: int = 512) -> None:
        self.runtime = runtime
        self.max_entries = max_entries
        self._cache: OrderedDict[tuple[str, str, int], dict[str, Any]] = OrderedDict()

    async def version(self, kind: str, key: str, version: int) -> dict[str, Any]:
        """Тело версии (payload) с ключами ответов."""
        cache_key = (kind, key, version)
        cached = self._cache.get(cache_key)
        if cached is not None:
            self._cache.move_to_end(cache_key)
            return cached
        try:
            data = await self.runtime.client(CATALOG).get(f"/internal/v1/versions/{kind}/{key}/{version}")
        except UpstreamError as exc:
            if exc.status == 404:
                raise ref_invalid(kind, key, version) from None
            log.warning("catalog version unavailable", extra={"error_type": type(exc).__name__,
                                                               "status": exc.status, "kind": kind})
            raise catalog_unavailable() from None
        payload = self._payload(data, kind, key, version)
        self._cache[cache_key] = payload
        if len(self._cache) > self.max_entries:
            self._cache.popitem(last=False)
        return payload

    @staticmethod
    def _payload(data: Any, kind: str, key: str, version: int) -> dict[str, Any]:
        if not isinstance(data, dict):
            raise catalog_unavailable()
        if isinstance(data.get("status"), str) and data["status"] in _NOT_PUBLISHED:
            raise ref_invalid(kind, key, version)
        if "version" in data and data["version"] != version and isinstance(data.get("payload"), dict):
            log.warning("catalog returned another version", extra={"kind": kind})
            raise catalog_unavailable()
        payload = data["payload"] if isinstance(data.get("payload"), dict) else data
        if payload.get(ID_FIELD[kind]) != key:
            log.warning("catalog payload key mismatch", extra={"kind": kind})
            raise catalog_unavailable()
        return payload

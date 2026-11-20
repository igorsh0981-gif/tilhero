"""Клиенты доменов, которые вызывает memory (INTERNAL_API §0): catalog, assessment, ai-gateway, identity-consent.

- catalog: версии контента с ключами (`/internal/v1/versions/{kind}/{key}/{version}` — неизменяемы, LRU), названия
  (текущая опубликованная версия, кеш TITLES_CACHE_SECONDS), словарь курса (lookup, ai-entries, forms), задания
  проверок удержания. Недоступность → 503 CATALOG_UNAVAILABLE (в consumers — TransientError, повтор доставки);
- assessment: `GET /internal/v1/evaluations/{id}/memory-feed` (ошибки текста ученика — только в памяти процесса);
- ai-gateway (subject = ученик во всех вызовах): статус (2 с), `teaching_coach` gloss_word (deadline 8 с, ожидание
  9 с), оценка произношения (сырое тело WAV + `X-Speech-Meta`, 15 с). Любой сбой ИИ — «недоступно», сервис
  продолжает без ИИ;
- identity-consent: `GET /internal/v1/users/{lrn}/public` — согласие на запись голоса (`purposes`).

В логи — только тип ошибки и статус: ни текста ученика, ни аудио, ни ответов моделей.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, TransientError, unavailable
from tilhero_common.http_client import ServiceClient, UpstreamError
from tilhero_memory.domain.common import content_not_found, word_not_in_content
from tilhero_memory.settings import Settings

log = logging.getLogger("tilhero.memory.clients")

CATALOG = "catalog"
ASSESSMENT = "assessment"
AI_GATEWAY = "ai-gateway"
IDENTITY = "identity-consent"
VERSION_STATUSES = frozenset({"published", "archived"})
# виды версий, к которым memory допущен в catalog (INTERNAL_API §2.3): навыки — только через check-items
CONTENT_KINDS = frozenset({"lesson", "media_asset", "reading", "scenario"})


class ContentGone(Exception):
    """Версии контента нет (404) или она не была опубликована."""


def catalog_unavailable() -> ApiError:
    return unavailable("CATALOG_UNAVAILABLE", "Каталог временно недоступен — попробуйте ещё раз")


def _settings(rt: Runtime) -> Settings:
    return rt.settings  # type: ignore[return-value]


# ---------------------------------------------------------------- catalog


def _parse_version(data: Any, version: int | None) -> tuple[int, str, dict[str, Any]]:
    if not isinstance(data, dict):
        raise ValueError("version: not an object")
    payload = data.get("payload") if isinstance(data.get("payload"), dict) else None
    v = data.get("version", version)
    if payload is None or not isinstance(v, int) or isinstance(v, bool) or v < 1:
        raise ValueError("version: malformed")
    if version is not None and v != version:
        raise ValueError("version: mismatch")
    return v, str(data.get("status") or "published"), payload


class CatalogGateway:
    def __init__(self, runtime: Runtime) -> None:
        self.runtime = runtime
        self._versions: OrderedDict[tuple[str, str, int, str], tuple[str, dict[str, Any]]] = OrderedDict()
        self._titles: dict[tuple[str, str], tuple[float, dict[str, str] | None]] = {}

    @property
    def settings(self) -> Settings:
        return _settings(self.runtime)

    @property
    def client(self) -> ServiceClient:
        return self.runtime.client(CATALOG)

    async def version(self, kind: str, key: str, version: int, audience: str | None = None) -> dict[str, Any]:
        """Полная версия (payload с ключами), опубликованная или бывшая опубликованной. audience — ученика (kids:
        недетский контент — 404); без аудитории — служебное чтение (consumers: урок, который ученик уже прошёл).
        404 / черновик → ContentGone; сбой → 503 CATALOG_UNAVAILABLE."""
        ck = (kind, key, version, audience or "")
        hit = self._versions.get(ck)
        if hit is None:
            try:
                data = await self.client.get(f"/internal/v1/versions/{kind}/{key}/{version}",
                                             params={"audience": audience} if audience else None)
                _, status, payload = _parse_version(data, version)
            except UpstreamError as exc:
                if exc.status == 404:
                    raise ContentGone(f"{kind}:{key}@{version}") from None
                log.warning("catalog version unavailable", extra={"error_type": type(exc).__name__, "kind": kind})
                raise catalog_unavailable() from None
            except (ValueError, KeyError, TypeError) as exc:
                log.warning("catalog version malformed", extra={"error_type": type(exc).__name__, "kind": kind})
                raise catalog_unavailable() from None
            hit = (status, payload)
            self._versions[ck] = hit
            while len(self._versions) > self.settings.versions_cache_size:
                self._versions.popitem(last=False)
        self._versions.move_to_end(ck)
        if hit[0] not in VERSION_STATUSES:
            raise ContentGone(f"{kind}:{key}@{version}")
        return hit[1]

    async def title(self, kind: str, key: str) -> dict[str, str] | None:
        """Название из текущей опубликованной версии (урок, текст, медиа, сценарий — memory допущен только к ним);
        снято с публикации или сбой → None."""
        if kind not in CONTENT_KINDS:
            return None
        now = time.monotonic()
        cached = self._titles.get((kind, key))
        if cached is not None and cached[0] > now:
            return cached[1]
        title: dict[str, str] | None = None
        ttl = float(self.settings.titles_cache_seconds)
        try:
            data = await self.client.get(f"/internal/v1/versions/{kind}/{key}")
            _, _, payload = _parse_version(data, None)
            raw = payload.get("title")
            if isinstance(raw, dict) and isinstance(raw.get("ru"), str) and isinstance(raw.get("uz"), str):
                title = {"ru": raw["ru"], "uz": raw["uz"]}
        except UpstreamError as exc:
            if exc.status != 404:
                ttl = min(ttl, 10.0)
        except (ValueError, KeyError, TypeError):
            ttl = min(ttl, 10.0)
        self._titles[(kind, key)] = (now + ttl, title)
        if len(self._titles) > 10_000:
            self._titles.clear()
        return title

    async def skill_title(self, skill_id: str, pair_id: str) -> dict[str, str] | None:
        """Название навыка — из `check-items` (версии навыков memory не читает); кеш TITLES_CACHE_SECONDS."""
        now = time.monotonic()
        cached = self._titles.get(("skill", skill_id))
        if cached is not None and cached[0] > now:
            return cached[1]
        data = await self.check_items(skill_id, "adults", pair_id)
        raw = data.get("title") if data is not None else None
        title = {"ru": raw["ru"], "uz": raw["uz"]} if isinstance(raw, dict) and isinstance(raw.get("ru"), str) \
            and isinstance(raw.get("uz"), str) else None
        ttl = float(self.settings.titles_cache_seconds) if data is not None else 10.0
        self._titles[("skill", skill_id)] = (now + ttl, title)
        return title

    async def lookup(self, pair_id: str, text: str, ref: dict[str, Any], audience: str) -> dict[str, Any]:
        """POST /internal/v1/glossary/lookup → {in_content, sentence_en, locator, note, entry | null, rejected}.
        audience — ученика: детям недетский контент «не существует» (404). 404 → CONTENT_NOT_FOUND; 422
        WORD_NOT_IN_CONTENT; сбой → 503 CATALOG_UNAVAILABLE."""
        body = {"pair_id": pair_id, "text": text, "content_ref": ref, "audience": audience}
        try:
            data = await self.client.post("/internal/v1/glossary/lookup", json=body)
        except UpstreamError as exc:
            if exc.status == 404:
                raise content_not_found() from None
            if exc.status == 422 and exc.code == "WORD_NOT_IN_CONTENT":
                raise word_not_in_content() from None
            log.warning("catalog glossary lookup failed", extra={"error_type": type(exc).__name__,
                                                                 "status": exc.status})
            raise catalog_unavailable() from None
        if not isinstance(data, dict) or data.get("in_content") is not True:
            if isinstance(data, dict) and data.get("in_content") is False:
                raise word_not_in_content()
            raise catalog_unavailable()
        entry = data.get("entry") if isinstance(data.get("entry"), dict) else None
        sentence = data.get("sentence_en") if isinstance(data.get("sentence_en"), str) else None
        note = data.get("note")
        note = {"ru": note["ru"], "uz": note["uz"]} if isinstance(note, dict) and isinstance(note.get("ru"), str) \
            and isinstance(note.get("uz"), str) else None
        locator = data.get("locator") if isinstance(data.get("locator"), str) else None
        return {"in_content": True, "sentence_en": sentence[:300] if sentence else None, "entry": entry,
                "rejected": data.get("rejected") is True, "note": note, "locator": locator}

    async def ai_entry(self, body: dict[str, Any]) -> dict[str, Any] | None:
        """POST /internal/v1/glossary/ai-entries (upsert по форме) → статья или None (сбой — перевод не кешируется)."""
        try:
            data = await self.client.post("/internal/v1/glossary/ai-entries", json=body)
        except UpstreamError as exc:
            log.warning("catalog ai-entries failed", extra={"error_type": type(exc).__name__, "status": exc.status})
            return None
        if isinstance(data, dict) and isinstance(data.get("entry"), dict):
            return dict(data["entry"])
        return dict(data) if isinstance(data, dict) and data.get("entry_id") else None

    async def forms(self, pair_id: str, forms: list[str]) -> list[dict[str, Any]]:
        """GET /internal/v1/glossary/forms?pair_id=&forms=a&forms=b (повторяемый параметр, ≤ 50, формы бывают с
        запятой) → {items: [{form, entry | null}]} → статьи; сбой — [] (только допустимые формы ответа)."""
        clean = [f[:120] for f in dict.fromkeys(forms) if f][:50]
        if not clean:
            return []
        try:
            data = await self.client.get("/internal/v1/glossary/forms", params={"pair_id": pair_id, "forms": clean})
        except UpstreamError as exc:
            log.info("catalog glossary forms unavailable", extra={"error_type": type(exc).__name__})
            return []
        items = data.get("items") if isinstance(data, dict) else None
        out: list[dict[str, Any]] = []
        for i in items if isinstance(items, list) else []:
            entry = i.get("entry") if isinstance(i, dict) else None
            if isinstance(entry, dict) and all(entry.get("entry_id") != o.get("entry_id") for o in out):
                out.append(entry)
        return out

    async def check_items(self, skill_id: str, audience: str, pair_id: str) -> dict[str, Any] | None:
        """GET /internal/v1/skills/{skill_id}/check-items → {skill_id, title, items[{lesson_id, version, item}]};
        404 — заданий нет ({items: []}); сбой — None (проверка остаётся в очереди)."""
        try:
            data = await self.client.get(f"/internal/v1/skills/{skill_id}/check-items",
                                         params={"audience": audience, "pair_id": pair_id})
        except UpstreamError as exc:
            if exc.status == 404:
                return {"skill_id": skill_id, "title": None, "items": []}
            log.warning("catalog check-items unavailable", extra={"error_type": type(exc).__name__})
            return None
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            return None
        return data


# ---------------------------------------------------------------- assessment


async def memory_feed(rt: Runtime, evaluation_id: uuid.UUID, user_id: uuid.UUID) -> dict[str, Any] | None:
    """Актуальная запись цепочки оценки с подтверждёнными ошибками текста ученика. None — только 404
    EVALUATION_NOT_FOUND (оценки нет) и 410 (ученик удалён): событие не повторяется. Любой другой ответ (в т. ч.
    404 без маршрута у старой версии assessment) и сбой → TransientError: consumer повторит доставку, событие не
    теряется."""
    try:
        data = await rt.client(ASSESSMENT).get(f"/internal/v1/evaluations/{evaluation_id}/memory-feed",
                                               subject=str(user_id))
    except UpstreamError as exc:
        if (exc.status == 404 and exc.code == "EVALUATION_NOT_FOUND") or exc.status == 410:
            return None
        log.warning("assessment memory-feed unavailable", extra={"error_type": type(exc).__name__,
                                                                 "status": exc.status})
        raise TransientError("assessment unavailable") from None
    if not isinstance(data, dict):
        raise TransientError("assessment memory-feed malformed")
    return data


# ---------------------------------------------------------------- ai-gateway


@dataclass
class AiStatus:
    ai_available: bool
    speech_available: bool


async def ai_status(rt: Runtime, user_id: uuid.UUID) -> AiStatus | None:
    """GET /internal/v1/status (2 с; subject — ученик); сбой — None (вызывающий решает: речь — недоступна)."""
    try:
        async with asyncio.timeout(_settings(rt).ai_status_timeout_seconds):
            data = await rt.client(AI_GATEWAY).get("/internal/v1/status", subject=str(user_id))
    except Exception as exc:
        log.info("ai-gateway status unavailable", extra={"error_type": type(exc).__name__})
        return None
    if not isinstance(data, dict):
        return None
    return AiStatus(data.get("ai_available") is True, data.get("speech_available") is True)


@dataclass
class GlossResult:
    status: str  # ok | unavailable | refused
    output: dict[str, Any] | None
    agent_version: str | None


async def invoke_gloss(rt: Runtime, *, request_id: uuid.UUID, session_id: uuid.UUID, user_id: uuid.UUID,
                       audience: str, locale: str, context: dict[str, Any]) -> GlossResult:
    """teaching_coach `gloss_word` (session_kind memory, deadline 8 с). Сбой / 409 / неверный ответ → unavailable."""
    body = {"request_id": str(request_id), "session_id": str(session_id), "session_kind": "memory",
            "user_id": str(user_id), "audience": audience, "locale": locale, "context": context,
            "deadline_ms": _settings(rt).gloss_deadline_ms}
    try:
        async with asyncio.timeout(_settings(rt).gloss_timeout_seconds):
            data = await rt.client(AI_GATEWAY).post("/internal/v1/agents/teaching_coach/invoke", json=body,
                                                    subject=str(user_id))
    except Exception as exc:  # сеть, таймаут, 403 / 409 / 422 / 5xx — «перевода нет»
        log.warning("ai-gateway gloss failed", extra={"error_type": type(exc).__name__,
                                                      "status": getattr(exc, "status", None)})
        return GlossResult("unavailable", None, None)
    if not isinstance(data, dict) or data.get("status") not in ("ok", "unavailable", "refused"):
        return GlossResult("unavailable", None, None)
    output = data.get("output") if isinstance(data.get("output"), dict) else None
    if data["status"] != "ok" or output is None:
        return GlossResult(str(data["status"]) if data["status"] != "ok" else "unavailable", None, None)
    version = data.get("agent_version")
    agent_version = f"teaching_coach@{version}" if isinstance(version, int) and not isinstance(version, bool) else (
        str(data.get("prompt_version"))[:64] if isinstance(data.get("prompt_version"), str) else "teaching_coach")
    return GlossResult("ok", output, agent_version)


def speech_meta_header(meta: dict[str, Any]) -> str:
    raw = json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


async def assess_pronunciation(rt: Runtime, audio: bytes, meta: dict[str, Any]) -> dict[str, Any] | None:
    """POST /internal/v1/speech/pronunciation — сырое тело WAV и X-Speech-Meta (subject = lrn = meta.user_id);
    таймаут 15 с. Сбой → None."""
    try:
        async with asyncio.timeout(_settings(rt).speech_timeout_seconds):
            data = await rt.client(AI_GATEWAY).request(
                "POST", "/internal/v1/speech/pronunciation", subject=str(meta["user_id"]), content=audio,
                headers={"content-type": "audio/wav", "x-speech-meta": speech_meta_header(meta)})
    except Exception as exc:
        log.warning("ai-gateway pronunciation failed", extra={"error_type": type(exc).__name__,
                                                              "status": getattr(exc, "status", None)})
        return None
    return data if isinstance(data, dict) else None


# ---------------------------------------------------------------- identity-consent


async def public_profile(rt: Runtime, user_id: uuid.UUID) -> dict[str, Any] | None:
    """GET /internal/v1/users/{lrn}/public → {kind, age_band, guardian_consent, consent_accepted, purposes, …};
    404 → {}; сбой → None."""
    try:
        data = await rt.client(IDENTITY).get(f"/internal/v1/users/{user_id}/public")
    except UpstreamError as exc:
        if exc.status == 404:
            return {}
        log.warning("identity-consent public unavailable", extra={"error_type": type(exc).__name__,
                                                                  "status": exc.status})
        return None
    return data if isinstance(data, dict) else None

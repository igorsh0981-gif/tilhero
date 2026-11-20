"""Произношение (INTERNAL_API §1.9, APP-ADV-01): оценка по реальной акустике через ai-gateway.

Порядок: тело WAV (RIFF, PCM 16 бит, моно, 16 кГц, 0,5..15 с, ≤ 600 000 байт; иначе 422 AUDIO_INVALID {reason}) →
эталонный текст — только сервер (карточка ученика или предложение опубликованного контента; чужая карточка — 404) →
согласие на запись голоса (identity-consent `/public`: purposes ∋ voice_recording; иначе 403 VOICE_CONSENT_REQUIRED
{who: self | guardian}; детский профиль и подросток без согласия родителя — guardian) → функция включена
(ai-gateway `/status`: speech_available; иначе 503 SPEECH_UNAVAILABLE) → оценка → попытка без аудио.

Аудио живёт только в памяти процесса на время запроса: не пишется на диск, в Redis, БД, логи, события и метрики.
В логах — длительность и статус.
"""

from __future__ import annotations

import asyncio
import logging
import re
import struct
import uuid
from dataclasses import dataclass
from typing import Any, Final

from sqlalchemy import select

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, forbidden, unavailable
from tilhero_memory import clients
from tilhero_memory.clients import ContentGone
from tilhero_memory.domain import learners
from tilhero_memory.domain.common import KIDS_BANDS, card_not_found, content_not_found, loc
from tilhero_memory.domain.context import Ctx
from tilhero_memory.models import Card, PronunciationAttempt

log = logging.getLogger("tilhero.memory.pronunciation")

MAX_BYTES: Final = 600_000
SAMPLE_RATE: Final = 16_000
MIN_MS: Final = 500
MAX_MS: Final = 15_000
VOICE_PURPOSE: Final = "voice_recording"
ERROR_TYPES: Final = frozenset({"none", "omission", "insertion", "mispronunciation"})
INTELLIGIBILITY: Final = frozenset({"clear", "mostly_clear", "needs_practice"})
SENTENCE_KINDS: Final = frozenset({"lesson", "media_asset", "reading", "scenario"})
WAV_TYPES: Final = frozenset({"audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"})
MSG_INSUFFICIENT: Final = loc("Не удалось оценить — говорите ближе к микрофону",
                              "Baholab boʻlmadi — mikrofonga yaqinroq gapiring")
MSG_UNAVAILABLE: Final = loc("Сейчас недоступно", "Hozircha mavjud emas")


def audio_invalid(reason: str) -> ApiError:
    return ApiError(422, "AUDIO_INVALID", "Запись не подходит: нужен WAV 16 кГц моно, от 0,5 до 15 секунд",
                    {"reason": reason})


def speech_unavailable() -> ApiError:
    return unavailable("SPEECH_UNAVAILABLE", "Оценка произношения сейчас недоступна")


def consent_required(who: str) -> ApiError:
    return forbidden("VOICE_CONSENT_REQUIRED", "Нужно согласие на запись голоса", {"who": who})


def reference_invalid() -> ApiError:
    return ApiError(422, "REFERENCE_INVALID", "Для этого текста оценка произношения недоступна")


def wav_duration_ms(data: bytes) -> int:
    """Проверка заголовка RIFF/WAVE: PCM (1), моно, 16 000 Гц, 16 бит → длительность, мс. Иначе AUDIO_INVALID."""
    if len(data) > MAX_BYTES:
        raise audio_invalid("too_large")
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise audio_invalid("format")
    pos, fmt_ok, data_len = 12, False, None
    while pos + 8 <= len(data):
        chunk, size = data[pos:pos + 4], struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = pos + 8
        if chunk == b"fmt ":
            if size < 16 or body + 16 > len(data):
                raise audio_invalid("format")
            audio_format, channels, rate, _, _, bits = struct.unpack("<HHIIHH", data[body:body + 16])
            fmt_ok = audio_format == 1 and channels == 1 and rate == SAMPLE_RATE and bits == 16
            if not fmt_ok:
                raise audio_invalid("format")
        elif chunk == b"data":
            data_len = min(size, len(data) - body)
            break
        pos = body + size + (size & 1)
    if not fmt_ok or data_len is None:
        raise audio_invalid("format")
    ms = data_len * 1000 // (SAMPLE_RATE * 2)
    if ms < MIN_MS:
        raise audio_invalid("too_short")
    if ms > MAX_MS:
        raise audio_invalid("too_long")
    return int(ms)


@dataclass
class Target:
    kind: str  # card | sentence
    ref: str
    card_id: uuid.UUID | None = None
    content: dict[str, Any] | None = None


def parse_target(target_kind: str | None, target: str) -> Target:
    """`target_kind=card|sentence&target=<card_id | kind:key:version:locator>` или (bff.ts)
    `target=card:<card_id> | sentence:<kind>:<key>:<version>:<locator>`."""
    raw = target.strip()
    kind = target_kind
    if kind is None:
        kind, _, raw = raw.partition(":")
    if kind == "card":
        try:
            return Target("card", raw, card_id=uuid.UUID(raw))
        except ValueError:
            raise card_not_found() from None
    if kind == "sentence":
        parts = raw.split(":", 3)
        if len(parts) == 4 and parts[0] in SENTENCE_KINDS and parts[2].isdigit() and int(parts[2]) >= 1 \
                and re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,63}", parts[1]) and parts[3]:
            return Target("sentence", raw, content={"kind": parts[0], "key": parts[1], "version": int(parts[2]),
                                                    "locator": parts[3][:32]})
        raise content_not_found()
    raise ApiError(422, "TARGET_INVALID", "Некорректная цель оценки произношения")


def speakable(text: str) -> str:
    """Эталон для речи: первый вариант («Goodbye! / Bye!»), без заготовки «…»."""
    first = re.split(r"\s+/\s+", text.strip())[0]
    return " ".join(re.sub(r"…|\.\.\.", " ", first).split())


def sentence_text(kind: str, payload: dict[str, Any], locator: str) -> str | None:
    if kind == "reading":
        for p in payload.get("paragraphs") or []:
            for s in (p.get("sentences") or []) if isinstance(p, dict) else []:
                if isinstance(s, dict) and s.get("s_id") == locator and isinstance(s.get("text_en"), str):
                    return str(s["text_en"])
        return None
    if kind == "media_asset":
        lines = payload.get("transcript") or []
        if locator.isdigit() and int(locator) < len(lines) and isinstance(lines[int(locator)], dict):
            return lines[int(locator)].get("text_en")
        return None
    if kind == "lesson":
        prefix, _, idx = locator.partition(":") if ":" in locator else ("ex", "", locator)
        field_name, attr = {"ex": ("examples", "en"), "kw": ("key_words", "en")}.get(prefix, ("", ""))
        items = payload.get(field_name) or [] if field_name else []
        if idx.isdigit() and int(idx) < len(items) and isinstance(items[int(idx)], dict):
            value = items[int(idx)].get(attr)
            return value if isinstance(value, str) else None
        return None
    nodes = payload.get("nodes") or {}
    node = nodes.get(locator) if isinstance(nodes, dict) else None
    return node.get("line_en") if isinstance(node, dict) and isinstance(node.get("line_en"), str) else None


async def reference_text(ctx: Ctx, t: Target) -> str:
    if t.kind == "card":
        async with ctx.rt.transaction() as db:
            card = (await db.execute(select(Card).where(Card.card_id == t.card_id, Card.user_id == ctx.user_id))
                    ).scalar_one_or_none()
        if card is None or card.status == "archived":
            raise card_not_found()
        text = str(card.error["correction"]) if card.error is not None else card.text_en
    else:
        assert t.content is not None
        try:
            payload = await ctx.catalog.version(t.content["kind"], t.content["key"], t.content["version"])
        except ContentGone:
            raise content_not_found() from None
        found = sentence_text(t.content["kind"], payload, t.content["locator"])
        if found is None:
            raise content_not_found()
        text = found
    ref = speakable(text)
    if not 1 <= len(ref) <= 200:
        raise reference_invalid()
    return ref


def who_must_consent(public: dict[str, Any], learner: learners.Learner) -> str:
    band = public.get("age_band")
    if public.get("kind") == "child" or band in KIDS_BANDS or learner.child_by_claims:
        return "guardian"
    if band == "14-17" and public.get("guardian_consent") != "granted":
        return "guardian"
    return "self"


def has_voice_consent(public: dict[str, Any]) -> bool:
    purposes = public.get("purposes")
    return isinstance(purposes, list) and VOICE_PURPOSE in purposes and public.get("status") in (None, "ACTIVE")


async def status_for(rt: Runtime, learner: learners.Learner) -> str:
    """MemoryOverview.pronunciation: available | consent_self | consent_guardian | unavailable."""
    status, public = await asyncio.gather(clients.ai_status(rt, learner.user_id),
                                          clients.public_profile(rt, learner.user_id))
    if status is None or not status.speech_available or public is None:
        return "unavailable"
    if has_voice_consent(public):
        return "available"
    return "consent_guardian" if who_must_consent(public, learner) == "guardian" else "consent_self"


def _score(value: Any) -> float | None:
    if isinstance(value, int | float) and not isinstance(value, bool):
        return max(0.0, min(100.0, float(value)))
    return None


def _words(raw: Any) -> list[dict[str, Any]]:
    out = []
    for w in raw if isinstance(raw, list) else []:
        if isinstance(w, dict) and isinstance(w.get("word"), str):
            out.append({"word": w["word"][:60], "accuracy": _score(w.get("accuracy")),
                        "error_type": w.get("error_type") if w.get("error_type") in ERROR_TYPES else "none"})
    return out[:40]


def _tips(raw: Any) -> list[dict[str, str]]:
    return [{"word": str(t["word"])[:60], "text": str(t["text"])[:300]} for t in (raw if isinstance(raw, list) else [])
            if isinstance(t, dict) and isinstance(t.get("word"), str) and isinstance(t.get("text"), str)][:2]


def _unavailable_view(reference: str) -> dict[str, Any]:
    return {"attempt_id": None, "status": "unavailable", "reference_text": reference, "intelligibility": None,
            "score": None, "words": [], "tips": [], "message": MSG_UNAVAILABLE}


async def assess(ctx: Ctx, target_kind: str | None, target: str, audio: bytes,
                 content_type: str | None) -> dict[str, Any]:
    """POST /internal/v1/pronunciation → PronunciationView (bff.ts)."""
    if (content_type or "").split(";")[0].strip().lower() not in WAV_TYPES:
        raise audio_invalid("format")
    audio_ms = wav_duration_ms(audio)
    t = parse_target(target_kind, target)
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        prof = await learners.profile(db, ctx.learner, ctx.settings)
    reference = await reference_text(ctx, t)
    public = await clients.public_profile(ctx.rt, ctx.user_id)
    if public is None:
        raise speech_unavailable()
    if not has_voice_consent(public):
        raise consent_required(who_must_consent(public, ctx.learner))
    status = await clients.ai_status(ctx.rt, ctx.user_id)
    if status is None or not status.speech_available:
        raise speech_unavailable()
    request_id = uuid.uuid4()
    meta = {"request_id": str(request_id), "user_id": str(ctx.user_id), "audience": prof.audience,
            "locale": prof.locale, "reference_text": reference, "language": "en-US"}
    result = await clients.assess_pronunciation(ctx.rt, audio, meta)
    if result is None or result.get("status") not in ("ok", "insufficient_evidence"):
        log.info("pronunciation not assessed", extra={"audio_ms": audio_ms, "result_status": "unavailable"})
        return _unavailable_view(reference)
    ok = result["status"] == "ok"
    raw_scores = result.get("scores") if isinstance(result.get("scores"), dict) else None
    scores = {k: _score(raw_scores.get(k)) for k in ("accuracy", "fluency", "completeness", "pron")} \
        if ok and raw_scores else None
    if scores is not None and any(v is None for v in scores.values()):
        scores = None
    intelligibility = result.get("intelligibility") if ok and result.get("intelligibility") in INTELLIGIBILITY \
        else None
    words = _words(result.get("words")) if ok else []
    tips = _tips(result.get("tips")) if ok else []
    confidence = _score(result.get("confidence"))
    attempt = PronunciationAttempt(
        attempt_id=uuid.uuid4(), user_id=ctx.user_id, target={"kind": t.kind, "ref": t.ref[:200]},
        card_id=t.card_id, reference_text=reference, status=result["status"], scores=scores,
        intelligibility=intelligibility, words=words,
        confidence=min(1.0, confidence) if confidence is not None else None, tips=tips, audio_ms=audio_ms,
        request_id=request_id, created_at=ctx.now)
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        db.add(attempt)
    log.info("pronunciation assessed", extra={"audio_ms": audio_ms, "result_status": result["status"]})
    return {"attempt_id": str(attempt.attempt_id), "status": attempt.status, "reference_text": reference,
            "intelligibility": intelligibility, "score": scores["pron"] if scores else None, "words": words,
            "tips": tips, "message": None if ok else MSG_INSUFFICIENT}

"""Оценка произношения — `pronunciation_coach` (implementation `code`, INTERNAL_API §3.2; скилл LinguaFlow
`08_pronunciation.md`): оценка провайдера + советы правилами. Провайдер (релиз 5.1): `whisper` — свой сервер
(распознавание в tts, сравнение слов с эталоном — `domain/word_score.py`; денег не стоит, бюджеты не тратит), `azure`
— Azure AI Speech Pronunciation Assessment (запасной), `fake` — стенд и тесты. Шаги ниже — общие; для whisper шаг
бюджета пропускается.

Порядок:
1. Доступность: аварийная остановка → `unavailable: ai_disabled`; нет ключа или региона Azure (или модель речи
   выключена в админке) → `unavailable: not_configured`; бюджет (месяц UTC, подлимит речи в месяц
   `speech_monthly_cap_usd` — решение владельца 20.11.2026, ученик за день по Ташкенту) по оценке стоимости длительности
   аудио → `unavailable: budget_exceeded` — всё до вызова провайдера.
2. Провайдер: таймаут попытки ≤ 12 с; один повтор при 5xx или сетевой ошибке, если до дедлайна (15 с ожидания memory,
   с запасом) осталось ≥ 4 с. Таймаут не повторяется (запрос мог быть обработан и оплачен).
3. Разбор `NBest[0]`: `RecognitionStatus` ≠ Success → `insufficient_evidence: not_recognized`; `Confidence` < 0,4 →
   `low_confidence`; `CompletenessScore` < 30 → `incomplete` (баллов нет). Иначе баллы 0..100 и слова
   (точность, `error_type: none | omission | insertion | mispronunciation`), ≤ 40.
4. Советы — не больше 2: `mispronunciation` с точностью < 60 и `omission` (точность 0), сначала самые низкие; RU/UZ по
   `locale`; детям — мягкий вариант на «ты»; ни слова об «акценте» (акцент — не ошибка, скилл 08 п. 3).
   `intelligibility`: clear (pron ≥ 80) | mostly_clear (60..79) | needs_practice (< 60).
5. Учёт — строка `usage`: агент `pronunciation_coach`, модель `azure-speech-pa` | `fake-speech`, провайдер
   `azure_speech` | `fake_speech`, `audio_ms`, `session_kind: memory`, стоимость = audio_ms / 3 600 000 ×
   audio_usd_per_hour за каждую оплаченную попытку (успех, ответ 200 с неразборчивым телом, таймаут). Оценка без
   баллов (insufficient_evidence) — `status ok` с причиной (вызов состоялся и оплачен).

Аудио — только аргумент функции на время запроса: не пишется в БД, Redis, логи и события. В логах — длительность,
статус, причина, задержка.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal
from typing import Any, Final

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_ai_gateway.contracts import CONTROL_RE, SpeechAssessMeta
from tilhero_ai_gateway.domain import budget as budgets
from tilhero_ai_gateway.domain.common import usd
from tilhero_ai_gateway.domain.provider_status import ProviderStatus
from tilhero_ai_gateway.domain.registry import SPEECH_MODEL_BY_PROVIDER
from tilhero_ai_gateway.domain.wav import WavInfo
from tilhero_ai_gateway.models import BudgetRow, DeletedUser, ModelRow, UsageRow
from tilhero_ai_gateway.providers.speech import SpeechError, SpeechProvider, SpeechRequest, SpeechTimeout
from tilhero_ai_gateway.settings import Settings
from tilhero_common.app import Runtime

log = logging.getLogger("tilhero.ai_gateway.pronunciation")

AGENT_ID: Final = "pronunciation_coach"
SESSION_KIND: Final = "memory"
DEADLINE_S: Final = 14.5  # memory ждёт ответ 15 с (INTERNAL_API §1.9) — отвечаем раньше
ATTEMPT_TIMEOUT_S: Final = 12.0
RETRY_MIN_REMAINING_S: Final = 4.0
MARGIN_S: Final = 0.5
MIN_ATTEMPT_S: Final = 1.0
MIN_CONFIDENCE: Final = 0.4
MIN_COMPLETENESS: Final = 30.0
TIP_ACCURACY: Final = 60.0
MAX_TIPS: Final = 2
MAX_WORDS: Final = 40
MS_PER_HOUR: Final = Decimal(3_600_000)
Q6: Final = Decimal("0.000001")
ERROR_TYPES: Final[dict[str, str]] = {"none": "none", "omission": "omission", "insertion": "insertion",
                                      "mispronunciation": "mispronunciation"}

# Советы (скилл 08: 1–2 конкретных совета для разборчивости, не для «исправления акцента»). Детям — мягко, на «ты».
TIPS: Final[dict[tuple[str, bool, str], str]] = {
    ("ru", False, "mispronunciation"):
        "Слово «{word}» прозвучало неразборчиво. Послушайте образец и повторите медленно.",
    ("ru", False, "omission"): "Слово «{word}» не прозвучало — произнесите фразу целиком.",
    ("ru", True, "mispronunciation"): "Давай ещё раз скажем слово «{word}»: послушай образец и повтори медленно.",
    ("ru", True, "omission"): "Слово «{word}» не прозвучало — скажи всю фразу ещё раз.",
    ("uz", False, "mispronunciation"): "«{word}» soʻzi aniq eshitilmadi. Namunani tinglang va sekin takrorlang.",
    ("uz", False, "omission"): "«{word}» soʻzi aytilmadi — iborani toʻliq ayting.",
    ("uz", True, "mispronunciation"): "Kel, «{word}» soʻzini yana aytamiz: namunani tingla va sekin takrorla.",
    ("uz", True, "omission"): "«{word}» soʻzi aytilmadi — butun iborani yana bir bor ayt.",
}


@dataclass
class SpeechDeps:
    rt: Runtime
    settings: Settings
    provider: SpeechProvider
    clock: Callable[[], datetime]
    status: ProviderStatus


@dataclass(frozen=True)
class Assessment:
    status: str  # ok | insufficient_evidence
    reason: str | None
    scores: dict[str, float] | None
    words: list[dict[str, Any]]
    confidence: float | None


def audio_cost(audio_ms: int, usd_per_hour: Decimal, *, ceiling: bool = False) -> Decimal:
    """audio_ms / 3 600 000 × audio_usd_per_hour (Decimal, 6 знаков; оценка бюджета — с округлением вверх)."""
    value = Decimal(max(audio_ms, 0)) * Decimal(usd_per_hour) / MS_PER_HOUR
    return value.quantize(Q6, rounding=ROUND_CEILING if ceiling else ROUND_HALF_UP)


def _num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value)
        except ValueError:
            return None
    else:
        return None
    return number if math.isfinite(number) else None


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _scores_source(item: dict[str, Any]) -> dict[str, Any]:
    """Баллы — внутри `PronunciationAssessment` (формат SDK) или прямо в элементе (REST для короткого аудио)."""
    nested = item.get("PronunciationAssessment")
    return nested if isinstance(nested, dict) else item


def _word_text(value: Any) -> str:
    text = CONTROL_RE.sub("", str(value or "")).strip()
    return " ".join(text.split())[:60]


def interpret(data: dict[str, Any]) -> Assessment:
    """Ответ провайдера (формат Azure) → оценка. Нет обязательных баллов у распознанной речи — SpeechError
    bad_response (формат провайдера изменился; запрос оплачен)."""
    if data.get("RecognitionStatus") != "Success":
        return Assessment("insufficient_evidence", "not_recognized", None, [], None)
    nbest = data.get("NBest")
    best = nbest[0] if isinstance(nbest, list) and nbest and isinstance(nbest[0], dict) else None
    if best is None:
        return Assessment("insufficient_evidence", "not_recognized", None, [], None)
    raw_confidence = _num(best.get("Confidence"))
    confidence = round(_clamp(raw_confidence, 0.0, 1.0), 4) if raw_confidence is not None else None
    if confidence is None or confidence < MIN_CONFIDENCE:
        return Assessment("insufficient_evidence", "low_confidence", None, [], confidence)
    source = _scores_source(best)
    raw = {name: _num(source.get(key)) for name, key in (("accuracy", "AccuracyScore"), ("fluency", "FluencyScore"),
                                                         ("completeness", "CompletenessScore"), ("pron", "PronScore"))}
    if any(v is None for v in raw.values()):
        raise SpeechError("bad_response", billed=True)
    scores = {k: round(_clamp(float(v or 0.0), 0.0, 100.0), 1) for k, v in raw.items()}
    if scores["completeness"] < MIN_COMPLETENESS:
        return Assessment("insufficient_evidence", "incomplete", None, [], confidence)
    words: list[dict[str, Any]] = []
    for item in best.get("Words") or []:
        if not isinstance(item, dict) or len(words) >= MAX_WORDS:
            continue
        text = _word_text(item.get("Word"))
        if not text:
            continue
        ws = _scores_source(item)
        accuracy = _num(ws.get("AccuracyScore"))
        error_type = ERROR_TYPES.get(str(ws.get("ErrorType") or "None").lower(), "none")
        words.append({"word": text, "accuracy": round(_clamp(accuracy, 0.0, 100.0), 1) if accuracy is not None
                      else None, "error_type": error_type})
    return Assessment("ok", None, scores, words, confidence)


def make_tips(words: list[dict[str, Any]], locale: str, audience: str) -> list[dict[str, str]]:
    """≤ 2 совета: неразборчивые (mispronunciation, точность < 60) и пропущенные (omission) слова, сначала самые
    низкие по точности; одно слово — один совет."""
    candidates: list[tuple[float, int, dict[str, Any]]] = []
    for i, w in enumerate(words):
        accuracy = w["accuracy"]
        if w["error_type"] == "mispronunciation" and accuracy is not None and accuracy < TIP_ACCURACY:
            candidates.append((accuracy, i, w))
        elif w["error_type"] == "omission":
            candidates.append((accuracy if accuracy is not None else 0.0, i, w))
    kids = audience == "kids"
    tips: list[dict[str, str]] = []
    seen: set[str] = set()
    for _, _, w in sorted(candidates, key=lambda c: (c[0], c[1])):
        key = w["word"].lower()
        if key in seen:
            continue
        seen.add(key)
        template = TIPS[(locale if locale in ("ru", "uz") else "ru", kids, w["error_type"])]
        tips.append({"word": w["word"], "text": template.format(word=w["word"])})
        if len(tips) >= MAX_TIPS:
            break
    return tips


def intelligibility(pron: float) -> str:
    if pron >= 80:
        return "clear"
    if pron >= 60:
        return "mostly_clear"
    return "needs_practice"


def result_body(meta: SpeechAssessMeta, status: str, reason: str | None, *, audio_ms: int, provider: str | None,
                cost: Decimal = Decimal(0), latency_ms: int = 0, assessment: Assessment | None = None,
                locale: str = "ru", audience: str = "adults") -> dict[str, Any]:
    """PronunciationResult (ai.ts)."""
    ok = assessment is not None and assessment.status == "ok" and assessment.scores is not None
    scores = assessment.scores if ok and assessment is not None else None
    words = assessment.words if ok and assessment is not None else []
    return {
        "status": status,
        "reason": reason,
        "reference_text": meta.reference_text,
        "scores": scores,
        "words": words,
        "intelligibility": intelligibility(scores["pron"]) if scores is not None else None,
        "tips": make_tips(words, locale, audience) if ok else [],
        "confidence": assessment.confidence if assessment is not None else None,
        "audio_ms": audio_ms,
        "provider": provider,
        "cost_usd": usd(cost),
        "latency_ms": latency_ms,
    }


async def speech_model(session: AsyncSession, provider: SpeechProvider) -> ModelRow | None:
    return await session.get(ModelRow, SPEECH_MODEL_BY_PROVIDER[provider.name])


async def speech_available(session: AsyncSession, provider: SpeechProvider, now: datetime) -> bool:
    """AiStatus.speech_available: нет аварийной остановки, провайдер настроен (whisper — задан TTS_URL, без проверки
    сети; azure — ключ и регион; fake — всегда), модель речи включена; для платных провайдеров ещё месячный потолок не
    превышен и расход речи за месяц меньше подлимита речи (whisper бюджеты не тратит)."""
    budget = await session.get(BudgetRow, 1)
    if budget is None or not budget.ai_enabled or not provider.ready():
        return False
    model = await speech_model(session, provider)
    if model is None or not model.active:
        return False
    if not provider.budgeted:
        return True
    if await budgets.speech_month_spent(session, now) >= Decimal(budget.speech_monthly_cap_usd):
        return False
    return await budgets.month_spent(session, now) < Decimal(budget.monthly_cap_usd)


def _ms(started: float) -> int:
    return max(0, int((time.perf_counter() - started) * 1000))


async def assess(deps: SpeechDeps, meta: SpeechAssessMeta, audio: bytes, info: WavInfo, *, caller: str,
                 audience: str, received: float) -> dict[str, Any]:
    """Оценка одной записи → PronunciationResult. `received` — time.monotonic() приёма запроса (дедлайн)."""
    started = time.perf_counter()
    deadline = received + DEADLINE_S
    provider = deps.provider
    call_id = uuid.uuid4()
    async with deps.rt.transaction() as s:
        user_id: uuid.UUID | None = meta.user_id
        if await s.get(DeletedUser, meta.user_id) is not None:
            user_id = None  # удалённый ученик: учёт без идентификатора
        budget = await s.get(BudgetRow, 1)
        model = await speech_model(s, provider)
    base: dict[str, Any] = {
        "call_id": call_id, "request_id": meta.request_id, "caller": caller[:32], "agent_id": AGENT_ID,
        "model_id": model.model_id if model is not None else None, "provider": provider.name,
        "session_id": None, "session_kind": SESSION_KIND, "user_id": user_id, "audio_ms": info.duration_ms,
        "created_at": deps.clock(),
    }

    async def early(reason: str) -> dict[str, Any]:
        async with deps.rt.transaction() as s:
            s.add(UsageRow(**base, status="unavailable", reason=reason, latency_ms=_ms(started),
                           finished_at=deps.clock()))
        _log(reason="early", status="unavailable", detail=reason, audio_ms=info.duration_ms, latency=_ms(started),
             attempts=0, provider=provider.name, caller=caller)
        return result_body(meta, "unavailable", reason, audio_ms=info.duration_ms, provider=None,
                           latency_ms=_ms(started))

    if budget is None or not budget.ai_enabled:
        return await early("ai_disabled")
    if not provider.ready() or model is None or not model.active or model.audio_usd_per_hour is None:
        return await early("not_configured")
    price = Decimal(model.audio_usd_per_hour)
    estimate = audio_cost(info.duration_ms, price, ceiling=True)
    async with deps.rt.transaction() as s:
        s.add(UsageRow(**base, status="pending"))
    reserved = True
    if provider.budgeted:  # whisper (свой сервер) денег не стоит — бюджеты и подлимит речи не проверяются
        scope = budgets.Scope(call_id=call_id, user_id=user_id, session_id=None, learner_limits=True, speech=True)
        async with deps.rt.transaction() as s:
            reserved = await budgets.try_reserve(s, budget, scope, actual=Decimal(0), estimate=estimate,
                                                 now=deps.clock(), tz=deps.settings.timezone)
    if not reserved:
        return await _finish(deps, meta, call_id, "unavailable", "budget_exceeded", started=started, attempts=0,
                             cost=Decimal(0), info=info, provider=None, caller=caller, audience=audience)

    attempts, billed = 0, 0
    data: dict[str, Any] | None = None
    failure = "provider_error"
    while True:
        remaining = deadline - time.monotonic()
        timeout_s = min(ATTEMPT_TIMEOUT_S, remaining - MARGIN_S)
        if timeout_s < MIN_ATTEMPT_S:
            failure = "timeout"
            break
        attempts += 1
        request = SpeechRequest(audio=audio, reference_text=meta.reference_text, language=meta.language,
                                timeout_s=timeout_s)
        try:
            async with asyncio.timeout(timeout_s):
                data = await provider.assess(request)
            billed += 1
            break
        except (TimeoutError, SpeechTimeout):
            billed += 1  # запрос мог быть обработан и оплачен — консервативно
            failure = "timeout"
            await deps.status.record_error("timeout", deps.clock())
            break
        except SpeechError as exc:
            billed += 1 if exc.billed else 0
            failure = "provider_error"
            await deps.status.record_error(exc.code, deps.clock())
            if exc.retryable and attempts < 2 and deadline - time.monotonic() >= RETRY_MIN_REMAINING_S:
                continue
            break
        except Exception as exc:  # провайдер не должен ронять вызов: ученик продолжает без оценки
            failure = "provider_error"
            log.warning("speech provider failed", extra={"error_type": type(exc).__name__})
            await deps.status.record_error("unexpected", deps.clock())
            break
    cost = audio_cost(info.duration_ms, price) * billed
    if data is None:
        return await _finish(deps, meta, call_id, "unavailable", failure, started=started, attempts=attempts,
                             cost=cost, info=info, provider=provider.name, caller=caller, audience=audience)
    try:
        assessment = interpret(data)
    except SpeechError as exc:
        await deps.status.record_error(exc.code, deps.clock())
        return await _finish(deps, meta, call_id, "unavailable", "provider_error", started=started,
                             attempts=attempts, cost=cost, info=info, provider=provider.name, caller=caller,
                             audience=audience)
    return await _finish(deps, meta, call_id, assessment.status, assessment.reason, started=started,
                         attempts=attempts, cost=cost, info=info, provider=provider.name, caller=caller,
                         audience=audience, assessment=assessment)


async def _finish(deps: SpeechDeps, meta: SpeechAssessMeta, call_id: uuid.UUID, status: str, reason: str | None, *,
                  started: float, attempts: int, cost: Decimal, info: WavInfo, provider: str | None, caller: str,
                  audience: str, assessment: Assessment | None = None) -> dict[str, Any]:
    latency = _ms(started)
    usage_status = "unavailable" if status == "unavailable" else "ok"
    async with deps.rt.transaction() as s:
        await s.execute(update(UsageRow).where(UsageRow.call_id == call_id).values(
            status=usage_status, reason=reason, cost_usd=cost, reserved_usd=0, latency_ms=latency,
            attempts=attempts, finished_at=deps.clock()).execution_options(synchronize_session=False))
    _log(reason="done", status=status, detail=reason, audio_ms=info.duration_ms, latency=latency, attempts=attempts,
         provider=provider, caller=caller)
    return result_body(meta, status, reason, audio_ms=info.duration_ms, provider=provider, cost=cost,
                       latency_ms=latency, assessment=assessment, locale=meta.locale, audience=audience)


def _log(*, reason: str, status: str, detail: str | None, audio_ms: int, latency: int, attempts: int,
         provider: str | None, caller: str) -> None:
    """Только метаданные: статус, причина, длительность, задержка — без эталона, слов, аудио и ключа."""
    log.info("pronunciation assessed", extra={"stage": reason, "status": status, "reason": detail,
                                              "audio_ms": audio_ms, "latency_ms": latency, "attempts": attempts,
                                              "provider": provider, "caller": caller})

"""Провайдеры оценки произношения (INTERNAL_API §3.2): azure (prod) и fake (тесты, стенд). Выбор — SPEECH_PROVIDER.

**Azure AI Speech, REST для короткого аудио** (SDK провайдеров не ставим — httpx):
`POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
?language=en-US&format=detailed`, заголовки `Ocp-Apim-Subscription-Key`, `Content-Type: audio/wav; codecs=audio/pcm;
samplerate=16000`, `Accept: application/json`, `Pronunciation-Assessment` = base64(JSON `{ReferenceText,
GradingSystem: HundredMark, Granularity: Word, Dimension: Comprehensive, EnableMiscue: true}`); тело — WAV как есть.
Ответ: `RecognitionStatus` и `NBest[0]` — `Confidence`, баллы (`AccuracyScore`, `FluencyScore`, `CompletenessScore`,
`PronScore` — на уровне NBest[0] в REST и внутри `PronunciationAssessment` в формате SDK: читаются оба), `Words[]` —
`Word`, `AccuracyScore`, `ErrorType` (так же: плоско или в `PronunciationAssessment`).

Ключ — только заголовок запроса: не логируется, не попадает в ответы, исключения и repr; ошибка несёт лишь код
(`http_<status> | network | timeout | bad_response`). Тело ответа и аудио в лог не пишутся.
Тесты подменяют транспорт (`httpx.MockTransport`) — сеть стенда к Azure закрыта.

**fake** (`SPEECH_PROVIDER=fake`): WAV со средней амплитудой < 200 → `InitialSilenceTimeout` (insufficient_evidence);
иначе слова эталона с точностью 90, слова длиной ≥ 8 букв — 55 и `Mispronunciation`; стоимость 0 (модель fake-speech).
"""

from __future__ import annotations

import base64
import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Final, Literal, Protocol

import httpx

from tilhero_ai_gateway.domain.wav import mean_amplitude, parse_wav
from tilhero_ai_gateway.settings import Settings

log = logging.getLogger("tilhero.ai_gateway.speech")

SpeechProviderName = Literal["azure_speech", "fake_speech"]
AZURE_PATH: Final = "/speech/recognition/conversation/cognitiveservices/v1"
CONTENT_TYPE: Final = "audio/wav; codecs=audio/pcm; samplerate=16000"
SILENCE_AMPLITUDE: Final = 200
FAKE_LONG_WORD: Final = 8
REFERENCE_WORD_RE: Final = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)*")


class SpeechError(Exception):
    """Ошибка провайдера речи; code — короткий код без деталей ответа. retryable — 5xx и сеть (§3.2: один повтор);
    billed — провайдер мог выставить счёт (ответ 200 с неразборчивым телом)."""

    def __init__(self, code: str, *, retryable: bool = False, billed: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.billed = billed


class SpeechTimeout(SpeechError):
    """Таймаут: запрос мог быть обработан и оплачен — повтора нет, стоимость — консервативно."""

    def __init__(self) -> None:
        super().__init__("timeout", retryable=False, billed=True)


@dataclass(frozen=True)
class SpeechRequest:
    audio: bytes  # WAV целиком — только в памяти на время запроса
    reference_text: str
    language: str
    timeout_s: float


class SpeechProvider(Protocol):
    name: SpeechProviderName

    def ready(self) -> bool:
        """Можно ли вызывать: у azure — заданы ключ и регион. False → unavailable: not_configured."""
        ...

    async def assess(self, request: SpeechRequest) -> dict[str, Any]:
        """Ответ провайдера в формате Azure (RecognitionStatus, NBest). Ошибки — SpeechError / SpeechTimeout."""
        ...

    async def aclose(self) -> None: ...


def assessment_header(reference_text: str) -> str:
    params = {"ReferenceText": reference_text, "GradingSystem": "HundredMark", "Granularity": "Word",
              "Dimension": "Comprehensive", "EnableMiscue": True}
    return base64.b64encode(json.dumps(params, ensure_ascii=False).encode("utf-8")).decode("ascii")


class AzureSpeechProvider:
    name: SpeechProviderName = "azure_speech"

    def __init__(self, key: str | None, region: str | None, *,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._key = key
        self._region = region
        self._transport = transport
        self._client: httpx.AsyncClient | None = None

    def ready(self) -> bool:
        return bool(self._key) and bool(self._region)

    @property
    def url(self) -> str:
        return f"https://{self._region}.stt.speech.microsoft.com{AZURE_PATH}"

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(transport=self._transport, follow_redirects=False,
                                             trust_env=self._transport is None)
        return self._client

    async def assess(self, request: SpeechRequest) -> dict[str, Any]:
        if not self.ready():
            raise SpeechError("not_configured")
        headers = {"Ocp-Apim-Subscription-Key": str(self._key), "Content-Type": CONTENT_TYPE,
                   "Accept": "application/json", "Pronunciation-Assessment": assessment_header(request.reference_text)}
        try:
            response = await self._http().post(self.url, params={"language": request.language, "format": "detailed"},
                                               content=request.audio, headers=headers,
                                               timeout=httpx.Timeout(request.timeout_s))
        except httpx.TimeoutException:
            raise SpeechTimeout() from None
        except httpx.HTTPError as exc:
            # текст исключения httpx может содержать URL и заголовки — только тип
            log.warning("azure speech request failed", extra={"error_type": type(exc).__name__})
            raise SpeechError("network", retryable=True) from None
        if response.status_code >= 400:
            log.warning("azure speech error status", extra={"status": response.status_code})
            raise SpeechError(f"http_{response.status_code}", retryable=response.status_code >= 500)
        try:
            data = response.json()
        except ValueError:
            raise SpeechError("bad_response", billed=True) from None
        if not isinstance(data, dict):
            raise SpeechError("bad_response", billed=True)
        return data

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def __repr__(self) -> str:  # ключ не попадает в repr/логи ни при каких условиях
        return f"AzureSpeechProvider(region={self._region!r}, key_configured={bool(self._key)})"


def reference_words(reference_text: str) -> list[str]:
    return [w.lower().replace("’", "'") for w in REFERENCE_WORD_RE.findall(reference_text)]


class FakeSpeechProvider:
    name: SpeechProviderName = "fake_speech"

    def ready(self) -> bool:
        return True

    async def assess(self, request: SpeechRequest) -> dict[str, Any]:
        info = parse_wav(request.audio)
        if mean_amplitude(request.audio, info) < SILENCE_AMPLITUDE:
            return {"RecognitionStatus": "InitialSilenceTimeout", "Offset": 0, "Duration": 0}
        words: list[dict[str, Any]] = []
        for word in reference_words(request.reference_text)[:40]:
            long = sum(ch.isalpha() for ch in word) >= FAKE_LONG_WORD
            words.append({"Word": word, "AccuracyScore": 55.0 if long else 90.0,
                          "ErrorType": "Mispronunciation" if long else "None"})
        accuracy = round(sum(float(w["AccuracyScore"]) for w in words) / len(words), 1) if words else 0.0
        fluency, completeness = 90.0, 100.0 if words else 0.0
        pron = round(accuracy * 0.6 + fluency * 0.2 + completeness * 0.2, 1)
        return {"RecognitionStatus": "Success", "DisplayText": request.reference_text,
                "NBest": [{"Confidence": 0.95, "AccuracyScore": accuracy, "FluencyScore": fluency,
                           "CompletenessScore": completeness, "PronScore": pron, "Words": words}]}

    async def aclose(self) -> None:
        return None


def make_speech_provider(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> SpeechProvider:
    if settings.speech_provider == "fake":
        return FakeSpeechProvider()
    return AzureSpeechProvider(settings.speech_key, settings.speech_region, transport=transport)

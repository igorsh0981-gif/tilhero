"""Провайдеры оценки произношения (INTERNAL_API §3.2): whisper (по умолчанию, релиз 5.1), azure (запасной) и fake
(тесты, стенд). Выбор — SPEECH_PROVIDER. Все отдают ответ в формате Azure (`RecognitionStatus`, `NBest[0]`) — дальше
общий разбор, советы и учёт (`domain/speech.py`).

**whisper** (решение владельца 20.11.2026: регистрация Azure не прошла — свой сервер): запись уходит в сервис tts
`POST {TTS_URL}/internal/v1/recognize` (общий ServiceClient, сырое тело `audio/wav`, без ученика в токене — tts
незачем знать, чья запись; эталон туда не передаётся — модель не «исправит» произношение); распознанные слова с
вероятностью и временем сравниваются с эталоном здесь (`domain/word_score.py`). Денег не стоит: модель
`whisper-base-en` 0 $, бюджеты ИИ и подлимит речи не тратятся (`budgeted = False`), аварийная остановка действует.
Ошибки: сеть/tts недоступен (`network`), 502/504 — повтор по общим правилам; 503 `RECOGNITION_UNAVAILABLE` (tts не
успел или модель упала) и прочие ответы — без повтора (CPU tts не перегружается повторами).

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
from tilhero_ai_gateway.domain.word_score import score
from tilhero_ai_gateway.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.http_client import CircuitOpen, UpstreamError

log = logging.getLogger("tilhero.ai_gateway.speech")

SpeechProviderName = Literal["whisper", "azure_speech", "fake_speech"]
TTS: Final = "tts"
RECOGNIZE_PATH: Final = "/internal/v1/recognize"
RETRYABLE_STATUS: Final = frozenset({502, 504})
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
    # оценка стоит денег: бюджеты ИИ и подлимит речи (whisper — свой сервер, False)
    budgeted: bool

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
    budgeted = True

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
    budgeted = True  # цена fake-speech правится в админке — тесты бюджета речи идут на fake

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


class WhisperSpeechProvider:
    """Свой сервер: распознавание в tts + сравнение с эталоном по словам. Клиент tts регистрируется в Runtime
    (`main.py`) только при заданном TTS_URL."""

    name: SpeechProviderName = "whisper"
    budgeted = False

    def __init__(self, runtime: Runtime, tts_url: str | None) -> None:
        self._rt = runtime
        self._url = tts_url

    def ready(self) -> bool:
        return bool(self._url)

    async def assess(self, request: SpeechRequest) -> dict[str, Any]:
        client = self._rt.clients.get(TTS) if self._url else None
        if client is None:
            raise SpeechError("not_configured")
        try:
            data = await client.post(RECOGNIZE_PATH, content=request.audio, headers={"Content-Type": "audio/wav"})
        except CircuitOpen:
            raise SpeechError("circuit_open") from None
        except UpstreamError as exc:
            if exc.code == "UPSTREAM_UNAVAILABLE":  # сеть: tts не отвечает (перезапуск, деплой)
                raise SpeechError("network", retryable=True) from None
            log.warning("tts recognize error status", extra={"status": exc.status, "code": exc.code[:64]})
            raise SpeechError(f"http_{exc.status}", retryable=exc.status in RETRYABLE_STATUS) from None
        words = data.get("words") if isinstance(data, dict) else None
        if not isinstance(words, list) or not all(isinstance(w, dict) for w in words):
            raise SpeechError("bad_response")
        return score(request.reference_text, words)

    async def aclose(self) -> None:
        return None  # клиент tts закрывает Runtime

    def __repr__(self) -> str:
        return f"WhisperSpeechProvider(tts_configured={bool(self._url)})"


def make_speech_provider(settings: Settings, transport: httpx.AsyncBaseTransport | None = None,
                         runtime: Runtime | None = None) -> SpeechProvider:
    if settings.speech_provider == "fake":
        return FakeSpeechProvider()
    if settings.speech_provider == "whisper":
        if runtime is None:  # pragma: no cover — build_app всегда передаёт Runtime
            raise RuntimeError("whisper speech provider needs Runtime (tts client)")
        return WhisperSpeechProvider(runtime, settings.tts_url)
    return AzureSpeechProvider(settings.speech_key, settings.speech_region, transport=transport)

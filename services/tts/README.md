# tts — серверная озвучка (релиз 4.1)

Озвучивает английские фразы контента в MP3 для Mini App (через telegram-bff):
- аудирование теста на уровень;
- «Прослушать» в разговоре с персонажем;
- медиа без аудиофайла.

**Зачем.** Раньше фразы озвучивал синтез речи устройства (Web Speech). Во встроенном браузере Telegram на Android его нет: кнопка не играла. На iOS звук шёл по тихому каналу, громкость телефона на него не действовала. MP3 играет в `HTMLAudioElement` через динамик на обеих платформах.

| | |
|---|---|
| Порт | 8115 (приватный, без публичного домена) |
| Движок | [Piper](https://github.com/rhasspy/piper) (MIT), CPU, `onnxruntime` → MP3 (`lameenc`, 64 кбит/с, моно) |
| Голоса | en-US — `en-us-ryan-high` (мужской), en-GB — `en-gb-southern_english_female-low` (женский); выбор владельца 19.11.2026. Скачиваются при сборке образа (Dockerfile, rhasspy/piper v0.0.2) и сверяются по SHA-256 |
| Кеш | Redis, ключ `tts:v1:<голос>:<скорость>:<sha256 текста>`, TTL 30 дней — фразы контента одинаковы у всех учеников, синтез один раз |
| Без БД и шины | только Redis |

## API

`POST /internal/v1/speech` (вызывающий — только **telegram-bff**, внутренний JWT) — тело `SpeechRequest` из bff.ts:
```json
{"text": "Excuse me, where is the train station?", "variant": "en-US", "speed": "normal"}
```
- **200 `audio/mpeg`** — заголовки `Cache-Control: private, max-age=86400`, `X-TTS-Cache: hit|miss`.
- **422 `TEXT_INVALID`** — пусто или больше 400 знаков после схлопывания пробелов, управляющие символы, нет латиницы.
- **503 `SPEECH_UNAVAILABLE`** — синтез не удался (таймаут 12 с). Клиент тогда откатывается на синтез устройства.
- **401 / 403** — нет токена или чужой вызывающий.

`speed: slow` — `length_scale` 1,2: для детей 6–13 и повторного прослушивания.

Текст фраз в лог не пишется — только длина, голос, попадание в кеш и размер.

## Переменные

| Переменная | По умолчанию | |
|---|---|---|
| `TTS_ENGINE` | `piper` | `fake` — заглушка без моделей (dev/test, CI, e2e); в stage/prod запрещён |
| `TTS_VOICES_DIR` | `/app/voices` | каталог `<голос>.onnx` + `.onnx.json` |
| `TTS_VOICE_EN_US` / `TTS_VOICE_EN_GB` | см. выше | смена голоса — новый архив в Dockerfile (с SHA-256) |
| `TTS_LENGTH_SCALE_NORMAL` / `_SLOW` | 1.0 / 1.2 | скорость речи |
| `TTS_MAX_TEXT_CHARS` | 400 | |
| `TTS_CONCURRENCY` | 2 | одновременных синтезов (CPU) |
| `TTS_SYNTH_TIMEOUT_SECONDS` | 12 | |
| `TTS_CACHE_TTL_DAYS` | 30 | |
| `REDIS_URL` | — | без Redis синтез идёт на каждый запрос |
| `INTERNAL_JWT_PRIVATE_KEY`, `INTERNAL_JWT_PUBLIC_KEYS`, `INTERNAL_JWT_SECRET` | — | как у всех Python-сервисов; tts сам никого не вызывает, его открытый ключ не раздаётся (`setup.py` `VERIFY_ONLY`) |

## Тесты

`uv run --offline pytest services/tts` — API на fake-синтезе.

Тест настоящего Piper запускается, если голоса доступны (`TTS_TEST_VOICES_DIR=<каталог>`); в CI он пропускается. Голоса скачиваются так:
```
curl -fsSL -o v.tgz https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-en-us-ryan-high.tar.gz && tar xzf v.tgz
```

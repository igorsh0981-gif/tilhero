# tts — серверная озвучка (релиз 4.1) и распознавание речи (релиз 5.1)

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
| Распознавание (5.1) | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT), CPU, CTranslate2 `int8`, модель `Systran/faster-whisper-base.en` в образе (`/app/asr/base.en`) — для оценки произношения (ai-gateway) |

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

`POST /internal/v1/recognize` (релиз 5.1; вызывающий — только **ai-gateway**) — распознавание записи для оценки
произношения (решение владельца 20.11.2026: свой сервер вместо Azure; ai-gateway сравнивает слова с эталоном). Тело —
`audio/wav` (PCM 16 бит, моно, 16 000 Гц, 0,5..15 с, ≤ 600 000 байт), эталон сюда **не передаётся**.
```json
{"text": "Good morning I have a reservation", "words": [{"word": "Good", "start_ms": 0, "end_ms": 420, "probability": 0.97}],
 "duration_ms": 2400, "model": "faster-whisper-base.en"}
```
- Тишина или неразборчивая речь — `200` с пустыми `text` и `words` (не ошибка: ai-gateway ответит «не удалось оценить»).
- **422 `AUDIO_INVALID {reason: format | too_short | too_long | too_large}`** — не RIFF/WAVE PCM 16 бит моно 16 кГц, не
  `audio/wav`, < 0,5 с, > 15 с, > 600 000 байт. Тело больше общего лимита сервисов (256 КиБ, `tilhero_common.app`)
  читает `AudioBodyMiddleware` — только этот маршрут.
- **503 `RECOGNITION_UNAVAILABLE`** — распознавание не удалось или не уложилось в `ASR_TIMEOUT_SECONDS` (вместе с
  ожиданием очереди).

Параметры faster-whisper: `language="en"`, `beam_size` = `ASR_BEAM_SIZE`, `word_timestamps=True`, `vad_filter=True`,
`temperature=0` (без повторов с «разогревом» — предсказуемое время), `condition_on_previous_text=False`, **без
`initial_prompt`**: эталон не подсказывается, иначе модель «исправит» произношение и пропущенные или искажённые слова
не будут видны. Не больше `ASR_CONCURRENCY` распознаваний сразу (CPU): место в очереди освобождается, когда поток
распознавания действительно закончил (после таймаута он досчитывает — второе распознавание не стартует параллельно).
Модель грузится при старте — без неё сервис не стартует (как с голосами Piper). Аудио — только в памяти на время
запроса; в лог — длительность, число слов, задержка и модель (без текста).

**Модель в образе** (Dockerfile, стадия `asr`): файлы `config.json`, `model.bin`, `tokenizer.json`, `vocabulary.txt` с
`https://huggingface.co/<ASR_REPO>/resolve/<ASR_COMMIT>/<файл>`, коммит закреплён (`3d3d5dee…be6c`). SHA-256 — build-arg
`ASR_SHA256_CONFIG`, `ASR_SHA256_MODEL`, `ASR_SHA256_TOKENIZER`, `ASR_SHA256_VOCABULARY`: заданы — сверяются (иначе
сборка падает); не заданы — `sha256sum` печатается в лог сборки («ASR_SHA256 not pinned …»), суммы закрепляются
следующим коммитом (со стенда разработки Hugging Face недоступен). Модель `small.en` — тем же механизмом: build-arg
`ASR_MODEL=small.en`, `ASR_REPO=Systran/faster-whisper-small.en`, `ASR_COMMIT=<коммит>` и её суммы (точнее, ~3× медленнее
на CPU). В рантайме `HF_HUB_OFFLINE=1` — сети к Hugging Face не нужно.

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
| `ASR_ENGINE` | `whisper` | `fake` — заглушка без модели (dev/test, CI, стенд): тишина → слов нет, иначе слова из комментария WAV (`LIST/INFO/ICMT`); в stage/prod запрещён |
| `ASR_MODEL_DIR` / `ASR_MODEL` | `/app/asr` / `base.en` | модель — каталог `<ASR_MODEL_DIR>/<ASR_MODEL>` |
| `ASR_BEAM_SIZE` | 1 | 1 — жадное декодирование (быстрее), до 5 — поиск лучом (точнее, дольше) |
| `ASR_CONCURRENCY` | 1 | одновременных распознаваний (CPU) |
| `ASR_CPU_THREADS` | 2 | потоков CTranslate2 на распознавание |
| `ASR_TIMEOUT_SECONDS` | 10 | очередь + распознавание (ai-gateway ждёт попытку ≤ 12 с) |
| `REDIS_URL` | — | без Redis синтез идёт на каждый запрос |
| `INTERNAL_JWT_PRIVATE_KEY`, `INTERNAL_JWT_PUBLIC_KEYS`, `INTERNAL_JWT_SECRET` | — | как у всех Python-сервисов; tts сам никого не вызывает, его открытый ключ не раздаётся (`setup.py` `VERIFY_ONLY`); принимает токены telegram-bff (`/speech`) и ai-gateway (`/recognize`) |

## Тесты

`uv run --offline pytest services/tts` — API на fake-синтезе и fake-распознавании; `WhisperRecognizer` — на подменённой
модели (параметры распознавания, разбор слов, очередь и таймаут).

Тест настоящей модели распознавания — при `ASR_TEST_MODEL_DIR=<каталог с model.bin>` (с голосами Piper ещё и фраза
Piper → распознанные слова); в CI пропускается.

Тест настоящего Piper запускается, если голоса доступны (`TTS_TEST_VOICES_DIR=<каталог>`); в CI он пропускается. Голоса скачиваются так:
```
curl -fsSL -o v.tgz https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-en-us-ryan-high.tar.gz && tar xzf v.tgz
```

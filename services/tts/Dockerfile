# syntax=docker/dockerfile:1.7
# tts: Python-сервис по шаблону TilHero + голоса Piper в образе (скачиваются при сборке, проверяются по SHA-256) +
# модель распознавания речи faster-whisper (релиз 5.1; Hugging Face по закреплённому коммиту).
# Контекст сборки — корень репозитория (Railway: Root Directory пустой, Dockerfile Path = services/tts/Dockerfile).
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
# окружение сразу по итоговому пути: shebang у uvicorn указывает на /app/.venv/bin/python
WORKDIR /repo
COPY . .
RUN uv sync --frozen --no-dev --no-editable --package tilhero-tts

# Голоса Piper (MIT, rhasspy/piper v0.0.2): en-US — ryan (high), en-GB — southern english female (low).
# Выбор владельца 19.11.2026. Смена голоса — новый архив, его SHA-256 и TTS_VOICE_EN_* в settings.
FROM debian:bookworm-slim AS voices
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /voices
ARG PIPER_RELEASE=https://github.com/rhasspy/piper/releases/download/v0.0.2
RUN set -eu; \
    fetch() { curl -fsSL --retry 3 -o "$1.tgz" "$PIPER_RELEASE/voice-$1.tar.gz"; \
              echo "$2  $1.tgz" | sha256sum -c -; tar xzf "$1.tgz"; rm "$1.tgz"; }; \
    fetch en-us-ryan-high de346b054703a190782f49acb9b93c50678a884fede49cfd85429d204802d678; \
    fetch en-gb-southern_english_female-low 7c1bbe23e61a57bdb450b137f69a83ff5358159262e1ed7d2308fa14f4924da9; \
    rm -f MODEL_CARD; ls -la

# Модель распознавания (релиз 5.1, решение владельца 20.11.2026): Systran/faster-whisper-base.en (MIT; CTranslate2-
# конвертация openai/whisper base.en) по закреплённому коммиту. SHA-256 файлов задаются build-arg ASR_SHA256_* —
# заданы: сверяются (несовпадение — сборка падает); не заданы: sha256sum печатается в лог сборки, чтобы закрепить
# суммы следующим коммитом (Hugging Face недоступен со стенда разработки). Другая модель (small.en) — тем же
# механизмом: ASR_MODEL, ASR_REPO, ASR_COMMIT и суммы её файлов.
FROM debian:bookworm-slim AS asr
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ARG ASR_MODEL=base.en
ARG ASR_REPO=Systran/faster-whisper-base.en
ARG ASR_COMMIT=3d3d5dee26484f91867d81cb899cfcf72b96be6c
ARG ASR_SHA256_CONFIG=""
ARG ASR_SHA256_MODEL=""
ARG ASR_SHA256_TOKENIZER=""
ARG ASR_SHA256_VOCABULARY=""
WORKDIR /asr/${ASR_MODEL}
RUN set -eu; \
    fetch() { curl -fsSL --retry 3 -o "$1" "https://huggingface.co/$ASR_REPO/resolve/$ASR_COMMIT/$1"; \
              if [ -n "$2" ]; then echo "$2  $1" | sha256sum -c -; \
              else echo "ASR_SHA256 not pinned for $ASR_REPO@$ASR_COMMIT/$1:"; sha256sum "$1"; fi; }; \
    fetch config.json "$ASR_SHA256_CONFIG"; \
    fetch model.bin "$ASR_SHA256_MODEL"; \
    fetch tokenizer.json "$ASR_SHA256_TOKENIZER"; \
    fetch vocabulary.txt "$ASR_SHA256_VOCABULARY"; \
    ls -la

FROM python:3.13-slim
ARG ASR_MODEL=base.en
# HF_HUB_OFFLINE: модель — только из образа, сети к Hugging Face в рантайме нет и не нужно
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH="/app/.venv/bin:$PATH" TTS_VOICES_DIR=/app/voices \
    ASR_MODEL_DIR=/app/asr ASR_MODEL=${ASR_MODEL} HF_HUB_OFFLINE=1
# onnxruntime (Piper, VAD faster-whisper) и ctranslate2 — C++: libstdc++ и libgcc_s
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libgcc-s1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home app
WORKDIR /app/service
COPY --from=build /app/.venv /app/.venv
COPY --from=voices /voices /app/voices
COPY --from=asr /asr /app/asr
USER app
EXPOSE 8000
# Слушает :: в режиме dual-stack (IPv4 + IPv6): healthcheck Railway — IPv4, приватная сеть — оба. PORT — от платформы.
CMD ["python", "-m", "tilhero_common.serve", "tilhero_tts.main:app"]

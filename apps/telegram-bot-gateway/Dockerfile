# syntax=docker/dockerfile:1.7
# telegram-bot-gateway: без БД и миграций (только Redis). Контекст сборки — корень репозитория
# (Railway: Root Directory пустой, Dockerfile Path = apps/telegram-bot-gateway/Dockerfile).
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
# окружение сразу по итоговому пути: shebang у alembic/uvicorn указывает на /app/.venv/bin/python
WORKDIR /repo
COPY . .
RUN uv sync --frozen --no-dev --no-editable --package tilhero-botgw

FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH="/app/.venv/bin:$PATH"
RUN useradd --system --uid 10001 --no-create-home app
WORKDIR /app/service
COPY --from=build /app/.venv /app/.venv
USER app
EXPOSE 8107 8108
# Один процесс, два порта (ревью P1): PORT (публичный домен Railway) — только webhook и health;
# INTERNAL_PORT (8108, только приватная сеть *.railway.internal) — /internal/v1/messages для notifications.
# Слушаем `::` (dual-stack; приватная сеть Railway — IPv6). Access-лог uvicorn выключен (пишет общий middleware).
ENV INTERNAL_PORT=8108 HOST=::
CMD ["python", "-m", "tilhero_botgw"]

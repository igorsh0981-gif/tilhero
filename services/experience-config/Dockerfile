# syntax=docker/dockerfile:1.7
# Шаблон Dockerfile Python-сервиса TilHero (копируется в services/<name>/Dockerfile с подставленными значениями).
# Контекст сборки — корень репозитория (Railway: Root Directory пустой, Dockerfile Path = services/<name>/Dockerfile).
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
# окружение сразу по итоговому пути: shebang у alembic/uvicorn указывает на /app/.venv/bin/python
WORKDIR /repo
COPY . .
RUN uv sync --frozen --no-dev --no-editable --package tilhero-experience

FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH="/app/.venv/bin:$PATH"
RUN useradd --system --uid 10001 --no-create-home app
WORKDIR /app/service
COPY --from=build /app/.venv /app/.venv
COPY services/experience-config/alembic.ini ./alembic.ini
COPY services/experience-config/migrations ./migrations
USER app
EXPOSE 8000
# Слушает :: в режиме dual-stack (IPv4 + IPv6): healthcheck Railway — IPv4, приватная сеть — оба. PORT — от платформы.
CMD ["python", "-m", "tilhero_common.serve", "tilhero_experience.main:app"]

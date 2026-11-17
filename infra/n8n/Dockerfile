# syntax=docker/dockerfile:1.7
# TilHero — планировщик n8n (спринт 3). Контекст сборки — корень репозитория (Railway: RAILWAY_DOCKERFILE_PATH=
# infra/n8n/Dockerfile). Workflow из infra/n8n/workflows импортируются и включаются при каждом старте
# (entrypoint.sh): ручная настройка в UI не нужна, правки в UI перезаписываются при следующем деплое.
# n8n только вызывает внутренние эндпоинты learning-plan, notifications и social и не хранит доменные данные; его данные (sqlite,
# история запусков, учётка владельца) — в томе /home/node/.n8n. Версия закреплена: ветка 1.x (поддерживаемая 1.123).
FROM n8nio/n8n:1.123.83

USER root
COPY infra/n8n/workflows /workflows
COPY --chmod=0555 infra/n8n/entrypoint.sh /tilhero-entrypoint.sh
RUN chmod 0555 /workflows && chmod 0444 /workflows/*.json
USER node

# Значения по умолчанию (prod задаёт их ещё и в переменных Railway, infra/railway/setup.py → n8n.env).
# N8N_BLOCK_ENV_ACCESS_IN_NODE=false: выражения workflow читают $env.LEARNING_PLAN_URL, $env.NOTIFICATIONS_URL, $env.SOCIAL_URL и
# $env.SCHEDULER_TOKEN (секрет хранится только в Railway, не в credentials n8n).
ENV N8N_PORT=5678 \
    N8N_USER_FOLDER=/home/node \
    N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
    GENERIC_TIMEZONE=UTC \
    TZ=UTC \
    DB_TYPE=sqlite \
    DB_SQLITE_POOL_SIZE=2 \
    N8N_RUNNERS_ENABLED=true \
    N8N_DIAGNOSTICS_ENABLED=false \
    N8N_PERSONALIZATION_ENABLED=false \
    N8N_VERSION_NOTIFICATIONS_ENABLED=false \
    N8N_TEMPLATES_ENABLED=false \
    N8N_HIRING_BANNER_ENABLED=false \
    N8N_GIT_NODE_DISABLE_BARE_REPOS=true \
    N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true \
    EXECUTIONS_DATA_PRUNE=true \
    EXECUTIONS_DATA_MAX_AGE=336

EXPOSE 5678
# Healthcheck Railway: GET /healthz (отвечает сам n8n после старта HTTP-сервера)
ENTRYPOINT ["tini", "--", "/tilhero-entrypoint.sh"]

# syntax=docker/dockerfile:1.7
# telegram-bff (Node 22 + Fastify). Контекст сборки — КОРЕНЬ репозитория:
#   docker build -f services/telegram-bff/Dockerfile -t tilhero/telegram-bff .
# Railway: Root Directory пустой, Dockerfile Path = services/telegram-bff/Dockerfile (переменная RAILWAY_DOCKERFILE_PATH, docs/DEPLOYMENT.md).
#
# Lock-файл один на монорепозиторий: `npm ci` требует package.json ВСЕХ workspace'ов. В стадию зависимостей
# копируются только манифесты пакетов BFF (кэш слоя не сбивается правками Mini App), манифесты остальных workspace'ов
# восстанавливаются из package-lock.json (scripts/restore-workspace-manifests.mjs); ставятся только нужные (-w).
# Базовый образ — фиксированная версия (ревью T5); обновлять осознанно вместе с CI (node 22.22.0).
ARG NODE_IMAGE=node:22.22.0-alpine

# ---------- 1. манифесты (слой меняется только при изменении зависимостей) ----------
FROM ${NODE_IMAGE} AS manifests
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/ts-common/package.json packages/ts-common/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui-tokens/package.json packages/ui-tokens/
COPY services/telegram-bff/package.json services/telegram-bff/
COPY services/telegram-bff/scripts/restore-workspace-manifests.mjs /tmp/restore-workspace-manifests.mjs
RUN node /tmp/restore-workspace-manifests.mjs /repo

# ---------- 2. сборка: dev-зависимости (typescript), ts-common → dist, telegram-bff → dist ----------
FROM manifests AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
# без --mount=type=cache: Railway требует id=s/<service id>-… (у каждого сервиса свой), иначе сборка падает
RUN npm ci -w @tilhero/ts-common -w @tilhero/contracts -w @tilhero/telegram-bff --include-workspace-root=false
COPY tsconfig.base.json ./
COPY packages/ts-common packages/ts-common
# типы контракта (import type — в рантайме не нужны)
COPY packages/contracts packages/contracts
COPY services/telegram-bff services/telegram-bff
RUN npm run build -w @tilhero/ts-common && npm run build -w @tilhero/telegram-bff

# ---------- 3. только production-зависимости ----------
FROM manifests AS prod-deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
RUN npm ci --omit=dev -w @tilhero/telegram-bff --include-workspace-root=false

# ---------- 4. рантайм ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8001 HOST=::
WORKDIR /app
# манифесты + node_modules (workspace-симлинки @tilhero/* относительные и указывают внутрь /app).
# Файлы принадлежат root и только читаются процессом (USER node не может перезаписать свой код).
COPY --from=prod-deps /repo /app
COPY --from=build /repo/packages/ts-common/dist /app/packages/ts-common/dist
COPY --from=build /repo/services/telegram-bff/dist /app/services/telegram-bff/dist
WORKDIR /app/services/telegram-bff
USER node
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1
# Railway: приватная сеть требует слушать IPv6 (::); PORT задаёт платформа.
CMD ["node", "--enable-source-maps", "dist/main.js"]

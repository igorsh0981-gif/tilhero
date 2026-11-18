# syntax=docker/dockerfile:1.7
# admin-bff (Node 22 + Fastify). Контекст сборки — КОРЕНЬ репозитория:
#   docker build -f services/admin-bff/Dockerfile -t tilhero/admin-bff .
# Railway: Root Directory пустой, Dockerfile Path = services/admin-bff/Dockerfile (RAILWAY_DOCKERFILE_PATH).
# Публичного домена нет: admin-web (Caddy) проксирует /admin/v1/* на admin-bff.RAILWAY_PRIVATE_DOMAIN:8002.
#
# Lock-файл один на монорепозиторий: `npm ci` требует package.json ВСЕХ workspace'ов. В стадию зависимостей
# копируются только манифесты пакетов admin-bff, манифесты остальных workspace'ов восстанавливаются из
# package-lock.json (scripts/restore-workspace-manifests.mjs); ставятся только нужные (-w).
# Базовый образ — фиксированная версия (как telegram-bff; обновлять вместе с CI).
ARG NODE_IMAGE=node:22.22.0-alpine

# ---------- 1. манифесты (слой меняется только при изменении зависимостей) ----------
FROM ${NODE_IMAGE} AS manifests
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/ts-common/package.json packages/ts-common/
COPY packages/contracts/package.json packages/contracts/
COPY services/admin-bff/package.json services/admin-bff/
COPY services/admin-bff/scripts/restore-workspace-manifests.mjs /tmp/restore-workspace-manifests.mjs
RUN node /tmp/restore-workspace-manifests.mjs /repo

# ---------- 2. сборка: dev-зависимости (typescript), ts-common → dist, admin-bff → dist ----------
FROM manifests AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
# без --mount=type=cache: Railway требует id=s/<service id>-… (у каждого сервиса свой), иначе сборка падает
RUN npm ci -w @tilhero/ts-common -w @tilhero/contracts -w @tilhero/admin-bff --include-workspace-root=false
COPY tsconfig.base.json ./
COPY packages/ts-common packages/ts-common
# типы контракта admin.ts (import type — в рантайме не нужны)
COPY packages/contracts packages/contracts
COPY services/admin-bff services/admin-bff
RUN npm run build -w @tilhero/ts-common && npm run build -w @tilhero/admin-bff

# ---------- 3. только production-зависимости ----------
FROM manifests AS prod-deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
RUN npm ci --omit=dev -w @tilhero/admin-bff --include-workspace-root=false

# ---------- 4. рантайм ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8002 HOST=::
WORKDIR /app
# манифесты + node_modules (workspace-симлинки @tilhero/* относительные и указывают внутрь /app).
# Файлы принадлежат root и только читаются процессом (USER node не может перезаписать свой код).
COPY --from=prod-deps /repo /app
COPY --from=build /repo/packages/ts-common/dist /app/packages/ts-common/dist
COPY --from=build /repo/services/admin-bff/dist /app/services/admin-bff/dist
WORKDIR /app/services/admin-bff
USER node
EXPOSE 8002
# готовность: процесс жив и Redis сессий отвечает (без Redis вход и сессии невозможны)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/health/ready" >/dev/null || exit 1
# Railway: приватная сеть — IPv6; HOST=:: в Node — dual-stack (IPv4 тоже); PORT задаёт платформа.
CMD ["node", "--enable-source-maps", "dist/main.js"]

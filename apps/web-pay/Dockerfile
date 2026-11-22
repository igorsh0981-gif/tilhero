# syntax=docker/dockerfile:1.7
# web-pay (спринт 8): Vite-сборка статики сайта оплаты → Caddy (SPA fallback, /api/* → telegram-bff /web/v1/*,
# строгая CSP). Контекст сборки — КОРЕНЬ репозитория:
#   docker build -f apps/web-pay/Dockerfile -t tilhero/web-pay .
# Railway: Root Directory пустой, Dockerfile Path = apps/web-pay/Dockerfile (RAILWAY_DOCKERFILE_PATH);
# переменные сервиса: BFF_URL=http://${{telegram-bff.RAILWAY_PRIVATE_DOMAIN}}:8001 (рантайм, не сборка).
# В бандле нет ни одного build-time секрета или адреса: приложение ходит только на относительный /api.
# Контекст ограничен белым списком Dockerfile.dockerignore. Базовые образы — с фиксированной версией (как admin-web).
ARG NODE_IMAGE=node:22.20.0-alpine
ARG CADDY_IMAGE=caddy:2.10.2-alpine

# ---------- 1. зависимости (слой меняется только при изменении манифестов) ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# `npm ci` сверяет lock со ВСЕМИ workspace'ами корневого package.json — их манифесты восстанавливаются
# из package-lock.json, ставятся только зависимости web-pay (-w), без BFF и без корня.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web-pay/package.json apps/web-pay/
COPY services/telegram-bff/scripts/restore-workspace-manifests.mjs /tmp/restore-workspace-manifests.mjs
RUN node /tmp/restore-workspace-manifests.mjs /repo
RUN npm ci -w @tilhero/web-pay --include-workspace-root=false

# ---------- 2. сборка: typecheck (src) + vite build ----------
FROM deps AS build
COPY tsconfig.base.json ./
# типы API (import type) — единственный источник контракта telegram-bff /web/v1 ↔ web-pay (web.ts)
COPY packages/contracts packages/contracts
COPY apps/web-pay apps/web-pay
# страховка: в бандле нет Telegram SDK, сторонних адресов скриптов и моков
RUN npm run build -w @tilhero/web-pay \
    && ! grep -rqsE "telegram-web-app\.js|MockBff|googletagmanager|fonts\.googleapis" apps/web-pay/dist

# ---------- 3. рантайм: Caddy, только статика + reverse_proxy ----------
FROM ${CADDY_IMAGE} AS runtime
ENV PORT=8080 BFF_URL=http://telegram-bff.railway.internal:8001 \
    XDG_CONFIG_HOME=/tmp/caddy/config XDG_DATA_HOME=/tmp/caddy/data
RUN cp /usr/bin/caddy /tmp/caddy-bin && mv /tmp/caddy-bin /usr/bin/caddy && caddy version \
    && addgroup -S web && adduser -S -D -H -h /srv -G web web
COPY apps/web-pay/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web-pay/dist /srv
USER web
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

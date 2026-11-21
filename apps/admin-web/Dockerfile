# syntax=docker/dockerfile:1.7
# admin-web: Vite-сборка статики → Caddy (SPA fallback, прокси /admin/v1/* на admin-bff, заголовки безопасности).
# Контекст сборки — КОРЕНЬ репозитория:
#   docker build -f apps/admin-web/Dockerfile -t tilhero/admin-web .
# Railway: Root Directory пустой, Dockerfile Path = apps/admin-web/Dockerfile (RAILWAY_DOCKERFILE_PATH);
# переменные сервиса: ADMIN_BFF_URL=http://${{admin-bff.RAILWAY_PRIVATE_DOMAIN}}:8002 (рантайм, не сборка).
# В бандле нет ни одного build-time секрета или адреса: приложение ходит только на относительный /admin/v1.
#
# Контекст ограничен белым списком Dockerfile.dockerignore (BuildKit берёт его вместо корневого .dockerignore).
# Базовые образы — с фиксированной версией (как у telegram-miniapp; при первом CI-pull закрепить @sha256).
ARG NODE_IMAGE=node:22.20.0-alpine
ARG CADDY_IMAGE=caddy:2.10.2-alpine

# ---------- 1. зависимости (слой меняется только при изменении манифестов) ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# `npm ci` сверяет lock со ВСЕМИ workspace'ами корневого package.json — их манифесты восстанавливаются
# из package-lock.json, ставятся только зависимости admin-web (-w), без BFF и без корня.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/admin-web/package.json apps/admin-web/
COPY services/telegram-bff/scripts/restore-workspace-manifests.mjs /tmp/restore-workspace-manifests.mjs
RUN node /tmp/restore-workspace-manifests.mjs /repo
RUN npm ci -w @tilhero/admin-web --include-workspace-root=false

# ---------- 2. сборка: typecheck (src) + vite build ----------
FROM deps AS build
COPY tsconfig.base.json ./
# типы API (import type) — единственный источник контракта admin-bff ↔ admin-web
COPY packages/contracts packages/contracts
COPY apps/admin-web apps/admin-web
# иллюстрации «Что нового» (релиз 6.1): редактор берёт файлы сборки Mini App (import.meta.glob в news/catalog.ts)
COPY apps/telegram-miniapp/public/whatsnew apps/telegram-miniapp/public/whatsnew
# страховка: ни один секрет/токен/mock не попадает в production-бандл
RUN npm run build -w @tilhero/admin-web \
    && ! grep -rqsE "\"csrf-|Correct-Horse|JBSWY3DPEHPK3PXP|MockBff" apps/admin-web/dist

# ---------- 3. рантайм: Caddy, только статика + reverse_proxy ----------
FROM ${CADDY_IMAGE} AS runtime
# Порт задаёт платформа (Railway: PORT). ADMIN_BFF_URL — приватный адрес admin-bff (переменная сервиса).
ENV PORT=8080 ADMIN_BFF_URL=http://admin-bff.railway.internal:8002 \
    XDG_CONFIG_HOME=/tmp/caddy/config XDG_DATA_HOME=/tmp/caddy/data
# Не-root: порт > 1024, file capability cap_net_bind_service не нужна (копия бинаря без xattr работает
# и под no-new-privileges).
RUN cp /usr/bin/caddy /tmp/caddy-bin && mv /tmp/caddy-bin /usr/bin/caddy && caddy version \
    && addgroup -S web && adduser -S -D -H -h /srv -G web web
COPY apps/admin-web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/admin-web/dist /srv
USER web
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

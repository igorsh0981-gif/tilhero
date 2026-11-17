# syntax=docker/dockerfile:1.7
# telegram-miniapp: Vite-сборка статики → Caddy (SPA fallback, заголовки безопасности, кэш статики).
# Контекст сборки — КОРЕНЬ репозитория:
#   docker build -f apps/telegram-miniapp/Dockerfile \
#     --build-arg VITE_BFF_URL=https://bff.example.com --build-arg VITE_BOT_USERNAME=TilHeroBot \
#     -t tilhero/telegram-miniapp .
# Railway: Root Directory пустой, Dockerfile Path = apps/telegram-miniapp/Dockerfile (переменная RAILWAY_DOCKERFILE_PATH, docs/DEPLOYMENT.md);
# VITE_* задаются переменными сервиса — Railway передаёт их в сборку как build args (ARG ниже).
#
# Контекст сборки ограничен белым списком Dockerfile.dockerignore (BuildKit берёт его вместо корневого
# .dockerignore): в образ попадают только манифесты, contracts/src, ui-tokens и сама Mini App.
# Базовые образы — с фиксированной версией (обновлять осознанно; при первом CI-pull закрепить @sha256-дайджест).
ARG NODE_IMAGE=node:22.20.0-alpine
ARG CADDY_IMAGE=caddy:2.10.2-alpine

# ---------- 1. зависимости (слой меняется только при изменении манифестов) ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# `npm ci` сверяет lock со ВСЕМИ workspace'ами корневого package.json — нужны их манифесты,
# а ставятся только зависимости Mini App (-w), без BFF и без корня.
COPY package.json package-lock.json ./
COPY packages/ts-common/package.json packages/ts-common/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui-tokens/package.json packages/ui-tokens/
COPY services/telegram-bff/package.json services/telegram-bff/
COPY apps/telegram-miniapp/package.json apps/telegram-miniapp/
# манифесты остальных workspace'ов (admin-bff, admin-web, …) восстанавливаются из package-lock.json
COPY services/telegram-bff/scripts/restore-workspace-manifests.mjs /tmp/restore-workspace-manifests.mjs
RUN node /tmp/restore-workspace-manifests.mjs /repo
RUN npm ci -w @tilhero/telegram-miniapp --include-workspace-root=false

# ---------- 2. сборка: typecheck (src) + vite build ----------
FROM deps AS build
COPY tsconfig.base.json ./
# типы API (import type) и CSS-слои дизайн-системы
COPY packages/contracts packages/contracts
COPY packages/ui-tokens packages/ui-tokens
COPY apps/telegram-miniapp apps/telegram-miniapp
# Публичные build-time настройки (бандл публичен — секретов здесь нет и быть не может).
# VITE_BFF_URL — origin BFF без пути (https://host[:port]); он же попадает в CSP connect-src.
ARG VITE_BFF_URL
ARG VITE_BOT_USERNAME=TilHeroBot
ENV VITE_BFF_URL=${VITE_BFF_URL} VITE_BOT_USERNAME=${VITE_BOT_USERNAME} VITE_DEV_INIT_DATA=
RUN node -e 'const v = process.env.VITE_BFF_URL || ""; let u; try { u = new URL(v); } catch { console.error("VITE_BFF_URL is required (https://bff.example.com)"); process.exit(1); } if (u.origin !== v.replace(/\/+$/, "")) { console.error("VITE_BFF_URL must be an origin without a path: " + u.origin); process.exit(1); }'
# вторая команда — страховка: подписанный dev-initData (auth_date=…) не должен попасть в production-бандл
RUN npm run build -w @tilhero/telegram-miniapp \
    && ! grep -rqs "auth_date=" apps/telegram-miniapp/dist

# ---------- 3. рантайм: Caddy, только статика ----------
FROM ${CADDY_IMAGE} AS runtime
ARG VITE_BFF_URL
# Порт задаёт платформа (Railway: PORT). BFF_ORIGIN → CSP connect-src (можно переопределить переменной окружения).
ENV PORT=8080 BFF_ORIGIN=${VITE_BFF_URL} \
    XDG_CONFIG_HOME=/tmp/caddy/config XDG_DATA_HOME=/tmp/caddy/data
# Не-root: порт > 1024, поэтому file capability cap_net_bind_service не нужна. Копия бинаря без xattr
# работает и под no-new-privileges (с capability exec там падает с EPERM).
RUN cp /usr/bin/caddy /tmp/caddy-bin && mv /tmp/caddy-bin /usr/bin/caddy && caddy version \
    && addgroup -S web && adduser -S -D -H -h /srv -G web web
COPY apps/telegram-miniapp/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/telegram-miniapp/dist /srv
USER web
# валидируем уже от имени web: каталоги XDG в /tmp создаются с нужным владельцем
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

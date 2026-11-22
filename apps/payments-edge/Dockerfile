# syntax=docker/dockerfile:1.7
# payments-edge (спринт 8): публичный Caddy только для колбэков Payme, Click, Uzum → billing по приватной сети.
# Контекст сборки — КОРЕНЬ репозитория:
#   docker build -f apps/payments-edge/Dockerfile -t tilhero/payments-edge .
# Railway: Root Directory пустой, Dockerfile Path = apps/payments-edge/Dockerfile (RAILWAY_DOCKERFILE_PATH);
# переменные сервиса: BILLING_URL=http://${{billing.RAILWAY_PRIVATE_DOMAIN}}:8118, PAYMENTS_EDGE_TOKEN (рантайм).
# Контекст ограничен белым списком Dockerfile.dockerignore. Базовый образ — с фиксированной версией (как admin-web).
ARG CADDY_IMAGE=caddy:2.10.2-alpine

FROM ${CADDY_IMAGE} AS runtime
ENV PORT=8080 BILLING_URL=http://billing.railway.internal:8118 \
    XDG_CONFIG_HOME=/tmp/caddy/config XDG_DATA_HOME=/tmp/caddy/data
# Не-root: порт > 1024 (копия бинаря без file capability работает и под no-new-privileges)
RUN cp /usr/bin/caddy /tmp/caddy-bin && mv /tmp/caddy-bin /usr/bin/caddy && caddy version \
    && addgroup -S edge && adduser -S -D -H -h /srv -G edge edge
COPY apps/payments-edge/Caddyfile /etc/caddy/Caddyfile
USER edge
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

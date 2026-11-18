#!/usr/bin/env bash
# TilHero — сквозной локальный стенд спринта 1: все сервисы на реальных PG/Redis/NATS + мок Telegram Bot API.
# Перенесён из aievent (infra/e2e/run_local.sh) — только то, что нужно спринту 1, без туристического контура.
#
#   infra/e2e/run_local.sh up        — ключи внутреннего JWT (Ed25519 на издателя, как в prod), bootstrap ролей БД
#                                      (infra/db/bootstrap.sql), миграции под <svc>_owner, запуск сервисов под ролью <svc>
#                                      (только DML) + telegram-bff (Node, tsx) + мок Telegram
#   infra/e2e/run_local.sh test      — up + infra/e2e/scenario.py (PASS/FAIL по шагам, «Итого: N/M PASS»)
#   infra/e2e/run_local.sh ui [TGID] — дополнительно Mini App (vite :5173) с VITE_DEV_INIT_DATA для Telegram ID TGID
#   infra/e2e/run_local.sh status    — состояние процессов и /health/ready
#   infra/e2e/run_local.sh restart [name] — перезапустить один сервис (после правки кода) или всё
#   infra/e2e/run_local.sh stop [name] — остановить всё, что запустил этот скрипт (stack.sh не трогает), или один сервис
#
# Порты (docs/ARCHITECTURE.md): identity-consent 8101, learning-plan 8102, support 8103, notifications 8104, audit 8105,
# experience-config 8106, telegram-bot-gateway 8107 (публичный: webhook + health) + 8108 (внутренний API),
# social 8109, telegram-bff 8001, мок Telegram 8190, Mini App 5173.
# n8n на стенде не поднимается: plan:tick, notifications:dispatch и invites:tick вызывает сценарий с E2E_SCHEDULER_TOKEN
# (как n8n). Время слотов сценарий подбирает сдвигом часового пояса графика относительно реального now — часы сервисов
# не подменяются.
# Внутренний JWT: у каждого сервиса свой INTERNAL_JWT_PRIVATE_KEY, у всех — INTERNAL_JWT_PUBLIC_KEYS (как stage/prod,
# infra/scripts/gen_internal_keys.py); seed'ы — .dev/e2e/internal-keys.json (infra/e2e/internal_keys.py, не в git).
# Все Python-сервисы — ENV=dev (обязательная переменная).
# Логи: .dev/logs/<name>.log, PID: .dev/run/<name>.pid, перехват Telegram: .dev/e2e/telegram.jsonl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOGS="$ROOT/.dev/logs"
RUN="$ROOT/.dev/run"
E2E="$ROOT/.dev/e2e"
mkdir -p "$LOGS" "$RUN" "$E2E"

export UV_SYSTEM_CERTS=1
unset UV_NATIVE_TLS || true

# ---- общие параметры стенда (dev-значения, не секреты prod)
export E2E_BOT_TOKEN="${E2E_BOT_TOKEN:-123456789:dev-bot-token-change-me-0000000000}"
# секрет сервисов для HMAC (токены ссылок согласия родителя в identity-consent); ключи JWT из него НЕ выводятся
export E2E_INTERNAL_JWT_SECRET="${E2E_INTERNAL_JWT_SECRET:-e2e-internal-secret-0123456789abcdef-local}"
export E2E_SESSION_JWT_SECRET="${E2E_SESSION_JWT_SECRET:-e2e-session-secret-0123456789abcdef-local-xyz}"
export E2E_WEBHOOK_SECRET="${E2E_WEBHOOK_SECRET:-e2e-webhook-secret-0123456789abcdefXYZ}"
export E2E_INVITE_TOKEN_KEY="${E2E_INVITE_TOKEN_KEY:-e2e-invite-token-key-0123456789abcdef-local}"
export E2E_SCHEDULER_TOKEN="${E2E_SCHEDULER_TOKEN:-e2e-scheduler-token-0123456789abcdef-local}"
export E2E_MINIAPP_URL="${E2E_MINIAPP_URL:-https://miniapp.e2e.local}"
export E2E_MINIAPP_ORIGIN="${E2E_MINIAPP_ORIGIN:-http://127.0.0.1:5173}"
export E2E_TELEGRAM_APP_LINK="${E2E_TELEGRAM_APP_LINK:-https://t.me/tilhero_e2e_bot/app}"
export E2E_REDIS_URL="${E2E_REDIS_URL:-redis://127.0.0.1:6379/0}"
export E2E_NATS_URL="${E2E_NATS_URL:-nats://127.0.0.1:4222}"
export E2E_DB="${E2E_DB:-tilhero}"
MOCK_TG_PORT="${MOCK_TG_PORT:-8190}"
BOTGW_INTERNAL_PORT="${BOTGW_INTERNAL_PORT:-8108}"
PG="127.0.0.1:5432"
KEYS_FILE="$E2E/internal-keys.json"

# name | каталог | модуль uvicorn (или "-m пакет" — свой запуск) | порт | роль/схема БД ("" — без БД)
PY_SERVICES=(
  "audit|services/audit|tilhero_audit.main:app|8105|audit"
  "experience-config|services/experience-config|tilhero_experience.main:app|8106|experience_config"
  "identity-consent|services/identity-consent|tilhero_identity.main:app|8101|identity_consent"
  "learning-plan|services/learning-plan|tilhero_learning_plan.main:app|8102|learning_plan"
  "social|services/social|tilhero_social.main:app|8109|social"
  "support|services/support|tilhero_support.main:app|8103|support"
  "telegram-bot-gateway|apps/telegram-bot-gateway|-m tilhero_botgw|8107|"
  "notifications|services/notifications|tilhero_notifications.main:app|8104|notifications"
)

log() { printf '\033[1;34m[e2e]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[e2e] %s\033[0m\n' "$*" >&2; exit 1; }

load_keys() {
  # Ed25519 на издателя (как prod): E2E_KEY_<ИЗДАТЕЛЬ>, E2E_PUBLIC_KEYS — JSON открытых ключей всех издателей
  local out
  out="$(cd "$ROOT" && uv run --quiet python infra/e2e/internal_keys.py --file "$KEYS_FILE" --shell)" \
    || die "не удалось подготовить ключи внутреннего JWT ($KEYS_FILE)"
  eval "$out"
}

key_of() {
  local var="E2E_KEY_$(echo "$1" | tr 'a-z-' 'A-Z_')"
  printf '%s' "${!var}"
}

common_py_env() {
  # окружение, общее для всех Python-сервисов
  echo "ENV=dev LOG_LEVEL=INFO INTERNAL_JWT_SECRET=$E2E_INTERNAL_JWT_SECRET REDIS_URL=$E2E_REDIS_URL NATS_URL=$E2E_NATS_URL"
}

svc_env() {
  local name="$1" role="$2"
  local env
  env="$(common_py_env) INTERNAL_JWT_PRIVATE_KEY=$(key_of "$name") INTERNAL_JWT_PUBLIC_KEYS=$E2E_PUBLIC_KEYS"
  if [ -n "$role" ]; then
    # рантайм — роль сервиса (только DML), миграции — роль-владелец схемы (infra/db/bootstrap.sql)
    env="$env DATABASE_URL=postgresql://$role:dev@$PG/$E2E_DB DB_SCHEMA=$role"
    env="$env MIGRATION_DATABASE_URL=postgresql://${role}_owner:dev@$PG/$E2E_DB"
  fi
  case "$name" in
    identity-consent)
      # таймер саги удаления — раз в 5 с (prod 60); расписание повторов и DELETION_STUCK_HOURS — как в prod
      env="$env NOTIFICATIONS_URL=http://127.0.0.1:8104 DELETION_SWEEP_SECONDS=${E2E_DELETION_SWEEP_SECONDS:-5}" ;;
    learning-plan)
      env="$env SCHEDULER_TOKEN=$E2E_SCHEDULER_TOKEN" ;;
    social)
      env="$env SCHEDULER_TOKEN=$E2E_SCHEDULER_TOKEN INVITE_TOKEN_KEY=$E2E_INVITE_TOKEN_KEY"
      env="$env TELEGRAM_APP_LINK=$E2E_TELEGRAM_APP_LINK IDENTITY_CONSENT_URL=http://127.0.0.1:8101" ;;
    notifications)
      # bot-gateway: только ВНУТРЕННИЙ порт (публичный 8107 отдаёт лишь webhook и health)
      env="$env IDENTITY_CONSENT_URL=http://127.0.0.1:8101 BOTGW_URL=http://127.0.0.1:$BOTGW_INTERNAL_PORT"
      env="$env DISPATCH_INTERVAL_SECONDS=0.5 SCHEDULER_TOKEN=$E2E_SCHEDULER_TOKEN" ;;
    telegram-bot-gateway)
      env="$env BOT_TOKEN=$E2E_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET=$E2E_WEBHOOK_SECRET MINIAPP_URL=$E2E_MINIAPP_URL"
      env="$env TELEGRAM_API_BASE=http://127.0.0.1:$MOCK_TG_PORT IDENTITY_CONSENT_URL=http://127.0.0.1:8101"
      env="$env TELEGRAM_APP_LINK=$E2E_TELEGRAM_APP_LINK HOST=127.0.0.1 INTERNAL_PORT=$BOTGW_INTERNAL_PORT" ;;
  esac
  echo "$env"
}

# Время старта процесса (поле 22 /proc/<pid>/stat после «) »): PID после перезапуска машины переиспользуется, и
# устаревший .pid мог указывать на ДРУГОЙ живой процесс — тогда сервис «уже запущен» и не стартовал бы.
proc_start() { sed -E 's/^.*\) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}' || true; }
is_running() {
  local pid
  [ -f "$RUN/$1.pid" ] || return 1
  pid="$(cat "$RUN/$1.pid")"
  kill -0 "$pid" 2>/dev/null || return 1
  [ -f "$RUN/$1.start" ] && [ "$(cat "$RUN/$1.start")" = "$(proc_start "$pid")" ]
}

# запуск в отдельной группе процессов (uv/npx порождают дочерние) — stop гасит всю группу
spawn() {
  local name="$1" dir="$2"; shift 2
  if is_running "$name"; then log "$name уже запущен (pid $(cat "$RUN/$name.pid"))"; return; fi
  log "старт $name"
  ( cd "$ROOT/$dir" && exec setsid "$@" >>"$LOGS/$name.log" 2>&1 < /dev/null ) &
  echo $! > "$RUN/$name.pid"
  proc_start $! > "$RUN/$name.start"
}

wait_ready() {
  local name="$1" url="$2" timeout="${3:-60}"
  for _ in $(seq 1 $((timeout * 4))); do
    if curl -fsS "$url" >/dev/null 2>&1; then log "$name ready ($url)"; return 0; fi
    if ! is_running "$name"; then tail -n 40 "$LOGS/$name.log" >&2; die "$name упал при старте (лог: $LOGS/$name.log)"; fi
    sleep 0.25
  done
  curl -sS "$url" >&2 || true
  tail -n 40 "$LOGS/$name.log" >&2
  die "$name не стал ready за ${timeout}s"
}

bootstrap_db() {
  # Роли как в prod: <svc>_owner владеет схемой (миграции), <svc> — рантайм без DDL. Идемпотентно. Пароли dev
  # (локально trust-auth); bootstrap.sql создаёт роли без пароля — как на Railway, пароль задаётся отдельно.
  log "bootstrap ролей БД (infra/db/bootstrap.sql → $E2E_DB)"
  psql -h 127.0.0.1 -p 5432 -U postgres -d "$E2E_DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/infra/db/bootstrap.sql" \
    >>"$LOGS/bootstrap.log" 2>&1 || { tail -n 20 "$LOGS/bootstrap.log" >&2; die "bootstrap.sql не прошёл"; }
  local spec name dir mod port role
  for spec in "${PY_SERVICES[@]}"; do
    IFS='|' read -r name dir mod port role <<<"$spec"
    [ -n "$role" ] || continue
    psql -h 127.0.0.1 -p 5432 -U postgres -d "$E2E_DB" -q -v ON_ERROR_STOP=1 \
      -c "ALTER ROLE $role PASSWORD 'dev'" -c "ALTER ROLE ${role}_owner PASSWORD 'dev'" >/dev/null
  done
}

migrate() {
  local name="$1" dir="$2" role="$3"
  [ -n "$role" ] || return 0
  log "миграции $name (роль ${role}_owner; рантайм — $role)"
  # shellcheck disable=SC2046
  ( cd "$ROOT/$dir" && env $(svc_env "$name" "$role") uv run --quiet alembic -c alembic.ini upgrade head ) \
    >>"$LOGS/$name.migrate.log" 2>&1 || { tail -n 30 "$LOGS/$name.migrate.log" >&2; die "миграции $name не прошли"; }
}

up() {
  bash "$ROOT/infra/dev/stack.sh" up >/dev/null || die "stack.sh up не поднял PG/Redis/NATS"
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null || die "PostgreSQL недоступен"
  load_keys

  spawn mock-telegram . uv run --quiet python infra/e2e/mock_telegram.py --port "$MOCK_TG_PORT" \
    --token "$E2E_BOT_TOKEN" --store "$E2E/telegram.jsonl"
  wait_ready mock-telegram "http://127.0.0.1:$MOCK_TG_PORT/health" 30

  bootstrap_db
  local spec name dir mod port role
  for spec in "${PY_SERVICES[@]}"; do
    IFS='|' read -r name dir mod port role <<<"$spec"
    migrate "$name" "$dir" "$role"
  done
  for spec in "${PY_SERVICES[@]}"; do
    IFS='|' read -r name dir mod port role <<<"$spec"
    if [[ "$mod" == "-m "* ]]; then  # собственная точка входа (bot-gateway: два порта в одном процессе)
      # shellcheck disable=SC2046,SC2086
      spawn "$name" "$dir" env $(svc_env "$name" "$role") PORT="$port" uv run --quiet python $mod
    else
      # shellcheck disable=SC2046
      spawn "$name" "$dir" env $(svc_env "$name" "$role") PORT="$port" \
        uv run --quiet uvicorn "$mod" --host 127.0.0.1 --port "$port" --no-access-log
    fi
  done

  # telegram-bff: ts-common собирается в dist (BFF импортирует собранный пакет), сам BFF — через tsx из src
  if ! is_running telegram-bff; then
    log "сборка ts-common → dist"
    ( cd "$ROOT" && npm run --silent build -w @tilhero/ts-common ) >>"$LOGS/telegram-bff.build.log" 2>&1 \
      || { tail -n 30 "$LOGS/telegram-bff.build.log" >&2; die "сборка ts-common не прошла"; }
  fi
  spawn telegram-bff services/telegram-bff env ENV=dev NODE_ENV=development PORT=8001 HOST=127.0.0.1 LOG_LEVEL=info \
    TRUST_PROXY_HOPS=0 BOT_TOKEN="$E2E_BOT_TOKEN" SESSION_JWT_SECRET="$E2E_SESSION_JWT_SECRET" \
    INTERNAL_JWT_PRIVATE_KEY="$(key_of telegram-bff)" INTERNAL_JWT_PUBLIC_KEYS="$E2E_PUBLIC_KEYS" \
    REDIS_URL="$E2E_REDIS_URL" MINIAPP_ORIGIN="$E2E_MINIAPP_ORIGIN,http://localhost:5173" \
    TELEGRAM_APP_LINK="$E2E_TELEGRAM_APP_LINK" \
    IDENTITY_URL=http://127.0.0.1:8101 LEARNING_PLAN_URL=http://127.0.0.1:8102 SUPPORT_URL=http://127.0.0.1:8103 \
    NOTIFICATIONS_URL=http://127.0.0.1:8104 EXPERIENCE_URL=http://127.0.0.1:8106 SOCIAL_URL=http://127.0.0.1:8109 \
    RATE_LIMIT_SESSION_IP_PER_MIN="${E2E_RATE_LIMIT_SESSION_IP_PER_MIN:-500}" \
    RATE_LIMIT_USER_PER_MIN="${E2E_RATE_LIMIT_USER_PER_MIN:-600}" \
    RATE_LIMIT_PUBLIC_IP_PER_MIN="${E2E_RATE_LIMIT_PUBLIC_IP_PER_MIN:-600}" \
    npx tsx src/main.ts

  for spec in "${PY_SERVICES[@]}"; do
    IFS='|' read -r name dir mod port role <<<"$spec"
    wait_ready "$name" "http://127.0.0.1:$port/health/ready" 90
  done
  wait_ready telegram-bot-gateway "http://127.0.0.1:$BOTGW_INTERNAL_PORT/health/ready" 30
  wait_ready telegram-bff "http://127.0.0.1:8001/health/ready" 90
  log "стенд поднят; логи: $LOGS"
}

ui() {
  local tgid="${1:-$((700000000 + RANDOM * 10 + RANDOM % 10))}"
  is_running telegram-bff || up
  local init
  init="$(cd "$ROOT" && uv run --quiet python infra/e2e/initdata.py --user-id "$tgid" --name "Игорь" \
          --username "e2e_ui_$tgid" --lang ru --bot-token "$E2E_BOT_TOKEN")"
  printf '{"telegram_user_id": %s}\n' "$tgid" > "$E2E/ui_user.json"
  if is_running miniapp; then stop_one miniapp; fi
  : > "$LOGS/miniapp.log"
  log "Mini App :5173 для Telegram ID $tgid"
  spawn miniapp apps/telegram-miniapp env VITE_BFF_URL=http://127.0.0.1:8001 VITE_DEV_INIT_DATA="$init" \
    npx vite --host 127.0.0.1 --port 5173 --strictPort
  wait_ready miniapp "http://127.0.0.1:5173/" 60
}

stop_one() {
  local name="$1" pid
  [ -f "$RUN/$name.pid" ] || return 0
  pid="$(cat "$RUN/$name.pid")"
  if ! is_running "$name"; then rm -f "$RUN/$name.pid" "$RUN/$name.start"; return 0; fi  # устаревший PID — не наш
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    log "остановлен $name"
  fi
  rm -f "$RUN/$name.pid" "$RUN/$name.start"
}

stop() {
  local f
  for f in miniapp telegram-bff notifications telegram-bot-gateway social support learning-plan identity-consent \
           experience-config audit mock-telegram; do
    stop_one "$f"
  done
}

status() {
  local spec name dir mod port role
  printf '%-22s %-8s %s\n' service pid ready
  for spec in "${PY_SERVICES[@]}" "telegram-bot-gateway(int)|.|.|$BOTGW_INTERNAL_PORT|" "telegram-bff|.|.|8001|" \
              "mock-telegram|.|.|$MOCK_TG_PORT|" "miniapp|.|.|5173|"; do
    IFS='|' read -r name dir mod port role <<<"$spec"
    local path="/health/ready"; [[ "$name" == mock-* ]] && path="/health"; [ "$name" = miniapp ] && path="/"
    local pid="-"; is_running "${name%(int)}" && pid="$(cat "$RUN/${name%(int)}.pid")"
    local code; code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$path" 2>/dev/null || true)"
    [ "$code" = "000" ] || [ -z "$code" ] && code=down
    printf '%-22s %-8s %s\n' "$name" "$pid" "$code"
  done
}

case "${1:-up}" in
  up) up ;;
  ui) shift; ui "${1:-}" ;;
  test)
    up; cd "$ROOT"
    rc=0
    uv run --quiet python infra/e2e/scenario.py "${@:2}" || rc=1
    exit $rc ;;
  stop|down) shift; if [ -n "${1:-}" ]; then stop_one "$1"; else stop; fi ;;
  restart) shift; if [ -n "${1:-}" ]; then stop_one "$1"; else stop; fi; up ;;
  status) status ;;
  *) echo "usage: $0 up|test [аргументы scenario.py]|ui [tg_id]|status|stop [name]|restart [name]"; exit 2 ;;
esac

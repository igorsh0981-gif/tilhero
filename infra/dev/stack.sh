#!/usr/bin/env bash
# TilHero — локальный стенд dev/test без Docker: PostgreSQL 16, Redis 7, NATS (JetStream).
# Использование:
#   infra/dev/stack.sh up      — запустить (идемпотентно)
#   infra/dev/stack.sh down    — остановить
#   infra/dev/stack.sh status  — состояние
#   infra/dev/stack.sh reset   — снести данные и поднять заново
#   infra/dev/stack.sh stop nats|redis  — спринт 9 (учения отказа Q7): остановить одну зависимость (Postgres не трогается)
#   infra/dev/stack.sh start nats|redis — поднять её обратно
#     Redis останавливается с сохранением снимка (SHUTDOWN SAVE) и поднимается из него — как перезапуск Redis с
#     постоянным хранением: сессии, лимиты, кэши переживают учение; снимок удаляется сразу после старта (обычный `up`
#     стартует с пустым Redis, как раньше). NATS — JetStream на диске (-sd), стримы и консьюмеры сохраняются.
# Данные лежат в .dev/ (в .gitignore). Порты: PG 5432, Redis 6379, NATS 4222 (monitor 8222).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEV="$ROOT/.dev"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
NATS_BIN="${NATS_BIN:-$(command -v nats-server || echo "$HOME/.devtools/nats-server")}"
PGDATA="$DEV/pg"
PGPORT="${PGPORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"
NATS_PORT="${NATS_PORT:-4222}"

# Сервисы со своей схемой БД (owner schema per bounded context, ТЗ §Инфраструктура).
SERVICES=(identity_consent learning_plan social support notifications audit experience_config admin_identity user_admin catalog diagnostics)

as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

pg_up() {
  mkdir -p "$DEV"
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    mkdir -p "$PGDATA"
    [ "$(id -u)" = "0" ] && chown -R postgres:postgres "$PGDATA"
    as_pg "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
    echo "listen_addresses='127.0.0.1'" >> "$PGDATA/postgresql.conf"
    echo "port=$PGPORT" >> "$PGDATA/postgresql.conf"
    echo "unix_socket_directories='/tmp'" >> "$PGDATA/postgresql.conf"
  fi
  if ! as_pg "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    as_pg "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w start >/dev/null
  fi
  for db in tilhero tilhero_test; do
    psql -h 127.0.0.1 -p "$PGPORT" -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
      || psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qc "CREATE DATABASE $db"
  done
  # Роль и схема на каждый сервис: сервис видит только свою схему (no cross-service SQL).
  for svc in "${SERVICES[@]}"; do
    for db in tilhero tilhero_test; do
      psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$db" -q -v ON_ERROR_STOP=1 <<SQL
SET client_min_messages TO WARNING;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${svc}') THEN
    CREATE ROLE ${svc} LOGIN PASSWORD 'dev';
  END IF;
END \$\$;
CREATE SCHEMA IF NOT EXISTS ${svc} AUTHORIZATION ${svc};
REVOKE ALL ON SCHEMA public FROM ${svc};
GRANT CONNECT ON DATABASE ${db} TO ${svc};
SQL
    done
  done
}

redis_up() {
  mkdir -p "$DEV/redis"
  if ! redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$DEV/redis" --daemonize yes \
      --logfile "$DEV/redis/redis.log" --save "" --appendonly no >/dev/null
  fi
}

nats_up() {
  mkdir -p "$DEV/nats"
  if ! curl -fsS "http://127.0.0.1:8222/healthz" >/dev/null 2>&1; then
    nohup "$NATS_BIN" -a 127.0.0.1 -p "$NATS_PORT" -m 8222 -js -sd "$DEV/nats" >"$DEV/nats/nats.log" 2>&1 &
    echo $! > "$DEV/nats/nats.pid"
    for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:8222/healthz" >/dev/null 2>&1 && break; sleep 0.1; done
  fi
}

down() {
  as_pg "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  if [ -f "$DEV/nats/nats.pid" ]; then kill "$(cat "$DEV/nats/nats.pid")" 2>/dev/null || true; rm -f "$DEV/nats/nats.pid"; fi
}

stop_one() {
  case "${1:-}" in
    redis)
      redis-cli -p "$REDIS_PORT" shutdown save >/dev/null 2>&1 || true
      for _ in $(seq 1 50); do redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 || break; sleep 0.1; done ;;
    nats)
      if [ -f "$DEV/nats/nats.pid" ]; then kill "$(cat "$DEV/nats/nats.pid")" 2>/dev/null || true; rm -f "$DEV/nats/nats.pid"; fi
      pkill -f "nats-server .*-p $NATS_PORT" 2>/dev/null || true
      for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:8222/healthz" >/dev/null 2>&1 || break; sleep 0.1; done ;;
    *) echo "usage: $0 stop|start nats|redis"; exit 2 ;;
  esac
}

start_one() {
  case "${1:-}" in
    redis)
      redis_up
      for _ in $(seq 1 100); do redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 && break; sleep 0.1; done
      rm -f "$DEV/redis/dump.rdb" ;;
    nats) nats_up ;;
    *) echo "usage: $0 stop|start nats|redis"; exit 2 ;;
  esac
}

status() {
  printf "postgres: "; pg_isready -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1 && echo up || echo down
  printf "redis:    "; redis-cli -p "$REDIS_PORT" ping 2>/dev/null || echo down
  printf "nats:     "; curl -fsS "http://127.0.0.1:8222/healthz" 2>/dev/null || echo down; echo
}

case "${1:-up}" in
  up) pg_up; redis_up; nats_up; status ;;
  down) down ;;
  status) status ;;
  reset) down; rm -rf "$DEV"; pg_up; redis_up; nats_up; status ;;
  stop) stop_one "${2:-}"; status ;;
  start) start_one "${2:-}"; status ;;
  *) echo "usage: $0 up|down|status|reset|stop nats|redis|start nats|redis"; exit 2 ;;
esac

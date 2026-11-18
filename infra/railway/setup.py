"""Подготовка переменных Railway для TilHero (stage/prod). Ничего не отправляет в Railway и не пишет секреты в stdout.

    uv run python infra/railway/setup.py --out .dev/railway --bot-username TilHeroBot --app-name app

Что делает:
1. Генерирует секреты: Ed25519-ключ внутреннего JWT на каждый сервис (+ общий список открытых ключей),
   SCHEDULER_TOKEN (n8n), SESSION_JWT_SECRET (BFF), INVITE_TOKEN_KEY (social), TELEGRAM_WEBHOOK_SECRET (бот),
   пароли ролей БД <svc> и <svc>_owner.
2. Пишет в --out (каталог .dev/ в .gitignore — файлы НЕ коммитить):
   - <service>.env — переменные сервиса для вставки в Railway (Variables → Raw Editor);
   - db-passwords.sql — пароли ролей; выполнить ПОСЛЕ infra/db/bootstrap.sql под владельцем БД;
   - services.md — таблица: Dockerfile, публичный домен, Pre-Deploy Command, healthcheck.
Ссылки ${{…}} Railway подставляет сам: адреса приватной сети, Redis, публичные домены.
BOT_TOKEN вводится вручную в Railway (telegram-bot-gateway и telegram-bff) — скрипт его не знает.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages" / "py-common" / "src"))

from tilhero_common.internal_auth import b64e, private_from_seed, public_raw  # noqa: E402

REDIS = "REDIS_URL=${{Redis.REDIS_URL}}"
NATS = "NATS_URL=nats://${{nats.RAILWAY_PRIVATE_DOMAIN}}:4222"
PG_HOST = "${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{Postgres.PGDATABASE}}"
MIGRATE = "alembic -c /app/service/alembic.ini upgrade head"


@dataclass(frozen=True)
class Service:
    name: str
    port: int
    dockerfile: str
    schema: str | None = None  # схема и роли PostgreSQL; None — без БД
    public: bool = False
    health: str = "/health/ready"
    calls: tuple[str, ...] = ()  # кого вызывает по HTTP (переменная <X>_URL)
    extra: tuple[str, ...] = field(default_factory=tuple)


SERVICES: tuple[Service, ...] = (
    Service("identity-consent", 8101, "services/identity-consent/Dockerfile", "identity_consent",
            calls=("notifications",)),
    Service("learning-plan", 8102, "services/learning-plan/Dockerfile", "learning_plan"),
    Service("support", 8103, "services/support/Dockerfile", "support"),
    Service("notifications", 8104, "services/notifications/Dockerfile", "notifications",
            calls=("identity-consent", "telegram-bot-gateway")),
    Service("audit", 8105, "services/audit/Dockerfile", "audit"),
    Service("experience-config", 8106, "services/experience-config/Dockerfile", "experience_config"),
    Service("telegram-bot-gateway", 8107, "apps/telegram-bot-gateway/Dockerfile", public=True,
            calls=("identity-consent",)),
    Service("social", 8109, "services/social/Dockerfile", "social", calls=("identity-consent",)),
    Service("telegram-bff", 8001, "services/telegram-bff/Dockerfile", public=True,
            calls=("identity-consent", "learning-plan", "support", "notifications", "experience-config", "social")),
    Service("telegram-miniapp", 8080, "apps/telegram-miniapp/Dockerfile", public=True, health="/healthz"),
    Service("n8n", 5678, "infra/n8n/Dockerfile", health="/healthz",
            calls=("learning-plan", "notifications", "social")),
)
JWT_ISSUERS = ("identity-consent", "learning-plan", "support", "notifications", "audit", "experience-config",
               "telegram-bot-gateway", "social", "telegram-bff", "admin-bff")
SCHEDULED = ("learning-plan", "notifications", "social")
# имя переменной адреса в коде вызывающего (BFF и Python-сервисы называют identity по-разному)
URL_VAR = {
    ("telegram-bff", "identity-consent"): "IDENTITY_URL",
    ("telegram-bff", "experience-config"): "EXPERIENCE_URL",
    ("notifications", "telegram-bot-gateway"): "BOT_GATEWAY_URL",
}
BOT_INTERNAL_PORT = 8108
_USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{3,31}$")
_APP_RE = re.compile(r"^[A-Za-z0-9_]{3,30}$")


def by_name(name: str) -> Service:
    return next(s for s in SERVICES if s.name == name)


def private_url(name: str) -> str:
    port = BOT_INTERNAL_PORT if name == "telegram-bot-gateway" else by_name(name).port
    return f"http://${{{{{name}.RAILWAY_PRIVATE_DOMAIN}}}}:{port}"


def url_var(caller: str, callee: str) -> str:
    return URL_VAR.get((caller, callee), callee.upper().replace("-", "_") + "_URL")


def token(nbytes: int = 32) -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(nbytes)).decode().rstrip("=")


def pg_url(role: str, password: str) -> str:
    return f"postgresql://{role}:{password}@{PG_HOST}"


@dataclass
class Secrets:
    seeds: dict[str, bytes]
    passwords: dict[str, str]
    scheduler: str
    session_jwt: str
    invite_key: str
    webhook: str

    @classmethod
    def new(cls) -> Secrets:
        roles = [r for s in SERVICES if s.schema for r in (s.schema, f"{s.schema}_owner")]
        return cls(seeds={n: os.urandom(32) for n in JWT_ISSUERS},
                   passwords={r: secrets.token_hex(24) for r in roles},
                   scheduler=token(), session_jwt=token(48), invite_key=token(), webhook=secrets.token_hex(32))

    def public_keys(self) -> str:
        return json.dumps({n: b64e(public_raw(private_from_seed(s))) for n, s in self.seeds.items()},
                          separators=(",", ":"))


def service_env(svc: Service, sec: Secrets, *, env: str, app_link: str) -> list[str]:
    lines: list[str] = [f"ENV={env}", f"PORT={svc.port}"]
    if svc.name == "telegram-miniapp":
        return [*lines, "BFF_ORIGIN=https://${{telegram-bff.RAILWAY_PUBLIC_DOMAIN}}",
                "# build args: VITE_BFF_URL=https://${{telegram-bff.RAILWAY_PUBLIC_DOMAIN}}"]
    if svc.name == "n8n":
        lines = ["PORT=5678", f"SCHEDULER_TOKEN={sec.scheduler}"]
        return lines + [f"{url_var('n8n', c)}={private_url(c)}" for c in svc.calls]
    if svc.name == "telegram-bff":
        lines = ["NODE_ENV=production", f"PORT={svc.port}", "HOST=::"]
    if svc.schema:
        lines += [f"DATABASE_URL={pg_url(svc.schema, sec.passwords[svc.schema])}",
                  f"MIGRATION_DATABASE_URL={pg_url(svc.schema + '_owner', sec.passwords[svc.schema + '_owner'])}"]
    lines += [REDIS]
    if svc.name != "telegram-bff":
        lines += [NATS]
    if svc.name in JWT_ISSUERS:
        lines += [f"INTERNAL_JWT_PRIVATE_KEY={b64e(sec.seeds[svc.name])}",
                  f"INTERNAL_JWT_PUBLIC_KEYS={sec.public_keys()}"]
    lines += [f"{url_var(svc.name, c)}={private_url(c)}" for c in svc.calls]
    if svc.name in SCHEDULED:
        lines.append(f"SCHEDULER_TOKEN={sec.scheduler}")
    if svc.name == "social":
        lines += [f"INVITE_TOKEN_KEY={sec.invite_key}", f"TELEGRAM_APP_LINK={app_link}"]
    if svc.name == "telegram-bff":
        lines += [f"SESSION_JWT_SECRET={sec.session_jwt}", f"TELEGRAM_APP_LINK={app_link}",
                  "MINIAPP_ORIGIN=https://${{telegram-miniapp.RAILWAY_PUBLIC_DOMAIN}}",
                  "BOT_TOKEN=  # ввести вручную: токен бота от @BotFather"]
    if svc.name == "telegram-bot-gateway":
        lines += [f"INTERNAL_PORT={BOT_INTERNAL_PORT}", "HOST=::", f"TELEGRAM_WEBHOOK_SECRET={sec.webhook}",
                  "TELEGRAM_WEBHOOK_URL=https://${{telegram-bot-gateway.RAILWAY_PUBLIC_DOMAIN}}/telegram/webhook",
                  "MINIAPP_URL=https://${{telegram-miniapp.RAILWAY_PUBLIC_DOMAIN}}",
                  f"TELEGRAM_APP_LINK={app_link}", "BOT_AUTO_SETUP=true",
                  "BOT_TOKEN=  # ввести вручную: токен бота от @BotFather"]
    return lines


def services_table() -> str:
    rows = ["| Сервис | Dockerfile (RAILWAY_DOCKERFILE_PATH) | Публичный домен | Pre-Deploy Command | Healthcheck |",
            "|---|---|---|---|---|"]
    for s in SERVICES:
        rows.append(f"| {s.name} | `{s.dockerfile}` | {'да' if s.public else 'нет'} | "
                    f"{f'`{MIGRATE}`' if s.schema else '—'} | `{s.health}` |")
    infra = ("\nИнфраструктура: Postgres (шаблон Railway), Redis (шаблон Railway), nats (образ `nats:2.11-alpine`, "
             "команда `-js -sd /data`, том `/data`). n8n — том `/home/node/.n8n`.\n"
             "Порядок: Postgres → `psql \"$DATABASE_PUBLIC_URL\" -f infra/db/bootstrap.sql` → `-f db-passwords.sql` → "
             "сервисы (Pre-Deploy применит миграции) → identity-consent раньше social (social требует поля согласия).\n")
    return "\n".join(rows) + "\n" + infra


def db_passwords_sql(sec: Secrets) -> str:
    return "".join(f"ALTER ROLE {role} PASSWORD '{pw}';\n" for role, pw in sorted(sec.passwords.items()))


def build(sec: Secrets, *, env: str, bot_username: str, app_name: str) -> dict[str, str]:
    if not _USERNAME_RE.match(bot_username) or not _APP_RE.match(app_name):
        raise ValueError("bot username / app short name: латиница, цифры, _")
    app_link = f"https://t.me/{bot_username}/{app_name}"
    files = {f"{s.name}.env": "\n".join(service_env(s, sec, env=env, app_link=app_link)) + "\n" for s in SERVICES}
    files["db-passwords.sql"] = db_passwords_sql(sec)
    files["services.md"] = services_table()
    return files


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--env", choices=("stage", "prod"), default="prod")
    ap.add_argument("--bot-username", required=True)
    ap.add_argument("--app-name", required=True, help="short name Mini App в @BotFather (t.me/<bot>/<app>)")
    a = ap.parse_args(argv)
    out: Path = a.out
    if out.exists() and any(out.iterdir()):
        print(f"{out} не пуст — новые секреты не перезаписывают старые, выберите пустой каталог", file=sys.stderr)
        return 2
    files = build(Secrets.new(), env=a.env, bot_username=a.bot_username, app_name=a.app_name)
    out.mkdir(parents=True, exist_ok=True)
    os.chmod(out, 0o700)
    for name, text in files.items():
        path = out / name
        path.write_text(text, encoding="utf-8")
        os.chmod(path, 0o600)
    print(f"Готово: {len(files)} файлов в {out} (секреты — только в файлах). Дальше — {out}/services.md.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

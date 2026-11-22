"""Подготовка переменных Railway для TilHero (stage/prod). Ничего не отправляет в Railway и не пишет секреты в stdout.

    uv run python infra/railway/setup.py --out .dev/railway --bot-username TilHeroBot --app-name app

Что делает:
1. Генерирует секреты: Ed25519-ключ внутреннего JWT на каждый сервис (+ общий список открытых ключей),
   SCHEDULER_TOKEN (n8n), SESSION_JWT_SECRET (BFF), INVITE_TOKEN_KEY (social), TELEGRAM_WEBHOOK_SECRET (бот),
   USER_REF_SECRET (lessons: псевдоним ученика в «Контроле диалогов»), MEMBER_ID_KEY (спринт 7: общий ключ social,
   gamification и lessons — member_id ученика в социальном API), PAYMENTS_EDGE_TOKEN (спринт 8: один у billing и
   payments-edge), WEB_SESSION_SECRET (спринт 8: cookie-сессия сайта оплаты, telegram-bff), пароли ролей БД <svc> и
   <svc>_owner.
2. Пишет в --out (каталог .dev/ в .gitignore — файлы НЕ коммитить):
   - <service>.env — переменные сервиса для вставки в Railway (Variables → Raw Editor);
   - db-passwords.sql — пароли ролей; выполнить ПОСЛЕ infra/db/bootstrap.sql под владельцем БД;
   - services.md — таблица: Dockerfile, публичный домен, Pre-Deploy Command, healthcheck.
Ссылки ${{…}} Railway подставляет сам: адреса приватной сети, Redis, публичные домены.
BOT_TOKEN скрипт не знает: сервисы ссылаются на общую переменную ${{shared.BOT_TOKEN}}, её вводят вручную
(Railway → Project Settings → Shared Variables). Ссылка на BOT_TOKEN — только у telegram-bot-gateway (Bot API) и
telegram-bff (проверка initData): BOT_TOKEN_SERVICES, тест это проверяет. Спринт 8: ключи провайдеров (PAYME_KEY,
PAYME_SUBSCRIBE_KEY, CLICK_SECRET_KEY, UZUM_PASSWORD) — ссылки ${{shared.<ИМЯ>}} только у billing, секрет клиента
«Log In with Telegram» (TELEGRAM_LOGIN_CLIENT_SECRET) — только у telegram-bff; значения вводит владелец.
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
            calls=("notifications", "audit")),
    Service("learning-plan", 8102, "services/learning-plan/Dockerfile", "learning_plan", calls=("catalog",)),
    Service("support", 8103, "services/support/Dockerfile", "support"),
    Service("notifications", 8104, "services/notifications/Dockerfile", "notifications",
            calls=("identity-consent", "telegram-bot-gateway")),
    Service("audit", 8105, "services/audit/Dockerfile", "audit"),
    Service("experience-config", 8106, "services/experience-config/Dockerfile", "experience_config"),
    # спринт 8: + billing (платёжные обновления Telegram: pre_checkout_query, successful_payment, refunded_payment,
    # subscription → /internal/v1/stars/*); Bot API для Stars вызывает только bot-gateway (токен бота — только у него)
    Service("telegram-bot-gateway", 8107, "apps/telegram-bot-gateway/Dockerfile", public=True,
            calls=("identity-consent", "billing")),
    Service("social", 8109, "services/social/Dockerfile", "social", calls=("identity-consent",)),
    # спринт 8: + billing (Mini App /v1/billing/* — канал miniapp; сайт оплаты /web/v1/* — канал web)
    Service("telegram-bff", 8001, "services/telegram-bff/Dockerfile", public=True,
            calls=("identity-consent", "learning-plan", "support", "notifications", "experience-config", "social",
                   "catalog", "diagnostics", "lessons", "assessment", "tts", "memory", "gamification", "billing")),
    Service("telegram-miniapp", 8080, "apps/telegram-miniapp/Dockerfile", public=True, health="/healthz"),
    # спринт 3 — учебный контур: контент и диагностика
    Service("catalog", 8110, "services/catalog/Dockerfile", "catalog"),
    Service("diagnostics", 8111, "services/diagnostics/Dockerfile", "diagnostics", calls=("catalog",)),
    # спринт 4 — урок 20 минут, независимая оценка, ИИ (ai-gateway — единственный, у кого ключ провайдера)
    # спринт 7: + social (связь учеников, member_id → user_id), identity-consent (согласие на голос в парной комнате)
    # спринт 8: + billing (удержание минут при старте урока с ИИ и урока вдвоём, доступ по подписке)
    Service("lessons", 8112, "services/lessons/Dockerfile", "lessons",
            calls=("catalog", "ai-gateway", "assessment", "learning-plan", "diagnostics", "social", "identity-consent",
                   "billing")),
    Service("assessment", 8113, "services/assessment/Dockerfile", "assessment", calls=("catalog", "ai-gateway")),
    # релиз 5.1: оценка произношения — распознавание в tts (faster-whisper), ai-gateway сравнивает с эталоном
    Service("ai-gateway", 8114, "services/ai-gateway/Dockerfile", "ai_gateway", calls=("tts",)),
    # релиз 4.1 — серверная озвучка (Piper → MP3): синтез устройства в Telegram на Android отсутствует, на iOS тихий
    Service("tts", 8115, "services/tts/Dockerfile"),
    # спринт 5 — память и повторения (FSRS), перевод по тапу, проверки удержания, произношение (через ai-gateway)
    Service("memory", 8116, "services/memory/Dockerfile", "memory",
            calls=("catalog", "assessment", "ai-gateway", "identity-consent")),
    # спринт 6 — игра и герои: реестр XP, тилов и заморозок, герои, задания, магазин (начисления — только событиями);
    # спринт 7 — лиги и дуэли: social (связь учеников, member_id → user_id), lessons (набор заданий дуэли)
    Service("gamification", 8117, "services/gamification/Dockerfile", "gamification",
            calls=("social", "lessons", "diagnostics", "identity-consent")),
    # спринт 8 — деньги: каталог, заказы, платёжный контур (Stars через bot-gateway, Payme/Click/Uzum через
    # payments-edge), периоды и реестр минут, возвраты, сверка. Публичного домена нет: колбэки — через payments-edge
    Service("billing", 8118, "services/billing/Dockerfile", "billing",
            calls=("identity-consent", "gamification", "telegram-bot-gateway")),
    # payments-edge — публичный Caddy только для колбэков Payme, Click, Uzum (/pay/*) → billing по приватной сети;
    # web-pay — сайт оплаты вне Telegram (статика за Caddy, /api/* → telegram-bff /web/v1/* по приватной сети)
    Service("payments-edge", 8080, "apps/payments-edge/Dockerfile", public=True, health="/healthz"),
    Service("web-pay", 8080, "apps/web-pay/Dockerfile", public=True, health="/healthz"),
    # спринт 2 — админка: admin-bff без публичного домена, admin-web проксирует /admin/v1/* на него (один origin)
    Service("admin-identity", 8120, "services/admin-identity/Dockerfile", "admin_identity"),
    Service("user-admin", 8121, "services/user-admin/Dockerfile", "user_admin",
            calls=("identity-consent", "learning-plan")),
    # спринт 7: + social (друзья, модерация, реферальные кампании)
    # спринт 8: + billing («Деньги», вкладка «Тариф», финансовый обзор)
    Service("admin-bff", 8002, "services/admin-bff/Dockerfile", health="/health/ready",
            calls=("admin-identity", "user-admin", "identity-consent", "support", "audit", "experience-config",
                   "notifications", "catalog", "diagnostics", "ai-gateway", "lessons", "assessment", "memory",
                   "gamification", "social", "billing")),
    Service("admin-web", 8080, "apps/admin-web/Dockerfile", public=True, health="/healthz"),
    Service("n8n", 5678, "infra/n8n/Dockerfile", health="/healthz",
            calls=("learning-plan", "notifications", "social", "user-admin", "catalog", "lessons", "assessment",
                   "memory", "gamification", "billing")),
)
JWT_ISSUERS = ("identity-consent", "learning-plan", "support", "notifications", "audit", "experience-config",
               "telegram-bot-gateway", "social", "telegram-bff", "admin-bff", "admin-identity", "user-admin",
               "catalog", "diagnostics", "lessons", "assessment", "ai-gateway", "memory", "gamification", "billing")
# только проверяют внутренний JWT (сами никого не вызывают): закрытый ключ нужен ServiceSettings в stage/prod, но их
# открытый ключ никому не раздаётся
VERIFY_ONLY = ("tts",)
SCHEDULED = ("learning-plan", "notifications", "social", "user-admin", "catalog", "lessons", "assessment", "memory",
             "gamification", "billing")
# имя переменной адреса в коде вызывающего (BFF и Python-сервисы называют identity по-разному)
URL_VAR = {
    ("telegram-bff", "identity-consent"): "IDENTITY_URL",
    ("telegram-bff", "experience-config"): "EXPERIENCE_URL",
    ("admin-bff", "identity-consent"): "IDENTITY_URL",
    ("admin-bff", "experience-config"): "EXPERIENCE_URL",
    ("notifications", "telegram-bot-gateway"): "BOT_GATEWAY_URL",
    ("billing", "telegram-bot-gateway"): "BOTGW_URL",  # спринт 8: внутренний порт 8108, /internal/v1/stars/*
}
BOT_INTERNAL_PORT = 8108
# спринт 7: member_id = "mb_" + base64url(HMAC-SHA256(MEMBER_ID_KEY, str(user_id))[:16]) — одинаков в этих сервисах
# (INTERNAL_API спринта 7 §0). Ключ не меняется: смена меняет все member_id (ссылки клиентов, проекции)
MEMBER_ID_SERVICES = ("social", "gamification", "lessons")
# BOT_TOKEN (${{shared.BOT_TOKEN}}) — только у этих сервисов (INTERNAL_API спринта 8 §0.8): bot-gateway вызывает
# Bot API (в том числе Stars для billing), telegram-bff проверяет initData. Новых держателей токена нет
BOT_TOKEN_SERVICES = ("telegram-bot-gateway", "telegram-bff")
# спринт 8: секреты провайдеров — ссылки на общие переменные проекта (вводит владелец), только у billing
BILLING_SHARED_SECRETS = ("PAYME_KEY", "PAYME_SUBSCRIBE_KEY", "CLICK_SECRET_KEY", "UZUM_PASSWORD")
# флаги запуска (§0.7): в stage/prod всё выключено до ответов владельца и мерчантов
BILLING_FLAGS = ("PAYMENTS_ENABLED", "STARS_ENABLED", "PAYME_ENABLED", "CLICK_ENABLED", "UZUM_ENABLED",
                 "TRIAL_ON_ENFORCEMENT")
# переменные, которые новый сервис добавляет уже работающим (extend.py кладёт их в updates.json вместе с адресами):
# {новый сервис: {действующий сервис: (переменные)}}
COMPANION_VARS: dict[str, dict[str, tuple[str, ...]]] = {
    "billing": {"telegram-bot-gateway": ("TELEGRAM_TEST_ENV",),
                "lessons": ("BILLING_ENFORCED", "BILLING_TIMEOUT_SECONDS")},
    "web-pay": {"telegram-bff": ("WEB_PAY_ENABLED", "WEB_PAY_ORIGIN", "TELEGRAM_LOGIN_CLIENT_ID",
                                 "TELEGRAM_LOGIN_CLIENT_SECRET", "TELEGRAM_OIDC_BASE", "WEB_SESSION_SECRET")},
}
_USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{3,31}$")
_APP_RE = re.compile(r"^[A-Za-z0-9_]{3,30}$")
_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,}$")


def by_name(name: str) -> Service:
    return next(s for s in SERVICES if s.name == name)


def private_url(name: str) -> str:
    port = BOT_INTERNAL_PORT if name == "telegram-bot-gateway" else by_name(name).port
    return f"http://${{{{{name}.RAILWAY_PRIVATE_DOMAIN}}}}:{port}"


def url_var(caller: str, callee: str) -> str:
    return URL_VAR.get((caller, callee), callee.upper().replace("-", "_") + "_URL")


def token(nbytes: int = 32) -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(nbytes)).decode().rstrip("=")


def admin_password() -> str:
    """Временный пароль первого администратора: ≥ 12 символов, буквы и цифры (правила admin-identity)."""
    while True:
        pw = secrets.token_urlsafe(18)
        if any(c.isalpha() for c in pw) and any(c.isdigit() for c in pw):
            return pw


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
    n8n_key: str  # N8N_ENCRYPTION_KEY: n8n записывает его в том при первом запуске и с другим не стартует
    mfa_key: str  # ADMIN_MFA_ENC_KEY (admin-identity): шифрует секреты TOTP сотрудников, base64 32 байта
    admin_password: str  # ADMIN_BOOTSTRAP_PASSWORD: временный пароль первого super_admin (смена при первом входе)
    internal_hmac: str  # INTERNAL_JWT_SECRET — обязателен Python-сервисам в stage/prod (>= 32), отличен от session_jwt
    # USER_REF_SECRET (lessons): user_ref = HMAC-SHA256(user_id, секрет)[:8] — без секрета псевдоним не обратить
    user_ref: str
    # MEMBER_ID_KEY (спринт 7): общий для MEMBER_ID_SERVICES, ≥ 32 символов, отличен от остальных секретов
    member_key: str
    # PAYMENTS_EDGE_TOKEN (спринт 8): X-Edge-Token payments-edge → billing (один у обоих), ≥ 32 символов
    payments_edge: str
    # WEB_SESSION_SECRET (спринт 8): подпись cookie-сессии сайта оплаты (telegram-bff), отличен от SESSION_JWT_SECRET
    web_session: str

    @classmethod
    def new(cls) -> Secrets:
        roles = [r for s in SERVICES if s.schema for r in (s.schema, f"{s.schema}_owner")]
        return cls(seeds={n: os.urandom(32) for n in (*JWT_ISSUERS, *VERIFY_ONLY)},
                   passwords={r: secrets.token_hex(24) for r in roles},
                   scheduler=token(), session_jwt=token(48), invite_key=token(), webhook=secrets.token_hex(32),
                   n8n_key=token(), internal_hmac=token(48), user_ref=token(), member_key=token(),
                   payments_edge=token(), web_session=token(48),
                   mfa_key=base64.b64encode(secrets.token_bytes(32)).decode(), admin_password=admin_password())

    def public_keys(self) -> str:
        return json.dumps({n: b64e(public_raw(private_from_seed(s))) for n, s in self.seeds.items()
                           if n in JWT_ISSUERS}, separators=(",", ":"))


def service_env(svc: Service, sec: Secrets, *, env: str, app_link: str, bot_username: str = "",
                admin_email: str = "") -> list[str]:
    dockerfile = f"RAILWAY_DOCKERFILE_PATH={svc.dockerfile}"
    lines: list[str] = [dockerfile, f"ENV={env}", f"PORT={svc.port}"]
    if svc.name == "telegram-miniapp":  # VITE_* — build args (Railway передаёт переменные сервиса в сборку)
        return [dockerfile, f"PORT={svc.port}", "VITE_BFF_URL=https://${{telegram-bff.RAILWAY_PUBLIC_DOMAIN}}",
                f"VITE_BOT_USERNAME={bot_username}", "BFF_ORIGIN=https://${{telegram-bff.RAILWAY_PUBLIC_DOMAIN}}"]
    if svc.name == "n8n":  # как в aievent: sqlite в томе /home/node/.n8n, том Railway монтируется от root
        return [dockerfile, "PORT=5678", "N8N_PORT=5678", f"SCHEDULER_TOKEN={sec.scheduler}",
                *(f"{url_var('n8n', c)}={private_url(c)}" for c in svc.calls),
                f"N8N_ENCRYPTION_KEY={sec.n8n_key}", "N8N_PROXY_HOPS=1", "GENERIC_TIMEZONE=UTC", "TZ=UTC",
                "DB_TYPE=sqlite", "N8N_RUNNERS_ENABLED=true", "N8N_BLOCK_ENV_ACCESS_IN_NODE=false",
                "N8N_DIAGNOSTICS_ENABLED=false", "N8N_PERSONALIZATION_ENABLED=false",
                "N8N_VERSION_NOTIFICATIONS_ENABLED=false", "RAILWAY_RUN_UID=0", "N8N_USER_FOLDER=/home/node"]
    if svc.name == "admin-web":  # Caddy: статика + /admin/v1/* → admin-bff по приватной сети
        return [dockerfile, f"PORT={svc.port}", f"ADMIN_BFF_URL={private_url('admin-bff')}"]
    if svc.name == "web-pay":  # спринт 8: Caddy — статика сайта оплаты + /api/* → telegram-bff /web/v1/* (приватно)
        return [dockerfile, f"PORT={svc.port}", f"BFF_URL={private_url('telegram-bff')}"]
    if svc.name == "payments-edge":  # спринт 8: Caddy — только /pay/* колбэков провайдеров → billing /provider/v1/*
        return [dockerfile, f"PORT={svc.port}", f"BILLING_URL={private_url('billing')}",
                f"PAYMENTS_EDGE_TOKEN={sec.payments_edge}"]
    if svc.name == "telegram-bff":
        lines = [dockerfile, "NODE_ENV=production", f"PORT={svc.port}", "HOST=::", "TRUST_PROXY_HOPS=1"]
    if svc.name == "admin-bff":  # Railway edge + Caddy admin-web
        lines = [dockerfile, "NODE_ENV=production", f"ENV={env}", f"PORT={svc.port}", "HOST=::",
                 "TRUST_PROXY_HOPS=2"]
    if svc.schema:
        lines += [f"DATABASE_URL={pg_url(svc.schema, sec.passwords[svc.schema])}",
                  f"MIGRATION_DATABASE_URL={pg_url(svc.schema + '_owner', sec.passwords[svc.schema + '_owner'])}"]
    lines += [REDIS]
    if svc.name not in ("telegram-bff", "admin-bff", "tts"):  # tts без шины: только Redis-кеш озвучки
        lines += [NATS]
    if svc.name in JWT_ISSUERS or svc.name in VERIFY_ONLY:
        lines += [f"INTERNAL_JWT_PRIVATE_KEY={b64e(sec.seeds[svc.name])}",
                  f"INTERNAL_JWT_PUBLIC_KEYS={sec.public_keys()}"]
    if svc.name not in ("telegram-bff", "admin-bff"):  # Python: ServiceSettings в stage/prod; BFF его не использует
        lines.append(f"INTERNAL_JWT_SECRET={sec.internal_hmac}")
    lines += [f"{url_var(svc.name, c)}={private_url(c)}" for c in svc.calls]
    if svc.name in SCHEDULED:
        lines.append(f"SCHEDULER_TOKEN={sec.scheduler}")
    if svc.name == "social":
        lines += [f"INVITE_TOKEN_KEY={sec.invite_key}", f"TELEGRAM_APP_LINK={app_link}"]
    if svc.name == "lessons":  # обязателен в stage/prod; смена секрета меняет все user_ref (старые ссылки QA)
        lines.append(f"USER_REF_SECRET={sec.user_ref}")
    if svc.name in MEMBER_ID_SERVICES:  # спринт 7: один ключ на все три сервиса (member_id совпадает)
        lines.append(f"MEMBER_ID_KEY={sec.member_key}")
    if svc.name == "telegram-bff":
        lines += [f"SESSION_JWT_SECRET={sec.session_jwt}", f"TELEGRAM_APP_LINK={app_link}",
                  "MINIAPP_ORIGIN=https://${{telegram-miniapp.RAILWAY_PUBLIC_DOMAIN}}",
                  "BOT_TOKEN=${{shared.BOT_TOKEN}}",
                  # спринт 8 — сайт оплаты (/web/v1/*, выключен до решения владельца): вход «Log In with Telegram»
                  # (OIDC); Client ID = ID бота и секрет клиента из BotFather вводит владелец (секрет — общая
                  # переменная проекта, ссылка только здесь). Токен бота сайту не нужен
                  "WEB_PAY_ENABLED=false", "WEB_PAY_ORIGIN=https://${{web-pay.RAILWAY_PUBLIC_DOMAIN}}",
                  "TELEGRAM_LOGIN_CLIENT_ID=", "TELEGRAM_LOGIN_CLIENT_SECRET=${{shared.TELEGRAM_LOGIN_CLIENT_SECRET}}",
                  "TELEGRAM_OIDC_BASE=https://oauth.telegram.org", f"WEB_SESSION_SECRET={sec.web_session}"]
    if svc.name == "admin-bff":
        lines.append("ADMIN_ORIGIN=https://${{admin-web.RAILWAY_PUBLIC_DOMAIN}}")
    if svc.name == "admin-identity":
        lines += [f"ADMIN_MFA_ENC_KEY={sec.mfa_key}"]
        if admin_email:  # первый super_admin; после первого входа переменные удалить
            lines += [f"ADMIN_BOOTSTRAP_EMAIL={admin_email}", f"ADMIN_BOOTSTRAP_PASSWORD={sec.admin_password}"]
    if svc.name == "ai-gateway":  # ключ провайдера — общая переменная проекта (вводит владелец, как BOT_TOKEN);
        # не задана — ссылка пустая, ИИ выключен (урок без ИИ). Ссылка только у ai-gateway.
        lines += ["AI_PROVIDER=anthropic", "ANTHROPIC_API_KEY=${{shared.ANTHROPIC_API_KEY}}",
                  # релиз 5.1: оценка произношения на своём сервере (tts распознаёт, ai-gateway сравнивает с эталоном);
                  # Azure — запасной провайдер (SPEECH_PROVIDER=azure + общие переменные AZURE_SPEECH_KEY/REGION)
                  "SPEECH_PROVIDER=whisper"]
    if svc.name == "lessons":  # спринт 8: пэйвол уроков с ИИ и уроков вдвоём выключен до решения владельца
        lines += ["BILLING_ENFORCED=false", "BILLING_TIMEOUT_SECONDS=2"]
    if svc.name == "billing":
        lines += [f"PAYMENTS_EDGE_TOKEN={sec.payments_edge}", "WEB_PAY_ORIGIN=https://${{web-pay.RAILWAY_PUBLIC_DOMAIN}}",
                  "TIMEZONE=Asia/Tashkent", *(f"{flag}=false" for flag in BILLING_FLAGS),
                  # реквизиты мерчантов — не секреты, вводит владелец после договоров (пусто — провайдер выключен)
                  "PAYME_MERCHANT_ID=", "PAYME_LOGIN=Paycom", "PAYME_CHECKOUT_URL=https://checkout.paycom.uz",
                  "PAYME_ALLOWED_CIDRS=", "PAYME_SUBSCRIBE_URL=",
                  "CLICK_SERVICE_ID=", "CLICK_MERCHANT_ID=", "CLICK_MERCHANT_USER_ID=",
                  "CLICK_PAY_URL=https://my.click.uz/services/pay", "CLICK_API_URL=https://api.click.uz/v2/merchant",
                  "CLICK_ALLOWED_CIDRS=",
                  "UZUM_SERVICE_ID=", "UZUM_LOGIN=", "UZUM_ACCOUNT_FIELD=order_id", "UZUM_CHECKOUT_URL_TEMPLATE=",
                  "UZUM_ALLOWED_CIDRS=",
                  # ключи — только ссылки на общие переменные проекта (значения вводит владелец, не в репозиторий)
                  *(f"{name}=${{{{shared.{name}}}}}" for name in BILLING_SHARED_SECRETS)]
    if svc.name == "notifications":
        lines.append("ADMIN_TEST_CHAT_IDS=")  # Telegram chat id тестовых чатов через запятую (тестовая отправка)
    if svc.name == "telegram-bot-gateway":
        lines += [f"INTERNAL_PORT={BOT_INTERNAL_PORT}", "HOST=::", f"TELEGRAM_WEBHOOK_SECRET={sec.webhook}",
                  "TELEGRAM_WEBHOOK_URL=https://${{telegram-bot-gateway.RAILWAY_PUBLIC_DOMAIN}}/telegram/webhook",
                  "MINIAPP_URL=https://${{telegram-miniapp.RAILWAY_PUBLIC_DOMAIN}}",
                  f"TELEGRAM_APP_LINK={app_link}", "BOT_AUTO_SETUP=true",
                  "BOT_TOKEN=${{shared.BOT_TOKEN}}",
                  # спринт 8: Stars — боевой Bot API; true — тестовая среда Telegram (stage с тестовым ботом, §1.5)
                  "TELEGRAM_TEST_ENV=false"]
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
             "сервисы (Pre-Deploy применит миграции) → identity-consent раньше social (social требует поля согласия).\n"
             "Спринт 8: публичные домены payments-edge (URL колбэков в кабинетах Payme, Click, Uzum) и web-pay (сайт "
             "оплаты, Allowed URLs и redirect URI в BotFather); у billing публичного домена нет.\n")
    return "\n".join(rows) + "\n" + infra


def db_passwords_sql(sec: Secrets) -> str:
    return "".join(f"ALTER ROLE {role} PASSWORD '{pw}';\n" for role, pw in sorted(sec.passwords.items()))


def build(sec: Secrets, *, env: str, bot_username: str, app_name: str, admin_email: str = "") -> dict[str, str]:
    if not _USERNAME_RE.match(bot_username) or not _APP_RE.match(app_name):
        raise ValueError("bot username / app short name: латиница, цифры, _")
    if admin_email and not _EMAIL_RE.match(admin_email):
        raise ValueError("admin email: некорректный адрес")
    app_link = f"https://t.me/{bot_username}/{app_name}"
    files = {f"{s.name}.env": "\n".join(service_env(s, sec, env=env, app_link=app_link, bot_username=bot_username,
                                                    admin_email=admin_email))
             + "\n" for s in SERVICES}
    files["db-passwords.sql"] = db_passwords_sql(sec)
    files["services.md"] = services_table()
    return files


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--env", choices=("stage", "prod"), default="prod")
    ap.add_argument("--bot-username", required=True)
    ap.add_argument("--app-name", required=True, help="short name Mini App в @BotFather (t.me/<bot>/<app>)")
    ap.add_argument("--admin-email", default="", help="email первого super_admin админки (bootstrap admin-identity)")
    a = ap.parse_args(argv)
    out: Path = a.out
    if out.exists() and any(out.iterdir()):
        print(f"{out} не пуст — новые секреты не перезаписывают старые, выберите пустой каталог", file=sys.stderr)
        return 2
    files = build(Secrets.new(), env=a.env, bot_username=a.bot_username, app_name=a.app_name,
                  admin_email=a.admin_email)
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

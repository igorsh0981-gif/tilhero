"""infra/railway/setup.py: каждый сервис получает нужные переменные, секреты не повторяются и не печатаются."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import setup as rs  # infra/railway в sys.path через conftest

ROOT = Path(__file__).resolve().parents[2]


def build() -> tuple[rs.Secrets, dict[str, str]]:
    sec = rs.Secrets.new()
    return sec, rs.build(sec, env="prod", bot_username="TilHeroBot", app_name="app")


def env_of(files: dict[str, str], name: str) -> dict[str, str]:
    out = {}
    for line in files[f"{name}.env"].splitlines():
        if line and not line.startswith("#"):
            k, _, v = line.partition("=")
            out[k] = v
    return out


def test_every_dockerfile_is_a_railway_service():
    dockerfiles = {str(p.relative_to(ROOT)) for p in ROOT.glob("*/*/Dockerfile")} | {"infra/n8n/Dockerfile"}
    assert {s.dockerfile for s in rs.SERVICES} == dockerfiles
    for s in rs.SERVICES:
        assert (ROOT / s.dockerfile).exists(), s.name


def test_python_services_get_db_bus_keys_and_urls():
    _, files = build()
    pub = json.loads(env_of(files, "audit")["INTERNAL_JWT_PUBLIC_KEYS"])
    assert set(pub) == set(rs.JWT_ISSUERS)
    for s in rs.SERVICES:
        if not s.schema:
            continue
        e = env_of(files, s.name)
        assert e["ENV"] == "prod" and e["PORT"] == str(s.port)
        assert e["DATABASE_URL"].startswith(f"postgresql://{s.schema}:")
        assert e["MIGRATION_DATABASE_URL"].startswith(f"postgresql://{s.schema}_owner:")
        assert e["NATS_URL"].startswith("nats://") and e["REDIS_URL"] == "${{Redis.REDIS_URL}}"
        assert e["INTERNAL_JWT_PRIVATE_KEY"] and json.loads(e["INTERNAL_JWT_PUBLIC_KEYS"]) == pub
        for callee in s.calls:
            assert e[rs.url_var(s.name, callee)].startswith("http://${{" + callee + ".RAILWAY_PRIVATE_DOMAIN}}")
    assert env_of(files, "notifications")["BOT_GATEWAY_URL"].endswith(":8108")  # внутренний порт бота


def test_scheduler_and_service_specific_secrets():
    sec, files = build()
    for name in (*rs.SCHEDULED, "n8n"):
        assert env_of(files, name)["SCHEDULER_TOKEN"] == sec.scheduler
    assert len(sec.scheduler) >= 32  # P-8: не короче 32 символов
    social = env_of(files, "social")
    assert len(social["INVITE_TOKEN_KEY"]) >= 32 and social["TELEGRAM_APP_LINK"] == "https://t.me/TilHeroBot/app"
    bff = env_of(files, "telegram-bff")
    assert bff["TELEGRAM_APP_LINK"] == social["TELEGRAM_APP_LINK"] and len(bff["SESSION_JWT_SECRET"]) >= 32
    assert bff["IDENTITY_URL"].endswith(":8101") and bff["EXPERIENCE_URL"].endswith(":8106")
    gw = env_of(files, "telegram-bot-gateway")
    assert gw["MINIAPP_URL"].startswith("https://") and "localhost" not in gw["MINIAPP_URL"]
    n8n = env_of(files, "n8n")
    assert {k for k in n8n if k.endswith("_URL")} == {"LEARNING_PLAN_URL", "NOTIFICATIONS_URL", "SOCIAL_URL",
                                                       "USER_ADMIN_URL", "CATALOG_URL"}
    assert n8n["RAILWAY_RUN_UID"] == "0" and len(n8n["N8N_ENCRYPTION_KEY"]) >= 32


def test_db_passwords_cover_every_role_and_secrets_are_unique():
    sec, files = build()
    roles = re.findall(r"ALTER ROLE (\w+) PASSWORD", files["db-passwords.sql"])
    bootstrap = (ROOT / "infra/db/bootstrap.sql").read_text()
    schemas = {s.schema for s in rs.SERVICES if s.schema}
    assert set(roles) == schemas | {f"{x}_owner" for x in schemas}
    assert all(f"'{x}'" in bootstrap for x in schemas)
    values = [*sec.passwords.values(), sec.scheduler, sec.session_jwt, sec.invite_key, sec.webhook, sec.internal_hmac,
              sec.n8n_key, sec.mfa_key, sec.admin_password]
    assert len(values) == len(set(values))


def test_main_writes_files_privately_and_refuses_non_empty_dir(tmp_path, capsys):
    out = tmp_path / "rw"
    assert rs.main(["--out", str(out), "--bot-username", "TilHeroBot", "--app-name", "app"]) == 0
    assert (out / "services.md").exists() and oct(out.stat().st_mode)[-3:] == "700"
    assert all(oct(p.stat().st_mode)[-3:] == "600" for p in out.iterdir())
    printed = capsys.readouterr().out
    assert "PRIVATE_KEY" not in printed and "PASSWORD" not in printed
    assert rs.main(["--out", str(out), "--bot-username", "TilHeroBot", "--app-name", "app"]) == 2


@pytest.mark.parametrize("bad", ["@bot", "a", "bot name", "бот"])
def test_rejects_bad_bot_username(bad):
    with pytest.raises(ValueError):
        rs.build(rs.Secrets.new(), env="prod", bot_username=bad, app_name="app")


def test_dockerfile_path_bot_token_reference_and_miniapp_build_args():
    sec, files = build()
    for s in rs.SERVICES:
        e = env_of(files, s.name)
        assert e["RAILWAY_DOCKERFILE_PATH"] == s.dockerfile
        if s.schema or s.name == "telegram-bot-gateway":
            assert len(e["INTERNAL_JWT_SECRET"]) >= 32 and e["INTERNAL_JWT_SECRET"] == sec.internal_hmac
    for name in ("telegram-bff", "telegram-bot-gateway"):
        assert env_of(files, name)["BOT_TOKEN"] == "${{shared.BOT_TOKEN}}"  # noqa: S105 — ссылка Railway, не секрет
    app = env_of(files, "telegram-miniapp")
    assert app["VITE_BFF_URL"] == "https://${{telegram-bff.RAILWAY_PUBLIC_DOMAIN}}"
    assert app["VITE_BOT_USERNAME"] == "TilHeroBot"
    assert sec.internal_hmac != sec.session_jwt


def test_admin_services_sprint2():
    """Спринт 2: admin-bff без публичного домена за Caddy admin-web, admin-identity с ключом MFA и bootstrap."""
    sec = rs.Secrets.new()
    files = rs.build(sec, env="prod", bot_username="TilHeroBot", app_name="app", admin_email="owner@example.uz")
    bff = env_of(files, "admin-bff")
    assert bff["ADMIN_ORIGIN"] == "https://${{admin-web.RAILWAY_PUBLIC_DOMAIN}}" and bff["TRUST_PROXY_HOPS"] == "2"
    assert bff["NODE_ENV"] == "production" and bff["ENV"] == "prod" and "NATS_URL" not in bff
    assert "INTERNAL_JWT_SECRET" not in bff and bff["INTERNAL_JWT_PRIVATE_KEY"]
    assert {k for k in bff if k.endswith("_URL") and k != "REDIS_URL"} == {
        "ADMIN_IDENTITY_URL", "USER_ADMIN_URL", "IDENTITY_URL", "SUPPORT_URL", "AUDIT_URL", "EXPERIENCE_URL",
        "NOTIFICATIONS_URL", "CATALOG_URL", "DIAGNOSTICS_URL"}
    assert not rs.by_name("admin-bff").public and rs.by_name("admin-web").public
    web = env_of(files, "admin-web")
    assert web["ADMIN_BFF_URL"] == "http://${{admin-bff.RAILWAY_PRIVATE_DOMAIN}}:8002"
    aid = env_of(files, "admin-identity")
    assert len(__import__("base64").b64decode(aid["ADMIN_MFA_ENC_KEY"])) == 32
    assert aid["ADMIN_BOOTSTRAP_EMAIL"] == "owner@example.uz"
    pw = aid["ADMIN_BOOTSTRAP_PASSWORD"]
    assert len(pw) >= 12 and any(c.isdigit() for c in pw) and any(c.isalpha() for c in pw)
    ua = env_of(files, "user-admin")
    assert ua["IDENTITY_CONSENT_URL"].endswith(":8101") and ua["LEARNING_PLAN_URL"].endswith(":8102")
    assert ua["SCHEDULER_TOKEN"] == sec.scheduler
    assert env_of(files, "identity-consent")["AUDIT_URL"].endswith(":8105")
    assert "ADMIN_TEST_CHAT_IDS" in env_of(files, "notifications")
    # без --admin-email bootstrap не задаётся
    plain = rs.build(sec, env="prod", bot_username="TilHeroBot", app_name="app")
    assert "ADMIN_BOOTSTRAP_EMAIL" not in env_of(plain, "admin-identity")
    with pytest.raises(ValueError):
        rs.build(sec, env="prod", bot_username="TilHeroBot", app_name="app", admin_email="not-an-email")


def test_content_services_sprint3():
    """Спринт 3: catalog и diagnostics — приватные, со своими схемами; адреса у вызывающих."""
    sec = rs.Secrets.new()
    files = rs.build(sec, env="prod", bot_username="TilHeroBot", app_name="app")
    for name, port, schema in (("catalog", 8110, "catalog"), ("diagnostics", 8111, "diagnostics")):
        svc = rs.by_name(name)
        assert not svc.public and svc.port == port and svc.schema == schema
        env = env_of(files, name)
        assert env["DATABASE_URL"].startswith(f"postgresql://{schema}:") and env["INTERNAL_JWT_PRIVATE_KEY"]
    assert env_of(files, "catalog")["SCHEDULER_TOKEN"] == sec.scheduler
    assert env_of(files, "diagnostics")["CATALOG_URL"].endswith(":8110")
    assert env_of(files, "learning-plan")["CATALOG_URL"].endswith(":8110")
    bff = env_of(files, "telegram-bff")
    assert bff["CATALOG_URL"].endswith(":8110") and bff["DIAGNOSTICS_URL"].endswith(":8111")

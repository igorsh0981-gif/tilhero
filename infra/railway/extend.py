"""Дозаполнение prod новыми сервисами поверх действующих секретов (DEPLOYMENT.md §5). Секретов в файле нет.

`setup.py` при каждом запуске генерирует ВСЕ секреты заново — для выкладки новых сервисов в работающий prod он не
годится (сменил бы ключи JWT, SCHEDULER_TOKEN, пароли ролей). Этот скрипт берёт общие секреты из env-файла
действующего сервиса и действующий набор открытых ключей, генерирует ключ JWT и пароли ролей только для новых сервисов:

    uv run python infra/railway/extend.py --env-from .dev/railway-prod/learning-plan.env \\
        --public-keys .dev/railway-prod-s3/public-keys.json --out .dev/railway-prod-s4 \\
        --only lessons,assessment,ai-gateway

Выход (каталог 0700, файлы 0600; каталог должен быть пуст — повторная генерация сменила бы пароли и ключи):
- `<svc>.env` — переменные новых сервисов (ключ провайдера ИИ — ссылка `${{shared.ANTHROPIC_API_KEY}}`, не значение);
- `db-passwords.sql` — пароли ролей новых схем; `bootstrap.sql` — infra/db/bootstrap.sql + эти пароли (для db-bootstrap);
- `public-keys.json` — новый INTERNAL_JWT_PUBLIC_KEYS (действующие ключи + новых сервисов);
- `updates.json` — что выставить существующим сервисам: адреса новых сервисов (по `calls`), новые открытые ключи,
  SCHEDULER_TOKEN новым запланированным сервисам.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import setup as rs  # noqa: E402


def env_of(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            k, _, v = line.partition("=")
            out[k] = v
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env-from", type=Path, required=True,
                    help="env-файл действующего сервиса с SCHEDULER_TOKEN и INTERNAL_JWT_SECRET (например, learning-plan)")
    ap.add_argument("--public-keys", type=Path, required=True, help="действующий INTERNAL_JWT_PUBLIC_KEYS (JSON)")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--only", required=True, help="новые сервисы через запятую")
    ap.add_argument("--app-link", default="https://t.me/TilHero_bot/TilHero")
    ap.add_argument("--bot-username", default="TilHero_bot")
    a = ap.parse_args(argv)

    new = tuple(x.strip() for x in a.only.split(",") if x.strip())
    for n in new:
        rs.by_name(n)  # неизвестный сервис — ошибка сразу
    if a.out.exists() and any(a.out.iterdir()):
        print(f"{a.out} уже заполнен — повторная генерация сменила бы пароли и ключи", file=sys.stderr)
        return 2
    a.out.mkdir(mode=0o700, parents=True, exist_ok=True)

    base = env_of(a.env_from)
    sec = rs.Secrets.new()
    sec.scheduler = base["SCHEDULER_TOKEN"]
    sec.internal_hmac = base["INTERNAL_JWT_SECRET"]
    pub = json.loads(a.public_keys.read_text())
    if set(new) & set(pub):
        print(f"ключи сервисов {sorted(set(new) & set(pub))} уже есть в действующем наборе", file=sys.stderr)
        return 2
    new_issuers = [n for n in new if n in rs.JWT_ISSUERS]  # VERIFY_ONLY (tts) ключ не раздают
    for n in new_issuers:
        pub[n] = rs.b64e(rs.public_raw(rs.private_from_seed(sec.seeds[n])))
    missing = set(rs.JWT_ISSUERS) ^ set(pub)
    if missing:
        print(f"набор открытых ключей не совпадает с JWT_ISSUERS: {sorted(missing)}", file=sys.stderr)
        return 2
    pub_json = json.dumps(pub, separators=(",", ":"))

    def write(name: str, text: str) -> None:
        p = a.out / name
        p.write_text(text)
        os.chmod(p, 0o600)

    for name in new:
        lines = [f"INTERNAL_JWT_PUBLIC_KEYS={pub_json}" if line.startswith("INTERNAL_JWT_PUBLIC_KEYS=") else line
                 for line in rs.service_env(rs.by_name(name), sec, env="prod", app_link=a.app_link,
                                            bot_username=a.bot_username)]
        assert not any(line.startswith("ANTHROPIC_API_KEY=") and "${{shared." not in line for line in lines)
        write(f"{name}.env", "\n".join(lines) + "\n")

    roles = [r for n in new if (schema := rs.by_name(n).schema) for r in (schema, f"{schema}_owner")]
    pw_sql = "".join(f"ALTER ROLE {r} PASSWORD '{sec.passwords[r]}';\n" for r in roles)
    write("db-passwords.sql", pw_sql)
    write("bootstrap.sql", (ROOT / "infra/db/bootstrap.sql").read_text()
          + f"\n-- пароли ролей новых сервисов: {', '.join(new)}\n" + pw_sql)
    write("public-keys.json", pub_json + "\n")

    updates: dict[str, dict[str, str]] = {}
    for svc in rs.SERVICES:
        if svc.name in new:
            continue
        upd = {rs.url_var(svc.name, c): rs.private_url(c) for c in svc.calls if c in new}
        if new_issuers and svc.name in rs.JWT_ISSUERS:
            upd["INTERNAL_JWT_PUBLIC_KEYS"] = pub_json
        if upd:
            updates[svc.name] = upd
    write("updates.json", json.dumps(updates, ensure_ascii=False, indent=1) + "\n")
    print("ok:", sorted(x.name for x in a.out.iterdir()))
    print({k: sorted(v) for k, v in updates.items()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

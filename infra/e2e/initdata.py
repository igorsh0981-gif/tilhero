"""Подписанный Telegram initData — Python-эквивалент services/telegram-bff/scripts/dev-init-data.ts.

Алгоритм Telegram (Mini Apps, «Validating data received via the Mini App»):
  secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
  hash       = hex(HMAC_SHA256(key=secret_key, msg=data_check_string)),
  data_check_string — пары `key=value` (без hash), отсортированные по ключу и соединённые '\n'.

    uv run python infra/e2e/initdata.py --user-id 900001 --name Игорь [--json]
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import secrets
import time
from urllib.parse import urlencode

DEV_BOT_TOKEN = "123456789:dev-bot-token-change-me-0000000000"  # noqa: S105 - = DEV_DEFAULTS.BOT_TOKEN telegram-bff


def sign_init_data(
    bot_token: str,
    user: dict | None,
    *,
    auth_date: int | None = None,
    query_id: str | None = None,
    start_param: str | None = None,
) -> str:
    fields: list[tuple[str, str]] = [("auth_date", str(auth_date if auth_date is not None else int(time.time())))]
    if query_id:
        fields.append(("query_id", query_id))
    if user is not None:
        # как JSON.stringify: без пробелов, кириллица как есть
        fields.append(("user", json.dumps(user, ensure_ascii=False, separators=(",", ":"))))
    if start_param:
        fields.append(("start_param", start_param))
    dcs = "\n".join(f"{k}={v}" for k, v in sorted(fields))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    digest = hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest()
    return urlencode([*fields, ("hash", digest)])


def make_init_data(
    telegram_user_id: int,
    first_name: str,
    *,
    bot_token: str = DEV_BOT_TOKEN,
    username: str | None = None,
    lang: str = "ru",
    start_param: str | None = None,
    age: int = 0,
) -> str:
    user: dict = {"id": telegram_user_id, "first_name": first_name}
    if username:
        user["username"] = username
    if lang:
        user["language_code"] = lang
    user["allows_write_to_pm"] = True
    # каждый запуск Mini App — свой initData (query_id): initData одноразовый (спринт 9, О-1)
    return sign_init_data(
        bot_token, user, auth_date=int(time.time()) - age, query_id=f"AAdev{telegram_user_id}{secrets.token_hex(4)}",
        start_param=start_param,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user-id", type=int, required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--username")
    ap.add_argument("--lang", default="ru")
    ap.add_argument("--start-param")
    ap.add_argument("--age", type=int, default=0)
    ap.add_argument("--bot-token", default=DEV_BOT_TOKEN)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    s = make_init_data(a.user_id, a.name, bot_token=a.bot_token, username=a.username, lang=a.lang,
                       start_param=a.start_param, age=a.age)
    print(json.dumps({"init_data": s}, ensure_ascii=False) if a.json else s)


if __name__ == "__main__":
    main()

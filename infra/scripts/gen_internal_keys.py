"""Генерирует Ed25519-ключи внутреннего JWT для всех сервисов (stage/prod).

Каждый сервис получает свой INTERNAL_JWT_PRIVATE_KEY (только он может подписываться своим именем)
и INTERNAL_JWT_PUBLIC_KEYS — открытые ключи ВСЕХ сервисов (проверка по издателю).
Запуск: uv run python infra/scripts/gen_internal_keys.py > .dev/internal-keys.env   (файл не коммитить!)
Затем перенесите значения в переменные Railway соответствующих сервисов.
"""

import json
import os

from tilhero_common.internal_auth import b64e, private_from_seed, public_raw

SERVICES = [
    "telegram-bff",
    "admin-bff",
    "admin-identity",
    "user-admin",
    "catalog",
    "diagnostics",
    "identity-consent",
    "learning-plan",
    "social",
    "support",
    "notifications",
    "audit",
    "experience-config",
    "telegram-bot-gateway",
]


def main() -> None:
    seeds = {name: os.urandom(32) for name in SERVICES}
    publics = {name: b64e(public_raw(private_from_seed(seed))) for name, seed in seeds.items()}
    shared_public = json.dumps(publics, separators=(",", ":"))
    print("# Общая для всех сервисов переменная (Railway: Shared Variable)")
    print(f"INTERNAL_JWT_PUBLIC_KEYS='{shared_public}'")
    print()
    for name, seed in seeds.items():
        print(f"# {name}: INTERNAL_JWT_PRIVATE_KEY (секрет только этого сервиса)")
        print(f"{name.upper().replace('-', '_')}__INTERNAL_JWT_PRIVATE_KEY={b64e(seed)}")


if __name__ == "__main__":
    main()

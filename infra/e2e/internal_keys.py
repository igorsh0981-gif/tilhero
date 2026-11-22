"""Ключи внутреннего JWT (Ed25519) локального e2e-стенда — как в stage/prod, без dev-деривации из секрета.

    uv run python infra/e2e/internal_keys.py --file .dev/e2e/internal-keys.json --env <issuer>

Файл `.dev/e2e/internal-keys.json` (в .gitignore вместе с .dev) — seed (base64url 32 байта) каждого издателя; создаётся
при первом запуске и переиспользуется. `--env <issuer>` печатает две строки для `env`:
  INTERNAL_JWT_PRIVATE_KEY=<seed издателя>
  INTERNAL_JWT_PUBLIC_KEYS=<JSON открытых ключей всех издателей>
(сервис подписывает только своим ключом и проверяет входящие по ключу конкретного издателя — подделать admin-bff
нельзя). Сценарий берёт отсюда же ключ admin-bff (staff API) и notifications/telegram-bff (проверки портов bot-gateway).
Набор издателей совпадает с infra/scripts/gen_internal_keys.py (шаг 17a сценария спринта 1).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path

from tilhero_common.internal_auth import KeyRing, b64e, private_from_seed, public_raw

ISSUERS = (
    "telegram-bff",
    "admin-bff",
    "admin-identity",  # спринт 2: аудит HTTP (POST audit /internal/v1/records), шина
    "user-admin",  # спринт 2: сверка с identity-consent и learning-plan (GET /admin/v1/users|plans)
    "identity-consent",
    "learning-plan",
    "social",
    "support",
    "notifications",
    "audit",
    "experience-config",
    "telegram-bot-gateway",
    "catalog",  # спринт 3: контент, языки, медиа (аудит и события — шина; сам никого не вызывает)
    "diagnostics",  # спринт 3: диагностика и карта навыков (вызывает catalog: пары, снимок курса)
    "lessons",  # спринт 4: сессии урока (вызывает catalog, ai-gateway, assessment, learning-plan, diagnostics)
    "assessment",  # спринт 4: независимая оценка (вызывает catalog, ai-gateway)
    "ai-gateway",  # спринт 4: вызовы агентов (провайдер на стенде — fake)
    "tts",  # релиз 4.1: озвучка (только проверяет токены telegram-bff; на стенде — fake-синтез без моделей)
    "memory",  # спринт 5: память и повторения (вызывает catalog, assessment, ai-gateway, identity-consent)
    "gamification",  # спринт 6: игра и герои (никого не вызывает; издатель событий game.*)
    "billing",  # спринт 8: деньги (вызывает identity-consent, gamification, bot-gateway /stars/*; издатель billing.*)
)


def _b64d(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def ensure(path: Path) -> dict[str, str]:
    seeds: dict[str, str] = json.loads(path.read_text()) if path.exists() else {}
    changed = False
    for issuer in ISSUERS:
        if issuer not in seeds:
            seeds[issuer] = b64e(os.urandom(32))
            changed = True
    if changed:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(seeds, indent=1))
        path.chmod(0o600)
    return seeds


def public_keys(seeds: dict[str, str]) -> dict[str, str]:
    return {name: b64e(public_raw(private_from_seed(_b64d(seed)))) for name, seed in seeds.items()}


def keyring(path: Path, issuer: str) -> KeyRing:
    """KeyRing издателя для подписи токенов сценарием (staff API от имени admin-bff и т. п.)."""
    seeds = ensure(path)
    return KeyRing(issuer, private_from_seed(_b64d(seeds[issuer])), {})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", type=Path, required=True)
    ap.add_argument("--env", help="издатель: напечатать INTERNAL_JWT_PRIVATE_KEY и INTERNAL_JWT_PUBLIC_KEYS")
    ap.add_argument("--shell", action="store_true",
                    help="для run_local.sh: E2E_KEY_<ИЗДАТЕЛЬ>=<seed> по строке и E2E_PUBLIC_KEYS='<json>'")
    a = ap.parse_args()
    seeds = ensure(a.file)
    if a.shell:
        for name, seed in seeds.items():
            print(f"E2E_KEY_{name.upper().replace('-', '_')}={seed}")
        print(f"E2E_PUBLIC_KEYS='{json.dumps(public_keys(seeds), separators=(',', ':'))}'")
        return
    if a.env:
        if a.env not in seeds:
            raise SystemExit(f"неизвестный издатель {a.env!r}")
        print(f"INTERNAL_JWT_PRIVATE_KEY={seeds[a.env]}")
        print(f"INTERNAL_JWT_PUBLIC_KEYS={json.dumps(public_keys(seeds), separators=(',', ':'))}")


if __name__ == "__main__":
    main()

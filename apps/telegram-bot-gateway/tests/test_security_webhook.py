"""Q5 (спринт 9) — SEC-10 «инъекции JSON» на публичном webhook бота (единственный вход из интернета мимо BFF).

Злоумышленник, знающий секрет webhook (утечка, бывший сотрудник), или сам Telegram с испорченным обновлением не должен
получать 500: тело с вложенностью 10 000 уровней разбиралось до RecursionError — отчёт SEC9-04 (исправлено: 400).
Тело без секрета отбрасывается до разбора (401) — это проверяется здесь же.
"""

from __future__ import annotations

import pytest
from botgw_testkit import SECRET

DEEP = b'{"update_id": 1, "message": ' + b"[" * 10_000 + b"]" * 10_000 + b"}"


async def test_deep_json_without_secret_is_401_before_parsing(gw) -> None:
    r = await gw.client.post("/telegram/webhook", content=DEEP, headers={"content-type": "application/json"})
    assert r.status_code == 401


async def test_deep_json_with_secret_is_4xx(gw) -> None:
    h = {"X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json"}
    r = await gw.client.post("/telegram/webhook", content=DEEP, headers=h)
    assert r.status_code == 400 and r.json()["code"] == "WEBHOOK_INVALID", r.status_code


@pytest.mark.parametrize("depth", [33, 500, 990])
async def test_nested_update_beyond_depth_limit_is_400(gw, depth: int) -> None:
    """Глубже 32 уровней (в т. ч. ниже предела рекурсии json) — 400 до обработки."""
    h = {"X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json"}
    body = b'{"update_id": 2, "message": ' + b"[" * (depth - 1) + b"]" * (depth - 1) + b"}"
    r = await gw.client.post("/telegram/webhook", content=body, headers=h)
    assert r.status_code == 400 and r.json()["code"] == "WEBHOOK_INVALID", depth

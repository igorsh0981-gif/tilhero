"""Q5 (спринт 9) — проверка ссылки Runbook в оповещениях операторов (INTERNAL_API §6.2, §12 «Стыки»).

Кнопка «Runbook» допустима только на раздел `RUNBOOK_BASE_URL` (по умолчанию GitHub `main/docs/runbooks/`): чужой
хост, чужой репозиторий, не-https → 422. Ссылка с `..` (или её закодированной формой) после префикса формально
начинается с `RUNBOOK_BASE_URL`, но браузер нормализует путь и уводит на любую страницу github.com — см. отчёт
SEC9-06 (исправлено: разбор URL, `tilhero_common.links.runbook_url_allowed`).
"""

from __future__ import annotations

import uuid

import pytest
from conftest import ADMIN_WEB

from tilhero_common.testing import internal_headers

URL = "/internal/v1/ops-messages"
BASE = "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/"


def body(runbook_url: str) -> dict:
    return {
        "text": "🔴 Поставщик travelpayouts: недоступен.",
        "button": {"text": "Открыть мониторинг", "url": f"{ADMIN_WEB}/monitoring"},
        "runbook_button": {"text": "Runbook", "url": runbook_url},
        "dedup_key": f"ops:{uuid.uuid4()}:open:1",
    }


async def _post(env, url: str):
    return await env.internal.post(URL, json=body(url), headers=internal_headers(env.settings, issuer="notifications"))


@pytest.mark.parametrize("url", [
    "https://evil.example/docs/runbooks/x.md",
    "https://github.com/other/tilhero/blob/main/docs/runbooks/x.md",
    "http://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/x.md",
    "javascript:alert(1)//" + BASE,
    "https://github.com.evil.example/igorsh0981-gif/tilhero/blob/main/docs/runbooks/x.md",
])
async def test_runbook_link_outside_base_is_422(ops_gw, url: str) -> None:
    r = await _post(ops_gw, url)
    assert r.status_code == 422, (url, r.text)


async def test_runbook_link_inside_base_is_sent(ops_gw) -> None:
    r = await _post(ops_gw, BASE + "provider-gateway.md#aviasales")
    assert r.status_code in (200, 202), r.text


@pytest.mark.parametrize("url", [
    BASE + "../../../../../../evil-user/phish/blob/main/README.md",
    BASE + "%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/evil-user/phish",
    BASE + "%2E%2E/%2E%2E/evil",
    BASE + "..%2f..%2fevil",
    BASE + "%252e%252e/%252e%252e/evil",
    BASE + "..\\..\\evil",
    BASE + "./x.md",
    BASE + "a//b.md",
    BASE + "x.md?next=https://evil.example",
    "https://github.com@evil.example/igorsh0981-gif/tilhero/blob/main/docs/runbooks/x.md",
    "https://github.com:8443/igorsh0981-gif/tilhero/blob/main/docs/runbooks/x.md",
    "https://github.com:99999/igorsh0981-gif/tilhero/blob/main/docs/runbooks/x.md",  # .port → ValueError
    "https://github.com:abc/igorsh0981-gif/tilhero/blob/main/docs/runbooks/x.md",
    BASE.rstrip("/") + "-evil/x.md",
    BASE,
])
async def test_runbook_link_path_traversal_is_422(ops_gw, url: str) -> None:
    r = await _post(ops_gw, url)
    assert r.status_code == 422, r.text

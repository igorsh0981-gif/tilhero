"""Q5 (спринт 9) — кнопка «Runbook» в оповещениях операторов: только ссылки раздела `RUNBOOK_BASE_URL`
(INTERNAL_API §12). `..` после префикса — отчёт SEC9-06 (исправлено: разбор URL)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from tilhero_notifications.ops_alerts import runbook_button

BASE = "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/"


def _alert(url: str | None) -> SimpleNamespace:
    return SimpleNamespace(runbook_url=url, alert_id=uuid.uuid4(), occurred_at=datetime.now(UTC))


@pytest.mark.parametrize("url", [
    None, "", "https://evil.example/docs/runbooks/x.md", "http://github.com/igorsh0981-gif/tilhero/x",
    "https://github.com/other/tilhero/blob/main/docs/runbooks/x.md", BASE + 'x.md"onclick', BASE + "x\r\nmd",
    BASE + "x.md <script>",
])
def test_foreign_or_broken_link_gives_no_button(url: str | None) -> None:
    assert runbook_button(_alert(url), BASE) is None  # type: ignore[arg-type]


def test_base_url_must_be_https() -> None:
    assert runbook_button(_alert("http://x/docs/a.md"), "http://x/docs/") is None  # type: ignore[arg-type]


def test_link_inside_base_gives_button() -> None:
    btn = runbook_button(_alert(BASE + "nats.md#lag"), BASE)  # type: ignore[arg-type]
    assert btn is not None and btn["url"] == BASE + "nats.md#lag"


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
def test_path_traversal_gives_no_button(url: str) -> None:
    assert runbook_button(_alert(url), BASE) is None  # type: ignore[arg-type]

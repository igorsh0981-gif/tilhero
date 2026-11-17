"""CI: runbook на каждый сервис и каждый вид оповещения (спринт 9, Q8)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("check_runbooks", Path(__file__).with_name("check_runbooks.py"))
assert _spec and _spec.loader
cr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cr)


def test_runbooks_complete() -> None:
    problems = cr.check()
    assert not problems, "\n".join(problems)


def test_github_slug_matches_github_rules() -> None:
    assert cr.github_slug("Спринт 8: мониторинг, очереди и DLQ, дашборд") == "спринт-8-мониторинг-очереди-и-dlq-дашборд"
    assert cr.github_slug("Шаг О1. Код в ветке main") == "шаг-о1-код-в-ветке-main"
    assert cr.github_slug("`news_feeds` — ленты") == "news_feeds--ленты"
    assert cr.github_slug("Если что-то не так (мониторинг, DLQ, дашборд)") == "если-что-то-не-так-мониторинг-dlq-дашборд"


def test_detects_missing_anchor(tmp_path: Path) -> None:
    md = tmp_path / "x.md"
    md.write_text('# Заголовок\n<a id="service-down"></a>\n## Действия\n```\n# не заголовок\n```\n', encoding="utf-8")
    anchors = cr.anchors_of(md)
    assert {"заголовок", "service-down", "действия"} <= anchors
    assert "не-заголовок" not in anchors


def test_every_ops_monitor_kind_is_mapped() -> None:
    kinds, subject_types, providers = cr.ops_monitor_alerts()
    assert {"status", "route_spike", "dlq_growth", "outbox_stuck"} <= kinds
    assert "news_feeds" in providers and "provider" in subject_types

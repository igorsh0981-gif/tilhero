"""Статические проверки образа n8n (infra/n8n): workflow, Dockerfile, entrypoint.

    uv run pytest infra/n8n -q

TilHero, спринт 1: три расписания — plan-tick (learning-plan), notifications-dispatch (notifications),
invites-tick (social). Импорт по фиксированным id (upsert), включение — только при заданном адресе сервиса.
Здесь — то, что легко сломать правкой JSON: id, расписание, адреса и заголовок авторизации из переменных окружения,
ретраи. HTTP Request n8n считает успехом любой 2xx, если в options нет своей обработки ответа — это и проверяется.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

HERE = Path(__file__).resolve().parent
WORKFLOWS = HERE / "workflows"
# значения разнородны (строка, dict, bool, None) — ожидания читаются по ключам, тип значения — Any
EXPECTED: dict[str, dict[str, Any]] = {
    "invites-tick.json": {
        "cron": "10 * * * *",  # каждый час: напоминание о неотвеченных приглашениях и закрытие истёкших
        "url": "={{ $env.SOCIAL_URL }}/internal/v1/invites:tick",
        "body": None,
        "on_start": False,
    },
    "notifications-dispatch.json": {
        "cron": "*/5 * * * *",  # каждые 5 минут: отложенные (тихие часы, детское окно 08:00–20:00)
        "url": "={{ $env.NOTIFICATIONS_URL }}/internal/v1/notifications:dispatch",
        "body": None,
        "on_start": False,
    },
    "plan-tick.json": {
        "cron": "*/5 * * * *",  # каждые 5 минут: напоминания о занятии и пропуски
        "url": "={{ $env.LEARNING_PLAN_URL }}/internal/v1/plan:tick",
        "body": None,
        "on_start": False,
    },
    "catalog-tick.json": {
        "cron": "5 * * * *",  # каждый час: приостановка медиа с истёкшими правами (спринт 3)
        "url": "={{ $env.CATALOG_URL }}/internal/v1/catalog:tick",
        "body": None,
        "on_start": False,
    },
    "lessons-tick.json": {
        "cron": "*/5 * * * *",  # каждые 5 минут: брошенные сессии, реплики по сроку (спринт 4); парные комнаты — приглашения, «скоро начнётся», офлайн; наборы дуэлей (спринт 7)
        "url": "={{ $env.LESSONS_URL }}/internal/v1/lessons:tick",
        "body": None,
        "on_start": False,
    },
    "assessment-tick.json": {
        "cron": "35 3 * * *",  # раз в сутки: стирание текста апелляций через 90 дней после решения (спринт 4)
        "url": "={{ $env.ASSESSMENT_URL }}/internal/v1/assessment:tick",
        "body": None,
        "on_start": False,
    },
    "memory-tick.json": {
        "cron": "*/15 * * * *",  # каждые 15 минут: сессии повторения, вечерние напоминания, проверки удержания (спринт 5)
        "url": "={{ $env.MEMORY_URL }}/internal/v1/memory:tick",
        "body": None,
        "on_start": False,
    },
    "game-tick.json": {
        "cron": "*/15 * * * *",  # каждые 15 минут: задания дня, события недели, рефералы, сверка кошельков (спринт 6)
        "url": "={{ $env.GAMIFICATION_URL }}/internal/v1/game:tick",
        "body": None,
        "on_start": False,
    },
    # спринт 8: billing — выключены в репозитории ("active": false) до выкладки billing с tick и сверкой (поток A)
    "billing-tick.json": {
        "cron": "*/5 * * * *",  # каждые 5 минут: заказы, периоды, подписки Stars, удержания, заявки, фискализация
        "url": "={{ $env.BILLING_URL }}/internal/v1/billing:tick",
        "body": None,
        "on_start": False,
        "active": False,
    },
    "billing-reconcile.json": {
        "cron": "15 23 * * *",  # раз в сутки, 23:15 UTC: сверка с провайдерами и Telegram (INTERNAL_API §1.14)
        "url": "={{ $env.BILLING_URL }}/internal/v1/billing:reconcile",
        "body": None,
        "on_start": False,
        "active": False,
    },
    "user-admin-reconcile.json": {
        "cron": "25 * * * *",  # каждый час: страховочная сверка read-модели учеников админки (спринт 2)
        "url": "={{ $env.USER_ADMIN_URL }}/internal/v1/reconcile",
        "body": None,
        "on_start": False,
    },
}


def load(name: str) -> dict:
    return json.loads((WORKFLOWS / name).read_text(encoding="utf-8"))


def test_workflow_files_and_unique_fixed_ids():
    assert sorted(p.name for p in WORKFLOWS.glob("*.json")) == sorted(EXPECTED)
    ids = [load(n)["id"] for n in EXPECTED]
    assert all(re.fullmatch(r"[A-Za-z0-9]{16}", i) for i in ids), ids  # формат id n8n; повторный импорт — upsert
    assert len(set(ids)) == len(ids)
    names = [load(n)["name"] for n in EXPECTED]
    assert names == [n.removesuffix(".json") for n in EXPECTED]


@pytest.mark.parametrize("name", list(EXPECTED))
def test_workflow_schedule_and_http_call(name: str):
    wf, exp = load(name), EXPECTED[name]
    assert wf["settings"]["timezone"] == "UTC" and wf["settings"]["executionOrder"] == "v1"
    assert wf["active"] is exp.get("active", True)  # false — выключен в репозитории (entrypoint не включает)
    nodes = {n["name"]: n for n in wf["nodes"]}
    assert len({n["id"] for n in wf["nodes"]}) == len(wf["nodes"])
    triggers = [n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.scheduleTrigger"]
    assert len(triggers) == 1
    assert triggers[0]["parameters"]["rule"]["interval"] == [{"field": "cronExpression", "expression": exp["cron"]}]
    https = [n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.httpRequest"]
    assert len(https) == 1
    http = https[0]
    to_http = [[{"node": http["name"], "type": "main", "index": 0}]]
    # расписание → HTTP
    assert wf["connections"][triggers[0]["name"]]["main"] == to_http
    starts = [n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.n8nTrigger"]
    if exp["on_start"]:
        # «Instance Started» = значение "init" (n8n-nodes-base N8nTrigger, n8n 1.123.x) → тот же HTTP
        assert len(starts) == 1 and starts[0]["typeVersion"] == 1 and starts[0]["parameters"] == {"events": ["init"]}
        assert wf["connections"][starts[0]["name"]]["main"] == to_http
    else:
        assert starts == []
    assert set(nodes) == {triggers[0]["name"], http["name"], *(n["name"] for n in starts)}
    assert set(wf["connections"]) == {triggers[0]["name"], *(n["name"] for n in starts)}
    p = http["parameters"]
    assert p["method"] == "POST" and p["url"] == exp["url"]
    assert p["sendHeaders"] is True
    assert p["headerParameters"]["parameters"] == [
        {"name": "Authorization", "value": "=Bearer {{ $env.SCHEDULER_TOKEN }}"}]
    assert exp.get("min_timeout", 1000) <= p["options"]["timeout"] <= 300_000
    # без своей обработки ответа: 2xx (в том числе 200 «запуск не нужен» у discovery) — успех, не ошибка
    assert set(p["options"]) == {"timeout"}
    if exp["body"] is None:
        assert "sendBody" not in p
    else:
        assert p["sendBody"] is True and p["specifyBody"] == "json" and json.loads(p["jsonBody"]) == exp["body"]
    assert http["retryOnFail"] is True and http["maxTries"] >= 2 and http["waitBetweenTries"] <= 5000
    # секрет — только из окружения: в JSON нет credentials и литеральных токенов
    text = (WORKFLOWS / name).read_text()
    assert "credentials" not in text and "Bearer " + "{{" in text
    assert not re.search(r"Bearer [A-Za-z0-9_-]{16,}", text)


def test_dockerfile_pins_n8n_1x_and_allows_env_in_expressions():
    df = (HERE / "Dockerfile").read_text()
    m = re.search(r"^FROM n8nio/n8n:(\S+)$", df, re.M)
    assert m and re.fullmatch(r"1\.\d+\.\d+", m.group(1)), "версия n8n закреплена точно (ветка 1.x)"
    assert "COPY infra/n8n/workflows /workflows" in df  # контекст — корень репозитория (как у Railway)
    for line in ("N8N_BLOCK_ENV_ACCESS_IN_NODE=false", "N8N_USER_FOLDER=/home/node", "DB_TYPE=sqlite",
                 "GENERIC_TIMEZONE=UTC", "N8N_DIAGNOSTICS_ENABLED=false", "N8N_RUNNERS_ENABLED=true", "N8N_PORT=5678"):
        assert line in df, line
    assert 'ENTRYPOINT ["tini", "--", "/tilhero-entrypoint.sh"]' in df


def test_entrypoint_imports_activates_known_ids_then_starts():
    sh = (HERE / "entrypoint.sh").read_text()
    imp = sh.index('n8n import:workflow --separate --input="$WORKFLOWS_DIR"')
    act = sh.index('n8n update:workflow --id="$id" --active=true')
    start = sh.index("exec n8n start")
    assert imp < act < start
    assert "--all" not in sh  # включаются только свои workflow, созданные в UI не трогаются
    assert "set -eu" in sh


URL_VARS = {"invites-tick.json": "SOCIAL_URL", "notifications-dispatch.json": "NOTIFICATIONS_URL",
            "plan-tick.json": "LEARNING_PLAN_URL", "user-admin-reconcile.json": "USER_ADMIN_URL",
            "catalog-tick.json": "CATALOG_URL", "lessons-tick.json": "LESSONS_URL",
            "assessment-tick.json": "ASSESSMENT_URL", "memory-tick.json": "MEMORY_URL",
            "game-tick.json": "GAMIFICATION_URL", "billing-tick.json": "BILLING_URL",
            "billing-reconcile.json": "BILLING_URL"}


def _run_entrypoint(tmp_path: Path, env: dict[str, str]) -> tuple[subprocess.CompletedProcess, list[str]]:
    """entrypoint.sh с поддельным `n8n` в PATH: какие команды он выполнил бы (import, update, start)."""
    calls = tmp_path / "calls.log"
    fake = tmp_path / "bin" / "n8n"
    fake.parent.mkdir()
    fake.write_text(f'#!/bin/sh\necho "$*" >> {calls}\n')
    fake.chmod(0o755)
    run_env = {"PATH": f"{fake.parent}:{os.environ['PATH']}", "TILHERO_WORKFLOWS_DIR": str(WORKFLOWS),
               "N8N_USER_FOLDER": str(tmp_path), **env}
    proc = subprocess.run(["sh", str(HERE / "entrypoint.sh")], env=run_env, capture_output=True, text=True,
                          timeout=60, check=False)
    return proc, calls.read_text().splitlines() if calls.exists() else []


@pytest.mark.skipif(shutil.which("node") is None, reason="node нужен entrypoint.sh (в образе n8n он есть)")
def test_entrypoint_activates_only_workflows_with_url(tmp_path: Path):
    """n8n, обновлённый раньше сервисов (нет SOCIAL_URL), стартует, импортирует все workflow, но включает только те,
    чей адрес задан; со всеми адресами — все три."""
    ids = {name: load(name)["id"] for name in EXPECTED}
    assert set(URL_VARS) == set(EXPECTED)
    for name, var in URL_VARS.items():
        assert EXPECTED[name]["url"].startswith(f"={{{{ $env.{var} }}}}/"), name
    old = {"LEARNING_PLAN_URL": "http://learning-plan:8102", "NOTIFICATIONS_URL": "http://notifications:8104",
           "SCHEDULER_TOKEN": "t" * 43}
    proc, calls = _run_entrypoint(tmp_path, old)
    assert proc.returncode == 0, proc.stderr
    assert calls[0].startswith("import:workflow --separate") and calls[-1] == "start"
    activated = [c.split("--id=")[1].split()[0] for c in calls if c.startswith("update:workflow")]
    assert sorted(activated) == sorted(ids[n] for n in ("plan-tick.json", "notifications-dispatch.json"))
    assert "не задана SOCIAL_URL" in proc.stderr

    (tmp_path / "calls.log").unlink()
    shutil.rmtree(tmp_path / "bin")
    new = {**old, "SOCIAL_URL": "http://social:8109", "USER_ADMIN_URL": "http://user-admin:8121",
           "CATALOG_URL": "http://catalog:8110", "LESSONS_URL": "http://lessons:8112",
           "ASSESSMENT_URL": "http://assessment:8113", "MEMORY_URL": "http://memory:8116",
           "GAMIFICATION_URL": "http://gamification:8117", "BILLING_URL": "http://billing:8118"}
    proc, calls = _run_entrypoint(tmp_path, new)
    assert proc.returncode == 0, proc.stderr
    activated = [c.split("--id=")[1].split()[0] for c in calls if c.startswith("update:workflow")]
    # спринт 8: выключенные в репозитории (billing-tick, billing-reconcile) не включаются и при заданном адресе
    disabled = {ids[n] for n, e in EXPECTED.items() if e.get("active") is False}
    assert disabled == {ids["billing-tick.json"], ids["billing-reconcile.json"]}
    assert sorted(activated) == sorted(set(ids.values()) - disabled) and "WARNING" not in proc.stderr
    assert all(f"workflow {i}" in proc.stderr and "выключен в репозитории" in proc.stderr for i in disabled)

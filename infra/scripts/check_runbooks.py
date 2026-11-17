"""Проверка runbook'ов (спринт 9, пакет Q8; docs/sprint9/INTERNAL_API.md §6).

Что проверяется:
1. У каждого сервиса приложения (`services/*`, `apps/*` с Dockerfile) и у инфраструктуры (`postgres`, `redis`, `nats`,
   `n8n`) есть `docs/runbooks/<имя>.md` с обязательными разделами и якорем `service-down`.
2. `docs/runbooks/alerts.json` (вид оповещения → runbook) покрывает все виды и типы объектов оповещений ops-monitor
   (CHECK-ограничения `health_alerts` в коде) и всех поставщиков здоровья (`health/domain.py::PROVIDERS`), а также
   оповещения бюджета ai-control.
3. Каждая цель в `alerts.json` (`файл#якорь`) существует; правило с `{subject}` раскрывается во все сервисы.
4. Все относительные ссылки внутри `docs/runbooks/*.md` ведут на существующий файл и якорь — заголовок (slug как на
   GitHub) или `<a id="…"></a>`.

Запуск: `uv run python infra/scripts/check_runbooks.py` (код выхода 1 и список проблем при ошибке); тест —
`infra/scripts/test_check_runbooks.py` (job CI `py · infra/scripts`).
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNBOOKS = ROOT / "docs" / "runbooks"
ALERTS = RUNBOOKS / "alerts.json"
INFRA = ("postgres", "redis", "nats", "n8n")
# Разделы, без которых runbook сервиса неполон (шаблон docs/runbooks/README.md → «Шаблон»).
REQUIRED_SECTIONS = ("Назначение", "Признаки", "Проверка", "Действия", "Откат", "Эскалация")
SERVICE_ANCHORS = ("service-down",)
# Виды оповещений, которые спринт 9 добавляет в ops-monitor (INTERNAL_API §6.1). Проверяются заранее: runbook должен
# появиться раньше кода, а после изменения CHECK-ограничения они придут и из кода.
PLANNED_KINDS = {"service_down", "deletion_stuck", "rate_limit_spike", "rate_limit_unavailable"}
PLANNED_SUBJECT_TYPES = {"service", "deletion", "ratelimit"}

_ANCHOR_RE = re.compile(r'<a\s+(?:id|name)="([^"]+)"\s*>\s*</a>')
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_LINK_RE = re.compile(r"\]\(([^)\s]+)\)")
_CODE_FENCE = re.compile(r"^```")


def github_slug(text: str) -> str:
    """Якорь заголовка как у GitHub: нижний регистр, без разметки и пунктуации, пробелы → «-»."""
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<[^>]+>", "", text)
    out = []
    for ch in text.lower():
        if ch in (" ", "-") or ch == "_":
            out.append("-" if ch == " " else ch)
        elif unicodedata.category(ch)[0] in ("L", "N", "M"):
            out.append(ch)
    return "".join(out)


def anchors_of(path: Path) -> set[str]:
    """Якоря файла: slug каждого заголовка (с суффиксами -1, -2 у повторов) и явные `<a id>`."""
    found: set[str] = set()
    seen: dict[str, int] = {}
    in_code = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if _CODE_FENCE.match(line.strip()):
            in_code = not in_code
            continue
        if in_code:
            continue
        found.update(_ANCHOR_RE.findall(line))
        m = _HEADING_RE.match(line)
        if m:
            slug = github_slug(m.group(2))
            n = seen.get(slug, 0)
            found.add(slug if n == 0 else f"{slug}-{n}")
            seen[slug] = n + 1
    return found


def services() -> list[str]:
    names = []
    for base in ("services", "apps"):
        for d in sorted((ROOT / base).iterdir()):
            if d.is_dir() and (d / "Dockerfile").exists():
                names.append(d.name)
    return names


def _tuple_in_check(source: str, constraint: str) -> set[str]:
    """Значения `col IN ('a', 'b')` из CheckConstraint с именем `constraint` (может быть разбит на строки)."""
    m = re.search(r'CheckConstraint\(\s*((?:"[^"]*"\s*)+),\s*name="' + re.escape(constraint) + '"', source)
    if not m:
        raise SystemExit(f"не найдено ограничение {constraint} в коде ops-monitor")
    body = "".join(re.findall(r'"([^"]*)"', m.group(1)))
    return set(re.findall(r"'([a-z_]+)'", body))


def ops_monitor_alerts() -> tuple[set[str], set[str], set[str]]:
    models = (ROOT / "services/ops-monitor/src/tilhero_ops_monitor/health/models.py").read_text(encoding="utf-8")
    kinds = _tuple_in_check(models, "ck_health_alerts_kind") | PLANNED_KINDS
    subject_types = _tuple_in_check(models, "ck_health_alerts_subject_type") | PLANNED_SUBJECT_TYPES
    domain = (ROOT / "services/ops-monitor/src/tilhero_ops_monitor/health/domain.py").read_text(encoding="utf-8")
    m = re.search(r"PROVIDERS:\s*dict\[str, str\]\s*=\s*\{(.*?)\}", domain, re.S)
    if not m:
        raise SystemExit("не найден словарь PROVIDERS в ops-monitor health/domain.py")
    providers = set(re.findall(r'"([a-z_]+)":', m.group(1)))
    return kinds, subject_types, providers


def _resolve(target: str, base: Path) -> tuple[Path, str | None]:
    path, _, anchor = target.partition("#")
    return (base / path).resolve(), anchor or None


def check() -> list[str]:
    problems: list[str] = []
    if not RUNBOOKS.is_dir():
        return ["нет каталога docs/runbooks"]
    svc = services()
    # 1. файлы и разделы
    for name in [*svc, *INFRA]:
        path = RUNBOOKS / f"{name}.md"
        if not path.exists():
            problems.append(f"нет runbook'а {path.relative_to(ROOT)}")
            continue
        text = path.read_text(encoding="utf-8")
        headings = {m.group(2) for line in text.splitlines() if (m := _HEADING_RE.match(line))}
        for section in REQUIRED_SECTIONS:
            if not any(h.startswith(section) for h in headings):
                problems.append(f"{path.name}: нет раздела «{section}»")
        anchors = anchors_of(path)
        for anchor in SERVICE_ANCHORS:
            if anchor not in anchors:
                problems.append(f"{path.name}: нет якоря #{anchor}")
    if not (RUNBOOKS / "README.md").exists():
        problems.append("нет docs/runbooks/README.md (оглавление)")
    # 2–3. оповещения → runbook
    try:
        rules = json.loads(ALERTS.read_text(encoding="utf-8"))["rules"]
    except (OSError, ValueError, KeyError) as exc:
        return [*problems, f"alerts.json не читается: {exc}"]
    kinds, subject_types, providers = ops_monitor_alerts()
    om_rules = [r for r in rules if r.get("source", "ops-monitor") == "ops-monitor"]
    covered_kinds = {r["kind"] for r in om_rules}
    for kind in sorted(kinds - covered_kinds):
        problems.append(f"alerts.json: нет runbook'а для вида оповещения ops-monitor «{kind}»")
    for st in sorted(subject_types - {r["subject_type"] for r in om_rules}):
        problems.append(f"alerts.json: нет правила для типа объекта «{st}»")
    status_subjects = {r["subject"] for r in om_rules if r["kind"] == "status"}
    if "*" not in status_subjects:
        for p in sorted(providers - status_subjects):
            problems.append(f"alerts.json: нет runbook'а статуса поставщика «{p}»")
    ai_kinds = {r["kind"] for r in rules if r.get("source") == "ai-control"}
    for kind in ("budget", "unpriced"):
        if kind not in ai_kinds:
            problems.append(f"alerts.json: нет runbook'а оповещения ai-control «{kind}»")
    for r in rules:
        targets = ([r["runbook"].replace("{subject}", s) for s in svc] if "{subject}" in r["runbook"]
                   else [r["runbook"]])
        for t in targets:
            target, target_anchor = _resolve(t, RUNBOOKS)
            if not target.exists():
                problems.append(f"alerts.json: {r['kind']}/{r['subject']} → нет файла {t}")
            elif target_anchor and target_anchor not in anchors_of(target):
                problems.append(f"alerts.json: {r['kind']}/{r['subject']} → нет якоря {t}")
    # 4. ссылки внутри runbook'ов
    for md in sorted(RUNBOOKS.glob("*.md")):
        in_code = False
        for no, line in enumerate(md.read_text(encoding="utf-8").splitlines(), 1):
            if _CODE_FENCE.match(line.strip()):
                in_code = not in_code
            if in_code:
                continue
            for link in _LINK_RE.findall(line):
                if re.match(r"^[a-z]+:", link):  # http(s), mailto — внешние
                    continue
                link_path: Path
                link_anchor: str | None
                if link.startswith("#"):
                    link_path, link_anchor = md, link[1:]
                else:
                    link_path, link_anchor = _resolve(link, md.parent)
                if not link_path.exists():
                    problems.append(f"{md.name}:{no}: ссылка на несуществующий файл {link}")
                elif link_anchor and link_path.suffix == ".md" and link_anchor not in anchors_of(link_path):
                    problems.append(f"{md.name}:{no}: нет якоря {link}")
    return problems


def main() -> int:
    problems = check()
    for p in problems:
        print(f"::error title=runbooks::{p}" if "--github" in sys.argv else p)
    if not problems:
        print(f"runbooks ok: {len(services())} сервисов + {len(INFRA)} инфраструктура, оповещения покрыты")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())

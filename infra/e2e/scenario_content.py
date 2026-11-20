# ruff: noqa: S608 — QA-скрипт dev-стенда: psql (SQL только из ключей/UUID сценария, проверенных регуляркой, и констант)
"""Сквозной сценарий спринта 3 TilHero (контент, диагностика, план, медиа) через публичные API — как Mini App
(telegram-bff) и браузер admin-web (admin-bff).

Предусловие: `infra/e2e/run_local.sh content` (сброс учёток admin-identity + up + этот сценарий). Отдельно, на уже
поднятом стенде со свежим bootstrap-сотрудником:
    uv run python infra/e2e/scenario_content.py [--admin-bff http://127.0.0.1:8002] [--bff http://127.0.0.1:8001] [-v]
    uv run python infra/e2e/scenario_content.py --cleanup   # только уборка остатков прерванного прогона

Сотрудники входят bootstrap-учёткой (временный пароль → смена → TOTP), super_admin создаёт methodist ×2,
content_manager (привилегированные: MFA, four-eyes — waived при одном super_admin) и analyst. Помощники — сценарии
спринтов 1 (`scenario.py`: ученики, онбординг, мок Telegram, psql) и 2 (`scenario_admin.py`: браузер admin-web, TOTP,
step-up). Доменные сервисы напрямую не вызываются, кроме:
  * `POST catalog /internal/v1/catalog:tick` с SCHEDULER_TOKEN — как n8n `catalog-tick`;
  * read-only psql — то, чего нет в API: ключи заданий диагностики и seed сессии (воспроизводимость), неизменяемость
    версий, ревизии результатов и траекторий, сага удаления, события (outbox);
  * `--cleanup` и уборка в шаге C00 — staff API catalog от имени admin-bff (ключ стенда), как уборка scenario_admin.

ТЕСТОВЫЕ ИЗМЕНЕНИЯ БД (только dev-стенд, собственный ключ медиа сценария `m-e2e-<метка>`):
  * истечение прав (AT-29): API не публикует медиа с `valid_to` в прошлом (RIGHTS_REQUIRED при подтверждении прав,
    отправке и публикации), а ждать полуночи по Ташкенту нельзя — поэтому `valid_to` ОПУБЛИКОВАННОЙ версии этого ключа
    сдвигается на «вчера» под postgres в транзакции с `session_replication_role = replica` (триггер неизменяемости
    `content_versions_guard` в ней не срабатывает); затем `catalog:tick` приостанавливает материал штатно;
  * проверка неизменяемости (AT-26): UPDATE опубликованной версии под ролью-владельцем `catalog_owner` внутри
    BEGIN … ROLLBACK — обязан упасть на триггере (если бы прошёл — откатывается, шаг FAIL).

Что сценарий меняет в общем стенде и как возвращает:
  * урок курса (тот, что ученик без диагностики видит следующим): новая версия → публикация → откат к прежней
    (в finally шага — откат, если шаг упал посередине); остатки прерванного прогона (маркер «[e2e XXXXX]» в
    заголовке) убирает C00 / `--cleanup`;
  * сценарий `sc-e2e-<метка>` — снимается с публикации в finally; медиа `m-e2e-<метка>` — приостанавливается по
    сценарию (или снимается с публикации в finally, если шаг упал раньше);
  * заявки на песни e2e-учеников решаются (тестовая — rejected), чтобы реестр новых заявок не рос.

Печатает PASS/FAIL/SKIP по шагам и «Итого: N/M PASS»; код выхода 1, если хоть один шаг упал. Шаги после сбоя
критичного шага — SKIP.
"""

from __future__ import annotations

import argparse
import base64
import copy
import json
import os
import re
import secrets
import string
import subprocess
import sys
import time
import traceback
import uuid
from collections import Counter
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scenario as s1  # ученики (telegram-bff), онбординг, мок Telegram, psql
import scenario_admin as s2  # браузер admin-web, TOTP, step-up, вход сотрудника

check, expect, wait_for = s1.check, s1.expect, s1.wait_for
StepFailed, StepSkipped = s1.StepFailed, s1.StepSkipped
Staff = s2.Staff
idem = s2.idem
parse_ts = s2.parse_ts

TG_BFF = s2.TG_BFF
CATALOG = os.environ.get("E2E_CATALOG", "http://127.0.0.1:8110")
DIAGNOSTICS = os.environ.get("E2E_DIAGNOSTICS", "http://127.0.0.1:8111")
TASHKENT = ZoneInfo("Asia/Tashkent")
PAIR = "ru-en"
COURSE = "en-core"
BANDS = ("A0", "A1", "A2", "B1", "B2")
LOW_BANDS = ("A0", "A1", "A2")
MARK_LIKE = "%[e2e %"  # маркер правок сценария в заголовках контента: «[e2e ABC12]»
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
KINDS = {"course", "skill", "module", "lesson", "rubric", "scenario", "media_asset", "media_exercise"}

# admin.ts Permission (спринт 3) и PLAN спринта 3 «Права и роли»
S3_PERMS = {"content.read", "content.edit", "content.review", "content.publish", "media.rights", "lang.manage"}
ALL_PERMS = s2.ALL_PERMS | S3_PERMS
# + права спринта 4 (admin-identity 0004): methodist — агенты и контроль диалогов, analyst — только чтение
# + права спринта 5 (admin-identity 0005): methodist — memory.read и glossary.manage, content_manager — glossary.manage,
#   analyst — memory.read
METHODIST_PERMS = {"dashboard.read", "users.read", "content.read", "content.edit", "content.review", "content.publish",
                   "ai.read", "ai.manage", "ai.publish", "qa.read", "qa.transcripts", "qa.review",
                   "memory.read", "glossary.manage"}
CM_PERMS = {"dashboard.read", "content.read", "content.edit", "media.rights", "glossary.manage"}
ANALYST_PERMS = {"dashboard.read", "users.read", "content.read", "ai.read", "qa.read", "costs.read", "memory.read"}

# bff.ts DiagnosticItem — ровно эти поля (ключа ответа, полосы и тегов нет)
ITEM_KEYS = {"item_id", "area", "type", "instruction", "prompt_en", "passage_en", "audio_text_en", "options", "position"}
AREAS6 = {"vocabulary", "grammar", "reading", "listening", "speaking", "writing"}
KIDS_PRESSURE = ("быстрее", "скорее", "поторопись", "провал", "время вышло", "ошибся", "ошиблась")
CONTENT_SCHEMAS = ["catalog", "diagnostics", "learning_plan", "notifications", "admin_identity", "audit"]

# аудио «авторской сценки» сценария: заголовок ID3v2 + кадр MPEG (catalog проверяет сигнатуру); одинаковые байты
# во всех прогонах — повторная загрузка отдаёт тот же blob (sha256)
AUDIO_BYTES = b"ID3\x04\x00\x00\x00\x00\x00\x00" + bytes([0xFF, 0xFB, 0x90, 0x64]) + b"\x00" * 413 + b"TilHero e2e"


# =============================================================================================== помощники


def pj(sql: str) -> Any:
    """psql → JSON (запрос сам собирает json_agg/json_build_object)."""
    out = s1._psql(sql)
    return json.loads(out) if out else None


def safe_key(value: str) -> str:
    check(isinstance(value, str) and KEY_RE.fullmatch(value), f"недопустимый ключ контента {value!r}")
    return value


def psql_try(sql: str, user: str = "postgres") -> subprocess.CompletedProcess[str]:
    """psql под заданной ролью без check=True: результат и stderr для проверок «запрос обязан упасть»."""
    env = {**os.environ, "PGPASSWORD": "dev"}
    return subprocess.run(["psql", "-h", "127.0.0.1", "-U", user, "-d", s1.DB, "-v", "ON_ERROR_STOP=1", "-tAc", sql],
                          capture_output=True, text=True, env=env, check=False)


def published(kind: str) -> dict[str, dict[str, Any]]:
    """Опубликованные тела вида (то, что видит ученик, — по указателям catalog)."""
    check(kind in KINDS, kind)
    return pj("SELECT coalesce(json_object_agg(cv.key, cv.payload), '{}') FROM catalog.content_versions cv "
              "JOIN catalog.content_pointers p ON p.kind = cv.kind AND p.key = cv.key "
              f"AND p.published_version = cv.version WHERE cv.kind = '{kind}'") or {}


def tashkent_today() -> date:
    return datetime.now(TASHKENT).date()


def need(c: s2.Ctx, *keys: str) -> None:
    missing = [k for k in keys if k not in c.data]
    if missing:
        raise StepSkipped(f"нет данных предыдущего шага: {', '.join(missing)}")


def errors_of(body: dict[str, Any]) -> list[tuple[str, str]]:
    return [(e.get("path", ""), e.get("code", "")) for e in (body.get("details") or {}).get("errors") or []]


def tick() -> dict[str, Any]:
    """catalog:tick — как n8n `catalog-tick` (Bearer SCHEDULER_TOKEN)."""
    r = httpx.post(f"{CATALOG}/internal/v1/catalog:tick", headers={"authorization": f"Bearer {s1.SCHEDULER_TOKEN}"},
                   timeout=30)
    body = expect(r, 200)
    check({"suspended", "expiring", "today"} <= set(body), f"ответ catalog:tick: {body}")
    return body


def mark_of(c: s2.Ctx) -> str:
    return f"[e2e {c.tag}]"


def content_path(kind: str, key: str, v: int | None = None, tail: str = "") -> str:
    p = f"/admin/v1/content/{kind}/{key}"
    if v is not None:
        p += f"/versions/{v}"
    return p + tail


def detail(b: s2.Browser, kind: str, key: str) -> dict[str, Any]:
    return expect(b.get(content_path(kind, key)), 200)


def version_meta(d: dict[str, Any], v: int) -> dict[str, Any]:
    found = [x for x in d["versions"] if x["version"] == v]
    check(found, f"версии {v} нет в карточке: {[x['version'] for x in d['versions']]}")
    return found[0]


def review_ok() -> dict[str, Any]:
    return {"decision": "approve", "note": "e2e: проверено методистом", "locale_checks": {"ru": "checked", "uz": "checked"}}


def put_version(b: s2.Browser, kind: str, key: str, v: int, payload: dict[str, Any], expected_hash: str,
                status: int = 200, code: str | None = None) -> dict[str, Any]:
    return expect(b.request("PUT", content_path(kind, key, v), json_body={"payload": payload,
                                                                          "expected_hash": expected_hash}),
                  status, code)


def rbac_denied(b: s2.Browser, method: str, path: str, body: Any, perm: str) -> str | None:
    """403 PERMISSION_DENIED {permission} — иначе строка с отклонением."""
    r = b.request(method, path, json_body=body, headers=idem() if method != "GET" else None)
    j = r.json() if r.content else {}
    if r.status_code != 403 or j.get("code") != "PERMISSION_DENIED" or (j.get("details") or {}).get("permission") != perm:
        return f"{b.name} {method} {path} → {r.status_code} {str(j)[:160]}"
    return None


def step_up_active(st: Staff, min_left: float = 60.0) -> bool:
    me = expect(st.browser.get("/admin/v1/me"), 200)
    st.browser.adopt(me)
    until = me["session"]["step_up_until"]
    return bool(until) and (parse_ts(until) - datetime.now(UTC)).total_seconds() > min_left


# ---------------------------------------------------------------- диагностика ученика


def dx_test(test_ref: str) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Банк заданий версии теста с ключами (diagnostics.tests, psql: ученику ключи не отдаются)."""
    test_id, _, ver = test_ref.partition("@")
    check(KEY_RE.fullmatch(test_id) and ver.isdigit(), f"test_version: {test_ref}")
    row = pj("SELECT json_build_object('config', config, 'items', items, 'pair_id', pair_id, 'audience', audience) "
             f"FROM diagnostics.tests WHERE test_id = '{test_id}' AND version = {int(ver)}")
    check(row and row.get("items"), f"теста {test_ref} нет в diagnostics.tests")
    row["test_id"], row["version"] = test_id, int(ver)
    return {i["item_id"]: i for i in row["items"]}, row


def answer_value(meta: dict[str, Any], correct: bool) -> int | list[str]:
    key = meta["answer"]
    if isinstance(key, int):
        return key if correct else (key + 1) % len(meta["options"])
    words = list(key)
    return words if correct else [*words[1:], words[0]]


def check_item(item: Any) -> None:
    check(isinstance(item, dict) and set(item) == ITEM_KEYS, f"задание не по контракту DiagnosticItem: "
          f"{sorted(set(item) ^ ITEM_KEYS) if isinstance(item, dict) else item}")


def run_session(u: s1.U, sid: str, first: dict[str, Any], items: dict[str, dict[str, Any]],
                decide: Callable[[dict[str, Any], int], tuple[Any, bool]],
                seen_instr: list[str] | None = None) -> list[dict[str, Any]]:
    """Отвечает до done: decide(задание банка, номер в области) → (answer, dont_know). → журнал ответов."""
    cur: dict[str, Any] | None = first
    log: list[dict[str, Any]] = []
    per_area: Counter[str] = Counter()
    for n in range(80):
        if cur is None:
            return log
        check_item(cur)
        check(cur["position"] == len(log) + 1, f"position {cur['position']} ≠ {len(log) + 1}")
        meta = items[cur["item_id"]]
        if seen_instr is not None:
            seen_instr.append(cur["instruction"]["ru"])
        ans, dk = decide(meta, per_area[meta["area"]])
        r = u.ok("POST", f"/v1/diagnostics/sessions/{sid}/answers",
                 json={"item_id": cur["item_id"], "answer": None if dk else ans, "dont_know": dk, "time_ms": 3000 + n})
        check(r["accepted"] is True and set(r) == {"accepted", "next", "done"}, r)
        correct = (not dk) and ans == meta["answer"]
        log.append({"item_id": cur["item_id"], "area": meta["area"], "band": meta["band"], "correct": correct,
                    "listening": True})
        per_area[meta["area"]] += 1
        if r["done"]:
            check(r["next"] is None, f"done и next одновременно: {r}")
            return log
        cur = r["next"]
    raise StepFailed("диагностика не завершилась за 80 заданий")


def replay(test_row: dict[str, Any], seed: str, log: list[dict[str, Any]], probe: tuple[int, str] | None,
           result: dict[str, Any], *, listening_available: bool) -> str:
    """Воспроизводимость (AT-32): подбор и профиль — функция (версия теста, seed, ответы, аудирование). Повтор правилами
    diagnostics (engine — чистые функции, БД и HTTP не трогает) по данным сессии из psql обязан дать те же задания и
    тот же профиль, что отдал сервис. Без пакета tilhero_diagnostics — проверка пропускается (строка-пояснение)."""
    try:
        from tilhero_diagnostics import engine, testdef
    except ImportError as exc:  # pragma: no cover — только вне workspace
        return f"replay пропущен: {exc}"
    test = testdef.from_row(test_row["test_id"], test_row["version"], test_row["pair_id"], test_row["audience"],
                            test_row["config"], test_row["items"])
    quotas = {a: test.config.items_per_area for a in test.config.areas}
    hist: list[Any] = []
    for i, e in enumerate(log):
        if probe is not None and probe[0] == i:
            exp = engine.next_item(test, seed, hist, session_answers=hist, quotas=quotas, listening_available=True)
            check(exp is not None and exp.item_id == probe[1],
                  f"воспроизводимость: задание {i + 1} (до «нет голоса») {probe[1]}, правила дают "
                  f"{exp.item_id if exp else None}")
        exp = engine.next_item(test, seed, hist, session_answers=hist, quotas=quotas,
                               listening_available=e["listening"])
        check(exp is not None and exp.item_id == e["item_id"],
              f"воспроизводимость: задание {i + 1} сервиса {e['item_id']}, правила дают {exp.item_id if exp else None}")
        hist.append(engine.Answered(e["item_id"], e["area"], e["band"], e["correct"]))
    last = engine.next_item(test, seed, hist, session_answers=hist, quotas=quotas,
                            listening_available=log[-1]["listening"] if log else True)
    check(last is None, f"воспроизводимость: правила дают ещё задание {last.item_id if last else None}")
    prof = engine.profile(test, hist, listening_available=listening_available)
    want = {a.area: a.public() for a in prof.areas}
    got = {a["area"]: a for a in result["areas"]}
    diff = [a for a in want if any(want[a][k] != got.get(a, {}).get(k)
                                   for k in ("status", "band", "confidence", "reason", "needs_followup"))]
    check(not diff, f"профиль сервиса ≠ правилам по областям {diff}: сервис {[got.get(a) for a in diff]}, "
          f"правила {[want[a] for a in diff]}")
    check(prof.provisional_level == result["provisional_level"] and prof.weak_areas == result["weak_areas"],
          f"уровень/слабые стороны: сервис {result['provisional_level']} {result['weak_areas']}, правила "
          f"{prof.provisional_level} {prof.weak_areas}")
    return f"задания и профиль совпали с правилами ({len(log)} ответов)"


# =============================================================================================== уборка стенда


def cleanup_leftovers() -> list[str]:
    """Остатки прерванного прогона (процесс убит до finally шагов): опубликованные версии с маркером «[e2e …]» →
    откат к прежней опубликованной без маркера; открытые версии с маркером → вернуть в черновик и снять правку
    (тело = опубликованное); опубликованные `sc-e2e-*`/`m-e2e-*` → снять с публикации; открытые заявки e2e-учеников →
    rejected. Только dev-стенд: staff API catalog от имени admin-bff (ключ стенда), как cleanup scenario_admin."""
    done: list[str] = []
    if s1._psql("SELECT to_regclass('catalog.content_versions') IS NOT NULL") != "t":
        return done
    hdr = s2.staff_token("catalog", ALL_PERMS, str(uuid.uuid4()), "super_admin")
    reason = "e2e: уборка после прерванного прогона"

    def call(method: str, path: str, body: Any = None) -> dict[str, Any]:
        r = httpx.request(method, f"{CATALOG}{path}", json=body, headers={**hdr, **idem()}, timeout=20)
        check(r.status_code in (200, 201), f"уборка {method} {path}: {r.status_code} {r.text[:200]}")
        return r.json() if r.content else {}

    rows = pj("SELECT coalesce(json_agg(json_build_object('kind', cv.kind, 'key', cv.key, 'version', cv.version)), "
              "'[]') FROM catalog.content_versions cv JOIN catalog.content_pointers p ON p.kind = cv.kind "
              "AND p.key = cv.key AND p.published_version = cv.version "
              f"WHERE cv.payload->'title'->>'ru' LIKE '{MARK_LIKE}'") or []
    for r in rows:
        kind, key = r["kind"], safe_key(r["key"])
        check(kind in KINDS, kind)
        prev = s1._psql(f"SELECT max(version) FROM catalog.content_versions WHERE kind = '{kind}' AND key = '{key}' "
                        "AND status = 'archived' AND published_at IS NOT NULL "
                        f"AND payload->'title'->>'ru' NOT LIKE '{MARK_LIKE}'")
        if prev:
            call("POST", content_path(kind, key, tail="/rollback"), {"to_version": int(prev), "reason": reason})
            done.append(f"{kind}:{key}@{r['version']} → откат к v{prev}")
    rows = pj("SELECT coalesce(json_agg(json_build_object('kind', kind, 'key', key, 'version', version, "
              "'status', status)), '[]') FROM catalog.content_versions WHERE status IN ('draft', 'in_review') "
              f"AND payload->'title'->>'ru' LIKE '{MARK_LIKE}'") or []
    for r in rows:
        kind, key, v = r["kind"], safe_key(r["key"]), int(r["version"])
        check(kind in KINDS, kind)
        if r["status"] == "in_review":
            call("POST", content_path(kind, key, v, "/review"),
                 {"decision": "return", "note": reason, "locale_checks": {"ru": "draft", "uz": "draft"}})
        pub = published(kind).get(key)
        if pub is not None:
            cur = call("GET", content_path(kind, key, v))
            call("PUT", content_path(kind, key, v), {"payload": pub, "expected_hash": cur["payload_hash"]})
            done.append(f"{kind}:{key}@{v}: черновик без правки сценария")
    for kind, prefix in (("scenario", "sc-e2e-"), ("media_asset", "m-e2e-")):
        for key in sorted(published(kind)):
            if key.startswith(prefix):
                call("POST", content_path(kind, safe_key(key), tail="/archive"), {"reason": reason})
                done.append(f"{kind}:{key}: снят с публикации")
    reqs = pj("SELECT coalesce(json_agg(request_id), '[]') FROM catalog.media_requests "
              "WHERE title LIKE 'e2e %' AND status IN ('new', 'in_review')") or []
    for rid in reqs:
        call("POST", f"/admin/v1/content/media-requests/{s1.uid(rid)}/decide",
             {"status": "rejected", "note": "e2e: тестовая заявка (уборка)"})
    if reqs:
        done.append(f"заявки e2e: {len(reqs)} → rejected")
    return done


# =============================================================================================== шаги


def s_stand(c: s2.Ctx) -> None:
    for name, url in [("catalog", f"{CATALOG}/health/ready"), ("diagnostics", f"{DIAGNOSTICS}/health/ready"),
                      ("learning-plan", f"{s1.LEARNING_PLAN}/health/ready"), ("admin-bff", f"{c.bff}/health/ready"),
                      ("admin-identity", f"{s2.ADMIN_IDENTITY}/health/ready"), ("telegram-bff", f"{TG_BFF}/health/ready"),
                      ("notifications", f"{s1.NOTIFICATIONS}/health/ready"), ("audit", f"{s1.AUDIT}/health/ready"),
                      ("identity-consent", f"{s1.IDENTITY}/health/ready"), ("mock-telegram", f"{s1.MOCK_TG}/health")]:
        r = httpx.get(url, timeout=5)
        check(r.status_code == 200, f"{name} не ready: {r.status_code} {r.text[:200]}")
    # маршруты спринта 3 есть (без сессии — 401, а не 404 «маршрут не найден»)
    missing = []
    for path in ("/v1/languages", "/v1/diagnostics/state", "/v1/plan/trajectory", "/v1/scenarios", "/v1/media",
                 "/v1/skills/map", "/v1/media/requests"):
        r = httpx.get(f"{TG_BFF}{path}", timeout=5)
        if r.status_code != 401:
            missing.append(f"telegram-bff GET {path} → {r.status_code}")
    for path in ("/admin/v1/content/summary", "/admin/v1/content/lesson", "/admin/v1/language-pairs",
                 "/admin/v1/diagnostics/tests", "/admin/v1/content/media-requests"):
        r = httpx.get(f"{c.bff}{path}", timeout=5)
        if r.status_code != 401:
            missing.append(f"admin-bff GET {path} → {r.status_code}")
    check(not missing, f"маршруты спринта 3 не готовы: {missing}")
    # сид контента и тестов диагностики загружен миграциями
    counts = pj("SELECT json_build_object('lesson', count(*) FILTER (WHERE kind = 'lesson'), "
                "'skill', count(*) FILTER (WHERE kind = 'skill'), 'scenario', count(*) FILTER (WHERE kind = 'scenario'), "
                "'media_asset', count(*) FILTER (WHERE kind = 'media_asset')) FROM catalog.content_pointers "
                "WHERE published_version IS NOT NULL")
    check(counts["lesson"] >= 24 and counts["skill"] >= 40 and counts["scenario"] >= 20 and counts["media_asset"] >= 8,
          f"сид контента: {counts}")
    tests = s1._psql("SELECT string_agg(test_id || '@' || version, ',' ORDER BY test_id) FROM diagnostics.tests "
                     "WHERE status = 'published'")
    check("dx-en-adult@1" in tests and "dx-en-kids@1" in tests, f"опубликованные тесты диагностики: {tests}")
    c.data["dlq_before"] = s1.dlq_counts()
    for line in cleanup_leftovers():
        print(f"      уборка: {line}", flush=True)
    c.data["policy"] = expect(httpx.get(f"{TG_BFF}/v1/legal/policy", params={"lang": "ru"}), 200)
    c.lc.data["policy"] = c.data["policy"]


# ---------------------------------------------------------------- сотрудники


def _create(c: s2.Ctx, who: str, role: str, name: str, privileged: bool) -> None:
    b = c.staff["root"].browser
    body = {"email": f"{who}.{c.tag.lower()}@tilhero.local", "display_name": f"{name} {c.tag}", "role": role}
    created = expect(b.post("/admin/v1/staff", body, headers=idem()), 201)
    tmp = str(created.get("temporary_password") or "")
    check(len(tmp) >= 16, f"{role}: временный пароль не выдан")
    c.remember(f"временный пароль {who}", tmp)
    appr = created.get("approval")
    if privileged:
        check(appr and appr.get("kind") == "staff.create_privileged" and appr.get("waived") == "single_super_admin"
              and appr.get("status") == "APPLIED", f"four-eyes {role} (привилегированная по праву со step-up): {appr}")
    else:
        check(appr is None, f"{role}: four-eyes у непривилегированной роли: {appr}")
    check(created["staff"]["role"] == role, created["staff"])
    c.staff[who] = Staff(c.browser(who), body["email"], tmp, body["display_name"], created["staff"]["staff_id"])


def warm_admin_identity(c: s2.Ctx) -> None:
    """admin-identity сразу после старта (reset_admin перезапускает его, up — соседние сервисы) считает хеш пароля дольше
    таймаута admin-bff (UPSTREAM_TIMEOUT_MS 3 с): смена пароля — это проверка прежнего и хеш нового, под нагрузкой
    стенда она шла 3,3 с → 503, хотя пароль уже сменён (bootstrap-учётка израсходована, прогон надо повторять со
    сбросом). Прогрев: вход несуществующей учёткой (тот же расчёт dummy-хеша) — до трёх ответов подряд быстрее 0,6 с
    (нагрузка после запуска сервисов спала), не дольше 120 с."""
    b = c.browser("warmup")
    deadline = time.monotonic() + 120
    fast = n = 0
    dt = 0.0
    while time.monotonic() < deadline:
        t0 = time.monotonic()
        n += 1  # свой email на каждую попытку: лимит входа по email (prod-значение) не должен сработать
        r = b.post("/admin/v1/auth/login", {"email": f"warmup.{c.tag.lower()}.{n}@tilhero.local",
                                            "password": "Warmup-e2e-not-a-password-0"})
        dt = time.monotonic() - t0
        fast = fast + 1 if r.status_code == 401 and dt < 0.6 else 0
        if fast >= 3:
            return
        time.sleep(1 if fast else 3)
    print(f"      admin-identity медленно считает хеш ({dt:.1f} с, ответ {r.status_code}) — возможен 503 на смене "
          "пароля", flush=True)


def s_staff(c: s2.Ctx) -> None:
    warm_admin_identity(c)
    root = Staff(c.browser("root"), s2.BOOT_EMAIL, s2.BOOT_PASSWORD, display_name="Администратор")
    c.staff["root"] = root
    c.remember("пароль bootstrap", s2.BOOT_PASSWORD)
    r = root.browser.post("/admin/v1/auth/login", {"email": s2.BOOT_EMAIL, "password": s2.BOOT_PASSWORD})
    if r.status_code == 401:
        raise StepFailed("bootstrap-учётка уже использована (пароль сменён прошлым сценарием) — запускайте "
                         "`run_local.sh content` (сбрасывает учётки admin-identity) или добавьте reset_admin перед "
                         "scenario_content в `run_local.sh test`")
    me = s2.login(c, root, expect_next=["password_change", "mfa_enroll", "done"])
    check(me["staff"]["role"] == "super_admin", me["staff"])
    check(set(me["permissions"]) == ALL_PERMS, f"права super_admin: {sorted(set(me['permissions']) ^ ALL_PERMS)}")
    # права и роли спринта 3 в матрице (admin-identity 0003): methodist и content_manager — привилегированные
    roles = {x["code"]: x for x in expect(root.browser.get("/admin/v1/roles"), 200)["items"]}
    check(set(roles.get("methodist", {}).get("permissions", [])) == METHODIST_PERMS
          and set(roles.get("content_manager", {}).get("permissions", [])) == CM_PERMS
          and set(roles.get("analyst", {}).get("permissions", [])) == ANALYST_PERMS,
          f"матрица: methodist {roles.get('methodist', {}).get('permissions')}, content_manager "
          f"{roles.get('content_manager', {}).get('permissions')}, analyst {roles.get('analyst', {}).get('permissions')}")
    check(roles["methodist"]["privileged"] is True and roles["content_manager"]["privileged"] is True
          and roles["analyst"]["privileged"] is False, "привилегированность ролей спринта 3")
    body = expect(root.browser.post("/admin/v1/staff", {"email": f"x.{c.tag.lower()}@tilhero.local",
                                                        "display_name": "x", "role": "methodist"},
                                    headers=idem()), 403, "STEP_UP_REQUIRED")
    check(body["details"].get("permission") == "staff.manage", body)
    s2.step_up(root)
    _create(c, "m1", "methodist", "Мадина Методист", True)
    _create(c, "m2", "methodist", "Мурод Методист", True)
    _create(c, "cm", "content_manager", "Камола Контент", True)
    _create(c, "an", "analyst", "Анвар Аналитик", False)


def s_staff_login(c: s2.Ctx) -> None:
    for who, perms in (("m1", METHODIST_PERMS), ("m2", METHODIST_PERMS), ("cm", CM_PERMS)):
        st = c.staff[who]
        me = s2.login(c, st, expect_next=["password_change", "mfa_enroll", "done"])
        check(me["mfa_enabled"] is True and set(me["permissions"]) == perms,
              f"{who}: mfa={me['mfa_enabled']} права {sorted(me['permissions'])}")
    an = c.staff["an"]
    me = s2.login(c, an, expect_next=["password_change", "done"])
    check(set(me["permissions"]) == ANALYST_PERMS, f"analyst: {sorted(me['permissions'])}")


# ---------------------------------------------------------------- ученики


def s_learners(c: s2.Ctx) -> None:
    lc = c.lc
    z = lc.data["zone_day"]
    l0 = lc.user("L0", "Лола")  # без диагностики: план от начала курса, видит правку урока
    s1.onboard(l0, zone=z)
    ld = lc.user("LD", "Достон")  # взрослый: диагностика, план, заявка на песню
    s1.onboard(ld, zone=z)
    p = lc.user("P", "Парвина")  # родитель + детский профиль 6–9
    s1.onboard(p, zone=z)
    kid_name = f"Камрон {c.tag}K"
    kid = p.ok("POST", "/v1/learners", 201, json={"display_name": kid_name, "age_band": "6-9"}, idem=True)
    c.data.update(kid=kid["learner_id"], kid_name=kid_name)
    p.switch(kid["learner_id"])
    check(p.session["learner"]["kind"] == "child", p.session["learner"])
    s1.plan_patch(p, {"goal": "study", "level_self": "zero", "schedule": {
        "preset": "daily", "preferred_time": "17:00", "duration_min": 15, "reminders_enabled": False, "timezone": z}})
    p.ok("POST", "/v1/plan/onboarding/complete")
    p.switch(p.account_id)
    lx = lc.user("LX", "Хуршид")  # удаляется (сага): диагностика, навыки, заявки
    s1.onboard(lx, zone=z)
    for u in (l0, ld, lx):
        check(u.ok("GET", "/v1/plan")["onboarding_completed_at"], f"{u.role}: онбординг не завершён")


# ---------------------------------------------------------------- AT-31 языки ученика


def s_languages_learner(c: s2.Ctx) -> None:
    ld = c.lc.users["LD"]
    langs = ld.ok("GET", "/v1/languages")
    check(langs["active_pair_id"] == PAIR, langs)
    pairs = {x["pair_id"]: x for x in langs["pairs"]}
    check(pairs.get(PAIR, {}).get("available") is True and pairs[PAIR]["status"] == "published", pairs.get(PAIR))
    check(langs["pairs"][0]["pair_id"] == PAIR, f"активная пара первой: {[x['pair_id'] for x in langs['pairs']]}")
    soon = [x for x in langs["pairs"] if x["pair_id"] != PAIR]
    check(soon and all(x["available"] is False and x["status"] != "published" for x in soon),
          f"остальные пары — «скоро»: {soon}")
    check("ru-uz" in pairs and pairs["ru-uz"]["status"] == "planned", pairs.get("ru-uz"))
    check(all(x["title"]["ru"].strip() and x["title"]["uz"].strip() for x in langs["pairs"]), "названия пар RU/UZ")
    # «скоро» не запускается: ни диагностика, ни её состояние
    body = ld.ok("POST", "/v1/diagnostics/sessions", 409, "PAIR_NOT_AVAILABLE", json={"pair_id": "ru-uz"}, idem=True)
    check(body["details"].get("pair_id") == "ru-uz", body)
    ld.ok("GET", "/v1/diagnostics/state", 409, "PAIR_NOT_AVAILABLE", params={"pair_id": "ru-uz"})
    ld.ok("GET", "/v1/plan/trajectory", 409, "PAIR_NOT_AVAILABLE", params={"pair_id": "ru-uz"})


# ---------------------------------------------------------------- AT-26/27 урок: версии, проверка, публикация, откат


def _l0_next(c: s2.Ctx) -> dict[str, Any]:
    return c.lc.users["L0"].ok("GET", "/v1/plan/trajectory")


def _restore_lesson(c: s2.Ctx, key: str, orig_v: int) -> None:
    """finally шага урока: указатель — снова на исходной версии (откат через admin-bff)."""
    m1 = c.staff["m1"]
    d = detail(m1.browser, "lesson", key)
    if d["row"]["published_version"] != orig_v:
        s2.ensure_step_up(m1)
        expect(m1.browser.post(content_path("lesson", key, tail="/rollback"),
                               {"to_version": orig_v, "reason": "e2e: возврат урока после сбоя шага"},
                               headers=idem()), 200)
        print(f"      finally: урок {key} откатан к v{orig_v}", flush=True)
    left = [v["version"] for v in d["versions"] if v["status"] in ("draft", "in_review")]
    if left:
        print(f"      finally: у урока {key} осталась открытая версия {left} — уберёт C00/--cleanup", flush=True)


def s_lesson(c: s2.Ctx) -> None:
    m1, m2, cm, an = (c.staff[k] for k in ("m1", "m2", "cm", "an"))
    b = m1.browser
    mark = mark_of(c)
    t0 = _l0_next(c)
    nx = t0["next"]
    check(nx and t0["basis"]["diagnostic_result_id"] is None and "no_diagnostic" in nx["reason_codes"],
          f"ученик без диагностики: следующий {nx and nx['lesson_id']} {nx and nx['reason_codes']}")
    key = safe_key(nx["lesson_id"])
    orig_title = nx["title"]["ru"]
    d0 = detail(b, "lesson", key)
    orig_v = d0["row"]["published_version"]
    check(isinstance(orig_v, int) and mark not in orig_title, f"урок {key}: {d0['row']}")
    c.data["lesson"] = (key, orig_v)
    try:
        base = expect(b.get(content_path("lesson", key, orig_v)), 200)
        check(base["status"] == "published" and "answer" in json.dumps(base["payload"]["control_items"]),
              "админка видит опубликованное тело с ключами контрольных заданий")
        r = b.post(content_path("lesson", key, tail="/versions"), {"from_version": orig_v}, headers=idem())
        if r.status_code == 409 and (r.json().get("code") == "DRAFT_EXISTS"):
            v = int(r.json()["details"]["version"])
            cur = expect(b.get(content_path("lesson", key, v)), 200)
            if cur["status"] == "in_review":
                expect(m2.browser.post(content_path("lesson", key, v, "/review"),
                                       {"decision": "return", "note": "e2e: возврат остатка прошлого прогона",
                                        "locale_checks": {"ru": "draft", "uz": "draft"}}), 200)
            print(f"      открытая версия v{v} прошлого прогона принята как черновик", flush=True)
        else:
            created = expect(r, 201)
            v = created["version"]
            check(created["status"] == "draft" and created["author_id"] == m1.staff_id
                  and created["author_name"] == m1.display_name, f"черновик: {created['status']} {created['author_name']}")
        c.data["lesson_v"] = v
        expect(b.post(content_path("lesson", key, tail="/versions"), {"from_version": orig_v}, headers=idem()), 409,
               "DRAFT_EXISTS")
        cur = expect(b.get(content_path("lesson", key, v)), 200)
        # AT-27: пустая локализация UZ и урок без трёх контрольных заданий → submit 422 с путями полей
        bad = copy.deepcopy(base["payload"])
        bad["title"] = {"ru": f"{base['payload']['title']['ru']} {mark}", "uz": ""}
        bad["control_items"] = base["payload"]["control_items"][:2]
        upd = put_version(b, "lesson", key, v, bad, cur["payload_hash"])
        check(upd["status"] == "draft" and upd["locale_checks"]["uz"] == "missing", upd["locale_checks"])
        body = expect(b.post(content_path("lesson", key, v, "/submit")), 422, "CONTENT_INVALID")
        errs = errors_of(body)
        check(("payload.title.uz", "LOCALE_MISSING") in errs and ("payload.control_items", "NO_CONTROL_ITEMS") in errs,
              f"ошибки отправки: {errs}")
        check(all(e.get("message") for e in body["details"]["errors"]), "у ошибок нет message")
        # правка по устаревшему хешу — 409
        put_version(b, "lesson", key, v, base["payload"], cur["payload_hash"], 409, "VERSION_CONFLICT")
        good = copy.deepcopy(base["payload"])
        good["title"] = {"ru": f"{base['payload']['title']['ru']} {mark}", "uz": f"{base['payload']['title']['uz']} {mark}"}
        upd = put_version(b, "lesson", key, v, good, upd["payload_hash"])
        sub = expect(b.post(content_path("lesson", key, v, "/submit")), 200)
        check(sub["status"] == "in_review" and sub["submitted_at"], sub["status"])
        # AT-26: автор не проверяет свою версию; проверка — с отметками RU/UZ
        expect(b.post(content_path("lesson", key, v, "/review"), review_ok()), 409, "SELF_REVIEW")
        q = expect(m2.browser.get("/admin/v1/content/review-queue", params={"kind": "lesson"}), 200)["items"]
        check(any(x["key"] == key and x["latest_status"] == "in_review" for x in q), "версии нет в очереди проверки M2")
        q1 = expect(b.get("/admin/v1/content/review-queue", params={"kind": "lesson"}), 200)["items"]
        check(not any(x["key"] == key for x in q1), "своя версия в очереди проверки автора")
        expect(m2.browser.post(content_path("lesson", key, v, "/review"),
                               {"decision": "approve", "note": "e2e: UZ не вычитан",
                                "locale_checks": {"ru": "checked", "uz": "draft"}}), 422)
        rv = expect(m2.browser.post(content_path("lesson", key, v, "/review"), review_ok()), 200)
        check(rv["status"] == "approved" and rv["reviewer_id"] == m2.staff_id and rv["reviewer_name"] == m2.display_name
              and rv["locale_checks"] == {"ru": "checked", "uz": "checked"}, f"проверка: {rv['status']} {rv['reviewer_name']}")
        # RBAC: публикация — только content.publish; без step-up — 403 STEP_UP_REQUIRED
        bad_rbac = [x for x in (
            rbac_denied(cm.browser, "POST", content_path("lesson", key, v, "/publish"), {"reason": "e2e: попытка"},
                        "content.publish"),
            rbac_denied(an.browser, "POST", content_path("lesson", key, v, "/publish"), {"reason": "e2e: попытка"},
                        "content.publish"),
            rbac_denied(cm.browser, "POST", content_path("lesson", key, v, "/review"), review_ok(), "content.review"),
        ) if x]
        check(not bad_rbac, "; ".join(bad_rbac))
        body = expect(b.post(content_path("lesson", key, v, "/publish"), {"reason": "e2e: публикация правки"},
                             headers=idem()), 403, "STEP_UP_REQUIRED")
        check(body["details"].get("permission") == "content.publish", body)
        s2.step_up(m1)
        key_pub = idem()
        pub = expect(b.post(content_path("lesson", key, v, "/publish"), {"reason": "e2e: публикация правки"},
                            headers=key_pub), 200)
        check(pub["status"] == "published" and pub["published_by"] == m1.staff_id
              and pub["published_by_name"] == m1.display_name, f"публикация: {pub['status']} {pub['published_by_name']}")
        rep = b.post(content_path("lesson", key, v, "/publish"), {"reason": "e2e: публикация правки"}, headers=key_pub)
        check(rep.status_code == 200 and rep.json()["status"] == "published", f"повтор публикации: {rep.status_code}")
        d1 = detail(b, "lesson", key)
        check(d1["row"]["published_version"] == v and version_meta(d1, orig_v)["status"] == "archived",
              f"после публикации: {d1['row']}")
        # ученик видит новую версию в плане; прежняя ревизия плана ссылается на свою версию урока
        t1 = wait_for(lambda: (t := _l0_next(c)) and mark in ((t.get("next") or {}).get("title") or {}).get("ru", "")
                      and t, 40, what="новая версия урока в плане ученика (catalog.version.published.v1 → learning-plan)")
        check(t1["revision"] > t0["revision"], f"ревизия плана {t0['revision']} → {t1['revision']}")
        l0_id = s1.uid(c.lc.users["L0"].account_id)
        old = s1._psql(f"SELECT items::text FROM learning_plan.trajectories WHERE user_id = '{l0_id}' "
                       f"AND revision = {int(t0['revision'])}")
        check(orig_title in old and mark not in old, "прежняя ревизия плана изменилась после публикации")
        # откат: публикуется прежняя версия, текущая — в архив
        expect(b.post(content_path("lesson", key, tail="/rollback"), {"to_version": v, "reason": "e2e: откат"},
                      headers=idem()), 409, "ROLLBACK_TARGET_INVALID")
        s2.ensure_step_up(m1)
        rb = expect(b.post(content_path("lesson", key, tail="/rollback"),
                           {"to_version": orig_v, "reason": "e2e: откат к прежней версии"}, headers=idem()), 200)
        check(rb["version"] == orig_v and rb["status"] == "published", f"откат: v{rb['version']} {rb['status']}")
        d2 = detail(b, "lesson", key)
        check(d2["row"]["published_version"] == orig_v and version_meta(d2, v)["status"] == "archived", d2["row"])
        c.data["lesson_rolled_back"] = True
        wait_for(lambda: (t := _l0_next(c)) and (t.get("next") or {}).get("title", {}).get("ru") == orig_title,
                 40, what="план ученика после отката — прежний заголовок урока")
        # неизменяемость: API правит только черновик; триггер БД — даже роли-владельцу схемы
        put_version(b, "lesson", key, orig_v, good, base["payload_hash"], 409, "VERSION_NOT_DRAFT")
        put_version(b, "lesson", key, v, good, upd["payload_hash"], 409, "VERSION_NOT_DRAFT")
        res = psql_try("BEGIN; UPDATE catalog.content_versions SET payload = jsonb_set(payload, '{title,ru}', "
                       f"'\"e2e immutable\"') WHERE kind = 'lesson' AND key = '{key}' AND version = {int(orig_v)}; "
                       "ROLLBACK;", user="catalog_owner")
        check(res.returncode != 0 and "immutable" in res.stderr,
              f"UPDATE опубликованной версии под catalog_owner не отклонён триггером: rc={res.returncode} "
              f"{(res.stdout + res.stderr)[:300]}")
        res = psql_try("BEGIN; UPDATE catalog.content_versions SET status = 'draft' WHERE kind = 'lesson' "
                       f"AND key = '{key}' AND version = {int(v)}; ROLLBACK;", user="catalog_owner")
        check(res.returncode != 0 and "not allowed" in res.stderr,
              f"переход archived → draft не отклонён: rc={res.returncode} {(res.stdout + res.stderr)[:300]}")
        # снять с публикации навык, на который ссылаются опубликованные уроки, нельзя (409 CONTENT_IN_USE {refs})
        skill = safe_key(base["payload"]["primary_skill_id"])
        s2.ensure_step_up(m1)
        r = b.post(content_path("skill", skill, tail="/archive"), {"reason": "e2e: проверка зависимостей"},
                   headers=idem())
        if r.status_code == 200:  # дефект: навык снят — вернуть его до сбоя шага
            prev = detail(b, "skill", skill)["versions"][0]["version"]
            b.post(content_path("skill", skill, tail="/rollback"), {"to_version": prev, "reason": "e2e: возврат"},
                   headers=idem())
        body = expect(r, 409, "CONTENT_IN_USE")
        refs = body["details"].get("refs") or []
        check({"kind": "lesson", "key": key} in refs, f"CONTENT_IN_USE refs: {refs[:5]}")
    finally:
        try:
            _restore_lesson(c, key, orig_v)
        except Exception as exc:  # уборка не маскирует причину сбоя шага
            print(f"      finally урока: {exc}", flush=True)


# ---------------------------------------------------------------- AT-28 сценарий: тестовый прогон и публикация


def _scenario_payload(key: str, mark: str, *, fixed: bool) -> dict[str, Any]:
    def loc(ru: str, uz: str) -> dict[str, str]:
        return {"ru": ru, "uz": uz}

    def tr(intent: str, ru: str, uz: str, ex: str, to: str) -> dict[str, Any]:
        return {"intent": intent, "description": loc(ru, uz), "examples_en": [ex], "to": to}

    def node(line: str, ru: str, uz: str, transitions: list[dict[str, Any]], *, rp: bool = False,
             end: dict[str, Any] | None = None) -> dict[str, Any]:
        return {"speaker": "anna", "line_en": line, "gloss": loc(ru, uz), "hint": None, "recovery_point": rp,
                "event": None, "transitions": transitions, "end": end}

    offer = [tr("accept", "Согласитесь", "Rozi boʻling", "Yes, please.", "done_ok"),
             tr("decline", "Вежливо откажитесь", "Xushmuomalalik bilan rad eting", "No, thank you.", "done_alt")]
    if fixed:
        offer.append(tr("other", "Ответьте невпопад", "Mavzudan tashqari javob bering", "I like cats.", "orphan"))
    return {
        "scenario_id": key, "title": loc(f"Знакомство в кафе {mark}", f"Kafeda tanishuv {mark}"),
        "task": loc("Поздоровайтесь и ответьте на предложение.", "Salomlashing va taklifga javob bering."),
        "goals": ["daily"], "topics": ["small_talk"], "level": "A1", "difficulty": 1, "audience": ["adults"],
        "access": "free",
        "characters": [{"id": "anna", "name": "Anna", "role": loc("Официантка", "Ofitsiant"), "voice": "en-GB"}],
        "start_node": "start",
        "nodes": {
            "start": node("Hello! Welcome to our cafe.", "Здравствуйте! Добро пожаловать.", "Salom! Xush kelibsiz.",
                          [tr("greet", "Поздоровайтесь", "Salomlashing", "Hello!", "ask")], rp=True),
            "ask": node("What is your name?", "Как вас зовут?", "Ismingiz nima?",
                        [tr("introduce", "Назовите имя", "Ismingizni ayting", "My name is Lola.", "offer")]),
            "offer": node("Would you like some tea?", "Хотите чаю?", "Choy ichasizmi?", offer),
            "done_ok": node("Here you are!", "Пожалуйста!", "Marhamat!", [],
                            end={"outcome": "success", "summary": loc("Вы заказали чай.", "Siz choy buyurtma qildingiz.")}),
            "done_alt": node("No problem!", "Ничего страшного!", "Hechqisi yoʻq!", [],
                             end={"outcome": "alt_success", "summary": loc("Вы вежливо отказались.",
                                                                           "Siz xushmuomalalik bilan rad etdingiz.")}),
            "orphan": node("Sorry, I don't understand.", "Простите, не понимаю.", "Kechirasiz, tushunmadim.", [],
                           end={"outcome": "fail", "summary": loc("Разговор не получился.", "Suhbat chiqmadi.")}),
        },
        "completion": {"criteria": loc("Ответить на предложение официантки.", "Ofitsiantning taklifiga javob berish.")},
        "skill_ids": ["en.func.greet"], "rubric_id": "r-roleplay",
    }


def s_scenario(c: s2.Ctx) -> None:
    m1, m2 = c.staff["m1"], c.staff["m2"]
    b = m1.browser
    key = f"sc-e2e-{c.tag.lower()}"
    c.data["scenario"] = key
    mark = mark_of(c)
    l0 = c.lc.users["L0"]
    try:
        created = expect(b.post("/admin/v1/content/scenario", {"payload": _scenario_payload(key, mark, fixed=False)},
                                headers=idem()), 201)
        check(created["version"] == 1 and created["status"] == "draft" and created["test_run"] is None, created["status"])
        run = expect(b.post(content_path("scenario", key, 1, "/test-run")), 200)
        codes = {(i["code"], i["node_id"]) for i in run["issues"]}
        check(run["ok"] is False and ("UNREACHABLE_NODE", "orphan") in codes, f"прогон с недостижимым узлом: {run}")
        check(run["stats"]["nodes"] == 6 and run["stats"]["ends"] == {"success": 1, "alt_success": 1, "fail": 1},
              run["stats"])
        val = expect(b.post(content_path("scenario", key, 1, "/validate")), 200)
        vc = {e["code"] for e in val["errors"]}
        check(val["ok"] is False and {"UNREACHABLE_NODE", "SCENARIO_TEST_FAILED"} <= vc, f"сухая проверка: {vc}")
        body = expect(b.post(content_path("scenario", key, 1, "/submit")), 422, "CONTENT_INVALID")
        check(("payload.nodes.orphan", "UNREACHABLE_NODE") in errors_of(body), errors_of(body))
        cur = expect(b.get(content_path("scenario", key, 1)), 200)
        put_version(b, "scenario", key, 1, _scenario_payload(key, mark, fixed=True), cur["payload_hash"])
        cur = expect(b.get(content_path("scenario", key, 1)), 200)
        check(cur["test_run"] is None, "прогон по прежнему телу не устарел после правки")
        expect(b.post(content_path("scenario", key, 1, "/submit")), 200)
        expect(b.post(content_path("scenario", key, 1, "/review"), review_ok()), 409, "SELF_REVIEW")
        expect(m2.browser.post(content_path("scenario", key, 1, "/review"), review_ok()), 200)
        # без зелёного прогона этой версии публикация невозможна
        s2.ensure_step_up(m1)
        body = expect(b.post(content_path("scenario", key, 1, "/publish"), {"reason": "e2e: без прогона"},
                             headers=idem()), 422, "CONTENT_INVALID")
        check(("test_run", "SCENARIO_TEST_FAILED") in errors_of(body), errors_of(body))
        run = expect(b.post(content_path("scenario", key, 1, "/test-run")), 200)
        check(run["ok"] is True and not run["issues"] and run["stats"]["paths_to_success"] >= 1, run)
        got = expect(b.get(content_path("scenario", key, 1)), 200)
        check((got["test_run"] or {}).get("ok") is True, f"прогон в версии: {got['test_run']}")
        pub = expect(b.post(content_path("scenario", key, 1, "/publish"), {"reason": "e2e: сценарий с прогоном"},
                            headers=idem()), 200)
        check(pub["status"] == "published", pub["status"])
        c.data["scenario_published"] = True
        # ученик (взрослый) видит сценарий: карточка без графа, фильтр цели
        dd = l0.ok("GET", f"/v1/scenarios/{key}")
        check(dd["opening"]["line_en"] == "Hello! Welcome to our cafe." and "nodes" not in dd and mark in dd["title"]["ru"]
              and {o["outcome"] for o in dd["outcomes"]} >= {"success"}, f"карточка сценария: {str(dd)[:300]}")
        lst = l0.ok("GET", "/v1/scenarios", params={"goal": "daily", "level": "A1", "limit": 100})["items"]
        check(key in [x["scenario_id"] for x in lst], "сценарий не виден в каталоге ученика")
    finally:
        try:
            d = detail(b, "scenario", key)
            if d["row"]["published_version"] is not None:
                s2.ensure_step_up(m1)
                arch = expect(b.post(content_path("scenario", key, tail="/archive"), {"reason": "e2e: уборка сценария"},
                                     headers=idem()), 200)
                check(arch["row"]["published_version"] is None, arch)
                c.data["scenario_archived"] = True
        except Exception as exc:
            print(f"      finally сценария: {exc}", flush=True)
    l0.ok("GET", f"/v1/scenarios/{key}", 404, "SCENARIO_NOT_FOUND")


# ---------------------------------------------------------------- AT-29 медиа: права, публикация, истечение


def _media_payload(key: str, mark: str, blob_id: str, today: date, territories: list[str]) -> dict[str, Any]:
    def gl(ru: str, uz: str) -> dict[str, str]:
        return {"ru": ru, "uz": uz}

    return {
        "asset_id": key, "type": "own_scene", "origin": "own_recording",
        "title": gl(f"Сценка «Привет в кафе» {mark}", f"«Kafeda salom» sahnasi {mark}"), "original_title": None,
        "language": "en", "level": "A1", "topics": ["small_talk"], "skill_ids": ["en.func.greet"],
        "audience": ["adults"], "duration_s": 12,
        "transcript": [
            {"t_start_ms": 500, "t_end_ms": 3500, "speaker": "Anna", "text_en": "Hello! Nice to see you.",
             "gloss": gl("Привет! Рада тебя видеть.", "Salom! Seni koʻrganimdan xursandman.")},
            {"t_start_ms": 4000, "t_end_ms": 7000, "speaker": "Tom", "text_en": "Hi, Anna! How are you?",
             "gloss": gl("Привет, Анна! Как дела?", "Salom, Anna! Ishlaring qalay?")},
        ],
        "phrases": [{"en": "Nice to see you", "gloss": gl("Рада тебя видеть", "Seni koʻrganimdan xursandman"),
                     "t_ms": 500}],
        "audio_blob_id": blob_id, "embed": None,
        "rights": {"owner": "TilHero", "license_type": "own", "license_ref": None, "attribution": None,
                   "territories": territories, "valid_from": (today - timedelta(days=1)).isoformat(),
                   "valid_to": (today + timedelta(days=7)).isoformat(),
                   "allowed_uses": ["listen", "show_transcript", "dictionary"]},
    }


def s_media(c: s2.Ctx) -> None:
    m1, cm = c.staff["m1"], c.staff["cm"]
    l0, p = c.lc.users["L0"], c.lc.users["P"]
    key = f"m-e2e-{c.tag.lower()}"
    c.data["media"] = key
    mark = mark_of(c)
    today = date.fromisoformat(tick()["today"])  # «сегодня» по Ташкенту — как считает catalog
    check(abs((today - tashkent_today()).days) <= 1, f"today catalog {today}")
    cb = cm.browser
    try:
        # аудио авторской сценки: сигнатура проверяется, одинаковый файл не дублируется
        bad = expect(cb.post("/admin/v1/content/blobs", {"filename": "x.mp3", "content_type": "audio/mpeg",
                                                         "data_base64": base64.b64encode(b"not an audio").decode()}),
                     422, "AUDIO_INVALID")
        check(bad["details"].get("reason") == "signature", bad)
        up = {"filename": "e2e-hello.mp3", "content_type": "audio/mpeg",
              "data_base64": base64.b64encode(AUDIO_BYTES).decode()}
        r1 = cb.post("/admin/v1/content/blobs", up)
        check(r1.status_code in (200, 201), f"загрузка аудио: {r1.status_code} {r1.text[:200]}")
        blob = r1.json()
        r2 = expect(cb.post("/admin/v1/content/blobs", up), 200)
        check(r2["blob_id"] == blob["blob_id"] and blob["size"] == len(AUDIO_BYTES), f"дубль аудио: {r2} / {blob}")
        # без территории UZ — права не подтвердить и не отправить на проверку
        created = expect(cb.post("/admin/v1/content/media_asset",
                                 {"payload": _media_payload(key, mark, blob["blob_id"], today, ["KZ"])},
                                 headers=idem()), 201)
        check(created["status"] == "draft" and created["rights_approved_at"] is None, created["status"])
        body = expect(cb.post(content_path("media_asset", key, 1, "/submit")), 422, "CONTENT_INVALID")
        check(("payload.rights.territories", "RIGHTS_REQUIRED") in errors_of(body), errors_of(body))
        denied = rbac_denied(m1.browser, "POST", content_path("media_asset", key, 1, "/rights-approve"),
                             {"note": "e2e: попытка методиста"}, "media.rights")
        check(denied is None, denied)
        body = expect(cb.post(content_path("media_asset", key, 1, "/rights-approve"), {"note": "e2e: права проверены"},
                              headers=idem()), 403, "STEP_UP_REQUIRED")
        check(body["details"].get("permission") == "media.rights", body)
        s2.step_up(cm)
        body = expect(cb.post(content_path("media_asset", key, 1, "/rights-approve"), {"note": "e2e: права проверены"},
                              headers=idem()), 422, "CONTENT_INVALID")
        check(("payload.rights.territories", "RIGHTS_REQUIRED") in errors_of(body), errors_of(body))
        cur = expect(cb.get(content_path("media_asset", key, 1)), 200)
        put_version(cb, "media_asset", key, 1, _media_payload(key, mark, blob["blob_id"], today, ["UZ", "KZ"]),
                    cur["payload_hash"])
        ra = expect(cb.post(content_path("media_asset", key, 1, "/rights-approve"), {"note": "e2e: права проверены"},
                            headers=idem()), 200)
        check(ra["rights_approved_by"] == cm.staff_id and ra["rights_approved_by_name"] == cm.display_name
              and ra["rights_approved_at"], f"подтверждение прав: {ra['rights_approved_by_name']}")
        expect(cb.post(content_path("media_asset", key, 1, "/submit")), 200)
        expect(m1.browser.post(content_path("media_asset", key, 1, "/review"), review_ok()), 200)
        denied = rbac_denied(cb, "POST", content_path("media_asset", key, 1, "/publish"), {"reason": "e2e: попытка"},
                             "content.publish")
        check(denied is None, denied)
        s2.ensure_step_up(m1)
        pub = expect(m1.browser.post(content_path("media_asset", key, 1, "/publish"), {"reason": "e2e: медиа"},
                                     headers=idem()), 200)
        check(pub["status"] == "published", pub["status"])
        c.data["media_published"] = True
        # ученик: в медиатеке, карточка с источником и транскриптом, аудио — прокси с кешем
        cards = l0.ok("GET", "/v1/media", params={"limit": 100})["items"]
        card = next((x for x in cards if x["asset_id"] == key), None)
        check(card and card["has_audio"] is True and card["source_label"] == "TilHero" and card["type"] == "own_scene",
              f"карточка медиа ученика: {card}")
        md = l0.ok("GET", f"/v1/media/{key}")
        check(md["attribution"] is None and len(md["transcript"] or []) == 2 and md["voices"] == {"Anna": "en-GB",
              "Tom": "en-US"} and md["phrases"], f"медиа ученика: {str(md)[:300]}")
        ra_ = l0.req("GET", f"/v1/media/{key}/audio")
        check(ra_.status_code == 200 and ra_.content == AUDIO_BYTES
              and ra_.headers.get("content-type", "").startswith("audio/mpeg")
              and "max-age=3600" in (ra_.headers.get("cache-control") or "") and ra_.headers.get("etag"),
              f"аудио: {ra_.status_code} {ra_.headers.get('content-type')} {ra_.headers.get('cache-control')}")
        r304 = l0.req("GET", f"/v1/media/{key}/audio", headers={"if-none-match": ra_.headers["etag"]})
        check(r304.status_code == 304, f"If-None-Match → {r304.status_code}")
        # детям недетское медиа не видно
        p.switch(c.data["kid"])
        try:
            p.ok("GET", f"/v1/media/{key}", 404, "MEDIA_NOT_AVAILABLE")
        finally:
            p.switch(p.account_id)
        # обзор: права истекают в ≤ 14 дней
        sm = expect(cb.get("/admin/v1/content/summary"), 200)
        exp = [x for x in sm["rights_expiring"] if x["asset_id"] == key]
        check(exp and exp[0]["valid_to"] == (today + timedelta(days=7)).isoformat(), f"rights_expiring: {sm['rights_expiring']}")
        check(detail(cb, "media_asset", key)["row"]["rights_warning"] == "expiring", "rights_warning ≠ expiring")
        susp_before = int(sm["suspended_media"])
        # ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: «наступил день после окончания прав» (см. docstring)
        yesterday = (today - timedelta(days=1)).isoformat()
        res = psql_try("BEGIN; SET LOCAL session_replication_role = replica; UPDATE catalog.content_versions "
                       f"SET payload = jsonb_set(payload, '{{rights,valid_to}}', to_jsonb('{yesterday}'::text)) "
                       f"WHERE kind = 'media_asset' AND key = '{key}' AND status = 'published'; COMMIT;")
        check(res.returncode == 0, f"подготовка истечения прав: {res.stderr[:300]}")
        check(s1._psql(f"SELECT payload->'rights'->>'valid_to' FROM catalog.content_versions WHERE kind = 'media_asset' "
                       f"AND key = '{key}' AND status = 'published'") == yesterday, "valid_to не сдвинут")
        t1 = tick()
        check(t1["suspended"] >= 1, f"catalog:tick: {t1}")
        t2 = tick()
        check(t2["suspended"] == 0, f"повтор catalog:tick приостановил ещё раз: {t2}")
        d = detail(cb, "media_asset", key)
        vm = version_meta(d, 1)
        check(d["row"]["published_version"] is None and d["row"]["rights_warning"] == "expired"
              and vm["status"] == "suspended" and vm["suspend_reason"] == "rights_expired" and vm["suspended_at"],
              f"админка после истечения: row={d['row']} v1={vm['status']}/{vm['suspend_reason']}")
        c.data["media_suspended"] = True
        sm2 = expect(cb.get("/admin/v1/content/summary"), 200)
        check(sm2["suspended_media"] == susp_before + 1 and not any(x["asset_id"] == key for x in sm2["rights_expiring"]),
              f"обзор: suspended_media {susp_before} → {sm2['suspended_media']}")
        # ученик материал больше не видит — ни в списке, ни карточку, ни аудио (кеш BFF перепроверяет права)
        check(key not in [x["asset_id"] for x in l0.ok("GET", "/v1/media", params={"limit": 100})["items"]],
              "приостановленное медиа в списке ученика")
        l0.ok("GET", f"/v1/media/{key}", 404, "MEDIA_NOT_AVAILABLE")
        ra2 = l0.req("GET", f"/v1/media/{key}/audio", headers={"if-none-match": ra_.headers["etag"]})
        check(ra2.status_code == 404, f"аудио приостановленного медиа: {ra2.status_code}")
        ev = s1._psql("SELECT count(*) FROM catalog.outbox WHERE envelope->>'event_type' = 'catalog.media.suspended.v1' "
                      f"AND envelope->'payload'->>'asset_id' = '{key}'")
        check(ev == "1", f"catalog.media.suspended.v1 для {key}: {ev}")
    finally:
        try:
            d = detail(m1.browser, "media_asset", key)
            if d["row"]["published_version"] is not None:
                s2.ensure_step_up(m1)
                expect(m1.browser.post(content_path("media_asset", key, tail="/archive"), {"reason": "e2e: уборка медиа"},
                                       headers=idem()), 200)
                print(f"      finally: медиа {key} снято с публикации", flush=True)
        except Exception as exc:
            print(f"      finally медиа: {exc}", flush=True)


# ---------------------------------------------------------------- RBAC контента (AT-17 для прав спринта 3)


def s_rbac(c: s2.Ctx) -> None:
    an, cm, m1 = c.staff["an"].browser, c.staff["cm"].browser, c.staff["m1"].browser
    key, v = c.data.get("lesson", ("l-01-greetings", 1))
    # analyst: контент только на чтение
    rows = expect(an.get("/admin/v1/content/lesson", params={"limit": 50}), 200)["items"]
    check(len(rows) >= 24 and all(r["kind"] == "lesson" for r in rows), f"analyst: уроков {len(rows)}")
    seed = expect(an.get(content_path("lesson", key)), 200)
    check(seed["row"]["published_version"] == v, seed["row"])
    one = expect(an.get(content_path("lesson", key, v)), 200)
    check(one["status"] == "published", one["status"])
    check(any(x["published_by_name"] for x in seed["versions"]), "имя публиковавшего (сид/сотрудник) в карточке")
    # реестр заявок учеников — только media.rights (ссылка и комментарий ученика — ПДн; решение по ревью)
    denied = expect(an.get("/admin/v1/content/media-requests"), 403)
    check(denied.get("code") == "PERMISSION_DENIED", f"analyst и реестр заявок: {denied}")
    expect(an.get("/admin/v1/language-pairs"), 200)
    expect(an.get("/admin/v1/diagnostics/tests"), 200)
    sid = str(uuid.uuid4())
    cases = [
        (an, "POST", "/admin/v1/content/lesson", {"payload": one["payload"]}, "content.edit"),
        (an, "POST", content_path("lesson", key, tail="/versions"), {"from_version": v}, "content.edit"),
        (an, "POST", content_path("lesson", key, v, "/publish"), {"reason": "e2e: попытка"}, "content.publish"),
        (an, "POST", content_path("lesson", key, tail="/rollback"), {"to_version": v, "reason": "e2e: попытка"},
         "content.publish"),
        (an, "GET", "/admin/v1/content/review-queue", None, "content.review"),
        (an, "POST", f"/admin/v1/content/media-requests/{sid}/take", {}, "media.rights"),
        (an, "POST", "/admin/v1/diagnostics/tests/dx-en-adult/versions/1/publish", {"reason": "e2e: попытка"},
         "content.publish"),
        (cm, "POST", content_path("lesson", key, tail="/archive"), {"reason": "e2e: попытка"}, "content.publish"),
        (cm, "GET", "/admin/v1/content/review-queue", None, "content.review"),
        (m1, "PUT", "/admin/v1/languages/kk", {"code": "kk"}, "lang.manage"),
        (m1, "POST", f"/admin/v1/content/media-requests/{sid}/take", {}, "media.rights"),
    ]
    bad = [x for x in (rbac_denied(b, mth, path, body, perm) for b, mth, path, body, perm in cases) if x]
    check(not bad, "; ".join(bad))
    # меню admin-web — из me.permissions: у аналитика нет команд контента
    perms = set(expect(an.get("/admin/v1/me"), 200)["permissions"])
    check(not (perms & {"content.edit", "content.review", "content.publish", "media.rights", "lang.manage"}), perms)


# ---------------------------------------------------------------- AT-32/33 диагностика взрослого


def _adult_policy(meta: dict[str, Any], n_in_area: int) -> bool:
    """Профиль «верно до A2»; в чтении — первое неверно, дальше всё верно («скачки» → уточнение области)."""
    if meta["area"] == "reading":
        return n_in_area > 0
    return meta["band"] in LOW_BANDS


def s_diag_adult(c: s2.Ctx) -> None:
    ld, l0 = c.lc.users["LD"], c.lc.users["L0"]
    st = ld.ok("GET", "/v1/diagnostics/state")
    check(st["pair_id"] == PAIR and st["status"] == "none" and st["audience"] == "adults" and st["session"] is None
          and st["last_result"] is None and st["next_allowed_at"] is None, st)
    r = ld.req("POST", "/v1/diagnostics/sessions", json={})
    check(r.status_code in (400, 422), f"сессия без Idempotency-Key: {r.status_code} {r.text[:200]}")
    key = str(uuid.uuid4())
    s = ld.ok("POST", "/v1/diagnostics/sessions", 201, json={}, idem=key)
    sid = s["session_id"]
    check(s["test_version"] == "dx-en-adult@1" and s["status"] == "in_progress" and s["answered"] == 0
          and s["total_estimate"] == 24 and s["followup_area"] is None and s["pair_id"] == PAIR, s)
    rep = ld.req("POST", "/v1/diagnostics/sessions", json={}, idem=key)
    check(rep.status_code in (200, 201) and rep.json()["session_id"] == sid, f"повтор Idempotency-Key: {rep.text[:200]}")
    items, test_row = dx_test(s["test_version"])
    seed = s1._psql(f"SELECT seed FROM diagnostics.sessions WHERE session_id = '{s1.uid(sid)}'")
    check(seed, "seed сессии")
    cur = ld.ok("GET", f"/v1/diagnostics/sessions/{sid}/next")
    check_item(cur)
    check(cur == ld.ok("GET", f"/v1/diagnostics/sessions/{sid}/next"), "повторный next отдал другое задание")
    check(cur["position"] == 1 and cur["area"] == "vocabulary", f"первое задание: {cur['area']} #{cur['position']}")
    other = next(i for i in items.values() if i["item_id"] != cur["item_id"] and isinstance(i["answer"], int))
    ld.ok("POST", f"/v1/diagnostics/sessions/{sid}/answers", 409, "ITEM_NOT_CURRENT",
          json={"item_id": other["item_id"], "answer": 0, "dont_know": False, "time_ms": 1000})
    # IDOR: чужая сессия неотличима от несуществующей
    l0.ok("GET", f"/v1/diagnostics/sessions/{sid}/next", 404, "DIAGNOSTIC_SESSION_NOT_FOUND")
    log: list[dict[str, Any]] = []
    probe: tuple[int, str] | None = None
    listening = True
    per_area: Counter[str] = Counter()
    served_bands: list[str] = []
    for n in range(80):
        check_item(cur)
        meta = items[cur["item_id"]]
        if meta["area"] == "listening" and listening:
            # на устройстве нет голоса en-*: Mini App сообщает и перезапрашивает задание
            probe = (len(log), cur["item_id"])
            r = ld.req("POST", f"/v1/diagnostics/sessions/{sid}/listening-unavailable")
            check(r.status_code == 204, f"listening-unavailable: {r.status_code} {r.text[:200]}")
            listening = False
            nxt = ld.ok("GET", f"/v1/diagnostics/sessions/{sid}/next")
            check(nxt["item_id"] != cur["item_id"] and nxt["area"] != "listening", f"после «нет голоса»: {nxt['area']}")
            ld.ok("POST", f"/v1/diagnostics/sessions/{sid}/answers", 409, "ITEM_NOT_CURRENT",
                  json={"item_id": cur["item_id"], "answer": answer_value(meta, True), "dont_know": False,
                        "time_ms": 2000})
            st = ld.ok("GET", "/v1/diagnostics/state")
            check(st["status"] == "in_progress" and st["session"]["session_id"] == sid
                  and st["session"]["total_estimate"] == 18 and st["session"]["answered"] == len(log),
                  f"состояние после «нет голоса»: {st['session']}")
            cur = nxt
            continue
        ok = _adult_policy(meta, per_area[meta["area"]])
        body = {"item_id": cur["item_id"], "answer": answer_value(meta, ok), "dont_know": False, "time_ms": 3000 + n}
        res = ld.ok("POST", f"/v1/diagnostics/sessions/{sid}/answers", json=body)
        check(res["accepted"] is True and set(res) == {"accepted", "next", "done"}, res)
        log.append({"item_id": cur["item_id"], "area": meta["area"], "band": meta["band"], "correct": ok,
                    "listening": listening})
        per_area[meta["area"]] += 1
        served_bands.append(meta["band"])
        if n == 0:
            # тот же ответ повторно — 200 без изменений (сеть Mini App переслала запрос)
            again = ld.ok("POST", f"/v1/diagnostics/sessions/{sid}/answers", json=body)
            check(again == res, f"повтор ответа изменил результат: {again} ≠ {res}")
            check(ld.ok("GET", "/v1/diagnostics/state")["session"]["answered"] == 1, "повтор ответа засчитан дважды")
        if res["done"]:
            check(res["next"] is None, res)
            break
        cur = res["next"]
    else:
        raise StepFailed("диагностика не завершилась")
    check(probe is not None, "задания аудирования не было — «нет голоса» не проверено")
    check(dict(per_area) == {"vocabulary": 6, "grammar": 6, "reading": 6}, f"заданий по областям: {dict(per_area)}")
    check(ld.ok("GET", f"/v1/diagnostics/sessions/{sid}/next") == {"done": True}, "next после последнего ответа")
    result = ld.ok("POST", f"/v1/diagnostics/sessions/{sid}/finish")
    blob = json.dumps(result, ensure_ascii=False)
    check('"answer"' not in blob and '"tags"' not in blob, "ключи ответов/теги в результате")
    areas = {a["area"]: a for a in result["areas"]}
    check(set(areas) == AREAS6 and result["cefr_certificate"] is False and result["revision"] == 1
          and result["test_version"] == "dx-en-adult@1" and result["pair_id"] == PAIR, f"результат: {blob[:300]}")
    for a in ("speaking", "writing"):
        check(areas[a]["status"] == "not_assessed" and areas[a]["reason"] == "not_in_test_yet" and areas[a]["band"] is None
              and areas[a]["confidence"] is None, areas[a])
    check(areas["listening"]["status"] == "not_assessed" and areas["listening"]["reason"] == "no_speech_voice",
          areas["listening"])
    for a in ("vocabulary", "grammar"):
        check(areas[a]["status"] == "assessed" and areas[a]["band"] == "A2" and areas[a]["needs_followup"] is False
              and areas[a]["confidence"] is not None and 0.5 <= areas[a]["confidence"] <= 1, f"{a}: {areas[a]}")
    check(areas["reading"]["status"] == "assessed" and areas["reading"]["needs_followup"] is True
          and areas["reading"]["confidence"] < 0.5, f"чтение со «скачками» — уточнение: {areas['reading']}")
    for a in areas.values():
        # основания — по полосам, без item_id и отметок по заданиям (иначе результат — «оракул» ключей; решение по ревью)
        check(all(set(e) == {"band", "answered", "correct"} and 0 <= e["correct"] <= e["answered"] for e in a["evidence"]),
              f"основания {a['area']}: {a['evidence']}")
        check([e["band"] for e in a["evidence"]] == sorted((e["band"] for e in a["evidence"]), key=BANDS.index),
              f"полосы оснований {a['area']} по возрастанию")
        if a["status"] == "not_assessed":
            check(a["evidence"] == [], f"{a['area']}: not_assessed без оснований")
    check("item_id" not in json.dumps(result), "item_id в результате диагностики")
    check(sum(e["answered"] for a in ("vocabulary", "grammar", "reading") for e in areas[a]["evidence"]) == 18,
          "основания — 18 заданий")
    check(result["provisional_level"] == "A2" and result["weak_areas"] == ["reading", "listening"],
          f"уровень {result['provisional_level']}, слабые стороны {result['weak_areas']}")
    rs = result["recommended_start"]
    if rs is not None:
        lessons = published("lesson")
        check(rs["lesson_id"] in lessons and lessons[rs["lesson_id"]]["kind"] == "core"
              and rs["title"]["ru"] and rs["level"] in BANDS, f"рекомендация старта: {rs}")
        # INTERNAL_API §2.3: ученик A2 не начинает с урока A0 только потому, что тест стартует с A1
        check(BANDS.index(rs["level"]) >= BANDS.index("A2"), f"старт ниже уровня ученика A2: {rs}")
    check(rs is not None, "у ученика A2 по курсу A0–A2 должна быть рекомендация старта")
    again = ld.ok("POST", f"/v1/diagnostics/sessions/{sid}/finish")
    check(again["result_id"] == result["result_id"] and again["revision"] == 1, "повтор finish дал другой результат")
    note = replay(test_row, seed, log, probe, result, listening_available=False)
    print(f"      воспроизводимость: {note}", flush=True)
    st = ld.ok("GET", "/v1/diagnostics/state")
    check(st["status"] == "completed" and st["session"] is None and st["last_result"]["result_id"] == result["result_id"],
          st["status"])
    nat = parse_ts(st["next_allowed_at"])
    check(abs((nat - (parse_ts(result["created_at"]) + timedelta(days=14))).total_seconds()) < 5,
          f"next_allowed_at {st['next_allowed_at']} ≠ результат + 14 дней")
    c.data.update(ld_session=sid, ld_result1=result, ld_items=(items, test_row), ld_seed=seed, ld_log=log,
                  ld_result=result)


# ---------------------------------------------------------------- AT-33 уточнение области


def s_followup(c: s2.Ctx) -> None:
    need(c, "ld_result1")
    ld = c.lc.users["LD"]
    r1 = c.data["ld_result1"]
    rid = r1["result_id"]
    items, test_row = c.data["ld_items"]
    weak = [a["area"] for a in r1["areas"] if a["needs_followup"]]
    if not weak:
        raise StepSkipped("ни одна область не требует уточнения")
    area = weak[0]
    body = ld.ok("POST", f"/v1/diagnostics/results/{rid}/followup", 409, "FOLLOWUP_NOT_AVAILABLE",
                 json={"area": "vocabulary"})
    check(body["details"] == {"area": "vocabulary", "reason": "not_needed"}, body["details"])
    fs = ld.ok("POST", f"/v1/diagnostics/results/{rid}/followup", 201, json={"area": area})
    fsid = fs["session_id"]
    check(fs["followup_area"] == area and fs["total_estimate"] == 3 and fsid != c.data["ld_session"]
          and fs["status"] == "in_progress" and fs["answered"] == 0, fs)
    first = ld.ok("GET", f"/v1/diagnostics/sessions/{fsid}/next")
    flog = run_session(ld, fsid, first, items, lambda meta, n: (answer_value(meta, meta["band"] in LOW_BANDS), False))
    check(len(flog) == 3 and all(e["area"] == area for e in flog), f"уточнение: {[(e['area'], e['band']) for e in flog]}")
    for e in flog:
        e["listening"] = True  # квота уточнения — одна область; аудирование для подбора не нужно
    r2 = ld.ok("POST", f"/v1/diagnostics/sessions/{fsid}/finish")
    check(r2["result_id"] == rid and r2["revision"] == 2 and r2["cefr_certificate"] is False, f"ревизия: {r2['revision']}")
    a2 = {a["area"]: a for a in r2["areas"]}
    check(sum(e["answered"] for e in a2[area]["evidence"]) == 9, f"основания {area} после уточнения: {a2[area]['evidence']}")
    # прежняя ревизия сохранена и неизменна
    revs = pj("SELECT json_agg(json_build_object('revision', revision, 'profile', profile) ORDER BY revision) "
              f"FROM diagnostics.results WHERE result_id = '{s1.uid(rid)}'")
    check([x["revision"] for x in revs] == [1, 2], f"ревизии результата: {[x['revision'] for x in revs]}")
    p1 = {a["area"]: a for a in revs[0]["profile"]["areas"]}
    o1 = {a["area"]: a for a in r1["areas"]}
    check(p1[area] == o1[area], "ревизия 1 изменилась после уточнения")
    hist = ld.ok("GET", "/v1/diagnostics/results")["items"]
    check(len(hist) == 1 and hist[0]["result_id"] == rid and hist[0]["revision"] == 2, f"история: "
          f"{[(x['result_id'][:8], x['revision']) for x in hist]}")
    # профиль ревизии 2 — по всем ответам (основная сессия + уточнение) теми же правилами
    try:
        from tilhero_diagnostics import engine, testdef
        test = testdef.from_row(test_row["test_id"], test_row["version"], test_row["pair_id"], test_row["audience"],
                                test_row["config"], test_row["items"])
        seed = c.data["ld_seed"]
        hist_a = [engine.Answered(e["item_id"], e["area"], e["band"], e["correct"]) for e in c.data["ld_log"]]
        own: list[Any] = []
        for e in flog:
            exp = engine.next_item(test, seed, hist_a + own, session_answers=own, quotas={area: 3},
                                   listening_available=True)
            check(exp is not None and exp.item_id == e["item_id"], f"уточнение: задание {e['item_id']} ≠ правила "
                  f"{exp.item_id if exp else None}")
            own.append(engine.Answered(e["item_id"], e["area"], e["band"], e["correct"]))
        prof = engine.profile(test, hist_a + own, listening_available=False)
        want = {a.area: a.public() for a in prof.areas}
        check(all(want[a]["band"] == a2[a]["band"] and want[a]["confidence"] == a2[a]["confidence"] for a in want),
              f"профиль ревизии 2 ≠ правилам: {[(a, want[a]['band'], a2[a]['band']) for a in want]}")
    except ImportError:
        print("      воспроизводимость уточнения: tilhero_diagnostics недоступен — пропущено", flush=True)
    r = ld.req("POST", f"/v1/diagnostics/results/{rid}/followup", json={"area": area})
    check(r.status_code == 409 and r.json().get("code") == "FOLLOWUP_NOT_AVAILABLE", f"повтор уточнения: {r.text[:200]}")
    c.data["ld_result"] = r2


# ---------------------------------------------------------------- AT-34 повтор раньше 14 дней


def s_retest(c: s2.Ctx) -> None:
    need(c, "ld_result1")
    ld = c.lc.users["LD"]
    r1 = c.data["ld_result1"]
    body = ld.ok("POST", "/v1/diagnostics/sessions", 409, "DIAGNOSTIC_TOO_SOON", json={}, idem=True)
    nat = parse_ts(body["details"]["next_allowed_at"])
    check(abs((nat - (parse_ts(r1["created_at"]) + timedelta(days=14))).total_seconds()) < 5,
          f"next_allowed_at {body['details']} ≠ результат + 14 дней")
    st = ld.ok("GET", "/v1/diagnostics/state")
    check(st["status"] == "completed" and st["session"] is None and parse_ts(st["next_allowed_at"]) == nat
          and st["last_result"]["revision"] == c.data["ld_result"]["revision"], f"состояние: {st['status']}")
    n = s1._psql(f"SELECT count(*) FROM diagnostics.sessions WHERE user_id = '{s1.uid(ld.account_id)}' "
                 "AND status = 'in_progress'")
    check(n == "0", f"отказ в повторе открыл сессию: {n}")


# ---------------------------------------------------------------- AT-35 карта навыков


def s_skill_map(c: s2.Ctx) -> None:
    need(c, "ld_result")
    ld, l0 = c.lc.users["LD"], c.lc.users["L0"]
    m = ld.ok("GET", "/v1/skills/map")
    check(m["pair_id"] == PAIR and m["course_id"] == COURSE, m.get("course_id"))
    skills = m["skills"]
    counts = m["counts"]
    check(set(counts) == {"not_started", "learning", "demonstrated", "retained"}
          and dict(Counter(s["state"] for s in skills)) == {k: v for k, v in counts.items() if v}, f"счётчики: {counts}")
    check(counts["demonstrated"] >= 1 and counts["learning"] >= 1 and counts["retained"] == 0, counts)
    course_skills = published("skill")
    check(all(s["skill_id"] in course_skills and s["title"]["ru"] and s["title"]["uz"] and s["level"] in BANDS
              for s in skills), "навык вне курса или без названия/уровня")
    touched = [s for s in skills if s["state"] != "not_started"]
    check(all(s["history"] and all(h["source"] == "diagnostic" for h in s["history"]) and s["updated_at"]
              for s in touched), "у изменённого навыка нет истории подтверждений диагностикой")
    check(all(not s["history"] for s in skills if s["state"] == "not_started"), "история у не начатого навыка")
    demo = {s["skill_id"] for s in skills if s["state"] == "demonstrated"}
    neg = [s for s in touched if s["state"] == "learning" and not any(h["outcome"] == "negative" for h in s["history"])]
    check(not neg, f"learning без отрицательного свидетельства: {[s['skill_id'] for s in neg][:5]}")
    rows = int(s1._psql(f"SELECT count(*) FROM diagnostics.skill_states WHERE user_id = '{s1.uid(ld.account_id)}' "
                        "AND pair_id = 'ru-en'"))
    check(rows >= len(touched), f"skill_states {rows} < изменённых навыков {len(touched)}")
    two = [s["skill_id"] for s in touched if len(s["history"]) >= 2]
    print(f"      навыков: {len(skills)}, demonstrated {counts['demonstrated']}, learning {counts['learning']}, "
          f"с двумя подтверждениями (основная сессия + уточнение): {len(two)}", flush=True)
    # навыки меняются только оценкой: у ученика без диагностики ничего не освоено
    m0 = l0.ok("GET", "/v1/skills/map")
    check(m0["counts"]["demonstrated"] == 0 and m0["counts"]["learning"] == 0
          and all(not s["history"] for s in m0["skills"]), f"L0 без диагностики: {m0['counts']}")
    c.data["ld_demonstrated"] = demo


# ---------------------------------------------------------------- AT-36 план уроков


def s_trajectory(c: s2.Ctx) -> None:
    need(c, "ld_result", "ld_demonstrated")
    ld = c.lc.users["LD"]
    res = c.data["ld_result"]
    rec = res["recommended_start"]
    lessons = published("lesson")

    def ready() -> dict[str, Any] | None:
        t = ld.ok("GET", "/v1/plan/trajectory")
        if t["basis"]["diagnostic_result_id"] != res["result_id"]:
            return None
        if rec and (t.get("next") or {}).get("lesson_id") != rec["lesson_id"]:
            return None
        return t

    t = wait_for(ready, 40, interval=1.0, what="план по результату диагностики (diagnostics.completed.v1 → learning-plan)")
    # спринт 4: уроки проходятся (lessons) — lessons_available true; в спринте 3 было false
    check(t["pair_id"] == PAIR and t["course_id"] == COURSE and t["lessons_available"] is True and t["completed"] == [],
          f"траектория: {str(t)[:300]}")
    nx = t["next"]
    check(nx and "start_after_diagnostic" in nx["reason_codes"] and nx["explanation"]["ru"].strip()
          and nx["explanation"]["uz"].strip(), f"следующий урок: {nx and nx['reason_codes']}")
    check(t["mandatory"] and t["mandatory"][0]["lesson_id"] == nx["lesson_id"], "следующий ≠ первый обязательный")
    check(all(x["kind"] == "core" for x in t["mandatory"]) and all(x["kind"] == "optional" for x in t["optional"]),
          "обязательные — core, дополнительные — optional")
    every = t["mandatory"] + t["optional"]
    check(all("adults" in lessons[x["lesson_id"]]["audience"] for x in every), "урок не для взрослых в плане")
    demo = c.data["ld_demonstrated"]
    check(not [x["lesson_id"] for x in t["mandatory"] if x["primary_skill_id"] in demo],
          "в обязательных урок с уже освоенным основным навыком")
    goal0 = t["basis"]["goal"]
    check(goal0 == "travel", f"цель плана: {goal0}")
    gm0 = [x["lesson_id"] for x in t["optional"] if "goal_match" in x["reason_codes"]]
    check(all(goal0 in lessons[x]["goals"] for x in gm0), f"goal_match не по цели: {gm0}")
    in_plan = {x["lesson_id"] for x in t["mandatory"]}

    def expected_goal_match(goal: str) -> set[str]:
        return {k for k, p in lessons.items() if p["kind"] == "optional" and goal in p["goals"]
                and "adults" in p["audience"] and p["primary_skill_id"] not in demo and k not in in_plan}

    check(set(gm0) == expected_goal_match(goal0), f"дополнительные по цели travel: {gm0}, ожидали "
          f"{sorted(expected_goal_match(goal0))}")
    # смена цели → пересчёт с новой причиной, прежняя ревизия сохраняется. Новая цель — та, у которой по курсу и
    # навыкам ученика есть свои дополнительные уроки (иначе «новую причину» не увидеть); нет такой — work
    goals_ok = [g for g in ("work", "daily", "career", "study", "exam")
                if expected_goal_match(g) and expected_goal_match(g) != set(gm0)]
    new_goal = goals_ok[0] if goals_ok else "work"
    s1.plan_patch(ld, {"goal": new_goal})
    t2 = wait_for(lambda: (x := ld.ok("GET", "/v1/plan/trajectory")) and x["basis"]["goal"] == new_goal and x, 30,
                  what="пересчёт плана после смены цели")
    check(t2["revision"] > t["revision"] and t2["basis"]["diagnostic_result_id"] == res["result_id"],
          f"ревизия {t['revision']} → {t2['revision']}")
    gm = [x["lesson_id"] for x in t2["optional"] if "goal_match" in x["reason_codes"]]
    in_plan = {x["lesson_id"] for x in t2["mandatory"]}
    check(set(gm) == expected_goal_match(new_goal),
          f"дополнительные по цели {new_goal}: {gm}, ожидали {sorted(expected_goal_match(new_goal))}")
    if goals_ok:
        check(gm and set(gm) != set(gm0), "дополнительные уроки не изменились при смене цели")
    print(f"      дополнительные по цели: travel {sorted(gm0)} → {new_goal} {sorted(gm)}", flush=True)
    goals = s1._psql("SELECT string_agg(coalesce(basis->>'goal', '-'), ',' ORDER BY revision) FROM "
                     f"learning_plan.trajectories WHERE user_id = '{s1.uid(ld.account_id)}' AND pair_id = 'ru-en'")
    check(goals.split(",")[-2:] == ["travel", new_goal], f"ревизии плана (цели): {goals}")


# ---------------------------------------------------------------- AT-37 каталог сценариев


def s_scenarios(c: s2.Ctx) -> None:
    u = c.lc.users["L0"]
    scen = published("scenario")
    adult = {k for k, p in scen.items() if "adults" in p["audience"]}
    page = u.ok("GET", "/v1/scenarios", params={"limit": 100})
    ids = [x["scenario_id"] for x in page["items"]]
    check(page["next_cursor"] is None and len(ids) == len(set(ids)) and set(ids) == adult,
          f"каталог взрослого: {len(ids)} (ожидали {len(adult)})")
    check(20 <= len(ids) <= 30, f"сценариев {len(ids)} — нужно 20–30 (AT-37)")
    for x in page["items"]:
        check(x["title"]["ru"] and x["task"]["ru"] and x["task"]["uz"] and x["level"] in BANDS
              and 1 <= x["difficulty"] <= 5 and x["characters"] and x["access"] == "free" and x["goals"],
              f"карточка сценария {x['scenario_id']}")
    # курсор
    got: list[str] = []
    cursor: str | None = None
    for _ in range(10):
        pg = u.ok("GET", "/v1/scenarios", params={"limit": 7, **({"cursor": cursor} if cursor else {})})
        got += [x["scenario_id"] for x in pg["items"]]
        cursor = pg["next_cursor"]
        if not cursor:
            break
    check(got == ids, "страницы по 7 не совпали с общим списком")
    # фильтры цели, уровня, темы
    for params, pred in ((("goal", "work"), lambda p: "work" in p["goals"]), (("level", "A1"), lambda p: p["level"] == "A1"),
                         (("topic", "food"), lambda p: "food" in p["topics"])):
        f = {x["scenario_id"] for x in u.ok("GET", "/v1/scenarios", params={params[0]: params[1], "limit": 100})["items"]}
        want = {k for k in adult if pred(scen[k])}
        check(f and f == want, f"фильтр {params}: {sorted(f)} ≠ {sorted(want)}")
    sid = sorted(adult)[0]
    d = u.ok("GET", f"/v1/scenarios/{sid}")
    p = scen[sid]
    check(d["opening"]["line_en"] == p["nodes"][p["start_node"]]["line_en"] and d["opening"]["replies"]
          and d["completion"]["ru"] and d["outcomes"] and "nodes" not in d and "start_node" not in d,
          f"карточка сценария: {str(d)[:300]}")
    u.ok("GET", "/v1/scenarios/sc-no-such-e2e", 404, "SCENARIO_NOT_FOUND")
    u.ok("GET", "/v1/scenarios", 422, params={"goal": "space"})


# ---------------------------------------------------------------- APP-MEDIA-01 медиатека


def s_media_library(c: s2.Ctx) -> None:
    u = c.lc.users["L0"]
    today = tashkent_today()
    media = published("media_asset")

    def visible(p: dict[str, Any]) -> bool:
        r = p["rights"]
        return ("adults" in p["audience"] and "UZ" in r["territories"] and r["valid_from"] <= today.isoformat()
                and (r["valid_to"] is None or r["valid_to"] >= today.isoformat())
                and p["origin"] not in ("licensed", "platform_embed"))

    want = {k for k, p in media.items() if visible(p)}
    items = u.ok("GET", "/v1/media", params={"limit": 100})["items"]
    ids = [x["asset_id"] for x in items]
    check(set(ids) == want and len(ids) >= 8, f"медиатека: {sorted(ids)} ≠ {sorted(want)}")
    for x in items:
        check(x["title"]["ru"] and x["source_label"] and x["allowed_uses"] and 5 <= x["duration_s"] <= 90
              and isinstance(x["has_audio"], bool), f"карточка медиа {x['asset_id']}")
    songs = {x["asset_id"] for x in u.ok("GET", "/v1/media", params={"type": "song", "limit": 100})["items"]}
    check(songs == {k for k in want if media[k]["type"] == "song"}, f"фильтр type=song: {songs}")
    a2 = {x["asset_id"] for x in u.ok("GET", "/v1/media", params={"level": "A2", "limit": 100})["items"]}
    check(a2 == {k for k in want if media[k]["level"] == "A2"}, f"фильтр level=A2: {a2}")
    key = next(k for k in sorted(want) if "show_transcript" in media[k]["rights"]["allowed_uses"])
    d = u.ok("GET", f"/v1/media/{key}")
    p = media[key]
    speakers = {t["speaker"] for t in p["transcript"]}
    check(d["attribution"] == p["rights"]["attribution"] and "attribution" in d
          and d["source_label"] == ("TilHero" if p["origin"] == "own_recording" else d["source_label"])
          and len(d["transcript"]) == len(p["transcript"]) and set(d["voices"]) == speakers
          and set(d["voices"].values()) <= {"en-GB", "en-US"} and isinstance(d["exercises_available"], bool),
          f"карточка медиа {key}: {str(d)[:300]}")
    no_audio = next((x["asset_id"] for x in items if not x["has_audio"]), None)
    if no_audio:
        r = u.req("GET", f"/v1/media/{no_audio}/audio")
        check(r.status_code == 404 and r.json().get("code") in ("AUDIO_NOT_FOUND", "MEDIA_NOT_AVAILABLE"),
              f"аудио без файла: {r.status_code} {r.text[:200]}")
    u.ok("GET", "/v1/media/m-no-such-e2e", 404, "MEDIA_NOT_AVAILABLE")
    if not c.data.get("media_suspended"):
        print("      аудио с файлом проверено в шаге C07 (своё медиа сценария)" if c.data.get("media_published")
              else "      аудио с файлом не проверено: шаг C07 не дошёл до публикации", flush=True)


# ---------------------------------------------------------------- AT-30 заявка на песню


def s_media_request(c: s2.Ctx) -> None:
    ld = c.lc.users["LD"]
    cm, m1 = c.staff["cm"], c.staff["m1"]
    title = f"e2e {c.tag} Кофейная песенка"
    link = f"https://example.org/e2e/{c.tag.lower()}"
    comment = f"Хочу разобрать припев {c.tag}"
    c.remember("ссылка заявки", link)
    c.remember("комментарий заявки", comment)
    c.data["request_title"] = title
    req_body = {"kind": "song", "title": title, "link": link, "comment": comment}
    r = ld.req("POST", "/v1/media/requests", json=req_body)
    check(r.status_code in (400, 422), f"заявка без Idempotency-Key: {r.status_code}")
    ld.ok("POST", "/v1/media/requests", 422, json={**req_body, "link": "http://example.org/x"}, idem=True)
    key = str(uuid.uuid4())
    mr = ld.ok("POST", "/v1/media/requests", 201, json=req_body, idem=key)
    rid = mr["request_id"]
    check(mr["status"] == "new" and mr["title"] == title and mr["link"] == link and mr["comment"] == comment
          and mr["decided_at"] is None and mr["decision_note"] is None, mr)
    rep = ld.req("POST", "/v1/media/requests", json=req_body, idem=key)
    check(rep.status_code in (200, 201) and rep.json()["request_id"] == rid, f"повтор заявки: {rep.text[:200]}")
    mine = ld.ok("GET", "/v1/media/requests")["items"]
    check([x["request_id"] for x in mine] == [rid], f"мои заявки: {[x['request_id'] for x in mine]}")
    c.data["request"] = rid
    # админка: реестр заявок (ссылка не открывается сервером — только показывается)
    cb = cm.browser
    rows = expect(cb.get("/admin/v1/content/media-requests", params={"q": title}), 200)["items"]
    check(len(rows) == 1 and rows[0]["request_id"] == rid and rows[0]["user_id"] == ld.account_id
          and rows[0]["status"] == "new" and rows[0]["link"] == link and rows[0]["ui_locale"] == "ru"
          and rows[0]["similar_count"] == 0, f"заявка в админке: {rows}")
    sm = expect(cb.get("/admin/v1/content/summary"), 200)
    check(sm["new_media_requests"] >= 1, sm["new_media_requests"])
    tk = expect(cb.post(f"/admin/v1/content/media-requests/{rid}/take", {}), 200)
    check(tk["status"] == "in_review", tk["status"])
    denied = rbac_denied(m1.browser, "POST", f"/admin/v1/content/media-requests/{rid}/decide",
                         {"status": "rejected", "note": "e2e: попытка"}, "media.rights")
    check(denied is None, denied)
    if not step_up_active(cm):
        expect(cb.post(f"/admin/v1/content/media-requests/{rid}/decide", {"status": "rejected", "note": "e2e: x x"},
                       headers=idem()), 403, "STEP_UP_REQUIRED")
    s2.ensure_step_up(cm)
    note = f"Подобрали авторскую сценку про кофе {c.tag}"
    c.remember("решение по заявке (видно ученику, не в Telegram)", note)
    if c.data.get("media"):
        expect(cb.post(f"/admin/v1/content/media-requests/{rid}/decide",
                       {"status": "authored_alternative", "note": note, "linked_asset_id": c.data["media"]},
                       headers=idem()), 422, "LINKED_ASSET_NOT_PUBLISHED")
    expect(cb.post(f"/admin/v1/content/media-requests/{rid}/decide", {"status": "authored_alternative", "note": note},
                   headers=idem()), 422, "LINKED_ASSET_REQUIRED")
    seq = s1.tg_last_seq()
    dec = expect(cb.post(f"/admin/v1/content/media-requests/{rid}/decide",
                         {"status": "authored_alternative", "note": note, "linked_asset_id": "m-own-coffee-order"},
                         headers=idem()), 200)
    check(dec["status"] == "authored_alternative" and dec["decided_by"] == cm.staff_id
          and dec["decided_by_name"] == cm.display_name and dec["linked_asset_id"] == "m-own-coffee-order",
          f"решение: {dec['status']} {dec['decided_by_name']}")
    c.data["request_decided"] = True
    # ученик видит статус и комментарий; уведомление — в центре и в Telegram (без комментария сотрудника)
    got = ld.ok("GET", "/v1/media/requests")["items"][0]
    check(got["status"] == "authored_alternative" and got["decision_note"] == note
          and got["linked_asset_id"] == "m-own-coffee-order" and got["decided_at"], got)
    msgs = wait_for(lambda: s1.tg_sent(ld.tg_id, seq, contains=title), 30, what="уведомление о решении в Telegram")
    text = msgs[0]["payload"]["text"]
    check(note not in text and link not in text and s1.startapp_of(msgs[0]["payload"]) == "route_media_requests",
          f"уведомление: {text[:200]} / {msgs[0]['payload'].get('reply_markup')}")
    time.sleep(1.5)
    check(len(s1.tg_sent(ld.tg_id, seq, contains=title)) == 1, "уведомлений о решении больше одного")
    inbox = [i for i in ld.inbox() if title in i["body"]]
    check(len(inbox) == 1 and inbox[0]["category"] == "support" and inbox[0]["startapp"] == "route_media_requests"
          and note not in json.dumps(inbox, ensure_ascii=False), f"центр уведомлений: {inbox}")
    body = expect(cb.post(f"/admin/v1/content/media-requests/{rid}/decide",
                          {"status": "rejected", "note": "e2e: передумали"}, headers=idem()), 409, "MEDIA_REQUEST_DECIDED")
    check(body["details"].get("status") == "authored_alternative", body)


# ---------------------------------------------------------------- AT-38 дети


def s_kids(c: s2.Ctx) -> None:
    p = c.lc.users["P"]
    kid = c.data["kid"]
    lessons, scen, media = published("lesson"), published("scenario"), published("media_asset")
    p.switch(kid)
    try:
        check(p.session["learner"]["kind"] == "child", p.session["learner"])
        st = p.ok("GET", "/v1/diagnostics/state")
        check(st["audience"] == "kids" and st["status"] == "none", st)
        s = p.ok("POST", "/v1/diagnostics/sessions", 201, json={}, idem=True)
        check(s["test_version"] == "dx-en-kids@1" and s["total_estimate"] == 12, s)
        items, _ = dx_test(s["test_version"])
        check({i["band"] for i in items.values()} <= set(LOW_BANDS), "в детском тесте есть B1/B2")
        first = p.ok("GET", f"/v1/diagnostics/sessions/{s['session_id']}/next")
        instr: list[str] = []
        log = run_session(p, s["session_id"], first, items, lambda meta, n: (answer_value(meta, True), False), instr)
        check(dict(Counter(e["area"] for e in log)) == {"vocabulary": 3, "grammar": 3, "reading": 3, "listening": 3},
              f"детский тест — 3 задания на область: {dict(Counter(e['area'] for e in log))}")
        check(all(e["band"] in LOW_BANDS for e in log), "детям — задание B1/B2")
        hard = [t for t in instr if any(w in t.lower() for w in KIDS_PRESSURE)]
        check(not hard, f"давление в инструкциях детского теста: {hard}")
        res = p.ok("POST", f"/v1/diagnostics/sessions/{s['session_id']}/finish")
        check(res["cefr_certificate"] is False and res["provisional_level"] in LOW_BANDS
              and all(a["band"] in (None, *LOW_BANDS) for a in res["areas"]), f"детский результат: {res['provisional_level']}")
        if res["recommended_start"]:
            check("kids" in lessons[res["recommended_start"]["lesson_id"]]["audience"], res["recommended_start"])
        # сценарии и медиа — только детские
        sc = [x["scenario_id"] for x in p.ok("GET", "/v1/scenarios", params={"limit": 100})["items"]]
        kids_sc = {k for k, v in scen.items() if "kids" in v["audience"]}
        check(sc and set(sc) == kids_sc, f"сценарии ребёнка: {sorted(sc)} ≠ {sorted(kids_sc)}")
        adult_only = sorted(k for k, v in scen.items() if "kids" not in v["audience"])[0]
        p.ok("GET", f"/v1/scenarios/{adult_only}", 404, "SCENARIO_NOT_FOUND")
        md = [x["asset_id"] for x in p.ok("GET", "/v1/media", params={"limit": 100})["items"]]
        check(md and all("kids" in media[k]["audience"] for k in md), f"медиа ребёнка: {md}")
        adult_media = sorted(k for k, v in media.items() if "kids" not in v["audience"])[0]
        p.ok("GET", f"/v1/media/{adult_media}", 404, "MEDIA_NOT_AVAILABLE")
        t = wait_for(lambda: (x := p.ok("GET", "/v1/plan/trajectory")) and x["basis"]["diagnostic_result_id"]
                     == res["result_id"] and x, 30, what="план ребёнка по детской диагностике")
        every = ([t["next"]] if t["next"] else []) + t["mandatory"] + t["optional"]
        check(every and all("kids" in lessons[x["lesson_id"]]["audience"] for x in every),
              f"в плане ребёнка недетский урок: {[x['lesson_id'] for x in every]}")
        # заявки на песни и фильмы — только из аккаунта опекуна
        p.ok("POST", "/v1/media/requests", 403, "KIDS_NOT_ALLOWED", json={"kind": "song", "title": "e2e детская"},
             idem=True)
        p.ok("GET", "/v1/media/requests", 403, "KIDS_NOT_ALLOWED")
        c.data["kid_result"] = res
    finally:
        p.switch(p.account_id)
    check(p.ok("GET", "/v1/diagnostics/state")["audience"] == "adults", "родитель получил детский тест")


# ---------------------------------------------------------------- AT-31 языки и пары в админке


def s_languages_admin(c: s2.Ctx) -> None:
    root, m1 = c.staff["root"], c.staff["m1"]
    b = root.browser
    langs = {x["code"]: x for x in expect(b.get("/admin/v1/languages"), 200)["items"]}
    check(langs.get("en", {}).get("status") == "active" and {"ru", "uz"} <= set(langs), f"языки: {sorted(langs)}")
    pairs = {x["pair_id"]: x for x in expect(b.get("/admin/v1/language-pairs"), 200)["items"]}
    en = pairs.get(PAIR)
    check(en and en["status"] == "published" and en["course_id"] == COURSE
          and en["readiness"]["diagnostic_test"] == "dx-en-adult@1" and en["readiness"]["lessons_published"] >= 24
          and en["readiness"]["scenarios_published"] >= 20 and en["learners"] >= 1, f"пара ru-en: {en}")
    uz = pairs.get("ru-uz")
    check(uz and uz["status"] == "planned" and uz["readiness"]["diagnostic_test"] is None, f"пара ru-uz: {uz}")
    assert uz is not None
    body = {k: uz[k] for k in ("pair_id", "source", "target", "explanation_locales", "ui_locales", "title", "status",
                               "release_at", "course_id")}
    body.update(status="published", reason="e2e: проверка готовности пары")
    denied = rbac_denied(m1.browser, "PUT", "/admin/v1/language-pairs/ru-uz", body, "lang.manage")
    check(denied is None, denied)
    if not step_up_active(root):
        r = expect(b.request("PUT", "/admin/v1/language-pairs/ru-uz", json_body=body), 403, "STEP_UP_REQUIRED")
        check(r["details"].get("permission") == "lang.manage", r)
    s2.ensure_step_up(root)
    r = expect(b.request("PUT", "/admin/v1/language-pairs/ru-uz", json_body=body), 422, "PAIR_NOT_READY")
    missing = r["details"].get("missing") or []
    check("diagnostic_test" in missing and "course" in missing, f"PAIR_NOT_READY missing: {missing}")
    after = {x["pair_id"]: x for x in expect(b.get("/admin/v1/language-pairs"), 200)["items"]}
    check(after["ru-uz"]["status"] == "planned", f"ru-uz изменилась: {after['ru-uz']['status']}")
    ld = c.lc.users["LD"]
    check(next(x for x in ld.ok("GET", "/v1/languages")["pairs"] if x["pair_id"] == "ru-uz")["available"] is False,
          "ru-uz стала доступна ученику")


# ---------------------------------------------------------------- обзор


def s_dashboard(c: s2.Ctx) -> None:
    b = c.staff["root"].browser
    d = expect(b.get("/admin/v1/dashboard", params={"period": "today"}), 200)
    bad = {k: d[k].get("service") for k in ("content", "diagnostics") if not (d[k]["available"] and d[k]["data"])}
    check(not bad, f"блоки обзора недоступны: {bad}")
    ct, dx = d["content"]["data"], d["diagnostics"]["data"]
    check(ct["by_kind"]["lesson"]["published"] >= 24 and ct["by_kind"]["scenario"]["published"] >= 20
          and ct["by_kind"]["media_asset"]["published"] >= 8, f"контент: {ct['by_kind']}")
    if c.data.get("media_suspended"):
        check(ct["suspended_media"] >= 1, ct["suspended_media"])
    check(dx["finished"] >= (2 if c.data.get("kid_result") else 1) and dx["started"] >= dx["finished"]
          and set(dx["not_assessed_pct"]) == {"vocabulary", "grammar", "reading", "listening"}
          and 0 <= dx["not_assessed_pct"]["listening"] <= 100, f"диагностика: {dx}")
    check(dx["by_level"].get("A2", 0) >= 1, f"распределение уровней: {dx['by_level']}")
    if c.data.get("ld_result") and c.data["ld_result"]["revision"] == 2:
        check(dx["followups"] >= 1, f"followups: {dx['followups']}")
    for who in ("cm", "an", "m1"):
        dd = expect(c.staff[who].browser.get("/admin/v1/dashboard", params={"period": "7d"}), 200)
        check(dd["content"]["available"] is True, f"{who}: блок content недоступен")


# ---------------------------------------------------------------- [QA] пустая диагностика


def s_diag_empty(c: s2.Ctx) -> None:
    """INTERNAL_API §2.5 и telegram-bff: завершение без ответов — 422 DIAGNOSTIC_EMPTY (результат не сохраняется)."""
    lx = c.lc.users["LX"]
    s = lx.ok("POST", "/v1/diagnostics/sessions", 201, json={}, idem=True)
    r = lx.req("POST", f"/v1/diagnostics/sessions/{s['session_id']}/finish")
    body = r.json() if r.content else {}
    check(body.get("code") == "DIAGNOSTIC_EMPTY", f"пустое завершение: {r.status_code} {str(body)[:200]}")
    n = s1._psql(f"SELECT count(*) FROM diagnostics.results WHERE user_id = '{s1.uid(lx.account_id)}'")
    check(n == "0", f"пустая диагностика сохранила результат: {n}")
    check(lx.ok("GET", "/v1/diagnostics/state")["next_allowed_at"] is None, "пустая диагностика блокирует повтор")
    check(r.status_code == 422, f"DIAGNOSTIC_EMPTY отдан с {r.status_code}, по контракту (INTERNAL_API §2.5, "
          "описание маршрута telegram-bff) — 422")


# ---------------------------------------------------------------- сага удаления


def s_deletion(c: s2.Ctx) -> None:
    lx = c.lc.users["LX"]
    cm = c.staff["cm"]
    uid = s1.uid(lx.account_id)
    s = lx.ok("POST", "/v1/diagnostics/sessions", 201, json={}, idem=True)
    items, _ = dx_test(s["test_version"])
    first = lx.ok("GET", f"/v1/diagnostics/sessions/{s['session_id']}/next")
    run_session(lx, s["session_id"], first, items,
                lambda meta, n: (answer_value(meta, meta["band"] == "A1"), n % 3 == 2))
    res = lx.ok("POST", f"/v1/diagnostics/sessions/{s['session_id']}/finish")
    wait_for(lambda: (t := lx.ok("GET", "/v1/plan/trajectory")) and t["basis"]["diagnostic_result_id"]
             == res["result_id"], 30, what="план LX по диагностике")
    # лимит заявок: 5 в сутки, шестая — 429
    rids: list[str] = []
    for i in range(5):
        rids.append(lx.ok("POST", "/v1/media/requests", 201, json={
            "kind": "movie", "title": f"e2e {c.tag} LX фильм {i}", "link": f"https://example.org/lx/{c.tag}/{i}",
            "comment": f"LX комментарий {c.tag} {i}"}, idem=True)["request_id"])
    r = lx.req("POST", "/v1/media/requests", json={"kind": "movie", "title": f"e2e {c.tag} LX лишний"}, idem=True)
    check(r.status_code == 429 and r.json().get("code") in ("MEDIA_REQUEST_LIMIT", "RATE_LIMITED")
          and (r.headers.get("retry-after") or (r.json().get("details") or {}).get("retry_after")),
          f"шестая заявка за сутки: {r.status_code} {r.text[:200]}")
    for i in range(5):
        c.remember(f"комментарий LX {i}", f"LX комментарий {c.tag} {i}")
    counts_sql = {
        "diagnostics.sessions": f"SELECT count(*) FROM diagnostics.sessions WHERE user_id = '{uid}'",
        "diagnostics.answers": "SELECT count(*) FROM diagnostics.answers a JOIN diagnostics.sessions s USING "
                               f"(session_id) WHERE s.user_id = '{uid}'",
        "diagnostics.results": f"SELECT count(*) FROM diagnostics.results WHERE user_id = '{uid}'",
        "diagnostics.skill_states": f"SELECT count(*) FROM diagnostics.skill_states WHERE user_id = '{uid}'",
        "diagnostics.skill_evidence": f"SELECT count(*) FROM diagnostics.skill_evidence WHERE user_id = '{uid}'",
        "learning_plan.trajectories": f"SELECT count(*) FROM learning_plan.trajectories WHERE user_id = '{uid}'",
        "catalog.media_requests (user_id)": f"SELECT count(*) FROM catalog.media_requests WHERE user_id = '{uid}'",
    }
    before = {k: int(s1._psql(q)) for k, q in counts_sql.items()}
    check(all(v > 0 for k, v in before.items() if k != "diagnostics.answers") and before["catalog.media_requests (user_id)"]
          == 5, f"данные LX до удаления: {before}")
    answers_ids = s1._psql("SELECT string_agg(session_id::text, ',') FROM diagnostics.sessions "
                           f"WHERE user_id = '{uid}'").split(",")
    d = lx.ok("POST", "/v1/profile/delete-request", 202, json={"confirm_word": "УДАЛИТЬ"})
    check({"catalog", "diagnostics", "learning-plan"} <= set(d["domains"]), f"домены саги: {d['domains']}")

    def done() -> Any:
        row = s1._psql("SELECT status || '|' || array_to_string(acked_domains, ',') FROM "
                       f"identity_consent.deletion_requests WHERE user_id = '{uid}'")
        return row if row.startswith("COMPLETED|") else None

    row = wait_for(done, 90, interval=1.0, what="сага удаления LX (ACK всех доменов)")
    acked = set(row.split("|")[1].split(","))
    check({"catalog", "diagnostics", "learning-plan"} <= acked, f"ACK: {sorted(acked)}")
    left = {k: v for k, q in counts_sql.items() if (v := int(s1._psql(q)))}
    check(not left, f"данные LX после удаления: {left}")
    ids = ",".join(f"'{s1.uid(x)}'" for x in answers_ids if x)
    if ids:
        n = s1._psql(f"SELECT count(*) FROM diagnostics.answers WHERE session_id IN ({ids})")
        check(n == "0", f"ответы диагностики после удаления: {n}")
    anon = pj("SELECT json_agg(json_build_object('u', user_id, 'l', link, 'c', comment, 't', title)) FROM "
              f"catalog.media_requests WHERE request_id IN ({','.join(repr(s1.uid(x)) for x in rids)})")
    check(len(anon) == 5 and all(x["u"] is None and x["l"] is None and x["c"] is None and x["t"] for x in anon),
          f"заявки LX не обезличены: {anon}")
    rows = expect(cm.browser.get("/admin/v1/content/media-requests", params={"q": f"e2e {c.tag} LX"}), 200)["items"]
    check(len(rows) == 5 and all(x["user_id"] is None and x["link"] is None and x["comment"] is None for x in rows),
          f"админка: заявки LX после удаления {[(x['user_id'], x['link']) for x in rows]}")
    # гигиена реестра: обезличенные тестовые заявки — rejected (уведомлять некого)
    try:
        s2.ensure_step_up(cm)
        for x in rows:
            expect(cm.browser.post(f"/admin/v1/content/media-requests/{x['request_id']}/decide",
                                   {"status": "rejected", "note": "e2e: тестовая заявка"}, headers=idem()), 200)
    except Exception as exc:
        print(f"      уборка заявок LX: {exc} — уберёт --cleanup", flush=True)
    c.data["deleted"] = uid


# ---------------------------------------------------------------- аудит


def s_audit(c: s2.Ctx) -> None:
    b = c.staff["root"].browser
    m1, m2, cm = (c.staff[k].staff_id for k in ("m1", "m2", "cm"))
    d = c.data
    want: list[tuple[str, dict[str, str]]] = []
    if d.get("lesson_rolled_back"):
        key, orig = d["lesson"]
        v = d["lesson_v"]
        oid = f"lesson:{key}@{v}"
        want += [("content.version_updated", {"object_id": oid, "actor_id": m1}),
                 ("content.submitted", {"object_id": oid, "actor_id": m1}),
                 ("content.reviewed", {"object_id": oid, "actor_id": m2}),
                 ("content.published", {"object_id": oid, "actor_id": m1}),
                 ("content.rolled_back", {"object_id": f"lesson:{key}@{orig}", "actor_id": m1})]
    if d.get("scenario_archived"):
        oid = f"scenario:{d['scenario']}@1"
        want += [("content.version_created", {"object_id": oid, "actor_id": m1}),
                 ("content.test_run", {"object_id": oid, "actor_id": m1}),
                 ("content.published", {"object_id": oid, "actor_id": m1}),
                 ("content.archived", {"object_id": oid, "actor_id": m1})]
    if d.get("media_suspended"):
        oid = f"media_asset:{d['media']}@1"
        want += [("content.rights_approved", {"object_id": oid, "actor_id": cm}),
                 ("content.published", {"object_id": oid, "actor_id": m1}),
                 ("media.suspended", {"object_id": oid, "actor_type": "system"})]
    if d.get("request_decided"):
        want += [("media_request.taken", {"object_id": d["request"], "actor_id": cm}),
                 ("media_request.decided", {"object_id": d["request"], "actor_id": cm})]
    check(want, "нет команд контента для проверки аудита (шаги контента упали)")
    recs: list[dict[str, Any]] = []

    def missing() -> list[str]:
        nonlocal recs
        recs = s2.all_records(b, d["started_at"])
        return [f"{a} {q}" for a, q in want
                if not any(r["action"] == a and all(r.get(k) == v for k, v in q.items()) for r in recs)]

    deadline = time.monotonic() + 40
    left = missing()
    while left and time.monotonic() < deadline:
        time.sleep(2)
        left = missing()
    check(not left, f"нет записей аудита: {left}")
    mine = [r for r in recs if r.get("source") == "catalog"]
    check(mine and all(r["actor_type"] in ("staff", "system") for r in mine), "записи catalog")
    pub = next(r for r in mine if r["action"] == "content.published" and r.get("actor_id") == m1)
    check(pub["actor_role"] == "methodist", pub)
    blob = json.dumps(recs, ensure_ascii=False)
    leaks = [w for w, v in c.secrets.items() if v and v in blob and not w.startswith("решение")]
    leaks += [f"заявка «{d['request_title']}»"] if d.get("request_title") and d["request_title"] in blob else []
    leaks += [f"Telegram ID {u.role}" for u in c.lc.users.values() if re.search(rf"(?<!\d){u.tg_id}(?!\d)", blob)]
    check(not leaks, f"тексты заявок/секреты/PII в аудите: {leaks}")
    v = expect(b.get("/admin/v1/audit/verify"), 200)
    check(v["valid"] is True and v["broken_at_seq"] is None, f"цепочка аудита: {v}")


# ---------------------------------------------------------------- события и логи


def s_events(c: s2.Ctx) -> None:
    import jsonschema

    since = c.data["started_at"]
    env_schema = json.loads((s1.CONTRACTS / "envelope.schema.json").read_text())
    seen: Counter[str] = Counter()
    problems: list[str] = []
    texts: dict[str, str] = {}
    for schema in CONTENT_SCHEMAS:
        if s1._psql(f"SELECT to_regclass('{schema}.outbox') IS NOT NULL") != "t":
            continue
        rows = pj("SELECT coalesce(json_agg(json_build_object('e', envelope, 'p', published_at IS NOT NULL)), '[]') "
                  f"FROM {schema}.outbox WHERE created_at >= to_timestamp({int(since)})") or []
        texts[schema] = json.dumps([r["e"] for r in rows], ensure_ascii=False)
        for row in rows:
            env = row["e"]
            et = env.get("event_type", "?")
            seen[f"{schema}:{et}"] += 1
            if not row["p"]:
                problems.append(f"{schema}: {et} не опубликовано (outbox)")
            try:
                jsonschema.validate(env, env_schema, format_checker=jsonschema.FormatChecker())
                path = s1.CONTRACTS / f"{et}.schema.json"
                if not path.exists():
                    problems.append(f"{schema}: нет контракта для {et}")
                    continue
                jsonschema.validate(env["payload"], json.loads(path.read_text()),
                                    format_checker=jsonschema.FormatChecker())
            except jsonschema.ValidationError as exc:
                problems.append(f"{schema}: {et}: {exc.message[:160]}")
    expected = {"catalog:catalog.version.published.v1", "catalog:admin.audit.recorded.v1",
                "diagnostics:diagnostics.completed.v1", "diagnostics:skills.state.changed.v1",
                "learning_plan:learning.trajectory.updated.v1"}
    if c.data.get("media_suspended"):
        expected.add("catalog:catalog.media.suspended.v1")
    if c.data.get("request_decided"):
        expected |= {"catalog:catalog.media_request.created.v1", "catalog:catalog.media_request.decided.v1"}
    if c.data.get("deleted"):
        expected |= {"catalog:user.domain.deleted.v1", "diagnostics:user.domain.deleted.v1"}
    check(not (expected - set(seen)), f"не опубликованы события: {sorted(expected - set(seen))}")
    check(not problems, "; ".join(problems[:8]))
    # published/rolled_back урока — в событиях catalog.version.published.v1
    if c.data.get("lesson_rolled_back"):
        key = c.data["lesson"][0]
        acts = s1._psql("SELECT string_agg(envelope->'payload'->>'action', ',' ORDER BY created_at) FROM catalog.outbox "
                        "WHERE envelope->>'event_type' = 'catalog.version.published.v1' AND envelope->'payload'->>'key' = "
                        f"'{key}' AND created_at >= to_timestamp({int(since)})")
        check(acts.split(",")[-2:] == ["published", "rolled_back"], f"события урока {key}: {acts}")
    # PII: Telegram ID и username учеников, email сотрудников, ссылки и комментарии заявок, секреты
    leaks = []
    for schema, text in texts.items():
        for u in c.lc.users.values():
            if u.username in text or re.search(rf"(^|[^0-9]){u.tg_id}([^0-9]|$)", text):
                leaks.append(f"{schema}: ученик {u.role}")
        for st in c.staff.values():
            if st.email in text:
                leaks.append(f"{schema}: email {st.email.split('@')[0]}")
        for what, v in c.secrets.items():
            # решение по заявке — текст сотрудника: причина команды в admin.audit.recorded.v1 (как в C22)
            if v and v in text and not what.startswith("решение"):
                leaks.append(f"{schema}: {what}")
    if c.data.get("request_title"):
        created = s1._psql("SELECT coalesce(string_agg(envelope::text, E'\\n'), '') FROM catalog.outbox WHERE "
                           "envelope->>'event_type' IN ('catalog.media_request.created.v1', 'admin.audit.recorded.v1') "
                           f"AND created_at >= to_timestamp({int(since)})")
        if c.data["request_title"] in created:
            leaks.append("catalog: название заявки в created/аудите")
    check(not leaks, f"PII/секреты в событиях: {sorted(set(leaks))}")
    after, before = s1.dlq_counts(), c.data.get("dlq_before", {})
    grown = {k: v - before.get(k, 0) for k, v in after.items() if v > before.get(k, 0)}
    check(not grown, f"новые сообщения в DLQ: {grown}")


def s_logs(c: s2.Ctx) -> None:
    needles: dict[str, str] = dict(c.secrets)
    needles.update({f"ученик: {k}": v for k, v in c.lc.secrets.items()})
    for i, v in enumerate(dict.fromkeys(c.seen)):
        needles[f"cookie/CSRF #{i}"] = v
    for st in c.staff.values():
        needles[f"email {st.email.split('@')[0]}"] = st.email
    for u in c.lc.users.values():
        needles[f"Telegram ID {u.role}"] = str(u.tg_id)
        needles[f"username {u.role}"] = u.username
        needles[f"имя {u.role}"] = u.first
    needles["имя ребёнка"] = c.data.get("kid_name", "")
    needles["название заявки"] = c.data.get("request_title", "")
    needles["SCHEDULER_TOKEN"] = s1.SCHEDULER_TOKEN
    found = []
    for log in sorted(s1.LOG_DIR.glob("*.log")):
        if log.name.startswith(("mock-telegram", "miniapp", "bootstrap")) or ".migrate" in log.name or ".build" in log.name:
            continue
        text = log.read_text(errors="replace")
        for what, needle in needles.items():
            if not needle:
                continue
            hit = re.search(rf"(?<!\d){re.escape(needle)}(?!\d)", text) if needle.isdigit() else needle in text
            if hit:
                found.append(f"{log.name}: {what}")
    check(not found, f"PII/секреты в логах: {found}")


STEPS: list[tuple[str, Callable[[s2.Ctx], None], bool]] = [
    ("C00 стенд спринта 3: catalog, diagnostics, маршруты BFF, сид контента и тестов; уборка остатков", s_stand, True),
    ("C01 super_admin (bootstrap) и сотрудники: methodist ×2, content_manager (four-eyes waived, step-up), analyst",
     s_staff, True),
    ("C02 первый вход сотрудников: смена пароля → TOTP (methodist, content_manager), права ролей спринта 3",
     s_staff_login, True),
    ("C03 ученики через telegram-bff: L0, LD, родитель + ребёнок 6–9, LX", s_learners, True),
    ("C04 AT-31 «Мои языки»: ru-en активна, остальные «скоро»; ru-uz → 409 PAIR_NOT_AVAILABLE", s_languages_learner,
     False),
    ("C05 AT-26/27 урок: черновик → 422 (LOCALE_MISSING, NO_CONTROL_ITEMS) → SELF_REVIEW → проверка RU/UZ → "
     "STEP_UP_REQUIRED → публикация → ученик видит в плане → откат → неизменяемость", s_lesson, False),
    ("C06 AT-28 сценарий: прогон находит недостижимый узел → 422 → исправить → без прогона SCENARIO_TEST_FAILED → "
     "прогон ok → публикация → ученик видит → снят", s_scenario, False),
    ("C07 AT-29 медиа: RIGHTS_REQUIRED → methodist 403 → права content_manager (step-up) → публикация → ученик и "
     "аудио → «истекает» на обзоре → истечение → catalog:tick → приостановлено", s_media, False),
    ("C08 RBAC контента: analyst только чтение, content_manager без публикации/проверки, methodist без языков и заявок",
     s_rbac, False),
    ("C09 AT-32/33 диагностика взрослого: без ключей, ITEM_NOT_CURRENT, повтор ответа, «нет голоса», результат, "
     "воспроизводимость", s_diag_adult, False),
    ("C10 AT-33 уточнение области (needs_followup) → ревизия 2, ревизия 1 сохранена", s_followup, False),
    ("C11 AT-34 повтор раньше 14 дней → 409 DIAGNOSTIC_TOO_SOON {next_allowed_at}", s_retest, False),
    ("C12 AT-35 карта навыков: состояния и история; без оценки — ничего не меняется", s_skill_map, False),
    ("C13 AT-36 план: следующий урок с причиной, обязательные и дополнительные; смена цели → пересчёт", s_trajectory,
     False),
    ("C14 AT-37 каталог сценариев: 20–30, курсор, фильтры цели/уровня/темы, карточка без графа", s_scenarios, False),
    ("C15 APP-MEDIA-01 медиатека: список по правам и аудитории, фильтры, карточка с атрибуцией, аудио 404 без файла",
     s_media_library, False),
    ("C16 AT-30 заявка на песню: ученик → реестр админки → взять → решение (step-up) → статус → уведомление",
     s_media_request, False),
    ("C17 AT-38 дети: детский тест (3 на область, без B1/B2), только детские сценарии/медиа/уроки, заявки 403",
     s_kids, False),
    ("C18 AT-31 языки в админке: ru-en published, ru-uz planned → published 422 PAIR_NOT_READY {missing}",
     s_languages_admin, False),
    ("C19 обзор: блоки content и diagnostics", s_dashboard, False),
    ("C20 [QA] пустая диагностика: 422 DIAGNOSTIC_EMPTY, результат не сохраняется", s_diag_empty, False),
    ("C21 сага удаления: диагностика, результаты, навыки, план удалены; заявки обезличены (+ лимит заявок 429)",
     s_deletion, False),
    ("C22 аудит команд контента и заявок без текстов учеников; цепочка цела", s_audit, False),
    ("C23 события по контрактам (catalog, diagnostics, learning-plan), outbox опубликован, без PII; DLQ", s_events,
     False),
    ("C24 логи сервисов без секретов и PII", s_logs, False),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--admin-bff", default=os.environ.get("E2E_ADMIN_BFF", "http://127.0.0.1:8002"))
    ap.add_argument("--bff", default=TG_BFF)
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--cleanup", action="store_true", help="только уборка остатков прерванного прогона")
    args = ap.parse_args()
    if args.cleanup:
        done = cleanup_leftovers()
        print("уборка стенда (контент): " + ("; ".join(done) if done else "остатков прерванных прогонов нет"), flush=True)
        return 0
    tag = "C" + "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(4))
    base_tg = 8_100_000_000 + secrets.randbelow(800_000_000) * 4
    with httpx.Client(base_url=args.bff, timeout=20) as tg:
        lc = s1.Ctx(bff=tg, tag=tag, base_tg=base_tg)
        lc.data["zone_day"] = s1.pick_zone(datetime.now(UTC), 10 * 60, 16 * 60, 13 * 60)
        c = s2.Ctx(bff=args.admin_bff, lc=lc, tag=tag)
        c.data["started_at"] = int(time.time()) - 1
        print(f"TilHero e2e (спринт 3, контент и диагностика): admin-bff {args.admin_bff}, telegram-bff {args.bff}, "
              f"метка {tag}, Telegram ID от {base_tg + 1}, зона учеников {lc.data['zone_day']}\n", flush=True)
        results: list[tuple[str, str, str]] = []
        blocked: str | None = None
        for name, fn, critical in STEPS:
            if blocked:
                results.append((name, "SKIP", f"после сбоя «{blocked}»"))
                print(f"SKIP  {name}", flush=True)
                continue
            t0 = time.monotonic()
            try:
                fn(c)
                status, det = "PASS", ""
            except StepSkipped as exc:
                status, det = "SKIP", str(exc)
            except Exception as exc:
                status = "FAIL"
                det = str(exc) if isinstance(exc, StepFailed) else f"{type(exc).__name__}: {exc}"
                if args.verbose and not isinstance(exc, StepFailed):
                    traceback.print_exc()
                if critical:
                    blocked = name
            dt = time.monotonic() - t0
            results.append((name, status, det))
            print(f"{status}  {name}  ({dt:.1f} c){'  — ' + det[:900] if det else ''}", flush=True)
    passed = sum(1 for r in results if r[1] == "PASS")
    failed = [r for r in results if r[1] == "FAIL"]
    skipped = [r for r in results if r[1] == "SKIP"]
    print(f"\nИтого: {passed}/{len(results)} PASS" + (f", {len(skipped)} SKIP" if skipped else "")
          + f" (выполнено проверок: {s1.CHECKS[0]})")
    (s1.E2E_DIR / "last-run-content.json").write_text(json.dumps(
        {"tag": tag, "checks": s1.CHECKS[0], "results": [{"step": n, "status": s, "detail": d} for n, s, d in results]},
        ensure_ascii=False, indent=1))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

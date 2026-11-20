# ruff: noqa: S608 — QA-скрипт dev-стенда: psql (SQL только из UUID/ключей сценария, проверенных регуляркой, и констант)
"""Сквозной сценарий спринта 5 TilHero (память и повторения, чтение, перевод по тапу, произношение, вечернее
напоминание, админка памяти и словаря, сага удаления) через публичные API — как Mini App (telegram-bff) и браузер
admin-web (admin-bff).

Предусловие: `infra/e2e/run_local.sh memory` (сброс учёток admin-identity + up + этот сценарий; стенд — `AI_PROVIDER=fake`, `SPEECH_PROVIDER=fake`, ключей провайдеров нет и не нужно). Отдельно,
на уже поднятом стенде со свежим bootstrap-сотрудником:
    uv run python infra/e2e/scenario_memory.py [--admin-bff http://127.0.0.1:8002] [--bff http://127.0.0.1:8001] [-v]
    uv run python infra/e2e/scenario_memory.py --cleanup   # только уборка остатков прерванного прогона

Сотрудники: bootstrap super_admin создаёт двух методистов (текст для чтения: автор и проверяющий; словарь курса и
модерация переводов ИИ; переоценка), operations (ручная правка карточки со step-up), content_manager (словарь без
доступа к памяти ученика) и qa_analyst (память ученика только на чтение). Помощники — сценарии спринтов 1–4
(`scenario.py`: ученики, онбординг, мок Telegram, psql; `scenario_admin.py`: браузер admin-web, TOTP, step-up;
`scenario_content.py`: создание сотрудников, публикация контента, прогрев admin-identity; `scenario_lessons.py`:
прохождение урока).

Ключи ответов (контрольные задания урока, вопросы текста) сценарий берёт так же, как методист в админке:
`GET /admin/v1/content/{kind}/{key}/versions/{v}` (content.read) — ученику ключи не отдаются.

Доменные сервисы напрямую не вызываются, кроме `POST memory /internal/v1/memory:tick` с SCHEDULER_TOKEN — как n8n
`memory-tick`. Прямой доступ к БД (psql):
  * ТЕСТОВЫЕ ИЗМЕНЕНИЯ БД — только сдвиг времени СВОИХ учеников (ждать 1–30 дней нельзя): `memory.cards.due_at /
    last_review_at`, `memory.review_sessions.local_date / started_at / last_activity_at / finished_at`,
    `memory.retention_checks.due_at / demonstrated_at` переносятся в прошлое на одинаковый интервал (UPDATE по user_id
    ученика этого прогона). Каждый сдвиг печатается в журнал прогона;
  * проверки «аудио и тексты ученика нигде не сохранены», «история неизменяема» (UPDATE под ролью-владельцем в
    BEGIN … ROLLBACK обязан упасть), сага удаления (строки ученика в memory), outbox (события по контрактам), проекция
    пояса плана в memory (ожидание перед tick) — только чтение.

Что сценарий меняет в общем стенде и как возвращает (finally шагов + уборка в M00 / в конце / `--cleanup`):
  * текст для чтения `r-e2e-<метка>` (публикуется методистом) — снимается с публикации;
  * статья методиста словаря курса (форма `pelmar<метка>`) — в архив. Статьи course из глоссария e2e-текста и
    переводы ИИ слов e2e-текста остаются (это словарь курса, а не данные ученика; формы уникальны для прогона);
  * согласие на запись голоса ребёнка — отзывается в конце шага.

Окно вечернего напоминания — как prod: с REMINDER_HOUR (19:00) до REMINDER_UNTIL_HOUR (22:00) по поясу плана, не чаще
раза в местный день. На стенде n8n нет, tick вызывает сценарий; пояс плана выбирается так, чтобы сейчас там было
19:xx–20:xx (часы окна сценарий сверяет с окружением процесса memory, /proc/<pid>/environ).

Печатает PASS/FAIL/SKIP по шагам и «Итого: N/M PASS»; код выхода 1, если хоть один шаг упал. Замечания (отклонения от
контракта, не роняющие шаг) печатаются в конце. Шаги после сбоя критичного шага — SKIP.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import re
import secrets
import string
import struct
import subprocess
import sys
import time
import traceback
import uuid
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scenario as s1  # ученики (telegram-bff), онбординг, мок Telegram, psql
import scenario_admin as s2  # браузер admin-web, TOTP, step-up, вход сотрудника
import scenario_content as s3  # создание сотрудников спринта 3, публикация контента, psql-помощники
import scenario_lessons as s4  # прохождение урока (шаги, ролевая ситуация), уборка настроек ИИ

check, expect, wait_for = s1.check, s1.expect, s1.wait_for
StepFailed, StepSkipped = s1.StepFailed, s1.StepSkipped
Staff = s2.Staff
idem = s2.idem
parse_ts = s2.parse_ts
need, pj, safe_key, psql_try = s3.need, s3.pj, s3.safe_key, s3.psql_try

TG_BFF = s2.TG_BFF
MEMORY = os.environ.get("E2E_MEMORY", "http://127.0.0.1:8116")
LESSONS, ASSESSMENT, AI_GATEWAY = s4.LESSONS, s4.ASSESSMENT, s4.AI_GATEWAY
PAIR = "ru-en"
REQUIRED = s1.REQUIRED
VOICE = "voice_recording"
REMINDER_HOURS = (19, 22)  # REMINDER_HOUR, REMINDER_UNTIL_HOUR memory по умолчанию (prod)
MARK = "[e2e "  # маркер прогона в заголовках контента: «[e2e MABCD]»
READING_PREFIX = "r-e2e-"
METHODIST_WORD = "pelmar"  # префикс формы статьи методиста (уборка находит остатки по нему)
SPRINT5_PERMS = {"memory.read", "memory.manage", "glossary.manage"}
# закрытый список error_code оценщика (independent_evaluator rules v1/v2)
EVALUATOR_CODES = {"missing_be", "third_person_s", "wrong_tense", "verb_form", "article", "preposition", "plural",
                   "word_order", "question_form", "pronoun", "vocabulary", "other"}
OTHER_EXPLANATION_RU = "Сравните свою фразу с правильным вариантом и запишите его."
NOTES: list[str] = []  # замечания: отклонения от контракта, не роняющие шаг (печатаются в конце прогона)

# Ответы telegram-bff по повторению (ReviewTask / ReviewTaskResult.next) — проверка «ключей нет в заданиях»
REVIEW_TASKS: list[dict[str, Any]] = []
KEY_FIELDS = {"answer", "answers", "answers_en", "key", "correct", "display", "target", "unit", "distractors"}


def note(text: str) -> None:
    NOTES.append(text)
    print(f"      замечание: {text}", flush=True)


# =============================================================================================== помощники


def iso_z(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def ts(value: str | None) -> datetime | None:
    return parse_ts(value) if value else None


def words_of(tag: str) -> dict[str, str]:
    """Уникальные для прогона «слова» e2e-текста (только буквы — форма словаря курса не пересечётся с другими)."""
    t = tag[1:].lower()
    return {"g1": f"brimo{t}", "g2": f"tavel{t}", "g3": f"kesto{t}",  # глоссарий текста → статьи course
            "ai": f"zorvik{t}", "ai2": f"quandor{t}",  # нет в словаре курса → перевод ИИ (fake)
            "m": f"{METHODIST_WORD}{t}"}  # статья методиста


def admin_payload(c: s2.Ctx, kind: str, key: str, version: int) -> dict[str, Any]:
    """Тело версии контента с ключами — как его видит методист в админке (content.read)."""
    cache: dict[tuple[str, str, int], dict[str, Any]] = c.data.setdefault("payload_cache", {})
    k = (kind, safe_key(key), int(version))
    if k not in cache:
        b = c.staff["root"].browser
        cache[k] = expect(b.get(s3.content_path(kind, key, int(version))), 200)["payload"]
    return cache[k]


def published_version(c: s2.Ctx, kind: str, key: str) -> int:
    v = expect(c.staff["root"].browser.get(s3.content_path(kind, safe_key(key))), 200)["row"]["published_version"]
    check(isinstance(v, int), f"{kind}:{key} не опубликован")
    return int(v)


def lesson_content(c: s2.Ctx, lesson_id: str, version: int) -> dict[str, Any]:
    """Тела урока и его сценария (ключи — из админки) в форме, которую ждёт s4.drive."""
    lesson = admin_payload(c, "lesson", lesson_id, version)
    scn_id = lesson.get("scenario_id")
    scenario = admin_payload(c, "scenario", scn_id, published_version(c, "scenario", scn_id)) if scn_id else None
    return {"lesson": lesson, "scenario": scenario, "exercises": {}}


def control_index(c: s2.Ctx) -> dict[tuple[str, tuple[str, ...]], dict[str, Any]]:
    """Контрольные задания всех опубликованных уроков (админка): (prompt_en, варианты) → задание с ключом. Нужно,
    чтобы отвечать на задания проверок удержания (check_item) верно или неверно — ученику ключ не отдаётся."""
    if "control_index" in c.data:
        return c.data["control_index"]
    b = c.staff["root"].browser
    rows: list[dict[str, Any]] = []
    cursor = None
    for _ in range(10):
        page = expect(b.get("/admin/v1/content/lesson", params={"limit": "100", **({"cursor": cursor} if cursor else {})}),
                      200)
        rows += page["items"]
        cursor = page.get("next_cursor")
        if not cursor:
            break
    out: dict[tuple[str, tuple[str, ...]], dict[str, Any]] = {}
    for r in rows:
        if r.get("published_version") is None:
            continue
        p = admin_payload(c, "lesson", r["key"], int(r["published_version"]))
        for ci in p.get("control_items") or []:
            out[(str(ci["prompt_en"]), tuple(sorted(str(o) for o in ci.get("options") or [])))] = ci
    c.data["control_index"] = out
    return out


def is_uuid(v: Any) -> bool:
    try:
        uuid.UUID(str(v))
        return True
    except ValueError:
        return False


def keys_named(obj: Any, names: set[str], path: str = "$") -> list[str]:
    out: list[str] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in names:
                out.append(f"{path}.{k}")
            out += keys_named(v, names, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out += keys_named(v, names, f"{path}[{i}]")
    return out


def uuids_in(text: str) -> list[str]:
    return [x.lower() for x in re.findall(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
                                          text)]


# ---------------------------------------------------------------- FSRS-5 (независимый расчёт для сверки истории)

W = (0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11,
     0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621)
G = {"again": 1, "hard": 2, "good": 3}
FACTOR, DECAY = 19 / 81, -0.5


def fsrs_d0(g: int) -> float:
    return min(10.0, max(1.0, W[4] - math.exp(W[5] * (g - 1)) + 1))


def fsrs_expected(before: dict[str, Any], grade: str, elapsed: float | None) -> tuple[float, float]:
    """(S′, D′) по формулам INTERNAL_API §1.4 — считается здесь, независимо от memory."""
    g = G[grade]
    if before.get("state") == "new" or before.get("stability") is None:
        return W[g - 1], fsrs_d0(g)
    s, d = float(before["stability"]), float(before["difficulty"])
    d1 = d + (-W[6] * (g - 3)) * (10 - d) / 9
    d2 = min(10.0, max(1.0, W[7] * fsrs_d0(4) + (1 - W[7]) * d1))
    t = float(elapsed or 0.0)
    r = (1 + FACTOR * t / s) ** DECAY
    if t < 1.0:
        s2_ = s * math.exp(W[17] * (g - 3 + W[18]))
    elif g == 1:
        s2_ = min(s, W[11] * d ** (-W[12]) * ((s + 1) ** W[13] - 1) * math.exp(W[14] * (1 - r)))
    else:
        s2_ = s * (math.exp(W[8]) * (11 - d) * s ** (-W[9]) * (math.exp(W[10] * (1 - r)) - 1)
                   * (W[15] if g == 2 else 1.0) + 1)
    return max(s2_, 0.001), d2


def fsrs_interval(s: float) -> int:
    return int(min(365, max(1, math.floor(s / FACTOR * (0.9 ** (1 / DECAY) - 1) + 0.5 + 1e-9))))


# ---------------------------------------------------------------- WAV (Web Audio клиента: PCM 16 бит, моно, 16 кГц)


def wav(ms: int, amplitude: int, *, marker: str = "", rate: int = 16_000) -> bytes:
    """WAV с тоном 440 Гц (amplitude 0 — тишина). marker — чанк LIST/INFO с уникальной строкой: по ней проверяется,
    что тело записи не попало в БД, Redis и логи (сами отсчёты нигде не сохраняются по контракту)."""
    n = int(rate * ms / 1000)
    samples = b"".join(struct.pack("<h", int(amplitude * math.sin(2 * math.pi * 440 * i / rate))) for i in range(n))
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    chunks = fmt
    if marker:
        text = marker.encode() + b"\x00"
        if len(text) % 2:
            text += b"\x00"
        info = b"INFO" + b"ICMT" + struct.pack("<I", len(text)) + text
        chunks += b"LIST" + struct.pack("<I", len(info)) + info
    chunks += b"data" + struct.pack("<I", len(samples)) + samples
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks


def pron(u: s1.U, target: str, body: bytes, ctype: str = "audio/wav") -> httpx.Response:
    """POST /v1/memory/pronunciation — сырое тело записи, как Mini App (fetch с Blob)."""
    return u.ctx.bff.post("/v1/memory/pronunciation", params={"target": target}, content=body,
                          headers=u.h({"content-type": ctype}), timeout=40)


# ---------------------------------------------------------------- время: tick, сдвиги (ТЕСТОВЫЕ ИЗМЕНЕНИЯ БД)


def memory_tick() -> dict[str, Any]:
    """memory:tick — как n8n `memory-tick` (Bearer SCHEDULER_TOKEN); занято соседним tick — повтор."""
    for _ in range(20):
        r = httpx.post(f"{MEMORY}/internal/v1/memory:tick", headers={"authorization": f"Bearer {s1.SCHEDULER_TOKEN}"},
                       timeout=60)
        res = expect(r, 200)
        if not res.get("skipped"):
            return res
        time.sleep(0.5)
    raise StepFailed("memory:tick 10 с подряд отвечает skipped")


def shift_rows(sql: str, what: str) -> list[str]:
    """ТЕСТОВОЕ ИЗМЕНЕНИЕ БД (сдвиг времени своих учеников) — UPDATE … RETURNING <uuid>; печатается в журнал."""
    out = s1._psql(sql)
    ids = [x for x in out.splitlines() if is_uuid(x.strip())]
    print(f"      сдвиг времени (БД): {what} — строк {len(ids)}", flush=True)
    return ids


def shift_cards(user_id: str, days: float, *, card_ids: list[str] | None = None) -> list[str]:
    """Срок и последнее повторение карточек ученика — на `days` дней в прошлое (как если бы прошло `days` дней)."""
    only = ""
    if card_ids:
        only = " AND card_id IN (" + ",".join(f"'{s1.uid(x)}'" for x in card_ids) + ")"
    return shift_rows(
        f"UPDATE memory.cards SET due_at = due_at - make_interval(secs => {float(days) * 86400}), "
        f"last_review_at = last_review_at - make_interval(secs => {float(days) * 86400}) "
        f"WHERE user_id = '{s1.uid(user_id)}' AND status IN ('learning', 'review') AND due_at IS NOT NULL{only} "
        "RETURNING card_id", f"карточки −{days:g} дн.")


def shift_sessions(user_id: str, days: int) -> list[str]:
    """Сессии «Повторения дня» ученика — на `days` дней в прошлое (местная дата и время): прошлые повторения
    перестают быть «сегодняшними» (лимит новых в день, «повторение сегодня было»)."""
    return shift_rows(
        f"UPDATE memory.review_sessions SET local_date = local_date - {int(days)}, "
        f"started_at = started_at - interval '{int(days)} days', "
        f"last_activity_at = last_activity_at - interval '{int(days)} days', "
        f"finished_at = finished_at - interval '{int(days)} days' "
        f"WHERE user_id = '{s1.uid(user_id)}' AND status <> 'active' RETURNING session_id",
        f"сессии повторения −{days} дн.")


def shift_checks_due(user_id: str, skill_id: str) -> list[str]:
    """Проверка удержания навыка «наступила»: срок и момент «демонстрирует» сдвигаются в прошлое на один и тот же
    интервал (срок − сейчас + 1 мин) — как если бы прошли 7 (30) дней."""
    return shift_rows(
        "UPDATE memory.retention_checks SET demonstrated_at = demonstrated_at - (due_at - now() + interval '1 minute'), "
        "due_at = now() - interval '1 minute' "
        f"WHERE user_id = '{s1.uid(user_id)}' AND skill_id = '{safe_key(skill_id)}' AND status = 'scheduled' "
        "AND due_at > now() RETURNING check_id", f"проверка удержания {skill_id}")


# ---------------------------------------------------------------- «Повторение дня» как Mini App


def rs(sid: str) -> str:
    return f"/v1/memory/review-sessions/{sid}"


def capture(task: dict[str, Any] | None) -> dict[str, Any] | None:
    if task is not None:
        REVIEW_TASKS.append(task)
    return task


def card_info(u: s1.U, card_id: str, cache: dict[str, dict[str, Any]]) -> dict[str, Any]:
    if card_id not in cache:
        cache[card_id] = u.ok("GET", f"/v1/memory/cards/{card_id}")
    return cache[card_id]


def answer_text_of(card: dict[str, Any]) -> str:
    return str(card["error"]["correction"]) if card.get("error") else str(card["text_en"])


def right_answer(u: s1.U, c: s2.Ctx, task: dict[str, Any], cache: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Верный ответ «как ученик, который помнит»: перевод/слово карточки, текст, порядок; check_item — по ключу урока."""
    t = task["type"]
    if t == "check_item":
        item = control_item_of(c, task)
        return check_answer(task, item, correct=True)
    card = card_info(u, task["card_id"], cache)
    if t == "meaning_choice":
        want = {card["gloss"]["ru"], card["gloss"]["uz"]}
        idx = [i for i, o in enumerate(task["options"]) if o in want]
        check(len(idx) == 1, f"meaning_choice: верный перевод {want} среди вариантов {task['options']}")
        return {"choice": idx[0]}
    if t == "listen_choice":
        idx = [i for i, o in enumerate(task["options"]) if o == card["text_en"]]
        check(len(idx) == 1, f"listen_choice: «{card['text_en']}» среди вариантов {task['options']}")
        return {"choice": idx[0]}
    if t == "assemble":
        target = answer_text_of(card)
        tiles = list(task["tiles"])
        unit = target.split() if len(tiles) == len(target.split()) else [ch for ch in target if ch.isalpha()]
        order: list[int] = []
        for piece in unit:
            i = next(j for j, x in enumerate(tiles) if x == piece and j not in order)
            order.append(i)
        return {"order": order}
    return {"text": answer_text_of(card)}


def wrong_answer(task: dict[str, Any], marker: str) -> dict[str, Any]:
    if task["answer_kind"] == "choice":
        return {"choice": -1}  # заменяется вызывающим на неверный индекс
    if task["answer_kind"] == "order":
        return {"order": list(range(len(task["tiles"] or task["options"])))}
    return {"text": f"purple elephant {marker}"}


def control_item_of(c: s2.Ctx, task: dict[str, Any]) -> dict[str, Any]:
    idx = control_index(c)
    key = (str(task["prompt"]["prompt_en"]), tuple(sorted(str(o) for o in task["options"])))
    item = idx.get(key)
    if item is None:  # gap_fill — без вариантов; order_words — варианты перемешаны (множество то же)
        cands = [v for (p, _), v in idx.items() if p == key[0]]
        check(len(cands) == 1, f"задание проверки «{key[0]}» не найдено среди контрольных заданий уроков ({len(cands)})")
        item = cands[0]
    return item


def check_answer(task: dict[str, Any], item: dict[str, Any], *, correct: bool) -> dict[str, Any]:
    typ, opts = item["type"], list(task["options"])
    if typ in ("single_choice", "translate_choice"):
        right = opts.index(str(item["options"][int(item["answer"])]))
        return {"choice": right if correct else (right + 1) % len(opts)}
    if typ == "gap_fill":
        return {"text": str(item["answer"][0]) if correct else "xyzzy"}
    order: list[int] = []
    for w in item["answer"]:
        order.append(next(j for j, x in enumerate(opts) if x == w and j not in order))
    return {"order": order if correct else list(reversed(order))}


def post_answer(u: s1.U, sid: str, task: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    if body.get("choice") == -1:  # неверный вариант
        body = {"choice": next(i for i in range(len(task["options"])) if i not in correct_choices(u, task))}
    r = u.ok("POST", f"{rs(sid)}/tasks/{task['task_id']}", json=body)
    capture(r.get("next"))
    return r


def correct_choices(u: s1.U, task: dict[str, Any]) -> set[int]:
    cache: dict[str, dict[str, Any]] = {}
    card = card_info(u, task["card_id"], cache)
    want = {card["gloss"]["ru"], card["gloss"]["uz"], card["text_en"]}
    return {i for i, o in enumerate(task["options"]) if o in want}


def current(u: s1.U, sid: str) -> dict[str, Any] | None:
    r = u.req("GET", f"{rs(sid)}/current")
    if r.status_code == 409 and r.json().get("code") == "TASK_NOT_CURRENT":
        check((r.json().get("details") or {}).get("current_task_id") is None, f"TASK_NOT_CURRENT: {r.text[:200]}")
        return None
    return capture(expect(r, 200))


Policy = Callable[[dict[str, Any], int], str]


def run_review(c: s2.Ctx, u: s1.U, sid: str, policy: Policy, log: list[dict[str, Any]],
               cache: dict[str, dict[str, Any]]) -> None:
    """Проходит сессию до конца: policy(задание, номер) → right | wrong | known | reveal | first_letter | almost.
    log — что сделано и что ответил сервис (для проверок)."""
    marker = c.data["marker"]
    task = current(u, sid)
    n = 0
    while task is not None:
        n += 1
        check(n < 120, "повторение не закончилось за 120 заданий")
        act = policy(task, n)
        t = task["type"]
        entry: dict[str, Any] = {"task": task, "act": act}
        if t == "intro":
            body: dict[str, Any] = {"known": True} if act == "known" else {}
        elif act == "wrong":
            body = wrong_answer(task, marker)
        elif act == "reveal":
            h = u.ok("POST", f"{rs(sid)}/tasks/{task['task_id']}/hint", json={"kind": "reveal"})
            entry["hint"] = h
            body = right_answer(u, c, task, cache)
        elif act == "first_letter":
            h = u.ok("POST", f"{rs(sid)}/tasks/{task['task_id']}/hint", json={"kind": "first_letter"})
            entry["hint"] = h
            body = right_answer(u, c, task, cache)
        elif act == "almost":
            body = right_answer(u, c, task, cache)
            words = body["text"].split(" ")
            i = next(k for k, w in enumerate(words) if len(re.sub(r"[^A-Za-z]", "", w)) >= 6)
            w = words[i]
            j = max(k for k, ch in enumerate(w) if ch.isalpha())
            words[i] = w[:j] + w[j + 1:]  # одна правка (удалена буква) в слове ≥ 5 букв
            body = {"text": " ".join(words)}
        else:
            body = right_answer(u, c, task, cache)
        entry["body"] = body
        r = post_answer(u, sid, task, body)
        entry["result"] = r
        log.append(entry)
        task = r["next"]


# =============================================================================================== уборка стенда


def cleanup_leftovers() -> list[str]:
    """Остатки прерванного прогона: опубликованные тексты `r-e2e-*` → снять с публикации; статьи методиста с формой
    `pelmar*` → в архив. Только dev-стенд: staff API catalog от имени admin-bff (ключ стенда), как уборка сценариев
    спринтов 2–4."""
    done: list[str] = []
    if s1._psql("SELECT to_regclass('catalog.glossary_entries') IS NOT NULL") != "t":
        return done
    hdr = s2.staff_token("catalog", s3.ALL_PERMS | SPRINT5_PERMS, str(uuid.uuid4()), "super_admin")
    reason = "e2e: уборка после прерванного прогона"
    keys = pj("SELECT coalesce(json_agg(key), '[]') FROM catalog.content_pointers WHERE kind = 'reading' "
              f"AND key LIKE '{READING_PREFIX}%' AND published_version IS NOT NULL") or []
    for key in keys:
        r = httpx.post(f"{s3.CATALOG}/admin/v1/content/reading/{safe_key(key)}/archive", json={"reason": reason},
                       headers={**hdr, **idem()}, timeout=20)
        check(r.status_code == 200, f"уборка: снять {key}: {r.status_code} {r.text[:200]}")
        done.append(f"reading:{key}: снят с публикации")
    ids = pj("SELECT coalesce(json_agg(entry_id), '[]') FROM catalog.glossary_entries WHERE source = 'methodist' "
             f"AND archived_at IS NULL AND lemma LIKE '{METHODIST_WORD}%'") or []
    for eid in ids:
        r = httpx.request("DELETE", f"{s3.CATALOG}/admin/v1/glossary/{s1.uid(eid)}", json={"reason": reason},
                          headers={**hdr, **idem()}, timeout=20)
        check(r.status_code in (200, 204), f"уборка: статья {eid}: {r.status_code} {r.text[:200]}")
        done.append(f"статья методиста {str(eid)[:8]}: в архив")
    return done


def memory_reminder_hours() -> tuple[int, int]:
    """(REMINDER_HOUR, REMINDER_UNTIL_HOUR) процесса memory стенда; не заданы — значения prod (19, 22)."""
    pid_file = s1.ROOT / ".dev" / "run" / "memory.pid"
    found: dict[str, int] = {}
    try:
        pid = int(pid_file.read_text().strip())
        for kv in Path(f"/proc/{pid}/environ").read_bytes().split(b"\x00"):
            name, _, value = kv.decode(errors="replace").partition("=")
            if name in ("REMINDER_HOUR", "REMINDER_UNTIL_HOUR") and value.isdigit():
                found[name] = int(value)
    except (OSError, ValueError):
        pass
    return found.get("REMINDER_HOUR", REMINDER_HOURS[0]), found.get("REMINDER_UNTIL_HOUR", REMINDER_HOURS[1])


# =============================================================================================== шаги


def s_stand(c: s2.Ctx) -> None:
    for name, url in [("memory", f"{MEMORY}/health/ready"), ("catalog", f"{s3.CATALOG}/health/ready"),
                      ("lessons", f"{LESSONS}/health/ready"), ("assessment", f"{ASSESSMENT}/health/ready"),
                      ("ai-gateway", f"{AI_GATEWAY}/health/ready"), ("diagnostics", f"{s3.DIAGNOSTICS}/health/ready"),
                      ("learning-plan", f"{s1.LEARNING_PLAN}/health/ready"),
                      ("notifications", f"{s1.NOTIFICATIONS}/health/ready"), ("audit", f"{s1.AUDIT}/health/ready"),
                      ("identity-consent", f"{s1.IDENTITY}/health/ready"), ("admin-bff", f"{c.bff}/health/ready"),
                      ("telegram-bff", f"{TG_BFF}/health/ready"), ("mock-telegram", f"{s1.MOCK_TG}/health")]:
        r = httpx.get(url, timeout=5)
        check(r.status_code == 200, f"{name} не ready: {r.status_code} {r.text[:200]}")
    # маршруты спринта 5 есть (без сессии — 401, а не 404 «маршрут не найден»)
    missing = []
    for method, path in (("GET", "/v1/memory/overview"), ("GET", "/v1/memory/cards"), ("GET", "/v1/memory/errors"),
                         ("POST", "/v1/memory/review-sessions"), ("GET", "/v1/memory/review-sessions/active"),
                         ("POST", "/v1/memory/translate"), ("POST", "/v1/memory/pronunciation"),
                         ("GET", "/v1/practice/readings"), ("PUT", f"/v1/learners/{uuid.uuid4()}/voice-consent")):
        r = httpx.request(method, f"{TG_BFF}{path}", timeout=5)
        if r.status_code != 401:
            missing.append(f"telegram-bff {method} {path} → {r.status_code}")
    for path in ("/admin/v1/glossary", "/admin/v1/memory/analytics", "/admin/v1/memory/stats",
                 f"/admin/v1/memory/learners/{uuid.uuid4()}", "/admin/v1/content/reading"):
        r = httpx.get(f"{c.bff}{path}", timeout=5)
        if r.status_code != 401:
            missing.append(f"admin-bff GET {path} → {r.status_code}")
    check(not missing, f"маршруты спринта 5 не готовы (BFF): {missing}")
    for line in [*cleanup_leftovers(), *s4.cleanup_leftovers()]:
        print(f"      уборка: {line}", flush=True)
    # сид: 12 текстов (8 взрослых, 4 детских), словарь курса, teaching_coach v2 опубликован, речь — fake
    seed = pj("SELECT json_build_object('readings', (SELECT json_object_agg(cv.key, cv.payload->'audience') FROM "
              "catalog.content_versions cv JOIN catalog.content_pointers p ON p.kind = cv.kind AND p.key = cv.key "
              "AND p.published_version = cv.version WHERE cv.kind = 'reading' AND cv.key NOT LIKE 'r-e2e-%'), "
              "'glossary', (SELECT json_object_agg(source, n) FROM (SELECT source, count(*) n FROM "
              "catalog.glossary_entries WHERE archived_at IS NULL GROUP BY source) g), "
              "'tc', (SELECT published_version FROM ai_gateway.agent_rollout WHERE agent_id = 'teaching_coach'), "
              "'speech', (SELECT json_agg(model_id) FROM ai_gateway.models WHERE provider = 'fake_speech' AND active), "
              "'ai', (SELECT ai_enabled FROM ai_gateway.budget))")
    readings = seed["readings"] or {}
    kids = sorted(k for k, a in readings.items() if a == ["kids"])
    adults = sorted(k for k, a in readings.items() if "adults" in a)
    check(len(readings) >= 12 and len(kids) >= 4 and len(adults) >= 8, f"сид текстов: {readings}")
    check((seed["glossary"] or {}).get("course", 0) >= 100, f"словарь курса: {seed['glossary']}")
    check((seed["tc"] or 0) >= 2 and seed["speech"] and seed["ai"] is True,
          f"teaching_coach v{seed['tc']}, fake-речь {seed['speech']}, ИИ включён {seed['ai']}")
    c.data.update(seed_kids=kids, seed_adults=adults)
    hours = memory_reminder_hours()
    c.data["reminder_hours"] = hours
    print(f"      текстов {len(readings)} (детских {len(kids)}), словарь {seed['glossary']}, teaching_coach "
          f"v{seed['tc']}; окно напоминания memory {hours[0]:02d}:00–{hours[1]:02d}:00", flush=True)
    c.data["dlq_before"] = s1.dlq_counts()
    c.data["policy"] = expect(httpx.get(f"{TG_BFF}/v1/legal/policy", params={"lang": "ru"}), 200)
    c.lc.data["policy"] = c.data["policy"]


# ---------------------------------------------------------------- сотрудники


def s_staff(c: s2.Ctx) -> None:
    s3.warm_admin_identity(c)
    root = Staff(c.browser("root"), s2.BOOT_EMAIL, s2.BOOT_PASSWORD, display_name="Администратор")
    c.staff["root"] = root
    c.remember("пароль bootstrap", s2.BOOT_PASSWORD)
    r = root.browser.post("/admin/v1/auth/login", {"email": s2.BOOT_EMAIL, "password": s2.BOOT_PASSWORD})
    if r.status_code == 401:
        raise StepFailed("bootstrap-учётка уже использована — запускайте `run_local.sh memory` (сбрасывает учётки "
                         "admin-identity)")
    me = s2.login(c, root, expect_next=["password_change", "mfa_enroll", "done"])
    check(me["staff"]["role"] == "super_admin", me["staff"])
    check(SPRINT5_PERMS <= set(me["permissions"]) and set(me["permissions"]) == s4.ALL_PERMS | SPRINT5_PERMS,
          f"права super_admin: {sorted(set(me['permissions']) ^ (s4.ALL_PERMS | SPRINT5_PERMS))}")
    roles = {x["code"]: set(x.get("permissions") or []) for x in expect(root.browser.get("/admin/v1/roles"), 200)["items"]}
    want = {"methodist": ({"memory.read", "glossary.manage"}, {"memory.manage"}),
            "content_manager": ({"glossary.manage"}, {"memory.read", "memory.manage"}),
            "qa_analyst": ({"memory.read"}, {"memory.manage", "glossary.manage"}),
            "analyst": ({"memory.read"}, {"memory.manage", "glossary.manage"}),
            "operations": ({"memory.read", "memory.manage"}, {"glossary.manage"}),
            "auditor": ({"memory.read"}, {"memory.manage", "glossary.manage"})}
    bad = [f"{r}: {sorted(roles.get(r, set()) & SPRINT5_PERMS)}" for r, (has, hasnt) in want.items()
           if not has <= roles.get(r, set()) or hasnt & roles.get(r, set())]
    check(not bad, f"права спринта 5 в матрице ролей (PLAN «Права и роли»): {bad}")
    s2.step_up(root)
    s3._create(c, "m1", "methodist", "Мадина Методист", True)
    s3._create(c, "m2", "methodist", "Мурод Методист", True)
    s3._create(c, "ops", "operations", "Олим Операции", True)
    s3._create(c, "cm", "content_manager", "Камола Контент", True)
    s3._create(c, "qa", "qa_analyst", "Камила QA", False)


def s_staff_login(c: s2.Ctx) -> None:
    for who in ("m1", "m2", "ops", "cm"):
        me = s2.login(c, c.staff[who], expect_next=["password_change", "mfa_enroll", "done"])
        check(me["mfa_enabled"] is True, f"{who}: MFA")
    me = s2.login(c, c.staff["qa"], expect_next=["password_change", "done"])
    check("memory.read" in me["permissions"] and "memory.manage" not in me["permissions"], f"qa: {me['permissions']}")


# ---------------------------------------------------------------- ученики


def s_learners(c: s2.Ctx) -> None:
    lc = c.lc
    z = lc.data["zone_day"]
    for role, name in (("LA", "Азиза"), ("LB", "Бобур"), ("LC", "Сардор"), ("LX", "Хуршид"), ("P", "Парвина")):
        s1.onboard(lc.user(role, name), zone=z)
    # LR — вечернее напоминание: график с напоминаниями (время урока — утром, чтобы не путать с напоминанием урока) и
    # включённая категория «Напоминания» (по умолчанию выключена — opt-in)
    s1.onboard(lc.user("LR", "Рустам"), zone=z, categories={"reminders": True},
               schedule={"reminders_enabled": True, "preferred_time": "09:00"})
    p = lc.users["P"]
    kid_name = f"Камрон {c.tag}K"
    kid = p.ok("POST", "/v1/learners", 201, json={"display_name": kid_name, "age_band": "6-9"}, idem=True)
    c.data.update(kid=kid["learner_id"], kid_name=kid_name)
    check(kid.get("voice_consent") is False, f"детский профиль: voice_consent {kid.get('voice_consent')}")
    p.switch(kid["learner_id"])
    try:
        s1.plan_patch(p, {"goal": "study", "level_self": "zero", "schedule": {
            "preset": "daily", "preferred_time": "17:00", "duration_min": 15, "reminders_enabled": False,
            "timezone": z}})
        p.ok("POST", "/v1/plan/onboarding/complete")
    finally:
        p.switch(p.account_id)
    for role in ("LA", "LB", "LC", "LX", "LR"):
        check(lc.users[role].ok("GET", "/v1/plan")["onboarding_completed_at"], f"{role}: онбординг не завершён")
    c.data["marker"] = f"Zq{c.tag}x"  # маркер текстов учеников: не должен попасть в события, аудит, логи
    c.data["words"] = words_of(c.tag)


# ---------------------------------------------------------------- урок как ученик


def pass_lesson(c: s2.Ctx, u: s1.U, open_text: str) -> dict[str, Any]:
    """Урок плана ученика целиком (как в scenario_lessons): верные ответы по ключам (админка), ролевая ситуация к
    успеху, открытое задание — open_text. → {sid, lesson_id, version, content, summary}."""
    t = u.ok("GET", "/v1/plan/trajectory")
    check(t["next"], f"{u.role}: нет следующего урока")
    lid = t["next"]["lesson_id"]
    card = u.ok("GET", f"/v1/lessons/{lid}")
    s = u.ok("POST", f"/v1/lessons/{lid}/sessions", 201, idem=True)
    sid = s["session_id"]
    content = lesson_content(c, lid, int(card["version"]))
    step = s4.drive(u, sid, s4.cur(u, sid), content, open_text=open_text)
    check(step["type"] == "done", f"урок не дошёл до итогов: {step['type']}")
    summ = s4.finish(u, sid)
    check(summ["evaluation"], f"{u.role}: итоги без оценки")
    return {"sid": sid, "lesson_id": lid, "version": int(card["version"]), "content": content, "summary": summ}


def dictionary(u: s1.U, **params: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cursor = None
    for _ in range(20):
        page = u.ok("GET", "/v1/memory/cards", params={"limit": 100, **params, **({"cursor": cursor} if cursor else {})})
        out += page["items"]
        cursor = page.get("next_cursor")
        if not cursor:
            return out
    raise StepFailed("словарь: больше 20 страниц")


# ---------------------------------------------------------------- AT-53 урок → словарь и журнал ошибок


def s_lesson_cards(c: s2.Ctx) -> None:
    la = c.lc.users["LA"]
    marker = c.data["marker"]
    # открытое задание с двумя типичными ошибками A1 (fake-оценщик: «I want go» → missing_to, «he have» → third_person_s)
    open_text = f"I want go to London and my brother he have two bags. {marker}"
    les = pass_lesson(c, la, open_text)
    c.data["la_lesson"] = les
    lesson = les["content"]["lesson"]
    ev = les["summary"]["evaluation"]
    errs = ev["key_errors"]
    check(errs and all(e["evidence"] and e["correction"] for e in errs), f"ключевые ошибки оценки: {errs}")
    kws = {k["en"]: k for k in lesson["key_words"]}
    text_errs = {e["correction"]: e for e in errs if (e.get("turn_id") or "").startswith(("OA", "T"))}
    check(len(text_errs) >= 2, f"ошибки текста ученика (OA/T) в оценке: {errs}")

    def ready() -> list[dict[str, Any]] | None:
        items = dictionary(la)
        have = {x["text_en"] for x in items}
        return items if set(kws) <= have and set(text_errs) <= have else None

    items = wait_for(ready, 40, interval=1.0, what="карточки урока в словаре (assessment.completed.v1 → memory)")
    by_text = {x["text_en"]: x for x in items}
    check(len(items) == len(kws) + len(text_errs), f"карточек {len(items)}, ожидали {len(kws)} слов + "
          f"{len(text_errs)} ошибок: {sorted(by_text)}")
    now = datetime.now(UTC)
    for en, kw in kws.items():
        x = by_text[en]
        check(x["kind"] == ("word" if len(en.split()) == 1 else "phrase") and x["gloss"] == {"ru": kw["gloss"]["ru"],
              "uz": kw["gloss"]["uz"]} and x["gloss_source"] == "course" and x["status"] == "new"
              and x["strength"] == "new" and x["last_reviewed_at"] is None
              and abs((parse_ts(x["due_at"]) - now).total_seconds()) < 600, f"карточка «{en}»: {x}")
    for corr in text_errs:
        x = by_text[corr]
        check(x["kind"] == "error" and x["status"] == "new" and x["gloss"]["ru"] and x["gloss"]["uz"],
              f"карточка ошибки «{corr}»: {x}")
    # карточка слова: пример, источник (урок), история пуста; озвучка — серверный синтез
    kw0 = next(k for k in lesson["key_words"] if k.get("example_en"))
    d = la.ok("GET", f"/v1/memory/cards/{by_text[kw0['en']]['card_id']}")
    check(d["example_en"] == kw0["example_en"] and d["error"] is None and d["history"] == []
          and [s["kind"] for s in d["sources"]] == ["lesson"] and d["sources"][0]["title"]
          and d["sources"][0]["title"]["ru"] and d["last_pronunciation"] is None, f"карточка слова: {d}")
    sp = la.req("POST", "/v1/speech", json={"text": kw0["en"].replace("…", "").strip(), "variant": "en-US"})
    check(sp.status_code == 200 and sp.headers.get("content-type", "").startswith("audio/mpeg") and sp.content,
          f"озвучка карточки: {sp.status_code} {sp.headers.get('content-type')}")
    # журнал ошибок: исправление, объяснение, без цитаты; цитата — только в карточке ученика
    journal = la.ok("GET", "/v1/memory/errors", params={"limit": 50})["items"]
    jt = {x["correction"]: x for x in journal}
    check(set(jt) == set(text_errs) and all(x["explanation"]["ru"] and x["severity"] in ("low", "medium", "high")
                                            and x["lesson_title"] and x["lesson_title"]["ru"] for x in journal),
          f"журнал ошибок: {journal}")
    check(not keys_named(journal, {"evidence"}) and not any(e["evidence"] in json.dumps(journal, ensure_ascii=False)
                                                           for e in text_errs.values()), "цитата ошибки в журнале")
    # цитата и код — в карточке ошибки; код из закрытого списка оценщика сохраняется как есть (своё объяснение),
    # код вне списка — «other»
    outside = []
    for corr, e in text_errs.items():
        ec = la.ok("GET", f"/v1/memory/cards/{jt[corr]['card_id']}")
        want_code = e["error_code"] if e["error_code"] in EVALUATOR_CODES else "other"
        if want_code == "other" and e["error_code"] != "other":
            outside.append(e["error_code"])
        check(ec["error"] and ec["error"]["correction"] == e["correction"] and ec["error"]["evidence"] == e["evidence"]
              and ec["error"]["error_code"] == want_code and ec["error"]["explanation"]["ru"]
              and (want_code == "other" or ec["error"]["explanation"]["ru"] != OTHER_EXPLANATION_RU),
              f"карточка ошибки «{corr}» ({e['error_code']}): {ec.get('error')}")
    if outside:
        note(f"fake-оценщик (ai-gateway providers/fake.py) выдаёт error_code вне закрытого списка independent_evaluator "
             f"({sorted(set(outside))}) — memory сохраняет их как «other»")
    # без дублей: «в словарь» того же ключевого слова урока — 200, та же карточка; повтор ключа — тот же ответ
    total = len(items)
    key = str(uuid.uuid4())
    body = {"text_en": kw0["en"], "source": {"kind": "lesson", "key": les["lesson_id"], "version": les["version"]}}
    r1 = la.req("POST", "/v1/memory/cards", json=body, idem=key)
    check(r1.status_code == 200 and r1.json()["card_id"] == by_text[kw0["en"]]["card_id"],
          f"повторное «в словарь» слова урока: {r1.status_code} {r1.text[:200]}")
    r2 = la.req("POST", "/v1/memory/cards", json=body, idem=key)
    check(r2.status_code == 200 and r2.json() == r1.json(), f"повтор Idempotency-Key: {r2.status_code}")
    r3 = la.req("POST", "/v1/memory/cards", json=body)
    check(r3.status_code in (400, 422), f"«в словарь» без Idempotency-Key: {r3.status_code}")
    la.ok("POST", "/v1/memory/cards", 422, "WORD_NOT_IN_CONTENT", idem=True,
          json={"text_en": f"spaceship {marker}", "source": body["source"]})
    check(len(dictionary(la)) == total, "дубль карточки после повторного добавления")
    # фильтры и поиск словаря: по английскому и по переводу (RU), вид и статус
    kw_q = next(k for k in lesson["key_words"] if len(k["en"]) >= 5)
    q_en = kw_q["en"].strip("!?.… ")[:5]
    hits = {x["text_en"] for x in dictionary(la, q=q_en)}
    check(kw_q["en"] in hits and len(hits) < total, f"поиск «{q_en}»: {sorted(hits)}")
    q_ru = kw_q["gloss"]["ru"].strip("!?.… ")[:5]
    hits = {x["text_en"] for x in dictionary(la, q=q_ru)}
    check(kw_q["en"] in hits, f"поиск по переводу «{q_ru}»: {sorted(hits)}")
    check({x["text_en"] for x in dictionary(la, kind="error")} == set(text_errs)
          and len(dictionary(la, status="new")) == total and dictionary(la, status="review") == [],
          "фильтры словаря kind/status")
    ov = la.ok("GET", "/v1/memory/overview")
    check(ov["total_cards"] == total and ov["due_count"] == 0 and ov["new_available"] == min(5, total)
          and ov["done_today"] is False and ov["active_session_id"] is None and ov["retention_due"] == 0
          and ov["pronunciation"] == "consent_self", f"обзор: {ov}")
    c.data["la_cards"] = {x["text_en"]: x["card_id"] for x in items}
    c.data["la_errors"] = text_errs
    c.data["la_eval"] = ev["evaluation_id"]
    print(f"      урок {les['lesson_id']}@{les['version']}: карточек {total} ({len(kws)} слов/фраз, "
          f"{len(text_errs)} ошибки), оценка passed={ev['passed']}", flush=True)


def s_reevaluate(c: s2.Ctx) -> None:
    """AT-53: ошибка, снятая переоценкой (QA / апелляция), уходит из словаря и журнала ученика."""
    need(c, "la_lesson", "la_errors")
    la = c.lc.users["LA"]
    m1 = c.staff["m1"]
    les = c.data["la_lesson"]
    card = expect(m1.browser.get(f"/admin/v1/qa/sessions/{les['sid']}"), 200)
    check(card["evaluations"], f"карточка сессии без оценок: {card.get('errors')}")
    ec = card["evaluations"][-1]
    keep, drop = ec["confirmed_errors"][:1], ec["confirmed_errors"][1:]
    check(keep and drop, f"подтверждённых ошибок {len(ec['confirmed_errors'])} — нужно ≥ 2")
    body = {"scores": {x["code"]: x["score"] for x in ec["scores"] if x["score"] is not None and x["code"] != "pronunciation"},
            "skill_outcomes": [{"skill_id": x["skill_id"], "outcome": x["outcome"]} for x in ec["skill_outcomes"]],
            "confirmed_errors": keep, "reason": "QA: ошибка не подтверждается ответом ученика (e2e)"}
    path = f"/admin/v1/qa/evaluations/{ec['evaluation_id']}/reevaluate"
    s2.ensure_step_up(m1)
    new = expect(m1.browser.post(path, body, headers=idem()), 201)
    check(new["supersedes"] == ec["evaluation_id"], f"переоценка: {str(new)[:300]}")
    gone = {e["correction"] for e in drop}
    kept = {e["correction"] for e in keep}

    def applied() -> list[dict[str, Any]] | None:
        j = la.ok("GET", "/v1/memory/errors", params={"limit": 50})["items"]
        return j if {x["correction"] for x in j} == kept else None

    wait_for(applied, 40, interval=1.0, what="журнал ошибок после переоценки (assessment.reevaluated.v1 → memory)")
    dict_texts = {x["text_en"] for x in dictionary(la)}
    check(not (gone & dict_texts) and kept <= dict_texts, f"словарь после переоценки: {sorted(dict_texts)}")
    gone_id = c.data["la_cards"][next(iter(gone))]
    la.ok("GET", f"/v1/memory/cards/{gone_id}", 404, "CARD_NOT_FOUND")
    adm = expect(m1.browser.get(f"/admin/v1/memory/cards/{gone_id}"), 200)
    last = adm["log"]["items"][0]
    check(adm["status"] == "archived" and last["actor"] == "system" and last["reason"] == "reevaluated"
          and last["grade"] is None and last["after"]["status"] == "archived", f"архив ошибки: {adm['status']} {last}")
    c.data["la_archived_error"] = gone_id
    print(f"      переоценка {ec['evaluation_id'][:8]} → {new['evaluation_id'][:8]}: ошибка «{next(iter(gone))}» "
          f"снята, «{next(iter(kept))}» осталась", flush=True)


# ---------------------------------------------------------------- AT-54/55 «Повторение дня» и FSRS


def check_task_shape(task: dict[str, Any], card: dict[str, Any] | None) -> None:
    """Ключа нет в задании: лишних полей нет; для воспроизведения английский ответ не показан."""
    leaks = keys_named(task, KEY_FIELDS)
    check(not leaks, f"ключ ответа в задании {task['type']}: {leaks}")
    p, t = task["prompt"], task["type"]
    if t == "meaning_choice":
        check(p["text_en"] and p["gloss"] is None and task["answer_kind"] == "choice" and len(task["options"]) >= 2
              and task["hints"] == ["reveal"], f"meaning_choice: {task}")
    elif t == "listen_choice":
        check(p["speech_text"] and p["text_en"] is None and task["answer_kind"] == "choice", f"listen_choice: {task}")
    elif t in ("typed", "cloze", "error_fix"):
        check(p["text_en"] is None and p["example_en"] is None and p["speech_text"] is None
              and task["answer_kind"] == "text" and set(task["hints"]) == {"first_letter", "reveal"},
              f"{t}: {task}")
        if card is not None and t != "error_fix":
            ans = answer_text_of(card)
            shown = json.dumps(p, ensure_ascii=False)
            check(ans not in shown or ans in json.dumps(card["gloss"], ensure_ascii=False),
                  f"{t}: ответ «{ans}» виден в задании {p}")
        if t == "cloze":
            check(p["example_gap"] and "___" in p["example_gap"], f"cloze без пропуска: {p}")
    elif t == "intro":
        check(p["text_en"] and p["gloss"] and task["answer_kind"] == "none" and task["hints"] == [],
              f"intro: {task}")
    elif t == "check_item":
        check(task["check"] and task["hints"] == [] and p["prompt_en"] and p["text_en"] is None and p["gloss"] is None,
              f"check_item: {task}")


def s_review_first(c: s2.Ctx) -> None:
    """R1 (день 1): новые карточки — intro → meaning_choice; «Знаю это», выбор (hard), повтор ответа, ошибки 409."""
    need(c, "la_cards")
    la = c.lc.users["LA"]
    ov = la.ok("GET", "/v1/memory/overview")
    check(ov["new_available"] == 5 and ov["due_count"] == 0, f"обзор перед первым повторением: {ov}")
    r = la.req("POST", "/v1/memory/review-sessions")
    check(r.status_code in (400, 422), f"старт без Idempotency-Key: {r.status_code} {r.text[:200]}")
    key = str(uuid.uuid4())
    s = la.ok("POST", "/v1/memory/review-sessions", 201, idem=key)
    sid = s["session_id"]
    check(s["status"] == "active" and s["new_cards"] == 5 and s["cards"] == 5 and s["checks"] == 0
          and s["total_tasks"] == 10 and s["done_tasks"] == 0 and s["finished_at"] is None,
          f"R1: 5 новых карточек → 10 заданий (intro + узнавание): {s}")
    check(la.ok("POST", "/v1/memory/review-sessions", 200, idem=key)["session_id"] == sid, "повтор ключа — другая сессия")
    check(la.ok("POST", "/v1/memory/review-sessions", 200, idem=True)["session_id"] == sid,
          "вторая сессия при незавершённой")
    check(la.ok("GET", "/v1/memory/review-sessions/active")["session"]["session_id"] == sid, "активная сессия")
    check(la.ok("GET", "/v1/memory/overview")["active_session_id"] == sid, "обзор: active_session_id")
    la.ok("POST", f"{rs(sid)}/finish", 409, "TASK_NOT_CURRENT")
    la.ok("POST", f"{rs(sid)}/tasks/{uuid.uuid4()}", 404, json={})
    cache: dict[str, dict[str, Any]] = {}
    log: list[dict[str, Any]] = []
    intros: list[str] = []
    seen_types: list[str] = []

    def policy(task: dict[str, Any], n: int) -> str:
        seen_types.append(task["type"])
        card = card_info(la, task["card_id"], cache) if task["card_id"] else None
        check_task_shape(task, card)
        if task["type"] == "intro":
            intros.append(task["card_id"])
            check(task["prompt"]["text_en"] == card["text_en"] and task["prompt"]["gloss"] == card["gloss"],  # type: ignore[index]
                  f"intro не по карточке: {task['prompt']} / {card}")
            return "known" if len(intros) == 1 else "right"
        if task["type"] == "meaning_choice" and n == 4:
            # «Первая буква» у выбора недоступна; подсказку и ответ — после неё (повтор того же ответа — тот же итог)
            la.ok("POST", f"{rs(sid)}/tasks/{task['task_id']}/hint", 409, "HINTS_NOT_ALLOWED",
                  json={"kind": "first_letter"})
        return "right"

    run_review(c, la, sid, policy, log, cache)
    check(intros and len(intros) == 5, f"intro по 5 новым карточкам: {seen_types}")
    known_card = intros[0]
    check(not any(e["task"]["card_id"] == known_card and e["task"]["type"] != "intro" for e in log),
          f"после «Знаю это» карточка осталась в сессии: {seen_types}")
    graded = [e for e in log if e["task"]["type"] != "intro"]
    check(graded and all(e["result"]["result"] == "correct" for e in graded), "выбор/ввод не засчитан")
    for e in graded:
        res = e["result"]
        want_days = 3 if e["task"]["type"] == "error_fix" else 1  # S₀(good) = 3,173 → 3 дня; S₀(hard) = 1,18 → 1
        check(res["next_review_in_days"] == want_days and res["requeued"] is False and res["correct_answer"],
              f"{e['task']['type']}: next_review_in_days {res['next_review_in_days']} (ожидали {want_days}) {res}")
    # повтор ответа на то же задание (обрыв сети) — тот же результат
    e0 = graded[0]
    again = la.ok("POST", f"{rs(sid)}/tasks/{e0['task']['task_id']}", json=e0["body"])
    check({k: again[k] for k in ("result", "correct_answer", "next_review_in_days", "requeued")}
          == {k: e0["result"][k] for k in ("result", "correct_answer", "next_review_in_days", "requeued")},
          f"повтор ответа — другой итог: {again} / {e0['result']}")
    check(la.ok("GET", f"{rs(sid)}/current", 409, "TASK_NOT_CURRENT").get("details", {}).get("current_task_id") is None,
          "после последнего задания current ≠ 409 TASK_NOT_CURRENT {null}")
    summ = la.ok("POST", f"{rs(sid)}/finish")
    check(summ["status"] == "completed" and summ["reviewed"] == 4 and summ["correct"] == 4 and summ["again"] == 0
          and summ["new_learned"] == 4 and summ["checks"] == [] and summ["minutes"] >= 0
          and summ["next_due_at"] and parse_ts(summ["next_due_at"]) > datetime.now(UTC)
          and summ["due_tomorrow"] >= sum(1 for e in graded if e["result"]["next_review_in_days"] == 1),
          f"итоги R1: {summ}")
    check(la.ok("POST", f"{rs(sid)}/finish") == summ, "повтор finish — другой итог")
    la.ok("POST", f"{rs(sid)}/cancel", 409, "REVIEW_SESSION_STATE")
    kc = la.ok("GET", f"/v1/memory/cards/{known_card}")
    check(kc["status"] == "known" and kc["due_at"] is None and kc["history"] and kc["history"][0]["grade"] is None,
          f"«Знаю это»: статус {kc['status']}, история {kc['history']}")
    check(known_card in {x["card_id"] for x in dictionary(la, status="known")}, "фильтр словаря status=known")
    back = la.ok("DELETE", f"/v1/memory/cards/{known_card}/known")
    check(back["status"] == "new" and back["due_at"], f"вернуть в повторение: {back}")
    ov = la.ok("GET", "/v1/memory/overview")
    check(ov["done_today"] is True and ov["active_session_id"] is None and ov["new_available"] == 0,
          f"обзор после повторения: {ov}")
    body = la.ok("POST", "/v1/memory/review-sessions", 409, "NOTHING_TO_REVIEW", idem=True)
    check("next_due_at" in (body.get("details") or {}), f"NOTHING_TO_REVIEW: {body}")
    c.data["review_log"] = {"R1": log}
    c.data["la_known"] = known_card
    c.data["la_r1"] = sid
    print(f"      R1: заданий {len(log)} ({Counter(seen_types)}), «Знаю это» — 1, итог {summ['reviewed']} повторено, "
          f"следующее {summ['next_due_at']}", flush=True)


def s_review_later(c: s2.Ctx) -> None:
    """R2 (через 10 дней): узнавание — выбор (hard), неверно (again → повтор в конце), «Не помню»; R3 (ещё через 5 дней):
    воспроизведение — ввод (good), «Первая буква» (hard), опечатка (almost → hard), неверно, «Не помню»."""
    need(c, "la_r1")
    la = c.lc.users["LA"]
    uid = la.learner_id
    # ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: «прошло 10 дней» — сроки карточек и прошлые сессии повторения LA
    shift_cards(uid, 10)
    shift_sessions(uid, 10)
    cache: dict[str, dict[str, Any]] = {}
    coverage: Counter[str] = Counter()
    # ---- R2
    s = la.ok("POST", "/v1/memory/review-sessions", 201, idem=True)
    sid2 = s["session_id"]
    check(s["cards"] >= 4 and s["new_cards"] >= 1, f"R2: к сроку и новые: {s}")
    log2: list[dict[str, Any]] = []
    plan2 = iter(["wrong", "reveal"])
    acted: dict[str, str] = {}

    def policy2(task: dict[str, Any], n: int) -> str:
        card = card_info(la, task["card_id"], cache) if task["card_id"] else None
        check_task_shape(task, card)
        t = task["type"]
        if t in ("meaning_choice", "listen_choice") and task["card_id"] not in acted:
            act = next(plan2, "right")
            acted[task["card_id"]] = act
            return act
        return "right"

    run_review(c, la, sid2, policy2, log2, cache)
    for e in log2:
        t, act, res = e["task"]["type"], e["act"], e["result"]
        if t in ("meaning_choice", "listen_choice") and act == "right" and e["task"]["card_id"] in acted:
            if acted[e["task"]["card_id"]] in ("wrong", "reveal"):  # повтор карточки с again в конце сессии
                check(res["requeued"] is False, f"повтор карточки снова поставлен в очередь: {res}")
                coverage["requeued_answered"] += 1
                continue
        if t in ("meaning_choice", "listen_choice") and act == "right":
            check(res["result"] == "correct" and res["requeued"] is False, f"выбор: {res}")
            coverage["choice_hard"] += 1
        elif act == "wrong":
            check(res["result"] == "incorrect" and res["requeued"] is True and res["correct_answer"]
                  and res["next_review_in_days"] == 1, f"неверный выбор → again и повтор в конце: {res}")
            coverage["again_requeue"] += 1
        elif act == "reveal":
            check(e["hint"]["kind"] == "reveal" and e["hint"]["text"] == res["correct_answer"] and res["requeued"] is True,
                  f"«Не помню» → ответ показан, again и повтор в конце: {e['hint']} {res}")
            coverage["reveal_again"] += 1
    requeued = [e for e in log2 if e["task"]["card_id"] in acted and acted[e["task"]["card_id"]] in ("wrong", "reveal")
                and e["act"] == "right" and e["task"]["type"] != "intro"]
    check(len(requeued) == 2 and all(e is not log2[0] for e in requeued)
          and log2.index(requeued[0]) > max(i for i, e in enumerate(log2) if e["act"] in ("wrong", "reveal")),
          f"карточки с again — один раз в конце сессии: {[(e['task']['type'], e['act']) for e in log2]}")
    sm2 = la.ok("POST", f"{rs(sid2)}/finish")
    check(sm2["again"] == 2 and sm2["reviewed"] >= 4 and sm2["correct"] == sm2["reviewed"] - 2,
          f"итоги R2 (again 2): {sm2}")
    # ---- R3: «прошло ещё 5 дней» — у карточек с двумя hard S ≥ 3 → воспроизведение
    shift_cards(uid, 5)
    shift_sessions(uid, 5)
    s = la.ok("POST", "/v1/memory/review-sessions", 201, idem=True)
    sid3 = s["session_id"]
    log3: list[dict[str, Any]] = []
    pending3 = ["right", "first_letter", "almost", "wrong", "reveal"]  # по приоритету покрытия
    acted3: dict[str, str] = {}

    def policy3(task: dict[str, Any], n: int) -> str:
        card = card_info(la, task["card_id"], cache) if task["card_id"] else None
        check_task_shape(task, card)
        if task["type"] in ("typed", "cloze", "error_fix") and task["card_id"] not in acted3:
            long_word = any(len(re.sub(r"[^A-Za-z]", "", w)) >= 6
                            for w in answer_text_of(card).split())  # type: ignore[arg-type]
            act = next((a for a in pending3 if a != "almost" or long_word), "right")
            if act in pending3:
                pending3.remove(act)
            acted3[task["card_id"]] = act
            return act
        return "right"

    run_review(c, la, sid3, policy3, log3, cache)
    prod = [e for e in log3 if e["task"]["type"] in ("typed", "cloze", "error_fix") and e["task"]["card_id"] in acted3
            and e is next(x for x in log3 if x["task"]["card_id"] == e["task"]["card_id"]
                          and x["task"]["type"] in ("typed", "cloze", "error_fix"))]
    check(len(prod) >= 2, f"R3: заданий воспроизведения {len(prod)} (нужно ≥ 2): {[e['task']['type'] for e in log3]}")
    for e in prod:
        act, res = e["act"], e["result"]
        if act == "right":
            check(res["result"] == "correct" and res["next_review_in_days"] >= 1 and res["requeued"] is False, res)
            coverage["typed_good"] += 1
        elif act == "first_letter":
            ans = res["correct_answer"] or ""
            check(e["hint"]["text"].endswith("…") and ans.lower().startswith(e["hint"]["text"][:-1].lower())
                  and res["result"] == "correct" and res["requeued"] is False, f"первая буква: {e['hint']} {res}")
            coverage["first_letter_hard"] += 1
        elif act == "almost":
            check(res["result"] == "almost" and res["requeued"] is False and res["correct_answer"],
                  f"опечатка → almost (hard): {res}")
            coverage["almost_hard"] += 1
        elif act == "wrong":
            check(res["result"] == "incorrect" and res["requeued"] is True and res["correct_answer"], f"неверно: {res}")
            coverage["typed_again"] += 1
        elif act == "reveal":
            check(res["requeued"] is True and e["hint"]["text"] == res["correct_answer"], f"«Не помню»: {res}")
            coverage["typed_reveal"] += 1
    sm3 = la.ok("POST", f"{rs(sid3)}/finish")
    check(sm3["status"] == "completed" and sm3["reviewed"] >= len(prod), f"итоги R3: {sm3}")
    need_cov = {"choice_hard", "again_requeue", "reveal_again", "typed_good", "first_letter_hard"}
    check(need_cov <= set(coverage), f"не покрыты варианты ответа: {sorted(need_cov - set(coverage))} ({coverage})")
    if "typed_again" not in coverage or "almost_hard" not in coverage:
        print(f"      R3: заданий воспроизведения {len(prod)} — покрыто {dict(coverage)}", flush=True)
    c.data["review_log"].update(R2=log2, R3=log3)
    c.data["la_sessions"] = [c.data["la_r1"], sid2, sid3]
    print(f"      R2: {len(log2)} заданий, R3: {len(log3)} заданий ({Counter(e['task']['type'] for e in log3)}); "
          f"покрыто {dict(coverage)}", flush=True)


def s_fsrs_history(c: s2.Ctx) -> None:
    """AT-55: история планирования в админке: было/стало, fsrs-5, версия параметров; S, D и срок — по формулам."""
    need(c, "la_sessions")
    la = c.lc.users["LA"]
    m1 = c.staff["m1"]
    cards = [x for x in dictionary(la) if x["status"] in ("learning", "review")]
    check(cards, "нет карточек с историей")
    rows_checked = grades = 0
    seen_grades: Counter[str] = Counter()
    for x in cards:
        d = expect(m1.browser.get(f"/admin/v1/memory/cards/{x['card_id']}"), 200)
        log = list(d["log"]["items"])
        cur = d["log"].get("next_cursor")
        while cur:
            page = expect(m1.browser.get(f"/admin/v1/memory/cards/{x['card_id']}/log", params={"cursor": cur}), 200)
            log += page["items"]
            cur = page.get("next_cursor")
        check(d["user_id"] == la.learner_id and "evidence" not in json.dumps(d, ensure_ascii=False),
              f"карточка в админке: {str(d)[:200]}")
        for row in reversed(log):  # от старых к новым
            check(row["algorithm"] == "fsrs-5" and row["params_version"] == "fsrs5-default-1"
                  and row["actor"] in ("learner", "system", "staff") and row["grade"] in (None, "again", "hard", "good"),
                  f"строка истории: {row}")
            check(set(row["before"]) >= {"state", "stability", "difficulty", "due_at", "status"}
                  and set(row["after"]) >= {"state", "stability", "difficulty", "due_at", "status"}, f"было/стало: {row}")
            if row["grade"] is None:
                continue
            seen_grades[row["grade"]] += 1
            grades += 1
            if row["answer_mode"] in ("choice", "listen"):
                check(row["grade"] in ("again", "hard"), f"выбор оценён выше hard: {row}")
            if row["hinted"] or row["revealed"]:
                check(row["grade"] in ("again", "hard") and (not row["revealed"] or row["grade"] == "again"),
                      f"подсказка/раскрытие: {row}")
            s_exp, d_exp = fsrs_expected(row["before"], row["grade"], row["elapsed_days"])
            s_got, d_got = float(row["after"]["stability"]), float(row["after"]["difficulty"])
            check(abs(s_got - s_exp) <= 1e-3 * max(1.0, s_exp) and abs(d_got - d_exp) <= 1e-3 * max(1.0, d_exp),
                  f"FSRS: {row['before']} + {row['grade']} (t={row['elapsed_days']}) → S {s_got}, D {d_got}; "
                  f"по формулам S {s_exp:.5f}, D {d_exp:.5f}")
            due = parse_ts(row["after"]["due_at"]) - parse_ts(row["at"])
            check(abs(due.total_seconds() - fsrs_interval(s_exp) * 86400) < 120,
                  f"срок: {row['after']['due_at']} − {row['at']} = {due}, интервал по формуле {fsrs_interval(s_exp)} дн.")
            if row["before"]["state"] == "new":
                check(row["elapsed_days"] is None and row["after"]["state"] in ("learning", "review"), f"первая: {row}")
            rows_checked += 1
    check(rows_checked >= 10 and {"again", "hard", "good"} <= set(seen_grades),
          f"оценок в истории {rows_checked}: {dict(seen_grades)}")
    # «easy» не ставится нигде: ни в истории, ни в итогах и ответах сессий
    blob = json.dumps(c.data["review_log"], ensure_ascii=False)
    check('"easy"' not in blob, "easy в ответах повторения")
    print(f"      история: {rows_checked} оценок сверены с FSRS-5 ({dict(seen_grades)}), easy — нет", flush=True)


# ---------------------------------------------------------------- AT-56 проверки удержания


def run_retention(c: s2.Ctx, u: s1.U, skill: str, correct: bool, stage: str) -> dict[str, Any]:
    """Повторение с проверкой удержания навыка: задания без подсказок (409), итог в конце блока."""
    cache: dict[str, dict[str, Any]] = {}
    s = u.ok("POST", "/v1/memory/review-sessions", 201, idem=True)
    sid = s["session_id"]
    check(s["checks"] >= 1, f"{u.role}: проверка {stage} не попала в повторение: {s}")
    log: list[dict[str, Any]] = []
    blocks: dict[str, list[dict[str, Any]]] = {}

    def policy(task: dict[str, Any], n: int) -> str:
        check_task_shape(task, card_info(u, task["card_id"], cache) if task["card_id"] else None)
        if task["type"] == "check_item":
            blocks.setdefault(task["check"]["check_id"], []).append(task)
            if len(blocks) == 1 and len(blocks[task["check"]["check_id"]]) == 1:
                for kind in ("first_letter", "reveal"):
                    u.ok("POST", f"{rs(sid)}/tasks/{task['task_id']}/hint", 409, "HINTS_NOT_ALLOWED",
                         json={"kind": kind})
            return "check_right" if correct else "check_wrong"
        return "right"

    def run() -> None:
        task = current(u, sid)
        n = 0
        while task is not None:
            n += 1
            act = policy(task, n)
            if act.startswith("check_"):
                body = check_answer(task, control_item_of(c, task), correct=act == "check_right")
            elif task["type"] == "intro":
                body = {}
            else:
                body = right_answer(u, c, task, cache)
            r = post_answer(u, sid, task, body)
            log.append({"task": task, "act": act, "body": body, "result": r})
            task = r["next"]

    run()
    checks = [e for e in log if e["task"]["type"] == "check_item"]
    check(checks, f"{u.role}: заданий проверки нет")
    by_check: dict[str, list[dict[str, Any]]] = {}
    for e in checks:
        by_check.setdefault(e["task"]["check"]["check_id"], []).append(e)
    results: dict[str, dict[str, Any]] = {}
    for cid, es in by_check.items():
        for e in es[:-1]:
            check(e["result"]["result"] is None and e["result"]["correct_answer"] is None
                  and e["result"]["check_result"] is None, f"правильность до конца блока проверки: {e['result']}")
        last = es[-1]["result"]
        cr = last["check_result"]
        check(cr and cr["total"] == len(es) and len(cr["items"]) == len(es) and cr["passed"] is correct
              and cr["correct"] == (len(es) if correct else 0) and all(i["correct_answer"] for i in cr["items"])
              and last["correct_answer"] is None and last["next_review_in_days"] is None,
              f"итог блока проверки: {last}")
        check(2 <= len(es) <= 3 and es[0]["task"]["check"]["of"] == len(es), f"заданий в проверке {len(es)}")
        results[cid] = cr
    summ = u.ok("POST", f"{rs(sid)}/finish")
    want = [x for x in summ["checks"] if x["stage"] == stage]
    check(want and all(x["passed"] is correct and x["skill_retained"] == (correct and stage == "d30")
                       and x["skill_title"]["ru"] for x in want), f"итоги: проверки {summ['checks']}")
    return {"sid": sid, "summary": summ, "checks": results, "log": log}


def skill_map(u: s1.U) -> dict[str, dict[str, Any]]:
    return {x["skill_id"]: x for x in u.ok("GET", "/v1/skills/map")["skills"]}


def demonstrate(c: s2.Ctx, u: s1.U) -> str:
    """Урок без ошибок → основной навык «демонстрирует» (diagnostics) → memory ставит проверку d7."""
    les = pass_lesson(c, u, "I want to go to London and my brother has two bags.")
    ev = les["summary"]["evaluation"]
    skill = les["content"]["lesson"]["primary_skill_id"]
    check(ev["passed"] is True, f"{u.role}: урок без ошибок не зачтён: {str(ev)[:300]}")
    wait_for(lambda: skill_map(u).get(skill, {}).get("state") == "demonstrated", 40, interval=1.0,
             what=f"{u.role}: навык {skill} → demonstrated")
    ov = wait_for(lambda: (o := u.ok("GET", "/v1/memory/overview")) and o["total_cards"] > 0 and o, 40, interval=1.0,
                  what=f"{u.role}: карточки урока")
    check(ov["retention_due"] == 0, f"проверка d7 со сроком сразу после урока: {ov}")
    return skill


def s_retention_pass(c: s2.Ctx) -> None:
    """AT-56: demonstrated → d7 (через 7 дней, без подсказок) → d30 → retained в карте навыков."""
    lb = c.lc.users["LB"]
    m1 = c.staff["m1"]
    skill = demonstrate(c, lb)
    c.data["lb_skill"] = skill

    def scheduled() -> list[dict[str, Any]] | None:
        sm = expect(m1.browser.get(f"/admin/v1/memory/learners/{lb.learner_id}"), 200)
        rows = [x for x in sm["checks"] if x["skill_id"] == skill and x["stage"] == "d7" and x["status"] == "scheduled"]
        return rows or None

    rows = wait_for(scheduled, 40, interval=1.0, what="проверка d7 (skills.state.changed.v1 → memory)")
    d7_due = parse_ts(rows[0]["due_at"])
    check(abs((d7_due - datetime.now(UTC)).total_seconds() - 7 * 86400) < 600, f"срок d7 через 7 дней: {rows[0]}")
    # ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: «прошло 7 дней» — срок d7 наступил (активность была — урок сегодня)
    check(shift_checks_due(lb.learner_id, skill), "сдвиг d7: строк нет")
    check(lb.ok("GET", "/v1/memory/overview")["retention_due"] >= 1, "обзор: проверка со сроком")
    r7 = run_retention(c, lb, skill, True, "d7")
    after7 = expect(m1.browser.get(f"/admin/v1/memory/learners/{lb.learner_id}"), 200)["checks"]
    done7 = [x for x in after7 if x["skill_id"] == skill and x["stage"] == "d7" and x["status"] == "passed"]
    d30 = [x for x in after7 if x["skill_id"] == skill and x["stage"] == "d30" and x["status"] == "scheduled"]
    check(done7 and done7[0]["result"] and done7[0]["result"]["correct"] >= 2 and d30,
          f"после d7: {[(x['stage'], x['status'], x['result']) for x in after7 if x['skill_id'] == skill]}")
    time.sleep(1.5)
    check(skill_map(lb)[skill]["state"] == "demonstrated", "d7 изменил состояние навыка")
    # ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: «прошло 30 дней с demonstrated» — срок d30 наступил
    check(shift_checks_due(lb.learner_id, skill), "сдвиг d30: строк нет")
    run_retention(c, lb, skill, True, "d30")
    mp = wait_for(lambda: (m := skill_map(lb)) and m[skill]["state"] == "retained" and m, 40, interval=1.0,
                  what=f"навык {skill} → retained (memory.retention.checked.v1 → diagnostics)")
    check(any(h["source"] == "retention" for h in mp[skill]["history"]), f"история навыка: {mp[skill]['history']}")
    c.data["lb_retained"] = True
    print(f"      {skill}: d7 {sum(len(v['items']) for v in r7['checks'].values())} заданий — пройдена → d30 — пройдена "
          f"→ retained", flush=True)


def s_retention_fail(c: s2.Ctx) -> None:
    """AT-56: два провала подряд → навык снова learning."""
    lc_ = c.lc.users["LC"]
    m1 = c.staff["m1"]
    skill = demonstrate(c, lc_)
    wait_for(lambda: any(x["skill_id"] == skill and x["status"] == "scheduled" for x in expect(
        m1.browser.get(f"/admin/v1/memory/learners/{lc_.learner_id}"), 200)["checks"]), 40, interval=1.0,
        what="проверка d7 у LC")
    check(shift_checks_due(lc_.learner_id, skill), "сдвиг d7: строк нет")
    # нет активности 14 дней (ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: дни активности LC — на 20 дней в прошлое) → tick не проваливает
    # проверку, а переносит срок на +1 день; первое повторение после возвращения её берёт
    shift_rows(f"UPDATE memory.activity_days SET local_date = local_date - 20 WHERE user_id = '{s1.uid(lc_.learner_id)}' "
               "RETURNING user_id", "дни активности LC −20 дн.")
    res = memory_tick()
    rows = expect(m1.browser.get(f"/admin/v1/memory/learners/{lc_.learner_id}"), 200)["checks"]
    moved = [x for x in rows if x["skill_id"] == skill and x["status"] == "scheduled"]
    check(res["checks_postponed"] >= 1 and moved and moved[0]["consecutive_failures"] == 0
          and 0 < (parse_ts(moved[0]["due_at"]) - datetime.now(UTC)).total_seconds() <= 86400 + 120,
          f"нет активности 14 дней → срок +1 день: tick {res}, проверка {moved[:1]}")
    check(lc_.ok("GET", "/v1/memory/overview")["retention_due"] >= 1, "перенесённая проверка не ждёт повторения")
    run_retention(c, lc_, skill, False, "d7")
    rows = expect(m1.browser.get(f"/admin/v1/memory/learners/{lc_.learner_id}"), 200)["checks"]
    retry = [x for x in rows if x["skill_id"] == skill and x["status"] == "scheduled"]
    check(retry and retry[0]["stage"] == "d7" and retry[0]["consecutive_failures"] == 1
          and abs((parse_ts(retry[0]["due_at"]) - datetime.now(UTC)).total_seconds() - 3 * 86400) < 600,
          f"после первого провала — повтор той же стадии через 3 дня: {rows[:3]}")
    time.sleep(1.5)
    check(skill_map(lc_)[skill]["state"] == "demonstrated", "первый провал изменил состояние навыка")
    check(shift_checks_due(lc_.learner_id, skill), "сдвиг повтора d7: строк нет")
    run_retention(c, lc_, skill, False, "d7")
    wait_for(lambda: skill_map(lc_)[skill]["state"] == "learning", 40, interval=1.0,
             what=f"навык {skill} → learning после двух провалов")
    rows = expect(m1.browser.get(f"/admin/v1/memory/learners/{lc_.learner_id}"), 200)["checks"]
    check(not [x for x in rows if x["skill_id"] == skill and x["status"] == "scheduled"]
          and [x["consecutive_failures"] for x in rows if x["skill_id"] == skill and x["status"] == "failed"][:1] == [2],
          f"цепочка закончена: {[(x['stage'], x['status'], x['consecutive_failures']) for x in rows]}")
    print(f"      {skill}: нет активности 14 дней → срок +1 день; d7 провал → повтор через 3 дня → провал → learning",
          flush=True)


# ---------------------------------------------------------------- AT-60 текст для чтения и словарь курса


def reading_payload(c: s2.Ctx) -> dict[str, Any]:
    w = c.data["words"]
    mark = s3.mark_of(c)

    def s(sid: str, en: str, ru: str, uz: str) -> dict[str, Any]:
        return {"s_id": sid, "text_en": en, "gloss": {"ru": ru, "uz": uz}}

    def loc(ru: str, uz: str) -> dict[str, str]:
        return {"ru": ru, "uz": uz}

    return {
        "reading_id": c.data["reading_key"],
        "title": loc(f"Магазин Тома {mark}", f"Tomning doʻkoni {mark}"),
        "level": "A1", "audience": ["teens", "adults"], "topics": ["food"], "skill_ids": ["en.read.signs-menus"],
        "paragraphs": [
            {"p_id": "p1", "sentences": [
                s("s1", "Tom works in a small shop in the city.", "Том работает в маленьком магазине в городе.",
                  "Tom shahardagi kichik doʻkonda ishlaydi."),
                s("s2", "Every morning he opens the shop at eight o'clock.", "Каждое утро он открывает магазин в восемь.",
                  "Har kuni ertalab u doʻkonni soat sakkizda ochadi."),
                s("s3", f"He sells fresh bread, cheese and a sweet {w['g1']} cake.",
                  f"Он продаёт свежий хлеб, сыр и сладкий пирог {w['g1']}.",
                  f"U yangi non, pishloq va shirin {w['g1']} pirogini sotadi."),
                s("s4", f"People like his {w['g2']} very much.", f"Людям очень нравится его {w['g2']}.",
                  f"Odamlarga uning {w['g2']}i juda yoqadi."),
                s("s5", f"His friend Anna brings a {w['g3']} from the market.",
                  f"Его подруга Анна приносит {w['g3']} с рынка.",
                  f"Uning dugonasi Anna bozordan {w['g3']} olib keladi."),
            ]},
            {"p_id": "p2", "sentences": [
                s("s6", f"Today Tom has a new box of {w['ai']} tea.", f"Сегодня у Тома новая коробка чая {w['ai']}.",
                  f"Bugun Tomda yangi bir quti {w['ai']} choyi bor."),
                s("s7", f"Anna says the {w['m']} is wonderful and beautiful.",
                  f"Анна говорит, что {w['m']} чудесный и красивый.",
                  f"Anna {w['m']} ajoyib va chiroyli deydi."),
                s("s8", f"They drink tea together and talk about the {w['ai2']} day.",
                  f"Они вместе пьют чай и говорят о дне {w['ai2']}.",
                  f"Ular birga choy ichishadi va {w['ai2']} kuni haqida gaplashishadi."),
                s("s9", "In the evening Tom closes the shop and goes home.",
                  "Вечером Том закрывает магазин и идёт домой.", "Kechqurun Tom doʻkonni yopib, uyga ketadi."),
            ]},
        ],
        "glossary": [
            {"en": w["g1"], "gloss": loc(f"пирог {w['g1']}", f"{w['g1']} pirogi"), "note": None},
            {"en": w["g2"], "gloss": loc(f"выпечка {w['g2']}", f"{w['g2']} pishiriq"),
             "note": loc("Название выпечки из текста.", "Matndagi pishiriq nomi.")},
            {"en": w["g3"], "gloss": loc(f"корзина {w['g3']}", f"{w['g3']} savat"), "note": None},
        ],
        "questions": [
            {"question_id": "q1", "type": "single_choice", "instruction": loc("Выберите верный ответ.", "Toʻgʻri javobni tanlang."),
             "prompt_en": "Where does Tom work?", "options": ["In a shop", "In a school", "In a bank"], "answer": 0},
            {"question_id": "q2", "type": "true_false", "instruction": loc("Верно ли это?", "Bu toʻgʻrimi?"),
             "prompt_en": "Tom opens the shop at eight o'clock.", "options": ["True", "False"], "answer": 0},
            {"question_id": "q3", "type": "gap_fill", "instruction": loc("Вставьте слово.", "Soʻzni qoʻying."),
             "prompt_en": "In the evening Tom closes the ___.", "options": [], "answer": ["shop"]},
        ],
        "voice": "en-GB", "est_minutes": 5,
    }


def glossary_rows(b: s2.Browser, **params: str) -> list[dict[str, Any]]:
    return expect(b.get("/admin/v1/glossary", params={"pair_id": PAIR, "limit": "50", **params}), 200)["items"]


def glossary_entry(b: s2.Browser, form: str) -> dict[str, Any]:
    rows = [x for x in glossary_rows(b, q=form) if form in x["forms"]]
    check(len(rows) == 1, f"статья словаря с формой «{form}»: {rows}")
    return rows[0]


def s_reading_admin(c: s2.Ctx) -> None:
    """AT-60: текст для чтения — черновик → проверка вторым методистом → публикация (step-up), как уроки."""
    m1, m2, cm, qa = (c.staff[k] for k in ("m1", "m2", "cm", "qa"))
    b = m1.browser
    key = f"{READING_PREFIX}{c.tag.lower()}"
    c.data["reading_key"] = key
    payload = reading_payload(c)
    bad = copy.deepcopy(payload)
    bad["glossary"] = bad["glossary"][:2]
    bad["paragraphs"][0]["sentences"][0]["gloss"]["uz"] = ""
    created = expect(b.post("/admin/v1/content/reading", {"payload": bad}, headers=idem()), 201)
    check(created["version"] == 1 and created["status"] == "draft" and created["author_name"] == m1.display_name,
          f"черновик текста: {created['status']} {created.get('author_name')}")
    c.data["reading_draft"] = True
    body = expect(b.post(s3.content_path("reading", key, 1, "/submit")), 422, "CONTENT_INVALID")
    errs = s3.errors_of(body)
    check(("payload.glossary", "COUNT_OUT_OF_RANGE") in errs
          and any(p.startswith("payload.paragraphs[0].sentences[0].gloss.uz") for p, _ in errs),
          f"ошибки отправки (глоссарий < 3, нет перевода UZ): {errs}")
    cur = expect(b.get(s3.content_path("reading", key, 1)), 200)
    s3.put_version(b, "reading", key, 1, payload, cur["payload_hash"])
    sub = expect(b.post(s3.content_path("reading", key, 1, "/submit")), 200)
    check(sub["status"] == "in_review", sub["status"])
    expect(b.post(s3.content_path("reading", key, 1, "/review"), s3.review_ok()), 409, "SELF_REVIEW")
    denied = s3.rbac_denied(qa.browser, "POST", s3.content_path("reading", key, 1, "/review"), s3.review_ok(),
                            "content.review")
    check(denied is None, denied)
    rv = expect(m2.browser.post(s3.content_path("reading", key, 1, "/review"), s3.review_ok()), 200)
    check(rv["status"] == "approved" and rv["reviewer_name"] == m2.display_name, f"проверка: {rv['status']}")
    denied = s3.rbac_denied(cm.browser, "POST", s3.content_path("reading", key, 1, "/publish"),
                            {"reason": "e2e: попытка"}, "content.publish")
    check(denied is None, denied)
    if not s3.step_up_active(m1, min_left=1):
        body = expect(b.post(s3.content_path("reading", key, 1, "/publish"), {"reason": "e2e: публикация текста"},
                             headers=idem()), 403, "STEP_UP_REQUIRED")
        check(body["details"].get("permission") == "content.publish", body)
    s2.ensure_step_up(m1)
    pub = expect(b.post(s3.content_path("reading", key, 1, "/publish"), {"reason": "e2e: публикация текста"},
                        headers=idem()), 200)
    check(pub["status"] == "published" and pub["published_by_name"] == m1.display_name, f"публикация: {pub['status']}")
    c.data["reading_published"] = True
    c.data["reading_version"] = 1
    print(f"      текст {key}: черновик → 422 → правка → проверка ({m2.display_name}) → публикация", flush=True)


def s_glossary_admin(c: s2.Ctx) -> None:
    """AT-60: словарь курса — список, карточка с историей, статья методиста, FORM_TAKEN, If-Match, override у course."""
    need(c, "reading_published")
    m1, cm, qa = c.staff["m1"], c.staff["cm"], c.staff["qa"]
    b = m1.browser
    w = c.data["words"]
    key = c.data["reading_key"]
    rows = glossary_rows(b)
    check(rows and all(set(r) >= {"entry_id", "lemma", "forms", "gloss", "source", "review_status", "refs_count"}
                       for r in rows), f"список словаря: {rows[:2]}")
    g1 = wait_for(lambda: [x for x in glossary_rows(b, q=w["g1"]) if w["g1"] in x["forms"]], 30, interval=1.0,
                  what="статья course из глоссария нового текста")[0]
    check(g1["source"] == "course" and g1["review_status"] == "not_required" and g1["refs_count"] == 1
          and g1["overridden"] is False, f"статья course: {g1}")
    d = expect(b.get(f"/admin/v1/glossary/{g1['entry_id']}"), 200)
    check(d["refs"] == [{"kind": "reading", "key": key, "version": 1}] and d["refs_titles"][0]["title"]
          and d["history"] and d["history"][0]["action"] == "created", f"карточка статьи: {str(d)[:400]}")
    # статья методиста: создание, занятая форма, If-Match
    denied = s3.rbac_denied(qa.browser, "POST", "/admin/v1/glossary", {"pair_id": PAIR, "lemma": w["m"],
                                                                       "forms": [w["m"]], "part_of_speech": "noun",
                                                                       "gloss": {"ru": "x", "uz": "x"},
                                                                       "example_en": None, "reason": None},
                            "glossary.manage")
    check(denied is None, denied)
    body = {"pair_id": PAIR, "lemma": w["m"], "forms": [w["m"]], "part_of_speech": "noun",
            "gloss": {"ru": f"пельмар {c.tag}", "uz": f"pelmar {c.tag}"},
            "example_en": f"Anna says the {w['m']} is wonderful and beautiful.", "reason": "e2e: статья методиста"}
    me = expect(b.post("/admin/v1/glossary", body, headers=idem()), 201)
    check(me["source"] == "methodist" and me["review_status"] == "not_required" and me["forms"] == [w["m"]]
          and me["updated_by_name"] == m1.display_name and me["history"][0]["action"] == "created",
          f"статья методиста: {str(me)[:300]}")
    c.data["methodist_entry"] = me["entry_id"]
    taken = expect(b.post("/admin/v1/glossary", {**body, "lemma": w["g1"], "forms": [w["g1"]]}, headers=idem()), 409,
                   "FORM_TAKEN")
    check((taken.get("details") or {}).get("entry_id") == g1["entry_id"], f"FORM_TAKEN: {taken}")
    path = f"/admin/v1/glossary/{me['entry_id']}"
    patch = {"gloss": {"ru": f"пельмар (исправлено) {c.tag}", "uz": f"pelmar (tuzatildi) {c.tag}"},
             "reason": "e2e: уточнён перевод"}
    expect(b.request("PATCH", path, json_body=patch), 428, "IF_MATCH_REQUIRED")
    expect(b.request("PATCH", path, json_body=patch, headers={"if-match": "2020-01-01T00:00:00Z"}), 409,
           "VERSION_CONFLICT")
    up = expect(b.request("PATCH", path, json_body=patch, headers={"if-match": me["updated_at"]}), 200)
    check(up["gloss"] == patch["gloss"] and up["updated_at"] != me["updated_at"]
          and [h["action"] for h in up["history"]][:2] in (["updated", "created"], ["created", "updated"]),
          f"правка статьи методиста: {str(up)[:300]}")
    c.data["methodist_gloss"] = patch["gloss"]
    # статья course: только override (перевод поверх контента)
    gpath = f"/admin/v1/glossary/{g1['entry_id']}"
    gd = expect(b.get(gpath), 200)
    r = b.request("PATCH", gpath, json_body={"gloss": {"ru": "x", "uz": "x"}, "reason": "e2e"},
                  headers={"if-match": gd["updated_at"]})
    j = r.json() if r.content else {}
    locked = r.status_code == 409 and j.get("code") == "COURSE_ENTRY_LOCKED"
    locked_422 = r.status_code == 422 and any(e.get("code") == "COURSE_ENTRY_LOCKED"
                                             for e in (j.get("details") or {}).get("errors") or [])
    check(locked or locked_422, f"правка перевода статьи course: {r.status_code} {str(j)[:200]}")
    if locked_422:
        note("catalog: правка полей статьи course → 422 GLOSSARY_INVALID {errors: [COURSE_ENTRY_LOCKED]}, а admin.ts "
             "(«Память, словарь курса, чтение») перечисляет COURSE_ENTRY_LOCKED среди кодов 409 — уточнить контракт")
    ov = {"gloss": {"ru": f"пирог-бримо (поправка) {c.tag}", "uz": f"brimo pirogi (tuzatish) {c.tag}"},
          "example_en": None}
    od = expect(b.request("PATCH", gpath, json_body={"override": ov, "reason": "e2e: поправка перевода"},
                          headers={"if-match": gd["updated_at"]}), 200)
    check(od["override"] and od["override"]["gloss"] == ov["gloss"] and od["gloss"] == ov["gloss"]
          and od["source"] == "course" and od["history"][0]["action"] == "overridden", f"override: {str(od)[:300]}")
    check(glossary_entry(b, w["g1"])["overridden"] is True, "строка списка: overridden")
    c.data["override_gloss"] = ov["gloss"]
    # content_manager тоже ведёт словарь (glossary.manage), но память ученика ему не видна
    check(expect(cm.browser.get(f"/admin/v1/glossary/{me['entry_id']}"), 200)["entry_id"] == me["entry_id"],
          "content_manager: карточка статьи")
    st = expect(b.get("/admin/v1/glossary/stats", params={"pair_id": PAIR}), 200)
    check(st["entries"]["methodist"] >= 1 and st["overridden"] >= 1 and isinstance(st["ai_glosses_pending"], int),
          f"счётчики словаря: {st}")
    print(f"      словарь: course «{w['g1']}» → override; статья методиста «{w['m']}» (FORM_TAKEN, 428/409, правка)",
          flush=True)


# ---------------------------------------------------------------- AT-57 чтение ученика


def translate(u: s1.U, text: str, ref: dict[str, Any], status: int = 200, code: str | None = None) -> dict[str, Any]:
    return u.ok("POST", "/v1/memory/translate", status, code, json={"text": text, "content": ref})


def s_reading_learner(c: s2.Ctx) -> None:
    need(c, "reading_published", "methodist_entry")
    la, p = c.lc.users["LA"], c.lc.users["P"]
    m1 = c.staff["m1"]
    w = c.data["words"]
    key = c.data["reading_key"]
    marker = c.data["marker"]
    # список: взрослому — взрослые тексты (и новый), без детских
    lst = la.ok("GET", "/v1/practice/readings", params={"limit": 50})["items"]
    ids = {x["reading_id"] for x in lst}
    check(key in ids and set(c.data["seed_adults"]) <= ids and not ids & set(c.data["seed_kids"]),
          f"тексты взрослого: {sorted(ids)}")
    a1 = {x["reading_id"] for x in la.ok("GET", "/v1/practice/readings", params={"level": "A1", "limit": 50})["items"]}
    check(key in a1 and all(x["level"] == "A1" for x in lst if x["reading_id"] in a1), f"фильтр уровня: {a1}")
    me = next(x for x in lst if x["reading_id"] == key)
    check(me["title"]["ru"].startswith("Магазин Тома") and me["est_minutes"] == 5 and me["word_count"] >= 60
          and me["last_result"] is None, f"карточка текста: {me}")
    # ребёнку — только детские тексты, взрослый текст недоступен
    p.switch(c.data["kid"])
    try:
        kid_ids = {x["reading_id"] for x in p.ok("GET", "/v1/practice/readings", params={"limit": 50})["items"]}
        check(kid_ids and kid_ids <= set(c.data["seed_kids"]), f"тексты ребёнка: {sorted(kid_ids)}")
        p.ok("GET", f"/v1/practice/readings/{key}", 404, "READING_NOT_AVAILABLE")
        p.ok("POST", f"/v1/practice/readings/{key}/sessions", 404, "READING_NOT_AVAILABLE", idem=True)
        kv = p.ok("GET", f"/v1/practice/readings/{sorted(kid_ids)[0]}")
        c.data["kid_reading"] = (kv["reading_id"], kv["version"], kv["paragraphs"][0]["sentences"][0])
        # ребёнок: «в словарь» из детского текста, повторение — не больше 3 новых в день, журнала ошибок нет
        kref = {"kind": "reading", "key": kv["reading_id"], "version": kv["version"]}
        for g in kv["glossary"][:4]:
            tk = translate(p, g["en"], kref)
            check(tk["gloss"] and tk["source"] == "course", f"ребёнок: перевод слова глоссария {tk}")
            p.ok("POST", "/v1/memory/cards", 201, json={"text_en": g["en"], "source": kref}, idem=True)
        check(p.ok("GET", "/v1/memory/overview")["new_available"] == 3, "ребёнок: новых в день — 3")
        ks = p.ok("POST", "/v1/memory/review-sessions", 201, idem=True)
        check(ks["new_cards"] == 3 and ks["total_tasks"] == 6, f"детское повторение: {ks}")
        run_review(c, p, ks["session_id"], lambda t, n: "right", [], {})
        km = p.ok("POST", f"{rs(ks['session_id'])}/finish")
        check(km["reviewed"] == 3 and km["status"] == "completed", f"итоги детского повторения: {km}")
        check(p.ok("GET", "/v1/memory/errors")["items"] == [], "у ребёнка журнал ошибок")
    finally:
        p.switch(p.account_id)
    # текст без ответов; глоссарий подсвечен
    v = la.ok("GET", f"/v1/practice/readings/{key}")
    check(v["version"] == 1 and len([s for pp in v["paragraphs"] for s in pp["sentences"]]) == 9
          and [g["en"] for g in v["glossary"]] == [w["g1"], w["g2"], w["g3"]]
          and all(g["in_dictionary"] is None for g in v["glossary"]) and v["questions_count"] == 3
          and set(v["question_types"]) <= {"single_choice", "true_false", "gap_fill"},
          f"текст: {str(v)[:400]}")
    check(not keys_named(v, {"answer", "questions"}), "ответы вопросов в тексте для ученика")
    ref = {"kind": "reading", "key": key, "version": 1}
    # тап по слову глоссария: перевод словаря курса (с поправкой методиста), слово методиста
    t1 = translate(la, w["g1"], {**ref, "locator": "s3"})
    check(t1["source"] == "course" and t1["gloss"] == c.data["override_gloss"] and t1["ai_unreviewed"] is False
          and t1["reason"] is None and t1["in_dictionary"] is None, f"перевод слова глоссария (override): {t1}")
    t2 = translate(la, w["g2"], ref)
    check(t2["source"] == "course" and t2["gloss"]["ru"] == f"выпечка {w['g2']}" and t2["note"]
          and t2["note"]["ru"] == "Название выпечки из текста.", f"перевод слова глоссария (+ пояснение): {t2}")
    tm = translate(la, w["m"], {**ref, "locator": "s7"})
    check(tm["source"] == "methodist" and tm["gloss"] == c.data["methodist_gloss"] and tm["ai_unreviewed"] is False,
          f"перевод — статья методиста: {tm}")
    # слово не из глоссария → перевод ИИ (fake) с пометкой «проверяется методистом»
    ta = translate(la, w["ai"], {**ref, "locator": "s6"})
    check(ta["source"] == "ai" and ta["ai_unreviewed"] is True and ta["gloss"] == {"ru": f"[ru] {w['ai']}",
          "uz": f"[uz] {w['ai']}"} and ta["lemma"] == w["ai"], f"перевод ИИ: {ta}")
    check(translate(la, w["ai"], ref) == ta, "повторный тап — другой ответ (кеш)")
    # свободный текст и слово не из этого текста в ИИ не уходят
    translate(la, f"spaceship {marker}", ref, 422, "WORD_NOT_IN_CONTENT")
    translate(la, w["ai"], {**ref, "locator": "s1"}, 422, "WORD_NOT_IN_CONTENT")
    translate(la, "Tom", {**ref, "version": 99}, 404, "CONTENT_NOT_FOUND")
    # очередь переводов ИИ у методиста → исправление → ученик видит исправленный перевод
    q = wait_for(lambda: [x for x in glossary_rows(m1.browser, review_status="pending", q=w["ai"])
                          if w["ai"] in x["forms"]], 30, interval=1.0, what="перевод ИИ в очереди методиста")[0]
    check(q["source"] == "ai" and q["confidence"] == 0.9 and q["refs_count"] == 1, f"строка очереди: {q}")
    qd = expect(m1.browser.get(f"/admin/v1/glossary/{q['entry_id']}"), 200)
    check(qd["agent_version"] and qd["agent_version"].startswith("teaching_coach@") and qd["corrected"] is False
          and la.learner_id not in json.dumps(qd) and la.account_id not in json.dumps(qd),
          f"карточка перевода ИИ: {str(qd)[:300]}")
    fixed = {"ru": f"зорвик (исправлено) {c.tag}", "uz": f"zorvik (tuzatildi) {c.tag}"}
    rv = expect(m1.browser.post(f"/admin/v1/glossary/{q['entry_id']}/review",
                                {"decision": "correct", "gloss": fixed, "note": "e2e: исправлен перевод ИИ"}), 200)
    check(rv["review_status"] == "approved" and rv["corrected"] is True and rv["gloss"] == fixed, f"решение: {rv}")
    expect(m1.browser.post(f"/admin/v1/glossary/{q['entry_id']}/review", {"decision": "approve"}), 409, "NOT_PENDING")
    c.data["ai_entry"] = q["entry_id"]
    tf = wait_for(lambda: (t := translate(la, w["ai"], ref)) and t["gloss"] == fixed and t, 30, interval=1.0,
                  what="исправление методиста у ученика (catalog.glossary.changed.v1 → сброс кеша memory)")
    check(tf["source"] == "ai" and tf["ai_unreviewed"] is False, f"перевод после исправления: {tf}")
    # «в словарь»: слово глоссария и слово с исправленным переводом ИИ
    r = la.ok("POST", "/v1/memory/cards", 201, json={"text_en": w["g2"], "source": {**ref, "locator": "s4"}}, idem=True)
    check(r["kind"] == "word" and r["gloss_source"] == "course" and r["status"] == "new", f"«в словарь»: {r}")
    again = la.ok("POST", "/v1/memory/cards", 200, json={"text_en": w["g2"], "source": ref}, idem=True)
    check(again["card_id"] == r["card_id"], "«в словарь» второй раз — дубль")
    ra = la.ok("POST", "/v1/memory/cards", 201, json={"text_en": w["ai"], "source": ref}, idem=True)
    check(ra["gloss"] == fixed and ra["gloss_source"] == "ai", f"«в словарь» слова с переводом ИИ: {ra}")
    la.ok("POST", "/v1/memory/cards", 422, "WORD_NOT_IN_CONTENT", idem=True,
          json={"text_en": f"my own text {marker}", "source": ref})
    # убрать из словаря и вернуть: карточка та же (история планирования сохраняется)
    la.req("DELETE", f"/v1/memory/cards/{ra['card_id']}").raise_for_status()
    check(ra["card_id"] not in {x["card_id"] for x in dictionary(la)}, "удалённая карточка в словаре")
    la.ok("GET", f"/v1/memory/cards/{ra['card_id']}", 404, "CARD_NOT_FOUND")
    rb = la.req("POST", "/v1/memory/cards", json={"text_en": w["ai"], "source": ref}, idem=True)
    check(rb.status_code in (200, 201) and rb.json()["card_id"] == ra["card_id"] and rb.json()["status"] == "new",
          f"вернуть удалённое слово: {rb.status_code} {rb.text[:200]}")
    v2 = la.ok("GET", f"/v1/practice/readings/{key}")
    check(next(g for g in v2["glossary"] if g["en"] == w["g2"])["in_dictionary"] == r["card_id"],
          f"глоссарий: in_dictionary {v2['glossary']}")
    check(translate(la, w["g2"], ref)["in_dictionary"] == r["card_id"], "перевод: in_dictionary")
    c.data["la_reading_card"] = r["card_id"]
    # вопросы на понимание — практика (practice_only), навыки не меняются
    before = {k: (x["state"], len(x["history"])) for k, x in skill_map(la).items()}
    payload = admin_payload(c, "reading", key, 1)
    qs = {q["question_id"]: q for q in payload["questions"]}
    s = la.ok("POST", f"/v1/practice/readings/{key}/sessions", 201, idem=True)
    sid = s["session_id"]
    check(s["kind"] == "reading" and [x["type"] for x in s["stages"]] == ["reading", "questions", "summary"],
          f"сессия чтения: {str(s)[:300]}")
    step = s4.cur(la, sid)
    check(step["type"] == "reading" and step["reading"]["reading_id"] == key and not keys_named(step, {"answer"}),
          f"шаг чтения: {str(step)[:300]}")
    step = s4.post_step(la, sid, step, {})["next"]
    want: dict[str, bool] = {}
    while step["type"] == "item":
        it = step["item"]
        check(step["graded_later"] is True and step["hint_available"] is False and it["item_id"] in qs,
              f"вопрос: {str(step)[:300]}")
        if not want:
            la.ok("POST", f"/v1/sessions/{sid}/steps/{step['step_id']}/hint", 409, "HINTS_NOT_ALLOWED")
        qq = qs[it["item_id"]]
        ok = it["item_id"] != "q2"  # второй вопрос — с ошибкой
        if qq["type"] == "gap_fill":
            ans: Any = qq["answer"][0] if ok else "school"
        else:
            check(it["options"] == qq["options"], f"варианты {it['options']} ≠ {qq['options']}")
            ans = int(qq["answer"]) if ok else 1 - int(qq["answer"])
        r = s4.post_step(la, sid, step, {"answer": ans})
        check(r["feedback"] is None, "правильность показана до итогов")
        want[it["item_id"]] = ok
        step = r["next"]
    check(step["type"] == "done" and set(want) == set(qs), f"вопросы: {want}; последний шаг {step['type']}")
    summ = s4.finish(la, sid)
    ev = summ["evaluation"]
    check(summ["kind"] == "reading" and summ["skills"] == [] and ev and ev["practice_only"] is True
          and {i["item_id"]: i["correct"] for i in ev["items"]} == want and ev["evaluator"] is None,
          f"итоги чтения: {str(summ)[:400]}")
    time.sleep(2.0)
    after = {k: (x["state"], len(x["history"])) for k, x in skill_map(la).items()}
    check(after == before, f"чтение изменило навыки: {[k for k in after if after[k] != before.get(k)]}")
    card = wait_for(lambda: next((x for x in la.ok("GET", "/v1/practice/readings", params={"limit": 50})["items"]
                                  if x["reading_id"] == key and x["last_result"]), None), 20, interval=1.0,
                    what="последний результат чтения в списке")
    check(card["last_result"]["correct"] == 2 and card["last_result"]["total"] == 3, f"last_result: {card}")
    c.data["reading_session"] = sid
    print("      чтение: course/override, методист, ИИ → исправлен методистом; «в словарь» 2; вопросы 2/3 "
          "(practice_only)", flush=True)


# ---------------------------------------------------------------- AT-58 произношение


def s_pronunciation(c: s2.Ctx) -> None:
    need(c, "reading_published", "la_cards")
    la, lb, p = c.lc.users["LA"], c.lc.users["LB"], c.lc.users["P"]
    key = c.data["reading_key"]
    w = c.data["words"]
    audio_mark = f"AUDIOe2e{c.tag}"
    c.data["audio_marker"] = audio_mark
    tone = wav(2000, 9000, marker=audio_mark)
    target_s7 = f"sentence:reading:{key}:1:s7"
    card_id = c.data["la_cards"][c.data["la_lesson"]["content"]["lesson"]["key_words"][0]["en"]]
    # без согласия — 403 {who: self}; обзор: consent_self
    check(la.ok("GET", "/v1/memory/overview")["pronunciation"] == "consent_self", "обзор без согласия")
    r = pron(la, target_s7, tone)
    j = expect(r, 403, "VOICE_CONSENT_REQUIRED")
    check((j.get("details") or {}).get("who") == "self", f"VOICE_CONSENT_REQUIRED: {j}")
    # своё согласие на запись голоса (настройки) → можно
    pol = c.data["policy"]
    la.ok("POST", "/v1/profile/consent", json={"policy_version": pol["version"], "purposes": [*REQUIRED, VOICE]})
    me = next(x for x in la.ok("GET", "/v1/learners")["items"] if x["learner_id"] == la.learner_id)
    check(me["voice_consent"] is True, f"LearnerSummary.voice_consent: {me}")
    check(wait_for(lambda: la.ok("GET", "/v1/memory/overview")["pronunciation"] == "available", 20, interval=1.0,
                   what="обзор: произношение доступно"), "обзор")
    r = pron(la, target_s7, tone)
    pv = expect(r, 200)
    ref_text = f"Anna says the {w['m']} is wonderful and beautiful."
    long_words = [x for x in re.findall(r"[A-Za-z']+", ref_text) if len(x) >= 8]
    check(pv["status"] == "ok" and pv["reference_text"] == ref_text and is_uuid(pv["attempt_id"])
          and isinstance(pv["score"], (int, float)) and 0 <= pv["score"] <= 100
          and pv["intelligibility"] in ("clear", "mostly_clear", "needs_practice") and pv["message"] is None,
          f"оценка: {pv}")
    words = {x["word"].strip(".,!?").lower(): x for x in pv["words"]}
    check(set(words) >= {x.lower() for x in re.findall(r"[A-Za-z']+", ref_text)},
          f"слова эталона в результате: {sorted(words)}")
    bad = [x for x in pv["words"] if x["error_type"] == "mispronunciation"]
    check(len(bad) == len(long_words) and all((x["accuracy"] or 0) < 60 for x in bad)
          and all(x["error_type"] == "none" and (x["accuracy"] or 0) >= 60 for x in pv["words"] if x not in bad),
          f"слова (fake: ≥ 8 букв — mispronunciation 55): {pv['words']}")
    check(1 <= len(pv["tips"]) <= 2 and len(pv["tips"]) == min(2, len(bad))
          and all(t["word"].strip(".,!?").lower() in {x["word"].strip(".,!?").lower() for x in bad} and t["text"]
                  for t in pv["tips"]) and not any("акцент" in t["text"].lower() for t in pv["tips"]),
          f"советы (≤ 2, без «акцента»): {pv['tips']}")
    # по карточке словаря; повтор — новая попытка
    pc = expect(pron(la, f"card:{card_id}", wav(1500, 9000, marker=audio_mark)), 200)
    check(pc["status"] == "ok" and pc["attempt_id"] != pv["attempt_id"], f"по карточке: {pc}")
    lp = la.ok("GET", f"/v1/memory/cards/{card_id}")["last_pronunciation"]
    check(lp and lp["intelligibility"] == pc["intelligibility"], f"последняя попытка в карточке: {lp}")
    # тишина → «не удалось оценить»
    ps = expect(pron(la, target_s7, wav(1500, 0, marker=audio_mark)), 200)
    check(ps["status"] == "insufficient_evidence" and ps["score"] is None and ps["words"] == [] and ps["tips"] == []
          and ps["message"] and ps["message"]["ru"], f"тишина: {ps}")
    # битые записи → 422 AUDIO_INVALID {reason}
    for body, ctype, reason in ((b"ID3" + os.urandom(2000), "audio/wav", "format"),
                                (wav(300, 9000), "audio/wav", "too_short"),
                                (wav(16_000, 9000), "audio/wav", "too_long"),
                                (wav(1000, 9000, rate=8000), "audio/wav", "format"),
                                (wav(1000, 9000), "audio/mpeg", "format")):
        j = expect(pron(la, target_s7, body, ctype), 422, "AUDIO_INVALID")
        check((j.get("details") or {}).get("reason") == reason, f"AUDIO_INVALID {reason}: {j}")
    # чужая карточка → 404; несуществующее предложение → 404
    expect(pron(lb, f"card:{card_id}", tone), 404)
    expect(pron(la, f"sentence:reading:{key}:1:s99", tone), 404)
    # ребёнок: без согласия родителя — {who: guardian}; родитель включает в карточке ребёнка → можно
    rid, ver, sent = c.data["kid_reading"]
    kid_target = f"sentence:reading:{rid}:{ver}:{sent['s_id']}"
    p.switch(c.data["kid"])
    try:
        check(p.ok("GET", "/v1/memory/overview")["pronunciation"] == "consent_guardian", "ребёнок: consent_guardian")
        j = expect(pron(p, kid_target, tone), 403, "VOICE_CONSENT_REQUIRED")
        check((j.get("details") or {}).get("who") == "guardian", f"ребёнок без согласия родителя: {j}")
    finally:
        p.switch(p.account_id)
    kid_sum = p.ok("PUT", f"/v1/learners/{c.data['kid']}/voice-consent", json={"granted": True})
    check(kid_sum["voice_consent"] is True and kid_sum["kind"] == "child", f"согласие родителя: {kid_sum}")
    c.data["kid_voice"] = True
    try:
        p.switch(c.data["kid"])
        try:
            kp = expect(pron(p, kid_target, tone), 200)
            check(kp["status"] == "ok" and kp["reference_text"] == sent["text_en"]
                  and not any("акцент" in t["text"].lower() for t in kp["tips"]), f"ребёнок с согласием: {kp}")
        finally:
            p.switch(p.account_id)
    finally:
        p.ok("PUT", f"/v1/learners/{c.data['kid']}/voice-consent", json={"granted": False})
        c.data["kid_voice"] = False
    p.switch(c.data["kid"])
    try:
        j = expect(pron(p, kid_target, tone), 403, "VOICE_CONSENT_REQUIRED")
        check((j.get("details") or {}).get("who") == "guardian", f"после отзыва согласия родителем: {j}")
    finally:
        p.switch(p.account_id)
    c.data["pron_attempts"] = [pv["attempt_id"], pc["attempt_id"], ps["attempt_id"]]
    # затраты учтены (usage ai-gateway: pronunciation_coach, длительность аудио); стоимость fake — 0
    ops = c.staff["ops"]
    sm = expect(ops.browser.get("/admin/v1/ai/usage/summary", params={"period": "month"}), 200)
    check(any(x["agent_id"] == "pronunciation_coach" and x["calls"] >= 3 for x in sm["by_agent"]),
          f"затраты: pronunciation_coach в сводке {[x['agent_id'] for x in sm['by_agent']]}")
    use = pj("SELECT json_build_object('n', count(*), 'ms', coalesce(sum(audio_ms), 0), 'cost', coalesce(sum(cost_usd), 0), "
             "'models', json_agg(DISTINCT model_id)) FROM ai_gateway.usage WHERE agent_id = 'pronunciation_coach' "
             f"AND user_id = '{s1.uid(la.learner_id)}'")
    check(use["n"] >= 3 and use["ms"] >= 4500 and float(use["cost"]) == 0 and use["models"] == ["fake-speech"],
          f"usage произношения LA: {use}")
    print(f"      произношение: 403 self → согласие → ok ({len(pv['words'])} слов, советов {len(pv['tips'])}), "
          f"тишина → insufficient_evidence, 5 × AUDIO_INVALID; ребёнок: guardian → согласие родителя → ok → отзыв",
          flush=True)


# ---------------------------------------------------------------- ИИ и речь выключены (аварийная остановка)


def s_ai_off(c: s2.Ctx) -> None:
    """ИИ и речь необязательны (бриф спринта 5): при аварийной остановке «Произнести» скрыто (unavailable, 503
    SPEECH_UNAVAILABLE), перевод ИИ → «перевода нет» (показать перевод предложения), словарь курса, словарь ученика и
    повторение работают. Остановка снимается в finally (исходное состояние — в lessons-restore.json, как у L15)."""
    need(c, "reading_published", "la_cards")
    la, ops = c.lc.users["LA"], c.staff["ops"]
    w = c.data["words"]
    key = c.data["reading_key"]
    ref = {"kind": "reading", "key": key, "version": 1}
    b0 = expect(ops.browser.get("/admin/v1/ai/budget"), 200)
    check(b0["ai_enabled"] is True, f"ИИ выключен до шага: {b0}")
    s4.save_restore(budget=b0)
    try:
        s2.ensure_step_up(ops)
        st = expect(ops.browser.post("/admin/v1/ai/emergency-stop", {"enabled": True, "reason": "e2e: ИИ и речь "
                                                                     "выключены (память)"}, headers=idem()), 200)
        check(st["ai_enabled"] is False, f"аварийная остановка: {st}")
        wait_for(lambda: la.ok("GET", "/v1/memory/overview")["pronunciation"] == "unavailable", 30, interval=1.0,
                 what="обзор: произношение unavailable (кнопка «Произнести» скрыта)")
        expect(pron(la, f"sentence:reading:{key}:1:s1", wav(1000, 9000)), 503, "SPEECH_UNAVAILABLE")
        t = translate(la, w["ai2"], ref)
        check(t["gloss"] is None and t["source"] is None and t["reason"] == "not_available"
              and t["ai_unreviewed"] is False, f"перевод ИИ при выключенном ИИ: {t}")
        t3 = translate(la, w["g3"], ref)
        check(t3["source"] == "course" and t3["gloss"], f"словарь курса при выключенном ИИ: {t3}")
        check(dictionary(la), "словарь ученика при выключенном ИИ")
        r = la.req("POST", "/v1/memory/review-sessions", idem=True)
        check(r.status_code in (200, 201) or (r.status_code == 409 and r.json().get("code") == "NOTHING_TO_REVIEW"),
              f"повторение при выключенном ИИ: {r.status_code} {r.text[:200]}")
        if r.status_code in (200, 201):
            la.ok("POST", f"{rs(r.json()['session_id'])}/cancel")
    finally:
        s2.ensure_step_up(ops)
        st = expect(ops.browser.post("/admin/v1/ai/emergency-stop", {"enabled": False, "reason": "e2e: ИИ снова "
                                                                     "включён"}, headers=idem()), 200)
        check(st["ai_enabled"] is True, f"ИИ не включён обратно: {st}")
        s4.drop_restore("budget")
    wait_for(lambda: la.ok("GET", "/v1/memory/overview")["pronunciation"] == "available", 30, interval=1.0,
             what="обзор: произношение снова available")
    c.data["ai_off_checked"] = True
    print("      остановка ИИ: произношение unavailable/503, перевод ИИ — «нет перевода», словарь курса и повторение "
          "работают; ИИ включён обратно", flush=True)


# ---------------------------------------------------------------- AT-59 вечернее напоминание


def reminder_zone(hours: tuple[int, int]) -> str | None:
    """Пояс, где сейчас начало окна напоминания: [начало, начало + 2 ч) и не позже конца окна − 5 мин (уведомление
    позже 19:00 + 3 ч notifications кладёт только в центр — берём ближе к началу окна)."""
    lo = hours[0] * 60
    hi = min(hours[1] * 60 - 5, lo + 120)
    try:
        return s1.pick_zone(datetime.now(UTC), lo, hi, lo + 30) if hi > lo else None
    except StepFailed:
        return None


def projection(user_id: str) -> dict[str, Any] | None:
    """Проекция плана в memory (learning.plan.updated.v1) — только чтение: tick смотрит пояс и напоминания отсюда."""
    return pj("SELECT row_to_json(p) FROM (SELECT timezone, reminders_enabled FROM memory.learner_projection "
              f"WHERE user_id = '{s1.uid(user_id)}') p")


def reviews_due_events(user_id: str, since: int) -> list[dict[str, Any]]:
    return pj("SELECT coalesce(json_agg(envelope->'payload' ORDER BY created_at), '[]') FROM memory.outbox WHERE "
              f"envelope->>'event_type' = 'memory.reviews.due.v1' AND envelope->'payload'->>'user_id' = "
              f"'{s1.uid(user_id)}' AND created_at >= to_timestamp({int(since)})") or []


def s_reminder(c: s2.Ctx) -> None:
    lr = c.lc.users["LR"]
    since = c.data["started_at"]
    uid = lr.learner_id
    hours = c.data.get("reminder_hours", REMINDER_HOURS)
    # 5 слов «в словарь» из опубликованного текста (урока сегодня не было — день графика ещё не засчитан)
    rid = "r-a0-new-group"
    v = lr.ok("GET", f"/v1/practice/readings/{rid}")
    ref = {"kind": "reading", "key": rid, "version": v["version"]}
    for g in v["glossary"][:5]:
        lr.ok("POST", "/v1/memory/cards", 201, json={"text_en": g["en"], "source": ref}, idem=True)
    check(lr.ok("GET", "/v1/plan/today")["done_today"] is False, "день графика засчитан без занятия")
    # повторили, но не закончили (отмена — день графика не засчитывается): карточки learning/review
    s = lr.ok("POST", "/v1/memory/review-sessions", 201, idem=True)
    log: list[dict[str, Any]] = []
    run_review(c, lr, s["session_id"], lambda t, n: "right", log, {})
    cs = lr.ok("POST", f"{rs(s['session_id'])}/cancel")
    check(cs["status"] == "cancelled" and cs["done_tasks"] == cs["total_tasks"] == 10, f"отмена: {cs}")
    cards = [x for x in dictionary(lr) if x["status"] in ("learning", "review")]
    check(len(cards) == 5, f"карточки после повторения: {[(x['text_en'], x['status']) for x in cards]}")
    # ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: повторение «позавчера» (местная дата сессии — по прежнему поясу плана, а пояс сейчас
    # сменится на 19:xx, где может быть ещё вчерашняя дата) и наступивший срок у 4 карточек из 5
    shift_sessions(uid, 2)
    ids = [x["card_id"] for x in cards]
    shift_cards(uid, 1.01, card_ids=ids[:4])
    ov = lr.ok("GET", "/v1/memory/overview")
    check(ov["due_count"] == 4 and ov["done_today"] is False, f"обзор LR: {ov}")
    # пояс, где сейчас начало окна напоминания (19:xx–20:xx)
    zone = reminder_zone(hours)
    if zone is None:
        raise StepFailed(f"нет часового пояса, где сейчас {hours[0]:02d}:00–{hours[1]:02d}:00 (окно memory)")
    local = s1.loc(datetime.now(UTC), zone)
    # ученик в другом поясе (сейчас там днём, вне окна) — напоминания нет
    check(memory_tick()["reminders_sent"] >= 0, "tick")
    check(not reviews_due_events(uid, since), "напоминание не в 19:00 по поясу плана")
    # пояс плана (и уведомлений) → 19:xx; проекция memory обновилась
    s1.plan_patch(lr, {"schedule": {"timezone": zone}})
    lr.ok("PATCH", "/v1/profile/settings", json={"notifications": {"timezone": zone}})
    wait_for(lambda: (pr := projection(uid)) and pr["timezone"] == zone and pr["reminders_enabled"] is True, 30,
             interval=0.5, what="проекция пояса плана в memory (learning.plan.updated.v1)")
    seq = s1.tg_last_seq()
    memory_tick()
    check(not reviews_due_events(uid, since), "напоминание при 4 карточках к сроку (нужно ≥ 5)")
    shift_cards(uid, 1.01, card_ids=ids[4:])
    res = memory_tick()
    evs = reviews_due_events(uid, since)
    check(len(evs) == 1 and evs[0]["due_count"] == 5 and evs[0]["timezone"] == zone
          and evs[0]["local_date"] == s1.loc(datetime.now(UTC), zone).date().isoformat(),
          f"memory.reviews.due.v1: {evs} (tick {res})")
    msgs = wait_for(lambda: s1.tg_sent(lr.tg_id, seq, contains="Пора повторить слова"), 30, interval=1.0,
                    what="уведомление reviews_due в Telegram (notifications)")
    text = msgs[0]["payload"]["text"]
    check("Пора повторить слова: 5" in text and "около 2 минут" in text and s1.startapp_of(msgs[0]["payload"])
          == "route_review", f"уведомление: {text[:200]} / {s1.startapp_of(msgs[0]['payload'])}")
    inbox = [x for x in lr.inbox() if "Пора повторить слова" in x["body"]]
    check(len(inbox) == 1 and inbox[0]["category"] == "reminders" and inbox[0]["startapp"] == "route_review",
          f"центр уведомлений: {inbox}")
    # повторный tick — без второго напоминания
    memory_tick()
    time.sleep(1.5)
    check(len(reviews_due_events(uid, since)) == 1 and len(s1.tg_sent(lr.tg_id, seq, contains="Пора повторить")) == 1,
          "второе напоминание в тот же день")
    # повторение засчитывается в день графика (learning-plan)
    s = lr.ok("POST", "/v1/memory/review-sessions", 201, idem=True)
    check(s["cards"] == 5 and s["new_cards"] == 0, f"повторение по напоминанию: {s}")
    time.sleep(1.1)  # активное время сессии > 0 → минуты ≥ 1
    run_review(c, lr, s["session_id"], lambda t, n: "right", [], {})
    sm = lr.ok("POST", f"{rs(s['session_id'])}/finish")
    check(sm["status"] == "completed" and sm["reviewed"] == 5 and sm["minutes"] >= 1, f"итоги: {sm}")
    today = wait_for(lambda: (t := lr.ok("GET", "/v1/plan/today"))["done_today"] and t, 30, interval=1.0,
                     what="день графика засчитан повторением (memory.review.completed.v1 → learning-plan)")
    check(today["minutes_today"] >= 1 and today["streak_days"] >= 1, f"план дня: {today}")
    c.data["reminder_done"] = zone
    print(f"      пояс {zone} ({local:%H:%M}): 4 к сроку — нет, 5 — memory.reviews.due.v1 → Telegram и центр; "
          f"повторный tick — без второго; повторение засчитано (минут {today['minutes_today']})", flush=True)


# ---------------------------------------------------------------- AT-61 «Память» в админке, аналитика


def s_memory_admin(c: s2.Ctx) -> None:
    need(c, "la_sessions")
    la = c.lc.users["LA"]
    ops, m1, cm, qa, root = (c.staff[k] for k in ("ops", "m1", "cm", "qa", "root"))
    uid = la.learner_id
    # сводка (memory.read): статусы, к сроку, повторения, проверки — без PII
    sm = expect(qa.browser.get(f"/admin/v1/memory/learners/{uid}"), 200)
    mine = dictionary(la)
    check(sm["user_id"] == uid and sm["pair_id"] == PAIR and sum(sm["cards_by_status"].values()) >= len(mine)
          and sm["cards_by_status"]["archived"] >= 1 and sm["reviews_30d"] >= 10 and sm["last_review_at"],
          f"сводка памяти: {sm}")
    blob = json.dumps(sm, ensure_ascii=False)
    check(la.first not in blob and str(la.tg_id) not in blob, "PII ученика в сводке")
    denied = s3.rbac_denied(cm.browser, "GET", f"/admin/v1/memory/learners/{uid}", None, "memory.read")
    check(denied is None, denied)
    expect(qa.browser.get(f"/admin/v1/memory/learners/{uuid.uuid4()}"), 404, "MEMORY_LEARNER_NOT_FOUND")
    rows = expect(qa.browser.get(f"/admin/v1/memory/learners/{uid}/cards", params={"limit": "100"}), 200)["items"]
    errs = expect(qa.browser.get(f"/admin/v1/memory/learners/{uid}/cards", params={"kind": "error"}), 200)["items"]
    evidence = [e["evidence"] for e in c.data["la_errors"].values()]
    check(rows and errs and all(x["kind"] == "error" and x["error_code"] for x in errs)
          and not keys_named(rows + errs, {"evidence"})
          and not any(e in json.dumps(rows + errs, ensure_ascii=False) for e in evidence),
          "карточки ученика в админке: цитата ошибки видна")
    # ручная правка одной карточки: memory.manage + step-up, причина, аудит
    target = next(x for x in mine if x["status"] in ("learning", "review"))
    cid = target["card_id"]
    path = f"/admin/v1/memory/cards/{cid}/actions"
    due = iso_z(datetime.now(UTC) + timedelta(days=3))
    body = {"action": "reschedule", "due_at": due, "reason": "e2e: перенос срока по просьбе ученика"}
    denied = s3.rbac_denied(m1.browser, "POST", path, body, "memory.manage")
    check(denied is None, denied)
    nd = s4.step_up_needed(ops, "POST", path, body, "memory.manage")
    check(nd is None, nd)
    s2.ensure_step_up(ops)
    expect(ops.browser.post(path, {**body, "reason": "коротко"}, headers=idem()), 422)
    expect(ops.browser.post(path, {**body, "due_at": iso_z(datetime.now(UTC) + timedelta(days=400))}, headers=idem()),
           422, "DUE_AT_RANGE")
    d = expect(ops.browser.post(path, body, headers=idem()), 200)
    row = d["log"]["items"][0]
    check(abs((parse_ts(d["due_at"]) - parse_ts(due)).total_seconds()) < 2 and row["actor"] == "staff"
          and row["actor_id"] == ops.staff_id and row["actor_name"] == ops.display_name and row["reason"] == body["reason"]
          and row["grade"] is None and row["answer_mode"] == "manual"
          and row["before"]["stability"] == row["after"]["stability"]
          and row["before"]["due_at"] != row["after"]["due_at"], f"перенос срока: {row}")
    check(la.ok("GET", f"/v1/memory/cards/{cid}")["due_at"] == d["due_at"], "ученик не видит новый срок")
    fz = expect(ops.browser.post(path, {"action": "freeze", "reason": "e2e: заморозка карточки"}, headers=idem()), 200)
    check(fz["status"] == "frozen", f"заморозка: {fz['status']}")
    lc_ = la.ok("GET", f"/v1/memory/cards/{cid}")
    check(lc_["status"] == "frozen" and lc_["due_at"] is None, f"ученик: замороженная карточка {lc_['status']}")
    la.ok("POST", f"/v1/memory/cards/{cid}/known", 409, "CARD_STATE")
    uf = expect(ops.browser.post(path, {"action": "unfreeze", "reason": "e2e: разморозка карточки"}, headers=idem()), 200)
    check(uf["status"] == target["status"], f"разморозка: {uf['status']} ≠ {target['status']}")
    body409 = expect(ops.browser.post(path, {"action": "unfreeze", "reason": "e2e: повторная разморозка"},
                                      headers=idem()), 409, "CARD_STATE")
    check((body409.get("details") or {}).get("status") == target["status"], f"CARD_STATE: {body409}")
    rs_ = expect(ops.browser.post(path, {"action": "reset", "reason": "e2e: сброс карточки"}, headers=idem()), 200)
    check(rs_["status"] == "new" and rs_["stability"] is None and rs_["reps"] == 0, f"сброс: {rs_}")
    acts = [x["reason"] for x in rs_["log"]["items"] if x["actor"] == "staff"]
    check(len(acts) == 4, f"ручные правки в истории: {acts}")
    c.data["card_adjusted"] = cid
    # аналитика забывания: только агрегаты, группы < 5 учеников скрыты
    an = expect(m1.browser.get("/admin/v1/memory/analytics", params={"pair_id": PAIR, "period": "30d"}), 200)
    check(an["period"] == "30d" and an["pair_id"] == PAIR and set(an["checks"]) == {"d7", "d30"}
          and not keys_named(an, {"user_id"}) and uid not in json.dumps(an), f"аналитика: {str(an)[:400]}")
    rates = [an["checks"]["d7"], an["checks"]["d30"]] + [x[k] for x in an["by_skill"] for k in ("d7", "d30")]
    check(all((r["pass_pct"] is None and r["scheduled"] == r["passed"] == r["failed"] == 0) if r["hidden"]
              else (r["pass_pct"] is None or 0 <= r["pass_pct"] <= 100) for r in rates),
          f"скрытые группы (< 5 учеников) без значений: {rates[:4]}")
    check(all(x["hidden"] is False or x["again_pct"] is None for x in an["by_lesson"])
          and all(x["hidden"] is False or (x["learners_with_repeats"] == 0 and x["cards"] == 0)
                  for x in an["repeated_errors"])
          and all(x["answers"] >= 20 for x in an["forgotten_words"]) and len(an["forgotten_words"]) <= 20,
          f"аналитика по урокам/ошибкам/словам: {str(an)[:400]}")
    lesson_id = c.data["la_lesson"]["lesson_id"]
    lrow = next((x for x in an["by_lesson"] if x["lesson_id"] == lesson_id), None)
    check(lrow is not None and lrow["title"], f"урок LA в аналитике: {an['by_lesson'][:3]}")
    expect(cm.browser.get("/admin/v1/memory/analytics", params={"pair_id": PAIR, "period": "90d"}), 200)  # dashboard.read
    st = expect(root.browser.get("/admin/v1/memory/stats", params={"period": "7d"}), 200)
    check(st["review_sessions"] >= 3 and st["learners_reviewing"] >= 1 and isinstance(st["ai_glosses_pending"], int)
          and (st["d30_pass_pct"] is None or 0 <= st["d30_pass_pct"] <= 100), f"memory/stats: {st}")
    dash = expect(root.browser.get("/admin/v1/dashboard", params={"period": "today"}), 200)
    check(dash.get("memory") and dash["memory"]["available"] and dash["memory"]["data"]
          and dash["memory"]["data"]["review_sessions"] >= 3, f"блок обзора memory: {str(dash.get('memory'))[:300]}")
    print(f"      память LA: {sm['cards_by_status']}; правки ops: перенос → заморозка → разморозка → сброс; "
          f"аналитика: уроков {len(an['by_lesson'])}, навыков {len(an['by_skill'])}", flush=True)


# ---------------------------------------------------------------- AT-62 сага удаления


MEMORY_TABLES = ("cards", "review_log", "review_sessions", "retention_checks", "pronunciation_attempts",
                 "learner_projection", "skill_projection", "activity_days", "reminders_sent", "idempotency", "feed_log")


def memory_rows(uid: str) -> dict[str, int]:
    out = {t: int(s1._psql(f"SELECT count(*) FROM memory.{t} WHERE user_id = '{s1.uid(uid)}'")) for t in MEMORY_TABLES}
    out["review_tasks"] = int(s1._psql("SELECT count(*) FROM memory.review_tasks t JOIN memory.review_sessions s "
                                       f"USING (session_id) WHERE s.user_id = '{s1.uid(uid)}'"))
    return out


def s_deletion(c: s2.Ctx) -> None:
    need(c, "reading_published")
    lx = c.lc.users["LX"]
    m1 = c.staff["m1"]
    w = c.data["words"]
    key = c.data["reading_key"]
    ref = {"kind": "reading", "key": key, "version": 1}
    demonstrate(c, lx)  # карточки урока, навык → demonstrated → проверка d7 (memory)
    wait_for(lambda: expect(m1.browser.get(f"/admin/v1/memory/learners/{lx.learner_id}"), 200)["checks"], 30,
             interval=1.0, what="проверка d7 у LX")
    for word in (w["g2"], w["g3"]):
        lx.ok("POST", "/v1/memory/cards", 201, json={"text_en": word, "source": ref}, idem=True)
    s = lx.ok("POST", "/v1/memory/review-sessions", 201, idem=True)
    run_review(c, lx, s["session_id"], lambda t, n: "right", [], {})
    lx.ok("POST", f"{rs(s['session_id'])}/finish")
    pol = c.data["policy"]
    lx.ok("POST", "/v1/profile/consent", json={"policy_version": pol["version"], "purposes": [*REQUIRED, VOICE]})
    wait_for(lambda: lx.ok("GET", "/v1/memory/overview")["pronunciation"] == "available", 20, interval=1.0,
             what="LX: произношение доступно")
    expect(pron(lx, f"sentence:reading:{key}:1:s1", wav(1200, 9000)), 200)
    # общий перевод ИИ (не персональный) — останется после удаления
    tx = wait_for(lambda: (t := translate(lx, w["ai2"], ref))["source"] == "ai" and t, 30, interval=1.0,
                  what="перевод ИИ слова LX (ИИ включён)")
    check(tx["ai_unreviewed"] is True, f"перевод ИИ LX: {tx}")
    entry = wait_for(lambda: [x for x in glossary_rows(m1.browser, q=w["ai2"]) if w["ai2"] in x["forms"]], 20,
                     interval=1.0, what="статья ИИ слова LX")[0]
    uid = lx.learner_id
    before = memory_rows(uid)
    check(all(before[t] > 0 for t in ("cards", "review_log", "review_sessions", "review_tasks", "pronunciation_attempts",
                                      "retention_checks", "skill_projection", "learner_projection", "activity_days",
                                      "feed_log")), f"данные LX в memory до удаления: {before}")
    d = lx.ok("POST", "/v1/profile/delete-request", 202, json={"confirm_word": "УДАЛИТЬ"})
    check("memory" in d["domains"], f"домены саги: {d['domains']}")

    def done() -> Any:
        row = s1._psql("SELECT status || '|' || array_to_string(acked_domains, ',') FROM "
                       f"identity_consent.deletion_requests WHERE user_id = '{s1.uid(lx.account_id)}'")
        return row if row.startswith("COMPLETED|") else None

    row = wait_for(done, 90, interval=1.0, what="сага удаления LX (ACK memory)")
    check("memory" in row.split("|")[1].split(","), f"ACK: {row}")
    left = {k: v for k, v in memory_rows(uid).items() if v}
    check(not left, f"данные LX в memory после удаления: {left}")
    ack = pj("SELECT count(*) FROM memory.outbox WHERE envelope->>'event_type' = 'user.domain.deleted.v1' "
             f"AND envelope->'payload'->>'user_id' = '{s1.uid(uid)}'")
    check(ack == 1, f"ACK user.domain.deleted.v1 {{domain: memory}}: {ack}")
    still = expect(m1.browser.get(f"/admin/v1/glossary/{entry['entry_id']}"), 200)
    check(still["archived_at"] is None and still["source"] == "ai", "общий перевод ИИ удалён вместе с учеником")
    check(glossary_entry(m1.browser, w["g2"])["source"] == "course", "статья словаря курса удалена с учеником")
    expect(m1.browser.get(f"/admin/v1/memory/learners/{uid}"), 404, "MEMORY_LEARNER_NOT_FOUND")
    c.data["deleted"] = uid
    print(f"      LX: до удаления {before}; после — пусто; статья ИИ «{w['ai2']}» и словарь курса на месте", flush=True)


# ---------------------------------------------------------------- безопасность и «нигде не сохранено»


def s_security(c: s2.Ctx) -> None:
    need(c, "la_sessions")
    la, lb = c.lc.users["LA"], c.lc.users["LB"]
    since = c.data["started_at"]
    marker = c.data["marker"]
    card = next(iter(c.data["la_cards"].values()))
    sid = c.data["la_sessions"][-1]
    # IDOR: чужие карточки и сессии неотличимы от несуществующих
    lb.ok("GET", f"/v1/memory/cards/{card}", 404, "CARD_NOT_FOUND")
    lb.ok("DELETE", f"/v1/memory/cards/{card}", 404, "CARD_NOT_FOUND")
    lb.ok("POST", f"/v1/memory/cards/{card}/known", 404, "CARD_NOT_FOUND")
    lb.ok("GET", f"{rs(sid)}", 404, "REVIEW_SESSION_NOT_FOUND")
    lb.ok("GET", f"{rs(sid)}/current", 404, "REVIEW_SESSION_NOT_FOUND")
    lb.ok("POST", f"{rs(sid)}/finish", 404, "REVIEW_SESSION_NOT_FOUND")
    check(card not in {x["card_id"] for x in dictionary(lb)}, "чужая карточка в словаре")
    # ключей ответов нет ни в одном задании повторения, выданном ученику
    leaks = [f"{t['type']}: {k}" for t in REVIEW_TASKS for k in keys_named(t, KEY_FIELDS)]
    check(not leaks and len(REVIEW_TASKS) >= 30, f"ключи в заданиях ({len(REVIEW_TASKS)}): {leaks[:5]}")
    # история планирования неизменяема (триггер — даже владельцу схемы)
    res = psql_try(f"BEGIN; UPDATE memory.review_log SET grade = 'good' WHERE user_id = '{s1.uid(la.learner_id)}'; "
                   "ROLLBACK;", user="memory_owner")
    check(res.returncode != 0 and "permission denied" not in res.stderr,
          f"UPDATE review_log под memory_owner не отклонён триггером: rc={res.returncode} {(res.stdout + res.stderr)[:200]}")
    # аудио нигде не сохранено: ни столбцов-байтов, ни тела записи (маркер чанка LIST) в БД, Redis и логах
    am = c.data.get("audio_marker")
    if am:
        cols = s1._psql("SELECT coalesce(string_agg(table_schema || '.' || table_name || '.' || column_name, ','), '') "
                        "FROM information_schema.columns WHERE table_schema IN ('memory', 'ai_gateway') "
                        "AND data_type = 'bytea'")
        check(not cols, f"столбцы bytea в memory/ai_gateway: {cols}")
        found = []
        for schema in ("memory", "ai_gateway"):
            tables = s1._psql("SELECT string_agg(table_name, ',') FROM information_schema.tables WHERE table_schema = "
                              f"'{schema}' AND table_type = 'BASE TABLE'").split(",")
            for t in tables:
                if not re.fullmatch(r"[a-z_]+", t):
                    continue
                n = int(s1._psql(f"SELECT count(*) FROM {schema}.{t} x WHERE row_to_json(x)::text LIKE '%{am}%' "
                                 "OR row_to_json(x)::text LIKE '%UklGR%'"))
                if n:
                    found.append(f"{schema}.{t}: {n}")
        check(not found, f"тело записи в БД: {found}")
        att = pj("SELECT json_agg(row_to_json(a)) FROM memory.pronunciation_attempts a WHERE attempt_id IN ("
                 + ",".join(f"'{s1.uid(x)}'" for x in c.data["pron_attempts"]) + ")") or []
        check(len(att) == 3 and all(set(a) >= {"audio_ms", "words", "scores"} and a["audio_ms"] >= 1000 for a in att),
              f"попытки произношения — баллы без аудио: {att}")
        rd = subprocess.run(["redis-cli", "-u", os.environ.get("E2E_REDIS_URL", "redis://127.0.0.1:6379/0"), "--scan"],
                            capture_output=True, text=True, check=False).stdout.split()
        hits = []
        for k in rd[:20000]:
            if not re.fullmatch(r"[\x21-\x7e]{1,300}", k):
                continue
            v = subprocess.run(["redis-cli", "-u", os.environ.get("E2E_REDIS_URL", "redis://127.0.0.1:6379/0"), "--raw",
                                "GET", k], capture_output=True, check=False).stdout
            if am.encode() in v or b"RIFF" in v[:16]:
                hits.append(k)
        check(not hits, f"тело записи в Redis: {hits[:5]}")
        logs = [f.name for f in sorted(s1.LOG_DIR.glob("*.log")) if not f.name.startswith(("mock-telegram", "miniapp"))
                and (am in f.read_text(errors="replace") or "UklGR" in f.read_text(errors="replace"))]
        check(not logs, f"тело записи в логах: {logs}")
    # тексты ученика (неверный ввод с маркером, слова «своего текста») — не в событиях и не в аудите
    found = []
    for schema in ("memory", "catalog", "lessons", "assessment", "learning_plan", "notifications", "diagnostics"):
        blob = s1._psql(f"SELECT coalesce(string_agg(envelope::text, E'\\n'), '') FROM {schema}.outbox "
                        f"WHERE created_at >= to_timestamp({int(since)})")
        if marker in blob:
            found.append(schema)
    audit = json.dumps(s2.all_records(c.staff["root"].browser, since), ensure_ascii=False)
    check(not found and marker not in audit, f"тексты учеников в событиях/аудите: {found} аудит {marker in audit}")
    print(f"      IDOR — 404; заданий без ключей: {len(REVIEW_TASKS)}; review_log неизменяем; аудио — нигде", flush=True)


# ---------------------------------------------------------------- аудит, события, логи


def s_audit(c: s2.Ctx) -> None:
    b = c.staff["root"].browser
    d = c.data
    m1, ops = (c.staff[k].staff_id for k in ("m1", "ops"))
    want: list[tuple[str, dict[str, str]]] = []
    if d.get("card_adjusted"):
        want += [("memory.card_adjusted", {"actor_id": ops, "object_id": d["card_adjusted"]})]
    if d.get("methodist_entry"):
        want += [("glossary.entry_created", {"actor_id": m1, "object_id": d["methodist_entry"]}),
                 ("glossary.entry_updated", {"actor_id": m1, "object_id": d["methodist_entry"]})]
    if d.get("ai_entry"):
        want += [("glossary.entry_reviewed", {"actor_id": m1, "object_id": d["ai_entry"]})]
    check(want, "нет команд спринта 5 для проверки аудита (шаги упали)")
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
    if d.get("card_adjusted"):
        adj = [r for r in recs if r["action"] == "memory.card_adjusted"]
        check(len(adj) == 4 and all(r["source"] == "memory" and r["reason"] for r in adj),
              f"memory.card_adjusted: {adj[:2]}")
    blob = json.dumps(recs, ensure_ascii=False)
    leaks = [w for w, v in c.secrets.items() if v and v in blob]
    leaks += [f"Telegram ID {u.role}" for u in c.lc.users.values() if re.search(rf"(?<!\d){u.tg_id}(?!\d)", blob)]
    check(not leaks, f"секреты/PII в аудите: {leaks}")
    v = expect(b.get("/admin/v1/audit/verify"), 200)
    check(v["valid"] is True and v["broken_at_seq"] is None, f"цепочка аудита: {v}")


S5_SCHEMAS = ["memory", "catalog", "lessons", "assessment", "diagnostics", "learning_plan", "notifications",
              "identity_consent", "ai_gateway"]


def s_events(c: s2.Ctx) -> None:
    import jsonschema

    since = c.data["started_at"]
    env_schema = json.loads((s1.CONTRACTS / "envelope.schema.json").read_text())
    seen: Counter[str] = Counter()
    problems: list[str] = []
    for schema in S5_SCHEMAS:
        if s1._psql(f"SELECT to_regclass('{schema}.outbox') IS NOT NULL") != "t":
            continue
        rows = pj("SELECT coalesce(json_agg(json_build_object('e', envelope, 'p', published_at IS NOT NULL)), '[]') "
                  f"FROM {schema}.outbox WHERE created_at >= to_timestamp({int(since)})") or []
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
    expected = {"memory:memory.review.completed.v1", "catalog:catalog.version.published.v1",
                "assessment:assessment.completed.v1", "lessons:lesson.session.completed.v1"}
    if c.data.get("lb_retained"):
        expected.add("memory:memory.retention.checked.v1")
    if c.data.get("reminder_done"):
        expected.add("memory:memory.reviews.due.v1")
    if c.data.get("methodist_entry"):
        expected.add("catalog:catalog.glossary.changed.v1")
    if c.data.get("card_adjusted"):
        expected.add("memory:admin.audit.recorded.v1")
    if c.data.get("deleted"):
        expected.add("memory:user.domain.deleted.v1")
    check(not (expected - set(seen)), f"не опубликованы события: {sorted(expected - set(seen))}")
    check(not problems, "; ".join(problems[:8]))
    # kind reading в событиях урока и оценки
    if c.data.get("reading_session"):
        kinds = pj("SELECT json_agg(DISTINCT envelope->'payload'->>'kind') FROM lessons.outbox WHERE "
                   f"envelope->'payload'->>'session_id' = '{s1.uid(c.data['reading_session'])}'") or []
        check(kinds == ["reading"], f"kind события сессии чтения: {kinds}")
    after, before = s1.dlq_counts(), c.data.get("dlq_before", {})
    grown = {k: v - before.get(k, 0) for k, v in after.items() if v > before.get(k, 0)}
    check(not grown, f"новые сообщения в DLQ: {grown}")
    print(f"      событий с начала прогона: {sum(seen.values())}; memory: "
          f"{ {k.split(':')[1]: v for k, v in seen.items() if k.startswith('memory:')} }", flush=True)


def s_logs(c: s2.Ctx) -> None:
    needles: dict[str, str] = {"маркер текстов ученика": c.data.get("marker", ""),
                               "SCHEDULER_TOKEN": s1.SCHEDULER_TOKEN}
    needles.update({k: v for k, v in c.secrets.items()})
    found = []
    for log in sorted(s1.LOG_DIR.glob("*.log")):
        if log.name.startswith(("mock-telegram", "miniapp", "bootstrap")) or ".migrate" in log.name or ".build" in log.name:
            continue
        text = log.read_text(errors="replace")
        found += [f"{log.name}: {what}" for what, needle in needles.items() if needle and needle in text]
        if s4.KEY_RE.search(text):
            found.append(f"{log.name}: строка вида ключа провайдера")
    check(not found, f"тексты учеников/секреты в логах: {found[:8]}")


# ---------------------------------------------------------------- уборка в конце прогона


def final_cleanup(c: s2.Ctx) -> list[str]:
    done: list[str] = []
    m1 = c.staff.get("m1")
    if m1 is None or not m1.browser.cookie:
        return cleanup_leftovers()
    if c.data.get("kid_voice"):
        c.lc.users["P"].ok("PUT", f"/v1/learners/{c.data['kid']}/voice-consent", json={"granted": False})
        done.append("согласие ребёнка на запись голоса — отозвано")
    if c.data.get("methodist_entry"):
        r = m1.browser.request("DELETE", f"/admin/v1/glossary/{c.data['methodist_entry']}",
                               json_body={"reason": "e2e: уборка статьи методиста"}, headers=idem())
        check(r.status_code in (200, 204), f"архив статьи методиста: {r.status_code} {r.text[:200]}")
        done.append("статья методиста — в архив")
    if c.data.get("reading_published"):
        s2.ensure_step_up(m1)
        r = m1.browser.post(s3.content_path("reading", c.data["reading_key"], tail="/archive"),
                            {"reason": "e2e: уборка текста для чтения"}, headers=idem())
        check(r.status_code == 200, f"снять текст: {r.status_code} {r.text[:200]}")
        done.append(f"текст {c.data['reading_key']} — снят с публикации")
    return done


STEPS: list[tuple[str, Callable[[s2.Ctx], None], bool]] = [
    ("M00 стенд спринта 5: memory, catalog, ai-gateway (fake + fake-речь), маршруты BFF, сид текстов и словаря; уборка",
     s_stand, True),
    ("M01 super_admin (bootstrap), права спринта 5 в матрице ролей; 2 methodist, operations, content_manager, qa_analyst",
     s_staff, True),
    ("M02 первый вход сотрудников (TOTP у привилегированных)", s_staff_login, True),
    ("M03 ученики через telegram-bff: LA, LB, LC, LR (напоминания), LX, родитель + ребёнок 6–9", s_learners, True),
    ("M04 AT-53 урок → ключевые слова (RU/UZ, пример, озвучка) и ошибки из оценки в словаре и журнале; без дублей",
     s_lesson_cards, False),
    ("M05 AT-53 переоценка (step-up) → ошибка снята → архив карточки (actor system, reevaluated)", s_reevaluate, False),
    ("M06 AT-54/55 «Повторение дня» R1: intro → meaning_choice, «Знаю это», выбор = hard, повтор ответа, "
     "HINTS_NOT_ALLOWED у выбора, TASK_NOT_CURRENT, finish ×2, NOTHING_TO_REVIEW", s_review_first, False),
    ("M07 AT-54/55 сдвиг 10 и 5 дней: R2 узнавание (again → повтор в конце, «Не помню»), R3 воспроизведение (ввод = "
     "good, «Первая буква» = hard, опечатка, неверно, «Не помню»)", s_review_later, False),
    ("M08 AT-55 история планирования в админке: было/стало, fsrs-5, версия параметров; S, D, срок — по формулам; "
     "easy нигде", s_fsrs_history, False),
    ("M09 AT-56 урок без ошибок → demonstrated → d7 (без подсказок) → d30 → retained в карте навыков",
     s_retention_pass, False),
    ("M10 AT-56 два провала подряд (d7, повтор через 3 дня) → навык снова learning", s_retention_fail, False),
    ("M11 AT-60 текст для чтения: черновик → 422 → проверка вторым методистом (SELF_REVIEW) → публикация (step-up)",
     s_reading_admin, False),
    ("M12 AT-60 словарь курса: список, карточка с историей, статья методиста (FORM_TAKEN, 428/409), override у course",
     s_glossary_admin, False),
    ("M13 AT-57 чтение: тексты по аудитории, перевод по тапу (course/override, методист, ИИ → очередь → исправление), "
     "422/404, «в словарь», вопросы (practice_only, навыки не меняются)", s_reading_learner, False),
    ("M14 AT-58 произношение: 403 self → согласие → оценка по словам и советы ≤ 2; тишина; битый WAV; ребёнок: "
     "guardian → согласие родителя → можно → отзыв; затраты", s_pronunciation, False),
    ("M14b ИИ и речь выключены (аварийная остановка, step-up): «Произнести» скрыто (503), перевод ИИ → «нет "
     "перевода», словарь курса и повторение работают", s_ai_off, False),
    ("M15 AT-59 вечернее напоминание: пояс плана 19:00–22:00, ≥ 5 к сроку, tick → memory.reviews.due.v1 → Telegram и центр, "
     "повторный tick — без второго; повторение засчитано в день графика", s_reminder, False),
    ("M16 AT-61 «Память» в админке: сводка, карточки без цитат, правка со step-up (перенос, заморозка, сброс), 403; "
     "аналитика забывания (скрытые группы), блок обзора", s_memory_admin, False),
    ("M17 AT-62 сага удаления: карточки, история, сессии, попытки произношения удалены; общий словарь и перевод ИИ "
     "остались", s_deletion, False),
    ("M18 безопасность: IDOR → 404, ключей нет в заданиях, review_log неизменяем, аудио и тексты нигде не сохранены",
     s_security, False),
    ("M19 аудит memory.card_adjusted и glossary.* без PII; цепочка цела", s_audit, False),
    ("M20 события спринта 5 по контрактам, outbox опубликован, DLQ", s_events, False),
    ("M21 логи сервисов без текстов учеников и секретов", s_logs, False),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--admin-bff", default=os.environ.get("E2E_ADMIN_BFF", "http://127.0.0.1:8002"))
    ap.add_argument("--bff", default=TG_BFF)
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--cleanup", action="store_true", help="только уборка остатков прерванного прогона")
    args = ap.parse_args()
    if args.cleanup:
        done = [*cleanup_leftovers(), *s4.cleanup_leftovers()]
        print("уборка стенда (память и словарь): " + ("; ".join(done) if done else "остатков прерванных прогонов нет"),
              flush=True)
        return 0
    tag = "M" + "".join(secrets.choice(string.ascii_uppercase) for _ in range(4))
    base_tg = 8_990_000_000 + secrets.randbelow(4_000_000) * 8
    results: list[tuple[str, str, str]] = []
    with httpx.Client(base_url=args.bff, timeout=45) as tg:
        lc = s1.Ctx(bff=tg, tag=tag, base_tg=base_tg)
        lc.data["zone_day"] = s1.pick_zone(datetime.now(UTC), 10 * 60, 16 * 60, 13 * 60)
        c = s2.Ctx(bff=args.admin_bff, lc=lc, tag=tag)
        c.data["started_at"] = int(time.time()) - 1
        print(f"TilHero e2e (спринт 5, память и повторения): admin-bff {args.admin_bff}, telegram-bff {args.bff}, "
              f"метка {tag}, Telegram ID от {base_tg + 1}, зона учеников {lc.data['zone_day']}\n", flush=True)
        blocked: str | None = None
        try:
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
        finally:
            try:
                for line in final_cleanup(c):
                    print(f"      уборка в конце прогона: {line}", flush=True)
            except Exception as exc:
                print(f"      уборка в конце прогона не удалась: {exc} — запустите --cleanup", flush=True)
    passed = sum(1 for r in results if r[1] == "PASS")
    failed = [r for r in results if r[1] == "FAIL"]
    skipped = [r for r in results if r[1] == "SKIP"]
    if NOTES:
        print("\nЗамечания (не роняют шаг):")
        for n in NOTES:
            print(f"  - {n}")
    print(f"\nИтого: {passed}/{len(results)} PASS" + (f", {len(skipped)} SKIP" if skipped else "")
          + f" (выполнено проверок: {s1.CHECKS[0]})")
    (s1.E2E_DIR / "last-run-memory.json").write_text(json.dumps(
        {"tag": tag, "checks": s1.CHECKS[0], "notes": NOTES,
         "results": [{"step": n, "status": s, "detail": d} for n, s, d in results]}, ensure_ascii=False, indent=1))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

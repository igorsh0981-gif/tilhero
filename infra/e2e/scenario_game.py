# ruff: noqa: S608 — QA-скрипт dev-стенда: psql (SQL только из UUID/дат/кодов сценария, проверенных регуляркой, и констант)
"""Сквозной сценарий спринта 6 TilHero (игра и герои) через публичные API — как Mini App (telegram-bff) и браузер
admin-web (admin-bff).

Предусловие: `infra/e2e/run_local.sh game` (сброс учёток admin-identity + up + этот сценарий; ИИ и речь — fake).
Отдельно, на уже поднятом стенде со свежим bootstrap-сотрудником:
    uv run python infra/e2e/scenario_game.py [--admin-bff http://127.0.0.1:8002] [--bff http://127.0.0.1:8001] [-v]
    uv run python infra/e2e/scenario_game.py --only G08,G12   # подготовка (G00–G03) + только эти шаги
    uv run python infra/e2e/scenario_game.py --cleanup        # только уборка остатков прерванного прогона

Сотрудники: bootstrap super_admin создаёт content_manager (game.read + game.manage: черновики правил, герои, картинки,
магазин, события), operations (+ game.publish и wallet.adjust со step-up) и support (только game.read). Ученики —
взрослые LA (основной), LR (пригласивший) и LB (приглашённый по реферальной ссылке), LE (правила и событие недели),
LF/LG (пропуск дня графика с заморозкой и без), LX (удаление), родитель P с ребёнком 6–9. Помощники — сценарии
спринтов 1–5 (`scenario.py`: ученики, онбординг, мок Telegram, psql, plan:tick; `scenario_admin.py`: браузер
admin-web, TOTP, step-up; `scenario_content.py`: создание сотрудников; `scenario_lessons.py`: шаги занятий;
`scenario_memory.py`: урок целиком и «Повторение дня»).

Доменные сервисы напрямую вызываются только как планировщик (`POST gamification /internal/v1/game:tick`,
`learning-plan plan:tick` с SCHEDULER_TOKEN — как n8n) и при уборке остатков прерванного прогона (staff API
gamification от имени admin-bff — ключ стенда). Повтор события — адресный повтор ops-monitor: исходный конверт
урока из outbox lessons публикуется в `tilhero.replay.gamification_lessons` (получает только consumer gamification,
event_id прежний). Прямой доступ к БД (psql):
  * ТЕСТОВЫЕ ИЗМЕНЕНИЯ БД — только сдвиг времени СВОИХ учеников LF/LG (ждать сутки нельзя): дата занятия
    `learning_plan.activities.local_date` → позавчера по поясу плана, `learning_plan.plans.onboarding_completed_at /
    schedule_set_at` → на 3 дня назад (график действовал вчера). Пропуск выпускает настоящий plan:tick: пояс плана
    выбирается так, чтобы местная полночь была между прошлым tick и сейчас (иначе сценарий ждёт ближайшую полночь).
    Каждый сдвиг печатается в журнал прогона;
  * только чтение: outbox/inbox (события по контрактам, обработка повтора), сага удаления (строки ученика),
    неизменяемость реестра, значков и активной версии правил (UPDATE под ролью-владельцем в BEGIN … ROLLBACK обязан
    упасть), tick_state learning-plan (выбор пояса), потребители NATS (хвост).

Что сценарий меняет в общем стенде и как возвращает (уборка в конце, в G00 и `--cleanup`):
  * правила игры: черновик → активация (комментарий «[e2e …] активация») → откат на прежнюю версию в том же шаге;
    прерванный прогон — откат активной e2e-версии на based_on, черновик e2e удаляется;
  * события недели `e2e_*` — отменяются; предмет магазина `e2e_*` — снимается с продажи;
  * картинка ступени героя — исходные asset_id ступеней восстанавливаются публикацией (файл .dev/e2e/game-restore.json
    на случай прерывания).

Печатает PASS/FAIL/SKIP по шагам и «Итого: N/M PASS»; код выхода 1, если хоть один шаг упал. Замечания (отклонения от
контракта, не роняющие шаг) печатаются в конце. Шаги после сбоя критичного шага — SKIP.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import math
import os
import re
import secrets
import string
import struct
import sys
import time
import traceback
import uuid
import zlib
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from datetime import time as dtime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scenario as s1  # ученики (telegram-bff), онбординг, мок Telegram, psql, plan:tick
import scenario_admin as s2  # браузер admin-web, TOTP, step-up, вход сотрудника
import scenario_content as s3  # создание сотрудников, psql-помощники
import scenario_lessons as s4  # шаги занятий, уборка настроек ИИ
import scenario_memory as s5  # урок целиком, «Повторение дня»

check, expect, wait_for = s1.check, s1.expect, s1.wait_for
StepFailed, StepSkipped = s1.StepFailed, s1.StepSkipped
Staff = s2.Staff
idem = s2.idem
parse_ts = s2.parse_ts
need, pj, psql_try = s3.need, s3.pj, s3.psql_try

TG_BFF = s2.TG_BFF
GAME = os.environ.get("E2E_GAMIFICATION", "http://127.0.0.1:8117")
NATS_URL = os.environ.get("E2E_NATS_URL", "nats://127.0.0.1:4222")
REQUIRED = s1.REQUIRED
RESTORE_FILE = s1.E2E_DIR / "game-restore.json"
GAME_PERMS = {"game.read", "game.manage", "game.publish", "wallet.adjust"}
# PLAN спринта 6 «Права и роли»: права игры по ролям (super_admin — все)
ROLE_GAME = {"content_manager": {"game.read", "game.manage"}, "methodist": {"game.read"},
             "operations": GAME_PERMS, "support": {"game.read"}, "analyst": {"game.read"}, "auditor": {"game.read"}}
HEROES = {f"{line}_{i}" for line in ("robot", "pet", "human") for i in range(3)}
OPEN_OK = "I want to go to London and my brother has two bags."  # открытое задание без ошибок (fake-оценщик)
EVENT_PREFIX = "e2e_"
ACTIVITY = ("lesson", "scenario", "media", "reading", "review", "skill_demonstrated", "skill_retained")
CAPPED = (*ACTIVITY, "quest")
GAME_TABLES = ("ledger", "wallets", "learners", "skill_states", "quests", "badges", "ownership", "purchases",
               "session_rewards")
ET_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NOTES: list[str] = []


def note(text: str) -> None:
    NOTES.append(text)
    print(f"      замечание: {text}", flush=True)


# =============================================================================================== помощники


def iso_z(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def uid(v: str) -> str:
    return s1.uid(v)


def game_tick() -> dict[str, Any]:
    """game:tick — как n8n `game-tick` (Bearer SCHEDULER_TOKEN); занято соседним tick — повтор."""
    for _ in range(20):
        r = httpx.post(f"{GAME}/internal/v1/game:tick", headers={"authorization": f"Bearer {s1.SCHEDULER_TOKEN}"},
                       timeout=60)
        res = expect(r, 200)
        if not res.get("skipped"):
            return res
        time.sleep(0.5)
    raise StepFailed("game:tick 10 с подряд отвечает skipped")


def summary(u: s1.U) -> dict[str, Any]:
    return u.ok("GET", "/v1/game/summary")


def history(u: s1.U, currency: str | None = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cursor = None
    for _ in range(30):
        params: dict[str, Any] = {}
        if currency:
            params["currency"] = currency
        if cursor:
            params["cursor"] = cursor
        page = u.ok("GET", "/v1/game/history", params=params or None)
        out += page["items"]
        cursor = page.get("next_cursor")
        if not cursor:
            return out
    raise StepFailed("история: больше 30 страниц")


def totals(ops: list[dict[str, Any]]) -> dict[str, int]:
    out = {"xp": 0, "til": 0, "freeze": 0}
    for o in ops:
        out[o["currency"]] += int(o["amount"])
    return out


def rewards(u: s1.U, sid: str) -> dict[str, Any]:
    return u.ok("GET", "/v1/game/rewards", params={"source_session_id": sid})


def wait_rewards(u: s1.U, sid: str, pred: Callable[[dict[str, Any]], bool], what: str,
                 timeout: float = 45) -> dict[str, Any]:
    last: dict[str, Any] = {}

    def f() -> dict[str, Any] | None:
        nonlocal last
        last = rewards(u, sid)
        return last if pred(last) else None

    try:
        return wait_for(f, timeout, interval=1.5, what=what)
    except StepFailed as exc:
        raise StepFailed(f"{exc}; награды: {json.dumps(last, ensure_ascii=False)[:500]}") from None


def ops_of(r: dict[str, Any], reason: str, currency: str | None = None) -> list[dict[str, Any]]:
    return [o for o in r["operations"] if o["reason"] == reason and (currency is None or o["currency"] == currency)]


def op_ok(op: dict[str, Any], base: int, factor: float = 1, what: str = "") -> None:
    """Сумма операции активности: floor(база × множитель); урезанная лимитом дня — меньше и с capped = true."""
    want = math.floor(base * factor)
    check(float(op["multiplier"]) == float(factor) and op["status"] == "confirmed",
          f"{what}: множитель {op['multiplier']} (ожидали {factor}), статус {op['status']}")
    if op["capped"]:
        check(0 < op["amount"] < want, f"{what}: урезано лимитом дня, но сумма {op['amount']} (база {want})")
        print(f"      {what}: урезано дневным лимитом до {op['amount']} (база {want})", flush=True)
    else:
        check(op["amount"] == want, f"{what}: сумма {op['amount']}, ожидали {want} ({base} × {factor})")


def attribution_defect(sid: str, what: str) -> str:
    """Описание дефекта привязки наград к занятию (§1.8) с фактами из БД (только чтение)."""
    row = pj("SELECT json_build_object('null_session', count(*) FILTER (WHERE source_session_id IS NULL), "
             "'other_session', count(*) FILTER (WHERE source_session_id IS NOT NULL AND source_session_id <> "
             f"'{uid(sid)}')) FROM gamification.ledger WHERE reason IN ('skill_demonstrated', 'skill_retained') "
             f"AND user_id = (SELECT user_id FROM gamification.session_rewards WHERE session_id = '{uid(sid)}' LIMIT 1)")
    order = pj("SELECT json_agg(json_build_object('t', i.event_type, 'at', i.processed_at) ORDER BY i.processed_at) "
               "FROM gamification.inbox i WHERE i.consumer IN ('gamification.lessons', 'gamification.skills') "
               "AND i.processed_at > now() - interval '15 minutes'") or []
    return (f"ДЕФЕКТ gamification (earning.py on_skills — привязка наград навыков к занятию): {what} не в наградах "
            f"занятия {sid}; операции навыков ученика без source_session_id / с другой сессией: {row}; порядок "
            f"обработки: {[x['t'] for x in order[-4:]]}")


def level_of(xp: int, levels: list[int]) -> int:
    return max(1, sum(1 for t in levels if t <= xp))


def admin_wallet(st: Staff, user_id: str, status: int = 200, code: str | None = None) -> dict[str, Any]:
    return expect(st.browser.get(f"/admin/v1/game/wallets/{user_id}"), status, code)


def admin_ledger(st: Staff, user_id: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cursor = None
    for _ in range(20):
        params = {"limit": "100", **({"cursor": cursor} if cursor else {})}
        page = expect(st.browser.get(f"/admin/v1/game/wallets/{user_id}/ledger", params=params), 200)
        out += page["items"]
        cursor = page.get("next_cursor")
        if not cursor:
            return out
    raise StepFailed("реестр: больше 20 страниц")


def outbox(schema: str, event_type: str, since: int, user_id: str | None = None) -> list[dict[str, Any]]:
    check(re.fullmatch(r"[a-z_]+", schema) and ET_RE.fullmatch(event_type), f"{schema} {event_type}")
    flt = f" AND envelope->'payload'->>'user_id' = '{uid(user_id)}'" if user_id else ""
    return pj(f"SELECT coalesce(json_agg(envelope->'payload' ORDER BY created_at), '[]') FROM {schema}.outbox "
              f"WHERE envelope->>'event_type' = '{event_type}' AND created_at >= to_timestamp({int(since)}){flt}") or []


def outbox_envelopes(schema: str, event_type: str, since: int, user_id: str) -> list[dict[str, Any]]:
    check(re.fullmatch(r"[a-z_]+", schema) and ET_RE.fullmatch(event_type), f"{schema} {event_type}")
    return pj(f"SELECT coalesce(json_agg(envelope ORDER BY created_at), '[]') FROM {schema}.outbox "
              f"WHERE envelope->>'event_type' = '{event_type}' AND created_at >= to_timestamp({int(since)}) "
              f"AND envelope->'payload'->>'user_id' = '{uid(user_id)}'") or []


def inbox_count(event_id: str) -> int:
    return int(s1._psql(f"SELECT count(*) FROM gamification.inbox WHERE event_id = '{uid(event_id)}'"))


def consumers(prefix: str) -> dict[str, dict[str, int]]:
    import nats

    async def run() -> dict[str, dict[str, int]]:
        nc = await nats.connect(NATS_URL)
        try:
            js = nc.jetstream()
            return {ci.name: {"pending": ci.num_pending or 0, "ack_pending": ci.num_ack_pending or 0,
                              "delivered": ci.delivered.stream_seq or 0}
                    for ci in await js.consumers_info("TILHERO") if ci.name.startswith(prefix)}
        finally:
            await nc.close()

    return asyncio.run(run())


def replay(envelope: dict[str, Any], durable: str) -> int:
    """Адресный повтор (как ops-monitor): конверт как есть в `tilhero.replay.<durable>` — получает только этот
    consumer; новый Nats-Msg-Id, чтобы JetStream не отбросил его как дубль публикации. → seq в стриме."""
    import nats

    async def run() -> int:
        nc = await nats.connect(NATS_URL)
        try:
            js = nc.jetstream()
            ack = await js.publish(f"tilhero.replay.{durable}", json.dumps(envelope).encode(),
                                   headers={"Nats-Msg-Id": f"e2e-replay-{uuid.uuid4()}"})
            return int(ack.seq)
        finally:
            await nc.close()

    return asyncio.run(run())


def wait_delivered(durable: str, seq: int, timeout: float = 30) -> None:
    def ok() -> bool:
        st = consumers(durable).get(durable)
        return bool(st and st["delivered"] >= seq and st["pending"] == 0 and st["ack_pending"] == 0)

    wait_for(ok, timeout, interval=0.5, what=f"consumer {durable} обработал повтор (seq {seq})")


def png(w: int, h: int, seed: str) -> bytes:
    """PNG RGBA (stdlib): уникальная для прогона картинка — новый sha256."""
    d = hashlib.sha256(seed.encode()).digest()
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            row += bytes([(d[0] + 2 * x) % 256, (d[1] + 2 * y) % 256, d[2], 255])
        rows.append(bytes(row))

    def chunk(t: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + t + data + struct.pack(">I", zlib.crc32(t + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"tEXt", b"Comment\x00" + seed.encode()) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
            + chunk(b"IEND", b""))


def upload(st: Staff, data: bytes, ctype: str = "image/png", purpose: str = "hero_stage") -> httpx.Response:
    """POST /admin/v1/game/assets — сырое тело картинки, как admin-web (fetch с Blob): cookie, Origin, CSRF."""
    b = st.browser
    h = {"cookie": f"{s2.COOKIE}={b.cookie}", "origin": s2.ADMIN_ORIGIN, "content-type": ctype}
    if b.csrf:
        h["x-csrf-token"] = b.csrf
    return b.http.post("/admin/v1/game/assets", params={"purpose": purpose}, content=data, headers=h)


def public_asset(url: str, headers: dict[str, str] | None = None) -> httpx.Response:
    """Картинка ученика — без авторизации (публичное неизменяемое содержимое)."""
    return httpx.get(f"{TG_BFF}{url}", headers=headers or {}, timeout=15)


def readings(u: s1.U) -> list[dict[str, Any]]:
    return u.ok("GET", "/v1/practice/readings", params={"limit": 50})["items"]


def reading_session(c: s2.Ctx, u: s1.U) -> str:
    """Текст для чтения целиком (как Mini App): чтение → вопросы (ответы — любые, это практика) → итоги.
    Ответ ввода содержит маркер прогона — текст ученика не должен попасть в логи и события."""
    items = sorted((x for x in readings(u) if not x["reading_id"].startswith("r-e2e-")), key=lambda x: x["reading_id"])
    check(items, f"{u.role}: нет текстов для чтения")
    key = items[0]["reading_id"]
    s = u.ok("POST", f"/v1/practice/readings/{key}/sessions", 201, idem=True)
    sid = s["session_id"]
    step = s4.cur(u, sid)
    for _ in range(40):
        if step["type"] == "done":
            break
        body: dict[str, Any] = {}
        if step["type"] == "item":
            it = step["item"]
            t = it.get("item_type") or it.get("type")
            body = {"answer": f"x{c.data['marker']}" if (t in s4.GAP_TYPES or not it.get("options")) else 0}
        step = s4.post_step(u, sid, step, body)["next"]
    check(step["type"] == "done", f"{u.role}: чтение не дошло до итогов ({step['type']})")
    summ = s4.finish(u, sid)
    check(summ["kind"] == "reading", f"{u.role}: итоги чтения {str(summ)[:200]}")
    return sid


def wait_reading_reward(u: s1.U, sid: str) -> dict[str, Any]:
    return wait_rewards(u, sid, lambda r: r["status"] == "ready" and bool(ops_of(r, "reading", "xp")),
                        f"{u.role}: награда за чтение (lesson.session.completed.v1 kind reading → gamification)")


def skill_map(u: s1.U) -> dict[str, dict[str, Any]]:
    return {x["skill_id"]: x for x in u.ok("GET", "/v1/skills/map")["skills"]}


def held(u: s1.U) -> int:
    return sum(1 for x in skill_map(u).values() if x["state"] in ("demonstrated", "retained"))


def inbox_titles(u: s1.U) -> list[dict[str, Any]]:
    return u.inbox()


def rules_payload(st: Staff, version: int) -> dict[str, Any]:
    return expect(st.browser.get(f"/admin/v1/game/rules/{version}"), 200)


def active_version(st: Staff) -> dict[str, Any]:
    items = expect(st.browser.get("/admin/v1/game/rules"), 200)["items"]
    act = [x for x in items if x["status"] == "active"]
    check(len(act) == 1, f"активных версий правил: {len(act)}")
    return act[0]


def staff_api_headers(perms: set[str], step_up: bool = False) -> dict[str, str]:
    h = s2.staff_token("gamification", perms, str(uuid.uuid4()), "super_admin")
    if step_up:
        h["x-step-up"] = "ok"
    return h


# =============================================================================================== уборка стенда


def save_restore(heroes: dict[str, Any]) -> None:
    data = json.loads(RESTORE_FILE.read_text()) if RESTORE_FILE.exists() else {}
    data.setdefault("heroes", {}).update(heroes)
    RESTORE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=1))


def cleanup_leftovers() -> list[str]:
    """Остатки прерванного (или этого) прогона: события недели `e2e_*` → отмена, предметы `e2e_*` → снять с продажи,
    черновик правил e2e → удалить, активная версия правил с e2e-активацией → откат на based_on, картинки ступеней
    героев → исходные (файл восстановления). Только dev-стенд: staff API gamification от имени admin-bff (ключ стенда,
    X-Step-Up: ok), как уборка сценариев спринтов 2–5."""
    done: list[str] = []
    try:
        httpx.get(f"{GAME}/health/ready", timeout=5).raise_for_status()
    except httpx.HTTPError:
        return ["gamification недоступен — уборка пропущена"]
    base = f"{GAME}/internal/v1/admin/game"
    hdr = staff_api_headers(GAME_PERMS, step_up=True)
    reason = {"comment": "e2e: уборка после прогона"}
    if RESTORE_FILE.exists():
        data = json.loads(RESTORE_FILE.read_text())
        for code, fields in (data.get("heroes") or {}).items():
            live = next((h for h in expect(httpx.get(f"{base}/heroes", headers=hdr, timeout=20), 200)["items"]
                         if h["code"] == code), None)
            cur = [s["asset_id"] for s in (live or {}).get("stages", [])]
            if live and cur != [s["asset_id"] for s in fields["stages"]]:
                expect(httpx.put(f"{base}/heroes/{code}/draft", json=fields, headers=hdr, timeout=20), 200)
                expect(httpx.post(f"{base}/heroes/{code}/publish", json=reason, headers=hdr, timeout=20), 200)
                done.append(f"герой {code}: картинки ступеней восстановлены")
        RESTORE_FILE.unlink(missing_ok=True)
    for ev in expect(httpx.get(f"{base}/events", headers=hdr, timeout=20), 200)["items"]:
        if ev["code"].startswith(EVENT_PREFIX) and ev["status"] in ("draft", "published"):
            expect(httpx.post(f"{base}/events/{ev['event_id']}/cancel", json=reason, headers=hdr, timeout=20), 200)
            done.append(f"событие {ev['code']}: отменено")
    for it in expect(httpx.get(f"{base}/shop/items", headers=hdr, timeout=20), 200)["items"]:
        if it["code"].startswith(EVENT_PREFIX) and it["status"] == "published":
            expect(httpx.post(f"{base}/shop/items/{it['code']}/retire", json=reason, headers=hdr, timeout=20), 200)
            done.append(f"предмет {it['code']}: снят с продажи")
    versions = expect(httpx.get(f"{base}/rules", headers=hdr, timeout=20), 200)["items"]
    for v in versions:
        cm = v.get("comment") or ""
        if v["status"] == "draft" and "[e2e " in cm:
            r = httpx.delete(f"{base}/rules/draft", headers=hdr, timeout=20)
            check(r.status_code == 204, f"уборка: удалить черновик правил: {r.status_code} {r.text[:200]}")
            done.append(f"черновик правил v{v['version']}: удалён")
        if v["status"] == "active" and "[e2e " in cm and "активация" in cm and v.get("based_on"):
            expect(httpx.post(f"{base}/rules/{v['based_on']}/rollback",
                              json={"comment": "e2e: уборка — откат правил после прерванного прогона"},
                              headers=hdr, timeout=20), 200)
            done.append(f"правила v{v['version']} (e2e): откат на v{v['based_on']}")
    return done


# =============================================================================================== шаги


def s_stand(c: s2.Ctx) -> None:
    for name, url in [("gamification", f"{GAME}/health/ready"), ("lessons", f"{s4.LESSONS}/health/ready"),
                      ("memory", f"{s5.MEMORY}/health/ready"), ("learning-plan", f"{s1.LEARNING_PLAN}/health/ready"),
                      ("notifications", f"{s1.NOTIFICATIONS}/health/ready"), ("social", f"{s1.SOCIAL}/health/ready"),
                      ("identity-consent", f"{s1.IDENTITY}/health/ready"), ("audit", f"{s1.AUDIT}/health/ready"),
                      ("admin-bff", f"{c.bff}/health/ready"), ("telegram-bff", f"{TG_BFF}/health/ready"),
                      ("mock-telegram", f"{s1.MOCK_TG}/health")]:
        r = httpx.get(url, timeout=5)
        check(r.status_code == 200, f"{name} не ready: {r.status_code} {r.text[:200]}")
    missing = []
    u0 = str(uuid.uuid4())
    for method, path in (("GET", "/v1/game/summary"), ("GET", "/v1/game/heroes"), ("GET", "/v1/game/quests"),
                         ("GET", "/v1/game/badges"), ("GET", "/v1/game/shop"), ("GET", "/v1/game/history"),
                         ("GET", "/v1/game/settings"), ("PATCH", "/v1/game/settings"), ("PUT", "/v1/game/hero"),
                         ("PUT", "/v1/game/equipment"), ("POST", "/v1/game/shop/purchases"),
                         ("GET", f"/v1/game/rewards?source_session_id={u0}")):
        r = httpx.request(method, f"{TG_BFF}{path}", timeout=5)
        if r.status_code != 401:
            missing.append(f"telegram-bff {method} {path} → {r.status_code}")
    for path in ("/admin/v1/game/overview", "/admin/v1/game/rules", "/admin/v1/game/heroes", "/admin/v1/game/shop/items",
                 "/admin/v1/game/events", f"/admin/v1/game/wallets/{u0}"):
        r = httpx.get(f"{c.bff}{path}", timeout=5)
        if r.status_code != 401:
            missing.append(f"admin-bff GET {path} → {r.status_code}")
    check(not missing, f"маршруты спринта 6 не готовы (BFF): {missing}")
    # картинка — без авторизации; неизвестная → 404 ASSET_NOT_FOUND
    expect(public_asset(f"/v1/game/assets/{u0}/{'0' * 64}"), 404, "ASSET_NOT_FOUND")
    for line in [*cleanup_leftovers(), *s4.cleanup_leftovers()]:
        print(f"      уборка: {line}", flush=True)
    # gamification догоняет историю стрима после первого старта — дождаться, иначе события учеников ждут в очереди
    t0 = time.monotonic()

    def idle() -> bool:
        return all(v["pending"] == 0 and v["ack_pending"] == 0 for v in consumers("gamification_").values())

    if not idle():
        tail = {k: v["pending"] for k, v in consumers("gamification_").items() if v["pending"]}
        print(f"      gamification догоняет стрим: {tail}", flush=True)
        wait_for(idle, 300, interval=2.0, what="consumers gamification без хвоста")
        print(f"      хвост обработан за {time.monotonic() - t0:.0f} с", flush=True)
    seed = pj("SELECT json_build_object('heroes', (SELECT json_agg(json_build_object('code', code, 'stages', "
              "jsonb_array_length(stages), 'pub', published_at IS NOT NULL)) FROM gamification.heroes), "
              "'rules', (SELECT json_build_object('version', version, 'payload', payload) FROM "
              "gamification.rules_versions WHERE status = 'active'), "
              "'freeze', (SELECT status FROM gamification.shop_items WHERE code = 'streak_freeze'))")
    heroes = {h["code"]: h for h in seed["heroes"] or []}
    check(set(heroes) >= HEROES and all(heroes[k]["stages"] == 3 and heroes[k]["pub"] for k in HEROES),
          f"сид героев: {seed['heroes']}")
    check(seed["rules"] and seed["freeze"] == "published", f"активные правила / заморозка в магазине: {seed}")
    c.data["rules0"] = seed["rules"]
    c.data["levels"] = [int(x) for x in seed["rules"]["payload"]["levels"]]
    c.data["dlq_before"] = s1.dlq_counts()
    c.data["policy"] = expect(httpx.get(f"{TG_BFF}/v1/legal/policy", params={"lang": "ru"}), 200)
    c.lc.data["policy"] = c.data["policy"]
    print(f"      правила v{seed['rules']['version']}, героев {len(heroes)}", flush=True)


# ---------------------------------------------------------------- сотрудники


def s_staff(c: s2.Ctx) -> None:
    s3.warm_admin_identity(c)
    root = Staff(c.browser("root"), s2.BOOT_EMAIL, s2.BOOT_PASSWORD, display_name="Администратор")
    c.staff["root"] = root
    c.remember("пароль bootstrap", s2.BOOT_PASSWORD)
    r = root.browser.post("/admin/v1/auth/login", {"email": s2.BOOT_EMAIL, "password": s2.BOOT_PASSWORD})
    if r.status_code == 401:
        raise StepFailed("bootstrap-учётка уже использована — запускайте `run_local.sh game` (сбрасывает учётки "
                         "admin-identity)")
    me = s2.login(c, root, expect_next=["password_change", "mfa_enroll", "done"])
    check(me["staff"]["role"] == "super_admin", me["staff"])
    check(GAME_PERMS <= set(me["permissions"]), f"права игры у super_admin: {sorted(GAME_PERMS - set(me['permissions']))}")
    roles = {x["code"]: x for x in expect(root.browser.get("/admin/v1/roles"), 200)["items"]}
    perms = {k: set(v.get("permissions") or []) for k, v in roles.items()}
    bad = [f"{code}: {sorted(perms.get(code, set()) & GAME_PERMS)} ≠ {sorted(want)}" for code, want in ROLE_GAME.items()
           if perms.get(code, set()) & GAME_PERMS != want]
    bad += [f"{code}: {sorted(p & GAME_PERMS)}" for code, p in perms.items()
            if code not in ROLE_GAME and code != "super_admin" and p & GAME_PERMS]
    check(not bad, f"права игры в матрице ролей (PLAN «Права и роли»): {bad}")
    check(roles["operations"]["privileged"] is True, "operations (game.publish, wallet.adjust со step-up) — не "
                                                     "привилегированная роль")
    c.data["priv"] = {k: bool(roles[r_]["privileged"]) for k, r_ in (("cm", "content_manager"), ("ops", "operations"),
                                                                      ("sup", "support"))}
    s2.step_up(root)
    s3._create(c, "cm", "content_manager", "Камола Контент", c.data["priv"]["cm"])
    s3._create(c, "ops", "operations", "Олим Операции", c.data["priv"]["ops"])
    s3._create(c, "sup", "support", "Сабина Поддержка", c.data["priv"]["sup"])


def s_staff_login(c: s2.Ctx) -> None:
    for who, want in (("cm", ROLE_GAME["content_manager"]), ("ops", GAME_PERMS), ("sup", {"game.read"})):
        nxt = ["password_change", "mfa_enroll", "done"] if c.data["priv"][who] else ["password_change", "done"]
        me = s2.login(c, c.staff[who], expect_next=nxt)
        check(set(me["permissions"]) & GAME_PERMS == want, f"{who}: права игры {sorted(set(me['permissions']) & GAME_PERMS)}")


# ---------------------------------------------------------------- ученики, бонус регистрации


def registration_ok(u: s1.U, who: str) -> dict[str, Any]:
    s = wait_for(lambda: (x := summary(u))["freeze_stock"] == 2 and x, 90, interval=1.5,
                 what=f"{who}: бонус регистрации 2 заморозки (user.profile.created.v1 → gamification)")
    reg = [x for x in history(u) if x["reason"] == "registration_bonus"]
    check(len(reg) == 1 and reg[0]["currency"] == "freeze" and reg[0]["amount"] == 2 and reg[0]["status"] == "confirmed",
          f"{who}: операция бонуса регистрации {reg}")
    return s


def s_learners(c: s2.Ctx) -> None:
    lc = c.lc
    z = lc.data["zone_day"]
    c.data["marker"] = f"Zq{c.tag}x"
    s1.onboard(lc.user("LA", "Азиза"), zone=z, categories={"reminders": True})
    for role, name in (("LR", "Рустам"), ("LB", "Бобур")):
        s1.onboard(lc.user(role, name), zone=z, purposes=[*REQUIRED, "social"], categories={"social": True})
    for role, name in (("LE", "Элёр"), ("LX", "Хуршид"), ("P", "Парвина")):
        s1.onboard(lc.user(role, name), zone=z)
    p = lc.users["P"]
    kid_name = f"Камрон {c.tag}K"
    kid = p.ok("POST", "/v1/learners", 201, json={"display_name": kid_name, "age_band": "6-9"}, idem=True)
    c.data.update(kid=kid["learner_id"], kid_name=kid_name)
    p.switch(kid["learner_id"])
    try:
        s1.plan_patch(p, {"goal": "study", "level_self": "zero", "schedule": {
            "preset": "daily", "preferred_time": "17:00", "duration_min": 15, "reminders_enabled": False,
            "timezone": z}})
        p.ok("POST", "/v1/plan/onboarding/complete")
        ks = registration_ok(p, "ребёнок")
        check(ks["settings"]["celebrations"] == "quiet", f"ребёнок: празднования {ks['settings']}")
    finally:
        p.switch(p.account_id)
    la = lc.users["LA"]
    if la.learner_id != la.account_id:
        note(f"основной профиль: learner_id {la.learner_id} ≠ account_id {la.account_id}")
    for role in ("LA", "LR", "LB", "LE", "LX"):
        registration_ok(lc.users[role], role)
    s = summary(la)
    today = s1.loc(datetime.now(UTC), z).date().isoformat()
    want = {"level": 1, "xp_total": 0, "til_balance": 0, "hero": None, "purchase_available": False, "freeze_max": 5,
            "freeze_price_til": 40, "xp_level_start": 0, "xp_next_level": c.data["levels"][1],
            "equipment": {"background": None, "frame": None},
            # спринт 7 (bff.ts GameSettings): + league_opt_in — участие в общей лиге, по умолчанию false
            "settings": {"auto_freeze": True, "quests_hidden": False, "celebrations": "full", "game_notifications": True,
                         "league_opt_in": False}}
    diff = {k: s.get(k) for k, v in want.items() if s.get(k) != v}
    check(not diff, f"сводка нового ученика — отличия от ожидаемого: {json.dumps(diff, ensure_ascii=False)[:600]}")
    q = s["quests"]
    tpl = {t["code"]: t for t in c.data["rules0"]["payload"]["quests"]["templates"]}
    check(q["local_date"] == today and q["hidden"] is False and len(q["items"]) == 3
          and len({x["code"] for x in q["items"]}) == 3 and [x["slot"] for x in q["items"]] == [1, 2, 3]
          and all(x["code"] in tpl and "adults" in tpl[x["code"]]["audiences"] and x["status"] == "active"
                  and x["progress"] == 0 and x["target"] == tpl[x["code"]]["target"] for x in q["items"]),
          f"задания дня взрослого: {q}")
    check(la.ok("GET", "/v1/game/quests") == q, "задания дня при повторном запросе — другие (выбор не детерминирован)")
    check(la.ok("GET", "/v1/game/settings") == s["settings"], "GET /v1/game/settings ≠ сводка")
    c.data["la_quests"] = [x["code"] for x in q["items"]]
    print(f"      ученики LA, LR, LB, LE, LX, родитель + ребёнок 6–9: по 2 заморозки; задания LA: {c.data['la_quests']}",
          flush=True)


# ---------------------------------------------------------------- AT-63/64/68/70 урок → XP, тилы, уровень, задания, значок


def s_first_lesson(c: s2.Ctx) -> None:
    la = c.lc.users["LA"]
    seq = s1.tg_last_seq()
    les = s5.pass_lesson(c, la, OPEN_OK)
    sid = les["sid"]
    passed = les["summary"]["evaluation"]["passed"]
    earn = c.data["rules0"]["payload"]["earn"]
    r = wait_rewards(la, sid, lambda x: x["status"] == "ready" and bool(ops_of(x, "lesson", "xp")),
                     "награды урока (lesson.session.completed.v1 → gamification)")
    xp_op, til_op = ops_of(r, "lesson", "xp"), ops_of(r, "lesson", "til")
    check(len(xp_op) == 1 and len(til_op) == 1, f"операции урока: {r['operations']}")
    op_ok(xp_op[0], earn["lesson"]["xp"] + (earn["lesson_passed_bonus"]["xp"] if passed else 0), what="XP урока")
    op_ok(til_op[0], earn["lesson"]["til"] + (earn["lesson_passed_bonus"]["til"] if passed else 0), what="тилы урока")
    # навыки урока (diagnostics) → skill_demonstrated; в наградах этого же занятия (§1.8)
    deferred: list[str] = []
    n = wait_for(lambda: held(la) or None, 40, interval=1.0, what="навыки урока в карте (assessment → diagnostics)")
    wait_for(lambda: len([x for x in history(la, "xp") if x["reason"] == "skill_demonstrated"]) == n, 40, interval=1.0,
             what=f"начисления за {n} подтверждённых навыков (skills.state.changed.v1 → gamification)")
    for o in [x for x in history(la) if x["reason"] == "skill_demonstrated"]:
        op_ok(o, earn["skill_demonstrated"][o["currency"]], what=f"навык ({o['currency']})")
    try:
        r = wait_rewards(la, sid, lambda x: len(ops_of(x, "skill_demonstrated", "xp")) == n, "навыки в наградах занятия", 10)
    except StepFailed:
        r = rewards(la, sid)
        deferred.append(attribution_defect(sid, "skill_demonstrated"))
    # все операции навыков урока — в наградах этого занятия (реестр неизменяем: пришедшие раньше урока операции
    # привязываются к занятию через итоги занятия, а не через source_session_id)
    skill_ids = {x["op_id"] for x in history(la) if x["reason"] == "skill_demonstrated"}
    if not deferred and not skill_ids <= {o["op_id"] for o in r["operations"]}:
        deferred.append(attribution_defect(sid, "skill_demonstrated (часть операций)"))
    badges = {b["code"]: b for b in r["badges"]}
    fl = badges.get("first_lesson")
    check(fl and fl["earned_at"] and fl["basis"] == {"metric": "lessons", "value": 1, "threshold": 1}
          and fl["title"]["ru"], f"значок «Первый урок» в наградах: {r['badges']}")
    s = summary(la)
    hist = history(la)
    tot = totals(hist)
    check(s["xp_total"] == tot["xp"] and s["til_balance"] == tot["til"] and s["freeze_stock"] == tot["freeze"],
          f"баланс ≠ сумма операций: сводка {s['xp_total']}/{s['til_balance']}/{s['freeze_stock']}, история {tot}")
    check(all(x["reason"] and x["status"] == "confirmed" and x["op_id"] for x in hist), f"история: {hist[:3]}")
    check("comment" not in json.dumps(hist) and "actor" not in json.dumps(hist), "в истории ученика поля сотрудника")
    lv = level_of(s["xp_total"], c.data["levels"])
    levels = c.data["levels"]
    check(s["level"] == lv and s["xp_level_start"] == levels[lv - 1]
          and s["xp_next_level"] == (levels[lv] if lv < len(levels) else None),
          f"уровень {s['level']} при XP {s['xp_total']} (по порогам — {lv})")
    if lv > 1:
        if not deferred:
            check(r["level_up"] == {"from": 1, "to": lv}, f"новый уровень в наградах: {r['level_up']}")
        ev = wait_for(lambda: outbox("gamification", "game.level.reached.v1", c.data["started_at"], la.learner_id), 20,
                      what="game.level.reached.v1")
        check(ev[-1]["level"] == lv and ev[-1]["xp_total"] <= s["xp_total"], f"game.level.reached.v1: {ev}")
    # задания дня: прогресс по событиям, награда — операцией quest
    q = la.ok("GET", "/v1/game/quests")
    done_q = [x for x in q["items"] if x["status"] == "completed"]
    quest_ops = [x for x in hist if x["reason"] == "quest"]
    for x in q["items"]:
        if x["kind"] == "lesson_complete":
            check(x["status"] == "completed" and x["progress"] == 1, f"задание «урок»: {x}")
        if x["kind"] == "skill_confirmed":
            check(x["progress"] == min(n, x["target"]), f"задание «навык»: {x}")
    want_quest_ops = sum((1 if x["reward"]["xp"] else 0) + (1 if x["reward"]["til"] else 0) for x in done_q)
    check(len(quest_ops) == want_quest_ops, f"операции заданий {len(quest_ops)}, ожидали {want_quest_ops}: {done_q}")
    if not deferred:
        check({(x["slot"]) for x in r["quests_completed"]} == {x["slot"] for x in done_q},
              f"выполненные задания в наградах занятия: {r['quests_completed']} / {done_q}")
    if len(done_q) == 3:
        check(q["bonus_received"] is True and [x for x in hist if x["reason"] == "quest_bonus"], "бонус за все три")
    # значки: выданный — первым, с основанием; невыданные — условие и прогресс
    b = la.ok("GET", "/v1/game/badges")["items"]
    check(b and b[0]["code"] == "first_lesson" and b[0]["earned_at"]
          and all(x["earned_at"] is None and 0 <= x["basis"]["value"] <= x["basis"]["threshold"] for x in b[1:]),
          f"значки: {[(x['code'], x['earned_at'], x['basis']) for x in b]}")
    ev = wait_for(lambda: [x for x in outbox("gamification", "game.badge.earned.v1", c.data["started_at"], la.learner_id)
                           if x["badge_code"] == "first_lesson"], 20, what="game.badge.earned.v1 first_lesson")
    check(ev[0]["notify"] is True, f"game.badge.earned.v1: {ev}")
    items = wait_for(lambda: [x for x in la.inbox() if "Новый значок: Первый урок" in x["body"]], 30, interval=1.0,
                     what="уведомление badge_earned в центре LA (notifications)")
    check(len(items) == 1, f"уведомлений о значке: {items}")
    if not s1.tg_sent(la.tg_id, seq, contains="Новый значок"):
        note("badge_earned: в центре есть, в Telegram LA (категория reminders включена) — нет")
    c.data.update(la_lesson1=sid, la_held=n, la_sessions=[sid])
    print(f"      урок {les['lesson_id']} (passed={passed}): навыков {n}, XP {s['xp_total']}, тилов {s['til_balance']}, "
          f"уровень {s['level']}; заданий выполнено {len(done_q)}/3; значок first_lesson", flush=True)
    if deferred:
        raise StepFailed("; ".join(deferred))


def s_replay(c: s2.Ctx) -> None:
    """AT-63: повтор события (адресный повтор, тот же event_id) не даёт второй операции."""
    need(c, "la_lesson1")
    la = c.lc.users["LA"]
    sid = c.data["la_lesson1"]
    env = pj("SELECT envelope FROM lessons.outbox WHERE envelope->>'event_type' = 'lesson.session.completed.v1' "
             f"AND envelope->'payload'->>'session_id' = '{uid(sid)}' LIMIT 1")
    check(env and env["payload"]["status"] == "completed", f"событие урока в outbox lessons: {env}")
    check(inbox_count(env["event_id"]) == 1, "событие урока не в inbox gamification")
    before_h, before_s = history(la), summary(la)
    seq = replay(env, "gamification_lessons")
    wait_delivered("gamification_lessons", seq)
    time.sleep(1.0)
    after_h, after_s = history(la), summary(la)
    check([x["op_id"] for x in after_h] == [x["op_id"] for x in before_h], "повтор события дал новые операции")
    check({k: after_s[k] for k in ("xp_total", "til_balance", "level")}
          == {k: before_s[k] for k in ("xp_total", "til_balance", "level")}, "повтор события изменил кошелёк")
    check(inbox_count(env["event_id"]) == 1, "inbox: дубль event_id")
    n = int(s1._psql("SELECT count(*) FROM gamification.ledger WHERE idempotency_key LIKE "
                     f"'lesson:{uid(env['event_id'])}%'"))
    check(n == 2, f"операций урока по ключу lesson:<event_id>: {n} (ожидали 2 — XP и тилы)")
    print(f"      повтор lesson.session.completed.v1 (seq {seq}) → операций не прибавилось", flush=True)


def s_review_reading(c: s2.Ctx) -> None:
    """AT-63: повторение и чтение → начисления по правилам."""
    need(c, "la_lesson1")
    la = c.lc.users["LA"]
    earn = c.data["rules0"]["payload"]["earn"]
    ov = wait_for(lambda: (o := la.ok("GET", "/v1/memory/overview"))["new_available"] >= 5 and o, 30, interval=1.0,
                  what="карточки урока для повторения")
    s = la.ok("POST", "/v1/memory/review-sessions", 201, idem=True)
    rsid = s["session_id"]
    s5.run_review(c, la, rsid, lambda t, n: "right", [], {})
    fin = la.ok("POST", f"/v1/memory/review-sessions/{rsid}/finish")
    check(fin["status"] == "completed" and fin["reviewed"] >= earn["review"]["min_cards"],
          f"итоги повторения: {fin} (обзор {ov})")
    r = wait_rewards(la, rsid, lambda x: x["status"] == "ready" and bool(ops_of(x, "review", "xp")),
                     "награды повторения (memory.review.completed.v1 → gamification)")
    op_ok(ops_of(r, "review", "xp")[0], earn["review"]["xp_base"] + min(fin["correct"], earn["review"]["xp_per_correct_cap"]),
          what="XP повторения")
    til = ops_of(r, "review", "til")
    if til:
        op_ok(til[0], earn["review"]["til"], what="тилы повторения")
    else:
        note("тилы за повторение не начислены (дневной лимит тилов исчерпан?)")
    q = {x["kind"]: x for x in la.ok("GET", "/v1/game/quests")["items"]}
    if "review_cards" in q:
        check(q["review_cards"]["progress"] == min(fin["reviewed"], q["review_cards"]["target"]),
              f"задание «повторить карточки»: {q['review_cards']}")
    sid = reading_session(c, la)
    r = wait_reading_reward(la, sid)
    op_ok(ops_of(r, "reading", "xp")[0], earn["reading"]["xp"], what="XP чтения")
    if ops_of(r, "reading", "til"):
        op_ok(ops_of(r, "reading", "til")[0], earn["reading"]["til"], what="тилы чтения")
    b = {x["code"]: x for x in la.ok("GET", "/v1/game/badges")["items"]}
    check(b.get("readings_10", {}).get("basis", {}).get("value") == 1, f"прогресс значка «10 текстов»: {b.get('readings_10')}")
    s_ = summary(la)
    tot = totals(history(la))
    check(s_["xp_total"] == tot["xp"] and s_["til_balance"] == tot["til"], f"баланс ≠ сумма операций: {tot}")
    xp_today = sum(x["amount"] for x in history(la, "xp") if x["reason"] in CAPPED)
    til_today = sum(x["amount"] for x in history(la, "til") if x["reason"] in CAPPED)
    caps = c.data["rules0"]["payload"]["caps"]
    check(xp_today <= caps["xp_per_day"] and til_today <= caps["til_per_day"],
          f"дневной лимит: XP {xp_today}/{caps['xp_per_day']}, тилы {til_today}/{caps['til_per_day']}")
    c.data["la_reading"] = sid
    print(f"      повторение {fin['reviewed']} карточек (верно {fin['correct']}) и чтение → начисления; XP {s_['xp_total']}, "
          f"тилов {s_['til_balance']} (за день: XP {xp_today}, тилов {til_today})", flush=True)


# ---------------------------------------------------------------- AT-65 герои и ступени


def s_heroes(c: s2.Ctx) -> None:
    need(c, "la_lesson1")
    la = c.lc.users["LA"]
    root = c.staff["root"]
    th = [int(x) for x in c.data["rules0"]["payload"]["hero"]["stage_thresholds"]]
    hs = la.ok("GET", "/v1/game/heroes")
    items = {h["code"]: h for h in hs["items"]}
    check(set(items) == HEROES and hs["selected"] is None and hs["stage"] == 1, f"герои: {sorted(items)} {hs['selected']}")
    url_re = re.compile(r"^/v1/game/assets/([0-9a-f-]{36})/([0-9a-f]{64})$")
    for h in hs["items"]:
        st = h["stages"]
        check([x["stage"] for x in st] == [1, 2, 3] and [x["skills_required"] for x in st] == th
              and all(url_re.match(x["image"]["url"]) and x["image"]["width"] > 0 and x["image"]["height"] > 0
                      and x["name"]["ru"] for x in st) and h["name"]["ru"] and h["tagline"]["ru"],
              f"герой {h['code']}: {json.dumps(h, ensure_ascii=False)[:400]}")
    c.data["adult_order"] = [h["code"] for h in hs["items"]]
    img = items["robot_1"]["stages"][0]["image"]
    a = public_asset(img["url"])
    check(a.status_code == 200 and a.headers.get("content-type", "").startswith(("image/webp", "image/png"))
          and "immutable" in a.headers.get("cache-control", "") and hashlib.sha256(a.content).hexdigest()
          == url_re.match(img["url"]).group(2), f"картинка героя без авторизации: {a.status_code} {a.headers}")  # type: ignore[union-attr]
    before = summary(la)
    s = la.ok("PUT", "/v1/game/hero", json={"hero_code": "robot_1"})
    w = admin_wallet(root, la.learner_id)
    hero = s["hero"]
    check(hero and hero["code"] == "robot_1" and hero["stage"] == 1 and hero["image"] == img
          and hero["confirmed_skills"] == w["confirmed_skills"] and hero["stage_name"]["ru"]
          and hero["next_stage_at"] == max(0, th[1] - w["confirmed_skills"]), f"выбранный герой: {hero}")
    la.ok("PUT", "/v1/game/hero", 404, "HERO_NOT_FOUND", json={"hero_code": "robot_9"})
    la.ok("PUT", "/v1/game/hero", 422, json={"hero_code": "dragon_9"})
    s = la.ok("PUT", "/v1/game/hero", json={"hero_code": "human_1"})
    check(s["hero"]["code"] == "human_1" and s["hero"]["stage"] == 1
          and (s["xp_total"], s["level"], s["til_balance"]) == (before["xp_total"], before["level"], before["til_balance"]),
          f"смена героя изменила XP/уровень/тилы: {s['xp_total']}/{s['level']} ≠ {before['xp_total']}/{before['level']}")
    check(la.ok("GET", "/v1/game/heroes")["selected"] == "human_1", "выбранный герой в списке")
    shop_kinds = {x["kind"] for x in la.ok("GET", "/v1/game/shop")["items"]}
    check(shop_kinds <= {"background", "hero_frame", "streak_freeze"}, f"в магазине есть рост героя: {shop_kinds}")
    # уроки, пока подтверждённых навыков не станет ≥ ступени 2
    stage_sid = None
    lessons_done = 0
    for _ in range(4):
        cur = admin_wallet(root, la.learner_id)["confirmed_skills"]
        if cur >= th[1]:
            break
        h0 = held(la)
        les = s5.pass_lesson(c, la, OPEN_OK)
        c.data.setdefault("la_sessions", []).append(les["sid"])
        lessons_done += 1
        try:
            wait_for(lambda h0=h0: held(la) > h0, 40, interval=1.5, what="новые навыки урока в карте")
        except StepFailed:
            note(f"урок {les['lesson_id']} не подтвердил новых навыков")
        wait_for(lambda: admin_wallet(root, la.learner_id)["confirmed_skills"] == held(la), 45, interval=1.5,
                 what="подтверждённые навыки урока в gamification (skills.state.changed.v1)")
        if admin_wallet(root, la.learner_id)["confirmed_skills"] >= th[1]:
            stage_sid = les["sid"]
    w = admin_wallet(root, la.learner_id)
    check(w["confirmed_skills"] >= th[1], f"после {lessons_done} уроков подтверждённых навыков {w['confirmed_skills']}")
    s = summary(la)
    hs = la.ok("GET", "/v1/game/heroes")
    h1 = next(h for h in hs["items"] if h["code"] == "human_1")
    check(s["hero"]["stage"] == 2 and hs["stage"] == 2 and s["hero"]["image"] == h1["stages"][1]["image"]
          and s["hero"]["image"]["url"] != h1["stages"][0]["image"]["url"] and s["hero"]["stage_name"] == h1["stages"][1]["name"]
          and s["hero"]["next_stage_at"] == th[2] - w["confirmed_skills"] and w["hero"] == {"code": "human_1", "stage": 2},
          f"ступень 2: {s['hero']} / {w['hero']}")
    deferred: list[str] = []
    if stage_sid:
        try:
            r = wait_rewards(la, stage_sid, lambda x: x["hero_stage_up"] is not None, "рост героя в наградах занятия", 15)
            check(r["hero_stage_up"] == {"from": 1, "to": 2}, f"hero_stage_up: {r['hero_stage_up']}")
        except StepFailed:
            other = pj("SELECT coalesce(json_agg(session_id), '[]') FROM gamification.session_rewards WHERE user_id = "
                       f"'{uid(la.learner_id)}' AND stage_to = 2") or []
            known = {c.data.get("la_reading"): "чтения (G06)", c.data.get("la_lesson1"): "первого урока (G04)"}
            where = [f"{x} — итоги {known.get(x, 'другого занятия')}" for x in other]
            deferred.append(attribution_defect(stage_sid, "hero_stage_up")
                            + (f"; рост героя записан в итоги другого занятия: {where}" if where else ""))
    ev = wait_for(lambda: outbox("gamification", "game.hero.stage_reached.v1", c.data["started_at"], la.learner_id), 20,
                  what="game.hero.stage_reached.v1")
    check(len(ev) == 1 and ev[0]["stage"] == 2 and ev[0]["hero_code"] == "human_1"
          and ev[0]["confirmed_skills"] >= th[1] and ev[0]["notify"] is True, f"game.hero.stage_reached.v1: {ev}")
    items_n = wait_for(lambda: [x for x in la.inbox() if "Ученик Тимур вырос: Путешественник" in x["body"]], 30,
                       interval=1.0, what="уведомление hero_stage_reached в центре LA")
    check(len(items_n) == 1, f"уведомлений о росте героя: {items_n}")
    c.data.update(la_stage=2, la_hero="human_1")
    if deferred:
        print(f"      герой human_1: ступень 2, картинка {s['hero']['image']['url'][-12:]}", flush=True)
        raise StepFailed("; ".join(deferred))
    print(f"      герой robot_1 → human_1 (XP и уровень сохранены); ещё уроков {lessons_done} → подтверждённых навыков "
          f"{w['confirmed_skills']} → ступень 2, картинка {s['hero']['image']['url'][-12:]}", flush=True)


# ---------------------------------------------------------------- AT-66/67 пропуск дня с заморозкой


def freeze_zone() -> tuple[str, datetime, bool]:
    """Пояс плана, где местная полночь — между прошлым plan:tick и сейчас (пропуск вчерашнего дня выпустит ближайший
    tick); если такого нет — ближайшая будущая полночь (ждём её). → (пояс, полночь UTC, ждать ли)."""
    raw = s1._psql("SELECT coalesce(extract(epoch FROM last_tick_at)::text, '') FROM learning_plan.tick_state WHERE id = 1")
    if not raw:
        s1.plan_tick()  # первая строка tick_state — окно пустое
        raw = s1._psql("SELECT extract(epoch FROM last_tick_at)::text FROM learning_plan.tick_state WHERE id = 1")
    last = datetime.fromtimestamp(float(raw), UTC)
    now = datetime.now(UTC)
    best: tuple[datetime, str] | None = None
    for z in s1.ZONES:
        local = s1.loc(now, z)
        midnight = datetime.combine(local.date(), dtime(0), tzinfo=ZoneInfo(z)).astimezone(UTC)
        if midnight > last + timedelta(seconds=5) and midnight < now - timedelta(seconds=30) \
                and midnight > now - timedelta(hours=20) and (best is None or midnight > best[0]):
            best = (midnight, z)
    if best:
        return best[1], best[0], False
    z, m = s1.pick_midnight_zone(now, timedelta(seconds=200))
    return z, m, True


def s_freeze(c: s2.Ctx) -> None:
    lc = c.lc
    since = int(time.time()) - 1
    z, midnight, wait = freeze_zone()
    today = midnight.astimezone(ZoneInfo(z)).date()  # день, начавшийся в эту полночь
    missed_d, act_d = today - timedelta(days=1), today - timedelta(days=2)
    print(f"      пояс плана {z}: полночь {iso_z(midnight)} ({'ждём' if wait else 'уже прошла'}), пропуск {missed_d}",
          flush=True)
    lf, lg = lc.user("LF", "Фарида"), lc.user("LG", "Гулнора")
    s1.onboard(lf, zone=z, categories={"reminders": True}, quiet=None)
    s1.onboard(lg, zone=z, categories={"reminders": True}, quiet=None)
    st = lg.ok("PATCH", "/v1/game/settings", json={"auto_freeze": False})
    check(st["auto_freeze"] is False and st["quests_hidden"] is False, f"автозаморозка выключена: {st}")
    for u in (lf, lg):
        registration_ok(u, u.role)
        reading_session(c, u)
    for u in (lf, lg):
        wait_for(lambda u=u: int(s1._psql("SELECT count(*) FROM learning_plan.activities WHERE user_id = "
                                          f"'{uid(u.account_id)}'")) > 0,
                 30, interval=1.0, what=f"{u.role}: занятие записано (learning-plan)")
    ids = f"'{uid(lf.account_id)}', '{uid(lg.account_id)}'"
    # ТЕСТОВЫЕ ИЗМЕНЕНИЯ БД: занятие было позавчера, график действует уже 3 дня (ждать сутки нельзя)
    s5.shift_rows(f"UPDATE learning_plan.activities SET local_date = '{act_d.isoformat()}' WHERE user_id IN ({ids}) "
                  "RETURNING user_id", f"занятие LF/LG → {act_d}")
    s5.shift_rows("UPDATE learning_plan.plans SET onboarding_completed_at = onboarding_completed_at - interval '3 days', "
                  f"schedule_set_at = schedule_set_at - interval '3 days' WHERE user_id IN ({ids}) RETURNING user_id",
                  "график LF/LG −3 дня")
    if wait:
        s1.sleep_until(midnight + timedelta(seconds=3), f"местную полночь в {z}")
    seq = s1.tg_last_seq()
    res = s1.plan_tick()
    marks = s1._psql("SELECT coalesce(string_agg(user_id || ':' || kind, ','), '') FROM learning_plan.slot_marks "
                     f"WHERE local_date = '{missed_d.isoformat()}' AND user_id IN ({ids})")
    check(res["missed"] >= 2 and sorted(marks.split(",")) == sorted([f"{uid(lf.account_id)}:missed",
                                                                      f"{uid(lg.account_id)}:missed"]),
          f"plan:tick: {res}, отметки {missed_d}: {marks}")
    # gamification: LF — заморозка −1 → game.streak.frozen.v1; LG (автозаморозка выключена) — без списания
    wait_for(lambda: summary(lf)["freeze_stock"] == 1, 40, interval=1.0,
             what="LF: заморозка списана (learning.session.missed.v1 → gamification)")
    fz = [x for x in history(lf) if x["reason"] == "streak_freeze"]
    check(len(fz) == 1 and fz[0]["currency"] == "freeze" and fz[0]["amount"] == -1, f"LF: операция заморозки {fz}")
    ev = wait_for(lambda: outbox("gamification", "game.streak.frozen.v1", since, lf.learner_id), 20,
                  what="game.streak.frozen.v1")
    check(len(ev) == 1 and ev[0]["local_date"] == missed_d.isoformat() and ev[0]["freeze_left"] == 1
          and ev[0]["op_id"] == fz[0]["op_id"], f"game.streak.frozen.v1: {ev}")
    lg_missed = outbox_envelopes("learning_plan", "learning.session.missed.v1", since, lg.account_id)
    check(len(lg_missed) == 1, f"learning.session.missed.v1 LG: {len(lg_missed)}")
    wait_for(lambda: inbox_count(lg_missed[0]["event_id"]) == 1, 30, interval=1.0, what="пропуск LG обработан gamification")
    check(summary(lg)["freeze_stock"] == 2 and not [x for x in history(lg) if x["reason"] == "streak_freeze"]
          and not outbox("gamification", "game.streak.frozen.v1", since, lg.learner_id),
          "LG: заморозка списана при выключенной автозаморозке")
    # learning-plan: замороженный день не рвёт серию, неделя — frozen; LG — серия прервалась мягко
    t = wait_for(lambda: (x := lf.ok("GET", "/v1/plan/today"))["streak_days"] == 1 and x, 30, interval=1.0,
                 what="LF: серия сохранена (game.streak.frozen.v1 → learning-plan)")
    tg = lg.ok("GET", "/v1/plan/today")
    check(tg["streak_days"] == 0, f"LG без заморозки: серия {tg['streak_days']} (ожидали 0)")
    wk, wkg = {d["local_date"]: d for d in t["week"]}, {d["local_date"]: d for d in tg["week"]}
    if missed_d.isoformat() in wk:
        check(wk[missed_d.isoformat()]["missed"] is True and wk[missed_d.isoformat()]["frozen"] is True,
              f"неделя LF {missed_d}: {wk[missed_d.isoformat()]}")
        check(wkg[missed_d.isoformat()]["missed"] is True and wkg[missed_d.isoformat()]["frozen"] is False,
              f"неделя LG {missed_d}: {wkg[missed_d.isoformat()]}")
    else:
        note(f"{missed_d} — прошлая неделя (сегодня понедельник в {z}): week[].frozen не проверен")
    check(int(s1._psql(f"SELECT count(*) FROM learning_plan.frozen_days WHERE user_id = '{uid(lf.account_id)}' AND "
                       f"local_date = '{missed_d.isoformat()}'")) == 1, "frozen_days LF")
    b = {x["code"]: x for x in lf.ok("GET", "/v1/game/badges")["items"]}
    check(b.get("first_freeze", {}).get("earned_at"), f"значок «Первая заморозка»: {b.get('first_freeze')}")
    # уведомление «Серия спасена» — LF (центр и Telegram), LG — нет
    items = wait_for(lambda: [x for x in lf.inbox() if x["title"] == "Серия спасена"], 30, interval=1.0,
                     what="уведомление streak_frozen в центре LF")
    check(len(items) == 1 and f"Заморозка закрыла пропуск {missed_d.strftime('%d.%m')}" in items[0]["body"]
          and "Осталось заморозок: 1" in items[0]["body"], f"streak_frozen: {items}")
    msgs = wait_for(lambda: s1.tg_sent(lf.tg_id, seq, contains="Заморозка закрыла пропуск"), 30, interval=1.0,
                    what="streak_frozen в Telegram LF")
    check(len(msgs) == 1, f"сообщений streak_frozen: {len(msgs)}")
    check(not [x for x in lg.inbox() if x["title"] == "Серия спасена"], "LG получил «Серия спасена»")
    # повтор: tick не выпускает пропуск снова; повтор события — без второго списания
    s1.plan_tick()
    lf_missed = outbox_envelopes("learning_plan", "learning.session.missed.v1", since, lf.account_id)
    check(len(lf_missed) == 1, f"пропусков LF: {len(lf_missed)}")
    sq = replay(lf_missed[0], "gamification_missed")
    wait_delivered("gamification_missed", sq)
    time.sleep(1.0)
    check(summary(lf)["freeze_stock"] == 1 and len(outbox("gamification", "game.streak.frozen.v1", since, lf.learner_id)) == 1,
          "повтор пропуска списал вторую заморозку")
    c.data.update(freeze_done=True, freeze_zone=z)
    print(f"      LF: {missed_d} пропуск → заморозка (осталось 1), серия {t['streak_days']}, неделя frozen, «Серия спасена» в "
          f"центре и Telegram; LG (автозаморозка выкл.): серия 0, заморозки 2", flush=True)


# ---------------------------------------------------------------- AT-67 реферал


def s_referral(c: s2.Ctx) -> None:
    """Спринт 7 (INTERNAL_API спринта 7 §2.4, §11): правило спринта 6 «+2 заморозки после первого урока
    приглашённого» отключено — новых pending в gamification нет; реферал ведёт social (диагностика, 3 урока в 2 дня,
    антифрод), награду gamification начисляет по social.referral.qualified.v1 (полный путь — scenario_social.py S07).
    Здесь: принятие → первый урок приглашённого → бонуса нет, у пригласившего реферал «в процессе»; повтор события —
    без бонуса. Уведомления игры — своя категория game (по умолчанию включена): выключил — значок только в центре."""
    lr, lb = c.lc.users["LR"], c.lc.users["LB"]
    root = c.staff["root"]
    inv = lr.ok("POST", "/v1/invites", 201, json={"kind": "referral"}, idem=True)
    check(inv["kind"] == "referral" and inv["expires_at"] is None and "startapp=inv_" in inv["link"], f"реферал: {inv}")
    token = inv["link"].split("startapp=inv_", 1)[1]
    c.secrets["токен реферальной ссылки"] = token
    pv = lb.ok("POST", "/v1/invites/open", json={"token": token})
    check(pv["can_accept"] is True and pv["kind"] == "referral", f"карточка реферала: {pv}")
    lb.ok("POST", f"/v1/invites/{inv['invite_id']}/accept")
    ref = wait_for(lambda: next(iter(lr.ok("GET", "/v1/referrals")["items"]), None), 20, interval=1.0,
                   what="реферал у пригласившего (social)")
    check(ref["status"] in ("invited", "diagnostic_done") and ref["progress"]["lessons"] == 0 and ref["reward"] is None,
          f"реферал после принятия: {ref}")
    time.sleep(2.0)
    w = admin_wallet(root, lr.learner_id)
    check(w["freeze_stock"] == 2 and w["referrals"] == {"pending": 0, "rewarded": 0, "capped": 0},
          f"спринт 7: новых pending в gamification нет — {w['freeze_stock']} {w['referrals']}")
    # выключатель категории game: значок приглашённого — только в центре, без Telegram
    st = lb.ok("PATCH", "/v1/profile/settings", json={"notifications": {"categories": {"game": False}}})
    check((st.get("notifications") or {}).get("categories", {}).get("game") is False,
          f"категория game не выключилась: {str(st.get('notifications'))[:300]}")
    seq = s1.tg_last_seq()
    les = s5.pass_lesson(c, lb, OPEN_OK)
    ref = wait_for(lambda: (x := lr.ok("GET", "/v1/referrals")["items"][0])["progress"]["lessons"] == 1 and x, 30,
                   interval=1.0, what="зачётный урок приглашённого (lesson.session.completed.v1 → social)")
    check(ref["status"] == "learning" and ref["reward"] is None, f"реферал после первого урока: {ref}")
    time.sleep(3.0)
    check(summary(lr)["freeze_stock"] == 2 and not [x for x in history(lr) if x["reason"] == "referral_bonus"],
          "бонус пригласившему после первого урока (правило спринта 6 отключено в спринте 7)")
    w = admin_wallet(root, lr.learner_id)
    check(w["referrals"] == {"pending": 0, "rewarded": 0, "capped": 0}, f"рефералы в кошельке: {w['referrals']}")
    check(summary(lb)["freeze_stock"] == 2, "приглашённому начислены заморозки за реферал")
    env = pj("SELECT envelope FROM lessons.outbox WHERE envelope->>'event_type' = 'lesson.session.completed.v1' "
             f"AND envelope->'payload'->>'session_id' = '{uid(les['sid'])}' LIMIT 1")
    sq = replay(env, "gamification_lessons")
    wait_delivered("gamification_lessons", sq)
    time.sleep(1.0)
    check(summary(lr)["freeze_stock"] == 2, "повтор урока приглашённого дал бонус")
    items = wait_for(lambda: [x for x in lb.inbox() if "Новый значок: Первый урок" in x["body"]], 30, interval=1.0,
                     what="LB (категория game выключена): значок в центре уведомлений")
    check(len(items) == 1 and items[0]["telegram"] == "in_app_only" and items[0]["category"] == "game",
          f"значок LB в центре: {items}")
    time.sleep(1.0)
    check(not s1.tg_sent(lb.tg_id, seq, contains="Новый значок"), "значок ушёл в Telegram при выключенной категории game")
    print(f"      LR пригласил LB → реферал «{ref['status']}» (уроков {ref['progress']['lessons']}/"
          f"{ref['progress']['lessons_required']}); первый урок — без бонуса (правило спринта 6 отключено); повтор — "
          "без бонуса; значок при выключенной категории game — только центр", flush=True)


# ---------------------------------------------------------------- AT-69 магазин


def s_shop(c: s2.Ctx) -> None:
    need(c, "la_lesson1")
    la, le = c.lc.users["LA"], c.lc.users["LE"]
    cm, ops = c.staff["cm"], c.staff["ops"]
    code = f"e2e_bg_{c.tag.lower()}"
    body = {"code": code, "kind": "background", "title": {"ru": f"Фон e2e {c.tag}", "uz": f"Fon e2e {c.tag}"},
            "description": {"ru": "Фон для проверки магазина", "uz": "Doʻkonni tekshirish uchun fon"},
            "asset_id": None, "theme": {"bg": "--mark", "accent": "--pen"}, "price_til": 7,
            "audiences": ["kids", "teens", "adults"], "available_from": None, "available_until": None, "order": 900}
    k = str(uuid.uuid4())
    it = expect(cm.browser.post("/admin/v1/game/shop/items", body, headers={"idempotency-key": k}), 201)
    check(it["status"] == "draft" and it["price_til"] == 7 and it["owners"] == 0, f"предмет: {it}")
    check(expect(cm.browser.post("/admin/v1/game/shop/items", body, headers={"idempotency-key": k}), 200)["code"] == code,
          "повтор Idempotency-Key создания предмета")
    expect(cm.browser.post("/admin/v1/game/shop/items", {**body, "kind": "streak_freeze"}, headers=idem()), 422)
    denied = s3.rbac_denied(cm.browser, "POST", f"/admin/v1/game/shop/items/{code}/publish", {"comment": "e2e: в продажу"},
                            "game.publish")
    check(denied is None, denied)
    s2.ensure_step_up(ops)
    pub = expect(ops.browser.post(f"/admin/v1/game/shop/items/{code}/publish", {"comment": "e2e: в продажу"}), 200)
    check(pub["status"] == "published", f"публикация предмета: {pub}")
    c.data["shop_item"] = code
    sh = la.ok("GET", "/v1/game/shop")
    mine = {x["code"]: x for x in sh["items"]}
    check(code in mine and mine[code]["can_buy"] is (sh["til_balance"] >= 7) and mine[code]["price_til"] == 7
          and mine[code]["theme"] == {"bg": "--mark", "accent": "--pen"} and "streak_freeze" in mine
          and mine["streak_freeze"]["price_til"] == 40, f"витрина: {json.dumps(sh, ensure_ascii=False)[:500]}")
    bal0 = sh["til_balance"]
    check(bal0 >= 7, f"LA: тилов {bal0} — не хватает на предмет за 7")
    la.ok("POST", "/v1/game/shop/purchases", 422, "IDEMPOTENCY_KEY_REQUIRED", json={"item_code": code})
    key = str(uuid.uuid4())
    p1 = la.ok("POST", "/v1/game/shop/purchases", json={"item_code": code}, idem=key)
    check(p1["item_code"] == code and p1["price_til"] == 7 and p1["til_balance"] == bal0 - 7 and p1["purchase_id"],
          f"покупка: {p1}")
    p2 = la.ok("POST", "/v1/game/shop/purchases", json={"item_code": code}, idem=key)
    check(p2 == p1, f"повтор ключа — другой ответ: {p2} ≠ {p1}")
    la.ok("POST", "/v1/game/shop/purchases", 422, "IDEMPOTENCY_KEY_REUSED", json={"item_code": "streak_freeze"}, idem=key)
    la.ok("POST", "/v1/game/shop/purchases", 409, "ALREADY_OWNED", json={"item_code": code}, idem=True)
    shop_ops = [x for x in history(la, "til") if x["reason"] == "shop"]
    check(len(shop_ops) == 1 and shop_ops[0]["amount"] == -7, f"списание за покупку: {shop_ops}")
    s = la.ok("PUT", "/v1/game/equipment", json={"background_code": code, "frame_code": None})
    check(s["equipment"]["background"] and s["equipment"]["background"]["code"] == code, f"экипировка: {s['equipment']}")
    la.ok("PUT", "/v1/game/equipment", 409, "NOT_OWNED", json={"background_code": code, "frame_code": "frame_mint"})
    # нехватка тилов: «покупка тилов скоро», без оплаты
    bal = summary(la)["til_balance"]
    check(bal < 200, f"LA: тилов {bal} — проверка нехватки на frame_ink невозможна")
    e = la.ok("POST", "/v1/game/shop/purchases", 409, "INSUFFICIENT_TILS", json={"item_code": "frame_ink"}, idem=True)
    check(e["details"] == {"price": 200, "balance": bal, "missing": 200 - bal, "purchase_available": False},
          f"INSUFFICIENT_TILS: {e}")
    # снятие с продажи купленное не отбирает
    r = expect(ops.browser.post(f"/admin/v1/game/shop/items/{code}/retire", {"comment": "e2e: снять с продажи"}), 200)
    check(r["status"] == "retired" and r["owners"] == 1, f"снятие с продажи: {r}")
    check(code not in {x["code"] for x in la.ok("GET", "/v1/game/shop")["items"]}, "снятый предмет на витрине")
    check(summary(la)["equipment"]["background"]["code"] == code, "снятие с продажи отобрало экипировку")
    le.ok("POST", "/v1/game/shop/purchases", 410, "ITEM_NOT_AVAILABLE", json={"item_code": code}, idem=True)
    w = admin_wallet(c.staff["root"], la.learner_id)
    owned = [x for x in w["owned_items"] if x["code"] == code]
    check(owned and owned[0]["purchase_id"] == p1["purchase_id"] and owned[0]["kind"] == "background",
          f"владение в кошельке: {w['owned_items']}")
    ev = outbox("gamification", "game.purchase.completed.v1", c.data["started_at"], la.learner_id)
    check(ev and ev[0]["purchase_id"] == p1["purchase_id"] and ev[0]["price_til"] == 7, f"game.purchase.completed.v1: {ev}")
    check(summary(la)["purchase_available"] is False, "purchase_available")
    c.data["la_purchase"] = p1["purchase_id"]
    print(f"      предмет {code} (7 тилов): покупка, повтор ключа — тот же ответ, ALREADY_OWNED, экипировка; frame_ink → "
          f"INSUFFICIENT_TILS (purchase_available false); снятие с продажи не отобрало", flush=True)


# ---------------------------------------------------------------- AT-71 правила: черновик → проверка → активация → откат


def s_rules(c: s2.Ctx) -> None:
    le = c.lc.users["LE"]
    cm, ops, root = c.staff["cm"], c.staff["ops"], c.staff["root"]
    v0 = active_version(cm)["version"]
    check(v0 == c.data["rules0"]["version"], f"активная версия {v0} ≠ {c.data['rules0']['version']} (кто-то менял правила)")
    base = rules_payload(cm, v0)
    check(base["status"] == "active" and base["diff"] == [], f"активная версия: {str(base)[:300]}")
    payload0 = base["payload"]
    # начисление по прежней версии
    sid1 = reading_session(c, le)
    r = wait_reading_reward(le, sid1)
    op_ok(ops_of(r, "reading", "xp")[0], payload0["earn"]["reading"]["xp"], what="XP чтения v0")
    led1 = {x["op_id"]: x for x in admin_ledger(root, le.learner_id)}
    old = led1[ops_of(r, "reading", "xp")[0]["op_id"]]
    check(old["rules_version"] == v0 and old["reason"] == "reading", f"операция v0: {old}")
    items = expect(cm.browser.get("/admin/v1/game/rules"), 200)["items"]
    if any(x["status"] == "draft" for x in items):
        expect(cm.browser.request("DELETE", "/admin/v1/game/rules/draft", json_body={}), 204)
        note("на стенде был чужой черновик правил — удалён")
    bad = {**copy.deepcopy(payload0), "bogus": 1}
    e = expect(cm.browser.request("PUT", "/admin/v1/game/rules/draft",
                                  json_body={"payload": bad, "comment": None, "based_on": v0}), 422, "RULES_INVALID")
    check({"path": "bogus", "code": "unknown_key"} in e["details"]["errors"], f"RULES_INVALID: {e}")
    new = copy.deepcopy(payload0)
    new["earn"]["reading"] = {"xp": payload0["earn"]["reading"]["xp"] * 2, "til": payload0["earn"]["reading"]["til"] * 2}
    tag = f"[e2e {c.tag}]"
    d = expect(cm.browser.request("PUT", "/admin/v1/game/rules/draft",
                                  json_body={"payload": new, "comment": f"{tag} черновик: чтение ×2", "based_on": v0}), 200)
    vd = d["version"]
    diff = {x["path"]: (x["from"], x["to"]) for x in d["diff"]}
    check(d["status"] == "draft" and d["based_on"] == v0 and d["validated_at"] is None
          and diff == {"earn.reading.xp": (payload0["earn"]["reading"]["xp"], new["earn"]["reading"]["xp"]),
                       "earn.reading.til": (payload0["earn"]["reading"]["til"], new["earn"]["reading"]["til"])},
          f"черновик v{vd}: diff {d['diff']}")
    expect(cm.browser.request("PUT", "/admin/v1/game/rules/draft",
                              json_body={"payload": new, "comment": f"{tag} черновик", "based_on": v0}), 409, "DRAFT_CONFLICT")
    d = expect(cm.browser.request("PUT", "/admin/v1/game/rules/draft", headers={"if-match": d["updated_at"]},
                                  json_body={"payload": new, "comment": f"{tag} черновик: чтение ×2", "based_on": v0}), 200)
    s2.ensure_step_up(ops)
    expect(ops.browser.post("/admin/v1/game/rules/draft/activate", {"comment": f"{tag} активация до проверки"}), 409,
           "RULES_NOT_VALIDATED")
    val = expect(cm.browser.post("/admin/v1/game/rules/draft/validate", {}), 200)
    check(val["ok"] is True and val["errors"] == [], f"проверка черновика: {val}")
    denied = s3.rbac_denied(cm.browser, "POST", "/admin/v1/game/rules/draft/activate",
                            {"comment": f"{tag} активация content_manager"}, "game.publish")
    check(denied is None, denied)
    expect(ops.browser.post("/admin/v1/game/rules/draft/activate", {"comment": "коротко"}), 422)
    s2.ensure_step_up(ops)
    act = expect(ops.browser.post("/admin/v1/game/rules/draft/activate",
                                  {"comment": f"{tag} активация: чтение ×2"}), 200)
    check(act["status"] == "active" and act["version"] == vd and act["activated_by"]
          and act["activated_by"]["staff_id"] == ops.staff_id and act["payload"] == new, f"активация: {str(act)[:300]}")
    st = {x["version"]: x["status"] for x in expect(cm.browser.get("/admin/v1/game/rules"), 200)["items"]}
    check(st.get(v0) == "archived" and st.get(vd) == "active", f"версии: {st}")
    ev = wait_for(lambda: [x for x in outbox("gamification", "game.rules.activated.v1", c.data["started_at"])
                           if x["version"] == vd], 15, what="game.rules.activated.v1")
    check(ev[0]["based_on"] == v0 and ev[0]["activated_by"] == ops.staff_id, f"game.rules.activated.v1: {ev}")
    # активная версия неизменяема даже для владельца схемы
    res = psql_try(f"BEGIN; UPDATE gamification.rules_versions SET comment = 'x' WHERE version = {int(vd)}; ROLLBACK;",
                   user="gamification_owner")
    check(res.returncode != 0 and "permission denied" not in res.stderr,
          f"UPDATE активной версии правил не отклонён триггером: {(res.stdout + res.stderr)[:200]}")
    # новые начисления — по новой версии, старые операции не меняются
    sid2 = reading_session(c, le)
    r2 = wait_reading_reward(le, sid2)
    op_ok(ops_of(r2, "reading", "xp")[0], new["earn"]["reading"]["xp"], what="XP чтения по новой версии")
    if ops_of(r2, "reading", "til"):
        op_ok(ops_of(r2, "reading", "til")[0], new["earn"]["reading"]["til"], what="тилы чтения по новой версии")
    led2 = {x["op_id"]: x for x in admin_ledger(root, le.learner_id)}
    check(led2[ops_of(r2, "reading", "xp")[0]["op_id"]]["rules_version"] == vd, "rules_version новой операции")
    check(led2[old["op_id"]] == old, f"старая операция изменилась: {led2[old['op_id']]} ≠ {old}")
    quests_v = {x["rules_version"] for x in led2.values() if x["reason"] == "quest"}
    if quests_v:
        check(quests_v == {v0}, f"задания текущего дня доигрываются по своей версии: {quests_v}")
    # откат — новая версия с payload архивной
    s2.ensure_step_up(ops)
    rb = expect(ops.browser.post(f"/admin/v1/game/rules/{v0}/rollback", {"comment": f"{tag} откат правил"}), 200)
    vr = rb["version"]
    check(rb["status"] == "active" and vr > vd and rb["based_on"] == v0 and rb["payload"] == payload0, f"откат: {str(rb)[:300]}")
    expect(ops.browser.post(f"/admin/v1/game/rules/{vr}/rollback", {"comment": f"{tag} откат активной"}), 409, "RULES_STATE")
    st = {x["version"]: x["status"] for x in expect(cm.browser.get("/admin/v1/game/rules"), 200)["items"]}
    check(st.get(vd) == "archived" and st.get(vr) == "active" and st.get(v0) == "archived", f"версии после отката: {st}")
    led3 = {x["op_id"]: x for x in admin_ledger(root, le.learner_id)}
    check(all(led3[k] == v for k, v in led2.items()), "откат изменил проведённые операции")
    c.data.update(rules_v0=v0, rules_vd=vd, rules_vr=vr, rules_payload=payload0)
    print(f"      v{v0} → черновик v{vd} (чтение ×2) → проверка → активация (step-up) → чтение по v{vd} → откат v{vr}; "
          "проведённые операции не изменились", flush=True)


# ---------------------------------------------------------------- AT-71 событие недели ×2


def s_event(c: s2.Ctx) -> None:
    need(c, "rules_vr")
    le, p = c.lc.users["LE"], c.lc.users["P"]
    cm, ops = c.staff["cm"], c.staff["ops"]
    tag = c.tag.lower()
    now = datetime.now(UTC)
    start, end = now + timedelta(seconds=30), now + timedelta(hours=2)

    def body(code: str, s: datetime, e: datetime, factor: float = 2) -> dict[str, Any]:
        return {"code": code, "title": {"ru": f"Неделя чтения ×2 [e2e {c.tag}]", "uz": f"Oʻqish haftasi ×2 [e2e {c.tag}]"},
                "description": {"ru": "Двойной опыт за чтение", "uz": "Oʻqish uchun ikki baravar tajriba"},
                "starts_at": iso_z(s), "ends_at": iso_z(e), "audiences": ["adults"],
                "multipliers": [{"action": "reading", "currency": "xp", "factor": factor}]}

    k = str(uuid.uuid4())
    ev = expect(cm.browser.post("/admin/v1/game/events", body(f"e2e_read_{tag}", start, end), headers={"idempotency-key": k}), 201)
    check(ev["status"] == "draft" and ev["multipliers"] == [{"action": "reading", "currency": "xp", "factor": 2}],
          f"событие: {ev}")
    check(expect(cm.browser.post("/admin/v1/game/events", body(f"e2e_read_{tag}", start, end),
                                 headers={"idempotency-key": k}), 200)["event_id"] == ev["event_id"], "повтор ключа события")
    expect(cm.browser.post("/admin/v1/game/events", body(f"e2e_long_{tag}", start, start + timedelta(days=15)),
                           headers=idem()), 422, "EVENT_INVALID")
    past = expect(cm.browser.post("/admin/v1/game/events", body(f"e2e_past_{tag}", now - timedelta(hours=1), end),
                                  headers=idem()), 201)
    s2.ensure_step_up(ops)
    expect(ops.browser.post(f"/admin/v1/game/events/{past['event_id']}/publish", {"comment": "e2e: в прошлом"}), 422,
           "EVENT_STARTS_IN_PAST")
    expect(ops.browser.post(f"/admin/v1/game/events/{past['event_id']}/cancel", {"comment": "e2e: отмена"}), 200)
    pub = expect(ops.browser.post(f"/admin/v1/game/events/{ev['event_id']}/publish", {"comment": "e2e: публикация"}), 200)
    check(pub["status"] == "published" and pub["published_by"]["staff_id"] == ops.staff_id, f"публикация события: {pub}")
    dup = expect(cm.browser.post("/admin/v1/game/events", body(f"e2e_dup_{tag}", start, end, 3), headers=idem()), 201)
    e = expect(ops.browser.post(f"/admin/v1/game/events/{dup['event_id']}/publish", {"comment": "e2e: пересечение"}),
               409, "EVENT_OVERLAP")
    check(e["details"].get("event_id") == ev["event_id"], f"EVENT_OVERLAP: {e}")
    expect(ops.browser.post(f"/admin/v1/game/events/{dup['event_id']}/cancel", {"comment": "e2e: отмена"}), 200)
    c.data["event_id"] = ev["event_id"]
    s1.sleep_until(start + timedelta(seconds=1), "начало события недели")
    s = summary(le)
    mine = [x for x in s["events"] if x["event_id"] == ev["event_id"]]
    check(mine and mine[0]["multipliers"] == [{"action": "reading", "currency": "xp", "factor": 2}]
          and mine[0]["title"]["ru"].startswith("Неделя чтения"), f"активные события ученика: {s['events']}")
    p.switch(c.data["kid"])
    try:
        check(ev["event_id"] not in {x["event_id"] for x in summary(p)["events"]}, "событие взрослых видно ребёнку")
    finally:
        p.switch(p.account_id)
    base = c.data["rules_payload"]["earn"]["reading"]
    sid = reading_session(c, le)
    r = wait_reading_reward(le, sid)
    op_ok(ops_of(r, "reading", "xp")[0], base["xp"], 2, what="XP чтения в событие ×2")
    if ops_of(r, "reading", "til"):
        op_ok(ops_of(r, "reading", "til")[0], base["til"], 1, what="тилы чтения (без множителя)")
    hop = next(x for x in history(le, "xp") if x["op_id"] == ops_of(r, "reading", "xp")[0]["op_id"])
    expect(ops.browser.post(f"/admin/v1/game/events/{ev['event_id']}/cancel", {"comment": "e2e: событие завершено"}), 200)
    check(ev["event_id"] not in {x["event_id"] for x in summary(le)["events"]}, "отменённое событие видно ученику")
    after = next(x for x in history(le, "xp") if x["op_id"] == hop["op_id"])
    check(after == hop, "отмена события изменила начисление")
    print(f"      событие ×2 XP за чтение (взрослые): EVENT_STARTS_IN_PAST, EVENT_OVERLAP, ребёнку не видно; чтение → "
          f"{hop['amount']} XP (×{hop['multiplier']}); отмена не пересчитала", flush=True)


# ---------------------------------------------------------------- AT-72 кошелёк: ручная операция и обратная запись


def s_wallet(c: s2.Ctx) -> None:
    need(c, "la_lesson1")
    la = c.lc.users["LA"]
    ops, cm, sup, root = (c.staff[k] for k in ("ops", "cm", "sup", "root"))
    uid_la = la.learner_id
    s = summary(la)
    w = admin_wallet(sup, uid_la)
    check((w["xp_total"], w["til_balance"], w["freeze_stock"], w["level"]) == (s["xp_total"], s["til_balance"],
                                                                              s["freeze_stock"], s["level"])
          and w["audience"] == "adults" and w["confirmed_skills"] >= 1 and len(w["quests_today"]) == 3
          and any(b["code"] == "first_lesson" for b in w["badges"]) and set(w["settings"]) == {"auto_freeze", "quests_hidden"},
          f"кошелёк в админке ≠ сводка ученика: {json.dumps(w, ensure_ascii=False)[:500]}")
    led = admin_ledger(sup, uid_la)
    check(totals(led) == {"xp": w["xp_total"], "til": w["til_balance"], "freeze": w["freeze_stock"]},
          f"реестр ≠ кошелёк: {totals(led)}")
    check(all(x["actor"] in ("system", "learner") and x["comment"] is None for x in led), "операции до ручных — с actor staff")
    check(all(x["rules_version"] == c.data["rules0"]["version"] for x in led if x["reason"] in ACTIVITY),
          "rules_version операций активностей")
    admin_wallet(sup, str(uuid.uuid4()), 404, "WALLET_NOT_FOUND")
    path = f"/admin/v1/game/wallets/{uid_la}/adjustments"
    body = {"currency": "til", "amount": 15, "reason": f"e2e: компенсация за сбой урока {c.tag}"}
    for st, who in ((sup, "support"), (cm, "content_manager")):
        denied = s3.rbac_denied(st.browser, "POST", path, body, "wallet.adjust")
        check(denied is None, f"{who}: {denied}")
    nd = s4.step_up_needed(ops, "POST", path, body, "wallet.adjust")
    check(nd is None, nd)
    s2.ensure_step_up(ops)
    expect(ops.browser.post(path, {**body, "reason": "коротко"}, headers=idem()), 422)
    expect(ops.browser.post(path, {**body, "amount": 0}, headers=idem()), 422)
    key = {"idempotency-key": str(uuid.uuid4())}
    adj = expect(ops.browser.post(path, body, headers=key), 201)
    check(adj["reason"] == "manual" and adj["amount"] == 15 and adj["currency"] == "til"
          and adj["actor"] == f"staff:{ops.staff_id}" and adj["comment"] == body["reason"]
          and adj["source"]["kind"] == "staff" and adj["status"] == "confirmed", f"ручная операция: {adj}")
    check(expect(ops.browser.post(path, body, headers=key), 200)["op_id"] == adj["op_id"], "повтор ключа — новая операция")
    expect(ops.browser.post(path, {**body, "amount": 16}, headers=key), 422, "IDEMPOTENCY_KEY_REUSED")
    s1_ = summary(la)
    check(s1_["til_balance"] == s["til_balance"] + 15, f"тилы после начисления: {s1_['til_balance']}")
    lh = history(la, "til")
    mop = [x for x in lh if x["op_id"] == adj["op_id"]]
    check(mop and mop[0]["reason"] == "manual" and body["reason"] not in json.dumps(lh, ensure_ascii=False)
          and "comment" not in mop[0], f"ученик видит комментарий сотрудника: {mop}")
    e = expect(ops.browser.post(path, {"currency": "til", "amount": -(s1_["til_balance"] + 100),
                                       "reason": "e2e: списание больше баланса"}, headers=idem()), 409, "BALANCE_NEGATIVE")
    check(summary(la)["til_balance"] == s1_["til_balance"], f"баланс после отказа: {e}")
    rpath = f"/admin/v1/game/wallets/{uid_la}/ledger/{adj['op_id']}/reverse"
    rev = expect(ops.browser.post(rpath, {"reason": f"e2e: ошибочная компенсация {c.tag}"}), 200)
    check(rev["reason"] == "reversal" and rev["amount"] == -15 and rev["reversal_of"] == adj["op_id"]
          and rev["actor"] == f"staff:{ops.staff_id}", f"обратная запись: {rev}")
    expect(ops.browser.post(rpath, {"reason": "e2e: повторная отмена"}), 409, "ALREADY_REVERSED")
    expect(ops.browser.post(f"/admin/v1/game/wallets/{uid_la}/ledger/{rev['op_id']}/reverse",
                            {"reason": "e2e: отмена обратной записи"}), 409, "OPERATION_NOT_REVERSIBLE")
    led = {x["op_id"]: x for x in admin_ledger(root, uid_la)}
    check(led[adj["op_id"]]["status"] == "reversed" and led[adj["op_id"]]["reversed_by"] == rev["op_id"]
          and led[adj["op_id"]]["amount"] == 15, f"исходная операция: {led[adj['op_id']]}")
    shop_op = next((x for x in led.values() if x["reason"] == "shop" and x["currency"] == "til"), None)
    if shop_op:
        expect(ops.browser.post(f"/admin/v1/game/wallets/{uid_la}/ledger/{shop_op['op_id']}/reverse",
                                {"reason": "e2e: отмена покупки не возвратом"}), 409, "OPERATION_NOT_REVERSIBLE")
    check(summary(la)["til_balance"] == s["til_balance"], "баланс после обратной записи")
    # игра не меняет учёбу: XP и уровень ручной операцией — навыки и план те же
    sk0 = {k: v["state"] for k, v in skill_map(la).items()}
    tr0 = la.ok("GET", "/v1/plan/trajectory")
    pl0 = la.ok("GET", "/v1/plan")
    x0 = summary(la)
    want_lv = level_of(x0["xp_total"] + 600, c.data["levels"])
    ax = expect(ops.browser.post(path, {"currency": "xp", "amount": 600, "reason": "e2e: проверка уровня игры"},
                                 headers=idem()), 201)
    x1 = summary(la)
    check(x1["xp_total"] == x0["xp_total"] + 600 and x1["level"] == want_lv > x0["level"], f"уровень после +600 XP: {x1['level']}")
    lv_ev = [x for x in outbox("gamification", "game.level.reached.v1", c.data["started_at"], uid_la) if x["level"] == want_lv]
    check(lv_ev, "game.level.reached.v1 после ручного начисления XP")
    time.sleep(1.0)
    check({k: v["state"] for k, v in skill_map(la).items()} == sk0, "уровень игры изменил навыки")
    check(la.ok("GET", "/v1/plan/trajectory").get("next") == tr0.get("next")
          and la.ok("GET", "/v1/plan").get("level_self") == pl0.get("level_self"), "уровень игры изменил план")
    expect(ops.browser.post(f"/admin/v1/game/wallets/{uid_la}/ledger/{ax['op_id']}/reverse",
                            {"reason": "e2e: вернуть XP после проверки"}), 200)
    x2 = summary(la)
    check(x2["xp_total"] == x0["xp_total"] and x2["level"] == want_lv, f"обратная запись XP: XP {x2['xp_total']}, уровень "
                                                                         f"{x2['level']} (не понижается — {want_lv})")
    # возврат покупки: обратная запись, владение снято
    if c.data.get("la_purchase"):
        t0 = summary(la)["til_balance"]
        rf = expect(ops.browser.post(f"/admin/v1/game/wallets/{uid_la}/purchases/{c.data['la_purchase']}/refund",
                                     {"reason": "e2e: возврат покупки по обращению"}), 200)
        check(len(rf["operations"]) == 1 and rf["operations"][0]["amount"] == 7, f"возврат: {rf}")
        s3_ = summary(la)
        check(s3_["til_balance"] == t0 + 7 and s3_["equipment"]["background"] is None, f"после возврата: {s3_['equipment']}")
        check(c.data["shop_item"] not in {x["code"] for x in admin_wallet(root, uid_la)["owned_items"]}, "владение после возврата")
        expect(ops.browser.post(f"/admin/v1/game/wallets/{uid_la}/purchases/{c.data['la_purchase']}/refund",
                                {"reason": "e2e: повторный возврат"}), 409, "ALREADY_REVERSED")
    # заморозка за тилы до полного запаса: ops начисляет 40 тилов и заморозки до max − 1, покупка → max, ещё — 409
    s2.ensure_step_up(ops)
    f0 = summary(la)
    fmax = f0["freeze_max"]
    expect(ops.browser.post(path, {"currency": "til", "amount": f0["freeze_price_til"],
                                   "reason": "e2e: тилы на заморозку серии"}, headers=idem()), 201)
    if fmax - 1 - f0["freeze_stock"] > 0:
        expect(ops.browser.post(path, {"currency": "freeze", "amount": fmax - 1 - f0["freeze_stock"],
                                       "reason": "e2e: заморозки до почти полного запаса"}, headers=idem()), 201)
    t1 = summary(la)["til_balance"]
    pf = la.ok("POST", "/v1/game/shop/purchases", json={"item_code": "streak_freeze"}, idem=True)
    check(pf["freeze_stock"] == fmax and pf["til_balance"] == t1 - f0["freeze_price_til"]
          and pf["price_til"] == f0["freeze_price_til"], f"покупка заморозки за тилы: {pf}")
    fops = [x for x in history(la, "freeze") if x["reason"] == "shop"]
    check(len(fops) == 1 and fops[0]["amount"] == 1, f"операция заморозки из магазина: {fops}")
    sv = {x["code"]: x for x in la.ok("GET", "/v1/game/shop")["items"]}["streak_freeze"]
    check(sv["can_buy"] is False and sv["reason_unavailable"] == "freeze_full", f"витрина при полном запасе: {sv}")
    e = la.ok("POST", "/v1/game/shop/purchases", 409, "FREEZE_STOCK_FULL", json={"item_code": "streak_freeze"}, idem=True)
    check(e["details"].get("max") == fmax, f"FREEZE_STOCK_FULL: {e}")
    w2 = admin_wallet(root, uid_la)
    check(totals(admin_ledger(root, uid_la)) == {"xp": w2["xp_total"], "til": w2["til_balance"], "freeze": w2["freeze_stock"]},
          "реестр ≠ кошелёк после ручных операций")
    c.data["wallet_ops"] = {"adjusted": adj["op_id"], "reversed": rev["op_id"]}
    print(f"      ops: +15 тилов (повтор ключа, BALANCE_NEGATIVE) → обратная запись (ALREADY_REVERSED); +600 XP → уровень "
          f"{want_lv}, навыки и план те же → обратная запись (уровень не понижается); возврат покупки; заморозка за тилы до полного запаса → FREEZE_STOCK_FULL", flush=True)


# ---------------------------------------------------------------- AT-71 картинка ступени без релиза


def s_hero_image(c: s2.Ctx) -> None:
    need(c, "la_stage")
    la = c.lc.users["LA"]
    cm, ops = c.staff["cm"], c.staff["ops"]
    code, stage = c.data["la_hero"], c.data["la_stage"]
    old = summary(la)["hero"]["image"]
    heroes = {h["code"]: h for h in expect(cm.browser.get("/admin/v1/game/heroes"), 200)["items"]}
    live = heroes[code]
    check(live["learners"] >= 1 and live["draft"] is None and len(live["images"]) == 3, f"герой {code}: {str(live)[:300]}")
    fields = {k: live[k] for k in ("name", "tagline", "audiences", "stages")}
    img = png(96, 96, f"tilhero e2e {c.tag} {uuid.uuid4()}")
    sha = hashlib.sha256(img).hexdigest()
    up = upload(cm, img)
    check(up.status_code == 201, f"загрузка картинки: {up.status_code} {up.text[:300]}")
    a = up.json()
    check(a["sha256"] == sha and a["width"] == 96 and a["height"] == 96 and a["size"] == len(img), f"картинка: {a}")
    again = upload(cm, img)
    check(again.status_code == 200 and again.json()["asset_id"] == a["asset_id"], f"та же картинка: {again.status_code}")
    bad = upload(cm, b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
    check(bad.status_code == 422 and bad.json()["code"] == "ASSET_INVALID", f"битая картинка: {bad.status_code} {bad.text[:200]}")
    big = upload(cm, png(8, 8, "big") + b"\x00" * (301 * 1024))
    check(big.status_code == 413 and big.json()["code"] == "ASSET_TOO_LARGE", f"большая картинка: {big.status_code}")
    url = f"/v1/game/assets/{a['asset_id']}/{sha}"
    expect(public_asset(url), 404, "ASSET_NOT_FOUND")  # ещё не опубликована
    raw = cm.browser.get(f"/admin/v1/game/assets/{a['asset_id']}/content")
    check(raw.status_code == 200 and raw.content == img, f"просмотр черновой картинки в админке: {raw.status_code}")
    draft = copy.deepcopy(fields)
    for s_ in draft["stages"]:
        if s_["stage"] == stage:
            s_["asset_id"] = a["asset_id"]
    save_restore({code: fields})
    d = expect(cm.browser.request("PUT", f"/admin/v1/game/heroes/{code}/draft", json_body=draft), 200)
    check(d["draft"] and any(i["stage"] == stage and i["image"]["asset_id"] == a["asset_id"] for i in d["draft"]["images"]),
          f"черновик героя: {str(d.get('draft'))[:300]}")
    check(summary(la)["hero"]["image"] == old, "черновик изменил картинку у ученика")
    denied = s3.rbac_denied(cm.browser, "POST", f"/admin/v1/game/heroes/{code}/publish", {"comment": "e2e: картинка"},
                            "game.publish")
    check(denied is None, denied)
    s2.ensure_step_up(ops)
    pub = expect(ops.browser.post(f"/admin/v1/game/heroes/{code}/publish", {"comment": "e2e: новая картинка ступени"}), 200)
    check(pub["version"] == live["version"] + 1 and pub["draft"] is None, f"публикация героя: v{pub['version']}")
    try:
        h = summary(la)["hero"]
        check(h["image"] == {"asset_id": a["asset_id"], "url": url, "width": 96, "height": 96} and h["image"]["url"] != old["url"],
              f"картинка ступени у ученика: {h['image']} (было {old})")
        r = public_asset(url)
        check(r.status_code == 200 and r.content == img and r.headers["content-type"].startswith("image/png")
              and r.headers.get("etag", "").strip('"') == sha and "immutable" in r.headers.get("cache-control", ""),
              f"картинка без авторизации: {r.status_code} {dict(r.headers)}")
        check(public_asset(url, {"if-none-match": f'"{sha}"'}).status_code == 304, "If-None-Match → 304")
        expect(public_asset(f"/v1/game/assets/{a['asset_id']}/{'a' * 64}"), 404, "ASSET_NOT_FOUND")
        if public_asset(old["url"]).status_code != 404:
            note("прежняя картинка ступени после замены по-прежнему отдаётся (используется в другом опубликованном)")
    finally:
        # вернуть исходную картинку ступени (без релиза — та же публикация)
        s2.ensure_step_up(ops)
        expect(cm.browser.request("PUT", f"/admin/v1/game/heroes/{code}/draft", json_body=fields), 200)
        expect(ops.browser.post(f"/admin/v1/game/heroes/{code}/publish", {"comment": "e2e: вернуть картинку"}), 200)
        RESTORE_FILE.unlink(missing_ok=True)
    check(summary(la)["hero"]["image"] == old, "картинка ступени не вернулась")
    c.data["hero_published"] = code
    print(f"      {code}, ступень {stage}: PNG 96×96 → черновик → публикация (step-up) → у ученика новый url; без авторизации "
          "200/304/404; исходная картинка возвращена", flush=True)


# ---------------------------------------------------------------- дети 6–13


def s_kid(c: s2.Ctx) -> None:
    p = c.lc.users["P"]
    kid = c.data["kid"]
    seq = s1.tg_last_seq()
    p.switch(kid)
    try:
        s = summary(p)
        tpl = {t["code"]: t for t in c.data["rules0"]["payload"]["quests"]["templates"]}
        check(s["settings"]["celebrations"] == "quiet" and s["purchase_available"] is False and s["freeze_stock"] == 2,
              f"сводка ребёнка: {s['settings']} {s['purchase_available']} {s['freeze_stock']}")
        check(s["quests"]["items"] and all("kids" in tpl[q["code"]]["audiences"] for q in s["quests"]["items"]),
              f"задания ребёнка — не детские: {[q['code'] for q in s['quests']['items']]}")
        hs = p.ok("GET", "/v1/game/heroes")
        lines = [h["line"] for h in hs["items"]]
        check(len(lines) == 9 and lines[:3] == ["pet"] * 3, f"детям первыми — дракончики: {[h['code'] for h in hs['items']]}")
        check([h["code"] for h in hs["items"]] != c.data.get("adult_order"), "порядок героев ребёнка = взрослого")
        hero = p.ok("PUT", "/v1/game/hero", json={"hero_code": hs["items"][0]["code"]})["hero"]
        check(hero["code"].startswith("pet_") and hero["stage"] == 1, f"дракончик ребёнка: {hero}")
        e = p.ok("POST", "/v1/game/shop/purchases", 409, "INSUFFICIENT_TILS", json={"item_code": "streak_freeze"}, idem=True)
        check(e["details"]["purchase_available"] is False and e["details"]["price"] == 40, f"ребёнок: {e}")
        check(all(x["reason"] != "purchase" for x in history(p)), "у ребёнка операция purchase")
        # «Напоминания» у ребёнка по умолчанию выключены: игровая запись остаётся в центре детского профиля, без Telegram
        les = s5.pass_lesson(c, p, OPEN_OK)
        r = wait_rewards(p, les["sid"], lambda x: x["status"] == "ready" and any(b["code"] == "first_lesson" for b in x["badges"]),
                         "награды детского урока")
        check(ops_of(r, "lesson", "xp"), f"ребёнку не начислен XP: {r['operations']}")
        items = wait_for(lambda: [x for x in p.inbox() if "Новый значок" in x["body"]], 30, interval=1.0,
                         what="значок ребёнка в центре детского профиля")
        check(items and items[0]["telegram"] == "in_app_only", f"значок ребёнка в центре: {items}")
    finally:
        p.switch(p.account_id)
    time.sleep(2.0)
    sent = [m for m in s1.tg_sent(p.tg_id, seq) if "значок" in m["payload"].get("text", "").lower()]
    check(not sent, f"push о значке ребёнка ушёл в Telegram: {[m['payload']['text'][:80] for m in sent]}")
    print("      ребёнок: празднования quiet, дракончики первыми, детские задания, покупка за тилы — INSUFFICIENT_TILS "
          "(purchase_available false), урок → значок в центре, без push", flush=True)


# ---------------------------------------------------------------- AT-72 сага удаления


def game_rows(user_id: str) -> dict[str, int]:
    u = uid(user_id)
    out = {t: int(s1._psql(f"SELECT count(*) FROM gamification.{t} WHERE user_id = '{u}'")) for t in GAME_TABLES}
    out["referrals"] = int(s1._psql(f"SELECT count(*) FROM gamification.referrals WHERE inviter_user_id = '{u}' "
                                    f"OR invitee_user_id = '{u}'"))
    return out


def s_deletion(c: s2.Ctx) -> None:
    lx = c.lc.users["LX"]
    root = c.staff["root"]
    sid = reading_session(c, lx)
    wait_reading_reward(lx, sid)
    summary(lx)
    before = game_rows(lx.learner_id)
    check(all(before[t] > 0 for t in ("ledger", "wallets", "learners", "quests", "session_rewards")),
          f"данные LX в gamification до удаления: {before}")
    st0 = pj("SELECT json_build_object('n', count(*), 's', coalesce(sum(value), 0)) FROM gamification.daily_stats")
    d = lx.ok("POST", "/v1/profile/delete-request", 202, json={"confirm_word": "УДАЛИТЬ"})
    check("gamification" in d["domains"], f"домены саги: {d['domains']}")

    def done() -> Any:
        row = s1._psql("SELECT status || '|' || array_to_string(acked_domains, ',') FROM "
                       f"identity_consent.deletion_requests WHERE user_id = '{uid(lx.account_id)}'")
        return row if row.startswith("COMPLETED|") else None

    row = wait_for(done, 90, interval=1.0, what="сага удаления LX (ACK gamification)")
    check("gamification" in row.split("|")[1].split(","), f"ACK: {row}")
    left = {k: v for k, v in game_rows(lx.learner_id).items() if v}
    check(not left, f"данные LX в gamification после удаления: {left}")
    st1 = pj("SELECT json_build_object('n', count(*), 's', coalesce(sum(value), 0)) FROM gamification.daily_stats")
    check(st1["n"] >= st0["n"] and st1["s"] >= st0["s"], f"обезличенная статистика уменьшилась: {st0} → {st1}")
    ack = pj("SELECT count(*) FROM gamification.outbox WHERE envelope->>'event_type' = 'user.domain.deleted.v1' "
             f"AND envelope->'payload'->>'user_id' = '{uid(lx.learner_id)}' AND envelope->'payload'->>'domain' = 'gamification'")
    check(ack == 1, f"ACK user.domain.deleted.v1 {{domain: gamification}}: {ack}")
    admin_wallet(root, lx.learner_id, 404, "WALLET_NOT_FOUND")
    c.data["deleted"] = lx.learner_id
    print(f"      LX: до удаления {before}; после — пусто, daily_stats {st0} → {st1}", flush=True)


# ---------------------------------------------------------------- tick, обзор


def s_tick_overview(c: s2.Ctx) -> None:
    root, sup, cm = c.staff["root"], c.staff["sup"], c.staff["cm"]
    deferred: list[str] = []
    expect(httpx.post(f"{GAME}/internal/v1/game:tick", timeout=10), 401, "SCHEDULER_TOKEN_INVALID")
    expect(httpx.post(f"{GAME}/internal/v1/game:tick", headers={"authorization": "Bearer wrong-token-0123456789abcdef0123"},
                      timeout=10), 401, "SCHEDULER_TOKEN_INVALID")
    r = httpx.post(f"{GAME}/internal/v1/game:tick", headers={"authorization": f"Bearer {s1.SCHEDULER_TOKEN}"}, timeout=60)
    res: dict[str, Any] = {}
    if r.status_code != 200:
        bad = s1._psql("SELECT coalesce(string_agg(l.timezone || ':' || n, ','), '') FROM (SELECT l.timezone, count(*) n "
                       "FROM gamification.learners l WHERE l.timezone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "
                       "pg_timezone_names z WHERE z.name = l.timezone) GROUP BY 1) l")
        deferred.append(f"ДЕФЕКТ gamification (domain/tick.py _EXPIRE_SQL, AT TIME ZONE learners.timezone): game:tick → "
                        f"{r.status_code} {r.json().get('code') if r.content else ''}; пояса учеников, известные Python "
                        f"zoneinfo, но неизвестные PostgreSQL: {bad}")
    else:
        res = r.json() if not r.json().get("skipped") else game_tick()
        # спринт 7: referrals_void → legacy_referrals_expired (доживающие pending спринта 6), + лиги, дуэли и
        # начальная загрузка проекций
        check({"quests_expired", "events_finished", "legacy_referrals_expired", "reconciled", "wallets_fixed",
               "league_groups_closed", "league_members_assigned", "duels_finished", "projections_loaded"} <= set(res),
              f"tick: {res}")
        if res["reconciled"] and res["wallets_fixed"]:
            note(f"game:tick: сверка исправила кошельков {res['wallets_fixed']} (WALLET_DRIFT)")
    ov = expect(sup.browser.get("/admin/v1/game/overview", params={"period": "7d"}), 200)
    act = active_version(root)["version"]
    check(ov["period"] == "7d" and ov["active_rules_version"] == act and ov["earned"]["xp"] > 0 and ov["earned"]["til"] > 0
          and ov["badges_earned"] >= 1 and ov["quests_completed"] >= 1 and ov["freezes"]["granted"] >= 2
          and ov["spent_til"] >= 0 and any(x["audience"] == "adults" for x in ov["by_audience"]),
          f"обзор: {json.dumps(ov, ensure_ascii=False)[:500]}")
    if c.data.get("la_purchase"):
        check(ov["purchases"] >= 1, f"обзор: покупок {ov['purchases']}")
    if c.data.get("freeze_done") and ov["freezes"]["used"] < 1:
        tz = c.data.get("freeze_zone", "")
        rows = pj("SELECT coalesce(json_agg(json_build_object('d', local_date, 'a', audience, 'v', value)), '[]') FROM "
                  "gamification.daily_stats WHERE metric = 'freezes_used' AND local_date > (now() AT TIME ZONE "
                  "'Asia/Tashkent')::date")
        deferred.append(f"ДЕФЕКТ gamification (engine.py post → bump по местной дате ученика; stats.py overview — окно по "
                        f"дате STATS_TIMEZONE): заморозка ученика в поясе {tz} записана в daily_stats «завтрашним» днём "
                        f"{rows} и не видна в обзоре 7d (freezes.used = {ov['freezes']['used']})")
    blob = json.dumps(ov)
    check("user_id" not in blob and all(u.learner_id not in blob for u in c.lc.users.values()), "обзор с идентификаторами")
    expect(cm.browser.get("/admin/v1/game/overview", params={"period": "30d"}), 200)
    dash = expect(root.browser.get("/admin/v1/dashboard", params={"period": "today"}), 200)
    g = dash.get("game") or {}
    check(g.get("available") is True and g.get("data") and g["data"]["earned_xp"] > 0, f"блок обзора game: {str(g)[:300]}")
    print(f"      game:tick {res or r.status_code}; обзор 7d: XP {ov['earned']['xp']}, тилов {ov['earned']['til']}, заморозок "
          f"{ov['freezes']}, покупок {ov['purchases']}", flush=True)
    if deferred:
        raise StepFailed("; ".join(deferred))


# ---------------------------------------------------------------- безопасность и неизменяемость


def s_security(c: s2.Ctx) -> None:
    need(c, "la_lesson1")
    la, lb = c.lc.users["LA"], c.lc.users["LB"]
    r = rewards(lb, c.data["la_lesson1"])
    check(r["status"] == "none" and r["operations"] == [] and r["badges"] == [], f"чужая сессия: {r}")
    rnd = rewards(la, str(uuid.uuid4()))
    if rnd["status"] != "none":
        note(f"награды неизвестной сессии — status {rnd['status']} (не none): домен не знает возраст сессии, Mini App "
             "опрашивает до 8 раз (INTERNAL_API §1.8 «прошло 2 мин → none»)")
    bad_sid = la.req("GET", "/v1/game/rewards", params={"source_session_id": "not-a-uuid"})
    check(bad_sid.status_code in (400, 422), f"награды с неверным id: {bad_sid.status_code}")
    bad = la.req("GET", "/v1/game/history", params={"currency": "gold"})
    check(bad.status_code in (400, 422), f"история с неизвестной валютой: {bad.status_code}")
    u = uid(la.learner_id)
    for sql, what in ((f"UPDATE gamification.ledger SET amount = amount + 1 WHERE user_id = '{u}'", "UPDATE ledger"),
                      (f"DELETE FROM gamification.ledger WHERE user_id = '{u}'", "DELETE ledger"),
                      (f"UPDATE gamification.badges SET value = 99 WHERE user_id = '{u}'", "UPDATE badges")):
        res = psql_try(f"BEGIN; {sql}; ROLLBACK;", user="gamification_owner")
        check(res.returncode != 0 and "permission denied" not in res.stderr,
              f"{what} под gamification_owner не отклонён триггером: rc={res.returncode} {(res.stdout + res.stderr)[:200]}")
    res = psql_try(f"BEGIN; UPDATE gamification.ledger SET amount = amount + 1 WHERE user_id = '{u}'; ROLLBACK;",
                   user="gamification")
    check(res.returncode != 0, "UPDATE ledger под рантайм-ролью прошёл")
    # клиент не задаёт сумм: лишние поля в покупке и настройках не принимаются
    x = la.req("POST", "/v1/game/shop/purchases", json={"item_code": "streak_freeze", "price_til": 1}, idem=True)
    check(x.status_code in (400, 422), f"покупка с ценой от клиента: {x.status_code} {x.text[:200]}")
    check(c.lc.users["LB"].learner_id not in json.dumps(summary(la)), "чужой ученик в сводке")
    print("      чужая сессия → none; ledger/badges неизменяемы (триггер); цена от клиента — 4xx", flush=True)


# ---------------------------------------------------------------- аудит, события, логи


def s_audit(c: s2.Ctx) -> None:
    b = c.staff["root"].browser
    ops, cm = c.staff["ops"].staff_id, c.staff["cm"].staff_id
    d = c.data
    want: list[tuple[str, str]] = []
    if d.get("rules_vd"):
        want += [("game.rules.draft_created", cm), ("game.rules.validated", cm), ("game.rules.activated", ops),
                 ("game.rules.rolled_back", ops)]
    if d.get("shop_item"):
        want += [("game.shop_item.created", cm), ("game.shop_item.published", ops), ("game.shop_item.retired", ops)]
    if d.get("event_id"):
        want += [("game.event.created", cm), ("game.event.published", ops), ("game.event.cancelled", ops)]
    if d.get("wallet_ops"):
        want += [("game.wallet.adjusted", ops), ("game.wallet.reversed", ops)]
        if d.get("la_purchase"):
            want += [("game.purchase.refunded", ops)]
    if d.get("hero_published"):
        want += [("game.asset.uploaded", cm), ("game.hero.draft_saved", cm), ("game.hero.published", ops)]
    check(want, "нет команд сотрудников для проверки аудита (шаги упали)")
    recs: list[dict[str, Any]] = []

    def missing() -> list[str]:
        nonlocal recs
        recs = s2.all_records(b, d["started_at"])
        return [f"{a} ({who[:8]})" for a, who in want if not any(r["action"] == a and r.get("actor_id") == who for r in recs)]

    deadline = time.monotonic() + 40
    left = missing()
    while left and time.monotonic() < deadline:
        time.sleep(2)
        left = missing()
    check(not left, f"нет записей аудита: {left}")
    game = [r for r in recs if r["action"].startswith("game.")]
    check(all(r.get("reason") for r in game if r["action"] in ("game.wallet.adjusted", "game.wallet.reversed",
                                                                "game.rules.activated", "game.rules.rolled_back")),
          "аудит без причины/комментария")
    blob = json.dumps(game, ensure_ascii=False)
    leaks = [w for w, v in c.secrets.items() if v and v in blob]
    leaks += [f"Telegram ID {u.role}" for u in c.lc.users.values() if re.search(rf"(?<!\d){u.tg_id}(?!\d)", blob)]
    leaks += [f"имя {u.role}" for u in c.lc.users.values() if u.first in blob]
    check(not leaks, f"секреты/PII в аудите: {leaks}")
    v = expect(b.get("/admin/v1/audit/verify"), 200)
    check(v["valid"] is True and v["broken_at_seq"] is None, f"цепочка аудита: {v}")
    print(f"      записей game.*: {len(game)} ({sorted(Counter(r['action'] for r in game))[:6]}…)", flush=True)


SCHEMAS = ["gamification", "learning_plan", "lessons", "memory", "social", "identity_consent", "notifications",
           "diagnostics", "assessment"]


def s_events(c: s2.Ctx) -> None:
    import jsonschema

    since = c.data["started_at"]
    env_schema = json.loads((s1.CONTRACTS / "envelope.schema.json").read_text())
    seen: Counter[str] = Counter()
    problems: list[str] = []
    for schema in SCHEMAS:
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
                jsonschema.validate(env["payload"], json.loads(path.read_text()), format_checker=jsonschema.FormatChecker())
            except jsonschema.ValidationError as exc:
                problems.append(f"{schema}: {et}: {exc.message[:160]}")
    expected = {"gamification:game.badge.earned.v1", "learning_plan:learning.activity.recorded.v1"}
    flags = {"la_stage": "gamification:game.hero.stage_reached.v1", "freeze_done": "gamification:game.streak.frozen.v1",
             "la_purchase": "gamification:game.purchase.completed.v1", "rules_vd": "gamification:game.rules.activated.v1",
             "wallet_ops": "gamification:game.level.reached.v1", "deleted": "gamification:user.domain.deleted.v1"}
    expected |= {v for k, v in flags.items() if c.data.get(k)}
    if c.data.get("freeze_done"):
        expected.add("learning_plan:learning.session.missed.v1")
    if c.data.get("rules_vd"):
        expected.add("gamification:admin.audit.recorded.v1")
    check(not (expected - set(seen)), f"не опубликованы события: {sorted(expected - set(seen))}")
    check(not problems, "; ".join(problems[:8]))
    streak = pj("SELECT count(*) FROM learning_plan.outbox WHERE envelope->>'event_type' = 'learning.activity.recorded.v1' "
                f"AND envelope->'payload' ? 'streak_days' AND created_at >= to_timestamp({int(since)})")
    check(streak and streak >= 1, "learning.activity.recorded.v1 без streak_days")
    marker = c.data.get("marker", "")
    leak = [s for s in SCHEMAS if s1._psql(f"SELECT to_regclass('{s}.outbox') IS NOT NULL") == "t" and marker and marker in
            s1._psql(f"SELECT coalesce(string_agg(envelope::text, E'\\n'), '') FROM {s}.outbox WHERE created_at >= "
                     f"to_timestamp({int(since)})")]
    check(not leak, f"тексты учеников в событиях: {leak}")

    def idle() -> bool:
        return all(v["pending"] == 0 and v["ack_pending"] == 0 for v in consumers("").values())

    wait_for(idle, 30, interval=1.0, what="потребители NATS без хвоста")
    after, before = s1.dlq_counts(), c.data.get("dlq_before", {})
    grown = {k: v - before.get(k, 0) for k, v in after.items() if v > before.get(k, 0)}
    check(not grown, f"новые сообщения в DLQ: {grown}")
    print(f"      событий с начала прогона: {sum(seen.values())}; gamification: "
          f"{ {k.split(':')[1]: v for k, v in seen.items() if k.startswith('gamification:')} }", flush=True)


def s_logs(c: s2.Ctx) -> None:
    needles: dict[str, str] = {"маркер текстов ученика": c.data.get("marker", ""), "SCHEDULER_TOKEN": s1.SCHEDULER_TOKEN}
    needles.update(dict(c.secrets.items()))
    found = []
    for log in sorted(s1.LOG_DIR.glob("*.log")):
        if log.name.startswith(("mock-telegram", "miniapp", "bootstrap")) or ".migrate" in log.name or ".build" in log.name:
            continue
        text = log.read_text(errors="replace")
        found += [f"{log.name}: {what}" for what, needle in needles.items() if needle and needle in text]
        if s4.KEY_RE.search(text):
            found.append(f"{log.name}: строка вида ключа провайдера")
    check(not found, f"тексты учеников/секреты в логах: {found[:8]}")
    since = datetime.fromtimestamp(c.data["started_at"], UTC).isoformat(timespec="milliseconds")[:23]
    bad = [line[:200] for line in (s1.LOG_DIR / "gamification.log").read_text(errors="replace").splitlines()
           if '"level": "error"' in line and line[8:31] >= since]
    if bad:
        note(f"gamification.log: ошибок {len(bad)}, первая: {bad[0]}")


# ---------------------------------------------------------------- шаги


STEPS: list[tuple[str, Callable[[s2.Ctx], None], bool]] = [
    ("G00 стенд спринта 6: gamification, маршруты BFF (401), картинка без авторизации (404), сид героев и правил; "
     "уборка; хвост NATS", s_stand, True),
    ("G01 super_admin (bootstrap), права game.* и wallet.adjust в матрице ролей; content_manager, operations, support",
     s_staff, True),
    ("G02 первый вход сотрудников (TOTP у привилегированных)", s_staff_login, True),
    ("G03 AT-67 ученики и ребёнок 6–9: бонус регистрации 2 заморозки каждому профилю; сводка, задания дня (3, "
     "детерминированы)", s_learners, True),
    ("G04 AT-63/64/68/70 урок → XP и тилы по правилам, навыки, уровень, задания дня, значок first_lesson, "
     "/v1/game/rewards по сессии, уведомление", s_first_lesson, False),
    ("G05 AT-63 повтор события урока (адресный повтор в NATS) — без второй операции", s_replay, False),
    ("G06 AT-63 повторение и чтение → начисления; баланс = сумма операций; дневной лимит", s_review_reading, False),
    ("G07 AT-65 герои: 9, выбор и смена (XP сохраняется), 404; 5 навыков подтверждены уроками → ступень 2, картинка "
     "меняется, событие и уведомление", s_heroes, False),
    ("G08 AT-66 пропуск дня графика (plan:tick) с заморозкой → game.streak.frozen.v1, серия цела, неделя frozen, "
     "«Серия спасена»; без автозаморозки — серия рвётся мягко; повтор — без второго списания", s_freeze, False),
    ("G09 AT-67 реферал (спринт 7): принят → первый урок приглашённого — без бонуса (правило «первого урока» "
     "отключено), реферал в social «в процессе»; повтор — без бонуса; категория game выключена — значок только в "
     "центре", s_referral, False),
    ("G10 AT-69 магазин: предмет (черновик → публикация, step-up), покупка, повтор ключа, ALREADY_OWNED, экипировка, "
     "INSUFFICIENT_TILS (purchase_available false), снятие с продажи не отбирает", s_shop, False),
    ("G11 AT-71 правила: черновик (RULES_INVALID, DRAFT_CONFLICT) → проверка → активация (step-up, RULES_NOT_VALIDATED, "
     "403) → начисления по новой версии, старые неизменны → откат", s_rules, False),
    ("G12 AT-71 событие недели ×2 XP за чтение: EVENT_STARTS_IN_PAST, EVENT_OVERLAP, аудитория, множитель в операции; "
     "отмена", s_event, False),
    ("G13 AT-72 кошелёк: баланс и реестр, ручная операция (step-up, причина, 403, BALANCE_NEGATIVE) и обратная запись; "
     "уровень игры не меняет учёбу; возврат покупки; заморозка за тилы до полного запаса (FREEZE_STOCK_FULL)", s_wallet,
     False),
    ("G14 AT-71 замена картинки ступени героя без релиза: загрузка (413/422), черновик → публикация (step-up) → новый "
     "url у ученика; картинка без авторизации (ETag, 304, 404)", s_hero_image, False),
    ("G15 дети 6–9: дракончики первыми, тихие празднования, детские задания, без покупок за деньги, значок без push",
     s_kid, False),
    ("G16 AT-72 сага удаления: кошелёк, реестр, задания, значки удалены; обезличенная статистика осталась", s_deletion,
     False),
    ("G17 game:tick (SCHEDULER_TOKEN), обзор игры в админке и блок главной", s_tick_overview, False),
    ("G18 безопасность: чужая сессия → none, реестр и значки неизменяемы, клиент не задаёт сумм", s_security, False),
    ("G19 аудит game.* (actor, причина, без PII); цепочка цела", s_audit, False),
    ("G20 события спринта 6 по контрактам, outbox опубликован, streak_days, DLQ", s_events, False),
    ("G21 логи сервисов без текстов учеников и секретов", s_logs, False),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--admin-bff", default=os.environ.get("E2E_ADMIN_BFF", "http://127.0.0.1:8002"))
    ap.add_argument("--bff", default=TG_BFF)
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--cleanup", action="store_true", help="только уборка остатков прерванного прогона")
    ap.add_argument("--only", default="", help="через запятую: G08,G12 — подготовка G00–G03 и только эти шаги")
    args = ap.parse_args()
    if args.cleanup:
        done = cleanup_leftovers()
        print("уборка стенда (игра): " + ("; ".join(done) if done else "остатков прерванных прогонов нет"), flush=True)
        return 0
    only = {x.strip().upper() for x in args.only.split(",") if x.strip()}
    tag = "G" + "".join(secrets.choice(string.ascii_uppercase) for _ in range(4))
    base_tg = 8_995_000_000 + secrets.randbelow(4_000_000) * 8
    results: list[tuple[str, str, str]] = []
    with httpx.Client(base_url=args.bff, timeout=45) as tg:
        lc = s1.Ctx(bff=tg, tag=tag, base_tg=base_tg)
        lc.data["zone_day"] = s1.pick_zone(datetime.now(UTC), 10 * 60, 16 * 60, 13 * 60)
        c = s2.Ctx(bff=args.admin_bff, lc=lc, tag=tag)
        c.data["started_at"] = int(time.time()) - 1
        print(f"TilHero e2e (спринт 6, игра и герои): admin-bff {args.admin_bff}, telegram-bff {args.bff}, метка {tag}, "
              f"Telegram ID от {base_tg + 1}, зона учеников {lc.data['zone_day']}\n", flush=True)
        blocked: str | None = None
        try:
            for name, fn, critical in STEPS:
                if only and not critical and name.split()[0] not in only:
                    continue
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
                for line in cleanup_leftovers():
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
    (s1.E2E_DIR / "last-run-game.json").write_text(json.dumps(
        {"tag": tag, "checks": s1.CHECKS[0], "notes": NOTES,
         "results": [{"step": n, "status": s, "detail": d} for n, s, d in results]}, ensure_ascii=False, indent=1))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

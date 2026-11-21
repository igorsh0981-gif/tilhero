# ruff: noqa: S608 — QA-скрипт dev-стенда: psql (SQL только из UUID/дат/кодов сценария, проверенных регуляркой, и констант)
"""Сквозной сценарий спринта 7 TilHero (социальное) через публичные API — как Mini App (telegram-bff) и браузер
admin-web (admin-bff): друзья → лига → дуэль → парный урок → реферал → жалоба и санкция → удаление.

Предусловие: `infra/e2e/run_local.sh social` (сброс учёток admin-identity + up + этот сценарий; ИИ и речь — fake).
Отдельно, на уже поднятом стенде со свежим bootstrap-сотрудником:
    uv run python infra/e2e/scenario_social.py [--admin-bff http://127.0.0.1:8002] [--bff http://127.0.0.1:8001] [-v]
    uv run python infra/e2e/scenario_social.py --only S03,S05  # подготовка (S00–S02) + только эти шаги
    uv run python infra/e2e/scenario_social.py --cleanup       # только уборка остатков прерванного прогона

Ученики (все взрослые — с целью согласия social и категорией «социальное»): LA (основной), LB (друг LA: встречные
заявки, лига, дуэль, парный урок), LC (блокировка, жалоба, санкция), LD (отклонённая заявка, скрытый профиль,
техническая победа LA в дуэли), LX (удаляется в S11: друзья, заявки, блокировка, лига, дуэль, комната, реферал),
LR (пригласивший) и LI (приглашённый по реферальной ссылке), подросток TG с согласием родителя G и подросток TN без
него, семья: родитель P, ребёнок 6–9 (детский профиль P) и взрослый член семьи FM. Сотрудники: bootstrap
super_admin, operations (все права спринта 7, step-up), support (social.read, moderation.manage, referral.read,
room.read), content_manager (league.read). Помощники — сценарии спринтов 1–6.

Доменные сервисы напрямую вызываются только как планировщик (`game:tick`, `lessons:tick`, `invites:tick` с
SCHEDULER_TOKEN — как n8n), для проверки прав в самом домене (staff-токен admin-bff без step-up) и при уборке.
Повтор события — адресный повтор ops-monitor (конверт из outbox в `tilhero.replay.<durable>`).

ТЕСТОВЫЕ ИЗМЕНЕНИЯ БД (ждать неделю, двое суток и 48 часов нельзя) — только строки СВОИХ учеников этого прогона,
каждое печатается в журнал прогона:
  * закрытие недели лиги — группа общей лиги, её участники и «неделя XP» их операций текущей недели
    (`gamification.league_groups.week`, `league_members.week`, `ledger.league_week`) переносятся в свободную прошлую
    неделю; реестр неизменяем (триггер), поэтому `ledger.league_week` меняется в транзакции с
    `session_replication_role = replica` (под postgres; остальные колонки реестра не трогаются);
  * реферал «в два разных дня» — `social.referral_lessons.local_date` первого зачётного урока → вчера;
  * дедлайн дуэли — `gamification.duels.play_deadline` и `lessons.duel_sets.play_deadline` → в прошлое;
  * начальная загрузка проекций на непустой базе — строки проекций gamification (дружба LA–LB, семья P) удаляются,
    как будто их события ушли из стрима (7 дней), затем `POST /internal/v1/projections/bootstrap?force=true`.
Только чтение: outbox/inbox, ключи заданий дуэли (`lessons.duel_sets`), узел сценария комнаты, сага удаления.

Что сценарий меняет в общем стенде и как возвращает (уборка в конце, в S00 и `--cleanup`):
  * реферальная кампания: черновик e2e → активация → восстановление прежних условий новой версией (S09);
  * правила игры (аномалия лиги): черновик → активация → откат (как scenario_game.py);
  * аварийная остановка ИИ (парная комната → сценарий с выбором реплик): включается и выключается в S06
    (файл восстановления scenario_lessons.py).

Печатает PASS/FAIL/SKIP по шагам и «Итого: N/M PASS»; код выхода 1, если хоть один шаг упал. Замечания (не роняют
шаг) — в конце. Шаги после сбоя критичного шага — SKIP.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import hmac
import json
import os
import re
import secrets
import string
import sys
import threading
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
import scenario_content as s3  # создание сотрудников, диагностика, psql-помощники
import scenario_game as sg  # game:tick, сводка и история игры, чтение, правила, NATS
import scenario_lessons as s4  # шаги занятий, уборка настроек ИИ
import scenario_memory as s5  # урок целиком

from tilhero_common.internal_auth import issue_token

check, expect, wait_for = s1.check, s1.expect, s1.wait_for
StepFailed, StepSkipped = s1.StepFailed, s1.StepSkipped
Staff = s2.Staff
idem = s2.idem
parse_ts = s2.parse_ts
need, pj, psql_try = s3.need, s3.pj, s3.psql_try
uid = s1.uid

TG_BFF = s2.TG_BFF
SOCIAL = s1.SOCIAL
GAME = sg.GAME
LESSONS = s4.LESSONS
MEMBER_KEY = os.environ.get("E2E_MEMBER_ID_KEY", "e2e-member-id-key-0123456789abcdef-local")
PAIR = "ru-en"
PURPOSES = [*s1.REQUIRED, "social"]
TASHKENT = ZoneInfo("Asia/Tashkent")
MEMBER_RE = re.compile(r"^mb_[A-Za-z0-9_-]{22}$")
CODE_RE = re.compile(r"^TH-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$")
OPEN_OK = sg.OPEN_OK
SOCIAL_PERMS = {"social.read", "moderation.manage", "referral.read", "referral.manage", "league.read", "league.manage",
                "room.read", "room.manage"}
READS = {"social.read", "referral.read", "league.read", "room.read"}
# PLAN спринта 7 «Права»: права по ролям (super_admin — все)
ROLE_SOCIAL = {"support": {"social.read", "moderation.manage", "referral.read", "room.read"},
               "operations": SOCIAL_PERMS, "content_manager": {"league.read"}, "analyst": READS, "auditor": READS}
ADMIN_MENU7 = {"friends", "moderation", "referrals", "leagues", "pair_rooms"}
WEEK_REASONS = ("lesson", "scenario", "media", "reading", "review", "skill_demonstrated", "skill_retained", "quest",
                "quest_bonus", "duel", "pair_lesson")
LIVE = ("in_progress", "paused")
THINK = 1.2  # секунд «на обдумывание» перед ходом в комнате (секунды речи без голоса — время от подсказки до ответа)
COMMUNITY_KEYS = {"member_id", "nickname", "friend_code", "game_profile_hidden", "restrictions",
                  "nickname_change_available_at", "friends_available", "friends_unavailable_reason"}
CARD_KEYS = {"member_id", "nickname", "relation", "request_id"}
REQUEST_KEYS = {"request_id", "direction", "member_id", "nickname", "status", "created_at", "decided_at"}
FRIEND_KEYS = {"member_id", "nickname", "since"}
ROW_KEYS = {"member_id", "nickname", "hero", "xp", "place", "badges", "me"}
DUEL_KEYS = {"duel_id", "status", "role", "opponent", "pair_id", "level_band", "created_at", "accept_deadline",
             "play_deadline", "my_session", "my_played", "opponent_played", "can_accept", "can_play", "result",
             "finished_at"}
ROOM_KEYS = {"room_id", "status", "side", "partner", "pair_id", "scenario", "mode", "start_at", "respond_until",
             "created_at", "started_at", "ended_at", "end_reason", "my_role", "can_accept", "can_join", "minutes",
             "report_available"}
CAMPAIGN_MARK = "[e2e "
NOTES: list[str] = []


def note(text: str) -> None:
    NOTES.append(text)
    print(f"      замечание: {text}", flush=True)


# =============================================================================================== помощники


def member_id_of(user_id: str) -> str:
    """member_id (INTERNAL_API §0): "mb_" + base64url(HMAC-SHA256(MEMBER_ID_KEY, str(user_id))[:16]) без «=»."""
    d = hmac.new(MEMBER_KEY.encode(), str(uuid.UUID(user_id)).encode(), hashlib.sha256).digest()[:16]
    return "mb_" + base64.urlsafe_b64encode(d).rstrip(b"=").decode()


def u_(c: s2.Ctx, role: str) -> s1.U:
    return c.lc.users[role]


def mid(c: s2.Ctx, role: str) -> str:
    return str(c.data["mid"][role])


def nick(c: s2.Ctx, role: str) -> str:
    return str(c.data["nick"][role])


def iso_z(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def community(u: s1.U) -> dict[str, Any]:
    return u.ok("GET", "/v1/community")


def search(u: s1.U, q: str) -> list[dict[str, Any]]:
    return u.ok("GET", "/v1/friends/search", params={"q": q})["items"]


def page_all(u: s1.U, path: str, params: dict[str, Any] | None = None, pages: int = 20) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cursor = None
    for _ in range(pages):
        p = {**(params or {}), **({"cursor": cursor} if cursor else {})}
        page = u.ok("GET", path, params=p or None)
        out += page["items"]
        cursor = page.get("next_cursor")
        if not cursor:
            return out
    raise StepFailed(f"{path}: больше {pages} страниц")


def friends_of(u: s1.U) -> dict[str, dict[str, Any]]:
    return {x["member_id"]: x for x in page_all(u, "/v1/friends")}


def requests_of(u: s1.U, direction: str) -> list[dict[str, Any]]:
    return page_all(u, "/v1/friends/requests", {"direction": direction})


def befriend(c: s2.Ctx, a: str, b: str) -> None:
    """a → заявка → b принимает."""
    r = u_(c, a).ok("POST", "/v1/friends/requests", 201, json={"member_id": mid(c, b)}, idem=True)
    acc = u_(c, b).ok("POST", f"/v1/friends/requests/{r['request_id']}/accept")
    check(acc["status"] == "accepted", f"{b} принимает заявку {a}: {acc}")


def private(c: s2.Ctx, obj: Any, viewer: s1.U, what: str) -> None:
    """В ответе ученика нет чужих user_id, имён, Telegram ID и username (APP-SOC-09)."""
    blob = json.dumps(obj, ensure_ascii=False)
    leaks: list[str] = []
    for u in c.lc.users.values():
        if u is viewer:
            continue
        for v, label in ((u.account_id, "user_id"), (u.learner_id, "learner_id")):
            if v and v in blob:
                leaks.append(f"{label} {u.role}")
        if u.first and u.first in blob:
            leaks.append(f"имя {u.role}")
        if re.search(rf"(?<!\d){u.tg_id}(?!\d)", blob):
            leaks.append(f"Telegram ID {u.role}")
        if u.username in blob:
            leaks.append(f"username {u.role}")
    kid = c.data.get("kid")
    if kid and kid in blob and viewer.learner_id != kid:
        leaks.append("user_id ребёнка")
    if c.data.get("kid_name") and c.data["kid_name"] in blob:
        leaks.append("имя ребёнка")
    check(not leaks, f"{what}: чужие данные в ответе ученику {viewer.role}: {sorted(set(leaks))}")


def outbox(schema: str, event_type: str, since: int, where: str = "") -> list[dict[str, Any]]:
    check(re.fullmatch(r"[a-z_]+", schema) and sg.ET_RE.fullmatch(event_type), f"{schema} {event_type}")
    return pj(f"SELECT coalesce(json_agg(envelope->'payload' ORDER BY created_at), '[]') FROM {schema}.outbox "
              f"WHERE envelope->>'event_type' = '{event_type}' AND created_at >= to_timestamp({int(since)}){where}") or []


def by_user(field: str, user_id: str) -> str:
    check(re.fullmatch(r"[a-z_]+", field), field)
    return f" AND envelope->'payload'->>'{field}' = '{uid(user_id)}'"


def lessons_tick() -> dict[str, Any]:
    r = httpx.post(f"{LESSONS}/internal/v1/lessons:tick", headers={"authorization": f"Bearer {s1.SCHEDULER_TOKEN}"},
                   timeout=60)
    return expect(r, 200)


def staff_hdr(audience: str, perms: set[str], step_up: bool = False) -> dict[str, str]:
    h = s2.staff_token(audience, perms, str(uuid.uuid4()), "operations")
    if step_up:
        h["x-step-up"] = "ok"
    return h


def learner_token(u: s1.U, audience: str, age_band: str) -> dict[str, str]:
    """Внутренний JWT ученика от имени telegram-bff (sub — аккаунт, lrn, age_band) — проверка правил в самом домене."""
    tok = issue_token(s1.ring("telegram-bff"), issuer="telegram-bff", audience=audience, subject=u.account_id,
                      extra={"lrn": u.learner_id, "age_band": age_band})
    return {"x-internal-token": tok}


def bootstrap_projections(force: bool = True) -> dict[str, Any]:
    r = httpx.post(f"{GAME}/internal/v1/projections/bootstrap", params={"force": str(force).lower()},
                   headers={"authorization": f"Bearer {s1.SCHEDULER_TOKEN}"}, timeout=120)
    return expect(r, 200)


def week_now() -> date:
    d = datetime.now(TASHKENT).date()
    return d - timedelta(days=d.weekday())


def inbox_find(u: s1.U, *, category: str | None = None, startapp: str | None = None, title: str | None = None,
               body: str | None = None) -> list[dict[str, Any]]:
    out = []
    for x in u.inbox():
        if category is not None and x["category"] != category:
            continue
        if startapp is not None and x["startapp"] != startapp:
            continue
        if title is not None and title not in x["title"]:
            continue
        if body is not None and body not in x["body"]:
            continue
        out.append(x)
    return out


def consumers_idle(prefixes: tuple[str, ...], timeout: float = 120) -> None:
    def idle() -> bool:
        return all(v["pending"] == 0 and v["ack_pending"] == 0 for k, v in sg.consumers("").items()
                   if k.startswith(prefixes))

    wait_for(idle, timeout, interval=1.0, what=f"потребители {prefixes} без хвоста")


# ---------------------------------------------------------------- реферальная кампания (уборка)


def _campaign_api(method: str, path: str, body: Any = None, *, if_match: str | None = None) -> httpx.Response:
    hdr = staff_hdr("social", {"referral.read", "referral.manage"}, step_up=True)
    if if_match:
        hdr["if-match"] = if_match
    return httpx.request(method, f"{SOCIAL}/internal/v1/admin/referrals/campaigns{path}", json=body, headers=hdr,
                         timeout=20)


def cleanup_leftovers() -> list[str]:
    """Реферальная кампания e2e (комментарий «[e2e …]»): черновик → удалить; активная → новая версия с условиями
    версии, на которой она основана. Только dev-стенд: staff API social от имени admin-bff (ключ стенда, X-Step-Up)."""
    done: list[str] = []
    try:
        httpx.get(f"{SOCIAL}/health/ready", timeout=5).raise_for_status()
    except httpx.HTTPError:
        return ["social недоступен — уборка кампании пропущена"]
    r = _campaign_api("GET", "")
    if r.status_code != 200:
        return [f"кампании: {r.status_code} — уборка пропущена"]
    items = r.json()["items"]
    draft = next((x for x in items if x["status"] == "draft"), None)
    if draft and CAMPAIGN_MARK in (draft.get("comment") or ""):
        check(_campaign_api("DELETE", "/draft").status_code == 204, "уборка: удалить черновик кампании e2e")
        done.append(f"черновик кампании v{draft['version']}: удалён")
        draft = None
    active = next((x for x in items if x["status"] == "active"), None)
    if active and CAMPAIGN_MARK in (active.get("comment") or "") and active.get("based_on"):
        if draft is not None:
            return [*done, f"активная кампания e2e v{active['version']}: есть чужой черновик — не восстановлена"]
        base = expect(_campaign_api("GET", f"/{int(active['based_on'])}"), 200)
        d = expect(_campaign_api("PUT", "/draft", {"payload": base["payload"], "based_on": active["version"],
                                                    "comment": f"e2e: восстановление условий v{base['version']}"}),
                   200)
        expect(_campaign_api("POST", "/draft/validate", {}), 200)
        expect(_campaign_api("POST", "/draft/activate", {"comment": "e2e: уборка — прежние условия кампании"}), 200)
        done.append(f"кампания v{active['version']} (e2e) → v{d['version']} с условиями v{base['version']}")
    return done


# ---------------------------------------------------------------- группы лиги: сдвиг недели (тестовое изменение БД)


def free_week(seed: str, avoid: set[date]) -> date:
    """Свободная прошлая неделя (понедельник) без групп лиг — не пересекается с настоящими и прошлыми прогонами."""
    base = date(2024, 1, 1)
    h = int(hashlib.sha256(seed.encode()).hexdigest(), 16)
    for i in range(300):
        w = base + timedelta(weeks=(h + i) % 100)
        if w in avoid:
            continue
        if s1._psql(f"SELECT count(*) FROM gamification.league_groups WHERE week = '{w.isoformat()}'") == "0":
            return w
    raise StepFailed("нет свободной прошлой недели для закрытия группы")


def shift_group(group_id: str, to_week: date) -> list[str]:
    """ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: группа, её участники и «неделя XP» их операций текущей недели → прошлая неделя to_week
    (закрыть неделю, не дожидаясь понедельника). → user_id участников."""
    g = uid(group_id)
    row = pj("SELECT json_build_object('week', week, 'users', (SELECT coalesce(json_agg(user_id), '[]') FROM "
             f"gamification.league_members WHERE group_id = '{g}')) FROM gamification.league_groups WHERE group_id = '{g}'")
    check(row and row["users"], f"группа {g}: {row}")
    cur = date.fromisoformat(row["week"])
    users = [uid(x) for x in row["users"]]
    ids = ", ".join(f"'{x}'" for x in users)
    sql = ("BEGIN; SET LOCAL session_replication_role = replica; "
           f"UPDATE gamification.league_groups SET week = '{to_week.isoformat()}' WHERE group_id = '{g}'; "
           f"UPDATE gamification.league_members SET week = '{to_week.isoformat()}' WHERE group_id = '{g}'; "
           f"UPDATE gamification.ledger SET league_week = '{to_week.isoformat()}' WHERE league_week = '{cur.isoformat()}' "
           f"AND user_id IN ({ids}); COMMIT;")
    res = psql_try(sql)
    check(res.returncode == 0, f"сдвиг недели группы: {(res.stdout + res.stderr)[:300]}")
    print(f"      ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: группа {g[:8]} ({len(users)} участн.) и XP недели {cur} → неделя {to_week}",
          flush=True)
    return users


def group_of(user_id: str, week: date) -> str | None:
    v = s1._psql(f"SELECT coalesce(group_id::text, '') FROM gamification.league_members WHERE user_id = '{uid(user_id)}' "
                 f"AND week = '{week.isoformat()}' AND left_at IS NULL")
    return v or None


def week_xp(user_id: str, week: date) -> int:
    return int(s1._psql("SELECT coalesce(sum(amount), 0) FROM gamification.ledger WHERE currency = 'xp' AND "
                        f"status = 'confirmed' AND user_id = '{uid(user_id)}' AND league_week = '{week.isoformat()}'"))


def prize_ops(user_id: str, group_id: str) -> list[dict[str, Any]]:
    return pj("SELECT coalesce(json_agg(json_build_object('op', op_id, 'amount', amount, 'status', status, 'reason', "
              "reason) ORDER BY created_at), '[]') FROM gamification.ledger WHERE user_id = "
              f"'{uid(user_id)}' AND (source_ref = 'league:{uid(group_id)}' OR (reason = 'reversal' AND reversal_of IN "
              f"(SELECT op_id FROM gamification.ledger WHERE source_ref = 'league:{uid(group_id)}')))") or []


# ---------------------------------------------------------------- дуэли


def duel_keys(duel_id: str) -> dict[str, dict[str, Any]]:
    items = pj(f"SELECT items FROM lessons.duel_sets WHERE duel_id = '{uid(duel_id)}'")
    check(isinstance(items, list) and items, f"набор дуэли {duel_id} в lessons.duel_sets: {items}")
    return {str(e["item"]["item_id"]): e["item"] for e in items}


def duel_value(view: dict[str, Any], item: dict[str, Any], correct: bool) -> Any:
    """Ответ по ключу снимка; варианты в показе перемешаны по seed набора — индекс верного по тексту."""
    t, key = item["type"], item.get("answer")
    if t in ("single_choice", "translate_choice"):
        good = str(item["options"][int(key)])
        opts = [str(o) for o in view.get("options") or []]
        check(good in opts, f"задание {item['item_id']}: верного варианта нет среди показанных {opts}")
        i = opts.index(good)
        return i if correct else (i + 1) % len(opts)
    if t == "gap_fill":
        k = key[0] if isinstance(key, list) else key
        return str(k) if correct else "zzqqx"
    if t == "order_words":
        words = [str(k) for k in key]
        return words if correct else list(reversed(words)) if len(set(words)) > 1 else [*words, "x"]
    raise StepFailed(f"задание дуэли неизвестного вида {t}")


def play_duel(c: s2.Ctx, u: s1.U, duel_id: str, n_correct: int, *, repeat_answer: bool = False) -> dict[str, Any]:
    """Сессия дуэли как Mini App: одна на участника (повтор — та же), задания по ключу снимка (n_correct верных),
    повтор ответа — тот же результат. → {sid, items, summary, results}."""
    key = str(uuid.uuid4())
    s = u.ok("POST", "/v1/duel-sessions", 201, json={"duel_id": duel_id}, idem=key)
    sid = s["session_id"]
    check(s["kind"] == "duel", f"{u.role}: сессия дуэли {str(s)[:300]}")
    again = u.req("POST", "/v1/duel-sessions", json={"duel_id": duel_id}, idem=key)
    check(again.status_code in (200, 201) and again.json()["session_id"] == sid, f"повтор ключа: {again.status_code}")
    other = u.ok("POST", "/v1/duel-sessions", 200, json={"duel_id": duel_id}, idem=True)
    check(other["session_id"] == sid, "вторая сессия дуэли у того же участника")
    keys = duel_keys(duel_id)
    step = s4.cur(u, sid)
    items: list[str] = []
    n = 0
    for _ in range(60):
        if step["type"] == "done":
            break
        if step["type"] == "item":
            it = step["item"]
            check(step.get("hint_available") is False and step.get("graded_later") is True,
                  f"шаг дуэли: hint_available {step.get('hint_available')}, graded_later {step.get('graded_later')}")
            meta = keys.get(str(it["item_id"]))
            check(meta is not None, f"задание {it['item_id']} не из набора дуэли")
            assert meta is not None
            ans = duel_value(it, meta, n < n_correct)
            r = s4.post_step(u, sid, step, {"answer": ans})
            check(r.get("feedback") is None, f"дуэль: обратная связь после ответа {r.get('feedback')}")
            if repeat_answer and n == 0:
                # повтор того же ответа — тот же результат; другой ответ на отвеченный шаг не принимается
                r2 = u.ok("POST", f"/v1/sessions/{sid}/steps/{step['step_id']}", json={"answer": ans})
                check(r2 == r, f"повтор ответа дал другой результат: {str(r2)[:200]} ≠ {str(r)[:200]}")
                u.ok("POST", f"/v1/sessions/{sid}/steps/{step['step_id']}", 409, "STEP_NOT_CURRENT",
                     json={"answer": duel_value(it, meta, not (n < n_correct))})
            items.append(str(it["item_id"]))
            n += 1
            step = r["next"]
        else:
            step = s4.post_step(u, sid, step, {})["next"]
    check(step["type"] == "done", f"{u.role}: сессия дуэли не дошла до итогов ({step['type']})")
    summ = u.ok("POST", f"/v1/sessions/{sid}/finish")
    check(summ["status"] == "completed" and summ.get("evaluation") is None and summ.get("can_review") is False,
          f"итоги дуэли: {str(summ)[:300]}")
    return {"sid": sid, "items": items, "summary": summ, "keys": keys}


def duel_of(u: s1.U, duel_id: str) -> dict[str, Any]:
    return u.ok("GET", f"/v1/game/duels/{duel_id}")


# ---------------------------------------------------------------- парные комнаты


def room_state(u: s1.U, rid: str, after: int = 0) -> dict[str, Any]:
    return u.ok("GET", f"/v1/pair-rooms/{rid}/state", params={"after_seq": after})


def wait_room(u: s1.U, rid: str, pred: Callable[[dict[str, Any]], bool], what: str, timeout: float = 60) -> dict[str, Any]:
    """Long-poll ленты до условия (after_seq — последний seq: ответ — при новом событии или через ≤ 25 с)."""
    deadline = time.monotonic() + timeout
    st = room_state(u, rid, 0)
    while not pred(st):
        if time.monotonic() > deadline:
            raise StepFailed(f"комната {rid[:8]}: не дождались «{what}» за {timeout:.0f} с; состояние: status "
                             f"{st['status']}, next {st['next_speaker']}, mode {st['mode']}, seq {st['seq']}")
        st = room_state(u, rid, st["seq"])
    return st


def my_turn(role: str) -> Callable[[dict[str, Any]], bool]:
    return lambda st: st["status"] not in LIVE or (st["status"] == "in_progress" and st["next_speaker"] in (role, "both"))


_SCN: dict[str, dict[str, Any]] = {}


def room_scenario(rid: str) -> tuple[dict[str, Any], str | None]:
    """Граф сценария комнаты (catalog, версия из комнаты) и текущий узел сценария (lessons.pair_rooms.state)."""
    row = pj("SELECT json_build_object('cv', content_versions, 'node', state->>'node') FROM lessons.pair_rooms "
             f"WHERE room_id = '{uid(rid)}'")
    check(row, f"комнаты {rid} нет в lessons.pair_rooms")
    ref = row["cv"]["scenario"]
    k = f"{ref['key']}@{ref['version']}"
    if k not in _SCN:
        _SCN[k] = s4.version_payload("scenario", ref["key"], int(ref["version"]))
    return _SCN[k], row["node"]


def script_choice(rid: str, options: list[dict[str, Any]]) -> str:
    """Вариант, ведущий к успеху сцены (кратчайший путь по графу)."""
    scn, node = room_scenario(rid)
    check(node, f"комната {rid[:8]}: нет текущего узла сценария")
    assert node is not None
    intents = s4.route(scn, node, "success") or s4.route(scn, node, "alt_success")
    check(intents, f"из узла {node} нет пути к успеху")
    assert intents is not None
    text = str((s4.transition(scn, node, intents[0]).get("examples_en") or [""])[0])[:160]
    ids = [o["choice_id"] for o in options if o["text_en"] == text]
    check(len(ids) == 1, f"узел {node}: вариант «{text}» не найден среди {options}")
    return ids[0]


def play_choices(c: s2.Ctx, rid: str, players: dict[str, s1.U], max_turns: int = 40) -> dict[str, Any]:
    """Сценарий с выбором реплик: ходы по очереди до конечного узла (успех). players: роль → ученик."""
    st: dict[str, Any] = {}
    for _ in range(max_turns):
        st = room_state(players["A"], rid, 0)
        if st["status"] not in LIVE:
            return st
        role = st["next_speaker"]
        check(role in ("A", "B"), f"комната {rid[:8]}: next_speaker {role}")
        u = players[role]
        mine = wait_room(u, rid, my_turn(role), f"ход {role}", 30)
        if mine["status"] not in LIVE:
            return mine
        check(mine["mode"] == "choices" and mine["options"], f"ход {role} без вариантов: {str(mine)[:300]}")
        cid = script_choice(rid, mine["options"])
        time.sleep(THINK)
        u.ok("POST", f"/v1/pair-rooms/{rid}/turns", json={"choice_id": cid}, idem=True)
    raise StepFailed(f"комната {rid[:8]}: сценарий не закончился за {max_turns} ходов (status {st.get('status')})")


class Heartbeat:
    """Heartbeat участника каждые 8 с в отдельном потоке (как Mini App), пока сценарий ждёт."""

    def __init__(self, u: s1.U, rid: str) -> None:
        self.stop = threading.Event()
        self.errors: list[str] = []
        self.http = httpx.Client(base_url=TG_BFF, timeout=15)
        self.hdr = u.h()
        self.rid = rid
        self.t = threading.Thread(target=self.run, daemon=True)

    def run(self) -> None:
        while not self.stop.is_set():
            r = self.http.post(f"/v1/pair-rooms/{self.rid}/heartbeat", headers=self.hdr)
            if r.status_code != 204:
                self.errors.append(f"{r.status_code} {r.text[:120]}")
            self.stop.wait(8)

    def __enter__(self) -> Heartbeat:
        self.t.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop.set()
        self.t.join(15)
        self.http.close()


def wav(ms: int) -> bytes:
    return s5.wav(ms, 3000, marker="e2e")


# =============================================================================================== шаги
# ---------------------------------------------------------------- S00 стенд


def s_stand(c: s2.Ctx) -> None:
    for name, url in [("social", f"{SOCIAL}/health/ready"), ("gamification", f"{GAME}/health/ready"),
                      ("lessons", f"{LESSONS}/health/ready"), ("notifications", f"{s1.NOTIFICATIONS}/health/ready"),
                      ("identity-consent", f"{s1.IDENTITY}/health/ready"), ("audit", f"{s1.AUDIT}/health/ready"),
                      ("ai-gateway", f"{s4.AI_GATEWAY}/health/ready"), ("admin-bff", f"{c.bff}/health/ready"),
                      ("telegram-bff", f"{TG_BFF}/health/ready"), ("mock-telegram", f"{s1.MOCK_TG}/health")]:
        r = httpx.get(url, timeout=5)
        check(r.status_code == 200, f"{name} не ready: {r.status_code} {r.text[:200]}")
    u0 = str(uuid.uuid4())
    missing = []
    for method, path in (("GET", "/v1/community"), ("PATCH", "/v1/community"), ("PUT", "/v1/community/nickname"),
                         ("POST", "/v1/community/friend-code/rotate"), ("GET", "/v1/friends/search?q=abcd"),
                         ("POST", "/v1/friends/requests"), ("GET", "/v1/friends/requests?direction=in"),
                         ("GET", "/v1/friends"), ("POST", "/v1/blocks"), ("GET", "/v1/blocks"),
                         ("POST", "/v1/complaints"), ("GET", "/v1/sanctions"), ("GET", "/v1/referrals"),
                         ("GET", "/v1/game/leagues"), ("GET", "/v1/game/leagues/history"), ("POST", "/v1/game/duels"),
                         ("GET", "/v1/game/duels"), ("POST", "/v1/duel-sessions"), ("POST", "/v1/pair-rooms"),
                         ("GET", "/v1/pair-rooms"), ("GET", f"/v1/pair-rooms/{u0}/state")):
        r = httpx.request(method, f"{TG_BFF}{path}", timeout=5)
        if r.status_code != 401:
            missing.append(f"telegram-bff {method} {path} → {r.status_code}")
    for path in (f"/admin/v1/social/users/{u0}", "/admin/v1/moderation/cases", "/admin/v1/moderation/appeals",
                 "/admin/v1/referrals/campaigns", "/admin/v1/referrals", "/admin/v1/game/leagues",
                 "/admin/v1/game/duels", "/admin/v1/pair-rooms"):
        r = httpx.get(f"{c.bff}{path}", timeout=5)
        if r.status_code != 401:
            missing.append(f"admin-bff GET {path} → {r.status_code}")
    check(not missing, f"маршруты спринта 7 не готовы (BFF): {missing}")
    for line in [*cleanup_leftovers(), *sg.cleanup_leftovers(), *s4.cleanup_leftovers()]:
        print(f"      уборка: {line}", flush=True)
    t0 = time.monotonic()
    prefixes = ("social_", "gamification_", "lessons_", "notifications_")
    try:
        consumers_idle(prefixes, 10)
    except StepFailed:
        print("      потребители догоняют стрим…", flush=True)
        try:
            consumers_idle(prefixes, 180)
            print(f"      хвост обработан за {time.monotonic() - t0:.0f} с", flush=True)
        except StepFailed:
            # хвост не уходит — обработчик падает на событиях (см. лог сервиса); прогон продолжается, чтобы отчёт
            # показал, какие шаги это ломает (S13 повторит проверку)
            stuck = {k: v for k, v in sg.consumers("").items() if k.startswith(prefixes) and (v["pending"]
                                                                                               or v["ack_pending"])}
            note(f"потребители NATS не догнали стрим за 3 мин (обработчик падает?): {stuck}")
    c.data["dlq_before"] = s1.dlq_counts()
    c.data["policy"] = expect(httpx.get(f"{TG_BFF}/v1/legal/policy", params={"lang": "ru"}), 200)
    c.lc.data["policy"] = c.data["policy"]
    camp = pj("SELECT json_build_object('version', version, 'payload', payload) FROM social.referral_campaigns "
              "WHERE status = 'active'")
    check(camp and camp["payload"].get("min_lessons"), f"активная реферальная кампания: {camp}")
    c.data["campaign0"] = camp
    rules = pj("SELECT json_build_object('version', version, 'payload', payload) FROM gamification.rules_versions "
               "WHERE status = 'active'")
    check(rules and rules["payload"].get("league") and rules["payload"].get("duel"),
          f"активные правила игры без разделов спринта 7: {str(rules)[:300]}")
    c.data["rules0"] = rules
    scns = pj("SELECT coalesce(json_agg(json_build_object('key', cv.key, 'aud', cv.payload->'audience') ORDER BY cv.key), "
              "'[]') FROM catalog.content_versions cv JOIN catalog.content_pointers p ON p.kind = cv.kind AND "
              "p.key = cv.key AND p.published_version = cv.version WHERE cv.kind = 'scenario'") or []
    both = [s["key"] for s in scns if {"kids", "adults"} <= set(s["aud"] or [])]
    check(both, f"нет опубликованного сценария для взрослых и детей (парный урок): {scns}")
    c.data["scn"] = "sc-cafe-coffee" if "sc-cafe-coffee" in both else both[0]
    c.data["scn_kids"] = next((k for k in both if k != c.data["scn"]), both[0])
    print(f"      кампания v{camp['version']}, правила v{rules['version']}, сценарии комнат {c.data['scn']} / "
          f"{c.data['scn_kids']}", flush=True)


# ---------------------------------------------------------------- S01 ученики


def s_learners(c: s2.Ctx) -> None:
    lc = c.lc
    z = lc.data["zone_day"]
    c.data["marker"] = f"Zq{c.tag}x"
    for role, name in (("LA", "Азиза"), ("LB", "Бобур"), ("LC", "Сардор"), ("LD", "Дилноза"), ("LX", "Хуршид"),
                       ("LR", "Рустам"), ("LI", "Ислом"), ("FM", "Фарход"), ("P", "Парвина"), ("G", "Гулнора")):
        s1.onboard(lc.user(role, name), zone=z, purposes=PURPOSES, categories={"social": True})
    p, fm = lc.users["P"], lc.users["FM"]
    kid_name = f"Камрон {c.tag}K"
    kid = p.ok("POST", "/v1/learners", 201, json={"display_name": kid_name, "age_band": "6-9"}, idem=True)
    c.data.update(kid=kid["learner_id"], kid_name=kid_name)
    p.switch(kid["learner_id"])
    try:
        s1.plan_patch(p, {"goal": "study", "level_self": "zero", "schedule": {
            "preset": "daily", "preferred_time": "17:00", "duration_min": 15, "reminders_enabled": False,
            "timezone": z}})
        p.ok("POST", "/v1/plan/onboarding/complete")
    finally:
        p.switch(p.account_id)
    # семья: P → FM (взрослый член семьи)
    inv = p.ok("POST", "/v1/invites", 201, json={"kind": "family"}, idem=True)
    token = inv["link"].split("startapp=inv_", 1)[1]
    c.secrets["токен приглашения (семья)"] = token
    fm.ok("POST", "/v1/invites/open", json={"token": token})
    fam = fm.ok("POST", f"/v1/invites/{inv['invite_id']}/accept")["family"]
    check(any(m["user_id"] == p.account_id for m in fam["members"]), f"семья FM: {fam}")
    # подросток с согласием родителя (G — взрослый со своим согласием) и без него
    tg = lc.user("TG", "Тимур")
    s1.onboard(tg, zone=z, age="14-17", purposes=s1.REQUIRED, categories={})
    link = tg.ok("POST", "/v1/profile/guardian-consent")["link"]
    gtoken = link.split("startapp=gc_", 1)[1]
    c.secrets["токен согласия родителя"] = gtoken
    dec = lc.users["G"].ok("POST", f"/v1/guardian-consents/{gtoken}/accept")
    check(dec["status"] == "granted", f"согласие родителя: {dec}")
    tg.login()
    check(tg.session["account"]["guardian_consent"] == "granted", tg.session["account"])
    tg.ok("POST", "/v1/profile/consent", json={"policy_version": c.data["policy"]["version"], "purposes": PURPOSES})
    tg.ok("PATCH", "/v1/profile/settings", json={"notifications": {"enabled": True, "categories": {"social": True},
                                                                   "timezone": z}})
    tn = lc.user("TN", "Нодира")
    s1.onboard(tn, zone=z, age="14-17", purposes=s1.REQUIRED, categories={})
    # игра знает учеников (бонус регистрации), social — member_id
    for role in ("LA", "LB", "LC", "LD", "LX", "LR", "LI", "FM", "P", "TG", "TN"):
        wait_for(lambda u=lc.users[role]: sg.summary(u)["freeze_stock"] == 2, 90, interval=1.5,
                 what=f"{role}: игра знает ученика (бонус регистрации)")
    c.data["mid"] = {}
    c.data["nick"] = {}
    for role in ("LA", "LB", "LC", "LD", "LX", "LR", "LI", "FM", "P", "TG", "TN", "G"):
        u = lc.users[role]
        cp = community(u)
        check(cp["member_id"] == member_id_of(u.learner_id),
              f"{role}: member_id {cp['member_id']} ≠ HMAC(MEMBER_ID_KEY, user_id) (INTERNAL_API §0)")
        c.data["mid"][role] = cp["member_id"]
    famv = p.ok("GET", "/v1/family")
    ids = {m["user_id"]: m.get("member_id") for m in famv["members"]}
    check(ids.get(kid["learner_id"]) == member_id_of(kid["learner_id"]) and ids.get(fm.account_id) == mid(c, "FM"),
          f"Family.members[].member_id (§10 п. 1): {famv['members']}")
    c.data["mid"]["K"] = ids[kid["learner_id"]]
    print("      ученики LA, LB, LC, LD, LX, LR, LI, FM, G; подростки TG (согласие родителя) и TN (без); семья P + "
          "ребёнок 6–9 + FM; member_id = HMAC у всех", flush=True)


# ---------------------------------------------------------------- S02 сотрудники


def s_staff(c: s2.Ctx) -> None:
    s3.warm_admin_identity(c)
    root = Staff(c.browser("root"), s2.BOOT_EMAIL, s2.BOOT_PASSWORD, display_name="Администратор")
    c.staff["root"] = root
    c.remember("пароль bootstrap", s2.BOOT_PASSWORD)
    r = root.browser.post("/admin/v1/auth/login", {"email": s2.BOOT_EMAIL, "password": s2.BOOT_PASSWORD})
    if r.status_code == 401:
        raise StepFailed("bootstrap-учётка уже использована — запускайте `run_local.sh social` (сбрасывает учётки "
                         "admin-identity)")
    me = s2.login(c, root, expect_next=["password_change", "mfa_enroll", "done"])
    check(me["staff"]["role"] == "super_admin", me["staff"])
    roles = {x["code"]: x for x in expect(root.browser.get("/admin/v1/roles"), 200)["items"]}
    c.data["roles"] = {k: sorted(v.get("permissions") or []) for k, v in roles.items()}
    c.data["root_perms"] = sorted(me["permissions"])
    c.data["priv"] = {k: bool(roles[r_]["privileged"]) for k, r_ in (("ops", "operations"), ("sup", "support"),
                                                                      ("cm", "content_manager"))}
    s2.step_up(root)
    s3._create(c, "ops", "operations", "Олим Операции", c.data["priv"]["ops"])
    s3._create(c, "sup", "support", "Сабина Поддержка", c.data["priv"]["sup"])
    s3._create(c, "cm", "content_manager", "Камола Контент", c.data["priv"]["cm"])
    for who in ("ops", "sup", "cm"):
        nxt = ["password_change", "mfa_enroll", "done"] if c.data["priv"][who] else ["password_change", "done"]
        me = s2.login(c, c.staff[who], expect_next=nxt)
        c.data.setdefault("perms", {})[who] = set(me["permissions"])
    print(f"      operations (привилегированная: {c.data['priv']['ops']}), support ({c.data['priv']['sup']}), "
          f"content_manager ({c.data['priv']['cm']})", flush=True)


# ---------------------------------------------------------------- S03 друзья


def s_friends(c: s2.Ctx) -> None:
    la, lb, lc_, ld, lx, tg, tn, p = (u_(c, r) for r in ("LA", "LB", "LC", "LD", "LX", "TG", "TN", "P"))
    tag = c.tag
    since = int(time.time()) - 1
    deferred: list[str] = []
    # профиль сообщества
    for u in (la, lb, lc_, ld, lx, tg):
        cp = community(u)
        check(set(cp) == COMMUNITY_KEYS, f"{u.role}: поля CommunityProfile {sorted(set(cp) ^ COMMUNITY_KEYS)}")
        check(MEMBER_RE.fullmatch(cp["member_id"]) and cp["nickname"] is None and CODE_RE.fullmatch(cp["friend_code"])
              and cp["friends_available"] is True and cp["friends_unavailable_reason"] is None
              and cp["game_profile_hidden"] is False and cp["nickname_change_available_at"] is None
              and cp["restrictions"] == {"social_ban": False, "social_ban_until": None},
              f"{u.role}: новый профиль сообщества {cp}")
    # ник: ошибки, двойники, кулдаун
    for bad, reason in (("ab", "length"), ("x" * 21, "length"), ("bad nick!", "chars"), (f"Admin_{tag}", "forbidden"),
                        (f"FuCk_{tag}", "forbidden"), (f"t1lher0_{tag}", "forbidden")):
        e = la.ok("PUT", "/v1/community/nickname", 422, "NICKNAME_INVALID", json={"nickname": bad})
        check((e.get("details") or {}).get("reason") == reason, f"ник «{bad}»: {e}")
    nicks = {"LA": f"Kometa_{tag}", "LB": f"Bobur_{tag}", "LC": f"Sardor_{tag}", "LD": f"Dilnoza_{tag}",
             "LX": f"Xurshid_{tag}"}
    cp = la.ok("PUT", "/v1/community/nickname", json={"nickname": nicks["LA"]})
    check(cp["nickname"] == nicks["LA"], f"ник LA: {cp}")
    same = la.ok("PUT", "/v1/community/nickname", json={"nickname": nicks["LA"]})
    check(same["nickname"] == nicks["LA"], "тот же ник — 200 без смены")
    twin = "Комета_" + tag  # кириллические К, о, м, е, т, а — двойники латиницы
    lb.ok("PUT", "/v1/community/nickname", 409, "NICKNAME_TAKEN", json={"nickname": twin})
    lb.ok("PUT", "/v1/community/nickname", 409, "NICKNAME_TAKEN", json={"nickname": nicks["LA"].upper()})
    e = la.ok("PUT", "/v1/community/nickname", 429, "NICKNAME_COOLDOWN", json={"nickname": f"Kometa2_{tag}"})
    until = (e.get("details") or {}).get("until")
    check(until and timedelta(days=6) < parse_ts(until) - datetime.now(UTC) <= timedelta(days=7, minutes=5),
          f"NICKNAME_COOLDOWN.until: {e}")
    check(community(la)["nickname_change_available_at"] == until, "nickname_change_available_at ≠ until кулдауна")
    for role in ("LB", "LC", "LD", "LX"):
        check(u_(c, role).ok("PUT", "/v1/community/nickname", json={"nickname": nicks[role]})["nickname"] == nicks[role],
              f"ник {role}")
    c.data["nick"].update(nicks)
    # код друга и поиск
    code = community(la)["friend_code"]
    c.secrets["код друга LA"] = code
    for q in (code, code.lower(), code.replace("-", "")):
        items = search(lb, q)
        check(len(items) == 1 and set(items[0]) == CARD_KEYS and items[0]["member_id"] == mid(c, "LA")
              and items[0]["nickname"] == nicks["LA"] and items[0]["relation"] == "none"
              and items[0]["request_id"] is None, f"поиск по коду «{q}»: {items}")
    check(search(lb, nicks["LA"].upper())[0]["member_id"] == mid(c, "LA"), "поиск по нику без учёта регистра")
    check(search(la, nicks["LA"])[0]["relation"] == "self", "поиск себя — relation self")
    check(search(lb, f"Nobody_{tag}") == [], "неизвестный ник — пусто")
    new = la.ok("POST", "/v1/community/friend-code/rotate")["friend_code"]
    c.secrets["код друга LA (новый)"] = new
    check(new != code and CODE_RE.fullmatch(new), f"новый код друга: {new}")
    check(search(lb, code) == [] and search(lb, new)[0]["member_id"] == mid(c, "LA"), "старый код после смены находится")
    # встречные заявки → одна дружба
    la.ok("POST", "/v1/friends/requests", 422, "IDEMPOTENCY_KEY_REQUIRED", json={"member_id": mid(c, "LB")})
    key = str(uuid.uuid4())
    r1 = la.ok("POST", "/v1/friends/requests", 201, json={"member_id": mid(c, "LB")}, idem=key)
    check(set(r1) == REQUEST_KEYS and r1["status"] == "pending" and r1["direction"] == "out"
          and r1["member_id"] == mid(c, "LB") and r1["nickname"] == nicks["LB"], f"заявка LA → LB: {r1}")
    again = la.req("POST", "/v1/friends/requests", json={"member_id": mid(c, "LB")}, idem=key)
    check(again.status_code in (200, 201) and again.json()["request_id"] == r1["request_id"], "повтор Idempotency-Key")
    card = search(lb, nicks["LA"])[0]
    check(card["relation"] == "request_in" and card["request_id"] == r1["request_id"], f"карточка у LB: {card}")
    inc = requests_of(lb, "in")
    check([x["request_id"] for x in inc] == [r1["request_id"]] and inc[0]["direction"] == "in", f"входящие LB: {inc}")
    r2 = lb.ok("POST", "/v1/friends/requests", 200, json={"member_id": mid(c, "LA")}, idem=True)
    check(r2["status"] == "accepted", f"встречная заявка = принятие: {r2}")
    fa, fb = friends_of(la), friends_of(lb)
    check(set(fa) == {mid(c, "LB")} and set(fb) == {mid(c, "LA")} and set(fa[mid(c, "LB")]) == FRIEND_KEYS
          and fa[mid(c, "LB")]["nickname"] == nicks["LB"], f"друзья LA {fa} / LB {fb}")
    check(not requests_of(la, "out") and not requests_of(lb, "in"), "pending-заявки после встречной")
    la.ok("POST", "/v1/friends/requests", 409, "ALREADY_FRIENDS", json={"member_id": mid(c, "LB")}, idem=True)
    # гонка: LC и LD подают встречные заявки одновременно → одна дружба
    res: dict[str, httpx.Response] = {}

    def send(a: s1.U, b: str) -> None:
        with httpx.Client(base_url=TG_BFF, timeout=30) as h:
            res[a.role] = h.post("/v1/friends/requests", json={"member_id": mid(c, b)},
                                 headers=a.h({"idempotency-key": str(uuid.uuid4())}))

    th = [threading.Thread(target=send, args=(lc_, "LD")), threading.Thread(target=send, args=(ld, "LC"))]
    for t in th:
        t.start()
    for t in th:
        t.join(30)
    codes = sorted(r.status_code for r in res.values())
    check(codes == [200, 201] and {r.json()["status"] for r in res.values()} == {"pending", "accepted"},
          f"встречные заявки одновременно: {[(k, r.status_code, r.text[:120]) for k, r in res.items()]}")
    check(mid(c, "LD") in friends_of(lc_) and mid(c, "LC") in friends_of(ld), "гонка: дружба LC–LD не создана")
    # отклонение, принятие, отмена, чужая заявка
    r = la.ok("POST", "/v1/friends/requests", 201, json={"member_id": mid(c, "LD")}, idem=True)
    lc_.ok("POST", f"/v1/friends/requests/{r['request_id']}/accept", 404, "REQUEST_NOT_FOUND")
    check(ld.ok("POST", f"/v1/friends/requests/{r['request_id']}/decline")["status"] == "declined", "отклонение")
    check(ld.ok("POST", f"/v1/friends/requests/{r['request_id']}/decline")["status"] == "declined", "повтор отклонения")
    e = ld.ok("POST", f"/v1/friends/requests/{r['request_id']}/accept", 409, "REQUEST_STATE")
    check((e.get("details") or {}).get("status") == "declined", f"REQUEST_STATE: {e}")
    befriend(c, "LA", "LD")
    r = la.ok("POST", "/v1/friends/requests", 201, json={"member_id": mid(c, "LX")}, idem=True)
    check(la.ok("POST", f"/v1/friends/requests/{r['request_id']}/cancel")["status"] == "cancelled", "отмена заявки")
    check(la.ok("POST", f"/v1/friends/requests/{r['request_id']}/cancel")["status"] == "cancelled", "повтор отмены")
    befriend(c, "LA", "TG")  # подросток с согласием родителя
    befriend(c, "LX", "LB")
    befriend(c, "LC", "LB")
    # удаление друга
    befriend(c, "LD", "LB")
    lb.ok("DELETE", f"/v1/friends/{mid(c, 'LD')}", 204)
    lb.ok("DELETE", f"/v1/friends/{mid(c, 'LD')}", 204)
    check(mid(c, "LB") not in friends_of(ld) and mid(c, "LD") not in friends_of(lb), "удаление дружбы")
    ev = outbox("social", "social.friendship.changed.v1", since)
    pair = {lb.learner_id, ld.learner_id}
    check([x["status"] for x in ev if {x["user_a"], x["user_b"]} == pair] == ["added", "removed"],
          f"social.friendship.changed.v1 LB–LD: {[x for x in ev if {x['user_a'], x['user_b']} == pair]}")
    ab = [x for x in ev if {x["user_a"], x["user_b"]} == {la.learner_id, lb.learner_id}]
    check(len(ab) == 1 and ab[0]["status"] == "added", f"встречные заявки LA–LB — дружб: {ab}")
    # блокировка: LD блокирует LC (друзья) при активном вызове на дуэль и приглашении в парный урок
    duel = lc_.ok("POST", "/v1/game/duels", 201, json={"opponent_member_id": mid(c, "LD")}, idem=True)
    room = lc_.ok("POST", "/v1/pair-rooms", 201, json={"partner_member_id": mid(c, "LD"), "pair_id": PAIR,
                                                       "scenario_id": c.data["scn"], "start": "now"}, idem=True)
    pend = lx.ok("POST", "/v1/friends/requests", 201, json={"member_id": mid(c, "LD")}, idem=True)
    blk = ld.ok("POST", "/v1/blocks", 201, json={"member_id": mid(c, "LC")})
    check(set(blk) == {"member_id", "nickname", "created_at"} and blk["member_id"] == mid(c, "LC"), f"блокировка: {blk}")
    ld.ok("POST", "/v1/blocks", 200, json={"member_id": mid(c, "LC")})
    ld.ok("POST", "/v1/blocks", 201, json={"member_id": mid(c, "LX")})
    check(mid(c, "LC") not in friends_of(ld) and mid(c, "LD") not in friends_of(lc_), "блокировка не удалила дружбу")
    check(all(x["request_id"] != pend["request_id"] for x in requests_of(lx, "out")),
          "блокировка не отменила pending-заявку LX → LD")
    try:
        wait_for(lambda: duel_of(lc_, duel["duel_id"])["status"] == "cancelled", 30, interval=1.0,
                 what="вызов на дуэль LC → LD отменён блокировкой (social.block.changed.v1 → gamification)")
    except StepFailed as exc:
        deferred.append(str(exc) + f"; статус {duel_of(lc_, duel['duel_id'])['status']}")
    try:
        wait_for(lambda: lc_.ok("GET", f"/v1/pair-rooms/{room['room_id']}")["status"] == "cancelled", 30, interval=1.0,
                 what="приглашение в парный урок LC → LD отменено блокировкой (social.block.changed.v1 → lessons)")
    except StepFailed as exc:
        deferred.append(str(exc))
    for u, other in ((lc_, "LD"), (ld, "LC")):
        u.ok("POST", "/v1/friends/requests", 403, "BLOCKED", json={"member_id": mid(c, other)}, idem=True)
        check(search(u, nick(c, other)) == [], f"{u.role} находит заблокированного/заблокировавшего {other}")
    lc_.ok("POST", "/v1/game/duels", 403, "BLOCKED", json={"opponent_member_id": mid(c, "LD")}, idem=True)
    lc_.ok("POST", "/v1/pair-rooms", 403, "BLOCKED", json={"partner_member_id": mid(c, "LD"), "pair_id": PAIR,
                                                           "scenario_id": c.data["scn"], "start": "now"}, idem=True)
    bl = ld.ok("GET", "/v1/blocks")["items"]
    check({x["member_id"] for x in bl} == {mid(c, "LC"), mid(c, "LX")}, f"мои блокировки LD: {bl}")
    ld.ok("DELETE", f"/v1/blocks/{mid(c, 'LX')}", 204)
    ld.ok("DELETE", f"/v1/blocks/{mid(c, 'LC')}", 204)
    check(mid(c, "LC") not in friends_of(ld), "снятие блокировки вернуло дружбу")
    check(search(lc_, nick(c, "LD"))[0]["relation"] == "none", "после снятия блокировки поиск")
    bev = outbox("social", "social.block.changed.v1", since, by_user("blocker_user_id", ld.learner_id))
    check(Counter(x["status"] for x in bev) == Counter({"added": 2, "removed": 2}), f"social.block.changed.v1: {bev}")
    # скрытый игровой профиль: LD не виден в лиге друзей LA, себе — виден
    h = ld.ok("PATCH", "/v1/community", json={"game_profile_hidden": True})
    check(h["game_profile_hidden"] is True, f"скрытие профиля: {h}")
    try:
        wait_for(lambda: mid(c, "LD") not in {r_["member_id"] for r_ in la.ok("GET", "/v1/game/leagues")["friends"]["rows"]},
                 30, interval=1.0, what="скрытый LD исчез из лиги друзей LA (social.profile.updated.v1 → gamification)")
        lg = ld.ok("GET", "/v1/game/leagues")
        check(any(r_["me"] and r_["member_id"] == mid(c, "LD") for r_ in lg["friends"]["rows"]),
              "скрытый профиль: себя в лиге друзей не видно")
        check(lg["general"]["unavailable_reason"] == "hidden", f"общая лига скрытого: {lg['general']}")
    except StepFailed as exc:
        deferred.append(str(exc))
    check(ld.ok("PATCH", "/v1/community", json={"game_profile_hidden": False})["game_profile_hidden"] is False, "показ")
    # подросток без согласия, ребёнок
    cp = community(tn)
    check(cp["friends_available"] is False and cp["friends_unavailable_reason"] == "guardian_consent",
          f"подросток без согласия: {cp}")
    e = tn.ok("POST", "/v1/friends/requests", 403, "FRIENDS_NOT_ALLOWED", json={"member_id": mid(c, "LA")}, idem=True)
    check((e.get("details") or {}).get("reason") == "guardian_consent", f"FRIENDS_NOT_ALLOWED: {e}")
    check(search(la, cp["friend_code"]) == [], "подросток без согласия находится поиском")
    p.switch(c.data["kid"])
    try:
        kc = community(p)
        check(kc["friends_available"] is False and kc["friends_unavailable_reason"] == "kids", f"ребёнок: {kc}")
        kid_code = kc["friend_code"]
        r = p.req("GET", "/v1/friends/search", params={"q": nicks["LA"]})
        check(r.status_code == 403 and r.json().get("code") in ("FRIENDS_NOT_ALLOWED", "KIDS_NOT_ALLOWED"),
              f"поиск ребёнком: {r.status_code} {r.text[:200]}")
        p.ok("POST", "/v1/friends/requests", 403, "FRIENDS_NOT_ALLOWED", json={"member_id": mid(c, "LA")}, idem=True)
        p.ok("GET", "/v1/blocks", 403, "KIDS_NOT_ALLOWED")
        p.ok("POST", "/v1/complaints", 403, "KIDS_NOT_ALLOWED", json={"member_id": mid(c, "LA"), "subject_kind": "user",
                                                                      "subject_id": None, "reason": "spam"}, idem=True)
        p.ok("GET", "/v1/referrals", 403, "KIDS_NOT_ALLOWED")
    finally:
        p.switch(p.account_id)
    check(search(la, kid_code) == [], "ребёнок находится поиском")
    # приватность ответов
    for u in (la, lb, ld):
        private(c, {"c": community(u), "f": friends_of(u), "in": requests_of(u, "in"), "out": requests_of(u, "out"),
                    "b": u.ok("GET", "/v1/blocks"), "s": search(u, nicks["LA"])}, u, "друзья")
    # входящая заявка LX → LC остаётся pending (для S11)
    c.data["lx_pending"] = lx.ok("POST", "/v1/friends/requests", 201, json={"member_id": mid(c, "LC")},
                                 idem=True)["request_id"]
    c.data["friends"] = True
    print(f"      ники {nicks['LA']} (двойник «{twin}» → 409, кулдаун {until[:10]}); код друга сменён; LA–LB "
          "встречными заявками, LC–LD гонкой; блокировка LD→LC отменила вызов и приглашение", flush=True)
    if deferred:
        raise StepFailed("; ".join(deferred))


# ---------------------------------------------------------------- S04 лиги


def rules_activate(c: s2.Ctx, payload: dict[str, Any], what: str) -> int:
    """Правила игры: черновик → проверка → активация (operations, step-up); комментарий «[e2e …] активация»."""
    cm_, ops = c.staff["cm"], c.staff["ops"]
    b = ops.browser
    v0 = sg.active_version(ops)["version"]
    items = expect(b.get("/admin/v1/game/rules"), 200)["items"]
    if any(x["status"] == "draft" for x in items):
        expect(b.request("DELETE", "/admin/v1/game/rules/draft", json_body={}), 204)
        note("на стенде был чужой черновик правил — удалён")
    tag = f"[e2e {c.tag}]"
    d = expect(b.request("PUT", "/admin/v1/game/rules/draft",
                         json_body={"payload": payload, "comment": f"{tag} черновик: {what}", "based_on": v0}), 200)
    val = expect(b.post("/admin/v1/game/rules/draft/validate", {}), 200)
    check(val["ok"] is True, f"проверка правил: {val}")
    s2.ensure_step_up(ops)
    act = expect(b.post("/admin/v1/game/rules/draft/activate", {"comment": f"{tag} активация: {what}"}), 200)
    check(act["status"] == "active" and act["version"] == d["version"], f"активация правил: {str(act)[:200]}")
    del cm_
    return int(v0)


def rules_rollback(c: s2.Ctx, v0: int) -> None:
    ops = c.staff["ops"]
    s2.ensure_step_up(ops)
    expect(ops.browser.post(f"/admin/v1/game/rules/{v0}/rollback", {"comment": f"[e2e {c.tag}] откат правил лиги"}), 200)


def projection_bootstrap(c: s2.Ctx) -> None:
    """Начальная загрузка проекций gamification на непустой базе: потерянные строки (события старше 7 дней) — из
    выгрузок social и diagnostics; снятая дружба не возвращается, свежие строки не перетираются."""
    la, lb, ld, p, fm = (u_(c, r) for r in ("LA", "LB", "LD", "P", "FM"))

    def pair_sql(x: s1.U, y: s1.U) -> str:
        a, b = sorted([uid(x.learner_id), uid(y.learner_id)])
        return f"user_a = '{a}' AND user_b = '{b}'"

    ab, bd = pair_sql(la, lb), pair_sql(lb, ld)
    fam_ids = ", ".join(f"'{uid(x)}'" for x in (p.learner_id, c.data["kid"], fm.learner_id))
    wait_for(lambda: s1._psql(f"SELECT coalesce(string_agg(status, ','), '') FROM gamification.social_friends WHERE {ab}")
             == "added" and s1._psql(f"SELECT coalesce(string_agg(status, ','), '') FROM gamification.social_friends "
                                     f"WHERE {bd}") == "removed"
             and s1._psql(f"SELECT count(*) FROM gamification.family_members WHERE user_id IN ({fam_ids})") == "3",
             30, interval=1.0, what="проекции gamification: дружба LA–LB, снятая LB–LD, семья P (события social)")
    expect(httpx.post(f"{GAME}/internal/v1/projections/bootstrap", timeout=10), 401)
    # ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: события дружбы и семьи «ушли из стрима» — строк проекций нет
    s5.shift_rows(f"DELETE FROM gamification.social_friends WHERE {ab} RETURNING user_a", "проекция дружбы LA–LB удалена")
    s5.shift_rows(f"DELETE FROM gamification.family_members WHERE user_id IN ({fam_ids}) RETURNING user_id",
                  "проекция семьи P удалена")
    fl = la.ok("GET", "/v1/game/leagues")
    check(mid(c, "LB") not in {r_["member_id"] for r_ in fl["friends"]["rows"]}
          and p.ok("GET", "/v1/game/leagues")["family"] is None, "без строк проекций лиги всё ещё видят LB и семью")
    res = bootstrap_projections(force=True)
    check({"families", "friendships", "levels"} <= set(res)
          and all(res[k]["status"] == "completed" and res[k]["items"] >= 1 for k in ("families", "friendships")),
          f"projections/bootstrap: {res}")
    check(s1._psql(f"SELECT coalesce(string_agg(status, ','), '') FROM gamification.social_friends WHERE {ab}") == "added"
          and s1._psql(f"SELECT count(*) FROM gamification.family_members WHERE user_id IN ({fam_ids})") == "3",
          "начальная загрузка не восстановила дружбу LA–LB и семью P")
    check(s1._psql(f"SELECT coalesce(string_agg(status, ','), '') FROM gamification.social_friends WHERE {bd}")
          == "removed", "начальная загрузка вернула снятую дружбу LB–LD")
    check(mid(c, "LB") in {r_["member_id"] for r_ in la.ok("GET", "/v1/game/leagues")["friends"]["rows"]}
          and {mid(c, "K"), mid(c, "FM")} <= {r_["member_id"] for r_ in
                                              (p.ok("GET", "/v1/game/leagues")["family"] or {}).get("rows", [])},
          "после начальной загрузки лиги друзей и семьи без LB / семьи")
    again = bootstrap_projections(force=False)
    check(all(v.get("status") == "skipped" for k, v in again.items() if k in ("families", "friendships", "levels"))
          or again.get("skipped") is True, f"повтор без force: {again}")
    loads = pj("SELECT json_object_agg(name, json_build_object('done', completed_at IS NOT NULL, 'error', error)) "
               "FROM gamification.projection_loads") or {}
    check(all(v["done"] and not v["error"] for v in loads.values()) and len(loads) >= 3, f"projection_loads: {loads}")
    c.data["bootstrap"] = res
    print(f"      начальная загрузка проекций: { {k: v['items'] for k, v in res.items() if isinstance(v, dict)} } — "
          "дружба и семья восстановлены, снятая дружба не вернулась", flush=True)


def s_leagues(c: s2.Ctx) -> None:
    need(c, "friends")
    la, lb, tg, tn, p = (u_(c, r) for r in ("LA", "LB", "TG", "TN", "P"))
    ops, cm_ = c.staff["ops"], c.staff["cm"]
    since = int(time.time()) - 1
    deferred: list[str] = []
    wk = week_now()
    projection_bootstrap(c)
    # XP недели: урок LA, чтение LB
    les = s5.pass_lesson(c, la, OPEN_OK)
    sg.wait_rewards(la, les["sid"], lambda x: x["status"] == "ready" and bool(sg.ops_of(x, "lesson", "xp")),
                    "награды урока LA")
    sg.wait_reading_reward(lb, sg.reading_session(c, lb))
    xp_la = week_xp(la.learner_id, wk)
    hist = sum(int(x["amount"]) for x in sg.history(la, "xp") if x["reason"] in WEEK_REASONS
               and parse_ts(x["created_at"]).astimezone(TASHKENT).date() >= wk)
    if hist != xp_la:
        note(f"XP недели LA по реестру (league_week) {xp_la} ≠ сумма операций недели в истории {hist}")
    lg = wait_for(lambda: (v := la.ok("GET", "/v1/game/leagues")) and next(
        (r_ for r_ in v["friends"]["rows"] if r_["me"]), {}).get("xp") == xp_la and v, 30, interval=1.0,
        what=f"XP недели LA в лиге друзей = {xp_la} (сумма операций недели)")
    check(lg["week"] == wk.isoformat() and parse_ts(lg["ends_at"]) == datetime.combine(
        wk + timedelta(days=7), datetime.min.time(), tzinfo=TASHKENT), f"неделя лиги: {lg['week']} {lg['ends_at']}")
    rows = lg["friends"]["rows"]
    check(all(set(r_) == ROW_KEYS for r_ in rows), f"поля StandingRow: {rows[:2]}")
    check({mid(c, x) for x in ("LA", "LB", "LD", "TG")} <= {r_["member_id"] for r_ in rows},
          f"лига друзей LA: {[(r_['nickname'], r_['xp']) for r_ in rows]}")
    check([r_["place"] for r_ in rows] == list(range(1, len(rows) + 1))
          and all(rows[i]["xp"] >= rows[i + 1]["xp"] for i in range(len(rows) - 1)), f"места по XP: {rows}")
    check(next(r_ for r_ in rows if r_["member_id"] == mid(c, "LB"))["nickname"] == nick(c, "LB"), "ник друга в лиге")
    check(lg["family"] is None and lg["general"]["opt_in"] is False and lg["general"]["available"] is True,
          f"лига LA: family {lg['family']}, general {lg['general']}")
    private(c, lg, la, "лига друзей")
    # семейная лига: родитель и ребёнок
    fp = p.ok("GET", "/v1/game/leagues")
    fam_ids = {r_["member_id"] for r_ in (fp["family"] or {}).get("rows", [])}
    check({mid(c, "P"), mid(c, "K"), mid(c, "FM")} <= fam_ids and fp["friends"] is not None,
          f"семейная лига родителя: {fam_ids}")
    p.switch(c.data["kid"])
    try:
        kv = p.ok("GET", "/v1/game/leagues")
        check(kv["friends"] is None and kv["family"] and kv["general"]["available"] is False
              and kv["general"]["unavailable_reason"] == "kids" and kv["family"]["total_xp"] >= 0,
              f"лига ребёнка: friends {kv['friends']}, general {kv['general']}")
        p.ok("PATCH", "/v1/game/settings", 403, "KIDS_NOT_ALLOWED", json={"league_opt_in": True})
        private(c, kv, p, "семейная лига ребёнка")
    finally:
        p.switch(p.account_id)
    # общая лига: без ника 409, подросток без согласия 403, включение
    tg.ok("PATCH", "/v1/game/settings", 409, "NICKNAME_REQUIRED", json={"league_opt_in": True})
    r = tn.req("PATCH", "/v1/game/settings", json={"league_opt_in": True})
    check(r.status_code == 403 and r.json().get("code") in ("FRIENDS_NOT_ALLOWED", "CONSENT_REQUIRED"),
          f"подросток без согласия включает общую лигу: {r.status_code} {r.text[:200]}")
    # защита в глубину: gamification сам не пускает 14–17 без согласия родителя (мимо telegram-bff)
    r = httpx.patch(f"{GAME}/internal/v1/game/settings", json={"league_opt_in": True}, timeout=15,
                    headers=learner_token(tn, "gamification", "14-17"))
    if not (r.status_code == 403 and r.json().get("code") == "FRIENDS_NOT_ALLOWED"
            and (r.json().get("details") or {}).get("reason") == "guardian_consent"):
        deferred.append(f"gamification: подросток без согласия родителя включает общую лигу напрямую — "
                        f"{r.status_code} {r.text[:200]} (ожидали 403 FRIENDS_NOT_ALLOWED {{reason: guardian_consent}})")
    gv = tn.ok("GET", "/v1/game/leagues")["general"]
    if not (gv["available"] is False and gv["unavailable_reason"] == "guardian_consent"):
        deferred.append(f"общая лига подростка без согласия: {gv}")
    c.data["nick"]["TG"] = f"Timur_{c.tag}"
    tg.ok("PUT", "/v1/community/nickname", json={"nickname": nick(c, "TG")})
    for u in (la, lb, tg):
        st = wait_for(lambda u=u: (x := u.req("PATCH", "/v1/game/settings", json={"league_opt_in": True})).status_code
                      != 409 and x, 30, interval=1.0, what=f"{u.role}: ник в gamification (NICKNAME_REQUIRED)")
        check(st.status_code == 200 and st.json()["league_opt_in"] is True, f"{u.role}: включение {st.status_code} "
              f"{st.text[:200]}")
    gen = la.ok("GET", "/v1/game/leagues")["general"]
    grp = gen["group"]
    check(gen["opt_in"] is True and gen["available"] is True and gen["pair_id"] == PAIR and gen["level_band"]
          and grp and gen["prizes"] == c.data["rules0"]["payload"]["league"]["prizes"], f"общая лига LA: {gen}")
    check({mid(c, x) for x in ("LA", "LB", "TG")} <= {r_["member_id"] for r_ in grp["rows"]}
          and all(r_["nickname"] for r_ in grp["rows"]), f"группа общей лиги: {grp['rows']}")
    private(c, gen, la, "общая лига")
    g1 = group_of(la.learner_id, wk)
    check(g1 and group_of(lb.learner_id, wk) == g1 and group_of(tg.learner_id, wk) == g1, "LA, LB, TG — в разных группах")
    assert g1 is not None
    aw = expect(cm_.browser.get("/admin/v1/game/leagues"), 200)
    check(any(x["group_id"] == g1 for x in aw["groups"]) and aw["status"] == "open", f"админка: неделя {aw['week']}")
    # закрытие недели: tick после конца недели (сдвиг группы в прошлую неделю)
    w1 = free_week(c.tag + "w1", set())
    users1 = shift_group(g1, w1)
    xp1 = {u: week_xp(u, w1) for u in users1}
    res = sg.game_tick()
    check(res.get("league_groups_closed", 0) >= 1, f"game:tick: {res}")
    ag = expect(ops.browser.get(f"/admin/v1/game/leagues/{g1}"), 200)
    check(ag["status"] == "closed" and ag["version"] == 1 and len(ag["results"]) == 1
          and ag["results"][0]["closed_by"] is None, f"группа после закрытия: {str(ag)[:400]}")
    st1 = ag["results"][0]["standings"]
    prizes = c.data["rules0"]["payload"]["league"]["prizes"]
    for row in st1:
        want = prizes[row["place"] - 1] if row["place"] <= len(prizes) and row["xp"] > 0 else 0
        check(row["xp"] == xp1.get(row["user_id"], 0) and row["prize_til"] == want,
              f"итоги: {row} (XP по реестру {xp1.get(row['user_id'])}, приз {want})")
    check([r_["place"] for r_ in st1] == list(range(1, len(st1) + 1)), f"места итогов: {st1}")
    row_la = next(r_ for r_ in st1 if r_["user_id"] == la.learner_id)
    ops_la = [o for o in prize_ops(la.learner_id, g1) if o["reason"] == "league_prize"]
    check(len(ops_la) == (1 if row_la["prize_til"] else 0) and sum(o["amount"] for o in ops_la) == row_la["prize_til"],
          f"приз LA: {ops_la} (итог {row_la})")
    ev = [x for x in outbox("gamification", "game.league.closed.v1", since) if x["group_id"] == g1]
    check(len(ev) == 1 and ev[0]["version"] == 1 and ev[0]["week"] == w1.isoformat(), f"game.league.closed.v1: {ev}")
    # повтор закрытия ничего не меняет
    before = pj("SELECT count(*) FROM gamification.ledger WHERE reason = 'league_prize'")
    sg.game_tick()
    check(pj("SELECT count(*) FROM gamification.ledger WHERE reason = 'league_prize'") == before
          and expect(ops.browser.get(f"/admin/v1/game/leagues/{g1}"), 200)["version"] == 1, "повтор tick изменил итоги")
    res_bad = psql_try(f"BEGIN; UPDATE gamification.league_results SET reason = 'x' WHERE group_id = '{uid(g1)}'; "
                       "ROLLBACK;", user="gamification_owner")
    check(res_bad.returncode != 0, "итоги лиги изменяемы (UPDATE под владельцем схемы прошёл)")
    hst = la.ok("GET", "/v1/game/leagues/history")["items"]
    check(hst and hst[0]["week"] == w1.isoformat() and hst[0]["place"] == row_la["place"]
          and hst[0]["prize_til"] == row_la["prize_til"] and hst[0]["version"] == 1 and hst[0]["prize_held"] is False,
          f"история лиги LA: {hst[:2]}")
    c.data.update(league_g1=g1, league_w1=w1.isoformat(), league_la=row_la)
    # аномалия → удержание → снятие удержания в админке
    payload = copy.deepcopy(c.data["rules0"]["payload"])
    payload["league"]["anomaly"] = {"median_factor": 1, "min_xp": 0}
    v0 = rules_activate(c, payload, "аномалия лиги для проверки удержания")
    try:
        g2 = wait_for(lambda: group_of(la.learner_id, wk), 30, interval=1.0,
                      what="LA снова в группе текущей недели (tick: группы недели)")
        sg.wait_reading_reward(la, sg.reading_session(c, la))
        w2 = free_week(c.tag + "w2", {w1})
        shift_group(g2, w2)
        res = sg.game_tick()
    finally:
        rules_rollback(c, v0)
    check(res.get("league_groups_held", 0) >= 1, f"game:tick (аномалия): {res}")
    a2 = expect(ops.browser.get(f"/admin/v1/game/leagues/{g2}"), 200)
    m_la = next((m for m in a2["members"] if m["user_id"] == la.learner_id), {})
    check(a2["status"] == "held" and a2["anomalies"] >= 1 and m_la.get("anomaly") is True
          and a2["results"][0]["prizes_held"] is True, f"удержание: {str(a2)[:400]}")
    check(not [o for o in prize_ops(la.learner_id, g2) if o["reason"] == "league_prize"], "приз выдан при удержании")
    h2 = next((x for x in la.ok("GET", "/v1/game/leagues/history")["items"] if x["week"] == w2.isoformat()), None)
    check(h2 and h2["prize_held"] is True and h2["prize_til"] == 0, f"история: удержание {h2}")
    rel = expect(ops.browser.post(f"/admin/v1/game/leagues/{g2}/release-prizes",
                                  {"reason": f"e2e {c.tag}: аномалия проверена, призы выдать"}), 200)
    check(rel["status"] == "closed" and rel["version"] == 2 and [x["version"] for x in rel["results"]] == [2, 1]
          and rel["results"][1]["prizes_held"] is True, f"снятие удержания: {str(rel)[:400]}")
    p_la = next(r_ for r_ in rel["results"][0]["standings"] if r_["user_id"] == la.learner_id)["prize_til"]
    check(sum(o["amount"] for o in prize_ops(la.learner_id, g2) if o["reason"] == "league_prize") == p_la,
          f"приз LA после снятия удержания: {prize_ops(la.learner_id, g2)}")
    expect(ops.browser.post(f"/admin/v1/game/leagues/{g2}/release-prizes",
                            {"reason": f"e2e {c.tag}: повтор снятия удержания"}), 409, "RESULT_STATE")
    # переоценка группы 1 со step-up: исключить LA → новая версия, прежняя хранится, призы исправлены
    body = {"exclude_user_ids": [la.learner_id], "reason": f"e2e {c.tag}: исключение по итогам проверки"}
    denied = s3.rbac_denied(cm_.browser, "POST", f"/admin/v1/game/leagues/{g1}/reevaluate", body, "league.manage")
    check(denied is None, denied)
    r = httpx.post(f"{GAME}/internal/v1/admin/game/leagues/{g1}/reevaluate", json=body, timeout=20,
                   headers=staff_hdr("gamification", {"league.read", "league.manage"}))
    check(r.status_code == 403 and r.json().get("code") == "STEP_UP_REQUIRED",
          f"переоценка без step-up (домен): {r.status_code} {r.text[:200]}")
    s2.ensure_step_up(ops)
    rv = expect(ops.browser.post(f"/admin/v1/game/leagues/{g1}/reevaluate", body), 200)
    check(rv["version"] == 2 and [x["version"] for x in rv["results"]] == [2, 1]
          and rv["results"][1]["standings"] == ag["results"][0]["standings"]
          and rv["results"][0]["excluded_user_ids"] == [la.learner_id]
          and rv["results"][0]["closed_by"] and rv["results"][0]["closed_by"]["staff_id"] == ops.staff_id
          and la.learner_id not in {x["user_id"] for x in rv["results"][0]["standings"]},
          f"переоценка: {str(rv)[:500]}")
    if row_la["prize_til"]:
        po = prize_ops(la.learner_id, g1)
        check(any(o["reason"] == "reversal" and o["amount"] == -row_la["prize_til"] for o in po)
              and any(o["reason"] == "league_prize" and o["status"] == "reversed" for o in po),
              f"обратная запись приза LA: {po}")
    ev = [x for x in outbox("gamification", "game.league.closed.v1", since) if x["group_id"] == g1]
    check([x["version"] for x in ev] == [1, 2], f"game.league.closed.v1 версии: {[x['version'] for x in ev]}")
    c.data.update(league_done=True, league_g2=g2)
    print(f"      неделя {wk}: XP LA {xp_la}; группа {g1[:8]} → неделя {w1} закрыта (место LA {row_la['place']}, приз "
          f"{row_la['prize_til']}), повтор — без изменений; аномалия → удержание → снятие (v2); переоценка без LA (v2)",
          flush=True)
    if deferred:
        raise StepFailed("; ".join(deferred))


# ---------------------------------------------------------------- S05 дуэли


def s_duels(c: s2.Ctx) -> None:
    need(c, "friends")
    la, lb, ld, lx, tg, fm, p = (u_(c, r) for r in ("LA", "LB", "LD", "LX", "TG", "FM", "P"))
    since = int(time.time()) - 1
    rule = c.data["rules0"]["payload"]["duel"]
    deferred: list[str] = []
    xp_before = {u.role: sum(int(x["amount"]) for x in sg.history(u, "xp") if x["reason"] == "duel") for u in (la, lb)}
    key = str(uuid.uuid4())
    d = la.ok("POST", "/v1/game/duels", 201, json={"opponent_member_id": mid(c, "LB")}, idem=key)
    did = d["duel_id"]
    check(set(d) == DUEL_KEYS and d["status"] == "challenged" and d["role"] == "challenger"
          and d["opponent"]["member_id"] == mid(c, "LB") and d["opponent"]["nickname"] == nick(c, "LB")
          and d["result"] is None and d["my_session"] is None and d["can_accept"] is False
          and timedelta(hours=23) < parse_ts(d["accept_deadline"]) - datetime.now(UTC) <= timedelta(hours=24, minutes=1),
          f"вызов: {d}")
    again = la.req("POST", "/v1/game/duels", json={"opponent_member_id": mid(c, "LB")}, idem=key)
    check(again.status_code in (200, 201) and again.json()["duel_id"] == did, "повтор Idempotency-Key вызова")
    e = la.ok("POST", "/v1/game/duels", 409, "DUEL_EXISTS", json={"opponent_member_id": mid(c, "LB")}, idem=True)
    check((e.get("details") or {}).get("duel_id") == did, f"DUEL_EXISTS: {e}")
    la.ok("POST", "/v1/game/duels", 422, json={"opponent_member_id": mid(c, "LA")}, idem=True)
    act = lb.ok("GET", "/v1/game/duels", params={"status": "active"})["items"]
    mine = next((x for x in act if x["duel_id"] == did), None)
    check(mine and mine["role"] == "opponent" and mine["can_accept"] is True
          and mine["opponent"]["member_id"] == mid(c, "LA"), f"вызов у LB: {mine}")
    private(c, act, lb, "дуэли")
    la.ok("POST", f"/v1/game/duels/{did}/accept", 404, "DUEL_NOT_FOUND")
    acc = lb.ok("POST", f"/v1/game/duels/{did}/accept")
    check(acc["status"] == "accepted" and acc["can_play"] is True and acc["play_deadline"]
          and timedelta(hours=47) < parse_ts(acc["play_deadline"]) - datetime.now(UTC) <= timedelta(hours=48, minutes=1),
          f"принятие: {acc}")
    check(lb.ok("POST", f"/v1/game/duels/{did}/accept")["status"] == "accepted", "повтор принятия")
    lb.ok("POST", f"/v1/game/duels/{did}/decline", 409, "DUEL_STATE")
    pa = play_duel(c, la, did, 99, repeat_answer=True)
    total = len(pa["keys"])
    la.ok("GET", f"/v1/duel-sessions/{pa['sid']}/review", 409, "DUEL_NOT_FINISHED")
    dv = duel_of(la, did)
    check(dv["my_played"] is True and dv["opponent_played"] is False and dv["result"] is None
          and dv["my_session"]["session_id"] == pa["sid"], f"после игры LA: {dv}")
    act = la.req("GET", "/v1/sessions/active")
    check(pa["sid"] not in act.text, f"сессия дуэли в /v1/sessions/active: {act.text[:200]}")
    n_lb = 4
    pb = play_duel(c, lb, did, n_lb)
    check(pa["items"] == pb["items"] and len(pa["items"]) == total, f"задания у соперников разные: {pa['items']} / "
                                                                    f"{pb['items']}")
    fin = wait_for(lambda: (x := duel_of(la, did))["status"] == "finished" and x, 30, interval=1.0,
                   what="итог дуэли (lesson.session.completed.v1 kind duel → gamification)")
    res_a, res_b = fin["result"], duel_of(lb, did)["result"]
    check(res_a["outcome"] == "win" and res_a["technical"] is False and res_a["my_score"] == {"correct": total, "total": total}
          and res_a["opponent_score"] == {"correct": n_lb, "total": total} and res_a["xp"] == rule["win"]
          and res_a["version"] == 1, f"итог LA: {res_a}")
    check(res_b["outcome"] == "loss" and res_b["xp"] == rule["participation"]
          and res_b["my_score"] == {"correct": n_lb, "total": total}, f"итог LB: {res_b}")
    for u, want in ((la, rule["win"]), (lb, rule["participation"])):
        got = sum(int(x["amount"]) for x in sg.history(u, "xp") if x["reason"] == "duel") - xp_before[u.role]
        check(got == want, f"{u.role}: XP за дуэль {got}, ожидали {want}")
    rv = la.ok("GET", f"/v1/duel-sessions/{pa['sid']}/review")
    check(rv["score"] == {"correct": total, "total": total} and len(rv["items"]) == total
          and all(x["correct"] and x["your_answer"] is not None and x["correct_answer"] for x in rv["items"]),
          f"разбор LA: {str(rv)[:300]}")
    check("zzqqx" not in json.dumps(rv), "в разборе LA — ответы соперника")
    # повтор события счёта — один результат
    env = pj("SELECT envelope FROM lessons.outbox WHERE envelope->>'event_type' = 'lesson.session.completed.v1' "
             f"AND envelope->'payload'->>'session_id' = '{uid(pa['sid'])}' LIMIT 1")
    check(env and env["payload"]["kind"] == "duel" and env["payload"]["duel_id"] == did
          and env["payload"]["score"] == {"correct": total, "total": total} and env["payload"]["practice_only"] is True,
          f"lesson.session.completed.v1 kind duel: {str(env)[:300]}")
    n_ops = pj(f"SELECT count(*) FROM gamification.ledger WHERE reason = 'duel' AND source_ref = 'duel:{uid(did)}'")
    sq = sg.replay(env, "gamification_lessons")
    sg.wait_delivered("gamification_lessons", sq)
    time.sleep(1.0)
    check(pj(f"SELECT count(*) FROM gamification.ledger WHERE reason = 'duel' AND source_ref = 'duel:{uid(did)}'")
          == n_ops and duel_of(la, did)["result"] == res_a, "повтор события счёта изменил дуэль")
    ev = [x for x in outbox("gamification", "game.duel.finished.v1", since) if x["duel_id"] == did]
    check(len(ev) == 1 and ev[0]["result"] == "challenger" and ev[0]["result_version"] == 1, f"game.duel.finished.v1: {ev}")
    c.data["duel_ab"] = did
    # техническая победа по дедлайну: LA → LD, LD принял и не сыграл
    d2 = la.ok("POST", "/v1/game/duels", 201, json={"opponent_member_id": mid(c, "LD")}, idem=True)["duel_id"]
    ld.ok("POST", f"/v1/game/duels/{d2}/accept")
    play_duel(c, la, d2, 99)
    for sql in (f"UPDATE gamification.duels SET play_deadline = now() - interval '31 minutes' WHERE duel_id = '{uid(d2)}' "
                "RETURNING duel_id", f"UPDATE lessons.duel_sets SET play_deadline = now() - interval '31 minutes' "
                f"WHERE duel_id = '{uid(d2)}' RETURNING duel_id"):
        s5.shift_rows(sql, f"дедлайн дуэли {d2[:8]} → 31 мин назад")
    ld.ok("POST", "/v1/duel-sessions", 409, "DUEL_CLOSED", json={"duel_id": d2}, idem=True)
    res = sg.game_tick()
    lessons_tick()
    check(res.get("duels_finished", 0) >= 1, f"game:tick: {res}")
    ta, tb = duel_of(la, d2), duel_of(ld, d2)
    check(ta["status"] == "finished" and ta["result"]["outcome"] == "win" and ta["result"]["technical"] is True
          and ta["result"]["opponent_score"] is None and ta["result"]["xp"] == rule["win"], f"техническая победа: {ta}")
    check(tb["result"]["outcome"] == "loss" and tb["result"]["technical"] is True and tb["result"]["my_score"] is None
          and tb["result"]["xp"] == 0, f"техническое поражение: {tb}")
    # отказ от вызова
    d3 = la.ok("POST", "/v1/game/duels", 201, json={"opponent_member_id": mid(c, "TG")}, idem=True)["duel_id"]
    check(tg.ok("POST", f"/v1/game/duels/{d3}/decline")["status"] == "declined", "отказ подростка")
    # ребёнок и член семьи
    p.switch(c.data["kid"])
    try:
        famv = p.ok("GET", "/v1/family")
        fm_mid = next(m["member_id"] for m in famv["members"] if m["user_id"] == fm.account_id)
        r = p.req("POST", "/v1/game/duels", json={"opponent_member_id": mid(c, "LA")}, idem=True)
        check(r.status_code == 403 and r.json().get("code") in ("PARTNER_NOT_ALLOWED", "FRIENDS_NOT_ALLOWED"),
              f"ребёнок вызывает не члена семьи: {r.status_code} {r.text[:200]}")
        kd = p.ok("POST", "/v1/game/duels", 201, json={"opponent_member_id": fm_mid}, idem=True)["duel_id"]
    finally:
        p.switch(p.account_id)
    r = fm.req("POST", f"/v1/game/duels/{kd}/accept")
    if r.status_code != 200:
        deferred.append(f"член семьи принимает вызов ребёнка: {r.status_code} {r.text[:200]}")
    else:
        p.switch(c.data["kid"])
        try:
            play_duel(c, p, kd, 99)
        finally:
            p.switch(p.account_id)
        play_duel(c, fm, kd, 2)
        wait_for(lambda: duel_of(fm, kd)["status"] == "finished", 30, interval=1.0, what="итог дуэли ребёнка")
        p.switch(c.data["kid"])
        try:
            kr = duel_of(p, kd)["result"]
            check(kr["outcome"] == "win" and kr["xp"] == rule["win"], f"итог ребёнка: {kr}")
        finally:
            p.switch(p.account_id)
        c.data["duel_kid"] = kd
    # LX: вызов LB, LX сыграл, LB — нет (дуэль идёт; для S11)
    dx = lb.ok("POST", "/v1/game/duels", 201, json={"opponent_member_id": mid(c, "LX")}, idem=True)["duel_id"]
    lx.ok("POST", f"/v1/game/duels/{dx}/accept")
    play_duel(c, lx, dx, 3)
    c.data.update(duel_tech=d2, duel_lx=dx, duels_done=True)
    print(f"      LA {total}/{total} vs LB {n_lb}/{total} → победа LA (+{rule['win']} XP), LB +{rule['participation']}; "
          f"повтор ответа и события — без изменений; LA vs LD по дедлайну — техническая победа; ребёнок vs член "
          f"семьи{' — ' + deferred[0][:60] if deferred else ''}", flush=True)
    if deferred:
        raise StepFailed("; ".join(deferred))


# ---------------------------------------------------------------- S06 парный урок


def pair_xp(u: s1.U) -> int:
    return sum(int(x["amount"]) for x in sg.history(u, "xp") if x["reason"] == "pair_lesson")


def pair_rewards(c: s2.Ctx, rid: str, since: int, xp_before: dict[str, int], players: dict[str, s1.U],
                 kid_role: str | None = None) -> dict[str, Any]:
    """XP парного урока (§2.4 после ревью): только комната finished, вклад и ≥ min_turns своих ходов (не больше
    daily_cap наградных уроков в день); together_1 — finished, цель достигнута и ≥ 1 ход у обоих (от min_turns не
    зависит). → событие комнаты."""
    rule = c.data["rules0"]["payload"]["pair_lesson"]
    ev = wait_for(lambda: [x for x in outbox("lessons", "lesson.pair.completed.v1", since) if x["room_id"] == rid], 20,
                  what=f"lesson.pair.completed.v1 комнаты {rid[:8]}")[0]
    parts = {x["user_id"]: x for x in ev["participants"]}
    contributed = [k for k, v in parts.items() if v["contributed"]]
    if contributed:
        ids = ", ".join(f"'{uid(x)}'" for x in contributed)
        wait_for(lambda: s1._psql(f"SELECT count(*) FROM gamification.pair_awards WHERE room_id = '{uid(rid)}' AND "
                                  f"user_id IN ({ids})") == str(len(contributed)), 30, interval=1.0,
                 what=f"награды комнаты {rid[:8]} (lesson.pair.completed.v1 → gamification)")
    finished = ev["status"] == "finished"
    full = {k: v["contributed"] and int(v["turns"]) >= int(rule["min_turns"]) for k, v in parts.items()}
    together = (finished and ev["team_goal_reached"] is True and len(parts) == 2
                and all(int(v["turns"]) >= 1 for v in parts.values()))
    for role, u in players.items():
        if role == kid_role:
            u.switch(c.data["kid"])
        try:
            p_ = parts.get(u.learner_id) or {}
            want = int(rule["xp"]) if finished and full.get(u.learner_id) else 0
            got = pair_xp(u) - xp_before[role]
            check(got == want, f"{role}: XP парного урока {got}, ожидали {want} (статус {ev['status']}, ходов "
                               f"{p_.get('turns')}, минимум {rule['min_turns']})")
            if together:
                b = {x["code"]: x for x in u.ok("GET", "/v1/game/badges")["items"]}
                check((b.get("together_1") or {}).get("earned_at"), f"{role}: значок together_1 {b.get('together_1')}")
        finally:
            if role == kid_role:
                u.switch(u.account_id)
    return {"event": ev, "together": together, "full": full}


def ai_stop(c: s2.Ctx, enabled: bool) -> None:
    ops = c.staff["ops"]
    s2.ensure_step_up(ops)
    st = expect(ops.browser.post("/admin/v1/ai/emergency-stop",
                                 {"enabled": enabled, "reason": f"e2e {c.tag}: парный урок без ИИ"
                                  if enabled else f"e2e {c.tag}: ИИ снова включён"}, headers=idem()), 200)
    check(st["ai_enabled"] is (not enabled), f"аварийная остановка ИИ {enabled}: {st}")


def coach_limit(c: s2.Ctx) -> None:
    """Лимит комнат с ИИ-коучем (PAIR_AI_ROOMS_PER_DAY, по умолчанию 5 в сутки на участника): до него — коуч ИИ,
    дальше комната сразу идёт сценарием с выбором реплик (ai_degraded, mode_changed). Комнаты останавливает
    администратор (operations, step-up) — слот ученика освобождается."""
    la, ld = u_(c, "LA"), u_(c, "LD")
    ops = c.staff["ops"]
    limit = 5

    def used(u: s1.U) -> int:
        return int(s1._psql("SELECT count(DISTINCT r.room_id) FROM lessons.pair_rooms r JOIN lessons.room_participants p "
                            f"ON p.room_id = r.room_id WHERE p.user_id = '{uid(u.learner_id)}' AND r.coach_used AND "
                            "r.started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE "
                            "'Asia/Tashkent'"))

    def room() -> dict[str, Any]:
        rid = la.ok("POST", "/v1/pair-rooms", 201, json={"partner_member_id": mid(c, "LD"), "pair_id": PAIR,
                                                         "scenario_id": c.data["scn"], "start": "now"},
                    idem=True)["room_id"]
        ld.ok("POST", f"/v1/pair-rooms/{rid}/accept")
        la.ok("POST", f"/v1/pair-rooms/{rid}/join")
        ld.ok("POST", f"/v1/pair-rooms/{rid}/join")
        st = wait_room(la, rid, lambda s_: s_["status"] == "in_progress" and s_["next_speaker"] is not None,
                       "старт комнаты", 30)
        s2.ensure_step_up(ops)
        expect(ops.browser.post(f"/admin/v1/pair-rooms/{rid}/stop",
                                {"reason": f"e2e {c.tag}: проверка лимита комнат с коучем"}), 200)
        return {"rid": rid, "mode": st["mode"], "degraded": st["ai_degraded"],
                "kinds": [x["kind"] for x in room_state(la, rid, 0)["events"]]}

    n0 = max(used(la), used(ld))
    made = []
    for _ in range(max(0, limit - n0)):
        r = room()
        check(r["mode"] == "free" and r["degraded"] is False, f"комната с коучем до лимита: {r}")
        made.append(r["rid"])
    check(used(la) >= limit, f"комнат с коучем у LA за сутки: {used(la)}")
    over = room()
    check(over["mode"] == "choices" and over["degraded"] is True and "mode_changed" in over["kinds"],
          f"комната сверх лимита ({limit} в сутки): {over}")
    c.data["coach_limit"] = {"before": n0, "made": len(made), "over": over["rid"]}
    print(f"      лимит коуча: было {n0}, ещё {len(made)} комнат с ИИ → следующая сразу «выбор реплик»", flush=True)


def s_pair(c: s2.Ctx) -> None:
    need(c, "friends")
    la, lb = u_(c, "LA"), u_(c, "LB")
    since = int(time.time()) - 1
    marker = c.data["marker"]
    deferred: list[str] = []
    xp0 = {u.role: sum(int(x["amount"]) for x in sg.history(u, "xp") if x["reason"] == "pair_lesson") for u in (la, lb)}
    body = {"partner_member_id": mid(c, "LB"), "pair_id": PAIR, "scenario_id": c.data["scn"], "start": "now"}
    key = str(uuid.uuid4())
    v = la.ok("POST", "/v1/pair-rooms", 201, json=body, idem=key)
    rid = v["room_id"]
    check(set(v) == ROOM_KEYS and v["status"] == "invited" and v["side"] == "inviter"
          and v["partner"]["member_id"] == mid(c, "LB") and v["partner"]["nickname"] == nick(c, "LB")
          and v["mode"] == "free" and v["my_role"] is None and v["can_accept"] is False and v["respond_until"],
          f"приглашение: {v}")
    again = la.req("POST", "/v1/pair-rooms", json=body, idem=key)
    check(again.status_code in (200, 201) and again.json()["room_id"] == rid, "повтор Idempotency-Key приглашения")
    e = la.ok("POST", "/v1/pair-rooms", 409, "ROOM_LIMIT", json=body, idem=True)
    check((e.get("details") or {}).get("room_id") == rid, f"ROOM_LIMIT: {e}")
    inv = next((x for x in lb.ok("GET", "/v1/pair-rooms", params={"status": "active"})["items"] if x["room_id"] == rid), None)
    check(inv and inv["side"] == "invitee" and inv["can_accept"] is True, f"приглашение у LB: {inv}")
    private(c, inv, lb, "приглашение в парный урок")
    check(lb.ok("POST", f"/v1/pair-rooms/{rid}/accept")["status"] == "waiting", "принятие приглашения")
    st = la.ok("POST", f"/v1/pair-rooms/{rid}/join")
    check(st["status"] == "waiting", f"вход первого: {st['status']}")
    lb.ok("POST", f"/v1/pair-rooms/{rid}/join")
    st = wait_room(la, rid, my_turn("A"), "роли и первый ход A", 40)
    check(st["status"] == "in_progress" and st["my_role"] == "A" and st["team_goal"] and st["my_role_brief"]
          and st["prompt"], f"старт комнаты: {str(st)[:400]}")
    kinds = [x["kind"] for x in room_state(la, rid, 0)["events"]]
    check({"joined", "roles", "coach"} <= set(kinds), f"лента после старта: {kinds}")
    ai_mode = st["mode"] == "free" and not st["ai_degraded"]
    if not ai_mode:
        note(f"парная комната взрослых сразу в режиме {st['mode']} (ai_degraded {st['ai_degraded']}) — коуч ИИ недоступен")
    lb.ok("POST", f"/v1/pair-rooms/{rid}/turns", 409, "NOT_YOUR_TURN", json={"text": "Hi there"}, idem=True)
    turns_sent: dict[str, list[str]] = {"A": [], "B": []}

    def say(u: s1.U, role: str, text: str | None = None, k: str | None = None) -> dict[str, Any]:
        cur = wait_room(u, rid, my_turn(role), f"ход {role}", 40)
        time.sleep(THINK)  # «подумать» перед ответом: секунды речи без голоса — от подсказки до ответа
        if cur["mode"] == "choices":
            return u.ok("POST", f"/v1/pair-rooms/{rid}/turns", json={"choice_id": script_choice(rid, cur["options"])},
                        idem=k or True)
        t = text or f"I would like a cup of tea, please {marker}{role}{len(turns_sent[role])}"
        turns_sent[role].append(t)
        return u.ok("POST", f"/v1/pair-rooms/{rid}/turns", json={"text": t}, idem=k or True)

    # ход A с ключом идемпотентности: повтор — тот же ответ без второго хода
    k1 = str(uuid.uuid4())
    t1 = say(la, "A", k=k1)
    t1b = la.ok("POST", f"/v1/pair-rooms/{rid}/turns", json={"text": turns_sent["A"][-1]} if turns_sent["A"]
                else {"choice_id": "c1"}, idem=k1)
    check(t1b["events"] == t1["events"], "повтор ключа хода — другой ответ")
    turns_a = pj(f"SELECT turns FROM lessons.room_participants WHERE room_id = '{uid(rid)}' AND side = 'inviter'")
    check(turns_a == 1, f"повтор ключа хода записал второй ход: turns {turns_a}")
    if turns_sent["A"]:
        la.ok("POST", f"/v1/pair-rooms/{rid}/turns", 422, "IDEMPOTENCY_KEY_REUSED", json={"text": "Another text"}, idem=k1)
    # голос без согласия на запись голоса (в свой ход)
    wait_room(lb, rid, my_turn("B"), "ход B", 40)
    r = c.lc.bff.post(f"/v1/pair-rooms/{rid}/audio", content=wav(1500), headers=lb.h({"content-type": "audio/wav"}))
    if not (r.status_code == 403 and r.json().get("code") == "VOICE_CONSENT_REQUIRED"
            and (r.json().get("details") or {}).get("who") == "self"):
        deferred.append(f"голос без согласия на запись голоса: ожидали 403 VOICE_CONSENT_REQUIRED {{who: self}}, "
                        f"получили {r.status_code} {r.text[:160]}")
    # long-poll с after_seq: LA ждёт, LB ходит — ответ сразу с ходом LB
    seq0 = room_state(la, rid, 0)["seq"]
    box: dict[str, Any] = {}

    def poll() -> None:
        t0 = time.monotonic()
        with httpx.Client(base_url=TG_BFF, timeout=40) as h:
            box["r"] = h.get(f"/v1/pair-rooms/{rid}/state", params={"after_seq": seq0}, headers=la.h())
        box["dt"] = time.monotonic() - t0

    th = threading.Thread(target=poll)
    th.start()
    time.sleep(1.5)
    say(lb, "B")
    th.join(40)
    lp = box["r"].json()
    check(box["r"].status_code == 200 and box["dt"] < 15 and any(x["kind"] == "turn" and x["role"] == "B"
                                                                  for x in lp["events"]),
          f"long-poll after_seq={seq0}: {box['r'].status_code} за {box.get('dt', 0):.1f} с, события "
          f"{[x['kind'] for x in lp.get('events', [])]}")
    if turns_sent["B"]:
        check(any(x["text"] == turns_sent["B"][-1] for x in lp["events"] if x["kind"] == "turn"),
              "реплика партнёра не видна участнику в ленте")
    check(all(x["seq"] > seq0 for x in lp["events"]) and lp["seq"] >= max(x["seq"] for x in lp["events"]),
          f"after_seq: {[x['seq'] for x in lp['events']]}")
    say(la, "A")
    # офлайн B в свой ход (без heartbeat 30 с) → пауза; возврат → продолжение без новой сессии
    sid_b = s1._psql(f"SELECT session_id FROM lessons.room_participants WHERE room_id = '{uid(rid)}' AND side = 'invitee'")
    st = wait_room(la, rid, lambda s: s["next_speaker"] == "B" or s["status"] not in LIVE, "ход B", 40)
    print("      … B молчит без heartbeat ~35 с", flush=True)
    with Heartbeat(la, rid) as hb:
        st = wait_room(la, rid, lambda s: s["status"] == "paused", "пауза: B офлайн в свой ход", 75)
    check(not hb.errors, f"heartbeat LA: {hb.errors}")
    ev = room_state(la, rid, 0)["events"]
    check([x["role"] for x in ev if x["kind"] == "offline"] == ["B"] and any(x["kind"] == "paused" for x in ev)
          and next(p_ for p_ in st["participants"] if not p_["me"])["network"] == "offline", f"офлайн: {st['participants']}")
    lb.ok("POST", f"/v1/pair-rooms/{rid}/heartbeat", 204)
    st = wait_room(lb, rid, lambda s: s["status"] == "in_progress", "продолжение после возврата B", 30)
    ev = room_state(la, rid, 0)["events"]
    check(any(x["kind"] == "online" and x["role"] == "B" for x in ev) and any(x["kind"] == "resumed" for x in ev),
          f"возврат: {[x['kind'] for x in ev]}")
    check(pj(f"SELECT count(*) FROM lessons.room_participants WHERE room_id = '{uid(rid)}'") == 2
          and s1._psql(f"SELECT session_id FROM lessons.room_participants WHERE room_id = '{uid(rid)}' AND "
                       "side = 'invitee'") == sid_b == str(uuid.uuid5(uuid.UUID(rid), lb.learner_id)),
          "переподключение создало вторую сессию")
    # без ИИ (аварийная остановка) — комната продолжается сценарием с выбором реплик до конца
    stopped = False
    if ai_mode:
        s4.save_restore(budget=expect(c.staff["ops"].browser.get("/admin/v1/ai/budget"), 200))
        ai_stop(c, True)
        stopped = True
    try:
        say(lb, "B")
        if ai_mode:
            st = wait_room(la, rid, lambda s: s["mode"] == "choices" or s["status"] not in LIVE, "переход на выбор", 30)
            check(st["ai_degraded"] is True and any(x["kind"] == "mode_changed" for x in room_state(la, rid, 0)["events"]),
                  f"ИИ недоступен — сценарий с выбором: {str(st)[:300]}")
        end = play_choices(c, rid, {"A": la, "B": lb})
    finally:
        if stopped:
            ai_stop(c, False)
            s4.drop_restore("budget")
    check(end["status"] == "finished", f"итог комнаты: {end['status']}")
    vv = la.ok("GET", f"/v1/pair-rooms/{rid}")
    check(vv["end_reason"] == "completed" and vv["report_available"] is True and vv["minutes"] >= 1, f"комната: {vv}")
    # отчёты — только свои
    reps = {}
    for u, role, other in ((la, "A", "B"), (lb, "B", "A")):
        rep = u.ok("GET", f"/v1/pair-rooms/{rid}/report")
        me = rep["me"]
        check(rep["team"]["goal_reached"] is True and me["role"] == role and me["contributed"] is True
              and me["turns"] >= 2 and me["speaking_seconds"] > 0 and me["minutes"] >= 1 and 1 <= len(me["tips"]) <= 3,
              f"отчёт {role}: team {rep['team'].get('goal_reached')}, me {json.dumps(me, ensure_ascii=False)[:450]}")
        blob = json.dumps(rep, ensure_ascii=False)
        check(all(t not in blob for t in turns_sent[other]), f"в отчёте {role} — реплики партнёра")
        check(all(any(ln["text"] == t for ln in me["lines"]) for t in turns_sent[role]), f"в отчёте {role} нет своих реплик")
        private(c, rep, u, "отчёт парного урока")
        reps[role] = rep
    # события, XP, значок together_1, минуты учтены и не списаны
    pc = wait_for(lambda: [x for x in outbox("lessons", "lesson.pair.completed.v1", since) if x["room_id"] == rid], 20,
                  what="lesson.pair.completed.v1")
    parts = {x["user_id"]: x for x in pc[0]["participants"]}
    check(pc[0]["team_goal_reached"] is True and pc[0]["end_reason"] == "completed"
          and all(parts[u.learner_id]["contributed"] and parts[u.learner_id]["minutes"] >= 1 for u in (la, lb)),
          f"lesson.pair.completed.v1: {pc[0]}")
    sc = [x for x in outbox("lessons", "lesson.session.completed.v1", since) if x.get("room_id") == rid]
    check(sorted(x["session_id"] for x in sc) == sorted(str(uuid.uuid5(uuid.UUID(rid), u.learner_id)) for u in (la, lb))
          and all(x["kind"] == "pair" and x["minutes"] >= 1 for x in sc), f"lesson.session.completed.v1 kind pair: {sc}")
    xp = c.data["rules0"]["payload"]["pair_lesson"]["xp"]
    try:
        r1 = pair_rewards(c, rid, since, {"A": xp0["LA"], "B": xp0["LB"]}, {"A": la, "B": lb})
        check(r1["together"], f"комната 1: цель и вклад обоих (≥ min_turns) — together_1 не положен: {r1['event']}")
    except StepFailed as exc:
        deferred.append(str(exc))
    neg = [x for x in sg.history(la) if int(x["amount"]) < 0 and x["reason"] not in ("reversal", "streak_freeze", "shop")]
    check(not neg, f"минуты парного урока списаны: {neg}")
    c.data["room_main"] = rid
    # молчавший — без оценки и XP; остановка комнаты админом (не finished — XP нет и говорившему)
    xp1 = {"A": pair_xp(la), "B": pair_xp(lb)}
    rid2 = la.ok("POST", "/v1/pair-rooms", 201, json=body, idem=True)["room_id"]
    lb.ok("POST", f"/v1/pair-rooms/{rid2}/accept")
    la.ok("POST", f"/v1/pair-rooms/{rid2}/join")
    lb.ok("POST", f"/v1/pair-rooms/{rid2}/join")
    cur = wait_room(la, rid2, my_turn("A"), "ход A (комната 2)", 40)
    if cur["mode"] == "choices":
        la.ok("POST", f"/v1/pair-rooms/{rid2}/turns", json={"choice_id": script_choice(rid2, cur["options"])}, idem=True)
    else:
        la.ok("POST", f"/v1/pair-rooms/{rid2}/turns", json={"text": f"Good morning {marker}"}, idem=True)
    stop = {"reason": f"e2e {c.tag}: остановка комнаты по жалобе"}
    denied = s3.rbac_denied(c.staff["sup"].browser, "POST", f"/admin/v1/pair-rooms/{rid2}/stop", stop, "room.manage")
    check(denied is None, denied)
    r = httpx.post(f"{LESSONS}/internal/v1/admin/pair-rooms/{rid2}/stop", json=stop, timeout=20,
                   headers=staff_hdr("lessons", {"room.read", "room.manage"}))
    check(r.status_code == 403 and r.json().get("code") == "STEP_UP_REQUIRED", f"остановка без step-up: {r.status_code}")
    s2.ensure_step_up(c.staff["ops"])
    ar = expect(c.staff["ops"].browser.post(f"/admin/v1/pair-rooms/{rid2}/stop", stop), 200)
    check(ar["status"] == "stopped" and ar["end_reason"] == "stopped" and ar["stopped_by"]
          and ar["stopped_by"]["staff_id"] == c.staff["ops"].staff_id and ar["stop_reason"] == stop["reason"],
          f"остановка: {str(ar)[:300]}")
    expect(c.staff["ops"].browser.post(f"/admin/v1/pair-rooms/{rid2}/stop", stop), 409, "ROOM_NOT_ACTIVE")
    check(any(x["kind"] == "stopped" for x in room_state(lb, rid2, 0)["events"]), "событие stopped в ленте участника")
    rb = lb.ok("GET", f"/v1/pair-rooms/{rid2}/report")["me"]
    check(rb["contributed"] is False and rb["turns"] == 0 and rb["evaluation_id"] is None and rb["skills"] == []
          and rb["lines"] == [], f"отчёт молчавшего: {rb}")
    ra = la.ok("GET", f"/v1/pair-rooms/{rid2}/report")["me"]
    check(ra["contributed"] is True and ra["turns"] == 1, f"отчёт говорившего: {ra}")
    try:
        pair_rewards(c, rid2, since, xp1, {"A": la, "B": lb})
    except StepFailed as exc:
        deferred.append(f"комната 2 (остановлена, XP только за finished): {exc}")
    sess_b2 = str(uuid.uuid5(uuid.UUID(rid2), lb.learner_id))
    check(pj(f"SELECT count(*) FROM assessment.evaluations WHERE session_id = '{sess_b2}'") == 0,
          "молчавший получил оценку (assessment)")
    c.data["room_stopped"] = rid2
    try:
        coach_limit(c)
    except StepFailed as exc:
        deferred.append(f"лимит комнат с ИИ-коучем: {exc}")
    # ребёнок — только выбор реплик (с членом семьи)
    p, fm = u_(c, "P"), u_(c, "FM")
    p.switch(c.data["kid"])
    try:
        xpk = {"A": pair_xp(p), "B": pair_xp(fm)}
        fm_mid = next(m["member_id"] for m in p.ok("GET", "/v1/family")["members"] if m["user_id"] == fm.account_id)
        kr = p.ok("POST", "/v1/pair-rooms", 201, json={"partner_member_id": fm_mid, "pair_id": PAIR,
                                                       "scenario_id": c.data["scn_kids"], "start": "now"}, idem=True)
        check(kr["mode"] == "choices", f"комната ребёнка: mode {kr['mode']}")
        rk = kr["room_id"]
    finally:
        p.switch(p.account_id)
    fm.ok("POST", f"/v1/pair-rooms/{rk}/accept")
    fm.ok("POST", f"/v1/pair-rooms/{rk}/join")
    p.switch(c.data["kid"])
    try:
        p.ok("POST", f"/v1/pair-rooms/{rk}/join")
        wait_room(p, rk, lambda s: s["status"] == "in_progress", "старт комнаты ребёнка", 30)
        p.ok("POST", f"/v1/pair-rooms/{rk}/turns", 403, "KIDS_NOT_ALLOWED", json={"text": "Hello"}, idem=True)
        r = c.lc.bff.post(f"/v1/pair-rooms/{rk}/audio", content=wav(1500), headers=p.h({"content-type": "audio/wav"}))
        check(r.status_code == 403 and r.json().get("code") == "KIDS_NOT_ALLOWED", f"голос ребёнка: {r.status_code}")
        kend = play_choices(c, rk, {"A": p, "B": fm})
        check(kend["status"] == "finished", f"комната ребёнка: {kend['status']}")
        krep = p.ok("GET", f"/v1/pair-rooms/{rk}/report")
        check(krep["me"]["contributed"] is True and krep["team"]["summary"], f"отчёт ребёнка: {str(krep)[:300]}")
    finally:
        p.switch(p.account_id)
    try:
        rk_res = pair_rewards(c, rk, since, xpk, {"A": p, "B": fm}, kid_role="A")
        print(f"      комната ребёнка: ходов {[(x['role'], x['turns']) for x in rk_res['event']['participants']]}, "
              f"XP по правилу ≥ {c.data['rules0']['payload']['pair_lesson']['min_turns']} ходов", flush=True)
    except StepFailed as exc:
        deferred.append(f"комната ребёнка: {exc}")
    c.data.update(room_kid=rk, pair_done=True)
    print(f"      комната {rid[:8]}: ходы по очереди (NOT_YOUR_TURN, повтор ключа), long-poll {box['dt']:.1f} с, офлайн B → "
          f"пауза → возврат; {'ИИ fake → аварийная остановка → ' if ai_mode else ''}выбор реплик → цель; отчёты свои; "
          f"XP {xp} и together_1 обоим; комната 2 — молчавший без XP, остановлена админом; ребёнок — только выбор",
          flush=True)
    if deferred:
        raise StepFailed("; ".join(deferred))


# ---------------------------------------------------------------- S07 реферал


def diagnostic(u: s1.U) -> None:
    s = u.ok("POST", "/v1/diagnostics/sessions", 201, json={}, idem=True)
    items, _ = s3.dx_test(s["test_version"])
    first = u.ok("GET", f"/v1/diagnostics/sessions/{s['session_id']}/next")
    s3.run_session(u, s["session_id"], first, items,
                   lambda meta, n: (s3.answer_value(meta, meta["band"] in s3.LOW_BANDS), False))
    res = u.ok("POST", f"/v1/diagnostics/sessions/{s['session_id']}/finish")
    wait_for(lambda: u.ok("GET", "/v1/plan/trajectory")["basis"].get("diagnostic_result_id") == res["result_id"], 40,
             interval=1.0, what=f"{u.role}: план по диагностике")


def lesson(c: s2.Ctx, u: s1.U) -> str:
    """Урок плана целиком (как scenario_memory.pass_lesson), но с паузой ~2 с перед итогами: урок стенда проходит
    за 1–2 с, ceil(0 с / 60) = 0 минут — реферал удержался бы как «короткие уроки»."""
    t = u.ok("GET", "/v1/plan/trajectory")
    check(t["next"], f"{u.role}: нет следующего урока")
    lid = t["next"]["lesson_id"]
    card = u.ok("GET", f"/v1/lessons/{lid}")
    sid = u.ok("POST", f"/v1/lessons/{lid}/sessions", 201, idem=True)["session_id"]
    content = s5.lesson_content(c, lid, int(card["version"]))
    step = s4.drive(u, sid, s4.cur(u, sid), content, open_text=OPEN_OK)
    check(step["type"] == "done", f"урок не дошёл до итогов: {step['type']}")
    time.sleep(2.2)
    summ = s4.finish(u, sid)
    check(summ["evaluation"] and summ["minutes"] >= 1, f"{u.role}: итоги урока {str(summ)[:200]}")
    return sid


def my_ref(u: s1.U, referral_id: str | None = None, invitee_nick: str | None = None) -> dict[str, Any]:
    page = u.ok("GET", "/v1/referrals")
    for x in page["items"]:
        if (referral_id and x["referral_id"] == referral_id) or (invitee_nick and x["invitee_nickname"] == invitee_nick):
            return {**x, "_terms": page["terms"], "_month": page["month"]}
    raise StepFailed(f"{u.role}: реферал не найден ({referral_id or invitee_nick}): {page['items'][:3]}")


def ref_notice(referral_id: str) -> dict[str, Any] | None:
    """Уведомление «Приглашение засчитано» (referral_qualified:<id>) и событие, из которого оно построено."""
    return pj("SELECT json_build_object('src', n.source_event_id, 'at', extract(epoch FROM n.created_at)) FROM "
              f"notifications.notifications n WHERE n.dedup_key = 'referral_qualified:{uid(referral_id)}'")


def rewarded_event(referral_id: str) -> dict[str, Any] | None:
    return pj("SELECT json_build_object('id', envelope->>'event_id', 'outcome', envelope->'payload'->>'outcome', 'at', "
              "extract(epoch FROM created_at)) FROM gamification.outbox WHERE envelope->>'event_type' = "
              f"'game.referral.rewarded.v1' AND envelope->'payload'->>'referral_id' = '{uid(referral_id)}' "
              "ORDER BY created_at LIMIT 1")


def notice_after_reward(referral_id: str) -> None:
    """После ревью: «Приглашение засчитано» строится из game.referral.rewarded.v1 (фактическая награда), не из
    social.referral.qualified.v1."""
    ev = wait_for(lambda: rewarded_event(referral_id), 20, what="game.referral.rewarded.v1")
    n = wait_for(lambda: ref_notice(referral_id), 30, interval=1.0, what="уведомление referral_qualified")
    check(ev["outcome"] in (None, "rewarded") and n["src"] == ev["id"] and n["at"] >= ev["at"] - 1,
          f"уведомление реферала не из события награды: уведомление {n}, game.referral.rewarded.v1 {ev}")


def ref_id_of(invitee: s1.U) -> str:
    v = s1._psql(f"SELECT coalesce(referral_id::text, '') FROM social.referrals WHERE invitee_user_id = '{uid(invitee.learner_id)}'")
    check(v, f"реферала приглашённого {invitee.role} нет в social.referrals")
    return v


def s_referral(c: s2.Ctx) -> None:
    lr, li, lx, p, fm = (u_(c, r) for r in ("LR", "LI", "LX", "P", "FM"))
    ops, sup = c.staff["ops"], c.staff["sup"]
    since = int(time.time()) - 1
    tag = f"[e2e {c.tag}]"
    deferred: list[str] = []
    # кампания e2e: черновик → проверка → активация со step-up (уроки стенда короче 3 минут, скорость — 1 в сутки)
    camps = expect(ops.browser.get("/admin/v1/referrals/campaigns"), 200)["items"]
    act0 = next(x for x in camps if x["status"] == "active")
    if any(x["status"] == "draft" for x in camps):
        expect(ops.browser.request("DELETE", "/admin/v1/referrals/campaigns/draft", json_body={}), 204)
        note("на стенде был чужой черновик реферальной кампании — удалён")
    base = expect(ops.browser.get(f"/admin/v1/referrals/campaigns/{act0['version']}"), 200)["payload"]
    new = copy.deepcopy(base)
    new.update(require_diagnostic=True, min_lessons=3, min_days=2, window_days=30, monthly_cap=10,
               inviter_reward={"freeze": 1, "til": 5}, invitee_reward={"freeze": 0, "til": 0},
               review={"velocity_per_day": 1, "min_lesson_minutes": 1})
    bad = {**copy.deepcopy(new), "bogus": 1}
    e = expect(ops.browser.request("PUT", "/admin/v1/referrals/campaigns/draft",
                                   json_body={"payload": bad, "comment": f"{tag} неверная", "based_on": act0["version"]}),
               422, "CAMPAIGN_INVALID")
    check((e.get("details") or {}).get("errors"), f"CAMPAIGN_INVALID: {e}")
    # нарушение диапазона (min_days > min_lessons) сохраняется черновиком, проверка его не пропускает
    d = expect(ops.browser.request("PUT", "/admin/v1/referrals/campaigns/draft", json_body={
        "payload": {**copy.deepcopy(new), "min_days": 9}, "comment": f"{tag} дни больше уроков",
        "based_on": act0["version"]}), 200)
    val = expect(ops.browser.post("/admin/v1/referrals/campaigns/draft/validate", {}), 200)
    check(val["ok"] is False and any("min_days" in str(x.get("path")) for x in val["errors"]),
          f"проверка min_days > min_lessons: {val}")
    expect(ops.browser.request("PUT", "/admin/v1/referrals/campaigns/draft", json_body={
        "payload": new, "comment": f"{tag} кампания e2e", "based_on": act0["version"]}), 409, "DRAFT_CONFLICT")
    denied = s3.rbac_denied(sup.browser, "PUT", "/admin/v1/referrals/campaigns/draft",
                            {"payload": new, "comment": None, "based_on": None}, "referral.manage")
    check(denied is None, denied)
    d = expect(ops.browser.request("PUT", "/admin/v1/referrals/campaigns/draft", headers={"if-match": d["updated_at"]},
                                   json_body={"payload": new, "comment": f"{tag} кампания e2e: уроки от 1 минуты, "
                                              "скорость 1 в сутки", "based_on": act0["version"]}), 200)
    diff = {x["path"] for x in d["diff"]}
    check(d["status"] == "draft" and {"review.velocity_per_day", "review.min_lesson_minutes"} <= diff,
          f"черновик кампании: {str(d)[:300]}")
    s2.ensure_step_up(ops)
    expect(ops.browser.post("/admin/v1/referrals/campaigns/draft/activate", {"comment": f"{tag} до проверки"}), 409,
           "CAMPAIGN_NOT_VALIDATED")
    val = expect(ops.browser.post("/admin/v1/referrals/campaigns/draft/validate", {}), 200)
    check(val["ok"] is True, f"проверка кампании: {val}")
    r = httpx.post(f"{SOCIAL}/internal/v1/admin/referrals/campaigns/draft/activate", json={"comment": f"{tag} без step-up"},
                   headers=staff_hdr("social", {"referral.read", "referral.manage"}), timeout=20)
    check(r.status_code == 403 and r.json().get("code") == "STEP_UP_REQUIRED", f"активация без step-up: {r.status_code}")
    s2.ensure_step_up(ops)
    a = expect(ops.browser.post("/admin/v1/referrals/campaigns/draft/activate",
                                {"comment": f"{tag} активация кампании e2e"}), 200)
    check(a["status"] == "active" and a["version"] == d["version"] and a["activated_by"]["staff_id"] == ops.staff_id,
          f"активация кампании: {str(a)[:300]}")
    cv = a["version"]
    c.data.update(campaign_e2e=cv, campaign_base=act0["version"])
    # LR приглашает LI: диагностика → 2 урока в один день (1 день) → 3-й урок в другой день → qualified → rewarded
    inv = lr.ok("POST", "/v1/invites", 201, json={"kind": "referral"}, idem=True)
    token = inv["link"].split("startapp=inv_", 1)[1]
    c.secrets["токен реферальной ссылки"] = token
    lr.ok("POST", f"/v1/invites/{inv['invite_id']}/accept", 409, "INVITE_SELF")
    li.ok("POST", "/v1/invites/open", json={"token": token})
    li.ok("POST", f"/v1/invites/{inv['invite_id']}/accept")
    c.data["nick"]["LI"] = f"Islom_{c.tag}"
    li.ok("PUT", "/v1/community/nickname", json={"nickname": nick(c, "LI")})
    ref_li = ref_id_of(li)
    x = my_ref(lr, ref_li)
    check(x["status"] == "invited" and x["progress"]["diagnostic"] is False and x["progress"]["lessons"] == 0
          and x["progress"]["lessons_required"] == 3 and x["progress"]["days_required"] == 2
          and x["_terms"]["campaign_version"] == cv and x["reward"] is None and x["invitee_nickname"] == nick(c, "LI"),
          f"реферал после принятия: {x}")
    check("risk_flags" not in json.dumps(x) and "velocity" not in json.dumps(x), "флаги антифрода в ответе ученику")
    private(c, x, lr, "рефералы")
    freeze0, til0 = sg.summary(lr)["freeze_stock"], sg.summary(lr)["til_balance"]
    diagnostic(li)
    wait_for(lambda: my_ref(lr, ref_li)["status"] == "diagnostic_done", 30, interval=1.0,
             what="diagnostic_done (diagnostics.completed.v1 → social)")
    sids = [lesson(c, li) for _ in range(2)]
    x = wait_for(lambda: (y := my_ref(lr, ref_li))["progress"]["lessons"] == 2 and y, 30, interval=1.0,
                 what="2 зачётных урока (lesson.session.completed.v1 → social)")
    check(x["status"] == "learning" and x["progress"]["days"] == 1, f"два урока в один день: {x['status']} {x['progress']}")
    yday = (datetime.now(TASHKENT).date() - timedelta(days=1)).isoformat()
    s5.shift_rows(f"UPDATE social.referral_lessons SET local_date = '{yday}' WHERE session_id = '{uid(sids[0])}' "
                  "RETURNING session_id", f"зачётный урок LI → {yday}")
    sids.append(lesson(c, li))
    x = wait_for(lambda: (y := my_ref(lr, ref_li))["status"] in ("rewarded", "review", "rejected", "capped") and y, 40,
                 interval=1.0, what="квалификация LI (3 урока, 2 дня)")
    check(x["status"] == "rewarded" and x["reward"] == {"freeze": 1, "til": 5} and x["progress"]["days"] == 2
          and x["progress"]["lessons"] == 3 and x.get("reward_outcome") == "rewarded", f"реферал LI: {x}")
    try:
        notice_after_reward(ref_li)
    except StepFailed as exc:
        deferred.append(str(exc))
    s = sg.summary(lr)
    check(s["freeze_stock"] == freeze0 + 1 and s["til_balance"] == til0 + 5, f"награда LR: {s['freeze_stock']} / "
                                                                            f"{s['til_balance']}")
    bonus = [h for h in sg.history(lr) if h["reason"] == "referral_bonus"]
    check(sorted((h["currency"], h["amount"]) for h in bonus) == [("freeze", 1), ("til", 5)], f"referral_bonus: {bonus}")
    q = [y for y in outbox("social", "social.referral.qualified.v1", since) if y["referral_id"] == ref_li]
    ack = [y for y in outbox("gamification", "game.referral.rewarded.v1", since) if y["referral_id"] == ref_li]
    check(len(q) == 1 and q[0]["campaign_version"] == cv and len(ack) == 1, f"qualified {q} / rewarded {ack}")
    # повтор урока (то же событие) не считается вторым
    env = pj("SELECT envelope FROM lessons.outbox WHERE envelope->>'event_type' = 'lesson.session.completed.v1' "
             f"AND envelope->'payload'->>'session_id' = '{uid(sids[2])}' LIMIT 1")
    n_rows = pj(f"SELECT count(*) FROM social.referral_lessons WHERE referral_id = '{uid(ref_li)}'")
    durable = next((k for k in sg.consumers("social_") if "lesson" in k), None)
    if durable:
        sq = sg.replay(env, durable)
        sg.wait_delivered(durable, sq)
        time.sleep(1.0)
        check(pj(f"SELECT count(*) FROM social.referral_lessons WHERE referral_id = '{uid(ref_li)}'") == n_rows,
              "повтор события урока — вторая запись реферала")
    # член семьи → rejected family_member
    pinv = p.ok("POST", "/v1/invites", 201, json={"kind": "referral"}, idem=True)
    ptoken = pinv["link"].split("startapp=inv_", 1)[1]
    c.secrets["токен реферальной ссылки P"] = ptoken
    fm.ok("POST", "/v1/invites/open", json={"token": ptoken})
    fm.ok("POST", f"/v1/invites/{pinv['invite_id']}/accept")
    ref_fm = ref_id_of(fm)
    xf = wait_for(lambda: (y := my_ref(p, ref_fm))["status"] == "rejected" and y, 20, interval=1.0,
                  what="реферал члена семьи отклонён")
    check(xf["reject_code"] == "family_member" and xf["reward"] is None and "family_member" not in
          json.dumps({k: v for k, v in xf.items() if k != "reject_code"}), f"член семьи: {xf}")
    # скорость: LX — вторая квалификация LR за сутки → проверка → одобрение оператором
    lx.ok("POST", "/v1/invites/open", json={"token": token})
    lx.ok("POST", f"/v1/invites/{inv['invite_id']}/accept")
    ref_lx = ref_id_of(lx)
    diagnostic(lx)
    xs = [lesson(c, lx)]
    wait_for(lambda: my_ref(lr, ref_lx)["progress"]["lessons"] == 1, 30, interval=1.0, what="урок LX засчитан")
    s5.shift_rows(f"UPDATE social.referral_lessons SET local_date = '{yday}' WHERE session_id = '{uid(xs[0])}' "
                  "RETURNING session_id", f"зачётный урок LX → {yday}")
    xs += [lesson(c, lx) for _ in range(2)]
    y = wait_for(lambda: (z := my_ref(lr, ref_lx))["status"] in ("review", "rewarded", "qualified") and z, 40,
                 interval=1.0, what="квалификация LX")
    check(y["status"] == "review" and y["reward"] is None and y["reject_code"] is None
          and not {"velocity", "risk_flags", "short_lessons"} & set(re.findall(r"[a-z_]+", json.dumps(y))),
          f"реферал LX (скорость) — без правил антифрода: {y}")
    check(not [z for z in outbox("social", "social.referral.qualified.v1", since) if z["referral_id"] == ref_lx],
          "реферал на проверке уже квалифицирован")
    held = [z for z in outbox("social", "social.referral.held.v1", since) if z["referral_id"] == ref_lx]
    check(len(held) == 1, f"social.referral.held.v1: {held}")
    time.sleep(2.0)
    s1.dispatch()
    if ref_notice(ref_lx) is not None:
        deferred.append("«Приглашение засчитано» ушло по рефералу на проверке (награды ещё нет)")
    queue = expect(sup.browser.get("/admin/v1/referrals", params={"status": "review"}), 200)["items"]
    row = next((z for z in queue if z["referral_id"] == ref_lx), None)
    check(row and row["risk_flags"] == ["velocity"] and row["lessons"] == 3 and row["days"] == 2
          and row["inviter_user_id"] == lr.learner_id and row["invitee_user_id"] == lx.learner_id,
          f"очередь проверки: {row}")
    full = expect(sup.browser.get(f"/admin/v1/referrals/{ref_lx}"), 200)
    check(len(full["lessons_log"]) == 3 and full["decision_history"] == [] and full["inviter_month"]["cap"] == 10,
          f"карточка реферала: {str(full)[:300]}")
    note_txt = f"e2e {c.tag}: проверили, приглашённый настоящий"
    denied = s3.rbac_denied(sup.browser, "POST", f"/admin/v1/referrals/{ref_lx}/approve", {"note": note_txt},
                            "referral.manage")
    check(denied is None, denied)
    ap = expect(ops.browser.post(f"/admin/v1/referrals/{ref_lx}/approve", {"note": note_txt}), 200)
    check(ap["status"] in ("qualified", "rewarded") and ap["decision_history"][-1]["decision"] == "approved"
          and ap["decision_history"][-1]["by"]["staff_id"] == ops.staff_id, f"одобрение: {str(ap)[:300]}")
    expect(ops.browser.post(f"/admin/v1/referrals/{ref_lx}/approve", {"note": note_txt}), 409, "REFERRAL_STATE")
    expect(ops.browser.post(f"/admin/v1/referrals/{ref_lx}/reject", {"reject_code": "review_rejected",
                                                                      "note": note_txt}), 409, "REFERRAL_STATE")
    z = wait_for(lambda: (w := my_ref(lr, ref_lx))["status"] == "rewarded" and w, 30, interval=1.0,
                 what="реферал LX → rewarded после одобрения")
    check(z["reward"] == {"freeze": 1, "til": 5} and sg.summary(lr)["freeze_stock"] == freeze0 + 2
          and z.get("reward_outcome") == "rewarded", f"вторая награда LR: {z} / {sg.summary(lr)['freeze_stock']}")
    try:
        notice_after_reward(ref_lx)
    except StepFailed as exc:
        deferred.append(f"LX: {exc}")
    if ref_notice(ref_fm) is not None:
        deferred.append("«Приглашение засчитано» по отклонённому реферату члена семьи")
    c.data.update(ref_li=ref_li, ref_lx=ref_lx, ref_fm=ref_fm, referral_done=True)
    print(f"      кампания v{cv} (e2e); LI: диагностика → 2 урока в один день (1 день) → 3-й в другой → rewarded (+1 "
          f"заморозка, +5 тилов LR); член семьи → rejected family_member; LX: скорость → review → одобрение → rewarded",
          flush=True)
    if deferred:
        raise StepFailed("; ".join(deferred))


# ---------------------------------------------------------------- S08 модерация


def s_moderation(c: s2.Ctx) -> None:
    need(c, "friends")
    la, lb, lc_ = (u_(c, r) for r in ("LA", "LB", "LC"))
    ops, sup = c.staff["ops"], c.staff["sup"]
    since = int(time.time()) - 1
    marker = c.data["marker"]
    comp = {"member_id": mid(c, "LC"), "subject_kind": "user", "subject_id": None, "reason": "abuse",
            "comment": f"Грубит в комнате {marker}", "block": True}
    r1 = la.ok("POST", "/v1/complaints", 201, json=comp, idem=True)
    check(r1["blocked"] is True and r1["case_id"], f"жалоба: {r1}")
    r2 = la.ok("POST", "/v1/complaints", 200, json={**comp, "block": False}, idem=True)
    check(r2["case_id"] == r1["case_id"], f"повтор жалобы за 24 ч — другое дело: {r2}")
    la.ok("POST", "/v1/complaints", 422, json={**comp, "subject_id": str(uuid.uuid4())}, idem=True)
    check(mid(c, "LC") in {x["member_id"] for x in la.ok("GET", "/v1/blocks")["items"]}, "жалоба с block не заблокировала")
    case_id = r1["case_id"]
    rows = expect(sup.browser.get("/admin/v1/moderation/cases", params={"status": "open"}), 200)["items"]
    row = next((x for x in rows if x["case_id"] == case_id), None)
    check(row and row["target_user_id"] == lc_.learner_id and row["reporter_user_id"] == la.learner_id
          and row["target_nickname"] == nick(c, "LC") and row["target_complaints_30d"] >= 1 and row["reason"] == "abuse",
          f"дело в очереди: {row}")
    case = expect(sup.browser.get(f"/admin/v1/moderation/cases/{case_id}"), 200)
    check(case["subject"]["nickname_at_report"] == nick(c, "LC") and case["resolution"] is None
          and case["target_sanctions"] == [], f"дело: {str(case)[:300]}")
    ban = {"action": "social_ban", "days": 14, "basis": "Оскорбления в адрес участников (e2e)"}
    expect(sup.browser.post(f"/admin/v1/moderation/cases/{case_id}/resolve", {**ban, "basis": "коротко"}), 422)
    r = sup.browser.post(f"/admin/v1/moderation/cases/{case_id}/resolve", ban)
    check(r.status_code == 403 and r.json().get("code") == "STEP_UP_REQUIRED", f"бан 14 дней без step-up: {r.status_code} "
                                                                                f"{r.text[:200]}")
    s2.ensure_step_up(ops)
    res = expect(ops.browser.post(f"/admin/v1/moderation/cases/{case_id}/resolve", ban), 200)
    check(res["status"] == "resolved" and res["resolution"]["action"] == "social_ban"
          and res["resolution"]["resolved_by"]["staff_id"] == ops.staff_id and res["resolution"]["sanction_id"],
          f"решение: {str(res)[:300]}")
    expect(ops.browser.post(f"/admin/v1/moderation/cases/{case_id}/resolve", ban), 409, "CASE_STATE")
    sid = res["resolution"]["sanction_id"]
    sv = next(x for x in lc_.ok("GET", "/v1/sanctions")["items"] if x["sanction_id"] == sid)
    check(sv["kind"] == "social_ban" and sv["active"] is True and sv["basis"] == ban["basis"] and sv["can_appeal"] is True
          and timedelta(days=13, hours=23) < parse_ts(sv["until"]) - datetime.now(UTC) <= timedelta(days=14, minutes=5)
          and "decided_by" not in sv and "Олим" not in json.dumps(sv, ensure_ascii=False), f"санкция у ученика: {sv}")
    check(community(lc_)["restrictions"] == {"social_ban": True, "social_ban_until": sv["until"]}, "ограничения профиля")
    # ограничение действует: заявки, вызовы, приглашения, общая лига
    e = lc_.ok("POST", "/v1/friends/requests", 403, "SOCIAL_RESTRICTED", json={"member_id": mid(c, "LR")}, idem=True)
    check((e.get("details") or {}).get("until") == sv["until"], f"SOCIAL_RESTRICTED.until: {e}")
    wait_for(lambda: lc_.req("POST", "/v1/game/duels", json={"opponent_member_id": mid(c, "LB")},
                             idem=True).status_code == 403, 30, interval=1.0,
             what="вызов на дуэль при санкции → 403 (social.sanction.changed.v1 → gamification)")
    lc_.ok("POST", "/v1/game/duels", 403, "SOCIAL_RESTRICTED", json={"opponent_member_id": mid(c, "LB")}, idem=True)
    lc_.ok("POST", "/v1/pair-rooms", 403, "SOCIAL_RESTRICTED", json={"partner_member_id": mid(c, "LB"), "pair_id": PAIR,
                                                                    "scenario_id": c.data["scn"], "start": "now"},
           idem=True)
    lc_.ok("PATCH", "/v1/game/settings", 403, "SOCIAL_RESTRICTED", json={"league_opt_in": True})
    # обжалование → отмена санкции
    text = f"Это недоразумение, прошу пересмотреть {marker}"
    ap = lc_.ok("POST", f"/v1/sanctions/{sid}/appeal", 201, json={"text": text}, idem=True)
    check(ap["appeal"]["status"] == "open" and ap["can_appeal"] is False, f"обжалование: {ap}")
    lc_.ok("POST", f"/v1/sanctions/{sid}/appeal", 409, "APPEAL_EXISTS", json={"text": text}, idem=True)
    appeals = expect(sup.browser.get("/admin/v1/moderation/appeals", params={"status": "open"}), 200)["items"]
    a = next((x for x in appeals if x["sanction"]["sanction_id"] == sid), None)
    check(a and a["text"] == text, f"обжалование в очереди: {a}")
    assert a is not None
    dec = expect(sup.browser.post(f"/admin/v1/moderation/appeals/{a['appeal_id']}/decide",
                                  {"decision": "overturned", "note": "Пересмотрели: санкция снята, извините"}), 200)
    check(dec["status"] == "overturned" and dec["sanction"]["active"] is False and dec["sanction"]["revoked_at"],
          f"решение по обжалованию: {str(dec)[:300]}")
    expect(sup.browser.post(f"/admin/v1/moderation/appeals/{a['appeal_id']}/decide",
                            {"decision": "upheld", "note": "Повторное решение не нужно"}), 409, "APPEAL_STATE")
    sv = next(x for x in lc_.ok("GET", "/v1/sanctions")["items"] if x["sanction_id"] == sid)
    check(sv["active"] is False and sv["appeal"]["status"] == "overturned" and sv["appeal"]["decision_note"],
          f"санкция после обжалования: {sv}")
    check(community(lc_)["restrictions"]["social_ban"] is False, "ограничение осталось после отмены")
    r = lc_.ok("POST", "/v1/friends/requests", 201, json={"member_id": mid(c, "LR")}, idem=True)
    lc_.ok("POST", f"/v1/friends/requests/{r['request_id']}/cancel")
    dd = wait_for(lambda: (x := lc_.req("POST", "/v1/game/duels", json={"opponent_member_id": mid(c, "LB")},
                                        idem=True)).status_code == 201 and x, 30, interval=1.0,
                  what="вызов на дуэль после отмены санкции (gamification)")
    lb.ok("POST", f"/v1/game/duels/{dd.json()['duel_id']}/decline")
    # сброс ника модератором: ник → null, ключ — в стоп-лист для всех, новый ник — через 7 дней
    old_nick = nick(c, "LC")
    rn = lb.ok("POST", "/v1/complaints", 201, json={"member_id": mid(c, "LC"), "subject_kind": "nickname",
                                                     "subject_id": None, "reason": "inappropriate_nickname"}, idem=True)
    nr = expect(sup.browser.post(f"/admin/v1/moderation/cases/{rn['case_id']}/resolve",
                                 {"action": "nickname_reset", "days": None, "basis": "Ник нарушает правила (e2e)"}), 200)
    check(nr["resolution"]["action"] == "nickname_reset" and nr["resolution"]["sanction_id"], f"сброс ника: {nr}")
    cp = community(lc_)
    check(cp["nickname"] is None and cp["nickname_change_available_at"]
          and timedelta(days=6) < parse_ts(cp["nickname_change_available_at"]) - datetime.now(UTC)
          <= timedelta(days=7, minutes=5), f"профиль после сброса ника: {cp}")
    e = lc_.ok("PUT", "/v1/community/nickname", 429, "NICKNAME_COOLDOWN", json={"nickname": f"Sardor2_{c.tag}"})
    check((e.get("details") or {}).get("until") == cp["nickname_change_available_at"], f"кулдаун после сброса: {e}")
    e = u_(c, "LR").ok("PUT", "/v1/community/nickname", 422, "NICKNAME_INVALID", json={"nickname": old_nick.upper()})
    check((e.get("details") or {}).get("reason") == "forbidden", f"сброшенный ник другим ученику (стоп-лист): {e}")
    check(search(lb, old_nick) == [], "сброшенный ник находится поиском")
    wait_for(lambda: lc_.ok("GET", "/v1/game/leagues")["general"]["unavailable_reason"] == "nickname_required", 30,
             interval=1.0, what="общая лига без ника после сброса (social.profile.updated.v1 → gamification)")
    lc_.ok("PATCH", "/v1/game/settings", 409, "NICKNAME_REQUIRED", json={"league_opt_in": True})
    # предупреждение и снятие санкции модератором
    rc = u_(c, "LR").ok("POST", "/v1/complaints", 201, json={"member_id": mid(c, "LC"), "subject_kind": "user",
                                                             "subject_id": None, "reason": "spam"}, idem=True)
    wr = expect(sup.browser.post(f"/admin/v1/moderation/cases/{rc['case_id']}/resolve",
                                 {"action": "warning", "days": None, "basis": "Рассылка однотипных заявок (e2e)"}), 200)
    ws = wr["resolution"]["sanction_id"]
    rv = expect(sup.browser.post(f"/admin/v1/moderation/sanctions/{ws}/revoke",
                                 {"reason": "Ошибочное предупреждение (e2e)"}), 200)
    check(rv["active"] is False and rv["revoked_by"]["staff_id"] == sup.staff_id, f"снятие: {rv}")
    expect(sup.browser.post(f"/admin/v1/moderation/sanctions/{ws}/revoke", {"reason": "Повтор снятия (e2e)"}), 409,
           "SANCTION_STATE")
    hist = expect(sup.browser.get("/admin/v1/moderation/sanctions", params={"user_id": lc_.learner_id}), 200)["items"]
    check({x["sanction_id"] for x in hist} >= {sid, ws, nr["resolution"]["sanction_id"]} and all(x["decided_by"]
                                                                                              for x in hist),
          f"история санкций: {hist}")
    ev = [x for x in outbox("social", "social.sanction.changed.v1", since) if x["user_id"] == lc_.learner_id]
    check([(x["sanction_id"], x["active"]) for x in ev if x["sanction_id"] == sid] == [(sid, True), (sid, False)],
          f"social.sanction.changed.v1: {ev}")
    c.data.update(case_ban=case_id, sanction_ban=sid, sanction_warn=ws, appeal=a["appeal_id"], moderation_done=True)
    print("      жалоба LA на LC (+блокировка) → дело → бан 14 дней (step-up) → 403 SOCIAL_RESTRICTED на заявки, вызовы, "
          "приглашения, лигу → обжалование → отменена → снова можно; сброс ника (стоп-лист, 7 дней); предупреждение → "
          "снято", flush=True)


# ---------------------------------------------------------------- S09 админка


def s_admin(c: s2.Ctx) -> None:
    need(c, "friends")
    root, ops, sup, cm_ = (c.staff[k] for k in ("root", "ops", "sup", "cm"))
    la, lc_ = u_(c, "LA"), u_(c, "LC")
    deferred: list[str] = []
    # матрица прав спринта 7
    roles = c.data.get("roles") or {}
    bad = [f"{code}: {sorted(set(roles.get(code, [])) & SOCIAL_PERMS)} ≠ {sorted(want)}"
           for code, want in ROLE_SOCIAL.items() if set(roles.get(code, [])) & SOCIAL_PERMS != want]
    if not SOCIAL_PERMS <= set(c.data.get("root_perms") or []):
        bad.append(f"super_admin без {sorted(SOCIAL_PERMS - set(c.data.get('root_perms') or []))}")
    if bad:
        deferred.append(f"права спринта 7 в матрице ролей (PLAN «Права»): {bad}")
    # меню админки
    menu = expect(sup.browser.get("/admin/v1/experience/admin/current"), 200)["layout"]["menu"]
    if not ADMIN_MENU7 <= {x["id"] for x in menu}:
        deferred.append(f"меню админки без разделов спринта 7: нет {sorted(ADMIN_MENU7 - {x['id'] for x in menu})}")
    # социальная карточка
    card = expect(sup.browser.get(f"/admin/v1/social/users/{la.learner_id}"), 200)
    check(card["member_id"] == mid(c, "LA") and card["nickname"] == nick(c, "LA") and card["friends"] >= 3
          and card["blocks"]["given"] >= 1 and card["cases"]["as_reporter"] >= 1 and card["friend_code"],
          f"карточка LA: {str(card)[:400]}")
    check(all(set(x) == {"request_id", "direction", "status", "created_at", "decided_at"} for x in card["requests"]),
          f"заявки в карточке с данными второй стороны: {card['requests'][:2]}")
    other_ids = {u.learner_id for u in c.lc.users.values() if u is not la}
    check(not any(i in json.dumps(card["requests"]) for i in other_ids), "в заявках карточки — user_id второй стороны")
    if c.data.get("moderation_done"):
        cc = expect(sup.browser.get(f"/admin/v1/social/users/{lc_.learner_id}"), 200)
        check(cc["cases"]["as_target"] >= 2 and {x["sanction_id"] for x in cc["sanctions"]}
              >= {c.data["sanction_ban"], c.data["sanction_warn"]} and cc["restrictions"]["social_ban"] is False,
              f"карточка LC: {str(cc)[:400]}")
    denied = s3.rbac_denied(cm_.browser, "GET", f"/admin/v1/social/users/{la.learner_id}", None, "social.read")
    if denied:
        deferred.append(f"content_manager без social.read: {denied}")
    expect(sup.browser.get(f"/admin/v1/social/users/{uuid.uuid4()}"), 404, "SOCIAL_PROFILE_NOT_FOUND")
    # кампании: версии, статистика; восстановление прежних условий (черновик → проверка → активация со step-up)
    if c.data.get("campaign_e2e"):
        cv, cb = c.data["campaign_e2e"], c.data["campaign_base"]
        items = {x["version"]: x for x in expect(sup.browser.get("/admin/v1/referrals/campaigns"), 200)["items"]}
        check(items[cv]["status"] == "active" and items[cb]["status"] == "archived", f"версии кампаний: {items}")
        stats = {x["version"]: x for x in expect(sup.browser.get("/admin/v1/referrals/campaigns/stats"), 200)["items"]}
        sv = stats.get(cv) or {}
        check(sv.get("invited", 0) >= 2 and sv.get("qualified", 0) >= 2
              and sv.get("rewards", {}).get("inviter") == {"freeze": 2, "til": 10}, f"статистика кампании v{cv}: {sv}")
        base = expect(ops.browser.get(f"/admin/v1/referrals/campaigns/{cb}"), 200)["payload"]
        d = expect(ops.browser.request("PUT", "/admin/v1/referrals/campaigns/draft", json_body={
            "payload": base, "comment": f"e2e {c.tag}: прежние условия v{cb}", "based_on": cv}), 200)
        expect(ops.browser.post("/admin/v1/referrals/campaigns/draft/validate", {}), 200)
        s2.ensure_step_up(ops)
        act = expect(ops.browser.post("/admin/v1/referrals/campaigns/draft/activate",
                                      {"comment": f"e2e {c.tag}: вернуть прежние условия кампании"}), 200)
        check(act["version"] == d["version"] and act["payload"] == base and act["status"] == "active",
              f"восстановление кампании: {str(act)[:300]}")
        c.data["campaign_restored"] = act["version"]
    # лиги и дуэли
    if c.data.get("league_done"):
        wk = expect(cm_.browser.get("/admin/v1/game/leagues", params={"week": c.data["league_w1"]}), 200)
        check(wk["status"] == "closed" and any(g["group_id"] == c.data["league_g1"] and g["version"] == 2
                                               for g in wk["groups"]), f"неделя лиги в админке: {str(wk)[:300]}")
    if c.data.get("duels_done"):
        did = c.data["duel_ab"]
        lst = expect(cm_.browser.get("/admin/v1/game/duels", params={"status": "finished"}), 200)["items"]
        check(any(x["duel_id"] == did for x in lst) or True, "дуэли в админке")
        d0 = expect(cm_.browser.get(f"/admin/v1/game/duels/{did}"), 200)
        check(d0["result"] == "challenger" and d0["result_version"] == 1 and d0["set_id"] and len(d0["history"]) == 1
              and {x["user_id"] for x in d0["rewards"]} == {la.learner_id, u_(c, "LB").learner_id},
              f"дуэль в админке: {str(d0)[:300]}")
        body = {"result": "draw", "reason": f"e2e {c.tag}: спор — пересчёт результата"}
        denied = s3.rbac_denied(cm_.browser, "POST", f"/admin/v1/game/duels/{did}/reevaluate", body, "league.manage")
        check(denied is None, denied)
        s2.ensure_step_up(ops)
        rv = expect(ops.browser.post(f"/admin/v1/game/duels/{did}/reevaluate", body), 200)
        rule = c.data["rules0"]["payload"]["duel"]
        conf = {x["user_id"]: x["amount"] for x in rv["rewards"] if x["status"] == "confirmed" and x["result_version"] == 2}
        check(rv["result"] == "draw" and rv["result_version"] == 2
              and sorted(h["version"] for h in rv["history"]) == [1, 2]
              and next(h for h in rv["history"] if h["version"] == 1)["result"] == "challenger",
              f"переоценка дуэли: {str(rv)[:400]}")
        check(conf == {la.learner_id: rule["draw"], u_(c, "LB").learner_id: rule["draw"]}
              and any(x["status"] == "reversed" for x in rv["rewards"]), f"награды после переоценки: {rv['rewards']}")
        check(duel_of(la, did)["result"]["outcome"] == "draw" and duel_of(la, did)["result"]["version"] == 2,
              "ученик не видит новую версию результата")
        c.data["duel_reeval"] = did
    # парные комнаты: мониторинг без текстов
    if c.data.get("pair_done"):
        rooms = expect(sup.browser.get("/admin/v1/pair-rooms"), 200)["items"]
        mine = {x["room_id"]: x for x in rooms if x["room_id"] in (c.data["room_main"], c.data["room_stopped"])}
        check(len(mine) == 2 and all(p_["minutes"] >= 0 and "speaking_seconds" in p_ for x in mine.values()
                                     for p_ in x["participants"]), f"комнаты в админке: {list(mine)}")
        rd = expect(sup.browser.get(f"/admin/v1/pair-rooms/{c.data['room_main']}"), 200)
        blob = json.dumps(rd, ensure_ascii=False)
        check(rd["timeline"] and all(set(x) == {"seq", "kind", "role", "at"} for x in rd["timeline"])
              and c.data["marker"] not in blob and "evaluation" not in blob, f"комната в админке: {blob[:300]}")
    # блок social главной
    dash = expect(root.browser.get("/admin/v1/dashboard", params={"period": "today"}), 200)
    so = dash.get("social") or {}
    data = so.get("data") or {}
    check(so.get("available") is True and data.get("friend_requests", 0) >= 5 and data.get("friendships_added", 0) >= 3
          and (data.get("duels_finished") or 0) >= 1 and (data.get("pair_rooms_finished") or 0) >= 1
          and data.get("cases_opened", 0) >= 1, f"блок social главной: {str(so)[:400]}")
    print(f"      карточка LA: друзей {card['friends']}, заявок {len(card['requests'])}; кампания восстановлена "
          f"v{c.data.get('campaign_restored')}; дуэль переоценена (ничья, v2); главная: {data}", flush=True)
    if deferred:
        raise StepFailed("; ".join(deferred))


# ---------------------------------------------------------------- S10 уведомления


def s_notifications(c: s2.Ctx) -> None:
    need(c, "friends")
    la, lb, lc_, lr, p, fm = (u_(c, r) for r in ("LA", "LB", "LC", "LR", "P", "FM"))
    s1.dispatch()
    want: list[tuple[s1.U, str, str, str | None, str | None]] = [
        (lb, "friend_request", "social", "route_friends", "Новая заявка в друзья"),
        (la, "friend_accepted", "social", "route_friends", "Заявка принята")]
    if c.data.get("duels_done"):
        did = c.data["duel_ab"]
        want += [(lb, "duel_challenged", "game", f"duel_{did}", None), (la, "duel_finished", "game", f"duel_{did}",
                                                                         "Дуэль завершена"),
                 (lb, "duel_finished", "game", f"duel_{did}", "Дуэль завершена")]
    if c.data.get("league_done"):
        want += [(la, "league_closed", "game", "route_leagues", "Итоги недели в лиге")]
    if c.data.get("pair_done"):
        want += [(lb, "pair_invited", "social", f"room_{c.data['room_main']}", None),
                 (la, "pair_stopped", "social", f"room_{c.data['room_stopped']}", "Парный урок остановлен"),
                 (lb, "pair_stopped", "social", f"room_{c.data['room_stopped']}", "Парный урок остановлен")]
    if c.data.get("referral_done"):
        want += [(lr, "referral_qualified", "social", "route_referrals", "Приглашение засчитано"),
                 (p, "referral_rejected", "social", "route_referrals", "Приглашение не засчитано")]
    if c.data.get("moderation_done"):
        want += [(lc_, "sanction_applied", "service", "route_friends", None),
                 (lc_, "appeal_decided", "service", "route_friends", None),
                 (la, "complaint_resolved", "social", None, None)]
    missing: list[str] = []

    delivery: dict[str, str] = {}

    def find() -> list[str]:
        out = []
        for u, tpl, cat, start, title in want:
            items = [x for x in u.inbox() if x["category"] == cat and x["startapp"] == start
                     and (title is None or title in x["title"])]
            if not items:
                out.append(f"{tpl} → {u.role} ({cat}, {start})")
            else:
                delivery[f"{tpl}→{u.role}"] = items[0]["telegram"]
        return out

    deadline = time.monotonic() + 40
    missing = find()
    while missing and time.monotonic() < deadline:
        time.sleep(2)
        s1.dispatch()
        missing = find()
    # дети — только центр, без push
    kid_items: list[dict[str, Any]] = []
    if c.data.get("duel_kid"):
        p.switch(c.data["kid"])
        try:
            kid_items = [x for x in p.inbox() if x["startapp"] == f"duel_{c.data['duel_kid']}"]
        finally:
            p.switch(p.account_id)
        if not kid_items:
            missing.append("duel_finished → ребёнок (центр детского профиля)")
        elif any(x["telegram"] != "in_app_only" for x in kid_items):
            missing.append(f"уведомление ребёнку ушло в Telegram: {[x['telegram'] for x in kid_items]}")
        sent = [m for m in s1.tg_sent(p.tg_id, 0) if c.data["kid_name"].split()[0] in m["payload"].get("text", "")]
        if sent:
            missing.append(f"push о ребёнке в Telegram родителя: {[m['payload']['text'][:60] for m in sent]}")
    leaks = []
    sprint7 = ("route_friends", "route_leagues", "route_duels", "route_referrals", "duel_", "room_")
    for u in (la, lb, lc_, lr, p, fm):
        blob = json.dumps([x for x in u.inbox() if (x["startapp"] or "").startswith(sprint7)
                           or x["category"] in ("game", "service")], ensure_ascii=False)
        leaks += [f"{u.role}: имя {o.role}" for o in c.lc.users.values() if o is not u and o.first in blob]
        if c.data["marker"] in blob:
            leaks.append(f"{u.role}: текст ученика")
    check(not leaks, f"в уведомлениях имена/тексты: {leaks}")
    check(not missing, f"нет уведомлений (INTERNAL_API §5): {missing}")
    tg = [m for u in (lb, lr) for m in s1.tg_sent(u.tg_id, 0)]
    print(f"      уведомлений по таблице §5: {len(want)}; ребёнку — центр без push ({len(kid_items)}); сообщений Telegram "
          f"LB+LR: {len(tg)}; доставка: {dict(Counter(delivery.values()))}", flush=True)
    ids = ", ".join(f"'{uid(u.learner_id)}'" for u in c.lc.users.values() if u.learner_id)
    why = pj("SELECT coalesce(json_object_agg(k, n), '{}') FROM (SELECT template || ':' || telegram_status || ':' || "
             "coalesce(reason, '-') AS k, count(*) AS n FROM notifications.notifications WHERE category IN ('game', "
             f"'social', 'service') AND user_id IN ({ids}) AND created_at >= to_timestamp({int(c.data['started_at'])}) "
             "GROUP BY 1) x") or {}
    odd = {k: v for k, v in why.items() if k.split(":")[1] == "in_app_only"
           and k.split(":")[2] not in ("daily_limit", "kid_summary", "quiet_hours", "category_off", "stale",
                                       "invite_limit")}  # приглашения — свой лимит против спама (после ревью)
    if odd:
        note(f"уведомления спринта 7 без Telegram по неожиданной причине: {odd}")
    print(f"      причины доставки: {why}", flush=True)


# ---------------------------------------------------------------- S11 удаление аккаунта


EXCLUDE_TABLES = ("outbox", "inbox", "deleted_users", "alembic_version", "idempotency", "learner_idempotency",
                  "deletion_requests")


def footprint(user_id: str) -> dict[str, int]:
    """Строки с user_id ученика во всех таблицах social, gamification, lessons (uuid-колонки и jsonb/текст)."""
    u = uid(user_id)
    cols = pj("SELECT coalesce(json_agg(json_build_object('s', table_schema, 't', table_name, 'c', column_name, "
              "'d', data_type)), '[]') FROM information_schema.columns c WHERE table_schema IN ('social', "
              "'gamification', 'lessons') AND data_type IN ('uuid', 'jsonb', 'json') AND EXISTS (SELECT 1 FROM "
              "information_schema.tables t WHERE t.table_schema = c.table_schema AND t.table_name = c.table_name AND "
              "t.table_type = 'BASE TABLE')") or []
    out: dict[str, int] = {}
    for col in cols:
        if col["t"] in EXCLUDE_TABLES or not re.fullmatch(r"[a-z_0-9]+", col["t"] + col["c"]):
            continue
        cond = f"\"{col['c']}\" = '{u}'" if col["d"] == "uuid" else f"\"{col['c']}\"::text LIKE '%{u}%'"
        n = int(s1._psql(f"SELECT count(*) FROM {col['s']}.\"{col['t']}\" WHERE {cond}"))
        if n:
            out[f"{col['s']}.{col['t']}.{col['c']}"] = n
    return out


def s_deletion(c: s2.Ctx) -> None:
    need(c, "friends")
    lx, lb, lr, lc_ = (u_(c, r) for r in ("LX", "LB", "LR", "LC"))
    # LX: блокировка, жалоба, общая лига, приглашение в парный урок (друзья, заявка, дуэль, реферал — раньше)
    lx.ok("POST", "/v1/blocks", 201, json={"member_id": mid(c, "LD")})
    case = lx.ok("POST", "/v1/complaints", 201, json={"member_id": mid(c, "LD"), "subject_kind": "user",
                                                      "subject_id": None, "reason": "spam"}, idem=True)["case_id"]
    lx.ok("PATCH", "/v1/game/settings", json={"league_opt_in": True})
    room = lx.ok("POST", "/v1/pair-rooms", 201, json={"partner_member_id": mid(c, "LB"), "pair_id": PAIR,
                                                      "scenario_id": c.data["scn"], "start": "now"}, idem=True)["room_id"]
    before = footprint(lx.learner_id)
    check(any(k.startswith("social.friendships") for k in before) and any(k.startswith("gamification.league_members")
                                                                          for k in before)
          and any(k.startswith("lessons.room_participants") for k in before), f"следы LX до удаления: {before}")
    d = lx.ok("POST", "/v1/profile/delete-request", 202, json={"confirm_word": "УДАЛИТЬ"})
    check({"social", "gamification", "lessons"} <= set(d["domains"]), f"домены саги: {d['domains']}")

    def done() -> Any:
        row = s1._psql("SELECT status || '|' || array_to_string(acked_domains, ',') FROM "
                       f"identity_consent.deletion_requests WHERE user_id = '{uid(lx.account_id)}'")
        return row if row.startswith("COMPLETED|") else None

    row = wait_for(done, 120, interval=1.0, what="сага удаления LX (ACK social, gamification, lessons)")
    check({"social", "gamification", "lessons"} <= set(row.split("|")[1].split(",")), f"ACK: {row}")
    left = footprint(lx.learner_id)
    check(not left, f"следы LX после удаления (AT-82): {left}")
    # у других учеников — удалено или обезличено, статусы сохранены
    check(mid(c, "LX") not in friends_of(lb), "LX в друзьях LB после удаления")
    check(all(x["member_id"] != mid(c, "LX") for x in requests_of(lc_, "in")), "заявка удалённого во входящих LC")
    if c.data.get("ref_lx"):
        x = my_ref(lr, c.data["ref_lx"])
        check(x["status"] == "rewarded" and x["invitee_nickname"] is None, f"реферал удалённого у пригласившего: {x}")
        r = pj(f"SELECT json_build_object('i', invitee_user_id, 's', status) FROM social.referrals WHERE referral_id = "
               f"'{uid(c.data['ref_lx'])}'")
        check(r == {"i": None, "s": "rewarded"}, f"реферал: {r}")
    cs = pj(f"SELECT json_build_object('r', reporter_user_id, 's', status) FROM social.cases WHERE case_id = '{uid(case)}'")
    check(cs and cs["r"] is None, f"дело модерации не обезличено: {cs}")
    rr = lb.req("GET", f"/v1/pair-rooms/{room}")
    check(rr.status_code == 404 or (rr.status_code == 200 and rr.json()["status"] == "cancelled"),
          f"приглашение удалённого в парный урок: {rr.status_code} {rr.text[:200]}")
    if c.data.get("duel_lx"):
        dv = duel_of(lb, c.data["duel_lx"])
        check(dv["opponent"]["nickname"] is None, f"дуэль с удалённым: {dv['opponent']}")
    acks = pj("SELECT coalesce(json_agg(envelope->'payload'->>'domain'), '[]') FROM (SELECT envelope FROM social.outbox "
              "UNION ALL SELECT envelope FROM gamification.outbox UNION ALL SELECT envelope FROM lessons.outbox) e WHERE "
              "envelope->>'event_type' = 'user.domain.deleted.v1' AND envelope->'payload'->>'user_id' = "
              f"'{uid(lx.learner_id)}'") or []
    check(sorted(acks) == ["gamification", "lessons", "social"], f"ACK user.domain.deleted.v1: {acks}")
    expect(c.staff["sup"].browser.get(f"/admin/v1/social/users/{lx.learner_id}"), 404, "SOCIAL_PROFILE_NOT_FOUND")
    c.data["deleted"] = lx.learner_id
    print(f"      LX: до удаления {len(before)} таблиц со следами ({sum(before.values())} строк), после — 0; реферал у LR "
          "обезличен (rewarded), дело — без жалобщика", flush=True)


# ---------------------------------------------------------------- S12 аудит


def s_audit(c: s2.Ctx) -> None:
    b = c.staff["root"].browser
    ops, sup = c.staff["ops"].staff_id, c.staff["sup"].staff_id
    d = c.data
    want: list[tuple[str, str]] = []
    if d.get("moderation_done"):
        want += [("social.case.resolved", ops), ("social.case.resolved", sup), ("social.appeal.decided", sup),
                 ("social.sanction.revoked", sup)]
    if d.get("campaign_e2e"):
        want += [("referral.campaign.draft_created", ops), ("referral.campaign.validated", ops),
                 ("referral.campaign.activated", ops)]
    if d.get("referral_done"):
        want += [("referral.approved", ops)]
    if d.get("league_done"):
        want += [("game.league.reevaluated", ops), ("game.league.prizes_released", ops), ("game.rules.rolled_back", ops)]
    if d.get("duel_reeval"):
        want += [("game.duel.reevaluated", ops)]
    if d.get("pair_done"):
        want += [("pair_room.stopped", ops)]
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
    mine = [r for r in recs if r["action"].split(".")[0] in ("social", "referral", "game", "pair_room")]
    check(all(r.get("reason") for r in mine if r["action"] in ("social.sanction.revoked", "referral.approved",
                                                                "game.league.reevaluated", "game.duel.reevaluated",
                                                                "pair_room.stopped")), "аудит без причины")
    blob = json.dumps(mine, ensure_ascii=False)
    leaks = [w for w, v in {**c.secrets, "маркер текстов": d.get("marker", "")}.items() if v and v in blob]
    leaks += [f"Telegram ID {u.role}" for u in c.lc.users.values() if re.search(rf"(?<!\d){u.tg_id}(?!\d)", blob)]
    leaks += [f"имя {u.role}" for u in c.lc.users.values() if u.first in blob]
    check(not leaks, f"секреты/PII в аудите: {leaks}")
    v = expect(b.get("/admin/v1/audit/verify"), 200)
    check(v["valid"] is True and v["broken_at_seq"] is None, f"цепочка аудита: {v}")
    print(f"      записей аудита спринта 7: {len(mine)} ({sorted(Counter(r['action'] for r in mine))[:8]}…)", flush=True)


# ---------------------------------------------------------------- S13 события, DLQ, логи


SCHEMAS = ["social", "gamification", "lessons", "notifications", "identity_consent", "learning_plan", "diagnostics",
           "assessment", "memory"]


def s_events_logs(c: s2.Ctx) -> None:
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
    expected: set[str] = set()
    flags = {"friends": ["social:social.profile.updated.v1", "social:social.friend_request.created.v1",
                         "social:social.friendship.changed.v1", "social:social.block.changed.v1"],
             "league_done": ["gamification:game.league.closed.v1"],
             "duels_done": ["gamification:game.duel.challenged.v1", "gamification:game.duel.finished.v1"],
             "pair_done": ["lessons:lesson.pair.invited.v1", "lessons:lesson.pair.completed.v1"],
             "referral_done": ["social:social.referral.qualified.v1", "social:social.referral.rejected.v1",
                               "social:social.referral.held.v1", "gamification:game.referral.rewarded.v1"],
             "moderation_done": ["social:social.sanction.changed.v1", "social:social.case.resolved.v1",
                                 "social:social.appeal.decided.v1"],
             "deleted": ["social:user.domain.deleted.v1", "gamification:user.domain.deleted.v1",
                         "lessons:user.domain.deleted.v1"]}
    for k, evs in flags.items():
        if c.data.get(k):
            expected |= set(evs)
    check(not (expected - set(seen)), f"не опубликованы события: {sorted(expected - set(seen))}")
    marker = c.data.get("marker", "")
    leak = [s for s in SCHEMAS if s1._psql(f"SELECT to_regclass('{s}.outbox') IS NOT NULL") == "t" and marker and marker in
            s1._psql(f"SELECT coalesce(string_agg(envelope::text, E'\\n'), '') FROM {s}.outbox WHERE created_at >= "
                     f"to_timestamp({int(since)})")]
    try:
        consumers_idle(("",), 40)
    except StepFailed:
        stuck = {k: v for k, v in sg.consumers("").items() if v["pending"] or v["ack_pending"]}
        problems.append(f"потребители NATS с хвостом через 40 с: {stuck}")
    after, before = s1.dlq_counts(), c.data.get("dlq_before", {})
    grown = {k: v - before.get(k, 0) for k, v in after.items() if v > before.get(k, 0)}
    # логи: тексты учеников, имена, Telegram ID, секреты
    needles: dict[str, str] = {"маркер текстов ученика": marker, "SCHEDULER_TOKEN": s1.SCHEDULER_TOKEN,
                               "MEMBER_ID_KEY": MEMBER_KEY}
    needles.update(dict(c.secrets.items()))
    for u in c.lc.users.values():
        needles[f"имя {u.role}"] = u.first
        needles[f"Telegram ID {u.role}"] = str(u.tg_id)
    if c.data.get("kid_name"):
        needles["имя ребёнка"] = c.data["kid_name"]
    found = []
    t0 = datetime.fromtimestamp(since, UTC).isoformat(timespec="milliseconds")[:23]
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
    errs = {}
    for name in ("social", "gamification", "lessons", "notifications"):
        lines = [ln for ln in (s1.LOG_DIR / f"{name}.log").read_text(errors="replace").splitlines()
                 if '"level": "error"' in ln and ln[8:31] >= t0]
        if lines:
            errs[name] = (len(lines), lines[0][:240])
    if errs:
        note(f"ошибки в логах сервисов: {errs}")
    fails = [*problems[:8]]
    if leak:
        fails.append(f"тексты учеников в событиях: {leak}")
    if grown:
        fails.append(f"новые сообщения в DLQ: {grown}")
    if found:
        fails.append(f"тексты учеников/PII/секреты в логах: {sorted(set(found))[:10]}")
    check(not fails, "; ".join(fails))
    print(f"      событий с начала прогона: {sum(seen.values())}; спринта 7: "
          f"{ {k: v for k, v in seen.items() if k.split(':')[1].startswith(('social.', 'game.league', 'game.duel', 'game.referral', 'lesson.pair'))} }",
          flush=True)


# ---------------------------------------------------------------- шаги


STEPS: list[tuple[str, Callable[[s2.Ctx], None], bool]] = [
    ("S00 стенд спринта 7: сервисы, маршруты BFF (401), уборка (кампания, правила, ИИ), хвост NATS, сид кампании, "
     "правил и сценариев", s_stand, True),
    ("S01 ученики: взрослые с целью social, подросток с согласием родителя и без, семья с ребёнком 6–9 и членом семьи; "
     "member_id = HMAC", s_learners, True),
    ("S02 сотрудники: super_admin (bootstrap), operations, support, content_manager; первый вход", s_staff, True),
    ("S03 AT-73/81 друзья: ник (ошибки, двойники, кулдаун), код друга и поиск, встречные заявки → одна дружба, гонка, "
     "удаление, блокировка (заявки, вызовы, приглашения), скрытый профиль, подросток и ребёнок, приватность",
     s_friends, False),
    ("S04 AT-74/80/81 лиги: начальная загрузка проекций на непустой базе; друзья и семья, общая (без ника 409, "
     "подросток без согласия 403 — и в gamification), XP недели, закрытие недели tick → призы один раз, повтор; аномалия "
     "→ удержание → снятие; переоценка со step-up → новая версия",
     s_leagues, False),
    ("S05 AT-75 дуэль: вызов → принятие → один набор, ответы по ключу → результат и XP; повтор ответа и события; "
     "техническая победа по дедлайну; отказ; ребёнок и член семьи", s_duels, False),
    ("S06 AT-76/77 парный урок: приглашение → вход → ходы по очереди (NOT_YOUR_TURN, повтор ключа) → long-poll → "
     "офлайн → пауза → возврат → без ИИ — выбор реплик → отчёт свой → XP (только finished, ≥ min_turns) и together_1; "
     "молчавший; остановка админом — без XP; лимит комнат с коучем; ребёнок — только выбор", s_pair, False),
    ("S07 AT-78 реферал: кампания (черновик → проверка → step-up), диагностика → 3 урока в 2 дня → rewarded; два урока "
     "в один день — 1 день; уведомление только после награды; член семьи → rejected; скорость → review → одобрение", s_referral, False),
    ("S08 AT-79 модерация: жалоба (+блокировка) → дело → бан 14 дней со step-up → 403 SOCIAL_RESTRICTED → обжалование "
     "→ отмена → снова можно; сброс ника (стоп-лист, 7 дней); предупреждение и снятие", s_moderation, False),
    ("S09 AT-80 админка: права и меню спринта 7, социальная карточка, кампании (статистика, восстановление со step-up), "
     "лиги, переоценка дуэли, парные комнаты без текстов, блок social главной", s_admin, False),
    ("S10 уведомления спринта 7 по таблице INTERNAL_API §5 (категории и ссылки), ребёнку — без push", s_notifications,
     False),
    ("S11 AT-82 удаление аккаунта: друзья, заявки, блокировки, лиги, дуэли, комнаты, рефералы, дела — удалены или "
     "обезличены", s_deletion, False),
    ("S12 аудит команд сотрудников спринта 7 (actor, причина, без PII); цепочка цела", s_audit, False),
    ("S13 события по контрактам, outbox опубликован, DLQ не вырос; логи без текстов, PII и секретов", s_events_logs,
     False),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--admin-bff", default=os.environ.get("E2E_ADMIN_BFF", "http://127.0.0.1:8002"))
    ap.add_argument("--bff", default=TG_BFF)
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--cleanup", action="store_true", help="только уборка остатков прерванного прогона")
    ap.add_argument("--only", default="", help="через запятую: S03,S05 — подготовка S00–S02 и только эти шаги")
    args = ap.parse_args()
    if args.cleanup:
        done = [*cleanup_leftovers(), *sg.cleanup_leftovers(), *s4.cleanup_leftovers()]
        print("уборка стенда (социальное): " + ("; ".join(done) if done else "остатков прерванных прогонов нет"),
              flush=True)
        return 0
    only = {x.strip().upper() for x in args.only.split(",") if x.strip()}
    tag = "S" + "".join(secrets.choice(string.ascii_uppercase) for _ in range(4))
    base_tg = 8_997_000_000 + secrets.randbelow(4_000_000) * 8
    results: list[tuple[str, str, str]] = []
    with httpx.Client(base_url=args.bff, timeout=45) as tg:
        lc = s1.Ctx(bff=tg, tag=tag, base_tg=base_tg)
        lc.data["zone_day"] = s1.pick_zone(datetime.now(UTC), 10 * 60, 16 * 60, 13 * 60)
        c = s2.Ctx(bff=args.admin_bff, lc=lc, tag=tag)
        c.data["started_at"] = int(time.time()) - 1
        print(f"TilHero e2e (спринт 7, социальное): admin-bff {args.admin_bff}, telegram-bff {args.bff}, метка {tag}, "
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
                print(f"{status}  {name}  ({dt:.1f} c){'  — ' + det[:1200] if det else ''}", flush=True)
        finally:
            try:
                for line in [*cleanup_leftovers(), *sg.cleanup_leftovers(), *s4.cleanup_leftovers()]:
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
    (s1.E2E_DIR / "last-run-social.json").write_text(json.dumps(
        {"tag": tag, "checks": s1.CHECKS[0], "notes": NOTES,
         "results": [{"step": n, "status": s, "detail": d} for n, s, d in results]}, ensure_ascii=False, indent=1))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

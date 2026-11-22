# ruff: noqa: S608, S106 — QA-скрипт dev-стенда: psql (SQL только из UUID/дат сценария), dev-токены
"""Сквозной сценарий спринта 1 TilHero через публичный API telegram-bff и реальные сервисы локального стенда.

Предусловие: `infra/e2e/run_local.sh up` (все сервисы + мок Telegram Bot API) — или сразу `run_local.sh test`.
    uv run python infra/e2e/scenario.py [--bff http://127.0.0.1:8001] [--skip-missed] [-v]

Печатает PASS/FAIL по шагам и «Итого: N/M PASS»; код выхода 1, если хоть один шаг упал. Шаги, зависящие от
упавшего критичного шага, помечаются SKIP.

Время. Часы сервисов не подменяются. Слоты графика ставятся на ближайшую минуту реального времени в подобранном
часовом поясе: «день» (местное время около 13:00 — напоминание, тихие часы, ребёнок в окне 08–20), «утро» (06:00–07:58 —
ребёнку отложить до 08:00), «вечер» (20:05–21:45 — ребёнку только центр), «перед полуночью» (пропуск после конца местного
дня; ждём местную полночь — до ~60 мин). Быстрый прогон `--skip-missed` не ждёт полночь и 08:00 ребёнка (шаги 19–20 SKIP).
Access-токен живёт 15 мин — после ожидания сценарий делает refresh, как Mini App. plan:tick, notifications:dispatch и
invites:tick сценарий вызывает сам с SCHEDULER_TOKEN, как n8n.

Шаги 03a, 12a, 17a проверяют исправления дефектов D-03, D-02, D-01 из docs/qa/sprint1-qa-report.md; 10b, 12b, 17b —
решения INTERNAL_API §11 (отзыв согласия родителем, цель social, plan:tick {skipped}).

Служебные проверки, которых нет в публичном API, идут так же, как это делали бы другие клиенты стенда:
  * «Что нового» (experience-config) и поддержка (support) — staff API с внутренним JWT `iss=admin-bff`, подписанным
    ключом admin-bff стенда (.dev/e2e/internal-keys.json), с actor и нужными правами (как будущий admin-bff);
  * исходящие сообщения бота — мок Telegram (`/_mock/calls`), блокировка бота — `/_mock/block` и webhook my_chat_member;
  * read-only запросы к БД (psql) — финальные статусы саги удаления, отметки слотов, основание согласия.
  * ДВА ТЕСТОВЫХ ИЗМЕНЕНИЯ БД (только dev-стенд, помечены в отчёте QA): `social.invite_redemptions.opened_at`
    сдвигается на 25 ч назад (AT-10, D-02, §11: «через 24 ч после открытия» без ожидания суток) и
    `not_before/scheduled_for` записи «пропуск» в notifications — на «сейчас» (AT-08: сообщение уходит утром
    следующего дня в слот-время). Шаг 17b на несколько секунд удерживает advisory-блокировку tick из сессии psql
    («идущий tick»), данные не меняются.
"""

from __future__ import annotations

import argparse
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
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo, available_timezones

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import internal_keys
from initdata import make_init_data

from tilhero_common.internal_auth import Actor, issue_token

ROOT = Path(__file__).resolve().parents[2]
E2E_DIR = ROOT / ".dev" / "e2e"
LOG_DIR = ROOT / ".dev" / "logs"
KEYS_FILE = E2E_DIR / "internal-keys.json"
CONTRACTS = ROOT / "packages" / "contracts" / "events"

BOT_TOKEN = os.environ.get("E2E_BOT_TOKEN", "123456789:dev-bot-token-change-me-0000000000")
INTERNAL_SECRET = os.environ.get("E2E_INTERNAL_JWT_SECRET", "e2e-internal-secret-0123456789abcdef-local")
WEBHOOK_SECRET = os.environ.get("E2E_WEBHOOK_SECRET", "e2e-webhook-secret-0123456789abcdefXYZ")
SCHEDULER_TOKEN = os.environ.get("E2E_SCHEDULER_TOKEN", "e2e-scheduler-token-0123456789abcdef-local")
INVITE_TOKEN_KEY = os.environ.get("E2E_INVITE_TOKEN_KEY", "e2e-invite-token-key-0123456789abcdef-local")
APP_LINK = os.environ.get("E2E_TELEGRAM_APP_LINK", "https://t.me/tilhero_e2e_bot/app")
MINIAPP_URL = os.environ.get("E2E_MINIAPP_URL", "https://miniapp.e2e.local")
DB = os.environ.get("E2E_DB", "tilhero")
MOCK_TG = os.environ.get("E2E_MOCK_TG", "http://127.0.0.1:8190")
IDENTITY = "http://127.0.0.1:8101"
LEARNING_PLAN = "http://127.0.0.1:8102"
SUPPORT = "http://127.0.0.1:8103"
NOTIFICATIONS = "http://127.0.0.1:8104"
AUDIT = "http://127.0.0.1:8105"
EXPERIENCE = "http://127.0.0.1:8106"
SOCIAL = "http://127.0.0.1:8109"
BOTGW = "http://127.0.0.1:8107"  # публичный порт: только webhook и health
BOTGW_INTERNAL = os.environ.get("E2E_BOTGW_INTERNAL", "http://127.0.0.1:8108")  # внутренний API (приватная сеть)

REQUIRED = ["terms", "privacy", "learning"]
DOMAINS = {"learning-plan", "social", "notifications", "support", "experience-config"}
SCHEMAS = ["identity_consent", "learning_plan", "social", "support", "notifications", "audit", "experience_config"]
# слова, которых не должно быть в детских сообщениях (CONVENTIONS §8)
HARSH = ("потер", "провал", "сгор", "серия прервал", "yoʻqot", "muvaffaqiyatsiz")
# IANA-зона, которую пропускает схема BFF (Timezone в services/telegram-bff/src/schemas.ts)
BFF_TZ_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+){0,2}$")


class StepFailed(AssertionError):
    pass


class StepSkipped(Exception):
    pass


CHECKS = [0]  # число выполненных проверок (check/expect) — для отчёта


def check(cond: Any, msg: object) -> None:
    CHECKS[0] += 1
    if not cond:
        raise StepFailed(str(msg)[:600])


def expect(resp: httpx.Response, status: int, code: str | None = None) -> dict[str, Any]:
    CHECKS[0] += 1
    body: Any
    try:
        body = resp.json() if resp.content else {}
    except ValueError:
        body = {"_raw": resp.text[:300]}
    if resp.status_code != status or (code is not None and (not isinstance(body, dict) or body.get("code") != code)):
        raise StepFailed(
            f"{resp.request.method} {resp.request.url.path}: ожидали {status}{' ' + code if code else ''}, "
            f"получили {resp.status_code} {str(body)[:400]}"
        )
    return body if isinstance(body, dict) else {"_list": body}


def wait_for(fn: Callable[[], Any], timeout: float = 30.0, interval: float = 0.5, what: str = "условие") -> Any:
    deadline = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    raise StepFailed(f"не дождались: {what} за {timeout:.0f} с (последнее значение: {str(last)[:300]})")


def sleep_until(at: datetime, what: str) -> None:
    left = (at - datetime.now(UTC)).total_seconds()
    if left > 0:
        print(f"      … ждём {what}: {left:.0f} с", flush=True)
        time.sleep(left)


def _psql(sql: str) -> str:
    """Запросы QA к БД dev-стенда (значения в SQL — только UUID/даты, полученные сценарием)."""
    return subprocess.run(
        ["psql", "-h", "127.0.0.1", "-U", "postgres", "-d", DB, "-tAc", sql],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def uid(value: str) -> str:
    return str(uuid.UUID(str(value)))  # только валидный UUID попадает в SQL


# ---------------------------------------------------------------- внутренние токены и вызовы служб

def ring(issuer: str) -> internal_keys.KeyRing:
    return internal_keys.keyring(KEYS_FILE, issuer)


def internal_token(issuer: str, audience: str, subject: str | None = None) -> dict[str, str]:
    return {"x-internal-token": issue_token(ring(issuer), issuer=issuer, audience=audience, subject=subject)}


def staff_headers(audience: str, permissions: list[str], actor_id: str | None = None) -> dict[str, str]:
    token = issue_token(
        ring("admin-bff"), issuer="admin-bff", audience=audience,
        actor=Actor(id=actor_id or str(uuid.uuid4()), role="support_agent", permissions=frozenset(permissions),
                    name="Алина Петрова"),
    )
    return {"x-internal-token": token}


def scheduler(url: str) -> dict[str, Any]:
    r = httpx.post(url, headers={"authorization": f"Bearer {SCHEDULER_TOKEN}"}, timeout=30)
    return expect(r, 200)


def plan_tick() -> dict[str, Any]:
    """plan:tick как n8n; если занято соседним tick (§11: {skipped: true}) — повтор через 0,5 с."""
    for _ in range(20):
        res = scheduler(f"{LEARNING_PLAN}/internal/v1/plan:tick")
        check("skipped" in res, f"в ответе plan:tick нет skipped (§11): {res}")
        if not res["skipped"]:
            return res
        time.sleep(0.5)
    raise StepFailed("plan:tick 10 с подряд отвечает skipped")


def dispatch() -> dict[str, Any]:
    return scheduler(f"{NOTIFICATIONS}/internal/v1/notifications:dispatch")


def invites_tick() -> dict[str, Any]:
    return scheduler(f"{SOCIAL}/internal/v1/invites:tick")


# ---------------------------------------------------------------- мок Telegram

def tg_calls(chat_id: int, after: int = 0) -> list[dict[str, Any]]:
    r = httpx.get(f"{MOCK_TG}/_mock/calls", params={"method": "sendMessage", "chat_id": str(chat_id),
                                                     "after": str(after)})
    r.raise_for_status()
    return r.json()["items"]


def tg_sent(chat_id: int, after: int = 0, contains: str | None = None) -> list[dict[str, Any]]:
    """Доставленные (мок вернул message_id) сообщения в чат, опционально — содержащие подстроку."""
    out = [c for c in tg_calls(chat_id, after) if isinstance(c.get("result"), dict) and "message_id" in c["result"]]
    if contains is not None:
        out = [c for c in out if contains in c["payload"].get("text", "")]
    return out


def tg_last_seq() -> int:
    return int(httpx.get(f"{MOCK_TG}/_mock/calls", params={"after": 10**9}).json()["last_seq"])


def tg_block(chat_id: int, blocked: bool) -> None:
    httpx.post(f"{MOCK_TG}/_mock/block", json={"chat_id": chat_id, "blocked": blocked}).raise_for_status()


def buttons(payload: dict[str, Any]) -> list[dict[str, Any]]:
    kb = (payload.get("reply_markup") or {}).get("inline_keyboard") or []
    return [b for row in kb for b in row]


def startapp_of(payload: dict[str, Any]) -> str | None:
    for b in buttons(payload):
        url = (b.get("web_app") or {}).get("url") or b.get("url") or ""
        q = parse_qs(urlsplit(url).query)
        if "startapp" in q:
            return q["startapp"][0]
    return None


# ---------------------------------------------------------------- часовые пояса

def _zones() -> list[str]:
    skip = ("Etc/", "SystemV/", "posix/", "right/", "US/", "Canada/", "Brazil/", "Mexico/", "Chile/")
    return [z for z in sorted(available_timezones())
            if "/" in z and not z.startswith(skip) and BFF_TZ_RE.fullmatch(z)]


ZONES = _zones()


def loc(at: datetime, zone: str) -> datetime:
    return at.astimezone(ZoneInfo(zone))


def hhmm(at: datetime, zone: str) -> str:
    return loc(at, zone).strftime("%H:%M")


def minutes_of_day(at: datetime, zone: str) -> int:
    t = loc(at, zone)
    return t.hour * 60 + t.minute


def pick_zone(at: datetime, lo: int, hi: int, target: int) -> str:
    """Зона, где местное время `at` в [lo, hi) минут суток, ближе всего к target."""
    best = [(abs(minutes_of_day(at, z) - target), z) for z in ZONES if lo <= minutes_of_day(at, z) < hi]
    if not best:
        raise StepFailed(f"нет часового пояса с местным временем {lo // 60:02d}:{lo % 60:02d}–{hi // 60:02d}:{hi % 60:02d}")
    return min(best)[1]


def pick_midnight_zone(at: datetime, min_after: timedelta) -> tuple[str, datetime]:
    """Зона с ближайшей местной полуночью, наступающей не раньше at + min_after (слот `at` — в тот же местный день)."""
    best: tuple[datetime, str] | None = None
    for z in ZONES:
        local = loc(at, z)
        midnight = datetime.combine(local.date() + timedelta(days=1), datetime.min.time(), tzinfo=ZoneInfo(z))
        mid_utc = midnight.astimezone(UTC)
        if mid_utc - at >= min_after and (best is None or mid_utc < best[0]):
            best = (mid_utc, z)
    assert best is not None
    return best[1], best[0]


# ---------------------------------------------------------------- пользователи и контекст

@dataclass
class U:
    ctx: Ctx
    role: str
    tg_id: int
    first: str
    username: str
    access: str = ""
    refresh: str = ""
    account_id: str = ""
    learner_id: str = ""
    session: dict[str, Any] = field(default_factory=dict)
    refresh_tokens: list[str] = field(default_factory=list)
    # зона устройства: Mini App шлёт X-Timezone с каждым запросом (bff.ts) — BFF создаёт план по умолчанию в ней
    device_tz: str | None = None

    def init_data(self, *, start_param: str | None = None, age: int = 0, bot_token: str = BOT_TOKEN) -> str:
        return make_init_data(self.tg_id, self.first, bot_token=bot_token, username=self.username,
                              start_param=start_param, age=age)

    def adopt(self, s: dict[str, Any]) -> dict[str, Any]:
        self.session = s
        self.access = s["access_token"]
        self.refresh = s["refresh_token"]
        self.refresh_tokens.append(self.refresh)
        self.account_id = s["account"]["user_id"]
        self.learner_id = s["learner"]["learner_id"]
        self.ctx.secrets[f"refresh {self.role}"] = self.refresh
        return s

    def login(self, start_param: str | None = None, status: int = 200) -> dict[str, Any]:
        r = self.ctx.bff.post("/v1/session/telegram", json={"init_data": self.init_data(start_param=start_param)},
                              headers={"x-timezone": self.device_tz} if self.device_tz else {})
        body = expect(r, status)
        return self.adopt(body) if status == 200 else body

    def h(self, extra: dict[str, str] | None = None, token: str | None = None) -> dict[str, str]:
        tz = {"x-timezone": self.device_tz} if self.device_tz else {}
        return {"authorization": f"Bearer {token or self.access}", **tz, **(extra or {})}

    def req(self, method: str, path: str, *, json: Any = None, params: dict[str, Any] | None = None,
            headers: dict[str, str] | None = None, idem: bool | str = False, if_match: int | None = None,
            token: str | None = None) -> httpx.Response:
        extra = dict(headers or {})
        if idem:
            extra["idempotency-key"] = idem if isinstance(idem, str) else str(uuid.uuid4())
        if if_match is not None:
            extra["if-match"] = str(if_match)
        r = self.ctx.bff.request(method, path, json=json, params=params, headers=self.h(extra, token))
        if token is None and r.status_code == 401 and r.json().get("code") == "TOKEN_EXPIRED" and self.refresh:
            # access-токен живёт 15 мин (сценарий ждёт полночь дольше) — как Mini App: refresh и повтор
            ref = self.ctx.bff.post("/v1/session/refresh", json={"refresh_token": self.refresh},
                                    headers={"x-timezone": self.device_tz} if self.device_tz else {})
            if ref.status_code == 200:
                self.adopt(ref.json())
                r = self.ctx.bff.request(method, path, json=json, params=params, headers=self.h(extra))
        return r

    def ok(self, method: str, path: str, status: int = 200, code: str | None = None, **kw: Any) -> dict[str, Any]:
        return expect(self.req(method, path, **kw), status, code)

    def switch(self, learner_id: str, pin: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"learner_id": learner_id}
        if pin:
            body["pin"] = pin
        return self.adopt(self.ok("POST", "/v1/session/learner", json=body))

    def inbox(self) -> list[dict[str, Any]]:
        return self.ok("GET", "/v1/notifications", params={"limit": 100})["items"]


@dataclass
class Ctx:
    bff: httpx.Client
    tag: str
    base_tg: int
    users: dict[str, U] = field(default_factory=dict)
    data: dict[str, Any] = field(default_factory=dict)
    secrets: dict[str, str] = field(default_factory=dict)  # что не должно попасть в логи
    seq: int = 0

    def user(self, role: str, first: str) -> U:
        self.seq += 1
        tg_id = self.base_tg + self.seq
        u = U(self, role, tg_id, f"{first} {self.tag}{role}", f"e2e_{self.tag.lower()}_{role.lower()}")
        self.users[role] = u
        return u


def onboard(u: U, *, zone: str, age: str | None = "18+", purposes: list[str] | None = None,
            categories: dict[str, bool] | None = None, schedule: dict[str, Any] | None = None,
            quiet: Any = "default", complete: bool = True) -> None:
    """Короткий онбординг взрослого/подростка (как Mini App): вход, возраст, согласия, цель, уровень, график,
    напоминания и часовой пояс, «готово». Зона устройства — `zone` (X-Timezone)."""
    u.device_tz = zone
    u.login()
    if age:
        u.ok("PUT", "/v1/profile/age", json={"age_band": age})
    pol = u.ctx.data["policy"]
    u.ok("POST", "/v1/profile/consent", json={"policy_version": pol["version"], "purposes": purposes or REQUIRED})
    plan_patch(u, {"goal": "travel", "level_self": "beginner"})
    sched = {"preset": "daily", "preferred_time": "19:00", "duration_min": 20, "reminders_enabled": False,
             "timezone": zone, **(schedule or {})}
    plan_patch(u, {"schedule": sched})
    notif: dict[str, Any] = {"enabled": True, "timezone": zone, "categories": categories or {}}
    if quiet != "default":
        notif["quiet_hours"] = quiet
    u.ok("PATCH", "/v1/profile/settings", json={"notifications": notif})
    if complete:
        p = u.ok("POST", "/v1/plan/onboarding/complete")
        check(p["onboarding_completed_at"], f"{u.role}: онбординг не завершён")


def plan_patch(u: U, patch: dict[str, Any], status: int = 200, code: str | None = None,
               if_match: int | None = None) -> dict[str, Any]:
    return u.ok("PATCH", "/v1/plan", status, code, json=patch, if_match=if_match)


def slot_schedule(at: datetime, zone: str, reminders: bool) -> dict[str, Any]:
    return {"preset": "custom", "days": [loc(at, zone).isoweekday()], "preferred_time": hhmm(at, zone),
            "duration_min": 15, "reminders_enabled": reminders, "timezone": zone}


# =============================================================================================== шаги

def s_stand(c: Ctx) -> None:
    for name, url in [("identity-consent", IDENTITY), ("learning-plan", LEARNING_PLAN), ("support", SUPPORT),
                      ("notifications", NOTIFICATIONS), ("audit", AUDIT), ("experience-config", EXPERIENCE),
                      ("social", SOCIAL), ("telegram-bot-gateway", BOTGW), ("telegram-bot-gateway (int)", BOTGW_INTERNAL),
                      ("telegram-bff", str(c.bff.base_url))]:
        r = httpx.get(f"{url}/health/ready", timeout=5)
        check(r.status_code == 200, f"{name} не ready: {r.status_code} {r.text[:200]}")
    c.data["dlq_before"] = dlq_counts()
    # окно plan:tick начинается с этого вызова (первый вызов на чистой БД только создаёт состояние)
    plan_tick()


# ---------------------------------------------------------------- AT-01

def s_initdata_rejected(c: Ctx) -> None:
    u = c.user("U1", "Игорь")
    u.device_tz = c.data["zone_day"]
    bff = c.bff
    forged = u.init_data(bot_token="999999:forged-token-forged-token-forged-xx")
    expect(bff.post("/v1/session/telegram", json={"init_data": forged}), 401, "INIT_DATA_INVALID")
    good = u.init_data()
    tampered = re.sub(r"auth_date=(\d+)", lambda m: f"auth_date={int(m.group(1)) - 1}", good)
    check(tampered != good, "не удалось подменить auth_date")
    expect(bff.post("/v1/session/telegram", json={"init_data": tampered}), 401, "INIT_DATA_INVALID")
    renamed = good.replace("e2e_", "e2f_", 1)
    expect(bff.post("/v1/session/telegram", json={"init_data": renamed}), 401, "INIT_DATA_INVALID")
    no_hash = re.sub(r"&?hash=[0-9a-f]+", "", good)
    expect(bff.post("/v1/session/telegram", json={"init_data": no_hash}), 401, "INIT_DATA_INVALID")
    old = u.init_data(age=3600)
    expect(bff.post("/v1/session/telegram", json={"init_data": old}), 401, "INIT_DATA_EXPIRED")
    stale = u.init_data(age=660)
    expect(bff.post("/v1/session/telegram", json={"init_data": stale}), 401, "INIT_DATA_EXPIRED")
    expect(bff.get("/v1/profile"), 401)
    expect(bff.get("/v1/profile", headers={"authorization": "Bearer x.y.z"}), 401)


def s_login(c: Ctx) -> None:
    u = c.users["U1"]
    once = u.init_data()
    s = u.adopt(expect(c.bff.post("/v1/session/telegram", json={"init_data": once}), 200))
    check(s["account"]["is_new"] is True, f"is_new={s['account']['is_new']}")
    check(s["account"]["status"] == "ACTIVE" and s["account"]["locale"] == "ru", s["account"])
    check(s["account"]["age_band"] is None and s["onboarding_completed"] is False, s)
    check(s["learner"]["kind"] == "self" and s["learner"]["learner_id"] == u.account_id, s["learner"])
    check(s["start_param"] is None, s["start_param"])
    check(str(u.tg_id) not in json.dumps(s), "Telegram ID в ответе сессии")
    # D-03: при первом входе план не создаётся (его создаст первый запрос плана с зоной клиента)
    n = _psql(f"SELECT count(*) FROM learning_plan.plans WHERE user_id = '{uid(u.account_id)}'")
    check(n == "0", f"план создан уже при первом входе: {n}")
    # initData одноразовый: тот же initData второй раз → 401 INIT_DATA_REPLAYED
    expect(c.bff.post("/v1/session/telegram", json={"init_data": once}), 401, "INIT_DATA_REPLAYED")
    first = u.account_id
    s2 = u.login()
    check(s2["account"]["user_id"] == first and s2["account"]["is_new"] is False, "повторный вход создал нового")
    # refresh-ротация
    old_refresh = u.refresh
    u.adopt(expect(c.bff.post("/v1/session/refresh", json={"refresh_token": u.refresh}), 200))
    check(u.account_id == first, "refresh сменил аккаунт")
    expect(c.bff.post("/v1/session/refresh", json={"refresh_token": old_refresh}), 401, "REFRESH_INVALID")
    # повтор использованного refresh отзывает сессию → новый вход
    expect(c.bff.get("/v1/profile", headers=u.h()), 401)
    u.login()
    expect(c.bff.get("/v1/profile", headers=u.h()), 200)


def s_directories(c: Ctx) -> None:
    u = c.users["U1"]
    goals = u.ok("GET", "/v1/directory/goals")["items"]
    check(len(goals) == 6 and all(g["label"]["ru"] and g["label"]["uz"] for g in goals), f"цели: {goals}")
    topics = u.ok("GET", "/v1/directory/topics")["items"]
    check(len(topics) == 12 and all(t["label"]["ru"] and t["label"]["uz"] for t in topics), f"темы: {len(topics)}")
    c.data["topics"] = [t["code"] for t in topics]
    for lang in ("ru", "uz"):
        pol = expect(c.bff.get("/v1/legal/policy", params={"lang": lang}), 200)
        codes = {p["code"]: p["required"] for p in pol["purposes"]}
        check(all(codes.get(p) is True for p in REQUIRED), f"обязательные цели: {codes}")
        check(codes.get("voice_recording") is False, f"запись голоса должна быть необязательной: {codes}")
        check(pol["text"] and pol["version"], "текст политики")
        if lang == "ru":
            c.data["policy"] = pol
    cats = u.ok("GET", "/v1/support/categories")["items"]
    check(any(x["code"] == "SCHEDULE_REMINDERS" for x in cats), f"категории поддержки: {cats}")
    cfg = expect(c.bff.get("/v1/experience/config"), 200)
    check(cfg["app"] == "miniapp" and cfg["theme"]["id"] in ("notebook", "notebook_dark"), cfg.get("theme", {}).get("id"))
    check({s["type"] for s in cfg["home"]["sections"]} >= {"today_plan", "whats_new"}, cfg["home"])
    plan = u.ok("GET", "/v1/plan")
    sch = plan["schedule"]
    check(plan["goal"] is None and plan["onboarding_completed_at"] is None, plan)
    check(sch["preset"] == "daily" and sch["days"] == [1, 2, 3, 4, 5, 6, 7] and sch["preferred_time"] == "19:00"
          and sch["duration_min"] == 20 and sch["reminders_enabled"] is False, f"план по умолчанию: {sch}")
    check(plan["course_pair"] == "ru-en" and plan["learner_id"] == u.account_id, plan)
    check(sch["timezone"] == c.data["zone_day"], f"план по умолчанию не в зоне X-Timezone: {sch['timezone']}")
    # «Что нового» до завершения онбординга — none
    wn = u.ok("GET", "/v1/whats-new")
    check(wn == {"mode": "none", "notes": []}, f"whats-new до онбординга: {wn}")


def s_plan_tz(c: Ctx) -> None:
    """D-03 / INTERNAL_API §11: план по умолчанию — в зоне клиента (?tz= важнее X-Timezone), при входе не создаётся."""
    n = c.user("Z1", "Азиз")
    n.login()
    check(_psql(f"SELECT count(*) FROM learning_plan.plans WHERE user_id = '{uid(n.account_id)}'") == "0",
          "план создан при первом входе")
    zone = "Europe/Moscow" if c.data["zone_day"] != "Europe/Moscow" else "Asia/Dubai"
    p = n.ok("GET", "/v1/plan", params={"tz": zone}, headers={"x-timezone": "Asia/Dubai"})
    check(p["schedule"]["timezone"] == zone,
          f"GET /v1/plan?tz={zone} (X-Timezone Asia/Dubai) → {p['schedule']['timezone']}")
    p = n.ok("GET", "/v1/plan", params={"tz": "Asia/Tokyo"})
    check(p["schedule"]["timezone"] == zone, f"зона существующего плана сменилась через ?tz=: {p['schedule']['timezone']}")
    n.ok("GET", "/v1/plan", 422, params={"tz": "not a zone"})
    # CORS: Mini App шлёт X-Timezone — заголовок разрешён в preflight
    r = c.bff.options("/v1/plan", headers={"origin": "http://127.0.0.1:5173", "access-control-request-method": "GET",
                                           "access-control-request-headers": "authorization,x-timezone"})
    allowed = r.headers.get("access-control-allow-headers", "").lower()
    check(r.status_code in (200, 204) and "x-timezone" in allowed, f"preflight X-Timezone: {r.status_code} {allowed}")


# ---------------------------------------------------------------- AT-02, AT-03 (взрослый), AT-04–06

def s_age_consent(c: Ctx) -> None:
    u = c.users["U1"]
    pol = c.data["policy"]
    # аккаунт не может быть 6–13 (ребёнок — только детский профиль родителя)
    u.ok("PUT", "/v1/profile/age", 422, "VALIDATION_ERROR", json={"age_band": "10-13"})
    p = u.ok("PUT", "/v1/profile/age", json={"age_band": "18+"})
    check(p["account"]["age_band"] == "18+" and p["account"]["guardian_consent"] == "not_required", p["account"])
    u.ok("PUT", "/v1/profile/age", 409, "AGE_ALREADY_SET", json={"age_band": "14-17"})
    u.ok("POST", "/v1/profile/consent", 422, "CONSENT_REQUIRED_PURPOSES",
         json={"policy_version": pol["version"], "purposes": ["terms", "privacy"]})
    u.ok("POST", "/v1/profile/consent", 409, "POLICY_VERSION_OUTDATED",
         json={"policy_version": "0.1", "purposes": REQUIRED})
    u.ok("POST", "/v1/profile/consent", 422, "CONSENT_PURPOSES_INVALID",
         json={"policy_version": pol["version"], "purposes": [*REQUIRED, "geo_tracking"]})
    # отказ от записи голоса онбординг не блокирует
    chosen = [*REQUIRED, "social", "product_news"]
    st = u.ok("POST", "/v1/profile/consent", json={"policy_version": pol["version"], "purposes": chosen})
    check(st["accepted"] is True and st["policy_version"] == pol["version"], st)
    check(st["accepted_at"] and st["evidence_hash"] and "voice_recording" not in st["purposes"], st)
    check(set(st["purposes"]) == set(chosen), st["purposes"])
    aid = uid(u.account_id)
    row = _psql(f"SELECT policy_version || '|' || basis || '|' || (accepted_at IS NOT NULL) || '|' || "
                f"coalesce(revoked_at::text, '-') FROM identity_consent.consents WHERE user_id = '{aid}' "
                "AND revoked_at IS NULL")
    check(row == f"{pol['version']}|self|true|-", f"согласие в БД: {row}")
    # отзыв фиксируется (дата и причина), повторное согласие — новая запись
    rv = u.ok("DELETE", "/v1/profile/consent")
    check(rv["accepted"] is False, rv)
    row = _psql(f"SELECT revoke_reason || '|' || (revoked_at IS NOT NULL) FROM identity_consent.consents "
                f"WHERE user_id = '{aid}' ORDER BY accepted_at DESC LIMIT 1")
    check(row == "user|true", f"отзыв в БД: {row}")
    st = u.ok("POST", "/v1/profile/consent", json={"policy_version": pol["version"], "purposes": chosen})
    check(st["accepted"] is True, st)
    n = _psql(f"SELECT count(*) FROM identity_consent.consents WHERE user_id = '{aid}'")
    check(n == "2", f"записей согласия: {n} (ожидали 2: отозванное + действующее)")
    prof = u.ok("GET", "/v1/profile")
    check(prof["notifications"]["enabled"] is True, f"согласие не включило уведомления: {prof['notifications']}")
    cats = prof["notifications"]["categories"]
    check(cats["support"] is True and not cats["reminders"] and not cats["missed"] and not cats["social"],
          f"категории по умолчанию: {cats}")
    # аудит: принятие и отзыв согласия (через шину, хеш-цепочка цела)
    hdr = staff_headers("audit", ["audit.read"])

    def actions() -> set[str]:
        r = httpx.get(f"{AUDIT}/admin/v1/audit/records", params={"actor_id": u.account_id, "limit": 50}, headers=hdr)
        return {x["action"] for x in expect(r, 200)["items"]}

    wait_for(lambda: {"consent.accept", "consent.revoke"} <= actions(), 20, what="consent.accept/revoke в audit")
    v = expect(httpx.get(f"{AUDIT}/admin/v1/audit/verify", headers=hdr), 200)
    check(v.get("valid") is True, f"цепочка аудита: {v}")


def s_onboarding(c: Ctx) -> None:
    u = c.users["U1"]
    z = c.data["zone_day"]
    # AT-05: язык интерфейса RU → UZ не меняет учебную пару
    prof = u.ok("PATCH", "/v1/profile/settings", json={"locale": "uz"})
    check(prof["account"]["locale"] == "uz", prof["account"])
    p = plan_patch(u, {"ui_lang": "uz"})
    check(p["ui_lang"] == "uz" and p["course_pair"] == "ru-en" and p["explain_lang"] == "ru", p)
    u.ok("PATCH", "/v1/profile/settings", json={"locale": "ru"})
    p = plan_patch(u, {"ui_lang": "ru"})
    check(p["ui_lang"] == "ru" and p["course_pair"] == "ru-en", p)
    # без цели и уровня онбординг не завершается
    body = u.ok("POST", "/v1/plan/onboarding/complete", 409, "PLAN_INCOMPLETE")
    check({"goal", "level_self"} <= set(body["details"].get("missing", [])), body)
    v0 = p["version"]
    p = plan_patch(u, {"goal": "travel"})
    check(p["goal"] == "travel" and p["version"] == v0 + 1, p)
    p = plan_patch(u, {"level_self": "beginner", "topics": c.data["topics"][:2]})
    check(p["level_self"] == "beginner" and p["topics"] == c.data["topics"][:2], p)
    # график: свои дни, своё время, длительность (AT-06) + проверки формы (PLAN_INVALID)
    plan_patch(u, {"schedule": {"duration_min": 25}}, 422, "PLAN_INVALID")
    plan_patch(u, {"schedule": {"days": []}}, 422, "PLAN_INVALID")
    plan_patch(u, {"schedule": {"preferred_time": "7:30"}}, 422, "PLAN_INVALID")
    body = plan_patch(u, {"schedule": {"timezone": "Mars/Olympus_Mons"}}, 422, "PLAN_INVALID")
    check(body["details"].get("field") == "schedule.timezone", body)
    plan_patch(u, {"topics": ["no-such-topic"]}, 422, "PLAN_INVALID")
    plan_patch(u, {"learner_id": str(uuid.uuid4())}, 422, "PLAN_INVALID")
    sched = {"preset": "custom", "days": [2, 4, 6], "preferred_time": "07:30", "duration_min": 15,
             "reminders_enabled": True, "timezone": z}
    p = plan_patch(u, {"schedule": sched})
    check({k: p["schedule"][k] for k in sched} == sched, f"график не сохранился: {p['schedule']}")
    # явное согласие на напоминания — и в настройках доставки (категории), как в Mini App (optInPatch)
    prof = u.ok("PATCH", "/v1/profile/settings", json={"notifications": {
        "enabled": True, "categories": {"reminders": True, "missed": True, "social": True}, "timezone": z}})
    cats = prof["notifications"]["categories"]
    check(cats["reminders"] and cats["missed"] and cats["social"] and prof["notifications"]["timezone"] == z, cats)
    done = u.ok("POST", "/v1/plan/onboarding/complete")
    check(done["onboarding_completed_at"], "onboarding_completed_at пуст")
    again = u.ok("POST", "/v1/plan/onboarding/complete")
    check(again["onboarding_completed_at"] == done["onboarding_completed_at"], "повтор complete изменил план")
    c.data["u1_plan"] = done


def s_relogin_same(c: Ctx) -> None:
    u = c.users["U1"]
    before = c.data["u1_plan"]
    s = u.login()
    check(s["account"]["user_id"] == before["learner_id"] and s["account"]["is_new"] is False, s["account"])
    check(s["onboarding_completed"] is True and s["learner"]["onboarding_completed"] is True, "онбординг после входа")
    p = u.ok("GET", "/v1/plan")
    for k in ("goal", "level_self", "topics", "schedule", "onboarding_completed_at", "course_pair"):
        check(p[k] == before[k], f"после повторного входа {k}: {p[k]} != {before[k]}")
    # изменение графика в профиле сохраняется на сервере; устаревшая версия → 409
    plan_patch(u, {"schedule": {"preferred_time": "08:00"}}, 409, "PLAN_VERSION_CONFLICT", if_match=p["version"] - 1)
    p2 = plan_patch(u, {"schedule": {"preset": "weekdays", "preferred_time": "18:30", "duration_min": 30}},
                    if_match=p["version"])
    check(p2["schedule"]["days"] == [1, 2, 3, 4, 5] and p2["schedule"]["preset"] == "weekdays", p2["schedule"])
    p2 = plan_patch(u, {"schedule": {"days": [1, 2, 3, 4, 5, 6]}})
    check(p2["schedule"]["preset"] == "custom", f"«поменял дни — custom»: {p2['schedule']}")
    u.login()
    p3 = u.ok("GET", "/v1/plan")
    check(p3["schedule"] == p2["schedule"] and p3["version"] == p2["version"], f"после входа: {p3['schedule']}")
    today = u.ok("GET", "/v1/plan/today")
    check(len(today["week"]) == 7 and today["duration_min"] == 30, today)
    # занятие: Idempotency-Key обязателен, повтор не учитывается дважды
    u.ok("POST", "/v1/plan/activity", 422, "IDEMPOTENCY_KEY_REQUIRED", json={"kind": "practice", "minutes": 10})
    key = str(uuid.uuid4())
    t1 = u.ok("POST", "/v1/plan/activity", json={"kind": "practice", "minutes": 10}, idem=key)
    t2 = u.ok("POST", "/v1/plan/activity", json={"kind": "practice", "minutes": 10}, idem=key)
    check(t1["minutes_today"] == 10 and t2["minutes_today"] == 10 and t1["done_today"], (t1, t2))


# ---------------------------------------------------------------- AT-11 «Что нового»

def _note(slug: str, audience: str, segments: dict[str, Any] | None = None, uz: bool = True) -> dict[str, Any]:
    body = {
        "slug": slug,
        "title": {"ru": f"Новое в TilHero {slug}", "uz": f"TilHero yangiliklari {slug}" if uz else ""},
        "items": [{"title": {"ru": "График в профиле", "uz": "Profilda jadval"},
                   "text": {"ru": "Меняйте дни и время занятий в профиле.",
                            "uz": "Mashgʻulot kunlari va vaqtini profilda oʻzgartiring."},
                   "link": "schedule", "icon": "calendar"}],
        "audience": audience,
    }
    if segments is not None:
        body["segments"] = segments
    return body


EDITOR_ID = str(uuid.uuid4())  # сотрудник-редактор «Что нового» этого прогона (аудит)


def _publish(body: dict[str, Any]) -> dict[str, Any]:
    # спринт 2: права «Что нового» — whatsnew.manage (черновик) и whatsnew.publish (публикация, архив)
    edit = staff_headers("experience-config", ["whatsnew.manage", "whatsnew.publish"], EDITOR_ID)
    note = expect(httpx.post(f"{EXPERIENCE}/admin/v1/release-notes", json=body,
                             headers={**edit, "idempotency-key": uuid.uuid4().hex}), 201)
    check(note.get("status") == "draft", note)
    pub = httpx.post(f"{EXPERIENCE}/admin/v1/release-notes/{note['release_note_id']}/publish",
                     json={"expected_version": note["version"], "reason": "e2e: публикация"},
                     headers={**edit, "idempotency-key": uuid.uuid4().hex})
    out = expect(pub, 201)
    check(out.get("status") == "published", out)
    return out


def s_whats_new(c: Ctx) -> None:
    u = c.users["U1"]
    wn = u.ok("GET", "/v1/whats-new")
    check(wn["mode"] == "welcome", f"после онбординга ожидали welcome: {wn['mode']}")
    slugs = [n["slug"] for n in wn["notes"]]
    check("welcome-1" in slugs and all(n["audience"] in ("new", "all") for n in wn["notes"]), slugs)
    welcome = next(n for n in wn["notes"] if n["slug"] == "welcome-1")
    check(len(welcome["items"]) == 5 and all(i["title"] for i in welcome["items"]), welcome)
    u.ok("POST", "/v1/whats-new/seen", 204, json={"release_note_ids": [n["release_note_id"] for n in wn["notes"]]})
    check(u.ok("GET", "/v1/whats-new")["mode"] == "none", "после seen шторка снова показывается")
    u.login()
    check(u.ok("GET", "/v1/whats-new")["mode"] == "none", "повторный вход: показано уже просмотренное")
    # центр уведомлений: первое чтение ставит водяной знак, новости продукта — категория product
    u.inbox()
    u.ok("PATCH", "/v1/profile/settings", json={"notifications": {"categories": {"product": True}}})

    # staff API: права и переводы
    body = _note(f"e2e-{c.tag.lower()}", "existing", {})
    # права конфигурации интерфейса (config.*) к заметкам отношения не имеют (спринт 2)
    r = httpx.post(f"{EXPERIENCE}/admin/v1/release-notes", json=body,
                   headers=staff_headers("experience-config", ["config.read", "config.edit", "config.publish"]))
    expect(r, 403, "PERMISSION_DENIED")
    r = httpx.post(f"{EXPERIENCE}/admin/v1/release-notes", json=body,
                   headers=internal_token("telegram-bff", "experience-config", u.account_id))
    check(r.status_code == 403, f"telegram-bff в staff API: {r.status_code}")
    r = httpx.post(f"{EXPERIENCE}/admin/v1/release-notes", json=_note(f"e2e-{c.tag.lower()}-x", "existing", uz=False),
                   headers=staff_headers("experience-config", ["whatsnew.manage"]))
    expect(r, 422, "RELEASE_NOTE_TRANSLATION_MISSING")
    note = _publish(body)
    note_uz = _publish(_note(f"e2e-{c.tag.lower()}-uz", "existing", {"ui_lang": ["uz"]}))
    note_kids = _publish(_note(f"e2e-{c.tag.lower()}-kids", "all", {"age": ["kids"]}))
    c.data["notes"] = [note, note_uz, note_kids]

    u.login()
    wn = u.ok("GET", "/v1/whats-new")
    ids = [n["release_note_id"] for n in wn["notes"]]
    check(wn["mode"] == "updates" and ids == [note["release_note_id"]],
          f"следующий вход: {wn['mode']} {ids} (ждали {note['release_note_id']})")
    check(wn["notes"][0]["title"].startswith("Новое в TilHero"), wn["notes"][0]["title"])
    u.ok("POST", "/v1/whats-new/seen", 204, json={"release_note_ids": ids})
    u.login()
    check(u.ok("GET", "/v1/whats-new")["mode"] == "none", "заметка показана второй раз")
    feed = [n["release_note_id"] for n in u.ok("GET", "/v1/news")["items"]]
    check(note["release_note_id"] in feed and note_uz["release_note_id"] not in feed
          and note_kids["release_note_id"] not in feed, f"лента: {feed[:5]}")
    # центр уведомлений: новость продукта — только в приложении, кнопка «Новости»
    def product() -> list[dict[str, Any]]:
        return [i for i in u.inbox() if i["category"] == "product"]

    items = wait_for(product, 20, what="«Что нового» в центре уведомлений (категория product)")
    check(len(items) == 1 and items[0]["startapp"] == "route_news" and items[0]["telegram"] == "in_app_only", items)


def s_whats_new_newcomer(c: Ctx) -> None:
    """Новичок после публикации existing-заметки видит знакомство (new), а не updates."""
    n = c.user("N1", "Шахзода")
    onboard(n, zone=c.data["zone_day"])
    wn = n.ok("GET", "/v1/whats-new")
    slugs = [x["slug"] for x in wn["notes"]]
    check(wn["mode"] == "welcome" and "welcome-1" in slugs, f"новичок: {wn['mode']} {slugs}")
    check(not any(s.startswith("e2e-") for s in slugs), f"новичку попала existing-заметка: {slugs}")
    # язык интерфейса — locale аккаунта (§11): UZ → тексты знакомства на узбекском
    n.ok("PATCH", "/v1/profile/settings", json={"locale": "uz"})
    wn_uz = n.ok("GET", "/v1/whats-new")
    check(wn_uz["notes"] and wn_uz["notes"][0]["title"] != wn["notes"][0]["title"], "UZ-текст знакомства")
    # сегмент ui_lang=uz виден ученику с интерфейсом UZ (лента «Новости»), kids — нет
    feed = [x["release_note_id"] for x in n.ok("GET", "/v1/news")["items"]]
    by_slug = {x["release_note_id"]: x for x in c.data.get("notes", [])}
    uz_id = next(k for k, v in by_slug.items() if v["slug"].endswith("-uz"))
    kids_id = next(k for k, v in by_slug.items() if v["slug"].endswith("-kids"))
    check(uz_id in feed and kids_id not in feed, f"лента UZ взрослого: uz={uz_id in feed} kids={kids_id in feed}")


# ---------------------------------------------------------------- AT-07/08/13: подготовка слотов

def s_slots_setup(c: Ctx) -> None:
    now = datetime.now(UTC)
    # слот — граница минуты с запасом на подготовку учеников (минуты зон :00/:30/:45 совпадают)
    t = (now + timedelta(seconds=40)).replace(second=0, microsecond=0) + timedelta(minutes=1)
    z = c.data["zone_day"]
    z2 = pick_zone(t, 6 * 60, 7 * 60 + 58, 7 * 60 + 58)  # утро до 08:00: ребёнку — отложить до начала окна
    z3 = pick_zone(t, 20 * 60 + 5, 21 * 60 + 45, 20 * 60 + 50)  # вечер после 20:00: ребёнку — только центр
    zm, midnight = pick_midnight_zone(t, timedelta(minutes=3))
    kid_window = datetime.combine(loc(t, z2).date(), datetime.min.time().replace(hour=8),
                                  tzinfo=ZoneInfo(z2)).astimezone(UTC)
    c.data.update(slot=t, zone_morning=z2, zone_evening=z3, zone_midnight=zm, midnight=midnight,
                  kid_window=kid_window)
    print(f"      слот {t:%H:%M:%S}Z; день {z} {hhmm(t, z)}, утро {z2} {hhmm(t, z2)}, вечер {z3} {hhmm(t, z3)}, "
          f"полночь {zm} {hhmm(t, zm)} → {midnight:%H:%M}Z", flush=True)

    r1 = c.user("R1", "Рустам")
    onboard(r1, zone=z, categories={"reminders": True}, schedule=slot_schedule(t, z, True))
    r2 = c.user("R2", "Бахром")  # напоминания в плане выключены, категория включена
    onboard(r2, zone=z, categories={"reminders": True, "social": True}, schedule=slot_schedule(t, z, False),
            purposes=[*REQUIRED, "social"])
    r3 = c.user("R3", "Феруза")  # напоминания в плане включены, категория выключена (AT-13)
    onboard(r3, zone=z, categories={"reminders": False, "social": True}, schedule=slot_schedule(t, z, True),
            purposes=[*REQUIRED, "social"])
    q1 = c.user("Q1", "Лазиз")  # тихие часы: с прошлой минуты до слот + 1 мин
    quiet = {"start": hhmm(now - timedelta(minutes=1), z), "end": hhmm(t + timedelta(minutes=1), z)}
    onboard(q1, zone=z, categories={"reminders": True}, schedule=slot_schedule(t, z, True), quiet=quiet)
    c.data["quiet_end"] = t + timedelta(minutes=1)

    # родитель с двумя детскими профилями: ребёнок в окне 08–20 (зона «день») и вне окна (зона «вечер»)
    p = c.user("P", "Дилноза")
    onboard(p, zone=z, categories={"reminders": True, "social": True})
    s = p.session
    old_access = p.access
    kid = p.ok("POST", "/v1/learners", 201, json={"display_name": f"Мадина {c.tag}K", "age_band": "10-13"}, idem=True)
    check(kid["kind"] == "child" and kid["age_band"] == "10-13" and kid["onboarding_completed"] is False, kid)
    # AT-02: согласие за ребёнка фиксируется с основанием guardian и id родителя
    row = _psql("SELECT basis || '|' || coalesce(granted_by_user_id::text, '-') || '|' || policy_version FROM "
                f"identity_consent.consents WHERE user_id = '{uid(kid['learner_id'])}' AND revoked_at IS NULL")
    check(row == f"guardian|{uid(p.account_id)}|{c.data['policy']['version']}", f"согласие ребёнка: {row}")
    p.switch(kid["learner_id"])
    check(p.session["learner"]["kind"] == "child" and p.session["account"]["user_id"] == s["account"]["user_id"],
          p.session["learner"])
    # прежний access-токен после переключения ученика → 401 TOKEN_EXPIRED {reason: learner_switched}
    r = c.bff.get("/v1/plan", headers=p.h(token=old_access))
    body = expect(r, 401, "TOKEN_EXPIRED")
    check(body["details"].get("reason") == "learner_switched", body)
    plan_patch(p, {"goal": "study", "level_self": "zero", "schedule": slot_schedule(t, z, True)})
    p.ok("PATCH", "/v1/profile/settings", json={"notifications": {"categories": {"reminders": True}, "timezone": z}})
    check(p.ok("POST", "/v1/plan/onboarding/complete")["onboarding_completed_at"], "онбординг ребёнка")
    # в детском профиле: приглашения и поддержка недоступны, удаление — только взрослому
    p.ok("POST", "/v1/invites", 403, "INVITES_NOT_ALLOWED", json={"kind": "friend"}, idem=True)
    p.ok("POST", "/v1/support/tickets", 403, "ADULT_REQUIRED", idem=True,
         json={"category": "OTHER", "subject": "Тест", "message": "Тест"})
    p.ok("POST", "/v1/profile/delete-request", 403, "ADULT_REQUIRED", json={"confirm_word": "УДАЛИТЬ"})
    # §11: согласие и возраст — аккаунта родителя, в детском профиле → 403
    p.ok("POST", "/v1/profile/consent", 403, "ADULT_REQUIRED",
         json={"policy_version": c.data["policy"]["version"], "purposes": REQUIRED})
    p.ok("DELETE", "/v1/profile/consent", 403, "ADULT_REQUIRED")
    p.ok("PUT", "/v1/profile/age", 403, "ADULT_REQUIRED", json={"age_band": "18+"})
    p.ok("GET", "/v1/family/guardian-consents", 403, "ADULT_REQUIRED")
    p.switch(p.account_id)
    # ребёнок 6–9 утром до 08:00 (тихие часы сняты — причина отсрочки только окно детей) и 10–13 вечером
    kids = {}
    for key, name, band, zone, kid_quiet in (("kid2", f"Алия {c.tag}K", "6-9", z2, None),
                                             ("kid3", f"Камрон {c.tag}K", "10-13", z3, "default")):
        k = p.ok("POST", "/v1/learners", 201, json={"display_name": name, "age_band": band}, idem=True)
        p.switch(k["learner_id"])
        plan_patch(p, {"goal": "study", "level_self": "zero", "schedule": slot_schedule(t, zone, True)})
        notif: dict[str, Any] = {"categories": {"reminders": True}, "timezone": zone}
        if kid_quiet is None:
            notif["quiet_hours"] = None
        p.ok("PATCH", "/v1/profile/settings", json={"notifications": notif})
        p.ok("POST", "/v1/plan/onboarding/complete")
        kids[key] = k["learner_id"]
        c.data[f"{key}_name"] = name
        p.switch(p.account_id)  # создать следующего ребёнка можно только из профиля родителя
    learners = p.ok("GET", "/v1/learners")["items"]
    check([x["kind"] for x in learners] == ["self", "child", "child", "child"]
          and all(x["onboarding_completed"] for x in learners), learners)
    c.data.update(kid=kid["learner_id"], kid_name=f"Мадина {c.tag}K", **kids)

    # пропуск: слот в зоне «перед полуночью»; M1 без занятия, M2 занимается в тот же день
    for role, name in (("M1", "Отабек"), ("M2", "Гулноза")):
        m = c.user(role, name)
        onboard(m, zone=zm, categories={"missed": True, "social": True}, quiet=None,
                schedule=slot_schedule(t, zm, False), purposes=[*REQUIRED, "social"])
    c.data["missed_date"] = loc(t, zm).date()

    lead = (t - datetime.now(UTC)).total_seconds()
    check(lead > 20, f"подготовка заняла слишком долго: до слота {lead:.0f} с — сценарий нужно ускорить")
    plan_tick()  # начало окна — до слота


# ---------------------------------------------------------------- AT-03 подросток

def s_teen(c: Ctx) -> None:
    t = c.user("T1", "Тимур")
    t.device_tz = c.data["zone_day"]
    t.login()
    p = t.ok("PUT", "/v1/profile/age", json={"age_band": "14-17"})
    check(p["account"]["guardian_consent"] == "pending", p["account"])
    pol = c.data["policy"]
    t.ok("POST", "/v1/profile/consent", 403, "GUARDIAN_CONSENT_REQUIRED",
         json={"policy_version": pol["version"], "purposes": [*REQUIRED, "voice_recording"]})
    t.ok("POST", "/v1/profile/consent", 403, "GUARDIAN_CONSENT_REQUIRED",
         json={"policy_version": pol["version"], "purposes": [*REQUIRED, "social"]})
    st = t.ok("POST", "/v1/profile/consent", json={"policy_version": pol["version"], "purposes": REQUIRED})
    check(st["accepted"] and set(st["purposes"]) == set(REQUIRED), st)
    t.ok("POST", "/v1/invites", 403, "INVITES_NOT_ALLOWED", json={"kind": "friend"}, idem=True)
    t.ok("POST", "/v1/invites", 403, "ADULT_REQUIRED", json={"kind": "family"}, idem=True)
    t.ok("POST", "/v1/learners", 403, "ADULT_REQUIRED", json={"display_name": "Сестра", "age_band": "6-9"})
    # обучение и напоминания подростку доступны без согласия родителя: план со слотом шага 16
    plan_patch(t, {"goal": "exam", "level_self": "some", "schedule": slot_schedule(c.data["slot"], c.data["zone_day"],
                                                                                   True)})
    t.ok("PATCH", "/v1/profile/settings", json={"notifications": {
        "enabled": True, "categories": {"reminders": True}, "timezone": c.data["zone_day"]}})
    check(t.ok("POST", "/v1/plan/onboarding/complete")["onboarding_completed_at"], "онбординг подростка")
    # приглашение от взрослого подросток без согласия родителя открыть может, принять — нет
    u1 = c.users["U1"]
    fr = u1.ok("POST", "/v1/invites", 201, json={"kind": "friend"}, idem=True)
    ftoken = fr["link"].split("startapp=inv_", 1)[1]
    c.secrets["токен приглашения (друг, подросток)"] = ftoken
    pv = t.ok("POST", "/v1/invites/open", json={"token": ftoken})
    check(pv["can_accept"] is False and pv["reason"] == "not_allowed", f"подросток до согласия: {pv}")
    t.ok("POST", f"/v1/invites/{fr['invite_id']}/accept", 403, "INVITES_NOT_ALLOWED")
    # повторный запрос ссылки отзывает прежнюю
    first = t.ok("POST", "/v1/profile/guardian-consent")["link"].split("startapp=gc_", 1)[1]
    c.secrets["токен согласия родителя (первый)"] = first
    link = t.ok("POST", "/v1/profile/guardian-consent")["link"]
    check(link.startswith(f"{APP_LINK}?startapp=gc_"), link)
    token = link.split("startapp=gc_", 1)[1]
    check(token != first, "повторный запрос вернул ту же ссылку")
    c.secrets["токен согласия родителя"] = token
    t.ok("POST", f"/v1/guardian-consents/{token}/accept", 409, "GUARDIAN_CONSENT_SELF")
    pv = expect(c.bff.get(f"/v1/guardian-consents/{token}"), 200)
    check(pv["teen_display_name"] == t.first and pv["status"] == "pending", pv)
    expect(c.bff.get(f"/v1/guardian-consents/{'A' * 43}"), 404, "GUARDIAN_CONSENT_NOT_FOUND")
    # родитель открывает ссылку (deep link gc_ → start_param); решить может только 18+ со своим согласием (§11)
    g = c.user("U2", "Нигора")
    g.device_tz = c.data["zone_day"]
    s = g.login(start_param=f"gc_{token}")
    check(s["start_param"] == f"gc_{token}", f"start_param: {s['start_param']}")
    g.ok("POST", f"/v1/guardian-consents/{token}/accept", 403, "ADULT_REQUIRED")
    g.ok("PUT", "/v1/profile/age", json={"age_band": "18+"})
    body = g.ok("POST", f"/v1/guardian-consents/{token}/accept", 403, "CONSENT_REQUIRED")
    check(body["details"].get("purpose") == "terms", f"родитель без своего согласия: {body}")
    g.ok("POST", "/v1/profile/consent", json={"policy_version": pol["version"], "purposes": [*REQUIRED, "social"]})
    g.ok("POST", f"/v1/guardian-consents/{first}/accept", 410, "GUARDIAN_CONSENT_EXPIRED")
    g.ok("PATCH", "/v1/profile/settings", json={"notifications": {
        "enabled": True, "categories": {"social": True}, "timezone": c.data["zone_day"]}})
    dec = g.ok("POST", f"/v1/guardian-consents/{token}/accept")
    check(dec["status"] == "granted", dec)
    # согласие родителя — запись consents подростка с основанием guardian (evidence), событие consent.accepted.v1
    row = _psql("SELECT basis || '|' || coalesce(granted_by_user_id::text, '-') || '|' || policy_version || '|' || "
                "(evidence_hash IS NOT NULL) FROM identity_consent.consents "
                f"WHERE user_id = '{uid(t.account_id)}' AND basis = 'guardian' AND revoked_at IS NULL")
    check(row == f"guardian|{uid(g.account_id)}|{pol['version']}|true", f"согласие родителя в БД: {row}")
    ev = _psql("SELECT count(*) FROM identity_consent.outbox WHERE event_type = 'consent.accepted.v1' AND "
               f"envelope->'payload'->>'user_id' = '{uid(t.account_id)}' AND envelope->'payload'->>'basis' = 'guardian'")
    check(ev == "1", f"consent.accepted.v1 {{basis: guardian}}: {ev}")
    t.login()
    check(t.session["account"]["guardian_consent"] == "granted", t.session["account"])
    st = t.ok("POST", "/v1/profile/consent", json={"policy_version": pol["version"],
                                                   "purposes": [*REQUIRED, "voice_recording", "social"]})
    check("voice_recording" in st["purposes"], st)
    inv = t.ok("POST", "/v1/invites", 201, json={"kind": "friend"}, idem=True)
    check(inv["kind"] == "friend" and inv["status"] == "active", inv)
    t.ok("POST", "/v1/invites", 403, "ADULT_REQUIRED", json={"kind": "family"}, idem=True)
    pv = t.ok("POST", "/v1/invites/open", json={"token": ftoken})
    check(pv["can_accept"] is True, f"подросток после согласия: {pv}")
    t.ok("POST", f"/v1/invites/{fr['invite_id']}/accept")
    c.data["teen_invite"] = inv["invite_id"]


def s_teen_revoke(c: Ctx) -> None:
    """§11: родитель отзывает согласие за подростка — необязательные функции снова закрыты, обучение и напоминания
    работают (напоминание подростку — в шаге 16)."""
    t, g, u1 = c.users["T1"], c.users["U2"], c.users["U1"]
    pol = c.data["policy"]
    grants = g.ok("GET", "/v1/family/guardian-consents")["items"]
    mine = [x for x in grants if x["teen_user_id"] == t.account_id]
    check(len(mine) == 1 and mine[0]["status"] == "granted" and mine[0]["teen_display_name"] == t.first, grants)
    check(not u1.ok("GET", "/v1/family/guardian-consents")["items"], "чужие решения в списке другого взрослого")
    u1.ok("POST", f"/v1/family/guardian-consents/{t.account_id}/revoke", 404, "GUARDIAN_CONSENT_NOT_FOUND")
    g.ok("POST", f"/v1/family/guardian-consents/{uuid.uuid4()}/revoke", 404, "GUARDIAN_CONSENT_NOT_FOUND")
    t.ok("POST", f"/v1/family/guardian-consents/{t.account_id}/revoke", 404, "GUARDIAN_CONSENT_NOT_FOUND")
    rv = g.ok("POST", f"/v1/family/guardian-consents/{t.account_id}/revoke")
    check(rv["status"] == "declined" and rv["teen_user_id"] == t.account_id, rv)
    rv2 = g.ok("POST", f"/v1/family/guardian-consents/{t.account_id}/revoke")
    check(rv2["status"] == "declined", f"повтор отзыва: {rv2}")
    row = _psql("SELECT coalesce(revoke_reason, '-') || '|' || (revoked_at IS NOT NULL) FROM identity_consent.consents "
                f"WHERE user_id = '{uid(t.account_id)}' AND basis = 'guardian' ORDER BY accepted_at DESC LIMIT 1")
    check(row == "guardian|true", f"согласие родителя после отзыва: {row}")
    ev = _psql("SELECT count(*) FROM identity_consent.outbox WHERE event_type = 'consent.revoked.v1' AND "
               f"envelope->'payload'->>'user_id' = '{uid(t.account_id)}' AND envelope->'payload'->>'basis' = 'guardian'")
    check(ev == "1", f"consent.revoked.v1 {{basis: guardian}}: {ev}")
    s = t.login()
    check(s["account"]["guardian_consent"] == "declined", s["account"])
    check(s["consent"]["accepted"] is True and set(s["consent"]["purposes"]) == set(REQUIRED),
          f"после отзыва у подростка остались необязательные цели: {s['consent']}")
    # необязательные функции снова недоступны
    t.ok("POST", "/v1/profile/consent", 403, "GUARDIAN_CONSENT_REQUIRED",
         json={"policy_version": pol["version"], "purposes": [*REQUIRED, "voice_recording"]})
    t.ok("POST", "/v1/invites", 403, "INVITES_NOT_ALLOWED", json={"kind": "friend"}, idem=True)
    fr = u1.ok("POST", "/v1/invites", 201, json={"kind": "friend"}, idem=True)
    ftoken = fr["link"].split("startapp=inv_", 1)[1]
    c.secrets["токен приглашения (друг, подросток после отзыва)"] = ftoken
    pv = t.ok("POST", "/v1/invites/open", json={"token": ftoken})
    check(pv["can_accept"] is False and pv["reason"] == "not_allowed", f"после отзыва: {pv}")
    t.ok("POST", f"/v1/invites/{fr['invite_id']}/accept", 403, "INVITES_NOT_ALLOWED")
    # обучение работает: план, правка, план на сегодня (занятие не пишем — иначе не будет напоминания в слот)
    p = plan_patch(t, {"topics": c.data["topics"][:1]})
    check(p["topics"] == c.data["topics"][:1] and p["schedule"]["reminders_enabled"] is True, p)
    check(t.ok("GET", "/v1/plan/today")["is_scheduled_today"] is True, "план на сегодня подростка")
    check(g.ok("GET", "/v1/family/guardian-consents")["items"][0]["status"] == "declined", "статус в списке родителя")


def s_child_pin(c: Ctx) -> None:
    """AT-03: детский профиль у родителя; выход из него при заданном коде родителя — только с кодом (§10)."""
    p = c.user("P2", "Шерзод")
    onboard(p, zone=c.data["zone_day"])
    kid = p.ok("POST", "/v1/learners", 201, json={"display_name": f"Сардор {c.tag}K", "age_band": "6-9"}, idem=True)
    c.data["kid_p2_name"] = f"Сардор {c.tag}K"
    sec = p.ok("PUT", "/v1/profile/security/pin", json={"pin": "2580"})
    check(sec["pin_enabled"] is True, sec)
    p.switch(kid["learner_id"])
    check(p.session["learner"]["kind"] == "child", p.session["learner"])
    # в детском профиле код родителя и биометрию не поменять
    p.ok("PUT", "/v1/profile/security/pin", 403, "ADULT_REQUIRED", json={"pin": "1111"})
    body = p.ok("POST", "/v1/session/learner", 401, "PIN_INVALID", json={"learner_id": p.account_id})
    check(body["details"].get("reason") == "missing", body)
    p.ok("POST", "/v1/session/learner", 401, "PIN_INVALID", json={"learner_id": p.account_id, "pin": "9731"})
    p.switch(p.account_id, pin="2580")
    check(p.session["learner"]["kind"] == "self", p.session["learner"])
    # новый вход с заданным кодом: до подтверждения — 423 PIN_REQUIRED
    s = p.login()
    check(s["security"]["pin_required"] is True, s["security"])
    p.ok("GET", "/v1/profile", 423, "PIN_REQUIRED")
    p.adopt(p.ok("POST", "/v1/session/pin/verify", json={"pin": "2580"}))
    p.ok("GET", "/v1/profile")


# ---------------------------------------------------------------- AT-09 приглашение в семью

def _webhook(update: dict[str, Any], secret: str | None = WEBHOOK_SECRET) -> httpx.Response:
    headers = {"x-telegram-bot-api-secret-token": secret} if secret is not None else {}
    return httpx.post(f"{BOTGW}/telegram/webhook", json=update, headers=headers, timeout=5)


def _start_update(u: U, text: str) -> dict[str, Any]:
    return {
        "update_id": secrets.randbelow(2_000_000_000),
        "message": {"message_id": 1, "date": int(time.time()), "text": text,
                    "chat": {"id": u.tg_id, "type": "private"},
                    "from": {"id": u.tg_id, "is_bot": False, "first_name": u.first, "language_code": "ru"},
                    "entities": [{"type": "bot_command", "offset": 0, "length": 6}]},
    }


def s_family_invite(c: Ctx) -> None:
    u1, u2 = c.users["U1"], c.users["U2"]
    u1.ok("POST", "/v1/invites", 422, "IDEMPOTENCY_KEY_REQUIRED", json={"kind": "family"})
    key = str(uuid.uuid4())
    inv = u1.ok("POST", "/v1/invites", 201, json={"kind": "family"}, idem=key)
    again = u1.req("POST", "/v1/invites", json={"kind": "family"}, idem=key)
    check(again.status_code in (200, 201) and again.json()["invite_id"] == inv["invite_id"], "повтор Idempotency-Key")
    check(inv["link"].startswith(f"{APP_LINK}?startapp=inv_") and inv["status"] == "active", inv)
    check(inv["expires_at"], "семейная ссылка без срока")
    token = inv["link"].split("startapp=inv_", 1)[1]
    c.secrets["токен приглашения (семья)"] = token
    c.data["family_invite"] = inv["invite_id"]
    # бот: /start inv_<token> → кнопка-ссылка Mini App с тем же startapp (deep link)
    body = expect(_webhook(_start_update(u2, f"/start inv_{token}")), 200)
    check(body.get("method") == "sendMessage" and startapp_of(body) == f"inv_{token}", f"/start: {body}")
    expect(_webhook(_start_update(u2, "/start"), "wrong-secret"), 401)
    # самоприглашение
    pv = u1.ok("POST", "/v1/invites/open", json={"token": token})
    check(pv["can_accept"] is False and pv["reason"] == "self", pv)
    u1.ok("POST", f"/v1/invites/{inv['invite_id']}/accept", 409, "INVITE_SELF")
    u1.ok("POST", "/v1/invites/open", 404, "INVITE_NOT_FOUND", json={"token": "A" * 32})
    # получатель открывает ссылку (start_param), видит имя пригласившего и принимает
    seq = tg_last_seq()
    s = u2.login(start_param=f"inv_{token}")
    check(s["start_param"] == f"inv_{token}", s["start_param"])
    pv = u2.ok("POST", "/v1/invites/open", json={"token": token})
    check(pv["can_accept"] is True and pv["kind"] == "family" and pv["inviter_display_name"] == u1.first, pv)
    check(u1.username not in json.dumps(pv) and str(u1.tg_id) not in json.dumps(pv), "username/Telegram ID в карточке")
    res = u2.ok("POST", f"/v1/invites/{inv['invite_id']}/accept")
    members = {m["user_id"]: m for m in res["family"]["members"]}
    check(members.get(u1.account_id, {}).get("role") == "owner" and members.get(u2.account_id, {}).get("is_me"),
          res["family"])
    res2 = u2.ok("POST", f"/v1/invites/{inv['invite_id']}/accept")
    check(res2["invite_id"] == inv["invite_id"], "повтор принятия")
    fam = u1.ok("GET", "/v1/family")
    check(any(m["user_id"] == u2.account_id and m["role"] == "adult" for m in fam["members"]), fam)
    # пригласившему — сообщение с именем принявшего и кнопкой «Семья»
    msgs = wait_for(lambda: tg_sent(u1.tg_id, seq, contains=u2.first), 30, what="сообщение пригласившему о принятии")
    check(len(msgs) == 1, f"сообщений пригласившему: {len(msgs)}")
    check(startapp_of(msgs[0]["payload"]) == "route_family", msgs[0]["payload"])
    # повторная активация одноразовой ссылки
    r2 = c.users["R2"]
    pv = r2.ok("POST", "/v1/invites/open", json={"token": token})
    check(pv["can_accept"] is False and pv["reason"] in ("already_used",), pv)
    r2.ok("POST", f"/v1/invites/{inv['invite_id']}/accept", 409, "INVITE_ALREADY_USED")
    lst = u1.ok("GET", "/v1/invites")["items"]
    check(any(i["invite_id"] == inv["invite_id"] and i["status"] == "accepted" and i["accepted_count"] == 1
              for i in lst), lst)
    # отклонение: пригласившему — только центр уведомлений, без Telegram
    seq = tg_last_seq()
    fr = u1.ok("POST", "/v1/invites", 201, json={"kind": "friend"}, idem=True)
    ftoken = fr["link"].split("startapp=inv_", 1)[1]
    c.secrets["токен приглашения (друг, отклонено)"] = ftoken
    r3 = c.users["R3"]
    r3.ok("POST", "/v1/invites/open", json={"token": ftoken})
    dv = r3.ok("POST", f"/v1/invites/{fr['invite_id']}/decline")
    check(dv["invite_id"] == fr["invite_id"], dv)

    def declined() -> list[dict[str, Any]]:
        return [i for i in u1.inbox() if i["title"] == "Приглашение отклонено"]

    items = wait_for(declined, 20, what="«Приглашение отклонено» в центре пригласившего")
    check(items[0]["telegram"] == "in_app_only", items[0])
    time.sleep(1)
    check(not tg_sent(u1.tg_id, seq), f"отклонение ушло в Telegram: {tg_sent(u1.tg_id, seq)}")


# ---------------------------------------------------------------- AT-10 напоминание о неотвеченном приглашении

def s_invite_reminder(c: Ctx) -> None:
    u1 = c.users["U1"]
    u5 = c.user("U5", "Санжар")
    onboard(u5, zone=c.data["zone_day"], categories={"social": True}, purposes=[*REQUIRED, "social"])
    inv = u1.ok("POST", "/v1/invites", 201, json={"kind": "friend"}, idem=True)
    token = inv["link"].split("startapp=inv_", 1)[1]
    c.secrets["токен приглашения (друг)"] = token
    c.data["friend_invite"] = inv["invite_id"]
    pv = u5.ok("POST", "/v1/invites/open", json={"token": token})
    check(pv["can_accept"] is True, pv)
    check(u5.req("GET", "/v1/family").status_code == 204, "семьи нет — ожидали 204")
    seq = tg_last_seq()
    invites_tick()
    time.sleep(2)
    check(not tg_sent(u5.tg_id, seq), "напоминание пришло раньше 24 ч")
    # ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: открытие «25 часов назад» (ждать сутки на стенде нельзя)
    iid, invitee = uid(inv["invite_id"]), uid(u5.account_id)
    _psql(f"UPDATE social.invite_redemptions SET opened_at = opened_at - interval '25 hours' "
          f"WHERE invite_id = '{iid}' AND invitee_user_id = '{invitee}'")
    res = invites_tick()
    check(res["reminders"] >= 1, f"invites:tick: {res}")
    msgs = wait_for(lambda: tg_sent(u5.tg_id, seq), 30, what="напоминание о приглашении получателю")
    p = msgs[0]["payload"]
    check(u1.first in p["text"] and startapp_of(p) == f"invite_{inv['invite_id']}", p)
    invites_tick()
    time.sleep(2)
    check(len(tg_sent(u5.tg_id, seq)) == 1, f"напоминаний: {len(tg_sent(u5.tg_id, seq))} (ожидали одно)")
    # карточка по кнопке напоминания — тому, кто открывал; остальным 404
    pv = u5.ok("GET", f"/v1/invites/{inv['invite_id']}/preview")
    check(pv["can_accept"] is True and pv["inviter_display_name"] == u1.first, pv)
    c.users["R2"].ok("GET", f"/v1/invites/{inv['invite_id']}/preview", 404, "INVITE_NOT_FOUND")


def _shift_open(invite_id: str, invitee: str) -> None:
    """ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: открытие «25 часов назад» (ждать сутки на стенде нельзя)."""
    _psql(f"UPDATE social.invite_redemptions SET opened_at = opened_at - interval '25 hours' "
          f"WHERE invite_id = '{uid(invite_id)}' AND invitee_user_id = '{uid(invitee)}'")


def _reminded(invite_id: str, invitee: str) -> str:
    return _psql("SELECT coalesce(reminded_at::text, 'NULL') FROM social.invite_redemptions "
                 f"WHERE invite_id = '{uid(invite_id)}' AND invitee_user_id = '{uid(invitee)}'")


def s_invite_reminder_eligibility(c: Ctx) -> None:
    """D-02 / §11: напоминание «откройте, чтобы принять» — только тому, кто может принять: подростку без согласия
    родителя (reason=not_allowed) и уже другу (reason=already_friends) не уходит."""
    u1, z = c.users["U1"], c.data["zone_day"]
    tt = c.user("T2", "Севара")
    tt.device_tz = z
    tt.login()
    tt.ok("PUT", "/v1/profile/age", json={"age_band": "14-17"})
    tt.ok("POST", "/v1/profile/consent", json={"policy_version": c.data["policy"]["version"], "purposes": REQUIRED})
    tt.ok("PATCH", "/v1/profile/settings", json={"notifications": {
        "enabled": True, "categories": {"social": True}, "timezone": z, "quiet_hours": None}})
    inv = u1.ok("POST", "/v1/invites", 201, json={"kind": "friend"}, idem=True)
    token = inv["link"].split("startapp=inv_", 1)[1]
    c.secrets["токен приглашения (друг, подросток T2)"] = token
    pv = tt.ok("POST", "/v1/invites/open", json={"token": token})
    check(pv["can_accept"] is False and pv["reason"] == "not_allowed", pv)
    # уже друзья: F приглашает R3, R3 принимает; второе приглашение F → already_friends
    f = c.user("F", "Фарход")
    onboard(f, zone=z, categories={"social": True}, purposes=[*REQUIRED, "social"])
    r3 = c.users["R3"]
    f1 = f.ok("POST", "/v1/invites", 201, json={"kind": "friend"}, idem=True)
    r3.ok("POST", "/v1/invites/open", json={"token": f1["link"].split("startapp=inv_", 1)[1]})
    r3.ok("POST", f"/v1/invites/{f1['invite_id']}/accept")
    f2 = f.ok("POST", "/v1/invites", 201, json={"kind": "friend"}, idem=True)
    c.secrets["токен приглашения (друг, F)"] = f2["link"].split("startapp=inv_", 1)[1]
    pv = r3.ok("POST", "/v1/invites/open", json={"token": f2["link"].split("startapp=inv_", 1)[1]})
    check(pv["can_accept"] is False and pv["reason"] == "already_friends", pv)
    seq = tg_last_seq()
    _shift_open(inv["invite_id"], tt.account_id)
    _shift_open(f2["invite_id"], r3.account_id)
    invites_tick()
    time.sleep(3)
    check(_reminded(inv["invite_id"], tt.account_id) == "NULL", "напоминание выпущено подростку без согласия родителя")
    check(_reminded(f2["invite_id"], r3.account_id) == "NULL", "напоминание выпущено уже другу")
    check(not tg_sent(tt.tg_id, seq) and not tg_sent(r3.tg_id, seq), "напоминание ушло в Telegram тому, кто не может "
                                                                     "принять")


def s_consent_social(c: Ctx) -> None:
    """§11 (P-3): необязательные цели — выключатели функций. Без цели social приглашения не создать и не принять
    (403 CONSENT_REQUIRED {purpose: social}), без согласия с политикой — даже не открыть ({purpose: terms});
    категория «социальное» без цели social в доставке не учитывается."""
    u1, z = c.users["U1"], c.data["zone_day"]
    c1 = c.user("C1", "Камила")
    onboard(c1, zone=z, categories={"social": True}, quiet=None)  # согласие без цели social
    body = c1.ok("POST", "/v1/invites", 403, "CONSENT_REQUIRED", json={"kind": "friend"}, idem=True)
    check(body["details"].get("purpose") == "social", body)
    inv = u1.ok("POST", "/v1/invites", 201, json={"kind": "friend"}, idem=True)
    token = inv["link"].split("startapp=inv_", 1)[1]
    c.secrets["токен приглашения (друг, C1)"] = token
    pv = c1.ok("POST", "/v1/invites/open", json={"token": token})
    check(pv["can_accept"] is True and pv["inviter_display_name"] == u1.first, f"карточка без цели social: {pv}")
    body = c1.ok("POST", f"/v1/invites/{inv['invite_id']}/accept", 403, "CONSENT_REQUIRED")
    check(body["details"].get("purpose") == "social", body)
    # без согласия с политикой — ни открыть, ни посмотреть
    c0 = c.user("C0", "Жасур")
    c0.device_tz = z
    c0.login()
    c0.ok("PUT", "/v1/profile/age", json={"age_band": "18+"})
    body = c0.ok("POST", "/v1/invites/open", 403, "CONSENT_REQUIRED", json={"token": token})
    check(body["details"].get("purpose") == "terms", body)
    check(_reminded(inv["invite_id"], c0.account_id) == "", "открытие без согласия записано")
    # категория «социальное» без цели social: напоминание о приглашении в Telegram и в центр не попадает
    seq = tg_last_seq()
    _shift_open(inv["invite_id"], c1.account_id)
    invites_tick()
    time.sleep(3)
    check(not tg_sent(c1.tg_id, seq), "сообщение категории «социальное» без цели social ушло в Telegram")
    check(not [i for i in c1.inbox() if i["category"] == "social"], "социальное без цели social попало в центр")
    # разрешил приглашения (повторное согласие с целью social) — создать и принять можно
    st = c1.ok("POST", "/v1/profile/consent", json={"policy_version": c.data["policy"]["version"],
                                                    "purposes": [*REQUIRED, "social"]})
    check("social" in st["purposes"], st)
    c1.ok("POST", f"/v1/invites/{inv['invite_id']}/accept")
    c1.ok("POST", "/v1/invites", 201, json={"kind": "friend"}, idem=True)


# ---------------------------------------------------------------- AT-12 лимит в сутки

def s_daily_limit(c: Ctx) -> None:
    lo = c.user("L", "Лола")
    onboard(lo, zone=c.data["zone_day"], categories={"social": True}, purposes=[*REQUIRED, "social"])
    seq = tg_last_seq()
    ref = lo.ok("POST", "/v1/invites", 201, json={"kind": "referral"}, idem=True)
    check(ref["expires_at"] is None, f"реферальная ссылка со сроком: {ref}")
    token = ref["link"].split("startapp=inv_", 1)[1]
    c.secrets["токен приглашения (реферал)"] = token
    acceptors = [c.users[r] for r in ("U2", "R2", "R3", "M1")]
    for a in acceptors:
        a.ok("POST", "/v1/invites/open", json={"token": token})
        a.ok("POST", f"/v1/invites/{ref['invite_id']}/accept")
        time.sleep(0.3)

    def social() -> list[dict[str, Any]]:
        items = [i for i in lo.inbox() if i["category"] == "social"]
        return items if len(items) == 4 and all(i["telegram"] != "scheduled" for i in items) else []

    items = wait_for(social, 40, what="4 записи «приглашение принято» в центре")
    sent = [i for i in items if i["telegram"] == "sent"]
    only = [i for i in items if i["telegram"] == "in_app_only"]
    check(len(sent) == 3 and len(only) == 1, f"telegram: {[i['telegram'] for i in items]}")
    time.sleep(1)
    msgs = tg_sent(lo.tg_id, seq)
    check(len(msgs) == 3, f"в Telegram {len(msgs)} сообщений (лимит 3 в сутки)")
    reason = _psql(f"SELECT string_agg(coalesce(reason, '-'), ',') FROM notifications.notifications "
                   f"WHERE user_id = '{uid(lo.account_id)}' AND telegram_status = 'in_app_only'")
    check("daily_limit" in reason, f"причина: {reason}")


# ---------------------------------------------------------------- AT-15 поддержка

def s_support(c: Ctx) -> None:
    u = c.users["U1"]
    body = {"category": "SCHEDULE_REMINDERS", "subject": "Не пришло напоминание",
            "message": f"Секретная деталь {c.tag}: напоминание в 07:30 не пришло.",
            "context": {"client_version": "telegram-miniapp-1.0"}}
    c.secrets["текст обращения"] = f"Секретная деталь {c.tag}"
    u.ok("POST", "/v1/support/tickets", 422, "IDEMPOTENCY_KEY_REQUIRED", json=body)
    u.ok("POST", "/v1/support/tickets", 422, "SUPPORT_CATEGORY_INVALID", json={**body, "category": "EVENT"}, idem=True)
    key = str(uuid.uuid4())
    t1 = u.ok("POST", "/v1/support/tickets", 201, json=body, idem=key)
    t2 = u.req("POST", "/v1/support/tickets", json=body, idem=key)
    check(t2.status_code in (200, 201) and t2.json()["ticket_id"] == t1["ticket_id"], "повтор создал второе обращение")
    check(re.fullmatch(r"TCK-\d{4,}", t1["number"]) and t1["status"] == "NEW", t1)
    c.data["ticket"] = t1
    op = str(uuid.uuid4())
    c.data["operator"] = op
    read = staff_headers("support", ["support.read"], op)
    reply = staff_headers("support", ["support.read", "support.reply"], op)
    q = expect(httpx.get(f"{SUPPORT}/admin/v1/support/tickets", params={"status": "open"}, headers=read), 200)
    check(any(x["ticket_id"] == t1["ticket_id"] for x in q["items"]), "обращения нет в очереди оператора")
    expect(httpx.post(f"{SUPPORT}/admin/v1/support/tickets/{t1['ticket_id']}/messages",
                      json={"text": "x", "visibility": "public"}, headers=read), 403, "PERMISSION_DENIED")
    seq = tg_last_seq()
    for text, vis in (("ВНУТРЕННЯЯ ЗАМЕТКА: проверить tick", "internal"),
                      ("Проверили график, напоминание придёт в следующий слот.", "public")):
        r = httpx.post(f"{SUPPORT}/admin/v1/support/tickets/{t1['ticket_id']}/messages",
                       json={"text": text, "visibility": vis}, headers=reply)
        check(r.status_code in (200, 201), f"ответ оператора: {r.status_code} {r.text[:200]}")
    t = u.ok("GET", f"/v1/support/tickets/{t1['ticket_id']}")
    texts = [m["text"] for m in t["messages"]]
    check(any("Проверили график" in x for x in texts), f"клиент не видит ответ: {texts}")
    check("ВНУТРЕННЯЯ" not in json.dumps(t, ensure_ascii=False), "клиент видит внутреннюю заметку")
    opmsg = next(m for m in t["messages"] if m["sender_type"] == "operator")
    check(opmsg["author_name"] == "Алина", opmsg)
    by_number = u.ok("GET", f"/v1/support/tickets/{t1['number']}")
    check(by_number["ticket_id"] == t1["ticket_id"], "deep link по номеру")
    msgs = wait_for(lambda: tg_sent(u.tg_id, seq, contains=t1["number"]), 30, what="«Поддержка ответила» в Telegram")
    check(len(msgs) == 1, f"уведомлений об ответе: {len(msgs)} (заметка не должна уведомлять)")
    p = msgs[0]["payload"]
    check("Проверили график" not in p["text"], "текст ответа оператора попал в Telegram")
    check(startapp_of(p) == f"ticket_{t1['number']}", p)
    items = [i for i in u.inbox() if i["category"] == "support"]
    check(items and items[0]["startapp"] == f"ticket_{t1['number']}" and items[0]["telegram"] == "sent", items[:2])


# ---------------------------------------------------------------- AT-12 бот заблокирован

def _member_update(u: U, status: str) -> dict[str, Any]:
    return {
        "update_id": secrets.randbelow(2_000_000_000),
        "my_chat_member": {
            "chat": {"id": u.tg_id, "type": "private"},
            "from": {"id": u.tg_id, "is_bot": False, "first_name": u.first},
            "date": int(time.time()),
            "old_chat_member": {"status": "member" if status == "kicked" else "kicked",
                                "user": {"id": 1, "is_bot": True}},
            "new_chat_member": {"status": status, "user": {"id": 1, "is_bot": True}},
        },
    }


def _operator_reply(c: Ctx, text: str) -> None:
    t = c.data["ticket"]
    hdr = staff_headers("support", ["support.read", "support.reply"], c.data["operator"])
    r = httpx.post(f"{SUPPORT}/admin/v1/support/tickets/{t['ticket_id']}/messages",
                   json={"text": text, "visibility": "public"}, headers=hdr)
    check(r.status_code in (200, 201), f"ответ оператора: {r.status_code} {r.text[:200]}")


def s_bot_blocked(c: Ctx) -> None:
    u = c.users["U1"]

    def support_items() -> list[dict[str, Any]]:
        return [i for i in u.inbox() if i["category"] == "support"]

    # 1) Telegram отвечает 403 при отправке → запись остаётся в центре (in_app_only)
    tg_block(u.tg_id, True)
    try:
        n0 = len(support_items())
        _operator_reply(c, "Второй ответ: бот заблокирован при отправке.")
        items = wait_for(lambda: (lambda xs: xs if len(xs) > n0 and xs[0]["telegram"] != "scheduled" else [])(
            support_items()), 30, what="ответ поддержки в центре при заблокированном боте")
        check(items[0]["telegram"] == "in_app_only", f"telegram={items[0]['telegram']}")
        blocked_calls = [x for x in tg_calls(u.tg_id) if x.get("result") == {"error": 403}]
        check(blocked_calls, "бот не пытался отправить (мок не видел 403)")
    finally:
        tg_block(u.tg_id, False)
    # 2) webhook my_chat_member kicked → identity-consent bot-status → доставка выключена, центр работает
    expect(_webhook(_member_update(u, "kicked")), 200)
    time.sleep(1.5)
    seq = tg_last_seq()
    n1 = len(support_items())
    _operator_reply(c, "Третий ответ: бот заблокирован в Telegram.")
    items = wait_for(lambda: (lambda xs: xs if len(xs) > n1 and xs[0]["telegram"] != "scheduled" else [])(
        support_items()), 30, what="ответ поддержки в центре после блокировки бота")
    check(items[0]["telegram"] == "in_app_only", f"telegram={items[0]['telegram']}")
    check(not tg_calls(u.tg_id, seq), "при заблокированном боте была попытка отправки")
    prof = u.ok("GET", "/v1/profile")
    check(prof["notifications"]["categories"]["social"] is True, "блокировка бота изменила настройки")
    # 3) разблокировка → доставка снова идёт
    expect(_webhook(_member_update(u, "member")), 200)
    time.sleep(1.5)
    seq = tg_last_seq()
    _operator_reply(c, "Четвёртый ответ: бот разблокирован.")
    wait_for(lambda: tg_sent(u.tg_id, seq, contains=c.data["ticket"]["number"]), 30,
             what="доставка после разблокировки бота")


# ---------------------------------------------------------------- AT-07, AT-13: слоты

def _reminders(u: U) -> list[dict[str, Any]]:
    return [i for i in u.inbox() if i["category"] == "reminders"]


def s_slots_check(c: Ctx) -> None:
    t: datetime = c.data["slot"]
    users = c.users
    seq = c.data.setdefault("seq_slot", tg_last_seq())
    sleep_until(t + timedelta(seconds=2), "слот графика")
    res = plan_tick()
    check(res["reminders"] >= 6, f"plan:tick: {res} (ожидали ≥ 6 напоминаний: R1, R3, Q1, T1, ребёнок ×3)")
    # M2 занимается в тот же местный день (после слота) — пропуска быть не должно (AT-08)
    m2 = users["M2"]
    m2.ok("POST", "/v1/plan/activity", json={"kind": "practice", "minutes": 15}, idem=True)

    r1 = users["R1"]
    msgs = wait_for(lambda: tg_sent(r1.tg_id, seq), 30, what="напоминание R1 в Telegram")
    p = msgs[0]["payload"]
    check("Время занятия" in p["text"] and "15 минут" in p["text"], f"текст напоминания: {p['text']}")
    check(startapp_of(p) == "route_home", p)
    rem = _reminders(r1)
    check(len(rem) == 1 and rem[0]["telegram"] == "sent", rem)
    # ребёнок 10–13 в окне 08–20: сообщение родителю с именем ребёнка, мягкий текст
    parent = users["P"]
    kid_msgs = wait_for(lambda: tg_sent(parent.tg_id, seq, contains=c.data["kid_name"]), 30,
                        what="напоминание ребёнка родителю")
    text = kid_msgs[0]["payload"]["text"]
    check(not any(w in text.lower() for w in HARSH), f"резкий текст ребёнку: {text}")
    check(text != p["text"], "ребёнку ушёл взрослый шаблон")
    # подросток после отзыва согласия родителем (шаг 10b): обучение и напоминания работают
    teen = users["T1"]
    tmsg = wait_for(lambda: tg_sent(teen.tg_id, seq, contains="Время занятия"), 30,
                    what="напоминание подростку после отзыва согласия родителя")
    check(len(tmsg) == 1, f"напоминаний подростку: {len(tmsg)}")
    time.sleep(3)  # остальные отрицательные проверки — после того как очередь отработала
    check(not tg_sent(users["R2"].tg_id, seq), "напоминание при выключенных напоминаниях плана")
    check(not _reminders(users["R2"]), "запись напоминания у R2 (план без напоминаний)")
    check(not tg_sent(users["R3"].tg_id, seq), "напоминание при выключенной категории")
    check(not _reminders(users["R3"]), "выключенная категория попала в центр (§10: skipped)")
    st = _psql(f"SELECT string_agg(telegram_status || ':' || coalesce(reason, '-'), ',') FROM "
               f"notifications.notifications WHERE user_id = '{uid(users['R3'].account_id)}' AND category='reminders'")
    check(st.startswith("skipped"), f"R3 в журнале: {st}")
    # ребёнок 6–9 утром до 08:00 — отложено до начала окна, родителю пока не ушло
    check(not tg_sent(parent.tg_id, seq, contains=c.data["kid2_name"]), "ребёнку до 08:00 ушло сообщение")
    # местное время — в Python (zoneinfo, как сервисы): у PostgreSQL нет части IANA-псевдонимов (Asia/Calcutta)
    row = _psql("SELECT telegram_status || ':' || coalesce(reason, '-') || '|' || "
                "coalesce(extract(epoch FROM scheduled_for)::bigint::text, '') FROM notifications.notifications "
                f"WHERE user_id = '{uid(c.data['kid2'])}' AND category='reminders'")
    st, _, epoch = row.partition("|")
    at = hhmm(datetime.fromtimestamp(int(epoch), UTC), c.data["zone_morning"]) if epoch else "-"
    check(f"{st}:{at}" == "scheduled:kid_window:08:00",
          f"ребёнок утром до окна 08–20: {st}:{at} (ожидали scheduled:kid_window:08:00)")
    # ребёнок 10–13 вечером после 20:00 — родителю не уходит (до 08:00 напоминание устареет) — только центр
    check(not tg_sent(parent.tg_id, seq, contains=c.data["kid3_name"]), "ребёнку после 20:00 ушло сообщение")
    st = _psql(f"SELECT telegram_status || ':' || coalesce(reason, '-') FROM notifications.notifications "
               f"WHERE user_id = '{uid(c.data['kid3'])}' AND category='reminders'")
    check(st == "in_app_only:stale", f"ребёнок после 20:00: {st} (ожидали in_app_only:stale)")
    # тихие часы Q1: отложено до конца, затем dispatch → отправлено
    q1 = users["Q1"]
    rem = _reminders(q1)
    check(rem and rem[0]["telegram"] == "scheduled", f"Q1 в тихие часы: {rem}")
    check(not tg_sent(q1.tg_id, seq), "напоминание ушло в тихие часы")
    quiet_end: datetime = c.data["quiet_end"]
    sleep_until(quiet_end + timedelta(seconds=1), "конец тихих часов Q1")
    dispatch()
    msgs = wait_for(lambda: tg_sent(q1.tg_id, seq), 20, what="отложенное напоминание Q1 после тихих часов")
    check(msgs[0]["at"] >= quiet_end.timestamp(), f"отправлено в тихие часы: {msgs[0]['at']} < {quiet_end.timestamp()}")
    check(_reminders(q1)[0]["telegram"] == "sent", "запись Q1 не стала sent")
    # повторный tick не дублирует
    plan_tick()
    dispatch()
    time.sleep(2)
    check(len(tg_sent(r1.tg_id, seq)) == 1 and len(tg_sent(q1.tg_id, seq)) == 1, "повторное напоминание")
    # центр детского профиля — свои записи (в Telegram — родителю)
    parent.switch(c.data["kid"])
    feed = [x["release_note_id"] for x in parent.ok("GET", "/v1/news")["items"]]
    kids_note = next(n["release_note_id"] for n in c.data["notes"] if n["slug"].endswith("-kids"))
    check(kids_note in feed, "заметка сегмента kids не видна детскому профилю")
    kid_items = _reminders(parent)
    check(kid_items and kid_items[0]["telegram"] == "sent" and c.data["kid_name"] in kid_items[0]["title"], kid_items)
    parent.switch(parent.account_id)
    check(not _reminders(parent), "напоминание ребёнка попало в центр родителя")


# ---------------------------------------------------------------- безопасность

def s_botgw_ports(c: Ctx) -> None:
    u = c.users["U1"]
    msg = {"telegram_user_id": u.tg_id, "text": "probe", "idempotency_key": uuid.uuid4().hex}
    good = internal_token("notifications", "telegram-bot-gateway")
    expect(httpx.post(f"{BOTGW}/internal/v1/messages", json=msg, headers=good), 404)
    expect(httpx.get(f"{BOTGW}/health/ready"), 200)
    expect(httpx.post(f"{BOTGW_INTERNAL}/internal/v1/messages", json=msg), 401, "INTERNAL_TOKEN_MISSING")
    expect(httpx.post(f"{BOTGW_INTERNAL}/telegram/webhook", json={"update_id": 1}), 404)
    forged = internal_token("telegram-bff", "telegram-bot-gateway")
    expect(httpx.post(f"{BOTGW_INTERNAL}/internal/v1/messages", json=msg, headers=forged), 403, "CALLER_NOT_ALLOWED")
    # dev-деривация ключа из общего секрета на стенде с личными ключами не принимается
    derived = issue_token(INTERNAL_SECRET, issuer="notifications", audience="telegram-bot-gateway")
    r = httpx.post(f"{BOTGW_INTERNAL}/internal/v1/messages", json=msg, headers={"x-internal-token": derived})
    check(r.status_code == 401, f"токен из dev-деривации принят: {r.status_code}")
    # служебный API identity-consent: адресация — только notifications, имя — social/notifications; BFF — 403
    for path in (f"/internal/v1/users/{u.account_id}/delivery", f"/internal/v1/users/{u.account_id}/public"):
        r = httpx.get(f"{IDENTITY}{path}", headers=internal_token("telegram-bff", "identity-consent", u.account_id))
        expect(r, 403, "CALLER_NOT_ALLOWED")
    r = httpx.get(f"{IDENTITY}/internal/v1/users/{u.account_id}/delivery",
                  headers=internal_token("notifications", "identity-consent"))
    d = expect(r, 200)
    check(d["recipient_telegram_user_id"] == u.tg_id, "адресация notifications")
    # расписания: только SCHEDULER_TOKEN; внутренний JWT сервиса → 403
    for url in (f"{LEARNING_PLAN}/internal/v1/plan:tick", f"{NOTIFICATIONS}/internal/v1/notifications:dispatch",
                f"{SOCIAL}/internal/v1/invites:tick"):
        expect(httpx.post(url, headers={"authorization": "Bearer wrong-token"}), 401)
        expect(httpx.post(url), 401)
        aud = urlsplit(url).port
        audience = {8102: "learning-plan", 8104: "notifications", 8109: "social"}[aud or 0]
        r = httpx.post(url, headers=internal_token("telegram-bff", audience))
        expect(r, 403, "CALLER_NOT_ALLOWED")


def s_internal_keys_script(c: Ctx) -> None:
    """D-01: infra/scripts/gen_internal_keys.py выдаёт ключи всем издателям стенда спринта 1 и ничего лишнего."""
    out = subprocess.run(["uv", "run", "--quiet", "python", str(ROOT / "infra" / "scripts" / "gen_internal_keys.py")],
                         check=True, capture_output=True, text=True, cwd=ROOT).stdout
    pub_line = next(x for x in out.splitlines() if x.startswith("INTERNAL_JWT_PUBLIC_KEYS="))
    issuers = set(json.loads(pub_line.split("=", 1)[1].strip("'")))
    private = {x.split("__", 1)[0] for x in out.splitlines() if "__INTERNAL_JWT_PRIVATE_KEY=" in x}
    want = set(internal_keys.ISSUERS)
    check(issuers == want, f"открытые ключи: лишние {sorted(issuers - want)}, нет {sorted(want - issuers)}")
    check(private == {i.upper().replace("-", "_") for i in want}, f"закрытые ключи: {sorted(private)}")


def s_tick_skipped(c: Ctx) -> None:
    """§11 (P-1): повтор plan:tick, пока идёт предыдущий, не ждёт блокировку — 200 {skipped: true}. На стенде tick
    проходит за миллисекунды, поэтому «идущий tick» моделирует сессия QA, удерживающая ту же advisory-блокировку
    (класс 'LPTI', объект — crc32 схемы learning_plan), что берёт tick; плюс попытка параллельных вызовов."""
    import zlib
    from concurrent.futures import ThreadPoolExecutor

    url = f"{LEARNING_PLAN}/internal/v1/plan:tick"
    hdr = {"authorization": f"Bearer {SCHEDULER_TOKEN}"}
    with ThreadPoolExecutor(8) as pool:
        par = list(pool.map(lambda _: httpx.post(url, headers=hdr, timeout=30).json(), range(8)))
    check(all("skipped" in r for r in par), f"ответы параллельных tick: {par}")
    c.data["parallel_skipped"] = sum(1 for r in par if r["skipped"])
    print(f"      8 параллельных plan:tick: skipped {c.data['parallel_skipped']}", flush=True)
    lock_class = 0x4C505449
    lock_obj = int.from_bytes(zlib.crc32(b"learning_plan").to_bytes(4, "big"), "big", signed=True)
    holder = subprocess.Popen(
        ["psql", "-h", "127.0.0.1", "-U", "postgres", "-d", DB, "-qtA",
         "-c", f"SELECT pg_advisory_lock({lock_class}, {lock_obj})", "-c", "SELECT pg_sleep(6)"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for(lambda: _psql("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted AND "
                               f"classid = {lock_class & 0xFFFFFFFF} AND objid = {lock_obj & 0xFFFFFFFF}") == "1",
                 5, 0.1, what="блокировка tick удерживается сессией QA")
        t0 = time.monotonic()
        res = scheduler(url)
        check(res.get("skipped") is True, f"plan:tick во время идущего: {res}")
        check(time.monotonic() - t0 < 2, "повтор ждал блокировку, а не ответил сразу")
    finally:
        holder.wait(timeout=15)
    res = scheduler(url)
    check(res.get("skipped") is False, f"plan:tick после освобождения: {res}")


def s_idor(c: Ctx) -> None:
    u1, u2, p = c.users["U1"], c.users["U2"], c.users["P"]
    # ученик: чужой детский профиль и чужой аккаунт неотличимы от несуществующего
    u2.ok("POST", "/v1/session/learner", 404, "LEARNER_NOT_FOUND", json={"learner_id": c.data["kid"]})
    u2.ok("POST", "/v1/session/learner", 404, "LEARNER_NOT_FOUND", json={"learner_id": u1.account_id})
    u2.ok("POST", "/v1/session/learner", 404, "LEARNER_NOT_FOUND", json={"learner_id": str(uuid.uuid4())})
    # план: только активного ученика; learner_id в запросе игнорируется / запрещён
    r = u2.req("GET", "/v1/plan", params={"learner_id": u1.account_id})
    check(r.status_code in (200, 422), f"GET /v1/plan?learner_id=чужой: {r.status_code}")
    if r.status_code == 200:
        check(r.json()["learner_id"] == u2.account_id, f"чужой план: {r.json()['learner_id']}")
    plan_patch(u2, {"learner_id": u1.account_id, "goal": "work"}, 422, "PLAN_INVALID")
    check(u1.ok("GET", "/v1/plan")["goal"] == "travel", "план U1 изменён чужим запросом")
    # домен напрямую: user_id — только из sub токена (путь /me), чужой sub подписать нельзя без ключа BFF
    r = httpx.get(f"{LEARNING_PLAN}/internal/v1/me/plan",
                  headers={"x-internal-token": issue_token(INTERNAL_SECRET, issuer="telegram-bff",
                                                           audience="learning-plan", subject=u1.account_id)})
    check(r.status_code == 401, f"learning-plan принял токен не от ключа BFF: {r.status_code}")
    # приглашение: чужое — 404
    u2.ok("DELETE", f"/v1/invites/{c.data['friend_invite']}", 404, "INVITE_NOT_FOUND")
    u2.ok("GET", f"/v1/invites/{c.data['friend_invite']}/preview", 404, "INVITE_NOT_FOUND")
    check(all(i["invite_id"] != c.data["friend_invite"] for i in u2.ok("GET", "/v1/invites")["items"]),
          "чужое приглашение в моём списке")
    # обращение: чужое — 404 (и по id, и по номеру)
    t = c.data["ticket"]
    u2.ok("GET", f"/v1/support/tickets/{t['ticket_id']}", 404, "SUPPORT_TICKET_NOT_FOUND")
    u2.ok("GET", f"/v1/support/tickets/{t['number']}", 404, "SUPPORT_TICKET_NOT_FOUND")
    u2.ok("POST", f"/v1/support/tickets/{t['ticket_id']}/messages", 404, "SUPPORT_TICKET_NOT_FOUND",
          json={"text": "чужое"}, idem=True)
    # центр уведомлений: чужие id не отмечаются прочитанными
    before = u1.ok("GET", "/v1/notifications/unread-count")["unread"]
    ids = [i["notification_id"] for i in u1.inbox()][:5]
    u2.ok("POST", "/v1/notifications/read", json={"ids": ids})
    after = u1.ok("GET", "/v1/notifications/unread-count")["unread"]
    check(after == before, f"чужой запрос отметил прочитанными: {before} → {after}")
    # ребёнок: родитель видит своих детей, чужой — нет
    check([x["learner_id"] for x in u2.ok("GET", "/v1/learners")["items"]] == [u2.account_id], "чужие дети в списке")
    check(len(p.ok("GET", "/v1/learners")["items"]) == 4, "дети родителя")


# ---------------------------------------------------------------- AT-14 удаление аккаунта с детьми

def s_deletion(c: Ctx) -> None:
    p = c.users["P"]
    pol = c.data["policy"]
    # данные во всех доменах спринта: план (есть), центр (напоминания детей), обращение, отметки «Что нового», семья
    t = p.ok("POST", "/v1/support/tickets", 201, idem=True,
             json={"category": "CHILD_PROFILE", "subject": "Профиль ребёнка", "message": "Вопрос про профиль",
                   "context": {"client_version": "telegram-miniapp-1.0"}})
    wn = p.ok("GET", "/v1/whats-new")
    if wn["notes"]:
        p.ok("POST", "/v1/whats-new/seen", 204, json={"release_note_ids": [n["release_note_id"] for n in wn["notes"]]})
    fam = p.ok("GET", "/v1/family")
    check(sum(1 for m in fam["members"] if m["role"] == "child") == 3, f"дети не в семье родителя: {fam}")
    ids = [uid(p.account_id), uid(c.data["kid"]), uid(c.data["kid2"]), uid(c.data["kid3"])]
    c.data["deleted_account"] = ids[0]
    in_ids = ",".join(f"'{x}'" for x in ids)
    check(int(_psql(f"SELECT count(*) FROM learning_plan.plans WHERE user_id IN ({in_ids})")) == 4, "планы до удаления")
    check(int(_psql(f"SELECT count(*) FROM notifications.notifications WHERE user_id IN ({in_ids})")) >= 2,
          "центр уведомлений до удаления")
    check(int(_psql(f"SELECT count(*) FROM experience_config.release_note_views WHERE user_id = '{ids[0]}'")) >= 1,
          "отметки «Что нового» до удаления")
    _ = pol
    p.ok("POST", "/v1/profile/delete-request", 422, json={"confirm_word": "НЕТ"})
    d = p.ok("POST", "/v1/profile/delete-request", 202, json={"confirm_word": "УДАЛИТЬ"})
    check(d["status"] == "REQUESTED" and d["learners"] == 4 and DOMAINS <= set(d["domains"]), d)
    expect(c.bff.get("/v1/profile", headers=p.h()), 401, "SESSION_REVOKED")
    expect(c.bff.post("/v1/session/refresh", json={"refresh_token": p.refresh}), 401, "REFRESH_INVALID")

    def done() -> Any:
        rows = _psql("SELECT user_id || '|' || status || '|' || array_to_string(acked_domains, ',') FROM "
                     f"identity_consent.deletion_requests WHERE user_id IN ({in_ids})").splitlines()
        return rows if len(rows) == 4 and all(r.split("|")[1] == "COMPLETED" for r in rows) else None

    rows = wait_for(done, 60, interval=1.0, what="ACK всех доменов по аккаунту и трём детям")
    for r in rows:
        acked = set(r.split("|")[2].split(","))
        check(DOMAINS <= acked, f"ACK {r.split('|')[0]}: {sorted(acked)}")
    u = _psql("SELECT string_agg(status || ':' || coalesce(telegram_user_id::text, 'NULL') || ':' || "
              f"coalesce(display_name, 'NULL'), ',') FROM identity_consent.users WHERE user_id IN ({in_ids})")
    check(u == ",".join(["DELETED:NULL:NULL"] * 4), f"identity users: {u}")
    left = {
        "learning_plan.plans": f"SELECT count(*) FROM learning_plan.plans WHERE user_id IN ({in_ids})",
        "learning_plan.activities": f"SELECT count(*) FROM learning_plan.activities WHERE user_id IN ({in_ids})",
        "learning_plan.slot_marks": f"SELECT count(*) FROM learning_plan.slot_marks WHERE user_id IN ({in_ids})",
        "notifications.notifications":
            f"SELECT count(*) FROM notifications.notifications WHERE user_id IN ({in_ids})",
        "experience_config.release_note_views":
            f"SELECT count(*) FROM experience_config.release_note_views WHERE user_id IN ({in_ids})",
        "social.family_members": f"SELECT count(*) FROM social.family_members WHERE user_id IN ({in_ids})",
        "identity_consent.guardian_links":
            f"SELECT count(*) FROM identity_consent.guardian_links WHERE child_user_id IN ({in_ids})",
        "support.tickets (user_id)": f"SELECT count(*) FROM support.tickets WHERE user_id IN ({in_ids})",
    }
    leftovers = {k: v for k, q in left.items() if (v := _psql(q)) != "0"}
    check(not leftovers, f"данные после удаления: {leftovers}")
    tk = _psql(f"SELECT status FROM support.tickets WHERE ticket_id = '{uid(t['ticket_id'])}'")
    check(tk == "CLOSED", f"обращение после удаления: {tk}")
    s = p.login()
    check(s["account"]["user_id"] != ids[0] and s["account"]["is_new"] is True, "повторный вход вернул удалённого")
    check(len(s["learners"]) == 1 and s["onboarding_completed"] is False, s["learners"])


# ---------------------------------------------------------------- AT-08 пропуск

def s_missed(c: Ctx) -> None:
    if c.data.get("skip_missed"):
        raise StepSkipped("--skip-missed")
    midnight: datetime = c.data["midnight"]
    zm = c.data["zone_midnight"]
    m1, m2 = c.users["M1"], c.users["M2"]
    d: date = c.data["missed_date"]
    seq = tg_last_seq()
    plan_tick()
    sleep_until(midnight + timedelta(seconds=2), f"местную полночь в {zm}")
    res = plan_tick()
    check(res["missed"] >= 1, f"plan:tick после полуночи: {res}")
    marks = _psql("SELECT string_agg(user_id || ':' || kind, ',') FROM learning_plan.slot_marks "
                  f"WHERE local_date = '{d.isoformat()}' AND user_id IN ('{uid(m1.account_id)}', '{uid(m2.account_id)}')")
    check(marks == f"{uid(m1.account_id)}:missed", f"отметки слота {d}: {marks}")
    res2 = plan_tick()
    n = _psql(f"SELECT count(*) FROM learning_plan.slot_marks WHERE user_id = '{uid(m1.account_id)}' AND kind='missed'")
    check(n == "1", f"повторный tick выпустил ещё пропуск: {n} ({res2})")

    def missed_items(u: U) -> list[dict[str, Any]]:
        return [i for i in u.inbox() if i["category"] == "missed"]

    items = wait_for(lambda: missed_items(m1), 20, what="пропуск в центре M1")
    check(len(items) == 1 and items[0]["telegram"] == "scheduled", f"M1: {items}")
    check(not missed_items(m2), "пропуск у M2, который занимался в тот же день")
    epoch = _psql("SELECT extract(epoch FROM not_before)::bigint FROM notifications.notifications "
                  f"WHERE dedup_key = 'missed:{uid(m1.account_id)}:{d.isoformat()}'")
    row = loc(datetime.fromtimestamp(int(epoch), UTC), zm).strftime("%Y-%m-%d %H:%M") if epoch else "-"
    expected = f"{(d + timedelta(days=1)).isoformat()} {hhmm(c.data['slot'], zm)}"
    check(row == expected, f"пропуск отправляется в слот-время следующего дня: {row} (ожидали {expected})")

    # Только сообщения о пропуске: со спринта 6 пропуск закрывает автозаморозка (2 заморозки бонуса регистрации) —
    # «Серия спасена» и значок «Первая заморозка», а со спринта 7 они в категории game, включённой по умолчанию
    # (INTERNAL_API спринта 7 §5; до этого — выключатель reminders, у M1 выключен). M1 без тихих часов — эти сообщения
    # уходят сразу, ночью; к пропуску (отложен до слот-времени) это не относится.
    def missed_tg(u: U) -> list[dict[str, Any]]:
        return [m for m in tg_sent(u.tg_id, seq) if "Вчера занятия не было" in m["payload"].get("text", "")]

    check(not missed_tg(m1), "пропуск ушёл ночью, не дожидаясь слот-времени")
    other = [m["payload"].get("text", "")[:50] for m in tg_sent(m1.tg_id, seq)]
    if other:
        print(f"      M1 ночью получил не о пропуске (категория game, тихие часы выключены): {other}", flush=True)
    # ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: «наступило слот-время следующего дня» (ждать сутки на стенде нельзя)
    _psql("UPDATE notifications.notifications SET not_before = now(), scheduled_for = now() "
          f"WHERE dedup_key = 'missed:{uid(m1.account_id)}:{d.isoformat()}'")
    dispatch()
    msgs = wait_for(lambda: missed_tg(m1), 20, what="сообщение о пропуске M1")
    check(len(msgs) == 1 and startapp_of(msgs[0]["payload"]) == "route_home", msgs)
    dispatch()
    time.sleep(1)
    check(len(missed_tg(m1)) == 1 and not missed_tg(m2), "пропусков в Telegram больше одного")
    today = m1.ok("GET", "/v1/plan/today")
    wk = {w["local_date"]: w for w in today["week"]}
    if d.isoformat() in wk:
        check(wk[d.isoformat()]["missed"] is True, f"неделя M1: {wk[d.isoformat()]}")


def s_kid_window_open(c: Ctx) -> None:
    """Отложенное напоминание ребёнка 6–9 уходит родителю в 08:00 по местному времени ребёнка."""
    at: datetime = c.data["kid_window"]
    left = (at - datetime.now(UTC)).total_seconds()
    if left > (2 * 60 if c.data.get("skip_missed") else 40 * 60):
        raise StepSkipped(f"08:00 в {c.data['zone_morning']} наступит через {left / 60:.0f} мин — не ждём; "
                          "отсрочка до 08:00 проверена в шаге 16")
    parent = c.users["P"]
    seq = c.data["seq_slot"]
    sleep_until(at + timedelta(seconds=2), f"08:00 в {c.data['zone_morning']}")
    dispatch()
    msgs = wait_for(lambda: tg_sent(parent.tg_id, seq, contains=c.data["kid2_name"]), 30,
                    what="отложенное напоминание ребёнка родителю в 08:00")
    check(len(msgs) == 1 and msgs[0]["at"] >= at.timestamp(), f"отправлено до 08:00: {msgs[0]['at']} < {at.timestamp()}")
    text = msgs[0]["payload"]["text"]
    check(not any(w in text.lower() for w in HARSH), f"резкий текст ребёнку: {text}")


# ---------------------------------------------------------------- события, DLQ, логи

def dlq_counts() -> dict[str, int]:
    import asyncio

    import nats

    async def run() -> dict[str, int]:
        nc = await nats.connect("nats://127.0.0.1:4222")
        try:
            js = nc.jetstream()
            try:
                info = await js.stream_info("TILHERO_DLQ", subjects_filter="tilherodlq.>")
            except Exception:
                return {}
            # NATS стенда общий с юнит-тестами: py-common test_nats_publish_subscribe_dedup_and_dlq намеренно кладёт
            # сообщение в DLQ своего потребителя test_bad_<suffix> — это не сервисы стенда
            return {k: v for k, v in (info.state.subjects or {}).items() if not k.startswith("tilherodlq.test_")}
        finally:
            await nc.close()

    return asyncio.run(run())


def s_events_contract(c: Ctx) -> None:
    import asyncio

    import jsonschema
    import nats

    since = c.data["started_at"]
    env_schema = json.loads((CONTRACTS / "envelope.schema.json").read_text())
    seen: dict[str, int] = {}
    problems: list[str] = []
    for schema in SCHEMAS:
        rows = _psql(
            "SELECT coalesce(json_agg(json_build_object('e', envelope, 'p', published_at IS NOT NULL)), '[]') "
            f"FROM {schema}.outbox WHERE created_at >= to_timestamp({int(since)})"
        )
        for row in json.loads(rows or "[]"):
            env = row["e"]
            et = env.get("event_type", "?")
            seen[et] = seen.get(et, 0) + 1
            if not row["p"]:
                problems.append(f"{schema}: {et} не опубликовано (outbox)")
            try:
                jsonschema.validate(env, env_schema, format_checker=jsonschema.FormatChecker())
                path = CONTRACTS / f"{et}.schema.json"
                if not path.exists():
                    problems.append(f"{schema}: нет контракта для {et}")
                    continue
                jsonschema.validate(env["payload"], json.loads(path.read_text()),
                                    format_checker=jsonschema.FormatChecker())
            except jsonschema.ValidationError as exc:
                problems.append(f"{schema}: {et}: {exc.message[:160]}")
    expected = {
        "user.profile.created.v1", "user.profile.updated.v1", "consent.accepted.v1", "consent.revoked.v1",
        "user.notification_settings.changed.v1", "learning.plan.updated.v1", "learning.activity.recorded.v1",
        "learning.reminder.due.v1", "social.invite.created.v1", "social.invite.opened.v1",
        "social.invite.accepted.v1", "social.invite.declined.v1", "social.invite.reminder_due.v1",
        "social.family.member_added.v1", "support.ticket.created.v1", "support.ticket.replied.v1",
        "notification.delivered.v1", "telegram.delivery.failed.v1", "experience.release_note.published.v1",
        "admin.audit.recorded.v1", "user.deletion.requested.v1", "user.domain.deleted.v1", "user.status.changed.v1",
    }
    if not c.data.get("skip_missed"):
        expected.add("learning.session.missed.v1")
    missing = expected - set(seen)
    check(not missing, f"не опубликованы события: {sorted(missing)}")
    check(not problems, "; ".join(problems[:8]))
    # PII в событиях: Telegram ID и username только у identity-consent (CONVENTIONS §3)
    leaks = []
    for schema in SCHEMAS:
        for u in c.users.values():
            n = _psql(f"SELECT count(*) FROM {schema}.outbox WHERE created_at >= to_timestamp({int(since)}) AND "
                      f"(envelope::text LIKE '%{u.username}%' OR envelope::text ~ '(^|[^0-9]){u.tg_id}([^0-9]|$)')")
            if n != "0":
                leaks.append(f"{schema}: {u.role}")
    check(not leaks, f"Telegram ID / username в событиях: {leaks}")

    async def lag() -> list[str]:
        nc = await nats.connect("nats://127.0.0.1:4222")
        try:
            js = nc.jetstream()
            out = []
            for ci in await js.consumers_info("TILHERO"):
                if ci.num_pending or ci.num_ack_pending:
                    out.append(f"{ci.name}: pending={ci.num_pending} ack_pending={ci.num_ack_pending}")
            return out
        finally:
            await nc.close()

    wait_for(lambda: not asyncio.run(lag()) or None, 20, what="потребители NATS без хвоста")
    after, before = dlq_counts(), c.data.get("dlq_before", {})
    grown = {k: v - before.get(k, 0) for k, v in after.items() if v > before.get(k, 0)}
    check(not grown, f"новые сообщения в DLQ: {grown}")


def s_audit_trail(c: Ctx) -> None:
    hdr = staff_headers("audit", ["audit.read"])

    def recs(**q: str) -> list[dict[str, Any]]:
        r = httpx.get(f"{AUDIT}/admin/v1/audit/records", params={**q, "limit": "100"}, headers=hdr)
        return expect(r, 200)["items"]

    staff = wait_for(lambda: recs(actor_id=c.data["operator"]), 20, what="аудит действий оператора")
    actions = {x["action"] for x in staff}
    check({"ticket.reply", "ticket.note"} <= actions, f"аудит оператора: {sorted(actions)}")
    check(all("Проверили график" not in json.dumps(x, ensure_ascii=False) and "ВНУТРЕННЯЯ" not in
              json.dumps(x, ensure_ascii=False) for x in staff), "текст сообщения попал в аудит")
    editor = wait_for(lambda: recs(actor_id=EDITOR_ID), 20, what="аудит публикации «Что нового»")
    actions = {x["action"] for x in editor}
    check({"release_note.create", "release_note.publish", "release_note.archive"} <= actions, sorted(actions))
    deleted = c.data.get("deleted_account")
    if deleted:
        rec = wait_for(lambda: recs(actor_id=deleted, action="user.deletion_request"), 20, what="аудит удаления")
        check(rec, "нет записи аудита удаления")
    v = expect(httpx.get(f"{AUDIT}/admin/v1/audit/verify", headers=hdr), 200)
    check(v.get("valid") is True, f"цепочка аудита: {v}")
    expect(httpx.get(f"{AUDIT}/admin/v1/audit/records", headers=staff_headers("audit", ["support.read"])), 403,
           "PERMISSION_DENIED")


def s_cleanup_notes(c: Ctx) -> None:
    hdr = staff_headers("experience-config", ["whatsnew.manage", "whatsnew.publish"], EDITOR_ID)
    for note in c.data.get("notes", []):
        r = httpx.post(f"{EXPERIENCE}/admin/v1/release-notes/{note['release_note_id']}/archive",
                       json={"reason": "e2e: уборка"}, headers={**hdr, "idempotency-key": uuid.uuid4().hex})
        check(r.status_code in (200, 201), f"архив заметки: {r.status_code} {r.text[:200]}")
    u = c.users["U1"]
    feed = [n["release_note_id"] for n in u.ok("GET", "/v1/news")["items"]]
    check(all(n["release_note_id"] not in feed for n in c.data.get("notes", [])), "архивная заметка в ленте")


def s_logs_no_pii(c: Ctx) -> None:
    needles: dict[str, str] = {}
    for u in c.users.values():
        needles[f"Telegram ID {u.role}"] = str(u.tg_id)
        needles[f"username {u.role}"] = u.username
        needles[f"имя {u.role}"] = u.first
        for i, tok in enumerate(u.refresh_tokens):
            needles[f"refresh {u.role}#{i}"] = tok
        if u.access:
            needles[f"access {u.role}"] = u.access.split(".")[-1]
    for k in ("kid_name", "kid2_name", "kid3_name", "kid_p2_name"):
        if c.data.get(k):
            needles[f"имя ребёнка {k}"] = c.data[k]
    needles.update(c.secrets)
    needles["токен бота"] = BOT_TOKEN.split(":")[1]
    needles["SCHEDULER_TOKEN"] = SCHEDULER_TOKEN
    needles["INVITE_TOKEN_KEY"] = INVITE_TOKEN_KEY
    needles["ответ оператора"] = "Проверили график"
    needles["внутренняя заметка"] = "ВНУТРЕННЯЯ ЗАМЕТКА"
    found = []
    for log in sorted(LOG_DIR.glob("*.log")):
        if log.name.startswith(("mock-telegram", "miniapp", "bootstrap")) or ".migrate" in log.name:
            continue
        text = log.read_text(errors="replace")
        for what, needle in needles.items():
            if not needle:
                continue
            # числовые значения — только как отдельное число (метки времени pino содержат длинные цифры)
            hit = re.search(rf"(?<!\d){re.escape(needle)}(?!\d)", text) if needle.isdigit() else needle in text
            if hit:
                found.append(f"{log.name}: {what}")
    check(not found, f"PII/секреты в логах: {found}")


STEPS: list[tuple[str, Callable[[Ctx], None], bool]] = [
    ("00 стенд готов, окно plan:tick открыто", s_stand, True),
    ("01 AT-01 поддельный/подменённый/просроченный initData → 401", s_initdata_rejected, True),
    ("02 AT-01 вход, повтор initData, повторный вход — тот же профиль; refresh-ротация", s_login, True),
    ("03 справочники, политика RU/UZ, конфиг, план по умолчанию, «Что нового» до онбординга", s_directories, True),
    ("03a D-03: план в зоне клиента (?tz= / X-Timezone), при входе не создаётся; CORS", s_plan_tz, False),
    ("04 AT-02/03 возраст 18+, согласия без записи голоса, отзыв и повтор, аудит", s_age_consent, True),
    ("05 AT-04/05/06 онбординг: язык RU↔UZ, цель, уровень, график, напоминания, готово", s_onboarding, True),
    ("06 AT-01/06 повторный вход — тот же план; изменение графика в профиле; занятие", s_relogin_same, False),
    ("07 AT-11 «Что нового»: welcome → seen → none; публикация staff API → updates один раз", s_whats_new, False),
    ("08 AT-11 новичок после публикации — знакомство (new), UZ-тексты", s_whats_new_newcomer, False),
    ("09 AT-07/08/13 подготовка слотов (R1–R3, Q1, родитель + 3 ребёнка, M1/M2)", s_slots_setup, True),
    ("10 AT-03 подросток: gc_-ссылка, до согласия родителя необязательное закрыто, после — открыто", s_teen, False),
    ("10b §11 родитель отзывает согласие за подростка: необязательное снова закрыто, обучение работает", s_teen_revoke,
     False),
    ("10a AT-03 детский профиль: выход из него с кодом родителя, вход с кодом → 423 до проверки", s_child_pin, False),
    ("11 AT-09 приглашение в семью: inv_, открытие, принятие, сообщение пригласившему, отклонение", s_family_invite,
     False),
    ("12 AT-10 неотвеченное приглашение: invites:tick через 24 ч → одно напоминание", s_invite_reminder, False),
    ("12a D-02: напоминание о приглашении не уходит тому, кто не может принять (подросток, уже друг)",
     s_invite_reminder_eligibility, False),
    ("12b §11 цель social: без неё 403 CONSENT_REQUIRED, без согласия — не открыть; доставка social по цели",
     s_consent_social, False),
    ("13 AT-12 лимит ≤ 3 сообщений reminders+missed+social в сутки", s_daily_limit, False),
    ("14 AT-15 поддержка: обращение, ответ оператора в приложении и в Telegram", s_support, False),
    ("15 AT-12 бот заблокирован → центр уведомлений; разблокировка", s_bot_blocked, False),
    ("16 AT-07/13 слот: напоминание, тихие часы, категории, ребёнок родителю, окно 08–20", s_slots_check, False),
    ("17 безопасность: порты bot-gateway, ключи JWT, расписания по SCHEDULER_TOKEN", s_botgw_ports, False),
    ("17a D-01: gen_internal_keys.py — ключи для всех издателей спринта 1", s_internal_keys_script, False),
    ("17b §11 plan:tick во время идущего → 200 {skipped: true}, без ожидания", s_tick_skipped, False),
    ("18 безопасность: IDOR — ученик, план, приглашение, обращение, центр уведомлений", s_idor, False),
    ("19 AT-08 пропуск: после местной полуночи одно сообщение; занятие отменяет пропуск", s_missed, False),
    ("20 AT-07 ребёнок: отложенное до 08:00 напоминание уходит родителю в начале окна", s_kid_window_open, False),
    ("21 AT-14 удаление аккаунта с детьми: ACK всех доменов, данные удалены", s_deletion, False),
    ("22 «Что нового»: уборка заметок сценария (архив)", s_cleanup_notes, False),
    ("22a аудит: действия оператора и редактора, запрос удаления; хеш-цепочка цела", s_audit_trail, False),
    ("23 события по контрактам, outbox опубликован, без PII, DLQ без новых", s_events_contract, False),
    ("24 логи всех сервисов без PII и секретов", s_logs_no_pii, False),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bff", default="http://127.0.0.1:8001")
    ap.add_argument("--skip-missed", action="store_true",
                    help="быстрый прогон: не ждать местную полночь (AT-08) и 08:00 ребёнка — эти шаги SKIP")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    tag = "Q" + "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(4))
    base_tg = 6_100_000_000 + secrets.randbelow(800_000_000) * 4
    with httpx.Client(base_url=args.bff, timeout=20) as bff:
        c = Ctx(bff=bff, tag=tag, base_tg=base_tg)
        c.data["started_at"] = int(time.time()) - 1
        c.data["skip_missed"] = args.skip_missed
        # «дневная» зона на весь прогон: местное время около 13:00 (не тихие часы, окно детей 08–20)
        c.data["zone_day"] = pick_zone(datetime.now(UTC), 10 * 60, 16 * 60, 13 * 60)
        print(f"TilHero e2e (спринт 1): BFF {args.bff}, метка прогона {tag}, Telegram ID от {base_tg + 1}, "
              f"дневная зона {c.data['zone_day']}\n", flush=True)
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
                status, detail = "PASS", ""
            except StepSkipped as exc:
                status, detail = "SKIP", str(exc)
            except Exception as exc:
                status = "FAIL"
                detail = str(exc) if isinstance(exc, StepFailed) else f"{type(exc).__name__}: {exc}"
                if args.verbose and not isinstance(exc, StepFailed):
                    traceback.print_exc()
                if critical:
                    blocked = name
            dt = time.monotonic() - t0
            results.append((name, status, detail))
            print(f"{status}  {name}  ({dt:.1f} c){'  — ' + detail if detail else ''}", flush=True)
    passed = sum(1 for r in results if r[1] == "PASS")
    failed = [r for r in results if r[1] == "FAIL"]
    skipped = [r for r in results if r[1] == "SKIP"]
    print(f"\nИтого: {passed}/{len(results)} PASS" + (f", {len(skipped)} SKIP" if skipped else "")
          + f" (выполнено проверок: {CHECKS[0]})")
    (E2E_DIR / "last-run.json").write_text(json.dumps(
        {"tag": tag, "checks": CHECKS[0], "results": [{"step": n, "status": s, "detail": d} for n, s, d in results]},
        ensure_ascii=False, indent=1))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

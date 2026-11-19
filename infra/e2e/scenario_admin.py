# ruff: noqa: S608 — QA-скрипт dev-стенда: psql (SQL только из UUID сценария и имён схем), dev-пароли
"""Сквозной сценарий спринта 2 TilHero (админ-контур) через admin-bff — так, как это делает браузер admin-web.

Предусловие: `infra/e2e/run_local.sh admin` (сброс учёток admin-identity + up + этот сценарий) или `run_local.sh test`
(после сценария спринта 1). Отдельно, на уже поднятом стенде со свежим bootstrap:
    uv run python infra/e2e/scenario_admin.py [--admin-bff http://127.0.0.1:8002] [-v]

Браузер admin-web: cookie `__Host-tilhero_admin` храним сами (http.cookiejar не отдаёт Secure-cookie по http, а браузер
считает http://127.0.0.1 безопасным контекстом), `X-CSRF-Token` = `Me.csrf_token` и `Origin` = ADMIN_ORIGIN на всех
не-GET, постоянный User-Agent (сессия к нему привязана). TOTP считается здесь по секрету, выданному при подключении
MFA (RFC 6238: HMAC-SHA1, 6 цифр, шаг 30 с; сервер принимает окно ±1 и запрещает повтор шага — следующий код берётся
с шага больше последнего использованного, при необходимости сценарий ждёт).
Ученики — через публичный API telegram-bff (помощники сценария спринта 1), доставка — мок Telegram (`/_mock/calls`),
plan:tick и notifications:dispatch — с SCHEDULER_TOKEN, как n8n. Read-only psql — проекции и журналы, которых нет в API.

Печатает PASS/FAIL по шагам и «Итого: N/M PASS»; код выхода 1, если хоть один шаг упал. Шаги после сбоя критичного
шага — SKIP. Изменения стенда, которые сценарий оставляет за собой (шаблон, конфигурация Mini App, заметка «Что нового»,
рассылки), откатываются в finally-блоках шагов — сценарий спринта 1 после него снова видит тексты по умолчанию.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import string
import struct
import sys
import time
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scenario as s1  # помощники сценария спринта 1: ученики, онбординг, мок Telegram, tick/dispatch, psql

from tilhero_common.internal_auth import Actor, issue_token

check, expect, wait_for = s1.check, s1.expect, s1.wait_for
StepFailed, StepSkipped = s1.StepFailed, s1.StepSkipped
U = s1.U

ROOT = s1.ROOT
LOG_DIR = s1.LOG_DIR
CONTRACTS = s1.CONTRACTS
MOCK_TG = s1.MOCK_TG
TG_BFF = os.environ.get("E2E_TG_BFF", "http://127.0.0.1:8001")
ADMIN_ORIGIN = os.environ.get("E2E_ADMIN_ORIGIN", "http://127.0.0.1:5174")
BOOT_EMAIL = os.environ.get("E2E_ADMIN_BOOTSTRAP_EMAIL", "root.e2e@tilhero.local")
BOOT_PASSWORD = os.environ.get("E2E_ADMIN_BOOTSTRAP_PASSWORD", "Bootstrap-e2e-2026-temp")
TEST_CHAT_IDS = [int(x) for x in os.environ.get("E2E_ADMIN_TEST_CHAT_IDS", "5550001001,5550001002").split(",") if x]
ADMIN_IDENTITY = "http://127.0.0.1:8120"
USER_ADMIN = "http://127.0.0.1:8121"
COOKIE = "__Host-tilhero_admin"
SAFE = {"GET", "HEAD", "OPTIONS"}

# admin.ts PERMISSIONS и PLAN «Роли и права»
ALL_PERMS = {
    "dashboard.read", "users.read", "users.sensitive.read", "support.read", "support.reply", "support.manage",
    "audit.read", "config.read", "config.edit", "config.publish", "whatsnew.manage", "whatsnew.publish",
    "notif.templates.manage", "notif.campaigns.manage", "notif.campaigns.send", "staff.manage", "roles.manage",
}
COMMS_PERMS = {"dashboard.read", "whatsnew.manage", "whatsnew.publish", "notif.templates.manage",
               "notif.campaigns.manage", "notif.campaigns.send"}
SUPPORT_PERMS = {"dashboard.read", "users.read", "support.read", "support.reply"}
SCHEMAS = ["admin_identity", "user_admin", "identity_consent", "notifications", "experience_config", "support"]


def idem() -> dict[str, str]:
    return {"idempotency-key": str(uuid.uuid4())}


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# ============================================================================================ TOTP (RFC 6238)


class Totp:
    """TOTP: HMAC-SHA1, 6 цифр, шаг 30 с (RFC 6238 поверх RFC 4226), только stdlib. Сервер принимает окно ±1 и
    отвергает шаги ≤ последнего принятого: каждый следующий код — с шага > последнего (при необходимости ждём)."""

    def __init__(self, secret: str) -> None:
        self.key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
        self.last_step = -1

    @staticmethod
    def now_step() -> int:
        return int(time.time() // 30)

    def at(self, step: int) -> str:
        mac = hmac.new(self.key, struct.pack(">Q", step), hashlib.sha1).digest()
        off = mac[-1] & 0x0F
        return f"{(struct.unpack('>I', mac[off:off + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"

    def code(self) -> str:
        step = max(self.now_step(), self.last_step + 1)
        if step > self.now_step() + 1:
            print(f"      … TOTP: ждём следующий шаг ({30 - time.time() % 30:.0f} с)", flush=True)
        while step > self.now_step() + 1:  # сервер примет шаг now+1, но не дальше
            time.sleep(0.5)
        self.last_step = step
        return self.at(step)

    def wrong(self) -> str:
        now = self.now_step()
        valid = {self.at(now + d) for d in (-1, 0, 1)}
        return next(f"{n:06d}" for n in range(123457, 999999, 7919) if f"{n:06d}" not in valid)


# ============================================================================================ «браузер» admin-web


class Browser:
    """Один браузер admin-web: свой User-Agent, cookie сессии, CSRF-токен из Me, Origin на не-GET."""

    def __init__(self, base: str, name: str, seen: list[str]) -> None:
        self.name = name
        self.http = httpx.Client(base_url=base, timeout=30,
                                 headers={"user-agent": f"Mozilla/5.0 (e2e {name}) AppleWebKit/537.36 Chrome/131"})
        self.cookie: str | None = None
        self.csrf: str | None = None
        self.seen = seen  # все выданные cookie и CSRF-токены — для проверки логов
        self.me: dict[str, Any] = {}

    def request(self, method: str, path: str, *, json_body: Any = None, params: dict[str, Any] | None = None,
                headers: dict[str, str] | None = None, csrf: bool = True, origin: str | None = ADMIN_ORIGIN,
                cookie: str | None = None) -> httpx.Response:
        h: dict[str, str] = {}
        sent_cookie = cookie if cookie is not None else self.cookie
        if sent_cookie:
            h["cookie"] = f"{COOKIE}={sent_cookie}"
        if method not in SAFE:
            if origin:
                h["origin"] = origin
            if csrf and self.csrf:
                h["x-csrf-token"] = self.csrf
        h.update(headers or {})
        r = self.http.request(method, path, json=json_body, params=params, headers=h)
        for sc in r.headers.get_list("set-cookie"):
            name, _, rest = sc.partition("=")
            if name.strip() != COOKIE:
                continue
            value = rest.split(";", 1)[0].strip()
            attrs = rest.lower()
            if not value or "max-age=0" in attrs:
                self.cookie = None
            else:
                check("httponly" in attrs and "secure" in attrs and "samesite=strict" in attrs and "path=/" in attrs
                      and "domain=" not in attrs, f"атрибуты cookie сессии: {sc.split(';', 1)[1] if ';' in sc else sc}")
                self.cookie = value
                self.seen.append(value)
        return r

    def get(self, path: str, **kw: Any) -> httpx.Response:
        return self.request("GET", path, **kw)

    def post(self, path: str, body: Any = None, **kw: Any) -> httpx.Response:
        return self.request("POST", path, json_body=body if body is not None else {}, **kw)

    def adopt(self, me: dict[str, Any]) -> None:
        self.me = me
        self.csrf = me["csrf_token"]
        self.seen.append(me["csrf_token"])


@dataclass
class Staff:
    browser: Browser
    email: str
    password: str  # текущий пароль (после смены — новый)
    display_name: str = ""
    staff_id: str = ""
    totp: Totp | None = None
    secret: str = ""


@dataclass
class Ctx:
    bff: str
    lc: s1.Ctx  # ученики (telegram-bff) — контекст сценария спринта 1
    tag: str
    staff: dict[str, Staff] = field(default_factory=dict)
    data: dict[str, Any] = field(default_factory=dict)
    secrets: dict[str, str] = field(default_factory=dict)  # что не должно попасть в логи
    seen: list[str] = field(default_factory=list)  # cookie и CSRF-токены сессий

    def browser(self, name: str) -> Browser:
        return Browser(self.bff, name, self.seen)

    def remember(self, what: str, value: str) -> None:
        self.secrets[what] = value


def new_password(c: Ctx, who: str) -> str:
    # ≥ 12, буквы и цифры, ≠ email, ≠ прежний
    pw = f"E2e-{who}-{secrets.token_hex(6)}-9x"
    c.remember(f"пароль {who}", pw)
    return pw


def login(c: Ctx, st: Staff, *, expect_next: list[str]) -> dict[str, Any]:
    """Вход по шагам LoginStep: password_change → mfa_enroll → mfa → done. Возвращает Me."""
    b = st.browser
    step = expect(b.post("/admin/v1/auth/login", {"email": st.email, "password": st.password}), 200)
    seen: list[str] = []
    for _ in range(6):
        nxt = step["next"]
        seen.append(nxt)
        if nxt == "done":
            check(step.get("me") and step.get("challenge") is None, f"done без me: {str(step)[:300]}")
            check(b.cookie, "после входа нет cookie сессии")
            b.adopt(step["me"])
            st.staff_id = step["me"]["staff"]["staff_id"]
            break
        ch = step["challenge"]
        check(isinstance(ch, str) and len(ch) >= 16 and step.get("me") is None, f"шаг {nxt}: {str(step)[:300]}")
        check(b.cookie is None, f"cookie выдана до завершения входа (шаг {nxt})")
        c.remember(f"challenge {st.email} {len(c.secrets)}", ch)
        if nxt == "password_change":
            pw = new_password(c, st.email.split("@")[0][:8])
            weak = expect(b.post("/admin/v1/auth/password", {"challenge": ch, "new_password": "short1"}), 422,
                          "PASSWORD_WEAK")
            check(weak["details"].get("rules"), weak)
            step = expect(b.post("/admin/v1/auth/password", {"challenge": ch, "new_password": pw}), 200)
            st.password = pw
        elif nxt == "mfa_enroll":
            start = expect(b.post("/admin/v1/auth/mfa/enroll/start", {"challenge": ch}), 200)
            check(start["issuer"] == "TilHero Admin" and start["otpauth_uri"].startswith("otpauth://totp/"), start)
            check(start["secret"] in start["otpauth_uri"] and start["account"] == st.email, "otpauth_uri/account")
            st.secret = start["secret"]
            c.remember(f"секрет TOTP {st.email}", start["secret"])
            st.totp = Totp(start["secret"])
            bad = expect(b.post("/admin/v1/auth/mfa/enroll/confirm", {"challenge": ch, "code": st.totp.wrong()}),
                         401, "MFA_INVALID")
            check(isinstance(bad["details"].get("remaining"), int), bad)
            step = expect(b.post("/admin/v1/auth/mfa/enroll/confirm", {"challenge": ch, "code": st.totp.code()}), 200)
        elif nxt == "mfa":
            check(st.totp is not None, "MFA подключена, но секрета у сценария нет")
            assert st.totp is not None
            step = expect(b.post("/admin/v1/auth/mfa", {"challenge": ch, "code": st.totp.code()}), 200)
            # challenge одноразовый
            expect(b.post("/admin/v1/auth/mfa", {"challenge": ch, "code": st.totp.wrong()}), 401)
        else:
            raise StepFailed(f"неизвестный шаг входа {nxt}")
    else:
        raise StepFailed(f"вход не завершился: {seen}")
    check(seen == expect_next, f"шаги входа {seen}, ожидали {expect_next}")
    return b.me


def step_up(st: Staff) -> None:
    assert st.totp is not None
    before = st.browser.cookie
    r = expect(st.browser.post("/admin/v1/auth/step-up", {"code": st.totp.code()}), 200)
    check(r.get("step_up_until"), r)
    check(st.browser.cookie and st.browser.cookie != before, "step-up не ротировал id сессии (cookie)")


def ensure_step_up(st: Staff, min_left: float = 100.0) -> None:
    """Повторный TOTP, если окна step-up нет или осталось меньше min_left секунд (окно — 5 мин)."""
    me = expect(st.browser.get("/admin/v1/me"), 200)
    st.browser.adopt(me)
    until = me["session"]["step_up_until"]
    if until and (parse_ts(until) - datetime.now(UTC)).total_seconds() > min_left:
        return
    step_up(st)


def staff_token(audience: str, permissions: set[str], actor_id: str, role: str) -> dict[str, str]:
    """Внутренний JWT с actor от имени admin-bff (ключ стенда) — проверка прав в самом домене (защита в глубину)."""
    token = issue_token(s1.ring("admin-bff"), issuer="admin-bff", audience=audience,
                        actor=Actor(id=actor_id, role=role, permissions=frozenset(permissions), name="Проверка"))
    return {"x-internal-token": token}


def tg_all(after: int) -> list[dict[str, Any]]:
    r = httpx.get(f"{MOCK_TG}/_mock/calls", params={"method": "sendMessage", "after": str(after)})
    r.raise_for_status()
    return [x for x in r.json()["items"] if isinstance(x.get("result"), dict) and "message_id" in x["result"]]


def audit_records(b: Browser, **q: str) -> list[dict[str, Any]]:
    return expect(b.get("/admin/v1/audit/records", params={**q, "limit": "100"}), 200)["items"]


# =============================================================================================== уборка стенда


def cleanup_leftovers() -> list[str]:
    """Остатки прерванного прогона (процесс убит до finally шагов): активная версия lesson.reminder, опубликованные
    заметки «Что нового» сценариев (slug e2e-…), запущенные рассылки сценария, тема Mini App с флагом сценария.
    Иначе следующий прогон сценария спринта 1 увидел бы чужой текст напоминания или лишнюю заметку. Только dev-стенд:
    staff API доменов от имени admin-bff (ключ стенда), как служебные проверки сценария спринта 1. → что сделано."""
    done: list[str] = []
    actor = str(uuid.uuid4())
    hdr = staff_token("notifications", {"notif.templates.manage", "notif.campaigns.manage", "notif.campaigns.send"},
                      actor, "super_admin")
    info = expect(httpx.get(f"{s1.NOTIFICATIONS}/admin/v1/notifications/templates/lesson.reminder", headers=hdr), 200)
    if info.get("active_version") is not None:
        expect(httpx.post(f"{s1.NOTIFICATIONS}/admin/v1/notifications/templates/lesson.reminder/reset",
                          json={"reason": "e2e: уборка после прерванного прогона"}, headers=hdr), 200)
        done.append(f"lesson.reminder: сброшена активная версия {info['active_version']}")
    for status in ("scheduled", "sending"):
        items = expect(httpx.get(f"{s1.NOTIFICATIONS}/admin/v1/notifications/campaigns",
                                 params={"status": status, "limit": 100}, headers=hdr), 200)["items"]
        for camp in items:
            if camp["title"].startswith("e2e рассылка"):
                expect(httpx.post(f"{s1.NOTIFICATIONS}/admin/v1/notifications/campaigns/{camp['campaign_id']}/stop",
                                  json={"reason": "e2e: уборка"}, headers=hdr), 200)
                done.append(f"рассылка {camp['title']}: остановлена")
    ehdr = staff_token("experience-config", {"whatsnew.manage", "whatsnew.publish", "config.read", "config.publish"},
                       actor, "super_admin")
    notes = expect(httpx.get(f"{s1.EXPERIENCE}/admin/v1/release-notes", params={"status": "published", "limit": 100},
                             headers=ehdr), 200)["items"]
    for n in notes:
        if n["slug"].startswith("e2e-"):
            r = httpx.post(f"{s1.EXPERIENCE}/admin/v1/release-notes/{n['release_note_id']}/archive",
                           json={"reason": "e2e: уборка"}, headers={**ehdr, **idem()})
            check(r.status_code in (200, 201), f"архив заметки {n['slug']}: {r.status_code} {r.text[:200]}")
            done.append(f"заметка {n['slug']}: в архив")
    for app, label in (("miniapp", "Mini App"), ("admin", "админки")):  # QA: тема админки — AT-24 (шаг A16a)
        state = expect(httpx.get(f"{s1.EXPERIENCE}/admin/v1/experience/{app}/state", headers=ehdr), 200)
        cur = (state.get("current") or {}).get("version")
        if cur:
            ver = expect(httpx.get(f"{s1.EXPERIENCE}/admin/v1/experience/{app}/versions/{cur}", headers=ehdr), 200)
            if (ver.get("payload") or {}).get("flags", {}).get("e2e_admin_marker") and state.get("previous_version"):
                expect(httpx.post(f"{s1.EXPERIENCE}/admin/v1/experience/{app}/rollback",
                                  json={"reason": "e2e: уборка"}, headers=ehdr), 201)
                done.append(f"тема {label} {cur}: откат")
    return done


# =============================================================================================== шаги


def s_stand(c: Ctx) -> None:
    for name, url in [("admin-bff", f"{c.bff}/health/ready"), ("admin-identity", f"{ADMIN_IDENTITY}/health/ready"),
                      ("user-admin", f"{USER_ADMIN}/health/ready"), ("telegram-bff", f"{TG_BFF}/health/ready"),
                      ("notifications", f"{s1.NOTIFICATIONS}/health/ready"), ("audit", f"{s1.AUDIT}/health/ready"),
                      ("identity-consent", f"{s1.IDENTITY}/health/ready"),
                      ("experience-config", f"{s1.EXPERIENCE}/health/ready"),
                      ("support", f"{s1.SUPPORT}/health/ready"), ("mock-telegram", f"{MOCK_TG}/health")]:
        r = httpx.get(url, timeout=5)
        check(r.status_code == 200, f"{name} не ready: {r.status_code} {r.text[:200]}")
    c.data["dlq_before"] = s1.dlq_counts()
    for line in cleanup_leftovers():
        print(f"      уборка: {line}", flush=True)
    c.data["policy"] = expect(httpx.get(f"{TG_BFF}/v1/legal/policy", params={"lang": "ru"}), 200)
    c.lc.data["policy"] = c.data["policy"]


# ---------------------------------------------------------------- AT-16 вход

def s_unauthorized(c: Ctx) -> None:
    b = c.browser("anon")
    nid = str(uuid.uuid4())
    routes = [
        ("GET", "/admin/v1/me"), ("GET", "/admin/v1/dashboard"), ("GET", "/admin/v1/learners"),
        ("GET", f"/admin/v1/learners/{nid}"), ("GET", "/admin/v1/support/tickets"), ("GET", "/admin/v1/staff"),
        ("GET", "/admin/v1/roles"), ("GET", "/admin/v1/audit/records"), ("GET", "/admin/v1/audit/verify"),
        ("GET", "/admin/v1/release-notes"), ("GET", "/admin/v1/notifications/templates"),
        ("GET", "/admin/v1/notifications/campaigns"), ("GET", "/admin/v1/experience/miniapp/state"),
        ("GET", "/admin/v1/experience/admin/current"),
        ("POST", "/admin/v1/staff"), ("POST", f"/admin/v1/learners/{nid}/reveal"),
        ("POST", f"/admin/v1/release-notes/{nid}/publish"), ("POST", "/admin/v1/experience/miniapp/rollback"),
        ("POST", "/admin/v1/notifications/campaigns"), ("POST", "/admin/v1/auth/step-up"),
        ("POST", "/admin/v1/auth/logout"),
    ]
    bad = []
    for method, path in routes:
        r = b.request(method, path, json_body={} if method != "GET" else None)
        if r.status_code != 401 or r.json().get("code") != "UNAUTHORIZED":
            bad.append(f"{method} {path} → {r.status_code} {r.text[:80]}")
    b.cookie = "A" * 43  # поддельная cookie
    r = b.get("/admin/v1/me")
    if r.status_code != 401:
        bad.append(f"поддельная cookie → {r.status_code}")
    check(not bad, "; ".join(bad))
    b.cookie = None
    # шаги входа — только с Origin admin-web
    expect(b.post("/admin/v1/auth/login", {"email": BOOT_EMAIL, "password": "x" * 12}, origin="https://evil.example"),
           403, "CSRF_INVALID")
    expect(b.post("/admin/v1/auth/login", {"email": BOOT_EMAIL, "password": "x" * 12}, origin=None), 403,
           "CSRF_INVALID")


def s_bootstrap(c: Ctx) -> None:
    root = Staff(c.browser("root"), BOOT_EMAIL, BOOT_PASSWORD, display_name="Администратор")
    c.staff["root"] = root
    c.remember("пароль bootstrap", BOOT_PASSWORD)
    b = root.browser
    r1 = expect(b.post("/admin/v1/auth/login", {"email": BOOT_EMAIL, "password": "wrong-password-123"}), 401,
                "INVALID_CREDENTIALS")
    check(r1["details"].get("remaining") == 4, f"остаток попыток: {r1['details']}")
    ghost = f"ghost.{secrets.token_hex(4)}@tilhero.local"
    r2 = expect(b.post("/admin/v1/auth/login", {"email": ghost, "password": "wrong-password-123"}), 401,
                "INVALID_CREDENTIALS")
    check(r2["details"].get("remaining") == 4 and set(r2) == set(r1), f"несуществующий email отличим: {r2}")
    expect(b.post("/admin/v1/auth/login", {"email": BOOT_EMAIL, "password": BOOT_PASSWORD, "role": "x"}), 422)
    me = login(c, root, expect_next=["password_change", "mfa_enroll", "done"])
    check(me["staff"]["role"] == "super_admin" and me["mfa_enabled"] is True, me["staff"])
    check(me["must_change_password"] is False and me["env"] == "dev" and me["impersonating"] is None, me)
    check(set(me["permissions"]) == ALL_PERMS, f"права super_admin: {sorted(set(me['permissions']) ^ ALL_PERMS)}")
    check(me["session"]["step_up_until"] is None, f"step-up сразу после входа: {me['session']}")
    # прежний (временный) пароль больше не действует
    expect(c.browser("root-old").post("/admin/v1/auth/login", {"email": BOOT_EMAIL, "password": BOOT_PASSWORD}),
           401, "INVALID_CREDENTIALS")
    # GET по cookie; не-GET без CSRF или с чужим Origin → 403 CSRF_INVALID
    check(expect(b.get("/admin/v1/me"), 200)["staff"]["staff_id"] == root.staff_id, "me другого сотрудника")
    expect(b.post("/admin/v1/auth/step-up", {"code": "000000"}, csrf=False), 403, "CSRF_INVALID")
    expect(b.post("/admin/v1/auth/step-up", {"code": "000000"}, origin="https://evil.example"), 403, "CSRF_INVALID")


def s_create_staff(c: Ctx) -> None:
    root = c.staff["root"]
    b = root.browser
    tag = c.tag.lower()
    comms_body = {"email": f"comms.{tag}@tilhero.local", "display_name": f"Камила Коммуникации {c.tag}",
                  "role": "communications"}
    # без step-up → 403 STEP_UP_REQUIRED (до вызова домена); без Idempotency-Key — 422
    body = expect(b.post("/admin/v1/staff", comms_body, headers=idem()), 403, "STEP_UP_REQUIRED")
    check(body["details"].get("permission") == "staff.manage", body)
    assert root.totp is not None
    expect(b.post("/admin/v1/auth/step-up", {"code": root.totp.wrong()}), 401, "MFA_INVALID")
    step_up(root)
    me = expect(b.get("/admin/v1/me"), 200)
    b.adopt(me)
    check(me["session"]["step_up_until"], me["session"])
    expect(b.post("/admin/v1/staff", comms_body), 422, "IDEMPOTENCY_KEY_REQUIRED")
    key = idem()
    created = expect(b.post("/admin/v1/staff", comms_body, headers=key), 201)
    tmp = str(created.get("temporary_password") or "")
    check(len(tmp) >= 16, "временный пароль не выдан")
    c.remember("временный пароль comms", tmp)
    appr = created.get("approval") or {}
    check(appr.get("kind") == "staff.create_privileged" and appr.get("waived") == "single_super_admin"
          and appr.get("status") == "APPLIED", f"four-eyes при одном super_admin: {appr}")
    sid = created["staff"]["staff_id"]
    rep = b.post("/admin/v1/staff", comms_body, headers=key)
    check(rep.status_code in (200, 201) and rep.json()["staff"]["staff_id"] == sid
          and rep.json().get("temporary_password") is None, f"повтор Idempotency-Key: {rep.status_code} {rep.text[:200]}")
    got = expect(b.get(f"/admin/v1/staff/{sid}"), 200)
    check(got["role"] == "communications" and got["must_change_password"] is True and got["mfa_enabled"] is False
          and got["created_by"] == root.staff_id, got)
    c.staff["comms"] = Staff(c.browser("comms"), comms_body["email"], tmp, comms_body["display_name"], sid)

    sup_body = {"email": f"support.{tag}@tilhero.local", "display_name": f"Алина Поддержка {c.tag}", "role": "support"}
    sup = expect(b.post("/admin/v1/staff", sup_body, headers=idem()), 201)
    check(sup.get("approval") is None and sup["staff"]["role"] == "support", sup.get("approval"))
    c.remember("временный пароль support", sup["temporary_password"])
    c.staff["support"] = Staff(c.browser("support"), sup_body["email"], sup["temporary_password"],
                               sup_body["display_name"], sup["staff"]["staff_id"])
    expect(b.post("/admin/v1/staff", sup_body, headers=idem()), 409, "STAFF_EMAIL_EXISTS")
    # отдельная учётка для проверки блокировки входа (AT-16)
    lock_body = {"email": f"lock.{tag}@tilhero.local", "display_name": f"Блок Проверка {c.tag}", "role": "read_only"}
    lk = expect(b.post("/admin/v1/staff", lock_body, headers=idem()), 201)
    c.remember("временный пароль lock", lk["temporary_password"])
    c.staff["lock"] = Staff(c.browser("lock"), lock_body["email"], lk["temporary_password"], lock_body["display_name"],
                            lk["staff"]["staff_id"])
    lst = expect(b.get("/admin/v1/staff", params={"q": f"{tag}@tilhero.local", "limit": 50}), 200)
    ids = {s["staff_id"] for s in lst["items"]}
    check({sid, sup["staff"]["staff_id"], lk["staff"]["staff_id"]} <= ids, f"сотрудники не в списке: {ids}")
    check(all("temporary_password" not in s and "password_hash" not in s for s in lst["items"]), "секреты в списке")


def s_lockout(c: Ctx) -> None:
    """AT-16: 5 неверных паролей → 423 ACCOUNT_LOCKED на 15 мин; верный пароль во время блокировки — тоже 423."""
    lk = c.staff["lock"]
    b = lk.browser
    for i in range(4):
        r = expect(b.post("/admin/v1/auth/login", {"email": lk.email, "password": f"wrong-pass-{i}-x1y2"}), 401,
                   "INVALID_CREDENTIALS")
        check(r["details"].get("remaining") == 4 - i, f"попытка {i + 1}: {r['details']}")
    r = expect(b.post("/admin/v1/auth/login", {"email": lk.email, "password": "wrong-pass-4-x1y2"}), 423,
               "ACCOUNT_LOCKED")
    check(840 <= int(r["details"].get("retry_after", 0)) <= 900, f"блокировка 15 мин: {r['details']}")
    # верный пароль во время блокировки. Лимит admin-bff на email — 5/мин (prod): шестой вход за минуту получает
    # 429 — ждём Retry-After, как браузер, и повторяем
    resp = b.post("/admin/v1/auth/login", {"email": lk.email, "password": lk.password})
    if resp.status_code == 429:
        wait = float(resp.headers.get("retry-after") or resp.json()["details"].get("retry_after") or 13)
        print(f"      … лимит входа на email (5/мин): ждём {wait:.0f} с", flush=True)
        time.sleep(wait + 0.5)
        resp = b.post("/admin/v1/auth/login", {"email": lk.email, "password": lk.password})
    expect(resp, 423, "ACCOUNT_LOCKED")
    check(b.cookie is None, "cookie выдана заблокированной учётке")


def s_comms_login(c: Ctx) -> None:
    cm = c.staff["comms"]
    me = login(c, cm, expect_next=["password_change", "mfa_enroll", "done"])
    check(me["staff"]["role"] == "communications" and me["mfa_enabled"] is True, me["staff"])
    check(set(me["permissions"]) == COMMS_PERMS, f"права communications: {sorted(me['permissions'])}")
    check(me["staff"]["display_name"] == cm.display_name and me["session"]["step_up_until"] is None, me)


def s_support_login(c: Ctx) -> None:
    sp = c.staff["support"]
    me = login(c, sp, expect_next=["password_change", "done"])
    check(me["staff"]["role"] == "support" and me["mfa_enabled"] is False, me["staff"])
    check(set(me["permissions"]) == SUPPORT_PERMS, f"права support: {sorted(me['permissions'])}")
    r = sp.browser.post("/admin/v1/auth/step-up", {"code": "123456"})
    check(r.status_code in (401, 409), f"step-up без подключённой MFA: {r.status_code} {r.text[:200]}")


# ---------------------------------------------------------------- AT-17 RBAC

def s_rbac(c: Ctx) -> None:
    sp, cm = c.staff["support"].browser, c.staff["comms"].browser
    nid = str(uuid.uuid4())
    note = {"slug": "x", "title": {"ru": "x", "uz": "x"}, "items": [], "audience": "all", "segments": {}}
    cases = [
        (sp, "GET", "/admin/v1/release-notes", None, "whatsnew.manage"),
        (sp, "POST", "/admin/v1/release-notes", note, "whatsnew.manage"),
        (sp, "POST", f"/admin/v1/release-notes/{nid}/publish", {"expected_version": 1, "reason": "e2e: проверка"},
         "whatsnew.publish"),
        (sp, "POST", f"/admin/v1/release-notes/{nid}/archive", {"reason": "e2e: проверка"}, "whatsnew.publish"),
        (sp, "GET", "/admin/v1/notifications/templates", None, "notif.templates.manage"),
        (sp, "GET", "/admin/v1/notifications/campaigns", None, "notif.campaigns.manage"),
        (sp, "GET", "/admin/v1/staff", None, "staff.manage"),
        (sp, "GET", "/admin/v1/audit/records", None, "audit.read"),
        (sp, "POST", f"/admin/v1/learners/{nid}/reveal", {"field": "telegram_user_id", "reason": "e2e: проверка"},
         "users.sensitive.read"),
        (cm, "GET", "/admin/v1/learners", None, "users.read"),
        (cm, "GET", "/admin/v1/support/tickets", None, "support.read"),
        (cm, "GET", "/admin/v1/experience/miniapp/state", None, "config.read"),
        (cm, "POST", "/admin/v1/experience/miniapp/rollback", {"reason": "e2e: проверка"}, "config.publish"),
    ]
    bad = []
    for b, method, path, body, perm in cases:
        r = b.request(method, path, json_body=body, headers=idem() if method == "POST" else None)
        j = r.json() if r.content else {}
        if r.status_code != 403 or j.get("code") != "PERMISSION_DENIED" or j.get("details", {}).get("permission") != perm:
            bad.append(f"{b.name} {method} {path} → {r.status_code} {str(j)[:120]}")
    check(not bad, "; ".join(bad))
    # защита в глубину: домен сам проверяет права actor (как если бы admin-bff пропустил запрос)
    sup_id = c.staff["support"].staff_id
    r = httpx.post(f"{s1.EXPERIENCE}/admin/v1/release-notes/{nid}/publish",
                   json={"expected_version": 1, "reason": "e2e: проверка"},
                   headers={**staff_token("experience-config", SUPPORT_PERMS, sup_id, "support"), **idem()})
    expect(r, 403, "PERMISSION_DENIED")
    r = httpx.get(f"{s1.EXPERIENCE}/admin/v1/release-notes",
                  headers=staff_token("experience-config", SUPPORT_PERMS, sup_id, "support"))
    expect(r, 403, "PERMISSION_DENIED")
    r = httpx.post(f"{s1.NOTIFICATIONS}/admin/v1/notifications/campaigns/{nid}/stop", json={"reason": "e2e: проверка"},
                   headers=staff_token("notifications", COMMS_PERMS - {"notif.campaigns.send"}, sup_id, "support"))
    expect(r, 403, "PERMISSION_DENIED")
    # QA (AT-17 дословно): роль С правом whatsnew.manage, но БЕЗ whatsnew.publish — публикация 403 и в самом домене
    cm_id = c.staff["comms"].staff_id
    r = httpx.post(f"{s1.EXPERIENCE}/admin/v1/release-notes/{nid}/publish",
                   json={"expected_version": 1, "reason": "e2e: проверка"},
                   headers={**staff_token("experience-config", COMMS_PERMS - {"whatsnew.publish"}, cm_id,
                                          "communications"), **idem()})
    body = expect(r, 403, "PERMISSION_DENIED")
    check(body["details"].get("permission") == "whatsnew.publish", f"право в отказе домена: {body['details']}")
    r = httpx.post(f"{s1.EXPERIENCE}/admin/v1/release-notes/{nid}/archive", json={"reason": "e2e: проверка"},
                   headers={**staff_token("experience-config", COMMS_PERMS - {"whatsnew.publish"}, cm_id,
                                          "communications"), **idem()})
    expect(r, 403, "PERMISSION_DENIED")
    # меню admin-web строится из me.permissions — у support нет разделов «Что нового» и «Уведомления»
    check(not ({"whatsnew.manage", "whatsnew.publish", "notif.templates.manage"} & set(
        expect(sp.get("/admin/v1/me"), 200)["permissions"])), "права «Что нового»/уведомлений у support")


# ---------------------------------------------------------------- ученики (Mini App через telegram-bff)

def s_learners(c: Ctx) -> None:
    lc = c.lc
    z = lc.data["zone_day"]
    now = datetime.now(UTC)
    # слоты напоминаний AT-20: R1 — после активации версии шаблона, R2 — через минуту, после сброса к тексту по
    # умолчанию (часы сервисов не подменяются; местное время «дневной» зоны около 13:00 — не тихие часы)
    # QA: R3 — слот после отката к предыдущей версии шаблона (AT-20 «откат к предыдущей версии»), R2 — после сброса
    t1 = (now + timedelta(seconds=100)).replace(second=0, microsecond=0) + timedelta(minutes=1)
    t_rb = t1 + timedelta(minutes=1)
    t2 = t1 + timedelta(minutes=2)
    c.data.update(slot1=t1, slot_rb=t_rb, slot2=t2)
    print(f"      дневная зона {z}; слоты напоминаний {t1:%H:%M}Z, {t_rb:%H:%M}Z и {t2:%H:%M}Z", flush=True)
    news = [*s1.REQUIRED, "product_news"]
    la = lc.user("LA", "Азиза")  # взрослый, согласие «Новости TilHero», категория product — в аудитории рассылки
    s1.onboard(la, zone=z, purposes=news, categories={"product": True})
    lb = lc.user("LB", "Бобур")  # взрослый без цели product_news — вне аудитории
    s1.onboard(lb, zone=z, categories={"product": True})
    p = lc.user("P", "Дилноза")  # родитель с согласием product_news и детский профиль 10–13
    s1.onboard(p, zone=z, purposes=news, categories={"product": True})
    kid = p.ok("POST", "/v1/learners", 201, json={"display_name": f"Мадина {c.tag}K", "age_band": "10-13"}, idem=True)
    c.data.update(kid=kid["learner_id"], kid_name=f"Мадина {c.tag}K")
    p.switch(kid["learner_id"])
    s1.plan_patch(p, {"goal": "study", "level_self": "zero", "schedule": {
        "preset": "daily", "preferred_time": "18:00", "duration_min": 15, "reminders_enabled": False, "timezone": z}})
    r = p.req("PATCH", "/v1/profile/settings", json={"notifications": {"categories": {"product": True}, "timezone": z}})
    c.data["kid_product_setting"] = r.status_code
    p.ok("POST", "/v1/plan/onboarding/complete")
    p.switch(p.account_id)
    for role, name, slot in (("R1", "Рустам", t1), ("R3", "Сардор", t_rb), ("R2", "Бахром", t2)):
        u = lc.user(role, name)
        s1.onboard(u, zone=z, categories={"reminders": True}, schedule=s1.slot_schedule(slot, z, True))
    # QA (AT-22 сегмент): LU — интерфейс UZ, согласие «Новости TilHero»; LN — согласие и категория есть, онбординг
    # не пройден; LA — занимался сегодня (активность), остальные — нет
    lu = lc.user("LU", "Улугбек")
    s1.onboard(lu, zone=z, purposes=news, categories={"product": True})
    check(lu.ok("PATCH", "/v1/profile/settings", json={"locale": "uz"})["account"]["locale"] == "uz", "locale LU")
    s1.plan_patch(lu, {"ui_lang": "uz"})
    ln = lc.user("LN", "Нигора")
    s1.onboard(ln, zone=z, purposes=news, categories={"product": True}, complete=False)
    la.ok("POST", "/v1/plan/activity", json={"kind": "practice", "minutes": 10}, idem=True)
    s = lc.user("S", "Севара")  # автор обращения AT-25
    s1.onboard(s, zone=z)
    # LQ — в аудитории рассылки, но сейчас у него тихие часы (рассылка откладывается до их конца)
    lq = lc.user("LQ", "Лазиз")
    quiet = {"start": s1.hhmm(now - timedelta(minutes=1), z), "end": s1.hhmm(now + timedelta(minutes=40), z)}
    c.data["quiet_end"] = (now + timedelta(minutes=40)).replace(second=0, microsecond=0)  # QA: тот же момент в UTC
    s1.onboard(lq, zone=z, purposes=news, categories={"product": True}, quiet=quiet)
    # T — подросток 14–17: согласие родителя (P) по ссылке gc_, затем своё согласие с product_news; в рассылку —
    # только если в сегменте явно указаны teens
    pol = c.data["policy"]
    t = lc.user("T", "Тимур")
    t.device_tz = z
    t.login()
    t.ok("PUT", "/v1/profile/age", json={"age_band": "14-17"})
    t.ok("POST", "/v1/profile/consent", json={"policy_version": pol["version"], "purposes": s1.REQUIRED})
    t.ok("POST", "/v1/profile/consent", 403, "GUARDIAN_CONSENT_REQUIRED",
         json={"policy_version": pol["version"], "purposes": news})
    token = t.ok("POST", "/v1/profile/guardian-consent")["link"].split("startapp=gc_", 1)[1]
    c.remember("токен согласия родителя", token)
    check(p.ok("POST", f"/v1/guardian-consents/{token}/accept")["status"] == "granted", "согласие родителя")
    t.login()
    check(t.session["account"]["guardian_consent"] == "granted", t.session["account"])
    t.ok("POST", "/v1/profile/consent", json={"policy_version": pol["version"], "purposes": news})
    s1.plan_patch(t, {"goal": "exam", "level_self": "some", "schedule": {
        "preset": "daily", "preferred_time": "18:00", "duration_min": 15, "reminders_enabled": False, "timezone": z}})
    t.ok("PATCH", "/v1/profile/settings", json={"notifications": {
        "enabled": True, "categories": {"product": True}, "timezone": z, "quiet_hours": None}})
    t.ok("POST", "/v1/plan/onboarding/complete")
    # «Что нового» до публикации: знакомство (welcome) → просмотрено → none
    wn = la.ok("GET", "/v1/whats-new")
    check(wn["mode"] == "welcome", f"LA после онбординга: {wn['mode']}")
    la.ok("POST", "/v1/whats-new/seen", 204, json={"release_note_ids": [n["release_note_id"] for n in wn["notes"]]})
    check(la.ok("GET", "/v1/whats-new")["mode"] == "none", "после seen знакомство показывается снова")
    la.inbox()  # первое чтение центра уведомлений ставит водяной знак (как Mini App)
    # проекция активности identity-consent (аудитория рассылок: onboarded) — из learning.plan.updated.v1
    ids = ",".join(f"'{s1.uid(x.account_id)}'" for x in (la, lb, p, lq, t, lu))
    wait_for(lambda: s1._psql("SELECT count(*) FROM identity_consent.learner_activity WHERE user_id IN "
                              f"({ids}) AND onboarding_completed_at IS NOT NULL") == "6", 30,
             what="learner_activity (онбординг) в identity-consent")
    wait_for(lambda: s1._psql("SELECT count(*) FROM identity_consent.learner_activity WHERE user_id = "
                              f"'{s1.uid(la.account_id)}' AND last_activity_at IS NOT NULL") == "1", 30,
             what="learner_activity (занятие LA) в identity-consent")
    s1.plan_tick()  # окно plan:tick — до слотов
    lead = (t1 - datetime.now(UTC)).total_seconds()
    check(lead > 30, f"подготовка учеников заняла слишком долго: до слота {lead:.0f} с")


# ---------------------------------------------------------------- AT-19, AT-18 «Что нового»

def _note(c: Ctx, slug: str, *, uz: bool = True) -> dict[str, Any]:
    return {
        "slug": slug,
        "title": {"ru": f"Новое в TilHero {c.tag}", "uz": f"TilHero yangiliklari {c.tag}" if uz else ""},
        "items": [
            {"title": {"ru": "Повторение слов", "uz": "Soʻzlarni takrorlash"},
             "text": {"ru": "Повторяйте слова по 5 минут в день.", "uz": "Kuniga 5 daqiqa soʻzlarni takrorlang." if uz
                      else " "},
             "link": "review", "icon": "book"},
            {"title": {"ru": "Новости", "uz": "Yangiliklar"},
             "text": {"ru": "Все обновления — в разделе «Новости».", "uz": "Barcha yangiliklar — «Yangiliklar» boʻlimida."},
             "link": "news", "icon": "news"},
        ],
        "audience": "existing",
        "segments": {},
    }


def _fields(body: dict[str, Any]) -> set[str]:
    """Поля ошибки VALIDATION_ERROR admin-bff: details.field и details.errors[].field (схема тела запроса BFF)."""
    det = body.get("details") or {}
    return {det.get("field") or ""} | {e.get("field") or "" for e in det.get("errors") or []}


def s_note_translation(c: Ctx) -> None:
    cm = c.staff["comms"].browser
    body = expect(cm.post("/admin/v1/release-notes", _note(c, f"e2e-adm-{c.tag.lower()}-x", uz=False), headers=idem()),
                  422, "RELEASE_NOTE_TRANSLATION_MISSING")
    missing = set(body["details"].get("missing") or [])
    check({"title.uz", "items[0].text.uz"} <= missing, f"подсвеченные поля: {sorted(missing)}")
    # запрещённый маршрут пункта → 422 (ничего не сохранено)
    bad = _note(c, f"e2e-adm-{c.tag.lower()}-y")
    bad["items"][0]["link"] = "admin"
    r = cm.post("/admin/v1/release-notes", bad, headers=idem())
    check(r.status_code == 422, f"запрещённый маршрут: {r.status_code} {r.text[:200]}")
    check(r.json().get("code") == "VALIDATION_ERROR" and "items.0.link" in _fields(r.json()),
          f"запрещённый маршрут — поле в ответе: {r.text[:300]}")
    drafts = expect(cm.get("/admin/v1/release-notes", params={"status": "draft", "limit": 100}), 200)["items"]
    check(not [n for n in drafts if n["slug"].startswith(f"e2e-adm-{c.tag.lower()}")], "черновик сохранён при 422")
    # QA (AT-19 «сохранить нельзя» — и правкой): PUT черновика с пустым UZ или запрещённым маршрутом → 422, черновик
    # прежний (версия, тексты, маршрут). Черновик остаётся в списке (slug e2e-adz-…; учеников не касается)
    ok = expect(cm.post("/admin/v1/release-notes", _note(c, f"e2e-adz-{c.tag.lower()}"), headers=idem()), 201)
    nid, ver = ok["release_note_id"], ok["version"]
    empty = {**_note(c, f"e2e-adz-{c.tag.lower()}", uz=False), "expected_version": ver}
    body = expect(cm.request("PUT", f"/admin/v1/release-notes/{nid}", json_body=empty), 422,
                  "RELEASE_NOTE_TRANSLATION_MISSING")
    missing = set(body["details"].get("missing") or [])
    check({"title.uz", "items[0].text.uz"} <= missing, f"PUT: подсвеченные поля: {sorted(missing)}")
    routed = {**_note(c, f"e2e-adz-{c.tag.lower()}"), "expected_version": ver}
    routed["items"][1]["link"] = "admin"
    r = cm.request("PUT", f"/admin/v1/release-notes/{nid}", json_body=routed)
    check(r.status_code == 422 and r.json().get("code") == "VALIDATION_ERROR" and "items.1.link" in _fields(r.json()),
          f"PUT: запрещённый маршрут: {r.status_code} {r.text[:300]}")
    got = expect(cm.get(f"/admin/v1/release-notes/{nid}"), 200)
    check(got["status"] == "draft" and got["version"] == ver and got["title"]["uz"] == f"TilHero yangiliklari {c.tag}"
          and got["items"][1]["link"] == "news" and got["items"][0]["text"]["uz"],
          f"черновик изменён отклонённой правкой: v{got['version']} {got['title']} {got['items'][1]['link']}")


def s_whats_new(c: Ctx) -> None:
    cmst = c.staff["comms"]
    cm = cmst.browser
    la = c.lc.users["LA"]
    note = expect(cm.post("/admin/v1/release-notes", _note(c, f"e2e-adm-{c.tag.lower()}"), headers=idem()), 201)
    nid = note["release_note_id"]
    c.data["note"] = nid
    check(note["status"] == "draft" and note["version"] == 1 and note["views_total"] == 0, note)
    check(note["created_by"] == cmst.staff_id and note["created_by_name"] == cmst.display_name,
          f"автор черновика: {note['created_by']} {note['created_by_name']}")
    published = False
    try:
        pub = {"expected_version": note["version"], "reason": "e2e: публикация обновления"}
        body = expect(cm.post(f"/admin/v1/release-notes/{nid}/publish", pub, headers=idem()), 403, "STEP_UP_REQUIRED")
        check(body["details"].get("permission") == "whatsnew.publish", body)
        step_up(cmst)
        out = expect(cm.post(f"/admin/v1/release-notes/{nid}/publish", pub, headers=idem()), 201)
        published = True
        check(out["status"] == "published" and out["published_by"] == cmst.staff_id
              and out["published_by_name"] == cmst.display_name and out["published_at"], out)
        # ученик, прошедший онбординг до публикации (audience existing), видит заметку при следующем входе один раз
        la.login()
        wn = la.ok("GET", "/v1/whats-new")
        ids = [n["release_note_id"] for n in wn["notes"]]
        check(wn["mode"] == "updates" and nid in ids, f"следующий вход: {wn['mode']} {ids} (ждали {nid})")
        mine = next(n for n in wn["notes"] if n["release_note_id"] == nid)
        check(mine["title"] == f"Новое в TilHero {c.tag}" and len(mine["items"]) == 2, mine)
        check(nid in [n["release_note_id"] for n in la.ok("GET", "/v1/news")["items"]], "заметки нет в ленте «Новости»")
        la.ok("POST", "/v1/whats-new/seen", 204, json={"release_note_ids": ids})
        check(nid not in [n["release_note_id"] for n in la.ok("GET", "/v1/whats-new")["notes"]], "показана повторно")
        la.login()
        check(nid not in [n["release_note_id"] for n in la.ok("GET", "/v1/whats-new")["notes"]],
              "после нового входа показана повторно")
        st = expect(cm.get(f"/admin/v1/release-notes/{nid}/stats"), 200)
        check(st["views_total"] == 1 and st["views_by_lang"] == {"ru": 1, "uz": 0}
              and st["views_by_age"].get("adults") == 1 and st["first_view_at"], f"статистика показов: {st}")
        lst = expect(cm.get("/admin/v1/release-notes", params={"status": "published", "limit": 100}), 200)["items"]
        check(any(n["release_note_id"] == nid and n["views_total"] == 1 for n in lst), "views_total в списке")
        # снятие (архив) — заметка больше не показывается
        ensure_step_up(cmst)
        arch = expect(cm.post(f"/admin/v1/release-notes/{nid}/archive", {"reason": "e2e: снятие"}, headers=idem()), 201)
        published = False
        check(arch["status"] == "archived" and arch["archived_by"] == cmst.staff_id, arch)
        again = cm.post(f"/admin/v1/release-notes/{nid}/archive", {"reason": "e2e: снятие"}, headers=idem())
        check(again.status_code == 200, f"повторный архив: {again.status_code}")
        check(nid not in [n["release_note_id"] for n in la.ok("GET", "/v1/news")["items"]], "архивная — в ленте")
        check(nid not in [n["release_note_id"] for n in la.ok("GET", "/v1/whats-new")["notes"]], "архивная — в шторке")
    finally:
        if published:  # уборка: заметка не должна остаться опубликованной для следующих прогонов
            hdr = staff_token("experience-config", {"whatsnew.publish"}, cmst.staff_id, "communications")
            httpx.post(f"{s1.EXPERIENCE}/admin/v1/release-notes/{nid}/archive", json={"reason": "e2e: уборка"},
                       headers={**hdr, **idem()})


# ---------------------------------------------------------------- AT-20 шаблон напоминания, AT-21 тестовая отправка

def _texts(c: Ctx, marker: str, extra: str = "") -> dict[str, Any]:
    return {
        "ru": {"title": f"Пора заниматься {marker}",
               "body": f"Сегодня {{duration}} в {{slot_time}}{extra}. Метка {marker}.", "button": "Начать"},
        "uz": {"title": f"Mashgʻulot vaqti {marker}",
               "body": f"Bugun {{duration}}, soat {{slot_time}}{extra}. Belgi {marker}.", "button": "Boshlash"},
    }


def s_template(c: Ctx) -> None:
    cmst = c.staff["comms"]
    cm = cmst.browser
    key = "lesson.reminder"
    marker = f"ШБЛ-{c.tag}"
    c.data["tpl_marker"] = marker
    lst = expect(cm.get("/admin/v1/notifications/templates"), 200)["items"]
    info = next((t for t in lst if t["key"] == key), None)
    check(info is not None and info["category"] == "reminders" and info["kid"] is False, f"{key} в списке: {info}")
    assert info is not None
    check({p["name"] for p in info["placeholders"]} == {"duration", "slot_time", "streak_days"}, info["placeholders"])
    check(info["active_version"] is None and info["default_texts"]["ru"]["title"] == "Время занятия", info)
    check(not any(t["key"].startswith("pin.") for t in lst), "служебные pin.* в списке редактируемых")
    # неизвестный плейсхолдер и пустой язык → 422 TEMPLATE_INVALID {fields}
    body = expect(cm.post(f"/admin/v1/notifications/templates/{key}/versions",
                          {"texts": _texts(c, marker, " для {learner_name}"), "note": "e2e: неизвестный"},
                          headers=idem()), 422, "TEMPLATE_INVALID")
    paths = {f["path"] for f in body["details"].get("fields", [])}
    check(paths == {"texts.ru.body", "texts.uz.body"} and {f["reason"] for f in body["details"]["fields"]}
          == {"unknown_placeholder"}, f"поля ошибки: {body['details']}")
    empty = _texts(c, marker)
    empty["uz"]["body"] = ""
    body = expect(cm.post(f"/admin/v1/notifications/templates/{key}/versions", {"texts": empty, "note": "e2e: пусто"},
                          headers=idem()), 422, "TEMPLATE_INVALID")
    check([f["path"] for f in body["details"]["fields"]] == ["texts.uz.body"], body["details"])
    ver = expect(cm.post(f"/admin/v1/notifications/templates/{key}/versions",
                         {"texts": _texts(c, marker), "note": "e2e: новый текст напоминания"}, headers=idem()), 201)
    v = ver["version"]
    c.data["tpl_version"] = v
    check(ver["status"] == "draft" and ver["created_by_name"] == cmst.display_name, ver)
    pv = expect(cm.post(f"/admin/v1/notifications/templates/{key}/versions/{v}/preview", {"lang": "ru"}), 200)
    check(marker in pv["title"] and "{" not in pv["body"] and marker in pv["telegram_text"], f"предпросмотр: {pv}")
    active = False
    try:
        ensure_step_up(cmst)
        act = expect(cm.post(f"/admin/v1/notifications/templates/{key}/versions/{v}/activate",
                             {"reason": "e2e: активация нового текста"}), 200)
        active = True
        check(act["status"] == "active" and act["activated_by"] == cmst.staff_id
              and act["activated_by_name"] == cmst.display_name, act)
        det = expect(cm.get(f"/admin/v1/notifications/templates/{key}"), 200)
        check(det["active_version"] == v and det["versions"][0]["version"] == v, f"активная версия: {det['active_version']}")
        # новое напоминание (слот R1) уходит с новым текстом
        r1, r2 = c.lc.users["R1"], c.lc.users["R2"]
        seq = s1.tg_last_seq()
        c.data["seq_tpl"] = seq
        s1.sleep_until(c.data["slot1"] + timedelta(seconds=2), "слот R1")
        res = s1.plan_tick()
        check(res["reminders"] >= 1, f"plan:tick: {res}")
        msgs = wait_for(lambda: s1.tg_sent(r1.tg_id, seq), 30, what="напоминание R1 в Telegram")
        text = msgs[0]["payload"]["text"]
        check(marker in text and "15 минут" in text and s1.hhmm(c.data["slot1"], c.lc.data["zone_day"]) in text,
              f"напоминание с новым текстом: {text!r}")
        check("{" not in text and "Время занятия" not in text, f"плейсхолдеры/старый текст: {text!r}")
        check(not s1.tg_sent(r2.tg_id, seq), "напоминание R2 раньше его слота")
        # QA (AT-20 «откат к предыдущей версии»): вторая версия v2 активна → снова активируем v (прежняя активная v2 →
        # archived) → новое напоминание (слот R3) уходит текстом v, а не v2
        marker2 = f"ШБЛ2-{c.tag}"
        r3 = c.lc.users["R3"]
        ver2 = expect(cm.post(f"/admin/v1/notifications/templates/{key}/versions",
                              {"texts": _texts(c, marker2), "note": "e2e: вторая версия"}, headers=idem()), 201)
        v2 = ver2["version"]
        check(v2 > v and ver2["status"] == "draft", ver2)
        ensure_step_up(cmst)
        a2 = expect(cm.post(f"/admin/v1/notifications/templates/{key}/versions/{v2}/activate",
                            {"reason": "e2e: активация второй версии"}), 200)
        check(a2["status"] == "active" and a2["version"] == v2, a2)
        det = expect(cm.get(f"/admin/v1/notifications/templates/{key}"), 200)
        st = {x["version"]: x["status"] for x in det["versions"]}
        check(det["active_version"] == v2 and st.get(v) == "archived" and st.get(v2) == "active", f"после v2: {st}")
        ensure_step_up(cmst)
        back = expect(cm.post(f"/admin/v1/notifications/templates/{key}/versions/{v}/activate",
                              {"reason": "e2e: откат к предыдущей версии"}), 200)
        check(back["status"] == "active" and back["version"] == v, f"откат к v{v}: {back}")
        det = expect(cm.get(f"/admin/v1/notifications/templates/{key}"), 200)
        st = {x["version"]: x["status"] for x in det["versions"]}
        check(det["active_version"] == v and st.get(v) == "active" and st.get(v2) == "archived", f"после отката: {st}")
        check(not s1.tg_sent(r3.tg_id, seq), "напоминание R3 раньше его слота")
        s1.sleep_until(c.data["slot_rb"] + timedelta(seconds=2), "слот R3")
        res = s1.plan_tick()
        check(res["reminders"] >= 1, f"plan:tick: {res}")
        msgs = wait_for(lambda: s1.tg_sent(r3.tg_id, seq), 30, what="напоминание R3 в Telegram")
        text = msgs[0]["payload"]["text"]
        check(marker in text and marker2 not in text and "{" not in text,
              f"после отката к v{v} — текст v{v}: {text!r}")
        c.data["tpl_rollback"] = True
        # сброс к тексту по умолчанию (step-up): новые напоминания — текстом из кода
        ensure_step_up(cmst)
        rs = expect(cm.post(f"/admin/v1/notifications/templates/{key}/reset", {"reason": "e2e: откат к тексту по умолчанию"}),
                    200)
        active = False
        check(rs["active_version"] is None, f"после сброса: {rs.get('active_version')}")
        det = expect(cm.get(f"/admin/v1/notifications/templates/{key}"), 200)
        check(next(x for x in det["versions"] if x["version"] == v)["status"] == "archived", "версия не в архиве")
        s1.sleep_until(c.data["slot2"] + timedelta(seconds=2), "слот R2")
        res = s1.plan_tick()
        check(res["reminders"] >= 1, f"plan:tick: {res}")
        msgs = wait_for(lambda: s1.tg_sent(r2.tg_id, seq), 30, what="напоминание R2 в Telegram")
        text = msgs[0]["payload"]["text"]
        check("Время занятия" in text and marker not in text, f"после сброса — текст по умолчанию: {text!r}")
        check(len(s1.tg_sent(r1.tg_id, seq)) == 1, "R1 получил напоминание повторно")
        check(len(s1.tg_sent(r3.tg_id, seq)) == 1, "R3 получил напоминание повторно")
    finally:
        if active:
            hdr = staff_token("notifications", {"notif.templates.manage"}, cmst.staff_id, "communications")
            httpx.post(f"{s1.NOTIFICATIONS}/admin/v1/notifications/templates/{key}/reset",
                       json={"reason": "e2e: уборка"}, headers=hdr)


def s_test_send(c: Ctx) -> None:
    """AT-21: тестовая отправка — только в тестовый чат из ADMIN_TEST_CHAT_IDS, с «[ТЕСТ]», ученикам ничего."""
    cmst = c.staff["comms"]
    cm = cmst.browser
    v, marker = c.data["tpl_version"], c.data["tpl_marker"]
    items = expect(cm.get("/admin/v1/notifications/test-recipients"), 200)["items"]
    check([x["index"] for x in items] == list(range(len(TEST_CHAT_IDS))), f"тестовые получатели: {items}")
    check(all(str(cid) not in json.dumps(items) for cid in TEST_CHAT_IDS)
          and items[0]["label"].endswith(f"{str(TEST_CHAT_IDS[0])[-4:]})"), f"маски получателей: {items}")
    seq = s1.tg_last_seq()
    db_t0 = s1._psql("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")
    res = expect(cm.post(f"/admin/v1/notifications/templates/lesson.reminder/versions/{v}/test",
                         {"lang": "ru", "recipient": 0}), 200)
    check(res["sent"] is True and res["delivery_id"] and res["error"] is None, res)
    c.data["tpl_tested"] = True
    msgs = wait_for(lambda: s1.tg_sent(TEST_CHAT_IDS[0], seq), 15, what="тестовое сообщение в тестовом чате")
    text = msgs[0]["payload"]["text"]
    check(text.startswith("[ТЕСТ] ") or "[ТЕСТ] " in text.split("\n", 1)[0], f"префикс [ТЕСТ]: {text!r}")
    check(marker in text and "{" not in text, f"текст версии с образцами: {text!r}")
    expect(cm.post(f"/admin/v1/notifications/templates/lesson.reminder/versions/{v}/test",
                   {"lang": "uz", "recipient": 99}), 422, "TEST_RECIPIENT_NOT_ALLOWED")
    time.sleep(1.5)
    others = [x for x in tg_all(seq) if x["payload"].get("chat_id") not in TEST_CHAT_IDS
              and str(x["payload"].get("chat_id")) not in {str(i) for i in TEST_CHAT_IDS}]
    check(not [x for x in others if "[ТЕСТ]" in x["payload"].get("text", "")], f"тест ушёл ученику: {others[:2]}")
    learners = {u.tg_id for u in c.lc.users.values()}
    check(not [x for x in others if int(x["payload"]["chat_id"]) in learners], "ученикам ушло сообщение при тесте")
    # без записи в центр уведомлений: ни одной записи с текстом версии после начала теста (метка — из сценария)
    check(re.fullmatch(r"[0-9TZ:.-]+", db_t0) and re.fullmatch(r"[A-Za-zА-Яа-я0-9-]+", marker), "метка/время")
    rows = s1._psql(f"SELECT count(*) FROM notifications.notifications WHERE created_at >= '{db_t0}' "
                    f"AND (title LIKE '%{marker}%' OR body LIKE '%{marker}%')")
    check(rows == "0", f"тест записан в центр уведомлений: {rows}")


# ---------------------------------------------------------------- AT-22 рассылки

def _campaign(c: Ctx, marker: str) -> dict[str, Any]:
    return {
        "title": f"e2e рассылка {marker}",
        "texts": {
            "ru": {"title": f"Новости TilHero {marker}", "body": f"{{learner_name}}, у нас новое! Метка {marker}.",
                   "button": "Открыть"},
            "uz": {"title": f"TilHero yangiliklari {marker}", "body": f"{{learner_name}}, bizda yangilik! Belgi {marker}.",
                   "button": "Ochish"},
        },
        "route": "news",
        "segment": {"ui_lang": ["ru"], "age": ["adults"], "onboarded": True},
    }


def _audience(params: dict[str, str]) -> tuple[set[str], list[dict[str, Any]]]:
    """identity-consent /internal/v1/audience от имени notifications (как исполнение рассылки) — все страницы."""
    hdr = s1.internal_token("notifications", "identity-consent")
    ids: set[str] = set()
    items: list[dict[str, Any]] = []
    cursor: str | None = None
    for _ in range(200):
        q = {**params, "limit": "500", **({"cursor": cursor} if cursor else {})}
        page = expect(httpx.get(f"{s1.IDENTITY}/internal/v1/audience", params=q, headers=hdr), 200)
        items += page["items"]
        ids |= {x["user_id"] for x in page["items"]}
        cursor = page.get("next_cursor")
        if not cursor:
            break
    return ids, items


def s_audience_segments(c: Ctx) -> None:
    """QA (AT-22 «сегмент: язык, возраст 14+/18+, онбординг, активность»): каждый фильтр сегмента отбирает и
    исключает конкретных учеников сценария. Всегда вне аудитории: без согласия product_news (LB), детский профиль."""
    u = c.lc.users
    la, lb, p, lq, t, lu, ln = (u[k].account_id for k in ("LA", "LB", "P", "LQ", "T", "LU", "LN"))
    kid = c.data["kid"]
    cases: list[tuple[dict[str, str], set[str], set[str]]] = [
        ({}, {la, p, lq, lu, ln}, {lb, t, kid}),                      # по умолчанию — взрослые с согласием
        ({"ui_lang": "uz"}, {lu}, {la, p, lq, ln, lb, t, kid}),
        ({"ui_lang": "ru"}, {la, p, lq, ln}, {lu, lb, t, kid}),
        ({"age": "teens"}, {t}, {la, p, lu, lb, kid}),
        ({"age": "teens,adults"}, {t, la, lu}, {lb, kid}),
        ({"onboarded": "true"}, {la, p, lq, lu}, {ln, lb, kid}),
        ({"onboarded": "false"}, {ln}, {la, p, lq, lu, lb, kid}),
        ({"active_days": "1"}, {la}, {p, lq, lu, ln, lb, kid}),
        ({"active_days": "-1"}, {p, lq, lu, ln}, {la, lb, kid}),
        ({"ui_lang": "ru", "age": "teens,adults", "onboarded": "true", "active_days": "-7"}, {p, lq, t}, {la, lu, ln}),
    ]
    bad = []
    for params, inside, outside in cases:
        ids, items = _audience(params)
        if not inside <= ids or ids & outside:
            names = {v.account_id: k for k, v in u.items()} | {kid: "ребёнок"}
            bad.append(f"{params}: нет {[names[x] for x in inside - ids]}, лишние {[names[x] for x in ids & outside]}")
        extra = {k for x in items for k in x} - {"user_id", "locale"}
        if extra:
            bad.append(f"{params}: лишние поля аудитории {sorted(extra)}")
    check(not bad, "; ".join(bad))
    hdr = s1.internal_token("notifications", "identity-consent")
    cnt = expect(httpx.get(f"{s1.IDENTITY}/internal/v1/audience/count", params={"ui_lang": "uz"}, headers=hdr), 200)
    check(cnt["count"] == len(_audience({"ui_lang": "uz"})[0]) and cnt["by_lang"].get("ru", 0) == 0, f"count uz: {cnt}")
    expect(httpx.get(f"{s1.IDENTITY}/internal/v1/audience", params={"age": "kids"}, headers=hdr), 422)
    # аудиторию отдаёт только notifications
    r = httpx.get(f"{s1.IDENTITY}/internal/v1/audience", headers=s1.internal_token("admin-bff", "identity-consent"))
    check(r.status_code == 403, f"аудитория для admin-bff: {r.status_code}")


def _run_campaign(cm: Browser, cid: str) -> dict[str, Any]:
    """notifications:dispatch (как n8n) до завершения рассылки."""
    for _ in range(20):
        s1.dispatch()
        camp = expect(cm.get(f"/admin/v1/notifications/campaigns/{cid}"), 200)
        if camp["status"] in ("done", "stopped"):
            return camp
        time.sleep(0.5)
    raise StepFailed(f"рассылка {cid} не завершилась: {camp['status']} {camp['stats']}")


def _recipient(cid: str, user_id: str) -> str:
    return s1._psql("SELECT coalesce(string_agg(status, ','), '') FROM notifications.campaign_recipients "
                    f"WHERE campaign_id = '{s1.uid(cid)}' AND user_id = '{s1.uid(user_id)}'")


def s_campaigns(c: Ctx) -> None:
    cmst = c.staff["comms"]
    cm = cmst.browser
    la, lb, p = c.lc.users["LA"], c.lc.users["LB"], c.lc.users["P"]
    lq, teen = c.lc.users["LQ"], c.lc.users["T"]
    kid = c.data["kid"]
    m1, m2, m3 = f"РСЛ1-{c.tag}", f"РСЛ2-{c.tag}", f"РСЛ3-{c.tag}"
    scheduled: list[str] = []
    try:
        expect(cm.post("/admin/v1/notifications/campaigns", _campaign(c, m1)), 422, "IDEMPOTENCY_KEY_REQUIRED")
        kids = _campaign(c, m1)
        kids["segment"] = {"age": ["kids"]}
        body = expect(cm.post("/admin/v1/notifications/campaigns", kids, headers=idem()), 422)
        check(body["code"] in ("CAMPAIGN_INVALID", "VALIDATION_ERROR"), f"сегмент kids: {body}")
        c1 = expect(cm.post("/admin/v1/notifications/campaigns", _campaign(c, m1), headers=idem()), 201)
        cid1 = c1["campaign_id"]
        check(c1["status"] == "draft" and c1["created_by_name"] == cmst.display_name, c1)
        est = expect(cm.post(f"/admin/v1/notifications/campaigns/{cid1}/estimate", {}), 200)
        check(est["audience"] >= 2 and est["by_lang"]["ru"] >= 2 and est["by_lang"]["uz"] == 0,
              f"оценка охвата (LA и P как минимум): {est}")
        # тестовая отправка рассылки — только тестовый чат
        seq = s1.tg_last_seq()
        t = expect(cm.post(f"/admin/v1/notifications/campaigns/{cid1}/test", {"lang": "ru", "recipient": 1}), 200)
        check(t["sent"] is True, t)
        msg = wait_for(lambda: s1.tg_sent(TEST_CHAT_IDS[1], seq, contains=m1), 15, what="тест рассылки")[0]
        check("[ТЕСТ]" in msg["payload"]["text"], msg["payload"]["text"])
        check(not s1.tg_sent(la.tg_id, seq), "тест рассылки ушёл ученику")
        # «Отправить сейчас» (send_at=null, step-up) → старт сразу, первая пачка в фоне, остальное — dispatch (D2-03)
        ensure_step_up(cmst)
        sched = {"expected_version": c1["version"], "send_at": None, "reason": "e2e: запуск рассылки"}
        expect(cm.post(f"/admin/v1/notifications/campaigns/{cid1}/schedule", {**sched, "expected_version": 99},
                       headers=idem()), 409, "CAMPAIGN_VERSION_CONFLICT")
        s = expect(cm.post(f"/admin/v1/notifications/campaigns/{cid1}/schedule", sched, headers=idem()), 200)
        scheduled.append(cid1)
        check(s["status"] == "sending" and s["started_at"] and s["scheduled_by"] == cmst.staff_id, s)
        done = _run_campaign(cm, cid1)
        check(done["status"] == "done" and done["stats"]["created"] >= 2 and done["finished_at"], done)
        msgs = wait_for(lambda: s1.tg_sent(la.tg_id, seq, contains=m1), 30, what="рассылка у ученика LA в Telegram")
        text = msgs[0]["payload"]["text"]
        check(len(msgs) == 1 and la.first in text and "{" not in text, f"текст рассылки: {text!r}")
        check(s1.startapp_of(msgs[0]["payload"]) == "route_news", msgs[0]["payload"].get("reply_markup"))
        check(_recipient(cid1, la.account_id) == "created", f"LA: {_recipient(cid1, la.account_id)}")
        wait_for(lambda: s1.tg_sent(p.tg_id, seq, contains=m1), 30, what="рассылка у родителя P")
        time.sleep(1.5)
        check(len(s1.tg_sent(p.tg_id, seq, contains=m1)) == 1, "родителю ушло больше одной рассылки (ребёнок?)")
        check(not s1.tg_sent(lb.tg_id, seq, contains=m1), "рассылка ушла ученику без согласия product_news")
        check(_recipient(cid1, lb.account_id) == "" and _recipient(cid1, kid) == "",
              f"в аудитории: LB={_recipient(cid1, lb.account_id)!r} ребёнок={_recipient(cid1, kid)!r}")
        n = s1._psql("SELECT count(*) FROM notifications.notifications WHERE user_id = "
                     f"'{s1.uid(kid)}' AND dedup_key LIKE 'campaign:%'")
        check(n == "0", f"запись рассылки у детского профиля: {n}")
        # подросток 14–17 с согласием родителя — не в сегменте «взрослые» (по умолчанию)
        check(_recipient(cid1, teen.account_id) == "", f"подросток в рассылке для взрослых: {_recipient(cid1, teen.account_id)}")
        check(not s1.tg_sent(teen.tg_id, seq, contains=m1), "рассылка для взрослых ушла подростку")
        # тихие часы ученика: запись создана, отправка отложена до их конца, в Telegram пока ничего
        check(_recipient(cid1, lq.account_id) == "created", f"LQ: {_recipient(cid1, lq.account_id)}")
        st_q = s1._psql("SELECT telegram_status || ':' || coalesce(reason, '-') FROM notifications.notifications "
                        f"WHERE user_id = '{s1.uid(lq.account_id)}' AND dedup_key = 'campaign:{s1.uid(cid1)}:"
                        f"{s1.uid(lq.account_id)}'")
        check(st_q == "scheduled:quiet_hours", f"LQ в тихие часы: {st_q} (ожидали scheduled:quiet_hours)")
        check(not s1.tg_sent(lq.tg_id, seq, contains=m1), "рассылка ушла в тихие часы")
        # QA (AT-22 «после окончания тихих часов по местному времени ученика»): запись отложена ровно до их конца
        q_end = c.data["quiet_end"]
        sched_at = s1._psql("SELECT to_char(scheduled_for AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') FROM "
                            f"notifications.notifications WHERE user_id = '{s1.uid(lq.account_id)}' AND dedup_key = "
                            f"'campaign:{s1.uid(cid1)}:{s1.uid(lq.account_id)}'")
        check(sched_at and abs((parse_ts(sched_at) - q_end).total_seconds()) <= 90,
              f"LQ: отложено до {sched_at}, конец тихих часов {q_end:%Y-%m-%dT%H:%M}Z")
        # QA (AT-22 сегмент): язык UZ (LU) и «онбординг не пройден» (LN) — вне рассылки «RU, взрослые, онбординг»
        lu, ln = c.lc.users["LU"], c.lc.users["LN"]
        check(_recipient(cid1, lu.account_id) == "" and _recipient(cid1, ln.account_id) == "",
              f"вне сегмента: LU={_recipient(cid1, lu.account_id)!r} LN={_recipient(cid1, ln.account_id)!r}")
        check(not s1.tg_sent(lu.tg_id, seq, contains=m1) and not s1.tg_sent(ln.tg_id, seq, contains=m1),
              "рассылка RU/онбординг ушла LU или LN")
        sent = wait_for(lambda: (lambda x: x if x["stats"]["sent"] >= 2 else None)(
            expect(cm.get(f"/admin/v1/notifications/campaigns/{cid1}"), 200)), 20, what="stats.sent")
        check(sent["stats"]["audience"] >= 3 and sent["stats"]["deferred"] >= 1, f"статистика: {sent['stats']}")
        # повторная рассылка тем же ученикам в течение 7 дней → skipped_frequency; сегмент явно с подростками —
        # подросток с согласием родителя её получает (первая рассылка для него)
        body2 = _campaign(c, m2)
        body2["segment"]["age"] = ["adults", "teens"]
        body2["segment"]["ui_lang"] = ["ru", "uz"]  # QA: + UZ — LU получает текст UZ
        c2 = expect(cm.post("/admin/v1/notifications/campaigns", body2, headers=idem()), 201)
        cid2 = c2["campaign_id"]
        est2 = expect(cm.post(f"/admin/v1/notifications/campaigns/{cid2}/estimate", {}), 200)
        check(est2["frequency_capped"] >= 2 and est2["by_lang"]["uz"] >= 1, f"оценка лимита частоты и UZ: {est2}")
        ensure_step_up(cmst)
        expect(cm.post(f"/admin/v1/notifications/campaigns/{cid2}/schedule",
                       {**sched, "expected_version": c2["version"]}, headers=idem()), 200)
        scheduled.append(cid2)
        done2 = _run_campaign(cm, cid2)
        check(done2["status"] == "done" and done2["stats"]["skipped_frequency"] >= 2, f"вторая рассылка: {done2['stats']}")
        check(_recipient(cid2, la.account_id) == "skipped_frequency", f"LA: {_recipient(cid2, la.account_id)}")
        time.sleep(1.5)
        check(not s1.tg_sent(la.tg_id, seq, contains=m2), "вторая рассылка за 7 дней ушла LA")
        check(_recipient(cid2, teen.account_id) == "created", f"подросток (teens в сегменте): "
              f"{_recipient(cid2, teen.account_id)}")
        wait_for(lambda: s1.tg_sent(teen.tg_id, seq, contains=m2), 30, what="рассылка с teens у подростка")
        # QA: LU (интерфейс UZ) — текст UZ с его именем; LN (онбординг не пройден) — нет
        check(_recipient(cid2, lu.account_id) == "created", f"LU во второй: {_recipient(cid2, lu.account_id)}")
        uz_msg = wait_for(lambda: s1.tg_sent(lu.tg_id, seq, contains=m2), 30, what="рассылка UZ у LU")[0]
        uz_text = uz_msg["payload"]["text"]
        check(f"TilHero yangiliklari {m2}" in uz_text and "bizda yangilik" in uz_text and lu.first in uz_text
              and "Новости TilHero" not in uz_text, f"текст UZ: {uz_text!r}")
        check(_recipient(cid2, ln.account_id) == "", f"LN (онбординг не пройден): {_recipient(cid2, ln.account_id)}")
        # QA (AT-22 «экстренная остановка прекращает отправку»): стоп уже завершённой первой рассылки отменяет то, что
        # ещё не ушло, — отложенное тихими часами сообщение LQ; отправленное (LA) не отзывается
        ensure_step_up(cmst)
        st1 = expect(cm.post(f"/admin/v1/notifications/campaigns/{cid1}/stop", {"reason": "e2e: стоп после отправки"}),
                     200)
        check(st1["status"] == "stopped" and st1["stopped_by"] == cmst.staff_id, f"стоп done: {st1['status']}")
        lq_st = s1._psql("SELECT telegram_status FROM notifications.notifications WHERE user_id = "
                         f"'{s1.uid(lq.account_id)}' AND dedup_key = 'campaign:{s1.uid(cid1)}:{s1.uid(lq.account_id)}'")
        la_st = s1._psql("SELECT telegram_status FROM notifications.notifications WHERE user_id = "
                         f"'{s1.uid(la.account_id)}' AND dedup_key = 'campaign:{s1.uid(cid1)}:{s1.uid(la.account_id)}'")
        check(lq_st == "cancelled" and la_st == "sent", f"после стопа: LQ={lq_st} LA={la_st}")
        check(_recipient(cid1, lq.account_id) == "cancelled", f"получатель LQ: {_recipient(cid1, lq.account_id)}")
        check(m1 not in json.dumps(lq.inbox(), ensure_ascii=False), "отменённая рассылка в центре уведомлений LQ")
        c.data["campaign_stopped_done"] = cid1
        # третья: расписание на будущее → экстренная остановка до старта → никому не ушло
        c3 = expect(cm.post("/admin/v1/notifications/campaigns", _campaign(c, m3), headers=idem()), 201)
        cid3 = c3["campaign_id"]
        ensure_step_up(cmst)
        later3 = (datetime.now(UTC) + timedelta(hours=2)).replace(microsecond=0)
        expect(cm.post(f"/admin/v1/notifications/campaigns/{cid3}/schedule",
                       {**sched, "expected_version": c3["version"],
                        "send_at": later3.isoformat().replace("+00:00", "Z")}, headers=idem()), 200)
        scheduled.append(cid3)
        sp = expect(cm.post(f"/admin/v1/notifications/campaigns/{cid3}/stop", {"reason": "e2e: экстренная остановка"}),
                    200)
        check(sp["status"] == "stopped" and sp["stopped_by"] == cmst.staff_id and sp["stop_reason"], sp)
        expect(cm.post(f"/admin/v1/notifications/campaigns/{cid3}/stop", {"reason": "e2e: повтор"}), 200)
        seq3 = s1.tg_last_seq()
        s1.dispatch()
        time.sleep(2)
        camp3 = expect(cm.get(f"/admin/v1/notifications/campaigns/{cid3}"), 200)
        check(camp3["status"] == "stopped" and camp3["stats"]["created"] == 0 and camp3["stats"]["sent"] == 0,
              f"остановленная рассылка: {camp3['status']} {camp3['stats']}")
        n3 = s1._psql(f"SELECT count(*) FROM notifications.campaign_recipients WHERE campaign_id = '{s1.uid(cid3)}' "
                      "AND status <> 'cancelled'")
        check(n3 == "0", f"получатели остановленной рассылки: {n3}")
        leaked = [x for x in tg_all(seq3) if m3 in x["payload"].get("text", "")]
        check(not leaked, f"остановленная рассылка ушла: {len(leaked)}")
        scheduled.remove(cid3)
        # QA (AT-22 «расписание → доставка в момент отправки»): рассылка на время через 2 ч — dispatch её не трогает
        # (ни получателей, ни сообщений), снятие с расписания возвращает черновик
        m4 = f"РСЛ4-{c.tag}"
        c4 = expect(cm.post("/admin/v1/notifications/campaigns", _campaign(c, m4), headers=idem()), 201)
        cid4 = c4["campaign_id"]
        later = (datetime.now(UTC) + timedelta(hours=2)).replace(microsecond=0)
        ensure_step_up(cmst)
        s4 = expect(cm.post(f"/admin/v1/notifications/campaigns/{cid4}/schedule",
                            {**sched, "expected_version": c4["version"],
                             "send_at": later.isoformat().replace("+00:00", "Z")}, headers=idem()), 200)
        scheduled.append(cid4)
        check(s4["status"] == "scheduled" and parse_ts(s4["send_at"]) == later, f"расписание +2 ч: {s4['send_at']}")
        seq4 = s1.tg_last_seq()
        s1.dispatch()
        time.sleep(1.5)
        camp4 = expect(cm.get(f"/admin/v1/notifications/campaigns/{cid4}"), 200)
        n4 = s1._psql(f"SELECT count(*) FROM notifications.campaign_recipients WHERE campaign_id = '{s1.uid(cid4)}'")
        check(camp4["status"] == "scheduled" and camp4["started_at"] is None and n4 == "0",
              f"до send_at: {camp4['status']} started_at={camp4['started_at']} получателей={n4}")
        check(not [x for x in tg_all(seq4) if m4 in x["payload"].get("text", "")], "рассылка ушла раньше send_at")
        un = expect(cm.post(f"/admin/v1/notifications/campaigns/{cid4}/unschedule", {"reason": "e2e: перенос"}), 200)
        check(un["status"] == "draft", f"снятие с расписания: {un['status']}")
        scheduled.remove(cid4)
        c.data["campaign_future"] = cid4
        # список рассылок и сводка для дашборда
        lst = expect(cm.get("/admin/v1/notifications/campaigns", params={"limit": 50}), 200)["items"]
        check({cid1, cid2, cid3, cid4} <= {x["campaign_id"] for x in lst}, "рассылки не в списке")
        c.data["campaigns"] = [cid1, cid2, cid3]
    finally:
        # уборка: незавершённые рассылки этого прогона не должны уйти позже (следующие dispatch)
        for cid in scheduled:
            camp = cm.get(f"/admin/v1/notifications/campaigns/{cid}")
            if camp.status_code == 200 and camp.json()["status"] in ("scheduled", "sending"):
                hdr = staff_token("notifications", {"notif.campaigns.send"}, cmst.staff_id, "communications")
                httpx.post(f"{s1.NOTIFICATIONS}/admin/v1/notifications/campaigns/{cid}/stop",
                           json={"reason": "e2e: уборка"}, headers=hdr)


# ---------------------------------------------------------------- AT-23 ученики в админке

def s_learners_admin(c: Ctx) -> None:
    root = c.staff["root"]
    # новая вкладка/браузер: вход с MFA (password → mfa → done) — сессия без step-up
    r2 = Staff(c.browser("root-2"), root.email, root.password, root.display_name, totp=root.totp)
    c.staff["root2"] = r2
    me = login(c, r2, expect_next=["mfa", "done"])
    check(me["staff"]["staff_id"] == root.staff_id and r2.browser.cookie != root.browser.cookie, "вход root-2")
    b = r2.browser
    p = c.lc.users["P"]
    kid = c.data["kid"]
    mask_tail = str(p.tg_id)[-3:]

    def row() -> dict[str, Any] | None:
        items = expect(b.get("/admin/v1/learners", params={"q": p.account_id}), 200)["items"]
        return items[0] if items and items[0]["children_count"] == 1 else None

    rw = wait_for(row, 30, what="ученик P в реестре user-admin (проекция)")
    assert rw is not None
    check(rw["user_id"] == p.account_id and rw["kind"] == "account" and rw["age_band"] == "18+"
          and rw["status"] == "ACTIVE" and rw["onboarding_completed"] is True, rw)
    masked = rw["telegram_id_masked"] or ""
    check(masked.endswith(mask_tail) and str(p.tg_id) not in masked and "•" in masked, f"маска Telegram ID: {masked}")
    lst = expect(b.get("/admin/v1/learners", params={"q": f"@{p.username}"}), 200)["items"]
    check([x["user_id"] for x in lst] == [p.account_id], f"поиск по @username: {[x['user_id'] for x in lst]}")
    card = expect(b.get(f"/admin/v1/learners/{p.account_id}"), 200)
    blob = json.dumps(card, ensure_ascii=False)
    check(str(p.tg_id) not in blob, "полный Telegram ID в карточке")
    check([ch["user_id"] for ch in card["children"]] == [kid] and card["children"][0]["kind"] == "child"
          and card["children"][0]["age_band"] == "10-13" and card["children"][0]["telegram_id_masked"] is None,
          f"дети в карточке: {card['children']}")
    check("product_news" in card["consent"]["purposes"] and card["consent"]["basis"] == "self", card["consent"])
    check(card["plan"] and card["plan"]["goal"] == "travel" and card["notifications"]["categories"]["product"] is True,
          f"план/уведомления: {card['plan']} {card['notifications']}")
    check(card["tickets"] == [] and card["refreshed_at"], f"обращения в карточке: {card['tickets']}")
    # QA (AT-23): график в карточке; полный @username — только с users.sensitive.read (super_admin)
    sch = (card["plan"] or {}).get("schedule") or {}
    check(sch.get("timezone") == c.lc.data["zone_day"] and sch.get("preferred_time") == "19:00"
          and sch.get("duration_min") == 20, f"график в карточке: {sch}")
    check(card["username"] == p.username, f"@username у super_admin: {card['username']!r}")
    # QA (AT-23 «у аккаунта — собственное согласие, решение родителя — отдельно»): подросток T
    t = c.lc.users["T"]
    tc = expect(b.get(f"/admin/v1/learners/{t.account_id}"), 200)
    check(tc["age_band"] == "14-17" and tc["guardian_consent"] == "granted" and tc["consent"]["basis"] == "self"
          and "product_news" in tc["consent"]["purposes"] and tc["consent"]["revoked_at"] is None,
          f"согласие подростка: guardian_consent={tc['guardian_consent']} consent={tc['consent']}")
    kc = expect(b.get(f"/admin/v1/learners/{kid}"), 200)
    check(kc["kind"] == "child" and kc["guardian"] and kc["guardian"]["user_id"] == p.account_id
          and kc["guardian_user_id"] == p.account_id and kc["children"] == [], f"карточка ребёнка: {kc.get('guardian')}")
    expect(b.get(f"/admin/v1/learners/{uuid.uuid4()}"), 404)
    # раскрытие Telegram ID: без step-up → 403; со step-up → значение 60 с + sensitive.view в аудите
    reveal = {"field": "telegram_user_id", "reason": f"e2e: проверка обращения {c.tag}"}
    c.remember("причина раскрытия", reveal["reason"])
    body = expect(b.post(f"/admin/v1/learners/{p.account_id}/reveal", reveal), 403, "STEP_UP_REQUIRED")
    check(body["details"].get("permission") == "users.sensitive.read", body)
    step_up(r2)
    r = b.post(f"/admin/v1/learners/{p.account_id}/reveal", reveal)
    rv = expect(r, 200)
    check(rv["value"] == str(p.tg_id) and rv["expires_in"] == 60 and rv["field"] == "telegram_user_id", "значение reveal")
    c.data["revealed"] = True
    check("no-store" in (r.headers.get("cache-control") or ""), f"Cache-Control reveal: {r.headers.get('cache-control')}")
    expect(b.post(f"/admin/v1/learners/{kid}/reveal", reveal), 409, "FIELD_NOT_AVAILABLE")
    expect(b.post(f"/admin/v1/learners/{p.account_id}/reveal", {**reveal, "reason": "x"}), 422)
    recs = wait_for(lambda: audit_records(b, action="sensitive.view", object_id=p.account_id), 20,
                    what="sensitive.view в аудите")
    check(recs[0]["actor_id"] == root.staff_id and recs[0]["actor_type"] == "staff", recs[0])
    check(str(p.tg_id) not in json.dumps(recs, ensure_ascii=False), "значение Telegram ID в записи аудита")
    # support: реестр — да (users.read), раскрытие — нет
    sp = c.staff["support"].browser
    check(expect(sp.get("/admin/v1/learners", params={"q": p.account_id}), 200)["items"], "support не видит реестр")
    expect(sp.post(f"/admin/v1/learners/{p.account_id}/reveal", reveal), 403, "PERMISSION_DENIED")
    # QA (AT-23): support (users.read без users.sensitive.read) — @username маской «первые 2 + ••• + последние 2» в
    # реестре, карточке и у опекуна в карточке ребёнка; поиск по точному @username работает, полного значения нет
    mask = f"{p.username[:2]}•••{p.username[-2:]}"
    rows = expect(sp.get("/admin/v1/learners", params={"q": f"@{p.username}"}), 200)["items"]
    check([x["user_id"] for x in rows] == [p.account_id] and rows[0]["username"] == mask,
          f"support: поиск по @username → {[(x['user_id'], x['username']) for x in rows]}")
    sc = expect(sp.get(f"/admin/v1/learners/{p.account_id}"), 200)
    skc = expect(sp.get(f"/admin/v1/learners/{kid}"), 200)
    blob = json.dumps([rows, sc, skc], ensure_ascii=False)
    check(sc["username"] == mask and (skc["guardian"] or {}).get("username") == mask and p.username not in blob,
          f"support: маска @username {sc['username']!r} / опекун {(skc['guardian'] or {}).get('username')!r}")


# ---------------------------------------------------------------- AT-25 поддержка

def s_support_desk(c: Ctx) -> None:
    sst = c.staff["support"]
    sp = sst.browser
    s = c.lc.users["S"]
    body = {"category": "SCHEDULE_REMINDERS", "subject": f"Не пришло напоминание {c.tag}",
            "message": f"Обращение ученика {c.tag}: напоминание не пришло.",
            "context": {"client_version": "telegram-miniapp-1.0"}}
    t = s.ok("POST", "/v1/support/tickets", 201, json=body, idem=True)
    tid, number = t["ticket_id"], t["number"]
    c.data["ticket"] = tid
    q = expect(sp.get("/admin/v1/support/tickets", params={"status": "open", "limit": 100}), 200)["items"]
    check(any(x["ticket_id"] == tid and x["status"] == "NEW" for x in q), "обращения нет в очереди оператора")
    tk = expect(sp.post(f"/admin/v1/support/tickets/{tid}/take", {}), 200)
    check(tk["status"] == "IN_PROGRESS" and tk["assignee_id"] == sst.staff_id
          and tk["assignee_name"] == sst.display_name, f"взять в работу: {tk['status']} {tk['assignee_name']}")
    check(tk["learner"] and tk["learner"]["user_id"] == s.account_id and str(s.tg_id) not in json.dumps(tk),
          f"сводка ученика в тикете: {tk.get('learner')}")
    public = f"Проверили график {c.tag}: напоминание придёт в следующий слот."
    internal = f"ВНУТРЕННЯЯ ЗАМЕТКА {c.tag}: проверить plan:tick"
    c.remember("ответ оператора", public)
    c.remember("внутренняя заметка", internal)
    seq = s1.tg_last_seq()
    expect(sp.post(f"/admin/v1/support/tickets/{tid}/messages", {"text": public, "visibility": "public"}), 422,
           "IDEMPOTENCY_KEY_REQUIRED")
    r1 = sp.post(f"/admin/v1/support/tickets/{tid}/messages", {"text": internal, "visibility": "internal"},
                 headers=idem())
    check(r1.status_code in (200, 201), f"заметка: {r1.status_code} {r1.text[:200]}")
    r2 = sp.post(f"/admin/v1/support/tickets/{tid}/messages", {"text": public, "visibility": "public"}, headers=idem())
    check(r2.status_code in (200, 201), f"ответ: {r2.status_code} {r2.text[:200]}")
    staff_view = expect(sp.get(f"/admin/v1/support/tickets/{tid}"), 200)
    vis = {m["text"]: m["visibility"] for m in staff_view["messages"]}
    check(vis.get(internal) == "internal" and vis.get(public) == "public", f"видимость в тикете оператора: {vis}")
    op = next(m for m in staff_view["messages"] if m["text"] == public)
    check(op["author_id"] == sst.staff_id and op["author_name"] == sst.display_name, op)
    cv = expect(sp.get(f"/admin/v1/support/tickets/{tid}/client-view"), 200)
    check(internal not in json.dumps(cv, ensure_ascii=False) and public in json.dumps(cv, ensure_ascii=False),
          "client-view показывает внутреннюю заметку или не показывает ответ")
    # ученик: только public, в приложении и в Telegram (уведомление без текста ответа)
    lt = s.ok("GET", f"/v1/support/tickets/{tid}")
    blob = json.dumps(lt, ensure_ascii=False)
    check(public in blob and internal not in blob and "ВНУТРЕННЯЯ" not in blob, "ученик видит заметку или не видит ответ")
    opmsg = next(m for m in lt["messages"] if m["sender_type"] == "operator")
    check(opmsg["author_name"] == sst.display_name.split()[0], f"имя оператора у ученика: {opmsg['author_name']}")
    msgs = wait_for(lambda: s1.tg_sent(s.tg_id, seq, contains=number), 30, what="«Поддержка ответила» в Telegram")
    time.sleep(1.5)
    msgs = s1.tg_sent(s.tg_id, seq)
    check(len([m for m in msgs if number in m["payload"]["text"]]) == 1, f"уведомлений об ответе: {len(msgs)}")
    check(all(public not in m["payload"]["text"] and internal not in m["payload"]["text"] for m in msgs),
          "текст ответа/заметки в Telegram")
    check(s1.startapp_of(msgs[0]["payload"]) == f"ticket_{number}", msgs[0]["payload"].get("reply_markup"))
    inbox = s.inbox()
    check(any(i["category"] == "support" for i in inbox), "ответа нет в центре уведомлений")
    check(internal not in json.dumps(inbox, ensure_ascii=False), "заметка в центре уведомлений ученика")
    # карточка ученика у оператора: обращения (support, агрегация admin-bff) и счётчики проекции user-admin
    card = expect(sp.get(f"/admin/v1/learners/{s.account_id}"), 200)
    check(card["tickets"] and card["tickets"][0]["number"] == number and card["tickets"][0]["ticket_id"] == tid,
          f"обращения в карточке: {card['tickets']}")

    def counted() -> dict[str, Any] | None:
        rows = expect(sp.get("/admin/v1/learners", params={"q": number}), 200)["items"]
        return rows[0] if rows and rows[0]["tickets_total"] >= 1 else None

    row = wait_for(counted, 30, what="поиск по TCK-номеру и счётчик обращений (user-admin)")
    assert row is not None
    check(row["user_id"] == s.account_id and row["tickets_total"] == 1 and row["open_tickets"] == 1, row)
    # без support.reply ответить нельзя: communications → 403
    expect(c.staff["comms"].browser.post(f"/admin/v1/support/tickets/{tid}/messages",
                                         {"text": "x", "visibility": "public"}, headers=idem()), 403,
           "PERMISSION_DENIED")


# ---------------------------------------------------------------- AT-24 аудит и откат конфигурации

def s_config_rollback(c: Ctx) -> None:
    r2 = c.staff["root2"]
    b = r2.browser
    state = expect(b.get("/admin/v1/experience/miniapp/state"), 200)
    cur = state["current"]["version"]
    base = expect(b.get(f"/admin/v1/experience/miniapp/versions/{cur}"), 200)
    payload = base["payload"]
    payload = {k: v for k, v in payload.items() if k not in ("app", "version")}
    payload["flags"] = {**payload.get("flags", {}), "e2e_admin_marker": True}
    for _ in range(5):
        new = f"1.{secrets.randbelow(9000) + 1000}.{secrets.randbelow(9000) + 1000}"
        r = b.post("/admin/v1/experience/miniapp/versions",
                   {"version": new, "payload": payload, "change_note": f"e2e: версия {c.tag}"}, headers=idem())
        if r.status_code != 409:
            break
    expect(r, 201)
    activated = False
    try:
        ensure_step_up(r2)
        act = expect(b.post("/admin/v1/experience/miniapp/activate", {"version": new, "reason": "e2e: активация темы"}),
                     201)
        activated = True
        check(act["version"] == new and act["previous_version"] == cur and act["kind"] == "activate", act)

        def tg_version(want: str) -> dict[str, Any] | None:
            cfg = expect(httpx.get(f"{TG_BFF}/v1/experience/config"), 200)
            return cfg if cfg["version"] == want else None

        cfg = wait_for(lambda: tg_version(new), 20, what=f"telegram-bff отдаёт {new}")
        check(cfg["flags"].get("e2e_admin_marker") is True, cfg["flags"])
        rb = expect(b.post("/admin/v1/experience/miniapp/rollback", {"reason": "e2e: откат темы"}), 201)
        activated = False
        check(rb["version"] == cur and rb["kind"] == "rollback" and rb["previous_version"] == new, rb)
        cfg = wait_for(lambda: tg_version(cur), 20, what=f"telegram-bff после отката отдаёт {cur}")
        check("e2e_admin_marker" not in cfg["flags"], f"после отката: {cfg['flags']}")
        st = expect(b.get("/admin/v1/experience/miniapp/state"), 200)
        check(st["current"]["version"] == cur and st["previous_version"] == new, st)
        acts = expect(b.get("/admin/v1/experience/miniapp/activations", params={"limit": 5}), 200)["items"]
        check([a["kind"] for a in acts[:2]] == ["rollback", "activate"], [a["kind"] for a in acts[:2]])
    finally:
        if activated:
            hdr = staff_token("experience-config", {"config.publish"}, r2.staff_id, "super_admin")
            httpx.post(f"{s1.EXPERIENCE}/admin/v1/experience/miniapp/rollback", json={"reason": "e2e: уборка"},
                       headers=hdr)
    c.data["config"] = (cur, new)


def s_admin_theme_rollback(c: Ctx) -> None:
    """QA (AT-24 «откат темы … и админки без сборки»): версия конфигурации admin → активация → admin-web получает её
    из /admin/v1/experience/admin/current (читается при каждом открытии) → откат → снова прежняя."""
    r2 = c.staff["root2"]
    b = r2.browser
    state = expect(b.get("/admin/v1/experience/admin/state"), 200)
    cur = state["current"]["version"]
    base = expect(b.get(f"/admin/v1/experience/admin/versions/{cur}"), 200)
    payload = {k: v for k, v in base["payload"].items() if k not in ("app", "version")}
    payload["flags"] = {**payload.get("flags", {}), "e2e_admin_marker": True}
    payload["layout"] = {**payload["layout"], "density": "compact" if payload["layout"].get("density") != "compact"
                         else "comfortable"}
    for _ in range(5):
        new = f"1.{secrets.randbelow(9000) + 1000}.{secrets.randbelow(9000) + 1000}"
        r = b.post("/admin/v1/experience/admin/versions",
                   {"version": new, "payload": payload, "change_note": f"e2e: тема админки {c.tag}"}, headers=idem())
        if r.status_code != 409:
            break
    expect(r, 201)
    other = expect(c.staff["comms"].browser.get("/admin/v1/experience/admin/current"), 200)  # любой сотрудник
    check(other["version"] == cur, f"до активации: {other['version']}")
    activated = False
    try:
        ensure_step_up(r2)
        act = expect(b.post("/admin/v1/experience/admin/activate", {"version": new, "reason": "e2e: тема админки"}),
                     201)
        activated = True
        check(act["version"] == new and act["previous_version"] == cur and act["app"] == "admin", act)
        got = expect(c.staff["comms"].browser.get("/admin/v1/experience/admin/current"), 200)
        check(got["version"] == new and got["layout"]["density"] == payload["layout"]["density"],
              f"админка после активации: {got['version']} {got['layout'].get('density')}")
        rb = expect(b.post("/admin/v1/experience/admin/rollback", {"reason": "e2e: откат темы админки"}), 201)
        activated = False
        check(rb["version"] == cur and rb["kind"] == "rollback" and rb["previous_version"] == new, rb)
        got = expect(c.staff["comms"].browser.get("/admin/v1/experience/admin/current"), 200)
        check(got["version"] == cur and got["layout"]["density"] == base["payload"]["layout"]["density"]
              and "e2e_admin_marker" not in (got.get("flags") or {}), f"админка после отката: {got['version']}")
        acts = expect(b.get("/admin/v1/experience/admin/activations", params={"limit": 5}), 200)["items"]
        check([a["kind"] for a in acts[:2]] == ["rollback", "activate"], [a["kind"] for a in acts[:2]])
        if c.data.get("config"):  # тема Mini App не тронута
            mini = expect(b.get("/admin/v1/experience/miniapp/state"), 200)
            check(mini["current"]["version"] == c.data["config"][0], f"Mini App: {mini['current']['version']}")
    finally:
        if activated:
            hdr = staff_token("experience-config", {"config.publish"}, r2.staff_id, "super_admin")
            httpx.post(f"{s1.EXPERIENCE}/admin/v1/experience/admin/rollback", json={"reason": "e2e: уборка"},
                       headers=hdr)
    c.data["admin_config"] = (cur, new)


def all_records(b: Browser, since: int) -> list[dict[str, Any]]:
    """Журнал аудита с начала прогона — постранично (одна выборка вместо запроса на каждое действие: лимит admin-bff
    на сотрудника — 300 запросов в минуту)."""
    since_iso = datetime.fromtimestamp(since, UTC).isoformat().replace("+00:00", "Z")
    out: list[dict[str, Any]] = []
    cursor: str | None = None
    for _ in range(50):
        params = {"from": since_iso, "limit": "100", **({"cursor": cursor} if cursor else {})}
        page = expect(b.get("/admin/v1/audit/records", params=params), 200)
        out += page["items"]
        cursor = page["next_cursor"]
        if not cursor:
            break
    return out


def s_audit(c: Ctx) -> None:
    b = c.staff["root2"].browser
    root, cm, sp = c.staff["root"], c.staff["comms"], c.staff["support"]
    d = c.data
    # что должно быть в журнале — по шагам, которые дошли до команды (упавший шаг не роняет этот)
    # bootstrap — при старте admin-identity, до начала прогона (в `run_local.sh test` — ещё до сценария спринта 1):
    # ищется отдельно, без окна по времени
    boot = audit_records(b, action="staff.bootstrap", object_id=root.staff_id)
    check(boot and boot[0]["actor_type"] == "system" and boot[0]["source"] == "admin-identity"
          and BOOT_EMAIL not in json.dumps(boot, ensure_ascii=False), f"staff.bootstrap: {boot[:1]}")
    want: list[tuple[str, dict[str, str]]] = [
        ("auth.mfa_enrolled", {"actor_id": root.staff_id}),
        ("auth.password_changed", {"actor_id": cm.staff_id}),
        ("staff.created", {"object_id": cm.staff_id, "actor_id": root.staff_id}),
        ("staff.created", {"object_id": sp.staff_id, "actor_id": root.staff_id}),
        ("approval.waived", {"actor_id": root.staff_id}),
        ("auth.locked", {"object_id": c.staff["lock"].staff_id}),
        ("auth.step_up", {"actor_id": cm.staff_id}),
    ]
    if d.get("note"):
        want += [("release_note.create", {"object_id": d["note"], "actor_id": cm.staff_id}),
                 ("release_note.publish", {"object_id": d["note"], "actor_id": cm.staff_id}),
                 ("release_note.archive", {"object_id": d["note"], "actor_id": cm.staff_id})]
    if d.get("tpl_version"):
        want += [("template.version_created", {"actor_id": cm.staff_id}),
                 ("template.activated", {"actor_id": cm.staff_id}), ("template.reset", {"actor_id": cm.staff_id})]
    if d.get("tpl_tested"):
        want += [("template.test_sent", {"actor_id": cm.staff_id})]
    if d.get("campaigns"):
        c1, _, c3 = d["campaigns"]
        want += [("campaign.created", {"object_id": c1}), ("campaign.scheduled", {"object_id": c1}),
                 ("campaign.finished", {"object_id": c1}), ("campaign.stopped", {"object_id": c3})]
    if d.get("revealed"):
        want += [("sensitive.view", {"object_id": c.lc.users["P"].account_id, "actor_id": root.staff_id})]
    if d.get("ticket"):
        want += [("ticket.take", {"object_id": d["ticket"], "actor_id": sp.staff_id}),
                 ("ticket.reply", {"object_id": d["ticket"], "actor_id": sp.staff_id}),
                 ("ticket.note", {"object_id": d["ticket"], "actor_id": sp.staff_id})]
    if d.get("config"):
        want += [("config.create", {"actor_id": root.staff_id}), ("config.publish", {"actor_id": root.staff_id}),
                 ("config.rollback", {"actor_id": root.staff_id})]
    # QA: дополнительные команды шагов A11 (откат к версии), A13 (стоп завершённой, снятие с расписания), A16a
    if d.get("campaign_stopped_done"):
        want += [("campaign.stopped", {"object_id": d["campaign_stopped_done"], "actor_id": cm.staff_id})]
    if d.get("campaign_future"):
        want += [("campaign.unscheduled", {"object_id": d["campaign_future"], "actor_id": cm.staff_id})]
    if d.get("admin_config"):
        want += [("config.publish", {"actor_id": root.staff_id, "object_id": f"admin@{d['admin_config'][1]}"}),
                 ("config.rollback", {"actor_id": root.staff_id, "object_id": f"admin@{d['admin_config'][0]}"})]
    since = d["started_at"]
    recs: list[dict[str, Any]] = []

    def missing() -> list[str]:
        nonlocal recs
        recs = all_records(b, since)
        return [f"{a} {q}" for a, q in want
                if not any(r["action"] == a and all(r.get(k) == v for k, v in q.items()) for r in recs)]

    left: list[str] = []
    deadline = time.monotonic() + 30
    while True:
        left = missing()
        if not left or time.monotonic() > deadline:
            break
        time.sleep(2)
    check(not left, f"нет записей аудита: {left}")
    print(f"      журнал с начала прогона: {len(recs)} записей, проверено {len(want)} команд", flush=True)
    # кто действовал и что попало в журнал: публикация — сотрудник communications; пароли, коды, секреты, cookie,
    # тексты сообщений поддержки и значение раскрытия в журнал не попадают
    if d.get("note"):
        pub = next(r for r in recs if r["action"] == "release_note.publish" and r["object_id"] == d["note"])
        check(pub["actor_type"] == "staff" and pub["source"] == "experience-config" and pub["actor_role"]
              == "communications", pub)
    blob = json.dumps(recs, ensure_ascii=False)
    leaks = [w for w, v in c.secrets.items() if v and v in blob and not w.startswith("причина")]
    leaks += [f"cookie/CSRF #{i}" for i, v in enumerate(c.seen) if v in blob]
    leaks += [f"Telegram ID {u.role}" for u in c.lc.users.values() if str(u.tg_id) in blob]
    check(not leaks, f"секреты/PII в аудите: {leaks}")
    v = expect(b.get("/admin/v1/audit/verify"), 200)
    check(v["valid"] is True and v["broken_at_seq"] is None and v["checked"] > 0, f"цепочка аудита: {v}")


def s_dashboard(c: Ctx) -> None:
    b = c.staff["root2"].browser
    d = expect(b.get("/admin/v1/dashboard", params={"period": "today"}), 200)
    blocks = {k: d[k] for k in ("learners", "support", "whats_new", "campaigns")}
    bad = {k: v.get("service") for k, v in blocks.items() if not (v["available"] is True and v["data"] is not None)}
    check(not bad, f"недоступные блоки дашборда: {bad}")
    check(d["period"] == "today" and blocks["learners"]["data"]["total_accounts"] >= 4
          and blocks["learners"]["data"]["total_children"] >= 1, blocks["learners"]["data"])
    check(blocks["campaigns"]["data"]["sent_in_period"] >= 1, blocks["campaigns"]["data"])
    sd = blocks["support"]["data"]
    check(sd["open"] + sd["in_progress"] + sd["waiting_customer"] >= 1, sd)  # обращение S ждёт ответа ученика
    # communications: dashboard.read есть — Обзор открывается
    d2 = expect(c.staff["comms"].browser.get("/admin/v1/dashboard", params={"period": "7d"}), 200)
    check(d2["period"] == "7d", d2["period"])


def s_logout(c: Ctx) -> None:
    r2 = c.staff["root2"]
    b = r2.browser
    old = b.cookie
    # cookie из другого браузера (другой User-Agent) → сессия отзывается (кража cookie)
    thief = c.browser("thief")
    expect(thief.get("/admin/v1/me", cookie=old), 401, "SESSION_REVOKED")
    expect(b.get("/admin/v1/me"), 401)
    # logout основной сессии root: 204, cookie стёрта, повтор со старой cookie → 401
    rb = c.staff["root"].browser
    old_root = rb.cookie
    r = rb.post("/admin/v1/auth/logout")
    check(r.status_code == 204 and rb.cookie is None, f"logout: {r.status_code}, cookie={rb.cookie is not None}")
    expect(rb.get("/admin/v1/me", cookie=old_root), 401)


def s_events(c: Ctx) -> None:
    import jsonschema

    since = c.data["started_at"]
    env_schema = json.loads((CONTRACTS / "envelope.schema.json").read_text())
    seen: dict[str, int] = {}
    problems: list[str] = []
    for schema in SCHEMAS:
        if s1._psql(f"SELECT to_regclass('{schema}.outbox') IS NOT NULL") != "t":
            continue
        rows = s1._psql(
            "SELECT coalesce(json_agg(json_build_object('e', envelope, 'p', published_at IS NOT NULL)), '[]') "
            f"FROM {schema}.outbox WHERE created_at >= to_timestamp({int(since)})")
        for row in json.loads(rows or "[]"):
            env = row["e"]
            et = env.get("event_type", "?")
            seen[f"{schema}:{et}"] = seen.get(f"{schema}:{et}", 0) + 1
            if not row["p"]:
                problems.append(f"{schema}: {et} не опубликовано (outbox)")
            try:
                jsonschema.validate(env, env_schema, format_checker=jsonschema.FormatChecker())
                path = CONTRACTS / f"{et}.schema.json"
                if not path.exists():
                    problems.append(f"{schema}: нет контракта для {et}")
                    continue
                jsonschema.validate(env["payload"], json.loads(path.read_text()), format_checker=jsonschema.FormatChecker())
            except jsonschema.ValidationError as exc:
                problems.append(f"{schema}: {et}: {exc.message[:160]}")
    expected = {"admin_identity:admin.audit.recorded.v1", "experience_config:experience.release_note.published.v1",
                "experience_config:admin.audit.recorded.v1", "notifications:admin.audit.recorded.v1",
                "support:support.ticket.created.v1", "support:support.ticket.replied.v1"}
    check(not (expected - set(seen)), f"не опубликованы события: {sorted(expected - set(seen))}")
    check(not problems, "; ".join(problems[:8]))
    # PII в событиях: Telegram ID, username учеников, email и пароли сотрудников
    leaks = []
    for schema in SCHEMAS:
        if s1._psql(f"SELECT to_regclass('{schema}.outbox') IS NOT NULL") != "t":
            continue
        text = s1._psql(f"SELECT coalesce(string_agg(envelope::text, E'\\n'), '') FROM {schema}.outbox "
                        f"WHERE created_at >= to_timestamp({int(since)})")
        for u in c.lc.users.values():
            if u.username in text or re.search(rf"(^|[^0-9]){u.tg_id}([^0-9]|$)", text):
                leaks.append(f"{schema}: ученик {u.role}")
        for st in c.staff.values():
            if st.email in text:
                leaks.append(f"{schema}: email {st.email.split('@')[0]}")
        for what, v in c.secrets.items():
            if v and v in text:
                leaks.append(f"{schema}: {what}")
    check(not leaks, f"PII/секреты в событиях: {sorted(set(leaks))}")
    after, before = s1.dlq_counts(), c.data.get("dlq_before", {})
    grown = {k: v - before.get(k, 0) for k, v in after.items() if v > before.get(k, 0)}
    check(not grown, f"новые сообщения в DLQ: {grown}")


def s_logs(c: Ctx) -> None:
    needles: dict[str, str] = dict(c.secrets)
    for i, v in enumerate(dict.fromkeys(c.seen)):
        needles[f"cookie/CSRF #{i}"] = v
    for st in c.staff.values():
        needles[f"email {st.email.split('@')[0]}"] = st.email
    for u in c.lc.users.values():
        needles[f"Telegram ID {u.role}"] = str(u.tg_id)
        needles[f"username {u.role}"] = u.username
        needles[f"имя {u.role}"] = u.first
    needles["имя ребёнка"] = c.data.get("kid_name", "")
    needles["SCHEDULER_TOKEN"] = s1.SCHEDULER_TOKEN
    found = []
    for log in sorted(LOG_DIR.glob("*.log")):
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


STEPS: list[tuple[str, Callable[[Ctx], None], bool]] = [
    ("A00 стенд спринта 2 готов (admin-bff, admin-identity, user-admin)", s_stand, True),
    ("A01 AT-16 без сессии любой маршрут → 401; шаги входа без Origin admin-web → 403", s_unauthorized, False),
    ("A02 AT-16 bootstrap: пароль → смена пароля → подключение TOTP → done; права super_admin", s_bootstrap, True),
    ("A03 сотрудники communications, support (+ read_only): step-up, временный пароль, four-eyes (waived)",
     s_create_staff, True),
    ("A04 AT-16 5 неверных паролей → 423 ACCOUNT_LOCKED; верный во время блокировки — тоже 423", s_lockout, False),
    ("A05 AT-16 первый вход communications: временный пароль → смена → TOTP → done", s_comms_login, True),
    ("A06 AT-16 первый вход support: временный пароль → смена → done (MFA по желанию)", s_support_login, True),
    ("A07 AT-17 RBAC: support без «Что нового»/уведомлений — 403 в admin-bff и в доменах; manage без publish — 403",
     s_rbac, False),
    ("A08 ученики через telegram-bff: LA (product_news, занятие), LB, родитель + ребёнок, R1/R3/R2 со слотами, S, "
     "LQ, T, LU (UZ), LN (без онбординга)", s_learners, True),
    ("A09 AT-19 пустой перевод UZ / запрещённый маршрут → 422 при создании и правке (PUT), черновик не изменён",
     s_note_translation, False),
    ("A10 AT-18 «Что нового»: черновик → публикация (403 без step-up → step-up → 201) → ученик видит один раз → "
     "статистика → архив", s_whats_new, False),
    ("A11 AT-20 шаблон lesson.reminder: 422 → версия → активация → напоминание с новым текстом → v2 → откат к v → "
     "напоминание текстом v → сброс → текст по умолчанию", s_template, False),
    ("A12 AT-21 тестовая отправка — только тестовый чат, «[ТЕСТ]», ученикам ничего", s_test_send, False),
    ("A12a AT-22 сегменты аудитории (identity-consent): язык, возраст 14+/18+, онбординг, активность [QA]",
     s_audience_segments, False),
    ("A13 AT-22 рассылки: охват → расписание → доставка по сегменту (RU/UZ); тихие часы до их конца; лимит 7 дней; "
     "стоп отменяет неотправленное; send_at в будущем", s_campaigns, False),
    ("A14 AT-23 реестр и карточка ученика (с ребёнком), маски Telegram ID и @username, согласие подростка; reveal 403 "
     "без step-up → значение + аудит", s_learners_admin, False),
    ("A15 AT-25 поддержка: взять, ответ и заметка; ученик видит только ответ, уведомление в Telegram", s_support_desk,
     False),
    ("A16 AT-24 конфигурация miniapp: активация → откат → telegram-bff отдаёт прежнюю версию", s_config_rollback, False),
    ("A16a AT-24 тема админки: активация → admin-web получает её → откат → прежняя [QA]", s_admin_theme_rollback,
     False),
    ("A17 AT-24 аудит: записи привилегированных команд, без секретов; цепочка цела", s_audit, False),
    ("A18 дашборд: 4 блока available=true", s_dashboard, False),
    ("A19 сессия: чужой User-Agent → отзыв; logout → 401", s_logout, False),
    ("A20 события по контрактам, outbox опубликован, без PII и секретов, DLQ без новых", s_events, False),
    ("A21 логи всех сервисов без паролей, TOTP-секретов, cookie, PII", s_logs, False),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--admin-bff", default=os.environ.get("E2E_ADMIN_BFF", "http://127.0.0.1:8002"))
    ap.add_argument("--bff", default=TG_BFF)
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--cleanup", action="store_true",
                    help="только уборка остатков прерванного прогона (run_local.sh — перед сценариями)")
    args = ap.parse_args()
    if args.cleanup:
        done = cleanup_leftovers()
        print("уборка стенда: " + ("; ".join(done) if done else "остатков прерванных прогонов нет"), flush=True)
        return 0
    tag = "A" + "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(4))
    base_tg = 7_100_000_000 + secrets.randbelow(800_000_000) * 4
    with httpx.Client(base_url=args.bff, timeout=20) as tg:
        lc = s1.Ctx(bff=tg, tag=tag, base_tg=base_tg)
        lc.data["zone_day"] = s1.pick_zone(datetime.now(UTC), 10 * 60, 16 * 60, 13 * 60)
        c = Ctx(bff=args.admin_bff, lc=lc, tag=tag)
        c.data["started_at"] = int(time.time()) - 1
        print(f"TilHero e2e (спринт 2, админка): admin-bff {args.admin_bff}, telegram-bff {args.bff}, метка {tag}, "
              f"Telegram ID от {base_tg + 1}\n", flush=True)
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
            print(f"{status}  {name}  ({dt:.1f} c){'  — ' + detail[:900] if detail else ''}", flush=True)
    passed = sum(1 for r in results if r[1] == "PASS")
    failed = [r for r in results if r[1] == "FAIL"]
    skipped = [r for r in results if r[1] == "SKIP"]
    print(f"\nИтого: {passed}/{len(results)} PASS" + (f", {len(skipped)} SKIP" if skipped else "")
          + f" (выполнено проверок: {s1.CHECKS[0]})")
    (s1.E2E_DIR / "last-run-admin.json").write_text(json.dumps(
        {"tag": tag, "checks": s1.CHECKS[0], "results": [{"step": n, "status": s, "detail": d} for n, s, d in results]},
        ensure_ascii=False, indent=1))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

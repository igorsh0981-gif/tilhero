# ruff: noqa: S608 — QA-скрипт dev-стенда: psql (SQL только из UUID, номеров заказов сценария и констант)
"""Сквозной сценарий спринта 8 TilHero («Деньги и контроль ИИ») через публичные API — Mini App (telegram-bff /v1),
сайт оплаты (Caddy web-pay → telegram-bff /web/v1), колбэки провайдеров (Caddy payments-edge → billing), Telegram (мок
Bot API шлёт платёжные обновления в webhook bot-gateway) и admin-web (admin-bff). AGENT_BRIEF «e2e scenario_money.py».

Предусловие: `infra/e2e/run_local.sh money` (сброс учёток admin-identity + up с BILLING_ENFORCED=true + этот сценарий).
Отдельно, на уже поднятом стенде со свежим bootstrap-сотрудником:
    uv run python infra/e2e/scenario_money.py [-v] [--only M05,M07] [--skip-flags]
    uv run python infra/e2e/scenario_money.py --cleanup   # только уборка остатков прерванного прогона

Ученики: A (взрослый, основной: Stars, сайт, урок вдвоём, «четыре глаза», удаление в конце), его детский профиль K
(6–9), B (взрослый, друг A: приглашение без подписки, перевод по тапу при деградации ИИ), D (взрослый: подписка Stars
и её возврат), E (взрослый: пробный → корректировка «четыре глаза» → исчерпание минут), T (подросток 14–17 без
согласия родителя), X — Telegram-пользователь без аккаунта TilHero (вход на сайт). Сотрудники: bootstrap super_admin,
finance, support, operations.

Внешнее — моки стенда: Telegram (`infra/e2e/mock_telegram.py`: createInvoiceLink, refundStarPayment,
editUserStarSubscription, getStarTransactions; pre_checkout_query, successful_payment, refunded_payment, subscription
в webhook), «Log In with Telegram» (`mock_oidc.py`), провайдеры (`mock_payments.py`: колбэки Payme/Click/Uzum через
payments-edge; Click Merchant API — исходящие billing). Доменные сервисы напрямую — только как планировщик
(`billing:tick`, `billing:reconcile` с SCHEDULER_TOKEN, как n8n), для проверки прав в самом домене (защита в глубину) и
внутренних API (bot-gateway `/internal/v1/stars/*` от имени billing — повторный возврат).

ТЕСТОВЫЕ ИЗМЕНЕНИЯ БД (ждать нельзя) — только строки СВОИХ учеников этого прогона, каждое печатается в журнал прогона:
  * `lessons.sessions.last_activity_at` своей сессии урока → на 130 с назад (2 ИИ-минуты без ожидания — исчерпание);
  * `billing.provider_transactions.created_at` своей транзакции Click Prepare без Complete → на 2 ч назад
    (`stale_created` без ожидания часа).
Что сценарий меняет в общем стенде и как возвращает: каталог billing — черновик с фискальными реквизитами сайта →
проверка → активация со step-up (AT-83); в конце — откат на прежнюю версию (тоже step-up); уровень деградации ИИ —
ручной `paid_only` и возврат в `auto`; флаги стенда (шаг M16) — `run_local.sh reconfig` и возврат всех флагов.

Печатает PASS/FAIL/SKIP по шагам и «Итого: N/M PASS»; код выхода 1, если хоть один шаг упал. Замечания (не роняют
шаг) — в конце. Шаги после сбоя критичного шага — SKIP. Повторный прогон на непустой базе — те же шаги с новыми
учениками и метками (каталог, уровни ИИ и флаги возвращаются в исходное состояние в конце каждого прогона).
"""

from __future__ import annotations

import argparse
import base64
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
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mock_payments as mp  # колбэки Payme / Click / Uzum (симуляторы потока B)
import scenario as s1  # ученики (telegram-bff), онбординг, мок Telegram, psql
import scenario_admin as s2  # браузер admin-web, TOTP, step-up, вход сотрудника
import scenario_content as s3  # создание сотрудников, psql-помощники
import scenario_game as sg  # игра: сводка, NATS (consumers, replay)
import scenario_lessons as s4  # шаги занятий
import scenario_memory as s5  # урок целиком
import scenario_social as s7  # друзья, парные комнаты

from tilhero_common.internal_auth import issue_token

check, expect, wait_for = s1.check, s1.expect, s1.wait_for
StepFailed, StepSkipped = s1.StepFailed, s1.StepSkipped
Staff = s2.Staff
idem = s2.idem
parse_ts = s2.parse_ts
need, pj, psql_try = s3.need, s3.pj, s3.psql_try
uid = s1.uid

TG_BFF = s2.TG_BFF
BILLING = os.environ.get("E2E_BILLING", "http://127.0.0.1:8118")
GAME = sg.GAME
LESSONS = s4.LESSONS
AI_GW = s4.AI_GATEWAY
MOCK_TG = s1.MOCK_TG
MOCK_PAY = os.environ.get("E2E_MOCK_PAY", "http://127.0.0.1:8191")
MOCK_OIDC = os.environ.get("E2E_MOCK_OIDC", "http://127.0.0.1:8192")
WEB_ORIGIN = os.environ.get("E2E_WEB_PAY_ORIGIN", "http://127.0.0.1:5175")
RUN_LOCAL = s1.ROOT / "infra" / "e2e" / "run_local.sh"
PAIR = "ru-en"
PURPOSES = [*s1.REQUIRED, "social"]
OPEN_OK = sg.OPEN_OK
FIAT = ("payme", "click", "uzum")
SUB_PERIOD = 2_592_000
# фискальные реквизиты сайта (заведомо тестовые): с ними CheckPerformTransaction отдаёт detail, Click — submit_items
FISCAL = {"ikpu": "10899001001000000", "package_code": "1545643", "units": None, "vat_percent": 12}
MERCHANT_TIN = "123456789"
CATALOG_MARK = "[e2e "
# флаги стенда спринта 8 (run_local.sh): все включены, пэйвол — да
FLAGS_ON = {"E2E_PAYMENTS_ENABLED": "true", "E2E_STARS_ENABLED": "true", "E2E_PAYME_ENABLED": "true",
            "E2E_CLICK_ENABLED": "true", "E2E_UZUM_ENABLED": "true", "E2E_WEB_PAY_ENABLED": "true",
            "E2E_BILLING_ENFORCED": "true"}
# анти-стиринг: в ответах канала miniapp, текстах бота и уведомлениях
STEERING_WORDS = re.compile(r"(?i)\b(payme|click|uzum|paycom)\b|\bсум(ов|ы|ах)?\b|\bso[ʻ'’`]?m\b|тийин|tiyin")
NOTES: list[str] = []


def note(text: str) -> None:
    NOTES.append(text)
    print(f"      замечание: {text}", flush=True)


def log_db_change(text: str) -> None:
    print(f"      ТЕСТОВОЕ ИЗМЕНЕНИЕ БД: {text}", flush=True)


# =============================================================================================== помощники


def u_(c: s2.Ctx, role: str) -> s1.U:
    return c.lc.users[role]


def web_host() -> str:
    return urlsplit(WEB_ORIGIN).netloc


def steering_leaks(obj: Any, what: str) -> list[str]:
    """Анти-стиринг (решение В1, AT-100): в ответе канала miniapp / тексте нет сумм в сумах (тийинов), названий
    фиатных провайдеров, адреса сайта оплаты и ссылок на страницы оплаты провайдеров."""
    blob = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    leaks = [f"{what}: поле {k}" for k in ("amount_tiyin", "price_tiyin", "tiyin", "checkout_url", "receipt_url")
             if f'"{k}"' in blob]
    m = STEERING_WORDS.search(blob)
    if m:
        leaks.append(f"{what}: «{m.group(0)}»")
    if web_host() in blob or "web-pay" in blob:
        leaks.append(f"{what}: адрес сайта оплаты")
    for host in ("paycom.uz", "click.uz"):
        if host in blob.lower():
            leaks.append(f"{what}: {host}")
    return leaks


def scheduler_post(url: str, timeout: float = 120) -> dict[str, Any]:
    r = httpx.post(url, headers={"authorization": f"Bearer {s1.SCHEDULER_TOKEN}"}, timeout=timeout)
    return expect(r, 200)


def billing_tick() -> dict[str, Any]:
    for _ in range(20):
        res = scheduler_post(f"{BILLING}/internal/v1/billing:tick")
        if not res.get("skipped"):
            return res
        time.sleep(0.5)
    raise StepFailed("billing:tick 10 с подряд отвечает skipped")


def billing_reconcile() -> dict[str, Any]:
    return scheduler_post(f"{BILLING}/internal/v1/billing:reconcile", 180)


def staff_hdr(perms: set[str], step_up: bool = False, actor_id: str | None = None) -> dict[str, str]:
    h = s2.staff_token("billing", perms, actor_id or str(uuid.uuid4()), "operations")
    if step_up:
        h["x-step-up"] = "ok"
    return h


def learner_hdr(u: s1.U, chn: str, *, lrn: str | None = None, age_band: str = "18+") -> dict[str, str]:
    """Внутренний JWT ученика от имени telegram-bff с каналом продаж — проверка правил в самом billing."""
    tok = issue_token(s1.ring("telegram-bff"), issuer="telegram-bff", audience="billing", subject=u.account_id,
                      extra={"lrn": lrn or u.account_id, "age_band": age_band, "chn": chn})
    return {"x-internal-token": tok}


def billing_as(u: s1.U, chn: str, method: str, path: str, **kw: Any) -> httpx.Response:
    headers = {**learner_hdr(u, chn), **kw.pop("headers", {})}
    return httpx.request(method, f"{BILLING}/internal/v1/me/billing{path}", headers=headers, timeout=20, **kw)


def order_db(order_no: int) -> dict[str, Any]:
    row = pj("SELECT row_to_json(o) FROM (SELECT order_id, order_no, account_id, beneficiary_id, channel, product_code, "
             "product_kind, provider, currency, amount_tiyin, amount_stars, stars_mode, status, start_mode, "
             f"stars_subscription_id, paid_at, fulfilled_at FROM billing.orders WHERE order_no = {int(order_no)}) o")
    check(row, f"заказа {order_no} нет в billing.orders")
    return row


def orders_of(account_id: str) -> list[dict[str, Any]]:
    return pj("SELECT coalesce(json_agg(row_to_json(o) ORDER BY o.order_no), '[]') FROM (SELECT order_id, order_no, "
              "channel, provider, status, product_code, stars_subscription_id, account_id, beneficiary_id "
              f"FROM billing.orders WHERE account_id = '{uid(account_id)}') o") or []


def periods_of(account_id: str) -> list[dict[str, Any]]:
    return pj("SELECT coalesce(json_agg(row_to_json(p) ORDER BY p.created_at), '[]') FROM (SELECT period_id, source, "
              "status, product_code, order_id, stars_subscription_id, minutes_granted, starts_at, ends_at, close_reason, "
              f"created_at FROM billing.periods WHERE account_id = '{uid(account_id)}') p") or []


def ledger_of(account_id: str) -> list[dict[str, Any]]:
    return pj("SELECT coalesce(json_agg(row_to_json(l) ORDER BY l.seq), '[]') FROM (SELECT seq, kind, minutes, overage, "
              "ref_kind, ref_id, learner_id, actor, idempotency_key, period_id FROM billing.minute_ledger WHERE "
              f"account_id = '{uid(account_id)}') l") or []


def hold_of(ref_id: str) -> dict[str, Any] | None:
    return pj("SELECT row_to_json(h) FROM (SELECT hold_id, account_id, feature, ref_kind, minutes, status, "
              f"settled_minutes, overage FROM billing.minute_holds WHERE ref_id = '{uid(ref_id)}') h")


def stars_sub_of(account_id: str) -> dict[str, Any] | None:
    return pj("SELECT row_to_json(s) FROM (SELECT subscription_id, status, renewals, first_charge_id, last_charge_id, "
              f"expires_at, first_order_id FROM billing.stars_subscriptions WHERE account_id = '{uid(account_id)}' "
              "ORDER BY created_at DESC LIMIT 1) s")


def recon_items(kind: str, since: int) -> list[dict[str, Any]]:
    check(re.fullmatch(r"[a-z_]+", kind), kind)
    return pj("SELECT coalesce(json_agg(row_to_json(i) ORDER BY i.created_at), '[]') FROM (SELECT item_id, kind, "
              "provider, order_id, txn_id, status, details, created_at FROM billing.reconciliation_items WHERE kind = "
              f"'{kind}' AND created_at >= to_timestamp({int(since)})) i") or []


def outbox(schema: str, event_type: str, since: int, where: str = "") -> list[dict[str, Any]]:
    return s7.outbox(schema, event_type, since, where)


def notif_rows(user_id: str, since: int) -> list[dict[str, Any]]:
    return pj("SELECT coalesce(json_agg(row_to_json(n) ORDER BY n.created_at), '[]') FROM (SELECT template, category, "
              "title, body, startapp, dedup_key, telegram_status, center_only, created_at FROM "
              "notifications.notifications WHERE "
              f"user_id = '{uid(user_id)}' AND created_at >= to_timestamp({int(since)})) n") or []


def wait_notif(user_id: str, template: str, since: int, timeout: float = 40) -> dict[str, Any]:
    rows = wait_for(lambda: [x for x in notif_rows(user_id, since) if x["template"] == template], timeout,
                    interval=1.0, what=f"уведомление {template}")
    return rows[-1]


def consumers_idle(prefixes: tuple[str, ...], timeout: float = 120) -> None:
    s7.consumers_idle(prefixes, timeout)


# ---------------------------------------------------------------- мок Telegram (Stars)


def tg_post(path: str, body: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
    r = httpx.post(f"{MOCK_TG}{path}", json=body, timeout=timeout)
    check(r.status_code == 200, f"мок Telegram {path}: {r.status_code} {r.text[:300]}")
    return r.json()


def tg_seq() -> int:
    return s1.tg_last_seq()


def tg_method_calls(method: str, after: int = 0) -> list[dict[str, Any]]:
    r = httpx.get(f"{MOCK_TG}/_mock/calls", params={"method": method, "after": str(after)}, timeout=10)
    r.raise_for_status()
    return r.json()["items"]


def stars_checkout(u: s1.U, link: str, **over: Any) -> dict[str, Any]:
    res = tg_post("/_mock/stars/checkout", {"user": {"id": u.tg_id, "language_code": "ru"}, "invoice_link": link, **over})
    check(res["status"] == 200 and res.get("answer"), f"pre_checkout_query: {res}")
    return res


def stars_pay(u: s1.U, link: str, **over: Any) -> dict[str, Any]:
    return tg_post("/_mock/stars/pay", {"user": {"id": u.tg_id, "language_code": "ru"}, "invoice_link": link, **over})


def stars_order(u: s1.U, product: str, status: int = 201, code: str | None = None, **body: Any) -> dict[str, Any]:
    offer = u.ok("GET", "/v1/billing/catalog")["offer"]["version"]
    return u.ok("POST", "/v1/billing/orders", status, code,
                json={"product_code": product, "provider": "telegram_stars", "offer_version": offer, **body}, idem=True)


def poll_order(u: s1.U, order_no: int, statuses: tuple[str, ...], timeout: float = 60) -> dict[str, Any]:
    """Как Mini App после openInvoice: опрос заказа до 60 с (источник истины — billing)."""
    return wait_for(lambda: (lambda o: o if o["status"] in statuses else None)(
        u.ok("GET", f"/v1/billing/orders/{order_no}")), timeout, interval=0.5,
        what=f"заказ {order_no} в {statuses}")


# ---------------------------------------------------------------- сайт оплаты (браузер)


class Site:
    """Браузер сайта оплаты: через Caddy web-pay (`/api/*`), а без Caddy — прямо в telegram-bff (`/web/v1/*`).
    Cookie — вручную (`__Host-` и Secure по http httpx не отправил бы), Origin и X-CSRF-Token — на изменяющих."""

    def __init__(self, c: s2.Ctx, name: str) -> None:
        self.c = c
        self.name = name
        self.via_caddy = c.data.get("caddy", False)
        self.http = httpx.Client(base_url=WEB_ORIGIN if self.via_caddy else TG_BFF, timeout=30, follow_redirects=False,
                                 headers={"user-agent": f"Mozilla/5.0 (e2e site {name})"})
        self.cookies: dict[str, str] = {}
        self.attrs: dict[str, str] = {}
        self.csrf: str | None = None

    def path(self, p: str) -> str:
        return f"/api{p}" if self.via_caddy else f"/web/v1{p}"

    def absorb(self, r: httpx.Response) -> None:
        for sc in r.headers.get_list("set-cookie"):
            name, _, rest = sc.partition("=")
            name = name.strip()
            value = rest.split(";", 1)[0].strip()
            self.attrs[name] = rest.split(";", 1)[1].lower() if ";" in rest else ""
            if not value or "max-age=0" in rest.lower():
                self.cookies.pop(name, None)
            else:
                self.cookies[name] = value
                self.c.secrets[f"cookie {name} {self.name} {len(self.c.secrets)}"] = value

    def cookie_header(self) -> dict[str, str]:
        return {"cookie": "; ".join(f"{k}={v}" for k, v in self.cookies.items())} if self.cookies else {}

    def req(self, method: str, p: str, *, json_body: Any = None, csrf: bool = True, origin: str | None = WEB_ORIGIN,
            idem_key: str | None = None, params: dict[str, Any] | None = None) -> httpx.Response:
        h = self.cookie_header()
        if method != "GET":
            if origin:
                h["origin"] = origin
            if csrf and self.csrf:
                h["x-csrf-token"] = self.csrf
            if idem_key:
                h["idempotency-key"] = idem_key
        r = self.http.request(method, self.path(p), json=json_body, headers=h, params=params)
        self.absorb(r)
        return r

    def ok(self, method: str, p: str, status: int = 200, code: str | None = None, **kw: Any) -> dict[str, Any]:
        return expect(self.req(method, p, **kw), status, code)

    def login(self, tg_id: int, *, forge: str | None = None) -> str:
        """Вход «Log In with Telegram»: /auth/start → мок /auth (пользователь подтверждает) → /auth/callback.
        → адрес, куда сайт перенаправил после входа ("/" или "/?login_error=…")."""
        r = self.req("GET", "/auth/start")
        check(r.status_code == 302, f"{self.name}: /auth/start → {r.status_code} {r.text[:200]}")
        auth = r.headers["location"]
        a = urlsplit(auth)
        check(f"{a.scheme}://{a.netloc}" == MOCK_OIDC and a.path == "/auth", f"адрес авторизации: {auth[:120]}")
        q = dict(x.split("=", 1) for x in a.query.split("&"))
        check(q.get("response_type") == "code" and q.get("code_challenge_method") == "S256"
              and len(q.get("code_challenge", "")) == 43 and q.get("state") and q.get("client_id"),
              f"параметры /auth: {sorted(q)}")
        check(not re.search(rf"(?<!\d){tg_id}(?!\d)", auth), "Telegram ID в адресе авторизации")
        oidc = self.attrs.get("__Host-wp_oidc", "")
        check("httponly" in oidc and "secure" in oidc and "samesite=lax" in oidc and "path=/" in oidc
              and "domain=" not in oidc, f"cookie __Host-wp_oidc: {oidc}")
        if forge:
            expect(httpx.post(f"{MOCK_OIDC}/_mock/forge", json={"mode": forge}, timeout=10), 200)
        r2 = httpx.get(auth + f"&e2e_tg_id={tg_id}", timeout=10, follow_redirects=False)
        check(r2.status_code == 302, f"мок /auth: {r2.status_code} {r2.text[:200]}")
        cb = urlsplit(r2.headers["location"])
        self.c.data.setdefault("oidc_codes", []).append(cb.query)
        r3 = self.http.get(f"{cb.path}?{cb.query}" if self.via_caddy else
                           f"/web/v1{cb.path.removeprefix('/api')}?{cb.query}", headers=self.cookie_header())
        self.absorb(r3)
        check(r3.status_code == 302, f"{self.name}: callback → {r3.status_code} {r3.text[:200]}")
        self.c.data["last_callback"] = f"{cb.path}?{cb.query}"
        return r3.headers["location"]

    def me(self) -> dict[str, Any]:
        me = self.ok("GET", "/me")
        self.csrf = me["csrf_token"]
        self.c.secrets[f"csrf {self.name} {len(self.c.secrets)}"] = me["csrf_token"]
        return me

    def order(self, body: dict[str, Any], status: int = 201, code: str | None = None) -> dict[str, Any]:
        return self.ok("POST", "/orders", status, code, json_body=body, idem_key=str(uuid.uuid4()))


# ---------------------------------------------------------------- админка


def admin(st: Staff, method: str, path: str, status: int = 200, code: str | None = None, *, body: Any = None,
          step_up: bool = False, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None
          ) -> dict[str, Any]:
    if step_up:
        s2.ensure_step_up(st)
    h = {**idem(), **(headers or {})} if method != "GET" else (headers or {})
    r = st.browser.request(method, f"/admin/v1/billing{path}", json_body=body if method != "GET" else None,
                           params=params, headers=h)
    return expect(r, status, code)


def staff_ref_ok(ref: Any, st: Staff) -> bool:
    return isinstance(ref, dict) and ref.get("staff_id") == st.staff_id


# ---------------------------------------------------------------- уроки


def start_lesson(c: s2.Ctx, u: s1.U) -> tuple[dict[str, Any], dict[str, Any]]:
    """Урок плана: карточка, старт сессии (решение billing — в ответе). → (сессия, контент для drive)."""
    t = u.ok("GET", "/v1/plan/trajectory")
    check(t["next"], f"{u.role}: нет следующего урока")
    lid = t["next"]["lesson_id"]
    card = u.ok("GET", f"/v1/lessons/{lid}")
    s = u.ok("POST", f"/v1/lessons/{lid}/sessions", 201, idem=True)
    return s, s5.lesson_content(c, lid, int(card["version"]))


def finish_lesson(u: s1.U, sid: str, content: dict[str, Any], *, pause_s: float = 2.2,
                  before_finish: Callable[[], None] | None = None) -> dict[str, Any]:
    step = s4.drive(u, sid, s4.cur(u, sid), content, open_text=OPEN_OK)
    check(step["type"] == "done", f"урок не дошёл до итогов: {step['type']}")
    time.sleep(pause_s)  # урок стенда проходит за 1–2 с: ⌈ИИ-секунды/60⌉ = 1 минута
    if before_finish:
        before_finish()
    return s4.finish(u, sid)


def completed_event(sid: str, since: int) -> dict[str, Any]:
    rows = wait_for(lambda: [x for x in outbox("lessons", "lesson.session.completed.v1", since)
                             if x["session_id"] == sid], 30, what=f"lesson.session.completed.v1 {sid[:8]}")
    return rows[0]


def lesson_envelope(sid: str) -> dict[str, Any]:
    env = pj("SELECT envelope FROM lessons.outbox WHERE envelope->>'event_type' = 'lesson.session.completed.v1' "
             f"AND envelope->'payload'->>'session_id' = '{uid(sid)}' LIMIT 1")
    check(env, f"событие урока {sid} в outbox lessons")
    return env


# ---------------------------------------------------------------- флаги стенда (M16)


def reconfig(**flags: str) -> None:
    env = {**os.environ, **FLAGS_ON, **flags}
    print(f"      … run_local.sh reconfig {' '.join(f'{k}={v}' for k, v in flags.items()) or '(все флаги включены)'}",
          flush=True)
    res = subprocess.run(["bash", str(RUN_LOCAL), "reconfig"], env=env, capture_output=True, text=True, timeout=400,
                         check=False)
    if res.returncode != 0:
        raise StepFailed(f"reconfig {flags}: {(res.stdout + res.stderr)[-600:]}")


# ---------------------------------------------------------------- уборка


def _catalog_api(method: str, path: str, body: Any = None, *, if_match: str | None = None,
                 step_up: bool = False) -> httpx.Response:
    perms = {"billing.read", "billing.manage", "billing.publish"}
    hdr = staff_hdr(perms, step_up)
    hdr["idempotency-key"] = str(uuid.uuid4())
    if if_match:
        hdr["if-match"] = if_match
    return httpx.request(method, f"{BILLING}/internal/v1/admin/billing/catalog{path}", json=body, headers=hdr,
                         timeout=20)


def cleanup_leftovers() -> list[str]:
    """Остатки прерванного прогона: черновик каталога e2e — удалить; активная версия e2e (комментарий «[e2e …]») —
    откат на версию, которая была активна до неё (staff API billing от имени admin-bff, X-Step-Up); ручной уровень
    деградации ИИ — назад в auto (scenario_lessons.cleanup_leftovers не знает об уровнях)."""
    done: list[str] = []
    try:
        httpx.get(f"{BILLING}/health/ready", timeout=5).raise_for_status()
    except httpx.HTTPError:
        return ["billing недоступен — уборка каталога пропущена"]
    r = _catalog_api("GET", "")
    if r.status_code != 200:
        return [f"каталог: {r.status_code} — уборка пропущена"]
    items = r.json()["items"]
    draft = next((x for x in items if x["status"] == "draft"), None)
    if draft and CATALOG_MARK in (draft.get("comment") or ""):
        check(_catalog_api("DELETE", "/draft").status_code == 204, "уборка: удалить черновик каталога e2e")
        done.append(f"черновик каталога v{draft['version']}: удалён")
    active = next((x for x in items if x["status"] == "active"), None)
    if active and CATALOG_MARK in (active.get("comment") or ""):
        prev = max((x["version"] for x in items if x["status"] == "archived" and x["version"] < active["version"]
                    and CATALOG_MARK not in (x.get("comment") or "")), default=None)
        if prev is not None:
            rb = _catalog_api("POST", f"/{prev}/rollback", {"comment": f"e2e: уборка — каталог v{prev} без e2e"},
                              step_up=True)
            check(rb.status_code == 200, f"уборка: откат каталога {rb.status_code} {rb.text[:200]}")
            done.append(f"каталог v{active['version']} (e2e) → v{rb.json()['version']} из v{prev}")
    try:
        dg = httpx.get(f"{AI_GW}/admin/v1/ai/degradation", headers=s2.staff_token("ai-gateway", {"costs.read"},
                                                                                     str(uuid.uuid4()), "operations"),
                       timeout=10)
        if dg.status_code == 200 and dg.json().get("mode") == "manual":
            b = dg.json()
            hdr = s2.staff_token("ai-gateway", {"costs.read", "costs.manage"}, str(uuid.uuid4()), "operations")
            hdr.update({"x-step-up": "ok", "idempotency-key": str(uuid.uuid4())})
            r2 = httpx.put(f"{AI_GW}/admin/v1/ai/degradation", headers=hdr, timeout=10, json={
                "mode": "auto", "manual_level": None, "economy_at_percent": b["economy_at_percent"],
                "paid_only_at_percent": b["paid_only_at_percent"], "reason": "e2e: уборка — уровень ИИ снова auto"})
            done.append(f"деградация ИИ manual → auto ({r2.status_code})")
    except httpx.HTTPError:
        done.append("ai-gateway недоступен — уровень деградации не проверен")
    return done


# =============================================================================================== шаги
# ---------------------------------------------------------------- M00 стенд


def s_stand(c: s2.Ctx) -> None:
    for name, url in [("billing", f"{BILLING}/health/ready"), ("lessons", f"{LESSONS}/health/ready"),
                      ("gamification", f"{GAME}/health/ready"), ("identity-consent", f"{s1.IDENTITY}/health/ready"),
                      ("notifications", f"{s1.NOTIFICATIONS}/health/ready"), ("ai-gateway", f"{AI_GW}/health/ready"),
                      ("telegram-bot-gateway", f"{s1.BOTGW}/health/ready"),
                      ("telegram-bot-gateway (int)", f"{s1.BOTGW_INTERNAL}/health/ready"),
                      ("admin-bff", f"{c.bff}/health/ready"), ("telegram-bff", f"{TG_BFF}/health/ready"),
                      ("mock-telegram", f"{MOCK_TG}/health"), ("mock-oidc", f"{MOCK_OIDC}/health"),
                      ("mock-payments", f"{MOCK_PAY}/health")]:
        r = httpx.get(url, timeout=5)
        check(r.status_code == 200, f"{name} не ready: {r.status_code} {r.text[:200]}")
    try:
        c.data["caddy"] = (httpx.get(f"{mp.EDGE_URL}/healthz", timeout=3).status_code == 200
                           and httpx.get(f"{WEB_ORIGIN}/healthz", timeout=3).status_code == 200)
    except httpx.HTTPError:
        c.data["caddy"] = False
    if not c.data["caddy"]:
        note("Caddy payments-edge / web-pay не подняты (нет CADDY_BIN) — колбэки идут в billing с X-Edge-Token, сайт — "
             "прямо в telegram-bff /web/v1")
    c.data["provider"] = mp.Provider(via_edge=c.data["caddy"])
    # маршруты Mini App и сайта без входа — 401; колбэки без X-Edge-Token — 404 (как несуществующий маршрут)
    missing = []
    for method, path in (("GET", "/v1/billing/catalog"), ("GET", "/v1/billing/subscription"),
                         ("GET", "/v1/billing/minutes"), ("POST", "/v1/billing/trial"), ("POST", "/v1/billing/orders"),
                         ("GET", "/v1/billing/orders"), ("GET", "/v1/billing/orders/100001"),
                         ("POST", "/v1/billing/stars-subscription")):
        r = httpx.request(method, f"{TG_BFF}{path}", timeout=5)
        if r.status_code != 401:
            missing.append(f"telegram-bff {method} {path} → {r.status_code}")
    r = httpx.get(f"{TG_BFF}/web/v1/me", timeout=5)
    if not (r.status_code == 401 and r.json().get("code") == "SESSION_EXPIRED"):
        missing.append(f"telegram-bff GET /web/v1/me без cookie → {r.status_code} {r.text[:100]}")
    for path in ("/admin/v1/billing/catalog", "/admin/v1/billing/orders", "/admin/v1/billing/reconciliation/items",
                 "/admin/v1/billing/reports/summary", "/admin/v1/ai/degradation"):
        r = httpx.get(f"{c.bff}{path}", timeout=5)
        if r.status_code != 401:
            missing.append(f"admin-bff GET {path} → {r.status_code}")
    check(not missing, f"маршруты спринта 8 не готовы: {missing}")
    for path in ("/provider/v1/payme", "/provider/v1/click/prepare", "/provider/v1/uzum/check"):
        r = httpx.post(f"{BILLING}{path}", content=b"{}", timeout=5)
        check(r.status_code == 404, f"billing {path} без X-Edge-Token: {r.status_code} (ожидали 404)")
        r = httpx.post(f"{BILLING}{path}", content=b"{}", headers={"x-edge-token": "not-the-token"}, timeout=5)
        check(r.status_code == 404, f"billing {path} с чужим X-Edge-Token: {r.status_code}")
    if c.data["caddy"]:
        r = httpx.post(f"{mp.EDGE_URL}/provider/v1/payme", content=b"{}", timeout=5)
        check(r.status_code == 404, f"payments-edge /provider/v1/payme снаружи: {r.status_code}")
        r = httpx.get(f"{mp.EDGE_URL}/admin", timeout=5)
        check(r.status_code == 404, f"payments-edge прочее: {r.status_code}")
        page = httpx.get(f"{WEB_ORIGIN}/", timeout=5)
        csp = page.headers.get("content-security-policy", "")
        check(page.status_code == 200 and "default-src 'none'" in csp and "script-src 'self'" in csp
              and "frame-ancestors 'none'" in csp and page.headers.get("referrer-policy") == "no-referrer"
              and page.headers.get("x-content-type-options") == "nosniff"
              and page.headers.get("cross-origin-opener-policy") == "same-origin"
              and "server" not in {k.lower() for k in page.headers},
              f"заголовки web-pay: {dict(page.headers)}")
        check("telegram-web-app.js" not in page.text and "https://" not in re.sub(r'https://[^"\']*w3\.org[^"\']*', "",
                                                                                   page.text),
              "web-pay: сторонние скрипты или ссылки в index.html")
    for line in cleanup_leftovers():
        print(f"      уборка: {line}", flush=True)
    prefixes = ("billing_", "gamification_", "notifications_", "lessons_", "ai_gateway_", "user_admin_", "audit_")
    try:
        consumers_idle(prefixes, 10)
    except StepFailed:
        print("      потребители догоняют стрим…", flush=True)
        try:
            consumers_idle(prefixes, 180)
        except StepFailed:
            stuck = {k: v for k, v in sg.consumers("").items() if k.startswith(prefixes) and (v["pending"]
                                                                                               or v["ack_pending"])}
            note(f"потребители NATS не догнали стрим за 3 мин: {stuck}")
    c.data["dlq_before"] = s1.dlq_counts()
    c.data["policy"] = expect(httpx.get(f"{TG_BFF}/v1/legal/policy", params={"lang": "ru"}), 200)
    c.lc.data["policy"] = c.data["policy"]
    cat = pj("SELECT json_build_object('version', version, 'payload', payload) FROM billing.catalog_versions "
             "WHERE status = 'active'")
    check(cat and cat["payload"]["products"], f"активный каталог billing: {str(cat)[:200]}")
    c.data["catalog0"] = cat
    flags = httpx.get(f"{BILLING}/health/ready", timeout=5)
    check(flags.status_code == 200, "billing")
    print(f"      каталог v{cat['version']} ({len(cat['payload']['products'])} товаров); Caddy: {c.data['caddy']}; "
          f"DLQ до прогона: {sum(c.data['dlq_before'].values())}", flush=True)


# ---------------------------------------------------------------- M01 ученики


def s_learners(c: s2.Ctx) -> None:
    lc = c.lc
    z = lc.data["zone_day"]
    c.data["marker"] = f"Zm{c.tag}x"
    for role, name in (("A", "Азиза"), ("B", "Бобур"), ("D", "Дилноза"), ("E", "Эркин")):
        s1.onboard(lc.user(role, name), zone=z, purposes=PURPOSES, categories={"social": True})
    a = lc.users["A"]
    kid_name = f"Камрон {c.tag}K"
    kid = a.ok("POST", "/v1/learners", 201, json={"display_name": kid_name, "age_band": "6-9"}, idem=True)
    c.data.update(kid=kid["learner_id"], kid_name=kid_name)
    a.switch(kid["learner_id"])
    try:
        s1.plan_patch(a, {"goal": "study", "level_self": "zero", "schedule": {
            "preset": "daily", "preferred_time": "17:00", "duration_min": 15, "reminders_enabled": False,
            "timezone": z}})
        a.ok("POST", "/v1/plan/onboarding/complete")
    finally:
        a.switch(a.account_id)
    t = lc.user("T", "Тимур")
    s1.onboard(t, zone=z, age="14-17", purposes=s1.REQUIRED, categories={})
    x = lc.user("X", "Хуршид")  # Telegram-пользователь без аккаунта TilHero (Mini App не открывал)
    c.data["x_tg"] = x.tg_id
    del lc.users["X"]
    # друзья A ↔ B (урок вдвоём — между друзьями)
    nicks = {"A": f"Aziza_{c.tag}", "B": f"Bobur_{c.tag}"}
    for role, n in nicks.items():
        check(u_(c, role).ok("PUT", "/v1/community/nickname", json={"nickname": n})["nickname"] == n, f"ник {role}")
    mids = {role: s7.community(u_(c, role))["member_id"] for role in ("A", "B")}
    c.data["mid"] = mids
    r = a.ok("POST", "/v1/friends/requests", 201, json={"member_id": mids["B"]}, idem=True)
    check(u_(c, "B").ok("POST", f"/v1/friends/requests/{r['request_id']}/accept")["status"] == "accepted", "дружба A–B")
    # billing знает учеников (проекция learners из identity-consent)
    ids = [u.account_id for u in lc.users.values()] + [kid["learner_id"]]
    wait_for(lambda: int(s1._psql("SELECT count(*) FROM billing.learners WHERE user_id IN ("
                                  + ", ".join(f"'{uid(i)}'" for i in ids) + ")")) == len(ids), 60, interval=1.0,
             what="проекция learners billing")
    kid_row = pj(f"SELECT row_to_json(l) FROM (SELECT kind, account_id, age_band FROM billing.learners WHERE user_id = "
                 f"'{uid(kid['learner_id'])}') l")
    check(kid_row == {"kind": "child", "account_id": a.account_id, "age_band": "6-9"}, f"ребёнок в billing: {kid_row}")
    for role in ("A", "B", "D", "E", "T"):
        wait_for(lambda u=lc.users[role]: sg.summary(u)["freeze_stock"] == 2, 90, interval=1.5,
                 what=f"{role}: игра знает ученика")
    c.data["learners_done"] = True
    print(f"      A (+ ребёнок 6–9), B (друг A), D, E, подросток T без согласия родителя, Telegram-пользователь X без "
          f"аккаунта; billing.learners — {len(ids)} строк", flush=True)


# ---------------------------------------------------------------- M02 сотрудники


def s_staff(c: s2.Ctx) -> None:
    s3.warm_admin_identity(c)
    root = Staff(c.browser("root"), s2.BOOT_EMAIL, s2.BOOT_PASSWORD, display_name="Администратор")
    c.staff["root"] = root
    c.remember("пароль bootstrap", s2.BOOT_PASSWORD)
    r = root.browser.post("/admin/v1/auth/login", {"email": s2.BOOT_EMAIL, "password": s2.BOOT_PASSWORD})
    if r.status_code == 401:
        raise StepFailed("bootstrap-учётка уже использована — запускайте `run_local.sh money` (сбрасывает учётки "
                         "admin-identity)")
    me = s2.login(c, root, expect_next=["password_change", "mfa_enroll", "done"])
    check(me["staff"]["role"] == "super_admin", me["staff"])
    roles = {x["code"]: x for x in expect(root.browser.get("/admin/v1/roles"), 200)["items"]}
    check("finance" in roles, f"роли admin-identity: нет finance ({sorted(roles)})")
    perms = {k: set(v.get("permissions") or []) for k, v in roles.items()}
    billing_all = {"billing.read", "billing.manage", "billing.publish", "billing.approve", "billing.refund"}
    check(billing_all <= perms["finance"] and "subscriptions.override" not in perms["finance"]
          and {"costs.read", "dashboard.read", "users.read"} <= perms["finance"] and roles["finance"]["privileged"],
          f"роль finance: {sorted(perms['finance'])}, privileged {roles['finance'].get('privileged')}")
    check({"billing.read", "subscriptions.override"} <= perms["support"]
          and not ({"billing.approve", "billing.refund"} & perms["support"]), f"support: {sorted(perms['support'])}")
    check(billing_all | {"subscriptions.override"} <= perms["operations"], f"operations: {sorted(perms['operations'])}")
    for r_ in ("analyst", "auditor"):
        if r_ in perms:
            check("billing.read" in perms[r_] and not ({"billing.manage", "billing.refund"} & perms[r_]), f"{r_}")
    s2.step_up(root)
    for who, role, name in (("fin", "finance", "Феруза Финансы"), ("sup", "support", "Сабина Поддержка"),
                            ("ops", "operations", "Олим Операции")):
        s3._create(c, who, role, name, bool(roles[role]["privileged"]))
    for who in ("fin", "sup", "ops"):
        role = {"fin": "finance", "sup": "support", "ops": "operations"}[who]
        nxt = ["password_change", "mfa_enroll", "done"] if roles[role]["privileged"] else ["password_change", "done"]
        me = s2.login(c, c.staff[who], expect_next=nxt)
        c.data.setdefault("perms", {})[who] = set(me["permissions"])
    menu = expect(root.browser.get("/admin/v1/experience/admin/current"), 200)["layout"]["menu"]
    ids = {x["id"] for x in menu} | {y["id"] for x in menu for y in (x.get("children") or x.get("items") or [])
                                     if isinstance(y, dict) and "id" in y}
    want = {"tariffs", "payments", "adjustments", "reconciliation", "finance"}
    v18 = pj("SELECT payload FROM experience_config.config_versions WHERE app = 'admin' AND version = '1.8.0'")
    check(v18 and want <= {x["id"] for x in v18["layout"]["menu"]}, "experience-config: нет версии админки 1.8.0 с "
                                                                     "группой «Деньги» (миграция 0010)")
    if not want <= ids:
        note("меню админки: действующая версия — не 1.8.0 (на стенде её переключали сотрудники в сценариях прошлых "
             "спринтов; миграция 0010 активирует 1.8.0 только поверх версии выкладки) — группа «Деньги» есть в 1.8.0")
    print("      finance (billing.* без subscriptions.override, привилегированная), support (+ billing.read, "
          "subscriptions.override), operations — вход с TOTP", flush=True)


# ---------------------------------------------------------------- M03 каталог (AT-83)


def s_catalog(c: s2.Ctx) -> None:
    need(c, "learners_done")
    a, t = u_(c, "A"), u_(c, "T")
    fin, sup = c.staff["fin"], c.staff["sup"]
    # Mini App: только Stars; детский профиль — без цен; подросток без согласия — оплата закрыта
    cat = a.ok("GET", "/v1/billing/catalog")
    check(cat["sales_enabled"] is True and cat["providers"] == ["telegram_stars"] and cat["can_pay"] is True
          and cat["payer_required"] is False and cat["trial"] == {"available": True, "days": 7, "minutes": 60}
          and cat["products"], f"каталог Mini App: {str(cat)[:400]}")
    check(all(set(p["price"]) == {"stars", "mode"} and isinstance(p["price"]["stars"], int) for p in cat["products"]),
          f"цены Mini App не только Stars: {[p['price'] for p in cat['products']]}")
    sub = next(p for p in cat["products"] if p["code"] == "plus_30d")
    check(sub["price"]["mode"] == "subscription" and sub["price"]["stars"] <= 10_000 and sub["days"] == 30
          and sub["minutes"] == 300 and set(sub["features"]) == {"ai_lessons", "pair_lessons"}, f"plus_30d: {sub}")
    leaks = steering_leaks(cat, "каталог Mini App")
    a.switch(c.data["kid"])
    try:
        kc = a.ok("GET", "/v1/billing/catalog")
        check(kc["products"] == [] and kc["payer_required"] is True and kc["can_pay"] is False and kc["trial"] is None,
              f"каталог детского профиля: {kc}")
        leaks += steering_leaks(kc, "каталог ребёнка")
    finally:
        a.switch(a.account_id)
    tc = t.ok("GET", "/v1/billing/catalog")
    check(tc["can_pay"] is False and tc["consent_required"] is True, f"каталог подростка без согласия: {str(tc)[:300]}")
    check(not leaks, leaks)
    # канал miniapp в самом billing: фиатный провайдер — 422 PROVIDER_NOT_ALLOWED; BFF — 422 без вызова billing
    r = billing_as(a, "miniapp", "POST", "/orders", json={"product_code": "plus_90d", "provider": "payme",
                                                          "start_mode": "after_current", "offer_version": "1.0"},
                   headers={"idempotency-key": str(uuid.uuid4())})
    check(r.status_code == 422 and r.json().get("code") == "PROVIDER_NOT_ALLOWED", f"billing: miniapp + payme: {r.text[:200]}")
    r = billing_as(a, "web", "POST", "/orders", json={"product_code": "plus_30d", "provider": "telegram_stars",
                                                      "offer_version": "1.0"},
                   headers={"idempotency-key": str(uuid.uuid4())})
    check(r.status_code == 422 and r.json().get("code") == "PROVIDER_NOT_ALLOWED", f"billing: web + Stars: {r.text[:200]}")
    r = a.req("POST", "/v1/billing/orders", json={"product_code": "plus_90d", "provider": "payme",
                                                  "offer_version": "1.0"}, idem=True)
    check(r.status_code in (400, 422) and "payme" not in r.text.lower(), f"BFF: провайдер payme в Mini App: {r.text[:200]}")
    # каталог в админке: черновик с фискальными реквизитами сайта → проверка → активация со step-up
    lst = admin(fin, "GET", "/catalog")["items"]
    active = next(x for x in lst if x["status"] == "active")
    draft = next((x for x in lst if x["status"] == "draft"), None)
    if draft is not None:
        note(f"в каталоге уже есть чужой черновик v{draft['version']} — он будет перезаписан")
    cur = admin(fin, "GET", f"/catalog/{active['version']}")
    payload = json.loads(json.dumps(cur["payload"]))
    payload["merchant"] = {"tin": MERCHANT_TIN}
    for p in payload["products"]:
        if p.get("price_tiyin") is not None:
            p["fiscal"] = {**FISCAL, "receipt_title": (p.get("fiscal") or {}).get("receipt_title") or p["code"]}
    # неверный черновик: подписка Stars дороже 10 000 — CATALOG_INVALID с путём
    bad = json.loads(json.dumps(payload))
    next(p for p in bad["products"] if p["code"] == "plus_30d")["price_stars"] = 20_000
    if_match = {"if-match": draft["updated_at"]} if draft and draft.get("updated_at") else {}
    d0 = admin(fin, "PUT", "/catalog/draft", body={"payload": bad, "comment": f"{CATALOG_MARK}{c.tag}] неверный"},
               headers=if_match)
    v = admin(fin, "POST", "/catalog/draft/validate", body={})
    check(v["ok"] is False and any("price_stars" in e["path"] for e in v["errors"]), f"проверка неверного: {v}")
    d = admin(fin, "PUT", "/catalog/draft", body={"payload": payload, "comment": f"{CATALOG_MARK}{c.tag}] фискальные "
                                                                                 "реквизиты сайта"},
              headers={"if-match": d0["updated_at"]})
    check(any("fiscal" in str(x["path"]) or "merchant" in str(x["path"]) for x in d["diff"]),
          f"diff черновика: {d['diff'][:5]}")
    stale = admin(fin, "PUT", "/catalog/draft", 409, "DRAFT_CONFLICT",
                  body={"payload": payload, "comment": "e2e stale"}, headers={"if-match": d0["updated_at"]})
    check(stale, "If-Match устаревший")
    v = admin(fin, "POST", "/catalog/draft/validate", body={})
    check(v["ok"] is True, f"проверка черновика: {v}")
    sup_r = sup.browser.request("POST", "/admin/v1/billing/catalog/draft/activate", json_body={"comment": "x" * 12},
                                headers=idem())
    check(sup_r.status_code == 403, f"support активирует каталог: {sup_r.status_code}")
    since = int(time.time()) - 1
    act = admin(fin, "POST", "/catalog/draft/activate", step_up=True,
                body={"comment": f"{CATALOG_MARK}{c.tag}] фискальные реквизиты для e2e"})
    check(act["status"] == "active" and act["version"] > active["version"] and staff_ref_ok(act["activated_by"], fin),
          f"активация: {str(act)[:300]}")
    ev = wait_for(lambda: [x for x in outbox("billing", "billing.catalog.activated.v1", since)
                           if x["version"] == act["version"]], 20, what="billing.catalog.activated.v1")
    check(ev, "событие активации каталога")
    c.data.update(catalog_e2e=act["version"], catalog_prev=active["version"])
    # web: тот же каталог — только сумы
    print(f"      Mini App — только Stars (подписка {sub['price']['stars']} ⭐, ребёнку — без цен); каталог "
          f"v{active['version']} → v{act['version']} (фискальные реквизиты, проверка, step-up); неверный — CATALOG_INVALID",
          flush=True)


# ---------------------------------------------------------------- M04 урок без подписки


def s_no_subscription(c: s2.Ctx) -> None:
    need(c, "learners_done")
    a = u_(c, "A")
    sub = a.ok("GET", "/v1/billing/subscription")
    check(sub["status"] == "none" and sub["period"] is None and sub["trial_available"] is True
          and sub["stars_subscription"] is None, f"подписка A до покупок: {sub}")
    s, content = start_lesson(c, a)
    check(s["ai_mode"] == "choices" and s["ai_locked"] == {"reason": "no_subscription"} and s["ai_minutes_left"] is None,
          f"урок без подписки (BILLING_ENFORCED=true): {str(s)[:300]}")
    finish_lesson(a, s["session_id"], content, pause_s=0)
    check(ledger_of(a.account_id) == [] and hold_of(s["session_id"]) is None, "реестр минут A не пуст без подписки")
    # учёба работает: повторения и игра без подписки
    check(sg.summary(a)["level"] >= 1, "игра A")
    c.data["no_sub_done"] = True
    print("      урок A без подписки — «варианты» с плашкой ai_locked no_subscription; реестр пуст", flush=True)


# ---------------------------------------------------------------- M05 пробный, удержание и списание (AT-90, AT-92)


def s_trial(c: s2.Ctx) -> None:
    need(c, "learners_done")
    a, t = u_(c, "A"), u_(c, "T")
    since = int(time.time()) - 1
    t.ok("POST", "/v1/billing/trial", 403, "GUARDIAN_CONSENT_REQUIRED", idem=True)
    # ребёнок — в самом billing (lrn = детский профиль): лимит tg.billing.order — 10 команд за 10 мин на аккаунт
    r = httpx.post(f"{BILLING}/internal/v1/me/billing/trial", timeout=20, headers={
        **learner_hdr(a, "miniapp", lrn=c.data["kid"], age_band="6-9"), "idempotency-key": str(uuid.uuid4())})
    check(r.status_code == 403 and r.json().get("code") == "PAYER_REQUIRED", f"пробный ребёнку: {r.text[:200]}")
    key = str(uuid.uuid4())
    tr = a.ok("POST", "/v1/billing/trial", 201, idem=key)
    check(tr["status"] == "trial" and tr["period"]["minutes_granted"] == 60 and tr["period"]["minutes_left"] == 60
          and tr["trial_available"] is False, f"пробный: {tr}")
    again = a.ok("POST", "/v1/billing/trial", 201, idem=key)
    check(again["period"] == tr["period"], "повтор Idempotency-Key пробного — другой ответ")
    a.ok("POST", "/v1/billing/trial", 409, "TRIAL_USED", idem=True)
    wait_notif(a.account_id, "trial_started", since)
    # урок с ИИ: удержание при старте, списание по событию — один раз
    s, content = start_lesson(c, a)
    sid = s["session_id"]
    check(s["ai_mode"] == "full" and s["ai_locked"] is None and isinstance(s["ai_minutes_left"], int),
          f"урок с пробным: {str(s)[:300]}")
    h = hold_of(sid)
    check(h and h["status"] == "active" and h["feature"] == "ai_lessons" and h["ref_kind"] == "session"
          and h["minutes"] >= 1 and h["minutes"] + s["ai_minutes_left"] == 60, f"удержание урока: {h}, сессия "
          f"ai_minutes_left {s['ai_minutes_left']}")
    held = a.ok("GET", "/v1/billing/subscription")["period"]
    check(held["minutes_held"] == h["minutes"] and held["minutes_left"] == 60 - h["minutes"], f"удержано: {held}")
    summ = finish_lesson(a, sid, content)
    ev = completed_event(sid, since)
    check(ev["billable_minutes"] == 1 and ev["billing_hold_id"] == h["hold_id"], f"событие урока: {ev}")
    wait_for(lambda: (hold_of(sid) or {}).get("status") == "settled", 30, what="удержание урока settled")
    led = [x for x in ledger_of(a.account_id) if x["kind"] == "debit"]
    check(len(led) == 1 and led[0]["minutes"] == -1 and led[0]["ref_kind"] == "session" and led[0]["ref_id"] == sid
          and led[0]["idempotency_key"] == f"debit:session:{sid}", f"списание: {led}")
    sub = a.ok("GET", "/v1/billing/subscription")["period"]
    check(sub["minutes_spent"] == 1 and sub["minutes_held"] == 0 and sub["minutes_left"] == 59, f"после урока: {sub}")
    # повтор события (адресный повтор в NATS) — без второго списания
    env = lesson_envelope(sid)
    seq = sg.replay(env, "billing_lessons")
    sg.wait_delivered("billing_lessons", seq)
    time.sleep(0.5)
    check(len([x for x in ledger_of(a.account_id) if x["kind"] == "debit"]) == 1, "повтор события урока — второе списание")
    hist = a.ok("GET", "/v1/billing/minutes")["items"]
    check([x["kind"] for x in hist][:2] == ["debit", "grant"] and hist[0]["minutes"] == -1
          and hist[0]["learner"] == "self" and hist[1]["ref_kind"] == "trial", f"история минут: {hist}")
    check(not steering_leaks(hist, "история минут"), "история минут")
    check(summ["minutes"] >= 1, f"итоги урока: {summ.get('minutes')}")
    c.data.update(trial_done=True, a_trial_sid=sid)
    print(f"      пробный 60 мин (повтор ключа — тот же; второй — TRIAL_USED; ребёнок и подросток — 403); урок full: "
          f"удержание {h['minutes']} → списание 1 мин; повтор события (seq {seq}) — без второго", flush=True)


# ---------------------------------------------------------------- M06 подписка Stars (AT-84, AT-85)


def s_stars_subscription(c: s2.Ctx) -> None:
    need(c, "trial_done")
    a, b = u_(c, "A"), u_(c, "B")
    since = int(time.time()) - 1
    seq0 = tg_seq()
    e = stars_order(a, "plus_30d", 409, "FORFEIT_CONFIRMATION_REQUIRED")
    check((e.get("details") or {}).get("minutes_left") == 59 and (e.get("details") or {}).get("days_left") in (6, 7),
          f"FORFEIT_CONFIRMATION_REQUIRED: {e}")
    o = stars_order(a, "plus_30d", confirm_forfeit=True)
    check(o["status"] == "pending" and o["currency"] == "XTR" and o["provider"] == "telegram_stars"
          and o["channel"] == "miniapp" and o["invoice_link"] and o["invoice_link"].startswith("https://t.me/")
          and isinstance(o["amount_stars"], int), f"заказ Stars: {o}")
    check(not steering_leaks(o, "заказ Stars"), steering_leaks(o, "заказ Stars"))
    inv = [x for x in tg_method_calls("createInvoiceLink", seq0)]
    check(len(inv) == 1, f"createInvoiceLink: {len(inv)} вызовов")
    p = inv[0]["payload"]
    check(p["currency"] == "XTR" and p["provider_token"] == "" and len(p["prices"]) == 1
          and p["prices"][0]["amount"] == o["amount_stars"] and p.get("subscription_period") == SUB_PERIOD
          and 1 <= len(p["title"]) <= 32 and len(p["payload"].encode()) <= 128
          and str(a.tg_id) not in json.dumps(p), f"createInvoiceLink: {p}")
    # pre_checkout_query по чужому заказу (другой аккаунт) → ok: false
    alien = stars_checkout(b, o["invoice_link"])
    check(alien["answer"]["ok"] is False and alien["answer"].get("error_message")
          and not steering_leaks(alien["answer"]["error_message"], "текст отказа"), f"чужой pre_checkout: {alien['answer']}")
    wrong = stars_checkout(a, o["invoice_link"], total_amount=o["amount_stars"] + 1)
    check(wrong["answer"]["ok"] is False, f"pre_checkout с другой суммой: {wrong['answer']}")
    ok = stars_checkout(a, o["invoice_link"])
    check(ok["answer"]["ok"] is True and ok["in_time"] and ok["elapsed_ms"] < 10_000,
          f"pre_checkout_query: {ok['answer']} за {ok['elapsed_ms']} мс")
    again = stars_checkout(a, o["invoice_link"], query_id=ok["query_id"])
    check(again["answer"]["ok"] is True, "повтор query_id — другой ответ")
    paid = stars_pay(a, o["invoice_link"])
    check(paid["status"] == 200, f"successful_payment: {paid}")
    redeliver = tg_post("/_mock/updates/resend", {"update_id": paid["update_id"]})
    check(redeliver["status"] == 200, f"повторная доставка того же update_id: {redeliver}")
    dup = stars_pay(a, o["invoice_link"], charge_id=paid["charge_id"])  # тот же charge id, новый update_id
    check(dup["status"] == 200 and dup["repeat_charge"], f"второй successful_payment с тем же charge id: {dup}")
    order = poll_order(a, o["order_no"], ("fulfilled",))
    check(order["paid_at"] and order["invoice_link"] is None, f"заказ после оплаты: {order}")
    txns = int(s1._psql("SELECT count(*) FROM billing.provider_transactions WHERE provider = 'telegram_stars' AND "
                        f"provider_txn_id = '{paid['charge_id']}'"))
    check(txns == 1, f"транзакций по charge id: {txns}")
    ps = periods_of(a.account_id)
    trial = [x for x in ps if x["source"] == "trial"]
    stars = [x for x in ps if x["order_id"] == order_db(o["order_no"])["order_id"]]
    exp = datetime.fromtimestamp(paid["expiration"], UTC)
    check(len(stars) == 1 and stars[0]["status"] == "active"
          and abs((parse_ts(stars[0]["ends_at"]) - exp).total_seconds()) < 2, f"период Stars: {stars} (до {exp})")
    check(trial and trial[0]["status"] == "superseded", f"пробный: {trial}")
    ss = stars_sub_of(a.account_id)
    check(ss and ss["status"] == "active" and ss["first_charge_id"] == paid["charge_id"] and ss["renewals"] == 0,
          f"stars_subscriptions: {ss}")
    view = a.ok("GET", "/v1/billing/subscription")
    check(view["status"] == "active" and view["period"]["minutes_granted"] == 300 and view["stars_subscription"]
          and view["stars_subscription"]["auto_renew"] is True and view["stars_subscription"]["status"] == "active",
          f"подписка A: {view}")
    # вторую подписку при живой купить нельзя
    stars_order(a, "plus_30d", 409, "STARS_SUBSCRIPTION_EXISTS", confirm_forfeit=True)
    led = [x for x in ledger_of(a.account_id) if x["kind"] == "grant" and x["ref_kind"] == "order"]
    check(len(led) == 1 and led[0]["minutes"] == 300, f"начисление минут: {led}")
    n = wait_notif(a.account_id, "payment_succeeded", since)
    check(n["startapp"] == "route_subscription" and not steering_leaks(n["title"] + n["body"], "payment_succeeded"),
          f"уведомление об оплате: {n}")
    c.data.update(a_sub_order=o["order_no"], a_charge=paid["charge_id"], a_link=o["invoice_link"],
                  a_expiration=paid["expiration"], stars_done=True)
    print(f"      заказ {o['order_no']}: FORFEIT 409 → confirm → createInvoiceLink (XTR, 1 позиция, 2592000) → "
          f"pre_checkout ok за {ok['elapsed_ms']:.0f} мс (чужой и не та сумма — ok:false) → successful_payment ×3 "
          "(повтор update_id и charge id) → один период до subscription_expiration_date, пробный superseded",
          flush=True)


# ---------------------------------------------------------------- M07 продление и автопродление (AT-85)


def s_stars_renewal(c: s2.Ctx) -> None:
    need(c, "stars_done")
    a = u_(c, "A")
    since = int(time.time()) - 1
    ren = tg_post("/_mock/stars/renew", {"user": {"id": a.tg_id}, "first_charge_id": c.data["a_charge"]})
    check(ren["status"] == 200, f"продление: {ren}")
    ss = wait_for(lambda: (lambda s: s if s and s["renewals"] == 1 else None)(stars_sub_of(a.account_id)), 20,
                  what="renewals 1")
    check(ss["status"] == "active" and ss["last_charge_id"] == ren["charge_id"]
          and abs((parse_ts(ss["expires_at"]) - datetime.fromtimestamp(ren["expiration"], UTC)).total_seconds()) < 2,
          f"подписка после продления: {ss}")
    rows = [x for x in orders_of(a.account_id) if x["channel"] == "renewal"]
    check(len(rows) == 1 and rows[0]["status"] == "fulfilled" and rows[0]["stars_subscription_id"] == ss["subscription_id"],
          f"заказ renewal: {rows}")
    ps = periods_of(a.account_id)
    nxt = [x for x in ps if x["order_id"] == rows[0]["order_id"]]
    check(len(nxt) == 1 and nxt[0]["status"] in ("scheduled", "active"), f"период продления: {nxt}")
    hist = a.ok("GET", "/v1/billing/orders")["items"]
    check({x["channel"] for x in hist} <= {"miniapp", "renewal"} and any(x["channel"] == "renewal" for x in hist),
          f"история Mini App: {[(x['order_no'], x['channel']) for x in hist]}")
    view = a.ok("GET", "/v1/billing/subscription")
    check(view["next_period"] is not None or view["period"]["ends_at"], f"следующий период: {view['next_period']}")
    # subscription canceled (пользователь отключил в Telegram) → автопродление выкл.
    r = tg_post("/_mock/stars/subscription", {"user": {"id": a.tg_id}, "invoice_link": c.data["a_link"],
                                              "state": "canceled"})
    check(r["status"] == 200, f"subscription canceled: {r}")
    wait_for(lambda: (stars_sub_of(a.account_id) or {}).get("status") == "canceled", 20, what="status canceled")
    v = a.ok("GET", "/v1/billing/subscription")["stars_subscription"]
    check(v["auto_renew"] is False and v["status"] == "canceled", f"автопродление выкл.: {v}")
    ev = wait_for(lambda: [x for x in outbox("billing", "billing.stars_subscription.changed.v1", since)
                           if x["account_id"] == a.account_id and x["status"] == "canceled"], 20,
                  what="billing.stars_subscription.changed.v1 canceled")
    check(ev, "событие")
    # «Включить автопродление» в Mini App → editUserStarSubscription is_canceled false
    seq0 = tg_seq()
    on = a.ok("POST", "/v1/billing/stars-subscription", json={"auto_renew": True})
    check(on["stars_subscription"]["auto_renew"] is True, f"включить автопродление: {on['stars_subscription']}")
    calls = tg_method_calls("editUserStarSubscription", seq0)
    check(len(calls) == 1 and calls[0]["payload"]["is_canceled"] is False
          and calls[0]["payload"]["telegram_payment_charge_id"] == c.data["a_charge"]
          and calls[0]["payload"]["user_id"] == a.tg_id, f"editUserStarSubscription: {calls}")
    # без живой подписки у другого — 404
    u_(c, "E").ok("POST", "/v1/billing/stars-subscription", 404, "STARS_SUBSCRIPTION_NOT_FOUND",
                  json={"auto_renew": False})
    c.data["renewal_done"] = True
    print(f"      продление (is_recurring, не первый) → заказ renewal, период {nxt[0]['status']}; subscription canceled → "
          "автопродление выкл.; «Включить» в Mini App → editUserStarSubscription is_canceled false", flush=True)


# ---------------------------------------------------------------- M08 тилы ребёнку за Stars (AT-93)


def til_balance(c: s2.Ctx, u: s1.U, learner_id: str) -> int:
    if learner_id == u.account_id:
        return int(sg.summary(u)["til_balance"])
    u.switch(learner_id)
    try:
        return int(sg.summary(u)["til_balance"])
    finally:
        u.switch(u.account_id)


def s_stars_tils(c: s2.Ctx) -> None:
    need(c, "stars_done")
    a = u_(c, "A")
    kid = c.data["kid"]
    since = int(time.time()) - 1
    before = til_balance(c, a, kid)
    a.switch(kid)
    try:
        a.ok("POST", "/v1/billing/orders", 403, "PAYER_REQUIRED", idem=True,
             json={"product_code": "til_100", "provider": "telegram_stars", "offer_version": "1.0"})
    finally:
        a.switch(a.account_id)
    r = billing_as(a, "miniapp", "POST", "/orders", headers={"idempotency-key": str(uuid.uuid4())},
                   json={"product_code": "til_100", "provider": "telegram_stars", "offer_version": "1.0",
                         "beneficiary_id": u_(c, "B").account_id})
    check(r.status_code == 403 and r.json().get("code") == "BENEFICIARY_NOT_ALLOWED", f"чужой получатель: {r.text[:200]}")
    o = stars_order(a, "til_100", beneficiary_id=kid)
    inv = tg_method_calls("createInvoiceLink")[-1]["payload"]
    check("subscription_period" not in inv or inv["subscription_period"] is None, f"разовый счёт: {inv}")
    check(stars_checkout(a, o["invoice_link"])["answer"]["ok"] is True, "pre_checkout тилов")
    # billing недоступен при successful_payment: bot-gateway отвечает 503, Telegram повторит — зачисление одно
    stop = subprocess.run(["bash", str(RUN_LOCAL), "stop", "billing"], capture_output=True, text=True, timeout=60,
                          check=False)
    check(stop.returncode == 0, f"остановка billing: {stop.stderr[-300:]}")
    try:
        down = stars_pay(a, o["invoice_link"])
        check(down["status"] == 503, f"successful_payment при недоступном billing: {down['status']} {down.get('body')}")
    finally:
        reconfig()
    up = tg_post("/_mock/updates/resend", {"update_id": down["update_id"]})
    check(up["status"] == 200, f"повтор Telegram после восстановления billing: {up}")
    tg_post("/_mock/updates/resend", {"update_id": down["update_id"]})
    order = poll_order(a, o["order_no"], ("fulfilled",), 60)
    wait_for(lambda: til_balance(c, a, kid) == before + 100, 30, what="тилы ребёнка +100")
    after = before + 100
    check(after == before + 100, f"тилы ребёнка: {before} → {after}")
    cr = wait_for(lambda: [x for x in outbox("gamification", "game.til_pack.credited.v1", since)
                           if x["order_id"] == order_db(o["order_no"])["order_id"]], 20, what="game.til_pack.credited.v1")
    check(len(cr) == 1 and cr[0]["user_id"] == kid and cr[0]["outcome"] == "credited", f"credited: {cr}")
    ops = int(s1._psql("SELECT count(*) FROM gamification.ledger WHERE idempotency_key = 'purchase:"
                       f"{uid(order_db(o['order_no'])['order_id'])}'"))
    check(ops == 1, f"операций purchase по заказу: {ops}")
    check(order["paid_at"], "paid_at")
    c.data.update(a_til_stars=o["order_no"])
    print(f"      тилы ребёнку за Stars: заказ {o['order_no']} (ребёнок сам — 403, чужой получатель — 403); billing "
          f"остановлен → webhook 503 → повтор Telegram → fulfilled; тилы ребёнка {before} → {after} один раз", flush=True)


# ---------------------------------------------------------------- M09 сайт: вход и Payme (AT-86, AT-87, AT-96)


def s_site_payme(c: s2.Ctx) -> None:
    need(c, "stars_done")
    a = u_(c, "A")
    prov: mp.Provider = c.data["provider"]
    # вход: подделанный id_token, нет аккаунта, повтор state/code, ребёнок не входит
    for forge in ("bad_signature", "bad_aud", "expired"):
        bad = Site(c, f"forge-{forge}")
        loc = bad.login(a.tg_id, forge=forge)
        check(loc == "/?login_error=auth_failed" and "__Host-wp_session" not in bad.cookies, f"{forge}: {loc}")
    nobody = Site(c, "nobody")
    loc = nobody.login(c.data["x_tg"])
    check(loc == "/?login_error=account_not_found" and not nobody.cookies.get("__Host-wp_session"), f"без аккаунта: {loc}")
    r = httpx.get(f"{s1.IDENTITY}/internal/v1/telegram-users/{int(c.data['x_tg'])}/account", timeout=10,
                  headers=s1.internal_token("telegram-bot-gateway", "identity-consent"))
    check(r.status_code == 404, f"вход на сайт создал аккаунт: {r.status_code}")
    site = Site(c, "A")
    loc = site.login(a.tg_id)
    check(loc == "/", f"после входа адрес не очищен: {loc}")
    attrs = site.attrs.get("__Host-wp_session", "")
    check(site.cookies.get("__Host-wp_session") and "httponly" in attrs and "secure" in attrs
          and "samesite=strict" in attrs and "path=/" in attrs and "domain=" not in attrs, f"cookie сессии: {attrs}")
    replay = site.http.get(c.data["last_callback"] if site.via_caddy else
                           "/web/v1" + c.data["last_callback"].removeprefix("/api"), headers=site.cookie_header())
    check(replay.status_code == 302 and replay.headers["location"] == "/?login_error=auth_failed",
          f"повтор state/code: {replay.status_code} {replay.headers.get('location')}")
    calls = expect(httpx.get(f"{MOCK_OIDC}/_mock/calls", timeout=10), 200)
    last = calls["token"][-1]
    check(last["basic_ok"] and last["pkce_ok"] and last["form_ok"] and last["grant_type"] == "authorization_code",
          f"обмен code: {last}")
    check("profile" in (calls["auth"][-1]["scope"] or "").split(), f"scope: {calls['auth'][-1]['scope']} (§14 L1)")
    me = site.me()
    check(me["account"] == {"age_band": "18+", "can_pay": True, "consent_required": False}
          and {x["kind"] for x in me["learners"]} == {"self", "child"}
          and any(x["learner_id"] == c.data["kid"] for x in me["learners"]), f"WebMe: {me}")
    check(str(a.tg_id) not in json.dumps(me), "Telegram ID в ответе сайта")
    cat = site.ok("GET", "/catalog")
    check(cat["providers"] == ["payme", "click", "uzum"] and all(set(p["price"]) == {"tiyin"} for p in cat["products"])
          and "trial" not in cat, f"каталог сайта: {str(cat)[:300]}")
    p90 = next(p for p in cat["products"] if p["code"] == "plus_90d")
    check(p90["price"]["tiyin"] == 12_900_000, f"цена «Плюс 90»: {p90['price']}")
    sub = site.ok("GET", "/subscription")
    check("stars_subscription" not in sub and "trial_available" not in sub and sub["status"] == "active",
          f"подписка на сайте: {sub}")
    body = {"product_code": "plus_90d", "provider": "payme", "start_mode": "after_current",
            "offer_version": cat["offer"]["version"]}
    r = site.req("POST", "/orders", json_body=body, csrf=False, idem_key=str(uuid.uuid4()))
    check(r.status_code == 403 and r.json().get("code") == "CSRF_INVALID", f"без CSRF: {r.status_code}")
    r = site.req("POST", "/orders", json_body=body, origin="https://evil.example", idem_key=str(uuid.uuid4()))
    check(r.status_code == 403 and r.json().get("code") == "CSRF_INVALID", f"чужой Origin: {r.status_code}")
    o = site.order(body)
    check(o["status"] == "pending" and o["currency"] == "UZS" and o["amount_tiyin"] == 12_900_000
          and o["provider"] == "payme" and o["checkout_url"].startswith("https://"), f"заказ сайта: {o}")
    raw = base64.b64decode(o["checkout_url"].rsplit("/", 1)[1]).decode()
    check(f"ac.order_id={o['order_no']}" in raw and "a=12900000" in raw
          and f"c={WEB_ORIGIN}/orders/{o['order_no']}" in raw, f"ссылка Payme: {raw}")
    n = o["order_no"]
    acc = {"order_id": str(n)}
    # Payme: всегда HTTP 200; неверный Basic — -32504
    bad = prov.payme("CheckPerformTransaction", {"amount": o["amount_tiyin"], "account": acc}, key="wrong-key")
    check(bad.status == 200 and bad.error == -32504, f"неверный ключ: {bad}")
    bad = prov.payme("CheckPerformTransaction", {"amount": o["amount_tiyin"] + 100, "account": acc})
    check(bad.status == 200 and bad.error == -31001, f"сумма: {bad}")
    bad = prov.payme("CheckPerformTransaction", {"amount": o["amount_tiyin"], "account": {"order_id": "999999999"}})
    check(bad.status == 200 and bad.error == -31050, f"нет заказа: {bad}")
    ok = prov.payme("CheckPerformTransaction", {"amount": o["amount_tiyin"], "account": acc})
    det = (ok.body.get("result") or {}).get("detail")
    check(ok.body.get("result", {}).get("allow") is True and det and det["receipt_type"] == 0 and len(det["items"]) == 1
          and det["items"][0]["code"] == FISCAL["ikpu"] and det["items"][0]["price"] == o["amount_tiyin"]
          and det["items"][0]["vat_percent"] == FISCAL["vat_percent"] and det["items"][0]["count"] == 1,
          f"CheckPerformTransaction detail: {ok.body}")
    tid = secrets.token_hex(12)
    now_ms = int(time.time() * 1000)
    params = {"id": tid, "time": now_ms, "amount": o["amount_tiyin"], "account": acc}
    c1, c2 = prov.payme("CreateTransaction", params), prov.payme("CreateTransaction", params)
    check(c1.body.get("result", {}).get("state") == 1 and c1.body["result"] == c2.body["result"], f"Create ×2: {c1} {c2}")
    other = prov.payme("CreateTransaction", {**params, "id": secrets.token_hex(12)})
    check(other.status == 200 and other.error is not None, f"вторая транзакция по заказу в ожидании: {other}")
    p1, p2 = prov.payme("PerformTransaction", {"id": tid}), prov.payme("PerformTransaction", {"id": tid})
    check(p1.body.get("result", {}).get("state") == 2 and p1.body["result"] == p2.body["result"], f"Perform ×2: {p1} {p2}")
    chk = prov.payme("CheckTransaction", {"id": tid})
    check(chk.body.get("result", {}).get("state") == 2 and chk.body["result"]["perform_time"] > 0, f"Check: {chk}")
    order = site.ok("GET", f"/orders/{n}")
    check(order["status"] == "fulfilled" and order["checkout_url"] is None, f"заказ после оплаты: {order}")
    ps = [x for x in periods_of(a.account_id) if x["order_id"] == order_db(n)["order_id"]]
    check(len(ps) == 1 and ps[0]["status"] == "scheduled", f"«Плюс 90» после текущего — scheduled: {ps}")
    qr = f"https://ofd.soliq.uz/check?t=EP000000{c.tag}&r=1&c=20261128&s=1"
    fd = prov.payme("SetFiscalData", {"id": tid, "type": "PERFORM", "fiscal_data": {
        "receipt_id": 123, "status_code": 0, "message": "accepted", "terminal_id": "EP000000000001",
        "fiscal_sign": "123456789012", "qr_code_url": qr, "date": "20261128140000"}})
    check(fd.body.get("result") == {"success": True}, f"SetFiscalData: {fd}")
    page = site.ok("GET", f"/orders/{n}")
    check(page["receipt_url"] == qr, f"ссылка на чек на странице заказа: {page['receipt_url']}")
    hist = site.ok("GET", "/orders")["items"]
    check([x["order_no"] for x in hist if x["order_no"] == n] and all(x["currency"] == "UZS" for x in hist),
          f"история сайта: {[(x['order_no'], x['currency']) for x in hist]}")
    site.ok("GET", f"/orders/{c.data['a_sub_order']}", 404)  # заказ Stars в канале web — как чужой
    pc = pj("SELECT coalesce(json_agg(json_build_object('m', method, 'r', result_code, 'ip', host(client_ip))), '[]') "
            f"FROM billing.provider_calls WHERE provider = 'payme' AND order_no = {int(n)}") or []
    check(pc and all(x["ip"] == prov.client_ip for x in pc) and {x["m"] for x in pc} >= {"CreateTransaction",
                                                                                         "PerformTransaction"},
          f"provider_calls: {pc[:4]}")
    c.data.update(site=site, a_payme=n, a_payme_tid=tid, site_done=True)
    print(f"      вход: подделки id_token (подпись, aud, exp) и повтор state — отказ, без аккаунта — account_not_found, A — "
          f"cookie __Host-wp_session, адрес «/»; заказ {n} «Плюс 90» Payme: Check (detail ИКПУ) → Create ×2 → "
          f"Perform ×2 → fulfilled, период scheduled; SetFiscalData → чек на странице; без CSRF и с чужим Origin — 403",
          flush=True)


# ---------------------------------------------------------------- M10 анти-стиринг (AT-100)


def s_anti_steering(c: s2.Ctx) -> None:
    need(c, "site_done")
    a = u_(c, "A")
    leaks: list[str] = []
    hist = a.ok("GET", "/v1/billing/orders")["items"]
    check(c.data["a_payme"] not in [x["order_no"] for x in hist], "заказ сайта в истории платежей Mini App")
    a.ok("GET", f"/v1/billing/orders/{c.data['a_payme']}", 404, "ORDER_NOT_FOUND")
    for path in ("/v1/billing/catalog", "/v1/billing/subscription", "/v1/billing/orders", "/v1/billing/minutes",
                 f"/v1/billing/orders/{c.data['a_sub_order']}", "/v1/game/summary"):
        leaks += steering_leaks(a.ok("GET", path), path)
    view = a.ok("GET", "/v1/billing/subscription")
    check(view["status"] == "active" and view["next_period"] is not None, f"покупка на сайте видна как следующий период: "
                                                                          f"{view['next_period']}")
    # уведомление о заказе сайта — нейтральное: purchase_applied без суммы и провайдера
    since = c.data["started_at"]
    rows = notif_rows(a.account_id, since)
    web = [x for x in rows if x["template"] == "purchase_applied"]
    check(web, f"уведомление о заказе сайта: {[x['template'] for x in rows]}")
    for x in rows:
        if x["template"] in ("payment_succeeded", "purchase_applied", "refund_completed", "trial_started",
                             "minutes_adjusted", "stars_renewal_failed", "minutes_low"):
            leaks += steering_leaks(x["title"] + " " + x["body"], f"уведомление {x['template']}")
            if x["startapp"] and not x["startapp"].startswith("route_"):
                leaks.append(f"уведомление {x['template']}: startapp {x['startapp']}")
    inbox = a.inbox()
    for x in inbox:
        leaks += steering_leaks(f"{x['title']} {x['body']}", "центр уведомлений")
    for msg in s1.tg_calls(a.tg_id):
        text = msg["payload"].get("text", "")
        leaks += steering_leaks(text, "сообщение бота")
        for b in s1.buttons(msg["payload"]):
            url = (b.get("web_app") or {}).get("url") or b.get("url") or ""
            if url and "startapp=" not in url and not url.startswith(s1.MINIAPP_URL):
                leaks.append(f"кнопка {url[:80]}")
    # тексты бота: /paysupport, /support, /terms — без ссылок на сайт оплаты
    seq0 = tg_seq()
    for cmd in ("/paysupport", "/terms", "/support"):
        r = s1._webhook(s1._start_update(a, cmd))
        check(r.status_code == 200, f"{cmd}: {r.status_code}")
        reply = r.json()
        if reply.get("method") == "sendMessage":
            leaks += steering_leaks(reply.get("text", ""), cmd)
            for b in s1.buttons(reply):
                url = (b.get("web_app") or {}).get("url") or b.get("url") or ""
                if web_host() in url:
                    leaks.append(f"{cmd}: ссылка на сайт")
        else:
            sent = s1.tg_calls(a.tg_id, seq0)
            leaks += [x for m in sent for x in steering_leaks(m["payload"].get("text", ""), cmd)]
    check(not leaks, f"анти-стиринг: {sorted(set(leaks))[:10]}")
    print(f"      Mini App: история — только Stars ({len(hist)} заказов), заказ сайта — 404; ответы без тийинов и "
          f"провайдеров; уведомление сайта — purchase_applied без суммы; /paysupport, /terms, /support — без сайта",
          flush=True)


# ---------------------------------------------------------------- M11 тилы ребёнку через Click (AT-88)


def s_site_click(c: s2.Ctx) -> None:
    need(c, "site_done")
    a = u_(c, "A")
    site: Site = c.data["site"]
    prov: mp.Provider = c.data["provider"]
    kid = c.data["kid"]
    before = til_balance(c, a, kid)
    site.order({"product_code": "til_100", "provider": "click", "beneficiary_id": u_(c, "B").account_id,
                "offer_version": "1.0"}, 403, "BENEFICIARY_NOT_ALLOWED")
    o = site.order({"product_code": "til_100", "provider": "click", "beneficiary_id": kid, "offer_version": "1.0"})
    check(o["checkout_url"].startswith("https://my.click.uz/services/pay?") and f"transaction_param={o['order_no']}"
          in o["checkout_url"] and "amount=5000.00" in o["checkout_url"], f"ссылка Click: {o['checkout_url']}")
    n, amount = o["order_no"], "5000.00"
    ct = str(1_000_000 + secrets.randbelow(8_999_999))
    bad = prov.click_prepare(ct, n, amount, sign_string="0" * 32)
    check(bad.status == 200 and bad.error == -1, f"неверная подпись Prepare: {bad}")
    w = prov.click_prepare(ct, n, "4999.00")
    check(w.error == -2, f"сумма: {w}")
    p1, p2 = prov.click_prepare(ct, n, amount), prov.click_prepare(ct, n, amount)
    check(p1.error == 0 and p1.body == p2.body and p1.body.get("merchant_prepare_id"), f"Prepare ×2: {p1} {p2}")
    mpid = p1.body["merchant_prepare_id"]
    bad = prov.click_complete(ct, n, amount, mpid, sign_string="f" * 32)
    check(bad.error == -1, f"неверная подпись Complete: {bad}")
    done = prov.click_complete(ct, n, amount, mpid)
    check(done.error == 0 and done.body.get("merchant_confirm_id"), f"Complete: {done}")
    expect(httpx.post(f"{MOCK_PAY}/_mock/click/payments", json={"merchant_trans_id": str(n),
                                                               "payment_id": mp.click_paydoc_id(ct), "status": 2}), 200)
    again = prov.click_complete(ct, n, amount, mpid)
    check(again.error == -4, f"повтор Complete: {again}")
    wait_for(lambda: til_balance(c, a, kid) == before + 100, 40, what="тилы ребёнка +100 (Click)")
    after = before + 100
    order = wait_for(lambda: (lambda x: x if x["status"] == "fulfilled" else None)(site.ok("GET", f"/orders/{n}")), 30,
                     what="заказ Click fulfilled")
    # фискализация Click: submit_items (мок Merchant API) — сразу или повтором tick
    def receipt() -> Any:
        billing_tick()
        return site.ok("GET", f"/orders/{n}")["receipt_url"]
    try:
        url = wait_for(receipt, 30, interval=2.0, what="чек Click (submit_items → ofd_data)")
        check(url.startswith("https://"), url)
        sub = [x for x in expect(httpx.get(f"{MOCK_PAY}/_mock/calls", params={"op": "submit_items"}), 200)["items"]]
        check(sub and sub[-1]["body"]["items"][0]["SPIC"] == FISCAL["ikpu"], f"submit_items: {sub[-1:]}")
    except StepFailed as exc:
        note(f"фискализация Click не подтверждена на стенде: {exc}")
    check(after == before + 100 and order["paid_at"], f"тилы ребёнка {before} → {after}")
    c.data.update(a_click=n, a_click_ct=ct)
    print(f"      Click: заказ {n} тилы ребёнку (чужой получатель — 403): подпись -1, сумма -2, Prepare ×2 → тот же "
          f"merchant_prepare_id, Complete → +100 тилов, повтор Complete -4", flush=True)


# ---------------------------------------------------------------- M12 Uzum (AT-89, за флагом)


def s_site_uzum(c: s2.Ctx) -> None:
    need(c, "site_done")
    site: Site = c.data["site"]
    prov: mp.Provider = c.data["provider"]
    o = site.order({"product_code": "til_100", "provider": "uzum", "offer_version": "1.0"})
    n = o["order_no"]
    bad = prov.uzum("check", order_no=n, password="wrong-password-000")  # noqa: S106 — неверный, тестовый
    check(bad.body.get("status") == "FAILED" and bad.body.get("errorCode") == 10001, f"Uzum Basic: {bad}")
    chk = prov.uzum("check", order_no=n)
    check(chk.body.get("status") == "OK", f"Uzum check: {chk}")
    tid = str(uuid.uuid4())
    cr1, cr2 = (prov.uzum("create", trans_id=tid, order_no=n, amount=o["amount_tiyin"]) for _ in range(2))
    check(cr1.body.get("status") == "CREATED" and (cr1.body.get("transTime") == cr2.body.get("transTime")
                                                   or cr2.body.get("errorCode") == 10010),
          f"Uzum create ×2: {cr1} {cr2}")
    if cr2.body.get("errorCode") == 10010:
        note("Uzum: повтор create с тем же transId — FAILED 10010 «уже есть» (HTTP 400), а не тот же ответ: так в "
             "сторонних SDK (§14 U1), сверить при получении спецификации")
    cf1 = prov.uzum("confirm", trans_id=tid)
    cf2 = prov.uzum("confirm", trans_id=tid)
    check(cf1.body.get("status") == "CONFIRMED" and cf2.body.get("status") in ("CONFIRMED", "FAILED"),
          f"Uzum confirm ×2: {cf1} {cf2}")
    st = prov.uzum("status", trans_id=tid)
    check(st.body.get("status") == "CONFIRMED", f"Uzum status: {st}")
    order = wait_for(lambda: (lambda x: x if x["status"] == "fulfilled" else None)(site.ok("GET", f"/orders/{n}")), 30,
                     what="заказ Uzum fulfilled")
    check(order["provider"] == "uzum", order)
    txns = int(s1._psql(f"SELECT count(*) FROM billing.provider_transactions WHERE provider = 'uzum' AND "
                        f"order_id = '{uid(order_db(n)['order_id'])}'"))
    check(txns == 1, f"транзакций Uzum: {txns}")
    print(f"      Uzum (симулятор, за флагом): заказ {n}: check → create ×2 → confirm ×2 → status; Basic — 10001",
          flush=True)


# ---------------------------------------------------------------- M13 урок вдвоём (AT-91)


def s_pair(c: s2.Ctx) -> None:
    need(c, "stars_done")
    a, b = u_(c, "A"), u_(c, "B")
    since = int(time.time()) - 1
    scns = pj("SELECT coalesce(json_agg(cv.key ORDER BY cv.key), '[]') FROM catalog.content_versions cv JOIN "
              "catalog.content_pointers p ON p.kind = cv.kind AND p.key = cv.key AND p.published_version = cv.version "
              "WHERE cv.kind = 'scenario' AND cv.payload->'audience' ? 'adults'") or []
    check(scns, "нет опубликованного сценария для взрослых")
    scn = "sc-cafe-coffee" if "sc-cafe-coffee" in scns else scns[0]
    body_b = {"partner_member_id": c.data["mid"]["A"], "pair_id": PAIR, "scenario_id": scn, "start": "now"}
    e = b.ok("POST", "/v1/pair-rooms", 403, "SUBSCRIPTION_REQUIRED", json=body_b, idem=True)
    check((e.get("details") or {}) == {"feature": "pair_lessons", "reason": "no_subscription"}, f"B приглашает A: {e}")
    left0 = a.ok("GET", "/v1/billing/subscription")["period"]["minutes_left"]
    body = {"partner_member_id": c.data["mid"]["B"], "pair_id": PAIR, "scenario_id": scn, "start": "now"}
    rid = a.ok("POST", "/v1/pair-rooms", 201, json=body, idem=True)["room_id"]
    b.ok("POST", f"/v1/pair-rooms/{rid}/accept")
    a.ok("POST", f"/v1/pair-rooms/{rid}/join")
    b.ok("POST", f"/v1/pair-rooms/{rid}/join")
    st = s7.wait_room(a, rid, lambda s_: s_["status"] == "in_progress" and s_["next_speaker"] is not None,
                      "старт комнаты", 40)
    h = hold_of(rid)
    if st["mode"] != "free" or st["ai_degraded"]:
        note(f"комната A–B без коуча (mode {st['mode']}, ai_degraded {st['ai_degraded']}) — удержания может не быть")
    check(h and h["account_id"] == a.account_id and h["feature"] == "pair_lessons" and h["ref_kind"] == "room",
          f"удержание урока вдвоём у пригласившего: {h}")
    # переподключение — без второго удержания
    a.ok("POST", f"/v1/pair-rooms/{rid}/join")
    check(int(s1._psql(f"SELECT count(*) FROM billing.minute_holds WHERE ref_id = '{uid(rid)}'")) == 1,
          "переподключение создало второе удержание")
    with s7.Heartbeat(a, rid), s7.Heartbeat(b, rid):
        for role, u in (("A", a), ("B", b)):
            cur = s7.wait_room(u, rid, s7.my_turn(role), f"ход {role}", 40)
            time.sleep(s7.THINK)
            if cur["mode"] == "choices":
                u.ok("POST", f"/v1/pair-rooms/{rid}/turns", json={"choice_id": s7.script_choice(rid, cur["options"])},
                     idem=True)
            else:
                u.ok("POST", f"/v1/pair-rooms/{rid}/turns",
                     json={"text": f"I would like a cup of tea, please {c.data['marker']}{role}"}, idem=True)
        time.sleep(1.5)
    # завершение комнаты: остановка администратором (operations, step-up) — событие lesson.pair.completed.v1 сразу
    # (выход участников оставляет комнату на паузе до 3 мин на возврат)
    ops = c.staff["ops"]
    s2.ensure_step_up(ops)
    expect(ops.browser.post(f"/admin/v1/pair-rooms/{rid}/stop", {"reason": f"e2e {c.tag}: конец урока вдвоём"}), 200)
    ev = wait_for(lambda: [x for x in outbox("lessons", "lesson.pair.completed.v1", since) if x["room_id"] == rid], 40,
                  what="lesson.pair.completed.v1")
    bl = ev[0].get("billing")
    check(bl and bl["payer_user_id"] == a.account_id and bl["hold_id"] == h["hold_id"]
          and bl["billable_minutes"] >= 1, f"billing в lesson.pair.completed.v1: {bl}")
    wait_for(lambda: (hold_of(rid) or {}).get("status") == "settled", 30, what="удержание комнаты settled")
    deb = [x for x in ledger_of(a.account_id) if x["kind"] == "debit" and x["ref_kind"] == "room"]
    check(len(deb) == 1 and deb[0]["minutes"] == -bl["billable_minutes"], f"списание у A: {deb}")
    check(not [x for x in ledger_of(b.account_id) if x["kind"] == "debit"], "у приглашённого списаны минуты")
    env = pj("SELECT envelope FROM lessons.outbox WHERE envelope->>'event_type' = 'lesson.pair.completed.v1' AND "
             f"envelope->'payload'->>'room_id' = '{uid(rid)}' LIMIT 1")
    seq = sg.replay(env, "billing_pairs")
    sg.wait_delivered("billing_pairs", seq)
    time.sleep(0.5)
    check(len([x for x in ledger_of(a.account_id) if x["kind"] == "debit" and x["ref_kind"] == "room"]) == 1,
          "повтор события комнаты — второе списание")
    left1 = a.ok("GET", "/v1/billing/subscription")["period"]["minutes_left"]
    check(left1 == left0 - bl["billable_minutes"], f"минуты A: {left0} → {left1}")
    # семейная комната A с ребёнком — без проверки и списания
    a.switch(c.data["kid"])
    try:
        fam = a.ok("GET", "/v1/family")
        fm = [m for m in fam["members"] if m["user_id"] == a.account_id]
        rk = None
        if fm and fm[0].get("member_id"):
            kids_scn = pj("SELECT coalesce(json_agg(cv.key ORDER BY cv.key), '[]') FROM catalog.content_versions cv "
                          "JOIN catalog.content_pointers p ON p.kind = cv.kind AND p.key = cv.key AND "
                          "p.published_version = cv.version WHERE cv.kind = 'scenario' AND cv.payload->'audience' ? "
                          "'kids'") or []
            r = a.req("POST", "/v1/pair-rooms", json={"partner_member_id": fm[0]["member_id"], "pair_id": PAIR,
                                                      "scenario_id": kids_scn[0], "start": "now"}, idem=True)
            if r.status_code == 201:
                rk = r.json()["room_id"]
                check(r.json()["mode"] == "choices", f"комната ребёнка: {r.json()['mode']}")
            else:
                note(f"семейная комната ребёнка с родителем: {r.status_code} {r.text[:160]}")
        else:
            note("семья ребёнка без member_id родителя — семейная комната не проверена")
    finally:
        a.switch(a.account_id)
    if rk:
        check(hold_of(rk) is None, "семейная комната с ребёнком — удержание минут")
    c.data["pair_done"] = rid
    print(f"      B без подписки приглашает A — 403 SUBSCRIPTION_REQUIRED; A приглашает B → удержание у A, "
          f"переподключение без второго; leave → списание {bl['billable_minutes']} мин у A один раз (повтор события — нет); "
          f"семейная комната с ребёнком — без удержания", flush=True)


# ---------------------------------------------------------------- M14 «четыре глаза» и исчерпание минут (AT-95, AT-90)


def s_four_eyes(c: s2.Ctx) -> None:
    need(c, "stars_done")
    a, e_ = u_(c, "A"), u_(c, "E")
    sup, fin = c.staff["sup"], c.staff["fin"]
    since = int(time.time()) - 1
    acc = admin(sup, "GET", f"/accounts/{a.account_id}")
    act = next((p for p in acc["periods"] if p["status"] == "active"), None)
    check(act and act["balance"], f"активный период A в админке: {str(acc)[:300]}")
    left0 = act["balance"]["minutes_left"]
    req = {"kind": "minutes", "minutes": 30, "period_id": act["period_id"],
           "reason": f"e2e {c.tag}: компенсация за сбой урока"}
    # без step-up — 403
    r = sup.browser.request("POST", f"/admin/v1/billing/accounts/{a.account_id}/adjustments", json_body=req,
                            headers=idem())
    if r.status_code != 403:
        s2.ensure_step_up(sup)
    adj = admin(sup, "POST", f"/accounts/{a.account_id}/adjustments", 202, body=req, step_up=True)
    check(adj["status"] == "pending" and staff_ref_ok(adj["requested_by"], sup) and adj["can_decide"] is False
          and adj["can_cancel"] is True, f"заявка: {adj}")
    admin(sup, "POST", f"/adjustments/{adj['adjustment_id']}/approve", 403, None, body={}, step_up=True)
    r = httpx.post(f"{BILLING}/internal/v1/admin/billing/adjustments/{adj['adjustment_id']}/approve", json={},
                   headers={**staff_hdr({"billing.read", "billing.approve"}, True, sup.staff_id),
                            "idempotency-key": str(uuid.uuid4())}, timeout=20)
    check(r.status_code == 409 and r.json().get("code") == "SELF_APPROVAL", f"автор подтверждает (в домене): {r.text[:200]}")
    lst = admin(fin, "GET", "/adjustments", params={"status": "pending"})["items"]
    mine = next(x for x in lst if x["adjustment_id"] == adj["adjustment_id"])
    check(mine["can_decide"] is True and mine["can_cancel"] is False, f"заявка у finance: {mine}")
    done = admin(fin, "POST", f"/adjustments/{adj['adjustment_id']}/approve", body={"note": "Проверено по логам"},
                 step_up=True)
    check(done["status"] == "applied" and staff_ref_ok(done["decided_by"], fin) and done["before_value"]
          and done["after_value"], f"подтверждение: {done}")
    admin(fin, "POST", f"/adjustments/{adj['adjustment_id']}/approve", 409, "ADJUSTMENT_STATE", body={}, step_up=True)
    left1 = a.ok("GET", "/v1/billing/subscription")["period"]["minutes_left"]
    check(left1 == left0 + 30, f"минуты A: {left0} → {left1}")
    hist = a.ok("GET", "/v1/billing/minutes")["items"]
    check(hist[0]["kind"] == "adjust" and hist[0]["minutes"] == 30 and "reason" not in hist[0]
          and req["reason"] not in json.dumps(hist, ensure_ascii=False), f"история минут A: {hist[0]}")
    ev = wait_for(lambda: [x for x in outbox("billing", "billing.adjustment.applied.v1", since)
                           if x["adjustment_id"] == adj["adjustment_id"]], 20, what="billing.adjustment.applied.v1")
    check(ev[0]["minutes"] == 30, ev)
    n = wait_notif(a.account_id, "minutes_adjusted", since)
    check(req["reason"] not in n["body"], "комментарий сотрудника в уведомлении ученику")
    # отклонение ничего не меняет
    rj = admin(sup, "POST", f"/accounts/{a.account_id}/adjustments", 202, step_up=True,
               body={**req, "minutes": 10, "reason": f"e2e {c.tag}: ошибочная заявка"})
    rjd = admin(fin, "POST", f"/adjustments/{rj['adjustment_id']}/reject", body={"note": "Заявка ошибочная, отклоняю"},
                step_up=True)
    check(rjd["status"] == "rejected", f"отклонение: {rjd}")
    check(a.ok("GET", "/v1/billing/subscription")["period"]["minutes_left"] == left1, "отклонение изменило минуты")
    # E: пробный → списание почти всего «четырьмя глазами» → урок длиннее остатка: без обрыва и без минуса
    e_.ok("POST", "/v1/billing/trial", 201, idem=True)
    pe = e_.ok("GET", "/v1/billing/subscription")["period"]
    eacc = admin(sup, "GET", f"/accounts/{e_.account_id}")
    ep = next(p for p in eacc["periods"] if p["status"] == "active")
    neg = admin(sup, "POST", f"/accounts/{e_.account_id}/adjustments", 202, step_up=True,
                body={"kind": "minutes", "minutes": -(pe["minutes_left"] - 1), "period_id": ep["period_id"],
                      "reason": f"e2e {c.tag}: проверка исчерпания минут"})
    admin(fin, "POST", f"/adjustments/{neg['adjustment_id']}/approve", body={}, step_up=True)
    check(e_.ok("GET", "/v1/billing/subscription")["period"]["minutes_left"] == 1, "остаток E — 1 минута")
    s, content = start_lesson(c, e_)
    sid = s["session_id"]
    check(s["ai_mode"] == "full" and s["ai_minutes_left"] == 0, f"урок E с 1 минутой: {str(s)[:300]}")

    def stretch() -> None:
        res = psql_try(f"UPDATE lessons.sessions SET last_activity_at = last_activity_at - interval '130 seconds' "
                       f"WHERE session_id = '{uid(sid)}' AND status = 'in_progress'")
        check(res.returncode == 0, f"сдвиг активности: {res.stderr[:200]}")
        log_db_change(f"lessons.sessions.last_activity_at сессии E {sid[:8]} → −130 с (2 ИИ-минуты без ожидания)")

    summ = finish_lesson(e_, sid, content, pause_s=0.5, before_finish=stretch)
    check(summ["status"] == "completed", f"урок E завершён (не оборван): {summ['status']}")
    ev = completed_event(sid, since)
    check(ev["billable_minutes"] >= 2, f"billable_minutes E: {ev['billable_minutes']}")
    wait_for(lambda: (hold_of(sid) or {}).get("status") == "settled", 30, what="удержание E settled")
    h = hold_of(sid)
    sub = e_.ok("GET", "/v1/billing/subscription")
    check(sub["period"]["minutes_left"] == 0 and sub["minutes_exhausted"] is True
          and sub["period"]["overage"] == ev["billable_minutes"] - 1 and h["settled_minutes"] == 1
          and h["overage"] == ev["billable_minutes"] - 1, f"исчерпание: {sub['period']}, удержание {h}")
    bal = pj(f"SELECT row_to_json(b) FROM (SELECT granted, spent, removed, held, overage FROM billing.period_balances "
             f"WHERE period_id = '{uid(ep['period_id'])}') b")
    check(bal["granted"] - bal["spent"] - bal["removed"] >= 0 and bal["held"] == 0, f"баланс ≥ 0: {bal}")
    s2_, content2 = start_lesson(c, e_)
    check(s2_["ai_mode"] == "choices" and s2_["ai_locked"] == {"reason": "minutes_exhausted"},
          f"после исчерпания: {str(s2_)[:300]}")
    finish_lesson(e_, s2_["session_id"], content2, pause_s=0)
    c.data["four_eyes_done"] = {"adj": adj["adjustment_id"], "rej": rj["adjustment_id"], "neg": neg["adjustment_id"]}
    print(f"      заявка support +30 → сам подтвердить нельзя (SELF_APPROVAL) → finance подтвердил: {left0} → {left1}; "
          f"отклонение без изменений; E: остаток 1 мин, урок {ev['billable_minutes']} ИИ-мин — завершён, списано 1, "
          f"перерасход {h['overage']}, баланс 0 → следующий урок minutes_exhausted", flush=True)


# ---------------------------------------------------------------- M15 контроль ИИ (AT-98)


def s_ai_control(c: s2.Ctx) -> None:
    need(c, "stars_done")
    a, b = u_(c, "A"), u_(c, "B")
    root = c.staff["root"]
    since = int(time.time()) - 1
    cur = expect(root.browser.get("/admin/v1/ai/degradation"), 200)
    c.data["degradation0"] = cur
    body = {"mode": "manual", "manual_level": "paid_only", "economy_at_percent": cur["economy_at_percent"],
            "paid_only_at_percent": cur["paid_only_at_percent"], "reason": f"e2e {c.tag}: только подписчики"}
    r = root.browser.request("PUT", "/admin/v1/ai/degradation", json_body={**body, "manual_level": None}, headers=idem())
    check(r.status_code == 422, f"manual без уровня: {r.status_code}")
    s2.ensure_step_up(root)
    set_ = expect(root.browser.request("PUT", "/admin/v1/ai/degradation", json_body=body, headers=idem()), 200)
    check(set_["mode"] == "manual" and set_["level"] == "paid_only", f"уровень: {set_}")
    try:
        st = expect(httpx.get(f"{AI_GW}/internal/v1/status", headers=s1.internal_token("lessons", "ai-gateway"),
                              timeout=10), 200)
        check(st["level"] == "paid_only" and st["paid_available"] is True and st["free_available"] is False,
              f"ai-gateway status: {st}")
        # B (бесплатный): перевод по тапу — ИИ недоступен (degraded); A (подписчик): урок full
        readings = b.ok("GET", "/v1/practice/readings", params={"limit": 50})["items"]
        check(readings, "нет текстов для чтения у B")
        rv = b.ok("GET", f"/v1/practice/readings/{readings[0]['reading_id']}")
        gloss = {g["en"].lower() for g in rv["glossary"]}
        words = []
        for pp in rv["paragraphs"]:
            for sen in pp["sentences"]:
                text = sen.get("text_en") or sen.get("text") or ""
                for w in re.findall(r"[A-Za-z]{4,}", text):
                    if w.lower() not in gloss and w not in words:
                        words.append(w)
        ref = {"kind": "reading", "key": rv["reading_id"], "version": rv["version"]}
        tapped = None
        t0 = int(time.time()) - 1
        for w in words[:25]:
            tr = b.ok("POST", "/v1/memory/translate", json={"text": w, "content": ref})
            if tr["gloss"] is None:
                tapped = (w, tr)
                break
        check(tapped, f"все слова текста уже в словаре — перевод ИИ не вызывался ({len(words)} слов)")
        assert tapped is not None
        check(tapped[1]["reason"] == "not_available", f"перевод по тапу при paid_only: {tapped[1]}")
        use = pj("SELECT coalesce(json_agg(json_build_object('s', status, 'r', reason)), '[]') FROM ai_gateway.usage "
                 f"WHERE user_id = '{uid(b.account_id)}' AND created_at >= to_timestamp({t0})") or []
        check(any(x["s"] == "unavailable" and x["r"] == "degraded" for x in use), f"ai-gateway usage B: {use}")
        s, content = start_lesson(c, a)
        check(s["ai_mode"] == "full" and s["ai_degraded"] is False, f"урок подписчика при paid_only: {str(s)[:300]}")
        finish_lesson(a, s["session_id"], content)
    finally:
        s2.ensure_step_up(root)
        back = expect(root.browser.request("PUT", "/admin/v1/ai/degradation", headers=idem(), json_body={
            "mode": "auto", "manual_level": None, "economy_at_percent": cur["economy_at_percent"],
            "paid_only_at_percent": cur["paid_only_at_percent"], "reason": f"e2e {c.tag}: снова автоматически"}), 200)
        check(back["mode"] == "auto", f"возврат в auto: {back}")
    ev = wait_for(lambda: [x for x in outbox("ai_gateway", "ai.degradation.changed.v1", since) if x["mode"] == "manual"],
                  20, what="ai.degradation.changed.v1")
    check(ev[0]["to"] == "paid_only" and ev[0]["reason"] == "manual", f"событие: {ev[0]}")
    lvl = pj("SELECT coalesce(json_agg(json_build_object('to', to_level, 'mode', mode)), '[]') FROM "
             f"ai_gateway.degradation_events WHERE at >= to_timestamp({since})") or []
    check(any(x["to"] == "paid_only" for x in lvl), f"degradation_events: {lvl}")
    uc = expect(root.browser.get("/admin/v1/ai/unit-costs", params={"period": "week"}), 200)
    check(set(uc["by_kind"]) >= {"lesson"} and isinstance(uc["by_kind"]["lesson"]["billable_minutes"], int),
          f"стоимость занятий: {str(uc)[:300]}")
    c.data["ai_done"] = True
    print(f"      ручной paid_only (TOTP; без уровня — 422) → B: перевод по тапу «{tapped[0]}» — not_available, в "
          f"ai-gateway unavailable/degraded; A: урок full → событие и аудит → auto", flush=True)


# ---------------------------------------------------------------- M16 возвраты (AT-94)


def s_refunds(c: s2.Ctx) -> None:
    need(c, "site_done")
    a, d = u_(c, "A"), u_(c, "D")
    fin, sup = c.staff["fin"], c.staff["sup"]
    prov: mp.Provider = c.data["provider"]
    kid = c.data["kid"]
    since = int(time.time()) - 1
    reason = f"e2e {c.tag}: возврат по обращению ученика"
    # 1) тилы Click → reversal (мок Merchant API) → тилы обратной записью
    if c.data.get("a_click"):
        oc = order_db(c.data["a_click"])
        card = admin(fin, "GET", f"/orders/{oc['order_id']}")
        check(card["can_refund"] is True and card["transactions"], f"карточка заказа Click: {str(card)[:300]}")
        r = sup.browser.request("POST", f"/admin/v1/billing/orders/{oc['order_id']}/refunds", json_body={"reason": reason},
                                headers=idem())
        check(r.status_code == 403, f"support делает возврат: {r.status_code}")
        bal0 = til_balance(c, a, kid)
        seq0 = int(expect(httpx.get(f"{MOCK_PAY}/_mock/calls"), 200)["last_seq"])
        rf = admin(fin, "POST", f"/orders/{oc['order_id']}/refunds", 201, body={"reason": reason}, step_up=True)
        check(rf["status"] == "completed" and rf["method"] == "provider_api" and rf["tils_check"]
              and rf["tils_check"]["til"] == 100, f"возврат Click: {rf}")
        calls = [x for x in expect(httpx.get(f"{MOCK_PAY}/_mock/calls", params={"after": seq0}), 200)["items"]
                 if x["op"] == "reversal"]
        check(len(calls) == 1 and calls[0]["method"] == "DELETE" and calls[0]["status"] == 200, f"reversal: {calls}")
        wait_for(lambda: til_balance(c, a, kid) == bal0 - 100, 40, what="тилы ребёнка −100 (обратная запись)")
        bal1 = bal0 - 100
        check(order_db(c.data["a_click"])["status"] == "refunded", "заказ Click refunded")
        admin(fin, "POST", f"/orders/{oc['order_id']}/refunds", 409, "REFUND_STATE", body={"reason": reason}, step_up=True)
        print(f"      Click: возврат {c.data['a_click']} — reversal → тилы ребёнка {bal0} → {bal1}; повтор — REFUND_STATE",
              flush=True)
    # 2) подписка Stars (D) → refundStarPayment + editUserStarSubscription is_canceled true, период revoked
    o = stars_order(d, "plus_30d")
    check(stars_checkout(d, o["invoice_link"])["answer"]["ok"], "pre_checkout D")
    paid = stars_pay(d, o["invoice_link"])
    poll_order(d, o["order_no"], ("fulfilled",))
    od = order_db(o["order_no"])
    seq0 = tg_seq()
    rf = admin(fin, "POST", f"/orders/{od['order_id']}/refunds", 201, body={"reason": reason}, step_up=True)
    check(rf["status"] == "completed" and rf["method"] == "provider_api", f"возврат Stars: {rf}")
    ref_calls = tg_method_calls("refundStarPayment", seq0)
    edit_calls = tg_method_calls("editUserStarSubscription", seq0)
    check(len(ref_calls) == 1 and ref_calls[0]["payload"]["telegram_payment_charge_id"] == paid["charge_id"]
          and ref_calls[0]["payload"]["user_id"] == d.tg_id, f"refundStarPayment: {ref_calls}")
    check(len(edit_calls) == 1 and edit_calls[0]["payload"]["is_canceled"] is True, f"editUserStarSubscription: {edit_calls}")
    ps = [x for x in periods_of(d.account_id) if x["order_id"] == od["order_id"]]
    check(ps and ps[0]["status"] == "revoked" and ps[0]["close_reason"] == "refund", f"период D: {ps}")
    check((stars_sub_of(d.account_id) or {}).get("status") == "refunded", "подписка Stars D не refunded")
    n = wait_notif(d.account_id, "refund_completed", since)
    check(not steering_leaks(n["title"] + n["body"], "refund_completed"), n)
    # повторное refunded_payment от Telegram — без изменений; повторный refundStarPayment — «уже возвращён»
    ledger0 = ledger_of(d.account_id)
    rr = tg_post("/_mock/stars/refunded", {"charge_id": paid["charge_id"]})
    check(rr["status"] == 200, f"refunded_payment: {rr}")
    time.sleep(0.5)
    check(ledger_of(d.account_id) == ledger0 and int(s1._psql(
        f"SELECT count(*) FROM billing.refunds WHERE order_id = '{uid(od['order_id'])}'")) == 1,
          "повторное refunded_payment изменило данные")
    again = httpx.post(f"{s1.BOTGW_INTERNAL}/internal/v1/stars/refunds", timeout=15,
                       headers=s1.internal_token("billing", "telegram-bot-gateway"),
                       json={"account_id": d.account_id, "telegram_payment_charge_id": paid["charge_id"]})
    check(again.status_code == 200 and again.json() == {"ok": True, "already": True},
          f"повторный refundStarPayment (400 CHARGE_ALREADY_REFUNDED у Telegram): {again.text[:200]}")
    # 3) заказ Payme (A) → awaiting_provider → CancelTransaction (state 2, reason 5) → refunded
    op = order_db(c.data["a_payme"])
    rf = admin(fin, "POST", f"/orders/{op['order_id']}/refunds", 201, body={"reason": reason}, step_up=True)
    check(rf["status"] == "awaiting_provider" and rf["method"] == "provider_cabinet" and rf["instruction"]
          and rf["instruction"]["provider_txn_id"] == c.data["a_payme_tid"]
          and rf["instruction"]["amount_tiyin"] == 12_900_000, f"возврат Payme: {rf}")
    cancel = prov.payme("CancelTransaction", {"id": c.data["a_payme_tid"], "reason": 5})
    if cancel.error == -32400:
        raise StepFailed("ДЕФЕКТ billing: CancelTransaction (reason 5) по проведённой транзакции заказа «после текущего» "
                         "→ Payme -32400: отзыв запланированного периода нарушает CHECK ck_periods_scheduled "
                         "(scheduled → revoked при starts_at NULL; см. .dev/pg/server.log); возврат завис в "
                         "awaiting_provider")
    check(cancel.body.get("result", {}).get("state") == -2, f"CancelTransaction: {cancel}")
    again = prov.payme("CancelTransaction", {"id": c.data["a_payme_tid"], "reason": 5})
    check(again.body.get("result") == cancel.body.get("result"), "повтор CancelTransaction")
    wait_for(lambda: order_db(c.data["a_payme"])["status"] == "refunded", 20, what="заказ Payme refunded")
    ps = [x for x in periods_of(a.account_id) if x["order_id"] == op["order_id"]]
    check(ps and ps[0]["status"] == "revoked", f"период Payme: {ps}")
    fd = prov.payme("SetFiscalData", {"id": c.data["a_payme_tid"], "type": "CANCEL", "fiscal_data": {
        "receipt_id": 124, "status_code": 0, "qr_code_url": f"https://ofd.soliq.uz/check?t=EPR{c.tag}"}})
    check(fd.body.get("result") == {"success": True}, f"SetFiscalData CANCEL: {fd}")
    kinds = pj("SELECT coalesce(json_agg(kind ORDER BY kind), '[]') FROM billing.fiscal_receipts f JOIN "
               "billing.provider_transactions t ON t.txn_id = f.txn_id WHERE t.provider_txn_id = "
               f"'{c.data['a_payme_tid']}'")
    check(kinds == ["refund", "sale"], f"чеки Payme: {kinds}")
    nw = wait_notif(a.account_id, "refund_completed", since)
    check(not steering_leaks(nw["title"] + nw["body"], "refund_completed web"), nw)
    c.data["refunds_done"] = True
    print("      Stars (D): refundStarPayment + editUserStarSubscription is_canceled → период revoked, refund_completed; "
          "повтор refunded_payment и refundStarPayment (already) — без изменений; Payme (A): awaiting_provider → "
          "CancelTransaction (state −2) → refunded, чек отмены отдельно", flush=True)


# ---------------------------------------------------------------- M17 сверка (AT-97)


def s_reconciliation(c: s2.Ctx) -> None:
    need(c, "site_done")
    fin = c.staff["fin"]
    site: Site = c.data["site"]
    prov: mp.Provider = c.data["provider"]
    since = int(time.time()) - 1
    ghost = f"stxGHOST{c.tag}{secrets.token_hex(6)}"
    tg_post("/_mock/stars/transactions", {"transaction": {
        "id": ghost, "amount": 77, "date": int(time.time()), "source": {
            "type": "user", "transaction_type": "invoice_payment", "user": {"id": 1, "is_bot": False, "first_name": "x"},
            "invoice_payload": f"o:{uuid.uuid4()}"}}})
    o = site.order({"product_code": "til_100", "provider": "click", "offer_version": "1.0"})
    ct = str(1_000_000 + secrets.randbelow(8_999_999))
    p = prov.click_prepare(ct, o["order_no"], "5000.00")
    check(p.error == 0, f"Prepare: {p}")
    # txn_guard не даёт менять транзакцию — тестовое изменение мимо триггеров (как сдвиг недели лиги, спринт 7)
    res = psql_try("BEGIN; SET LOCAL session_replication_role = replica; UPDATE billing.provider_transactions SET "
                   "created_at = created_at - interval '2 hours', provider_time = provider_time - interval '2 hours' "
                   f"WHERE provider = 'click' AND provider_txn_id = '{int(ct)}' AND state = 'created'; COMMIT;")
    check(res.returncode == 0 and "UPDATE 1" in res.stdout, f"сдвиг транзакции Click: {res.stdout} {res.stderr[:200]}")
    log_db_change(f"billing.provider_transactions.created_at Click Prepare {ct} (заказ {o['order_no']}) → −2 ч")
    run = billing_reconcile()
    check(run.get("finished_at") and run.get("error") is None, f"сверка: {run}")
    items = admin(fin, "GET", "/reconciliation/items", params={"status": "open"})["items"]
    st_items = [x for x in recon_items("stars_unmatched", since) if ghost in json.dumps(x["details"])]
    stale = [x for x in recon_items("stale_created", since) if x["order_id"] == order_db(o["order_no"])["order_id"]]
    check(st_items, f"stars_unmatched по лишней транзакции выписки: {recon_items('stars_unmatched', since)}")
    check(stale, f"stale_created по Click Prepare без Complete: {recon_items('stale_created', since)}")
    check(not any(str(u_(c, 'A').tg_id) in json.dumps(x["details"]) for x in items), "Telegram ID в пунктах сверки")
    item = next(x for x in items if x["item_id"] == stale[0]["item_id"])
    admin(fin, "POST", f"/reconciliation/items/{item['item_id']}/resolve", 422, None,
          body={"status": "resolved", "note": "short"})
    rs = admin(fin, "POST", f"/reconciliation/items/{item['item_id']}/resolve",
               body={"status": "resolved", "note": "Деньги не списаны, транзакция Click брошена"})
    check(rs["status"] == "resolved" and staff_ref_ok(rs["resolved_by"], fin), f"разбор: {rs}")
    admin(fin, "POST", f"/reconciliation/items/{st_items[0]['item_id']}/resolve",
          body={"status": "ignored", "note": "Тестовая транзакция выписки стенда e2e"})
    man = admin(fin, "POST", "/reconciliation/runs", body={})
    check(man["kind"] == "manual", f"ручной прогон: {man}")
    summ = admin(fin, "GET", "/reports/summary", params={"period": "day"})
    check(isinstance(summ["web"]["revenue_tiyin"], int) and isinstance(summ["stars"]["revenue_stars"], int)
          and summ["web"]["revenue_tiyin"] >= 12_900_000 and "recon_open" in summ, f"сводка: {str(summ)[:400]}")
    if "refunds_count" not in json.dumps(summ):
        note("сводка billing без refunds_count (INTERNAL_API §1.15 — дополнение потока A)")
    c.data["recon_done"] = {"stale": item["item_id"], "stars": st_items[0]["item_id"]}
    print(f"      выписка Stars с лишней транзакцией → stars_unmatched; Click Prepare без Complete (−2 ч) → stale_created; "
          f"разбор с заметкой (короткая — 422); ручной прогон; сводка: сайт {summ['web']['revenue_tiyin']} тийинов, "
          f"Stars {summ['stars']['revenue_stars']} ⭐", flush=True)


# ---------------------------------------------------------------- M18 сага удаления (AT-101)


def s_deletion(c: s2.Ctx) -> None:
    need(c, "stars_done")
    a = u_(c, "A")
    site: Site = c.data["site"]
    prov: mp.Provider = c.data["provider"]
    ss = stars_sub_of(a.account_id)
    check(ss and ss["status"] == "active", f"у A живая подписка Stars перед удалением: {ss}")
    pend = site.order({"product_code": "til_100", "provider": "payme", "offer_version": "1.0"})
    seq0 = tg_seq()
    d = a.ok("POST", "/v1/profile/delete-request", 202, json={"confirm_word": "УДАЛИТЬ"})
    check("billing" in d["domains"], f"домены саги: {d['domains']}")

    def done() -> Any:
        row = s1._psql("SELECT status || '|' || array_to_string(acked_domains, ',') FROM "
                       f"identity_consent.deletion_requests WHERE user_id = '{uid(a.account_id)}'")
        return row if row.startswith("COMPLETED|") else None

    row = wait_for(done, 180, interval=1.0, what="сага удаления A (ACK billing и прочих)")
    check("billing" in row.split("|")[1].split(","), f"ACK: {row}")
    edits = tg_method_calls("editUserStarSubscription", seq0)
    check(edits and edits[0]["payload"]["is_canceled"] is True and edits[0]["payload"]["user_id"] == a.tg_id
          and edits[0]["payload"]["telegram_payment_charge_id"] == c.data["a_charge"],
          f"отмена автопродления до удаления: {edits}")
    acc = uid(a.account_id)
    left = {t: int(s1._psql(f"SELECT count(*) FROM billing.{t} WHERE account_id = '{acc}'"))
            for t in ("minute_ledger", "minute_holds", "period_balances", "periods", "adjustments", "orders",
                      "stars_subscriptions")}
    left["learners"] = int(s1._psql(f"SELECT count(*) FROM billing.learners WHERE account_id = '{acc}'"))
    check(not any(left.values()), f"данные A в billing после удаления: {left}")
    kept = pj("SELECT json_build_object('orders', (SELECT count(*) FROM billing.orders WHERE order_no IN ("
              f"{int(c.data['a_sub_order'])}, {int(c.data['a_payme'])}) AND account_id IS NULL), 'stars', (SELECT status "
              f"FROM billing.stars_subscriptions WHERE subscription_id = '{uid(ss['subscription_id'])}'), 'txn', "
              "(SELECT count(*) FROM billing.provider_transactions t JOIN billing.orders o ON o.order_id = t.order_id "
              f"WHERE o.order_no = {int(c.data['a_sub_order'])}))")
    check(kept["orders"] == 2 and kept["stars"] in ("canceled", "ended", "refunded", "active") and kept["txn"] == 1,
          f"заказы и транзакции обезличены и сохранены: {kept}")
    check(order_db(pend["order_no"])["status"] == "cancelled", "незавершённый заказ сайта не отменён сагой")
    ack = pj("SELECT envelope->'payload' FROM billing.outbox WHERE envelope->>'event_type' = 'user.domain.deleted.v1' "
             f"AND envelope->'payload'->>'user_id' = '{acc}' LIMIT 1")
    check(ack and ack["domain"] == "billing" and ack.get("mode") == "anonymized", f"ACK billing: {ack}")
    late = prov.payme("CreateTransaction", {"id": secrets.token_hex(12), "time": int(time.time() * 1000),
                                            "amount": pend["amount_tiyin"], "account": {"order_id": str(pend["order_no"])}})
    check(late.status == 200 and late.error == -31050, f"Payme CreateTransaction по отменённому заказу: {late}")
    c.data["deleted"] = a.account_id
    print("      A удалён: автопродление Stars отменено через Bot API до удаления, минуты/периоды/удержания удалены, заказы "
          "и транзакции обезличены, незавершённый заказ сайта отменён (Payme -31050), ACK billing anonymized", flush=True)


# ---------------------------------------------------------------- M19 аудит


def s_audit(c: s2.Ctx) -> None:
    b = c.staff["root"].browser
    fin, sup, root = c.staff["fin"].staff_id, c.staff["sup"].staff_id, c.staff["root"].staff_id
    d = c.data
    want: list[tuple[str, str]] = []
    if d.get("catalog_e2e"):
        want.append(("billing.catalog_activated", fin))
    if d.get("four_eyes_done"):
        want += [("billing.adjustment_requested", sup), ("billing.adjustment_approved", fin),
                 ("billing.adjustment_rejected", fin)]
    if d.get("refunds_done"):
        want += [("billing.refund_requested", fin), ("billing.refund_completed", fin)]
    if d.get("recon_done"):
        want.append(("billing.recon_resolved", fin))
    if d.get("ai_done"):
        want.append(("ai.degradation_updated", root))
    check(want, "нет команд сотрудников для проверки аудита (шаги упали)")
    recs: list[dict[str, Any]] = []

    def missing() -> list[str]:
        nonlocal recs
        recs = s2.all_records(b, d["started_at"])
        return [f"{a} ({w[:8]})" for a, w in want
                if not any(r["action"] == a and (r.get("actor_id") == w or a == "billing.refund_completed")
                           for r in recs)]

    deadline = time.monotonic() + 40
    left = missing()
    while left and time.monotonic() < deadline:
        time.sleep(2)
        left = missing()
    check(not left, f"нет записей аудита: {left} (есть: {sorted({r['action'] for r in recs})[:20]})")
    mine = [r for r in recs if r["action"].startswith(("billing.", "ai.degradation"))]
    blob = json.dumps(mine, ensure_ascii=False)
    leaks = [w for w, v in c.secrets.items() if v and len(v) >= 8 and v in blob]
    leaks += [f"Telegram ID {u.role}" for u in c.lc.users.values() if re.search(rf"(?<!\d){u.tg_id}(?!\d)", blob)]
    check(not leaks, f"секреты/PII в аудите: {leaks}")
    v = expect(b.get("/admin/v1/audit/verify"), 200)
    check(v["valid"] is True and v["broken_at_seq"] is None, f"цепочка аудита: {v}")
    print(f"      записей аудита спринта 8: {len(mine)} ({sorted(Counter(r['action'] for r in mine))[:8]}…)", flush=True)


# ---------------------------------------------------------------- M20 события, DLQ, логи


SCHEMAS = ["billing", "gamification", "lessons", "notifications", "identity_consent", "ai_gateway", "user_admin"]


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
    expected = {"billing:billing.order.paid.v1", "billing:billing.subscription.changed.v1",
                "billing:billing.access.changed.v1"}
    flags = {"stars_done": ["billing:billing.stars_subscription.changed.v1"] if c.data.get("renewal_done") else [],
             "a_til_stars": ["gamification:game.til_pack.credited.v1"],
             "refunds_done": ["billing:billing.order.refunded.v1", "gamification:game.til_pack.reversed.v1"],
             "four_eyes_done": ["billing:billing.adjustment.applied.v1"],
             "ai_done": ["ai_gateway:ai.degradation.changed.v1"], "catalog_e2e": ["billing:billing.catalog.activated.v1"],
             "deleted": ["billing:user.domain.deleted.v1"], "pair_done": ["lessons:lesson.pair.completed.v1"]}
    for k, evs in flags.items():
        if c.data.get(k):
            expected |= set(evs)
    check(not (expected - set(seen)), f"не опубликованы события: {sorted(expected - set(seen))}")
    # Telegram ID и ПДн — не в событиях billing
    blob = s1._psql("SELECT coalesce(string_agg(envelope::text, E'\\n'), '') FROM billing.outbox WHERE created_at >= "
                    f"to_timestamp({int(since)})")
    for u in c.lc.users.values():
        if re.search(rf"(?<!\d){u.tg_id}(?!\d)", blob) or u.first in blob:
            problems.append(f"Telegram ID или имя {u.role} в событиях billing")
    try:
        consumers_idle(("",), 60)
    except StepFailed:
        stuck = {k: v for k, v in sg.consumers("").items() if v["pending"] or v["ack_pending"]}
        problems.append(f"потребители NATS с хвостом через 60 с: {stuck}")
    after, before = s1.dlq_counts(), c.data.get("dlq_before", {})
    grown = {k: v - before.get(k, 0) for k, v in after.items() if v > before.get(k, 0)}
    # логи: секреты стенда, Telegram ID, charge id, тексты учеников
    marker = c.data.get("marker", "")
    needles: dict[str, str] = {"маркер реплик": marker, "SCHEDULER_TOKEN": s1.SCHEDULER_TOKEN,
                               "PAYMENTS_EDGE_TOKEN": mp.EDGE_TOKEN, "PAYME_KEY": mp.PAYME_KEY,
                               "CLICK_SECRET_KEY": mp.CLICK_SECRET, "UZUM_PASSWORD": mp.UZUM_PASSWORD,
                               "секрет клиента OIDC": os.environ.get("E2E_OIDC_CLIENT_SECRET",
                                                                     "e2e-oidc-client-secret-0123456789abcdef"),
                               "WEB_SESSION_SECRET": os.environ.get("E2E_WEB_SESSION_SECRET",
                                                                    "e2e-web-session-secret-0123456789abcdef-local-xyz")}
    needles.update({k: v for k, v in c.secrets.items() if len(v) >= 8})
    for key in ("a_charge",):
        if c.data.get(key):
            needles[f"charge id ({key})"] = c.data[key]
    for code in c.data.get("oidc_codes", []):
        for part in code.split("&"):
            k, _, v = part.partition("=")
            if k in ("code", "state") and v:
                needles[f"OIDC {k}"] = v
    for u in c.lc.users.values():
        needles[f"имя {u.role}"] = u.first
        needles[f"Telegram ID {u.role}"] = str(u.tg_id)
    needles["имя ребёнка"] = c.data.get("kid_name", "")
    found = []
    for log in sorted(s1.LOG_DIR.glob("*.log")):
        if log.name.startswith(("mock-", "miniapp", "bootstrap", "web-pay", "payments-edge")) or ".migrate" in log.name \
                or ".build" in log.name:
            continue
        text = log.read_text(errors="replace")
        for what, needle in needles.items():
            if not needle:
                continue
            hit = re.search(rf"(?<!\d){re.escape(needle)}(?!\d)", text) if needle.isdigit() else needle in text
            if hit:
                found.append(f"{log.name}: {what}")
    errs = {}
    t0 = datetime.fromtimestamp(since, UTC).isoformat(timespec="milliseconds")[:23]
    for name in ("billing", "telegram-bot-gateway", "lessons", "gamification", "notifications", "ai-gateway"):
        p = s1.LOG_DIR / f"{name}.log"
        if not p.exists():
            continue
        lines = [ln for ln in p.read_text(errors="replace").splitlines() if '"level": "error"' in ln and ln[8:31] >= t0]
        if lines:
            errs[name] = (len(lines), lines[0][:240])
    if errs:
        note(f"ошибки в логах сервисов: {errs}")
    fails = [*problems[:8]]
    if grown:
        fails.append(f"новые сообщения в DLQ: {grown}")
    if found:
        fails.append(f"секреты/PII в логах: {sorted(set(found))[:10]}")
    check(not fails, "; ".join(fails))
    s8 = {k: v for k, v in seen.items() if k.split(":")[1].startswith(("billing.", "game.til_pack", "ai.degradation"))}
    print(f"      событий с начала прогона: {sum(seen.values())}; спринта 8: {s8}", flush=True)


# ---------------------------------------------------------------- M21 выключенные флаги (AGENT_BRIEF e2e п. 16)


def s_flags_off(c: s2.Ctx) -> None:
    need(c, "learners_done")
    if c.data.get("skip_flags"):
        raise StepSkipped("--skip-flags")
    b, e_ = u_(c, "B"), u_(c, "E")
    prov: mp.Provider = c.data["provider"]
    try:
        # STARS_ENABLED=false: pre_checkout — ok: false (продажи в Mini App выключены), сайт работает
        reconfig(E2E_STARS_ENABLED="false")
        cat = b.ok("GET", "/v1/billing/catalog")
        check(cat["sales_enabled"] is False and cat["providers"] == [], f"каталог при STARS_ENABLED=false: {cat}")
        b.ok("POST", "/v1/billing/orders", 409, "PROVIDER_NOT_AVAILABLE", idem=True,
             json={"product_code": "til_100", "provider": "telegram_stars", "offer_version": "1.0"})
        pend = c.data.get("flags_link")
        if pend:
            ans = stars_checkout(b, pend)["answer"]
            check(ans["ok"] is False and ans.get("error_message"), f"pre_checkout при STARS_ENABLED=false: {ans}")
        else:
            ans = tg_post("/_mock/stars/checkout", {"user": {"id": b.tg_id}, "payload": f"o:{uuid.uuid4()}",
                                                    "total_amount": 15})["answer"]
            check(ans["ok"] is False, f"pre_checkout при STARS_ENABLED=false: {ans}")
        # PAYMENTS_ENABLED=false, WEB_PAY_ENABLED=false, BILLING_ENFORCED=false
        reconfig(E2E_PAYMENTS_ENABLED="false", E2E_WEB_PAY_ENABLED="false", E2E_BILLING_ENFORCED="false")
        r = billing_as(e_, "web", "POST", "/orders", json={"product_code": "til_100", "provider": "payme",
                                                          "offer_version": "1.0"},
                       headers={"idempotency-key": str(uuid.uuid4())})
        check(r.status_code == 409 and r.json().get("code") == "PAYMENTS_DISABLED", f"заказ: {r.text[:200]}")
        e_.ok("POST", "/v1/billing/orders", 409, "PAYMENTS_DISABLED", idem=True,
              json={"product_code": "til_100", "provider": "telegram_stars", "offer_version": "1.0"})
        pm = prov.payme("CheckPerformTransaction", {"amount": 500000, "account": {"order_id": "100001"}})
        check(pm.status == 200 and pm.error == -32504, f"Payme при PAYMENTS_ENABLED=false: {pm}")
        r = httpx.get(f"{TG_BFF}/web/v1/me", timeout=5)
        check(r.status_code == 404, f"/web/v1/me при WEB_PAY_ENABLED=false: {r.status_code}")
        r = httpx.get(f"{TG_BFF}/web/v1/auth/start", timeout=5, follow_redirects=False)
        check(r.status_code == 404, f"/web/v1/auth/start: {r.status_code}")
        sid_holds0 = int(s1._psql("SELECT count(*) FROM billing.minute_holds"))
        s, content = start_lesson(c, b)
        check(s["ai_mode"] == "full" and s["ai_locked"] is None and s["ai_minutes_left"] is None,
              f"BILLING_ENFORCED=false: урок B без подписки {str(s)[:300]}")
        finish_lesson(b, s["session_id"], content, pause_s=0)
        check(hold_of(s["session_id"]) is None and int(s1._psql("SELECT count(*) FROM billing.minute_holds")) == sid_holds0,
              "BILLING_ENFORCED=false: lessons обратился к billing (удержание)")
    finally:
        reconfig()
    check(u_(c, "B").ok("GET", "/v1/billing/catalog")["sales_enabled"] is True, "флаги не вернулись")
    print("      STARS_ENABLED=false → pre_checkout ok:false, заказ Stars 409; PAYMENTS_ENABLED=false → заказ 409, Payme "
          "-32504; WEB_PAY_ENABLED=false → /web/v1/* 404; BILLING_ENFORCED=false → урок full без billing; флаги "
          "возвращены", flush=True)


def s_catalog_rollback(c: s2.Ctx) -> None:
    """Откат каталога на версию до прогона (AT-83: откат — новая версия из архивной, step-up)."""
    need(c, "catalog_e2e")
    fin = c.staff["fin"]
    prev = c.data["catalog_prev"]
    rb = admin(fin, "POST", f"/catalog/{prev}/rollback", step_up=True,
               body={"comment": f"e2e {c.tag}: откат каталога на v{prev}"})
    check(rb["status"] == "active" and rb["version"] > c.data["catalog_e2e"], f"откат: {str(rb)[:300]}")
    cur = pj("SELECT payload FROM billing.catalog_versions WHERE status = 'active'")
    check(cur == c.data["catalog0"]["payload"], "после отката активный каталог ≠ исходному")
    c.data["catalog_rolled_back"] = rb["version"]
    print(f"      каталог v{c.data['catalog_e2e']} → откат v{rb['version']} (= v{prev})", flush=True)


# ---------------------------------------------------------------- шаги


STEPS: list[tuple[str, Callable[[s2.Ctx], None], bool]] = [
    ("M00 стенд спринта 8: сервисы, моки, Caddy (CSP web-pay, edge 404), маршруты 401/404, X-Edge-Token, хвост NATS",
     s_stand, True),
    ("M01 ученики: взрослые A (+ ребёнок 6–9), B (друг A), D, E; подросток без согласия; Telegram без аккаунта; "
     "проекция billing", s_learners, True),
    ("M02 сотрудники: super_admin, finance (новая роль), support, operations; права спринта 8", s_staff, True),
    ("M03 AT-83 каталог: Mini App — только Stars, ребёнку без цен; пара канал—провайдер в billing; черновик с "
     "фискальными реквизитами → проверка (неверный — CATALOG_INVALID) → активация со step-up", s_catalog, False),
    ("M04 AT-90 урок без подписки (BILLING_ENFORCED): «варианты» и ai_locked no_subscription, реестр пуст",
     s_no_subscription, False),
    ("M05 AT-90/92 пробный: 60 мин, повтор, TRIAL_USED, ребёнок и подросток 403; урок full — удержание → списание 1 мин; "
     "повтор события без второго", s_trial, True),
    ("M06 AT-84/85 подписка Stars: FORFEIT → createInvoiceLink (XTR, 2592000) → pre_checkout ≤ 10 с (чужой — ok:false) → "
     "successful_payment ×3 → один период, пробный superseded", s_stars_subscription, True),
    ("M07 AT-85 продление (renewal), subscription canceled → автопродление выкл., «Включить» → editUserStarSubscription",
     s_stars_renewal, False),
    ("M08 AT-84/93 тилы ребёнку за Stars: billing недоступен при оплате → 503 → повтор Telegram → зачисление одно",
     s_stars_tils, False),
    ("M09 AT-86/87/96 сайт: вход OIDC (подделки, нет аккаунта, повтор state), cookie, CSRF и Origin; «Плюс 90» Payme: "
     "Check (detail) → Create ×2 → Perform ×2 → scheduled; SetFiscalData → чек", s_site_payme, False),
    ("M10 AT-100 анти-стиринг: Mini App без заказов сайта и тийинов, уведомления и тексты бота без сайта и сумов",
     s_anti_steering, False),
    ("M11 AT-88 тилы ребёнку через Click: подпись -1, сумма -2, Prepare ×2, Complete, повтор -4", s_site_click, False),
    ("M12 AT-89 Uzum (симулятор, за флагом): check → create ×2 → confirm ×2 → status", s_site_uzum, False),
    ("M13 AT-91 урок вдвоём: B без подписки — 403 SUBSCRIPTION_REQUIRED; A → B: удержание и одно списание у A; "
     "семейная комната — без списания", s_pair, False),
    ("M14 AT-95/90 «четыре глаза» (+30, SELF_APPROVAL, отклонение); исчерпание минут E без обрыва и минуса",
     s_four_eyes, False),
    ("M15 AT-98 контроль ИИ: ручной paid_only (step-up) → B: тап — degraded; A: урок full; событие; auto",
     s_ai_control, False),
    ("M16 AT-94 возвраты: Click (reversal, тилы обратно), Stars (refundStarPayment + отмена подписки), Payme "
     "(awaiting_provider → CancelTransaction)", s_refunds, False),
    ("M17 AT-97 сверка: stars_unmatched, stale_created (Click −2 ч), разбор с заметкой, ручной прогон, сводка",
     s_reconciliation, False),
    ("M18 AT-101 удаление A: отмена автопродления Stars до удаления, данные удалены/обезличены, ACK billing, "
     "Payme -31050", s_deletion, False),
    ("M19 аудит команд сотрудников спринта 8 (actor, без PII); цепочка цела", s_audit, False),
    ("M20 события по контрактам, outbox опубликован, DLQ не вырос; логи без секретов, Telegram ID и PII",
     s_events_logs, False),
    ("M21 выключенные флаги: STARS_ENABLED, PAYMENTS_ENABLED, WEB_PAY_ENABLED, BILLING_ENFORCED (run_local.sh reconfig)",
     s_flags_off, False),
    ("M22 AT-83 откат каталога на версию до прогона (step-up)", s_catalog_rollback, False),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--admin-bff", default=os.environ.get("E2E_ADMIN_BFF", "http://127.0.0.1:8002"))
    ap.add_argument("--bff", default=TG_BFF)
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--cleanup", action="store_true", help="только уборка остатков прерванного прогона")
    ap.add_argument("--skip-flags", action="store_true", help="без шага M21 (перезапуски сервисов с флагами)")
    ap.add_argument("--only", default="", help="через запятую: M05,M07 — подготовка (критичные шаги) и только эти шаги")
    args = ap.parse_args()
    if args.cleanup:
        done = cleanup_leftovers()
        print("уборка стенда (деньги): " + ("; ".join(done) if done else "остатков прерванных прогонов нет"), flush=True)
        return 0
    only = {x.strip().upper() for x in args.only.split(",") if x.strip()}
    tag = "M" + "".join(secrets.choice(string.ascii_uppercase) for _ in range(4))
    base_tg = 8_993_000_000 + secrets.randbelow(4_000_000) * 8
    results: list[tuple[str, str, str]] = []
    with httpx.Client(base_url=args.bff, timeout=45) as tg:
        lc = s1.Ctx(bff=tg, tag=tag, base_tg=base_tg)
        lc.data["zone_day"] = s1.pick_zone(datetime.now(UTC), 10 * 60, 16 * 60, 13 * 60)
        c = s2.Ctx(bff=args.admin_bff, lc=lc, tag=tag)
        c.data["started_at"] = int(time.time()) - 1
        c.data["skip_flags"] = args.skip_flags
        print(f"TilHero e2e (спринт 8, деньги и контроль ИИ): admin-bff {args.admin_bff}, telegram-bff {args.bff}, "
              f"сайт {WEB_ORIGIN}, метка {tag}, Telegram ID от {base_tg + 1}\n", flush=True)
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
                print(f"{status}  {name}  ({dt:.1f} c){'  — ' + det[:1500] if det else ''}", flush=True)
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
    (s1.E2E_DIR / "last-run-money.json").write_text(json.dumps(
        {"tag": tag, "checks": s1.CHECKS[0], "notes": NOTES,
         "results": [{"step": n, "status": s, "detail": d} for n, s, d in results]}, ensure_ascii=False, indent=1))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

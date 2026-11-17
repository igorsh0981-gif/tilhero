"""Спринт 8 (§6): notifications.ops_alerts — ops.alert.raised.v1 → bot-gateway /internal/v1/ops-messages.

Шаблоны ops.alert.<kind>.<state>, кнопка «Открыть мониторинг», dedup_key, ops_deliveries, skipped без повтора,
429 → повтор не раньше retry_after, предел попыток, PII нет в тексте."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from notif_testkit import api_error
from sqlalchemy import select

from tilhero_common.internal_auth import verify_token
from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms
from tilhero_notifications.models import OpsDelivery
from tilhero_notifications.ops_alerts import (
    OPS_TEMPLATES,
    OpsAlertRaised,
    monitoring_button,
    render_text,
    runbook_button,
)

OPENED = datetime(2026, 10, 15, 9, 12, tzinfo=UTC)
ADMIN_WEB = "https://admin.tilhero.test"

SAMPLES: dict[str, tuple[str, str, str, dict[str, Any]]] = {  # kind → (subject_type, subject, severity, params)
    "status": (
        "provider",
        "travelpayouts",
        "critical",
        {"status_from": "ok", "status_to": "down", "error_rate": 0.62, "p95_ms": 4100, "calls": 50,
         "by_class": {"timeout": 21, "server": 10}},
    ),
    "unstable": ("provider", "kudago", "warning", {"status_to": "degraded", "calls": 40}),
    "route_spike": (
        "provider",
        "travelpayouts",
        "warning",
        {"route_top": [{"location": "FRU", "count": 12}, {"location": "BSZ", "count": 7},
                       {"location": "_other", "count": 2}], "rl_60": 21, "base": 1.5},
    ),
    "dlq_growth": ("dlq", "notifications.requests", "warning", {"dlq_count": 3}),
    "lag": ("consumer", "offers.events", "warning", {"pending": 1500, "oldest_age_s": 1260}),
    # p95 и возраст бывают null (нет вызовов / нет неподтверждённых) — так их шлёт ops-monitor
    "outbox_stuck": ("outbox", "watch", "warning", {"pending": 12, "failing": 3, "max_attempts": 6,
                                                    "oldest_age_s": 900}),
    "feeds_problem": ("feeds", "news", "info", {"problem_feeds": 6}),
    # спринт 9 (INTERNAL_API §6.1)
    "service_down": ("service", "offers", "critical", {"down_s": 180}),
    "deletion_stuck": ("deletion", "all", "warning", {"stuck": 2, "open": 5, "oldest_open_at": "2026-10-14T09:00:00Z",
                                                      "pending_by_domain": {"watch": 2, "ai-control": 1}}),
    "rate_limit_spike": ("ratelimit", "tg.user", "warning", {"policy": "tg.user", "rejected": 340, "share": 0.27,
                                                            "subjects": 12}),
    "rate_limit_unavailable": ("ratelimit", "redis", "critical", {"failclosed": 41, "policies": 8}),
}


def alert_payload(kind: str = "status", state: str = "open", seq: int = 1, alert_id: uuid.UUID | None = None,
                  **over: Any) -> dict[str, Any]:
    subject_type, subject, severity, params = SAMPLES[kind]
    occurred = OPENED + (timedelta(minutes=42) if state == "resolved" else timedelta(hours=1))
    payload = {
        "alert_id": str(alert_id or uuid.uuid4()),
        "subject_type": subject_type,
        "subject": subject,
        "kind": kind,
        "severity": severity,
        "state": state,
        "state_seq": seq,
        "params": params if state != "resolved" else ({"status_from": "down", "status_to": "ok"}
                                                      if kind == "status" else {}),
        "opened_at": OPENED.isoformat().replace("+00:00", "Z"),
        "occurred_at": (OPENED if state == "open" else occurred).isoformat().replace("+00:00", "Z"),
    }
    payload.update(over)
    return payload


async def raise_alert(env, payload: dict[str, Any]):
    envelope = make_envelope("ops.alert.raised.v1", payload, producer="ops-monitor")
    assert_event_conforms(envelope)
    await env.bus.publish(envelope)
    return envelope


async def delivery(env, alert_id: str) -> list[OpsDelivery]:
    async with env.runtime.db.session() as s:
        return list((await s.execute(select(OpsDelivery).where(OpsDelivery.alert_id == uuid.UUID(alert_id)))).scalars())


def test_templates_cover_every_kind_and_state() -> None:
    kinds = ["status", "unstable", "route_spike", "dlq_growth", "lag", "outbox_stuck", "feeds_problem",
             "service_down", "deletion_stuck", "rate_limit_spike", "rate_limit_unavailable"]
    assert set(OPS_TEMPLATES) == {f"ops.alert.{k}.{s}" for k in kinds for s in ("open", "resolved", "reminder")}
    for kind in kinds:
        for state in ("open", "resolved", "reminder"):
            payload = alert_payload(kind, state)
            assert_event_conforms(make_envelope("ops.alert.raised.v1", payload, producer="ops-monitor"))
            text = render_text(OpsAlertRaised.model_validate(payload))
            assert 1 <= len(text) <= 3500 and "None" not in text and "<" not in text, (kind, state, text)


def test_template_texts() -> None:
    a = OpsAlertRaised.model_validate(alert_payload("status"))
    assert render_text(a) == (
        "🔴 Поставщик travelpayouts: недоступен (было: работает).\n"
        "Ошибок 62%, p95 4100 мс, вызовов 50.\n"
        "Классы ошибок: timeout 21, server 10."
    )
    r = OpsAlertRaised.model_validate(alert_payload("status", "resolved", seq=2))
    assert render_text(r) == "✅ Поставщик travelpayouts: снова работает.\nДлилось 42 мин."
    rem = OpsAlertRaised.model_validate(alert_payload("status", "reminder"))
    assert render_text(rem).startswith("🔁 Напоминание: Поставщик travelpayouts: недоступен")
    assert render_text(rem).endswith("Открыто 15.10 09:12 UTC.")
    spike = OpsAlertRaised.model_validate(alert_payload("route_spike"))
    assert render_text(spike) == (
        "🟠 Поставщик travelpayouts: всплеск ошибок «маршрут не поддерживается».\n"
        "Коды мест за час: FRU 12, BSZ 7, прочие 2.\n"
        "Ошибок за час: 21 (обычно 1.5 в час)."
    )
    lag = OpsAlertRaised.model_validate(alert_payload("lag"))
    assert render_text(lag) == (
        "🟠 Консьюмер offers.events: отставание обработки.\nОжидают обработки: 1500; самому старому 21 мин."
    )
    outbox = OpsAlertRaised.model_validate(alert_payload("outbox_stuck"))
    assert "Outbox сервиса watch: события не публикуются" in render_text(outbox)
    assert "Неопубликованных: 12; с ошибкой публикации 3; попыток до 6; самому старому 15 мин." in render_text(outbox)
    feeds = OpsAlertRaised.model_validate(alert_payload("feeds_problem"))
    assert render_text(feeds) == "🔵 Ленты новостей: проблемных лент — 6."
    assert monitoring_button(feeds, None) is None and monitoring_button(feeds, "http://localhost:5174") is None
    assert monitoring_button(feeds, ADMIN_WEB + "/") == {
        "text": "Открыть мониторинг", "url": f"{ADMIN_WEB}/#/monitoring/providers"
    }
    assert monitoring_button(lag, ADMIN_WEB)["url"] == f"{ADMIN_WEB}/#/monitoring/queues"
    # незнакомые поля params (новая версия ops-monitor) не роняют разбор
    assert OpsAlertRaised.model_validate(alert_payload("status", params={"status_to": "down", "future": 1}))


async def test_ops_alert_sent_once_per_state(env) -> None:
    env.settings.admin_web_url = ADMIN_WEB
    payload = alert_payload("status")
    await raise_alert(env, payload)
    [call] = env.gateway.ops_calls
    assert call == {
        "text": render_text(OpsAlertRaised.model_validate(payload)),
        "dedup_key": f"ops:{payload['alert_id']}:open:1",
        "button": {"text": "Открыть мониторинг", "url": f"{ADMIN_WEB}/#/monitoring/providers"},
    }
    principal = verify_token(env.gateway.headers[-1]["x-internal-token"], "t" * 40, audience="telegram-bot-gateway")
    assert principal.issuer == "notifications"
    [row] = await delivery(env, payload["alert_id"])
    assert (row.status, row.attempts, row.telegram_message_id) == ("sent", 1, 9001)
    assert row.template == "ops.alert.status.open"
    assert row.dedup_key == f"ops:{payload['alert_id']}:open:1" and row.sent_at is not None

    # другое событие с тем же переходом (повтор ops-monitor) — не отправляется второй раз
    await raise_alert(env, payload)
    assert len(env.gateway.ops_calls) == 1
    # как шлёт ops-monitor: напоминания и закрытие — тот же state_seq; каждое напоминание (другая минута) — отдельное
    # сообщение, повтор того же напоминания (тот же occurred_at) — нет
    aid = uuid.UUID(payload["alert_id"])
    first = alert_payload("status", "reminder", alert_id=aid, occurred_at="2026-10-15T10:12:00.123Z")
    await raise_alert(env, first)
    await raise_alert(env, first)
    await raise_alert(env, alert_payload("status", "reminder", alert_id=aid, occurred_at="2026-10-15T11:12:00Z"))
    await raise_alert(env, alert_payload("status", "resolved", alert_id=aid))
    assert [c["dedup_key"].split(":", 2)[2] for c in env.gateway.ops_calls] == [
        "open:1", "reminder:1:202610151012", "reminder:1:202610151112", "resolved:1"]
    assert len(await delivery(env, payload["alert_id"])) == 4
    assert env.gateway.calls == [] and env.bus.dlq == [] and env.bus.transient == []


async def test_ops_alert_without_admin_web_url_has_no_button(env) -> None:
    await raise_alert(env, alert_payload("dlq_growth"))
    [call] = env.gateway.ops_calls
    assert "button" not in call and call["text"].startswith("🟠 DLQ консьюмера notifications.requests")


async def test_ops_chat_not_configured_is_skipped_without_retry(env) -> None:
    env.gateway.ops_queue.append(api_error(409, "OPS_CHAT_NOT_CONFIGURED"))
    payload = alert_payload("lag")
    await raise_alert(env, payload)
    assert len(env.gateway.ops_calls) == 1
    [row] = await delivery(env, payload["alert_id"])
    assert (row.status, row.attempts, row.last_error) == ("skipped", 1, "OPS_CHAT_NOT_CONFIGURED")
    assert env.bus.dlq == [] and env.bus.transient == []


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (api_error(409, "OPS_CHAT_UNAVAILABLE"), "OPS_CHAT_UNAVAILABLE"),
        (api_error(422, "VALIDATION_ERROR"), "VALIDATION_ERROR"),
        (api_error(502, "TELEGRAM_ERROR", {"telegram_status": 400, "reason": "bad_request", "permanent": True}),
         "TELEGRAM_ERROR"),
    ],
)
async def test_ops_permanent_errors_fail_without_retry(env, response: httpx.Response, code: str) -> None:
    env.gateway.ops_queue.append(response)
    payload = alert_payload("outbox_stuck")
    await raise_alert(env, payload)
    assert len(env.gateway.ops_calls) == 1
    [row] = await delivery(env, payload["alert_id"])
    assert (row.status, row.attempts, row.last_error) == ("failed", 1, code)


async def test_ops_rate_limited_retries_with_retry_after(env, monkeypatch) -> None:
    seen: list[float | None] = []
    from tilhero_notifications import ops_alerts

    real = ops_alerts.TransientError

    def spy(*args, retry_after=None):
        seen.append(retry_after)
        return real(*args, retry_after=retry_after)

    monkeypatch.setattr(ops_alerts, "TransientError", spy)
    env.gateway.ops_queue.extend([
        api_error(429, "RATE_LIMITED", {"retry_after": 7}),
        api_error(429, "TELEGRAM_RATE_LIMITED", {"retry_after": 30}),
        httpx.ConnectError("down"),
        api_error(503, "UPSTREAM_UNAVAILABLE"),
    ])
    payload = alert_payload("route_spike")
    await raise_alert(env, payload)
    assert seen == [7.0, 30.0, None, None]
    assert len(env.gateway.ops_calls) == 5 and len({c["dedup_key"] for c in env.gateway.ops_calls}) == 1
    [row] = await delivery(env, payload["alert_id"])
    assert (row.status, row.attempts, row.last_error) == ("sent", 5, None)
    assert env.bus.dlq == [] and env.bus.transient == []


async def test_ops_attempts_exhausted(env) -> None:
    env.settings.ops_max_attempts = 3
    env.gateway.ops_queue.extend([api_error(502, "TELEGRAM_ERROR", {"permanent": False})] * 5)
    payload = alert_payload("unstable")
    await raise_alert(env, payload)
    assert len(env.gateway.ops_calls) == 3
    [row] = await delivery(env, payload["alert_id"])
    assert (row.status, row.attempts, row.last_error) == ("failed", 3, "TELEGRAM_ERROR")
    assert env.bus.dlq == [] and env.bus.transient == []


async def test_invalid_ops_alert_goes_to_dlq(env) -> None:
    bad = alert_payload("status")
    bad["subject"] = "иван@example.com"  # не идентификатор — так не бывает от ops-monitor
    await env.bus.publish(make_envelope("ops.alert.raised.v1", bad, producer="ops-monitor"))
    assert env.gateway.ops_calls == [] and [d for d, _ in env.bus.dlq] == ["notifications.ops_alerts"]


def test_null_metrics_from_ops_monitor() -> None:
    """ops-monitor шлёт p95_ms / oldest_age_s / pending = null, когда данных нет: текст без «None»."""
    a = alert_payload("status", params={"status_from": "ok", "status_to": "degraded", "error_rate": 0.12,
                                        "p95_ms": None, "by_class": {"rate_limit": 3}})
    assert_event_conforms(make_envelope("ops.alert.raised.v1", a, producer="ops-monitor"))
    text = render_text(OpsAlertRaised.model_validate(a))
    assert text == ("🔴 Поставщик travelpayouts: работает с ошибками (было: работает).\nОшибок 12%.\n"
                    "Классы ошибок: rate_limit 3.")
    lag = alert_payload("lag", params={"pending": 1200, "oldest_age_s": None})
    assert_event_conforms(make_envelope("ops.alert.raised.v1", lag, producer="ops-monitor"))
    assert render_text(OpsAlertRaised.model_validate(lag)).endswith("Ожидают обработки: 1200.")


# ---------------------------------------------------------------- спринт 9: новые виды и кнопка «Runbook»

RUNBOOKS = "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/"


def test_sprint9_texts_and_buttons() -> None:
    down = OpsAlertRaised.model_validate(alert_payload("service_down"))
    assert render_text(down) == "🔴 Сервис offers: не готов (/health/ready).\nНе готов уже 3 мин."
    assert monitoring_button(down, ADMIN_WEB)["url"] == f"{ADMIN_WEB}/#/monitoring/queues"
    # Q10: «NATS недоступен» — тот же вид service_down по субъекту nats, свой текст
    nats = OpsAlertRaised.model_validate(alert_payload("service_down", subject="nats", params={"down_s": 75}))
    assert render_text(nats) == ("🔴 NATS (шина событий): недоступна — события копятся в outbox сервисов.\n"
                                 "Недоступна уже 1 мин.")
    nats_ok = OpsAlertRaised.model_validate(alert_payload("service_down", "resolved", subject="nats"))
    assert render_text(nats_ok).startswith("✅ NATS (шина событий): снова доступна.")
    stuck = OpsAlertRaised.model_validate(alert_payload("deletion_stuck"))
    assert render_text(stuck) == (
        "🟠 Удаление профилей: зависло 2.\nОткрытых запросов удаления: 5.\n"
        "Не подтвердили домены: watch 2, ai-control 1.\nСамый старый запрос — с 14.10 09:00 UTC."
    )
    assert monitoring_button(stuck, ADMIN_WEB)["url"] == f"{ADMIN_WEB}/#/users/deletions"
    spike = OpsAlertRaised.model_validate(alert_payload("rate_limit_spike"))
    assert render_text(spike) == (
        "🟠 Лимит запросов tg.user: всплеск отказов «слишком много запросов».\n"
        "Отказов за 5 мин 340, доля 27%, субъектов 12."
    )
    assert monitoring_button(spike, ADMIN_WEB)["url"] == f"{ADMIN_WEB}/#/monitoring/limits"
    unavailable = OpsAlertRaised.model_validate(alert_payload("rate_limit_unavailable", "resolved"))
    assert render_text(unavailable).startswith("✅ Лимиты запросов: хранилище снова доступно.")
    # Runbook — только раздел runbook'ов репозитория
    with_rb = OpsAlertRaised.model_validate(alert_payload("service_down",
                                                          runbook_url=RUNBOOKS + "offers.md#service-down"))
    assert runbook_button(with_rb, RUNBOOKS) == {"text": "Runbook", "url": RUNBOOKS + "offers.md#service-down"}
    for bad in ("https://evil.example/docs/runbooks/offers.md", "https://github.com/other/repo/blob/main/x.md",
                "http://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/offers.md"):
        assert runbook_button(OpsAlertRaised.model_validate(alert_payload("lag", runbook_url=bad)), RUNBOOKS) is None
    assert runbook_button(OpsAlertRaised.model_validate(alert_payload("lag")), RUNBOOKS) is None  # до спринта 9


async def test_sprint9_alert_sent_with_runbook_button(env) -> None:
    env.settings.admin_web_url = ADMIN_WEB
    payload = alert_payload("deletion_stuck", runbook_url=RUNBOOKS + "identity-consent.md#deletion-stuck")
    await raise_alert(env, payload)
    [call] = env.gateway.ops_calls
    assert call["runbook_button"] == {"text": "Runbook", "url": RUNBOOKS + "identity-consent.md#deletion-stuck"}
    assert call["button"]["url"] == f"{ADMIN_WEB}/#/users/deletions"
    [row] = await delivery(env, payload["alert_id"])
    assert row.status == "sent" and env.bus.dlq == []


async def test_sprint9_old_bot_gateway_without_runbook_field(env) -> None:
    """Раскатка: bot-gateway до спринта 9 отвергает лишнее поле (422) — оповещение уходит без кнопки «Runbook»."""
    env.gateway.ops_queue.append(api_error(422, "VALIDATION_ERROR"))
    payload = alert_payload("service_down", runbook_url=RUNBOOKS + "offers.md#service-down")
    await raise_alert(env, payload)
    assert len(env.gateway.ops_calls) == 2
    assert "runbook_button" in env.gateway.ops_calls[0] and "runbook_button" not in env.gateway.ops_calls[1]
    [row] = await delivery(env, payload["alert_id"])
    assert row.status == "sent"


"""Оповещения операторам (спринт 8, docs/sprint8/INTERNAL_API.md §6).

Потребитель `notifications.ops_alerts` на `ops.alert.raised.v1` (издатель ops-monitor): шаблон
`ops.alert.<kind>.<state>` (русский, для сотрудников) → bot-gateway `POST /internal/v1/ops-messages` → чат операторов
(`OPS_ALERT_CHAT_ID` задаёт только bot-gateway). Тихих часов нет.

- `dedup_key` = `ops:<alert_id>:<state>:<state_seq>`; у напоминания ещё минута события
  (`ops:<alert_id>:reminder:<state_seq>:<YYYYMMDDHHMM occurred_at>`): ops-monitor шлёт напоминания с тем же
  `state_seq` раз в `OPS_ALERT_REPEAT_MINUTES` — каждое уходит, а повтор того же события (тот же `occurred_at`) — нет;
  журнал `ops_deliveries` (миграция 0004). Конечный статус
  (sent / skipped / failed) — повтор события ничего не отправляет; bot-gateway сам дедуплицирует по ключу 24 ч.
- 409 `OPS_CHAT_NOT_CONFIGURED` → skipped без повтора; 409 `OPS_CHAT_UNAVAILABLE` → failed (бот исключён из группы —
  нужен человек); 429 → повтор не раньше `retry_after`; 5xx/сеть → повтор с backoff шины; после
  `OPS_MAX_ATTEMPTS` попыток → failed. Отклонённый запрос (4xx) — failed без повтора.
- Текст — только из `params` (коды, числа) и `subject` (имя поставщика / консьюмера / сервиса): без PII.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.errors import TransientError
from tilhero_common.http_client import UpstreamError
from tilhero_common.links import runbook_url_allowed
from tilhero_common.messaging import Envelope
from tilhero_notifications.models import OpsDelivery

log = logging.getLogger("tilhero.notifications.ops")

OPS_ALERT_RAISED = "ops.alert.raised.v1"
OPS_MESSAGES_PATH = "/internal/v1/ops-messages"
BUTTON_TEXT = "Открыть мониторинг"
RUNBOOK_BUTTON_TEXT = "Runbook"
MAX_TEXT = 3500
PERMANENT_STATUSES = {400, 401, 403, 404, 413, 422}

Status = Literal["ok", "degraded", "down", "idle", "not_configured"]
Kind = Literal["status", "unstable", "route_spike", "dlq_growth", "lag", "outbox_stuck", "feeds_problem",
               # спринт 9 (INTERNAL_API §6.1)
               "service_down", "deletion_stuck", "rate_limit_spike", "rate_limit_unavailable"]
SubjectType = Literal["provider", "consumer", "outbox", "dlq", "feeds", "service", "deletion", "ratelimit"]
State = Literal["open", "resolved", "reminder"]
Count = Annotated[int, Field(ge=0)]


class RouteTop(BaseModel):
    model_config = ConfigDict(extra="ignore")

    location: Annotated[str, Field(pattern=r"^([A-Z]{3}|_other)$")]
    count: Count


class AlertParams(BaseModel):
    """params события (схема packages/contracts/events/ops.alert.raised.v1): коды и числа, без PII.
    Незнакомые поля игнорируются: новая версия ops-monitor не должна ронять доставку оповещений."""

    model_config = ConfigDict(extra="ignore")

    status_from: Status | None = None
    status_to: Status | None = None
    error_rate: Annotated[float, Field(ge=0, le=1)] | None = None
    p95_ms: Count | None = None
    calls: Count | None = None
    by_class: dict[Annotated[str, Field(pattern=r"^[a-z_]{1,32}$")], Count] | None = None
    route_top: Annotated[list[RouteTop], Field(max_length=5)] | None = None
    pending: Count | None = None
    dlq_count: Count | None = None
    problem_feeds: Count | None = None
    oldest_age_s: Count | None = None
    max_attempts: Count | None = None
    failing: Count | None = None
    rl_60: Count | None = None
    base: Annotated[float, Field(ge=0)] | None = None
    # спринт 9: service_down, deletion_stuck, rate_limit_spike, rate_limit_unavailable
    down_s: Count | None = None
    stuck: Count | None = None
    open: Count | None = None
    oldest_open_at: datetime | None = None
    pending_by_domain: dict[Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,40}$")], Count] | None = None
    policy: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$", max_length=64)] | None = None
    rejected: Count | None = None
    share: Annotated[float, Field(ge=0, le=1)] | None = None
    subjects: Count | None = None
    failclosed: Count | None = None
    policies: Count | None = None


class OpsAlertRaised(BaseModel):
    model_config = ConfigDict(extra="ignore")

    alert_id: uuid.UUID
    subject_type: SubjectType
    subject: Annotated[str, Field(pattern=r"^[A-Za-z0-9_.:\-]{1,120}$")]
    kind: Kind
    severity: Literal["critical", "warning", "info"]
    state: State
    state_seq: Annotated[int, Field(ge=1)]
    params: AlertParams
    opened_at: datetime
    occurred_at: datetime
    runbook_url: Annotated[str, Field(max_length=300)] | None = None  # спринт 9, необязательное

    @property
    def dedup_key(self) -> str:
        key = f"ops:{self.alert_id}:{self.state}:{self.state_seq}"
        if self.state == "reminder":  # напоминания одного перехода различаются минутой события
            key += ":" + self.occurred_at.astimezone(UTC).strftime("%Y%m%d%H%M")
        return key

    @property
    def template(self) -> str:
        return f"ops.alert.{self.kind}.{self.state}"


# ---------- шаблоны ----------

STATUS_RU = {
    "ok": "работает",
    "degraded": "работает с ошибками",
    "down": "недоступен",
    "idle": "нет вызовов",
    "not_configured": "не настроен",
}
SEVERITY_ICON = {"critical": "🔴", "warning": "🟠", "info": "🔵"}
SUBJECT_LABEL = {
    "provider": "Поставщик",
    "consumer": "Консьюмер",
    "outbox": "Outbox сервиса",
    "dlq": "DLQ консьюмера",
    "feeds": "Ленты новостей",
    "service": "Сервис",
    "deletion": "Удаление профилей",
    "ratelimit": "Лимит запросов",
}
# Раздел admin-web (hash-маршрутизация): мониторинг — #/monitoring/<вкладка>; спринт 9 (пакет Q4): «Лимиты» —
# #/monitoring/limits, «Пользователи → Удаления» — #/users/deletions
MONITORING_ROUTE = {
    "provider": "monitoring/providers",
    "feeds": "monitoring/providers",
    "consumer": "monitoring/queues",
    "outbox": "monitoring/queues",
    "dlq": "monitoring/queues",
    "service": "monitoring/queues",
    "ratelimit": "monitoring/limits",
    "deletion": "users/deletions",
}


def _cap(text: str) -> str:
    return text[:1].upper() + text[1:]


def _age(seconds: int | None) -> str | None:
    if seconds is None:
        return None
    minutes = seconds // 60
    if minutes < 1:
        return "меньше минуты"
    if minutes < 60:
        return f"{minutes} мин"
    hours, rest = divmod(minutes, 60)
    return f"{hours} ч {rest} мин" if rest else f"{hours} ч"


def _who(a: OpsAlertRaised) -> str:
    if a.subject_type in ("feeds", "deletion"):
        return SUBJECT_LABEL[a.subject_type]
    return f"{SUBJECT_LABEL[a.subject_type]} {a.subject}"


def _metrics(p: AlertParams) -> list[str]:
    parts = []
    if p.error_rate is not None:
        parts.append(f"ошибок {round(p.error_rate * 100)}%")
    if p.p95_ms is not None:
        parts.append(f"p95 {p.p95_ms} мс")
    if p.calls is not None:
        parts.append(f"вызовов {p.calls}")
    lines = [_cap(", ".join(parts)) + "."] if parts else []
    if p.by_class:
        top = sorted(p.by_class.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
        lines.append("Классы ошибок: " + ", ".join(f"{name} {count}" for name, count in top) + ".")
    return lines


def _status_open(a: OpsAlertRaised) -> tuple[str, list[str]]:
    p = a.params
    head = f"{_who(a)}: {STATUS_RU.get(p.status_to or 'down', p.status_to or '')}"
    if p.status_from:
        head += f" (было: {STATUS_RU[p.status_from]})"
    return head, _metrics(p)


def _status_resolved(a: OpsAlertRaised) -> tuple[str, list[str]]:
    to = a.params.status_to or "ok"
    return (f"{_who(a)}: снова работает" if to == "ok" else f"{_who(a)}: {STATUS_RU[to]}"), _metrics(a.params)


def _unstable_open(a: OpsAlertRaised) -> tuple[str, list[str]]:
    return f"{_who(a)}: нестабилен — статус часто меняется", _metrics(a.params)


def _unstable_resolved(a: OpsAlertRaised) -> tuple[str, list[str]]:
    return f"{_who(a)}: работа стабилизировалась", []


def _route_open(a: OpsAlertRaised) -> tuple[str, list[str]]:
    lines = []
    if a.params.route_top:
        codes = ", ".join(
            f"{'прочие' if r.location == '_other' else r.location} {r.count}" for r in a.params.route_top
        )
        lines.append(f"Коды мест за час: {codes}.")
    if a.params.rl_60 is not None:
        usual = f" (обычно {a.params.base:g} в час)" if a.params.base is not None else ""
        lines.append(f"Ошибок за час: {a.params.rl_60}{usual}.")
    return f"{_who(a)}: всплеск ошибок «маршрут не поддерживается»", lines


def _route_resolved(a: OpsAlertRaised) -> tuple[str, list[str]]:
    return f"{_who(a)}: всплеск «маршрут не поддерживается» закончился", []


def _dlq_open(a: OpsAlertRaised) -> tuple[str, list[str]]:
    lines = [f"Сообщений в DLQ: {a.params.dlq_count}."] if a.params.dlq_count is not None else []
    return f"{_who(a)}: новые сообщения в DLQ", lines


def _dlq_resolved(a: OpsAlertRaised) -> tuple[str, list[str]]:
    return f"{_who(a)}: DLQ больше не растёт", []


def _backlog(p: AlertParams, pending_label: str) -> list[str]:
    parts = []
    if p.pending is not None:
        parts.append(f"{pending_label}: {p.pending}")
    if p.failing is not None:
        parts.append(f"с ошибкой публикации {p.failing}")
    if p.max_attempts is not None:
        parts.append(f"попыток до {p.max_attempts}")
    if (age := _age(p.oldest_age_s)) is not None:
        parts.append(f"самому старому {age}")
    return [_cap("; ".join(parts)) + "."] if parts else []


def _lag_open(a: OpsAlertRaised) -> tuple[str, list[str]]:
    return f"{_who(a)}: отставание обработки", _backlog(a.params, "ожидают обработки")


def _lag_resolved(a: OpsAlertRaised) -> tuple[str, list[str]]:
    return f"{_who(a)}: отставание устранено", []


def _outbox_open(a: OpsAlertRaised) -> tuple[str, list[str]]:
    return f"{_who(a)}: события не публикуются", _backlog(a.params, "неопубликованных")


def _outbox_resolved(a: OpsAlertRaised) -> tuple[str, list[str]]:
    return f"{_who(a)}: публикация событий восстановлена", []


def _feeds_open(a: OpsAlertRaised) -> tuple[str, list[str]]:
    count = a.params.problem_feeds
    return f"{_who(a)}: проблемных лент — {count if count is not None else 'несколько'}", []


def _feeds_resolved(a: OpsAlertRaised) -> tuple[str, list[str]]:
    return f"{_who(a)}: проблемы с лентами устранены", []


NATS_SUBJECT = "nats"  # спринт 9 (Q10): ops-monitor не достаёт JetStream API — шина событий недоступна


def _service_open(a: OpsAlertRaised) -> tuple[str, list[str]]:
    took = _age(a.params.down_s)
    if a.subject == NATS_SUBJECT:
        return ("NATS (шина событий): недоступна — события копятся в outbox сервисов",
                [f"Недоступна уже {took}."] if took else [])
    return f"{_who(a)}: не готов (/health/ready)", [f"Не готов уже {took}."] if took else []


def _service_resolved(a: OpsAlertRaised) -> tuple[str, list[str]]:
    if a.subject == NATS_SUBJECT:
        return "NATS (шина событий): снова доступна", []
    return f"{_who(a)}: снова готов", []


def _deletion_open(a: OpsAlertRaised) -> tuple[str, list[str]]:
    p = a.params
    head = f"{_who(a)}: зависло {p.stuck if p.stuck is not None else 'несколько'}"
    lines = []
    if p.open is not None:
        lines.append(f"Открытых запросов удаления: {p.open}.")
    if p.pending_by_domain:
        top = sorted(p.pending_by_domain.items(), key=lambda kv: (-kv[1], kv[0]))[:9]
        lines.append("Не подтвердили домены: " + ", ".join(f"{d} {n}" for d, n in top) + ".")
    if p.oldest_open_at is not None:
        lines.append(f"Самый старый запрос — с {_hhmm(p.oldest_open_at)}.")
    return head, lines


def _deletion_resolved(a: OpsAlertRaised) -> tuple[str, list[str]]:
    return f"{_who(a)}: зависших удалений нет", []


def _spike_open(a: OpsAlertRaised) -> tuple[str, list[str]]:
    p = a.params
    parts = []
    if p.rejected is not None:
        parts.append(f"отказов за 5 мин {p.rejected}")
    if p.share is not None:
        parts.append(f"доля {round(p.share * 100)}%")
    if p.subjects is not None:
        parts.append(f"субъектов {p.subjects}")
    return f"{_who(a)}: всплеск отказов «слишком много запросов»", [_cap(", ".join(parts)) + "."] if parts else []


def _spike_resolved(a: OpsAlertRaised) -> tuple[str, list[str]]:
    return f"{_who(a)}: всплеск отказов закончился", []


def _rl_unavailable_open(a: OpsAlertRaised) -> tuple[str, list[str]]:
    p = a.params
    lines = []
    if p.failclosed is not None:
        lines.append(f"Отклонено из-за недоступности: {p.failclosed}.")
    if p.policies is not None:
        lines.append(f"Затронуто политик (вход, PIN, команды сотрудников): {p.policies}.")
    return "Лимиты запросов: хранилище (Redis) недоступно — вход и команды отклоняются", lines


def _rl_unavailable_resolved(a: OpsAlertRaised) -> tuple[str, list[str]]:
    return "Лимиты запросов: хранилище снова доступно", []


Part = Callable[[OpsAlertRaised], tuple[str, list[str]]]
_PARTS: dict[str, tuple[Part, Part]] = {  # kind → (открыто / напоминание, закрыто)
    "status": (_status_open, _status_resolved),
    "unstable": (_unstable_open, _unstable_resolved),
    "route_spike": (_route_open, _route_resolved),
    "dlq_growth": (_dlq_open, _dlq_resolved),
    "lag": (_lag_open, _lag_resolved),
    "outbox_stuck": (_outbox_open, _outbox_resolved),
    "feeds_problem": (_feeds_open, _feeds_resolved),
    "service_down": (_service_open, _service_resolved),
    "deletion_stuck": (_deletion_open, _deletion_resolved),
    "rate_limit_spike": (_spike_open, _spike_resolved),
    "rate_limit_unavailable": (_rl_unavailable_open, _rl_unavailable_resolved),
}


def _hhmm(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%d.%m %H:%M UTC")


def _open_template(part: Part) -> Callable[[OpsAlertRaised], str]:
    def render(a: OpsAlertRaised) -> str:
        head, lines = part(a)
        return "\n".join([f"{SEVERITY_ICON[a.severity]} {head}.", *lines])

    return render


def _reminder_template(part: Part) -> Callable[[OpsAlertRaised], str]:
    def render(a: OpsAlertRaised) -> str:
        head, lines = part(a)
        return "\n".join([f"🔁 Напоминание: {head}.", *lines, f"Открыто {_hhmm(a.opened_at)}."])

    return render


def _resolved_template(part: Part) -> Callable[[OpsAlertRaised], str]:
    def render(a: OpsAlertRaised) -> str:
        head, lines = part(a)
        took = _age(max(int((a.occurred_at - a.opened_at).total_seconds()), 0))
        return "\n".join([f"✅ {head}.", *lines, f"Длилось {took}."])

    return render


# ops.alert.<kind>.<state> → текст (обычный, без разметки: bot-gateway шлёт без parse_mode)
OPS_TEMPLATES: dict[str, Callable[[OpsAlertRaised], str]] = {}
for _kind, (_open, _resolved) in _PARTS.items():
    OPS_TEMPLATES[f"ops.alert.{_kind}.open"] = _open_template(_open)
    OPS_TEMPLATES[f"ops.alert.{_kind}.reminder"] = _reminder_template(_open)
    OPS_TEMPLATES[f"ops.alert.{_kind}.resolved"] = _resolved_template(_resolved)


def render_text(alert: OpsAlertRaised) -> str:
    text = OPS_TEMPLATES[alert.template](alert)
    return text if len(text) <= MAX_TEXT else text[: MAX_TEXT - 1] + "…"


def monitoring_button(alert: OpsAlertRaised, admin_web_url: str | None) -> dict[str, str] | None:
    """Кнопка «Открыть мониторинг» → ADMIN_WEB_URL/#/<раздел>; без https-адреса — без кнопки."""
    if not admin_web_url or not admin_web_url.startswith("https://"):
        return None
    return {"text": BUTTON_TEXT, "url": f"{admin_web_url.rstrip('/')}/#/{MONITORING_ROUTE[alert.subject_type]}"}


def runbook_button(alert: OpsAlertRaised, base_url: str | None) -> dict[str, str] | None:
    """Кнопка «Runbook» (спринт 9, §6.2) — только ссылка в разделе runbook'ов репозитория (`RUNBOOK_BASE_URL`, https);
    чужой адрес или его отсутствие — без кнопки."""
    url = alert.runbook_url
    # SEC9-06: разбор URL, а не префикс строки (`..`, `%2e`, обратные слеши не уводят за пределы раздела)
    if not url or not runbook_url_allowed(url, base_url):
        return None
    return {"text": RUNBOOK_BUTTON_TEXT, "url": url}


# ---------- доставка ----------


async def _record(
    session: AsyncSession,
    alert: OpsAlertRaised,
    env: Envelope,
    *,
    status: str,
    attempts: int,
    error: str | None = None,
    message_id: int | None = None,
) -> None:
    now = datetime.now(UTC)
    values: dict[str, Any] = {
        "status": status,
        "attempts": attempts,
        "last_error": error,
        "telegram_message_id": message_id,
        "updated_at": now,
        "sent_at": now if status == "sent" else None,
    }
    stmt = insert(OpsDelivery).values(
        delivery_id=uuid.uuid4(),
        dedup_key=alert.dedup_key,
        alert_id=alert.alert_id,
        template=alert.template,
        source_event_id=env.event_id,
        created_at=now,
        **values,
    )
    await session.execute(stmt.on_conflict_do_update(index_elements=[OpsDelivery.dedup_key], set_=values))


def build_ops_handler(runtime: Runtime) -> Callable[[AsyncSession, Envelope], Any]:
    async def on_ops_alert(session: AsyncSession, env: Envelope) -> None:
        alert = OpsAlertRaised.model_validate(env.payload)
        settings = runtime.settings
        row = (
            await session.execute(
                select(OpsDelivery.status, OpsDelivery.attempts).where(OpsDelivery.dedup_key == alert.dedup_key)
            )
        ).first()
        if row is not None and row.status != "pending":
            log.info("duplicate ops alert suppressed", extra={"template": alert.template, "status": row.status})
            return
        attempts = (row.attempts if row is not None else 0) + 1
        body: dict[str, Any] = {"text": render_text(alert), "dedup_key": alert.dedup_key}
        button = monitoring_button(alert, getattr(settings, "admin_web_url", None))
        if button is not None:
            body["button"] = button
        runbook = runbook_button(alert, getattr(settings, "runbook_base_url", None))
        if runbook is not None:
            body["runbook_button"] = runbook

        retry_after: float | None = None
        try:
            try:
                result = await runtime.client("telegram-bot-gateway").post(OPS_MESSAGES_PATH, json=body)
            except UpstreamError as exc:
                # bot-gateway до спринта 9 (раскатка): лишнее поле runbook_button → 422 — отправляем без него
                if exc.status != 422 or "runbook_button" not in body:
                    raise
                body.pop("runbook_button")
                result = await runtime.client("telegram-bot-gateway").post(OPS_MESSAGES_PATH, json=body)
        except UpstreamError as exc:
            details = exc.details or {}
            if exc.code == "OPS_CHAT_NOT_CONFIGURED":
                log.info("ops alert skipped: chat not configured", extra={"template": alert.template})
                await _record(session, alert, env, status="skipped", attempts=attempts, error=exc.code)
                return
            if exc.code == "OPS_CHAT_UNAVAILABLE":
                log.warning("ops alert failed: chat unavailable", extra={"template": alert.template})
                await _record(session, alert, env, status="failed", attempts=attempts, error=exc.code)
                return
            if exc.code == "IDEMPOTENCY_IN_PROGRESS":
                error, retry_after = exc.code, 30.0  # предыдущая попытка ещё отправляется
            elif exc.status == 429:
                error, retry_after = exc.code, float(details.get("retry_after") or 60)
            elif (exc.code == "TELEGRAM_ERROR" and details.get("permanent")) or exc.status in PERMANENT_STATUSES:
                log.error(
                    "ops alert rejected",
                    extra={"template": alert.template, "status": exc.status, "error_code": exc.code},
                )
                await _record(session, alert, env, status="failed", attempts=attempts, error=exc.code[:64])
                return
            else:
                error = exc.code[:64]
        except Exception as exc:
            error = "GATEWAY_UNAVAILABLE"
            log.warning("bot gateway call failed", extra={"error_type": type(exc).__name__})
        else:
            await _record(
                session, alert, env, status="sent", attempts=attempts, message_id=int(result["message_id"])
            )
            log.info("ops alert sent", extra={"template": alert.template, "attempts": attempts})
            return

        max_attempts = int(getattr(settings, "ops_max_attempts", 20))
        if attempts >= max_attempts:
            log.error("ops alert failed: attempts exhausted", extra={"template": alert.template, "error_code": error})
            await _record(session, alert, env, status="failed", attempts=attempts, error=error)
            return
        # Счётчик попыток — отдельной транзакцией: транзакция inbox откатывается, событие придёт снова
        assert runtime.db is not None
        async with runtime.db.session() as own:
            await _record(own, alert, env, status="pending", attempts=attempts, error=error)
        log.warning(
            "ops alert delivery will retry",
            extra={"template": alert.template, "error_code": error, "attempts": attempts},
        )
        raise TransientError(error, retry_after=retry_after)

    return on_ops_alert

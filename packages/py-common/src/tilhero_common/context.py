"""Контекст запроса/события: trace_id, correlation_id, causation_id, псевдонимный user id.

Значения живут в contextvars и автоматически попадают в логи, исходящие HTTP-вызовы и конверты событий.
"""

from __future__ import annotations

import hashlib
import uuid
from contextvars import ContextVar
from dataclasses import dataclass

trace_id_var: ContextVar[str | None] = ContextVar("trace_id", default=None)
correlation_id_var: ContextVar[str | None] = ContextVar("correlation_id", default=None)
causation_id_var: ContextVar[str | None] = ContextVar("causation_id", default=None)
user_pid_var: ContextVar[str | None] = ContextVar("user_pid", default=None)

TRACE_HEADER = "x-trace-id"
CORRELATION_HEADER = "x-correlation-id"
CAUSATION_HEADER = "x-causation-id"


def new_id() -> str:
    return uuid.uuid4().hex


def get_trace_id() -> str:
    value = trace_id_var.get()
    if value is None:
        value = new_id()
        trace_id_var.set(value)
    return value


def get_correlation_id() -> str:
    value = correlation_id_var.get()
    if value is None:
        value = get_trace_id()
        correlation_id_var.set(value)
    return value


def pseudonymize(user_id: str | None) -> str | None:
    """Псевдонимный ID для логов и телеметрии (ТЗ: user pseudonymous ID)."""
    if not user_id:
        return None
    return "u_" + hashlib.sha256(str(user_id).encode()).hexdigest()[:12]


@dataclass(frozen=True)
class ContextSnapshot:
    trace_id: str | None
    correlation_id: str | None
    causation_id: str | None
    user_pid: str | None


def snapshot() -> ContextSnapshot:
    return ContextSnapshot(trace_id_var.get(), correlation_id_var.get(), causation_id_var.get(), user_pid_var.get())


def bind(
    *,
    trace_id: str | None = None,
    correlation_id: str | None = None,
    causation_id: str | None = None,
    user_id: str | None = None,
) -> None:
    trace_id_var.set(trace_id or new_id())
    correlation_id_var.set(correlation_id or trace_id_var.get())
    causation_id_var.set(causation_id)
    if user_id is not None:
        user_pid_var.set(pseudonymize(user_id))


def outgoing_headers() -> dict[str, str]:
    headers = {TRACE_HEADER: get_trace_id(), CORRELATION_HEADER: get_correlation_id()}
    causation = causation_id_var.get()
    if causation:
        headers[CAUSATION_HEADER] = causation
    return headers

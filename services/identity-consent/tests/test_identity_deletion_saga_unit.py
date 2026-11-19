"""Юнит-тесты чистых правил саги удаления (deletion/saga.py) и переменных DELETION_*."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from conftest import make_settings
from pydantic import ValidationError

from tilhero_identity.deletion import saga

T0 = datetime(2026, 10, 16, 9, 0, tzinfo=UTC)
DEFAULT = (15, 60, 240, 720, 1440)


def m(minutes: float) -> datetime:
    return T0 + timedelta(minutes=minutes)


# ---------------------------------------------------------------- расписание

def test_parse_schedule() -> None:
    assert saga.parse_schedule("15,60,240,720,1440") == DEFAULT
    assert saga.parse_schedule(" 5 , 10,") == (5, 10)
    assert saga.parse_schedule([1, 2]) == (1, 2)
    for bad in ("", ",", "15,x", "0,15", "-5", "60,15", "15,15", "1,10081", "1.5"):
        with pytest.raises(ValueError):
            saga.parse_schedule(bad)


def test_settings_defaults_and_env(monkeypatch: pytest.MonkeyPatch) -> None:
    s = make_settings("x")
    assert s.deletion_retry_schedule == DEFAULT and s.deletion_stuck_hours == 24
    assert s.deletion_domains == ["learning-plan", "social", "notifications", "support", "experience-config", "catalog",
                                  "diagnostics", "lessons", "assessment", "ai-gateway"]
    monkeypatch.setenv("DELETION_RETRY_SCHEDULE_MINUTES", "1, 2,3")
    monkeypatch.setenv("DELETION_STUCK_HOURS", "0.5")
    monkeypatch.setenv("DELETION_SWEEP_SECONDS", "5")
    monkeypatch.setenv("DELETION_DOMAINS", '["learning-plan","memory"]')
    from tilhero_identity.settings import Settings

    env = Settings(env="test", internal_jwt_secret="y" * 40)
    assert env.deletion_retry_schedule == (1, 2, 3) and env.deletion_retry_schedule_minutes == "1,2,3"
    assert (env.deletion_stuck_hours, env.deletion_sweep_seconds) == (0.5, 5)
    assert env.deletion_domains == ["learning-plan", "memory"]
    for name, value in (("DELETION_RETRY_SCHEDULE_MINUTES", "60,15"), ("DELETION_STUCK_HOURS", "0"),
                        ("DELETION_SWEEP_SECONDS", "-1")):
        monkeypatch.setenv(name, value)
        with pytest.raises(ValidationError):
            Settings(env="test", internal_jwt_secret="y" * 40)
        monkeypatch.delenv(name)


def test_retry_offsets_follow_schedule_then_daily() -> None:
    assert [saga.retry_offset(k, DEFAULT) for k in range(1, 8)] == [
        timedelta(minutes=x) for x in (15, 60, 240, 720, 1440, 2880, 4320)]
    with pytest.raises(ValueError):
        saga.retry_offset(0, DEFAULT)


@pytest.mark.parametrize(("sent", "expected"), [
    (0, 15),            # первичная рассылка → первый повтор через 15 мин
    (15, 60),           # повтор по расписанию → следующая точка
    (16, 60),           # таймер опоздал на минуту — расписание не сдвигается
    (20, 60),           # ручной повтор между точками — без «догоняющего» повтора сразу за ним
    (60, 240), (240, 720), (720, 1440),
    (1440, 2880),       # после расписания — раз в сутки
    (1441, 2880),
    (2880, 4320),
    (5000, 5760),       # простой таймера на сутки: один повтор, следующая точка — ближайшая будущая
])
def test_next_retry_at(sent: float, expected: float) -> None:
    assert saga.next_retry_at(T0, m(sent), DEFAULT) == m(expected)


def test_next_retry_is_always_in_future_of_send() -> None:
    for sent in range(0, 10_000, 7):
        nxt = saga.next_retry_at(T0, m(sent), DEFAULT)
        assert nxt > m(sent) and nxt - m(sent) <= timedelta(minutes=1440)


# ---------------------------------------------------------------- переходы

def test_stuck_due_only_for_requested_after_deadline() -> None:
    assert saga.stuck_due("REQUESTED", T0, m(24 * 60), 24) is True
    assert saga.stuck_due("REQUESTED", T0, m(24 * 60 - 1), 24) is False
    assert saga.stuck_due("STUCK", T0, m(48 * 60), 24) is False  # уже STUCK — второго перехода нет
    assert saga.stuck_due("COMPLETED", T0, m(48 * 60), 24) is False
    assert saga.stuck_deadline(T0, 0.5) == m(30)


def test_retry_due() -> None:
    assert saga.retry_due("REQUESTED", m(15), m(15)) is True
    assert saga.retry_due("STUCK", m(15), m(16)) is True  # из STUCK повторы продолжаются
    assert saga.retry_due("REQUESTED", m(15), m(14)) is False
    assert saga.retry_due("COMPLETED", m(15), m(16)) is False
    assert saga.retry_due("REQUESTED", None, m(16)) is False


def test_pending_and_all_acked() -> None:
    expected = ["a", "b", "c", "b"]
    assert saga.pending_domains(expected, ["c"]) == ["a", "b"]
    assert saga.pending_domains(expected, ["x"]) == ["a", "b", "c"]  # чужой ACK не засчитывается
    assert saga.all_acked(expected, ["a", "b", "c"]) is True
    assert saga.all_acked(expected, ["a", "b"]) is False
    assert saga.all_acked([], []) is True


def test_can_retry() -> None:
    assert [saga.can_retry(s) for s in saga.STATUSES] == [True, True, False]


def test_no_forced_completion_in_module() -> None:
    """Правило спринта: принудительного завершения без ACK нет — ни функции, ни маршрута."""
    import inspect

    from tilhero_identity import service
    from tilhero_identity.deletion import store, sweeper

    for module in (saga, store, sweeper, service):
        source = inspect.getsource(module)
        assert "force" not in source.replace("Принудительного", "").lower(), module.__name__
    completes = [name for name, _ in inspect.getmembers(store, inspect.isfunction) if "complet" in name]
    assert completes == ["mark_completed"]

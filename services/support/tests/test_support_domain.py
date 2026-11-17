"""Unit-тесты чистых правил support: SLA-таймер, статусная машина, имя оператора, справочники TilHero."""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from tilhero_support.domain.constants import (
    CATEGORIES,
    ESCALATION_TYPES,
    STAFF_TRANSITIONS,
    STATUSES,
    default_priority,
)
from tilhero_support.domain.sla import deadlines, sla_view
from tilhero_support.domain.tickets import first_name, ref_condition
from tilhero_support.models import CATEGORIES_SQL, Ticket

BFF_TS = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "src" / "bff.ts"

NOW = datetime(2026, 10, 8, 12, 0, tzinfo=UTC)


def ticket(
    status: str, *, first_due: timedelta, res_due: timedelta = timedelta(hours=24), responded: bool = False
) -> Ticket:
    return Ticket(
        ticket_id=uuid.uuid4(),
        number=3000,
        status=status,
        sla_first_response_at=NOW + first_due,
        sla_resolution_at=NOW + res_due,
        first_response_at=NOW if responded else None,
    )


def test_sla_view_states() -> None:
    assert sla_view(ticket("NEW", first_due=-timedelta(seconds=1)), NOW).state == "breached"
    assert sla_view(ticket("NEW", first_due=timedelta(0)), NOW).state == "breached"
    soon = sla_view(ticket("IN_PROGRESS", first_due=timedelta(minutes=29)), NOW)
    assert soon.state == "soon" and soon.target == "first_response"
    assert sla_view(ticket("NEW", first_due=timedelta(minutes=30)), NOW).state == "ok"
    res = sla_view(
        ticket("IN_PROGRESS", first_due=-timedelta(hours=1), res_due=timedelta(minutes=5), responded=True),
        NOW,
    )
    assert res.target == "resolution" and res.state == "soon"
    paused = sla_view(ticket("WAITING_CUSTOMER", first_due=-timedelta(hours=1)), NOW)
    assert paused.state == "ok" and paused.paused and paused.due_at is None
    for status in ("RESOLVED", "CLOSED"):
        done = sla_view(ticket(status, first_due=-timedelta(hours=1)), NOW)
        assert done.state == "ok" and not done.paused and done.target is None


def test_deadlines_and_default_priority() -> None:
    assert deadlines(NOW, (120, 1440)) == (NOW + timedelta(hours=2), NOW + timedelta(hours=24))
    for category in ("ACCOUNT", "PERSONAL_DATA", "CHILD_PROFILE"):
        assert default_priority(category) == "high"
    for category in ("LESSON", "ASSESSMENT", "SCHEDULE_REMINDERS", "BUG", "OTHER"):
        assert default_priority(category) == "normal"


def test_staff_transitions_cover_all_statuses() -> None:
    assert set(STAFF_TRANSITIONS) == set(STATUSES)
    assert STAFF_TRANSITIONS["CLOSED"] == frozenset()
    assert "RESOLVED" not in STAFF_TRANSITIONS["NEW"]


def test_first_name_and_refs() -> None:
    assert first_name("Алина Петрова") == "Алина"
    assert first_name("  ") is None and first_name(None) is None
    assert ref_condition("TCK-3081") is not None and ref_condition(str(uuid.uuid4())) is not None
    assert ref_condition("TCK-") is None and ref_condition("3081") is None and ref_condition("tck-1") is None


def _ts_union(name: str) -> list[str]:
    m = re.search(rf"export type {name} =([^;]+);", BFF_TS.read_text())
    assert m, name
    return re.findall(r'"([A-Z_]+)"', m.group(1))


def test_categories_match_bff_contract() -> None:
    """Контракт с Mini App: коды категорий = TicketCategory из bff.ts (в том же порядке), подписи RU/UZ непустые,
    CHECK в БД допускает ровно эти коды."""
    assert list(CATEGORIES) == _ts_union("TicketCategory")
    for code, meta in CATEGORIES.items():
        assert set(meta) == {"ru", "uz", "available"}, code
        assert str(meta["ru"]).strip() and str(meta["uz"]).strip(), code
        assert not re.search(r"[А-Яа-яЁё]", str(meta["uz"])), code  # узбекский — латиница
    assert re.findall(r"'([A-Z_]+)'", CATEGORIES_SQL) == list(CATEGORIES)
    assert {k for k, m in CATEGORIES.items() if not m["available"]} == {"SUBSCRIPTION_PAYMENT"}


def test_no_tourist_leftovers() -> None:
    """Справочники «Бот турист» (события, билеты, перелёты, отели, цены) не перенесены."""
    words = " ".join([*CATEGORIES, *ESCALATION_TYPES, *(str(m["ru"]) for m in ESCALATION_TYPES.values())]).lower()
    for legacy in ("event", "ticket_source", "flight", "hotel", "price", "provider", "событ", "билет", "отел"):
        assert legacy not in words, legacy

"""Unit-тесты отбора «Что нового» (INTERNAL_API §5, for-me) без БД: режимы welcome / updates / none, сегменты,
лимит 5, порядок «новые первыми», граница onboarded_at."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from tilhero_experience.domain.release_notes import (
    CLIENT_MAX_NOTES,
    matches_segment,
    missing_translations,
    pick_whats_new,
)

T0 = datetime(2026, 11, 18, 9, 0, tzinfo=UTC)


@dataclass
class N:
    name: str
    audience: str
    published_at: datetime
    segments: dict[str, Any] = field(default_factory=dict)
    id: uuid.UUID = field(default_factory=uuid.uuid4)


def feed(*notes: N) -> list[N]:
    return sorted(notes, key=lambda n: n.published_at, reverse=True)


def pick(notes: list[N], *, seen: set[uuid.UUID] | None = None, seen_any_new: bool = False,
         onboarded_at: datetime | None = T0, lang: str = "ru", age: str = "adults") -> tuple[str, list[str]]:
    p = pick_whats_new(notes, seen=seen or set(), seen_any_new=seen_any_new, onboarded_at=onboarded_at,
                       lang=lang, age=age)
    return p.mode, [n.name for n in p.notes]


def test_no_onboarding_means_none() -> None:
    notes = feed(N("welcome", "new", T0 - timedelta(days=30)))
    assert pick(notes, onboarded_at=None) == ("none", [])


def test_welcome_on_first_registration() -> None:
    notes = feed(
        N("welcome", "new", T0 - timedelta(days=30)),
        N("all-old", "all", T0 - timedelta(days=20)),
        N("all-latest", "all", T0 - timedelta(days=10)),
        N("existing", "existing", T0 - timedelta(days=5)),
        N("existing-after", "existing", T0 + timedelta(hours=1)),
    )
    # все new + последняя all; existing — нет даже опубликованная после онбординга
    assert pick(notes) == ("welcome", ["all-latest", "welcome"])


def test_welcome_skips_seen_and_ends_after_any_new_seen() -> None:
    welcome = N("welcome", "new", T0 - timedelta(days=30))
    latest_all = N("all", "all", T0 - timedelta(days=1))
    notes = feed(welcome, latest_all)
    # показали, но отметку «всё просмотрено» успели поставить только у all
    assert pick(notes, seen={latest_all.id}) == ("welcome", ["welcome"])
    # видел заметку new → дальше только updates
    after = feed(welcome, latest_all, N("existing", "existing", T0 + timedelta(days=2)),
                 N("welcome-2", "new", T0 + timedelta(days=3)))
    assert pick(after, seen={welcome.id}, seen_any_new=True) == ("updates", ["existing"])


def test_updates_after_onboarding_unseen_only() -> None:
    welcome = N("welcome", "new", T0 - timedelta(days=30))
    before = N("before", "existing", T0 - timedelta(seconds=1))
    at = N("at", "all", T0)  # ровно в момент онбординга — не «после»
    a = N("a", "existing", T0 + timedelta(days=1))
    b = N("b", "all", T0 + timedelta(days=2))
    c = N("c", "existing", T0 + timedelta(days=3))
    notes = feed(welcome, before, at, a, b, c)
    assert pick(notes, seen={welcome.id}, seen_any_new=True) == ("updates", ["c", "b", "a"])
    assert pick(notes, seen={welcome.id, c.id}, seen_any_new=True) == ("updates", ["b", "a"])
    assert pick(notes, seen={welcome.id, a.id, b.id, c.id}, seen_any_new=True) == ("none", [])


def test_limit_and_newest_first() -> None:
    welcomes = [N(f"w{i}", "new", T0 - timedelta(days=10 - i)) for i in range(7)]
    mode, names = pick(feed(*welcomes))
    assert mode == "welcome" and names == ["w6", "w5", "w4", "w3", "w2"] and len(names) == CLIENT_MAX_NOTES
    updates = [N(f"u{i}", "existing", T0 + timedelta(hours=i + 1)) for i in range(8)]
    mode, names = pick(feed(*updates), seen_any_new=True)
    assert mode == "updates" and names == ["u7", "u6", "u5", "u4", "u3"]


def test_segments() -> None:
    assert matches_segment({}, "ru", "kids")
    assert matches_segment({"age": ["kids", "teens"]}, "uz", "teens")
    assert not matches_segment({"age": ["adults"]}, "ru", "kids")
    assert matches_segment({"ui_lang": ["uz"]}, "uz", "adults")
    assert not matches_segment({"ui_lang": ["uz"]}, "ru", "adults")
    assert not matches_segment({"age": ["kids"], "ui_lang": ["uz"]}, "ru", "kids")
    notes = feed(
        N("welcome", "new", T0 - timedelta(days=30)),
        N("welcome-teens", "new", T0 - timedelta(days=29), {"age": ["teens"]}),
        N("kids-uz", "existing", T0 + timedelta(days=1), {"age": ["kids"], "ui_lang": ["uz"]}),
        N("adults", "all", T0 + timedelta(days=2), {"age": ["adults"]}),
    )
    assert pick(notes, age="adults") == ("welcome", ["adults", "welcome"])
    assert pick(notes, age="teens") == ("welcome", ["welcome-teens", "welcome"])
    assert pick(notes, seen_any_new=True, age="kids", lang="uz") == ("updates", ["kids-uz"])
    assert pick(notes, seen_any_new=True, age="kids", lang="ru") == ("none", [])
    # для сегмента нет ни одной new → сразу updates
    only_teens = feed(N("welcome-teens", "new", T0 - timedelta(days=1), {"age": ["teens"]}),
                      N("all", "all", T0 + timedelta(days=1)))
    assert pick(only_teens, age="adults") == ("updates", ["all"])


def test_missing_translations_paths() -> None:
    title = {"ru": "Декабрь", "uz": " "}
    items = [{"title": {"ru": "A", "uz": "A"}, "text": {"ru": "", "uz": "B"}},
             {"title": {"ru": "C"}, "text": {"ru": "D", "uz": "E"}}]
    assert missing_translations(title, items) == ["title.uz", "items[0].text.ru", "items[1].title.uz"]
    assert missing_translations({"ru": "x", "uz": "y"}, [{"title": {"ru": "a", "uz": "b"},
                                                          "text": {"ru": "c", "uz": "d"}}]) == []

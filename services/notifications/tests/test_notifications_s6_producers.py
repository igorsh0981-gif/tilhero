"""Интеграция спринта 6: payload уведомлений, которые реально строят издатели (services/watch, services/news), проходят
строгие модели шаблонов notifications и рендерятся — по одному (watch.critical сразу) и в дайджесте digest.daily
(watch.price_drop + news.digest). Издатели — пакеты рабочего пространства; без них тест пропускается."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from types import SimpleNamespace

import pytest

from tilhero_notifications.digest import compose
from tilhero_notifications.store import PendingItem
from tilhero_notifications.templates import TEMPLATES

watch_store = pytest.importorskip("tilhero_watch.store")
watch_detector = pytest.importorskip("tilhero_watch.domain.detector")
news_digest = pytest.importorskip("tilhero_news.digest")

EVENT = uuid.UUID("0b7c3a52-1d2e-4f60-8a9b-000000000001")
WATCH = uuid.UUID("5d0c7e1a-2b3c-4d5e-8f9a-000000000001")
T0 = datetime(2026, 10, 11, 6, 0, tzinfo=UTC)


def _watch(title: str = "Formula 1 <Abu Dhabi> & GP") -> SimpleNamespace:
    return SimpleNamespace(watch_id=WATCH, event_id=EVENT, event_title=title, tier="comfort")


def _news(n: int, *, url: str | None = None, events: list[uuid.UUID] | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        news_id=uuid.UUID(f"7a1b2c3d-4e5f-4a6b-8c7d-{n:012d}"), title=f"F1 news {n} <b>", title_i18n=None,
        url=url or f"https://www.formula1.com/en/latest/article/n{n}.html", source_domain="formula1.com",
        source_name="Formula 1", event_ids=events or [])


@pytest.mark.parametrize(("frm", "to", "change"), [
    ("ON_SALE", "POSTPONED", "postponed"), ("ON_SALE", "CANCELLED", "cancelled"), ("ON_SALE", "SOLD_OUT", "sold_out"),
    ("ON_SALE", "LOW_INVENTORY", "low_inventory"), ("SALES_SOON", "ON_SALE", "sales_open"),
])
def test_watch_critical_payload_renders(frm: str, to: str, change: str) -> None:
    d = watch_detector.detect_lifecycle(frm, to)
    assert d is not None and d.notify == "critical" and d.critical_change == change
    params = watch_store._notification_params(_watch(), d)
    spec = TEMPLATES[watch_store.TEMPLATES["critical"]]
    assert spec.name == "watch.critical" and spec.digest_section is None  # критичное — сразу
    for lang in ("ru", "en"):
        r = spec.render(lang, params, f"event_{EVENT}")
        assert "&lt;Abu Dhabi&gt; &amp; GP" in r.text  # параметры экранируются
        assert r.buttons[0][0]["startapp"] == f"event_{EVENT}"


def test_watch_venue_change_payload_renders() -> None:
    d = watch_detector.detect_venue("a" * 32, "b" * 32)
    assert d is not None
    r = TEMPLATES["watch.critical"].render("ru", watch_store._notification_params(_watch(), d))
    assert "площадка" in r.text


def test_watch_price_drop_payload_renders_and_goes_to_digest() -> None:
    d = watch_detector.Detected(type="price_drop", severity="normal", before="1000.00", after="870.00", value="870",
                                dimension="price", notify="digest", delta_usd=Decimal("-130.00"),
                                delta_pct=Decimal("-13.0000"), flight_delta=Decimal("-100.00"),
                                hotel_delta=Decimal("-30.00"))
    params = watch_store._notification_params(_watch(), d)
    spec = TEMPLATES[watch_store.TEMPLATES["digest"]]
    assert spec.name == "watch.price_drop" and spec.digest_section == "watch"
    assert spec.validate(params).drop_pct == Decimal("13.00")
    text = spec.render("ru", params).text
    assert "870" in text and "130" in text and "Comfort" in text
    # дайджест: снижение цены + новости одним сообщением
    entries = [news_digest.digest_entry(_news(i, events=[EVENT] if i == 1 else None), "ru") for i in (1, 2)]
    news_params = {"items": entries}
    assert TEMPLATES["news.digest"].digest_section == "news"
    TEMPLATES["news.digest"].render("en", news_params, "news")
    items = [PendingItem(uuid.uuid4(), "watch", "watch.price_drop", params, T0),
             PendingItem(uuid.uuid4(), "news", "news.digest", news_params, T0)]
    daily = compose(items, date(2026, 10, 11))
    assert daily is not None and len(daily["watch"]) == 1 and len(daily["news"]) == 2
    assert daily["news"][0]["event_id"] == str(EVENT)
    for lang in ("ru", "en"):
        r = TEMPLATES["digest.daily"].render(lang, daily)
        assert "https://www.formula1.com/en/latest/article/n1.html" in r.text
        assert "&lt;b&gt;" in r.text and "<b>F1" not in r.text  # заголовок ленты — текст, не HTML


def test_news_digest_long_url_falls_back_to_source_home() -> None:
    entry = news_digest.digest_entry(_news(3, url="https://www.formula1.com/" + "x" * 600), "en")
    assert entry["source"]["url"] == "https://formula1.com/"
    TEMPLATES["news.digest"].validate({"items": [entry]})

"""Unit: шаблоны RU/EN (экранирование, деньги, кнопки) и тихие часы в часовом поясе пользователя."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms
from tilhero_notifications.delivery import DeliveryInfo
from tilhero_notifications.policy import decide, quiet_hours_end, zone
from tilhero_notifications.templates import TEMPLATES, TemplateError

TASHKENT = ZoneInfo("Asia/Tashkent")


def render(template: str, locale: str, params: dict, startapp: str | None = None):
    return TEMPLATES[template].render(locale, params, startapp)


def test_pin_reset_code_is_not_allowed_on_the_bus_contract() -> None:
    import jsonschema

    payload = {
        "notification_id": "6f1c5f0e-2d55-4c43-9c6f-6a6c3f6b1a11",
        "user_id": "0b8f5d8e-8f3b-4d1f-9a43-5a7c0e9d2c22",
        "kind": "transactional",
        "template": "pin.reset_code",
        "params": {"code": "123456"},
        "dedup_key": "pin:1",
    }
    with pytest.raises(jsonschema.ValidationError):
        assert_event_conforms(make_envelope("notification.requested.v1", payload, producer="identity-consent"))
    assert TEMPLATES["pin.reset_code"].direct_only


def test_pin_reset_ttl_wording() -> None:
    ru = {n: render("pin.reset_code", "ru", {"code": "123456", "ttl_minutes": n}).text for n in (1, 2, 5, 11, 21)}
    assert [t.rsplit("Действует ", 1)[1] for t in ru.values()] == [
        "1 минуту.", "2 минуты.", "5 минут.", "11 минут.", "21 минуту."]
    assert render("pin.reset_code", "en", {"code": "123456", "ttl_minutes": 1}).text.endswith("valid for 1 minute.")


def test_pin_reset_texts() -> None:
    assert render("pin.reset_code", "ru", {"code": "123456"}).text == (
        "Код для сброса PIN в TilHero: <b>123456</b>. Никому не сообщайте его. Действует 10 минут."
    )
    en = render("pin.reset_code", "en", {"code": "123456"})
    assert (
        en.text
        == "TilHero PIN reset code: <b>123456</b>. Do not share it with anyone. It is valid for 10 minutes."
    )
    assert en.buttons == []
    for bad in ({"code": "12345"}, {"code": "12345a"}, {"code": "<b>1</b>"}, {}, {"code": "123456", "x": 1}):
        with pytest.raises(TemplateError):
            render("pin.reset_code", "ru", bad)


def test_support_texts() -> None:
    reply = render("support.reply", "ru", {"number": "TCK-3081"})
    assert reply.text == "Поддержка ответила на обращение TCK-3081. Откройте, чтобы прочитать."
    assert reply.buttons == [[{"text": "Открыть обращение", "startapp": "ticket_TCK-3081"}]]
    resolved = render("support.resolved", "en-US", {"number": "TCK-3081"})
    assert resolved.text.startswith("Request TCK-3081 is resolved.")
    assert resolved.buttons == [[{"text": "Open request", "startapp": "ticket_TCK-3081"}]]
    with pytest.raises(TemplateError):
        render("support.reply", "ru", {"number": "TCK-1<script>"})


F1 = "0b6f3c2a-8d1e-4f5a-9b7c-1e2d3f4a5b6c"
DESERT = "3f2b8c1e-6a4d-4e0b-9c71-2d5e8f1a7b90"
DEEPLINK_EVENT = re.compile(r"^event_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")  # tg/deeplink.ts
MINIAPP_TABS = {"watch", "news"}


def src(domain: str = "formula1.com", path: str = "/en/latest/article/1") -> dict:
    return {"name": "Formula 1", "domain": domain, "url": f"https://www.{domain}{path}"}


def assert_deeplinks(buttons: list[list[dict]]) -> None:
    """Каждая кнопка ведёт туда, что разбирает Mini App: event_<uuid>, watch, news."""
    for row in buttons:
        for b in row:
            assert DEEPLINK_EVENT.match(b["startapp"]) or b["startapp"] in MINIAPP_TABS, b


def test_watch_price_drop() -> None:
    params = {
        "watch_id": "6f1c5f0e-2d55-4c43-9c6f-6a6c3f6b1a11",
        "event_id": F1.upper(),  # регистр UUID нормализуется — deeplink.ts сравнивает в нижнем
        "event_title": "Formula 1 <Abu Dhabi> & GP",
        "tier": "comfort",
        "price_usd": "1650",
        "drop_usd": "120.5",
        "drop_pct": "6.8",
        "flight_delta_usd": "-80",
        "hotel_delta_usd": "-40.50",
    }
    ru = render("watch.price_drop", "ru", params)
    assert ru.text == (
        "<b>Formula 1 &lt;Abu Dhabi&gt; &amp; GP</b>: поездка подешевела на $120,50 "
        "(перелёт −$80, отель −$40,50). Comfort сейчас $1 650 на человека."
    )
    assert ru.buttons == [
        [
            {"text": "Открыть событие", "startapp": f"event_{F1}"},
            {"text": "Все изменения", "startapp": "watch"},
        ]
    ]
    assert_deeplinks(ru.buttons)
    en = render("watch.price_drop", "en", {**params, "flight_delta_usd": None, "hotel_delta_usd": None})
    assert en.text == (
        "<b>Formula 1 &lt;Abu Dhabi&gt; &amp; GP</b>: the trip got $120.50 cheaper. "
        "Comfort is now $1,650 per person."
    )
    for bad in (
        {**params, "price_usd": "-1"},
        {**params, "tier": "vip"},
        {**params, "event_id": "../x"},
        {**params, "event_id": "evt_f1_auh_2026"},  # слаги прототипа больше не принимаются
        {**params, "price_usd": "1.001"},
        {**params, "drop_pct": "101"},
        {**params, "unknown": 1},
    ):
        with pytest.raises(TemplateError):
            render("watch.price_drop", "ru", bad)


def test_watch_critical_and_news_digest() -> None:
    crit = render(
        "watch.critical", "ru", {"event_id": DESERT, "event_title": "Desert Sounds Festival", "change": "postponed"}
    )
    assert crit.text == (
        "<b>Desert Sounds Festival</b>: событие перенесено, новые даты пока не объявлены. "
        "Откройте событие, чтобы узнать подробности."
    )
    assert crit.buttons == [[{"text": "Открыть событие", "startapp": f"event_{DESERT}"}]]
    assert_deeplinks(crit.buttons)
    news = render(
        "news.digest",
        "en",
        {
            "items": [
                {"news_id": F1, "title": "F1 <grid> confirmed", "source": src(), "event_id": F1},
                {"title": "Tickets restock", "source": {**src("abudhabigp.com"), "name": "Yas <Marina>"}},
            ]
        },
    )
    assert news.text == (
        "News on your events and interests — 2:\n"
        '• F1 &lt;grid&gt; confirmed — <a href="https://www.formula1.com/en/latest/article/1">Formula 1</a>'
        " (formula1.com)\n"
        '• Tickets restock — <a href="https://www.abudhabigp.com/en/latest/article/1">Yas &lt;Marina&gt;</a>'
        " (abudhabigp.com)"
    )
    assert news.buttons == [[{"text": "All news", "startapp": "news"}]]
    for bad_item in (
        {"title": "Без источника"},  # TG-FR-033
        {"title": "Строка вместо источника", "source": "formula1.com"},
        {"title": "http", "source": {**src(), "url": "http://www.formula1.com/x"}},
        {"title": "Чужой домен", "source": {**src(), "url": "https://evil.example/formula1.com"}},
        {"title": "Похожий домен", "source": {**src(), "url": "https://notformula1.com/x"}},
        {"title": "Кавычка", "source": {**src(), "url": 'https://www.formula1.com/"onclick'}},
    ):
        with pytest.raises(TemplateError):
            render("news.digest", "ru", {"items": [bad_item]})
    with pytest.raises(TemplateError):
        render("news.digest", "ru", {"items": [{"title": "x", "source": src()}] * 11})
    with pytest.raises(TemplateError):
        render("watch.critical", "ru", {"event_id": DESERT, "event_title": "x", "change": "exploded"})


def test_news_source_link_is_escaped() -> None:
    out = render(
        "news.digest", "ru", {"items": [{"title": "A & B", "source": {**src(), "url": "https://www.formula1.com/a?x=1&y=2"}}]}
    )
    assert out.text == (
        "Новости по вашим событиям и интересам — 1:\n"
        '• A &amp; B — <a href="https://www.formula1.com/a?x=1&amp;y=2">Formula 1</a> (formula1.com)'
    )


def test_news_source_domain_idna_and_garbage() -> None:
    """Ревью спринта 6, MINOR 5: punycode-TLD и кириллица показываются по-человечески, мусор не роняет дайджест."""
    from tilhero_notifications.templates import display_domain, normalize_domain

    assert normalize_domain("Lenta.XN--P1AI.") == "lenta.xn--p1ai"
    assert normalize_domain("пример.рф") == "xn--e1afmkfd.xn--p1ai"
    assert normalize_domain("news.xn--80asehdb") == "news.xn--80asehdb"
    assert normalize_domain("site.com1") == "site.com1"  # цифры в TLD
    for junk in ("", "localhost", "1.2.3.4", "a..b", "-x.com", "x.com/evil", "<b>.com", "a" * 300 + ".com",
                 "пример..рф", 42, None):
        assert normalize_domain(junk) is None, junk
    assert display_domain("xn--e1afmkfd.xn--p1ai") == "пример.рф"
    assert display_domain("news.xn--80asehdb") == "news.онлайн"
    broken = "xn--a.xn--p1ai"  # валиден по форме, но не декодируется → показываем как есть
    assert normalize_domain(broken) == display_domain(broken) == broken

    def line(source: dict) -> str:
        out = render("news.digest", "ru", {"items": [{"title": "Премьера <сезона>", "source": source}]})
        return out.text.split("\n", 1)[1]

    rf = {"name": "Лента", "domain": "lenta.xn--p1ai", "url": "https://lenta.xn--p1ai/news/1"}
    assert line(rf) == '• Премьера &lt;сезона&gt; — <a href="https://lenta.xn--p1ai/news/1">Лента</a> (lenta.рф)'
    cyr = {"name": "Пример", "domain": "Пример.РФ", "url": "https://новости.пример.рф/1"}
    assert line(cyr).endswith("</a> (пример.рф)")
    online = {"name": "Онлайн", "domain": "xn--80asehdb", "url": "https://xn--80asehdb/1"}
    assert normalize_domain("xn--80asehdb") is None  # одна метка — домен невалиден → новость не включается
    with pytest.raises(TemplateError):
        line(online)
    garbage = {"name": "Источник", "domain": "<script>!!", "url": "https://example.org/a"}
    # AT-33: невалидный домен — проверить «URL на домене» нельзя → новость не включается (остальные остаются)
    with pytest.raises(TemplateError):
        line(garbage)
    mixed = render("news.digest", "ru", {"items": [
        {"title": "a", "source": rf}, {"title": "b", "source": garbage},
        {"title": "c", "source": {**rf, "url": "https://evil.example/1"}},  # валидный домен, чужой URL
    ]})
    assert mixed.text.startswith("Новости по вашим событиям и интересам — 1:") and mixed.text.count("• ") == 1
    d = render("digest.daily", "ru", {"date": "2026-10-12", "news": [
        {"title": "a", "source": rf}, {"title": "b", "source": cyr}]})
    assert d.text.count("• ") == 2 and "(lenta.рф)" in d.text
    with pytest.raises(TemplateError):  # digest.daily собирается из уже проверенных пунктов — строго
        render("digest.daily", "ru", {"date": "2026-10-12", "news": [{"title": "c", "source": garbage}]})


def test_display_domain_mixed_scripts_shows_punycode() -> None:
    """Защита от подмены похожими буквами: Unicode — только если каждая метка целиком латиница или кириллица."""
    from tilhero_notifications.templates import display_domain, normalize_domain

    fake = normalize_domain("\u0430pple.com")  # «а» — кириллическая
    assert fake == "xn--pple-43d.com" and display_domain(fake) == "xn--pple-43d.com"
    assert display_domain(normalize_domain("раypal.рф") or "") == normalize_domain("раypal.рф")
    assert display_domain(normalize_domain("ελλάδα.gr") or "") == "xn--hxakic4aa.gr"  # другой алфавит
    assert display_domain("xn--e1afmkfd.xn--p1ai") == "пример.рф"
    assert display_domain("lenta.xn--p1ai") == "lenta.рф"  # метки разных алфавитов, но каждая цельная
    assert display_domain("apple.com") == "apple.com"
    out = render("news.digest", "ru", {"items": [
        {"title": "x", "source": {"name": "Apple", "domain": "\u0430pple.com", "url": "https://\u0430pple.com/n"}}]})
    assert out.text.endswith("</a> (xn--pple-43d.com)")


def digest_params(n_watch: int = 1, n_news: int = 1, more: int = 0) -> dict:
    return {
        "date": "2026-10-11",
        "watch": [
            {
                "event_id": F1,
                "event_title": f"Formula 1 Abu Dhabi GP {i}",
                "tier": "comfort",
                "price_usd": "1650",
                "drop_usd": "120",
            }
            for i in range(n_watch)
        ],
        "news": [{"title": f"Grid <confirmed> {i}", "source": src(path=f"/a/{i}")} for i in range(n_news)],
        "more": more,
    }


def test_digest_daily_sections_ru_en() -> None:
    ru = render("digest.daily", "ru", digest_params(1, 1, more=3))
    assert ru.text == (
        "<b>Дайджест TilHero</b>\n\n<b>Слежения</b>\n"
        "• <b>Formula 1 Abu Dhabi GP 0</b>: −$120 → Comfort $1 650 на человека\n\n"
        "<b>Новости</b>\n"
        '• Grid &lt;confirmed&gt; 0 — <a href="https://www.formula1.com/a/0">Formula 1</a> (formula1.com)\n\n'
        "Ещё 3 — в приложении."
    )
    assert ru.buttons == [[{"text": "Слежения", "startapp": "watch"}, {"text": "Все новости", "startapp": "news"}]]
    en = render("digest.daily", "en", digest_params(1, 0))
    assert en.text == (
        "<b>TilHero digest</b>\n\n<b>Watching</b>\n• <b>Formula 1 Abu Dhabi GP 0</b>: −$120 → Comfort $1,650 per person"
    )
    # одно событие — прямая кнопка на него (event_<uuid>)
    assert en.buttons == [
        [{"text": "Open event", "startapp": f"event_{F1}"}],
        [{"text": "Watch", "startapp": "watch"}],
    ]
    only_news = render("digest.daily", "en", digest_params(0, 2))
    assert "<b>Watching</b>" not in only_news.text and only_news.text.count("• ") == 2
    assert only_news.buttons == [[{"text": "All news", "startapp": "news"}]]
    for r in (ru, en, only_news):
        assert_deeplinks(r.buttons)


def test_digest_daily_limits() -> None:
    with pytest.raises(TemplateError):
        render("digest.daily", "ru", digest_params(0, 0))  # пустой дайджест не отправляется
    with pytest.raises(TemplateError):
        render("digest.daily", "ru", digest_params(6, 5))  # > 10 пунктов
    with pytest.raises(TemplateError):
        render("digest.daily", "ru", {**digest_params(), "news": [{"title": "x"}]})  # новость без источника
    full = render("digest.daily", "ru", digest_params(5, 5))
    assert full.text.count("• ") == 10
    # длинные заголовки обрезаются, длинные URL → имя источника без ссылки (лимит Telegram)
    long = digest_params(0, 10)
    for i, n in enumerate(long["news"]):
        n["title"] = "Т" * 200
        n["source"] = src(path="/" + "p" * 470 + str(i))
    out = render("digest.daily", "ru", long)
    assert len(out.text) <= 4000 and "<a href" not in out.text and "Т" * 119 + "…" in out.text


def test_generic_startapp_button() -> None:
    assert render("pin.reset_code", "ru", {"code": "123456"}, "profile").buttons == [
        [{"text": "Открыть TilHero", "startapp": "profile"}]
    ]
    assert (
        render("support.reply", "ru", {"number": "TCK-1"}, "other").buttons[0][0]["startapp"]
        == "ticket_TCK-1"
    )


def test_quiet_hours_window() -> None:
    def at(h: int, m: int = 0, day: int = 8) -> datetime:
        return datetime(2026, 10, day, h, m, tzinfo=TASHKENT).astimezone(UTC)

    end = datetime(2026, 10, 9, 8, 0, tzinfo=TASHKENT).astimezone(UTC)
    assert quiet_hours_end(at(23, 30), "23:00", "08:00", TASHKENT) == end  # через полночь
    assert quiet_hours_end(at(0, 30, day=9), "23:00", "08:00", TASHKENT) == end
    assert quiet_hours_end(at(23, 0), "23:00", "08:00", TASHKENT) == end  # начало включительно
    assert quiet_hours_end(at(8, 0, day=9), "23:00", "08:00", TASHKENT) is None  # конец не включительно
    assert quiet_hours_end(at(22, 59), "23:00", "08:00", TASHKENT) is None
    assert quiet_hours_end(at(14, 0), "13:00", "15:00", TASHKENT) == datetime(
        2026, 10, 8, 15, 0, tzinfo=TASHKENT
    )
    assert quiet_hours_end(at(14, 0), "14:00", "14:00", TASHKENT) is None
    assert quiet_hours_end(at(14, 0), "25:00", "08:00", TASHKENT) is None
    assert zone("Mars/Base", "Asia/Tashkent") == TASHKENT and zone(None, "Bad/Zone") == ZoneInfo("UTC")


def test_decide_policy() -> None:
    now = datetime(2026, 10, 8, 23, 30, tzinfo=TASHKENT).astimezone(UTC)
    quiet = {"start": "23:00", "end": "08:00"}
    user = DeliveryInfo(
        telegram_user_id=1,
        locale="ru",
        notifications_enabled=True,
        quiet_hours=quiet,
        timezone="Asia/Tashkent",
        status="ACTIVE",
    )
    reply, pin = TEMPLATES["support.reply"], TEMPLATES["pin.reset_code"]
    assert decide("standard", reply, user, now, "UTC").action == "defer"
    assert decide("critical", reply, user, now, "UTC").action == "send"
    assert decide("transactional", pin, user, now, "UTC").action == "send"
    # Часовой пояс пользователя важен: в UTC 18:30 — тихих часов нет
    assert decide("standard", reply, user.model_copy(update={"timezone": "UTC"}), now, "UTC").action == "send"
    off = user.model_copy(update={"notifications_enabled": False})
    assert decide("standard", reply, off, now, "UTC").reason == "notifications_disabled"
    assert decide("transactional", pin, off, now, "UTC").action == "send"
    assert decide("digest", pin, off, now, "UTC").action == "skip"
    disabled = user.model_copy(update={"status": "DISABLED"})
    assert decide("critical", reply, disabled, now, "UTC").reason == "user_inactive"
    assert decide("transactional", pin, disabled, now, "UTC").action == "send"


def test_consumed_event_contracts() -> None:
    for event_type, payload in (
        (
            "notification.requested.v1",
            {
                "notification_id": "6f1c5f0e-2d55-4c43-9c6f-6a6c3f6b1a11",
                "user_id": "0b8f5d8e-8f3b-4d1f-9a43-5a7c0e9d2c22",
                "kind": "critical",
                "template": "watch.critical",
                "params": {"event_id": DESERT, "event_title": "X", "change": "cancelled"},
                "dedup_key": "crit:1",
                "startapp": None,
            },
        ),
        (
            "support.ticket.replied.v1",
            {
                "ticket_id": "6f1c5f0e-2d55-4c43-9c6f-6a6c3f6b1a11",
                "number": "TCK-3081",
                "user_id": "0b8f5d8e-8f3b-4d1f-9a43-5a7c0e9d2c22",
                "message_id": "0b8f5d8e-8f3b-4d1f-9a43-5a7c0e9d2c23",
                "sender_type": "operator",
                "replied_at": "2026-10-08T10:00:00Z",
            },
        ),
    ):
        assert_event_conforms(make_envelope(event_type, payload, producer="test"))

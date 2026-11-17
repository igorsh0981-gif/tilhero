"""Шаблоны уведомлений RU/EN (тексты — из прототипа Mini App v9: 90-bot-console.js, 80-profile.js).

Правила:
- текст — HTML (parse_mode=HTML у bot-gateway); КАЖДЫЙ параметр экранируется html.escape;
- параметры проверяются строгой моделью ещё при приёме (неизвестное поле/формат → failed params_invalid);
- текст ответа оператора в уведомление не кладём — только номер обращения и кнопку «Открыть обращение»;
- watch.critical — сразу; watch.price_drop и news.digest с kind=digest копятся и уходят одним digest.daily
  в digest_time пользователя (спринт 6, docs/sprint6/INTERNAL_API.md §5);
- deep link события — `event_<uuid>` (Mini App tg/deeplink.ts), вкладки — `watch`, `news`;
- у новости всегда источник: https-URL на домене источника.
"""

from __future__ import annotations

import html
import re
import unicodedata
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date as datetime_date
from decimal import Decimal
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

Button = dict[str, str]
STARTAPP_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
Title = Annotated[str, Field(min_length=1, max_length=200)]
Money = Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=2)]
Delta = Annotated[Decimal, Field(max_digits=12, decimal_places=2)]
Pct = Annotated[Decimal, Field(ge=0, le=100, max_digits=5, decimal_places=2)]
MAX_TEXT = 4000  # bot-gateway: text ≤ 4096


class TemplateError(ValueError):
    pass


@dataclass(frozen=True)
class Rendered:
    text: str
    buttons: list[list[Button]] = field(default_factory=list)


def esc(value: object) -> str:
    return html.escape(str(value), quote=False)


def lang_of(locale: str | None) -> str:
    return "ru" if (locale or "").lower().startswith("ru") else "en"


def usd(amount: Decimal, lang: str) -> str:
    q = (
        amount.quantize(Decimal("1"))
        if amount == amount.to_integral_value()
        else amount.quantize(Decimal("0.01"))
    )
    text = f"{q:,}"
    if lang == "ru":
        text = text.replace(",", " ").replace(".", ",")
    return f"${text}"


def signed_usd(delta: Decimal, lang: str) -> str:
    return ("−" if delta < 0 else "+") + usd(abs(delta), lang)


class Params(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# ---------------------------------------------------------------- pin.reset_code (transactional)


class PinResetParams(Params):
    code: Annotated[str, Field(pattern=r"^\d{6}$")]
    ttl_minutes: Annotated[int, Field(ge=1, le=60)] = 10  # срок кода — из настроек identity-consent


def _minutes_ru(n: int) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} минуту"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return f"{n} минуты"
    return f"{n} минут"


def _pin_reset(lang: str, p: PinResetParams) -> Rendered:
    if lang == "ru":
        return Rendered(
            f"Код для сброса PIN в TilHero: <b>{esc(p.code)}</b>. Никому не сообщайте его. "
            f"Действует {_minutes_ru(p.ttl_minutes)}."
        )
    unit = "minute" if p.ttl_minutes == 1 else "minutes"
    return Rendered(
        f"TilHero PIN reset code: <b>{esc(p.code)}</b>. Do not share it with anyone. "
        f"It is valid for {p.ttl_minutes} {unit}."
    )


# ---------------------------------------------------------------- support.*


class TicketParams(Params):
    number: Annotated[str, Field(pattern=r"^TCK-\d{1,12}$")]


def _ticket_button(lang: str, number: str) -> list[list[Button]]:
    return [
        [{"text": "Открыть обращение" if lang == "ru" else "Open request", "startapp": f"ticket_{number}"}]
    ]


def _support_reply(lang: str, p: TicketParams) -> Rendered:
    if lang == "ru":
        text = f"Поддержка ответила на обращение {esc(p.number)}. Откройте, чтобы прочитать."
    else:
        text = f"Support replied to your request {esc(p.number)}. Open it to read the reply."
    return Rendered(text, _ticket_button(lang, p.number))


def _support_resolved(lang: str, p: TicketParams) -> Rendered:
    if lang == "ru":
        text = (
            f"Обращение {esc(p.number)} решено. Если вопрос остался — ответьте в обращении, и мы продолжим."
        )
    else:
        text = (
            f"Request {esc(p.number)} is resolved. If you still have a question, "
            "reply in the request and we will continue."
        )
    return Rendered(text, _ticket_button(lang, p.number))


# ---------------------------------------------------------------- watch.* (спринт 6, INTERNAL_API §2.3, §5)

TIERS = {"economy": "Economy", "comfort": "Comfort", "premium": "Premium"}


def event_startapp(event_id: uuid.UUID) -> str:
    """Deep link на событие: Mini App (apps/telegram-miniapp/src/tg/deeplink.ts) ждёт `event_<uuid>`."""
    return f"event_{str(event_id).lower()}"


class PriceDropParams(Params):
    """watch.price_drop (kind digest) — WatchChange type=price_drop: after → price_usd, |delta_usd| → drop_usd."""

    watch_id: uuid.UUID | None = None
    event_id: uuid.UUID
    event_title: Title
    tier: Literal["economy", "comfort", "premium"]
    price_usd: Money  # итог на человека после снижения
    drop_usd: Money  # на сколько подешевело
    drop_pct: Pct | None = None
    flight_delta_usd: Delta | None = None
    hotel_delta_usd: Delta | None = None


def _event_buttons(lang: str, event_id: uuid.UUID, *, changes: bool) -> list[list[Button]]:
    row = [{"text": "Открыть событие" if lang == "ru" else "Open event", "startapp": event_startapp(event_id)}]
    if changes:
        row.append({"text": "Все изменения" if lang == "ru" else "All changes", "startapp": "watch"})
    return [row]


def _price_drop(lang: str, p: PriceDropParams) -> Rendered:
    parts = []
    if p.flight_delta_usd is not None:
        parts.append(("перелёт " if lang == "ru" else "flight ") + signed_usd(p.flight_delta_usd, lang))
    if p.hotel_delta_usd is not None:
        parts.append(("отель " if lang == "ru" else "hotel ") + signed_usd(p.hotel_delta_usd, lang))
    detail = f" ({', '.join(parts)})" if parts else ""
    title, tier = esc(p.event_title), TIERS[p.tier]
    if lang == "ru":
        text = (
            f"<b>{title}</b>: поездка подешевела на {usd(p.drop_usd, lang)}{detail}. "
            f"{tier} сейчас {usd(p.price_usd, lang)} на человека."
        )
    else:
        text = (
            f"<b>{title}</b>: the trip got {usd(p.drop_usd, lang)} cheaper{detail}. "
            f"{tier} is now {usd(p.price_usd, lang)} per person."
        )
    return Rendered(text, _event_buttons(lang, p.event_id, changes=True))


CRITICAL_CHANGES = {
    "postponed": (
        "событие перенесено, новые даты пока не объявлены",
        "the event is postponed, new dates are not announced yet",
    ),
    "cancelled": ("событие отменено", "the event is cancelled"),
    "sold_out": ("билеты распроданы", "tickets are sold out"),
    "low_inventory": ("билетов осталось мало", "few tickets are left"),
    "sales_open": ("продажи билетов открыты", "ticket sales are open"),
    "venue_changed": ("изменилась площадка", "the venue has changed"),
}


class CriticalParams(Params):
    """watch.critical (kind critical) — критичный переход lifecycle (§2.2): POSTPONED, CANCELLED, SOLD_OUT,
    LOW_INVENTORY, ON_SALE из SALES_SOON/ANNOUNCED (sales_open), смена площадки (venue_changed)."""

    watch_id: uuid.UUID | None = None
    event_id: uuid.UUID
    event_title: Title
    change: Literal["postponed", "cancelled", "sold_out", "low_inventory", "sales_open", "venue_changed"]


def _critical(lang: str, p: CriticalParams) -> Rendered:
    ru, en = CRITICAL_CHANGES[p.change]
    title = esc(p.event_title)
    text = (
        f"<b>{title}</b>: {ru}. Откройте событие, чтобы узнать подробности."
        if lang == "ru"
        else f"<b>{title}</b>: {en}. Open the event for details."
    )
    return Rendered(text, _event_buttons(lang, p.event_id, changes=False))


# ---------------------------------------------------------------- news.digest (спринт 6, §3.3)

_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
# Метки — буквы/цифры/дефис (в т.ч. punycode xn--…); TLD — то же, но не из одних цифр (не IP), напр. xn--p1ai
_DOMAIN_RE = re.compile(rf"^(?:{_LABEL}\.)+({_LABEL})$")
DOMAIN_DISPLAY_MAX = 60


def normalize_domain(value: object) -> str | None:
    """Домен → ASCII-форма (IDNA/punycode, нижний регистр) или None, если домен невалиден. Никогда не падает:
    кириллица (пример.рф) кодируется в xn--…, мусор → None (домен пропускается, новость остаётся)."""
    if not isinstance(value, str):
        return None
    d = value.strip().lower().rstrip(".")
    if not d or len(d) > 253:
        return None
    if not d.isascii():
        try:
            d = d.encode("idna").decode("ascii").lower()
        except (UnicodeError, ValueError):
            return None
    m = _DOMAIN_RE.match(d)
    if m is None or m.group(1).isdigit() or len(d) > 253:
        return None
    return d


def _label_script(label: str) -> str | None:
    """Алфавит метки: latin | cyrillic | "" (только цифры/дефис); смешанная или другой алфавит → None."""
    scripts = set()
    for ch in label:
        if ch.isdigit() or ch == "-":
            continue
        name = unicodedata.name(ch, "")
        if name.startswith("LATIN"):
            scripts.add("latin")
        elif name.startswith("CYRILLIC"):
            scripts.add("cyrillic")
        else:
            return None
    if len(scripts) > 1:
        return None
    return scripts.pop() if scripts else ""


def display_domain(ascii_domain: str) -> str:
    """Для показа: punycode → Unicode (xn--p1ai → рф), только если каждая метка целиком латиница или целиком
    кириллица; смешение алфавитов в метке (аpple.com с кириллической «а») и прочие алфавиты — punycode
    (защита от подмены похожими буквами). Ошибка декодирования → исходная строка."""
    try:
        shown = ascii_domain.encode("ascii").decode("idna")
    except (UnicodeError, ValueError):
        return ascii_domain
    if not shown or any(_label_script(label) is None for label in shown.split(".")):
        return ascii_domain
    return shown


class NewsSource(Params):
    """Источник новости обязателен (TG-FR-033, AT-33): имя, https-URL и домен; URL — на домене источника или его
    поддомене. Невалидный домен → источник невалиден (новость в выдачу/дайджест не попадает, AT-33)."""

    name: Annotated[str, Field(min_length=1, max_length=100)]
    domain: str
    url: Annotated[str, Field(min_length=12, max_length=500, pattern=r"^https://[^\s<>\"']+$")]

    @field_validator("domain", mode="before")
    @classmethod
    def _domain(cls, v: object) -> str:
        normalized = normalize_domain(v)
        if normalized is None:
            raise ValueError("невалидный домен источника")
        return normalized

    @model_validator(mode="after")
    def _url_on_domain(self) -> NewsSource:
        host = normalize_domain(urlsplit(self.url).hostname or "")
        if host is None or (host != self.domain and not host.endswith("." + self.domain)):
            raise ValueError("URL источника не на его домене")
        return self


class NewsEntry(Params):
    news_id: uuid.UUID | None = None
    title: Title
    source: NewsSource
    event_id: uuid.UUID | None = None  # первая привязка (NewsItem.event_ids[0]), если есть


class NewsDigestParams(Params):
    """Новости с невалидным источником (домен, URL не на домене, нет источника) отбрасываются по одной, а не
    роняют весь пакет; если не осталось ни одной — пакет невалиден (пустое не отправляется)."""

    items: Annotated[list[NewsEntry], Field(min_length=1, max_length=10)]

    @model_validator(mode="before")
    @classmethod
    def _drop_unverifiable(cls, data: Any) -> Any:
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            return data
        kept = []
        for raw in data["items"]:
            try:
                NewsEntry.model_validate(raw)
            except ValidationError:
                continue
            kept.append(raw)
        return {**data, "items": kept}


def _source_link(source: NewsSource, *, links: bool) -> str:
    name = esc(source.name)
    if links:
        name = f'<a href="{html.escape(source.url, quote=True)}">{name}</a>'
    shown = display_domain(source.domain)
    if len(shown) > DOMAIN_DISPLAY_MAX or shown.lower() == source.name.strip().lower():
        return name
    return f"{name} ({esc(shown)})"


def _news_digest(lang: str, p: NewsDigestParams) -> Rendered:
    head = (
        f"Новости по вашим событиям и интересам — {len(p.items)}:"
        if lang == "ru"
        else f"News on your events and interests — {len(p.items)}:"
    )

    def build(links: bool) -> str:
        lines = [f"• {esc(i.title)} — {_source_link(i.source, links=links)}" for i in p.items]
        return "\n".join([head, *lines])

    text = build(True)
    if len(text) > MAX_TEXT:
        text = build(False)
    button = [[{"text": "Все новости" if lang == "ru" else "All news", "startapp": "news"}]]
    return Rendered(text, button)


# ---------------------------------------------------------------- digest.daily (спринт 6, §5)

DIGEST_MAX_ITEMS = 10
DIGEST_TITLE_MAX = 120


class DigestWatchItem(Params):
    event_id: uuid.UUID
    event_title: Title
    tier: Literal["economy", "comfort", "premium"]
    price_usd: Money
    drop_usd: Money


class DigestDailyParams(Params):
    """Собирается сервисом (digest.py) из digest_queue: снижения цен (watch.price_drop) и новости (news.digest)."""

    date: datetime_date  # локальная дата пользователя (идемпотентность «один дайджест в день»)
    watch: Annotated[list[DigestWatchItem], Field(max_length=DIGEST_MAX_ITEMS)] = []
    news: Annotated[list[NewsEntry], Field(max_length=DIGEST_MAX_ITEMS)] = []
    more: Annotated[int, Field(ge=0, le=10_000)] = 0  # сверх 10 пунктов — «Ещё N — в приложении»

    @model_validator(mode="after")
    def _not_empty(self) -> DigestDailyParams:
        total = len(self.watch) + len(self.news)
        if total == 0:
            raise ValueError("пустой дайджест не отправляется")
        if total > DIGEST_MAX_ITEMS:
            raise ValueError("не больше 10 пунктов")
        return self


def _short(title: str) -> str:
    return title if len(title) <= DIGEST_TITLE_MAX else title[: DIGEST_TITLE_MAX - 1].rstrip() + "…"


def _digest_daily(lang: str, p: DigestDailyParams) -> Rendered:
    ru = lang == "ru"

    def build(links: bool) -> str:
        out = ["<b>Дайджест TilHero</b>" if ru else "<b>TilHero digest</b>"]
        if p.watch:
            out += ["", "<b>Слежения</b>" if ru else "<b>Watching</b>"]
            for w in p.watch:
                per = "на человека" if ru else "per person"
                out.append(
                    f"• <b>{esc(_short(w.event_title))}</b>: −{usd(w.drop_usd, lang)} → "
                    f"{TIERS[w.tier]} {usd(w.price_usd, lang)} {per}"
                )
        if p.news:
            out += ["", "<b>Новости</b>" if ru else "<b>News</b>"]
            out += [f"• {esc(_short(n.title))} — {_source_link(n.source, links=links)}" for n in p.news]
        if p.more:
            out += ["", f"Ещё {p.more} — в приложении." if ru else f"{p.more} more in the app."]
        return "\n".join(out)

    text = build(True)
    if len(text) > MAX_TEXT:  # длинные URL источников: имя источника без ссылки (лимит Telegram 4096)
        text = build(False)
    buttons: list[list[Button]] = []
    if len(p.watch) == 1 and not p.news:
        buttons.append(
            [{"text": "Открыть событие" if ru else "Open event", "startapp": event_startapp(p.watch[0].event_id)}]
        )
    row: list[Button] = []
    if p.watch:
        row.append({"text": "Слежения" if ru else "Watch", "startapp": "watch"})
    if p.news:
        row.append({"text": "Все новости" if ru else "All news", "startapp": "news"})
    buttons.append(row)
    return Rendered(text, buttons)


# ---------------------------------------------------------------- реестр


@dataclass(frozen=True)
class TemplateSpec:
    name: str
    params: type[Params]
    renderer: Callable[[str, Any], Rendered]
    # Отправлять даже при выключенных уведомлениях/неактивном статусе (только kind=transactional)
    bypass_preferences: bool = False
    # Секрет в параметрах: принимается только синхронным POST /internal/v1/notifications/transactional,
    # никогда через шину (код не должен лежать в outbox издателя и в JetStream — ревью P2)
    direct_only: bool = False
    # kind=digest: пункт копится в digest_queue и уходит в digest.daily (секция «Слежения» / «Новости»)
    digest_section: Literal["watch", "news"] | None = None
    # Собирается только самим сервисом (digest.daily) — по шине не принимается
    internal_only: bool = False

    def validate(self, params: dict[str, Any] | None) -> Params:
        try:
            return self.params.model_validate(params or {})
        except ValidationError as exc:
            raise TemplateError(f"invalid params for {self.name}") from exc

    def render(
        self, locale: str | None, params: dict[str, Any] | None, startapp: str | None = None
    ) -> Rendered:
        lang = lang_of(locale)
        rendered = self.renderer(lang, self.validate(params))
        if not rendered.buttons and startapp:
            return Rendered(
                rendered.text,
                [[{"text": "Открыть TilHero" if lang == "ru" else "Open TilHero", "startapp": startapp}]],
            )
        return rendered


TEMPLATES: dict[str, TemplateSpec] = {
    spec.name: spec
    for spec in (
        TemplateSpec("pin.reset_code", PinResetParams, _pin_reset, bypass_preferences=True, direct_only=True),
        TemplateSpec("support.reply", TicketParams, _support_reply),
        TemplateSpec("support.resolved", TicketParams, _support_resolved),
        TemplateSpec("watch.price_drop", PriceDropParams, _price_drop, digest_section="watch"),
        TemplateSpec("watch.critical", CriticalParams, _critical),
        TemplateSpec("news.digest", NewsDigestParams, _news_digest, digest_section="news"),
        TemplateSpec("digest.daily", DigestDailyParams, _digest_daily, internal_only=True),
    )
}

DIRECT_TEMPLATES = frozenset(name for name, spec in TEMPLATES.items() if spec.direct_only)

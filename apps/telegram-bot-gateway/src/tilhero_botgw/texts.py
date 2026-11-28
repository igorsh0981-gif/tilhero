"""Тексты бота RU/UZ (узбекская латиница) и сборка ссылок открытия Mini App.

Бот — только транспорт (решение заказчика №1): `/start [payload]` — приветствие с кнопкой «Открыть TilHero»;
прочие команды и текст — одна подсказка с той же кнопкой. Диалогов нет.

Спринт 8 (продажи за Telegram Stars; требование Telegram — payments-stars): `/paysupport` и `/support` — вопросы по
оплате в поддержке TilHero (кнопка на раздел «Поддержка» Mini App) и пояснение, что поддержка Telegram с покупками в
боте не помогает; `/terms` — оферта на домене Mini App; тексты отказа `pre_checkout_query`.
**Анти-стиринг (решение В1):** ни один текст не упоминает сайт оплаты, ссылок на него, другие способы оплаты, названия
фиатных провайдеров и цены в сумах (тест test_botgw_stars_webhook). Тексты `/paysupport` и `/terms` — черновики до
вычитки юристом (О6).
"""

from __future__ import annotations

import html
import re
from typing import Any, Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

Lang = Literal["ru", "uz"]
START_PARAM_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")  # формат startapp Telegram (fullmatch)
MAX_PAYLOAD = 64
# Белый список payload /start (start_param Mini App, bff.ts SessionResponse.start_param): приглашение (токен),
# согласие родителя (токен), раздел приложения, приглашение по id (напоминание), обращение в поддержку
PAYLOAD_RULES: tuple[re.Pattern[str], ...] = (
    re.compile(r"inv_[A-Za-z0-9_-]{16,60}"),
    re.compile(r"gc_[A-Za-z0-9_-]{16,61}"),
    re.compile(r"route_[a-z][a-z0-9_-]{0,31}"),
    re.compile(r"invite_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"),
    re.compile(r"ticket_TCK-\d{1,12}"),
)

TEXTS: dict[Lang, dict[str, str]] = {
    "ru": {
        "hello": "Привет, {name}! Всё обучение — в мини-приложении TilHero: занятия, график и напоминания. "
        "Откройте его кнопкой ниже.",
        "hello_anon": "Привет! Всё обучение — в мини-приложении TilHero: занятия, график и напоминания. "
        "Откройте его кнопкой ниже.",
        "hint": "Бот только открывает приложение и присылает напоминания. Всё остальное — в TilHero: "
        "нажмите кнопку ниже.",
        "open": "Открыть TilHero",
        # спринт 8: команды продаж за Stars (О6 — черновики до вычитки юристом)
        "paysupport": "Вопросы по оплате, подписке TilHero Плюс и тилам решает поддержка TilHero. Откройте приложение "
        "→ «Поддержка», опишите вопрос — ответ придёт в этот чат.\n\nПоддержка Telegram не помогает с покупками в "
        "ботах и мини-приложениях — пишите нам.",
        "support_button": "Написать в поддержку",
        "terms": "Условия покупки подписки TilHero Плюс и тилов — в публичной оферте TilHero. Перед оплатой приложение "
        "показывает условия и просит согласия с ними.",
        "terms_button": "Открыть оферту",
    },
    "uz": {
        "hello": "Salom, {name}! Butun taʼlim TilHero mini-ilovasida: mashgʻulotlar, jadval va eslatmalar. "
        "Uni quyidagi tugma orqali oching.",
        "hello_anon": "Salom! Butun taʼlim TilHero mini-ilovasida: mashgʻulotlar, jadval va eslatmalar. "
        "Uni quyidagi tugma orqali oching.",
        "hint": "Bot faqat ilovani ochadi va eslatmalar yuboradi. Qolgan hammasi TilHeroʼda — quyidagi tugmani "
        "bosing.",
        "open": "TilHeroʼni ochish",
        "paysupport": "Toʻlov, TilHero Plus obunasi va tillar boʻyicha savollarni TilHero qoʻllab-quvvatlash xizmati "
        "hal qiladi. Ilovani oching → «Qoʻllab-quvvatlash», savolingizni yozing — javob shu chatga keladi.\n\nTelegram "
        "qoʻllab-quvvatlash xizmati botlar va mini-ilovalardagi xaridlar boʻyicha yordam bermaydi — bizga yozing.",
        "support_button": "Qoʻllab-quvvatlashga yozish",
        "terms": "TilHero Plus obunasi va tillarni xarid qilish shartlari — TilHero ommaviy ofertasida. Toʻlovdan "
        "oldin ilova shartlarni koʻrsatadi va ularga roziligingizni soʻraydi.",
        "terms_button": "Ofertani ochish",
    },
}

BOT_COMMANDS: dict[Lang, list[dict[str, str]]] = {
    "ru": [
        {"command": "start", "description": "Открыть TilHero"},
        {"command": "paysupport", "description": "Вопросы по оплате"},
        {"command": "support", "description": "Поддержка"},
        {"command": "terms", "description": "Условия покупки"},
    ],
    "uz": [
        {"command": "start", "description": "TilHeroʼni ochish"},
        {"command": "paysupport", "description": "Toʻlov boʻyicha savollar"},
        {"command": "support", "description": "Qoʻllab-quvvatlash"},
        {"command": "terms", "description": "Xarid shartlari"},
    ],
}
SUPPORT_PAYLOAD = "route_support"  # раздел «Поддержка» Mini App (обращение по оплате — категория в приложении)

# Отказ pre_checkout_query (error_message, показывается пользователю): коды billing §1.5 + `unavailable` (таймаут, сбой,
# любая иная ошибка). Без упоминания других способов оплаты и сайта.
PRE_CHECKOUT_ERRORS: dict[Lang, dict[str, str]] = {
    "ru": {
        "order_not_found": "Счёт устарел или отменён. Откройте TilHero и оформите покупку заново.",
        "order_closed": "Счёт устарел или отменён. Откройте TilHero и оформите покупку заново.",
        "amount_mismatch": "Стоимость в счёте не совпадает с заказом. Оформите покупку заново в TilHero.",
        "payer_mismatch": "Этот счёт оформлен в другом аккаунте TilHero. Откройте TilHero и оформите покупку в своём "
        "профиле.",
        "already_paid": "Этот счёт уже оплачен — покупка появится в TilHero.",
        "subscription_exists": "Подписка TilHero Плюс уже активна. Управлять ею можно в TilHero → «Подписка».",
        "payments_disabled": "Покупки в TilHero сейчас недоступны. Попробуйте позже.",
        "unavailable": "Оплата временно недоступна. Попробуйте ещё раз через несколько минут.",
    },
    "uz": {
        "order_not_found": "Hisob eskirgan yoki bekor qilingan. TilHeroʼni oching va xaridni qaytadan "
        "rasmiylashtiring.",
        "order_closed": "Hisob eskirgan yoki bekor qilingan. TilHeroʼni oching va xaridni qaytadan rasmiylashtiring.",
        "amount_mismatch": "Hisob summasi buyurtmaga mos kelmaydi. Xaridni TilHeroʼda qaytadan rasmiylashtiring.",
        "payer_mismatch": "Bu hisob boshqa TilHero hisobida rasmiylashtirilgan. TilHeroʼni oching va xaridni oʻz "
        "profilingizda rasmiylashtiring.",
        "already_paid": "Bu hisob allaqachon toʻlangan — xarid TilHeroʼda koʻrinadi.",
        "subscription_exists": "TilHero Plus obunasi allaqachon faol. Uni TilHero → «Obuna» boʻlimida boshqarish "
        "mumkin.",
        "payments_disabled": "TilHeroʼda xaridlar hozir mavjud emas. Keyinroq urinib koʻring.",
        "unavailable": "Toʻlov vaqtincha mavjud emas. Bir necha daqiqadan soʻng qayta urinib koʻring.",
    },
}


def pre_checkout_error_text(lang: Lang, error: str | None) -> str:
    """Текст отказа pre_checkout_query: известный код billing — свой текст, остальное — «временно недоступна»."""
    texts = PRE_CHECKOUT_ERRORS[lang]
    return texts.get(error or "", texts["unavailable"])

DESCRIPTIONS: dict[Lang, dict[str, str]] = {
    "ru": {
        "description": (
            "TilHero — английский по 20 минут в день: короткие занятия по вашему графику, повторения и герой, "
            "который растёт вместе с вашими навыками. Всё работает в мини-приложении — нажмите «Открыть TilHero». "
            "Бот присылает напоминания о занятиях и ответы поддержки."
        ),
        "short": "Английский по 20 минут в день — в мини-приложении TilHero.",
    },
    "uz": {
        "description": (
            "TilHero — kuniga 20 daqiqa ingliz tili: jadvalingiz boʻyicha qisqa mashgʻulotlar, takrorlash va "
            "koʻnikmalaringiz bilan birga oʻsadigan qahramon. Hammasi mini-ilovada ishlaydi — «TilHeroʼni ochish» "
            "tugmasini bosing. Bot mashgʻulotlar haqida eslatmalar va qoʻllab-quvvatlash javoblarini yuboradi."
        ),
        "short": "Kuniga 20 daqiqa ingliz tili — TilHero mini-ilovasida.",
    },
}


def lang_of(language_code: str | None) -> Lang:
    """uz (в т.ч. «uz-Latn») → UZ, иначе RU: интерфейс TilHero — RU и UZ."""
    if not language_code:
        return "ru"
    return "uz" if language_code.split("-", 1)[0].strip().lower() == "uz" else "ru"


def t(lang: Lang, key: str, **params: str) -> str:
    text = TEXTS[lang][key]
    return text.format(**{k: html.escape(v, quote=False) for k, v in params.items()}) if params else text


def start_payload(arg: str) -> str | None:
    """Payload /start по белому списку префиксов и длине; иначе None (Mini App откроется без него)."""
    if not arg or len(arg) > MAX_PAYLOAD:
        return None
    return arg if any(rule.fullmatch(arg) for rule in PAYLOAD_RULES) else None


def webapp_url(base: str, startapp: str) -> str:
    """MINIAPP_URL?startapp=<раздел> с сохранением существующих параметров (кнопки web_app)."""
    if not START_PARAM_RE.fullmatch(startapp):
        raise ValueError("invalid startapp")
    parts = urlsplit(base)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "startapp"]
    query.append(("startapp", startapp))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def open_button(
    lang: Lang, miniapp_url: str, app_link: str | None, payload: str | None, *, text_key: str = "open"
) -> dict[str, Any]:
    """Кнопка «Открыть TilHero». С payload и TELEGRAM_APP_LINK — прямая ссылка t.me/<bot>/<app>?startapp=…
    (Telegram передаст payload в initData.start_param); без прямой ссылки — web_app на MINIAPP_URL?startapp=…;
    без payload — web_app на MINIAPP_URL."""
    text = t(lang, text_key)
    if payload is None:
        return {"text": text, "web_app": {"url": miniapp_url}}
    if not START_PARAM_RE.fullmatch(payload):
        raise ValueError("invalid startapp")
    if app_link:
        return {"text": text, "url": f"{app_link}?{urlencode({'startapp': payload})}"}
    return {"text": text, "web_app": {"url": webapp_url(miniapp_url, payload)}}

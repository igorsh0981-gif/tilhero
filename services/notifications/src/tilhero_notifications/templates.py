"""Шаблоны уведомлений TilHero RU/UZ (узбекская латиница, oʻ/gʻ — U+02BB, тутук — U+02BC).

Правила (INTERNAL_API §4, CONVENTIONS §8):
- каждый шаблон даёт title/body (обычный текст — для центра уведомлений, на языке ученика) и текст Telegram
  (HTML: `<b>title</b>` + body; КАЖДОЕ значение экранируется html.escape);
- детские варианты (`*.kid`) адресованы родителю, с именем ребёнка, мягкие: без «потери серии», «провала»,
  давления; прочих PII нет (только имя ребёнка родителю и имя пригласившего/принявшего);
- текст ответа оператора в уведомление не кладём — только номер обращения;
- кнопка «Открыть» (startapp): напоминание и пропуск → route_home; приглашение принято / новый участник
  семьи / отклонено → route_family; неотвеченное приглашение → invite_<invite_id>; поддержка → ticket_<number>;
  «Что нового» → route_news; решение по заявке на песню/фильм (спринт 3) → route_media_requests; решение по
  апелляции на оценку урока (спринт 4) → route_lessons;
- параметры проверяются строгой моделью при приёме (неизвестное поле/формат → failed params_invalid).

Спринт 2 (INTERNAL_API §3 «Шаблоны»): код — источник текстов по умолчанию; сотрудник создаёт версию поверх.
Редактируемые — все, кроме `direct_only`/`transactional` (pin.*). У редактируемого шаблона есть описание,
плейсхолдеры (`placeholder_names` + `placeholders(lang, params, ctx)` — значения уже на языке ученика) и образец
параметров (`sample`) — из него `default_texts()` и предпросмотр. При отрисовке активная версия заменяет
title/body/button (кнопка null — из кода), `startapp` всегда из кода; ошибка подстановки → текст из кода + лог.
"""

from __future__ import annotations

import html
import logging
import unicodedata
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from tilhero_notifications.domain.texts import RENDERED_LIMITS, TextError, substitute

log = logging.getLogger("tilhero.notifications.templates")

Lang = Literal["ru", "uz"]
Button = dict[str, str]
NAME_MAX = 40
MAX_TEXT = 4000  # bot-gateway: text ≤ 4096


class TemplateError(ValueError):
    pass


def lang_of(locale: str | None) -> Lang:
    """Интерфейс TilHero — RU и UZ; всё, кроме uz, — RU."""
    return "uz" if (locale or "").strip().lower().split("-", 1)[0] == "uz" else "ru"


def esc(value: object) -> str:
    return html.escape(str(value), quote=False)


def clean_name(value: object) -> str | None:
    """Имя для текста: без управляющих и форматирующих символов (в т.ч. bidi), пробелы схлопнуты, ≤ 40."""
    if not isinstance(value, str):
        return None
    kept = "".join(" " if ch.isspace() else ch for ch in value if unicodedata.category(ch)[0] != "C")
    name = " ".join(kept.split())[:NAME_MAX].strip()
    return name or None


def _days_ru(n: int) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} день"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return f"{n} дня"
    return f"{n} дней"


def _minutes_ru(n: int) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} минуту"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return f"{n} минуты"
    return f"{n} минут"


def _ddmm(d: date) -> str:
    return d.strftime("%d.%m")


def _sessions_ru(n: int) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} занятие"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return f"{n} занятия"
    return f"{n} занятий"


@dataclass(frozen=True)
class Context:
    """Имена, известные только в момент отрисовки (identity-consent)."""

    learner_name: str | None = None  # имя ребёнка — в сообщении родителю
    other_name: str | None = None  # пригласивший / принявший / новый участник семьи
    timezone: str | None = None  # часовой пояс адресата (DeliveryInfo.timezone) — даты в тексте по местному времени


@dataclass(frozen=True)
class Rendered:
    title: str
    body: str
    button: str
    startapp: str | None
    html: str | None = None  # особый текст Telegram (код PIN), иначе <b>title</b>\nbody

    def telegram_text(self) -> str:
        return self.html if self.html is not None else f"<b>{esc(self.title)}</b>\n{esc(self.body)}"

    def buttons(self) -> list[list[Button]]:
        return [[{"text": self.button, "startapp": self.startapp}]] if self.startapp else []


class Params(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


OPEN = {"ru": "Открыть TilHero", "uz": "TilHeroʼni ochish"}
START = {"ru": "Начать занятие", "uz": "Mashgʻulotni boshlash"}

# ---------------------------------------------------------------- lesson.* (learning-plan)


class ReminderParams(Params):
    local_date: date
    slot_time: Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]
    duration_min: Literal[10, 15, 20, 30]
    streak_days: Annotated[int, Field(ge=0, le=100_000)] | None = None


def _reminder(lang: Lang, p: ReminderParams, ctx: Context) -> Rendered:
    if lang == "ru":
        body = f"По графику — {_minutes_ru(p.duration_min)} английского. Начнём?"
        if p.streak_days and p.streak_days >= 2:
            body += f" Вы занимаетесь {_days_ru(p.streak_days)} подряд — отлично!"
        return Rendered("Время занятия", body, START[lang], "route_home")
    body = f"Jadval boʻyicha — {p.duration_min} daqiqa ingliz tili. Boshlaymizmi?"
    if p.streak_days and p.streak_days >= 2:
        body += f" Ketma-ket {p.streak_days} kun shugʻullanyapsiz — ajoyib!"
    return Rendered("Mashgʻulot vaqti", body, START[lang], "route_home")


def _reminder_kid(lang: Lang, p: ReminderParams, ctx: Context) -> Rendered:
    name = ctx.learner_name
    if lang == "ru":
        title = f"{name}: время занятия" if name else "Время занятия ребёнка"
        body = f"По графику — {_minutes_ru(p.duration_min)} английского. Позанимайтесь вместе — будет интересно!"
        return Rendered(title, body, START[lang], "route_home")
    title = f"{name}: mashgʻulot vaqti" if name else "Farzandingizning mashgʻulot vaqti"
    body = f"Jadval boʻyicha — {p.duration_min} daqiqa ingliz tili. Birga shugʻullaning — qiziqarli boʻladi!"
    return Rendered(title, body, START[lang], "route_home")


class MissedParams(Params):
    local_date: date
    consecutive_missed: Annotated[int, Field(ge=1, le=100_000)]
    next_slot_date: date | None = None


def _missed(lang: Lang, p: MissedParams, ctx: Context) -> Rendered:
    if lang == "ru":
        body = "Ничего страшного: сегодня хватит и 10 минут, чтобы не забыть пройденное."
        if p.next_slot_date:
            body += f" Следующее занятие по графику — {_ddmm(p.next_slot_date)}."
        return Rendered("Вчера занятия не было", body, START[lang], "route_home")
    body = "Hechqisi yoʻq: oʻtilganlarni unutmaslik uchun bugun 10 daqiqa ham yetadi."
    if p.next_slot_date:
        body += f" Jadval boʻyicha keyingi mashgʻulot — {_ddmm(p.next_slot_date)}."
    return Rendered("Kecha mashgʻulot boʻlmadi", body, START[lang], "route_home")


def _missed_kid(lang: Lang, p: MissedParams, ctx: Context) -> Rendered:
    name = ctx.learner_name
    if lang == "ru":
        title = f"{name}: продолжим заниматься?" if name else "Продолжим заниматься?"
        body = "Вчера занятия не было — это нормально. Сегодня можно вместе пройти короткое занятие на 10 минут."
        return Rendered(title, body, START[lang], "route_home")
    title = f"{name}: mashgʻulotni davom ettiramizmi?" if name else "Mashgʻulotni davom ettiramizmi?"
    body = "Kecha mashgʻulot boʻlmadi — bu tabiiy. Bugun birga 10 daqiqalik qisqa mashgʻulot qilish mumkin."
    return Rendered(title, body, START[lang], "route_home")


class ComebackParams(Params):
    local_date: date
    consecutive_missed: Annotated[int, Field(ge=1, le=100_000)]


def _comeback(lang: Lang, p: ComebackParams, ctx: Context) -> Rendered:
    if lang == "ru":
        return Rendered(
            "Возвращайтесь к занятиям",
            "Ваш план сохранён. Начните с короткого занятия на 10 минут — так легче вернуться в ритм.",
            START[lang],
            "route_home",
        )
    return Rendered(
        "Mashgʻulotlarga qayting",
        "Rejangiz saqlangan. 10 daqiqalik qisqa mashgʻulotdan boshlang — ritmga qaytish osonroq boʻladi.",
        START[lang],
        "route_home",
    )


def _comeback_kid(lang: Lang, p: ComebackParams, ctx: Context) -> Rendered:
    name = ctx.learner_name
    if lang == "ru":
        title = f"{name}: вернёмся к английскому?" if name else "Вернёмся к английскому?"
        body = "План занятий сохранён. Попробуйте вместе короткое занятие на 10 минут — это весело!"
        return Rendered(title, body, START[lang], "route_home")
    title = f"{name}: ingliz tiliga qaytamizmi?" if name else "Ingliz tiliga qaytamizmi?"
    body = "Mashgʻulotlar rejasi saqlangan. Birga 10 daqiqalik qisqa mashgʻulotni sinab koʻring — bu qiziqarli!"
    return Rendered(title, body, START[lang], "route_home")


# ---------------------------------------------------------------- invite.* / family.* (social)


class InviteParams(Params):
    invite_id: uuid.UUID
    kind: Literal["family", "friend", "referral"]


def _invite_accepted(lang: Lang, p: InviteParams, ctx: Context) -> Rendered:
    n = ctx.other_name
    if p.kind == "family":
        if lang == "ru":
            title = f"{n} теперь в вашей семье" if n else "Новый участник семьи"
            body = f"{n} принял(а) приглашение в семью TilHero." if n else "Ваше приглашение в семью TilHero приняли."
        else:
            title = f"{n} endi oilangizda" if n else "Oilada yangi aʼzo"
            body = (
                f"{n} TilHero oilasiga taklifingizni qabul qildi."
                if n
                else "TilHero oilasiga taklifingizni qabul qilishdi."
            )
    elif lang == "ru":
        title = "Приглашение принято"
        body = f"{n} принял(а) ваше приглашение в TilHero." if n else "Ваше приглашение в TilHero приняли."
    else:
        title = "Taklif qabul qilindi"
        body = f"{n} TilHeroʼga taklifingizni qabul qildi." if n else "TilHeroʼga taklifingizni qabul qilishdi."
    return Rendered(title, body, OPEN[lang], "route_family")


def _invite_declined(lang: Lang, p: InviteParams, ctx: Context) -> Rendered:
    if lang == "ru":
        return Rendered(
            "Приглашение отклонено",
            "Приглашение не приняли. Можно пригласить кого-нибудь ещё.",
            OPEN[lang],
            "route_family",
        )
    return Rendered(
        "Taklif rad etildi",
        "Taklif qabul qilinmadi. Boshqa birovni taklif qilishingiz mumkin.",
        OPEN[lang],
        "route_family",
    )


def _invite_pending(lang: Lang, p: InviteParams, ctx: Context) -> Rendered:
    n = ctx.other_name
    startapp = f"invite_{p.invite_id}"
    if lang == "ru":
        button = "Открыть приглашение"
        if p.kind == "family":
            title = "Вас пригласили в семью"
            lead = f"{n} приглашает вас в семью TilHero." if n else "Вас пригласили в семью TilHero."
        else:
            title = "Вас ждёт приглашение"
            lead = f"{n} приглашает вас в TilHero." if n else "Вас пригласили в TilHero."
        return Rendered(title, f"{lead} Откройте, чтобы принять или отклонить.", button, startapp)
    button = "Taklifni ochish"
    if p.kind == "family":
        title = "Sizni oilaga taklif qilishdi"
        lead = f"{n} sizni TilHero oilasiga taklif qilmoqda." if n else "Sizni TilHero oilasiga taklif qilishdi."
    else:
        title = "Sizni taklif kutmoqda"
        lead = f"{n} sizni TilHeroʼga taklif qilmoqda." if n else "Sizni TilHeroʼga taklif qilishdi."
    return Rendered(title, f"{lead} Qabul qilish yoki rad etish uchun oching.", button, startapp)


class FamilyParams(Params):
    family_id: uuid.UUID
    role: Literal["adult", "teen"]


def _family_joined(lang: Lang, p: FamilyParams, ctx: Context) -> Rendered:
    n = ctx.other_name
    if lang == "ru":
        body = f"{n} теперь в вашей семье TilHero." if n else "В вашей семье TilHero новый участник."
        return Rendered("Новый участник семьи", body, OPEN[lang], "route_family")
    body = f"{n} endi TilHero oilangizda." if n else "TilHero oilangizda yangi aʼzo bor."
    return Rendered("Oilada yangi aʼzo", body, OPEN[lang], "route_family")


# ---------------------------------------------------------------- support.*


class TicketParams(Params):
    number: Annotated[str, Field(pattern=r"^TCK-\d{1,12}$")]


TICKET_BUTTON = {"ru": "Открыть обращение", "uz": "Murojaatni ochish"}


def _support_reply(lang: Lang, p: TicketParams, ctx: Context) -> Rendered:
    if lang == "ru":
        title, body = "Ответ поддержки", f"Поддержка ответила на обращение {p.number}. Откройте, чтобы прочитать."
    else:
        title = "Qoʻllab-quvvatlash javobi"
        body = f"Qoʻllab-quvvatlash {p.number} murojaatiga javob berdi. Oʻqish uchun oching."
    return Rendered(title, body, TICKET_BUTTON[lang], f"ticket_{p.number}")


def _support_resolved(lang: Lang, p: TicketParams, ctx: Context) -> Rendered:
    if lang == "ru":
        title = "Обращение решено"
        body = f"Обращение {p.number} решено. Если вопрос остался — ответьте в обращении, и мы продолжим."
    else:
        title = "Murojaat hal qilindi"
        body = f"{p.number} murojaati hal qilindi. Savol qolgan boʻlsa, murojaatda javob yozing — davom etamiz."
    return Rendered(title, body, TICKET_BUTTON[lang], f"ticket_{p.number}")


# ---------------------------------------------------------------- release_note (experience-config, только центр)


class ReleaseNoteParams(Params):
    release_note_id: uuid.UUID
    slug: Annotated[str, Field(min_length=1, max_length=200)]


def _release_note(lang: Lang, p: ReleaseNoteParams, ctx: Context) -> Rendered:
    if lang == "ru":
        return Rendered(
            "Что нового в TilHero",
            "В приложении появились обновления — посмотрите, что изменилось.",
            "Посмотреть",
            "route_news",
        )
    return Rendered(
        "TilHeroʼda yangiliklar", "Ilovada yangilanishlar bor — nimalar oʻzgarganini koʻring.", "Koʻrish", "route_news"
    )


# ---------------------------------------------------------------- media_request.decided (catalog, спринт 3)

MediaDecision = Literal["authored_alternative", "licensed", "rejected", "duplicate"]
REQUEST_TITLE_MAX = 80  # название из заявки в тексте — коротко (в заявке до 200)


class MediaRequestParams(Params):
    """Решение по заявке ученика на песню/фильм (AT-30). Комментарий сотрудника в уведомление не кладётся (его нет в
    событии; ученик читает его в Mini App на экране заявок) — как текст ответа поддержки."""

    request_id: uuid.UUID
    request_title: Annotated[str, Field(min_length=1, max_length=200)]
    status: MediaDecision
    linked_asset_id: Annotated[str, Field(max_length=200)] | None = None


DECISION_NAMES: dict[str, dict[str, str]] = {
    "authored_alternative": {"ru": "подобран авторский аналог", "uz": "oʻxshash mualliflik materiali tanlandi"},
    "licensed": {"ru": "материал лицензирован и добавлен", "uz": "material litsenziyalanib qoʻshildi"},
    "rejected": {"ru": "заявка отклонена", "uz": "soʻrov rad etildi"},
    "duplicate": {"ru": "такая заявка уже есть", "uz": "bunday soʻrov allaqachon bor"},
}
REQUESTS_BUTTON = {"ru": "Открыть заявки", "uz": "Soʻrovlarni ochish"}


def short_title(value: str) -> str:
    """Название из заявки ученика: без управляющих символов, пробелы схлопнуты, ≤ 80 символов (с «…»)."""
    text = clean_text(value)
    return text if len(text) <= REQUEST_TITLE_MAX else text[: REQUEST_TITLE_MAX - 1].rstrip() + "…"


def _media_request_values(lang: Lang, p: MediaRequestParams, ctx: Context) -> dict[str, str]:
    return {"request_title": short_title(p.request_title), "decision": DECISION_NAMES[p.status][lang]}


def _media_request_decided(lang: Lang, p: MediaRequestParams, ctx: Context) -> Rendered:
    v = _media_request_values(lang, p, ctx)
    if lang == "ru":
        body = f"Решение по заявке «{v['request_title']}»: {v['decision']}. Подробности — в разделе заявок."
        return Rendered("Решение по вашей заявке", body, REQUESTS_BUTTON[lang], "route_media_requests")
    body = f"«{v['request_title']}» soʻrovi boʻyicha qaror: {v['decision']}. Batafsil — soʻrovlar boʻlimida."
    return Rendered("Soʻrovingiz boʻyicha qaror", body, REQUESTS_BUTTON[lang], "route_media_requests")


# ---------------------------------------------------------------- appeal_decided (assessment, спринт 4)

AppealDecision = Literal["upheld", "corrected"]


class AppealParams(Params):
    """Решение по апелляции ученика на оценку урока (AT-47): оценка верна (upheld) или исправлена (corrected).
    Текст решения сотрудника (decision_note) в уведомление не кладётся — его нет в событии; ученик читает его в
    Mini App на экране оценки, как ответ поддержки."""

    appeal_id: uuid.UUID
    evaluation_id: uuid.UUID
    decision: AppealDecision


APPEAL_RESULTS: dict[str, dict[str, str]] = {
    "upheld": {"ru": "оценка верна", "uz": "baho toʻgʻri"},
    "corrected": {"ru": "оценка исправлена", "uz": "baho tuzatildi"},
}
LESSONS_BUTTON = {"ru": "Открыть уроки", "uz": "Darslarni ochish"}
LESSONS_ROUTE = "route_lessons"


def _appeal_values(lang: Lang, p: AppealParams, ctx: Context) -> dict[str, str]:
    return {"appeal_result": APPEAL_RESULTS[p.decision][lang]}


def _appeal_kid_values(lang: Lang, p: AppealParams, ctx: Context) -> dict[str, str]:
    return {"learner_name": ctx.learner_name or KID_NAME[lang], **_appeal_values(lang, p, ctx)}


def _appeal_decided(lang: Lang, p: AppealParams, ctx: Context) -> Rendered:
    result = APPEAL_RESULTS[p.decision][lang]
    if lang == "ru":
        body = f"Мы проверили вашу оценку урока: {result}."
        if p.decision == "corrected":
            body = f"Мы проверили вашу оценку урока: {result}, посмотрите обновлённый результат."
        return Rendered("Оценка урока проверена", body, LESSONS_BUTTON[lang], LESSONS_ROUTE)
    body = f"Dars bahongizni tekshirdik: {result}."
    if p.decision == "corrected":
        body = f"Dars bahongizni tekshirdik: {result}, yangilangan natijani koʻring."
    return Rendered("Dars bahosi tekshirildi", body, LESSONS_BUTTON[lang], LESSONS_ROUTE)


def _appeal_decided_kid(lang: Lang, p: AppealParams, ctx: Context) -> Rendered:
    """Родителю, с именем ребёнка, мягко (CONVENTIONS §8): без «провала» и давления."""
    name = ctx.learner_name
    result = APPEAL_RESULTS[p.decision][lang]
    if lang == "ru":
        title = f"{name}: оценка урока проверена" if name else "Оценка урока ребёнка проверена"
        body = f"Мы проверили оценку урока: {result}."
        if p.decision == "corrected":
            body = f"Мы проверили оценку урока: {result}, посмотрите обновлённый результат вместе."
        return Rendered(title, body, LESSONS_BUTTON[lang], LESSONS_ROUTE)
    title = f"{name}: dars bahosi tekshirildi" if name else "Farzandingizning dars bahosi tekshirildi"
    body = f"Dars bahosini tekshirdik: {result}."
    if p.decision == "corrected":
        body = f"Dars bahosini tekshirdik: {result}, yangilangan natijani birga koʻring."
    return Rendered(title, body, LESSONS_BUTTON[lang], LESSONS_ROUTE)


# ---------------------------------------------------------------- pin.reset_code (transactional, не в центре)


class PinResetParams(Params):
    code: Annotated[str, Field(pattern=r"^\d{6}$")]
    ttl_minutes: Annotated[int, Field(ge=1, le=60)] = 10  # срок кода — из настроек identity-consent


def _pin_reset(lang: Lang, p: PinResetParams, ctx: Context) -> Rendered:
    if lang == "ru":
        text = (
            f"Код для сброса PIN-кода родителя в TilHero: <b>{esc(p.code)}</b>. Никому не сообщайте его. "
            f"Действует {_minutes_ru(p.ttl_minutes)}. Новый PIN-код заработает через 24 часа."
        )
        return Rendered("Код для сброса PIN-кода", "", OPEN[lang], None, html=text)
    text = (
        f"TilHero ota-ona PIN-kodini tiklash kodi: <b>{esc(p.code)}</b>. Uni hech kimga aytmang. "
        f"{p.ttl_minutes} daqiqa amal qiladi. Yangi PIN-kod 24 soatdan keyin ishlaydi."
    )
    return Rendered("PIN-kodni tiklash kodi", "", OPEN[lang], None, html=text)


class PinResetScheduledParams(Params):
    effective_at: datetime


def _local(dt: datetime, tz: str | None) -> datetime:
    try:
        zone = ZoneInfo(tz or "Asia/Tashkent")
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("Asia/Tashkent")
    return dt.astimezone(zone)


def _pin_reset_scheduled(lang: Lang, p: PinResetScheduledParams, ctx: Context) -> Rendered:
    """Ревью T-8: сброс кода родителя через бота вступает в силу через 24 ч; без кода и без PII."""
    at = _local(p.effective_at, ctx.timezone).strftime("%d.%m %H:%M")
    if lang == "ru":
        text = (
            f"<b>Запрошен сброс кода родителя</b>\nНовый код начнёт действовать {at}. Если это не вы — откройте "
            "TilHero и введите прежний код: сброс отменится."
        )
        return Rendered("Запрошен сброс кода родителя", "", OPEN[lang], "route_profile", html=text)
    text = (
        f"<b>Ota-ona kodini tiklash soʻraldi</b>\nYangi kod {at} dan amal qiladi. Agar bu siz boʻlmasangiz — "
        "TilHeroʼni oching va avvalgi kodni kiriting: tiklash bekor qilinadi."
    )
    return Rendered("Ota-ona kodini tiklash soʻraldi", "", OPEN[lang], "route_profile", html=text)


# ---------------------------------------------------------------- плейсхолдеры версий (спринт 2)

# name → (описание RU, описание EN) — для TemplateInfo.placeholders
PLACEHOLDER_DESCRIPTIONS: dict[str, tuple[str, str]] = {
    "learner_name": (
        "Имя ребёнка (сообщение родителю); если неизвестно — «Ваш ребёнок»",
        "Child's name (message to the parent); “Your child” if unknown",
    ),
    "duration": ("Длительность занятия по графику, например «15 минут»", "Scheduled lesson length, e.g. “15 minutes”"),
    "slot_time": ("Время занятия по графику, ЧЧ:ММ", "Scheduled lesson time, HH:MM"),
    "streak_days": (
        "Сколько дней подряд ученик занимается, например «5 дней» (0 — серии нет)",
        "Days in a row with lessons, e.g. “5 days” (0 — no streak)",
    ),
    "missed_sessions": ("Сколько занятий подряд пропущено, например «2 занятия»", "Lessons missed in a row"),
    "next_slot_date": (
        "Дата следующего занятия по графику, ДД.ММ (пусто — не запланировано)",
        "Next scheduled lesson date, DD.MM (empty if none)",
    ),
    "inviter_name": ("Имя пригласившего; если неизвестно — «Ваш знакомый»", "Inviter's name; generic if unknown"),
    "invitee_name": (
        "Имя принявшего приглашение; если неизвестно — «Приглашённый»",
        "Name of the person who accepted; generic if unknown",
    ),
    "member_name": (
        "Имя нового участника семьи; если неизвестно — «Новый участник»",
        "New family member's name; generic if unknown",
    ),
    "ticket_number": ("Номер обращения, например TCK-3081", "Support ticket number, e.g. TCK-3081"),
    "request_title": (
        "Название песни или фильма из заявки ученика (до 80 символов)",
        "Song or movie title from the learner's request (up to 80 characters)",
    ),
    "decision": (
        "Решение по заявке на языке ученика, например «подобран авторский аналог»",
        "Decision in the learner's language, e.g. “authored alternative found”",
    ),
    "appeal_result": (
        "Итог проверки оценки урока на языке ученика: «оценка верна» или «оценка исправлена»",
        "Result of the lesson grade review in the learner's language: “grade is correct” or “grade corrected”",
    ),
}
KID_NAME = {"ru": "Ваш ребёнок", "uz": "Farzandingiz"}
INVITER_NAME = {"ru": "Ваш знакомый", "uz": "Tanishingiz"}
INVITEE_NAME = {"ru": "Приглашённый", "uz": "Taklif qilingan kishi"}
MEMBER_NAME = {"ru": "Новый участник", "uz": "Yangi aʼzo"}
# Образцы имён для текстов по умолчанию и предпросмотра (на языке шаблона)
SAMPLE_CONTEXT: dict[str, Context] = {
    "ru": Context(learner_name="Мадина", other_name="Алишер", timezone="Asia/Tashkent"),
    "uz": Context(learner_name="Madina", other_name="Alisher", timezone="Asia/Tashkent"),
}
_SAMPLE_ID = "3f2b8c1e-6a4d-4e0b-9c71-2d5e8f1a7b90"


def _reminder_values(lang: Lang, p: ReminderParams, ctx: Context) -> dict[str, str]:
    streak = p.streak_days or 0
    if lang == "ru":
        return {"duration": _minutes_ru(p.duration_min), "slot_time": p.slot_time, "streak_days": _days_ru(streak)}
    return {"duration": f"{p.duration_min} daqiqa", "slot_time": p.slot_time, "streak_days": f"{streak} kun"}


def _reminder_kid_values(lang: Lang, p: ReminderParams, ctx: Context) -> dict[str, str]:
    # Серия детям не показывается (CONVENTIONS §8): плейсхолдера streak_days у детского шаблона нет
    values = _reminder_values(lang, p, ctx)
    return {"learner_name": ctx.learner_name or KID_NAME[lang], "duration": values["duration"],
            "slot_time": values["slot_time"]}


def _missed_values(lang: Lang, p: MissedParams, ctx: Context) -> dict[str, str]:
    count = _sessions_ru(p.consecutive_missed) if lang == "ru" else f"{p.consecutive_missed} ta mashgʻulot"
    return {"missed_sessions": count, "next_slot_date": _ddmm(p.next_slot_date) if p.next_slot_date else ""}


def _missed_kid_values(lang: Lang, p: MissedParams, ctx: Context) -> dict[str, str]:
    return {"learner_name": ctx.learner_name or KID_NAME[lang],
            "next_slot_date": _ddmm(p.next_slot_date) if p.next_slot_date else ""}


def _comeback_values(lang: Lang, p: ComebackParams, ctx: Context) -> dict[str, str]:
    return {"missed_sessions": _sessions_ru(p.consecutive_missed) if lang == "ru"
            else f"{p.consecutive_missed} ta mashgʻulot"}


def _comeback_kid_values(lang: Lang, p: ComebackParams, ctx: Context) -> dict[str, str]:
    return {"learner_name": ctx.learner_name or KID_NAME[lang]}


def _invitee_values(lang: Lang, p: InviteParams, ctx: Context) -> dict[str, str]:
    return {"invitee_name": ctx.other_name or INVITEE_NAME[lang]}


def _inviter_values(lang: Lang, p: InviteParams, ctx: Context) -> dict[str, str]:
    return {"inviter_name": ctx.other_name or INVITER_NAME[lang]}


def _member_values(lang: Lang, p: FamilyParams, ctx: Context) -> dict[str, str]:
    return {"member_name": ctx.other_name or MEMBER_NAME[lang]}


def _ticket_values(lang: Lang, p: TicketParams, ctx: Context) -> dict[str, str]:
    return {"ticket_number": p.number}


def _no_values(lang: Lang, p: Params, ctx: Context) -> dict[str, str]:
    return {}


@dataclass(frozen=True)
class TextOverride:
    """Активная версия шаблона: тексты сотрудника {ru|uz: {title, body, button|None}}."""

    key: str
    version: int
    texts: Mapping[str, Mapping[str, str | None]]


# ---------------------------------------------------------------- реестр

Category = Literal["reminders", "missed", "social", "support", "product", "service"]
Placeholders = Callable[[Lang, Any, Context], dict[str, str]]


@dataclass(frozen=True)
class TemplateSpec:
    name: str
    category: Category
    params: type[Params]
    renderer: Callable[[Lang, Any, Context], Rendered]
    # Детский вариант (адресат — опекун, имя ребёнка): выбирается при отрисовке, если ученик 6–13
    kid_variant: str | None = None
    # Запись видна в центре уведомлений (код PIN — нет)
    in_app: bool = True
    # Проверять категорию у ученика (у отклонённого приглашения категория «—», §4)
    gated: bool = True
    # Отправлять сразу и мимо настроек/тихих часов/статуса (только kind=transactional)
    transactional: bool = False
    # Секрет в параметрах: только синхронный POST /internal/v1/notifications/transactional, никогда через шину
    direct_only: bool = False
    # Спринт 2 — версии сотрудников: описание (RU, EN), плейсхолдеры и их значения на языке ученика, образец
    # параметров для текстов по умолчанию и предпросмотра
    description: tuple[str, str] = ("", "")
    placeholder_names: tuple[str, ...] = ()
    placeholders: Placeholders = _no_values
    sample: dict[str, Any] = field(default_factory=dict)

    @property
    def editable(self) -> bool:
        return not (self.direct_only or self.transactional)

    @property
    def kid(self) -> bool:
        return self.name.endswith(".kid")

    def validate(self, params: dict[str, Any] | None) -> Params:
        try:
            return self.params.model_validate(params or {})
        except ValidationError as exc:
            raise TemplateError(f"invalid params for {self.name}") from exc

    def values(self, lang: Lang, params: Params, ctx: Context) -> dict[str, str]:
        """Значения плейсхолдеров на языке ученика: имена очищены, ровно `placeholder_names`."""
        raw = self.placeholders(lang, params, ctx)
        return {name: clean_text(raw.get(name, "")) for name in self.placeholder_names}

    def render(
        self,
        locale: str | None,
        params: dict[str, Any] | None,
        ctx: Context | None = None,
        override: TextOverride | None = None,
    ) -> Rendered:
        lang = lang_of(locale)
        validated = self.validate(params)
        context = ctx or Context()
        rendered = self.renderer(lang, validated, context)
        if override is not None and self.editable:
            try:
                rendered = self.apply(lang, validated, context, rendered, override.texts)
            except TextError as exc:
                # Не падать: текст из кода (активная версия могла пережить изменение плейсхолдеров в коде)
                log.warning("template version render failed, code text used",
                            extra={"template": self.name, "version": override.version, "error": str(exc)})
        if len(rendered.telegram_text()) > MAX_TEXT:
            raise TemplateError(f"text too long for {self.name}")
        return rendered

    def apply(
        self, lang: Lang, params: Params, ctx: Context, base: Rendered, texts: Mapping[str, Any]
    ) -> Rendered:
        """Тексты сотрудника поверх кода: подстановка строго из `values()`; `startapp` и кнопка по умолчанию — из
        кода. TextError — подставить нельзя (вызывающий берёт текст из кода)."""
        item = texts.get(lang)
        if not isinstance(item, Mapping):
            raise TextError("language missing")
        values = self.values(lang, params, ctx)
        return fill(item, values, default_button=base.button, startapp=base.startapp)


def clean_text(value: object) -> str:
    """Значение плейсхолдера в текст: без управляющих/форматирующих символов, пробелы схлопнуты."""
    if not isinstance(value, str):
        return ""
    kept = "".join(
        " " if ch.isspace() else ch for ch in value if ch.isspace() or unicodedata.category(ch)[0] != "C"
    )
    return " ".join(kept.split())


def fill(
    item: Mapping[str, Any], values: Mapping[str, str], *, default_button: str, startapp: str | None
) -> Rendered:
    """{title, body, button|None} + значения → Rendered (простой текст; экранирование — в telegram_text())."""
    title = substitute(str(item.get("title") or ""), values)
    body = substitute(str(item.get("body") or ""), values)
    raw_button = item.get("button")
    button = substitute(raw_button, values) if isinstance(raw_button, str) and raw_button else default_button
    if not title or not body or not button:
        raise TextError("empty text after substitution")
    if (len(title) > RENDERED_LIMITS["title"] or len(body) > RENDERED_LIMITS["body"]
            or len(button) > RENDERED_LIMITS["button"]):
        raise TextError("text too long after substitution")
    return Rendered(title, body, button, startapp)


def default_texts(spec: TemplateSpec) -> dict[str, dict[str, str | None]]:
    """Тексты по умолчанию (TemplateInfo.default_texts) — текущие рендереры кода на образцах."""
    out: dict[str, dict[str, str | None]] = {}
    for lang in ("ru", "uz"):
        r = spec.render(lang, spec.sample, SAMPLE_CONTEXT[lang])
        out[lang] = {"title": r.title, "body": r.body, "button": r.button}
    return out


def sample_values(spec: TemplateSpec, lang: Lang) -> dict[str, str]:
    return spec.values(lang, spec.validate(spec.sample), SAMPLE_CONTEXT[lang])


# ---------------------------------------------------------------- рассылки (кампании) — тексты из БД

CAMPAIGN_TEMPLATE = "campaign"  # notifications.template у записей рассылки (kind=campaign)
CAMPAIGN_PLACEHOLDERS = ("learner_name",)
CAMPAIGN_SAMPLE = {"ru": {"learner_name": "Алишер"}, "uz": {"learner_name": "Alisher"}}


class CampaignParams(Params):
    campaign_id: uuid.UUID


def _campaign_from_db(lang: Lang, p: CampaignParams, ctx: Context) -> Rendered:
    raise TemplateError("campaign texts are rendered from the campaigns table")


# Не входит в TEMPLATES (не редактируется как шаблон): описание записи журнала рассылки для обработчика —
# категория product (проверяется у ученика), видна в центре уведомлений
CAMPAIGN_SPEC = TemplateSpec(CAMPAIGN_TEMPLATE, "product", CampaignParams, _campaign_from_db)


def render_campaign(
    lang: Lang, texts: Mapping[str, Any], route: str | None, learner_name: str | None
) -> Rendered:
    """Рассылка: плейсхолдер только {learner_name} (нет имени — пустая строка, пробелы схлопываются); кнопка — при
    заданном маршруте (`route_<route>`), текст кнопки null — «Открыть TilHero». TextError — текст не отрисовать."""
    item = texts.get(lang)
    if not isinstance(item, Mapping):
        raise TextError("language missing")
    values = {"learner_name": clean_text(learner_name or "")}
    startapp = f"route_{route}" if route else None
    rendered = fill(item, values, default_button=OPEN[lang], startapp=startapp)
    if len(rendered.telegram_text()) > MAX_TEXT:
        raise TextError("text too long")
    return rendered


TEMPLATES: dict[str, TemplateSpec] = {
    spec.name: spec
    for spec in (
        TemplateSpec(
            "lesson.reminder", "reminders", ReminderParams, _reminder, kid_variant="lesson.reminder.kid",
            description=("Напоминание о занятии в слот графика", "Lesson reminder at the scheduled slot"),
            placeholder_names=("duration", "slot_time", "streak_days"), placeholders=_reminder_values,
            sample={"local_date": "2026-11-20", "slot_time": "19:00", "duration_min": 15, "streak_days": 5},
        ),
        TemplateSpec(
            "lesson.reminder.kid", "reminders", ReminderParams, _reminder_kid,
            description=("Напоминание о занятии ребёнка — родителю", "Child's lesson reminder — to the parent"),
            placeholder_names=("learner_name", "duration", "slot_time"), placeholders=_reminder_kid_values,
            sample={"local_date": "2026-11-20", "slot_time": "17:00", "duration_min": 15},
        ),
        TemplateSpec(
            "lesson.missed", "missed", MissedParams, _missed, kid_variant="lesson.missed.kid",
            description=("Занятие по графику пропущено (утром следующего дня)",
                         "Scheduled lesson missed (next morning)"),
            placeholder_names=("missed_sessions", "next_slot_date"), placeholders=_missed_values,
            sample={"local_date": "2026-11-20", "consecutive_missed": 2, "next_slot_date": "2026-11-22"},
        ),
        TemplateSpec(
            "lesson.missed.kid", "missed", MissedParams, _missed_kid,
            description=("Ребёнок пропустил занятие — родителю, мягко",
                         "Child missed a lesson — gentle, to the parent"),
            placeholder_names=("learner_name", "next_slot_date"), placeholders=_missed_kid_values,
            sample={"local_date": "2026-11-20", "consecutive_missed": 1, "next_slot_date": "2026-11-22"},
        ),
        TemplateSpec(
            "lesson.comeback", "missed", ComebackParams, _comeback, kid_variant="lesson.comeback.kid",
            description=("Возврат после 4+ пропусков подряд (не чаще раза в 7 дней)",
                         "Comeback after 4+ missed lessons (at most weekly)"),
            placeholder_names=("missed_sessions",), placeholders=_comeback_values,
            sample={"local_date": "2026-11-20", "consecutive_missed": 5},
        ),
        TemplateSpec(
            "lesson.comeback.kid", "missed", ComebackParams, _comeback_kid,
            description=("Возврат ребёнка к занятиям — родителю, мягко", "Child's comeback — gentle, to the parent"),
            placeholder_names=("learner_name",), placeholders=_comeback_kid_values,
            sample={"local_date": "2026-11-20", "consecutive_missed": 5},
        ),
        TemplateSpec(
            "invite.accepted", "social", InviteParams, _invite_accepted,
            description=("Приглашение принято — пригласившему", "Invitation accepted — to the inviter"),
            placeholder_names=("invitee_name",), placeholders=_invitee_values,
            sample={"invite_id": _SAMPLE_ID, "kind": "friend"},
        ),
        TemplateSpec(
            "invite.declined", "social", InviteParams, _invite_declined, gated=False,
            description=("Приглашение отклонено — пригласившему, только центр уведомлений",
                         "Invitation declined — to the inviter, in-app only"),
            sample={"invite_id": _SAMPLE_ID, "kind": "friend"},
        ),
        TemplateSpec(
            "invite.pending", "social", InviteParams, _invite_pending,
            description=("Напоминание о неотвеченном приглашении — получателю",
                         "Reminder about a pending invitation — to the invitee"),
            placeholder_names=("inviter_name",), placeholders=_inviter_values,
            sample={"invite_id": _SAMPLE_ID, "kind": "family"},
        ),
        TemplateSpec(
            "family.joined", "social", FamilyParams, _family_joined,
            description=("Новый участник семьи — владельцу семьи", "New family member — to the family owner"),
            placeholder_names=("member_name",), placeholders=_member_values,
            sample={"family_id": _SAMPLE_ID, "role": "adult"},
        ),
        TemplateSpec(
            "support.reply", "support", TicketParams, _support_reply,
            description=("Поддержка ответила на обращение (без текста ответа)",
                         "Support replied to a ticket (no reply text)"),
            placeholder_names=("ticket_number",), placeholders=_ticket_values, sample={"number": "TCK-3081"},
        ),
        TemplateSpec(
            "support.resolved", "support", TicketParams, _support_resolved,
            description=("Обращение решено", "Ticket resolved"),
            placeholder_names=("ticket_number",), placeholders=_ticket_values, sample={"number": "TCK-3081"},
        ),
        TemplateSpec(
            "media_request.decided", "support", MediaRequestParams, _media_request_decided,
            description=("Решение по заявке на песню или фильм (без комментария сотрудника)",
                         "Decision on a song/movie request (without the staff comment)"),
            placeholder_names=("request_title", "decision"), placeholders=_media_request_values,
            sample={"request_id": _SAMPLE_ID, "request_title": "Moonlight Café", "status": "authored_alternative",
                    "linked_asset_id": "m-own-coffee-order"},
        ),
        TemplateSpec(
            "appeal_decided", "support", AppealParams, _appeal_decided, kid_variant="appeal_decided.kid",
            description=("Решение по апелляции на оценку урока: оценка верна или исправлена (без текста решения)",
                         "Decision on a lesson grade appeal: upheld or corrected (without the staff note)"),
            placeholder_names=("appeal_result",), placeholders=_appeal_values,
            sample={"appeal_id": _SAMPLE_ID, "evaluation_id": _SAMPLE_ID, "decision": "corrected"},
        ),
        TemplateSpec(
            "appeal_decided.kid", "support", AppealParams, _appeal_decided_kid,
            description=("Решение по апелляции на оценку урока ребёнка — родителю, мягко",
                         "Decision on a child's lesson grade appeal — gentle, to the parent"),
            placeholder_names=("learner_name", "appeal_result"), placeholders=_appeal_kid_values,
            sample={"appeal_id": _SAMPLE_ID, "evaluation_id": _SAMPLE_ID, "decision": "upheld"},
        ),
        TemplateSpec(
            "release_note.published", "product", ReleaseNoteParams, _release_note,
            description=("«Что нового» в центре уведомлений", "“What's new” in the in-app notification center"),
            sample={"release_note_id": _SAMPLE_ID, "slug": "2026.11"},
        ),
        TemplateSpec(
            "pin.reset_scheduled",
            "service",
            PinResetScheduledParams,
            _pin_reset_scheduled,
            in_app=False,
            transactional=True,
            direct_only=True,
        ),
        TemplateSpec(
            "pin.reset_code",
            "service",
            PinResetParams,
            _pin_reset,
            in_app=False,
            transactional=True,
            direct_only=True,
        ),
    )
}

KID_TEMPLATES = frozenset(spec.kid_variant for spec in TEMPLATES.values() if spec.kid_variant)
DIRECT_TEMPLATES = frozenset(name for name, spec in TEMPLATES.items() if spec.direct_only)
# Редактируемые сотрудниками (admin.ts «Шаблоны уведомлений»): всё, кроме служебных pin.*
EDITABLE = tuple(name for name, spec in TEMPLATES.items() if spec.editable)

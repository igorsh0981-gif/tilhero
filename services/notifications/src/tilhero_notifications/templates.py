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
  апелляции на оценку урока (спринт 4) → route_lessons; слова к повторению (спринт 5) → route_review;
  игра (спринт 6): заморозка серии и ступень героя → route_home, новый значок → route_progress;
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

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

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


# ---------------------------------------------------------------- reviews_due (memory, спринт 5)

REVIEW_BUTTON = {"ru": "Повторить", "uz": "Takrorlash"}
REVIEW_ROUTE = "route_review"
REVIEW_MINUTES_MIN, REVIEW_MINUTES_MAX = 2, 15


class ReviewsDueParams(Params):
    """Вечернее напоминание о повторении (AT-59): сколько карточек к сроку на местную дату. Слов и текстов ученика
    в параметрах нет — только число."""

    local_date: date
    due_count: Annotated[int, Field(ge=1, le=2000)]


def review_minutes(due_count: int) -> int:
    """Примерное время «Повторения дня»: ceil(due_count × 0,4), не меньше 2 и не больше 15 минут."""
    return max(REVIEW_MINUTES_MIN, min(REVIEW_MINUTES_MAX, -(-due_count * 2 // 5)))


def _reviews_due_values(lang: Lang, p: ReviewsDueParams, ctx: Context) -> dict[str, str]:
    return {"due_count": str(p.due_count), "review_minutes": str(review_minutes(p.due_count))}


def _reviews_due_kid_values(lang: Lang, p: ReviewsDueParams, ctx: Context) -> dict[str, str]:
    return {"learner_name": ctx.learner_name or KID_NAME[lang], **_reviews_due_values(lang, p, ctx)}


def _reviews_due(lang: Lang, p: ReviewsDueParams, ctx: Context) -> Rendered:
    minutes = review_minutes(p.due_count)
    if lang == "ru":
        body = f"Пора повторить слова: {p.due_count}. Это займёт около {minutes} минут."
        return Rendered("Повторение дня", body, REVIEW_BUTTON[lang], REVIEW_ROUTE)
    body = f"Soʻzlarni takrorlash vaqti keldi: {p.due_count}. Bu taxminan {minutes} daqiqa oladi."
    return Rendered("Kunlik takrorlash", body, REVIEW_BUTTON[lang], REVIEW_ROUTE)


def _reviews_due_kid(lang: Lang, p: ReviewsDueParams, ctx: Context) -> Rendered:
    """Родителю, с именем ребёнка, мягко (CONVENTIONS §8): без серии, давления и сравнения."""
    name = ctx.learner_name
    minutes = review_minutes(p.due_count)
    if lang == "ru":
        title = f"{name}: пора повторить слова" if name else "Ребёнку пора повторить слова"
        body = (f"Пора повторить слова: {p.due_count}. Это займёт около {minutes} минут — "
                "повторите вместе, будет интересно!")
        return Rendered(title, body, REVIEW_BUTTON[lang], REVIEW_ROUTE)
    title = f"{name}: soʻzlarni takrorlash vaqti" if name else "Farzandingizga soʻzlarni takrorlash vaqti"
    body = (f"Soʻzlarni takrorlash vaqti keldi: {p.due_count}. Bu taxminan {minutes} daqiqa oladi — "
            "birga takrorlang, qiziqarli boʻladi!")
    return Rendered(title, body, REVIEW_BUTTON[lang], REVIEW_ROUTE)


# ---------------------------------------------------------------- игра (gamification, спринт 6)
#
# Категория `game`; переменные — коды и числа из событий (без текстов ученика). Имена значков, героев и ступеней —
# словарь сида (INTERNAL_API спринта 6 §1.4, §1.6): каталог героев правится в админке gamification, имена здесь —
# черновые до появления имён в событии; неизвестный код — общее название. Детям 6–13 — только центр детского
# профиля (опекуну «в сводке»), тексты `*.kid` — родителю, с именем ребёнка, мягко, без «серии».

PROGRESS_BUTTON = {"ru": "Открыть достижения", "uz": "Yutuqlarni ochish"}
PROGRESS_ROUTE = "route_progress"
HOME_ROUTE = "route_home"


def _plural_ru(n: int, one: str, few: str, many: str) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


class StreakFrozenParams(Params):
    """Заморозка закрыла пропуск дня `local_date`; `freeze_left` — сколько заморозок осталось."""

    local_date: date
    freeze_left: Annotated[int, Field(ge=0)]


def _streak_frozen_values(lang: Lang, p: StreakFrozenParams, ctx: Context) -> dict[str, str]:
    return {"date": _ddmm(p.local_date), "left": str(p.freeze_left)}


def _streak_frozen_kid_values(lang: Lang, p: StreakFrozenParams, ctx: Context) -> dict[str, str]:
    return {"learner_name": ctx.learner_name or KID_NAME[lang], **_streak_frozen_values(lang, p, ctx)}


def _streak_frozen(lang: Lang, p: StreakFrozenParams, ctx: Context) -> Rendered:
    d, left = _ddmm(p.local_date), p.freeze_left
    if lang == "ru":
        return Rendered("Серия спасена", f"Заморозка закрыла пропуск {d}. Осталось заморозок: {left}.",
                        OPEN[lang], HOME_ROUTE)
    return Rendered("Seriya saqlab qolindi",
                    f"Muzlatish {d} kuni oʻtkazib yuborilgan mashgʻulotni yopdi. Qolgan muzlatishlar: {left}.",
                    OPEN[lang], HOME_ROUTE)


def _streak_frozen_kid(lang: Lang, p: StreakFrozenParams, ctx: Context) -> Rendered:
    """Родителю, мягко: без «серии» и «потери» (CONVENTIONS §8)."""
    name, d, left = ctx.learner_name, _ddmm(p.local_date), p.freeze_left
    if lang == "ru":
        title = f"{name}: заморозка помогла" if name else "Заморозка помогла"
        body = f"Пропуск {d} закрыт заморозкой — можно спокойно продолжать. Заморозок осталось: {left}."
        return Rendered(title, body, OPEN[lang], HOME_ROUTE)
    title = f"{name}: muzlatish yordam berdi" if name else "Muzlatish yordam berdi"
    body = (f"{d} kuni oʻtkazib yuborilgan mashgʻulot muzlatish bilan yopildi — bemalol davom etish mumkin. "
            f"Qolgan muzlatishlar: {left}.")
    return Rendered(title, body, OPEN[lang], HOME_ROUTE)


class BadgeParams(Params):
    badge_code: Annotated[str, Field(pattern=r"^[a-z0-9_]{3,40}$")]


_BADGE_FIXED: dict[str, dict[str, str]] = {
    "first_lesson": {"ru": "Первый урок", "uz": "Birinchi dars"},
    "first_freeze": {"ru": "Первая заморозка", "uz": "Birinchi muzlatish"},
    "skill_retained": {"ru": "Первый закреплённый навык", "uz": "Birinchi mustahkamlangan koʻnikma"},
}
_BADGE_UNKNOWN = {"ru": "Новое достижение", "uz": "Yangi yutuq"}
_BADGE_COUNTED = ("streak_", "skills_", "reviews_", "readings_")


def badge_title(lang: Lang, code: str) -> str:
    """Название значка по коду (§1.6): first_lesson, streak_<n>, skills_<n>, skill_retained, reviews_<n>,
    readings_<n>, first_freeze. Значок серии — «N дней подряд» (без слова «серия»: текст бывает и родителю)."""
    if code in _BADGE_FIXED:
        return _BADGE_FIXED[code][lang]
    prefix = next((p for p in _BADGE_COUNTED if code.startswith(p)), None)
    raw = code[len(prefix):] if prefix else ""
    if prefix is None or not raw.isdigit() or not 0 < int(raw) <= 100_000:
        return _BADGE_UNKNOWN[lang]
    n = int(raw)
    if prefix == "streak_":
        return f"{_days_ru(n)} подряд" if lang == "ru" else f"Ketma-ket {n} kun"
    if prefix == "skills_":
        return (f"{n} {_plural_ru(n, 'подтверждённый навык', 'подтверждённых навыка', 'подтверждённых навыков')}"
                if lang == "ru" else f"{n} ta tasdiqlangan koʻnikma")
    if prefix == "reviews_":
        return (f"{n} {_plural_ru(n, 'повторённая карточка', 'повторённые карточки', 'повторённых карточек')}"
                if lang == "ru" else f"{n} ta takrorlangan soʻz")
    return (f"{n} {_plural_ru(n, 'прочитанный текст', 'прочитанных текста', 'прочитанных текстов')}"
            if lang == "ru" else f"{n} ta oʻqilgan matn")


def _badge_values(lang: Lang, p: BadgeParams, ctx: Context) -> dict[str, str]:
    return {"badge": badge_title(lang, p.badge_code)}


def _badge_kid_values(lang: Lang, p: BadgeParams, ctx: Context) -> dict[str, str]:
    return {"learner_name": ctx.learner_name or KID_NAME[lang], **_badge_values(lang, p, ctx)}


def _badge_earned(lang: Lang, p: BadgeParams, ctx: Context) -> Rendered:
    badge = badge_title(lang, p.badge_code)
    if lang == "ru":
        return Rendered("Поздравляем!", f"Новый значок: {badge}.", PROGRESS_BUTTON[lang], PROGRESS_ROUTE)
    return Rendered("Tabriklaymiz!", f"Yangi nishon: {badge}.", PROGRESS_BUTTON[lang], PROGRESS_ROUTE)


def _badge_earned_kid(lang: Lang, p: BadgeParams, ctx: Context) -> Rendered:
    name, badge = ctx.learner_name, badge_title(lang, p.badge_code)
    if lang == "ru":
        title = f"{name}: новый значок" if name else "Новый значок ребёнка"
        return Rendered(title, f"Новый значок: {badge} — отличный повод порадоваться вместе!",
                        PROGRESS_BUTTON[lang], PROGRESS_ROUTE)
    title = f"{name}: yangi nishon" if name else "Farzandingizning yangi nishoni"
    return Rendered(title, f"Yangi nishon: {badge} — birga quvonish uchun ajoyib sabab!",
                    PROGRESS_BUTTON[lang], PROGRESS_ROUTE)


class HeroStageParams(Params):
    hero_code: Annotated[str, Field(pattern=r"^(robot|pet|human)_[0-9]$")]
    stage: Literal[2, 3]


# код → (имя RU, имя UZ, женский род) — сид каталога (§1.4); UZ — на вычитку владельцу, как в сиде gamification
HERO_NAMES: dict[str, tuple[str, str, bool]] = {
    "robot_0": ("Робот Вольт", "Robot Volt", False),
    "robot_1": ("Робот Искра", "Robot Iskra", False),
    "robot_2": ("Робот Бриз", "Robot Briz", False),
    "pet_0": ("Дракончик Мятик", "Ajdarcha Myatik", False),
    "pet_1": ("Дракончик Персик", "Ajdarcha Persik", False),
    "pet_2": ("Дракончик Сирень", "Ajdarcha Siren", False),
    "human_0": ("Ученица Нилу", "Oʻquvchi Nilu", True),
    "human_1": ("Ученик Тимур", "Oʻquvchi Timur", False),
    "human_2": ("Ученица Ая", "Oʻquvchi Aya", True),
}
HERO_UNKNOWN = {"ru": "Герой", "uz": "Qahramon"}
# линия → ступень → (RU, UZ); ступень 1 в уведомлениях не бывает (событие — только рост до 2 и 3)
STAGE_NAMES: dict[str, dict[int, tuple[str, str]]] = {
    "robot": {2: ("Запуск", "Ishga tushish"), 3: ("Полёт", "Parvoz")},
    "pet": {2: ("Малыш", "Bolakay"), 3: ("Крылья", "Qanotlar")},
    "human": {2: ("Путешественник", "Sayohatchi"), 3: ("Знаток", "Bilimdon")},
}


def _hero_values(lang: Lang, p: HeroStageParams, ctx: Context) -> dict[str, str]:
    known = HERO_NAMES.get(p.hero_code)
    name = (known[0] if lang == "ru" else known[1]) if known else HERO_UNKNOWN[lang]
    feminine = bool(known and known[2])
    grew = ("выросла" if feminine else "вырос") if lang == "ru" else "oʻsdi"
    ru, uz = STAGE_NAMES[p.hero_code.split("_", 1)[0]][p.stage]
    return {"hero": name, "grew": grew, "stage": ru if lang == "ru" else uz}


def _hero_kid_values(lang: Lang, p: HeroStageParams, ctx: Context) -> dict[str, str]:
    return {"learner_name": ctx.learner_name or KID_NAME[lang], **_hero_values(lang, p, ctx)}


def _hero_stage_reached(lang: Lang, p: HeroStageParams, ctx: Context) -> Rendered:
    v = _hero_values(lang, p, ctx)
    body = f"{v['hero']} {v['grew']}: {v['stage']}!"
    return Rendered("Новая ступень героя" if lang == "ru" else "Qahramonning yangi bosqichi", body, OPEN[lang],
                    HOME_ROUTE)


def _hero_stage_reached_kid(lang: Lang, p: HeroStageParams, ctx: Context) -> Rendered:
    v, name = _hero_values(lang, p, ctx), ctx.learner_name
    if lang == "ru":
        title = f"{name}: новая ступень героя" if name else "Новая ступень героя ребёнка"
        return Rendered(title, f"{v['hero']} {v['grew']}: {v['stage']}! Посмотрите вместе.", OPEN[lang], HOME_ROUTE)
    title = f"{name}: qahramonning yangi bosqichi" if name else "Farzandingiz qahramonining yangi bosqichi"
    return Rendered(title, f"{v['hero']} {v['grew']}: {v['stage']}! Birga koʻring.", OPEN[lang], HOME_ROUTE)


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


# ---------------------------------------------------------------- социальное (спринт 7, INTERNAL_API §5)
#
# Заявки в друзья, дуэли, лиги, парные уроки, рефералы, модерация. Ник — из события (публичное имя сообщества,
# 3–20 букв, цифр и `_`; null → «Друг», детям — «Член семьи»); имён, Telegram и возраста в текстах нет; ответы и
# ошибки другого ученика — никогда (в итоге дуэли — только свой результат). Детям 6–13 — только центр детского
# профиля (`kid_in_app_only`, как спринт 6), тексты `*.kid` — родителю, с именем ребёнка, без сравнений и мест.
# Санкции и обжалования — категория `service` (решения о доступе не выключаются настройкой категорий) и не
# редактируются в админке (`staff_editable=False`: admin.ts TemplateInfo.category не допускает service).

FRIENDS_ROUTE = "route_friends"
LEAGUES_ROUTE = "route_leagues"
REFERRALS_ROUTE = "route_referrals"
FRIENDS_BUTTON = {"ru": "Открыть друзей", "uz": "Doʻstlarni ochish"}
DUEL_BUTTON = {"ru": "Открыть дуэль", "uz": "Duelni ochish"}
LEAGUES_BUTTON = {"ru": "Открыть лиги", "uz": "Ligalarni ochish"}
ROOM_BUTTON = {"ru": "Открыть комнату", "uz": "Xonani ochish"}
REFERRALS_BUTTON = {"ru": "Мои приглашения", "uz": "Taklifnomalarim"}
FRIEND_NAME = {"ru": "Друг", "uz": "Doʻst"}
FAMILY_MEMBER = {"ru": "Член семьи", "uz": "Oila aʼzosi"}
NICKNAME_PATTERN = r"^[^\W]{3,20}$"
Nickname = Annotated[str, Field(pattern=NICKNAME_PATTERN)]
_NICKNAME = TypeAdapter(Nickname)


def valid_nickname(value: object) -> str | None:
    """Ник из события → для текста: только 3–20 букв, цифр и `_` (как social); иначе None (→ «Друг»). Та же
    проверка, что у параметров шаблона, — неподходящий ник не делает запись failed."""
    if not isinstance(value, str):
        return None
    try:
        return _NICKNAME.validate_python(value.strip())
    except ValidationError:
        return None


def _nick(lang: Lang, value: str | None, *, kid: bool = False) -> str:
    return value or (FAMILY_MEMBER if kid else FRIEND_NAME)[lang]


def _when(value: datetime, ctx: Context) -> str:
    return _local(value, ctx.timezone).strftime("%d.%m %H:%M")


def _kid_title(lang: Lang, ctx: Context, ru: str, uz: str) -> str:
    """Заголовок детского варианта — родителю, с именем ребёнка («Мадина: …»)."""
    return f"{ctx.learner_name or KID_NAME[lang]}: {ru if lang == 'ru' else uz}"


class FriendRequestParams(Params):
    request_id: uuid.UUID
    nickname: Nickname | None = None


def _friend_request_values(lang: Lang, p: FriendRequestParams, ctx: Context) -> dict[str, str]:
    return {"nickname": _nick(lang, p.nickname)}


def _friend_request(lang: Lang, p: FriendRequestParams, ctx: Context) -> Rendered:
    nick = _nick(lang, p.nickname)
    if lang == "ru":
        return Rendered("Новая заявка в друзья", f"{nick} хочет добавить вас в друзья в TilHero.",
                        FRIENDS_BUTTON[lang], FRIENDS_ROUTE)
    return Rendered("Doʻstlikka yangi soʻrov", f"{nick} sizni TilHeroʼda doʻstlarga qoʻshmoqchi.",
                    FRIENDS_BUTTON[lang], FRIENDS_ROUTE)


class FriendAcceptedParams(Params):
    nickname: Nickname | None = None


def _friend_accepted_values(lang: Lang, p: FriendAcceptedParams, ctx: Context) -> dict[str, str]:
    return {"nickname": _nick(lang, p.nickname)}


def _friend_accepted(lang: Lang, p: FriendAcceptedParams, ctx: Context) -> Rendered:
    nick = _nick(lang, p.nickname)
    if lang == "ru":
        return Rendered("Заявка принята", f"{nick} теперь ваш друг в TilHero.", FRIENDS_BUTTON[lang], FRIENDS_ROUTE)
    return Rendered("Soʻrov qabul qilindi", f"{nick} endi TilHeroʼdagi doʻstingiz.", FRIENDS_BUTTON[lang],
                    FRIENDS_ROUTE)


class DuelChallengedParams(Params):
    duel_id: uuid.UUID
    nickname: Nickname | None = None
    accept_deadline: AwareDatetime


def _duel_challenged_values(lang: Lang, p: DuelChallengedParams, ctx: Context) -> dict[str, str]:
    return {"nickname": _nick(lang, p.nickname), "deadline": _when(p.accept_deadline, ctx)}


def _duel_challenged_kid_values(lang: Lang, p: DuelChallengedParams, ctx: Context) -> dict[str, str]:
    return {"learner_name": ctx.learner_name or KID_NAME[lang], "nickname": _nick(lang, p.nickname, kid=True)}


def _duel_challenged(lang: Lang, p: DuelChallengedParams, ctx: Context) -> Rendered:
    v = _duel_challenged_values(lang, p, ctx)
    route = f"duel_{p.duel_id}"
    if lang == "ru":
        return Rendered("Вызов на дуэль", f"{v['nickname']} вызывает вас на дуэль: 10 заданий. Принять вызов можно "
                        f"до {v['deadline']}.", DUEL_BUTTON[lang], route)
    return Rendered("Duelga chaqiruv", f"{v['nickname']} sizni duelga chaqirmoqda: 10 ta topshiriq. Chaqiruvni "
                    f"{v['deadline']} gacha qabul qilish mumkin.", DUEL_BUTTON[lang], route)


def _duel_challenged_kid(lang: Lang, p: DuelChallengedParams, ctx: Context) -> Rendered:
    nick, route = _nick(lang, p.nickname, kid=True), f"duel_{p.duel_id}"
    if lang == "ru":
        return Rendered(_kid_title(lang, ctx, "вызов на дуэль", ""),
                        f"{nick} зовёт на дуэль из 10 заданий — можно сыграть вместе.", DUEL_BUTTON[lang], route)
    return Rendered(_kid_title(lang, ctx, "", "duelga chaqiruv"),
                    f"{nick} 10 ta topshiriqli duelga chaqirmoqda — birga oʻynash mumkin.", DUEL_BUTTON[lang], route)


DuelOutcome = Literal["win", "loss", "draw", "technical_win", "technical_loss"]
DUEL_RESULTS: dict[str, dict[str, str]] = {
    "win": {"ru": "Победа!", "uz": "Gʻalaba!"},
    "loss": {"ru": "В этот раз победил соперник.", "uz": "Bu safar raqib gʻolib boʻldi."},
    "draw": {"ru": "Ничья!", "uz": "Durang!"},
    "technical_win": {"ru": "Соперник не успел сыграть — победа ваша.",
                      "uz": "Raqib oʻynashga ulgurmadi — gʻalaba sizniki."},
    "technical_loss": {"ru": "Время дуэли вышло: вы не успели сыграть.",
                       "uz": "Duel vaqti tugadi: siz oʻynashga ulgurmadingiz."},
}


class DuelFinishedParams(Params):
    """Итог дуэли получателю: свой исход и свой результат (чужие ответы и счёт соперника в текст не идут)."""

    duel_id: uuid.UUID
    outcome: DuelOutcome
    result_version: Annotated[int, Field(ge=1)]
    correct: Annotated[int, Field(ge=0, le=50)] | None = None
    total: Annotated[int, Field(ge=1, le=50)] | None = None


def _duel_finished_values(lang: Lang, p: DuelFinishedParams, ctx: Context) -> dict[str, str]:
    score = ""
    if p.correct is not None and p.total is not None:
        score = (f"Ваш результат: {p.correct} из {p.total}." if lang == "ru"
                 else f"Natijangiz: {p.total} tadan {p.correct} ta.")
    return {"duel_result": DUEL_RESULTS[p.outcome][lang], "score": score}


def _duel_finished(lang: Lang, p: DuelFinishedParams, ctx: Context) -> Rendered:
    v, route = _duel_finished_values(lang, p, ctx), f"duel_{p.duel_id}"
    revised = p.result_version > 1
    if lang == "ru":
        title = "Итог дуэли пересмотрен" if revised else "Дуэль завершена"
        return Rendered(title, " ".join(x for x in (v["duel_result"], v["score"]) if x), DUEL_BUTTON[lang], route)
    title = "Duel natijasi qayta koʻrib chiqildi" if revised else "Duel yakunlandi"
    return Rendered(title, " ".join(x for x in (v["duel_result"], v["score"]) if x), DUEL_BUTTON[lang], route)


def _duel_finished_kid_values(lang: Lang, p: DuelFinishedParams, ctx: Context) -> dict[str, str]:
    return {"learner_name": ctx.learner_name or KID_NAME[lang]}


def _duel_finished_kid(lang: Lang, p: DuelFinishedParams, ctx: Context) -> Rendered:
    """Родителю, без сравнений: ни победителя, ни счёта (дети — внутри семьи, CONVENTIONS §8)."""
    route = f"duel_{p.duel_id}"
    if lang == "ru":
        return Rendered(_kid_title(lang, ctx, "дуэль завершена", ""),
                        "Дуэль закончилась — посмотрите вместе, какие задания получились.", DUEL_BUTTON[lang], route)
    return Rendered(_kid_title(lang, ctx, "", "duel yakunlandi"),
                    "Duel tugadi — qaysi topshiriqlar chiqqanini birga koʻring.", DUEL_BUTTON[lang], route)


class LeagueClosedParams(Params):
    week: date
    place: Annotated[int, Field(ge=1, le=100)]
    xp: Annotated[int, Field(ge=0)]
    prize_til: Annotated[int, Field(ge=0, le=10_000)]


def _league_values(lang: Lang, p: LeagueClosedParams, ctx: Context) -> dict[str, str]:
    prize = ""
    if p.prize_til > 0:
        prize = f"Приз: {p.prize_til} тилов." if lang == "ru" else f"Sovrin: {p.prize_til} til."
    return {"place": str(p.place), "xp": str(p.xp), "prize": prize}


def _league_closed(lang: Lang, p: LeagueClosedParams, ctx: Context) -> Rendered:
    v = _league_values(lang, p, ctx)
    if lang == "ru":
        body = f"Вы заняли {v['place']} место в группе, {v['xp']} XP за неделю."
        return Rendered("Итоги недели в лиге", f"{body} {v['prize']}".strip(), LEAGUES_BUTTON[lang], LEAGUES_ROUTE)
    body = f"Siz guruhda {v['place']}-oʻrinni egalladingiz, hafta davomida {v['xp']} XP."
    return Rendered("Ligada hafta yakunlari", f"{body} {v['prize']}".strip(), LEAGUES_BUTTON[lang], LEAGUES_ROUTE)


class PairInvitedParams(Params):
    room_id: uuid.UUID
    nickname: Nickname | None = None
    start_at: AwareDatetime
    scheduled: bool  # запланированная комната (start_at в будущем), иначе — «сейчас»


def _pair_start(lang: Lang, p: PairInvitedParams, ctx: Context) -> str:
    if not p.scheduled:
        return "Начало — сейчас." if lang == "ru" else "Hozir boshlanadi."
    return f"Начало — {_when(p.start_at, ctx)}." if lang == "ru" else f"Boshlanishi — {_when(p.start_at, ctx)}."


def _pair_invited_values(lang: Lang, p: PairInvitedParams, ctx: Context) -> dict[str, str]:
    return {"nickname": _nick(lang, p.nickname), "start": _pair_start(lang, p, ctx)}


def _pair_invited_kid_values(lang: Lang, p: PairInvitedParams, ctx: Context) -> dict[str, str]:
    return {"learner_name": ctx.learner_name or KID_NAME[lang], "nickname": _nick(lang, p.nickname, kid=True),
            "start": _pair_start(lang, p, ctx)}


def _pair_invited(lang: Lang, p: PairInvitedParams, ctx: Context) -> Rendered:
    v, route = _pair_invited_values(lang, p, ctx), f"room_{p.room_id}"
    if lang == "ru":
        return Rendered("Приглашение на парный урок", f"{v['nickname']} зовёт вас на парный урок английского. "
                        f"{v['start']}", ROOM_BUTTON[lang], route)
    return Rendered("Juftlik darsiga taklif", f"{v['nickname']} sizni ingliz tili juftlik darsiga taklif qilmoqda. "
                    f"{v['start']}", ROOM_BUTTON[lang], route)


def _pair_invited_kid(lang: Lang, p: PairInvitedParams, ctx: Context) -> Rendered:
    v, route = _pair_invited_kid_values(lang, p, ctx), f"room_{p.room_id}"
    if lang == "ru":
        return Rendered(_kid_title(lang, ctx, "приглашение на парный урок", ""),
                        f"{v['nickname']} зовёт на парный урок — можно позаниматься вместе. {v['start']}",
                        ROOM_BUTTON[lang], route)
    return Rendered(_kid_title(lang, ctx, "", "juftlik darsiga taklif"),
                    f"{v['nickname']} juftlik darsiga taklif qilmoqda — birga shugʻullanish mumkin. {v['start']}",
                    ROOM_BUTTON[lang], route)


class RoomParams(Params):
    room_id: uuid.UUID


def _kid_name_values(lang: Lang, p: Params, ctx: Context) -> dict[str, str]:
    return {"learner_name": ctx.learner_name or KID_NAME[lang]}


def _pair_starting(lang: Lang, p: RoomParams, ctx: Context) -> Rendered:
    route = f"room_{p.room_id}"
    if lang == "ru":
        return Rendered("Парный урок через 5 минут", "Скоро начало — заходите в комнату вовремя.",
                        ROOM_BUTTON[lang], route)
    return Rendered("Juftlik darsi 5 daqiqadan keyin", "Tez orada boshlanadi — xonaga oʻz vaqtida kiring.",
                    ROOM_BUTTON[lang], route)


def _pair_starting_kid(lang: Lang, p: RoomParams, ctx: Context) -> Rendered:
    route = f"room_{p.room_id}"
    if lang == "ru":
        return Rendered(_kid_title(lang, ctx, "парный урок через 5 минут", ""),
                        "Скоро начало — помогите зайти в комнату.", ROOM_BUTTON[lang], route)
    return Rendered(_kid_title(lang, ctx, "", "juftlik darsi 5 daqiqadan keyin"),
                    "Tez orada boshlanadi — xonaga kirishga yordam bering.", ROOM_BUTTON[lang], route)


def _pair_stopped(lang: Lang, p: RoomParams, ctx: Context) -> Rendered:
    route = f"room_{p.room_id}"
    if lang == "ru":
        return Rendered("Парный урок остановлен", "Администратор остановил комнату. Отчёт по сделанному — "
                        "в приложении.", ROOM_BUTTON[lang], route)
    return Rendered("Juftlik darsi toʻxtatildi", "Administrator xonani toʻxtatdi. Bajarilganlar boʻyicha hisobot — "
                    "ilovada.", ROOM_BUTTON[lang], route)


def _pair_stopped_kid(lang: Lang, p: RoomParams, ctx: Context) -> Rendered:
    route = f"room_{p.room_id}"
    if lang == "ru":
        return Rendered(_kid_title(lang, ctx, "парный урок остановлен", ""),
                        "Комнату остановил администратор. Сделанное сохранено — посмотрите вместе.",
                        ROOM_BUTTON[lang], route)
    return Rendered(_kid_title(lang, ctx, "", "juftlik darsi toʻxtatildi"),
                    "Xonani administrator toʻxtatdi. Bajarilganlar saqlandi — birga koʻring.", ROOM_BUTTON[lang], route)


class ReferralQualifiedParams(Params):
    referral_id: uuid.UUID
    freeze: Annotated[int, Field(ge=0, le=10)]
    til: Annotated[int, Field(ge=0, le=10_000)]


def _reward(lang: Lang, p: ReferralQualifiedParams) -> str:
    parts: list[str] = []
    if p.freeze:
        parts.append(f"{p.freeze} {_plural_ru(p.freeze, 'заморозка', 'заморозки', 'заморозок')}" if lang == "ru"
                     else f"{p.freeze} ta muzlatish")
    if p.til:
        parts.append(f"{p.til} {_plural_ru(p.til, 'тил', 'тила', 'тилов')}" if lang == "ru" else f"{p.til} til")
    if not parts:
        return "без награды" if lang == "ru" else "mukofotsiz"
    return (" и " if lang == "ru" else " va ").join(parts)


def _referral_qualified_values(lang: Lang, p: ReferralQualifiedParams, ctx: Context) -> dict[str, str]:
    return {"reward": _reward(lang, p)}


def _referral_qualified(lang: Lang, p: ReferralQualifiedParams, ctx: Context) -> Rendered:
    rewarded = bool(p.freeze or p.til)
    if lang == "ru":
        body = "Приглашённый вами друг выполнил условия. " + (
            f"Награда: {_reward(lang, p)}." if rewarded else "Спасибо, что зовёте друзей!")
        return Rendered("Приглашение засчитано", body, REFERRALS_BUTTON[lang], REFERRALS_ROUTE)
    body = "Siz taklif qilgan doʻstingiz shartlarni bajardi. " + (
        f"Mukofot: {_reward(lang, p)}." if rewarded else "Doʻstlaringizni taklif qilganingiz uchun rahmat!")
    return Rendered("Taklif hisobga olindi", body, REFERRALS_BUTTON[lang], REFERRALS_ROUTE)


ReferralRejectCode = Literal["not_new_user", "family_member", "window_expired", "review_rejected", "monthly_cap"]
# публичные причины отказа (bff.ts), без правил антифрода
REFERRAL_REASONS: dict[str, dict[str, str]] = {
    "not_new_user": {"ru": "Приглашённый уже пользовался TilHero.", "uz": "Taklif qilingan kishi TilHeroʼdan "
                                                                         "avval foydalangan."},
    "family_member": {"ru": "Члены семьи не засчитываются как приглашения.",
                      "uz": "Oila aʼzolari taklif sifatida hisobga olinmaydi."},
    "window_expired": {"ru": "Срок выполнения условий истёк.", "uz": "Shartlarni bajarish muddati tugadi."},
    "review_rejected": {"ru": "Приглашение не прошло проверку.", "uz": "Taklif tekshiruvdan oʻtmadi."},
    "monthly_cap": {"ru": "В этом месяце уже засчитано максимальное число приглашений.",
                    "uz": "Bu oyda hisobga olinadigan takliflar soni chegarasiga yetildi."},
}


class ReferralRejectedParams(Params):
    referral_id: uuid.UUID
    reject_code: ReferralRejectCode


def _referral_rejected_values(lang: Lang, p: ReferralRejectedParams, ctx: Context) -> dict[str, str]:
    return {"reason": REFERRAL_REASONS[p.reject_code][lang]}


def _referral_rejected(lang: Lang, p: ReferralRejectedParams, ctx: Context) -> Rendered:
    reason = REFERRAL_REASONS[p.reject_code][lang]
    if lang == "ru":
        return Rendered("Приглашение не засчитано", reason, REFERRALS_BUTTON[lang], REFERRALS_ROUTE)
    return Rendered("Taklif hisobga olinmadi", reason, REFERRALS_BUTTON[lang], REFERRALS_ROUTE)


SanctionKind = Literal["warning", "social_ban", "nickname_reset"]


class SanctionParams(Params):
    """Санкция применена (основание в событие не входит — ученик читает его в разделе «Друзья»)."""

    sanction_id: uuid.UUID
    kind: SanctionKind
    until: AwareDatetime | None = None


def _sanction_text(lang: Lang, p: SanctionParams, ctx: Context) -> tuple[str, str]:
    until = _when(p.until, ctx) if p.until is not None else None
    if lang == "ru":
        if p.kind == "warning":
            return ("Предупреждение", "Вы получили предупреждение за нарушение правил общения. Подробности и "
                    "обжалование — в разделе «Друзья».")
        if p.kind == "nickname_reset":
            return ("Ник сброшен", "Ваш ник сброшен за нарушение правил. Задайте новый в разделе «Друзья».")
        term = f"до {until}" if until else "бессрочно"
        return ("Социальные функции ограничены", f"Заявки в друзья, дуэли, парные уроки и общая лига недоступны "
                f"{term}. Учёба продолжается как обычно. Решение можно обжаловать в разделе «Друзья».")
    if p.kind == "warning":
        return ("Ogohlantirish", "Muloqot qoidalarini buzganingiz uchun ogohlantirish oldingiz. Batafsil va "
                "eʼtiroz — «Doʻstlar» boʻlimida.")
    if p.kind == "nickname_reset":
        return ("Taxallus bekor qilindi", "Taxallusingiz qoidalar buzilgani uchun bekor qilindi. «Doʻstlar» "
                "boʻlimida yangisini kiriting.")
    term = f"{until} gacha" if until else "muddatsiz"
    return ("Ijtimoiy funksiyalar cheklandi", f"Doʻstlikka soʻrovlar, duellar, juftlik darslari va umumiy liga "
            f"{term} mavjud emas. Oʻqish odatdagidek davom etadi. Qarorga «Doʻstlar» boʻlimida eʼtiroz bildirish "
            "mumkin.")


def _sanction_applied(lang: Lang, p: SanctionParams, ctx: Context) -> Rendered:
    title, body = _sanction_text(lang, p, ctx)
    return Rendered(title, body, FRIENDS_BUTTON[lang], FRIENDS_ROUTE)


def _sanction_applied_kid(lang: Lang, p: SanctionParams, ctx: Context) -> Rendered:
    if lang == "ru":
        return Rendered(_kid_title(lang, ctx, "правила общения", ""),
                        "Мы напомнили о правилах общения в TilHero. Подробности — в разделе «Друзья».",
                        FRIENDS_BUTTON[lang], FRIENDS_ROUTE)
    return Rendered(_kid_title(lang, ctx, "", "muloqot qoidalari"),
                    "TilHeroʼdagi muloqot qoidalarini eslatdik. Batafsil — «Doʻstlar» boʻlimida.",
                    FRIENDS_BUTTON[lang], FRIENDS_ROUTE)


class SanctionAppealParams(Params):
    appeal_id: uuid.UUID
    decision: Literal["upheld", "overturned"]


def _sanction_appeal_decided(lang: Lang, p: SanctionAppealParams, ctx: Context) -> Rendered:
    if lang == "ru":
        if p.decision == "overturned":
            return Rendered("Обжалование удовлетворено", "Мы пересмотрели решение и сняли ограничение.",
                            FRIENDS_BUTTON[lang], FRIENDS_ROUTE)
        return Rendered("Обжалование рассмотрено", "Мы проверили обжалование: решение остаётся в силе.",
                        FRIENDS_BUTTON[lang], FRIENDS_ROUTE)
    if p.decision == "overturned":
        return Rendered("Eʼtiroz qanoatlantirildi", "Qarorni qayta koʻrib chiqdik va cheklovni olib tashladik.",
                        FRIENDS_BUTTON[lang], FRIENDS_ROUTE)
    return Rendered("Eʼtiroz koʻrib chiqildi", "Eʼtirozingizni tekshirdik: qaror oʻz kuchida qoladi.",
                    FRIENDS_BUTTON[lang], FRIENDS_ROUTE)


def _sanction_appeal_decided_kid(lang: Lang, p: SanctionAppealParams, ctx: Context) -> Rendered:
    if lang == "ru":
        return Rendered(_kid_title(lang, ctx, "обжалование рассмотрено", ""),
                        "Решение по обжалованию — в разделе «Друзья».", FRIENDS_BUTTON[lang], FRIENDS_ROUTE)
    return Rendered(_kid_title(lang, ctx, "", "eʼtiroz koʻrib chiqildi"),
                    "Eʼtiroz boʻyicha qaror — «Doʻstlar» boʻlimida.", FRIENDS_BUTTON[lang], FRIENDS_ROUTE)


COMPLAINT_RESULTS: dict[str, dict[str, str]] = {
    "action_taken": {"ru": "меры приняты", "uz": "choralar koʻrildi"},
    "dismissed": {"ru": "нарушений не найдено", "uz": "qoidabuzarlik topilmadi"},
}


class ComplaintParams(Params):
    """Жалоба рассмотрена — жалобщику, без подробностей (что за меры и против кого — не сообщается)."""

    case_id: uuid.UUID
    outcome: Literal["action_taken", "dismissed"]


def _complaint_values(lang: Lang, p: ComplaintParams, ctx: Context) -> dict[str, str]:
    return {"result": COMPLAINT_RESULTS[p.outcome][lang]}


def _complaint_kid_values(lang: Lang, p: ComplaintParams, ctx: Context) -> dict[str, str]:
    return {"learner_name": ctx.learner_name or KID_NAME[lang], **_complaint_values(lang, p, ctx)}


def _complaint_resolved(lang: Lang, p: ComplaintParams, ctx: Context) -> Rendered:
    result = COMPLAINT_RESULTS[p.outcome][lang]
    if lang == "ru":
        return Rendered("Жалоба рассмотрена", f"Спасибо, что сообщили! Жалоба проверена: {result}.", OPEN[lang],
                        None)
    return Rendered("Shikoyat koʻrib chiqildi", f"Xabar berganingiz uchun rahmat! Shikoyat tekshirildi: {result}.",
                    OPEN[lang], None)


def _complaint_resolved_kid(lang: Lang, p: ComplaintParams, ctx: Context) -> Rendered:
    result = COMPLAINT_RESULTS[p.outcome][lang]
    if lang == "ru":
        return Rendered(_kid_title(lang, ctx, "жалоба рассмотрена", ""),
                        f"Спасибо, что сообщили! Жалоба проверена: {result}.", OPEN[lang], None)
    return Rendered(_kid_title(lang, ctx, "", "shikoyat koʻrib chiqildi"),
                    f"Xabar berganingiz uchun rahmat! Shikoyat tekshirildi: {result}.", OPEN[lang], None)


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
    "due_count": ("Сколько слов к повторению сегодня, число, например «12»",
                  "Words due for review today, a number, e.g. “12”"),
    "review_minutes": (
        "Примерное время повторения в минутах, число от 2 до 15 (≈ 0,4 мин на слово), например «5»",
        "Estimated review time in minutes, a number from 2 to 15 (≈ 0.4 min per word), e.g. “5”",
    ),
    # спринт 6 — игра
    "date": ("Дата дня, закрытого заморозкой, ДД.ММ", "Date of the day covered by a streak freeze, DD.MM"),
    "left": ("Сколько заморозок осталось, число, например «1»", "Streak freezes left, a number, e.g. “1”"),
    "badge": (
        "Название значка на языке ученика, например «7 дней подряд»",
        "Badge name in the learner's language, e.g. “7 days in a row”",
    ),
    "hero": ("Имя героя, например «Дракончик Мятик»", "Hero's name, e.g. “Dragon Myatik”"),
    "grew": (
        "«вырос» или «выросла» по роду героя (UZ — «oʻsdi»)",
        "“grew” in Russian with the hero's grammatical gender (UZ — “oʻsdi”)",
    ),
    "stage": ("Название новой ступени героя, например «Малыш»", "Name of the hero's new stage, e.g. “Baby”"),
    # спринт 7 — социальное
    "nickname": (
        "Ник в сообществе TilHero; если не задан — «Друг» (детям — «Член семьи»)",
        "Community nickname; “Friend” if not set (“Family member” for children)",
    ),
    "deadline": ("До какого времени принять вызов, ДД.ММ ЧЧ:ММ по поясу ученика",
                 "Challenge acceptance deadline, DD.MM HH:MM in the learner's time zone"),
    "duel_result": ("Исход дуэли для получателя, например «Победа!» или «Ничья!»",
                    "Duel outcome for the recipient, e.g. “Victory!” or “Draw!”"),
    "score": ("Свой результат, например «Ваш результат: 7 из 10.» (пусто — не играл)",
              "Own score, e.g. “Your result: 7 of 10.” (empty if not played)"),
    "place": ("Место в группе лиги, число", "Place in the league group, a number"),
    "xp": ("XP за неделю, число", "XP earned this week, a number"),
    "prize": ("Приз, например «Приз: 50 тилов.» (пусто — без приза)", "Prize, e.g. “Prize: 50 tils.” (empty — none)"),
    "start": ("Начало урока: «Начало — сейчас.» или «Начало — 22.11 18:00.»",
              "Lesson start: “Starts now.” or “Starts at 22.11 18:00.”"),
    "reward": ("Награда за приглашение, например «2 заморозки»", "Referral reward, e.g. “2 streak freezes”"),
    "reason": ("Публичная причина, почему приглашение не засчитано (без правил антифрода)",
               "Public reason why the referral did not count (no anti-fraud rules)"),
    "result": ("Итог проверки жалобы: «меры приняты» или «нарушений не найдено»",
               "Complaint review result: “action taken” or “no violation found”"),
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

Category = Literal["reminders", "missed", "social", "support", "product", "service", "game"]
# Категория записи → категория публичных контрактов (bff.ts InboxItem.category, admin.ts TemplateInfo.category).
# Спринт 7: game — полноценная категория контрактов и настроек (в спринте 6 показывалась как reminders) — замен нет
PUBLIC_CATEGORY: dict[str, str] = {}


def public_category(category: str) -> str:
    return PUBLIC_CATEGORY.get(category, category)
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
    # Спринт 6: детям 6–13 — только центр детского профиля (опекуну «в сводке», без сообщения в Telegram)
    kid_in_app_only: bool = False
    # Спринт 7: шаблон виден и правится в админке (санкции и обжалования — категория service, только тексты кода:
    # admin.ts TemplateInfo.category не допускает service)
    staff_editable: bool = True
    # Спринт 2 — версии сотрудников: описание (RU, EN), плейсхолдеры и их значения на языке ученика, образец
    # параметров для текстов по умолчанию и предпросмотра
    description: tuple[str, str] = ("", "")
    placeholder_names: tuple[str, ...] = ()
    placeholders: Placeholders = _no_values
    sample: dict[str, Any] = field(default_factory=dict)

    @property
    def editable(self) -> bool:
        return self.staff_editable and not (self.direct_only or self.transactional)

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
            "reviews_due", "reminders", ReviewsDueParams, _reviews_due, kid_variant="reviews_due.kid",
            description=("Вечернее напоминание о повторении слов (19:00 по поясу плана)",
                         "Evening reminder to review words (19:00 in the plan's time zone)"),
            placeholder_names=("due_count", "review_minutes"), placeholders=_reviews_due_values,
            sample={"local_date": "2026-11-20", "due_count": 12},
        ),
        TemplateSpec(
            "reviews_due.kid", "reminders", ReviewsDueParams, _reviews_due_kid,
            description=("Напоминание о повторении слов ребёнка — родителю, мягко",
                         "Child's word review reminder — gentle, to the parent"),
            placeholder_names=("learner_name", "due_count", "review_minutes"), placeholders=_reviews_due_kid_values,
            sample={"local_date": "2026-11-20", "due_count": 7},
        ),
        TemplateSpec(
            "streak_frozen", "game", StreakFrozenParams, _streak_frozen, kid_variant="streak_frozen.kid",
            kid_in_app_only=True,
            description=("Заморозка закрыла пропуск — серия сохранена (утром следующего дня)",
                         "A streak freeze covered a missed day — the streak is kept (next morning)"),
            placeholder_names=("date", "left"), placeholders=_streak_frozen_values,
            sample={"local_date": "2026-11-19", "freeze_left": 1},
        ),
        TemplateSpec(
            "streak_frozen.kid", "game", StreakFrozenParams, _streak_frozen_kid, kid_in_app_only=True,
            description=("Заморозка закрыла пропуск ребёнка — родителю в центре детского профиля, мягко",
                         "A freeze covered the child's missed day — to the parent, in-app only, gentle"),
            placeholder_names=("learner_name", "date", "left"), placeholders=_streak_frozen_kid_values,
            sample={"local_date": "2026-11-19", "freeze_left": 1},
        ),
        TemplateSpec(
            "badge_earned", "game", BadgeParams, _badge_earned, kid_variant="badge_earned.kid",
            kid_in_app_only=True,
            description=("Новый значок за учебный результат", "New badge for a learning result"),
            placeholder_names=("badge",), placeholders=_badge_values,
            sample={"badge_code": "streak_7"},
        ),
        TemplateSpec(
            "badge_earned.kid", "game", BadgeParams, _badge_earned_kid, kid_in_app_only=True,
            description=("Новый значок ребёнка — родителю в центре детского профиля",
                         "Child's new badge — to the parent, in-app only"),
            placeholder_names=("learner_name", "badge"), placeholders=_badge_kid_values,
            sample={"badge_code": "first_lesson"},
        ),
        TemplateSpec(
            "hero_stage_reached", "game", HeroStageParams, _hero_stage_reached, kid_variant="hero_stage_reached.kid",
            kid_in_app_only=True,
            description=("Герой вырос: новая ступень за подтверждённые навыки",
                         "The hero grew: a new stage for confirmed skills"),
            placeholder_names=("hero", "grew", "stage"), placeholders=_hero_values,
            sample={"hero_code": "human_0", "stage": 2},
        ),
        TemplateSpec(
            "hero_stage_reached.kid", "game", HeroStageParams, _hero_stage_reached_kid, kid_in_app_only=True,
            description=("Герой ребёнка вырос — родителю в центре детского профиля",
                         "The child's hero grew — to the parent, in-app only"),
            placeholder_names=("learner_name", "hero", "grew", "stage"), placeholders=_hero_kid_values,
            sample={"hero_code": "pet_0", "stage": 2},
        ),
        # ---------------------------------------------------------------- спринт 7: социальное
        TemplateSpec(
            "friend_request", "social", FriendRequestParams, _friend_request, kid_in_app_only=True,
            description=("Новая заявка в друзья — получателю (ник отправителя)",
                         "New friend request — to the recipient (sender's nickname)"),
            placeholder_names=("nickname",), placeholders=_friend_request_values,
            sample={"request_id": _SAMPLE_ID, "nickname": "Alisher_7"},
        ),
        TemplateSpec(
            "friend_accepted", "social", FriendAcceptedParams, _friend_accepted, kid_in_app_only=True,
            description=("Заявка в друзья принята — отправителю заявки", "Friend request accepted — to the requester"),
            placeholder_names=("nickname",), placeholders=_friend_accepted_values,
            sample={"nickname": "Madina_uz"},
        ),
        TemplateSpec(
            "duel_challenged", "game", DuelChallengedParams, _duel_challenged, kid_variant="duel_challenged.kid",
            kid_in_app_only=True,
            description=("Вызов на дуэль — сопернику (ник вызывающего, срок принятия)",
                         "Duel challenge — to the opponent (challenger's nickname, acceptance deadline)"),
            placeholder_names=("nickname", "deadline"), placeholders=_duel_challenged_values,
            sample={"duel_id": _SAMPLE_ID, "nickname": "Alisher_7", "accept_deadline": "2026-11-22T13:00:00Z"},
        ),
        TemplateSpec(
            "duel_challenged.kid", "game", DuelChallengedParams, _duel_challenged_kid, kid_in_app_only=True,
            description=("Вызов на дуэль от члена семьи — родителю в центре детского профиля",
                         "Duel challenge from a family member — to the parent, in-app only"),
            placeholder_names=("learner_name", "nickname"), placeholders=_duel_challenged_kid_values,
            sample={"duel_id": _SAMPLE_ID, "nickname": None, "accept_deadline": "2026-11-22T13:00:00Z"},
        ),
        TemplateSpec(
            "duel_finished", "game", DuelFinishedParams, _duel_finished, kid_variant="duel_finished.kid",
            kid_in_app_only=True,
            description=("Итог дуэли — каждому участнику: свой исход и свой результат (переоценка — новое сообщение)",
                         "Duel result — to each participant: own outcome and score (re-evaluation — a new message)"),
            placeholder_names=("duel_result", "score"), placeholders=_duel_finished_values,
            sample={"duel_id": _SAMPLE_ID, "outcome": "win", "result_version": 1, "correct": 8, "total": 10},
        ),
        TemplateSpec(
            "duel_finished.kid", "game", DuelFinishedParams, _duel_finished_kid, kid_in_app_only=True,
            description=("Дуэль ребёнка завершена — родителю, без победителя и счёта",
                         "Child's duel finished — to the parent, without winner or score"),
            placeholder_names=("learner_name",), placeholders=_duel_finished_kid_values,
            sample={"duel_id": _SAMPLE_ID, "outcome": "draw", "result_version": 1, "correct": 6, "total": 10},
        ),
        TemplateSpec(
            "league_closed", "game", LeagueClosedParams, _league_closed, kid_in_app_only=True,
            description=("Итоги недели общей лиги — участнику: место, XP и приз",
                         "Weekly general league results — to a participant: place, XP and prize"),
            placeholder_names=("place", "xp", "prize"), placeholders=_league_values,
            sample={"week": "2026-11-16", "place": 2, "xp": 640, "prize_til": 30},
        ),
        TemplateSpec(
            "pair_invited", "social", PairInvitedParams, _pair_invited, kid_variant="pair_invited.kid",
            kid_in_app_only=True,
            description=("Приглашение на парный урок — приглашённому (ник, начало)",
                         "Pair lesson invitation — to the invitee (nickname, start)"),
            placeholder_names=("nickname", "start"), placeholders=_pair_invited_values,
            sample={"room_id": _SAMPLE_ID, "nickname": "Alisher_7", "start_at": "2026-11-22T13:00:00Z",
                    "scheduled": True},
        ),
        TemplateSpec(
            "pair_invited.kid", "social", PairInvitedParams, _pair_invited_kid, kid_in_app_only=True,
            description=("Приглашение ребёнка на парный урок от члена семьи — родителю в центре",
                         "Pair lesson invitation for the child from a family member — to the parent, in-app only"),
            placeholder_names=("learner_name", "nickname", "start"), placeholders=_pair_invited_kid_values,
            sample={"room_id": _SAMPLE_ID, "nickname": None, "start_at": "2026-11-22T13:00:00Z",
                    "scheduled": False},
        ),
        TemplateSpec(
            "pair_starting", "social", RoomParams, _pair_starting, kid_variant="pair_starting.kid",
            kid_in_app_only=True,
            description=("Запланированный парный урок начнётся через 5 минут — обоим участникам",
                         "A scheduled pair lesson starts in 5 minutes — to both participants"),
            sample={"room_id": _SAMPLE_ID},
        ),
        TemplateSpec(
            "pair_starting.kid", "social", RoomParams, _pair_starting_kid, kid_in_app_only=True,
            description=("Парный урок ребёнка через 5 минут — родителю в центре",
                         "Child's pair lesson in 5 minutes — to the parent, in-app only"),
            placeholder_names=("learner_name",), placeholders=_kid_name_values, sample={"room_id": _SAMPLE_ID},
        ),
        TemplateSpec(
            "pair_stopped", "social", RoomParams, _pair_stopped, kid_variant="pair_stopped.kid",
            kid_in_app_only=True,
            description=("Администратор остановил парную комнату — участникам",
                         "Staff stopped the pair room — to the participants"),
            sample={"room_id": _SAMPLE_ID},
        ),
        TemplateSpec(
            "pair_stopped.kid", "social", RoomParams, _pair_stopped_kid, kid_in_app_only=True,
            description=("Комнату ребёнка остановил администратор — родителю в центре",
                         "The child's pair room was stopped — to the parent, in-app only"),
            placeholder_names=("learner_name",), placeholders=_kid_name_values, sample={"room_id": _SAMPLE_ID},
        ),
        TemplateSpec(
            "referral_qualified", "social", ReferralQualifiedParams, _referral_qualified, kid_in_app_only=True,
            description=("Приглашение друга засчитано — пригласившему (награда)",
                         "Referral counted — to the inviter (reward)"),
            placeholder_names=("reward",), placeholders=_referral_qualified_values,
            sample={"referral_id": _SAMPLE_ID, "freeze": 2, "til": 0},
        ),
        TemplateSpec(
            "referral_rejected", "social", ReferralRejectedParams, _referral_rejected, kid_in_app_only=True,
            description=("Приглашение не засчитано — пригласившему (публичная причина)",
                         "Referral not counted — to the inviter (public reason)"),
            placeholder_names=("reason",), placeholders=_referral_rejected_values,
            sample={"referral_id": _SAMPLE_ID, "reject_code": "window_expired"},
        ),
        TemplateSpec(
            "complaint_resolved", "social", ComplaintParams, _complaint_resolved, kid_variant="complaint_resolved.kid",
            kid_in_app_only=True,
            description=("Жалоба рассмотрена — жалобщику, без подробностей",
                         "Complaint reviewed — to the reporter, without details"),
            placeholder_names=("result",), placeholders=_complaint_values,
            sample={"case_id": _SAMPLE_ID, "outcome": "action_taken"},
        ),
        TemplateSpec(
            "complaint_resolved.kid", "social", ComplaintParams, _complaint_resolved_kid, kid_in_app_only=True,
            description=("Жалоба ребёнка рассмотрена — родителю в центре",
                         "The child's complaint reviewed — to the parent, in-app only"),
            placeholder_names=("learner_name", "result"), placeholders=_complaint_kid_values,
            sample={"case_id": _SAMPLE_ID, "outcome": "dismissed"},
        ),
        TemplateSpec(
            "sanction_applied", "service", SanctionParams, _sanction_applied, kid_variant="sanction_applied.kid",
            kid_in_app_only=True, staff_editable=False,
            sample={"sanction_id": _SAMPLE_ID, "kind": "social_ban", "until": "2026-11-28T13:00:00Z"},
        ),
        TemplateSpec(
            "sanction_applied.kid", "service", SanctionParams, _sanction_applied_kid, kid_in_app_only=True,
            staff_editable=False, sample={"sanction_id": _SAMPLE_ID, "kind": "warning", "until": None},
        ),
        TemplateSpec(
            "sanction_appeal_decided", "service", SanctionAppealParams, _sanction_appeal_decided,
            kid_variant="sanction_appeal_decided.kid", kid_in_app_only=True, staff_editable=False,
            sample={"appeal_id": _SAMPLE_ID, "decision": "overturned"},
        ),
        TemplateSpec(
            "sanction_appeal_decided.kid", "service", SanctionAppealParams, _sanction_appeal_decided_kid,
            kid_in_app_only=True, staff_editable=False, sample={"appeal_id": _SAMPLE_ID, "decision": "upheld"},
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

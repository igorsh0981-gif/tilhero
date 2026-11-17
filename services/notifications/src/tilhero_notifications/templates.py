"""Шаблоны уведомлений TilHero RU/UZ (узбекская латиница, oʻ/gʻ — U+02BB, тутук — U+02BC).

Правила (INTERNAL_API §4, CONVENTIONS §8):
- каждый шаблон даёт title/body (обычный текст — для центра уведомлений, на языке ученика) и текст Telegram
  (HTML: `<b>title</b>` + body; КАЖДОЕ значение экранируется html.escape);
- детские варианты (`*.kid`) адресованы родителю, с именем ребёнка, мягкие: без «потери серии», «провала»,
  давления; прочих PII нет (только имя ребёнка родителю и имя пригласившего/принявшего);
- текст ответа оператора в уведомление не кладём — только номер обращения;
- кнопка «Открыть» (startapp): напоминание и пропуск → route_home; приглашение принято / новый участник
  семьи / отклонено → route_family; неотвеченное приглашение → invite_<invite_id>; поддержка → ticket_<number>;
  «Что нового» → route_news;
- параметры проверяются строгой моделью при приёме (неизвестное поле/формат → failed params_invalid).
"""

from __future__ import annotations

import html
import unicodedata
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

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


@dataclass(frozen=True)
class Context:
    """Имена, известные только в момент отрисовки (identity-consent)."""

    learner_name: str | None = None  # имя ребёнка — в сообщении родителю
    other_name: str | None = None  # пригласивший / принявший / новый участник семьи


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


# ---------------------------------------------------------------- pin.reset_code (transactional, не в центре)


class PinResetParams(Params):
    code: Annotated[str, Field(pattern=r"^\d{6}$")]
    ttl_minutes: Annotated[int, Field(ge=1, le=60)] = 10  # срок кода — из настроек identity-consent


def _pin_reset(lang: Lang, p: PinResetParams, ctx: Context) -> Rendered:
    if lang == "ru":
        text = (
            f"Код для сброса PIN-кода родителя в TilHero: <b>{esc(p.code)}</b>. Никому не сообщайте его. "
            f"Действует {_minutes_ru(p.ttl_minutes)}."
        )
        return Rendered("Код для сброса PIN-кода", "", OPEN[lang], None, html=text)
    text = (
        f"TilHero ota-ona PIN-kodini tiklash kodi: <b>{esc(p.code)}</b>. Uni hech kimga aytmang. "
        f"{p.ttl_minutes} daqiqa amal qiladi."
    )
    return Rendered("PIN-kodni tiklash kodi", "", OPEN[lang], None, html=text)


# ---------------------------------------------------------------- реестр

Category = Literal["reminders", "missed", "social", "support", "product", "service"]


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

    def validate(self, params: dict[str, Any] | None) -> Params:
        try:
            return self.params.model_validate(params or {})
        except ValidationError as exc:
            raise TemplateError(f"invalid params for {self.name}") from exc

    def render(self, locale: str | None, params: dict[str, Any] | None, ctx: Context | None = None) -> Rendered:
        rendered = self.renderer(lang_of(locale), self.validate(params), ctx or Context())
        if len(rendered.telegram_text()) > MAX_TEXT:
            raise TemplateError(f"text too long for {self.name}")
        return rendered


TEMPLATES: dict[str, TemplateSpec] = {
    spec.name: spec
    for spec in (
        TemplateSpec("lesson.reminder", "reminders", ReminderParams, _reminder, kid_variant="lesson.reminder.kid"),
        TemplateSpec("lesson.reminder.kid", "reminders", ReminderParams, _reminder_kid),
        TemplateSpec("lesson.missed", "missed", MissedParams, _missed, kid_variant="lesson.missed.kid"),
        TemplateSpec("lesson.missed.kid", "missed", MissedParams, _missed_kid),
        TemplateSpec("lesson.comeback", "missed", ComebackParams, _comeback, kid_variant="lesson.comeback.kid"),
        TemplateSpec("lesson.comeback.kid", "missed", ComebackParams, _comeback_kid),
        TemplateSpec("invite.accepted", "social", InviteParams, _invite_accepted),
        TemplateSpec("invite.declined", "social", InviteParams, _invite_declined, gated=False),
        TemplateSpec("invite.pending", "social", InviteParams, _invite_pending),
        TemplateSpec("family.joined", "social", FamilyParams, _family_joined),
        TemplateSpec("support.reply", "support", TicketParams, _support_reply),
        TemplateSpec("support.resolved", "support", TicketParams, _support_resolved),
        TemplateSpec("release_note.published", "product", ReleaseNoteParams, _release_note),
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

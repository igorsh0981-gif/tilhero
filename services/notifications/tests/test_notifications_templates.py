"""Шаблоны RU/UZ: тексты, кнопки startapp, экранирование, детские формулировки, имена без PII-мусора."""

from __future__ import annotations

import re
import uuid

import pytest

from tilhero_notifications.domain.texts import PRESSURE_WORDS
from tilhero_notifications.templates import (
    KID_TEMPLATES,
    TEMPLATES,
    Context,
    TemplateError,
    clean_name,
    lang_of,
)

INVITE = str(uuid.UUID("3f2b8c1e-6a4d-4e0b-9c71-2d5e8f1a7b90"))
PARAMS: dict[str, dict] = {
    "lesson.reminder": {"local_date": "2026-11-20", "slot_time": "19:00", "duration_min": 15, "streak_days": 5},
    "lesson.missed": {"local_date": "2026-11-20", "consecutive_missed": 2, "next_slot_date": "2026-11-22"},
    "lesson.comeback": {"local_date": "2026-11-20", "consecutive_missed": 9},
    "invite.accepted": {"invite_id": INVITE, "kind": "friend"},
    "invite.declined": {"invite_id": INVITE, "kind": "family"},
    "invite.pending": {"invite_id": INVITE, "kind": "family"},
    "family.joined": {"family_id": INVITE, "role": "adult"},
    "support.reply": {"number": "TCK-3081"},
    "support.resolved": {"number": "TCK-3081"},
    "release_note.published": {"release_note_id": INVITE, "slug": "2026.11"},
    "pin.reset_code": {"code": "482913", "ttl_minutes": 10},
    "pin.reset_scheduled": {"effective_at": "2026-11-19T05:30:00.000Z"},
}
for base in ("lesson.reminder", "lesson.missed", "lesson.comeback"):
    PARAMS[base + ".kid"] = PARAMS[base]

# Детям и о детях — без давления: ни «потери серии», ни «провала» (CONVENTIONS §8). Список — в коде: им же
# проверяются детские версии сотрудников при сохранении (domain/texts.py)
FORBIDDEN = PRESSURE_WORDS
STARTAPP = {
    "lesson.reminder": "route_home",
    "lesson.missed": "route_home",
    "lesson.comeback": "route_home",
    "invite.accepted": "route_family",
    "invite.declined": "route_family",
    "invite.pending": f"invite_{INVITE}",
    "family.joined": "route_family",
    "support.reply": "ticket_TCK-3081",
    "support.resolved": "ticket_TCK-3081",
    "release_note.published": "route_news",
}


def test_every_template_has_params_fixture() -> None:
    assert set(PARAMS) == set(TEMPLATES)
    assert KID_TEMPLATES == {"lesson.reminder.kid", "lesson.missed.kid", "lesson.comeback.kid"}


@pytest.mark.parametrize("name", sorted(TEMPLATES))
@pytest.mark.parametrize("locale", ["ru", "uz"])
def test_renders_both_languages(name: str, locale: str) -> None:
    spec = TEMPLATES[name]
    r = spec.render(locale, PARAMS[name], Context(learner_name="Мадина", other_name="Алишер"))
    assert r.title and len(r.title) <= 200 and len(r.body) <= 1000
    text = r.telegram_text()
    assert 0 < len(text) <= 4000
    if not name.startswith("pin."):
        assert text == f"<b>{r.title}</b>\n{r.body}"
        base = name.removesuffix(".kid")
        assert r.startapp == STARTAPP[base] and r.buttons() == [[{"text": r.button, "startapp": r.startapp}]]
        assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", r.startapp)
    if locale == "uz":
        assert not re.search(r"[А-Яа-яЁё]", text.replace("Мадина", "").replace("Алишер", "")), text
    else:
        assert re.search(r"[А-Яа-я]", text)


def test_russian_texts() -> None:
    r = TEMPLATES["lesson.reminder"].render("ru", PARAMS["lesson.reminder"])
    assert (r.title, r.body) == (
        "Время занятия",
        "По графику — 15 минут английского. Начнём? Вы занимаетесь 5 дней подряд — отлично!",
    )
    assert r.button == "Начать занятие"
    one = TEMPLATES["lesson.reminder"].render("ru", {**PARAMS["lesson.reminder"], "streak_days": 1})
    assert "подряд" not in one.body  # серия из одного дня не упоминается
    r = TEMPLATES["lesson.missed"].render("ru", PARAMS["lesson.missed"])
    assert r.body.endswith("Следующее занятие по графику — 22.11.")
    r = TEMPLATES["invite.accepted"].render("ru", {"invite_id": INVITE, "kind": "family"}, Context(other_name="Алишер"))
    assert (r.title, r.body) == ("Алишер теперь в вашей семье", "Алишер принял(а) приглашение в семью TilHero.")
    r = TEMPLATES["support.reply"].render("ru", PARAMS["support.reply"])
    assert r.body == "Поддержка ответила на обращение TCK-3081. Откройте, чтобы прочитать."
    assert r.button == "Открыть обращение"
    pin = TEMPLATES["pin.reset_code"].render("ru", {"code": "135790", "ttl_minutes": 2})
    assert pin.telegram_text().endswith(
        "<b>135790</b>. Никому не сообщайте его. Действует 2 минуты. Новый PIN-код заработает через 24 часа."
    )
    assert pin.buttons() == []


def test_pin_reset_scheduled_local_time_without_code() -> None:
    """Ревью T-8: сообщение о запрошенном сбросе — местное время вступления в силу, без кода, кнопка в профиль."""
    params = PARAMS["pin.reset_scheduled"]
    r = TEMPLATES["pin.reset_scheduled"].render("ru", params, Context(timezone="Asia/Tashkent"))
    assert "19.11 10:30" in r.telegram_text() and "прежний код" in r.telegram_text()
    assert r.startapp == "route_profile" and not re.search(r"\d{6}", r.telegram_text())
    moscow = TEMPLATES["pin.reset_scheduled"].render("uz", params, Context(timezone="Europe/Moscow"))
    assert "19.11 08:30" in moscow.telegram_text()
    fallback = TEMPLATES["pin.reset_scheduled"].render("ru", params, Context(timezone="Nowhere/Bad"))
    assert "19.11 10:30" in fallback.telegram_text()
    spec = TEMPLATES["pin.reset_scheduled"]
    assert spec.direct_only and spec.transactional and not spec.in_app


def test_uzbek_texts() -> None:
    r = TEMPLATES["lesson.reminder.kid"].render("uz", PARAMS["lesson.reminder"], Context(learner_name="Madina"))
    assert r.title == "Madina: mashgʻulot vaqti" and r.button == "Mashgʻulotni boshlash"
    r = TEMPLATES["invite.pending"].render("uz", PARAMS["invite.pending"], Context(other_name="Alisher"))
    assert r.body == "Alisher sizni TilHero oilasiga taklif qilmoqda. Qabul qilish yoki rad etish uchun oching."
    assert lang_of("uz-Latn") == "uz" and lang_of("en") == "ru" and lang_of(None) == "ru"


@pytest.mark.parametrize("name", sorted(KID_TEMPLATES))
@pytest.mark.parametrize("locale", ["ru", "uz"])
def test_kid_texts_are_soft_and_name_the_child(name: str, locale: str) -> None:
    r = TEMPLATES[name].render(locale, PARAMS[name], Context(learner_name="Мадина"))
    assert r.title.startswith("Мадина: ")
    assert not FORBIDDEN.search(r.title + r.body), (name, locale)
    nameless = TEMPLATES[name].render(locale, PARAMS[name], Context())
    assert "None" not in nameless.title and nameless.title


@pytest.mark.parametrize("name", ["lesson.missed", "lesson.comeback"])
def test_adult_missed_texts_without_pressure(name: str) -> None:
    for locale in ("ru", "uz"):
        r = TEMPLATES[name].render(locale, PARAMS[name])
        assert not FORBIDDEN.search(r.title + r.body)


def test_names_are_escaped_and_cleaned() -> None:
    hostile = "<b>Ali</b>‮​\n\tsher" + "x" * 60
    name = clean_name(hostile)
    assert name is not None and len(name) <= 40 and "‮" not in name and "\n" not in name
    r = TEMPLATES["family.joined"].render("ru", PARAMS["family.joined"], Context(other_name=name))
    assert "<b>Ali</b>" not in r.telegram_text() and "&lt;b&gt;Ali&lt;/b&gt;" in r.telegram_text()
    assert clean_name("   ") is None and clean_name(None) is None and clean_name(42) is None
    r = TEMPLATES["invite.accepted"].render("ru", PARAMS["invite.accepted"], Context())
    assert r.body == "Ваше приглашение в TilHero приняли."  # имя неизвестно (удалён) — текст без имени


@pytest.mark.parametrize(
    ("name", "params"),
    [
        ("support.reply", {"number": "TCK-1", "text": "ответ оператора"}),  # текст ответа не принимается
        ("support.reply", {"number": "<b>1</b>"}),
        ("lesson.reminder", {**PARAMS["lesson.reminder"], "duration_min": 25}),
        ("invite.pending", {"invite_id": "nope", "kind": "family"}),
        ("family.joined", {"family_id": INVITE, "role": "child"}),
        ("pin.reset_code", {"code": "12345"}),
        ("pin.reset_scheduled", {"effective_at": "завтра"}),
    ],
)
def test_invalid_params(name: str, params: dict) -> None:
    with pytest.raises(TemplateError):
        TEMPLATES[name].render("ru", params)


def test_registry_flags() -> None:
    assert TEMPLATES["pin.reset_code"].direct_only and not TEMPLATES["pin.reset_code"].in_app
    assert not TEMPLATES["invite.declined"].gated
    categories = {s.category for s in TEMPLATES.values()}
    assert categories == {"reminders", "missed", "social", "support", "product", "service"}

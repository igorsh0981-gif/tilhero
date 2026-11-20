"""Версии шаблонов — чистые правила: плейсхолдеры каждого шаблона, строгая подстановка, проверка текстов при
сохранении (TEMPLATE_INVALID), отрисовка активной версии поверх кода и откат к коду при ошибке, рассылки."""

from __future__ import annotations

import logging

import pytest
from test_notifications_templates import PARAMS

from tilhero_notifications.domain.texts import (
    TextError,
    check_texts,
    has_pressure,
    normalize,
    placeholders_in,
    substitute,
)
from tilhero_notifications.templates import (
    CAMPAIGN_PLACEHOLDERS,
    EDITABLE,
    PLACEHOLDER_DESCRIPTIONS,
    SAMPLE_CONTEXT,
    TEMPLATES,
    Context,
    TextOverride,
    default_texts,
    render_campaign,
    sample_values,
)


def texts(ru_title: str = "Заголовок", ru_body: str = "Текст", uz_title: str = "Sarlavha", uz_body: str = "Matn",
          button: str | None = None) -> dict:
    return {"ru": {"title": ru_title, "body": ru_body, "button": button},
            "uz": {"title": uz_title, "body": uz_body, "button": button}}


def test_editable_registry_excludes_service_templates() -> None:
    assert "pin.reset_code" not in EDITABLE and "pin.reset_scheduled" not in EDITABLE
    assert set(EDITABLE) == {n for n in TEMPLATES if not n.startswith("pin.")}
    kids = {n for n in EDITABLE if TEMPLATES[n].kid}
    assert kids == {"lesson.reminder.kid", "lesson.missed.kid", "lesson.comeback.kid", "appeal_decided.kid",
                    "reviews_due.kid"}


@pytest.mark.parametrize("name", EDITABLE)
@pytest.mark.parametrize("lang", ["ru", "uz"])
def test_placeholders_match_declared_names_and_language(name: str, lang: str) -> None:
    spec = TEMPLATES[name]
    assert spec.description[0] and spec.description[1]
    assert all(p in PLACEHOLDER_DESCRIPTIONS for p in spec.placeholder_names)
    values = spec.placeholders(lang, spec.validate(PARAMS[name]), SAMPLE_CONTEXT[lang])  # type: ignore[arg-type]
    assert set(values) == set(spec.placeholder_names)
    samples = sample_values(spec, lang)
    assert set(samples) == set(spec.placeholder_names) and all(isinstance(v, str) for v in samples.values())
    if spec.kid:
        assert "streak_days" not in spec.placeholder_names  # серия детям не показывается
    defaults = default_texts(spec)
    # тексты по умолчанию — текущий рендерер на образцах; проходят те же правила, что и версии
    assert check_texts(defaults, allowed=spec.placeholder_names, kid=spec.kid) == []
    assert defaults[lang] == {
        k: v for k, v in zip(
            ("title", "body", "button"),
            (lambda r: (r.title, r.body, r.button))(spec.render(lang, spec.sample, SAMPLE_CONTEXT[lang])),
            strict=True,
        )
    }


def test_values_are_in_learner_language() -> None:
    reminder = TEMPLATES["lesson.reminder"]
    p = reminder.validate({"local_date": "2026-11-20", "slot_time": "19:00", "duration_min": 20, "streak_days": 3})
    assert reminder.values("ru", p, Context()) == {"duration": "20 минут", "slot_time": "19:00",
                                                   "streak_days": "3 дня"}
    assert reminder.values("uz", p, Context()) == {"duration": "20 daqiqa", "slot_time": "19:00",
                                                   "streak_days": "3 kun"}
    missed = TEMPLATES["lesson.missed"]
    m = missed.validate({"local_date": "2026-11-20", "consecutive_missed": 1, "next_slot_date": None})
    assert missed.values("ru", m, Context()) == {"missed_sessions": "1 занятие", "next_slot_date": ""}
    kid = TEMPLATES["lesson.reminder.kid"]
    assert kid.values("ru", p, Context())["learner_name"] == "Ваш ребёнок"  # имя неизвестно
    hostile = Context(learner_name="Ma‮dina\n<b>")
    assert kid.values("uz", p, hostile)["learner_name"] == "Madina <b>"  # управляющие символы вычищены


def test_substitute_is_strict() -> None:
    assert substitute("{{a}} {name}!", {"name": "Ali"}) == "{a} Ali!"
    assert substitute("Привет,  {name}  !", {"name": ""}) == "Привет, !"  # пустое значение — без двойных пробелов
    for bad in ("{x}", "{name.__class__}", "{name[0]}", "{name!r}", "{name:>10}", "{", "}", "{}", "{0}"):
        with pytest.raises(TextError):
            substitute(bad, {"name": "Ali"})
    assert placeholders_in("{a} {{b}} {c}") == ["a", "c"]
    with pytest.raises(ValueError):
        placeholders_in("{a.b}")


def test_check_texts_reasons() -> None:
    allowed = ("duration",)
    assert check_texts(texts(ru_body="По графику — {duration}"), allowed=allowed) == []
    errors = check_texts(
        {"ru": {"title": " ", "body": "x" * 1001, "button": "b" * 33}, "uz": None}, allowed=allowed
    )
    assert {(e["path"], e["reason"]) for e in errors} == {
        ("texts.ru.title", "required"), ("texts.ru.body", "too_long"), ("texts.ru.button", "too_long"),
        ("texts.uz", "required"),
    }
    errors = check_texts(texts(ru_title="t\x07", ru_body="{unknown}", uz_body="{duration", uz_title="a‮b"),
                         allowed=allowed)
    assert {(e["path"], e["reason"]) for e in errors} == {
        ("texts.ru.title", "control_chars"), ("texts.ru.body", "unknown_placeholder"),
        ("texts.uz.body", "invalid_placeholder"), ("texts.uz.title", "control_chars"),
    }
    # перевод строки допустим только в body
    assert check_texts(texts(ru_body="a\nb"), allowed=()) == []
    assert check_texts(texts(ru_title="a\nb"), allowed=()) == [{"path": "texts.ru.title", "reason": "control_chars"}]
    assert check_texts(texts(uz_body=""), allowed=()) == [{"path": "texts.uz.body", "reason": "required"}]


@pytest.mark.parametrize("word", ["Не потеряй серию!", "Это провал", "штраф", "Seriyani", "yo'qotma",
                                  "yo‘qotasiz", "yoʼqotma", "muvaffaqiyatsiz", "Jarima"])
def test_pressure_words_in_kid_texts(word: str) -> None:
    assert has_pressure(word)
    errors = check_texts(texts(ru_body=word, uz_body=word), allowed=(), kid=True)
    assert {e["reason"] for e in errors} == {"pressure_words"}
    assert check_texts(texts(ru_body=word, uz_body=word), allowed=(), kid=False) == []


def test_normalize_trims_and_empty_button() -> None:
    out = normalize({"ru": {"title": " A ", "body": " B ", "button": "  "}, "uz": {"title": "C", "body": "D",
                                                                                     "button": " Go "}})
    assert out == {"ru": {"title": "A", "body": "B", "button": None}, "uz": {"title": "C", "body": "D",
                                                                            "button": "Go"}}


def test_render_with_active_version() -> None:
    spec = TEMPLATES["lesson.reminder"]
    override = TextOverride("lesson.reminder", 3, texts(
        ru_title="Пора заниматься в {slot_time}", ru_body="<b>{duration}</b> & {streak_days} подряд",
        uz_title="{slot_time} — vaqt", uz_body="{duration}",
    ))
    r = spec.render("ru", PARAMS["lesson.reminder"], Context(), override)
    assert (r.title, r.body, r.button, r.startapp) == (
        "Пора заниматься в 19:00", "<b>15 минут</b> & 5 дней подряд", "Начать занятие", "route_home"
    )
    # текст сотрудника — простой текст: экранируется для Telegram
    assert r.telegram_text() == "<b>Пора заниматься в 19:00</b>\n&lt;b&gt;15 минут&lt;/b&gt; &amp; 5 дней подряд"
    uz = spec.render("uz", PARAMS["lesson.reminder"], Context(), override)
    assert (uz.title, uz.body, uz.button) == ("19:00 — vaqt", "15 daqiqa", "Mashgʻulotni boshlash")
    with_button = TextOverride("lesson.reminder", 4, texts(button="Вперёд"))
    assert spec.render("ru", PARAMS["lesson.reminder"], Context(), with_button).button == "Вперёд"


def test_render_falls_back_to_code_on_substitution_error(caplog: pytest.LogCaptureFixture) -> None:
    spec = TEMPLATES["support.reply"]
    broken = TextOverride("support.reply", 2, texts(ru_body="Обращение {removed_placeholder}"))
    with caplog.at_level(logging.WARNING, logger="tilhero.notifications.templates"):
        r = spec.render("ru", PARAMS["support.reply"], Context(), broken)
    assert r.body == "Поддержка ответила на обращение TCK-3081. Откройте, чтобы прочитать."
    assert any("code text used" in rec.getMessage() for rec in caplog.records)
    # служебный шаблон версию не принимает никогда
    pin = TEMPLATES["pin.reset_code"].render("ru", PARAMS["pin.reset_code"], None,
                                             TextOverride("pin.reset_code", 1, texts()))
    assert "482913" in pin.telegram_text()


def test_render_campaign() -> None:
    t = texts(ru_title="Новости, {learner_name}", ru_body="Привет, {learner_name} ! Новое в TilHero", button=None)
    r = render_campaign("ru", t, "news", "Алишер")
    assert (r.title, r.body, r.button, r.startapp) == (
        "Новости, Алишер", "Привет, Алишер ! Новое в TilHero", "Открыть TilHero", "route_news"
    )
    nameless = render_campaign("ru", t, None, None)
    assert nameless.body == "Привет, ! Новое в TilHero" and nameless.buttons() == []
    assert CAMPAIGN_PLACEHOLDERS == ("learner_name",)
    with pytest.raises(TextError):
        render_campaign("ru", texts(ru_body="{duration}"), None, "A")

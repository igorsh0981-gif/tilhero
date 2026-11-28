"""Шаблоны RU/UZ: тексты, кнопки startapp, экранирование, детские формулировки, имена без PII-мусора."""

from __future__ import annotations

import re
import uuid

import pytest

from tilhero_notifications.domain.texts import PRESSURE_WORDS
from tilhero_notifications.templates import (
    BILLING_TEMPLATES,
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
    "media_request.decided": {"request_id": INVITE, "request_title": "Moonlight Café", "status": "rejected",
                              "linked_asset_id": None},
    "appeal_decided": {"appeal_id": INVITE, "evaluation_id": INVITE, "decision": "corrected"},
    "reviews_due": {"local_date": "2026-11-20", "due_count": 12},
    "streak_frozen": {"local_date": "2026-11-19", "freeze_left": 1},
    "badge_earned": {"badge_code": "streak_7"},
    "hero_stage_reached": {"hero_code": "human_0", "stage": 2},
    "pin.reset_code": {"code": "482913", "ttl_minutes": 10},
    "pin.reset_scheduled": {"effective_at": "2026-11-19T05:30:00.000Z"},
    # спринт 7 — социальное
    "friend_request": {"request_id": INVITE, "nickname": "Alisher_7"},
    "friend_accepted": {"nickname": None},
    "duel_challenged": {"duel_id": INVITE, "nickname": "Ali_07", "accept_deadline": "2026-11-22T13:00:00Z"},
    "duel_finished": {"duel_id": INVITE, "outcome": "loss", "result_version": 2, "correct": 6, "total": 10},
    "league_closed": {"week": "2026-11-16", "place": 3, "xp": 520, "prize_til": 20},
    "pair_invited": {"room_id": INVITE, "nickname": "Madina", "start_at": "2026-11-22T13:00:00Z", "scheduled": True},
    "pair_starting": {"room_id": INVITE},
    "pair_stopped": {"room_id": INVITE},
    "referral_qualified": {"referral_id": INVITE, "freeze": 2, "til": 15},
    "referral_rejected": {"referral_id": INVITE, "reject_code": "monthly_cap"},
    "sanction_applied": {"sanction_id": INVITE, "kind": "social_ban", "until": None},
    "sanction_appeal_decided": {"appeal_id": INVITE, "decision": "upheld"},
    "complaint_resolved": {"case_id": INVITE, "outcome": "dismissed"},
    # спринт 8 — оплата и подписка (billing)
    "payment_succeeded": {"order_no": 100_042, "product_kind": "subscription",
                          "product_title": {"ru": "Плюс 30 дней", "uz": "Plus 30 kun"}, "amount_stars": 300,
                          "renewal": False, "ends_at": "2026-12-22T19:00:00Z"},
    "purchase_applied": {"order_id": INVITE, "product_kind": "til_pack", "til": 550, "for_child": True},
    "refund_completed": {"order_id": INVITE, "stars": False, "product_kind": "subscription"},
    "subscription_expiring": {"period_id": INVITE, "ends_at": "2026-12-22T19:00:00Z", "days_left": 0,
                              "minutes_left": 12},
    "subscription_expired": {"period_id": INVITE},
    "stars_renewal_failed": {"subscription_id": INVITE, "expires_at": "2026-12-22T19:00:00Z"},
    "minutes_low": {"period_id": INVITE, "minutes_left": 21, "minutes_granted": 300},
    "minutes_adjusted": {"adjustment_id": INVITE, "kind": "grant_period", "days": 7},
    "trial_started": {"period_id": INVITE, "ends_at": "2026-11-29T19:00:00Z", "minutes_granted": 60},
}
KID_BASES = ("lesson.reminder", "lesson.missed", "lesson.comeback", "appeal_decided", "reviews_due", "streak_frozen",
             "badge_earned", "hero_stage_reached",
             # спринт 7: только то, что доступно детям 6–13 (семья), и решения модерации
             "duel_challenged", "duel_finished", "pair_invited", "pair_starting", "pair_stopped", "sanction_applied",
             "sanction_appeal_decided", "complaint_resolved")
for base in KID_BASES:
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
    "media_request.decided": "route_media_requests",
    "appeal_decided": "route_lessons",
    "reviews_due": "route_review",
    "streak_frozen": "route_home",
    "badge_earned": "route_progress",
    "hero_stage_reached": "route_home",
    "friend_request": "route_friends",
    "friend_accepted": "route_friends",
    "duel_challenged": f"duel_{INVITE}",
    "duel_finished": f"duel_{INVITE}",
    "league_closed": "route_leagues",
    "pair_invited": f"room_{INVITE}",
    "pair_starting": f"room_{INVITE}",
    "pair_stopped": f"room_{INVITE}",
    "referral_qualified": "route_referrals",
    "referral_rejected": "route_referrals",
    "sanction_applied": "route_friends",
    "sanction_appeal_decided": "route_friends",
    "complaint_resolved": None,  # §5: без ссылки
    # спринт 8: всё об оплате и подписке ведёт в «Подписку» Mini App
    **{name: "route_subscription" for name in (
        "payment_succeeded", "purchase_applied", "refund_completed", "subscription_expiring", "subscription_expired",
        "stars_renewal_failed", "minutes_low", "minutes_adjusted", "trial_started")},
}


def test_every_template_has_params_fixture() -> None:
    assert set(PARAMS) == set(TEMPLATES)
    assert KID_TEMPLATES == {f"{base}.kid" for base in KID_BASES}


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
        assert r.startapp == STARTAPP[base]
        if r.startapp is None:
            assert r.buttons() == []
        else:
            assert r.buttons() == [[{"text": r.button, "startapp": r.startapp}]]
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
    assert categories == {"reminders", "missed", "social", "support", "product", "service", "game"}
    # спринт 6: детям — только центр у шаблонов игры; спринт 7 — и у всех социальных
    sprint7 = {"friend_request", "friend_accepted", "duel_challenged", "duel_finished", "league_closed",
               "pair_invited", "pair_starting", "pair_stopped", "referral_qualified", "referral_rejected",
               "sanction_applied", "sanction_appeal_decided", "complaint_resolved"}
    assert {n for n, s in TEMPLATES.items() if s.kid_in_app_only} == {
        "streak_frozen", "streak_frozen.kid", "badge_earned", "badge_earned.kid", "hero_stage_reached",
        "hero_stage_reached.kid", *sprint7, *(f"{n}.kid" for n in sprint7 if f"{n}.kid" in TEMPLATES)}
    # спринт 7: категории §5; санкции и обжалования — service (не выключаются) и не редактируются в админке
    assert {n: TEMPLATES[n].category for n in sprint7} == {
        "friend_request": "social", "friend_accepted": "social", "duel_challenged": "game", "duel_finished": "game",
        "league_closed": "game", "pair_invited": "social", "pair_starting": "social", "pair_stopped": "social",
        "referral_qualified": "social", "referral_rejected": "social", "sanction_applied": "service",
        "sanction_appeal_decided": "service", "complaint_resolved": "social"}
    assert {n for n, s in TEMPLATES.items() if not s.staff_editable} == {
        "sanction_applied", "sanction_applied.kid", "sanction_appeal_decided", "sanction_appeal_decided.kid",
        *BILLING_TEMPLATES}
    # спринт 8: оплата и подписка — service, без детских вариантов, с центром, без обхода тихих часов
    assert len(BILLING_TEMPLATES) == 9
    for name in BILLING_TEMPLATES:
        spec = TEMPLATES[name]
        assert (spec.category, spec.kid_variant, spec.in_app, spec.transactional, spec.direct_only) == (
            "service", None, True, False, False), name

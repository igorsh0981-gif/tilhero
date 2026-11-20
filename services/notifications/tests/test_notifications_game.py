"""Спринт 6 (INTERNAL_API спринта 6 §3, AT-65/66/70): шаблоны игры `streak_frozen`, `badge_earned`,
`hero_stage_reached` (+ `*.kid`, RU/UZ, редактируемые) и потребитель событий gamification (только от gamification):
категория game (выключатель — GAME_CATEGORY_GATE, пока reminders; в центре и в админке — как reminders), общий
лимит дня, тихие часы и выключатель; флаг notify у значка и ступени; дети 6–13 — только центр детского профиля
(опекуну «в сводке», без Telegram); одно уведомление на день заморозки, на значок и на ступень."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from notif_testkit import at, local_day
from test_notifications_staff_templates import MANAGE, activate, create

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_notifications.domain.policy import Item, Recipient, Rules, decide, limit_applies
from tilhero_notifications.domain.texts import PRESSURE_WORDS
from tilhero_notifications.templates import (
    EDITABLE,
    TEMPLATES,
    Context,
    TemplateError,
    badge_title,
    public_category,
)

FROZEN, BADGE, HERO = "game.streak.frozen.v1", "game.badge.earned.v1", "game.hero.stage_reached.v1"
DURABLE = "notifications.game"
KEYS = ("streak_frozen", "badge_earned", "hero_stage_reached")


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


async def frozen(env, user: uuid.UUID, day: date, *, left: int = 1, producer: str = "gamification") -> Envelope:
    return await env.publish(FROZEN, {"user_id": str(user), "local_date": day.isoformat(), "op_id": str(uuid.uuid4()),
                                      "freeze_left": left, "frozen_at": iso(at(day + timedelta(days=1), "00:05"))},
                             producer=producer)


async def badge(env, user: uuid.UUID, code: str = "streak_7", *, notify: bool = True,
                earned_at: datetime | None = None, producer: str = "gamification") -> Envelope:
    return await env.publish(BADGE, {"user_id": str(user), "badge_code": code, "notify": notify,
                                     "earned_at": iso(earned_at or at(local_day(1), "12:00"))}, producer=producer)


async def hero(env, user: uuid.UUID, code: str = "pet_0", stage: int = 2, *, notify: bool = True,
               reached_at: datetime | None = None, producer: str = "gamification") -> Envelope:
    return await env.publish(HERO, {"user_id": str(user), "hero_code": code, "stage": stage, "confirmed_skills": 5,
                                    "notify": notify, "reached_at": iso(reached_at or at(local_day(1), "12:00"))},
                             producer=producer)


# ---------------------------------------------------------------- шаблоны


def test_registry_category_kid_variants_and_editable() -> None:
    for key in KEYS:
        spec, kid = TEMPLATES[key], TEMPLATES[f"{key}.kid"]
        assert spec.category == kid.category == "game"
        assert spec.kid_variant == f"{key}.kid" and kid.kid and not spec.kid
        assert spec.kid_in_app_only and kid.kid_in_app_only and spec.in_app and spec.gated
        assert key in EDITABLE and f"{key}.kid" in EDITABLE
        assert kid.placeholder_names == ("learner_name", *spec.placeholder_names)
    assert TEMPLATES["streak_frozen"].placeholder_names == ("date", "left")
    assert TEMPLATES["badge_earned"].placeholder_names == ("badge",)
    assert TEMPLATES["hero_stage_reached"].placeholder_names == ("hero", "grew", "stage")
    assert public_category("game") == "reminders" and public_category("missed") == "missed"


def test_streak_frozen_texts() -> None:
    spec = TEMPLATES["streak_frozen"]
    r = spec.render("ru", {"local_date": "2026-11-19", "freeze_left": 1})
    assert (r.title, r.body, r.button, r.startapp) == (
        "Серия спасена", "Заморозка закрыла пропуск 19.11. Осталось заморозок: 1.", "Открыть TilHero", "route_home")
    # запас больше max_stock (бонусы, ручное начисление) — не ошибка контракта (ревью спринта 6)
    assert spec.render("ru", {"local_date": "2026-11-19", "freeze_left": 34}).body.endswith("Осталось заморозок: 34.")
    u = spec.render("uz", {"local_date": "2026-11-19", "freeze_left": 0})
    assert (u.title, u.body) == (
        "Seriya saqlab qolindi", "Muzlatish 19.11 kuni oʻtkazib yuborilgan mashgʻulotni yopdi. Qolgan muzlatishlar: 0.")
    assert spec.values("ru", spec.validate({"local_date": "2026-11-19", "freeze_left": 4}), Context()) == {
        "date": "19.11", "left": "4"}


def test_badge_texts_and_names() -> None:
    spec = TEMPLATES["badge_earned"]
    r = spec.render("ru", {"badge_code": "streak_7"})
    assert (r.title, r.body, r.button, r.startapp) == (
        "Поздравляем!", "Новый значок: 7 дней подряд.", "Открыть достижения", "route_progress")
    u = spec.render("uz", {"badge_code": "first_lesson"})
    assert (u.title, u.body, u.button) == ("Tabriklaymiz!", "Yangi nishon: Birinchi dars.", "Yutuqlarni ochish")
    names = {code: badge_title("ru", code) for code in (
        "first_lesson", "streak_7", "streak_30", "streak_100", "streak_1", "streak_22", "skills_10", "skills_1",
        "skills_2", "skills_50", "skill_retained", "reviews_100", "reviews_1000", "reviews_2", "readings_10",
        "readings_1", "readings_3", "first_freeze", "streak_x", "streak_0", "mystery_badge", "skills_")}
    assert names == {
        "first_lesson": "Первый урок", "streak_7": "7 дней подряд", "streak_30": "30 дней подряд",
        "streak_100": "100 дней подряд", "streak_1": "1 день подряд", "streak_22": "22 дня подряд",
        "skills_10": "10 подтверждённых навыков", "skills_1": "1 подтверждённый навык",
        "skills_2": "2 подтверждённых навыка", "skills_50": "50 подтверждённых навыков",
        "skill_retained": "Первый закреплённый навык", "reviews_100": "100 повторённых карточек",
        "reviews_1000": "1000 повторённых карточек", "reviews_2": "2 повторённые карточки",
        "readings_10": "10 прочитанных текстов", "readings_1": "1 прочитанный текст",
        "readings_3": "3 прочитанных текста", "first_freeze": "Первая заморозка",
        # неизвестный код — общее название, а не код
        "streak_x": "Новое достижение", "streak_0": "Новое достижение", "mystery_badge": "Новое достижение",
        "skills_": "Новое достижение",
    }
    assert badge_title("uz", "streak_30") == "Ketma-ket 30 kun"
    assert badge_title("uz", "skills_10") == "10 ta tasdiqlangan koʻnikma"
    assert badge_title("uz", "unknown_x") == "Yangi yutuq"


def test_hero_texts_gender_and_unknown_hero() -> None:
    spec = TEMPLATES["hero_stage_reached"]
    r = spec.render("ru", {"hero_code": "pet_0", "stage": 2})
    assert (r.title, r.body, r.startapp) == ("Новая ступень героя", "Дракончик Мятик вырос: Малыш!", "route_home")
    assert spec.render("ru", {"hero_code": "human_0", "stage": 3}).body == "Ученица Нилу выросла: Знаток!"
    assert spec.render("ru", {"hero_code": "human_2", "stage": 2}).body == "Ученица Ая выросла: Путешественник!"
    assert spec.render("ru", {"hero_code": "robot_1", "stage": 3}).body == "Робот Искра вырос: Полёт!"
    assert spec.render("ru", {"hero_code": "robot_7", "stage": 2}).body == "Герой вырос: Запуск!"
    u = spec.render("uz", {"hero_code": "pet_2", "stage": 3})
    assert (u.title, u.body) == ("Qahramonning yangi bosqichi", "Ajdarcha Siren oʻsdi: Qanotlar!")
    assert spec.values("ru", spec.validate({"hero_code": "human_0", "stage": 2}), Context()) == {
        "hero": "Ученица Нилу", "grew": "выросла", "stage": "Путешественник"}


@pytest.mark.parametrize("key", KEYS)
@pytest.mark.parametrize("locale", ["ru", "uz"])
def test_kid_variants_to_parent_soft(key: str, locale: str) -> None:
    kid = TEMPLATES[f"{key}.kid"]
    params = {"streak_frozen": {"local_date": "2026-11-19", "freeze_left": 1},
              "badge_earned": {"badge_code": "streak_30"},  # значок серии — без слова «серия»
              "hero_stage_reached": {"hero_code": "pet_1", "stage": 2}}[key]
    r = kid.render(locale, params, Context(learner_name="Мадина"))
    assert r.title.startswith("Мадина: ") and not PRESSURE_WORDS.search(r.title + r.body)
    nameless = kid.render(locale, params, Context())
    assert nameless.title and "None" not in nameless.title and not PRESSURE_WORDS.search(nameless.title)
    assert kid.values(locale, kid.validate(params), Context())["learner_name"] in ("Ваш ребёнок", "Farzandingiz")


def test_kid_texts_ru() -> None:
    ctx = Context(learner_name="Мадина")
    r = TEMPLATES["streak_frozen.kid"].render("ru", {"local_date": "2026-11-19", "freeze_left": 2}, ctx)
    assert (r.title, r.body) == ("Мадина: заморозка помогла",
                                 "Пропуск 19.11 закрыт заморозкой — можно спокойно продолжать. Заморозок осталось: 2.")
    r = TEMPLATES["badge_earned.kid"].render("ru", {"badge_code": "first_lesson"}, ctx)
    assert (r.title, r.body) == ("Мадина: новый значок",
                                 "Новый значок: Первый урок — отличный повод порадоваться вместе!")
    r = TEMPLATES["hero_stage_reached.kid"].render("ru", {"hero_code": "pet_0", "stage": 2}, ctx)
    assert (r.title, r.body) == ("Мадина: новая ступень героя", "Дракончик Мятик вырос: Малыш! Посмотрите вместе.")


@pytest.mark.parametrize(("key", "bad"), [
    ("streak_frozen", {"local_date": "2026-11-19", "freeze_left": 1.5}),
    ("streak_frozen", {"local_date": "2026-11-19", "freeze_left": -1}),
    ("streak_frozen", {"local_date": "вчера", "freeze_left": 1}),
    ("streak_frozen", {"local_date": "2026-11-19", "freeze_left": 1, "op_id": str(uuid.uuid4())}),
    ("badge_earned", {"badge_code": "Streak 7"}),
    ("badge_earned", {"badge_code": "ab"}),
    ("badge_earned", {"badge_code": "streak_7", "title": "текст ученика"}),
    ("hero_stage_reached", {"hero_code": "pet_0", "stage": 1}),
    ("hero_stage_reached", {"hero_code": "cat_0", "stage": 2}),
    ("hero_stage_reached", {"hero_code": "pet_0", "stage": 2, "name": "Мой дракон"}),
])
def test_invalid_params(key: str, bad: dict[str, Any]) -> None:
    with pytest.raises(TemplateError):
        TEMPLATES[key].render("ru", bad)


# ---------------------------------------------------------------- политика


def _who(**kw: Any) -> Recipient:
    base: dict[str, Any] = dict(status="ACTIVE", categories=frozenset({"reminders", "support"}),
                                notifications_enabled=True, quiet_hours=None, timezone="Asia/Tashkent", is_kid=False,
                                has_address=True)
    base.update(kw)
    return Recipient(**base)


def test_policy_game_gate_kids_and_limit() -> None:
    now = datetime(2026, 11, 20, 7, 0, tzinfo=UTC)  # 12:00 Ташкент
    gated = Rules(category_gates={"game": "reminders"})
    strict = Rules(category_gates={"game": "game"})
    game = Item("game", kid_in_app_only=True)
    assert decide(game, _who(), now, gated).action == "send"
    off = decide(game, _who(categories=frozenset({"support", "missed"})), now, gated)
    assert (off.action, off.reason) == ("skip", "category_disabled")
    # когда game появится в настройках ученика — её собственный выключатель
    assert decide(game, _who(), now, strict).reason == "category_disabled"
    assert decide(game, _who(categories=frozenset({"game"})), now, strict).action == "send"
    # без отображения — категория сама себе выключатель (остальные категории не затронуты)
    assert decide(Item("reminders"), _who(), now, Rules()).action == "send"
    assert decide(game, _who(), now, Rules()).reason == "category_disabled"
    # дети 6–13: только центр; выключенная категория — раньше (ничего не создаётся)
    kid = decide(game, _who(is_kid=True), now, gated)
    assert (kid.action, kid.reason) == ("in_app_only", "kid_summary")
    assert decide(game, _who(is_kid=True, categories=frozenset()), now, gated).reason == "category_disabled"
    # остальные шаблоны детям — как прежде (опекуну в окне)
    assert decide(Item("reminders"), _who(is_kid=True), now, gated).action == "send"
    assert limit_applies("game")
    # выключатель выключен — запись остаётся в центре без Telegram (взрослый и ребёнок), остальные категории — skip
    soft = Rules(category_gates={"game": "reminders"}, center_when_disabled=frozenset({"game"}))
    off_soft = decide(game, _who(categories=frozenset({"support"})), now, soft)
    assert (off_soft.action, off_soft.reason) == ("in_app_only", "category_disabled_center")
    assert decide(game, _who(is_kid=True, categories=frozenset()), now, soft).action == "in_app_only"
    assert decide(Item("reminders"), _who(categories=frozenset({"support"})), now, soft).reason == "category_disabled"
    assert decide(game, _who(), now, soft).action == "send"


# ---------------------------------------------------------------- потребитель и доставка


async def test_streak_frozen_reaches_telegram_and_center(env) -> None:
    user, day = env.add_user(), local_day(1)
    ev = await frozen(env, user, day, left=1)
    row = await env.one(user)
    assert (row.template, row.category, row.telegram_status) == ("streak_frozen", "game", "scheduled")
    assert row.dedup_key == f"streak_frozen:{user}:{day.isoformat()}" and str(row.source_event_id) == ev.event_id
    assert row.params == {"local_date": day.isoformat(), "freeze_left": 1}  # op_id и время — не в параметрах
    assert row.stale_after == at(day + timedelta(days=1), "22:00")
    await env.dispatch(at(day + timedelta(days=1), "09:00"))
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(user)
    assert msg["text"] == f"<b>Серия спасена</b>\nЗаморозка закрыла пропуск {day:%d.%m}. Осталось заморозок: 1."
    assert msg["buttons"] == [[{"text": "Открыть TilHero", "startapp": "route_home"}]]
    row = await env.row(row.notification_id)
    assert row.telegram_status == "sent" and row.params is None and row.limit_day == day + timedelta(days=1)
    [item] = (await env.inbox(user))["items"]
    # в центре — категория контракта (game там пока нет — reminders)
    assert (item["category"], item["title"], item["startapp"]) == ("reminders", "Серия спасена", "route_home")
    assert env.bus.dlq == []


async def test_badge_and_hero_delivered_uz(env) -> None:
    user, day = env.add_user(locale="uz"), local_day(1)
    await badge(env, user, "reviews_100", earned_at=at(day, "12:00"))
    await hero(env, user, "human_1", 3, reached_at=at(day, "12:00"))
    await env.dispatch(at(day, "12:01"))
    texts = sorted(c["text"] for c in env.gateway.calls)
    assert texts == ["<b>Qahramonning yangi bosqichi</b>\nOʻquvchi Timur oʻsdi: Bilimdon!",
                     "<b>Tabriklaymiz!</b>\nYangi nishon: 100 ta takrorlangan soʻz."]
    rows = {r.template: r for r in await env.rows(user)}
    assert rows["badge_earned"].dedup_key == f"badge_earned:{user}:reviews_100"
    assert rows["hero_stage_reached"].dedup_key == f"hero_stage_reached:{user}:3"
    assert rows["badge_earned"].stale_after == at(day, "12:00") + timedelta(hours=12)


async def test_one_notification_per_day_badge_and_stage(env) -> None:
    user, day = env.add_user(), local_day(1)
    ev = await frozen(env, user, day)
    spec = next(s for s in env.bus.specs if s.durable == DURABLE)
    await spec.handler(ev)  # повтор доставки — inbox
    await frozen(env, user, day, left=0)  # повторная публикация того же дня — ключ дедупликации
    await frozen(env, user, day + timedelta(days=1))  # другой день — своё уведомление
    for _ in range(2):
        await badge(env, user, "first_lesson")
        await hero(env, user, "robot_0", 2)
    await hero(env, user, "pet_1", 2)  # смена героя: ступень та же — не новое событие
    await hero(env, user, "pet_1", 3)
    assert sorted(r.dedup_key.split(":")[0] for r in await env.rows(user)) == [
        "badge_earned", "hero_stage_reached", "hero_stage_reached", "streak_frozen", "streak_frozen"]


async def test_notify_false_creates_nothing_but_streak_always(env) -> None:
    user, day = env.add_user(), local_day(1)
    await badge(env, user, notify=False)
    await hero(env, user, notify=False)
    assert await env.rows(user) == []
    await frozen(env, user, day)  # у заморозки флага нет — уведомление о серии всегда
    assert [r.template for r in await env.rows(user)] == ["streak_frozen"]


async def test_category_gate_switch_and_quiet_hours(env) -> None:
    day = local_day(1)
    no_reminders = env.add_user(categories=("missed", "social", "support", "product"))
    switched_off = env.add_user(enabled=False)
    quiet = env.add_user(quiet={"start": "11:00", "end": "13:00"})
    for user in (no_reminders, switched_off, quiet):
        await badge(env, user, earned_at=at(day, "12:00"))
    await env.dispatch(at(day, "12:00"))
    row = await env.one(no_reminders)
    # выключатель выключен — без Telegram, но запись остаётся в центре (e2e спринта 6: «Серия спасена» видна всегда)
    assert (row.telegram_status, row.reason) == ("in_app_only", "category_disabled_center")
    assert len((await env.inbox(no_reminders))["items"]) == 1
    row = await env.one(switched_off)
    assert (row.telegram_status, row.reason) == ("in_app_only", "notifications_disabled")
    row = await env.one(quiet)
    assert (row.telegram_status, row.reason, row.scheduled_for) == ("scheduled", "quiet_hours", at(day, "13:00"))
    assert env.gateway.calls == []
    # GAME_CATEGORY_GATE=game (когда категория появится в настройках ученика): reminders её больше не включает
    env.settings.game_category_gate = "game"
    with_game, only_reminders = env.add_user(categories=("reminders", "game")), env.add_user()
    for user in (with_game, only_reminders):
        await badge(env, user, earned_at=at(day, "12:00"))
    await env.dispatch(at(day, "12:05"))
    assert (await env.one(only_reminders)).reason == "category_disabled_center"
    assert [c["telegram_user_id"] for c in env.gateway.calls] == [env.telegram_id(with_game)]


async def test_daily_limit_counts_game(env) -> None:
    user, day = env.add_user(), local_day(1)
    await env.reminder(user, day, "11:00")
    for _ in range(2):
        await env.invite("accepted", user, env.add_user())
    await env.dispatch(at(day, "11:30"))
    assert len(env.gateway.calls) == 3
    await badge(env, user, earned_at=at(day, "12:00"))
    await env.dispatch(at(day, "12:00"))
    assert len(env.gateway.calls) == 3
    row = next(r for r in await env.rows(user) if r.template == "badge_earned")
    assert (row.telegram_status, row.reason) == ("in_app_only", "daily_limit")
    # игра тоже расходует лимит: после трёх игровых сообщений напоминание — только центр
    other, next_day = env.add_user(), local_day(2)
    await frozen(env, other, next_day - timedelta(days=1))
    await badge(env, other, "first_lesson", earned_at=at(next_day, "09:00"))
    await hero(env, other, reached_at=at(next_day, "09:00"))
    await env.dispatch(at(next_day, "09:05"))
    assert len(env.gateway.to(env.telegram_id(other))) == 3
    await env.reminder(other, next_day, "10:00")
    await env.dispatch(at(next_day, "10:00"))
    row = next(r for r in await env.rows(other) if r.template == "lesson.reminder")
    assert (row.telegram_status, row.reason) == ("in_app_only", "daily_limit")


async def test_stale_goes_to_center_only(env) -> None:
    user, day = env.add_user(), local_day(1)
    await badge(env, user, earned_at=at(day, "08:00"))
    await env.dispatch(at(day, "20:01"))  # позже события + 12 ч
    row = await env.one(user)
    assert (row.telegram_status, row.reason) == ("in_app_only", "stale")
    late = env.add_user()
    await frozen(env, late, day)
    await env.dispatch(at(day + timedelta(days=1), "22:00"))  # после 22:00 следующего дня
    assert ((await env.one(late)).telegram_status, (await env.one(late)).reason) == ("in_app_only", "stale")
    assert env.gateway.calls == []


async def test_child_only_in_child_center_softly(env) -> None:
    """Дети 6–13: опекуну «только в сводке» — запись в центре детского профиля (текст *.kid — родителю, с именем,
    мягко), push ни ребёнку, ни опекуну; центр опекуна пуст."""
    parent = env.add_user(name="Нигора")
    child = env.add_child(parent, name="Мадина", age_band="6-9")
    day = local_day(1)
    await frozen(env, child, day, left=2)
    await badge(env, child, "streak_7", earned_at=at(day, "12:00"))
    await hero(env, child, "pet_0", 2, reached_at=at(day, "12:00"))
    await env.dispatch(at(day + timedelta(days=1), "10:00"))
    await env.dispatch(at(day, "12:01"))
    assert env.gateway.calls == []
    rows = {r.template: r for r in await env.rows(child)}
    assert set(rows) == {"streak_frozen.kid", "badge_earned.kid", "hero_stage_reached.kid"}
    assert {(r.telegram_status, r.reason) for r in rows.values()} == {("in_app_only", "kid_summary")}
    items = (await env.inbox(child))["items"]
    texts = {i["title"]: i["body"] for i in items}
    assert texts == {
        "Мадина: заморозка помогла": f"Пропуск {day:%d.%m} закрыт заморозкой — можно спокойно продолжать. "
                                     "Заморозок осталось: 2.",
        "Мадина: новый значок": "Новый значок: 7 дней подряд — отличный повод порадоваться вместе!",
        "Мадина: новая ступень героя": "Дракончик Мятик вырос: Малыш! Посмотрите вместе.",
    }
    assert not any(PRESSURE_WORDS.search(t + b) for t, b in texts.items())
    assert (await env.inbox(parent))["items"] == []
    # ребёнок 10–13 в аккаунте (не детский профиль) — те же правила
    kid_account = env.add_user(age_band="10-13")
    await badge(env, kid_account, earned_at=at(day, "12:00"))
    await env.dispatch(at(day, "12:02"))
    assert ((await env.one(kid_account)).reason, env.gateway.calls) == ("kid_summary", [])


async def test_teen_gets_regular_messages(env) -> None:
    teen, day = env.add_user(age_band="14-17"), local_day(1)
    await hero(env, teen, "human_0", 2, reached_at=at(day, "12:00"))
    await env.dispatch(at(day, "12:01"))
    [msg] = env.gateway.calls
    assert msg["text"] == "<b>Новая ступень героя</b>\nУченица Нилу выросла: Путешественник!"


async def test_foreign_producer_deleted_user_and_invalid_payload(env, caplog) -> None:
    user, day = env.add_user(), local_day(1)
    caplog.set_level(logging.WARNING, logger="tilhero.notifications.consumers")
    for producer in ("learning-plan", "lessons", "telegram-bff", "notifications", "admin-bff", "memory"):
        await frozen(env, user, day, producer=producer)
        await badge(env, user, producer=producer)
        await hero(env, user, producer=producer)
    assert await env.rows(user) == []
    warned = [r for r in caplog.records if r.getMessage() == "game event from unexpected producer ignored"]
    assert len(warned) == 18 and all(str(user) not in str(r.__dict__) for r in warned)
    # события уже исполненного удаления — без записи; удаление стирает и игровые уведомления
    await badge(env, user, "first_lesson")
    assert len(await env.rows(user)) == 1
    await env.delete(user)
    assert await env.rows(user) == []
    await hero(env, user)
    await frozen(env, user, day)
    assert await env.rows(user) == []
    other = env.add_user()
    bad = [
        make_envelope(HERO, {"user_id": str(other), "hero_code": "pet_0", "stage": 1, "confirmed_skills": 0,
                             "notify": True, "reached_at": "2026-11-20T10:00:00Z"}, producer="gamification"),
        make_envelope(BADGE, {"user_id": str(other), "badge_code": "streak_7", "earned_at": "2026-11-20T10:00:00Z"},
                      producer="gamification"),
        make_envelope(FROZEN, {"user_id": str(other), "local_date": "2026-11-19", "op_id": str(uuid.uuid4()),
                               "freeze_left": -1, "frozen_at": "2026-11-20T00:05:00Z"}, producer="gamification"),
    ]
    for ev in bad:
        await env.bus.publish(ev)
    assert [e.event_id for _, e in env.bus.dlq] == [e.event_id for e in bad]
    assert await env.rows(other) == []


async def test_staff_list_category_and_active_version(env) -> None:
    r = await env.client.get("/admin/v1/notifications/templates", headers=env.staff(MANAGE))
    assert r.status_code == 200, r.text
    items = {i["key"]: i for i in r.json()["items"]}
    for key in (*KEYS, *(f"{k}.kid" for k in KEYS)):
        # в контракте admin.ts категории game пока нет — карточка показывает reminders
        assert items[key]["category"] == "reminders", key
    r = await env.client.get("/admin/v1/notifications/templates/hero_stage_reached", headers=env.staff(MANAGE))
    assert [p["name"] for p in r.json()["placeholders"]] == ["hero", "grew", "stage"]
    # детская версия с давлением не сохраняется
    bad = await create(env, "streak_frozen.kid", {"texts": {
        "ru": {"title": "{learner_name}", "body": "Серия спасена: {date}", "button": None},
        "uz": {"title": "{learner_name}", "body": "{date}", "button": None}}, "note": "Пробуем"})
    assert (bad.status_code, bad.json()["code"]) == (422, "TEMPLATE_INVALID")
    r = await create(env, "badge_earned", {"texts": {
        "ru": {"title": "Ура!", "body": "Значок «{badge}» — ваш.", "button": None},
        "uz": {"title": "Ura!", "body": "«{badge}» nishoni — sizniki.", "button": None}}, "note": "Короче"})
    assert r.status_code == 201, r.text
    assert (await activate(env, r.json()["version"], key="badge_earned")).status_code == 200
    user, day = env.add_user(), local_day(1)
    await badge(env, user, "skills_10", earned_at=at(day, "12:00"))
    await env.dispatch(at(day, "12:01"))
    [msg] = env.gateway.calls
    assert msg["text"] == "<b>Ура!</b>\nЗначок «10 подтверждённых навыков» — ваш."
    assert msg["buttons"] == [[{"text": "Открыть достижения", "startapp": "route_progress"}]]

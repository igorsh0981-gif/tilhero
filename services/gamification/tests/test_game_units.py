"""Юнит-тесты без БД: разбор заголовков картинок (webp VP8 / VP8L / VP8X, png), валидатор правил, diff, уровни и
ступени, тексты значков."""

from __future__ import annotations

import copy
import json
import struct
from pathlib import Path
from typing import Any

import pytest
from conftest import SERVICE_DIR

from tilhero_gamification.domain.common import plural_ru, render
from tilhero_gamification.domain.rules import (
    diff,
    level_of,
    stage_of,
    structural,
    validate,
    warnings,
    with_social_sections,
)
from tilhero_gamification.images import ImageInvalid, inspect_image

RULES_V1: dict[str, Any] = json.loads((Path(SERVICE_DIR) / "migrations" / "seed" / "game_seed.json").read_text())[
    "rules_v1"]
# спринт 7: league / duel / pair_lesson обязательны (миграция 0002 дополняет активную версию)
RULES: dict[str, Any] = with_social_sections(RULES_V1, None)


def riff(chunk: bytes, data: bytes) -> bytes:
    body = b"WEBP" + chunk + struct.pack("<I", len(data)) + data
    if len(body) % 2:
        body += b"\x00"
    return b"RIFF" + struct.pack("<I", len(body)) + body


def test_webp_variants_and_png() -> None:
    lossy = riff(b"VP8 ", b"\x00\x00\x00" + b"\x9d\x01\x2a" + struct.pack("<HH", 300, 200) + b"\x00" * 10)
    assert (inspect_image(lossy).width, inspect_image(lossy).height) == (300, 200)
    bits = (99 & 0x3FFF) | ((49 & 0x3FFF) << 14)
    lossless = riff(b"VP8L", b"\x2f" + struct.pack("<I", bits) + b"\x00" * 8)
    info = inspect_image(lossless, "image/webp")
    assert (info.mime, info.width, info.height) == ("image/webp", 100, 50)
    ext = riff(b"VP8X", b"\x10\x00\x00\x00" + (1023).to_bytes(3, "little") + (459).to_bytes(3, "little"))
    assert (inspect_image(ext).width, inspect_image(ext).height) == (1024, 460)
    big = riff(b"VP8X", b"\x10\x00\x00\x00" + (1024).to_bytes(3, "little") + (9).to_bytes(3, "little"))
    with pytest.raises(ImageInvalid, match="dimensions"):
        inspect_image(big)
    with pytest.raises(ImageInvalid, match="header"):
        inspect_image(lossy[:-4] + b"\x00\x00")  # RIFF-размер не совпадает с длиной
    with pytest.raises(ImageInvalid, match="header"):
        inspect_image(riff(b"VP8 ", b"\x00" * 16))  # нет стартового кода
    with pytest.raises(ImageInvalid, match="header"):
        inspect_image(riff(b"ALPH", b"\x00" * 16))
    with pytest.raises(ImageInvalid, match="signature"):
        inspect_image(lossy, "image/png")
    seed = Path(SERVICE_DIR) / "migrations" / "seed" / "heroes"
    assert all(inspect_image(p.read_bytes()).height == 460 for p in seed.glob("*.webp"))
    with pytest.raises(ImageInvalid, match="header"):
        inspect_image(b"\x89PNG\r\n\x1a\n" + b"\x00" * 30)


def test_rules_validator_semantics() -> None:
    assert validate(RULES) == []
    assert {(e["path"], e["code"]) for e in validate(RULES_V1)} == {
        ("league", "required"), ("duel", "required"), ("pair_lesson", "required")}

    def errors(mutate: Any) -> set[tuple[str, str]]:
        p = copy.deepcopy(RULES)
        mutate(p)
        return {(e["path"], e["code"]) for e in validate(p)}

    assert ("levels[0]", "first_not_zero") in errors(lambda p: p.__setitem__("levels", [5, 100]))
    assert ("levels", "length") in errors(lambda p: p.__setitem__("levels", [0]))
    assert ("hero.stage_thresholds", "length") in errors(lambda p: p["hero"].__setitem__("stage_thresholds", [0, 5]))
    assert ("hero.stage_thresholds", "not_increasing") in errors(
        lambda p: p["hero"].__setitem__("stage_thresholds", [0, 5, 5]))
    assert ("freeze.price_til", "range") in errors(lambda p: p["freeze"].__setitem__("price_til", 0))
    assert ("freeze.max_stock", "range") in errors(lambda p: p["freeze"].__setitem__("max_stock", 31))
    assert ("bonuses.referral_freeze", "range") in errors(lambda p: p["bonuses"].__setitem__("referral_freeze", 11))
    assert ("quests.per_day", "range") in errors(lambda p: p["quests"].__setitem__("per_day", 4))
    assert ("earn.lesson.xp", "range") in errors(lambda p: p["earn"]["lesson"].__setitem__("xp", -1))
    assert ("caps.til_per_day", "cap_below_reward") in errors(lambda p: p["caps"].__setitem__("til_per_day", 9))
    assert ("badges.streak", "not_increasing") in errors(lambda p: p["badges"].__setitem__("streak", [7, 7]))
    # спринт 7: лиги, дуэли, парные уроки
    assert ("league.prizes", "order") in errors(lambda p: p["league"].__setitem__("prizes", [20, 30, 50]))
    assert ("league.prizes[0]", "range") in errors(lambda p: p["league"].__setitem__("prizes", [10_001]))
    assert ("league.prizes", "length") in errors(lambda p: p["league"].__setitem__("prizes", []))
    assert ("league.group_size", "order") in errors(lambda p: p["league"].__setitem__("group_size", [30, 20]))
    assert ("league.group_size[1]", "range") in errors(lambda p: p["league"].__setitem__("group_size", [20, 51]))
    assert ("league.group_size", "length") in errors(lambda p: p["league"].__setitem__("group_size", [20]))
    assert ("league.anomaly.median_factor", "range") in errors(
        lambda p: p["league"]["anomaly"].__setitem__("median_factor", 0))
    assert ("duel", "order") in errors(lambda p: p["duel"].__setitem__("draw", 40))
    assert ("duel.daily_cap", "range") in errors(lambda p: p["duel"].__setitem__("daily_cap", 51))
    assert ("pair_lesson.xp", "range") in errors(lambda p: p["pair_lesson"].__setitem__("xp", 10_001))
    assert ("pair_lesson.min_turns", "range") in errors(lambda p: p["pair_lesson"].__setitem__("min_turns", 0))
    assert ("pair_lesson.daily_cap", "range") in errors(lambda p: p["pair_lesson"].__setitem__("daily_cap", 21))
    assert ("duel.bonus", "unknown_key") in errors(lambda p: p["duel"].__setitem__("bonus", 1))

    def dup(p: dict[str, Any]) -> None:
        p["quests"]["templates"][1]["code"] = p["quests"]["templates"][0]["code"]
        p["quests"]["templates"][2]["kind"] = "win_league"
        p["quests"]["templates"][3]["audiences"] = ["pets"]

    assert errors(dup) >= {("quests.templates[1].code", "duplicate"), ("quests.templates[2].kind", "enum"),
                           ("quests.templates[3].audiences", "enum")}
    # структура: тип bool вместо числа, лишний и отсутствующий ключ
    p = copy.deepcopy(RULES)
    p["caps"]["xp_per_day"] = True
    p["earn"]["boost"] = {"xp": 1}
    del p["badges"]
    found = structural(validate(p))
    assert {(e["path"], e["code"]) for e in found} == {("caps.xp_per_day", "type"), ("earn.boost", "unknown_key"),
                                                      ("badges", "required")}
    assert structural(validate([])) == [{"path": "$", "code": "type"}]


def test_warnings_diff_levels_stages() -> None:
    p = copy.deepcopy(RULES)
    p["earn"]["review"]["til"] = 7
    p["levels"] = [*p["levels"][:-1], 20000]
    assert warnings(p, RULES) == [{"path": "earn.review.til", "code": "reward_growth_x2"}]
    assert diff(RULES, p) == [{"path": "earn.review.til", "from": 3, "to": 7},
                              {"path": "levels", "from": RULES["levels"], "to": p["levels"]}]
    assert diff(None, p) == []
    levels = RULES["levels"]
    assert [level_of(x, levels) for x in (0, 99, 100, 249, 250, 10_450, 99_999)] == [1, 1, 2, 2, 3, 20, 20]
    assert [stage_of(x, [0, 5, 15]) for x in (0, 4, 5, 14, 15, 100)] == [1, 1, 2, 2, 3, 3]


def test_badge_texts_plural() -> None:
    forms = ["день", "дня", "дней"]
    assert [plural_ru(n, forms) for n in (1, 2, 5, 11, 21, 22, 100, 112)] == [
        "день", "дня", "дней", "дней", "день", "дня", "дней", "дней"]
    assert render({"ru": "Серия {n} {unit}", "uz": "{n} {unit}lik seriya"}, 21,
                  {"ru": forms, "uz": "kun"}) == {"ru": "Серия 21 день", "uz": "21 kunlik seriya"}

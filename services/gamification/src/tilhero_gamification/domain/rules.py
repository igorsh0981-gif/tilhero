"""Правила игры (§1.3): загрузка активной версии, валидатор, предупреждения, diff, уровни и ступени — кодом.

Валидатор возвращает ошибки `[{path, code}]`:
- структурные (`required`, `unknown_key`, `type`) — черновик с ними не сохраняется (422 RULES_INVALID);
- смысловые (`range`, `not_increasing`, `first_not_zero`, `length`, `cap_below_reward`, `pattern`, `duplicate`,
  `enum`, `empty`, `too_few_templates`) — показываются проверкой, активация с ними невозможна.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from itertools import pairwise
from typing import Any, Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_gamification.models import QUEST_KINDS, RulesVersion

STRUCTURAL: Final = frozenset({"required", "unknown_key", "type"})
AUDIENCES: Final = ("kids", "teens", "adults")
CODE_RE: Final = re.compile(r"^[a-z0-9_]{3,40}$")
MAX_INT: Final = 10_000_000

_AMOUNT: dict[str, Any] = {"xp": "int", "til": "int"}
_TEMPLATE: dict[str, Any] = {"code": "str", "kind": "str", "target": "int", "reward": _AMOUNT,
                             "audiences": ["str"], "weight": "int"}
SCHEMA: Final[dict[str, Any]] = {
    "earn": {
        "lesson": _AMOUNT, "lesson_passed_bonus": _AMOUNT, "lesson_practice": _AMOUNT, "scenario": _AMOUNT,
        "media": _AMOUNT, "reading": _AMOUNT,
        "review": {"min_cards": "int", "xp_base": "int", "xp_per_correct_cap": "int", "til": "int"},
        "skill_demonstrated": _AMOUNT, "skill_retained": _AMOUNT, "skill_max_per_event": "int",
    },
    "caps": {"xp_per_day": "int", "til_per_day": "int"},
    "levels": ["int"],
    "hero": {"stage_thresholds": ["int"]},
    "freeze": {"price_til": "int", "max_stock": "int"},
    "bonuses": {"registration_freeze": "int", "referral_freeze": "int", "referral_monthly_cap": "int"},
    "quests": {"per_day": "int", "all_done_bonus": _AMOUNT, "templates": [_TEMPLATE]},
    "badges": {"streak": ["int"], "skills": ["int"], "reviews_cards": ["int"], "readings": ["int"]},
}

Issue = dict[str, str]


@dataclass(frozen=True)
class Rules:
    version: int
    payload: dict[str, Any]

    @property
    def earn(self) -> dict[str, Any]:
        return dict(self.payload["earn"])

    @property
    def levels(self) -> list[int]:
        return [int(x) for x in self.payload["levels"]]

    @property
    def stage_thresholds(self) -> list[int]:
        return [int(x) for x in self.payload["hero"]["stage_thresholds"]]

    @property
    def freeze_price(self) -> int:
        return int(self.payload["freeze"]["price_til"])

    @property
    def freeze_max(self) -> int:
        return int(self.payload["freeze"]["max_stock"])

    @property
    def caps(self) -> dict[str, int]:
        return {"xp": int(self.payload["caps"]["xp_per_day"]), "til": int(self.payload["caps"]["til_per_day"])}

    @property
    def bonuses(self) -> dict[str, int]:
        return {k: int(v) for k, v in self.payload["bonuses"].items()}

    @property
    def quests(self) -> dict[str, Any]:
        return dict(self.payload["quests"])

    @property
    def badges(self) -> dict[str, list[int]]:
        return {k: [int(x) for x in v] for k, v in self.payload["badges"].items()}


async def active_rules(session: AsyncSession) -> Rules:
    row = (await session.execute(select(RulesVersion.version, RulesVersion.payload)
                                 .where(RulesVersion.status == "active"))).first()
    if row is None:  # невозможно после миграции 0001; защита от пустой схемы
        raise RuntimeError("no active game rules")
    return Rules(int(row.version), dict(row.payload))


async def rules_by_version(session: AsyncSession, version: int) -> Rules | None:
    payload = (await session.execute(select(RulesVersion.payload).where(RulesVersion.version == version))).scalar()
    return None if payload is None else Rules(version, dict(payload))


def level_of(xp: int, levels: list[int]) -> int:
    """Уровень = число порогов (по возрастанию, первый 0), не превышающих xp_total."""
    return max(1, sum(1 for t in levels if t <= xp))


def stage_of(confirmed: int, thresholds: list[int]) -> int:
    return min(3, max(1, sum(1 for t in thresholds if t <= confirmed)))


# ---------------------------------------------------------------- валидатор


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _walk(value: Any, spec: Any, path: str, out: list[Issue]) -> None:
    if isinstance(spec, dict):
        if not isinstance(value, dict):
            out.append({"path": path or "$", "code": "type"})
            return
        for key in spec:
            if key not in value:
                out.append({"path": f"{path}.{key}" if path else key, "code": "required"})
        for key in value:
            if key not in spec:
                out.append({"path": f"{path}.{key}" if path else str(key), "code": "unknown_key"})
        for key, sub in spec.items():
            if key in value:
                _walk(value[key], sub, f"{path}.{key}" if path else key, out)
        return
    if isinstance(spec, list):
        if not isinstance(value, list):
            out.append({"path": path, "code": "type"})
            return
        for i, item in enumerate(value):
            _walk(item, spec[0], f"{path}[{i}]", out)
        return
    if spec == "int":
        if not _is_int(value):
            out.append({"path": path, "code": "type"})
        elif value < 0 or value > MAX_INT:
            out.append({"path": path, "code": "range"})
    elif spec == "str" and not isinstance(value, str):
        out.append({"path": path, "code": "type"})


def _range(out: list[Issue], path: str, value: int, lo: int, hi: int) -> None:
    if not lo <= value <= hi:
        out.append({"path": path, "code": "range"})


def _increasing(out: list[Issue], path: str, values: list[int], *, first_zero: bool, length: tuple[int, int],
                lo: int = 0) -> None:
    if not length[0] <= len(values) <= length[1]:
        out.append({"path": path, "code": "length"})
    if first_zero and values and values[0] != 0:
        out.append({"path": f"{path}[0]", "code": "first_not_zero"})
    for i, v in enumerate(values):
        if v < lo:
            out.append({"path": f"{path}[{i}]", "code": "range"})
    if any(b <= a for a, b in pairwise(values)):
        out.append({"path": path, "code": "not_increasing"})


def max_single_reward(payload: dict[str, Any], currency: str) -> int:
    """Самая большая разовая награда валюты (операция одного действия или задания)."""
    earn = payload["earn"]
    review = earn["review"]
    candidates = [
        earn["lesson"][currency] + earn["lesson_passed_bonus"][currency], earn["lesson_practice"][currency],
        earn["scenario"][currency], earn["media"][currency], earn["reading"][currency],
        earn["skill_demonstrated"][currency], earn["skill_retained"][currency],
        (review["xp_base"] + review["xp_per_correct_cap"]) if currency == "xp" else review["til"],
        *[t["reward"][currency] for t in payload["quests"]["templates"]],
    ]
    return max(int(x) for x in candidates)


def validate(payload: Any) -> list[Issue]:
    """Ошибки правил: сначала структура (типы, ключи), затем смысл — только при целой структуре."""
    out: list[Issue] = []
    _walk(payload, SCHEMA, "", out)
    if out:
        return out
    earn = payload["earn"]
    for key in ("lesson", "lesson_passed_bonus", "lesson_practice", "scenario", "media", "reading",
                "skill_demonstrated", "skill_retained"):
        for cur in ("xp", "til"):
            _range(out, f"earn.{key}.{cur}", earn[key][cur], 0, 10_000)
    for key in ("xp_base", "xp_per_correct_cap", "til"):
        _range(out, f"earn.review.{key}", earn["review"][key], 0, 10_000)
    _range(out, "earn.review.min_cards", earn["review"]["min_cards"], 1, 500)
    _range(out, "earn.skill_max_per_event", earn["skill_max_per_event"], 1, 100)
    _increasing(out, "levels", payload["levels"], first_zero=True, length=(2, 100))
    _increasing(out, "hero.stage_thresholds", payload["hero"]["stage_thresholds"], first_zero=True, length=(3, 3))
    _range(out, "freeze.price_til", payload["freeze"]["price_til"], 1, 10_000)
    _range(out, "freeze.max_stock", payload["freeze"]["max_stock"], 1, 30)
    bonuses = payload["bonuses"]
    _range(out, "bonuses.registration_freeze", bonuses["registration_freeze"], 0, 10)
    _range(out, "bonuses.referral_freeze", bonuses["referral_freeze"], 0, 10)
    _range(out, "bonuses.referral_monthly_cap", bonuses["referral_monthly_cap"], 0, 100)
    quests = payload["quests"]
    _range(out, "quests.per_day", quests["per_day"], 1, 3)
    for cur in ("xp", "til"):
        _range(out, f"quests.all_done_bonus.{cur}", quests["all_done_bonus"][cur], 0, 10_000)
    templates = quests["templates"]
    if not 1 <= len(templates) <= 50:
        out.append({"path": "quests.templates", "code": "length"})
    seen: set[str] = set()
    for i, t in enumerate(templates):
        p = f"quests.templates[{i}]"
        if not CODE_RE.match(t["code"]):
            out.append({"path": f"{p}.code", "code": "pattern"})
        if t["code"] in seen:
            out.append({"path": f"{p}.code", "code": "duplicate"})
        seen.add(t["code"])
        if t["kind"] not in QUEST_KINDS:
            out.append({"path": f"{p}.kind", "code": "enum"})
        _range(out, f"{p}.target", t["target"], 1, 100_000)
        _range(out, f"{p}.weight", t["weight"], 1, 10)
        for cur in ("xp", "til"):
            _range(out, f"{p}.reward.{cur}", t["reward"][cur], 0, 10_000)
        if not t["audiences"]:
            out.append({"path": f"{p}.audiences", "code": "empty"})
        if any(a not in AUDIENCES for a in t["audiences"]) or len(set(t["audiences"])) != len(t["audiences"]):
            out.append({"path": f"{p}.audiences", "code": "enum"})
    for aud in AUDIENCES:
        if sum(1 for t in templates if aud in t["audiences"]) < quests["per_day"]:
            out.append({"path": f"quests.templates.{aud}", "code": "too_few_templates"})
    for family in ("streak", "skills", "reviews_cards", "readings"):
        _increasing(out, f"badges.{family}", payload["badges"][family], first_zero=False, length=(0, 10), lo=1)
    if not out:
        for cur, key in (("xp", "xp_per_day"), ("til", "til_per_day")):
            if payload["caps"][key] < max_single_reward(payload, cur):
                out.append({"path": f"caps.{key}", "code": "cap_below_reward"})
    return out


def structural(errors: list[Issue]) -> list[Issue]:
    return [e for e in errors if e["code"] in STRUCTURAL]


def _reward_leaves(payload: dict[str, Any]) -> dict[str, int]:
    out: dict[str, int] = {}
    for key, value in payload["earn"].items():
        if isinstance(value, dict):
            for sub in ("xp", "til", "xp_base", "xp_per_correct_cap"):
                if sub in value:
                    out[f"earn.{key}.{sub}"] = int(value[sub])
    for cur in ("xp", "til"):
        out[f"quests.all_done_bonus.{cur}"] = int(payload["quests"]["all_done_bonus"][cur])
    return out


def warnings(payload: dict[str, Any], active: dict[str, Any] | None) -> list[Issue]:
    """Не блокируют: рост награды больше чем ×2 к активной версии; порог ступени 2 выше 10."""
    out: list[Issue] = []
    if active is not None:
        before = _reward_leaves(active)
        for path, value in _reward_leaves(payload).items():
            old = before.get(path)
            if old is not None and old > 0 and value > 2 * old:
                out.append({"path": path, "code": "reward_growth_x2"})
    if payload["hero"]["stage_thresholds"][1] > 10:
        out.append({"path": "hero.stage_thresholds[1]", "code": "stage2_above_10"})
    return out


def _flatten(value: Any, path: str, out: dict[str, Any]) -> None:
    if isinstance(value, dict) and value:
        for key, sub in value.items():
            _flatten(sub, f"{path}.{key}" if path else str(key), out)
    else:
        out[path] = value


def diff(active: dict[str, Any] | None, payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Отличия версии от активной: [{path, from (активная), to (эта версия)}]; списки сравниваются целиком."""
    if active is None:
        return []
    a: dict[str, Any] = {}
    b: dict[str, Any] = {}
    _flatten(active, "", a)
    _flatten(payload, "", b)
    return [{"path": p, "from": a.get(p), "to": b.get(p)} for p in sorted(set(a) | set(b)) if a.get(p) != b.get(p)]

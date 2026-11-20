"""Unit-тесты белого списка токенов и схемы payload (без БД): контракт с Mini App и прототипом TilHero."""

from __future__ import annotations

import copy
import importlib.util
import json
import re
from pathlib import Path

import pytest

from tilhero_experience.domain.payload import SECTION_TYPES, ConfigInvalid, checksum, validate_payload
from tilhero_experience.domain.tokens import (
    ADMIN_TOKENS,
    BRAND_FONTS,
    MINIAPP_TOKENS,
    TokenError,
    TokenSpec,
    validate_token,
)

_SEED_FILE = Path(__file__).resolve().parents[1] / "migrations" / "versions" / "0002_seed.py"
_spec = importlib.util.spec_from_file_location("expcfg_seed", _SEED_FILE)
assert _spec and _spec.loader
seed = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(seed)

ROOT = Path(__file__).resolve().parents[3]
# allowlist санитайзера Mini App (packages/ui-tokens) — сервер должен принимать ровно эти токены
CLIENT_ALLOWLIST = ROOT / "packages" / "ui-tokens" / "token-names.json"
BFF_TS = ROOT / "packages" / "contracts" / "src" / "bff.ts"
# согласованный прототип (Claude Design canvas) — источник значений темы «Тетрадь»
PROTOTYPE = Path("/home/claude/lf/project/Main.dc.html")
ADMIN_PROTOTYPE = Path("/home/claude/lf/project/Admin.dc.html")

# Тёмная «Тетрадь» (прототип `.app.dark`) — для тестов активации и отката версии 1.0.1
DARK_TOKENS = {
    "--paper": "#11152B", "--grid": "#181D3A", "--ink": "#EEF1FA", "--ink2": "#B1B8D3", "--line": "#2A3157",
    "--card": "#191E3B", "--pen": "#8A9DFF", "--pen-ink": "#0E1330", "--pen-soft": "#252D5E", "--mark": "#6E5F0E",
    "--margin": "#6E3B4E", "--err": "#FF8F8F", "--err-soft": "#3B1F2A", "--ok": "#63D6A0", "--ok-soft": "#163427",
    "--warn": "#FFC466", "--warn-soft": "#3A2D12", "--scrim": "rgba(0,0,0,.62)",
}


def miniapp_payload() -> dict:
    return copy.deepcopy(seed.SEED[0][2])


def admin_payload() -> dict:
    return copy.deepcopy(seed.SEED[1][2])


def _css_vars(html: str, selector: str) -> dict[str, str]:
    m = re.search(rf"\n{re.escape(selector)}\{{([^}}]*)\}}", html)
    assert m, selector
    return dict(re.findall(r"(--[a-z0-9-]+):([^;]+)", m.group(1)))


def test_seed_payloads_are_valid_and_normalized() -> None:
    assert [(app, version) for app, version, *_ in seed.SEED] == [("miniapp", "1.0.0"), ("admin", "1.0.0")]
    for app, _version, payload, *_ in seed.SEED:
        assert validate_payload(app, payload) == payload
        assert checksum(payload) == seed._checksum(payload)


def test_miniapp_whitelist_matches_client_allowlist() -> None:
    """Контракт с Mini App: те же имена и типы токенов и те же шрифты, что применяет санитайзер клиента."""
    client = json.loads(CLIENT_ALLOWLIST.read_text())
    assert {n: s.kind for n, s in MINIAPP_TOKENS.items()} == client["tokens"]
    assert set(client["fonts"]) == BRAND_FONTS == {"Onest", "Unbounded", "Caveat"}
    # сид задаёт каждый токен allowlist, значения проходят грамматику клиента (color = #hex / rgb[a](); length = px/rem;
    # font = одно семейство из fonts)
    tokens = miniapp_payload()["theme"]["tokens"]
    assert set(tokens) == set(client["tokens"])
    grammar = {"color": re.compile(r"^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,\s%]{1,60}\))$"),
               "length": re.compile(r"^(0|\d{1,4}(\.\d{1,3})?(px|rem))$")}
    for name, value in tokens.items():
        kind = client["tokens"][name]
        ok = value in client["fonts"] if kind == "font" else grammar[kind].match(value)
        assert ok, (name, value)


def test_miniapp_payload_matches_bff_contract() -> None:
    """ExperienceConfig (bff.ts): темы notebook | notebook_dark, типы секций HomeSectionType."""
    ts = BFF_TS.read_text()
    section_union = re.search(r"export type HomeSectionType =([^;]+);", ts)
    assert section_union
    assert tuple(re.findall(r'"([a-z_]+)"', section_union.group(1))) == SECTION_TYPES
    assert '"notebook" | "notebook_dark"' in ts
    p = miniapp_payload()
    assert p["theme"]["id"] == "notebook" and set(p) == {"theme", "home", "flags"}
    assert [s["type"] for s in p["home"]["sections"]] == list(SECTION_TYPES)


@pytest.mark.skipif(not PROTOTYPE.exists(), reason="прототип TilHero недоступен")
def test_theme_values_come_from_prototype() -> None:
    html = PROTOTYPE.read_text()
    light, dark = _css_vars(html, ".app"), _css_vars(html, ".app.dark")
    tokens = miniapp_payload()["theme"]["tokens"]
    colors = {n: v for n, v in tokens.items() if MINIAPP_TOKENS[n].kind == "color"}
    assert colors == light
    assert set(DARK_TOKENS) == set(dark)
    for name, value in dark.items():  # тёмная тема прототипа проходит проверку сервера
        validate_token(name, value, MINIAPP_TOKENS)
        assert DARK_TOKENS[name].replace(" ", "") == value.replace(" ", "")
    assert re.search(r"\n\.card\{[^}]*border-radius:14px", html) and tokens["--r-card"] == "14px"
    assert re.search(r"\n\.btn\{[^}]*border-radius:12px", html) and tokens["--r-btn"] == "12px"
    assert re.search(r"\n\.inp\{[^}]*border-radius:12px", html) and tokens["--r-field"] == "12px"
    assert re.search(r"\n\.sheet\{[^}]*border-radius:22px", html) and tokens["--r-sheet"] == "22px"
    assert re.search(r"\n\.pad\{padding:0 18px\}", html) and tokens["--gutter"] == "18px"
    assert (tokens["--font-body"], tokens["--font-display"], tokens["--font-hand"]) == ("Onest", "Unbounded", "Caveat")


@pytest.mark.skipif(not ADMIN_PROTOTYPE.exists(), reason="прототип админки недоступен")
def test_admin_theme_values_come_from_prototype() -> None:
    proto = _css_vars(ADMIN_PROTOTYPE.read_text(), ".ad")
    tokens = admin_payload()["theme"]["tokens"]
    assert {n: v for n, v in tokens.items() if ADMIN_TOKENS[n].kind == "color"} == proto


@pytest.mark.parametrize("value", [
    "#2F4BE0", "#fff", "#2F4BE0CC", "#0000", "rgb(1, 2, 3)", "rgba(18,22,44,.45)", "rgba(0,0,0,0.5)",
    "rgba(0,0,0,1)", "rgba(10, 20, 30, 50%)",
])
def test_colors_ok(value: str) -> None:
    validate_token("--pen", value, MINIAPP_TOKENS)


@pytest.mark.parametrize(("value", "reason"), [
    ("url(https://evil.example/x.png)", "forbidden_construct"),
    ("URL( 'x' )", "forbidden_construct"),
    ("expression(alert(1))", "forbidden_construct"),
    ("javascript:alert(1)", "forbidden_construct"),
    ("JavaScript :alert(1)", "forbidden_construct"),
    ("java\tscript:alert(1)", "forbidden_construct"),
    ("var(--paper)", "forbidden_construct"),
    ("#fff;background:url(x)", "forbidden_construct"),
    ("#fff}body{display:none", "forbidden_construct"),
    ("</style><script>alert(1)</script>", "forbidden_construct"),
    ("#fff /* */", "forbidden_construct"),
    ("@import 'x.css'", "forbidden_construct"),
    ("#fff\\9", "forbidden_construct"),
    ("#fff\nx", "forbidden_construct"),
    ("red", "invalid_color"),
    ("#12345", "invalid_color"),
    ("rgb(256,0,0)", "invalid_color"),
    ("rgba(0,0,0,1.5)", "invalid_color"),
    ("rgba(0,0,0)", "invalid_color"),
    ("hsl(1,2%,3%)", "invalid_color"),
    ("#" + "f" * 300, "too_long"),
])
def test_colors_rejected(value: str, reason: str) -> None:
    with pytest.raises(TokenError) as e:
        validate_token("--pen", value, MINIAPP_TOKENS)
    assert e.value.reason == reason


def test_lengths_and_ranges() -> None:
    for ok in ("14px", "0", "1.5rem", "0px", "32px", "2rem"):
        validate_token("--r-card", ok, MINIAPP_TOKENS)
    for bad, reason in (("33px", "out_of_range"), ("2.1rem", "out_of_range"), ("-2px", "invalid_length"),
                        ("10%", "invalid_length"), ("10em", "invalid_length"), ("10", "invalid_length"),
                        ("calc(1px + 2px)", "invalid_length")):
        with pytest.raises(TokenError) as e:
            validate_token("--r-card", bad, MINIAPP_TOKENS)
        assert e.value.reason == reason, bad
    validate_token("--r-btn", "24px", MINIAPP_TOKENS)
    with pytest.raises(TokenError):
        validate_token("--r-btn", "25px", MINIAPP_TOKENS)
    # поле экрана — только px, 8…32
    for ok in ("8px", "18px", "32px"):
        validate_token("--gutter", ok, MINIAPP_TOKENS)
    for bad in ("4px", "40px", "1rem", "0"):
        with pytest.raises(TokenError):
            validate_token("--gutter", bad, MINIAPP_TOKENS)
    validate_token("--nav-w", "236px", ADMIN_TOKENS)
    with pytest.raises(TokenError):
        validate_token("--nav-w", "2000px", ADMIN_TOKENS)


def test_numbers() -> None:
    spec = {"--scale": TokenSpec("number", 0.5, 3)}
    validate_token("--scale", "1.25", spec)
    for bad, reason in (("4", "out_of_range"), ("1e3", "invalid_number"), ("1,5", "invalid_number")):
        with pytest.raises(TokenError) as e:
            validate_token("--scale", bad, spec)
        assert e.value.reason == reason


def test_fonts() -> None:
    # Mini App: одно семейство бренда (фолбэки добавляет клиент)
    for name in ("--font-body", "--font-display", "--font-hand"):
        for ok in ("Onest", '"Unbounded"', "'Caveat'"):
            validate_token(name, ok, MINIAPP_TOKENS)
    for bad in ('"Onest",sans-serif', "system-ui", '"Comic Sans MS"', "Manrope", "Papyrus", "", '"Onest'):
        with pytest.raises(TokenError) as e:
            validate_token("--font-display", bad, MINIAPP_TOKENS)
        assert e.value.reason == "invalid_font", bad
    # Admin: стек из бренда и системных фолбэков
    validate_token("--font-ui", "Onest,system-ui,sans-serif", ADMIN_TOKENS)
    validate_token("--font-mono", "ui-monospace,SFMono-Regular,Menlo,monospace", ADMIN_TOKENS)
    for bad in ('"Comic Sans MS",sans-serif', '"Onest" , url(x)', "Segoe UI", '"Onest', "", '"Onest";x',
                ",".join(["sans-serif"] * 9)):
        with pytest.raises(TokenError):
            validate_token("--font-ui", bad, ADMIN_TOKENS)


def test_unknown_token_and_kind_mismatch() -> None:
    with pytest.raises(TokenError) as e:
        validate_token("--page", "#000000", MINIAPP_TOKENS)
    assert e.value.reason == "unknown_token"
    with pytest.raises(TokenError) as e:
        validate_token("--pen", "14px", MINIAPP_TOKENS)  # тип токена важен
    assert e.value.reason == "invalid_color"
    with pytest.raises(TokenError):
        validate_token("--side", "#000000", MINIAPP_TOKENS)  # токен админки не годится для Mini App
    # токены темы «Бот турист» (navy + lime) больше не применяются клиентом
    for legacy in ("--bg", "--accent", "--surface", "--rail-w", "--ec-media-h", "--match-bg", "--chrome"):
        with pytest.raises(TokenError) as e:
            validate_token(legacy, "#000000", MINIAPP_TOKENS)
        assert e.value.reason == "unknown_token", legacy
    with pytest.raises(TokenError) as e:
        validate_token("--pen", 12, MINIAPP_TOKENS)
    assert e.value.reason == "invalid_type"


def _errors(app: str, payload: dict) -> list[tuple[str, str]]:
    with pytest.raises(ConfigInvalid) as e:
        validate_payload(app, payload)
    return [(x["path"], x["reason"]) for x in e.value.errors]


def test_payload_collects_all_token_errors() -> None:
    p = miniapp_payload()
    p["theme"]["tokens"]["--pen"] = "url(x)"
    p["theme"]["tokens"]["--onclick"] = "#fff"
    assert _errors("miniapp", p) == [("payload.theme.tokens.--pen", "forbidden_construct"),
                                     ("payload.theme.tokens.--onclick", "unknown_token")]


def test_payload_miniapp_rules() -> None:
    p = miniapp_payload()
    p["home"]["sections"][1]["type"] = "today_plan"
    assert _errors("miniapp", p) == [("payload.home.sections[1].type", "duplicate")]
    p = miniapp_payload()
    p["home"]["sections"][2]["key"] = "today_plan"
    assert _errors("miniapp", p) == [("payload.home.sections[2].key", "duplicate")]
    p = miniapp_payload()
    p["home"]["sections"].append(dict(p["home"]["sections"][0], key="extra"))
    assert ("payload.home.sections", "too_many") in _errors("miniapp", p)
    for legacy in ("event_carousel", "watch_changes", "news_carousel", "ai_summary", "catalog_link"):
        p = miniapp_payload()
        p["home"]["sections"][0]["type"] = legacy
        assert _errors("miniapp", p) == [("payload.home.sections[0].type", "not_allowed")], legacy
    for field, value in (("welcome_mode", "first_visit_only"),):
        p = miniapp_payload()
        p["home"][field] = value
        assert _errors("miniapp", p) == [(f"payload.home.{field}", "unknown_field")]
    p = miniapp_payload()
    p["hotel_rating_min"] = 8.5
    assert _errors("miniapp", p) == [("payload.hotel_rating_min", "unknown_field")]
    for theme_id in ("default", "bank", "admin_light"):
        p = miniapp_payload()
        p["theme"]["id"] = theme_id
        assert _errors("miniapp", p) == [("payload.theme.id", "not_allowed")]
    p = miniapp_payload()
    p["theme"]["id"] = "notebook_dark"
    p["theme"]["tokens"] = dict(p["theme"]["tokens"], **DARK_TOKENS)
    assert validate_payload("miniapp", p)["theme"]["id"] == "notebook_dark"


def test_payload_admin_rules() -> None:
    p = admin_payload()
    p["layout"]["menu"].append({"id": "audit", "enabled": False})
    assert ("payload.layout.menu[15].id", "duplicate") in _errors("admin", p)  # 15 из 16 разрешённых — дубль, не лимит
    p = admin_payload()
    p["layout"]["menu"].append({"id": "memory", "enabled": True})  # спринт 5: раздел «Память» разрешён
    assert validate_payload("admin", p)["layout"]["menu"][-1]["id"] == "memory"
    p["layout"]["menu"].append({"id": "audit", "enabled": False})
    assert ("payload.layout.menu", "too_many") in _errors("admin", p)
    p = admin_payload()
    p["layout"]["menu"][1] = {"id": "overview", "enabled": True}
    assert _errors("admin", p) == [("payload.layout.menu[1].id", "duplicate")]
    p = admin_payload()
    p["layout"]["menu"][0]["id"] = "iframe_widget"
    assert _errors("admin", p) == [("payload.layout.menu[0].id", "not_allowed")]
    p = admin_payload()
    p["theme"]["tokens"]["--paper"] = "#FFFFFF"  # токен Mini App в админке
    assert _errors("admin", p) == [("payload.theme.tokens.--paper", "unknown_token")]
    p = admin_payload()
    p["home"] = {}
    assert _errors("admin", p) == [("payload.home", "unknown_field")]


def test_payload_size_and_type() -> None:
    assert _errors("miniapp", []) == [("payload", "invalid_type")]  # type: ignore[arg-type]
    p = miniapp_payload()
    p["flags"] = {f"flag_{i}_{'x' * 50}": True for i in range(600)}
    assert _errors("miniapp", p) == [("payload", "too_large")]

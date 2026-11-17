"""Unit-тесты белого списка токенов и схемы payload (без БД)."""

from __future__ import annotations

import copy
import importlib.util
import json
import re
from pathlib import Path

import pytest

from tilhero_experience.domain.payload import ConfigInvalid, checksum, validate_payload
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

# allowlist санитайзера Mini App (packages/ui-tokens) — сервер должен принимать ровно эти токены
CLIENT_ALLOWLIST = Path(__file__).resolve().parents[3] / "packages" / "ui-tokens" / "token-names.json"


def miniapp_payload() -> dict:
    return copy.deepcopy(seed.SEED[1][2])


def admin_payload() -> dict:
    return copy.deepcopy(seed.SEED[2][2])


def test_seed_payloads_are_valid_and_normalized() -> None:
    for app, _version, payload, *_ in seed.SEED:
        assert validate_payload(app, payload) == payload
        assert checksum(payload) == seed._checksum(payload)


@pytest.mark.skipif(not CLIENT_ALLOWLIST.exists(), reason="packages/ui-tokens/token-names.json недоступен")
def test_miniapp_whitelist_matches_client_allowlist() -> None:
    """Контракт с Mini App: те же имена и типы токенов, что применяет санитайзер клиента."""
    client = json.loads(CLIENT_ALLOWLIST.read_text())
    assert {n: s.kind for n, s in MINIAPP_TOKENS.items()} == client["tokens"]
    assert set(client["fonts"]) == BRAND_FONTS
    # значения сида проходят и проверку клиента (регулярки apps/telegram-miniapp/src/config/experience.ts)
    client_color = re.compile(r"^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/+-]{1,60}\))$", re.I)
    client_length = re.compile(r"^(0|-?\d{1,4}(\.\d{1,3})?(px|rem|em|%))$")
    client_number = re.compile(r"^\d{1,2}(\.\d{1,3})?$|^\.\d{1,3}$")
    for _, _, payload, *_ in seed.SEED[:2]:
        for name, value in payload["theme"]["tokens"].items():
            kind = client["tokens"][name]
            ok = {"color": client_color.match(value), "length": client_length.match(value),
                  "number": client_number.match(value), "font": value.strip("\"'") in client["fonts"]}[kind]
            assert ok, (name, value)


@pytest.mark.parametrize("value", [
    "#DFFF56", "#dff", "#DFFF56CC", "#0000", "rgb(1, 2, 3)", "rgba(223,255,86,.11)", "rgba(0,0,0,0.5)",
    "rgba(0,0,0,1)", "rgba(10, 20, 30, 50%)",
])
def test_colors_ok(value: str) -> None:
    validate_token("--accent", value, MINIAPP_TOKENS)


@pytest.mark.parametrize(("value", "reason"), [
    ("url(https://evil.example/x.png)", "forbidden_construct"),
    ("URL( 'x' )", "forbidden_construct"),
    ("expression(alert(1))", "forbidden_construct"),
    ("javascript:alert(1)", "forbidden_construct"),
    ("JavaScript :alert(1)", "forbidden_construct"),
    ("java\tscript:alert(1)", "forbidden_construct"),
    ("var(--bg)", "forbidden_construct"),
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
        validate_token("--accent", value, MINIAPP_TOKENS)
    assert e.value.reason == reason


def test_lengths_and_ranges() -> None:
    for ok in ("22px", "0", "1.5rem", "0px"):
        validate_token("--r-card", ok, MINIAPP_TOKENS)
    for bad, reason in (("65px", "out_of_range"), ("-2px", "invalid_length"), ("10%", "invalid_length"),
                        ("10em", "invalid_length"), ("10", "invalid_length"),
                        ("calc(1px + 2px)", "invalid_length")):
        with pytest.raises(TokenError) as e:
            validate_token("--r-card", bad, MINIAPP_TOKENS)
        assert e.value.reason == reason, bad
    # ширины рельсов — доля ширины в границах ТЗ UI/CSS §7
    for name, ok in (("--rail-w", "0.86"), ("--rail-w", ".9"), ("--rail-w-compact", "0.72")):
        validate_token(name, ok, MINIAPP_TOKENS)
    for bad, reason in (("0.91", "out_of_range"), ("0.84", "out_of_range"), ("86%", "invalid_number"),
                        ("1", "out_of_range")):
        with pytest.raises(TokenError) as e:
            validate_token("--rail-w", bad, MINIAPP_TOKENS)
        assert e.value.reason == reason, bad
    for bad in ("0.6", "0.8"):
        with pytest.raises(TokenError):
            validate_token("--rail-w-compact", bad, MINIAPP_TOKENS)
    validate_token("--ec-media-h", "188px", MINIAPP_TOKENS)
    for name, bad in (("--ec-media-h", "1000px"), ("--ec-media-h", "12rem"), ("--gutter", "4px"),
                      ("--sp-4", "100px")):
        with pytest.raises(TokenError):
            validate_token(name, bad, MINIAPP_TOKENS)
    validate_token("--nav-w", "248px", ADMIN_TOKENS)
    with pytest.raises(TokenError):
        validate_token("--nav-w", "2000px", ADMIN_TOKENS)


def test_numbers() -> None:
    spec = {"--card-ratio": TokenSpec("number", 0.5, 3)}
    validate_token("--card-ratio", "1.25", spec)
    for bad, reason in (("4", "out_of_range"), ("1e3", "invalid_number"), ("1,5", "invalid_number")):
        with pytest.raises(TokenError) as e:
            validate_token("--card-ratio", bad, spec)
        assert e.value.reason == reason


def test_fonts() -> None:
    # Mini App: одно семейство бренда (фолбэки добавляет клиент)
    for ok in ("Manrope", '"JetBrains Mono"', "'Unbounded'"):
        validate_token("--font-body", ok, MINIAPP_TOKENS)
    for bad in ('"Manrope",sans-serif', "system-ui", '"Comic Sans MS"', "Papyrus", "", '"Manrope'):
        with pytest.raises(TokenError) as e:
            validate_token("--font-display", bad, MINIAPP_TOKENS)
        assert e.value.reason == "invalid_font", bad
    # Admin: стек из бренда и системных фолбэков
    stack = '"Manrope",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif'
    validate_token("--font-ui", stack, ADMIN_TOKENS)
    validate_token("--font-mono", "'JetBrains Mono', monospace", ADMIN_TOKENS)
    for bad in ('"Comic Sans MS",sans-serif', '"Manrope" , url(x)', "Segoe UI", '"Manrope', "", '"Manrope";x',
                ",".join(["sans-serif"] * 9)):
        with pytest.raises(TokenError):
            validate_token("--font-ui", bad, ADMIN_TOKENS)


def test_shadows() -> None:
    validate_token("--shadow-pop", "0 18px 40px -20px rgba(0,0,0,.8)", ADMIN_TOKENS)
    validate_token("--shadow-drawer", "none", ADMIN_TOKENS)
    validate_token("--shadow-pop", "0 14px 36px -10px rgba(14,19,36,.28),0 2px 6px rgba(14,19,36,.08)",
                   ADMIN_TOKENS)
    validate_token("--shadow-drawer", "inset -24px 0 48px -12px #0B1020", ADMIN_TOKENS)
    four = "0 0 4px #000, 0 0 4px #000, 0 0 4px #000, 0 0 1px #000"
    for bad in ("0 0 -4px #000", "0 0 4px", "0 0 4px red", four,
                "0 0 4em #000", "0 0 999px #000", "0 0 4px url(x)"):
        with pytest.raises(TokenError):
            validate_token("--shadow-pop", bad, ADMIN_TOKENS)


def test_unknown_token_and_kind_mismatch() -> None:
    with pytest.raises(TokenError) as e:
        validate_token("--page", "#000000", MINIAPP_TOKENS)  # токен страницы прототипа, не приложения
    assert e.value.reason == "unknown_token"
    with pytest.raises(TokenError) as e:
        validate_token("--accent", "22px", MINIAPP_TOKENS)  # тип токена важен
    assert e.value.reason == "invalid_color"
    with pytest.raises(TokenError):
        validate_token("--nav", "#000000", MINIAPP_TOKENS)  # токен Admin не годится для Mini App
    for proto_only in ("--glass", "--pass", "--board", "--sh-2", "--f-b"):  # клиент их не применяет
        with pytest.raises(TokenError):
            validate_token(proto_only, "#000000", MINIAPP_TOKENS)


def _errors(app: str, payload: dict) -> list[tuple[str, str]]:
    with pytest.raises(ConfigInvalid) as e:
        validate_payload(app, payload)
    return [(x["path"], x["reason"]) for x in e.value.errors]


def test_payload_collects_all_token_errors() -> None:
    p = miniapp_payload()
    p["theme"]["tokens"]["--accent"] = "url(x)"
    p["theme"]["tokens"]["--onclick"] = "#fff"
    assert _errors("miniapp", p) == [("payload.theme.tokens.--accent", "forbidden_construct"),
                                     ("payload.theme.tokens.--onclick", "unknown_token")]


def test_payload_admin_rules() -> None:
    p = admin_payload()
    p["layout"]["dashboard_widgets"].append({"id": "dau", "enabled": False})
    assert ("payload.layout.dashboard_widgets", "too_many") in _errors("admin", p)
    p = admin_payload()
    p["layout"]["dashboard_widgets"][1] = {"id": "kpi_users", "enabled": True}
    assert _errors("admin", p) == [("payload.layout.dashboard_widgets[1].id", "duplicate")]
    p = admin_payload()
    p["layout"]["dashboard_widgets"][0]["id"] = "iframe_widget"
    assert _errors("admin", p) == [("payload.layout.dashboard_widgets[0].id", "not_allowed")]
    p = admin_payload()
    p["theme"]["tokens"]["--r-card"] = "22px"  # токен Mini App в Admin
    assert _errors("admin", p) == [("payload.theme.tokens.--r-card", "unknown_token")]
    p = admin_payload()
    p["home"] = {}
    assert _errors("admin", p) == [("payload.home", "unknown_field")]


def test_payload_size_and_type() -> None:
    assert _errors("miniapp", []) == [("payload", "invalid_type")]  # type: ignore[arg-type]
    p = miniapp_payload()
    p["flags"] = {f"flag_{i}_{'x' * 50}": True for i in range(600)}
    assert _errors("miniapp", p) == [("payload", "too_large")]

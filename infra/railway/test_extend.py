"""extend.py: дозаполнение prod новыми сервисами сохраняет действующие секреты и ключи (DEPLOYMENT.md §5)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import extend  # noqa: E402
import setup as rs  # noqa: E402

NEW = ("lessons", "assessment", "ai-gateway")


def _prod(tmp: Path) -> tuple[Path, Path, rs.Secrets, dict[str, str]]:
    sec = rs.Secrets.new()
    env = tmp / "learning-plan.env"
    env.write_text(f"SCHEDULER_TOKEN={sec.scheduler}\nINTERNAL_JWT_SECRET={sec.internal_hmac}\nOTHER=1\n")
    pub = {n: rs.b64e(rs.public_raw(rs.private_from_seed(sec.seeds[n]))) for n in rs.JWT_ISSUERS if n not in NEW}
    keys = tmp / "public-keys.json"
    keys.write_text(json.dumps(pub))
    return env, keys, sec, pub


def test_extend_keeps_existing_secrets_and_adds_new_services(tmp_path: Path) -> None:
    env, keys, sec, pub = _prod(tmp_path)
    out = tmp_path / "s4"
    assert extend.main(["--env-from", str(env), "--public-keys", str(keys), "--out", str(out),
                        "--only", ",".join(NEW)]) == 0
    new_pub = json.loads((out / "public-keys.json").read_text())
    assert {k: new_pub[k] for k in pub} == pub and set(new_pub) == set(rs.JWT_ISSUERS)
    for name in NEW:
        e = extend.env_of(out / f"{name}.env")
        assert e["INTERNAL_JWT_SECRET"] == sec.internal_hmac
        assert json.loads(e["INTERNAL_JWT_PUBLIC_KEYS"]) == new_pub
        if name in rs.SCHEDULED:
            assert e["SCHEDULER_TOKEN"] == sec.scheduler
    ai = extend.env_of(out / "ai-gateway.env")
    assert ai["ANTHROPIC_API_KEY"] == "${{shared.ANTHROPIC_API_KEY}}" and ai["AI_PROVIDER"] == "anthropic"
    assert len(extend.env_of(out / "lessons.env")["USER_REF_SECRET"]) >= 32
    pw = (out / "db-passwords.sql").read_text()
    assert all(f"ALTER ROLE {r} PASSWORD" in pw for r in ("lessons", "lessons_owner", "assessment",
                                                            "assessment_owner", "ai_gateway", "ai_gateway_owner"))
    assert "learning_plan" not in pw
    upd = json.loads((out / "updates.json").read_text())
    assert upd["n8n"]["LESSONS_URL"].endswith(":8112") and upd["n8n"]["ASSESSMENT_URL"].endswith(":8113")
    assert {"LESSONS_URL", "ASSESSMENT_URL"} <= set(upd["telegram-bff"])
    assert json.loads(upd["learning-plan"]["INTERNAL_JWT_PUBLIC_KEYS"]) == new_pub
    assert all(oct(p.stat().st_mode & 0o777) == "0o600" for p in out.iterdir())
    # повторный запуск в заполненный каталог — отказ (сменил бы пароли и ключи)
    assert extend.main(["--env-from", str(env), "--public-keys", str(keys), "--out", str(out),
                        "--only", ",".join(NEW)]) == 2


def test_extend_refuses_already_deployed_service(tmp_path: Path) -> None:
    env, keys, _, pub = _prod(tmp_path)
    keys.write_text(json.dumps({**pub, "lessons": "x"}))
    assert extend.main(["--env-from", str(env), "--public-keys", str(keys), "--out", str(tmp_path / "o"),
                        "--only", "lessons"]) == 2
    with pytest.raises(Exception):  # noqa: B017 — неизвестный сервис
        extend.main(["--env-from", str(env), "--public-keys", str(keys), "--out", str(tmp_path / "p"),
                     "--only", "nope"])

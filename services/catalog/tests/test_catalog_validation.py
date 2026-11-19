"""Бизнес-правила проверки контента (INTERNAL_API §1.2, AT-27/28/29) — чистые функции, без БД."""

from __future__ import annotations

import copy
from datetime import date
from typing import Any

import pytest
from catalog_kit import SEED_DIR, L, exercise, lesson, media, rubric, scenario, seed, skill

from tilhero_catalog.content import KEY_FIELDS
from tilhero_catalog.domain.media_ops import sniff_audio
from tilhero_catalog.domain.requests import normalize_title
from tilhero_catalog.domain.scenario_test import run_test
from tilhero_catalog.domain.seed import SeedInvalid, check_seed, load_seed_dir
from tilhero_catalog.domain.validation import RefContext, down_refs_of, locale_state, parse_schema, validate

TODAY = date(2026, 11, 19)


def all_seed() -> dict[tuple[str, str], dict[str, Any]]:
    return {(k, p[KEY_FIELDS[k]]): p for k, p in load_seed_dir(SEED_DIR)}


def ctx(mode: str = "submit", **kw: Any) -> RefContext:
    view = all_seed()
    base: dict[str, Any] = {"mode": mode, "today": TODAY, "existing": dict(view), "published": dict(view),
                            "pairs": {"ru-en"}}
    if mode == "publish":
        base.update(locale_checks={"ru": "checked", "uz": "checked"}, rights_approved=True, test_run_ok=True)
    base.update(kw)
    return RefContext(**base)


def codes(kind: str, payload: dict[str, Any], c: RefContext | None = None) -> list[str]:
    return [i.code for i in validate(kind, payload, c or ctx())]


def issues(kind: str, payload: dict[str, Any], c: RefContext | None = None) -> list[tuple[str, str]]:
    return [(i.code, i.path) for i in validate(kind, payload, c or ctx())]


# ---------------------------------------------------------------- сид и схема


def test_shipped_seed_is_valid_as_published() -> None:
    entries = load_seed_dir(SEED_DIR)
    kinds = {k for k, _ in entries}
    assert {"course", "module", "skill", "lesson", "rubric", "scenario", "media_asset"} <= kinds
    out = check_seed(entries, published={}, pairs={"ru-en"}, blobs=set(), today=TODAY, external_sources=False)
    assert len(out) == len(entries)
    for kind, payload in out:
        assert validate(kind, payload, ctx("publish")) == [], (kind, payload[KEY_FIELDS[kind]])


def test_seed_check_lists_all_problems() -> None:
    bad = lesson("l-bad")
    bad["control_items"] = []
    bad["title"]["uz"] = ""
    dup = copy.deepcopy(bad)
    with pytest.raises(SeedInvalid) as exc:
        check_seed([("lesson", bad), ("lesson", dup), ("skill", {"skill_id": "X"})], published=all_seed(),
                   pairs={"ru-en"}, blobs=set(), today=TODAY, external_sources=False)
    text = "\n".join(exc.value.problems)
    assert "NO_CONTROL_ITEMS" in text and "LOCALE_MISSING" in text and "DUPLICATE_ID" in text
    assert "SCHEMA_INVALID" in text


def test_schema_errors_have_payload_paths() -> None:
    p = lesson("l-x")
    p["stages"][0]["type"] = "warmup"
    p["extra"] = 1
    model, errs = parse_schema("lesson", p)
    assert model is None
    assert {(e.code, e.path) for e in errs} >= {("SCHEMA_INVALID", "payload.stages[0].type"),
                                                ("SCHEMA_INVALID", "payload.extra")}


@pytest.mark.parametrize("bad_key", ["Upper", "a", "has space", "-start", "x" * 65])
def test_identifier_pattern(bad_key: str) -> None:
    model, errs = parse_schema("skill", skill(bad_key))
    assert model is None and errs[0].path == "payload.skill_id"


def test_control_characters_rejected_by_schema() -> None:
    p = lesson("l-x")
    p["title"]["ru"] = "Привет‮мир"
    assert parse_schema("lesson", p)[0] is None


# ---------------------------------------------------------------- локализации


def test_locale_missing_and_script() -> None:
    p = lesson("l-x")
    p["title"]["uz"] = " "
    p["goal"]["uz"] = "Привет"
    p["key_words"][0]["gloss"]["uz"] = "o'zbek"
    found = issues("lesson", p)
    assert ("LOCALE_MISSING", "payload.title.uz") in found
    assert ("LOCALE_SCRIPT", "payload.goal.uz") in found
    assert ("LOCALE_SCRIPT", "payload.key_words[0].gloss.uz") in found


def test_locale_state_of_draft() -> None:
    p = lesson("l-x")
    model, _ = parse_schema("lesson", p)
    assert model is not None and locale_state(model) == {"ru": "draft", "uz": "draft"}
    p["hints"][0]["ru"] = ""
    model, _ = parse_schema("lesson", p)
    assert model is not None and locale_state(model) == {"ru": "missing", "uz": "draft"}


def test_publish_requires_checked_locales() -> None:
    found = issues("rubric", rubric("r-x"), ctx("publish", locale_checks={"ru": "checked", "uz": "draft"}))
    assert found == [("LOCALE_NOT_CHECKED", "locale_checks.uz")]


# ---------------------------------------------------------------- уроки, навыки, модули, курс (AT-27)


def test_lesson_without_control_items_and_bad_stages() -> None:
    p = lesson("l-x")
    p["control_items"] = p["control_items"][:2]
    p["stages"][0], p["stages"][1] = p["stages"][1], p["stages"][0]
    p["stages"][2]["minutes"] = 12
    p["key_words"] = p["key_words"][:3]
    p["secondary_skill_ids"] = ["en.gram.to-be", "en.func.order-drink", "en.func.greet", "en.gram.to-be"]
    found = codes("lesson", p)
    assert "NO_CONTROL_ITEMS" in found
    assert found.count("STAGES_INVALID") == 3  # порядок, минуты этапа, сумма ≠ duration_min
    assert "COUNT_OUT_OF_RANGE" in found and "DUPLICATE_ID" in found


def test_lesson_answers_checked_by_type() -> None:
    p = lesson("l-x")
    p["control_items"][0]["answer"] = 7
    p["control_items"][1]["answer"] = []
    p["control_items"][2]["answer"] = ["Nice", "to", "see", "you"]
    found = issues("lesson", p)
    assert {("ANSWER_INVALID", f"payload.control_items[{i}].answer") for i in range(3)} <= set(found)


def test_unknown_refs_submit_vs_publish() -> None:
    p = lesson("l-x")
    p["primary_skill_id"] = "en.func.nope"
    p["rubric_id"] = "r-nope"
    found = issues("lesson", p)
    assert ("UNKNOWN_REF", "payload.primary_skill_id") in found and ("UNKNOWN_REF", "payload.rubric_id") in found
    # при публикации ссылка на неопубликованное — тоже UNKNOWN_REF; контейнер (модуль) — достаточно существования
    q = lesson("l-y", module_id="m-draft")
    c = ctx("publish")
    c.existing[("module", "m-draft")] = {"module_id": "m-draft", "course_id": "en-core"}
    c.existing[("skill", "en.new")] = skill("en.new")
    q["secondary_skill_ids"] = ["en.new"]
    found = issues("lesson", q, c)
    assert ("UNKNOWN_REF", "payload.secondary_skill_ids[0]") in found
    assert not [f for f in found if f[1] == "payload.module_id"]


def test_ref_to_other_course_is_mismatch() -> None:
    c = ctx()
    c.existing[("skill", "en.other")] = skill("en.other", course="en-other")
    p = lesson("l-x")
    p["secondary_skill_ids"] = ["en.other"]
    assert ("REF_MISMATCH", "payload.secondary_skill_ids[0]") in issues("lesson", p, c)


def test_kids_lesson_cannot_use_adult_scenario() -> None:
    c = ctx()
    c.existing[("scenario", "sc-adult")] = scenario("sc-adult", audience=["adults"])
    p = lesson("l-x", scenario_id="sc-adult", audience=["kids", "adults"])
    assert ("KIDS_CONTENT", "payload.scenario_id") in issues("lesson", p, c)
    assert "KIDS_CONTENT" not in codes("lesson", lesson("l-y", scenario_id="sc-adult", audience=["adults"]), c)


def test_kids_content_has_no_external_links() -> None:
    p = lesson("l-kids", audience=["kids"])
    p["hints"] = [L("Смотри www.example.com", "Qarang: example.uz")]
    p["examples"][0]["en"] = "Visit https://example.com today!"
    found = issues("lesson", p)
    assert ("KIDS_CONTENT", "payload.hints[0].ru") in found and ("KIDS_CONTENT", "payload.hints[0].uz") in found
    assert ("KIDS_CONTENT", "payload.examples[0].en") in found
    adults = lesson("l-adults", audience=["adults"])
    adults["hints"] = [L("Смотри www.example.com", "Qarang: example.uz")]
    assert "KIDS_CONTENT" not in codes("lesson", adults)
    m = media("m-kids", license_ref="https://tilhero.uz/license")  # не показывается ученику — допустимо
    assert "KIDS_CONTENT" not in codes("media_asset", m)
    m["rights"]["attribution"] = "Музыка: https://example.com/author"
    assert ("KIDS_CONTENT", "payload.rights.attribution") in issues("media_asset", m)
    e = media("m-kids-embed", license_type="contract", license_ref="ToS")
    e.update(origin="platform_embed", embed={"provider": "youtube", "video_id": "abcdefghijk", "start_s": 0,
                                             "end_s": 30})
    assert ("KIDS_CONTENT", "payload.embed") in issues("media_asset", e, ctx(external_sources=True))


def test_audience_empty() -> None:
    assert "AUDIENCE_EMPTY" in codes("lesson", lesson("l-x", audience=[]))
    assert "AUDIENCE_EMPTY" in codes("scenario", scenario("sc-x", audience=[]))


def test_prerequisite_cycles() -> None:
    assert "PREREQ_CYCLE" in codes("skill", skill("en.a", prerequisites=["en.a"]))
    c = ctx()
    c.existing[("skill", "en.a")] = skill("en.a", prerequisites=["en.b"])
    c.existing[("skill", "en.b")] = skill("en.b", prerequisites=["en.c"])
    c.existing[("skill", "en.c")] = skill("en.c")
    # новая версия en.c с предпосылкой en.a замыкает цикл c → a → b → c
    found = validate("skill", skill("en.c", prerequisites=["en.a"]), c)
    cycle = [i for i in found if i.code == "PREREQ_CYCLE"]
    assert cycle and "en.c → en.a → en.b → en.c" in cycle[0].message
    assert "PREREQ_CYCLE" not in codes("skill", skill("en.d", prerequisites=["en.a"]), c)
    assert "UNKNOWN_REF" in codes("skill", skill("en.e", prerequisites=["en.missing"]), c)


def test_module_and_course_integrity() -> None:
    c = ctx()
    c.existing[("lesson", "l-foreign")] = lesson("l-foreign", module_id="m2-city")
    mod = seed("module", "m1-meet")
    mod["lesson_ids"] = ["l-foreign", "l-missing"]
    found = issues("module", mod, c)
    assert ("REF_MISMATCH", "payload.lesson_ids[0]") in found and ("UNKNOWN_REF", "payload.lesson_ids[1]") in found
    mod["lesson_ids"] = []
    assert "COUNT_OUT_OF_RANGE" in codes("module", mod)
    course = seed("course", "en-core")
    course["level_start"], course["level_end"] = "B1", "A1"
    course["pair_id"] = "ru-xx"
    course["module_ids"] = ["m1-meet", "m1-meet"]
    found = codes("course", course)
    assert {"LEVEL_RANGE", "UNKNOWN_REF", "DUPLICATE_ID"} <= set(found)


# ---------------------------------------------------------------- рубрики


def test_rubric_rules() -> None:
    p = rubric("r-x")
    p["criteria"][0]["weight"] = 0.5
    p["criteria"][1]["bands"] = p["criteria"][1]["bands"][:3]
    found = issues("rubric", p)
    assert ("RUBRIC_WEIGHTS", "payload.criteria") in found
    assert ("RUBRIC_BANDS", "payload.criteria[1].bands") in found
    empty = rubric("r-y")
    empty["criteria"] = []
    assert {"COUNT_OUT_OF_RANGE", "RUBRIC_WEIGHTS"} <= set(codes("rubric", empty))


def test_rubric_must_apply_to_target() -> None:
    c = ctx()
    only_lessons = rubric("r-lessons")
    only_lessons["applies_to"] = ["lesson"]
    c.existing[("rubric", "r-lessons")] = only_lessons
    sc = scenario("sc-x")
    sc["rubric_id"] = "r-lessons"
    assert ("RUBRIC_MISMATCH", "payload.rubric_id") in issues("scenario", sc, c)


# ---------------------------------------------------------------- граф сценария (AT-28)


def node(speaker: str = "barista", to: list[str] | None = None, end: str | None = None,
         recovery: bool = False) -> dict[str, Any]:
    return {"speaker": speaker, "line_en": "Hello.", "gloss": L("Привет.", "Salom."), "hint": None,
            "recovery_point": recovery, "event": None,
            "transitions": [{"intent": "go", "description": L("Дальше", "Davom"), "examples_en": ["OK."], "to": t}
                            for t in (to or [])],
            "end": None if end is None else {"outcome": end, "summary": L("Итог", "Yakun")}}


def graph(nodes: dict[str, Any], start: str = "a") -> dict[str, Any]:
    p = scenario("sc-g")
    p["nodes"] = nodes
    p["start_node"] = start
    return p


def run_codes(p: dict[str, Any]) -> set[tuple[str, str | None]]:
    return {(i["code"], i["node_id"]) for i in run_test(p, "t")["issues"]}


def test_seed_scenario_passes_test_run() -> None:
    result = run_test(seed("scenario", "sc-cafe-coffee"), "2026-11-19T00:00:00Z")
    assert result["ok"] and result["issues"] == []
    assert result["stats"] == {"nodes": 5, "ends": {"success": 1, "alt_success": 1, "fail": 0}, "max_depth": 2,
                               "paths_to_success": 2}


def test_graph_issue_codes() -> None:
    p = graph({
        "a": node(to=["b", "ghost"]),
        "b": node(to=["c"]),
        "c": node(to=["b"]),  # b ↔ c — ловушка: конца не достичь
        "d": node(end="success"),  # недостижим
        "e": node(speaker="stranger", end="fail"),
        "f": node(),  # тупик (без переходов и не конец), недостижим
    })
    found = run_codes(p)
    assert {("UNKNOWN_NODE", "a"), ("TRAP", "b"), ("TRAP", "c"), ("UNREACHABLE_NODE", "d"),
            ("UNKNOWN_SPEAKER", "e"), ("DEAD_END", "f"), ("NO_SUCCESS_END", None)} <= found
    assert not run_test(p, "t")["ok"]


def test_start_missing_and_too_many_nodes() -> None:
    assert ("START_MISSING", None) in run_codes(graph({"a": node(end="success")}, start="zz"))
    many = {f"n{i:02d}": node(to=[f"n{i + 1:02d}"], recovery=i == 3) for i in range(31)}
    many["n31"] = node(end="success")
    assert ("TOO_MANY_NODES", None) in run_codes(graph(many, start="n00"))


def test_recovery_points() -> None:
    chain = {f"n{i}": node(to=[f"n{i + 1}"]) for i in range(7)}
    chain["n7"] = node(end="success")
    assert ("NO_RECOVERY_POINT", None) in run_codes(graph(chain, start="n0"))
    chain["n3"]["recovery_point"] = True
    assert run_test(graph(chain, start="n0"), "t")["ok"]
    # из точки восстановления не дойти до успеха
    branch = {"a": node(to=["b", "s"]), "b": node(to=["f"], recovery=True), "f": node(end="fail"),
              "s": node(end="success"), "x1": node(to=["s"]), "x2": node(to=["s"]), "x3": node(to=["s"])}
    branch["a"]["transitions"] += [{"intent": "x", "description": L("x", "x"), "examples_en": ["x"], "to": t}
                                   for t in ("x1", "x2", "x3")]
    assert ("RECOVERY_CANNOT_FINISH", "b") in run_codes(graph(branch))


def test_scenario_graph_problems_block_submit_and_test_run_blocks_publish() -> None:
    p = seed("scenario", "sc-cafe-coffee")
    p["nodes"]["n4"]["end"] = None  # n4 — тупик, успешного конца больше нет
    found = issues("scenario", p)
    assert ("DEAD_END", "payload.nodes.n4") in found and ("NO_SUCCESS_END", "payload.nodes") in found
    p = seed("scenario", "sc-cafe-coffee")
    p["nodes"]["n4"]["transitions"] = p["nodes"]["n1"]["transitions"][:1]
    assert ("END_HAS_TRANSITIONS", "payload.nodes.n4.transitions") in issues("scenario", p)
    assert issues("scenario", seed("scenario", "sc-cafe-coffee"), ctx("publish", test_run_ok=False)) == [
        ("SCENARIO_TEST_FAILED", "test_run")]


def test_scenario_counts() -> None:
    p = seed("scenario", "sc-cafe-coffee")
    p["characters"] = []
    p["nodes"]["n1"]["transitions"][0]["examples_en"] = []
    found = codes("scenario", p)
    assert found.count("COUNT_OUT_OF_RANGE") >= 2 and "UNKNOWN_SPEAKER" in found


# ---------------------------------------------------------------- медиа (AT-29)


def test_media_rights_rules() -> None:
    assert "RIGHTS_REQUIRED" not in codes("media_asset", media("m-x"))
    for rights, path in [
        ({"territories": ["KZ"]}, "payload.rights.territories"),
        ({"valid_to": "2026-11-18"}, "payload.rights.valid_to"),
        ({"valid_from": "2026-12-01", "valid_to": "2026-11-30"}, "payload.rights.valid_to"),
        ({"allowed_uses": []}, "payload.rights.allowed_uses"),
        ({"license_type": "cc_by"}, "payload.rights.license_type"),
        ({"owner": " "}, "payload.rights.owner"),
    ]:
        assert ("RIGHTS_REQUIRED", path) in issues("media_asset", media("m-x", **rights)), rights
    cc = media("m-cc", license_type="cc_by", attribution=None)
    cc["origin"] = "open_license"
    assert ("RIGHTS_REQUIRED", "payload.rights.attribution") in issues("media_asset", cc)
    cc["rights"]["attribution"] = "Автор — Alex, CC BY 4.0"
    assert "RIGHTS_REQUIRED" not in codes("media_asset", cc)
    assert ("RIGHTS_REQUIRED", "rights_approved") in issues("media_asset", media("m-x"),
                                                            ctx("publish", rights_approved=False))


def test_valid_to_today_is_still_valid() -> None:
    assert "RIGHTS_REQUIRED" not in codes("media_asset", media("m-x", valid_to=TODAY.isoformat()))


def test_external_sources_flag() -> None:
    p = media("m-lic", license_type="contract", license_ref="Договор №1")
    p["origin"] = "licensed"
    assert ("EXTERNAL_SOURCE_DISABLED", "payload.origin") in issues("media_asset", p)
    assert "EXTERNAL_SOURCE_DISABLED" not in codes("media_asset", p, ctx(external_sources=True))
    e = media("m-embed", license_type="contract", license_ref="YouTube ToS")
    e["origin"] = "platform_embed"
    e["embed"] = {"provider": "youtube", "video_id": "abcdefghijk", "start_s": 10, "end_s": 200}
    found = codes("media_asset", e, ctx(external_sources=True))
    assert "EMBED_INVALID" in found and "EXTERNAL_SOURCE_DISABLED" not in found
    assert "EXTERNAL_SOURCE_DISABLED" in codes("media_asset", e)
    contract = media("m-c", license_type="contract", license_ref=None)
    contract["origin"] = "licensed"
    assert ("RIGHTS_REQUIRED", "payload.rights.license_ref") in issues("media_asset", contract,
                                                                     ctx(external_sources=True))


def test_transcript_and_duration() -> None:
    p = media("m-x")
    p["transcript"][1]["t_start_ms"] = 3000  # перекрытие с первой строкой
    p["transcript"][2]["t_end_ms"] = 7000  # конец раньше начала
    p["transcript"][4]["t_end_ms"] = 25_000  # за длительностью 24 с
    p["phrases"][0]["t_ms"] = 99_000
    found = issues("media_asset", p)
    for path in ("payload.transcript[1]", "payload.transcript[2]", "payload.transcript[4]", "payload.phrases[0].t_ms"):
        assert ("TRANSCRIPT_INVALID", path) in found, path
    long = media("m-long")
    long["duration_s"] = 91
    assert "MEDIA_TOO_LONG" in codes("media_asset", long)
    short = media("m-short")
    short["duration_s"] = 4
    short["transcript"] = short["transcript"][:1]
    assert "MEDIA_TOO_SHORT" in codes("media_asset", short)
    empty = media("m-empty")
    empty["transcript"] = []
    assert "TRANSCRIPT_INVALID" in codes("media_asset", empty)


def test_audio_blob_reference() -> None:
    p = media("m-x")
    p["audio_blob_id"] = "00000000-0000-4000-8000-000000000001"
    assert ("UNKNOWN_REF", "payload.audio_blob_id") in issues("media_asset", p)
    assert "UNKNOWN_REF" not in codes("media_asset", p, ctx(blobs={p["audio_blob_id"]}))


def test_media_exercise_rules() -> None:
    assert codes("media_exercise", exercise("ex-1")) == []
    bad = exercise("ex-2")
    bad["answer"] = 5
    assert ("ANSWER_INVALID", "payload.answer") in issues("media_exercise", bad)
    # order_lines: options — перемешанные реплики транскрипта, answer — индексы options в правильном порядке
    lines = ["Small or large?", "Hi! What would you like?", "A hot chocolate, please."]
    order = {**exercise("ex-3"), "type": "order_lines", "options": lines, "answer": [1, 0, 0]}
    assert ("ANSWER_INVALID", "payload.answer") in issues("media_exercise", order)
    order["answer"] = [1, 2, 0]
    assert codes("media_exercise", order) == []
    order["answer"] = [2, 1, 0]  # перестановка, но не порядок транскрипта
    assert ("ANSWER_INVALID", "payload.answer") in issues("media_exercise", order)
    order.update(options=["Hello!", *lines[1:]], answer=[0, 1, 2])
    assert ("ANSWER_INVALID", "payload.options") in issues("media_exercise", order)
    # gap_fill: строка с ___; line_index — реплика-источник (допустим, в пределах транскрипта)
    gap = {**exercise("ex-4"), "type": "gap_fill", "prompt_en": "Small or ___?", "options": [], "answer": ["large"],
           "line_index": 2}
    assert codes("media_exercise", gap) == []
    gap["line_index"] = 5
    assert ("ANSWER_INVALID", "payload.line_index") in issues("media_exercise", gap)
    gap.update(line_index=None, prompt_en="Small or large?")
    assert "ANSWER_INVALID" in codes("media_exercise", gap)
    shadow = {**exercise("ex-5"), "type": "shadowing", "prompt_en": None, "options": [], "answer": None,
              "line_index": 9}
    assert ("ANSWER_INVALID", "payload.line_index") in issues("media_exercise", shadow)
    shadow["line_index"] = 2
    assert codes("media_exercise", shadow) == []
    role = {**exercise("ex-6"), "type": "roleplay", "prompt_en": None, "options": [], "answer": 1}
    assert "ANSWER_INVALID" in codes("media_exercise", role)


def test_media_exercise_needs_license_for_exercises() -> None:
    c = ctx()
    c.existing[("media_asset", "m-listen")] = media("m-listen", allowed_uses=["listen"])
    assert ("RIGHTS_REQUIRED", "payload.asset_id") in issues("media_exercise", exercise("ex-1", asset_id="m-listen"),
                                                             c)


def test_down_refs_ignore_containers() -> None:
    refs = down_refs_of("lesson", seed("lesson", "l-07-coffee"))
    assert ("scenario", "sc-cafe-coffee") in refs and ("rubric", "r-lesson-core") in refs
    assert ("course", "en-core") not in refs and ("module", "m2-city") not in refs


# ---------------------------------------------------------------- мелочи


@pytest.mark.parametrize(("data", "kind"), [
    (b"ID3\x04\x00rest", "audio/mpeg"), (b"\xff\xfb\x90\x00", "audio/mpeg"), (b"OggS\x00\x02", "audio/ogg"),
    (b"\x00\x00\x00\x20ftypM4A \x00\x00", "audio/mp4"), (b"<html>", None), (b"RIFF....WAVE", None),
])
def test_audio_signature(data: bytes, kind: str | None) -> None:
    assert sniff_audio(data) == kind


def test_normalize_title() -> None:
    assert normalize_title("  Bohemian   Rhapsody!! ") == normalize_title("bohemian rhapsody")
    assert normalize_title("Ёлка — 2") == "елка 2"

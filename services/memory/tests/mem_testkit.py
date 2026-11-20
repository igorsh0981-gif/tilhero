"""Тестовый набор memory: заглушки доменов (httpx.MockTransport) на РЕАЛЬНОМ сиде catalog
(`services/catalog/migrations/seed/*.json`) + синтетические тексты для чтения.

- FakeCatalog: версии `/internal/v1/versions/{kind}/{key}[/{version}]`, словарь курса (lookup с проверкой «слово есть
  в тексте» по границам слов, ai-entries upsert по форме, forms), задания проверок удержания по навыку;
- FakeAssessment: memory-feed по evaluation_id (ошибки текста ученика);
- FakeAI: статус, teaching_coach gloss_word (fake-провайдер: «[ru] word»), оценка произношения (fake-речь:
  средняя амплитуда < 200 → insufficient_evidence; слова ≥ 8 букв — 55 и mispronunciation);
- FakeIdentity: `/internal/v1/users/{lrn}/public` с целями согласия.
Аудио в заглушке не сохраняется: записываются только метаданные (X-Speech-Meta) и длина тела.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import json
import re
import struct
import uuid
from pathlib import Path
from typing import Any

import httpx
import jwt

from tilhero_memory.domain.normalize import normalize

SEED = Path(__file__).resolve().parents[2] / "catalog" / "migrations" / "seed"
KIND_FILES = {"lesson": "lessons.json", "media_asset": "media.json", "skill": "skills.json",
              "scenario": "scenarios.json"}
KEY_FIELD = {"lesson": "lesson_id", "media_asset": "asset_id", "skill": "skill_id", "scenario": "scenario_id"}

READINGS: dict[str, dict[str, Any]] = {
    "r-a1-coffee": {
        "reading_id": "r-a1-coffee", "title": {"ru": "В кофейне", "uz": "Qahvaxonada"}, "level": "A1",
        "audience": ["teens", "adults"], "voice": "en-US",
        "paragraphs": [{"p_id": "p1", "sentences": [
            {"s_id": "s1", "text_en": "Anna goes to a small coffee shop every morning.",
             "gloss": {"ru": "Анна каждое утро ходит в маленькую кофейню.",
                       "uz": "Anna har kuni ertalab qahvaxonaga boradi."}},
            {"s_id": "s2", "text_en": "She orders a cup of tea and a croissant.",
             "gloss": {"ru": "Она заказывает чашку чая и круассан.", "uz": "U bir piyola choy va kruassan buyuradi."}},
            {"s_id": "s3", "text_en": "The barista is friendly and always smiles.",
             "gloss": {"ru": "Бариста дружелюбный и всегда улыбается.", "uz": "Barista samimiy va doim jilmayadi."}},
        ]}],
        "glossary": [{"en": "orders", "gloss": {"ru": "заказывает", "uz": "buyuradi"},
                      "note": {"ru": "глагол order + -s", "uz": "order feʼli + -s"}}],
        "questions": [],
    },
    "r-kids-cat": {
        "reading_id": "r-kids-cat", "title": {"ru": "Мой кот", "uz": "Mening mushugim"}, "level": "A0",
        "audience": ["kids"], "voice": "en-US",
        "paragraphs": [{"p_id": "p1", "sentences": [
            {"s_id": "s1", "text_en": "I have a little cat.",
             "gloss": {"ru": "У меня есть котёнок.", "uz": "Mening mushugim bor."}},
            {"s_id": "s2", "text_en": "My cat likes milk.",
             "gloss": {"ru": "Мой кот любит молоко.", "uz": "Mushugim sutni yaxshi koʻradi."}},
        ]}],
        "glossary": [], "questions": [],
    },
}


def load_seed() -> dict[str, dict[str, dict[str, Any]]]:
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for kind, name in KIND_FILES.items():
        data = json.loads((SEED / name).read_text(encoding="utf-8"))
        items = data if isinstance(data, list) else [data]
        out[kind] = {str(x[KEY_FIELD[kind]]): x for x in items}
    out["reading"] = copy.deepcopy(READINGS)
    return out


SEED_DATA = load_seed()


def error(status: int, code: str) -> httpx.Response:
    return httpx.Response(status, json={"code": code, "message": code, "trace_id": "t", "details": {}})


def _texts(kind: str, payload: dict[str, Any]) -> dict[str, str]:
    """locator → английский текст места в контенте."""
    out: dict[str, str] = {}
    if kind == "lesson":
        for i, kw in enumerate(payload.get("key_words") or []):
            out[f"kw:{i}"] = kw["en"]
            out[f"kwx:{i}"] = kw["example_en"]
        for i, ex in enumerate(payload.get("examples") or []):
            out[f"ex:{i}"] = ex["en"]
    elif kind == "media_asset":
        for i, ln in enumerate(payload.get("transcript") or []):
            out[str(i)] = ln["text_en"]
    elif kind == "reading":
        for p in payload["paragraphs"]:
            for s in p["sentences"]:
                out[s["s_id"]] = s["text_en"]
    elif kind == "scenario":
        for nid, node in (payload.get("nodes") or {}).items():
            out[nid] = node["line_en"]
    return out


def _contains(sentence: str, text: str) -> bool:
    base = sentence.replace("’", "'").lower()
    t = normalize(text)
    return bool(t) and re.search(rf"(?<![\w']){re.escape(t)}(?![\w'])", base) is not None


class FakeCatalog:
    def __init__(self) -> None:
        self.data = copy.deepcopy(SEED_DATA)
        self.versions: dict[tuple[str, str], dict[int, dict[str, Any]]] = {
            (kind, key): {1: payload} for kind, items in self.data.items() for key, payload in items.items()}
        self.published: dict[tuple[str, str], int | None] = {k: 1 for k in self.versions}
        self.drafts: set[tuple[str, str, int]] = set()
        self.down = False
        self.calls: list[str] = []
        self.entries: dict[str, dict[str, Any]] = {}
        self.rejected_forms: set[str] = set()
        self.ai_entry_down = False
        for lid, lesson in self.data["lesson"].items():
            for kw in lesson["key_words"]:
                form = normalize(kw["en"])
                if form and not self.by_form(form):
                    self.add_entry(lemma=kw["en"], forms=[form], gloss=kw["gloss"], source="course",
                                   ref={"kind": "lesson", "key": lid, "version": 1})

    # ---------- словарь курса
    def add_entry(self, *, lemma: str, forms: list[str], gloss: dict[str, str], source: str = "methodist",
                  review_status: str = "not_required", confidence: float | None = None,
                  ref: dict[str, Any] | None = None) -> dict[str, Any]:
        entry = {"entry_id": str(uuid.uuid4()), "pair_id": "ru-en", "lemma": lemma, "forms": forms,
                 "part_of_speech": None, "gloss": gloss, "example_en": None, "source": source,
                 "review_status": review_status, "confidence": confidence, "agent_version": None,
                 "refs": [ref] if ref else [], "override": None, "corrected": False, "archived_at": None,
                 "updated_by": None, "updated_at": "2026-11-20T00:00:00Z"}
        self.entries[entry["entry_id"]] = entry
        return entry

    def by_form(self, form: str) -> dict[str, Any] | None:
        for e in self.entries.values():
            if e["archived_at"] is None and form in e["forms"]:
                return e
        return None

    def publish(self, kind: str, key: str, payload: dict[str, Any]) -> int:
        versions = self.versions.setdefault((kind, key), {})
        v = max(versions, default=0) + 1
        versions[v] = payload
        self.published[(kind, key)] = v
        return v

    def calls_to(self, prefix: str) -> int:
        return sum(1 for c in self.calls if c.startswith(prefix))

    # ---------- задания проверок
    def check_items(self, skill_id: str, audience: str) -> list[dict[str, Any]]:
        """Как catalog: сначала задания самого навыка, затем остальные контрольные задания его уроков."""
        own, other = [], []
        for lid, lesson in sorted(self.data["lesson"].items()):
            if lesson["primary_skill_id"] == skill_id and audience in lesson["audience"]:
                for ci in lesson["control_items"]:
                    (own if ci["skill_id"] == skill_id else other).append({"lesson_id": lid, "version": 1,
                                                                           "item": ci})
        return [*own, *other][:20]

    def _version_status(self, kind: str, key: str, v: int) -> str:
        if (kind, key, v) in self.drafts:
            return "draft"
        return "published" if self.published.get((kind, key)) == v else "archived"

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append(path)
        assert request.headers.get("x-internal-token"), "internal JWT is required"
        if self.down:
            return error(503, "UNAVAILABLE")
        m = re.fullmatch(r"/internal/v1/versions/([a-z_]+)/([^/]+)(?:/(\d+))?", path)
        if m:
            kind, key, version = m.group(1), m.group(2), m.group(3)
            if kind not in ("lesson", "media_asset", "reading", "scenario"):
                return error(403, "KIND_NOT_ALLOWED")  # memory читает только контент (catalog §2.3)
            versions = self.versions.get((kind, key)) or {}
            v = int(version) if version else self.published.get((kind, key))
            if v is None or v not in versions or self._version_status(kind, key, v) == "draft":
                return error(404, "VERSION_NOT_FOUND")
            return httpx.Response(200, json={"kind": kind, "key": key, "version": v,
                                             "status": self._version_status(kind, key, v), "payload": versions[v]})
        if path == "/internal/v1/glossary/lookup":
            body = json.loads(request.content)
            assert len(body["text"]) <= 120
            ref = body["content_ref"]
            versions = self.versions.get((ref["kind"], ref["key"])) or {}
            v = ref["version"]
            if v not in versions or self._version_status(ref["kind"], ref["key"], v) == "draft":
                return error(404, "CONTENT_NOT_FOUND")
            payload = versions[v]
            texts = _texts(ref["kind"], payload)
            places = [(ref["locator"], texts[ref["locator"]])] if ref.get("locator") in texts else list(texts.items())
            hit = next(((loc, t) for loc, t in places if _contains(t, body["text"])), None)
            if hit is None:
                return error(422, "WORD_NOT_IN_CONTENT")
            form = normalize(body["text"])
            entry = self.by_form(form)
            rejected = entry is not None and entry["review_status"] == "rejected"
            note = next((g["note"] for g in payload.get("glossary") or [] if normalize(g["en"]) == form), None)
            return httpx.Response(200, json={"in_content": True, "sentence_en": hit[1], "locator": hit[0],
                                             "note": note, "entry": entry,
                                             "rejected": rejected or form in self.rejected_forms})
        if path == "/internal/v1/glossary/ai-entries":
            if self.ai_entry_down:
                return error(503, "UNAVAILABLE")
            body = json.loads(request.content)
            assert set(body) == {"pair_id", "surface", "lemma", "part_of_speech", "gloss", "forms", "confidence",
                                 "agent_version", "content_ref"}, body
            for f in body["forms"]:
                existing = self.by_form(f)
                if existing is not None:
                    return httpx.Response(200, json=existing)
            entry = self.add_entry(lemma=body["lemma"], forms=body["forms"], gloss=body["gloss"], source="ai",
                                   review_status="pending", confidence=body["confidence"], ref=body["content_ref"])
            return httpx.Response(201, json=entry)
        if path == "/internal/v1/glossary/forms":
            forms = request.url.params.get_list("forms")
            assert 1 <= len(forms) <= 50
            return httpx.Response(200, json={"items": [{"form": f, "entry": self.by_form(normalize(f))}
                                                       for f in forms]})
        m = re.fullmatch(r"/internal/v1/skills/([^/]+)/check-items", path)
        if m:
            skill = m.group(1)
            if skill not in self.data["skill"]:
                return error(404, "SKILL_NOT_FOUND")
            return httpx.Response(200, json={"skill_id": skill, "title": self.data["skill"][skill]["title"],
                                             "items": self.check_items(skill, request.url.params["audience"])})
        return error(404, "NOT_FOUND")


class FakeAssessment:
    def __init__(self) -> None:
        self.feeds: dict[str, dict[str, Any]] = {}
        self.gone: set[str] = set()  # 410 — ученик удалён
        self.down = False
        self.calls = 0

    def feed(self, user: uuid.UUID, *, kind: str = "lesson", lesson: str | None = "l-01-greetings",
             media: str | None = None, scenario: str | None = None, errors: list[dict[str, Any]] | None = None,
             evaluation_id: str | None = None, session_id: str | None = None, version: int = 1) -> str:
        ev = evaluation_id or str(uuid.uuid4())
        refs = {"lesson": {"key": lesson, "version": version} if lesson else None,
                "scenario": {"key": scenario, "version": version} if scenario else None,
                "media_asset": {"key": media, "version": version} if media else None, "reading": None,
                "rubric": {"key": "r-roleplay", "version": 1}, "media_exercises": []}
        self.feeds[ev] = {"evaluation_id": ev, "session_id": session_id or str(uuid.uuid4()), "user_id": str(user),
                          "pair_id": "ru-en", "kind": kind, "content_refs": refs, "practice_only": kind != "lesson",
                          "superseded_by": None, "errors": errors or []}
        return ev

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers.get("x-internal-token")
        self.calls += 1
        if self.down:
            return error(503, "UNAVAILABLE")
        m = re.fullmatch(r"/internal/v1/evaluations/([^/]+)/memory-feed", request.url.path)
        assert m, request.url.path
        if m.group(1) in self.gone:
            return error(410, "USER_DELETED")
        feed = self.feeds.get(m.group(1))
        return httpx.Response(200, json=feed) if feed else error(404, "EVALUATION_NOT_FOUND")


def wav(seconds: float = 1.0, *, rate: int = 16_000, channels: int = 1, bits: int = 16, amplitude: int = 1000,
        fmt: int = 1) -> bytes:
    n = int(seconds * rate)
    sample = struct.pack("<h", amplitude) + struct.pack("<h", -amplitude)
    data = (sample * (n // 2 + 1))[: n * channels * (bits // 8)]
    header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(data), b"WAVE", b"fmt ", 16, fmt, channels, rate,
                         rate * channels * bits // 8, channels * bits // 8, bits, b"data", len(data))
    return header + data


def _amplitude(audio: bytes) -> float:
    body = audio[44:]
    count = len(body) // 2
    if count == 0:
        return 0.0
    samples = struct.unpack(f"<{count}h", body[: count * 2])
    return sum(abs(s) for s in samples) / count


class FakeAI:
    def __init__(self) -> None:
        self.status = {"ai_available": True, "speech_available": True}
        self.status_down = False
        self.gloss_mode = "ok"  # ok | unavailable | refused | error | low
        self.speech_mode = "ok"  # ok | unavailable | error
        self.requests: list[dict[str, Any]] = []
        self.speech: list[dict[str, Any]] = []  # метаданные и длина тела — без аудио
        self.delay = 0.0  # ответ через N секунд (таймауты memory)

    def handler(self, request: httpx.Request) -> Any:
        resp = self._handle(request)
        if not self.delay:
            return resp

        async def later() -> httpx.Response:
            await asyncio.sleep(self.delay)
            return resp
        return later()

    def _handle(self, request: httpx.Request) -> httpx.Response:
        token = request.headers.get("x-internal-token")
        assert token
        sub_ = jwt.decode(token, options={"verify_signature": False}).get("sub")
        assert sub_, "ai-gateway: subject = ученик во всех вызовах"
        path = request.url.path
        if path == "/internal/v1/status":
            return error(500, "INTERNAL_ERROR") if self.status_down else httpx.Response(200, json=self.status)
        if path == "/internal/v1/speech/pronunciation":
            assert request.headers["content-type"] == "audio/wav"
            raw = request.headers["x-speech-meta"]
            meta = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
            assert meta["user_id"] == sub_ and set(meta) == {"request_id", "user_id", "audience", "locale",
                                                              "reference_text", "language"}
            self.speech.append({"meta": meta, "bytes": len(request.content)})
            if self.speech_mode == "error":
                return error(500, "INTERNAL_ERROR")
            base = {"reference_text": meta["reference_text"], "audio_ms": 1000, "provider": "fake_speech",
                    "cost_usd": 0, "latency_ms": 5, "confidence": None}
            if self.speech_mode == "unavailable":
                return httpx.Response(200, json={**base, "status": "unavailable", "reason": "budget_exceeded",
                                                 "scores": None, "words": [], "intelligibility": None, "tips": []})
            if _amplitude(request.content) < 200:
                return httpx.Response(200, json={**base, "status": "insufficient_evidence", "reason": "low_confidence",
                                                 "scores": None, "words": [], "intelligibility": None, "tips": []})
            words = [{"word": w, "accuracy": 55 if len(w) >= 8 else 90,
                      "error_type": "mispronunciation" if len(w) >= 8 else "none"}
                     for w in re.findall(r"[A-Za-z']+", meta["reference_text"])]
            tips = [{"word": w["word"], "text": f"Слово «{w['word']}» прозвучало неразборчиво."}
                    for w in words if w["error_type"] == "mispronunciation"][:2]
            return httpx.Response(200, json={**base, "status": "ok", "reason": None, "confidence": 0.9,
                                             "scores": {"accuracy": 88, "fluency": 90, "completeness": 100,
                                                        "pron": 87.5},
                                             "words": words, "intelligibility": "clear", "tips": tips})
        m = re.fullmatch(r"/internal/v1/agents/([a-z_]+)/invoke", path)
        assert m, path
        body = json.loads(request.content)
        assert body["user_id"] == sub_
        self.requests.append({"agent": m.group(1), **body})
        if self.gloss_mode == "error":
            return error(500, "INTERNAL_ERROR")
        if self.gloss_mode == "forbidden":
            return error(403, "CALLER_NOT_ALLOWED")
        base = {"agent_id": m.group(1), "agent_version": 2, "prompt_version": "teaching_coach@2",
                "schema_version": "teaching_coach.v2", "model_id": "fake", "canary": False, "cost_usd": 0,
                "latency_ms": 3, "warnings": []}
        if self.gloss_mode in ("unavailable", "refused"):
            return httpx.Response(200, json={**base, "status": self.gloss_mode,
                                             "reason": "ai_disabled" if self.gloss_mode == "unavailable"
                                             else "agent_not_active", "output": None})
        word = body["context"]["word"]
        return httpx.Response(200, json={**base, "status": "ok", "reason": None, "output": {
            "lemma": word, "part_of_speech": "verb", "gloss": {"ru": f"[ru] {word}", "uz": f"[uz] {word}"},
            "forms": [word.lower()], "confidence": 0.3 if self.gloss_mode == "low" else 0.9}})


class FakeIdentity:
    def __init__(self) -> None:
        self.profiles: dict[str, dict[str, Any]] = {}
        self.down = False
        self.calls = 0

    def set(self, user: uuid.UUID, *, age_band: str = "18+", kind: str = "account", voice: bool = False,
            guardian_consent: str = "not_required") -> None:
        purposes = ["terms", "privacy"] + (["voice_recording"] if voice else [])
        self.profiles[str(user)] = {"user_id": str(user), "display_name": "x", "kind": kind, "age_band": age_band,
                                    "guardian_consent": guardian_consent, "status": "ACTIVE",
                                    "consent_accepted": True, "purposes": purposes}

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers.get("x-internal-token")
        self.calls += 1
        if self.down:
            return error(503, "UNAVAILABLE")
        m = re.fullmatch(r"/internal/v1/users/([^/]+)/public", request.url.path)
        assert m
        p = self.profiles.get(m.group(1))
        return httpx.Response(200, json=p) if p else error(404, "USER_NOT_FOUND")


FORBIDDEN_TASK_KEYS = {"answer", "answers", "answers_en", "key", "correct", "target", "display", "distractors",
                       "user_id", "evidence_id", "items"}


def assert_no_keys(obj: Any, path: str = "$") -> None:
    """В задании ученику нет ключа ответа и служебных полей."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            assert k not in FORBIDDEN_TASK_KEYS, f"{path}.{k} leaked"
            assert_no_keys(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            assert_no_keys(v, f"{path}[{i}]")

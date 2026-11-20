"""Перевод по тапу (INTERNAL_API §1.7): словарь курса → общий кеш → teaching_coach `gloss_word`.

1. catalog `glossary/lookup` проверяет, что слово есть в этой опубликованной версии (иначе 422 WORD_NOT_IN_CONTENT,
   черновик/нет версии — 404 CONTENT_NOT_FOUND), и ищет статью. Результат проверки кешируется (версии неизменяемы).
2. Статья course / methodist / ai (не отклонённая, approved или confidence ≥ 0,5) → перевод.
3. Статья отклонена (или ИИ с низкой уверенностью) → «перевода нет» без вызова ИИ.
4. Статьи нет → `teaching_coach` (`gloss_word`, session_kind memory, session_id = uuid5(«memory-gloss»,
   user_id:local_date), deadline 8 с; детям тоже — текста ученика во входе нет, слово из контента) → catalog
   `glossary/ai-entries` (upsert по форме) → перевод с пометкой ИИ. ИИ недоступен / отказ → «перевода нет».
Кеш Redis `gloss:v1:<pair>:<key>` (TTL GLOSS_CACHE_TTL_SECONDS) сбрасывается событием catalog.glossary.changed.v1.
Redis недоступен — без кеша (catalog отвечает сам).
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any

from tilhero_common.app import Runtime
from tilhero_memory import clients
from tilhero_memory.domain.common import local_date, word_not_in_content
from tilhero_memory.domain.context import Ctx
from tilhero_memory.domain.learners import Profile
from tilhero_memory.domain.normalize import find_in_sentence, normalize
from tilhero_memory.settings import Settings

log = logging.getLogger("tilhero.memory.glossary")

GLOSS_NS = uuid.uuid5(uuid.NAMESPACE_URL, "tilhero:memory-gloss")
POS = frozenset({"noun", "verb", "adjective", "adverb", "pronoun", "preposition", "conjunction", "interjection",
                 "determiner", "phrase", "other"})
CONTENT_KINDS = frozenset({"lesson", "media_asset", "reading", "scenario"})
MIN_CONFIDENCE = 0.5


@dataclass
class Resolved:
    entry: dict[str, Any] | None  # статья, которую можно показать ученику
    sentence_en: str | None
    note: dict[str, str] | None = None  # пояснение глоссария текста («фразовый глагол») — из lookup catalog
    surface: str = ""  # слово как в предложении контента (не сырой ввод): для ИИ, статьи ИИ и карточки


def usable(entry: dict[str, Any] | None) -> bool:
    if not isinstance(entry, dict) or entry.get("archived_at"):
        return False
    gloss = entry.get("gloss")
    if not (isinstance(gloss, dict) and isinstance(gloss.get("ru"), str) and isinstance(gloss.get("uz"), str)):
        return False
    source = entry.get("source")
    if source in ("course", "methodist"):
        return True
    if source != "ai":
        return False
    status = entry.get("review_status")
    if status == "rejected":
        return False
    if status == "approved":
        return True
    conf = entry.get("confidence")
    return isinstance(conf, int | float) and not isinstance(conf, bool) and conf >= MIN_CONFIDENCE


def gloss_key(settings: Settings, pair_id: str, key: str) -> str:
    return f"gloss:v1:{settings.gloss_cache_namespace}{pair_id}:{key}"


def _in_content_key(settings: Settings, pair_id: str, ref: dict[str, Any], key: str, audience: str) -> str:
    """Проверка «слово есть в этом тексте» для аудитории (детям недетский контент — 404) — версии неизменяемы."""
    raw = json.dumps([pair_id, ref.get("kind"), ref.get("key"), ref.get("version"), ref.get("locator"), key,
                      audience], ensure_ascii=False)
    return f"gloss:v1:{settings.gloss_cache_namespace}in:{hashlib.sha256(raw.encode()).hexdigest()[:40]}"


async def _cache_get(rt: Runtime, key: str) -> dict[str, Any] | None:
    if rt.redis is None:
        return None
    try:
        raw = await rt.redis.get(key)
    except Exception as exc:
        log.info("gloss cache unavailable", extra={"error_type": type(exc).__name__})
        return None
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


async def _cache_set(rt: Runtime, key: str, value: dict[str, Any], ttl: int) -> None:
    if rt.redis is None:
        return
    try:
        await rt.redis.set(key, json.dumps(value, ensure_ascii=False), ex=ttl)
    except Exception as exc:
        log.info("gloss cache unavailable", extra={"error_type": type(exc).__name__})


async def invalidate(rt: Runtime, settings: Settings, pair_id: str, forms: list[str]) -> int:
    """catalog.glossary.changed.v1: сброс кеша по формам статьи (правка методиста видна сразу)."""
    if rt.redis is None or not forms:
        return 0
    keys = [gloss_key(settings, pair_id, normalize(f)) for f in forms if normalize(f)]
    try:
        return int(await rt.redis.delete(*keys)) if keys else 0
    except Exception as exc:
        log.warning("gloss cache invalidation failed", extra={"error_type": type(exc).__name__})
        return 0


async def _level(ctx: Ctx, ref: dict[str, Any], audience: str) -> str:
    try:
        payload = await ctx.catalog.version(str(ref["kind"]), str(ref["key"]), int(ref["version"]), audience)
    except Exception:  # ContentGone, CATALOG_UNAVAILABLE — уровень по умолчанию
        return "A1"
    level = payload.get("level")
    return level if level in ("A0", "A1", "A2", "B1", "B2") else "A1"


def _clean_output(out: dict[str, Any], text: str) -> dict[str, Any] | None:
    """Вывод gloss_word (ai.ts TeachingCoachGlossOutput) — проверка формы; неверный — как недоступный ИИ."""
    gloss = out.get("gloss")
    conf = out.get("confidence")
    if not (isinstance(gloss, dict) and isinstance(gloss.get("ru"), str) and isinstance(gloss.get("uz"), str)
            and gloss["ru"].strip() and gloss["uz"].strip()):
        return None
    if not isinstance(conf, int | float) or isinstance(conf, bool):
        return None
    raw_lemma = out.get("lemma")
    lemma = raw_lemma if isinstance(raw_lemma, str) and raw_lemma.strip() else text
    pos = out.get("part_of_speech") if out.get("part_of_speech") in POS else "other"
    raw_forms = out.get("forms")
    forms_raw: list[Any] = raw_forms if isinstance(raw_forms, list) else []
    forms = [normalize(f)[:60] for f in forms_raw if isinstance(f, str) and normalize(f)]
    for f in (normalize(text), normalize(lemma)):
        if f and f not in forms:
            forms.insert(0, f)
    return {"lemma": str(lemma)[:60], "part_of_speech": pos,
            "gloss": {"ru": gloss["ru"][:80], "uz": gloss["uz"][:80]},
            "forms": list(dict.fromkeys(forms))[:8], "confidence": max(0.0, min(1.0, float(conf)))}


async def resolve(ctx: Ctx, prof: Profile, text: str, ref: dict[str, Any]) -> Resolved:
    """Статья для слова из контента (или None — «перевода нет»). Ошибки: 422 WORD_NOT_IN_CONTENT,
    404 CONTENT_NOT_FOUND, 503 CATALOG_UNAVAILABLE."""
    key = normalize(text)
    if not key or ref.get("kind") not in CONTENT_KINDS:
        raise word_not_in_content()
    s = ctx.settings
    in_key = _in_content_key(s, prof.pair_id, ref, key, prof.audience)
    g_key = gloss_key(s, prof.pair_id, key)
    cached_in = await _cache_get(ctx.rt, in_key)
    cached_gloss = await _cache_get(ctx.rt, g_key)
    if cached_in is not None and cached_gloss is not None:
        sentence = cached_in.get("sentence_en") if isinstance(cached_in.get("sentence_en"), str) else None
        note = cached_in.get("note") if isinstance(cached_in.get("note"), dict) else None
        entry, blocked = cached_gloss.get("entry"), cached_gloss.get("blocked") is True
    else:
        look = await ctx.catalog.lookup(prof.pair_id, text, ref, prof.audience)
        sentence = look["sentence_en"]
        note = look["note"]
        entry = look["entry"]
        blocked = look["rejected"] or (entry is not None and not usable(entry))
        await _cache_set(ctx.rt, in_key, {"sentence_en": sentence, "note": note}, s.gloss_cache_ttl_seconds)
        if entry is not None or blocked:
            await _cache_set(ctx.rt, g_key, {"entry": entry if usable(entry) else None, "blocked": blocked},
                             s.gloss_cache_ttl_seconds)
    surface = (find_in_sentence(sentence, [text]) if sentence else None) or key
    if usable(entry):
        return Resolved(entry, sentence, note, surface)
    if blocked:
        return Resolved(None, sentence, note, surface)
    return Resolved(await _ai_gloss(ctx, prof, surface[:60], key, ref, sentence), sentence, note, surface)


async def _ai_gloss(ctx: Ctx, prof: Profile, text: str, key: str, ref: dict[str, Any],
                    sentence: str | None) -> dict[str, Any] | None:
    s = ctx.settings
    day = local_date(ctx.now, prof.tz).isoformat()
    session_id = uuid.uuid5(GLOSS_NS, f"{ctx.user_id}:{day}")
    request_id = uuid.uuid5(GLOSS_NS, f"{ctx.user_id}:{day}:{prof.pair_id}:{key}")
    context = {"request": "gloss_word", "word": text[:60], "sentence_en": (sentence or text)[:300],
               "level": await _level(ctx, ref, prof.audience), "content_kind": ref["kind"]}
    res = await clients.invoke_gloss(ctx.rt, request_id=request_id, session_id=session_id, user_id=ctx.user_id,
                                     audience=prof.audience, locale=prof.locale, context=context)
    if res.status != "ok" or res.output is None:
        log.info("gloss_word not available", extra={"status": res.status})
        return None
    out = _clean_output(res.output, text)
    if out is None:
        log.warning("gloss_word output malformed")
        return None
    body = {"pair_id": prof.pair_id, "surface": text[:60], **out, "agent_version": res.agent_version,
            "audience": prof.audience,
            "content_ref": {k: ref[k] for k in ("kind", "key", "version", "locator") if ref.get(k) is not None}}
    entry = await ctx.catalog.ai_entry(body)
    if entry is not None:
        blocked = not usable(entry)
        await _cache_set(ctx.rt, gloss_key(s, prof.pair_id, key),
                         {"entry": None if blocked else entry, "blocked": blocked}, s.gloss_cache_ttl_seconds)
        return None if blocked else entry
    if out["confidence"] < MIN_CONFIDENCE:
        return None
    # catalog не принял статью (сбой) — перевод показываем, но не кешируем: следующий тап повторит запись
    return {"entry_id": None, "lemma": out["lemma"], "part_of_speech": out["part_of_speech"], "gloss": out["gloss"],
            "forms": out["forms"], "source": "ai", "review_status": "pending", "confidence": out["confidence"],
            "example_en": None}


def word_gloss(text: str, entry: dict[str, Any] | None, in_dictionary: uuid.UUID | None,
               note: dict[str, str] | None = None) -> dict[str, Any]:
    """WordGloss (bff.ts); note — пояснение глоссария текста из lookup (иначе — из статьи)."""
    if entry is None:
        return {"text": text, "lemma": None, "part_of_speech": None, "gloss": None, "source": None,
                "ai_unreviewed": False, "note": None, "in_dictionary": str(in_dictionary) if in_dictionary else None,
                "reason": "not_available"}
    note = note or entry.get("note")
    pos = entry.get("part_of_speech")
    return {"text": text, "lemma": entry.get("lemma") if isinstance(entry.get("lemma"), str) else None,
            "part_of_speech": pos if pos in POS else None,
            "gloss": {"ru": entry["gloss"]["ru"], "uz": entry["gloss"]["uz"]},
            "source": entry.get("source"),
            "ai_unreviewed": entry.get("source") == "ai" and entry.get("review_status") == "pending",
            "note": {"ru": note["ru"], "uz": note["uz"]} if isinstance(note, dict) and isinstance(note.get("ru"), str)
            and isinstance(note.get("uz"), str) else None,
            "in_dictionary": str(in_dictionary) if in_dictionary else None, "reason": None}

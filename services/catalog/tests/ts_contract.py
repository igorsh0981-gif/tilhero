"""Разбор интерфейсов TypeScript из packages/contracts/src (регулярки + подсчёт скобок) для контрактных тестов:
поля pydantic-моделей = поля интерфейсов content.ts; ключи ответов API = поля интерфейсов bff.ts / admin.ts."""

from __future__ import annotations

import re
from functools import cache
from pathlib import Path

CONTRACTS = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "src"
_IFACE = re.compile(r"export interface (\w+)(?:<(?:[^<>]|<[^<>]*>)*>)?(?:\s+extends\s+([^{]+?))?\s*\{")
_TYPE = re.compile(r"export type (\w+)\s*=\s*(.*?);", re.S)
_FIELD = re.compile(r"^\s*(\w+)(\?)?\s*:\s*(.*)$", re.S)


def strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


@cache
def source(name: str) -> str:
    return strip_comments((CONTRACTS / name).read_text(encoding="utf-8"))


def _block(src: str, open_at: int) -> tuple[str, int]:
    """Текст между { в позиции open_at и парной }."""
    depth = 0
    for i in range(open_at, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[open_at + 1:i], i
    raise ValueError("unbalanced braces")


def split_fields(body: str) -> dict[str, str]:
    """Поля верхнего уровня тела объекта: имя → текст типа."""
    out: dict[str, str] = {}
    depth, cur = 0, []
    for ch in body + ";":
        if ch in "{<(":
            depth += 1
        elif ch in "}>)":
            depth -= 1
        if (ch == ";" or ch == ",") and depth == 0:
            text = "".join(cur).strip()
            cur = []
            m = _FIELD.match(text)
            if m:
                out[m.group(1)] = m.group(3).strip()
            continue
        cur.append(ch)
    return out


@cache
def interfaces(name: str) -> dict[str, tuple[str, str | None]]:
    """Интерфейс → (тело, extends)."""
    src = source(name)
    out: dict[str, tuple[str, str | None]] = {}
    for m in _IFACE.finditer(src):
        body, _ = _block(src, m.end() - 1)
        out[m.group(1)] = (body, m.group(2).strip() if m.group(2) else None)
    return out


def fields(name: str, iface: str) -> dict[str, str]:
    """Поля интерфейса с учётом простого `extends X` (X — интерфейс этого или content.ts файла)."""
    body, parent = interfaces(name)[iface]
    own = split_fields(body)
    if parent is None:
        return own
    base = re.match(r"^(\w+)(?:<[^>]*>)?$", parent.strip())
    if base is None:
        raise ValueError(f"unsupported extends: {parent}")
    pname = base.group(1)
    for file in (name, "content.ts"):
        if pname in interfaces(file):
            return {**fields(file, pname), **own}
    raise KeyError(pname)


def inline_object(type_text: str) -> dict[str, str] | None:
    """Поля встроенного объектного типа ({…}, Array<{…}>, {…} | null)."""
    start = type_text.find("{")
    if start < 0:
        return None
    body, _ = _block(type_text, start)
    return split_fields(body)


def literals(type_text: str) -> set[str | int] | None:
    """Значения объединения литералов ("a" | "b", 10 | 20, Array<"x" | "y">), иначе None."""
    text = type_text.strip()
    text = re.sub(r"\|\s*null\s*$", "", text).strip()
    m = re.fullmatch(r"Array<(.*)>", text, flags=re.S)
    if m:
        text = m.group(1).strip()
    parts = [p.strip() for p in text.split("|") if p.strip()]
    out: set[str | int] = set()
    for p in parts:
        if re.fullmatch(r'"[^"]*"', p):
            out.add(p[1:-1])
        elif re.fullmatch(r"\d+", p):
            out.add(int(p))
        else:
            return None
    return out or None


@cache
def type_aliases(name: str) -> dict[str, set[str]]:
    """export type X = "a" | "b" → {X: {a, b}} (только объединения строковых литералов)."""
    out: dict[str, set[str]] = {}
    for m in _TYPE.finditer(source(name)):
        values = literals(m.group(2))
        if values and all(isinstance(v, str) for v in values):
            out[m.group(1)] = {str(v) for v in values}
    return out

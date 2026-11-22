"""Модели billing — зеркало миграций (тест schema_drift): таблицы INTERNAL_API спринта 8 §1.1 добавляет поток A
миграцией 0001 (UNIQUE, индексы и CHECK — и в `__table_args__`). Таблицы без схемы (search_path = `billing`).

Деньги — только целые (ADR-0001): тийины `BigInteger` (`amount_tiyin`, `price_tiyin`), Stars `Integer`
(`amount_stars`, `price_stars`); `Numeric` и float для денег не используются.
"""

from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass

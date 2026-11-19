"""Версии тестов: выбор опубликованного теста для (пара, аудитория) и разбор строки в TestDef с кешем.

Опубликованная/архивная версия неизменяема (триггер tests_guard), поэтому разобранный тест кешируется по
(test_id, version, checksum) — без повторной проверки 90 заданий на каждый запрос.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_diagnostics.models import Test
from tilhero_diagnostics.testdef import TestDef, from_row

_CACHE: dict[tuple[str, int, str], TestDef] = {}
_CACHE_LIMIT = 64


def parse(row: Test) -> TestDef:
    key = (row.test_id, row.version, row.checksum)
    test = _CACHE.get(key)
    if test is None:
        test = from_row(row.test_id, row.version, row.pair_id, row.audience, row.config, row.items)
        if len(_CACHE) >= _CACHE_LIMIT:
            _CACHE.clear()
        _CACHE[key] = test
    return test


async def published(session: AsyncSession, pair_id: str, audience: str) -> TestDef | None:
    row = (await session.execute(
        select(Test).where(Test.pair_id == pair_id, Test.audience == audience, Test.status == "published")
    )).scalar_one_or_none()
    return parse(row) if row is not None else None


async def by_version(session: AsyncSession, test_id: str, version: int) -> TestDef:
    row = await session.get(Test, (test_id, version))
    if row is None:  # сессия ссылается на тест по FK — недостижимо
        raise LookupError(f"test {test_id}@{version} not found")
    return parse(row)

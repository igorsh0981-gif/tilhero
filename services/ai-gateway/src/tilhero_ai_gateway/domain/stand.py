"""Публикация версий сида на dev/e2e-стенде (INTERNAL_API §3.1, спринт 5): «v2 на стенде — через прогон на fake».

Миграция-накладка может создать версию черновиком (0004: `teaching_coach` v2 с `gloss_word`). В stage/prod её
публикует сотрудник после прогона золотых тестов на anthropic (`POST …/test-runs` → `POST …/publish`). На стенде
(`AI_ALLOW_FAKE_TEST_PUBLISH=true` — только ENV dev|test — и провайдер `fake`) это делает сам шлюз при старте: для
каждого черновика автора seed — обычный прогон золотых тестов на fake (запись test_runs, аудит `ai.test_run`) и, если
обязательные кейсы пройдены, обычная публикация (`ai.version_published`); автор — системный seed (actor_type system).
Ошибка не мешает старту сервиса (предупреждение в лог); черновики сотрудников не трогаются.
"""

from __future__ import annotations

import logging
from typing import Final

from sqlalchemy import select

from tilhero_ai_gateway.domain import golden, versions
from tilhero_ai_gateway.domain.common import AI_MANAGE, AI_PUBLISH, SEED_ACTOR_ID
from tilhero_ai_gateway.domain.invoke import Deps
from tilhero_ai_gateway.models import AgentVersion, TestRunRow
from tilhero_common.errors import ApiError
from tilhero_common.internal_auth import Actor

log = logging.getLogger("tilhero.ai_gateway.stand")
SEED_ACTOR: Final = Actor(id=SEED_ACTOR_ID, role="system", permissions=frozenset({AI_MANAGE, AI_PUBLISH}))
REASON: Final = "Стенд: публикация версии сида по прогону золотых тестов на fake"


def enabled(deps: Deps) -> bool:
    return deps.settings.ai_allow_fake_test_publish and deps.settings.env in ("dev", "test") \
        and deps.provider.name == "fake"


async def publish_seed_drafts(deps: Deps) -> dict[str, bool]:
    """{"agent_id@version": опубликована} для черновиков автора seed (пусто — не стенд или черновиков нет)."""
    if not enabled(deps):
        return {}
    async with deps.rt.transaction() as s:
        drafts = (await s.execute(select(AgentVersion.agent_id, AgentVersion.version).where(
            AgentVersion.status == "draft", AgentVersion.author_id == SEED_ACTOR_ID)
            .order_by(AgentVersion.agent_id))).all()
    out: dict[str, bool] = {}
    for agent_id, version in drafts:
        key = f"{agent_id}@{version}"
        out[key] = False
        try:
            async with deps.rt.transaction() as s:
                run = await versions.start_test_run(s, agent_id, version, SEED_ACTOR, deps.provider.name,
                                                    deps.clock(), daily_limit=deps.settings.golden_runs_daily_limit,
                                                    tz=deps.settings.timezone)
                run_id = run.run_id
            await golden.execute_run(deps, run_id)
            async with deps.rt.transaction() as s:
                finished = await s.get(TestRunRow, run_id)
                if finished is None or not finished.passed_mandatory:
                    log.warning("seed draft not published on stand: mandatory golden cases failed",
                                extra={"agent_id": agent_id, "agent_version": version})
                    continue
                await versions.publish(s, agent_id, version, REASON, SEED_ACTOR, deps.clock(),
                                       deps.settings.golden_run_max_age_days, deps.settings.publish_providers)
            out[key] = True
            log.info("seed draft published on stand", extra={"agent_id": agent_id, "agent_version": version})
        except ApiError as exc:
            log.warning("seed draft not published on stand", extra={"agent_id": agent_id, "agent_version": version,
                                                                     "code": exc.code})
    return out

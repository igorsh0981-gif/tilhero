from __future__ import annotations

import uuid


async def test_smoke(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    page = await env.get(user, "cards?limit=100")
    assert len(page["items"]) == 10
    s = await env.start(user)
    assert s["new_cards"] == 5 and s["total_tasks"] == 10
    results = await env.play(user, s["session_id"])
    assert len(results) == 10
    summary = await env.post(user, f"review-sessions/{s['session_id']}/finish")
    assert summary["status"] == "completed" and summary["reviewed"] == 5
    [ev] = await env.events("memory.review.completed.v1", user)
    assert ev.payload["reviewed"] == 5

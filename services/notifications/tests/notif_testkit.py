"""Помощники тестов notifications: фейковые identity-consent (/delivery, /public) и telegram-bot-gateway
(httpx.MockTransport), публикация событий спринта 1 (с проверкой по контрактам), чтение центра."""

from __future__ import annotations

import itertools
import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import jwt
from sqlalchemy import select

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import Envelope, InMemoryBus, make_envelope
from tilhero_common.testing import assert_event_conforms, internal_headers
from tilhero_notifications.dispatcher import Dispatcher
from tilhero_notifications.models import Notification
from tilhero_notifications.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
SCHEDULER_TOKEN = "sched-" + "n" * 40
TZ = "Asia/Tashkent"
ALL_CATEGORIES = ("reminders", "missed", "social", "support", "product")
TEST_CHATS = "5550001111,5550002222"
STAFF_ID = "0b6e2c1a-8d3f-4b7e-9a51-6c2d8e4f1a30"
COMMS_PERMISSIONS = frozenset({
    "dashboard.read", "whatsnew.manage", "whatsnew.publish", "notif.templates.manage", "notif.campaigns.manage",
    "notif.campaigns.send",
})


def api_error(status: int, code: str, details: dict | None = None) -> httpx.Response:
    return httpx.Response(status, json={"code": code, "message": "x", "trace_id": "t", "details": details or {}})


def local_day(offset: int = 1, tz: str = TZ) -> date:
    """Местная дата через `offset` дней (по умолчанию завтра — «сейчас» тестов всегда в будущем: записи журнала
    создаются с реальным временем и захватываются только при scheduled_for ≤ now)."""
    return datetime.now(UTC).astimezone(ZoneInfo(tz)).date() + timedelta(days=offset)


def quiet_around_now(tz: str = TZ) -> dict[str, str]:
    """Тихие часы, внутри которых сейчас реальное местное время (за час до и два часа после)."""
    local = datetime.now(UTC).astimezone(ZoneInfo(tz))
    return {
        "start": (local - timedelta(hours=1)).strftime("%H:%M"),
        "end": (local + timedelta(hours=2)).strftime("%H:%M"),
    }


def at(day: date, hhmm: str, tz: str = TZ) -> datetime:
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime.combine(day, time(h, m), tzinfo=ZoneInfo(tz)).astimezone(UTC)


@dataclass
class FakeIdentity:
    delivery: dict[str, dict[str, Any]] = field(default_factory=dict)
    public: dict[str, dict[str, Any]] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)
    fail: list[int] = field(default_factory=list)
    # Аудитория рассылок (контракт identity-consent `/internal/v1/audience[/count]`, INTERNAL_API спринта 2 §3):
    # список {user_id, locale}; фейк фильтрует только по ui_lang — остальное отбор identity-consent (здесь — как есть)
    audience: list[dict[str, Any]] = field(default_factory=list)
    audience_queries: list[dict[str, str]] = field(default_factory=list)
    audience_fail: list[Any] = field(default_factory=list)  # статус или (статус, код, details)

    def _audience(self, request: httpx.Request) -> httpx.Response:
        """Контракт identity-consent (координатор, 18.11): вызывающий — только notifications, без sub; age по
        умолчанию adults, kids → 422; limit 1..500; active_days ±1..90; ошибка сегмента → 422 SEGMENT_INVALID
        {field, reason}."""
        params = dict(request.url.params)
        self.audience_queries.append({"path": request.url.path, **params})
        claims = jwt.decode(request.headers["x-internal-token"], options={"verify_signature": False})
        assert claims["iss"] == "notifications" and claims["aud"] == "identity-consent" and "sub" not in claims
        assert "actor" not in claims
        if self.audience_fail:
            item = self.audience_fail.pop(0)
            if isinstance(item, tuple):
                return api_error(*item)
            return api_error(item, "UPSTREAM")
        allowed = {"ui_lang", "age", "onboarded", "active_days", "cursor", "limit"}
        if request.url.path.endswith("/count"):
            allowed -= {"cursor", "limit"}
        for name in params:
            if name not in allowed:
                return api_error(422, "VALIDATION_ERROR")
        ages = set((params.get("age") or "adults").split(","))
        if not ages <= {"teens", "adults"}:
            return api_error(422, "SEGMENT_INVALID", {"field": "age", "reason": "kids_not_allowed"
                                                      if "kids" in ages else "invalid"})
        if params.get("ui_lang") and not set(params["ui_lang"].split(",")) <= {"ru", "uz"}:
            return api_error(422, "SEGMENT_INVALID", {"field": "ui_lang", "reason": "invalid"})
        if params.get("onboarded") not in (None, "true", "false"):
            return api_error(422, "SEGMENT_INVALID", {"field": "onboarded", "reason": "invalid"})
        if params.get("active_days") is not None and not 1 <= abs(int(params["active_days"])) <= 90:
            return api_error(422, "SEGMENT_INVALID", {"field": "active_days", "reason": "out_of_range"})
        if "limit" in params and not 1 <= int(params["limit"]) <= 500:
            return api_error(422, "VALIDATION_ERROR")
        langs = set(params["ui_lang"].split(",")) if params.get("ui_lang") else {"ru", "uz"}
        items = [a for a in self.audience if a["locale"] in langs]
        if request.url.path.endswith("/count"):
            by_lang = {lang: sum(1 for a in items if a["locale"] == lang) for lang in ("ru", "uz")}
            return httpx.Response(200, json={"count": len(items), "by_lang": by_lang})
        start, limit = int(params.get("cursor") or 0), int(params.get("limit") or 500)
        page = items[start:start + limit]
        next_cursor = str(start + limit) if start + limit < len(items) else None
        return httpx.Response(200, json={"items": page, "next_cursor": next_cursor})

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request.url.path)
        if request.url.path.startswith("/internal/v1/audience"):
            return self._audience(request)
        _, _, _, _, user_id, kind = request.url.path.split("/")
        if self.fail:
            return api_error(self.fail.pop(0), "UPSTREAM")
        table = self.delivery if kind == "delivery" else self.public
        if user_id not in table:
            return api_error(404, "USER_NOT_FOUND")
        return httpx.Response(200, json=table[user_id])


@dataclass
class FakeGateway:
    calls: list[dict[str, Any]] = field(default_factory=list)
    headers: list[dict[str, str]] = field(default_factory=list)
    queue: list[Any] = field(default_factory=list)
    _ids: Any = field(default_factory=lambda: itertools.count(9001))

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/internal/v1/messages"
        self.calls.append(json.loads(request.content))
        self.headers.append(dict(request.headers))
        if self.queue:
            item = self.queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        return httpx.Response(200, json={"message_id": next(self._ids)})

    def to(self, telegram_user_id: int) -> list[dict[str, Any]]:
        return [c for c in self.calls if c["telegram_user_id"] == telegram_user_id]


@dataclass
class NotifEnv:
    settings: Settings
    client: httpx.AsyncClient
    runtime: Runtime
    bus: InMemoryBus
    identity: FakeIdentity
    gateway: FakeGateway
    dispatcher: Dispatcher
    accept: Any = None  # app.state.accept — общий приём записи журнала
    _tg: Any = field(default_factory=lambda: itertools.count(918273645))

    # ---------------------------------------------------------------- пользователи (identity-consent)

    def add_user(
        self,
        *,
        locale: str = "ru",
        enabled: bool = True,
        categories: tuple[str, ...] = ALL_CATEGORIES,
        quiet: dict[str, str] | None = None,
        tz: str = TZ,
        status: str = "ACTIVE",
        name: str = "Алишер",
        age_band: str | None = "18+",
    ) -> uuid.UUID:
        user_id = uuid.uuid4()
        self.identity.delivery[str(user_id)] = {
            "user_id": str(user_id),
            "kind": "account",
            "recipient_telegram_user_id": next(self._tg),
            "recipient_is_guardian": False,
            "learner_display_name": name,
            "locale": locale,
            "age_band": age_band,
            "is_minor": age_band in ("6-9", "10-13", "14-17"),
            "notifications_enabled": enabled,
            "categories": list(categories),
            "quiet_hours": quiet,
            "timezone": tz,
            "status": status,
        }
        self.identity.public[str(user_id)] = {
            "user_id": str(user_id),
            "display_name": name,
            "kind": "account",
            "age_band": age_band,
            "status": status,
        }
        return user_id

    def add_child(
        self, guardian: uuid.UUID, *, name: str = "Мадина", age_band: str = "6-9", **kw: Any
    ) -> uuid.UUID:
        g = self.identity.delivery[str(guardian)]
        child = self.add_user(name=name, age_band=age_band, locale=kw.pop("locale", g["locale"]), **kw)
        self.identity.delivery[str(child)].update(
            kind="child",
            recipient_telegram_user_id=g["recipient_telegram_user_id"],
            recipient_is_guardian=True,
            is_minor=True,
        )
        self.identity.public[str(child)]["kind"] = "child"
        return child

    def to_audience(self, *users: uuid.UUID) -> None:
        for user in users:
            self.identity.audience.append({"user_id": str(user), "locale": self.identity.delivery[str(user)]["locale"]})

    def telegram_id(self, user_id: uuid.UUID) -> int:
        return int(self.identity.delivery[str(user_id)]["recipient_telegram_user_id"])

    def set(self, user_id: uuid.UUID, **values: Any) -> None:
        self.identity.delivery[str(user_id)].update(values)

    # ---------------------------------------------------------------- события

    async def publish(self, event_type: str, payload: dict[str, Any], producer: str = "identity-consent") -> Envelope:
        env = make_envelope(event_type, payload, producer=producer)
        assert_event_conforms(env)
        await self.bus.publish(env)
        return env

    async def reminder(
        self,
        user: uuid.UUID,
        day: date,
        slot: str = "10:00",
        *,
        duration: int = 15,
        streak: int | None = None,
        tz: str = TZ,
    ) -> Envelope:
        return await self.publish(
            "learning.reminder.due.v1",
            {
                "user_id": str(user),
                "local_date": day.isoformat(),
                "slot_time": slot,
                "timezone": tz,
                "duration_min": duration,
                "streak_days": streak,
            },
            producer="learning-plan",
        )

    async def missed(
        self,
        user: uuid.UUID,
        day: date,
        slot: str = "10:00",
        *,
        consecutive: int = 1,
        next_slot: date | None = None,
        tz: str = TZ,
    ) -> Envelope:
        return await self.publish(
            "learning.session.missed.v1",
            {
                "user_id": str(user),
                "local_date": day.isoformat(),
                "slot_time": slot,
                "timezone": tz,
                "consecutive_missed": consecutive,
                "next_slot_date": next_slot.isoformat() if next_slot else None,
            },
            producer="learning-plan",
        )

    async def invite(
        self,
        action: str,
        inviter: uuid.UUID,
        invitee: uuid.UUID,
        *,
        kind: str = "friend",
        invite_id: uuid.UUID | None = None,
    ) -> uuid.UUID:
        invite_id = invite_id or uuid.uuid4()
        payload: dict[str, Any] = {
            "invite_id": str(invite_id),
            "inviter_user_id": str(inviter),
            "invitee_user_id": str(invitee),
            "kind": kind,
        }
        if action in ("accepted", "declined"):
            payload[f"{action}_at"] = "2026-11-18T10:00:00Z"
        await self.publish(f"social.invite.{action}.v1", payload, producer="social")
        return invite_id

    async def member_added(self, family: uuid.UUID, user: uuid.UUID, role: str,
                           owner: uuid.UUID | None = None) -> Envelope:
        owner = owner or (user if role == "owner" else None)
        assert owner is not None, "owner_user_id обязателен в social.family.member_added.v1"
        return await self.publish(
            "social.family.member_added.v1",
            {"family_id": str(family), "owner_user_id": str(owner), "user_id": str(user), "role": role,
             "added_at": "2026-11-18T10:00:00Z"},
            producer="social",
        )

    async def reply_event(
        self, user: uuid.UUID, number: str = "TCK-3081", message_id: uuid.UUID | None = None
    ) -> Envelope:
        return await self.publish(
            "support.ticket.replied.v1",
            {
                "ticket_id": str(uuid.uuid4()),
                "number": number,
                "user_id": str(user),
                "message_id": str(message_id or uuid.uuid4()),
                "sender_type": "operator",
                "replied_at": "2026-11-18T10:00:00Z",
            },
            producer="support",
        )

    async def release_note(
        self, *, audience: str = "existing", segments: dict[str, Any] | None = None
    ) -> uuid.UUID:
        note = uuid.uuid4()
        await self.publish(
            "experience.release_note.published.v1",
            {
                "release_note_id": str(note),
                "slug": "2026.11",
                "audience": audience,
                "segments": segments,
                "published_at": "2026-11-18T10:00:00Z",
            },
            producer="experience-config",
        )
        return note

    async def delete(self, user: uuid.UUID, request_id: uuid.UUID | None = None) -> Envelope:
        return await self.publish(
            "user.deletion.requested.v1",
            {
                "user_id": str(user),
                "request_id": str(request_id or uuid.uuid4()),
                "requested_at": "2026-11-18T10:00:00Z",
            },
        )

    # ---------------------------------------------------------------- HTTP

    async def transactional(
        self,
        user_id: uuid.UUID,
        code: str = "482913",
        *,
        notification_id: uuid.UUID | None = None,
        dedup_key: str | None = None,
        issuer: str = "identity-consent",
        params: dict[str, Any] | None = None,
        template: str = "pin.reset_code",
    ) -> httpx.Response:
        nid = notification_id or uuid.uuid4()
        return await self.client.post(
            "/internal/v1/notifications/transactional",
            json={
                "notification_id": str(nid),
                "user_id": str(user_id),
                "template": template,
                "params": params if params is not None else {"code": code},
                "dedup_key": dedup_key or f"pin_reset:{nid}",
            },
            headers=internal_headers(self.settings, issuer=issuer),
        )

    def staff(
        self,
        *permissions: str,
        staff_id: str | None = None,
        issuer: str = "admin-bff",
        role: str = "communications",
        with_actor: bool = True,
    ) -> dict[str, str]:
        """Заголовки admin-bff с контекстом сотрудника (по умолчанию — все права коммуникаций)."""
        perms = frozenset(permissions) if permissions else COMMS_PERMISSIONS
        actor = Actor(id=staff_id or STAFF_ID, role=role, permissions=perms, name="Оператор") if with_actor else None
        return internal_headers(self.settings, issuer=issuer, actor=actor if issuer == "admin-bff" else None)

    async def audit(self, action: str | None = None) -> list[dict[str, Any]]:
        records = [e.payload for e in await self.events("admin.audit.recorded.v1")]
        return [r for r in records if action is None or r["action"] == action]

    def bff(self, user: uuid.UUID | str | None, issuer: str = "telegram-bff") -> dict[str, str]:
        return internal_headers(self.settings, issuer=issuer, subject=str(user) if user else None)

    async def inbox(self, user: uuid.UUID, **params: Any) -> dict[str, Any]:
        r = await self.client.get("/internal/v1/me/inbox", params=params, headers=self.bff(user))
        assert r.status_code == 200, r.text
        return r.json()

    async def unread(self, user: uuid.UUID) -> int:
        r = await self.client.get("/internal/v1/me/inbox/unread-count", headers=self.bff(user))
        assert r.status_code == 200, r.text
        return int(r.json()["unread"])

    async def read(self, user: uuid.UUID, body: dict[str, Any]) -> httpx.Response:
        return await self.client.post("/internal/v1/me/inbox:read", json=body, headers=self.bff(user))

    # ---------------------------------------------------------------- журнал

    async def dispatch(self, now: datetime | None = None) -> int:
        return sum((await self.dispatcher.run_once(now)).values())

    async def rows(self, user_id: uuid.UUID | None = None) -> list[Notification]:
        async with self.runtime.transaction() as s:
            stmt = select(Notification).order_by(Notification.created_at)
            if user_id:
                stmt = stmt.where(Notification.user_id == user_id)
            return list((await s.execute(stmt)).scalars().all())

    async def row(self, notification_id: uuid.UUID) -> Notification:
        async with self.runtime.transaction() as s:
            return (
                await s.execute(select(Notification).where(Notification.notification_id == notification_id))
            ).scalar_one()

    async def one(self, user_id: uuid.UUID) -> Notification:
        [row] = await self.rows(user_id)
        return row

    async def events(self, event_type: str) -> list[Envelope]:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()
        return self.bus.of_type(event_type)

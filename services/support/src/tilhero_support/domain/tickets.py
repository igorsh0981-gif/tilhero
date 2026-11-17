"""Бизнес-правила обращений (без FastAPI): создание, переписка, статусы, staff-команды, обезличивание.

Инварианты:
- клиент видит только свои обращения (user_id из токена) и только публичные сообщения;
- внутренние заметки не попадают ни в клиентский API, ни в события, ни в уведомления (TG-FR-044, A-AT-42);
- support не делает refund/override — только эскалации (BR-TG-011);
- команды одного пользователя сериализуются advisory-lock'ом: лимиты и Idempotency-Key без гонок.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, cast

from sqlalchemy import ColumnElement, DateTime, Integer, func, literal, select, text, tuple_, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, not_found, too_many, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_common.redis_tools import fingerprint
from tilhero_support.domain import events
from tilhero_support.domain import sla as sla_rules
from tilhero_support.domain.constants import (
    ANONYMIZED_TEXT,
    CATEGORIES,
    CLOSED,
    DEFAULT_PRIORITY,
    IN_PROGRESS,
    NEW,
    OPEN_STATUSES,
    RESOLVED,
    SENDER_OPERATOR,
    SENDER_SYSTEM,
    SENDER_USER,
    STAFF_TRANSITIONS,
    VISIBILITY_PUBLIC,
    WAITING_CUSTOMER,
    default_priority,
    ticket_number,
)
from tilhero_support.domain.pagination import decode_cursor, encode_cursor
from tilhero_support.models import DeletedUser, Escalation, Message, SlaPolicy, StatusHistory, Ticket
from tilhero_support.schemas import (
    CreateTicketIn,
    EscalationIn,
    EscalationOut,
    SlaPoliciesOut,
    SlaPoliciesPut,
    SlaPolicyOut,
    StaffMessageIn,
    StaffMessageOut,
    StaffPatchIn,
    StaffStatusPoint,
    StaffTicketOut,
    StaffTicketSummaryOut,
    StatusPoint,
    SupportStatsOut,
    TicketContextOut,
    TicketMessageOut,
    TicketOut,
    TicketStatus,
    TicketSummaryOut,
    Visibility,
)

LOCK_CLASS = 7_340_103  # пространство advisory-lock'ов support (вторая половина ключа — hashtext(user_id))
_REF_NUMBER = re.compile(r"^TCK-(\d{1,12})$")


def utcnow() -> datetime:
    return datetime.now(UTC)


def ticket_not_found() -> ApiError:
    return not_found("SUPPORT_TICKET_NOT_FOUND", "Обращение не найдено")


async def lock_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:c, hashtext(:u))"), {"c": LOCK_CLASS, "u": str(user_id)}
    )


def user_deleted() -> ApiError:
    return ApiError(410, "USER_DELETED", "Профиль удалён по запросу пользователя")


async def ensure_not_deleted(session: AsyncSession, user_id: uuid.UUID) -> None:
    """После обезличивания (TG-FR-006) данные пользователя больше не принимаются: иначе новое обращение
    осталось бы с user_id навсегда — сага удаления уже подтверждена (ревью P3). Вызывать под lock_user."""
    if await session.get(DeletedUser, user_id) is not None:
        raise user_deleted()


async def lock_active_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    """Блокировка команд пользователя + проверка, что он не удалён (сериализуется с anonymize_user)."""
    await lock_user(session, user_id)
    await ensure_not_deleted(session, user_id)


def ref_condition(ref: str) -> ColumnElement | None:
    """Обращение адресуется UUID или номером «TCK-3081» (deep link startapp=ticket_TCK-3081)."""
    try:
        return Ticket.ticket_id == uuid.UUID(ref)
    except ValueError:
        pass
    m = _REF_NUMBER.match(ref)
    if m:
        return Ticket.number == int(m.group(1))
    return None


async def load_ticket(
    session: AsyncSession, ref: str, *, user_id: uuid.UUID | None = None, for_update: bool = False
) -> Ticket:
    cond = ref_condition(ref)
    if cond is None:
        raise ticket_not_found()
    stmt = select(Ticket).where(cond)
    if user_id is not None:
        # Изоляция пользователей: чужое обращение неотличимо от несуществующего (404, не 403)
        stmt = stmt.where(Ticket.user_id == user_id)
    if for_update:
        stmt = stmt.with_for_update()
    ticket = (await session.execute(stmt)).scalar_one_or_none()
    if ticket is None:
        raise ticket_not_found()
    return ticket


def first_name(name: str | None) -> str | None:
    """Клиент видит имя оператора без фамилии («Алина»)."""
    if not name or not name.strip():
        return None
    return name.strip().split()[0][:40]


async def _change_status(
    session: AsyncSession,
    ticket: Ticket,
    to_status: str,
    *,
    by: str,
    actor_id: str | None,
    now: datetime,
    producer: str,
) -> None:
    from_status = ticket.status
    ticket.status = to_status
    if to_status == RESOLVED:
        ticket.resolved_at = now
    elif from_status == RESOLVED:
        ticket.resolved_at = None  # переоткрыто
    if to_status == CLOSED:
        ticket.closed_at = now
    ticket.updated_at = now
    session.add(
        StatusHistory(
            ticket_id=ticket.ticket_id,
            from_status=from_status,
            to_status=to_status,
            changed_by=by,
            actor_id=actor_id,
            created_at=now,
        )
    )
    await events.status_changed(session, ticket, from_status, changed_by=by, producer=producer)


async def _check_message_rate(session: AsyncSession, user_id: uuid.UUID, now: datetime, limit: int) -> None:
    since = now - timedelta(hours=1)
    count, oldest = (
        await session.execute(
            select(func.count(), func.min(Message.created_at))
            .select_from(Message)
            .join(Ticket, Ticket.ticket_id == Message.ticket_id)
            .where(Ticket.user_id == user_id, Message.sender_type == SENDER_USER, Message.created_at > since)
        )
    ).one()
    if count >= limit:
        retry_after = max(1, int((oldest + timedelta(hours=1) - now).total_seconds()) + 1)
        raise too_many("SUPPORT_RATE_LIMITED", "Слишком много сообщений. Попробуйте позже", retry_after)


def _context_for_storage(body: CreateTicketIn) -> dict[str, Any] | None:
    if body.context is None:
        return None
    data = body.context.model_dump(exclude_none=True)
    snap = data.get("price_snapshot")
    if snap is not None:
        # Деньги — строкой с 2 знаками (Decimal без потери точности), время — ISO-8601 UTC
        snap["amount"] = str(Decimal(snap["amount"]).quantize(Decimal("0.01")))
        snap["fetched_at"] = events.iso(snap["fetched_at"])
    return data


# ================================================================ client commands


async def create_ticket(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    body: CreateTicketIn,
    idempotency_key: str,
    channel: str,
    correlation_id: str | None,
    producer: str,
    max_open: int,
    max_messages_per_hour: int,
    now: datetime | None = None,
) -> tuple[Ticket, bool]:
    """→ (обращение, replayed). Повтор с тем же Idempotency-Key — то же обращение без побочных эффектов."""
    now = now or utcnow()
    request_fp = fingerprint(body.model_dump(mode="json"))
    await lock_active_user(session, user_id)
    existing = (
        await session.execute(
            select(Ticket).where(Ticket.user_id == user_id, Ticket.idempotency_key == idempotency_key)
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.request_fingerprint != request_fp:
            raise unprocessable(
                "IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными"
            )
        return existing, True

    meta = CATEGORIES.get(body.category)
    if meta is None or not meta["available"]:
        raise unprocessable(
            "SUPPORT_CATEGORY_INVALID", "Категория обращения недоступна", {"category": body.category[:40]}
        )
    open_count = (
        await session.execute(
            select(func.count())
            .select_from(Ticket)
            .where(Ticket.user_id == user_id, Ticket.status.in_(OPEN_STATUSES))
        )
    ).scalar_one()
    if open_count >= max_open:
        raise ApiError(
            429,
            "SUPPORT_TOO_MANY_OPEN",
            "Слишком много незакрытых обращений. Закройте решённые или дождитесь ответа",
            {"limit": max_open},
        )
    await _check_message_rate(session, user_id, now, max_messages_per_hour)

    priority = default_priority(body.category)
    first_due, resolution_due = sla_rules.deadlines(
        now, await sla_rules.resolve_policy(session, body.category, priority)
    )
    number = (await session.execute(select(func.nextval("ticket_number_seq")))).scalar_one()
    ticket = Ticket(
        ticket_id=uuid.uuid4(),
        number=number,
        user_id=user_id,
        channel=channel,
        category=body.category,
        subject=body.subject,
        status=NEW,
        priority=priority,
        assignee_id=None,
        idempotency_key=idempotency_key,
        request_fingerprint=request_fp,
        context=_context_for_storage(body),
        correlation_id=(correlation_id or "")[:64] or None,
        sla_first_response_at=first_due,
        sla_resolution_at=resolution_due,
        created_at=now,
        updated_at=now,
        last_message_at=now,
        user_unread_operator_replies=0,
    )
    session.add(ticket)
    await session.flush()
    session.add(
        Message(
            message_id=uuid.uuid4(),
            ticket_id=ticket.ticket_id,
            sender_type=SENDER_USER,
            visibility=VISIBILITY_PUBLIC,
            author_id=None,
            author_name=None,
            text=body.message,
            created_at=now,
        )
    )
    session.add(
        StatusHistory(
            ticket_id=ticket.ticket_id,
            from_status=None,
            to_status=NEW,
            changed_by=SENDER_USER,
            actor_id=None,
            created_at=now,
        )
    )
    await events.ticket_created(session, ticket, producer=producer)
    return ticket, False


async def list_user_tickets(
    session: AsyncSession, user_id: uuid.UUID, *, limit: int, cursor: str | None
) -> tuple[list[Ticket], str | None]:
    await ensure_not_deleted(session, user_id)
    stmt = select(Ticket).where(Ticket.user_id == user_id).order_by(Ticket.number.desc()).limit(limit + 1)
    if cursor:
        try:
            stmt = stmt.where(Ticket.number < int(decode_cursor(cursor, {"n"})["n"]))
        except (TypeError, ValueError) as exc:
            raise decode_cursor_error() from exc
    rows = list((await session.execute(stmt)).scalars().all())
    next_cursor = encode_cursor({"n": rows[limit - 1].number}) if len(rows) > limit else None
    return rows[:limit], next_cursor


async def open_user_ticket(session: AsyncSession, user_id: uuid.UUID, ref: str) -> Ticket:
    """GET обращения клиентом: ответы оператора отмечаются прочитанными (bff.ts)."""
    await ensure_not_deleted(session, user_id)
    ticket = await load_ticket(session, ref, user_id=user_id, for_update=True)
    if ticket.user_unread_operator_replies:
        ticket.user_unread_operator_replies = 0
    return ticket


async def add_user_message(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    ref: str,
    text_: str,
    client_key: str | None,
    producer: str,
    max_messages_per_hour: int,
    now: datetime | None = None,
) -> Ticket:
    now = now or utcnow()
    await lock_active_user(session, user_id)
    ticket = await load_ticket(session, ref, user_id=user_id, for_update=True)
    if client_key and await _message_exists(session, ticket.ticket_id, client_key):
        return ticket  # повтор той же отправки
    if ticket.status == CLOSED:
        raise conflict("SUPPORT_TICKET_CLOSED", "Обращение закрыто. Создайте новое, если вопрос остался")
    await _check_message_rate(session, user_id, now, max_messages_per_hour)
    session.add(
        Message(
            message_id=uuid.uuid4(),
            ticket_id=ticket.ticket_id,
            sender_type=SENDER_USER,
            visibility=VISIBILITY_PUBLIC,
            text=text_,
            client_key=client_key,
            created_at=now,
        )
    )
    ticket.last_message_at = now
    ticket.updated_at = now
    # Ответ клиента возвращает мяч поддержке
    if ticket.status in (WAITING_CUSTOMER, RESOLVED):
        await _change_status(
            session, ticket, IN_PROGRESS, by=SENDER_USER, actor_id=None, now=now, producer=producer
        )
    return ticket


async def close_by_user(
    session: AsyncSession, *, user_id: uuid.UUID, ref: str, producer: str, now: datetime | None = None
) -> Ticket:
    """Клиент может закрыть обращение в любой момент; повторное закрытие — без изменений."""
    now = now or utcnow()
    await lock_active_user(session, user_id)
    ticket = await load_ticket(session, ref, user_id=user_id, for_update=True)
    if ticket.status != CLOSED:
        await _change_status(
            session, ticket, CLOSED, by=SENDER_USER, actor_id=None, now=now, producer=producer
        )
    return ticket


async def _message_exists(session: AsyncSession, ticket_id: uuid.UUID, client_key: str) -> bool:
    found = await session.execute(
        select(Message.message_id).where(Message.ticket_id == ticket_id, Message.client_key == client_key)
    )
    return found.first() is not None


# ================================================================ views


async def load_thread(
    session: AsyncSession, ticket: Ticket, *, include_internal: bool
) -> tuple[list[Message], list[StatusHistory]]:
    msg_stmt = select(Message).where(Message.ticket_id == ticket.ticket_id).order_by(Message.seq)
    if not include_internal:
        msg_stmt = msg_stmt.where(Message.visibility == VISIBILITY_PUBLIC)
    messages = list((await session.execute(msg_stmt)).scalars().all())
    history = list(
        (
            await session.execute(
                select(StatusHistory)
                .where(StatusHistory.ticket_id == ticket.ticket_id)
                .order_by(StatusHistory.id)
            )
        )
        .scalars()
        .all()
    )
    return messages, history


def _context_out(ticket: Ticket) -> TicketContextOut | None:
    return TicketContextOut.model_validate(ticket.context) if ticket.context else None


def client_summary(ticket: Ticket) -> TicketSummaryOut:
    return TicketSummaryOut(
        ticket_id=ticket.ticket_id,
        number=ticket_number(ticket.number),
        category=ticket.category,
        subject=ticket.subject,
        status=cast(TicketStatus, ticket.status),  # значения ограничены CHECK в БД
        created_at=ticket.created_at,
        updated_at=ticket.updated_at,
        last_message_at=ticket.last_message_at,
        unread_operator_replies=ticket.user_unread_operator_replies,
    )


def client_ticket(ticket: Ticket, messages: list[Message], history: list[StatusHistory]) -> TicketOut:
    public = [m for m in messages if m.visibility == VISIBILITY_PUBLIC]  # защита в глубину
    return TicketOut(
        **client_summary(ticket).model_dump(),
        context=_context_out(ticket),
        sla_first_response_at=ticket.sla_first_response_at,
        messages=[
            TicketMessageOut(
                message_id=m.message_id,
                sender_type=m.sender_type,  # type: ignore[arg-type]
                author_name=first_name(m.author_name) if m.sender_type == SENDER_OPERATOR else None,
                text=m.text,
                created_at=m.created_at,
            )
            for m in public
        ],
        status_history=[StatusPoint(status=h.to_status, at=h.created_at) for h in history],  # type: ignore[arg-type]
    )


def staff_summary(ticket: Ticket, now: datetime, soon_minutes: int) -> StaffTicketSummaryOut:
    view = sla_rules.sla_view(ticket, now, soon_minutes)
    return StaffTicketSummaryOut(
        ticket_id=ticket.ticket_id,
        number=ticket_number(ticket.number),
        user_id=ticket.user_id,
        channel=ticket.channel,
        category=ticket.category,
        subject=ticket.subject,
        status=ticket.status,
        priority=ticket.priority,
        assignee_id=ticket.assignee_id,
        has_event_context=ticket.context is not None,
        anonymized=ticket.anonymized_at is not None,
        created_at=ticket.created_at,
        updated_at=ticket.updated_at,
        last_message_at=ticket.last_message_at,
        first_response_at=ticket.first_response_at,
        sla_first_response_at=ticket.sla_first_response_at,
        sla_resolution_at=ticket.sla_resolution_at,
        sla_target=view.target,
        sla_due_at=view.due_at,
        sla_state=view.state,
        sla_paused=view.paused,
    )


async def staff_ticket(
    session: AsyncSession, ticket: Ticket, now: datetime, soon_minutes: int
) -> StaffTicketOut:
    messages, history = await load_thread(session, ticket, include_internal=True)
    escalations = (
        (
            await session.execute(
                select(Escalation)
                .where(Escalation.ticket_id == ticket.ticket_id)
                .order_by(Escalation.created_at)
            )
        )
        .scalars()
        .all()
    )
    return StaffTicketOut(
        **staff_summary(ticket, now, soon_minutes).model_dump(),
        context=_context_out(ticket),
        correlation_id=ticket.correlation_id,
        resolved_at=ticket.resolved_at,
        closed_at=ticket.closed_at,
        user_unread_operator_replies=ticket.user_unread_operator_replies,
        messages=[
            StaffMessageOut(
                message_id=m.message_id,
                sender_type=m.sender_type,  # type: ignore[arg-type]
                visibility=cast(Visibility, m.visibility),  # значения ограничены CHECK в БД
                author_id=m.author_id,
                author_name=m.author_name,
                text=m.text,
                created_at=m.created_at,
            )
            for m in messages
        ],
        status_history=[
            StaffStatusPoint(
                from_status=h.from_status,
                status=h.to_status,
                at=h.created_at,
                changed_by=h.changed_by,
                actor_id=h.actor_id,
            )
            for h in history
        ],
        escalations=[EscalationOut.model_validate(e, from_attributes=True) for e in escalations],
    )


# ================================================================ staff commands


async def staff_list(
    session: AsyncSession,
    *,
    statuses: list[str] | None,
    category: str | None,
    priority: str | None,
    assignee: str | None,
    unassigned: bool,
    user_id: uuid.UUID | None = None,
    sla: str | None,
    sort: str,
    limit: int,
    cursor: str | None,
    now: datetime,
    soon_minutes: int,
) -> tuple[list[Ticket], str | None]:
    stmt = select(Ticket)
    if statuses:
        stmt = stmt.where(Ticket.status.in_(statuses))
    if user_id is not None:
        stmt = stmt.where(Ticket.user_id == user_id)
    if category:
        stmt = stmt.where(Ticket.category == category)
    if priority:
        stmt = stmt.where(Ticket.priority == priority)
    if unassigned:
        stmt = stmt.where(Ticket.assignee_id.is_(None))
    elif assignee:
        stmt = stmt.where(Ticket.assignee_id == assignee)
    if sla:
        stmt = stmt.where(sla_rules.sla_filter(sla, now, soon_minutes))  # type: ignore[arg-type]

    if sort == "sla":
        # Очередь: сначала идущие таймеры по сроку (просроченные сверху), затем пауза/выполненные
        rank, due = sla_rules.rank_expr(), sla_rules.due_expr()
        stmt = stmt.order_by(rank, due, Ticket.number)
        if cursor:
            c = decode_cursor(cursor, {"r", "d", "n"})
            try:
                key = (int(c["r"]), datetime.fromisoformat(str(c["d"])), int(c["n"]))
            except (TypeError, ValueError) as exc:
                raise decode_cursor_error() from exc
            stmt = stmt.where(
                tuple_(rank, due, Ticket.number)
                > tuple_(literal(key[0], Integer), literal(key[1], DateTime(timezone=True)), literal(key[2]))
            )
        rows = list((await session.execute(stmt.limit(limit + 1))).scalars().all())
        nxt = None
        if len(rows) > limit:
            last = rows[limit - 1]
            view = sla_rules.sla_view(last, now, soon_minutes)
            last_rank = 0 if view.target is not None else 1
            last_due = (
                last.sla_first_response_at if last.first_response_at is None else last.sla_resolution_at
            )
            nxt = encode_cursor({"r": last_rank, "d": last_due.isoformat(), "n": last.number})
        return rows[:limit], nxt

    stmt = stmt.order_by(Ticket.number.desc())
    if cursor:
        try:
            stmt = stmt.where(Ticket.number < int(decode_cursor(cursor, {"n"})["n"]))
        except (TypeError, ValueError) as exc:
            raise decode_cursor_error() from exc
    rows = list((await session.execute(stmt.limit(limit + 1))).scalars().all())
    nxt = encode_cursor({"n": rows[limit - 1].number}) if len(rows) > limit else None
    return rows[:limit], nxt


def decode_cursor_error() -> ApiError:
    return ApiError(400, "INVALID_CURSOR", "Некорректный курсор")


def _audit_state(ticket: Ticket) -> dict[str, Any]:
    return {
        "number": ticket_number(ticket.number),
        "status": ticket.status,
        "priority": ticket.priority,
        "assignee_id": ticket.assignee_id,
    }


async def staff_add_message(
    session: AsyncSession,
    *,
    actor: Actor,
    ref: str,
    body: StaffMessageIn,
    client_key: str | None,
    producer: str,
    now: datetime | None = None,
) -> Ticket:
    now = now or utcnow()
    ticket = await load_ticket(session, ref, for_update=True)
    if client_key and await _message_exists(session, ticket.ticket_id, client_key):
        return ticket
    if ticket.status == CLOSED:
        raise conflict("SUPPORT_TICKET_CLOSED", "Обращение закрыто")
    public = body.visibility == VISIBILITY_PUBLIC
    if public and ticket.user_id is None:
        raise conflict("SUPPORT_TICKET_ANONYMIZED", "Пользователь удалил профиль — ответ доставить некому")
    before = _audit_state(ticket)
    message = Message(
        message_id=uuid.uuid4(),
        ticket_id=ticket.ticket_id,
        sender_type=SENDER_OPERATOR,
        visibility=body.visibility,
        author_id=actor.id[:64],
        # Имя — только из claim actor.name токена admin-bff (ревью P5): тело запроса не может подписать
        # ответ чужим именем. Клиент видит имя без фамилии.
        author_name=first_name(actor.name),
        text=body.text,
        client_key=client_key,
        created_at=now,
    )
    session.add(message)
    await session.flush()
    if not public:
        # Внутренняя заметка: только сотрудникам, без событий и уведомлений; метаданные клиента не меняются
        await events.audit(
            session,
            actor,
            "ticket.note",
            object_type="support_ticket",
            object_id=str(ticket.ticket_id),
            before=None,
            after={
                "number": ticket_number(ticket.number),
                "message_id": str(message.message_id),
                "length": len(body.text),
            },
            producer=producer,
            now=now,
        )
        return ticket

    first_response = ticket.first_response_at is None
    if first_response:
        ticket.first_response_at = now
    if ticket.assignee_id is None:
        ticket.assignee_id = actor.id[:64]  # кто ответил, тот и ведёт (как в прототипе Admin v2)
    ticket.last_message_at = now
    ticket.updated_at = now
    ticket.user_unread_operator_replies += 1
    await events.ticket_replied(session, ticket, message, producer=producer)
    if ticket.status in (NEW, IN_PROGRESS):
        # Ответ клиенту передаёт мяч клиенту: SLA на паузе до его ответа
        await _change_status(
            session,
            ticket,
            WAITING_CUSTOMER,
            by=SENDER_OPERATOR,
            actor_id=actor.id[:64],
            now=now,
            producer=producer,
        )
    await events.audit(
        session,
        actor,
        "ticket.reply",
        object_type="support_ticket",
        object_id=str(ticket.ticket_id),
        before=before,
        after={
            **_audit_state(ticket),
            "message_id": str(message.message_id),
            "first_response": first_response,
        },
        producer=producer,
        now=now,
    )
    return ticket


async def staff_patch(
    session: AsyncSession,
    *,
    actor: Actor,
    ref: str,
    patch: StaffPatchIn,
    producer: str,
    now: datetime | None = None,
) -> Ticket:
    now = now or utcnow()
    ticket = await load_ticket(session, ref, for_update=True)
    fields = patch.model_fields_set

    if "status" in fields and patch.status != ticket.status:
        allowed = STAFF_TRANSITIONS[ticket.status]
        if patch.status not in allowed:
            raise conflict(
                "SUPPORT_INVALID_TRANSITION",
                "Недопустимый переход статуса",
                {"from": ticket.status, "to": patch.status, "allowed": sorted(allowed)},
            )
        before = _audit_state(ticket)
        await _change_status(
            session,
            ticket,
            patch.status,
            by=SENDER_OPERATOR,
            actor_id=actor.id[:64],
            now=now,
            producer=producer,
        )
        await events.audit(
            session,
            actor,
            "ticket.status",
            object_type="support_ticket",
            object_id=str(ticket.ticket_id),
            before=before,
            after=_audit_state(ticket),
            producer=producer,
            now=now,
        )

    if "priority" in fields and patch.priority != ticket.priority:
        before = _audit_state(ticket)
        ticket.priority = patch.priority  # type: ignore[assignment]
        # Сроки SLA пересчитываются от момента создания по политике нового приоритета
        ticket.sla_first_response_at, ticket.sla_resolution_at = sla_rules.deadlines(
            ticket.created_at, await sla_rules.resolve_policy(session, ticket.category, ticket.priority)
        )
        await events.audit(
            session,
            actor,
            "ticket.priority",
            object_type="support_ticket",
            object_id=str(ticket.ticket_id),
            before=before,
            after={
                **_audit_state(ticket),
                "sla_first_response_at": events.iso(ticket.sla_first_response_at),
                "sla_resolution_at": events.iso(ticket.sla_resolution_at),
            },
            producer=producer,
            now=now,
        )

    if "assignee_id" in fields and patch.assignee_id != ticket.assignee_id:
        before = _audit_state(ticket)
        ticket.assignee_id = patch.assignee_id
        await events.audit(
            session,
            actor,
            "ticket.assign",
            object_type="support_ticket",
            object_id=str(ticket.ticket_id),
            before=before,
            after=_audit_state(ticket),
            producer=producer,
            now=now,
        )
    return ticket


async def staff_escalate(
    session: AsyncSession,
    *,
    actor: Actor,
    ref: str,
    body: EscalationIn,
    idempotency_key: str | None,
    producer: str,
    now: datetime | None = None,
) -> tuple[Escalation, bool]:
    """Связанный запрос в другую команду. Support сам не меняет оплату/подписку и не блокирует (BR-TG-011)."""
    now = now or utcnow()
    ticket = await load_ticket(session, ref, for_update=True)
    if idempotency_key:
        existing = (
            await session.execute(
                select(Escalation).where(
                    Escalation.ticket_id == ticket.ticket_id, Escalation.idempotency_key == idempotency_key
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            if existing.type != body.type or existing.note != body.note:
                raise unprocessable(
                    "IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными"
                )
            return existing, True
    escalation = Escalation(
        escalation_id=uuid.uuid4(),
        ticket_id=ticket.ticket_id,
        type=body.type,
        note=body.note,
        status="OPEN",
        created_by=actor.id[:64],
        idempotency_key=idempotency_key,
        created_at=now,
    )
    session.add(escalation)
    await session.flush()
    await events.audit(
        session,
        actor,
        "ticket.escalate",
        object_type="support_ticket",
        object_id=str(ticket.ticket_id),
        before=None,
        after={
            "number": ticket_number(ticket.number),
            "escalation_id": str(escalation.escalation_id),
            "type": body.type,
        },
        producer=producer,
        now=now,
    )
    return escalation, False


async def staff_take(
    session: AsyncSession, *, actor: Actor, ref: str, producer: str, now: datetime | None = None
) -> Ticket:
    """«Взять в работу»: назначить на себя; NEW → IN_PROGRESS. Повтор тем же оператором — без изменений и аудита.
    Закрытое обращение взять нельзя (409)."""
    now = now or utcnow()
    ticket = await load_ticket(session, ref, for_update=True)
    if ticket.status == CLOSED:
        raise conflict("SUPPORT_TICKET_CLOSED", "Обращение закрыто")
    me = actor.id[:64]
    if ticket.assignee_id == me and ticket.status != NEW:
        return ticket
    before = _audit_state(ticket)
    ticket.assignee_id = me
    if ticket.status == NEW:
        await _change_status(
            session, ticket, IN_PROGRESS, by=SENDER_OPERATOR, actor_id=me, now=now, producer=producer
        )
    await events.audit(
        session,
        actor,
        "ticket.take",
        object_type="support_ticket",
        object_id=str(ticket.ticket_id),
        before=before,
        after=_audit_state(ticket),
        producer=producer,
        now=now,
    )
    return ticket


async def support_stats(
    session: AsyncSession, *, since: datetime, now: datetime, soon_minutes: int
) -> SupportStatsOut:
    """Очередь — на текущий момент; средние времена (минуты, 1 знак) — за период [since, now]:
    первый ответ — по обращениям с first_response_at в периоде; решение — по переходам в RESOLVED в периоде
    (история статусов: resolved_at сбрасывается при закрытии/переоткрытии)."""
    counts = dict(
        (await session.execute(
            select(Ticket.status, func.count()).where(Ticket.status.in_(OPEN_STATUSES)).group_by(Ticket.status)
        )).all()
    )
    breached = (
        await session.execute(
            select(func.count()).select_from(Ticket).where(sla_rules.sla_filter("breached", now, soon_minutes))
        )
    ).scalar_one()
    first = (
        await session.execute(
            select(func.avg(func.extract("epoch", Ticket.first_response_at - Ticket.created_at))).where(
                Ticket.first_response_at >= since, Ticket.first_response_at <= now
            )
        )
    ).scalar_one()
    resolution = (
        await session.execute(
            select(func.avg(func.extract("epoch", StatusHistory.created_at - Ticket.created_at)))
            .select_from(StatusHistory)
            .join(Ticket, Ticket.ticket_id == StatusHistory.ticket_id)
            .where(
                StatusHistory.to_status == RESOLVED,
                StatusHistory.created_at >= since,
                StatusHistory.created_at <= now,
            )
        )
    ).scalar_one()

    def minutes(seconds: Any) -> float | None:
        return None if seconds is None else round(float(seconds) / 60, 1)

    return SupportStatsOut(
        open=sum(int(v) for v in counts.values()),
        in_progress=int(counts.get(IN_PROGRESS, 0)),
        waiting_customer=int(counts.get(WAITING_CUSTOMER, 0)),
        breached=int(breached),
        avg_first_response_minutes=minutes(first),
        avg_resolution_minutes=minutes(resolution),
    )


def escalation_out(e: Escalation) -> EscalationOut:
    return EscalationOut.model_validate(e, from_attributes=True)


# ================================================================ SLA policies


async def get_sla_policies(session: AsyncSession) -> SlaPoliciesOut:
    rows = (
        (await session.execute(select(SlaPolicy).order_by(SlaPolicy.category, SlaPolicy.priority)))
        .scalars()
        .all()
    )
    return SlaPoliciesOut(
        items=[SlaPolicyOut.model_validate(r, from_attributes=True) for r in rows],
        category_defaults={c: DEFAULT_PRIORITY.get(c, "normal") for c in CATEGORIES},
    )


async def put_sla_policies(
    session: AsyncSession, *, actor: Actor, body: SlaPoliciesPut, producer: str, now: datetime | None = None
) -> SlaPoliciesOut:
    """Upsert перечисленных пар (category, priority). Новые сроки действуют для новых обращений и при смене
    приоритета; уже открытые обращения не пересчитываются (оператор видит прежний таймер)."""
    now = now or utcnow()
    before: dict[str, list[int]] = {}
    for item in body.items:
        current = await session.get(SlaPolicy, (item.category, item.priority), with_for_update=True)
        if current is not None:
            before[f"{item.category}/{item.priority}"] = [
                current.first_response_minutes,
                current.resolution_minutes,
            ]
        stmt = insert(SlaPolicy).values(
            category=item.category,
            priority=item.priority,
            first_response_minutes=item.first_response_minutes,
            resolution_minutes=item.resolution_minutes,
            updated_at=now,
            updated_by=actor.id[:64],
        )
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=[SlaPolicy.category, SlaPolicy.priority],
                set_={
                    "first_response_minutes": stmt.excluded.first_response_minutes,
                    "resolution_minutes": stmt.excluded.resolution_minutes,
                    "updated_at": stmt.excluded.updated_at,
                    "updated_by": stmt.excluded.updated_by,
                },
            )
        )
    after = {
        f"{i.category}/{i.priority}": [i.first_response_minutes, i.resolution_minutes] for i in body.items
    }
    await events.audit(
        session,
        actor,
        "sla.change",
        object_type="support_sla_policy",
        object_id="sla_policies",
        before=before or None,
        after=after,
        reason=body.reason,
        producer=producer,
        now=now,
    )
    session.expire_all()
    return await get_sla_policies(session)


# ================================================================ deletion (TG-FR-006)


async def anonymize_user(
    session: AsyncSession, *, user_id: str, request_id: str, producer: str, now: datetime | None = None
) -> int:
    """Обезличивание: user_id → NULL, тексты клиента и тема → «[удалено по запросу пользователя]»,
    контекст очищается.
    Ответы операторов, заметки, история статусов и эскалации остаются (retention/audit). Открытые обращения
    закрываются системой — отвечать некому. Повторная доставка события безопасна (идемпотентно)."""
    now = now or utcnow()
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        uid = None
    count = 0
    if uid is not None:
        await lock_user(session, uid)
        try:
            request_uuid = uuid.UUID(request_id)
        except ValueError:
            request_uuid = uuid.UUID(int=0)
        # Отметка в той же транзакции и под той же блокировкой, что и обезличивание: создание обращения,
        # ждущее блокировку, после неё увидит отметку и получит 410 (гонка «удаление ↔ новое обращение»).
        await session.execute(
            insert(DeletedUser)
            .values(user_id=uid, request_id=request_uuid, deleted_at=now)
            .on_conflict_do_nothing(index_elements=[DeletedUser.user_id])
        )
        tickets = (
            (await session.execute(select(Ticket).where(Ticket.user_id == uid).with_for_update()))
            .scalars()
            .all()
        )
        ids = [t.ticket_id for t in tickets]
        if ids:
            await session.execute(
                update(Message)
                .where(Message.ticket_id.in_(ids), Message.sender_type == SENDER_USER)
                .values(text=ANONYMIZED_TEXT, client_key=None)
            )
        for ticket in tickets:
            ticket.user_id = None
            ticket.subject = ANONYMIZED_TEXT
            ticket.context = None
            ticket.correlation_id = None
            ticket.idempotency_key = None
            ticket.request_fingerprint = None
            ticket.anonymized_at = now
            ticket.user_unread_operator_replies = 0
            if ticket.status != CLOSED:
                await _change_status(
                    session, ticket, CLOSED, by=SENDER_SYSTEM, actor_id=None, now=now, producer=producer
                )
            count += 1
    await events.domain_deleted(session, user_id, request_id, producer=producer)
    return count

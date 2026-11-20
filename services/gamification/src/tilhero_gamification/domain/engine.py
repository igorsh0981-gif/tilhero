"""Ядро начислений: «ход» (Turn) — одна транзакция изменения кошелька ученика.

Порядок: удалённый ученик отсекается → advisory-блокировка ученика → строка learners (создаётся по умолчанию, если
событие пришло раньше user.profile.created.v1) → `SELECT … FOR UPDATE` строки wallets → активные правила.
Операция реестра идемпотентна по (user_id, idempotency_key): повтор ключа не создаёт второй операции и не меняет
кошелёк. Баланс тилов, заморозок и XP не уходит в минус (проверка до записи + CHECK ≥ 0 в wallets).

Начисление активности (§1.2): множитель — максимум одного опубликованного события недели, активного сейчас, с
подходящей аудиторией (округление вниз); дневной лимит `caps` — по подтверждённым операциям активностей и заданий
местного дня: превышение урезает сумму до остатка (`capped = true`), нулевой остаток — без операции.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import ROUND_FLOOR, Decimal
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_gamification.domain.common import (
    ACTIVITY_REASONS,
    CAPPED_REASONS,
    LEVEL_REACHED,
    audience_of,
    balance_negative,
    emit_event,
    iso,
    local_date,
    lock_user,
    zone,
)
from tilhero_gamification.domain.rules import Rules, active_rules, level_of
from tilhero_gamification.models import (
    DailyStat,
    DeletedUser,
    EvidenceReward,
    GameEvent,
    Learner,
    Ledger,
    SessionReward,
    Wallet,
)
from tilhero_gamification.settings import Settings

ONE = Decimal("1")

# метрики daily_stats по операциям: (reason, currency) → метрика (знак суммы учитывается в post)
_STAT_BY_OP: dict[tuple[str, str], str] = {
    **{(r, "xp"): "earned_xp" for r in (*ACTIVITY_REASONS, "quest", "quest_bonus")},
    **{(r, "til"): "earned_til" for r in (*ACTIVITY_REASONS, "quest", "quest_bonus")},
    ("shop", "til"): "spent_til",
    ("registration_bonus", "freeze"): "freezes_granted",
    ("referral_bonus", "freeze"): "freezes_granted",
    ("shop", "freeze"): "freezes_bought",
    ("streak_freeze", "freeze"): "freezes_used",
}


@dataclass
class Effects:
    """Что изменилось за ход — для экрана наград занятия (§1.8)."""

    ops: list[Ledger] = field(default_factory=list)
    level_from: int | None = None
    level_to: int | None = None
    stage_from: int | None = None
    stage_to: int | None = None
    badges: list[str] = field(default_factory=list)
    quests: list[tuple[date, int]] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not (self.ops or self.level_to or self.stage_to or self.badges or self.quests)


@dataclass
class Turn:
    session: AsyncSession
    settings: Settings
    now: datetime
    learner: Learner
    wallet: Wallet
    rules: Rules
    event_id: str | None = None
    session_id: uuid.UUID | None = None
    # время события-источника (finished_at / occurred_at): день ученика, лимит, множитель и задания — по нему
    at: datetime | None = None
    effects: Effects = field(default_factory=Effects)
    _events: list[GameEvent] | None = None
    _seq: int = 0

    @property
    def user_id(self) -> uuid.UUID:
        return self.learner.user_id

    @property
    def audience(self) -> str:
        return learner_audience(self.learner)

    @property
    def moment(self) -> datetime:
        """Момент действия: время события (не позже часов сервиса), иначе — сейчас."""
        return min(self.at, self.now) if self.at is not None else self.now

    @property
    def today(self) -> date:
        """День ученика на момент действия (операции, лимит, задания)."""
        return local_date(self.moment, zone(self.learner.timezone, self.settings.default_timezone))

    @property
    def stats_day(self) -> date:
        """День обезличенной статистики — по STATS_TIMEZONE (окно обзора считается так же)."""
        return local_date(self.moment, zone(self.settings.stats_timezone, self.settings.default_timezone))

    @property
    def fresh(self) -> bool:
        """Событие-источник свежее NOTIFY_MAX_AGE_MINUTES: по старым событиям (догоняющее чтение стрима после
        выкладки) уведомления о значках и росте героя не отправляются."""
        return self.at is None or self.now - self.at <= timedelta(minutes=self.settings.notify_max_age_minutes)

    @property
    def notify(self) -> bool:
        return bool(self.learner.game_notifications) and self.fresh

    @property
    def current_day(self) -> bool:
        """День действия — сегодняшний день ученика (задания выпускаются только на него)."""
        return self.today == local_date(self.now, zone(self.learner.timezone, self.settings.default_timezone))

    # ---------------------------------------------------------------- события недели и лимиты

    async def active_events(self) -> list[GameEvent]:
        if self._events is None:
            self._events = await events_active(self.session, self.moment, self.audience)
        return self._events

    async def multiplier(self, action: str, currency: str) -> Decimal:
        best = ONE
        for ev in await self.active_events():
            for m in ev.multipliers:
                if m.get("action") == action and m.get("currency") == currency:
                    best = max(best, Decimal(str(m.get("factor", 1))))
        return best

    async def earned_today(self, currency: str, reasons: tuple[str, ...] = CAPPED_REASONS) -> int:
        total = await self.session.scalar(
            select(func.coalesce(func.sum(Ledger.amount), 0)).where(
                Ledger.user_id == self.user_id, Ledger.local_date == self.today, Ledger.currency == currency,
                Ledger.reason.in_(reasons), Ledger.status == "confirmed"))
        return int(total or 0)

    # ---------------------------------------------------------------- проводка

    async def post(self, *, currency: str, amount: int, reason: str, key: str, source_kind: str, source_ref: str,
                   multiplier: Decimal = ONE, capped: bool = False, rules_version: int | None = None,
                   actor: str = "system", comment: str | None = None, reversal_of: uuid.UUID | None = None,
                   session_id: uuid.UUID | None = None, use_session: bool = True) -> Ledger | None:
        """Операция реестра + кошелёк в той же транзакции. Повтор ключа → None (кошелёк не меняется)."""
        if amount == 0:
            return None
        balance = self.balance(currency)
        if balance + amount < 0:
            raise balance_negative(currency, balance, amount)
        op_id = uuid.uuid4()
        sid = session_id if session_id is not None else (self.session_id if use_session else None)
        values: dict[str, Any] = {
            "op_id": op_id, "user_id": self.user_id, "currency": currency, "amount": amount, "reason": reason,
            "source_kind": source_kind, "source_ref": source_ref[:200], "source_session_id": sid,
            "rules_version": rules_version, "multiplier": multiplier, "capped": capped, "local_date": self.today,
            "status": "confirmed", "actor": actor, "comment": comment, "idempotency_key": key[:200],
            # операции одного хода — в порядке проводки (история сортируется по created_at, op_id)
            "reversal_of": reversal_of, "created_at": self.now + timedelta(microseconds=self._seq),
        }
        inserted = (await self.session.execute(
            insert(Ledger).values(**values)
            .on_conflict_do_nothing(index_elements=["user_id", "idempotency_key"]).returning(Ledger.op_id)
        )).scalar()
        if inserted is None:
            return None
        self._seq += 1
        if currency == "xp":
            self.wallet.xp_total += amount
        elif currency == "til":
            self.wallet.til_balance += amount
        else:
            self.wallet.freeze_stock += amount
        self.wallet.updated_at = self.now
        op = Ledger(**values)
        self.effects.ops.append(op)
        metric = _STAT_BY_OP.get((reason, currency))
        if metric is not None:
            await bump(self.session, self.stats_day, self.audience, metric, abs(amount))
        return op

    def balance(self, currency: str) -> int:
        if currency == "xp":
            return int(self.wallet.xp_total)
        if currency == "til":
            return int(self.wallet.til_balance)
        return int(self.wallet.freeze_stock)

    async def earn(self, *, reason: str, action: str, amounts: dict[str, int], key: str, source_ref: str,
                   rules_version: int | None = None) -> list[Ledger]:
        """Начисление активности или задания: множитель события недели (вниз), затем дневной лимит."""
        version = rules_version if rules_version is not None else self.rules.version
        out: list[Ledger] = []
        for currency in ("xp", "til"):
            base = int(amounts.get(currency, 0))
            if base <= 0:
                continue
            factor = await self.multiplier(action, currency)
            value = int((Decimal(base) * factor).to_integral_value(rounding=ROUND_FLOOR))
            remaining = self.rules.caps[currency] - await self.earned_today(currency)
            capped = value > remaining
            value = max(0, min(value, remaining))
            if value <= 0:
                continue
            op = await self.post(currency=currency, amount=value, reason=reason, key=f"{key}:{currency}",
                                 source_kind="event", source_ref=source_ref, multiplier=factor, capped=capped,
                                 rules_version=version)
            if op is not None:
                out.append(op)
        if any(op.currency == "xp" for op in out):
            await self.check_level()
        return out

    async def check_level(self) -> None:
        """Уровень = число порогов ≤ xp_total; не понижается. Рост → game.level.reached.v1."""
        new = min(100, level_of(int(self.wallet.xp_total), self.rules.levels))
        if new <= self.wallet.level:
            return
        before = int(self.wallet.level)
        self.wallet.level = new
        self.wallet.updated_at = self.now
        if self.effects.level_from is None:
            self.effects.level_from = before
        self.effects.level_to = new
        await emit_event(self.session, LEVEL_REACHED, {
            "user_id": str(self.user_id), "level": new, "xp_total": int(self.wallet.xp_total),
            "reached_at": iso(self.now)}, causation_id=self.event_id)

    async def record_session(self, session_id: uuid.UUID | None = None,
                             evaluation_id: uuid.UUID | None = None) -> SessionReward | None:
        """Итоги занятия (§1.8): строка появляется, как только событие сессии обработано (даже без наград)."""
        sid = session_id or self.session_id
        if sid is None:
            return None
        row = await self.session.get(SessionReward, (self.user_id, sid), with_for_update=True)
        if row is None:
            row = SessionReward(user_id=self.user_id, session_id=sid, evaluation_id=evaluation_id, op_ids=[],
                                badges=[], quests=[], created_at=self.now, updated_at=self.now)
            self.session.add(row)
        elif evaluation_id is not None and row.evaluation_id is None:
            row.evaluation_id = evaluation_id
        merge_effects(row, self.effects, self.now)
        return row

    async def stash_evidence(self, evidence_id: uuid.UUID) -> None:
        """Итоги навыков по доказательству, урок которого ещё не пришёл: операции (по op_id), рост, значки, задания."""
        row = await self.session.get(EvidenceReward, (self.user_id, evidence_id), with_for_update=True)
        if row is None:
            row = EvidenceReward(user_id=self.user_id, evidence_id=evidence_id, op_ids=[], badges=[], quests=[],
                                 created_at=self.now, updated_at=self.now)
            self.session.add(row)
        merge_effects(row, self.effects, self.now, with_ops=True)


def merge_effects(row: SessionReward | EvidenceReward, e: Effects | EvidenceReward, now: datetime, *,
                  with_ops: bool = False) -> None:
    """Слить итоги в строку занятия или доказательства: рост — от первого «из» до последнего «в», значки и задания
    без повторов; with_ops — запомнить op_id операций (они проведены без source_session_id)."""
    if e.level_to is not None:
        row.level_from = row.level_from if row.level_from is not None else e.level_from
        row.level_to = max(e.level_to, row.level_to or 0)
    if e.stage_to is not None:
        row.stage_from = row.stage_from if row.stage_from is not None else e.stage_from
        row.stage_to = max(e.stage_to, row.stage_to or 0)
    if e.badges:
        row.badges = [*row.badges, *[b for b in e.badges if b not in row.badges]]
    quests: list[tuple[str, int]] = ([(d.isoformat(), int(s)) for d, s in e.quests] if isinstance(e, Effects)
                                      else [(str(q[0]), int(q[1])) for q in e.quests])
    if quests:
        known = {(str(d), int(s)) for d, s in row.quests}
        row.quests = [*row.quests, *[[d, s] for d, s in quests if (d, s) not in known]]
    ops = [str(op.op_id) for op in e.ops] if isinstance(e, Effects) else list(e.op_ids)
    if (with_ops or not isinstance(e, Effects)) and ops:
        row.op_ids = [*row.op_ids, *[o for o in ops if o not in row.op_ids]]
    row.updated_at = now


# ---------------------------------------------------------------- открытие хода


def learner_audience(learner: Learner) -> str:
    return audience_of(learner.age_band, learner.kind == "child")


async def is_deleted(session: AsyncSession, user_id: uuid.UUID) -> bool:
    return await session.get(DeletedUser, user_id) is not None


async def ensure_learner(session: AsyncSession, user_id: uuid.UUID, now: datetime, *,
                         account_id: uuid.UUID | None = None, kind: str | None = None,
                         age_band: str | None = None) -> Learner:
    """Строка ученика (под блокировкой ученика). Детский профиль «липкий»; детям по умолчанию тихие праздники,
    пока ученик сам не менял настройки."""
    learner = await session.get(Learner, user_id, populate_existing=True)
    if learner is None:
        learner = Learner(user_id=user_id, account_id=account_id, kind=kind or "account", age_band=age_band,
                          hero_stage=1, confirmed_skills=0, auto_freeze=True, quests_hidden=False,
                          celebrations="full", game_notifications=True, settings_customized=False,
                          lessons_completed=0, reviews_cards=0, readings_completed=0, streak_best=0, freezes_used=0,
                          skills_retained=0, created_at=now, updated_at=now)
        session.add(learner)
    else:
        if account_id is not None and learner.account_id is None:
            learner.account_id = account_id
        if kind == "child" and learner.kind != "child":
            learner.kind = "child"
        if age_band is not None and learner.age_band != age_band:
            learner.age_band = age_band
    if learner_audience(learner) == "kids" and not learner.settings_customized:
        learner.celebrations = "quiet"
    learner.updated_at = now
    await session.flush()
    return learner


async def lock_wallet(session: AsyncSession, user_id: uuid.UUID, now: datetime) -> Wallet:
    await session.execute(insert(Wallet).values(user_id=user_id, xp_total=0, til_balance=0, freeze_stock=0, level=1,
                                                updated_at=now).on_conflict_do_nothing(index_elements=["user_id"]))
    return (await session.execute(select(Wallet).where(Wallet.user_id == user_id).with_for_update()
                                  .execution_options(populate_existing=True))).scalar_one()


async def open_turn(session: AsyncSession, settings: Settings, now: datetime, user_id: uuid.UUID, *,
                    event_id: str | None = None, account_id: uuid.UUID | None = None, kind: str | None = None,
                    age_band: str | None = None, at: datetime | None = None) -> Turn | None:
    """None — данные ученика удалены (события и запросы после удаления их не воскрешают). Отметка удаления
    проверяется ПОСЛЕ блокировки ученика: сага держит ту же блокировку до фиксации, поэтому параллельное событие
    или запрос ждёт и видит зафиксированную отметку, а не создаёт данные заново."""
    await lock_user(session, user_id)
    if await is_deleted(session, user_id):
        return None
    learner = await ensure_learner(session, user_id, now, account_id=account_id, kind=kind, age_band=age_band)
    wallet = await lock_wallet(session, user_id, now)
    turn = Turn(session=session, settings=settings, now=now, learner=learner, wallet=wallet,
                rules=await active_rules(session), event_id=event_id, at=at)
    if learner.registration_bonus_at is None:
        await grant_registration_bonus(turn)
    return turn


async def grant_registration_bonus(turn: Turn) -> None:
    """Бонус регистрации — заморозки — при первом ходе ученика: и тем, кто зарегистрирован до спринта 6 (их
    user.profile.created давно прочитан). Ключ registration_bonus:<user_id> — тот же, что по user.profile.created:
    без дубля. В итоги занятия не попадает."""
    bonus = turn.rules.bonuses["registration_freeze"]
    if bonus > 0:
        await turn.post(currency="freeze", amount=bonus, reason="registration_bonus",
                        key=f"registration_bonus:{turn.user_id}", source_kind="event" if turn.event_id else "command",
                        source_ref=turn.event_id or "first_visit", rules_version=turn.rules.version,
                        use_session=False)
    turn.learner.registration_bonus_at = turn.now
    turn.effects = Effects()


# ---------------------------------------------------------------- события недели, статистика


async def events_active(session: AsyncSession, now: datetime, audience: str | None) -> list[GameEvent]:
    rows = (await session.execute(select(GameEvent).where(
        GameEvent.status == "published", GameEvent.starts_at <= now, GameEvent.ends_at > now)
        .order_by(GameEvent.ends_at, GameEvent.event_id))).scalars().all()
    return [r for r in rows if audience is None or audience in (r.audiences or [])]


async def bump(session: AsyncSession, day: date, audience: str, metric: str, delta: int = 1) -> None:
    stmt = insert(DailyStat).values(local_date=day, audience=audience, metric=metric, value=delta)
    await session.execute(stmt.on_conflict_do_update(
        index_elements=["local_date", "audience", "metric"], set_={"value": DailyStat.value + stmt.excluded.value}))


_PG_ZONES: frozenset[str] | None = None


async def pg_zone_known(session: AsyncSession, name: str) -> bool:
    """Пояс есть в pg_timezone_names (кеш процесса: список поясов PostgreSQL не меняется без перезапуска)."""
    global _PG_ZONES
    if _PG_ZONES is None:
        _PG_ZONES = frozenset((await session.execute(text("SELECT name FROM pg_timezone_names"))).scalars().all())
    return name in _PG_ZONES


def recent(at: datetime | None, now: datetime, minutes: int) -> bool:
    return at is not None and timedelta(0) <= now - at <= timedelta(minutes=minutes)

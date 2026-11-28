"""Фискализация сайта (INTERNAL_API §1.9): чек продажи Click — `adapter.fiscalize` после проведения (строка
`fiscal_receipts` pending создаётся в той же транзакции, что и проведение), повторы tick'ом: 1, 5, 30 мин, затем раз в
час; дольше 24 ч → failed и пункт сверки `fiscal_missing`. Чек зарегистрирован без ссылки (QR Click приходит позже
submit_items) — tick повторяет `fiscalize` тем же расписанием до 24 ч только ради ссылки (адаптер не отправляет второй
чек); ссылку можно вписать и напрямую — `PaymentService.update_fiscal_link`. Payme — чек приходит в SetFiscalData
(PaymentPort `store_fiscal`); Uzum — до сверки no_op; Stars — чеков нет (решение 17, О3)."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import select

from tilhero_billing.domain import adapters
from tilhero_billing.domain.common import lock_account, lock_order, recon_item
from tilhero_billing.domain.orders import order_view
from tilhero_billing.domain.payments import txn_view
from tilhero_billing.models import FiscalReceipt, Order, ProviderTransaction
from tilhero_billing.providers.base import FiscalOutcome
from tilhero_common.app import Runtime

log = logging.getLogger("tilhero.billing.fiscal")

BACKOFF_MINUTES = (1, 5, 30)
GIVE_UP = timedelta(hours=24)


def next_delay(attempts: int) -> timedelta:
    return timedelta(minutes=BACKOFF_MINUTES[attempts - 1] if 0 < attempts <= len(BACKOFF_MINUTES) else 60)


async def retry_due(rt: Runtime, now: datetime, batch: int) -> int:
    """Чеки pending с наступившим next_attempt_at → адаптер (вне транзакции) → результат под блокировками."""
    async with rt.transaction() as db:
        # pending — повтор отправки; registered без ссылки на чек (QR Click приходит позже submit_items) — дозапрос
        due = (FiscalReceipt.status == "pending") | ((FiscalReceipt.status == "registered")
                                                     & FiscalReceipt.qr_code_url.is_(None))
        rows = (await db.execute(select(FiscalReceipt.receipt_id, ProviderTransaction, Order).join(
            ProviderTransaction, ProviderTransaction.txn_id == FiscalReceipt.txn_id).join(
            Order, Order.order_id == ProviderTransaction.order_id).where(
            due, FiscalReceipt.next_attempt_at <= now)
            .order_by(FiscalReceipt.next_attempt_at).limit(batch))).all()
        work = [(rid, txn_view(t, int(o.order_no)), order_view(o), o.account_id) for rid, t, o in rows]
    done = 0
    for receipt_id, tv, ov, account_id in work:
        try:
            outcome = await adapters.of(rt).get(tv.provider).fiscalize(tv, ov)
        except Exception as exc:
            log.warning("fiscalize failed", extra={"provider": tv.provider, "error_type": type(exc).__name__})
            outcome = FiscalOutcome(kind="pending")
        async with rt.transaction() as db:
            if account_id is not None:
                await lock_account(db, account_id)
            await lock_order(db, ov.order_id)
            row = await db.get(FiscalReceipt, receipt_id, with_for_update=True, populate_existing=True)
            if row is None or row.status not in ("pending", "registered") \
                    or (row.status == "registered" and row.qr_code_url is not None):
                continue
            row.attempts = int(row.attempts) + 1
            row.updated_at = now
            if row.status == "registered":  # дозапрос ссылки: есть — готово; нет — повтор, через 24 ч — без ссылки
                qr = outcome.qr_code_url if (outcome.qr_code_url or "").startswith("https://") else None
                row.qr_code_url = qr
                row.next_attempt_at = None if qr is not None or now - row.created_at >= GIVE_UP \
                    else now + next_delay(int(row.attempts))
                continue
            if outcome.kind == "registered":
                row.status, row.registered_at = "registered", now
                row.provider_receipt_id = outcome.provider_receipt_id or row.provider_receipt_id
                row.fiscal_receipt_id = outcome.fiscal_receipt_id or row.fiscal_receipt_id
                row.terminal_id, row.fiscal_sign = outcome.terminal_id, outcome.fiscal_sign
                row.qr_code_url = outcome.qr_code_url if (outcome.qr_code_url or "").startswith("https://") \
                    else row.qr_code_url
                row.status_code, row.message = outcome.status_code, (outcome.message or None)
                row.next_attempt_at = None if row.qr_code_url else now + next_delay(int(row.attempts))
                done += 1
                continue
            give_up = outcome.kind == "failed" or now - row.created_at >= GIVE_UP
            if give_up:
                row.status, row.next_attempt_at = "failed", None
                row.status_code, row.message = outcome.status_code, (outcome.message or "")[:500] or None
                await recon_item(db, "fiscal_missing", f"fiscal_missing:{row.txn_id}", at=now, provider=tv.provider,
                                 order_id=ov.order_id, txn_id=row.txn_id, details={"attempts": int(row.attempts)})
            else:
                retry = outcome.retry_at if outcome.retry_at is not None and outcome.retry_at > now else None
                row.next_attempt_at = retry or now + next_delay(int(row.attempts))
    return done

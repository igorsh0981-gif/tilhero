/**
 * «Заказы и платежи» (ADM-MONEY-01, ADM-MONEY-04, AT-94; billing.read; «Возврат» — billing.refund + step-up + a reason):
 * orders of both channels with filters (channel, provider, status, product kind, order number, the provider's
 * transaction id, the account, dates) — the site in sums (Payme, Click, Uzum), the Mini App and its renewals in Stars;
 * the card — the product snapshot, transactions, the Stars subscription, fiscal receipts (a link to the receipt),
 * refunds and the provider calls (metadata only). The refund warns before the command: Stars and Click return at once,
 * Payme and Uzum — in the provider's cabinet (the instruction comes back); a pack of tils — if the bought tils are spent,
 * billing refuses (409 REFUND_NOT_ALLOWED tils_spent) and the refund can be forced with a second confirmation.
 * The second tab — refunds by status; a refund waiting for the provider can be closed as failed.
 * Routes: #/payments · #/payments/orders/<order_id> · #/payments/refunds.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminOrderCard, AdminOrderRow, AdminRefund, BillingChannel, BillingProvider, RefundStatus } from "@tilhero/contracts/admin";
import type { BillingOrderStatus, BillingProductKind } from "@tilhero/contracts/bff";
import { Billing } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Select, Spinner, TabPanel, Tabs } from "../../ui/kit";
import { ConfirmCommand, Drawer } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { CommandKey } from "../memory/model";
import { StepUpNote, useCmdFail } from "../social/parts";
import {
  CHANNELS,
  clickWindowOpen,
  emptyOrderFilters,
  isUuid,
  NOTE_MAX,
  NOTE_MIN,
  ORDER_STATUSES,
  ORDER_TONE,
  orderFiltersProblem,
  PAY_TABS,
  performedTxn,
  PRODUCT_KINDS,
  providersOf,
  REFUND_STATUSES,
  REFUND_TONE,
  refundMethod,
  refundSig,
  STARS_SUB_TONE,
  TXN_TONE,
  type OrderFilters,
  type PayTab,
} from "./model";
import { AccountRef, staffName, useMoney } from "./parts";

export function parsePayRoute(id: string | null): { tab: PayTab; order: string | null } {
  if (!id) return { tab: "orders", order: null };
  const [a, b] = id.split("/");
  if (a === "refunds") return { tab: "refunds", order: null };
  return { tab: "orders", order: a === "orders" && b && isUuid(b) ? b.toLowerCase() : null };
}

export function PaymentsPage({ routeId }: { routeId: string | null }) {
  const { t } = useI18n();
  const { navigate } = useNav();
  const r = parsePayRoute(routeId);
  return (
    <div className="stack" data-testid="payments">
      <Tabs<PayTab>
        id="pay"
        label={t("page.payments")}
        value={r.tab}
        onChange={(v) => navigate("payments", v === "orders" ? null : v)}
        items={PAY_TABS.map((v) => ({ v, label: t(`pay.tab.${v}` as MessageKey), icon: v === "orders" ? "coins" : "rollback", testId: `pay-tab-${v}` }))}
      />
      <TabPanel id="pay" value={r.tab}>
        {r.tab === "orders" ? <OrdersTab openId={r.order} /> : <RefundsTab />}
      </TabPanel>
      <p className="xs muted row" data-testid="pay-channels-note">
        <Icon name="info" /> {t("pay.channelsNote")}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- orders */

function OrdersTab({ openId }: { openId: string | null }) {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const money = useMoney();
  const [f, setF] = useState<OrderFilters>(emptyOrderFilters);
  const [rows, setRows] = useState<AdminOrderRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const req = useRef(0);
  const problem = orderFiltersProblem(f);
  const fKey = JSON.stringify(f);
  const load = useCallback(
    async (more?: string | null) => {
      const x = JSON.parse(fKey) as OrderFilters;
      if (orderFiltersProblem(x)) return;
      const id = ++req.current;
      try {
        const page = await Billing.orders({
          status: x.status,
          channel: x.channel,
          provider: x.provider,
          product_kind: x.product_kind,
          order_no: x.order_no.trim() || undefined,
          provider_txn_id: x.provider_txn_id.trim() || undefined,
          account_id: x.account_id.trim().toLowerCase() || undefined,
          from: x.from || undefined,
          to: x.to || undefined,
          cursor: more ?? null,
        });
        if (id !== req.current) return;
        setRows((xs) => (more && xs ? [...xs, ...page.items] : page.items));
        setCursor(page.next_cursor);
        setError(null);
      } catch (e) {
        if (id === req.current) setError(e);
      }
    },
    [fKey],
  );
  useEffect(() => {
    const tm = setTimeout(() => void load(), 250);
    return () => clearTimeout(tm);
  }, [load, tick]);
  const set = <K extends keyof OrderFilters>(k: K, v: OrderFilters[K]) => setF((x) => ({ ...x, [k]: v, ...(k === "channel" ? { provider: "" as const } : {}) }));
  const dirty = fKey !== JSON.stringify(emptyOrderFilters());
  return (
    <section className="panel" aria-labelledby="pay-h" data-testid="pay-orders">
      <div className="panel-h">
        <h2 className="panel-t grow" id="pay-h">
          <Icon name="coins" /> {t("pay.title")}
        </h2>
        <Btn size="sm" icon="refresh" label={t("common.refresh")} onClick={() => void load()} testId="pay-refresh" />
      </div>
      <div className="panel-b qa-filters" role="group" aria-label={t("mny.filters")} data-testid="pay-filters">
        <div className="field">
          <label htmlFor="pay-channel">{t("pay.f.channel")}</label>
          <Select<BillingChannel | ""> id="pay-channel" label={t("pay.f.channel")} value={f.channel} onChange={(v) => set("channel", v)} options={[{ v: "", label: t("common.all") }, ...CHANNELS.map((v) => ({ v, label: t(`chn.${v}` as MessageKey) }))]} testId="pay-channel" />
        </div>
        <div className="field">
          <label htmlFor="pay-provider">{t("pay.f.provider")}</label>
          <Select<BillingProvider | ""> id="pay-provider" label={t("pay.f.provider")} value={f.provider} onChange={(v) => set("provider", v)} options={[{ v: "", label: t("common.all") }, ...providersOf(f.channel).map((v) => ({ v, label: t(`bprv.${v}` as MessageKey) }))]} testId="pay-provider" />
        </div>
        <div className="field">
          <label htmlFor="pay-status">{t("col.status")}</label>
          <Select<BillingOrderStatus | ""> id="pay-status" label={t("col.status")} value={f.status} onChange={(v) => set("status", v)} options={[{ v: "", label: t("common.all") }, ...ORDER_STATUSES.map((v) => ({ v, label: t(`ost.${v}` as MessageKey) }))]} testId="pay-status" />
        </div>
        <div className="field">
          <label htmlFor="pay-kind">{t("pay.f.kind")}</label>
          <Select<BillingProductKind | ""> id="pay-kind" label={t("pay.f.kind")} value={f.product_kind} onChange={(v) => set("product_kind", v)} options={[{ v: "", label: t("common.all") }, ...PRODUCT_KINDS.map((v) => ({ v, label: t(`pk.${v}` as MessageKey) }))]} testId="pay-kind" />
        </div>
        <div className="field">
          <label htmlFor="pay-no">{t("pay.f.orderNo")}</label>
          <input id="pay-no" className={cx("input mono", problem === "order_no" && "is-invalid")} inputMode="numeric" value={f.order_no} onChange={(e) => set("order_no", e.target.value)} data-testid="pay-no" />
        </div>
        <div className="field">
          <label htmlFor="pay-txn">{t("pay.f.txn")}</label>
          <input id="pay-txn" className={cx("input mono", problem === "txn" && "is-invalid")} value={f.provider_txn_id} spellCheck={false} onChange={(e) => set("provider_txn_id", e.target.value)} data-testid="pay-txn" />
        </div>
        <div className="field">
          <label htmlFor="pay-account">{t("pay.f.account")}</label>
          <input id="pay-account" className={cx("input mono", problem === "account" && "is-invalid")} value={f.account_id} spellCheck={false} placeholder="UUID" onChange={(e) => set("account_id", e.target.value)} data-testid="pay-account" />
        </div>
        <div className="field">
          <label htmlFor="pay-from">{t("qa.f.from")}</label>
          <input id="pay-from" type="date" className="input" value={f.from} max={f.to || undefined} onChange={(e) => set("from", e.target.value)} data-testid="pay-from" />
        </div>
        <div className="field">
          <label htmlFor="pay-to">{t("qa.f.to")}</label>
          <input id="pay-to" type="date" className={cx("input", problem === "to_before_from" && "is-invalid")} value={f.to} min={f.from || undefined} onChange={(e) => set("to", e.target.value)} data-testid="pay-to" />
        </div>
        {dirty && (
          <div className="field qf-reset">
            <span className="field-label" aria-hidden="true">
              &nbsp;
            </span>
            <Btn size="sm" kind="ghost" icon="x" label={t("common.resetFilters")} onClick={() => setF(emptyOrderFilters())} testId="pay-reset" />
          </div>
        )}
      </div>
      {problem && (
        <div className="panel-b">
          <FieldErr msg={t(`pay.fp.${problem}` as MessageKey)} />
        </div>
      )}
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="tbl compact" data-testid="pay-rows">
            <caption className="sr-only">{t("pay.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("pay.col.order")}</th>
                <th scope="col">{t("pay.col.product")}</th>
                <th scope="col">{t("pay.col.channel")}</th>
                <th scope="col" className="r">
                  {t("pay.col.amount")}
                </th>
                <th scope="col">{t("col.status")}</th>
                <th scope="col">{t("pay.col.account")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.order_id} className={cx(openId === o.order_id && "is-selected")} data-testid={`pay-${o.order_id}`} data-status={o.status} data-channel={o.channel}>
                  <td className="nowrap">
                    <button type="button" className="tr mono" onClick={() => navigate("payments", `orders/${o.order_id}`)} data-testid={`pay-open-${o.order_id}`}>
                      № {o.order_no}
                    </button>
                    <span className="xs muted block">{fmt.dateTime(o.created_at)}</span>
                  </td>
                  <td className="small">
                    <span lang="ru">{o.product_title.ru || o.product_code}</span>
                    <span className="xs muted block">{t(`pk.${o.product_kind}` as MessageKey)}</span>
                  </td>
                  <td className="small">
                    {t(`chn.${o.channel}` as MessageKey)}
                    <span className="xs muted block">{t(`bprv.${o.provider}` as MessageKey)}</span>
                  </td>
                  <td className="r num" data-testid={`pay-${o.order_id}-amount`}>
                    {money.amount(o)}
                  </td>
                  <td>
                    <Pill tone={ORDER_TONE[o.status]}>{t(`ost.${o.status}` as MessageKey)}</Pill>
                  </td>
                  <td>
                    <AccountRef id={o.account_id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="coins" title={t("pay.none")} text={dirty ? t("common.changeFilters") : undefined} testId="pay-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="pay-more" />
        </div>
      )}
      {openId && <OrderDrawer key={openId} id={openId} onClose={() => navigate("payments")} onChanged={() => setTick((n) => n + 1)} />}
    </section>
  );
}

function OrderDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const money = useMoney();
  const [o, setO] = useState<AdminOrderCard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refund, setRefund] = useState(false);
  const [last, setLast] = useState<AdminRefund | null>(null);
  const load = useCallback(() => {
    Billing.order(id)
      .then((x) => (setO(x), setError(null)))
      .catch(setError);
  }, [id]);
  useEffect(load, [load]);
  const canRefund = can("billing.refund");
  return (
    <Drawer
      wide
      testId="pay-order"
      onClose={onClose}
      title={o ? t("pay.orderT", { n: o.order_no }) : t("pay.orderT", { n: shortId(id, 8, 4) })}
      sub={
        o && (
          <>
            <Pill tone={ORDER_TONE[o.status]}>{t(`ost.${o.status}` as MessageKey)}</Pill>
            <span>{t(`chn.${o.channel}` as MessageKey)}</span>
            <span>· {t(`bprv.${o.provider}` as MessageKey)}</span>
          </>
        )
      }
      footer={
        o?.can_refund ? (
          canRefund ? (
            <Btn kind="danger" icon="rollback" label={t("pay.refund")} onClick={() => setRefund(true)} testId="pay-refund" />
          ) : (
            <span className="xs muted row" data-testid="pay-refund-ro">
              <Icon name="lock" /> {t("perm.need", { p: "billing.refund" })}
            </span>
          )
        ) : undefined
      }
    >
      {error && !o ? (
        <LoadError error={error} onRetry={load} />
      ) : !o ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack" data-testid="pay-order-body" data-status={o.status}>
          <div className="kpis mem-kpis">
            <div className="card kpi">
              <div className="kpi-l">{t("pay.col.amount")}</div>
              <div className="kpi-v" data-testid="pay-order-amount">
                {money.amount(o)}
              </div>
              <div className="kpi-n">{o.currency === "XTR" ? t("pay.inStars") : t("pay.inSums")}</div>
            </div>
            <div className="card kpi">
              <div className="kpi-l">{t("pay.col.product")}</div>
              <div className="kpi-v small" lang="ru">
                {o.product_title.ru || o.product_code}
              </div>
              <div className="kpi-n mono">{o.product_code}</div>
            </div>
            <div className="card kpi">
              <div className="kpi-l">{t("pay.paidAt")}</div>
              <div className="kpi-v small">{o.paid_at ? fmt.dateTime(o.paid_at) : "—"}</div>
              <div className="kpi-n">{t("pay.expiresAt", { t: fmt.dateTime(o.expires_at) })}</div>
            </div>
          </div>
          {last && <RefundResult r={last} />}
          <dl className="dl" data-testid="pay-order-facts">
            <dt>{t("pay.col.account")}</dt>
            <dd>
              <AccountRef id={o.account_id} />
            </dd>
            <dt>{t("pay.beneficiary")}</dt>
            <dd>
              <AccountRef id={o.beneficiary_id} />
            </dd>
            <dt>{t("pay.offer")}</dt>
            <dd className="mono">{o.offer_version}</dd>
            {o.start_mode && (
              <>
                <dt>{t("pay.startMode")}</dt>
                <dd>{t(`pay.sm.${o.start_mode}` as MessageKey)}</dd>
              </>
            )}
            {o.stars_mode && (
              <>
                <dt>{t("tf.starsMode")}</dt>
                <dd>{t(`stm.${o.stars_mode}` as MessageKey)}</dd>
              </>
            )}
          </dl>
          <section className="stack sm" aria-labelledby="pay-txn-h">
            <h3 className="h3" id="pay-txn-h">
              {t("pay.txns", { n: o.transactions.length })}
            </h3>
            <div className="table-wrap">
              <table className="tbl compact" data-testid="pay-txns">
                <caption className="sr-only">{t("pay.txns", { n: o.transactions.length })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("pay.col.txn")}</th>
                    <th scope="col">{t("col.status")}</th>
                    <th scope="col" className="r">
                      {t("pay.col.amount")}
                    </th>
                    <th scope="col">{t("pay.col.when")}</th>
                  </tr>
                </thead>
                <tbody>
                  {o.transactions.map((x) => (
                    <tr key={x.txn_id} data-state={x.state}>
                      <td className="mono xs wrap-any">{x.provider_txn_id}</td>
                      <td>
                        <Pill tone={TXN_TONE[x.state]}>{t(`txs.${x.state}` as MessageKey)}</Pill>
                        {x.cancel_reason && <span className="xs muted block">{x.cancel_reason}</span>}
                      </td>
                      <td className="r num">{money.amount(x)}</td>
                      <td className="small nowrap">{fmt.dateTime(x.performed_at ?? x.cancelled_at ?? x.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          {o.stars_subscription && (
            <section className="card stack sm" aria-labelledby="pay-sub-h" data-testid="pay-stars-sub">
              <h3 className="h3" id="pay-sub-h">
                {t("pay.starsSub")}
              </h3>
              <div className="row">
                <Pill tone={STARS_SUB_TONE[o.stars_subscription.status]}>{t(`ssub.${o.stars_subscription.status}` as MessageKey)}</Pill>
                <span>{money.stars(o.stars_subscription.amount_stars)}</span>
                <span className="small muted">{t("pay.starsSubUntil", { t: fmt.dateTime(o.stars_subscription.expires_at), n: o.stars_subscription.renewals })}</span>
              </div>
            </section>
          )}
          <section className="stack sm" aria-labelledby="pay-rcpt-h" data-testid="pay-receipts">
            <h3 className="h3" id="pay-rcpt-h">
              {t("pay.receipts")}
            </h3>
            {o.currency === "XTR" ? (
              <p className="small muted" data-testid="pay-no-receipts-stars">
                {t("pay.receiptsStars")}
              </p>
            ) : o.receipts.length ? (
              <ul className="plain-list">
                {o.receipts.map((r) => (
                  <li key={r.receipt_id} className="small">
                    <Pill tone={r.status === "registered" ? "good" : r.status === "failed" ? "bad" : "warn"}>{t(`rcpt.${r.status}` as MessageKey)}</Pill> {t(`rcpt.k.${r.kind}` as MessageKey)}
                    {r.qr_code_url && (
                      <>
                        {" "}
                        ·{" "}
                        <a href={r.qr_code_url} target="_blank" rel="noopener noreferrer" data-testid={`pay-receipt-${r.receipt_id}`}>
                          {t("pay.receiptLink")} <Icon name="ext" />
                        </a>
                      </>
                    )}
                    {r.message && <span className="xs muted block">{r.message}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">{t("pay.noReceipts")}</p>
            )}
          </section>
          {o.refunds.length > 0 && (
            <section className="stack sm" aria-labelledby="pay-ref-h">
              <h3 className="h3" id="pay-ref-h">
                {t("pay.tab.refunds")}
              </h3>
              <RefundsTable items={o.refunds} />
            </section>
          )}
          <section className="stack sm" aria-labelledby="pay-calls-h">
            <h3 className="h3" id="pay-calls-h">
              {t("pay.calls", { n: o.provider_calls.length })}
            </h3>
            {o.provider_calls.length ? (
              <div className="table-wrap">
                <table className="tbl dense" data-testid="pay-calls">
                  <caption className="sr-only">{t("pay.calls", { n: o.provider_calls.length })}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("pay.col.when")}</th>
                      <th scope="col">{t("pay.col.method")}</th>
                      <th scope="col">{t("pay.col.result")}</th>
                      <th scope="col" className="r">
                        {t("pay.col.latency")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.provider_calls.map((c) => (
                      <tr key={c.call_id}>
                        <td className="small nowrap">{fmt.dateTimeS(c.created_at)}</td>
                        <td className="mono xs">
                          {c.direction === "in" ? "←" : "→"} {c.provider} · {c.method}
                        </td>
                        <td className="mono xs">{c.result_code}</td>
                        <td className="r num">{fmt.num(c.latency_ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="small muted">{t("pay.noCalls")}</p>
            )}
            <p className="xs muted row">
              <Icon name="lock" /> {t("pay.callsNote")}
            </p>
          </section>
        </div>
      )}
      {refund && o && (
        <RefundDialog
          o={o}
          onClose={() => setRefund(false)}
          onDone={(r) => {
            setLast(r);
            load();
            onChanged();
          }}
          onStale={load}
        />
      )}
    </Drawer>
  );
}

/** The refund: the provider decides how it goes; a pack of tils warns about spent tils (force after a refusal). */
function RefundDialog({ o, onClose, onDone, onStale }: { o: AdminOrderCard; onClose: () => void; onDone: (r: AdminRefund) => void; onStale: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const fail = useCmdFail();
  const money = useMoney();
  const [key] = useState(() => new CommandKey(uuid));
  const [spent, setSpent] = useState<{ til: number; balance: number } | null>(null);
  const [force, setForce] = useState(false);
  const txn = performedTxn(o);
  const method = refundMethod(o.provider);
  const clickClosed = o.provider === "click" && !clickWindowOpen(txn?.performed_at ?? null, Date.now());
  return (
    <ConfirmCommand
      title={t("pay.refundT", { n: o.order_no })}
      text={t(method === "api" ? "pay.refundApi" : "pay.refundCabinet", { p: t(`bprv.${o.provider}` as MessageKey) })}
      icon="rollback"
      tone="bad"
      ok={spent && force ? t("pay.refundForce") : t("pay.refund")}
      okKind="danger"
      okDisabled={!!spent && !force}
      minReason={NOTE_MIN}
      maxReason={NOTE_MAX}
      reasonPlaceholder={t("pay.refundPh")}
      testId="pay-refund-dialog"
      extra={
        <>
          <dl className="dl" data-testid="pay-refund-what">
            <dt>{t("pay.col.amount")}</dt>
            <dd>{money.amount(o)}</dd>
            <dt>{t("pay.col.product")}</dt>
            <dd lang="ru">{o.product_title.ru || o.product_code}</dd>
          </dl>
          {o.product_kind === "subscription" && (
            <Callout kind="warn" icon="alert" testId="pay-refund-period">
              {t(o.provider === "telegram_stars" ? "pay.refundSubStars" : "pay.refundSub")}
            </Callout>
          )}
          {o.product_kind === "til_pack" && (
            <Callout kind="warn" icon="coins" testId="pay-refund-tils">
              {t("pay.refundTils")}
            </Callout>
          )}
          {clickClosed && (
            <Callout kind="bad" icon="clock" testId="pay-refund-window">
              {t("pay.refundClickWindow")}
            </Callout>
          )}
          {spent && (
            <div role="alert" className="stack sm" data-testid="pay-refund-spent">
              <Callout kind="bad" icon="alertCircle">
                {t("pay.tilsSpent", { til: spent.til, b: spent.balance })}
              </Callout>
              <label className="check" htmlFor="pay-refund-force">
                <input type="checkbox" id="pay-refund-force" checked={force} onChange={(e) => setForce(e.target.checked)} data-testid="pay-refund-force" />
                <span>{t("pay.forceLabel")}</span>
              </label>
            </div>
          )}
          <StepUpNote />
        </>
      }
      onClose={onClose}
      onConfirm={async (reason) => {
        const useForce = !!spent && force;
        const k = key.for(refundSig(o.order_id, reason, useForce));
        try {
          const r = await Billing.refund(o.order_id, reason, useForce, k);
          key.settle();
          toast(t(`pay.refunded.${r.status}` as MessageKey), r.status === "failed" ? "err" : "ok", "billing.refund_requested");
          onDone(r);
          return null;
        } catch (e) {
          key.settle(e);
          if (e instanceof ApiError && e.code === "REFUND_NOT_ALLOWED" && e.str("reason") === "tils_spent") {
            setSpent({ til: e.num("til") ?? 0, balance: e.num("til_balance") ?? 0 });
            return t("pay.tilsSpentErr");
          }
          if (e instanceof ApiError && e.code === "REFUND_NOT_ALLOWED") {
            const why = e.str("reason");
            if (why === "provider_window") return t("pay.na.provider_window");
            if (why === "not_paid") return t("pay.na.not_paid");
          }
          if (e instanceof ApiError && e.code === "REFUND_STATE") onStale();
          return fail(e, onStale);
        }
      }}
    />
  );
}

function RefundResult({ r }: { r: AdminRefund }) {
  const { t } = useI18n();
  const money = useMoney();
  if (r.status === "awaiting_provider" && r.instruction)
    return (
      <Callout kind="warn" icon="info" testId="pay-refund-instruction">
        <b>{t("pay.instructionT", { p: t(`bprv.${r.instruction.provider}` as MessageKey) })}</b>
        <span className="block small">{t("pay.instructionM", { id: r.instruction.provider_txn_id, a: money.sum(r.instruction.amount_tiyin) })}</span>
      </Callout>
    );
  return (
    <Callout kind={r.status === "completed" ? "good" : "bad"} icon={r.status === "completed" ? "checkCircle" : "alertCircle"} testId="pay-refund-result">
      {t(`pay.refunded.${r.status}` as MessageKey)}
      {r.failure_code ? ` · ${r.failure_code}` : ""}
    </Callout>
  );
}

/* ---------------------------------------------------------------- refunds */

function RefundsTable({ items, onFail }: { items: AdminRefund[]; onFail?: ((r: AdminRefund) => void) | null }) {
  const { t, fmt } = useI18n();
  const money = useMoney();
  return (
    <div className="table-wrap">
      <table className="tbl compact" data-testid="pay-refund-rows">
        <caption className="sr-only">{t("pay.tab.refunds")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("pay.col.order")}</th>
            <th scope="col" className="r">
              {t("pay.col.amount")}
            </th>
            <th scope="col">{t("col.status")}</th>
            <th scope="col">{t("pay.col.reason")}</th>
            <th scope="col">{t("pay.col.who")}</th>
            {onFail && (
              <th scope="col" className="r">
                {t("ct.col.actions")}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.refund_id} data-testid={`pay-refund-${r.refund_id}`} data-status={r.status}>
              <td className="nowrap mono small">
                № {r.order_no}
                <span className="xs muted block">{t(`bprv.${r.provider}` as MessageKey)}</span>
              </td>
              <td className="r num">{money.amount(r)}</td>
              <td>
                <Pill tone={REFUND_TONE[r.status]}>{t(`rfst.${r.status}` as MessageKey)}</Pill>
                <span className="xs muted block">{t(`pay.method.${r.method}` as MessageKey)}</span>
              </td>
              <td className="small wrap-any">
                {r.reason ?? <span className="muted">{t(`pay.init.${r.initiated_by}` as MessageKey)}</span>}
                {r.tils_check && <span className="xs muted block">{t("pay.tilsCheck", { til: r.tils_check.til, b: r.tils_check.til_balance })}</span>}
              </td>
              <td className="small">
                {staffName(r.requested_by, t(`pay.init.${r.initiated_by}` as MessageKey))}
                <span className="xs muted block">{fmt.dateTime(r.requested_at)}</span>
              </td>
              {onFail && <td className="actions-cell">{r.status === "awaiting_provider" && <Btn size="xs" kind="danger-ghost" icon="x" label={t("pay.fail")} onClick={() => onFail(r)} testId={`pay-fail-${r.refund_id}`} />}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RefundsTab() {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const cmdFail = useCmdFail();
  const [status, setStatus] = useState<RefundStatus | "">("awaiting_provider");
  const [rows, setRows] = useState<AdminRefund[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [fail, setFail] = useState<AdminRefund | null>(null);
  const [key] = useState(() => new CommandKey(uuid));
  const load = useCallback(
    async (more?: string | null) => {
      try {
        const p = await Billing.refunds(status, more ?? null);
        setRows((xs) => (more && xs ? [...xs, ...p.items] : p.items));
        setCursor(p.next_cursor);
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [status],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="panel" aria-labelledby="ref-h" data-testid="pay-refunds">
      <div className="panel-h">
        <h2 className="panel-t grow" id="ref-h">
          <Icon name="rollback" /> {t("pay.tab.refunds")}
        </h2>
        <Select<RefundStatus | ""> id="ref-status" label={t("col.status")} value={status} onChange={setStatus} options={[{ v: "", label: t("common.all") }, ...REFUND_STATUSES.map((v) => ({ v, label: t(`rfst.${v}` as MessageKey) }))]} testId="ref-status" />
      </div>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <RefundsTable items={rows} onFail={can("billing.refund") ? setFail : null} />
      ) : (
        <Empty icon="rollback" title={t("pay.noRefunds")} testId="ref-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="ref-more" />
        </div>
      )}
      <div className="panel-f xs">
        <Icon name="info" /> {t("pay.refundsNote")}
      </div>
      {fail && (
        <ConfirmCommand
          title={t("pay.failT", { n: fail.order_no })}
          text={t("pay.failM")}
          icon="x"
          tone="bad"
          ok={t("pay.fail")}
          okKind="danger"
          minReason={NOTE_MIN}
          maxReason={NOTE_MAX}
          reasonLabel={t("mny.note")}
          testId="pay-fail-dialog"
          extra={<StepUpNote />}
          onClose={() => setFail(null)}
          onConfirm={async (note) => {
            const k = key.for(JSON.stringify(["fail", fail.refund_id, note]));
            try {
              await Billing.failRefund(fail.refund_id, note, k);
              key.settle();
              toast(t("pay.failed"), "ok", "billing.refund_failed");
              void load();
              return null;
            } catch (e) {
              key.settle(e);
              return cmdFail(e, () => void load());
            }
          }}
        />
      )}
    </section>
  );
}

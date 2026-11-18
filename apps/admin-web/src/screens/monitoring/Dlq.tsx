import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  DlqAction,
  DlqCommand,
  DlqCommandResult,
  DlqDetail,
  DlqItem,
} from "@tilhero/contracts/admin";
import { OpsApi, type DlqFilters } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import {
  Btn,
  Callout,
  cx,
  Empty,
  FieldErr,
  Locked,
  Pill,
  Select,
  Spinner,
} from "../../ui/kit";
import { Drawer, Modal } from "../../ui/overlays";
import { errText } from "../../ui/errors";
import type { MonShared } from "./Monitoring";
import { tOr } from "./Alerts";
import {
  countConfirmed,
  DLQ_BATCH_MAX,
  DLQ_FILTER_MAX,
  atReplayLimit,
  parseLocalDateTime,
  reasonParts,
  replayBlocked,
} from "./ops";

type Kind = "replay" | "delete";
interface Pending {
  kind: Kind;
  scope: "selected" | "filter" | "one";
  ids: string[];
  count: number;
  consumers: string[];
  /** среди сообщений есть уже повторённые (или фильтр включает их) — диалог предлагает «включая уже повторённые» */
  replayed: boolean;
}

/** pretty JSON of the masked envelope; masked values ("***") are marked, not only coloured */
export function MaskedJson({
  value,
  testId,
}: {
  value: unknown;
  testId?: string;
}) {
  const text = JSON.stringify(value, null, 2) ?? "null";
  const parts: ReactNode[] = [];
  const re =
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] && m[2]) {
      parts.push(
        <span key={k++} className="k">
          {m[1]}
        </span>,
      );
      parts.push(
        <span key={k++} className="p">
          {m[2]}
        </span>,
      );
    } else if (m[1]) {
      parts.push(
        m[1] === '"***"' ? (
          <mark key={k++} className="mon-mask" title="***">
            {m[1]}
          </mark>
        ) : (
          <span key={k++} className="s">
            {m[1]}
          </span>
        ),
      );
    } else if (m[3])
      parts.push(
        <span key={k++} className="bl">
          {m[3]}
        </span>,
      );
    else if (m[4])
      parts.push(
        <span key={k++} className="n">
          {m[4]}
        </span>,
      );
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <pre className="code mon-json" data-testid={testId}>
      {parts}
    </pre>
  );
}

function Reason({ r }: { r: string | null }) {
  const i = useI18n();
  const p = reasonParts(r);
  return (
    <span className="mon-reason">
      <span className="tag">{tOr(i, `mon.dlq.rc.${p.kind}`, p.kind)}</span>
      {p.detail && <span className="mono xs muted"> {p.detail}</span>}
    </span>
  );
}

/**
 * «DLQ»: messages a consumer could not process (both sources — TILHERO_DLQ and legacy tilhero.dlq.*), filters, the
 * masked envelope (ops.queues.manage), replay and delete — one message, the selected ones (≤ 100) or the whole filter
 * (≤ 500) — with a reason, the typed number of messages and TOTP; the history of commands.
 */
export function DlqTab({
  shared,
  initialConsumer,
}: {
  shared: MonShared;
  initialConsumer: string | null;
}) {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const manage = can("ops.queues.manage");
  const [consumer, setConsumer] = useState(initialConsumer ?? "");
  const [eventType, setEventType] = useState("");
  const [source, setSource] = useState<"" | "dlq" | "legacy">("");
  const [state, setState] = useState<"present" | "replayed" | "all">("present");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [items, setItems] = useState<DlqItem[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<DlqItem | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const req = useRef(0);
  useEffect(() => {
    if (initialConsumer) setConsumer(initialConsumer);
  }, [initialConsumer]);

  const fromIso = parseLocalDateTime(from, i.lang, false);
  const toIso = parseLocalDateTime(to, i.lang, true);
  const periodBad = fromIso === null || toIso === null || (!!fromIso && !!toIso && fromIso >= toIso);
  const etBad =
    !!eventType.trim() &&
    !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/.test(eventType.trim());
  const filters: DlqFilters = useMemo(
    () => ({
      consumer: consumer || undefined,
      event_type: etBad ? undefined : eventType.trim() || undefined,
      source,
      state,
      dead_from: fromIso ?? undefined,
      dead_to: toIso ?? undefined,
    }),
    [consumer, eventType, etBad, source, state, fromIso, toIso],
  );
  const fKey = JSON.stringify(filters);
  const load = useCallback(async (f: DlqFilters, more: string | null) => {
    const id = ++req.current;
    setLoading(true);
    try {
      const page = await OpsApi.dlq({ ...f, cursor: more });
      if (id !== req.current) return;
      setItems((xs) => (more && xs ? [...xs, ...page.items] : page.items));
      setTotal(page.total);
      setCursor(page.next_cursor);
      setError(null);
      if (!more) setSel(new Set());
    } catch (e) {
      if (id === req.current) setError(e);
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, []);
  useEffect(
    () => void load(JSON.parse(fKey) as DlqFilters, null),
    [fKey, load],
  );

  const replayable = useMemo(
    () =>
      new Map(
        (shared.consumers ?? []).map((c) => [c.durable, c.replay_enabled]),
      ),
    [shared.consumers],
  );
  const consumerOpts = useMemo(() => {
    const names = new Set((shared.consumers ?? []).map((c) => c.durable));
    if (consumer) names.add(consumer);
    return [
      { v: "", label: t("mon.dlq.allConsumers") },
      ...[...names].sort().map((n) => ({ v: n, label: n })),
    ];
  }, [shared.consumers, consumer, t]);
  const filtered = !!(consumer || eventType || source || from || to || state !== "present");
  const selectable = (items ?? []).filter((x) => !atReplayLimit(x));
  const allOnPage = selectable.length > 0 && selectable.every((x) => sel.has(x.dlq_id));
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else if (n.size < DLQ_BATCH_MAX) n.add(id);
      return n;
    });
  const after = () => {
    void load(filters, null);
    setHistoryKey((k) => k + 1);
    shared.reload(true);
    setOpen(null);
  };
  const ask = (kind: Kind, scope: Pending["scope"], list: DlqItem[]) =>
    setPending({
      kind,
      scope,
      ids: list.map((x) => x.dlq_id),
      count: scope === "filter" ? (total ?? 0) : list.length,
      consumers:
        scope === "filter"
          ? [consumer]
          : [...new Set(list.map((x) => x.consumer))],
      replayed: scope === "filter" ? state !== "present" : list.some((x) => x.state === "replayed"),
    });
  const selected = (items ?? []).filter((x) => sel.has(x.dlq_id));
  const byFilterOk =
    !!consumer && total != null && total > 0 && total <= DLQ_FILTER_MAX;

  return (
    <div className="stack" data-testid="mon-dlq">
      <section className="panel" aria-labelledby="mon-dlq-h">
        <div className="panel-h">
          <h2 className="panel-t" id="mon-dlq-h">
            <Icon name="inbox" />
            {t("mon.dlq.t")}
          </h2>
          <span className="panel-sub">{t("mon.dlq.sub")}</span>
          <span className="grow" />
          {total != null && (
            <span className="small" data-testid="mon-dlq-total">
              {t("mon.dlq.total", { n: fmt.num(total) })}
            </span>
          )}
        </div>
        <div className="panel-b">
          <div
            className="mon-dlq-filters"
            role="group"
            aria-label={t("mon.dlq.filters")}
          >
            <div className="field">
              <label htmlFor="dlq-consumer">{t("mon.dlq.f.consumer")}</label>
              <Select
                id="dlq-consumer"
                label={t("mon.dlq.f.consumer")}
                value={consumer}
                options={consumerOpts}
                onChange={setConsumer}
                testId="dlq-consumer"
              />
            </div>
            <div className="field">
              <label htmlFor="dlq-et">{t("mon.dlq.f.eventType")}</label>
              <input
                id="dlq-et"
                className={cx("input", etBad && "is-invalid")}
                placeholder={t("mon.dlq.f.eventTypePh")}
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                aria-invalid={etBad || undefined}
                data-testid="dlq-et"
              />
            </div>
            <div className="field">
              <label htmlFor="dlq-source">{t("mon.dlq.f.source")}</label>
              <Select
                id="dlq-source"
                label={t("mon.dlq.f.source")}
                value={source}
                onChange={setSource}
                testId="dlq-source"
                options={[
                  { v: "", label: t("mon.dlq.src.all") },
                  { v: "dlq", label: t("mon.dlq.src.dlq") },
                  { v: "legacy", label: t("mon.dlq.src.legacy") },
                ]}
              />
            </div>
            <div className="field">
              <label htmlFor="dlq-state">{t("mon.dlq.f.state")}</label>
              <Select
                id="dlq-state"
                label={t("mon.dlq.f.state")}
                value={state}
                onChange={setState}
                testId="dlq-state"
                options={[
                  { v: "present", label: t("mon.dlq.st.present") },
                  { v: "replayed", label: t("mon.dlq.st.replayed") },
                  { v: "all", label: t("mon.dlq.st.all") },
                ]}
              />
            </div>
            <div className="field">
              <label htmlFor="dlq-from">{t("mon.dlq.f.from")}</label>
              <input
                id="dlq-from"
                className={cx("input mono", fromIso === null && "is-invalid")}
                inputMode="numeric"
                autoComplete="off"
                placeholder={t("mon.dlq.f.dtFormat")}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-invalid={fromIso === null || undefined}
                aria-describedby="dlq-period-fmt"
                data-testid="dlq-from"
              />
            </div>
            <div className="field">
              <label htmlFor="dlq-to">{t("mon.dlq.f.to")}</label>
              <input
                id="dlq-to"
                className={cx("input mono", toIso === null && "is-invalid")}
                inputMode="numeric"
                autoComplete="off"
                placeholder={t("mon.dlq.f.dtFormat")}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-invalid={toIso === null || undefined}
                aria-describedby="dlq-period-fmt"
                data-testid="dlq-to"
              />
            </div>
            <div className="mon-dlq-reset">
              {filtered && (
                <Btn
                  size="sm"
                  kind="ghost"
                  icon="x"
                  label={t("common.reset")}
                  onClick={() => {
                    setConsumer("");
                    setEventType("");
                    setSource("");
                    setState("present");
                    setFrom("");
                    setTo("");
                  }}
                  testId="dlq-reset"
                />
              )}
            </div>
          </div>
          <p className="xs muted mon-dlq-fmt" id="dlq-period-fmt">
            {t("mon.dlq.f.periodFmt", { f: t("mon.dlq.f.dtFormat") })}
          </p>
          <FieldErr msg={etBad ? t("mon.dlq.f.eventTypeBad") : periodBad ? t("mon.dlq.f.periodBad", { f: t("mon.dlq.f.dtFormat") }) : null} />
          {manage && (
            <div className="mon-dlq-acts" data-testid="dlq-acts">
              <span className="small" aria-live="polite">
                {sel.size
                  ? t("mon.dlq.selected", { n: sel.size })
                  : t("mon.dlq.selectHint")}
              </span>
              <span className="mon-dlq-btns">
                <Btn
                  size="sm"
                  icon="refresh"
                  label={t("mon.dlq.replaySel", { n: sel.size })}
                  disabled={!sel.size}
                  onClick={() => ask("replay", "selected", selected)}
                  perm="ops.queues.manage"
                  testId="dlq-replay-sel"
                />
                <Btn
                  size="sm"
                  kind="danger-ghost"
                  icon="x"
                  label={t("mon.dlq.deleteSel", { n: sel.size })}
                  disabled={!sel.size}
                  onClick={() => ask("delete", "selected", selected)}
                  perm="ops.queues.manage"
                  testId="dlq-delete-sel"
                />
                {consumer && (
                  <>
                    <span className="mon-dlq-sep" aria-hidden="true" />
                    <Btn
                      size="sm"
                      icon="refresh"
                      label={t("mon.dlq.replayAll", { n: fmt.num(total ?? 0) })}
                      disabled={!byFilterOk}
                      title={
                        !byFilterOk && (total ?? 0) > DLQ_FILTER_MAX
                          ? t("mon.dlq.tooMany", { max: DLQ_FILTER_MAX })
                          : undefined
                      }
                      onClick={() => ask("replay", "filter", [])}
                      perm="ops.queues.manage"
                      testId="dlq-replay-all"
                    />
                    <Btn
                      size="sm"
                      kind="danger-ghost"
                      icon="x"
                      label={t("mon.dlq.deleteAll", { n: fmt.num(total ?? 0) })}
                      disabled={!byFilterOk}
                      onClick={() => ask("delete", "filter", [])}
                      perm="ops.queues.manage"
                      testId="dlq-delete-all"
                    />
                  </>
                )}
              </span>
            </div>
          )}
        </div>
        {error ? (
          <div className="panel-b">
            <LoadError
              error={error}
              onRetry={() => void load(filters, null)}
              testId="dlq-error"
            />
          </div>
        ) : !items ? (
          <Spinner label={t("common.loading")} />
        ) : !items.length ? (
          <Empty
            icon="checkCircle"
            title={filtered ? t("mon.dlq.emptyFT") : t("mon.dlq.emptyT")}
            text={filtered ? t("mon.dlq.emptyFM") : t("mon.dlq.emptyM")}
            testId="dlq-empty"
          />
        ) : (
          <div className="table-wrap">
            <table className="tbl mon-dlq-tbl" aria-busy={loading}>
              <thead>
                <tr>
                  {manage && (
                    <th className="chk">
                      <input
                        type="checkbox"
                        aria-label={t("mon.dlq.selectPage")}
                        checked={allOnPage}
                        disabled={!selectable.length}
                        onChange={() =>
                          setSel(
                            allOnPage
                              ? new Set()
                              : new Set(
                                  selectable
                                    .slice(0, DLQ_BATCH_MAX)
                                    .map((x) => x.dlq_id),
                                ),
                          )
                        }
                        data-testid="dlq-select-page"
                      />
                    </th>
                  )}
                  <th>{t("mon.dlq.col.dead")}</th>
                  <th>{t("mon.dlq.col.consumer")}</th>
                  <th>{t("mon.dlq.col.event")}</th>
                  <th>{t("mon.dlq.col.reason")}</th>
                  <th className="num">{t("mon.dlq.col.deliveries")}</th>
                  <th className="num">{t("mon.dlq.col.replays")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((x) => (
                  <tr
                    key={x.dlq_id}
                    className={cx(
                      "is-click",
                      sel.has(x.dlq_id) && "is-selected",
                      atReplayLimit(x) && "is-limit",
                    )}
                    tabIndex={0}
                    onClick={() => setOpen(x)}
                    onKeyDown={(e) =>
                      e.key === "Enter" &&
                      e.target === e.currentTarget &&
                      setOpen(x)
                    }
                    data-testid="dlq-row"
                    data-dlq={x.dlq_id}
                  >
                    {manage && (
                      <td className="chk" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={atReplayLimit(x) ? t("mon.dlq.limitSel", { id: x.dlq_id }) : t("mon.dlq.select", { id: x.dlq_id })}
                          title={atReplayLimit(x) ? t("mon.dlq.limitH") : undefined}
                          checked={sel.has(x.dlq_id)}
                          disabled={atReplayLimit(x)}
                          onChange={() => toggle(x.dlq_id)}
                          data-testid="dlq-check"
                        />
                      </td>
                    )}
                    <td className="nowrap" data-label={t("mon.dlq.col.dead")}>
                      {fmt.dateTime(x.dead_at)}
                      <span className="block xs muted">
                        {fmt.rel(x.dead_at)}
                      </span>
                    </td>
                    <td data-label={t("mon.dlq.col.consumer")}>
                      <span className="mono small">{x.consumer}</span>
                      <span className="block xs muted">
                        {x.service ?? "—"}{" "}
                        {x.source === "legacy" && (
                          <span className="tag">
                            {t("mon.dlq.src.legacyShort")}
                          </span>
                        )}
                      </span>
                    </td>
                    <td data-label={t("mon.dlq.col.event")}>
                      <span className="mono small">{x.event_type ?? "—"}</span>
                      {x.event_id && (
                        <span className="block xs muted mono">
                          {shortId(x.event_id, 8, 4)}
                        </span>
                      )}
                    </td>
                    <td data-label={t("mon.dlq.col.reason")}>
                      <Reason r={x.reason_class} />
                    </td>
                    <td className="num" data-label={t("mon.dlq.col.deliveries")}>
                      {x.deliveries == null ? "—" : fmt.num(x.deliveries)}
                    </td>
                    <td className="num" data-label={t("mon.dlq.col.replays")}>
                      {atReplayLimit(x) ? (
                        <span className="tag is-warn nowrap" title={t("mon.dlq.limitH")} data-testid="dlq-limit">
                          <Icon name="ban" /> {t("mon.dlq.limit", { n: fmt.num(x.replays) })}
                        </span>
                      ) : x.replays ? (
                        <b>{fmt.num(x.replays)}</b>
                      ) : (
                        "0"
                      )}
                      {x.state === "replayed" && (
                        <span
                          className="block xs muted nowrap"
                          title={x.replayed_at ? t("mon.dlq.replayedAt", { when: fmt.dateTime(x.replayed_at) }) : undefined}
                          data-testid="dlq-replayed"
                        >
                          <Icon name="refresh" /> {t("mon.dlq.replayedTag")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <div className="pager">
            <span />
            <Btn
              size="sm"
              icon="down"
              label={t("common.loadMore")}
              busy={loading}
              onClick={() => void load(filters, cursor)}
              testId="dlq-more"
            />
          </div>
        )}
        <div className="panel-f ai-foot">
          <Icon name="shield" /> {t("mon.dlq.foot")}
        </div>
      </section>

      <DlqHistory key={historyKey} />

      {open && (
        <DlqDrawer
          item={open}
          manage={manage}
          onClose={() => setOpen(null)}
          onCommand={(kind) => ask(kind, "one", [open])}
        />
      )}
      {pending && (
        <CommandDialog
          p={pending}
          filter={
            pending.scope === "filter"
              ? {
                  // перепроверка 8: фильтр команды = параметры списка (что оператор видит), total вида = число
                  consumer,
                  ...(filters.event_type
                    ? { event_type: filters.event_type }
                    : {}),
                  ...(source ? { source } : {}),
                  state,
                  ...(filters.dead_from
                    ? { dead_from: filters.dead_from }
                    : {}),
                  ...(filters.dead_to ? { dead_to: filters.dead_to } : {}),
                }
              : null
          }
          blocked={
            pending.kind === "replay"
              ? replayBlocked(
                  pending.scope === "filter"
                    ? [{ consumer } as DlqItem]
                    : (items ?? []).filter((x) =>
                        pending.ids.includes(x.dlq_id),
                      ),
                  replayable,
                )
              : []
          }
          onClose={() => setPending(null)}
          onDone={() => {
            setPending(null);
            after();
          }}
          onReload={() => {
            setPending(null);
            void load(filters, null);
          }}
        />
      )}
    </div>
  );
}

function DlqDrawer({
  item,
  manage,
  onClose,
  onCommand,
}: {
  item: DlqItem;
  manage: boolean;
  onClose: () => void;
  onCommand: (k: Kind) => void;
}) {
  const i = useI18n();
  const { t, fmt } = i;
  const [d, setD] = useState<DlqDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!manage) return;
    let live = true;
    OpsApi.dlqMessage(item.dlq_id)
      .then((x) => live && setD(x))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [item.dlq_id, manage]);
  return (
    <Drawer
      wide
      title={item.event_type ?? t("mon.dlq.message")}
      sub={
        <>
          <span className="mono">{item.dlq_id}</span>
          <span>· {item.consumer}</span>
        </>
      }
      onClose={onClose}
      testId="dlq-drawer"
      footer={
        <>
          <Btn label={t("common.close")} onClick={onClose} />
          <span className="grow" />
          <Btn
            kind="danger-ghost"
            icon="x"
            label={t("mon.dlq.delete")}
            perm="ops.queues.manage"
            onClick={() => onCommand("delete")}
            testId="dlq-drawer-delete"
          />
          <Btn
            kind="primary"
            icon="refresh"
            label={t("mon.dlq.replay")}
            perm="ops.queues.manage"
            disabled={atReplayLimit(item)}
            title={atReplayLimit(item) ? t("mon.dlq.limitH") : undefined}
            onClick={() => onCommand("replay")}
            testId="dlq-drawer-replay"
          />
        </>
      }
    >
      <div className="stack">
        <dl className="kv mon-kv">
          <dt>{t("mon.dlq.col.consumer")}</dt>
          <dd className="mono">
            {item.consumer}{" "}
            <span className="xs muted">· {item.service ?? "—"}</span>
          </dd>
          <dt>{t("mon.dlq.col.event")}</dt>
          <dd className="mono">
            {item.event_type ?? "—"}
            {item.event_id && (
              <span className="block xs muted">{item.event_id}</span>
            )}
          </dd>
          <dt>{t("mon.dlq.col.reason")}</dt>
          <dd>
            <Reason r={item.reason_class} />
          </dd>
          <dt>{t("mon.dlq.occurred")}</dt>
          <dd>{item.occurred_at ? fmt.dateTime(item.occurred_at) : "—"}</dd>
          <dt>{t("mon.dlq.col.dead")}</dt>
          <dd>{fmt.dateTime(item.dead_at)}</dd>
          <dt>{t("mon.dlq.col.deliveries")}</dt>
          <dd>
            {item.deliveries ?? "—"} ·{" "}
            {t("mon.dlq.replaysN", { n: item.replays })}
            {item.state === "replayed" && (
              <span className="block xs" data-testid="dlq-drawer-replayed">
                <Icon name="refresh" />{" "}
                {item.replayed_at
                  ? t("mon.dlq.replayedAt", { when: fmt.dateTime(item.replayed_at) })
                  : t("mon.dlq.replayedTag")}
              </span>
            )}
          </dd>
          <dt>{t("mon.dlq.source")}</dt>
          <dd>
            {item.source === "legacy"
              ? t("mon.dlq.src.legacy")
              : t("mon.dlq.src.dlq")}
          </dd>
        </dl>
        <section className="mon-sec" aria-labelledby="dlq-env-h">
          <div className="mon-sec-h">
            <h3 id="dlq-env-h">{t("mon.dlq.envelope")}</h3>
            <span className="grow" />
            {d && d.masked_fields.length > 0 && (
              <Pill tone="info" dot={false} testId="dlq-masked-n">
                <Icon name="eyeOff" />{" "}
                {t("mon.dlq.maskedN", { n: d.masked_fields.length })}
              </Pill>
            )}
          </div>
          {!manage ? (
            <Locked
              title={t("mon.dlq.lockedT")}
              text={t("mon.dlq.lockedM")}
              testId="dlq-locked"
            />
          ) : error ? (
            <LoadError error={error} testId="dlq-detail-error" />
          ) : !d ? (
            <Spinner label={t("common.loading")} />
          ) : !d.envelope_readable || !d.envelope_masked ? (
            <Callout kind="warn" icon="alert" testId="dlq-unreadable">
              {t("mon.dlq.unreadable")}
            </Callout>
          ) : (
            <>
              <MaskedJson value={d.envelope_masked} testId="dlq-envelope" />
              <p className="xs muted row">
                <Icon name="shield" /> {t("mon.dlq.maskNote")}
              </p>
            </>
          )}
        </section>
      </div>
    </Drawer>
  );
}

function CommandDialog({
  p,
  filter,
  blocked,
  onClose,
  onDone,
  onReload,
}: {
  p: Pending;
  filter: DlqCommand["filter"] | null;
  blocked: string[];
  onClose: () => void;
  onDone: () => void;
  /** close and re-read the list (the view changed under the operator) */
  onReload: () => void;
}) {
  const i = useI18n();
  const { t, fmt } = i;
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const count = p.count;
  /** 409: the view changed — the number is not substituted silently, the operator re-reads the list */
  const [changed, setChanged] = useState<{ actual: number | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DlqCommandResult | null>(null);
  // по фильтру в представлении «уже повторены» / «все» — сразу включая повторённые (иначе число не сойдётся)
  const [includeReplayed, setIncludeReplayed] = useState(p.scope === "filter" && p.replayed);
  // one Idempotency-Key for this open dialog: a repeat (network error, step-up, audit down) is the same command;
  // a new key only when the command itself changes (the count by filter changed)
  const idem = useRef(`dlq-${p.kind}-${uuid()}`);
  const del = p.kind === "delete";
  const ok = !changed && reason.trim().length >= 3 && countConfirmed(typed, count);
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const body: DlqCommand = filter
        ? { filter, expected_count: count, reason: reason.trim() }
        : { ids: p.ids, reason: reason.trim() };
      if (!del && includeReplayed) body.include_replayed = true;
      const r = await OpsApi.dlqCommand(p.kind, body, idem.current);
      // the result dialog is the feedback (done / skipped / action id) — no toast over the history «Result» column
      setResult(r);
    } catch (e) {
      if (e instanceof ApiError && e.cancelled) setErr(t("stepup.cancelled"));
      else if (e instanceof ApiError && e.code === "DLQ_COUNT_CHANGED") {
        setChanged({ actual: e.num("actual") });
        setTyped("");
      } else if (e instanceof ApiError && e.code === "AUDIT_UNAVAILABLE")
        setErr(t("mon.dlq.auditDown"));
      else setErr(errText(i, e));
    } finally {
      setBusy(false);
    }
  };
  if (result)
    return (
      <Modal
        title={t(del ? "mon.dlq.resDelT" : "mon.dlq.resReplayT")}
        icon={result.skipped.length ? "alert" : "checkCircle"}
        tone={result.skipped.length ? "warn" : ""}
        onClose={onDone}
        testId="dlq-result"
        footer={
          <Btn
            kind="primary"
            label={t("common.close")}
            onClick={onDone}
            testId="dlq-result-close"
          />
        }
      >
        <p data-testid="dlq-result-sum">
          {t("mon.dlq.resSum", {
            done: fmt.num(result.done),
            n: fmt.num(result.requested),
            skipped: fmt.num(result.skipped.length),
          })}
        </p>
        {result.skipped.length > 0 && (
          <ul className="mon-skipped" data-testid="dlq-skipped">
            {result.skipped.slice(0, 20).map((s) => (
              <li key={s.dlq_id}>
                <span className="mono">{s.dlq_id}</span> —{" "}
                {tOr(i, `mon.dlq.skip.${s.reason}`, s.reason)}
              </li>
            ))}
            {result.skipped.length > 20 && (
              <li className="muted">
                {t("mon.dlq.andMore", { n: result.skipped.length - 20 })}
              </li>
            )}
          </ul>
        )}
        <p className="xs muted">
          {t("mon.dlq.actionId")}{" "}
          <span className="mono">{result.action_id}</span>
        </p>
      </Modal>
    );
  return (
    <Modal
      title={t(del ? "mon.dlq.delT" : "mon.dlq.replayT", { what: i.tp("mon.dlq.msgN", count) })}
      text={t(del ? "mon.dlq.delM" : "mon.dlq.replayM")}
      icon={del ? "x" : "refresh"}
      tone={del ? "bad" : "warn"}
      onClose={() => !busy && onClose()}
      testId="dlq-confirm"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn
            kind={del ? "danger" : "primary"}
            label={t(del ? "mon.dlq.delete" : "mon.dlq.replay")}
            disabled={!ok}
            busy={busy}
            onClick={() => void submit()}
            testId="dlq-confirm-ok"
          />
        </>
      }
    >
      {changed && (
        <Callout kind="bad" icon="alertCircle" testId="dlq-count-changed">
          <b>{t("mon.dlq.changedT", { seen: fmt.num(count), actual: changed.actual == null ? "—" : fmt.num(changed.actual) })}</b>
          <span className="block">{t("mon.dlq.changedM")}</span>
          <span className="block mt-8">
            <Btn size="sm" icon="refresh" label={t("mon.dlq.reread")} onClick={onReload} testId="dlq-reread" />
          </span>
        </Callout>
      )}
      <dl className="kv mon-kv">
        <dt>{t("mon.dlq.scope")}</dt>
        <dd>
          {p.scope === "filter"
            ? t("mon.dlq.scopeFilter")
            : t("mon.dlq.scopeIds", { n: p.ids.length })}
        </dd>
        <dt>{t("mon.dlq.col.consumer")}</dt>
        <dd className="mono small">{p.consumers.join(", ")}</dd>
        {filter && (
            <>
              <dt>{t("mon.dlq.filters")}</dt>
              <dd className="small" data-testid="dlq-confirm-filter">
                {[
                  t(`mon.dlq.st.${filter.state ?? "present"}`),
                  filter.source && t(filter.source === "legacy" ? "mon.dlq.src.legacy" : "mon.dlq.src.dlq"),
                  filter.event_type,
                  filter.dead_from && `≥ ${fmt.dateTime(filter.dead_from)}`,
                  filter.dead_to && `≤ ${fmt.dateTime(filter.dead_to)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </dd>
            </>
          )}
      </dl>
      {blocked.length > 0 && (
        <Callout kind="warn" icon="alert" testId="dlq-replay-blocked">
          {t("mon.dlq.replayBlocked", { c: blocked.join(", ") })}
        </Callout>
      )}
      {!del && <p className="small muted">{t("mon.dlq.replayNote")}</p>}
      {!del && p.replayed && (
        <div className="field">
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeReplayed}
              onChange={(e) => {
                setIncludeReplayed(e.target.checked);
                // другая команда — новый ключ идемпотентности
                idem.current = `dlq-${p.kind}-${uuid()}`;
              }}
              data-testid="dlq-include-replayed"
            />{" "}
            {t("mon.dlq.includeReplayed")}
          </label>
          <p className="xs muted">{t("mon.dlq.includeReplayedH")}</p>
        </div>
      )}
      <div className="field">
        <label htmlFor="dlq-reason" className="req">
          {t("cmd.reason")}
        </label>
        <textarea
          id="dlq-reason"
          className="textarea"
          rows={2}
          maxLength={300}
          data-autofocus=""
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("mon.dlq.reasonPh")}
          data-testid="dlq-reason"
        />
      </div>
      <div className="field">
        <label htmlFor="dlq-typed" className="req">
          {t("mon.dlq.typeCount", { n: count })}
        </label>
        <input
          id="dlq-typed"
          className={cx(
            "input mono",
            typed && !countConfirmed(typed, count) && "is-invalid",
          )}
          inputMode="numeric"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={!!changed}
          autoComplete="off"
          data-testid="dlq-typed"
        />
      </div>
      <FieldErr msg={err} />
      <p className="xs muted row">
        <Icon name="smartphoneKey" /> {t("dsc.stepUpNote")}
      </p>
      <p className="xs muted row">
        <Icon name="audit" /> {t("cmd.auditNote")}
      </p>
    </Modal>
  );
}

function DlqHistory() {
  const { t, fmt } = useI18n();
  const [items, setItems] = useState<DlqAction[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async (more: string | null) => {
    try {
      const p = await OpsApi.dlqActions(more);
      setItems((xs) => (more && xs ? [...xs, ...p.items] : p.items));
      setCursor(p.next_cursor);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => void load(null), [load]);
  return (
    <section
      className="panel"
      aria-labelledby="dlq-hist-h"
      data-testid="dlq-history"
    >
      <div className="panel-h">
        <h2 className="panel-t" id="dlq-hist-h">
          <Icon name="audit" />
          {t("mon.dlq.hist.t")}
        </h2>
      </div>
      {error ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load(null)} />
        </div>
      ) : !items ? (
        <Spinner label={t("common.loading")} />
      ) : !items.length ? (
        <Empty icon="audit" title={t("mon.dlq.hist.emptyT")} />
      ) : (
        <div className="table-wrap">
          <table className="tbl compact mon-dlq-hist-tbl">
            <thead>
              <tr>
                <th>{t("mon.dlq.hist.when")}</th>
                <th>{t("mon.dlq.hist.what")}</th>
                <th>{t("mon.dlq.hist.who")}</th>
                <th>{t("cmd.reason")}</th>
                <th className="num">{t("mon.dlq.hist.result")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.action_id} data-testid="dlq-hist-row">
                  <td className="nowrap small" data-label={t("mon.dlq.hist.when")}>{fmt.dateTime(a.at)}</td>
                  <td data-label={t("mon.dlq.hist.what")}>
                    <Pill tone={a.kind === "delete" ? "bad" : "info"}>
                      {t(
                        a.kind === "delete"
                          ? "mon.dlq.delete"
                          : "mon.dlq.replay",
                      )}
                    </Pill>
                    <span className="block xs muted mono">
                      {a.selector.filter
                        ? `${a.selector.filter.consumer}${a.selector.filter.event_type ? ` · ${a.selector.filter.event_type}` : ""}`
                        : (a.selector.ids ?? []).slice(0, 3).join(", ") +
                          ((a.selector.ids?.length ?? 0) > 3
                            ? ` +${a.selector.ids!.length - 3}`
                            : "")}
                    </span>
                  </td>
                  <td className="small" data-label={t("mon.dlq.hist.who")}>
                    {a.by_name ??
                      (a.by.length > 20 ? shortId(a.by, 8, 4) : a.by)}
                  </td>
                  <td className="small" data-label={t("cmd.reason")}>«{a.reason}»</td>
                  <td className="num small" data-label={t("mon.dlq.hist.result")}>
                    {t("mon.dlq.hist.done", { done: a.done, n: a.requested })}
                    {a.skipped.length > 0 && (
                      <span className="block xs muted">
                        {t("mon.dlq.hist.skipped", { n: a.skipped.length })}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <div className="pager">
          <span />
          <Btn
            size="sm"
            icon="down"
            label={t("common.loadMore")}
            onClick={() => void load(cursor)}
          />
        </div>
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewBulkResult, ReviewDetail, ReviewItem, ReviewRejectReason, ReviewStatus } from "@tilhero/contracts/admin";
import { ReviewApi, type ReviewFilters } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { DICTS, useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { fmtPriceRange } from "../../lib/money";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, CopyBtn, cx, Empty, FieldErr, Pill, Reveal, Select, Spinner } from "../../ui/kit";
import { ConfirmCommand, Drawer, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errMeta, errText } from "../../ui/errors";
import {
  categoryLabel,
  countryName,
  countryOptions,
  domainOf,
  fmtLocalDate,
  httpsUrl,
  REJECT_REASONS,
  reasonHint,
  reasonLabel,
  reasonTone,
  REVIEW_STATUS_TONE,
  REVIEW_STATUSES,
} from "../catalog/common";
import { useNow } from "../../lib/useNow";
import { BULK_MAX, REVIEW_EXPIRE_DAYS, SELECTABLE, SKIP_CODES, daysLeft, pruneSelection, summarize, toggleAll, toggleOne, type BulkSummary } from "./bulk";
import { buildCorrection, changeField, CURRENCIES, formFromFacts, rebaseForm, readFacts, type CorrectionErrors, type CorrectionField, type CorrectionForm, type Facts } from "./facts";

/** Row severity bar: the worst reason of the candidate. */
export function rowSeverity(reasons: readonly string[]): "sev-bad" | "sev-warn" | "sev-info" {
  const tones = reasons.map(reasonTone);
  return tones.includes("bad") ? "sev-bad" : tones.includes("warn") ? "sev-warn" : "sev-info";
}

/** confidence 0..1 → "0.54"; below the AI threshold (0.6) the meter is amber */
export const fmtConfidence = (c: number | null | undefined) => (typeof c === "number" && Number.isFinite(c) ? Math.max(0, Math.min(1, c)).toFixed(2) : "—");

export function Confidence({ value }: { value: number }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <span className={cx("conf", v < 0.6 && "is-low")} title={fmtConfidence(v)}>
      <span className="conf-bar" aria-hidden="true">
        <i style={{ width: `${Math.round(v * 100)}%` }} />
      </span>
      <span className="mono">{fmtConfidence(v)}</span>
    </span>
  );
}

function ReasonPills({ reasons, max = 3 }: { reasons: readonly string[]; max?: number }) {
  const { t } = useI18n();
  const shown = reasons.slice(0, max);
  return (
    <span className="rv-reasons">
      {shown.map((r) => (
        <Pill key={r} tone={reasonTone(r)} title={r} dot={false}>
          {reasonLabel(t, r)}
        </Pill>
      ))}
      {reasons.length > max && (
        <span className="xs muted" title={reasons.slice(max).map((r) => reasonLabel(t, r)).join(", ")}>
          +{reasons.length - max}
        </span>
      )}
    </span>
  );
}

/** «Event review» (events.review): NEEDS_REVIEW candidates; accept / reject / correct with a source-backed basis. */
export function ReviewPage({ openId = null, onChanged }: { openId?: string | null; onChanged?: () => void }) {
  const i = useI18n();
  const { t, fmt, lang } = i;
  const [status, setStatus] = useState<ReviewStatus>("OPEN");
  const [country, setCountry] = useState("");
  const [rows, setRows] = useState<ReviewItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(openId);
  const [countries, setCountries] = useState<string[]>([]);
  useEffect(() => setOpen(openId), [openId]);
  const req = useRef(0);
  /* fix 5.1: selected rows (id → content_hash the operator saw), bulk dialogs, the outcome of the last bulk command */
  const [sel, setSel] = useState<Map<string, string>>(() => new Map());
  const [bulk, setBulk] = useState<"reject" | "reopen" | null>(null);
  const [reopenRow, setReopenRow] = useState<ReviewItem | null>(null);
  const [outcome, setOutcome] = useState<{ kind: "reject" | "reopen"; sum: BulkSummary; titles: Record<string, string> } | null>(null);
  const selectable = SELECTABLE.has(status);
  const now = useNow(status === "OPEN");
  const allBox = useRef<HTMLInputElement>(null);
  const allSel = rows.length > 0 && rows.every((r) => sel.has(r.review_id));
  const someSel = !allSel && rows.some((r) => sel.has(r.review_id));
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = someSel;
  }, [someSel, selectable]);

  const filters: ReviewFilters = { status, country: country || undefined };
  const fKey = JSON.stringify(filters);

  const load = useCallback(async (f: ReviewFilters, append: boolean) => {
    const id = ++req.current;
    setLoading(true);
    try {
      const p = await ReviewApi.list(f);
      if (id !== req.current) return;
      setRows((xs) => (append ? [...xs, ...p.items] : p.items));
      setCursor(p.next_cursor);
      setError(null);
      setCountries((cs) => [...new Set([...cs, ...p.items.map((x) => x.country_code ?? "")])].filter(Boolean));
    } catch (e) {
      if (id === req.current) setError(e);
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(JSON.parse(fKey) as ReviewFilters, false);
    setSel(new Map()); // another filter — another set of rows
    setOutcome(null);
  }, [fKey, load]);
  // a reload (decision elsewhere, refresh) keeps only the selected rows that are still listed
  useEffect(() => setSel((x) => (x.size ? pruneSelection(x, rows) : x)), [rows]);

  const reload = () => {
    void load(filters, false);
    onChanged?.();
  };

  const selected = rows.filter((r) => sel.has(r.review_id));
  const bulkDone = (kind: "reject" | "reopen", res: ReviewBulkResult) => {
    setBulk(null);
    setOutcome({ kind, sum: summarize(res), titles: Object.fromEntries(selected.map((r) => [r.review_id, r.title || r.review_id])) });
    setSel(new Map());
    reload();
  };

  return (
    <div data-testid="review">
      <div className="page-head">
        <div className="lead">
          <p>{t("rv.lead")}</p>
        </div>
      </div>
      <div className="toolbar">
        <Select
          id="rv-status"
          label={t("rv.f.status")}
          value={status}
          onChange={setStatus}
          testId="rv-status"
          options={REVIEW_STATUSES.map((s) => ({ v: s, label: t(`rv.st.${s}` as MessageKey) }))}
        />
        <Select
          id="rv-country"
          label={t("rv.f.country")}
          value={country}
          onChange={setCountry}
          testId="rv-country"
          options={[{ v: "", label: t("rv.f.allCountries") }, ...countryOptions(lang, countries).map((c) => ({ v: c, label: countryName(lang, c) }))]}
        />
        <Btn kind="ghost" size="sm" label={t("common.resetFilters")} onClick={() => (setStatus("OPEN"), setCountry(""))} />
        <span className="grow" />
        <Btn icon="refresh" size="sm" label={t("common.refresh")} onClick={reload} busy={loading && rows.length > 0} testId="rv-refresh" />
      </div>
      {error ? (
        <div className="mb-12">
          <LoadError error={error} onRetry={reload} />
        </div>
      ) : null}
      {outcome && <BulkOutcome kind={outcome.kind} sum={outcome.sum} titles={outcome.titles} onClose={() => setOutcome(null)} />}
      <section className="panel" aria-label={t("page.review")} aria-busy={loading}>
        {selectable && sel.size > 0 && (
          <div className="rv-bulk" role="region" aria-label={t("rv.sel.region")} data-testid="rv-bulk">
            <span className="rv-bulk-n" data-testid="rv-bulk-n">
              <Icon name="check" />
              {t("rv.sel.n", { n: sel.size })}
            </span>
            <Btn kind="ghost" size="xs" label={t("rv.sel.clear")} onClick={() => setSel(new Map())} testId="rv-sel-clear" />
            <span className="grow" />
            {sel.size > BULK_MAX && <span className="xs rv-bulk-max">{t("rv.sel.max", { n: BULK_MAX })}</span>}
            {status === "OPEN" ? (
              <Btn kind="danger" size="sm" icon="ban" label={t("rv.bulk.reject", { n: sel.size })} perm="events.review" disabled={sel.size > BULK_MAX} onClick={() => setBulk("reject")} testId="rv-bulk-reject" />
            ) : (
              <Btn kind="primary" size="sm" icon="rollback" label={t("rv.bulk.reopen", { n: sel.size })} perm="events.review" disabled={sel.size > BULK_MAX} onClick={() => setBulk("reopen")} testId="rv-bulk-reopen" />
            )}
          </div>
        )}
        <div className="table-wrap">
          <table className="tbl" data-testid="review-table">
            <thead>
              <tr>
                {selectable && (
                  <th className="rv-cb">
                    <input
                      ref={allBox}
                      type="checkbox"
                      className="rv-check"
                      checked={allSel}
                      disabled={!rows.length}
                      aria-label={t("rv.sel.all")}
                      title={t("rv.sel.all")}
                      onChange={() => setSel((x) => toggleAll(x, rows))}
                      data-testid="rv-sel-all"
                    />
                  </th>
                )}
                <th>{t("rv.col.title")}</th>
                <th>{t("rv.col.when")}</th>
                <th>{t("rv.col.where")}</th>
                <th>{t("rv.col.source")}</th>
                <th>{t("rv.col.reasons")}</th>
                <th className="r">{t("rv.col.confidence")}</th>
                <th>{t("rv.col.received")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const checked = sel.has(r.review_id);
                const left = r.status === "OPEN" ? daysLeft(r.expires_at, now) : null;
                return (
                  <tr
                    key={r.review_id}
                    className={cx("is-click", rowSeverity(r.reasons), checked && "is-sel")}
                    tabIndex={0}
                    aria-label={t("common.openRow", { x: r.title || r.review_id })}
                    aria-selected={selectable ? checked : undefined}
                    onClick={() => setOpen(r.review_id)}
                    onKeyDown={(e) => e.target === e.currentTarget && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(r.review_id))}
                    data-review={r.review_id}
                  >
                    {selectable && (
                      // the cell is a label: a click anywhere in it toggles the row instead of opening the card
                      <td className="rv-cb" onClick={(e) => e.stopPropagation()}>
                        <label className="rv-cb-hit">
                          <input
                            type="checkbox"
                            className="rv-check"
                            checked={checked}
                            aria-label={t("rv.sel.row", { x: r.title || r.review_id })}
                            onChange={() => setSel((x) => toggleOne(x, r))}
                            data-testid="rv-sel"
                          />
                        </label>
                      </td>
                    )}
                    <td style={{ minWidth: 220 }}>
                      <div className="cell-main wrap-any">{r.title || <span className="muted">{t("rv.noTitle")}</span>}</div>
                      <div className="cell-sub">
                        {r.status !== "OPEN" && r.status !== "EXPIRED" && (
                          <>
                            <Pill tone={REVIEW_STATUS_TONE[r.status]}>{t(`rv.st.${r.status}` as MessageKey)}</Pill>{" "}
                          </>
                        )}
                        {r.source_name ?? r.provider}
                      </div>
                      {r.status === "EXPIRED" && (
                        <>
                          <div className="cell-sub rv-expired" data-testid="rv-expired-note">
                            <Icon name="clock" />
                            <span>{i.tp("rv.expiredRow", REVIEW_EXPIRE_DAYS)}</span>
                          </div>
                          {/* the row action lives in the title cell: no extra column, fits 400 px */}
                          <div className="rv-row-act" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                            <Btn size="xs" icon="rollback" label={t("rv.reopen")} aria={t("rv.reopenA", { x: r.title || r.review_id })} perm="events.review" onClick={() => setReopenRow(r)} testId="rv-row-reopen" />
                          </div>
                        </>
                      )}
                    </td>
                    <td className="nowrap">
                      <div className="cell-main">{fmtLocalDate(lang, r.start?.local_date)}</div>
                      <div className="cell-sub mono">{r.start?.local_time ?? t("rv.noTime")}</div>
                    </td>
                    <td>
                      <div className="cell-main">{r.city ?? "—"}</div>
                      <div className="cell-sub">{countryName(lang, r.country_code)}</div>
                    </td>
                    <td className="nowrap">
                      <div className="cell-main mono">{domainOf(r.source_url)}</div>
                      <div className="cell-sub">{t(`tier.${r.tier}` as MessageKey) || r.tier}</div>
                    </td>
                    <td style={{ minWidth: 180 }}>
                      <ReasonPills reasons={r.reasons} />
                    </td>
                    <td className="r">
                      <Confidence value={r.confidence} />
                    </td>
                    <td className="nowrap" title={fmt.dateTime(r.received_at)}>
                      <div>{fmt.rel(r.received_at)}</div>
                      {left !== null && (
                        <div className={cx("cell-sub rv-expires", left <= 1 && "is-soon")} title={t("rv.expiresTitle", { t: fmt.dateTime(r.expires_at) })} data-testid="rv-expires">
                          <Icon name="clock" />
                          <span>{left === 0 ? t("rv.expiresToday") : i.tp("rv.expiresIn", left)}</span>
                        </div>
                      )}
                      {r.status === "EXPIRED" && r.expired_at && <div className="cell-sub">{t("rv.expiredAt", { t: fmt.date(r.expired_at) })}</div>}
                    </td>
                  </tr>
                );
              })}
              {!loading && !rows.length && !error && (
                <tr>
                  <td colSpan={7 + (selectable ? 1 : 0)} className="empty-cell">
                    {status === "EXPIRED" && !country ? (
                      <Empty icon="checkCircle" title={t("rv.emptyExpired.t")} text={t("rv.emptyExpired.m")} testId="rv-empty" />
                    ) : status === "OPEN" && !country ? (
                      <Empty icon="checkCircle" title={t("rv.empty.t")} text={t("rv.empty.m")} testId="rv-empty" />
                    ) : (
                      <Empty icon="search" title={t("common.nothingFound")} text={t("common.changeFilters")} testId="rv-empty" />
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && <Spinner label={t("common.loading")} />}
        <div className="pager">
          <span>{t("rv.shown", { n: rows.length })}</span>
          {cursor && !loading && <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load({ ...filters, cursor }, true)} testId="rv-more" />}
        </div>
      </section>
      <p className="xs muted foot-note">
        <Icon name="audit" /> {t("rv.foot")}
      </p>
      {open && (
        <ReviewDrawer
          id={open}
          onClose={() => setOpen(null)}
          onDecided={() => {
            setOpen(null);
            reload();
          }}
          onStale={reload}
        />
      )}
      {bulk === "reject" && <BulkRejectDialog rows={selected} onClose={() => setBulk(null)} onDone={(res) => bulkDone("reject", res)} />}
      {bulk === "reopen" && <BulkReopenDialog rows={selected} onClose={() => setBulk(null)} onDone={(res) => bulkDone("reopen", res)} />}
      {reopenRow && (
        <ReopenDialog
          item={reopenRow}
          onClose={() => setReopenRow(null)}
          onConflict={() => {
            setReopenRow(null);
            reload();
          }}
          onDone={() => {
            setReopenRow(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

/** «Rejected N, skipped M» and why each skipped card was skipped (by reason, with the titles). */
function BulkOutcome({ kind, sum, titles, onClose }: { kind: "reject" | "reopen"; sum: BulkSummary; titles: Record<string, string>; onClose: () => void }) {
  const { t } = useI18n();
  const head = t(kind === "reject" ? "rv.res.rejectSum" : "rv.res.reopenSum", { done: sum.done, skipped: sum.skipped });
  return (
    <div className="mb-12" data-testid="rv-bulk-result">
      <Callout kind={sum.skipped ? "warn" : "good"} icon={sum.skipped ? "alert" : "checkCircle"}>
        <div className="rv-res">
          <div className="rv-res-b">
            <b data-testid="rv-bulk-result-sum">{head}</b>
            {sum.byCode.length > 0 && (
              <ul className="rv-skips">
                {sum.byCode.map((g) => {
                  const key = `rv.skip.${g.code}` as MessageKey;
                  const why = (SKIP_CODES as readonly string[]).includes(g.code) ? t(key) : t("rv.skip.other", { code: g.code });
                  const names = g.ids.map((id) => titles[id] ?? id);
                  return (
                    <li key={g.code} data-skip={g.code}>
                      <span className="b">{why}</span> <span className="muted">— {names.slice(0, 3).join(", ")}{names.length > 3 ? ` +${names.length - 3}` : ""}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <button type="button" className="btn ghost xs" onClick={onClose} aria-label={t("common.close")} data-testid="rv-bulk-result-close">
            <Icon name="x" />
          </button>
        </div>
      </Callout>
    </div>
  );
}

/** Bulk reject: one reason and one comment for all selected cards; each card is decided separately by events. */
function BulkRejectDialog({ rows, onClose, onDone }: { rows: ReviewItem[]; onClose: () => void; onDone: (r: ReviewBulkResult) => void }) {
  const i = useI18n();
  const { t } = i;
  // one key per action: a retry after a lost answer returns the same outcome instead of «already decided»
  const key = useRef(uuid());
  const [code, setCode] = useState<ReviewRejectReason | "">("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<{ code?: string; note?: string; form?: string; meta?: string }>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    const e: typeof err = {};
    if (!code) e.code = t("rv.err.rejectCode");
    if (note.trim().length < 3) e.note = t("rv.err.note");
    setErr(e);
    if (e.code || e.note || !code) return;
    setBusy(true);
    try {
      onDone(await ReviewApi.bulkReject(rows.map((r) => ({ review_id: r.review_id, expected_content_hash: r.content_hash })), code, note.trim(), key.current));
    } catch (x) {
      setBusy(false);
      setErr({ form: x instanceof ApiError && x.cancelled ? t("stepup.cancelled") : errText(i, x), meta: errMeta(x) });
    }
  };
  return (
    <Modal
      title={i.tp("rv.bulk.rejectT", rows.length)}
      text={t("rv.bulk.rejectM")}
      icon="ban"
      tone="bad"
      onClose={() => !busy && onClose()}
      testId="rv-bulk-reject-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn label={t("rv.bulk.rejectOk", { n: rows.length })} kind="danger" busy={busy} onClick={() => void submit()} testId="rv-bulk-reject-ok" />
        </>
      }
    >
      <BulkTitles rows={rows} />
      <div className="field">
        <label htmlFor="rv-bulk-code" className="req">
          {t("rv.rejectCode")}
        </label>
        <select
          id="rv-bulk-code"
          className={cx("select", err.code && "is-invalid")}
          value={code}
          data-autofocus=""
          aria-invalid={!!err.code}
          aria-describedby={err.code ? "rv-bulk-code-err" : undefined}
          onChange={(e) => (setCode(e.target.value as ReviewRejectReason), setErr((x) => ({ ...x, code: undefined })))}
          data-testid="rv-bulk-code"
        >
          <option value="">{t("rv.rejectPick")}</option>
          {REJECT_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`rv.rej.${r}` as MessageKey)}
            </option>
          ))}
        </select>
        <FieldErr msg={err.code} id="rv-bulk-code-err" />
      </div>
      <div className="field">
        <label htmlFor="rv-bulk-note" className="req">
          {t("rv.note")}
        </label>
        <textarea
          id="rv-bulk-note"
          className={cx("textarea", err.note && "is-invalid")}
          rows={3}
          maxLength={500}
          value={note}
          placeholder={t("rv.bulk.rejectPh")}
          aria-invalid={!!err.note}
          aria-describedby={err.note ? "rv-bulk-note-err" : undefined}
          onChange={(e) => (setNote(e.target.value), setErr((x) => ({ ...x, note: undefined })))}
          data-testid="rv-bulk-note"
        />
        <FieldErr msg={err.note} id="rv-bulk-note-err" />
      </div>
      {err.form && (
        <Callout kind="bad" icon="alertCircle" testId="rv-bulk-err">
          <b>{err.form}</b>
          {err.meta && <span className="xs muted block mono">{err.meta}</span>}
        </Callout>
      )}
      <p className="xs muted rv-audit">
        <Icon name="audit" />
        <span>{t("rv.bulk.audit")}</span>
      </p>
    </Modal>
  );
}

/** the selected titles inside a bulk dialog: the operator sees what exactly is decided */
function BulkTitles({ rows }: { rows: ReviewItem[] }) {
  const { t } = useI18n();
  const shown = rows.slice(0, 5);
  return (
    <ul className="rv-bulk-list" data-testid="rv-bulk-list">
      {shown.map((r) => (
        <li key={r.review_id} className="wrap-any">
          {r.title || t("rv.noTitle")} <span className="muted xs">· {r.source_name ?? r.provider}</span>
        </li>
      ))}
      {rows.length > shown.length && <li className="muted xs">{t("rv.bulk.more", { n: rows.length - shown.length })}</li>}
    </ul>
  );
}

/** Bulk back to the queue from «Not confirmed»: one comment for all; each card gets a fresh 7-day term. */
function BulkReopenDialog({ rows, onClose, onDone }: { rows: ReviewItem[]; onClose: () => void; onDone: (r: ReviewBulkResult) => void }) {
  const i = useI18n();
  const { t } = i;
  const key = useRef(uuid());
  const result = useRef<ReviewBulkResult | null>(null);
  return (
    <ConfirmCommand
      title={i.tp("rv.bulk.reopenT", rows.length)}
      text={t("rv.reopenM", { n: REVIEW_EXPIRE_DAYS })}
      icon="rollback"
      tone=""
      ok={t("rv.bulk.reopenOk", { n: rows.length })}
      reasonLabel={t("rv.note")}
      reasonPlaceholder={t("rv.reopenPh")}
      minReason={3}
      testId="rv-bulk-reopen-dialog"
      extra={<BulkTitles rows={rows} />}
      onClose={() => (result.current ? onDone(result.current) : onClose())}
      onConfirm={async (note) => {
        try {
          result.current = await ReviewApi.bulkReopen(
            rows.map((r) => r.review_id),
            note,
            key.current,
          );
          return null;
        } catch (e) {
          return e instanceof ApiError && e.cancelled ? t("stepup.cancelled") : errText(i, e);
        }
      }}
    />
  );
}

/** Back to the queue for one «Not confirmed» card (row button or the card drawer). */
function ReopenDialog({ item, onClose, onConflict, onDone }: { item: Pick<ReviewItem, "review_id" | "title">; onClose: () => void; onConflict: () => void; onDone: () => void }) {
  const i = useI18n();
  const { t } = i;
  const toast = useToast();
  const key = useRef(uuid());
  const ok = useRef(false);
  return (
    <ConfirmCommand
      title={t("rv.reopenT")}
      text={t("rv.reopenM", { n: REVIEW_EXPIRE_DAYS })}
      icon="rollback"
      tone=""
      ok={t("rv.reopenOk")}
      reasonLabel={t("rv.note")}
      reasonPlaceholder={t("rv.reopenPh")}
      minReason={3}
      testId="rv-reopen-dialog"
      onClose={() => (ok.current ? onDone() : onClose())}
      onConfirm={async (note) => {
        try {
          await ReviewApi.reopen(item.review_id, note, key.current);
          ok.current = true;
          toast(t("rv.reopenedOk"), "ok", item.title || undefined);
          return null;
        } catch (e) {
          if (e instanceof ApiError && e.code === "REVIEW_ALREADY_DECIDED") {
            toast(t("rv.reopenElsewhere"), "err", "409 REVIEW_ALREADY_DECIDED");
            onConflict();
            return null;
          }
          return e instanceof ApiError && e.cancelled ? t("stepup.cancelled") : errText(i, e);
        }
      }}
    />
  );
}

type Dialog = "accept" | "reject" | null;

function ReviewDrawer({ id, onClose, onDecided, onStale }: { id: string; onClose: () => void; onDecided: () => void; onStale: () => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const toast = useToast();
  const [item, setItem] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mode, setMode] = useState<"view" | "correct">("view");
  const [stale, setStale] = useState(false);
  /** 409 REVIEW_CHANGED: a newer candidate replaced the facts the operator was looking at */
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    try {
      setItem(await ReviewApi.get(id));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  /** 409 REVIEW_ALREADY_DECIDED: someone else decided first — say so, re-read the card and the list. */
  const decidedElsewhere = () => {
    toast(t("rv.decidedElsewhere"), "err", "409 REVIEW_ALREADY_DECIDED");
    setDialog(null);
    setMode("view");
    setStale(true);
    void load();
    onStale();
  };

  /** 409 REVIEW_CHANGED: say so, re-read the card (the correct form keeps the operator's edits) and the list. */
  const factsChanged = () => {
    toast(t("err.REVIEW_CHANGED"), "err", "409 REVIEW_CHANGED");
    setDialog(null);
    setChanged(true);
    void load();
    onStale();
  };

  const done = (msg: string, eventId?: string | null) => {
    toast(msg, "ok", eventId ? `event_id ${shortId(eventId, 8, 4)}` : undefined);
    onDecided();
  };

  // memoized: the correct form re-bases the operator's edits only when the facts really change
  const facts = useMemo(() => (item ? readFacts(item.facts) : null), [item]);
  const isOpen = item?.status === "OPEN";
  const isExpired = item?.status === "EXPIRED";
  const [reopen, setReopen] = useState(false);
  const src = item ? httpsUrl(item.source_url) : null;

  return (
    <Drawer
      wide
      testId="review-card"
      onClose={onClose}
      title={item ? item.title || t("rv.noTitle") : t("common.loading")}
      sub={
        item ? (
          <>
            <Pill tone={REVIEW_STATUS_TONE[item.status]}>{t(`rv.st.${item.status}` as MessageKey)}</Pill>
            <span>
              {item.source_name ?? item.provider} · {t("rv.receivedAt", { t: fmt.dateTime(item.received_at) })}
            </span>
          </>
        ) : undefined
      }
      footer={
        item && isOpen ? (
          mode === "view" ? (
            <>
              <Btn kind="danger-ghost" icon="ban" label={t("rv.reject")} perm="events.review" onClick={() => setDialog("reject")} testId="rv-reject" />
              <span className="grow" />
              <Btn icon="edit" label={t("rv.correct")} perm="events.review" onClick={() => setMode("correct")} testId="rv-correct" />
              <Btn kind="primary" icon="check" label={t("rv.accept")} perm="events.review" onClick={() => setDialog("accept")} testId="rv-accept" />
            </>
          ) : null
        ) : item && isExpired ? (
          <>
            <span className="grow" />
            <Btn kind="primary" icon="rollback" label={t("rv.reopen")} perm="events.review" onClick={() => setReopen(true)} testId="rv-reopen" />
          </>
        ) : undefined
      }
    >
      {error ? <LoadError error={error} onRetry={() => void load()} /> : null}
      {!item && !error && <Spinner label={t("common.loading")} />}
      {item && facts && stale && !isOpen && (
        <div className="mb-12">
          <Callout kind="warn" icon="alert" testId="rv-stale">
            {t("rv.decidedElsewhere")}
          </Callout>
        </div>
      )}
      {item && facts && changed && isOpen && mode === "view" && (
        <div className="mb-12">
          <Reveal dep={item.content_hash}>
            <Callout kind="warn" icon="refresh" testId="rv-changed">
              <b>{t("rv.changedT")}.</b> {t("rv.changedM")}
            </Callout>
          </Reveal>
        </div>
      )}
      {item && facts && mode === "correct" && isOpen ? (
        <CorrectForm
          item={item}
          facts={facts}
          changed={changed}
          onCancel={() => setMode("view")}
          onConflict={decidedElsewhere}
          onChanged={factsChanged}
          onDone={(eventId) => done(t("rv.correctedOk"), eventId)}
        />
      ) : item && facts ? (
        <div className="stack">
          <section aria-labelledby="rv-why">
            <h3 className="sec-h" id="rv-why">
              {t("rv.why")}
            </h3>
            <ul className="rv-why" data-testid="rv-reasons">
              {item.reasons.length ? (
                item.reasons.map((r) => (
                  <li key={r}>
                    <Pill tone={reasonTone(r)} dot={false} title={r}>
                      {reasonLabel(t, r)}
                    </Pill>
                    <span className="small ink2">{reasonHint(t, r) ?? <span className="mono xs">{r}</span>}</span>
                  </li>
                ))
              ) : (
                <li className="small muted">{t("rv.noReasons")}</li>
              )}
              <li>
                <span className="small muted">{t("rv.col.confidence")}</span>
                <Confidence value={item.confidence} />
              </li>
            </ul>
          </section>

          <section className="rv-source" aria-labelledby="rv-src-h">
            <h3 className="sec-h" id="rv-src-h">
              {t("rv.source")}
            </h3>
            <div className="rv-src-card">
              <div className="grow">
                <div className="rv-src-domain mono" data-testid="rv-domain">
                  {domainOf(item.source_url)}
                </div>
                <div className="xs muted">
                  {item.source_name ?? item.provider} · {t(`tier.${item.tier}` as MessageKey) || item.tier} · <span className="mono">{item.provider}</span>
                </div>
              </div>
              {src ? (
                <a className="btn sm" href={src.href} target="_blank" rel="noopener noreferrer" data-testid="rv-source-link" aria-label={t("rv.openSourceA", { d: domainOf(item.source_url) })}>
                  <Icon name="ext" />
                  <span>{t("rv.openSource")}</span>
                </a>
              ) : (
                <Pill tone="bad">{t("rv.notHttps")}</Pill>
              )}
            </div>
            <div className="xs muted wrap-any mt-8 mono">{item.source_url}</div>
          </section>

          <div className="rv-grid">
            <section aria-labelledby="rv-facts-h">
              <h3 className="sec-h" id="rv-facts-h">
                {t("rv.facts")}
              </h3>
              <FactsList facts={facts} country={item.country_code} />
            </section>
            <section aria-labelledby="rv-banner-h">
              <h3 className="sec-h" id="rv-banner-h">
                {t("rv.banner")}
              </h3>
              <Banner media={item.media[0] ?? null} />
            </section>
          </div>

          <section aria-labelledby="rv-match-h">
            <h3 className="sec-h" id="rv-match-h">
              {t("rv.match")}
            </h3>
            {item.matched_event_id ? (
              <div className="row" data-testid="rv-match">
                <Icon name="link" />
                <span>{t("rv.matchYes")}</span>
                <span className="code-chip" title={item.matched_event_id}>
                  {shortId(item.matched_event_id, 8, 4)}
                </span>
                <CopyBtn value={item.matched_event_id} label="event_id" />
              </div>
            ) : (
              <p className="small muted" data-testid="rv-match">
                {t("rv.matchNo")}
              </p>
            )}
          </section>

          {!isOpen && (
            <section aria-labelledby="rv-dec-h" data-testid="rv-decision">
              <h3 className="sec-h" id="rv-dec-h">
                {t("rv.decision")}
              </h3>
              <dl className="dl">
                <dt>{t("rv.f.status")}</dt>
                <dd>
                  <Pill tone={REVIEW_STATUS_TONE[item.status]}>{t(`rv.st.${item.status}` as MessageKey)}</Pill>
                </dd>
                <dt>{t("rv.decidedBy")}</dt>
                <dd className={item.decided_by_name || item.decided_by === "system" ? undefined : "mono"} data-testid="rv-decided-by">
                  {item.decided_by === "system" ? t("rv.system") : (item.decided_by_name ?? (item.decided_by ? shortId(item.decided_by, 8, 4) : "—"))}
                </dd>
                <dt>{t("rv.decidedAt")}</dt>
                <dd>{item.decided_at ? fmt.dateTime(item.decided_at) : "—"}</dd>
                {item.decision_reason && (
                  <>
                    <dt>{item.decision_reason === "AUTO_EXPIRED" ? t("rv.reasonAuto") : t("rv.rejectCode")}</dt>
                    <dd data-testid="rv-decision-reason">{item.decision_reason === "AUTO_EXPIRED" ? i.tp("rv.expiredRow", REVIEW_EXPIRE_DAYS) : t(`rv.rej.${item.decision_reason}` as MessageKey)}</dd>
                  </>
                )}
                <dt>{t("rv.note")}</dt>
                <dd>{item.decision_note ?? "—"}</dd>
                {item.event_id && (
                  <>
                    <dt>event_id</dt>
                    <dd className="mono">
                      {item.event_id} <CopyBtn value={item.event_id} label="event_id" />
                    </dd>
                  </>
                )}
              </dl>
            </section>
          )}
          {isOpen && (
            <p className="xs muted foot-note">
              <Icon name="info" /> {t("rv.decideNote")}
              {item.expires_at && !Number.isNaN(Date.parse(item.expires_at)) && <> {t("rv.expiresTitle", { t: fmt.dateTime(item.expires_at) })}</>}
            </p>
          )}
        </div>
      ) : null}

      {dialog === "accept" && item && <AcceptDialog item={item} onClose={() => setDialog(null)} onConflict={decidedElsewhere} onChanged={factsChanged} onDone={(eid) => done(t("rv.acceptedOk"), eid)} />}
      {reopen && item && (
        <ReopenDialog
          item={item}
          onClose={() => setReopen(false)}
          onConflict={() => {
            setReopen(false);
            setStale(true);
            void load();
            onStale();
          }}
          onDone={onDecided}
        />
      )}
      {dialog === "reject" && item && <RejectDialog item={item} onClose={() => setDialog(null)} onConflict={decidedElsewhere} onChanged={factsChanged} onDone={() => done(t("rv.rejectedOk"))} />}
    </Drawer>
  );
}

function FactsList({ facts, country }: { facts: Facts; country: string | null }) {
  const { t, lang } = useI18n();
  const when = (w: Facts["start"]) => (w ? `${fmtLocalDate(lang, w.local_date)}${w.local_time ? ` · ${w.local_time}` : ""}` : "—");
  return (
    <dl className="dl" data-testid="rv-facts">
      <dt>{t("rv.fact.start")}</dt>
      <dd>
        {when(facts.start)}
        <span className="xs muted block">{t("rv.localTime")}</span>
      </dd>
      {facts.end && (
        <>
          <dt>{t("rv.fact.end")}</dt>
          <dd>{when(facts.end)}</dd>
        </>
      )}
      <dt>{t("rv.fact.venue")}</dt>
      <dd>{facts.venue?.name || "—"}</dd>
      <dt>{t("rv.fact.city")}</dt>
      <dd>
        {facts.venue?.city || "—"}
        {(facts.venue?.country_code ?? country) && <span className="muted">, {countryName(lang, facts.venue?.country_code ?? country)}</span>}
      </dd>
      <dt>{t("rv.fact.address")}</dt>
      <dd>{facts.venue?.address || "—"}</dd>
      <dt>{t("rv.fact.price")}</dt>
      <dd className="mono" data-testid="rv-price">
        {facts.price ? fmtPriceRange(facts.price, lang) : <span className="muted">{t("rv.noPrice")}</span>}
      </dd>
      <dt>{t("rv.fact.online")}</dt>
      <dd>{facts.online ? t("common.yes") : t("common.no")}</dd>
      <dt>{t("rv.fact.categories")}</dt>
      <dd>{facts.categories.length ? facts.categories.map((c) => categoryLabel(t, c)).join(", ") : "—"}</dd>
    </dl>
  );
}

/** media rights code → «official site» / «provider API»; an unknown code is shown as is */
export function rightsLabel(t: (k: MessageKey) => string, rights: string): string {
  const key = `rv.rights.${rights}` as MessageKey;
  return key in DICTS.ru ? t(key) : rights;
}

/** Banner of the candidate: https only, no referrer to the source's CDN; anything else → a placeholder. */
export function Banner({ media }: { media: ReviewDetail["media"][number] | null }) {
  const { t } = useI18n();
  const url = httpsUrl(media?.url);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [media?.url]);
  if (!url || failed)
    return (
      <div className="rv-banner is-empty" data-testid="rv-banner-empty">
        <Icon name="image" />
        <span>{!media ? t("rv.bannerNone") : !url ? t("rv.bannerUnsafe") : t("rv.bannerFailed")}</span>
      </div>
    );
  return (
    <figure className="rv-banner" data-testid="rv-banner">
      <img src={url.href} alt={t("rv.bannerAlt", { d: url.hostname })} referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      <figcaption className="xs muted">
        {t("rv.photoFrom", { d: url.hostname.replace(/^www\./, "") })}
        {media?.provenance?.rights ? (
          <span className="tag" title={media.provenance.rights} data-testid="rv-rights">
            {rightsLabel(t, media.provenance.rights)}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

type DecisionProps = { item: ReviewDetail; onClose: () => void; onConflict: () => void; onChanged: () => void };

function AcceptDialog({ item, onClose, onConflict, onChanged, onDone }: DecisionProps & { onDone: (eventId: string | null) => void }) {
  const i = useI18n();
  const { t } = i;
  const key = useRef(uuid());
  return (
    <ConfirmCommand
      title={t("rv.acceptT")}
      text={t("rv.acceptM", { d: domainOf(item.source_url) })}
      icon="checkCircle"
      tone=""
      ok={t("rv.acceptOk")}
      reasonLabel={t("rv.note")}
      reasonPlaceholder={t("rv.notePh")}
      minReason={3}
      testId="rv-accept-dialog"
      onClose={onClose}
      onConfirm={async (note) => {
        try {
          const r = await ReviewApi.accept(item.review_id, item.content_hash, note, key.current);
          onDone(r.event_id ?? r.review.event_id ?? null);
          return null;
        } catch (e) {
          if (e instanceof ApiError && e.code === "REVIEW_ALREADY_DECIDED") {
            onConflict();
            return null;
          }
          if (e instanceof ApiError && e.code === "REVIEW_CHANGED") {
            onChanged();
            return null;
          }
          return e instanceof ApiError && e.cancelled ? t("stepup.cancelled") : errText(i, e);
        }
      }}
    />
  );
}

function RejectDialog({ item, onClose, onConflict, onChanged, onDone }: DecisionProps & { onDone: () => void }) {
  const i = useI18n();
  const { t } = i;
  const key = useRef(uuid());
  const [code, setCode] = useState<ReviewRejectReason | "">("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<{ code?: string; note?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    const e: typeof err = {};
    if (!code) e.code = t("rv.err.rejectCode");
    if (note.trim().length < 3) e.note = t("rv.err.note");
    setErr(e);
    if (e.code || e.note || !code) return;
    setBusy(true);
    try {
      await ReviewApi.reject(item.review_id, item.content_hash, code, note.trim(), key.current);
      onDone();
    } catch (x) {
      setBusy(false);
      if (x instanceof ApiError && x.code === "REVIEW_ALREADY_DECIDED") return onConflict();
      if (x instanceof ApiError && x.code === "REVIEW_CHANGED") return onChanged();
      setErr({ form: x instanceof ApiError && x.cancelled ? t("stepup.cancelled") : errText(i, x) });
    }
  };
  return (
    <Modal
      title={t("rv.rejectT")}
      text={t("rv.rejectM")}
      icon="ban"
      tone="bad"
      onClose={() => !busy && onClose()}
      testId="rv-reject-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn label={t("rv.rejectOk")} kind="danger" busy={busy} onClick={() => void submit()} testId="rv-reject-ok" />
        </>
      }
    >
      <div className="field">
        <label htmlFor="rv-rej-code" className="req">
          {t("rv.rejectCode")}
        </label>
        <select
          id="rv-rej-code"
          className={cx("select", err.code && "is-invalid")}
          value={code}
          data-autofocus=""
          aria-invalid={!!err.code}
          aria-describedby={err.code ? "rv-rej-code-err" : undefined}
          onChange={(e) => setCode(e.target.value as ReviewRejectReason)}
          data-testid="rv-reject-code"
        >
          <option value="">{t("rv.rejectPick")}</option>
          {REJECT_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`rv.rej.${r}` as MessageKey)}
            </option>
          ))}
        </select>
        <FieldErr msg={err.code} id="rv-rej-code-err" />
      </div>
      <div className="field">
        <label htmlFor="rv-rej-note" className="req">
          {t("rv.note")}
        </label>
        <textarea
          id="rv-rej-note"
          className={cx("textarea", err.note && "is-invalid")}
          rows={3}
          maxLength={500}
          value={note}
          placeholder={t("rv.rejectPh")}
          aria-invalid={!!err.note}
          aria-describedby={err.note ? "rv-rej-note-err" : undefined}
          onChange={(e) => setNote(e.target.value)}
          data-testid="rv-reject-note"
        />
        <FieldErr msg={err.note} id="rv-rej-note-err" />
      </div>
      <FieldErr msg={err.form} />
      <p className="xs muted row">
        <Icon name="audit" /> {t("cmd.auditNote")}
      </p>
    </Modal>
  );
}

const ERR_KEY = (code: string) => `rv.err.${code}` as MessageKey;
/** input that receives focus for a field error */
const FIELD_INPUT: Partial<Record<CorrectionField, string>> = { title: "rc-title", date: "rc-date", time: "rc-time", venue: "rc-venue", city: "rc-city", price: "rc-min", basisUrl: "rc-basis", note: "rc-note" };

function CorrectForm({
  item,
  facts,
  changed,
  onCancel,
  onConflict,
  onChanged,
  onDone,
}: {
  item: ReviewDetail;
  facts: Facts;
  changed: boolean;
  onCancel: () => void;
  onConflict: () => void;
  onChanged: () => void;
  onDone: (eventId: string | null) => void;
}) {
  const i = useI18n();
  const { t, lang } = i;
  const [f, setF] = useState<CorrectionForm>(() => formFromFacts(facts, item.source_url));
  const [errors, setErrors] = useState<CorrectionErrors>({});
  /** server-side error: at a field (basis URL, REVIEW_CHANGES_INVALID {field}) or for the whole form */
  const [serverErr, setServerErr] = useState<{ field: CorrectionField | "form"; text: string; meta?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(uuid());
  const firstErr = useRef<HTMLDivElement>(null);
  const base = formFromFacts(facts);
  const baseRef = useRef(base);
  // newer facts (409 REVIEW_CHANGED → the card was re-read): keep the operator's edits, take the new values elsewhere
  useEffect(() => {
    const next = formFromFacts(facts);
    if (JSON.stringify(next) === JSON.stringify(baseRef.current)) return;
    setF((x) => rebaseForm(x, baseRef.current, next));
    baseRef.current = next;
  }, [facts]);
  const set = <K extends keyof CorrectionForm>(k: K, v: CorrectionForm[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setServerErr(null);
  };
  const domain = domainOf(item.source_url);
  const focus = (id: string | undefined) => setTimeout(() => (id ? document.getElementById(id) : firstErr.current?.querySelector<HTMLElement>("[aria-invalid='true']"))?.focus(), 0);

  const submit = async () => {
    if (busy) return;
    const r = buildCorrection(facts, f);
    setErrors(r.errors);
    if (!r.changes) return focus(undefined);
    setBusy(true);
    try {
      const res = await ReviewApi.correct(item.review_id, item.content_hash, r.changes, f.basisUrl.trim(), f.note.trim(), key.current);
      onDone(res.event_id ?? res.review.event_id ?? null);
    } catch (e) {
      setBusy(false);
      if (!(e instanceof ApiError)) return setServerErr({ field: "form", text: errText(i, e) });
      if (e.code === "REVIEW_ALREADY_DECIDED") return onConflict();
      if (e.code === "REVIEW_CHANGED") {
        key.current = uuid(); // a different body (new content_hash) must not reuse the key
        return onChanged();
      }
      if (e.code === "REVIEW_BASIS_URL_NOT_ALLOWED") {
        focus("rc-basis");
        return setServerErr({ field: "basisUrl", text: t("err.REVIEW_BASIS_URL_NOT_ALLOWED") });
      }
      if (e.code === "REVIEW_CHANGES_INVALID") {
        const field = changeField(e.str("field"));
        const reason = e.str("reason");
        const rk = `rv.chg.${reason}` as MessageKey;
        focus(FIELD_INPUT[field]);
        return setServerErr({ field, text: reason && rk in DICTS.ru ? t(rk) : t("err.REVIEW_CHANGES_INVALID"), meta: errMeta(e) });
      }
      setServerErr({ field: "form", text: e.cancelled ? t("stepup.cancelled") : errText(i, e), meta: errMeta(e) });
    }
  };

  const srvAt = (k: CorrectionField | null) => (k && serverErr?.field === k ? serverErr.text : null);
  const fe = (k: CorrectionField | null) => (k && errors[k] ? t(ERR_KEY(errors[k]!)) : srvAt(k));
  const inv = (k: CorrectionField) => (errors[k] || serverErr?.field === k ? true : undefined);
  /** «was: …» — the candidate's current value next to the field; the field is marked when the operator changed it */
  const wasText = (v: string | null | undefined) => t("rv.was", { v: v && v.trim() ? v : t("rv.wasEmpty") });
  const isEdited = (...ks: Array<keyof CorrectionForm>) => ks.some((k) => String(f[k]).trim() !== String(base[k]).trim());
  const field = (
    id: string,
    k: CorrectionField | null,
    label: string,
    input: React.ReactNode,
    opts: { req?: boolean; hint?: string; span?: boolean; was?: string; edited?: boolean } = {},
  ) => (
    <div className={cx("field", opts.span && "span-2", opts.edited && "is-edited")}>
      <label htmlFor={id} className={opts.req ? "req" : undefined}>
        {label}
      </label>
      {input}
      {opts.was != null && (
        <span className="was" id={`${id}-was`} data-testid={`${id}-was`}>
          {opts.was}
        </span>
      )}
      {opts.hint && (
        <span className="hint" id={`${id}-hint`}>
          {opts.hint}
        </span>
      )}
      <FieldErr msg={fe(k)} id={`${id}-err`} />
    </div>
  );
  const desc = (id: string, k: CorrectionField, o: { hint?: boolean; was?: boolean } = {}) =>
    [o.was ? `${id}-was` : "", o.hint ? `${id}-hint` : "", fe(k) ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  const origPrice = facts.price ? fmtPriceRange(facts.price, lang) : t("rv.noPrice");

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      data-testid="rv-correct-form"
      noValidate
    >
      {changed ? (
        <Reveal dep={item.content_hash}>
          <Callout kind="warn" icon="refresh" testId="rv-changed">
            <b>{t("rv.changedT")}.</b> {t("rv.changedForm")}
          </Callout>
        </Reveal>
      ) : (
        <Callout kind="info" icon="info">
          {t("rv.correctLead", { d: domain })}
        </Callout>
      )}
      <div ref={firstErr} className="form-grid">
        {field(
          "rc-title",
          "title",
          t("rv.fact.title"),
          <input id="rc-title" className="input" value={f.title} maxLength={300} onChange={(e) => set("title", e.target.value)} aria-invalid={inv("title")} aria-describedby={desc("rc-title", "title", { was: true })} data-autofocus="" />,
          { req: true, span: true, was: wasText(facts.title), edited: isEdited("title") },
        )}
        {field(
          "rc-date",
          "date",
          t("rv.fact.date"),
          <input id="rc-date" className="input" type="date" value={f.date} onChange={(e) => set("date", e.target.value)} aria-invalid={inv("date")} aria-describedby={desc("rc-date", "date", { was: true })} />,
          { req: true, was: wasText(facts.start ? fmtLocalDate(lang, facts.start.local_date) : null), edited: isEdited("date") },
        )}
        {field(
          "rc-time",
          "time",
          t("rv.fact.time"),
          <input id="rc-time" className="input" type="time" value={f.time} onChange={(e) => set("time", e.target.value)} aria-invalid={inv("time")} aria-describedby={desc("rc-time", "time", { hint: true, was: true })} />,
          { hint: t("rv.timeHint"), was: wasText(facts.start?.local_time), edited: isEdited("time") },
        )}
        {field(
          "rc-venue",
          "venue",
          t("rv.fact.venue"),
          <input id="rc-venue" className="input" value={f.venue} maxLength={300} onChange={(e) => set("venue", e.target.value)} aria-invalid={inv("venue")} aria-describedby={desc("rc-venue", "venue", { was: true })} />,
          { was: wasText(facts.venue?.name), edited: isEdited("venue") },
        )}
        {field(
          "rc-city",
          "city",
          t("rv.fact.city"),
          <input id="rc-city" className="input" value={f.city} maxLength={200} onChange={(e) => set("city", e.target.value)} aria-invalid={inv("city")} aria-describedby={desc("rc-city", "city", { was: true })} />,
          { was: wasText(facts.venue?.city), edited: isEdited("city") },
        )}
        {field(
          "rc-address",
          null,
          t("rv.fact.address"),
          <input id="rc-address" className="input" value={f.address} maxLength={500} onChange={(e) => set("address", e.target.value)} aria-describedby="rc-address-was" />,
          { span: true, was: wasText(facts.venue?.address), edited: isEdited("address") },
        )}
        <fieldset className={cx("span-2 rc-price", isEdited("noPrice", "priceMin", "priceMax", "currency") && "is-edited")} aria-describedby={["rc-price-was", fe("price") ? "rc-price-err" : ""].filter(Boolean).join(" ")}>
          <legend className="field-label">{t("rv.fact.price")}</legend>
          <label className="check" htmlFor="rc-noprice">
            <input id="rc-noprice" type="checkbox" checked={f.noPrice} onChange={(e) => set("noPrice", e.target.checked)} data-testid="rc-noprice" />
            <span>{t("rv.noPriceCheck")}</span>
          </label>
          {!f.noPrice && (
            <div className="rc-price-row">
              <input id="rc-min" className="input mono" inputMode="decimal" aria-label={t("rv.priceMin")} placeholder={t("rv.priceMin")} value={f.priceMin} maxLength={16} onChange={(e) => set("priceMin", e.target.value)} aria-invalid={inv("price")} data-testid="rc-min" />
              <span className="muted" aria-hidden="true">
                –
              </span>
              <input className="input mono" inputMode="decimal" aria-label={t("rv.priceMax")} placeholder={t("rv.priceMax")} value={f.priceMax} maxLength={16} onChange={(e) => set("priceMax", e.target.value)} aria-invalid={inv("price")} data-testid="rc-max" />
              <select className="select" aria-label={t("rv.currency")} value={f.currency} onChange={(e) => set("currency", e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          )}
          <span className="was" id="rc-price-was" data-testid="rc-price-was">
            {t("rv.was", { v: origPrice })}
          </span>
          <FieldErr msg={fe("price")} id="rc-price-err" />
        </fieldset>
        <div className={cx("span-2", isEdited("online") && "is-edited")}>
          <label className="check" htmlFor="rc-online">
            <input id="rc-online" type="checkbox" checked={f.online} onChange={(e) => set("online", e.target.checked)} aria-describedby="rc-online-was" />
            <span>{t("rv.onlineCheck")}</span>
          </label>
          <span className="was block" id="rc-online-was">
            {t("rv.was", { v: facts.online ? t("common.yes") : t("common.no") })}
          </span>
        </div>
        {field(
          "rc-basis",
          "basisUrl",
          t("rv.basis"),
          <input
            id="rc-basis"
            className="input mono"
            type="url"
            inputMode="url"
            placeholder={`https://${domain}/…`}
            value={f.basisUrl}
            maxLength={2048}
            onChange={(e) => set("basisUrl", e.target.value)}
            aria-invalid={inv("basisUrl")}
            aria-describedby={desc("rc-basis", "basisUrl", { hint: true })}
            data-testid="rc-basis"
          />,
          { req: true, span: true, hint: `${t("rv.basisHint", { d: domain })} ${f.basisUrl.trim() === item.source_url ? t("rv.basisPrefill") : ""}`.trim() },
        )}
        {field(
          "rc-note",
          "note",
          t("rv.note"),
          <textarea id="rc-note" className="textarea" rows={3} maxLength={500} placeholder={t("rv.correctPh")} value={f.note} onChange={(e) => set("note", e.target.value)} aria-invalid={inv("note")} aria-describedby={desc("rc-note", "note")} data-testid="rc-note" />,
          { req: true, span: true },
        )}
      </div>
      {(errors.changes || serverErr?.field === "changes") && (
        <Callout kind="warn" icon="alert" testId="rc-nochanges">
          {errors.changes ? t(ERR_KEY(errors.changes)) : serverErr?.text}
        </Callout>
      )}
      {serverErr?.field === "form" && (
        <Callout kind="bad" icon="alertCircle" testId="rc-server-err">
          <b>{serverErr.text}</b>
          {serverErr.meta && <span className="xs muted block mono">{serverErr.meta}</span>}
        </Callout>
      )}
      <div className="row rc-actions">
        <Btn label={t("common.cancel")} onClick={onCancel} disabled={busy} />
        <span className="grow" />
        <Btn type="submit" kind="primary" icon="check" label={t("rv.correctOk")} busy={busy} perm="events.review" testId="rc-submit" />
      </div>
      <p className="xs muted row">
        <Icon name="audit" /> {t("rv.correctAudit")}
      </p>
    </form>
  );
}

/**
 * «Заявки учеников» (media.rights — the register holds learners' titles, links and comments; ADM-MEDIA-04, AT-30):
 * learners' requests for songs and films. List with status, similar requests
 * and date; the card shows the learner's link ONLY as text — never a clickable preview; opening it is a deliberate
 * manual action (new window, rel noopener noreferrer, no referrer) after a warning «не скачивать материалы по ссылке».
 * «Взять» and the decision (authored alternative / licensed / rejected / duplicate + a note for the learner + the
 * linked published material) need media.rights; the decision also needs step-up and notifies the learner.
 */
import { useCallback, useEffect, useState } from "react";
import type { AdminMediaRequest, MediaRequestDecision } from "@tilhero/contracts/admin";
import type { MediaRequestStatus } from "@tilhero/contracts/content";
import { MediaRequests } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, CopyBtn, cx, Empty, FieldErr, Pill, Seg, Spinner, type Tone } from "../../ui/kit";
import { Drawer, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { useRefs, withCurrent } from "./refs";

export const REQUEST_STATUSES: readonly MediaRequestStatus[] = ["new", "in_review", "authored_alternative", "licensed", "rejected", "duplicate"];
export const DECISIONS: readonly MediaRequestDecision["status"][] = ["authored_alternative", "licensed", "rejected", "duplicate"];
export const REQ_TONE: Record<MediaRequestStatus, Tone> = { new: "warn", in_review: "info", authored_alternative: "good", licensed: "good", rejected: "neutral", duplicate: "neutral" };
const OPEN: readonly MediaRequestStatus[] = ["new", "in_review"];

/** Only an https:// link may be opened by hand (the catalog accepts nothing else); anything else stays text. */
export function safeLink(link: string | null): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function RequestsTab({ openId }: { openId: string | null }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { navigate } = useNav();
  const [status, setStatus] = useState<MediaRequestStatus | "">("new");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<AdminMediaRequest[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(
    async (more?: string | null) => {
      try {
        const r = await MediaRequests.list({ status, q: q.trim() || undefined, cursor: more ?? null });
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [status, q],
  );
  useEffect(() => {
    const tm = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(tm);
  }, [load, q]);
  const current = openId ? (rows?.find((r) => r.request_id === openId) ?? null) : null;
  // a request opened by link may be outside the status filter: look for it among all requests
  useEffect(() => {
    if (openId && rows && !current && (status !== "" || q)) {
      setRows(null);
      setStatus("");
      setQ("");
    }
  }, [openId, rows, current, status, q]);
  return (
    <div className="stack" data-testid="requests">
      <Callout kind="warn" icon="shield" testId="rq-rules">
        <b>{t("rq.rulesT")}</b> {t("rq.rulesM")}
      </Callout>
      <section className="panel">
        <div className="panel-h">
          <h2 className="panel-t grow">
            <Icon name="inbox" /> {t("rq.title")}
          </h2>
          <div className="input-wrap">
            <Icon name="search" />
            <input className="input" type="search" value={q} placeholder={t("rq.search")} aria-label={t("rq.search")} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="panel-b">
          <Seg<MediaRequestStatus | ""> label={t("col.status")} value={status} onChange={setStatus} testId="rq-status" items={[{ v: "", label: t("rq.all") }, ...REQUEST_STATUSES.map((s) => ({ v: s, label: t(`rqs.${s}` as MessageKey) }))]} />
        </div>
        {error && !rows ? (
          <div className="panel-b">
            <LoadError error={error} onRetry={() => void load()} />
          </div>
        ) : !rows ? (
          <Spinner label={t("common.loading")} />
        ) : rows.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("rq.col.title")}</th>
                  <th scope="col">{t("rq.col.kind")}</th>
                  <th scope="col" className="r">
                    {t("rq.col.similar")}
                  </th>
                  <th scope="col">{t("col.status")}</th>
                  <th scope="col">{t("rq.col.created")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.request_id} className={openId === r.request_id ? "is-sel" : undefined} data-testid={`rq-row-${r.request_id}`}>
                    <td>
                      <button type="button" className="tr wrap-any" onClick={() => navigate("content", `requests/${r.request_id}`)} data-testid={`rq-open-${r.request_id}`}>
                        {r.title}
                      </button>
                      <div className="cell-sub">{r.ui_locale.toUpperCase()}</div>
                    </td>
                    <td className="small">{t(`rqk.${r.kind}` as MessageKey)}</td>
                    <td className="r num">{r.similar_count ? <Pill tone="info">+{r.similar_count}</Pill> : "—"}</td>
                    <td>
                      <Pill tone={REQ_TONE[r.status]}>{t(`rqs.${r.status}` as MessageKey)}</Pill>
                      {r.decided_by_name && <div className="cell-sub">{r.decided_by_name}</div>}
                    </td>
                    <td className="nowrap small">{fmt.dateTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="inbox" title={t("rq.empty")} text={t("rq.emptyM")} />
        )}
        {cursor && (
          <div className="more-row">
            <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} />
          </div>
        )}
      </section>
      {openId && current && <RequestCard key={current.request_id} r={current} onClose={() => navigate("content", "requests")} onChanged={(x) => setRows((xs) => (xs ? xs.map((y) => (y.request_id === x.request_id ? x : y)) : xs))} />}
      {openId && rows && !current && status === "" && !q && <LoadError error={new ApiError(404, { code: "MEDIA_REQUEST_NOT_FOUND", message: "", trace_id: "", details: {} })} />}
    </div>
  );
}

function RequestCard({ r, onClose, onChanged }: { r: AdminMediaRequest; onClose: () => void; onChanged: (r: AdminMediaRequest) => void }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const toast = useToast();
  const refs = useRefs();
  const [status, setStatus] = useState<MediaRequestDecision["status"]>("authored_alternative");
  const [note, setNote] = useState("");
  const [asset, setAsset] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openAsk, setOpenAsk] = useState(false);
  const link = safeLink(r.link);
  const open = OPEN.includes(r.status);
  const needsAsset = status === "authored_alternative" || status === "licensed";
  const noteOk = note.trim().length >= 3 && note.trim().length <= 500;
  const take = async () => {
    setBusy("take");
    setErr(null);
    try {
      const x = await MediaRequests.take(r.request_id);
      onChanged(x);
      toast(t("rq.taken"), "ok", "media_request.taken");
    } catch (e) {
      setErr(errText(i18n, e));
    } finally {
      setBusy(null);
    }
  };
  const decide = async () => {
    if (!noteOk || (needsAsset && !asset)) {
      setErr(!noteOk ? t("rq.noteErr") : t("err.LINKED_ASSET_REQUIRED"));
      return;
    }
    setBusy("decide");
    setErr(null);
    try {
      const body: MediaRequestDecision = needsAsset ? { status, note: note.trim(), linked_asset_id: asset } : { status, note: note.trim() };
      const x = await MediaRequests.decide(r.request_id, body);
      onChanged(x);
      toast(t("rq.decided", { s: t(`rqs.${x.status}` as MessageKey) }), "ok", "media_request.decided");
    } catch (e) {
      setErr((e as ApiError)?.cancelled ? t("stepup.cancelled") : errText(i18n, e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Drawer
      title={r.title}
      sub={
        <>
          <Pill tone={REQ_TONE[r.status]} testId="rq-card-status">
            {t(`rqs.${r.status}` as MessageKey)}
          </Pill>
          <span>{t(`rqk.${r.kind}` as MessageKey)}</span>
          <span>{fmt.dateTime(r.created_at)}</span>
        </>
      }
      onClose={onClose}
      testId="rq-card"
    >
      <div className="stack sm">
        <dl className="dl">
          <dt>{t("rq.learner")}</dt>
          <dd>{r.user_id ? <span className="mono">{shortId(r.user_id, 8, 4)}</span> : <span className="muted">{t("rq.anonymized")}</span>}</dd>
          <dt>{t("rq.lang")}</dt>
          <dd>{t(`ulang.${r.ui_locale}`)}</dd>
          <dt>{t("rq.similar")}</dt>
          <dd>{r.similar_count ? t("rq.similarN", { n: r.similar_count }) : t("ct.none")}</dd>
          <dt>{t("rq.comment")}</dt>
          <dd className="wrap-any" data-testid="rq-comment">
            {r.comment ?? "—"}
          </dd>
          <dt>{t("rq.link")}</dt>
          <dd>
            {r.link ? (
              <span className="stack sm">
                {/* the learner's link is plain text: no <a>, no preview, nothing is fetched */}
                <code className="code-chip wrap-any link-text" data-testid="rq-link-text">
                  {r.link}
                </code>
                <span className="row">
                  <CopyBtn value={r.link} label={t("rq.link")} text={t("rq.copy")} testId="rq-copy" />
                  {link && <Btn size="sm" icon="ext" label={t("rq.openManual")} onClick={() => setOpenAsk(true)} testId="rq-open-manual" />}
                </span>
              </span>
            ) : (
              "—"
            )}
          </dd>
        </dl>
        <Callout kind="warn" icon="alert" testId="rq-no-download">
          {t("rq.noDownload")}
        </Callout>
        {!open && (
          <section className="card stack sm" data-testid="rq-decision">
            <h3 className="h3">{t("rq.decision")}</h3>
            <p className="small">
              <Pill tone={REQ_TONE[r.status]}>{t(`rqs.${r.status}` as MessageKey)}</Pill> {r.decided_by_name ?? "—"} · {fmt.dateTime(r.decided_at)}
            </p>
            {r.decision_note && <p className="wrap-any">{r.decision_note}</p>}
            {r.linked_asset_id && (
              <p className="small">
                {t("rq.linked")} <span className="mono">{r.linked_asset_id}</span>
              </p>
            )}
          </section>
        )}
        {open && !can("media.rights") && (
          <p className="xs muted row" data-testid="rq-no-rights">
            <Icon name="lock" /> {t("rq.noRights", { p: "media.rights" })}
          </p>
        )}
        {open && can("media.rights") && (
          <section className="card stack sm" aria-labelledby="rq-dec-h" data-testid="rq-form">
            <div className="row between">
              <h3 className="h3" id="rq-dec-h">
                {t("rq.decide")}
              </h3>
              {r.status === "new" && <Btn size="sm" icon="userCheck" label={t("rq.take")} busy={busy === "take"} onClick={() => void take()} testId="rq-take" />}
            </div>
            <fieldset className="fs field">
              <legend className="field-label req">{t("rq.outcome")}</legend>
              <div className="stack sm">
                {DECISIONS.map((d) => (
                  <label key={d} className="check">
                    <input type="radio" name="rq-status" checked={status === d} onChange={() => setStatus(d)} data-testid={`rq-st-${d}`} />
                    <span>
                      {t(`rqs.${d}` as MessageKey)} <span className="xs muted">— {t(`rqh.${d}` as MessageKey)}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {needsAsset && (
              <div className="field">
                <label htmlFor="rq-asset" className="req">
                  {t("rq.asset")}
                </label>
                <select id="rq-asset" className={cx("select wide", err && !asset && "is-invalid")} value={asset} onChange={(e) => setAsset(e.target.value)} data-testid="rq-asset">
                  {withCurrent(refs.options("media_asset", { publishedOnly: true }), asset, t("ct.choose")).map((o) => (
                    <option key={o.v} value={o.v}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <span className="hint">{t("rq.assetHint")}</span>
              </div>
            )}
            <div className="field">
              <label htmlFor="rq-note" className="req">
                {t("rq.note")}
              </label>
              <textarea id="rq-note" className={cx("textarea", err && !noteOk && "is-invalid")} rows={3} maxLength={500} value={note} lang={r.ui_locale === "uz" ? "uz-Latn" : "ru"} onChange={(e) => setNote(e.target.value)} aria-describedby="rq-note-h" data-testid="rq-note" />
              <span className="hint" id="rq-note-h">
                {t("rq.noteHint", { l: t(`ulang.${r.ui_locale}`) })} · {note.trim().length}/500
              </span>
            </div>
            <FieldErr msg={err} />
            <div className="acts">
              <Btn kind="primary" icon="send" label={t("rq.send")} busy={busy === "decide"} onClick={() => void decide()} testId="rq-decide" />
            </div>
            <p className="xs muted row">
              <Icon name="smartphoneKey" /> {t("rq.stepUpNote")}
            </p>
          </section>
        )}
      </div>
      {openAsk && link && (
        <Modal
          title={t("rq.openT")}
          text={t("rq.openM")}
          icon="alert"
          tone="warn"
          onClose={() => setOpenAsk(false)}
          testId="rq-open-confirm"
          footer={
            <>
              <Btn label={t("common.cancel")} onClick={() => setOpenAsk(false)} />
              <Btn
                kind="primary"
                icon="ext"
                label={t("rq.openGo")}
                onClick={() => {
                  // a deliberate manual open: new browsing context without opener and referrer
                  window.open(link, "_blank", "noopener,noreferrer");
                  setOpenAsk(false);
                }}
                testId="rq-open-go"
              />
            </>
          }
        >
          <code className="code-chip wrap-any">{link}</code>
        </Modal>
      )}
    </Drawer>
  );
}

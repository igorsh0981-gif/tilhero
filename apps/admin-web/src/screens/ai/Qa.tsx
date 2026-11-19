/**
 * «Контроль диалогов» (qa.read; sprint 4, ADM-QA-01…04, UC-ADM-03, AT-47, AT-52). Routes: #/qa — the session journal
 * (period, kind, status, outcome, flag, lesson, level; columns of SessionRow; no learner names or ids at all),
 * #/qa/flag/<flag> — the journal with a flag preset (links of the overview), #/qa/sessions/<id> — the session card,
 * #/qa/appeals[/<id>] — the appeal queue: «Взять» (qa.review), a re-evaluation by the appeal and the decision «оценка
 * верна / исправлена» with a text for the learner (10…500) and the link to the re-evaluation (qa.review, step-up).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AdminAppeal, AppealDecision, SessionCard, SessionFlag, SessionRow } from "@tilhero/contracts/admin";
import type { SessionKind } from "@tilhero/contracts/ai";
import type { Band } from "@tilhero/contracts/content";
import { Qa, type SessionFilters } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Seg, Select, Spinner, TabPanel, Tabs, type Tone } from "../../ui/kit";
import { Drawer, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { APPEAL_STATUSES, lastDays, OUTCOMES, SESSION_FLAGS, SESSION_KINDS, SESSION_STATUSES } from "./model";
import { AiOffBanner, CharCount, Kv, useKeyed, useUsd } from "./parts";
import { EvaluationView, latestOf, ReevalDrawer, SessionCardView, SST_TONE } from "./SessionCard";

const BANDS: readonly Band[] = ["A0", "A1", "A2", "B1", "B2"];
export const APS_TONE: Record<AdminAppeal["status"], Tone> = { new: "warn", in_review: "info", upheld: "good", corrected: "accent" };

export type QaRoute = { view: "journal"; flag: SessionFlag | null } | { view: "session"; id: string } | { view: "appeals"; id: string | null };

export function parseQaRoute(id: string | null): QaRoute {
  if (!id) return { view: "journal", flag: null };
  const [head, ...rest] = id.split("/");
  const tail = rest.join("/") || null;
  if (head === "sessions" && tail) return { view: "session", id: tail };
  if (head === "appeals") return { view: "appeals", id: tail };
  if (head === "flag" && tail && (SESSION_FLAGS as readonly string[]).includes(tail)) return { view: "journal", flag: tail as SessionFlag };
  return { view: "journal", flag: null };
}

const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00+05:00`).toISOString() : undefined);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999+05:00`).toISOString() : undefined);

interface JournalFilters {
  from: string;
  to: string;
  kind: SessionKind | "";
  status: SessionRow["status"] | "";
  outcome: NonNullable<SessionRow["outcome"]> | "";
  flag: SessionFlag | "";
  lesson_id: string;
  level: Band | "";
}
const initialFilters = (): JournalFilters => ({ ...lastDays(7), kind: "", status: "", outcome: "", flag: "", lesson_id: "", level: "" });

export function QaPage({ routeId }: { routeId: string | null }) {
  const { t } = useI18n();
  const { navigate } = useNav();
  const r = parseQaRoute(routeId);
  const [filters, setFilters] = useState<JournalFilters>(() => ({ ...initialFilters(), flag: r.view === "journal" && r.flag ? r.flag : "" }));
  useEffect(() => {
    if (r.view === "journal" && r.flag) setFilters((f) => ({ ...f, flag: r.flag! }));
    // the preset comes from the route only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);
  const tab = r.view === "appeals" ? "appeals" : "journal";
  return (
    <div className="stack" data-testid="qa">
      <AiOffBanner />
      {r.view === "session" ? (
        <SessionCardView key={r.id} id={r.id} onBack={() => (window.history.length > 1 ? window.history.back() : navigate("qa"))} />
      ) : (
        <>
          <Tabs<"journal" | "appeals">
            id="qa"
            label={t("qa.tabs")}
            value={tab}
            onChange={(v) => navigate("qa", v === "journal" ? null : "appeals")}
            items={[
              { v: "journal", label: t("qa.tab.journal"), icon: "clipboardCheck", testId: "qa-tab-journal" },
              { v: "appeals", label: t("qa.tab.appeals"), icon: "inbox", testId: "qa-tab-appeals" },
            ]}
          />
          <TabPanel id="qa" value={tab}>
            {tab === "journal" ? <Journal filters={filters} setFilters={setFilters} /> : <Appeals openId={r.view === "appeals" ? r.id : null} />}
          </TabPanel>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- journal */

function Journal({ filters, setFilters }: { filters: JournalFilters; setFilters: (f: (x: JournalFilters) => JournalFilters) => void }) {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const k = useKeyed();
  const money = useUsd();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const req = useRef(0);
  const q = useMemo<SessionFilters>(
    () => ({ from: dayStart(filters.from), to: dayEnd(filters.to), kind: filters.kind, status: filters.status, outcome: filters.outcome, flag: filters.flag, lesson_id: filters.lesson_id.trim() || undefined, level: filters.level }),
    [filters],
  );
  const load = useCallback(
    async (more?: string | null) => {
      const id = ++req.current;
      try {
        const r = await Qa.sessions({ ...q, cursor: more ?? null });
        if (id !== req.current) return;
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        if (id === req.current) setError(e);
      }
    },
    [q],
  );
  useEffect(() => {
    const tm = setTimeout(() => void load(), filters.lesson_id ? 300 : 0);
    return () => clearTimeout(tm);
  }, [load, filters.lesson_id]);
  const set = <K extends keyof JournalFilters>(key: K, v: JournalFilters[K]) => setFilters((f) => ({ ...f, [key]: v }));
  const dirty = JSON.stringify({ ...filters, from: "", to: "" }) !== JSON.stringify({ ...initialFilters(), from: "", to: "" });
  return (
    <section className="panel" aria-labelledby="qj-h" data-testid="qa-journal">
      <div className="panel-h">
        <h2 className="panel-t grow" id="qj-h">
          <Icon name="clipboardCheck" /> {t("qa.journal")}
        </h2>
        <span className="xs muted">{t("qa.journalNote")}</span>
      </div>
      <div className="panel-b qa-filters" role="group" aria-label={t("qa.filters")} data-testid="qa-filters">
        <div className="field">
          <label htmlFor="qf-from">{t("qa.f.from")}</label>
          <input id="qf-from" type="date" className="input" value={filters.from} max={filters.to || undefined} onChange={(e) => set("from", e.target.value)} data-testid="qf-from" />
        </div>
        <div className="field">
          <label htmlFor="qf-to">{t("qa.f.to")}</label>
          <input id="qf-to" type="date" className="input" value={filters.to} min={filters.from || undefined} onChange={(e) => set("to", e.target.value)} data-testid="qf-to" />
        </div>
        <div className="field">
          <label htmlFor="qf-kind">{t("qa.f.kind")}</label>
          <Select<SessionKind | ""> id="qf-kind" label={t("qa.f.kind")} value={filters.kind} onChange={(v) => set("kind", v)} options={[{ v: "", label: t("common.all") }, ...SESSION_KINDS.map((v) => ({ v, label: t(`sk.${v}`) }))]} testId="qf-kind" />
        </div>
        <div className="field">
          <label htmlFor="qf-status">{t("col.status")}</label>
          <Select<SessionRow["status"] | ""> id="qf-status" label={t("col.status")} value={filters.status} onChange={(v) => set("status", v)} options={[{ v: "", label: t("common.all") }, ...SESSION_STATUSES.map((v) => ({ v, label: t(`sst.${v}`) }))]} testId="qf-status" />
        </div>
        <div className="field">
          <label htmlFor="qf-outcome">{t("qa.f.outcome")}</label>
          <Select<NonNullable<SessionRow["outcome"]> | ""> id="qf-outcome" label={t("qa.f.outcome")} value={filters.outcome} onChange={(v) => set("outcome", v)} options={[{ v: "", label: t("common.all") }, ...OUTCOMES.map((v) => ({ v, label: t(`out.${v}`) }))]} testId="qf-outcome" />
        </div>
        <div className="field">
          <label htmlFor="qf-flag">{t("qa.f.flag")}</label>
          <Select<SessionFlag | ""> id="qf-flag" label={t("qa.f.flag")} value={filters.flag} onChange={(v) => set("flag", v)} options={[{ v: "", label: t("common.all") }, ...SESSION_FLAGS.map((v) => ({ v, label: t(`sflag.${v}`) }))]} testId="qf-flag" />
        </div>
        <div className="field">
          <label htmlFor="qf-lesson">{t("qa.f.lesson")}</label>
          <input id="qf-lesson" className="input mono" value={filters.lesson_id} placeholder="l-01-greetings" spellCheck={false} onChange={(e) => set("lesson_id", e.target.value)} data-testid="qf-lesson" />
        </div>
        <div className="field">
          <label htmlFor="qf-level">{t("qa.f.level")}</label>
          <Select<Band | ""> id="qf-level" label={t("qa.f.level")} value={filters.level} onChange={(v) => set("level", v)} options={[{ v: "", label: t("common.all") }, ...BANDS.map((v) => ({ v, label: v }))]} testId="qf-level" />
        </div>
        {dirty && (
          <div className="field qf-reset">
            <span className="field-label" aria-hidden="true">
              &nbsp;
            </span>
            <Btn size="sm" kind="ghost" icon="x" label={t("common.resetFilters")} onClick={() => setFilters((f) => ({ ...initialFilters(), from: f.from, to: f.to }))} testId="qf-reset" />
          </div>
        )}
      </div>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="tbl qa-tbl" data-testid="qa-rows">
            <caption className="sr-only">{t("qa.journal")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("qa.col.started")}</th>
                <th scope="col">{t("qa.col.session")}</th>
                <th scope="col">{t("qa.f.level")}</th>
                <th scope="col">{t("col.status")}</th>
                <th scope="col" className="r">
                  {t("qa.col.min")}
                </th>
                <th scope="col">{t("qa.col.ai")}</th>
                <th scope="col" className="r">
                  {t("qa.col.p95")}
                </th>
                <th scope="col" className="r">
                  {t("qa.col.cost")}
                </th>
                <th scope="col">{t("qa.f.outcome")}</th>
                <th scope="col">{t("qa.col.flags")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.session_id} data-testid={`qa-row-${s.session_id}`}>
                  <td className="small nowrap">
                    {fmt.dateTime(s.started_at) || "—"}
                    <span className="mono xs muted block">{s.session_id.slice(0, 8)}</span>
                  </td>
                  <td>
                    <button type="button" className="tr wrap-any" lang="ru" onClick={() => navigate("qa", `sessions/${s.session_id}`)} data-testid={`qa-open-${s.session_id}`}>
                      {s.title.ru || s.lesson_id || s.scenario_id || s.asset_id || s.session_id}
                    </button>
                    <span className="xs muted block">
                      {k("sk", s.kind)} · <span className="mono">{s.lesson_id ?? s.scenario_id ?? s.asset_id ?? "—"}</span> · {k("ageseg", s.audience)}
                    </span>
                  </td>
                  <td>{s.level ? <span className="tag">{s.level}</span> : "—"}</td>
                  <td>
                    <Pill tone={SST_TONE[s.status] ?? "neutral"}>{k("sst", s.status)}</Pill>
                  </td>
                  <td className="r num">{fmt.num(s.minutes)}</td>
                  <td className="small">
                    {k("aimode", s.ai_mode)}
                    {s.models.length > 0 && <span className="mono xs muted block">{s.models.join(", ")}</span>}
                  </td>
                  <td className="r num small nowrap">{s.p95_latency_ms != null ? `${fmt.num(s.p95_latency_ms)} ms` : "—"}</td>
                  {/* null — ai-gateway was down: the cost is unknown, not zero */}
                  <td className="r num small nowrap" title={s.cost_usd == null ? t("qa.costUnknown") : undefined}>
                    {money(s.cost_usd)}
                  </td>
                  <td className="small">
                    {s.outcome ? k("out", s.outcome) : "—"}
                    {s.passed != null && <span className={cx("block xs", s.passed ? "good-ink" : "warn-ink")}>{s.passed ? t("qa.passed") : t("qa.notPassed")}</span>}
                  </td>
                  <td>
                    <span className="qa-flags">
                      {s.flags.map((f) => (
                        <Pill key={f} tone={f === "failed" || f === "ai_unavailable" ? "bad" : f === "human_review" || f === "appealed" || f === "flagged" ? "warn" : "neutral"} dot={false}>
                          {k("sflag", f)}
                        </Pill>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="inbox" title={t("qa.empty")} text={dirty ? t("common.changeFilters") : t("qa.emptyM")} testId="qa-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="qa-more" />
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- appeals */

function Appeals({ openId }: { openId: string | null }) {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const k = useKeyed();
  const [status, setStatus] = useState<AdminAppeal["status"] | "">("");
  const [rows, setRows] = useState<AdminAppeal[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(
    async (more?: string | null) => {
      try {
        const r = await Qa.appeals(status, more ?? null);
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
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
  const current = openId ? (rows?.find((a) => a.appeal_id === openId) ?? null) : null;
  return (
    <section className="panel" aria-labelledby="qap-h" data-testid="qa-appeals">
      <div className="panel-h">
        <h2 className="panel-t grow" id="qap-h">
          <Icon name="inbox" /> {t("ap.title")}
        </h2>
        <Seg<AdminAppeal["status"] | ""> label={t("col.status")} value={status} onChange={setStatus} testId="ap-status" items={[{ v: "", label: t("common.all") }, ...APPEAL_STATUSES.map((v) => ({ v, label: t(`aps.${v}`) }))]} />
      </div>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="tbl" data-testid="ap-rows">
            <caption className="sr-only">{t("ap.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("ap.col.created")}</th>
                <th scope="col">{t("col.status")}</th>
                <th scope="col">{t("ap.col.reason")}</th>
                <th scope="col">{t("ap.col.session")}</th>
                <th scope="col">{t("ap.col.who")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.appeal_id} className={cx(openId === a.appeal_id && "is-sel")} data-testid={`ap-row-${a.appeal_id}`}>
                  <td className="small nowrap">{fmt.dateTime(a.created_at)}</td>
                  <td>
                    <Pill tone={APS_TONE[a.status]}>{k("aps", a.status)}</Pill>
                  </td>
                  <td>
                    <button type="button" className="tr wrap-any ap-reason" onClick={() => navigate("qa", `appeals/${a.appeal_id}`)} data-testid={`ap-open-${a.appeal_id}`}>
                      {a.reason_redacted || a.reason === null ? (
                        <span className="muted" data-testid={`ap-redacted-${a.appeal_id}`}>
                          <Icon name="clock" /> {t("ap.redacted")}
                        </span>
                      ) : a.reason.length > 110 ? (
                        `${a.reason.slice(0, 110)}…`
                      ) : (
                        a.reason
                      )}
                    </button>
                  </td>
                  <td>
                    <button type="button" className="tr mono" onClick={() => navigate("qa", `sessions/${a.session_id}`)}>
                      {a.session_id.slice(0, 8)}
                    </button>
                  </td>
                  <td className="small">
                    {a.decided_by_name ? t("ap.decidedBy", { n: a.decided_by_name }) : a.taken_by_name ? t("ap.takenBy", { n: a.taken_by_name }) : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="inbox" title={t("ap.empty")} testId="ap-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} />
        </div>
      )}
      {current && (
        <AppealDrawer
          appeal={current}
          onClose={() => navigate("qa", "appeals")}
          onChanged={(a) => setRows((xs) => xs?.map((x) => (x.appeal_id === a.appeal_id ? a : x)) ?? xs)}
        />
      )}
      {openId && rows && !current && <Callout kind="warn" icon="alert">{t("ap.notInList")}</Callout>}
    </section>
  );
}

function AppealDrawer({ appeal, onClose, onChanged }: { appeal: AdminAppeal; onClose: () => void; onChanged: (a: AdminAppeal) => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const { navigate } = useNav();
  const toast = useToast();
  const k = useKeyed();
  const [card, setCard] = useState<SessionCard | null>(null);
  const [cardErr, setCardErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState<null | "reeval" | "decide">(null);
  const [newEval, setNewEval] = useState<string | null>(appeal.new_evaluation_id);
  const loadCard = useCallback(() => {
    Qa.session(appeal.session_id)
      .then((c) => {
        setCard(c);
        setCardErr(null);
      })
      .catch(setCardErr);
  }, [appeal.session_id]);
  useEffect(loadCard, [loadCard]);
  const latest = latestOf(card);
  const chain = card?.evaluations ?? [];
  const idx = chain.findIndex((e) => e.evaluation_id === appeal.evaluation_id);
  const after = idx >= 0 ? chain.slice(idx + 1) : [];
  const open = appeal.status === "new" || appeal.status === "in_review";
  const review = can("qa.review");
  const take = async () => {
    setBusy(true);
    try {
      const a = await Qa.take(appeal.appeal_id);
      onChanged(a);
      toast(t("ap.taken"), "ok", "qa.appeal_taken");
    } catch (e) {
      toast(errText(i, e), "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      wide
      title={t("ap.cardT")}
      sub={<span className="mono">{appeal.appeal_id.slice(0, 8)}</span>}
      onClose={onClose}
      testId="ap-drawer"
      footer={
        <>
          <Btn label={t("common.close")} onClick={onClose} />
          <span className="grow" />
          {review && appeal.status === "new" && <Btn kind="primary" icon="userCheck" label={t("ap.take")} busy={busy} onClick={() => void take()} testId="ap-take" />}
          {review && appeal.status === "in_review" && latest && <Btn icon="clipboardCheck" label={t("ap.reeval")} onClick={() => setDlg("reeval")} testId="ap-reeval" />}
          {review && appeal.status === "in_review" && <Btn kind="primary" icon="check" label={t("ap.decide")} onClick={() => setDlg("decide")} testId="ap-decide" />}
        </>
      }
    >
      <div className="stack sm" data-testid="ap-card" data-status={appeal.status}>
        <div className="row">
          <Pill tone={APS_TONE[appeal.status]} testId="ap-card-status">
            {k("aps", appeal.status)}
          </Pill>
          <span className="small muted">{t("ap.createdAt", { t: fmt.dateTime(appeal.created_at) })}</span>
        </div>
        <div className="ap-quote" data-testid="ap-reason" data-redacted={appeal.reason_redacted || appeal.reason === null}>
          <span className="xs muted">{t("ap.learnerText")}</span>
          {appeal.reason_redacted || appeal.reason === null ? (
            <p className="small muted" data-testid="ap-reason-redacted">
              <Icon name="clock" /> {t("ap.redacted")} · {t("ap.redactedH")}
            </p>
          ) : (
            <blockquote className="wrap-any">{appeal.reason}</blockquote>
          )}
        </div>
        <Kv k={t("ap.col.session")} v={<button type="button" className="tr mono" onClick={() => navigate("qa", `sessions/${appeal.session_id}`)} data-testid="ap-session">{appeal.session_id}</button>} />
        <Kv k={t("ap.evaluation")} v={<span className="mono">{appeal.evaluation_id.slice(0, 8)}</span>} />
        {appeal.taken_by_name && <Kv k={t("ap.takenL")} v={appeal.taken_by_name} />}
        {appeal.decided_at && <Kv k={t("ap.decidedL")} v={`${appeal.decided_by_name ?? "—"} · ${fmt.dateTime(appeal.decided_at)}`} />}
        {appeal.decision_note && (
          <div className="ap-quote" data-testid="ap-note">
            <span className="xs muted">{t("ap.noteForLearner")}</span>
            <blockquote className="wrap-any">{appeal.decision_note}</blockquote>
          </div>
        )}
        {appeal.new_evaluation_id && <Kv k={t("ap.newEval")} v={<span className="mono">{appeal.new_evaluation_id.slice(0, 8)}</span>} />}
        {open && !review && (
          <p className="xs muted row" data-testid="ap-no-review">
            <Icon name="lock" /> {t("ap.noReview")}
          </p>
        )}
        {appeal.status === "new" && review && <Callout icon="info">{t("ap.takeFirst")}</Callout>}
        <h3 className="h3">{t("ap.evalT")}</h3>
        {cardErr && !card ? (
          <LoadError error={cardErr} onRetry={loadCard} />
        ) : !card ? (
          <Spinner label={t("common.loading")} />
        ) : !card.evaluations ? (
          <Callout kind="warn" icon="alert">
            {t("dash.off.m", { s: "assessment" })}
          </Callout>
        ) : idx >= 0 ? (
          <EvaluationView e={chain[idx]!} n={idx} latest={idx === chain.length - 1} />
        ) : latest ? (
          <EvaluationView e={latest} n={chain.length - 1} latest />
        ) : (
          <p className="small muted">{t("qa.noEvaluations")}</p>
        )}
        {after.length > 0 && (
          <Callout kind="info" icon="clipboardCheck" testId="ap-has-reeval">
            {t("ap.hasReeval", { n: after.length })}
          </Callout>
        )}
      </div>
      {dlg === "reeval" && card && latest && (
        <ReevalDrawer
          card={card}
          evaluation={latest}
          appealId={appeal.appeal_id}
          onClose={() => setDlg(null)}
          onDone={(ev) => {
            setNewEval(ev.evaluation_id);
            loadCard();
            setDlg("decide");
          }}
        />
      )}
      {dlg === "decide" && (
        <DecideDialog
          appeal={appeal}
          options={[...after.map((e) => e.evaluation_id), ...(newEval && !after.some((e) => e.evaluation_id === newEval) ? [newEval] : [])]}
          preset={newEval}
          onClose={() => setDlg(null)}
          onDone={(a) => {
            onChanged(a);
            setDlg(null);
            toast(t(a.status === "corrected" ? "ap.doneCorrected" : "ap.doneUpheld"), "ok", "qa.appeal_decided");
          }}
        />
      )}
    </Drawer>
  );
}

function DecideDialog({ appeal, options, preset, onClose, onDone }: { appeal: AdminAppeal; options: string[]; preset: string | null; onClose: () => void; onDone: (a: AdminAppeal) => void }) {
  const i = useI18n();
  const { t } = i;
  const [decision, setDecision] = useState<AppealDecision["decision"]>(preset ? "corrected" : "upheld");
  const [note, setNote] = useState("");
  const [evalId, setEvalId] = useState(preset ?? options[options.length - 1] ?? "");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const noteBad = note.trim().length < 10 || note.length > 500;
  const evalBad = decision === "corrected" && !evalId;
  const submit = async () => {
    setTried(true);
    if (noteBad || evalBad || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const a = await Qa.decide(appeal.appeal_id, { decision, note: note.trim(), new_evaluation_id: decision === "corrected" ? evalId : null });
      onDone(a);
    } catch (e) {
      setBusy(false);
      setErr((e as ApiError)?.cancelled ? t("stepup.cancelled") : errText(i, e));
    }
  };
  return (
    <Modal
      title={t("ap.decideT")}
      text={t("ap.decideM")}
      icon="check"
      tone="warn"
      onClose={() => !busy && onClose()}
      testId="ap-decide-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn kind="primary" label={t("ap.decideOk")} busy={busy} onClick={() => void submit()} testId="ap-decide-ok" />
        </>
      }
    >
      <fieldset className="ap-choice">
        <legend className="field-label">{t("ap.decision")}</legend>
        {(["upheld", "corrected"] as const).map((d) => (
          <label key={d} className="check">
            <input type="radio" name="ap-decision" value={d} checked={decision === d} onChange={() => setDecision(d)} data-testid={`ap-d-${d}`} />
            <span>
              <b>{t(`ap.d.${d}`)}</b>
              <span className="xs muted block">{t(`ap.d.${d}.h`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {decision === "corrected" && (
        <div className="field">
          <label htmlFor="ap-eval" className="req">
            {t("ap.newEval")}
          </label>
          {options.length ? (
            <Select<string> id="ap-eval" label={t("ap.newEval")} value={evalId} onChange={setEvalId} options={options.map((x) => ({ v: x, label: x.slice(0, 8) }))} testId="ap-eval" />
          ) : (
            <p className="small bad-ink" data-testid="ap-need-reeval">
              {t("ap.needReeval")}
            </p>
          )}
        </div>
      )}
      <div className="field">
        <div className="field-top">
          <label htmlFor="ap-note" className="req">
            {t("ap.noteForLearner")}
          </label>
          <CharCount id="ap-note-count" n={note.length} max={500} />
        </div>
        <textarea id="ap-note" className={cx("textarea", tried && noteBad && "is-invalid")} rows={4} value={note} maxLength={600} placeholder={t("ap.notePh")} onChange={(e) => setNote(e.target.value)} aria-describedby="ap-note-count ap-note-h" data-autofocus="" data-testid="ap-note-input" />
        <span className="hint" id="ap-note-h">
          {t("ap.noteH")}
        </span>
        <FieldErr msg={tried && noteBad ? t("ap.noteErr") : null} />
      </div>
      <FieldErr msg={tried && evalBad ? t("ap.needReeval") : err} />
      <Callout kind="info" icon="smartphoneKey">
        {t("ct.stepUpNote")}
      </Callout>
    </Modal>
  );
}

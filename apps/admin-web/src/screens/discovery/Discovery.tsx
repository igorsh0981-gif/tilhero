import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { AiBudget, DiscoveryRun } from "@tilhero/contracts/admin";
import { DiscoveryApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { fmtUsd, ratio } from "../../lib/money";
import { useNow } from "../../lib/useNow";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, CopyBtn, cx, Empty, FieldErr, Pill, Spinner } from "../../ui/kit";
import { ConfirmCommand, Drawer, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errMeta, errText } from "../../ui/errors";
import { LimitsPanel } from "./Limits";
import { fmtLocalDate, hoursMinutes, looksLikeUuid, msToUtcMidnight, RUN_STATUS_TONE, runErrorLabel } from "../catalog/common";

export const POLL_MS = 5_000;

/** errors of a run grouped by code (the table shows codes with counts, the drawer — every scope) */
export function groupErrors(errors: DiscoveryRun["errors"]): Array<{ code: string; scopes: string[] }> {
  const m = new Map<string, string[]>();
  for (const e of errors) m.set(e.code, [...(m.get(e.code) ?? []), e.scope]);
  return [...m.entries()].map(([code, scopes]) => ({ code, scopes })).sort((a, b) => b.scopes.length - a.scopes.length || a.code.localeCompare(b.code));
}

/** meter level of the AI day budget: ok < 80 % ≤ warn < 100 % ≤ bad */
export function budgetLevel(b: Pick<AiBudget, "spent_usd" | "budget_usd">): "ok" | "warn" | "bad" {
  const r = ratio(b.spent_usd, b.budget_usd);
  return r >= 1 ? "bad" : r >= 0.8 ? "warn" : "ok";
}

const isPaused = (b: AiBudget | null) => b?.paused?.paused === true;
const tokens = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

/** «Event search» (discovery.manage): AI budget of the day, kill switch, manual run, run history. */
export function DiscoveryPage({ openId = null }: { openId?: string | null }) {
  const i = useI18n();
  const { t } = i;
  const { can } = useSession();
  const toast = useToast();
  const [budget, setBudget] = useState<AiBudget | null>(null);
  const [budgetErr, setBudgetErr] = useState<unknown>(null);
  const [runs, setRuns] = useState<DiscoveryRun[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [runsErr, setRunsErr] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(openId);
  const [starting, setStarting] = useState(false);
  const [pauseDlg, setPauseDlg] = useState<null | boolean>(null);
  const [inProgress, setInProgress] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => setOpen(openId), [openId]);
  /** older pages were appended: a refresh of the first page must not reset the cursor */
  const extraPages = useRef(false);

  const loadBudget = useCallback(async (background = false) => {
    try {
      setBudget(await DiscoveryApi.budget(background));
      setBudgetErr(null);
    } catch (e) {
      if (!background) setBudgetErr(e);
    }
  }, []);

  /** first page: replaces fresh rows and keeps already loaded older pages */
  const loadRuns = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const p = await DiscoveryApi.runs(null, background);
      setRuns((old) => {
        const fresh = new Set(p.items.map((r) => r.run_id));
        const lastFresh = p.items.at(-1)?.started_at ?? "";
        return [...p.items, ...old.filter((r) => !fresh.has(r.run_id) && r.started_at < lastFresh)];
      });
      if (!extraPages.current) setCursor(p.next_cursor);
      setRunsErr(null);
    } catch (e) {
      if (!background) setRunsErr(e);
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const p = await DiscoveryApi.runs(cursor);
      extraPages.current = true;
      setRuns((xs) => [...xs, ...p.items.filter((r) => !xs.some((x) => x.run_id === r.run_id))]);
      setCursor(p.next_cursor);
    } catch (e) {
      toast(errText(i, e), "err", errMeta(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBudget();
    void loadRuns();
  }, [loadBudget, loadRuns]);

  // auto-refresh while a run is in progress (background requests: they do not extend the idle session)
  const running = runs.some((r) => r.status === "RUNNING");
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      void loadRuns(true);
      void loadBudget(true);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [running, loadRuns, loadBudget]);
  useEffect(() => {
    if (!running) setInProgress(null);
  }, [running]);

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div data-testid="discovery">
      <div className="page-head">
        <div className="lead">
          <p>{t("dsc.lead")}</p>
        </div>
        <div className="acts">
          <Btn kind="primary" icon="play" label={t("dsc.start")} perm="discovery.manage" onClick={() => setStarting(true)} testId="dsc-start" />
        </div>
      </div>

      {inProgress && (
        <div className="mb-12">
          <Callout kind="warn" icon="clock" testId="dsc-in-progress">
            <b>{t("dsc.inProgressT")}</b> {t("dsc.inProgressM")}{" "}
            <button type="button" className="link-btn" onClick={() => setOpen(inProgress)} data-testid="dsc-in-progress-link">
              {t("dsc.openRun", { id: shortId(inProgress, 8, 4) })}
            </button>
          </Callout>
        </div>
      )}

      <div className="dsc-top">
        <BudgetPanel budget={budget} error={budgetErr} onRetry={() => void loadBudget()} />
        <KillSwitchPanel budget={budget} unknown={!budget && !!budgetErr} canSwitch={can("ops.kill_switch")} onSwitch={(v) => setPauseDlg(v)} />
      </div>
      {/* fix 6.1: AI limits from the admin */}
      <LimitsPanel budget={budget} onChanged={() => void loadBudget(true)} />

      <section className="panel mt-16" aria-labelledby="dsc-runs-h" aria-busy={loading}>
        <div className="panel-h">
          <h2 className="panel-t" id="dsc-runs-h">
            <Icon name="activity" />
            {t("dsc.runs")}
          </h2>
          <span className="grow" />
          {running && (
            <span className="dash-updated" data-testid="dsc-live">
              <span className="live" aria-hidden="true" />
              {t("dsc.live", { s: POLL_MS / 1000 })}
            </span>
          )}
          <Btn size="sm" kind="ghost" icon="refresh" label={t("common.refresh")} onClick={() => (void loadRuns(), void loadBudget())} />
        </div>
        {runsErr ? (
          <div className="panel-b">
            <LoadError error={runsErr} onRetry={() => void loadRuns()} />
          </div>
        ) : null}
        <div className="table-wrap">
          <table className="tbl" data-testid="runs-table">
            <thead>
              <tr>
                <th>{t("dsc.col.time")}</th>
                <th>{t("dsc.col.trigger")}</th>
                <th>{t("dsc.col.status")}</th>
                <th>{t("dsc.col.scope")}</th>
                <th className="r">{t("dsc.col.calls")}</th>
                <th className="r">{t("dsc.col.candidates")}</th>
                <th className="r">{t("dsc.col.ai")}</th>
                <th>{t("dsc.col.errors")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const groups = groupErrors(r.errors);
                const isExp = expanded.has(r.run_id);
                return (
                  <Fragment key={r.run_id}>
                    <tr
                      className={cx("is-click", r.status === "FAILED" ? "sev-bad" : r.status === "PARTIAL" ? "sev-warn" : r.status === "RUNNING" ? "sev-info" : "sev-none")}
                      tabIndex={0}
                      aria-label={t("common.openRow", { x: `${t(`dsc.st.${r.status}` as MessageKey)} ${shortId(r.run_id, 8, 4)}` })}
                      onClick={() => setOpen(r.run_id)}
                      onKeyDown={(e) => e.target === e.currentTarget && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(r.run_id))}
                      data-run={r.run_id}
                    >
                      <RunTime run={r} />
                      <td>
                        <Pill tone="outline" dot={false}>
                          {t(`dsc.tr.${r.trigger}` as MessageKey)}
                        </Pill>
                      </td>
                      <td>
                        <Pill tone={RUN_STATUS_TONE[r.status]}>{t(`dsc.st.${r.status}` as MessageKey)}</Pill>
                      </td>
                      <td className="nowrap">
                        <ScopeProgress run={r} />
                      </td>
                      <td className="r mono">{r.provider_calls}</td>
                      <td className="r nowrap" title={t("dsc.candidatesHint")}>
                        <span className="mono">{r.candidates_emitted}</span>
                        <span className="xs muted mono"> / {r.candidates_seen}</span>
                      </td>
                      <td className="r nowrap">
                        <div className="cell-main mono" title={t("dsc.costHint")}>
                          {fmtUsd(r.ai.cost_usd, 4)}
                        </div>
                        <div className="cell-sub mono" title={t("dsc.aiHint", { i: r.ai.input_tokens, o: r.ai.output_tokens, p: r.ai.pages_fetched })}>
                          {t("dsc.aiCalls", { n: r.ai.llm_calls })} · {tokens(r.ai.input_tokens + r.ai.output_tokens)} tok
                        </div>
                      </td>
                      <td>
                        {r.errors.length ? (
                          <button
                            type="button"
                            className={cx("btn xs", r.status === "FAILED" ? "danger-ghost" : "")}
                            aria-expanded={isExp}
                            aria-controls={`run-errs-${r.run_id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(r.run_id);
                            }}
                            data-testid={`run-errs-btn-${r.run_id}`}
                          >
                            <Icon name={isExp ? "chevD" : "chevR"} />
                            {i.tp("dsc.errorsN", r.errors.length)}
                          </button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                    {isExp && (
                      <tr className="run-errs" id={`run-errs-${r.run_id}`}>
                        <td colSpan={8}>
                          <ul className="run-err-list">
                            {groups.map((g) => (
                              <li key={g.code}>
                                <span className="act-code sec">{g.code}</span>
                                <span className="small">{runErrorLabel(t, g.code)}</span>
                                <span className="xs muted mono wrap-any">
                                  ×{g.scopes.length} · {g.scopes.slice(0, 6).join(", ")}
                                  {g.scopes.length > 6 ? ` +${g.scopes.length - 6}` : ""}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {!loading && !runs.length && !runsErr && (
                <tr>
                  <td colSpan={8} className="empty-cell">
                    <Empty icon="scan" title={t("dsc.empty.t")} text={t("dsc.empty.m")} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && <Spinner label={t("common.loading")} />}
        <div className="pager">
          <span>{t("dsc.shown", { n: runs.length })}</span>
          {cursor && !loading && <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void loadMore()} testId="dsc-more" />}
        </div>
      </section>
      <p className="xs muted foot-note">
        <Icon name="info" /> {t("dsc.foot")}
      </p>

      {starting && (
        <StartDialog
          paused={isPaused(budget)}
          onClose={() => setStarting(false)}
          onStarted={(run) => {
            setStarting(false);
            setInProgress(null);
            setRuns((xs) => [run, ...xs.filter((x) => x.run_id !== run.run_id)]);
            toast(t("dsc.started"), "ok", `run ${shortId(run.run_id, 8, 4)}`);
            void loadBudget(true);
          }}
          onInProgress={(runId) => {
            setStarting(false);
            setInProgress(runId);
            void loadRuns(true);
          }}
        />
      )}
      {pauseDlg !== null && (
        <ConfirmCommand
          title={pauseDlg ? t("dsc.pauseT") : t("dsc.resumeT")}
          text={pauseDlg ? t("dsc.pauseM") : t("dsc.resumeM")}
          icon="power"
          tone={pauseDlg ? "bad" : "warn"}
          ok={pauseDlg ? t("dsc.pause") : t("dsc.resume")}
          okKind={pauseDlg ? "danger" : "primary"}
          minReason={3}
          reasonPlaceholder={pauseDlg ? t("dsc.pausePh") : t("dsc.resumePh")}
          extra={
            <p className="xs muted row">
              <Icon name="smartphoneKey" /> {t("dsc.stepUpNote")}
            </p>
          }
          testId="dsc-pause-dialog"
          onClose={() => setPauseDlg(null)}
          onConfirm={async (reason) => {
            if (reason.length > 300) return t("dsc.reasonLong");
            try {
              const b = await DiscoveryApi.pause(pauseDlg, reason);
              setBudget(b);
              toast(pauseDlg ? t("dsc.paused") : t("dsc.resumed"), pauseDlg ? "info" : "ok", pauseDlg ? "ai.kill_switch.on" : "ai.kill_switch.off");
              return null;
            } catch (e) {
              if (e instanceof ApiError && e.cancelled) return t("stepup.cancelled");
              // the command may have failed before or after the switch: show the actual state, not a guess
              void loadBudget();
              return errText(i, e);
            }
          }}
        />
      )}
      {open && <RunDrawer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function RunTime({ run }: { run: DiscoveryRun }) {
  const { t, fmt } = useI18n();
  const now = useNow(run.status === "RUNNING");
  const end = run.finished_at ? Date.parse(run.finished_at) : now;
  const min = Math.max(0, Math.round((end - Date.parse(run.started_at)) / 60_000));
  return (
    <td className="nowrap">
      <div className="cell-main mono">{fmt.dateTime(run.started_at)}</div>
      <div className="cell-sub">{run.status === "RUNNING" ? t("dsc.runningFor", { m: min }) : t("dsc.took", { m: min })}</div>
    </td>
  );
}

function ScopeProgress({ run }: { run: DiscoveryRun }) {
  const total = Math.max(0, run.scopes_total);
  const done = Math.min(total, Math.max(0, run.scopes_done));
  return (
    <span className="scope-prog" title={`${done} / ${total}`}>
      <span className="mono">
        {done}
        <span className="muted">/{total}</span>
      </span>
      <span className="conf-bar" aria-hidden="true">
        <i style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
      </span>
    </span>
  );
}

function BudgetPanel({ budget, error, onRetry }: { budget: AiBudget | null; error: unknown; onRetry: () => void }) {
  const { t, fmt, lang } = useI18n();
  const now = useNow(!!budget);
  if (error) return <section className="panel dsc-budget">{<div className="panel-b"><LoadError error={error} onRetry={onRetry} testId="dsc-budget-error" /></div>}</section>;
  if (!budget)
    return (
      <section className="panel dsc-budget">
        <Spinner label={t("common.loading")} />
      </section>
    );
  const spent = ratio(budget.spent_usd, budget.budget_usd);
  const reserved = Math.min(1 - spent, ratio(budget.reserved_usd, budget.budget_usd));
  const level = budgetLevel(budget);
  const left = msToUtcMidnight(now);
  const hm = hoursMinutes(left);
  const resetAt = new Date(now + left).toISOString();
  const pages = ratio(budget.pages_used, budget.pages_limit);
  const remaining = Math.max(0, Number(budget.budget_usd) - Number(budget.spent_usd) - Number(budget.reserved_usd));
  return (
    <section className={cx("panel dsc-budget", `lvl-${level}`)} aria-labelledby="dsc-budget-h" data-testid="dsc-budget">
      <div className="panel-h">
        <h2 className="panel-t" id="dsc-budget-h">
          <Icon name="gauge" />
          {t("dsc.budget")}
        </h2>
        <span className="grow" />
        <span className="panel-sub" title={t("dsc.dayHint")}>
          {t("dsc.day", { d: fmtLocalDate(lang, budget.day) })} <span className="scope">UTC</span>
        </span>
      </div>
      <div className="panel-b">
        <div className="bdg-figure">
          <span className="bdg-spent" data-testid="dsc-spent">
            {fmtUsd(budget.spent_usd, 4)}
          </span>
          <span className="bdg-of">
            {t("dsc.of")} <span className="mono" data-testid="dsc-budget-limit">{fmtUsd(budget.budget_usd, 2)}</span>
          </span>
          {level !== "ok" && (
            <Pill tone={level === "bad" ? "bad" : "warn"}>{level === "bad" ? t("dsc.exhausted") : t("dsc.almost")}</Pill>
          )}
        </div>
        <div
          className="bdg-meter"
          role="meter"
          aria-label={t("dsc.budget")}
          aria-valuemin={0}
          aria-valuemax={Number(budget.budget_usd) || 1}
          aria-valuenow={Number(budget.spent_usd) || 0}
          aria-valuetext={t("dsc.meterText", { s: fmtUsd(budget.spent_usd, 4), b: fmtUsd(budget.budget_usd, 2) })}
        >
          <span className="bdg-used" style={{ width: `${spent * 100}%` }} />
          {reserved > 0 && <span className="bdg-res" style={{ width: `${reserved * 100}%` }} title={t("dsc.reserved")} />}
        </div>
        <div className="legend mt-8">
          <span>
            <i className="lg-used" />
            {t("dsc.spent")} {fmtUsd(budget.spent_usd, 4)}
            {/* sprint 6: the daily total includes the news AI (provider-gateway news/*) */}
            {budget.news && (
              <span className="muted" data-testid="dsc-spent-incl-news">
                {" "}
                {t("dsc.inclNews")}
              </span>
            )}
          </span>
          <span>
            <i className="lg-res" />
            {t("dsc.reserved")} {fmtUsd(budget.reserved_usd, 4)}
          </span>
          <span>
            <i className="lg-left" />
            {t("dsc.left")} {fmtUsd(remaining.toFixed(4), 4)}
          </span>
        </div>
      </div>
      <div className="statband">
        <div className="stat">
          <div className="stat-l">{t("dsc.pages")}</div>
          <div className="stat-v" data-testid="dsc-pages">
            {fmt.num(budget.pages_used)}
            <span className="slash">/</span>
            <span className="unit">{fmt.num(budget.pages_limit)}</span>
          </div>
          <div className="stat-s">
            <span className={cx("conf-bar wide", pages >= 1 ? "is-bad" : pages >= 0.8 && "is-warn")} aria-hidden="true">
              <i style={{ width: `${pages * 100}%` }} />
            </span>
          </div>
        </div>
        <div className="stat">
          <div className="stat-l">{t("dsc.reset")}</div>
          <div className="stat-v">{t("dsc.resetIn", { h: hm.h, m: String(hm.m).padStart(2, "0") })}</div>
          <div className="stat-s">{t("dsc.resetAt", { t: fmt.time(resetAt) })}</div>
        </div>
        <div className="stat">
          <div className="stat-l">{t("dsc.model")}</div>
          <div className="stat-v mono bdg-model" title={budget.model}>
            {budget.model}
          </div>
          <div className="stat-s">{t("dsc.modelSub")}</div>
        </div>
        {budget.news && (
          <div className="stat" data-testid="dsc-news-budget">
            <div className="stat-l">{t("dsc.news")}</div>
            <div className="stat-v" data-testid="dsc-news-value">
              {fmtUsd(budget.news.spent_usd, 4)}
              <span className="slash">/</span>
              <span className="unit">{fmtUsd(budget.news.budget_usd, 2)}</span>
            </div>
            <div className="stat-s">{t("dsc.newsSub")}</div>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Kill switch of the AI search. It stays usable when the budget did not load (`unknown`): the state is «unknown» and
 * a holder of ops.kill_switch gets both commands — stopping the AI must not depend on the budget endpoint.
 */
function KillSwitchPanel({ budget, unknown, canSwitch, onSwitch }: { budget: AiBudget | null; unknown: boolean; canSwitch: boolean; onSwitch: (pause: boolean) => void }) {
  const { t, fmt } = useI18n();
  const paused = isPaused(budget);
  const p = budget?.paused;
  return (
    <section className={cx("panel dsc-kill", paused && "is-paused")} aria-labelledby="dsc-kill-h" data-testid="dsc-kill">
      <div className="panel-h">
        <h2 className="panel-t" id="dsc-kill-h">
          <Icon name="power" />
          {t("dsc.kill")}
        </h2>
      </div>
      <div className="panel-b">
        {!budget && unknown ? (
          <>
            <div className="kill-state kill-unknown" data-testid="dsc-kill-state">
              <Icon name="alert" />
              <b>{t("dsc.stateUnknown")}</b>
            </div>
            <p className="small muted">{t("dsc.stateUnknownM")}</p>
          </>
        ) : !budget ? (
          <Spinner />
        ) : paused && p ? (
          <>
            <div className="kill-state bad" data-testid="dsc-kill-state">
              <Icon name="pause" />
              <b>{t("dsc.stateOff")}</b>
            </div>
            <dl className="kv">
              <dt>{t("dsc.pausedBy")}</dt>
              <dd className={!p.by_name && looksLikeUuid(p.by) ? "mono" : undefined} title={p.by} data-testid="dsc-paused-by">
                {p.by_name ?? (looksLikeUuid(p.by) ? shortId(p.by, 8, 4) : p.by)}
              </dd>
              <dt>{t("dsc.pausedAt")}</dt>
              <dd>{fmt.dateTime(p.at)}</dd>
              <dt>{t("cmd.reason")}</dt>
              <dd className="wrap-any">{p.reason}</dd>
            </dl>
          </>
        ) : (
          <>
            <div className="kill-state good" data-testid="dsc-kill-state">
              <span className="health-dot" aria-hidden="true" />
              <b>{t("dsc.stateOn")}</b>
            </div>
            <p className="small muted">{t("dsc.stateOnM")}</p>
          </>
        )}
        {(budget || unknown) && (
          <div className="kill-acts">
            {canSwitch && !budget ? (
              <>
                <Btn kind="danger-ghost" icon="pause" label={t("dsc.pause")} onClick={() => onSwitch(true)} testId="dsc-pause" />
                <Btn icon="play" label={t("dsc.resume")} onClick={() => onSwitch(false)} testId="dsc-resume" />
              </>
            ) : canSwitch ? (
              paused ? (
                <Btn kind="primary" icon="play" label={t("dsc.resume")} onClick={() => onSwitch(false)} testId="dsc-resume" />
              ) : (
                <Btn kind="danger-ghost" icon="pause" label={t("dsc.pause")} onClick={() => onSwitch(true)} testId="dsc-pause" />
              )
            ) : (
              <p className="xs muted row" data-testid="dsc-kill-ro">
                <Icon name="lock" /> {t("dsc.killRo", { p: "ops.kill_switch" })}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function StartDialog({ paused, onClose, onStarted, onInProgress }: { paused: boolean; onClose: () => void; onStarted: (r: DiscoveryRun) => void; onInProgress: (runId: string) => void }) {
  const i = useI18n();
  const { t } = i;
  const key = useRef(uuid());
  const [limit, setLimit] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    const n = limit.trim() ? Number(limit) : null;
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 200)) return setErr(t("dsc.limitErr"));
    setBusy(true);
    setErr(null);
    try {
      onStarted(await DiscoveryApi.start(n, key.current));
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.code === "DISCOVERY_RUN_IN_PROGRESS") {
        const id = e.str("run_id");
        if (id) return onInProgress(id);
      }
      setErr(e instanceof ApiError && e.cancelled ? t("stepup.cancelled") : errText(i, e));
    }
  };
  return (
    <Modal
      title={t("dsc.startT")}
      text={t("dsc.startM")}
      icon="play"
      tone="warn"
      onClose={() => !busy && onClose()}
      testId="dsc-start-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn kind="primary" icon="play" label={t("dsc.startOk")} busy={busy} onClick={() => void submit()} testId="dsc-start-ok" />
        </>
      }
    >
      {paused && (
        <Callout kind="warn" icon="pause">
          {t("dsc.startPaused")}
        </Callout>
      )}
      <div className="field">
        <label htmlFor="dsc-limit">{t("dsc.limit")}</label>
        <input
          id="dsc-limit"
          className="input mono"
          type="number"
          inputMode="numeric"
          min={1}
          max={200}
          placeholder={t("dsc.limitPh")}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          aria-invalid={err ? true : undefined}
          aria-describedby="dsc-limit-hint"
          data-autofocus=""
          data-testid="dsc-limit"
        />
        <span className="hint" id="dsc-limit-hint">
          {t("dsc.limitHint")}
        </span>
      </div>
      <FieldErr msg={err} />
      <p className="xs muted row">
        <Icon name="audit" /> {t("dsc.startAudit")}
      </p>
    </Modal>
  );
}

function RunDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, fmt } = useI18n();
  const [run, setRun] = useState<DiscoveryRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(
    async (background = false) => {
      try {
        setRun(await DiscoveryApi.run(id, background));
        setError(null);
      } catch (e) {
        if (!background) setError(e);
      }
    },
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (run?.status !== "RUNNING") return;
    const tm = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(tm);
  }, [run?.status, load]);

  return (
    <Drawer
      testId="run-card"
      onClose={onClose}
      title={
        <>
          {t("dsc.run")} <span className="mono">{shortId(id, 8, 4)}</span>
        </>
      }
      sub={
        run ? (
          <>
            <Pill tone={RUN_STATUS_TONE[run.status]}>{t(`dsc.st.${run.status}` as MessageKey)}</Pill>
            <span>{t(`dsc.tr.${run.trigger}` as MessageKey)}</span>
          </>
        ) : undefined
      }
    >
      {error ? <LoadError error={error} onRetry={() => void load()} /> : null}
      {!run && !error && <Spinner label={t("common.loading")} />}
      {run && (
        <div className="stack">
          <dl className="dl">
            <dt>run_id</dt>
            <dd className="mono">
              {run.run_id} <CopyBtn value={run.run_id} label="run_id" />
            </dd>
            <dt>{t("dsc.startedAt")}</dt>
            <dd>{fmt.dateTime(run.started_at)}</dd>
            <dt>{t("dsc.finishedAt")}</dt>
            <dd>{run.finished_at ? fmt.dateTime(run.finished_at) : <span className="muted">{t("dsc.st.RUNNING")}</span>}</dd>
            <dt>{t("dsc.col.scope")}</dt>
            <dd>
              <ScopeProgress run={run} />
            </dd>
            <dt>{t("dsc.col.calls")}</dt>
            <dd className="mono">{run.provider_calls}</dd>
            <dt>{t("dsc.col.candidates")}</dt>
            <dd>
              {t("dsc.candidatesFull", { e: run.candidates_emitted, s: run.candidates_seen })}
            </dd>
          </dl>
          <section className="panel" aria-labelledby="run-ai-h">
            <div className="panel-h">
              <h3 className="panel-t" id="run-ai-h">
                <Icon name="sparkles" />
                {t("dsc.aiUsage")}
              </h3>
            </div>
            <div className="statband">
              <div className="stat">
                <div className="stat-l">{t("dsc.cost")}</div>
                <div className="stat-v mono">{fmtUsd(run.ai.cost_usd, 4)}</div>
              </div>
              <div className="stat">
                <div className="stat-l">{t("dsc.llmCalls")}</div>
                <div className="stat-v">{fmt.num(run.ai.llm_calls)}</div>
              </div>
              <div className="stat">
                <div className="stat-l">{t("dsc.pagesFetched")}</div>
                <div className="stat-v">{fmt.num(run.ai.pages_fetched)}</div>
              </div>
              <div className="stat">
                <div className="stat-l">{t("dsc.tokensIn")}</div>
                <div className="stat-v">{fmt.num(run.ai.input_tokens)}</div>
              </div>
              <div className="stat">
                <div className="stat-l">{t("dsc.tokensOut")}</div>
                <div className="stat-v">{fmt.num(run.ai.output_tokens)}</div>
              </div>
            </div>
          </section>
          <section aria-labelledby="run-err-h">
            <h3 className="sec-h" id="run-err-h">
              {t("dsc.col.errors")}
            </h3>
            {run.errors.length ? (
              <ul className="run-err-list" data-testid="run-errors">
                {groupErrors(run.errors).map((g) => (
                  <li key={g.code}>
                    <span className="act-code sec">{g.code}</span>
                    <span className="small">{runErrorLabel(t, g.code)}</span>
                    <span className="xs muted mono wrap-any">{g.scopes.join(", ")}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">{t("dsc.noErrors")}</p>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}

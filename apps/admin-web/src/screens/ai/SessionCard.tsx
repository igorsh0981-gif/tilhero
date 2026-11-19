/**
 * Card of a learner session in «Контроль диалогов» (qa.read; ADM-QA-02…04, UC-ADM-03, AT-52). Three independent
 * blocks, each with its own «no data»: the session (lessons — content and agent versions, status history, steps with
 * results and hints, metadata of the replies), the evaluations (assessment — the original and re-evaluations, scores
 * per criterion, errors with the quote and the correction, skill outcomes, evaluator versions, flags) and the AI calls
 * (ai-gateway — model, version, tokens, cost, latency, status). The learner is a pseudonymous user_ref only.
 * «Показать реплики» (qa.transcripts: a reason ≥ 10, every opening is audited; texts past 90 days — «deleted by
 * retention»), «Отметить спорной» (a flag with a reason, the evaluation itself is not changed), «Переоценить»
 * (qa.review, step-up: scores 0…3 / not assessed, skill outcomes, errors, a reason ≥ 10 → a new record that keeps the
 * original) and «Сформировать задачу» (Markdown for Jira without learner data — copy or download .md).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiCall, EvaluationCard, Reevaluation, SessionCard, Transcript } from "@tilhero/contracts/admin";
import type { ConfirmedError, RubricCriterionCode } from "@tilhero/contracts/ai";
import { Qa } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, copyText, CopyBtn, cx, FieldErr, IconBtn, Pill, Seg, Select, Spinner, type Tone } from "../../ui/kit";
import { ConfirmCommand, Drawer } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { SEVERITIES, SKILL_OUTCOMES, taskFileName, taskMarkdown, type TaskInput } from "./model";
import { BlockOff, CharCount, Kv, useKeyed, useUsd } from "./parts";

export const SST_TONE: Record<string, Tone> = { ready: "neutral", in_progress: "info", paused: "warn", completed: "good", failed: "bad", cancelled: "neutral" };
export const EVS_TONE: Record<EvaluationCard["status"], Tone> = { ok: "good", partial: "warn", insufficient_evidence: "neutral", pending_review: "warn" };
export const SEV_TONE: Record<ConfirmedError["severity"], Tone> = { low: "neutral", medium: "warn", high: "bad" };
export const SKO_TONE: Record<string, Tone> = { demonstrated: "good", learning: "info", not_assessed: "neutral" };
const SVC = { lessons: "lessons", assessment: "assessment", "ai-gateway": "ai-gateway" } as const;

export const latestOf = (card: SessionCard | null): EvaluationCard | null => (card?.evaluations?.length ? card.evaluations[card.evaluations.length - 1]! : null);

export function SessionCardView({ id, onBack, appealId }: { id: string; onBack: () => void; appealId?: string | null }) {
  const i = useI18n();
  const { t } = i;
  const { can } = useSession();
  const toast = useToast();
  const k = useKeyed();
  const [card, setCard] = useState<SessionCard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dlg, setDlg] = useState<null | "transcript" | "flag" | "reeval" | "task">(null);
  const load = useCallback(async () => {
    try {
      const c = await Qa.session(id);
      setCard(c);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error && !card) return <LoadError error={error} onRetry={() => void load()} />;
  if (!card) return <Spinner label={t("common.loading")} />;
  const s = card.session;
  const latest = latestOf(card);
  const title = s ? s.title.ru || s.lesson_id || s.scenario_id || s.asset_id || id : id;
  return (
    <div className="stack" data-testid="qa-card" data-session={id}>
      <div className="row">
        <Btn size="sm" kind="ghost" icon="chevL" label={t("qa.back")} onClick={onBack} testId="qa-back" />
      </div>
      <section className="card qa-head" aria-labelledby="qa-h">
        <div className="ws-h">
          <div className="grow">
            <div className="crumb">
              {t("qa.cardCrumb")} · {s ? k("sk", s.kind) : "—"}
            </div>
            <h2 className="h2 wrap-any" id="qa-h" lang={s ? "ru" : undefined}>
              {title}
            </h2>
            <span className="row small">
              <span className="muted">{t("qa.sessionId")}</span> <span className="mono" data-testid="qa-sid">{id}</span>
              <CopyBtn value={id} label={t("qa.sessionId")} />
            </span>
            {s && (
              <span className="row small" data-testid="qa-user-ref">
                <Icon name="user" /> <span className="muted">{t("qa.userRef")}</span> <span className="mono">{s.user_ref}</span>
              </span>
            )}
          </div>
          {s && (
            <div className="ws-pills">
              <Pill tone={SST_TONE[s.status] ?? "neutral"} testId="qa-status">
                {k("sst", s.status)}
              </Pill>
              {s.outcome && <Pill tone={s.outcome === "fail" ? "warn" : "good"}>{k("out", s.outcome)}</Pill>}
              {s.passed != null && <Pill tone={s.passed ? "good" : "warn"}>{s.passed ? t("qa.passed") : t("qa.notPassed")}</Pill>}
              <Pill dot={false}>{k("aimode", s.ai_mode)}</Pill>
              <Pill dot={false}>{k("ageseg", s.audience)}</Pill>
              {s.level && <span className="tag">{s.level}</span>}
            </div>
          )}
        </div>
        {s && s.flags.length > 0 && (
          <div className="row" data-testid="qa-flags">
            {s.flags.map((f) => (
              <Pill key={f} tone={f === "failed" || f === "ai_unavailable" ? "bad" : f === "human_review" || f === "appealed" || f === "flagged" ? "warn" : "info"}>
                {k("sflag", f)}
              </Pill>
            ))}
          </div>
        )}
        <div className="acts ws-acts" data-testid="qa-actions">
          {can("qa.transcripts") && <Btn icon="eye" label={t("qa.showTranscript")} onClick={() => setDlg("transcript")} testId="qa-transcript" />}
          <Btn icon="note" label={t("qa.task")} onClick={() => setDlg("task")} testId="qa-task" />
          {latest && <Btn icon="alert" label={t("qa.flag")} onClick={() => setDlg("flag")} testId="qa-flag" />}
          {latest && can("qa.review") && <Btn kind="primary" icon="clipboardCheck" label={t("qa.reeval")} onClick={() => setDlg("reeval")} testId="qa-reeval" />}
        </div>
        {!can("qa.transcripts") && (
          <p className="xs muted row" data-testid="qa-no-transcripts">
            <Icon name="lock" /> {t("qa.noTranscripts")}
          </p>
        )}
      </section>

      <SessionBlock card={card} />
      <EvaluationsBlock card={card} />
      <CallsBlock card={card} />

      {dlg === "transcript" && <TranscriptFlow sessionId={id} onClose={() => setDlg(null)} />}
      {dlg === "task" && <TaskDrawer card={card} onClose={() => setDlg(null)} />}
      {dlg === "flag" && latest && (
        <ConfirmCommand
          title={t("qa.flagT")}
          text={t("qa.flagM")}
          icon="alert"
          ok={t("qa.flagOk")}
          minReason={10}
          reasonLabel={t("qa.flagReason")}
          testId="qa-flag-dialog"
          onClose={() => setDlg(null)}
          onConfirm={async (reason) => {
            try {
              const ev = await Qa.flag(latest.evaluation_id, reason);
              setCard((c) => (c ? { ...c, evaluations: c.evaluations?.map((x) => (x.evaluation_id === ev.evaluation_id ? ev : x)) ?? null } : c));
              toast(t("qa.flagged"), "ok", "qa.flagged");
              return null;
            } catch (e) {
              return errText(i, e);
            }
          }}
        />
      )}
      {dlg === "reeval" && latest && (
        <ReevalDrawer
          card={card}
          evaluation={latest}
          appealId={appealId ?? null}
          onClose={() => setDlg(null)}
          onDone={() => {
            setDlg(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- blocks */

function SessionBlock({ card }: { card: SessionCard }) {
  const { t, fmt } = useI18n();
  const k = useKeyed();
  const s = card.session;
  return (
    <section className="card qa-block" aria-labelledby="qb-s" data-testid="qa-block-session" data-available={String(!!s)}>
      <h3 className="h2 blk-h" id="qb-s">
        <Icon name="book" /> {t("qa.b.session")}
      </h3>
      {!s ? (
        <BlockOff service={SVC.lessons} code={card.errors.lessons} testId="qa-block-session-off" />
      ) : (
        <div className="stack sm">
          <div className="grid2 tight">
            <div>
              <Kv k={t("qa.k.kind")} v={k("sk", s.kind)} />
              <Kv k={t("qa.k.content")} v={<span className="mono">{s.lesson_id ?? s.scenario_id ?? s.asset_id ?? "—"}</span>} />
              <Kv k={t("qa.k.started")} v={fmt.dateTime(s.started_at) || "—"} />
              <Kv k={t("qa.k.finished")} v={fmt.dateTime(s.finished_at) || "—"} />
              <Kv k={t("qa.k.minutes")} v={fmt.num(s.minutes)} />
            </div>
            <div>
              <div className="blk-sub">{t("qa.versions")}</div>
              <div className="row" data-testid="qa-versions">
                {Object.entries(s.content_versions).map(([kk, v]) => (
                  <span key={kk} className="code-chip">
                    {kk} v{v}
                  </span>
                ))}
                {!Object.keys(s.content_versions).length && <span className="muted small">—</span>}
              </div>
              <div className="blk-sub">{t("qa.models")}</div>
              <div className="row">
                {s.models.length ? s.models.map((m) => <span key={m} className="code-chip">{m}</span>) : <span className="muted small">{t("qa.noModels")}</span>}
              </div>
            </div>
          </div>
          <div className="blk-sub">{t("qa.history")}</div>
          <div className="table-wrap">
            <table className="tbl dense" data-testid="qa-history">
              <caption className="sr-only">{t("qa.history")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("qa.col.at")}</th>
                  <th scope="col">{t("qa.col.from")}</th>
                  <th scope="col">{t("qa.col.to")}</th>
                  <th scope="col">{t("qa.col.reason")}</th>
                </tr>
              </thead>
              <tbody>
                {s.status_history.map((h, n) => (
                  <tr key={n}>
                    <td className="small">{fmt.dateTimeS(h.at)}</td>
                    <td>{h.from ? k("sst", h.from) : "—"}</td>
                    <td>
                      <Pill tone={SST_TONE[h.to] ?? "neutral"}>{k("sst", h.to)}</Pill>
                    </td>
                    <td className="small">{k("shr", h.reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="blk-sub">{t("qa.steps", { n: s.steps.length })}</div>
          {s.steps.length ? (
            <div className="table-wrap">
              <table className="tbl dense" data-testid="qa-steps">
                <caption className="sr-only">{t("qa.steps", { n: s.steps.length })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("qa.col.step")}</th>
                    <th scope="col">{t("qa.col.stage")}</th>
                    <th scope="col">{t("qa.col.type")}</th>
                    <th scope="col">{t("qa.col.result")}</th>
                    <th scope="col">{t("qa.col.hint")}</th>
                    <th scope="col">{t("qa.col.answered")}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.steps.map((st) => (
                    <tr key={st.step_id}>
                      <td className="mono small">{st.step_id}</td>
                      <td>{k("stage", st.stage)}</td>
                      <td className="mono small">{st.type}</td>
                      <td>{st.result ? <Pill tone={st.result === "correct" ? "good" : st.result === "incorrect" ? "bad" : "neutral"}>{k("stres", st.result)}</Pill> : <span className="muted">—</span>}</td>
                      <td>{st.hinted ? <Pill tone="warn">{t("qa.hinted")}</Pill> : <span className="muted">—</span>}</td>
                      <td className="small">{fmt.time(st.answered_at) || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted">{t("qa.noSteps")}</p>
          )}
          <div className="blk-sub">{t("qa.turns", { n: s.turns_meta.length })}</div>
          {s.turns_meta.length ? (
            <div className="table-wrap">
              <table className="tbl dense" data-testid="qa-turns">
                <caption className="sr-only">{t("qa.turns", { n: s.turns_meta.length })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("qa.col.turn")}</th>
                    <th scope="col">{t("qa.col.speaker")}</th>
                    <th scope="col">{t("qa.col.mode")}</th>
                    <th scope="col">{t("qa.col.intent")}</th>
                    <th scope="col">{t("qa.col.call")}</th>
                    <th scope="col">{t("qa.col.text")}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.turns_meta.map((tm) => (
                    <tr key={tm.turn_id}>
                      <td className="mono small">{tm.turn_id}</td>
                      <td>{k("spk", tm.speaker)}</td>
                      <td>{k("tmode", tm.mode)}</td>
                      <td className="mono small">{tm.intent ?? "—"}</td>
                      <td className="mono xs">{tm.ai_call_id ? tm.ai_call_id.slice(0, 8) : "—"}</td>
                      <td className="small">{tm.redacted ? <span className="muted">{t("qa.redacted")}</span> : <span className="muted">{t("qa.textHidden")}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted">{t("qa.noTurns")}</p>
          )}
        </div>
      )}
    </section>
  );
}

function EvaluationsBlock({ card }: { card: SessionCard }) {
  const { t } = useI18n();
  const evs = card.evaluations;
  return (
    <section className="card qa-block" aria-labelledby="qb-e" data-testid="qa-block-evaluations" data-available={String(!!evs)}>
      <h3 className="h2 blk-h" id="qb-e">
        <Icon name="clipboardCheck" /> {t("qa.b.evaluations")}
      </h3>
      {!evs ? (
        <BlockOff service={SVC.assessment} code={card.errors.assessment} testId="qa-block-evaluations-off" />
      ) : !evs.length ? (
        <p className="small muted" data-testid="qa-no-evaluations">
          {t("qa.noEvaluations")}
        </p>
      ) : (
        <ol className="ev-chain">
          {evs.map((e, n) => (
            <li key={e.evaluation_id}>
              <EvaluationView e={e} n={n} latest={n === evs.length - 1} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function EvaluationView({ e, n, latest }: { e: EvaluationCard; n: number; latest: boolean }) {
  const { t, fmt } = useI18n();
  const k = useKeyed();
  return (
    <article className={cx("ev", latest && "is-latest")} aria-labelledby={`ev-${e.evaluation_id}`} data-testid={`ev-${n}`} data-evaluation={e.evaluation_id}>
      <div className="ws-h">
        <div className="grow">
          <h4 className="h3" id={`ev-${e.evaluation_id}`}>
            {n === 0 ? t("qa.ev.original") : t("qa.ev.reN", { n })}
            {latest && (
              <span className="ml-6">
                <Pill tone="accent">{t("qa.ev.current")}</Pill>
              </span>
            )}
          </h4>
          <span className="small muted">
            {fmt.dateTime(e.created_at)} · {e.created_by_name ?? t("qa.ev.system")} · <span className="mono">{e.evaluation_id.slice(0, 8)}</span>
          </span>
        </div>
        <div className="ws-pills">
          <Pill tone={EVS_TONE[e.status]}>{k("evs", e.status)}</Pill>
          {e.passed != null && <Pill tone={e.passed ? "good" : "warn"}>{e.passed ? t("qa.passed") : t("qa.notPassed")}</Pill>}
          {e.requires_human_review && <Pill tone="warn">{t("qa.ev.humanReview")}</Pill>}
          {e.practice_only && <Pill dot={false}>{t("qa.ev.practice")}</Pill>}
        </div>
      </div>
      {e.reason && (
        <p className="small ev-reason">
          <b>{t("qa.ev.reason")}</b> <span className="wrap-any">{e.reason}</span>
        </p>
      )}
      <div className="grid2 tight">
        <div>
          <Kv k={t("qa.ev.rubric")} v={<span className="mono">{`${e.rubric.rubric_id} v${e.rubric.version}`}</span>} />
          <Kv k={t("qa.ev.weighted")} v={e.weighted != null ? fmt.num(e.weighted, 2) : "—"} />
          <Kv k={t("qa.ev.task")} v={e.task_completed == null ? "—" : e.task_completed ? t("common.yes") : t("common.no")} />
          <Kv
            k={t("qa.ev.evaluator")}
            v={
              e.evaluator ? (
                <span className="mono small" data-testid={`ev-${n}-evaluator`}>
                  {e.evaluator.prompt_version} · {e.evaluator.model_id} · {e.evaluator.schema_version}
                  {e.evaluator.canary ? ` · ${t("ag.canaryShort")}` : ""}
                </span>
              ) : (
                t("qa.ev.rulesOnly")
              )
            }
          />
        </div>
        <div>
          <table className="tbl dense mini-tbl" data-testid={`ev-${n}-scores`}>
            <caption className="sr-only">{t("qa.ev.scores")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("qa.ev.criterion")}</th>
                <th scope="col" className="r">
                  {t("qa.ev.score")}
                </th>
              </tr>
            </thead>
            <tbody>
              {e.scores.map((x) => (
                <tr key={x.code}>
                  <td>{k("rc", x.code)}</td>
                  <td className="r num">{x.score == null ? <span className="muted">{t("qa.ev.notScored")}</span> : <b>{x.score}/3</b>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="blk-sub">{t("qa.ev.errors", { n: e.confirmed_errors.length })}</div>
      {e.confirmed_errors.length ? (
        <div className="table-wrap">
          <table className="tbl dense" data-testid={`ev-${n}-errors`}>
            <caption className="sr-only">{t("qa.ev.errors", { n: e.confirmed_errors.length })}</caption>
            <thead>
              <tr>
                <th scope="col">{t("qa.col.turn")}</th>
                <th scope="col">{t("qa.ev.evidence")}</th>
                <th scope="col">{t("qa.ev.correction")}</th>
                <th scope="col">{t("qa.ev.code")}</th>
                <th scope="col">{t("qa.ev.severity")}</th>
              </tr>
            </thead>
            <tbody>
              {e.confirmed_errors.map((x, j) => (
                <tr key={j}>
                  <td className="mono small">{x.turn_id}</td>
                  <td className="small wrap-any">
                    <q className="ev-quote">{x.evidence}</q>
                  </td>
                  <td className="small wrap-any">{x.correction}</td>
                  <td className="mono xs">{x.error_code}</td>
                  <td>
                    <Pill tone={SEV_TONE[x.severity]}>{k("sev", x.severity)}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small muted">{t("qa.ev.noErrors")}</p>
      )}
      <div className="grid2 tight">
        <div>
          <div className="blk-sub">{t("qa.ev.skills")}</div>
          {e.skill_outcomes.length ? (
            <ul className="plain-list ev-skills">
              {e.skill_outcomes.map((x) => (
                <li key={x.skill_id}>
                  <span className="mono small">{x.skill_id}</span> <Pill tone={SKO_TONE[x.outcome] ?? "neutral"}>{k("skout", x.outcome)}</Pill>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">—</p>
          )}
        </div>
        <div>
          <div className="blk-sub">{t("qa.ev.items", { n: e.items.length })}</div>
          {e.items.length ? (
            <ul className="plain-list ev-skills">
              {e.items.map((x) => (
                <li key={x.item_id}>
                  <span className="mono small">{x.item_id}</span> {x.correct ? <Pill tone="good">{t("stres.correct")}</Pill> : <Pill tone="bad">{t("stres.incorrect")}</Pill>}
                  {x.hinted && <Pill tone="warn">{t("qa.hinted")}</Pill>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">—</p>
          )}
        </div>
      </div>
      {e.flags.length > 0 && (
        <div data-testid={`ev-${n}-flags`}>
          <div className="blk-sub">{t("qa.ev.flags", { n: e.flags.length })}</div>
          <ul className="plain-list">
            {e.flags.map((f, j) => (
              <li key={j} className="small">
                <Icon name="alert" /> <span className="wrap-any">{f.reason}</span> <span className="muted">· {f.by_name ?? "—"} · {fmt.dateTime(f.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {e.supersedes && <p className="xs muted">{t("qa.ev.supersedes", { id: e.supersedes.slice(0, 8) })}</p>}
    </article>
  );
}

function CallsBlock({ card }: { card: SessionCard }) {
  const { t, fmt } = useI18n();
  const k = useKeyed();
  const money = useUsd();
  const calls = card.ai_calls;
  const total = useMemo(() => (calls ?? []).reduce((a, c) => a + c.cost_usd, 0), [calls]);
  return (
    <section className="card qa-block" aria-labelledby="qb-c" data-testid="qa-block-calls" data-available={String(!!calls)}>
      <h3 className="h2 blk-h" id="qb-c">
        <Icon name="cpu" /> {t("qa.b.calls")}
        {calls && calls.length > 0 && <span className="small muted"> · {t("qa.callsTotal", { n: calls.length, c: money(total) })}</span>}
      </h3>
      {!calls ? (
        <BlockOff service={SVC["ai-gateway"]} code={card.errors["ai-gateway"]} testId="qa-block-calls-off" />
      ) : !calls.length ? (
        <p className="small muted">{t("qa.noCalls")}</p>
      ) : (
        <div className="table-wrap">
          <table className="tbl dense" data-testid="qa-calls">
            <caption className="sr-only">{t("qa.b.calls")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("qa.col.at")}</th>
                <th scope="col">{t("qa.col.agent")}</th>
                <th scope="col">{t("qa.col.model")}</th>
                <th scope="col">{t("col.status")}</th>
                <th scope="col" className="r">
                  {t("qa.col.tokens")}
                </th>
                <th scope="col" className="r">
                  {t("qa.col.cost")}
                </th>
                <th scope="col" className="r">
                  {t("qa.col.latency")}
                </th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c: AiCall) => (
                <tr key={c.call_id}>
                  <td className="small">{fmt.time(c.created_at)}</td>
                  <td>
                    <span className="mono small">{c.agent_id}</span>
                    {c.version != null && <span className="mono xs muted"> v{c.version}</span>}
                    {c.canary && (
                      <span className="ml-6">
                        <Pill tone="accent">{t("ag.canaryShort")}</Pill>
                      </span>
                    )}
                  </td>
                  <td className="mono small">{c.model_id ?? "—"}</td>
                  <td>
                    <Pill tone={c.status === "ok" ? "good" : c.status === "refused" ? "neutral" : "bad"}>{k("callst", c.status)}</Pill>
                    {c.reason && <span className="xs muted block">{k("aireason", c.reason)}</span>}
                  </td>
                  <td className="r num small">
                    {fmt.num(c.input_tokens)} / {fmt.num(c.output_tokens)}
                  </td>
                  <td className="r num small">{money(c.cost_usd)}</td>
                  <td className="r num small">{fmt.num(c.latency_ms)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- transcript (qa.transcripts, reason, audit) */

function TranscriptFlow({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const i = useI18n();
  const { t } = i;
  const k = useKeyed();
  const [tr, setTr] = useState<Transcript | null>(null);
  // ConfirmCommand closes itself after a successful command: the flow stays open and shows the texts instead
  const loaded = useRef(false);
  if (!tr)
    return (
      <ConfirmCommand
        title={t("qa.trT")}
        text={t("qa.trM")}
        icon="eye"
        ok={t("qa.trOk")}
        minReason={10}
        reasonLabel={t("qa.trReason")}
        reasonPlaceholder={t("qa.trReasonPh")}
        testId="qa-transcript-dialog"
        extra={
          <Callout kind="warn" icon="audit" testId="qa-transcript-audit">
            {t("qa.trAudit")}
          </Callout>
        }
        onClose={() => {
          if (!loaded.current) onClose();
        }}
        onConfirm={async (reason) => {
          try {
            const x = await Qa.transcript(sessionId, reason);
            loaded.current = true;
            setTr(x);
            return null;
          } catch (e) {
            if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
            return errText(i, e);
          }
        }}
      />
    );
  return (
    <Drawer wide title={t("qa.trTitle")} sub={<span className="mono">{sessionId}</span>} onClose={onClose} testId="qa-transcript-view">
      <div className="stack sm">
        <Callout kind="warn" icon="audit">
          {t("qa.trViewed")}
        </Callout>
        <h3 className="h3">{t("qa.trTurns", { n: tr.turns.length })}</h3>
        {tr.turns.length ? (
          <ol className="tr-list" data-testid="qa-tr-turns">
            {tr.turns.map((x) => (
              <li key={x.turn_id} className={cx("tr-turn", x.speaker)} data-testid={`qa-tr-${x.turn_id}`}>
                <span className="tr-meta">
                  <span className="mono">{x.turn_id}</span> · {k("spk", x.speaker)} · {k("tmode", x.mode)}
                </span>
                {x.redacted || x.text == null ? (
                  <span className="tr-text is-redacted" data-testid={`qa-tr-${x.turn_id}-redacted`}>
                    <Icon name="clock" /> {t("qa.redactedLong")}
                  </span>
                ) : (
                  <span className="tr-text wrap-any">{x.text}</span>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="small muted">{t("qa.noTurns")}</p>
        )}
        <h3 className="h3">{t("qa.trAnswers", { n: tr.answers.length })}</h3>
        {tr.answers.length ? (
          <div className="table-wrap">
            <table className="tbl dense" data-testid="qa-tr-answers">
              <thead>
                <tr>
                  <th scope="col">{t("qa.col.step")}</th>
                  <th scope="col">{t("qa.col.item")}</th>
                  <th scope="col">{t("qa.col.answer")}</th>
                </tr>
              </thead>
              <tbody>
                {tr.answers.map((a, n) => (
                  <tr key={n}>
                    <td className="mono small">{a.step_id}</td>
                    <td className="mono small">{a.item_id}</td>
                    <td className="small wrap-any">{a.answer ?? <span className="muted">{t("qa.redactedLong")}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">—</p>
        )}
        <h3 className="h3">{t("qa.trOpen")}</h3>
        <p className="small wrap-any" data-testid="qa-tr-open">
          {tr.open_answer ?? <span className="muted">—</span>}
        </p>
      </div>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- re-evaluation (qa.review, step-up) */

type ScoreV = "" | "0" | "1" | "2" | "3";
interface ErrDraft {
  turn_id: string;
  evidence: string;
  correction: string;
  error_code: string;
  severity: ConfirmedError["severity"];
}

export function ReevalDrawer({ card, evaluation, appealId, onClose, onDone }: { card: SessionCard; evaluation: EvaluationCard; appealId: string | null; onClose: () => void; onDone: (e: EvaluationCard) => void }) {
  const i = useI18n();
  const { t } = i;
  const k = useKeyed();
  const toast = useToast();
  const [scores, setScores] = useState<Record<string, ScoreV>>(() => Object.fromEntries(evaluation.scores.map((x) => [x.code, x.score == null ? "" : (String(x.score) as ScoreV)])));
  const [skills, setSkills] = useState(() => evaluation.skill_outcomes.map((x) => ({ ...x })));
  const [errs, setErrs] = useState<ErrDraft[]>(() => evaluation.confirmed_errors.map((x) => ({ ...x })));
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(uuid());
  const refs = useMemo(() => {
    const turns = (card.session?.turns_meta ?? []).filter((x) => x.speaker === "learner").map((x) => x.turn_id);
    const items = evaluation.items.map((x) => x.item_id);
    return [...new Set([...turns, ...items, ...evaluation.confirmed_errors.map((x) => x.turn_id)])];
  }, [card, evaluation]);
  const errIssues = errs.map((e) => ({
    turn_id: !e.turn_id,
    evidence: !e.evidence.trim() || e.evidence.length > 120,
    correction: !e.correction.trim() || e.correction.length > 200,
    error_code: !/^[a-z][a-z0-9_]{1,39}$/.test(e.error_code.trim()),
  }));
  const reasonBad = reason.trim().length < 10 || reason.length > 500;
  const bad = reasonBad || errIssues.some((x) => Object.values(x).some(Boolean)) || errs.length > 5;
  const changed =
    evaluation.scores.some((x) => (x.score == null ? "" : String(x.score)) !== scores[x.code]) ||
    skills.some((x, n) => x.outcome !== evaluation.skill_outcomes[n]?.outcome) ||
    JSON.stringify(errs) !== JSON.stringify(evaluation.confirmed_errors);
  const submit = async () => {
    setTried(true);
    if (busy) return;
    if (bad) {
      setErr(t("rv2.fix"));
      return;
    }
    setBusy(true);
    setErr(null);
    const body: Reevaluation = {
      scores: Object.fromEntries(Object.entries(scores).map(([c, v]) => [c, v === "" ? null : (Number(v) as 0 | 1 | 2 | 3)])) as Reevaluation["scores"],
      skill_outcomes: skills,
      confirmed_errors: errs.map((e) => ({ ...e, evidence: e.evidence.trim(), correction: e.correction.trim(), error_code: e.error_code.trim() })),
      reason: reason.trim(),
      appeal_id: appealId,
    };
    try {
      const ev = await Qa.reevaluate(evaluation.evaluation_id, body, key.current);
      toast(t("rv2.done"), "ok", "qa.reevaluated");
      onDone(ev);
    } catch (e) {
      setBusy(false);
      if ((e as ApiError)?.cancelled) setErr(t("stepup.cancelled"));
      else setErr(errText(i, e));
    }
  };
  return (
    <Drawer
      wide
      title={t("rv2.title")}
      sub={
        <span>
          {t("rv2.sub", { id: evaluation.evaluation_id.slice(0, 8) })}
          {appealId && ` · ${t("rv2.byAppeal")}`}
        </span>
      }
      onClose={onClose}
      testId="qa-reeval-drawer"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <span className="grow" />
          <Btn kind="primary" icon="check" label={t("rv2.submit")} busy={busy} onClick={() => void submit()} testId="rv2-submit" />
        </>
      }
    >
      <div className="stack sm">
        <Callout kind="info" icon="info">
          {t("rv2.note")}
        </Callout>
        <fieldset className="rv2-set">
          <legend className="h3">{t("rv2.scores")}</legend>
          <div className="rv2-grid">
            {evaluation.scores.map((x) => (
              <div key={x.code} className="field">
                <label htmlFor={`rv2-s-${x.code}`}>
                  {k("rc", x.code)} <span className="xs muted">({t("rv2.was", { v: x.score == null ? t("qa.ev.notScored") : `${x.score}/3` })})</span>
                </label>
                <Select<ScoreV>
                  id={`rv2-s-${x.code}`}
                  label={k("rc", x.code)}
                  value={scores[x.code] ?? ""}
                  onChange={(v) => setScores((s) => ({ ...s, [x.code]: v }))}
                  options={[{ v: "", label: t("qa.ev.notScored") }, ...(["0", "1", "2", "3"] as const).map((v) => ({ v, label: `${v} — ${t(`rv2.band.${v}`)}` }))]}
                  testId={`rv2-s-${x.code as RubricCriterionCode}`}
                />
              </div>
            ))}
          </div>
        </fieldset>
        {skills.length > 0 && (
          <fieldset className="rv2-set">
            <legend className="h3">{t("rv2.skills")}</legend>
            <div className="rv2-grid">
              {skills.map((x, n) => (
                <div key={x.skill_id} className="field">
                  <label htmlFor={`rv2-k-${n}`} className="mono">
                    {x.skill_id}
                  </label>
                  <Select<(typeof SKILL_OUTCOMES)[number]>
                    id={`rv2-k-${n}`}
                    label={x.skill_id}
                    value={x.outcome}
                    onChange={(v) => setSkills((xs) => xs.map((y, j) => (j === n ? { ...y, outcome: v } : y)))}
                    options={SKILL_OUTCOMES.map((v) => ({ v, label: t(`skout.${v}`) }))}
                    testId={`rv2-k-${x.skill_id}`}
                  />
                </div>
              ))}
            </div>
          </fieldset>
        )}
        <fieldset className="rv2-set" data-testid="rv2-errors">
          <legend className="h3">{t("rv2.errors", { n: errs.length })}</legend>
          <p className="xs muted">{t("rv2.errorsH")}</p>
          {errs.map((e, n) => {
            const bad2 = tried ? errIssues[n]! : { turn_id: false, evidence: e.evidence.length > 120, correction: e.correction.length > 200, error_code: false };
            const set = (patch: Partial<ErrDraft>) => setErrs((xs) => xs.map((y, j) => (j === n ? { ...y, ...patch } : y)));
            return (
              <div key={n} className="item" data-testid={`rv2-err-${n}`}>
                <div className="item-h">
                  <span className="idx">{n + 1}</span>
                  <span className="grow" />
                  <IconBtn icon="x" className="sm" label={t("rv2.removeErr", { n: n + 1 })} onClick={() => setErrs((xs) => xs.filter((_, j) => j !== n))} testId={`rv2-err-${n}-remove`} />
                </div>
                <div className="rv2-grid">
                  <div className="field">
                    <label htmlFor={`rv2-e-${n}-turn`}>{t("qa.col.turn")}</label>
                    <Select<string> id={`rv2-e-${n}-turn`} label={t("qa.col.turn")} value={e.turn_id} onChange={(v) => set({ turn_id: v })} options={[{ v: "", label: "—" }, ...refs.map((r) => ({ v: r, label: r }))]} className={cx(bad2.turn_id && "is-invalid")} />
                  </div>
                  <div className="field">
                    <label htmlFor={`rv2-e-${n}-code`}>{t("qa.ev.code")}</label>
                    <input id={`rv2-e-${n}-code`} className={cx("input mono", bad2.error_code && "is-invalid")} value={e.error_code} placeholder="missing_be" onChange={(ev) => set({ error_code: ev.target.value })} data-testid={`rv2-e-${n}-code`} />
                  </div>
                  <div className="field">
                    <label htmlFor={`rv2-e-${n}-sev`}>{t("qa.ev.severity")}</label>
                    <Select<ErrDraft["severity"]> id={`rv2-e-${n}-sev`} label={t("qa.ev.severity")} value={e.severity} onChange={(v) => set({ severity: v })} options={SEVERITIES.map((v) => ({ v, label: t(`sev.${v}`) }))} />
                  </div>
                </div>
                <div className="field">
                  <div className="field-top">
                    <label htmlFor={`rv2-e-${n}-ev`}>{t("qa.ev.evidence")}</label>
                    <CharCount id={`rv2-e-${n}-ev-count`} n={e.evidence.length} max={120} />
                  </div>
                  <input id={`rv2-e-${n}-ev`} className={cx("input", bad2.evidence && "is-invalid")} value={e.evidence} onChange={(ev) => set({ evidence: ev.target.value })} aria-describedby={`rv2-e-${n}-ev-count`} data-testid={`rv2-e-${n}-ev`} />
                </div>
                <div className="field">
                  <label htmlFor={`rv2-e-${n}-cor`}>{t("qa.ev.correction")}</label>
                  <input id={`rv2-e-${n}-cor`} className={cx("input", bad2.correction && "is-invalid")} value={e.correction} maxLength={240} onChange={(ev) => set({ correction: ev.target.value })} data-testid={`rv2-e-${n}-cor`} />
                </div>
              </div>
            );
          })}
          {errs.length < 5 && <Btn size="sm" icon="plus" label={t("rv2.addErr")} onClick={() => setErrs((xs) => [...xs, { turn_id: "", evidence: "", correction: "", error_code: "", severity: "medium" }])} testId="rv2-add-err" />}
        </fieldset>
        <div className="field">
          <div className="field-top">
            <label htmlFor="rv2-reason" className="req">
              {t("rv2.reason")}
            </label>
            <CharCount id="rv2-reason-count" n={reason.length} max={500} />
          </div>
          <textarea id="rv2-reason" className={cx("textarea", tried && reasonBad && "is-invalid")} rows={3} value={reason} placeholder={t("rv2.reasonPh")} onChange={(e) => setReason(e.target.value)} aria-describedby="rv2-reason-count" data-testid="rv2-reason" />
          <FieldErr msg={tried && reasonBad ? t("cmd.errReason", { n: 10 }) : null} />
        </div>
        {!changed && <p className="xs muted">{t("rv2.unchanged")}</p>}
        <Callout kind="info" icon="smartphoneKey">
          {t("ct.stepUpNote")}
        </Callout>
        <FieldErr msg={err} />
      </div>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- task for Jira (ADM-QA-04) */

function TaskDrawer({ card, onClose }: { card: SessionCard; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [input, setInput] = useState<TaskInput>({ kind: "bug", title: "", expected: "", actual: "" });
  const md = useMemo(() => taskMarkdown(card, input, (key, vars) => t(key as MessageKey, vars)), [card, input, t]);
  const sid = card.session?.session_id ?? card.evaluations?.[0]?.session_id ?? "session";
  const download = () => {
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = taskFileName(sid);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(t("qt.downloaded", { f: taskFileName(sid) }), "ok");
  };
  return (
    <Drawer
      wide
      title={t("qt.title")}
      sub={<span className="mono">{sid}</span>}
      onClose={onClose}
      testId="qa-task-drawer"
      footer={
        <>
          <Btn label={t("common.close")} onClick={onClose} />
          <span className="grow" />
          <Btn
            icon="copy"
            label={t("qt.copy")}
            onClick={async () => {
              const ok = await copyText(md);
              toast(ok ? t("common.copied") : t("common.copyFailed"), ok ? "ok" : "err");
            }}
            testId="qt-copy"
          />
          <Btn kind="primary" icon="download" label={t("qt.download")} onClick={download} testId="qt-download" />
        </>
      }
    >
      <div className="stack sm">
        <Callout kind="warn" icon="shield" testId="qt-pii">
          {t("qt.pii")}
        </Callout>
        <Seg<TaskInput["kind"]> label={t("qt.kindL")} value={input.kind} onChange={(v) => setInput((x) => ({ ...x, kind: v }))} items={(["bug", "method"] as const).map((v) => ({ v, label: t(`qt.kind.${v}`) }))} testId="qt-kind" />
        <div className="field">
          <label htmlFor="qt-title">{t("qt.titleL")}</label>
          <input id="qt-title" className="input" value={input.title} maxLength={140} placeholder={t("qt.titlePh")} onChange={(e) => setInput((x) => ({ ...x, title: e.target.value }))} data-testid="qt-title" />
        </div>
        <div className="grid2 tight">
          <div className="field">
            <label htmlFor="qt-exp">{t("qt.expected")}</label>
            <textarea id="qt-exp" className="textarea" rows={4} value={input.expected} maxLength={2000} onChange={(e) => setInput((x) => ({ ...x, expected: e.target.value }))} data-testid="qt-expected" />
          </div>
          <div className="field">
            <label htmlFor="qt-act">{t("qt.actual")}</label>
            <textarea id="qt-act" className="textarea" rows={4} value={input.actual} maxLength={2000} onChange={(e) => setInput((x) => ({ ...x, actual: e.target.value }))} data-testid="qt-actual" />
          </div>
        </div>
        <div className="field">
          <span className="field-label" id="qt-pv-l">
            {t("qt.preview")}
          </span>
          <pre className="code qt-pre" aria-labelledby="qt-pv-l" data-testid="qt-md" tabIndex={0}>
            {md}
          </pre>
        </div>
      </div>
    </Drawer>
  );
}


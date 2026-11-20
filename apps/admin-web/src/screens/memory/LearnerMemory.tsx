/**
 * A learner's memory (memory.read; AT-61, ADM-MEM-01): the summary (cards by status, due now, overdue > 7 days, reviews
 * in 30 days), the retention checks d7/d30 with their status and result, the cards (filters status / kind; S, D, R,
 * repetitions, lapses, due) and the card with its whole scheduling history (before → after, algorithm and parameter
 * version, who: the learner / the system / a staff member by name, the reason). Manual actions — memory.manage, one card
 * at a time, a reason ≥ 10 and step-up (admin-bff): reschedule (a date 1..365 days ahead), reset, freeze, unfreeze;
 * every action is a row of the history and an audit record `memory.card_adjusted`. Without memory.manage the buttons
 * are not shown. No quotes of the learner's errors — they are not in the contract.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminCardDetail, AdminCardRow, AdminCardStatus, CardAction, FsrsSnapshot, LearnerMemorySummary, ReviewLogRow } from "@tilhero/contracts/admin";
import { Memory } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Select, Spinner } from "../../ui/kit";
import { ConfirmCommand, Drawer } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { useKeyed } from "../ai/parts";
import { SummaryCard } from "./Summary";
import { actionBody, allowedActions, CARD_ACTIONS, CARD_KINDS, CARD_STATUSES, CARD_TONE, CHECK_TONE, daysUntil, DUE_MAX_DAYS, DUE_MIN_DAYS, GRADE_TONE, isOverdue, localDate, REASON_MAX, REASON_MIN, rescheduleDueAt } from "./model";

export function LearnerMemory({ userId, cardId }: { userId: string; cardId: string | null }) {
  const { t } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const [sum, setSum] = useState<LearnerMemorySummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const load = useCallback(() => {
    Memory.learner(userId)
      .then((s) => {
        setSum(s);
        setError(null);
      })
      .catch(setError);
  }, [userId]);
  useEffect(load, [load, tick]);
  const none = error instanceof ApiError && error.status === 404;
  return (
    <div className="stack" data-testid="mem-learner" data-user={userId}>
      <div className="row">
        <Btn size="sm" kind="ghost" icon="chevL" label={t("mem.otherLearner")} onClick={() => navigate("memory", "learners")} testId="mem-back" />
        <span className="mono small muted" title={userId}>
          {shortId(userId, 8, 4)}
        </span>
        <span className="grow" />
        {can("users.read") && <Btn size="sm" icon="users" label={t("mem.toCard")} onClick={() => navigate("users", userId)} testId="mem-to-card" />}
      </div>
      {error && !sum ? (
        none ? (
          <Empty icon="layers" title={t("mem.noMemory")} text={t("mem.noMemoryM")} testId="mem-none" />
        ) : (
          <LoadError error={error} onRetry={load} />
        )
      ) : !sum ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <>
          <SummaryCard s={sum} />
          <ChecksPanel s={sum} />
          <CardsPanel userId={userId} selected={cardId} tick={tick} onOpen={(id) => navigate("memory", `learners/${userId}/${id}`)} />
        </>
      )}
      {cardId && !none && (
        <CardDrawer
          key={cardId}
          id={cardId}
          onClose={() => navigate("memory", `learners/${userId}`)}
          onChanged={() => setTick((n) => n + 1)}
        />
      )}
      <p className="xs muted row">
        <Icon name="shield" /> {t("mem.piiNote")}
      </p>
    </div>
  );
}

function ChecksPanel({ s }: { s: LearnerMemorySummary }) {
  const { t, fmt } = useI18n();
  return (
    <section className="panel" aria-labelledby="mem-ch-h" data-testid="mem-checks">
      <div className="panel-h">
        <h2 className="panel-t grow" id="mem-ch-h">
          <Icon name="clipboardCheck" /> {t("mem.checks", { n: s.checks.length })}
        </h2>
        <span className="xs muted">{t("mem.checksNote")}</span>
      </div>
      {s.checks.length ? (
        <div className="table-wrap">
          <table className="tbl compact">
            <caption className="sr-only">{t("mem.checks", { n: s.checks.length })}</caption>
            <thead>
              <tr>
                <th scope="col">{t("mem.col.skill")}</th>
                <th scope="col">{t("mem.col.stage")}</th>
                <th scope="col">{t("col.status")}</th>
                <th scope="col">{t("mem.col.due")}</th>
                <th scope="col">{t("mem.col.checked")}</th>
                <th scope="col" className="r">
                  {t("mem.col.result")}
                </th>
              </tr>
            </thead>
            <tbody>
              {s.checks.map((c) => (
                <tr key={c.check_id} data-testid={`mem-check-${c.check_id}`}>
                  <td>
                    <span lang="ru">{c.skill_title?.ru ?? c.skill_id}</span>
                    <span className="mono xs muted block">{c.skill_id}</span>
                  </td>
                  <td>
                    <span className="tag">{t(`chstage.${c.stage}` as MessageKey)}</span>
                  </td>
                  <td>
                    <Pill tone={CHECK_TONE[c.status]}>{t(`chst.${c.status}` as MessageKey)}</Pill>
                    {c.consecutive_failures > 0 && <span className="xs warn-ink block">{t("mem.failuresN", { n: c.consecutive_failures })}</span>}
                  </td>
                  <td className="small nowrap">{fmt.dateTime(c.due_at)}</td>
                  <td className="small nowrap">{c.checked_at ? fmt.dateTime(c.checked_at) : "—"}</td>
                  <td className="r num">{c.result ? t("mem.resultN", { c: c.result.correct, n: c.result.total }) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="clipboardCheck" title={t("mem.noChecks")} text={t("mem.noChecksM")} />
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- cards */

export function fsrsText(fmt: { num(n: number, d?: number): string }, s: number | null, d: number | null): { s: string; d: string } {
  return { s: s == null ? "—" : fmt.num(s, s < 10 ? 2 : 1), d: d == null ? "—" : fmt.num(d, 2) };
}

function CardsPanel({ userId, selected, tick, onOpen }: { userId: string; selected: string | null; tick: number; onOpen: (id: string) => void }) {
  const { t, fmt } = useI18n();
  const [status, setStatus] = useState<AdminCardStatus | "">("");
  const [kind, setKind] = useState<AdminCardRow["kind"] | "">("");
  const [rows, setRows] = useState<AdminCardRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const req = useRef(0);
  const load = useCallback(
    async (more?: string | null) => {
      const id = ++req.current;
      try {
        const r = await Memory.cards(userId, { status, kind, cursor: more ?? null });
        if (id !== req.current) return;
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        if (id === req.current) setError(e);
      }
    },
    [userId, status, kind],
  );
  useEffect(() => {
    void load();
  }, [load, tick]);
  const now = Date.now();
  return (
    <section className="panel" aria-labelledby="mem-cards-h" data-testid="mem-cards">
      <div className="panel-h">
        <h2 className="panel-t grow" id="mem-cards-h">
          <Icon name="layers" /> {t("mem.cardsList")}
        </h2>
        <Select<AdminCardStatus | ""> id="mem-f-status" label={t("col.status")} value={status} onChange={setStatus} testId="mem-f-status" options={[{ v: "", label: t("mem.allStatuses") }, ...CARD_STATUSES.map((s) => ({ v: s, label: t(`cst.${s}` as MessageKey) }))]} />
        <Select<AdminCardRow["kind"] | ""> id="mem-f-kind" label={t("mem.kind")} value={kind} onChange={setKind} testId="mem-f-kind" options={[{ v: "", label: t("mem.allKinds") }, ...CARD_KINDS.map((s) => ({ v: s, label: t(`ckind.${s}` as MessageKey) }))]} />
      </div>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="tbl mem-tbl" data-testid="mem-card-rows">
            <caption className="sr-only">{t("mem.cardsList")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("mem.col.card")}</th>
                <th scope="col">{t("col.status")}</th>
                <th scope="col" className="r" title={t("mem.sHint")}>
                  {t("mem.col.s")}
                </th>
                <th scope="col" className="r" title={t("mem.dHint")}>
                  {t("mem.col.d")}
                </th>
                <th scope="col" className="r" title={t("mem.rHint")}>
                  {t("mem.col.r")}
                </th>
                <th scope="col" className="r">
                  {t("mem.col.reps")}
                </th>
                <th scope="col" className="r">
                  {t("mem.col.lapses")}
                </th>
                <th scope="col">{t("mem.col.due")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const f = fsrsText(fmt, c.stability, c.difficulty);
                const over = isOverdue(c, now);
                return (
                  <tr key={c.card_id} className={cx(selected === c.card_id && "is-sel")} data-testid={`mem-card-${c.card_id}`}>
                    <td>
                      <button type="button" className="tr" lang="en" onClick={() => onOpen(c.card_id)} data-testid={`mem-open-${c.card_id}`}>
                        {c.text_en}
                      </button>
                      <span className="xs muted block">
                        {t(`ckind.${c.kind}` as MessageKey)} · <span lang="ru">{c.gloss.ru}</span>
                        {c.error_code && (
                          <>
                            {" · "}
                            <span className="mono">{c.error_code}</span>
                          </>
                        )}
                      </span>
                    </td>
                    <td>
                      <Pill tone={CARD_TONE[c.status]}>{t(`cst.${c.status}` as MessageKey)}</Pill>
                    </td>
                    <td className="r num">{f.s}</td>
                    <td className="r num">{f.d}</td>
                    <td className="r num">{c.retrievability == null ? "—" : fmt.pct(c.retrievability * 100, 0)}</td>
                    <td className="r num">{fmt.num(c.reps)}</td>
                    <td className="r num">{fmt.num(c.lapses)}</td>
                    <td className="small nowrap">
                      {c.due_at ? fmt.dateTime(c.due_at) : "—"}
                      {over && (
                        <span className="xs bad-ink b block">
                          <Icon name="clock" /> {t("mem.overdueTag")}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="inbox" title={t("mem.noCards")} text={status || kind ? t("common.changeFilters") : t("mem.noCardsM")} testId="mem-cards-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="mem-cards-more" />
        </div>
      )}
      <div className="panel-f xs">
        <Icon name="info" /> {t("mem.fsrsNote")}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- card with the scheduling history */

function Snapshot({ s }: { s: FsrsSnapshot }) {
  const { t, fmt } = useI18n();
  const f = fsrsText(fmt, s.stability, s.difficulty);
  return (
    <span className="mem-snap">
      <Pill tone={CARD_TONE[s.status]} dot={false}>
        {t(`cst.${s.status}` as MessageKey)}
      </Pill>
      <span className="xs muted">{t(`fsrs.${s.state}` as MessageKey)}</span>
      <span className="xs">
        S {f.s} · D {f.d}
      </span>
      <span className="xs muted">{s.due_at ? fmt.dateTime(s.due_at) : "—"}</span>
    </span>
  );
}

function Actor({ r }: { r: ReviewLogRow }) {
  const { t } = useI18n();
  return (
    <span>
      <span className="tag plain">{t(`actor.${r.actor}` as MessageKey)}</span>
      {r.actor === "staff" && <span className="block small">{r.actor_name ?? t("mem.staffUnknown")}</span>}
    </span>
  );
}

function CardDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const toast = useToast();
  const k = useKeyed();
  const [c, setC] = useState<AdminCardDetail | null>(null);
  const [log, setLog] = useState<ReviewLogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [moreErr, setMoreErr] = useState<string | null>(null);
  const [ask, setAsk] = useState<CardAction["action"] | null>(null);
  const [due, setDue] = useState("");
  const actKey = useRef(uuid());
  const apply = (d: AdminCardDetail) => {
    setC(d);
    setLog(d.log.items);
    setCursor(d.log.next_cursor);
  };
  const load = useCallback(async () => {
    try {
      apply(await Memory.card(id));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const more = async () => {
    if (!cursor) return;
    try {
      const p = await Memory.log(id, cursor);
      setLog((xs) => [...xs, ...p.items]);
      setCursor(p.next_cursor);
      setMoreErr(null);
    } catch (e) {
      setMoreErr(errText(i18n, e));
    }
  };
  const manage = can("memory.manage");
  const allowed = c ? allowedActions(c.status) : null;
  const now = Date.now();
  const minDate = localDate(now + DUE_MIN_DAYS * 86_400_000);
  const maxDate = localDate(now + DUE_MAX_DAYS * 86_400_000);
  const dueAt = ask === "reschedule" ? rescheduleDueAt(due, now) : null;
  const n = daysUntil(due, now);
  const f = c ? fsrsText(fmt, c.stability, c.difficulty) : null;
  return (
    <Drawer
      wide
      testId="mem-card"
      onClose={onClose}
      title={c ? <span lang="en">{c.text_en}</span> : t("mem.card")}
      sub={
        c && (
          <>
            <Pill tone={CARD_TONE[c.status]}>{t(`cst.${c.status}` as MessageKey)}</Pill>
            <span className="tag plain">{t(`ckind.${c.kind}` as MessageKey)}</span>
            <span lang="ru">{c.gloss.ru}</span>
            <span className="muted" lang="uz-Latn">
              {c.gloss.uz}
            </span>
          </>
        )
      }
    >
      {error && !c ? (
        <LoadError error={error} onRetry={() => void load()} />
      ) : !c || !f ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack" data-testid="mem-card-body" data-status={c.status}>
          {manage && allowed ? (
            <div className="acts" data-testid="mem-actions">
              {CARD_ACTIONS.filter((a) => allowed[a]).map((a) => (
                <Btn key={a} kind={a === "reschedule" ? "primary" : a === "reset" ? "danger-ghost" : ""} icon={a === "reschedule" ? "calendar" : a === "reset" ? "rollback" : a === "freeze" ? "pause" : "play"} label={t(`mact.${a}` as MessageKey)} onClick={() => (setDue(""), setAsk(a))} testId={`mem-act-${a}`} />
              ))}
              <span className="xs muted row">
                <Icon name="smartphoneKey" /> {t("mem.actNote")}
              </span>
            </div>
          ) : (
            <p className="xs muted row" data-testid="mem-ro">
              <Icon name="lock" /> {t("mem.ro", { p: "memory.manage" })}
            </p>
          )}
          <dl className="dl" data-testid="mem-card-meta">
            <dt>{t("mem.col.s")}</dt>
            <dd>{t("mem.sDays", { s: f.s })}</dd>
            <dt>{t("mem.col.d")}</dt>
            <dd>{f.d}</dd>
            <dt>{t("mem.col.r")}</dt>
            <dd>{c.retrievability == null ? "—" : fmt.pct(c.retrievability * 100, 0)}</dd>
            <dt>{t("mem.col.reps")}</dt>
            <dd>
              {fmt.num(c.reps)} · {t("mem.col.lapses")}: {fmt.num(c.lapses)}
            </dd>
            <dt>{t("mem.col.due")}</dt>
            <dd data-testid="mem-card-due">
              {c.due_at ? fmt.dateTime(c.due_at) : "—"}
              {isOverdue(c, now) && <span className="bad-ink b"> · {t("mem.overdueTag")}</span>}
            </dd>
            <dt>{t("mem.lastReviewL")}</dt>
            <dd>{c.last_review_at ? fmt.dateTime(c.last_review_at) : "—"}</dd>
            {c.example_en && (
              <>
                <dt>{t("mem.example")}</dt>
                <dd lang="en">{c.example_en}</dd>
              </>
            )}
            {c.error_code && (
              <>
                <dt>{t("mem.errorCode")}</dt>
                <dd>
                  <span className="mono">{c.error_code}</span>
                  <span className="xs muted block">{t("mem.noQuote")}</span>
                </dd>
              </>
            )}
            <dt>{t("mem.sources")}</dt>
            <dd>
              <ul className="plain-list">
                {c.sources.map((s, j) => (
                  <li key={j} className="small">
                    {k("msrc", s.kind)}
                    {s.key && <span className="mono xs"> · {s.key}</span>}
                    {s.version != null && <span className="mono xs"> v{s.version}</span>}
                    <span className="xs muted"> · {fmt.dateTime(s.at)}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </dl>
          <section aria-labelledby="mem-log-h" data-testid="mem-log">
            <h3 className="h3" id="mem-log-h">
              {t("mem.log")}
            </h3>
            <p className="xs muted">{t("mem.logNote")}</p>
            {log.length ? (
              <div className="table-wrap">
                <table className="tbl compact mem-log">
                  <caption className="sr-only">{t("mem.log")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("mem.col.when")}</th>
                      <th scope="col">{t("mem.col.who")}</th>
                      <th scope="col">{t("mem.col.answer")}</th>
                      <th scope="col">{t("mem.col.before")}</th>
                      <th scope="col">{t("mem.col.after")}</th>
                      <th scope="col">{t("mem.col.algo")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {log.map((r) => (
                      <tr key={r.log_id} data-testid={`mem-log-${r.log_id}`} data-actor={r.actor}>
                        <td className="small nowrap">
                          {fmt.dateTime(r.at)}
                          {r.elapsed_days != null && <span className="xs muted block">{t("mem.elapsed", { n: fmt.num(r.elapsed_days, 1) })}</span>}
                        </td>
                        <td className="small">
                          <Actor r={r} />
                        </td>
                        <td className="small">
                          <span className="mono xs">{r.task_type}</span>
                          <span className="xs muted block">{t(`amode.${r.answer_mode}` as MessageKey)}</span>
                          {r.grade ? <Pill tone={GRADE_TONE[r.grade]}>{t(`grade.${r.grade}` as MessageKey)}</Pill> : <span className="xs muted">{t("mem.noGrade")}</span>}
                          {r.hinted && <span className="xs warn-ink block">{t("mem.hinted")}</span>}
                          {r.revealed && <span className="xs warn-ink block">{t("mem.revealed")}</span>}
                          {r.reason && <span className="xs block wrap-any">{t("mem.reasonX", { r: r.reason })}</span>}
                        </td>
                        <td>
                          <Snapshot s={r.before} />
                        </td>
                        <td>
                          <Snapshot s={r.after} />
                        </td>
                        <td className="mono xs">
                          {r.algorithm}
                          <span className="block muted">{r.params_version}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="small muted">{t("mem.noLog")}</p>
            )}
            {cursor && (
              <div className="more-row">
                <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void more()} testId="mem-log-more" />
              </div>
            )}
            <FieldErr msg={moreErr} />
          </section>
        </div>
      )}
      {ask && c && (
        <ConfirmCommand
          title={t(`mact.${ask}.t` as MessageKey, { w: c.text_en })}
          text={t(`mact.${ask}.m` as MessageKey)}
          icon={ask === "reschedule" ? "calendar" : ask === "reset" ? "rollback" : ask === "freeze" ? "pause" : "play"}
          tone={ask === "reset" ? "bad" : "warn"}
          ok={t(`mact.${ask}` as MessageKey)}
          okKind={ask === "reset" ? "danger" : "primary"}
          okDisabled={ask === "reschedule" && !dueAt}
          minReason={REASON_MIN}
          reasonPlaceholder={t("mem.reasonPh")}
          testId="mem-act-dialog"
          extra={
            <>
              {ask === "reschedule" && (
                <div className="field">
                  <label htmlFor="mem-due" className="req">
                    {t("mem.newDue")}
                  </label>
                  <input id="mem-due" type="date" className={cx("input", due && !dueAt && "is-invalid")} min={minDate} max={maxDate} value={due} aria-invalid={(!!due && !dueAt) || undefined} aria-describedby="mem-due-h" onChange={(e) => setDue(e.target.value)} data-testid="mem-due" />
                  <span className="hint" id="mem-due-h">
                    {due && dueAt ? t("mem.dueIn", { n, t: fmt.dateTime(dueAt) }) : t("mem.dueRange", { a: DUE_MIN_DAYS, b: DUE_MAX_DAYS })}
                  </span>
                  <FieldErr msg={due && !dueAt ? t("err.DUE_AT_RANGE") : null} />
                </div>
              )}
              <Callout kind="info" icon="smartphoneKey">
                {t("mem.stepUpNote")}
              </Callout>
            </>
          }
          onClose={() => setAsk(null)}
          onConfirm={async (reason) => {
            if (reason.length > REASON_MAX) return t("mem.reasonMax", { n: REASON_MAX });
            const body = actionBody(ask, reason, dueAt);
            if (!body) return ask === "reschedule" ? t("err.DUE_AT_RANGE") : t("cmd.errReason", { n: REASON_MIN });
            try {
              const d = await Memory.act(c.card_id, body, actKey.current);
              actKey.current = uuid();
              apply(d);
              onChanged();
              toast(t(`mact.${ask}.done` as MessageKey), "ok", "memory.card_adjusted");
              return null;
            } catch (e) {
              if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
              actKey.current = uuid();
              return errText(i18n, e);
            }
          }}
        />
      )}
    </Drawer>
  );
}

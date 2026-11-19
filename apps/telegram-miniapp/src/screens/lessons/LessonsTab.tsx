import type { LessonHistoryItem, LessonSession } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../../api/errors";
import { completedMark, isOpen, planLists } from "../../domain/lessons";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Margin, NavRow, NoBreakHyphens, Pill, Skeleton } from "../../ui/kit";
import { ReasonPills, Stages } from "../plan/PlanScreen";

/**
 * The «Уроки» tab (APP-LESS, APP-PROG-03 partly): an unfinished session («Продолжить урок»), the next lesson of the plan,
 * mandatory and optional lessons, the lessons passed («зачтено / повторить»), the history of sessions (lessons, scenarios,
 * media, reviews) with their summaries; links to «Мой план» and «Практика».
 */
export function LessonsTab() {
  const { bff, nav, session, plan } = useApp();
  const { t, l, fmt } = useI18n();
  const me = session.learner.learner_id;
  const active = useLoad(() => bff.activeSession(true), [me]);
  const tr = useLoad(() => bff.trajectory(true), [me, plan?.version]);
  const d = tr.data;
  const lists = d ? planLists(d) : null;

  return (
    <main className="scroll" data-testid="lessons-tab">
      <div className="stack loose">
        <ActiveCard session={active.data?.session ?? null} />

        {tr.loading && !d ? (
          <div className="pad"><Skeleton lines={3} /></div>
        ) : tr.error && !d ? (
          <div className="pad">
            <div className="card warn stack tight">
              <p className="sub ink">{t("ls.planError")}</p>
              <Btn variant="secondary" onClick={() => void tr.reload()}>{t("c.retry")}</Btn>
            </div>
          </div>
        ) : d ? (
          <>
            {!d.lessons_available ? (
              <div className="pad"><div className="card warn" data-testid="ls-unavailable"><p className="sub ink">{t("ls.unavailable")}</p></div></div>
            ) : null}
            {d.next ? (
              <Margin note={t("home.next.note")} tilt>
                <section className="card lift stack tight" aria-labelledby="ls-next" data-testid="ls-next">
                  <div className="cap" id="ls-next">{t("ls.next.cap", { level: d.next.level, n: d.next.duration_min })}</div>
                  <h2 className="h2"><NoBreakHyphens text={l(d.next.title)} /></h2>
                  <p className="sub">{l(d.next.explanation)}</p>
                  <ReasonPills codes={d.next.reason_codes} />
                  <Stages card={d.next} />
                  <Btn disabled={!d.lessons_available} onClick={() => nav.push({ name: "lessonCard", id: d.next!.lesson_id })} data-testid="ls-next-open">
                    <Icon name="lessons" size={18} />
                    {t("ls.next.open")}
                  </Btn>
                </section>
              </Margin>
            ) : (
              <div className="pad"><p className="sub" data-testid="ls-next-none">{t("ls.next.none")}</p></div>
            )}

            {lists!.mandatory.length ? (
              <section className="pad stack tight" aria-labelledby="ls-mand" data-testid="ls-mandatory">
                <h2 className="sec" id="ls-mand">{t("ls.mandatory")}</h2>
                <div className="list">
                  {lists!.mandatory.map((c) => (
                    <NavRow
                      key={c.lesson_id}
                      title={l(c.title)}
                      note={`${t("plan.meta", { level: c.level, n: c.duration_min })}${c.reason_codes.includes("repeat") ? ` · ${t("plan.reason.repeat")}` : ""}`}
                      onClick={() => nav.push({ name: "lessonCard", id: c.lesson_id })}
                      testId={`ls-lesson-${c.lesson_id}`}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            {lists!.optional.length ? (
              <section className="pad stack tight" aria-labelledby="ls-opt" data-testid="ls-optional">
                <h2 className="sec" id="ls-opt">{t("ls.optional")}</h2>
                <div className="list">
                  {lists!.optional.map((c) => (
                    <NavRow key={c.lesson_id} title={l(c.title)} note={t("plan.meta", { level: c.level, n: c.duration_min })} onClick={() => nav.push({ name: "lessonCard", id: c.lesson_id })} testId={`ls-lesson-${c.lesson_id}`} />
                  ))}
                </div>
              </section>
            ) : null}
            {d.completed.length ? (
              <section className="pad stack tight" aria-labelledby="ls-done" data-testid="ls-completed">
                <h2 className="sec" id="ls-done">{t("ls.completed")}</h2>
                <div className="list">
                  {d.completed.map((c) => {
                    const mark = completedMark(c);
                    return (
                      <button type="button" key={c.lesson_id} className="row ls-row" onClick={() => nav.push({ name: "lessonCard", id: c.lesson_id })} data-testid={`ls-done-${c.lesson_id}`}>
                        <span className="t">
                          <b>{l(c.title)}</b>
                          <span>{fmt.date(c.completed_at)} · {t("plan.meta", { level: c.level, n: c.duration_min })}</span>
                        </span>
                        <span className={mark === "passed" ? "v ok" : mark === "again" ? "v again" : "v"}>
                          {mark === "passed" ? <Icon name="check" size={14} stroke={3} /> : mark === "again" ? <span aria-hidden="true">↺</span> : null}
                          {t(mark === "passed" ? "ls.passed" : mark === "again" ? "ls.again" : "ls.later")}
                        </span>
                        <Icon name="chevron" size={18} stroke={2} />
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </>
        ) : null}

        <History />

        <div className="pad">
          <div className="list">
            <NavRow title={t("ls.plan")} icon="route" onClick={() => nav.push({ name: "plan" })} testId="ls-plan" />
            <NavRow title={t("ls.practice")} icon="chat" onClick={() => nav.push({ name: "practice" })} testId="ls-practice" />
          </div>
        </div>
      </div>
    </main>
  );
}

/** «Продолжить урок»: an unfinished session of the learner (ready / in progress / paused up to 72 h). */
export function ActiveCard({ session, compact }: { session: LessonSession | null; compact?: boolean }) {
  const { nav } = useApp();
  const { t, l, fmt } = useI18n();
  if (!session || !isOpen(session)) return null;
  const stage = session.stage ? t(`st.${session.stage}` as MessageKey) : null;
  return (
    <Margin>
      <section className="card lift ls-active" aria-labelledby="ls-active-cap" data-testid="active-card">
        <div className="cap" id="ls-active-cap">{t("ls.active.cap")} · {t(`ls.kind.${session.kind}` as MessageKey)}</div>
        <h2 className={compact ? "h3" : "h2"}><NoBreakHyphens text={l(session.title)} /></h2>
        <p className="sub">
          {session.status === "paused" && session.expires_at ? t("ls.active.paused", { date: fmt.dateTime(session.expires_at).replace(" ", "\u00A0") }) : stage ? t("ls.active.going", { stage }) : ""}
        </p>
        <Btn onClick={() => nav.push({ name: "player", sessionId: session.session_id })} data-testid="active-continue">
          <Icon name="play" size={18} />
          {t("ls.continue")}
        </Btn>
      </section>
    </Margin>
  );
}

function History() {
  const { bff, nav, session } = useApp();
  const { t, l, fmt } = useI18n();
  const [items, setItems] = useState<LessonHistoryItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(
    async (cursor: string | null) => {
      const my = ++seq.current;
      setBusy(true);
      setError(null);
      try {
        const p = await bff.sessions(null, cursor);
        if (my !== seq.current) return;
        setItems((prev) => (cursor && prev ? [...prev, ...p.items] : p.items));
        setNext(p.next_cursor);
      } catch (e) {
        if (my === seq.current) setError(errorText(e, t, fmt.mmss));
      } finally {
        if (my === seq.current) setBusy(false);
      }
    },
    [bff, t, fmt],
  );
  useEffect(() => {
    void load(null);
  }, [load, session.learner.learner_id]);

  const openItem = (h: LessonHistoryItem) => {
    if (isOpen(h)) nav.push({ name: "player", sessionId: h.session_id });
    else if (h.status === "completed") nav.push({ name: "lessonSummary", sessionId: h.session_id });
  };

  return (
    <section className="pad stack tight" aria-labelledby="ls-hist" data-testid="ls-history">
      <h2 className="sec" id="ls-hist">{t("ls.history")}</h2>
      {items === null && busy ? (
        <Skeleton lines={2} />
      ) : items && items.length ? (
        <div className="list">
          {items.map((h) => {
            const when = h.finished_at ?? h.started_at;
            const tappable = isOpen(h) || h.status === "completed";
            const content = (
              <>
                <span className="t">
                  <b>{l(h.title)}</b>
                  <span>
                    {t(`ls.kind.${h.kind}` as MessageKey)}
                    {when ? ` · ${fmt.date(when)}` : ""}
                    {h.minutes ? ` · ${t("c.minutesN", { n: h.minutes })}` : ""}
                  </span>
                  <span className="pills">
                    <Pill tone={h.status === "completed" ? "mute" : h.status === "cancelled" || h.status === "failed" ? "mute" : undefined}>{t(`ls.status.${h.status}` as MessageKey)}</Pill>
                    {h.outcome ? <Pill tone={h.outcome === "fail" ? "warn" : "ok"}>{t(`ls.outcome.${h.outcome}` as MessageKey)}</Pill> : null}
                    {h.passed === true ? <Pill tone="ok">{t("ls.passed")}</Pill> : h.passed === false ? <Pill tone="mute">{t("ls.again")}</Pill> : null}
                  </span>
                </span>
                {tappable ? <Icon name="chevron" size={18} stroke={2} /> : null}
              </>
            );
            return tappable ? (
              <button type="button" className="row" key={h.session_id} onClick={() => openItem(h)} data-testid={`ls-h-${h.session_id}`}>
                {content}
              </button>
            ) : (
              <div className="row" key={h.session_id} data-testid={`ls-h-${h.session_id}`}>
                {content}
              </div>
            );
          })}
        </div>
      ) : items ? (
        <p className="sub" data-testid="ls-history-empty">{t("ls.historyEmpty")}</p>
      ) : null}
      <ErrorLine text={error} />
      {error && !items ? <Btn variant="secondary" onClick={() => void load(null)}>{t("c.retry")}</Btn> : null}
      {next ? <Btn variant="secondary" busy={busy} onClick={() => void load(next)}>{t("c.more")}</Btn> : null}
    </section>
  );
}

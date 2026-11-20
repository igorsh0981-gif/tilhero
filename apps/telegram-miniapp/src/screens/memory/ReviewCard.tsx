import type { MemoryOverview } from "@tilhero/contracts/bff";
import { reviewCardState, reviewMinutes } from "../../domain/memory";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { Icon } from "../../ui/Icon";
import { Btn, Margin, Pill, Skeleton } from "../../ui/kit";

/**
 * «Повторение дня» (APP-MEM-03/04, AT-54) on Home and on top of «Словарь»: how many cards are due and new, the checks of
 * retention, «Начать» / «Продолжить»; done today — a calm line with the next date; nothing — the nearest date. A failure
 * of memory only hides the card (the lesson of the day stays the main action). Children: no counters of «должен».
 */
export function ReviewCard({ overview, loading, testId = "review-card" }: { overview: MemoryOverview | null; loading: boolean; testId?: string }) {
  const { nav, session } = useApp();
  const { t, tp, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  if (!overview) return loading ? <div className="pad"><Skeleton lines={2} /></div> : null;
  const st = reviewCardState(overview);
  const open = () => nav.push({ name: "review", autostart: true });

  if (st.kind === "done" || st.kind === "empty") {
    const next = st.nextDueAt ? fmt.date(st.nextDueAt) : null;
    return (
      <Margin note={st.kind === "done" ? "✓" : undefined} tone="g">
        <section className="card stack tight rv-card" aria-labelledby={`${testId}-cap`} data-testid={testId} data-state={st.kind}>
          <div className="cap" id={`${testId}-cap`}>{t("mem.card.cap")}</div>
          <p className="h3" data-testid={`${testId}-line`}>
            {st.kind === "done" ? (kid ? t("mem.card.doneKid") : t("mem.card.done")) : st.total ? t("mem.card.nothing") : t("mem.card.noCards")}
          </p>
          {next ? <p className="sub small" data-testid={`${testId}-next`}>{t("mem.card.nextAt", { date: next })}</p> : null}
        </section>
      </Margin>
    );
  }

  const cards = st.due + st.fresh;
  const minutes = reviewMinutes(cards + st.checks * 3);
  return (
    <Margin note={st.kind === "continue" ? "…" : String(cards + st.checks)} tone="b" tilt>
      <section className="card lift stack tight rv-card" aria-labelledby={`${testId}-cap`} data-testid={testId} data-state={st.kind}>
        <div className="cap" id={`${testId}-cap`}>
          {t("mem.card.cap")}
          {minutes ? ` · ${t("mem.card.minutes", { n: minutes })}` : ""}
        </div>
        <p className="h2" data-testid={`${testId}-line`}>
          {st.kind === "continue" ? t("mem.card.continueLine") : kid ? t("mem.card.lineKid") : t("mem.card.line")}
        </p>
        <div className="pills" data-testid={`${testId}-counts`}>
          {st.due ? <Pill>{t("mem.card.due", { n: st.due, w: tp("mem.wordsWord", st.due) })}</Pill> : null}
          {st.fresh ? <Pill tone="mute">{t("mem.card.new", { n: st.fresh })}</Pill> : null}
          {st.checks ? (
            <Pill tone="warn">
              <Icon name="shield" size={14} />
              {t("mem.card.checks", { n: st.checks })}
            </Pill>
          ) : null}
          {st.kind === "start" && st.doneToday ? <Pill tone="ok"><Icon name="check" size={14} stroke={3} />{t("mem.card.doneTodayPill")}</Pill> : null}
        </div>
        <Btn onClick={open} data-testid={`${testId}-go`}>
          <Icon name={st.kind === "continue" ? "play" : "review"} size={18} />
          {st.kind === "continue" ? t("mem.card.continue") : t("mem.card.start")}
        </Btn>
      </section>
    </Margin>
  );
}

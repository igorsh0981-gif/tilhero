/** Summary of a learner's memory (memory.read): shared by «Память» and the learner card of «Ученики» (kept small — the
 *  learners screen is in the main chunk). */
import type { LearnerMemorySummary } from "@tilhero/contracts/admin";
import { useI18n, type MessageKey } from "../../i18n";
import { cx, Pill } from "../../ui/kit";
import { CARD_STATUSES, CARD_TONE } from "./model";

export function SummaryCard({ s, compact }: { s: LearnerMemorySummary; compact?: boolean }) {
  const { t, fmt } = useI18n();
  const total = CARD_STATUSES.reduce((a, k) => a + (s.cards_by_status[k] ?? 0), 0);
  return (
    <section className={cx("card stack sm", compact && "is-compact")} aria-labelledby="mem-sum-h" data-testid="mem-summary">
      <h2 className="h2" id="mem-sum-h">
        {t("mem.summary")}
      </h2>
      <div className="kpis mem-kpis">
        <div className="kpi">
          <div className="kpi-l">{t("mem.cards")}</div>
          <div className="kpi-v" data-testid="mem-total">
            {fmt.num(total)}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-l">{t("mem.dueNow")}</div>
          <div className="kpi-v" data-testid="mem-due">
            {fmt.num(s.due_now)}
          </div>
        </div>
        <div className={cx("kpi", s.overdue_7d > 0 && "is-bad")}>
          <div className="kpi-l">{t("mem.overdue")}</div>
          <div className={cx("kpi-v", s.overdue_7d > 0 && "bad-ink")} data-testid="mem-overdue">
            {fmt.num(s.overdue_7d)}
          </div>
          <div className="kpi-n">{t("mem.overdueN")}</div>
        </div>
        <div className="kpi">
          <div className="kpi-l">{t("mem.reviews30")}</div>
          <div className="kpi-v" data-testid="mem-reviews">
            {fmt.num(s.reviews_30d)}
          </div>
          <div className="kpi-n">{s.last_review_at ? t("mem.lastReview", { t: fmt.dateTime(s.last_review_at) }) : t("mem.noReviews")}</div>
        </div>
      </div>
      <ul className="mem-statuses" aria-label={t("mem.byStatus")} data-testid="mem-by-status">
        {CARD_STATUSES.map((k) => (
          <li key={k} data-testid={`mem-st-${k}`}>
            <Pill tone={CARD_TONE[k]}>{t(`cst.${k}` as MessageKey)}</Pill>
            <b className="num">{fmt.num(s.cards_by_status[k] ?? 0)}</b>
          </li>
        ))}
      </ul>
      {s.pair_id && <span className="xs muted mono">{s.pair_id}</span>}
    </section>
  );
}


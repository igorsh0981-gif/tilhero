import type { ReactNode } from "react";
import type { AiAgentState, AiPause, SkillStatus } from "@tilhero/contracts/admin";
import { useI18n } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { shortId } from "../../lib/ids";
import { cx, Pill } from "../../ui/kit";
import { meterWidth, msParts, pctTone, STATE_TONE, STATUS_TONE } from "./ai";

/** thin budget meter with the 70 / 90 % ticks and the percentage next to it */
export function BudgetMeter({ pct, testId, compact }: { pct: number | null; testId?: string; compact?: boolean }) {
  const { fmt, t } = useI18n();
  const tone = pctTone(pct);
  return (
    <span className={cx("ai-meter", `is-${tone}`, compact && "is-compact")} data-testid={testId} data-tone={tone}>
      <span className="ai-meter-bar" aria-hidden="true">
        <i style={{ width: `${meterWidth(pct)}%` }} />
        <b className="tick t70" />
        <b className="tick t90" />
      </span>
      <span className="ai-meter-v">{pct == null ? t("ai.noLimit") : fmt.pct(pct, 0)}</span>
    </span>
  );
}

export function StatePill({ state, testId }: { state: AiAgentState; testId?: string }) {
  const { t } = useI18n();
  return (
    <Pill tone={STATE_TONE[state]} testId={testId}>
      {t(`ai.state.${state}`)}
    </Pill>
  );
}

export function StatusPill({ status, testId }: { status: SkillStatus; testId?: string }) {
  return (
    <Pill tone={STATUS_TONE[status]} mono testId={testId}>
      {status}
    </Pill>
  );
}

/** «6,2 с» / «820 мс» */
export function Ms({ ms }: { ms: number | null | undefined }) {
  const { t, fmt } = useI18n();
  const p = msParts(ms);
  if (!p) return <>—</>;
  return <>{p.unit === "ms" ? t("ai.ms", { n: fmt.num(p.v) }) : t("ai.sec", { n: fmt.num(p.v, 1) })}</>;
}

/** who stopped / changed: staff name, «system» or a short id */
export function Who({ id, name }: { id: string | null | undefined; name: string | null | undefined }) {
  const { t } = useI18n();
  if (name) return <>{name}</>;
  if (!id) return <>—</>;
  if (id === "system") return <>{t("ai.system")}</>;
  return <span className="mono">{shortId(id, 8, 4)}</span>;
}

/** «Остановлен · причина · кто · когда» */
export function PauseNote({ p }: { p: AiPause }) {
  const { t, fmt } = useI18n();
  return (
    <span className="xs ai-pause-note" data-testid="pause-note">
      {p.reason ? `«${p.reason}»` : t("ai.noReason")} · <Who id={p.by} name={p.by_name} /> · <span title={fmt.dateTime(p.at)}>{fmt.rel(p.at)}</span>
    </span>
  );
}

export function Kpi({ label, value, sub, tone, testId, title }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "bad" | "warn"; testId?: string; title?: string }) {
  const { t } = useI18n();
  return (
    <div className={cx("stat", tone === "bad" && "is-bad", tone === "warn" && "is-warn")} data-testid={testId} title={title}>
      <div className="stat-l">
        <span className="stat-ln">{label}</span>
      </div>
      <div className="stat-v">
        {tone && (
          <>
            <Icon name={tone === "bad" ? "alertCircle" : "alert"} className="tone-ico" />
            <span className="sr-only">{t(tone === "bad" ? "dash.tone.bad" : "dash.tone.warn")}: </span>
          </>
        )}
        {value}
      </div>
      {sub != null && <div className="stat-s">{sub}</div>}
    </div>
  );
}

/** sprint 8 (rule NC): the daily quota of the user was not charged — the turn changed nothing, or failed */
export function QuotaMark({ row, compact }: { row: { quota_charged?: boolean | null; quota_refund_reason?: "failed" | "no_change" | null }; compact?: boolean }) {
  const { t } = useI18n();
  if (row.quota_charged !== false) return null;
  const why = row.quota_refund_reason === "no_change" ? "no_change" : "failed";
  return (
    <span className={cx("quota-mark", compact && "is-compact")} title={t(`req.quota.${why}.h`)} data-testid="req-quota-free" data-reason={why}>
      <Icon name="checkCircle" />
      <span>
        {t("req.quota.free")}
        {/* in the log the reason is in the hint (and read by screen readers) — the column stays narrow */}
        <span className={compact ? "sr-only" : "xs muted"}> · {t(`req.quota.${why}`)}</span>
      </span>
    </span>
  );
}

/** full status of a request in words — the hint of the narrow status cell of the log */
export function requestStatusText(t: (k: string) => string, r: { status: string; error_code: string | null; quota_charged?: boolean | null; quota_refund_reason?: string | null }): string {
  const parts = [t(`req.st.${r.status}`)];
  if (r.error_code) parts.push(r.error_code);
  if (r.quota_charged === false) parts.push(`${t("req.quota.free")} (${t(r.quota_refund_reason === "no_change" ? "req.quota.no_change" : "req.quota.failed")})`);
  return parts.join(" · ");
}

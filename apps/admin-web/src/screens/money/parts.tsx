/**
 * Shared pieces of «Деньги»: integer money (sums from tiyin, Stars, micro-dollars) with their units, an account link
 * (a short UUID → the learner card with users.read; «обезличен» after the deletion saga), an order link, the text of a
 * form problem and the KPI card. Money is never shown with a float: model.ts formats integers.
 */
import type { ReactNode } from "react";
import type { AdminOrderRow, StaffRef } from "@tilhero/contracts/admin";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { cx } from "../../ui/kit";
import { fmtMicroUsd, fmtStars, fmtTiyin, NOTE_MAX, NOTE_MIN, type Issue } from "./model";

export function useMoney() {
  const { t, fmt } = useI18n();
  return {
    /** «49 000 сум» */
    sum: (tiyin: number | null | undefined) => (tiyin == null ? "—" : t("money.sum", { n: fmtTiyin(tiyin, fmt.locale) })),
    /** «⭐ 250» */
    stars: (n: number | null | undefined) => (n == null ? "—" : t("money.stars", { n: fmtStars(n, fmt.locale) })),
    /** «$3.25» */
    usd: (micro: number | null | undefined) => (micro == null ? "—" : fmtMicroUsd(micro, fmt.locale)),
    /** the amount of an order, a transaction or a refund — in its own currency (exactly one is filled) */
    amount: (o: Pick<AdminOrderRow, "amount_tiyin" | "amount_stars">) =>
      o.amount_tiyin != null ? t("money.sum", { n: fmtTiyin(o.amount_tiyin, fmt.locale) }) : o.amount_stars != null ? t("money.stars", { n: fmtStars(o.amount_stars, fmt.locale) }) : "—",
  };
}

/** A learner account: a short id; with users.read — the way to the learner card; null — anonymised. */
export function AccountRef({ id, testId }: { id: string | null; testId?: string }) {
  const { t } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  if (!id)
    return (
      <span className="tag plain" data-testid={testId}>
        {t("mny.anon")}
      </span>
    );
  const label = shortId(id, 8, 4);
  if (can("users.read"))
    return (
      <button type="button" className="tr mono" title={id} aria-label={t("mny.openLearner", { id: label })} onClick={() => navigate("users", id)} data-testid={testId}>
        {label}
      </button>
    );
  return (
    <span className="mono" title={id} data-testid={testId}>
      {label}
    </span>
  );
}

/** «№ 1042» → the order card in «Заказы и платежи». */
export function OrderLink({ id, no, testId }: { id: string | null; no: number | null; testId?: string }) {
  const { t } = useI18n();
  const { navigate } = useNav();
  if (!id || no == null) return <span className="muted">—</span>;
  return (
    <button type="button" className="tr mono" onClick={() => navigate("payments", `orders/${id}`)} aria-label={t("pay.openOrder", { n: no })} data-testid={testId}>
      № {no}
    </button>
  );
}

export const staffName = (s: StaffRef | null | undefined, system: string) => s?.name || system;

/** The text of a form problem of the section: `mi.<code>` with the bounds of notes; else the raw code. */
export function useMoneyIssue() {
  const { t } = useI18n();
  return (x: Issue | null | undefined) => {
    if (!x) return null;
    const k = `mi.${x.code}` as MessageKey;
    const s = t(k, { min: NOTE_MIN, max: NOTE_MAX });
    return s === k ? x.code : s;
  };
}

export function Kpi({ label, value, note, tone, testId }: { label: ReactNode; value: ReactNode; note?: ReactNode; tone?: "bad" | "warn" | "good"; testId?: string }) {
  return (
    <div className={cx("card kpi", tone === "bad" && "is-bad")} data-testid={testId}>
      <div className="kpi-l">{label}</div>
      <div className={cx("kpi-v", tone === "warn" && "warn-ink", tone === "good" && "good-ink")}>{value}</div>
      {note != null && <div className="kpi-n">{note}</div>}
    </div>
  );
}

/** «оценка» next to a figure computed with the Star rate of finance */
export function EstimateTag({ testId }: { testId?: string }) {
  const { t } = useI18n();
  return (
    <span className="tag plain mny-est" title={t("fin.estimateH")} data-testid={testId}>
      {t("fin.estimate")}
    </span>
  );
}

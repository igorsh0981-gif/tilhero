import type { EventReaction, Recommendation } from "@tilhero/contracts/bff";
import { useState } from "react";
import { clampScore, displayReasons } from "../../events/why";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { useInterests } from "../../state/directory";
import { haptic } from "../../tg";
import { countryName } from "../../ui/EventCard";
import { Icon } from "../../ui/Icon";
import { showToast } from "../../ui/overlays";

/**
 * «Почему вам» on the event detail (prototype v9 dtWhy, AT-25-TG): the score ring 0..100, 2–3 reasons each marked
 * fact / estimate / recommendation, the expandable factors of the score, and the reactions «Больше такого» /
 * «Не интересно» (a second tap or «Отменить» removes the reaction — POST …/reactions with undo).
 * recommendation = null (service down, personalisation off) → the block is not shown.
 */
const KIND_CLS = { fact: "k-fact", estimate: "k-est", recommendation: "k-rec" } as const;
const FACTORS = ["interests", "geography", "budget", "significance", "freshness", "feedback"] as const;

type Reaction = "more" | "less" | null;
const FROM_SERVER: Record<EventReaction, Reaction> = { more_like_this: "more", not_interested: "less" };

/**
 * The user's reaction to an event (EventDetailView.reaction), set and removed optimistically: POST …/reactions sets
 * «Больше такого» / «Не интересно», DELETE …/reactions/{event_id} removes it; a failure rolls the state back.
 */
export function useReaction(eventId: string, initial: EventReaction | null | undefined) {
  const { api } = useApp();
  const { t } = useI18n();
  const errText = useErrorText();
  const [rx, setRx] = useState<Reaction>(initial ? FROM_SERVER[initial] ?? null : null);
  const [busy, setBusy] = useState(false);
  const run = async (next: Reaction, call: () => Promise<void>, ok: string, icon: "check" | "refresh") => {
    if (busy) return;
    const prev = rx;
    setRx(next);
    setBusy(true);
    haptic.selection();
    try {
      await call();
      showToast(ok, icon);
    } catch (e) {
      setRx(prev);
      showToast(errText(e), "alert");
    } finally {
      setBusy(false);
    }
  };
  const undo = () => run(null, () => api.recommendations.unreact(eventId), t("why.rx.undo"), "refresh");
  const set = (next: "more" | "less") =>
    rx === next ? undo() : run(next, () => api.recommendations.react({ event_id: eventId, reaction: next, undo: false }), t(next === "more" ? "why.rx.more" : "why.rx.less"), "check");
  return { rx, busy, set, undo };
}
export type ReactionState = ReturnType<typeof useReaction>;

/** «Вы отметили «Не интересно» · Отменить» — instead of «Почему вам» while the event is hidden by the reaction. */
export function NotInterested({ r }: { r: ReactionState }) {
  const { t } = useI18n();
  return (
    <section className="sec" data-testid="dt-not-interested">
      <div className="panel ni">
        <span className="lrow-i">
          <Icon name="slash" size={18} />
        </span>
        <div className="ni-t">
          <b>{t("why.ni.h")}</b>
          <small>{t("why.ni.p")}</small>
        </div>
        <button className="lnk" type="button" data-testid="why-ni-undo" disabled={r.busy} aria-label={t("why.ni.undoA11y")} onClick={() => void r.undo()}>
          {t("why.undo")}
        </button>
      </div>
    </section>
  );
}

export function WhyBlock({ rec, reaction }: { rec: Recommendation; reaction: ReactionState }) {
  const { api } = useApp();
  const { t, lang } = useI18n();
  const dir = useInterests(api);
  const [open, setOpen] = useState(false);
  const { rx, busy } = reaction;
  const score = clampScore(rec.score);
  const reasons = displayReasons(rec, {
    t,
    lang,
    category: (code) => {
      const hit = dir.items?.find((i) => i.code === code);
      return hit ? hit.label[lang] || hit.label.ru : null;
    },
    country: (cc) => countryName(cc, lang),
  });
  const f = rec.factors;
  const react = (next: "more" | "less") => void reaction.set(next);

  if (score === null) return null;
  return (
    <section className="sec" data-testid="dt-why">
      <div className="panel">
        <div className="why">
          <div className="ring" role="img" aria-label={t("why.ring", { n: score })} data-testid="why-score" data-score={score}>
            <svg viewBox="0 0 36 36" aria-hidden="true">
              <circle className="ring-bg" cx="18" cy="18" r="15.5" pathLength={100} />
              <circle className="ring-fg" cx="18" cy="18" r="15.5" pathLength={100} strokeDasharray={`${score} 100`} />
            </svg>
            <b className="num">{score}</b>
          </div>
          <div>
            <h2 className="h-sm">{t("why.h")}</h2>
            <small className="lbl">{t("why.sub")}</small>
          </div>
        </div>
        {reasons.length > 0 && (
          <ul className="claims" data-testid="why-reasons">
            {reasons.map((r) => (
              <li key={r.code} data-code={r.code} data-kind={r.kind}>
                <span className={`kind ${KIND_CLS[r.kind]}`}>{t(`why.k.${r.kind}` as MessageKey)}</span>
                <p>{r.text}</p>
              </li>
            ))}
          </ul>
        )}
        {f && (
          <>
            <button className="fx-tg" type="button" aria-expanded={open} data-testid="why-fx-toggle" onClick={() => setOpen((x) => !x)}>
              <span>{t("why.fx")}</span>
              <Icon name="chevD" size={18} />
            </button>
            {open && (
              <div className="fx" data-testid="why-factors">
                {FACTORS.map((k) => {
                  const v = clampScore(f[k]);
                  return (
                    <div className="fx-r" key={k} data-factor={k}>
                      <span>{t(`why.f.${k}` as MessageKey)}</span>
                      <i>
                        <em style={{ width: `${v ?? 0}%` }} />
                      </i>
                      <b className="num">{v ?? "—"}</b>
                    </div>
                  );
                })}
                {f.budget === null && <p className="fx-note">{t("why.f.budgetNone")}</p>}
              </div>
            )}
          </>
        )}
        <ul className="legend" aria-label={t("why.legendA11y")}>
          <li>
            <span className="kind k-fact">{t("why.k.fact")}</span>
            {t("why.lg.fact")}
          </li>
          <li>
            <span className="kind k-est">{t("why.k.estimate")}</span>
            {t("why.lg.estimate")}
          </li>
          <li>
            <span className="kind k-rec">{t("why.k.recommendation")}</span>
            {t("why.lg.recommendation")}
          </li>
        </ul>
        <div className="react" data-testid="why-react">
          <button className={rx === "more" ? "btn btn-sm btn-on" : "btn btn-sm btn-ghost"} type="button" aria-pressed={rx === "more"} data-testid="why-more" onClick={() => void react("more")}>
            <Icon name="plusc" size={16} />
            {t("why.more")}
          </button>
          <button className={rx === "less" ? "btn btn-sm btn-on" : "btn btn-sm btn-ghost"} type="button" aria-pressed={rx === "less"} data-testid="why-less" onClick={() => void react("less")}>
            <Icon name="slash" size={16} />
            {t("why.less")}
          </button>
          {rx && (
            <button className="lnk why-undo" type="button" data-testid="why-undo" disabled={busy} onClick={() => void reaction.undo()}>
              {t("why.undo")}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

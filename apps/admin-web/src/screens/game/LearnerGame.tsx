/**
 * The «Игра» tab of the learner card in «Ученики» (game.read): the short wallet — level, XP, tils, freezes, the hero —
 * and the link to the whole wallet in «Геймификация → Кошельки» (the ledger and the manual operations live there).
 * No wallet yet (404) — a calm empty state.
 */
import { useCallback, useEffect, useState } from "react";
import type { AdminWallet } from "@tilhero/contracts/admin";
import { Game } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { LoadError } from "../../ui/LoadError";
import { Btn, Empty, Spinner } from "../../ui/kit";
import { Kpi } from "./parts";

export function LearnerGameTab({ id }: { id: string }) {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const [w, setW] = useState<AdminWallet | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    setError(null);
    Game.wallet(id)
      .then(setW)
      .catch(setError);
  }, [id]);
  useEffect(load, [load]);
  const open = <Btn kind="primary" icon="coins" label={t("lr.gameOpen")} onClick={() => navigate("game", `wallets/${id}`)} testId="lc-game-open" />;
  if (error)
    return error instanceof ApiError && error.status === 404 ? (
      <div className="stack">
        <Empty icon="coins" title={t("wl.none")} text={t("wl.noneM")} testId="lc-game-none" />
      </div>
    ) : (
      <LoadError error={error} onRetry={load} />
    );
  if (!w) return <Spinner label={t("common.loading")} />;
  return (
    <div className="stack" data-testid="lc-game">
      <div className="kpis mem-kpis">
        <Kpi label={t("wl.level")} value={fmt.num(w.level)} note={t("wl.xpTotal", { n: fmt.num(w.xp_total) })} />
        <Kpi label={t("gm.cur.til")} value={fmt.num(w.til_balance)} />
        <Kpi label={t("gm.cur.freeze")} value={fmt.num(w.freeze_stock)} />
        <Kpi label={t("wl.hero")} value={w.hero ? <span className="mono small">{w.hero.code}</span> : "—"} note={w.hero ? t("hr.stageN", { n: w.hero.stage }) : t("wl.noHero")} />
      </div>
      <p className="xs muted">{t("lr.gameNote")}</p>
      <div className="acts">{open}</div>
    </div>
  );
}

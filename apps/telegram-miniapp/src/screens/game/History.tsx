import type { GameCurrency, GameOperation, GameSummary, Page } from "@tilhero/contracts/bff";
import { useState } from "react";
import { amountText, reasonKey } from "../../domain/game";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { Icon, type IconName } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Pill, Seg, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";
import { GameError } from "./parts";

type Filter = "all" | GameCurrency;
const FILTERS: readonly Filter[] = ["all", "xp", "til", "freeze"];
const CUR_ICON: Record<GameCurrency, IconName> = { xp: "star", til: "coin", freeze: "snow" };

/**
 * The history of the ledger (APP-PROG-03, APP-GAME-06, AT-63): every operation with its origin in words, newest first,
 * 30 per page, a filter by currency. A staff operation reads «Корректировка поддержки» — the staff comment never reaches
 * the learner; a reversed one is struck through and says «отменена» (not colour only); a cut by the daily limit and the
 * multiplier of a week event are named.
 */
export function GameHistoryScreen() {
  const { bff, nav, session } = useApp();
  const { t, tp } = useI18n();
  const kid = session.learner.kind === "child";
  const [filter, setFilter] = useState<Filter>("all");
  const cur = filter === "all" ? null : filter;
  const first = useLoad<Page<GameOperation>>(() => bff.gameHistory(cur, null), [session.learner.learner_id, cur]);
  const summary = useLoad<GameSummary | null>(() => bff.gameSummary(true).catch(() => null), [session.learner.learner_id]);
  const [more, setMore] = useState<{ key: string; items: GameOperation[]; next: string | null } | null>(null);
  const key = `${cur ?? "all"}`;
  const extra = more && more.key === key ? more : null;
  const items = [...(first.data?.items ?? []), ...(extra?.items ?? [])];
  const next = extra ? extra.next : (first.data?.next_cursor ?? null);
  const loadMore = useAction(async () => {
    if (!next) return;
    const p = await bff.gameHistory(cur, next);
    setMore({ key, items: [...(extra?.items ?? []), ...p.items], next: p.next_cursor });
  });
  const s = summary.data;

  return (
    <>
      <Bar title={t("game.hist.title")} onBack={nav.back} />
      <main className="scroll" data-testid="game-history">
        <div className="stack">
          <div className="pad stack tight">
            {s ? (
              <p className="sub ink" data-testid="hist-now">
                {t("game.hist.now", { xp: s.xp_total, til: s.til_balance, tw: tp("game.tilsWord", s.til_balance), fr: s.freeze_stock, fw: tp("game.freezeWord", s.freeze_stock) })}
              </p>
            ) : null}
            <Seg
              label={t("game.hist.filter")}
              value={filter}
              testId="hist-filter"
              options={FILTERS.map((f) => ({ value: f, label: t(`game.hist.${f}`) }))}
              onChange={(f) => {
                setFilter(f);
                setMore(null);
              }}
            />
          </div>
          {first.loading && !first.data ? (
            <div className="pad"><Skeleton lines={4} /></div>
          ) : first.error && !first.data ? (
            <GameError error={first.error} errorObj={first.errorObj} onRetry={() => void first.reload()} />
          ) : items.length === 0 ? (
            <div className="pad">
              <div className="card notice" data-testid="hist-empty">
                <Icon name="info" size={20} />
                <p className="sub ink">{kid ? t("game.hist.emptyKid") : t("game.hist.empty")}</p>
              </div>
            </div>
          ) : (
            <div className="pad stack tight">
              <ul className="list" data-testid="hist-list" aria-busy={first.loading || undefined}>
                {items.map((op) => (
                  <HistRow key={op.op_id} op={op} />
                ))}
              </ul>
              <ErrorLine text={loadMore.error} />
              {next ? (
                <Btn variant="secondary" busy={loadMore.busy} onClick={() => void loadMore.run()} data-testid="hist-more">
                  {t("c.more")}
                </Btn>
              ) : null}
            </div>
          )}
          <div className="pad">
            <p className="sub small">{t("game.hist.note")}</p>
          </div>
        </div>
      </main>
    </>
  );
}

function HistRow({ op }: { op: GameOperation }) {
  const { t, tp, fmt } = useI18n();
  const reversed = op.status === "reversed";
  const amount = amountText(op, tp);
  return (
    <li className="hist-row" data-testid={`hist-${op.op_id}`} data-reason={op.reason} data-status={op.status}>
      <span className="nic" aria-hidden="true"><Icon name={CUR_ICON[op.currency]} size={18} /></span>
      <span className="t">
        <b>{t(reasonKey(op))}</b>
        <span className="sub small">{fmt.dateTime(op.created_at)}</span>
        {op.capped || op.multiplier > 1 || reversed ? (
          <span className="pills">
            {reversed ? <Pill tone="mute">{t("game.hist.reversed")}</Pill> : null}
            {op.capped ? <Pill tone="warn">{t("game.hist.capped")}</Pill> : null}
            {op.multiplier > 1 ? <Pill>{t("game.hist.multiplier", { f: op.multiplier })}</Pill> : null}
          </span>
        ) : null}
      </span>
      <span className={cx("amt", reversed && "rev")} data-testid={`hist-amt-${op.op_id}`}>
        {amount}
      </span>
    </li>
  );
}

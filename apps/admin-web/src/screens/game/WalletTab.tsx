/**
 * «Геймификация → Кошельки» (ADM-GAME-03 LinguaFlow «Кошелёк наград», AT-72): a learner's wallet by the UUID (opened
 * from the learner card in «Ученики» or typed): balance (level, XP, tils, freezes), the hero and its stage, the
 * inventory, today's quests, badges, referrals, settings, and the ledger — every operation with its origin (reason,
 * source, rules version, multiplier, cap), status and actor, filtered by currency, newest first.
 *
 * wallet.adjust (step-up, reason 10..300, audit): a manual operation is a separate record of the ledger; a correction
 * is a reversal (never an edit); a refund of a purchase reverses its operations and takes the item back. Tils and
 * freezes never go below zero (409 BALANCE_NEGATIVE). The reason is seen by staff only — the learner sees «Корректировка
 * поддержки». Without wallet.adjust the commands are not offered.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminHero, AdminLedgerOperation, AdminWallet } from "@tilhero/contracts/admin";
import type { GameCurrency } from "@tilhero/contracts/bff";
import { Game } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Seg, Select, Spinner } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { errText } from "../../ui/errors";
import { useToast } from "../../ui/toasts";
import { CommandKey, outcomeUnknown } from "../memory/model";
import { useKeyed } from "../ai/parts";
import { GameImg, IssueMsg, Kpi, useAmount } from "./parts";
import { actorOf, ADJUST_MAX, adjustmentBody, balanceOf, canReverse, CURRENCIES, emptyAdjust, isUuid, issuesAt, purchaseOf, REASON_MAX, REASON_MIN, refundAnchors, reversalBelowZero, type AdjustForm } from "./model";

export function WalletTab({ userId }: { userId: string | null }) {
  return userId ? <Wallet key={userId} userId={userId} /> : <WalletLookup />;
}

function WalletLookup() {
  const { t } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const [id, setId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = () => {
    if (!isUuid(id)) {
      setErr(t("mem.lookupErr"));
      return;
    }
    navigate("game", `wallets/${id.trim().toLowerCase()}`);
  };
  return (
    <section className="card stack sm mem-lookup" aria-labelledby="wl-lk-h" data-testid="wl-lookup">
      <h2 className="h2" id="wl-lk-h">
        {t("wl.lookup")}
      </h2>
      <p className="small muted">{t("wl.lookupM")}</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <div className="field grow">
          <label htmlFor="wl-uid">{t("mem.uid")}</label>
          <input id="wl-uid" className="input mono" value={id} spellCheck={false} autoComplete="off" placeholder="a1000000-0000-4000-8000-000000000001" aria-invalid={!!err || undefined} aria-describedby={err ? "wl-uid-e" : undefined} onChange={(e) => (setId(e.target.value), setErr(null))} data-testid="wl-uid" />
          <FieldErr msg={err} id="wl-uid-e" />
        </div>
        <Btn type="submit" kind="primary" icon="search" label={t("mem.open")} testId="wl-uid-go" />
      </form>
      {can("users.read") ? (
        <Empty icon="users" title={t("wl.fromCard")} text={t("wl.fromCardM")}>
          <Btn size="sm" icon="users" label={t("mem.toLearners")} onClick={() => navigate("users")} testId="wl-to-users" />
        </Empty>
      ) : (
        <p className="xs muted row">
          <Icon name="info" /> {t("wl.noUsers")}
        </p>
      )}
    </section>
  );
}

/** A refund names its purchase: an item of the inventory (cosmetics) or a shop operation of the ledger (a freeze too). */
interface RefundTarget {
  purchase_id: string;
  /** item code (cosmetics) or null (a consumable — the freeze) */
  code: string | null;
  /** the operations of the purchase shown in the ledger (empty when opened from the inventory) */
  ops: AdminLedgerOperation[];
}
type Cmd = { kind: "adjust" } | { kind: "reverse"; op: AdminLedgerOperation } | { kind: "refund"; target: RefundTarget };

function Wallet({ userId }: { userId: string }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const { navigate } = useNav();
  const toast = useToast();
  const amount = useAmount();
  const k = useKeyed();
  const [w, setW] = useState<AdminWallet | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [heroes, setHeroes] = useState<AdminHero[]>([]);
  const [tick, setTick] = useState(0);
  const [cmd, setCmd] = useState<Cmd | null>(null);
  const [adj, setAdj] = useState<AdjustForm>(emptyAdjust);
  const [adjKey] = useState(() => new CommandKey(uuid));
  const [cmdKey] = useState(() => new CommandKey(uuid));
  const adjust = can("wallet.adjust");

  const load = useCallback(() => {
    Game.wallet(userId)
      .then((x) => (setW(x), setError(null)))
      .catch(setError);
  }, [userId]);
  useEffect(load, [load, tick]);
  useEffect(() => {
    Game.heroes()
      .then((r) => setHeroes(r.items))
      .catch(() => undefined);
  }, []);
  const changed = () => setTick((n) => n + 1);
  const none = error instanceof ApiError && error.status === 404;
  const hero = w?.hero ? heroes.find((h) => h.code === w.hero!.code) : undefined;
  const heroImg = hero && w?.hero ? (hero.images.find((x) => x.stage === w.hero!.stage)?.image ?? null) : null;

  const fail = (e: unknown) => {
    if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
    // the outcome is unknown (network, 5xx): the operation may have been made — re-read the wallet and the ledger;
    // a repeat of the same command goes with the same Idempotency-Key (no second operation)
    if (outcomeUnknown(e)) {
      changed();
      return t("wl.unknownOutcome");
    }
    if (e instanceof ApiError && e.code === "BALANCE_NEGATIVE") return t("err.BALANCE_NEGATIVE");
    return errText(i18n, e);
  };

  return (
    <div className="stack" data-testid="wl" data-user={userId}>
      <div className="row">
        <Btn size="sm" kind="ghost" icon="chevL" label={t("mem.otherLearner")} onClick={() => navigate("game", "wallets")} testId="wl-back" />
        <span className="mono small muted" title={userId}>
          {shortId(userId, 8, 4)}
        </span>
        <span className="grow" />
        {can("users.read") && <Btn size="sm" icon="users" label={t("mem.toCard")} onClick={() => navigate("users", userId)} testId="wl-to-card" />}
        {adjust && w && (
          <Btn
            size="sm"
            kind="primary"
            icon="coins"
            label={t("wl.adjust")}
            onClick={() => {
              setAdj(emptyAdjust());
              setCmd({ kind: "adjust" });
            }}
            testId="wl-adjust"
          />
        )}
      </div>
      {!adjust && (
        <p className="xs muted row" data-testid="wl-ro">
          <Icon name="lock" /> {t("wl.noAdjust")}
        </p>
      )}
      {error && !w ? (
        none ? (
          <Empty icon="coins" title={t("wl.none")} text={t("wl.noneM")} testId="wl-none" />
        ) : (
          <LoadError error={error} onRetry={load} />
        )
      ) : !w ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <>
          <div className="kpis wl-kpis" data-testid="wl-kpis">
            <Kpi label={t("wl.level")} value={fmt.num(w.level)} note={t("wl.xpTotal", { n: fmt.num(w.xp_total) })} testId="wl-level" />
            <Kpi label={t("gm.cur.til")} value={<span data-testid="wl-til">{fmt.num(w.til_balance)}</span>} note={t("wl.tilNote")} />
            <Kpi label={t("gm.cur.freeze")} value={<span data-testid="wl-freeze">{fmt.num(w.freeze_stock)}</span>} note={w.settings.auto_freeze ? t("wl.autoOn") : t("wl.autoOff")} />
            <Kpi label={t("wl.skills")} value={fmt.num(w.confirmed_skills)} note={t("wl.skillsNote")} />
          </div>
          <div className="grid2">
            <section className="card stack sm" aria-labelledby="wl-hero-h" data-testid="wl-hero">
              <h2 className="h3" id="wl-hero-h">
                {t("wl.hero")}
              </h2>
              {w.hero ? (
                <div className="row nowrap-row">
                  <GameImg img={heroImg} alt={t("hr.imgAlt", { hero: hero?.name.ru ?? w.hero.code, s: w.hero.stage, stage: hero?.stages.find((s) => s.stage === w.hero!.stage)?.name.ru ?? "" })} size={72} />
                  <span>
                    <b lang="ru">{hero?.name.ru ?? w.hero.code}</b>
                    <span className="mono xs muted block">{w.hero.code}</span>
                    <span className="small block">{t("hr.stageN", { n: w.hero.stage })}</span>
                  </span>
                </div>
              ) : (
                <p className="small muted">{t("wl.noHero")}</p>
              )}
              <div className="kv">
                <span>{t("gm.audience")}</span>
                <span>{t(`gm.aud.${w.audience}` as MessageKey)}</span>
              </div>
              <div className="kv">
                <span>{t("wl.questsHidden")}</span>
                <span>{w.settings.quests_hidden ? t("common.yes") : t("common.no")}</span>
              </div>
              <div className="kv" data-testid="wl-referrals">
                <span>{t("wl.referrals")}</span>
                <span className="num">{t("wl.referralsV", { p: w.referrals.pending, r: w.referrals.rewarded, c: w.referrals.capped })}</span>
              </div>
            </section>
            <section className="card stack sm" aria-labelledby="wl-q-h" data-testid="wl-quests">
              <h2 className="h3" id="wl-q-h">
                {t("wl.questsToday")}
              </h2>
              {w.quests_today.length ? (
                <ul className="plain-list wl-quests">
                  {w.quests_today.map((q) => (
                    <li key={q.code} data-status={q.status}>
                      <span className="grow">
                        {t(`gq.${q.kind}` as MessageKey)} <span className="mono xs muted">{q.code}</span>
                      </span>
                      <span className="wl-prog" role="progressbar" aria-valuemin={0} aria-valuemax={q.target} aria-valuenow={Math.min(q.progress, q.target)} aria-label={t("wl.questProg", { p: q.progress, n: q.target })}>
                        <span style={{ width: `${Math.min(100, (q.progress / Math.max(1, q.target)) * 100)}%` }} />
                      </span>
                      <span className="xs num">
                        {fmt.num(q.progress)}/{fmt.num(q.target)}
                      </span>
                      <Pill tone={q.status === "completed" ? "good" : q.status === "expired" ? "neutral" : "info"}>{k("wlq", q.status)}</Pill>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">{w.settings.quests_hidden ? t("wl.questsOff") : t("wl.noQuests")}</p>
              )}
            </section>
            <section className="card stack sm" aria-labelledby="wl-inv-h" data-testid="wl-inventory">
              <h2 className="h3" id="wl-inv-h">
                {t("wl.inventory")}
              </h2>
              {w.owned_items.length ? (
                <ul className="plain-list wl-inv">
                  {w.owned_items.map((it) => (
                    <li key={it.purchase_id} data-testid={`wl-item-${it.code}`}>
                      <span className="grow">
                        <span className="mono">{it.code}</span> <span className="xs muted">· {t(`shk.${it.kind}` as MessageKey)}</span>
                        <span className="xs muted block">{t("wl.boughtAt", { t: fmt.dateTime(it.purchased_at) })}</span>
                      </span>
                      {adjust && <Btn size="xs" kind="danger-ghost" icon="rollback" label={t("wl.refund")} aria={t("wl.refundOf", { c: it.code })} onClick={() => setCmd({ kind: "refund", target: { purchase_id: it.purchase_id, code: it.code, ops: [] } })} testId={`wl-refund-${it.code}`} />}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">{t("wl.noItems")}</p>
              )}
            </section>
            <section className="card stack sm" aria-labelledby="wl-b-h" data-testid="wl-badges">
              <h2 className="h3" id="wl-b-h">
                {t("wl.badges", { n: w.badges.length })}
              </h2>
              {w.badges.length ? (
                <ul className="plain-list wl-badges">
                  {w.badges.map((b) => (
                    <li key={b.code}>
                      <Icon name="trophy" /> <span className="grow">{badgeName(t, b.code)}</span>
                      <span className="xs muted">{fmt.date(b.earned_at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">{t("wl.noBadges")}</p>
              )}
            </section>
          </div>
          <Ledger
            userId={userId}
            tick={tick}
            onReverse={adjust ? (op) => setCmd({ kind: "reverse", op }) : null}
            onRefund={adjust ? (purchaseId, ops) => setCmd({ kind: "refund", target: { purchase_id: purchaseId, code: w.owned_items.find((o) => o.purchase_id === purchaseId)?.code ?? null, ops } }) : null}
          />
        </>
      )}
      <p className="xs muted row">
        <Icon name="shield" /> {t("wl.piiNote")}
      </p>
      {cmd && w && dialog(w)}
    </div>
  );

  function dialog(wallet: AdminWallet) {
    if (!cmd) return null;
    const close = () => setCmd(null);
    if (cmd.kind === "adjust") {
      const chk = adjustmentBody({ ...adj, reason: "x".repeat(REASON_MIN) }, wallet);
      const amountIssues = issuesAt(chk.issues, "amount");
      const showAmount = adj.amount.trim() !== "" ? amountIssues : [];
      return (
        <ConfirmCommand
          title={t("wl.adjustT")}
          text={t("wl.adjustM")}
          icon="coins"
          ok={t("wl.adjustOk")}
          minReason={REASON_MIN}
          maxReason={REASON_MAX}
          reasonPlaceholder={t("wl.reasonPh")}
          okDisabled={amountIssues.length > 0}
          testId="wl-adjust-dialog"
          extra={
            <>
              <Callout kind="warn" icon="alert" testId="wl-adjust-warn">
                {t("wl.separateNote")}
              </Callout>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="wl-cur">{t("wl.currency")}</label>
                  <Select<GameCurrency> id="wl-cur" label={t("wl.currency")} value={adj.currency} onChange={(v) => setAdj({ ...adj, currency: v })} options={CURRENCIES.map((c) => ({ v: c, label: t(`gm.cur.${c}` as MessageKey) }))} testId="wl-cur" />
                </div>
                <div className="field">
                  <span className="field-label" id="wl-dir-l">
                    {t("wl.direction")}
                  </span>
                  <Seg<AdjustForm["direction"]> label={t("wl.direction")} value={adj.direction} onChange={(v) => setAdj({ ...adj, direction: v })} items={[{ v: "credit", label: t("wl.credit") }, { v: "debit", label: t("wl.debit") }]} testId="wl-dir" />
                </div>
                <div className="field">
                  <label htmlFor="wl-amount" className="req">
                    {t("wl.amount")}
                  </label>
                  <input id="wl-amount" className={cx("input num-in", showAmount.length > 0 && "is-invalid")} inputMode="numeric" value={adj.amount} aria-invalid={showAmount.length > 0 || undefined} aria-describedby="wl-amount-h" onChange={(e) => setAdj({ ...adj, amount: e.target.value })} data-testid="wl-amount" />
                  <span className="hint" id="wl-amount-h">
                    {t("wl.amountHint", { max: fmt.num(ADJUST_MAX[adj.currency]), b: amount(adj.currency, balanceOf(wallet, adj.currency)) })}
                  </span>
                  <IssueMsg issues={showAmount} vars={{ max: fmt.num(ADJUST_MAX[adj.currency]), b: amount(adj.currency, balanceOf(wallet, adj.currency)) }} />
                </div>
                <div className="field">
                  <span className="field-label">{t("wl.after")}</span>
                  <b data-testid="wl-after">{chk.body ? amount(adj.currency, balanceOf(wallet, adj.currency) + chk.body.amount) : "—"}</b>
                  {adj.currency === "xp" && adj.direction === "debit" && <span className="hint">{t("wl.xpLevelNote")}</span>}
                </div>
              </div>
              <Callout kind="info" icon="smartphoneKey">
                {t("wl.stepUpNote")}
              </Callout>
            </>
          }
          onClose={close}
          onConfirm={async (reason) => {
            if (reason.length > REASON_MAX) return t("gm.commentMax", { n: REASON_MAX });
            const { body } = adjustmentBody({ ...adj, reason }, wallet);
            if (!body) return t("gm.fixErrors", { n: 1 });
            const key = adjKey.for(JSON.stringify([userId, body]));
            try {
              const op = await Game.adjust(userId, body, key);
              adjKey.settle();
              toast(t("wl.adjusted", { a: amount(op.currency, op.amount, true) }), "ok", "game.wallet_adjusted");
              changed();
              return null;
            } catch (e) {
              adjKey.settle(e);
              return fail(e);
            }
          }}
        />
      );
    }
    if (cmd.kind === "reverse") {
      const op = cmd.op;
      const below = reversalBelowZero(op, wallet);
      return (
        <ConfirmCommand
          title={t("wl.reverseT", { a: amount(op.currency, op.amount, true) })}
          text={t("wl.reverseM", { a: amount(op.currency, -op.amount, true) })}
          icon="rollback"
          tone="bad"
          ok={t("wl.reverse")}
          okKind="danger"
          minReason={REASON_MIN}
          maxReason={REASON_MAX}
          reasonPlaceholder={t("wl.reasonPh")}
          okDisabled={below}
          testId="wl-reverse-dialog"
          extra={
            <>
              <dl className="dl" data-testid="wl-reverse-op">
                <dt>{t("wl.col.op")}</dt>
                <dd>
                  {t(`grsn.${op.reason}` as MessageKey)} · {fmt.dateTime(op.created_at)}
                </dd>
                <dt>{t("wl.col.source")}</dt>
                <dd className="mono xs">
                  {op.source.kind}:{shortId(op.source.ref, 8, 4)}
                </dd>
              </dl>
              {below && (
                <Callout kind="bad" icon="alertCircle" testId="wl-reverse-below">
                  {t("wl.reverseBelow", { b: amount(op.currency, balanceOf(wallet, op.currency)) })}
                </Callout>
              )}
              <Callout kind="info" icon="smartphoneKey">
                {t("wl.stepUpNote")}
              </Callout>
            </>
          }
          onClose={close}
          onConfirm={async (reason) => {
            if (reason.length > REASON_MAX) return t("gm.commentMax", { n: REASON_MAX });
            const key = cmdKey.for(JSON.stringify(["reverse", op.op_id, reason]));
            try {
              await Game.reverse(userId, op.op_id, reason, key);
              cmdKey.settle();
              toast(t("wl.reversed", { a: amount(op.currency, -op.amount, true) }), "ok", "game.wallet_reversed");
              changed();
              return null;
            } catch (e) {
              cmdKey.settle(e);
              if (e instanceof ApiError && e.code === "ALREADY_REVERSED") changed();
              if (e instanceof ApiError && e.code === "OPERATION_NOT_REVERSIBLE") return t("err.OPERATION_NOT_REVERSIBLE");
              return fail(e);
            }
          }}
        />
      );
    }
    if (cmd.kind === "refund") {
      const it = cmd.target;
      const name = it.code ?? shortId(it.purchase_id, 8, 4);
      return (
        <ConfirmCommand
          title={t("wl.refundT", { c: name })}
          text={it.code ? t("wl.refundM") : t("wl.refundConsumableM")}
          icon="rollback"
          tone="bad"
          ok={t("wl.refund")}
          okKind="danger"
          minReason={REASON_MIN}
          maxReason={REASON_MAX}
          reasonPlaceholder={t("wl.reasonPh")}
          testId="wl-refund-dialog"
          extra={
            <>
              <p className="xs muted mono" data-testid="wl-refund-purchase">
                {t("wl.purchaseId", { id: it.purchase_id })}
              </p>
              {it.ops.length > 0 && (
                <p className="small" data-testid="wl-refund-ops">
                  {t("wl.purchaseOps", { ops: it.ops.map((o) => amount(o.currency, o.amount, true)).join(" · ") })}
                </p>
              )}
              <Callout kind="info" icon="smartphoneKey">
                {t("wl.stepUpNote")}
              </Callout>
            </>
          }
          onClose={close}
          onConfirm={async (reason) => {
            if (reason.length > REASON_MAX) return t("gm.commentMax", { n: REASON_MAX });
            const key = cmdKey.for(JSON.stringify(["refund", it.purchase_id, reason]));
            try {
              const r = await Game.refund(userId, it.purchase_id, reason, key);
              cmdKey.settle();
              toast(t("wl.refunded", { c: name, n: r.operations.length }), "ok", "game.purchase_refunded");
              changed();
              return null;
            } catch (e) {
              cmdKey.settle(e);
              return fail(e);
            }
          }}
        />
      );
    }
    return null;
  }
}

export function badgeName(t: (k: MessageKey, v?: Record<string, string | number>) => string, code: string): string {
  const m = /^(streak|skills|reviews|readings)_(\d+)$/.exec(code);
  if (m) return t(`gb.${m[1]}` as MessageKey, { n: Number(m[2]) });
  const k = `gb.${code}` as MessageKey;
  const s = t(k);
  return s === k ? code : s;
}

/* ---------------------------------------------------------------- ledger */

function Ledger({ userId, tick, onReverse, onRefund }: { userId: string; tick: number; onReverse: ((op: AdminLedgerOperation) => void) | null; onRefund: ((purchaseId: string, ops: AdminLedgerOperation[]) => void) | null }) {
  const { t, fmt } = useI18n();
  const amount = useAmount();
  const [cur, setCur] = useState<GameCurrency | "">("");
  const [rows, setRows] = useState<AdminLedgerOperation[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const req = useRef(0);
  const load = useCallback(
    async (more?: string | null) => {
      const id = ++req.current;
      try {
        const r = await Game.ledger(userId, cur, more ?? null);
        if (id !== req.current) return;
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        if (id === req.current) setError(e);
      }
    },
    [userId, cur],
  );
  useEffect(() => {
    void load();
  }, [load, tick]);
  // a purchase is cancelled by a refund only: one «Вернуть покупку» per purchase, on its first shown operation
  const anchors = refundAnchors(rows ?? []);
  return (
    <section className="panel" aria-labelledby="wl-led-h" data-testid="wl-ledger">
      <div className="panel-h">
        <h2 className="panel-t grow" id="wl-led-h">
          <Icon name="layers" /> {t("wl.ledger")}
        </h2>
        <Seg<GameCurrency | ""> label={t("wl.currency")} value={cur} onChange={setCur} testId="wl-led-cur" items={[{ v: "", label: t("common.all") }, ...CURRENCIES.map((c) => ({ v: c, label: t(`gm.cur.${c}` as MessageKey) }))]} />
      </div>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="tbl compact wl-tbl" data-testid="wl-led-rows">
            <caption className="sr-only">{t("wl.ledger")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("wl.col.when")}</th>
                <th scope="col" className="r">
                  {t("wl.col.amount")}
                </th>
                <th scope="col">{t("wl.col.op")}</th>
                <th scope="col">{t("wl.col.source")}</th>
                <th scope="col">{t("col.status")}</th>
                <th scope="col">{t("wl.col.actor")}</th>
                {onReverse && (
                  <th scope="col" className="r">
                    {t("ct.col.actions")}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((op) => {
                const who = actorOf(op.actor);
                return (
                  <tr key={op.op_id} className={cx(op.status === "reversed" && "is-reversed")} data-testid={`wl-op-${op.op_id}`} data-reason={op.reason} data-status={op.status}>
                    <td className="small nowrap">
                      {fmt.dateTime(op.created_at)}
                      <span className="xs muted block">{t("wl.localDate", { d: op.local_date })}</span>
                    </td>
                    <td className={cx("r num b nowrap", op.amount > 0 ? "good-ink" : "bad-ink")} data-testid={`wl-op-amount-${op.op_id}`}>
                      {amount(op.currency, op.amount, true)}
                    </td>
                    <td className="small">
                      {t(`grsn.${op.reason}` as MessageKey)}
                      <span className="xs muted block">
                        {op.rules_version != null && t("wl.rulesV", { v: op.rules_version })}
                        {op.multiplier !== 1 && ` · ×${fmt.num(op.multiplier, op.multiplier % 1 ? 1 : 0)}`}
                        {op.capped && ` · ${t("wl.capped")}`}
                      </span>
                      {op.comment && <span className="xs block wrap-any" data-testid={`wl-op-comment-${op.op_id}`}>{t("mem.reasonX", { r: op.comment })}</span>}
                    </td>
                    <td className="mono xs">
                      {t(`wlsrc.${op.source.kind}` as MessageKey)}
                      <span className="block muted" title={op.source.ref}>
                        {shortId(op.source.ref, 8, 4)}
                      </span>
                    </td>
                    <td className="small">
                      <Pill tone={op.status === "reversed" ? "neutral" : "good"}>{t(`wlst.${op.status}` as MessageKey)}</Pill>
                      {op.reversed_by && <span className="xs muted block">{t("wl.reversedBy", { id: shortId(op.reversed_by, 8, 4) })}</span>}
                      {op.reversal_of && <span className="xs muted block">{t("wl.reversalOf", { id: shortId(op.reversal_of, 8, 4) })}</span>}
                    </td>
                    <td className="small">
                      <span className="tag plain">{t(`wlact.${who.kind}` as MessageKey)}</span>
                      {who.id && <span className="mono xs muted block">{shortId(who.id, 8, 4)}</span>}
                    </td>
                    {onReverse && (
                      <td className="actions-cell">
                        {canReverse(op) && <Btn size="xs" kind="danger-ghost" icon="rollback" label={t("wl.reverse")} onClick={() => onReverse(op)} testId={`wl-reverse-${op.op_id}`} />}
                        {onRefund && anchors.has(op.op_id) && <Btn size="xs" kind="danger-ghost" icon="rollback" label={t("wl.refund")} onClick={() => {
                              const pid = anchors.get(op.op_id)!;
                              onRefund(pid, (rows ?? []).filter((r) => purchaseOf(r) === pid));
                            }} testId={`wl-refund-op-${op.op_id}`} />}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="inbox" title={t("wl.noOps")} text={cur ? t("common.changeFilters") : t("wl.noOpsM")} testId="wl-led-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="wl-led-more" />
        </div>
      )}
      <div className="panel-f xs">
        <Icon name="lock" /> {t("wl.ledgerNote")}
      </div>
    </section>
  );
}

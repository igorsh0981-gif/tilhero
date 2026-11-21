import type { DuelReview, DuelView, MemberId } from "@tilhero/contracts/bff";
import { useEffect, useRef, useState } from "react";
import { newIdempotencyKey } from "../../api/client";
import { ApiError } from "../../api/errors";
import { duelPhase, memberLabel, scoreText, type DuelPhase } from "../../domain/social";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Pill, Seg, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { ComplaintSheet, MemberAvatar, PickMemberSheet, SocialError, useSocialAction } from "./parts";

/**
 * Duels (APP-SOC-07, AT-75): an asynchronous challenge to a friend (14+) or a member of the family (children — only the
 * family); the opponent accepts or declines in 24 h; both play the same 10 closed tasks in the lesson player (kind duel —
 * no hints, no AI, the time does not count) within 48 h; the result by the server's key — a win, a draw, a technical win;
 * XP only, no stakes; the review of my own answers after the end (never the opponent's).
 */

/** Challenge a member: one Idempotency-Key per member until the answer comes (a retry is the same challenge); an
 *  existing duel with them (409 DUEL_EXISTS {duel_id}) opens that duel. */
export function useChallenge() {
  const { bff, nav } = useApp();
  const { t } = useI18n();
  const keys = useRef(new Map<string, string>());
  return useSocialAction(async (memberId: MemberId): Promise<DuelView | null> => {
    let key = keys.current.get(memberId);
    if (!key) {
      key = newIdempotencyKey();
      keys.current.set(memberId, key);
    }
    try {
      const d = await bff.challenge({ opponent_member_id: memberId }, key);
      keys.current.delete(memberId);
      showToast(t("du.challengedToast"));
      nav.push({ name: "duel", id: d.duel_id });
      return d;
    } catch (e) {
      // a lost answer keeps the key (the retry is the same challenge); a business answer frees it
      if (!(e instanceof ApiError && (e.status === 0 || e.status >= 500))) keys.current.delete(memberId);
      if (e instanceof ApiError && e.code === "DUEL_EXISTS" && typeof e.details.duel_id === "string") {
        nav.push({ name: "duel", id: e.details.duel_id });
        return null;
      }
      throw e;
    }
  });
}

/** The outcome of a finished duel: a child who did not play in time (a technical loss) never reads «Хорошая игра!». */
function outcomeText(r: NonNullable<DuelView["result"]>, kid: boolean, t: (k: MessageKey) => string): string {
  if (kid && r.technical && r.outcome === "loss") return t("du.res.techLossKid");
  return t(`du.res.${r.outcome}${kid ? "Kid" : ""}` as MessageKey);
}

/** The line of a duel in the list and on its card. */
function duelLine(d: DuelView, phase: DuelPhase, t: (k: MessageKey, v?: Record<string, string | number>) => string, dateTime: (s: string) => string, kid: boolean): string {
  switch (phase) {
    case "incoming":
      return t(kid ? "du.st.incomingKid" : "du.st.incoming", { date: dateTime(d.accept_deadline) });
    case "awaiting":
      return t("du.st.awaiting", { date: dateTime(d.accept_deadline) });
    case "play":
      return t("du.st.play", { date: d.play_deadline ? dateTime(d.play_deadline) : "—" });
    case "waiting":
      return kid ? t("du.st.waitingKid") : t("du.st.waiting", { date: d.play_deadline ? dateTime(d.play_deadline) : "—" });
    case "result":
      return d.result ? outcomeText(d.result, kid, t) : "";
    default:
      return t(`du.st.${phase}` as MessageKey);
  }
}

export function DuelsScreen() {
  const { bff, nav, session } = useApp();
  const { t, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const [tab, setTab] = useState<"active" | "finished">("active");
  const list = useLoad(() => bff.duels(tab), [tab, session.learner.learner_id]);
  const [pick, setPick] = useState(false);
  const challenge = useChallenge();
  const items = list.data?.items ?? [];
  return (
    <>
      <Bar title={t("du.title")} onBack={nav.back} />
      <main className="scroll" data-testid="duels">
        <div className="pad stack">
          <div className="card notice" role="note">
            <Icon name="target" size={20} />
            <p className="sub ink">{kid ? t("du.rulesKid") : t("du.rules")}</p>
          </div>
          <Btn onClick={() => setPick(true)} data-testid="duel-new">
            <Icon name="plus" size={18} />
            {t("du.new")}
          </Btn>
          <ErrorLine text={challenge.error} />
          <Seg label={t("du.title")} value={tab} onChange={setTab} options={[{ value: "active", label: t("du.active") }, { value: "finished", label: t("du.finished") }]} testId="duel-tabs" />
          {!list.data ? (
            list.loading ? <Skeleton lines={2} /> : <SocialError error={list.error} errorObj={list.errorObj} onRetry={() => void list.reload()} service="gamification" />
          ) : items.length ? (
            <ul className="list" data-testid="duel-list">
              {items.map((d) => {
                const phase = duelPhase(d);
                return (
                  <li key={d.duel_id}>
                    <button type="button" className="row" onClick={() => nav.push({ name: "duel", id: d.duel_id })} data-testid="duel-row" data-phase={phase}>
                      <MemberAvatar hero={d.opponent.hero} />
                      <span className="t">
                        <b>{memberLabel(d.opponent.nickname, t, kid ? "family" : "friend")}</b>
                        <span>{duelLine(d, phase, t, fmt.dateTime, kid)}</span>
                      </span>
                      {phase === "incoming" || phase === "play" ? <Pill>{t("c.new")}</Pill> : null}
                      <Icon name="chevron" size={18} stroke={2} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="sub" data-testid="duel-empty">{tab === "active" ? t("du.empty") : t("du.emptyFinished")}</p>
          )}
          <p className="sub small">{t("du.learning")}</p>
        </div>
      </main>
      {pick ? (
        <PickMemberSheet
          title={kid ? t("du.pickTitleKid") : t("du.pickTitle")}
          onClose={() => setPick(false)}
          onPick={(m) => {
            setPick(false);
            void challenge.run(m.member_id);
          }}
          testId="duel-pick"
        />
      ) : null}
    </>
  );
}

/** The card of a duel: answer a challenge, play, wait, the result and the way to the review. */
export function DuelScreen({ id }: { id: string }) {
  const { bff, nav, session } = useApp();
  const { t, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const res = useLoad(() => bff.duel(id), [id]);
  const d = res.data;
  const phase = d ? duelPhase(d) : null;
  const [complain, setComplain] = useState(false);
  const playKey = useRef<string | null>(null);
  const respond = useSocialAction(async (a: "accept" | "decline") => {
    try {
      const n = await bff.duelAction(id, a);
      res.setData(n);
      showToast(a === "accept" ? t("du.acceptedToast") : t("du.declinedToast"));
    } catch (e) {
      // DUEL_STATE: the duel moved on (expired, cancelled) — show it as it is
      if (e instanceof ApiError && e.code === "DUEL_STATE") void res.reload();
      throw e;
    }
  });
  const play = useSocialAction(async () => {
    playKey.current ??= newIdempotencyKey();
    const s = await bff.startDuelSession(id, playKey.current);
    nav.push({ name: "player", sessionId: s.session_id, duelId: id });
  });
  // waiting for an answer or for the opponent: re-read now and then (the screen also has «Обновить»)
  const waiting = phase === "awaiting" || phase === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void res.reload(), 15_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, id]);

  // a child plays only with the family: an opponent without a nickname is «Участник семьи», not «Друг»
  const name = d ? memberLabel(d.opponent.nickname, t, kid ? "family" : "friend") : "";
  return (
    <>
      <Bar title={t("du.title")} onBack={nav.back} />
      <main className="scroll" data-testid="duel" data-phase={phase ?? undefined}>
        {!d ? (
          res.loading ? <div className="pad"><Skeleton lines={3} /></div> : <SocialError error={res.error} errorObj={res.errorObj} onRetry={() => void res.reload()} service="gamification" />
        ) : (
          <div className="pad stack">
            <div className="card hrow" data-testid="duel-opponent">
              <MemberAvatar hero={d.opponent.hero} />
              <div className="grow">
                <b>{t(kid ? "du.opponentKid" : "du.opponent", { name })}</b>
                <p className="sub small" data-testid="duel-line">{duelLine(d, phase!, t, fmt.dateTime, kid)}</p>
              </div>
            </div>

            {phase === "incoming" ? (
              <section className="card stack tight" aria-labelledby="duel-in" data-testid="duel-incoming">
                <h2 className="h3" id="duel-in">{t(kid ? "du.incomingTitleKid" : "du.incomingTitle", { name })}</h2>
                <p className="sub">{kid ? t("du.rulesKid") : t("du.rules")}</p>
                <div className="duo">
                  <Btn variant="secondary" busy={respond.busy} onClick={() => void respond.run("decline")} data-testid="duel-decline">{t("du.decline")}</Btn>
                  <Btn busy={respond.busy} onClick={() => void respond.run("accept")} data-testid="duel-accept">{t("du.accept")}</Btn>
                </div>
                <ErrorLine text={respond.error} />
              </section>
            ) : null}

            {phase === "awaiting" ? (
              <section className="card stack tight" data-testid="duel-awaiting">
                <h2 className="h3">{t("du.awaitingTitle")}</h2>
                <p className="sub">{t("du.st.awaiting", { date: fmt.dateTime(d.accept_deadline) })}</p>
                <Btn variant="secondary" onClick={() => void res.reload()} data-testid="duel-refresh">{t("soc.refresh")}</Btn>
              </section>
            ) : null}

            {phase === "play" ? (
              <section className="card stack tight" data-testid="duel-play">
                <p className="sub ink">{kid ? t("du.rulesKid") : t("du.rules")}</p>
                {d.play_deadline ? <p className="sub small">{t("du.st.play", { date: fmt.dateTime(d.play_deadline) })}</p> : null}
                <Btn busy={play.busy} onClick={() => void play.run()} data-testid="duel-start">
                  <Icon name="play" size={18} />
                  {d.my_session ? t("du.continue") : t("du.play")}
                </Btn>
                <ErrorLine text={play.error} />
              </section>
            ) : null}

            {phase === "waiting" ? (
              <section className="card stack tight" data-testid="duel-waiting">
                <h2 className="h3">{kid ? t("du.waitTitleKid") : t("du.waitTitle")}</h2>
                <p className="sub">{kid ? t("du.waitTextKid") : t("du.waitText", { date: d.play_deadline ? fmt.dateTime(d.play_deadline) : "—" })}</p>
                <Btn variant="secondary" onClick={() => void res.reload()} data-testid="duel-refresh">{t("soc.refresh")}</Btn>
              </section>
            ) : null}

            {phase === "result" && d.result ? (
              <section className={cx("card stack tight duel-res", d.result.outcome)} aria-labelledby="duel-res" data-testid="duel-result" data-outcome={d.result.outcome}>
                <h2 className="h2" id="duel-res" data-testid="duel-outcome">
                  <Icon name={d.result.outcome === "win" ? "trophy" : d.result.outcome === "draw" ? "star" : "medal"} size={24} />
                  {outcomeText(d.result, kid, t)}
                </h2>
                {d.result.technical ? (
                  <p className="sub small" data-testid="duel-technical">
                    {d.result.outcome === "loss" ? t(kid ? "du.technicalLossKid" : "du.technicalLoss") : t(kid ? "du.technicalKid" : "du.technical")}
                  </p>
                ) : null}
                <dl className="duel-scores">
                  <div data-testid="duel-my-score">
                    <dt>{kid ? t("soc.youKid") : t("soc.you")}</dt>
                    <dd>{scoreText(d.result.my_score, t)}</dd>
                  </div>
                  <div data-testid="duel-their-score">
                    <dt>{name}</dt>
                    <dd>{scoreText(d.result.opponent_score, t)}</dd>
                  </div>
                </dl>
                <p className="sub ink ic-line" data-testid="duel-xp"><Icon name="spark" size={16} /> {d.result.xp > 0 ? t("du.xp", { n: d.result.xp }) : t("du.xpZero")}
                </p>
                {d.result.version > 1 ? <Pill tone="mute">{t("du.version")}</Pill> : null}
                {d.my_session ? (
                  <Btn variant="secondary" onClick={() => nav.push({ name: "duelReview", sessionId: d.my_session!.session_id, duelId: d.duel_id })} data-testid="duel-review">
                    <Icon name="list" size={18} />
                    {t("du.review")}
                  </Btn>
                ) : null}
              </section>
            ) : null}

            <p className="sub small">{t("du.learning")}</p>
            {!kid ? (
              <Btn variant="link" onClick={() => setComplain(true)} data-testid="duel-complain">
                <Icon name="flag" size={16} />
                {t("du.complain")}
              </Btn>
            ) : null}
          </div>
        )}
      </main>
      {complain && d ? (
        <ComplaintSheet member={{ member_id: d.opponent.member_id, label: name }} subject={{ kind: "duel", id: d.duel_id }} onClose={() => setComplain(false)} />
      ) : null}
    </>
  );
}

/** The review of a finished duel: my answers with the right ones; the opponent's answers are never shown. */
export function DuelReviewScreen({ sessionId }: { sessionId: string; duelId: string }) {
  const { bff, nav, session } = useApp();
  const { t } = useI18n();
  const kid = session.learner.kind === "child";
  const res = useLoad<DuelReview>(() => bff.duelReview(sessionId), [sessionId]);
  const r = res.data;
  return (
    <>
      <Bar title={t("du.reviewTitle")} onBack={nav.back} />
      <main className="scroll" data-testid="duel-review-screen">
        {!r ? (
          res.loading ? <div className="pad"><Skeleton lines={3} /></div> : <SocialError error={res.error} errorObj={res.errorObj} onRetry={() => void res.reload()} service="lessons" />
        ) : (
          <div className="pad stack">
            <p className="h3" data-testid="duel-review-score">{t("du.reviewScore", { n: r.score.correct, m: r.score.total })}</p>
            <p className="sub small">{t(kid ? "du.reviewNoteKid" : "du.reviewNote")}</p>
            <ol className="stack tight duel-items">
              {r.items.map((it, i) => (
                <li key={it.item_id} className={cx("card stack tight", !it.correct && "warn")} data-testid="duel-item" data-correct={it.correct}>
                  <span className="cap">
                    {i + 1}. <Icon name={it.correct ? "check" : "info"} size={14} /> {it.correct ? t("du.correct") : t("du.wrong")}
                  </span>
                  <b lang="en">{it.prompt_en}</b>
                  <span className="sub ink">{t(kid ? "du.yourAnswerKid" : "du.yourAnswer", { a: it.your_answer ?? t("du.noAnswer") })}</span>
                  {!it.correct ? <span className="sub ink" data-testid="duel-item-right">{t("du.rightAnswer", { a: it.correct_answer })}</span> : null}
                </li>
              ))}
            </ol>
          </div>
        )}
      </main>
    </>
  );
}

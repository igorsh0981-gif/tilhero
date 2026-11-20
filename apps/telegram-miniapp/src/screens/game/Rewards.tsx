import type { GameSummary, SessionRewards } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { celebrationMode, hasRewards, pollRewards, prefersReducedMotion, questText, rewardTotals, withTimeout } from "../../domain/game";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { haptic } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, cx, Pill } from "../../ui/kit";
import { HeroImg } from "./parts";

type Phase =
  | { kind: "loading" }
  | { kind: "pending" }
  | { kind: "ready"; r: SessionRewards; mode: "full" | "quiet" }
  | { kind: "late" }
  | { kind: "hidden" };

const CONFETTI = 14;
/** how long the card waits for the summary (celebrations, the hero) before it shows the rewards quietly */
const SUMMARY_WAIT_MS = 1500;

/**
 * The rewards of a finished session (lesson, scenario, media, reading, «Повторение дня»): GET /v1/game/rewards
 * ?source_session_id= — credited by events, so `pending` is polled every 1.5 s (at most 8 more times), then «позже».
 * Shows XP, tils, a new level, new badges, the hero's growth (with its new art), quests of the day done, a cut by the
 * daily limit and the multiplier of a week event. `celebrations: quiet` (children by default) and the device's reduced
 * motion — no animation and no confetti. No rewards (`none`) or no game (GAME_UNAVAILABLE) — nothing at all, and no
 * other request. Only for a session just finished in the player (the summary screen passes `fresh`): the summaries of
 * past sessions from the history show no rewards and never poll.
 */
export function SessionRewardsCard({ sessionId, inset = false }: { sessionId: string; /** already inside a padded column */ inset?: boolean }) {
  const { bff, nav, session } = useApp();
  const { t, tp, l } = useI18n();
  const kid = session.learner.kind === "child";
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [hero, setHero] = useState<GameSummary["hero"]>(null);

  useEffect(() => {
    let alive = true;
    const stop = pollRewards(() => bff.gameRewards(sessionId), {
      update: (r) => {
        if (alive && r.status === "pending") setPhase({ kind: "pending" });
      },
      end: (how, last) => {
        if (!alive) return;
        if (how === "late") {
          setPhase({ kind: "late" });
          return;
        }
        if (how !== "ready" || !last || !hasRewards(last)) {
          setPhase({ kind: "hidden" });
          return;
        }
        // there are rewards: the summary tells the learner's celebrations (and the hero's new art) — asked only now; slow
        // or failed — quiet for a child, full otherwise (celebrationMode), never a wait without end
        void withTimeout(bff.gameSummary(true), SUMMARY_WAIT_MS)
          .catch(() => null)
          .then((s) => {
            if (!alive) return;
            if (s) setHero(s.hero);
            const mode = celebrationMode(s?.settings ?? null, kid, prefersReducedMotion());
            if (mode === "full") haptic.notify("success");
            setPhase({ kind: "ready", r: last, mode });
          });
      },
    });
    return () => {
      alive = false;
      stop();
    };
  }, [bff, sessionId, kid]);

  let content = null;
  if (phase.kind === "loading" || phase.kind === "pending") {
    content = (
      <p className="sub small rw-line" data-testid="rw-pending">
        <span className="spin" aria-hidden="true" />
        {t("game.rw.pending")}
      </p>
    );
  } else if (phase.kind === "late") {
    content = (
      <div className="card stack tight" data-testid="rw-late">
        <p className="sub ink">{t("game.rw.late")}</p>
        <Btn variant="link" onClick={() => nav.push({ name: "gameHistory" })}>
          <Icon name="list" size={18} />
          {t("game.historyLong")}
        </Btn>
      </div>
    );
  } else if (phase.kind === "ready") {
    const r = phase.r;
    const sum = rewardTotals(r);
    const full = phase.mode === "full";
    content = (
      <section className={cx("card lift rw-card", full && "celebrate")} aria-labelledby="rw-title" data-testid="rw-card" data-celebration={phase.mode}>
        {full ? (
          <span className="rw-confetti" aria-hidden="true">
            {Array.from({ length: CONFETTI }, (_, i) => (
              <i key={i} style={{ left: `${4 + i * 7}%`, animationDelay: `${(i % 5) * 90}ms` }} />
            ))}
          </span>
        ) : null}
        <h2 className="h3" id="rw-title">{kid ? t("game.rw.titleKid") : t("game.rw.title")}</h2>
        {sum.xp > 0 || sum.til > 0 || sum.freeze > 0 ? (
          <div className="rw-sum" data-testid="rw-sum">
            {sum.xp > 0 ? (
              <span className="stt" data-testid="rw-xp"><Icon name="star" size={16} />+{sum.xp} XP</span>
            ) : null}
            {sum.til > 0 ? (
              <span className="stt" data-testid="rw-til"><span className="coin"><Icon name="coin" size={16} /></span>+{sum.til} {tp("game.tilsWord", sum.til)}</span>
            ) : null}
            {sum.freeze > 0 ? (
              <span className="stt" data-testid="rw-freeze"><Icon name="snow" size={16} />+{sum.freeze} {tp("game.freezeWord", sum.freeze)}</span>
            ) : null}
            {sum.multiplier > 1 ? <Pill>{t("game.rw.multiplier", { f: sum.multiplier })}</Pill> : null}
          </div>
        ) : null}
        {r.level_up ? (
          <p className="rw-line h3" data-testid="rw-level"><Icon name="trophy" size={20} />{t("game.rw.level", { n: r.level_up.to })}</p>
        ) : null}
        {r.hero_stage_up ? (
          <div className="rw-hero" data-testid="rw-hero">
            {hero ? <HeroImg image={hero.image} code={hero.code} stage={hero.stage} alt={t("game.hero.alt", { name: l(hero.name), stage: l(hero.stage_name) })} /> : null}
            <p className="h3">
              {hero && hero.stage === r.hero_stage_up.to ? t("game.rw.stage", { hero: l(hero.name), stage: l(hero.stage_name) }) : t("game.rw.stageN", { n: r.hero_stage_up.to })}
            </p>
          </div>
        ) : null}
        {r.badges.length ? (
          <ul className="stack tight" data-testid="rw-badges">
            {r.badges.map((b) => (
              <li key={b.code} className="rw-line sub ink"><Icon name="medal" size={18} />{t("game.rw.badge", { title: l(b.title) })}</li>
            ))}
          </ul>
        ) : null}
        {r.quests_completed.length ? (
          <ul className="stack tight" data-testid="rw-quests">
            {r.quests_completed.map((q) => (
              <li key={q.slot} className="rw-line sub ink"><Icon name="gift" size={18} />{t("game.rw.quest", { quest: questText(q, t, tp, kid) })}</li>
            ))}
          </ul>
        ) : null}
        {sum.capped ? (
          <p className="sub small notice" role="note" data-testid="rw-capped"><Icon name="info" size={16} />{kid ? t("game.rw.cappedKid") : t("game.rw.capped")}</p>
        ) : null}
        <Btn variant="link" onClick={() => nav.push({ name: "gameHistory" })} data-testid="rw-history">
          <Icon name="list" size={18} />
          {t("game.historyLong")}
        </Btn>
      </section>
    );
  }
  if (phase.kind === "hidden") return null;
  return (
    <div className={inset ? undefined : "pad"} aria-live="polite" data-testid="rw">
      {content}
    </div>
  );
}

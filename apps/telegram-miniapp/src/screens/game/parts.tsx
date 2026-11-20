import type { DailyQuests, GameImage, GameSummary, HeroStage, Quest } from "@tilhero/contracts/bff";
import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../../api/errors";
import { assetSrc, heroFallback, levelProgress, questPct, questText } from "../../domain/game";
import { env } from "../../env";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { Icon } from "../../ui/Icon";
import { Btn, cx } from "../../ui/kit";

/* Building blocks of the game screens (sprint 6). Every number comes from the server (GameSummary, the ledger). */

/**
 * The art of a hero stage: the catalogue image (GET /v1/game/assets/{id}/{sha256} — replaced in the admin without a
 * release); when it cannot be loaded (no network, the game is down, an old BFF) — the bundled art of public/heroes.
 */
export function HeroImg({ image, code, stage, alt, className }: { image: GameImage | null | undefined; code: string; stage: HeroStage; alt: string; className?: string }) {
  const remote = assetSrc(image, env.bffUrl);
  const fallback = heroFallback(code, stage);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [remote]);
  const src = remote && !failed ? remote : fallback;
  return (
    <img
      className={cx("hero", className)}
      src={src}
      alt={alt}
      draggable={false}
      decoding="async"
      width={image?.width || undefined}
      height={image?.height || undefined}
      onError={() => setFailed(true)}
      data-src-kind={src === fallback ? "static" : "catalogue"}
    />
  );
}

/**
 * A decorative image of the shop or of a badge (GameImage): the catalogue picture, or — no picture, not a picture of the
 * game, or it cannot be loaded — the fallback (an icon).
 */
export function AssetImg({ image, fallback, testId }: { image: GameImage | null | undefined; fallback: ReactNode; testId?: string }) {
  const src = assetSrc(image, env.bffUrl);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <>{fallback}</>;
  return <img src={src} alt="" draggable={false} decoding="async" onError={() => setFailed(true)} data-testid={testId} />;
}

/** «+10 XP · +5 тилов» (a zero part is left out). */
export function rewardLine(r: { xp: number; til: number }, tp: (k: "game.tilsWord", n: number) => string): string {
  const parts: string[] = [];
  if (r.xp > 0) parts.push(`+${r.xp} XP`);
  if (r.til > 0) parts.push(`+${r.til} ${tp("game.tilsWord", r.til)}`);
  return parts.join(" · ");
}

export function LevelBar({ s }: { s: Pick<GameSummary, "level" | "xp_total" | "xp_level_start" | "xp_next_level"> }) {
  const { t } = useI18n();
  const p = levelProgress(s);
  const text = p.next == null ? t("game.xpMax", { xp: s.xp_total }) : t("game.xpToNext", { cur: p.inLevel, span: p.span, next: p.next, left: p.toNext ?? 0 });
  return (
    <div className="lvl" data-testid="game-level">
      <div className="hrow between">
        <b className="h3" data-testid="game-level-n">{t("game.level", { n: p.level })}</b>
      </div>
      <div
        className="prog"
        role="progressbar"
        aria-label={t("game.levelBar", { n: p.level })}
        aria-valuemin={0}
        aria-valuemax={p.span || 100}
        aria-valuenow={p.span ? p.inLevel : 100}
        aria-valuetext={text}
        data-testid="game-xp-bar"
      >
        <div style={{ width: `${p.pct}%` }} />
      </div>
      <p className="sub small" data-testid="game-xp-text">{text}</p>
    </div>
  );
}

export function TilsChip({ n }: { n: number }) {
  const { t, tp } = useI18n();
  return (
    <span className="stt" aria-label={t("game.tilsAria", { n })} data-testid="game-tils" role="img">
      <span className="coin"><Icon name="coin" size={18} /></span>
      {t("game.tilsN", { n, w: tp("game.tilsWord", n) })}
    </span>
  );
}

export function FreezeChip({ n, max, testId = "game-freezes" }: { n: number; max: number; testId?: string }) {
  const { t } = useI18n();
  return (
    <span className="stt" aria-label={t("game.freezeAria", { n, max })} data-testid={testId} role="img">
      <span className="snow"><Icon name="snow" size={18} /></span>
      {t("game.freezeN", { n, max })}
    </span>
  );
}

/** Quests of the day: the task in words, «N из M» next to the bar, the reward; a done one — a check and «выполнено». */
export function QuestList({ quests, kid }: { quests: DailyQuests; kid: boolean }) {
  const { t, tp } = useI18n();
  if (quests.hidden || !quests.items.length) return null;
  const bonus = rewardLine(quests.all_done_bonus, tp);
  return (
    <section className="card stack tight" aria-labelledby="quests-title" data-testid="game-quests">
      <h2 className="h3" id="quests-title">{t("game.quests.title")}</h2>
      <ul className="quests" aria-labelledby="quests-title">
        {quests.items.map((q) => (
          <QuestRow key={q.slot} q={q} kid={kid} />
        ))}
      </ul>
      {bonus ? (
        <p className="sub small q-bonus" data-testid="game-quests-bonus">
          <Icon name="gift" size={18} />
          {quests.bonus_received ? t("game.quests.bonusDone") : t("game.quests.bonus", { reward: bonus })}
        </p>
      ) : null}
      <p className="sub small">{kid ? t("game.quests.noteKid") : t("game.quests.note")}</p>
    </section>
  );
}

function QuestRow({ q, kid }: { q: Quest; kid: boolean }) {
  const { t, tp } = useI18n();
  const done = q.status === "completed";
  const text = questText(q, t, tp, kid);
  const n = Math.min(q.progress, q.target);
  return (
    <li className={cx("q-row", done && "done")} data-testid={`quest-${q.code}`} data-status={q.status}>
      <div className="q-head">
        <span className="q-mk" aria-hidden="true">{done ? <Icon name="check" size={14} stroke={3} /> : null}</span>
        <span className="t">{text}</span>
      </div>
      <div
        className={cx("prog", done && "ok")}
        role="progressbar"
        aria-label={text}
        aria-valuemin={0}
        aria-valuemax={q.target}
        aria-valuenow={n}
        aria-valuetext={t("game.quests.aria", { quest: text, n, m: q.target })}
      >
        <div style={{ width: `${questPct(q)}%` }} />
      </div>
      <div className="q-meta">
        <span data-testid={`quest-${q.code}-progress`}>{done ? `✓ ${t("game.quests.done")}` : t("game.quests.progress", { n, m: q.target })}</span>
        <span>{rewardLine(q.reward, tp)}</span>
      </div>
    </li>
  );
}

/** A game screen whose data did not come: GAME_UNAVAILABLE reads «учёба работает как обычно», plus «Повторить». */
export function GameError({ error, errorObj, onRetry }: { error: string | null; errorObj: unknown; onRetry: () => void }) {
  const { session } = useApp();
  const { t } = useI18n();
  const kid = session.learner.kind === "child";
  const down = errorObj instanceof ApiError && (errorObj.code === "GAME_UNAVAILABLE" || errorObj.status >= 500);
  return (
    <div className="pad stack tight" data-testid="game-error">
      <div className="card warn notice" role="status">
        <Icon name="info" size={20} />
        <p className="sub ink">{down ? (kid ? t("game.unavailableKid") : t("game.unavailable")) : error}</p>
      </div>
      <Btn variant="secondary" onClick={onRetry}>{t("c.retry")}</Btn>
    </div>
  );
}

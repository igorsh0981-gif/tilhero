import type { BadgeView } from "@tilhero/contracts/bff";
import { useState } from "react";
import { badgePct, sortBadges, type BadgesResponse } from "../../domain/game";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, cx, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";
import { AssetImg, GameError } from "./parts";

/**
 * Badges (AT-70, APP-PROG-03): earned ones with the date and their basis («Основание» opens what it was given for —
 * the counter at the moment of the award), open ones with the progress «N из M». Badges are for learning results only:
 * XP and tils never replace the criteria of mastery.
 */
export function BadgesScreen() {
  const { bff, nav, session } = useApp();
  const { t } = useI18n();
  const res = useLoad<BadgesResponse>(() => bff.gameBadges(), [session.learner.learner_id]);
  const items = res.data ? sortBadges(res.data.items) : [];
  const earned = items.filter((b) => b.earned_at);
  const open = items.filter((b) => !b.earned_at);
  return (
    <>
      <Bar title={t("game.badges.title")} onBack={nav.back} />
      <main className="scroll" data-testid="badges">
        {!res.data ? (
          res.loading ? (
            <div className="pad"><Skeleton lines={4} /></div>
          ) : (
            <GameError error={res.error} errorObj={res.errorObj} onRetry={() => void res.reload()} />
          )
        ) : (
          <div className="stack loose">
            <div className="pad">
              <div className="card warn notice" role="note">
                <Icon name="shield" size={20} />
                <p className="sub ink">{t("game.badges.note")}</p>
              </div>
            </div>
            {items.length === 0 ? (
              <div className="pad"><p className="sub">{t("game.badges.empty")}</p></div>
            ) : null}
            {earned.length ? (
              <section className="pad stack tight" aria-labelledby="badges-earned">
                <h2 className="sec" id="badges-earned">{t("game.badges.earnedSec")}</h2>
                <ul className="stack tight" data-testid="badges-earned">
                  {earned.map((b) => <BadgeRow key={b.code} b={b} />)}
                </ul>
              </section>
            ) : null}
            {open.length ? (
              <section className="pad stack tight" aria-labelledby="badges-open">
                <h2 className="sec" id="badges-open">{t("game.badges.openSec")}</h2>
                <ul className="stack tight" data-testid="badges-open">
                  {open.map((b) => <BadgeRow key={b.code} b={b} />)}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </main>
    </>
  );
}

function BadgeRow({ b }: { b: BadgeView }) {
  const { t, l, fmt } = useI18n();
  const [shown, setShown] = useState(false);
  const earned = !!b.earned_at;
  const basis = t(`game.badges.basis.${b.basis.metric}` as MessageKey, { value: b.basis.value, threshold: b.basis.threshold });
  const detailId = `badge-basis-${b.code}`;
  const progress = t("game.badges.progress", { value: Math.min(b.basis.value, b.basis.threshold), threshold: b.basis.threshold });
  return (
    <li className="card badge-row" data-testid={`badge-${b.code}`} data-earned={earned}>
      <span className={cx("badge-ic", !earned && "open")} aria-hidden="true">
        <AssetImg image={b.image} fallback={<Icon name={earned ? "medal" : "lock"} size={24} />} testId={`badge-${b.code}-img`} />
      </span>
      <div className="grow">
        <b>{l(b.title)}</b>
        <p className="sub small">{l(b.description)}</p>
        {earned ? (
          <>
            <p className="sub small ic-line" data-testid={`badge-${b.code}-date`}>
              <Icon name="check" size={14} stroke={3} />
              {t("game.badges.earned", { date: fmt.date(b.earned_at!) })}
            </p>
            <Btn variant="link" aria-expanded={shown} aria-controls={detailId} onClick={() => setShown((v) => !v)} data-testid={`badge-${b.code}-basis-btn`}>
              <Icon name="info" size={16} />
              {t("game.badges.basis")}
            </Btn>
            {shown ? (
              <p className="sub ink" id={detailId} data-testid={`badge-${b.code}-basis`}>{basis}</p>
            ) : null}
          </>
        ) : (
          <>
            <div
              className="prog"
              role="progressbar"
              aria-label={l(b.title)}
              aria-valuemin={0}
              aria-valuemax={b.basis.threshold}
              aria-valuenow={Math.min(b.basis.value, b.basis.threshold)}
              aria-valuetext={t("game.badges.progressAria", { title: l(b.title), value: Math.min(b.basis.value, b.basis.threshold), threshold: b.basis.threshold })}
            >
              <div style={{ width: `${badgePct(b)}%` }} />
            </div>
            <p className="sub small" data-testid={`badge-${b.code}-progress`}>{progress}</p>
          </>
        )}
      </div>
    </li>
  );
}

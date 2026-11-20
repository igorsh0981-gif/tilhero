import type { GameSummary } from "@tilhero/contracts/bff";
import { themeVars } from "../../domain/game";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { Icon } from "../../ui/Icon";
import { Btn, cx, HERO, Hero, Margin } from "../../ui/kit";
import { FreezeChip, HeroImg, LevelBar, QuestList, TilsChip } from "./parts";

/**
 * The game block of Home (APP-PROG-01): the hero with the art of its stage and «за что растёт», the level with the XP
 * bar, tils, freezes of the streak, events of the week, links to the shop, badges and the history; then the quests of
 * the day. No hero yet — an invitation to choose one. The summary failed (503 GAME_UNAVAILABLE…) — nothing at all:
 * learning goes on without the game. The cosmetics bought in the shop (background, hero frame) colour it with tokens.
 */
export function GameBlock({ s }: { s: GameSummary | null }) {
  const { nav, session } = useApp();
  const { t, tp, l, fmt } = useI18n();
  if (!s) return null;
  const kid = session.learner.kind === "child";
  const bg = s.equipment.background;
  const frame = s.equipment.frame;
  const h = s.hero;
  return (
    <>
      <Margin note={t("game.note")} tone="b">
        <section className="card k game-card" style={themeVars(bg?.theme)} aria-labelledby="game-title" data-testid="game-card" data-background={bg?.code ?? undefined}>
          {h ? (
            <div className="game-top" data-testid="game-hero">
              <div className={cx("game-hero", frame && "framed")} style={frame ? themeVars(frame.theme) : undefined} data-frame={frame?.code ?? undefined}>
                <HeroImg image={h.image} code={h.code} stage={h.stage} alt={t("game.hero.alt", { name: l(h.name), stage: l(h.stage_name) })} />
              </div>
              <div className="grow">
                <span className="cap">{kid ? t("game.heroOfKid") : t("game.heroOf")}</span>
                <h2 className="h3" id="game-title" data-testid="game-hero-name">
                  {l(h.name)} · {t("game.stageName", { stage: l(h.stage_name) })}
                </h2>
                <p className="sub small" data-testid="game-stage">{t("game.stageOf", { n: h.stage })}</p>
                <p className="sub small" data-testid="game-next-stage">
                  {h.next_stage_at == null ? t("game.lastStage") : t("game.toNextStage", { n: h.next_stage_at, skills: tp("game.confirmedSkillsWord", h.next_stage_at) })}
                </p>
                <Btn variant="link" onClick={() => nav.push({ name: "heroes" })} data-testid="game-change-hero">
                  {t("game.change")}
                </Btn>
              </div>
            </div>
          ) : (
            <div className="game-invite" data-testid="game-invite">
              <Hero src={kid ? HERO.myatikEgg : HERO.volt} alt="" />
              <div className="grow stack tight">
                <h2 className="h3" id="game-title">{kid ? t("game.invite.titleKid") : t("game.invite.title")}</h2>
                <p className="sub small">{kid ? t("game.invite.textKid") : t("game.invite.text")}</p>
                <Btn onClick={() => nav.push({ name: "heroes" })} data-testid="game-choose-hero">
                  <Icon name="hero" size={18} />
                  {t("game.invite.go")}
                </Btn>
              </div>
            </div>
          )}
          <p className="sub small">{t("game.growsFor")}</p>
          <LevelBar s={s} />
          <div className="game-stats">
            <TilsChip n={s.til_balance} />
            <FreezeChip n={s.freeze_stock} max={s.freeze_max} />
          </div>
          {s.events.length ? (
            <ul className="game-events" data-testid="game-events">
              {s.events.map((e) => (
                <li key={e.event_id} className="sub small ic-line">
                  <Icon name="spark" size={18} />
                  <span><b>{t("game.event", { title: l(e.title), date: fmt.date(e.ends_at) })}</b> {l(e.description)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <nav className="game-links" aria-label={t("game.cap")}>
            <button type="button" className="game-link" onClick={() => nav.push({ name: "shop" })} data-testid="game-shop">
              <Icon name="bag" size={18} />
              {t("game.shop")}
            </button>
            <button type="button" className="game-link" onClick={() => nav.push({ name: "badges" })} data-testid="game-badges">
              <Icon name="medal" size={18} />
              {t("game.badges")}
            </button>
            <button type="button" className="game-link" onClick={() => nav.push({ name: "gameHistory" })} data-testid="game-history">
              <Icon name="list" size={18} />
              {t("game.history")}
            </button>
          </nav>
        </section>
      </Margin>
      {!s.quests.hidden && s.quests.items.length ? (
        <Margin>
          <QuestList quests={s.quests} kid={kid} />
        </Margin>
      ) : null}
    </>
  );
}

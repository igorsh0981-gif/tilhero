import { flag } from "../../config/experience";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { Icon } from "../../ui/Icon";
import { Margin } from "../../ui/kit";

/**
 * Home: «Учиться вместе» (a child — «Моя семья») — the way to friends, the league of the week, duels and the pair lesson.
 * No requests behind it: a failure of the social domains never touches Home. The flag `social` of Remote Experience
 * Config hides it; without the game (flag `game`) the league and duels are not offered.
 */
export function SocialCard() {
  const { nav, session, config } = useApp();
  const { t } = useI18n();
  if (!flag(config, "social")) return null;
  const kid = session.learner.kind === "child";
  const gameOn = flag(config, "game");
  return (
    <Margin note={kid ? "♥" : "2+"} tone="b">
      <section className="card stack tight soc-card" aria-labelledby="soc-card-t" data-testid="social-card">
        <h2 className="h3" id="soc-card-t">{kid ? t("soc.card.titleKid") : t("soc.card.title")}</h2>
        <p className="sub small">{kid ? t("soc.card.textKid") : t("soc.card.text")}</p>
        <nav className="game-links soc-links" aria-label={kid ? t("soc.card.titleKid") : t("soc.card.title")}>
          <button type="button" className="game-link" onClick={() => nav.push({ name: "friends" })} data-testid="soc-friends">
            <Icon name="users" size={18} />
            {kid ? t("soc.link.family") : t("soc.link.friends")}
          </button>
          {gameOn ? (
            <button type="button" className="game-link" onClick={() => nav.push({ name: "leagues" })} data-testid="soc-leagues">
              <Icon name="trophy" size={18} />
              {t("soc.link.leagues")}
            </button>
          ) : null}
          {gameOn ? (
            <button type="button" className="game-link" onClick={() => nav.push({ name: "duels" })} data-testid="soc-duels">
              <Icon name="target" size={18} />
              {t("soc.link.duels")}
            </button>
          ) : null}
          <button type="button" className="game-link" onClick={() => nav.push({ name: "pairRooms" })} data-testid="soc-pair">
            <Icon name="chat" size={18} />
            {t("soc.link.pair")}
          </button>
        </nav>
      </section>
    </Margin>
  );
}

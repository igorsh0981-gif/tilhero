import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { Btn, HERO, Hero, Pill } from "../../ui/kit";

/** Tabs whose content arrives in later sprints (lessons — 4, review — 5, progress — 3/6): an honest placeholder. */
export function Soon({ what }: { what: "lessons" | "review" | "progress" }) {
  const { nav } = useApp();
  const { t } = useI18n();
  const img = what === "lessons" ? HERO.nilu : what === "review" ? HERO.iskra : HERO.myatik;
  return (
    <main className="scroll soon" data-testid={`soon-${what}`}>
      <div className="pad stack loose center">
        <Hero src={img} alt="" />
        <div>
          <Pill tone="mute">{t("c.soon")}</Pill>
        </div>
        <h2 className="h1">{t(`soon.${what}.title` as MessageKey)}</h2>
        <p className="sub">{t(`soon.${what}.text` as MessageKey)}</p>
        <Btn variant="secondary" onClick={() => nav.goTab("home")}>{t("soon.home")}</Btn>
      </div>
    </main>
  );
}

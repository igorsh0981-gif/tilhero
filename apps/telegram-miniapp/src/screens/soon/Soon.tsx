import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Btn, HERO, Hero, NavRow, Pill } from "../../ui/kit";

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
      {what === "lessons" ? <LessonsMeanwhile /> : null}
    </main>
  );
}

/** Sprint 3: while lessons are «скоро» — the next lesson of the plan, «Мой план» and practice. */
function LessonsMeanwhile() {
  const { bff, nav, session } = useApp();
  const { t, l } = useI18n();
  const tr = useLoad(() => bff.trajectory(true), [session.learner.learner_id]);
  const next = tr.data?.next;
  return (
    <div className="pad stack mt16" data-testid="soon-lessons-more">
      <div className="list">
        <NavRow
          title={t("soon.lessons.plan")}
          note={next ? `${t("soon.lessons.next")}: ${l(next.title)}` : undefined}
          icon="route"
          onClick={() => nav.push({ name: "plan" })}
          testId="soon-plan"
        />
        <NavRow title={t("soon.lessons.practice")} icon="chat" onClick={() => nav.push({ name: "practice" })} testId="soon-practice" />
      </div>
    </div>
  );
}

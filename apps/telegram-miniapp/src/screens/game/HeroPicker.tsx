import type { GameSummary, HeroLine, HeroView } from "@tilhero/contracts/bff";
import { useMemo, useState } from "react";
import { orderHeroes, stageOf, type HeroesResponse } from "../../domain/game";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { haptic } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Pill, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { GameError, HeroImg } from "./parts";

/** «Мой герой» from Profile and Home: the picker on its own screen, «Назад» after the choice. */
export function HeroesScreen() {
  const { nav } = useApp();
  return <HeroPicker layout="screen" onDone={() => nav.back()} />;
}

/**
 * The choice of a hero (APP-GAME-01, AT-65): nine heroes in three lines (children see the dragons first), each with its
 * three stages and «за что растёт» — only confirmed skills grow it, tils never buy a stage. The stage is common to all
 * heroes: every hero is drawn at the learner's current stage; a change is free and keeps XP, the level and the stage.
 * In onboarding (after the plan) it can be skipped.
 */
export function HeroPicker(props: {
  layout: "screen" | "onboarding";
  /** prefetched by onboarding (the step is shown only when no hero is chosen yet) */
  initial?: HeroesResponse;
  onDone: (summary: GameSummary, hero: HeroView) => void;
  onSkip?: () => void;
}) {
  const { bff, nav, session } = useApp();
  const { t, l } = useI18n();
  const kid = session.learner.kind === "child";
  const res = useLoad<HeroesResponse>(() => (props.initial ? Promise.resolve(props.initial) : bff.gameHeroes()), [session.learner.learner_id]);
  const data = res.data;
  const items = useMemo(() => (data ? orderHeroes(data.items, kid) : []), [data, kid]);
  const [focus, setFocus] = useState<string | null>(null);
  const current = focus ?? data?.selected ?? items[0]?.code ?? null;
  const hero = items.find((h) => h.code === current) ?? null;
  const mine = data?.selected ?? null;

  const choose = useAction(async () => {
    if (!hero) return;
    const s = await bff.selectHero(hero.code);
    haptic.notify("success");
    res.setData((prev) => (prev ? { ...prev, selected: hero.code } : prev));
    showToast(t(kid ? "game.hero.chosenKid" : "game.hero.chosen", { name: l(hero.name) }));
    props.onDone(s, hero);
  });

  const groups = useMemo(() => {
    const out: Array<{ line: HeroLine; heroes: HeroView[] }> = [];
    for (const h of items) {
      const g = out.find((x) => x.line === h.line);
      if (g) g.heroes.push(h);
      else out.push({ line: h.line, heroes: [h] });
    }
    return out;
  }, [items]);

  const body = !data ? (
    res.loading ? (
      <div className="pad"><Skeleton lines={4} /></div>
    ) : (
      <GameError error={res.error} errorObj={res.errorObj} onRetry={() => void res.reload()} />
    )
  ) : (
    <div className="stack loose">
      <div className="pad stack tight">
        <h1 className="h1">{kid ? t("game.invite.titleKid") : t("game.invite.title")}</h1>
        <p className="sub">{kid ? t("game.hero.leadKid") : t("game.hero.lead")}</p>
      </div>
      {groups.map((g) => (
        <section key={g.line} className="pad stack tight" aria-labelledby={`hero-line-${g.line}`}>
          <h2 className="sec" id={`hero-line-${g.line}`}>{t(`game.hero.line.${g.line}` as MessageKey)}</h2>
          <div className="hero-grid" data-testid={`hero-line-${g.line}`}>
            {g.heroes.map((h) => {
              const st = stageOf(h, data.stage);
              const on = h.code === current;
              return (
                <button
                  key={h.code}
                  type="button"
                  className="hero-tile"
                  aria-pressed={on}
                  aria-label={`${l(h.name)}${h.code === mine ? `, ${t("game.hero.selected")}` : ""}`}
                  onClick={() => setFocus(h.code)}
                  data-testid={`hero-${h.code}`}
                >
                  {h.code === mine ? <span className="mine" aria-hidden="true">{t("game.hero.selected")}</span> : null}
                  {on ? <span className="tick" aria-hidden="true"><Icon name="check" size={14} stroke={3} /></span> : null}
                  <HeroImg image={st?.image} code={h.code} stage={data.stage} alt="" />
                  <span aria-hidden="true">{l(h.name)}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {hero ? <HeroDetail hero={hero} stage={data.stage} /> : null}
      <div className="pad">
        <p className="sub small">{kid ? t("game.hero.changeKid") : t("game.hero.change")}</p>
      </div>
    </div>
  );

  const isMine = !!hero && hero.code === mine;
  const actions = data ? (
    <>
      <ErrorLine text={choose.error} />
      <Btn busy={choose.busy} disabled={!hero || isMine} onClick={() => void choose.run()} data-testid="hero-choose">
        {isMine ? t(kid ? "game.hero.yoursKid" : "game.hero.yours") : t("game.hero.choose", { name: hero ? l(hero.name) : "" })}
      </Btn>
      {props.onSkip ? (
        <Btn variant="link" className="c" onClick={props.onSkip} data-testid="hero-skip">
          {t(kid ? "game.hero.skipKid" : "game.hero.skip")}
        </Btn>
      ) : null}
    </>
  ) : props.onSkip ? (
    <Btn variant="secondary" onClick={props.onSkip} data-testid="hero-skip">
      {t(kid ? "game.hero.skipKid" : "game.hero.skip")}
    </Btn>
  ) : null;

  if (props.layout === "onboarding") {
    return (
      <>
        <Bar title={t("ob.hero.cap")} plainTitle />
        <main className="ob" data-testid="ob-step-hero">
          <div className="ob-body hero-ob">{body}</div>
          <div className="ob-foot">{actions}</div>
        </main>
      </>
    );
  }
  return (
    <>
      <Bar title={t("game.hero.title")} onBack={nav.back} />
      <main className="scroll" data-testid="heroes">{body}</main>
      {actions ? <div className="foot">{actions}</div> : null}
    </>
  );
}

function HeroDetail({ hero, stage }: { hero: HeroView; stage: 1 | 2 | 3 }) {
  const { t, tp, l } = useI18n();
  return (
    <section className="pad stack tight" aria-labelledby="hero-detail-title" data-testid="hero-detail">
      <div className="card stack tight">
        <h2 className="h2" id="hero-detail-title" data-testid="hero-detail-name">{l(hero.name)}</h2>
        <p className="sub">{l(hero.tagline)}</p>
        <h3 className="sec">{t("game.hero.stages")}</h3>
        <ol className="stage-row" data-testid="hero-stages">
          {hero.stages.map((s) => (
            <li key={s.stage} className={cx("stage", s.stage === stage && "cur")} data-testid={`hero-stage-${s.stage}`}>
              <HeroImg image={s.image} code={hero.code} stage={s.stage} alt={t("game.hero.alt", { name: l(hero.name), stage: l(s.name) })} />
              <b>{l(s.name)}</b>
              <span className="sub small">{s.skills_required <= 0 ? t("game.hero.stageStart") : t("game.hero.stageNeed", { n: s.skills_required, w: tp("game.skillsGen", s.skills_required) })}</span>
              {s.stage === stage ? <Pill>{t("game.hero.now")}</Pill> : s.stage < stage ? <Pill tone="ok"><Icon name="check" size={12} stroke={3} />{t("game.hero.reached")}</Pill> : null}
            </li>
          ))}
        </ol>
        <h3 className="sec">{t("game.hero.growTitle")}</h3>
        <ul className="grow-list" data-testid="hero-grows">
          <li>{t("game.hero.grow1")}</li>
          <li>{t("game.hero.grow2")}</li>
          <li>{t("game.hero.grow3")}</li>
        </ul>
      </div>
    </section>
  );
}

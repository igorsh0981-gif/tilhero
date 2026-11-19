import type { Localized } from "@tilhero/contracts/content";
import { stageRanges } from "../../domain/lessons";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Margin, NoBreakHyphens, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";
import { useStartSession } from "./startSession";

/**
 * The lesson card (APP-LESS-01, AT-39): topic, goal, level, duration, skill, the five stages with their minutes and
 * what happens in each, the format of the roleplay for this learner (own answer or ready replies; a child — always
 * replies). No rewards (sprint 6). «Начать урок»; an unfinished session of this lesson — «Продолжить урок».
 */
export function LessonCardScreen({ id }: { id: string }) {
  const { bff, nav, session } = useApp();
  const { t, l } = useI18n();
  const kid = session.learner.kind === "child";
  const card = useLoad(() => bff.lessonCard(id), [id, session.learner.learner_id]);
  const { start, sheet, open } = useStartSession();
  const c = card.data;
  const format = c?.roleplay_mode ? t(`lc.format.${kid ? "choices" : c.roleplay_mode}` as MessageKey) : t("lc.format.none");

  return (
    <>
      {/* в шапке — раздел, название урока — h1 ниже (без повтора) */}
      <Bar title={t("tab.lessons")} onBack={nav.back} plainTitle />
      <main className="scroll" data-testid="lesson-card">
        {card.loading && !c ? (
          <div className="pad"><Skeleton lines={4} /></div>
        ) : card.error && !c ? (
          <div className="pad stack tight">
            <div className="card err" data-testid="lc-error"><p className="sub ink">{card.error}</p></div>
            <Btn variant="secondary" onClick={() => void card.reload()}>{t("c.retry")}</Btn>
          </div>
        ) : c ? (
          <div className="stack loose">
            <div className="pad stack tight">
              <div className="cap">{t("lc.cap", { level: c.level, n: c.duration_min })}</div>
              <h1 className="h1"><NoBreakHyphens text={l(c.title)} /></h1>
            </div>
            <div className="pad">
              <div className="card lc-kv" data-testid="lc-facts">
                <div className="kv"><span>{t("lc.goal")}</span><span>{l(c.goal)}</span></div>
                <div className="kv"><span>{t("lc.skill")}</span><span>{l(c.primary_skill.title)}</span></div>
                <div className="kv"><span>{t("lc.level")}</span><span>{c.level} — {t(`band.${c.level}` as MessageKey)}</span></div>
                <div className="kv"><span>{t("lc.duration")}</span><span>{t("c.minutesN", { n: c.duration_min })}</span></div>
                <div className="kv" data-testid="lc-format"><span>{t("lc.format")}</span><span>{format}</span></div>
                {c.key_words_count ? <div className="kv"><span>{t("lc.words")}</span><span>{t("lc.wordsN", { n: c.key_words_count })}</span></div> : null}
              </div>
            </div>
            <section className="stack lc-stages" aria-labelledby="lc-how">
              <div className="pad">
                <h2 className="sec" id="lc-how">{t("lc.how")}</h2>
              </div>
              {stageRanges<{ type: (typeof c.stages)[number]["type"]; minutes: number; instructions: Localized | null }>(c.stages_detail.length ? c.stages_detail : c.stages.map((s) => ({ ...s, instructions: null }))).map((s) => {
                const text = s.instructions ? l(s.instructions) : "";
                return (
                  <Margin key={s.type} note={`${s.from}–${s.to}`} tone="b">
                    <div className="card lc-stage" data-testid={`lc-stage-${s.type}`}>
                      <b className="h3">{t(`st.${s.type}` as MessageKey)}</b>
                      <p className="sub">{text || t(`st.hint.${s.type}` as MessageKey)}</p>
                    </div>
                  </Margin>
                );
              })}
            </section>
            <div className="pad stack tight">
              <p className="sub small">{kid ? t("lc.kidNote") : t("lc.pauseNote")}</p>
            </div>
          </div>
        ) : null}
      </main>
      {c ? (
        <div className="foot">
          <ErrorLine text={start.error} />
          {!c.available ? (
            <p className="sub ink" role="status" data-testid="lc-unavailable">{t(`lc.unavailable.${c.unavailable_reason ?? "audience"}` as MessageKey)}</p>
          ) : c.active_session_id ? (
            <Btn onClick={() => open(c.active_session_id!)} data-testid="lc-continue">
              <Icon name="play" size={18} />
              {t("lc.continue")}
            </Btn>
          ) : (
            <Btn busy={start.busy} onClick={() => void start.run({ kind: "lesson", id: c.lesson_id })} data-testid="lc-start">
              <Icon name="lessons" size={18} />
              {t("lc.start")}
            </Btn>
          )}
        </div>
      ) : null}
      {sheet}
    </>
  );
}

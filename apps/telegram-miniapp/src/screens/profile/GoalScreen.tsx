import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api/errors";
import { directionOf, directionPatch, MAX_TOPICS, type DirectionDraft } from "../../domain/plan";
import { useI18n } from "../../i18n";
import { useApp, usePlan } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { Btn, ErrorLine, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { GoalPicker, LevelPicker, TopicsPicker, useGoalItems } from "../onboarding/pickers";

/**
 * Profile → «Цель и уровень»: the direction of learning after onboarding — the goal (the same choices and labels as in
 * onboarding, GET /v1/directory/goals), the level (level_self) and up to 5 topics (GET /v1/directory/topics).
 * «Сохранить» sends only the changed fields with If-Match: <version>; a change made on another device meanwhile
 * (409 PLAN_VERSION_CONFLICT) reloads the plan and shows it (as ScheduleScreen).
 */
export function GoalScreen() {
  const { bff, nav, setPlan, reloadPlan, session } = useApp();
  const plan = usePlan();
  const { t } = useI18n();
  const kid = session.learner.kind === "child";
  const goals = useLoad(() => bff.goals(), []);
  const topics = useLoad(() => bff.topics(), []);
  const goalItems = useGoalItems(goals.data?.items);
  const [draft, setDraft] = useState<DirectionDraft>(() => directionOf(plan));
  const [conflict, setConflict] = useState(false);
  const [topicsInvalid, setTopicsInvalid] = useState(false);
  useEffect(() => {
    setDraft(directionOf(plan));
    // the server's plan (after a save or a 409) replaces the draft
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.version, plan.learner_id]);

  const known = useMemo(() => (topics.data ? new Set(topics.data.items.map((i) => i.code)) : undefined), [topics.data]);
  const patch = directionPatch(directionOf(plan), draft, known);
  const dirty = Object.keys(patch).length > 0;
  const chosen = known ? draft.topics.filter((c) => known.has(c)) : draft.topics;

  const save = useAction(async () => {
    setConflict(false);
    setTopicsInvalid(false);
    try {
      setPlan(await bff.patchPlan(patch, plan.version));
    } catch (e) {
      if (e instanceof ApiError && e.code === "PLAN_VERSION_CONFLICT") {
        setConflict(true);
        await reloadPlan();
      }
      if (e instanceof ApiError && e.code === "PLAN_INVALID" && e.details.field === "topics") {
        setTopicsInvalid(true);
        void topics.reload();
      }
      throw e;
    }
    showToast(t("goal.saved"));
  });

  return (
    <>
      <Bar title={t("goal.title")} onBack={nav.back} />
      <main className="scroll" data-testid="goal-screen">
        <div className="pad stack loose">
          <p className="sub">{t("goal.text")}</p>

          <section className="stack tight" aria-labelledby="goal-goal">
            <h2 className="sec" id="goal-goal">{kid ? t("ob.goal.titleChild") : t("goal.goal")}</h2>
            <GoalPicker items={goalItems} value={draft.goal} onChange={(g) => setDraft({ ...draft, goal: g })} label={t("goal.goal")} labelledBy="goal-goal" />
          </section>

          <section className="stack tight" aria-labelledby="goal-level">
            <h2 className="sec" id="goal-level">{t("goal.level")}</h2>
            <LevelPicker value={draft.level_self} onChange={(lv) => setDraft({ ...draft, level_self: lv })} labelledBy="goal-level" />
            <p className="sub small">{t("ob.level.note")}</p>
          </section>

          <section className="stack tight" aria-labelledby="goal-topics" aria-describedby="goal-topics-note">
            <div className="hrow between">
              <h2 className="sec" id="goal-topics">{t("goal.topics")}</h2>
              <span className="sub small" aria-live="polite" data-testid="topics-count">
                {t("goal.topicsCount", { n: chosen.length })}
              </span>
            </div>
            <p className="sub small" id="goal-topics-note">
              {chosen.length >= MAX_TOPICS ? t("goal.topicsFull") : t("goal.topicsNote")}
            </p>
            {topics.data ? (
              <TopicsPicker items={topics.data.items} value={chosen} onChange={(v) => setDraft({ ...draft, topics: v })} labelledBy="goal-topics" />
            ) : topics.error ? (
              <div className="stack tight">
                <ErrorLine text={topics.error} />
                <Btn variant="secondary" onClick={() => void topics.reload()}>{t("c.retry")}</Btn>
              </div>
            ) : (
              <Skeleton lines={1} />
            )}
          </section>

          {conflict ? (
            <div className="card warn" data-testid="goal-conflict">
              <p className="sub ink">{t("err.PLAN_VERSION_CONFLICT")}</p>
            </div>
          ) : null}
        </div>
      </main>
      <div className="foot">
        <ErrorLine text={conflict ? null : topicsInvalid ? t("goal.topicsInvalid") : save.error} />
        <Btn busy={save.busy} disabled={!dirty} onClick={() => void save.run()} data-testid="goal-save">
          {dirty ? t("c.save") : t("schedule.noChanges")}
        </Btn>
      </div>
    </>
  );
}

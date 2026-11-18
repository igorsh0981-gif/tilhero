import type { Schedule } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { ApiError } from "../../api/errors";
import { scheduleDiff, scheduleProblem } from "../../domain/schedule";
import { useI18n } from "../../i18n";
import { useApp, usePlan } from "../../state/app";
import { useAction } from "../../state/hooks";
import { requestWriteAccess } from "../../tg";
import { Btn, ErrorLine, ToggleRow } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { DaysPicker, DurationPicker, TimePicker, ZonePicker, timeError } from "../schedule/parts";

/**
 * Profile → «График занятий» (AT-06): the same choices as in onboarding; «Сохранить» sends only the changed fields
 * with If-Match: <version>. A change made on another device meanwhile (409 PLAN_VERSION_CONFLICT) reloads the plan.
 * Reminders and the time zone are mirrored into the delivery settings (AT-07, AT-13).
 */
export function ScheduleScreen() {
  const { bff, nav, setPlan, reloadPlan, syncProfile, deviceTz, session } = useApp();
  const plan = usePlan();
  const { t } = useI18n();
  const [draft, setDraft] = useState<Schedule>(plan.schedule);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    setDraft(plan.schedule);
  }, [plan.schedule]);
  const diff = scheduleDiff(plan.schedule, draft);
  const dirty = Object.keys(diff).length > 0;
  const kid = session.learner.kind === "child";
  const problem = scheduleProblem(draft, { kid });

  const save = useAction(async () => {
    setConflict(false);
    if (diff.reminders_enabled) await requestWriteAccess();
    try {
      const next = await bff.patchPlan({ schedule: diff }, plan.version);
      setPlan(next);
    } catch (e) {
      if (e instanceof ApiError && e.code === "PLAN_VERSION_CONFLICT") {
        setConflict(true);
        await reloadPlan();
      }
      throw e;
    }
    if (diff.reminders_enabled !== undefined || diff.timezone !== undefined) {
      const on = diff.reminders_enabled;
      syncProfile(
        await bff.patchSettings({
          notifications: {
            ...(on ? { enabled: true } : {}),
            ...(on !== undefined ? { categories: { reminders: on } } : {}),
            ...(diff.timezone ? { timezone: diff.timezone } : {}),
          },
        }),
      );
    }
    showToast(t("schedule.saved"));
  });

  return (
    <>
      <Bar title={t("schedule.title")} onBack={nav.back} />
      <main className="scroll" data-testid="schedule-screen">
        <div className="pad stack loose">
          <p className="sub">{t("schedule.text")}</p>
          <DaysPicker value={draft} onChange={(d) => setDraft({ ...draft, ...d })} />
          <TimePicker kid={kid} value={draft.preferred_time} onChange={(v) => setDraft({ ...draft, preferred_time: v })} error={timeError(problem, draft.preferred_time, kid, t)} />
          <DurationPicker value={draft.duration_min} onChange={(d) => setDraft({ ...draft, duration_min: d })} />
          <div className="list">
            <ToggleRow
              title={t("sch.reminders")}
              note={kid ? t("sch.remindersKid") : t("sch.remindersNote", { time: draft.preferred_time })}
              checked={draft.reminders_enabled}
              onChange={(v) => setDraft({ ...draft, reminders_enabled: v })}
              testId="reminders"
            />
          </div>
          <ZonePicker value={draft.timezone} device={deviceTz} onChange={(tz) => setDraft({ ...draft, timezone: tz })} />
          {conflict ? (
            <div className="card warn">
              <p className="sub ink">{t("err.PLAN_VERSION_CONFLICT")}</p>
            </div>
          ) : null}
        </div>
      </main>
      <div className="foot">
        <ErrorLine text={conflict ? null : save.error} />
        <Btn busy={save.busy} disabled={!dirty || problem != null} onClick={() => void save.run()} data-testid="schedule-save">
          {dirty ? t("c.save") : t("schedule.noChanges")}
        </Btn>
      </div>
    </>
  );
}

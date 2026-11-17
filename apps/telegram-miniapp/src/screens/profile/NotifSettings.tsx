import type { NotificationCategories, NotificationSettings, SettingsPatch } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { isValidTime } from "../../domain/schedule";
import { useI18n } from "../../i18n";
import { useApp, usePlan } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { setLessonReminders } from "../../state/reminders";
import { Btn, ErrorLine, Pill, Skeleton, ToggleRow } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { zoneLabel } from "../schedule/parts";

type Editable = Exclude<keyof NotificationCategories, "support">;
const CATS: readonly Editable[] = ["reminders", "missed", "social", "product"];

/**
 * Profile → «Уведомления» (APP-SUP-03, AT-13): the Telegram master switch, categories and quiet hours are applied on
 * the server. Support replies are always delivered; the in-app notification center works even with everything off.
 */
export function NotifSettings() {
  const { bff, nav, syncProfile, setPlan, session } = useApp();
  const plan = usePlan();
  const { t } = useI18n();
  const loaded = useLoad(() => bff.profile(), []);
  const [s, setS] = useState<NotificationSettings | null>(null);
  const [quiet, setQuiet] = useState<{ start: string; end: string }>({ start: "22:00", end: "08:00" });
  useEffect(() => {
    if (!loaded.data) return;
    syncProfile(loaded.data);
    setS(loaded.data.notifications);
    if (loaded.data.notifications.quiet_hours) setQuiet(loaded.data.notifications.quiet_hours);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded.data]);
  const kid = session.learner.kind === "child";

  // optimistic: the switch moves at once, a failed save puts it back (the error is shown below)
  const [remOn, setRemOn] = useState<boolean | null>(null);
  const patch = useAction(async (p: NonNullable<SettingsPatch["notifications"]>) => {
    const before = s;
    if (s) {
      setS({
        ...s,
        ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
        ...(p.quiet_hours !== undefined ? { quiet_hours: p.quiet_hours } : {}),
        categories: { ...s.categories, ...(p.categories ?? {}) },
      });
    }
    try {
      const prof = await bff.patchSettings({ notifications: p });
      syncProfile(prof);
      setS(prof.notifications);
      showToast(t("ns.saved"));
    } catch (e) {
      setS(before);
      throw e;
    }
  });
  const reminders = useAction(async (on: boolean) => {
    setRemOn(on);
    try {
      const r = await setLessonReminders(bff, on, plan);
      setPlan(r.plan);
      syncProfile(r.profile);
      setS(r.profile.notifications);
      showToast(t("ns.saved"));
    } finally {
      setRemOn(null);
    }
  });
  const busy = patch.busy || reminders.busy;
  const quietValid = isValidTime(quiet.start) && isValidTime(quiet.end) && quiet.start !== quiet.end;
  const quietDirty = !!s?.quiet_hours && (s.quiet_hours.start !== quiet.start || s.quiet_hours.end !== quiet.end);

  return (
    <>
      <Bar title={t("ns.title")} onBack={nav.back} />
      <main className="scroll" data-testid="notif-settings">
        <div className="pad stack">
          {!s ? (
            loaded.error ? (
              <div className="card err stack tight">
                <p className="sub ink">{loaded.error}</p>
                <Btn variant="secondary" onClick={() => void loaded.reload()}>{t("c.retry")}</Btn>
              </div>
            ) : (
              <Skeleton lines={3} />
            )
          ) : (
            <>
              <div className="list">
                <ToggleRow title={t("ns.master")} note={t("ns.masterNote")} checked={s.enabled} disabled={busy} onChange={(v) => void patch.run({ enabled: v })} testId="ns-master" />
              </div>
              {kid ? (
                <div className="card warn">
                  <p className="sub ink">{t("ns.kid")}</p>
                </div>
              ) : null}
              <p className="sec">{t("ns.categories")}</p>
              <div className="list">
                {CATS.map((c) => (
                  <ToggleRow
                    key={c}
                    title={t(`ns.${c}`)}
                    note={c === "reminders" ? t("ns.remindersNote", { time: plan.schedule.preferred_time }) : t(`ns.${c}Note`)}
                    checked={c === "reminders" ? remOn ?? (s.categories.reminders && plan.schedule.reminders_enabled) : s.categories[c]}
                    disabled={busy || !s.enabled}
                    onChange={(v) => void (c === "reminders" ? reminders.run(v) : patch.run({ categories: { [c]: v } }))}
                    testId={`ns-${c}`}
                  />
                ))}
                <div className="row">
                  <span className="t">
                    <b>{t("ns.support")}</b>
                    <span>{t("ns.supportNote")}</span>
                  </span>
                  <Pill tone="ok">{t("ns.always")}</Pill>
                </div>
              </div>
              {!s.enabled ? <p className="sub small">{t("ns.offNote")}</p> : null}

              <p className="sec">{t("ns.quiet")}</p>
              <div className="list">
                <ToggleRow
                  title={t("ns.quietOn")}
                  note={t("ns.quietNote")}
                  checked={!!s.quiet_hours}
                  disabled={busy}
                  onChange={(v) => void patch.run({ quiet_hours: v ? (quietValid ? quiet : { start: "22:00", end: "08:00" }) : null })}
                  testId="ns-quiet"
                />
                {s.quiet_hours ? (
                  <div className="row">
                    <label className="t" htmlFor="q-start"><b>{t("ns.quietFrom")}</b></label>
                    <input id="q-start" className="inp time-inp" type="time" value={quiet.start} onChange={(e) => setQuiet({ ...quiet, start: e.target.value })} data-testid="q-start" />
                  </div>
                ) : null}
                {s.quiet_hours ? (
                  <div className="row">
                    <label className="t" htmlFor="q-end"><b>{t("ns.quietTo")}</b></label>
                    <input id="q-end" className="inp time-inp" type="time" value={quiet.end} onChange={(e) => setQuiet({ ...quiet, end: e.target.value })} data-testid="q-end" />
                  </div>
                ) : null}
              </div>
              {s.quiet_hours && quietDirty ? (
                <Btn variant="secondary" busy={patch.busy} disabled={!quietValid} onClick={() => void patch.run({ quiet_hours: quiet })} data-testid="q-save">
                  {t("ns.quietSave")}
                </Btn>
              ) : null}
              {s.quiet_hours && !quietValid ? <p className="field-err" role="alert">{t("err.QUIET_HOURS_INVALID")}</p> : null}
              <p className="sub small">{t("ns.tz", { tz: zoneLabel(s.timezone, t) })}</p>
              <ErrorLine text={patch.error ?? reminders.error} />
            </>
          )}
        </div>
      </main>
    </>
  );
}

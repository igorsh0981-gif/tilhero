import type { DurationMin, Schedule, SchedulePreset } from "@tilhero/contracts/bff";
import { useId } from "react";
import {
  ALL_DAYS,
  DURATIONS,
  KID_WINDOW,
  TIME_CHOICES,
  TIME_PRESETS,
  choosePreset,
  inKidWindow,
  isValidTime,
  presetForDays,
  timeChoice,
  toggleDay,
  utcOffset,
  zoneOptions,
} from "../../domain/schedule";
import { useI18n, type I18n, type MessageKey } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { cx, Seg } from "../../ui/kit";

/* Parts of the schedule editor (AT-06), shared by the onboarding steps and Profile → «График занятий». */

const PRESET_ORDER: readonly SchedulePreset[] = ["daily", "weekdays", "three_per_week", "custom"];

export function DaysPicker({ value, onChange }: { value: Pick<Schedule, "preset" | "days">; onChange: (v: Pick<Schedule, "preset" | "days">) => void }) {
  const { t } = useI18n();
  const legend = useId();
  const pickLabel = useId();
  return (
    <fieldset className="stack tight">
      <legend className="lb" id={legend}>{t("sch.days")}</legend>
      <div className="opts two" role="group" aria-labelledby={legend}>
        {PRESET_ORDER.map((p) => {
          const on = value.preset === p;
          return (
            <button key={p} type="button" className={cx("opt", on && "on")} aria-pressed={on} onClick={() => onChange(choosePreset(value, p))} data-testid={`preset-${p}`}>
              <span className="t">
                <b>{t(`preset.${p}`)}</b>
              </span>
              <span className="mark" aria-hidden="true">{on ? <Icon name="check" size={14} stroke={3} /> : null}</span>
            </button>
          );
        })}
      </div>
      <p className="sr" id={pickLabel}>{t("sch.pickDays")}</p>
      <div className="days" role="group" aria-labelledby={pickLabel} data-testid="days">
        {ALL_DAYS.map((d) => {
          const on = value.days.includes(d);
          return (
            <button key={d} type="button" className={cx("day", on && "on")} aria-pressed={on} aria-label={t(`dayLong.${d}` as MessageKey)} onClick={() => onChange(toggleDay(value, d))}>
              {t(`day.${d}` as MessageKey)}
              <span className="tick" aria-hidden="true">{on ? "✓" : "·"}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** `kid` — a child profile: the time only within KID_WINDOW (08:00–19:30), with the reason shown under the picker. */
export function TimePicker({ value, onChange, error, kid }: { value: string; onChange: (v: string) => void; error?: string | null; kid?: boolean }) {
  const { t } = useI18n();
  const id = useId();
  const label = useId();
  const kidNote = useId();
  const choice = timeChoice(value);
  return (
    <fieldset className="stack tight">
      <legend className="lb" id={label}>{t("sch.time")}</legend>
      <Seg
        label={t("sch.time")}
        labelledBy={label}
        tall
        value={choice}
        testId="time-choice"
        options={TIME_CHOICES.map((c) => ({
          value: c,
          label:
            c === "custom" ? (
              t("time.custom")
            ) : (
              <>
                {t(`time.${c}`)}
                <small className="sg-sub">{TIME_PRESETS[c]}</small>
              </>
            ),
        }))}
        onChange={(c) => {
          if (c !== "custom") onChange(TIME_PRESETS[c]);
          else document.getElementById(id)?.focus();
        }}
      />
      <div className="hrow">
        <label className="sub" htmlFor={id}>{t("sch.timeExact")}</label>
        <input
          id={id}
          className="inp time-inp"
          type="time"
          step={300}
          value={value}
          {...(kid ? { min: KID_WINDOW.from, max: KID_WINDOW.to, "aria-describedby": kidNote } : {})}
          aria-invalid={!!error || !isValidTime(value) || undefined}
          onChange={(e) => onChange(e.target.value)}
          data-testid="time-input"
        />
      </div>
      {kid ? (
        <p className="sub small field-hint" id={kidNote} data-testid="kid-window">
          {t("sch.kidWindow", { from: KID_WINDOW.from, to: KID_WINDOW.to })}
        </p>
      ) : null}
      {error ? <p className="field-err" role="alert">{error}</p> : null}
    </fieldset>
  );
}

/** The error under the time picker: format, or — in a child profile — outside the 08:00–19:30 window. */
export function timeError(problem: string | null, time: string, kid: boolean, t: I18n["t"]): string | null {
  if (problem !== "preferred_time") return null;
  if (kid && isValidTime(time) && !inKidWindow(time)) return t("sch.kidTimeErr", { from: KID_WINDOW.from, to: KID_WINDOW.to });
  return t("sch.timeErr");
}

export function DurationPicker({ value, onChange }: { value: DurationMin; onChange: (v: DurationMin) => void }) {
  const { t } = useI18n();
  const label = useId();
  return (
    <fieldset className="stack tight">
      <legend className="lb" id={label}>{t("sch.duration")}</legend>
      <Seg
        label={t("sch.duration")}
        labelledBy={label}
        value={value}
        testId="duration"
        options={DURATIONS.map((d) => ({ value: d, label: t("c.minutesN", { n: d }) }))}
        onChange={onChange}
      />
    </fieldset>
  );
}

export function zoneLabel(tz: string, t: I18n["t"]): string {
  const key = `tz.${tz}` as MessageKey;
  const city = t(key);
  const name = city === key ? tz.replace(/_/g, " ").split("/").pop() ?? tz : city;
  const off = utcOffset(tz);
  return off ? `${name} (${off})` : name;
}

export function ZonePicker({ value, device, onChange }: { value: string; device: string; onChange: (tz: string) => void }) {
  const { t } = useI18n();
  const id = useId();
  const hint = useId();
  return (
    <div>
      <label className="lb" htmlFor={id}>{t("sch.tz")}</label>
      <select id={id} className="inp" value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={hint} data-testid="tz">
        {zoneOptions(value, device).map((z) => (
          <option key={z} value={z}>
            {zoneLabel(z, t)}
          </option>
        ))}
      </select>
      <p className="sub small field-hint" id={hint}>{value === device ? t("sch.tzDevice") : t("sch.tzOther")}</p>
    </div>
  );
}

/** «Пн, Ср, Пт · 19:00 · 20 мин» / «Каждый день · 08:00 · 10 мин». */
export function daysText(s: Pick<Schedule, "preset" | "days">, t: I18n["t"]): string {
  const p = presetForDays(s.days);
  if (p === "daily") return t("preset.daily");
  if (p === "weekdays") return t("preset.weekdays");
  return s.days.map((d) => t(`day.${d}` as MessageKey)).join(", ");
}

export function scheduleSummary(s: Schedule, t: I18n["t"]): string {
  return `${daysText(s, t)} · ${s.preferred_time} · ${t("c.minutesN", { n: s.duration_min })}`;
}

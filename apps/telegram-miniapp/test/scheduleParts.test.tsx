import type { DurationMin, Schedule } from "@tilhero/contracts/bff";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULE } from "../src/domain/schedule";
import { I18nProvider, makeI18n } from "../src/i18n";
import { DaysPicker, DurationPicker, TimePicker, ZonePicker, daysText, scheduleSummary, zoneLabel } from "../src/screens/schedule/parts";

let last: Schedule = DEFAULT_SCHEDULE;
function Editor({ initial = DEFAULT_SCHEDULE }: { initial?: Schedule }) {
  const [s, setS] = useState(initial);
  last = s;
  return (
    <>
      <DaysPicker value={s} onChange={(d) => setS({ ...s, ...d })} />
      <TimePicker value={s.preferred_time} onChange={(v) => setS({ ...s, preferred_time: v })} />
      <DurationPicker value={s.duration_min} onChange={(d: DurationMin) => setS({ ...s, duration_min: d })} />
      <ZonePicker value={s.timezone} device="Asia/Tashkent" onChange={(tz) => setS({ ...s, timezone: tz })} />
    </>
  );
}
const ui = (initial?: Schedule) =>
  render(
    <I18nProvider initial="ru">
      <Editor initial={initial} />
    </I18nProvider>,
  );

describe("schedule editor (AT-06)", () => {
  it("presets and days: every choice is a pressed button with a label (not colour only)", async () => {
    ui();
    expect(screen.getByRole("button", { name: "Каждый день" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "3 раза в неделю" }));
    expect(last.days).toEqual([1, 3, 5]);
    expect(screen.getByRole("button", { name: "понедельник" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "вторник" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "воскресенье" }));
    expect(last).toMatchObject({ preset: "custom", days: [1, 3, 5, 7] });
    expect(screen.getByRole("button", { name: "Свои дни" })).toHaveAttribute("aria-pressed", "true");
  });
  it("time: presets fill the exact time; typing another time selects «Своё»", async () => {
    ui();
    await userEvent.click(screen.getByRole("button", { name: /Утром/ }));
    expect(last.preferred_time).toBe("08:00");
    const input = screen.getByLabelText("Время занятия");
    expect(input).toHaveValue("08:00");
    await userEvent.clear(input);
    await userEvent.type(input, "07:45");
    expect(last.preferred_time).toBe("07:45");
    expect(screen.getByRole("button", { name: "Своё" })).toHaveAttribute("aria-pressed", "true");
  });
  it("duration 10 / 15 / 20 / 30", async () => {
    ui();
    expect(screen.getAllByRole("button", { name: /мин$/ }).map((b) => b.textContent)).toEqual(["10 мин", "15 мин", "20 мин", "30 мин"]);
    await userEvent.click(screen.getByRole("button", { name: "30 мин" }));
    expect(last.duration_min).toBe(30);
  });
  it("time zone: the device one by default, with a city and offset", async () => {
    ui();
    const select = screen.getByLabelText("Часовой пояс");
    expect(select).toHaveValue("Asia/Tashkent");
    expect(screen.getByText("Как на вашем устройстве")).toBeInTheDocument();
    await userEvent.selectOptions(select, "Europe/Moscow");
    expect(last.timezone).toBe("Europe/Moscow");
    expect(screen.getByText(/Отличается от устройства/)).toBeInTheDocument();
  });
  it("summaries in RU and UZ", () => {
    const ru = makeI18n("ru").t;
    const uz = makeI18n("uz").t;
    const s: Schedule = { ...DEFAULT_SCHEDULE, preset: "custom", days: [1, 3, 6], preferred_time: "07:30", duration_min: 15 };
    expect(scheduleSummary(s, ru)).toBe("Пн, Ср, Сб · 07:30 · 15 мин");
    expect(scheduleSummary(s, uz)).toBe("Du, Ch, Sh · 07:30 · 15 daqiqa");
    expect(daysText({ preset: "custom", days: [1, 2, 3, 4, 5] }, ru)).toBe("По будням");
    expect(zoneLabel("Asia/Tashkent", ru)).toBe("Ташкент (UTC+5)");
    expect(zoneLabel("Asia/Tashkent", uz)).toBe("Toshkent (UTC+5)");
  });
});

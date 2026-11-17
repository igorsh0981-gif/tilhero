import { expect, test } from "@playwright/test";
import { expectNextVisible, expectNoVerticalScroll, open, shot } from "./helpers";

/**
 * AT-04 onboarding without a long questionnaire — every step without scrolling at 390×844; AT-02 consents (voice
 * recording optional); AT-06 schedule: days, time, duration, reminders opt-in, time zone from the device; AT-01 after a
 * reload the same plan; AT-11 the welcome sheet after the first registration, seen marks go to the server.
 */
test("adult onboarding with a custom schedule, then the welcome «Что нового»", async ({ page }) => {
  const bff = await open(page);
  const next = page.getByTestId("ob-next");

  // 1. language (welcome)
  await expect(page.getByTestId("ob-step-lang")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Говорите по-английски с ИИ-коучем" })).toBeVisible();
  await expectNoVerticalScroll(page);
  await shot(page, "01_welcome");
  await next.click();

  // 2. who and age
  await expect(page.getByTestId("ob-step-who")).toBeVisible();
  await expect(next).toBeDisabled();
  await page.getByTestId("who-self").click();
  await page.getByRole("button", { name: "18 лет и старше" }).click();
  await expectNoVerticalScroll(page);
  await expectNextVisible(page);
  await next.click();
  await expect.poll(() => bff.last("PUT", "/v1/profile/age")?.body).toEqual({ age_band: "18+" });

  // 3. consents: required ones only, voice recording stays off (AT-02)
  await expect(page.getByTestId("ob-step-consent")).toBeVisible();
  await expect(next).toBeDisabled();
  for (const c of ["terms", "privacy", "learning"]) await page.getByTestId(`consent-${c}`).check();
  await expect(page.getByTestId("consent-voice_recording")).not.toBeChecked();
  await expectNoVerticalScroll(page);
  await expectNextVisible(page);
  await shot(page, "02_consent");
  await next.click();
  await expect.poll(() => bff.last("POST", "/v1/profile/consent")?.body).toEqual({ policy_version: "1.2", purposes: ["terms", "privacy", "learning"] });

  // 4. goal
  await expect(page.getByTestId("ob-step-goal")).toBeVisible();
  await page.getByRole("button", { name: "Путешествия" }).click();
  await expectNoVerticalScroll(page);
  await next.click();

  // 5. level
  await expect(page.getByTestId("ob-step-level")).toBeVisible();
  await page.getByTestId("level-beginner").click();
  await expectNoVerticalScroll(page);
  await next.click();

  // 6. days and time: weekdays, then Saturday too → «свои дни»; evening time
  await expect(page.getByTestId("ob-step-when")).toBeVisible();
  await page.getByTestId("preset-weekdays").click();
  await page.getByRole("button", { name: "суббота" }).click();
  await expect(page.getByTestId("preset-custom")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("time-choice").getByRole("button", { name: /Утром/ }).click();
  await expect(page.getByTestId("time-input")).toHaveValue("08:00");
  await page.getByTestId("time-input").fill("07:30");
  await expect(page.getByTestId("time-choice").getByRole("button", { name: "Своё" })).toHaveAttribute("aria-pressed", "true");
  await expectNoVerticalScroll(page);
  await expectNextVisible(page);
  await shot(page, "03_schedule_days_time");
  await next.click();
  await expect.poll(() => bff.plan().schedule.days).toEqual([1, 2, 3, 4, 5, 6]);

  // 7. duration, reminders (explicit opt-in), time zone from the device
  await expect(page.getByTestId("ob-step-minutes")).toBeVisible();
  await expect(page.getByTestId("reminders")).not.toBeChecked();
  await page.getByTestId("duration").getByRole("button", { name: "15 мин" }).click();
  await page.getByTestId("reminders").check();
  await expect(page.getByTestId("tz")).toHaveValue("Asia/Tashkent");
  await expect(page.getByText("Как на вашем устройстве")).toBeVisible();
  await expectNoVerticalScroll(page);
  await expectNextVisible(page);
  await shot(page, "04_schedule_minutes");
  await next.click();

  // done
  await expect(page.getByTestId("ob-done")).toBeVisible();
  await expect(page.getByText("Пн, Вт, Ср, Чт, Пт, Сб")).toBeVisible();
  await expectNoVerticalScroll(page);
  const p = bff.plan();
  expect(p.schedule).toMatchObject({ preset: "custom", days: [1, 2, 3, 4, 5, 6], preferred_time: "07:30", duration_min: 15, reminders_enabled: true, timezone: "Asia/Tashkent" });
  expect(p.goal).toBe("travel");
  expect(p.course_pair).toBe("ru-en");
  expect(bff.settings[bff.active]!.categories.reminders).toBe(true);
  await page.getByTestId("ob-open-home").click();

  // welcome «Что нового» (mode welcome): 5 + 1 cards, «Подробнее» only where a route exists
  const sheet = page.getByTestId("whats-new-welcome");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Знакомство с TilHero" })).toBeVisible();
  await expect(sheet.getByText("Герой растёт за навыки")).toBeVisible();
  await shot(page, "05_whats_new_welcome");
  for (let i = 0; i < 5; i++) await sheet.getByTestId("wn-next").click();
  await expect(sheet.getByTestId("wn-next")).toHaveText("Понятно");
  await sheet.getByTestId("wn-next").click();
  await expect(sheet).toBeHidden();
  await expect.poll(() => (bff.last("POST", "/v1/whats-new/seen")?.body as { release_note_ids: string[] } | undefined)?.release_note_ids.sort()).toEqual(
    ["11111111-aaaa-4bbb-8ccc-000000000001", "11111111-aaaa-4bbb-8ccc-000000000003"],
  );

  // home: today's plan by the learner's schedule
  await expect(page.getByTestId("home")).toBeVisible();
  await expect(page.getByTestId("today-card")).toBeVisible();
  await shot(page, "06_home");

  // AT-01 / AT-06: after the next login the same plan, no onboarding, no sheet (everything seen)
  await page.reload();
  await expect(page.getByTestId("home")).toBeVisible();
  await expect(page.getByTestId("ob-step-lang")).toHaveCount(0);
  await page.waitForTimeout(400);
  await expect(page.getByTestId("whats-new-welcome")).toHaveCount(0);
  await expect(page.getByTestId("whats-new-updates")).toHaveCount(0);
  await page.getByTestId("tab-profile").click();
  await expect(page.getByTestId("row-schedule")).toContainText("Пн, Вт, Ср, Чт, Пт, Сб · 07:30");
});

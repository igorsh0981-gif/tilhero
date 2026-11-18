import { expect, test } from "@playwright/test";
import { open, shot } from "./helpers";

const ALL_SEEN = ["11111111-aaaa-4bbb-8ccc-000000000001", "11111111-aaaa-4bbb-8ccc-000000000002", "11111111-aaaa-4bbb-8ccc-000000000003"];

/** AT-06: the schedule changed in the profile is stored on the server (only the changed fields, If-Match). */
test("change the schedule in the profile; after the next login it is the same", async ({ page }) => {
  const bff = await open(page, { onboarded: true, seen: ALL_SEEN });
  await page.getByTestId("tab-profile").click();
  await expect(page.getByTestId("row-schedule")).toContainText("Пн, Ср, Пт · 19:00");
  await page.getByTestId("row-schedule").click();
  const save = page.getByTestId("schedule-save");
  await expect(save).toBeDisabled();
  await page.getByTestId("preset-weekdays").click();
  await page.getByTestId("time-choice").getByRole("button", { name: /Утром/ }).click();
  await page.getByTestId("duration").getByRole("button", { name: "30 мин" }).click();
  await shot(page, "09_profile_schedule");
  await save.click();
  await expect(page.getByTestId("toast")).toHaveText("График сохранён");
  const patch = bff.last("PATCH", "/v1/plan")!;
  expect(patch.headers["if-match"]).toBe("4");
  expect(patch.body).toEqual({ schedule: { preset: "weekdays", days: [1, 2, 3, 4, 5], preferred_time: "08:00", duration_min: 30 } });
  await expect(save).toBeDisabled();

  await page.reload();
  await page.getByTestId("tab-profile").click();
  await expect(page.getByTestId("row-schedule")).toContainText("По будням · 08:00");
  await page.getByTestId("tab-home").click();
  await expect(page.getByTestId("today-card")).toBeVisible();
});

test("a change made on another device: 409 → the current plan is shown", async ({ page }) => {
  await open(page, { onboarded: true, seen: ALL_SEEN, conflictOnce: true });
  await page.getByTestId("tab-profile").click();
  await page.getByTestId("row-schedule").click();
  await page.getByTestId("duration").getByRole("button", { name: "10 мин" }).click();
  await page.getByTestId("schedule-save").click();
  await expect(page.getByText("План изменился на другом устройстве — показываем актуальный.")).toBeVisible();
  await expect(page.getByTestId("time-input")).toHaveValue("07:30");
});

/** AT-13: categories and quiet hours are applied on the server; support is always on. */
test("notification settings: a category, quiet hours", async ({ page }) => {
  const bff = await open(page, { onboarded: true, seen: ALL_SEEN });
  await page.getByTestId("tab-profile").click();
  await page.getByTestId("row-notif").click();
  await expect(page.getByTestId("ns-product")).toBeChecked();
  await page.getByTestId("ns-product").uncheck();
  await expect.poll(() => bff.last("PATCH", "/v1/profile/settings")?.body).toEqual({ notifications: { categories: { product: false } } });
  await page.getByTestId("q-start").fill("23:00");
  await page.getByTestId("q-save").click();
  await expect.poll(() => bff.settings[bff.active]!.quiet_hours).toEqual({ start: "23:00", end: "08:00" });
  await page.getByTestId("ns-reminders").uncheck();
  await expect.poll(() => bff.plan().schedule.reminders_enabled).toBe(false);
  await expect.poll(() => bff.settings[bff.active]!.categories.reminders).toBe(false);
});

/** AT-12: every message is in the notification center; unread ones are marked without relying on colour. */
test("notification center: unread, read on open, the link leads to its screen", async ({ page }) => {
  const bff = await open(page, { onboarded: true, seen: ALL_SEEN });
  await expect(page.getByTestId("bell")).toHaveAccessibleName("Уведомления: непрочитанных 2");
  await page.getByTestId("bell").click();
  const items = page.getByTestId("inbox-item");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("новое");
  await expect(items.nth(1)).toContainText("только в приложении");
  await shot(page, "10_inbox");
  await items.nth(0).click();
  await expect(page.getByTestId("family")).toBeVisible();
  expect(bff.last("POST", "/v1/notifications/read")?.body).toEqual({ ids: ["22222222-aaaa-4bbb-8ccc-000000000001"] });
  await page.getByTestId("bar-back").click();
  await page.getByTestId("read-all").click();
  await expect(page.getByTestId("read-all")).toHaveCount(0);
  await page.getByTestId("bar-back").click();
  await expect(page.getByTestId("bell")).toHaveAccessibleName("Уведомления");
});

test("mark a session on Home: Idempotency-Key, today is done", async ({ page }) => {
  const bff = await open(page, { onboarded: true, seen: ALL_SEEN });
  await page.getByTestId("mark-activity").click();
  await expect(page.getByTestId("toast")).toHaveText("Занятие отмечено: +20 мин");
  const r = bff.last("POST", "/v1/plan/activity")!;
  expect(r.body).toEqual({ kind: "practice", minutes: 20 });
  expect(r.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByTestId("today-title")).toHaveText("Сегодня занятие уже есть");
});

test("support: a request by category, then it is in the list", async ({ page }) => {
  const bff = await open(page, { onboarded: true, seen: ALL_SEEN });
  await page.getByTestId("tab-profile").click();
  await page.getByTestId("row-support").click();
  await page.getByTestId("sup-new").click();
  await page.getByTestId("sup-form").getByRole("button", { name: "SCHEDULE_REMINDERS" }).click();
  await page.getByTestId("sup-subject").fill("Не пришло напоминание");
  await page.getByTestId("sup-message").fill("Вчера в 19:00 ничего не пришло.");
  await page.getByTestId("sup-send").click();
  await expect(page.getByTestId("toast")).toHaveText("Обращение TCK-3083 отправлено");
  const r = bff.last("POST", "/v1/support/tickets")!;
  expect(r.body).toMatchObject({ category: "SCHEDULE_REMINDERS", subject: "Не пришло напоминание", context: { client_version: "telegram-miniapp-1.0" } });
  await expect(page.getByTestId("tickets")).toContainText("Не пришло напоминание");
});

/** AT-14: deletion with the confirmation word; after 202 nothing more is called. */
test("delete the account and data", async ({ page }) => {
  const bff = await open(page, { onboarded: true, seen: ALL_SEEN });
  await page.getByTestId("tab-profile").click();
  await page.getByTestId("row-privacy").click();
  await page.getByTestId("to-delete").click();
  await expect(page.getByTestId("del-go")).toBeDisabled();
  await page.getByTestId("del-chk").check();
  await page.getByTestId("del-word").fill("удалить");
  await page.getByTestId("del-go").click();
  await expect(page.getByTestId("deletion-done")).toContainText("Удаляем данные");
  expect(bff.last("POST", "/v1/profile/delete-request")?.body).toEqual({ confirm_word: "УДАЛИТЬ" });
});

import { expect, test } from "@playwright/test";
import { UPDATE_1, UPDATE_2, WELCOME } from "./fixtures/data";
import { open, shot } from "./helpers";

/** AT-11: at every next login — the notes the learner has not seen (audience existing / all), each one once. */
test("updates at the next login: shown notes are marked seen on the server, the rest come back", async ({ page }) => {
  const bff = await open(page, { onboarded: true });
  const sheet = page.getByTestId("whats-new-updates");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Что изменилось" })).toBeVisible();
  await expect(sheet.getByText("С вашего прошлого входа")).toBeVisible();
  // newest first: «Центр уведомлений» (all), then «Ноябрь: график» (existing, 2 items) → 3 cards
  await expect(sheet.getByTestId("wn-card")).toContainText("Все сообщения — в приложении");
  await expect(sheet.getByTestId("wn-card")).toContainText("1 из 3");
  await expect(sheet.getByTestId("wn-more")).toHaveCount(0); // no route — no «Подробнее»
  await shot(page, "07_whats_new_updates");
  // close after the first card: only that note is seen
  await sheet.getByRole("button", { name: "Закрыть" }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(() => (bff.last("POST", "/v1/whats-new/seen")?.body as { release_note_ids: string[] } | undefined)?.release_note_ids).toEqual([UPDATE_2.id]);

  // next login: only the unseen note, its link leads to the schedule
  await page.reload();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("wn-card")).toContainText("Свои дни занятий");
  await expect(sheet.getByTestId("wn-card")).toContainText("1 из 2");
  await sheet.getByTestId("wn-more").click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("schedule-screen")).toBeVisible();
  await expect.poll(() => [...bff.seen[bff.active]!].sort()).toEqual([WELCOME.id, UPDATE_1.id, UPDATE_2.id].sort());

  // and then nothing at all
  await page.reload();
  await expect(page.getByTestId("home")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(sheet).toHaveCount(0);
  expect(bff.calls("GET", "/v1/whats-new").length).toBe(3);
});

test("no sheet when there is nothing new; the feed still lists every note", async ({ page }) => {
  await open(page, { onboarded: true, seen: [WELCOME.id, UPDATE_1.id, UPDATE_2.id] });
  await expect(page.getByTestId("home")).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.getByTestId("whats-new-updates")).toHaveCount(0);
  await page.getByTestId("news-card").click();
  await expect(page.getByTestId("news")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Центр уведомлений" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Знакомство" })).toBeVisible();
});

/**
 * Sprint 7 «Парные комнаты» (ADM-SOC-02, AT-76, AT-80): the list with filters (status, dates); a room — participants
 * with their side, role, turns, speaking seconds of each and minutes (counted, not charged), the AI cost and the course
 * of events WITHOUT the texts of the replies and WITHOUT assessments; a room that has not ended is stopped with step-up
 * and a reason; an ended one offers no stop and the server answers 409 ROOM_NOT_ACTIVE.
 */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { ROOM } from "./fixtures/social-data";

test("the list: newest first, filters by status and dates; «to» before «from» is refused without a request", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/pair_rooms");
  const rows = page.getByTestId("pr-rows").locator("tbody tr");
  await expect(rows).toHaveCount(7);
  await expect(rows.first()).toHaveAttribute("data-testid", `pr-${ROOM.waiting}`);
  await expect(page.getByTestId(`pr-${ROOM.live}`)).toContainText("В кафе: заказ на двоих");
  await expect(page.getByTestId(`pr-${ROOM.live}`)).toContainText("142 с");
  await page.getByTestId("pr-status").selectOption("in_progress");
  await expect(rows).toHaveCount(1);
  await page.getByTestId("pr-reset").click();
  await expect(rows).toHaveCount(7);
  await page.getByTestId("pr-from").fill("2099-12-10");
  await expect(page.getByTestId("pr-empty")).toBeVisible();
  const before = bff.calls("GET", "/pair-rooms").length;
  await page.getByTestId("pr-to").fill("2099-12-01");
  await expect(page.getByTestId("pr-filters")).toContainText("Дата «по» раньше даты «с»");
  await page.waitForTimeout(300);
  expect(bff.calls("GET", "/pair-rooms")).toHaveLength(before);
});

test("a room: participants and speaking seconds of each, the cost, events without texts; personal assessments isolated", async ({ page }) => {
  await openAs(page, "support@tilhero.local", `#/pair_rooms/${ROOM.live}`);
  const d = page.getByTestId("pr-room");
  await expect(d.getByTestId("pr-isolated")).toContainText("без реплик и оценок");
  await expect(d.getByTestId("prp-inviter-speak")).toContainText("142 с");
  await expect(d.getByTestId("prp-inviter-speak")).toContainText("60 %");
  await expect(d.getByTestId("prp-invitee-speak")).toContainText("96 с");
  await expect(d.getByTestId("pr-duration")).toHaveText("12:04");
  await expect(d.getByTestId("pr-cost")).toContainText("$0,012");
  await expect(d.getByTestId("pr-timeline").locator("tbody tr")).toHaveCount(9);
  await expect(d.getByTestId("pr-timeline")).toContainText("ход участника");
  await expect(d.getByTestId("pr-timeline")).toContainText("Тексты реплик и подсказок коуча видят только участники комнаты");
  // support has room.read, not room.manage: the stop is not offered
  await expect(d.getByTestId("pr-stop")).toHaveCount(0);
  await expect(d.getByTestId("pr-ro")).toContainText("room.manage");
});

test("stop: a reason, step-up, the same command repeated; the room is «stopped» with who and why; an ended room — no stop", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/pair_rooms/${ROOM.live}`);
  await page.getByTestId("pr-stop").click();
  const dlg = page.getByTestId("pr-stop-dialog");
  await dlg.locator("#cmd-reason").fill("Жалоба на грубость, дело модерации открыто");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Комната остановлена")).toBeVisible();
  const d = page.getByTestId("pr-room");
  await expect(d.getByTestId("pr-room-body")).toHaveAttribute("data-status", "stopped");
  await expect(d.getByTestId("pr-stopped")).toContainText("Тимур");
  await expect(d.getByTestId("pr-stopped")).toContainText("Жалоба на грубость, дело модерации открыто");
  await expect(d.getByTestId("pr-timeline").locator("tbody tr").last()).toHaveAttribute("data-kind", "stopped");
  await expect(d.getByTestId("pr-stop")).toHaveCount(0);
  const calls = bff.calls("POST", `/pair-rooms/${ROOM.live}/stop`);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.headers["idempotency-key"]).toBe(calls[0]!.headers["idempotency-key"]);
  expect(bff.social.audit.at(-1)).toMatchObject({ action: "pair_room.stopped" });
  await page.getByTestId("drawer-close").click();
  await expect(page.getByTestId(`pr-${ROOM.live}`)).toHaveAttribute("data-status", "stopped");
  // a finished room: no stop
  await page.getByTestId(`pr-open-${ROOM.finished}`).click();
  await expect(page.getByTestId("pr-room-body")).toHaveAttribute("data-status", "finished");
  await expect(page.getByTestId("pr-stop")).toHaveCount(0);
});

test("a room ended in between: the server answers ROOM_NOT_ACTIVE and the card is re-read", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/pair_rooms/${ROOM.paused}`);
  await expect(page.getByTestId("pr-stop")).toBeVisible();
  bff.social.rooms.find((r) => r.room_id === ROOM.paused)!.status = "abandoned";
  await page.getByTestId("pr-stop").click();
  const dlg = page.getByTestId("pr-stop-dialog");
  await dlg.locator("#cmd-reason").fill("Участник не вернулся, остановить вручную");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(dlg).toContainText("Комната уже завершена — остановка не нужна");
  await dlg.getByRole("button", { name: "Отмена" }).click();
  await expect(page.getByTestId("pr-room-body")).toHaveAttribute("data-status", "abandoned");
  await expect(page.getByTestId("pr-stop")).toHaveCount(0);
});

/** AT-25: support desk — queue, take, reply vs internal note (visually distinct), statuses, escalation, RU/UZ templates. */
import { expect, test } from "@playwright/test";
import { openAs } from "./helpers";

test("queue sorted by SLA; take; reply and internal note are different; the learner never sees the note", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local", "#/support");
  const rows = page.locator("[data-ticket]");
  await expect(rows.first()).toHaveAttribute("data-ticket", "TCK-1042"); // breached first
  await expect(page.getByTestId("support-count")).toHaveText("3");
  // the sidebar counter is a background poll
  expect(bff.calls("GET", "/support/stats").every((r) => r.headers["x-background"] === "1")).toBe(true);

  await page.getByTestId("take-TCK-1042").click();
  await expect(page.getByTestId("thread")).toBeVisible();
  await expect(page.getByTestId("status-IN_PROGRESS")).toHaveAttribute("aria-current", "true");

  // internal note: marker-yellow composer, lock label, never «sent to the learner»
  await page.getByTestId("composer-mode").getByRole("button", { name: "Внутренняя заметка" }).click();
  await expect(page.getByTestId("composer")).toHaveClass(/is-note/);
  await page.getByTestId("composer-text").fill("Проверить рубрику 1.3 — похоже на ложную коррекцию");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("msg-note")).toContainText("ложную коррекцию");
  await expect(page.getByTestId("msg-note")).toContainText("Видно только сотрудникам");

  // reply in the learner's language (RU) from a template
  await page.getByTestId("composer-mode").getByRole("button", { name: "Ответ ученику" }).click();
  await expect(page.getByTestId("composer")).not.toHaveClass(/is-note/);
  await page.getByTestId("tpl-btn").click();
  await page.getByRole("menuitem", { name: /Переоценка/ }).click();
  await expect(page.getByTestId("composer-text")).toHaveValue(/пересчитали результат урока/);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("msg-op").last()).toContainText("пересчитали");

  const sent = bff.calls("POST", /\/messages$/);
  expect(sent.map((r) => (r.body as { visibility: string }).visibility)).toEqual(["internal", "public"]);
  expect(sent.every((r) => r.headers["idempotency-key"])).toBe(true);

  // what the learner sees: no internal note
  await page.getByTestId("client-view-btn").click();
  await expect(page.getByTestId("client-feed")).toContainText("пересчитали");
  await expect(page.getByTestId("client-feed")).not.toContainText("ложную коррекцию");
  await page.getByTestId("drawer-close").click();

  // statuses and escalation
  await page.getByTestId("status-WAITING_CUSTOMER").click();
  await expect(page.getByTestId("status-WAITING_CUSTOMER")).toHaveAttribute("aria-current", "true");
  await page.getByTestId("esc-btn").click();
  await page.getByTestId("esc-assessment_review").click();
  await page.locator("#cmd-reason").fill("Проверить оценку грамматики в L-014");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("escalation")).toContainText("Проверка оценки");
});

test("UZ reply templates: the learner's language is preselected; an empty UZ text falls back to RU", async ({ page }) => {
  await openAs(page, "support@tilhero.local", "#/support/TCK-1043");
  await expect(page.getByTestId("tpl-lang").getByRole("button", { name: "UZ" })).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("tpl-btn").click();
  await page.getByRole("menuitem", { name: /Приветствие/ }).click();
  await expect(page.getByTestId("composer-text")).toHaveValue(/Assalomu alaykum! .*TCK-1043/);
  await page.getByTestId("tpl-btn").click();
  await expect(page.getByRole("menuitem", { name: /Часовой пояс/ })).toContainText("вставится RU");
});

test("read-only role sees the thread but not the composer", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/support/TCK-1042");
  await expect(page.getByTestId("thread")).toBeVisible();
  await expect(page.getByTestId("composer-locked")).toBeVisible();
});

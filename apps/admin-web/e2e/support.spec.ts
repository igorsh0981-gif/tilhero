import { expect, test } from "@playwright/test";
import { nav, openAs, shot } from "./helpers";

test("queue: live SLA timers tick every second, breached first; take a ticket", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local", "#/support");
  const rows = page.locator("[data-ticket]");
  await expect(rows.first()).toBeVisible();
  // breached (TCK-3069, TCK-3074) come first, then the nearest deadline
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-ticket")))).toEqual(["TCK-3069", "TCK-3074", "TCK-3072", "TCK-3081", "TCK-3071", "TCK-3080"]);
  await expect(rows.first().locator('[data-sla="over"]')).toContainText("−");
  const chip = page.locator('[data-ticket="TCK-3081"] .sla-v');
  const t1 = await chip.textContent();
  await expect.poll(() => chip.textContent(), { timeout: 3000 }).not.toBe(t1);
  await expect(page.getByTestId("sup-status")).toContainText("Открытые6");
  await shot(page, "06-support-queue");

  await page.getByTestId("take-TCK-3074").click();
  await expect(page.getByTestId("thread")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("TCK-3074");
  expect(bff.calls("POST", /\/take$/)[0]!.headers["x-csrf-token"]).toBeTruthy();
});

test("thread: reply to the customer and an internal note look different; client view never shows notes (A42)", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local", "#/support/TCK-3081");
  await expect(page.getByTestId("thread-subject")).toHaveText("Не открывается ссылка на билет");
  await expect(page.getByTestId("msg-note")).toContainText("Видно только сотрудникам");
  await expect(page.getByTestId("ctx-event")).toContainText("evt_f1_auh_2026");

  // internal note
  await page.getByTestId("composer-mode").getByRole("button", { name: "Внутренняя заметка" }).click();
  await expect(page.getByTestId("composer")).toHaveClass(/is-note/);
  await page.getByTestId("composer-text").fill("Провайдер подтвердил гео-редирект, тикет у них PRV-88.");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("msg-note")).toHaveCount(2);
  const note = bff.calls("POST", /\/messages$/)[0]!;
  expect(note.body).toEqual({ text: "Провайдер подтвердил гео-редирект, тикет у них PRV-88.", visibility: "internal" });
  expect(note.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(note.headers["x-csrf-token"]).toMatch(/^csrf-/);

  // AI draft (stub) → insert → reply
  await page.getByTestId("composer-mode").getByRole("button", { name: "Ответ клиенту" }).click();
  await page.getByTestId("ai-draft-btn").click();
  await expect(page.getByTestId("ai-draft")).toContainText("шаблон");
  await page.getByTestId("ai-insert").click();
  await expect(page.getByTestId("composer-text")).toHaveValue(/TCK-3081/);
  await page.getByTestId("composer-text").fill("Игорь, здравствуйте! Откройте официальную страницу напрямую: https://www.abudhabigp.com/en/tickets");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("msg-op")).toHaveCount(1);
  const reply = bff.calls("POST", /\/messages$/)[1]!;
  expect(reply.body).toMatchObject({ visibility: "public" });
  expect(reply.headers["idempotency-key"]).not.toBe(note.headers["idempotency-key"]);
  // a public reply hands the ticket to the customer: SLA pauses
  await expect(page.locator(".st-conv-h .pill").first()).toContainText("Ждём ответа");
  await expect(page.locator('.st-conv-h [data-sla="paused"]')).toBeVisible();
  await shot(page, "06c-support-thread");

  // the client view: the reply is there, internal notes are not
  await page.getByTestId("client-view-btn").click();
  const feed = page.getByTestId("client-feed");
  await expect(feed).toContainText("Откройте официальную страницу");
  await expect(feed).not.toContainText("PRV-88");
  await expect(feed).not.toContainText("гео-редирект");
  await shot(page, "06e-support-client-view");
});

test("thread: status flow allows only valid transitions; templates; escalation with a reason", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local", "#/support/TCK-3081");
  // IN_PROGRESS → only WAITING_CUSTOMER / RESOLVED are enabled
  await expect(page.getByTestId("status-NEW")).toBeDisabled();
  await expect(page.getByTestId("status-CLOSED")).toBeDisabled();
  await page.getByTestId("status-RESOLVED").click();
  await expect(page.getByTestId("toasts")).toContainText("Статус: Решено");
  expect(bff.calls("PATCH", /\/support\/tickets\//)[0]!.body).toEqual({ status: "RESOLVED" });
  await expect(page.getByTestId("status-CLOSED")).toBeEnabled();

  await page.getByTestId("tpl-btn").click();
  await page.getByRole("menuitem", { name: /Ссылка провайдера/ }).click();
  await expect(page.getByTestId("composer-text")).toHaveValue(/abudhabigp\.com/);

  await page.getByTestId("esc-btn").click();
  await page.getByTestId("esc-provider_issue").click();
  await page.getByTestId("esc-confirm").locator("textarea").fill("Гео-редирект на sold-out");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("escalation")).toContainText("Проблема провайдера");
  await shot(page, "06d-support-escalated");
});

test("SLA settings: edit a rule with a reason (support.manage)", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/support");
  await page.getByTestId("sup-tab-sla").click();
  await expect(page.getByTestId("sla-table")).toBeVisible();
  await page.getByTestId("sla-edit-*-high").click();
  await page.locator("#sla-first").fill("45");
  await page.locator("#sla-res").fill("30");
  await page.getByTestId("sla-save").click();
  await expect(page.getByTestId("sla-edit")).toContainText("больше срока первого ответа");
  await page.locator("#sla-res").fill("420");
  await page.locator("#sla-reason").fill("Ускоряем первый ответ для high");
  await page.getByTestId("sla-save").click();
  await expect(page.getByTestId("sla-edit")).toBeHidden();
  const put = bff.calls("PUT", "/support/sla-policies")[0]!;
  expect(put.body).toMatchObject({ reason: "Ускоряем первый ответ для high" });
  expect((put.body as { items: Array<{ category: string; priority: string; first_response_minutes: number }> }).items.find((x) => x.category === "*" && x.priority === "high")!.first_response_minutes).toBe(45);
  await shot(page, "06g-support-sla");
});

test("support role: users card is reachable from the ticket context", async ({ page }) => {
  await openAs(page, "support@tilhero.local", "#/support/TCK-3081");
  await page.getByTestId("ctx-user").getByRole("button").click();
  await expect(page.getByTestId("user-card")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Пользователи");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("user-card")).toBeHidden();
  await nav(page, "support");
});

test("409 SESSION_ROTATED (step-up in another tab): the command is repeated once with the new CSRF, no sign-out", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local", "#/support/TCK-3081", { rotateOnce: "PATCH /support/tickets/7e000000-0000-4000-8000-000000003081" });
  await page.getByTestId("status-RESOLVED").click();
  await expect(page.getByTestId("toasts")).toContainText("Статус: Решено");
  const patches = bff.calls("PATCH", "/support/tickets/7e000000-0000-4000-8000-000000003081");
  expect(patches).toHaveLength(2);
  expect(patches[1]!.headers["x-csrf-token"]).toMatch(/^csrf-rotated-/);
  expect(patches[0]!.headers["x-csrf-token"]).not.toBe(patches[1]!.headers["x-csrf-token"]);
  await expect(page.getByTestId("shell")).toBeVisible();
  await expect(page.getByTestId("login-creds")).toHaveCount(0);
  // the next command already uses the refreshed token
  await page.getByTestId("tk-prio").selectOption("urgent");
  await expect.poll(() => bff.calls("PATCH", "/support/tickets/7e000000-0000-4000-8000-000000003081").length).toBe(3);
  expect(bff.calls("PATCH", /\/support\/tickets\//).at(-1)!.headers["x-csrf-token"]).toBe(patches[1]!.headers["x-csrf-token"]);
});

/**
 * Sprint 6 «Геймификация → Правила» (ADM-GAME-01, AT-71): draft → check → activation with step-up and a comment ≥ 10;
 * errors of the client mirror and of the gamification validator are shown at their fields; the activation waits for a
 * successful check of the saved draft; history and the diff; rollback of an archived version creates a new version;
 * 409 DRAFT_CONFLICT when someone saved in between.
 */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";

test("draft from the active version: client errors at the fields, the server check, activation with step-up", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/game/rules");
  await expect(page.getByTestId("gr-active")).toHaveText(/v2/);
  await expect(page.getByTestId("gr-editor")).toHaveAttribute("data-editable", "false");
  await expect(page.getByTestId("gr-readonly")).toBeVisible();
  await page.getByTestId("gr-new-draft").click();
  await expect(page.getByTestId("gr-draft")).toHaveText(/v3/);
  expect(bff.calls("PUT", "/game/rules/draft")[0]!.headers["if-match"]).toBeUndefined();
  await expect(page.getByTestId("gr-activate")).toBeDisabled();
  await expect(page.getByTestId("gr-notes")).toHaveAttribute("data-gate", "not_validated");

  // client mirror: a level below the previous one and a cap below the largest single award
  await page.getByTestId("gr-levels-2").fill("90");
  await page.getByTestId("gr-caps-xp_per_day").fill("20");
  const errs = page.getByTestId("gr-errors");
  await expect(errs).toContainText("Ошибки: 2");
  await expect(errs.locator('[data-path="levels[2]"]')).toContainText("Каждое значение больше предыдущего");
  await expect(errs.locator('[data-path="caps.xp_per_day"]')).toContainText("Лимит меньше самой большой разовой награды");
  await expect(page.getByTestId("gr-caps-xp_per_day")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("grs-caps")).toContainText("ошибок: 1");
  // a link of the panel focuses its field
  await errs.locator('[data-path="levels[2]"] button').click();
  await expect(page.getByTestId("gr-levels-2")).toBeFocused();
  // a non-number cannot be saved
  await page.getByTestId("gr-earn-reading-til").fill("пять");
  await page.getByTestId("gr-save").click();
  await expect(page.getByText("Нечисловых значений: 1 — исправьте перед сохранением").first()).toBeVisible();
  expect(bff.calls("PUT", "/game/rules/draft")).toHaveLength(1);

  // fix the client errors but leave a problem only the server sees: templates per audience (per_day 5)
  await page.getByTestId("gr-levels-2").fill("250");
  await page.getByTestId("gr-caps-xp_per_day").fill("300");
  await page.getByTestId("gr-earn-reading-til").fill("8");
  await page.getByTestId("gr-quests-per_day").fill("8");
  await expect(page.getByTestId("gr-errors")).toContainText("Шаблонов для детей меньше, чем заданий в день");
  await page.getByTestId("gr-quests-per_day").fill("3");
  await expect(page.getByTestId("gr-errors")).toHaveCount(0);
  await page.getByTestId("gr-hero-stage_thresholds-1").fill("12");
  await expect(page.getByTestId("gr-warnings")).toContainText("Порог 2-й ступени выше 10 навыков");
  await page.getByTestId("gr-comment").fill("Чтение даёт больше тилов");
  await page.getByTestId("gr-save").click();
  await expect(page.getByText("Черновик v3 сохранён")).toBeVisible();
  const put = bff.calls("PUT", "/game/rules/draft")[1]!;
  expect(put.headers["if-match"]).toBeTruthy();
  expect((put.body as { payload: { earn: { reading: { til: number } } } }).payload.earn.reading.til).toBe(8);
  await expect(page.getByTestId("gr-activate")).toBeDisabled();

  await page.getByTestId("gr-validate").click();
  await expect(page.getByTestId("gr-check-ok")).toContainText("Предупреждений: 1");
  await expect(page.getByTestId("gr-check-state")).toHaveAttribute("data-state", "ok");
  await expect(page.getByTestId("gr-activate")).toBeEnabled();

  // the diff against the active version
  await page.getByTestId("grt-diff").click();
  await expect(page.getByTestId("gr-diff-table").locator('tr[data-path="earn.reading.til"]')).toContainText("8");
  await expect(page.getByTestId("gr-diff-table").locator('tr[data-path="hero.stage_thresholds[1]"]')).toBeVisible();

  await page.getByTestId("gr-activate").click();
  const dlg = page.getByTestId("gr-activate-dialog");
  await expect(dlg.getByTestId("gr-activate-changes")).toContainText("Изменений относительно активной версии: 2");
  await expect(dlg.getByTestId("gr-activate-warnings")).toBeVisible();
  await dlg.locator("#cmd-reason").fill("коротко");
  await dlg.getByTestId("confirm-ok").click();
  await expect(dlg).toContainText("не короче 10");
  await dlg.locator("#cmd-reason").fill("Ноябрь: чтение даёт больше тилов");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Правила v3 активированы")).toBeVisible();
  await expect(page.getByTestId("gr-active")).toHaveText(/v3/);
  await expect(page.getByTestId("gr-draft")).toHaveCount(0);
  expect(bff.game.audit.map((a) => a.action)).toEqual(["game.rules_draft_saved", "game.rules_draft_saved", "game.rules_activated"]);
  expect(bff.game.audit.at(-1)!.reason).toBe("Ноябрь: чтение даёт больше тилов");

  await page.getByTestId("grt-history").click();
  await expect(page.getByTestId("grh-3")).toHaveAttribute("data-status", "active");
  await expect(page.getByTestId("grh-2")).toHaveAttribute("data-status", "archived");
});

test("errors of the server validator land at their fields (pydantic paths); the draft changed after the check cannot be activated", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/game/rules");
  await page.getByTestId("gr-new-draft").click();
  await expect(page.getByTestId("gr-draft")).toBeVisible();
  // a key the client does not show: the server answers extra_forbidden at the root path
  const d = bff.game.rules.find((r) => r.status === "draft")!;
  (d.payload as unknown as Record<string, unknown>).leagues = { size: 30 };
  await page.getByTestId("gr-validate").click();
  await expect(page.getByTestId("gr-errors")).toContainText("Лишний параметр — такого в правилах нет");
  await expect(page.getByTestId("gr-check-state")).toHaveAttribute("data-state", "bad");
  await expect(page.getByTestId("gr-activate")).toBeDisabled();
  // server path «levels.1» with a client-invisible change reaches the field levels[1]
  delete (d.payload as unknown as Record<string, unknown>).leagues;
  d.payload.levels[1] = 0;
  await page.getByTestId("gr-validate").click();
  await expect(page.getByTestId("gr-errors").locator('[data-path="levels[1]"]')).toContainText("Каждое значение больше предыдущего");
  await expect(page.getByTestId("gr-levels-1")).toHaveAttribute("aria-invalid", "true");
});

test("the draft changed on the server after the check: activation answers 409 RULES_NOT_VALIDATED and the draft is re-read", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/game/rules");
  await page.getByTestId("gr-new-draft").click();
  await page.getByTestId("gr-validate").click();
  await expect(page.getByTestId("gr-check-ok")).toBeVisible();
  // another staff member saved the draft after this check (its updated_at moved on)
  const d = bff.game.rules.find((r) => r.status === "draft")!;
  d.updated_at = new Date(Date.now() + 60_000).toISOString();
  await page.getByTestId("gr-activate").click();
  const dlg = page.getByTestId("gr-activate-dialog");
  await dlg.locator("#cmd-reason").fill("Активируем проверенный черновик");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(dlg).toContainText("Черновик менялся после проверки — нажмите «Проверить» ещё раз");
  await dlg.getByRole("button", { name: "Отмена" }).click();
  await expect(page.getByTestId("gr-check-state")).toHaveAttribute("data-state", "stale");
  await expect(page.getByTestId("gr-activate")).toBeDisabled();
  expect(bff.game.rules.find((r) => r.status === "active")!.version).toBe(2);
});

test("rollback of an archived version from the history creates a new active version", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/game/rules");
  await page.getByTestId("grt-history").click();
  await expect(page.getByTestId("grh-rollback-2")).toHaveCount(0); // the active one cannot be rolled back to
  await page.getByTestId("grh-open-1").click();
  const drawer = page.getByTestId("gr-version");
  await expect(drawer.getByTestId("gr-version-body")).toHaveAttribute("data-status", "archived");
  await expect(drawer.getByTestId("gr-version-diff").locator('tr[data-path="earn.reading.xp"]')).toContainText("15");
  await drawer.getByTestId("gr-version-rollback").click();
  const dlg = page.getByTestId("gr-rollback-dialog");
  await expect(dlg).toContainText("Будет создана версия v3 с правилами v1");
  await dlg.locator("#cmd-reason").fill("Возвращаем начальные правила");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Активна v3 — откат к правилам v1")).toBeVisible();
  await expect(page.getByTestId("gr-active")).toHaveText(/v3/);
  const v3 = bff.game.rules.find((r) => r.version === 3)!;
  expect(v3.based_on).toBe(1);
  expect(v3.payload.earn.reading.xp).toBe(10);
  expect(bff.game.rules.find((r) => r.version === 2)!.status).toBe("archived");
});

test("rollback waits while a draft exists («сначала удалите черновик»); a double click deletes the draft once", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/game/rules");
  await page.getByTestId("gr-new-draft").click();
  await expect(page.getByTestId("gr-draft")).toHaveText(/v3/);
  await page.getByTestId("grt-history").click();
  await expect(page.getByTestId("grh-rollback-1")).toBeDisabled();
  await expect(page.getByTestId("gr-rollback-blocked")).toHaveText(/Откат недоступен, пока есть черновик v3: сначала удалите черновик/);
  await page.getByTestId("grh-open-1").click();
  await expect(page.getByTestId("gr-version-rollback")).toBeDisabled();
  await page.keyboard.press("Escape");

  // «Удалить черновик»: busy while the request runs, a double click sends one DELETE
  await page.getByTestId("gr-delete").click();
  await page.getByTestId("gr-delete-ok").dblclick();
  await expect(page.getByText("Черновик v3 удалён")).toBeVisible();
  expect(bff.calls("DELETE", "/game/rules/draft")).toHaveLength(1);
  await page.getByTestId("grt-history").click();
  await expect(page.getByTestId("grh-rollback-1")).toBeEnabled();
  await expect(page.getByTestId("gr-rollback-blocked")).toHaveCount(0);

  // another staff member opened a draft in between: the server answers 409 RULES_STATE, the text says what to do
  const active = bff.game.rules.find((r) => r.status === "active")!;
  bff.game.rules.push({ ...JSON.parse(JSON.stringify(active)), version: 4, status: "draft", activated_by: null, activated_at: null, validated_at: null });
  await page.getByTestId("grh-rollback-1").click();
  const dlg = page.getByTestId("gr-rollback-dialog");
  await dlg.locator("#cmd-reason").fill("Возвращаем начальные правила");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(dlg).toContainText("сначала удалите черновик");
  expect(bff.game.rules.find((r) => r.status === "active")!.version).toBe(2);
});

test("a comment longer than 300 characters is refused in the command and in the draft form", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/game/rules");
  await page.getByTestId("gr-new-draft").click();
  await expect(page.getByTestId("gr-draft")).toHaveText(/v3/);
  await page.getByTestId("gr-comment").fill("x".repeat(301));
  await expect(page.locator("#gr-comment-n")).toContainText("301");
  await page.getByTestId("gr-save").click();
  await expect(page.getByText("Комментарий — от 10 до 300 символов").first()).toBeVisible();
  expect(bff.calls("PUT", "/game/rules/draft")).toHaveLength(1);
  await page.getByTestId("gr-comment").fill("");
  await page.getByTestId("gr-validate").click();
  await expect(page.getByTestId("gr-check-state")).toHaveAttribute("data-state", "ok");
  await page.getByTestId("gr-activate").click();
  const dlg = page.getByTestId("gr-activate-dialog");
  await dlg.locator("#cmd-reason").fill("y".repeat(301));
  await expect(dlg.getByTestId("cmd-reason-count")).toHaveText("301/300");
  await dlg.getByTestId("confirm-ok").click();
  await expect(dlg).toContainText("Причина — не длиннее 300 символов");
  expect(bff.calls("POST", "/game/rules/draft/activate")).toHaveLength(0);
});

test("someone saved the draft in between: 409 DRAFT_CONFLICT → reload", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/game/rules", { game: { draftConflictOnce: true } });
  await page.getByTestId("gr-new-draft").click();
  await page.getByTestId("gr-freeze-price_til").fill("45");
  await page.getByTestId("gr-save").click();
  await expect(page.getByTestId("gr-conflict")).toBeVisible();
  await page.getByTestId("gr-reload").click();
  await expect(page.getByTestId("gr-conflict")).toHaveCount(0);
  await expect(page.getByTestId("gr-freeze-price_til")).toHaveValue("40");
  expect(bff.calls("PUT", "/game/rules/draft").length).toBe(2);
});

test("a staff member without game.manage / game.publish reads the rules but gets no commands", async ({ page }) => {
  await openAs(page, "support@tilhero.local", "#/game/rules");
  await expect(page.getByTestId("gr-editor")).toHaveAttribute("data-editable", "false");
  await expect(page.getByTestId("gr-new-draft")).toHaveCount(0);
  await expect(page.getByTestId("gr-activate")).toHaveCount(0);
  await expect(page.getByTestId("gr-notes")).toContainText("game.manage");
  await expect(page.getByTestId("gr-notes")).toContainText("game.publish");
  await expect(page.getByTestId("gr-earn-lesson-xp")).toBeDisabled();
  await page.getByTestId("grt-history").click();
  await expect(page.getByTestId("grh-rollback-1")).toHaveCount(0);
});

/** AT-20 / AT-21 / AT-22: notification templates and campaigns. */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { TOTP } from "./fixtures/data";

test("template: edit → unknown placeholder highlighted → fix → save version → activate with TOTP", async ({ page }) => {
  const bff = await openAs(page, "comms@tilhero.local", "#/news/templates");
  await expect(page.getByTestId("tpl-detail")).toBeVisible();
  await expect(page.getByTestId("tpl-title")).toHaveText("Напоминание о занятии");
  // the editor starts from the active version v2
  await expect(page.getByTestId("tpl-body-ru")).toHaveValue(/повторения слов/);

  await page.getByTestId("tpl-body-ru").fill("В {slot_time} — {duration} английского. {streak_days} дней подряд!");
  // the unknown placeholder is highlighted at once, under the field and on the RU tab
  await expect(page.getByTestId("tpl-body-ru")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert").filter({ hasText: "{streak_days}" })).toBeVisible();
  await expect(page.getByTestId("tpl-lang-ru")).toContainText("1");
  await page.getByTestId("tpl-note").fill("Короче, без серии");
  await page.getByTestId("tpl-save").click();
  expect(bff.calls("POST", /\/versions$/)).toHaveLength(0);

  // fix: insert a known placeholder with the chip (at the caret)
  await page.getByTestId("tpl-body-ru").fill("В {slot_time} — {duration} английского. ");
  await page.getByTestId("tpl-body-ru").focus();
  await page.getByTestId("ph-learner_name").click();
  await expect(page.getByTestId("tpl-body-ru")).toHaveValue("В {slot_time} — {duration} английского. {learner_name}");
  await expect(page.getByTestId("tpl-body-ru")).not.toHaveAttribute("aria-invalid", "true");
  // live preview with sample values
  await expect(page.getByTestId("tg-preview")).toContainText("В 19:30 — 20 минут английского. Мадина");

  await page.getByTestId("tpl-save").click();
  await expect(page.getByTestId("tpl-v-3")).toContainText("черновик");
  expect(bff.calls("POST", "/notifications/templates/reminder.lesson/versions")[0]!.body).toMatchObject({ note: "Короче, без серии" });

  // test send — only to the test chats
  await page.getByTestId("ts-ver").selectOption("3");
  await page.getByTestId("ts-send").click();
  await expect(page.getByTestId("ts-result")).toContainText("delivery");

  // activation is privileged: reason + fresh TOTP
  await page.getByTestId("tpl-activate-3").click();
  await page.locator("#cmd-reason").fill("Новый текст напоминания");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("tpl-v-3")).toContainText("активна");
  await expect(page.getByTestId("tpl-v-2")).toContainText("в архиве");
  expect(bff.audit[0]!.action).toBe("template.activated");
});

test("server TEMPLATE_INVALID {fields} highlights the field; child templates are checked for pressure words", async ({ page }) => {
  await openAs(page, "comms@tilhero.local", "#/news/templates");
  await page.getByTestId("tpl-reminder.lesson.kid").click();
  await expect(page.getByTestId("tpl-title")).toContainText("ребёнка");
  await page.getByTestId("tpl-body-ru").fill("Не потеряй серию — урок ждёт!");
  await expect(page.getByTestId("tpl-body-ru")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert").filter({ hasText: "без давления" })).toBeVisible();

  // the server is the authority: 422 TEMPLATE_INVALID {fields:[{path, reason}]} → that field, on its language tab
  await page.route("**/admin/v1/notifications/templates/*/versions", (route) =>
    route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ code: "TEMPLATE_INVALID", message: "x", trace_id: "t", details: { fields: [{ path: "texts.uz.body", reason: "pressure_words" }] } }) }),
  );
  await page.getByTestId("tpl-body-ru").fill("Короткий урок с героем ждёт.");
  await page.getByTestId("tpl-note").fill("Мягче для детей");
  await page.getByTestId("tpl-save").click();
  await expect(page.getByTestId("tpl-lang-uz")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("tpl-body-uz")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert").filter({ hasText: "Тексты шаблона не прошли проверку" })).toBeVisible();
});

test("campaign: estimate → schedule with TOTP → emergency stop", async ({ page }) => {
  const bff = await openAs(page, "comms@tilhero.local", "#/news/campaigns");
  await expect(page.getByTestId("cmp-detail")).toBeVisible();
  // the draft «Ноябрь: вернуться к урокам»: segment RU+UZ, adults, onboarded, inactive 14 days
  await page.getByTestId("cmp-age-teens").check();
  await page.getByTestId("cmp-save").click();
  await expect(page.getByText("сохранён")).toBeVisible();
  const patch = bff.calls("PATCH", /\/notifications\/campaigns\//)[0]!;
  expect(patch.body).toMatchObject({ expected_version: 2, segment: { age: ["teens", "adults"], onboarded: true, active_days: -14 } });

  await page.getByTestId("cmp-estimate-btn").click();
  await expect(page.getByTestId("cmp-est-audience")).toHaveText(/1\s840/);

  await page.getByTestId("cmp-schedule").click();
  await page.getByTestId("cmp-when-at").check();
  await page.locator("#cmd-reason").fill("Возвращаем неактивных учеников");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("cmp-detail")).toContainText("в расписании");
  const sch = bff.calls("POST", /\/schedule$/);
  expect(sch).toHaveLength(2);
  expect(sch[1]!.headers["idempotency-key"]).toBe(sch[0]!.headers["idempotency-key"]);
  expect(sch[1]!.body).toMatchObject({ expected_version: 3, reason: "Возвращаем неактивных учеников" });

  // the dispatcher picked it up → live statistics; then the emergency stop
  bff.startSending("e1000000-0000-4000-8000-000000000003");
  await page.getByTestId("cmp-open-e1000000-0000-4000-8000-000000000002").click();
  await page.getByTestId("cmp-open-e1000000-0000-4000-8000-000000000003").click();
  await expect(page.getByTestId("cmp-stats")).toBeVisible();
  await expect(page.getByTestId("cmp-s-sent")).toHaveText("640");
  await page.getByTestId("cmp-stop").click();
  await page.locator("#cmd-reason").fill("Ошибка в тексте UZ");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("cmp-detail")).toContainText("остановлена");
  expect(bff.audit[0]!.action).toBe("campaign.stopped");
});

test("new campaign: RU and UZ required, only {learner_name}, children never in the segment", async ({ page }) => {
  const bff = await openAs(page, "comms@tilhero.local", "#/news/campaigns");
  await page.getByTestId("cmp-new").click();
  await page.getByTestId("cmp-title").fill("Тест: новые уроки");
  await page.getByTestId("cmp-t-ru").fill("{learner_name}, новые уроки");
  await page.getByTestId("cmp-b-ru").fill("Привет, {first_name}!");
  await expect(page.getByTestId("cmp-b-ru")).toHaveAttribute("aria-invalid", "true");
  await page.getByTestId("cmp-b-ru").fill("Мы добавили уроки про путешествия.");
  await page.getByTestId("cmp-save").click();
  await expect(page.getByTestId("cmp-lang-uz")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("cmp-t-uz")).toHaveAttribute("aria-invalid", "true");
  await page.getByTestId("cmp-t-uz").fill("{learner_name}, yangi darslar");
  await page.getByTestId("cmp-b-uz").fill("Sayohat haqida darslar qoʻshdik.");
  await expect(page.getByText("дети 6–13 — никогда")).toBeVisible();
  await page.getByTestId("cmp-save").click();
  await expect(page.getByTestId("cmp-detail")).toContainText("Тест: новые уроки");
  const c = bff.calls("POST", "/notifications/campaigns")[0]!;
  expect(c.headers["idempotency-key"]).toBeTruthy();
  expect((c.body as { segment: { age?: string[] } }).segment.age).not.toContain("kids");
});

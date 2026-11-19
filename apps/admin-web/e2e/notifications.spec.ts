/** AT-20 / AT-21 / AT-22: notification templates and campaigns. */
import { expect, test, type Page } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { DAY, HOUR, MIN, TOTP } from "./fixtures/data";

/** «YYYY-MM-DDTHH:mm» for <input type="datetime-local"> in the BROWSER's time zone (Asia/Tashkent in the config). */
const localAt = (page: Page, offsetMs: number) =>
  page.evaluate((o) => {
    const d = new Date(Date.now() + o);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }, offsetMs);

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
  // who scheduled and who stopped — names from staff/lookup, not UUIDs (review T2-6)
  await expect(page.getByTestId("cmp-stopped-by")).toContainText("Остановлена Дилноза");
  await expect(page.getByTestId("cmp-stopped-by")).toContainText("Ошибка в тексте UZ");
  await expect(page.getByTestId("cmp-scheduled-by")).toContainText("Запланировал Дилноза");
  await expect(page.getByTestId("cmp-detail")).not.toContainText("0b6c3e1a-");
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

test("schedule (T2-2, D2-03): explicit choice; a past time → error at the field, inactive button; «Send now» passes null", async ({ page }) => {
  const bff = await openAs(page, "comms@tilhero.local", "#/news/campaigns");
  await expect(page.getByTestId("cmp-detail")).toBeVisible();
  await page.getByTestId("cmp-schedule").click();
  const ok = page.getByTestId("confirm-ok");
  // nothing is preselected: the operator has to choose
  await expect(page.getByTestId("cmp-when-hint")).toBeVisible();
  await expect(ok).toBeDisabled();

  // the review scenario: only the hours were changed on a date that is already today → the time has passed
  await page.getByTestId("cmp-when-at").check();
  await page.getByTestId("cmp-at").fill(await localAt(page, -8 * HOUR));
  await expect(page.getByTestId("cmp-at")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#cmp-at-err")).toContainText("уже прошло");
  await expect(page.getByTestId("cmp-starts")).toHaveCount(0);
  await expect(ok).toBeDisabled();
  // less than 2 minutes ahead is refused too (notifications would send it «now»)
  await page.getByTestId("cmp-at").fill(await localAt(page, 1 * MIN));
  await expect(page.locator("#cmp-at-err")).toContainText("уже прошло");
  await expect(ok).toBeDisabled();
  // beyond 30 days
  await page.getByTestId("cmp-at").fill(await localAt(page, 31 * DAY));
  await expect(page.locator("#cmp-at-err")).toContainText("30 дней");
  await expect(ok).toBeDisabled();
  // tomorrow: valid, the summary says when sending starts
  await page.getByTestId("cmp-at").fill(await localAt(page, DAY));
  await expect(page.locator("#cmp-at-err")).toHaveCount(0);
  await expect(page.getByTestId("cmp-starts")).toContainText("Отправка начнётся");
  await expect(ok).toBeEnabled();

  // explicit «Send now» → send_at = null: the server starts it by its own clock, the answer is already «идёт отправка»
  await page.getByTestId("cmp-when-now").check();
  await expect(page.getByTestId("cmp-starts")).toContainText("Рассылка начнётся сразу после подтверждения");
  await page.locator("#cmd-reason").fill("Срочно: новые уроки уже доступны");
  await ok.click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("cmp-confirm")).toHaveCount(0);
  await expect(page.getByTestId("cmp-detail").locator(".pill").first()).toHaveText("идёт отправка");
  await expect(page.getByTestId("cmp-stats")).toContainText("старт");
  await expect(page.getByTestId("cmp-scheduled-by")).toContainText("Запланировал Дилноза");
  await expect(page.getByText("«Ноябрь: вернуться к урокам»: отправка началась")).toBeVisible();
  const sch = bff.calls("POST", /\/schedule$/);
  expect(sch.length).toBeGreaterThan(0);
  for (const c of sch) expect((c.body as { send_at: unknown }).send_at).toBeNull();
  expect(sch.at(-1)!.body).toEqual({ expected_version: 2, send_at: null, reason: "Срочно: новые уроки уже доступны" });
});

test("«Send now» does not depend on the browser clock (review T2-11): a PC clock 10 min ahead still sends null", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.now() + 10 * MIN) });
  const bff = await openAs(page, "comms@tilhero.local", "#/news/campaigns");
  await expect(page.getByTestId("cmp-detail")).toBeVisible();
  await page.getByTestId("cmp-schedule").click();
  await page.getByTestId("cmp-when-now").check();
  await page.locator("#cmd-reason").fill("Срочно");
  await page.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("cmp-detail").locator(".pill").first()).toHaveText("идёт отправка");
  const sch = bff.calls("POST", /\/schedule$/);
  expect(sch.at(-1)!.body).toMatchObject({ send_at: null });
});

test("schedule (T2-2): 422 CAMPAIGN_INVALID {send_at: in_past} from the domain lands at the field; the retry is a new command", async ({ page }) => {
  // the notifications clock runs 3 days ahead: tomorrow is «in the past» there
  const bff = await openAs(page, "comms@tilhero.local", "#/news/campaigns", { serverClockAheadMs: 3 * DAY });
  await expect(page.getByTestId("cmp-detail")).toBeVisible();
  await page.getByTestId("cmp-schedule").click();
  await page.getByTestId("cmp-when-at").check();
  await page.getByTestId("cmp-at").fill(await localAt(page, DAY));
  await page.locator("#cmd-reason").fill("Анонс голосовых уроков");
  await page.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("cmp-confirm")).toBeVisible();
  await expect(page.getByTestId("cmp-at")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#cmp-at-err")).toContainText("уже прошло");
  await expect(page.getByTestId("cmp-confirm")).toContainText("Сервер не принял время отправки");
  await expect(page.getByTestId("confirm-ok")).toBeDisabled();
  // a later time → accepted; the refused attempt created nothing, so the retry carries a new Idempotency-Key
  await page.getByTestId("cmp-at").fill(await localAt(page, 5 * DAY));
  await expect(page.locator("#cmp-at-err")).toHaveCount(0);
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("cmp-detail")).toContainText("в расписании");
  const sch = bff.calls("POST", /\/schedule$/);
  expect(sch.at(-1)!.headers["idempotency-key"]).not.toBe(sch[0]!.headers["idempotency-key"]);
});

test("stalled campaign (P2-7): Campaign.last_error is visible in the list and the card; no stop for a draft", async ({ page }) => {
  await openAs(page, "comms@tilhero.local", "#/news/campaigns", { stalled: true });
  const id = "e1000000-0000-4000-8000-000000000002";
  await expect(page.getByTestId(`cmp-row-${id}`)).toHaveClass(/sev-bad/);
  await expect(page.getByTestId(`cmp-stalled-${id}`)).toContainText(/Отправка не идёт: INVALID_CURSOR, с .+, попыток 8/);
  // the opened draft: nothing to stop
  await expect(page.getByTestId("cmp-schedule")).toBeVisible();
  await expect(page.getByTestId("cmp-stop")).toHaveCount(0);
  await page.getByTestId(`cmp-open-${id}`).click();
  await expect(page.getByTestId("cmp-stalled")).toContainText("попыток 8");
  await expect(page.getByTestId("cmp-stop")).toBeVisible();
  // a finished campaign without deferred messages has nothing to stop either
  await page.getByTestId("cmp-open-e1000000-0000-4000-8000-000000000001").click();
  await expect(page.getByTestId("cmp-stats")).toBeVisible();
  await expect(page.getByTestId("cmp-stop")).toHaveCount(0);
  await expect(page.getByTestId("cmp-stalled")).toHaveCount(0);
});

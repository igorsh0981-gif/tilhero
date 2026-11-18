/** AT-18 / AT-19: «Что нового» — draft RU+UZ, empty UZ highlighted, preview in a phone frame, publication with TOTP. */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { TOTP } from "./fixtures/data";

test("draft → empty UZ highlighted → fill → preview → publish with TOTP → views and stats", async ({ page }) => {
  const bff = await openAs(page, "comms@tilhero.local", "#/news/whatsnew");
  await expect(page.getByTestId("wn-editor")).toBeVisible();
  await page.getByTestId("wn-new").click();

  // RU only
  await page.getByTestId("wn-slug").fill("2026.12");
  await page.getByTestId("wn-title-ru").fill("Декабрь: голосовые уроки");
  await page.getByTestId("wn-it-title-0-ru").fill("Говорим вслух");
  await page.getByTestId("wn-it-text-0-ru").fill("Отвечайте герою голосом — он подскажет, если ошибётесь.");
  await page.getByTestId("wn-link-0").selectOption("lessons");
  await page.getByTestId("wn-ic-0-mic").check({ force: true });
  await page.getByTestId("wn-audience").getByRole("button", { name: "всем" }).click();

  // the UZ tab counts the empty translations; saving is refused and the fields are highlighted
  await expect(page.getByTestId("wn-lang-uz")).toContainText("3");
  await page.getByTestId("wn-save").click();
  await expect(page.getByTestId("wn-lang-uz")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("wn-title-uz")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("wn-it-text-0-uz")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Заполните пустые переводы")).toBeVisible();
  expect(bff.calls("POST", "/release-notes")).toHaveLength(0);

  // preview in UZ shows the empty fields as «boʻsh»
  await expect(page.getByTestId("wn-phone")).toContainText("boʻsh");

  // fill UZ
  await page.getByTestId("wn-title-uz").fill("Dekabr: ovozli darslar");
  await page.getByTestId("wn-it-title-0-uz").fill("Ovoz chiqarib gapiramiz");
  await page.getByTestId("wn-it-text-0-uz").fill("Qahramonga ovoz bilan javob bering — xato qilsangiz, u yordam beradi.");
  await expect(page.getByTestId("wn-title-uz")).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("wn-lang-uz")).not.toContainText("3");

  // preview: the Mini App sheet in a phone frame, RU / UZ, light / dark
  const phone = page.getByTestId("wn-phone");
  await expect(phone).toContainText("Dekabr: ovozli darslar");
  await expect(phone).toContainText("Batafsil"); // the item has a link → «Подробнее» in UZ
  await expect(phone).toContainText("Nima oʻzgardi"); // audience «all» → the «what changed» sheet
  await page.getByTestId("pv-lang").getByRole("button", { name: "RU" }).click();
  await expect(phone).toContainText("Говорим вслух");
  await expect(phone).toContainText("Подробнее");
  await page.getByTestId("pv-scheme").getByRole("button", { name: "Тёмная" }).click();
  await expect(phone).toHaveAttribute("data-scheme", "dark");

  // save the draft (Idempotency-Key), then publish with a reason and a fresh TOTP
  await page.getByTestId("wn-save").click();
  await expect(page.getByTestId("wn-row-2026.12")).toBeVisible();
  const create = bff.calls("POST", "/release-notes")[0]!;
  expect(create.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(create.body).toMatchObject({ slug: "2026.12", audience: "all", title: { ru: "Декабрь: голосовые уроки", uz: "Dekabr: ovozli darslar" } });

  await page.getByTestId("wn-publish").click();
  await page.locator("#cmd-reason").fill("Релиз голосовых уроков 1.1");
  await page.getByTestId("confirm-ok").click();
  // 403 STEP_UP_REQUIRED → the TOTP dialog → the same command is repeated
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("wn-row-2026.12")).toContainText("опубликована");
  const pubs = bff.calls("POST", /\/publish$/);
  expect(pubs).toHaveLength(2);
  expect(pubs[0]!.headers["idempotency-key"]).toBe(pubs[1]!.headers["idempotency-key"]);
  expect(pubs[1]!.headers["x-csrf-token"]).toBeTruthy();
  expect(pubs[1]!.body).toMatchObject({ expected_version: 1, reason: "Релиз голосовых уроков 1.1" });
  expect(bff.audit[0]!.action).toBe("release_note.publish");

  // published → read-only, stats, withdrawal with TOTP (the step-up window is still open)
  await expect(page.getByTestId("wn-readonly")).toBeVisible();
  await expect(page.getByTestId("wn-stats")).toBeVisible();
  await page.getByTestId("wn-archive").click();
  await page.locator("#cmd-reason").fill("Перенесли релиз на январь");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("wn-row-2026.12")).toContainText("в архиве");
});

test("server 422 RELEASE_NOTE_TRANSLATION_MISSING highlights the reported fields", async ({ page }) => {
  // the client sees text, the server finds the item text empty (e.g. only invisible characters) and reports the path
  const bff = await openAs(page, "comms@tilhero.local", "#/news/whatsnew");
  await page.route("**/admin/v1/release-notes/*", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ code: "RELEASE_NOTE_TRANSLATION_MISSING", message: "x", trace_id: "t", details: { missing: ["items[1].text.uz"] } }) });
  });
  await page.getByTestId("wn-open-2026.11").click();
  await page.getByTestId("wn-it-text-1-ru").fill("После 21:00 напоминания не приходят.");
  await page.getByTestId("wn-save").click();
  await expect(page.getByTestId("wn-lang-uz")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("wn-it-text-1-uz")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert").filter({ hasText: "пустой перевод не сохраняется" })).toBeVisible();
  void bff;
});

test("version conflict: another staff member saved first", async ({ page }) => {
  const bff = await openAs(page, "comms@tilhero.local", "#/news/whatsnew");
  await page.getByTestId("wn-open-2026.11").click();
  bff.notes[0]!.version = 9; // saved elsewhere
  await page.getByTestId("wn-title-ru").fill("Ноябрь: семья, график и тихие часы");
  await page.getByTestId("wn-save").click();
  await expect(page.getByTestId("wn-conflict")).toBeVisible();
});

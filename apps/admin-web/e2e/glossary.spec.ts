/**
 * Sprint 5 «Контент → Словарь курса» on the mock admin-bff (AT-60): the queue of AI translations sorted by the places
 * in the content with quick «Подтвердить» / «Исправить» (RU/UZ) / «Отклонить» (+ a note) and their audit; a methodist
 * entry (a taken form → a link to the holder); an edit with If-Match that meets a concurrent change (409
 * VERSION_CONFLICT → plain message → «Перечитать»); the override of a course entry; the archive of a methodist entry;
 * no action buttons without glossary.manage.
 */
import { expect, test, type Page } from "@playwright/test";
import { openAs } from "./helpers";
import { GID } from "./fixtures/memory-data";

test.describe.configure({ timeout: 90_000 });

const queueOrder = (page: Page) => page.locator("li.gl-q-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));

test("AT-60 AI queue: sorted by places in the content; approve, correct (RU/UZ, Latin UZ checked), reject with a note — each audited", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/content/glossary/queue");
  await expect(page.getByTestId("gl-queue")).toBeVisible();
  await expect(page.getByTestId("gl-view").getByRole("button", { name: /Очередь переводов ИИ/ })).toContainText("3");
  expect(await queueOrder(page)).toEqual(["glq-bakery", "glq-window", "glq-tip"]);
  // low confidence is said in words, not only by colour
  await expect(page.getByTestId("glq-tip")).toContainText("ученикам не показывается");
  // approve
  await page.getByTestId("glq-approve-window").click();
  await expect(page.getByTestId("toasts")).toContainText("Перевод «window» подтверждён");
  await expect(page.getByTestId("glq-window")).toHaveCount(0);
  const ap = bff.calls("POST", `/glossary/${GID.window}/review`).at(-1)!;
  expect(ap.body).toEqual({ decision: "approve", note: null });
  expect(ap.headers["idempotency-key"]).toBeTruthy();
  // correct: the UZ translation must be Latin
  await page.getByTestId("glq-correct-bakery").click();
  const form = page.getByTestId("gld-correct");
  await expect(form.getByTestId("gld-ru")).toHaveValue("пекарня");
  await form.getByTestId("gld-uz").fill("нонвойхона");
  await form.getByTestId("gld-ok").click();
  await expect(form).toContainText("Узбекский перевод — только латиницей");
  expect(bff.calls("POST", `/glossary/${GID.bakery}/review`)).toHaveLength(0);
  await form.getByTestId("gld-uz").fill("novvoyxona");
  await form.getByTestId("gld-ru").fill("пекарня, булочная");
  await form.getByTestId("gld-note").fill("В тексте — булочная у дома");
  await form.getByTestId("gld-ok").click();
  await expect(page.getByTestId("toasts")).toContainText("Перевод «bakery» исправлен");
  expect(bff.calls("POST", `/glossary/${GID.bakery}/review`).at(-1)!.body).toEqual({ decision: "correct", gloss: { ru: "пекарня, булочная", uz: "novvoyxona" }, note: "В тексте — булочная у дома" });
  expect(bff.memory.entry(GID.bakery)).toMatchObject({ review_status: "approved", corrected: true, gloss: { ru: "пекарня, булочная" } });
  // reject with a note
  await page.getByTestId("glq-reject-tip").click();
  await page.getByTestId("gld-reject").getByTestId("gld-note").fill("В уроке — чаевые, а не кончик");
  await page.getByTestId("gld-reject").getByTestId("gld-ok").click();
  await expect(page.getByTestId("toasts")).toContainText("Перевод «tip» отклонён");
  await expect(page.getByTestId("gl-queue-empty")).toBeVisible();
  expect(bff.memory.entry(GID.tip)!.review_status).toBe("rejected");
  expect(bff.memory.audit.map((a) => a.action)).toEqual(["glossary.entry_reviewed", "glossary.entry_reviewed", "glossary.entry_reviewed"]);
  // the history of the corrected entry names the methodist
  await page.getByTestId("gl-view").getByRole("button", { name: "Все статьи" }).click();
  await page.getByTestId("gl-open-bakery").click();
  const card = page.getByTestId("gl-entry");
  await expect(card).toContainText("исправлено методистом");
  await expect(page.getByTestId("gl-h-0")).toContainText("Гульнора");
  await expect(page.getByTestId("gl-h-0")).toContainText("проверена");
  await expect(page.getByTestId("gl-refs")).toContainText("В кофейне");
});

test("methodist entry: a taken form links to its entry; create; edit meets a concurrent change (If-Match → 409) → re-read → save; archive", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/content/glossary");
  await expect(page.getByTestId("gl-stats")).toContainText("Из контента: 3");
  await page.getByTestId("gl-new").click();
  const nd = page.getByTestId("gl-new-drawer");
  await nd.getByTestId("gl-create").click();
  await expect(nd).toContainText("Заполните поле");
  await nd.getByTestId("glf-lemma").fill("café");
  await nd.getByTestId("glf-forms").fill("Coffee shop\ncafé");
  await expect(nd.getByTestId("glf-forms-norm")).toContainText("coffee shop · café");
  await nd.getByTestId("glf-ru").fill("кафе");
  await nd.getByTestId("glf-uz").fill("kafe");
  await nd.getByTestId("gl-create").click();
  await expect(page.getByTestId("gl-form-taken")).toContainText("уже есть в другой статье");
  await page.getByTestId("gl-open-holder").click();
  await expect(page.getByTestId("gl-entry")).toContainText("coffee shop");
  await page.getByTestId("drawer-close").click();
  // a new entry with a free form
  await page.getByTestId("gl-new").click();
  await nd.getByTestId("glf-lemma").fill("pastry");
  await nd.getByTestId("glf-pos").selectOption("noun");
  await nd.getByTestId("glf-ru").fill("выпечка");
  await nd.getByTestId("glf-uz").fill("pishiriq");
  await nd.getByTestId("glf-reason").fill("Нужно для текста про пекарню");
  await nd.getByTestId("gl-create").click();
  await expect(page.getByTestId("toasts")).toContainText("Статья «pastry» создана");
  await expect(page.getByTestId("gl-entry")).toContainText("Статья методиста");
  const created = bff.calls("POST", "/glossary").at(-1)!;
  expect(created.body).toEqual({ pair_id: "ru-en", lemma: "pastry", forms: ["pastry"], part_of_speech: "noun", gloss: { ru: "выпечка", uz: "pishiriq" }, example_en: null, reason: "Нужно для текста про пекарню" });
  expect(created.headers["idempotency-key"]).toBeTruthy();
  await page.getByTestId("drawer-close").click();
  // edit «by the way»: someone saves the entry in between
  await page.getByTestId("gl-open-by the way").click();
  const read = bff.memory.entry(GID.byTheWay)!.updated_at;
  await page.getByTestId("gl-edit").click();
  await page.getByTestId("glf-ru").fill("между прочим");
  bff.memory.touchEntry(GID.byTheWay);
  await page.getByTestId("gl-save").click();
  await expect(page.getByTestId("gl-conflict")).toContainText("Статью уже изменил другой сотрудник");
  expect(bff.calls("PATCH", `/glossary/${GID.byTheWay}`).at(-1)!.headers["if-match"]).toBe(read);
  await page.getByTestId("gl-reread").click();
  await expect(page.getByTestId("gl-conflict")).toHaveCount(0);
  await expect(page.getByTestId("glf-ru")).toHaveValue("кстати (правка коллеги)");
  await page.getByTestId("glf-ru").fill("между прочим");
  await page.getByTestId("gl-save").click();
  await expect(page.getByTestId("toasts")).toContainText("Статья «by the way» сохранена");
  await expect(page.getByTestId("gl-e-ru")).toHaveText("между прочим");
  const patch = bff.calls("PATCH", `/glossary/${GID.byTheWay}`).at(-1)!;
  expect(patch.body).toEqual({ gloss: { ru: "между прочим", uz: "aytgancha" }, reason: null });
  expect(patch.headers["if-match"]).not.toBe(read);
  // archive (methodist entries only) with a reason
  await page.getByTestId("gl-archive").click();
  await page.locator("#cmd-reason").fill("Дубль статьи урока");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("toasts")).toContainText("Статья «by the way» в архиве");
  expect(bff.memory.entry(GID.byTheWay)!.archived_at).toBeTruthy();
  await expect(page.getByTestId("gl-row-by the way")).toHaveCount(0);
});

test("course entry: places in content and conflicts; override only (no edit, no archive); the override is saved and can be removed", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", `#/content/glossary/${GID.coffeeShop}`);
  const card = page.getByTestId("gl-entry");
  // the first visit compiles the content chunk on the dev server
  await expect(card.getByTestId("gl-entry-body")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("gl-refs")).toContainText("В кофейне");
  await expect(page.getByTestId("gl-refs")).toContainText("Заказ кофе");
  await expect(page.getByTestId("gl-conflicts")).toContainText("кафе");
  await expect(card.getByTestId("gl-edit")).toHaveCount(0);
  await expect(card.getByTestId("gl-archive")).toHaveCount(0);
  await card.getByTestId("gl-override").click();
  await page.getByTestId("glo-ru").fill("кофейня, кафе");
  await page.getByTestId("glo-reason").fill("В медиа — кафе");
  await page.getByTestId("glo-save").click();
  await expect(page.getByTestId("toasts")).toContainText("Перевод «coffee shop» переопределён");
  await expect(page.getByTestId("gl-e-ru")).toHaveText("кофейня, кафе");
  await expect(page.getByTestId("gl-e-override")).toBeVisible();
  expect(bff.calls("PATCH", `/glossary/${GID.coffeeShop}`).at(-1)!.body).toEqual({ override: { gloss: { ru: "кофейня, кафе", uz: "qahvaxona" }, example_en: "Every morning Lola goes to a small coffee shop." }, reason: "В медиа — кафе" });
  // a reference opens its content
  await page.getByTestId("gl-ref-r-a1-coffee-shop").click();
  await expect(page.getByTestId("ws-reading")).toBeVisible();
  // back: remove the override
  await page.evaluate((id) => (window.location.hash = `#/content/glossary/${id}`), GID.coffeeShop);
  await page.getByTestId("gl-unoverride").click();
  await page.locator("#cmd-reason").fill("Вернуть перевод урока");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("toasts")).toContainText("Переопределение «coffee shop» снято");
  expect(bff.calls("PATCH", `/glossary/${GID.coffeeShop}`).at(-1)!.body).toEqual({ override: null, reason: "Вернуть перевод урока" });
});

test("without glossary.manage: the dictionary and the queue are read-only — no action buttons at all", async ({ page }) => {
  const bff = await openAs(page, "qa@tilhero.local", "#/content/glossary/queue");
  await expect(page.getByTestId("gl-queue")).toContainText("glossary.manage");
  await expect(page.getByTestId("glq-bakery")).toBeVisible();
  await expect(page.locator('[data-testid^="glq-approve-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="glq-correct-"]')).toHaveCount(0);
  await expect(page.getByTestId("gl-new")).toHaveCount(0);
  await page.getByTestId("glq-open-bakery").click();
  await expect(page.getByTestId("gl-ro")).toContainText("glossary.manage");
  await expect(page.getByTestId("gl-actions")).toHaveCount(0);
  expect(bff.calls("POST", /\/glossary/)).toHaveLength(0);
});

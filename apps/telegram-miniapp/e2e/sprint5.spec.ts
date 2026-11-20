import { expect, test, type Page } from "@playwright/test";
import * as F from "./fixtures/data";
import { MockMemory } from "./fixtures/memory";
import { gumCalls, installMic } from "./fixtures/mic";
import type { Scenario } from "./fixtures/mock-bff";
import { installSpeech } from "./fixtures/speech";
import { CYRILLIC, open, shot } from "./helpers";

/**
 * Sprint 5 on the mock BFF: Home → «Повторение дня» through every task type (the check block, intro, recognition,
 * typing with the first letter, a gap, letters with «Отменить», an error fix with a typo → «почти», a card coming back at
 * the end) → the summary; the dictionary (filters, search, strength, pages, «Знаю это», removal) and the error journal;
 * reading (the translation of the course dictionary / of the AI / none → the sentence, «В словарь», the questions in the
 * player, the summary, the last result); «Произнести» (no consent → settings → on → a recording with a fake microphone →
 * the result and a 16 kHz mono WAV; a refused microphone; a teen; unavailable; not assessed); the parent's switch for a
 * child; a child (children's texts, no error journal, soft words); route_review; UZ.
 */
const ALL_SEEN = [F.WELCOME.id, F.UPDATE_1.id, F.UPDATE_2.id];
const I = MockMemory.IDS;
const KID_ID = "7a1c2b3a-2222-4a2b-9c3d-000000000777";
const VOICE = ["terms", "privacy", "learning", "product_news", "voice_recording"];

async function start(page: Page, sc: Scenario = {}) {
  await installSpeech(page);
  return open(page, { onboarded: true, seen: ALL_SEEN, content: { diag: "completed" }, ...sc });
}

/** Escape closes the bottom sheet; wait until it is gone before the next tap. */
async function closeSheet(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(".sheet")).toHaveCount(0);
}

async function openCard(page: Page, id: string) {
  await page.getByTestId("tab-review").click();
  await expect(page.getByTestId("dictionary")).toBeVisible();
  // the card may be on the second page
  const row = page.getByTestId(`dict-card-${id}`);
  if (!(await row.isVisible().catch(() => false))) {
    const more = page.getByRole("button", { name: "Показать ещё" });
    if (await more.isVisible().catch(() => false)) await more.click();
  }
  await row.click();
  await expect(page.getByTestId("card")).toBeVisible();
}

test.describe("«Повторение дня»", () => {
  test("главная → все типы заданий → итоги (проверка навыка, ввод, буквы, «почти», повтор в конце)", async ({ page }) => {
    const bff = await start(page);
    const card = page.getByTestId("review-card");
    await expect(card).toHaveAttribute("data-state", "start");
    await expect(page.getByTestId("review-card-counts")).toContainText("5 карточек к повторению");
    await expect(page.getByTestId("review-card-counts")).toContainText("новых: 1");
    await expect(page.getByTestId("review-card-counts")).toContainText("проверок: 1");
    await page.getByTestId("review-card-go").click();
    await expect(page.getByTestId("rv-header")).toBeVisible();
    expect(bff.last("POST", "/v1/memory/review-sessions")?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);

    // ---- the retention check: no hints, no correctness until the end of the block ----
    await expect(page.getByTestId("rv-check")).toContainText("Проверка: Вежливая просьба в кафе");
    await expect(page.getByTestId("rv-check")).toContainText("задание 1 из 3");
    await shot(page, "32_review_check");
    await expect(page.getByTestId("rv-reveal")).toHaveCount(0);
    await expect(page.getByTestId("rv-first-letter")).toHaveCount(0);
    await page.getByTestId("rv-opt-1").click();
    await page.getByTestId("rv-answer").click();
    await expect(page.getByTestId("toast")).toHaveText("Ответ принят");
    await expect(page.getByTestId("rv-feedback")).toHaveCount(0);
    await page.getByTestId("rv-input").fill("like");
    await page.getByTestId("rv-input").press("Enter");
    await expect(page.getByTestId("rv-check")).toContainText("задание 3 из 3");
    // order of options as tiles (check_item: options, no tiles)
    for (const i of [1, 3, 0, 2]) await page.getByTestId(`rv-tile-${i}`).click();
    await expect(page.getByTestId("rv-assembled")).toHaveText("Could I have the bill?");
    await page.getByTestId("rv-answer").click();
    await expect(page.getByTestId("rv-check-result")).toHaveAttribute("data-passed", "true");
    await expect(page.getByTestId("rv-check-result")).toContainText("Пройдена: верно 3 из 3");
    await expect(page.getByTestId("rv-check-items").locator("li")).toHaveCount(3);
    await page.getByTestId("rv-next").click();

    // ---- a new card: intro, then the meaning ----
    await expect(page.getByTestId("rv-task-intro")).toBeVisible();
    await expect(page.getByTestId("rv-word")).toHaveText("receipt");
    await expect(page.getByTestId("rv-gloss")).toHaveText("чек");
    await page.getByTestId("rv-got").click();
    await expect(page.getByTestId("rv-task-meaning_choice")).toBeVisible();
    await page.getByTestId("rv-opt-0").click();
    await page.getByTestId("rv-answer").click();
    await expect(page.getByTestId("rv-feedback")).toHaveAttribute("data-result", "correct");
    await expect(page.getByTestId("rv-back-in")).toHaveText("Вернётся через 2 дн.");
    await page.getByTestId("rv-next").click();

    // ---- listen and choose ----
    await expect(page.getByTestId("rv-task-listen_choice")).toBeVisible();
    await page.getByTestId("rv-listen").click();
    await expect.poll(() => bff.calls("POST", "/v1/speech").length).toBeGreaterThan(0);
    await page.getByTestId("rv-opt-0").click();
    await page.getByTestId("rv-answer").click();
    await expect(page.getByTestId("rv-feedback")).toHaveAttribute("data-result", "correct");
    await page.getByTestId("rv-next").click();

    // ---- typing: the first letter, a wrong answer → the right one, back at the end of the session ----
    await expect(page.getByTestId("rv-task-typed")).toBeVisible();
    await expect(page.getByTestId("rv-gloss")).toHaveText("с собой");
    await page.getByTestId("rv-first-letter").click();
    await expect(page.getByTestId("rv-hint")).toContainText("Начинается так: t…");
    await page.getByTestId("rv-input").fill("for go");
    await page.getByTestId("rv-input").press("Enter");
    await expect(page.getByTestId("rv-feedback")).toHaveAttribute("data-result", "incorrect");
    await expect(page.getByTestId("rv-feedback")).toContainText("Пока неверно");
    await expect(page.getByTestId("rv-right")).toHaveText("Правильно: to go");
    await expect(page.getByTestId("rv-requeued")).toHaveText("Вернётся в конце этого повторения");
    await shot(page, "30_review_typed_feedback");
    await page.getByTestId("rv-next").click();

    // ---- a gap ----
    await expect(page.getByTestId("rv-task-cloze")).toBeVisible();
    await page.getByTestId("rv-input").fill("menu");
    await page.getByTestId("rv-answer").click();
    await expect(page.getByTestId("rv-back-in")).toHaveText("Вернётся через 4 дн.");
    await page.getByTestId("rv-next").click();

    // ---- letters with «Отменить» ----
    await expect(page.getByTestId("rv-task-assemble")).toBeVisible();
    await expect(page.getByTestId("rv-answer")).toBeDisabled();
    await page.getByTestId("rv-tile-0").click();
    await page.getByTestId("rv-undo").click();
    await expect(page.getByTestId("rv-assembled")).toHaveText("");
    for (const i of [1, 3, 0, 4, 2]) await page.getByTestId(`rv-tile-${i}`).click();
    await expect(page.getByTestId("rv-assembled")).toHaveText("table");
    await shot(page, "31_review_assemble");
    await page.getByTestId("rv-answer").click();
    await expect(page.getByTestId("rv-feedback")).toHaveAttribute("data-result", "correct");
    expect(bff.last("POST", /\/tasks\/[0-9a-z-]+$/)?.body).toEqual({ order: [1, 3, 0, 4, 2] });
    await page.getByTestId("rv-next").click();

    // ---- fix the error: a typo → «почти» ----
    await expect(page.getByTestId("rv-task-error_fix")).toBeVisible();
    await expect(page.getByTestId("rv-evidence")).toHaveText("I want latte");
    await page.getByTestId("rv-input").fill("I'd like a latte, pleese");
    await page.getByTestId("rv-answer").click();
    await expect(page.getByTestId("rv-feedback")).toHaveAttribute("data-result", "almost");
    await expect(page.getByTestId("rv-feedback")).toContainText("Почти — проверьте написание");
    await page.getByTestId("rv-next").click();

    // ---- the card answered wrong comes back ----
    await expect(page.getByTestId("rv-task-typed")).toBeVisible();
    await expect(page.getByTestId("rv-progress-text")).toHaveText("задание 11 из 11");
    await page.getByTestId("rv-input").fill("to go");
    await page.getByTestId("rv-input").press("Enter");
    await expect(page.getByTestId("rv-feedback")).toHaveAttribute("data-result", "correct");
    await page.getByTestId("rv-next").click();

    // ---- the summary ----
    await expect(page.getByTestId("rv-summary")).toBeVisible();
    await expect(page.getByTestId("rv-sum-title")).toHaveText("Повторение готово");
    await expect(page.getByTestId("rv-sum-reviewed")).toHaveText("6");
    await expect(page.getByTestId("rv-sum-correct")).toHaveText("5");
    await expect(page.getByTestId("rv-sum-again")).toHaveText("1");
    await expect(page.getByTestId("rv-sum-new")).toHaveText("1");
    await expect(page.getByTestId("rv-sum-check")).toHaveAttribute("data-passed", "true");
    await expect(page.getByTestId("rv-sum-check")).toContainText("Навык закреплён");
    await expect(page.getByTestId("rv-sum-next")).toContainText("Завтра к повторению: 6");
    await shot(page, "26_review_summary");
    await page.getByTestId("rv-sum-done").click();
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(page.getByTestId("review-card")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("review-card-line")).toHaveText("На сегодня всё повторено");
  });

  test("пауза: выйти и продолжить с того же задания; потерянный ответ отправляется ещё раз", async ({ page }) => {
    const bff = await start(page, { dropResponseOnce: ["POST /v1/memory/review-sessions/*/tasks/*"] });
    await page.getByTestId("review-card-go").click();
    await page.getByTestId("rv-opt-1").click();
    await page.getByTestId("rv-answer").click();
    // the answer was handled but the response was lost: the answer is held as sent — no other choice, only the same again
    await expect(page.getByTestId("rv-send-failed")).toBeVisible();
    await expect(page.getByTestId("rv-opt-0")).toBeDisabled();
    await expect(page.getByTestId("rv-opt-1")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("rv-answer")).toBeDisabled();
    await page.getByTestId("rv-resend").click();
    await expect(page.getByTestId("rv-check")).toContainText("задание 2 из 3");
    const answers = bff.calls("POST", /\/tasks\/[0-9a-z-]+$/);
    expect(answers).toHaveLength(2);
    expect(answers[0]!.path).toBe(answers[1]!.path);
    expect(answers[1]!.body).toEqual({ choice: 1 });
    // pause → home: «Продолжить»
    await page.getByTestId("rv-menu").click();
    await page.getByTestId("rv-exit").click();
    await expect(page.getByTestId("toast")).toHaveText("Повторение на паузе — продолжите с этого задания");
    await expect(page.getByTestId("review-card")).toHaveAttribute("data-state", "continue");
    await page.getByTestId("review-card-go").click();
    await expect(page.getByTestId("rv-check")).toContainText("задание 2 из 3");
    // the same session, not a second one
    expect(bff.calls("POST", "/v1/memory/review-sessions")).toHaveLength(2);
    expect(bff.memory.sessions.size).toBe(1);
  });

  test("«Знаю это» на новом слове: дальше без оценки; «Не помню» показывает ответ", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("review-card-go").click();
    await page.getByTestId("rv-opt-1").click();
    await page.getByTestId("rv-answer").click();
    await page.getByTestId("rv-input").fill("like");
    await page.getByTestId("rv-input").press("Enter");
    for (const i of [1, 3, 0, 2]) await page.getByTestId(`rv-tile-${i}`).click();
    await page.getByTestId("rv-answer").click();
    await page.getByTestId("rv-next").click();
    await page.getByTestId("rv-known").click();
    expect(bff.last("POST", /\/tasks\/[0-9a-z-]+$/)?.body).toEqual({ known: true });
    // the meaning task of the known card is gone: the next is listening
    await expect(page.getByTestId("rv-task-listen_choice")).toBeVisible();
    await page.getByTestId("rv-reveal").click();
    await expect(page.getByTestId("rv-revealed")).toHaveText("latte");
    expect(bff.last("POST", /\/hint$/)?.body).toEqual({ kind: "reveal" });
    await page.getByTestId("rv-opt-0").click();
    await page.getByTestId("rv-answer").click();
    await expect(page.getByTestId("rv-requeued")).toBeVisible();
  });

  test("deep link route_review (уведомление reviews_due) открывает «Повторение дня» над «Словарём»", async ({ page }) => {
    await start(page, { startParam: "route_review" });
    await expect(page.getByTestId("rv-start")).toBeVisible();
    await expect(page.getByTestId("rv-start-counts")).toContainText("5 карточек к повторению");
    await page.getByTestId("rv-start-go").click();
    await expect(page.getByTestId("rv-task-check_item")).toBeVisible();
    await page.getByTestId("rv-menu").click();
    await page.getByTestId("rv-exit").click();
    await expect(page.getByTestId("dictionary")).toBeVisible();
    await expect(page.getByTestId("tab-review")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("tab-review")).toHaveText("Словарь");
  });

  test("пусто и «на сегодня всё»: спокойное состояние с ближайшим сроком", async ({ page }) => {
    await start(page, { memory: { doneToday: true } });
    await expect(page.getByTestId("review-card")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("review-card-next")).toContainText("Следующее повторение —");
    await page.getByTestId("tab-review").click();
    await expect(page.getByTestId("dict-review")).toHaveAttribute("data-state", "done");
  });

  test("пустой словарь: подсказка и путь в «Чтение»; повторять нечего", async ({ page }) => {
    await start(page, { memory: { empty: true }, startParam: "route_review" });
    await expect(page.getByTestId("rv-start-nothing")).toHaveText("Сегодня повторять нечего");
    await page.getByTestId("rv-start-back").click();
    await expect(page.getByTestId("dict-empty")).toHaveAttribute("data-filtered", "false");
    await expect(page.getByTestId("dict-review-line")).toHaveText("Слова появятся здесь после уроков и чтения");
    await page.getByTestId("dict-to-reading").click();
    await expect(page.getByTestId("rd-list")).toBeVisible();
  });
});

test.describe("словарь и журнал ошибок", () => {
  test("фильтры, поиск, сила словом, страницы, карточка, «Знаю это» / вернуть, убрать", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("tab-review").click();
    await expect(page.getByTestId("dict-list").locator("li")).toHaveCount(20);
    await page.getByRole("button", { name: "Показать ещё" }).click();
    await expect(page.getByTestId("dict-list").locator("li")).toHaveCount(25);
    // strength: bars and a word
    const togo = page.getByTestId(`dict-card-${I.togo}`);
    await expect(togo.getByTestId("strength")).toHaveAttribute("aria-label", "Запомнилось: слабо");
    await expect(togo.getByTestId("strength")).toContainText("слабо");
    // kind
    await page.getByTestId("dict-view").getByRole("button", { name: "Фразы" }).click();
    await expect(page.getByTestId("dict-list").locator("li")).toHaveCount(2);
    expect(bff.last("GET", "/v1/memory/cards")?.query.get("kind")).toBe("phrase");
    await page.getByTestId("dict-view").getByRole("button", { name: "Все" }).click();
    // search by the translation
    await page.getByTestId("dict-search").fill("счёт");
    await expect(page.getByTestId("dict-list").locator("li")).toHaveCount(1);
    await expect(page.getByTestId(`dict-card-${I.bill}`)).toBeVisible();
    await page.getByTestId("dict-search").fill("zzz");
    await expect(page.getByTestId("dict-empty")).toHaveAttribute("data-filtered", "true");
    await page.getByRole("button", { name: "Сбросить фильтры" }).click();
    // status
    await page.getByTestId("dict-status").getByRole("button", { name: "Знаю" }).click();
    await expect(page.getByTestId("dict-list").locator("li")).toHaveCount(1);
    await page.getByTestId("dict-status").getByRole("button", { name: "Знаю" }).click();
    await shot(page, "27_dictionary");

    // the card
    await page.getByTestId(`dict-card-${I.togo}`).click();
    await expect(page.getByTestId("cd-text")).toHaveText("to go");
    await expect(page.getByTestId("cd-gloss")).toHaveText("с собой");
    await expect(page.getByTestId("gloss-source")).toHaveText("Словарь курса");
    await expect(page.getByTestId("cd-example")).toHaveText("A latte to go, please.");
    await expect(page.getByTestId("cd-history").locator("li")).toHaveCount(2);
    await expect(page.getByTestId("cd-when")).toContainText("Повторить сегодня");
    await page.getByTestId("cd-listen").click();
    await expect.poll(() => bff.calls("POST", "/v1/speech").some((c) => (c.body as { text: string }).text === "to go")).toBe(true);
    await page.getByTestId("cd-known").click();
    await expect(page.getByTestId("toast")).toHaveText("Отмечено: знаю. В повторение не попадёт");
    await expect(page.getByTestId("cd-when")).toContainText("«Знаю это»");
    await page.getByTestId("cd-unknown").click();
    await expect(page.getByTestId("cd-known")).toBeVisible();
    expect(bff.calls("DELETE", `/v1/memory/cards/${I.togo}/known`)).toHaveLength(1);
    // remove
    await page.getByTestId("cd-remove").click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Убрать" }).click();
    await expect(page.getByTestId("toast")).toHaveText("Убрали из словаря");
    await expect(page.getByTestId("dictionary")).toBeVisible();
    await expect(page.getByTestId(`dict-card-${I.togo}`)).toHaveCount(0);
  });

  test("журнал ошибок: исправление, объяснение, ваш фрагмент; через 90 дней фрагмента нет", async ({ page }) => {
    await start(page);
    await page.getByTestId("tab-review").click();
    await page.getByTestId("dict-view").getByRole("button", { name: "Ошибки" }).click();
    await expect(page.getByTestId("err-list").locator("li")).toHaveCount(2);
    await expect(page.getByTestId(`err-${I.like}`)).toContainText("I’d like a latte, please.");
    await expect(page.getByTestId(`err-${I.like}`)).toContainText("Вежливая просьба: I’d like вместо I want");
    await expect(page.getByTestId(`err-${I.like}`)).toContainText("важная");
    await page.getByTestId(`err-${I.like}`).click();
    await expect(page.getByTestId("cd-error")).toContainText("Вежливая просьба");
    await expect(page.getByTestId("cd-evidence")).toHaveText("I want latte");
    await page.getByTestId("bar-back").click();
    await page.getByTestId(`err-${I.be}`).click();
    await expect(page.getByTestId("cd-evidence-gone")).toBeVisible();
  });
});

test.describe("чтение", () => {
  test("тап по слову: словарь курса / ИИ / нет перевода → предложение; «В словарь»; вопросы; итоги; результат в списке", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("home-practice").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Чтение" }).click();
    await expect(page.getByTestId("rd-list").locator("button")).toHaveCount(2);
    await page.getByTestId("rd-rd-cafe-morning").click();
    await expect(page.getByTestId("rd-title")).toHaveText("Утро в кафе");
    // glossary terms: a marker and a dotted underline
    await expect(page.getByTestId("rw-s2-to_go")).toHaveClass(/term/);

    // the course dictionary; the word is already in my dictionary
    await page.getByTestId("rw-s2-latte").click();
    const sheet = page.getByTestId("rd-word-sheet");
    await expect(sheet.getByTestId("rd-gloss")).toHaveText("латте");
    await expect(sheet.getByTestId("gloss-source")).toHaveText("Словарь курса");
    await expect(sheet.getByTestId("rd-in-dict")).toBeVisible();
    expect(bff.last("POST", "/v1/memory/translate")?.body).toEqual({ text: "latte", content: { kind: "reading", key: "rd-cafe-morning", version: 2, locator: "s2" } });
    await closeSheet(page);
    // a new word: the lemma and «В словарь»
    await page.getByTestId("rw-s2-orders").click();
    await expect(sheet.getByTestId("rd-gloss")).toHaveText("заказывает");
    await expect(sheet.getByTestId("rd-lemma")).toHaveText("order · глагол");
    await sheet.getByTestId("rd-add").click();
    await expect(page.getByTestId("toast")).toHaveText("Добавлено в словарь — вернётся в повторении");
    await expect(sheet.getByTestId("rd-in-dict")).toBeVisible();
    const add = bff.last("POST", "/v1/memory/cards")!;
    expect(add.body).toEqual({ text_en: "orders", source: { kind: "reading", key: "rd-cafe-morning", version: 2, locator: "s2" } });
    expect(add.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await shot(page, "28_reading_word");
    await closeSheet(page);

    // an AI translation, marked
    await page.getByTestId("rw-s3-barista").click();
    await expect(sheet.getByTestId("rd-gloss")).toHaveText("бариста");
    await expect(sheet.getByTestId("gloss-source")).toHaveAttribute("data-source", "ai");
    await expect(sheet.getByTestId("gloss-source")).toHaveText("Перевод ИИ — его проверяет методист");
    await closeSheet(page);

    // no translation → the sentence; no «В словарь»
    await page.getByTestId("rw-s3-smiles").click();
    await expect(sheet.getByTestId("rd-no-gloss")).toContainText("Бариста улыбается и говорит");
    await expect(sheet.getByTestId("rd-add")).toHaveCount(0);
    await closeSheet(page);

    // the sentence: sound and translation
    await shot(page, "34_reading_text");
    await page.getByTestId("rd-s-act-s4").click();
    await page.getByTestId("rd-s-translate").click();
    await expect(page.getByTestId("rd-s-gloss")).toHaveText("Потом Азиз просит счёт.");
    await page.getByTestId("rd-s-listen").click();
    await expect.poll(() => bff.calls("POST", "/v1/speech").some((c) => (c.body as { text: string }).text === "Then Aziz asks for the bill.")).toBe(true);
    await closeSheet(page);

    // the questions: a reading session in the lesson player
    await page.getByTestId("rd-start").click();
    expect(bff.last("POST", "/v1/practice/readings/rd-cafe-morning/sessions")?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByTestId("pl-reading")).toBeVisible();
    await expect(page.getByTestId("pl-stage")).toHaveText("Чтение");
    // tap a word inside the step too
    await page.getByTestId("rw-s1-morning").click();
    await expect(page.getByTestId("rd-word-sheet").getByTestId("gloss-source")).toHaveText("Проверено методистом");
    await closeSheet(page);
    await page.getByTestId("pl-next").click();
    await expect(page.getByTestId("pl-stage")).toHaveText("Вопросы");
    await expect(page.getByTestId("pl-graded")).toBeVisible();
    await expect(page.getByTestId("pl-hint-btn")).toHaveCount(0);
    await page.getByTestId("pl-opt-1").click();
    await page.getByTestId("pl-answer").click();
    await expect(page.getByTestId("toast")).toHaveText("Ответ принят");
    await expect(page.getByTestId("pl-prompt")).toHaveText("Aziz goes to the café every evening.");
    await expect(page.getByTestId("pl-opt-0")).toContainText("True");
    await page.getByTestId("pl-opt-1").click();
    await page.getByTestId("pl-answer").click();
    await page.getByTestId("pl-gap-input").fill("for");
    await page.getByTestId("pl-answer").click();
    await page.getByTestId("pl-finish").click();
    await expect(page.getByTestId("summary")).toBeVisible();
    await expect(page.locator(".bar")).toContainText("Итоги чтения");
    await expect(page.getByTestId("sm-score-comprehension")).toBeVisible();
    await page.getByTestId("bar-back").click();
    await page.getByTestId("bar-back").click();
    await expect(page.getByTestId("rd-rd-cafe-morning")).toContainText("Последний раз: 3 из 3");
  });
});

test.describe("«Произнести»", () => {
  test("нет согласия → настройки → включить → запись (подменённый микрофон) → результат по словам; WAV 16 кГц моно", async ({ page }) => {
    await installMic(page, "ok");
    const bff = await start(page);
    await openCard(page, I.togo);
    await expect(page.getByTestId("cd-pron-consent")).toHaveAttribute("data-who", "self");
    await expect(page.getByTestId("cd-pron")).toHaveCount(0);
    await page.getByTestId("cd-pron-to-settings").click();
    await expect(page.getByTestId("voice-consent")).toBeVisible();
    await page.getByTestId("vc-self").click();
    await expect(page.getByTestId("toast")).toHaveText("Запись голоса включена");
    expect((bff.last("POST", "/v1/profile/consent")?.body as { purposes: string[] }).purposes).toContain("voice_recording");
    await page.getByTestId("bar-back").click();

    // the microphone only on «Записать»
    expect(await gumCalls(page)).toBe(0);
    await page.getByTestId("cd-pron").click();
    await expect(page.getByTestId("pron-ref")).toHaveText("to go");
    expect(await gumCalls(page)).toBe(0);
    await page.getByTestId("pron-record").click();
    await expect(page.getByTestId("pron-recording")).toBeVisible();
    await expect(page.getByTestId("pron-recording")).toContainText("Идёт запись");
    await page.waitForTimeout(1300);
    await page.getByTestId("pron-stop").click();
    await expect(page.getByTestId("pron-result")).toHaveAttribute("data-status", "ok");
    await expect(page.getByTestId("pron-intel")).toHaveText("В основном понятно");
    await expect(page.getByTestId("pron-words").locator("li")).toHaveCount(2);
    await expect(page.getByTestId("pron-words").locator("li").nth(1)).toHaveAttribute("data-mark", "practice");
    await expect(page.getByTestId("pron-words").locator("li").nth(1)).toHaveAttribute("aria-label", "go — потренировать");
    await expect(page.getByTestId("pron-tips")).toContainText("go");
    await shot(page, "29_pronunciation");
    const call = bff.last("POST", "/v1/memory/pronunciation")!;
    expect(call.query.get("target")).toBe(`card:${I.togo}`);
    expect(call.headers["content-type"]).toBe("audio/wav");
    const wav = bff.memory.lastWav!;
    expect(wav).toMatchObject({ rate: 16000, channels: 1, bits: 16 });
    expect(wav.durationMs).toBeGreaterThanOrEqual(500);
    expect(wav.durationMs).toBeLessThanOrEqual(15_000);
    // 16 000 samples of 2 bytes per second after the 44-byte header
    expect(Math.abs((wav.bytes - 44) / 32 - wav.durationMs)).toBeLessThanOrEqual(1);
    expect(await gumCalls(page)).toBe(1);
    // «Ещё раз»
    await page.getByTestId("pron-again").click();
    await expect(page.getByTestId("pron-record")).toBeVisible();
  });

  test("отказ в микрофоне: понятное сообщение, инструкция и текстовый резерв, без повторных запросов", async ({ page }) => {
    await installMic(page, "denied");
    const bff = await start(page, { purposes: VOICE });
    await openCard(page, I.togo);
    await page.getByTestId("cd-pron").click();
    await page.getByTestId("pron-record").click();
    await expect(page.getByTestId("pron-mic")).toHaveAttribute("data-reason", "denied");
    await expect(page.getByTestId("pron-mic")).toContainText("Нет доступа к микрофону.");
    await expect(page.getByTestId("pron-mic")).toContainText("Настройки → Telegram → Микрофон");
    await expect(page.getByTestId("pron-text-way")).toContainText("послушайте образец и повторите вслух");
    await page.waitForTimeout(600);
    expect(await gumCalls(page)).toBe(1);
    await page.getByTestId("pron-retry").click();
    await expect(page.getByTestId("pron-record")).toBeVisible();
    expect(await gumCalls(page)).toBe(1);
    expect(bff.calls("POST", "/v1/memory/pronunciation")).toHaveLength(0);
    // the sample still plays (the text way)
    await page.getByTestId("pron-sample").click();
    await expect.poll(() => bff.calls("POST", "/v1/speech").length).toBeGreaterThan(0);
  });

  test("нет getUserMedia: запись недоступна на устройстве, без кнопки повтора", async ({ page }) => {
    await installMic(page, "none");
    await start(page, { purposes: VOICE });
    await openCard(page, I.togo);
    await page.getByTestId("cd-pron").click();
    await page.getByTestId("pron-record").click();
    await expect(page.getByTestId("pron-mic")).toHaveAttribute("data-reason", "unsupported");
    await expect(page.getByTestId("pron-retry")).toHaveCount(0);
  });

  test("не удалось оценить (insufficient_evidence) — дружелюбное сообщение; предложение текста — своя цель", async ({ page }) => {
    await installMic(page, "ok");
    const bff = await start(page, { purposes: VOICE, memory: { pronResult: "insufficient_evidence" } });
    await page.getByTestId("home-practice").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Чтение" }).click();
    await page.getByTestId("rd-rd-cafe-morning").click();
    await page.getByTestId("rd-s-act-s4").click();
    await page.getByTestId("rd-pron").click();
    await expect(page.getByTestId("pron-sheet")).toBeVisible();
    await expect(page.getByTestId("rd-sentence-sheet")).toHaveCount(0);
    await page.getByTestId("pron-record").click();
    await expect(page.getByTestId("pron-recording")).toBeVisible();
    await page.waitForTimeout(1000);
    await page.getByTestId("pron-stop").click();
    await expect(page.getByTestId("pron-result")).toHaveAttribute("data-status", "insufficient_evidence");
    await expect(page.getByTestId("pron-result")).toContainText("Не удалось оценить — говорите ближе к микрофону");
    expect(bff.last("POST", "/v1/memory/pronunciation")?.query.get("target")).toBe("sentence:reading:rd-cafe-morning:2:s4");
  });

  test("подросток без согласия родителя: объяснение; оценка выключена — кнопки нет", async ({ page }) => {
    await start(page, { age: "14-17", guardian: "pending", purposes: ["terms", "privacy", "learning"] });
    await openCard(page, I.togo);
    await expect(page.getByTestId("cd-pron-consent")).toHaveAttribute("data-who", "guardian");
    await expect(page.getByTestId("cd-pron-consent")).toContainText("после согласия родителя");
    await page.getByTestId("bar-back").click();
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-voice").click();
    await expect(page.getByTestId("vc-self")).toBeDisabled();
    await expect(page.getByTestId("vc-to-guardian")).toBeVisible();
  });

  test("оценка недоступна (нет ключа Azure): ни кнопки, ни раздела", async ({ page }) => {
    await start(page, { purposes: VOICE, memory: { speech: "unavailable" } });
    await openCard(page, I.togo);
    await expect(page.getByTestId("cd-pron")).toHaveCount(0);
    await expect(page.getByTestId("cd-pron-consent")).toHaveCount(0);
  });

  test("родитель включает запись голоса ребёнку в «Семье»", async ({ page }) => {
    const bff = await start(page, { withChild: true });
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-family").click();
    const toggle = page.getByTestId(`vc-child-${KID_ID}`);
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(page.getByTestId("toast")).toHaveText("Запись голоса для Мадина включена");
    expect(bff.last("PUT", `/v1/learners/${KID_ID}/voice-consent`)?.body).toEqual({ granted: true });
    await expect(toggle).toBeChecked();
    // the same switch on «Запись голоса»
    await page.getByTestId("bar-back").click();
    await page.getByTestId("row-voice").click();
    await expect(page.getByTestId("vc-children").getByTestId(`vc-child-${KID_ID}`)).toBeChecked();
  });
});

test.describe("ребёнок", () => {
  test("мягкие формулировки, без журнала ошибок, детские тексты, «попроси родителя»", async ({ page }) => {
    await start(page, { child: true });
    await expect(page.getByTestId("review-card-line")).toHaveText("Давай вспомним слова!");
    await page.getByTestId("review-card-go").click();
    await page.getByTestId("rv-got").click();
    // a wrong choice: no «неверно» for a child
    await page.getByTestId("rv-opt-1").click();
    await page.getByTestId("rv-answer").click();
    await expect(page.getByTestId("rv-feedback")).toContainText("Давай запомним вместе");
    await shot(page, "33_review_kid");
    await expect(page.getByTestId("rv-feedback")).not.toContainText("неверно");
    await expect(page.getByTestId("rv-requeued")).toHaveText("Мы ещё встретимся с этим словом сегодня");
    await page.getByTestId("rv-next").click();
    await page.getByTestId("rv-opt-0").click();
    await page.getByTestId("rv-answer").click();
    await page.getByTestId("rv-next").click();
    // assemble letters instead of typing (6–9)
    await expect(page.getByTestId("rv-task-assemble")).toBeVisible();
    for (const i of [3, 1, 0, 4, 5, 2]) await page.getByTestId(`rv-tile-${i}`).click();
    await expect(page.getByTestId("rv-assembled")).toHaveText("yellow");
    await page.getByTestId("rv-answer").click();
    await expect(page.getByTestId("rv-feedback")).toContainText("Отлично!");
    await page.getByTestId("rv-next").click();
    for (const i of [1, 0]) await page.getByTestId(`rv-tile-${i}`).click();
    await page.getByTestId("rv-answer").click();
    await page.getByTestId("rv-next").click();
    await page.getByTestId("rv-opt-0").click();
    await page.getByTestId("rv-answer").click();
    await page.getByTestId("rv-next").click();
    await expect(page.getByTestId("rv-sum-title")).toHaveText("Молодец! Повторение готово");
    await expect(page.getByTestId("rv-sum-again")).toHaveCount(0);
    await page.getByTestId("rv-sum-done").click();

    // the dictionary: no error journal
    await page.getByTestId("tab-review").click();
    await expect(page.getByTestId("dict-view").getByRole("button")).toHaveCount(3);
    await expect(page.getByTestId("dict-view")).not.toContainText("Ошибки");
    // pronunciation: ask a parent
    await page.getByTestId(`dict-card-${I.lion}`).click();
    await expect(page.getByTestId("cd-pron-consent")).toHaveAttribute("data-who", "child");
    await expect(page.getByTestId("cd-pron-consent")).toContainText("Попроси родителя");
    await page.getByTestId("bar-back").click();
    // reading: only children's texts
    await page.getByTestId("tab-home").click();
    await page.getByTestId("home-practice").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Чтение" }).click();
    await expect(page.getByTestId("rd-list").locator("button")).toHaveCount(1);
    await expect(page.getByTestId("rd-rd-kids-cat")).toContainText("Мой кот");
  });

  test("с согласием родителя ребёнок может записать произношение", async ({ page }) => {
    await installMic(page, "ok");
    await start(page, { child: true, childVoice: true });
    await page.getByTestId("tab-review").click();
    await page.getByTestId(`dict-card-${I.lion}`).click();
    await expect(page.getByTestId("cd-pron")).toBeVisible();
    // the child cannot change the consent: no «Запись голоса» in the profile
    await page.getByTestId("bar-back").click();
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("row-voice")).toHaveCount(0);
  });
});

test.describe("узбекский", () => {
  test("словарь и повторение на латинице, без кириллицы", async ({ page }) => {
    await start(page, { locale: "uz" });
    await expect(page.getByTestId("review-card")).toContainText("Kunlik takrorlash");
    await page.getByTestId("tab-review").click();
    await expect(page.getByTestId("tab-review")).toHaveText("Lugʻat");
    const text = await page.getByTestId("dictionary").innerText();
    // the English words and the Uzbek translations only
    expect(CYRILLIC.test(text)).toBe(false);
    await page.getByTestId("dict-review-go").click();
    await expect(page.getByTestId("rv-check")).toContainText("Tekshiruv:");
    expect(CYRILLIC.test(await page.locator(".app").innerText())).toBe(false);
  });
});

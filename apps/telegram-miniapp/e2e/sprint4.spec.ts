import { expect, test, type Page } from "@playwright/test";
import type { LessonsScenario } from "./fixtures/lessons";
import * as F from "./fixtures/data";
import type { Scenario } from "./fixtures/mock-bff";
import { installSpeech, played, sources, spoken } from "./fixtures/speech";
import { CYRILLIC, open } from "./helpers";

/**
 * Sprint 4 on the mock BFF: the lesson of five stages (choices and free text), pause and continue after a reload, a lost
 * answer re-sent, «Объясни проще», the roleplay to «не вышло» → «ещё раз» → success, the summary with errors, the appeal
 * and its decision, a child (no text field), the simplified mode, practice of a scenario and of a media item, RU / UZ,
 * the dark notebook and a 375 px phone.
 */
const ALL_SEEN = [F.WELCOME.id, F.UPDATE_1.id, F.UPDATE_2.id];

async function start(page: Page, lessons: LessonsScenario = {}, sc: Scenario = {}) {
  await installSpeech(page);
  return open(page, { onboarded: true, seen: ALL_SEEN, content: { diag: "completed" }, lessons, ...sc });
}

/** Home → «Начать занятие» → the lesson card → «Начать урок» → the player. */
async function startLesson(page: Page) {
  await page.getByTestId("start-lesson").click();
  await expect(page.getByTestId("lesson-card")).toBeVisible();
  await page.getByTestId("lc-start").click();
  await expect(page.getByTestId("pl-header")).toBeVisible();
}

async function choose(page: Page, type: string, opt: number) {
  await expect(page.getByTestId(`pl-item-${type}`)).toBeVisible();
  await page.getByTestId(`pl-opt-${opt}`).click();
  await page.getByTestId("pl-answer").click();
}

/** Retrieval (2 items with feedback), explanation, the meaning check → the roleplay. */
async function toRoleplay(page: Page) {
  await choose(page, "single_choice", 0);
  await expect(page.getByTestId("pl-feedback")).toContainText("Верно!");
  await page.getByTestId("pl-next").click();
  await expect(page.getByTestId("pl-item-order_words")).toBeVisible();
  for (const w of [1, 3, 4, 0, 2]) await page.getByTestId(`ow-word-${w}`).click();
  await page.getByTestId("pl-answer").click();
  await page.getByTestId("pl-next").click();
  await expect(page.getByTestId("pl-explanation")).toBeVisible();
  await page.getByTestId("pl-next").click();
  await choose(page, "meaning_check", 0);
  await page.getByTestId("pl-next").click();
  await expect(page.getByTestId("pl-roleplay")).toBeVisible();
}

/** The check without hints and the open answer → done. */
async function check(page: Page, gap = "like", open: string | null = "I'd like a latte to go and the bill, please.") {
  await expect(page.getByTestId("pl-graded")).toBeVisible();
  await page.getByTestId("pl-gap-input").fill(gap);
  await page.getByTestId("pl-answer").click();
  await expect(page.getByTestId("toast")).toHaveText("Ответ принят");
  await choose(page, "translate_choice", 0);
  if (open !== null) {
    await page.getByTestId("pl-open-input").fill(open);
    await page.getByTestId("pl-open-send").click();
  }
  await expect(page.getByTestId("pl-done")).toBeVisible();
}

test.describe("урок 20 минут", () => {
  test("целиком: 5 этапов, свободный текст в разговоре, проверка без подсказок, итоги с ошибками и оговоркой CEFR", async ({ page }) => {
    const bff = await start(page);
    await startLesson(page);
    expect(bff.last("POST", "/v1/lessons/l-a1-03-cafe/sessions")?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    // header: the stage in words and the strip of five stages
    await expect(page.getByTestId("pl-stage")).toHaveText("Повторение");
    await expect(page.getByTestId("pl-stage-of")).toHaveText("этап 1 из 5 · шаг 1 из 2");
    await expect(page.getByTestId("pl-strip").locator(".lp-seg")).toHaveCount(5);
    // retrieval: a wrong answer gets «Пока неверно» with the right one at once
    await choose(page, "single_choice", 1);
    await expect(page.getByTestId("pl-feedback")).toContainText("Пока неверно");
    await expect(page.getByTestId("pl-right-answer")).toHaveText("Правильно: счёт");
    await page.getByTestId("pl-next").click();
    await page.getByTestId("pl-hint-btn").click();
    await expect(page.getByTestId("pl-hint")).toContainText("Начните с Could.");
    for (const w of [1, 3, 4, 0, 2]) await page.getByTestId(`ow-word-${w}`).click();
    await page.getByTestId("pl-answer").click();
    await expect(page.getByTestId("pl-feedback")).toContainText("Верно!");
    await page.getByTestId("pl-next").click();
    // explanation: translation on tap, key words, «Объясни проще» (AI on the learner's language), the position is kept
    await expect(page.getByTestId("pl-stage")).toHaveText("Объяснение");
    await page.getByTestId("pl-ex-0").click();
    await expect(page.getByTestId("pl-ex-gloss-0")).toHaveText("Мне суп, пожалуйста.");
    await page.getByRole("button", { name: "the bill" }).click();
    await expect(page.getByTestId("pl-kw")).toContainText("счёт");
    await page.getByTestId("pl-simpler").click();
    await expect(page.getByTestId("pl-simpler-card")).toContainText("Проще: «I’d like» — это как «мне, пожалуйста»");
    expect(bff.last("POST", /\/simpler$/)?.query.get("locale")).toBe("ru");
    await expect(page.getByTestId("pl-explanation")).toBeVisible();
    await page.getByTestId("pl-next").click();
    await choose(page, "meaning_check", 0);
    await page.getByTestId("pl-next").click();
    // roleplay: free text (adult, AI on), the character answers, the scene ends by the graph
    await expect(page.getByTestId("pl-stage")).toHaveText("Разговор");
    await expect(page.getByTestId("rp-ch").first()).toContainText("Hi! What can I get you?");
    // «Прослушать» — MP3 of the server speech in the character's voice (release 4.1), not the device voice
    const before = await played(page);
    await page.getByTestId("rp-listen").first().click();
    await expect.poll(async () => (await played(page)) - before).toBe(1);
    expect(bff.last("POST", "/v1/speech")?.body).toEqual({ text: "Hi! What can I get you?", variant: "en-GB", speed: "normal" });
    expect((await spoken(page)).map((s) => s.text)).not.toContain("Hi! What can I get you?");
    await page.getByTestId("rp-input").fill("I want a latte");
    await page.getByTestId("rp-send").click();
    await expect(page.getByTestId("rp-me")).toHaveText(/I want a latte/);
    await expect(page.getByTestId("rp-ch").last()).toContainText("Sure! Anything else?");
    await page.getByTestId("rp-input").fill("Could I have the bill?");
    await page.getByTestId("rp-send").click();
    await expect(page.getByTestId("pl-outcome")).toHaveAttribute("data-outcome", "success");
    await expect(page.getByTestId("pl-outcome")).toContainText("Задача выполнена");
    await page.getByTestId("pl-next").click();
    // the check without hints: no hint, no correctness
    await expect(page.getByTestId("pl-stage")).toHaveText("Проверка без подсказок");
    await expect(page.getByTestId("pl-hint-btn")).toHaveCount(0);
    await check(page, "likes");
    await expect(page.getByTestId("pl-feedback")).toHaveCount(0);
    await page.getByTestId("pl-finish").click();
    // summary
    const sm = page.getByTestId("summary");
    await expect(sm).toBeVisible();
    await expect(page.getByTestId("sm-task")).toHaveText("Задача выполнена");
    await expect(page.getByTestId("sm-not-cefr")).toContainText("Это не сертификат CEFR");
    await expect(page.getByTestId("sm-errors")).toContainText("I want a latte");
    await expect(page.getByTestId("sm-errors")).toContainText("лучше: I’d like a latte");
    await expect(page.getByTestId("sm-item-a-gap")).toContainText("likes");
    await expect(page.getByTestId("sm-item-a-gap")).toContainText("like");
    await expect(page.getByTestId("sm-items")).not.toContainText("Could I have some water?");
    await expect(page.getByTestId("sm-score-pronunciation")).toContainText("не оценивалось в этом формате");
    await expect(page.getByTestId("sm-skills")).toContainText("Вежливая просьба в кафе");
    await expect(page.getByTestId("sm-words")).toContainText("the bill");
    await expect(page.getByTestId("sm-next")).toContainText("В магазине: цены и размеры");
    expect(bff.calls("POST", /\/finish$/)).toHaveLength(1);
    // the lesson is in the plan with «повторить», in the history; manual activity is never called
    await page.getByTestId("sm-done").click();
    await page.getByTestId("bar-back").click(); // the lesson card → Home
    await page.getByTestId("tab-lessons").click();
    await expect(page.getByTestId("ls-completed")).toContainText("повторим");
    await expect(page.getByTestId("ls-history")).toContainText("задача выполнена");
    expect(bff.calls("POST", "/v1/plan/activity")).toHaveLength(0);
  });

  test("пауза и продолжение после перезагрузки: тот же шаг; выход — «Продолжить урок» на главной и во вкладке", async ({ page }) => {
    const bff = await start(page);
    await startLesson(page);
    await choose(page, "single_choice", 0);
    await page.getByTestId("pl-next").click();
    await expect(page.getByTestId("pl-item-order_words")).toBeVisible();
    // the Mini App is reloaded with the player open → the same session from the same step
    await page.reload();
    await expect(page.getByTestId("pl-item-order_words")).toBeVisible();
    await expect(page.getByTestId("pl-stage-of")).toHaveText("этап 1 из 5 · шаг 2 из 2");
    // pause from the menu and continue
    await page.getByTestId("pl-menu").click();
    await page.getByTestId("pl-pause").click();
    await expect(page.getByTestId("pl-paused")).toContainText("Урок на паузе");
    await page.getByTestId("pl-resume").click();
    await expect(page.getByTestId("pl-item-order_words")).toBeVisible();
    // exit → paused on the server, «Продолжить урок» on Home and in «Уроки»
    await page.getByTestId("pl-menu").click();
    await page.getByTestId("pl-exit").click();
    await expect(page.getByTestId("toast")).toHaveText("Урок на паузе. Продолжите с этапа «Повторение».");
    expect(bff.calls("POST", /\/pause$/).length).toBeGreaterThanOrEqual(2);
    // after the reload the player was the only screen on the stack → back on Home
    await expect(page.getByTestId("start-lesson")).toHaveText("Продолжить урок");
    await expect(page.getByTestId("today-active")).toContainText("В кафе: заказ напитков");
    await page.reload();
    await expect(page.getByTestId("today-card")).toBeVisible();
    await expect(page.getByTestId("pl-header")).toHaveCount(0); // a deliberate exit is not reopened
    await page.getByTestId("tab-lessons").click();
    await expect(page.getByTestId("active-card")).toContainText("На паузе");
    await page.getByTestId("active-continue").click();
    await expect(page.getByTestId("pl-item-order_words")).toBeVisible();
  });

  test("обрыв сети на ответе: тот же ответ отправляется ещё раз, сервер отвечает так же", async ({ page }) => {
    const bff = await start(page, {}, { dropResponseOnce: ["POST /v1/sessions/*/steps/*"] });
    await startLesson(page);
    await choose(page, "single_choice", 0);
    await expect(page.getByTestId("pl-send-failed")).toContainText("Ответ не отправился");
    await page.getByTestId("pl-resend").click();
    await expect(page.getByTestId("pl-feedback")).toContainText("Верно!");
    const posts = bff.calls("POST", /\/steps\/s1$/);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    await page.getByTestId("pl-next").click();
    await expect(page.getByTestId("pl-stage-of")).toHaveText("этап 1 из 5 · шаг 2 из 2");
  });

  test("409 SESSION_ACTIVE: «Продолжить» или «Отменить и начать новое»", async ({ page }) => {
    const bff = await start(page, { active: "paused" });
    await page.getByTestId("tab-lessons").click();
    await page.getByTestId("ls-lesson-l-a1-04-shop").click();
    await page.getByTestId("lc-start").click();
    const sheet = page.getByTestId("active-session-sheet");
    await expect(sheet).toContainText("«В кафе: заказ напитков» ещё не закончено");
    await sheet.getByTestId("as-cancel-new").click();
    await expect(page.getByTestId("pl-header")).toBeVisible();
    expect(bff.calls("POST", /\/cancel$/)).toHaveLength(1);
    expect(bff.calls("POST", "/v1/lessons/l-a1-04-shop/sessions")).toHaveLength(2);
  });
});

test.describe("ролевая ситуация, итоги, апелляция", () => {
  test("«Разыграть» сценарий: не вышло → «Попробовать ещё раз» → успех → итоги разговора", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("home-practice").click();
    await page.getByTestId("sc-sc-cafe-order").click();
    await page.getByTestId("sc-play").click();
    await expect(page.getByTestId("pl-roleplay")).toBeVisible();
    expect(bff.last("POST", "/v1/scenarios/sc-cafe-order/sessions")?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await page.getByTestId("rp-hint-btn").click();
    await expect(page.getByTestId("rp-hint")).toContainText("Подсказка учитывается в оценке");
    await page.getByTestId("rp-choice-c2").click();
    await expect(page.getByTestId("pl-outcome")).toHaveAttribute("data-outcome", "fail");
    await expect(page.getByTestId("pl-outcome")).toContainText("Не вышло — бывает");
    await page.getByTestId("pl-rp-retry").click();
    await expect(page.getByTestId("pl-roleplay")).toBeVisible();
    await page.getByTestId("rp-choice-c1").click();
    await expect(page.getByTestId("rp-ch").last()).toContainText("Sure! Anything else?");
    await page.getByTestId("rp-choice-c3").click();
    await expect(page.getByTestId("pl-outcome")).toHaveAttribute("data-outcome", "success");
    await expect(page.getByTestId("pl-rp-retry")).toHaveCount(0);
    await page.getByTestId("pl-next").click();
    await page.getByTestId("pl-finish").click();
    await expect(page.getByTestId("summary")).toBeVisible();
    await expect(page.getByRole("paragraph").filter({ hasText: "Итоги разговора" })).toBeVisible();
    await expect(page.getByTestId("sm-score-independence")).toContainText("хорошо");
  });

  test("апелляция: причина → «подана»; решение методиста «исправлена» → актуальная оценка и комментарий; уведомление ведёт в «Уроки»", async ({ page }) => {
    const bff = await start(page, {}, {
      inbox: [{ notification_id: "22222222-aaaa-4bbb-8ccc-000000000009", category: "support", title: "Мы проверили вашу оценку урока", body: "Оценка исправлена.", startapp: "route_lessons", created_at: "2026-11-19T10:00:00Z", read_at: null, telegram: "sent" }],
    });
    await startLesson(page);
    await toRoleplay(page);
    await page.getByTestId("rp-choice-c1").click();
    await page.getByTestId("rp-choice-c4").click();
    await page.getByTestId("pl-next").click();
    await check(page, "likes", "I want a coffee to go.");
    await page.getByTestId("pl-finish").click();
    await page.getByTestId("sm-appeal").click();
    await expect(page.getByTestId("appeal")).toContainText("В кафе: заказ напитков");
    const reason = "«like» — опечатка, остальное верно";
    await page.getByTestId("ap-reason").fill(reason);
    await expect(page.getByTestId("appeal")).toContainText(`${reason.length} из 500`);
    await page.getByTestId("ap-send").click();
    await expect(page.getByTestId("toast")).toContainText("Апелляция отправлена");
    await expect(page.getByTestId("sm-appeal-state")).toContainText("Апелляция подана");
    await expect(page.getByTestId("sm-appeal")).toHaveCount(0);
    const post = bff.last("POST", /\/appeal$/)!;
    expect(post.body).toEqual({ reason: "«like» — опечатка, остальное верно" });
    expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    // the methodologist corrects the evaluation; the notification leads to «Уроки»
    const appeal = [...bff.lessons.appeals.values()][0]!;
    bff.lessons.decide(appeal.appeal_id, "corrected", "Проверили: опечатка не меняет оценку задачи.");
    await page.getByTestId("sm-done").click();
    await page.getByTestId("bar-back").click();
    await page.getByTestId("bell").click();
    await page.getByTestId("inbox-item").first().click();
    await expect(page.getByTestId("tab-lessons")).toHaveAttribute("aria-current", "page");
    await page.getByTestId("ls-history").getByRole("button").first().click();
    await expect(page.getByTestId("sm-corrected")).toBeVisible();
    await expect(page.getByTestId("sm-appeal-state")).toContainText("Оценка исправлена.");
    await expect(page.getByTestId("sm-appeal-state")).toContainText("Комментарий методиста: Проверили");
  });

  test("оценка появится позже: итоги без оценки, «Проверить оценку» перезапрашивает итоги", async ({ page }) => {
    const bff = await start(page, { evaluationLater: true });
    await page.getByTestId("home-practice").click();
    await page.getByTestId("sc-sc-cafe-order").click();
    await page.getByTestId("sc-play").click();
    await page.getByTestId("rp-choice-c1").click();
    await page.getByTestId("rp-choice-c3").click();
    await page.getByTestId("pl-next").click();
    await page.getByTestId("pl-finish").click();
    await expect(page.getByTestId("sm-pending")).toContainText("Оценка появится позже");
    await page.getByTestId("sm-refresh").click();
    await expect.poll(() => bff.calls("GET", /\/summary$/).length).toBe(1);
    await expect(page.getByTestId("sm-appeal")).toHaveCount(0);
  });
});

test.describe("дети, упрощённый режим, практика медиа", () => {
  test("ребёнок: детский урок, в разговоре только варианты (поля ввода нет), без открытого ответа", async ({ page }) => {
    const bff = await start(page, {}, { child: true });
    await startLesson(page);
    await expect(page.getByTestId("pl-notice")).toContainText("Повторять пока нечего");
    await page.getByTestId("pl-next").click();
    await expect(page.getByTestId("pl-explanation")).toBeVisible();
    await page.getByTestId("pl-next").click();
    await expect(page.getByTestId("pl-roleplay")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Выбери ответ" })).toBeVisible();
    await expect(page.getByTestId("rp-input")).toHaveCount(0);
    await expect(page.locator("textarea, input[type=text]")).toHaveCount(0);
    await page.getByTestId("rp-choice-c1").click();
    await page.getByTestId("rp-choice-c4").click();
    await page.getByTestId("pl-next").click();
    await choose(page, "single_choice", 0);
    await expect(page.getByTestId("pl-done")).toBeVisible();
    await page.getByTestId("pl-finish").click();
    await expect(page.getByTestId("sm-task")).toHaveText("Задача выполнена");
    expect(bff.calls("POST", /\/steps\//).every((c) => !("text" in ((c.body as object) ?? {})))).toBe(true);
  });

  test("упрощённый режим (ИИ недоступен): нейтральная плашка, выбор реплик, урок проходится", async ({ page }) => {
    await start(page, { aiDegraded: true });
    await startLesson(page);
    await toRoleplay(page);
    await expect(page.getByTestId("pl-degraded")).toContainText("упрощённом режиме");
    await expect(page.getByTestId("rp-input")).toHaveCount(0);
    await page.getByTestId("rp-choice-c1").click();
    await page.getByTestId("rp-choice-c3").click();
    await page.getByTestId("pl-next").click();
    await check(page, "like", null);
    await page.getByTestId("pl-finish").click();
    await expect(page.getByTestId("sm-task")).toHaveText("Задача выполнена");
  });

  test("медиа: прослушивание в уроке с файлом — файл загружен при показе шага и играет в нажатии на общем аудиоэлементе", async ({ page }) => {
    const bff = await start(page, { listenFile: true });
    await page.getByTestId("home-practice").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Медиатека" }).click();
    await page.getByTestId("md-m-own-coffee").click();
    const files = () => bff.calls("GET", "/v1/media/m-own-coffee/audio").length;
    await expect.poll(files).toBe(1); // the media screen fetched it when shown
    await page.getByTestId("md-exercises-start").click();
    await expect(page.getByTestId("pl-stage")).toHaveText("Прослушивание");
    // the step fetches the file when shown (the media screen's load finished long before), never in the tap
    await expect.poll(files).toBe(2);
    const before = await played(page);
    await page.getByTestId("pl-play").click();
    await expect.poll(() => played(page)).toBe(before + 1);
    expect((await sources(page)).at(-1)).toMatch(/^blob:/);
    await expect(page.getByTestId("pl-play")).toHaveText("Слушать"); // ended
    expect(files()).toBe(2); // nothing fetched in the tap
    expect(bff.calls("POST", "/v1/speech")).toHaveLength(0);
  });

  test("медиа: «Упражнения» — прослушивание (синтез речи), понимание, порядок реплик, пропуск, значение фразы → итоги", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("home-practice").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Медиатека" }).click();
    await page.getByTestId("md-m-own-train").click();
    await expect(page.getByTestId("md-exercises-start")).toHaveCount(0); // no exercises — no button
    await page.getByTestId("bar-back").click();
    await page.getByTestId("md-m-own-coffee").click();
    await page.getByTestId("md-exercises-start").click();
    await expect(page.getByTestId("pl-listen")).toBeVisible();
    await expect(page.getByTestId("pl-stage")).toHaveText("Прослушивание");
    // without a file: the lines as server speech, each in its speaker's voice, one after another (release 4.1)
    const before = await played(page);
    await page.getByTestId("pl-play").click();
    await expect.poll(async () => (await played(page)) - before).toBe(2);
    // (the media screen before prefetched the first line of its own dialogue — only the lesson's lines are checked)
    expect(bff.calls("POST", "/v1/speech").slice(-2).map((c) => c.body)).toEqual([
      { text: "Hi! What would you like?", variant: "en-GB", speed: "normal" },
      { text: "A latte to go, please.", variant: "en-US", speed: "normal" },
    ]);
    expect(await spoken(page)).toEqual([]);
    await page.getByTestId("pl-line-1").click();
    await expect(page.getByTestId("pl-transcript")).toContainText("Латте с собой, пожалуйста.");
    await page.getByTestId("pl-next").click();
    await choose(page, "comprehension", 1);
    await expect(page.getByTestId("toast")).toHaveText("Ответ принят");
    await expect(page.getByTestId("pl-item-order_lines")).toBeVisible();
    await page.getByTestId("ow-word-1").click();
    await page.getByTestId("ow-word-0").click();
    await page.getByTestId("pl-answer").click();
    await choose(page, "gap_fill_media", 0);
    await choose(page, "phrase_meaning", 0);
    await page.getByTestId("pl-finish").click();
    await expect(page.getByRole("paragraph").filter({ hasText: "Итоги упражнений" })).toBeVisible();
    await expect(page.getByTestId("sm-all-right")).toBeVisible();
    const answers = bff.calls("POST", /\/steps\//).map((c) => c.body);
    expect(answers).toContainEqual({ answer: ["Hi! What would you like?", "A latte to go, please."] });
    expect(answers).toContainEqual({ answer: "to" });
  });
});

test.describe("языки, тема, ширина", () => {
  test("UZ: карточка урока и плеер без кириллицы в интерфейсе", async ({ page }) => {
    await start(page, {}, { locale: "uz" });
    await page.getByTestId("start-lesson").click();
    await expect(page.getByTestId("lesson-card")).toContainText("Dars qanday oʻtadi");
    await page.getByTestId("lc-start").click();
    await expect(page.getByTestId("pl-stage")).toHaveText("Takrorlash");
    await expect(page.getByTestId("pl-stage-of")).toHaveText("5 bosqichdan 1-bosqich · 2 qadamdan 1-qadam");
    // the options of a translation item are Russian by design (the course is ru → en); the interface is not
    const ui = await page.locator(".lp-bar, .foot, .lp-instr").allInnerTexts();
    expect(CYRILLIC.test(ui.join(" "))).toBe(false);
    await choose(page, "single_choice", 0);
    await expect(page.getByTestId("pl-feedback")).toContainText("Toʻgʻri!");
    expect((await page.evaluate(() => document.documentElement.lang))).toBe("uz");
  });

  test("тёмная тетрадь и 375 px: плеер и итоги без горизонтальной прокрутки, тач-цели ≥ 44 px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.emulateMedia({ colorScheme: "dark" });
    await start(page);
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
    await startLesson(page);
    await toRoleplay(page);
    const noHScroll = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".app, .scroll")].every((el) => el.scrollWidth <= el.clientWidth + 1));
    expect(await noHScroll()).toBe(true);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".app button:not(.ow-word)")]
        .filter((b) => b.offsetParent !== null)
        .map((b) => ({ t: b.getAttribute("data-testid") ?? b.textContent, h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width }))
        .filter((b) => b.h < 43.5 || b.w < 43.5),
    );
    expect(small).toEqual([]);
    await page.getByTestId("rp-choice-c1").click();
    await page.getByTestId("rp-choice-c3").click();
    await page.getByTestId("pl-next").click();
    await check(page);
    await page.getByTestId("pl-finish").click();
    await expect(page.getByTestId("summary")).toBeVisible();
    expect(await noHScroll()).toBe(true);
  });
});

test.describe("ревью R2: таймауты, оценка позже, окно апелляции, упрощённый режим", () => {
  test("R2-02: 503 после сохранения ответа — «сервис отвечает долго», тот же ответ ещё раз, второго шага нет", async ({ page }) => {
    const bff = await start(page, {}, { lateResponseOnce: { "POST /v1/sessions/*/steps/*": [503, "UPSTREAM_UNAVAILABLE"] } });
    await startLesson(page);
    await choose(page, "single_choice", 0);
    const failed = page.getByTestId("pl-send-failed");
    await expect(failed).toHaveAttribute("data-reason", "service");
    await expect(failed).toContainText("Сервис отвечает долго или временно недоступен");
    await expect(failed).not.toContainText("нет связи");
    // the BFF answered itself (one domain is slow): no global «Нет связи» banner
    await expect(page.getByTestId("offline")).toHaveCount(0);
    await page.getByTestId("pl-resend").click();
    await expect(page.getByTestId("pl-feedback")).toContainText("Верно!");
    const posts = bff.calls("POST", /\/steps\/s1$/);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    await page.getByTestId("pl-next").click();
    await expect(page.getByTestId("pl-stage-of")).toHaveText("этап 1 из 5 · шаг 2 из 2");
  });

  test("R2-02: обрыв сети на ответе — свой текст «нет связи», не «сервис отвечает долго»", async ({ page }) => {
    await start(page, {}, { dropResponseOnce: ["POST /v1/sessions/*/steps/*"] });
    await startLesson(page);
    await choose(page, "single_choice", 0);
    const failed = page.getByTestId("pl-send-failed");
    await expect(failed).toHaveAttribute("data-reason", "network");
    await expect(failed).toContainText("нет связи. Проверьте интернет");
    await expect(failed).not.toContainText("Сервис отвечает долго");
  });

  test("R2-03: оценка позже — без обещания «напишем в Telegram», итоги перечитываются сами, пока экран открыт", async ({ page }) => {
    await page.clock.install();
    const bff = await start(page, { evaluationLater: true, evaluationAfterReads: 2 });
    await page.getByTestId("home-practice").click();
    await page.getByTestId("sc-sc-cafe-order").click();
    await page.getByTestId("sc-play").click();
    await page.getByTestId("rp-choice-c1").click();
    await page.getByTestId("rp-choice-c3").click();
    await page.getByTestId("pl-next").click();
    await page.getByTestId("pl-finish").click();
    const pending = page.getByTestId("sm-pending");
    await expect(pending).toContainText("Оценка появится позже — пока этот экран открыт, мы проверяем её сами");
    await expect(pending).not.toContainText("Telegram");
    await expect(page.getByTestId("sm-refresh")).toBeVisible();
    expect(bff.calls("GET", /\/summary$/)).toHaveLength(0);
    await page.clock.runFor(5_000);
    await expect.poll(() => bff.calls("GET", /\/summary$/).length).toBe(1);
    await expect(pending).toBeVisible();
    await page.clock.runFor(10_000);
    await expect.poll(() => bff.calls("GET", /\/summary$/).length).toBe(2);
    await expect(pending).toHaveCount(0);
    await expect(page.getByTestId("sm-scores")).toBeVisible();
    await expect(page.getByTestId("sm-appeal")).toBeVisible();
    // the evaluation is there — no more reads; after leaving the screen — neither
    await page.getByTestId("sm-done").click();
    await page.clock.runFor(200_000);
    expect(bff.calls("GET", /\/summary$/)).toHaveLength(2);
  });

  test("R2-04: оценка старше 14 дней — вместо «Оспорить оценку» короткое пояснение (RU и UZ)", async ({ page }) => {
    await start(page, { evaluatedDaysAgo: 15 });
    await page.getByTestId("tab-lessons").click();
    await page.getByTestId("ls-history").getByRole("button").first().click();
    await expect(page.getByTestId("sm-scores")).toBeVisible();
    await expect(page.getByTestId("sm-appeal-closed")).toHaveText("Оспорить оценку можно в течение 14 дней — этот срок уже прошёл.");
    await expect(page.getByTestId("sm-appeal")).toHaveCount(0);

    const uz = await page.context().newPage();
    await start(uz, { evaluatedDaysAgo: 13 }, { locale: "uz" });
    await uz.getByTestId("tab-lessons").click();
    await uz.getByTestId("ls-history").getByRole("button").first().click();
    await expect(uz.getByTestId("sm-appeal")).toBeVisible();
    await expect(uz.getByTestId("sm-appeal-closed")).toHaveCount(0);
  });

  test("R2-05: ИИ пропал на свободном тексте — плашка упрощённого режима без перезагрузки, дальше выбор реплик", async ({ page }) => {
    const bff = await start(page, { aiDropsOnText: true });
    await page.getByTestId("home-practice").click();
    await page.getByTestId("sc-sc-cafe-order").click();
    await page.getByTestId("sc-play").click();
    await expect(page.getByTestId("pl-roleplay")).toBeVisible();
    await expect(page.getByTestId("pl-degraded")).toHaveCount(0);
    const SESSION = /^\/v1\/sessions\/[0-9a-f-]{36}$/;
    const reads = { session: bff.calls("GET", SESSION).length, current: bff.calls("GET", /\/current$/).length };
    await page.getByTestId("rp-input").fill("A latte, please");
    await page.getByTestId("rp-send").click();
    await expect(page.getByTestId("rp-clarify")).toContainText("Let's choose an answer.");
    await expect(page.getByTestId("pl-degraded")).toContainText("упрощённом режиме");
    await expect(page.getByTestId("rp-input")).toHaveCount(0);
    // the session was re-read once more (the plaque), the step was not reloaded
    expect(bff.calls("GET", SESSION)).toHaveLength(reads.session + 1);
    expect(bff.calls("GET", /\/current$/)).toHaveLength(reads.current);
    await page.getByTestId("rp-choice-c1").click();
    await expect(page.getByTestId("rp-ch").last()).toContainText("Sure! Anything else?");
    await expect(page.getByTestId("pl-degraded")).toBeVisible();
  });

  test("ИИ выключен с начала: карточка без обещания «свой ответ», плашка — с первого шага урока", async ({ page }) => {
    const bff = await start(page, { aiDegraded: true });
    await page.getByTestId("start-lesson").click();
    // lessons says roleplay_mode "choices" on the card when the AI is off — no promise of the own answer
    await expect(page.getByTestId("lc-format")).toContainText("выбор готовых реплик");
    await expect(page.getByTestId("lc-format")).not.toContainText("свой ответ");
    await page.getByTestId("lc-start").click();
    await expect(page.getByTestId("pl-item-single_choice")).toBeVisible();
    await expect(page.getByTestId("pl-stage")).toHaveText("Повторение");
    await expect(page.getByTestId("pl-degraded")).toContainText("Сейчас занятие идёт в упрощённом режиме");
    // the session started in the simplified mode: ai_mode choices, ai_degraded
    const started = [...bff.lessons.runs.values()].at(-1)!;
    expect([started.view.ai_mode, started.view.ai_degraded]).toEqual(["choices", true]);
    await choose(page, "single_choice", 0);
    await page.getByTestId("pl-next").click();
    await expect(page.getByTestId("pl-item-order_words")).toBeVisible();
    await expect(page.getByTestId("pl-degraded")).toBeVisible();
  });
});

test.describe("доделки координатора: AI_BUSY, тексты по сроку хранения", () => {
  test("409 AI_BUSY на свободном тексте: «Секунду, ответ ещё обрабатывается», тот же ответ через 2 с → ответ персонажа", async ({ page }) => {
    const bff = await start(page, { aiBusy: 2 });
    await page.getByTestId("home-practice").click();
    await page.getByTestId("sc-sc-cafe-order").click();
    await page.getByTestId("sc-play").click();
    await page.getByTestId("rp-input").fill("I'd like a latte, please");
    await page.getByTestId("rp-send").click();
    await expect(page.getByTestId("pl-busy")).toHaveText("Секунду, ответ ещё обрабатывается…");
    await expect(page.getByTestId("rp-ch").last()).toContainText("Sure! Anything else?", { timeout: 10_000 });
    await expect(page.getByTestId("pl-busy")).toHaveCount(0);
    const posts = bff.calls("POST", /\/steps\/s1$/);
    expect(posts).toHaveLength(3);
    for (const p of posts) expect(p.body).toEqual({ text: "I'd like a latte, please" });
  });

  test("апелляция решена больше 90 дней назад: «текст удалён по сроку хранения», у ошибок — только тип", async ({ page }) => {
    await start(page, { decided: "corrected", decidedDaysAgo: 100 });
    await page.getByTestId("tab-lessons").click();
    await page.getByTestId("ls-history").getByRole("button").first().click();
    await expect(page.getByTestId("sm-appeal-state")).toContainText("Оценка исправлена.");
    await expect(page.getByTestId("sm-appeal-reason")).toHaveText("Текст апелляции удалён по сроку хранения.");
    const errors = page.getByTestId("sm-error");
    await expect(errors.first()).toHaveAttribute("data-redacted", "true");
    await expect(page.getByTestId("sm-errors")).not.toContainText("Ваш вариант");
    await expect(page.getByTestId("sm-errors")).not.toContainText("лучше:");
    await expect(page.getByTestId("sm-error-type").first()).toHaveText("пропущенное слово");
  });
});

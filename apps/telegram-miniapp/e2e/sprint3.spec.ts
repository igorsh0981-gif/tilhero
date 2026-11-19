import { expect, test, type Page } from "@playwright/test";
import type { ContentScenario } from "./fixtures/content";
import * as F from "./fixtures/data";
import type { Scenario } from "./fixtures/mock-bff";
import { EN_VOICES, installSpeech, played, spoken, type FakeVoice } from "./fixtures/speech";
import { CYRILLIC, open, settle } from "./helpers";

/**
 * Sprint 3 on the mock BFF: placement test (choice, word order by taps and drag, listening by the device voice and
 * without it), result (not_assessed, «не сертификат CEFR», follow-up, retake date), skill map, «Мой план» and goal change,
 * practice (scenario and media filters, audio and speech synthesis), song / film requests (403 for a child),
 * «Мои языки», deep links, RU / UZ, the dark notebook and phone widths 375–412.
 */
const ALL_SEEN = [F.WELCOME.id, F.UPDATE_1.id, F.UPDATE_2.id];

async function start(page: Page, content: ContentScenario = {}, sc: Scenario = {}, voices: FakeVoice[] = EN_VOICES) {
  await installSpeech(page, voices);
  return open(page, { onboarded: true, seen: ALL_SEEN, content, ...sc });
}

async function answerChoice(page: Page, type: string, opt: number) {
  await expect(page.getByTestId(`dx-item-${type}`)).toBeVisible();
  await page.getByTestId(`dx-opt-${opt}`).click();
  await page.getByTestId("dx-answer").click();
}

test.describe("диагностика", () => {
  test("целиком: выбор, «Не знаю», порядок слов (тапы и перетаскивание), аудирование ≤ 2 раз → результат с not_assessed и оговоркой CEFR", async ({ page }) => {
    const bff = await start(page);
    const card = page.getByTestId("home-diag-card");
    await expect(card).toContainText("Узнаем ваш уровень · 10–15 минут");
    await card.getByTestId("home-diag-start").click();

    const intro = page.getByTestId("dx-intro");
    await expect(intro).toContainText("Это не экзамен и не сертификат");
    await expect(intro).toContainText("«Не знаю»");
    await expect(intro).toContainText("Говорение оценим позже");
    await page.getByTestId("dx-start").click();
    expect(bff.last("POST", "/v1/diagnostics/sessions")?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);

    // 1. single choice — the answer button waits for a choice; no correctness after answering
    await expect(page.getByTestId("dx-progress")).toHaveText("Задание 1 из ~5");
    await expect(page.getByTestId("dx-answer")).toBeDisabled();
    await answerChoice(page, "single_choice", 0);

    // 2. gap — «Не знаю»
    await expect(page.getByTestId("dx-item-gap_choice")).toBeVisible();
    await expect(page.getByTestId("dx-prompt").getByRole("img", { name: "пропуск" })).toBeVisible();
    await page.getByTestId("dx-dont-know").click();

    // 3. word order: tap, tap back, drag into the line
    await expect(page.getByTestId("dx-item-order_words")).toBeVisible();
    await page.getByTestId("ow-word-2").click(); // Where
    await page.getByTestId("ow-word-0").click(); // the (wrong)
    await page.getByTestId("ow-line-1").click(); // back to the bank
    await page.getByTestId("ow-word-1").click(); // is
    await page.getByTestId("ow-word-0").dragTo(page.getByTestId("ow-line")); // the — dragged
    await expect(page.getByTestId("dx-answer")).toBeDisabled();
    await page.getByTestId("ow-word-3").click(); // station?
    await expect(page.getByTestId("ow-line")).toHaveText("Whereisthestation?");
    await page.getByTestId("dx-answer").click();
    await expect.poll(() => bff.calls("POST", /\/answers$/).length).toBe(3);
    const answers = bff.calls("POST", /\/answers$/).map((c) => c.body);
    expect(answers[0]).toMatchObject({ item_id: "v-a1-03", answer: 0, dont_know: false });
    expect(answers[1]).toMatchObject({ item_id: "g-a1-07", answer: null, dont_know: true });
    expect(answers[2]).toMatchObject({ item_id: "g-a1-12", answer: ["Where", "is", "the", "station?"] });

    // 4. reading
    await expect(page.getByTestId("dx-passage")).toContainText("Aziz usually takes the bus");
    await answerChoice(page, "read_choice", 0);

    // 5. listening: the phrase is spoken by an en-* voice, at most twice; its text never shown
    const item = page.getByTestId("dx-item-listen_choice");
    await expect(item).toBeVisible();
    await expect(item).not.toContainText("green tea, please");
    const play = page.getByTestId("dx-listen-play");
    await play.click();
    await expect(page.getByTestId("dx-listen-left")).toContainText("Осталось прослушиваний: 1");
    await play.click();
    await expect(page.getByTestId("dx-listen-left")).toHaveText("Прослушивания закончились — выберите ответ.");
    await expect(play).toBeDisabled();
    expect((await spoken(page)).map((s) => [s.text, s.voice])).toEqual([
      ["Could I have a cup of green tea, please?", "Fake English (UK)"],
      ["Could I have a cup of green tea, please?", "Fake English (UK)"],
    ]);
    await expect(page.getByText(/верно|неверно/)).toHaveCount(0);
    await answerChoice(page, "listen_choice", 1);

    // result
    const res = page.getByTestId("dx-result");
    await expect(res).toBeVisible();
    await expect(page.getByTestId("dx-level")).toHaveText("Предварительный уровень: A1");
    await expect(page.getByTestId("not-cefr")).toHaveText("Это не сертификат CEFR — предварительная оценка внутри TilHero. Она уточняется по урокам.");
    await expect(page.getByTestId("area-speaking")).toHaveAttribute("data-status", "not_assessed");
    await expect(page.getByTestId("reason-speaking")).toHaveText("Говорение — после появления голосовых уроков.");
    await expect(page.getByTestId("conf-vocabulary")).toHaveAttribute("aria-label", "уверенность высокая: 3 из 3");
    // «почему так» — по полосам, без заданий и без отметок по отдельным заданиям
    await page.getByTestId("why-vocabulary").locator("summary").click();
    await expect(page.getByTestId("why-vocabulary-A1")).toHaveText("A1 — 3 из 3 верно");
    await expect(page.getByTestId("why-vocabulary-A2")).toHaveText("A2 — 2 из 3 верно");
    await expect(page.getByTestId("why-vocabulary-B1")).toHaveText("B1 — 0 из 2 верно");
    await expect(page.getByTestId("why-how-vocabulary")).toContainText("не по одному удачному ответу");
    await expect(page.getByTestId("why-vocabulary")).not.toContainText("a ticket");
    await expect(page.getByTestId("why-listening")).toHaveCount(0);
    await expect(page.getByTestId("dx-weak")).toContainText("Аудирование — не оценено");
    await expect(page.getByTestId("dx-start-lesson")).toContainText("В кафе: заказ напитков");
    await expect(page.getByTestId("retake")).toBeDisabled();
    await expect(page.getByTestId("retake-note")).toContainText("Пройти снова можно с");
    await expect(page.getByTestId("dx-history")).toContainText("текущий");
  });

  test("нет голоса en-* → listening-unavailable, ученику объяснили, аудирование not_assessed (no_speech_voice)", async ({ page }) => {
    const bff = await start(page, {}, {}, [{ lang: "ru-RU", name: "Fake Russian" }]);
    await page.getByTestId("home-diag-start").click();
    await page.getByTestId("dx-start").click();
    for (const type of ["single_choice", "gap_choice"]) {
      await expect(page.getByTestId(`dx-item-${type}`)).toBeVisible();
      await page.getByTestId("dx-dont-know").click();
    }
    await expect(page.getByTestId("dx-item-order_words")).toBeVisible();
    await page.getByTestId("dx-dont-know").click();
    await answerChoice(page, "read_choice", 0);
    // the listening item is not shown — reported once, the result follows
    await expect(page.getByTestId("dx-result")).toBeVisible();
    expect(bff.calls("POST", /\/listening-unavailable$/)).toHaveLength(1);
    expect(bff.content.listeningUnavailableCalls).toBe(1);
    await expect(page.getByTestId("reason-listening")).toHaveText("На устройстве не нашлось английского голоса — аудирование оценим позже.");
  });

  test("уточнение сомнительной области: +3 задания, новая ревизия «уточнено», кнопки уточнения больше нет", async ({ page }) => {
    const bff = await start(page, { diag: "completed", nextAllowedAt: null });
    await bff.content.results.splice(0, 1, bff.content.makeResult({ listening: true, revision: 1 })); // fresh: within 24 h
    await page.getByTestId("home-skills-link").click();
    await page.getByTestId("sk-result").click();
    await expect(page.getByTestId("dx-result")).toBeVisible();
    await expect(page.getByTestId("followup-vocabulary")).toHaveCount(0);
    await page.getByTestId("followup-grammar").click();
    await expect(page.getByTestId("dx-progress")).toHaveText("Уточнение · Грамматика · Задание 1 из ~3");
    await answerChoice(page, "gap_choice", 1);
    await answerChoice(page, "single_choice", 0);
    await answerChoice(page, "gap_choice", 1);
    await expect(page.getByTestId("dx-result")).toBeVisible();
    await expect(page.getByTestId("dx-result")).toContainText("уточнено");
    await expect(page.getByTestId("area-grammar").getByText("A2", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("followup-grammar")).toHaveCount(0);
    expect(bff.last("POST", /\/followup$/)?.body).toEqual({ area: "grammar" });
  });

  test("три результата без оценённой области: «Слишком много незаконченных проверок — следующая будет доступна …»", async ({ page }) => {
    await start(page, { diag: "unfinished_limit" });
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-diagnostics").click();
    await expect(page.getByTestId("dx-level")).toHaveText("Недостаточно данных для общего уровня");
    await expect(page.getByTestId("retake")).toBeDisabled();
    await expect(page.getByTestId("retake-note")).toHaveText(/^Слишком много незаконченных проверок — следующая будет доступна \d{1,2} [а-я]+$/);
    await expect(page.locator("[data-testid^=why-]")).toHaveCount(0);
  });

  test("«Пройти снова» до даты недоступно; после даты — подтверждение и новая проверка; незаконченную можно продолжить", async ({ page }) => {
    await start(page, { diag: "completed" });
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("row-diagnostics")).toContainText("уровень A1");
    await page.getByTestId("row-diagnostics").click();
    await expect(page.getByTestId("retake")).toBeDisabled();
    await expect(page.getByTestId("retake-note")).toHaveText(/^Пройти снова можно с \d{1,2} [а-я]+$/);

    const p2 = await page.context().newPage();
    const bff2 = await start(p2, { diag: "completed", nextAllowedAt: null });
    await p2.getByTestId("tab-profile").click();
    await p2.getByTestId("row-diagnostics").click();
    await p2.getByTestId("retake").click();
    await p2.getByRole("alertdialog").getByRole("button", { name: "Пройти снова" }).click();
    await expect(p2.getByTestId("dx-item-single_choice")).toBeVisible();
    expect(bff2.calls("POST", "/v1/diagnostics/sessions")).toHaveLength(1);

    const p3 = await page.context().newPage();
    await start(p3, { diag: "in_progress" });
    await expect(p3.getByTestId("home-diag-card")).toContainText("Проверка не закончена · 1 из ~5");
    await p3.getByTestId("home-diag-start").click();
    await expect(p3.getByTestId("dx-resume-note")).toContainText("отвечено 1 из ~5");
    await p3.getByTestId("dx-resume").click();
    await expect(p3.getByTestId("dx-progress")).toHaveText("Задание 2 из ~5");
    // pause: back to Home with the promise to continue
    await p3.getByTestId("dx-pause").click();
    await expect(p3.getByTestId("toast")).toHaveText("Продолжим с этого места — в течение 24 часов.");
  });
});

test.describe("план и карта навыков", () => {
  test("«Мой план»: следующий урок с причиной, обязательные и дополнительные; смена цели → пересчёт", async ({ page }) => {
    const bff = await start(page, { diag: "completed" });
    await expect(page.getByTestId("home-next-why")).toHaveText("Словарь у вас уверенный, а вежливые просьбы пока даются трудно — с них и начнём.");
    await page.getByTestId("home-plan-link").click();
    const next = page.getByTestId("plan-next");
    await expect(next).toContainText("В кафе: заказ напитков");
    await expect(next.getByTestId("reasons")).toHaveText(/старт по проверке.*слабая область/);
    await expect(next.getByRole("paragraph").filter({ hasText: "Этапы урока" })).toHaveCount(0);
    await expect(next.locator(".stages")).toHaveAttribute("aria-label", /повторение 3 мин, объяснение 4 мин, разговор 8 мин/);
    await expect(page.getByTestId("plan-mandatory")).toContainText("3 урока");
    await expect(page.getByTestId("plan-basis")).toContainText("Цель: Путешествия");
    await expect(page.getByTestId("plan-optional")).toContainText("В аэропорту: регистрация");
    await page.getByTestId("plan-change-goal").click();
    await page.getByTestId("goal-picker").getByRole("button", { name: "Работа" }).click();
    await page.getByTestId("goal-save").click();
    await expect(page.getByTestId("toast")).toBeVisible();
    await page.getByTestId("bar-back").click();
    await expect(page.getByTestId("plan-basis")).toContainText("Цель: Работа");
    await expect(page.getByTestId("plan-optional")).toContainText("Разговор о погоде");
    expect(bff.calls("GET", "/v1/plan/trajectory").length).toBeGreaterThanOrEqual(3);
    // sprint 4: «Начать урок» → the lesson card
    await page.getByTestId("plan-start").click();
    await expect(page.getByTestId("lesson-card")).toContainText("В кафе: заказ напитков");
  });

  test("карта навыков: состояния словами и значками, история; каталог недоступен — честное сообщение", async ({ page }) => {
    await start(page, { diag: "completed" });
    await page.getByTestId("tab-progress").click();
    await expect(page.getByTestId("sk-counts")).toContainText("3●подтверждён");
    await expect(page.getByTestId("sk-counts")).toContainText("0★закреплён");
    const row = page.getByTestId("skill-en.func.order");
    await expect(row).toContainText("◐изучается");
    await expect(row).toContainText("Основа: Приветствие и знакомство");
    await row.getByRole("button").first().click();
    await expect(row.getByTestId("skill-history")).toContainText("Проверка уровня");
    await expect(row.getByTestId("skill-history")).toContainText("ошибка");

    const p2 = await page.context().newPage();
    await start(p2, { diag: "completed", catalogDown: true });
    await p2.getByTestId("tab-progress").click();
    await expect(p2.getByTestId("sk-unavailable")).toContainText("Карта навыков временно недоступна");
    await expect(p2.getByTestId("offline")).toHaveCount(0);
  });
});

test.describe("практика", () => {
  test("сценарии: фильтры цели и уровня, карточка с первой репликой и переводом по тапу", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("home-practice").click();
    await expect(page.getByTestId("sc-list").locator("button")).toHaveCount(3);
    await page.getByTestId("flt-goal").getByRole("button", { name: "Работа" }).click();
    await expect(page.getByTestId("sc-list").locator("button")).toHaveCount(1);
    expect(bff.last("GET", "/v1/scenarios")?.query.get("goal")).toBe("work");
    await page.getByTestId("flt-goal").getByRole("button", { name: "Все" }).click();
    await page.getByTestId("flt-sc-level").getByRole("button", { name: /^A1/ }).click();
    await expect(page.getByTestId("sc-list").locator("button")).toHaveCount(2);
    await page.getByTestId("flt-sc-level").getByRole("button", { name: /^B2/ }).click();
    await expect(page.getByTestId("pr-empty")).toBeVisible();
    await page.getByTestId("flt-sc-level").getByRole("button", { name: "Все" }).click();
    await page.getByTestId("sc-sc-cafe-order").click();
    const opening = page.getByTestId("sc-opening");
    await expect(opening).toContainText("Hi! What can I get you?");
    await expect(page.getByTestId("sc-gloss")).toHaveCount(0);
    await page.getByTestId("sc-translate").click();
    await expect(page.getByTestId("sc-gloss")).toHaveText("Привет! Что вам принести?");
    await expect(page.getByTestId("scenario")).toContainText("Чем может закончиться");
    await expect(page.getByTestId("sc-play")).toBeEnabled();
    // back: the practice keeps its tab
    await page.getByTestId("bar-back").click();
    await expect(page.getByTestId("sc-list")).toBeVisible();
  });

  test("медиатека: фильтры типа и уровня; запись — из BFF, без записи — синтез речи с пометкой; транскрипт с переводом по тапу; лицензия без транскрипта", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("home-practice").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Медиатека" }).click();
    await expect(page.getByTestId("md-list").locator("button")).toHaveCount(4);
    await page.getByTestId("flt-type").getByRole("button", { name: "Песня" }).click();
    await expect(page.getByTestId("md-list").locator("button")).toHaveCount(1);
    expect(bff.last("GET", "/v1/media")?.query.get("type")).toBe("song");
    await page.getByTestId("flt-type").getByRole("button", { name: "Все" }).click();
    await page.getByTestId("flt-md-level").getByRole("button", { name: /^A1/ }).click();
    await expect(page.getByTestId("md-list").locator("button")).toHaveCount(1);
    await page.getByTestId("md-m-own-coffee").click();

    await page.getByTestId("md-play").click();
    await expect.poll(() => played(page)).toBe(1);
    expect(bff.calls("GET", "/v1/media/m-own-coffee/audio")).toHaveLength(1);
    expect(bff.last("GET", "/v1/media/m-own-coffee/audio")?.headers.authorization).toMatch(/^Bearer /);
    await expect(page.getByTestId("md-tts")).toHaveCount(0);
    await page.getByTestId("md-line-1").click();
    await expect(page.getByTestId("md-gloss-1")).toHaveText("Латте с собой, пожалуйста.");
    await page.getByTestId("bar-back").click();

    await page.getByTestId("flt-md-level").getByRole("button", { name: "Все" }).click();
    await page.getByTestId("md-m-own-train").click();
    await expect(page.getByTestId("md-tts")).toContainText("синтез речи");
    await page.getByTestId("md-play").click();
    await expect.poll(async () => (await spoken(page)).length).toBe(2);
    expect((await spoken(page)).map((s) => s.voice)).toEqual(["Fake English (UK)", "Fake English (US)"]);
    await page.getByTestId("bar-back").click();

    // лицензия без `listen`: ни файла, ни синтеза речи по транскрипту — кнопки прослушивания нет
    await page.getByTestId("md-m-own-quotes").click();
    await expect(page.getByTestId("md-no-listen")).toHaveText("Прослушивание недоступно по условиям лицензии.");
    await expect(page.getByTestId("md-play")).toHaveCount(0);
    await expect(page.getByTestId("md-transcript")).toContainText("Tell us about your first job.");
    const before = (await spoken(page)).length;
    await page.getByTestId("md-line-0").click();
    expect((await spoken(page)).length).toBe(before);
    await page.getByTestId("bar-back").click();

    await page.getByTestId("md-m-pd-poem").click();
    await expect(page.getByTestId("md-no-transcript")).toBeVisible();
    await expect(page.getByTestId("md-attribution")).toHaveText("Атрибуция: Traditional, public domain");
    await expect(page.getByTestId("media-item").locator("a")).toHaveCount(0);
  });

  test("ребёнку — только детские сценарии и медиа, без внешних ссылок", async ({ page }) => {
    await start(page, {}, { child: true });
    await page.getByTestId("home-practice").click();
    await expect(page.getByTestId("sc-list").locator("button")).toHaveCount(1);
    await expect(page.getByTestId("sc-list")).toContainText("В зоопарке");
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Медиатека" }).click();
    await expect(page.getByTestId("md-list").locator("button")).toHaveCount(1);
    await expect(page.getByTestId("md-list")).toContainText("Песенка про цвета");
    await expect(page.locator("a[href^='http']")).toHaveCount(0);
  });
});

test.describe("заявки на песни и фильмы", () => {
  test("заявка: честный текст, только https, Idempotency-Key, «Мои заявки» со статусами и ответом", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("home-practice").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Медиатека" }).click();
    await page.getByTestId("pr-want-song").click();
    await expect(page.getByTestId("mr-honest")).toContainText("мы не скачиваем и не загружаем материалы по ссылке");
    const list = page.getByTestId("mr-list");
    await expect(list).toContainText("подобран авторский аналог");
    await expect(list).toContainText("Ответ: Подобрали авторскую сценку «В саванне»");
    await page.getByTestId("mr-kind").getByRole("button", { name: "Фильм" }).click();
    await page.getByTestId("mr-title").fill("Up");
    await page.getByTestId("mr-link").fill("http://example.com/up");
    await expect(page.getByText("Ссылка должна начинаться с https://")).toBeVisible();
    await expect(page.getByTestId("mr-send")).toBeDisabled();
    await page.getByTestId("mr-link").fill("https://example.com/up");
    await page.getByTestId("mr-comment").fill("Хочу разобрать финальную сцену");
    await page.getByTestId("mr-send").click();
    await expect(page.getByTestId("toast")).toHaveText("Заявка отправлена");
    const req = bff.last("POST", "/v1/media/requests")!;
    expect(req.body).toEqual({ kind: "movie", title: "Up", link: "https://example.com/up", comment: "Хочу разобрать финальную сцену" });
    expect(req.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await expect(list.locator("li").first()).toContainText("Up");
    await expect(list.locator("li").first()).toContainText("новая");
    await expect(page.getByTestId("mr-title")).toHaveValue("");
  });

  test("детский профиль: заявки недоступны — «попросите родителя», вызовов нет; BFF отвечает 403 KIDS_NOT_ALLOWED", async ({ page }) => {
    const bff = await start(page, {}, { child: true });
    await page.getByTestId("home-practice").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Медиатека" }).click();
    await expect(page.getByTestId("pr-want-song")).toContainText("Заявки отправляет родитель");
    await page.getByTestId("pr-want-song").click();
    await expect(page.getByTestId("mr-kids")).toContainText("Попроси родителя");
    expect(bff.calls("GET", "/v1/media/requests")).toHaveLength(0);
    // the route itself refuses a child (defence in depth)
    const status = await page.evaluate(async () => (await fetch("/__bff/v1/media/requests", { headers: { authorization: "Bearer acc-1" } })).status);
    expect(status).toBe(403);
  });

  test("> 5 заявок в сутки → понятный текст", async ({ page }) => {
    await start(page, { requests: 5 });
    await page.goto("/");
    await page.getByTestId("home-practice").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Медиатека" }).click();
    await page.getByTestId("pr-want-song").click();
    await page.getByTestId("mr-title").fill("Song 6");
    await page.getByTestId("mr-send").click();
    await expect(page.getByTestId("mr-form").getByRole("alert")).toHaveText("Не больше 5 заявок в сутки — отправьте завтра.");
  });
});

test.describe("языки, ссылки, языки интерфейса", () => {
  test("«Мои языки»: RU→EN активна, остальные «скоро» и не запускаются", async ({ page }) => {
    await start(page);
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-languages").click();
    await expect(page.getByTestId("pair-ru-en")).toContainText("активен");
    for (const p of ["ru-uz", "ru-kk", "en-uz"]) await expect(page.getByTestId(`pair-${p}`)).toContainText("скоро");
    await page.getByTestId("pair-ru-uz").click();
    await expect(page.getByTestId("toast")).toHaveText("Этот курс появится позже — расскажем в «Что нового».");
  });

  for (const [param, testId] of [
    ["route_diagnostics", "dx-intro"],
    ["route_plan", "plan-screen"],
    ["route_skills", "skill-map"],
    ["route_scenarios", "sc-list"],
    ["route_media", "md-list"],
    ["route_media_requests", "mr-form"],
    ["route_languages", "my-languages"],
  ] as const) {
    test(`deep link ${param}`, async ({ page }) => {
      await start(page, {}, { startParam: param });
      await expect(page.getByTestId(testId)).toBeVisible();
    });
  }

  test("UZ: диагностика, результат и практика — только латиница", async ({ page }) => {
    await start(page, { diag: "completed" }, { locale: "uz" });
    await expect(page.getByTestId("home-next-lesson")).toContainText("Keyingi dars");
    await page.getByTestId("home-skills-link").click();
    await expect(page.getByTestId("skill-map")).toContainText("Koʻnikmalar xaritasi");
    await page.getByTestId("sk-result").click();
    await expect(page.getByTestId("not-cefr")).toHaveText("Bu CEFR sertifikati emas — TilHero ichidagi taxminiy baho. U darslar boʻyicha aniqlashtiriladi.");
    await expect(page.getByTestId("reason-speaking")).toHaveText("Gapirish — ovozli darslar paydo boʻlgandan keyin.");
    const text = await page.locator(".app").innerText();
    expect(CYRILLIC.test(text), text.match(/.{0,20}[Ѐ-ӿ].{0,20}/)?.[0]).toBe(false);
    await page.getByTestId("bar-back").click();
    await page.getByTestId("tab-home").click();
    await page.getByTestId("home-practice").click();
    await expect(page.getByTestId("sc-list")).toContainText("Mehmonxonaga joylashish");
    const t2 = await page.locator(".app").innerText();
    expect(CYRILLIC.test(t2), t2.match(/.{0,20}[Ѐ-ӿ].{0,20}/)?.[0]).toBe(false);
  });
});

test.describe("тёмная тема и ширины 375–412", () => {
  for (const width of [375, 412]) {
    test(`без горизонтальной прокрутки @ ${width}px (диагностика, результат, план, практика)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: width === 412 ? "dark" : "light" });
      await start(page, { diag: "completed", nextAllowedAt: null });
      if (width === 412) await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
      const noOverflow = async () => {
        await settle(page);
        const over = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".scroll, .app")].map((e) => e.scrollWidth - e.clientWidth));
        for (const o of over) expect(o).toBeLessThanOrEqual(1);
      };
      await page.getByTestId("tab-profile").click();
      await page.getByTestId("row-diagnostics").click();
      await expect(page.getByTestId("dx-result")).toBeVisible();
      await noOverflow();
      await page.getByTestId("dx-open-plan").click();
      await expect(page.getByTestId("plan-next")).toBeVisible();
      await noOverflow();
      await page.getByTestId("bar-back").click();
      await page.getByTestId("retake").click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Пройти снова" }).click();
      await page.getByTestId("dx-opt-0").click();
      await page.getByTestId("dx-answer").click();
      await page.getByTestId("dx-dont-know").click();
      await expect(page.getByTestId("dx-item-order_words")).toBeVisible();
      await noOverflow();
    });
  }
});

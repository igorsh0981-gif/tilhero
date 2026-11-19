import { expect, test, type Page } from "@playwright/test";
import * as F from "./fixtures/data";
import type { LessonsScenario } from "./fixtures/lessons";
import type { Scenario } from "./fixtures/mock-bff";
import { installSpeech } from "./fixtures/speech";
import { open, settle } from "./helpers";

/** Screenshots of the key sprint 4 screens in both notebooks (light / dark) → /tmp/miniapp-s4-shots (SPRINT4_SHOTS). */
const DIR = process.env.SPRINT4_SHOTS ?? "/tmp/miniapp-s4-shots";
const ALL_SEEN = [F.WELCOME.id, F.UPDATE_1.id, F.UPDATE_2.id];

async function snap(page: Page, name: string, scheme: string, scrollTo?: string) {
  if (scrollTo) await page.getByTestId(scrollTo).first().scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${DIR}/${name}_${scheme}.png` });
}

async function boot(page: Page, scheme: string, lessons: LessonsScenario = {}, sc: Scenario = {}) {
  await page.emulateMedia({ colorScheme: scheme as "light" | "dark" });
  await installSpeech(page);
  return open(page, { onboarded: true, seen: ALL_SEEN, content: { diag: "completed" }, lessons, ...sc });
}

async function choose(page: Page, type: string, opt: number) {
  await expect(page.getByTestId(`pl-item-${type}`)).toBeVisible();
  await page.getByTestId(`pl-opt-${opt}`).click();
  await page.getByTestId("pl-answer").click();
}

for (const scheme of ["light", "dark"] as const) {
  test(`ключевые экраны спринта 4 — ${scheme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page, scheme, { decided: "upheld" });
    await page.getByTestId("tab-lessons").click();
    await expect(page.getByTestId("ls-next")).toBeVisible();
    await snap(page, "01_lessons_tab", scheme);
    await snap(page, "02_lessons_tab_done_history", scheme, "ls-history");
    await page.getByTestId("ls-next-open").click();
    await expect(page.getByTestId("lc-facts")).toBeVisible();
    await snap(page, "03_lesson_card", scheme);
    await snap(page, "04_lesson_card_stages", scheme, "lc-stage-summary");
    await page.getByTestId("lc-start").click();
    await choose(page, "single_choice", 1);
    await expect(page.getByTestId("pl-feedback")).toBeVisible();
    await snap(page, "05_retrieval_feedback", scheme);
    await page.getByTestId("pl-next").click();
    for (const w of [1, 3]) await page.getByTestId(`ow-word-${w}`).click();
    await snap(page, "06_retrieval_order_words", scheme);
    for (const w of [4, 0, 2]) await page.getByTestId(`ow-word-${w}`).click();
    await page.getByTestId("pl-answer").click();
    await page.getByTestId("pl-next").click();
    await page.getByTestId("pl-ex-1").click();
    await page.getByRole("button", { name: "the bill" }).click();
    await snap(page, "07_explanation", scheme);
    await page.getByTestId("pl-simpler").click();
    await expect(page.getByTestId("pl-simpler-card")).toBeVisible();
    await snap(page, "08_explanation_simpler", scheme, "pl-simpler-card");
    await page.getByTestId("pl-next").click();
    await choose(page, "meaning_check", 0);
    await page.getByTestId("pl-next").click();
    await expect(page.getByTestId("pl-roleplay")).toBeVisible();
    await page.getByTestId("rp-input").fill("blue sky");
    await page.getByTestId("rp-send").click();
    await expect(page.getByTestId("rp-clarify")).toBeVisible();
    await page.getByTestId("rp-translate").first().click();
    await snap(page, "09_roleplay_chat_clarify", scheme);
    await page.getByTestId("rp-input").fill("I want a latte");
    await page.getByTestId("rp-send").click();
    await expect(page.getByTestId("rp-ch").last()).toContainText("Sure!");
    await page.getByTestId("rp-hint-btn").click();
    await expect(page.getByTestId("rp-hint")).toBeVisible();
    await snap(page, "10_roleplay_chat_hint", scheme, "rp-hint");
    await page.getByTestId("rp-choice-c4").click();
    await expect(page.getByTestId("pl-outcome")).toBeVisible();
    await snap(page, "11_roleplay_end_alt", scheme);
    await page.getByTestId("pl-next").click();
    await page.getByTestId("pl-gap-input").fill("likes");
    await snap(page, "12_check_without_hints", scheme);
    await page.getByTestId("pl-answer").click();
    await choose(page, "translate_choice", 2);
    await page.getByTestId("pl-open-input").fill("I want a coffee to go and the bill, please.");
    await snap(page, "13_open_answer", scheme);
    await page.getByTestId("pl-open-send").click();
    await expect(page.getByTestId("pl-done")).toBeVisible();
    await snap(page, "14_done", scheme);
    await page.getByTestId("pl-finish").click();
    await expect(page.getByTestId("summary")).toBeVisible();
    await snap(page, "15_summary_top", scheme);
    await snap(page, "16_summary_errors", scheme, "sm-errors");
    await snap(page, "17_summary_items", scheme, "sm-items");
    await snap(page, "18_summary_skills_next", scheme, "sm-next");
    await page.getByTestId("sm-appeal").scrollIntoViewIfNeeded();
    await snap(page, "19_summary_actions", scheme);
    await page.getByTestId("sm-appeal").click();
    await page.getByTestId("ap-reason").fill("«I’d like» в открытом ответе было бы правильно — я ошибся только в задании с пропуском.");
    await snap(page, "20_appeal_form", scheme);
    await page.getByTestId("ap-send").click();
    await expect(page.getByTestId("sm-appeal-state")).toBeVisible();
    await snap(page, "21_summary_appeal_sent", scheme);
    // pause
    await page.getByTestId("sm-done").click();
    await page.getByTestId("bar-back").click();
    await page.getByTestId("tab-home").click();
    await page.getByTestId("home-practice").click();
    await page.getByTestId("sc-sc-cafe-order").click();
    await snap(page, "22_scenario_play", scheme);
    await page.getByTestId("sc-play").click();
    await page.getByTestId("rp-choice-c2").click();
    await expect(page.getByTestId("pl-outcome")).toBeVisible();
    await snap(page, "23_roleplay_fail_retry", scheme);
    await page.getByTestId("pl-menu").click();
    await snap(page, "24_pause_menu", scheme);
    await page.getByTestId("pl-pause").click();
    await expect(page.getByTestId("pl-paused")).toBeVisible();
    await snap(page, "25_paused", scheme);
  });

  test(`решение по апелляции, ребёнок, упрощённый режим, медиа — ${scheme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await boot(page, scheme, { decided: "corrected" });
    await page.getByTestId("tab-lessons").click();
    await page.getByTestId("ls-history").getByRole("button").first().click();
    await expect(page.getByTestId("sm-corrected")).toBeVisible();
    await snap(page, "26_summary_corrected", scheme);
    await page.getByTestId("bar-back").click();
    await page.getByTestId("tab-home").click();
    await page.getByTestId("home-practice").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Медиатека" }).click();
    await page.getByTestId("md-m-own-coffee").click();
    await snap(page, "27_media_exercises_button", scheme);
    await page.getByTestId("md-exercises-start").click();
    await page.getByTestId("pl-line-0").click();
    await snap(page, "28_media_listen", scheme);
    await page.getByTestId("pl-next").click();
    await choose(page, "comprehension", 1);
    await expect(page.getByTestId("pl-item-order_lines")).toBeVisible();
    await page.getByTestId("ow-word-1").click();
    await snap(page, "29_media_order_lines", scheme);

    const kid = await page.context().newPage();
    await boot(kid, scheme, {}, { child: true });
    await kid.getByTestId("start-lesson").click();
    await kid.getByTestId("lc-start").click();
    await kid.getByTestId("pl-next").click();
    await kid.getByTestId("pl-next").click();
    await expect(kid.getByTestId("pl-roleplay")).toBeVisible();
    await kid.getByTestId("rp-choice-c2").click();
    await expect(kid.getByTestId("rp-ch").last()).toContainText("look again");
    await snap(kid, "30_kid_chat", scheme);

    const lite = await page.context().newPage();
    await boot(lite, scheme, { aiDegraded: true });
    await lite.getByTestId("home-practice").click();
    await lite.getByTestId("sc-sc-cafe-order").click();
    await lite.getByTestId("sc-play").click();
    await expect(lite.getByTestId("pl-degraded")).toBeVisible();
    await snap(lite, "31_degraded_roleplay", scheme);
  });
}

test("UZ — разговор и итоги (light)", async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page, "light", {}, { locale: "uz" });
  await page.getByTestId("home-practice").click();
  await page.getByTestId("sc-sc-cafe-order").click();
  await page.getByTestId("sc-play").click();
  await page.getByTestId("rp-choice-c1").click();
  await expect(page.getByTestId("rp-ch").last()).toContainText("Sure!");
  await snap(page, "32_uz_roleplay", "light");
  await page.getByTestId("rp-choice-c3").click();
  await page.getByTestId("pl-next").click();
  await page.getByTestId("pl-finish").click();
  await expect(page.getByTestId("summary")).toBeVisible();
  await snap(page, "33_uz_summary", "light");
});

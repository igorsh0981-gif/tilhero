import { test, type Page } from "@playwright/test";
import * as F from "./fixtures/data";
import { installSpeech } from "./fixtures/speech";
import { open, settle } from "./helpers";

/** Screenshots of the key sprint 3 screens in both notebooks (light / dark) → /tmp/miniapp-s3-shots (SPRINT3_SHOTS). */
const DIR = process.env.SPRINT3_SHOTS ?? "/tmp/miniapp-s3-shots";
const ALL_SEEN = [F.WELCOME.id, F.UPDATE_1.id, F.UPDATE_2.id];

async function snap(page: Page, name: string, scheme: string, scrollTo?: string) {
  if (scrollTo) await page.getByTestId(scrollTo).scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${DIR}/${name}_${scheme}.png` });
}

for (const scheme of ["light", "dark"] as const) {
  test(`ключевые экраны спринта 3 — ${scheme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: scheme });
    await installSpeech(page);
    await open(page, { onboarded: true, seen: ALL_SEEN, content: {} });
    await snap(page, "01_home_diag_card", scheme, "home-diag-card");
    await page.getByTestId("home-diag-start").click();
    await snap(page, "02_dx_intro", scheme);
    await page.getByTestId("dx-start").click();
    await page.getByTestId("dx-opt-0").click();
    await snap(page, "03_dx_choice", scheme);
    await page.getByTestId("dx-answer").click();
    await page.getByTestId("dx-item-gap_choice").waitFor();
    await snap(page, "04_dx_gap", scheme);
    await page.getByTestId("dx-dont-know").click();
    await page.getByTestId("ow-word-2").click();
    await page.getByTestId("ow-word-1").click();
    await snap(page, "05_dx_order_words", scheme);
    await page.getByTestId("ow-word-0").click();
    await page.getByTestId("ow-word-3").click();
    await page.getByTestId("dx-answer").click();
    await page.getByTestId("dx-passage").waitFor();
    await snap(page, "06_dx_read", scheme);
    await page.getByTestId("dx-opt-0").click();
    await page.getByTestId("dx-answer").click();
    await page.getByTestId("dx-listen-play").click();
    await snap(page, "07_dx_listen", scheme);
    await page.getByTestId("dx-opt-1").click();
    await page.getByTestId("dx-answer").click();
    await page.getByTestId("dx-result").waitFor();
    await snap(page, "08_result_level_cefr", scheme);
    await page.getByTestId("why-vocabulary").locator("summary").click();
    await page.getByTestId("why-grammar").locator("summary").click();
    await snap(page, "09_result_followup_why", scheme, "area-grammar");
    await snap(page, "09b_result_why_bands", scheme, "why-vocabulary");
    await snap(page, "10_result_not_assessed", scheme, "area-writing");
    await snap(page, "11_result_start_retake", scheme, "retake");
    await page.getByTestId("dx-open-plan").click();
    await page.getByTestId("plan-next").waitFor();
    await snap(page, "12_plan_next", scheme);
    await snap(page, "13_plan_lessons", scheme, "plan-optional");
    await page.getByTestId("bar-back").click();
    await page.getByTestId("bar-back").click();
    await snap(page, "14_home_next_lesson", scheme, "home-next-lesson");
    await page.getByTestId("tab-progress").click();
    await page.getByTestId("sk-counts").waitFor();
    await snap(page, "15_skill_map", scheme);
    await page.getByTestId("skill-en.gram.questions").getByRole("button").first().click();
    await snap(page, "16_skill_history", scheme, "skill-en.gram.questions");
    await page.getByTestId("tab-home").click();
    await page.getByTestId("home-practice").click();
    await page.getByTestId("sc-list").waitFor();
    await snap(page, "17_practice_scenarios", scheme);
    await page.getByTestId("sc-sc-travel-hotel").click();
    await page.getByTestId("sc-translate").click();
    await snap(page, "18_scenario", scheme);
    await page.getByTestId("bar-back").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Медиатека" }).click();
    await page.getByTestId("md-list").waitFor();
    await snap(page, "19_practice_media", scheme);
    await page.getByTestId("md-m-own-train").click();
    await page.getByTestId("md-line-0").click();
    await snap(page, "20_media_tts_transcript", scheme);
    await page.getByTestId("bar-back").click();
    await page.getByTestId("pr-want-song").click();
    await page.getByTestId("mr-title").fill("Yesterday — The Beatles");
    await snap(page, "21_media_request_form", scheme);
    await snap(page, "22_media_requests_mine", scheme, "mr-list");
    await page.getByTestId("bar-back").click();
    await page.getByTestId("bar-back").click();
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-languages").click();
    await page.getByTestId("pair-ru-uz").waitFor();
    await snap(page, "23_my_languages", scheme);

    const kid = await page.context().newPage();
    await kid.emulateMedia({ colorScheme: scheme });
    await installSpeech(kid);
    await open(kid, { onboarded: true, seen: ALL_SEEN, child: true });
    await snap(kid, "24_kid_home", scheme, "home-diag-card");
    await kid.getByTestId("home-diag-start").click();
    await snap(kid, "25_kid_dx_intro", scheme);
    await kid.getByTestId("dx-start").click();
    await kid.getByTestId("dx-opt-0").click();
    await snap(kid, "26_kid_dx_choice", scheme);
    await kid.getByTestId("bar-back").click();
    await kid.getByTestId("home-practice").click();
    await kid.getByTestId("pr-tabs").getByRole("button", { name: "Медиатека" }).click();
    await kid.getByTestId("pr-want-song").click();
    await snap(kid, "27_kid_requests_parent", scheme);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`результат: незаконченные проверки и медиа без прослушивания — ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await installSpeech(page);
    await open(page, { onboarded: true, seen: ALL_SEEN, content: { diag: "unfinished_limit" } });
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-diagnostics").click();
    await page.getByTestId("retake").waitFor();
    await snap(page, "30_result_too_many_unfinished", scheme, "retake");
    await page.getByTestId("bar-back").click();
    await page.getByTestId("tab-home").click();
    await page.getByTestId("home-practice").click();
    await page.getByTestId("pr-tabs").getByRole("button", { name: "Медиатека" }).click();
    await page.getByTestId("md-m-own-quotes").click();
    await page.getByTestId("md-no-listen").waitFor();
    await snap(page, "31_media_no_listen", scheme);
  });
}

test("UZ — результат проверки (light)", async ({ page }) => {
  await installSpeech(page);
  await open(page, { onboarded: true, seen: ALL_SEEN, locale: "uz", content: { diag: "completed" } });
  await page.getByTestId("tab-profile").click();
  await page.getByTestId("row-diagnostics").click();
  await page.getByTestId("why-vocabulary").locator("summary").click();
  await snap(page, "28_uz_result", "light", "why-vocabulary");
  await page.getByTestId("bar-back").click();
  await page.getByTestId("tab-home").click();
  await page.getByTestId("home-practice").click();
  await snap(page, "29_uz_practice", "light");
});

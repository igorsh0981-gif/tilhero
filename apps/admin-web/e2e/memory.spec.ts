/**
 * Sprint 5 «Память и повторения», overview and speech on the mock admin-bff (AT-61, ADM-MEM-01/02): the learner card
 * → «Память» (summary, retention checks, cards, the scheduling history with staff names) → a reschedule with a reason
 * and step-up (audit `memory.card_adjusted`); no memory.manage → no buttons; a learner by UUID without users.read; the
 * forgetting analytics with hidden small groups («мало данных», never zeros); the overview block `memory` and the AI
 * translation queue (a failed block does not break the overview); the audio hour price of the speech model (step-up),
 * the speech provider without the key and the pronunciation block of the costs; the menu by permission.
 */
import { expect, test, type Page } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { LEARNER, TOTP } from "./fixtures/data";
import { CID } from "./fixtures/memory-data";

test.describe.configure({ timeout: 90_000 });

const menu = (page: Page) => page.locator("[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav")));
/** a local day of the browser (playwright.config: Asia/Tashkent, UTC+5, no DST) N days ahead */
const TZ_MS = 5 * 3_600_000;
const ymd = (days: number) => new Date(Date.now() + days * 86_400_000 + TZ_MS).toISOString().slice(0, 10);
/** noon of that local day — what the admin sends as the new due moment (admin.ts) */
const noonOf = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) - TZ_MS).toISOString();

test("AT-61 learner card → «Память»: summary, checks, cards, the history with names → reschedule (reason ≥ 10, step-up) → audit", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/users/${LEARNER.madina}`);
  await page.getByTestId("lc-tab-memory").click();
  const tab = page.getByTestId("lc-memory");
  await expect(tab.getByTestId("mem-total")).toHaveText("6");
  await expect(tab.getByTestId("mem-due")).toHaveText("3");
  await expect(tab.getByTestId("mem-overdue")).toHaveText("1");
  await page.getByTestId("lc-memory-open").click();
  await expect(page.getByTestId("page-memory")).toBeVisible();
  await expect(page.getByTestId("mem-learner")).toHaveAttribute("data-user", LEARNER.madina);
  // retention checks: stage, status in words, result
  const checks = page.getByTestId("mem-checks");
  await expect(checks).toContainText("30 дней");
  await expect(checks).toContainText("не пройдена");
  await expect(checks).toContainText("1 из 3");
  await expect(checks).toContainText("провалов подряд: 1");
  // cards with S, D, R; the overdue is said in words; filters go to the server
  await expect(page.locator('[data-testid^="mem-card-c1"]')).toHaveCount(6);
  await expect(page.getByTestId(`mem-card-${CID.c4}`)).toContainText("просрочено");
  await expect(page.getByTestId(`mem-card-${CID.c4}`)).toContainText("word_order");
  // an error card: the label of its code instead of a text — the correction came from the learner's own answer
  await expect(page.getByTestId(`mem-open-${CID.c4}`)).toHaveText("Порядок слов");
  await page.getByTestId("mem-f-status").selectOption("frozen");
  await expect(page.locator('[data-testid^="mem-card-c1"]')).toHaveCount(1);
  await page.getByTestId("mem-f-status").selectOption("");
  // the error card: the code and its label, never the learner's text or its correction
  await expect(page.getByTestId("mem-learner")).toContainText("Тексты и исправления ученика не показываются");
  await page.getByTestId(`mem-open-${CID.c4}`).click();
  await expect(page.getByTestId("mem-card-meta")).toContainText("Текст ученика и исправление в админке не показываются");
  await expect(page.getByTestId("mem-card")).toContainText("Порядок слов");
  await expect(page.getByTestId("mem-card")).toContainText("word_order");
  await page.getByTestId("drawer-close").click();
  // the card with the scheduling history: before → after, algorithm and version, who (a staff member by name)
  await page.getByTestId(`mem-open-${CID.c1}`).click();
  const log = page.getByTestId("mem-log");
  await expect(log.locator("tbody tr")).toHaveCount(3);
  await expect(log.locator('tr[data-actor="staff"]')).toContainText("Тимур");
  await expect(log.locator('tr[data-actor="staff"]')).toContainText("Причина: Ученик сообщил о сбое");
  await expect(log).toContainText("fsrs5-default-1");
  await page.getByTestId("mem-log-more").click();
  await expect(log.locator("tbody tr")).toHaveCount(5);
  await expect(page.getByTestId("mem-log-more")).toHaveCount(0);
  // reschedule: date 1..365 days, reason ≥ 10, step-up
  await page.getByTestId("mem-act-reschedule").click();
  const dlg = page.getByTestId("mem-act-dialog");
  await expect(dlg.getByTestId("confirm-ok")).toBeDisabled();
  await dlg.getByTestId("mem-due").fill(ymd(3));
  await expect(dlg).toContainText("Через 3 дн.");
  await dlg.locator("#cmd-reason").fill("коротко");
  await dlg.getByTestId("confirm-ok").click();
  await expect(dlg).toContainText("не короче 10");
  await dlg.locator("#cmd-reason").fill("Ученица уезжает, перенос по её просьбе в поддержке");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("toasts")).toContainText("Срок перенесён");
  await expect(log.locator("tbody tr").first()).toHaveAttribute("data-actor", "staff");
  await expect(log.locator("tbody tr").first()).toContainText("Тимур");
  await expect(log.locator("tbody tr").first()).toContainText("ручная правка");
  const post = bff.calls("POST", `/memory/cards/${CID.c1}/actions`).at(-1)!;
  // the chosen day as local noon (memory allows ±1 day at the borders 1..365)
  expect(post.body).toEqual({ action: "reschedule", reason: "Ученица уезжает, перенос по её просьбе в поддержке", due_at: noonOf(ymd(3)) });
  expect(post.headers["idempotency-key"]).toBeTruthy();
  expect(bff.memory.audit.at(-1)).toMatchObject({ action: "memory.card_adjusted", id: CID.c1 });
  // a frozen card offers only reset and unfreeze
  await page.getByTestId("drawer-close").click();
  await page.getByTestId(`mem-open-${CID.c5}`).click();
  await expect(page.getByTestId("mem-act-unfreeze")).toBeVisible();
  await expect(page.getByTestId("mem-act-freeze")).toHaveCount(0);
  await expect(page.getByTestId("mem-act-reschedule")).toHaveCount(0);
  // the window of step-up is still open: unfreeze without a second code
  await page.getByTestId("mem-act-unfreeze").click();
  await page.locator("#cmd-reason").fill("Ученица вернулась к занятиям");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("toasts")).toContainText("Карточка разморожена");
  await expect(page.getByTestId("mem-card-body")).toHaveAttribute("data-status", "review");
});

test("memory without memory.manage: no action buttons; a learner by UUID without users.read; a learner without cards", async ({ page }) => {
  const bff = await openAs(page, "qa@tilhero.local", "#/memory/learners");
  await expect(page.getByTestId("mem-lookup")).toBeVisible();
  await page.getByTestId("mem-uid").fill("not-a-uuid");
  await page.getByTestId("mem-uid-go").click();
  await expect(page.getByTestId("mem-lookup")).toContainText("Введите UUID ученика");
  await page.getByTestId("mem-uid").fill(LEARNER.madina);
  await page.getByTestId("mem-uid-go").click();
  await expect(page.getByTestId("mem-summary")).toBeVisible();
  await expect(page.getByTestId("mem-to-card")).toHaveCount(0); // no users.read — no link to the learner card
  await page.getByTestId(`mem-open-${CID.c2}`).click();
  await expect(page.getByTestId("mem-ro")).toContainText("memory.manage");
  await expect(page.getByTestId("mem-actions")).toHaveCount(0);
  await expect(page.locator('[data-testid^="mem-act-"]')).toHaveCount(0);
  await page.getByTestId("drawer-close").click();
  await page.evaluate((id) => (window.location.hash = `#/memory/learners/${id}`), LEARNER.jasur);
  await expect(page.getByTestId("mem-none")).toContainText("Карточек пока нет");
  expect(bff.calls("POST", /\/memory\//)).toHaveLength(0);
});

test("forgetting analytics (dashboard.read): totals d7 / d30, hidden groups «мало данных», never zeros; 90 days", async ({ page }) => {
  const bff = await openAs(page, "comms@tilhero.local", "#/memory");
  expect(await menu(page)).toContain("memory");
  await expect(page.getByTestId("mem-tab-analytics")).toBeVisible();
  await expect(page.getByTestId("mem-tab-learners")).toHaveCount(0); // a learner's memory needs memory.read
  await expect(page.getByTestId("fa-d7-pct")).toHaveText("80 %");
  await expect(page.getByTestId("fa-d7")).toContainText("пройдено 36, не пройдено 9, назначено 48");
  await expect(page.getByTestId("fa-d30")).toHaveAttribute("data-hidden", "true");
  await expect(page.getByTestId("fa-d30")).toContainText("мало данных (< 5 учеников)");
  await expect(page.getByTestId("fa-d30-pct")).toHaveCount(0);
  await expect(page.getByTestId("fa-skill-en.func.order-d7")).toHaveAttribute("data-hidden", "true");
  await expect(page.getByTestId("fa-skill-en.gram.numbers-d7")).toContainText("52 %");
  await expect(page.getByTestId("fa-lesson-l-03-cafe")).toContainText("мало данных");
  await expect(page.getByTestId("fa-lesson-l-03-cafe")).not.toContainText("%");
  await expect(page.getByTestId("fa-lesson-l-02-numbers")).toContainText("41,5 %");
  await expect(page.getByTestId("fa-err-article")).toContainText("мало данных");
  await expect(page.getByTestId("fa-err-article")).not.toContainText(/\b0\b/);
  await expect(page.getByTestId("fa-err-word_order")).toContainText("12");
  await expect(page.getByTestId("fa-word-0")).toContainText("queue");
  await expect(page.getByTestId("fa-word-0").getByRole("meter")).toHaveAttribute("aria-label", /queue: again 46,9/);
  await page.getByTestId("fa-period").getByRole("button", { name: "90 дней" }).click();
  await expect(page.getByTestId("fa-d30-pct")).toHaveText("78,9 %");
  expect(bff.calls("GET", "/memory/analytics").length).toBeGreaterThanOrEqual(2);
  // a learner's memory by link without memory.read → back to the analytics tab
  await page.evaluate((id) => (window.location.hash = `#/memory/learners/${id}`), LEARNER.madina);
  await expect(page.getByTestId("mem-analytics")).toBeVisible();
  await expect(page.getByTestId("mem-learner")).toHaveCount(0);
});

test("manual action: the answer is lost (502) → the retry carries the same Idempotency-Key → one history row, one audit record; the next command gets a new key", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/memory/learners/${LEARNER.madina}/${CID.c2}`, { memory: { actionLostOnce: true } });
  await expect(page.getByTestId("mem-card-body")).toHaveAttribute("data-status", "learning");
  const reason = "Ученица в отпуске до конца месяца";
  await page.getByTestId("mem-act-freeze").click();
  const dlg = page.getByTestId("mem-act-dialog");
  await dlg.locator("#cmd-reason").fill(reason);
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
  // memory applied the action, the answer did not come back: the dialog stays with the error, the command is repeated
  await expect(dlg).toContainText("Сервис временно недоступен");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("toasts")).toContainText("Карточка заморожена");
  await expect(page.getByTestId("mem-card-body")).toHaveAttribute("data-status", "frozen");
  const keys = bff.memory.actionKeys;
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(bff.memory.audit.filter((a) => a.id === CID.c2)).toHaveLength(1);
  expect(bff.memory.card(CID.c2)!.log.filter((r) => r.reason === reason)).toHaveLength(1);
  await expect(page.getByTestId("mem-log").locator('tr[data-actor="staff"]')).toHaveCount(1);
  // a new command after a success — a new key
  await page.getByTestId("mem-act-unfreeze").click();
  await page.locator("#cmd-reason").fill("Ученица вернулась к занятиям");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("toasts")).toContainText("Карточка разморожена");
  expect(keys).toHaveLength(3);
  expect(keys[2]).not.toBe(keys[0]);
});

test("analytics: a late answer of the period the staff member already left is dropped (30 → 90 days)", async ({ page }) => {
  const bff = await openAs(page, "comms@tilhero.local", "#/memory", { memory: { analyticsDelay: { "30d": 1500 } } });
  // the 30-day answer is still on its way — switch to 90 days, which answers at once
  await page.getByTestId("fa-period").getByRole("button", { name: "90 дней" }).click();
  await expect(page.getByTestId("fa-body")).toHaveAttribute("data-period", "90d");
  await expect(page.getByTestId("fa-d30-pct")).toHaveText("78,9 %");
  // the late 30-day answer arrives and must not replace the chosen period
  expect(bff.calls("GET", "/memory/analytics").length).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(1_800); // past the delay of the 30-day answer
  await expect(page.getByTestId("mem-analytics")).toHaveAttribute("data-period", "90d");
  await expect(page.getByTestId("fa-body")).toHaveAttribute("data-period", "90d");
  await expect(page.getByTestId("fa-d30-pct")).toHaveText("78,9 %");
  // back to 30 days: the 90-day figures stay dimmed (busy) until the 30-day answer comes — never shown as 30 days
  await page.getByTestId("fa-period").getByRole("button", { name: "30 дней" }).click();
  await expect(page.getByTestId("fa-body")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("fa-body")).toHaveAttribute("data-period", "30d");
  await expect(page.getByTestId("fa-body")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("fa-d30")).toHaveAttribute("data-hidden", "true");
});

test("overview: the block «Память и повторения» and the AI queue link; a failed memory block does not break the overview", async ({ page }) => {
  await openAs(page, "methodist@tilhero.local", "#/overview");
  const blk = page.getByTestId("block-memory");
  await expect(blk).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("dmem-d30")).toContainText("78,9");
  await expect(page.getByTestId("att-glosses")).toContainText("3");
  await page.getByTestId("dmem-glosses-link").click();
  await expect(page.getByTestId("gl-queue")).toBeVisible();
  await page.evaluate(() => (window.location.hash = "#/overview"));
  await page.getByTestId("dmem-open").click();
  await expect(page.getByTestId("mem-analytics")).toBeVisible();
});

test("overview: memory down → only its block says so; catalog without an answer → «нет данных», not zero", async ({ page }) => {
  await openAs(page, "methodist@tilhero.local", "#/overview", { memory: { statsDown: true } });
  await expect(page.getByTestId("block-memory")).toHaveAttribute("data-available", "false");
  await expect(page.getByTestId("block-memory-off")).toContainText("memory");
  await expect(page.getByTestId("block-learners")).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("block-lessons")).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("att-glosses")).toHaveCount(0);
});

test("overview: the AI queue unknown (catalog down) is «нет данных»", async ({ page }) => {
  await openAs(page, "methodist@tilhero.local", "#/overview", { memory: { glossesUnknown: true } });
  await expect(page.getByTestId("dmem-glosses")).toContainText("нет данных");
  await expect(page.getByTestId("dmem-glosses-link")).toHaveCount(0);
  await expect(page.getByTestId("dai-speech")).toContainText("мин аудио");
});

test("speech: audio hour price of the speech model (step-up), provider status without the key, pronunciation in costs", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/agents/models");
  await expect(page.getByTestId("mdl-audio-azure-speech-pa")).toHaveText("$1,32");
  await expect(page.getByTestId("mdl-in-azure-speech-pa")).toHaveText("—");
  await expect(page.getByTestId("mdl-audio-claude-haiku-5-5")).toHaveText("—");
  const sp = page.getByTestId("prov-speech");
  await expect(page.getByTestId("prov-speech-set")).toContainText("ключ задан");
  await expect(page.getByTestId("prov-speech-region")).toContainText("westeurope");
  await expect(sp).toContainText("не показывается и не вводится");
  await expect(sp.locator("input")).toHaveCount(0);
  await page.getByTestId("mdl-edit-azure-speech-pa").click();
  const dlg = page.getByTestId("mdl-dialog");
  await expect(dlg.getByTestId("mdl-in")).toHaveCount(0);
  await dlg.getByTestId("mdl-audio").fill("abc");
  await expect(dlg.getByTestId("confirm-ok")).toBeDisabled();
  await dlg.getByTestId("mdl-audio").fill("1,5");
  await dlg.locator("#cmd-reason").fill("Новый тариф Azure");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("mdl-audio-azure-speech-pa")).toHaveText("$1,50");
  expect(bff.calls("PUT", "/ai/models/azure-speech-pa").at(-1)!.body).toEqual({ input_usd_per_mtok: 0, output_usd_per_mtok: 0, audio_usd_per_hour: 1.5, active: true, reason: "Новый тариф Azure" });
  // an LLM never sends the audio price
  await page.getByTestId("mdl-edit-claude-haiku-5-5").click();
  await page.getByTestId("mdl-out").fill("0,6");
  await page.locator("#cmd-reason").fill("Новая цена вывода");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("mdl-out-claude-haiku-5-5")).toHaveText("$0,60");
  expect(bff.calls("PUT", "/ai/models/claude-haiku-5-5").at(-1)!.body).not.toHaveProperty("audio_usd_per_hour");
  // costs: the pronunciation block
  await page.locator('[data-nav="costs"]').click();
  const cs = page.getByTestId("cs-speech");
  await expect(cs).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("cs-speech-minutes")).toHaveText("136,5");
  await expect(page.getByTestId("cs-speech-calls")).toHaveText("819");
  await expect(cs).toContainText("звук не хранится");
});

test("pronunciation sub-cap: «≈ N ч аудио» at the current price, 0…month, step-up; the costs show the spend against it", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/costs");
  // the month's speech spend against the sub-cap: 136,5 min × $1,32/h = $3,00 of $5,00
  const bar = page.getByTestId("cs-speech-cap");
  await expect(bar).toContainText("$3,00");
  await expect(bar).toContainText("из $5,00");
  await expect(page.getByTestId("cs-speech-cap-pct")).toHaveText("60,1 %");
  await expect(page.getByTestId("cs-speech-on")).toBeVisible();
  // the field and the hint from the price of the speech model
  const f = page.getByTestId("csf-speech_monthly_cap_usd");
  await expect(f).toHaveValue("5");
  await expect(page.locator('label[for="csf-speech_monthly_cap_usd"]')).toHaveText("Подлимит оценки произношения, $ в месяц");
  await expect(page.getByTestId("csf-speech-hours")).toHaveText("≈ 3,8 ч аудио при текущей цене $1,32/ч");
  await f.fill("2,64");
  await expect(page.getByTestId("csf-speech-hours")).toHaveText("≈ 2 ч аудио при текущей цене $1,32/ч");
  // 0…the monthly cap
  await f.fill("25");
  await page.getByTestId("csf-save").click();
  await expect(page.getByTestId("cs-settings")).toContainText("Не больше месячного потолка");
  await f.fill("-1");
  await expect(page.getByTestId("cs-settings")).toContainText("Число не меньше 0");
  await f.fill("2,5");
  await page.getByTestId("csf-save").click();
  const sd = page.getByTestId("csf-dialog");
  await expect(sd).toContainText("произношение $2,50 в месяц");
  await sd.locator("#cmd-reason").fill("Сокращаем подлимит речи до конца пилота");
  await sd.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("toasts")).toContainText("Лимиты сохранены");
  expect(bff.calls("PUT", "/ai/budget").at(-1)!.body).toMatchObject({ monthly_cap_usd: 20, speech_monthly_cap_usd: 2.5, reason: "Сокращаем подлимит речи до конца пилота" });
  // $3,00 spent of $2,50: the sub-cap is reached — the feature is hidden from learners
  await expect(page.getByTestId("cs-speech-off")).toBeVisible();
  await expect(bar).toHaveAttribute("data-level", "over");
  await expect(bar).toContainText("из $2,50");
  // a week: the sub-cap of the month as text
  await page.getByTestId("cs-period").getByRole("button", { name: /неделя/i }).click();
  await expect(page.getByTestId("cs-speech-cap-m")).toHaveText("Подлимит произношения: $2,50 в месяц");
});

test("speech without the Azure key: «не задан», the feature is shown as unavailable", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/agents/models", { ai: { noSpeechKey: true } });
  await expect(page.getByTestId("prov-speech-unset")).toContainText("ключ не задан");
  await expect(page.getByTestId("prov-speech-note")).toContainText("вводит владелец в Railway");
  await page.locator('[data-nav="costs"]').click();
  await expect(page.getByTestId("cs-speech-off")).toContainText("недоступна");
});

test("menu and tabs by permission: content_manager — reading and dictionary with glossary.manage; roles list the new permissions", async ({ page }) => {
  await openAs(page, "content@tilhero.local", "#/content");
  await expect(page.getByTestId("ct-tab-readings")).toBeVisible();
  await expect(page.getByTestId("ct-tab-glossary")).toBeVisible();
  await page.getByTestId("ct-tab-glossary").click();
  await expect(page.getByTestId("gl-new")).toBeVisible();
  expect(await menu(page)).toEqual(expect.arrayContaining(["overview", "content", "memory"]));
  await page.locator('[data-nav="memory"]').click();
  await expect(page.getByTestId("mem-analytics")).toBeVisible();
  await expect(page.getByTestId("mem-tab-learners")).toHaveCount(0);
});

test("roles: the matrix lists memory.read, memory.manage and glossary.manage with their labels", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/roles");
  const roles = page.getByTestId("roles");
  await expect(roles).toContainText("memory.manage");
  await expect(roles).toContainText("Память: ручная правка карточки");
  await expect(roles).toContainText("Словарь курса и переводы ИИ");
  await expect(roles).toContainText("Память учеников и аналитика забывания");
});

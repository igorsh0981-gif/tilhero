/**
 * Sprint 4 «Контроль диалогов» on the mock admin-bff (AT-52, AT-47, ADM-QA-01…04, UC-ADM-03): the journal with filters
 * → the session card whose ai-gateway block is down → «Показать реплики» with a reason (audited) → a «disputed» flag →
 * re-evaluation with step-up that keeps the original → the appeal: take → decision «corrected» with the
 * re-evaluation and a note for the learner; the Markdown task for Jira without learner data; texts deleted by
 * retention.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { TOTP } from "./fixtures/data";
import { AID, EID, SID, USER_REF } from "./fixtures/ai-data";

test.describe.configure({ timeout: 120_000 });

test("AT-52/AT-47: journal → card (ai-gateway down) → replies with a reason → flag → re-evaluation (step-up) → appeal decided", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/qa", { ai: { qaDown: ["ai-gateway"] } });
  await expect(page.getByTestId("qa-journal")).toBeVisible();
  await expect(page.locator('[data-testid^="qa-row-"]')).toHaveCount(7);
  // a cost unknown because ai-gateway was down is «—», not $0
  await expect(page.getByTestId(`qa-row-${SID.s4}`).locator('td[title^="Стоимость неизвестна"]')).toHaveText("—");
  // no learner names or ids in the journal
  await expect(page.getByTestId("qa-rows")).not.toContainText(USER_REF);
  await expect(page.getByTestId("qa-rows")).not.toContainText("Madina");
  // filters go to the server
  await page.getByTestId("qf-flag").selectOption("appealed");
  await expect(page.locator('[data-testid^="qa-row-"]')).toHaveCount(1);
  expect(bff.calls("GET", "/qa/sessions").at(-1)!.path).toBe("/qa/sessions");
  await page.getByTestId("qf-reset").click();
  await page.getByTestId("qf-kind").selectOption("lesson");
  await page.getByTestId("qf-level").selectOption("A1");
  await expect(page.locator('[data-testid^="qa-row-"]')).toHaveCount(2);
  await page.getByTestId(`qa-open-${SID.s1}`).click();

  // the card: three independent blocks, the AI calls are down
  const card = page.getByTestId("qa-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("qa-user-ref")).toContainText(USER_REF);
  await expect(page.getByTestId("qa-block-session")).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("qa-versions")).toContainText("lesson v3");
  await expect(page.getByTestId("qa-steps")).toContainText("с подсказкой");
  await expect(page.getByTestId("qa-turns")).toContainText("скрыт");
  await expect(page.getByTestId("qa-block-evaluations")).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("ev-0-evaluator")).toContainText("independent_evaluator@1");
  await expect(page.getByTestId("qa-block-calls-off")).toContainText("ai-gateway");
  // the learner's texts are not part of the card
  await expect(card).not.toContainText("My name is Madina");

  // «Показать реплики»: a reason ≥ 10, the view is audited
  await page.getByTestId("qa-transcript").click();
  const td = page.getByTestId("qa-transcript-dialog");
  await expect(page.getByTestId("qa-transcript-audit")).toContainText("журнал аудита");
  await td.locator("#cmd-reason").fill("апелляция");
  await td.getByTestId("confirm-ok").click();
  await expect(td).toContainText("не короче 10");
  await td.locator("#cmd-reason").fill("Апелляция A1: проверяем ложную коррекцию");
  await td.getByTestId("confirm-ok").click();
  const tv = page.getByTestId("qa-transcript-view");
  await expect(tv).toContainText("Hello! My name is Madina.");
  await expect(page.getByTestId("qa-tr-open")).toContainText("I say hello");
  expect(bff.ai.audit.at(-1)).toMatchObject({ action: "qa.transcript_viewed", id: SID.s1, reason: "Апелляция A1: проверяем ложную коррекцию" });
  await tv.getByTestId("drawer-close").click();
  await expect(tv).toHaveCount(0);
  await expect(card).not.toContainText("My name is Madina");

  // «Отметить спорной» — the evaluation itself does not change
  await page.getByTestId("qa-flag").click();
  const fd = page.getByTestId("qa-flag-dialog");
  await fd.locator("#cmd-reason").fill("Ошибка T3 — выбранная реплика, а не текст ученика");
  await fd.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("ev-0-flags")).toContainText("выбранная реплика");
  expect(bff.ai.evals[SID.s1]).toHaveLength(1);

  // «Переоценить» (qa.review, step-up): grammar 1 → 2, the T3 error removed, a reason
  await page.getByTestId("qa-reeval").click();
  const rv = page.getByTestId("qa-reeval-drawer");
  await expect(rv).toBeVisible();
  await page.getByTestId("rv2-s-grammar").selectOption("2");
  await page.getByTestId("rv2-s-pronunciation").selectOption("");
  await page.getByTestId("rv2-err-0-remove").click();
  await page.getByTestId("rv2-submit").click();
  await expect(rv).toContainText("не короче 10");
  await page.getByTestId("rv2-reason").fill("T3 выбрана из вариантов — это не ошибка ученика");
  await page.getByTestId("rv2-submit").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("toasts")).toContainText("Переоценка сохранена");
  await expect(page.getByTestId("ev-1")).toContainText("Переоценка 1");
  await expect(page.getByTestId("ev-1")).toContainText("актуальная");
  await expect(page.getByTestId("ev-1")).toContainText("T3 выбрана из вариантов");
  await expect(page.getByTestId("ev-0")).toContainText("Исходная оценка");
  await expect(page.getByTestId("ev-0-errors")).toContainText("I want coffee big"); // the original is kept
  const re = bff.calls("POST", `/qa/evaluations/${EID.e1}/reevaluate`).at(-1)!;
  expect(re.headers["idempotency-key"]).toBeTruthy();
  expect(re.body).toMatchObject({ scores: { grammar: 2, pronunciation: null }, confirmed_errors: [{ turn_id: "q2", error_code: "agreement" }], reason: "T3 выбрана из вариантов — это не ошибка ученика", appeal_id: null });

  // the appeal queue: take → decision «corrected» with the re-evaluation and a note for the learner
  await page.evaluate(() => (window.location.hash = "#/qa/appeals"));
  await expect(page.getByTestId("qa-appeals")).toBeVisible();
  await page.getByTestId(`ap-open-${AID.a1}`).click();
  const ad = page.getByTestId("ap-drawer");
  await expect(page.getByTestId("ap-reason")).toContainText("я выбрала из вариантов");
  await expect(page.getByTestId("ap-has-reeval")).toBeVisible();
  await expect(page.getByTestId("ap-decide")).toHaveCount(0);
  await page.getByTestId("ap-take").click();
  await expect(page.getByTestId("ap-card")).toHaveAttribute("data-status", "in_review");
  await page.getByTestId("ap-decide").click();
  const dd = page.getByTestId("ap-decide-dialog");
  await dd.getByTestId("ap-d-corrected").check();
  await expect(dd.getByTestId("ap-eval")).toBeVisible();
  await dd.getByTestId("ap-note-input").fill("Коротко");
  await dd.getByTestId("ap-decide-ok").click();
  await expect(dd).toContainText("от 10 до 500");
  await dd.getByTestId("ap-note-input").fill("Мы проверили: фразу вы выбрали из вариантов, это не ошибка. Оценка исправлена.");
  bff.expireStepUp();
  await dd.getByTestId("ap-decide-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", TOTP);
  await expect(dd).toHaveCount(0);
  await expect(page.getByTestId("ap-card")).toHaveAttribute("data-status", "corrected");
  await expect(page.getByTestId("ap-note")).toContainText("Оценка исправлена");
  const decided = bff.ai.appeals.find((a) => a.appeal_id === AID.a1)!;
  expect(decided).toMatchObject({ status: "corrected", decided_by_name: "Гульнора" });
  expect(decided.new_evaluation_id).toBe(bff.ai.evals[SID.s1]!.at(-1)!.evaluation_id);
  expect(bff.ai.audit.map((a) => a.action)).toEqual(expect.arrayContaining(["qa.flagged", "qa.reevaluated", "qa.appeal_taken", "qa.appeal_decided"]));
  await ad.getByTestId("drawer-close").click();
  await expect(page.getByTestId(`ap-row-${AID.a1}`)).toContainText("исправлена");
});

test("ADM-QA-04: the task for Jira — reproduction, expected, actual, session id and versions; no learner data", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openAs(page, "qa@tilhero.local", `#/qa/sessions/${SID.s1}`);
  await page.getByTestId("qa-task").click();
  const d = page.getByTestId("qa-task-drawer");
  await expect(page.getByTestId("qt-pii")).toBeVisible();
  await d.getByTestId("qt-title").fill("Ложная коррекция выбранной реплики");
  await d.getByTestId("qt-expected").fill("Оценщик не исправляет реплики, выбранные из вариантов");
  await d.getByTestId("qt-actual").fill(`Ошибка T3 засчитана. Ученица писала с madina@example.com, тел. +998 90 123 45 67, ник @madina_k, ref ${USER_REF}`);
  const md = page.getByTestId("qt-md");
  await expect(md).toContainText("# [Баг] Ложная коррекция выбранной реплики");
  await expect(md).toContainText(SID.s1);
  await expect(md).toContainText("Воспроизведение");
  await expect(md).toContainText("lesson v3, scenario v2, rubric v1");
  await expect(md).toContainText("s2 · retrieval · gap_fill → неверно (с подсказкой)");
  await expect(md).toContainText("independent_evaluator@1 · claude-sonnet-5-5");
  await expect(md).toContainText("Оценщик не исправляет реплики");
  for (const leak of [USER_REF, "madina@example.com", "123 45 67", "@madina_k", "I want coffee big", "Hello! My name is Madina", "я выбрала из вариантов"]) await expect(md).not.toContainText(leak);
  await expect(md).toContainText("[скрыто]");
  const [dl] = await Promise.all([page.waitForEvent("download"), d.getByTestId("qt-download").click()]);
  expect(dl.suggestedFilename()).toBe(`tilhero-session-${SID.s1.slice(0, 8)}.md`);
  const file = readFileSync((await dl.path())!, "utf8");
  expect(file).toContain(SID.s1);
  expect(file).not.toContain(USER_REF);
  await d.getByTestId("qt-copy").click();
  await expect(page.getByTestId("toasts")).toContainText("Скопировано");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("## Факт");
});

test("replies deleted by retention read «удалено по сроку хранения»; a failed session shows its status history", async ({ page }) => {
  await openAs(page, "qa@tilhero.local", `#/qa/sessions/${SID.s6}`);
  await expect(page.getByTestId("qa-status")).toHaveText("сбой");
  await expect(page.getByTestId("qa-history")).toContainText("сбой");
  await expect(page.getByTestId("qa-no-evaluations")).toBeVisible();
  // AI refusal reasons in words, the new cost_limit included
  await expect(page.getByTestId("qa-calls")).toContainText("ошибка провайдера");
  await expect(page.getByTestId("qa-calls")).toContainText("превышен лимит стоимости вызова (версия агента)");
  await page.getByTestId("qa-transcript").click();
  await page.locator("#cmd-reason").fill("Разбор сбоя провайдера в сценарии");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("qa-tr-T1-redacted")).toContainText("удалён по сроку хранения");
  await expect(page.getByTestId("qa-transcript-view")).toContainText("Do you have a booking?");
});

test("appeal text erased 90 days after the decision: «удалён по сроку хранения» in the queue and in the card", async ({ page }) => {
  await openAs(page, "qa@tilhero.local", "#/qa/appeals");
  await expect(page.getByTestId("qa-appeals")).toBeVisible();
  await expect(page.getByTestId(`ap-redacted-${AID.a4}`)).toHaveText("удалён по сроку хранения");
  await expect(page.getByTestId(`ap-open-${AID.a1}`)).toContainText("я выбрала из вариантов");
  await expect(page.getByTestId(`ap-redacted-${AID.a1}`)).toHaveCount(0);
  await page.getByTestId(`ap-open-${AID.a4}`).click();
  await expect(page.getByTestId("ap-reason")).toHaveAttribute("data-redacted", "true");
  await expect(page.getByTestId("ap-reason-redacted")).toContainText("удалён по сроку хранения");
  await expect(page.getByTestId("ap-reason").locator("blockquote")).toHaveCount(0);
  // the decision itself is kept
  await expect(page.getByTestId("ap-note")).toContainText("оценка верна");
});

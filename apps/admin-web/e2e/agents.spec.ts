/**
 * Sprint 4 «Агенты и скиллы» on the mock admin-bff (AT-49, ADM-AGENT-01…05): the registry of 17 agents; the life cycle
 * of a conversation_partner version — draft → edit → golden run with a failure → fix → green run → publication with
 * step-up → canary 10 % → rollback; If-Match conflict; the diff with the published version; the golden-case builder;
 * models and prices (step-up); the provider status without any key field.
 */
import { expect, test, type Page } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { TOTP } from "./fixtures/data";

test.describe.configure({ timeout: 120_000 });

async function confirm(page: Page, testId: string, reason: string, stepUp: boolean) {
  const dlg = page.getByTestId(testId);
  await expect(dlg).toBeVisible();
  await dlg.locator("#cmd-reason").fill(reason);
  await dlg.getByTestId("confirm-ok").click();
  if (stepUp) {
    await expect(page.getByTestId("stepup")).toBeVisible();
    await typeOtp(page, "stepup", TOTP);
  }
  await expect(dlg).toHaveCount(0);
}

async function runTests(page: Page) {
  await page.getByTestId("agv-run").click();
  await expect(page.getByTestId("agv-progress")).toBeVisible();
  await expect(page.getByTestId("agv-run-summary")).toBeVisible({ timeout: 15_000 });
}

test("registry: 17 agents with type, place, stage; LLM rows carry version, model, canary, tests, calls", async ({ page }) => {
  await openAs(page, "methodist@tilhero.local", "#/agents");
  await expect(page.getByTestId("ag-registry")).toBeVisible();
  await expect(page.locator('[data-testid^="ag-row-"]')).toHaveCount(17);
  const cp = page.getByTestId("ag-row-conversation_partner");
  await expect(cp).toContainText("LLM");
  await expect(cp).toContainText("v2");
  await expect(cp).toContainText("claude-haiku-5-5");
  await expect(cp).toContainText("свободный текст ученика");
  await expect(page.getByTestId("ag-canary-independent_evaluator")).toHaveText(/v2 · 10%/);
  await expect(page.getByTestId("ag-row-learning_orchestrator")).toContainText("lessons");
  await expect(page.getByTestId("ag-row-learning_orchestrator")).toContainText("версии — через релиз сервиса");
  await expect(page.getByTestId("ag-row-spaced_repetition_coach")).toContainText("спринт 5");
  // code / rules agents do not open a version card
  await expect(page.getByTestId("ag-open-learning_orchestrator")).toHaveCount(0);
  await page.getByTestId("ag-filter").getByRole("button", { name: /^LLM/ }).click();
  await expect(page.locator('[data-testid^="ag-row-"]')).toHaveCount(8);
  // a planned LLM agent has no versions yet: no card link
  await expect(page.getByTestId("ag-open-pronunciation_coach")).toHaveCount(0);
});

test("AT-49: draft → edit → failed run → fix → green → publish (step-up) → canary 10 % → rollback", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/agents/conversation_partner");
  await expect(page.getByTestId("ag-card")).toBeVisible();
  await expect(page.getByTestId("ag-pub")).toContainText("v2");
  await expect(page.getByTestId("ag-version")).toHaveAttribute("data-status", "published");
  await expect(page.getByTestId("agv-readonly")).toContainText("неизменяема");
  // draft from the published version
  await page.getByTestId("ag-new-draft").click();
  await expect(page.getByTestId("ag-version")).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("ag-version")).toHaveAttribute("data-version", "3");
  expect(bff.ai.states("conversation_partner")).toEqual(["v1:archived", "v2:published", "v3:draft"]);
  // publication is closed until a run of this version
  await expect(page.getByTestId("agv-gate")).toHaveAttribute("data-gate", "no_run");
  await expect(page.getByTestId("agv-publish")).toBeDisabled();
  // edit: one more instruction line and a too short reply in the schema
  const ins = page.getByTestId("agv-instructions");
  await ins.fill(`${await ins.inputValue()}\nPrefer the vocabulary of the current lesson.`);
  await expect(page.getByTestId("agv-instructions-count")).toContainText("/ 20");
  const schema = page.getByTestId("agv-schema");
  await schema.fill((await schema.inputValue()).replace('"maxLength": 240', '"maxLength": 20'));
  // a broken JSON is caught before the request, with the line
  await schema.press("End");
  await schema.pressSequentially(",");
  await expect(page.getByTestId("ag-version")).toContainText("Ошибка JSON: строка");
  await schema.press("Backspace");
  await expect(page.getByTestId("agf-schema-ok")).toBeVisible();
  await expect(page.getByTestId("agv-run")).toBeDisabled(); // unsaved
  await page.getByTestId("agv-save").click();
  await expect(page.getByTestId("toasts")).toContainText("Черновик v3 сохранён");
  const patch = bff.calls("PATCH", "/ai/agents/conversation_partner/versions/3").at(-1)!;
  expect(patch.headers["if-match"]).toBeTruthy();
  expect(Object.keys(patch.body as object).sort()).toEqual(["instructions", "output_schema"]);
  // golden run → a mandatory case fails → publication stays closed with a link to the results
  await runTests(page);
  await expect(page.getByTestId("agv-run-summary")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("agv-results").locator('[data-passed="false"]', { hasText: "Длина реплики персонажа" })).toHaveCount(1);
  await expect(page.getByTestId("agv-results")).toContainText("longer than maxLength 20");
  await expect(page.getByTestId("agv-fake-note")).toBeVisible();
  await expect(page.getByTestId("agv-gate")).toHaveAttribute("data-gate", "failed");
  await expect(page.getByTestId("agv-publish")).toBeDisabled();
  await page.getByTestId("agv-to-results").click();
  // fix → save → green run
  await schema.fill((await schema.inputValue()).replace('"maxLength": 20', '"maxLength": 240'));
  await page.getByTestId("agv-save").click();
  await expect(page.getByTestId("agv-gate")).toHaveAttribute("data-gate", "no_run");
  await runTests(page);
  await expect(page.getByTestId("agv-run-summary")).toHaveAttribute("data-ok", "true");
  await expect(page.getByTestId("agv-gate")).toHaveCount(0);
  // publish with a reason and step-up
  await page.getByTestId("agv-publish").click();
  await confirm(page, "agv-publish-dialog", "Короче реплики, словарь урока", true);
  await expect(page.getByTestId("toasts")).toContainText("Опубликована v3");
  await expect(page.getByTestId("ag-pub")).toContainText("v3");
  expect(bff.ai.states("conversation_partner")).toEqual(["v1:archived", "v2:archived", "v3:published"]);
  expect(bff.ai.audit.map((a) => a.action)).toEqual(expect.arrayContaining(["ai.version_created", "ai.version_updated", "ai.test_run", "ai.version_published"]));
  // canary: a new draft with a green run gets 10 % of traffic
  await page.getByTestId("ag-new-draft").click();
  await expect(page.getByTestId("ag-version")).toHaveAttribute("data-version", "4");
  await runTests(page);
  await page.getByTestId("ag-canary-btn").click();
  const cn = page.getByTestId("ag-canary-dialog");
  await cn.getByTestId("cn-percent").fill("60");
  await expect(cn.getByTestId("confirm-ok")).toBeDisabled();
  await cn.getByTestId("cn-percent").fill("10");
  bff.expireStepUp(); // each privileged command needs a fresh code once the 5-minute window is over
  await confirm(page, "ag-canary-dialog", "Проверяем v4 на части трафика", true);
  await expect(page.getByTestId("ag-canary")).toContainText("v4 · 10 %");
  expect(bff.calls("PUT", "/ai/agents/conversation_partner/canary").at(-1)!.body).toMatchObject({ version: 4, percent: 10 });
  // rollback to the previous published version (the canary stops)
  await page.getByTestId("ag-rollback").click();
  bff.expireStepUp();
  await confirm(page, "ag-rollback-dialog", "Отказы выросли после публикации v3", true);
  await expect(page.getByTestId("ag-pub")).toContainText("v2");
  await expect(page.getByTestId("ag-canary-none")).toBeVisible();
  await expect(page.getByTestId("ag-rollback")).toBeDisabled();
  expect(bff.ai.audit.map((a) => a.action)).toEqual(expect.arrayContaining(["ai.canary_set", "ai.rolled_back"]));
});

test("If-Match: another staff member saved the draft → 409 VERSION_CONFLICT → reload", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/agents/teaching_coach");
  await page.getByTestId("ag-new-draft").click();
  await expect(page.getByTestId("ag-version")).toHaveAttribute("data-status", "draft");
  await page.getByTestId("agv-notes").fill("Пример короче");
  bff.ai.touchDraft("teaching_coach");
  await page.getByTestId("agv-save").click();
  await expect(page.getByTestId("agv-conflict")).toBeVisible();
  await page.getByTestId("agv-reload").click();
  await expect(page.getByTestId("agv-conflict")).toHaveCount(0);
  await expect(page.getByTestId("agv-notes")).toHaveValue("");
});

test("a version on the canary is frozen: no edit or delete, but tests and publication; the diff with the published one", async ({ page }) => {
  await openAs(page, "methodist@tilhero.local", "#/agents/independent_evaluator");
  await expect(page.getByTestId("ag-version")).toHaveAttribute("data-version", "2");
  await expect(page.getByTestId("agv-readonly")).toContainText("заморожена");
  await expect(page.getByTestId("agv-save")).toHaveCount(0);
  await expect(page.getByTestId("agv-delete")).toHaveCount(0);
  await expect(page.getByTestId("agv-run")).toBeEnabled();
  await expect(page.getByTestId("agv-publish")).toBeEnabled();
  await expect(page.getByTestId("agv-temperature")).toHaveAttribute("readonly", "");
  await page.getByTestId("agc-tab-diff").click();
  await expect(page.getByTestId("ag-diff")).toContainText("Изменения v2 относительно опубликованной v1");
  const ins = page.getByTestId("ag-diff-instructions");
  await expect(ins.locator('[data-op="add"]')).toHaveCount(1);
  await expect(ins.locator('[data-op="add"]')).toContainText("self-correction");
  await expect(ins.locator('[data-op="del"]')).toHaveCount(0);
  await expect(page.getByTestId("ag-diff-params").locator("tr.is-changed")).toHaveCount(0);
  await expect(page.getByTestId("ag-diff-rules-same")).toBeVisible();
});

test("diff marks unsaved edits of a draft and changed parameters", async ({ page }) => {
  await openAs(page, "methodist@tilhero.local", "#/agents/teaching_coach");
  await page.getByTestId("ag-new-draft").click();
  await expect(page.getByTestId("ag-version")).toHaveAttribute("data-version", "2");
  await page.getByTestId("agv-temperature").fill("0.2");
  // switching the interface language keeps unsaved edits
  await page.getByTestId("lang-en").click();
  await expect(page.getByTestId("agc-tab-version")).toHaveText(/Version v2/);
  await expect(page.getByTestId("agv-temperature")).toHaveValue("0.2");
  await page.getByTestId("lang-ru").click();
  const ins = page.getByTestId("agv-instructions");
  await ins.fill((await ins.inputValue()).replace("Give one new English example", "Give two short English examples"));
  await page.getByTestId("agc-tab-diff").click();
  await expect(page.getByTestId("ag-diff")).toContainText("С учётом несохранённых правок");
  await expect(page.getByTestId("ag-diff-instructions").locator('[data-op="del"]')).toContainText("Give one new English example");
  await expect(page.getByTestId("ag-diff-instructions").locator('[data-op="add"]')).toContainText("Give two short English examples");
  await expect(page.getByTestId("ag-diff-params").locator("tr.is-changed")).toHaveCount(1);
});

test("golden cases: builder with typed values, path check, archive", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/agents/conversation_partner");
  await page.getByTestId("agc-tab-cases").click();
  await expect(page.getByTestId("gc-list")).toContainText("Золотые тесты: 10, обязательных 7");
  await page.getByTestId("gc-add").click();
  const ed = page.getByTestId("gc-editor");
  await ed.getByTestId("gc-title").fill("Вежливый отказ от скидки");
  await ed.getByTestId("gc-ctx").fill('{"learner_turn": "Give me a discount", "attempts_on_node": 0}');
  await ed.getByTestId("gc-add-check").click();
  await ed.getByTestId("gck-1-path").fill("output intent");
  await ed.getByTestId("gck-1-values").fill("unclear\noff_topic\nnull");
  await ed.getByTestId("gc-save").click();
  await expect(ed).toContainText("Путь от корня ответа");
  await ed.getByTestId("gck-1-path").fill("output.intent");
  await ed.getByTestId("gc-add-check").click();
  await ed.getByTestId("gck-2-kind").selectOption("max_length");
  await ed.getByTestId("gck-2-path").fill("output.reply_en");
  await ed.getByTestId("gck-2-n").fill("0");
  await expect(ed.getByTestId("gck-2")).toContainText("Целое число от 1 до 20000");
  await ed.getByTestId("gck-2-n").fill("200");
  await ed.getByTestId("gc-save").click();
  await expect(ed).toHaveCount(0);
  await expect(page.getByTestId("toasts")).toContainText("Кейс «Вежливый отказ от скидки» создан");
  const post = bff.calls("POST", "/ai/agents/conversation_partner/golden-cases").at(-1)!;
  expect(post.body).toMatchObject({
    title: "Вежливый отказ от скидки",
    mandatory: true,
    input: { audience: "adults", context: { learner_turn: "Give me a discount" } },
    checks: [{ kind: "schema_valid" }, { kind: "field_in", path: "output.intent", values: ["unclear", "off_topic", null] }, { kind: "max_length", path: "output.reply_en", n: 200 }],
  });
  await expect(page.getByTestId("gc-list")).toContainText("Золотые тесты: 11, обязательных 8");
  // archive
  const created = bff.ai.cases.at(-1)!;
  await page.getByTestId(`gc-archive-${created.case_id}`).click();
  await page.getByTestId("gc-archive-ok").click();
  await expect(page.getByTestId("gc-list")).toContainText("Золотые тесты: 10");
});

test("models and prices: edit with step-up; the provider shows only «key set / not set», never a key field", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/agents/models", { ai: { noKey: true } });
  await expect(page.getByTestId("prov-key-unset")).toBeVisible();
  await expect(page.getByTestId("prov-note")).toContainText("ANTHROPIC_API_KEY");
  await expect(page.getByTestId("ag-provider").locator("input, textarea")).toHaveCount(0);
  await expect(page.getByTestId("mdl-in-claude-haiku-5-5")).toHaveText(/^\$0[.,]10$/);
  await page.getByTestId("mdl-edit-claude-haiku-5-5").click();
  const dlg = page.getByTestId("mdl-dialog");
  await dlg.getByTestId("mdl-in").fill("-1");
  await expect(dlg.getByTestId("confirm-ok")).toBeDisabled();
  await dlg.getByTestId("mdl-in").fill("0.12");
  await confirm(page, "mdl-dialog", "Новый прайс Anthropic", true);
  await expect(page.getByTestId("mdl-in-claude-haiku-5-5")).toHaveText(/^\$0[.,]12$/);
  expect(bff.calls("PUT", "/ai/models/claude-haiku-5-5").at(-1)!.body).toMatchObject({ input_usd_per_mtok: 0.12, output_usd_per_mtok: 0.5, active: true, reason: "Новый прайс Anthropic" });
  expect(bff.ai.audit.at(-1)).toMatchObject({ action: "ai.model_updated" });
});

test("prod/stage: a green run on fake does not publish — 422 TESTS_REQUIRED real_provider_required is explained", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/agents/independent_evaluator", { ai: { realProviderRequired: true } });
  await expect(page.getByTestId("agv-publish")).toBeEnabled();
  await page.getByTestId("agv-publish").click();
  const dlg = page.getByTestId("agv-publish-dialog");
  await dlg.locator("#cmd-reason").fill("Самоисправление засчитывается");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", TOTP);
  await expect(dlg).toContainText("на настоящем провайдере (anthropic)");
  expect(bff.ai.states("independent_evaluator")).toEqual(["v1:published", "v2:draft"]);
});

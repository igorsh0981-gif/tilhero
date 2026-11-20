/**
 * Sprint 5 «Контент → Чтение» on the mock admin-bff (AT-57, AT-60): a draft that breaks the rules (58 words, a sentence
 * of 33 words, a glossary word not in the text) → the always-on rules and the catalog codes at the fields → fix by
 * editing, adding sentences with RU/UZ translations and a glossary word that occurs → save → submit → another methodist
 * reviews → publication with step-up; the learner preview with a tap on a highlighted word; «Чтение» in «Контроль
 * диалогов».
 */
import { expect, test, type Page } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { TOTP } from "./fixtures/data";
import { SID } from "./fixtures/ai-data";

test.describe.configure({ timeout: 90_000 });

const ws = (page: Page) => page.getByTestId("ws-reading");

async function becomes(page: Page, bff: Awaited<ReturnType<typeof openAs>>, email: string, hash: string) {
  bff.switchTo(email);
  await page.goto(`/${hash}`);
  await page.reload();
  await expect(page.getByTestId("shell")).toBeVisible();
}

test("AT-60 reading: rules and catalog codes at the fields → fix → save → submit → review by another methodist → publish (step-up)", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/content/readings/r-a1-market");
  await expect(ws(page)).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("list-reading")).toContainText("r-a1-coffee-shop");
  // the rules are always visible: text + icon (not colour alone)
  await expect(page.getByTestId("rd-words")).toContainText("58");
  await expect(page.getByTestId("rd-rule-words")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("rd-rule-words")).toContainText("нужно не меньше 60");
  await expect(page.getByTestId("rd-rule-sentences")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("rd-s-words-0-1")).toContainText("33/30");
  await expect(page.getByTestId("rd-rule-glossary")).toContainText("Слов глоссария нет в тексте: 1");
  await expect(page.getByTestId("rd-gi-missing-2")).toContainText("Не встречается в тексте");
  await expect(page.getByTestId("rd-gi-found-0")).toContainText("s1, s3");
  // the dry check of the saved draft: catalog codes as plain messages, each leads to its field
  await page.getByTestId("ws-validate").click();
  const issues = page.getByTestId("ws-issues");
  await expect(issues).toBeVisible();
  await expect(page.getByTestId("issue-READING_WORDS")).toContainText("В тексте должно быть от 60 до 250 слов");
  await expect(page.getByTestId("issue-SENTENCE_TOO_LONG")).toContainText("Предложение длиннее 30 слов");
  await expect(page.getByTestId("issue-GLOSSARY_NOT_IN_TEXT")).toContainText("Этого слова нет в тексте");
  await page.getByTestId("go-payload.glossary[2].en").click();
  await expect(page.getByTestId("rd-gi-en-2")).toBeFocused();
  await expect(page.getByTestId("err-payload.glossary[2].en")).toContainText("Этого слова нет в тексте");
  await page.getByTestId("rd-gi-en-2").fill("spices");
  await expect(page.getByTestId("rd-gi-found-2")).toContainText("s4");
  await expect(page.getByTestId("rd-highlight").locator("mark")).toHaveCount(4);
  // the long sentence → two sentences (a new s5 keeps the numbering), one more sentence in paragraph 2
  await page.getByTestId("rd-go-payload.paragraphs[0].sentences[1].text_en").click();
  await expect(page.getByTestId("rd-en-0-1")).toBeFocused();
  await page.getByTestId("rd-en-0-1").fill("He buys fresh bread, tomatoes, cucumbers and some green apples for the family.");
  await page.getByTestId("rd-add-s-0").click();
  await expect(page.getByTestId("rd-s-0-2")).toContainText("s5");
  await page.getByTestId("rd-en-0-2").fill("Then he talks with the old seller about the weather, the prices and his little garden in the village.");
  await page.getByTestId("rd-gl-0-2-ru").fill("Потом он говорит со старым продавцом о погоде, ценах и своём маленьком саде в деревне.");
  await page.getByTestId("rd-add-s-1").click();
  await page.getByTestId("rd-en-1-2").fill("Aziz always comes home happy and tired.");
  await page.getByTestId("rd-gl-1-2-ru").fill("Азиз всегда возвращается домой довольный и уставший.");
  // the empty UZ translations are counted on the language tab
  await expect(page.getByTestId("ws-lang-uz")).toContainText("2");
  await page.getByTestId("ws-lang-uz").click();
  await page.getByTestId("rd-gl-0-2-uz").fill("Keyin u keksa sotuvchi bilan ob-havo, narxlar va qishloqdagi kichik bogʻi haqida gaplashadi.");
  await page.getByTestId("rd-gl-1-2-uz").fill("Aziz doim uyga xursand va charchagan holda qaytadi.");
  await expect(page.getByTestId("rd-words")).toContainText("64");
  for (const r of ["words", "sentences", "glossary", "glossaryCount", "questions"]) await expect(page.getByTestId(`rd-rule-${r}`)).toHaveAttribute("data-ok", "true");
  // save (expected_hash) → submit
  await expect(page.getByTestId("ws-submit")).toBeDisabled();
  await page.getByTestId("ws-save").click();
  await expect(page.getByTestId("toasts")).toContainText("Сохранено: v1");
  const put = bff.calls("PUT", "/content/reading/r-a1-market/versions/1").at(-1)!;
  expect(put.body).toMatchObject({ expected_hash: expect.stringMatching(/^[0-9a-f]{64}$/), payload: { glossary: [{ en: "market" }, { en: "seller" }, { en: "spices" }] } });
  const paras = (put.body as { payload: { paragraphs: Array<{ sentences: Array<{ s_id: string }> }> } }).payload.paragraphs;
  expect(paras.map((p) => p.sentences.map((s) => s.s_id))).toEqual([["s1", "s2", "s5"], ["s3", "s4", "s6"]]);
  await page.getByTestId("ws-submit").click();
  await expect(ws(page)).toHaveAttribute("data-status", "in_review");
  // another methodist reviews (the author cannot)
  await becomes(page, bff, "methodist2@tilhero.local", "#/content/review");
  await page.getByTestId("rv-open-r-a1-market").click();
  await expect(page.getByTestId("rv-diff")).toContainText("paragraphs[0].sentences[2].text_en");
  await page.getByTestId("rv-note").fill("Текст проверен, переводы вычитаны");
  await page.getByTestId("rv-check-ru").check();
  await page.getByTestId("rv-check-uz").check();
  await page.getByTestId("rv-approve").click();
  await expect(page.getByTestId("review-queue")).toBeVisible();
  // publication with a fresh TOTP
  await page.evaluate(() => (window.location.hash = "#/content/readings/r-a1-market"));
  await expect(ws(page)).toHaveAttribute("data-status", "approved");
  await page.getByTestId("ws-publish").click();
  await page.locator("#cmd-reason").fill("Текст «На рынке» для A1");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", TOTP);
  await expect(ws(page)).toHaveAttribute("data-status", "published");
  expect(bff.content.states("reading", "r-a1-market")).toEqual(["published"]);
  expect(bff.calls("POST", "/content/reading/r-a1-market/versions/1/publish").at(-1)!.headers["idempotency-key"]).toBeTruthy();
});

test("reading: a published text is read-only; the learner preview translates a highlighted word in RU/UZ; a kids text is for kids only", async ({ page }) => {
  await openAs(page, "methodist@tilhero.local", "#/content/readings/r-a1-coffee-shop");
  await expect(page.getByTestId("ws-reading")).toHaveAttribute("data-status", "published");
  await expect(page.getByTestId("ws-readonly")).toBeVisible();
  await expect(page.getByTestId("rd-add-p")).toHaveCount(0);
  await page.getByTestId("ws-tab-preview").click();
  const phone = page.getByTestId("reading-phone");
  await expect(phone).toContainText("Чтение · уровень A1 · 5 мин · 66 слов");
  await page.getByTestId("rd-pv-word-1").click();
  await expect(page.getByTestId("rd-pv-sheet")).toContainText("очередь");
  await expect(page.getByTestId("rd-pv-sheet")).toContainText("В американском английском — line");
  await page.getByTestId("pv-lang").getByRole("button", { name: "UZ" }).click();
  await expect(page.getByTestId("rd-pv-sheet")).toContainText("navbat");
  await page.getByTestId("rd-pv-tr-p2").click();
  await expect(phone).toContainText("Bugun qahvaxona juda gavjum");
  // a new text: checking «kids» leaves kids only (KIDS_CONTENT is impossible from the form)
  await page.getByTestId("new-reading").click();
  await expect(page.getByTestId("ws-reading")).toHaveAttribute("data-status", "new");
  await page.getByTestId("rd-aud-kids").check();
  await expect(page.getByTestId("rd-aud-kids")).toBeChecked();
  await expect(page.getByTestId("rd-aud-adults")).not.toBeChecked();
  await expect(page.getByTestId("rd-aud-teens")).not.toBeChecked();
  await expect(page.getByTestId("rd-kids-note")).toContainText("виден только детям 6–13");
  await page.getByTestId("rd-aud-adults").check();
  await expect(page.getByTestId("rd-aud-kids")).not.toBeChecked();
});

test("«Контроль диалогов»: the session kind «Чтение» in the filter and in the rows (reading_id)", async ({ page }) => {
  await openAs(page, "methodist@tilhero.local", "#/qa");
  await page.getByTestId("qf-kind").selectOption("reading");
  await expect(page.locator('[data-testid^="qa-row-"]')).toHaveCount(1);
  await expect(page.getByTestId(`qa-row-${SID.s7}`)).toContainText("Чтение · r-a1-coffee-shop");
  await page.getByTestId(`qa-open-${SID.s7}`).click();
  await expect(page.getByTestId("qa-card")).toContainText("r-a1-coffee-shop");
});

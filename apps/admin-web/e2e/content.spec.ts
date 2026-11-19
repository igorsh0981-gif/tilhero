/**
 * Sprint 3 «Контент» and «Языки и курсы» on the mock admin-bff (AT-26…31): the life cycle of a lesson with an empty UZ
 * highlighted → validate → submit → review by another methodist → publication with step-up → rollback; a scenario test
 * run with problems → fix → green → publication; media rights without UZ → error → approval; a learner's request →
 * decision; a pair that is not ready; RBAC of the new permissions; the overview blocks.
 */
import { expect, test, type Page } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { TOTP } from "./fixtures/data";
import { REQ } from "./fixtures/content-data";

// the life-cycle flows switch staff members, reload and pass step-up several times
test.describe.configure({ timeout: 90_000 });

const ws = (page: Page, kind: string) => page.getByTestId(`ws-${kind}`);

/** The current session is replaced by another staff member (as after a sign-in in another browser) and the page reloads. */
async function becomes(page: Page, bff: Awaited<ReturnType<typeof openAs>>, email: string, hash: string) {
  bff.switchTo(email);
  await page.goto(`/${hash}`);
  await page.reload(); // a hash change alone keeps the old document (and the old Me)
  await expect(page.getByTestId("shell")).toBeVisible();
}

async function confirmWithReason(page: Page, reason: string, stepUp: boolean) {
  await page.locator("#cmd-reason").fill(reason);
  await page.getByTestId("confirm-ok").click();
  if (stepUp) {
    await expect(page.getByTestId("stepup")).toBeVisible();
    await typeOtp(page, "stepup", TOTP);
  }
}

async function approveAs(page: Page, bff: Awaited<ReturnType<typeof openAs>>, email: string, kind: string, key: string) {
  await becomes(page, bff, email, "#/content/review");
  await page.getByTestId(`rv-open-${key}`).click();
  await expect(page.getByTestId("rv-diff")).toBeVisible();
  await page.getByTestId("rv-approve").click();
  await expect(page.getByText(/от 3 до 1000|3 to 1000/)).toBeVisible();
  await page.getByTestId("rv-note").fill("Проверено: RU и UZ вычитаны");
  await page.getByTestId("rv-approve").click();
  await expect(page.getByText(/Для одобрения отметьте/)).toBeVisible();
  await page.getByTestId("rv-check-ru").check();
  await page.getByTestId("rv-check-uz").check();
  await page.getByTestId("rv-approve").click();
  await expect(page.getByTestId("review-queue")).toBeVisible();
  expect(bff.content.states(kind as never, key).at(-1)).toBe("approved");
}

test("AT-26/27 lesson: empty UZ highlighted → validate → submit → another methodist reviews → publish with step-up → rollback", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/content/lessons/l-01-greetings");
  await expect(ws(page, "lesson")).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("ws-lang-uz")).toContainText("3");
  await page.getByTestId("ws-lang-uz").click();
  await expect(page.getByTestId("le-title-uz-missing")).toBeVisible();
  // dry check of the saved draft: empty translations and unchecked localisations, each with «→ к полю»
  await page.getByTestId("ws-validate").click();
  await expect(page.getByTestId("ws-issues")).toBeVisible();
  await expect(page.getByTestId("issue-LOCALE_MISSING")).toHaveCount(3);
  await page.getByTestId("go-payload.title.uz").click();
  await expect(page.getByTestId("le-title-uz")).toBeFocused();
  await page.getByTestId("le-title-uz").fill("Salom! Tanishamiz");
  await page.getByTestId("le-stage-1-uz").fill("Hello, Hi, Good morning, Good evening va My name is…");
  await page.locator('input[data-path="payload.key_words[4].gloss.uz"]').fill("xayrli kech");
  await expect(page.getByTestId("ws-lang-uz")).not.toContainText("3");
  // submission is closed until the edits are saved
  await expect(page.getByTestId("ws-submit")).toBeDisabled();
  await page.getByTestId("ws-save").click();
  await expect(page.getByTestId("toasts")).toContainText("Сохранено: v2");
  const put = bff.calls("PUT", "/content/lesson/l-01-greetings/versions/2").at(-1)!;
  expect(put.body).toMatchObject({ expected_hash: expect.stringMatching(/^[0-9a-f]{64}$/), payload: { title: { uz: "Salom! Tanishamiz" } } });
  await page.getByTestId("ws-submit").click();
  await expect(ws(page, "lesson")).toHaveAttribute("data-status", "in_review");
  expect(bff.content.states("lesson", "l-01-greetings")).toEqual(["published", "in_review"]);
  // the author cannot review the own version — a plain explanation, the buttons are off
  await page.evaluate(() => (window.location.hash = "#/content/review/lesson/l-01-greetings"));
  await expect(page.getByTestId("rv-self")).toContainText("Автор не проверяет свою версию");
  await expect(page.getByTestId("rv-approve")).toBeDisabled();
  // another methodist: queue → diff → marks → approve
  await approveAs(page, bff, "methodist2@tilhero.local", "lesson", "l-01-greetings");
  // publication with a fresh TOTP
  await page.evaluate(() => (window.location.hash = "#/content/lessons/l-01-greetings"));
  await expect(ws(page, "lesson")).toHaveAttribute("data-status", "approved");
  await page.getByTestId("ws-publish").click();
  await confirmWithReason(page, "Новая версия урока: вечернее приветствие", true);
  await expect(ws(page, "lesson")).toHaveAttribute("data-status", "published");
  expect(bff.content.states("lesson", "l-01-greetings")).toEqual(["archived", "published"]);
  expect(bff.calls("POST", "/content/lesson/l-01-greetings/versions/2/publish").at(-1)!.headers["idempotency-key"]).toBeTruthy();
  // rollback to v1 from the versions history (the step-up window is still open: no second prompt)
  await page.getByTestId("ws-tab-versions").click();
  await expect(page.getByTestId("ver-rollback-2")).toHaveCount(0);
  await page.getByTestId("ver-rollback-1").click();
  await confirmWithReason(page, "Откат: вернуть прежний текст", false);
  await expect(ws(page, "lesson")).toHaveAttribute("data-version", "1");
  await expect(ws(page, "lesson")).toHaveAttribute("data-status", "published");
  expect(bff.content.states("lesson", "l-01-greetings")).toEqual(["published", "archived"]);
  expect(bff.audit.slice(0, 2).map((r) => r.action)).toEqual(["content.rolled_back", "content.published"]);
});

test("AT-28 scenario: test run finds a dead end and an unreachable node → click → fix → green → publish", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/content/scenarios/sc-cafe-order");
  await expect(ws(page, "scenario")).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("ws-submit")).toBeDisabled();
  await expect(page.getByTestId("ws-gate-submit")).toContainText("тестовый прогон");
  await page.getByTestId("se-run").click();
  await expect(page.getByTestId("se-run-state")).toContainText("проблем 2");
  await expect(page.getByTestId("run-issue-DEAD_END-n_wait")).toBeVisible();
  await expect(page.getByTestId("run-issue-UNREACHABLE_NODE-n_tip")).toBeVisible();
  await expect(page.getByTestId("sg-node-n_wait")).toHaveAttribute("data-bad", "DEAD_END");
  await expect(page.getByTestId("sg-node-n_tip")).toHaveAttribute("data-bad", "UNREACHABLE_NODE");
  // the issue leads to its node: the node editor opens
  await page.getByTestId("run-go-n_wait").click();
  await expect(page.getByTestId("se-node-ed-n_wait")).toBeVisible();
  await expect(page.getByTestId("sg-node-n_wait")).toHaveAttribute("aria-pressed", "true");
  // fix: «wait» leads to «tip» — no dead end, «tip» becomes reachable
  await page.getByTestId("se-add-tr").click();
  await page.getByTestId("se-tr-to-0").selectOption("n_tip");
  await page.getByTestId("se-tr-intent-0").fill("ready");
  await page.getByTestId("se-tr-ex-0").fill("I'm ready now.");
  await page.locator('input[data-path="payload.nodes.n_wait.transitions[0].description.ru"]').fill("Скажите, что готовы");
  await page.getByTestId("ws-lang-uz").click();
  await page.locator('input[data-path="payload.nodes.n_wait.transitions[0].description.uz"]').fill("Tayyor ekaningizni ayting");
  await expect(page.getByTestId("se-run-state")).toContainText("несохранённые");
  await expect(page.getByTestId("se-local")).toHaveCount(0); // the preliminary check is already clean
  await page.getByTestId("ws-save").click();
  await expect(page.getByTestId("se-run-state")).toContainText("прогона ещё не было");
  await expect(page.getByTestId("ws-submit")).toBeDisabled();
  await page.getByTestId("se-run").click();
  await expect(page.getByTestId("se-run-green")).toBeVisible();
  await expect(page.getByTestId("sg-node-n_tip")).not.toHaveAttribute("data-bad", /./);
  await page.getByTestId("ws-submit").click();
  await expect(ws(page, "scenario")).toHaveAttribute("data-status", "in_review");
  await approveAs(page, bff, "methodist2@tilhero.local", "scenario", "sc-cafe-order");
  await page.evaluate(() => (window.location.hash = "#/content/scenarios/sc-cafe-order"));
  await page.getByTestId("ws-publish").click();
  await confirmWithReason(page, "Сценарий с ожиданием и чаевыми", true);
  await expect(ws(page, "scenario")).toHaveAttribute("data-status", "published");
  expect(bff.content.states("scenario", "sc-cafe-order")).toEqual(["archived", "published"]);
});

test("AT-29 media: rights without UZ → 422 at the field → fix → rights approved (step-up); audio upload checks", async ({ page }) => {
  const bff = await openAs(page, "content@tilhero.local", "#/content/media/m-own-train");
  await expect(ws(page, "media_asset")).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("ma-tts")).toBeVisible();
  // a file over 3 MB is refused before any request; a real mp3 is uploaded as base64
  const big = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(3 * 1024 * 1024)]);
  await page.getByTestId("ma-file").setInputFiles({ name: "scene.mp3", mimeType: "audio/mpeg", buffer: big });
  await expect(page.locator("#ma-upload-err")).toContainText("3 МБ");
  await page.getByTestId("ma-file").setInputFiles({ name: "scene.ogg", mimeType: "audio/ogg", buffer: Buffer.from("ID3 not an ogg") });
  await expect(page.locator("#ma-upload-err")).toContainText("не похоже");
  expect(bff.calls("POST", "/content/blobs")).toHaveLength(0);
  const mp3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0, 0, 0]), Buffer.alloc(2048, 0x55)]);
  await page.getByTestId("ma-file").setInputFiles({ name: "train.mp3", mimeType: "audio/mpeg", buffer: mp3 });
  await expect(page.getByTestId("ma-player")).toBeVisible();
  const up = bff.calls("POST", "/content/blobs")[0]!;
  expect(up.body).toMatchObject({ filename: "train.mp3", content_type: "audio/mpeg", data_base64: mp3.toString("base64") });
  // rights are approved only on a saved version
  await expect(page.getByTestId("ma-approve")).toBeDisabled();
  await page.getByTestId("ws-save").click();
  await expect(page.getByTestId("toasts")).toContainText("Сохранено");
  await page.getByTestId("ma-approve").click();
  await page.locator("#cmd-reason").fill("Своя запись, договор TH-REC-2026-12");
  await page.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("ma-approve-confirm")).toContainText("Права не подтверждены");
  await page.getByTestId("ma-approve-confirm").getByRole("button", { name: "Отмена" }).click();
  await expect(page.getByTestId("err-payload.rights.territories")).toContainText("UZ");
  await expect(page.getByTestId("ma-territories")).toHaveAttribute("aria-invalid", "true");
  await page.getByTestId("ma-territories").fill("KZ, UZ");
  await page.getByTestId("ws-save").click();
  await expect(page.getByTestId("ma-approve")).toBeEnabled();
  await page.getByTestId("ma-approve").click();
  await page.locator("#cmd-reason").fill("Своя запись, территории KZ и UZ, срок год");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("ma-rights-state")).toContainText("Права подтверждены");
  expect(bff.content.vers.media_asset["m-own-train"]![0]!.rights_approved_by).toBeTruthy();
  // the content manager submits; publication is the methodist's (content.publish)
  await page.getByTestId("ws-submit").click();
  await expect(ws(page, "media_asset")).toHaveAttribute("data-status", "in_review");
  await approveAs(page, bff, "methodist@tilhero.local", "media_asset", "m-own-train");
  await page.evaluate(() => (window.location.hash = "#/content/media/m-own-train"));
  await page.getByTestId("ws-publish").click();
  await confirmWithReason(page, "Сценка на вокзале: права подтверждены", true);
  await expect(ws(page, "media_asset")).toHaveAttribute("data-status", "published");
});

test("AT-29 media: expiring and expired rights are visible; external sources stay closed", async ({ page }) => {
  await openAs(page, "content@tilhero.local", "#/content/media");
  await expect(page.getByTestId("rw-m-own-bus-stop")).toContainText("права истекают");
  await expect(page.getByTestId("rw-m-own-old-market")).toContainText("права истекли");
  await page.getByTestId("row-m-own-old-market").click();
  await expect(page.getByTestId("ws-suspended")).toContainText("Права истекли");
  await expect(page.getByTestId("ma-rights-expired")).toBeVisible();
  await page.getByTestId("row-m-own-train").click();
  const origin = page.getByTestId("ma-origin");
  await expect(origin.locator('option[value="licensed"]')).toBeDisabled();
  await expect(origin.locator('option[value="platform_embed"]')).toContainText("после решения владельца и юриста");
});

test("AT-30 request: the link is text only, take → decision with step-up → the learner's status", async ({ page }) => {
  const bff = await openAs(page, "content@tilhero.local", "#/content/requests");
  await expect(page.getByTestId("rq-rules")).toContainText("Ничего не скачиваем");
  await expect(page.getByTestId(`rq-row-${REQ.song}`)).toContainText("+1");
  await page.getByTestId(`rq-open-${REQ.song}`).click();
  const card = page.getByTestId("rq-card");
  await expect(page.getByTestId("rq-link-text")).toHaveText("https://example.com/watch?v=shape-of-you");
  await expect(card.locator("a")).toHaveCount(0);
  await expect(page.getByTestId("rq-no-download")).toBeVisible();
  // opening by hand asks first; nothing is fetched by the admin
  await page.getByTestId("rq-open-manual").click();
  await expect(page.getByTestId("rq-open-confirm")).toContainText("Ничего не скачивайте");
  await page.getByTestId("rq-open-confirm").getByRole("button", { name: "Отмена" }).click();
  await page.getByTestId("rq-take").click();
  await expect(page.getByTestId("rq-card-status")).toContainText("в работе");
  await page.getByTestId("rq-st-authored_alternative").check();
  await page.getByTestId("rq-decide").click();
  await expect(card).toContainText("от 3 до 500");
  await page.getByTestId("rq-note").fill("Сделали похожую сценку про кафе — она уже в медиатеке");
  await page.getByTestId("rq-decide").click();
  await expect(card).toContainText("Выберите опубликованный материал");
  await page.getByTestId("rq-asset").selectOption("m-own-coffee-order");
  await page.getByTestId("rq-decide").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("rq-card-status")).toContainText("подобран авторский аналог");
  await expect(page.getByTestId("rq-decision")).toContainText("m-own-coffee-order");
  const r = bff.content.requests.find((x) => x.request_id === REQ.song)!;
  expect(r).toMatchObject({ status: "authored_alternative", linked_asset_id: "m-own-coffee-order" });
  expect(bff.calls("POST", new RegExp(`/content/media-requests/${REQ.song}/decide`)).at(-1)!.body).toEqual({ status: "authored_alternative", note: "Сделали похожую сценку про кафе — она уже в медиатеке", linked_asset_id: "m-own-coffee-order" });
  expect(bff.audit[0]!.action).toBe("media_request.decided");
});

test("AT-31 languages: a pair that is not ready → PAIR_NOT_READY with the missing parts; another status is saved", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/langs");
  await expect(page.getByTestId("pair-status-ru-en")).toContainText("опубликована");
  await expect(page.getByTestId("pair-ru-uz")).toContainText("скоро");
  await page.getByTestId("pair-edit-ru-uz").click();
  await page.getByTestId("pf-status").selectOption("published");
  await page.getByTestId("pf-reason").fill("Пробуем открыть узбекский");
  await page.getByTestId("pair-save").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("pair-missing")).toBeVisible();
  await expect(page.getByTestId("missing-course")).toContainText("Курс пары");
  await expect(page.getByTestId("missing-diagnostic_test")).toContainText("Тест диагностики");
  await page.getByTestId("pf-status").selectOption("development");
  await page.getByTestId("pair-save").click();
  await expect(page.getByTestId("pair-drawer")).toHaveCount(0);
  await expect(page.getByTestId("pair-status-ru-uz")).toContainText("разработка");
  expect(bff.calls("PUT", "/language-pairs/ru-uz").at(-1)!.body).toMatchObject({ pair_id: "ru-uz", status: "development", reason: "Пробуем открыть узбекский" });
});

test("RBAC: content_manager has no «Опубликовать урок» and no review tab; methodist does not approve rights or decide requests", async ({ page }) => {
  const bff = await openAs(page, "content@tilhero.local", "#/content/lessons/l-03-cafe");
  const ids = await page.locator("[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav")));
  expect(ids).toEqual(expect.arrayContaining(["overview", "content", "langs"]));
  for (const x of ["users", "news", "support", "config", "roles", "audit"]) expect(ids).not.toContain(x);
  await expect(ws(page, "lesson")).toHaveAttribute("data-status", "approved");
  await expect(page.getByTestId("ws-publish")).toHaveCount(0);
  await expect(page.getByTestId("ws-no-publish")).toContainText("content.publish");
  await expect(page.getByTestId("ct-tab-review")).toHaveCount(0);
  // methodist: no rights approval on media, no decision on requests, languages read-only
  await becomes(page, bff, "methodist@tilhero.local", "#/content/media/m-own-train");
  await expect(page.getByTestId("ma-rights-state")).toBeVisible();
  await expect(page.getByTestId("ma-approve")).toHaveCount(0);
  await expect(page.getByTestId("ma-no-rights")).toContainText("media.rights");
  // the learners' requests register is media.rights only: no tab, a link falls back to the lessons
  await expect(page.getByTestId("ct-tab-requests")).toHaveCount(0);
  await page.evaluate((id) => (window.location.hash = `#/content/requests/${id}`), REQ.film);
  await expect(page.getByTestId("ct-tab-lessons")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("rq-card")).toHaveCount(0);
  expect(bff.calls("GET", "/content/media-requests")).toHaveLength(0);
  await page.evaluate(() => (window.location.hash = "#/langs"));
  await expect(page.getByTestId("lg-readonly")).toContainText("lang.manage");
  await expect(page.getByTestId("pair-edit-ru-uz")).toHaveCount(0);
  // a role without content.read does not get the section at all
  await becomes(page, bff, "support@tilhero.local", "#/content");
  await expect(page.getByTestId("page-overview")).toBeVisible();
  expect(bff.calls("POST", /rights-approve|\/publish$|\/decide$/)).toHaveLength(0);
});

test("RBAC: the requests register needs media.rights — auditor and operations see content without it; the overview keeps the count without a link", async ({ page }) => {
  const bff = await openAs(page, "auditor@tilhero.local", "#/content");
  await expect(page.getByTestId("ct-tab-lessons")).toBeVisible();
  await expect(page.getByTestId("ct-tab-media")).toBeVisible();
  await expect(page.getByTestId("ct-tab-requests")).toHaveCount(0);
  await expect(page.getByTestId("ct-tab-review")).toHaveCount(0);
  await page.evaluate(() => (window.location.hash = "#/overview"));
  await expect(page.getByTestId("dct-new-requests")).toContainText("2");
  await expect(page.getByTestId("dct-requests")).toHaveCount(0);
  await expect(page.getByTestId("attention")).toContainText("Новые заявки учеников");
  await expect(page.getByTestId("att-requests")).toHaveCount(0);
  await becomes(page, bff, "ops@tilhero.local", "#/content/requests");
  await expect(page.getByTestId("ct-tab-requests")).toHaveCount(0);
  await expect(page.getByTestId("ct-tab-lessons")).toHaveAttribute("aria-selected", "true");
  expect(bff.calls("GET", "/content/media-requests")).toHaveLength(0);
  // the server refuses the register to content.read alone as well
  const res = await page.evaluate(async () => (await fetch("/admin/v1/content/media-requests")).json());
  expect(res).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "media.rights" } });
  // with media.rights (content manager) — tab and the overview link are there
  await becomes(page, bff, "content@tilhero.local", "#/overview");
  await page.getByTestId("dct-requests").click();
  await expect(page.getByTestId("requests")).toBeVisible();
});

test("overview: content and diagnostics blocks with links; each block has its own «no data»", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/overview");
  await expect(page.getByTestId("block-content")).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("block-diagnostics")).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("dct-in-review")).toContainText("2");
  await expect(page.getByTestId("ddx-finished")).toContainText("39");
  await expect(page.getByTestId("att-rights")).toContainText("1");
  await page.getByTestId("dct-exp-m-own-bus-stop").click();
  await expect(page.getByTestId("ma-rights-expiring")).toContainText("Права истекают");
});

test("overview: catalog down → only the content block says so", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/overview", { dashOff: ["content"] });
  await expect(page.getByTestId("block-content-off")).toContainText("catalog");
  await expect(page.getByTestId("block-diagnostics")).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("block-support")).toHaveAttribute("data-available", "true");
});

test("409 VERSION_CONFLICT offers a reload; 422 CONTENT_INVALID of submit highlights the rubric weights", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/content/rubrics/r-media");
  await expect(page.getByTestId("ru-sum")).toContainText("0,9");
  await page.getByTestId("ws-submit").click();
  await expect(page.getByTestId("ws-issues")).toBeVisible();
  await expect(page.getByTestId("issue-RUBRIC_WEIGHTS")).toBeVisible();
  await expect(page.getByTestId("err-payload.criteria")).toBeVisible();
  await page.getByTestId("ru-balance").click();
  await expect(page.getByTestId("ru-sum")).toContainText("= 1");
  // somebody else saved the draft meanwhile
  bff.content.vers.rubric["r-media"]![0]!.payload_hash = "f".repeat(64);
  await page.getByTestId("ws-save").click();
  await expect(page.getByTestId("ws-conflict")).toBeVisible();
  await page.getByTestId("ws-reload").click();
  await expect(page.getByTestId("ws-conflict")).toHaveCount(0);
  await expect(page.getByTestId("ru-sum")).toContainText("0,9");
});

test("course tree, skills with prerequisites, a new lesson draft", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/content/course");
  await expect(page.getByTestId("tree-m1-meet")).toContainText("Знакомство");
  await expect(page.getByTestId("skill-en.func.order")).toContainText("en.func.greet");
  await expect(page.getByTestId("skill-en.func.greet")).toContainText("нужен для");
  await page.getByTestId("ct-level").getByRole("button", { name: "A1" }).click();
  await expect(page.getByTestId("skill-en.func.greet")).toHaveCount(0);
  await page.getByTestId("tree-lesson-l-03-cafe").click();
  await expect(ws(page, "lesson")).toBeVisible();
  await page.getByTestId("new-lesson").click();
  await page.getByTestId("ws-key").fill("Bad Key");
  await page.getByTestId("ws-save").click();
  await expect(page.getByText(/латиница в нижнем регистре/)).toBeVisible();
  await page.getByTestId("ws-key").fill("l-04-shop");
  await page.getByTestId("le-title-ru").fill("В магазине");
  await page.getByTestId("ws-save").click();
  await expect(page).toHaveURL(/#\/content\/lessons\/l-04-shop$/);
  await expect(ws(page, "lesson")).toHaveAttribute("data-status", "draft");
  expect(bff.calls("POST", "/content/lesson").at(-1)!.headers["idempotency-key"]).toBeTruthy();
});

test("diagnostics: coverage cells, keys for staff, publication of a draft version with step-up", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", "#/content/diagnostics");
  await expect(page.getByTestId("cov-listening-B2")).toContainText("0");
  await expect(page.getByTestId("cov-listening-B2")).toHaveClass(/is-bad/);
  await expect(page.getByTestId("cov-reading-B1")).toHaveClass(/is-warn/);
  await page.getByTestId("cov-reading-B1").getByRole("button").click();
  await expect(page.getByTestId("dx-items").locator("tbody tr")).toHaveCount(1);
  await page.getByTestId("dx-v-dx-en-adult-2").click();
  await page.getByTestId("dx-publish").click();
  await confirmWithReason(page, "Версия 2: аудирование B2", true);
  await expect(page.getByTestId("toasts")).toContainText("dx-en-adult v2 опубликована");
  await expect(page.getByTestId("dx-v-dx-en-adult-2")).toContainText("опубликована");
  expect(bff.content.tests[0]!.published_version).toBe(2);
});

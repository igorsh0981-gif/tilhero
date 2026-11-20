/**
 * Sprint 6 «Герои» (AT-65, AT-71): the catalog of 9 heroes with 3 stage pictures and the number of learners; a stage
 * picture is replaced without a release — upload into the draft (checked by its bytes first), the live ↔ draft
 * comparison, save, publish with step-up and a comment; picking an already uploaded picture; 409 HERO_IN_USE.
 */
import { expect, test } from "@playwright/test";
import { expectNoHScroll, openAs, typeOtp } from "./helpers";
import { NEW_STAGE_PNG } from "./fixtures/game-data";

test("catalog: 9 heroes in three lines, 27 pictures load, the learners of each hero", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/heroes");
  await expect(page.getByTestId("heroes")).toBeVisible();
  for (const line of ["robot", "pet", "human"]) await expect(page.getByTestId(`hr-line-${line}`).locator(".hero-card")).toHaveCount(3);
  await expect(page.locator(".hero-card img")).toHaveCount(27);
  // every picture really decodes (same-origin bytes of admin-bff, CSP img-src 'self')
  await expect.poll(async () => page.locator(".hero-card img").evaluateAll((xs) => xs.filter((x) => (x as HTMLImageElement).complete && (x as HTMLImageElement).naturalWidth > 0).length)).toBe(27);
  await expect(page.getByTestId("hero-robot_0-learners")).toContainText("214");
  await expect(page.getByTestId("hero-pet_0-img-1")).toHaveAttribute("alt", /Дракончик Мятик, ступень 1: Яйцо/);
  await expectNoHScroll(page);
});

test("replace a stage picture: upload → comparison → save draft → publish with step-up; the live picture changes without a release", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/heroes/pet_1");
  await expect(page.getByTestId("hero-card")).toBeVisible();
  await expect(page.getByTestId("hr-publish")).toBeDisabled();
  await expect(page.getByTestId("hr-gate")).toHaveAttribute("data-gate", "no_draft");
  const before = await page.getByTestId("hr-stage-2").getAttribute("data-asset");

  // a renamed file is refused in the browser — nothing is sent
  await page.getByTestId("hr-upload-2").setInputFiles({ name: "stage.png", mimeType: "image/png", buffer: Buffer.from("not a png at all, just text") });
  await expect(page.getByTestId("hr-stage-2")).toContainText("Содержимое файла не похоже на webp или png");
  expect(bff.calls("POST", "/game/assets")).toHaveLength(0);

  await page.getByTestId("hr-upload-2").setInputFiles({ name: "malysh.png", mimeType: "image/png", buffer: NEW_STAGE_PNG() });
  await expect(page.getByTestId("hr-stage-2-changed")).toBeVisible();
  const after = await page.getByTestId("hr-stage-2").getAttribute("data-asset");
  expect(after).not.toBe(before);
  const up = bff.calls("POST", "/game/assets")[0]!;
  expect(up.headers["content-type"]).toBe("image/png");
  await expect.poll(() => page.getByTestId("hr-stage-2-img").evaluate((x) => (x as HTMLImageElement).naturalWidth)).toBe(300);

  // the comparison shows the replaced picture before the save
  await page.getByTestId("hrd-tab-compare").click();
  await expect(page.getByTestId("hr-cmp-stage-2")).toHaveAttribute("data-changed", "true");
  await expect(page.getByTestId("hr-cmp-stage-1")).toHaveAttribute("data-changed", "false");
  await page.getByTestId("hrd-tab-draft").click();

  await page.getByTestId("hr-save").click();
  await expect(page.getByText("Черновик героя сохранён")).toBeVisible();
  const put = bff.calls("PUT", "/game/heroes/pet_1/draft")[0]!;
  expect((put.body as { stages: Array<{ asset_id: string }> }).stages[1]!.asset_id).toBe(after);
  await expect(page.getByTestId("hr-gate")).toHaveAttribute("data-gate", "ok");

  await page.getByTestId("hr-publish").click();
  const dlg = page.getByTestId("hr-publish-dialog");
  await expect(dlg).toContainText("v2");
  await dlg.locator("#cmd-reason").fill("короче");
  await dlg.getByTestId("confirm-ok").click();
  await expect(dlg).toContainText("не короче 10");
  await dlg.locator("#cmd-reason").fill("Иллюстратор прислал новую ступень");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Герой «Дракончик Персик» опубликован · v2")).toBeVisible();
  expect(bff.calls("POST", "/game/heroes/pet_1/publish")).toHaveLength(2); // refused once without step-up, then repeated
  expect(bff.calls("POST", "/game/heroes/pet_1/publish")[1]!.headers["idempotency-key"]).toBe(bff.calls("POST", "/game/heroes/pet_1/publish")[0]!.headers["idempotency-key"]);
  expect(bff.game.audit.map((a) => a.action)).toEqual(["game.asset_uploaded", "game.hero_draft_saved", "game.hero_published"]);

  // the catalog shows the new live picture of stage 2
  await page.getByTestId("drawer-close").click();
  await expect(page.getByTestId("hero-pet_1-img-2")).toHaveAttribute("data-asset", after!);
  await expect(page.getByTestId("hero-pet_1-draft")).toHaveCount(0);
});

test("the three stage uploads have their own names, a visible keyboard focus; an oversized file is refused before reading", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/heroes/pet_1");
  for (const n of [1, 2, 3]) await expect(page.getByLabel(`Загрузить картинку ступени ${n}`, { exact: true })).toHaveAttribute("data-testid", `hr-upload-${n}`);
  // keyboard focus on the hidden file field shows a ring on its visible button
  const field = page.getByTestId("hr-upload-2");
  await page.keyboard.press("Shift");
  await field.focus();
  const ring = await field.evaluate((el) => {
    const label = el.closest(".g-upload")!.querySelector("label")!;
    const cs = getComputedStyle(label);
    return { focused: el.matches(":focus-visible"), style: cs.outlineStyle, width: cs.outlineWidth };
  });
  expect(ring).toEqual({ focused: true, style: "solid", width: "2px" });
  // 301 KB: the size is checked first — a clear text, nothing is sent
  await field.setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.concat([NEW_STAGE_PNG(), Buffer.alloc(301 * 1024)]) });
  await expect(page.getByTestId("hr-stage-2")).toContainText("Файл больше 300 КБ — сожмите картинку");
  expect(bff.calls("POST", "/game/assets")).toHaveLength(0);
});

test("pick an already uploaded picture for a stage; back to the live one", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/heroes/human_2");
  await page.getByTestId("hr-pick-3").click();
  const picker = page.getByTestId("hr-picker");
  await expect(picker.locator(".img-pick-i")).toHaveCount(27);
  await picker.getByTestId("hr-picker-ab000000-0000-4000-8000-000000000021").click();
  await picker.getByTestId("hr-picker-ok").click();
  await expect(page.getByTestId("hr-stage-3")).toHaveAttribute("data-asset", "ab000000-0000-4000-8000-000000000021");
  await expect(page.getByTestId("hr-stage-3-changed")).toBeVisible();
  await page.getByTestId("hr-live-3").click();
  await expect(page.getByTestId("hr-stage-3-changed")).toHaveCount(0);
  await expect(page.getByTestId("hr-save")).toBeDisabled();
  expect(bff.calls("POST", "/game/assets")).toHaveLength(0);
});

test("hiding a chosen hero is allowed (no audiences, a warning); taking him off answers HERO_IN_USE in words", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/heroes/robot_0", { game: { heroInUse: "robot_0" } });
  for (const a of ["kids", "teens", "adults"]) await page.getByTestId(`hr-aud-${a}`).uncheck();
  await expect(page.getByTestId("hr-hidden-note")).toContainText("214");
  await page.getByTestId("hr-save").click();
  await expect(page.getByText("Черновик героя сохранён")).toBeVisible();
  await page.getByTestId("hr-publish").click();
  const dlg = page.getByTestId("hr-publish-dialog");
  await expect(dlg.getByTestId("hr-publish-hidden")).toBeVisible();
  await dlg.locator("#cmd-reason").fill("Убираем из выбора на время перерисовки");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(dlg).toContainText("Этого героя выбрали ученики (214) — снять его нельзя");
});

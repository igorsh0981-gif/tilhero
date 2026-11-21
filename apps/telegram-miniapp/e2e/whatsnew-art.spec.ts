import { expect, test, type Page } from "@playwright/test";
import { S6_HEROES, S6_HEROES_KIDS, UPDATE_1, UPDATE_2, WELCOME } from "./fixtures/data";
import { open, shot } from "./helpers";

/**
 * Release 6.1: the «Что нового» sheet with an illustration — the note s6-heroes (teens and adults) and s6-heroes-kids
 * (a child profile) published at the deploy reach every learner at the next login; the welcome tour carries its own
 * picture. Screenshots → e2e/shots/61_*.png (light, dark, the child profile, a narrow screen).
 */
const RELEASE = [WELCOME, UPDATE_1, UPDATE_2, S6_HEROES, S6_HEROES_KIDS];
const SEEN = [WELCOME.id, UPDATE_1.id, UPDATE_2.id];

async function artBox(page: Page) {
  const sheet = page.locator(".sheet");
  const fig = page.getByTestId("wn-art");
  const [s, f, c] = await Promise.all([sheet.boundingBox(), fig.boundingBox(), page.getByTestId("wn-card").boundingBox()]);
  const pad = await sheet.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft) + parseFloat(getComputedStyle(el).paddingRight));
  return { sheet: s!, fig: f!, card: c!, pad };
}

async function imageLoaded(page: Page) {
  await expect.poll(() => page.getByTestId("wn-art").locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1200);
}

test("existing learner: s6-heroes with the illustration on top of the first card, 16:9, full width, alt = title", async ({ page }) => {
  await open(page, { onboarded: true, notes: RELEASE, seen: SEEN, game: {} });
  const sheet = page.getByTestId("whats-new-updates");
  await expect(sheet).toBeVisible();
  const img = sheet.getByRole("img", { name: "Новое в TilHero: герои, тилы и повторения" });
  await expect(img).toHaveAttribute("src", "/whatsnew/s6-heroes.webp");
  await imageLoaded(page);
  const { sheet: s, fig, card, pad } = await artBox(page);
  expect(Math.abs(fig.width - (s.width - pad))).toBeLessThanOrEqual(1); // the full width of the sheet
  expect(Math.abs(fig.height - (fig.width * 9) / 16)).toBeLessThanOrEqual(1.5); // 16:9
  expect(Math.abs(fig.width - card.width)).toBeLessThanOrEqual(1); // as wide as the card under it
  expect(fig.y + fig.height).toBeLessThanOrEqual(card.y); // on top of the card
  const radius = await page.getByTestId("wn-art").evaluate((el) => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(document.querySelector(".wn-card")!).borderTopLeftRadius]);
  expect(radius[0]).toBe(radius[1]); // the corners of the cards
  await expect(sheet.getByTestId("wn-card")).toContainText("Выберите героя");
  await expect(sheet.getByTestId("wn-card")).toContainText("1 из 6");
  await shot(page, "61_whatsnew_s6_light");
  // the second card of the same note — the picture goes, the texts stay
  await sheet.getByTestId("wn-next").click();
  await expect(sheet.getByTestId("wn-art")).toHaveCount(0);
  await expect(sheet.getByTestId("wn-card")).toContainText("Тилы и задания дня");
  // «Подробнее» on the first card of the next login leads to the heroes
  await page.reload();
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("wn-more").click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("heroes")).toBeVisible();
});

test("no layout shift: the 16:9 box is there before the picture arrives", async ({ page }) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/whatsnew/*.webp", async (route) => {
    await gate;
    await route.continue();
  });
  await open(page, { onboarded: true, notes: RELEASE, seen: SEEN });
  await expect(page.getByTestId("whats-new-updates")).toBeVisible();
  await page.waitForTimeout(400); // the sheet animation is over, the picture is still on its way
  const before = await artBox(page);
  expect(await page.getByTestId("wn-art").locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(0);
  expect(Math.abs(before.fig.height - (before.fig.width * 9) / 16)).toBeLessThanOrEqual(1.5);
  release();
  await imageLoaded(page);
  const after = await artBox(page);
  expect(after.card.y).toBeCloseTo(before.card.y, 0);
  expect(after.fig.height).toBeCloseTo(before.fig.height, 0);
});

test("dark notebook: the same sheet, the picture dimmed a little", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page, { onboarded: true, notes: RELEASE, seen: SEEN });
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
  await expect(page.getByTestId("whats-new-updates")).toBeVisible();
  await imageLoaded(page);
  const filter = await page.getByTestId("wn-art").locator("img").evaluate((img) => getComputedStyle(img).filter);
  expect(filter).toContain("brightness");
  await shot(page, "61_whatsnew_s6_dark");
});

test("child profile: s6-heroes-kids on «ты», without the friend bonus, the voice — with the parent's permission", async ({ page }) => {
  await open(page, { child: true, notes: RELEASE, game: {} });
  const sheet = page.getByTestId("whats-new-updates");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("img", { name: "Новое в TilHero: герои, тилы и повторения" })).toBeVisible();
  await imageLoaded(page);
  await expect(sheet.getByTestId("wn-card")).toContainText("Выбери героя");
  await shot(page, "61_whatsnew_s6_kids");
  const texts: string[] = [];
  for (let i = 0; i < 6; i++) {
    texts.push((await sheet.getByTestId("wn-card").textContent()) ?? "");
    if (i < 5) await sheet.getByTestId("wn-next").click();
  }
  const all = texts.join(" ");
  expect(all).toContain("Заморозка сохранит серию, если пропустишь день.");
  expect(all).toContain("С разрешения родителя");
  expect(all).not.toMatch(/друг|\bвас\b|\bвы\b/i);
});

test("narrow screen 320×568, reduced motion: the picture fits, «Дальше» stays reachable, no animation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, { onboarded: true, notes: RELEASE, seen: SEEN, locale: "uz" });
  const sheet = page.getByTestId("whats-new-updates");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("img", { name: "TilHero’da yangi: qahramonlar, tillar va takrorlash" })).toBeVisible();
  await imageLoaded(page);
  expect(await page.getByTestId("wn-art").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  const { fig } = await artBox(page);
  expect(fig.width).toBeLessThanOrEqual(320);
  expect(fig.height).toBeLessThanOrEqual(568 * 0.26 + 1); // short screens crop the picture instead of growing
  const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // the long Uzbek title wraps inside the card: the pill and the counter stay within it, the text does not run under
  // the dots and the buttons
  const card = (await sheet.getByTestId("wn-card").boundingBox())!;
  for (const el of [sheet.getByTestId("wn-card").locator(".pill"), sheet.getByTestId("wn-card").getByText("6 tadan 1")]) {
    const b = (await el.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
  }
  const text = (await sheet.getByTestId("wn-card").locator("p.sub").boundingBox())!;
  expect(text.y + text.height).toBeLessThanOrEqual(card.y + card.height + 0.5);
  const dots = (await sheet.locator(".dots").boundingBox())!;
  expect(dots.y).toBeGreaterThanOrEqual(card.y + card.height);
  await sheet.getByTestId("wn-next").scrollIntoViewIfNeeded();
  await expect(sheet.getByTestId("wn-next")).toBeInViewport();
  await shot(page, "61_whatsnew_s6_narrow_uz");
});

test("the picture fails to load — the card looks as before; the welcome tour carries its own picture", async ({ page }) => {
  await page.route("**/whatsnew/s6-heroes.webp", (route) => route.fulfill({ status: 404, body: "" }));
  await open(page, { onboarded: true, notes: RELEASE, seen: SEEN });
  const sheet = page.getByTestId("whats-new-updates");
  await expect(sheet.getByTestId("wn-card")).toContainText("Выберите героя");
  await expect(sheet.getByTestId("wn-art")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Закрыть" }).click();

  // a new learner: the welcome tour with the illustration «welcome»
  const tour = await page.context().newPage();
  await open(tour, { onboarded: true, notes: [{ ...WELCOME, illustration: "welcome" }, S6_HEROES], seen: [] });
  const welcome = tour.getByTestId("whats-new-welcome");
  await expect(welcome).toBeVisible();
  await expect(welcome.getByRole("img", { name: "Знакомство" })).toHaveAttribute("src", "/whatsnew/welcome.webp");
  await imageLoaded(tour);
  await shot(tour, "61_whatsnew_welcome");
});

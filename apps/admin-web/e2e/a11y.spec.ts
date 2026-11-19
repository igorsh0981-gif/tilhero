/** Accessibility basics on the key screens: every control is named, focus is visible, keyboard works, no h-scroll. */
import { expect, test, type Page } from "@playwright/test";
import { expectNoHScroll, openAs } from "./helpers";
import { LEARNER } from "./fixtures/data";
import { SID } from "./fixtures/ai-data";

async function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const visible = (el: Element) => (el as HTMLElement).offsetParent !== null || (el as HTMLElement).getClientRects().length > 0;
    for (const el of Array.from(document.querySelectorAll("input:not([type=hidden]),select,textarea,button,[role=tab],[role=menuitem]"))) {
      if (!visible(el)) continue;
      const h = el as HTMLInputElement;
      const name =
        h.getAttribute("aria-label") ||
        (h.getAttribute("aria-labelledby") ?? "")
          .split(" ")
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join("")
          .trim() ||
        (h.labels && Array.from(h.labels).map((l) => l.textContent ?? "").join("").trim()) ||
        (el.tagName === "BUTTON" || el.getAttribute("role") ? (el.textContent ?? "").trim() : "") ||
        h.title;
      if (!name) out.push(`${el.tagName.toLowerCase()}#${el.id}.${(el as HTMLElement).className}`);
    }
    return out;
  });
}

const SCREENS: Array<[string, string]> = [
  ["#/overview", "overview"],
  ["#/users", "learners"],
  [`#/users/${LEARNER.madina}`, "learner-card"],
  ["#/support/TCK-1042", "thread"],
  ["#/news/whatsnew", "wn"],
  ["#/news/templates", "templates"],
  ["#/news/campaigns", "campaigns"],
  ["#/config", "config"],
  ["#/roles", "roles"],
  ["#/audit", "audit"],
  // sprint 3
  ["#/content/course", "course-tab"],
  ["#/content/lessons/l-01-greetings", "ws-lesson"],
  ["#/content/scenarios/sc-cafe-order", "ws-scenario"],
  ["#/content/rubrics/r-media", "ws-rubric"],
  ["#/content/media/m-own-train", "ws-media_asset"],
  ["#/content/exercises/mx-coffee-1", "ws-media_exercise"],
  ["#/content/requests", "requests"],
  ["#/content/review", "review-queue"],
  ["#/content/review/scenario/sc-hotel-checkin", "review-screen"],
  ["#/content/diagnostics", "dx"],
  ["#/langs", "langs"],
  // sprint 4
  ["#/agents", "ag-registry"],
  ["#/agents/models", "ag-models"],
  ["#/agents/independent_evaluator", "ag-version"],
  ["#/qa", "qa-journal"],
  [`#/qa/sessions/${SID.s1}`, "qa-card"],
  [`#/qa/appeals`, "qa-appeals"],
  ["#/costs", "cs-usage"],
];

for (const [hash, id] of SCREENS) {
  test(`every control is named · ${hash}`, async ({ page }) => {
    await openAs(page, "admin@tilhero.local", hash);
    await expect(page.getByTestId(id === "learner-card" ? "learner-card" : id)).toBeVisible();
    await page.waitForTimeout(300);
    expect(await unnamedControls(page)).toEqual([]);
    await expectNoHScroll(page);
  });
}

test("keyboard: Tab reaches the menu with a visible focus ring; Enter opens a section; tabs move with arrows", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/news/whatsnew");
  await page.locator('[data-nav="users"]').focus();
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement;
    const cs = getComputedStyle(a);
    return { nav: a.getAttribute("data-nav"), style: cs.outlineStyle, width: cs.outlineWidth };
  });
  expect(ring.nav).toBe("content");
  expect(ring.style).not.toBe("none");
  expect(parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("content")).toBeVisible();
  // WAI-ARIA tabs: arrows move the selection
  await page.evaluate(() => (window.location.hash = "#/news/whatsnew"));
  await page.getByTestId("news-tab-whatsnew").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("news-tab-templates")).toHaveAttribute("aria-selected", "true");
});

test("dialogs trap focus and close with Escape", async ({ page }) => {
  await openAs(page, "comms@tilhero.local", "#/news/whatsnew");
  await page.getByTestId("wn-publish").click();
  await expect(page.getByTestId("wn-confirm")).toBeVisible();
  await expect(page.locator("#cmd-reason")).toBeFocused();
  for (let n = 0; n < 6; n++) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("[data-dialog]"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("wn-confirm")).toHaveCount(0);
  await expect(page.getByTestId("wn-publish")).toBeFocused();
});

test("sprint 3: the scenario graph is keyboard operable; the EN interface of content has no Russian chrome", async ({ page }) => {
  await openAs(page, "methodist@tilhero.local", "#/content/scenarios/sc-cafe-order");
  const node = page.getByTestId("sg-node-n_menu");
  await expect(node).toHaveAttribute("role", "button");
  await expect(node).toHaveAttribute("aria-label", /n_menu/);
  await node.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("se-node-ed-n_menu")).toBeVisible();
  await expect(node).toHaveAttribute("aria-pressed", "true");
  // tabs of the editor move with arrows
  await page.getByTestId("ws-lang-ru").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("ws-lang-uz")).toHaveAttribute("aria-selected", "true");
  // EN: labels, tabs, buttons and headings come from the EN dictionary (learner data stays as entered)
  await page.getByTestId("lang-en").click();
  await expect(page.getByTestId("ct-tab-lessons")).toHaveText(/Lessons/);
  const chrome = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[role=tab], .ws-acts button, .ed-sec-h h3, .field-label, .field-top > label, th, .stepper li"))
      .map((e) => e.innerText.trim())
      .filter((s) => /[Ѐ-ӿ]/.test(s)),
  );
  expect(chrome).toEqual([]);
});

test("sprint 4: EN chrome of agents, dialogue QA and costs has no Russian; the stop switch is a named switch", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/agents/independent_evaluator");
  await page.getByTestId("lang-en").click();
  await expect(page.getByTestId("agc-tab-version")).toHaveText(/Version/);
  const chrome = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[role=tab], .acts button, label, th, .h2, .h3, .panel-t, .kv > span:first-child, .pill"))
        .filter((e) => !e.closest('[lang="ru"]')) // learner-facing content (titles of lessons and agents) is data, marked lang=ru
        .map((e) => e.innerText.trim())
        .filter((x) => /[Ѐ-ӿ]/.test(x)),
    );
  expect(await chrome()).toEqual([]);
  await page.evaluate((id) => (window.location.hash = `#/qa/sessions/${id}`), SID.s2);
  await expect(page.getByTestId("qa-card")).toBeVisible();
  expect(await chrome()).toEqual([]);
  await page.evaluate(() => (window.location.hash = "#/costs"));
  await expect(page.getByTestId("cs-stop-btn")).toHaveAttribute("role", "switch");
  await expect(page.getByTestId("cs-stop-btn")).toHaveAccessibleName(/switch the AI off/i);
  expect(await chrome()).toEqual([]);
});

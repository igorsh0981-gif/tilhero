/** Accessibility basics on the key screens: every control is named, focus is visible, keyboard works, no h-scroll. */
import { expect, test, type Page } from "@playwright/test";
import { expectNoHScroll, openAs } from "./helpers";
import { LEARNER } from "./fixtures/data";

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
  await expect(page.getByTestId("soon")).toBeVisible();
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

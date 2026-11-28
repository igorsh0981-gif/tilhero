/**
 * QA D2-02: the shell on laptop screens. Playwright scrolls to an element by itself, so ordinary clicks never notice
 * a cut-off menu — these tests measure the boxes instead: at 1440×900 and 1280×720 all 16 sections of super_admin and
 * the footer are inside the window with no scrolling of the panel and nothing covered by the footer; on a shorter
 * window the panel scrolls inside, the footer stays pinned. KPI notes («… детских профилей N») wrap instead of being
 * cut. Screenshots: SHOTS_DIR (default /tmp/admin-shots).
 */
import { expect, test, type Page } from "@playwright/test";
import { openAs, shot } from "./helpers";

interface NavMetrics {
  items: Array<{ id: string; top: number; bottom: number; hit: boolean }>;
  scroll: { top: number; bottom: number; scrollHeight: number; clientHeight: number; overflowY: string };
  foot: { top: number; bottom: number };
  vh: number;
}

async function navMetrics(page: Page): Promise<NavMetrics> {
  return page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>(".sn-scroll")!;
    const ft = document.querySelector<HTMLElement>(".sn-foot")!;
    const s = sc.getBoundingClientRect();
    const f = ft.getBoundingClientRect();
    const items = [...sc.querySelectorAll<HTMLElement>("[data-nav]")].map((el) => {
      const r = el.getBoundingClientRect();
      // what the user actually sees at the item's centre (not covered by the footer, not outside the window)
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { id: el.dataset.nav!, top: r.top, bottom: r.bottom, hit: !!at && el.contains(at) };
    });
    return {
      items,
      scroll: { top: s.top, bottom: s.bottom, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, overflowY: getComputedStyle(sc).overflowY },
      foot: { top: f.top, bottom: f.bottom },
      vh: window.innerHeight,
    };
  });
}

for (const vp of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`shell ${vp.width}×${vp.height}: 26 sections (sprint 8: + «Деньги») and the footer — without scrolling at 1440×900, the menu panel scrolls at 1280×720; KPI notes are not cut`, async ({ page }) => {
    await page.setViewportSize(vp);
    await openAs(page, "admin@tilhero.local", "#/overview");
    await expect(page.getByTestId("block-learners")).toBeVisible();
    await shot(page, `d2-02-shell-${vp.width}x${vp.height}`);

    await expectAllVisible(page);
    await expect(page.getByTestId("kpis")).toContainText(/детских профилей \d+/);
    // EN labels are longer in places — the same holds
    await page.getByTestId("lang-en").click();
    await expect(page.getByTestId("kpis")).toContainText(/child profiles \d+/);
    await expectAllVisible(page);
    await shot(page, `d2-02-shell-${vp.width}x${vp.height}-en`);
  });
}

async function expectAllVisible(page: Page): Promise<void> {
  const m = await navMetrics(page);
  expect(m.items.map((i) => i.id)).toHaveLength(26);
  // WCAG 2.5.8: even the densest rows stay ≥ 24 px high
  for (const it of m.items) expect(it.bottom - it.top, `${it.id} height`).toBeGreaterThanOrEqual(24);
  if (m.vh >= 780) {
    // sprint 8: 26 sections still fit 1440×900 without scrolling
    expect(m.scroll.scrollHeight, "the menu panel needs no scrolling").toBeLessThanOrEqual(m.scroll.clientHeight + 1);
    for (const it of m.items) {
      expect(it.top, `${it.id} top`).toBeGreaterThanOrEqual(m.scroll.top - 0.5);
      expect(it.bottom, `${it.id} is above the footer`).toBeLessThanOrEqual(Math.min(m.scroll.bottom, m.foot.top) + 0.5);
      expect(it.hit, `${it.id} is not covered`).toBe(true);
    }
  } else {
    // 1280×720: 26 rows of 24 px, 7 group labels, the head and the footer do not fit — the panel scrolls inside
    // (as at 1280×600), the targets keep their size; the last section is reached by scrolling, the footer stays
    expect(m.scroll.overflowY).toBe("auto");
    expect(m.scroll.bottom).toBeLessThanOrEqual(m.foot.top + 0.5);
    await page.locator(".sn-scroll").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const after = await navMetrics(page);
    expect(after.items.at(-1)!.hit, `${after.items.at(-1)!.id} is reachable`).toBe(true);
    expect(after.foot.top).toBeCloseTo(m.foot.top, 0);
    await page.locator(".sn-scroll").evaluate((el) => el.scrollTo(0, 0));
  }
  expect(m.foot.bottom, "footer inside the window").toBeLessThanOrEqual(m.vh + 0.5);
  await expect(page.getByTestId("env-chip")).toBeInViewport({ ratio: 1 });

  // KPI notes and labels wrap — nothing is clipped (the number of child profiles is readable)
  const kpis = await page.locator(".kpi-n, .kpi-l").evaluateAll((els) =>
    els.map((el) => ({ text: el.textContent ?? "", cut: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 })),
  );
  expect(kpis.length).toBeGreaterThanOrEqual(10);
  for (const k of kpis) expect(k.cut, `KPI text cut: «${k.text}»`).toBe(false);
}

test("shell 1280×600: the menu scrolls inside the panel, the footer stays pinned, the last section is reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await openAs(page, "admin@tilhero.local", "#/overview");
  const m = await navMetrics(page);
  expect(m.scroll.overflowY).toBe("auto");
  expect(m.foot.bottom).toBeLessThanOrEqual(m.vh + 0.5);
  expect(m.scroll.bottom).toBeLessThanOrEqual(m.foot.top + 0.5);
  await shot(page, "d2-02-shell-1280x600");
  // the page itself does not scroll the panel away: scrolling the panel reveals «Аудит», the footer does not move
  await page.locator(".sn-scroll").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const after = await navMetrics(page);
  const audit = after.items.find((i) => i.id === "audit")!;
  expect(audit.hit).toBe(true);
  expect(after.foot.top).toBeCloseTo(m.foot.top, 0);
});

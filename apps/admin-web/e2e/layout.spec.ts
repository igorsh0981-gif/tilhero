import { expect, test } from "@playwright/test";
import { CYRILLIC, expectNoHScroll, openAs, shot } from "./helpers";

const PAGES = ["dashboard", "users", "support", "review", "sources", "discovery", "travel", "config", "audit", "roles"] as const;

test.describe("width 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("no horizontal scroll on every section; dashboard light and dark", async ({ page }) => {
    await openAs(page, "admin@tilhero.local");
    for (const p of PAGES) {
      await page.locator(`[data-nav="${p}"]`).click();
      await expect(page.getByTestId(`page-${p}`)).toBeVisible();
      await page.waitForTimeout(300);
      await expectNoHScroll(page);
    }
    await page.locator('[data-nav="dashboard"]').click();
    await expect(page.getByTestId("dash-system")).toBeVisible();
    await shot(page, "02-dashboard-light");
    await page.getByTestId("theme-btn").click();
    await page.getByTestId("theme-dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await shot(page, "02-dashboard-dark");
    await page.goto("/#/support/TCK-3081");
    await expect(page.getByTestId("thread")).toBeVisible();
    await shot(page, "06c-support-thread-dark");
  });
});

test.describe("width 400", () => {
  test.use({ viewport: { width: 400, height: 860 }, hasTouch: true });
  test("no horizontal scroll; navigation is a drawer; thread switches conversation/context", async ({ page }) => {
    await openAs(page, "admin@tilhero.local");
    for (const p of PAGES) {
      await page.getByTestId("burger").click();
      await expect(page.getByTestId("shell")).toHaveClass(/is-nav-open/);
      await page.locator(`[data-nav="${p}"]`).click();
      await expect(page.getByTestId(`page-${p}`)).toBeVisible();
      await page.waitForTimeout(300);
      await expectNoHScroll(page);
      if (p === "dashboard") await shot(page, "w400-dashboard");
      if (p === "users") await shot(page, "w400-users");
    }
    await page.getByTestId("burger").click();
    await shot(page, "w400-nav-drawer");
    await page.locator('[data-nav="support"]').click();
    await page.locator('[data-ticket="TCK-3081"]').click();
    await expect(page.getByTestId("thread")).toBeVisible();
    await expectNoHScroll(page);
    await shot(page, "w400-support-thread");
    await page.getByTestId("thread-mtab").getByRole("button", { name: "Контекст" }).click();
    await expect(page.getByTestId("ticket-controls")).toBeVisible();
    await expectNoHScroll(page);
    await shot(page, "w400-support-context");
  });

  test("sign-in at 400 px", async ({ page }) => {
    await page.route("**/admin/v1/**", (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "UNAUTHORIZED", message: "", trace_id: "t", details: {} }) }));
    await page.goto("/");
    await expect(page.getByTestId("login-creds")).toBeVisible();
    await expectNoHScroll(page);
    await shot(page, "w400-login");
  });
});

test("EN: switching the language leaves no Cyrillic in the interface (except staff names from data)", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/support");
  await page.getByTestId("lang-en").click();
  for (const p of ["dashboard", "support", "config", "audit"] as const) {
    await page.locator(`[data-nav="${p}"]`).click();
    await expect(page.getByTestId(`page-${p}`)).toBeVisible();
    await page.waitForTimeout(300);
    // user data (ticket subjects, staff names, notes) is not translated — strip known data nodes
    const text = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".cell-main, .cell-sub, .subj, .wrap-any, .small, .msg, td, .ver-card, .avatar").forEach((n) => n.remove());
      clone.querySelectorAll("select").forEach((n) => n.remove());
      return clone.innerText;
    });
    expect(text, `${p}: ${text.match(/.{0,30}[Ѐ-ӿ]+.{0,30}/)?.[0]}`).not.toMatch(CYRILLIC);
  }
  await page.locator('[data-nav="dashboard"]').click();
  await shot(page, "en-dashboard");
});

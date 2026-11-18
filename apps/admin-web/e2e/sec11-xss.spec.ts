import { expect, test, type Page } from "@playwright/test";
import { openAs } from "./helpers";
import { expectInert, poison, watchDialogs } from "./xss";

/* Sprint 9, SEC-11: every admin-bff answer carries hostile strings (catalogue candidates, news, DLQ with the masked
   envelope, tickets and messages, alerts, users) — React must render them as text: no script, no markup from data,
   no javascript: link. Mock admin-bff only. */

const R3 = "7e000000-0000-4000-8000-000000000003";
const sc = { transform: (_path: string, data: unknown) => poison(data) };
/* feeds: the editor's own fields (name, entities, feed/page URL) are hostile too */
const feeds = { transform: (_path: string, data: unknown) => poison(data, { text: /^(name|entities)$/, link: /^(feed_url|page_url)$/ }) };

async function visit(page: Page, email: string, hash: string, scenario = sc): Promise<string[]> {
  const dialogs = watchDialogs(page);
  await openAs(page, email, hash, scenario);
  await expect(page.locator("main")).toContainText("__xss");
  return dialogs;
}

test.describe("SEC-11 admin-web", () => {
  test("catalogue review: list and candidate detail", async ({ page }) => {
    let d = await visit(page, "admin@tilhero.local", "#/review");
    await expectInert(page, d, "review list");
    await page.goto("about:blank");
    d = await visit(page, "admin@tilhero.local", `#/review/${R3}`);
    await expectInert(page, d, "review detail");
  });

  test("news and feeds", async ({ page }) => {
    let d = await visit(page, "ops@tilhero.local", "#/news");
    await expectInert(page, d, "news");
    await page.goto("about:blank");
    d = await visit(page, "ops@tilhero.local", "#/feeds", feeds);
    await expectInert(page, d, "feeds");
  });

  test("DLQ: list and masked envelope", async ({ page }) => {
    const d = await visit(page, "ops@tilhero.local", "#/monitoring/dlq");
    await expectInert(page, d, "dlq list");
    await page.getByTestId("dlq-row").first().click();
    await expect(page.getByRole("dialog").or(page.locator("[data-testid$='drawer']")).first()).toBeVisible();
    await expectInert(page, d, "dlq detail");
  });

  test("support: queue and ticket thread", async ({ page }) => {
    let d = await visit(page, "support@tilhero.local", "#/support");
    await expectInert(page, d, "support queue");
    await page.goto("about:blank");
    d = await visit(page, "support@tilhero.local", "#/support/TCK-3081");
    await expectInert(page, d, "ticket");
  });

  test("alerts and users", async ({ page }) => {
    let d = await visit(page, "ops@tilhero.local", "#/monitoring/alerts");
    await expectInert(page, d, "alerts");
    await page.goto("about:blank");
    d = await visit(page, "admin@tilhero.local", "#/users");
    await expectInert(page, d, "users");
  });
});

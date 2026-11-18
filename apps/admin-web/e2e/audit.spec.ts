import { expect, test } from "@playwright/test";
import { openAs, shot } from "./helpers";

test("audit: journal, exact action filter, record detail JSON with secrets redacted, chain verification", async ({ page }) => {
  const bff = await openAs(page, "audit@tilhero.local", "#/audit");
  const rows = page.locator("[data-action]");
  await expect(rows).toHaveCount(20);
  await page.getByTestId("aud-more").click();
  await expect(rows).toHaveCount(24);
  await shot(page, "12-audit");

  await page.getByTestId("aud-action").fill("staff.created");
  await expect(rows).toHaveCount(3);
  expect(bff.calls("GET", "/audit/records").at(-1)!.headers).toBeTruthy();
  await rows.first().click();
  const json = page.getByTestId("audit-json");
  await expect(json).toContainText("staff.created");
  // a leaked secret in a record is never rendered
  await expect(json).not.toContainText("never-shown");
  await expect(json).toContainText("redacted");
  await shot(page, "12b-audit-record");
  await page.getByTestId("drawer-close").click();

  await page.getByTestId("aud-verify").click();
  await expect(page.getByTestId("aud-chain")).toContainText("Цепочка цела: 24");
});

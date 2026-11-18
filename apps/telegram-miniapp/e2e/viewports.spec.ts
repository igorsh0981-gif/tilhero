import { expect, test } from "@playwright/test";
import { expectNoVerticalScroll, open } from "./helpers";

/** AT-04 on three viewports (CONVENTIONS §7): every onboarding step fits without scrolling, the action is visible. */
const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "375x812", width: 375, height: 812 },
  { name: "412x915", width: 412, height: 915 },
] as const;

async function fits(page: import("@playwright/test").Page, h: number) {
  await expectNoVerticalScroll(page);
  const box = await page.getByTestId("ob-next").boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(h + 0.5);
}

for (const vp of VIEWPORTS) {
  test(`teen path (the tallest consent step) @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize(vp);
    await open(page);
    const next = page.getByTestId("ob-next");
    await fits(page, vp.height);
    await next.click();
    await page.getByTestId("who-self").click();
    await page.getByRole("button", { name: "от 14 до 17 лет" }).click();
    await fits(page, vp.height);
    await next.click();
    await expect(page.getByTestId("ob-step-teen")).toBeVisible();
    await fits(page, vp.height);
    await next.click();
    await expect(page.getByTestId("ob-step-consent")).toBeVisible();
    await expect(page.getByTestId("consent-terms")).toBeVisible();
    await fits(page, vp.height);
    for (const c of ["terms", "privacy", "learning"]) await page.getByTestId(`consent-${c}`).check();
    await next.click();
    await page.getByRole("button", { name: "Общение каждый день" }).click();
    await fits(page, vp.height);
    await next.click();
    await page.getByTestId("level-confident").click();
    await fits(page, vp.height);
    await next.click();
    await page.getByTestId("preset-custom").click();
    await page.getByTestId("time-choice").getByRole("button", { name: "Своё" }).click();
    await fits(page, vp.height);
    await next.click();
    await page.getByTestId("reminders").check();
    await page.getByTestId("missed").check();
    await fits(page, vp.height);
    await next.click();
    await expect(page.getByTestId("ob-done")).toBeVisible();
    await expectNoVerticalScroll(page);
  });

  test(`child path @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize(vp);
    await open(page);
    const next = page.getByTestId("ob-next");
    await next.click();
    await page.getByTestId("who-child").click();
    await page.getByRole("button", { name: "от 10 до 13 лет" }).click();
    await fits(page, vp.height);
    await next.click();
    await page.getByTestId("child-name").fill("Мадина");
    await page.getByTestId("child-adult").check();
    await fits(page, vp.height);
  });
}

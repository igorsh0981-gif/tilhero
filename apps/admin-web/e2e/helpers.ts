import { expect, type Page } from "@playwright/test";
import { MockBff, type Scenario } from "./fixtures/mock-bff";
import { PASSWORD, TOTP } from "./fixtures/data";

/** Screenshots of key screens: SHOTS_DIR (default /tmp/admin-shots — not committed). */
export const SHOTS = process.env.SHOTS_DIR ?? "/tmp/admin-shots";
export const CYRILLIC = /[Ѐ-ӿ]/;

export async function open(page: Page, scenario: Scenario = {}, hash = ""): Promise<MockBff> {
  const bff = new MockBff(scenario);
  await bff.install(page);
  await page.goto(`/${hash}`);
  return bff;
}

/** Signed-in shell of `email` (cookie session already exists) on `hash`. */
export async function openAs(page: Page, email: string, hash = "", sc: Scenario = {}): Promise<MockBff> {
  const bff = await open(page, { ...sc, signedInAs: email }, hash);
  await expect(page.getByTestId("shell")).toBeVisible();
  return bff;
}

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.locator("#login-email").fill(email);
  await page.locator("#login-pass").fill(password);
  await page.getByTestId("login-submit").click();
}

/** Types a 6-digit code into the OTP cells (paste into the first cell spreads it). */
export async function typeOtp(page: Page, idPrefix = "otp", code = TOTP): Promise<void> {
  await page.locator(`#${idPrefix}-0`).focus();
  await page.keyboard.type(code);
}

export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(250);
}

export async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}

/** No horizontal scroll of the document (tables scroll inside .table-wrap). */
export async function expectNoHScroll(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
  expect(m.sw, `scrollWidth ${m.sw} > clientWidth ${m.cw}`).toBeLessThanOrEqual(m.cw + 1);
  expect(m.bw, `body scrollWidth ${m.bw} > clientWidth ${m.cw}`).toBeLessThanOrEqual(m.cw + 1);
}

export async function nav(page: Page, id: string): Promise<void> {
  const burger = page.getByTestId("burger");
  if (await burger.isVisible()) await burger.click();
  await page.locator(`[data-nav="${id}"]`).click();
  await expect(page.getByTestId(`page-${id}`)).toBeVisible();
}

export async function setTheme(page: Page, mode: "light" | "dark"): Promise<void> {
  await page.getByTestId("theme-btn").click();
  await page.getByTestId(`theme-${mode}`).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
}

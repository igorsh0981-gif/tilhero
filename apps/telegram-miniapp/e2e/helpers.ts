import { expect, type Page } from "@playwright/test";
import { MockBff, type Scenario } from "./fixtures/mock-bff";

/** The target viewport of the prototype (AT-04: every onboarding step without scrolling at 390×844). */
export const PHONE = { width: 390, height: 844 };
export const SHOTS = "e2e/shots";

export async function open(page: Page, scenario: Scenario = {}, query = ""): Promise<MockBff> {
  const bff = new MockBff(scenario);
  await bff.install(page);
  await page.goto(`/${query}`);
  return bff;
}

/** No vertical scroll: neither the onboarding frame body, the app, nor the document scrolls. */
export async function expectNoVerticalScroll(page: Page): Promise<void> {
  const m = await page.evaluate(() => {
    const pick = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      return el ? [el.scrollHeight, el.clientHeight] : [0, 0];
    };
    const doc = document.scrollingElement!;
    return { body: pick(".ob-body"), ob: pick(".ob"), app: pick(".app"), doc: [doc.scrollHeight, doc.clientHeight] };
  });
  for (const [name, [sh, ch]] of Object.entries(m) as Array<[string, number[]]>) {
    expect(sh!, `${name}: scrollHeight ${sh} > clientHeight ${ch}`).toBeLessThanOrEqual(ch! + 1);
  }
}

/** The primary action of the step is fully inside the window. */
export async function expectNextVisible(page: Page): Promise<void> {
  const box = await page.getByTestId("ob-next").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height + 0.5);
}

export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(300);
}

export async function shot(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

export const CYRILLIC = /[Ѐ-ӿ]/;

/** Quick onboarding of a new adult (who → 18+ → consents → goal → level → schedule as is → done → home). */
export async function onboardAdult(page: Page): Promise<void> {
  const next = page.getByTestId("ob-next");
  await page.getByTestId("ob-step-lang").waitFor();
  await next.click();
  await page.getByTestId("who-self").click();
  await page.getByRole("button", { name: "18 лет и старше" }).click();
  await next.click();
  for (const c of ["terms", "privacy", "learning"]) await page.getByTestId(`consent-${c}`).check();
  await next.click();
  await page.getByRole("button", { name: "Работа" }).click();
  await next.click();
  await page.getByTestId("level-some").click();
  await next.click();
  await page.getByTestId("ob-step-when").waitFor();
  await next.click();
  await page.getByTestId("ob-step-minutes").waitFor();
  await next.click();
  await page.getByTestId("ob-open-home").click();
}

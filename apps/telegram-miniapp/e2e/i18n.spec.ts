import { expect, test } from "@playwright/test";
import { CYRILLIC, expectNoVerticalScroll, open, shot } from "./helpers";

/** AT-05: RU / UZ switches the interface and never the course pair; UZ is Latin only. */
test("Oʻzbekcha on the first screen: the whole onboarding in Latin, the course stays ru → en", async ({ page }) => {
  const bff = await open(page);
  await page.getByTestId("lang").getByRole("button", { name: "Oʻzbekcha" }).click();
  await expect(page.getByRole("heading", { name: "AI-murabbiy bilan ingliz tilida gaplashing" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "uz");
  await page.getByTestId("ob-next").click();
  await expect(page.getByRole("heading", { name: "Kim shugʻullanadi?" })).toBeVisible();
  expect(bff.last("PATCH", "/v1/profile/settings")?.body).toEqual({ locale: "uz" });
  expect(bff.last("PATCH", "/v1/plan")?.body).toEqual({ ui_lang: "uz" });
  expect(bff.plan().course_pair).toBe("ru-en");
  const text = await page.locator(".app").innerText();
  expect(CYRILLIC.test(text), text).toBe(false);
  await page.getByTestId("who-self").click();
  await page.getByRole("button", { name: "18 yosh va undan katta" }).click();
  await page.getByTestId("ob-next").click();
  await expect(page.getByRole("heading", { name: "Roziliklar" })).toBeVisible();
  await expect(page.getByText("Foydalanish shartlari")).toBeVisible();
  await expectNoVerticalScroll(page);
  // the only Cyrillic left is the name of the Russian language itself in the picker
  expect(CYRILLIC.test((await page.locator(".app").innerText()).replace("Русский", ""))).toBe(false);
});

test("language in the profile: RU → UZ keeps the course, the dark notebook follows the device", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const bff = await open(page, { onboarded: true, seen: ["11111111-aaaa-4bbb-8ccc-000000000001", "11111111-aaaa-4bbb-8ccc-000000000002", "11111111-aaaa-4bbb-8ccc-000000000003"] });
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
  // the remote light palette (theme notebook) must not override the dark notebook
  const paper = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim());
  expect(paper.toUpperCase()).toBe("#11152B");
  await shot(page, "13_home_dark");
  await page.getByTestId("tab-profile").click();
  await page.getByTestId("row-lang").click();
  await page.getByTestId("lang-uz").click();
  await expect(page.getByRole("heading", { name: "Interfeys tili" })).toBeVisible();
  await expect(page.getByTestId("course-pair")).toContainText("Rus tili → Ingliz tili");
  expect(bff.plan().course_pair).toBe("ru-en");
  // интерфейс переключается сразу, а PATCH плана и профиля доходят до мока BFF чуть позже (в CI тест падал на гонке)
  await expect.poll(() => bff.plan().ui_lang).toBe("uz");
  await expect.poll(() => bff.account.locale).toBe("uz");
  // the only Cyrillic left is the name of the Russian language itself in the picker
  expect(CYRILLIC.test((await page.locator(".app").innerText()).replace("Русский", ""))).toBe(false);
});

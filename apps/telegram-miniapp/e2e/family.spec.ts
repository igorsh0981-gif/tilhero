import { expect, test } from "@playwright/test";
import { expectNoVerticalScroll, open, shot } from "./helpers";

/** AT-03: 6–13 — only a child profile on the parent's account; 14–17 — a link for the parent, optional features off. */
test("parent creates a child profile in onboarding; the child's plan, then back to the parent with the code", async ({ page }) => {
  const bff = await open(page, { pin: "2580" });
  const next = page.getByTestId("ob-next");
  await next.click();
  await page.getByTestId("who-child").click();
  await page.getByRole("button", { name: "от 6 до 9 лет" }).click();
  await next.click();
  await expect(page.getByTestId("ob-step-child")).toBeVisible();
  await page.getByTestId("child-name").fill("Мадина");
  await expect(next).toBeDisabled();
  await page.getByTestId("child-adult").check();
  await expectNoVerticalScroll(page);
  await shot(page, "11_child_profile");
  await next.click();
  await expect.poll(() => bff.account.age_band).toBe("18+");
  for (const c of ["terms", "privacy", "learning"]) await page.getByTestId(`consent-${c}`).check();
  await expect(page.getByText("Вы даёте согласие и за ребёнка.")).toBeVisible();
  await next.click();
  // the child is created and becomes the active learner
  await expect(page.getByRole("heading", { name: "Для чего ребёнку английский?" })).toBeVisible();
  expect(bff.last("POST", "/v1/learners")?.body).toEqual({ display_name: "Мадина", age_band: "6-9" });
  expect(bff.learner().kind).toBe("child");
  await expect(page.getByTestId("bar-back")).toHaveCount(0); // consents are behind
  await page.getByRole("button", { name: "Путешествия" }).click();
  await next.click();
  await page.getByTestId("level-zero").click();
  await next.click();
  await page.getByTestId("preset-three_per_week").click();
  await next.click();
  await expect(page.getByText("Напоминания придут вам, родителю, не позже 20:00")).toBeVisible();
  await next.click();
  await expect(page.getByRole("heading", { name: "Готово! План для Мадина составлен" })).toBeVisible();
  await page.getByTestId("ob-open-home").click();
  await page.getByTestId("whats-new-welcome").getByRole("button", { name: "Закрыть" }).click();
  await expect(page.getByText("Детский профиль: Мадина.")).toBeVisible();
  await expect(page.getByTestId("family-card")).toHaveCount(0);

  // back to the parent: the parent code
  await page.getByTestId("tab-profile").click();
  await expect(page.getByTestId("row-family")).toHaveCount(0);
  await page.getByTestId("to-parent").click();
  const pin = page.getByTestId("pin-sheet");
  await expect(pin).toBeVisible();
  for (const d of "2580") await pin.getByRole("button", { name: d, exact: true }).click();
  await expect(pin).toBeHidden();
  expect(bff.last("POST", "/v1/session/learner")?.body).toEqual({ learner_id: bff.learners[0]!.learner_id, pin: "2580" });
  // the parent has not finished their own plan yet → the short onboarding (goal…)
  await expect(page.getByTestId("ob-step-goal")).toBeVisible();
});

test("teen 14–17: a link for the parent, optional purposes locked until consent", async ({ page }) => {
  const bff = await open(page);
  const next = page.getByTestId("ob-next");
  await next.click();
  await page.getByTestId("who-self").click();
  await page.getByRole("button", { name: "от 14 до 17 лет" }).click();
  await next.click();
  await expect(page.getByTestId("ob-step-teen")).toBeVisible();
  const popup = page.waitForEvent("popup");
  await page.getByTestId("teen-send").click();
  const share = await popup;
  await share.waitForURL(/t\.me/);
  expect(share.url()).toContain("startapp%3Dgc_");
  await share.close();
  await expect(page.getByTestId("teen-link")).toBeVisible();
  await expectNoVerticalScroll(page);
  await next.click();
  await expect(page.getByTestId("consent-voice_recording")).toBeDisabled();
  await expect(page.getByText("после согласия родителя").first()).toBeVisible();
  for (const c of ["terms", "privacy", "learning"]) await page.getByTestId(`consent-${c}`).check();
  await next.click();
  expect(bff.last("POST", "/v1/profile/consent")?.body).toEqual({ policy_version: "1.2", purposes: ["terms", "privacy", "learning"] });
  await expect(page.getByTestId("ob-step-goal")).toBeVisible();
});

test("parent opens gc_<token>: confirms 18+ and gives consent", async ({ page }) => {
  const TOKEN = "GcTok0123456789abcdefghijklmnopqrstuvwxyzAB";
  const bff = await open(page, { guardianLinks: { [TOKEN]: { teen: "Тимур", status: "pending" } } }, `?startapp=gc_${TOKEN}`);
  const sheet = page.getByTestId("guardian-sheet");
  await expect(sheet).toContainText("Тимур хочет заниматься в TilHero");
  await expect(sheet.getByTestId("gc-accept")).toBeDisabled();
  await sheet.getByTestId("gc-adult").check();
  await shot(page, "12_guardian_consent");
  await sheet.getByTestId("gc-accept").click();
  await expect(sheet.getByTestId("gc-status")).toHaveText("Согласие для Тимур дано.");
  expect(bff.account.age_band).toBe("18+");
  expect(bff.calls("POST", `/v1/guardian-consents/${TOKEN}/accept`)).toHaveLength(1);
});

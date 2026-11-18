/** AT-23: learner registry and card; the Telegram ID is revealed with a reason, step-up and a 60-second timer. */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { LEARNER, TOTP } from "./fixtures/data";

test("filters, card with children, reveal with a reason + TOTP, hidden after 60 s", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/users");
  await expect(page.getByTestId("learners-table")).toBeVisible();
  await page.getByTestId("lr-kind").selectOption("child");
  await expect(page.locator("[data-learner]")).toHaveCount(2);
  expect(bff.calls("GET", "/learners").at(-1)!.headers).toBeTruthy();
  await page.getByTestId("lr-kind").selectOption("");
  await page.getByTestId("lr-q").fill("@botir");
  await expect(page.locator("[data-learner]")).toHaveCount(1);
  await page.getByTestId(`lr-open-${LEARNER.botir}`).click();

  const card = page.getByTestId("learner-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("lc-children")).toContainText("Лола");
  await expect(page.getByTestId("card-tg-masked")).toHaveText("••••••932");
  // nothing but the mask until the reveal
  await expect(card).not.toContainText("6011280932");

  await page.getByTestId("reveal-start").click();
  await page.getByTestId("reveal-reason").fill("abc");
  await page.getByTestId("reveal-confirm").click();
  await expect(page.locator("#rv-err")).toBeVisible();
  expect(bff.calls("POST", /\/reveal$/)).toHaveLength(0);

  await page.clock.install();
  await page.getByTestId("reveal-reason").fill("TCK-1043 — напоминания приходят поздно, сверяем аккаунт");
  await page.getByTestId("reveal-confirm").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("reveal-value")).toHaveText("6011280932");
  await expect(page.getByTestId("reveal-countdown")).toHaveText(/01:00|00:5\d/);
  const reveal = bff.calls("POST", `/learners/${LEARNER.botir}/reveal`).at(-1)!;
  expect(reveal.body).toMatchObject({ field: "telegram_user_id" });
  expect(String((reveal.body as { reason: string }).reason)).toContain("TCK-1043");
  expect(bff.audit[0]!.action).toBe("sensitive.view");

  await page.clock.runFor(61_000);
  await expect(page.getByTestId("reveal-box")).toHaveCount(0);
  await expect(card).not.toContainText("6011280932");
  await expect(page.getByTestId("card-tg-masked")).toBeVisible();

  // a child profile has no Telegram ID: nothing to reveal; the guardian is linked
  await page.getByRole("button", { name: "Лола" }).click();
  await expect(page.getByTestId("lc-guardian")).toContainText("Ботир");
});

test("card tabs: consents, plan and schedule, notifications, tickets", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", `#/users/${LEARNER.madina}`);
  await expect(page.getByTestId("learner-card")).toBeVisible();
  await page.getByTestId("lc-tab-consent").click();
  await expect(page.getByTestId("lc-consent")).toContainText("product_news");
  await page.getByTestId("lc-tab-plan").click();
  await expect(page.getByTestId("lc-plan")).toContainText("19:30");
  await page.getByTestId("lc-tab-notif").click();
  await expect(page.getByTestId("lc-notif")).toContainText("Новости TilHero");
  await page.getByTestId("lc-tab-tickets").click();
  await page.getByTestId("lc-tickets").getByRole("button", { name: "TCK-1042" }).click();
  await expect(page.getByTestId("thread")).toBeVisible();
});

test("without users.sensitive.read there is no reveal button; the audit being down reveals nothing", async ({ page }) => {
  await openAs(page, "support@tilhero.local", `#/users/${LEARNER.madina}`);
  await expect(page.getByTestId("card-tg-masked")).toBeVisible();
  await expect(page.getByTestId("reveal-start")).toHaveCount(0);
});

test("reveal: 503 AUDIT_UNAVAILABLE → no value", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", `#/users/${LEARNER.madina}`, { auditDown: true });
  await page.getByTestId("reveal-start").click();
  await page.getByTestId("reveal-reason").fill("TCK-1042 — сверяем аккаунт");
  await page.getByTestId("reveal-confirm").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.locator("#rv-err")).toContainText("Журнал аудита недоступен");
  await expect(page.getByTestId("reveal-value")).toHaveCount(0);
});

test("username exactly as user-admin sends it: the mask without users.sensitive.read — «@» added once", async ({ page }) => {
  await openAs(page, "support@tilhero.local", "#/users/a1000000-0000-4000-8000-000000000001");
  await expect(page.getByTestId("lc-username")).toHaveText("@ma•••_k");
  await expect(page.getByText("madina_k")).toHaveCount(0);
  await expect(page.getByText(/@@/)).toHaveCount(0);
  // a child profile names its guardian by the masked username as well
  await page.goto("/#/users/a1000000-0000-4000-8000-000000000003");
  await expect(page.getByTestId("lc-guardian")).toContainText("@bo•••_r");
});

test("username: a super_admin (users.sensitive.read) gets the full name", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/users/a1000000-0000-4000-8000-000000000001");
  await expect(page.getByTestId("lc-username")).toHaveText("@madina_k");
});

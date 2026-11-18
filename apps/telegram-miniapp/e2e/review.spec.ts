import { expect, test, type Locator } from "@playwright/test";
import { open, shot } from "./helpers";

/**
 * Sprint 1 review fixes: the parent code (T-1), the teens a parent gave consent for and CONSENT_REQUIRED {social}
 * (INTERNAL_API §11).
 */
const SEEN = ["11111111-aaaa-4bbb-8ccc-000000000001", "11111111-aaaa-4bbb-8ccc-000000000002", "11111111-aaaa-4bbb-8ccc-000000000003"];
const TEEN = "8b1c2b3a-3333-4a2b-9c3d-000000000001";

async function keypad(scope: Locator, code: string): Promise<void> {
  for (const d of code) await scope.getByRole("button", { name: d, exact: true }).click();
}

test("parent code: offered right after the first child profile; set there, it then guards deletion", async ({ page }) => {
  const bff = await open(page, { onboarded: true, seen: SEEN });
  await page.getByTestId("tab-profile").click();
  await expect(page.getByTestId("row-pin")).toContainText("не задан");
  await page.getByTestId("row-family").click();
  await page.getByTestId("add-child").click();
  await page.getByLabel("Как обращаться к ребёнку").fill("Мадина");
  await page.getByRole("button", { name: "от 6 до 9 лет" }).click();
  await page.getByTestId("add-child-save").click();

  const offer = page.getByTestId("pin-offer");
  await expect(offer.getByRole("heading", { name: "Задайте код родителя" })).toBeVisible();
  await shot(page, "14_parent_code_offer");
  await keypad(offer, "2580");
  await expect(offer.getByTestId("pin-step")).toHaveText("Повторите код");
  await keypad(offer, "2581");
  await expect(offer).toContainText("Коды не совпадают");
  await keypad(offer, "2580");
  await keypad(offer, "2580");
  await expect(offer).toBeHidden();
  await expect(page.getByTestId("toast")).toHaveText("Код родителя задан");
  expect(bff.calls("PUT", "/v1/profile/security/pin")).toHaveLength(1);
  expect(bff.last("PUT", "/v1/profile/security/pin")?.body).toEqual({ pin: "2580" });

  // the second child — no offer
  await page.getByTestId("add-child").click();
  await page.getByLabel("Как обращаться к ребёнку").fill("Тимур");
  await page.getByRole("button", { name: "от 10 до 13 лет" }).click();
  await page.getByTestId("add-child-save").click();
  await expect.poll(() => bff.calls("POST", "/v1/learners").length).toBe(2);
  await expect(offer).toHaveCount(0);

  // the profile shows the code; deletion asks for it instead of the word
  await page.getByTestId("bar-back").click();
  await expect(page.getByTestId("row-pin")).not.toContainText("не задан");
  await page.getByTestId("row-pin").click();
  await expect(page.getByTestId("pc-status")).toHaveText("Код задан");
  await page.getByTestId("bar-back").click();
  await page.getByTestId("row-privacy").click();
  await page.getByTestId("to-delete").click();
  await expect(page.getByTestId("del-pin")).toBeVisible();
  await expect(page.getByTestId("del-word")).toHaveCount(0);
});

test("parent code in onboarding: offered after the child profile is created, before entering it; can be skipped", async ({ page }) => {
  const bff = await open(page);
  const next = page.getByTestId("ob-next");
  await next.click();
  await page.getByTestId("who-child").click();
  await page.getByRole("button", { name: "от 6 до 9 лет" }).click();
  await next.click();
  await page.getByTestId("child-name").fill("Мадина");
  await page.getByTestId("child-adult").check();
  await next.click();
  for (const c of ["terms", "privacy", "learning"]) await page.getByTestId(`consent-${c}`).check();
  await next.click();
  const offer = page.getByTestId("pin-offer");
  await expect(offer).toBeVisible();
  // still the parent's profile: the child is created, not entered yet
  expect(bff.calls("POST", "/v1/learners")).toHaveLength(1);
  expect(bff.calls("POST", "/v1/session/learner")).toHaveLength(0);
  await offer.getByTestId("pin-offer-skip").click();
  await expect(page.getByRole("heading", { name: "Для чего ребёнку английский?" })).toBeVisible();
  expect(bff.learner().kind).toBe("child");
  expect(bff.calls("PUT", "/v1/profile/security/pin")).toHaveLength(0);
});

/** «19 ноября, 22:30» in the page's time zone (playwright.config: Asia/Tashkent). */
function tashkent(iso: string): string {
  const d = new Date(iso);
  const dm = new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Tashkent", day: "numeric", month: "long" }).format(d);
  const hm = new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${dm}, ${hm}`;
}

test("forgot the parent code at login: the reset from the lock screen waits 24 h, the old code still unlocks and cancels it (T-8)", async ({ page }) => {
  const bff = await open(page, { onboarded: true, pin: "2580", pinRequired: true, seen: SEEN });
  const lock = page.getByTestId("lock");
  await expect(lock).toBeVisible();
  await lock.getByTestId("lock-forgot").click();
  await expect(lock).toContainText("Новый код заработает через 24 часа — до этого действует прежний.");
  await lock.getByTestId("pin-reset-send").click();
  await expect(lock).toContainText("Код отправлен в чат с ботом. Он действует 10 мин.");
  await lock.getByTestId("pin-reset-code").fill("246810");
  await lock.getByTestId("pin-reset-next").click();
  await keypad(lock, "1357");
  await keypad(lock, "1357");

  // no rights of the parent: «Новый код заработает через 24 часа» with the date and time, the lock stays
  const wait = lock.getByTestId("pin-reset-wait");
  await expect(wait.getByTestId("pin-reset-wait-title")).toHaveText("Новый код заработает через 24 часа");
  const at = bff.security.pin_reset_effective_at!;
  await expect(wait.getByTestId("pin-reset-wait-when")).toHaveText(`Он начнёт действовать ${tashkent(at)}.`);
  await shot(page, "17_pin_reset_wait");
  expect(bff.last("POST", "/v1/profile/security/pin/reset-confirm")?.body).toEqual({ code: "246810", new_pin: "1357" });
  expect(bff.pin).toBe("2580");
  expect(bff.pendingPin).toBe("1357");
  await wait.getByTestId("pin-reset-wait-ok").click();
  await expect(lock.getByTestId("pin-reset-pending")).toContainText("Введите прежний код — сброс отменится.");
  await expect(lock.getByTestId("pin-reset-pending-when")).toContainText(tashkent(at));
  await expect(page.getByTestId("home")).toHaveCount(0);

  // the new code does not open the app before the deadline; the old one does — and cancels the reset
  await keypad(lock, "1357");
  await expect(lock).toContainText("Неверный код");
  await expect(page.getByTestId("home")).toHaveCount(0);
  await keypad(lock, "2580");
  await expect(page.getByTestId("home")).toBeVisible();
  expect(bff.pendingPin).toBeNull();
  expect(bff.calls("POST", "/v1/session/pin/verify").map((r) => r.body)).toEqual([{ pin: "1357" }, { pin: "2580" }]);
});

test("the adult profile shows the pending reset; «Отменить сброс» asks for the old code (T-8)", async ({ page }) => {
  const at = new Date(Date.now() + 20 * 3600_000).toISOString();
  const bff = await open(page, { onboarded: true, pin: "2580", pendingReset: { pin: "1357", at }, seen: SEEN });
  await page.getByTestId("tab-profile").click();
  const banner = page.getByTestId("pin-reset-pending");
  await expect(banner).toContainText("Сброс кода запрошен");
  await expect(banner.getByTestId("pin-reset-pending-when")).toHaveText(`Вступит в силу ${tashkent(at)}. До этого действует прежний код.`);
  await shot(page, "18_pin_reset_pending");
  await banner.getByTestId("pin-reset-cancel").click();

  const step = page.getByTestId("pin-reset-cancel-step");
  await expect(step.getByTestId("pin-step")).toHaveText("Введите прежний код");
  await keypad(step, "0000");
  await expect(step).toContainText("Неверный код. Осталось попыток: 4.");
  await keypad(step, "2580");
  await expect(page.getByTestId("toast")).toHaveText("Сброс кода отменён");
  await expect(page.getByTestId("parent-code").getByTestId("pin-reset-pending")).toHaveCount(0);
  expect(bff.calls("POST", "/v1/profile/security/pin/reset-cancel").map((r) => r.body)).toEqual([{ current_pin: "0000" }, { current_pin: "2580" }]);
  expect(bff.pendingPin).toBeNull();
  await page.getByTestId("bar-back").click();
  await expect(page.getByTestId("profile")).toBeVisible();
  await expect(page.getByTestId("pin-reset-pending")).toHaveCount(0);
});

test("a parent revokes the consent given for a teen (with a confirmation)", async ({ page }) => {
  const bff = await open(page, {
    onboarded: true,
    seen: SEEN,
    grants: [{ teen_user_id: TEEN, teen_display_name: "Тимур", status: "granted", decided_at: "2026-11-12T09:00:00Z" }],
  });
  await page.getByTestId("tab-profile").click();
  await page.getByTestId("row-family").click();
  const section = page.getByTestId("teen-consents");
  await expect(section.getByTestId("teen-consent-row")).toContainText("Тимур");
  await expect(section.getByTestId("teen-consent-row")).toContainText("согласие дано");
  await section.getByTestId("teen-consent-revoke").click();
  const pop = page.locator(".pop");
  await expect(pop).toContainText("У Тимур выключатся запись голоса, приглашения и семья.");
  await shot(page, "15_teen_consent_revoke");
  await pop.getByRole("button", { name: "Отозвать согласие" }).click();
  await expect(section.getByTestId("teen-consent-row")).toContainText("согласия нет");
  await expect(section.getByTestId("teen-consent-revoke")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toHaveText("Согласие отозвано");
  expect(bff.calls("POST", `/v1/family/guardian-consents/${TEEN}/revoke`)).toHaveLength(1);
});

test("accepting an invitation without the purpose «social»: the sheet, the consent, then the acceptance", async ({ page }) => {
  const TOKEN = "FamTok0123456789abcdefghijklmnop";
  const INVITE_ID = "33333333-aaaa-4bbb-8ccc-0000000000aa";
  const bff = await open(
    page,
    { onboarded: true, seen: SEEN, incoming: { [TOKEN]: { invite: { invite_id: INVITE_ID, kind: "family", inviter_display_name: "Мама", status: "active" } } } },
    `?startapp=inv_${TOKEN}`,
  );
  const sheet = page.getByTestId("invite-sheet");
  await sheet.getByTestId("invite-accept").click();
  const consent = page.getByTestId("social-consent");
  await expect(consent.getByRole("heading", { name: "Разрешить приглашения и семью" })).toBeVisible();
  await expect(consent).toContainText("«Приглашения, семья и друзья»");
  await shot(page, "16_social_consent");
  await consent.getByTestId("social-allow").click();
  await expect(page.getByTestId("toast")).toHaveText("Приглашение принято");
  await expect(page.getByTestId("family-members")).toContainText("Мама");
  // the consent is repeated with the purpose added (the optional ones already given stay), then the acceptance
  expect(bff.last("POST", "/v1/profile/consent")?.body).toEqual({ policy_version: "1.2", purposes: ["terms", "privacy", "learning", "product_news", "social"] });
  expect(bff.calls("POST", `/v1/invites/${INVITE_ID}/accept`)).toHaveLength(2);
  expect(bff.consent.purposes).toContain("social");
});

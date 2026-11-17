import { expect, test } from "@playwright/test";
import { onboardAdult, open, shot } from "./helpers";

const TOKEN = "FamTok0123456789abcdefghijklmnop";
const INVITE_ID = "33333333-aaaa-4bbb-8ccc-0000000000aa";
const family = (status: "active" | "accepted" = "active") => ({
  [TOKEN]: { invite: { invite_id: INVITE_ID, kind: "family" as const, inviter_display_name: "Мама", status } },
});

/** AT-09: the link opens the Mini App by deep link (start_param inv_<token>), acceptance is two-sided. */
test("invitation to the family by deep link: preview, accept, the family screen", async ({ page }) => {
  const bff = await open(page, { onboarded: true, incoming: family(), seen: ["11111111-aaaa-4bbb-8ccc-000000000001", "11111111-aaaa-4bbb-8ccc-000000000002", "11111111-aaaa-4bbb-8ccc-000000000003"] }, `?startapp=inv_${TOKEN}`);
  const sheet = page.getByTestId("invite-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Мама приглашает вас в семью" })).toBeVisible();
  expect(bff.last("POST", "/v1/invites/open")?.body).toEqual({ token: TOKEN });
  await shot(page, "08_invite_deeplink");
  await sheet.getByTestId("invite-accept").click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("toast")).toHaveText("Приглашение принято");
  await expect(page.getByTestId("family")).toBeVisible();
  await expect(page.getByTestId("family-members")).toContainText("Мама");
  await expect(page.getByTestId("family-members")).toContainText("Азиз (вы)");
  expect(bff.calls("POST", `/v1/invites/${INVITE_ID}/accept`)).toHaveLength(1);
});

test("own invitation cannot be accepted: the reason instead of the button", async ({ page }) => {
  await open(page, { onboarded: true, incoming: { [TOKEN]: { invite: { invite_id: INVITE_ID, kind: "friend", inviter_display_name: "Азиз", status: "active" }, self: true } } }, `?startapp=inv_${TOKEN}`);
  const sheet = page.getByTestId("invite-sheet");
  await expect(sheet.getByTestId("invite-reason")).toHaveText("Это ваше собственное приглашение — принять его нельзя.");
  await expect(sheet.getByTestId("invite-accept")).toHaveCount(0);
});

test("an unknown token: «не найдено», nothing breaks", async ({ page }) => {
  await open(page, { onboarded: true }, "?startapp=inv_Unknown0123456789abcdefghijklmn");
  await expect(page.getByTestId("invite-sheet")).toContainText("Приглашение не найдено");
});

test("a new user: the invitation waits for the short setup, then comes back before «Что нового»", async ({ page }) => {
  const bff = await open(page, { incoming: family() }, `?startapp=inv_${TOKEN}`);
  const sheet = page.getByTestId("invite-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Сначала короткая настройка");
  await sheet.getByTestId("invite-defer").click();
  await onboardAdult(page);
  await expect(sheet).toBeVisible();
  // GET …/preview (the invitation was opened before the setup); dev StrictMode may run the effect twice
  await expect.poll(() => bff.calls("GET", `/v1/invites/${INVITE_ID}/preview`).length).toBeGreaterThanOrEqual(1);
  await sheet.getByTestId("invite-accept").click();
  await expect(page.getByTestId("whats-new-welcome")).toBeVisible();
});

test("my invitations: create a family link, share it through Telegram, revoke it", async ({ page }) => {
  const bff = await open(page, { onboarded: true, seen: ["11111111-aaaa-4bbb-8ccc-000000000001", "11111111-aaaa-4bbb-8ccc-000000000002", "11111111-aaaa-4bbb-8ccc-000000000003"] });
  await page.getByTestId("tab-profile").click();
  await page.getByTestId("row-family").click();
  const popup = page.waitForEvent("popup");
  await page.getByTestId("invite-family").click();
  const share = await popup;
  await share.waitForURL(/t\.me/);
  expect(share.url()).toContain("https://t.me/share/url?url=https%3A%2F%2Ft.me%2FTilHeroBot%2Fapp%3Fstartapp%3Dinv_");
  await share.close();
  const created = bff.last("POST", "/v1/invites")!;
  expect(created.body).toEqual({ kind: "family" });
  expect(created.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByTestId("invite-row")).toContainText("действует");
  page.once("dialog", () => undefined);
  await page.getByTestId("invite-revoke").click();
  await page.locator(".pop").getByRole("button", { name: "Отозвать" }).click();
  await expect(page.getByTestId("invite-row")).toContainText("отозвано");
});

/**
 * Sprint 7 permissions of «Сообщество» (PLAN «Права»): without the read right of a section it is not in the menu and
 * does not open by link; support (social.read, moderation.manage, referral.read, room.read) reads referrals and rooms
 * without their commands; the content manager (league.read) sees leagues without re-evaluation; the analyst reads
 * everything without a single command; a request the server refuses names the missing right; the overview block; the
 * EN chrome of the sections has no Russian.
 */
import { expect, test, type Page } from "@playwright/test";
import { openAs } from "./helpers";
import { LEARNER, MATRIX } from "./fixtures/data";
import { DUEL, GROUP, REFERRAL, ROOM } from "./fixtures/social-data";

const menu = async (page: Page) => page.locator("[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav")));
const SOCIAL = ["friends", "moderation", "referrals", "leagues", "pair_rooms"];

test("communications: no section of «Сообщество»; a link is refused with a toast", async ({ page }) => {
  await openAs(page, "comms@tilhero.local", "#/overview");
  const ids = await menu(page);
  for (const x of SOCIAL) expect(ids).not.toContain(x);
  await page.evaluate(() => (window.location.hash = "#/moderation"));
  await expect(page.getByText("Раздел «Модерация» недоступен для вашей роли")).toBeVisible();
  await expect(page.getByTestId("page-overview")).toBeVisible();
});

test("support without social.read (matrix changed): the learner card has no «Сообщество» tab, «Друзья и жалобы» is not in the menu", async ({ page }) => {
  await openAs(page, "support@tilhero.local", `#/users/${LEARNER.anya}`, { matrix: { support: MATRIX.support.filter((p) => p !== "social.read") } });
  await expect(page.getByTestId("lc-tab-account")).toBeVisible();
  await expect(page.getByTestId("lc-tab-social")).toHaveCount(0);
  expect(await menu(page)).not.toContain("friends");
});

test("support: friends, moderation, referrals, rooms — not leagues; referrals and rooms without commands", async ({ page }) => {
  await openAs(page, "support@tilhero.local", `#/referrals/review/${REFERRAL.shortLessons}`);
  const ids = await menu(page);
  expect(ids.filter((x) => SOCIAL.includes(x!))).toEqual(["friends", "moderation", "referrals", "pair_rooms"]);
  await expect(page.getByTestId("rr-body")).toBeVisible();
  await expect(page.getByTestId("rr-approve")).toHaveCount(0);
  await expect(page.getByTestId("rr-reject")).toHaveCount(0);
  await expect(page.getByTestId("rr-ro")).toContainText("referral.manage");
  await page.evaluate(() => (window.location.hash = "#/referrals/campaigns"));
  await expect(page.getByTestId("rc-new-draft")).toHaveCount(0);
  await expect(page.getByTestId("rc-notes")).toContainText("referral.manage");
  await page.evaluate((id) => (window.location.hash = `#/pair_rooms/${id}`), ROOM.live);
  await expect(page.getByTestId("pr-ro")).toContainText("room.manage");
  await page.evaluate(() => (window.location.hash = "#/leagues"));
  await expect(page.getByText("Раздел «Лиги и дуэли» недоступен для вашей роли")).toBeVisible();
});

test("content manager: leagues and duels read-only; analyst: every section of reading, no commands", async ({ page }) => {
  await openAs(page, "content@tilhero.local", `#/leagues/groups/${GROUP.heldPrev}`);
  expect((await menu(page)).filter((x) => SOCIAL.includes(x!))).toEqual(["leagues"]);
  await expect(page.getByTestId("lg-group-body")).toBeVisible();
  await expect(page.getByTestId("lg-release")).toHaveCount(0);
  await expect(page.getByTestId("lg-reevaluate")).toHaveCount(0);
  await expect(page.getByTestId("lg-ro")).toContainText("league.manage");
  await page.evaluate((id) => (window.location.hash = `#/leagues/duels/${id}`), DUEL.won);
  await expect(page.getByTestId("dl-ro")).toContainText("league.manage");
  await page.evaluate(() => (window.location.hash = "#/overview"));
  await expect(page.getByTestId("block-social")).toBeVisible();
});

test("analyst: reads friends, referrals, leagues, rooms; no moderation; no command anywhere", async ({ page }) => {
  await openAs(page, "analyst@tilhero.local", `#/friends/${LEARNER.anya}`);
  expect((await menu(page)).filter((x) => SOCIAL.includes(x!))).toEqual(["friends", "referrals", "leagues", "pair_rooms"]);
  await expect(page.getByTestId("fr-card")).toBeVisible();
  await expect(page.locator('[data-testid^="fr-sanc-revoke-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="fr-case-open-"]')).toHaveCount(0);
  await page.evaluate((id) => (window.location.hash = `#/pair_rooms/${id}`), ROOM.live);
  await expect(page.getByTestId("pr-room-body")).toBeVisible();
  await expect(page.getByTestId("pr-stop")).toHaveCount(0);
});

test("the server refuses (the domain re-checks): the stop names the missing right", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", `#/pair_rooms/${ROOM.live}`, { deny: { [`POST /pair-rooms/${ROOM.live}/stop`]: "room.manage" } });
  await page.getByTestId("pr-stop").click();
  const dlg = page.getByTestId("pr-stop-dialog");
  await dlg.locator("#cmd-reason").fill("Проверка отказа сервера по праву");
  await dlg.getByTestId("confirm-ok").click();
  await expect(dlg).toContainText("Недостаточно прав: нужно право room.manage");
});

test("a read the server refuses shows a locked block naming the right, not an empty screen", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/referrals/stats", { deny: { "GET /referrals/campaigns/stats": "referral.read" } });
  await expect(page.getByTestId("load-denied")).toContainText("referral.read");
});

test("overview: the block «Сообщество» with links by right; a source down shows «нет данных» for its counter", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/overview", { social: { duelsDown: true } });
  const b = page.getByTestId("block-social");
  await expect(b.getByTestId("dsoc-duels-na")).toHaveText("нет данных");
  await expect(b.getByTestId("dsoc-cases-open")).toContainText("3");
  await b.getByTestId("dsoc-cases-link").click();
  await expect(page.getByTestId("mod-cases")).toBeVisible();
  await page.evaluate(() => (window.location.hash = "#/overview"));
  await expect(page.getByTestId("att-referrals")).toBeVisible();
  await page.getByTestId("att-referrals").click();
  await expect(page.getByTestId("ref-queue")).toBeVisible();
});

test("overview: the whole block down is said in its own place", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/overview", { social: { statsDown: true } });
  await expect(page.getByTestId("block-social-off")).toContainText("social");
  await expect(page.getByTestId("block-learners")).toBeVisible();
});

test("EN: the chrome of the community screens has no Russian (nicknames, scenario titles and staff texts are data, marked lang=ru)", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/moderation");
  await expect(page.getByTestId("mod-cases")).toBeVisible();
  await page.getByTestId("lang-en").click();
  await expect(page.locator('[data-nav="moderation"]')).toHaveText(/Moderation/);
  const chrome = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[role=tab], .acts button, label, th, .h2, .h3, .panel-t, .kv > span:first-child, .pill, legend, .field-label, .callout, .btn, dt, .kpi-l, .hint"))
        .filter((e) => !e.closest('[lang="ru"]') && !e.querySelector('[lang="ru"]'))
        .map((e) => e.innerText.trim())
        .filter((x) => /[Ѐ-ӿ]/.test(x)),
    );
  for (const [hash, id] of [
    ["#/moderation/cases", "mc-rows"],
    [`#/moderation/cases/${"c7000000-0000-4000-8000-000000000001"}`, "mc-resolve"],
    ["#/moderation/sanctions", "ms-rows"],
    ["#/moderation/appeals", "ma-rows"],
    [`#/friends/${LEARNER.anya}`, "fr-kpis"],
    ["#/referrals/review", "rq-rows"],
    [`#/referrals/review/${REFERRAL.velocity}`, "rr-body"],
    ["#/referrals/campaigns", "rc-form"],
    ["#/referrals/stats", "rst-rows"],
    ["#/leagues/groups", "lg-kpis"],
    [`#/leagues/groups/${GROUP.heldPrev}`, "lg-members"],
    [`#/leagues/duels/${DUEL.won}`, "dl-duel-body"],
    ["#/pair_rooms", "pr-rows"],
    [`#/pair_rooms/${ROOM.live}`, "pr-participants"],
    ["#/overview", "block-social"],
  ] as const) {
    await page.evaluate((h) => (window.location.hash = h), hash);
    await expect(page.getByTestId(id)).toBeVisible();
    await page.waitForTimeout(250);
    expect(await chrome(), hash).toEqual([]);
  }
});

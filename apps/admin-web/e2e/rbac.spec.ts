/** AT-17: the menu follows the role and the active admin config; actions without the right are not offered. */
import { expect, test } from "@playwright/test";
import { openAs } from "./helpers";
import { MATRIX } from "./fixtures/data";

const menu = async (page: import("@playwright/test").Page) => page.locator("[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav")));

test("support sees overview, learners, support and the game (game.read, sprint 6); not news, config, roles, audit", async ({ page }) => {
  await openAs(page, "support@tilhero.local");
  const ids = await menu(page);
  expect(ids).toEqual(expect.arrayContaining(["overview", "users", "support", "heroes", "game", "events"]));
  for (const x of ["news", "config", "roles", "audit"]) expect(ids).not.toContain(x);
  // a forbidden section by link → toast + the start screen
  await page.evaluate(() => (window.location.hash = "#/roles"));
  await expect(page.getByTestId("page-overview")).toBeVisible();
});

test("communications: «news» with the three tabs; the 15 menu ids and groups of the prototype for super admin", async ({ page }) => {
  await openAs(page, "comms@tilhero.local", "#/news");
  const ids = await menu(page);
  // sprint 5: «memory» (forgetting analytics) opens with dashboard.read
  expect(ids.filter((x) => !["content", "agents", "qa", "costs", "heroes", "game", "events", "langs"].includes(x!))).toEqual(["overview", "memory", "news"]);
  await expect(page.getByTestId("news-tab-whatsnew")).toBeVisible();
  await expect(page.getByTestId("news-tab-templates")).toBeVisible();
  await expect(page.getByTestId("news-tab-campaigns")).toBeVisible();
});

test("super admin: 15 sections + «memory» (sprint 5) + «Сообщество» (sprint 7) in 6 groups; the game sections are live (sprint 6), so are content and languages (sprint 3)", async ({ page }) => {
  await openAs(page, "admin@tilhero.local");
  // the five sections of sprint 7 are not in the admin config 1.0.0: they follow its sections, in their own group
  expect(await menu(page)).toEqual(["overview", "users", "content", "memory", "agents", "qa", "costs", "heroes", "game", "events", "news", "support", "config", "langs", "roles", "audit", "friends", "moderation", "referrals", "leagues", "pair_rooms"]);
  await expect(page.locator(".sn-group")).toHaveCount(6);
  await expect(page.locator('.sn-group[data-group="social"] [data-nav]')).toHaveCount(5);
  await expect(page.locator(".sn-tag")).toHaveCount(0);
  await page.locator('[data-nav="heroes"]').click();
  await expect(page.getByTestId("heroes")).toBeVisible();
  await expect(page.getByTestId("soon")).toHaveCount(0);
  await page.locator('[data-nav="content"]').click();
  await expect(page.getByTestId("content")).toBeVisible();
  await expect(page.getByTestId("soon")).toHaveCount(0);
  await page.locator('[data-nav="langs"]').click();
  await expect(page.getByTestId("langs")).toBeVisible();
});

test("a role without whatsnew.publish does not see the publish button (and the server would answer 403)", async ({ page }) => {
  const bff = await openAs(page, "comms@tilhero.local", "#/news/whatsnew", { matrix: { communications: MATRIX.communications.filter((p) => p !== "whatsnew.publish") } });
  await expect(page.getByTestId("wn-editor")).toBeVisible();
  await expect(page.getByTestId("wn-save")).toBeVisible();
  await expect(page.getByTestId("wn-publish")).toHaveCount(0);
  await expect(page.getByTestId("wn-no-publish")).toContainText("whatsnew.publish");
  // the published note cannot be withdrawn either
  await page.getByTestId("wn-open-2026.10").click();
  await expect(page.getByTestId("wn-archive")).toHaveCount(0);
  expect(bff.calls("POST", /\/publish$/)).toHaveLength(0);
});

test("a role without notif.campaigns.send prepares campaigns but cannot schedule or stop them", async ({ page }) => {
  await openAs(page, "comms@tilhero.local", "#/news/campaigns", { matrix: { communications: MATRIX.communications.filter((p) => p !== "notif.campaigns.send") } });
  await expect(page.getByTestId("cmp-detail")).toBeVisible();
  await expect(page.getByTestId("cmp-schedule")).toHaveCount(0);
  await expect(page.getByTestId("cmp-no-send")).toBeVisible();
});

test("the active admin config switches menu sections off (and they do not open by link)", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/overview", { menuOff: ["heroes", "game", "events"] });
  await expect(page.locator('[data-nav="overview"]')).toBeVisible();
  const ids = await menu(page);
  for (const x of ["heroes", "game", "events"]) expect(ids).not.toContain(x);
  await page.evaluate(() => (window.location.hash = "#/game"));
  await expect(page.getByTestId("page-overview")).toBeVisible();
});

test("the admin theme from experience-config is applied without a build; its failure keeps the built-in theme", async ({ page }) => {
  await openAs(page, "admin@tilhero.local");
  await expect(page.locator("html")).toHaveAttribute("style", /--pen: #2F4BE0/);
});

test("experience-config down → the built-in menu and theme", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/overview", { adminConfigDown: true });
  // the built-in order: «Сообщество» after the game
  expect(await menu(page)).toHaveLength(21);
  expect((await menu(page)).slice(10, 15)).toEqual(["friends", "moderation", "referrals", "leagues", "pair_rooms"]);
  await expect(page.locator("html")).not.toHaveAttribute("style", /--pen/);
});

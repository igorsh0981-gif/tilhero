/**
 * Sprint 4 RBAC on the mock admin-bff (PLAN «Права и роли»): qa_analyst reads agents and dialogue QA with replies but
 * never re-evaluates and has no costs; analyst reads everything of sprint 4 and changes nothing (no replies);
 * methodist manages agents and re-evaluates but has no costs; operations manages the budget. The roles screen lists
 * the QA analyst and the new permissions; privileged — from Role.privileged.
 */
import { expect, test, type Page } from "@playwright/test";
import { openAs } from "./helpers";
import { AID, SID } from "./fixtures/ai-data";

const menu = (page: Page) => page.locator("[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav")));

test("qa_analyst: agents and dialogue QA with replies; no re-evaluation, no appeal decisions, no costs", async ({ page }) => {
  await openAs(page, "qa@tilhero.local", "#/overview");
  const ids = await menu(page);
  expect(ids).toEqual(expect.arrayContaining(["overview", "content", "agents", "qa"]));
  expect(ids).not.toContain("costs");
  await page.evaluate((id) => (window.location.hash = `#/qa/sessions/${id}`), SID.s1);
  await expect(page.getByTestId("qa-card")).toBeVisible();
  await expect(page.getByTestId("qa-transcript")).toBeVisible();
  await expect(page.getByTestId("qa-flag")).toBeVisible();
  await expect(page.getByTestId("qa-reeval")).toHaveCount(0);
  await page.evaluate((id) => (window.location.hash = `#/qa/appeals/${id}`), AID.a1);
  await expect(page.getByTestId("ap-drawer")).toBeVisible();
  await expect(page.getByTestId("ap-no-review")).toContainText("qa.review");
  await expect(page.getByTestId("ap-take")).toHaveCount(0);
  // agents: read only
  await page.evaluate(() => (window.location.hash = "#/agents/conversation_partner"));
  await expect(page.getByTestId("ag-card")).toBeVisible();
  await expect(page.getByTestId("ag-new-draft")).toHaveCount(0);
  await expect(page.getByTestId("ag-canary-btn")).toHaveCount(0);
  await expect(page.getByTestId("ag-rollback")).toHaveCount(0);
  await expect(page.getByTestId("ag-ro-note")).toContainText("ai.manage");
  // the budget by link → back to the start screen
  await page.evaluate(() => (window.location.hash = "#/costs"));
  await expect(page.getByTestId("page-overview")).toBeVisible();
});

test("analyst: reads agents, dialogue QA and costs; changes nothing and sees no replies", async ({ page }) => {
  await openAs(page, "analyst@tilhero.local", "#/agents/independent_evaluator");
  await expect(page.getByTestId("ag-version")).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("agv-readonly")).toBeVisible();
  await expect(page.getByTestId("ag-ro-note")).toContainText("ai.manage");
  await expect(page.getByTestId("agv-save")).toHaveCount(0);
  await expect(page.getByTestId("agv-run")).toHaveCount(0);
  await expect(page.getByTestId("agv-publish")).toHaveCount(0);
  await expect(page.getByTestId("agv-instructions")).toHaveAttribute("readonly", "");
  await page.getByTestId("agc-tab-cases").click();
  await expect(page.getByTestId("gc-add")).toHaveCount(0);
  await page.evaluate(() => (window.location.hash = "#/agents/models"));
  await expect(page.getByTestId("ag-models")).toBeVisible();
  await expect(page.locator('[data-testid^="mdl-edit-"]')).toHaveCount(0);
  await page.evaluate((id) => (window.location.hash = `#/qa/sessions/${id}`), SID.s1);
  await expect(page.getByTestId("qa-card")).toBeVisible();
  await expect(page.getByTestId("qa-transcript")).toHaveCount(0);
  await expect(page.getByTestId("qa-no-transcripts")).toBeVisible();
  await expect(page.getByTestId("qa-reeval")).toHaveCount(0);
  await page.evaluate(() => (window.location.hash = "#/costs"));
  await expect(page.getByTestId("costs")).toBeVisible();
  await expect(page.getByTestId("cs-stop-locked")).toContainText("costs.manage");
  await expect(page.getByTestId("cs-stop-btn")).toHaveCount(0);
  await expect(page.getByTestId("cs-settings-locked")).toBeVisible();
  await expect(page.getByTestId("csf-save")).toHaveCount(0);
  await expect(page.getByTestId("csf-monthly_cap_usd")).toHaveAttribute("readonly", "");
});

test("methodist manages agents and re-evaluates, but has no costs; operations has costs but no re-evaluation", async ({ page }) => {
  const bff = await openAs(page, "methodist@tilhero.local", `#/qa/sessions/${SID.s1}`);
  await expect(page.getByTestId("qa-reeval")).toBeVisible();
  expect(await menu(page)).not.toContain("costs");
  await page.evaluate(() => (window.location.hash = "#/costs"));
  await expect(page.getByTestId("page-overview")).toBeVisible();
  bff.switchTo("ops@tilhero.local");
  await page.goto(`/#/qa/sessions/${SID.s1}`);
  await page.reload();
  await expect(page.getByTestId("qa-card")).toBeVisible();
  await expect(page.getByTestId("qa-reeval")).toHaveCount(0);
  await expect(page.getByTestId("qa-transcript")).toHaveCount(0);
  await page.evaluate(() => (window.location.hash = "#/costs"));
  await expect(page.getByTestId("cs-stop-btn")).toBeVisible();
  await expect(page.getByTestId("csf-save")).toBeVisible();
});

test("roles: the QA analyst role and the sprint 4 permissions are in the matrix (RU and EN)", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/roles");
  await page.getByTestId("roles-tab-matrix").click();
  const body = page.locator("main");
  await expect(body).toContainText("QA-аналитик");
  await expect(body).toContainText("Контроль диалогов");
  await expect(body).toContainText("Лимиты и аварийная остановка ИИ");
  await page.getByTestId("lang-en").click();
  await expect(body).toContainText("QA analyst");
  await expect(body).toContainText("Re-evaluation and appeals");
});

test("without costs.read the «AI is off» banner comes from AiProviderStatus.ai_enabled (GET /ai/provider)", async ({ page }) => {
  const bff = await openAs(page, "qa@tilhero.local", "#/qa", { ai: { aiOff: true } });
  await expect(page.getByTestId("ai-off-banner")).toContainText("ИИ выключен");
  await expect(page.getByTestId("ai-off-open")).toHaveCount(0); // no link to «Затраты» without costs.read
  await page.locator('[data-nav="agents"]').click();
  await expect(page.getByTestId("ai-off-banner")).toBeVisible();
  expect(bff.calls("GET", "/ai/provider").length).toBeGreaterThanOrEqual(1);
  expect(bff.calls("GET", "/ai/budget")).toHaveLength(0);
});

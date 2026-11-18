import { expect, test, type Page } from "@playwright/test";
import { ALERT, REQ } from "./fixtures/ai";
import { USER } from "./fixtures/data";
import { CYRILLIC, expectNoHScroll, openAs, settle, typeOtp } from "./helpers";
import type { MockBff } from "./fixtures/mock-bff";

/* Sprint 7, stream G: «Requests and cost», «Budgets and limits», «Agents and skills», user AI tab, bell → shots/sprint7/. */

const SHOTS = "shots/sprint7";
async function shot(page: Page, name: string, fullPage = false) {
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}
async function block(page: Page, testId: string, name: string) {
  await page.getByTestId(testId).first().scrollIntoViewIfNeeded();
  await settle(page);
  await page.getByTestId(testId).first().screenshot({ path: `${SHOTS}/${name}.png` });
}
/** the last recorded request to the mock admin-bff (waits until it is there — the UI may update first) */
async function lastCall(bff: MockBff, method: string, path: string) {
  await expect.poll(() => bff.calls(method, path).length).toBeGreaterThan(0);
  return bff.calls(method, path).at(-1)!;
}
async function totp(page: Page) {
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", "123456");
  await expect(page.getByTestId("stepup")).toHaveCount(0);
}

test.describe("width 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("requests: KPI, agents with budget thresholds, log filters, drill-down with cost by catalogue version", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/requests");
    await expect(page.getByTestId("kpi-requests")).toContainText("412");
    await expect(page.getByTestId("kpi-cost")).toContainText("$4.14");
    await expect(page.getByTestId("kpi-unpriced")).toContainText("3");
    const row = page.locator('[data-testid="req-agent-row"][data-agent="concierge"]');
    await expect(row.getByTestId("req-agent-meter")).toHaveAttribute("data-tone", "bad");
    await expect(page.locator('[data-testid="req-agent-row"][data-agent="news"]').getByTestId("req-agent-meter")).toHaveAttribute("data-tone", "warn");
    await expectNoHScroll(page);
    await shot(page, "01-requests-agents-light");

    // agent row → the log filtered by that agent
    await row.click();
    await expect(page.getByTestId("req-f-agent")).toHaveValue("concierge");
    await expect(page.getByTestId("req-row")).toHaveCount(3);
    await page.getByTestId("req-f-status").selectOption("PARTIAL");
    await expect(page.getByTestId("req-row")).toHaveCount(1);
    expect((await lastCall(bff, "GET", "/usage/requests")).path).toBe("/usage/requests");
    await page.getByTestId("req-reset").click();
    await expect(page.getByTestId("req-row")).toHaveCount(5); // 30 days: the request of 34 days ago is outside
    await page.getByTestId("req-f-user").fill("not-a-uuid");
    await expect(page.getByTestId("req-log")).toContainText("ID пользователя — UUID целиком");
    await page.getByTestId("req-f-user").fill(USER.maria);
    await expect(page.getByTestId("req-row")).toHaveCount(1);
    await page.getByTestId("req-reset").click();
    await shot(page, "02-requests-log-light");

    await page.locator(`[data-request="${REQ.cheaper}"]`).click();
    const d = page.getByTestId("req-drawer");
    await expect(d).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/requests/${REQ.cheaper}$`));
    await expect(d.getByTestId("rq-catalog")).toHaveText("price_catalog_version: 2026-10-12");
    await expect(d.getByTestId("rq-unpriced")).toContainText("claude-sonnet-4-5");
    await expect(d.getByTestId("rq-call").nth(1)).toContainText("$0.002625");
    await expect(d.getByTestId("rq-call").nth(1)).toContainText("$0.009949");
    await expect(d.getByTestId("rq-timeline")).toContainText("reprice_offer");
    await expect(d.getByTestId("rq-meta")).toContainText("нарушений: 1");
    await expect(d.getByTestId("rq-content-hidden")).toBeVisible();
    await shot(page, "03-request-drilldown-light");
  });

  test("request content: reason + TOTP, audited, not kept after closing; audit down → nothing revealed; expired", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", `#/requests/${REQ.direct}`);
    const d = page.getByTestId("req-drawer");
    await d.getByTestId("rq-reveal").click();
    const dlg = page.getByTestId("rq-reveal-confirm");
    await dlg.locator("textarea").fill("Обращение TCK-3081: пользователь оспаривает ответ");
    await shot(page, "04-reveal-confirm-light");
    await dlg.getByTestId("confirm-ok").click();
    await totp(page);
    await expect(d.getByTestId("rq-content")).toBeVisible();
    await expect(d.getByTestId("rq-content")).toContainText("Берите прямой");
    await expect(d.getByTestId("rq-tools")).toContainText('{"direct_only":true}');
    const call = (await lastCall(bff, "POST", `/usage/requests/${REQ.direct}/content:reveal`));
    expect(call.body).toEqual({ reason: "Обращение TCK-3081: пользователь оспаривает ответ" });
    expect(bff.audit[0]).toMatchObject({ action: "ai.content.view", object_id: REQ.direct });
    await shot(page, "05-reveal-content-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "05-reveal-content-dark");
    await page.emulateMedia({ colorScheme: "light" });

    // closing the drawer drops the content: opening again shows the hidden block
    await page.getByTestId("drawer-close").click();
    await page.getByTestId("req-tab-log").click();
    await page.locator(`[data-request="${REQ.direct}"]`).click();
    await expect(page.getByTestId("rq-content-hidden")).toBeVisible();

    // the request of 34 days ago: the conversation is gone (30 days)
    await page.goto(`/#/requests/${REQ.old}`);
    await expect(page.getByTestId("rq-content-expired")).toBeVisible();
    // service request: no conversation at all
    await page.goto(`/#/requests/${REQ.discovery}`);
    await expect(page.getByTestId("rq-content-none")).toBeVisible();
  });

  test("request content: audit unavailable → not shown; without ai.content.read — locked", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", `#/requests/${REQ.direct}`, { revealAuditDown: true });
    await page.getByTestId("rq-reveal").click();
    const dlg = page.getByTestId("rq-reveal-confirm");
    await dlg.locator("textarea").fill("Проверка жалобы");
    await dlg.getByTestId("confirm-ok").click();
    await totp(page);
    await expect(dlg).toContainText("Журнал аудита недоступен, поэтому переписка не показана");
    await expect(page.getByTestId("rq-content")).toHaveCount(0);
    await page.goto("about:blank");
    await openAs(page, "ops@tilhero.local", `#/requests/${REQ.direct}`);
    await expect(page.getByTestId("rq-content-locked")).toContainText("ai.content.read");
    await block(page, "rq-content-locked", "06-content-locked-light");
  });

  test("price catalogue: draft with missing Sonnet rates, fill, save, activate with TOTP; active is immutable", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/requests");
    await page.getByTestId("req-tab-pricing").click();
    await expect(page.getByTestId("pc-incomplete")).toContainText("claude-sonnet-4-5");
    await expect(page.getByTestId("pc-activate")).toBeDisabled();
    await shot(page, "07-pricing-draft-light");
    for (const [f, v] of [["input_usd_per_mtok", "3"], ["output_usd_per_mtok", "15"], ["cache_read_usd_per_mtok", "0,30"], ["cache_write_usd_per_mtok", "3.75"]] as const) {
      await page.getByTestId(`pc-rate-claude-sonnet-4-5-${f}`).fill(v);
    }
    await page.getByTestId("pc-rate-claude-haiku-4-5-input_usd_per_mtok").fill("1.0000001");
    await page.getByTestId("pc-save").click();
    await expect(page.getByTestId("pc")).toContainText("Ставка — сумма до 6 знаков");
    await page.getByTestId("pc-rate-claude-haiku-4-5-input_usd_per_mtok").fill("1");
    await page.getByTestId("pc-note-in").fill("Ставки сверены со страницей цен Anthropic 12.10");
    await page.getByTestId("pc-save").click();
    await expect(page.getByTestId("pc-incomplete")).toHaveCount(0);
    const patch = (await lastCall(bff, "PATCH", "/ai/pricing/versions/2026-10-12"));
    expect((patch.body as { items: Array<{ key: string; cache_read_usd_per_mtok: string }> }).items.find((i) => i.key === "claude-sonnet-4-5")!.cache_read_usd_per_mtok).toBe("0.30");
    expect(patch.headers["idempotency-key"]).toBeTruthy();
    await page.getByTestId("pc-activate").click();
    const dlg = page.getByTestId("pc-activate-confirm");
    await dlg.locator("textarea").fill("Сверено с официальной страницей");
    await dlg.getByTestId("confirm-ok").click();
    await totp(page);
    await expect(page.getByTestId("pc-immutable")).toBeVisible();
    await expect(page.getByTestId("pc-versions")).toContainText("действует");
    expect(bff.audit[0]).toMatchObject({ action: "ai.pricing.activate" });
    await shot(page, "08-pricing-active-light");
  });

  test("budgets: limits with the concierge and Test Console, agents, kill switch with typed name + TOTP, config, alerts, levels", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/budgets");
    await expect(page.getByTestId("lim-concierge")).toHaveValue("1.00");
    await expect(page.getByTestId("lim-evaluation")).toHaveValue("0.30");
    const c = page.locator('[data-testid="bdg-agent-row"][data-agent="concierge"]');
    await expect(c.getByTestId("bdg-state")).toHaveText("Деградация");
    await expect(c.getByTestId("bdg-day-meter")).toHaveAttribute("data-tone", "bad");
    await expectNoHScroll(page);
    await shot(page, "10-budgets-light", true);
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "10-budgets-dark");
    await page.emulateMedia({ colorScheme: "light" });

    // kill switch: reason + typing the agent id + TOTP
    await c.getByTestId("bdg-kill").click();
    const k = page.getByTestId("kill-dialog");
    await k.getByTestId("kill-reason").fill("Инцидент INC-42: аномальный расход");
    await expect(k.getByTestId("kill-ok")).toBeDisabled();
    await k.getByTestId("kill-type").fill("concierg");
    await expect(k.getByTestId("kill-ok")).toBeDisabled();
    await k.getByTestId("kill-type").fill("concierge");
    await shot(page, "11-kill-confirm-light");
    await k.getByTestId("kill-ok").click();
    await totp(page);
    await expect(c.getByTestId("bdg-state")).toHaveText("Остановлен");
    await expect(c.getByTestId("pause-note")).toContainText("Тимур");
    expect((await lastCall(bff, "PUT", "/ai/agents/concierge/pause")).body).toEqual({ paused: true, reason: "Инцидент INC-42: аномальный расход" });
    expect(bff.audit[0]).toMatchObject({ action: "ai.agent.pause", object_id: "concierge" });
    await block(page, "bdg-agents", "12-agent-paused-light");
    // resume: no typing, reason + TOTP window is still open
    await c.getByTestId("bdg-kill").click();
    await page.getByTestId("kill-reason").fill("Расход в норме");
    await page.getByTestId("kill-ok").click();
    await expect(c.getByTestId("bdg-state")).toHaveText("Деградация");

    // agent configuration
    await c.getByTestId("bdg-config").click();
    const cfg = page.getByTestId("cfg-drawer");
    await cfg.getByTestId("cfg-per_request_max_usd").fill("1.5");
    await expect(cfg).toContainText("Сумма от 0.001 до 1 USD");
    await cfg.getByTestId("cfg-per_request_max_usd").fill("0,06");
    await cfg.getByTestId("cfg-degrade_at_pct").fill("85");
    await cfg.getByTestId("cfg-monthly_cap_usd").fill("");
    await expect(cfg.getByTestId("cfg-diff")).toContainText("monthly_cap_usd");
    await cfg.getByTestId("cfg-reason").fill("Раньше на Haiku в сезон");
    await shot(page, "13-agent-config-light");
    await cfg.getByTestId("cfg-save").click();
    await expect(cfg).toHaveCount(0);
    const p = (await lastCall(bff, "PATCH", "/ai/agents/concierge"));
    expect(p.body).toEqual({ degrade_at_pct: 85, per_request_max_usd: "0.06", monthly_cap_usd: null, reason: "Раньше на Haiku в сезон", expected_version: 4 });
    expect(p.headers["idempotency-key"]).toBeTruthy();

    // concierge budget in the limits block (own budget, not inside the AI total)
    await page.getByTestId("lim-concierge").fill("1,5");
    await page.getByTestId("lim-save").click();
    const lc = page.getByTestId("lim-confirm");
    await expect(lc.getByTestId("lim-diff")).toContainText("$1.50");
    await lc.locator("textarea").fill("Сезон: больше вопросов к консьержу");
    await lc.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("lim-concierge")).toHaveValue("1.50");
    expect((await lastCall(bff, "PUT", "/ai/limits")).body).toMatchObject({ concierge_daily_usd: "1.5", evaluation_daily_usd: "0.30", reason: "Сезон: больше вопросов к консьержу" });

    // alerts: acknowledge the 90 % one
    const al = page.locator(`[data-alert="${ALERT.a90}"]`).first();
    await al.getByTestId("ai-alert-ack").click();
    await expect(al).toContainText("просмотрел");

    // access levels: plus 20 → 25 with TOTP (window still open)
    await page.locator('[data-level="plus"]').getByTestId("lvl-edit").click();
    const lv = page.getByTestId("lvl-dialog");
    await lv.getByTestId("lvl-n").fill("1001");
    await lv.getByTestId("lvl-reason").fill("Больше сообщений партнёрам");
    await lv.getByTestId("lvl-ok").click();
    await expect(lv).toContainText("Целое число от 0 до 1000");
    await lv.getByTestId("lvl-n").fill("25");
    await shot(page, "14-level-edit-light");
    await lv.getByTestId("lvl-ok").click();
    await expect(page.locator('[data-level="plus"]').getByTestId("lvl-messages")).toHaveText("25");
    await block(page, "bdg-levels", "15-levels-light");
  });

  test("budgets: provider kill switch; ai-control down — overview from the gateway; audit down", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/budgets", { controlDown: true });
    await expect(page.getByTestId("bdg-control-down")).toBeVisible();
    await page.getByTestId("bdg-provider-kill").click();
    await page.getByTestId("kill-reason").fill("Утечка ключа: отзываем");
    await page.getByTestId("kill-type").fill("anthropic");
    await page.getByTestId("kill-ok").click();
    await totp(page);
    await expect(page.getByTestId("bdg-provider")).toContainText("Остановлен");
    await expect(page.locator('[data-testid="bdg-agent-row"][data-agent="news"]').getByTestId("bdg-state")).toHaveText("Остановлен");
    await shot(page, "16-provider-killed-control-down-light");
    await page.goto("about:blank");
    await openAs(page, "ops@tilhero.local", "#/budgets", { auditDown: true });
    await page.locator('[data-agent="news"]').getByTestId("bdg-kill").click();
    await page.getByTestId("kill-reason").fill("Проверка");
    await page.getByTestId("kill-type").fill("news");
    await page.getByTestId("kill-ok").click();
    await totp(page);
    await expect(page.getByTestId("kill-dialog")).toContainText("Журнал аудита недоступен, поэтому состояние не изменилось");
  });

  test("agents and skills: list, editor of every field, Test Console, review, four-eyes, publish with TOTP, compare, rollback", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/agents");
    await expect(page.getByTestId("agt-row")).toHaveCount(4);
    await expect(page.locator('[data-agent="discovery"]')).toContainText("промпт в коде шлюза");
    await shot(page, "20-agents-light");
    await page.locator('[data-skill="concierge.event"]').getByTestId("agt-open").click();
    await expect(page).toHaveURL(/#\/agents\/concierge\.event$/);
    await expect(page.getByTestId("page-title")).toHaveText("concierge.event");
    await expect(page.getByTestId("sk-stepper").locator('[aria-current="step"]')).toContainText("DRAFT");
    await expect(page.getByTestId("sk-instruction")).toHaveValue(/честно скажи/);
    await shot(page, "21-skill-editor-draft-light", true);

    // editor: a tool outside the agent list is impossible; the cost above the agent's per-request limit is an error
    await page.getByTestId("sk-maxcost").fill("0.06");
    await expect(page.getByTestId("sk-editor")).toContainText("Больше лимита агента на запрос");
    await page.getByTestId("sk-maxcost").fill("0.04");
    await page.getByTestId("sk-note").fill("Короче ответы; лимит запроса 0.04");
    await page.getByTestId("sk-save").click();
    await expect(page.getByTestId("sk-save")).toBeDisabled();
    const pt = (await lastCall(bff, "PATCH", "/skills/concierge.event/versions/3"));
    expect(pt.body).toMatchObject({ change_note: "Короче ответы; лимит запроса 0.04", limits: { max_cost_usd: "0.04" }, expected_version: 1 });
    expect(Object.keys(pt.body as object).sort()).toEqual(["change_note", "expected_version", "limits"]);

    // Test Console: compare with the active v2, the run finishes → TESTED
    await page.getByTestId("sk-tab-test").click();
    await expect(page.getByTestId("tc-cmp")).toHaveValue("2");
    await page.getByTestId("tc-run").click();
    await expect(page.getByTestId("tc-result")).toHaveAttribute("data-status", "done", { timeout: 10_000 });
    await expect(page.getByTestId("tc-verdict")).toContainText("TESTED");
    await expect(page.getByTestId("tc-table")).toContainText("tools_called:set_direct_only");
    await expect(page.getByTestId("sk-stepper").locator('[aria-current="step"]')).toContainText("TESTED");
    await shot(page, "22-test-console-light", true);

    // review: request, approve (another staff member authored the draft), publish with TOTP
    await page.getByTestId("sk-tab-editor").click();
    await page.getByTestId("sk-request-review").click();
    await expect(page.getByTestId("sk-stepper").locator('[aria-current="step"]')).toContainText("REVIEW");
    await page.getByTestId("sk-approve").click();
    await page.getByTestId("sk-review-comment").fill("Кейсы AT-28/29 зелёные");
    await page.getByTestId("sk-review-ok").click();
    await expect(page.getByTestId("sk-review")).toContainText("Одобрено");
    await page.getByTestId("sk-publish").click();
    const pub = page.getByTestId("sk-publish-confirm");
    await pub.locator("textarea").fill("Ревью пройдено, тест зелёный");
    await shot(page, "23-publish-confirm-light");
    await pub.getByTestId("confirm-ok").click();
    await totp(page);
    await expect(page.getByTestId("sk-readonly")).toBeVisible();
    await expect(page.getByTestId("skill")).toContainText("Активная версия в runtime: v3");
    await expect(page.getByTestId("sk-instruction")).toHaveAttribute("readonly", "");
    await shot(page, "24-published-readonly-light");

    // compare v2 → v3
    await page.getByTestId("sk-tab-compare").click();
    await expect(page.getByTestId("cmp-diff")).toContainText("честно скажи");
    await expect(page.getByTestId("cmp-fields")).toContainText("allowed_tools");
    await shot(page, "25-compare-light", true);

    // rollback to v2 = a new activation
    await page.locator('[data-testid="sk-versions"] [data-version="2"]').click();
    await page.getByTestId("sk-tab-editor").click();
    await page.getByTestId("sk-rollback").click();
    const rb = page.getByTestId("sk-confirm");
    await expect(rb).toContainText("v3 → v2");
    await rb.locator("textarea").fill("Жалобы на короткие ответы");
    await rb.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("skill")).toContainText("Активная версия в runtime: v2");
    await page.getByTestId("sk-tab-activations").click();
    await expect(page.getByTestId("act-row")).toHaveCount(4);
    await expect(page.getByTestId("act-row").first()).toContainText("откат");
    await shot(page, "26-activations-light");
    expect((await lastCall(bff, "POST", "/skills/concierge.event/rollback")).body).toEqual({ to_version: 2, reason: "Жалобы на короткие ответы" });
  });

  test("four-eyes: the author cannot approve; agent_manager edits but cannot publish", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/agents/concierge.event", { draftAuthor: "admin@tilhero.local" });
    await page.getByTestId("sk-tab-test").click();
    await page.getByTestId("tc-run").click();
    await expect(page.getByTestId("tc-result")).toHaveAttribute("data-status", "done", { timeout: 10_000 });
    await page.getByTestId("sk-tab-editor").click();
    await page.getByTestId("sk-request-review").click();
    await expect(page.getByTestId("sk-approve")).toBeDisabled();
    await expect(page.getByTestId("sk-four-eyes")).toBeVisible();
    await block(page, "sk-actions", "27-four-eyes-light");
    expect(bff.calls("POST", "/skills/concierge.event/versions/3/review").length).toBe(1);
  });

  test("user card: AI tab — access level with reason and expiry, 30-day usage, conversations metadata only", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", `#/users/${USER.igor}`);
    await expect(page.getByTestId("card-access-brief")).toContainText("Базовый");
    await page.getByTestId("user-tab-ai").click();
    await expect(page.getByTestId("uai-level")).toHaveText("Базовый");
    await expect(page.getByTestId("uai-conv")).toContainText("событие");
    await expect(page.getByTestId("uai-text-hidden")).toBeVisible();
    await shot(page, "30-user-ai-light");
    await page.getByTestId("uai-change").click();
    const dlg = page.getByTestId("uai-assign");
    await dlg.getByTestId("uai-level-sel").selectOption("plus");
    await dlg.getByTestId("uai-until-date").check();
    await dlg.getByTestId("uai-date").fill("2020-01-01");
    await dlg.getByTestId("uai-reason").fill("Партнёр фестиваля: TCK-3074");
    await dlg.getByTestId("uai-assign-ok").click();
    await expect(dlg).toContainText("Дата окончания — в будущем");
    const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    await dlg.getByTestId("uai-date").fill(future);
    await shot(page, "31-assign-level-light");
    await dlg.getByTestId("uai-assign-ok").click();
    await expect(page.getByTestId("uai-level")).toHaveText("Расширенный");
    await expect(page.getByTestId("user-access")).toContainText("Тимур");
    const put = (await lastCall(bff, "PUT", `/users/${USER.igor}/access-level`));
    expect(put.body).toMatchObject({ level: "plus", reason: "Партнёр фестиваля: TCK-3074", expires_at: `${future}T23:59:59Z`, expected_version: 0 });
    expect(put.headers["idempotency-key"]).toBeTruthy();
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "32-user-ai-dark");
  });

  test("support: no AI sections in the menu; card shows the level read-only", async ({ page }) => {
    await openAs(page, "support@tilhero.local", `#/users/${USER.igor}`);
    await expect(page.locator('[data-nav="requests"]')).toHaveCount(0);
    await expect(page.locator('[data-nav="budgets"]')).toHaveCount(0);
    await page.getByTestId("user-tab-ai").click();
    await expect(page.getByTestId("uai-change")).toHaveClass(/is-locked/);
    await expect(page.getByTestId("uai-requests")).toBeVisible();
  });

  test("bell: unacknowledged budget alerts, acknowledge, open budgets", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/dashboard");
    await expect(page.getByTestId("dash-ai-requests")).toContainText("74");
    await block(page, "dash-ai", "36-dashboard-ai-light");
    // sprint 8: one feed — 2 AI budget alerts + 2 unacknowledged ops-monitor alerts
    await expect(page.getByTestId("bell-count")).toHaveText("4");
    await page.getByTestId("bell").click();
    await expect(page.getByTestId("bell-list")).toContainText("90 % суточного бюджета");
    await expect(page.getByTestId("bell-list")).toContainText("AI-консьерж");
    await expect(page.getByTestId("bell-list")).not.toContainText("concierge ·");
    await shot(page, "33-bell-light");
    await page.getByTestId("bell-list").locator(`[data-alert="${ALERT.a90}"]`).getByTestId("ai-alert-ack").click();
    await expect(page.getByTestId("bell-list").locator("[data-alert]")).toHaveCount(3);
    await expect(page.getByTestId("bell-list").locator('[data-source="ai"]')).toHaveCount(1);
    await page.getByTestId("bell-open").click();
    await expect(page.getByTestId("page-budgets")).toBeVisible();
  });

  test("not connected: FEATURE_UNAVAILABLE names ai-control; English UI has no Cyrillic outside data", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/requests", { aiOff: true });
    await expect(page.getByTestId("req-error")).toContainText("ai-control");
    // sprint 8: the bell stays (ops-monitor alerts); «not connected» is a deployment state — no warning (review 8)
    await page.getByTestId("bell").click();
    await expect(page.getByTestId("bell-list")).toBeVisible();
    await expect(page.getByTestId("bell-partial")).toHaveCount(0);
    await expect(page.getByTestId("bell-list").locator('[data-source="ai"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await shot(page, "34-ai-off-light");
    await page.goto("about:blank");
    await openAs(page, "admin@tilhero.local", "#/budgets");
    await page.getByTestId("lang-en").click();
    await expect(page.getByTestId("page-title")).toHaveText("Budgets & limits");
    await expect(page.getByTestId("bdg-provider")).toContainText("Provider kill switch");
    const text = await page.getByTestId("bdg-levels").innerText();
    expect(text.replace(/Базовый|Расширенный/g, "")).not.toMatch(CYRILLIC);
    await shot(page, "35-budgets-en-light");
  });
});

test.describe("width 400", () => {
  test.use({ viewport: { width: 400, height: 860 } });

  test("requests, drill-down, budgets, skill and the user AI tab fit 400 px", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/requests");
    await expect(page.getByTestId("kpi-requests")).toBeVisible();
    await expectNoHScroll(page);
    await shot(page, "40-requests-400");
    await page.goto(`/#/requests/${REQ.cheaper}`);
    await expect(page.getByTestId("rq-cost")).toBeVisible();
    await expectNoHScroll(page);
    await shot(page, "41-drilldown-400");
    await page.goto("/#/budgets");
    await expect(page.getByTestId("bdg-agents")).toBeVisible();
    await expectNoHScroll(page);
    await shot(page, "42-budgets-400");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "42-budgets-400-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/#/agents/concierge.event");
    await expect(page.getByTestId("sk-editor")).toBeVisible();
    await expectNoHScroll(page);
    await shot(page, "43-skill-400");
    await page.goto(`/#/users/${USER.igor}`);
    await page.getByTestId("user-tab-ai").click();
    await expect(page.getByTestId("uai-bars")).toBeVisible();
    await expectNoHScroll(page);
    await shot(page, "44-user-ai-400");
  });
});

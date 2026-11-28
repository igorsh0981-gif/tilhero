/**
 * Sprint 8 «Корректировки» and the «Тариф» tab (ADM-USR-02, ADM-USR-04, ADM-MONEY-05, AT-95): the learner card shows the
 * tier, the period, the minutes left, the holds and the ledger (a child — the guardian's account, no prices); a request
 * of «four eyes» is filed with a reason and a fresh TOTP; the author never sees «Подтвердить» (only «Отозвать»), another
 * staff member approves it with step-up and the minutes change; the requests of one account are a link from the tab.
 */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { LEARNER } from "./fixtures/data";
import { ADJ, PERIOD } from "./fixtures/money-data";

const REASON = "Урок прервался по нашей вине, компенсация TCK-1050";

test("the «Тариф» tab: period, minutes, holds, ledger; a child profile shares the guardian's account", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", `#/users/${LEARNER.madina}`);
  await page.getByTestId("lc-tab-billing").click();
  const tab = page.getByTestId("lb");
  await expect(tab.getByTestId("lb-status")).toContainText("подписка активна");
  await expect(tab.getByTestId("lb-left")).toContainText("170");
  await expect(tab.getByTestId("lb-period")).toContainText("из 300");
  await expect(tab.getByTestId("lb-ledger")).toContainText("списано за занятие");
  await expect(tab.getByTestId("lb-pending")).toContainText("1");
  // the learners list: the tier column and the filter
  await page.goto("/#/users");
  await expect(page.getByTestId(`lr-tier-${LEARNER.madina}`)).toContainText("подписка");
  await expect(page.getByTestId(`lr-tier-${LEARNER.kamila}`)).toContainText("бесплатный");
  await page.getByTestId("lr-tier").selectOption("paid");
  await expect(page.getByTestId(`lr-tier-${LEARNER.kamila}`)).toHaveCount(0);
  await expect(page.getByTestId(`lr-tier-${LEARNER.madina}`)).toBeVisible();
  // a child: the guardian's account, a notice that a child does not pay
  await page.goto(`/#/users/${LEARNER.lola}`);
  await page.getByTestId("lc-tab-billing").click();
  await expect(page.getByTestId("lb-child")).toContainText("Ребёнок не платит и цен не видит");
  await expect(page.getByTestId("lb-status")).toContainText("пробный");
});

test("four eyes: the author files a request with step-up and sees only «Отозвать»; another staff member approves it", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", `#/users/${LEARNER.madina}`);
  await page.getByTestId("lc-tab-billing").click();
  await page.getByTestId("lb-adjust").click();
  const dlg = page.getByTestId("lb-adjust-dialog");
  await dlg.getByTestId("lb-period").selectOption(PERIOD.madina);
  await dlg.getByTestId("lb-minutes").fill("-500");
  await dlg.getByTestId("lb-reason").fill(REASON);
  await dlg.getByTestId("lb-adjust-ok").click();
  await expect(dlg).toContainText("Снять можно не больше доступного остатка");
  await dlg.getByTestId("lb-minutes").fill("+30");
  await dlg.getByTestId("lb-adjust-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Заявка отправлена — ждёт другого сотрудника")).toBeVisible();
  const posts = bff.calls("POST", `/billing/accounts/${LEARNER.madina}/adjustments`);
  expect(posts).toHaveLength(2);
  expect(posts[1]!.headers["idempotency-key"]).toBe(posts[0]!.headers["idempotency-key"]);
  expect(posts[1]!.body).toEqual({ kind: "minutes", minutes: 30, period_id: PERIOD.madina, reason: REASON });
  const mine = bff.money.adjustments[0]!;

  // the author: no «Подтвердить» on the own request, «Отозвать» is there; Нодира's request can be approved
  await page.goto("/#/adjustments");
  await expect(page.getByTestId(`adj-${mine.adjustment_id}`)).toBeVisible();
  await expect(page.getByTestId(`adj-approve-${mine.adjustment_id}`)).toHaveCount(0);
  await expect(page.getByTestId(`adj-cancel-${mine.adjustment_id}`)).toBeVisible();
  await expect(page.getByTestId(`adj-own-${mine.adjustment_id}`)).toContainText("подтверждает другой");
  await expect(page.getByTestId(`adj-approve-${ADJ.byNodira}`)).toBeVisible();

  // another staff member (operations) approves the request of the author with step-up
  bff.switchTo("ops@tilhero.local");
  await page.goto("/#/adjustments");
  await page.reload();
  await page.getByTestId(`adj-approve-${mine.adjustment_id}`).click();
  const ap = page.getByTestId("adj-approve-dialog");
  await expect(ap).toContainText("+30 мин к периоду");
  await ap.getByTestId("adj-dialog-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Заявка применена")).toBeVisible();
  expect(bff.money.adjustments[0]).toMatchObject({ status: "applied", decided_by: { name: "Тимур" }, before_value: { minutes_left: 170 }, after_value: { minutes_left: 200 } });
  // the ledger of the learner has the adjustment by Тимур
  await page.goto(`/#/users/${LEARNER.madina}`);
  await page.getByTestId("lc-tab-billing").click();
  await expect(page.getByTestId("lb-ledger")).toContainText("корректировка");
  await expect(page.getByTestId("lb-left")).toContainText("200");
});

test("the author of the seeded request sees only «Отозвать»; the requests of one account from the tab", async ({ page }) => {
  const bff = await openAs(page, "security@tilhero.local", "#/adjustments");
  // Нодира is the author of the seeded request: only «Отозвать»
  await expect(page.getByTestId(`adj-approve-${ADJ.byNodira}`)).toHaveCount(0);
  await expect(page.getByTestId(`adj-cancel-${ADJ.byNodira}`)).toBeVisible();
  expect(bff.money.adjustments.find((a) => a.adjustment_id === ADJ.byNodira)!.status).toBe("pending");
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  await page.goto(`/#/users/${LEARNER.madina}`);
  await page.getByTestId("lc-tab-billing").click();
  await page.getByTestId("lb-pending").click();
  await expect(page.getByTestId("adj-account")).toContainText("Заявки аккаунта");
  await expect(page).toHaveURL(new RegExp(`#/adjustments/${LEARNER.madina}$`));
  const last = urls.filter((u) => u.includes("/admin/v1/billing/adjustments?")).at(-1)!;
  expect(new URL(last).searchParams.get("account_id")).toBe(LEARNER.madina);
});

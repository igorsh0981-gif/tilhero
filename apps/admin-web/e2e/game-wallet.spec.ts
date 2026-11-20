/**
 * Sprint 6 «Геймификация → Кошельки» (ADM-GAME-03 LinguaFlow, AT-72): the wallet from the learner card; balance, hero,
 * inventory, quests, badges, referrals and the ledger with its origin and a currency filter; a manual operation
 * (wallet.adjust, step-up, reason ≥ 10, «a separate record, a correction — a reversal»), a reversal, a refund of a
 * purchase; the balance never below zero; a direct request without the right answers in words.
 */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { LEARNER } from "./fixtures/data";
import { OP, PURCHASE } from "./fixtures/game-data";

test("from the learner card: the «Игра» tab → the wallet with its ledger and a currency filter", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local", `#/users/${LEARNER.madina}`);
  await page.getByTestId("lc-tab-game").click();
  await expect(page.getByTestId("lc-game")).toContainText("355 XP всего");
  await page.getByTestId("lc-game-open").click();
  await expect(page.getByTestId("wl")).toHaveAttribute("data-user", LEARNER.madina);
  await expect(page.getByTestId("wl-level")).toContainText("3");
  await expect(page.getByTestId("wl-til")).toHaveText("105");
  await expect(page.getByTestId("wl-freeze")).toHaveText("3");
  await expect(page.getByTestId("wl-hero")).toContainText("Робот Вольт");
  await expect(page.getByTestId("wl-referrals")).toContainText("ждут 1 · награждены 2 · сверх лимита 0");
  await expect(page.getByTestId("wl-inventory")).toContainText("bg_night_notebook");
  await expect(page.getByTestId("wl-badges")).toContainText("Серия 7 дней");
  // the ledger: newest first, origin of each operation, the staff reason (staff only), paging
  const rows = page.getByTestId("wl-led-rows").locator("tbody tr");
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toHaveAttribute("data-reason", "review");
  await expect(page.getByTestId(`wl-op-comment-${OP(16)}`)).toContainText("Компенсация за сбой урока");
  await expect(page.getByTestId(`wl-op-${OP(14)}`)).toContainText("урезано лимитом");
  await expect(page.getByTestId(`wl-op-${OP(9)}`)).toContainText("×2");
  await page.getByTestId("wl-led-more").click();
  await expect(rows).toHaveCount(19);
  await page.getByTestId("wl-led-cur").getByRole("button", { name: "Заморозки" }).click();
  await expect(rows).toHaveCount(4);
  expect(bff.calls("GET", `/game/wallets/${LEARNER.madina}/ledger`).at(-1)).toBeTruthy();
  // support has game.read only: no commands
  await expect(page.getByTestId("wl-adjust")).toHaveCount(0);
  await expect(page.getByTestId(`wl-reverse-${OP(16)}`)).toHaveCount(0);
  await expect(page.getByTestId("wl-refund-bg_night_notebook")).toHaveCount(0);
  await expect(page.getByTestId("wl-ro")).toContainText("wallet.adjust");
});

test("manual operation: a separate record with step-up and a reason; the balance never below zero", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/game/wallets/${LEARNER.madina}`);
  await page.getByTestId("wl-adjust").click();
  const dlg = page.getByTestId("wl-adjust-dialog");
  await expect(dlg.getByTestId("wl-adjust-warn")).toContainText("Операция будет отдельной записью в реестре. Прежние записи не меняются; исправление — обратной записью.");
  // a debit larger than the balance is refused in the dialog
  await dlg.getByTestId("wl-dir").getByRole("button", { name: "Списать" }).click();
  await dlg.getByTestId("wl-amount").fill("106");
  await expect(dlg).toContainText("Списание больше остатка (105 тилов)");
  await expect(dlg.getByTestId("confirm-ok")).toBeDisabled();
  await dlg.getByTestId("wl-amount").fill("10001");
  await expect(dlg).toContainText("Целое число от 1 до 10 000");
  // a credit of 40 tils
  await dlg.getByTestId("wl-dir").getByRole("button", { name: "Начислить" }).click();
  await dlg.getByTestId("wl-amount").fill("40");
  await expect(dlg.getByTestId("wl-after")).toHaveText("145 тилов");
  await dlg.locator("#cmd-reason").fill("TCK-1042");
  await dlg.getByTestId("confirm-ok").click();
  await expect(dlg).toContainText("не короче 10");
  await dlg.locator("#cmd-reason").fill("Компенсация за сбой урока, TCK-1042");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Операция проведена: +40 тилов")).toBeVisible();
  await expect(page.getByTestId("wl-til")).toHaveText("145");
  const calls = bff.calls("POST", `/game/wallets/${LEARNER.madina}/adjustments`);
  expect(calls).toHaveLength(2); // 403 STEP_UP_REQUIRED, then the same command with the same key
  expect(calls[1]!.headers["idempotency-key"]).toBe(calls[0]!.headers["idempotency-key"]);
  expect(calls[1]!.body).toEqual({ currency: "til", amount: 40, reason: "Компенсация за сбой урока, TCK-1042" });
  const first = page.getByTestId("wl-led-rows").locator("tbody tr").first();
  await expect(first).toHaveAttribute("data-reason", "manual");
  await expect(first).toContainText("+40 тилов");
  await expect(first).toContainText("Причина: Компенсация за сбой урока, TCK-1042");
  expect(bff.game.audit.at(-1)).toMatchObject({ action: "game.wallet_adjusted", reason: "Компенсация за сбой урока, TCK-1042" });
});

test("reversal: a new record, the original becomes «reversed»; a repeat answers ALREADY_REVERSED; the server keeps the balance ≥ 0", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/game/wallets/${LEARNER.madina}`);
  await page.getByTestId(`wl-reverse-${OP(16)}`).click();
  const dlg = page.getByTestId("wl-reverse-dialog");
  await expect(dlg).toContainText("Обратная запись к операции +25 тилов?");
  await expect(dlg).toContainText("В реестр добавится запись −25 тилов");
  await dlg.locator("#cmd-reason").fill("Компенсация начислена по ошибке");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Обратная запись проведена: −25 тилов")).toBeVisible();
  await expect(page.getByTestId("wl-til")).toHaveText("80");
  await expect(page.getByTestId(`wl-op-${OP(16)}`)).toHaveAttribute("data-status", "reversed");
  await expect(page.getByTestId(`wl-reverse-${OP(16)}`)).toHaveCount(0);
  const first = page.getByTestId("wl-led-rows").locator("tbody tr").first();
  await expect(first).toHaveAttribute("data-reason", "reversal");
  await expect(first).toContainText(`к операции ${OP(16).slice(0, 8)}`);
  // the original record is not changed except its status — the ledger is append-only
  const orig = bff.game.wallets[0]!.ledger.find((o) => o.op_id === OP(16))!;
  expect(orig.amount).toBe(25);
  expect(orig.comment).toBe("Компенсация за сбой урока, обращение TCK-1042");

  // another staff member reversed an operation while this dialog was open: 409 ALREADY_REVERSED, the ledger refreshes
  await page.getByTestId(`wl-reverse-${OP(15)}`).click();
  const d1 = page.getByTestId("wl-reverse-dialog");
  const q = bff.game.wallets[0]!.ledger.find((o) => o.op_id === OP(15))!;
  q.status = "reversed";
  q.reversed_by = OP(91);
  await d1.locator("#cmd-reason").fill("Задание засчитано дважды");
  await d1.getByTestId("confirm-ok").click();
  await expect(d1).toContainText("Эта операция уже отменена обратной записью");
  await expect(page.getByTestId(`wl-op-${OP(15)}`)).toHaveAttribute("data-status", "reversed");
  await page.keyboard.press("Escape");

  // a reversal that would take tils below zero: the dialog warns, the server answers BALANCE_NEGATIVE
  bff.game.wallets[0]!.ledger.push({ ...orig, op_id: OP(90), amount: -80, reason: "shop", status: "confirmed", reversed_by: null, comment: null });
  await page.reload();
  await expect(page.getByTestId("wl-til")).toHaveText("0");
  await page.getByTestId(`wl-reverse-${OP(12)}`).click();
  const d2 = page.getByTestId("wl-reverse-dialog");
  await expect(d2.getByTestId("wl-reverse-below")).toBeVisible();
  await d2.locator("#cmd-reason").fill("Проверяем отрицательный баланс");
  // the warning blocks the command: nothing is sent
  await expect(d2.getByTestId("confirm-ok")).toBeDisabled();
  await d2.getByTestId("confirm-ok").click({ force: true });
  expect(bff.calls("POST", `/game/wallets/${LEARNER.madina}/ledger/${OP(12)}/reverse`)).toHaveLength(0);
});

test("a purchase is not reversed but refunded: «Вернуть покупку» in the ledger by source.ref, a freeze purchase too", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/game/wallets/${LEARNER.madina}`);
  // a cosmetic purchase on the first page: no reversal, a refund by its purchase
  await expect(page.getByTestId(`wl-op-${OP(8)}`)).toBeVisible();
  await expect(page.getByTestId(`wl-reverse-${OP(8)}`)).toHaveCount(0);
  await expect(page.getByTestId(`wl-refund-op-${OP(8)}`)).toBeVisible();
  // the freeze purchase (two operations, no inventory item) — one action on the purchase
  await page.getByTestId("wl-led-more").click();
  await expect(page.getByTestId(`wl-op-${OP(19)}`)).toBeVisible();
  for (const n of [18, 19]) await expect(page.getByTestId(`wl-reverse-${OP(n)}`)).toHaveCount(0);
  await expect(page.getByTestId(`wl-refund-op-${OP(18)}`)).toHaveCount(0);
  await page.getByTestId(`wl-refund-op-${OP(19)}`).click();
  const dlg = page.getByTestId("wl-refund-dialog");
  await expect(dlg.getByTestId("wl-refund-purchase")).toContainText(PURCHASE.madinaFreeze);
  await expect(dlg.getByTestId("wl-refund-ops")).toHaveText("Операции покупки: +1 заморозка · −40 тилов");
  await expect(dlg).toContainText("купленные заморозки спишутся");
  await dlg.locator("#cmd-reason").fill("Заморозка куплена по ошибке, TCK-1077");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText(/возвращена · обратных записей: 2/)).toBeVisible();
  await expect(page.getByTestId("wl-til")).toHaveText("145");
  await expect(page.getByTestId("wl-freeze")).toHaveText("2");
  const calls = bff.calls("POST", `/game/wallets/${LEARNER.madina}/purchases/${PURCHASE.madinaFreeze}/refund`);
  expect(calls.at(-1)!.body).toEqual({ reason: "Заморозка куплена по ошибке, TCK-1077" });
  expect(calls.at(-1)!.headers["idempotency-key"]).toBeTruthy();
  // the ledger reloads from its first page: two reversals on top, the purchase operations are «reversed»
  await expect(page.getByTestId("wl-led-rows").locator("tbody tr").first()).toHaveAttribute("data-reason", "reversal");
  expect(bff.game.wallets[0]!.ledger.filter((o) => o.source.ref === PURCHASE.madinaFreeze).map((o) => o.status)).toEqual(["reversed", "reversed"]);

  // a stale ledger: the operation turned out to be a purchase — the server refuses its reversal, the text says how
  bff.game.wallets[0]!.ledger.find((o) => o.op_id === OP(16))!.reason = "shop";
  await page.getByTestId(`wl-reverse-${OP(16)}`).click();
  const d2 = page.getByTestId("wl-reverse-dialog");
  await d2.locator("#cmd-reason").fill("Отменяем начисление по ошибке");
  await d2.getByTestId("confirm-ok").click();
  await expect(d2).toContainText("покупку отменяют возвратом");
});

test("a manual operation with an unknown outcome (the answer is lost): the wallet and the ledger reload, the retry reuses the key", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/game/wallets/${LEARNER.madina}`, { game: { adjustLostOnce: true } });
  await page.getByTestId("wl-adjust").click();
  const dlg = page.getByTestId("wl-adjust-dialog");
  await dlg.getByTestId("wl-amount").fill("40");
  await dlg.locator("#cmd-reason").fill("Компенсация за сбой урока, TCK-1042");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(dlg).toContainText("проверьте журнал перед повтором");
  // the operation went through: the wallet and the ledger already show it
  await expect(page.getByTestId("wl-til")).toHaveText("145");
  await expect(page.getByTestId("wl-led-rows").locator("tbody tr").first()).toContainText("+40 тилов");
  // the staff member retries anyway: the same Idempotency-Key — the server replays, no second operation
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByText("Операция проведена: +40 тилов")).toBeVisible();
  const calls = bff.calls("POST", `/game/wallets/${LEARNER.madina}/adjustments`).filter((c) => c.headers["idempotency-key"]);
  const keys = new Set(calls.map((c) => c.headers["idempotency-key"]));
  expect(keys.size).toBe(1);
  expect(bff.game.wallets[0]!.ledger.filter((o) => o.reason === "manual" && o.amount === 40)).toHaveLength(1);
  await expect(page.getByTestId("wl-til")).toHaveText("145");
});

test("refund of a purchase: reversals of its operations, the item leaves the inventory", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/game/wallets/${LEARNER.madina}`);
  await page.getByTestId("wl-refund-bg_night_notebook").click();
  const dlg = page.getByTestId("wl-refund-dialog");
  await dlg.locator("#cmd-reason").fill("Купил по ошибке, просьба в TCK-1051");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Покупка bg_night_notebook возвращена · обратных записей: 1")).toBeVisible();
  await expect(page.getByTestId("wl-til")).toHaveText("225");
  await expect(page.getByTestId("wl-inventory")).toContainText("Купленных предметов нет");
  expect(bff.calls("POST", `/game/wallets/${LEARNER.madina}/purchases/${PURCHASE.madinaBg}/refund`).at(-1)!.body).toEqual({ reason: "Купил по ошибке, просьба в TCK-1051" });
});

test("a direct request without wallet.adjust is refused with a clear text; a wallet that does not exist is a calm state", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", `#/game/wallets/${LEARNER.madina}`, { deny: { [`POST /game/wallets/${LEARNER.madina}/adjustments`]: "wallet.adjust" } });
  await page.getByTestId("wl-adjust").click();
  const dlg = page.getByTestId("wl-adjust-dialog");
  await dlg.getByTestId("wl-amount").fill("5");
  await dlg.locator("#cmd-reason").fill("Проверка права на ручную операцию");
  await dlg.getByTestId("confirm-ok").click();
  await expect(dlg).toContainText("Недостаточно прав: нужно право wallet.adjust");
  await page.keyboard.press("Escape");
  await page.evaluate((id) => (window.location.hash = `#/game/wallets/${id}`), LEARNER.anya);
  await expect(page.getByTestId("wl-none")).toContainText("Кошелька ещё нет");
  await page.getByTestId("wl-back").click();
  await page.getByTestId("wl-uid").fill("not-a-uuid");
  await page.getByTestId("wl-uid-go").click();
  await expect(page.getByTestId("wl-lookup")).toContainText("Введите UUID ученика");
  await page.getByTestId("wl-uid").fill(LEARNER.lola);
  await page.getByTestId("wl-uid-go").click();
  await expect(page.getByTestId("wl-hero")).toContainText("Дракончик Мятик");
});

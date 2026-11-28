/**
 * Страница заказа и история (AT-86, AT-96 — сторона сайта): возврат с провайдера на /orders/{order_no} (параметры
 * провайдера убираются из адреса), опрос статуса до «выполнен», фискальный чек, повторный переход к оплате, отмена,
 * история заказов сайта с подгрузкой.
 */
import { expect, test } from "@playwright/test";
import { NEVER, orderFixture } from "./fixtures/mock-bff";
import { expectAddress, expectClean, setup } from "./helpers";

test("возврат с провайдера: адрес очищен, опрос статуса → «Выполнен», чек https с noopener", async ({ page }) => {
  const w = await setup(page, { orders: [orderFixture({ order_no: 1001 })], pollsToPaid: 1 });
  await page.goto("/orders/1001?payment_id=777&payment_status=2");
  await expectAddress(page, "/orders/1001");
  const card = page.getByTestId("order");
  await expect(card.getByRole("heading", { name: "Заказ № 1001" })).toBeVisible();
  await expect(card.getByTestId("order-amount")).toHaveText("49 000 сум");
  await expect(card).toContainText("Payme");
  await expect(card.getByText("Проверяем оплату…")).toBeVisible();
  await expect(card.getByText("Выполнен")).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("Готово! Подписка активна — откройте TilHero в Telegram.");
  const receipt = card.getByRole("link", { name: /Открыть чек/ });
  await expect(receipt).toHaveAttribute("href", /^https:\/\/ofd\.soliq\.uz\//);
  await expect(receipt).toHaveAttribute("rel", "noopener noreferrer");
  await expect(card.getByRole("button", { name: "Отменить заказ" })).toHaveCount(0);
  expect(w.bff.requests.filter((r) => r.path === "/orders/1001").length).toBeGreaterThanOrEqual(3);
  expectClean(w);
});

test("неоплаченный заказ: «Перейти к оплате» — навигация на провайдера; «Отменить» → «Отменён»", async ({ page }) => {
  const w = await setup(page, { orders: [orderFixture({ order_no: 1002 }), orderFixture({ order_no: 1003 })], pollsToPaid: NEVER });
  await page.goto("/orders/1002");
  const card = page.getByTestId("order");
  await expect(card.getByText("Ожидает оплаты")).toBeVisible();
  await card.getByRole("button", { name: "Отменить заказ" }).click();
  await expect(card.getByText("Отменён")).toBeVisible();
  await expect(card.getByRole("button", { name: "Перейти к оплате" })).toHaveCount(0);
  expect(w.bff.posts("/orders/1002/cancel")).toHaveLength(1);

  await page.goto("/orders/1003");
  await page.getByRole("button", { name: "Перейти к оплате" }).click();
  await page.waitForURL(/^https:\/\/checkout\.paycom\.uz\//);
});

test("отмена не удалась (409 ORDER_STATE) — сообщение", async ({ page }) => {
  await setup(page, {
    orders: [orderFixture({ order_no: 1004 })],
    pollsToPaid: NEVER,
    failOnce: { "POST /orders/1004/cancel": { status: 409, code: "ORDER_STATE", details: { status: "paid" } } },
  });
  await page.goto("/orders/1004");
  await page.getByRole("button", { name: "Отменить заказ" }).click();
  await expect(page.getByRole("alert")).toContainText("Заказ уже нельзя изменить");
});

test("возврат и ссылка не https: чек скрыт, статус возврата показан", async ({ page }) => {
  await setup(page, {
    orders: [
      orderFixture({
        order_no: 1005,
        status: "refunded",
        checkout_url: null,
        paid_at: "2026-11-21T09:00:00Z",
        receipt_url: "http://insecure.example/check",
        refund: { status: "awaiting_provider", receipt_url: null },
      }),
    ],
  });
  await page.goto("/orders/1005");
  const card = page.getByTestId("order");
  await expect(card.getByText("Возвращён")).toBeVisible();
  await expect(card).toContainText("ожидает платёжную систему");
  await expect(card.getByRole("link", { name: /Открыть чек/ })).toHaveCount(0);
  await expect(card).toContainText("21 ноября 2026, 14:00");
});

test("чужой или неизвестный заказ — «Заказ не найден»", async ({ page }) => {
  await setup(page);
  await page.goto("/orders/9999");
  await expect(page.getByText("Заказ не найден.")).toBeVisible();
});

test("история: только заказы сайта, суммы в сумах, подгрузка «Показать ещё», переход в заказ", async ({ page }) => {
  const orders = Array.from({ length: 5 }, (_, i) =>
    orderFixture({ order_no: 1100 + i, status: i % 2 ? "fulfilled" : "expired", checkout_url: null, amount_tiyin: 500_000 * (i + 1) }),
  );
  const w = await setup(page, { orders, pageSize: 3 });
  await page.goto("/");
  await page.getByRole("link", { name: "Мои заказы" }).click();
  const list = page.getByTestId("orders");
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list.getByRole("listitem").first()).toContainText("№ 1104");
  await expect(list.getByRole("listitem").first()).toContainText("25 000 сум");
  await page.getByRole("button", { name: "Показать ещё" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Показать ещё" })).toHaveCount(0);
  expect(w.bff.requests.some((r) => r.path === "/orders?cursor=3")).toBe(true);
  await list.getByRole("link", { name: /№ 1100/ }).click();
  await expectAddress(page, "/orders/1100");
  await expect(page.getByTestId("order")).toContainText("Срок оплаты истёк");
});

test("история пуста — пояснение", async ({ page }) => {
  await setup(page);
  await page.goto("/orders");
  await expect(page.getByText("Заказов на сайте пока нет.")).toBeVisible();
});

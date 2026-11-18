/**
 * Billing — тех. долг. Маршрут возврата существует ради проверки прав (A31): без billing.refund →
 * 403 PERMISSION_DENIED (до вызова чего-либо), с правом → 501 BILLING_NOT_AVAILABLE.
 */
import { AppError } from "@tilhero/ts-common";
import type { App } from "../http.js";
import { requirePermission } from "../rbac.js";
import { params, str } from "../schemas.js";
import { ERROR_BODY } from "../responses.js";

export function billingRoutes(app: App): void {
  app.post<{ Params: { paymentId: string } }>(
    "/admin/v1/billing/payments/:paymentId/refunds",
    {
      config: requirePermission("billing.refund"),
      schema: { response: { 501: ERROR_BODY }, params: params({ paymentId: str(1, 64, { pattern: "^[A-Za-z0-9_-]+$" }) }) },
    },
    async () => {
      throw new AppError(501, "BILLING_NOT_AVAILABLE", "Модуль платежей ещё не подключён");
    },
  );
}

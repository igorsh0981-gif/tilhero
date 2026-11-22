/** EN texts of sprint 8 «Деньги» — the same keys as ru.money.ts. */
export const enMoney = {
  "role.finance": "Finance",
  "role.desc.finance": "tariffs and products, orders and payments, refunds, reconciliation, rates, finance overview; AI costs — read",
  "perm.billing.read": "Money: catalogue, orders, payments, learner subscription and minutes, reconciliation, reports — read",
  "perm.billing.manage": "Money: catalogue draft and check, USD and Stars rates, reconciliation, manual run",
  "perm.billing.publish": "Money: activate and roll back the catalogue, grant the trial to everyone (step-up)",
  "perm.billing.approve": "Money: approve or reject another person's adjustment request (step-up)",
  "perm.billing.refund": "Money: refund an order (step-up, reason)",
  "perm.subscriptions.override": "Subscriptions: request a minutes adjustment, a period grant or revocation (step-up, reason)",
} as const;

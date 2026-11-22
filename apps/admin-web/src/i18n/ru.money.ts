/**
 * RU texts of sprint 8 «Деньги» (поток 0 — каркас): the role `finance` and the new permissions. Screens «Деньги»,
 * «Тариф» of the learner card, the overview block `money` and «Затраты ИИ» add their keys here (поток F). Merged into
 * the same dictionary (MessageKey); EN — en.money.ts, the same keys.
 */
export const ruMoney = {
  "role.finance": "Финансы",
  "role.desc.finance": "тарифы и товары, заказы и платежи, возвраты, сверка, курсы, финансовый обзор; затраты ИИ — чтение",
  "perm.billing.read": "Деньги: каталог, заказы, платежи, подписка и минуты ученика, сверка, отчёты — просмотр",
  "perm.billing.manage": "Деньги: черновик каталога и проверка, курсы USD и Stars, разбор сверки, ручной прогон",
  "perm.billing.publish": "Деньги: активация и откат каталога, массовая выдача пробного (step-up)",
  "perm.billing.approve": "Деньги: подтверждение или отклонение чужой заявки на корректировку (step-up)",
  "perm.billing.refund": "Деньги: возврат по заказу (step-up, причина)",
  "perm.subscriptions.override": "Подписки: заявка на корректировку минут, выдачу или отзыв периода (step-up, причина)",
} as const;

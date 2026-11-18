/**
 * RBAC admin-bff: декларативные требования маршрутов и эффективные права (с учётом имперсонации). Содержимое
 * AI-переписок в ответах не появляется вовсе (спринт 7: карточка — только метаданные, раскрытие — отдельная команда).
 *
 * Каждый маршрут /admin/v1/* ОБЯЗАН объявить доступ (fail-closed): `publicAuth(...)` для шагов входа или
 * `requirePermission(...)` / `requireRole(...)` / `authenticated()` для сессионных; `requireStepUp()` —
 * дополнительно. Маршрут без объявления не регистрируется (ошибка при старте, см. app.ts → onRoute).
 * Проверка — в onRequest ДО разбора тела и вызова домена; домен проверяет права повторно (защита в глубину).
 */
import type { Permission, RoleCode } from "@tilhero/contracts/admin";

export type Guard =
  | { kind: "authenticated" }
  | { kind: "permission"; anyOf: Permission[] }
  | { kind: "role"; role: RoleCode };

/** Лимит маршрута: login — 10/мин IP; auth_step — шаги входа по challenge; step_up — 5/мин на сотрудника. */
export type RateClass = "login" | "auth_step" | "step_up";

export interface AccessConfig {
  access: "public" | "session";
  guard?: Guard;
  stepUp?: boolean;
  rate?: RateClass;
}

/** Шаг входа до сессии: обязательна проверка Origin, лимит по IP. */
export const publicAuth = (rate: RateClass): AccessConfig => ({ access: "public", rate });

/** Любой вошедший сотрудник (me, logout, step-up). */
export const authenticated = (rate?: RateClass): AccessConfig => ({
  access: "session",
  guard: { kind: "authenticated" },
  ...(rate ? { rate } : {}),
});

/** Нужно хотя бы одно из перечисленных прав (эффективных, с учётом имперсонации). */
export const requirePermission = (...anyOf: [Permission, ...Permission[]]): AccessConfig => ({
  access: "session",
  guard: { kind: "permission", anyOf },
});

/** Нужна роль (four-eyes: approve/reject — только super_admin). */
export const requireRole = (role: RoleCode): AccessConfig => ({ access: "session", guard: { kind: "role", role } });

/** Повторная проверка TOTP не старше окна step-up (5 мин). Комбинируется с requirePermission/requireRole. */
export const requireStepUp = (): Pick<AccessConfig, "stepUp"> => ({ stepUp: true });

export const ALL_PERMISSIONS = [
  "dashboard.read",
  "users.read",
  "users.sensitive.read",
  "ai.content.read",
  "export.csv",
  "support.read",
  "support.reply",
  "support.manage",
  "subscriptions.override",
  "billing.refund",
  "skills.edit",
  "skills.publish",
  "audit.read",
  "config.read",
  "config.edit",
  "config.publish",
  "ops.kill_switch",
  "staff.manage",
  "roles.manage",
  // спринт 4: AI-поиск событий
  "events.review",
  "sources.manage",
  "discovery.manage",
  // спринт 6: ленты и модерация новостей
  "news.manage",
  // спринт 7: уровень доступа к AI пользователю
  "users.access.manage",
  // спринт 8: DLQ — маскированный payload, повтор и удаление (привилегированное, admin-identity 0008)
  "ops.queues.manage",
] as const satisfies readonly Permission[];

/** Компиляция падает, если в admin.ts появилось право, которого нет в ALL_PERMISSIONS (права вне списка отбрасываются). */
type MissingPermissions = Exclude<Permission, (typeof ALL_PERMISSIONS)[number]>;
const _allPermissionsListed: [MissingPermissions] extends [never] ? true : MissingPermissions = true;
void _allPermissionsListed;

export const ROLE_CODES: readonly RoleCode[] = [
  "super_admin",
  "operations",
  "support",
  "billing",
  "agent_manager",
  "analyst",
  "auditor",
  "read_only",
];

/**
 * Матрица по умолчанию (docs/sprint2/INTERNAL_API.md, + права спринта 4 — docs/sprint4/INTERNAL_API.md §7, спринта 6 — docs/sprint6/INTERNAL_API.md §8, спринта 7 — docs/sprint7/INTERNAL_API.md §4, спринта 8 — docs/sprint8/INTERNAL_API.md §7.6) — только для имперсонации в dev: эффективные права =
 * свои ∩ права выбранной роли (сужение, не расширение). Источник истины матрицы — admin-identity.
 */
export const DEFAULT_ROLE_MATRIX: Readonly<Record<RoleCode, readonly Permission[]>> = {
  super_admin: ALL_PERMISSIONS,
  operations: [
    "dashboard.read",
    "users.read",
    "support.read",
    "config.read",
    "ops.kill_switch",
    "audit.read",
    "events.review",
    "sources.manage",
    "discovery.manage",
    "news.manage",
    "users.access.manage",
    "ops.queues.manage",
  ],
  support: ["dashboard.read", "users.read", "support.read", "support.reply"],
  billing: ["dashboard.read", "users.read", "subscriptions.override", "billing.refund"],
  agent_manager: ["dashboard.read", "skills.edit"],
  analyst: ["dashboard.read", "users.read"],
  auditor: ["dashboard.read", "audit.read"],
  read_only: ["dashboard.read"],
};

export interface Effective {
  /** Настоящая роль сотрудника (имперсонация роль НЕ меняет: actor-токен и проверки requireRole — по ней). */
  role: RoleCode;
  permissions: Permission[];
  /** Примеряемая роль (только ENV=dev и только если её права ⊆ своих), иначе null. */
  impersonating: RoleCode | null;
}

function ownPermissions(own: readonly string[]): Permission[] {
  return [...new Set(own.filter((p): p is Permission => (ALL_PERMISSIONS as readonly string[]).includes(p)))].sort();
}

/** Имперсонация допустима только роли, все права которой (матрица по умолчанию) у сотрудника уже есть. */
export function canImpersonate(own: readonly string[], role: RoleCode): boolean {
  const mine = new Set(own);
  return (DEFAULT_ROLE_MATRIX[role] ?? []).every((p) => mine.has(p));
}

/**
 * Эффективный доступ. Без имперсонации — свои права. С имперсонацией роли R (R ⊆ свои) — права R, роль остаётся
 * настоящей. Недопустимая имперсонация (R шире своих — например, после понижения роли) игнорируется:
 * режим может только сужать доступ.
 */
export function effectiveAccess(own: { role: RoleCode; permissions: readonly string[] }, impersonating: RoleCode | null): Effective {
  const mine = ownPermissions(own.permissions);
  if (!impersonating || !canImpersonate(mine, impersonating)) return { role: own.role, permissions: mine, impersonating: null };
  const allowed = new Set<string>(DEFAULT_ROLE_MATRIX[impersonating]);
  return { role: own.role, permissions: mine.filter((p) => allowed.has(p)), impersonating };
}

/** Проверка по роли — по настоящей роли; при имперсонации ещё и примеряемая роль должна совпадать (сужение). */
export function guardAllows(guard: Guard, eff: Effective): boolean {
  switch (guard.kind) {
    case "authenticated":
      return true;
    case "permission":
      return guard.anyOf.some((p) => eff.permissions.includes(p));
    case "role":
      return eff.role === guard.role && (eff.impersonating === null || eff.impersonating === guard.role);
  }
}

/** Что сообщить в 403 PERMISSION_DENIED {permission}. */
export function guardLabel(guard: Guard): string {
  switch (guard.kind) {
    case "authenticated":
      return "authenticated";
    case "permission":
      return guard.anyOf.join("|");
    case "role":
      return `role:${guard.role}`;
  }
}


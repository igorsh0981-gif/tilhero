/**
 * RBAC admin-bff: декларативные требования маршрутов и эффективные права (с учётом имперсонации в dev).
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
  /** Только сессия (cookie → Redis → UA → CSRF/Origin), без principal admin-identity и без лимитов — logout. */
  sessionOnly?: boolean;
}

/** Шаг входа до сессии: обязательна проверка Origin, лимит по IP. */
export const publicAuth = (rate: RateClass): AccessConfig => ({ access: "public", rate });

/** Любой вошедший сотрудник (me, logout, step-up, тема админки). */
export const authenticated = (rate?: RateClass): AccessConfig => ({
  access: "session",
  guard: { kind: "authenticated" },
  ...(rate ? { rate } : {}),
});

/**
 * Выход (ревью T2-1): безотказный — нужны только cookie, сессия в Redis, привязка к User-Agent и CSRF/Origin.
 * Без principal (admin-identity может быть недоступен) и без лимитов команд: сессия удаляется всегда.
 */
export const sessionOnly = (): AccessConfig => ({ access: "session", guard: { kind: "authenticated" }, sessionOnly: true });

/** Нужно хотя бы одно из перечисленных прав (эффективных, с учётом имперсонации). */
export const requirePermission = (...anyOf: [Permission, ...Permission[]]): AccessConfig => ({
  access: "session",
  guard: { kind: "permission", anyOf },
});

/** Нужна роль (four-eyes: approve/reject — только super_admin). */
export const requireRole = (role: RoleCode): AccessConfig => ({ access: "session", guard: { kind: "role", role } });

/** Повторная проверка TOTP не старше окна step-up (5 мин). Комбинируется с requirePermission/requireRole. */
export const requireStepUp = (): Pick<AccessConfig, "stepUp"> => ({ stepUp: true });

/** Каталог прав — копия `PERMISSIONS` из admin.ts (рантайм не импортирует контракт; тест сверяет списки). */
export const ALL_PERMISSIONS = [
  "dashboard.read",
  "users.read",
  "users.sensitive.read",
  "support.read",
  "support.reply",
  "support.manage",
  "audit.read",
  "config.read",
  "config.edit",
  "config.publish",
  "whatsnew.manage",
  "whatsnew.publish",
  "notif.templates.manage",
  "notif.campaigns.manage",
  "notif.campaigns.send",
  "staff.manage",
  "roles.manage",
  // спринт 3 — контент, медиа, языки
  "content.read",
  "content.edit",
  "content.review",
  "content.publish",
  "media.rights",
  "lang.manage",
  // спринт 4 — ИИ-агенты, контроль диалогов, затраты
  "ai.read",
  "ai.manage",
  "ai.publish",
  "qa.read",
  "qa.transcripts",
  "qa.review",
  "costs.read",
  "costs.manage",
  // спринт 5 — память и повторения, словарь курса
  "memory.read",
  "memory.manage",
  "glossary.manage",
  // спринт 6 — игра и герои; game.publish и wallet.adjust — со step-up
  "game.read",
  "game.manage",
  "game.publish",
  "wallet.adjust",
  // спринт 7 — социальное; step-up: social_ban > 7 дней и бессрочный (moderation.manage, по телу команды), активация
  // кампании (referral.manage), переоценка лиги и дуэли (league.manage), остановка комнаты (room.manage)
  "social.read",
  "moderation.manage",
  "referral.read",
  "referral.manage",
  "league.read",
  "league.manage",
  "room.read",
  "room.manage",
  // спринт 8 — деньги; step-up: billing.publish, billing.approve, billing.refund, subscriptions.override
  "billing.read",
  "billing.manage",
  "billing.publish",
  "billing.approve",
  "billing.refund",
  "subscriptions.override",
] as const satisfies readonly Permission[];

/** Компиляция падает, если в admin.ts появилось право, которого нет в ALL_PERMISSIONS (права вне списка отбрасываются). */
type MissingPermissions = Exclude<Permission, (typeof ALL_PERMISSIONS)[number]>;
const _allPermissionsListed: [MissingPermissions] extends [never] ? true : MissingPermissions = true;
void _allPermissionsListed;

export const ROLE_CODES = [
  "super_admin",
  "operations",
  "communications",
  "support",
  "methodist",
  "content_manager",
  "qa_analyst",
  "finance",
  "analyst",
  "auditor",
  "read_only",
] as const satisfies readonly RoleCode[];

type MissingRoles = Exclude<RoleCode, (typeof ROLE_CODES)[number]>;
const _allRolesListed: [MissingRoles] extends [never] ? true : MissingRoles = true;
void _allRolesListed;

/**
 * Матрица по умолчанию (docs/sprint2/PLAN.md §«Роли и права» + §«Права и роли» PLAN спринтов 3–6) — только для
 * имперсонации в dev: эффективные права = свои ∩ права выбранной роли (сужение, не расширение). Источник истины
 * матрицы — admin-identity (сид 0001 + 0003 + 0004 + 0005 + спринт 6). Спринт 5: memory.manage (step-up) — operations;
 * memory.read — methodist, qa_analyst, analyst, operations, auditor; glossary.manage (без step-up) — methodist,
 * content_manager. Спринт 6: game.read — content_manager, methodist, operations, support, analyst, auditor;
 * game.manage — content_manager, operations; game.publish и wallet.adjust (step-up) — только operations (и
 * super_admin). Спринт 7 (PLAN спринта 7 «Права»): support — + social.read, moderation.manage, referral.read,
 * room.read; operations — все восемь прав социального; content_manager — + league.read; analyst и auditor — + чтение
 * (social.read, referral.read, league.read, room.read). Спринт 8 (PLAN спринта 8 «Права и роли»): новая роль finance —
 * billing.* кроме subscriptions.override, costs.read, dashboard.read, users.read (привилегированная: step-up);
 * support — + billing.read, subscriptions.override; operations — + все billing.* и subscriptions.override; analyst и
 * auditor — + billing.read. methodist (content.publish, ai.publish, qa.review) и
 * content_manager (media.rights) — привилегированные по составу прав (MFA, four-eyes), хотя PRIVILEGED_ROLES admin.ts
 * их не перечисляет; operations (costs.manage) привилегирован и по коду роли; qa_analyst (чтение и реплики с
 * причиной, без прав со step-up) — нет. Признак `Role.privileged` вычисляет admin-identity.
 */
const SOCIAL_READ = ["social.read", "referral.read", "league.read", "room.read"] as const satisfies readonly Permission[];
const BILLING_ALL = ["billing.read", "billing.manage", "billing.publish", "billing.approve", "billing.refund"] as const satisfies readonly Permission[];

export const DEFAULT_ROLE_MATRIX: Readonly<Record<RoleCode, readonly Permission[]>> = {
  super_admin: ALL_PERMISSIONS,
  operations: [
    "dashboard.read",
    "users.read",
    "support.read",
    "config.read",
    "config.edit",
    "config.publish",
    "audit.read",
    "content.read",
    "ai.read",
    "qa.read",
    "costs.read",
    "costs.manage",
    "memory.read",
    "memory.manage",
    "game.read",
    "game.manage",
    "game.publish",
    "wallet.adjust",
    "social.read",
    "moderation.manage",
    "referral.read",
    "referral.manage",
    "league.read",
    "league.manage",
    "room.read",
    "room.manage",
    ...BILLING_ALL,
    "subscriptions.override",
  ],
  communications: [
    "dashboard.read",
    "whatsnew.manage",
    "whatsnew.publish",
    "notif.templates.manage",
    "notif.campaigns.manage",
    "notif.campaigns.send",
  ],
  support: [
    "dashboard.read",
    "users.read",
    "support.read",
    "support.reply",
    "game.read",
    "social.read",
    "moderation.manage",
    "referral.read",
    "room.read",
    "billing.read",
    "subscriptions.override",
  ],
  methodist: [
    "dashboard.read",
    "users.read",
    "content.read",
    "content.edit",
    "content.review",
    "content.publish",
    "ai.read",
    "ai.manage",
    "ai.publish",
    "qa.read",
    "qa.transcripts",
    "qa.review",
    "memory.read",
    "glossary.manage",
    "game.read",
  ],
  content_manager: ["dashboard.read", "content.read", "content.edit", "media.rights", "glossary.manage", "game.read", "game.manage", "league.read"],
  qa_analyst: ["dashboard.read", "content.read", "ai.read", "qa.read", "qa.transcripts", "memory.read"],
  finance: ["dashboard.read", "users.read", "costs.read", ...BILLING_ALL],
  analyst: ["dashboard.read", "users.read", "content.read", "ai.read", "qa.read", "costs.read", "memory.read", "game.read", ...SOCIAL_READ, "billing.read"],
  auditor: ["dashboard.read", "audit.read", "content.read", "ai.read", "qa.read", "costs.read", "memory.read", "game.read", ...SOCIAL_READ, "billing.read"],
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

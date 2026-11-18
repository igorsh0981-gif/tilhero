/**
 * Схемы ответов admin-bff (Fastify response → fast-json-stringify): клиент получает ТОЛЬКО поля контракта admin.ts.
 * Ответы доменов описаны кодеками (contract.ts: проверка значения + схема), здесь — то, что собирает сам BFF
 * (вход, Me), и общие помощники.
 *
 * Синхронизация с контрактом проверяется при `tsc`: `shape<T>()` требует ровно ключи типа T. Обязательные поля
 * записаны в `x-contract-required`: сериализатор их не требует, а тесты проверяют каждый 2xx-ответ до
 * сериализации строгим Ajv (`strictContractSchema`) — так ловится null вместо обязательного значения, который
 * fast-json-stringify молча превратил бы в ""/0/{}. Маршрут /admin/v1 без схемы ответа не регистрируется.
 */
import type { ErrorBody, LoginStep, Me, MfaEnrollStart, StaffSummary, StepUpResult } from "@tilhero/contracts/admin";
import { CONTRACT_REQUIRED, type Schema } from "./codec.js";

export { CONTRACT_REQUIRED, type Schema } from "./codec.js";

type Props<T> = { [K in keyof Required<T>]: Schema };
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

/** Объект ровно с ключами T (проверка при компиляции); optional — необязательные (`?:`) поля контракта. */
export function shape<T>(props: Props<T>, ...optional: OptionalKeys<T>[]): Schema {
  const opt = new Set<string>(optional as string[]);
  return { type: "object", properties: props, [CONTRACT_REQUIRED]: Object.keys(props).filter((k) => !opt.has(k)) };
}

/** Строгая копия схемы для Ajv (тесты): x-contract-required → required. */
export function strictContractSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictContractSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === CONTRACT_REQUIRED) out.required = v;
    else out[k] = strictContractSchema(v);
  }
  return out;
}

const orNull = (s: Schema): Schema => ({ ...s, type: [s.type as string, "null"] });
const STR: Schema = { type: "string" };
const N_STR: Schema = { type: ["string", "null"] };
const INT: Schema = { type: "integer" };
const BOOL: Schema = { type: "boolean" };
const ANY_OBJ: Schema = { type: "object", additionalProperties: true };

export const ERROR_BODY = shape<ErrorBody>({ code: STR, message: STR, trace_id: STR, details: ANY_OBJ });

// ---------- auth (собирает BFF) ----------
export const STAFF_SUMMARY = shape<StaffSummary>({ staff_id: STR, email: STR, display_name: STR, role: STR });
export const ME = shape<Me>({
  staff: STAFF_SUMMARY,
  permissions: { type: "array", items: STR },
  mfa_enabled: BOOL,
  must_change_password: BOOL,
  session: shape<Me["session"]>({ expires_at: STR, idle_timeout_seconds: INT, step_up_until: N_STR }),
  csrf_token: STR,
  env: STR,
  impersonating: N_STR,
});
export const LOGIN_STEP = shape<LoginStep>({ next: STR, challenge: N_STR, me: orNull(ME) });
export const MFA_ENROLL_START = shape<MfaEnrollStart>({ secret: STR, otpauth_uri: STR, issuer: STR, account: STR });
export const STEP_UP_RESULT = shape<StepUpResult>({ step_up_until: STR });

export const ok = (s: Schema) => ({ "2xx": s });
export const NO_CONTENT = { 204: { type: "null" } };

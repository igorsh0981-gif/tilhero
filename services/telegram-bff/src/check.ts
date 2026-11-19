/**
 * Строгая проверка ответов доменов (спринт 3): ответ catalog / diagnostics / learning-plan сверяется со схемой контракта
 * ДО сборки ответа Mini App. Не по схеме (не тот тип, неизвестное значение перечисления, нет обязательного поля) →
 * 503 UPSTREAM_UNAVAILABLE {service} и предупреждение в лог (сервис, что проверялось, путь и правило — без значений).
 * Лишние поля доменов допустимы: в Mini App они не попадают (сериализация по схеме ответа BFF).
 */
import type { TSchema, Static } from "@fastify/type-provider-typebox";
import { Ajv, type ValidateFunction } from "ajv";
import type { FastifyBaseLogger } from "fastify";
import { upstreamUnavailable } from "./upstream.js";

const ajv = new Ajv({ allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false, strict: false });
const compiled = new WeakMap<TSchema, ValidateFunction>();

function validator(schema: TSchema): ValidateFunction {
  let v = compiled.get(schema);
  if (!v) {
    v = ajv.compile(schema);
    compiled.set(schema, v);
  }
  return v;
}

/** value соответствует схеме → value; иначе 503 от имени service. what — короткое имя проверки для лога. */
export function expectShape<S extends TSchema>(log: FastifyBaseLogger, service: string, what: string, schema: S, value: unknown): Static<S> {
  const v = validator(schema);
  if (v(value)) return value as Static<S>;
  const e = v.errors?.[0];
  log.warn(
    { upstream: service, check: what, path: e?.instancePath ?? "", rule: e?.keyword ?? "", upstream_code: "UPSTREAM_BAD_RESPONSE" },
    "domain response does not match the contract",
  );
  throw upstreamUnavailable(service);
}

/** Проверка без исключения (элементы списков, кеш). */
export function matches<S extends TSchema>(schema: S, value: unknown): value is Static<S> {
  return validator(schema)(value);
}

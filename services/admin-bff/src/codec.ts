/**
 * Строгая нормализация ответов доменов спринта 7 (docs/sprint7/INTERNAL_API.md §6): одно описание поля даёт и
 * проверку значения домена, и схему ответа admin-bff (fast-json-stringify + строгий Ajv в тестах через
 * x-contract-required). `obj<T>()` требует ровно ключи типа T из admin.ts — поле, добавленное в контракт, ломает
 * сборку, пока описание не обновлено (как `shape<T>()` в responses.ts).
 *
 * Испорченный ответ (не тот тип, неизвестное значение перечисления, деньги не строкой или с float, время без зоны,
 * ссылка не https) → 503 UPSTREAM_UNAVAILABLE {service}; в лог — только путь поля, без значений (там могут быть
 * тексты). Свободный текст домена очищается от управляющих символов и обрезается.
 */
import type { Schema } from "./responses.js";
import { upstreamUnavailable } from "./upstream.js";
import { cleanText, isoTime, safeHttps } from "./routes/travel.js";
import type { BffContext } from "./context.js";
import type { StaffAuth } from "./http.js";

/** Как responses.ts CONTRACT_REQUIRED (свой литерал: responses.ts импортирует схемы спринта 7 — без цикла модулей). */
const CONTRACT_REQUIRED = "x-contract-required";

export class BadValue extends Error {
  constructor(readonly path: string) {
    super(path);
    this.name = "BadValue";
  }
}

export interface Codec<T> {
  readonly schema: Schema;
  /** Значение домена → значение контракта; иначе BadValue(path). undefined приходит для отсутствующего поля. */
  parse(v: unknown, path: string): T;
}

const codec = <T>(schema: Schema, parse: (v: unknown, path: string) => T): Codec<T> => ({ schema, parse });
/** Сколько элементов отбросил `C.arrSkip` (parseDomain пишет WARNING с числом и сбрасывает). */
export const skipped = { count: 0 };
const bad = (path: string): never => {
  throw new BadValue(path);
};

/** Управляющие символы, кроме перевода строки и табуляции (многострочный текст skill). */
const CONTROL_ML_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g;
/** Деньги USD строкой: до 12 целых и до 6 дробных знаков (ai-control — 6 знаков, gateway — 2–4). */
export const USD_RE = /^\d{1,12}(\.\d{1,6})?$/;
const USD_SIGNED_RE = /^-?\d{1,12}(\.\d{1,6})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Идентификатор агента, уровня доступа: как в ai-control. */
export const SLUG_RE = /^[a-z][a-z0-9_-]{1,31}$/;
/** Модель / внешний API / инструмент / skill: латиница, цифры, точки, дефисы, подчёркивания. */
export const KEY_RE = /^[A-Za-z0-9*][A-Za-z0-9._:\-*]{0,127}$/;

type Props<T> = { [K in keyof Required<T>]-?: Codec<Exclude<T[K], undefined>> };
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

const withNull = (s: Schema): Schema => {
  const t = s.type;
  if (typeof t === "string") return { ...s, type: [t, "null"] };
  if (Array.isArray(t)) return t.includes("null") ? s : { ...s, type: [...t, "null"] };
  return { anyOf: [s, { type: "null" }] };
};

export const C = {
  /** Строка-идентификатор по регулярному выражению. */
  id: (re: RegExp, max = 128): Codec<string> =>
    codec({ type: "string" }, (v, p) => (typeof v === "string" && v.length <= max && re.test(v) ? v : bad(p))),
  uuid: codec<string>({ type: "string" }, (v, p) => (typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : bad(p))),
  /** Однострочный текст домена: управляющие символы → пробел, обрезка до max; пустой → ошибка. */
  text: (max: number): Codec<string> => codec({ type: "string" }, (v, p) => cleanText(v, max) ?? bad(p)),
  /** Многострочный текст (инструкция skill, строки diff): без управляющих символов, кроме \n и \t; длиннее max — ошибка. */
  multiline: (max: number, allowEmpty = false): Codec<string> =>
    codec({ type: "string" }, (v, p) => {
      if (typeof v !== "string") return bad(p);
      const s = v.replace(/\r\n?/g, "\n").replace(CONTROL_ML_RE, " ");
      return s.length > max || (!allowEmpty && !s.trim()) ? bad(p) : s;
    }),
  int: (min = 0, max = Number.MAX_SAFE_INTEGER): Codec<number> =>
    codec({ type: "integer" }, (v, p) => (typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : bad(p))),
  /** Проценты и доли (не деньги): конечное число в границах. */
  num: (min: number, max: number): Codec<number> =>
    codec({ type: "number" }, (v, p) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : bad(p))),
  bool: codec<boolean>({ type: "boolean" }, (v, p) => (typeof v === "boolean" ? v : bad(p))),
  /** Деньги строкой (float → ошибка). */
  usd: codec<string>({ type: "string" }, (v, p) => (typeof v === "string" && USD_RE.test(v) ? v : bad(p))),
  usdSigned: codec<string>({ type: "string" }, (v, p) => (typeof v === "string" && USD_SIGNED_RE.test(v) ? v : bad(p))),
  time: codec<string>({ type: "string" }, (v, p) => isoTime(v) ?? bad(p)),
  date: codec<string>({ type: "string" }, (v, p) =>
    typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : bad(p),
  ),
  /** Ссылка только https (иначе null — ссылку не показываем, ответ не ломаем). */
  https: codec<string | null>({ type: ["string", "null"] }, (v) => safeHttps(v)),
  oneOf: <T extends string>(values: readonly T[]): Codec<T> =>
    codec({ type: "string" }, (v, p) => (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : bad(p))),
  /** null/нет поля → null. */
  nullable: <T>(c: Codec<T>): Codec<T | null> =>
    codec(withNull(c.schema), (v, p) => (v === null || v === undefined ? null : c.parse(v, p))),
  /** Нет поля → значение по умолчанию (поле, которого нет у домена прошлой версии). */
  fallback: <T>(c: Codec<T>, def: T): Codec<T> => codec(c.schema, (v, p) => (v === undefined ? def : c.parse(v, p))),
  arr: <T>(c: Codec<T>, max = 1000): Codec<T[]> =>
    codec({ type: "array", items: c.schema }, (v, p) => {
      if (!Array.isArray(v) || v.length > max) return bad(p);
      return v.map((x, i) => c.parse(x, `${p}[${i}]`));
    }),
  /** Массив, в котором элемент, не прошедший кодек (например, вид оповещения или тип объекта новее этого admin-bff),
   *  отбрасывается поштучно, а не делает весь ответ 503 (ревью спринта 9). Сам массив — по-прежнему обязателен. */
  arrSkip: <T>(c: Codec<T>, max = 1000): Codec<T[]> =>
    codec({ type: "array", items: c.schema }, (v, p) => {
      if (!Array.isArray(v) || v.length > max) return bad(p);
      const out: T[] = [];
      v.forEach((x, i) => {
        try {
          out.push(c.parse(x, `${p}[${i}]`));
        } catch (e) {
          if (!(e instanceof BadValue)) throw e;
          skipped.count += 1;
        }
      });
      return out;
    }),
  /** Имя сотрудника: заполняет `withNames` (admin-identity staff/lookup) после проверки. */
  name: codec<string | null>({ type: ["string", "null"] }, () => null),
  /** JSON-объект фикстуры (Test Console): передаётся как есть, если не больше maxBytes. */
  json: (maxBytes: number): Codec<Record<string, unknown>> =>
    codec({ type: "object", additionalProperties: true }, (v, p) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return bad(p);
      return JSON.stringify(v).length <= maxBytes ? (v as Record<string, unknown>) : bad(p);
    }),
  /** Любое JSON-значение → компактная строка (сравнение полей, аргументы инструмента); null/нет → null. */
  jsonText: (max: number): Codec<string | null> =>
    codec({ type: ["string", "null"] }, (v) => {
      if (v === undefined || v === null) return null;
      let s: string;
      try {
        s = typeof v === "string" ? v : JSON.stringify(v);
      } catch {
        return null;
      }
      s = s.replace(CONTROL_ML_RE, " ");
      return s.length > max ? `${s.slice(0, max - 1)}…` : s;
    }),
  obj: <T>(props: Props<T>, ...optional: OptionalKeys<T>[]): Codec<T> => {
    const opt = new Set<string>(optional as string[]);
    const entries = Object.entries(props) as Array<[string, Codec<unknown>]>;
    const schema: Schema = {
      type: "object",
      properties: Object.fromEntries(entries.map(([k, c]) => [k, c.schema])),
      [CONTRACT_REQUIRED]: entries.map(([k]) => k).filter((k) => !opt.has(k)),
    };
    return codec(schema, (v, p) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return bad(p);
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, c] of entries) {
        if (opt.has(k) && src[k] === undefined) continue;
        out[k] = c.parse(src[k], `${p}.${k}`);
      }
      return out as T;
    });
  },
  /** Произвольное преобразование поверх кодека (переименование полей домена и т. п.). */
  map: <A, B>(c: Codec<A>, schema: Schema, f: (a: A, path: string) => B): Codec<B> => codec(schema, (v, p) => f(c.parse(v, p), p)),
  /** Кодек с собственным разбором (схема задаётся явно). */
  custom: <T>(schema: Schema, parse: (v: unknown, path: string) => T): Codec<T> => codec(schema, parse),
};

/** {items, next_cursor} домена. */
export const pageOf = <T>(item: Codec<T>, max = 200): Codec<{ items: T[]; next_cursor: string | null }> =>
  C.obj<{ items: T[]; next_cursor: string | null }>({
    items: C.arr(item, max),
    next_cursor: C.nullable(C.id(/^[A-Za-z0-9_=.:-]+$/, 512)),
  });

/** Разбор ответа домена: испорченный → 503 UPSTREAM_UNAVAILABLE {service} (в лог — путь поля, без значения). */
export function parseDomain<T>(ctx: BffContext, service: string, c: Codec<T>, body: unknown): T {
  skipped.count = 0;
  try {
    const out = c.parse(body, "$");
    if (skipped.count) {
      ctx.log.warn({ upstream: service, skipped: skipped.count }, "domain items skipped by normalization (unknown values)");
      skipped.count = 0;
    }
    return out;
  } catch (e) {
    if (!(e instanceof BadValue)) throw e;
    ctx.log.warn({ upstream: service, upstream_code: "UPSTREAM_BAD_RESPONSE", field: e.path.slice(0, 200) }, "domain response rejected by normalization");
    throw upstreamUnavailable(service);
  }
}

/** Поля сотрудника, у которых в контракте есть пара `<поле>_name`. */
const NAMED = ["by", "updated_by", "author", "reviewer", "created_by", "activated_by", "assigned_by", "acked_by", "started_by"] as const;

function walk(v: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(v)) {
    for (const x of v) walk(x, visit);
    return;
  }
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  visit(o);
  for (const x of Object.values(o)) walk(x, visit);
}

/** Имена сотрудников одним запросом staff/lookup (только UUID; "system" и прочее — без lookup, имя null). */
export async function withNames<T>(ctx: BffContext, auth: StaffAuth, value: T): Promise<T> {
  const ids = new Set<string>();
  walk(value, (o) => {
    for (const k of NAMED) {
      const id = o[k];
      if (`${k}_name` in o && typeof id === "string" && UUID_RE.test(id)) ids.add(id);
    }
  });
  if (!ids.size) return value;
  const names = await ctx.names.resolve([...ids], auth);
  walk(value, (o) => {
    for (const k of NAMED) {
      const id = o[k];
      if (`${k}_name` in o && typeof id === "string") o[`${k}_name`] = names.get(id) ?? null;
    }
  });
  return value;
}

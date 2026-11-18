/**
 * Строгая нормализация ответов доменов: одно описание поля даёт и проверку значения домена, и схему ответа
 * admin-bff (fast-json-stringify + строгий Ajv в тестах через x-contract-required). `C.obj<T>()` требует ровно
 * ключи типа T из admin.ts — поле, добавленное в контракт или удалённое из него, ломает сборку, пока описание не
 * обновлено. Лишние поля домена отбрасываются (в ответ попадает только контракт).
 *
 * Испорченный ответ (не тот тип, неизвестное значение перечисления, время без зоны, ссылка не https) →
 * 503 UPSTREAM_UNAVAILABLE {service}; в лог — только путь поля, без значений (там могут быть тексты и PII).
 */
import type { BffContext } from "./context.js";
import type { StaffAuth } from "./http.js";
import { upstreamUnavailable } from "./upstream.js";

export type Schema = Record<string, unknown>;

/** Нестандартное ключевое слово: обязательные поля контракта (сериализатор его игнорирует, тесты — required). */
export const CONTRACT_REQUIRED = "x-contract-required";

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
/** Отклонить значение домена (путь поля — в лог, без значения). */
export const bad = (path: string): never => {
  throw new BadValue(path);
};

/** Управляющие и «невидимые» символы однострочного текста (bidi-переключатели, BOM). */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** Управляющие символы, кроме перевода строки и табуляции (многострочный текст). */
const CONTROL_ML_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_URL = 2048;

/** Однострочный текст: управляющие символы → пробел, пробелы схлопываются, обрезка до max; пустой → null. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Время ISO 8601 с зоной (как отдают домены), разумной длины; иначе null. */
export function isoTime(v: unknown): string | null {
  return typeof v === "string" && v.length <= 40 && DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** Ссылка для сотрудника: только https, с хостом-доменом, без учётных данных и пробелов; иначе null. */
export function safeHttps(v: unknown): string | null {
  if (typeof v !== "string" || v.length > MAX_URL || /[\s\u0000-\u001f\u007f]/.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return null;
  return u.href;
}

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
  /** Строка как есть (содержимое, которое сотрудник правит: тексты шаблонов, заметок) — только тип и длина. */
  str: (max: number, min = 0): Codec<string> =>
    codec({ type: "string" }, (v, p) => (typeof v === "string" && v.length >= min && v.length <= max ? v : bad(p))),
  /** Однострочный текст домена для показа: управляющие символы → пробел, обрезка до max; пустой → ошибка. */
  text: (max: number): Codec<string> => codec({ type: "string" }, (v, p) => cleanText(v, max) ?? bad(p)),
  /** Необязательный однострочный текст для показа: null, пустой или из одних пробелов → null; не строка → ошибка. */
  optText: (max: number): Codec<string | null> =>
    codec({ type: ["string", "null"] }, (v, p) => (v === null || v === undefined ? null : typeof v === "string" ? cleanText(v, max) : bad(p))),
  /** Многострочный текст (сообщения поддержки): без управляющих символов, кроме \n и \t; длиннее max — ошибка. */
  multiline: (max: number, allowEmpty = false): Codec<string> =>
    codec({ type: "string" }, (v, p) => {
      if (typeof v !== "string") return bad(p);
      const s = v.replace(/\r\n?/g, "\n").replace(CONTROL_ML_RE, " ");
      return s.length > max || (!allowEmpty && !s.trim()) ? bad(p) : s;
    }),
  int: (min = 0, max = Number.MAX_SAFE_INTEGER): Codec<number> =>
    codec({ type: "integer" }, (v, p) => (typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : bad(p))),
  /** Проценты, средние: конечное число в границах. */
  num: (min: number, max: number): Codec<number> =>
    codec({ type: "number" }, (v, p) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : bad(p))),
  bool: codec<boolean>({ type: "boolean" }, (v, p) => (typeof v === "boolean" ? v : bad(p))),
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
  /** Массив, где элемент, не прошедший кодек (например, право новее этого admin-bff), отбрасывается поштучно. */
  arrSkip: <T>(c: Codec<T>, max = 1000): Codec<T[]> =>
    codec({ type: "array", items: c.schema }, (v, p) => {
      if (!Array.isArray(v) || v.length > max) return bad(p);
      const out: T[] = [];
      v.forEach((x, i) => {
        try {
          out.push(c.parse(x, `${p}[${i}]`));
        } catch (e) {
          if (!(e instanceof BadValue)) throw e;
        }
      });
      return out;
    }),
  /** Имя сотрудника: заполняет `withNames` (admin-identity staff/lookup) после проверки; от домена не берётся. */
  name: codec<string | null>({ type: ["string", "null"] }, () => null),
  /** Свободный JSON-объект (summary заявки, before/after аудита, payload конфигурации) — как есть, ≤ maxBytes. */
  json: (maxBytes: number): Codec<Record<string, unknown>> =>
    codec({ type: "object", additionalProperties: true }, (v, p) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return bad(p);
      return JSON.stringify(v).length <= maxBytes ? (v as Record<string, unknown>) : bad(p);
    }),
  /** Словарь строка → значение кодека (ключи — по регулярному выражению). */
  dict: <T>(key: RegExp, c: Codec<T>, maxKeys = 100): Codec<Record<string, T>> =>
    codec({ type: "object", additionalProperties: c.schema }, (v, p) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return bad(p);
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length > maxKeys) return bad(p);
      const out: Record<string, T> = {};
      for (const [k, x] of entries) {
        if (!key.test(k)) return bad(`${p}.${k.slice(0, 40)}`);
        out[k] = c.parse(x, `${p}.${k}`);
      }
      return out;
    }),
  /**
   * Объект ровно с ключами T. Необязательные (`?:`) ключи контракта: нет поля, null или кодек вернул null
   * (например, ссылка не https) → ключа нет в ответе (fast-json-stringify превратил бы null в ""/0).
   */
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
        if (!opt.has(k)) {
          out[k] = c.parse(src[k], `${p}.${k}`);
          continue;
        }
        if (src[k] === undefined || src[k] === null) continue;
        const r = c.parse(src[k], `${p}.${k}`);
        if (r !== undefined && r !== null) out[k] = r;
      }
      return out as T;
    });
  },
  /** Произвольное преобразование поверх кодека (защитная подмена значения и т. п.). */
  map: <A, B>(c: Codec<A>, schema: Schema, f: (a: A, path: string) => B): Codec<B> => codec(schema, (v, p) => f(c.parse(v, p), p)),
  /** Кодек с собственным разбором (схема задаётся явно). */
  custom: <T>(schema: Schema, parse: (v: unknown, path: string) => T): Codec<T> => codec(schema, parse),
};

/** Курсор страницы домена: непрозрачная строка разумной длины. */
export const CURSOR = C.nullable(C.id(/^[A-Za-z0-9_=.:+/-]+$/, 512));

/** {items, next_cursor} домена → Page<T>. */
export const pageOf = <T>(item: Codec<T>, max = 200): Codec<{ items: T[]; next_cursor: string | null }> =>
  C.obj<{ items: T[]; next_cursor: string | null }>({ items: C.arr(item, max), next_cursor: CURSOR });

/** {items} домена. */
export const itemsOf = <T>(item: Codec<T>, max = 500): Codec<{ items: T[] }> => C.obj<{ items: T[] }>({ items: C.arr(item, max) });

/** Разбор ответа домена: испорченный → 503 UPSTREAM_UNAVAILABLE {service} (в лог — путь поля, без значения). */
export function parseDomain<T>(ctx: BffContext, service: string, c: Codec<T>, body: unknown): T {
  try {
    return c.parse(body, "$");
  } catch (e) {
    if (!(e instanceof BadValue)) throw e;
    ctx.log.warn(
      { upstream: service, upstream_code: "UPSTREAM_BAD_RESPONSE", field: e.path.replace(/[^\w.$[\]-]/g, "?").slice(0, 200) },
      "domain response rejected by normalization",
    );
    throw upstreamUnavailable(service);
  }
}

// ---------------------------------------------------------------- имена сотрудников (*_name)

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

/** Пары «поле сотрудника → поле имени» объекта контракта: `created_by` → `created_by_name`, `assignee_id` → `assignee_name`. */
function namePairs(o: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const k of Object.keys(o)) {
    if (k.endsWith("_name")) continue;
    if (`${k}_name` in o) out.push([k, `${k}_name`]);
    else if (k.endsWith("_id") && `${k.slice(0, -3)}_name` in o) out.push([k, `${k.slice(0, -3)}_name`]);
  }
  return out;
}

/**
 * Имена сотрудников одним запросом staff/lookup: для каждого объекта, где рядом с идентификатором сотрудника есть
 * поле `*_name` контракта. Только UUID ("system", "seed" — без lookup). Не найдено — остаётся значение домена
 * (имя автора-ученика в тикете) или null.
 */
export async function withNames<T>(ctx: BffContext, auth: StaffAuth, value: T): Promise<T> {
  const ids = new Set<string>();
  walk(value, (o) => {
    for (const [k] of namePairs(o)) {
      const id = o[k];
      if (typeof id === "string" && UUID_RE.test(id)) ids.add(id.toLowerCase());
    }
  });
  if (!ids.size) return value;
  const names = await ctx.names.resolve([...ids], auth);
  walk(value, (o) => {
    for (const [k, nk] of namePairs(o)) {
      const id = o[k];
      const found = typeof id === "string" ? names.get(id.toLowerCase()) : undefined;
      o[nk] = found ?? o[nk] ?? null;
    }
  });
  return value;
}

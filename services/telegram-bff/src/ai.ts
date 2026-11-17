/**
 * Спринт 7 (INTERNAL_API §5): AI-консьерж — Mini App → telegram-bff /v1/ai/* → ai-concierge.
 *
 * - Ограничения профиля (`constraints`) собирает BFF из preferences — клиенту не доверяем; язык — из identity.
 * - Ход: SSE-прокси без буферизации. Каждое событие upstream проверяется: тип ∈ шести, `data` — JSON по схеме
 *   `AiSseEvent` (TypeBox, строки ≤ 2000, лишние поля отбрасываются), `turn_id` — тот же, что у первого события хода.
 *   Событие не по схеме отбрасывается с WARNING (без содержимого). Heartbeat `: ping` проходит как есть. Поток
 *   оборвался/истёк таймаут без `done`/`error` — BFF сам присылает `error` (AI_PROVIDER_UNAVAILABLE / AI_TIMEOUT,
 *   retryable), Mini App перечитывает переписку. Закрытие клиента → abort upstream (ai-concierge останавливает ход).
 * - `Accept: application/json` — запасной путь без стрима: тот же ход целиком (`AiTurnResult`), собранный из
 *   проверенных событий.
 * - Ошибки ai-concierge до стрима — JSON с HTTP-статусом: известные коды §8 — со своим сообщением и проверенными
 *   details; 404 без известного кода (нет маршрута), 400/401/403, 5xx, мусор → 503.
 */
import type { FastifyBaseLogger } from "fastify";
import type {
  AiConversation,
  AiError,
  AiQuota,
  AiSseEvent,
  AiToolResult,
  AiTurnResult,
  Preferences,
} from "@tilhero/contracts/bff";
import { AppError, INTERNAL_HEADER, issueInternalToken, outgoingHeaders, type InternalKey } from "@tilhero/ts-common";
import { flightLink, hotelFiltersOf, project, tripProfile } from "./offers.js";
import { geographiesOf, interestsOf, validator } from "./personal.js";
import {
  AI_ARG_KEY,
  AI_QUOTA_NOTE_KEYS,
  AI_SSE_SCHEMAS,
  AiConversationSchema,
  AiMessageSchema,
  AiQuotaSchema,
  AiSegmentSchema,
  AiToolResultSchema,
  AiDoneSchema,
  AiDoneActionSchema,
  AiErrorSchema,
  AiMessageActionSchema,
  AiQuickActionSchema,
  CATEGORY_CODE,
  UUID_RE,
} from "./schemas.js";
import { SERVICE_NAME, type DomainClient } from "./upstream.js";

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

export const AI_FEATURE = "ai";
export function aiUnavailable(): AppError {
  return new AppError(503, "FEATURE_UNAVAILABLE", "Функция временно недоступна", { feature: AI_FEATURE });
}
const upstreamDown = (service = "ai-concierge") =>
  new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service });

export const AI_EVENTS = ["tool_call", "tool_result", "fact", "delta", "done", "error"] as const;
export type TilHeroName = (typeof AI_EVENTS)[number];
const EVENT_SET: ReadonlySet<string> = new Set(AI_EVENTS);

/** Предел строки в данных консьержа (INTERNAL_API §5). */
export const AI_MAX_STRING = 2000;
/** Предел одного события SSE (байт до разбора) и буфера незавершённого события. */
export const AI_MAX_FRAME_BYTES = 262_144;

// ---------------------------------------------------------------- чистка и проверка

class TooLong extends Error {}

/** Управляющие символы, кроме перевода строки и табуляции (текст ответа AI многострочный), bidi и zero-width. */
const AI_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** Глубокая копия JSON с чисткой строк; строка длиннее AI_MAX_STRING → TooLong; вложенность > 12 → null. */
export function aiScrub(v: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (typeof v === "string") {
    if (v.length > AI_MAX_STRING) throw new TooLong();
    return v.replace(AI_UNSAFE, "");
  }
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => aiScrub(x, depth + 1));
  if (isObj(v)) {
    const out: Raw = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = aiScrub(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** Ключи аргументов инструментов и параметров приветствия — латиница (Record в схеме ключи не ограничивает). */
function keysOk(v: unknown): boolean {
  if (Array.isArray(v)) return v.every(keysOk);
  if (!isObj(v)) return true;
  for (const [k, x] of Object.entries(v)) {
    if ((k === "args" || k === "params") && isObj(x) && !Object.keys(x).every((a) => AI_ARG_KEY.test(a))) return false;
    if (!keysOk(x)) return false;
  }
  return true;
}

/** Значение по схеме (после чистки) или null; результат — проекция на схему. */
export function checked<T>(schema: object, raw: unknown): { ok: true; value: T } | { ok: false; path: string; rule: string } {
  let v: unknown;
  try {
    v = aiScrub(raw);
  } catch {
    return { ok: false, path: "", rule: "maxLength" };
  }
  const fn = validator(schema);
  if (!fn(v)) {
    const e = fn.errors?.[0];
    return { ok: false, path: e?.instancePath ?? "", rule: e?.keyword ?? "unknown" };
  }
  if (!keysOk(v)) return { ok: false, path: "", rule: "key" };
  return { ok: true, value: project(schema as never, v) as T };
}

/**
 * Списки, где битый элемент отбрасывается по одному, а объект сохраняется (ревью спринта 7: одно битое быстрое действие
 * не должно ронять done — иначе синтетическая ошибка и повторный ход). required — не массив → [], иначе поле удаляется.
 * Возвращает число отброшенных элементов.
 */
export function pruneList(obj: unknown, key: string, schema: object, required: boolean): number {
  if (!isObj(obj) || !(key in obj)) return 0;
  const list = obj[key];
  if (!Array.isArray(list)) {
    if (required) obj[key] = [];
    else delete obj[key];
    return 1;
  }
  const kept: unknown[] = [];
  for (const item of list) {
    const r = checked<unknown>(schema, item);
    if (r.ok) kept.push(r.value);
  }
  obj[key] = kept;
  return list.length - kept.length;
}

/** Необязательный объект: битый — поле удаляется (1), иначе 0. */
function pruneField(obj: unknown, key: string, schema: object): number {
  if (!isObj(obj) || !(key in obj) || obj[key] === undefined) return 0;
  const r = checked<unknown>(schema, obj[key]);
  if (r.ok) {
    obj[key] = r.value;
    return 0;
  }
  delete obj[key];
  return 1;
}

/** Ревью 7.2: ссылка «Билеты на Aviasales» — только та, что принимает `flightLink` (цель редиректа tp.media/r?u= —
 *  сайт Aviasales); хост приводится к нижнему регистру и без точки в конце. Негодное действие отбрасывается. */
function pruneFlightLinks(obj: unknown): number {
  if (!isObj(obj) || !Array.isArray(obj.actions)) return 0;
  const list = obj.actions as unknown[];
  const kept: unknown[] = [];
  for (const a of list) {
    if (isObj(a) && a.type === "flight_search") {
      const link = flightLink(a.url);
      if (!link) continue;
      a.url = link;
    }
    kept.push(a);
  }
  obj.actions = kept;
  return list.length - kept.length;
}

/** Спринт 8: поля квоты — битый `quota_charged` удаляется, неизвестная подпись → null (done не роняется). */
function pruneQuotaNote(obj: unknown): number {
  if (!isObj(obj)) return 0;
  let n = 0;
  if ("quota_charged" in obj && typeof obj.quota_charged !== "boolean") {
    delete obj.quota_charged;
    n += 1;
  }
  const key = obj.quota_note_key;
  if (key !== undefined && key !== null && !(AI_QUOTA_NOTE_KEYS as readonly unknown[]).includes(key)) {
    obj.quota_note_key = null;
    n += 1;
  }
  return n;
}

/** done: битые actions и quick_actions — по одному; поля квоты (спринт 8). */
export function pruneDone(data: unknown): number {
  return (
    pruneList(data, "actions", AiDoneActionSchema, true) +
    pruneFlightLinks(data) +
    pruneList(data, "quick_actions", AiQuickActionSchema, false) +
    pruneQuotaNote(data)
  );
}

/** Сообщение истории: битые actions / tool_results — по одному, битая подпись быстрого действия — без неё; поля квоты
 *  (спринт 8) — как в done. */
export function pruneMessage(m: unknown): number {
  return (
    pruneList(m, "actions", AiDoneActionSchema, false) +
    pruneFlightLinks(m) +
    pruneList(m, "tool_results", AiToolResultSchema, false) +
    pruneField(m, "action", AiMessageActionSchema) +
    pruneQuotaNote(m)
  );
}

/** Событие SSE upstream → проверенное событие (pruned — сколько битых элементов списков отброшено) или причина отказа. */
export function sseEventOf(
  event: string,
  dataText: string,
): { ok: true; value: AiSseEvent; pruned: number } | { ok: false; reason: string } {
  if (!EVENT_SET.has(event)) return { ok: false, reason: "unknown_event" };
  if (dataText.length > AI_MAX_FRAME_BYTES) return { ok: false, reason: "too_large" };
  let data: unknown;
  try {
    data = JSON.parse(dataText);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  const pruned = event === "done" ? pruneDone(data) : 0;
  const r = checked<AiSseEvent["data"]>(AI_SSE_SCHEMAS[event as TilHeroName], data);
  if (!r.ok) return { ok: false, reason: `schema:${r.path || "/"}:${r.rule}` };
  return { ok: true, value: { event, data: r.value } as AiSseEvent, pruned };
}

/** Кадр SSE для Mini App: id = <turn_id>:<seq BFF>, data — JSON одной строкой. */
export function sseFrame(e: AiSseEvent, seq: number): string {
  const turn = e.data.turn_id ?? "none";
  return `id: ${turn}:${seq}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

// ---------------------------------------------------------------- разбор потока text/event-stream

export interface SseBlock {
  comment: boolean;
  event: string;
  data: string;
}

/** Потоковый разборщик SSE (WHATWG): строки \n, \r\n или \r; пустая строка — конец события. */
export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];
  private comment = false;
  private size = 0;

  /** Части текста → готовые блоки. Слишком большое незавершённое событие → исключение. */
  push(chunk: string): SseBlock[] {
    this.buf += chunk;
    const out: SseBlock[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      // \r в конце буфера может быть началом \r\n — ждём следующую часть
      if (m[0] === "\r" && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const b = this.line(line);
      if (b) out.push(b);
    }
    if (this.buf.length + this.size > AI_MAX_FRAME_BYTES) throw new TooLong();
    return out;
  }

  private line(line: string): SseBlock | null {
    if (line === "") {
      if (!this.comment && !this.data.length && !this.event) return null;
      const b = { comment: this.comment && !this.data.length && !this.event, event: this.event || "message", data: this.data.join("\n") };
      this.event = "";
      this.data = [];
      this.comment = false;
      this.size = 0;
      return b;
    }
    this.size += line.length;
    if (line.startsWith(":")) {
      this.comment = true;
      return null;
    }
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return null; // id, retry и прочее — BFF ставит свои
  }
}

// ---------------------------------------------------------------- ответы JSON

/** Conversation ai-concierge → AiConversation; пустые поля контекста — значения по умолчанию; битые сообщения истории
 *  отбрасываются. Битая переписка — null. */
export function conversationOf(raw: unknown, log?: FastifyBaseLogger): AiConversation | null {
  if (!isObj(raw)) return null;
  const ctx = isObj(raw.context) ? raw.context : {};
  const v: Raw = {
    ...raw,
    context: {
      chips: Array.isArray(ctx.chips) ? ctx.chips : [],
      sources_count: typeof ctx.sources_count === "number" ? ctx.sources_count : 0,
      trip_kind: ctx.trip_kind ?? null,
      tier: ctx.tier ?? null,
      allowed_departures: Array.isArray(ctx.allowed_departures) ? ctx.allowed_departures : [],
    },
  };
  let dropped = pruneList(v, "quick_actions", AiQuickActionSchema, true);
  if (Array.isArray(raw.messages)) {
    v.messages = raw.messages
      .map((m0) => {
        const m = isObj(m0) ? { ...m0 } : m0;
        dropped += pruneMessage(m);
        const r = checked<AiConversation["messages"]>(AiMessageSchema, m);
        if (!r.ok) dropped += 1;
        return r.ok ? r.value : null;
      })
      .filter((m) => m !== null)
      .slice(-50);
  }
  const r = checked<AiConversation>(AiConversationSchema, v);
  if (!r.ok) {
    log?.warn({ upstream: "ai-concierge", reason: "schema", path: r.path, rule: r.rule }, "ai conversation bad response");
    return null;
  }
  if (dropped) log?.warn({ upstream: "ai-concierge", dropped }, "ai messages dropped (schema)");
  return { ...r.value, conversation_id: r.value.conversation_id.toLowerCase() };
}

/** Ход без стрима: из списка событий (как в потоке) или из полей TurnResult. Битые части отбрасываются. */
export function turnResultOf(raw: unknown, log?: FastifyBaseLogger): AiTurnResult | null {
  if (!isObj(raw)) return null;
  const segments = new Map<number, AiTurnResult["segments"][number]>();
  const tools: AiToolResult[] = [];
  let done: AiTurnResult["done"] = null;
  let error: AiTurnResult["error"] = null;
  let turnId = typeof raw.turn_id === "string" && UUID_RE.test(raw.turn_id) ? raw.turn_id.toLowerCase() : null;
  let dropped = 0;
  if (Array.isArray(raw.events)) {
    for (const item of raw.events.slice(0, 500)) {
      if (!isObj(item) || typeof item.event !== "string") {
        dropped += 1;
        continue;
      }
      const r = sseEventOf(item.event, JSON.stringify(item.data ?? null));
      if (!r.ok) {
        dropped += 1;
        continue;
      }
      dropped += r.pruned;
      const e = r.value;
      const tid = e.data.turn_id?.toLowerCase() ?? null;
      if (tid && turnId && tid !== turnId) {
        dropped += 1;
        continue;
      }
      turnId ??= tid;
      if (done || error) continue; // после терминального — ничего
      if (e.event === "fact") segments.set(e.data.segment, { segment: e.data.segment, kind: e.data.kind, sources: e.data.sources, text: "" });
      else if (e.event === "delta") {
        const s = segments.get(e.data.segment);
        if (s && s.text.length + e.data.text.length <= 4 * AI_MAX_STRING) s.text += e.data.text;
      } else if (e.event === "tool_result") tools.push(e.data);
      else if (e.event === "done") done = e.data;
      else if (e.event === "error") error = e.data;
    }
  } else {
    for (const s of Array.isArray(raw.segments) ? raw.segments : []) {
      const r = checked<Omit<AiTurnResult["segments"][number], "segment">>(AiSegmentSchema, s);
      const n = isObj(s) && typeof s.segment === "number" && Number.isInteger(s.segment) && s.segment >= 0 && s.segment <= 200 ? s.segment : segments.size;
      if (r.ok) segments.set(n, { ...r.value, segment: n });
      else dropped += 1;
    }
    for (const t of Array.isArray(raw.tool_results) ? raw.tool_results : []) {
      const r = checked<AiToolResult>(AiToolResultSchema, t);
      if (r.ok) tools.push(r.value);
      else dropped += 1;
    }
    if (raw.done != null) {
      const d = isObj(raw.done) ? { ...raw.done } : raw.done;
      dropped += pruneDone(d);
      const r = checked<NonNullable<AiTurnResult["done"]>>(AiDoneSchema, d);
      if (r.ok) done = r.value;
      else dropped += 1;
    }
    if (raw.error != null) {
      const r = checked<AiError>(AiErrorSchema, raw.error);
      if (r.ok) error = r.value;
      else dropped += 1;
    }
  }
  if (dropped) log?.warn({ upstream: "ai-concierge", dropped }, "ai turn parts dropped (schema)");
  if (!turnId) return null;
  if (!done && !error) error = { turn_id: turnId, code: "AI_PROVIDER_UNAVAILABLE", message: AI_MESSAGES.AI_PROVIDER_UNAVAILABLE!, retryable: true, quota_refunded: false };
  return {
    turn_id: turnId,
    segments: [...segments.values()].sort((a, b) => a.segment - b.segment).filter((s) => s.text.length <= 4 * AI_MAX_STRING),
    tool_results: tools.slice(0, 10),
    done,
    error,
  };
}

// ---------------------------------------------------------------- ошибки

/** Сообщения кодов §8 (по-русски; клиенты переводят по коду). */
export const AI_MESSAGES: Readonly<Record<string, string>> = {
  AI_QUOTA_EXCEEDED: "Лимит запросов к AI-консьержу на сегодня исчерпан",
  AI_CONCIERGE_PAUSED: "AI-консьерж временно отключён",
  AI_BUDGET_EXHAUSTED: "Дневной бюджет AI исчерпан",
  AI_PROVIDER_UNAVAILABLE: "AI сейчас недоступен. Цены и детали — в блоке «Поездка»",
  AI_TIMEOUT: "AI не успел ответить. Попробуйте ещё раз",
  AI_BUSY: "Сейчас много запросов к AI, попробуйте через минуту",
  AI_TURN_IN_PROGRESS: "Предыдущий запрос ещё обрабатывается",
  AI_CONVERSATION_NOT_FOUND: "Диалог не найден",
  AI_TOOL_NOT_ALLOWED: "Это действие недоступно для этого события",
  AI_CONTENT_EXPIRED: "Переписка удалена по сроку хранения",
  EVENT_NOT_FOUND: "Событие не найдено",
  USER_DELETED: "Аккаунт удалён",
};

/** Коды ai-concierge, которые уходят клиенту со своим HTTP-статусом (остальное — 503). */
const PASS: Readonly<Record<string, number>> = {
  AI_QUOTA_EXCEEDED: 429,
  AI_CONCIERGE_PAUSED: 409,
  AI_BUDGET_EXHAUSTED: 429,
  AI_PROVIDER_UNAVAILABLE: 503,
  AI_BUSY: 503,
  AI_TURN_IN_PROGRESS: 409,
  AI_CONVERSATION_NOT_FOUND: 404,
  AI_TOOL_NOT_ALLOWED: 422,
  AI_CONTENT_EXPIRED: 404,
  EVENT_NOT_FOUND: 404,
  USER_DELETED: 410,
};

const retryAfterOf = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 86_400 ? n : null;
};

/** Ошибка ai-concierge → ответ Mini App (только проверенные details). */
export function mapAiError(status: number, code: string, details: unknown, retryAfterHeader?: string | null): AppError {
  const d = isObj(details) ? details : {};
  if (status === 422 && code === "VALIDATION_ERROR") return new AppError(422, "VALIDATION_ERROR", "Некорректные данные запроса", { in: "body" });
  if (status === 429 && code === "RATE_LIMITED") {
    return new AppError(429, "RATE_LIMITED", "Слишком много запросов, повторите позже", { retry_after: retryAfterOf(d.retry_after) ?? 60 });
  }
  const want = PASS[code];
  if (want === undefined || want !== status) return upstreamDown();
  const out: Raw = {};
  const ra = retryAfterOf(d.retry_after) ?? retryAfterOf(retryAfterHeader);
  if (code === "AI_QUOTA_EXCEEDED") {
    for (const k of ["limit", "used"] as const) if (Number.isInteger(d[k]) && (d[k] as number) >= 0) out[k] = d[k];
    if (typeof d.level === "string" && /^[a-z0-9_]{1,32}$/.test(d.level)) out.level = d.level;
    if (typeof d.resets_at === "string" && d.resets_at.length <= 40 && !Number.isNaN(Date.parse(d.resets_at))) out.resets_at = d.resets_at;
    if (typeof out.resets_at === "string") {
      const s = Math.ceil((Date.parse(out.resets_at) - Date.now()) / 1000);
      if (s > 0 && s <= 86_400) out.retry_after = s;
    }
  }
  if (code === "AI_BUDGET_EXHAUSTED" && typeof d.limit === "string" && ["concierge", "evaluation", "ai", "news"].includes(d.limit)) out.limit = d.limit;
  if ((code === "AI_BUDGET_EXHAUSTED" || code === "AI_BUSY") && ra) out.retry_after = ra;
  return new AppError(status, code, AI_MESSAGES[code] ?? "Ошибка AI-консьержа", out);
}

/** Ошибка DomainClient (JSON-эндпоинты) → mapAiError; 5xx/сеть уже 503 у DomainClient. */
function mapClientError(err: unknown): unknown {
  if (err instanceof AppError && err.status < 500) return mapAiError(err.status, err.code, err.details);
  if (err instanceof AppError && err.code === "UPSTREAM_UNAVAILABLE") return upstreamDown();
  return err;
}

// ---------------------------------------------------------------- ограничения профиля

export interface Constraints {
  departures: Array<{ airport_iata: string; city: string; country_code: string }>;
  flight_prefs: { direct: boolean; connecting: boolean; alternative_departure: boolean };
  budget: { min: string | null; max: string | null } | null;
  hotel_prefs: { rating_min: number | null; max_distance_km: number | null; min_stars: number | null } | null;
  interests: string[];
  entities: string[];
  geographies: Array<{ level: string; code: string | null }>;
  horizon_months: number | null;
  lang: "ru" | "en";
}

const AI_INTEREST = new RegExp(CATEGORY_CODE);

/** preferences (недоверенный ответ) → Constraints ai-concierge (§1.2): клиент их не присылает. */
export function constraintsOf(prefs: Preferences, lang: "ru" | "en"): Constraints {
  const trip = tripProfile(prefs);
  const { interests, entities } = interestsOf(prefs);
  const h = hotelFiltersOf(prefs.hotel_prefs, null);
  return {
    departures: trip.departures,
    flight_prefs: trip.flight_prefs,
    budget: trip.budget,
    hotel_prefs: h ? { rating_min: h.rating_min, max_distance_km: h.max_distance_km, min_stars: h.min_stars } : null,
    interests: interests.filter((c) => AI_INTEREST.test(c)).slice(0, 30),
    entities: entities.map((e) => e.slice(0, 80).trim()).filter(Boolean).slice(0, 20),
    geographies: geographiesOf(prefs)
      .filter((g) => g.code === null || g.code.length <= 100)
      .slice(0, 20),
    horizon_months: [3, 6, 12, 24].includes(prefs.search_horizon_months) ? prefs.search_horizon_months : null,
    lang,
  };
}

// ---------------------------------------------------------------- сервис

export interface ConciergeDeps {
  /** чтение (обычный таймаут); null — AI_CONCIERGE_URL не задан */
  ai: DomainClient | null;
  /** создание переписки и ход без стрима (CONCIERGE_TIMEOUT_MS, ответ в конверте {status, body}) */
  aiLong: DomainClient | null;
  baseUrl: string | undefined;
  key: InternalKey;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  log: FastifyBaseLogger;
}

export class ConciergeService {
  constructor(private readonly d: ConciergeDeps) {}

  get configured(): boolean {
    return this.d.ai !== null && this.d.aiLong !== null && !!this.d.baseUrl;
  }

  private client(long = false): DomainClient {
    const c = long ? this.d.aiLong : this.d.ai;
    if (!c) throw aiUnavailable();
    return c;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapClientError(err);
    }
  }

  private bad(what: string): AppError {
    this.d.log.warn({ upstream: "ai-concierge", reason: "schema", what }, "ai-concierge bad response");
    return upstreamDown();
  }

  async quota(userId: string): Promise<AiQuota> {
    const raw = await this.call(() => this.client().get<unknown>("/internal/v1/quota", { subject: userId }));
    const r = checked<AiQuota>(AiQuotaSchema, raw);
    if (!r.ok) throw this.bad("quota");
    return r.value;
  }

  /** Конверт aiLong {status, body, retry_after}: ошибка ai-concierge → AppError (§8), успех — {status, body}. */
  private unwrap(env: unknown): { status: number; body: unknown } {
    const e = isObj(env) ? env : {};
    const status = typeof e.status === "number" ? e.status : 0;
    if (status >= 200 && status < 300) return { status, body: e.body };
    const b = isObj(e.body) ? e.body : {};
    const code = typeof b.code === "string" ? b.code : "UPSTREAM_ERROR";
    if (status >= 500 && code !== "AI_PROVIDER_UNAVAILABLE" && code !== "AI_BUSY") {
      this.d.log.warn({ upstream: "ai-concierge", upstream_status: status, upstream_code: code.slice(0, 64) }, "ai-concierge unavailable");
      throw upstreamDown();
    }
    throw mapAiError(status, code, b.details, typeof e.retry_after === "string" ? e.retry_after : null);
  }

  async create(userId: string, body: Raw, idempotencyKey: string): Promise<{ created: boolean; conversation: AiConversation }> {
    const env = await this.call(() => this.client(true).post<unknown>("/internal/v1/conversations", { subject: userId, body, idempotencyKey }));
    const e = this.unwrap(env);
    const conv = conversationOf(e.body, this.d.log);
    if (!conv) throw this.bad("conversation");
    return { created: e.status === 201, conversation: conv };
  }

  async get(userId: string, conversationId: string): Promise<AiConversation> {
    const raw = await this.call(() => this.client().get<unknown>(`/internal/v1/conversations/${conversationId}`, { subject: userId }));
    const conv = conversationOf(raw, this.d.log);
    if (!conv || conv.conversation_id !== conversationId) throw this.bad("conversation");
    return conv;
  }

  async remove(userId: string, conversationId: string): Promise<void> {
    await this.call(() => this.client().delete(`/internal/v1/conversations/${conversationId}`, { subject: userId }));
  }

  /** Запасной путь без стрима. */
  async turnJson(userId: string, conversationId: string, body: Raw): Promise<AiTurnResult> {
    const env = await this.call(() =>
      this.client(true).post<unknown>(`/internal/v1/conversations/${conversationId}/turns`, { subject: userId, body }),
    );
    const res = turnResultOf(this.unwrap(env).body, this.d.log);
    if (!res) throw this.bad("turn");
    return res;
  }

  /**
   * Открыть поток хода. Ошибка до стрима (HTTP ≥ 400, сеть, не event-stream) → AppError (JSON-ответ клиенту);
   * иначе — Response с телом-потоком. signal — закрытие клиента и таймаут CONCIERGE_TIMEOUT_MS.
   */
  /** clientGone — закрытие клиента (отдельно от таймаута в signal): тогда не «недоступен», а info «client closed». */
  async openStream(userId: string, conversationId: string, body: Raw, signal: AbortSignal, clientGone?: AbortSignal): Promise<Response> {
    if (!this.configured) throw aiUnavailable();
    const token = await issueInternalToken(this.d.key, { issuer: SERVICE_NAME, audience: "ai-concierge", subject: userId });
    let resp: Response;
    try {
      resp = await (this.d.fetchImpl ?? fetch)(`${this.d.baseUrl}/internal/v1/conversations/${conversationId}/turns`, {
        method: "POST",
        headers: {
          ...outgoingHeaders(),
          [INTERNAL_HEADER]: token,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (clientGone?.aborted) {
        this.d.log.info({ upstream: "ai-concierge", reason: "client_closed" }, "ai turn: client closed before upstream response");
        throw new AppError(499, "CLIENT_CLOSED", "Клиент закрыл соединение", {});
      }
      this.d.log.warn({ upstream: "ai-concierge", upstream_status: 0, err_name: (err as Error)?.name }, "ai-concierge unavailable");
      throw upstreamDown();
    }
    if (resp.status >= 400) {
      const text = await readLimited(resp, 65_536).catch(() => "");
      let parsed: Raw = {};
      try {
        const j: unknown = JSON.parse(text);
        if (isObj(j)) parsed = j;
      } catch {
        /* не JSON — 503 */
      }
      const code = typeof parsed.code === "string" ? parsed.code : "UPSTREAM_ERROR";
      const mapped = resp.status >= 500 && code !== "AI_PROVIDER_UNAVAILABLE" && code !== "AI_BUSY"
        ? upstreamDown()
        : mapAiError(resp.status, code, parsed.details, resp.headers.get("retry-after"));
      if (mapped.status >= 500 && mapped.code === "UPSTREAM_UNAVAILABLE") {
        this.d.log.warn({ upstream: "ai-concierge", upstream_status: resp.status, upstream_code: code.slice(0, 64) }, "ai-concierge unavailable");
      }
      throw mapped;
    }
    const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.startsWith("text/event-stream") || !resp.body) {
      await resp.body?.cancel().catch(() => undefined);
      throw this.bad("not_event_stream");
    }
    return resp;
  }
}

async function readLimited(resp: Response, max: number): Promise<string> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Терминальная ошибка, которую BFF присылает сам (поток оборвался или истёк таймаут без done/error). */
export function syntheticError(turnId: string | null, code: "AI_PROVIDER_UNAVAILABLE" | "AI_TIMEOUT"): AiSseEvent {
  return { event: "error", data: { turn_id: turnId, code, message: AI_MESSAGES[code]!, retryable: true, quota_refunded: false } };
}

/**
 * Sprint 7 — the concierge chat without React (tested in test/ai.test.tsx): messages built from SSE events and from the
 * saved history, the texts of tool cards (no technical jargon: «Проверено у поставщиков»), the trip change note, the
 * quota line. Texts are i18n keys; the AI's own text is plain text (the UI never renders it as HTML).
 */
import type {
  AiDoneAction,
  AiAppliedChange,
  TilHeroRef,
  AiMessage,
  AiOfferBrief,
  AiQuickAction,
  AiQuotaNoteKey,
  AiSegment,
  AiSegmentKind,
  AiSource,
  AiSseEvent,
  AiToolArgs,
  AiToolName,
  AiToolResult,
  AiToolStatus,
  AiTripParams,
} from "@tilhero/contracts/bff";

export interface ChatTool {
  call_id: string;
  tool: AiToolName;
  args: AiToolArgs;
  status: "run" | AiToolStatus;
  code: string | null;
  changed: boolean;
  offer: AiOfferBrief | null;
  events: TilHeroRef[] | null;
}

export interface ChatAnswer {
  kind: "answer";
  id: string;
  turn_id: string | null;
  tools: ChatTool[];
  segments: AiSegment[];
  status: "streaming" | "completed" | "partial" | "failed";
  /** wait — seconds of a 429 RATE_LIMITED (sprint 9: «повторите через N с») */
  error: { code: string; retryable: boolean; wait?: number } | null;
  actions: AiDoneAction[];
  applied: AiAppliedChange | null;
  /** sprint 8: the turn changed nothing and was not counted — «Не списано: поездка не изменилась» under the answer */
  quotaNote: AiQuotaNoteKey | null;
}
export interface ChatUser {
  kind: "user";
  id: string;
  text: string;
  /** a quick action in the saved history (text null): its label key (`label_key` of the message, when the server
   *  sends it) or the tool of the turn — the bubble is worded by the UI */
  label?: { key: string | null; tool: AiToolName | null; action?: AiQuickAction };
}
export type ChatItem = ChatAnswer | ChatUser;

export const newAnswer = (id: string): ChatAnswer => ({ kind: "answer", id, turn_id: null, tools: [], segments: [], status: "streaming", error: null, actions: [], applied: null, quotaNote: null });

/** Sprint 8: the note under the answer only when the turn was really not counted and the key is one the UI knows. */
export const quotaNoteOf = (d: { quota_charged?: boolean; quota_note_key?: string | null }): AiQuotaNoteKey | null =>
  d.quota_charged === false && d.quota_note_key === "ai.quota.free_no_change" ? d.quota_note_key : null;

const MAX_SEGMENT = 4000;
/** Plain text of the AI: control characters out (the UI escapes the rest), length bounded. */
export const cleanText = (s: unknown): string => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, MAX_SEGMENT) : "");
const KINDS: ReadonlySet<string> = new Set(["fact", "estimate", "recommendation"]);
const kindOf = (k: unknown): AiSegmentKind => (typeof k === "string" && KINDS.has(k) ? (k as AiSegmentKind) : "recommendation");

/** Sources that can be shown: an https link (opened with Telegram openLink) or a named source without a link. */
export function cleanSources(list: unknown): AiSource[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is AiSource => !!s && typeof s === "object" && typeof (s as AiSource).ref === "string")
    .map((s) => {
      const url = typeof s.url === "string" && /^https:\/\//i.test(s.url) ? s.url : null;
      // the link's own host names the source (a `domain` that disagrees with the link is not trusted)
      const host = url ? hostOf(url) : "";
      return { ...s, url, domain: (host || cleanText(s.domain)).slice(0, 80), title: cleanText(s.title).slice(0, 160) };
    });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

const toolOf = (r: AiToolResult, prev?: ChatTool): ChatTool => ({
  call_id: r.call_id,
  tool: r.tool,
  args: prev?.args ?? {},
  status: r.status,
  code: r.code ?? null,
  changed: !!r.changed,
  offer: r.offer ?? null,
  events: Array.isArray(r.events) ? r.events : null,
});

/** A tool whose result never came (the turn ended or broke first): nothing is known about the supplier. */
export const UNFINISHED = "UNFINISHED";

/** sprint 9: the seconds of a 429 the chat put into its own error event (`retry_after`) */
const waitOf = (d: unknown): { wait?: number } => {
  const v = (d as { retry_after?: unknown }).retry_after;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? { wait: v } : {};
};

/** One SSE event applied to the answer being streamed (pure). */
export function applyEvent(a: ChatAnswer, e: AiSseEvent): ChatAnswer {
  switch (e.event) {
    case "tool_call": {
      if (a.tools.some((x) => x.call_id === e.data.call_id)) return a;
      return { ...a, turn_id: e.data.turn_id ?? a.turn_id, tools: [...a.tools, { call_id: e.data.call_id, tool: e.data.tool, args: e.data.args ?? {}, status: "run", code: null, changed: false, offer: null, events: null }] };
    }
    case "tool_result": {
      const i = a.tools.findIndex((x) => x.call_id === e.data.call_id);
      const tools = i < 0 ? [...a.tools, toolOf(e.data)] : a.tools.map((x, k) => (k === i ? toolOf(e.data, x) : x));
      return { ...a, turn_id: e.data.turn_id ?? a.turn_id, tools };
    }
    case "fact": {
      const segs = [...a.segments];
      segs[e.data.segment] = { kind: kindOf(e.data.kind), text: segs[e.data.segment]?.text ?? "", sources: cleanSources(e.data.sources) };
      return { ...a, segments: fill(segs) };
    }
    case "delta": {
      const segs = [...a.segments];
      const s = segs[e.data.segment] ?? { kind: "recommendation" as const, text: "", sources: [] };
      segs[e.data.segment] = { ...s, text: (s.text + cleanText(e.data.text)).slice(0, MAX_SEGMENT) };
      return { ...a, segments: fill(segs) };
    }
    case "done":
      return {
        ...a,
        turn_id: e.data.turn_id ?? a.turn_id,
        status: e.data.status === "partial" ? "partial" : "completed",
        actions: Array.isArray(e.data.actions) ? e.data.actions : [],
        applied: e.data.applied_change ?? null,
        quotaNote: quotaNoteOf(e.data),
        tools: a.tools.map((x) => (x.status === "run" ? { ...x, status: "failed", code: UNFINISHED } : x)),
      };
    case "error":
      return {
        ...a,
        status: "failed",
        error: {
          code: typeof e.data.code === "string" ? e.data.code : "AI_PROVIDER_UNAVAILABLE",
          retryable: !!e.data.retryable,
          ...waitOf(e.data),
        },
        tools: a.tools.map((x) => (x.status === "run" ? { ...x, status: "failed", code: UNFINISHED } : x)),
      };
    default:
      return a;
  }
}
const fill = (segs: AiSegment[]): AiSegment[] => Array.from(segs, (s) => s ?? { kind: "recommendation", text: "", sources: [] });

/** ai-concierge writes a failed turn as status "error" (+ code); the contract's "failed" means the same. */
const failedStatus = (s: unknown): boolean => s === "failed" || s === "error";

/** The saved history (GET /v1/ai/conversations/{id}) as chat items. */
export function fromHistory(messages: readonly AiMessage[] | undefined): ChatItem[] {
  const out: ChatItem[] = [];
  const list = messages ?? [];
  for (const m of list) {
    if (m.role === "user") {
      const text = cleanText(m.text ?? "").slice(0, 500);
      if (text.trim()) out.push({ kind: "user", id: m.message_id, text });
      else {
        // a quick action: no text — worded as the button was (`action`: tool, args, label_key, params), else by its
        // label key or by the tool of the same turn
        const act = m.action && typeof m.action === "object" && typeof m.action.label_key === "string" ? m.action : null;
        const lk: unknown = act?.label_key ?? m.label_key;
        const key = typeof lk === "string" && lk ? lk : null;
        const tool = act?.tool ?? list.find((x) => x.role === "assistant" && x.turn_id === m.turn_id)?.tool_results?.[0]?.tool ?? null;
        const action: AiQuickAction | undefined = act ? { id: "", tool: act.tool, args: act.args ?? {}, label_key: act.label_key, ...(act.params ? { params: act.params } : {}) } : undefined;
        out.push({ kind: "user", id: m.message_id, text: "", label: { key, tool, ...(action ? { action } : {}) } });
      }
    } else
      out.push({
        kind: "answer",
        id: m.message_id,
        turn_id: m.turn_id,
        tools: (m.tool_results ?? []).map((r) => toolOf(r)),
        segments: (m.segments ?? []).map((s) => ({ kind: kindOf(s.kind), text: cleanText(s.text), sources: cleanSources(s.sources) })),
        status: failedStatus(m.status) ? "failed" : m.status === "partial" ? "partial" : m.status === "running" ? "streaming" : "completed",
        // the turn's error code (history: status "error" + code) — the chat words it as the live error
        error: failedStatus(m.status) ? { code: typeof (m as { code?: unknown }).code === "string" ? ((m as { code?: unknown }).code as string) : "AI_PROVIDER_UNAVAILABLE", retryable: true } : null,
        actions: m.actions ?? [],
        applied: m.applied_change ?? null,
        // sprint 8 (review): the note survives a broken stream — the saved turn carries quota_charged / quota_note_key
        quotaNote: quotaNoteOf(m),
      });
  }
  return out;
}

/* ---------------------------------------------------------------- texts (i18n keys) */

const NO_CHANGE_KEYS: Record<string, string> = {
  NO_DIRECT: "ai.tool.noDirect",
  NO_FLIGHTS: "ai.tool.noFlights",
  ROUTE_NOT_SUPPORTED: "ai.tool.routeUnknown",
  NO_HOTEL: "ai.tool.noHotel",
};

/** Flight link domains (with subdomains) — a copy of packages/contracts/link-domains.json (`flight`), checked by a test;
 *  fix 7.2: + aviasales.tp.st, the short Travelpayouts partner link. */
export const FLIGHT_LINK_DOMAINS = ["aviasales.com", "aviasales.ru", "aviasales.kz", "tp.media", "aviasales.tp.st"] as const;

/** The Aviasales site — where any flight link ends up, a partner redirect included (review 7.2). */
const AVIASALES_DOMAINS = ["aviasales.com", "aviasales.ru", "aviasales.kz"] as const;

/** Хост без точки в конце, в нижнем регистре; пустые метки — null. */
function cleanHost(raw: string): string | null {
  let h = raw.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  return !h || h.startsWith(".") || h.endsWith(".") || h.includes("..") ? null : h;
}
const hostIn = (h: string, list: readonly string[]): boolean => list.some((d) => h === d || h.endsWith(`.${d}`));

/** https без userinfo, порт 443 или без порта, без пробелов и кавычек, ≤ 2048 → URL с чистым хостом, иначе null. */
function parseHttps(v: unknown): URL | null {
  if (typeof v !== "string" || !v || v.length > 2048 || /[\s\u0000-\u001f\u007f\\<>"'`]/.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const host = cleanHost(u.hostname);
  if (u.protocol !== "https:" || !host || u.username || u.password || (u.port !== "" && u.port !== "443")) return null;
  u.hostname = host;
  return u;
}

/** Параметр с целью редиректа: `u` у tp.media, `url` у aviasales.*\/redirect; null — ссылка не редирект. */
function redirectParam(u: URL): string | null {
  if (hostIn(u.hostname, ["tp.media"])) return "u";
  if (hostIn(u.hostname, AVIASALES_DOMAINS) && (u.pathname === "/redirect" || u.pathname.startsWith("/redirect/"))) return "url";
  return null;
}

/**
 * Ссылка на перелёт для пользователя (как tilhero_common.links.flight_link): https, хост из FLIGHT_LINK_DOMAINS (с
 * поддоменами), без точки в конце и в нижнем регистре. Редирект (tp.media/r?u=…, aviasales.*\/redirect?url=…) —
 * только если цель (ровно один параметр) — страница сайта Aviasales. Иначе null.
 */
export function flightLink(v: unknown): string | null {
  const u = parseHttps(v);
  if (!u || !hostIn(u.hostname, FLIGHT_LINK_DOMAINS)) return null;
  const param = redirectParam(u);
  if (param) {
    const targets = u.searchParams.getAll(param);
    const t = targets.length === 1 ? parseHttps(targets[0]) : null;
    if (!t || !hostIn(t.hostname, AVIASALES_DOMAINS) || redirectParam(t)) return null;
  }
  return u.toString();
}

/** A link the chat may open for «Билеты на Aviasales» (done.actions flight_search): `flightLink` of its url. */
export function flightSearchUrl(a: { url?: unknown }): string | null {
  return flightLink(a.url);
}

/** Tool card line without jargon: what the user needs to know, not which service ran. */
export function toolLine(x: ChatTool): { key: string; vars?: Record<string, string | number>; tone: "run" | "ok" | "same" | "fail" | "idle" } {
  const similar = x.tool === "find_similar_event";
  if (x.status === "run") return { key: similar ? "ai.tool.searching" : "ai.tool.runU", tone: "run" };
  if (x.status === "ok") {
    if (similar) return { key: "ai.tool.foundU", vars: { n: x.events?.length ?? 0 }, tone: "ok" };
    return x.changed ? { key: "ai.tool.okU", tone: "ok" } : { key: "ai.tool.sameU", tone: "same" };
  }
  // 7.1: nothing found — the trip stays as it was; a neutral card (not «проверено ✓», not a failure)
  if (x.status === "no_change") {
    const k = NO_CHANGE_KEYS[x.code ?? ""];
    return { key: k ?? "ai.tool.unchanged", tone: "idle" };
  }
  if (x.status === "rejected") {
    if (x.code === "NO_TRIP_PACKAGE") return { key: "ai.tool.noTrip", tone: "fail" };
    if (x.code === "OFFER_DEPARTURE_INVALID") return { key: "ai.tool.badDep", tone: "fail" };
    // ревью 7: offers отверг параметры (не сбой поставщика) — «Повторить» не предлагается сервером
    if (x.code === "OFFER_PARAMS_INVALID") return { key: "ai.tool.badParams", tone: "fail" };
    return { key: "ai.tool.rejected", tone: "fail" };
  }
  if (x.code === UNFINISHED) return { key: "ai.tool.unfinished", tone: "idle" };
  if (x.code === "TOOL_TIMEOUT") return { key: "ai.tool.timeout", tone: "fail" };
  const missing = x.offer?.missing ?? [];
  if (missing.includes("flight") || x.tool === "set_direct_only" || x.tool === "change_departure") return { key: "ai.tool.failFlight", tone: "fail" };
  if (missing.includes("hotel") || x.tool === "set_hotel_distance") return { key: "ai.tool.failHotel", tone: "fail" };
  return { key: "ai.tool.failU", tone: "fail" };
}

/**
 * The change the AI made, as the trip block says it («AI изменил предложение: только прямые рейсы») — the same keys as
 * ai-concierge `change_note` (ai.note.*). The tool's arguments first; what they do not say — from the trip parameters
 * the tool returned (`done.applied_change` carries only those).
 */
export function changeNote(tool: AiToolName, args: AiToolArgs | null | undefined, trip?: AiTripParams | null): { key: string; vars: Record<string, string | number> } {
  const a = args ?? {};
  switch (tool) {
    case "reprice_offer": {
      const tier = typeof a.tier === "string" ? a.tier : null;
      if (tier && tier !== "economy") return { key: "ai.note.tier", vars: { t: tier } };
      if (typeof a.travellers === "number" && !tier && !a.relax) return { key: "ai.note.travellers", vars: { n: a.travellers } };
      return { key: "ai.note.cheaper", vars: {} };
    }
    case "set_direct_only": {
      const direct = typeof a.direct_only === "boolean" ? a.direct_only : !!trip?.direct_only;
      return { key: direct ? "ai.note.direct" : "ai.note.connecting", vars: {} };
    }
    case "change_departure":
      return { key: "ai.note.dep", vars: { iata: String(a.departure_iata ?? trip?.departure_iata ?? "") } };
    case "set_hotel_distance":
      return { key: "ai.note.hotel", vars: { km: Number(a.max_distance_km ?? trip?.hotel_filters?.max_distance_km) || 1 } };
    case "extend_trip_days":
      return { key: "ai.note.nights", vars: { n: Number(a.extra_nights ?? trip?.extra_nights) || 0 } };
    default:
      return { key: "ai.note.cheaper", vars: {} };
  }
}

/** Error codes the chat explains by itself; anything else reads as «AI недоступен». */
export const AI_ERRORS = new Set([
  "AI_QUOTA_EXCEEDED",
  "AI_CONCIERGE_PAUSED",
  "AI_BUDGET_EXHAUSTED",
  "AI_PROVIDER_UNAVAILABLE",
  "AI_TIMEOUT",
  "AI_BUSY",
  "AI_TURN_IN_PROGRESS",
  "AI_CONVERSATION_NOT_FOUND",
  "AI_TOOL_NOT_ALLOWED",
  "AI_TOOL_NOT_FOUND",
  "FEATURE_UNAVAILABLE",
  "RATE_LIMITED",
  "NETWORK",
  "UPSTREAM_UNAVAILABLE",
  "EVENT_NOT_FOUND",
  "USER_DELETED",
  // the stream broke and the saved turn could not be found: the answer may still be there — «Повторить» asks for it
  "TURN_LOST",
]);
export const aiErrorKey = (code: string): string => (AI_ERRORS.has(code) ? `ai.err.${code}` : "ai.err.AI_PROVIDER_UNAVAILABLE");

/** Chips «Видит:» of the conversation context. */
export function contextChips(chips: readonly string[], ctx: { sources_count: number; tier: string | null; trip_kind: string | null }, mode: "event" | "home", hasQuery: boolean): Array<{ key: string; vars?: Record<string, string | number>; plural?: number }> {
  const out: Array<{ key: string; vars?: Record<string, string | number>; plural?: number }> = [];
  if (mode === "home" && hasQuery) out.push({ key: "ai.ctx.query" });
  for (const c of chips) {
    if (c === "event") out.push({ key: "ai.ctx.ev" });
    else if (c === "sources") out.push({ key: "ai.ctx.src", plural: ctx.sources_count, vars: { n: ctx.sources_count } });
    else if (c === "package")
      out.push(ctx.trip_kind === "ticket_only" ? { key: "ai.ctx.ticket" } : ctx.tier ? { key: "ai.ctx.pkg", vars: { t: ctx.tier } } : { key: "ai.ctx.pkg0" });
    else if (c === "prefs") out.push({ key: "ai.ctx.prefs" });
    else if (c === "untrusted") out.push({ key: "ai.ctx.untrusted" });
  }
  return out;
}

export const MAX_INPUT = 500;

/**
 * Quick actions are built by the server when the conversation opens; after a change (the AI's or the user's own) the
 * ones that would change nothing are hidden: «Только прямые» when the trip is direct only already, the departure the
 * trip flies from, the hotel distance already set, nights not above the current, the tier already open.
 */
export function liveQuickActions(list: readonly AiQuickAction[], trip: AiTripParams | null): AiQuickAction[] {
  if (!trip) return [...list];
  return list.filter((q) => {
    const a = q.args;
    switch (q.tool) {
      case "set_direct_only":
        return a.direct_only !== (trip.direct_only === true);
      case "change_departure":
        return a.departure_iata !== trip.departure_iata;
      case "set_hotel_distance":
        return a.max_distance_km !== trip.hotel_filters?.max_distance_km;
      case "extend_trip_days":
        return Number(a.extra_nights) > (trip.extra_nights ?? 0);
      case "reprice_offer":
        return !(typeof a.tier === "string" && a.tier === trip.selected_tier && !(Array.isArray(a.relax) && a.relax.length));
      default:
        return true;
    }
  });
}

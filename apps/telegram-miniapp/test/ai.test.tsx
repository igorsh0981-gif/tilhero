import type { AiQuickAction, AiSseEvent, AiToolResult, AiTurnResult, SessionResponse } from "@tilhero/contracts/bff";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api/client";
import { createApi } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { aiErrorKey, applyEvent, flightSearchUrl, changeNote, cleanSources, cleanText, contextChips, fromHistory, liveQuickActions, newAnswer, quotaNoteOf, toolLine, type ChatTool } from "../src/ai/chat";
import { replayTurn, runTurn, SseParser, toEvent } from "../src/ai/sse";
import { aiStore, quickMemo, quotaExhausted, quotaLeft } from "../src/ai/store";
import { greetingText, noteText, quickActionLabel, tierName } from "../src/ai/text";
import { fromAiTripParams, toAiTripParams, tripBridge, tripKey } from "../src/ai/tripBridge";
import { translate, type MessageKey, type Vars } from "../src/i18n";
import { DEFAULT_PARAMS } from "../src/trip/logic";

const T = "t-1";
const ev = (event: AiSseEvent["event"], data: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify({ turn_id: T, ...data })}\n\n`;
const result = (o: Partial<AiToolResult> = {}): AiToolResult => ({
  turn_id: T,
  call_id: "c1",
  tool: "set_direct_only",
  status: "ok",
  code: null,
  changed: true,
  trip_params: { travellers: 1, direct_only: true, selected_tier: "comfort" },
  offer: null,
  events: null,
  providers: [],
  duration_ms: 900,
  label_key: "ai.tool.okU",
  ...o,
});
const done = (o: Record<string, unknown> = {}) => ({
  turn_id: T,
  message_id: "m1",
  status: "completed",
  applied_change: null,
  actions: [],
  quota: { used: 1, limit: 10, remaining: 9, level: "basic", level_name: "Basic", resets_at: "2026-10-11T00:00:00Z" },
  model: "primary",
  ...o,
});
const tRu = (k: MessageKey, v?: Vars) => translate("ru", k, v);

/* ---------------------------------------------------------------- SSE parser */

describe("SseParser (text/event-stream without a library)", () => {
  it("assembles events across chunk borders, CRLF and LF, skips the heartbeat comment", () => {
    const p = new SseParser();
    const text = `: ping\r\n\r\nid: t:0\r\n${ev("tool_call", { call_id: "c1", tool: "set_direct_only", args: { direct_only: true }, label_key: "ai.tool.runU" })}${ev("delta", { segment: 0, text: "Привет" })}`;
    const out: AiSseEvent[] = [];
    for (let i = 0; i < text.length; i += 7) out.push(...p.feed(text.slice(i, i + 7)));
    out.push(...p.end());
    expect(out.map((e) => e.event)).toEqual(["tool_call", "delta"]);
    expect(out[0]!.data).toMatchObject({ call_id: "c1", args: { direct_only: true } });
    expect(out[1]!.data).toMatchObject({ text: "Привет" });
  });

  it("joins multi-line data, delivers the last event without the blank line at the end", () => {
    const p = new SseParser();
    const evs = p.feed('event: delta\ndata: {"turn_id":"t","segment":0,\ndata: "text":"a"}');
    expect(evs).toEqual([]);
    expect(p.end()).toEqual([{ event: "delta", data: { turn_id: "t", segment: 0, text: "a" } }]);
  });

  it("drops unknown types, broken JSON, non-objects and events without a type", () => {
    const p = new SseParser();
    const evs = p.feed('event: hack\ndata: {"a":1}\n\nevent: delta\ndata: {broken\n\nevent: done\ndata: [1,2]\n\ndata: {"x":1}\n\nevent: done\ndata: "str"\n\n');
    expect(evs).toEqual([]);
    expect(toEvent("fact", '{"turn_id":"t","segment":0,"kind":"fact","sources":[]}')).toMatchObject({ event: "fact" });
    expect(toEvent("fact", "x".repeat(70_000))).toBeNull();
  });
});

describe("replayTurn (the JSON fallback as stream events)", () => {
  it("tool results, then fact + delta per segment in order, then done", () => {
    const r: AiTurnResult = {
      turn_id: T,
      tool_results: [result()],
      segments: [
        { segment: 1, kind: "estimate", text: "B", sources: [] },
        { segment: 0, kind: "fact", text: "A", sources: [] },
      ],
      done: done() as never,
      error: null,
    };
    expect(replayTurn(r).map((e) => `${e.event}${"segment" in e.data ? e.data.segment : ""}`)).toEqual(["tool_result", "fact0", "delta0", "fact1", "delta1", "done"]);
    expect(replayTurn({ turn_id: T, tool_results: [], segments: [], done: null, error: { turn_id: T, code: "AI_TIMEOUT", message: "", retryable: true, quota_refunded: true } }).map((e) => e.event)).toEqual(["error"]);
  });
});

/* ---------------------------------------------------------------- runTurn */

const stream = (text: string, chunk = 11) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (let i = 0; i < text.length; i += chunk) c.enqueue(enc.encode(text.slice(i, i + chunk)));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

describe("runTurn (stream first, JSON fallback, no retry after the first event)", () => {
  const full = ev("tool_call", { call_id: "c1", tool: "set_direct_only", args: {}, label_key: "ai.tool.runU" }) + ev("fact", { segment: 0, kind: "fact", sources: [] }) + ev("delta", { segment: 0, text: "ok" }) + ev("done", done());

  it("reads the stream to done", async () => {
    const seen: string[] = [];
    const accepts: string[] = [];
    const out = await runTurn(
      async (a) => (accepts.push(a), stream(full)),
      (e) => seen.push(e.event),
    );
    expect(out).toEqual({ terminal: true, started: true, via: "sse" });
    expect(seen).toEqual(["tool_call", "fact", "delta", "done"]);
    expect(accepts).toEqual(["text/event-stream"]);
  });

  it("a JSON answer to the stream request (a buffering proxy) is replayed", async () => {
    const seen: string[] = [];
    const body: AiTurnResult = { turn_id: T, tool_results: [], segments: [{ segment: 0, kind: "fact", text: "A", sources: [] }], done: done() as never, error: null };
    const out = await runTurn(
      async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
      (e) => seen.push(e.event),
    );
    expect(out.via).toBe("json");
    expect(seen).toEqual(["fact", "delta", "done"]);
  });

  it("a network failure before any event → the same turn once more with Accept: application/json", async () => {
    const accepts: string[] = [];
    const body: AiTurnResult = { turn_id: T, tool_results: [], segments: [], done: done() as never, error: null };
    const out = await runTurn(
      async (a) => {
        accepts.push(a);
        if (a === "text/event-stream") throw new ApiError(0, "NETWORK", "net");
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      () => undefined,
    );
    expect(accepts).toEqual(["text/event-stream", "application/json"]);
    expect(out).toMatchObject({ terminal: true, via: "json" });
  });

  it("an error before the stream (quota, paused) is thrown as is — no fallback request", async () => {
    const open = vi.fn(async () => {
      throw new ApiError(429, "AI_QUOTA_EXCEEDED", "", { limit: 10 });
    });
    await expect(runTurn(open, () => undefined)).rejects.toMatchObject({ code: "AI_QUOTA_EXCEEDED" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("the stream breaks after the first event → no retry, «not terminal» for the caller to re-read", async () => {
    const open = vi.fn(async () => {
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(ev("tool_call", { call_id: "c1", tool: "set_direct_only", args: {}, label_key: "x" })));
            setTimeout(() => c.error(new TypeError("network")), 10);
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const out = await runTurn(open, () => undefined);
    expect(out).toEqual({ terminal: false, started: true, via: "sse" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("stops reading after done (the rest of the stream is ignored)", async () => {
    const seen: string[] = [];
    await runTurn(async () => stream(full + ev("delta", { segment: 0, text: "late" }), 4000), (e) => seen.push(e.event));
    expect(seen).toEqual(["tool_call", "fact", "delta", "done"]);
  });
});

/* ---------------------------------------------------------------- client + endpoints */

describe("api.ai (Authorization, Accept, the right path)", () => {
  const session: SessionResponse = {
    access_token: "acc-1",
    expires_in: 900,
    refresh_token: "ref-1",
    user: { user_id: "u", display_name: "Igor", username: null, locale: "ru", status: "ACTIVE", is_new: false },
    security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null },
    consent: { accepted: true, policy_version: "1.0", current_policy_version: "1.0", accepted_at: null, evidence_hash: null, age_confirmed_18_plus: true },
    onboarding_completed: true,
  };
  function setup(handler: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return String(url).endsWith("/v1/session/telegram") ? new Response(JSON.stringify(session), { status: 200, headers: { "Content-Type": "application/json" } }) : handler(String(url), init ?? {});
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "https://bff.test", fetchImpl, storage: null, lang: () => "ru" });
    return { client, api: createApi(client), calls };
  }

  it("a quick action goes to …/actions/{tool} with the stream Accept and the bearer token", async () => {
    const { client, api, calls } = setup(() => stream(ev("done", done())));
    await client.startSession("init");
    const res = await api.ai.turn("conv 1", { client_msg_id: "k", args: { direct_only: true } }, "set_direct_only", "text/event-stream");
    expect(res.ok).toBe(true);
    const c = calls[1]!;
    expect(c.url).toBe("https://bff.test/v1/ai/conversations/conv%201/actions/set_direct_only");
    const h = c.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer acc-1");
    expect(h.Accept).toBe("text/event-stream");
    expect(JSON.parse(String(c.init.body))).toEqual({ client_msg_id: "k", args: { direct_only: true } });
  });

  it("an ErrorBody before the stream becomes ApiError with details (429 AI_QUOTA_EXCEEDED)", async () => {
    const { client, api } = setup(() => new Response(JSON.stringify({ code: "AI_QUOTA_EXCEEDED", message: "m", trace_id: "t", details: { limit: 10, used: 10, level: "basic", resets_at: "2026-10-11T00:00:00Z" } }), { status: 429, headers: { "Content-Type": "application/json" } }));
    await client.startSession("init");
    await expect(api.ai.turn("c", { client_msg_id: "k", text: "hi" }, null, "text/event-stream")).rejects.toMatchObject({ code: "AI_QUOTA_EXCEEDED", status: 429, details: { limit: 10 } });
  });
});

/* ---------------------------------------------------------------- the chat reducer */

describe("applyEvent / fromHistory (the answer from events and from the saved history)", () => {
  it("tool card run → ok, segments with kinds and sources, done with actions", () => {
    let a = newAnswer("a1");
    a = applyEvent(a, { event: "tool_call", data: { turn_id: T, call_id: "c1", tool: "set_direct_only", args: { direct_only: true }, label_key: "ai.tool.runU" } });
    expect(a.tools[0]).toMatchObject({ status: "run", args: { direct_only: true } });
    a = applyEvent(a, { event: "tool_result", data: result() });
    expect(a.tools[0]).toMatchObject({ status: "ok", changed: true, args: { direct_only: true } });
    a = applyEvent(a, { event: "fact", data: { turn_id: T, segment: 0, kind: "fact", sources: [{ ref: "S1", title: "x", domain: "ticketmaster.com", url: "https://ticketmaster.com/e", fetched_at: null }] } });
    a = applyEvent(a, { event: "delta", data: { turn_id: T, segment: 0, text: "Рейс " } });
    a = applyEvent(a, { event: "delta", data: { turn_id: T, segment: 0, text: "прямой." } });
    a = applyEvent(a, { event: "delta", data: { turn_id: T, segment: 1, text: "Совет" } }); // a delta before its fact
    a = applyEvent(a, { event: "done", data: done({ actions: [{ type: "watch_price", event_id: "e1" }] }) as never });
    expect(a.segments.map((s) => [s.kind, s.text])).toEqual([
      ["fact", "Рейс прямой."],
      ["recommendation", "Совет"],
    ]);
    expect(a.segments[0]!.sources[0]!.url).toBe("https://ticketmaster.com/e");
    expect(a).toMatchObject({ status: "completed", actions: [{ type: "watch_price", event_id: "e1" }] });
  });

  it("an unknown kind reads as a recommendation; control characters are dropped; text is never HTML", () => {
    let a = applyEvent(newAnswer("a"), { event: "fact", data: { turn_id: T, segment: 0, kind: "opinion" as never, sources: [] } });
    a = applyEvent(a, { event: "delta", data: { turn_id: T, segment: 0, text: "<b>x</b>\u0007" } });
    expect(a.segments[0]).toMatchObject({ kind: "recommendation", text: "<b>x</b>" });
    expect(cleanText(42)).toBe("");
  });

  it("error / done mark a tool still running as unfinished (a neutral line, not «the supplier did not answer»)", () => {
    let a = applyEvent(newAnswer("a"), { event: "tool_call", data: { turn_id: T, call_id: "c1", tool: "reprice_offer", args: {}, label_key: "" } });
    a = applyEvent(a, { event: "error", data: { turn_id: T, code: "AI_TIMEOUT", message: "", retryable: true, quota_refunded: true } });
    expect(a).toMatchObject({ status: "failed", error: { code: "AI_TIMEOUT", retryable: true } });
    expect(a.tools[0]).toMatchObject({ status: "failed", code: "UNFINISHED" });
    const l = toolLine(a.tools[0]!);
    expect([tRu(l.key as MessageKey), l.tone]).toEqual(["Проверка не завершилась", "idle"]);
  });

  it("sources: only https links open; other links stay as a named source", () => {
    const s = cleanSources([{ ref: "S1", title: "T", domain: "evil.com", url: "javascript:alert(1)", fetched_at: null }, { ref: "S2", title: "T", domain: "x.com", url: "http://x.com", fetched_at: null }, null, { title: "no ref" }]);
    expect(s.map((x) => x.url)).toEqual([null, null]);
    // the label is the link's own host, not the `domain` field
    expect(cleanSources([{ ref: "S1", title: "T", domain: "official.com", url: "https://www.evil.example/x", fetched_at: null }])[0]!.domain).toBe("evil.example");
  });

  it("history: user and assistant messages, a failed one stays failed", () => {
    const items = fromHistory([
      { message_id: "u1", turn_id: "t1", role: "user", text: "Привет", segments: null, created_at: "" },
      { message_id: "a1", turn_id: "t1", role: "assistant", text: null, segments: [{ kind: "estimate", text: "Оценка", sources: [] }], created_at: "", status: "partial", tool_results: [result()] },
      // «failed» — ранний формат ai-concierge (до 7b22eb0, теперь status error): читается так же
      { message_id: "a2", turn_id: "t2", role: "assistant", text: null, segments: null, created_at: "", status: "failed" } as never,
    ]);
    expect(items.map((x) => (x.kind === "user" ? x.text : x.status))).toEqual(["Привет", "partial", "failed"]);
    expect(items[1]).toMatchObject({ tools: [{ status: "ok" }], segments: [{ kind: "estimate" }] });
  });

  it("history (ai-concierge 7b22eb0): the pressed button in `action`, a failed turn as status error + code", () => {
    const items = fromHistory([
      { message_id: "u1", turn_id: "t1", role: "user", text: null, segments: null, created_at: "", action: { tool: "change_departure", args: { departure_iata: "ALA" }, label_key: "ai.q.dep", params: { city_name: "Алматы" } } },
      { message_id: "a1", turn_id: "t1", role: "assistant", text: null, segments: [], created_at: "", status: "error", code: "AI_TIMEOUT" } as never,
    ]);
    expect(items[0]).toMatchObject({ kind: "user", label: { key: "ai.q.dep", tool: "change_departure", action: { tool: "change_departure", label_key: "ai.q.dep", params: { city_name: "Алматы" } } } });
    expect(quickActionLabel(tRu, (items[0] as { label: { action: AiQuickAction } }).label.action)).toBe("Вылет: Алматы");
    expect(items[1]).toMatchObject({ kind: "answer", status: "failed", error: { code: "AI_TIMEOUT", retryable: true } });
  });

  it("history: a quick action without text is labelled by label_key or by its tool; a running turn stays streaming", () => {
    const items = fromHistory([
      { message_id: "u1", turn_id: "t1", role: "user", text: null, segments: null, created_at: "" },
      { message_id: "a1", turn_id: "t1", role: "assistant", text: null, segments: [], created_at: "", status: "completed", tool_results: [result({ tool: "set_direct_only" })] },
      { message_id: "u2", turn_id: "t2", role: "user", text: null, segments: null, created_at: "", label_key: "ai.q.near" } as never,
      { message_id: "a2", turn_id: "t2", role: "assistant", text: null, segments: null, created_at: "", status: "running" },
    ]);
    expect(items[0]).toMatchObject({ kind: "user", text: "", label: { key: null, tool: "set_direct_only" } });
    expect(items[2]).toMatchObject({ kind: "user", label: { key: "ai.q.near", tool: null } });
    expect(items[3]).toMatchObject({ kind: "answer", status: "streaming", turn_id: "t2" });
  });
});

/* ---------------------------------------------------------------- texts */

describe("tool lines, change notes, chips, errors (no technical jargon)", () => {
  const tool = (o: Partial<ChatTool>): ChatTool => ({ call_id: "c", tool: "set_direct_only", args: {}, status: "ok", code: null, changed: true, offer: null, events: null, ...o });
  it("tool lines name what the user needs, never a service", () => {
    const line = (o: Partial<ChatTool>) => tRu(toolLine(tool(o)).key as MessageKey, toolLine(tool(o)).vars);
    expect(line({ status: "run" })).toBe("Пересчитываю у поставщиков…");
    expect(line({})).toBe("Проверено у поставщиков");
    expect(line({ changed: false })).toBe("Проверено у поставщиков · без изменений");
    // 7.1: nothing found — a neutral card «Поездка без изменений: …» (tone idle), never «проверено ✓»
    expect(line({ status: "no_change", code: "NO_DIRECT" })).toBe("Поездка без изменений: прямых рейсов нет");
    expect(line({ status: "no_change", code: "NO_FLIGHTS" })).toBe("Поездка без изменений: рейсов на эти даты нет");
    expect(line({ status: "no_change", code: "ROUTE_NOT_SUPPORTED" })).toBe("Поездка без изменений: поставщик перелётов не знает маршрут");
    expect(line({ status: "no_change", code: "NO_HOTEL" })).toBe("Поездка без изменений: подходящего отеля нет");
    expect(line({ status: "no_change", code: "SOMETHING_NEW" })).toBe("Поездка без изменений");
    expect(toolLine(tool({ status: "no_change", code: "NO_FLIGHTS" })).tone).toBe("idle");
    expect(flightSearchUrl({ url: "https://www.aviasales.ru/search/TAS0412FRU1" })).toBe("https://www.aviasales.ru/search/TAS0412FRU1");
    const tp = "https://tp.media/r?marker=1&u=https%3A%2F%2Fwww.aviasales.ru%2Fsearch%2FTAS0412FRU1";
    expect(flightSearchUrl({ url: tp })).toBe(tp);
    expect(flightSearchUrl({ url: "https://tp.media/r?x=1" })).toBeNull(); // review 7.2: no redirect target
    for (const bad of ["http://www.aviasales.ru/x", "https://aviasales.ru.evil.com/x", "javascript:alert(1)", 42]) expect(flightSearchUrl({ url: bad })).toBeNull();
    expect(line({ status: "failed", code: "PROVIDER_UNAVAILABLE" })).toBe("Поставщик перелётов не ответил");
    expect(line({ status: "failed", code: "PROVIDER_UNAVAILABLE", tool: "set_hotel_distance" })).toBe("Поставщик отелей не ответил");
    expect(line({ status: "failed", code: "TOOL_TIMEOUT" })).toBe("Поставщик не ответил вовремя");
    expect(line({ status: "rejected", code: "NO_TRIP_PACKAGE" })).toBe("У события нет пакета поездки");
    expect(line({ status: "rejected", code: "OFFER_PARAMS_INVALID" })).toBe("Расчёт не принял эти параметры поездки");
    expect(line({ tool: "find_similar_event", events: [] as never })).toBe("Нашёл в каталоге: 0");
    for (const st of ["run", "ok", "no_change", "failed", "rejected"] as const) expect(line({ status: st })).not.toMatch(/service|API|offer|timeout/i);
  });

  it("change notes match ai-concierge note keys; the tier is named", () => {
    const n = (tool: Parameters<typeof changeNote>[0], args: Parameters<typeof changeNote>[1], trip?: Parameters<typeof changeNote>[2]) => noteText(tRu, changeNote(tool, args, trip));
    expect(n("set_direct_only", { direct_only: true })).toBe("только прямые рейсы");
    expect(n("set_direct_only", undefined, { travellers: 1, direct_only: false })).toBe("рейсы с пересадками разрешены");
    expect(n("change_departure", { departure_iata: "ALA" })).toBe("вылет из ALA");
    expect(n("set_hotel_distance", undefined, { travellers: 1, hotel_filters: { max_distance_km: 3 } })).toBe("отель до 3 км от площадки");
    expect(n("extend_trip_days", { extra_nights: 2 })).toBe("дополнительных ночей: 2");
    expect(n("reprice_offer", { tier: "premium" })).toBe("тариф Premium");
    expect(n("reprice_offer", { tier: "economy" })).toBe("пакет дешевле");
    expect(n("reprice_offer", { travellers: 3 })).toBe("путешественников: 3");
    expect(noteText(tRu, { key: "ai.note.from_newer_server", vars: {} })).toBe("пакет дешевле");
    expect(tierName(tRu, "comfort")).toBe("Comfort");
    expect(tierName(tRu, "lux")).toBe("");
  });

  it("«Видит:» chips from the conversation context", () => {
    const c = contextChips(["event", "sources", "package", "prefs", "untrusted", "unknown"], { sources_count: 3, tier: "economy", trip_kind: "trip" }, "event", false);
    expect(c.map((x) => x.key)).toEqual(["ai.ctx.ev", "ai.ctx.src", "ai.ctx.pkg", "ai.ctx.prefs", "ai.ctx.untrusted"]);
    expect(contextChips(["package"], { sources_count: 0, tier: null, trip_kind: "ticket_only" }, "event", false)[0]!.key).toBe("ai.ctx.ticket");
    expect(contextChips(["prefs"], { sources_count: 0, tier: null, trip_kind: null }, "home", true)[0]!.key).toBe("ai.ctx.query");
  });

  it("every AI error code has a text; unknown codes read as «AI недоступен»", () => {
    for (const code of ["AI_QUOTA_EXCEEDED", "AI_CONCIERGE_PAUSED", "AI_BUDGET_EXHAUSTED", "AI_PROVIDER_UNAVAILABLE", "AI_TIMEOUT", "AI_BUSY", "AI_TURN_IN_PROGRESS", "AI_CONVERSATION_NOT_FOUND", "AI_TOOL_NOT_ALLOWED", "AI_TOOL_NOT_FOUND", "FEATURE_UNAVAILABLE", "RATE_LIMITED", "NETWORK"]) {
      const k = aiErrorKey(code) as MessageKey;
      expect(tRu(k), code).not.toBe(k);
    }
    expect(aiErrorKey("WHATEVER")).toBe("ai.err.AI_PROVIDER_UNAVAILABLE");
  });

  it("quick actions that would change nothing are hidden after a change", () => {
    const qa = (id: string, tool: AiQuickAction["tool"], args: AiQuickAction["args"]): AiQuickAction => ({ id, tool, args, label_key: `ai.q.${id}` });
    const list = [
      qa("cheaper", "reprice_offer", { tier: "economy" }),
      qa("direct", "set_direct_only", { direct_only: true }),
      qa("near", "set_hotel_distance", { max_distance_km: 1 }),
      qa("plus2", "extend_trip_days", { extra_nights: 2 }),
      qa("dep_TAS", "change_departure", { departure_iata: "TAS" }),
      qa("dep_ALA", "change_departure", { departure_iata: "ALA" }),
      qa("similar", "find_similar_event", { reason: "same_category" }),
    ];
    expect(liveQuickActions(list, null)).toHaveLength(7);
    const ids = liveQuickActions(list, { travellers: 1, direct_only: true, departure_iata: "ALA", extra_nights: 2, hotel_filters: { max_distance_km: 1 }, selected_tier: "economy" }).map((q) => q.id);
    expect(ids).toEqual(["dep_TAS", "similar"]);
  });
});

describe("server-built quick actions and the greeting (ai-concierge §1.2: plus1, dep params, scalar greeting)", () => {
  const tEn = (k: MessageKey, v?: Vars) => translate("en", k, v);
  const plus1: AiQuickAction = { id: "plus1", tool: "extend_trip_days", args: { extra_nights: 1 }, label_key: "ai.q.plus1", params: {} };
  const depAla: AiQuickAction = { id: "dep_ALA", tool: "change_departure", args: { departure_iata: "ALA" }, label_key: "ai.q.dep", params: { iata: "ALA", city_name: "Алматы" } };

  it("plus1 reads «Продлить на день»; a departure is named by the city from params, else by the airport code", () => {
    expect(quickActionLabel(tRu, plus1)).toBe("Продлить на день");
    expect(quickActionLabel(tEn, plus1)).toBe("Extend by a day");
    expect(quickActionLabel(tRu, depAla)).toBe("Вылет: Алматы");
    expect(quickActionLabel(tEn, { ...depAla, params: { iata: "ALA", city_name: "Almaty" } })).toBe("Fly from Almaty");
    // params omitted (older server) or city_name null — the airport code, never «undefined»
    const { params: _omit, ...noParams } = depAla;
    expect(quickActionLabel(tRu, noParams)).toBe("Вылет: ALA");
    expect(quickActionLabel(tRu, { ...depAla, params: { iata: "ALA", city_name: null } })).toBe("Вылет: ALA");
    // an unknown label key from a newer server → the tool's generic label
    expect(quickActionLabel(tRu, { ...plus1, label_key: "ai.q.plus7" })).toBe("Продлить поездку");
  });

  it("plus1 hides once the trip already has that many nights (the server sends current + 1)", () => {
    expect(liveQuickActions([plus1], { travellers: 1 }).map((q) => q.id)).toEqual(["plus1"]);
    expect(liveQuickActions([plus1], { travellers: 1, extra_nights: 1 })).toEqual([]);
  });

  it("the online greeting takes scalar price_amount / price_currency; no price → no sum (never guessed)", () => {
    const money = (a: string, c: string) => `${c} ${a}`;
    expect(greetingText(tRu, { key: "ai.hello.online", params: { price_amount: "120.00", price_currency: "USD" } }, money)).toContain("только билет от USD 120.00");
    expect(greetingText(tRu, { key: "ai.hello.online", params: { price_amount: null, price_currency: null } }, money)).toBe(tRu("ai.hello.online0"));
    // a broken amount or currency is not shown as a price
    expect(greetingText(tRu, { key: "ai.hello.online", params: { price_amount: "1e9", price_currency: "USD" } }, money)).toBe(tRu("ai.hello.online0"));
    expect(greetingText(tRu, { key: "ai.hello.online", params: { price_amount: "120.00", price_currency: "usd" } }, money)).toBe(tRu("ai.hello.online0"));
    // early servers sent an object — still read
    expect(greetingText(tRu, { key: "ai.hello.online", params: { price: { amount: "35.50", currency: "EUR" } } as never }, money)).toContain("EUR 35.50");
  });

  it("the other greetings: tier name, query, unknown key → Home greeting", () => {
    const money = () => "";
    expect(greetingText(tRu, { key: "ai.hello", params: { tier: "comfort" } }, money)).toContain(tierName(tRu, "comfort"));
    expect(greetingText(tRu, { key: "ai.hello", params: { tier: null } }, money)).toBe(tRu("ai.hello.notier"));
    expect(greetingText(tRu, { key: "ai.hello.cat", params: { query: "джаз" } }, money)).toContain("«джаз»");
    expect(greetingText(tRu, { key: "ai.hello.post", params: { reason: "past" } }, money)).toBe(tRu("ai.hello.post"));
    expect(greetingText(tRu, { key: "ai.hello.zzz", params: {} }, money)).toBe(tRu("ai.hello.home"));
    expect(greetingText(tRu, undefined, money)).toBe(tRu("ai.hello.home"));
  });
});

/* ---------------------------------------------------------------- the trip bridge */

describe("tripBridge (the trip on screen ↔ the concierge)", () => {
  it("sends exactly the recalculate body + the open tier", () => {
    expect(toAiTripParams(DEFAULT_PARAMS, "comfort")).toEqual({ travellers: 1, direct_only: false, near_venue: false, extra_nights: 0, selected_tier: "comfort" });
    expect(toAiTripParams({ ...DEFAULT_PARAMS, travellers: 2, direct_only: true, departure_iata: "ALA", hotel_filters: { max_distance_km: 3 } }, "economy")).toEqual({
      travellers: 2,
      direct_only: true,
      near_venue: false,
      extra_nights: 0,
      departure_iata: "ALA",
      hotel_filters: { max_distance_km: 3 },
      selected_tier: "economy",
    });
  });

  it("takes back what a tool priced — broken fields fall back to the defaults, never thrown", () => {
    expect(fromAiTripParams({ travellers: 9, departure_iata: "tas", direct_only: true, extra_nights: 7, hotel_id: "bad id!", keep_hotels: { lux: "h1", economy: "h-2" } as never, hotel_filters: { max_distance_km: 2 }, selected_tier: "lux" as never })).toEqual({
      params: { ...DEFAULT_PARAMS, travellers: 6, direct_only: true, extra_nights: 3, keep_hotels: { economy: "h-2" } },
      tier: null,
    });
    expect(fromAiTripParams({ travellers: 2, selected_tier: "premium", hotel_filters: { max_distance_km: 1, rating_min: 8 } })).toMatchObject({ params: { travellers: 2, hotel_filters: { max_distance_km: 1, rating_min: 8 } }, tier: "premium" });
  });

  it("registration per event; apply reaches only the registered block and tells whether «Поездка» took it", async () => {
    const apply = vi.fn(async () => false);
    const sync = vi.fn();
    const off = tripBridge.register("e1", { get: () => ({ travellers: 1 }), apply, sync });
    expect(tripBridge.sync("e2", { travellers: 1, direct_only: true })).toBe(false);
    expect(tripBridge.sync("e1", { travellers: 1, direct_only: true })).toBe(true);
    expect(sync).toHaveBeenCalledWith({ travellers: 1, direct_only: true });
    expect(apply).not.toHaveBeenCalled();
    expect(tripBridge.get("e1")).toEqual({ travellers: 1 });
    expect(tripBridge.apply("e2", { travellers: 1 }, { key: "ai.note.direct", vars: {} })).toBeNull();
    await expect(tripBridge.apply("e1", { travellers: 1 }, { key: "ai.note.direct", vars: {} })).resolves.toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    off();
    expect(tripBridge.get("e1")).toBeNull();
  });
});

describe("tripKey (one spelling of a trip)", () => {
  it("the server's trip and the block's trip compare equal; another trip differs", () => {
    const fromServer = { travellers: 1, direct_only: true, selected_tier: "comfort" as const };
    const fromBlock = toAiTripParams({ ...DEFAULT_PARAMS, direct_only: true }, "comfort");
    expect(tripKey(fromServer)).toBe(tripKey(fromBlock));
    expect(tripKey({ travellers: 1, selected_tier: "comfort" })).not.toBe(tripKey(fromServer));
    expect(tripKey(null)).toBe("");
  });
});

/* ---------------------------------------------------------------- availability */

describe("aiStore (is the concierge there, the quota)", () => {
  it("FEATURE_UNAVAILABLE and 404 hide the entry points; a transient failure keeps them and asks again", async () => {
    aiStore.reset();
    await aiStore.load(async () => {
      throw new ApiError(503, "FEATURE_UNAVAILABLE", "");
    });
    expect(aiStore.get().availability).toBe("off");
    aiStore.reset();
    await aiStore.load(async () => {
      throw new ApiError(404, "NOT_FOUND", "");
    });
    expect(aiStore.get().availability).toBe("off");
    aiStore.reset();
    const fetchQuota = vi.fn(async () => {
      throw new ApiError(0, "NETWORK", "");
    });
    await aiStore.load(fetchQuota);
    expect(aiStore.get().availability).toBe("on");
    await aiStore.load(fetchQuota);
    expect(fetchQuota).toHaveBeenCalledTimes(2);
  });

  it("the quota: loaded once, updated by done, exhausted by 429 details", async () => {
    aiStore.reset();
    const q = { used: 2, limit: 10, remaining: 8, level: "basic", level_name: "Basic", resets_at: "2026-10-11T00:00:00Z" };
    const f = vi.fn(async () => q);
    await aiStore.load(f);
    await aiStore.load(f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(quotaLeft(aiStore.get().quota)).toEqual({ left: 8, limit: 10 });
    aiStore.setQuota({ ...q, used: 3, remaining: 7 });
    expect(quotaLeft(aiStore.get().quota)).toEqual({ left: 7, limit: 10 });
    aiStore.setQuota({ nonsense: true } as never);
    expect(quotaLeft(aiStore.get().quota)).toEqual({ left: 7, limit: 10 });
    aiStore.exhausted({ limit: 20, used: 20, level: "plus", resets_at: "2026-10-12T00:00:00Z" });
    expect(aiStore.get().quota).toMatchObject({ remaining: 0, limit: 20, level: "plus", resets_at: "2026-10-12T00:00:00Z" });
    aiStore.open({ mode: "home", eventId: null, title: null, query: "jazz" });
    expect(aiStore.get().chat).toMatchObject({ mode: "home", query: "jazz" });
    aiStore.close();
    expect(aiStore.get().chat).toBeNull();
    aiStore.reset();
  });

  it("the limit holds until resets_at, then the chat is open again", () => {
    const q = { used: 10, limit: 10, remaining: 0, level: "basic", level_name: "Basic", resets_at: "2026-10-11T00:00:00Z" };
    expect(quotaExhausted(q, Date.parse("2026-10-10T23:59:00Z"))).toBe(true);
    expect(quotaExhausted(q, Date.parse("2026-10-11T00:00:01Z"))).toBe(false);
    expect(quotaExhausted({ ...q, remaining: 1 }, 0)).toBe(false);
    expect(quotaExhausted(null)).toBe(false);
  });

  it("quick actions are remembered per conversation and trip («Отменить» brings the earlier set back)", () => {
    const qa = (id: string): AiQuickAction => ({ id, tool: "set_direct_only", args: { direct_only: true }, label_key: "ai.q.direct" });
    quickMemo.put("c1", "trip-a", [qa("direct")]);
    quickMemo.put("c1", "trip-b", [qa("near")]);
    expect(quickMemo.get("c1", "trip-a")!.map((x) => x.id)).toEqual(["direct"]);
    expect(quickMemo.get("c2", "trip-a")).toBeNull();
    expect(quickMemo.get("c1", "")).toBeNull();
    for (let i = 0; i < 50; i++) quickMemo.put("c9", `t${i}`, []);
    expect(quickMemo.get("c1", "trip-a")).toBeNull(); // bounded
    quickMemo.clear();
  });
});

/* ---------------------------------------------------------------- sprint 8: rule NC */

describe("sprint 8: a turn «без изменений» is not counted (done.quota_charged / quota_note_key)", () => {
  it("done with quota_charged false + the known key → the note under the answer; the quota is the server's", () => {
    const a = applyEvent(newAnswer("a"), { event: "done", data: done({ quota_charged: false, quota_note_key: "ai.quota.free_no_change", quota: { used: 3, limit: 10, remaining: 7, level: "basic", level_name: "Basic", resets_at: "2026-10-11T00:00:00Z" } }) as never });
    expect(a.quotaNote).toBe("ai.quota.free_no_change");
    expect(tRu("ai.quota.free_no_change")).toBe("Не списано: поездка не изменилась");
    expect(translate("en", "ai.quota.free_no_change")).toBe("Not counted: the trip didn't change");
    expect(tRu("ai.quota", { n: 7, max: 10 })).toBe("Осталось 7 из 10");
  });

  it("no note: charged, an old ai-concierge without the fields, an unknown key, a note without quota_charged false", () => {
    for (const extra of [{ quota_charged: true, quota_note_key: null }, {}, { quota_charged: false, quota_note_key: "ai.quota.other" }, { quota_note_key: "ai.quota.free_no_change" }]) {
      expect(applyEvent(newAnswer("a"), { event: "done", data: done(extra) as never }).quotaNote).toBeNull();
    }
    expect(quotaNoteOf({ quota_charged: false, quota_note_key: null })).toBeNull();
    expect(newAnswer("x").quotaNote).toBeNull();
  });

  it("an error event carries no note; the saved history does (review: the note survives a broken stream)", () => {
    const e = applyEvent(newAnswer("a"), { event: "error", data: { turn_id: T, code: "AI_TIMEOUT", message: "", retryable: true, quota_refunded: true } });
    expect(e.quotaNote).toBeNull();
    const seg = [{ kind: "fact" as const, text: "x", sources: [] }];
    const items = fromHistory([
      { message_id: "a1", turn_id: "t1", role: "assistant", text: null, segments: seg, created_at: "", status: "completed", quota_charged: false, quota_note_key: "ai.quota.free_no_change" },
      { message_id: "a2", turn_id: "t2", role: "assistant", text: null, segments: seg, created_at: "", status: "completed", quota_charged: true, quota_note_key: null },
      // ai-concierge before sprint 8 / a running turn: no fields — no note
      { message_id: "a3", turn_id: "t3", role: "assistant", text: null, segments: seg, created_at: "", status: "completed" },
      { message_id: "a4", turn_id: "t4", role: "assistant", text: null, segments: seg, created_at: "", status: "error", code: "AI_TIMEOUT", quota_charged: false, quota_note_key: null },
    ]);
    expect(items.map((x) => (x.kind === "answer" ? x.quotaNote : "user"))).toEqual(["ai.quota.free_no_change", null, null, null]);
  });
});

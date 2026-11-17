/**
 * Sprint 7 — the concierge's turn over SSE (INTERNAL_API §1.3, §5) without an SSE library: `fetch` + a line parser.
 *
 * - The stream: `event: <type>` / `data: <JSON one line>` / `id:` / comments (`: ping` heartbeat). Only the six types
 *   of AiSseEvent with a JSON object `data` are passed on; anything else is dropped (a broken upstream must not break
 *   the chat).
 * - The fallback path: the server (or a buffering proxy) answered `application/json` — the AiTurnResult is replayed as
 *   the same events; no ReadableStream in the WebView — the whole body is parsed at once; the request failed before
 *   any event (network) — the same turn once more with `Accept: application/json` (the same client_msg_id: idempotent).
 * - No retry after the first event (as GymBot): the caller re-reads the conversation (`broken`).
 */
import type { AiSseEvent, AiTurnResult } from "@tilhero/contracts/bff";
import { ApiError } from "../api/errors";

export const SSE_TYPES = ["tool_call", "tool_result", "fact", "delta", "done", "error"] as const;
type SseType = (typeof SSE_TYPES)[number];
const MAX_DATA = 64_000;

/** Incremental `text/event-stream` parser: feed() chunks, get complete events back. */
export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];

  feed(chunk: string): AiSseEvent[] {
    this.buf += chunk;
    const out: AiSseEvent[] = [];
    let i: number;
    while ((i = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, i);
      const nl = this.buf.startsWith("\r\n", i) ? 2 : 1;
      this.buf = this.buf.slice(i + nl);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    if (this.buf.length > MAX_DATA) this.buf = ""; // a runaway line without a newline is dropped
    return out;
  }

  /** The stream ended: a last event without the blank line is still delivered. */
  end(): AiSseEvent[] {
    const out: AiSseEvent[] = [];
    if (this.buf) {
      const ev = this.line(this.buf);
      if (ev) out.push(ev);
      this.buf = "";
    }
    const ev = this.dispatch();
    if (ev) out.push(ev);
    return out;
  }

  private line(line: string): AiSseEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null; // heartbeat / comment
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? "" : line.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return null;
  }

  private dispatch(): AiSseEvent | null {
    const type = this.event;
    const raw = this.data.join("\n");
    this.event = "";
    this.data = [];
    return toEvent(type, raw);
  }
}

/** One validated event or null (unknown type, broken JSON, not an object). */
export function toEvent(type: string, raw: string): AiSseEvent | null {
  if (!(SSE_TYPES as readonly string[]).includes(type) || !raw || raw.length > MAX_DATA) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return { event: type as SseType, data } as AiSseEvent;
  } catch {
    return null;
  }
}

/** The fallback JSON answer (AiTurnResult) as the events the stream would have carried. */
export function replayTurn(r: AiTurnResult): AiSseEvent[] {
  const out: AiSseEvent[] = [];
  for (const tr of r.tool_results ?? []) out.push({ event: "tool_result", data: tr });
  for (const s of [...(r.segments ?? [])].sort((a, b) => a.segment - b.segment)) {
    out.push({ event: "fact", data: { turn_id: r.turn_id, segment: s.segment, kind: s.kind, sources: s.sources ?? [] } });
    out.push({ event: "delta", data: { turn_id: r.turn_id, segment: s.segment, text: s.text } });
  }
  if (r.done) out.push({ event: "done", data: r.done });
  else if (r.error) out.push({ event: "error", data: r.error });
  return out;
}

export interface TurnOutcome {
  /** a done / error event arrived */
  terminal: boolean;
  /** at least one event arrived */
  started: boolean;
  /** how the answer came: the stream, the JSON fallback */
  via: "sse" | "json";
}

const isJson = (res: Response) => /application\/json/i.test(res.headers.get("content-type") ?? "");

async function consume(res: Response, onEvent: (e: AiSseEvent) => void, state: { started: boolean; terminal: boolean }): Promise<void> {
  // nothing after the terminal event is delivered (done / error is the last word of a turn)
  const emit = (e: AiSseEvent) => {
    if (state.terminal) return;
    state.started = true;
    if (e.event === "done" || e.event === "error") state.terminal = true;
    onEvent(e);
  };
  if (isJson(res)) {
    const r = (await res.json()) as AiTurnResult;
    for (const e of replayTurn(r)) emit(e);
    return;
  }
  const parser = new SseParser();
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    // no streaming in this WebView: the whole answer at once
    for (const e of [...parser.feed(await res.text()), ...parser.end()]) emit(e);
    return;
  }
  const reader = body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const e of parser.feed(dec.decode(value, { stream: true }))) emit(e);
    if (state.terminal) {
      void reader.cancel().catch(() => undefined);
      return;
    }
  }
  for (const e of [...parser.feed(dec.decode()), ...parser.end()]) emit(e);
}

/**
 * Runs a turn: the stream first, the JSON fallback when the stream could not start. ApiError before the stream (quota,
 * paused, budget, 404, validation) is thrown to the caller as is.
 */
export async function runTurn(open: (accept: "text/event-stream" | "application/json") => Promise<Response>, onEvent: (e: AiSseEvent) => void): Promise<TurnOutcome> {
  const state = { started: false, terminal: false };
  try {
    const res = await open("text/event-stream");
    const via = isJson(res) ? "json" : "sse";
    await consume(res, onEvent, state);
    return { ...state, via };
  } catch (e) {
    if (e instanceof ApiError && e.code !== "NETWORK") throw e;
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    if (state.started) return { ...state, via: "sse" }; // broken after the first event: no retry, the caller re-reads
    const res = await open("application/json");
    await consume(res, onEvent, state);
    return { ...state, via: "json" };
  }
}

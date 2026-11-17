/**
 * Подделка ai-concierge (INTERNAL_API спринта 7 §1.2–1.3) для тестов telegram-bff: переписки с владельцем по sub,
 * квота, ход — поток text/event-stream по сценарию (части текста и паузы) или JSON (Accept: application/json).
 */
import { randomUUID } from "node:crypto";
import { domainError, json, type FakeDomains, type Req } from "./helpers.js";

export type Step = string | { wait: number } | { gate: Promise<void> };

export interface AiFakeState {
  /** conversation_id → владелец */
  owners: Map<string, string>;
  idem: Map<string, string>;
  /** сценарий потока следующего хода (по умолчанию — обычный ответ) */
  script: ((turnId: string) => Step[]) | null;
  /** подмена ответа целиком (ошибки до стрима и т. п.) */
  turnOverride: ((r: Req) => Response | null) | null;
  /** upstream получил отмену потока */
  aborted: boolean;
  /** поток дошёл до конца сценария */
  finished: boolean;
  conversationExtra: Record<string, unknown>;
  messages: unknown[];
}

export const QUOTA = { used: 1, limit: 10, remaining: 9, level: "basic", level_name: "Базовый", resets_at: "2026-10-13T00:00:00Z" };

export function conversationFixture(id: string, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation_id: id,
    mode: "event",
    event_id: "0b7c3a52-1d2e-4f60-8a9b-000000000777",
    status: "open",
    context: { chips: ["event", "sources", "package", "prefs", "untrusted"], sources_count: 2, trip_kind: "trip", tier: "comfort", allowed_departures: ["TAS", "ALA"] },
    greeting: { key: "ai.hello", params: { tier: "comfort" } },
    quick_actions: [
      { id: "cheaper", tool: "reprice_offer", args: { tier: "economy" }, label_key: "ai.q.cheaper" },
      { id: "direct", tool: "set_direct_only", args: { direct_only: true }, label_key: "ai.q.direct" },
      { id: "dep_ALA", tool: "change_departure", args: { departure_iata: "ALA" }, label_key: "ai.q.dep" },
    ],
    quota: QUOTA,
    created_at: "2026-10-12T10:00:00.123456Z",
    last_activity_at: "2026-10-12T10:00:00Z",
    internal_note: "лишнее поле — BFF не пропускает",
    ...o,
  };
}

export const OFFER_BRIEF = {
  offer_ids: { economy: "11111111-1111-4111-8111-111111111111", comfort: "22222222-2222-4222-8222-222222222222", premium: null },
  tier: "comfort",
  status: "complete",
  per_person: "1470.00",
  total: "2940.00",
  missing: [],
  flight: { origin: "TAS", destination: "AUH", transfers: 0, price_per_person: "420.00", provider: "aviasales", fetched_at: "2026-10-12T09:00:00Z" },
  hotel: { name: "Yas Hotel", distance_km: 1.9, rating: "9.1", price_total: "1040.00", provider: "liteapi", fetched_at: "2026-10-12T09:00:00Z" },
  budget_fit: "within",
  budget_excludes: [],
};

/** События обычного хода «только прямые» (AT-28). */
export function happyEvents(turnId: string): Array<[string, Record<string, unknown>]> {
  const callId = "c1";
  return [
    ["tool_call", { turn_id: turnId, call_id: callId, tool: "set_direct_only", args: { direct_only: true }, label_key: "ai.tool.runU" }],
    [
      "tool_result",
      {
        turn_id: turnId,
        call_id: callId,
        tool: "set_direct_only",
        status: "ok",
        code: null,
        changed: true,
        trip_params: { travellers: 2, direct_only: true, selected_tier: "comfort" },
        offer: OFFER_BRIEF,
        events: null,
        providers: [{ provider: "aviasales", fetched_at: "2026-10-12T09:00:00Z" }],
        duration_ms: 812,
        label_key: "ai.tool.okU",
        secret_debug: "x",
      },
    ],
    ["fact", { turn_id: turnId, segment: 0, kind: "fact", sources: [{ ref: "T1", title: "Aviasales", domain: "aviasales.com", url: null, fetched_at: "2026-10-12T09:00:00Z" }] }],
    ["delta", { turn_id: turnId, segment: 0, text: "Прямой рейс TAS → AUH — $420 на человека.\nИтого $1 470." }],
    [
      "done",
      {
        turn_id: turnId,
        message_id: randomUUID(),
        status: "completed",
        applied_change: { tool: "set_direct_only", trip_params: { travellers: 2, direct_only: true }, note_key: "ai.chg.direct" },
        actions: [{ type: "watch_price", event_id: "0b7c3a52-1d2e-4f60-8a9b-000000000777" }],
        quota: { ...QUOTA, used: 2, remaining: 8 },
        model: "primary",
        quick_actions: [
          { id: "plus1", tool: "extend_trip_days", args: { extra_nights: 1 }, label_key: "ai.q.plus1", params: {} },
          { id: "dep_ALA", tool: "change_departure", args: { departure_iata: "ALA" }, label_key: "ai.q.dep", params: { iata: "ALA", city_name: "Алматы" } },
        ],
      },
    ],
  ];
}

export const frame = (turnId: string, seq: number, event: string, data: unknown) =>
  `id: ${turnId}:${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function defaultScript(turnId: string): Step[] {
  return [": ping\n\n", ...happyEvents(turnId).map(([e, d], i) => frame(turnId, i, e, d))];
}

/** Поток по сценарию: отмена вызывающего (signal) отмечается в state.aborted. */
function streamOf(steps: Step[], state: AiFakeState, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) {
        state.aborted = true;
        controller.error(new Error("aborted"));
        return;
      }
      if (i >= steps.length) {
        state.finished = true;
        controller.close();
        return;
      }
      const s = steps[i++]!;
      if (typeof s === "string") {
        controller.enqueue(enc.encode(s));
        return;
      }
      const wait = "wait" in s ? new Promise<void>((r) => setTimeout(r, s.wait)) : s.gate;
      await Promise.race([
        wait,
        new Promise<void>((r) => {
          if (signal?.aborted) r();
          signal?.addEventListener("abort", () => r());
        }),
      ]);
      if (signal?.aborted) {
        state.aborted = true;
        controller.error(new Error("aborted"));
      }
    },
    cancel() {
      state.aborted = true;
    },
  });
}

export function installAiFake(fake: FakeDomains): AiFakeState {
  const state: AiFakeState = {
    owners: new Map(),
    idem: new Map(),
    script: null,
    turnOverride: null,
    aborted: false,
    finished: false,
    conversationExtra: {},
    messages: [],
  };
  fake.aiHandler = (r: Req) => {
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    if (r.method === "GET" && r.path === "/internal/v1/quota") return json(200, { ...QUOTA, user_id: r.subject });
    if (r.method === "POST" && r.path === "/internal/v1/conversations") {
      const key = r.headers["idempotency-key"];
      if (!key) return domainError(400, "IDEMPOTENCY_KEY_REQUIRED");
      const prev = state.idem.get(`${r.subject}:${key}`);
      if (prev) return json(200, conversationFixture(prev, { ...state.conversationExtra, mode: r.body.mode, event_id: r.body.event_id ?? null }));
      const id = randomUUID();
      state.owners.set(id, r.subject);
      state.idem.set(`${r.subject}:${key}`, id);
      return json(201, conversationFixture(id, { ...state.conversationExtra, mode: r.body.mode, event_id: r.body.event_id ?? null }));
    }
    const m = /^\/internal\/v1\/conversations\/([^/]+)(\/turns)?$/.exec(r.path);
    if (!m) return json(404, { detail: "Not Found" });
    const id = m[1]!;
    if (state.owners.get(id) !== r.subject) return domainError(404, "AI_CONVERSATION_NOT_FOUND");
    if (!m[2] && r.method === "GET") return json(200, { ...conversationFixture(id, state.conversationExtra), messages: state.messages });
    if (!m[2] && r.method === "DELETE") {
      state.owners.delete(id);
      return new Response(null, { status: 204 });
    }
    if (m[2] && r.method === "POST") {
      const ov = state.turnOverride?.(r);
      if (ov) return ov;
      const turnId = randomUUID();
      if ((r.headers.accept ?? "").includes("application/json")) {
        const events = happyEvents(turnId).map(([event, data]) => ({ event, data }));
        return json(200, { turn_id: turnId, segments: [], tool_results: [], done: null, error: null, events });
      }
      const steps = (state.script ?? defaultScript)(turnId);
      return new Response(streamOf(steps, state, r.signal), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    return domainError(404, "NOT_FOUND");
  };
  return state;
}

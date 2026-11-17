/**
 * Sprint 7 — the bridge between the concierge chat and «Поездка» on the event detail (AGENT_BRIEF F).
 *
 * The trip block registers itself for its event: the chat reads the parameters the user sees (sent with every turn as
 * `trip_params`, the source of truth for the concierge) and hands back the parameters a tool priced
 * (`tool_result.trip_params` when ok + changed). The block applies them through its usual recalculation (the offers
 * window returns the same snapshots) and shows «AI изменил предложение: … · Отменить».
 */
import type { AiTripParams, OfferTier } from "@tilhero/contracts/bff";
import { clampNights, clampTravellers, DEFAULT_PARAMS, filtersOf, offersCall, TIERS, type TripParams } from "../trip/logic";

export interface TripNote {
  key: string;
  vars: Record<string, string | number>;
}

export interface TripHandle {
  /** the parameters on screen; null — the event has no trip package (nothing to send) */
  get(): AiTripParams | null;
  /** apply what a tool priced; `note` — the plaque «AI изменил предложение: …». Settles true once «Поездка» priced
   *  these parameters (or a newer change replaced them), false when that recalculation failed (the block rolled back). */
  apply(p: AiTripParams, note: TripNote): Promise<boolean>;
  /** 7.1: a condition the tool kept although nothing changed (no_change with trip_params): taken quietly — no plaque,
   *  no «Отменить»; the same trip in other words is not recalculated */
  sync(p: AiTripParams): void;
}

const handles = new Map<string, TripHandle>();

export const tripBridge = {
  register(eventId: string, h: TripHandle): () => void {
    handles.set(eventId, h);
    return () => {
      if (handles.get(eventId) === h) handles.delete(eventId);
    };
  },
  get(eventId: string | null | undefined): AiTripParams | null {
    if (!eventId) return null;
    try {
      return handles.get(eventId)?.get() ?? null;
    } catch {
      return null;
    }
  },
  sync(eventId: string | null | undefined, p: AiTripParams): boolean {
    const h = eventId ? handles.get(eventId) : undefined;
    if (!h) return false;
    h.sync(p);
    return true;
  },
  /** null — no «Поездка» on screen for this event (nothing applied) */
  apply(eventId: string | null | undefined, p: AiTripParams, note: TripNote): Promise<boolean> | null {
    const h = eventId ? handles.get(eventId) : undefined;
    return h ? h.apply(p, note) : null;
  },
};

/** The trip on screen as the concierge gets it: exactly the recalculate body + the open tier. */
export function toAiTripParams(p: TripParams, tier: OfferTier): AiTripParams {
  const c = offersCall(p, true);
  const body = c.method === "POST" ? c.body : { travellers: c.travellers };
  return { ...body, selected_tier: tier };
}

const IATA = /^[A-Z]{3}$/;
const HOTEL = /^[A-Za-z0-9_-]{1,64}$/;

/** The parameters a tool priced, as the block's state (unknown or broken fields → the defaults, never thrown). */
export function fromAiTripParams(a: AiTripParams): { params: TripParams; tier: OfferTier | null } {
  const keep = a.keep_hotels && typeof a.keep_hotels === "object" ? Object.fromEntries(Object.entries(a.keep_hotels).filter(([k, v]) => (TIERS as readonly string[]).includes(k) && typeof v === "string" && HOTEL.test(v))) : null;
  const params: TripParams = {
    ...DEFAULT_PARAMS,
    travellers: clampTravellers(Number(a.travellers)),
    departure_iata: typeof a.departure_iata === "string" && IATA.test(a.departure_iata) ? a.departure_iata : null,
    direct_only: a.direct_only === true,
    near_venue: a.near_venue === true,
    extra_nights: clampNights(Number(a.extra_nights ?? 0)),
    hotel_id: typeof a.hotel_id === "string" && HOTEL.test(a.hotel_id) ? a.hotel_id : null,
    keep_hotels: keep && Object.keys(keep).length ? keep : null,
    hotel_filters: filtersOf({ hotel_filters: a.hotel_filters ?? null }),
  };
  const tier = typeof a.selected_tier === "string" && (TIERS as readonly string[]).includes(a.selected_tier) ? a.selected_tier : null;
  return { params, tier };
}

/** One spelling of a trip for comparisons (what the server returned vs what the block sends): "" — no trip. */
export function tripKey(p: AiTripParams | null | undefined): string {
  if (!p) return "";
  const { params, tier } = fromAiTripParams(p);
  return JSON.stringify(toAiTripParams(params, tier ?? "comfort"));
}

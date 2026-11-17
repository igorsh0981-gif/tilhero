import type { BudgetPreset, Departure, GeoOption, Geography, Preferences, PreferencesPatch } from "@tilhero/contracts/bff";

/**
 * UI draft of the preference profile — shared by onboarding steps and profile editors
 * (TG-FR-018: the same controls everywhere). Converts to/from the BFF contract.
 */
export type FormatChoice = "offline" | "online" | "both";
export type BudgetChip = Exclude<BudgetPreset, "custom">;
export type Horizon = Preferences["search_horizon_months"];
export type RemindPoint = Preferences["notification_points_months"][number];

export interface PrefDraft {
  interests: string[];
  entities: string[];
  geo: string[];
  strong: boolean;
  format: FormatChoice;
  budget: Array<BudgetChip | "custom">;
  custom: string;
  horizon: Horizon;
  remind: RemindPoint[];
  deps: Departure[];
  direct: boolean;
  connecting: boolean;
  alt: boolean;
  /** fix 6.3: hotel settings; null — the default (rating from experience-config, 5 km, any stars) */
  hotelRating: number | null;
  hotelDistance: number | null;
  hotelStars: number | null;
}

export const BUDGET_CHIPS: readonly BudgetChip[] = ["under_500", "500_1000", "1000_2000", "2000_5000"];
export const BUDGET_RANGES: Record<BudgetChip, readonly [number, number]> = {
  under_500: [0, 500],
  "500_1000": [500, 1000],
  "1000_2000": [1000, 2000],
  "2000_5000": [2000, 5000],
};
export const HORIZONS: readonly Horizon[] = [3, 6, 12, 24];
export const REMIND_POINTS: readonly RemindPoint[] = [1, 3, 6, 12];
export const MAX_DEPARTURES = 10;
/* fix 6.3: hotel settings — the chips (the preferences domain accepts exactly these) */
export const HOTEL_RATINGS: readonly number[] = [0, 7, 7.5, 8, 8.5, 9];
export const HOTEL_DISTANCES_KM: readonly number[] = [1, 3, 5, 10, 15];
export const HOTEL_STARS: readonly number[] = [0, 3, 4, 5];
/** the hotel search radius without a setting (offers HOTEL_RADIUS_M) */
export const DEFAULT_HOTEL_DISTANCE_KM = 5;
export const MAX_ENTITIES = 20;
export const MAX_GEOGRAPHIES = 30;
/** «Свой» бюджет: the preferences domain accepts 50…100 000 USD (custom_amount). */
export const MIN_CUSTOM_BUDGET = 50;
export const MAX_CUSTOM_BUDGET = 100_000;

/* ---------- budget: «Свой» = fixed $ prefix + digits only (BR-TG-003, AT-22) ---------- */

/** Keeps digits only, drops leading zeros, max 6 digits. */
export function sanitizeAmountInput(raw: string): string {
  return raw.replace(/\D+/g, "").replace(/^0+/, "").slice(0, 6);
}

export type BudgetState = "ok" | "none" | "need" | "min" | "max";

export function budgetState(d: Pick<PrefDraft, "budget" | "custom">): BudgetState {
  if (!d.budget.length) return "none";
  if (!d.budget.includes("custom")) return "ok";
  if (!/^\d+$/.test(d.custom)) return "need";
  const n = Number(d.custom);
  if (!(n > 0)) return "need";
  if (n < MIN_CUSTOM_BUDGET) return "min";
  if (n > MAX_CUSTOM_BUDGET) return "max";
  return "ok";
}

export function toggleBudget(d: PrefDraft, chip: BudgetChip | "custom"): PrefDraft {
  if (chip === "custom") return { ...d, budget: d.budget.includes("custom") ? [] : ["custom"] };
  const ranges = d.budget.filter((x): x is BudgetChip => x !== "custom");
  const next = ranges.includes(chip) ? ranges.filter((x) => x !== chip) : [...ranges, chip];
  return { ...d, budget: BUDGET_CHIPS.filter((c) => next.includes(c)) };
}

/** Contract has one preset + min/max: several ranges become one span [min of lows, max of highs]. */
export function budgetToContract(d: Pick<PrefDraft, "budget" | "custom">): Preferences["budget"] {
  if (d.budget.includes("custom")) {
    const n = Number(d.custom);
    return { currency: "USD", preset: "custom", min: null, max: null, custom_amount: Number.isFinite(n) && n > 0 ? Math.floor(n) : null };
  }
  const chips = d.budget.filter((x): x is BudgetChip => x !== "custom");
  if (!chips.length) return { currency: "USD", preset: null, min: null, max: null, custom_amount: null };
  const min = Math.min(...chips.map((c) => BUDGET_RANGES[c][0]));
  const max = Math.max(...chips.map((c) => BUDGET_RANGES[c][1]));
  return { currency: "USD", preset: chips.length === 1 ? chips[0]! : null, min, max, custom_amount: null };
}

export function budgetFromContract(b: Preferences["budget"] | null | undefined): Pick<PrefDraft, "budget" | "custom"> {
  if (!b) return { budget: [], custom: "" };
  if (b.preset === "custom") return { budget: ["custom"], custom: b.custom_amount ? String(Math.floor(b.custom_amount)) : "" };
  if (b.preset) return { budget: [b.preset], custom: "" };
  if (b.min != null && b.max != null) {
    const chips = BUDGET_CHIPS.filter((c) => BUDGET_RANGES[c][0] >= b.min! && BUDGET_RANGES[c][1] <= b.max!);
    return { budget: chips, custom: "" };
  }
  return { budget: [], custom: "" };
}

/* ---------- geography ---------- */
export function geoKey(g: Pick<Geography, "level"> & { code?: string | null }): string {
  return g.level === "world" ? "world" : `${g.level}:${g.code ?? ""}`;
}
export function geoFromKey(key: string): Geography {
  if (key === "world") return { level: "world" };
  const i = key.indexOf(":");
  const level = key.slice(0, i) as Geography["level"];
  return { level, code: key.slice(i + 1) };
}
export function toggleGeo(d: PrefDraft, key: string): PrefDraft {
  if (d.geo.includes(key)) return { ...d, geo: d.geo.filter((x) => x !== key) };
  if (key === "world") return { ...d, geo: ["world"] };
  const rest = d.geo.filter((x) => x !== "world");
  return rest.length >= MAX_GEOGRAPHIES ? d : { ...d, geo: [...rest, key] };
}
export function geoOptionKey(o: GeoOption): string {
  return geoKey({ level: o.level, code: o.code });
}

/* ---------- horizon & reminders (TG-FR-015: horizon separate from notification points) ---------- */
export function setHorizon(d: PrefDraft, h: Horizon): PrefDraft {
  return { ...d, horizon: h, remind: d.remind.filter((n) => n <= h) };
}
export function toggleRemind(d: PrefDraft, n: RemindPoint): PrefDraft {
  if (n > d.horizon) return d;
  const next = d.remind.includes(n) ? d.remind.filter((x) => x !== n) : [...d.remind, n];
  return { ...d, remind: REMIND_POINTS.filter((x) => next.includes(x)) };
}

/* ---------- departures (BR-TG-004: never pre-filled) ---------- */
export function addDeparture(d: PrefDraft, dep: Departure): PrefDraft {
  if (d.deps.some((x) => x.airport_iata === dep.airport_iata) || d.deps.length >= MAX_DEPARTURES) return d;
  return { ...d, deps: [...d.deps, dep] };
}
export function removeDeparture(d: PrefDraft, iata: string): PrefDraft {
  return { ...d, deps: d.deps.filter((x) => x.airport_iata !== iata) };
}

/* ---------- entities ---------- */
export function addEntity(d: PrefDraft, raw: string): PrefDraft {
  const v = raw.replace(/\s+/g, " ").trim().slice(0, 40);
  if (!v || d.entities.some((e) => e.toLowerCase() === v.toLowerCase()) || d.entities.length >= MAX_ENTITIES) return d;
  return { ...d, entities: [...d.entities, v] };
}

/* ---------- conversions ---------- */
export function draftFromPreferences(p: Preferences | null | undefined): PrefDraft {
  const formats = p?.event_formats ?? ["offline"];
  const format: FormatChoice = formats.includes("offline") && formats.includes("online") ? "both" : formats.includes("online") ? "online" : "offline";
  return {
    interests: [...(p?.interests.categories ?? [])],
    entities: [...(p?.interests.entities ?? [])],
    geo: (p?.geographies ?? []).map(geoKey),
    strong: p?.strong_events_outside_geo ?? true,
    format,
    ...budgetFromContract(p?.budget),
    horizon: p?.search_horizon_months ?? 12,
    remind: [...(p?.notification_points_months ?? [3, 6])],
    deps: [...(p?.departures ?? [])],
    direct: p?.flight_prefs.direct ?? true,
    connecting: p?.flight_prefs.connecting ?? true,
    alt: p?.flight_prefs.alternative_departure ?? true,
    hotelRating: p?.hotel_prefs?.rating_min ?? null,
    hotelDistance: p?.hotel_prefs?.max_distance_km ?? null,
    hotelStars: p?.hotel_prefs?.min_stars || null,
  };
}

/* ---------- hotel settings (fix 6.3) ---------- */

/** A chip pick: the default value is stored as null (the profile then follows experience-config / offers). */
export function pickHotel(d: PrefDraft, field: "rating" | "distance" | "stars", v: number, defaultRating: number): PrefDraft {
  if (field === "rating") return { ...d, hotelRating: v === defaultRating ? null : v };
  if (field === "distance") return { ...d, hotelDistance: v === DEFAULT_HOTEL_DISTANCE_KM ? null : v };
  return { ...d, hotelStars: v || null };
}

export type PrefSection = "interests" | "geo" | "budget" | "horizon" | "flights" | "hotel";

/** PATCH body for the given sections (departures go through PUT /v1/profile/departures). */
export function preferencesPatch(d: PrefDraft, sections: readonly PrefSection[], version?: number): PreferencesPatch {
  const patch: PreferencesPatch = {};
  if (sections.includes("interests")) patch.interests = { categories: [...d.interests], entities: [...d.entities] };
  if (sections.includes("geo")) {
    patch.geographies = d.geo.map(geoFromKey);
    patch.strong_events_outside_geo = d.strong;
    patch.event_formats = d.format === "both" ? ["offline", "online"] : [d.format];
  }
  if (sections.includes("budget") && budgetState(d) === "ok") patch.budget = budgetToContract(d);
  if (sections.includes("horizon")) {
    patch.search_horizon_months = d.horizon;
    patch.notification_points_months = d.remind.filter((n) => n <= d.horizon);
  }
  if (sections.includes("flights")) patch.flight_prefs = { direct: d.direct, connecting: d.connecting, alternative_departure: d.alt };
  if (sections.includes("hotel")) patch.hotel_prefs = { rating_min: d.hotelRating, max_distance_km: d.hotelDistance, min_stars: d.hotelStars };
  if (version != null) patch.version = version;
  return patch;
}

/** Onboarding step validity (MainButton enabled state). */
export function stepValid(d: PrefDraft, step: number, consent?: { age: boolean; ok: boolean }): boolean {
  switch (step) {
    case 2:
      return d.interests.length > 0 || d.entities.length > 0;
    case 3:
      return d.geo.length > 0;
    case 4:
      return budgetState(d) === "ok";
    case 5:
      return d.deps.length > 0;
    case 6:
      return !!consent && consent.age && consent.ok;
    default:
      return true;
  }
}

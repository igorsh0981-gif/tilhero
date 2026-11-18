import type { ReviewCorrection } from "@tilhero/contracts/admin";
import { normalizePrice, priceCents } from "../../lib/money";
import { httpsUrl } from "../catalog/common";

/**
 * ReviewDetail.facts is the candidate's facts object from the catalogue (FactsIn of services/events): untrusted,
 * so every field is read defensively — a wrong type becomes null, never a crash or an injected node.
 */
export interface Facts {
  title: string;
  start: { local_date: string; local_time: string | null } | null;
  end: { local_date: string; local_time: string | null } | null;
  venue: { name: string; city: string; address: string | null; country_code: string | null } | null;
  online: boolean;
  price: { min: string; max: string; currency: string } | null;
  categories: string[];
  official_url: string | null;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
const when = (v: unknown): Facts["start"] => {
  const o = obj(v);
  const d = o && str(o.local_date, 10);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const tm = str(o.local_time, 8);
  return { local_date: d, local_time: tm && /^\d{2}:\d{2}/.test(tm) ? tm.slice(0, 5) : null };
};

export function readFacts(raw: Record<string, unknown> | null | undefined): Facts {
  const f = obj(raw) ?? {};
  const v = obj(f.venue);
  const p = obj(f.price_range);
  const min = p ? str(p.min, 20) : null;
  const max = p ? str(p.max, 20) : null;
  const cur = p ? str(p.currency, 3) : null;
  return {
    title: str(f.title, 300) ?? "",
    start: when(f.start),
    end: when(f.end),
    venue: v && (str(v.name) || str(v.city)) ? { name: str(v.name, 300) ?? "", city: str(v.city, 200) ?? "", address: str(v.address), country_code: str(v.country_code, 2) } : null,
    online: f.online === true,
    price: min && max && cur ? { min, max, currency: cur } : null,
    categories: Array.isArray(f.categories) ? f.categories.filter((c): c is string => typeof c === "string").slice(0, 10) : [],
    official_url: str(f.official_url, 2048),
  };
}

/** Editable form of «Correct» (strings as typed). */
export interface CorrectionForm {
  title: string;
  date: string;
  time: string;
  venue: string;
  city: string;
  address: string;
  noPrice: boolean;
  priceMin: string;
  priceMax: string;
  currency: string;
  online: boolean;
  basisUrl: string;
  note: string;
}

export const CURRENCIES = ["UZS", "KZT", "KGS", "AZN", "GEL", "AMD", "USD", "EUR", "RUB"] as const;

/** «Correct» starts from the candidate's facts; the basis URL is prefilled with the candidate page (https only). */
export function formFromFacts(f: Facts, basisUrl = ""): CorrectionForm {
  return {
    title: f.title,
    date: f.start?.local_date ?? "",
    time: f.start?.local_time ?? "",
    venue: f.venue?.name ?? "",
    city: f.venue?.city ?? "",
    address: f.venue?.address ?? "",
    noPrice: !f.price,
    priceMin: f.price?.min ?? "",
    priceMax: f.price?.max ?? "",
    currency: f.price?.currency ?? "UZS",
    online: f.online,
    basisUrl: httpsUrl(basisUrl) ? basisUrl : "",
    note: "",
  };
}

/** form fields that come from the candidate's facts (basis and note are the operator's own) */
export const FACT_KEYS = ["title", "date", "time", "venue", "city", "address", "noPrice", "priceMin", "priceMax", "currency", "online"] as const;
export type FactKey = (typeof FACT_KEYS)[number];

/**
 * Newer facts arrived while the operator was correcting (409 REVIEW_CHANGED): fields the operator edited keep the
 * edit, untouched ones take the new value — otherwise sending the form would silently revert the newer facts.
 */
export function rebaseForm(form: CorrectionForm, oldBase: CorrectionForm, newBase: CorrectionForm): CorrectionForm {
  const out = { ...form };
  for (const k of FACT_KEYS) if (form[k] === oldBase[k]) (out as Record<FactKey, unknown>)[k] = newBase[k];
  return out;
}

/** `REVIEW_CHANGES_INVALID {field}` of services/events (a key of ReviewCorrection) → the form field to highlight */
export function changeField(field: string | null): CorrectionField {
  switch (field) {
    case "title":
      return "title";
    case "start":
    case "end":
      return "date";
    case "venue":
    case "online":
      return "venue";
    case "price_range":
      return "price";
    default:
      return "changes";
  }
}

export type CorrectionField = "title" | "date" | "time" | "venue" | "city" | "price" | "basisUrl" | "note" | "changes";
/** error codes → dictionary keys rv.err.<code> */
export type CorrectionErrors = Partial<Record<CorrectionField, string>>;

/**
 * Validates the form and builds `changes` with ONLY the facts that differ from the candidate (admin.ts
 * ReviewCorrection). Errors are message codes (rv.err.*); `changes` is null while there are errors.
 */
export function buildCorrection(orig: Facts, form: CorrectionForm): { changes: ReviewCorrection | null; errors: CorrectionErrors } {
  const errors: CorrectionErrors = {};
  const changes: ReviewCorrection = {};
  const title = form.title.trim();
  if (!title) errors.title = "title";
  else if (title.length > 300) errors.title = "titleLong";
  else if (title !== orig.title) changes.title = title;

  const date = form.date.trim();
  const time = form.time.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) errors.date = "date";
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.time = "time";
  if (!errors.date && !errors.time && (date !== orig.start?.local_date || (time || null) !== (orig.start?.local_time ?? null))) {
    changes.start = { local_date: date, local_time: time || null };
  }

  const venue = form.venue.trim();
  const city = form.city.trim();
  const address = form.address.trim();
  const venueTouched = venue !== (orig.venue?.name ?? "") || city !== (orig.venue?.city ?? "") || address !== (orig.venue?.address ?? "");
  if (venueTouched) {
    if (!form.online || venue || city) {
      if (!venue) errors.venue = "venue";
      if (!city) errors.city = "city";
    }
    if (!errors.venue && !errors.city && venue && city) changes.venue = { name: venue.slice(0, 300), city: city.slice(0, 200), address: address ? address.slice(0, 500) : null };
  }

  if (form.noPrice) {
    if (orig.price) changes.price_range = null;
  } else {
    const min = normalizePrice(form.priceMin);
    const max = normalizePrice(form.priceMax || form.priceMin);
    if (!min || !max) errors.price = "price";
    else if (priceCents(min) > priceCents(max)) errors.price = "priceOrder";
    else if (!/^[A-Z]{3}$/.test(form.currency)) errors.price = "currency";
    else if (!orig.price || min !== normalizePrice(orig.price.min) || max !== normalizePrice(orig.price.max) || form.currency !== orig.price.currency) {
      changes.price_range = { min, max, currency: form.currency };
    }
  }

  if (form.online !== orig.online) changes.online = form.online;

  const basis = form.basisUrl.trim();
  if (!basis) errors.basisUrl = "basis";
  else if (!httpsUrl(basis)) errors.basisUrl = "basisHttps";

  const note = form.note.trim();
  if (note.length < 3) errors.note = "note";

  if (!Object.keys(changes).length && !errors.title && !errors.date && !errors.time && !errors.venue && !errors.city && !errors.price) errors.changes = "noChanges";
  return { changes: Object.keys(errors).length ? null : changes, errors };
}

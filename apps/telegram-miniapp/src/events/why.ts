/**
 * «Почему вам» (sprint 6, AT-25-TG): texts of recommendation reasons are built by the UI from the code and its
 * params (INTERNAL_API §1.1) — RU/EN, never the server's words. Unknown or incomplete params fall back to the
 * generic sentence of the code; unknown codes are dropped. Pure (tested in test/watch.test.tsx).
 */
import type { Recommendation, RecommendationReason } from "@tilhero/contracts/bff";
import type { Lang, MessageKey, Vars } from "../i18n";
import { usd } from "../watch/logic";

const CODES = new Set(["INTEREST_MATCH", "ENTITY_MATCH", "IN_GEOGRAPHY", "FITS_BUDGET", "OVER_BUDGET", "HIGH_SIGNIFICANCE", "SALES_OPEN", "NEW", "MORE_LIKE_THIS"]);
const KINDS = new Set(["fact", "estimate", "recommendation"]);

export interface ReasonDeps {
  t: (key: MessageKey, vars?: Vars) => string;
  lang: Lang;
  /** taxonomy code → localised label (directory), null when unknown */
  category: (code: string) => string | null;
  /** ISO-2 → localised country name */
  country: (code: string) => string;
}

const str = (p: Record<string, string | number>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80);
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
};
const money = (p: Record<string, string | number>, lang: Lang, ...keys: string[]): string => {
  const v = str(p, ...keys);
  return v ? usd(v, lang) : "";
};

/** Text of one reason, or null for an unknown code. */
export function reasonText(r: RecommendationReason, d: ReasonDeps): string | null {
  if (!r || !CODES.has(r.code)) return null;
  const p = r.params && typeof r.params === "object" ? r.params : {};
  const { t, lang } = d;
  switch (r.code) {
    case "INTEREST_MATCH": {
      const code = str(p, "category", "interest");
      const label = str(p, "label") || (code ? d.category(code) : null);
      return label ? t("why.r.INTEREST_MATCH", { x: label }) : t("why.r.INTEREST_MATCH.0");
    }
    case "ENTITY_MATCH": {
      const x = str(p, "entity", "name");
      return x ? t("why.r.ENTITY_MATCH", { x }) : t("why.r.ENTITY_MATCH.0");
    }
    case "IN_GEOGRAPHY": {
      // services/recommendations: {level: country|region|city, code} | {level: world, country_code} | {level: online}
      const level = str(p, "level");
      const cc = level === "country" ? str(p, "code") : str(p, "country", "country_code");
      const city = level === "city" ? str(p, "code") : "";
      const x = str(p, "label") || (/^[A-Za-z]{2}$/.test(cc) ? d.country(cc.toUpperCase()) : city);
      return x ? t("why.r.IN_GEOGRAPHY", { x }) : t("why.r.IN_GEOGRAPHY.0");
    }
    case "FITS_BUDGET":
    case "OVER_BUDGET": {
      // services/recommendations: {per_person, max, basis: trip|ticket, over_by?}. basis «ticket» — only the ticket
      // price was known (no trip yet): the text says «билет», never «поездка» (review: honesty of «Почему вам»)
      const ticket = str(p, "basis") === "ticket";
      const x = money(p, lang, "per_person", "trip_per_person");
      const y = money(p, lang, "max", "budget_max");
      if (!x || !y) return t(`why.r.${r.code}.0`);
      return t(ticket ? `why.r.${r.code}.ticket` : `why.r.${r.code}`, { x, y });
    }
    case "HIGH_SIGNIFICANCE": {
      const q = Number(p.quality_score);
      return Number.isFinite(q) && q >= 0 && q <= 100 ? t("why.r.HIGH_SIGNIFICANCE", { n: Math.round(q) }) : t("why.r.HIGH_SIGNIFICANCE.0");
    }
    case "SALES_OPEN": {
      const st = str(p, "status");
      return t(st === "LOW_INVENTORY" ? "why.r.SALES_OPEN.low" : st === "RESALE" ? "why.r.SALES_OPEN.resale" : "why.r.SALES_OPEN");
    }
    case "NEW": {
      const at = Date.parse(str(p, "first_seen_at"));
      if (!Number.isFinite(at)) return t("why.r.NEW");
      const d = new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "long" }).format(new Date(at));
      return t("why.r.NEW.at", { d });
    }
    case "MORE_LIKE_THIS": {
      if (str(p, "scope") === "event") return t("why.r.MORE_LIKE_THIS.event");
      const code = str(p, "category");
      const label = code ? d.category(code) : null;
      return label ? t("why.r.MORE_LIKE_THIS.cat", { x: label }) : t("why.r.MORE_LIKE_THIS");
    }
    default:
      return null;
  }
}

/** 2–3 displayable reasons with their kind (fact / estimate / recommendation). */
export function displayReasons(rec: Recommendation | null | undefined, d: ReasonDeps): Array<{ code: string; kind: RecommendationReason["kind"]; text: string }> {
  const out: Array<{ code: string; kind: RecommendationReason["kind"]; text: string }> = [];
  for (const r of rec?.reasons ?? []) {
    const text = reasonText(r, d);
    if (!text) continue;
    out.push({ code: r.code, kind: KINDS.has(r.kind) ? r.kind : "recommendation", text });
    if (out.length === 3) break;
  }
  return out;
}

/** Score as an integer 0..100 (null — not shown). */
export function clampScore(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
}

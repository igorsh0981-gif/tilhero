/**
 * Sprint 7 — texts the server names by key (note_key, label_key, greeting key): shown only when the dictionary has the
 * key (an unknown key from a newer server never reaches the screen as «ai.something»).
 */
import type { AiGreeting, AiQuickAction } from "@tilhero/contracts/bff";
import { DICTS, type MessageKey, type Vars } from "../i18n";
import type { TripNote } from "./tripBridge";

export const hasKey = (key: string): key is MessageKey => key in DICTS.ru;

type T = (key: MessageKey, vars?: Vars) => string;

/** A tier code as its name («Economy»); anything else as is. */
export function tierName(t: T, v: unknown): string {
  const k = `tr.tier.${String(v)}`;
  return typeof v === "string" && hasKey(k) ? t(k) : "";
}

/** «только прямые рейсы», «тариф Economy», «вылет из TAS» — the trip change the AI made. */
export function noteText(t: T, n: TripNote): string {
  const key = hasKey(n.key) ? n.key : "ai.note.cheaper";
  return t(key, { ...n.vars, t: tierName(t, n.vars.t) || String(n.vars.t ?? "") });
}

/** A quick action's label: `ai.q.dep` names the city in the conversation's language (`params.city_name` from the server),
 *  otherwise the airport code; `ai.q.plus1` — «Продлить на день»; an unknown key — the tool's generic label. */
export function quickActionLabel(t: T, q: AiQuickAction): string {
  const city = q.params?.city_name;
  const vars: Vars = { c: typeof city === "string" && city ? city : String(q.args.departure_iata ?? ""), km: Number(q.args.max_distance_km) || 1 };
  return hasKey(q.label_key) ? t(q.label_key, vars) : t(`ai.q.tool.${q.tool}` as MessageKey);
}

/** The greeting by its key with scalar params only (INTERNAL_API §1.2): ai.hello {tier}; ai.hello.online
 *  {price_amount: Decimal string | null, price_currency | null}; ai.hello.cat {query}; ai.hello.post / ai.hello.home.
 *  `money` formats a confirmed amount; no amount — the greeting without a price (never a guessed one). */
export function greetingText(t: T, g: AiGreeting | undefined, money: (amount: string, currency: string) => string): string {
  if (!g) return t("ai.hello.home");
  const p = g.params as Record<string, unknown>;
  if (g.key === "ai.hello") return tierName(t, p.tier) ? t("ai.hello", { tier: tierName(t, p.tier) }) : t("ai.hello.notier");
  if (g.key === "ai.hello.online") {
    // the contract: scalars price_amount / price_currency; an object `price` — the fallback for early servers
    const pr = (typeof p.price_amount === "string" ? { amount: p.price_amount, currency: p.price_currency } : p.price) as { amount?: unknown; currency?: unknown } | null | undefined;
    const sum = pr && typeof pr.amount === "string" && /^\d+(\.\d+)?$/.test(pr.amount) && typeof pr.currency === "string" && /^[A-Z]{3}$/.test(pr.currency) ? money(pr.amount, pr.currency) : "";
    return sum ? t("ai.hello.online", { price: sum }) : t("ai.hello.online0");
  }
  if (g.key === "ai.hello.cat") return typeof p.query === "string" && p.query ? t("ai.hello.cat", { query: p.query.slice(0, 120) }) : t("ai.hello.home");
  return hasKey(g.key) ? t(g.key) : t("ai.hello.home");
}

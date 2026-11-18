/**
 * Имена сотрудников в ответах спринта 4 (как assignee_name / author_name у тикетов поддержки): admin-bff дополняет
 * идентификаторы именами через admin-identity `GET /admin/v1/staff/lookup` (StaffNames, кэш 60 с). Сбой lookup не
 * ломает экран — имя остаётся null, admin-web показывает короткий идентификатор.
 */
import type { AiBudget, ReviewDetail, Source, SourceDetail } from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import type { StaffAuth } from "../http.js";

type Names = Map<string, string>;
const nameOf = (names: Names, id: string | null | undefined): string | null => (id ? (names.get(id) ?? null) : null);

const source = <T extends Source>(s: T, names: Names): T => ({ ...s, updated_by_name: nameOf(names, s.updated_by) });

export async function namedSources<T extends Source>(ctx: BffContext, auth: StaffAuth, items: T[]): Promise<T[]> {
  const names = await ctx.names.resolve(items.map((s) => s.updated_by), auth);
  return items.map((s) => source(s, names));
}

export async function namedSourceDetail(ctx: BffContext, auth: StaffAuth, d: SourceDetail): Promise<SourceDetail> {
  const changes = d.changes ?? [];
  const names = await ctx.names.resolve([d.updated_by, ...changes.map((c) => c.actor_id)], auth);
  return { ...source(d, names), changes: changes.map((c) => ({ ...c, actor_name: nameOf(names, c.actor_id) })) };
}

const USD_RE = /^\d{1,10}\.\d{1,6}$/;
/** Спринт 6: бюджет AI новостей provider-gateway {spent_usd, budget_usd} — только десятичные строки; иначе null.
 *  Нет поля (gateway до спринта 6) — поля нет и в ответе. */
export function budgetNews(v: unknown): AiBudget["news"] {
  if (!v || typeof v !== "object") return null;
  const { spent_usd, budget_usd } = v as Record<string, unknown>;
  return typeof spent_usd === "string" && USD_RE.test(spent_usd) && typeof budget_usd === "string" && USD_RE.test(budget_usd) ? { spent_usd, budget_usd } : null;
}

export async function namedBudget(ctx: BffContext, auth: StaffAuth, raw: AiBudget): Promise<AiBudget> {
  const b: AiBudget = "news" in raw ? { ...raw, news: budgetNews(raw.news) } : raw;
  if (!b.paused) return b;
  const names = await ctx.names.resolve([b.paused.by], auth);
  return { ...b, paused: { ...b.paused, by_name: nameOf(names, b.paused.by) } };
}

const STAFF_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function namedReview(ctx: BffContext, auth: StaffAuth, r: ReviewDetail): Promise<ReviewDetail> {
  // "system" (авто-снятие EXPIRED, исправление 5.1) и прочие не-UUID в lookup не отправляются
  if (!r.decided_by || !STAFF_ID_RE.test(r.decided_by)) return { ...r, decided_by_name: null };
  const names = await ctx.names.resolve([r.decided_by], auth);
  return { ...r, decided_by_name: nameOf(names, r.decided_by) };
}

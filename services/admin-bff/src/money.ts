/**
 * Целочисленные деньги финансового обзора (ADR-0001, admin.ts «Деньги»): суммы — тийины (1 сум = 100 тийинов), Stars —
 * целые звёзды, затраты ИИ — микродоллары (1 USD = 1 000 000). Пересчёт — только BigInt, деление — с округлением
 * half-up (половина — от нуля); float и Decimal для денег не используются.
 *
 * Единственная граница с дробными числами — ответы ai-gateway (AiUsageSummary в USD числом, AiUnitCosts строками с 6
 * знаками): число переводится в микродоллары через десятичную запись с 6 знаками, строка — разбором цифр.
 */

export const MICRO = 1_000_000n;

/** a / b с округлением half-up (от нуля); b > 0. */
export function divHalfUp(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError("divHalfUp: делитель должен быть > 0");
  const neg = a < 0n;
  const x = neg ? -a : a;
  const q = (x * 2n + b) / (2n * b);
  return neg ? -q : q;
}

/** USD числом (ai-gateway) → микродоллары: 6 знаков после точки (toFixed округляет half-up по десятичной записи). */
export function usdToMicro(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0 || usd >= 1e12) throw new RangeError("usdToMicro: вне диапазона");
  const [int, frac = ""] = usd.toFixed(6).split(".");
  return BigInt(int!) * MICRO + BigInt(frac.padEnd(6, "0"));
}

const USD6_RE = /^(\d{1,12})(?:\.(\d{1,6}))?$/;
/** USD строкой ("0.012345", ai.ts AiUnitCostsKind) → микродоллары точно. */
export function usd6ToMicro(usd: string): bigint {
  const m = USD6_RE.exec(usd);
  if (!m) throw new RangeError("usd6ToMicro: формат");
  return BigInt(m[1]!) * MICRO + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** Микродоллары → тийины по курсу «тийинов за 1 USD», half-up. */
export function microToTiyin(micro: bigint, usdInTiyin: number): bigint {
  return divHalfUp(micro * BigInt(usdInTiyin), MICRO);
}

/** Stars → тийины по оценке «тийинов за 1 Star» (точно: целое × целое). */
export function starsToTiyin(stars: number, starInTiyin: number): bigint {
  return BigInt(stars) * BigInt(starInTiyin);
}

/** BigInt → число JSON; за пределами безопасных целых — ошибка (значение не показывается, блок недоступен). */
export function toSafe(b: bigint): number {
  if (b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError("toSafe: вне безопасных целых");
  return Number(b);
}

const TASHKENT_OFFSET_MS = 5 * 3_600_000; // UTC+5, без перехода на летнее время

/**
 * Границы периода отчёта billing по Asia/Tashkent — запасной расчёт, когда billing недоступен (тогда from/to обзора
 * берутся отсюда): day — сегодня, week — с понедельника, month — с 1-го числа; to — начало следующего периода.
 */
export function tashkentRange(period: "day" | "week" | "month", now: number): { from: string; to: string } {
  // как billing reports.bounds: день, неделя с понедельника, месяц — по Ташкенту, [from, to) — to это начало следующего
  const local = new Date(now + TASHKENT_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const monday = d - ((local.getUTCDay() + 6) % 7);
  const [start, end] =
    period === "month" ? [Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1)] : period === "week" ? [Date.UTC(y, m, monday), Date.UTC(y, m, monday + 7)] : [Date.UTC(y, m, d), Date.UTC(y, m, d + 1)];
  return { from: new Date(start - TASHKENT_OFFSET_MS).toISOString(), to: new Date(end - TASHKENT_OFFSET_MS).toISOString() };
}

/** Начало и конец месяца UTC (потолок ИИ — месяц UTC, INTERNAL_API §1.15). */
export function utcMonth(now: number): { start: number; end: number } {
  const d = new Date(now);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

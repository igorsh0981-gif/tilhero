/**
 * Money as decimal strings (admin.ts: AI cost "0.4213" — 4 digits, budget "1.00" — 2 digits). Never parsed into a
 * float for display: the string is rounded half-up on its digits, so "$0.4213" stays exactly what the server counted.
 */
const DEC = /^(-?)(\d+)(?:\.(\d+))?$/;

/** "0.42135" → "0.4214" (digits=4), "1" → "1.00" (digits=2); invalid input → null. */
export function roundDecimal(value: string | number | null | undefined, digits: number): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  const m = DEC.exec(s);
  if (!m) return null;
  const neg = m[1] === "-";
  const int = m[2]!;
  const frac = m[3] ?? "";
  const scaled = BigInt(int + frac.padEnd(digits, "0").slice(0, digits));
  const roundUp = frac.length > digits && Number(frac[digits]) >= 5;
  const v = scaled + (roundUp ? 1n : 0n);
  const str = v.toString().padStart(digits + 1, "0");
  const out = digits ? `${str.slice(0, -digits)}.${str.slice(-digits)}` : str;
  return neg && v !== 0n ? `-${out}` : out;
}

/** "$0.4213" (AI cost, digits 4), "$1.00" (budget, digits 2) or "$0.002625" (cost breakdown by the price catalog,
 *  digits 6); "—" for missing/invalid values. */
export function fmtUsd(value: string | number | null | undefined, digits: 2 | 4 | 6): string {
  const r = roundDecimal(value, digits);
  if (r == null) return "—";
  return r.startsWith("-") ? `−$${r.slice(1)}` : `$${r}`;
}

/** share a/b in 0..1 for meters (display only); 0 when b is not positive */
export function ratio(a: string | number | null | undefined, b: string | number | null | undefined): number {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) return 0;
  return Math.max(0, Math.min(1, x / y));
}

/**
 * Price typed by an operator → the catalogue money format `^\d{1,10}\.\d{2}$`: "150 000" → "150000.00",
 * "99,5" → "99.50". More than 2 fraction digits, letters or a negative number → null.
 */
export function normalizePrice(input: string): string | null {
  const s = input.replace(/[\s  ]/g, "").replace(",", ".");
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return `${m[1]!.replace(/^0+(?=\d)/, "")}.${(m[2] ?? "").padEnd(2, "0")}`;
}

/** compare two normalized prices ("10.00" ≤ "9.50"?) without floats */
export function priceCents(p: string): bigint {
  const [i, f = "00"] = p.split(".");
  return BigInt(i!) * 100n + BigInt(f.padEnd(2, "0").slice(0, 2));
}

/**
 * Catalogue money string → digits grouped by the locale, without floats: "150000.00" → "150 000" (ru) / "150,000"
 * (en); kopecks are kept only when non-zero ("99.50" → "99,50" / "99.50"). Invalid input is returned as is.
 */
export function fmtAmount(value: string, lang: "ru" | "en"): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return value;
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const int = new Intl.NumberFormat(locale, { useGrouping: true }).format(BigInt(m[1]!));
  const frac = (m[2] ?? "").replace(/0+$/, "");
  return frac ? `${int}${lang === "ru" ? "," : "."}${frac.padEnd(2, "0")}` : int;
}

/** price range of a candidate: "150 000 – 450 000 UZS"; one value when min = max */
export function fmtPriceRange(p: { min: string; max: string; currency: string }, lang: "ru" | "en"): string {
  const min = fmtAmount(p.min, lang);
  const max = fmtAmount(p.max, lang);
  return `${min === max ? min : `${min} – ${max}`} ${p.currency}`;
}

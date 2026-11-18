/** RFC 4122 v4 UUID for Idempotency-Key headers (crypto.randomUUID where available). */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function shortId(s: string, a = 4, b = 3): string {
  return s.length <= a + b + 1 ? s : `${s.slice(0, a)}…${s.slice(-b)}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  // first letter or digit of each word: "Сергей (подрядчик)" → "СП", not "С("
  return (parts.map((p) => p.match(/[\p{L}\p{N}]/u)?.[0] ?? "").join("").slice(0, 2) || "?").toUpperCase();
}

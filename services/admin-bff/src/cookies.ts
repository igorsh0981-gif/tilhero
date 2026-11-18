/**
 * Cookie сессии `__Host-tilhero_admin`: Secure, HttpOnly, SameSite=Strict, Path=/, без Domain (требование
 * префикса __Host-). Разбор — свой (без @fastify/cookie): нужна одна cookie.
 */
export const SESSION_COOKIE = "__Host-tilhero_admin";

export function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(id: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; Secure; HttpOnly; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

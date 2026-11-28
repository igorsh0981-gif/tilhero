/**
 * Клиент API сайта: только относительный /api/* (Caddy → telegram-bff /web/v1/*), cookie сессии — same-origin
 * (HttpOnly, сайт её не видит). Изменяющие запросы несут X-CSRF-Token (из GET /me) — Origin браузер ставит сам;
 * создание заказа — с Idempotency-Key. Типы — только packages/contracts/src/web.ts.
 */
import type { ErrorBody, Page, WebCatalog, WebMe, WebOrder, WebOrderRequest, WebSubscriptionView } from "@tilhero/contracts/web";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;
let onSessionExpired: (() => void) | null = null;

export function setCsrf(token: string | null): void {
  csrfToken = token;
}

/** Обработчик 401 SESSION_EXPIRED (приложение показывает вход). */
export function setSessionExpiredHandler(fn: (() => void) | null): void {
  onSessionExpired = fn;
}

async function call<T>(method: "GET" | "POST", path: string, o: { body?: unknown; idempotencyKey?: string } = {}): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (method === "POST" && csrfToken) headers["x-csrf-token"] = csrfToken;
  if (o.idempotencyKey) headers["idempotency-key"] = o.idempotencyKey;
  let resp: Response;
  try {
    resp = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
  } catch {
    throw new ApiError(0, "NETWORK");
  }
  if (resp.status === 204) return { status: 204, data: undefined as T };
  let data: unknown = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  if (!resp.ok) {
    const err = (data ?? {}) as Partial<ErrorBody>;
    const code = typeof err.code === "string" ? err.code : resp.status >= 500 ? "BILLING_UNAVAILABLE" : "UNKNOWN";
    if (resp.status === 401) onSessionExpired?.();
    throw new ApiError(resp.status, code, err.details && typeof err.details === "object" ? err.details : {});
  }
  return { status: resp.status, data: data as T };
}

export const api = {
  me: async () => (await call<WebMe>("GET", "/me")).data,
  catalog: async () => (await call<WebCatalog>("GET", "/catalog")).data,
  subscription: async () => (await call<WebSubscriptionView>("GET", "/subscription")).data,
  orders: async (cursor?: string | null) =>
    (await call<Page<WebOrder>>("GET", `/orders${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)).data,
  order: async (orderNo: number) => (await call<WebOrder>("GET", `/orders/${orderNo}`)).data,
  createOrder: async (body: WebOrderRequest, idempotencyKey: string) =>
    (await call<WebOrder>("POST", "/orders", { body, idempotencyKey })).data,
  cancelOrder: async (orderNo: number) => (await call<WebOrder>("POST", `/orders/${orderNo}/cancel`)).data,
  logout: async () => {
    await call<void>("POST", "/auth/logout");
  },
};

/** Вход: навигация страницы на /api/auth/start (302 на oauth.telegram.org) — без всплывающих окон и SDK. */
export function startLogin(): void {
  window.location.assign("/api/auth/start");
}

/** Переход на страницу оплаты провайдера — только https (адрес строит billing; проверка — вторая линия). */
export function goToCheckout(url: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    window.location.assign(u.toString());
    return true;
  } catch {
    return false;
  }
}

/** https-ссылка (оферта, чек) или null — в href не попадают javascript:/http-адреса. */
export function safeHttps(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

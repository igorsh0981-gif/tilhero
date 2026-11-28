/**
 * Маршруты сайта (history API, без зависимостей): / — тарифы; /buy/{код товара}; /orders; /orders/{номер заказа} —
 * возврат покупателя с провайдера. В адресе — только код товара и номер заказа (без ПДн); любые параметры query
 * (login_error после входа, параметры провайдера после оплаты) сайт читает один раз и убирает из адреса.
 */
import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "buy"; code: string }
  | { name: "orders" }
  | { name: "order"; orderNo: number }
  | { name: "not_found" };

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { name: "home" };
  const buy = /^\/buy\/([a-z0-9_]{2,40})\/?$/.exec(pathname);
  if (buy) return { name: "buy", code: buy[1]! };
  if (/^\/orders\/?$/.test(pathname)) return { name: "orders" };
  const order = /^\/orders\/([1-9][0-9]{0,11})\/?$/.exec(pathname);
  if (order) return { name: "order", orderNo: Number(order[1]) };
  return { name: "not_found" };
}

const listeners = new Set<() => void>();

export function navigate(path: string): void {
  if (path !== window.location.pathname) window.history.pushState(null, "", path);
  window.scrollTo(0, 0);
  listeners.forEach((l) => l());
}

/** Убирает query и hash из адреса (без новой записи истории). */
export function cleanAddress(): void {
  if (window.location.search || window.location.hash) window.history.replaceState(null, "", window.location.pathname);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.pathname));
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return route;
}

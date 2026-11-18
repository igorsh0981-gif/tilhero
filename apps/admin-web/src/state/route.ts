import { useCallback, useEffect, useState } from "react";

export interface Route {
  page: string;
  id: string | null;
}

/** #/support/TCK-3081 → {page: "support", id: "TCK-3081"}. Hash routing keeps deep links without server routes. */
export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const page = (parts[0] ?? "").replace(/[^a-z]/g, "");
  const raw = parts.slice(1).join("/");
  let id: string | null = null;
  if (raw) {
    try {
      id = decodeURIComponent(raw).slice(0, 128);
    } catch {
      id = null;
    }
  }
  return { page, id };
}

/** each segment of the id is encoded on its own: «providers/aviasales» stays readable (#/monitoring/providers/aviasales) */
export function routeHash(page: string, id?: string | null): string {
  return `#/${page}${id ? `/${id.split("/").map(encodeURIComponent).join("/")}` : ""}`;
}

export function useHashRoute(): [Route, (page: string, id?: string | null, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((page: string, id?: string | null, replace?: boolean) => {
    const h = routeHash(page, id);
    if (window.location.hash === h) return;
    if (replace) window.history.replaceState(null, "", h);
    else window.history.pushState(null, "", h);
    setRoute(parseHash(h));
  }, []);
  return [route, go];
}

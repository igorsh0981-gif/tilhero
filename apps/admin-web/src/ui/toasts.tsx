import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export type ToastKind = "ok" | "err" | "info";
type ToastFn = (msg: string, kind?: ToastKind, meta?: string) => void;
interface Item {
  id: number;
  msg: string;
  kind: ToastKind;
  meta?: string;
}

const Ctx = createContext<ToastFn>(() => undefined);

/** Toasts (role=status, aria-live polite). With a drawer open they move to the free left side / the top. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const [pos, setPos] = useState("");
  const seq = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const place = useCallback(() => {
    const dr = document.querySelector<HTMLElement>(".drawer");
    const dw = dr ? dr.offsetWidth : 0;
    setPos(!dw ? "" : window.innerWidth - dw >= 420 ? "at-left" : "at-top");
  }, []);
  // a drawer opened (or closed) while toasts are visible: move them off its footer buttons (review 7)
  const shown = items.length > 0;
  useEffect(() => {
    if (!shown || typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(place);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", place);
    return () => {
      mo.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [shown, place]);
  const toast = useCallback<ToastFn>((msg, kind = "ok", meta) => {
    const id = ++seq.current;
    place();
    setItems((xs) => [...xs.slice(-3), { id, msg, kind, meta }]);
    const tm = setTimeout(() => {
      timers.current.delete(tm);
      setItems((xs) => xs.filter((x) => x.id !== id));
    }, kind === "err" ? 6000 : 4200);
    timers.current.add(tm);
  }, [place]);
  // review 8: visible toasts reserve room under the page (--toasts-h) — the last rows / columns can be scrolled
  // above them instead of staying covered
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    const el = box.current;
    if (!el || !shown || pos || typeof ResizeObserver === "undefined") {
      root.style.removeProperty("--toasts-h");
      return;
    }
    const ro = new ResizeObserver(() => root.style.setProperty("--toasts-h", `${Math.ceil(el.offsetHeight) + 16}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--toasts-h");
    };
  }, [shown, pos]);
  return (
    <Ctx.Provider value={toast}>
      {children}
      <div ref={box} className={`toasts ${pos}`} role="status" aria-live="polite" data-testid="toasts">
        {items.map((x) => (
          <div key={x.id} className="toast" data-kind={x.kind}>
            <Icon name={x.kind === "err" ? "alertCircle" : x.kind === "info" ? "info" : "checkCircle"} className={`t-${x.kind}`} />
            <div className="grow">
              {x.msg}
              {x.meta && <div className="tm">{x.meta}</div>}
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);

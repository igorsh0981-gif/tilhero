import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { popupStore, useBackButton, useStoreTop } from "../tg";
import { Icon, type IconName } from "./Icon";

export const LAYERS_ID = "aie-layers";

function layersEl(): HTMLElement {
  return document.getElementById(LAYERS_ID) ?? document.body;
}

/* ---------- focus trap ---------- */
function trap(e: KeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== "Tab" || !root) return;
  const f = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(
    (x) => x.offsetParent !== null,
  );
  if (!f.length) return;
  const first = f[0]!;
  const last = f[f.length - 1]!;
  if (!root.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/* ---------- on-screen keyboard ---------- */
/**
 * The part of the sheet layer covered by the on-screen keyboard (visualViewport): iOS WebViews (Telegram included)
 * do not resize the page for the keyboard, they shrink the visual viewport. The layer is lifted by that much
 * (padding-bottom), so a sheet keeps its search field, list and footer above the keyboard; `.kb` lets a sheet
 * compact its header part. Android resizes the WebView itself (viewportChanged) — the overlap is 0 there.
 */
export function keyboardOverlap(layerBottom: number, vv: { height: number; offsetTop: number } | null | undefined): number {
  if (!vv || !Number.isFinite(vv.height) || vv.height <= 0) return 0;
  const o = Math.round(layerBottom - (vv.offsetTop + vv.height));
  return o > 0 ? o : 0;
}

function useKeyboardInset(sheet: { current: HTMLElement | null }): void {
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const layer = sheet.current?.parentElement;
    if (!vv || !layer) return;
    const sync = () => {
      // the layer's border box does not move with its padding: its bottom is the bottom of the app area
      const kb = keyboardOverlap(layer.getBoundingClientRect().bottom, vv);
      layer.style.paddingBottom = kb ? `${kb}px` : "";
      layer.classList.toggle("kb", kb > 80);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, [sheet]);
}

/* ---------- bottom sheet ---------- */
export function Sheet(props: { title: string; sub?: string; onClose: () => void; children: ReactNode; foot?: ReactNode; full?: boolean; className?: string; lead?: ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const opener = useRef<Element | null>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useBackButton(() => onClose.current());
  useKeyboardInset(ref);

  useEffect(() => {
    opener.current = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !popupStore.top()) {
        e.stopPropagation();
        onClose.current();
      } else trap(e, ref.current);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const o = opener.current as HTMLElement | null;
      if (o && document.body.contains(o)) o.focus({ preventScroll: true });
    };
  }, []);

  // swipe down on the grab handle / header closes the sheet, like a native sheet
  const drag = useRef<{ y0: number; dy: number } | null>(null);
  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".sheet-x")) return;
    drag.current = { y0: e.clientY, dy: 0 };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const move = (e: React.PointerEvent) => {
    if (!drag.current || !ref.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y0);
    ref.current.style.transform = drag.current.dy ? `translateY(${drag.current.dy}px)` : "";
  };
  const up = () => {
    if (!drag.current || !ref.current) return;
    const { dy } = drag.current;
    drag.current = null;
    if (dy > 90) onClose.current();
    else ref.current.style.transform = "";
  };

  return createPortal(
    <div className="layer">
      <div className="scrim" onClick={() => onClose.current()} />
      <div
        ref={ref}
        className={["sheet", props.full ? "full" : "", props.className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="sheet-grab" aria-hidden="true" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        <div className="sheet-h" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          {props.lead}
          <h2 id={titleId}>
            {props.title}
            {props.sub && <small>{props.sub}</small>}
          </h2>
          <button className="sheet-x" type="button" onClick={() => onClose.current()} aria-label={t("a11y.close")}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="sheet-b">{props.children}</div>
        {props.foot && <div className="sheet-f">{props.foot}</div>}
      </div>
    </div>,
    layersEl(),
  );
}

/* ---------- in-app popup (Telegram showPopup twin) ---------- */
export function PopupHost() {
  const p = useStoreTop(popupStore);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!p) return;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        p.resolve(null);
      } else trap(e, ref.current);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [p]);
  if (!p) return null;
  const row = p.buttons.length === 2;
  return (
    <div className="pop-layer">
      <div className="scrim" onClick={() => p.resolve(null)} />
      <div ref={ref} className="pop" role="alertdialog" aria-modal="true" aria-labelledby="popT" aria-describedby="popM" tabIndex={-1}>
        <div className="pop-b">
          <h3 id="popT">{p.title}</h3>
          <p id="popM">{p.message}</p>
        </div>
        <div className={row ? "pop-a row" : "pop-a"}>
          {p.buttons.map((b) => (
            <button
              key={b.id}
              type="button"
              className={[b.type === "destructive" ? "destr" : "", b.primary ? "def" : ""].filter(Boolean).join(" ") || undefined}
              onClick={() => p.resolve(b.id)}
            >
              {b.text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- toast ---------- */
interface ToastMsg {
  id: number;
  text: string;
  icon: IconName;
}
let toastCurrent: ToastMsg | null = null;
let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const toastListeners = new Set<() => void>();
const toastEmit = () => {
  for (const l of toastListeners) l();
};
const toastSubscribe = (fn: () => void) => {
  toastListeners.add(fn);
  return () => {
    toastListeners.delete(fn);
  };
};

export function showToast(text: string, icon: IconName = "check"): void {
  toastCurrent = { id: ++toastSeq, text, icon };
  toastEmit();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastCurrent = null;
    toastEmit();
  }, 2800);
}

export function ToastHost() {
  const m = useSyncExternalStore(toastSubscribe, () => toastCurrent, () => null);
  return (
    <div role="status" aria-live="polite">
      {m && (
        <div className="toast" key={m.id}>
          <Icon name={m.icon} size={18} />
          <span>{m.text}</span>
        </div>
      )}
    </div>
  );
}

/* ---------- live seconds countdown ---------- */
export function useCountdown(untilMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!untilMs || untilMs <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [untilMs]);
  return untilMs ? Math.max(0, Math.ceil((untilMs - now) / 1000)) : 0;
}

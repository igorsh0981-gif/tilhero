import { Children, useCallback, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

/**
 * Horizontal rail (AT-24): CSS scroll-snap, the next card peeks (large 86% / compact 72% — ui-tokens --rail-w),
 * dots, and ‹ › buttons on devices with a fine pointer (CSS shows .rail-nav only for hover:hover).
 */
export function Rail(props: { id: string; label: string; compact?: boolean; children: ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);
  const n = Children.count(props.children);

  const step = useCallback(() => {
    const el = ref.current;
    const first = el?.firstElementChild as HTMLElement | null;
    if (!el || !first) return 0;
    const gap = parseFloat(getComputedStyle(el).columnGap || "12") || 12;
    return first.getBoundingClientRect().width + gap;
  }, []);

  const onScroll = () => {
    const el = ref.current;
    const w = step();
    if (!el || !w) return;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    setIdx(atEnd ? n - 1 : Math.max(0, Math.min(n - 1, Math.round(el.scrollLeft / w))));
  };
  const by = (dir: -1 | 1) => ref.current?.scrollBy({ left: dir * step(), behavior: "smooth" });

  return (
    <>
      <div
        ref={ref}
        className={props.compact ? "rail compact" : "rail"}
        role="region"
        aria-roledescription="carousel"
        aria-label={props.label}
        tabIndex={0}
        data-rail={props.id}
        data-testid={`rail-${props.id}`}
        onScroll={onScroll}
      >
        {props.children}
      </div>
      {n > 1 && (
        <div className="rail-foot">
          <div className="dots" aria-hidden="true">
            {Array.from({ length: n }, (_, i) => (
              <i key={i} className={i === idx ? "on" : undefined} />
            ))}
          </div>
          <span className="rail-nav">
            <button type="button" aria-label={t("a11y.prev")} disabled={idx === 0} onClick={() => by(-1)}>
              <Icon name="chevL" size={18} />
            </button>
            <button type="button" aria-label={t("a11y.next")} disabled={idx >= n - 1} onClick={() => by(1)}>
              <Icon name="chevR" size={18} />
            </button>
          </span>
        </div>
      )}
    </>
  );
}

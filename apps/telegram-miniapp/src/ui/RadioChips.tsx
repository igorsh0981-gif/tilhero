import { useRef, type KeyboardEvent } from "react";
import { haptic } from "../tg";

/**
 * Single-choice chip group (WAI-ARIA radio group): roving tabindex — only the checked chip (or the first) is in the
 * Tab order; arrows move and select, Home/End jump to the ends.
 */
export function RadioChips<T extends string>(props: {
  label: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  className?: string;
}) {
  const { options, value, onChange } = props;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checked = options.findIndex((o) => o.value === value);
  const tabStop = checked >= 0 ? checked : 0;

  const select = (i: number) => {
    const n = (i + options.length) % options.length;
    const o = options[n];
    if (!o) return;
    haptic.selection();
    onChange(o.value);
    refs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: options.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(next);
  };

  return (
    <div className={props.className ? `wrap ${props.className}` : "wrap"} role="radiogroup" aria-label={props.label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="chip"
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === tabStop ? 0 : -1}
          onClick={() => {
            haptic.selection();
            onChange(o.value);
          }}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

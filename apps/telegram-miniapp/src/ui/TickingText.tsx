import { useRef } from "react";

/**
 * Review of sprint 9 (a11y): a countdown inside an `aria-live` region («повторите через N с», PIN lockout mm:ss) must
 * not be announced every second. While `ticking`, the visible text is hidden from assistive technology and a visually
 * hidden copy keeps the text of the first second — the live region announces it once; when the wait ends the region
 * announces the next message as usual.
 */
export function TickingText({ ticking, text }: { ticking: boolean; text: string }) {
  const first = useRef<string | null>(null);
  if (!ticking) {
    first.current = null;
    return <>{text}</>;
  }
  if (first.current == null) first.current = text;
  return (
    <>
      <span aria-hidden="true" data-testid="ticking-visible">
        {text}
      </span>
      <span className="sr-only" data-testid="ticking-announce">
        {first.current}
      </span>
    </>
  );
}

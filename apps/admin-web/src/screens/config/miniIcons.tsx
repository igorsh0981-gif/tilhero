/**
 * 9.4: the Mini App line icons allowed in release notes (packages/contracts/release-notes.json) — copied from
 * apps/telegram-miniapp/src/ui/Icon.tsx so the phone preview shows exactly what the user will see (test: same paths).
 */
import type { ReactElement } from "react";

export const MINI_ICON_PATHS: Record<string, readonly string[]> = {
  spark: ["M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8L12 16.9l-1.8-4.9-4.9-1.8 4.9-1.8z", "M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"],
  ticket: ["M2.5 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2h-15a2 2 0 0 0-2 2z", "M14 5v2M14 11v2M14 17v2"],
  globe: ["c:12,12,8.5", "M3.5 12h17M12 3.5c2.4 2.5 3.6 5.3 3.6 8.5s-1.2 6-3.6 8.5c-2.4-2.5-3.6-5.3-3.6-8.5s1.2-6 3.6-8.5z"],
  pin: ["M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z", "c:12,10,2.4"],
  bell: ["M6.5 16v-5a5.5 5.5 0 0 1 11 0v5l1.5 2h-14z", "M10 20.5a2 2 0 0 0 4 0"],
  radar: ["c:12,12,8.5", "c:12,12,4.5", "M12 12l5.6-5.6", "f:12,12,.9"],
  news: ["M4 5.5h12.5v13a1.5 1.5 0 0 1-1.5 1.5H6a2 2 0 0 1-2-2z", "M16.5 8.5H20v9.5a2 2 0 0 1-2 2h-3", "M7.5 9h5.5M7.5 12.5h5.5M7.5 16h3.5"],
  route: ["c:6,18,2.2", "c:18,6,2.2", "M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"],
  star: ["M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"],
  plane: ["M21 12c0-.8-.7-1.5-1.5-1.5H15L10 4H8l2.5 6.5H6L4.5 8.5H3l1 3.5-1 3.5h1.5L6 13.5h4.5L8 20h2l5-6.5h4.5c.8 0 1.5-.7 1.5-1.5z"],
  bed: ["M3 18.5V6.5", "M3 14.5h18v4", "M21 14.5v-2.5a3 3 0 0 0-3-3h-7.5v5.5", "c:6.8,11.2,1.9"],
  search: ["c:11,11,6.5", "M20 20l-4.2-4.2"],
  shield: ["M12 3.5l7.5 3v5.6c0 4.2-3.2 7.6-7.5 8.6-4.3-1-7.5-4.4-7.5-8.6V6.5z", "M9 12l2.2 2.2L15.5 10"],
  chat: ["M20.5 12a8.5 8.5 0 0 1-12.4 7.5L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z"],
  cal: ["r:3.5,5,17,15.5,3", "M3.5 9.5h17M8 3v4M16 3v4"],
  phone: ["r:6.5,2.5,11,19,2.6", "M10.5 18.2h3", "M9.5 6.5h5"],
};

function shape(d: string, i: number): ReactElement {
  const [kind, rest] = [d.slice(0, 2), d.slice(2)];
  const v = rest.split(",");
  if (kind === "c:") return <circle key={i} cx={v[0]} cy={v[1]} r={v[2]} />;
  if (kind === "f:") return <circle key={i} cx={v[0]} cy={v[1]} r={v[2]} fill="currentColor" stroke="none" />;
  if (kind === "r:") return <rect key={i} x={v[0]} y={v[1]} width={v[2]} height={v[3]} rx={v[4]} />;
  if (kind === "e:") return <ellipse key={i} cx={v[0]} cy={v[1]} rx={v[2]} ry={v[3]} />;
  return <path key={i} d={d} />;
}

export function MiniIcon({ name, size = 16 }: { name: string; size?: number }) {
  const paths = MINI_ICON_PATHS[name] ?? MINI_ICON_PATHS.spark!;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths.map((d, i) => shape(d, i))}
    </svg>
  );
}

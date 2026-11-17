import type { ReleaseNoteIcon } from "@tilhero/contracts/bff";

/** Stroke icons of the prototype (24×24, currentColor). Decorative: always aria-hidden — the label is on the control. */
const P: Record<string, string> = {
  back: "M15 5l-7 7 7 7",
  chevron: "M9 6l6 6-6 6",
  bell: "M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2 2 0 0 0 4 0",
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  lessons: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM9 9h6M9 13h4",
  review: "M4 12a8 8 0 0 1 13.7-5.7L20 8M20 3v5h-5M20 12a8 8 0 0 1-13.7 5.7L4 16M4 21v-5h5",
  progress: "M5 20V11M12 20V5M19 20v-6",
  profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  check: "M5 12l5 5 9-10",
  close: "M6 6l12 12M18 6 6 18",
  plus: "M12 5v14M5 12h14",
  share: "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 3v13M7 8l5-5 5 5",
  copy: "M9 9h10v11H9zM5 15V4h10",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.01",
  alert: "M12 3 2 20h20zM12 10v4M12 17v.01",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  hero: "M8 4h8v5H8zM6 9h12v8H6zM9 17v3M15 17v3M10 12h.01M14 12h.01M12 2v2",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  book: "M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z",
  chat: "M4 5h16v11H9l-5 4z",
  mic: "M9 3h6v12H9zM5 11a7 7 0 0 0 14 0M12 18v3",
  star: "M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z",
  flame: "M12 21c-3.9 0-7-2.8-7-6.6 0-3.1 2.1-5.3 3.9-7.4.4 1.9 1.4 3.2 2.6 3.7C11.8 7.6 12.6 4.7 15 3c.3 3.4 4 6 4 10.9C19 18.2 15.9 21 12 21z",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14a6 6 0 0 1 4 7",
  gift: "M4 9h16v4H4zM6 13h12v8H6zM12 9v12M12 9c-1-3-5-4-5-1.5S12 9 12 9zM12 9c1-3 5-4 5-1.5S12 9 12 9z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M10 17h4",
  news: "M4 5h13v14H6a2 2 0 0 1-2-2zM17 9h3v8a2 2 0 0 1-2 2M8 9h5M8 13h5",
  send: "M4 12 20 4l-6 16-3-7z",
  logout: "M10 4H5v16h5M14 8l4 4-4 4M18 12H9",
  wave: "M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2",
};

export type IconName = keyof typeof P | ReleaseNoteIcon;

export function Icon({ name, size = 22, stroke = 1.9, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  const d = P[name] ?? P.spark!;
  const filled = name === "flame" || name === "star";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={d} />
    </svg>
  );
}

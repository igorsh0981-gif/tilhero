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
  // sprint 3
  play: "M8 5.5v13l11-6.5z",
  stop: "M7 7h10v10H7z",
  volume: "M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11",
  music: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  film: "M4 4h16v16H4zM4 9h16M4 15h16M9 4v16M15 4v16",
  map: "M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15",
  flag: "M5 21V4h11l-2 4 2 4H5",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01",
  // sprint 5
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.2-4.2",
  route: "M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 15V9a3 3 0 0 1 3-3h7M18 9v6a3 3 0 0 1-3 3H8",
  // sprint 6: the game
  snow: "M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.6 4.6 12 6l2.4-1.4M9.6 19.4 12 18l2.4 1.4M4.4 10.3l2.4-.6-.6-2.6M19.6 13.7l-2.4.6.6 2.6M4.4 13.7l2.4.6-.6 2.6M19.6 10.3l-2.4-.6.6-2.6",
  coin: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 8.5h7M12 8.5V17",
  medal: "M8 3l2.6 6.2M16 3l-2.6 6.2M12 21a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 12.6l.9 1.9 2.1.3-1.5 1.5.4 2.1-1.9-1-1.9 1 .4-2.1-1.5-1.5 2.1-.3z",
  bag: "M5 8h14l-1.2 12H6.2zM9 8V6.5a3 3 0 0 1 6 0V8",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
};

export type IconName = keyof typeof P | ReleaseNoteIcon;

export function Icon({ name, size = 22, stroke = 1.9, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  const d = P[name] ?? P.spark!;
  const filled = name === "flame" || name === "star" || name === "play";
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

import type { ReleaseNoteIcon } from "@tilhero/contracts/admin";

/**
 * The 16 «Что нового» icons as the Mini App draws them (apps/telegram-miniapp/src/ui/Icon.tsx, 24×24 stroke paths):
 * the editor's icon picker and the phone preview show exactly what the learner will see.
 */
const P: Record<ReleaseNoteIcon, string> = {
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  hero: "M8 4h8v5H8zM6 9h12v8H6zM9 17v3M15 17v3M10 12h.01M14 12h.01M12 2v2",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  bell: "M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2 2 0 0 0 4 0",
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
};

export function MiniIcon({ name, size = 20 }: { name: ReleaseNoteIcon; size?: number }) {
  const filled = name === "flame" || name === "star";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={P[name] ?? P.spark} />
    </svg>
  );
}

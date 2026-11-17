/** Build-time configuration. Nothing secret lives here: the bundle is public. */
export const env = {
  bffUrl: (import.meta.env.VITE_BFF_URL ?? "").replace(/\/+$/, ""),
  botUsername: (import.meta.env.VITE_BOT_USERNAME ?? "TilHeroBot").replace(/^@/, ""),
  /** Mini App short name in BotFather (t.me/<bot>/<app>); empty → the bot's main Mini App link. */
  miniAppShortName: import.meta.env.VITE_MINIAPP_SHORT_NAME ?? "",
  /** Dev fallback outside Telegram. Production builds never read it (see tg/boot.ts). */
  devInitData: import.meta.env.DEV ? (import.meta.env.VITE_DEV_INIT_DATA ?? "") : "",
  isDev: import.meta.env.DEV,
  clientVersion: "telegram-miniapp-2.0",
} as const;

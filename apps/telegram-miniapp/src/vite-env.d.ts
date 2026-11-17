/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of telegram-bff, e.g. https://bff.tilhero.app (no trailing slash). */
  readonly VITE_BFF_URL?: string;
  /** Bot username for the «Open in Telegram» screen, without @. */
  readonly VITE_BOT_USERNAME?: string;
  /** Mini App short name (BotFather) for share links t.me/<bot>/<app>?startapp=…; empty → main Mini App link. */
  readonly VITE_MINIAPP_SHORT_NAME?: string;
  /** Dev only: signed initData produced by services/telegram-bff/scripts/dev-init-data.ts. Ignored in production builds. */
  readonly VITE_DEV_INIT_DATA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

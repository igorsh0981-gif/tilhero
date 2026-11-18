/**
 * Minimal typings for window.Telegram.WebApp (Bot API 8.x) — only what the Mini App uses.
 * https://core.telegram.org/bots/webapps
 */
export interface TgThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  bottom_bar_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  section_separator_color?: string;
  subtitle_text_color?: string;
  destructive_text_color?: string;
}

export interface TgInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TgWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgBottomButton {
  text: string;
  isVisible: boolean;
  isActive: boolean;
  isProgressVisible: boolean;
  setParams(params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_active?: boolean;
    is_visible?: boolean;
    has_shine_effect?: boolean;
    position?: "left" | "right" | "top" | "bottom";
  }): TgBottomButton;
  onClick(cb: () => void): TgBottomButton;
  offClick(cb: () => void): TgBottomButton;
  show(): TgBottomButton;
  hide(): TgBottomButton;
  showProgress(leaveActive?: boolean): TgBottomButton;
  hideProgress(): TgBottomButton;
}

export interface TgBackButton {
  isVisible: boolean;
  onClick(cb: () => void): TgBackButton;
  offClick(cb: () => void): TgBackButton;
  show(): TgBackButton;
  hide(): TgBackButton;
}

export interface TgHaptic {
  impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): TgHaptic;
  notificationOccurred(type: "error" | "success" | "warning"): TgHaptic;
  selectionChanged(): TgHaptic;
}

export interface TgPopupButton {
  id?: string;
  type?: "default" | "ok" | "close" | "cancel" | "destructive";
  text?: string;
}

export interface TgPopupParams {
  title?: string;
  message: string;
  buttons?: TgPopupButton[];
}

/** Telegram CloudStorage (Bot API 6.9+): per user and bot, keys 1–128 chars [A-Za-z0-9_-], values ≤ 4096 chars. */
export interface TgCloudStorage {
  setItem(key: string, value: string, cb?: (err: string | null, stored?: boolean) => void): TgCloudStorage;
  getItem(key: string, cb: (err: string | null, value?: string) => void): TgCloudStorage;
  removeItem(key: string, cb?: (err: string | null, removed?: boolean) => void): TgCloudStorage;
}

export type TgEvent =
  | "themeChanged"
  | "viewportChanged"
  | "safeAreaChanged"
  | "contentSafeAreaChanged"
  | "backButtonClicked"
  | "mainButtonClicked"
  | "secondaryButtonClicked"
  | "popupClosed"
  | "activated"
  | "deactivated"
  /** Bot API 8.0: full screen entered / left (WebApp.isFullscreen) */
  | "fullscreenChanged"
  /** Bot API 8.0: requestFullscreen failed, payload {error: "UNSUPPORTED" | "ALREADY_FULLSCREEN"} */
  | "fullscreenFailed"
  /** Bot API 8.0: the icon was added to the home screen (only when the device can tell) */
  | "homeScreenAdded"
  /** Bot API 8.0: addToHomeScreen failed, payload {error: "UNSUPPORTED"} */
  | "homeScreenFailed"
  /** Bot API 8.0: answer to checkHomeScreenStatus, payload {status} */
  | "homeScreenChecked";

/** Bot API 8.0: checkHomeScreenStatus / homeScreenChecked {status}. */
export type TgHomeScreenStatus = "unsupported" | "unknown" | "added" | "missed";


export interface TgWebApp {
  initData: string;
  initDataUnsafe: { user?: TgWebAppUser; start_param?: string; auth_date?: number; hash?: string };
  version: string;
  platform: string;
  colorScheme: "light" | "dark";
  themeParams: TgThemeParams;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  safeAreaInset?: TgInsets;
  contentSafeAreaInset?: TgInsets;
  isVersionAtLeast(version: string): boolean;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  disableVerticalSwipes?(): void;
  onEvent(event: TgEvent, handler: (payload?: unknown) => void): void;
  offEvent(event: TgEvent, handler: (payload?: unknown) => void): void;
  ready(): void;
  expand(): void;
  /** Bot API 8.0+: the Mini App is in full screen (Telegram draws its buttons over the content — contentSafeAreaInset). */
  isFullscreen?: boolean;
  /** Bot API 8.0+: fullscreenChanged on success, fullscreenFailed {error} otherwise. */
  requestFullscreen?(): void;
  exitFullscreen?(): void;
  /** Bot API 8.0+: prompt to add the Mini App to the home screen (homeScreenAdded on success, if the device can tell). */
  addToHomeScreen?(): void;
  /** Bot API 8.0+: status via callback (and the homeScreenChecked event). */
  checkHomeScreenStatus?(cb?: (status: TgHomeScreenStatus) => void): void;
  CloudStorage?: TgCloudStorage;
  close(): void;
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  openTelegramLink(url: string): void;
  showPopup(params: TgPopupParams, cb?: (buttonId: string) => void): void;
  showConfirm(message: string, cb?: (ok: boolean) => void): void;
  requestWriteAccess?(cb?: (granted: boolean) => void): void;
  BackButton: TgBackButton;
  MainButton: TgBottomButton;
  SecondaryButton?: TgBottomButton;
  HapticFeedback?: TgHaptic;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

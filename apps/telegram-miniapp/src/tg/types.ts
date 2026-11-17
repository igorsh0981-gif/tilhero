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
  | "deactivated";


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

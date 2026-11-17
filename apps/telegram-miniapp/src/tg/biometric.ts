import type { TgBiometricManager } from "./types";
import { getWebApp, isInsideTelegram, supports } from "./webapp";

export interface BiometricInfo {
  available: boolean;
  type: "face" | "finger" | "unknown";
  accessRequested: boolean;
  accessGranted: boolean;
  tokenSaved: boolean;
}

function manager(): TgBiometricManager | null {
  const wa = getWebApp();
  if (!wa || !isInsideTelegram() || !supports("7.2")) return null;
  return wa.BiometricManager ?? null;
}

function info(bm: TgBiometricManager): BiometricInfo {
  return {
    available: !!bm.isBiometricAvailable,
    type: bm.biometricType ?? "unknown",
    accessRequested: !!bm.isAccessRequested,
    accessGranted: !!bm.isAccessGranted,
    tokenSaved: !!bm.isBiometricTokenSaved,
  };
}

/** BiometricManager.init — never prompts the user. null outside Telegram / on old clients. */
export function biometricInit(): Promise<BiometricInfo | null> {
  const bm = manager();
  if (!bm) return Promise.resolve(null);
  if (bm.isInited) return Promise.resolve(info(bm));
  return new Promise((resolve) => {
    try {
      bm.init(() => resolve(info(bm)));
    } catch {
      resolve(null);
    }
  });
}

/** Only after an explicit user action (toggle in Profile) — ТЗ: «BiometricManager только по явному user action». */
export function biometricRequestAccess(reason: string): Promise<boolean> {
  const bm = manager();
  if (!bm) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      bm.requestAccess({ reason }, (granted) => resolve(!!granted));
    } catch {
      resolve(false);
    }
  });
}

/** Only on tap of the biometric key on the lock screen. Returns the token stored by Telegram. */
export function biometricAuthenticate(reason: string): Promise<{ ok: boolean; token: string | null }> {
  const bm = manager();
  if (!bm) return Promise.resolve({ ok: false, token: null });
  return new Promise((resolve) => {
    try {
      bm.authenticate({ reason }, (success, token) => resolve({ ok: !!success, token: success && token ? token : null }));
    } catch {
      resolve({ ok: false, token: null });
    }
  });
}

/** Store (or clear with "") the server-issued biometric_token in the device keystore. */
export function biometricUpdateToken(token: string): Promise<boolean> {
  const bm = manager();
  if (!bm) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      bm.updateBiometricToken(token, (updated) => resolve(!!updated));
    } catch {
      resolve(false);
    }
  });
}

export function biometricOpenSettings(): void {
  try {
    manager()?.openSettings();
  } catch {
    /* ignore */
  }
}

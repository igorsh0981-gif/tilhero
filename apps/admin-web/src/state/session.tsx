import { createContext, useContext } from "react";
import type { Me, Permission } from "@tilhero/contracts/admin";
import type { MenuEntry } from "./nav";

export type SignOutReason = "explicit" | "idle" | "expired" | "revoked";

/** Admin layout of the active experience-config version (payload.layout, app=admin): density, order and switches of the menu. */
export interface AdminLayout {
  density: "compact" | "comfortable";
  menu: MenuEntry[];
}

export interface Session {
  me: Me | null;
  /** UX only (menu, locked buttons). Every command is re-checked by admin-bff and the domain. */
  can(p: Permission): boolean;
  canAny(ps: readonly Permission[]): boolean;
  refreshMe(): Promise<Me | null>;
  setMe(me: Me): void;
  signOut(reason?: SignOutReason): Promise<void>;
  /** re-reads the active admin experience config and applies its theme tokens and menu */
  reloadTheme(): Promise<void>;
  themeVersion: string | null;
  /** null until the active admin config has been read (or when it is unavailable) → built-in defaults */
  adminLayout: AdminLayout | null;
}

const noop = async () => undefined;
export const SessionCtx = createContext<Session>({
  me: null,
  can: () => false,
  canAny: () => false,
  refreshMe: async () => null,
  setMe: () => undefined,
  signOut: noop,
  reloadTheme: noop,
  themeVersion: null,
  adminLayout: null,
});

export const useSession = () => useContext(SessionCtx);

export function permSet(me: Me | null): ReadonlySet<Permission> {
  return new Set(me?.permissions ?? []);
}

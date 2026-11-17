import type { DeletionResponse, ExperienceConfig, Profile, SecurityState, SessionResponse } from "@tilhero/contracts/bff";
import { createContext, useCallback, useContext, type Dispatch } from "react";
import type { ApiClient } from "../api/client";
import type { Api } from "../api/endpoints";
import { errorText } from "../api/errors";
import type { ConfigSource } from "../config/experience";
import { useI18n } from "../i18n";
import type { NavAction, NavState } from "./nav";

export interface AppCtx {
  api: Api;
  client: ApiClient;
  inTelegram: boolean;
  session: SessionResponse;
  profile: Profile | null;
  setProfile(p: Profile): void;
  reloadProfile(): Promise<Profile | null>;
  setSecurity(s: SecurityState): void;
  applySession(s: SessionResponse): void;
  config: ExperienceConfig;
  configSource: ConfigSource;
  online: boolean;
  /** first visit: a brand-new profile or onboarding finished during this launch (big welcome on Home) */
  firstVisit: boolean;
  nav: NavState;
  navigate: Dispatch<NavAction>;
  /** server says the PIN is needed (423) or the user locked manually */
  lock(): void;
  /** onboarding finished → main app */
  onboardingDone(): void;
  /** deletion requested → «Запрос принят» */
  deletionAccepted(r: DeletionResponse): void;
}

export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const v = useContext(AppContext);
  if (!v) throw new Error("useApp outside AppContext");
  return v;
}

/** Localised text for any thrown error. */
export function useErrorText(): (e: unknown) => string {
  const { t, fmt } = useI18n();
  return useCallback((e: unknown) => errorText(e, t, fmt.mmss), [t, fmt]);
}

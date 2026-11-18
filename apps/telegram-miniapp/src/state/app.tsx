import type { DeletionResponse, ExperienceConfig, LearningPlan, Profile, SessionResponse } from "@tilhero/contracts/bff";
import { createContext, useContext } from "react";
import type { Bff } from "../api/bff";
import type { Nav } from "./nav";

/** Everything a screen needs from the shell. Created in App.tsx once the session is ready. */
export interface AppCtx {
  bff: Bff;
  session: SessionResponse;
  /** a new SessionResponse (PIN verify, learner switch): tokens are already accepted by the client */
  applySession(s: SessionResponse): Promise<void>;
  /** merge a fresh Profile into the session (account, learners, consent, security) */
  syncProfile(p: Profile): void;
  patchSession(patch: Partial<SessionResponse>): void;
  plan: LearningPlan | null;
  setPlan(p: LearningPlan): void;
  reloadPlan(): Promise<LearningPlan | null>;
  config: ExperienceConfig;
  nav: Nav;
  unread: number;
  setUnread(n: number): void;
  refreshUnread(): void;
  /** startapp of a notification / route of «Что нового» → the right screen or sheet */
  openLink(raw: string | null): void;
  /** the session ended (deletion requested: 202, sessions revoked) */
  endSession(kind: "deleted", res: DeletionResponse): void;
  deviceTz: string;
  online: boolean;
}

const Ctx = createContext<AppCtx | null>(null);
export const AppProvider = Ctx.Provider;

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

/** The plan is loaded before any screen that uses it renders. */
export function usePlan(): LearningPlan {
  const { plan } = useApp();
  if (!plan) throw new Error("plan is not loaded");
  return plan;
}

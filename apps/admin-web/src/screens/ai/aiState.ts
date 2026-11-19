/**
 * «Is the AI on?» for the banner of the three sprint 4 sections. The source depends on the role: GET /ai/budget
 * (costs.read), else AiProviderStatus.ai_enabled of GET /ai/provider (ai.read — the QA analyst and the methodist have
 * no costs.read), else the `ai` block of GET /dashboard. The value is shared between the sections, refreshed at most
 * every 30 s and set at once by the emergency stop and the overview.
 */
import { useEffect, useSyncExternalStore } from "react";
import { Ai, DashboardApi } from "../../api/endpoints";
import { useSession } from "../../state/session";

let state: { enabled: boolean | null; at: number } = { enabled: null, at: 0 };
const subs = new Set<() => void>();
let inflight: Promise<void> | null = null;

export function setAiEnabled(enabled: boolean | null): void {
  state = { enabled, at: Date.now() };
  subs.forEach((f) => f());
}

/** test hook: forget the cached value */
export function resetAiState(): void {
  state = { enabled: null, at: 0 };
  inflight = null;
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function useAiEnabled(): boolean | null {
  const { can } = useSession();
  const costs = can("costs.read");
  const ai = can("ai.read");
  const dash = can("dashboard.read");
  const enabled = useSyncExternalStore(subscribe, () => state.enabled);
  useEffect(() => {
    if (Date.now() - state.at < 30_000 || inflight || (!costs && !ai && !dash)) return;
    inflight = (
      costs
        ? Ai.budget(true).then((b) => b.ai_enabled)
        : ai
          ? Ai.provider(true).then((p) => p.ai_enabled)
          : DashboardApi.get("today", true).then((d) => (d.ai?.available && d.ai.data ? d.ai.data.ai_enabled : null))
    )
      .then((v) => setAiEnabled(v))
      .catch(() => undefined)
      .finally(() => {
        inflight = null;
      });
  }, [costs, ai, dash]);
  return enabled;
}

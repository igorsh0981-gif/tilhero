import type { EventDetailView } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { aiStore, useAi } from "../../ai/store";
import { useI18n } from "../../i18n";
import { haptic, useMainButton } from "../../tg";
import { Icon } from "../../ui/Icon";

/**
 * Sprint 7 — where the concierge opens (AGENT_BRIEF F): the MainButton on the event detail «✦ Спросить AI о поездке»
 * (n-04: «✦ Спросить AI» on narrow screens), the row on Home, «Попросить AI найти похожее» in the empty catalogue.
 * No entry point while GET /v1/ai/quota has not answered or says the concierge is not connected.
 */
const NARROW = 390;

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < NARROW);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}

export function useAiAvailable(): boolean {
  return useAi().availability === "on";
}

/** The detail's MainButton; hidden while the chat is open (the chat has its own composer). */
export function useAskAiButton(ev: Pick<EventDetailView, "event_id" | "title">): void {
  const { availability, chat } = useAi();
  const { t } = useI18n();
  const narrow = useNarrow();
  useMainButton(
    availability === "on" && !chat
      ? {
          text: t(narrow ? "dt.ai.askShort" : "dt.ai.ask"),
          short: t("dt.ai.askShort"),
          onClick: () => {
            haptic.impact("light");
            aiStore.open({ mode: "event", eventId: ev.event_id, title: ev.title, query: null });
          },
        }
      : null,
  );
}

export function openAiHome(query: string | null, title: string | null = null): void {
  haptic.impact("light");
  aiStore.open({ mode: "home", eventId: null, title, query: query?.trim().slice(0, 120) || null });
}

/** Home: one row under the search — the concierge picks events by the user's query and interests. */
export function AiHomeEntry() {
  const { t } = useI18n();
  if (!useAiAvailable()) return null;
  return (
    <button className="ai-home" type="button" data-testid="home-ai" onClick={() => openAiHome(null)}>
      <span className="ai-av" aria-hidden="true">
        <Icon name="spark" size={18} />
      </span>
      <span className="grow">
        <b>{t("home.ai")}</b>
        <small>{t("home.ai.sub")}</small>
      </span>
      <Icon name="chevR" size={16} />
    </button>
  );
}

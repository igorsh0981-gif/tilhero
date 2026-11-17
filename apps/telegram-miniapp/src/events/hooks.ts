import { useCallback } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { useApp } from "../state/app";
import { categoryLabel, useInterests } from "../state/directory";
import { KNOWN_TOP } from "./catalog";

/** (categories) → localised type label for event cards (directory label, bundled top-level name as fallback). */
export function useTypeLabel(): (categories: readonly string[]) => string {
  const { api } = useApp();
  const { t, lang } = useI18n();
  const dir = useInterests(api);
  return useCallback(
    (categories: readonly string[]) =>
      categoryLabel(dir.items, categories, lang, (top) => ((KNOWN_TOP as readonly string[]).includes(top) ? t(`cat.${top}` as MessageKey) : t("cat.other"))),
    [dir.items, lang, t],
  );
}

/** Open the event detail on top of the current screen (BackButton returns). */
export function useOpenEvent(): (id: string) => void {
  const { navigate } = useApp();
  return useCallback((id: string) => navigate({ type: "push", route: { name: "event", id } }), [navigate]);
}

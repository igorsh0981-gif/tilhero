import type { EventCard } from "@tilhero/contracts/bff";
import { EventCardView, type CardVariant } from "../../ui/EventCard";
import { useWatchRef } from "../../watch/store";
import type { useWatchAction } from "./WatchSheet";

const UNWATCHABLE = new Set(["CANCELLED", "COMPLETED"]);

/** EventCard with the Watch icon (state from the BFF `watch`, overridden by taps in this launch). */
export function WatchableCard(props: {
  event: EventCard;
  variant: CardVariant;
  typeLabel: string;
  onOpen: (id: string) => void;
  score?: number | null;
  wa: ReturnType<typeof useWatchAction>;
}) {
  const { event: e, wa } = props;
  const ref = useWatchRef(e.event_id, e.watch);
  const on = ref && ref.status !== "ended" ? ref : null;
  const can = !!on || (e.is_past !== true && !UNWATCHABLE.has(e.lifecycle.status));
  return (
    <EventCardView
      event={e}
      variant={props.variant}
      typeLabel={props.typeLabel}
      onOpen={props.onOpen}
      score={props.score}
      watch={can ? { on: !!on, paused: on?.status === "paused", busy: wa.busy === e.event_id, onTap: () => void wa.act(e.event_id, on) } : null}
    />
  );
}

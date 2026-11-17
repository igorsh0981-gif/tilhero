import type { ReleaseNoteRoute, WhatsNew } from "@tilhero/contracts/bff";
import { useMemo, useRef, useState } from "react";
import { cardsOf, seenNoteIds } from "../../domain/whatsNew";
import { useI18n } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { Btn, Pill } from "../../ui/kit";
import { Sheet } from "../../ui/overlays";

/**
 * «Что нового» (AT-11): mode welcome — getting to know the whole app after the first registration; mode updates —
 * what the learner has not seen yet. One item per card; the notes whose cards were on screen are reported as seen
 * when the sheet closes (by «Понятно», «Подробнее», the cross, Escape or the Telegram back button).
 */
export function WhatsNewSheet({ data, onClose }: { data: WhatsNew; onClose: (seenIds: string[], route: ReleaseNoteRoute | null) => void }) {
  const { t } = useI18n();
  const cards = useMemo(() => cardsOf(data), [data]);
  const [idx, setIdx] = useState(0);
  const maxIdx = useRef(0);
  const closed = useRef(false);
  const card = cards[Math.min(idx, cards.length - 1)];
  if (!card) return null;
  const last = idx >= cards.length - 1;
  const welcome = data.mode === "welcome";

  const close = (route: ReleaseNoteRoute | null) => {
    if (closed.current) return;
    closed.current = true;
    onClose(seenNoteIds(cards, maxIdx.current), route);
  };
  const next = () => {
    if (last) return close(null);
    const n = idx + 1;
    maxIdx.current = Math.max(maxIdx.current, n);
    setIdx(n);
  };

  return (
    <Sheet title={welcome ? t("wn.welcome.title") : t("wn.updates.title")} cap={welcome ? t("wn.welcome.cap") : t("wn.updates.cap")} onClose={() => close(null)} testId={`whats-new-${data.mode}`}>
      <div className="card k stack wn-card" aria-live="polite" data-testid="wn-card">
        <div className="hrow between">
          <Pill>{card.noteTitle}</Pill>
          <span className="sub small">{t("wn.progress", { n: idx + 1, m: cards.length })}</span>
        </div>
        <div className="hrow">
          {card.item.icon ? (
            <span className="wn-ic">
              <Icon name={card.item.icon} size={20} />
            </span>
          ) : null}
          <h3 className="h3">{card.item.title}</h3>
        </div>
        <p className="sub">{card.item.text}</p>
      </div>
      <div className="dots" aria-hidden="true">
        {cards.map((c, i) => (
          <div key={c.key} className={i === idx ? "dt on" : "dt"} />
        ))}
      </div>
      <div className="duo">
        {card.item.link ? (
          <Btn variant="secondary" onClick={() => close(card.item.link)} data-testid="wn-more">
            {t("wn.more")}
          </Btn>
        ) : (
          <span />
        )}
        <Btn onClick={next} data-testid="wn-next">
          {last ? t("wn.gotIt") : t("wn.next")}
        </Btn>
      </div>
      <p className="sub small center">{t("wn.once")}</p>
    </Sheet>
  );
}

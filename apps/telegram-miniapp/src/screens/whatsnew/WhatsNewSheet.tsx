import type { WhatsNew } from "@tilhero/contracts/bff";
import type { AppRoute } from "../../tg/deeplink";
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
 *
 * Release 6.1: the first card of a note with an illustration shows it on top, full width of the sheet (16:9, the
 * corners of the cards, alt = the note title). The box is reserved before the picture arrives (width/height and
 * aspect-ratio — no layout shift); a picture that fails to load is dropped and the card looks as before.
 */
export function WhatsNewSheet({ data, onClose }: { data: WhatsNew; onClose: (seenIds: string[], route: AppRoute | null) => void }) {
  const { t } = useI18n();
  const cards = useMemo(() => cardsOf(data), [data]);
  const [idx, setIdx] = useState(0);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const maxIdx = useRef(0);
  const closed = useRef(false);
  const card = cards[Math.min(idx, cards.length - 1)];
  if (!card) return null;
  const last = idx >= cards.length - 1;
  const welcome = data.mode === "welcome";
  const art = card.art && !broken.has(card.art.src) ? card.art : null;

  const close = (route: AppRoute | null) => {
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
      {art ? (
        <figure className="wn-art" key={art.src} data-testid="wn-art">
          <img
            src={art.src}
            width={art.width}
            height={art.height}
            alt={card.noteTitle}
            decoding="async"
            onError={() => setBroken((b) => new Set(b).add(art.src))}
          />
        </figure>
      ) : null}
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

/**
 * 9.4 «Что нового в TilHero»: нижняя шторка с пунктами заметок о релизах, «Понятно» — MainButton Telegram (как в
 * других шторках-формах), у пункта со ссылкой — «Посмотреть». Тексты заметок — только как текст (никакой разметки).
 */
import type { ReleaseNote } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { loadWhatsNew, markWhatsNewSeen, routeAction, unseenAfterLaunchMark, wnLaunch } from "../../state/whatsNew";
import { haptic, useMainButton } from "../../tg";
import { Icon, type IconName } from "../../ui/Icon";
import { LRow } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";

const ICONS: ReadonlySet<string> = new Set([
  "spark", "ticket", "globe", "pin", "bell", "radar", "news", "route", "star", "plane", "bed", "search", "shield", "chat", "cal", "phone",
]);
const iconOf = (name: string | null): IconName => (name && ICONS.has(name) ? (name as IconName) : "spark");

export function WhatsNewSheet({ notes, onClose }: { notes: ReleaseNote[]; onClose: () => void }) {
  const { api, navigate } = useApp();
  const { t, l, fmt } = useI18n();
  const close = () => {
    markWhatsNewSeen(api, notes);
    onClose();
  };
  useMainButton({ text: t("wn.ok"), onClick: close });
  const one = notes.length === 1 ? notes[0]! : null;
  return (
    <Sheet
      title={t("wn.h")}
      sub={one ? `${l(one.title)} · ${fmt.date(one.published_at)}` : t("wn.sub.many", { n: notes.length })}
      onClose={close}
      className="wn-sheet"
    >
      <div data-testid="whats-new">
        {notes.map((n) => (
          <section key={n.release_note_id} className="wn-note" aria-label={l(n.title)}>
            {!one && (
              <h3 className="wn-note-h">
                {l(n.title)}
                <small>{fmt.date(n.published_at)}</small>
              </h3>
            )}
            <ul className="wn-list">
              {n.items.map((it, i) => {
                const go = routeAction(it.link);
                const title = l(it.title);
                return (
                  <li key={i}>
                    <span className="wn-ic" aria-hidden="true">
                      <Icon name={iconOf(it.icon)} size={18} />
                    </span>
                    <div className="wn-t">
                      <b>{title}</b>
                      <p>{l(it.text)}</p>
                      {go && (
                        <button
                          className="lnk"
                          type="button"
                          aria-label={t("wn.view.aria", { title })}
                          data-testid="wn-view"
                          onClick={() => {
                            haptic.selection();
                            close();
                            navigate(go);
                          }}
                        >
                          {t("wn.view")}
                          <Icon name="chevR" size={14} />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Sheet>
  );
}

/** Главная: шторка сама — раз за запуск, после загрузки Главной (ready; Home передаёт false, пока открыто
 *  приветствие первого запуска — ревью 9.4). */
export function useAutoWhatsNew(ready: boolean): React.ReactNode {
  const { api } = useApp();
  const [notes, setNotes] = useState<ReleaseNote[] | null>(null);
  useEffect(() => {
    if (!ready || wnLaunch.autoShown) return;
    let alive = true;
    void loadWhatsNew(api).then((r) => {
      const items = unseenAfterLaunchMark(r?.items ?? []);
      if (!alive || wnLaunch.autoShown || !items.length) return;
      wnLaunch.autoShown = true;
      setNotes(items);
    });
    return () => {
      alive = false;
    };
  }, [ready, api]);
  return notes ? <WhatsNewSheet notes={notes} onClose={() => setNotes(null)} /> : null;
}

/** Профиль: «Что нового» — последняя заметка вручную. */
export function WhatsNewRow() {
  const { api } = useApp();
  const { t, l } = useI18n();
  const [latest, setLatest] = useState<ReleaseNote | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadWhatsNew(api).then((r) => alive && setLatest(r?.latest ?? null));
    return () => {
      alive = false;
    };
  }, [api]);
  return (
    <>
      <LRow
        icon="spark"
        title={t("p.wn")}
        sub={latest ? l(latest.title) : t("p.wn.sub")}
        disabled={busy}
        testId="wn-row"
        onClick={() => {
          setBusy(true);
          void loadWhatsNew(api, true).then((r) => {
            setBusy(false);
            if (r?.latest) {
              setLatest(r.latest);
              setOpen(true);
            } else showToast(t(r ? "wn.empty" : "err.SERVICE_UNAVAILABLE"), "info");
          });
        }}
      />
      {open && latest && <WhatsNewSheet notes={[latest]} onClose={() => setOpen(false)} />}
    </>
  );
}

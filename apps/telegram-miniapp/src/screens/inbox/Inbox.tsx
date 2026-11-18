import type { InboxItem, NotificationCategory } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction } from "../../state/hooks";
import { errorText } from "../../api/errors";
import { Icon, type IconName } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Pill, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";

const CAT_ICON: Record<NotificationCategory, IconName> = {
  reminders: "clock",
  missed: "calendar",
  social: "users",
  support: "chat",
  product: "spark",
  service: "shield",
};
const CAT_TONE: Partial<Record<NotificationCategory, string>> = { missed: "warn", social: "ok" };

/**
 * Notification center (AT-12): every message the learner was sent — also when Telegram delivery was off, postponed
 * or the bot is blocked. Unread items are marked with a dot, bold title and the word «новое» (not by colour alone);
 * opening an item marks it read and follows its startapp.
 */
export function Inbox() {
  const { bff, nav, setUnread, openLink } = useApp();
  const { t, fmt } = useI18n();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (c: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const page = await bff.inbox(c);
      setItems((prev) => (c ? [...prev, ...page.items.filter((i) => !prev.some((p) => p.notification_id === i.notification_id))] : page.items));
      setCursor(page.next_cursor);
    } catch (e) {
      setError(errorText(e, t, fmt.mmss));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readAll = useAction(async () => {
    const r = await bff.markRead({ all: true });
    const now = new Date().toISOString();
    setItems((prev) => prev.map((i) => (i.read_at ? i : { ...i, read_at: now })));
    setUnread(r.unread);
  });

  const open = async (item: InboxItem) => {
    if (!item.read_at) {
      const now = new Date().toISOString();
      setItems((prev) => prev.map((i) => (i.notification_id === item.notification_id ? { ...i, read_at: now } : i)));
      try {
        const r = await bff.markRead({ ids: [item.notification_id] });
        setUnread(r.unread);
      } catch {
        /* the dot comes back on the next load; opening still works */
      }
    }
    if (item.startapp) openLink(item.startapp);
  };

  const unreadHere = items.some((i) => !i.read_at);
  return (
    <>
      <Bar title={t("inbox.title")} onBack={nav.back} />
      <main className="scroll" data-testid="inbox">
        <div className="pad stack">
          {unreadHere ? (
            <Btn variant="link" busy={readAll.busy} onClick={() => void readAll.run()} data-testid="read-all">
              <Icon name="check" size={18} />
              {t("inbox.readAll")}
            </Btn>
          ) : null}
          <ErrorLine text={readAll.error} />
          {items.length ? (
            <ul className="list" aria-label={t("inbox.title")}>
              {items.map((i) => (
                <li key={i.notification_id}>
                  <button type="button" className={cx("row", !i.read_at && "unread")} onClick={() => void open(i)} data-testid="inbox-item" aria-describedby={`n-${i.notification_id}`}>
                    <span className={cx("nic", CAT_TONE[i.category])}>
                      <Icon name={CAT_ICON[i.category] ?? "bell"} size={20} />
                    </span>
                    <span className="t">
                      <small>
                        {t(`cat.${i.category}` as MessageKey)} · {fmt.dateTime(i.created_at)}
                      </small>
                      <b>{i.title}</b>
                      <span>{i.body}</span>
                      <span id={`n-${i.notification_id}`} className="pills">
                        {!i.read_at ? <Pill>{t("c.new")}</Pill> : null}
                        {i.telegram !== "sent" ? <Pill tone="mute">{t(`inbox.tg.${i.telegram}` as MessageKey)}</Pill> : null}
                      </span>
                    </span>
                    {!i.read_at ? <span className="unread-dot" aria-hidden="true" /> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : !loading && !error ? (
            <div className="card">
              <p className="sub">{t("inbox.empty")}</p>
            </div>
          ) : null}
          {loading ? <Skeleton lines={items.length ? 1 : 3} /> : null}
          {error ? (
            <div className="card err stack tight">
              <p className="sub ink">{error}</p>
              <Btn variant="secondary" onClick={() => void load(items.length ? cursor : null)}>{t("c.retry")}</Btn>
            </div>
          ) : null}
          {cursor && !loading && !error ? (
            <Btn variant="secondary" onClick={() => void load(cursor)} data-testid="inbox-more">
              {t("c.more")}
            </Btn>
          ) : null}
        </div>
      </main>
    </>
  );
}

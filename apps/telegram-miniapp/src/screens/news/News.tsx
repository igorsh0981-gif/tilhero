import type { WhatsNewNote } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { Icon } from "../../ui/Icon";
import { Btn, Margin, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";

/** News feed (GET /v1/news): every published note visible to the learner, newest first; items lead to screens. */
export function News() {
  const { bff, nav } = useApp();
  const { t, fmt } = useI18n();
  const [notes, setNotes] = useState<WhatsNewNote[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = async (c: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const page = await bff.news(c);
      setNotes((prev) => (c ? [...prev, ...page.items] : page.items));
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
  return (
    <>
      <Bar title={t("news.title")} onBack={nav.back} />
      <main className="scroll" data-testid="news">
        <div className="stack">
          {notes.map((n) => (
            <Margin key={n.release_note_id} note={fmt.date(n.published_at).split(" ")[0]} tone="b">
              <article className="card stack tight">
                <div className="cap">{fmt.date(n.published_at)}</div>
                <h2 className="h3">{n.title}</h2>
                {n.items.map((it, i) => (
                  <div key={i} className="stack tight">
                    <p className="sub ink"><b>{it.title}</b></p>
                    <p className="sub">{it.text}</p>
                    {it.link ? (
                      <Btn variant="link" onClick={() => nav.route(it.link!)}>
                        {t("news.open")}
                        <Icon name="chevron" size={16} />
                      </Btn>
                    ) : null}
                  </div>
                ))}
              </article>
            </Margin>
          ))}
          <div className="pad stack">
            {!loading && !error && !notes.length ? <div className="card"><p className="sub">{t("news.empty")}</p></div> : null}
            {loading ? <Skeleton lines={2} /> : null}
            {error ? (
              <div className="card err stack tight">
                <p className="sub ink">{error}</p>
                <Btn variant="secondary" onClick={() => void load(notes.length ? cursor : null)}>{t("c.retry")}</Btn>
              </div>
            ) : null}
            {cursor && !loading && !error ? <Btn variant="secondary" onClick={() => void load(cursor)}>{t("c.more")}</Btn> : null}
          </div>
        </div>
      </main>
    </>
  );
}

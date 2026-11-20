import type { CardStatus, DictionaryCard, ErrorJournalItem } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { daysUntil } from "../../domain/memory";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, Chip, Pill, Seg } from "../../ui/kit";
import { ListState, usePaged } from "../practice/Practice";
import { KindPill, Strength } from "./parts";
import { ReviewCard } from "./ReviewCard";

export type DictView = "all" | "word" | "phrase" | "error";
const STATUSES: readonly CardStatus[] = ["new", "learning", "review", "known"];

/** Filters survive opening a card and coming back (the tab root unmounts under a pushed screen) — per learner. */
const memory: { learner: string | null; view: DictView; status: CardStatus | null; q: string } = { learner: null, view: "all", status: null, q: "" };

/**
 * «Словарь» (APP-MEM-01/02, APP-PROG-04 partly): «Повторение дня» on top, my words and phrases (filters by kind and
 * status, search by English and the translation, pages), the strength of each card in bars and a word, and the error
 * journal (corrections of the evaluator with the explanation). A child has no error journal: children never write free
 * text.
 */
export function Dictionary() {
  const { bff, session } = useApp();
  const { t } = useI18n();
  const kid = session.learner.kind === "child";
  const me = session.learner.learner_id;
  if (memory.learner !== me) Object.assign(memory, { learner: me, view: "all", status: null, q: "" });
  const [view, setViewState] = useState<DictView>(kid && memory.view === "error" ? "all" : memory.view);
  const [status, setStatusState] = useState<CardStatus | null>(memory.status);
  const [q, setQState] = useState(memory.q);
  const [query, setQuery] = useState(memory.q.trim());
  const setView = (v: DictView) => setViewState((memory.view = v));
  const setStatus = (s: CardStatus | null) => setStatusState((memory.status = s));
  const setQ = (v: string) => setQState((memory.q = v));
  useEffect(() => {
    // search after a pause in typing (the BFF never logs the query)
    const id = setTimeout(() => setQuery(q.trim()), 350);
    return () => clearTimeout(id);
  }, [q]);
  const overview = useLoad(() => bff.memoryOverview(true), [me]);

  const views: Array<{ value: DictView; label: string }> = [
    { value: "all", label: t("mem.view.all") },
    { value: "word", label: t("mem.view.word") },
    { value: "phrase", label: t("mem.view.phrase") },
    ...(kid ? [] : [{ value: "error" as const, label: t("mem.view.error") }]),
  ];

  return (
    <main className="scroll" data-testid="dictionary">
      <div className="stack loose">
        <ReviewCard overview={overview.data} loading={overview.loading} testId="dict-review" />
        <div className="pad stack tight">
          <Seg label={t("mem.view")} value={view} onChange={setView} options={views} testId="dict-view" />
          {view !== "error" ? (
            <>
              <div className="search">
                <label className="sr" htmlFor="dict-q">{t("mem.search")}</label>
                <Icon name="search" size={18} />
                <input
                  id="dict-q"
                  className="inp"
                  type="search"
                  inputMode="search"
                  enterKeyHint="search"
                  autoComplete="off"
                  maxLength={60}
                  placeholder={t("mem.searchPh")}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  data-testid="dict-search"
                />
              </div>
              <div className="chips x" role="group" aria-label={t("mem.statusFilter")} data-testid="dict-status">
                <Chip on={status === null} label={t("mem.status.all")} onClick={() => setStatus(null)} />
                {STATUSES.map((s) => (
                  <Chip key={s} on={status === s} label={t(`mem.status.${s}` as MessageKey)} onClick={() => setStatus(status === s ? null : s)} />
                ))}
              </div>
            </>
          ) : (
            <p className="sub small">{t("mem.errors.note")}</p>
          )}
        </div>
        {view === "error" ? (
          <ErrorJournal />
        ) : (
          <CardList
            kind={view === "all" ? null : view}
            status={status}
            q={query}
            totalCards={overview.data?.total_cards ?? null}
            onReset={() => {
              setStatus(null);
              setQ("");
              setQuery("");
              setView("all");
            }}
          />
        )}
      </div>
    </main>
  );
}

function dueText(c: Pick<DictionaryCard, "status" | "due_at">, t: (k: MessageKey, v?: Record<string, string | number>) => string): string {
  if (c.status === "known") return t("mem.due.known");
  if (c.status === "frozen") return t("mem.due.frozen");
  if (c.status === "new") return t("mem.due.new");
  const d = daysUntil(c.due_at);
  if (d === null) return "";
  return d === 0 ? t("mem.due.today") : t("mem.due.in", { n: d });
}

function CardList(props: { kind: "word" | "phrase" | null; status: CardStatus | null; q: string; totalCards: number | null; onReset: () => void }) {
  const { bff, nav } = useApp();
  const { t, l } = useI18n();
  const list = usePaged<DictionaryCard>((c) => bff.memoryCards({ kind: props.kind, status: props.status, q: props.q }, c), `${props.kind}|${props.status}|${props.q}`);
  const filtered = !!props.kind || !!props.status || !!props.q;
  const empty = list.items !== null && list.items.length === 0;
  return (
    <>
      {list.items?.length ? (
        <div className="pad">
          <ul className="list" data-testid="dict-list">
            {list.items.map((c) => (
              <li key={c.card_id}>
                <button type="button" className="row dict-row" onClick={() => nav.push({ name: "card", id: c.card_id })} data-testid={`dict-card-${c.card_id}`}>
                  <span className="t">
                    <b lang="en">{c.text_en}</b>
                    <span>{l(c.gloss)}</span>
                    <span className="pills">
                      {!props.kind ? <KindPill kind={c.kind} /> : null}
                      <span className="due">{dueText(c, t)}</span>
                    </span>
                  </span>
                  <Strength value={c.strength} compact />
                  <Icon name="chevron" size={18} stroke={2} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {empty ? (
        filtered ? (
          <div className="pad stack tight" data-testid="dict-empty" data-filtered="true">
            <p className="sub">{t("mem.empty.filtered")}</p>
            <Btn variant="secondary" onClick={props.onReset}>{t("mem.empty.reset")}</Btn>
          </div>
        ) : (
          <div className="pad">
            <div className="card stack tight" data-testid="dict-empty" data-filtered="false">
              <b className="h3">{t("mem.empty.title")}</b>
              <p className="sub">{t("mem.empty.text")}</p>
              <Btn variant="secondary" onClick={() => nav.push({ name: "practice", tab: "reading" })} data-testid="dict-to-reading">
                <Icon name="book" size={18} />
                {t("mem.empty.reading")}
              </Btn>
            </div>
          </div>
        )
      ) : null}
      <ListState busy={list.busy} error={list.error} count={list.items ? list.items.length : null} more={!!list.next} onMore={list.more} onRetry={list.retry} empty={false} />
    </>
  );
}

const SEVERITY_TONE: Record<ErrorJournalItem["severity"], "mute" | "warn" | "err"> = { low: "mute", medium: "warn", high: "err" };

/** The error journal (APP-MEM-01): the correction, what it is about, how strong it is now, where it came from. */
function ErrorJournal() {
  const { bff, nav } = useApp();
  const { t, l, fmt } = useI18n();
  const list = usePaged<ErrorJournalItem>((c) => bff.memoryErrors(c), "errors");
  return (
    <>
      {list.items?.length ? (
        <div className="pad">
          <ul className="list" data-testid="err-list">
            {list.items.map((e) => (
              <li key={e.card_id}>
                <button type="button" className="row dict-row" onClick={() => nav.push({ name: "card", id: e.card_id })} data-testid={`err-${e.card_id}`}>
                  <span className="t">
                    <b lang="en">{e.correction}</b>
                    <span>{l(e.explanation)}</span>
                    <span className="pills">
                      <Pill tone={SEVERITY_TONE[e.severity]}>{t(`mem.sev.${e.severity}` as MessageKey)}</Pill>
                      <span className="due">{e.lesson_title ? `${l(e.lesson_title)} · ` : ""}{fmt.date(e.created_at)}</span>
                    </span>
                  </span>
                  <Strength value={e.strength} compact />
                  <Icon name="chevron" size={18} stroke={2} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {list.items && list.items.length === 0 ? (
        <div className="pad">
          <div className="card stack tight" data-testid="err-empty">
            <b className="h3">{t("mem.errors.emptyTitle")}</b>
            <p className="sub">{t("mem.errors.empty")}</p>
          </div>
        </div>
      ) : null}
      <ListState busy={list.busy} error={list.error} count={list.items ? list.items.length : null} more={!!list.next} onMore={list.more} onRetry={list.retry} empty={false} />
    </>
  );
}

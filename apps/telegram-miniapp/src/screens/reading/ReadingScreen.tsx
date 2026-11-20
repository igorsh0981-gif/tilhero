import type { ReadingCard } from "@tilhero/contracts/bff";
import type { Band } from "@tilhero/contracts/content";
import { useState } from "react";
import { pronunciationAccess } from "../../domain/memory";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Pill, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";
import { useStartSession } from "../lessons/startSession";
import { LevelFilter, ListState, usePaged } from "../practice/Practice";
import { ReadingText } from "./ReadingText";

/** The level filter of «Чтение» survives opening a text and coming back. */
const memory: { level: Band | null } = { level: null };

/**
 * «Практика → Чтение» (AT-57): short texts of the learner's audience and level (children — only children's texts, the
 * BFF and lessons narrow the audience), minutes, words, the result of the last questions.
 */
export function ReadingList() {
  const { bff, nav } = useApp();
  const { t, l } = useI18n();
  const [level, setLevelState] = useState<Band | null>(memory.level);
  const setLevel = (b: Band | null) => setLevelState((memory.level = b));
  const list = usePaged<ReadingCard>((c) => bff.readings(level, c), `${level}`);
  return (
    <>
      <div className="pad stack tight">
        <p className="sub">{t("rd.listNote")}</p>
        <div className="filters">
          <LevelFilter value={level} onChange={setLevel} id="flt-rd-level" />
        </div>
      </div>
      {list.items?.length ? (
        <div className="pad stack tight" data-testid="rd-list">
          {list.items.map((r) => (
            <button type="button" key={r.reading_id} className="row boxed" onClick={() => nav.push({ name: "reading", id: r.reading_id })} data-testid={`rd-${r.reading_id}`}>
              <span className="nic"><Icon name="book" size={20} /></span>
              <span className="t">
                <b>{l(r.title)}</b>
                <span>{t("rd.meta", { level: r.level, n: r.est_minutes, w: r.word_count })}</span>
                {r.last_result ? (
                  <span className="pills">
                    <Pill tone="ok" >{t("rd.last", { n: r.last_result.correct, m: r.last_result.total })}</Pill>
                  </span>
                ) : null}
              </span>
              <Icon name="chevron" size={18} stroke={2} />
            </button>
          ))}
        </div>
      ) : null}
      <ListState busy={list.busy} error={list.error} count={list.items ? list.items.length : null} more={!!list.next} onMore={list.more} onRetry={list.retry} empty={t("rd.empty")} />
    </>
  );
}

/** A text: the tappable words, the glossary, «Начать вопросы» → a reading session in the lesson player. */
export function ReadingScreen({ id }: { id: string }) {
  const { bff, nav, session } = useApp();
  const { t, l, tp } = useI18n();
  const r = useLoad(() => bff.reading(id), [id]);
  const ov = useLoad(() => bff.memoryOverview(true).catch(() => null), [session.learner.learner_id]);
  const { start, sheet } = useStartSession();
  const d = r.data;
  const access = pronunciationAccess(ov.data?.pronunciation, session.learner);
  return (
    <>
      <Bar title={t("pr.tab.reading")} onBack={nav.back} plainTitle />
      <main className="scroll" data-testid="reading">
        {r.loading && !d ? (
          <div className="pad"><Skeleton lines={5} /></div>
        ) : r.error && !d ? (
          <div className="pad stack tight">
            <div className="card err"><p className="sub ink">{r.error}</p></div>
            <Btn variant="secondary" onClick={() => void r.reload()}>{t("c.retry")}</Btn>
          </div>
        ) : d ? (
          <div className="pad stack loose">
            <div className="stack tight">
              <div className="cap hrow"><Icon name="book" size={16} />{t("rd.metaShort", { level: d.level, n: d.est_minutes })}</div>
              <h1 className="h1" data-testid="rd-title">{l(d.title)}</h1>
              <p className="sub small">{t("rd.tapHint")}</p>
            </div>
            <ReadingText reading={d} access={access} />
            {d.glossary.length ? (
              <section className="stack tight" aria-labelledby="rd-gl">
                <h2 className="sec" id="rd-gl">{t("rd.glossary")}</h2>
                <ul className="list" data-testid="rd-glossary">
                  {d.glossary.map((g, i) => (
                    <li key={i} className="row">
                      <span className="t">
                        <b lang="en">{g.en}</b>
                        <span>{l(g.gloss)}</span>
                      </span>
                      {g.in_dictionary ? (
                        <span className="v ok"><Icon name="check" size={14} stroke={3} />{t("rd.inDictShort")}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </main>
      {d && d.questions_count > 0 ? (
        <div className="foot" data-testid="rd-questions">
          <ErrorLine text={start.error} />
          <Btn busy={start.busy} onClick={() => void start.run({ kind: "reading", id: d.reading_id })} data-testid="rd-start">
            <Icon name="lessons" size={18} />
            {t("rd.start", { n: d.questions_count, q: tp("rd.questionsWord", d.questions_count) })}
          </Btn>
          <p className="sub small center">{t("rd.startNote")}</p>
        </div>
      ) : null}
      {sheet}
    </>
  );
}

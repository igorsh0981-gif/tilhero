import type { DictionaryCard, DictionaryCardDetail } from "@tilhero/contracts/bff";
import { cardTarget, pronunciationAccess } from "../../domain/memory";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { confirmPopup } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Pill, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { GlossSourceNote, KindPill, SpeakButton, StatusPill, Strength } from "./parts";
import { PronounceBlock } from "./Pronounce";

/**
 * A card of the dictionary (APP-MEM-02, AT-53): the word or phrase with its translation in the interface language,
 * the example, the sound, when it comes back, the last ten reviews; «Знаю это» / «Вернуть в повторение», «Убрать из
 * словаря», «Произнести». An error card shows the correction, the explanation and your fragment (erased after 90 days).
 */
export function CardScreen({ id }: { id: string }) {
  const { bff, nav, session } = useApp();
  const { t } = useI18n();
  const card = useLoad(() => bff.memoryCard(id), [id]);
  const overview = useLoad(() => bff.memoryOverview(true).catch(() => null), [session.learner.learner_id]);
  const c = card.data;
  const merge = (x: DictionaryCard) => card.setData(card.data ? { ...card.data, ...x } : card.data);

  const known = useAction(async (on: boolean) => {
    merge(on ? await bff.markKnown(id) : await bff.unmarkKnown(id));
    // the server sets the next review; the details (next_review_in_days) are re-read
    void card.reload();
    showToast(on ? t("cd.knownDone") : t("cd.backDone"));
  });
  const remove = useAction(async () => {
    const ok = await confirmPopup({ title: t("cd.removeQ"), message: t("cd.removeText"), ok: t("cd.remove"), cancel: t("c.cancel"), destructive: true });
    if (!ok) return;
    await bff.removeCard(id);
    showToast(t("cd.removed"));
    nav.back();
  });

  return (
    <>
      <Bar title={t("tab.review")} onBack={nav.back} plainTitle />
      <main className="scroll" data-testid="card">
        {card.loading && !c ? (
          <div className="pad"><Skeleton lines={4} /></div>
        ) : card.error && !c ? (
          <div className="pad stack tight">
            <div className="card err"><p className="sub ink">{card.error}</p></div>
            <Btn variant="secondary" onClick={() => void card.reload()}>{t("c.retry")}</Btn>
          </div>
        ) : c ? (
          <CardBody c={c} access={pronunciationAccess(overview.data?.pronunciation, session.learner)} />
        ) : null}
      </main>
      {c ? (
        <div className="foot cd-foot">
          <ErrorLine text={known.error ?? remove.error} />
          <div className="duo">
            {c.status === "known" ? (
              <Btn variant="secondary" busy={known.busy} onClick={() => void known.run(false)} data-testid="cd-unknown">
                <Icon name="review" size={18} />
                {t("cd.back")}
              </Btn>
            ) : (
              <Btn variant="secondary" busy={known.busy} disabled={c.status === "frozen"} onClick={() => void known.run(true)} data-testid="cd-known">
                <Icon name="check" size={18} />
                {t("cd.known")}
              </Btn>
            )}
            <Btn variant="dangerOutline" busy={remove.busy} onClick={() => void remove.run()} data-testid="cd-remove">
              <Icon name="trash" size={18} />
              {t("cd.remove")}
            </Btn>
          </div>
        </div>
      ) : null}
    </>
  );
}

function CardBody({ c, access }: { c: DictionaryCardDetail; access: ReturnType<typeof pronunciationAccess> }) {
  const { session } = useApp();
  const { t, l, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const when =
    c.status === "known"
      ? t("cd.when.known")
      : c.status === "frozen"
        ? t("cd.when.frozen")
        : c.next_review_in_days === null
          ? t("cd.when.new")
          : c.next_review_in_days <= 0
            ? t("cd.when.today")
            : t("cd.when.in", { n: c.next_review_in_days });
  return (
    <div className="pad stack loose">
      <div className="stack tight">
        <div className="pills">
          <KindPill kind={c.kind} />
          <StatusPill status={c.status} />
        </div>
        <h1 className="h1 cd-en" lang="en" data-testid="cd-text">{c.text_en}</h1>
        <p className="cd-gloss" data-testid="cd-gloss">{l(c.gloss)}</p>
        <GlossSourceNote source={c.gloss_source} />
        <div className="hrow between">
          <SpeakButton text={c.text_en} kid={kid} testId="cd-listen" />
          <Strength value={c.strength} />
        </div>
      </div>

      {c.error ? (
        <section className="card fix-card" aria-labelledby="cd-err" data-testid="cd-error">
          <h2 className="sec" id="cd-err">{t("cd.error.title")}</h2>
          <p className="sub ink">{l(c.error.explanation)}</p>
          {c.error.evidence ? (
            <>
              <span className="sub small">{t("sm.yours")}</span>
              <span className="was" lang="en" data-testid="cd-evidence">{c.error.evidence}</span>
            </>
          ) : (
            <span className="sub small" data-testid="cd-evidence-gone">{t("cd.error.erased")}</span>
          )}
          <span className="sub small">{t("cd.error.right")}</span>
          <span className="now" lang="en">{c.error.correction}</span>
        </section>
      ) : null}

      {c.example_en ? (
        <section className="stack tight" aria-labelledby="cd-ex">
          <h2 className="sec" id="cd-ex">{t("cd.example")}</h2>
          <div className="card hrow between">
            <p className="line-en" lang="en" data-testid="cd-example">{c.example_en}</p>
            <SpeakButton text={c.example_en} kid={kid} label={t("cd.listenExample")} testId="cd-listen-ex" />
          </div>
        </section>
      ) : null}

      <div className="card stack tight" data-testid="cd-when">
        <p className="h3 ic-line"><Icon name="clock" size={18} />{when}</p>
        {c.last_reviewed_at ? <p className="sub small">{t("cd.lastReviewed", { date: fmt.date(c.last_reviewed_at) })}</p> : null}
      </div>

      {access !== "hidden" || c.last_pronunciation ? (
      <section className="stack tight" aria-labelledby="cd-pron">
        <h2 className="sec" id="cd-pron">{t("pn.title")}</h2>
        {c.last_pronunciation ? (
          <p className="sub small" data-testid="cd-last-pron">
            {t("cd.lastPron", { date: fmt.date(c.last_pronunciation.at) })}
            {c.last_pronunciation.intelligibility ? ` · ${t(`pn.intel.${c.last_pronunciation.intelligibility}` as MessageKey)}` : ""}
          </p>
        ) : null}
        <PronounceBlock access={access} target={cardTarget(c.card_id)} text={c.kind === "error" && c.error ? c.error.correction : c.text_en} testId="cd-pron" />
      </section>
      ) : null}

      <section className="stack tight" aria-labelledby="cd-hist">
        <h2 className="sec" id="cd-hist">{t("cd.history")}</h2>
        {c.history.length ? (
          <ul className="list" data-testid="cd-history">
            {c.history.map((h, i) => (
              <li key={i} className="row">
                <span className={`mk ${h.grade === "again" ? "no" : "ok"}`} aria-hidden="true">{h.grade === "again" ? "↺" : h.grade ? "✓" : "•"}</span>
                <span className="t">
                  <b>{h.grade ? t(`cd.grade.${h.grade}${kid ? ".kid" : ""}` as MessageKey) : t("cd.grade.none")}</b>
                  <span>{t(`cd.mode.${h.mode}` as MessageKey)} · {fmt.dateTime(h.at)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sub" data-testid="cd-history-empty">{t("cd.historyEmpty")}</p>
        )}
      </section>

      {c.sources.length ? (
        <section className="stack tight" aria-labelledby="cd-src">
          <h2 className="sec" id="cd-src">{t("cd.sources")}</h2>
          <ul className="list" data-testid="cd-sources">
            {c.sources.map((s, i) => (
              <li key={i} className="row">
                <span className="t">
                  <b>{s.title ? l(s.title) : t("cd.sourceGone")}</b>
                  <span>{t(`cd.src.${s.kind}` as MessageKey)} · {fmt.date(s.at)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {c.status === "frozen" ? <Pill tone="warn">{t("cd.frozenNote")}</Pill> : null}
    </div>
  );
}

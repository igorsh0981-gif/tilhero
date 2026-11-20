/**
 * «Герои» (sprint 6, ADM-GAME-03 TilHero = ADM-GAME-04 LinguaFlow «Каталог героев», AT-65, AT-71): 9 heroes in three
 * lines (robots, dragons, pupils), 3 stages each with their pictures, the number of learners with the hero. A hero
 * card (#/heroes/<code>): the draft — name and tagline RU/UZ, audiences (none = hidden from the choice, the learners who
 * chose him keep him), the name and the picture of every stage (upload a new one or pick an uploaded one) — saved by
 * game.manage; the live ↔ draft comparison; publication by game.publish with step-up and a comment ≥ 10: the draft
 * becomes the live version without a release of the Mini App. 409 HERO_IN_USE {learners} — the hero is chosen and
 * cannot be taken off; hiding him from the choice is allowed.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminGameImage, AdminHero } from "@tilhero/contracts/admin";
import type { HeroLine } from "@tilhero/contracts/bff";
import { Game } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, Pill, Spinner, TabPanel, Tabs } from "../../ui/kit";
import { ConfirmCommand, Drawer } from "../../ui/overlays";
import { errText } from "../../ui/errors";
import { useToast } from "../../ui/toasts";
import { CommandKey } from "../memory/model";
import { AudiencePicker, AudiencePills, GameImg, ImagePicker, ImageUpload, IssueMsg, LocFields } from "./parts";
import { checkHero, COMMENT_MAX, COMMENT_MIN, HERO_CODE_RE, HERO_LINES, HERO_STAGES, heroBody, heroDiff, heroForm, heroGate, issuesAt, liveForm, NAME_MAX, parseItemRoute, sameHero, TAGLINE_MAX, type HeroForm } from "./model";

export function HeroesPage({ routeId }: { routeId: string | null }) {
  const { t } = useI18n();
  const { navigate } = useNav();
  const [heroes, setHeroes] = useState<AdminHero[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const open = parseItemRoute(routeId, HERO_CODE_RE);
  const load = useCallback(async () => {
    try {
      const r = await Game.heroes();
      setHeroes(r.items);
      setError(null);
      return r.items;
    } catch (e) {
      setError(e);
      return null;
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const hero = heroes?.find((h) => h.code === open) ?? null;
  return (
    <div className="stack" data-testid="heroes">
      <Callout kind="info" icon="image" testId="hr-note">
        {t("hr.note")}
      </Callout>
      {error && !heroes ? (
        <LoadError error={error} onRetry={() => void load()} />
      ) : !heroes ? (
        <Spinner label={t("common.loading")} />
      ) : !heroes.length ? (
        <Empty icon="hero" title={t("hr.none")} text={t("hr.noneM")} />
      ) : (
        HERO_LINES.map((line) => <LineSection key={line} line={line} heroes={heroes.filter((h) => h.line === line).sort((a, b) => a.order - b.order)} onOpen={(c) => navigate("heroes", c)} />)
      )}
      {open && heroes && !hero && <Callout kind="warn" icon="alert">{t("err.HERO_NOT_FOUND")}</Callout>}
      {hero && heroes && <HeroDrawer key={hero.code} hero={hero} all={heroes} onClose={() => navigate("heroes")} onSaved={(h) => setHeroes((xs) => (xs ? xs.map((x) => (x.code === h.code ? h : x)) : xs))} />}
    </div>
  );
}

function LineSection({ line, heroes, onOpen }: { line: HeroLine; heroes: AdminHero[]; onOpen: (code: string) => void }) {
  const { t, fmt, tp } = useI18n();
  return (
    <section className="panel" aria-labelledby={`hr-l-${line}`} data-testid={`hr-line-${line}`}>
      <div className="panel-h">
        <h2 className="panel-t grow" id={`hr-l-${line}`}>
          <Icon name="hero" /> {t(`hr.line.${line}` as MessageKey)}
        </h2>
        <span className="xs muted">{t(`hr.stages.${line}` as MessageKey)}</span>
      </div>
      <div className="hero-grid">
        {heroes.map((h) => (
          <article key={h.code} className="hero-card" aria-labelledby={`hr-n-${h.code}`} data-testid={`hero-${h.code}`}>
            <div className="hero-stages">
              {HERO_STAGES.map((s) => {
                const img = h.images.find((x) => x.stage === s)?.image ?? null;
                const name = h.stages.find((x) => x.stage === s)?.name.ru ?? "";
                return (
                  <figure key={s} className="hero-stage">
                    <GameImg img={img} alt={t("hr.imgAlt", { hero: h.name.ru, s, stage: name })} size={84} testId={`hero-${h.code}-img-${s}`} />
                    <figcaption className="xs muted">{t("hr.stageN", { n: s })}</figcaption>
                  </figure>
                );
              })}
            </div>
            <div className="hero-meta">
              <h3 className="h3" id={`hr-n-${h.code}`} lang="ru">
                {h.name.ru}
              </h3>
              <span className="mono xs muted">{h.code}</span>
            </div>
            <p className="small muted hero-tag" lang="ru">
              {h.tagline.ru}
            </p>
            <div className="row xs-gap">
              <AudiencePills value={h.audiences} />
            </div>
            <div className="row xs-gap">
              <Pill tone="neutral" dot={false}>
                v{h.version}
              </Pill>
              {h.draft && <Pill tone="info" testId={`hero-${h.code}-draft`}>{t("hr.hasDraft")}</Pill>}
              <span className="xs muted" data-testid={`hero-${h.code}-learners`}>
                <Icon name="users" /> {tp("hr.learnersN", h.learners).replace(String(h.learners), fmt.num(h.learners))}
              </span>
            </div>
            <Btn size="sm" icon="edit" label={t("common.open")} aria={t("common.openRow", { x: h.name.ru })} onClick={() => onOpen(h.code)} testId={`hero-open-${h.code}`} />
          </article>
        ))}
      </div>
    </section>
  );
}

type HeroTab = "draft" | "compare";

function HeroDrawer({ hero, all, onClose, onSaved }: { hero: AdminHero; all: AdminHero[]; onClose: () => void; onSaved: (h: AdminHero) => void }) {
  const i18n = useI18n();
  const { t, fmt, tp } = i18n;
  const { can } = useSession();
  const toast = useToast();
  const manage = can("game.manage");
  const publish = can("game.publish");
  const [h, setH] = useState(hero);
  const [form, setForm] = useState<HeroForm>(() => heroForm(hero));
  const [base, setBase] = useState<HeroForm>(() => heroForm(hero));
  const [tab, setTab] = useState<HeroTab>(manage ? "draft" : "compare");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [ask, setAsk] = useState(false);
  const [extra, setExtra] = useState<AdminGameImage[]>([]);
  const [pubKey] = useState(() => new CommandKey(uuid));

  // every hero picture the section knows: live and draft of all heroes + uploaded here
  const known = useMemo(() => {
    const m = new Map<string, AdminGameImage>();
    for (const x of all) for (const im of [...x.images, ...(x.draft?.images ?? [])]) m.set(im.image.asset_id, im.image);
    for (const im of [...h.images, ...(h.draft?.images ?? [])]) m.set(im.image.asset_id, im.image);
    for (const im of extra) m.set(im.asset_id, im);
    return m;
  }, [all, h, extra]);
  const owner = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of all) for (const im of x.images) if (!m.has(im.image.asset_id)) m.set(im.image.asset_id, `${x.code} · ${t("hr.stageN", { n: im.stage })}`);
    return m;
  }, [all, t]);

  const issues = checkHero(form);
  const shown = tried ? issues : issues.filter((x) => x.code !== "required");
  const dirty = !sameHero(form, base);
  const gate = heroGate(h, dirty, issues.length);
  const live = liveForm(h);
  const stageImg = (assetId: string) => known.get(assetId) ?? null;

  const save = async () => {
    if (busy) return;
    setTried(true);
    if (issues.length) {
      setErr(t("gm.fixErrors", { n: issues.length }));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const x = await Game.saveHero(h.code, heroBody(form));
      setH(x);
      const f = heroForm(x);
      setForm(f);
      setBase(f);
      setTried(false);
      onSaved(x);
      toast(t("hr.saved"), "ok", "game.hero_draft_saved");
    } catch (e) {
      setErr(errText(i18n, e));
    } finally {
      setBusy(false);
    }
  };

  const setStage = (i: number, patch: Partial<HeroForm["stages"][number]>) => setForm((f) => ({ ...f, stages: f.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const hiddenWithLearners = !form.audiences.length && h.learners > 0;

  return (
    <Drawer
      wide
      testId="hero-card"
      onClose={onClose}
      title={
        <>
          <span lang="ru">{h.name.ru}</span> <span className="mono small muted">{h.code}</span>
        </>
      }
      sub={
        <>
          <span>{t(`hr.line.${h.line}` as MessageKey)}</span>
          <Pill tone="neutral" dot={false}>
            v{h.version}
          </Pill>
          {h.published_at && <span>{t("hr.publishedX", { t: fmt.dateTime(h.published_at), n: h.published_by?.name ?? "—" })}</span>}
          <Pill tone={h.learners ? "accent" : "neutral"} testId="hero-learners">
            {tp("hr.learnersN", h.learners).replace(String(h.learners), fmt.num(h.learners))}
          </Pill>
          {h.draft && <Pill tone="info">{t("hr.hasDraft")}</Pill>}
          {dirty && <Pill tone="warn">{t("ct.unsaved")}</Pill>}
        </>
      }
      tabs={
        <Tabs<HeroTab>
          id="hrd"
          label={t("hr.tabs")}
          className="drawer-tabs"
          value={tab}
          onChange={setTab}
          items={[
            { v: "draft", label: t("hr.tab.draft"), icon: "edit", testId: "hrd-tab-draft" },
            { v: "compare", label: t("hr.tab.compare"), icon: "diff", testId: "hrd-tab-compare" },
          ]}
        />
      }
      footer={
        <>
          <span className="xs muted grow row" data-testid="hr-gate" data-gate={gate ?? "ok"}>
            {gate && publish ? (
              <>
                <Icon name="info" /> {t(`hr.gate.${gate}` as MessageKey)}
              </>
            ) : !manage || !publish ? (
              <>
                <Icon name="lock" /> {!manage ? t("gm.noManage") : t("gm.noPublish")}
              </>
            ) : null}
          </span>
          {manage && <Btn label={t("hr.saveDraft")} icon="check" kind={dirty ? "primary" : ""} disabled={!dirty} busy={busy} onClick={() => void save()} testId="hr-save" />}
          {publish && <Btn label={t("hr.publish")} icon="send" kind={!gate ? "primary" : ""} disabled={!!gate} title={gate ? t(`hr.gate.${gate}` as MessageKey) : undefined} onClick={() => setAsk(true)} testId="hr-publish" />}
        </>
      }
    >
      <TabPanel id="hrd" value={tab}>
        {tab === "draft" ? (
          <div className="stack" data-testid="hr-editor">
            {!manage && (
              <Callout icon="lock" testId="hr-ro">
                {t("gm.roManage")}
              </Callout>
            )}
            {!h.draft && manage && (
              <Callout icon="info" testId="hr-no-draft">
                {t("hr.noDraftYet")}
              </Callout>
            )}
            {err && (
              <Callout kind="bad" icon="alertCircle" testId="hr-err">
                {err}
              </Callout>
            )}
            <LocFields prefix="hr" path="name" label={t("hr.f.name")} value={form.name} onChange={(v) => setForm({ ...form, name: v })} max={NAME_MAX} issues={shown} disabled={!manage} testId="hr-name" />
            <LocFields prefix="hr" path="tagline" label={t("hr.f.tagline")} value={form.tagline} onChange={(v) => setForm({ ...form, tagline: v })} max={TAGLINE_MAX} issues={shown} disabled={!manage} area testId="hr-tagline" />
            <AudiencePicker
              id="hr-aud"
              value={form.audiences}
              onChange={(a) => setForm({ ...form, audiences: a })}
              disabled={!manage}
              hint={hiddenWithLearners ? <span className="warn-ink b" data-testid="hr-hidden-note">{t("hr.hiddenNote", { n: h.learners })}</span> : t("hr.audHint")}
            />
            <section aria-labelledby="hr-st-h" className="stack sm">
              <h3 className="h3" id="hr-st-h">
                {t("hr.stagesT")}
              </h3>
              <p className="xs muted">{t("hr.stagesNote")}</p>
              <div className="hero-edit-stages">
                {form.stages.map((s, i) => {
                  const img = stageImg(s.asset_id);
                  const liveId = live.stages[i]?.asset_id ?? "";
                  const changed = s.asset_id !== liveId;
                  return (
                    <div key={s.stage} className="hero-edit-stage" data-testid={`hr-stage-${s.stage}`} data-asset={s.asset_id}>
                      <div className="row between">
                        <b>{t("hr.stageN", { n: s.stage })}</b>
                        {changed && <Pill tone="info" testId={`hr-stage-${s.stage}-changed`}>{t("hr.imgChanged")}</Pill>}
                      </div>
                      <GameImg img={img} alt={t("hr.imgAlt", { hero: form.name.ru, s: s.stage, stage: s.name.ru })} size={150} testId={`hr-stage-${s.stage}-img`} />
                      <IssueMsg issues={issuesAt(shown, `stages[${i}].asset_id`)} />
                      {manage && (
                        <div className="acts">
                          <ImageUpload purpose="hero_stage" aria={t("hr.uploadStage", { n: s.stage })} testId={`hr-upload-${s.stage}`} onDone={(im) => (setExtra((xs) => [...xs, im]), setStage(i, { asset_id: im.asset_id }))} />
                          <Btn size="sm" icon="image" label={t("gm.pick")} aria={t("hr.pickStage", { n: s.stage })} onClick={() => setPick(i)} testId={`hr-pick-${s.stage}`} />
                          {changed && liveId && <Btn size="sm" kind="ghost" icon="rollback" label={t("hr.backToLive")} aria={t("hr.backToLiveN", { n: s.stage })} onClick={() => setStage(i, { asset_id: liveId })} testId={`hr-live-${s.stage}`} />}
                        </div>
                      )}
                      <LocFields prefix="hr" path={`stages[${i}].name`} label={t("hr.f.stageName")} value={s.name} onChange={(v) => setStage(i, { name: v })} max={NAME_MAX} issues={shown} disabled={!manage} testId={`hr-stage-${s.stage}-name`} />
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        ) : (
          <Compare live={live} draft={h.draft ? heroForm(h) : null} unsaved={dirty ? form : null} img={stageImg} />
        )}
      </TabPanel>
      {pick != null && (
        <ImagePicker
          title={t("hr.pickT", { n: pick + 1 })}
          images={[...known.values()]}
          current={form.stages[pick]?.asset_id ?? null}
          labelOf={(im) => owner.get(im.asset_id) ?? t("gm.uploadedHere")}
          onClose={() => setPick(null)}
          onPick={(im) => {
            setStage(pick, { asset_id: im.asset_id });
            setPick(null);
          }}
          testId="hr-picker"
        />
      )}
      {ask && (
        <ConfirmCommand
          title={t("hr.publishT", { n: h.name.ru })}
          text={t("hr.publishM", { v: h.version + 1 })}
          icon="send"
          ok={t("hr.publish")}
          minReason={COMMENT_MIN}
          maxReason={COMMENT_MAX}
          reasonLabel={t("gm.comment")}
          reasonPlaceholder={t("gm.commentPh")}
          testId="hr-publish-dialog"
          extra={
            <>
              {h.draft && !h.draft.audiences.length && h.learners > 0 && (
                <Callout kind="warn" icon="alert" testId="hr-publish-hidden">
                  {t("hr.hiddenNote", { n: h.learners })}
                </Callout>
              )}
              <Callout kind="info" icon="smartphoneKey">
                {t("ct.stepUpNote")}
              </Callout>
            </>
          }
          onClose={() => setAsk(false)}
          onConfirm={async (comment) => {
            const key = pubKey.for(JSON.stringify([h.code, h.draft?.updated_at, comment]));
            try {
              const x = await Game.publishHero(h.code, comment, key);
              pubKey.settle();
              setH(x);
              const f = heroForm(x);
              setForm(f);
              setBase(f);
              onSaved(x);
              toast(t("hr.published", { n: x.name.ru, v: x.version }), "ok", "game.hero_published");
              return null;
            } catch (e) {
              pubKey.settle(e);
              if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
              if (e instanceof ApiError && e.code === "HERO_IN_USE") return t("err.HERO_IN_USE", { learners: e.num("learners") ?? h.learners });
              return errText(i18n, e);
            }
          }}
        />
      )}
    </Drawer>
  );
}

/** Live ↔ draft (and the unsaved edits): texts, audiences, names and pictures of the stages. */
function Compare({ live, draft, unsaved, img }: { live: HeroForm; draft: HeroForm | null; unsaved: HeroForm | null; img: (id: string) => AdminGameImage | null }) {
  const { t } = useI18n();
  const other = unsaved ?? draft;
  if (!other)
    return (
      <Callout icon="info" testId="hr-cmp-none">
        {t("hr.cmpNone")}
      </Callout>
    );
  const rows = heroDiff(live, other).filter((r) => !r.key.endsWith(".asset_id"));
  const label = (k: string) => {
    const m = /^stages\[(\d)\]\.name\.(ru|uz)$/.exec(k);
    if (m) return `${t("hr.stageN", { n: Number(m[1]) + 1 })} · ${t("hr.f.stageName")} · ${m[2]!.toUpperCase()}`;
    const [f, l] = k.split(".");
    return f === "audiences" ? t("gm.audiences") : `${t(f === "name" ? "hr.f.name" : "hr.f.tagline")} · ${l!.toUpperCase()}`;
  };
  const aud = (s: string) => (s ? s.split(",").map((a) => t(`gm.aud.${a}` as MessageKey)).join(", ") : t("gm.audNone"));
  const changes = heroDiff(live, other).filter((r) => r.changed).length;
  return (
    <div className="stack" data-testid="hr-compare">
      <Callout icon="diff">{unsaved ? t("hr.cmpUnsaved", { n: changes }) : t("hr.cmpDraft", { n: changes })}</Callout>
      <div className="hero-cmp-imgs" role="table" aria-label={t("hr.cmpImgs")}>
        {HERO_STAGES.map((s, i) => {
          const a = live.stages[i]?.asset_id ?? "";
          const b = other.stages[i]?.asset_id ?? "";
          return (
            <div key={s} className={cx("hero-cmp-stage", a !== b && "is-changed")} role="row" data-testid={`hr-cmp-stage-${s}`} data-changed={String(a !== b)}>
              <b role="rowheader">{t("hr.stageN", { n: s })}</b>
              <span role="cell" className="hero-cmp-cell">
                <span className="xs muted">{t("hr.live")}</span>
                <GameImg img={img(a)} alt={t("hr.liveImg", { n: s })} size={110} />
              </span>
              <Icon name="right" />
              <span role="cell" className="hero-cmp-cell">
                <span className="xs muted">{unsaved ? t("hr.unsaved") : t("hr.draft")}</span>
                <GameImg img={img(b)} alt={t("hr.draftImg", { n: s })} size={110} />
              </span>
              {a !== b && <Pill tone="info">{t("hr.imgChanged")}</Pill>}
            </div>
          );
        })}
      </div>
      <div className="table-wrap">
        <table className="tbl dense" data-testid="hr-cmp-table">
          <caption className="sr-only">{t("hr.tab.compare")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("hr.col.field")}</th>
              <th scope="col">{t("hr.live")}</th>
              <th scope="col">{unsaved ? t("hr.unsaved") : t("hr.draft")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={cx(r.changed && "is-changed")} data-changed={String(r.changed)}>
                <th scope="row">{label(r.key)}</th>
                <td className="small">{r.key === "audiences" ? aud(r.from) : r.from || "—"}</td>
                <td className="small">
                  {r.key === "audiences" ? aud(r.to) : r.to || "—"}
                  {r.changed && (
                    <span className="pill info ml-6">
                      <Icon name="edit" /> {t("ag.diff.changed")}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

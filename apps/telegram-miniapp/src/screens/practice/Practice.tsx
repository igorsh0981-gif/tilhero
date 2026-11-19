import type { MediaCard, Page, ScenarioCard } from "@tilhero/contracts/bff";
import type { Band, GoalCode, MediaType } from "@tilhero/contracts/content";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import type { PracticeTab } from "../../state/nav";
import { Icon, type IconName } from "../../ui/Icon";
import { Btn, Chip, ErrorLine, NavRow, Pill, Seg, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";

const GOALS: readonly GoalCode[] = ["work", "career", "travel", "daily", "study", "exam"];
const LEVELS: readonly Band[] = ["A0", "A1", "A2", "B1", "B2"];
const TYPES: readonly MediaType[] = ["own_scene", "dialogue", "song", "movie", "interview"];
export const MEDIA_ICON: Record<MediaType, IconName> = { own_scene: "chat", dialogue: "chat", song: "music", movie: "film", interview: "mic" };

/** Tab and filters survive opening a card and coming back (the stack unmounts this screen) — for the app session. */
const memory: { tab: PracticeTab; goal: GoalCode | null; scLevel: Band | null; type: MediaType | null; mdLevel: Band | null } = {
  tab: "scenarios",
  goal: null,
  scLevel: null,
  type: null,
  mdLevel: null,
};

/** A paged list that restarts when the filters change; «Показать ещё» appends the next page. */
function usePaged<T>(load: (cursor: string | null) => Promise<Page<T>>, key: string) {
  const { t, fmt } = useI18n();
  const [items, setItems] = useState<T[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const latest = useRef(load);
  latest.current = load;
  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const my = ++seq.current;
      setBusy(true);
      setError(null);
      try {
        const p = await latest.current(cursor);
        if (my !== seq.current) return;
        setItems((prev) => (cursor && prev ? [...prev, ...p.items] : p.items));
        setNext(p.next_cursor);
      } catch (e) {
        if (my === seq.current) setError(errorText(e, t, fmt.mmss));
      } finally {
        if (my === seq.current) setBusy(false);
      }
    },
    [t, fmt],
  );
  useEffect(() => {
    setItems(null);
    void fetchPage(null);
  }, [key, fetchPage]);
  return { items, next, busy, error, more: () => void fetchPage(next), retry: () => void fetchPage(null) };
}

/**
 * Practice (APP-PLAN-04, APP-MEDIA-01): the catalogue of conversation scenarios (goal and level filters) and the media
 * library (type and level filters), the request for a song or a film. A child profile sees only children's content
 * (the BFF passes audience=kids) and no external links anywhere.
 */
export function Practice({ tab: initial }: { tab?: PracticeTab }) {
  const { nav } = useApp();
  const { t } = useI18n();
  const [tab, setTabState] = useState<PracticeTab>(initial ?? memory.tab);
  const setTab = (x: PracticeTab) => {
    memory.tab = x;
    setTabState(x);
  };
  useEffect(() => {
    if (initial) {
      memory.tab = initial;
      setTabState(initial);
    }
  }, [initial]);
  return (
    <>
      <Bar title={t("pr.title")} onBack={nav.back} />
      <main className="scroll" data-testid="practice">
        <div className="stack loose">
          <div className="pad">
            <Seg
              label={t("pr.tabs")}
              value={tab}
              onChange={setTab}
              options={[
                { value: "scenarios", label: t("pr.tab.scenarios") },
                { value: "media", label: t("pr.tab.media") },
              ]}
              testId="pr-tabs"
            />
          </div>
          {tab === "scenarios" ? <Scenarios /> : <Media />}
        </div>
      </main>
    </>
  );
}

function LevelFilter({ value, onChange, id }: { value: Band | null; onChange: (b: Band | null) => void; id: string }) {
  const { t } = useI18n();
  return (
    <div className="stack tight">
      <p className="lb" id={`${id}-l`}>{t("pr.filterLevel")}</p>
      <div className="chips x" role="group" aria-labelledby={`${id}-l`} data-testid={id}>
        <Chip on={value === null} label={t("pr.all")} onClick={() => onChange(null)} />
        {LEVELS.map((b) => (
          <Chip key={b} on={value === b} label={b} ariaLabel={`${b} — ${t(`band.${b}` as MessageKey)}`} onClick={() => onChange(value === b ? null : b)} />
        ))}
      </div>
    </div>
  );
}

function ListState(props: { busy: boolean; error: string | null; count: number | null; more: boolean; onMore: () => void; onRetry: () => void }) {
  const { t } = useI18n();
  if (props.count === null && props.busy) return <div className="pad"><Skeleton lines={3} /></div>;
  if (props.error && props.count === null) {
    return (
      <div className="pad stack tight">
        <ErrorLine text={props.error} />
        <Btn variant="secondary" onClick={props.onRetry}>{t("c.retry")}</Btn>
      </div>
    );
  }
  return (
    <div className="pad stack tight">
      {props.count === 0 ? <p className="sub" data-testid="pr-empty">{t("pr.empty")}</p> : null}
      <ErrorLine text={props.count !== null ? props.error : null} />
      {props.more ? (
        <Btn variant="secondary" busy={props.busy} onClick={props.onMore}>{t("c.more")}</Btn>
      ) : null}
    </div>
  );
}

function Scenarios() {
  const { bff, nav } = useApp();
  const { t, l } = useI18n();
  const [goal, setGoalState] = useState<GoalCode | null>(memory.goal);
  const [level, setLevelState] = useState<Band | null>(memory.scLevel);
  const setGoal = (g: GoalCode | null) => setGoalState((memory.goal = g));
  const setLevel = (b: Band | null) => setLevelState((memory.scLevel = b));
  const list = usePaged<ScenarioCard>((c) => bff.scenarios({ goal, level }, c), `${goal}|${level}`);
  return (
    <>
      <div className="pad stack tight">
        <p className="sub">{t("pr.scenariosNote")}</p>
        <div className="filters">
          <p className="lb" id="flt-goal-l">{t("pr.filterGoal")}</p>
          <div className="chips x" role="group" aria-labelledby="flt-goal-l" data-testid="flt-goal">
            <Chip on={goal === null} label={t("pr.all")} onClick={() => setGoal(null)} />
            {GOALS.map((g) => (
              <Chip key={g} on={goal === g} label={t(`goal.${g}` as MessageKey)} onClick={() => setGoal(goal === g ? null : g)} />
            ))}
          </div>
          <LevelFilter value={level} onChange={setLevel} id="flt-sc-level" />
        </div>
      </div>
      {list.items?.length ? (
        <div className="pad stack tight" data-testid="sc-list">
          {list.items.map((s) => (
            <button type="button" key={s.scenario_id} className="card stack tight" onClick={() => nav.push({ name: "scenario", id: s.scenario_id })} data-testid={`sc-${s.scenario_id}`}>
              <span className="cap">{t("sc.meta", { level: s.level, n: s.difficulty })}</span>
              <b className="h3">{l(s.title)}</b>
              <span className="sub">{l(s.task)}</span>
              <span className="sub small">{s.characters.map((c) => `${c.name} — ${l(c.role)}`).join(", ")}</span>
              <span className="pills">
                {s.goals.map((g) => (
                  <Pill key={g} tone="mute">{t(`goal.${g}` as MessageKey)}</Pill>
                ))}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <ListState busy={list.busy} error={list.error} count={list.items ? list.items.length : null} more={!!list.next} onMore={list.more} onRetry={list.retry} />
    </>
  );
}

function Media() {
  const { bff, nav, session } = useApp();
  const { t, l } = useI18n();
  const [type, setTypeState] = useState<MediaType | null>(memory.type);
  const [level, setLevelState] = useState<Band | null>(memory.mdLevel);
  const setType = (x: MediaType | null) => setTypeState((memory.type = x));
  const setLevel = (b: Band | null) => setLevelState((memory.mdLevel = b));
  const list = usePaged<MediaCard>((c) => bff.media({ type, level }, c), `${type}|${level}`);
  const kid = session.learner.kind === "child";
  return (
    <>
      <div className="pad stack tight">
        <p className="sub">{t("pr.mediaNote")}</p>
        <div className="filters">
          <p className="lb" id="flt-type-l">{t("pr.filterType")}</p>
          <div className="chips x" role="group" aria-labelledby="flt-type-l" data-testid="flt-type">
            <Chip on={type === null} label={t("pr.all")} onClick={() => setType(null)} />
            {TYPES.map((x) => (
              <Chip key={x} on={type === x} label={t(`md.type.${x}` as MessageKey)} onClick={() => setType(type === x ? null : x)} />
            ))}
          </div>
          <LevelFilter value={level} onChange={setLevel} id="flt-md-level" />
        </div>
      </div>
      {list.items?.length ? (
        <div className="pad stack tight" data-testid="md-list">
          {list.items.map((m) => (
            <button type="button" key={m.asset_id} className="row boxed" onClick={() => nav.push({ name: "mediaItem", id: m.asset_id })} data-testid={`md-${m.asset_id}`}>
              <span className="nic"><Icon name={MEDIA_ICON[m.type]} size={20} /></span>
              <span className="t">
                <b>{l(m.title)}</b>
                <span>
                  {t(`md.type.${m.type}` as MessageKey)} · {m.level} · {t("md.duration", { n: Math.round(m.duration_s) })} · {m.source_label}
                </span>
              </span>
              <Icon name="chevron" size={18} stroke={2} />
            </button>
          ))}
        </div>
      ) : null}
      <ListState busy={list.busy} error={list.error} count={list.items ? list.items.length : null} more={!!list.next} onMore={list.more} onRetry={list.retry} />
      <div className="pad">
        <div className="list">
          <NavRow title={t("pr.wantSong")} note={kid ? t("mr.kids.title") : t("pr.wantSongNote")} icon="music" onClick={() => nav.push({ name: "mediaRequests" })} testId="pr-want-song" />
        </div>
      </div>
    </>
  );
}

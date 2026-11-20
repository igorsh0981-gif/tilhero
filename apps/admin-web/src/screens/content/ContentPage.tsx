/**
 * «Контент» (content.read; sprint 3, ADM-CONT-01…06, ADM-MEDIA-01…04): tabs «Курс», «Уроки», «Сценарии», «Рубрики»,
 * «Медиа» (materials and their exercises), «Заявки учеников», «Проверка» (content.review), «Диагностика». Routes:
 * #/content/<tab>[/<key>] · #/content/review/<kind>/<key> · #/content/requests/<id> · #/content/diagnostics/<test>/<v>.
 * Sprint 5: «Чтение» (#/content/readings[/<key>]) and «Словарь курса» (#/content/glossary[/queue][/<entry_id>]).
 * Each list opens the entity in the shared Workspace (versions and the life cycle); every command is re-checked by
 * admin-bff and the catalog.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContentRow, Permission } from "@tilhero/contracts/admin";
import type { Band, ContentKind, VersionStatus } from "@tilhero/contracts/content";
import { Content } from "../../api/endpoints";
import { useI18n, type MessageKey } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon, type IconName } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, cx, Empty, Pill, Seg, Select, Spinner, TabPanel, Tabs } from "../../ui/kit";
import { Drawer } from "../../ui/overlays";
import { DiagnosticsTab } from "./DiagnosticsTab";
import { GlossaryTab } from "./GlossaryTab";
import { BANDS, prereqCycle, STATUSES } from "./model";
import { RefsProvider, useRefs } from "./refs";
import { RequestsTab } from "./RequestsTab";
import { ReviewTab } from "./ReviewTab";
import { SPECS } from "./specs";
import { STATUS_TONE, Workspace } from "./Workspace";

export type ContentTab = "course" | "lessons" | "scenarios" | "rubrics" | "media" | "readings" | "glossary" | "requests" | "review" | "diagnostics";
/** The tab needs its permission (UX; admin-bff and the catalog re-check): the learners' requests register is
 *  media.rights only (decision of the sprint 3 review) — it holds learners' titles, links and comments. */
export const CONTENT_TABS: ReadonlyArray<{ v: ContentTab; icon: IconName; perm: "content.read" | "content.review" | "media.rights" }> = [
  { v: "course", icon: "layers", perm: "content.read" },
  { v: "lessons", icon: "book", perm: "content.read" },
  { v: "scenarios", icon: "branch", perm: "content.read" },
  { v: "rubrics", icon: "clipboardCheck", perm: "content.read" },
  { v: "media", icon: "play", perm: "content.read" },
  // sprint 5: reading texts (ContentKind reading, the shared content API) and the course dictionary
  { v: "readings", icon: "note", perm: "content.read" },
  { v: "glossary", icon: "layers", perm: "content.read" },
  { v: "requests", icon: "inbox", perm: "media.rights" },
  { v: "review", icon: "userCheck", perm: "content.review" },
  { v: "diagnostics", icon: "gauge", perm: "content.read" },
];
const TAB_KIND: Partial<Record<string, ContentKind>> = { lessons: "lesson", scenarios: "scenario", rubrics: "rubric", media: "media_asset", exercises: "media_exercise", readings: "reading" };

/** «lessons/l-01» → {tab: lessons, rest: "l-01"}; «exercises/x» is the exercise view of the media tab. */
export function parseContentRoute(id: string | null): { tab: ContentTab | null; sub: "assets" | "exercises"; rest: string | null } {
  if (!id) return { tab: null, sub: "assets", rest: null };
  const [head, ...more] = id.split("/");
  const rest = more.join("/") || null;
  if (head === "exercises") return { tab: "media", sub: "exercises", rest };
  const tab = CONTENT_TABS.find((x) => x.v === head)?.v ?? null;
  return { tab, sub: "assets", rest: tab ? rest : null };
}

/** Tabs of the content section a staff member gets: content.read for the section; review — content.review; requests — media.rights. */
export function contentTabs(can: (p: Permission) => boolean): ContentTab[] {
  return can("content.read") ? CONTENT_TABS.filter((x) => can(x.perm)).map((x) => x.v) : [];
}

export function ContentPage({ routeId }: { routeId: string | null }) {
  const { t } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const r = parseContentRoute(routeId);
  const allowedTabs = contentTabs(can);
  const tabs = CONTENT_TABS.filter((x) => allowedTabs.includes(x.v));
  const tab = r.tab && tabs.some((x) => x.v === r.tab) ? r.tab : (tabs.find((x) => x.v === "lessons")?.v ?? tabs[0]?.v ?? "lessons");
  return (
    <RefsProvider>
      <div className="stack" data-testid="content">
        <Tabs<ContentTab>
          id="ct"
          label={t("ct.tabs")}
          value={tab}
          onChange={(v) => navigate("content", v)}
          items={tabs.map((x) => ({ v: x.v, label: t(`ct.tab.${x.v}` as MessageKey), icon: x.icon, testId: `ct-tab-${x.v}` }))}
        />
        <TabPanel id="ct" value={tab}>
          {tab === "course" && <CourseTab />}
          {(tab === "lessons" || tab === "scenarios" || tab === "rubrics" || tab === "readings") && <KindTab key={tab} tab={tab} kind={TAB_KIND[tab]!} routeKey={r.rest} />}
          {tab === "glossary" && <GlossaryTab route={r.rest} />}
          {tab === "media" && <MediaTab sub={r.sub} routeKey={r.rest} />}
          {tab === "requests" && <RequestsTab openId={r.rest} />}
          {tab === "review" && <ReviewTab route={r.rest} />}
          {tab === "diagnostics" && <DiagnosticsTab route={r.rest} />}
        </TabPanel>
      </div>
    </RefsProvider>
  );
}

/* ---------------------------------------------------------------- list + workspace of one kind */

function KindTab({ tab, kind, routeKey }: { tab: string; kind: ContentKind; routeKey: string | null }) {
  const { navigate } = useNav();
  const { t } = useI18n();
  const [mode, setMode] = useState<"open" | "new">("open");
  const [tick, setTick] = useState(0);
  useEffect(() => setMode("open"), [routeKey]);
  const open = (k: string) => {
    setMode("open");
    navigate("content", `${tab}/${k}`);
  };
  return (
    <div className="ct-split">
      <KindList kind={kind} selected={mode === "new" ? null : routeKey} onSelect={open} onNew={() => setMode("new")} tick={tick} />
      <div className="ct-main">
        {mode === "new" ? (
          <Workspace key={`new-${kind}`} spec={SPECS[kind]} entityKey={null} onOpen={(k) => (setTick((n) => n + 1), open(k))} onChanged={() => setTick((n) => n + 1)} onCancelNew={() => setMode("open")} />
        ) : routeKey ? (
          <Workspace key={`${kind}/${routeKey}`} spec={SPECS[kind]} entityKey={routeKey} onOpen={open} onChanged={() => setTick((n) => n + 1)} />
        ) : (
          <section className="panel">
            <Empty icon="book" title={t(`ct.pick.${kind}` as MessageKey)} text={t("ct.pickM")} testId="ct-pick" />
          </section>
        )}
      </div>
    </div>
  );
}

function MediaTab({ sub, routeKey }: { sub: "assets" | "exercises"; routeKey: string | null }) {
  const { t } = useI18n();
  const { navigate } = useNav();
  return (
    <div className="stack sm">
      <Seg<"assets" | "exercises">
        label={t("ct.mediaSub")}
        value={sub}
        onChange={(v) => navigate("content", v === "assets" ? "media" : "exercises")}
        testId="ct-media-sub"
        items={[
          { v: "assets", label: t("ct.media.assets") },
          { v: "exercises", label: t("ct.media.exercises") },
        ]}
      />
      {sub === "assets" ? <KindTab key="assets" tab="media" kind="media_asset" routeKey={routeKey} /> : <KindTab key="ex" tab="exercises" kind="media_exercise" routeKey={routeKey} />}
    </div>
  );
}

export function KindList({ kind, selected, onSelect, onNew, tick }: { kind: ContentKind; selected: string | null; onSelect: (key: string) => void; onNew: () => void; tick: number }) {
  const { t, fmt } = useI18n();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<VersionStatus | "">("");
  const [level, setLevel] = useState<Band | "">("");
  const [rows, setRows] = useState<ContentRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const req = useRef(0);
  const load = useCallback(
    async (more?: string | null) => {
      const id = ++req.current;
      try {
        const r = await Content.list(kind, { q: q.trim() || undefined, status, level, cursor: more ?? null, limit: 50 });
        if (id !== req.current) return;
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        if (id === req.current) setError(e);
      }
    },
    [kind, q, status, level],
  );
  useEffect(() => {
    const tm = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(tm);
  }, [load, q, tick]);
  const media = kind === "media_asset";
  return (
    <section className="panel ct-list" aria-labelledby={`ctl-${kind}`} data-testid={`list-${kind}`}>
      <div className="panel-h">
        <h2 className="panel-t grow" id={`ctl-${kind}`}>
          {t(`kinds.${kind}` as MessageKey)}
        </h2>
        <Btn size="sm" kind="primary" icon="plus" label={t("ct.new")} perm="content.edit" onClick={onNew} testId={`new-${kind}`} />
      </div>
      <div className="ct-filters">
        <div className="input-wrap">
          <Icon name="search" />
          <input className="input" type="search" value={q} placeholder={t("ct.searchPh")} aria-label={t("ct.search")} onChange={(e) => setQ(e.target.value)} data-testid={`q-${kind}`} />
        </div>
        <div className="row nowrap-row">
          <Select<VersionStatus | ""> id={`st-${kind}`} label={t("col.status")} value={status} onChange={setStatus} options={[{ v: "", label: t("ct.allStatuses") }, ...STATUSES.map((s) => ({ v: s, label: t(`vst.${s}` as MessageKey) }))]} />
          <Select<Band | ""> id={`lv-${kind}`} label={t("le.level")} value={level} onChange={setLevel} options={[{ v: "", label: t("ct.allLevels") }, ...BANDS.map((b) => ({ v: b, label: b }))]} />
        </div>
      </div>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <ul className="ct-rows">
          {rows.map((r) => (
            <li key={r.key}>
              <button type="button" className="ct-row" aria-current={selected === r.key ? "true" : undefined} onClick={() => onSelect(r.key)} data-testid={`row-${r.key}`}>
                <span className="ct-row-t">{r.title.ru || r.key}</span>
                <span className="ct-row-m">
                  <span className="mono">{r.key}</span>
                  {r.level && <span className="tag">{r.level}</span>}
                </span>
                <span className="ct-row-s">
                  <Pill tone={STATUS_TONE[r.latest_status]}>
                    v{r.latest_version} · {t(`vst.${r.latest_status}` as MessageKey)}
                  </Pill>
                  {r.published_version != null && r.published_version !== r.latest_version && (
                    <Pill tone="good" dot={false}>
                      {t("ct.pubV", { v: r.published_version })}
                    </Pill>
                  )}
                  {media && r.rights_warning && (
                    <Pill tone={r.rights_warning === "expired" ? "bad" : "warn"} testId={`rw-${r.key}`}>
                      {t(`ct.rw.${r.rights_warning}` as MessageKey)}
                    </Pill>
                  )}
                </span>
                <span className="ct-row-u">
                  {fmt.dateTime(r.updated_at)}
                  {r.updated_by_name ? ` · ${r.updated_by_name}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="inbox" title={t("ct.emptyList")} text={q || status || level ? t("ct.emptyFiltered") : t("ct.emptyListM")} />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} />
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- course: tree and skills */

interface Tree {
  course: { key: string; payload: { module_ids: string[]; level_start: Band; level_end: Band; title: { ru: string; uz: string } } } | null;
  modules: Record<string, { lesson_ids: string[]; title: { ru: string; uz: string }; theme: string } | null>;
  skills: Record<string, { prerequisites: string[]; area: string; level: Band } | null>;
}

async function latestPayload<P>(kind: ContentKind, row: ContentRow): Promise<P | null> {
  try {
    return (await Content.version<P>(kind, row.key, row.latest_version)).payload;
  } catch {
    return null;
  }
}

/** Runs `fn` over `xs` with at most `n` requests at a time. */
async function pool<T, R>(xs: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) {
        const k = i++;
        out[k] = await fn(xs[k]!);
      }
    }),
  );
  return out;
}

function CourseTab() {
  const { t } = useI18n();
  const { navigate } = useNav();
  const refs = useRefs();
  const courses = refs.rows.course ?? [];
  const [courseKey, setCourseKey] = useState<string>("");
  const [level, setLevel] = useState<Band | "all">("all");
  const [tree, setTree] = useState<Tree | null>(null);
  const [drawer, setDrawer] = useState<{ kind: ContentKind; key: string | null } | null>(null);
  const cur = courseKey || courses[0]?.key || "";

  const build = useCallback(async () => {
    const crow = courses.find((c) => c.key === cur);
    const course = crow ? await latestPayload<NonNullable<Tree["course"]>["payload"]>("course", crow) : null;
    const mrows = refs.rows.module ?? [];
    const srows = refs.rows.skill ?? [];
    const mods = await pool(mrows, 6, async (m) => [m.key, await latestPayload<NonNullable<Tree["modules"][string]>>("module", m)] as const);
    const sks = await pool(srows, 6, async (s) => [s.key, await latestPayload<NonNullable<Tree["skills"][string]>>("skill", s)] as const);
    setTree({ course: course && crow ? { key: crow.key, payload: course } : null, modules: Object.fromEntries(mods), skills: Object.fromEntries(sks) });
  }, [courses, cur, refs.rows.module, refs.rows.skill]);
  useEffect(() => {
    if (refs.loaded) void build();
  }, [refs.loaded, build]);

  const lessonRow = (k: string) => (refs.rows.lesson ?? []).find((x) => x.key === k);
  const graph = useMemo(() => Object.fromEntries(Object.entries(tree?.skills ?? {}).map(([k, v]) => [k, v?.prerequisites ?? []])), [tree]);
  const cyclic = useMemo(() => new Set(Object.keys(graph).filter((k) => prereqCycle(graph, k, graph[k] ?? []))), [graph]);
  const usedBy = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const [k, ps] of Object.entries(graph)) for (const p of ps) (m[p] ??= []).push(k);
    return m;
  }, [graph]);
  const skillRows = (refs.rows.skill ?? []).filter((s) => level === "all" || s.level === level);
  const known = new Set((refs.rows.skill ?? []).map((s) => s.key));

  if (!refs.loaded) return <Spinner label={t("common.loading")} />;
  return (
    <div className="stack" data-testid="course-tab">
      <div className="toolbar">
        {courses.length > 1 && <Select id="ct-course" label={t("le.course")} value={cur} onChange={setCourseKey} options={courses.map((c) => ({ v: c.key, label: `${c.title.ru} · ${c.key}` }))} />}
        <Seg<Band | "all"> label={t("ct.levelFilter")} value={level} onChange={setLevel} testId="ct-level" items={[{ v: "all", label: t("ct.allLevels") }, ...BANDS.map((b) => ({ v: b, label: b }))]} />
        <span className="grow" />
        <Btn size="sm" icon="plus" label={t("ct.newModule")} perm="content.edit" onClick={() => setDrawer({ kind: "module", key: null })} />
        <Btn size="sm" icon="plus" label={t("ct.newSkill")} perm="content.edit" onClick={() => setDrawer({ kind: "skill", key: null })} />
      </div>
      <div className="grid2">
        <section className="card" aria-labelledby="tree-h" data-testid="course-tree">
          <div className="row between">
            <h2 className="h2" id="tree-h">
              {t("ct.tree")}
            </h2>
            {tree?.course && (
              <Btn size="xs" icon="edit" label={t("ct.openCourse")} onClick={() => setDrawer({ kind: "course", key: tree.course!.key })} testId="tree-course" />
            )}
          </div>
          {!tree ? (
            <Spinner label={t("common.loading")} />
          ) : !tree.course ? (
            <Empty icon="layers" title={t("ct.noCourse")} />
          ) : (
            <ul className="tree" aria-label={t("ct.tree")}>
              <li>
                <span className="tree-node course">
                  <Icon name="layers" /> <b>{tree.course.payload.title.ru}</b>
                  <span className="mono xs muted">{tree.course.key}</span>
                  <span className="tag">
                    {tree.course.payload.level_start}–{tree.course.payload.level_end}
                  </span>
                </span>
                <ul>
                  {tree.course.payload.module_ids.map((mid, mi) => {
                    const m = tree.modules[mid];
                    const mrow = (refs.rows.module ?? []).find((x) => x.key === mid);
                    const lessons = (m?.lesson_ids ?? []).filter((lid) => level === "all" || lessonRow(lid)?.level === level);
                    return (
                      <li key={mid} data-testid={`tree-${mid}`}>
                        <button type="button" className="tree-node module" onClick={() => setDrawer({ kind: "module", key: mid })}>
                          <span className="idx">{mi + 1}</span>
                          <span className="grow">
                            {m?.title.ru ?? mid}
                            <span className="mono xs muted block">{mid}</span>
                          </span>
                          {mrow ? <Pill tone={STATUS_TONE[mrow.latest_status]}>{t(`vst.${mrow.latest_status}` as MessageKey)}</Pill> : <Pill tone="bad">{t("ct.missing")}</Pill>}
                        </button>
                        <ul>
                          {lessons.map((lid, li) => {
                            const lr = lessonRow(lid);
                            return (
                              <li key={lid}>
                                <button type="button" className="tree-node lesson" onClick={() => navigate("content", `lessons/${lid}`)} data-testid={`tree-lesson-${lid}`}>
                                  <span className="idx">
                                    {mi + 1}.{li + 1}
                                  </span>
                                  <span className="grow">
                                    {lr?.title.ru ?? lid}
                                    <span className="mono xs muted block">{lid}</span>
                                  </span>
                                  {lr?.level && <span className="tag">{lr.level}</span>}
                                  {lr ? <Pill tone={STATUS_TONE[lr.latest_status]}>{t(`vst.${lr.latest_status}` as MessageKey)}</Pill> : <Pill tone="bad">{t("ct.missing")}</Pill>}
                                </button>
                              </li>
                            );
                          })}
                          {!lessons.length && <li className="xs muted tree-empty">{t("ct.noLessons")}</li>}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              </li>
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="skills-h" data-testid="skills">
          <h2 className="h2" id="skills-h">
            {t("ct.skills", { n: skillRows.length })}
          </h2>
          <p className="xs muted">{t("ct.skillsHint")}</p>
          {!tree ? (
            <Spinner label={t("common.loading")} />
          ) : (
            <ul className="skill-list">
              {skillRows.map((s) => {
                const pre = tree.skills[s.key]?.prerequisites ?? [];
                const by = usedBy[s.key] ?? [];
                return (
                  <li key={s.key} className={cx("skill-li", cyclic.has(s.key) && "is-bad")} data-testid={`skill-${s.key}`}>
                    <button type="button" className="tr" onClick={() => setDrawer({ kind: "skill", key: s.key })}>
                      {s.title.ru || s.key}
                    </button>
                    <span className="mono xs muted">{s.key}</span>
                    <span className="row">
                      {s.level && <span className="tag">{s.level}</span>}
                      {tree.skills[s.key]?.area && <span className="tag plain">{t(`area.${tree.skills[s.key]!.area}` as MessageKey)}</span>}
                      <Pill tone={STATUS_TONE[s.latest_status]}>{t(`vst.${s.latest_status}` as MessageKey)}</Pill>
                      {cyclic.has(s.key) && <Pill tone="bad">{t("ci.PREREQ_CYCLE")}</Pill>}
                    </span>
                    <span className="small">
                      <span className="muted">{t("ct.requires")}</span>{" "}
                      {pre.length
                        ? pre.map((x) => (
                            <span key={x} className={cx("chip-ref", !known.has(x) && "is-bad")}>
                              {x}
                            </span>
                          ))
                        : t("ct.none")}
                    </span>
                    {by.length > 0 && (
                      <span className="small">
                        <span className="muted">{t("ct.neededFor")}</span>{" "}
                        {by.map((x) => (
                          <span key={x} className="chip-ref">
                            {x}
                          </span>
                        ))}
                      </span>
                    )}
                  </li>
                );
              })}
              {!skillRows.length && <li className="small muted">{t("ct.noSkills")}</li>}
            </ul>
          )}
        </section>
      </div>
      {drawer && (
        <Drawer wide title={drawer.key ? `${t(`kind.${drawer.kind}` as MessageKey)} · ${drawer.key}` : t("ct.newT", { k: t(`kind.${drawer.kind}` as MessageKey) })} onClose={() => setDrawer(null)} testId="struct-drawer">
          <Workspace
            key={`${drawer.kind}/${drawer.key ?? "new"}`}
            spec={SPECS[drawer.kind]}
            entityKey={drawer.key}
            newCtx={{ course_id: cur || undefined }}
            onOpen={(k) => setDrawer({ kind: drawer.kind, key: k })}
            onChanged={() => void refs.reload().then(build)}
            onCancelNew={() => setDrawer(null)}
          />
        </Drawer>
      )}
    </div>
  );
}

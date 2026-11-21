/**
 * «Обзор» (dashboard.read): the independent blocks of GET /admin/v1/dashboard — learners (user-admin), support,
 * «Что нового» (experience-config), campaigns (notifications) and, since sprint 3, content (catalog: versions under
 * review, media rights expiring in ≤ 14 days with links, suspended media, new learners' requests) and diagnostics
 * (sessions, levels, not_assessed), sprint 7 — the community (friend requests, duels, pair rooms, moderation, referrals
 * under review). A block whose source is down answers available=false and shows its own notice;
 * the others keep working (admin.ts Dashboard, always 200; a block missing in an older admin-bff counts as down).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AiUsageSummary, ContentSummary, Dashboard, DashboardBlock, DashboardCampaigns, DashboardLearners, DashboardWhatsNew, DiagnosticStats, GameStats, LessonStats, MemoryStats, SocialStats, SupportStats } from "@tilhero/contracts/admin";
import type { ContentKind } from "@tilhero/contracts/content";
import { DashboardApi, type Period } from "../../api/endpoints";
import { useI18n, type MessageKey } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon, type IconName } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Seg, Spinner } from "../../ui/kit";
import { setAiEnabled } from "../ai/aiState";
import { budgetLevel, usd } from "../ai/model";
import { zoneDateTime } from "../game/model";

const PERIODS: readonly Period[] = ["today", "7d", "30d"];
type BlockKey = "learners" | "support" | "whats_new" | "campaigns" | "content" | "diagnostics" | "lessons" | "ai" | "memory" | "game" | "social";
const SESSION_KINDS = ["lesson", "scenario", "media", "review", "reading"] as const;
const OFF = (service: string) => ({ available: false, data: null, service });
const DX_AREAS = ["vocabulary", "grammar", "reading", "listening"] as const;
const LEVELS = ["A0", "A1", "A2", "B1", "B2", "none"] as const;
const SUMMARY_KINDS: readonly ContentKind[] = ["lesson", "scenario", "rubric", "media_asset", "media_exercise", "reading", "skill"];

export function Overview() {
  const i = useI18n();
  const { t, fmt } = i;
  const [period, setPeriod] = useState<Period>("today");
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const req = useRef(0);

  const load = useCallback((p: Period, background = false) => {
    const id = ++req.current;
    if (!background) setLoading(true);
    DashboardApi.get(p, background)
      .then((d) => {
        if (id !== req.current) return;
        setData(d);
        setError(null);
        if (d.ai?.available && d.ai.data) setAiEnabled(d.ai.data.ai_enabled);
      })
      .catch((e) => id === req.current && !background && setError(e))
      .finally(() => id === req.current && setLoading(false));
  }, []);
  useEffect(() => {
    load(period);
    const tm = setInterval(() => load(period, true), 60_000);
    return () => clearInterval(tm);
  }, [period, load]);

  const periodLabel = t(`dash.period.${period}`);
  return (
    <div className="stack" data-testid="overview">
      <div className="dash-head">
        <Seg<Period> label={t("dash.period")} value={period} onChange={setPeriod} testId="dash-period" items={PERIODS.map((v) => ({ v, label: t(`dash.period.${v}`) }))} />
        <span className="grow" />
        {data && (
          <span className="dash-updated" data-testid="dash-updated">
            <span className="live" aria-hidden="true" />
            {t("dash.updated", { t: fmt.time(data.generated_at) })}
          </span>
        )}
        <Btn size="sm" icon="refresh" label={t("common.refresh")} busy={loading && !!data} onClick={() => load(period)} testId="dash-refresh" />
      </div>
      {error && !data ? <LoadError error={error} onRetry={() => load(period)} /> : null}
      {!data && !error ? <Spinner label={t("common.loading")} /> : null}
      {data && (
        <>
          <Kpis d={data} period={periodLabel} />
          <Attention d={data} />
          <div className="grid2">
            <Block<DashboardLearners> k="learners" icon="users" block={data.learners} empty={(x) => x.total_accounts + x.total_children === 0}>
              {(x) => <LearnersBody x={x} period={periodLabel} />}
            </Block>
            <Block<SupportStats> k="support" icon="support" block={data.support} empty={(x) => x.open + x.in_progress + x.waiting_customer === 0 && x.avg_first_response_minutes == null}>
              {(x) => <SupportBody x={x} />}
            </Block>
            <Block<DashboardWhatsNew> k="whats_new" icon="sparkles" block={data.whats_new} empty={(x) => x.published + x.drafts === 0}>
              {(x) => <WhatsNewBody x={x} />}
            </Block>
            <Block<DashboardCampaigns> k="campaigns" icon="megaphone" block={data.campaigns} empty={(x) => x.scheduled + x.sending + x.sent_in_period + x.delivered_in_period === 0}>
              {(x) => <CampaignsBody x={x} period={periodLabel} />}
            </Block>
            <Block<ContentSummary> k="content" icon="book" block={data.content ?? OFF("catalog")} empty={(x) => Object.values(x.by_kind ?? {}).every((k) => !k.published && !k.drafts && !k.in_review) && !x.new_media_requests}>
              {(x) => <ContentBody x={x} />}
            </Block>
            <Block<DiagnosticStats> k="diagnostics" icon="gauge" block={data.diagnostics ?? OFF("diagnostics")} empty={(x) => x.started === 0 && x.finished === 0}>
              {(x) => <DiagnosticsBody x={x} period={periodLabel} />}
            </Block>
            <Block<LessonStats> k="lessons" icon="play" block={data.lessons ?? OFF("lessons")} empty={(x) => x.started === 0 && x.completed === 0 && !x.appeals_open && !x.human_review_open}>
              {(x) => <LessonsBody x={x} period={periodLabel} />}
            </Block>
            <Block<AiUsageSummary> k="ai" icon="cpu" block={data.ai ?? OFF("ai-gateway")} empty={(x) => x.calls === 0 && x.spent_usd === 0 && x.ai_enabled}>
              {(x) => <AiBody x={x} />}
            </Block>
            {/* sprint 5: memory and reviews; a failure of this block never breaks the overview */}
            <Block<MemoryStats> k="memory" icon="trendDown" block={data.memory ?? OFF("memory")} empty={(x) => x.review_sessions === 0 && x.learners_reviewing === 0 && !x.ai_glosses_pending}>
              {(x) => <MemoryBody x={x} period={periodLabel} />}
            </Block>
            {/* sprint 6: the game (gamification); a failure of this block never breaks the overview */}
            <Block<GameStats> k="game" icon="trophy" block={data.game ?? OFF("gamification")} empty={(x) => x.earned_xp === 0 && x.earned_til === 0 && x.freezes_used === 0 && x.quests_completed === 0 && !x.active_event}>
              {(x) => <GameBody x={x} asked={period} />}
            </Block>
            {/* sprint 7: the community (social; duels — gamification, rooms — lessons: null when those are down) */}
            <Block<SocialStats> k="social" icon="userPlus" block={data.social ?? OFF("social")} empty={(x) => x.friend_requests + x.friendships_added + (x.duels_finished ?? 0) + (x.pair_rooms_finished ?? 0) + x.referrals_in_review + x.cases_opened + x.cases_open === 0}>
              {(x) => <SocialBody x={x} period={periodLabel} />}
            </Block>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- KPI row (prototype .grid .card) */

function Kpis({ d, period }: { d: Dashboard; period: string }) {
  const { t, fmt } = useI18n();
  const l = d.learners.available ? d.learners.data : null;
  const s = d.support.available ? d.support.data : null;
  const w = d.whats_new.available ? d.whats_new.data : null;
  const c = d.campaigns.available ? d.campaigns.data : null;
  const dash = "—";
  return (
    <div className="kpis" data-testid="kpis">
      <Kpi label={t("kpi.active", { p: period })} value={l ? fmt.num(l.active_in_period) : dash} note={l ? t("kpi.activeN", { a: fmt.num(l.total_accounts), c: fmt.num(l.total_children) }) : t("dash.noData")} />
      <Kpi label={t("kpi.new", { p: period })} value={l ? fmt.num(l.new_in_period) : dash} note={l ? t("kpi.onboarded", { n: fmt.pct(l.onboarding_completed_pct) }) : t("dash.noData")} />
      <Kpi label={t("kpi.open")} value={s ? fmt.num(s.open) : dash} note={s ? (s.breached ? t("kpi.breached", { n: s.breached }) : t("kpi.slaOk")) : t("dash.noData")} bad={!!s?.breached} />
      <Kpi label={t("kpi.views")} value={w?.latest ? fmt.num(w.latest.views_total) : dash} note={w?.latest ? w.latest.title : w ? t("wn.none") : t("dash.noData")} />
      <Kpi label={t("kpi.delivered", { p: period })} value={c ? fmt.num(c.delivered_in_period) : dash} note={c ? t("kpi.sent", { n: fmt.num(c.sent_in_period) }) : t("dash.noData")} />
    </div>
  );
}

function Kpi({ label, value, note, bad }: { label: string; value: string; note: string; bad?: boolean }) {
  return (
    <div className={cx("card kpi", bad && "is-bad")}>
      <div className="kpi-l">{label}</div>
      <div className="kpi-v">{value}</div>
      <div className="kpi-n" title={note}>
        {note}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- «Требует внимания» (prototype) */

function Attention({ d }: { d: Dashboard }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const rows: Array<{ label: string; n: number; go: () => void; show: boolean; id: string; text?: string }> = [];
  const s = d.support.available ? d.support.data : null;
  const w = d.whats_new.available ? d.whats_new.data : null;
  const c = d.campaigns.available ? d.campaigns.data : null;
  if (s) rows.push({ id: "breached", label: t("att.breached"), n: s.breached, go: () => navigate("support"), show: can("support.read") });
  if (s) rows.push({ id: "new", label: t("att.waiting"), n: s.open - s.in_progress - s.waiting_customer, go: () => navigate("support"), show: can("support.read") });
  if (w) rows.push({ id: "drafts", label: t("att.drafts"), n: w.drafts, go: () => navigate("news", "whatsnew"), show: can("whatsnew.manage") });
  if (c) rows.push({ id: "sending", label: t("att.sending"), n: c.sending + c.scheduled, go: () => navigate("news", "campaigns"), show: can("notif.campaigns.manage") });
  const ct = d.content?.available ? d.content.data : null;
  if (ct) {
    rows.push({ id: "review", label: t("att.review"), n: ct.in_review, go: () => navigate("content", "review"), show: can("content.review") });
    rows.push({ id: "rights", label: t("att.rights"), n: ct.rights_expiring.length, go: () => navigate("content", "media"), show: can("content.read") });
    rows.push({ id: "suspended", label: t("att.suspended"), n: ct.suspended_media, go: () => navigate("content", "media"), show: can("content.read") });
    // the requests register is media.rights only: others see the count without a link
    rows.push({ id: "requests", label: t("att.requests"), n: ct.new_media_requests, go: () => navigate("content", "requests"), show: can("media.rights") });
  }
  // sprint 4: the AI budget past its alert threshold, the AI switched off, open appeals and manual reviews
  const ai = d.ai?.available ? d.ai.data : null;
  if (ai) {
    rows.push({ id: "ai-off", label: t("att.aiOff"), n: ai.ai_enabled ? 0 : 1, go: () => navigate("costs"), show: can("costs.read"), text: t("att.aiOffV") });
    // the alert threshold comes with the summary (AiUsageSummary.alert_percent = AiBudget.alert_percent)
    const lvl = budgetLevel(ai.cap_used_pct, ai.alert_percent);
    rows.push({ id: "budget", label: t(lvl === "over" ? "att.budgetOver" : "att.budget", { a: ai.alert_percent }), n: lvl === "ok" ? 0 : 1, go: () => navigate("costs"), show: can("costs.read"), text: fmt.pct(ai.cap_used_pct) });
  }
  const ls = d.lessons?.available ? d.lessons.data : null;
  if (ls) {
    rows.push({ id: "appeals", label: t("att.appeals"), n: ls.appeals_open, go: () => navigate("qa", "appeals"), show: can("qa.read") });
    rows.push({ id: "human-review", label: t("att.humanReview"), n: ls.human_review_open, go: () => navigate("qa", "flag/human_review"), show: can("qa.read") });
  }
  // sprint 5: the queue of AI translations waiting for a methodist (the course dictionary)
  const mem = d.memory?.available ? d.memory.data : null;
  if (mem && mem.ai_glosses_pending != null) rows.push({ id: "glosses", label: t("att.glosses"), n: mem.ai_glosses_pending, go: () => navigate("content", "glossary/queue"), show: can("content.read") });
  // sprint 7: open moderation cases and referrals held for an operator
  const soc = d.social?.available ? d.social.data : null;
  if (soc) {
    rows.push({ id: "cases", label: t("att.cases"), n: soc.cases_open, go: () => navigate("moderation", "cases"), show: can("moderation.manage") });
    rows.push({ id: "referrals", label: t("att.referrals"), n: soc.referrals_in_review, go: () => navigate("referrals", "review"), show: can("referral.read") });
  }
  const live = rows.filter((r) => r.n > 0);
  if (!live.length) return null;
  return (
    <section className="card attention" aria-labelledby="att-h" data-testid="attention">
      <h2 className="h2" id="att-h">
        {t("att.title")}
      </h2>
      {live.map((r) => (
        <div className="kv" key={r.id}>
          <span>{r.label}</span>
          {r.show ? (
            <button type="button" className="tr" onClick={r.go} data-testid={`att-${r.id}`}>
              {t("att.open", { n: r.text ?? r.n })}
            </button>
          ) : (
            <span className="num" data-testid={`att-${r.id}-n`}>
              {r.text ?? r.n}
            </span>
          )}
        </div>
      ))}
    </section>
  );
}

/* ---------------------------------------------------------------- block frame */

function Block<T>({ k, icon, block, empty, children }: { k: BlockKey; icon: IconName; block: DashboardBlock<T>; empty: (x: T) => boolean; children: (x: T) => ReactNode }) {
  const { t } = useI18n();
  const off = !block.available || block.data == null;
  return (
    <section className={cx("card dash-block", off && "is-off")} aria-labelledby={`blk-${k}`} data-testid={`block-${k}`} data-available={String(!off)}>
      <div className="blk-h">
        <Icon name={icon} />
        <h2 className="h2" id={`blk-${k}`}>
          {t(`dash.b.${k}`)}
        </h2>
      </div>
      {off ? (
        <Callout kind="warn" icon="alert" testId={`block-${k}-off`}>
          <b>{t("dash.off.t")}</b> {t("dash.off.m", { s: block.service ?? t(`dash.svc.${k}`) })}
        </Callout>
      ) : empty(block.data as T) ? (
        <p className="sub blk-empty" data-testid={`block-${k}-empty`}>
          <Icon name="inbox" /> {t(`dash.empty.${k}`)}
        </p>
      ) : (
        children(block.data as T)
      )}
    </section>
  );
}

function Row({ k, v, testId }: { k: ReactNode; v: ReactNode; testId?: string }) {
  return (
    <div className="kv" data-testid={testId}>
      <span>{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}

function Split({ parts, label }: { parts: Array<{ k: string; n: number; label: string }>; label: string }) {
  const total = parts.reduce((a, p) => a + p.n, 0) || 1;
  return (
    <div className="split" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.n}`).join(", ")}`}>
      <div className="splitbar" aria-hidden="true">
        {parts.map((p, n) => (p.n ? <span key={p.k} className={`sw-${(n % 5) + 1}`} style={{ width: `${(p.n / total) * 100}%` }} /> : null))}
      </div>
      <div className="legend" aria-hidden="true">
        {parts.map((p, n) => (
          <span key={p.k}>
            <i className={`sw-${(n % 5) + 1}`} />
            {p.label} · {p.n}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- bodies */

function LearnersBody({ x, period }: { x: DashboardLearners; period: string }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const ages = (["6-9", "10-13", "14-17", "18+", "unknown"] as const).map((k) => ({ k, n: x.by_age_band[k] ?? 0, label: k === "unknown" ? t("dash.unknown") : k }));
  const langs = (["ru", "uz", "unknown"] as const).map((k) => ({ k, n: x.by_locale[k] ?? 0, label: k === "unknown" ? t("dash.unknown") : k.toUpperCase() }));
  return (
    <>
      <Row k={t("dl.accounts")} v={fmt.num(x.total_accounts)} testId="dl-accounts" />
      <Row k={t("dl.children")} v={fmt.num(x.total_children)} />
      <Row k={t("dl.new", { p: period })} v={fmt.num(x.new_in_period)} />
      <Row k={t("dl.active", { p: period })} v={fmt.num(x.active_in_period)} />
      <Row k={t("dl.onboarded")} v={fmt.pct(x.onboarding_completed_pct)} />
      <Row k={t("dl.reminders")} v={fmt.pct(x.reminders_enabled_pct)} />
      <div className="blk-sub">{t("dl.byAge")}</div>
      <Split parts={ages} label={t("dl.byAge")} />
      <div className="blk-sub">{t("dl.byLang")}</div>
      <Split parts={langs} label={t("dl.byLang")} />
      {can("users.read") && (
        <div className="acts">
          <Btn size="sm" icon="users" label={t("dl.open")} onClick={() => navigate("users")} />
        </div>
      )}
    </>
  );
}

function SupportBody({ x }: { x: SupportStats }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  return (
    <>
      <Row k={t("ds.open")} v={fmt.num(x.open)} testId="ds-open" />
      <Row k={t("ds.inProgress")} v={fmt.num(x.in_progress)} />
      <Row k={t("ds.waiting")} v={fmt.num(x.waiting_customer)} />
      <Row k={t("ds.breached")} v={<span className={x.breached ? "bad-ink b" : undefined}>{fmt.num(x.breached)}</span>} />
      <Row k={t("ds.first")} v={fmt.minutes(x.avg_first_response_minutes)} />
      <Row k={t("ds.resolution")} v={fmt.minutes(x.avg_resolution_minutes)} />
      {can("support.read") && (
        <div className="acts">
          <Btn size="sm" icon="support" label={t("ds.openQueue")} onClick={() => navigate("support")} />
        </div>
      )}
    </>
  );
}

function WhatsNewBody({ x }: { x: DashboardWhatsNew }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  return (
    <>
      <Row k={t("dw.published")} v={fmt.num(x.published)} />
      <Row k={t("dw.drafts")} v={fmt.num(x.drafts)} />
      {x.latest ? (
        <>
          <Row k={t("dw.latest")} v={<span className="wrap-any">{x.latest.title}</span>} />
          <Row k={t("dw.views")} v={fmt.num(x.latest.views_total)} testId="dw-views" />
          <Row k={t("dw.at")} v={fmt.dateTime(x.latest.published_at)} />
        </>
      ) : (
        <p className="sub">{t("wn.none")}</p>
      )}
      {can("whatsnew.manage") && (
        <div className="acts">
          <Btn size="sm" icon="sparkles" label={t("dw.open")} onClick={() => navigate("news", "whatsnew")} />
        </div>
      )}
    </>
  );
}

function CampaignsBody({ x, period }: { x: DashboardCampaigns; period: string }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  return (
    <>
      <Row k={t("dc.scheduled")} v={fmt.num(x.scheduled)} />
      <Row k={t("dc.sending")} v={fmt.num(x.sending)} />
      {/* units differ (QA D2-01): campaigns started vs. campaign messages delivered — admin.ts DashboardCampaigns */}
      <Row k={t("dc.sent", { p: period })} v={fmt.num(x.sent_in_period)} testId="dc-sent" />
      <Row k={t("dc.delivered", { p: period })} v={fmt.num(x.delivered_in_period)} testId="dc-delivered" />
      {can("notif.campaigns.manage") && (
        <div className="acts">
          <Btn size="sm" icon="megaphone" label={t("dc.open")} onClick={() => navigate("news", "campaigns")} />
        </div>
      )}
    </>
  );
}

function ContentBody({ x }: { x: ContentSummary }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const read = can("content.read");
  return (
    <>
      <Row k={t("dct.inReview")} v={can("content.review") && x.in_review ? <button type="button" className="tr" onClick={() => navigate("content", "review")} data-testid="dct-review">{fmt.num(x.in_review)}</button> : fmt.num(x.in_review)} testId="dct-in-review" />
      <Row k={t("dct.suspended")} v={<span className={x.suspended_media ? "bad-ink b" : undefined}>{fmt.num(x.suspended_media)}</span>} testId="dct-suspended" />
      <Row k={t("dct.requests")} v={can("media.rights") && x.new_media_requests ? <button type="button" className="tr" onClick={() => navigate("content", "requests")} data-testid="dct-requests">{fmt.num(x.new_media_requests)}</button> : fmt.num(x.new_media_requests)} testId="dct-new-requests" />
      <div className="blk-sub">{t("dct.expiring")}</div>
      {x.rights_expiring.length ? (
        <ul className="plain-list exp-list" data-testid="dct-expiring">
          {x.rights_expiring.slice(0, 6).map((r) => (
            <li key={r.asset_id}>
              {read ? (
                <button type="button" className="tr" onClick={() => navigate("content", `media/${r.asset_id}`)} data-testid={`dct-exp-${r.asset_id}`}>
                  {r.title.ru || r.asset_id}
                </button>
              ) : (
                <span>{r.title.ru || r.asset_id}</span>
              )}
              <span className="pill warn">{t("dct.until", { d: fmt.date(`${r.valid_to}T00:00:00Z`) })}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sub small">{t("dct.noExpiring")}</p>
      )}
      <div className="blk-sub">{t("dct.byKind")}</div>
      <table className="tbl dense mini-tbl">
        <thead>
          <tr>
            <th scope="col">{t("dct.kind")}</th>
            <th scope="col" className="r">{t("dct.published")}</th>
            <th scope="col" className="r">{t("dct.drafts")}</th>
            <th scope="col" className="r">{t("dct.review")}</th>
          </tr>
        </thead>
        <tbody>
          {SUMMARY_KINDS.map((k) => {
            const v = x.by_kind?.[k] ?? { published: 0, drafts: 0, in_review: 0 };
            return (
              <tr key={k}>
                <td>{t(`kinds.${k}` as MessageKey)}</td>
                <td className="r num">{fmt.num(v.published)}</td>
                <td className="r num">{fmt.num(v.drafts)}</td>
                <td className="r num">{fmt.num(v.in_review)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {read && (
        <div className="acts">
          <Btn size="sm" icon="book" label={t("dct.open")} onClick={() => navigate("content")} />
        </div>
      )}
    </>
  );
}

function DiagnosticsBody({ x, period }: { x: DiagnosticStats; period: string }) {
  const { t, fmt } = useI18n();
  const total = LEVELS.reduce((a, b) => a + (x.by_level[b] ?? 0), 0);
  return (
    <>
      <Row k={t("ddx.started", { p: period })} v={fmt.num(x.started)} />
      <Row k={t("ddx.finished", { p: period })} v={fmt.num(x.finished)} testId="ddx-finished" />
      <Row k={t("ddx.median")} v={fmt.minutes(x.median_minutes)} />
      <Row k={t("ddx.followups")} v={fmt.num(x.followups)} />
      <div className="blk-sub">{t("ddx.levels")}</div>
      {total ? <Split parts={LEVELS.map((b) => ({ k: b, n: x.by_level[b] ?? 0, label: b === "none" ? t("ddx.none") : b }))} label={t("ddx.levels")} /> : <p className="sub small">{t("dash.noData")}</p>}
      <div className="blk-sub">{t("ddx.na")}</div>
      {DX_AREAS.map((a) => (
        <Row key={a} k={t(`area.${a}` as MessageKey)} v={fmt.pct(x.not_assessed_pct[a] ?? 0)} testId={`ddx-na-${a}`} />
      ))}
      <p className="xs muted">{t("ddx.note")}</p>
    </>
  );
}

/* ---------------------------------------------------------------- sprint 4: lessons and AI */

function LessonsBody({ x, period }: { x: LessonStats; period: string }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const qa = can("qa.read");
  const kinds = SESSION_KINDS.map((k) => ({ k, n: x.by_kind?.[k] ?? 0, label: t(`sk.${k}`) }));
  return (
    <>
      <Row k={t("dls.started", { p: period })} v={fmt.num(x.started)} testId="dls-started" />
      <Row k={t("dls.completed", { p: period })} v={fmt.num(x.completed)} testId="dls-completed" />
      <Row k={t("dls.completion")} v={x.completion_pct != null ? fmt.pct(x.completion_pct) : "—"} testId="dls-completion" />
      <Row k={t("dls.median")} v={fmt.minutes(x.median_minutes)} />
      <Row k={t("dls.degraded")} v={x.ai_degraded_pct != null ? fmt.pct(x.ai_degraded_pct) : "—"} testId="dls-degraded" />
      <Row
        k={t("dls.appeals")}
        testId="dls-appeals"
        v={qa && x.appeals_open ? <button type="button" className="tr" onClick={() => navigate("qa", "appeals")} data-testid="dls-appeals-link">{fmt.num(x.appeals_open)}</button> : fmt.num(x.appeals_open)}
      />
      <Row
        k={t("dls.humanReview")}
        testId="dls-human"
        v={qa && x.human_review_open ? <button type="button" className="tr" onClick={() => navigate("qa", "flag/human_review")} data-testid="dls-human-link">{fmt.num(x.human_review_open)}</button> : fmt.num(x.human_review_open)}
      />
      <div className="blk-sub">{t("dls.byKind")}</div>
      {kinds.some((k) => k.n) ? <Split parts={kinds} label={t("dls.byKind")} /> : <p className="sub small">{t("dash.noData")}</p>}
      {qa && (
        <div className="acts">
          <Btn size="sm" icon="clipboardCheck" label={t("dls.open")} onClick={() => navigate("qa")} />
        </div>
      )}
    </>
  );
}

function AiBody({ x }: { x: AiUsageSummary }) {
  const alert = x.alert_percent;
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const money = (n: number | null) => usd(n, fmt.locale);
  const lvl = budgetLevel(x.cap_used_pct, alert);
  return (
    <>
      {!x.ai_enabled && (
        <Callout kind="bad" icon="power" testId="dai-off">
          <b>{t("ai.off.t")}</b> {t("ai.off.m")}
        </Callout>
      )}
      <div className="kv" data-testid="dai-spent">
        <span>{t("dai.spent")}</span>
        <span className="num">
          <b>{money(x.spent_usd)}</b> <span className="muted">{t("bud.of", { c: money(x.monthly_cap_usd) })}</span>
        </span>
      </div>
      <div className={cx("bud is-compact", `is-${lvl}`)} data-level={lvl}>
        <div className="bud-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, x.cap_used_pct)} aria-label={t("bud.barAria", { s: money(x.spent_usd), c: money(x.monthly_cap_usd), p: fmt.pct(x.cap_used_pct), a: alert })}>
          <span className="bud-fill" style={{ width: `${Math.min(100, x.cap_used_pct)}%` }} />
          <span className="bud-mark" style={{ left: `${Math.min(100, alert)}%` }} />
        </div>
      </div>
      <Row k={t("dai.capUsed")} v={<span className={cx(lvl !== "ok" && (lvl === "over" ? "bad-ink b" : "warn-ink b"))}>{fmt.pct(x.cap_used_pct)}{lvl !== "ok" ? ` · ${t(lvl === "over" ? "dai.over" : "dai.warn")}` : ""}</span>} testId="dai-pct" />
      <Row k={t("dai.calls")} v={fmt.num(x.calls)} testId="dai-calls" />
      <Row k={t("dai.unavailable")} v={`${fmt.num(x.unavailable)}${x.unavailable_pct != null ? ` · ${fmt.pct(x.unavailable_pct)}` : ""}`} testId="dai-unavail" />
      <Row k={t("dai.p95")} v={x.p95_latency_ms != null ? `${fmt.num(x.p95_latency_ms)} ms` : "—"} />
      <Row k={t("dai.avgLesson")} v={money(x.avg_cost_per_lesson_usd)} />
      {x.speech && (
        <Row
          k={t("dai.speech")}
          testId="dai-speech"
          v={
            <>
              {money(x.speech.spent_usd)} · {t("dai.speechMin", { n: fmt.num(x.speech.audio_minutes, Number.isInteger(x.speech.audio_minutes) ? 0 : 1) })}
              {!x.speech.speech_available && <span className="xs muted block">{t("dai.speechOff")}</span>}
            </>
          }
        />
      )}
      {can("costs.read") && (
        <div className="acts">
          <Btn size="sm" icon="gauge" label={t("dai.open")} onClick={() => navigate("costs")} />
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- sprint 5: memory and reviews */

function MemoryBody({ x, period }: { x: MemoryStats; period: string }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const pending = x.ai_glosses_pending;
  return (
    <>
      <Row k={t("dmem.sessions", { p: period })} v={fmt.num(x.review_sessions)} testId="dmem-sessions" />
      <Row k={t("dmem.learners", { p: period })} v={fmt.num(x.learners_reviewing)} testId="dmem-learners" />
      <Row k={t("dmem.median")} v={fmt.minutes(x.median_minutes)} />
      <Row k={t("dmem.d30")} v={x.d30_pass_pct != null ? fmt.pct(x.d30_pass_pct) : t("dmem.noData")} testId="dmem-d30" />
      <Row k={t("dmem.due")} v={x.avg_due_per_learner != null ? fmt.num(x.avg_due_per_learner, 1) : "—"} testId="dmem-due" />
      <Row
        k={t("dmem.glosses")}
        testId="dmem-glosses"
        v={
          pending == null ? (
            <span className="muted">{t("dmem.noData")}</span>
          ) : can("content.read") && pending > 0 ? (
            <button type="button" className="tr" onClick={() => navigate("content", "glossary/queue")} data-testid="dmem-glosses-link">
              {fmt.num(pending)}
            </button>
          ) : (
            fmt.num(pending)
          )
        }
      />
      <div className="acts">
        <Btn size="sm" icon="trendDown" label={t("dmem.open")} onClick={() => navigate("memory", "analytics")} testId="dmem-open" />
        {can("content.read") && <Btn size="sm" icon="layers" label={t("dmem.queue")} onClick={() => navigate("content", "glossary/queue")} testId="dmem-queue" />}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- sprint 6: the game */

/** The block names the period of its own data: gamification has no daily totals — for «today» it answers 7 days. */
function GameBody({ x, asked }: { x: GameStats; asked: Period }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const period = t(`dash.period.${x.period}`);
  return (
    <>
      {x.period !== asked && (
        <p className="xs muted" data-testid="dgm-period-note">
          {t("dgm.periodNote", { p: period })}
        </p>
      )}
      <Row k={t("dgm.xp", { p: period })} v={fmt.num(x.earned_xp)} testId="dgm-xp" />
      <Row k={t("dgm.til", { p: period })} v={fmt.num(x.earned_til)} testId="dgm-til" />
      <Row k={t("dgm.freezes", { p: period })} v={fmt.num(x.freezes_used)} testId="dgm-freezes" />
      <Row k={t("dgm.quests", { p: period })} v={fmt.num(x.quests_completed)} testId="dgm-quests" />
      <Row
        k={t("dgm.event")}
        testId="dgm-event"
        v={
          x.active_event ? (
            <span className="wrap-any" lang="ru">
              {x.active_event.title.ru}
              <span className="xs muted block">{t("dgm.until", { t: zoneDateTime(fmt.locale, x.active_event.ends_at) })}</span>
            </span>
          ) : (
            <span className="muted">{t("dgm.noEvent")}</span>
          )
        }
      />
      <p className="xs muted">{t("dgm.note")}</p>
      {can("game.read") && (
        <div className="acts">
          <Btn size="sm" icon="trophy" label={t("dgm.open")} onClick={() => navigate("game", "overview")} testId="dgm-open" />
          <Btn size="sm" icon="calendar" label={t("dgm.events")} onClick={() => navigate("events")} testId="dgm-events" />
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- sprint 7: the community */

/** Counters of the period and the queues now; a duel or room counter of a source that did not answer — «нет данных». */
function SocialBody({ x, period }: { x: SocialStats; period: string }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const opt = (n: number | null, testId: string) => (n == null ? <span className="muted" data-testid={`${testId}-na`}>{t("dmem.noData")}</span> : fmt.num(n));
  return (
    <>
      <Row k={t("dsoc.requests", { p: period })} v={fmt.num(x.friend_requests)} testId="dsoc-requests" />
      <Row k={t("dsoc.friendships", { p: period })} v={fmt.num(x.friendships_added)} testId="dsoc-friendships" />
      <Row k={t("dsoc.duels", { p: period })} v={opt(x.duels_finished, "dsoc-duels")} testId="dsoc-duels" />
      <Row k={t("dsoc.rooms", { p: period })} v={opt(x.pair_rooms_finished, "dsoc-rooms")} testId="dsoc-rooms" />
      <Row k={t("dsoc.casesOpened", { p: period })} v={fmt.num(x.cases_opened)} testId="dsoc-cases-opened" />
      <Row
        k={t("dsoc.casesOpen")}
        testId="dsoc-cases-open"
        v={can("moderation.manage") && x.cases_open ? <button type="button" className="tr" onClick={() => navigate("moderation", "cases")} data-testid="dsoc-cases-link">{fmt.num(x.cases_open)}</button> : fmt.num(x.cases_open)}
      />
      <Row
        k={t("dsoc.referrals")}
        testId="dsoc-referrals"
        v={can("referral.read") && x.referrals_in_review ? <button type="button" className="tr" onClick={() => navigate("referrals", "review")} data-testid="dsoc-referrals-link">{fmt.num(x.referrals_in_review)}</button> : fmt.num(x.referrals_in_review)}
      />
      <p className="xs muted">{t("dsoc.note")}</p>
      {(can("league.read") || can("room.read")) && (
        <div className="acts">
          {can("league.read") && <Btn size="sm" icon="podium" label={t("dsoc.leagues")} onClick={() => navigate("leagues")} testId="dsoc-leagues" />}
          {can("room.read") && <Btn size="sm" icon="mic" label={t("dsoc.rooms2")} onClick={() => navigate("pair_rooms")} testId="dsoc-rooms-open" />}
        </div>
      )}
    </>
  );
}

import type { BadgeView, GeneralLeague, LeaguesView, StandingRow, Standings } from "@tilhero/contracts/bff";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api/errors";
import { badgeNames, generalReasonKey, knownBadge, leagueBadgeCodes, leagueTabs, memberLabel, prizeOf, showPlaces, standingRows, type LeagueTab } from "../../domain/social";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { confirmPopup } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Pill, Seg, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { MemberAvatar, NicknameSheet, PrivacyNote, SocialError, useSocialAction } from "./parts";

/**
 * Leagues of the week (APP-SOC-08/09, AT-74, AT-81): friends and family — XP of the week, no prizes; the general league
 * (14+, by choice, only the nickname) — a group of 20–30 of the same pair and level, places, prizes in tils for 1–3, the
 * end of the week; the history of my weeks. A child sees only the family league: no places, no «последний» — «вместе
 * набрали». In every table: a nickname (or «Друг» / «Участник семьи»), the hero, XP, the place and allowed badges.
 */
/** the titles of badges from the game catalogue (code → the name in the interface language) */
const BadgeTitles = createContext<ReadonlyMap<string, string> | undefined>(undefined);

export function LeaguesScreen({ initial }: { initial?: LeagueTab }) {
  const { bff, nav, session } = useApp();
  const { t, l, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const res = useLoad(() => bff.leagues(), [session.learner.learner_id]);
  const v = res.data;
  // a badge outside the 9 named ones (a step added by the rules: streak_100, skills_50…) — its title from the catalogue
  const needCatalogue = !!v && leagueBadgeCodes(v).some((c) => !knownBadge(c));
  const [catalogue, setCatalogue] = useState<BadgeView[] | null>(null);
  useEffect(() => {
    if (!needCatalogue || catalogue) return;
    let alive = true;
    bff.gameBadges().then(
      (r) => alive && setCatalogue(r.items),
      () => undefined, // no catalogue — «значок» once
    );
    return () => {
      alive = false;
    };
  }, [bff, needCatalogue, catalogue]);
  const titles = useMemo(() => (catalogue ? new Map(catalogue.map((b) => [b.code, l(b.title)])) : undefined), [catalogue, l]);
  const tabs = v ? leagueTabs(v, kid) : [];
  const [pick, setPick] = useState<LeagueTab | null>(initial ?? null);
  const tab: LeagueTab | null = pick && tabs.includes(pick) ? pick : (tabs[0] ?? null);
  return (
    <BadgeTitles.Provider value={titles}>
      <Bar title={t("lg.title")} onBack={nav.back} />
      <main className="scroll" data-testid="leagues" data-tab={tab ?? undefined}>
        {!v ? (
          res.loading ? <div className="pad"><Skeleton lines={4} /></div> : <SocialError error={res.error} errorObj={res.errorObj} onRetry={() => void res.reload()} service="gamification" />
        ) : (
          <div className="pad stack">
            <p className="sub ic-line" data-testid="lg-ends"><Icon name="calendar" size={16} /> {t(kid ? "lg.endsKid" : "lg.ends", { date: fmt.dateTime(v.ends_at) })}
            </p>
            {tabs.length > 1 ? (
              <Seg
                label={t("lg.tabs")}
                value={tab!}
                onChange={setPick}
                options={tabs.map((x) => ({ value: x, label: t(`lg.tab.${x}`) }))}
                testId="lg-tabs"
              />
            ) : null}
            {tab === "friends" ? (
              v.friends && v.friends.participants > 1 ? (
                <StandingsTable s={v.friends} kind="friend" kid={false} />
              ) : (
                <div className="card stack tight" data-testid="lg-friends-empty">
                  {v.friends ? <StandingsTable s={v.friends} kind="friend" kid={false} /> : null}
                  <p className="sub">{t("lg.friendsEmpty")}</p>
                  <Btn variant="secondary" onClick={() => nav.push({ name: "friends" })}>{t("soc.link.friends")}</Btn>
                </div>
              )
            ) : null}
            {tab === "family" ? (
              v.family ? (
                <>
                  {kid ? <p className="sub ink" data-testid="lg-kid-note">{t("lg.kidNote")}</p> : null}
                  <StandingsTable s={v.family} kind="family" kid={kid} />
                </>
              ) : (
                <p className="sub" data-testid="lg-family-empty">{t("lg.familyEmpty")}</p>
              )
            ) : null}
            {tab === "general" && !kid ? <GeneralPanel v={v} onChange={(n) => res.setData(n)} reload={() => void res.reload()} /> : null}
            {tab !== "general" ? <p className="sub small">{t("lg.noPrizes")}</p> : null}
            <p className="sub small">{t("lg.howXp")}</p>
            <PrivacyNote kid={kid} />
          </div>
        )}
      </main>
    </BadgeTitles.Provider>
  );
}

/** A table of standings: places (not for children), heroes, nicknames, XP of the week, allowed badges, «вы» on my row
 *  (a word and a frame, not colour only). */
function StandingsTable({ s, kind, kid, prizes }: { s: Standings; kind: "friend" | "family" | "general"; kid: boolean; prizes?: readonly number[] }) {
  const { t } = useI18n();
  const places = showPlaces(kid);
  const rows = standingRows(s);
  return (
    <section className="stack tight" data-testid={`lg-table-${kind}`}>
      {kind !== "general" ? (
        <p className="sub ink lg-total ic-line" data-testid="lg-total">
          <Icon name="spark" size={16} />
          {kid ? t("lg.togetherKid", { n: s.total_xp }) : t("lg.together", { n: s.total_xp })}
        </p>
      ) : null}
      {!kid ? <p className="sub small">{t("lg.participants", { n: s.participants })}</p> : null}
      <ol className="list lg-list" aria-label={t("lg.title")}>
        {rows.map((r) => (
          <LeagueRow key={r.member_id} r={r} kind={kind} kid={kid} places={places} prize={prizes ? prizeOf(prizes, r.place) : null} gap={!!s.me_row && r === s.me_row && !s.rows.some((x) => x.me)} />
        ))}
      </ol>
    </section>
  );
}

function LeagueRow({ r, kind, kid, places, prize, gap }: { r: StandingRow; kind: "friend" | "family" | "general"; kid: boolean; places: boolean; prize: number | null; gap: boolean }) {
  const { t, tp } = useI18n();
  const titles = useContext(BadgeTitles);
  // my row: my nickname with «· вы», or just «Вы» / «Ты» when no nickname is set
  const name = r.me ? (r.nickname ?? t(kid ? "soc.youKid" : "soc.you")) : memberLabel(r.nickname, t, kind === "family" ? "family" : "friend");
  const mark = r.me && !!r.nickname;
  // allowed badges by name (never codes), in the name of the row too: the icons themselves are decorative
  const badges = badgeNames(r.badges.slice(0, 3), t, titles);
  const base = places ? t("lg.placeAria", { place: r.place, name, xp: r.xp }) : t("lg.rowAriaKid", { name, xp: r.xp });
  const aria = badges.length ? `${base}, ${t("lg.badges", { list: badges.join(", ") })}` : base;
  return (
    <li className={cx("row lg-row", r.me && "me", gap && "gap")} aria-label={aria} data-testid={r.me ? "lg-me" : "lg-row"} data-place={places ? r.place : undefined}>
      {places ? (
        <span className={cx("lg-place", r.place <= 3 && "top")} aria-hidden="true">
          {r.place}
        </span>
      ) : null}
      <MemberAvatar hero={r.hero} me={r.me} />
      <span className="t" aria-hidden="true">
        <b>
          {name}
          {mark ? <span className="lg-me-mark"> · {t(kid ? "lg.meMarkKid" : "lg.meMark")}</span> : null}
        </b>
        {badges.length ? (
          <span className="lg-badges" title={badges.join(", ")} data-testid="lg-badges">
            {r.badges.slice(0, 3).map((b) => (
              <Icon key={b} name="medal" size={14} />
            ))}
          </span>
        ) : null}
        {prize ? <span className="sub small">{t("lg.prizeOf", { n: prize, w: tp("game.tilsWord", prize) })}</span> : null}
      </span>
      <b className="lg-xp" aria-hidden="true">{t("lg.xp", { n: r.xp })}</b>
    </li>
  );
}

/**
 * The general league: what it is and what others see before joining (only the nickname, 14+, by choice); join (409
 * NICKNAME_REQUIRED → «Задать ник»), my group with places and prizes, «группа назначится» before the tick, leave.
 */
function GeneralPanel({ v, onChange, reload }: { v: LeaguesView; onChange: (v: LeaguesView) => void; reload: () => void }) {
  const { bff, nav } = useApp();
  const { t, tp } = useI18n();
  const g: GeneralLeague = v.general;
  const [nick, setNick] = useState(false);
  const set = useSocialAction(async (on: boolean) => {
    if (!on) {
      const ok = await confirmPopup({ title: t("lg.gen.leaveQ"), message: t("lg.gen.leaveText"), ok: t("lg.gen.leave"), cancel: t("c.cancel"), destructive: true });
      if (!ok) return;
    }
    try {
      await bff.patchGameSettings({ league_opt_in: on });
    } catch (e) {
      if (e instanceof ApiError && e.code === "NICKNAME_REQUIRED") setNick(true);
      throw e;
    }
    onChange({ ...v, general: { ...g, opt_in: on } });
    showToast(on ? t("lg.gen.on") : t("lg.gen.off"));
    reload();
  });
  const prizes = g.prizes.map((n, i) => t("lg.prize", { place: i + 1, n, w: tp("game.tilsWord", n) }));
  return (
    <section className="stack" aria-labelledby="lg-gen" data-testid="lg-general" data-opt-in={g.opt_in}>
      <h2 className="h3" id="lg-gen">{t("lg.gen.title")}</h2>
      {!g.opt_in ? (
        <div className="card stack tight" data-testid="lg-explain">
          <p className="sub ink">{t("lg.gen.what")}</p>
          <p className="sub ink ic-line"><Icon name="shield" size={16} /> {t("lg.gen.only")}</p>
          <ul className="lg-facts">
            <li><Icon name="check" size={16} stroke={2.4} /> {t("lg.gen.seen")}</li>
            <li><Icon name="lock" size={16} /> {t("lg.gen.notSeen")}</li>
          </ul>
        </div>
      ) : null}
      {!g.available && g.unavailable_reason ? (
        <div className="card warn stack tight" role="status" data-testid="lg-why" data-reason={g.unavailable_reason}>
          <p className="sub ink">{t(generalReasonKey(g.unavailable_reason))}</p>
          {g.unavailable_reason === "nickname_required" ? (
            <Btn variant="secondary" onClick={() => setNick(true)} data-testid="lg-set-nick">{t("fr.nickSet")}</Btn>
          ) : g.unavailable_reason === "restricted" ? (
            <Btn variant="link" onClick={() => nav.push({ name: "sanctions" })}>{t("soc.toSanctions")}</Btn>
          ) : g.unavailable_reason === "hidden" ? (
            <Btn variant="link" onClick={() => nav.push({ name: "friends" })}>{t("soc.link.friends")}</Btn>
          ) : g.unavailable_reason === "guardian_consent" ? (
            <Btn variant="link" onClick={() => nav.push({ name: "guardian" })}>{t("profile.guardian")}</Btn>
          ) : null}
        </div>
      ) : null}
      {!g.opt_in ? (
        <Btn busy={set.busy} disabled={!g.available} onClick={() => void set.run(true)} data-testid="lg-join">
          <Icon name="trophy" size={18} />
          {t("lg.gen.join")}
        </Btn>
      ) : (
        <>
          <p className="sub ink ic-line" data-testid="lg-joined"><Icon name="check" size={16} stroke={2.4} /> {t("lg.gen.on")}</p>
          {g.pair_id && g.level_band ? <p className="sub small" data-testid="lg-group">{t("lg.gen.group", { pair: g.pair_id.toUpperCase(), band: g.level_band })}</p> : null}
          {g.group ? <StandingsTable s={g.group} kind="general" kid={false} prizes={g.prizes} /> : <p className="sub card" data-testid="lg-pending">{t("lg.gen.pending")}</p>}
        </>
      )}
      {prizes.length ? (
        <div className="card stack tight" data-testid="lg-prizes">
          <span className="cap">{t("lg.prizes")}</span>
          {prizes.map((p) => (
            <p key={p} className="sub ink"><Icon name="coin" size={16} /> {p}</p>
          ))}
        </div>
      ) : null}
      <ErrorLine text={set.error} />
      <div className="hrow between">
        <Btn variant="link" onClick={() => nav.push({ name: "leagueHistory" })} data-testid="lg-history">
          <Icon name="list" size={16} />
          {t("lg.history")}
        </Btn>
        {g.opt_in ? (
          <Btn variant="link" busy={set.busy} onClick={() => void set.run(false)} data-testid="lg-leave">
            {t("lg.gen.leave")}
          </Btn>
        ) : null}
      </div>
      {nick ? (
        <NicknameSheet
          current={null}
          onClose={() => setNick(false)}
          onSaved={() => {
            setNick(false);
            set.setError(null);
            reload();
          }}
        />
      ) : null}
    </section>
  );
}

/** My results of past weeks in the general league (the last version of the group's results). */
export function LeagueHistoryScreen() {
  const { bff, nav, session } = useApp();
  const { t, tp, fmt } = useI18n();
  const res = useLoad(() => bff.leagueHistory(), [session.learner.learner_id]);
  const items = res.data?.items ?? [];
  return (
    <>
      <Bar title={t("lg.hist.title")} onBack={nav.back} />
      <main className="scroll" data-testid="league-history">
        <div className="pad stack">
          {!res.data ? (
            res.loading ? <Skeleton lines={3} /> : <SocialError error={res.error} errorObj={res.errorObj} onRetry={() => void res.reload()} service="gamification" />
          ) : items.length ? (
            <ul className="stack tight">
              {items.map((r) => (
                <li key={`${r.week}:${r.version}`} className="card stack tight" data-testid="lg-hist-row">
                  <span className="cap">{t("lg.hist.week", { date: fmt.localDate(r.week) })} · {r.pair_id.toUpperCase()} · {r.level_band}</span>
                  <b className="h3">{t("lg.hist.place", { place: r.place, n: r.participants })}</b>
                  <span className="sub">{t("lg.xp", { n: r.xp })}{r.prize_til > 0 ? ` · ${t("lg.hist.prize", { n: r.prize_til, w: tp("game.tilsWord", r.prize_til) })}` : ""}</span>
                  <span className="pills">
                    {r.prize_held ? <Pill tone="warn">{t("lg.hist.held")}</Pill> : null}
                    {r.version > 1 ? <Pill tone="mute">{t("lg.hist.version")}</Pill> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub" data-testid="lg-hist-empty">{t("lg.hist.empty")}</p>
          )}
        </div>
      </main>
    </>
  );
}

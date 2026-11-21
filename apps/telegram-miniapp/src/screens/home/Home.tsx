import type { GameSummary, HomeSectionType, LessonSession, TodayPlan } from "@tilhero/contracts/bff";
import { Fragment } from "react";
import { flag, homeSections } from "../../config/experience";
import { weekState } from "../../domain/game";
import { isOpen } from "../../domain/lessons";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp, usePlan } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Margin, NoBreakHyphens, Pill, Skeleton } from "../../ui/kit";
import { GameBlock } from "../game/GameBlock";
import { FreezeChip } from "../game/parts";
import { ActiveCard } from "../lessons/LessonsTab";
import { ReviewCard } from "../memory/ReviewCard";
import { SocialCard } from "../social/SocialCard";
import { scheduleSummary } from "../schedule/parts";

/** ISO weekday (1=Mon … 7=Sun) of a plan date "YYYY-MM-DD" (calendar arithmetic, no time zone). */
export function isoWeekday(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function greetingKey(hour: number): MessageKey {
  if (hour >= 5 && hour < 12) return "home.hello.morning";
  if (hour >= 12 && hour < 17) return "home.hello.day";
  if (hour >= 17 && hour < 23) return "home.hello.evening";
  return "home.hello.night";
}

/**
 * Home: the plan for today by the learner's own schedule (slot, duration, «Начать занятие» → the next lesson, an
 * unfinished one — «Продолжить урок»), the week, the game block and the sections of Remote Experience Config. Sessions
 * are counted from the lessons themselves (sprint 4): there is no manual «Отметить занятие» any more.
 * Sprint 6 (APP-PROG-01): the streak with the stock of freezes, a missed day closed by a freeze in the week, the hero,
 * level, tils and quests of the day (GameBlock). The game is quiet: its failure (GAME_UNAVAILABLE) only hides the block;
 * the flag `game` of Remote Experience Config switches it off.
 */
export function Home() {
  const { bff, session, config, nav } = useApp();
  const plan = usePlan();
  const { t, tp } = useI18n();
  const today = useLoad(() => bff.today(), [plan.learner_id, plan.version]);
  // an unfinished lesson: «Продолжить урок» instead of «Начать занятие» (a failure just hides it)
  const active = useLoad(() => bff.activeSession(true).catch(() => ({ session: null })), [plan.learner_id]);
  const activeSession = active.data?.session ?? null;
  const kid = session.learner.kind === "child";
  const news = flag(config, "news");
  const sections = homeSections(config).filter(
    (s) => !(s === "family" && (kid || !flag(config, "family_invites"))) && !((s === "news" || s === "whats_new") && !news),
  );
  const name = session.learner.display_name;
  const tp0 = today.data;
  const gameOn = flag(config, "game");
  // a failure of the game never blocks Home: the block is simply not shown (bff.gameSummary is quiet)
  const game = useLoad<GameSummary | null>(() => (gameOn ? bff.gameSummary(true) : Promise.resolve(null)), [session.learner.learner_id, gameOn]);
  const g = game.error ? null : game.data;
  // the game block goes after the learning sections (today, the lesson, the review): learning first
  const shown = sections.filter((s, i) => !(s === "news" && sections.slice(0, i).includes("whats_new")));
  const anchor = [...shown].reverse().find((s) => s === "today_plan" || s === "lesson_of_day" || s === "review") ?? "today_plan";

  return (
    <main className="scroll" data-testid="home">
      <div className="stack home">
        <Margin note={tp0 ? t(`day.${isoWeekday(tp0.local_date)}` as MessageKey).toLowerCase() : ""} tone="b">
          <p className="sub">{t(greetingKey(new Date().getHours()), { name })}</p>
          <h1 className="h1 today-title" data-testid="today-title">
            {!tp0 ? t("home.loading") : tp0.done_today ? t("home.todayDone") : tp0.is_scheduled_today ? t("home.today", { n: tp0.duration_min, min: tp(`c.minutesWord`, tp0.duration_min) }) : t("home.todayRest")}
          </h1>
          {tp0 ? (
            <div className="stat mt10">
              <span className="stt" aria-label={t("home.streakAria", { n: tp0.streak_days, days: tp("c.daysWord", tp0.streak_days) })}>
                <span className="flame"><Icon name="flame" size={20} /></span>
                {tp0.streak_days}
              </span>
              {g ? <FreezeChip n={g.freeze_stock} max={g.freeze_max} testId="home-freezes" /> : null}
              <span className="stt" aria-label={t("home.minutesAria", { n: tp0.minutes_today })}>
                <Icon name="clock" size={20} />
                {t("c.minutesN", { n: tp0.minutes_today })}
              </span>
            </div>
          ) : null}
        </Margin>

        {shown.map((s) => (
          <Fragment key={s}>
            <Section type={s} today={today} active={activeSession} withToday={sections.includes("today_plan")} />
            {s === anchor ? (
              <>
                <GameBlock s={g} />
                <SocialCard />
              </>
            ) : null}
          </Fragment>
        ))}

        {kid ? (
          <Margin>
            <div className="card warn">
              <p className="sub ink">{t("home.kid", { name })}</p>
            </div>
          </Margin>
        ) : null}
        {news ? (
          <div className="pad">
            <Btn variant="link" className="c" onClick={() => nav.push({ name: "news" })}>
              <Icon name="news" size={18} />
              {t("home.allNews")}
            </Btn>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function Section({ type, today, active, withToday }: { type: HomeSectionType; today: ReturnType<typeof useLoad<TodayPlan>>; active: LessonSession | null; withToday: boolean }) {
  switch (type) {
    case "today_plan":
      return <TodaySection today={today} active={active} />;
    case "lesson_of_day":
      return <LearningSection active={withToday ? null : active} />;
    case "whats_new":
    case "news":
      return <NewsCard />;
    case "family":
      return <FamilyCard />;
    case "review":
      return <ReviewSection />;
    default:
      return null;
  }
}

function TodaySection({ today, active }: { today: ReturnType<typeof useLoad<TodayPlan>>; active: LessonSession | null }) {
  const { bff, nav, session } = useApp();
  const plan = usePlan();
  const { t, l, fmt } = useI18n();
  const open = isOpen(active) ? active : null;
  // «Начать занятие» leads to the lesson: an unfinished one, else the next lesson of the plan, else the «Уроки» tab
  const go = useAction(async () => {
    if (open) {
      nav.push({ name: "player", sessionId: open.session_id });
      return;
    }
    const tr = await bff.trajectory(true).catch(() => null);
    if (tr?.next && tr.lessons_available) nav.push({ name: "lessonCard", id: tr.next.lesson_id });
    else nav.goTab("lessons");
  });
  const d = today.data;
  const kid = session.learner.kind === "child";

  if (today.loading && !d) return <div className="pad"><Skeleton lines={2} /></div>;
  if (today.error && !d) {
    return (
      <div className="pad">
        <div className="card err stack tight">
          <p className="sub ink">{today.error}</p>
          <Btn variant="secondary" onClick={() => void today.reload()}>{t("c.retry")}</Btn>
        </div>
      </div>
    );
  }
  if (!d) return null;
  const slot = d.slot_time ?? plan.schedule.preferred_time;
  const anyFrozen = d.week.some((w) => weekState(w) === "frozen");

  return (
    <>
      <Margin note={d.done_today ? "✓" : slot} tone={d.done_today ? "g" : "b"}>
        <section className="card lift stack" aria-labelledby="today-cap" data-testid="today-card">
          <div className="cap" id="today-cap">
            {d.is_scheduled_today ? t("home.byPlan", { time: slot, n: d.duration_min }) : t("home.restDay")}
          </div>
          <p className="h2">
            {d.done_today ? t("home.doneLine") : d.is_scheduled_today ? t("home.slotLine", { time: slot }) : d.next_slot ? t("home.nextLine", { day: dayName(d.next_slot.local_date, t, fmt.localDate), time: d.next_slot.time }) : t("home.noSlot")}
          </p>
          <ErrorLine text={go.error} />
          {/* sprint 4: sessions are counted from the lessons — the day card leads to the lesson (no manual marking) */}
          <div className="plan-actions">
            <Btn busy={go.busy} onClick={() => void go.run()} data-testid="start-lesson">
              <Icon name={open ? "play" : "lessons"} size={18} />
              {open ? t("ls.continue") : t("home.start")}
            </Btn>
          </div>
          {open ? <p className="sub small" data-testid="today-active">{t("home.continueCap")} · {l(open.title)}</p> : null}
          <p className="sub small">{d.done_today ? t("home.doneHint", { n: d.minutes_today }) : t("home.startHint")}</p>
          {!plan.schedule.reminders_enabled ? (
            <Btn variant="link" onClick={() => nav.route("schedule")}>
              <Icon name="bell" size={18} />
              {kid ? t("home.remindersOffKid") : t("home.remindersOff")}
            </Btn>
          ) : null}
        </section>
      </Margin>
      <Margin note={t("home.weekNote")} tone="g" tilt>
        <section className="card stack tight" aria-labelledby="week-title">
          <div className="hrow between">
            <h2 className="h3" id="week-title">{t("home.week")}</h2>
            <Btn variant="link" onClick={() => nav.route("schedule")} data-testid="edit-schedule">
              {t("home.editSchedule")}
            </Btn>
          </div>
          <p className="sub small">{scheduleSummary(plan.schedule, t)}</p>
          <ol className="week" aria-label={t("home.week")}>
            {d.week.map((w) => {
              const wd = isoWeekday(w.local_date);
              // sprint 6: a missed day of the schedule closed by a freeze — a snowflake and a dashed frame, not colour only
              const state = weekState(w);
              const isToday = w.local_date === d.local_date;
              return (
                <li
                  key={w.local_date}
                  className={cx("wd", w.scheduled && "sch", state === "done" && "done", state === "missed" && "miss", state === "frozen" && "frz", isToday && "today")}
                  aria-label={`${t(`dayLong.${wd}` as MessageKey)}: ${t(`wd.${state}` as MessageKey)}${isToday ? `, ${t("home.todayMark")}` : ""}`}
                  data-state={state}
                >
                  <span aria-hidden="true">{t(`day.${wd}` as MessageKey)}</span>
                  <b aria-hidden="true" className="wd-ic">
                    {state === "done" ? "✓" : state === "frozen" ? <Icon name="snow" size={14} stroke={2.2} /> : state === "missed" ? "–" : w.scheduled ? "•" : ""}
                  </b>
                </li>
              );
            })}
          </ol>
          {anyFrozen ? (
            <p className="sub small frz-legend" data-testid="frozen-legend">
              <Icon name="snow" size={16} />
              {kid ? t("home.frozenLegendKid") : t("home.frozenLegend")}
            </p>
          ) : null}
        </section>
      </Margin>
    </>
  );
}

function dayName(ymd: string, t: (k: MessageKey) => string, localDate: (s: string) => string): string {
  return `${t(`dayLong.${isoWeekday(ymd)}` as MessageKey)}, ${localDate(ymd)}`;
}

/**
 * Sprint 3: the learning entry of Home. No placement test yet → «Узнаем ваш уровень · 10–15 минут»; an unfinished one →
 * «Продолжить»; done → «Следующий урок» from the trajectory with «почему» (explanation), «Начать урок» (the honest
 * «скоро» of the lessons tab), links to «Мой план» and «Карта навыков»; then «Практика».
 */
function LearningSection({ active }: { active: LessonSession | null }) {
  const { bff, nav, session } = useApp();
  const plan = usePlan();
  const { t, l } = useI18n();
  const kid = session.learner.kind === "child";
  const dx = useLoad(() => bff.diagnosticsState(true), [session.learner.learner_id]);
  const done = dx.data?.status === "completed";
  const tr = useLoad(() => (done ? bff.trajectory(true) : Promise.resolve(null)), [done, plan.version, session.learner.learner_id]);
  const st = dx.data;
  const next = tr.data?.next ?? null;

  let card;
  if (dx.loading && !st) {
    card = <div className="pad"><Skeleton lines={2} /></div>;
  } else if (!st) {
    card = dx.error ? (
      <div className="pad">
        <div className="card warn stack tight">
          <p className="sub ink">{dx.error}</p>
          <Btn variant="secondary" onClick={() => void dx.reload()}>{t("c.retry")}</Btn>
        </div>
      </div>
    ) : null;
  } else if (!done) {
    const resume = st.status === "in_progress" && st.session;
    card = (
      <Margin note={t("home.dx.note")} tone="b" tilt>
        <section className="card lift stack tight" aria-labelledby="home-dx-cap" data-testid="home-diag-card">
          <div className="cap" id="home-dx-cap">
            {resume ? t("home.dx.resumeCap", { n: st.session!.answered, m: Math.max(st.session!.total_estimate, st.session!.answered) }) : kid ? t("home.dx.capKid") : t("home.dx.cap")}
          </div>
          <h2 className="h2"><NoBreakHyphens text={kid ? t("home.dx.titleKid") : t("home.dx.title")} /></h2>
          <p className="sub">{kid ? t("home.dx.textKid") : t("home.dx.text")}</p>
          <Btn onClick={() => nav.push({ name: "diagnostics" })} data-testid="home-diag-start">
            <Icon name="target" size={18} />
            {resume ? t("home.dx.resume") : t("home.dx.start")}
          </Btn>
        </section>
      </Margin>
    );
  } else {
    card = (
      <Margin note={t("home.next.note")} tilt>
        <section className="card lift stack tight" aria-labelledby="home-next-cap" data-testid="home-next-lesson">
          {tr.loading && !tr.data ? (
            <Skeleton lines={2} />
          ) : next ? (
            <>
              <div className="cap" id="home-next-cap">{t("home.next.cap", { level: next.level, n: next.duration_min })}</div>
              <h2 className="h2"><NoBreakHyphens text={l(next.title)} /></h2>
              <p className="sub" data-testid="home-next-why">{l(next.explanation)}</p>
              {next.reason_codes.includes("repeat") ? (
                <div className="pills"><Pill tone="mute">{t("plan.reason.repeat")}</Pill></div>
              ) : null}
              <Btn disabled={!tr.data?.lessons_available} onClick={() => nav.push({ name: "lessonCard", id: next.lesson_id })} data-testid="home-start-lesson">
                <Icon name="lessons" size={18} />
                {t("home.next.start")}
              </Btn>
            </>
          ) : (
            <>
              <div className="cap" id="home-next-cap">{t("plan.title")}</div>
              <p className="sub ink">{tr.error ? t("home.planError") : t("plan.empty")}</p>
              {tr.error ? <Btn variant="secondary" onClick={() => void tr.reload()}>{t("c.retry")}</Btn> : null}
            </>
          )}
          <div className="hrow between">
            <Btn variant="link" onClick={() => nav.push({ name: "plan" })} data-testid="home-plan-link">
              <Icon name="route" size={18} />
              {t("home.myPlan")}
            </Btn>
            <Btn variant="link" onClick={() => nav.goTab("progress")} data-testid="home-skills-link">
              <Icon name="map" size={18} />
              {t("home.skills")}
            </Btn>
          </div>
        </section>
      </Margin>
    );
  }
  return (
    <>
      {active ? <ActiveCard session={active} compact /> : null}
      {card}
      <Margin>
        <button type="button" className="row boxed" onClick={() => nav.push({ name: "practice" })} data-testid="home-practice">
          <span className="nic"><Icon name="chat" size={20} /></span>
          <span className="t">
            <b>{t("home.practice.title")}</b>
            <span>{t("home.practice.text")}</span>
          </span>
          <Icon name="chevron" size={20} stroke={2} />
        </button>
      </Margin>
    </>
  );
}

/** Sprint 5: «Повторение дня» (MemoryOverview); a failure of memory hides the card, never blocks Home. */
function ReviewSection() {
  const { bff, session } = useApp();
  const ov = useLoad(() => bff.memoryOverview(true), [session.learner.learner_id]);
  return <ReviewCard overview={ov.data} loading={ov.loading} />;
}

function NewsCard() {
  const { nav } = useApp();
  const { t } = useI18n();
  return (
    <Margin note="new" tone="b">
      <button type="button" className="row boxed" onClick={() => nav.push({ name: "news" })} data-testid="news-card">
        <span className="t">
          <span>{t("home.newsCap")}</span>
          <b>{t("home.newsTitle")}</b>
        </span>
        <Icon name="chevron" size={20} stroke={2} />
      </button>
    </Margin>
  );
}

function FamilyCard() {
  const { nav } = useApp();
  const { t } = useI18n();
  return (
    <Margin>
      <button type="button" className="row boxed" onClick={() => nav.route("family")} data-testid="family-card">
        <span className="nic"><Icon name="users" size={20} /></span>
        <span className="t">
          <b>{t("home.familyTitle")}</b>
          <span>{t("home.familyText")}</span>
        </span>
        <Icon name="chevron" size={20} stroke={2} />
      </button>
    </Margin>
  );
}

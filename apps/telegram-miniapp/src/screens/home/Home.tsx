import type { HomeSectionType, TodayPlan } from "@tilhero/contracts/bff";
import { useRef } from "react";
import { flag, homeSections } from "../../config/experience";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp, usePlan } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { newIdempotencyKey } from "../../api/client";
import { haptic } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, HERO, Hero, Margin, Pill, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
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
 * Home: the plan for today by the learner's own schedule (slot, duration, marking a session), the week, the hero
 * and the sections of Remote Experience Config. Lessons, reviews and the hero's growth arrive in later sprints.
 */
export function Home() {
  const { bff, session, config, nav } = useApp();
  const plan = usePlan();
  const { t, tp } = useI18n();
  const today = useLoad(() => bff.today(), [plan.learner_id, plan.version]);
  const kid = session.learner.kind === "child";
  const news = flag(config, "news");
  const sections = homeSections(config).filter(
    (s) => !(s === "family" && (kid || !flag(config, "family_invites"))) && !((s === "news" || s === "whats_new") && !news),
  );
  const name = session.learner.display_name;
  const tp0 = today.data;

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
              <span className="stt" aria-label={t("home.minutesAria", { n: tp0.minutes_today })}>
                <Icon name="clock" size={20} />
                {t("c.minutesN", { n: tp0.minutes_today })}
              </span>
            </div>
          ) : null}
        </Margin>

        {sections
          .filter((s, i) => !(s === "news" && sections.slice(0, i).includes("whats_new")))
          .map((s) => (
            <Section key={s} type={s} today={today} />
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

function Section({ type, today }: { type: HomeSectionType; today: ReturnType<typeof useLoad<TodayPlan>> }) {
  switch (type) {
    case "today_plan":
      return <TodaySection today={today} />;
    case "lesson_of_day":
      return <LessonSoon />;
    case "whats_new":
    case "news":
      return <NewsCard />;
    case "family":
      return <FamilyCard />;
    case "review":
      return null;
    default:
      return null;
  }
}

function TodaySection({ today }: { today: ReturnType<typeof useLoad<TodayPlan>> }) {
  const { bff, nav, session } = useApp();
  const plan = usePlan();
  const { t, fmt } = useI18n();
  const key = useRef<string | null>(null);
  const mark = useAction(async () => {
    // one key per tap; a retry after a lost answer reuses it, so the session is counted once
    key.current ??= newIdempotencyKey();
    const res = await bff.recordActivity({ kind: "practice", minutes: plan.schedule.duration_min }, key.current);
    key.current = null;
    today.setData(res);
    haptic.notify("success");
    showToast(t("home.marked", { n: plan.schedule.duration_min }));
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
          <p className="sub">{d.done_today ? t("home.doneHint", { n: d.minutes_today }) : t("home.markHint")}</p>
          <ErrorLine text={mark.error} />
          <Btn variant={d.done_today ? "secondary" : "primary"} busy={mark.busy} onClick={() => void mark.run()} data-testid="mark-activity">
            <Icon name="check" size={18} />
            {d.done_today ? t("home.markMore") : t("home.mark")}
          </Btn>
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
              const state = w.done ? "done" : w.missed ? "missed" : w.scheduled ? "planned" : "rest";
              const isToday = w.local_date === d.local_date;
              return (
                <li
                  key={w.local_date}
                  className={cx("wd", w.scheduled && "sch", w.done && "done", w.missed && "miss", isToday && "today")}
                  aria-label={`${t(`dayLong.${wd}` as MessageKey)}: ${t(`wd.${state}` as MessageKey)}${isToday ? `, ${t("home.todayMark")}` : ""}`}
                >
                  <span aria-hidden="true">{t(`day.${wd}` as MessageKey)}</span>
                  <b aria-hidden="true">{w.done ? "✓" : w.missed ? "–" : w.scheduled ? "•" : ""}</b>
                </li>
              );
            })}
          </ol>
        </section>
      </Margin>
      <HeroCard />
    </>
  );
}

function dayName(ymd: string, t: (k: MessageKey) => string, localDate: (s: string) => string): string {
  return `${t(`dayLong.${isoWeekday(ymd)}` as MessageKey)}, ${localDate(ymd)}`;
}

function HeroCard() {
  const { session } = useApp();
  const { t } = useI18n();
  const kid = session.learner.kind === "child";
  return (
    <Margin>
      <div className="card k hero-card" data-testid="hero-card">
        <Hero src={kid ? HERO.myatikEgg : HERO.volt} alt={kid ? t("hero.myatik") : t("hero.volt")} />
        <div className="grow">
          <b className="h3">{kid ? t("home.heroKid") : t("home.hero")}</b>
          <p className="sub mt4">{t("home.heroText")}</p>
          <div className="prog mt8" aria-hidden="true">
            <div style={{ width: "8%" }} />
          </div>
        </div>
      </div>
    </Margin>
  );
}

function LessonSoon() {
  const { t } = useI18n();
  return (
    <Margin note={t("home.lessonNote")} tilt>
      <div className="card stack tight">
        <div className="hrow between">
          <div className="cap">{t("home.lessonCap")}</div>
          <Pill tone="mute">{t("c.soon")}</Pill>
        </div>
        <p className="h3">{t("home.lessonTitle")}</p>
        <p className="sub">{t("home.lessonText")}</p>
      </div>
    </Margin>
  );
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

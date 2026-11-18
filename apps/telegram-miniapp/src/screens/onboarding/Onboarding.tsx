import type { AgeBand, DirectoryItem, Goal, LearningPlan, LevelSelf, PolicyDocument, Schedule } from "@tilhero/contracts/bff";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api/errors";
import { flag } from "../../config/experience";
import { agesFor, consentIsCurrent, nextStep, obSteps, optionalAllowed, prevStep, stepForMissing, type ObStart, type ObStep, type Who } from "../../domain/onboarding";
import { children, isChildBand } from "../../domain/people";
import { DEFAULT_SCHEDULE, scheduleProblem } from "../../domain/schedule";
import { useI18n, type Lang, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { keyForDraft, type DraftKey } from "../../state/idempotency";
import { optInPatch } from "../../state/reminders";
import { requestWriteAccess, shareToTelegram } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, Check, Chip, Field, HERO, Hero, Opt, Pill, Seg, TextInput, ToggleRow } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { PinOffer } from "../profile/ParentCode";
import { DaysPicker, DurationPicker, TimePicker, ZonePicker, daysText, timeError } from "../schedule/parts";
import { ObFrame } from "./frame";

export const GOALS: readonly Goal[] = ["work", "career", "travel", "daily", "study", "exam"];
export const LEVELS: readonly LevelSelf[] = ["zero", "beginner", "some", "confident"];
const REQUIRED = ["terms", "privacy", "learning"];

/**
 * Onboarding (APP-ONB-01…03, AT-02…06): language → who and age → child profile | parent link → consents → goal →
 * level → days and time → duration, reminders and time zone → done. Each step is stored on the server when the user
 * continues, so a returning user resumes with the same answers (AT-01).
 */
export function Onboarding({ onFinished }: { onFinished: (plan: LearningPlan) => void }) {
  const app = useApp();
  const { session, plan, deviceTz } = app;
  const { lang, setLang } = useI18n();

  const start = useRef<ObStart>({ firstRun: session.account.age_band == null, consentOk: consentIsCurrent(session.consent) }).current;
  const [who, setWho] = useState<Who | null>(null);
  const [age, setAge] = useState<AgeBand | null>(null);
  const [child, setChild] = useState<ChildDraft>({ name: "", adult: false });
  const steps = useMemo(() => obSteps(start, { who, age }), [start, who, age]);
  const [step, setStep] = useState<ObStep>(() => steps[0]!);
  const [done, setDone] = useState<LearningPlan | null>(null);
  const committed = { ageSet: session.account.age_band != null, childCreated: session.learner.kind === "child" };
  const kid = session.learner.kind === "child" || who === "child";

  // drafts of the plan, reset whenever the active learner (and so the plan) changes
  const [goal, setGoal] = useState<Goal | null>(plan?.goal ?? null);
  const [level, setLevel] = useState<LevelSelf | null>(plan?.level_self ?? null);
  const fresh = (p: LearningPlan | null): Schedule => {
    const s = p?.schedule ?? DEFAULT_SCHEDULE;
    return p?.onboarding_completed_at ? s : { ...s, timezone: deviceTz };
  };
  const [schedule, setSchedule] = useState<Schedule>(() => fresh(plan));
  const [missed, setMissed] = useState(false);
  const learnerId = plan?.learner_id;
  useEffect(() => {
    setGoal(plan?.goal ?? null);
    setLevel(plan?.level_self ?? null);
    setSchedule(fresh(plan));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learnerId]);

  const go = (s: ObStep | "done") => {
    if (s !== "done") setStep(s);
  };
  const n = steps.indexOf(step) + 1;
  const m = steps.length;
  const back = (() => {
    const p = prevStep(steps, step, committed);
    return p ? () => setStep(p) : null;
  })();
  const frame = { n, m, onBack: back };

  if (done) return <DoneStep plan={done} onOpen={() => onFinished(done)} />;

  switch (step) {
    case "lang":
      return <LangStep lang={lang} onLang={setLang} onNext={() => go(nextStep(steps, "lang"))} />;
    case "who":
      return <WhoStep frame={frame} who={who} age={age} setWho={setWho} setAge={setAge} onNext={(s) => go(s ?? nextStep(steps, "who"))} steps={steps} />;
    case "child":
      return <ChildStep frame={frame} age={age} value={child} onChange={setChild} onNext={() => go(nextStep(steps, "child"))} />;
    case "teen":
      return <TeenStep frame={frame} onNext={() => go(nextStep(steps, "teen"))} />;
    case "consent":
      return <ConsentStep frame={frame} who={who} childAge={age} childName={child.name.trim()} onNext={() => go(nextStep(steps, "consent"))} />;
    case "goal":
      return <GoalStep frame={frame} kid={kid} value={goal} onChange={setGoal} onNext={() => go(nextStep(steps, "goal"))} />;
    case "level":
      return <LevelStep frame={frame} kid={kid} value={level} onChange={setLevel} onNext={() => go(nextStep(steps, "level"))} />;
    case "when":
      return <WhenStep frame={frame} kid={kid} value={schedule} onChange={setSchedule} onNext={() => go(nextStep(steps, "when"))} />;
    case "minutes":
      return (
        <MinutesStep
          frame={frame}
          kid={kid}
          value={schedule}
          onChange={setSchedule}
          missed={missed}
          setMissed={setMissed}
          onDone={setDone}
          onMissing={(s) => setStep(s)}
        />
      );
    default:
      return null;
  }
}

type FrameProps = { n: number; m: number; onBack: (() => void) | null };

/* ---------------------------------------------------------------- language (welcome) */
function LangStep({ lang, onLang, onNext }: { lang: Lang; onLang: (l: Lang) => void; onNext: () => void }) {
  const { bff, setPlan, config } = useApp();
  const { t } = useI18n();
  const uz = flag(config, "uz_ui") || lang === "uz";
  const save = useAction(async () => {
    // the interface language is stored in the profile and in the plan; the course stays ru → en (AT-05)
    await bff.patchSettings({ locale: lang });
    setPlan(await bff.patchPlan({ ui_lang: lang }));
    onNext();
  });
  return (
    <main className="ob" data-testid="ob-step-lang">
      <div className="ob-body welcome">
        <p className="brand" aria-label="TilHero">
          Til<span>Hero</span>
        </p>
        <div className="trio">
          <Hero src={HERO.voltUp} alt={t("hero.volt")} />
          <Hero src={HERO.nilu} alt={t("hero.nilu")} />
          <Hero src={HERO.myatik} alt={t("hero.myatik")} />
        </div>
        <h1 className="h1">{t("ob.welcome.title")}</h1>
        <p className="sub lead">{t("ob.welcome.text")}</p>
        <div className="stack tight">
          <span className="lb" id="ob-lang-label">{t("ob.welcome.lang")}</span>
          <Seg
            label={t("ob.welcome.lang")}
            labelledBy="ob-lang-label"
            value={lang}
            testId="lang"
            options={uz ? [
              { value: "ru", label: "Русский" },
              { value: "uz", label: "Oʻzbekcha" },
            ] : [{ value: "ru", label: "Русский" }]}
            onChange={onLang}
          />
          <p className="sub small">{t("ob.welcome.langNote")}</p>
        </div>
      </div>
      <div className="ob-foot">
        {save.error ? <p className="field-err" role="alert">{save.error}</p> : null}
        <Btn busy={save.busy} onClick={() => void save.run()} data-testid="ob-next">
          {t("ob.welcome.start")}
        </Btn>
      </div>
    </main>
  );
}

/* ---------------------------------------------------------------- who and age */
function WhoStep(props: {
  frame: FrameProps;
  who: Who | null;
  age: AgeBand | null;
  setWho: (w: Who) => void;
  setAge: (a: AgeBand | null) => void;
  onNext: (s?: ObStep) => void;
  steps: ObStep[];
}) {
  const { bff, syncProfile } = useApp();
  const { t } = useI18n();
  const { who, age } = props;
  const ages = agesFor(who);
  const save = useAction(async () => {
    if (who === "self" && (age === "14-17" || age === "18+")) {
      try {
        syncProfile(await bff.setAge({ age_band: age }));
      } catch (e) {
        // the age is already stored (a repeated tap, another device): continue with the stored one
        if (!(e instanceof ApiError && e.code === "AGE_ALREADY_SET")) throw e;
        syncProfile(await bff.profile());
      }
    }
    props.onNext();
  });
  return (
    <ObFrame
      id="who"
      {...props.frame}
      error={save.error}
      foot={
        <Btn busy={save.busy} disabled={!who || !age} onClick={() => void save.run()} data-testid="ob-next">
          {t("c.continue")}
        </Btn>
      }
    >
      <h1 className="h1">{t("ob.who.title")}</h1>
      <div className="opts">
        <Opt on={who === "self"} title={t("ob.who.self")} note={t("ob.who.selfNote")} onClick={() => (props.setWho("self"), props.setAge(null))} testId="who-self" />
        <Opt on={who === "child"} title={t("ob.who.child")} note={t("ob.who.childNote")} onClick={() => (props.setWho("child"), props.setAge(null))} testId="who-child" />
      </div>
      {ages.length ? (
        <fieldset className="stack tight">
          <legend className="sec">{who === "child" ? t("ob.who.age") : t("ob.who.selfAge")}</legend>
          <div className="chips">
            {ages.map((a) => (
              <Chip key={a} on={age === a} label={t(`age.${a}` as MessageKey)} ariaLabel={t(`ageAria.${a}` as MessageKey)} onClick={() => props.setAge(a)} />
            ))}
          </div>
        </fieldset>
      ) : null}
      {who === "self" ? (
        <div className={age === "14-17" ? "card warn" : "card"}>
          <p className="sub ink">{age === "14-17" ? t("ob.who.teen") : t("ob.who.under14")}</p>
        </div>
      ) : null}
      {who === "child" ? (
        <div className="card">
          <p className="sub ink">{t("ob.who.childTeen")}</p>
        </div>
      ) : null}
    </ObFrame>
  );
}

/* ---------------------------------------------------------------- child profile (6–13) */
interface ChildDraft {
  name: string;
  adult: boolean;
}

function ChildStep({ frame, age, value, onChange, onNext }: { frame: FrameProps; age: AgeBand | null; value: ChildDraft; onChange: (v: ChildDraft) => void; onNext: () => void }) {
  const { bff, session, syncProfile } = useApp();
  const { t } = useI18n();
  const { name, adult } = value;
  const setName = (v: string) => onChange({ ...value, name: v });
  const setAdult = (v: boolean) => onChange({ ...value, adult: v });
  const [touched, setTouched] = useState(false);
  const clean = name.trim();
  const nameOk = clean.length >= 1 && clean.length <= 40;
  const save = useAction(async () => {
    // the parent account is 18+ (only an adult creates a child profile — POST /v1/learners 403 ADULT_REQUIRED)
    if (session.account.age_band == null) {
      try {
        syncProfile(await bff.setAge({ age_band: "18+" }));
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "AGE_ALREADY_SET")) throw e;
        syncProfile(await bff.profile());
      }
    }
    onNext();
  });
  return (
    <ObFrame
      id="child"
      {...frame}
      error={save.error}
      foot={
        <Btn busy={save.busy} disabled={!nameOk || !adult} onClick={() => void save.run()} data-testid="ob-next">
          {t("ob.child.create")}
        </Btn>
      }
    >
      <h1 className="h1">{t("ob.child.title")}</h1>
      <p className="sub">{t("ob.child.text")}</p>
      <Field label={t("ob.child.name")} error={touched && !nameOk ? t("ob.child.nameErr") : null}>
        {(id, d) => (
          <TextInput
            id={id}
            aria-describedby={d}
            invalid={touched && !nameOk}
            value={name}
            maxLength={40}
            autoComplete="off"
            placeholder={t("ob.child.namePh")}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched(true)}
            data-testid="child-name"
          />
        )}
      </Field>
      <div className="card">
        <p className="h3">{t("ob.child.inProfile", { age: age ? t(`age.${age}` as MessageKey) : "" })}</p>
        <div className="kv"><span>{t("ob.child.rule1")}</span><Pill tone="mute">{t("ob.child.rule1v")}</Pill></div>
        <div className="kv"><span>{t("ob.child.rule2")}</span><Pill>{t("ob.child.rule2v")}</Pill></div>
        <div className="kv"><span>{t("ob.child.rule3")}</span><Pill tone="mute">{t("ob.child.rule3v")}</Pill></div>
      </div>
      <Check checked={adult} onChange={setAdult} testId="child-adult">
        {t("ob.child.adult")}
      </Check>
    </ObFrame>
  );
}

/* ---------------------------------------------------------------- teen 14–17: link for the parent */
function TeenStep({ frame, onNext }: { frame: FrameProps; onNext: () => void }) {
  const { bff, session, syncProfile } = useApp();
  const { t, fmt } = useI18n();
  const [link, setLink] = useState<{ link: string; expires_at: string } | null>(null);
  const granted = session.account.guardian_consent === "granted";
  const send = useAction(async () => {
    try {
      const l = link ?? (await bff.requestGuardianConsent());
      setLink(l);
      shareToTelegram(l.link, t("ob.teen.shareText"));
    } catch (e) {
      if (e instanceof ApiError && e.code === "GUARDIAN_CONSENT_NOT_REQUIRED") {
        syncProfile(await bff.profile());
        return;
      }
      throw e;
    }
  });
  return (
    <ObFrame
      id="teen"
      {...frame}
      error={send.error}
      foot={
        <Btn onClick={onNext} data-testid="ob-next">
          {t("c.continue")}
        </Btn>
      }
    >
      <h1 className="h1">{t("ob.teen.title")}</h1>
      <p className="sub">{t("ob.teen.text")}</p>
      {granted ? (
        <div className="card ok">
          <p className="sub ink"><Icon name="check" size={16} /> {t("ob.teen.granted")}</p>
        </div>
      ) : (
        <>
          <Btn variant="secondary" busy={send.busy} onClick={() => void send.run()} data-testid="teen-send">
            <Icon name="share" size={18} />
            {t("ob.teen.send")}
          </Btn>
          {link ? (
            <div className="card warn stack tight" data-testid="teen-link">
              <p className="sub ink">{t("ob.teen.sent", { date: fmt.date(link.expires_at) })}</p>
              <CopyLink link={link.link} />
            </div>
          ) : null}
        </>
      )}
    </ObFrame>
  );
}

export function CopyLink({ link }: { link: string }) {
  const { t } = useI18n();
  return (
    <Btn
      variant="link"
      onClick={() => {
        void navigator.clipboard?.writeText(link).then(
          () => showToast(t("c.copied")),
          () => showToast(link),
        );
      }}
    >
      <Icon name="copy" size={18} />
      {t("c.copy")}
    </Btn>
  );
}

/* ---------------------------------------------------------------- consents (AT-02) */
function ConsentStep({ frame, who, childAge, childName, onNext }: { frame: FrameProps; who: Who | null; childAge: AgeBand | null; childName: string; onNext: () => void }) {
  const { bff, session, patchSession, applySession } = useApp();
  const { t, lang } = useI18n();
  const policy = useLoad(() => bff.policy(lang), [lang]);
  const prev = session.consent.purposes;
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(prev.filter((p) => !REQUIRED.includes(p)).map((p) => [p, true])));
  const [doc, setDoc] = useState<PolicyDocument | null>(null);
  const keyRef = useRef<DraftKey | null>(null);
  const [offerFor, setOfferFor] = useState<string | null>(null);
  const optionalOk = optionalAllowed(session.account.age_band, session.account.guardian_consent);
  const purposes = policy.data?.purposes ?? [];
  const required = purposes.filter((p) => p.required);
  const optional = purposes.filter((p) => !p.required);
  const allRequired = required.length > 0 && required.every((p) => checked[p.code]);

  const save = useAction(async () => {
    const pol = policy.data!;
    const chosen = purposes.filter((p) => checked[p.code] && (p.required || optionalOk)).map((p) => p.code);
    try {
      patchSession({ consent: await bff.acceptConsent({ policy_version: pol.version, purposes: chosen }) });
    } catch (e) {
      if (e instanceof ApiError && e.code === "POLICY_VERSION_OUTDATED") void policy.reload();
      throw e;
    }
    // the child profile is created only after the parent's consents (POST /v1/learners → switch to it)
    if (who === "child" && session.learner.kind !== "child") {
      const band = childAge && isChildBand(childAge) ? (childAge as "6-9" | "10-13") : "6-9";
      keyRef.current = keyForDraft(keyRef.current, { name: childName, band });
      const child = await bff.createChild({ display_name: childName, age_band: band }, keyRef.current.key);
      // the first child profile and no parent code yet: offer it while still in the parent's profile (review T-1)
      if (!children(session).length && !session.security.pin_enabled) {
        setOfferFor(child.learner_id);
        return;
      }
      await enter.run(child.learner_id);
      return;
    }
    onNext();
  });
  // into the new child profile (after the parent code is set or skipped)
  const enter = useAction(async (childId: string) => {
    await applySession(await bff.switchLearner(childId));
    await bff.patchPlan({ ui_lang: lang }).catch(() => null);
    onNext();
  });

  return (
    <ObFrame
      id="consent"
      {...frame}
      tight
      error={save.error ?? enter.error ?? policy.error}
      foot={
        policy.error ? (
          <Btn variant="secondary" onClick={() => void policy.reload()}>
            {t("c.retry")}
          </Btn>
        ) : (
          <Btn busy={save.busy || enter.busy} disabled={!allRequired || policy.loading} onClick={() => void save.run()} data-testid="ob-next">
            {t("c.continue")}
          </Btn>
        )
      }
    >
      <h1 className="h1">{t("ob.consent.title")}</h1>
      <p className="sub">{t("ob.consent.text")}</p>
      {policy.data ? (
        <>
          <fieldset>
            <legend className="sec">{t("ob.consent.required")}</legend>
            {required.map((p) => (
              <Check key={p.code} checked={!!checked[p.code]} onChange={(v) => setChecked((c) => ({ ...c, [p.code]: v }))} testId={`consent-${p.code}`}>
                {p.title} <span className="small">({t("ob.consent.version", { v: policy.data!.version })})</span>
              </Check>
            ))}
          </fieldset>
          <fieldset>
            <legend className="sec">{t("ob.consent.optional")}</legend>
            {optional.map((p) => (
              <Check
                key={p.code}
                checked={optionalOk && !!checked[p.code]}
                disabled={!optionalOk}
                onChange={(v) => setChecked((c) => ({ ...c, [p.code]: v }))}
                note={!optionalOk ? t("ob.consent.teenLocked") : p.description}
                testId={`consent-${p.code}`}
              >
                {p.title}
              </Check>
            ))}
          </fieldset>
          <div className="card">
            <p className="sub">{who === "child" ? t("ob.consent.childNote") : t("ob.consent.note")}</p>
          </div>
          <Btn variant="link" onClick={() => setDoc(policy.data)}>
            {t("ob.consent.read")}
          </Btn>
        </>
      ) : policy.loading ? (
        <p className="sub">{t("c.loading")}</p>
      ) : null}
      {doc ? <PolicySheet doc={doc} onClose={() => setDoc(null)} /> : null}
      {offerFor ? (
        <PinOffer
          onDone={() => {
            const id = offerFor;
            setOfferFor(null);
            void enter.run(id);
          }}
        />
      ) : null}
    </ObFrame>
  );
}

export function PolicySheet({ doc, onClose }: { doc: PolicyDocument; onClose: () => void }) {
  const { t } = useI18n();
  // plain text: the document is shown as paragraphs, never as HTML
  const paras = doc.text.split(/\n{2,}/).map((p) => p.replace(/^#+\s*/, "").trim()).filter(Boolean);
  return (
    <Sheet title={t("ob.consent.docTitle", { v: doc.version })} onClose={onClose} testId="policy-sheet">
      <div className="stack">
        {paras.map((p, i) => (
          <p key={i} className="sub ink">{p}</p>
        ))}
      </div>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- goal */
function GoalStep({ frame, kid, value, onChange, onNext }: { frame: FrameProps; kid: boolean; value: Goal | null; onChange: (g: Goal) => void; onNext: () => void }) {
  const { bff, setPlan } = useApp();
  const { t, l } = useI18n();
  const dir = useLoad(() => bff.goals(), []);
  const items: Array<{ code: Goal; label: string }> = useMemo(() => {
    const fromServer = (dir.data?.items ?? []).filter((i: DirectoryItem) => (GOALS as readonly string[]).includes(i.code));
    if (fromServer.length) return fromServer.map((i) => ({ code: i.code as Goal, label: l(i.label) }));
    return GOALS.map((g) => ({ code: g, label: t(`goal.${g}` as MessageKey) }));
  }, [dir.data, l, t]);
  const save = useAction(async () => {
    setPlan(await bff.patchPlan({ goal: value! }));
    onNext();
  });
  return (
    <ObFrame
      id="goal"
      {...frame}
      error={save.error}
      foot={
        <Btn busy={save.busy} disabled={!value} onClick={() => void save.run()} data-testid="ob-next">
          {t("c.continue")}
        </Btn>
      }
    >
      <h1 className="h1">{kid ? t("ob.goal.titleChild") : t("ob.goal.title")}</h1>
      <p className="sub">{t("ob.goal.text")}</p>
      <div className="chips" role="group" aria-label={kid ? t("ob.goal.titleChild") : t("ob.goal.title")}>
        {items.map((g) => (
          <Chip key={g.code} on={value === g.code} label={g.label} onClick={() => onChange(g.code)} />
        ))}
      </div>
      <div className="stack tight">
        <p className="sec">{t("ob.goal.explain")}</p>
        <Opt on title="Русский" note={t("ob.goal.course")} onClick={() => undefined} />
        <Opt on={false} disabled title="Oʻzbekcha" note={t("ob.goal.uzSoon")} onClick={() => undefined} aside={<Pill tone="mute">{t("c.soon")}</Pill>} />
      </div>
    </ObFrame>
  );
}

/* ---------------------------------------------------------------- level */
function LevelStep({ frame, kid, value, onChange, onNext }: { frame: FrameProps; kid: boolean; value: LevelSelf | null; onChange: (l: LevelSelf) => void; onNext: () => void }) {
  const { bff, setPlan } = useApp();
  const { t } = useI18n();
  const save = useAction(async () => {
    setPlan(await bff.patchPlan({ level_self: value! }));
    onNext();
  });
  return (
    <ObFrame
      id="level"
      {...frame}
      error={save.error}
      foot={
        <Btn busy={save.busy} disabled={!value} onClick={() => void save.run()} data-testid="ob-next">
          {t("c.continue")}
        </Btn>
      }
    >
      <h1 className="h1">{kid ? t("ob.level.titleChild") : t("ob.level.title")}</h1>
      <div className="opts">
        {LEVELS.map((lv) => (
          <Opt key={lv} on={value === lv} title={t(`level.${lv}` as MessageKey)} note={t(`level.${lv}.note` as MessageKey)} onClick={() => onChange(lv)} testId={`level-${lv}`} />
        ))}
      </div>
      <p className="sub">{t("ob.level.note")}</p>
    </ObFrame>
  );
}

/* ---------------------------------------------------------------- days and time */
function WhenStep({ frame, kid, value, onChange, onNext }: { frame: FrameProps; kid: boolean; value: Schedule; onChange: (s: Schedule) => void; onNext: () => void }) {
  const { bff, setPlan } = useApp();
  const { t } = useI18n();
  const problem = scheduleProblem(value, { kid });
  const save = useAction(async () => {
    setPlan(await bff.patchPlan({ schedule: { preset: value.preset, days: value.days, preferred_time: value.preferred_time } }));
    onNext();
  });
  return (
    <ObFrame
      id="when"
      {...frame}
      tight
      error={save.error}
      foot={
        <Btn busy={save.busy} disabled={problem === "days" || problem === "preferred_time"} onClick={() => void save.run()} data-testid="ob-next">
          {t("c.continue")}
        </Btn>
      }
    >
      <h1 className="h1">{t("ob.when.title")}</h1>
      <p className="sub">{t("ob.when.text")}</p>
      <DaysPicker value={value} onChange={(d) => onChange({ ...value, ...d })} />
      <TimePicker kid={kid} value={value.preferred_time} onChange={(v) => onChange({ ...value, preferred_time: v })} error={timeError(problem, value.preferred_time, kid, t)} />
    </ObFrame>
  );
}

/* ---------------------------------------------------------------- duration, reminders, time zone → complete */
function MinutesStep(props: {
  frame: FrameProps;
  kid: boolean;
  value: Schedule;
  onChange: (s: Schedule) => void;
  missed: boolean;
  setMissed: (v: boolean) => void;
  onDone: (p: LearningPlan) => void;
  onMissing: (s: ObStep) => void;
}) {
  const { bff, setPlan, syncProfile, deviceTz } = useApp();
  const { t } = useI18n();
  const { value } = props;
  const save = useAction(async () => {
    if (value.reminders_enabled || props.missed) await requestWriteAccess();
    setPlan(await bff.patchPlan({ schedule: { ...value } }));
    const cats = { ...(value.reminders_enabled ? { reminders: true } : {}), ...(props.missed ? { missed: true } : {}) };
    syncProfile(await bff.patchSettings({ notifications: optInPatch(cats, value.timezone) }));
    try {
      const p = await bff.completeOnboarding();
      setPlan(p);
      props.onDone(p);
    } catch (e) {
      if (e instanceof ApiError && e.code === "PLAN_INCOMPLETE") props.onMissing(stepForMissing(e.details.missing));
      throw e;
    }
  });
  return (
    <ObFrame
      id="minutes"
      {...props.frame}
      tight
      error={save.error}
      foot={
        <Btn busy={save.busy} disabled={scheduleProblem(value, { kid: props.kid }) != null} onClick={() => void save.run()} data-testid="ob-next">
          {t("ob.minutes.finish")}
        </Btn>
      }
    >
      <h1 className="h1">{t("ob.minutes.title")}</h1>
      <DurationPicker value={value.duration_min} onChange={(d) => props.onChange({ ...value, duration_min: d })} />
      <div className="list">
        <ToggleRow
          title={t("sch.reminders")}
          note={props.kid ? t("sch.remindersKid") : t("sch.remindersNote", { time: value.preferred_time })}
          checked={value.reminders_enabled}
          onChange={(v) => props.onChange({ ...value, reminders_enabled: v })}
          testId="reminders"
        />
        <ToggleRow title={t("sch.missed")} note={t("sch.missedNote")} checked={props.missed} onChange={props.setMissed} testId="missed" />
      </div>
      <ZonePicker value={value.timezone} device={deviceTz} onChange={(tz) => props.onChange({ ...value, timezone: tz })} />
    </ObFrame>
  );
}

/* ---------------------------------------------------------------- done */
function DoneStep({ plan, onOpen }: { plan: LearningPlan; onOpen: () => void }) {
  const { session } = useApp();
  const { t } = useI18n();
  const s = plan.schedule;
  const kid = session.learner.kind === "child";
  return (
    <main className="ob" data-testid="ob-done">
      <div className="ob-body">
        <div className="done-hero">
          <Hero src={kid ? HERO.myatik : HERO.voltUp} alt={kid ? t("hero.myatik") : t("hero.volt")} />
        </div>
        <h1 className="h1 center">{kid ? t("ob.done.titleChild", { name: session.learner.display_name }) : t("ob.done.title")}</h1>
        <p className="sub center">{t("ob.done.text")}</p>
        <div className="card">
          {plan.goal ? <div className="kv"><span>{t("ob.done.goal")}</span><span>{t(`goal.${plan.goal}` as MessageKey)}</span></div> : null}
          <div className="kv"><span>{t("sch.days")}</span><span>{daysText(s, t)}</span></div>
          <div className="kv"><span>{t("sch.time")}</span><span>{s.preferred_time}</span></div>
          <div className="kv"><span>{t("sch.duration")}</span><span>{t("c.minutesN", { n: s.duration_min })}</span></div>
          <div className="kv"><span>{t("ob.done.reminders")}</span><span>{s.reminders_enabled ? t("c.on") : t("c.off")}</span></div>
        </div>
      </div>
      <div className="ob-foot">
        <Btn onClick={onOpen} data-testid="ob-open-home">
          {t("ob.done.go")}
        </Btn>
      </div>
    </main>
  );
}

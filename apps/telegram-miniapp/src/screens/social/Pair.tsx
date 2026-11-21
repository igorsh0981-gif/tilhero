import type { MemberId, PairRoomView, ScenarioCard } from "@tilhero/contracts/bff";
import { useRef, useState } from "react";
import { ApiError } from "../../api/errors";
import { lobbyPhase, startValue } from "../../domain/pairRoom";
import { memberLabel } from "../../domain/social";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp, usePlan } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { keyForDraft, type DraftKey } from "../../state/idempotency";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Opt, Pill, Seg, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { MemberAvatar, PickMemberSheet, SocialError, useSocialAction } from "./parts";

/** The status line of a pair lesson from my side. */
export function pairLine(v: PairRoomView, t: (k: MessageKey, vars?: Record<string, string | number>) => string, kid: boolean): string {
  const name = memberLabel(v.partner.nickname, t, kid ? "family" : "friend");
  const phase = lobbyPhase(v);
  if (phase === "incoming") return t(kid ? "pair.st.incomingKid" : "pair.st.incoming", { name });
  if (phase === "outgoing") return t("pair.st.outgoing", { name });
  // accepted, the entry opens 5 minutes before the start / the lesson goes on without me
  if (phase === "scheduled") return t("pair.st.scheduled");
  if (phase === "away") return kid ? t("pair.away.titleKid") : t("pair.away.title");
  return t(`pair.st.${v.status}` as MessageKey);
}

/**
 * «Урок вдвоём» (APP-SOC-03…06): what it is (two learners, the AI coach, own roles, own report; minutes counted, not
 * charged), «Позвать» and my lessons — invitations both ways, rooms, past lessons with my report.
 */
export function PairRoomsScreen() {
  const { bff, nav, session } = useApp();
  const { t, l, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const [tab, setTab] = useState<"active" | "finished">("active");
  const list = useLoad(() => bff.pairRooms(tab), [tab, session.learner.learner_id]);
  const items = list.data?.items ?? [];
  return (
    <>
      <Bar title={t("pair.title")} onBack={nav.back} />
      <main className="scroll" data-testid="pair-rooms">
        <div className="pad stack">
          <div className="card notice" role="note">
            <Icon name="chat" size={20} />
            <div className="stack tight">
              <p className="sub ink">{kid ? t("pair.whatKid") : t("pair.what")}</p>
              <p className="sub small">{t("pair.minutes")}</p>
            </div>
          </div>
          <Btn onClick={() => nav.push({ name: "pairInvite" })} data-testid="pair-new">
            <Icon name="plus" size={18} />
            {t("pair.new")}
          </Btn>
          <Seg label={t("pair.title")} value={tab} onChange={setTab} options={[{ value: "active", label: t("pair.active") }, { value: "finished", label: t("pair.finished") }]} testId="pair-tabs" />
          {!list.data ? (
            list.loading ? <Skeleton lines={2} /> : <SocialError error={list.error} errorObj={list.errorObj} onRetry={() => void list.reload()} service="lessons" />
          ) : items.length ? (
            <ul className="list" data-testid="pair-list">
              {items.map((v) => (
                <li key={v.room_id}>
                  <button type="button" className="row" onClick={() => nav.push({ name: "pairRoom", id: v.room_id })} data-testid="pair-row" data-status={v.status}>
                    <MemberAvatar hero={v.partner.hero} />
                    <span className="t">
                      <b>{pairLine(v, t, kid)}</b>
                      <span>
                        {l(v.scenario.title)} · {fmt.dateTime(v.start_at)}
                      </span>
                    </span>
                    {lobbyPhase(v) === "incoming" ? <Pill>{t("c.new")}</Pill> : null}
                    <Icon name="chevron" size={18} stroke={2} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub" data-testid="pair-empty">{t("pair.empty")}</p>
          )}
        </div>
      </main>
    </>
  );
}

/**
 * The invitation: whom (a friend 14+ or a member of the family), the scenario of the catalogue (children — their own
 * scenarios, choices only), now or a time within 7 days; one Idempotency-Key per content of the form.
 */
export function PairInviteScreen({ partner: initial, partnerLabel }: { partner?: MemberId; partnerLabel?: string }) {
  const { bff, nav, session } = useApp();
  const plan = usePlan();
  const { t, l } = useI18n();
  const kid = session.learner.kind === "child";
  const [partner, setPartner] = useState<{ id: MemberId; label: string } | null>(initial ? { id: initial, label: partnerLabel ?? t(kid ? "soc.familyMember" : "soc.friend") } : null);
  const [pick, setPick] = useState(false);
  const [scenario, setScenario] = useState<string | null>(null);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const scenarios = useLoad(() => bff.scenarios({}, null), [session.learner.learner_id]);
  const key = useRef<DraftKey | null>(null);
  const start = startValue(when, at);
  const send = useSocialAction(async () => {
    if (!partner || !scenario || !start) return;
    const body = { partner_member_id: partner.id, pair_id: plan.course_pair, scenario_id: scenario, start };
    key.current = keyForDraft(key.current, body);
    try {
      const v = await bff.invitePair(body, key.current.key);
      key.current = null;
      showToast(t("pair.inv.sent"));
      nav.replace({ name: "pairRoom", id: v.room_id });
    } catch (e) {
      if (e instanceof ApiError && e.code === "ROOM_LIMIT" && typeof e.details.room_id === "string") {
        key.current = null;
        nav.replace({ name: "pairRoom", id: e.details.room_id });
        return;
      }
      throw e;
    }
  });
  const items: ScenarioCard[] = scenarios.data?.items ?? [];
  return (
    <>
      <Bar title={t("pair.new")} onBack={nav.back} />
      <main className="scroll" data-testid="pair-invite">
        <div className="pad stack loose">
          <section className="stack tight" aria-labelledby="pi-who">
            <h2 className="sec" id="pi-who">{t("pair.inv.partner")}</h2>
            <div className="card hrow">
              <MemberAvatar hero={null} />
              <b className="grow" data-testid="pi-partner">{partner ? partner.label : "—"}</b>
              <Btn variant="link" onClick={() => setPick(true)} data-testid="pi-pick">
                {partner ? t("pair.inv.change") : t("pair.inv.pick")}
              </Btn>
            </div>
          </section>
          <section className="stack tight" aria-labelledby="pi-sc">
            <h2 className="sec" id="pi-sc">{t("pair.inv.scenario")}</h2>
            {!scenarios.data ? (
              scenarios.loading ? <Skeleton lines={2} /> : <ErrorLine text={scenarios.error} />
            ) : items.length ? (
              <div className="opts" role="group" aria-labelledby="pi-sc">
                {items.map((s) => (
                  <Opt key={s.scenario_id} on={scenario === s.scenario_id} title={l(s.title)} note={`${s.level} · ${l(s.task)}`} onClick={() => setScenario(s.scenario_id)} testId={`pi-sc-${s.scenario_id}`} />
                ))}
              </div>
            ) : (
              <p className="sub">{t("pair.inv.noScenarios")}</p>
            )}
          </section>
          <section className="stack tight" aria-labelledby="pi-when">
            <h2 className="sec" id="pi-when">{t("pair.inv.when")}</h2>
            <Seg label={t("pair.inv.when")} value={when} onChange={setWhen} options={[{ value: "now", label: t("pair.inv.now") }, { value: "later", label: t("pair.inv.later") }]} testId="pi-when" />
            {when === "later" ? (
              <div>
                <label className="lb" htmlFor="pi-at">{t("pair.inv.time")}</label>
                <input id="pi-at" className="inp" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-invalid={!!at && !start} data-testid="pi-at" />
                {at && !start ? <p className="field-err" role="alert">{t("pair.inv.badTime")}</p> : null}
              </div>
            ) : null}
            <p className="sub small">{when === "now" ? t("pair.inv.nowHint") : t("pair.inv.timeHint")}</p>
            {kid ? <p className="sub small" data-testid="pi-kid">{t("pair.inv.choicesKid")}</p> : null}
            <p className="sub small">{t("pair.minutes")}</p>
          </section>
          <ErrorLine text={send.error} />
          <Btn busy={send.busy} disabled={!partner || !scenario || !start} onClick={() => void send.run()} data-testid="pi-send">
            <Icon name="send" size={18} />
            {t("pair.inv.send")}
          </Btn>
        </div>
      </main>
      {pick ? (
        <PickMemberSheet
          title={t("pair.inv.pickTitle")}
          onClose={() => setPick(false)}
          onPick={(m) => {
            setPartner({ id: m.member_id, label: m.label });
            setPick(false);
          }}
          testId="pi-pick-sheet"
        />
      ) : null}
    </>
  );
}

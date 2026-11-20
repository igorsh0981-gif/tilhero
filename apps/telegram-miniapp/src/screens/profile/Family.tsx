import type { AgeBand, GuardianConsentGrant, Invite, InviteKind, LearnerSummary } from "@tilhero/contracts/bff";
import { useRef, useState } from "react";
import { flag } from "../../config/experience";
import { children, initialOf, invitePermissions, teenWithoutConsent } from "../../domain/people";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { keyForDraft, type DraftKey } from "../../state/idempotency";
import { newIdempotencyKey } from "../../api/client";
import { confirmPopup, shareToTelegram } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, Chip, ErrorLine, Field, Pill, Skeleton, TextInput } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { PinOffer } from "./ParentCode";
import { useSocialConsentGate } from "./SocialConsent";
import { useSwitchToChild } from "./switching";
import { ChildVoiceToggle } from "./VoiceConsent";

const STATUS_TONE: Record<Invite["status"], "ok" | "mute" | "warn" | undefined> = { active: undefined, accepted: "ok", revoked: "mute", expired: "mute" };

/**
 * Profile → «Семья и приглашения» (APP-SOC-01, APP-REF-01, AT-09): the family, child profiles 6–13 (create, switch;
 * after the first one — the offer to set the parent code), teens 14–17 the parent gave consent for (revoke),
 * invitation links family / friend shared through Telegram (403 CONSENT_REQUIRED {social} → the consent sheet), the list
 * of my invitations and revoking them.
 */
export function Family() {
  const { bff, session, nav, patchSession, config } = useApp();
  const { t, fmt } = useI18n();
  const invitesOn = flag(config, "family_invites");
  const perms = invitePermissions(session);
  const family = useLoad(() => bff.family(), []);
  const invites = useLoad(() => bff.invites(null), []);
  const kids = children(session);
  const toChild = useSwitchToChild();
  const inviteKey = useRef<{ kind: InviteKind; key: string } | null>(null);
  const gate = useSocialConsentGate();
  const [offerPin, setOfferPin] = useState(false);

  const create = useAction(async (kind: InviteKind) => {
    if (!inviteKey.current || inviteKey.current.kind !== kind) inviteKey.current = { kind, key: newIdempotencyKey() };
    let inv: Invite;
    try {
      inv = await bff.createInvite(kind, inviteKey.current.key);
    } catch (e) {
      if (gate.intercept(e, () => void create.run(kind))) return;
      throw e;
    }
    inviteKey.current = null;
    invites.setData({ items: [inv, ...(invites.data?.items ?? []).filter((i) => i.invite_id !== inv.invite_id)], next_cursor: invites.data?.next_cursor ?? null });
    shareToTelegram(inv.link, t(`inv.shareText.${kind}` as MessageKey));
  });
  const revoke = useAction(async (inv: Invite) => {
    const ok = await confirmPopup({ title: t("inv.revokeQ"), message: t("inv.revokeText"), ok: t("inv.revoke"), cancel: t("c.cancel"), destructive: true });
    if (!ok) return;
    const r = await bff.revokeInvite(inv.invite_id);
    invites.setData({ items: (invites.data?.items ?? []).map((i) => (i.invite_id === r.invite_id ? r : i)), next_cursor: invites.data?.next_cursor ?? null });
    showToast(t("inv.revoked"));
  });

  return (
    <>
      <Bar title={t("fam.title")} onBack={nav.back} />
      <main className="scroll" data-testid="family">
        <div className="pad stack loose">
          {/* ---- family ---- */}
          <section className="stack tight" aria-labelledby="fam-h">
            <h2 className="sec" id="fam-h">{t("fam.members")}</h2>
            {family.loading && !family.data ? <Skeleton lines={1} /> : null}
            {family.data ? (
              <ul className="list" data-testid="family-members">
                {family.data.members.map((m) => (
                  <li key={m.user_id} className="row">
                    <span className="av s" aria-hidden="true">{initialOf(m.display_name)}</span>
                    <span className="t">
                      <b>{m.display_name}{m.is_me ? ` (${t("fam.me")})` : ""}</b>
                      <span>{t(`fam.role.${m.role}` as MessageKey)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : !family.loading && !family.error ? (
              <div className="card"><p className="sub">{t("fam.noFamily")}</p></div>
            ) : null}
            <ErrorLine text={family.error} />
          </section>

          {/* ---- children ---- */}
          {perms.children ? (
            <section className="stack tight" aria-labelledby="kids-h">
              <h2 className="sec" id="kids-h">{t("fam.children")}</h2>
              {kids.length ? (
                <ul className="list" data-testid="children">
                  {kids.map((k) => (
                    <li key={k.learner_id} className="child-item" data-testid={`child-${k.learner_id}`}>
                      <div className="row">
                        <span className="av s" aria-hidden="true">{initialOf(k.display_name)}</span>
                        <span className="t">
                          <b>{k.display_name}</b>
                          <span>{k.age_band ? t(`age.${k.age_band}` as MessageKey) : ""}</span>
                        </span>
                        <Btn variant="link" busy={toChild.busy} onClick={() => void toChild.run(k.learner_id)} aria-label={t("fam.switchTo", { name: k.display_name })}>
                          {t("fam.switch")}
                        </Btn>
                      </div>
                      {/* sprint 5: the parent's consent to record the child's voice (pronunciation score) */}
                      <ChildVoiceToggle child={k} />
                    </li>
                  ))}
                </ul>
              ) : null}
              <ErrorLine text={toChild.error} />
              <AddChild
                onAdded={(l: LearnerSummary) => {
                  patchSession({ learners: [...session.learners, l] });
                  // the first child profile: offer the parent code (without it the child leaves the profile in one tap)
                  if (!kids.length && !session.security.pin_enabled) setOfferPin(true);
                }}
                count={kids.length}
              />
            </section>
          ) : null}

          {/* ---- teens the parent decided for (§11) ---- */}
          {perms.children ? <TeenConsents /> : null}

          {/* ---- invite (flag family_invites) ---- */}
          {invitesOn ? (
          <section className="stack tight" aria-labelledby="inv-h">
            <h2 className="sec" id="inv-h">{t("fam.invite")}</h2>
            {perms.family || perms.friend ? (
              <div className="duo">
                <Btn variant="secondary" disabled={!perms.family} busy={create.busy} onClick={() => void create.run("family")} data-testid="invite-family">
                  <Icon name="users" size={18} />
                  {t("fam.inviteFamily")}
                </Btn>
                <Btn variant="secondary" disabled={!perms.friend} busy={create.busy} onClick={() => void create.run("friend")} data-testid="invite-friend">
                  <Icon name="share" size={18} />
                  {t("fam.inviteFriend")}
                </Btn>
              </div>
            ) : null}
            <p className="sub small">
              {session.learner.kind === "child" ? t("fam.notAllowedChild") : teenWithoutConsent(session) ? t("fam.notAllowedTeen") : perms.family ? t("fam.inviteNote") : t("fam.adultOnly")}
            </p>
            {teenWithoutConsent(session) ? (
              <Btn variant="link" onClick={() => nav.push({ name: "guardian" })}>{t("profile.guardian")}</Btn>
            ) : null}
            <ErrorLine text={create.error} />
          </section>
          ) : null}

          {/* ---- my invitations ---- */}
          <section className="stack tight" aria-labelledby="my-inv-h">
            <h2 className="sec" id="my-inv-h">{t("fam.invites")}</h2>
            {invites.loading && !invites.data ? <Skeleton lines={1} /> : null}
            {invites.data?.items.length ? (
              <ul className="list" data-testid="invites">
                {invites.data.items.map((inv) => (
                  <li key={inv.invite_id} className="row" data-testid="invite-row">
                    <span className="t">
                      <b>{t(`inv.kind.${inv.kind}` as MessageKey)}</b>
                      <span>
                        {inv.expires_at ? t("inv.until", { date: fmt.date(inv.expires_at) }) : t("inv.noExpiry")}
                        {inv.accepted_count ? ` · ${t("inv.accepted", { n: inv.accepted_count })}` : ""}
                      </span>
                      <span className="pills">
                        <Pill tone={STATUS_TONE[inv.status]}>{t(`inv.status.${inv.status}` as MessageKey)}</Pill>
                      </span>
                    </span>
                    {inv.status === "active" ? (
                      <span className="stack tight">
                        <Btn variant="link" onClick={() => shareToTelegram(inv.link, t(`inv.shareText.${inv.kind}` as MessageKey))} aria-label={t("inv.shareAria")}>
                          <Icon name="share" size={18} />
                        </Btn>
                        <Btn variant="link" busy={revoke.busy} onClick={() => void revoke.run(inv)} data-testid="invite-revoke">
                          {t("inv.revoke")}
                        </Btn>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : !invites.loading && !invites.error ? (
              <div className="card"><p className="sub">{t("fam.noInvites")}</p></div>
            ) : null}
            <ErrorLine text={invites.error ?? revoke.error} />
          </section>
        </div>
      </main>
      {gate.sheet}
      {offerPin ? <PinOffer onDone={() => setOfferPin(false)} /> : null}
    </>
  );
}

const GRANT_TONE: Record<GuardianConsentGrant["status"], "ok" | "mute"> = { granted: "ok", declined: "mute" };

/** Teens 14–17 this adult decided for by a gc_ link; the consent given can be revoked (with a confirmation). Hidden
 *  while there are none. */
function TeenConsents() {
  const { bff } = useApp();
  const { t, fmt } = useI18n();
  const grants = useLoad(() => bff.guardianGrants(), []);
  const revoke = useAction(async (g: GuardianConsentGrant) => {
    const ok = await confirmPopup({
      title: t("gcg.revokeQ"),
      message: t("gcg.revokeText", { name: g.teen_display_name }),
      ok: t("gcg.revoke"),
      cancel: t("c.cancel"),
      destructive: true,
    });
    if (!ok) return;
    const r = await bff.revokeGuardianGrant(g.teen_user_id);
    grants.setData({ items: (grants.data?.items ?? []).map((x) => (x.teen_user_id === r.teen_user_id ? r : x)) });
    showToast(t("gcg.revoked"));
  });
  if (!grants.data?.items.length && !grants.error) return null;
  return (
    <section className="stack tight" aria-labelledby="gcg-h" data-testid="teen-consents">
      <h2 className="sec" id="gcg-h">{t("gcg.title")}</h2>
      <p className="sub small">{t("gcg.note")}</p>
      {grants.data?.items.length ? (
        <ul className="list">
          {grants.data.items.map((g) => (
            <li key={g.teen_user_id} className="row" data-testid="teen-consent-row">
              <span className="av s" aria-hidden="true">{initialOf(g.teen_display_name)}</span>
              <span className="t">
                <b>{g.teen_display_name}</b>
                <span>{t("gcg.decided", { date: fmt.date(g.decided_at) })}</span>
                <span className="pills">
                  <Pill tone={GRANT_TONE[g.status]}>{t(`gcg.status.${g.status}` as MessageKey)}</Pill>
                </span>
              </span>
              {g.status === "granted" ? (
                <Btn variant="link" busy={revoke.busy} onClick={() => void revoke.run(g)} data-testid="teen-consent-revoke">
                  {t("gcg.revoke")}
                </Btn>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <ErrorLine text={grants.error ?? revoke.error} />
    </section>
  );
}

function AddChild({ onAdded, count }: { onAdded: (l: LearnerSummary) => void; count: number }) {
  const { bff } = useApp();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [age, setAge] = useState<AgeBand | null>(null);
  const key = useRef<DraftKey | null>(null);
  const clean = name.trim();
  const add = useAction(async () => {
    key.current = keyForDraft(key.current, { clean, age });
    const l = await bff.createChild({ display_name: clean, age_band: age as "6-9" | "10-13" }, key.current.key);
    onAdded(l);
    setOpen(false);
    setName("");
    setAge(null);
    key.current = null;
    showToast(t("fam.childAdded", { name: l.display_name }));
  });
  if (!open) {
    return (
      <>
        <Btn variant="secondary" disabled={count >= 5} onClick={() => setOpen(true)} data-testid="add-child">
          <Icon name="plus" size={18} />
          {t("fam.addChild")}
        </Btn>
        <p className="sub small">{t("fam.childrenNote")}</p>
      </>
    );
  }
  return (
    <div className="card stack" data-testid="add-child-form">
      <Field label={t("ob.child.name")}>
        {(id, d) => <TextInput id={id} aria-describedby={d} value={name} maxLength={40} placeholder={t("ob.child.namePh")} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <fieldset className="stack tight">
        <legend className="lb">{t("ob.who.age")}</legend>
        <div className="chips">
          {(["6-9", "10-13"] as const).map((a) => (
            <Chip key={a} on={age === a} label={t(`age.${a}`)} ariaLabel={t(`ageAria.${a}`)} onClick={() => setAge(a)} />
          ))}
        </div>
      </fieldset>
      <ErrorLine text={add.error} />
      <div className="duo">
        <Btn variant="secondary" onClick={() => setOpen(false)}>{t("c.cancel")}</Btn>
        <Btn busy={add.busy} disabled={!clean || clean.length > 40 || !age} onClick={() => void add.run()} data-testid="add-child-save">
          {t("fam.addChildSave")}
        </Btn>
      </div>
    </div>
  );
}

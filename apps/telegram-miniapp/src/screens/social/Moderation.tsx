import type { SanctionView } from "@tilhero/contracts/bff";
import { useEffect, useRef, useState } from "react";
import { memberLabel } from "../../domain/social";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { keyForDraft, type DraftKey } from "../../state/idempotency";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Field, Pill, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { MemberAvatar, SocialError, useSocialAction } from "./parts";

/**
 * «Заблокированные» (APP-SOC-02): whom I blocked and since when; «Разблокировать» does not return the friendship. The
 * blocked one never learns about it.
 */
export function BlockedScreen() {
  const { bff, nav, session } = useApp();
  const { t, fmt } = useI18n();
  const res = useLoad(() => bff.blocks(), [session.learner.learner_id]);
  const unblock = useSocialAction(async (memberId: string) => {
    await bff.unblock(memberId);
    res.setData({ items: (res.data?.items ?? []).filter((b) => b.member_id !== memberId) });
    showToast(t("blk.unblocked"));
  });
  const items = res.data?.items ?? [];
  return (
    <>
      <Bar title={t("blk.title")} onBack={nav.back} />
      <main className="scroll" data-testid="blocked">
        <div className="pad stack">
          {!res.data ? (
            res.loading ? <Skeleton lines={2} /> : <SocialError error={res.error} errorObj={res.errorObj} onRetry={() => void res.reload()} />
          ) : items.length ? (
            <ul className="list" data-testid="blocked-list">
              {items.map((b) => {
                const name = memberLabel(b.nickname, t);
                return (
                  <li key={b.member_id} className="row" data-testid="blocked-row">
                    <MemberAvatar hero={null} />
                    <span className="t">
                      <b>{name}</b>
                      <span>{t("blk.since", { date: fmt.date(b.created_at) })}</span>
                    </span>
                    <Btn variant="link" busy={unblock.busy} onClick={() => void unblock.run(b.member_id)} aria-label={`${t("blk.unblock")}: ${name}`} data-testid="blocked-unblock">
                      {t("blk.unblock")}
                    </Btn>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="sub" data-testid="blocked-empty">{t("blk.empty")}</p>
          )}
          <ErrorLine text={unblock.error} />
          <p className="sub small">{t("blk.note")}</p>
        </div>
      </main>
    </>
  );
}

/**
 * «Мои ограничения» (APP-SOC-10, AT-79): warnings, a ban of social actions (until a date or without a term), a reset
 * nickname — with the basis written for me (who decided is not shown); one appeal per sanction, its status and the
 * answer of the moderator.
 */
export function SanctionsScreen() {
  const { bff, nav, session } = useApp();
  const { t } = useI18n();
  const res = useLoad(() => bff.sanctions(), [session.learner.learner_id]);
  const items = res.data?.items ?? [];
  return (
    <>
      <Bar title={t("san.title")} onBack={nav.back} />
      <main className="scroll" data-testid="sanctions">
        <div className="pad stack">
          {!res.data ? (
            res.loading ? <Skeleton lines={2} /> : <SocialError error={res.error} errorObj={res.errorObj} onRetry={() => void res.reload()} />
          ) : items.length ? (
            <ul className="stack tight">
              {items.map((s) => (
                <SanctionCard key={s.sanction_id} s={s} onChange={(n) => res.setData({ items: items.map((x) => (x.sanction_id === n.sanction_id ? n : x)) })} />
              ))}
            </ul>
          ) : (
            <p className="sub" data-testid="sanctions-empty">{t("san.empty")}</p>
          )}
          <p className="sub small">{t("san.note")}</p>
        </div>
      </main>
    </>
  );
}

/**
 * What a reset of the nickname means — a plain line. The date of a new nickname is on «Друзья» (fr.nickWhen, from the
 * server's nickname_change_available_at), so the link there is shown only while the server gives that date (14+;
 * a child has no such screen). No counting of days here: the cooldown is a setting of social.
 */
function NickResetNote() {
  const { bff, nav, session } = useApp();
  const { t } = useI18n();
  const kid = session.learner.kind === "child";
  const [until, setUntil] = useState<string | null>(null);
  useEffect(() => {
    if (kid) return;
    let alive = true;
    bff.community().then(
      (p) => alive && setUntil(p.nickname_change_available_at),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bff, kid]);
  return (
    <div className="stack tight" data-testid="sanction-nick">
      <p className="sub ink" data-testid="sanction-nick-note">{t("san.nickNote")}</p>
      {!kid && until && Date.parse(until) > Date.now() ? (
        <Btn variant="link" className="soc-inline" onClick={() => nav.push({ name: "friends" })} data-testid="sanction-nick-when">
          <Icon name="users" size={16} />
          {t("san.nickWhere")}
        </Btn>
      ) : null}
    </div>
  );
}

function SanctionCard({ s, onChange }: { s: SanctionView; onChange: (s: SanctionView) => void }) {
  const { bff } = useApp();
  const { t, fmt } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const key = useRef<DraftKey | null>(null);
  const clean = text.trim();
  const send = useSocialAction(async () => {
    key.current = keyForDraft(key.current, { id: s.sanction_id, clean });
    const n = await bff.appealSanction(s.sanction_id, clean, key.current.key);
    key.current = null;
    onChange(n);
    setOpen(false);
    showToast(t("san.appealSent"));
  });
  const term = s.kind === "social_ban" ? (s.until ? t("san.until", { date: fmt.dateTime(s.until) }) : t("san.forever")) : null;
  const appealTone = s.appeal?.status === "overturned" ? "ok" : s.appeal?.status === "upheld" ? "mute" : "warn";
  return (
    <li className="card stack tight" data-testid="sanction" data-kind={s.kind} data-active={s.active}>
      <div className="hrow between">
        <b className="h3">{t(`san.kind.${s.kind}` as MessageKey)}</b>
        <Pill tone={s.active ? "warn" : "mute"}>{s.revoked_at ? t("san.revoked", { date: fmt.date(s.revoked_at) }) : s.active ? t("san.active") : t("san.ended")}</Pill>
      </div>
      <span className="sub small">
        {t("san.decided", { date: fmt.date(s.decided_at) })}
        {term ? ` · ${term}` : ""}
      </span>
      <div className="stack tight">
        <span className="cap">{t("san.basis")}</span>
        <p className="sub ink" data-testid="sanction-basis">{s.basis}</p>
      </div>
      {s.kind === "nickname_reset" && s.active ? <NickResetNote /> : null}
      {s.appeal ? (
        <div className="card pen stack tight" data-testid="sanction-appeal" data-status={s.appeal.status}>
          <span className="cap">{t("san.appealYours")}</span>
          <p className="sub ink">{s.appeal.text}</p>
          <span className="pills"><Pill tone={appealTone}>{t(`san.appeal.${s.appeal.status}` as MessageKey)}</Pill></span>
          {s.appeal.decision_note ? (
            <>
              <span className="cap">{t("san.answer")}</span>
              <p className="sub ink" data-testid="sanction-answer">{s.appeal.decision_note}</p>
            </>
          ) : null}
        </div>
      ) : s.can_appeal ? (
        open ? (
          <div className="stack tight" data-testid="appeal-form">
            <Field label={t("san.appealLabel")} hint={t("san.appealHint")} error={send.error}>
              {(id, d) => (
                <textarea id={id} aria-describedby={d} className="inp" rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} data-testid="appeal-text" />
              )}
            </Field>
            <p className="rp-count" aria-live="polite">{t("pair.room.count", { n: text.length, m: 1000 })}</p>
            <div className="duo">
              <Btn variant="secondary" onClick={() => setOpen(false)}>{t("c.cancel")}</Btn>
              <Btn busy={send.busy} disabled={clean.length < 10} onClick={() => void send.run()} data-testid="appeal-send">{t("san.appealSend")}</Btn>
            </div>
          </div>
        ) : (
          <Btn variant="secondary" onClick={() => setOpen(true)} data-testid="appeal-open">
            <Icon name="chat" size={18} />
            {t("san.appeal")}
          </Btn>
        )
      ) : null}
      {!open ? <ErrorLine text={send.error} /> : null}
    </li>
  );
}

import type { ComplaintReason, ComplaintSubjectKind, MemberHero, MemberId, SocialRestrictions } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../../api/errors";
import { familyPick, memberLabel, nicknameProblem, NICK_MAX, socialDown, socialErrorText, type PickMember } from "../../domain/social";
import { env } from "../../env";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { keyForDraft, type DraftKey } from "../../state/idempotency";
import { Icon } from "../../ui/Icon";
import { Btn, Check, cx, ErrorLine, Field, Opt, Skeleton, TextInput } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { HeroImg } from "../game/parts";

/* Building blocks of the social screens (sprint 7). Another learner is a member_id with a nickname or «Друг» /
 * «Участник семьи», a hero and XP — never a name, Telegram or an age. */

/** A link into the Mini App (t.me/<bot>[/<app>]?startapp=…) — for «Поделиться в Telegram». */
export function appLink(startapp: string): string {
  const app = env.miniAppShortName ? `/${env.miniAppShortName}` : "";
  return `https://t.me/${env.botUsername}${app}?startapp=${encodeURIComponent(startapp)}`;
}

/** A user action of a social screen: busy state and the text of the error with its details (until, reason). */
export function useSocialAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const { t, fmt } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorObj, setErrorObj] = useState<unknown>(null);
  const latest = useRef(fn);
  latest.current = fn;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async (...a: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      setErrorObj(null);
      try {
        return await latest.current(...a);
      } catch (e) {
        if (mounted.current) {
          setError(socialErrorText(e, t, fmt));
          setErrorObj(e);
        }
        return undefined;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [t, fmt],
  );
  return { run, busy, error, errorObj, setError };
}

/**
 * A social screen whose data did not come: the domain is down — «учёба работает как обычно», plus «Повторить». social
 * down — «Друзья, лиги и дуэли…»; lessons or gamification (the pair lesson, duels, leagues) — a neutral «эта часть»; a
 * child — always the soft text. The service comes from 503 UPSTREAM_UNAVAILABLE {service}, else from the screen.
 */
export function SocialError({ error, errorObj, onRetry, service = "social" }: { error: string | null; errorObj: unknown; onRetry: () => void; service?: "social" | "lessons" | "gamification" }) {
  const { session } = useApp();
  const { t, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const down = socialDown(errorObj);
  const which = errorObj instanceof ApiError && typeof errorObj.details.service === "string" ? errorObj.details.service : errorObj instanceof ApiError && errorObj.code === "GAME_UNAVAILABLE" ? "gamification" : service;
  return (
    <div className="pad stack tight" data-testid="social-error">
      <div className="card warn notice" role="status">
        <Icon name="info" size={20} />
        <p className="sub ink">{down ? (kid ? t("soc.unavailableKid") : which === "social" ? t("soc.unavailable") : t("soc.unavailablePart")) : errorObj ? socialErrorText(errorObj, t, fmt) : error}</p>
      </div>
      <Btn variant="secondary" onClick={onRetry} data-testid="social-retry">{t("c.retry")}</Btn>
    </div>
  );
}

/** The hero of another learner (catalogue art, the bundled art as a fallback) or a neutral circle — never a photo. */
export function MemberAvatar({ hero, me }: { hero: MemberHero | null | undefined; me?: boolean }) {
  return (
    <span className={cx("soc-av", me && "me")} aria-hidden="true">
      {hero ? <HeroImg image={hero.image} code={hero.code} stage={hero.stage} alt="" /> : <Icon name="hero" size={20} />}
    </span>
  );
}

/** social_ban: what is closed and until when, with the way to the sanctions and the appeal. */
export function RestrictionBanner({ r, onMore }: { r: SocialRestrictions | null | undefined; onMore?: () => void }) {
  const { t, fmt } = useI18n();
  if (!r?.social_ban) return null;
  return (
    <div className="card warn stack tight" role="status" data-testid="soc-restricted">
      <p className="sub ink notice">
        <Icon name="shield" size={20} />
        <b>{r.social_ban_until ? t("soc.restricted", { date: fmt.dateTime(r.social_ban_until) }) : t("soc.restrictedForever")}</b>
      </p>
      <p className="sub small">{t("soc.restrictedNote")}</p>
      {onMore ? (
        <Btn variant="link" onClick={onMore} data-testid="soc-to-sanctions">
          {t("soc.toSanctions")}
        </Btn>
      ) : null}
    </div>
  );
}

/** A plaque «Социальное не меняет учёбу» + what others see (children — a softer one). */
export function PrivacyNote({ kid }: { kid: boolean }) {
  const { t } = useI18n();
  return (
    <div className="card notice" role="note" data-testid="soc-privacy">
      <Icon name="shield" size={20} />
      <div className="stack tight">
        <p className="sub ink">{kid ? t("soc.privacyKid") : t("soc.privacy")}</p>
        {!kid ? <p className="sub small">{t("soc.learning")}</p> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the nickname */

/**
 * «Задать ник» / «Сменить ник»: 3–20 letters, digits and «_» checked before sending; the answers of the server — taken
 * (409 NICKNAME_TAKEN), invalid by reason (length | chars | forbidden: the filter, or a nickname reset by a moderator —
 * it is closed to everybody), the cooldown of 7 days with its date (429 NICKNAME_COOLDOWN {until}). Before that date —
 * after a change or after a reset by the moderator — the sheet shows it and does not save. `availableAt` — from the
 * community profile when the screen has it; without it the sheet reads the profile itself.
 */
export function NicknameSheet({ current, availableAt, onSaved, onClose }: { current: string | null; availableAt?: string | null; onSaved: (nick: string) => void; onClose: () => void }) {
  const { bff } = useApp();
  const { t, fmt } = useI18n();
  const [value, setValue] = useState(current ?? "");
  const [touched, setTouched] = useState(false);
  const [until, setUntil] = useState<string | null>(availableAt ?? null);
  useEffect(() => {
    if (availableAt !== undefined) return;
    let alive = true;
    bff.community().then(
      (p) => alive && setUntil(p.nickname_change_available_at),
      () => undefined,
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const local = nicknameProblem(value);
  const save = useSocialAction(async () => {
    try {
      const p = await bff.setNickname(value.trim());
      showToast(t("nick.saved", { nick: p.nickname ?? value.trim() }));
      onSaved(p.nickname ?? value.trim());
    } catch (e) {
      // too early: the date from the answer, and no more saving before it
      if (e instanceof ApiError && e.code === "NICKNAME_COOLDOWN" && typeof e.details.until === "string") setUntil(e.details.until);
      throw e;
    }
  });
  const locked = !!until && Date.parse(until) > Date.now();
  const shown = locked ? null : (save.error ?? (touched && local ? t(`nick.err.${local}` as MessageKey) : null));
  return (
    <Sheet title={current ? t("fr.nickChange") : t("fr.nickSet")} onClose={onClose} testId="nick-sheet">
      <div className="stack">
        {locked ? (
          <p className="card warn sub ink" role="status" data-testid="nick-when">
            {t(current ? "fr.nickWhen" : "fr.nickWhenSet", { date: fmt.dateTime(until!) })}
          </p>
        ) : null}
        <Field label={t("nick.label")} hint={t("nick.hint")} error={shown}>
          {(id, d) => (
            <TextInput
              id={id}
              aria-describedby={d}
              invalid={!!shown}
              value={value}
              disabled={locked}
              maxLength={NICK_MAX + 5}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => {
                setValue(e.target.value);
                save.setError(null);
              }}
              onBlur={() => setTouched(true)}
              data-testid="nick-input"
            />
          )}
        </Field>
        <Btn
          busy={save.busy}
          disabled={locked || !!local || value.trim() === (current ?? "")}
          onClick={() => {
            setTouched(true);
            void save.run();
          }}
          data-testid="nick-save"
        >
          {t("nick.save")}
        </Btn>
      </div>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- a complaint (APP-SOC-10) */

const REASONS: readonly ComplaintReason[] = ["spam", "abuse", "inappropriate_nickname", "cheating", "other"];

/**
 * «Пожаловаться»: the reason, a comment (≤ 500, optional), «и заблокировать». One Idempotency-Key per content of the
 * form (a lost answer is re-sent with the same key — one case). The moderator sees only the subject, not a conversation.
 */
export function ComplaintSheet(props: {
  member: { member_id: MemberId; label: string };
  subject?: { kind: ComplaintSubjectKind; id: string | null };
  onClose: () => void;
  onDone?: (blocked: boolean) => void;
}) {
  const { bff } = useApp();
  const { t } = useI18n();
  const [reason, setReason] = useState<ComplaintReason | null>(null);
  const [comment, setComment] = useState("");
  const [block, setBlock] = useState(false);
  const key = useRef<DraftKey | null>(null);
  const subject = props.subject ?? { kind: "user" as const, id: null };
  const send = useSocialAction(async () => {
    if (!reason) return;
    const body = {
      member_id: props.member.member_id,
      subject_kind: subject.kind,
      subject_id: subject.id,
      reason,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      ...(block ? { block: true } : {}),
    };
    key.current = keyForDraft(key.current, body);
    const r = await bff.complain(body, key.current.key);
    key.current = null;
    showToast(r.blocked ? t("cmp.sentBlocked") : t("cmp.sent"));
    props.onDone?.(r.blocked);
    props.onClose();
  });
  return (
    <Sheet title={t("cmp.title")} cap={t("cmp.on", { name: props.member.label })} onClose={props.onClose} testId="complaint-sheet">
      <div className="stack">
        <fieldset className="stack tight">
          <legend className="lb">{t("cmp.reason")}</legend>
          <div className="opts" role="group" aria-label={t("cmp.reason")}>
            {REASONS.map((r) => (
              <Opt key={r} on={reason === r} title={t(`cmp.r.${r}` as MessageKey)} onClick={() => setReason(r)} testId={`cmp-${r}`} />
            ))}
          </div>
        </fieldset>
        <div>
          <label className="lb" htmlFor="cmp-comment">{t("cmp.comment")}</label>
          <textarea
            id="cmp-comment"
            className="inp"
            rows={3}
            maxLength={500}
            placeholder={t("cmp.commentPh")}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="cmp-comment"
          />
          <p className="rp-count" aria-live="polite">{t("cmp.count", { n: comment.length })}</p>
        </div>
        <Check checked={block} onChange={setBlock} note={t("cmp.blockNote")} testId="cmp-block">
          {t("cmp.block")}
        </Check>
        <p className="sub small">{t("cmp.note")}</p>
        <ErrorLine text={send.error} />
        <Btn busy={send.busy} disabled={!reason} onClick={() => void send.run()} data-testid="cmp-send">
          {t("cmp.send")}
        </Btn>
      </div>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- choosing a partner (a duel, a pair lesson) */

/**
 * Whom to challenge or invite: friends (14+) and members of my family — a child sees only the family. Members are shown
 * by nickname or «Друг» / «Участник семьи» with their hero; nobody by name.
 */
export function PickMemberSheet({ title, onPick, onClose, testId = "pick-sheet" }: { title: string; onPick: (m: PickMember) => void; onClose: () => void; testId?: string }) {
  const { bff, session } = useApp();
  const { t } = useI18n();
  const kid = session.learner.kind === "child";
  const data = useLoad(async () => {
    const [friends, family, leagues] = await Promise.all([
      kid ? Promise.resolve(null) : bff.friends().catch((e: unknown) => (socialDown(e) ? Promise.reject(e) : null)),
      // a child has only the family: its failure is an error («сейчас это отдыхает»), not an empty family
      kid ? bff.family() : bff.family().catch(() => null),
      bff.leagues().catch(() => null),
    ]);
    const fam = familyPick(family, leagues?.family, t);
    const fr: PickMember[] = (friends?.items ?? []).map((f) => ({ member_id: f.member_id, label: memberLabel(f.nickname, t), kind: "friend" as const, hero: null }));
    // a friend who is also in my family is shown once — in the family
    const famIds = new Set(fam.map((m) => m.member_id));
    return { friends: fr.filter((f) => !famIds.has(f.member_id)), family: fam };
  }, [session.learner.learner_id]);
  const d = data.data;
  const empty = d && !d.friends.length && !d.family.length;
  const list = (items: PickMember[], head: string, id: string): ReactNode =>
    items.length ? (
      <section className="stack tight" aria-labelledby={id}>
        <h3 className="sec" id={id}>{head}</h3>
        <ul className="list">
          {items.map((m) => (
            <li key={m.member_id}>
              <button type="button" className="row" onClick={() => onPick(m)} data-testid={`pick-${m.member_id}`}>
                <MemberAvatar hero={m.hero} />
                <span className="t"><b>{m.label}</b></span>
                <Icon name="chevron" size={18} stroke={2} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    ) : null;
  return (
    <Sheet title={title} onClose={onClose} testId={testId}>
      <div className="stack">
        {!d ? (
          data.loading ? <Skeleton lines={2} /> : <SocialError error={data.error} errorObj={data.errorObj} onRetry={() => void data.reload()} />
        ) : empty ? (
          <p className="sub" data-testid="pick-empty">{kid ? t("du.pickEmptyKid") : t("du.pickEmpty")}</p>
        ) : (
          <>
            {list(d.friends, t("du.pickFriends"), "pick-fr")}
            {list(d.family, t("du.pickFamily"), "pick-fam")}
          </>
        )}
      </div>
    </Sheet>
  );
}

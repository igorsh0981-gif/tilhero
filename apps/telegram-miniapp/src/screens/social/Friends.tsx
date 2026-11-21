import type { CommunityProfile, FriendRequestView, FriendView, MemberCard, Page } from "@tilhero/contracts/bff";
import { useRef, useState } from "react";
import { newIdempotencyKey } from "../../api/client";
import { flag } from "../../config/experience";
import { cardAction, friendsGate, memberLabel, searchQuery } from "../../domain/social";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { confirmPopup, shareToTelegram } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Field, NavRow, Skeleton, TextInput, ToggleRow } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { SocialConsentSheet } from "../profile/SocialConsent";
import { useChallenge } from "./Duels";
import { KidFamilyScreen } from "./KidFamily";
import { appLink, ComplaintSheet, MemberAvatar, NicknameSheet, PrivacyNote, RestrictionBanner, SocialError, useSocialAction } from "./parts";

/**
 * «Друзья» (APP-SOC-01/02, AT-73): my nickname (set / change) and friend code (copy, share in Telegram, rotate), the
 * search by an exact code or nickname, incoming and outgoing requests, friends (a duel, a pair lesson, remove, block,
 * complain), the hidden game profile, blocks and my sanctions. A child 6–13 has no friends — «Моя семья» instead.
 * Another learner is only a nickname or «Друг».
 */
export function FriendsScreen() {
  const { session } = useApp();
  return session.learner.kind === "child" ? <KidFamilyScreen /> : <Friends />;
}

function Friends() {
  const { bff, nav, session, config } = useApp();
  const { t } = useI18n();
  const community = useLoad(() => bff.community(), [session.learner.learner_id]);
  const friends = useLoad(() => bff.friends(), [session.learner.learner_id]);
  const incoming = useLoad(() => bff.friendRequests("in"), [session.learner.learner_id]);
  const outgoing = useLoad(() => bff.friendRequests("out"), [session.learner.learner_id]);
  const [allow, setAllow] = useState(false);
  const p = community.data;
  const gate = friendsGate(p, false);
  const gameOn = flag(config, "game");
  const reloadAll = () => {
    void friends.reload();
    void incoming.reload();
    void outgoing.reload();
  };

  return (
    <>
      <Bar title={t("fr.title")} onBack={nav.back} />
      <main className="scroll" data-testid="friends">
        {!p ? (
          community.loading ? (
            <div className="pad"><Skeleton lines={4} /></div>
          ) : (
            <SocialError error={community.error} errorObj={community.errorObj} onRetry={() => void community.reload()} />
          )
        ) : (
          <div className="pad stack loose">
            <RestrictionBanner r={p.restrictions} onMore={() => nav.push({ name: "sanctions" })} />
            {gate !== "ok" ? (
              <div className="card warn stack tight" data-testid="friends-gate" data-reason={gate}>
                <p className="sub ink notice"><Icon name="lock" size={20} />{t(`fr.why.${gate}` as MessageKey)}</p>
                {gate === "consent" ? (
                  <Btn onClick={() => setAllow(true)} data-testid="friends-allow">{t("fr.allow")}</Btn>
                ) : (
                  <Btn variant="link" onClick={() => nav.push({ name: "guardian" })}>{t("profile.guardian")}</Btn>
                )}
              </div>
            ) : null}
            <MeCard p={p} onChange={community.setData} />
            {gate === "ok" ? (
              <>
                <SearchSection onChanged={reloadAll} />
                <Requests incoming={incoming} outgoing={outgoing} onChanged={reloadAll} />
                <FriendsList friends={friends} onChanged={reloadAll} />
              </>
            ) : null}
            <section className="stack tight" aria-labelledby="fr-more">
              <h2 className="sec" id="fr-more">{t("fr.more")}</h2>
              <div className="list">
                {gameOn ? <NavRow title={t("soc.link.leagues")} icon="trophy" onClick={() => nav.push({ name: "leagues" })} testId="fr-to-leagues" /> : null}
                {gameOn ? <NavRow title={t("soc.link.duels")} icon="target" onClick={() => nav.push({ name: "duels" })} testId="fr-to-duels" /> : null}
                <NavRow title={t("soc.link.pair")} icon="chat" onClick={() => nav.push({ name: "pairRooms" })} testId="fr-to-pair" />
                <NavRow title={t("soc.link.referrals")} icon="gift" onClick={() => nav.push({ name: "referrals" })} testId="fr-to-referrals" />
                <NavRow title={t("fr.blocked")} icon="lock" onClick={() => nav.push({ name: "blocked" })} testId="fr-to-blocked" />
                <NavRow title={t("fr.sanctions")} icon="shield" onClick={() => nav.push({ name: "sanctions" })} testId="fr-to-sanctions" />
              </div>
            </section>
            <PrivacyNote kid={false} />
          </div>
        )}
      </main>
      {allow ? (
        <SocialConsentSheet
          onClose={() => setAllow(false)}
          onAllowed={() => {
            setAllow(false);
            void community.reload();
            reloadAll();
          }}
        />
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- my nickname, code, hidden profile */

function MeCard({ p, onChange }: { p: CommunityProfile; onChange: (p: CommunityProfile) => void }) {
  const { bff } = useApp();
  const { t, fmt } = useI18n();
  const [nick, setNick] = useState(false);
  const rotate = useSocialAction(async () => {
    const ok = await confirmPopup({ title: t("fr.codeRotateQ"), message: t("fr.codeRotateText"), ok: t("fr.codeRotate"), cancel: t("c.cancel") });
    if (!ok) return;
    const n = await bff.rotateFriendCode();
    onChange(n);
    showToast(t("fr.codeRotated", { code: n.friend_code }));
  });
  const hide = useSocialAction(async (v: boolean) => {
    const before = p;
    onChange({ ...p, game_profile_hidden: v });
    try {
      onChange(await bff.patchCommunity({ game_profile_hidden: v }));
      showToast(v ? t("fr.hiddenToast") : t("fr.shownToast"));
    } catch (e) {
      onChange(before);
      throw e;
    }
  });
  const copy = () => {
    void navigator.clipboard?.writeText(p.friend_code).then(
      () => showToast(t("fr.codeCopied")),
      () => undefined,
    );
  };
  const cooldown = p.nickname_change_available_at && Date.parse(p.nickname_change_available_at) > Date.now() ? p.nickname_change_available_at : null;
  return (
    <section className="stack tight" aria-labelledby="fr-me">
      <h2 className="sec" id="fr-me">{t("fr.me")}</h2>
      <div className="card stack" data-testid="fr-me">
        <div className="hrow between">
          <div className="stack tight">
            <span className="cap">{t("fr.nick")}</span>
            <b className="h3" data-testid="fr-nick">{p.nickname ?? t("fr.nickNone")}</b>
          </div>
          <Btn variant="secondary" className="soc-small" disabled={!!cooldown} onClick={() => setNick(true)} data-testid="fr-nick-edit">
            {p.nickname ? t("fr.nickChange") : t("fr.nickSet")}
          </Btn>
        </div>
        {cooldown ? <p className="sub small" data-testid="fr-nick-when">{t(p.nickname ? "fr.nickWhen" : "fr.nickWhenSet", { date: fmt.dateTime(cooldown) })}</p> : <p className="sub small">{t("fr.nickNote")}</p>}
        <div className="soc-code stack tight">
          <span className="cap">{t("fr.code")}</span>
          <b className="soc-code-v" data-testid="fr-code" lang="en">{p.friend_code}</b>
          <p className="sub small">{t("fr.codeNote")}</p>
          <div className="soc-actions">
            <Btn variant="secondary" onClick={copy} data-testid="fr-code-copy">
              <Icon name="copy" size={18} />
              {t("fr.codeCopy")}
            </Btn>
            <Btn variant="secondary" onClick={() => shareToTelegram(appLink("route_friends"), t("fr.codeShareText", { code: p.friend_code }))} data-testid="fr-code-share">
              <Icon name="share" size={18} />
              {t("fr.codeShare")}
            </Btn>
            <Btn variant="link" busy={rotate.busy} onClick={() => void rotate.run()} data-testid="fr-code-rotate">
              <Icon name="route" size={18} />
              {t("fr.codeRotate")}
            </Btn>
          </div>
          <ErrorLine text={rotate.error} />
        </div>
      </div>
      <div className="list">
        <ToggleRow title={t("fr.hide")} note={t("fr.hideNote")} checked={p.game_profile_hidden} disabled={hide.busy} onChange={(v) => void hide.run(v)} testId="fr-hide" />
      </div>
      <ErrorLine text={hide.error} />
      {nick ? (
        <NicknameSheet
          current={p.nickname}
          availableAt={p.nickname_change_available_at}
          onClose={() => setNick(false)}
          onSaved={(n) => {
            setNick(false);
            onChange({ ...p, nickname: n });
            void bff.community().then(onChange, () => undefined);
          }}
        />
      ) : null}
    </section>
  );
}

/* ---------------------------------------------------------------- the search */

function SearchSection({ onChanged }: { onChanged: () => void }) {
  const { bff } = useApp();
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<MemberCard[] | null>(null);
  const query = searchQuery(q);
  const search = useSocialAction(async () => {
    if (!query) return;
    setFound((await bff.searchMembers(query.q)).items);
  });
  return (
    <section className="stack tight" aria-labelledby="fr-search">
      <h2 className="sec" id="fr-search">{t("fr.search")}</h2>
      <form
        className="stack tight"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void search.run();
        }}
      >
        <Field label={t("fr.searchLabel")} hint={q.trim() && !query ? t("fr.searchBad") : t("fr.searchHint")}>
          {(id, d) => (
            <div className="soc-search">
              <TextInput
                id={id}
                aria-describedby={d}
                value={q}
                maxLength={40}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={t("fr.searchPh")}
                onChange={(e) => {
                  setQ(e.target.value);
                  setFound(null);
                }}
                data-testid="fr-search-input"
              />
              <Btn type="submit" busy={search.busy} disabled={!query} data-testid="fr-search-go">
                <Icon name="search" size={18} />
                {t("fr.searchGo")}
              </Btn>
            </div>
          )}
        </Field>
      </form>
      <ErrorLine text={search.error} />
      {found ? (
        found.length ? (
          found.map((c) => <FoundCard key={c.member_id} card={c} onCard={(n) => setFound([n])} onChanged={onChanged} />)
        ) : (
          <p className="sub" role="status" data-testid="fr-not-found">{t("fr.notFound")}</p>
        )
      ) : null}
    </section>
  );
}

/** A found learner: only the nickname and our relation; add, accept / decline, take back; complain, block. */
function FoundCard({ card, onCard, onChanged }: { card: MemberCard; onCard: (c: MemberCard) => void; onChanged: () => void }) {
  const { bff } = useApp();
  const { t } = useI18n();
  const key = useRef<{ member: string; key: string } | null>(null);
  const [complain, setComplain] = useState(false);
  /** blocked from this card (or by a complaint with «и заблокировать»): no more «Добавить» — it would be 403 BLOCKED */
  const [blocked, setBlocked] = useState(false);
  const label = memberLabel(card.nickname, t);
  const action = blocked ? "blocked" : cardAction(card);
  const add = useSocialAction(async () => {
    if (!key.current || key.current.member !== card.member_id) key.current = { member: card.member_id, key: newIdempotencyKey() };
    const r = await bff.sendFriendRequest(card.member_id, key.current.key);
    key.current = null;
    if (r.status === "accepted") {
      showToast(t("fr.nowFriends"));
      onCard({ ...card, relation: "friend", request_id: null });
    } else {
      showToast(t("fr.sentToast"));
      onCard({ ...card, relation: "request_out", request_id: r.request_id });
    }
    onChanged();
  });
  const respond = useSocialAction(async (a: "accept" | "decline" | "cancel") => {
    if (!card.request_id) return;
    await bff.friendRequestAction(card.request_id, a);
    showToast(t(a === "accept" ? "fr.nowFriends" : a === "decline" ? "fr.declinedToast" : "fr.cancelledToast"));
    onCard({ ...card, relation: a === "accept" ? "friend" : "none", request_id: null });
    onChanged();
  });
  const block = useSocialAction(async () => {
    const ok = await confirmPopup({ title: t("fr.blockQ", { name: label }), message: t("fr.blockText"), ok: t("fr.block"), cancel: t("c.cancel"), destructive: true });
    if (!ok) return;
    await bff.block(card.member_id);
    showToast(t("fr.blockedToast"));
    setBlocked(true);
    onCard({ ...card, relation: "none", request_id: null });
    onChanged();
  });
  return (
    <div className="card stack tight" data-testid="fr-found" data-relation={blocked ? "blocked" : card.relation}>
      <div className="hrow">
        <MemberAvatar hero={null} />
        <div className="grow">
          <b data-testid="fr-found-name">{label}</b>
          <p className="sub small">{blocked ? t("fr.rel.blocked") : t(`fr.rel.${card.relation}` as MessageKey)}</p>
        </div>
      </div>
      {action === "add" ? (
        <Btn busy={add.busy} onClick={() => void add.run()} data-testid="fr-add">
          <Icon name="plus" size={18} />
          {t("fr.add")}
        </Btn>
      ) : action === "respond" ? (
        <div className="duo">
          <Btn variant="secondary" busy={respond.busy} onClick={() => void respond.run("decline")} data-testid="fr-found-decline">{t("fr.decline")}</Btn>
          <Btn busy={respond.busy} onClick={() => void respond.run("accept")} data-testid="fr-found-accept">{t("fr.accept")}</Btn>
        </div>
      ) : action === "cancel" ? (
        <Btn variant="secondary" busy={respond.busy} onClick={() => void respond.run("cancel")} data-testid="fr-found-cancel">{t("fr.cancel")}</Btn>
      ) : null}
      {action !== "self" && action !== "blocked" ? (
        <div className="hrow between">
          <Btn variant="link" onClick={() => setComplain(true)} data-testid="fr-found-complain">
            <Icon name="flag" size={16} />
            {t("fr.complain")}
          </Btn>
          <Btn variant="link" busy={block.busy} onClick={() => void block.run()} data-testid="fr-found-block">
            <Icon name="lock" size={16} />
            {t("fr.block")}
          </Btn>
        </div>
      ) : null}
      <ErrorLine text={add.error ?? respond.error ?? block.error} />
      {complain ? (
        <ComplaintSheet
          member={{ member_id: card.member_id, label }}
          subject={{ kind: card.nickname ? "nickname" : "user", id: null }}
          onClose={() => setComplain(false)}
          onDone={(didBlock) => {
            if (didBlock) {
              setBlocked(true);
              onCard({ ...card, relation: "none", request_id: null });
              onChanged();
            }
          }}
        />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- requests */

type Loaded<T> = ReturnType<typeof useLoad<T>>;

function Requests({ incoming, outgoing, onChanged }: { incoming: Loaded<Page<FriendRequestView>>; outgoing: Loaded<Page<FriendRequestView>>; onChanged: () => void }) {
  const { bff } = useApp();
  const { t, fmt } = useI18n();
  const [complain, setComplain] = useState<FriendRequestView | null>(null);
  const act = useSocialAction(async (r: FriendRequestView, a: "accept" | "decline" | "cancel") => {
    try {
      await bff.friendRequestAction(r.request_id, a);
      showToast(t(a === "accept" ? "fr.nowFriends" : a === "decline" ? "fr.declinedToast" : "fr.cancelledToast"));
    } finally {
      // REQUEST_STATE / REQUEST_NOT_FOUND — the lists are re-read either way
      onChanged();
    }
  });
  const inItems = incoming.data?.items ?? [];
  const outItems = outgoing.data?.items ?? [];
  const row = (r: FriendRequestView) => {
    const name = memberLabel(r.nickname, t);
    return (
      <li key={r.request_id} className="row" data-testid={`req-${r.direction}`}>
        <span className="t">
          <b>{name}</b>
          <span>{t("fr.sentAt", { date: fmt.date(r.created_at) })}</span>
          {r.direction === "in" ? (
            <Btn variant="link" className="soc-inline" onClick={() => setComplain(r)} aria-label={`${t("fr.complain")}: ${name}`} data-testid="req-complain">
              <Icon name="flag" size={14} />
              {t("fr.complain")}
            </Btn>
          ) : null}
        </span>
        {r.direction === "in" ? (
          <span className="soc-row-acts">
            <Btn variant="secondary" className="soc-small" disabled={act.busy} onClick={() => void act.run(r, "decline")} aria-label={`${t("fr.decline")}: ${name}`} data-testid="req-decline">
              {t("fr.decline")}
            </Btn>
            <Btn className="soc-small" disabled={act.busy} onClick={() => void act.run(r, "accept")} aria-label={`${t("fr.accept")}: ${name}`} data-testid="req-accept">
              {t("fr.accept")}
            </Btn>
          </span>
        ) : (
          <Btn variant="link" disabled={act.busy} onClick={() => void act.run(r, "cancel")} aria-label={`${t("fr.cancel")}: ${name}`} data-testid="req-cancel">
            {t("fr.cancel")}
          </Btn>
        )}
      </li>
    );
  };
  return (
    <section className="stack tight" aria-labelledby="fr-req">
      <h2 className="sec" id="fr-req">{t("fr.requests")}</h2>
      {incoming.loading && !incoming.data ? <Skeleton lines={1} /> : null}
      {inItems.length ? (
        <>
          <h3 className="sub small ink">{t("fr.in")}</h3>
          <ul className="list" data-testid="req-in-list">{inItems.map(row)}</ul>
        </>
      ) : null}
      {outItems.length ? (
        <>
          <h3 className="sub small ink">{t("fr.out")}</h3>
          <ul className="list" data-testid="req-out-list">{outItems.map(row)}</ul>
        </>
      ) : null}
      {!inItems.length && !outItems.length && incoming.data && outgoing.data ? <p className="sub small" data-testid="req-none">{t("fr.noRequests")}</p> : null}
      <ErrorLine text={act.error ?? incoming.error ?? outgoing.error} />
      {complain ? (
        <ComplaintSheet
          member={{ member_id: complain.member_id, label: memberLabel(complain.nickname, t) }}
          subject={{ kind: "friend_request", id: complain.request_id }}
          onClose={() => setComplain(null)}
          onDone={() => onChanged()}
        />
      ) : null}
    </section>
  );
}

/* ---------------------------------------------------------------- friends */

function FriendsList({ friends, onChanged }: { friends: Loaded<Page<FriendView>>; onChanged: () => void }) {
  const { t, fmt } = useI18n();
  const [open, setOpen] = useState<FriendView | null>(null);
  const items = friends.data?.items ?? [];
  return (
    <section className="stack tight" aria-labelledby="fr-list">
      <h2 className="sec" id="fr-list">{items.length ? t("fr.listN", { n: items.length }) : t("fr.list")}</h2>
      {friends.loading && !friends.data ? <Skeleton lines={2} /> : null}
      {items.length ? (
        <ul className="list" data-testid="fr-list">
          {items.map((f) => (
            <li key={f.member_id}>
              <button type="button" className="row" onClick={() => setOpen(f)} data-testid="fr-row" data-member={f.member_id}>
                <MemberAvatar hero={null} />
                <span className="t">
                  <b>{memberLabel(f.nickname, t)}</b>
                  <span>{t("fr.since", { date: fmt.date(f.since) })}</span>
                </span>
                <Icon name="chevron" size={18} stroke={2} />
              </button>
            </li>
          ))}
        </ul>
      ) : friends.data ? (
        <div className="card"><p className="sub" data-testid="fr-empty">{t("fr.empty")}</p></div>
      ) : null}
      <ErrorLine text={friends.data ? null : friends.error} />
      {open ? <FriendSheet friend={open} onClose={() => setOpen(null)} onChanged={onChanged} /> : null}
    </section>
  );
}

/** A friend: challenge to a duel, invite to a pair lesson, remove, block, complain (sheets are never stacked). */
function FriendSheet({ friend, onClose, onChanged }: { friend: FriendView; onClose: () => void; onChanged: () => void }) {
  const { bff, nav, config } = useApp();
  const { t } = useI18n();
  const [complain, setComplain] = useState(false);
  const label = memberLabel(friend.nickname, t);
  const challenge = useChallenge();
  const remove = useSocialAction(async () => {
    const ok = await confirmPopup({ title: t("fr.removeQ", { name: label }), message: t("fr.removeText"), ok: t("fr.remove"), cancel: t("c.cancel"), destructive: true });
    if (!ok) return;
    await bff.removeFriend(friend.member_id);
    showToast(t("fr.removed"));
    onClose();
    onChanged();
  });
  const block = useSocialAction(async () => {
    const ok = await confirmPopup({ title: t("fr.blockQ", { name: label }), message: t("fr.blockText"), ok: t("fr.block"), cancel: t("c.cancel"), destructive: true });
    if (!ok) return;
    await bff.block(friend.member_id);
    showToast(t("fr.blockedToast"));
    onClose();
    onChanged();
  });
  if (complain) {
    return (
      <ComplaintSheet
        member={{ member_id: friend.member_id, label }}
        onClose={onClose}
        onDone={(blocked) => {
          if (blocked) onChanged();
        }}
      />
    );
  }
  return (
    <Sheet title={t("fr.actionsOf", { name: label })} onClose={onClose} testId="friend-sheet">
      <div className="stack tight">
        {flag(config, "game") ? (
          <Btn
            busy={challenge.busy}
            onClick={() =>
              void challenge.run(friend.member_id).then((d) => {
                // undefined — an error (shown here); a duel (new or existing) is already open
                if (d !== undefined) onClose();
              })
            }
            data-testid="friend-duel"
          >
            <Icon name="target" size={18} />
            {t("fr.duel")}
          </Btn>
        ) : null}
        <Btn
          variant="secondary"
          onClick={() => {
            onClose();
            nav.push({ name: "pairInvite", partner: friend.member_id, partnerLabel: label });
          }}
          data-testid="friend-pair"
        >
          <Icon name="chat" size={18} />
          {t("fr.pair")}
        </Btn>
        <ErrorLine text={challenge.error ?? remove.error ?? block.error} />
        <Btn variant="link" busy={remove.busy} onClick={() => void remove.run()} data-testid="friend-remove">
          <Icon name="trash" size={16} />
          {t("fr.remove")}
        </Btn>
        <Btn variant="link" busy={block.busy} onClick={() => void block.run()} data-testid="friend-block">
          <Icon name="lock" size={16} />
          {t("fr.block")}
        </Btn>
        <Btn variant="link" onClick={() => setComplain(true)} data-testid="friend-complain">
          <Icon name="flag" size={16} />
          {t("fr.complain")}
        </Btn>
        <p className="sub small">{t("soc.privacy")}</p>
      </div>
    </Sheet>
  );
}

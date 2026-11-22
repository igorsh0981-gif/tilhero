/**
 * «Друзья и жалобы» (sprint 7, ADM-SOC-01, social.read): the social card of a learner by UUID — the community profile
 * (nickname, friend code, member_id, hidden game profile), friends (a number), friend requests (statuses and dates,
 * never the other side), blocks (given / received), cases where the learner complained or was complained about, the
 * sanctions with their basis and term, and the active restriction. A moderator never sees correspondence: there is
 * none to show here (ADM-SOC-01 acceptance). With moderation.manage a sanction in force can be revoked and a case opens
 * in «Модерация». The «Сообщество» tab of the learner card in «Ученики» — LearnerSocial.tsx.
 * Routes: #/friends · #/friends/<user_id>.
 */
import { useState } from "react";
import type { AdminSanction } from "@tilhero/contracts/admin";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, CopyBtn, Empty, Pill, Spinner } from "../../ui/kit";
import { Kpi } from "../game/parts";
import { CASE_TONE, caseRole, codeMasked, parseFriendsRoute, REQUEST_TONE } from "./model";
import { PrivacyNote, RevokeDialog, SanctionsTable, UserLookup } from "./parts";
import { isProfileMissing, useSocialCard } from "./LearnerSocial";

export function FriendsPage({ routeId }: { routeId: string | null }) {
  const { t } = useI18n();
  const uid = parseFriendsRoute(routeId);
  return (
    <div className="stack" data-testid="friends">
      {uid ? <SocialCard key={uid} userId={uid} /> : <UserLookup page="friends" title={t("fr.lookup")} text={t("fr.lookupM")} testId="fr-lookup" />}
    </div>
  );
}

function SocialCard({ userId }: { userId: string }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const { card, error, load } = useSocialCard(userId);
  const [revoke, setRevoke] = useState<AdminSanction | null>(null);
  const moderate = can("moderation.manage");
  const none = isProfileMissing(error);
  return (
    <div className="stack" data-testid="fr-card" data-user={userId}>
      <div className="row">
        <Btn size="sm" kind="ghost" icon="chevL" label={t("mem.otherLearner")} onClick={() => navigate("friends")} testId="fr-back" />
        <span className="mono small muted" title={userId}>
          {shortId(userId, 8, 4)}
        </span>
        <span className="grow" />
        {can("users.read") && <Btn size="sm" icon="users" label={t("mem.toCard")} onClick={() => navigate("users", userId)} testId="fr-to-card" />}
        {can("game.read") && <Btn size="sm" icon="coins" label={t("lr.gameOpen")} onClick={() => navigate("game", `wallets/${userId}`)} testId="fr-to-wallet" />}
      </div>
      {error && !card ? (
        none ? (
          <Empty icon="users" title={t("fr.none")} text={t("fr.noneM")} testId="fr-none" />
        ) : (
          <LoadError error={error} onRetry={load} />
        )
      ) : !card ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <>
          {card.restrictions.social_ban && (
            <Callout kind="bad" icon="ban" testId="fr-restricted">
              <b>{t("fr.banned")}</b> {card.restrictions.social_ban_until ? t("fr.bannedUntil", { t: fmt.dateTime(card.restrictions.social_ban_until) }) : t("fr.bannedForever")}
            </Callout>
          )}
          <div className="kpis" data-testid="fr-kpis">
            <Kpi label={t("fr.nickname")} value={card.nickname ? <span lang="ru" data-testid="fr-nick">{card.nickname}</span> : <span className="muted small">{t("fr.noNick")}</span>} note={card.nickname_changed_at ? t("fr.nickChanged", { t: fmt.date(card.nickname_changed_at) }) : t("fr.nickNever")} />
            <Kpi label={t("fr.friends")} value={<span data-testid="fr-friends">{fmt.num(card.friends)}</span>} note={t("fr.friendsNote")} />
            <Kpi label={t("fr.blocks")} value={<span data-testid="fr-blocks">{t("fr.blocksV", { g: fmt.num(card.blocks.given), r: fmt.num(card.blocks.received) })}</span>} note={t("fr.blocksNote")} />
            <Kpi label={t("fr.cases")} value={<span data-testid="fr-cases-n">{fmt.num(card.cases.as_target)}</span>} note={t("fr.casesNote", { o: fmt.num(card.cases.open_as_target), r: fmt.num(card.cases.as_reporter) })} />
          </div>
          <div className="grid2">
            <section className="card stack sm" aria-labelledby="fr-prof-h" data-testid="fr-profile">
              <h2 className="h3" id="fr-prof-h">
                {t("fr.profile")}
              </h2>
              {card.friend_code == null && <p className="small muted" data-testid="fr-no-profile">{t("fr.noProfile")}</p>}
              <div className="kv">
                <span>member_id</span>
                <span className="row xs-gap">
                  <span className="mono xs" data-testid="fr-member">{card.member_id}</span>
                  <CopyBtn value={card.member_id} label="member_id" />
                </span>
              </div>
              <div className="kv">
                <span>{t("fr.code")}</span>
                <span className="mono" data-testid="fr-code" data-masked={String(codeMasked(card.friend_code))}>
                  {card.friend_code ?? "—"}
                </span>
              </div>
              {card.friend_code && (
                <p className="xs muted row" data-testid="fr-code-note">
                  <Icon name={codeMasked(card.friend_code) ? "lock" : "eye"} /> {codeMasked(card.friend_code) ? t("fr.codeMasked") : t("fr.codeFull")}
                </p>
              )}
              <div className="kv">
                <span>{t("fr.hidden")}</span>
                <span data-testid="fr-hidden">{card.game_profile_hidden ? t("fr.hiddenYes") : t("common.no")}</span>
              </div>
              <div className="kv">
                <span>{t("fr.restriction")}</span>
                <span>{card.restrictions.social_ban ? <Pill tone="bad">{card.restrictions.social_ban_until ? t("soc.until", { t: fmt.dateTime(card.restrictions.social_ban_until) }) : t("soc.forever")}</Pill> : <Pill tone="good">{t("fr.noRestriction")}</Pill>}</span>
              </div>
              <PrivacyNote text={t("fr.privacy")} testId="fr-privacy" />
            </section>
            <section className="card stack sm" aria-labelledby="fr-req-h" data-testid="fr-requests">
              <h2 className="h3" id="fr-req-h">
                {t("fr.requests", { n: card.requests.length })}
              </h2>
              {card.requests.length ? (
                <div className="table-wrap soc-scroll">
                  <table className="tbl dense" data-testid="fr-req-rows">
                    <caption className="sr-only">{t("fr.requests", { n: card.requests.length })}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t("fr.col.dir")}</th>
                        <th scope="col">{t("col.status")}</th>
                        <th scope="col">{t("col.created")}</th>
                        <th scope="col">{t("fr.col.decided")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {card.requests.map((r) => (
                        <tr key={r.request_id} data-status={r.status}>
                          <td className="small">
                            <Icon name={r.direction === "in" ? "down" : "up"} /> {t(`fr.dir.${r.direction}` as MessageKey)}
                          </td>
                          <td>
                            <Pill tone={REQUEST_TONE[r.status]}>{t(`frs.${r.status}` as MessageKey)}</Pill>
                          </td>
                          <td className="small nowrap">{fmt.dateTime(r.created_at)}</td>
                          <td className="small nowrap">{r.decided_at ? fmt.dateTime(r.decided_at) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="small muted">{t("fr.noRequests")}</p>
              )}
              <p className="xs muted">{t("fr.requestsNote")}</p>
            </section>
          </div>
          <section className="panel" aria-labelledby="fr-cases-h" data-testid="fr-cases">
            <div className="panel-h">
              <h2 className="panel-t grow" id="fr-cases-h">
                <Icon name="flag" /> {t("fr.recentCases", { n: card.cases.recent.length })}
              </h2>
              {moderate && <Btn size="sm" icon="flag" label={t("fr.toModeration")} onClick={() => navigate("moderation", "cases")} testId="fr-to-mod" />}
            </div>
            {card.cases.recent.length ? (
              <div className="table-wrap">
                <table className="tbl compact" data-testid="fr-case-rows">
                  <caption className="sr-only">{t("fr.recentCases", { n: card.cases.recent.length })}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("col.created")}</th>
                      <th scope="col">{t("fr.col.role")}</th>
                      <th scope="col">{t("mod.col.subject")}</th>
                      <th scope="col">{t("mod.col.reason")}</th>
                      <th scope="col">{t("col.status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {card.cases.recent.map((c) => {
                      const role = caseRole(c, userId);
                      return (
                        <tr key={c.case_id} data-testid={`fr-case-${c.case_id}`} data-role={role ?? ""}>
                          <td className="small nowrap">
                            {moderate ? (
                              <button type="button" className="tr" onClick={() => navigate("moderation", `cases/${c.case_id}`)} data-testid={`fr-case-open-${c.case_id}`}>
                                {fmt.dateTime(c.created_at)}
                              </button>
                            ) : (
                              fmt.dateTime(c.created_at)
                            )}
                          </td>
                          <td className="small">{role ? t(`fr.role.${role}` as MessageKey) : "—"}</td>
                          <td className="small">{t(`subj.${c.subject_kind}` as MessageKey)}</td>
                          <td className="small">{t(`crsn.${c.reason}` as MessageKey)}</td>
                          <td>
                            <Pill tone={CASE_TONE[c.status]}>{t(`cst7.${c.status}` as MessageKey)}</Pill>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="flag" title={t("fr.noCases")} testId="fr-no-cases" />
            )}
          </section>
          <section className="panel" aria-labelledby="fr-sanc-h" data-testid="fr-sanctions">
            <div className="panel-h">
              <h2 className="panel-t grow" id="fr-sanc-h">
                <Icon name="ban" /> {t("fr.sanctions", { n: card.sanctions.length })}
              </h2>
            </div>
            <div className="panel-b">
              <SanctionsTable items={card.sanctions} onRevoke={moderate ? setRevoke : null} testId="fr-sanc" />
            </div>
          </section>
          {!moderate && (
            <p className="xs muted row" data-testid="fr-ro">
              <Icon name="lock" /> {t("perm.need", { p: "moderation.manage" })}
            </p>
          )}
        </>
      )}
      {revoke && (
        <RevokeDialog
          sanction={revoke}
          onClose={() => setRevoke(null)}
          onDone={() => {
            setRevoke(null);
            load();
          }}
        />
      )}
    </div>
  );
}

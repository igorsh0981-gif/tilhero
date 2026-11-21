import { flag } from "../../config/experience";
import { familyPick } from "../../domain/social";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, NavRow, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";
import { useChallenge } from "./Duels";
import { MemberAvatar, PrivacyNote, SocialError } from "./parts";

/**
 * «Моя семья» of a child profile 6–13 (instead of «Друзья»: children have no friends, requests or strangers): the
 * members of the family by nickname or «Участник семьи» with their hero — a duel or a pair lesson with one of them, the
 * family league «вместе набрали». Names of the family are not shown here.
 */
export function KidFamilyScreen() {
  const { bff, nav, session, config } = useApp();
  const { t } = useI18n();
  const data = useLoad(async () => {
    const [family, leagues] = await Promise.all([bff.family(), bff.leagues().catch(() => null)]);
    return { family, leagues };
  }, [session.learner.learner_id]);
  const challenge = useChallenge();
  const gameOn = flag(config, "game");
  const members = data.data ? familyPick(data.data.family, data.data.leagues?.family, t) : [];
  const fam = data.data?.leagues?.family ?? null;
  return (
    <>
      <Bar title={t("profile.myFamily")} onBack={nav.back} />
      <main className="scroll" data-testid="kid-family">
        {!data.data ? (
          data.loading ? <div className="pad"><Skeleton lines={3} /></div> : <SocialError error={data.error} errorObj={data.errorObj} onRetry={() => void data.reload()} />
        ) : (
          <div className="pad stack loose">
            <p className="sub ink">{t("soc.card.textKid")}</p>
            {fam ? (
              <button type="button" className="row boxed" onClick={() => nav.push({ name: "leagues" })} data-testid="kid-league">
                <span className="nic"><Icon name="trophy" size={20} /></span>
                <span className="t">
                  <b>{t("soc.link.leagues")}</b>
                  <span>{t("lg.togetherKid", { n: fam.total_xp })}</span>
                </span>
                <Icon name="chevron" size={18} stroke={2} />
              </button>
            ) : null}
            <section className="stack tight" aria-labelledby="kf-h">
              <h2 className="sec" id="kf-h">{t("soc.link.family")}</h2>
              {members.length ? (
                <ul className="stack tight" data-testid="kid-members">
                  {members.map((m) => (
                    <li key={m.member_id} className="card stack tight" data-testid="kid-member">
                      <div className="hrow">
                        <MemberAvatar hero={m.hero} />
                        <b className="grow">{m.label}</b>
                      </div>
                      <div className="duo">
                        {gameOn ? (
                          <Btn variant="secondary" busy={challenge.busy} onClick={() => void challenge.run(m.member_id)} aria-label={`${t("soc.btn.duel")}: ${m.label}`} data-testid="kid-duel">
                            <Icon name="target" size={18} />
                            {t("soc.btn.duel")}
                          </Btn>
                        ) : null}
                        <Btn variant="secondary" onClick={() => nav.push({ name: "pairInvite", partner: m.member_id, partnerLabel: m.label })} aria-label={`${t("soc.link.pair")}: ${m.label}`} data-testid="kid-pair">
                          <Icon name="chat" size={18} />
                          {t("soc.link.pair")}
                        </Btn>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sub" data-testid="kid-no-family">{t("lg.familyEmpty")}</p>
              )}
              <ErrorLine text={challenge.error} />
            </section>
            <div className="list">
              {gameOn ? <NavRow title={t("soc.link.duels")} icon="target" onClick={() => nav.push({ name: "duels" })} testId="kid-to-duels" /> : null}
              <NavRow title={t("soc.link.pair")} icon="chat" onClick={() => nav.push({ name: "pairRooms" })} testId="kid-to-pair" />
            </div>
            <PrivacyNote kid />
          </div>
        )}
      </main>
    </>
  );
}

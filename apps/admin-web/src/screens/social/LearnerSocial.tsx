/**
 * The «Сообщество» tab of the learner card in «Ученики» (sprint 7, social.read): the short social card — nickname,
 * friends, blocks, cases, the active restriction — and the way to the whole card in «Друзья и жалобы». In the main
 * chunk with the learner card (small); the sections themselves load on first visit.
 */
import { useCallback, useEffect, useState } from "react";
import type { AdminSocialCard } from "@tilhero/contracts/admin";
import { Social } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, Empty, Spinner } from "../../ui/kit";
import { Kpi } from "../game/parts";

/** 404 SOCIAL_PROFILE_NOT_FOUND: social does not know the learner (never in the community, or deleted — the same
 *  answer) — a calm state «not found in the community», not a failure. Any other error is a failure. */
export const isProfileMissing = (e: unknown): boolean => e instanceof ApiError && e.code === "SOCIAL_PROFILE_NOT_FOUND";

export function useSocialCard(userId: string) {
  const [card, setCard] = useState<AdminSocialCard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    Social.card(userId)
      .then((c) => (setCard(c), setError(null)))
      .catch(setError);
  }, [userId]);
  useEffect(load, [load]);
  return { card, error, load };
}

/** The «Сообщество» tab of the learner card (social.read): the short card and the way to the whole one. */
export function LearnerSocialTab({ id }: { id: string }) {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const { card, error, load } = useSocialCard(id);
  if (error && !card)
    return isProfileMissing(error) ? <Empty icon="users" title={t("fr.none")} text={t("fr.noneCard")} testId="lc-social-none" /> : <LoadError error={error} onRetry={load} />;
  if (!card) return <Spinner label={t("common.loading")} />;
  return (
    <div className="stack" data-testid="lc-social">
      {card.restrictions.social_ban && (
        <Callout kind="bad" icon="ban" testId="lc-social-ban">
          <b>{t("fr.banned")}</b> {card.restrictions.social_ban_until ? t("fr.bannedUntil", { t: fmt.dateTime(card.restrictions.social_ban_until) }) : t("fr.bannedForever")}
        </Callout>
      )}
      <div className="kpis mem-kpis">
        <Kpi label={t("fr.nickname")} value={card.nickname ? <span lang="ru">{card.nickname}</span> : <span className="muted small">{t("fr.noNick")}</span>} />
        <Kpi label={t("fr.friends")} value={fmt.num(card.friends)} />
        <Kpi label={t("fr.blocks")} value={t("fr.blocksV", { g: fmt.num(card.blocks.given), r: fmt.num(card.blocks.received) })} />
        <Kpi label={t("fr.cases")} value={fmt.num(card.cases.as_target)} note={t("fr.casesNote", { o: fmt.num(card.cases.open_as_target), r: fmt.num(card.cases.as_reporter) })} />
      </div>
      <p className="xs muted">{t("lr.socialNote")}</p>
      <div className="acts">
        <Btn kind="primary" icon="userPlus" label={t("lr.socialOpen")} onClick={() => navigate("friends", id)} testId="lc-social-open" />
      </div>
    </div>
  );
}

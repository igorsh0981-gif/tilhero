import type { DeletionResponse } from "@tilhero/contracts/bff";
import { env } from "../../env";
import { useI18n, type MessageKey } from "../../i18n";
import { openTelegramLink, tgClose, useMainButton } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Flap, Spinner, Wordmark } from "../../ui/kit";

export function Boot() {
  const { t } = useI18n();
  return (
    <div className="sys-scr" data-testid="boot" aria-busy="true">
      <Wordmark large />
      <h1>{t("sys.boot")}</h1>
      <p>{t("sys.bootSub")}</p>
      <Spinner />
    </div>
  );
}

/** Production build opened in a normal browser. */
export function OpenInTelegram({ dev }: { dev: boolean }) {
  const { t } = useI18n();
  const bot = env.botUsername;
  return (
    <div className="sys-scr" data-testid="open-in-telegram">
      <Wordmark large />
      <h1>{t("sys.tg.h")}</h1>
      <p>{t("sys.tg.p")}</p>
      <div className="btns">
        <a
          className="btn btn-lime"
          href={`https://t.me/${encodeURIComponent(bot)}`}
          rel="noopener noreferrer"
          target="_blank"
          onClick={(e) => {
            e.preventDefault();
            openTelegramLink(`https://t.me/${encodeURIComponent(bot)}`);
          }}
        >
          <Icon name="tgp" size={18} />
          {t("sys.tg.btn", { bot })}
        </a>
      </div>
      {dev && <p className="hint">{t("sys.tg.dev")}</p>}
    </div>
  );
}

export function Fatal({ title, text }: { title: MessageKey; text: string }) {
  const { t } = useI18n();
  return (
    <div className="sys-scr" data-testid="fatal">
      <span className="pin-badge">
        <Icon name="alert" size={26} />
      </span>
      <h1>{t(title)}</h1>
      <p>{text}</p>
      <p className="hint">{t("sys.reopen")}</p>
    </div>
  );
}

const DOMAIN_KEYS: Record<string, MessageKey> = {
  identity: "del.svc.identity",
  "identity-consent": "del.svc.identity",
  preferences: "del.svc.preferences",
  support: "del.svc.support",
  notifications: "del.svc.notifications",
  recommendations: "del.svc.recommendations",
  watch: "del.svc.watch",
  offers: "del.svc.offers",
  "ai-concierge": "del.svc.ai",
  "ai-control": "del.svc.aiusage",
  news: "del.svc.news",
};

/** POST /v1/profile/delete-request → 202: «Запрос принят». The saga (ACK of every domain) completes in the background. */
export function DeletionAccepted({ r }: { r: DeletionResponse | null }) {
  const { t } = useI18n();
  useMainButton({ text: t("del.close"), onClick: () => tgClose() });
  const domains = r?.domains?.length ? r.domains : ["identity-consent", "preferences", "support", "notifications"];
  return (
    <div className="del" data-testid="deletion-accepted">
      <h1>{t("del.acc.h")}</h1>
      <p>{t("del.acc.p")}</p>
      <ul className="board">
        {domains.map((d) => (
          <li key={d} className="brow">
            <span className="st">
              <Icon name="clock" size={13} />
            </span>
            <span className="brow-t">
              <b>{DOMAIN_KEYS[d] ? t(DOMAIN_KEYS[d]!) : d}</b>
            </span>
            <Flap tone="info">{t("flap.requested")}</Flap>
          </li>
        ))}
      </ul>
      {r && (
        <dl className="kv del-req">
          <dt>{t("del.acc.id")}</dt>
          <dd className="mono">{r.request_id}</dd>
        </dl>
      )}
      <p className="hint mt16">{t("del.acc.note")}</p>
    </div>
  );
}

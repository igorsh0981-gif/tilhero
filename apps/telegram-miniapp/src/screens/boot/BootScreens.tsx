import { env } from "../../env";
import { useI18n, type MessageKey } from "../../i18n";
import { openTelegramLink } from "../../tg";
import { Btn, HERO, Hero } from "../../ui/kit";

export function Loading() {
  const { t } = useI18n();
  return (
    <main className="state" aria-busy="true" data-testid="boot-loading">
      <Hero src={HERO.volt} alt="" />
      <p className="sub" role="status">{t("boot.loading")}</p>
    </main>
  );
}

/** Production build opened in a browser: TilHero works only inside Telegram (initData is checked on the server). */
export function Outside() {
  const { t } = useI18n();
  return (
    <main className="state" data-testid="boot-outside">
      <Hero src={HERO.nilu} alt="" />
      <h1 className="h2">{t("boot.outside.title")}</h1>
      <p className="sub">{t("boot.outside.text")}</p>
      <Btn onClick={() => openTelegramLink(`https://t.me/${env.botUsername}`)}>{t("boot.outside.open")}</Btn>
    </main>
  );
}

export type BootErrorKind = "reopen" | "network" | "deleted";

/** Sign-in failed (AT-01): a changed or expired initData — reopen; no network — retry; a deleted account. */
export function BootError({ kind, code, onRetry }: { kind: BootErrorKind; code: string; onRetry: () => void }) {
  const { t } = useI18n();
  const title: MessageKey = kind === "deleted" ? "boot.deleted.title" : kind === "network" ? "boot.net.title" : "boot.error.title";
  return (
    <main className="state" data-testid={`boot-error-${kind}`}>
      <Hero src={HERO.myatikEgg} alt="" />
      <h1 className="h2">{t(title)}</h1>
      <p className="sub" role="alert">{kind === "deleted" ? t("boot.deleted.text") : t(`err.${code}` as MessageKey)}</p>
      {kind === "network" ? <Btn onClick={onRetry}>{t("c.retry")}</Btn> : <p className="sub small">{t("boot.error.reopen")}</p>}
    </main>
  );
}

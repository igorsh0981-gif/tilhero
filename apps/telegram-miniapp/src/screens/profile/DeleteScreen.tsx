import type { DeletionResponse } from "@tilhero/contracts/bff";
import { useState } from "react";
import { children } from "../../domain/people";
import { translate, useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction } from "../../state/hooks";
import { Btn, Check, ErrorLine, Field, TextInput } from "../../ui/kit";
import { Bar } from "../../ui/shell";

/** The confirmation word of the contract (bff.ts DeletionRequest): УДАЛИТЬ | OʻCHIRISH. */
export function confirmWord(lang: "ru" | "uz"): string {
  return translate(lang, "del.word");
}

/** Normalises the typed word: case, spaces and the Uzbek apostrophe variants (ʻ ' ‘ `). */
export function wordMatches(typed: string, word: string): boolean {
  const norm = (s: string) => s.trim().toUpperCase().replace(/[ʻ'‘`’]/g, "ʻ");
  return norm(typed) === norm(word);
}

/**
 * Deletion of the account and all data (APP-AUTH-04, AT-14): what is deleted, the child profiles that go with it,
 * confirmation with the parent code (when set) or the confirmation word. After 202 the sessions are revoked.
 */
export function DeleteScreen() {
  const { bff, session, nav, endSession } = useApp();
  const { t, lang } = useI18n();
  const [ok, setOk] = useState(false);
  const [word, setWord] = useState("");
  const [pin, setPin] = useState("");
  const usePin = session.security.pin_enabled;
  const pinLen = session.security.pin_length ?? 4;
  const w = confirmWord(lang);
  const ready = ok && (usePin ? new RegExp(`^\\d{${pinLen}}$`).test(pin) : wordMatches(word, w));
  const kids = children(session).length;
  const del = useAction(async () => {
    const res = await bff.requestDeletion(usePin ? { pin } : { confirm_word: w });
    endSession("deleted", res);
  });
  return (
    <>
      <Bar title={t("del.title")} onBack={nav.back} />
      <main className="scroll" data-testid="delete">
        <div className="pad stack">
          <h2 className="h1">{t("del.ask")}</h2>
          <div className="card">
            <p className="h3">{t("del.will")}</p>
            <p className="sub mt4">{t("del.willText")}</p>
            {kids ? <p className="sub ink mt8">{t("del.kids", { n: kids })}</p> : null}
            <p className="h3 mt16">{t("del.keep")}</p>
            <p className="sub mt4">{t("del.keepText")}</p>
          </div>
          <Check checked={ok} onChange={setOk} testId="del-chk">{t("del.chk")}</Check>
          {usePin ? (
            <Field label={t("del.pin")}>
              {(id, d) => (
                <TextInput id={id} aria-describedby={d} type="password" inputMode="numeric" autoComplete="off" maxLength={pinLen} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} data-testid="del-pin" />
              )}
            </Field>
          ) : (
            <Field label={t("del.typeWord", { w })}>
              {(id, d) => <TextInput id={id} aria-describedby={d} autoComplete="off" value={word} onChange={(e) => setWord(e.target.value)} data-testid="del-word" />}
            </Field>
          )}
          <ErrorLine text={del.error} />
          <Btn variant="danger" busy={del.busy} disabled={!ready} onClick={() => void del.run()} data-testid="del-go">
            {t("del.go")}
          </Btn>
        </div>
      </main>
    </>
  );
}

const DOMAIN_KEYS: Record<string, MessageKey> = {
  "identity-consent": "del.domain.identity",
  "learning-plan": "del.domain.plan",
  social: "del.domain.social",
  notifications: "del.domain.notifications",
  support: "del.domain.support",
  "experience-config": "del.domain.experience",
};

/** After 202: the request is accepted, sessions are revoked — nothing more is called. */
export function DeletionDone({ res }: { res: DeletionResponse }) {
  const { t } = useI18n();
  return (
    <main className="scroll" data-testid="deletion-done">
      <div className="pad stack">
        <h1 className="h1">{t("del.run")}</h1>
        <p className="sub">{t("del.runText")}</p>
        <div className="card">
          <div className="tl"><i className="d" aria-hidden="true">✓</i><div><b className="h3">{t("del.req")}</b><p className="sub">{t("del.learners", { n: res.learners })}</p></div></div>
          {res.domains.map((d) => (
            <div key={d} className="tl">
              <i className="p" aria-hidden="true">…</i>
              <div>
                <b className="h3">{DOMAIN_KEYS[d] ? t(DOMAIN_KEYS[d]!) : d}</b>
                <p className="sub">{t("del.pending")}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="sub small">{t("del.number", { id: res.request_id.slice(0, 8) })}</p>
      </div>
    </main>
  );
}

import { useId, useRef, type ReactNode } from "react";
import type { UiLang } from "@tilhero/contracts/admin";
import { useI18n } from "../../i18n";
import { lt } from "../../i18n/learner";
import { Icon } from "../../ui/Icon";
import { cx, Seg } from "../../ui/kit";
import type { FieldIssue } from "./catalog";

/** Human text of a field issue (client check or a 422 of the domain). */
export function useIssueText() {
  const { t } = useI18n();
  return (x: FieldIssue | undefined | null): string | null => {
    if (!x) return null;
    switch (x.reason) {
      case "required":
        return t("fx.required");
      case "too_long":
        return t("fx.tooLong", { n: x.max ?? 0 });
      case "invalid_format":
        return t("fx.format");
      case "control_chars":
        return t("fx.control");
      case "unknown_placeholder":
        return t("fx.unknownPh", { x: (x.names ?? []).map((n) => `{${n}}`).join(", ") });
      case "invalid_placeholder":
        return t("fx.invalidPh", { x: (x.names ?? []).join(" ") });
      case "pressure_words":
        return t("fx.pressure");
      default:
        return t("fx.server");
    }
  };
}

/**
 * A text field of the RU/UZ editors: label, live «n/max» counter, the issue under the field (aria-describedby), and an
 * empty translation highlighted (`is-missing`) while the other language already has text.
 */
export function TextInput({
  id,
  label,
  value,
  onChange,
  max,
  issue,
  missing,
  multiline,
  rows = 3,
  placeholder,
  disabled,
  required = true,
  lang,
  onFocusEl,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  issue?: FieldIssue | null;
  missing?: boolean;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  lang?: UiLang;
  onFocusEl?: (el: HTMLInputElement | HTMLTextAreaElement) => void;
  testId?: string;
}) {
  const { t } = useI18n();
  const issueText = useIssueText();
  const msg = issueText(issue);
  const over = value.trim().length > max;
  const errId = `${id}-err`;
  const cntId = `${id}-cnt`;
  const common = {
    id,
    value,
    disabled,
    placeholder,
    lang: lang === "uz" ? "uz-Latn" : lang,
    maxLength: max + 200,
    "aria-invalid": !!msg || !!missing || undefined,
    "aria-required": required || undefined,
    "aria-describedby": [msg ? errId : null, cntId].filter(Boolean).join(" "),
    "data-testid": testId,
    "data-missing": missing ? "true" : undefined,
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => onFocusEl?.(e.currentTarget),
  };
  return (
    <div className={cx("field", missing && "is-missing")}>
      <div className="field-top">
        <label htmlFor={id} className={required ? "req" : undefined}>
          {label}
          {missing && !msg && (
            <span className="miss-badge" data-testid={testId ? `${testId}-missing` : undefined}>
              {t("fx.empty")}
            </span>
          )}
        </label>
        <span className={cx("counter", over && "is-over")} id={cntId} aria-live="off">
          {value.trim().length}/{max}
        </span>
      </div>
      {multiline ? (
        <textarea {...common} className={cx("textarea", (msg || missing) && "is-invalid")} rows={rows} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} className={cx("input", (msg || missing) && "is-invalid")} onChange={(e) => onChange(e.target.value)} />
      )}
      {msg && (
        <span className="err" role="alert" id={errId}>
          <Icon name="alertCircle" />
          {msg}
        </span>
      )}
    </div>
  );
}

/** Inserts `{name}` at the caret of the last focused field and returns the new value (or null when no field). */
export function useInsertAtCaret() {
  const last = useRef<{ el: HTMLInputElement | HTMLTextAreaElement; set: (v: string) => void } | null>(null);
  const track = (set: (v: string) => void) => (el: HTMLInputElement | HTMLTextAreaElement) => {
    last.current = { el, set };
  };
  const insert = (text: string): boolean => {
    const cur = last.current;
    if (!cur || !cur.el.isConnected || cur.el.disabled) return false;
    const { el, set } = cur;
    const a = el.selectionStart ?? el.value.length;
    const b = el.selectionEnd ?? a;
    const next = el.value.slice(0, a) + text + el.value.slice(b);
    set(next);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(a + text.length, a + text.length);
    }, 0);
    return true;
  };
  return { track, insert };
}

/** RU/UZ switch of the learner-facing previews and the light/dark scheme of the Mini App. */
export function PreviewControls({ lang, setLang, dark, setDark }: { lang: UiLang; setLang: (l: UiLang) => void; dark?: boolean; setDark?: (d: boolean) => void }) {
  const { t } = useI18n();
  return (
    <div className="row prev-ctl">
      <Seg<UiLang>
        label={t("pv.lang")}
        value={lang}
        onChange={setLang}
        testId="pv-lang"
        items={[
          { v: "ru", label: "RU" },
          { v: "uz", label: "UZ" },
        ]}
      />
      {setDark && (
        <Seg<"light" | "dark">
          label={t("pv.scheme")}
          value={dark ? "dark" : "light"}
          onChange={(v) => setDark(v === "dark")}
          testId="pv-scheme"
          items={[
            { v: "light", label: t("theme.light") },
            { v: "dark", label: t("theme.dark") },
          ]}
        />
      )}
    </div>
  );
}

/** Phone frame of the prototype (`.phone`): 280 px, dark bezel; `dark` switches the Mini App palette inside. */
export function Phone({ dark, label, children, testId }: { dark?: boolean; label: string; children: ReactNode; testId?: string }) {
  return (
    <figure className={cx("phone", dark && "is-dark")} aria-label={label} data-testid={testId} data-scheme={dark ? "dark" : "light"}>
      <span className="phone-notch" aria-hidden="true" />
      <div className="phone-screen">{children}</div>
      <figcaption className="sr-only">{label}</figcaption>
    </figure>
  );
}

/** A learner text that may be empty in this language: shows a red «пусто» marker instead of nothing. */
export function Maybe({ text, lang, className }: { text: string; lang: UiLang; className?: string }) {
  if (text.trim()) return <span className={className}>{text}</span>;
  return <span className={cx(className, "pv-empty")}>{lt(lang, "empty")}</span>;
}

/** Telegram message of the bot as the learner will see it: bold title, body, inline button. */
export function TelegramMessage({ lang, title, body, button, dark, label, test }: { lang: UiLang; title: string; body: string; button: string | null; dark?: boolean; label: string; test?: boolean }) {
  const id = useId();
  return (
    <Phone dark={dark} label={label} testId="tg-preview">
      <div className="tgp" aria-labelledby={id}>
        <div className="tgp-top">
          <span className="tg-ava">TH</span>
          <div>
            <b id={id}>TilHero</b>
            <div className="xs">{lt(lang, "tg.bot")}</div>
          </div>
        </div>
        <div className="tgp-feed">
          <div className="tgp-msg">
            <div className="tgp-b" lang={lang === "uz" ? "uz-Latn" : lang}>
              <b className="tgp-title">
                {test && lt(lang, "tg.test")}
                <Maybe text={title} lang={lang} />
              </b>
              <div className="tgp-body">
                <Maybe text={body} lang={lang} />
              </div>
            </div>
            {button !== null && <div className="tgp-btn">{button.trim() || lt(lang, "tg.open")}</div>}
          </div>
        </div>
      </div>
    </Phone>
  );
}

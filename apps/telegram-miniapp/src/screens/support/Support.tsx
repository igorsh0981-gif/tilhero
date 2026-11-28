import type { Ticket, TicketCategory, TicketStatus, TicketSummary } from "@tilhero/contracts/bff";
import { useEffect, useRef, useState } from "react";
import { env } from "../../env";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { keyForDraft, type DraftKey } from "../../state/idempotency";
import { Icon } from "../../ui/Icon";
import { Btn, Chip, ErrorLine, Field, Pill, Skeleton, TextInput } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";

const STATUS_TONE: Record<TicketStatus, "ok" | "warn" | "mute" | undefined> = {
  NEW: undefined,
  IN_PROGRESS: undefined,
  WAITING_CUSTOMER: "warn",
  RESOLVED: "ok",
  CLOSED: "mute",
};
const FALLBACK_CATEGORIES: TicketCategory[] = ["LESSON", "SCHEDULE_REMINDERS", "CHILD_PROFILE", "ACCOUNT", "PERSONAL_DATA", "BUG", "OTHER"];

/** Support (APP-SUP-01, AT-15): a request by category, my requests with statuses and operator replies. Sprint 8:
 *  «Вопрос по оплате» opens the new request at once with the category SUBSCRIPTION_PAYMENT (and the order in the subject). */
export function Support({ number, category, subject }: { number?: string; category?: TicketCategory; subject?: string }) {
  const { bff, nav } = useApp();
  const { t, fmt } = useI18n();
  const list = useLoad(() => bff.tickets(null), []);
  const [creating, setCreating] = useState(!!category);
  const opened = useRef(false);

  // deep link ticket_TCK-NNNN: open the ticket with that number once the list is here
  useEffect(() => {
    if (!number || opened.current || !list.data) return;
    const found = list.data.items.find((x) => x.number === number);
    if (found) {
      opened.current = true;
      nav.push({ name: "ticket", id: found.ticket_id });
    }
  }, [number, list.data, nav]);

  return (
    <>
      <Bar title={t("sup.title")} onBack={nav.back} />
      <main className="scroll" data-testid="support">
        <div className="pad stack">
          {creating ? (
            <NewTicket
              initialCategory={category ?? null}
              initialSubject={subject ?? ""}
              onCancel={() => setCreating(false)}
              onCreated={(tk) => {
                setCreating(false);
                list.setData({ items: [tk, ...(list.data?.items ?? [])], next_cursor: list.data?.next_cursor ?? null });
                showToast(t("sup.sent", { n: tk.number }));
              }}
            />
          ) : (
            <Btn onClick={() => setCreating(true)} data-testid="sup-new">
              <Icon name="plus" size={18} />
              {t("sup.new")}
            </Btn>
          )}
          <p className="sec">{t("sup.mine")}</p>
          {list.loading && !list.data ? <Skeleton lines={2} /> : null}
          {list.data?.items.length ? (
            <ul className="list" data-testid="tickets">
              {list.data.items.map((tk: TicketSummary) => (
                <li key={tk.ticket_id}>
                  <button type="button" className="row" onClick={() => nav.push({ name: "ticket", id: tk.ticket_id })}>
                    <span className="t">
                      <small>{tk.number} · {t(`tcat.${tk.category}` as MessageKey)} · {fmt.date(tk.last_message_at)}</small>
                      <b>{tk.subject}</b>
                      <span className="pills">
                        <Pill tone={STATUS_TONE[tk.status]}>{t(`tst.${tk.status}` as MessageKey)}</Pill>
                        {tk.unread_operator_replies ? <Pill tone="ok">{t("sup.unread", { n: tk.unread_operator_replies })}</Pill> : null}
                      </span>
                    </span>
                    <Icon name="chevron" size={18} stroke={2} />
                  </button>
                </li>
              ))}
            </ul>
          ) : !list.loading && !list.error ? (
            <div className="card"><p className="sub">{t("sup.empty")}</p></div>
          ) : null}
          {list.error ? (
            <div className="card err stack tight">
              <p className="sub ink">{list.error}</p>
              <Btn variant="secondary" onClick={() => void list.reload()}>{t("c.retry")}</Btn>
            </div>
          ) : null}
        </div>
      </main>
    </>
  );
}

function NewTicket(props: { initialCategory: TicketCategory | null; initialSubject: string; onCancel: () => void; onCreated: (t: Ticket) => void }) {
  const { onCancel, onCreated } = props;
  const { bff } = useApp();
  const { t, l } = useI18n();
  const cats = useLoad(() => bff.supportCategories(), []);
  const [category, setCategory] = useState<TicketCategory | null>(props.initialCategory);
  const [subject, setSubject] = useState(props.initialSubject);
  const [message, setMessage] = useState("");
  const [touched, setTouched] = useState(false);
  const key = useRef<DraftKey | null>(null);
  const listed = cats.data?.items.filter((c) => c.available).map((c) => ({ code: c.code, label: l(c.label) })) ?? FALLBACK_CATEGORIES.map((c) => ({ code: c, label: t(`tcat.${c}` as MessageKey) }));
  // the preset category (sprint 8: SUBSCRIPTION_PAYMENT) is offered even when the server list does not mark it
  const preset = props.initialCategory;
  const options = preset && !listed.some((c) => c.code === preset) ? [{ code: preset, label: t(`tcat.${preset}` as MessageKey) }, ...listed] : listed;
  const subjOk = subject.trim().length >= 3 && subject.trim().length <= 120;
  const msgOk = message.trim().length >= 1 && message.trim().length <= 4000;
  const send = useAction(async () => {
    const body = { category: category!, subject: subject.trim(), message: message.trim(), context: { client_version: env.clientVersion } };
    key.current = keyForDraft(key.current, body);
    onCreated(await bff.createTicket(body, key.current.key));
  });
  return (
    <div className="card stack" data-testid="sup-form">
      <b className="h3">{t("sup.new")}</b>
      <fieldset className="stack tight">
        <legend className="lb">{t("sup.category")}</legend>
        <div className="chips">
          {options.map((c) => (
            <Chip key={c.code} on={category === c.code} label={c.label} onClick={() => setCategory(c.code)} />
          ))}
        </div>
        {touched && !category ? <p className="field-err" role="alert">{t("err.SUPPORT_CATEGORY_INVALID")}</p> : null}
      </fieldset>
      <Field label={t("sup.subject")} error={touched && !subjOk ? t("sup.subjectErr") : null}>
        {(id, d) => <TextInput id={id} aria-describedby={d} value={subject} maxLength={120} invalid={touched && !subjOk} onChange={(e) => setSubject(e.target.value)} data-testid="sup-subject" />}
      </Field>
      <Field label={t("sup.message")} error={touched && !msgOk ? t("sup.messageErr") : null}>
        {(id, d) => (
          <textarea id={id} aria-describedby={d} className="inp" rows={4} maxLength={4000} value={message} aria-invalid={(touched && !msgOk) || undefined} onChange={(e) => setMessage(e.target.value)} data-testid="sup-message" />
        )}
      </Field>
      <ErrorLine text={send.error} />
      <div className="duo">
        <Btn variant="secondary" onClick={onCancel}>{t("c.cancel")}</Btn>
        <Btn
          busy={send.busy}
          onClick={() => {
            setTouched(true);
            if (category && subjOk && msgOk) void send.run();
          }}
          data-testid="sup-send"
        >
          {t("sup.send")}
        </Btn>
      </div>
    </div>
  );
}

export function TicketScreen({ id }: { id: string }) {
  const { bff, nav } = useApp();
  const { t, fmt } = useI18n();
  const tk = useLoad(() => bff.ticket(id), [id]);
  const [text, setText] = useState("");
  const reply = useAction(async () => {
    tk.setData(await bff.replyTicket(id, text.trim()));
    setText("");
  });
  const close = useAction(async () => {
    tk.setData(await bff.closeTicket(id));
    showToast(t("sup.closed"));
  });
  const d = tk.data;
  const open = d && d.status !== "CLOSED";
  return (
    <>
      <Bar title={d ? d.number : t("sup.title")} onBack={nav.back} />
      <main className="scroll" data-testid="ticket">
        <div className="pad stack">
          {tk.loading && !d ? <Skeleton lines={3} /> : null}
          <ErrorLine text={tk.error} />
          {d ? (
            <>
              <div className="card stack tight">
                <div className="hrow between">
                  <span className="cap">{t(`tcat.${d.category}` as MessageKey)}</span>
                  <Pill tone={STATUS_TONE[d.status]}>{t(`tst.${d.status}` as MessageKey)}</Pill>
                </div>
                <h2 className="h3">{d.subject}</h2>
                {d.sla_first_response_at && d.status === "NEW" ? <p className="sub small">{t("sup.sla", { date: fmt.dateTime(d.sla_first_response_at) })}</p> : null}
              </div>
              <ol className="chat" aria-label={t("sup.messages")}>
                {d.messages.map((m) => (
                  <li key={m.message_id} className={m.sender_type === "user" ? "bub me" : m.sender_type === "operator" ? "bub op" : "bub sys"}>
                    <span className="sr">{m.sender_type === "user" ? t("sup.you") : m.sender_type === "operator" ? m.author_name ?? t("sup.operator") : t("sup.system")}: </span>
                    {m.text}
                    <small aria-hidden="true">
                      {m.sender_type === "operator" ? `${m.author_name ?? t("sup.operator")} · ` : ""}
                      {fmt.dateTime(m.created_at)}
                    </small>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </div>
      </main>
      {open ? (
        <div className="foot">
          <ErrorLine text={reply.error ?? close.error} />
          <label className="sr" htmlFor="reply">{t("sup.reply")}</label>
          <div className="hrow">
            <TextInput id="reply" placeholder={t("sup.reply")} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} data-testid="reply" />
            <button type="button" className="ib" aria-label={t("sup.replySend")} disabled={!text.trim() || reply.busy} onClick={() => void reply.run()} data-testid="reply-send">
              <Icon name="send" size={22} />
            </button>
          </div>
          {d.status !== "RESOLVED" ? (
            <Btn variant="link" className="c" busy={close.busy} onClick={() => void close.run()}>
              {t("sup.close")}
            </Btn>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

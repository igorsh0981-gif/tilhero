import type { Ticket, TicketCategory, TicketContext, TicketStatus, TicketSummary } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/errors";
import { env } from "../../env";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { useSupportCategories } from "../../state/directory";
import { keyForDraft, type DraftKey } from "../../state/idempotency";
import type { EventSupportContext } from "../../state/nav";
import { confirmPopup, haptic, useMainButton, useSecondaryButton } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Badge, Chip, Empty, Note, Spinner } from "../../ui/kit";
import { showToast } from "../../ui/overlays";

/* Support (ТЗ §9, TG-FR-040…043, AT-30/32): create · list · thread with operator replies · close. */
const FLOW: TicketStatus[] = ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"];
const TONE: Record<TicketStatus, "info" | "lime" | "warn" | "good" | undefined> = {
  NEW: "info",
  IN_PROGRESS: "lime",
  WAITING_CUSTOMER: "warn",
  RESOLVED: "good",
  CLOSED: undefined,
};
const ALL_CATS: TicketCategory[] = ["EVENT_RECOMMENDATION", "TICKET_SOURCE", "FLIGHT", "HOTEL", "PRICE", "SUBSCRIPTION_PAYMENT", "ACCOUNT", "PERSONAL_DATA", "BUG", "OTHER"];
const SUBJ_MAX = 120;
const MSG_MAX = 4000;

function StatusBadge({ status }: { status: TicketStatus }) {
  const { t } = useI18n();
  return <Badge tone={TONE[status]}>{t(`tk.st.${status}` as MessageKey)}</Badge>;
}

/* ---------- new request ---------- */
export function SupportNew({ ctx }: { ctx?: EventSupportContext }) {
  const { api, navigate } = useApp();
  const { t, l, fmt } = useI18n();
  const errText = useErrorText();
  const cats = useSupportCategories(api);
  // from an event (TG-FR-041): the category and subject are prefilled, the context is attached to the request
  const [cat, setCat] = useState<TicketCategory | null>(ctx ? (ctx.category ?? "EVENT_RECOMMENDATION") : null);
  const [subj, setSubj] = useState((ctx?.subject ?? ctx?.event_title ?? "").slice(0, SUBJ_MAX));
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // one key per draft CONTENT: a retry with the same data reuses it, an edit gets a new one
  const draftKey = useRef<DraftKey | null>(null);
  const ok = !!cat && subj.trim().length >= 3 && msg.trim().length >= 1;

  const send = async () => {
    if (!ok || sending || !cat) return;
    setSending(true);
    setError(null);
    try {
      // presets (category, subject) are form state, not ticket context
      const { category: _c, subject: _s, ...attach } = ctx ?? ({} as Partial<EventSupportContext>);
      const context: TicketContext = { ...attach, client_version: env.clientVersion };
      const req = { category: cat, subject: subj.trim().slice(0, SUBJ_MAX), message: msg.trim().slice(0, MSG_MAX), context };
      draftKey.current = keyForDraft(draftKey.current, req);
      const tk = await api.support.create(req, draftKey.current.key);
      haptic.notify("success");
      navigate({ type: "replace", route: { name: "supportDone", id: tk.ticket_id, number: tk.number } });
    } catch (e) {
      haptic.notify("error");
      setError(errText(e));
      if (e instanceof ApiError && e.code === "SUPPORT_CATEGORY_INVALID") {
        setCat(null);
        cats.retry();
      }
    } finally {
      setSending(false);
    }
  };
  useMainButton({ text: t("sp.send"), onClick: () => void send(), disabled: !ok, progress: sending });

  const list = cats.items ?? ALL_CATS.map((code) => ({ code, label: null as { ru: string; en: string } | null, available: code !== "SUBSCRIPTION_PAYMENT" }));
  return (
    <>
      <header className="pg-h">
        <h1>{t("sp.new.h")}</h1>
      </header>
      <p className="pg-sub hint">{t("sp.new.sub")}</p>
      <div className="sp-form" data-testid="support-new">
        <div>
          <span className="field-l" id="spCatL">
            {t("sp.cat")}
          </span>
          <div className="sp-cats" role="radiogroup" aria-labelledby="spCatL">
            {list.map((c) => (
              <Chip key={c.code} role="radio" pressed={cat === c.code} disabled={!c.available} onToggle={() => setCat(c.code)}>
                {c.label ? l(c.label) : t(`sp.c.${c.code}` as MessageKey)}
                {!c.available && <small>· {t("sp.later")}</small>}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <label className="field-l" htmlFor="spSubj">
            <span>{t("sp.subj")}</span>
            {subj.trim().length > 0 && subj.trim().length < 3 && <small>{t("sp.subj.short")}</small>}
          </label>
          <div className="field">
            <input id="spSubj" maxLength={SUBJ_MAX} autoComplete="off" placeholder={t("sp.subj.ph")} value={subj} onChange={(e) => setSubj(e.target.value.slice(0, SUBJ_MAX))} />
          </div>
        </div>
        <div>
          <label className="field-l" htmlFor="spMsg">
            <span>{t("sp.msg")}</span>
            {msg.length > MSG_MAX * 0.8 && <small>{t("sp.count", { n: msg.length, max: MSG_MAX })}</small>}
          </label>
          <div className="field area">
            <textarea id="spMsg" maxLength={MSG_MAX} placeholder={t("sp.msg.ph")} value={msg} onChange={(e) => setMsg(e.target.value.slice(0, MSG_MAX))} />
          </div>
        </div>
        {ctx && (
          <div className="sp-ctx" data-testid="support-ctx">
            <div className="sp-ctx-h">
              <Icon name="link" size={16} />
              <b>{t("sp.ctx.attach")}</b>
            </div>
            <dl className="kv">
              <dt>{t("tk.ctx.ev")}</dt>
              <dd>
                {ctx.event_title ? `${ctx.event_title} · ` : ""}
                {ctx.event_id}
              </dd>
              {ctx.offer_id && (
                <>
                  <dt>{t("tk.ctx.offer")}</dt>
                  <dd data-testid="support-ctx-offer">{ctx.offer_id}</dd>
                </>
              )}
              {ctx.provider_id && (
                <>
                  <dt>{t("tk.ctx.prov")}</dt>
                  <dd>{ctx.provider_id}</dd>
                </>
              )}
              {ctx.deeplink && (
                <>
                  <dt>{t("tk.ctx.link")}</dt>
                  <dd>{ctx.deeplink}</dd>
                </>
              )}
              {ctx.price_snapshot && (
                <>
                  <dt>{t(ctx.offer_id ? "sp.ctx.package" : "tk.ctx.price")}</dt>
                  <dd data-testid="support-ctx-price">
                    {fmt.usdDecimal(ctx.price_snapshot.amount)} · {fmt.dateTime(ctx.price_snapshot.fetched_at)}
                  </dd>
                </>
              )}
              <dt>{t("tk.ctx.client")}</dt>
              <dd>{env.clientVersion}</dd>
            </dl>
          </div>
        )}
        <Note icon="shield">{ctx?.offer_id ? t("sp.pii.offer") : ctx ? t("sp.pii.ctx") : t("sp.pii")}</Note>
        {error && (
          <Note tone="bad" icon="alert">
            {error}
          </Note>
        )}
      </div>
    </>
  );
}

/* ---------- created ---------- */
export function SupportDone({ id, number }: { id: string; number: string }) {
  const { navigate } = useApp();
  const { t } = useI18n();
  // after creation the stack is Profile → My requests → (thread), so BackButton lands on the list
  const toList = () => navigate({ type: "reset", stack: [{ name: "profile" }, { name: "supportList" }] });
  useMainButton({
    text: t("sp.done.open"),
    onClick: () => navigate({ type: "reset", stack: [{ name: "profile" }, { name: "supportList" }, { name: "supportThread", id }] }),
  });
  const secondaryShown = useSecondaryButton({ text: t("sp.done.list"), onClick: toList });
  const [before = "", after = ""] = t("sp.done.h").split("{id}");
  return (
    <div className="done-scr" data-testid="support-done">
      <span className="done-ic">
        <Icon name="check" size={40} />
      </span>
      <h1>
        {before}
        <span className="mono">{number}</span>
        {after}
      </h1>
      <p>{t("sp.done.p")}</p>
      {!secondaryShown && (
        <div className="btns">
          <button className="btn btn-soft" type="button" onClick={toList}>
            {t("sp.done.list")}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- list ---------- */
export function SupportList() {
  const { api, navigate } = useApp();
  const { t, fmt } = useI18n();
  const errText = useErrorText();
  const [items, setItems] = useState<TicketSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (more: boolean) => {
      try {
        if (more) setLoadingMore(true);
        const page = await api.support.list(more ? cursor : null);
        setItems((prev) => (more && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.next_cursor);
        setError(null);
      } catch (e) {
        setError(errText(e));
      } finally {
        setLoadingMore(false);
      }
    },
    [api, cursor, errText],
  );
  useEffect(() => {
    void load(false);
    // initial page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useMainButton({ text: t("sp.list.new"), onClick: () => navigate({ type: "push", route: { name: "supportNew" } }) });

  return (
    <>
      <header className="pg-h">
        <h1>{t("sp.list.h")}</h1>
      </header>
      {error && (
        <div className="pd mt12">
          <Note tone="bad" icon="alert" action={{ label: t("common.retry"), onClick: () => void load(false) }}>
            {error}
          </Note>
        </div>
      )}
      {!items && !error && (
        <div className="empty">
          <Spinner />
        </div>
      )}
      {items && !items.length && <Empty icon="chat" title={t("sp.list.empty.h")} text={t("sp.list.empty.p")} />}
      {items && items.length > 0 && (
        <div className="sec tk-list" data-testid="ticket-list">
          {items.map((x) => (
            <button key={x.ticket_id} className="tk" type="button" onClick={() => navigate({ type: "push", route: { name: "supportThread", id: x.ticket_id } })}>
              <div>
                <b>{x.subject}</b>
                <small>
                  {x.number} · {fmt.dateTime(x.created_at)} · {t(`sp.c.${x.category}` as MessageKey)}
                </small>
              </div>
              <span className="tk-side">
                <StatusBadge status={x.status} />
                {x.unread_operator_replies > 0 && (
                  <span className="unread" aria-label={t("tk.unread", { n: x.unread_operator_replies })}>
                    {x.unread_operator_replies}
                  </span>
                )}
              </span>
            </button>
          ))}
          {cursor && (
            <button className="btn btn-soft btn-block mt12" type="button" disabled={loadingMore} onClick={() => void load(true)}>
              {loadingMore ? <Spinner small /> : null}
              {t("common.more")}
            </button>
          )}
        </div>
      )}
      <div className="scr-end" />
    </>
  );
}

/* ---------- thread ---------- */
const POLL_MS = 15_000;

export function SupportThread({ id }: { id: string }) {
  const { api, navigate } = useApp();
  const { t, fmt } = useI18n();
  const errText = useErrorText();
  const [tk, setTk] = useState<Ticket | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);
  /** One Idempotency-Key per reply text: a retry after a lost response does not post the message twice. */
  const replyKey = useRef<DraftKey | null>(null);

  const fetchTicket = useCallback(async () => {
    try {
      const x = await api.support.get(id);
      setTk(x);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api, id]);

  useEffect(() => {
    void fetchTicket();
    // operator replies become visible without reopening (AT-32): poll while the thread is open and visible
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void fetchTicket();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [fetchTicket]);

  useEffect(() => {
    const n = tk?.messages.length ?? 0;
    if (n > lastCount.current) {
      if (lastCount.current > 0 && tk?.messages[n - 1]?.sender_type === "operator") {
        haptic.notify("success");
        showToast(t("tk.newReply"), "chat");
      }
      endRef.current?.scrollIntoView({ block: "nearest" });
    }
    lastCount.current = n;
  }, [tk, t]);

  if (error instanceof ApiError && error.code === "SUPPORT_TICKET_NOT_FOUND") {
    return <Empty icon="help" title={t("err.SUPPORT_TICKET_NOT_FOUND")} text={t("sp.list.empty.p")} />;
  }
  if (!tk) {
    return error ? (
      <div className="pd mt16">
        <Note tone="bad" icon="alert" action={{ label: t("common.retry"), onClick: () => void fetchTicket() }}>
          {errText(error)}
        </Note>
      </div>
    ) : (
      <div className="empty">
        <Spinner />
      </div>
    );
  }

  const idx = FLOW.indexOf(tk.status);
  const closed = tk.status === "CLOSED";
  const send = async () => {
    const v = text.trim().slice(0, MSG_MAX);
    if (!v || sending) return;
    setSending(true);
    try {
      replyKey.current = keyForDraft(replyKey.current, v);
      setTk(await api.support.reply(tk.ticket_id, v, replyKey.current.key));
      replyKey.current = null;
      setText("");
    } catch (e) {
      showToast(errText(e), "alert");
      if (e instanceof ApiError && e.code === "SUPPORT_TICKET_CLOSED") void fetchTicket();
    } finally {
      setSending(false);
    }
  };
  const close = async () => {
    const ok = await confirmPopup({ title: t("tk.close.t"), message: t("tk.close.m"), ok: t("tk.close.ok"), cancel: t("common.cancel") });
    if (!ok) return;
    try {
      setTk(await api.support.close(tk.ticket_id));
      showToast(t("tk.closed.done"));
    } catch (e) {
      showToast(errText(e), "alert");
    }
  };
  const ctx = tk.context;
  const hasCtx = !!ctx && !!(ctx.event_id || ctx.offer_id || ctx.deeplink || ctx.price_snapshot);

  return (
    <div data-testid="support-thread">
      <header className="pg-h">
        <h1 className="mono-h">{tk.number}</h1>
        <StatusBadge status={tk.status} />
      </header>
      <p className="pg-sub hint">{tk.subject}</p>
      <div className="trk" aria-hidden="true">
        {FLOW.map((st, i) => (
          <i key={st} className={i < idx ? "on" : i === idx ? "cur" : undefined} />
        ))}
      </div>
      <div className="trk-l">
        {FLOW.map((st, i) => (
          <span key={st} className={i === idx ? "cur" : undefined}>
            {t(`tk.st.${st}` as MessageKey)}
          </span>
        ))}
      </div>
      {hasCtx && ctx && (
        <div className="pd mt16">
          <div className="sp-ctx">
            <div className="sp-ctx-h">
              <Icon name="link" size={16} />
              <b>{t("tk.ctx.t")}</b>
            </div>
            <dl className="kv">
              {ctx.event_id && (
                <>
                  <dt>{t("tk.ctx.ev")}</dt>
                  <dd>
                    {ctx.event_title ? `${ctx.event_title} · ` : ""}
                    {ctx.event_id}
                  </dd>
                </>
              )}
              {ctx.offer_id && (
                <>
                  <dt>{t("tk.ctx.offer")}</dt>
                  <dd>{ctx.offer_id}</dd>
                </>
              )}
              {ctx.provider_id && (
                <>
                  <dt>{t("tk.ctx.prov")}</dt>
                  <dd>{ctx.provider_id}</dd>
                </>
              )}
              {ctx.deeplink && (
                <>
                  <dt>{t("tk.ctx.link")}</dt>
                  <dd>{ctx.deeplink}</dd>
                </>
              )}
              {ctx.price_snapshot && (
                <>
                  <dt>{t(ctx.offer_id ? "sp.ctx.package" : "tk.ctx.price")}</dt>
                  <dd>
                    {fmt.usdDecimal(ctx.price_snapshot.amount)} USD · {fmt.dateTime(ctx.price_snapshot.fetched_at)}
                  </dd>
                </>
              )}
            </dl>
          </div>
        </div>
      )}
      <div className="th" aria-live="polite" data-testid="thread">
        {tk.sla_first_response_at && (tk.status === "NEW" || tk.status === "IN_PROGRESS") && (
          <div className="msg sys">{t("tk.sla", { time: fmt.dateTime(tk.sla_first_response_at) })}</div>
        )}
        {tk.messages.map((m) => {
          if (m.sender_type === "system") {
            return (
              <div key={m.message_id} className="msg sys">
                {m.text} · {fmt.time(m.created_at)}
              </div>
            );
          }
          if (m.sender_type === "operator") {
            return (
              <div key={m.message_id} className="msg op" data-testid="msg-operator">
                <span className="who">{m.author_name ? t("tk.op", { name: m.author_name }) : t("tk.op.anon")}</span>
                {m.text}
                <time dateTime={m.created_at}>{fmt.time(m.created_at)}</time>
              </div>
            );
          }
          return (
            <div key={m.message_id} className="msg u" data-testid="msg-user">
              {m.text}
              <time dateTime={m.created_at}>{fmt.time(m.created_at)}</time>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {closed ? (
        <p className="pd hint">{t("tk.closed.note")}</p>
      ) : (
        <>
          <div className="th-cmp">
            <div className="field">
              <textarea
                id="tkIn"
                rows={1}
                maxLength={MSG_MAX}
                placeholder={t("tk.reply.ph")}
                aria-label={t("tk.reply.ph")}
                value={text}
                onChange={(e) => {
                  setText(e.target.value.slice(0, MSG_MAX));
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(100, e.target.scrollHeight)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
            </div>
            <button className="send-btn" type="button" aria-label={t("tk.reply.send")} disabled={!text.trim() || sending} onClick={() => void send()}>
              {sending ? <Spinner small /> : <Icon name="up" size={20} />}
            </button>
          </div>
          <div className="th-acts">
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => void close()}>
              <Icon name="check" size={16} />
              {t("tk.solved")}
            </button>
          </div>
        </>
      )}
      <p className="disc">{t("tk.billing")}</p>
      <div className="scr-end" />
      {closed && (
        <div className="pd mt12">
          <button className="btn btn-soft btn-block" type="button" onClick={() => navigate({ type: "push", route: { name: "supportNew" } })}>
            <Icon name="plus" size={16} />
            {t("sp.list.new")}
          </button>
        </div>
      )}
    </div>
  );
}

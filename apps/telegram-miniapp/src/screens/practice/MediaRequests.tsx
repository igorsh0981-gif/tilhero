import type { MediaRequest, MediaRequestCreate } from "@tilhero/contracts/bff";
import { useRef, useState } from "react";
import { newIdempotencyKey } from "../../api/client";
import { HTTPS_LINK } from "../../domain/content";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { haptic } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Field, HERO, Hero, Pill, Seg, Skeleton, TextInput } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";

type Kind = MediaRequestCreate["kind"];
const KINDS: readonly Kind[] = ["song", "movie", "series", "other"];
const STATUS_TONE: Record<MediaRequest["status"], "ok" | "err" | "warn" | "mute" | undefined> = {
  new: "mute",
  in_review: undefined,
  authored_alternative: "ok",
  licensed: "ok",
  rejected: "err",
  duplicate: "warn",
};

/**
 * «Хочу песню или фильм» (APP-MEDIA-04, AT-30): an honest request to the content manager — nothing is downloaded or
 * opened by the link; «Мои заявки» with statuses and the manager's notes. A child profile cannot send requests
 * (AT-38): an explanation «попросите родителя», no calls to the BFF.
 */
export function MediaRequests() {
  const { nav, session } = useApp();
  const { t } = useI18n();
  const kid = session.learner.kind === "child";
  return (
    <>
      <Bar title={t("mr.title")} onBack={nav.back} />
      <main className="scroll" data-testid="media-requests">
        {kid ? (
          <div className="pad stack loose center" data-testid="mr-kids">
            <Hero src={HERO.myatik} alt={t("hero.myatik")} className="dx-hero" />
            <h2 className="h2">{t("mr.kids.title")}</h2>
            <p className="sub">{t("mr.kids.text")}</p>
            <Btn variant="secondary" onClick={nav.back}>{t("c.back")}</Btn>
          </div>
        ) : (
          <RequestsBody />
        )}
      </main>
    </>
  );
}

function RequestsBody() {
  const { bff } = useApp();
  const { t, fmt } = useI18n();
  const list = useLoad(() => bff.mediaRequests(), []);
  const [kind, setKind] = useState<Kind>("song");
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [comment, setComment] = useState("");
  const [touched, setTouched] = useState(false);
  const key = useRef<string | null>(null);
  const titleOk = title.trim().length >= 2;
  const linkOk = link.trim() === "" || HTTPS_LINK.test(link.trim());

  const send = useAction(async () => {
    setTouched(true);
    if (!titleOk || !linkOk) return;
    // one key per draft: a retry after a lost answer does not create a second request
    key.current ??= newIdempotencyKey();
    const body: MediaRequestCreate = {
      kind,
      title: title.trim(),
      ...(link.trim() ? { link: link.trim() } : {}),
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    };
    const created = await bff.createMediaRequest(body, key.current);
    key.current = null;
    haptic.notify("success");
    showToast(t("mr.sent"));
    setTitle("");
    setLink("");
    setComment("");
    setTouched(false);
    list.setData({ items: [created, ...(list.data?.items ?? []).filter((r) => r.request_id !== created.request_id)] });
  });
  const draftChanged = () => {
    key.current = null;
  };

  return (
    <div className="stack loose">
      <div className="pad">
        <div className="card pen notice" data-testid="mr-honest">
          <Icon name="info" size={20} />
          <p className="sub ink">{t("mr.honest")}</p>
        </div>
      </div>

      <form
        className="pad stack"
        onSubmit={(e) => {
          e.preventDefault();
          void send.run();
        }}
        noValidate
        data-testid="mr-form"
      >
        <div className="stack tight">
          <p className="lb" id="mr-kind">{t("mr.kind")}</p>
          <Seg
            label={t("mr.kind")}
            labelledBy="mr-kind"
            value={kind}
            onChange={(k) => {
              setKind(k);
              draftChanged();
            }}
            options={KINDS.map((k) => ({ value: k, label: t(`mr.kind.${k}` as MessageKey) }))}
            testId="mr-kind"
          />
        </div>
        <Field label={t("mr.titleField")} error={touched && !titleOk ? t("mr.titleShort") : null}>
          {(id, d) => (
            <TextInput
              id={id}
              aria-describedby={d}
              value={title}
              maxLength={200}
              placeholder={t("mr.titlePh")}
              invalid={touched && !titleOk}
              onChange={(e) => {
                setTitle(e.target.value);
                draftChanged();
              }}
              data-testid="mr-title"
              autoComplete="off"
            />
          )}
        </Field>
        <Field label={t("mr.link")} hint={t("mr.linkHint")} error={link.trim() && !linkOk ? t("mr.linkInvalid") : null}>
          {(id, d) => (
            <TextInput
              id={id}
              aria-describedby={d}
              value={link}
              maxLength={500}
              inputMode="url"
              type="url"
              placeholder="https://"
              invalid={!!link.trim() && !linkOk}
              onChange={(e) => {
                setLink(e.target.value);
                draftChanged();
              }}
              data-testid="mr-link"
              autoComplete="off"
            />
          )}
        </Field>
        <Field label={t("mr.comment")}>
          {(id, d) => (
            <textarea
              id={id}
              aria-describedby={d}
              className="inp"
              value={comment}
              maxLength={500}
              placeholder={t("mr.commentPh")}
              onChange={(e) => {
                setComment(e.target.value);
                draftChanged();
              }}
              data-testid="mr-comment"
            />
          )}
        </Field>
        <ErrorLine text={send.error} />
        <Btn type="submit" busy={send.busy} disabled={!titleOk || !linkOk} data-testid="mr-send">
          {t("mr.send")}
        </Btn>
        <p className="sub small">{t("mr.limit")}</p>
      </form>

      <section className="pad stack tight" aria-labelledby="mr-mine" data-testid="mr-list">
        <h2 className="sec" id="mr-mine">{t("mr.mine")}</h2>
        {list.loading && !list.data ? (
          <Skeleton lines={2} />
        ) : list.error && !list.data ? (
          <div className="stack tight">
            <ErrorLine text={list.error} />
            <Btn variant="secondary" onClick={() => void list.reload()}>{t("c.retry")}</Btn>
          </div>
        ) : list.data && list.data.items.length ? (
          <ul className="list">
            {list.data.items.map((r) => (
              <li className="row req" key={r.request_id} data-testid={`mr-${r.request_id}`}>
                <div className="hrow between">
                  <b>{r.title}</b>
                  <Pill tone={STATUS_TONE[r.status]}>{t(`mr.status.${r.status}` as MessageKey)}</Pill>
                </div>
                <span className="sub small">
                  {t(`mr.kind.${r.kind}` as MessageKey)} · {fmt.date(r.created_at)}
                </span>
                {r.decision_note ? <p className="sub ink">{t("mr.note", { text: r.decision_note })}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="sub">{t("mr.mineEmpty")}</p>
        )}
      </section>
    </div>
  );
}

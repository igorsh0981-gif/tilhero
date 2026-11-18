import { useEffect, useState } from "react";
import type { AccessLevel, AdminUserCard, UserAccessLevel } from "@tilhero/contracts/admin";
import { AccessApi, AiApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { shortId } from "../../lib/ids";
import { fmtUsd } from "../../lib/money";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Select } from "../../ui/kit";
import { ConfirmCommand, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { Who } from "../ai/parts";

/**
 * «AI» tab of the user card (sprint 7): access level to the concierge (messages per day; assignment with a reason
 * and an optional expiry — users.access.manage, audited by ai-control), AI usage for 30 days, AI conversations —
 * metadata only (the text is never in the card; a request's content is revealed in «Requests and cost» with
 * ai.content.read, a reason and an audit record).
 */
export function UserAiTab({ card, onAccess }: { card: AdminUserCard; onAccess: (a: UserAccessLevel) => void }) {
  const { t, fmt, lang } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const [assign, setAssign] = useState(false);
  const [reset, setReset] = useState(false);
  const toast = useToast();
  const i = useI18n();
  const a = card.access_level ?? null;
  const u = card.ai_usage_30d ?? null;
  const maxDay = u ? Math.max(1, ...u.days.map((d) => d.requests)) : 1;
  const days = u ? last30(u.days, u.to) : [];
  const levelName = (x: UserAccessLevel) => (lang === "ru" ? x.level_name : x.level_name_en);

  return (
    <div className="stack" data-testid="user-ai">
      <section className="panel" data-testid="user-access">
        <div className="panel-h">
          <h3 className="panel-t">
            <Icon name="layers" />
            {t("uai.access.t")}
          </h3>
          <span className="grow" />
          {a && (
            <>
              {a.source === "manual" && <Btn size="xs" kind="ghost" icon="rollback" label={t("uai.reset")} perm="users.access.manage" onClick={() => setReset(true)} testId="uai-reset" />}
              <Btn size="xs" icon="edit" label={t("uai.change")} perm="users.access.manage" onClick={() => setAssign(true)} testId="uai-change" />
            </>
          )}
        </div>
        <div className="panel-b">
          {!a ? (
            <Callout kind="info" icon="sliders" testId="uai-access-off">
              {t("uai.access.off")}
            </Callout>
          ) : (
            <dl className="dl">
              <dt>{t("uai.level")}</dt>
              <dd>
                <b data-testid="uai-level">{levelName(a)}</b> <span className="mono xs muted">{a.level}</span>{" "}
                {a.source === "manual" ? <Pill tone="info" dot={false}>{t("uai.manual")}</Pill> : <Pill dot={false}>{t("uai.default")}</Pill>}
              </dd>
              <dt>{t("uai.limit")}</dt>
              <dd>{t("uai.perDay", { n: fmt.num(a.limits.concierge_messages_per_day) })}</dd>
              {a.source === "manual" && (
                <>
                  <dt>{t("uai.expires")}</dt>
                  <dd>{a.expires_at ? fmt.dateTime(a.expires_at) : t("uai.noExpiry")}</dd>
                  <dt>{t("uai.assigned")}</dt>
                  <dd>
                    <Who id={a.assigned_by} name={a.assigned_by_name} /> {a.assigned_at && <span className="muted">· {fmt.dateTime(a.assigned_at)}</span>}
                    {a.reason && <span className="block xs">«{a.reason}»</span>}
                  </dd>
                </>
              )}
              {a.source === "default" && a.assignment?.expired && (
                <>
                  <dt>{t("uai.expired")}</dt>
                  <dd className="xs muted">{t("uai.expiredM", { l: a.assignment.level ?? "—", t: fmt.dateTime(a.assignment.expires_at) })}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      </section>

      <section className="panel" data-testid="user-usage">
        <div className="panel-h">
          <h3 className="panel-t">
            <Icon name="activity" />
            {t("uai.usage.t")}
          </h3>
          <span className="grow" />
          {can("dashboard.read") && (
            <Btn size="xs" kind="ghost" icon="right" label={t("uai.requests")} onClick={() => navigate("requests", `user:${card.user_id}`)} testId="uai-requests" />
          )}
        </div>
        {!u ? (
          <div className="panel-b">
            <Callout kind="info" icon="sliders" testId="uai-usage-off">
              {t("uai.usage.off")}
            </Callout>
          </div>
        ) : (
          <>
            <div className="statband uai-kpis">
              <div className="stat">
                <div className="stat-l">{t("uai.k.requests")}</div>
                <div className="stat-v" data-testid="uai-requests-n">
                  {fmt.num(u.requests)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-l">{t("uai.k.cost")}</div>
                <div className="stat-v">{fmtUsd(u.cost_usd, 2)}</div>
              </div>
              <div className="stat">
                <div className="stat-l">{t("uai.k.avg")}</div>
                <div className="stat-v">{u.requests ? fmtUsd(divUsd(u.cost_usd, u.requests), 4) : "—"}</div>
              </div>
            </div>
            {u.requests > 0 ? (
              <div className="panel-b">
                <div className="uai-bars" aria-label={t("uai.usage.days")} data-testid="uai-bars">
                  {days.map((d) => (
                    <span key={d.day} className={cx("uai-bar", d.requests > 0 && "is-on")} title={`${fmt.date(`${d.day}T00:00:00Z`)} · ${t("uai.reqN", { n: d.requests })} · ${fmtUsd(d.cost_usd, 4)}`}>
                      <i style={{ height: `${Math.round((d.requests / maxDay) * 100)}%` }} />
                    </span>
                  ))}
                </div>
                <div className="uai-bars-axis xs muted">
                  <span>{days[0] ? fmt.date(`${days[0].day}T00:00:00Z`) : ""}</span>
                  <span>{days.length ? fmt.date(`${days[days.length - 1]!.day}T00:00:00Z`) : ""}</span>
                </div>
                <table className="tbl compact mt-12">
                  <thead>
                    <tr>
                      <th>{t("req.col.agent")}</th>
                      <th className="num">{t("req.col.requests")}</th>
                      <th className="num">{t("req.col.cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.agents.map((x) => (
                      <tr key={x.agent_id}>
                        <td className="mono">{x.agent_id}</td>
                        <td className="num">{fmt.num(x.requests)}</td>
                        <td className="num">{fmtUsd(x.cost_usd, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="sparkles" title={t("uai.usage.noneT")} text={t("uai.usage.noneM")} testId="uai-usage-empty" />
            )}
          </>
        )}
      </section>

      <section className="panel" data-testid="user-conversations">
        <div className="panel-h">
          <h3 className="panel-t">
            <Icon name="support" />
            {t("uai.conv.t")}
          </h3>
        </div>
        {card.ai_conversations === null ? (
          <div className="panel-b">
            <Callout kind="info" icon="sliders" testId="uai-conv-off">
              {t("uai.conv.off")}
            </Callout>
          </div>
        ) : card.ai_conversations.length === 0 ? (
          <Empty icon="sparkles" title={t("ai.none.t")} text={t("ai.none.m")} testId="ai-empty" />
        ) : (
          <div className="table-wrap">
            <table className="tbl compact" data-testid="uai-conv">
              <thead>
                <tr>
                  <th>{t("uai.conv.mode")}</th>
                  <th>{t("uai.conv.event")}</th>
                  <th className="num">{t("uai.conv.turns")}</th>
                  <th>{t("col.created")}</th>
                  <th>{t("uai.conv.last")}</th>
                </tr>
              </thead>
              <tbody>
                {card.ai_conversations.map((c) => (
                  <tr key={c.conversation_id}>
                    <td>{t(c.mode === "home" ? "rq.mode.home" : "rq.mode.event")}</td>
                    <td className="mono xs">{c.event_id ? shortId(c.event_id, 8, 4) : "—"}</td>
                    <td className="num">{fmt.num(c.turns_count)}</td>
                    <td className="nowrap">{fmt.dateTime(c.created_at)}</td>
                    <td className="nowrap">{c.last_activity_at ? fmt.rel(c.last_activity_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="locked-block uai-hidden" data-testid="uai-text-hidden">
          <Icon name="lock" />
          <div className="grow">
            <div className="t">{t("uai.conv.hiddenT")}</div>
            <div className="m">{t("uai.conv.hiddenM")}</div>
          </div>
        </div>
      </section>

      {assign && a && (
        <AssignDialog
          userId={card.user_id}
          current={a}
          onClose={() => setAssign(false)}
          onDone={(x) => {
            setAssign(false);
            onAccess(x);
          }}
        />
      )}
      {reset && a && (
        <ConfirmCommand
          title={t("uai.resetT")}
          text={t("uai.resetM")}
          icon="rollback"
          ok={t("uai.reset")}
          minReason={3}
          testId="uai-reset-confirm"
          onClose={() => setReset(false)}
          onConfirm={async (reason) => {
            if (reason.length > 300) return t("dsc.reasonLong");
            try {
              const x = await AccessApi.reset(card.user_id, reason, a.version);
              toast(t("uai.resetDone"), "ok", "user.access_level.reset");
              onAccess(x);
              return null;
            } catch (e) {
              if (e instanceof ApiError && e.code === "AUDIT_UNAVAILABLE") return t("ai.auditDown");
              return errText(i, e);
            }
          }}
        />
      )}
    </div>
  );
}

/** cost / n with 6 digits, without floats */
function divUsd(v: string, n: number): string {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v);
  if (!m || n <= 0) return "0";
  const micro = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  const q = micro / BigInt(n);
  return `${q / 1_000_000n}.${(q % 1_000_000n).toString().padStart(6, "0")}`;
}

/** 30 calendar days ending with `to` (UTC), zero-filled */
function last30(days: Array<{ day: string; requests: number; cost_usd: string }>, to: string) {
  const by = new Map(days.map((d) => [d.day, d]));
  const end = Date.parse(to) || Date.now();
  const out: Array<{ day: string; requests: number; cost_usd: string }> = [];
  for (let k = 29; k >= 0; k--) {
    const day = new Date(end - k * 86_400_000).toISOString().slice(0, 10);
    out.push(by.get(day) ?? { day, requests: 0, cost_usd: "0" });
  }
  return out;
}

function AssignDialog({ userId, current, onClose, onDone }: { userId: string; current: UserAccessLevel; onClose: () => void; onDone: (a: UserAccessLevel) => void }) {
  const i = useI18n();
  const { t, fmt, lang } = i;
  const toast = useToast();
  const [levels, setLevels] = useState<AccessLevel[] | null>(null);
  const [level, setLevel] = useState(current.level);
  const [until, setUntil] = useState<"none" | "date">(current.expires_at ? "date" : "none");
  const [date, setDate] = useState(current.expires_at ? current.expires_at.slice(0, 10) : "");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    AiApi.levels()
      .then((l) => setLevels(l.items))
      .catch((e) => setErr(errText(i, e)));
  }, [i]);
  const chosen = levels?.find((l) => l.code === level);
  const submit = async () => {
    if (!chosen) return setErr(t("uai.err.level"));
    let expires: string | null = null;
    if (until === "date") {
      const ts = Date.parse(`${date}T23:59:59Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(ts) || ts <= Date.now()) return setErr(t("uai.err.date"));
      expires = new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    if (reason.trim().length < 3) return setErr(t("cmd.errReason", { n: 3 }));
    if (reason.trim().length > 300) return setErr(t("dsc.reasonLong"));
    setBusy(true);
    setErr(null);
    try {
      const x = await AccessApi.assign(userId, level, reason.trim(), expires, current.version);
      toast(t("uai.assigned.toast", { l: lang === "ru" ? x.level_name : x.level_name_en }), "ok", "user.access_level.assign");
      onDone(x);
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.code === "AUDIT_UNAVAILABLE") return setErr(t("ai.auditDown"));
      setErr(errText(i, e));
    }
  };
  return (
    <Modal
      title={t("uai.assignT")}
      text={t("uai.assignM")}
      icon="layers"
      onClose={() => !busy && onClose()}
      testId="uai-assign"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn label={t("uai.assignOk")} kind="primary" busy={busy} disabled={!levels} onClick={() => void submit()} testId="uai-assign-ok" />
        </>
      }
    >
      <div className="stack sm">
        <div className="field">
          <label htmlFor="uai-level-sel" className="req">
            {t("uai.level")}
          </label>
          <Select
            id="uai-level-sel"
            label={t("uai.level")}
            value={level}
            onChange={setLevel}
            testId="uai-level-sel"
            options={(levels ?? [{ code: current.level, name_ru: current.level_name, name_en: current.level_name_en, concierge_messages_per_day: current.limits.concierge_messages_per_day } as AccessLevel]).map((l) => ({
              v: l.code,
              label: `${lang === "ru" ? l.name_ru : l.name_en} · ${t("uai.perDay", { n: fmt.num(l.concierge_messages_per_day) })}`,
            }))}
          />
        </div>
        <div className="field">
          <span className="field-label">{t("uai.expires")}</span>
          <div className="row">
            <label className="check">
              <input type="radio" name="uai-until" checked={until === "none"} onChange={() => setUntil("none")} />
              <span>{t("uai.noExpiry")}</span>
            </label>
            <label className="check">
              <input type="radio" name="uai-until" checked={until === "date"} onChange={() => setUntil("date")} data-testid="uai-until-date" />
              <span>{t("uai.untilDate")}</span>
            </label>
            {until === "date" && <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t("uai.untilDate")} data-testid="uai-date" />}
          </div>
          <span className="hint">{t("uai.expiresH")}</span>
        </div>
        <div className="field">
          <label htmlFor="uai-reason" className="req">
            {t("cmd.reason")}
          </label>
          <textarea id="uai-reason" className="textarea" rows={2} maxLength={300} data-autofocus="" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("uai.reasonPh")} data-testid="uai-reason" />
        </div>
        <FieldErr msg={err} />
        <p className="xs muted row">
          <Icon name="audit" /> {t("cmd.auditNote")}
        </p>
      </div>
    </Modal>
  );
}

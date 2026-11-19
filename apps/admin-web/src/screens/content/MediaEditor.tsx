/**
 * Media (MediaPayload, ADM-MEDIA-01…03, AT-29): authored scenes and open materials only. Transcript lines with time
 * codes (order and duration checked live), phrases, audience; audio upload (mp3 / ogg / m4a ≤ 3 MB → base64 →
 * POST /content/blobs) with a preview player; «Права и лицензия» (MediaRights: owner, licence, reference, attribution,
 * territories with the mandatory UZ, term, allowed uses) and «Подтвердить права» (media.rights, step-up). The origins
 * `licensed` / `platform_embed` are visible but closed — «после решения владельца и юриста». Exercises to a material:
 * MediaExercisePayload. Nothing is ever fetched from a learner's link.
 */
import { useRef, useState } from "react";
import type { MediaExercisePayload, MediaPayload, MediaRights, TranscriptLine } from "@tilhero/contracts/content";
import type { ContentValidationError } from "@tilhero/contracts/admin";
import { Content } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { Btn, Callout, cx, FieldErr, Pill } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { AddBtn, CountPill } from "./LessonEditor";
import { CheckGroup, fieldId, ItemHead, LocField, NumField, PathIssues, RefList, removeAt, Sec, SelectField, setAt, TagsField, TextField, useEd } from "./fields";
import {
  addDays,
  answerText,
  AUDIENCES,
  BANDS,
  checkAudio,
  EXERCISE_TYPES,
  EXTERNAL_ORIGINS,
  isIsoDate,
  L,
  LICENSES,
  LICENSES_BY_ORIGIN,
  MEDIA_MAX_S,
  MEDIA_MIN_S,
  MEDIA_ORIGINS,
  MEDIA_TYPES,
  MEDIA_USES,
  msToSec,
  rightsState,
  secToMs,
  splitAnswers,
  todayTashkent,
  TOPICS,
  toBase64,
  type Issue,
} from "./model";
import { useRefs, withCurrent } from "./refs";
import type { EditorProps } from "./Workspace";

type P = MediaPayload;

export function MediaEditor({ payload: p, set, ver, dirty, onVersion, onIssues }: EditorProps<P>) {
  const { t } = useI18n();
  const refs = useRefs();
  const up = <K extends keyof P>(k: K, v: P[K]) => set((x) => ({ ...x, [k]: v }));
  const external = EXTERNAL_ORIGINS.includes(p.origin);
  return (
    <div className="ed" data-testid="media-editor">
      <Sec path="payload" title={t("ma.basics")}>
        <div className="form-grid">
          <LocField path="payload.title" label={t("ma.title")} value={p.title} max={120} onChange={(v) => up("title", v)} testId="ma-title" />
          <TextField path="payload.original_title" label={t("ma.original")} value={p.original_title ?? ""} max={200} onChange={(v) => up("original_title", v.trim() ? v : null)} hint={t("ma.originalHint")} />
          <SelectField path="payload.type" label={t("ma.type")} value={p.type} options={MEDIA_TYPES.map((x) => ({ v: x, label: t(`mt.${x}` as MessageKey) }))} onChange={(v) => up("type", v)} />
          <SelectField
            path="payload.origin"
            label={t("ma.origin")}
            value={p.origin}
            options={MEDIA_ORIGINS.map((x) => ({ v: x, label: EXTERNAL_ORIGINS.includes(x) ? `${t(`morg.${x}` as MessageKey)} — ${t("ma.closed")}` : t(`morg.${x}` as MessageKey), disabled: EXTERNAL_ORIGINS.includes(x) && x !== p.origin }))}
            onChange={(v) => up("origin", v)}
            hint={t("ma.originHint")}
            testId="ma-origin"
          />
          <SelectField path="payload.level" label={t("le.level")} value={p.level} options={BANDS.map((b) => ({ v: b, label: b }))} onChange={(v) => up("level", v)} />
          <NumField path="payload.duration_s" label={t("ma.duration")} value={p.duration_s} min={MEDIA_MIN_S} max={MEDIA_MAX_S} suffix={t("ma.sec")} onChange={(v) => up("duration_s", v)} testId="ma-duration" />
          <TextField path="payload.language" label={t("ma.language")} value={p.language} mono max={8} onChange={(v) => up("language", v)} />
          <CheckGroup path="payload.audience" label={t("ct.audience")} values={p.audience} options={AUDIENCES.map((a) => ({ v: a, label: t(`ageseg.${a}`) }))} onChange={(v) => up("audience", v)} required />
          <CheckGroup className="span-2" path="payload.topics" label={t("ct.topics")} values={p.topics} options={TOPICS.map((x) => ({ v: x, label: t(`topic.${x}` as MessageKey) }))} onChange={(v) => up("topics", v)} />
          <RefList path="payload.skill_ids" label={t("se.skills")} values={p.skill_ids} options={refs.options("skill")} onChange={(v) => up("skill_ids", v)} />
        </div>
        {external && (
          <Callout kind="bad" icon="ban" testId="ma-external">
            <b>{t("ma.externalT")}</b> {t("ma.externalM")}
          </Callout>
        )}
        {p.audience.includes("kids") && (
          <p className="xs muted row">
            <Icon name="shield" /> {t("ma.kidsNote")}
          </p>
        )}
      </Sec>

      <AudioBlock p={p} set={up} />
      <TranscriptBlock p={p} set={up} />

      <Sec path="payload.phrases" title={t("ma.phrases")} sub={t("ma.phrasesHint")}>
        {p.phrases.map((ph, i) => (
          <div key={i} className="item" data-path={`payload.phrases[${i}]`}>
            <ItemHead n={i + 1} title={ph.en || t("ma.phrase")} onRemove={() => up("phrases", removeAt(p.phrases, i))} removeLabel={t("ct.removeN", { n: i + 1 })} />
            <div className="form-grid">
              <TextField path={`payload.phrases[${i}].en`} label={t("ma.phraseEn")} value={ph.en} max={120} required onChange={(v) => up("phrases", setAt(p.phrases, i, { ...ph, en: v }))} />
              <TimeField path={`payload.phrases[${i}].t_ms`} label={t("ma.at")} ms={ph.t_ms} onChange={(ms) => up("phrases", setAt(p.phrases, i, { ...ph, t_ms: ms }))} />
              <LocField path={`payload.phrases[${i}].gloss`} label={t("le.gloss")} value={ph.gloss} max={160} onChange={(v) => up("phrases", setAt(p.phrases, i, { ...ph, gloss: v }))} />
            </div>
          </div>
        ))}
        <AddBtn label={t("ma.addPhrase")} onClick={() => up("phrases", [...p.phrases, { en: "", gloss: L(), t_ms: 0 }])} />
      </Sec>

      <RightsBlock p={p} set={up} ver={ver} dirty={dirty} onVersion={onVersion} onIssues={onIssues} />
    </div>
  );
}

export function mediaGate(ver: { rights_approved_at: string | null }, dirty: boolean): { submit: MessageKey | null; publish: MessageKey | null } {
  return { submit: null, publish: dirty ? "ct.gate.saveFirst" : ver.rights_approved_at ? null : "ma.gate" };
}

/* ---------------------------------------------------------------- time input (seconds) */

function TimeField({ path, label, ms, onChange, testId }: { path: string; label: string; ms: number; onChange: (ms: number) => void; testId?: string }) {
  const { t } = useI18n();
  const { editable, issues } = useEd();
  const [text, setText] = useState<string | null>(null);
  const id = fieldId(path);
  const bad = (issues[path]?.length ?? 0) > 0 || (text != null && secToMs(text) == null);
  return (
    <div className="field time-field" data-path={path}>
      <label htmlFor={id}>
        {label}, {t("ma.sec")}
      </label>
      <input
        id={id}
        className={cx("input mono", bad && "is-invalid")}
        inputMode="decimal"
        value={text ?? msToSec(ms)}
        disabled={!editable}
        aria-invalid={bad || undefined}
        aria-describedby={`${id}-u`}
        data-path={path}
        data-testid={testId}
        onChange={(e) => {
          setText(e.target.value);
          const v = secToMs(e.target.value);
          if (v != null) onChange(v);
        }}
        onBlur={() => setText(null)}
      />
      <span className="sr-only" id={`${id}-u`}>
        {t("ma.secUnit")}
      </span>
      <PathIssues path={path} />
    </div>
  );
}

/* ---------------------------------------------------------------- transcript */

function TranscriptBlock({ p, set }: { p: P; set: <K extends keyof P>(k: K, v: P[K]) => void }) {
  const { t } = useI18n();
  const total = p.duration_s * 1000;
  const lines = p.transcript;
  const add = () => {
    const last = lines[lines.length - 1];
    const start = last ? last.t_end_ms : 0;
    set("transcript", [...lines, { t_start_ms: start, t_end_ms: Math.min(start + 3000, Math.max(total, start + 1000)), speaker: last?.speaker ?? "A", text_en: "", gloss: L() }]);
  };
  return (
    <Sec path="payload.transcript" title={t("ma.transcript")} aside={<CountPill n={lines.length} lo={1} hi={null} />} sub={t("ma.transcriptHint", { s: p.duration_s })} testId="ma-transcript">
      <div className="timeline" role="img" aria-label={t("ma.timeline", { n: lines.length, s: p.duration_s })}>
        {lines.map((l, i) => {
          const left = total ? Math.max(0, Math.min(100, (l.t_start_ms / total) * 100)) : 0;
          const width = total ? Math.max(0.8, Math.min(100 - left, ((l.t_end_ms - l.t_start_ms) / total) * 100)) : 0;
          const prev = lines[i - 1];
          const bad = l.t_start_ms >= l.t_end_ms || l.t_end_ms > total || (!!prev && l.t_start_ms < prev.t_end_ms);
          return <span key={i} className={cx("tl-seg", bad && "is-bad")} style={{ left: `${left}%`, width: `${width}%` }} />;
        })}
      </div>
      {lines.map((l, i) => (
        <TranscriptRow key={i} i={i} l={l} onChange={(v) => set("transcript", setAt(lines, i, v))} onRemove={() => set("transcript", removeAt(lines, i))} />
      ))}
      <AddBtn label={t("ma.addLine")} onClick={add} testId="ma-add-line" />
    </Sec>
  );
}

function TranscriptRow({ i, l, onChange, onRemove }: { i: number; l: TranscriptLine; onChange: (v: TranscriptLine) => void; onRemove: () => void }) {
  const { t } = useI18n();
  const path = `payload.transcript[${i}]`;
  return (
    <div className="item tr-row" data-path={path} data-testid={`ma-line-${i}`}>
      <ItemHead n={i + 1} title={`${msToSec(l.t_start_ms)}–${msToSec(l.t_end_ms)} ${t("ma.sec")} · ${l.speaker}`} onRemove={onRemove} removeLabel={t("ct.removeN", { n: i + 1 })} />
      <PathIssues path={path} />
      <div className="tr-grid">
        <TimeField path={`${path}.t_start_ms`} label={t("ma.start")} ms={l.t_start_ms} onChange={(ms) => onChange({ ...l, t_start_ms: ms })} testId={`ma-start-${i}`} />
        <TimeField path={`${path}.t_end_ms`} label={t("ma.end")} ms={l.t_end_ms} onChange={(ms) => onChange({ ...l, t_end_ms: ms })} testId={`ma-end-${i}`} />
        <TextField path={`${path}.speaker`} label={t("ma.speaker")} value={l.speaker} max={40} required onChange={(v) => onChange({ ...l, speaker: v })} />
        <TextField className="span-3" path={`${path}.text_en`} label={t("ma.text")} value={l.text_en} max={240} required onChange={(v) => onChange({ ...l, text_en: v })} />
      </div>
      <LocField path={`${path}.gloss`} label={t("le.gloss")} value={l.gloss} max={300} onChange={(v) => onChange({ ...l, gloss: v })} />
    </div>
  );
}

/* ---------------------------------------------------------------- audio */

function AudioBlock({ p, set }: { p: P; set: <K extends keyof P>(k: K, v: P[K]) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { editable } = useEd();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [playErr, setPlayErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    const buf = new Uint8Array(await file.arrayBuffer());
    const chk = checkAudio({ name: file.name, size: file.size, type: file.type }, buf.subarray(0, 16));
    if (!chk.ok) {
      setErr(t(`ma.audioErr.${chk.reason}` as MessageKey));
      if (input.current) input.current.value = "";
      return;
    }
    setBusy(true);
    try {
      const blob = await Content.upload({ filename: file.name.slice(0, 200), content_type: chk.content_type, data_base64: toBase64(buf) }, uuid());
      set("audio_blob_id", blob.blob_id);
      toast(t("ma.uploaded", { kb: Math.round(blob.size / 1024) }), "ok", "content.blob_uploaded");
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "AUDIO_INVALID" ? t("err.AUDIO_INVALID") : errText(i18n, e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <Sec path="payload.audio_blob_id" title={t("ma.audio")} testId="ma-audio">
      {p.audio_blob_id ? (
        <div className="row audio-row">
          {/* same-origin file of the catalog (CSP media-src 'self'); no autoplay */}
          {playErr === p.audio_blob_id ? (
            <span className="small bad-ink row" data-testid="ma-player-err">
              <Icon name="alertCircle" /> {t("ma.playerErr")}
            </span>
          ) : (
            <audio controls preload="metadata" src={Content.blobUrl(p.audio_blob_id)} aria-label={t("ma.player")} onError={() => setPlayErr(p.audio_blob_id)} data-testid="ma-player" />
          )}
          <span className="mono xs muted">{p.audio_blob_id}</span>
          {editable && <Btn size="xs" kind="ghost" icon="x" label={t("ma.removeAudio")} onClick={() => set("audio_blob_id", null)} testId="ma-remove-audio" />}
        </div>
      ) : (
        <p className="small muted row" data-testid="ma-tts">
          <Icon name="info" /> {t("ma.tts")}
        </p>
      )}
      {editable && (
        <div className="row">
          <label className={cx("btn sm", busy && "is-busy")} htmlFor="ma-file">
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="download" />}
            <span>{p.audio_blob_id ? t("ma.replace") : t("ma.upload")}</span>
          </label>
          <input ref={input} id="ma-file" type="file" className="sr-only" accept=".mp3,.ogg,.oga,.m4a,audio/mpeg,audio/ogg,audio/mp4" disabled={busy} onChange={(e) => void onFile(e.target.files?.[0])} data-testid="ma-file" />
          <span className="xs muted">{t("ma.audioRules")}</span>
        </div>
      )}
      <FieldErr msg={err} id="ma-upload-err" />
    </Sec>
  );
}

/* ---------------------------------------------------------------- rights */

function RightsBlock({ p, set, ver, dirty, onVersion, onIssues }: { p: P; set: <K extends keyof P>(k: K, v: P[K]) => void; ver: EditorProps<P>["ver"]; dirty: boolean; onVersion: EditorProps<P>["onVersion"]; onIssues: (xs: Issue[]) => void }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  const r = p.rights;
  const today = todayTashkent();
  const state = rightsState(r.valid_to, today);
  const setR = (patch: Partial<MediaRights>) => set("rights", { ...r, ...patch });
  const allowedLic = LICENSES_BY_ORIGIN[p.origin] ?? [];
  const canApprove = can("media.rights") && !!ver && ["draft", "in_review", "approved"].includes(ver.status);
  const days = r.valid_to ? Math.round((Date.parse(`${r.valid_to}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
  return (
    <Sec path="payload.rights" title={t("ma.rights")} testId="ma-rights" sub={t("ma.rightsHint")}>
      {state === "expired" && (
        <Callout kind="bad" icon="ban" testId="ma-rights-expired">
          <b>{t("ma.expiredT")}</b> {t("ma.expiredM", { d: fmt.date(`${r.valid_to}T00:00:00Z`) })}
        </Callout>
      )}
      {state === "expiring" && (
        <Callout kind="warn" icon="clock" testId="ma-rights-expiring">
          <b>{t("ma.expiringT", { n: days ?? 0 })}</b> {t("ma.expiringM", { d: fmt.date(`${r.valid_to}T00:00:00Z`) })}
        </Callout>
      )}
      <div className="form-grid">
        <TextField path="payload.rights.owner" label={t("ma.owner")} value={r.owner} max={200} required lang="und" onChange={(v) => setR({ owner: v })} testId="ma-owner" />
        <SelectField path="payload.rights.license_type" label={t("ma.license")} value={r.license_type} options={LICENSES.map((x) => ({ v: x, label: t(`lic.${x}` as MessageKey), disabled: !allowedLic.includes(x) && x !== r.license_type }))} onChange={(v) => setR({ license_type: v })} hint={t("ma.licenseHint")} />
        <TextField path="payload.rights.license_ref" label={t("ma.licenseRef")} value={r.license_ref ?? ""} max={300} lang="und" required={r.license_type === "contract"} onChange={(v) => setR({ license_ref: v.trim() ? v : null })} hint={t("ma.licenseRefHint")} />
        <TextField path="payload.rights.attribution" label={t("ma.attribution")} value={r.attribution ?? ""} max={300} lang="und" required={r.license_type === "cc_by" || r.license_type === "cc_by_sa"} onChange={(v) => setR({ attribution: v.trim() ? v : null })} hint={t("ma.attributionHint")} />
        <TagsField path="payload.rights.territories" label={t("ma.territories")} values={r.territories} upper pattern={/^[A-Z]{2}$/} onChange={(v) => setR({ territories: v })} hint={r.territories.includes("UZ") ? t("ma.territoriesHint") : <span className="bad-ink b">{t("ma.needUz")}</span>} testId="ma-territories" />
        <DateField path="payload.rights.valid_from" label={t("ma.validFrom")} value={r.valid_from} onChange={(v) => setR({ valid_from: v ?? today })} />
        <DateField path="payload.rights.valid_to" label={t("ma.validTo")} value={r.valid_to} onChange={(v) => setR({ valid_to: v })} nullable={t("ma.noEnd")} />
        <CheckGroup className="span-2" path="payload.rights.allowed_uses" label={t("ma.uses")} values={r.allowed_uses} options={MEDIA_USES.map((x) => ({ v: x, label: t(`mu.${x}` as MessageKey) }))} onChange={(v) => setR({ allowed_uses: v })} required testId="ma-uses" />
      </div>
      <div className={cx("rights-state", ver?.rights_approved_at ? "is-ok" : "is-no")} data-path="rights_approved" data-testid="ma-rights-state">
        <Icon name={ver?.rights_approved_at ? "shield" : "alert"} />
        <span className="grow">
          {ver?.rights_approved_at ? (
            <>
              <b>{t("ma.approved")}</b> {t("ma.approvedBy", { n: ver.rights_approved_by_name ?? "—", t: fmt.dateTime(ver.rights_approved_at) })}
            </>
          ) : (
            <>
              <b>{t("ma.notApproved")}</b> {t("ma.notApprovedM")}
            </>
          )}
        </span>
        {canApprove ? (
          <Btn kind={ver?.rights_approved_at ? "" : "primary"} icon="shield" label={t("ma.approve")} disabled={dirty} title={dirty ? t("ct.gate.saveFirst") : undefined} onClick={() => setAsk(true)} testId="ma-approve" />
        ) : !can("media.rights") ? (
          <span className="xs muted row" data-testid="ma-no-rights">
            <Icon name="lock" /> {t("ma.noRights", { p: "media.rights" })}
          </span>
        ) : null}
      </div>
      {dirty && canApprove && <p className="xs muted">{t("ma.saveBeforeApprove")}</p>}
      {ask && ver && (
        <ConfirmCommand
          title={t("ma.approveT", { key: ver.key, v: ver.version })}
          text={t("ma.approveM", { owner: r.owner || "—", lic: t(`lic.${r.license_type}` as MessageKey), to: r.valid_to ? fmt.date(`${r.valid_to}T00:00:00Z`) : t("ma.noEnd") })}
          icon="shield"
          ok={t("ma.approve")}
          reasonLabel={t("ma.approveNote")}
          reasonPlaceholder={t("ma.approveNotePh")}
          minReason={3}
          extra={
            <Callout kind="info" icon="smartphoneKey">
              {t("ct.stepUpNote")}
            </Callout>
          }
          testId="ma-approve-confirm"
          onClose={() => setAsk(false)}
          onConfirm={async (note) => {
            try {
              const v = await Content.rightsApprove(ver.key, ver.version, note);
              onVersion(v as never);
              toast(t("ma.approvedToast"), "ok", "content.rights_approved");
              return null;
            } catch (e) {
              if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
              if (e instanceof ApiError && e.code === "CONTENT_INVALID") {
                const errs = (Array.isArray(e.details.errors) ? e.details.errors : []) as ContentValidationError[];
                onIssues(errs.map((x) => ({ path: x.path, code: x.code, message: x.message })));
                return t("ma.rightsInvalid", { n: errs.length });
              }
              return errText(i18n, e);
            }
          }}
        />
      )}
      {!r.territories.includes("UZ") && <Pill tone="bad">{t("ma.needUz")}</Pill>}
      {r.valid_to && isIsoDate(r.valid_to) && state === "ok" && <p className="xs muted">{t("ma.validUntil", { d: fmt.date(`${r.valid_to}T00:00:00Z`), w: fmt.date(`${addDays(r.valid_to, -14)}T00:00:00Z`) })}</p>}
    </Sec>
  );
}

function DateField({ path, label, value, onChange, nullable }: { path: string; label: string; value: string | null; onChange: (v: string | null) => void; nullable?: string }) {
  const { editable, issues } = useEd();
  const id = fieldId(path);
  const bad = (issues[path]?.length ?? 0) > 0;
  return (
    <div className="field" data-path={path}>
      <label htmlFor={id}>{label}</label>
      <span className="row nowrap-row">
        {value != null || !nullable ? (
          <input id={id} type="date" className={cx("input", bad && "is-invalid")} value={value ?? ""} disabled={!editable} aria-invalid={bad || undefined} data-path={path} onChange={(e) => onChange(e.target.value || null)} data-testid={`date-${path}`} />
        ) : (
          <span id={id} className="small muted">
            {nullable}
          </span>
        )}
        {nullable && (
          <label className="check nowrap">
            <input type="checkbox" checked={value == null} disabled={!editable} onChange={(e) => onChange(e.target.checked ? null : addDays(todayTashkent(), 365))} />
            <span>{nullable}</span>
          </label>
        )}
      </span>
      <PathIssues path={path} />
    </div>
  );
}

/* ---------------------------------------------------------------- exercises to a material */

export function ExerciseEditor({ payload: p, set }: EditorProps<MediaExercisePayload>) {
  const { t } = useI18n();
  const { editable } = useEd();
  const refs = useRefs();
  const up = <K extends keyof MediaExercisePayload>(k: K, v: MediaExercisePayload[K]) => set((x) => ({ ...x, [k]: v }));
  const choice = p.type === "comprehension" || p.type === "phrase_meaning";
  const setType = (type: MediaExercisePayload["type"]) =>
    set((x) => ({
      ...x,
      type,
      options: type === "comprehension" || type === "phrase_meaning" || type === "order_lines" ? (x.options.length >= 2 ? x.options : ["", ""]) : [],
      answer: type === "comprehension" || type === "phrase_meaning" ? 0 : type === "order_lines" ? x.options.map((_, i) => i) : type === "gap_fill" ? [] : null,
      line_index: type === "shadowing" ? (x.line_index ?? 0) : null,
    }));
  return (
    <div className="ed" data-testid="exercise-editor">
      <Sec path="payload" title={t("mx.basics")}>
        <div className="form-grid">
          <SelectField path="payload.asset_id" label={t("mx.asset")} value={p.asset_id} options={withCurrent(refs.options("media_asset"), p.asset_id, t("ct.choose"))} onChange={(v) => up("asset_id", v)} required />
          <SelectField path="payload.type" label={t("mx.type")} value={p.type} options={EXERCISE_TYPES.map((x) => ({ v: x, label: t(`xt.${x}` as MessageKey) }))} onChange={setType} />
          <SelectField path="payload.skill_id" label={t("le.itemSkill")} value={p.skill_id} options={withCurrent(refs.options("skill"), p.skill_id, t("ct.choose"))} onChange={(v) => up("skill_id", v)} required />
          <SelectField path="payload.level" label={t("le.level")} value={p.level} options={BANDS.map((b) => ({ v: b, label: b }))} onChange={(v) => up("level", v)} />
          <LocField path="payload.instruction" label={t("le.instruction")} value={p.instruction} max={300} multiline onChange={(v) => up("instruction", v)} hint={p.type === "roleplay" ? t("mx.roleplayHint") : undefined} />
          <SelectField path="payload.rubric_id" label={t("le.rubric")} value={p.rubric_id ?? ""} options={withCurrent(refs.options("rubric"), p.rubric_id, t("mx.noRubric"))} onChange={(v) => up("rubric_id", v || null)} />
          {p.type !== "shadowing" && p.type !== "roleplay" && (
            <TextField className="span-2" path="payload.prompt_en" label={t("mx.prompt")} value={p.prompt_en ?? ""} max={240} onChange={(v) => up("prompt_en", v || null)} hint={p.type === "gap_fill" ? t("le.gapHint") : undefined} />
          )}
          {p.type === "shadowing" && <NumField path="payload.line_index" label={t("mx.line")} value={(p.line_index ?? 0) + 1} min={1} onChange={(v) => up("line_index", Number.isFinite(v) ? Math.max(0, v - 1) : null)} />}
        </div>
      </Sec>
      {(choice || p.type === "order_lines") && (
        <Sec path="payload.options" title={p.type === "order_lines" ? t("mx.lines") : t("le.options")}>
          <ol className="opt-list">
            {p.options.map((o, j) => (
              <li key={j} className={cx("opt", choice && p.answer === j && "is-key")}>
                {choice ? (
                  <label className="check">
                    <input type="radio" name="mx-ans" checked={p.answer === j} disabled={!editable} onChange={() => up("answer", j)} aria-label={t("le.correctN", { x: String.fromCharCode(65 + j) })} data-path="payload.answer" />
                    <span className="mono">{String.fromCharCode(65 + j)}</span>
                  </label>
                ) : (
                  <span className="mono idx-plain">{j + 1}</span>
                )}
                <input className="input" lang="en" value={o} disabled={!editable} aria-label={t("le.optionN", { x: choice ? String.fromCharCode(65 + j) : String(j + 1) })} onChange={(e) => up("options", setAt(p.options, j, e.target.value))} />
                {editable && p.options.length > 2 && <Btn size="xs" kind="ghost" icon="x" aria={t("le.removeOption", { x: String(j + 1) })} onClick={() => set((x) => ({ ...x, options: removeAt(x.options, j), answer: choice ? 0 : removeAt(x.options, j).map((_, i) => i) }))} />}
              </li>
            ))}
          </ol>
          {editable && p.options.length < 8 && <Btn size="xs" icon="plus" label={t("le.addOption")} onClick={() => set((x) => ({ ...x, options: [...x.options, ""], answer: choice ? x.answer : [...x.options, ""].map((_, i) => i) }))} />}
          {p.type === "order_lines" && (
            <TextField
              path="payload.answer"
              label={t("mx.order")}
              value={Array.isArray(p.answer) ? p.answer.map((x) => (typeof x === "number" ? x + 1 : x)).join(" ") : ""}
              max={60}
              hint={t("mx.orderHint")}
              onChange={(v) => up("answer", v.split(/[\s,]+/).filter(Boolean).map((x) => Number(x) - 1).filter((x) => Number.isInteger(x)))}
            />
          )}
          <PathIssues path="payload.answer" />
        </Sec>
      )}
      {p.type === "gap_fill" && (
        <Sec path="payload.answer" title={t("le.accepted")}>
          <TextField path="payload.answer" label={t("le.accepted")} value={Array.isArray(p.answer) ? p.answer.join(", ") : ""} max={200} hint={t("le.acceptedHint")} onChange={(v) => up("answer", splitAnswers(v))} />
        </Sec>
      )}
      <p className="xs key-line">
        <b>{t("le.key")}</b> <span className="mono">{p.type === "shadowing" ? t("mx.lineN", { n: (p.line_index ?? 0) + 1 }) : p.type === "roleplay" ? t("mx.noKey") : answerText(p.type, p.options, p.answer)}</span>
      </p>
    </div>
  );
}

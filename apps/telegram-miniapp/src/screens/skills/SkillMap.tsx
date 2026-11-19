import type { SkillState } from "@tilhero/contracts/bff";
import { useState } from "react";
import { ApiError } from "../../api/errors";
import { groupSkills, SKILL_STATES, STATE_GLYPH, type MapSkill } from "../../domain/content";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, cx, Skeleton } from "../../ui/kit";

export function StateChip({ state }: { state: SkillState }) {
  const { t } = useI18n();
  return (
    <span className={cx("st", state)} data-state={state}>
      <span className="g" aria-hidden="true">{STATE_GLYPH[state]}</span>
      {t(`sk.state.${state}` as MessageKey)}
    </span>
  );
}

/**
 * Skill map (APP-PLAN-01, AT-35) — the «Прогресс» tab: counts, groups by area, states by glyph and word, the history
 * of evidence per skill. States change only through assessment (now — the placement test).
 */
export function SkillMap() {
  const { bff, nav, session } = useApp();
  const { t } = useI18n();
  const map = useLoad(() => bff.skillMap(), [session.learner.learner_id]);
  const dx = useLoad(() => bff.diagnosticsState(true), [session.learner.learner_id]);
  const [open, setOpen] = useState<string | null>(null);
  const unavailable = map.error && !map.data;
  const titles = new Map((map.data?.skills ?? []).map((s) => [s.skill_id, s]));

  return (
    <main className="scroll" data-testid="skill-map">
      <div className="stack loose">
        <div className="pad stack tight">
          <h2 className="h2">{t("sk.title")}</h2>
          <p className="sub">{t("sk.text")}</p>
        </div>

        {dx.data?.status === "none" ? (
          <div className="pad">
            <div className="card pen stack tight" data-testid="sk-no-diag">
              <p className="sub ink">{t("sk.empty")}</p>
              <Btn onClick={() => nav.push({ name: "diagnostics" })}>{t("sk.toDiag")}</Btn>
            </div>
          </div>
        ) : dx.data?.last_result ? (
          <div className="pad">
            <button type="button" className="row boxed" onClick={() => nav.push({ name: "diagnostics" })} data-testid="sk-result">
              <span className="nic"><Icon name="target" size={20} /></span>
              <span className="t">
                <b>{t("sk.lastResult")}</b>
                {dx.data.last_result.provisional_level ? <span>{t("dxr.historyLevel", { band: dx.data.last_result.provisional_level })}</span> : null}
              </span>
              <Icon name="chevron" size={18} stroke={2} />
            </button>
          </div>
        ) : null}

        {map.loading && !map.data ? (
          <div className="pad"><Skeleton lines={4} /></div>
        ) : unavailable ? (
          <div className="pad">
            <div className="card warn stack tight" data-testid="sk-unavailable">
              <p className="sub ink">{isCatalogUnavailable(map.errorObj) ? t("sk.unavailable") : map.error}</p>
              <Btn variant="secondary" onClick={() => void map.reload()}>{t("c.retry")}</Btn>
            </div>
          </div>
        ) : map.data ? (
          <>
            <div className="pad">
              <div className="counts" data-testid="sk-counts">
                {SKILL_STATES.map((s) => (
                  <div className="count" key={s} aria-label={t("sk.count", { state: t(`sk.state.${s}` as MessageKey), n: map.data!.counts[s] })}>
                    <b aria-hidden="true">{map.data!.counts[s]}</b>
                    <StateChip state={s} />
                  </div>
                ))}
              </div>
            </div>
            <div className="pad">
              <details className="legend card">
                <summary>{t("sk.legend")}</summary>
                <ul className="stack tight">
                  {SKILL_STATES.map((s) => (
                    <li key={s} className="hrow">
                      <StateChip state={s} />
                      <span className="sub small">{t(`sk.stateNote.${s}` as MessageKey)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
            {groupSkills(map.data.skills).map((g) => (
              <section className="pad stack tight" key={g.area} aria-labelledby={`skg-${g.area}`} data-testid={`sk-group-${g.area}`}>
                <h3 className="sec" id={`skg-${g.area}`}>{t(`area.${g.area}` as MessageKey)}</h3>
                <div className="list">
                  {g.skills.map((s) => (
                    <SkillRow key={s.skill_id} s={s} open={open === s.skill_id} onToggle={() => setOpen(open === s.skill_id ? null : s.skill_id)} names={titles} />
                  ))}
                </div>
              </section>
            ))}
          </>
        ) : null}
      </div>
    </main>
  );
}

function SkillRow({ s, open, onToggle, names }: { s: MapSkill; open: boolean; onToggle: () => void; names: Map<string, MapSkill> }) {
  const { t, l, fmt } = useI18n();
  const prereq = s.prerequisites.map((p) => (names.get(p) ? l(names.get(p)!.title) : null)).filter(Boolean);
  const panel = `sk-h-${s.skill_id.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <div className="skill" data-testid={`skill-${s.skill_id}`}>
      <button type="button" className="row" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        <span className="t">
          <b>{l(s.title)}</b>
          <span>
            {t("sk.level", { band: s.level })}
            {prereq.length ? ` · ${t("sk.needs", { list: prereq.join(", ") })}` : ""}
          </span>
        </span>
        <StateChip state={s.state} />
      </button>
      {open ? (
        <div className="pad stack tight" id={panel} data-testid="skill-history">
          <p className="lb">{t("sk.history")}</p>
          {s.history.length ? (
            <ul className="stack tight">
              {s.history.map((h, i) => (
                <li className="ev" key={i}>
                  <span className={cx("mk", h.outcome === "positive" ? "ok" : "no")} aria-hidden="true">{h.outcome === "positive" ? "✓" : "✕"}</span>
                  <b>{t(`sk.source.${h.source}` as MessageKey)}</b>
                  <span className="sub small">{fmt.date(h.at)} · {t(`sk.outcome.${h.outcome}` as MessageKey)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub small">{t("sk.historyEmpty")}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export const isCatalogUnavailable = (e: unknown) => e instanceof ApiError && e.code === "CATALOG_UNAVAILABLE";

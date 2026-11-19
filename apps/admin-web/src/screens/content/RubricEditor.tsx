/**
 * Rubric editor (RubricPayload, ADM-CONT-03): criteria with weights (sum = 1, shown live with «Выровнять»), four bands
 * 0..3 per criterion with RU/UZ descriptors, where the rubric applies and the pass rule.
 */
import type { RubricCriterion, RubricPayload } from "@tilhero/contracts/content";
import { useI18n, type MessageKey } from "../../i18n";
import { Btn, Pill } from "../../ui/kit";
import { AddBtn, CountPill } from "./LessonEditor";
import { CheckGroup, ItemHead, LocField, NumField, removeAt, Sec, SelectField, setAt, useEd } from "./fields";
import { L, RUBRIC_CODES, RUBRIC_TARGETS, weightsOk, weightsSum } from "./model";
import type { EditorProps } from "./Workspace";

type P = RubricPayload;

/** Spreads the remainder to 1 over the criteria (2 decimals; the last one takes the rounding). */
export function balanceWeights(criteria: readonly RubricCriterion[]): RubricCriterion[] {
  if (!criteria.length) return [];
  const each = Math.floor((1 / criteria.length) * 100) / 100;
  return criteria.map((c, i) => ({ ...c, weight: i === criteria.length - 1 ? Math.round((1 - each * (criteria.length - 1)) * 100) / 100 : each }));
}

export function RubricEditor({ payload: p, set }: EditorProps<P>) {
  const { t, fmt } = useI18n();
  const { editable } = useEd();
  const up = <K extends keyof P>(k: K, v: P[K]) => set((x) => ({ ...x, [k]: v }));
  const sum = weightsSum(p.criteria);
  const used = new Set(p.criteria.map((c) => c.code));
  return (
    <div className="ed" data-testid="rubric-editor">
      <Sec path="payload" title={t("ru.basics")}>
        <div className="form-grid">
          <LocField path="payload.title" label={t("ru.title")} value={p.title} max={120} onChange={(v) => up("title", v)} testId="ru-title" />
          <CheckGroup path="payload.applies_to" label={t("ru.applies")} values={p.applies_to} options={RUBRIC_TARGETS.map((x) => ({ v: x, label: t(`ru.to.${x}` as MessageKey) }))} onChange={(v) => up("applies_to", v)} required />
          <NumField path="payload.pass_rule.min_weighted" label={t("ru.minWeighted")} value={p.pass_rule.min_weighted} min={0} max={3} step={0.1} onChange={(v) => up("pass_rule", { ...p.pass_rule, min_weighted: v })} />
          <SelectField
            path="payload.pass_rule.min_per_criterion"
            label={t("ru.minPer")}
            value={String(p.pass_rule.min_per_criterion)}
            options={[0, 1, 2].map((n) => ({ v: String(n), label: String(n) }))}
            onChange={(v) => up("pass_rule", { ...p.pass_rule, min_per_criterion: Number(v) as 0 | 1 | 2 })}
          />
        </div>
      </Sec>
      <Sec
        path="payload.criteria"
        title={t("ru.criteria")}
        testId="ru-criteria"
        aside={
          <span className="row nowrap-row">
            <CountPill n={p.criteria.length} lo={2} hi={null} />
            <Pill tone={weightsOk(p.criteria) ? "good" : "bad"} testId="ru-sum">
              {t("ru.sum", { s: fmt.num(sum, 2) })}
            </Pill>
            {editable && !weightsOk(p.criteria) && p.criteria.length > 0 && <Btn size="xs" label={t("ru.balance")} onClick={() => up("criteria", balanceWeights(p.criteria))} testId="ru-balance" />}
          </span>
        }
        sub={t("ru.criteriaHint")}
      >
        {p.criteria.map((c, i) => {
          const path = `payload.criteria[${i}]`;
          return (
            <div key={i} className="item" data-path={path} data-testid={`ru-crit-${i}`}>
              <ItemHead n={i + 1} title={`${t(`rc.${c.code}` as MessageKey)} · ${fmt.num(c.weight, 2)}`} onRemove={() => up("criteria", removeAt(p.criteria, i))} removeLabel={t("ct.removeN", { n: i + 1 })} />
              <div className="form-grid">
                <SelectField path={`${path}.code`} label={t("ru.code")} value={c.code} options={RUBRIC_CODES.map((x) => ({ v: x, label: t(`rc.${x}` as MessageKey), disabled: x !== c.code && used.has(x) }))} onChange={(v) => up("criteria", setAt(p.criteria, i, { ...c, code: v }))} />
                <NumField path={`${path}.weight`} label={t("ru.weight")} value={c.weight} min={0.05} max={1} step={0.05} onChange={(v) => up("criteria", setAt(p.criteria, i, { ...c, weight: v }))} testId={`ru-w-${i}`} />
                <LocField path={`${path}.title`} label={t("ru.critTitle")} value={c.title} max={120} onChange={(v) => up("criteria", setAt(p.criteria, i, { ...c, title: v }))} />
              </div>
              <ol className="band-list" data-path={`${path}.bands`}>
                {c.bands.map((b, j) => (
                  <li key={j} className="band-row">
                    <span className="band-score" aria-hidden="true">
                      {b.score}
                    </span>
                    <LocField path={`${path}.bands[${j}].descriptor`} label={t("ru.band", { n: b.score })} value={b.descriptor} max={240} onChange={(v) => up("criteria", setAt(p.criteria, i, { ...c, bands: setAt(c.bands, j, { ...b, descriptor: v }) }))} testId={`ru-band-${i}-${j}`} />
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
        <AddBtn
          label={t("ru.addCrit")}
          disabled={used.size >= RUBRIC_CODES.length}
          onClick={() => {
            const code = RUBRIC_CODES.find((x) => !used.has(x))!;
            up("criteria", [...p.criteria, { code, title: L(), weight: 0, bands: ([0, 1, 2, 3] as const).map((score) => ({ score, descriptor: L() })) }]);
          }}
          testId="ru-add"
        />
      </Sec>
    </div>
  );
}

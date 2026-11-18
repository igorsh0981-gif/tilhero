import { ApiError } from "../api/errors";
import { DICTS, useI18n, type MessageKey } from "../i18n";
import { errMeta, errText } from "./errors";
import { Btn, Callout, Locked } from "./kit";

/**
 * Failed read of a screen block. 403 PERMISSION_DENIED is shown as a locked block naming the missing permission
 * (the menu hides what the role cannot open, but the backend is the authority — A31); anything else is an error
 * callout with the code/trace line and an optional retry.
 */
export function LoadError({ error, onRetry, testId }: { error: unknown; onRetry?: () => void; testId?: string }) {
  const i = useI18n();
  const { t } = i;
  if (error instanceof ApiError && error.status === 403 && error.code === "PERMISSION_DENIED") {
    const p = error.str("permission");
    return <Locked title={t("err.denied.t")} text={p ? t("perm.need", { p }) : t("err.denied.m")} testId={testId ?? "load-denied"} />;
  }
  // the section's domain is not configured in admin-bff yet (rollout order): a calm notice, not a failure
  if (error instanceof ApiError && error.code === "FEATURE_UNAVAILABLE") {
    // sprint 6: name the service that is not connected yet (news, watch) when the dictionary knows it
    const svcKey = `err.FEATURE_UNAVAILABLE.${error.str("service") ?? ""}` as MessageKey;
    return (
      <Callout kind="info" icon="sliders" testId={testId ?? "load-feature-off"}>
        <b>{svcKey in DICTS.ru ? t(svcKey) : errText(i, error)}</b>
        {onRetry && (
          <span className="block mt-8">
            <Btn size="xs" icon="refresh" label={t("common.retry")} onClick={onRetry} />
          </span>
        )}
      </Callout>
    );
  }
  return (
    <Callout kind="bad" icon="alertCircle" testId={testId ?? "load-error"}>
      <b>{errText(i, error)}</b>
      {errMeta(error) && <span className="xs muted block mono">{errMeta(error)}</span>}
      {onRetry && (
        <span className="block mt-8">
          <Btn size="xs" icon="refresh" label={t("common.retry")} onClick={onRetry} />
        </span>
      )}
    </Callout>
  );
}

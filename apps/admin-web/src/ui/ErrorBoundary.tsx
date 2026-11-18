import { Component, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { errMeta } from "./errors";
import { Btn, Callout } from "./kit";

interface Props {
  children: ReactNode;
  /** "section" — the page area of the shell (the menu and the header stay usable); "app" — the whole admin */
  scope: "section" | "app";
  /** a new value (another section or record) clears a caught error */
  resetKey?: string;
}
interface State {
  error: unknown;
  failed: boolean;
}

/**
 * A render error must not leave a blank page without a way back (review T2-9). Nothing about the error is logged or
 * sent anywhere: a message could carry learner data. The fallback shows the API code/trace when the error has one.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ error: null, failed: false });
  }

  private retry = () => this.setState({ error: null, failed: false });

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <Fallback scope={this.props.scope} error={this.state.error} onRetry={this.retry} />;
  }
}

function Fallback({ scope, error, onRetry }: { scope: Props["scope"]; error: unknown; onRetry: () => void }) {
  const { t } = useI18n();
  const meta = errMeta(error);
  const app = scope === "app";
  return (
    <div className={app ? "crash-page" : undefined} role="alert" data-testid={app ? "app-crash" : "section-crash"}>
      <Callout kind="bad" icon="alertCircle">
        <b>{t(app ? "eb.app.t" : "eb.t")}</b>
        <span className="block">{t(app ? "eb.app.m" : "eb.m")}</span>
        {meta && <span className="xs muted block mono">{meta}</span>}
        <span className="row mt-8">
          {!app && <Btn size="sm" icon="refresh" label={t("eb.retry")} onClick={onRetry} testId="crash-retry" />}
          <Btn size="sm" kind={app ? "primary" : "ghost"} label={t("eb.reload")} onClick={() => window.location.reload()} testId="crash-reload" />
        </span>
      </Callout>
    </div>
  );
}

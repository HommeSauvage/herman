import { AlertTriangle, RefreshCcw } from "lucide-react";
import { getLogger } from "@logtape/logtape";
import { Component, type ErrorInfo, type ReactNode } from "react";

const logger = getLogger(["herman-desktop", "view", "error-boundary"]);

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
};

type ErrorBoundaryState = {
  error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error("ErrorBoundary caught an error", {
      error: error.message,
      componentStack: info.componentStack,
    });
  }

  handleReset = () => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <AlertTriangle size={24} />
        </div>
        <div className="flex max-w-md flex-col gap-1">
          <p className="text-text text-sm font-medium">Something went wrong</p>
          <p className="text-dim text-xs leading-relaxed">
            {error.message || "An unexpected error occurred in this component."}
          </p>
        </div>
        <button
          type="button"
          onClick={this.handleReset}
          className="bg-surface flex items-center gap-2 rounded-xl border border-white/[0.08] px-3 py-2 text-xs font-medium transition hover:border-white/[0.14] hover:bg-white/[0.06]"
        >
          <RefreshCcw size={13} />
          Try again
        </button>
      </div>
    );
  }
}

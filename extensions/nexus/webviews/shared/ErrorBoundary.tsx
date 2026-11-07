import { Component, Fragment } from "react";
import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Called when RELOAD is pressed, after the boundary has reset itself. */
  onReload?: () => void;
}

/**
 * Catches a render error and shows one line with RELOAD instead of a blank page. RELOAD remounts the
 * children (a page reload would blank a webview, whose page is injected into an empty frame).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("view error", error);
  }

  render() {
    if (!this.state.failed) return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    const reload = () => {
      this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }));
      this.props.onReload?.();
    };
    return <EmptyState message="this view hit an error" action={{ label: "RELOAD", onClick: reload }} />;
  }
}

import { Component } from "react";
import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Defaults to reloading the page. */
  onReload?: () => void;
}

/** Catches a render error and shows one line with RELOAD instead of a blank page. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("view error", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <EmptyState message="this view hit an error" action={{ label: "RELOAD", onClick: this.props.onReload ?? (() => window.location.reload()) }} />;
  }
}

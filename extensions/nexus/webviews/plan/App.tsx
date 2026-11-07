import type { BridgeClient } from "../shared";
import { PlanReview } from "./PlanReview";

export interface AppProps {
  bridge?: BridgeClient;
  /** Undefined when the host gave no plan id: the panel shows an error and makes no requests. */
  planId: string | undefined;
}

export function App({ bridge, planId }: AppProps) {
  return (
    <div className="plan-app">
      <PlanReview planId={planId} bridge={bridge} />
    </div>
  );
}

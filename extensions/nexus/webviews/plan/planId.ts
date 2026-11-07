import { isFakeMode } from "../shared";

// How the panel learns its plan, in one place. The host renders <body data-plan-id="...">; ?planId= is a dev
// convenience only. The demo fallback exists only in ?fake=1 and the fixtures are loaded lazily so production
// bundles carry no demo data.
export async function resolvePlanId(): Promise<string | undefined> {
  const fromBody = document.body.dataset.planId;
  if (fromBody) return fromBody;
  const fromQuery = new URLSearchParams(location.search).get("planId");
  if (fromQuery) return fromQuery;
  if (!isFakeMode()) return undefined;
  const { fx } = await import("../../src/contracts/fixtures");
  return fx.plan.id;
}

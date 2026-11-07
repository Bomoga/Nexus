import type { ApprovalRequest } from "../../contracts";
import type { Auth0Session } from "../auth/auth0-signin";
import type { Unsubscribe } from "../ports";
import type { ApprovalHook, ApprovalsController } from "./approvals-controller";
import { CibaClient, type CibaDeps } from "./ciba";
import { makeCibaHook } from "./ciba-hook";

// Phone approvals wiring (L1-16). Inert until `nexus.ciba.serviceUrl` is set AND the user is signed in to Auth0:
// then, and only then, each approval created on this machine is pushed through CibaClient. A decision made on any
// other surface cancels the push. Nothing here reads or logs a token.

type ControllerLike = Pick<ApprovalsController, "resolve" | "get"> & { subscribe(cb: (a: ApprovalRequest) => void): Unsubscribe };

export interface CibaWiringDeps {
  serviceUrl(): string;
  auth: Pick<Auth0Session, "status" | "accessToken">;
  /** Lazy: the controller does not exist yet when the hook is built. */
  getController(): ControllerLike;
  makeClient?(deps: CibaDeps): Pick<CibaClient, "requestApproval">;
  log?: (message: string) => void;
}

export function makeConfiguredCibaHook(deps: CibaWiringDeps): ApprovalHook {
  let inner: ReturnType<typeof makeCibaHook> | undefined;
  let innerUrl = "";
  let subscribed = false;

  const ensureSubscribed = (controller: ControllerLike) => {
    if (subscribed) return;
    subscribed = true;
    controller.subscribe(a => { if (a.decision) inner?.cancel(a.id); });
  };

  return {
    name: "ciba-phone",
    async onCreated(approval) {
      const baseUrl = deps.serviceUrl().trim();
      if (!baseUrl || !deps.auth.status().signedIn) return;
      const controller = deps.getController();
      ensureSubscribed(controller);
      if (!inner || innerUrl !== baseUrl) {
        const previous = inner;
        const deps2: CibaDeps = {
          baseUrl,
          getAccessToken: async () => {
            const token = await deps.auth.accessToken();
            if (!token) throw new Error("not signed in");
            return token;
          },
          isStillPending: async id => !(await controller.get(id))?.decision,
        };
        const client = deps.makeClient ? deps.makeClient(deps2) : new CibaClient(deps2);
        const created = makeCibaHook({
          client,
          approverAuth0UserId: () => deps.auth.status().auth0UserId,
          resolve: (id, d, by) => controller.resolve(id, d, by),
          log: deps.log,
        });
        // Keep cancelling anything the previous (old URL) hook still has in flight.
        inner = previous ? { ...created, cancel: id => { previous.cancel(id); created.cancel(id); } } : created;
        innerUrl = baseUrl;
      }
      await inner.onCreated(approval);
    },
  };
}

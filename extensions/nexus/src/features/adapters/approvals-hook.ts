import type { ApprovalsHook } from "../../services/gate/types";
import type { ApprovalRequester } from "../sessions/sessions-controller";

/** Lane 2's gate asks `ApprovalsHook.create`; Lane 1's controller answers `ApprovalRequester.request`. Same wait, different shape. */
export function approvalsHookFor(requester: ApprovalRequester): ApprovalsHook {
  return {
    create: async ({ session, action, reason, diffPreview }) => {
      const { approval, decision } = await requester.request({ sessionId: session.id, action, reason, ...(diffPreview === undefined ? {} : { diffPreview }) });
      return { approvalId: approval.id, decision };
    },
  };
}

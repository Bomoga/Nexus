import type { ApprovalRequest, DecidedBy } from "../../contracts";

// App side of phone approvals (Auth0 CIBA push), PLAN L1-16. Talks only to the Nexus auth service (auth-service/):
// POST /ciba/start, then POST /ciba/poll until the approver answers on their phone. Only the machine that created the
// approval runs this, and only while it is undecided. A timeout, expiry or error is "no phone answer": it NEVER decides
// the approval (CLAUDE.md §5, §14); only an approve/reject confirmed by the requested approver is returned as a decision.
// Tokens, auth_req_id and codes live in memory only and are never logged or returned.

export type CibaOutcome =
  | { status: "approved" | "rejected"; decidedBy: DecidedBy }
  | { status: "no_answer"; reason: "timeout" | "expired" | "error" | "cancelled" | "decided_elsewhere" };

export interface CibaDeps {
  /** Base URL of the auth service, e.g. https://nexus-auth.example.workers.dev */
  baseUrl: string;
  /** The signed-in Nexus user's current Auth0 access token (never cached here). */
  getAccessToken(): Promise<string>;
  fetch?: typeof fetch;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  now?(): number;
  /** False once the approval has a decision from any surface; polling stops. */
  isStillPending(approvalId: string): Promise<boolean>;
  /** Used until the service gives an interval hint. */
  pollIntervalMs?: number;
  /** Total time to wait for the phone, capped by the request's own expiry. */
  timeoutMs?: number;
  /** Consecutive poll failures tolerated before giving up. */
  maxPollFailures?: number;
}

export interface CibaRequest {
  approval: Pick<ApprovalRequest, "id" | "sessionId" | "action">;
  /** Auth0 user ID of the person who should confirm on their phone. */
  approverAuth0UserId: string;
  signal?: AbortSignal;
}

const ACTION_WORD = { run_command: "cmd", write_outside_scope: "write", commit: "commit", other: "other" } as const;
/** The auth service shows the phone `NX <approvalId8> <label.slice(0,20)>`, so the label itself must fit in 20 characters. */
export const LABEL_MAX = 20;

/** Short action word + last 8 characters of the session id (no model-written text); always at most 20 characters. */
export function bindingMessage(approval: Pick<ApprovalRequest, "sessionId" | "action">): string {
  const session = approval.sessionId.replace(/[^A-Za-z0-9_.,:#-]/g, "").slice(-8);
  return `${ACTION_WORD[approval.action.kind]} ${session}`.slice(0, LABEL_MAX);
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const NO = (reason: Extract<CibaOutcome, { status: "no_answer" }>["reason"]): CibaOutcome => ({ status: "no_answer", reason });

export class CibaClient {
  constructor(private readonly deps: CibaDeps) {}

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; retryAfterHeader?: number }> {
    const token = await this.deps.getAccessToken();
    const res = await (this.deps.fetch ?? fetch)(`${this.deps.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    });
    const header = Number(res.headers.get("retry-after"));
    let data: Record<string, unknown> = {};
    try { const v = await res.json(); if (v && typeof v === "object") data = v as Record<string, unknown>; } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data, retryAfterHeader: header > 0 ? header : undefined };
  }

  async requestApproval(req: CibaRequest): Promise<CibaOutcome> {
    const { approval, approverAuth0UserId, signal } = req;
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? defaultSleep;
    const maxFailures = this.deps.maxPollFailures ?? 3;
    const stop = async (): Promise<CibaOutcome | undefined> => {
      if (signal?.aborted) return NO("cancelled");
      if (!(await this.deps.isStillPending(approval.id))) return NO("decided_elsewhere");
      return undefined;
    };
    try {
      const early = await stop();
      if (early) return early;
      const begun = now();
      const started = await this.post("/ciba/start", {
        approvalId: approval.id, sessionId: approval.sessionId, actionLabel: bindingMessage(approval), approverAuth0UserId,
      }, signal);
      const afterStart = await stop();
      if (afterStart) return afterStart;
      const authReqId = started.data.authReqId;
      if (!started.ok || typeof authReqId !== "string") return NO("error");
      let intervalMs = typeof started.data.interval === "number" && started.data.interval > 0 ? started.data.interval * 1000 : (this.deps.pollIntervalMs ?? 5000);
      const expiresMs = typeof started.data.expiresIn === "number" ? started.data.expiresIn * 1000 : Infinity;
      const deadline = begun + Math.min(this.deps.timeoutMs ?? 5 * 60_000, expiresMs);
      let failures = 0;
      for (;;) {
        await sleep(intervalMs, signal);
        const halt = await stop();
        if (halt) return halt;
        if (now() >= deadline) return NO("timeout");
        let polled: Awaited<ReturnType<CibaClient["post"]>>;
        try { polled = await this.post("/ciba/poll", { authReqId }, signal); } catch { polled = { ok: false, status: 0, data: {} }; }
        const afterPoll = await stop();   // cancelled or decided elsewhere while the poll was in flight: never report a decision
        if (afterPoll) return afterPoll;
        if (polled.status === 429) {      // rate limited: honour Retry-After, not a failure, still bounded by the deadline
          const wait = polled.retryAfterHeader ?? (typeof polled.data.retryAfter === "number" && polled.data.retryAfter > 0 ? polled.data.retryAfter : undefined);
          if (wait !== undefined) intervalMs = wait * 1000;
          continue;
        }
        if (!polled.ok) {
          if (polled.status === 400 || polled.status === 401 || polled.status === 403) return NO("error");
          if (++failures >= maxFailures) return NO("error");
          continue;
        }
        failures = 0;
        switch (polled.data.status) {
          case "pending":
            if (typeof polled.data.retryAfter === "number" && polled.data.retryAfter > 0) intervalMs = polled.data.retryAfter * 1000;
            break;
          case "expired": return NO("expired");
          case "approved":
          case "rejected": {
            const who = polled.data.auth0UserId;
            // The service reports the identity for approvals; a rejection carries none, so it is attributed to the requested approver.
            const auth0UserId = polled.data.status === "approved" ? who : approverAuth0UserId;
            if (typeof auth0UserId !== "string" || auth0UserId !== approverAuth0UserId) return NO("error");
            return { status: polled.data.status, decidedBy: { via: "auth0_push", userId: auth0UserId, auth0UserId } };
          }
          default: if (++failures >= maxFailures) return NO("error");
        }
      }
    } catch {
      if (signal?.aborted) return NO("cancelled");
      return NO("error");   // never echo the underlying error: it could carry a token
    }
  }
}

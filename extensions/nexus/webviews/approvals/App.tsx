import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequest, SwarmReview } from "../../src/contracts";
import { BridgeError, Button, Chip, EmptyState, KeyValueList, KeyValueRow, StatusLine, getBridge } from "../shared";
import type { BridgeClient, Tone } from "../shared";
import { formatEventTime } from "../globe/model/picking";

type Decision = NonNullable<ApprovalRequest["decision"]>;
type Verdict = NonNullable<SwarmReview["verdict"]>;

const DECISION_TONE: Record<Decision, Tone> = { approved: "ok", rejected: "error" };
const VERDICT_TONE: Record<Verdict, Tone> = { looks_good: "ok", concerns: "pending", do_not_merge: "error" };
const VIA_LABEL: Record<NonNullable<ApprovalRequest["decidedBy"]>["via"], string> = { slack: "slack", app: "app", auth0_push: "auth0 push" };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const timeOf = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);
const tplus = (iso: string | undefined) => formatEventTime(timeOf(iso));

/** A decided approval is final: an undecided or later copy never replaces it. */
export function mergeApproval(prev: ApprovalRequest | undefined, next: ApprovalRequest): ApprovalRequest {
  return prev?.decision ? prev : next;
}

/** One review per approval; the newest `at` wins, a tie goes to the later arrival. */
export function mergeReview(prev: SwarmReview | undefined, next: SwarmReview): SwarmReview {
  if (!prev) return next;
  if (timeOf(prev.at) > timeOf(next.at)) return prev;
  // Same instant: a finished copy is never replaced by a stale running snapshot.
  if (prev.id === next.id && timeOf(prev.at) === timeOf(next.at) && prev.status !== "running" && next.status === "running") return prev;
  return next;
}

/** Pending first (oldest request on top), then decided newest decision first. */
export function sortApprovals(list: readonly ApprovalRequest[]): ApprovalRequest[] {
  const pending = list.filter((a) => !a.decision).sort((a, b) => timeOf(a.requestedAt) - timeOf(b.requestedAt));
  const decided = list.filter((a) => a.decision).sort((a, b) => timeOf(b.decidedAt ?? b.requestedAt) - timeOf(a.decidedAt ?? a.requestedAt));
  return [...pending, ...decided];
}

function ModelWritten() {
  return <span className="ap-label">model-written</span>;
}

function SwarmCard({ review, busy, onRerun }: { review: SwarmReview; busy: boolean; onRerun: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ap-swarm" data-testid="swarm-card">
      {review.status === "running" ? <StatusLine tone="muted">council reviewing…</StatusLine> : null}
      {review.status === "unavailable" ? (
        <div className="ap-line">
          <StatusLine tone="muted">review unavailable, you decide without it</StatusLine>
          <Button onClick={onRerun} disabled={busy}>RE-RUN</Button>
        </div>
      ) : null}
      {review.status === "done" ? (
        <>
          <div className="ap-line">
            {review.verdict ? <Chip tone={VERDICT_TONE[review.verdict]}>{review.verdict}</Chip> : null}
            {review.summary ? <span className="ap-text">{review.summary}</span> : null}
          </div>
          {review.judges && review.judges.length > 0 ? (
            <div className="ap-line">
              <Button onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "JUDGES ▾" : "JUDGES ▸"}</Button>
            </div>
          ) : null}
          {open ? (
            <div className="ap-judges">
              {review.judges?.map((j, i) => (
                <div className="ap-judge" key={`${j.modelId}-${i}`}>
                  <span className="nx-data">{j.modelId}</span>
                  <Chip tone={VERDICT_TONE[j.verdict]}>{j.verdict}</Chip>
                  <span className="ap-text">{j.notes}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      <div className="ap-note">left machine · model-written</div>
    </div>
  );
}

function ActionBody({ approval }: { approval: ApprovalRequest }) {
  const [diffOpen, setDiffOpen] = useState(false);
  const a = approval.action;
  switch (a.kind) {
    case "run_command":
      return <KeyValueList><KeyValueRow label="RUN"><code className="nx-data ap-block">{a.command}</code></KeyValueRow></KeyValueList>;
    case "write_outside_scope":
      return <KeyValueList><KeyValueRow label="WRITE OUTSIDE SCOPE"><code className="nx-data ap-block">{a.path}</code></KeyValueRow></KeyValueList>;
    case "other":
      return <KeyValueList><KeyValueRow label="OTHER"><span className="ap-text">{a.description}</span><ModelWritten /></KeyValueRow></KeyValueList>;
    case "commit":
      return (
        <>
          <KeyValueList>
            <KeyValueRow label="COMMIT"><span className="ap-text">{a.message}</span><ModelWritten /></KeyValueRow>
          </KeyValueList>
          {approval.diffPreview ? (
            <>
              <div className="ap-line">
                <Button onClick={() => setDiffOpen(!diffOpen)} aria-expanded={diffOpen}>{diffOpen ? "DIFF ▾" : "DIFF ▸"}</Button>
              </div>
              {diffOpen ? <pre className="nx-data ap-diff">{approval.diffPreview}</pre> : null}
            </>
          ) : null}
        </>
      );
  }
}

interface RowProps {
  approval: ApprovalRequest;
  review: SwarmReview | undefined;
  busy: boolean;
  rerunBusy: boolean;
  names: ReadonlyMap<string, string>;
  onResolve: (id: string, decision: Decision) => void;
  onRerun: (id: string) => void;
}

function ApprovalRow({ approval, review, busy, rerunBusy, names, onResolve, onRerun }: RowProps) {
  const by = approval.decidedBy;
  const who = by ? (by.via === "slack" ? names.get(by.userId) ?? by.userId : by.userId) : "";
  return (
    <div className="ap-row" data-testid="approval-row" data-id={approval.id}>
      <div className="ap-line">
        <Chip tone={approval.decision ? DECISION_TONE[approval.decision] : "pending"}>{approval.decision ?? "pending"}</Chip>
        <span className="ap-kind">{approval.action.kind}</span>
        <span className="nx-data">{tplus(approval.requestedAt)}</span>
      </div>
      <ActionBody approval={approval} />
      <div className="ap-reason">
        <span className="ap-text">{approval.reason}</span>
        <ModelWritten />
      </div>
      {approval.action.kind === "commit" && review ? <SwarmCard review={review} busy={rerunBusy} onRerun={() => onRerun(approval.id)} /> : null}
      {approval.decision ? (
        <div className="ap-decided nx-data">{by ? `decided by ${who} via ${VIA_LABEL[by.via]} ${tplus(approval.decidedAt)}` : `decided ${tplus(approval.decidedAt)}`}</div>
      ) : (
        <div className="ap-line">
          <Button variant="primary" disabled={busy} onClick={() => onResolve(approval.id, "approved")}>APPROVE</Button>
          <Button disabled={busy} onClick={() => onResolve(approval.id, "rejected")}>REJECT</Button>
        </div>
      )}
    </div>
  );
}

export function App({ bridge = getBridge() }: { bridge?: BridgeClient }) {
  const [approvals, setApprovals] = useState<ReadonlyMap<string, ApprovalRequest>>(new Map());
  const [reviews, setReviews] = useState<ReadonlyMap<string, SwarmReview>>(new Map());
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const askedReviews = useRef(new Set<string>());
  const askedUsers = useRef(new Set<string>());

  const putApproval = useCallback((next: ApprovalRequest) => {
    setApprovals((prev) => new Map(prev).set(next.id, mergeApproval(prev.get(next.id), next)));
  }, []);
  const putReview = useCallback((next: SwarmReview) => {
    setReviews((prev) => new Map(prev).set(next.approvalId, mergeReview(prev.get(next.approvalId), next)));
  }, []);

  useEffect(() => {
    const unsubA = bridge.subscribe("approvals.subscribe", {}, putApproval);
    const unsubR = bridge.subscribe("swarms.review.subscribe", {}, putReview);
    let live = true;
    bridge.request("approvals.list", { pendingOnly: false }).then(
      (list) => {
        if (!live) return;
        list.forEach(putApproval);
        setLoaded(true);
        setError(undefined);
      },
      (e) => {
        if (!live) return;
        setLoaded(true);
        setError(`approvals.list failed: ${message(e)}`);
      },
    );
    return () => {
      live = false;
      unsubA();
      unsubR();
    };
  }, [bridge, putApproval, putReview]);

  useEffect(() => {
    for (const a of approvals.values()) {
      if (a.action.kind === "commit" && !askedReviews.current.has(a.id)) {
        askedReviews.current.add(a.id);
        bridge.request("swarms.review.get", { approvalId: a.id }).then(
          (r) => (r ? putReview(r) : undefined),
          (e) => {
            askedReviews.current.delete(a.id);
            setError(`swarms.review.get failed: ${message(e)}`);
          },
        );
      }
      const by = a.decidedBy;
      if (by?.via === "slack" && !askedUsers.current.has(by.userId)) {
        askedUsers.current.add(by.userId);
        bridge.request("slack.users", { ids: [by.userId] }).then(
          (users) => {
            const found = users.find((u) => u.id === by.userId);
            if (found) setNames((prev) => new Map(prev).set(found.id, found.displayName || found.name));
          },
          () => undefined,
        );
      }
    }
  }, [approvals, bridge, putReview]);

  const withBusy = useCallback(async (key: string, work: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(key));
    try {
      await work();
      setError(undefined);
    } catch (e) {
      setError(`${key.startsWith("rerun:") ? "swarms.review.rerun" : "approvals.resolve"} failed: ${message(e)}`);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const onResolve = useCallback(
    (approvalId: string, decision: Decision) =>
      void withBusy(approvalId, async () => {
        try {
          putApproval(await bridge.request("approvals.resolve", { approvalId, decision }));
        } catch (e) {
          if (!(e instanceof BridgeError && e.code === "conflict")) throw e;
          // Lost the race: someone else decided first. Not an error; fetch the decided copy.
          (await bridge.request("approvals.list", { pendingOnly: false })).forEach(putApproval);
        }
      }),
    [bridge, putApproval, withBusy],
  );
  const onRerun = useCallback(
    (approvalId: string) => void withBusy(`rerun:${approvalId}`, async () => putReview(await bridge.request("swarms.review.rerun", { approvalId }))),
    [bridge, putReview, withBusy],
  );

  const sorted = useMemo(() => sortApprovals([...approvals.values()]), [approvals]);

  return (
    <div className="ap-app">
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      {sorted.length === 0 ? (
        loaded ? <EmptyState message="No approvals" /> : null
      ) : (
        sorted.map((a) => (
          <ApprovalRow
            key={a.id}
            approval={a}
            review={reviews.get(a.id)}
            busy={busy.has(a.id)}
            rerunBusy={busy.has(`rerun:${a.id}`)}
            names={names}
            onResolve={onResolve}
            onRerun={onRerun}
          />
        ))
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ApprovalRequest, SwarmReview } from "../../src/contracts";
import { Badge, BridgeError, Button, EmptyState, MonoBlock, PendingNote, Region, StatusLine, StoreStatusLine, Table, friendlyError, getBridge, useNow } from "../shared";
import type { BadgeKind, BridgeClient, TableColumn, Tone } from "../shared";
import { formatEventTime } from "../globe/model/picking";

type Decision = NonNullable<ApprovalRequest["decision"]>;
type Verdict = NonNullable<SwarmReview["verdict"]>;

const DECISION_TONE: Record<Decision, Tone> = { approved: "ok", rejected: "error" };
const VIA_LABEL: Record<NonNullable<ApprovalRequest["decidedBy"]>["via"], string> = { slack: "slack", app: "app", auth0_push: "auth0 push" };

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

const VERDICT_BADGE: Record<Verdict, { kind: BadgeKind; label: string }> = {
  looks_good: { kind: "ok", label: "LOOKS GOOD" },
  concerns: { kind: "pending", label: "CONCERNS" },
  do_not_merge: { kind: "error", label: "DO NOT MERGE" },
};

type Judge = NonNullable<SwarmReview["judges"]>[number];

const JUDGE_COLUMNS: readonly TableColumn<Judge>[] = [
  { key: "modelId", header: "model", mono: true, truncate: true },
  { key: "verdict", header: "verdict", render: (j) => <Badge kind={VERDICT_BADGE[j.verdict].kind} dot={false}>{VERDICT_BADGE[j.verdict].label}</Badge> },
  { key: "notes", header: "note", truncate: true },
];

/** The advisory council verdict: it only changes how the card looks, never the decision. */
function SwarmCard({ review, busy, onRerun }: { review: SwarmReview; busy: boolean; onRerun: () => void }) {
  const judges = review.judges ?? [];
  return (
    <div className="ap-swarm" data-testid="swarm-card">
      {review.status === "running" ? <StatusLine tone="muted">review running</StatusLine> : null}
      {review.status === "unavailable" ? (
        <div className="ap-line">
          <Badge kind="muted" title="the review did not finish; you decide without it">REVIEW UNAVAILABLE</Badge>
          <Button size="sm" onClick={onRerun} disabled={busy}>RE-RUN</Button>
        </div>
      ) : null}
      {review.status === "done" ? (
        <>
          <div className="ap-line">
            {review.verdict ? (
              <span data-testid="swarm-verdict">
                <Badge kind={VERDICT_BADGE[review.verdict].kind}>{VERDICT_BADGE[review.verdict].label}</Badge>
              </span>
            ) : null}
            {review.summary ? <span className="ap-text">{review.summary}</span> : null}
          </div>
          {judges.length > 0 ? <Table columns={JUDGE_COLUMNS} rows={judges} rowKey={(j) => `${j.modelId}-${j.notes}`} aria-label="judges" /> : null}
        </>
      ) : null}
      <div className="ap-note">left machine · model-written</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ap-field">
      <span className="ap-key">{label}</span>
      <div className="ap-val">{children}</div>
    </div>
  );
}

function ActionBody({ approval }: { approval: ApprovalRequest }) {
  const [diffOpen, setDiffOpen] = useState(false);
  const a = approval.action;
  switch (a.kind) {
    case "run_command":
      return <Field label="run"><code className="nx-data ap-block">{a.command}</code></Field>;
    case "write_outside_scope":
      return <Field label="path"><code className="nx-data ap-block">{a.path}</code></Field>;
    case "other":
      return <Field label="detail"><code className="nx-data ap-block">{a.description}</code><ModelWritten /></Field>;
    case "commit":
      return (
        <>
          <Field label="message"><code className="nx-data ap-block">{a.message}</code><ModelWritten /></Field>
          {approval.diffPreview ? (
            <div className="ap-diffwrap">
              <Button size="sm" variant="ghost" onClick={() => setDiffOpen(!diffOpen)} aria-expanded={diffOpen}>{diffOpen ? "DIFF ▾" : "DIFF ▸"}</Button>
              {diffOpen ? <MonoBlock label="DIFF">{approval.diffPreview}</MonoBlock> : null}
            </div>
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
  now: number;
  onResolve: (id: string, decision: Decision) => void;
  onRerun: (id: string) => void;
}

/** "approved by slack Brandon at T+02:07"; a decision with no recorded decider reads "approved at T+02:07". */
export function decidedLine(approval: ApprovalRequest, who: string): string {
  const by = approval.decidedBy;
  const at = tplus(approval.decidedAt);
  return by ? `${approval.decision} by ${VIA_LABEL[by.via]} ${who} at ${at}` : `${approval.decision} at ${at}`;
}

function ApprovalCard({ approval, review, busy, rerunBusy, names, now, onResolve, onRerun }: RowProps) {
  const by = approval.decidedBy;
  const who = by ? (by.via === "slack" ? names.get(by.userId) ?? by.userId : by.userId) : "";
  const line = approval.decision ? decidedLine(approval, who) : "";
  const header = {
    title: approval.action.kind.replace(/_/g, " "),
    children: (
      <>
        <span className="nx-data" title={approval.sessionId}>{approval.sessionId.slice(0, 8)}</span>
        <span className="nx-data" title={approval.requestedAt}>{tplus(approval.requestedAt)}</span>
      </>
    ),
    actions: approval.decision ? undefined : <Badge kind="pending">PENDING</Badge>,
  };
  return (
    <Region flush header={header} className="ap-card" data-testid="approval-row" data-id={approval.id}>
      <ActionBody approval={approval} />
      <Field label="reason">
        <span className="ap-text">{approval.reason}</span>
        <ModelWritten />
      </Field>
      {approval.action.kind === "commit" && review ? <SwarmCard review={review} busy={rerunBusy} onRerun={() => onRerun(approval.id)} /> : null}
      {approval.decision ? (
        <StatusLine tone={DECISION_TONE[approval.decision]}>
          <span className="nx-data" title={line}>{line}</span>
        </StatusLine>
      ) : (
        <>
          <PendingNote requestedAt={approval.requestedAt} now={now} />
          <div className="ap-actions">
            <Button variant="primary" disabled={busy} onClick={() => onResolve(approval.id, "approved")}>APPROVE</Button>
            <Button variant="danger" disabled={busy} onClick={() => onResolve(approval.id, "rejected")}>REJECT</Button>
          </div>
        </>
      )}
    </Region>
  );
}

export function App({ bridge = getBridge() }: { bridge?: BridgeClient }) {
  const [approvals, setApprovals] = useState<ReadonlyMap<string, ApprovalRequest>>(new Map());
  const [reviews, setReviews] = useState<ReadonlyMap<string, SwarmReview>>(new Map());
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // A failed load: shown with a RETRY that re-runs it.
  const [loadError, setLoadError] = useState<string | undefined>();
  const [reviewError, setReviewError] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);
  const [reviewAttempt, setReviewAttempt] = useState(0);
  // One clock for every pending row in the view.
  const now = useNow();
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
        setLoadError(undefined);
      },
      (e) => {
        if (!live) return;
        setLoaded(true);
        setLoadError(friendlyError(e, "approvals"));
      },
    );
    return () => {
      live = false;
      unsubA();
      unsubR();
    };
  }, [bridge, putApproval, putReview, attempt]);

  useEffect(() => {
    for (const a of approvals.values()) {
      if (a.action.kind === "commit" && !askedReviews.current.has(a.id)) {
        askedReviews.current.add(a.id);
        bridge.request("swarms.review.get", { approvalId: a.id }).then(
          (r) => (r ? putReview(r) : undefined),
          (e) => {
            askedReviews.current.delete(a.id);
            setReviewError(friendlyError(e, "review"));
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
  }, [approvals, bridge, putReview, reviewAttempt]);

  const withBusy = useCallback(async (key: string, work: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(key));
    try {
      await work();
      setError(undefined);
    } catch (e) {
      setError(friendlyError(e, key.startsWith("rerun:") ? "review" : "approvals"));
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
  const pendingRows = sorted.filter((a) => !a.decision);
  const decidedRows = sorted.filter((a) => a.decision);
  const card = (a: ApprovalRequest) => (
    <ApprovalCard
      key={a.id}
      approval={a}
      review={reviews.get(a.id)}
      busy={busy.has(a.id)}
      rerunBusy={busy.has(`rerun:${a.id}`)}
      names={names}
      now={now}
      onResolve={onResolve}
      onRerun={onRerun}
    />
  );

  return (
    <div className="ap-app">
      <StoreStatusLine bridge={bridge} />
      {loadError ? (
        <div className="ap-err">
          <StatusLine tone="error">
            <span>{loadError}</span>
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>RETRY</Button>
          </StatusLine>
        </div>
      ) : null}
      {reviewError ? (
        <div className="ap-err">
          <StatusLine tone="error">
            <span>{reviewError}</span>
            <Button
              size="sm"
              onClick={() => {
                askedReviews.current.clear();
                setReviewError(undefined);
                setReviewAttempt((n) => n + 1);
              }}
            >
              RETRY
            </Button>
          </StatusLine>
        </div>
      ) : null}
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      {!loaded ? <StatusLine tone="muted">… loading</StatusLine> : null}
      {loaded && sorted.length === 0 && !loadError ? <EmptyState message="no approvals · an agent will ask here before a risky action" /> : null}
      {pendingRows.map(card)}
      {decidedRows.length > 0 ? (
        <div className="ap-sep" role="separator" aria-label="decided">DECIDED</div>
      ) : null}
      {decidedRows.map(card)}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, AgentSession, ApprovalRequest, ModelCallReceipt, SpendSummary } from "../../src/contracts";
import { BridgeError, Button, EmptyState, PendingNote, Select, StatusLine, StoreStatusLine, Tabs, friendlyError, getBridge, useNow } from "../shared";
import type { BridgeClient, Tone } from "../shared";

type Status = AgentSession["status"];
const TABS = [
  { id: "log", label: "LOG" },
  { id: "diff", label: "DIFF" },
  { id: "tests", label: "TESTS" },
  { id: "receipts", label: "RECEIPTS" },
] as const;
const OPEN_RECEIPT_HINT = "opening receipts needs a bridge command (pending Lane 1)";

const STATUS_TONE: Record<Status, Tone> = { running: "muted", awaiting_approval: "pending", done: "ok", failed: "error", cancelled: "muted" };

/** A decided approval is final: a late undecided copy (stale list, delayed event) never reopens it. */
function putApproval(cur: ReadonlyMap<string, ApprovalRequest>, a: ApprovalRequest): ReadonlyMap<string, ApprovalRequest> {
  if (cur.get(a.id)?.decision && !a.decision) return cur;
  return new Map(cur).set(a.id, a);
}
const usd = (n: number) => n.toFixed(4);

const isLive = (s: AgentSession) => s.status === "running" || s.status === "awaiting_approval";

/** Newest first, with running and awaiting_approval sessions ahead of finished ones. */
export function orderSessions(list: readonly AgentSession[]): AgentSession[] {
  return [...list].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/** Missing seqs between 0 and the highest seen, as "4" or "6-8" ranges. */
export function missingRanges(seen: ReadonlySet<number>): string[] {
  let max = -1;
  for (const s of seen) max = Math.max(max, s);
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= max + 1; i++) {
    const missing = i <= max && !seen.has(i);
    if (missing && start < 0) start = i;
    if (!missing && start >= 0) {
      out.push(start === i - 1 ? String(start) : `${start}-${i - 1}`);
      start = -1;
    }
  }
  return out;
}

export interface Totals {
  calls: number;
  costUsd: number;
  baselineUsd: number;
  savedUsd: number;
}

export function computeTotals(receipts: readonly ModelCallReceipt[]): Totals {
  let costUsd = 0;
  let baselineUsd = 0;
  let savedUsd = 0;
  for (const r of receipts) {
    costUsd += r.costUsd;
    if (r.baselineCostUsd !== undefined) {
      baselineUsd += r.baselineCostUsd;
      savedUsd += r.baselineCostUsd - r.costUsd;
    }
  }
  return { calls: receipts.length, costUsd, baselineUsd, savedUsd };
}

function ModelWritten() {
  return <span className="log-label">model-written</span>;
}

function actionText(a: ApprovalRequest["action"]): string {
  switch (a.kind) {
    case "run_command": return `run_command: ${a.command}`;
    case "write_outside_scope": return `write_outside_scope: ${a.path}`;
    case "commit": return `commit: ${a.message}`;
    case "other": return `other: ${a.description}`;
  }
}

function Approval({ approval, fallback, busy, now, onResolve }: {
  approval: ApprovalRequest | undefined;
  now: number;
  fallback: string;
  busy: boolean;
  onResolve: (decision: "approved" | "rejected") => void;
}) {
  if (!approval) return <span>approval {fallback} (loading)</span>;
  const decided = approval.decision;
  return (
    <div>
      <div>
        approval {approval.id}: <span className="log-mono">{actionText(approval.action)}</span>
      </div>
      <div>
        reason: {approval.reason}
        <ModelWritten />
      </div>
      {decided ? (
        <StatusLine tone={decided === "approved" ? "ok" : "error"}>
          {decided}, decided by {approval.decidedBy ? `${approval.decidedBy.via} ${approval.decidedBy.userId}` : "unknown"}
        </StatusLine>
      ) : (
        <>
          <PendingNote requestedAt={approval.requestedAt} now={now} />
          <div className="log-actions">
            <Button variant="primary" disabled={busy} onClick={() => onResolve("approved")}>APPROVE</Button>
            <Button disabled={busy} onClick={() => onResolve("rejected")}>REJECT</Button>
          </div>
        </>
      )}
    </div>
  );
}

function switcherOptions(list: readonly AgentSession[] | undefined, current: AgentSession | undefined, titles: ReadonlyMap<string, string>) {
  const all = [...(list ?? [])];
  if (current && !all.some((x) => x.id === current.id)) all.unshift(current);
  return all.map((x) => ({
    value: x.id,
    label: `${x.status.toUpperCase()} · ${titles.get(x.taskId) ?? x.taskId} · ${x.model.modelId}`,
  }));
}

function short(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? "";
  } catch {
    s = String(v);
  }
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
}

export interface AppProps {
  bridge?: BridgeClient;
  /** The session the host pointed the view at; undefined means "pick the newest one from sessions.list". */
  sessionId: string | undefined;
}

export function App({ bridge, sessionId: initialId }: AppProps) {
  // The user's (or the host's) choice; once set, a new sessions.list result never replaces it.
  const [sessionId, setSessionId] = useState<string | undefined>(initialId);
  const [list, setList] = useState<readonly AgentSession[] | undefined>();
  const [listError, setListError] = useState("");
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const asked = useRef(new Set<string>());
  const [session, setSession] = useState<AgentSession | undefined>();
  const [events, setEvents] = useState<ReadonlyMap<number, AgentEvent>>(new Map());
  const [receipts, setReceipts] = useState<readonly ModelCallReceipt[]>([]);
  const [summary, setSummary] = useState<SpendSummary | undefined>();
  const [approvals, setApprovals] = useState<ReadonlyMap<string, ApprovalRequest>>(new Map());
  const [cancelled, setCancelled] = useState<{ atSeq: number } | undefined>();
  const [tab, setTab] = useState<string>("log");
  const [error, setError] = useState("");
  // A failed load: the only errors with a RETRY (an action error is retried by clicking the action again).
  const [loadError, setLoadError] = useState("");
  // approvals.list has its own slot: its failure never replaces the view or hides a sessions.get error.
  const [approvalsError, setApprovalsError] = useState("");
  const [receiptsError, setReceiptsError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // One clock for every pending approval in the view.
  const now = useNow();
  const [busyApproval, setBusyApproval] = useState("");
  const [cancelling, setCancelling] = useState(false);

  const addReceipt = useCallback((r: ModelCallReceipt) => {
    setReceipts((cur) => (cur.some((x) => x.callId === r.callId) ? cur : [...cur, r]));
    setSummary(undefined); // live additions: totals are recomputed from the rows
  }, []);

  const ensureTitle = useCallback((taskId: string) => {
    if (asked.current.has(taskId)) return;
    asked.current.add(taskId);
    (bridge ?? getBridge())
      .request("tasks.get", { taskId })
      .then((t) => setTitles((cur) => new Map(cur).set(taskId, t.title)))
      .catch(() => asked.current.delete(taskId));
  }, [bridge]);

  const loadList = useCallback(() => {
    (bridge ?? getBridge())
      .request("sessions.list", {})
      .then((l) => {
        setListError("");
        setList(orderSessions(l));
        // First list with no choice yet: the newest running session, else the newest.
        setSessionId((cur) => cur ?? orderSessions(l)[0]?.id);
        for (const x of l.slice(0, 12)) ensureTitle(x.taskId);
      })
      .catch((e) => setListError(friendlyError(e, "sessions")));
  }, [bridge, ensureTitle]);

  useEffect(() => {
    loadList();
  }, [loadList, attempt]);

  useEffect(() => {
    if (initialId) setSessionId(initialId);
  }, [initialId]);

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    setSession(undefined);
    setEvents(new Map());
    setReceipts([]);
    setSummary(undefined);
    setApprovals(new Map());
    setCancelled(undefined);
    setError("");
    setLoadError("");
    setApprovalsError("");
    setReceiptsError("");
    const b = bridge ?? getBridge();
    b.request("sessions.get", { sessionId })
      .then((s) => {
        if (!live) return;
        setSession(s);
        ensureTitle(s.taskId);
      })
      .catch((e) => live && setLoadError(friendlyError(e, "session")));
    b.request("receipts.list", { sessionId })
      .then((r) => {
        if (!live) return;
        setReceipts((cur) => [...cur, ...r.receipts.filter((x) => !cur.some((c) => c.callId === x.callId))]);
        setSummary((cur) => cur ?? r.summary);
      })
      .catch((e) => live && setReceiptsError(friendlyError(e, "receipts")));
    b.request("approvals.list", { sessionId })
      .then((list) => live && setApprovals((cur) => list.reduce(putApproval, cur)))
      .catch((e) => live && setApprovalsError(friendlyError(e, "approvals")));

    const unsubs = [
      b.subscribe("agent.subscribe", { sessionId, fromSeq: 0 }, (e) => {
        setEvents((cur) => {
          if (cur.has(e.seq)) return cur;
          const next = new Map(cur);
          next.set(e.seq, e);
          return next;
        });
        if (e.type === "receipt") addReceipt(e.receipt);
      }),
      b.subscribe("receipts.subscribe", { sessionId }, (r) => addReceipt(r)),
      b.subscribe("approvals.subscribe", {}, (a) => {
        if (a.sessionId === sessionId) setApprovals((cur) => putApproval(cur, a));
      }),
    ];
    return () => {
      live = false;
      unsubs.forEach((u) => u());
    };
  }, [bridge, sessionId, addReceipt, ensureTitle, attempt]);

  const ordered = useMemo(() => [...events.values()].sort((a, b) => a.seq - b.seq), [events]);
  const gaps = useMemo(() => missingRanges(new Set(events.keys())), [events]);
  const totals = useMemo(() => computeTotals(receipts), [receipts]);

  const retry = <Button onClick={() => setAttempt((n) => n + 1)}>RETRY</Button>;
  if (!sessionId) {
    if (listError) {
      return (
        <div className="session-app">
          <StatusLine tone="error">{listError} {retry}</StatusLine>
        </div>
      );
    }
    return list ? <EmptyState message="no agent session yet · start one from a Slack thread" /> : <StatusLine>… loading</StatusLine>;
  }
  if (loadError && !session) {
    return (
      <div className="session-app">
        <StoreStatusLine bridge={bridge} />
        <StatusLine tone="error">{loadError} {retry}</StatusLine>
      </div>
    );
  }

  // Newest status event wins; a cancel answer stands until a later status event arrives.
  let status: Status | undefined = session?.status;
  let statusSeq = -1;
  for (const e of ordered) {
    if (e.type === "status") {
      status = e.status;
      statusSeq = e.seq;
    }
  }
  if (cancelled && statusSeq <= cancelled.atSeq) status = "cancelled";
  const canCancel = (status === "running" || status === "awaiting_approval") && !cancelling;

  const b = bridge ?? getBridge();
  const cancel = () => {
    const atSeq = ordered.length ? ordered[ordered.length - 1].seq : -1;
    setCancelling(true);
    b.request("agent.cancel", { sessionId })
      .then(() => setCancelled({ atSeq }))
      .catch((e) => setError(friendlyError(e, "session")))
      .finally(() => setCancelling(false));
  };
  const resolve = (approvalId: string, decision: "approved" | "rejected") => {
    setBusyApproval(approvalId);
    const settle = async () => {
      try {
        const a = await b.request("approvals.resolve", { approvalId, decision });
        setApprovals((cur) => putApproval(cur, a));
      } catch (e) {
        // Someone else decided first: the host answers "conflict" without the winner, so fetch it.
        if (!(e instanceof BridgeError && e.code === "conflict")) throw e;
        const list = await b.request("approvals.list", { sessionId });
        setApprovals((cur) => list.reduce(putApproval, cur));
        if (!list.some((a) => a.id === approvalId && a.decision)) setError("already decided elsewhere");
      }
    };
    settle()
      .catch((e) => setError(friendlyError(e, "approvals")))
      .finally(() => setBusyApproval(""));
  };

  // Latest diff per path, in order of first appearance.
  const diffs = new Map<string, string>();
  for (const e of ordered) if (e.type === "file_edit") diffs.set(e.path, e.diff);
  const tests = ordered.filter((e): e is Extract<AgentEvent, { type: "test_output" }> => e.type === "test_output");

  return (
    <div className="session-app">
      <StoreStatusLine bridge={bridge} />
      <div className="session-head">
        <Select
          aria-label="session"
          value={sessionId}
          onMouseDown={loadList}
          onChange={(e) => setSessionId(e.target.value)}
          options={switcherOptions(list, session, titles)}
        />
        <span className="session-sep">·</span>
        <span className="session-data" title="requested model">{session?.model.modelId ?? "…"}</span>
        <span className="session-sep">·</span>
        <span className="session-data">{session?.branch ?? "…"}</span>
        <span className="session-sep">·</span>
        <span data-testid="session-status" className={`nx-chip nx-tone-${status ? STATUS_TONE[status] : "muted"}`}>
          {status ?? "loading"}
        </span>
        <span className="session-spacer" />
        <Button disabled={!canCancel} onClick={cancel}>CANCEL</Button>
      </div>
      {loadError ? <StatusLine tone="error">{loadError} {retry}</StatusLine> : null}
      {approvalsError ? <StatusLine tone="error">{approvalsError} {retry}</StatusLine> : null}
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      {gaps.length ? <StatusLine tone="pending">missing events {gaps.join(", ")}</StatusLine> : null}
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      <div className="session-body">
        {tab === "log" ? (
          ordered.length ? (
            ordered.map((e) => (
              <div className="log-row" data-testid="log-row" data-seq={e.seq} key={e.seq}>
                <span className="log-seq">{e.seq}</span>
                <span className="log-at">{e.at.slice(11, 19)}</span>
                <span className="log-kind">{e.type}</span>
                <div className="log-text">
                  {e.type === "approval_request" ? (
                    <Approval
                      approval={approvals.get(e.approvalId)}
                      fallback={e.approvalId}
                      busy={busyApproval === e.approvalId}
                      now={now}
                      onResolve={(d) => resolve(e.approvalId, d)}
                    />
                  ) : (
                    <LogBody e={e} />
                  )}
                </div>
              </div>
            ))
          ) : (
            <EmptyState message="no events yet" />
          )
        ) : null}
        {tab === "diff" ? (
          diffs.size ? (
            [...diffs].map(([path, diff]) => (
              <div key={path}>
                <div className="diff-path" data-testid="diff-path">{path}</div>
                <pre className="diff-pre">
                  {diff.split("\n").map((line, i) => (
                    <span key={i} className={`diff-line ${diffClass(line)}`}>{line}</span>
                  ))}
                </pre>
              </div>
            ))
          ) : (
            <EmptyState message="no diffs yet" />
          )
        ) : null}
        {tab === "tests" ? (
          tests.length ? (
            tests.map((t) => (
              <div className="test-block" key={t.seq}>
                <div className="test-head">
                  <span className="log-mono">{t.command}</span>
                  <span className={`log-mono nx-tone-${t.exitCode === 0 ? "ok" : "error"}`}>exit {t.exitCode}</span>
                </div>
                <pre className="test-tail">{t.tail}</pre>
              </div>
            ))
          ) : (
            <EmptyState message="no test output yet" />
          )
        ) : null}
        {tab === "receipts" ? (
          <>
            {receiptsError ? <StatusLine tone="error">{receiptsError} {retry}</StatusLine> : null}
            <Receipts receipts={receipts} totals={totals} summary={summary} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function diffClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-meta";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "";
}

function LogBody({ e }: { e: AgentEvent }) {
  switch (e.type) {
    case "status": return <>status: {e.status}</>;
    case "message": return <>{e.text}<ModelWritten /></>;
    case "tool_call": return <><span className="log-mono">{e.tool}</span> <span className="log-mono">{short(e.args)}</span></>;
    case "tool_result": return <span className={e.ok ? undefined : "nx-tone-error"}><span className="log-mono">{e.tool}</span> {e.ok ? "ok" : "failed"}: {e.summary}</span>;
    case "file_edit": return <>edited <span className="log-mono">{e.path}</span></>;
    case "approval_request": return null;
    case "approval_resolved": return <>approval {e.approvalId}: {e.decision}</>;
    case "commit": return <>commit <span className="log-mono">{e.sha.slice(0, 12)}</span></>;
    case "error": return <span className="nx-tone-error">{e.message}</span>;
    case "test_output": return <><span className="log-mono">{e.command}</span> exit {e.exitCode}</>;
    case "receipt": return <>receipt <span className="log-mono">{e.receipt.callId}</span> {e.receipt.role} {usd(e.receipt.costUsd)} USD</>;
  }
}

function Receipts({ receipts, totals, summary }: { receipts: readonly ModelCallReceipt[]; totals: Totals; summary: SpendSummary | undefined }) {
  if (!receipts.length) return <EmptyState message="no receipts yet" />;
  // The host's summary is authoritative while no live receipt has arrived; otherwise the rows are summed.
  const useSummary = summary !== undefined && summary.calls === receipts.length;
  const cost = useSummary ? summary.costUsd : totals.costUsd;
  const saved = useSummary ? summary.savedUsd : totals.savedUsd;
  return (
    <table className="nx-table receipts-table">
      <thead>
        <tr>
          <th>role</th><th>requested → served</th><th className="receipts-num">cost USD</th><th className="receipts-num">baseline</th><th>optimizations</th><th>receipt</th>
        </tr>
      </thead>
      <tbody>
        {receipts.map((r) => (
          <tr key={r.callId} data-testid="receipt-row">
            <td>{r.role}</td>
            <td className="nx-data">
              <span>{r.requestedModel}</span> → <span className={r.servedModel !== r.requestedModel ? "nx-tone-pending" : undefined}>{r.servedModel}</span>
            </td>
            <td className="nx-data receipts-num">{usd(r.costUsd)}</td>
            <td className="nx-data receipts-num">{r.baselineCostUsd === undefined ? "—" : usd(r.baselineCostUsd)}</td>
            <td>{r.optimizations.join(", ") || "—"}</td>
            <td className="nx-data">
              {r.pruneReceiptId} <Button disabled title={OPEN_RECEIPT_HINT}>OPEN</Button>
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr data-testid="receipts-totals">
          <td>total ({totals.calls} calls)</td>
          <td>savings <span className="nx-data">{usd(saved)}</span></td>
          <td className="nx-data receipts-num">{usd(cost)}</td>
          <td className="nx-data receipts-num">{usd(totals.baselineUsd)}</td>
          <td colSpan={2} />
        </tr>
      </tfoot>
    </table>
  );
}

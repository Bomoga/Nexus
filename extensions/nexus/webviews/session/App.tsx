import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentEvent, AgentSession, ApprovalRequest, ModelCallReceipt, SpendSummary, SwarmReview } from "../../src/contracts";
import { BridgeError, Badge, Button, EmptyState, MonoBlock, PendingNote, Region, Select, StatusLine, StoreStatusLine, Table, Tabs, friendlyError, getBridge, statusBadge, useNow } from "../shared";
import type { BadgeKind, BridgeClient, TableColumn } from "../shared";
import { formatEventTime } from "../globe/model/picking";

type Status = AgentSession["status"];
const OPEN_RECEIPT_HINT = "opening receipts needs a bridge command (pending Lane 1)";


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

/** T+hh:mm from an ISO time, formatted like the globe. */
const tPlus = (iso: string) => formatEventTime(Date.parse(iso));

/** "45s", "12m04s", "1h05m". */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function actionText(a: ApprovalRequest["action"]): string {
  switch (a.kind) {
    case "run_command": return a.command;
    case "write_outside_scope": return a.path;
    case "commit": return a.message;
    case "other": return a.description;
  }
}

function verdictBadge(r: SwarmReview): { kind: BadgeKind; label: string } {
  if (r.status === "unavailable") return { kind: "muted", label: "REVIEW UNAVAILABLE" };
  if (r.status === "running" || !r.verdict) return { kind: "muted", label: "REVIEWING" };
  switch (r.verdict) {
    case "looks_good": return { kind: "ok", label: "LOOKS GOOD" };
    case "concerns": return { kind: "pending", label: "CONCERNS" };
    case "do_not_merge": return { kind: "error", label: "DO NOT MERGE" };
  }
}

type Judge = NonNullable<SwarmReview["judges"]>[number];
const JUDGE_COLUMNS: readonly TableColumn<Judge>[] = [
  { key: "modelId", header: "JUDGE", mono: true, truncate: true },
  { key: "verdict", header: "VERDICT", render: (j) => j.verdict.replace(/_/g, " ") },
  { key: "notes", header: "NOTES", truncate: true },
];

function Approval({ approval, resolved, fallback, review, busy, now, onResolve }: {
  approval: ApprovalRequest | undefined;
  /** An approval_resolved event was seen: the stored copy may lag, but the decision is final. */
  resolved: "approved" | "rejected" | undefined;
  review: SwarmReview | undefined;
  now: number;
  fallback: string;
  busy: boolean;
  onResolve: (decision: "approved" | "rejected") => void;
}) {
  if (!approval) return <StatusLine>{`approval ${fallback} · … loading`}</StatusLine>;
  const decided = approval.decision;
  const text = actionText(approval.action);
  const verdict = review ? verdictBadge(review) : undefined;
  const footer = decided ? (
    <StatusLine tone={decided === "approved" ? "ok" : "error"}>
      {`${decided} by ${approval.decidedBy ? `${approval.decidedBy.via} ${approval.decidedBy.userId}` : "unknown"}${approval.decidedAt ? ` at ${tPlus(approval.decidedAt)}` : ""}`}
    </StatusLine>
  ) : resolved ? (
    <StatusLine tone={resolved === "approved" ? "ok" : "error"}>{`${resolved} (resolved event)`}</StatusLine>
  ) : (
    <PendingNote requestedAt={approval.requestedAt} now={now} />
  );
  return (
    <Region className="sv-approval" header={{ title: `APPROVAL · ${approval.action.kind}`, children: <span className="nx-data">{approval.id}</span> }} footer={footer}>
      <div className="sv-card">
        <div className="sv-mono" title={text}>{text}</div>
        <div className="sv-reason">
          <span className="sv-k">REASON</span> {approval.reason}
          <ModelWritten />
        </div>
        {review && verdict ? (
          <div className="sv-swarm">
            <div className="sv-swarm-head">
              <Badge kind={verdict.kind}>{verdict.label}</Badge>
              <span className="sv-k">SWARM · data left this machine</span>
            </div>
            {review.summary ? (
              <div>
                {review.summary}
                <ModelWritten />
              </div>
            ) : null}
            {review.judges?.length ? <Table columns={JUDGE_COLUMNS} rows={review.judges} rowKey={(j) => j.modelId} aria-label="swarm judges" /> : null}
          </div>
        ) : null}
        {decided || resolved ? null : (
          <div className="sv-actions">
            <Button variant="primary" disabled={busy} onClick={() => onResolve("approved")}>APPROVE</Button>
            <Button variant="danger" disabled={busy} onClick={() => onResolve("rejected")}>REJECT</Button>
          </div>
        )}
      </div>
    </Region>
  );
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

function switcherOptions(list: readonly AgentSession[] | undefined, current: AgentSession | undefined, titles: ReadonlyMap<string, string>, liveStatus?: AgentSession["status"]) {
  const all = [...(list ?? [])];
  if (current && !all.some((x) => x.id === current.id)) all.unshift(current);
  return all.map((x) => ({
    value: x.id,
    label: `${statusBadge(x.id === current?.id && liveStatus ? liveStatus : x.status).label} · ${titles.get(x.taskId) ?? x.taskId} · ${x.model.modelId}`,
  }));
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
  const [reviews, setReviews] = useState<ReadonlyMap<string, SwarmReview>>(new Map());
  const reviewAsked = useRef(new Set<string>());
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
  // The session the view is on right now: async answers for another session are dropped.
  const sidRef = useRef<string | undefined>(sessionId);
  sidRef.current = sessionId;
  const listAt = useRef(0);

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
    listAt.current = Date.now();
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
    setCancelling(false);
    setBusyApproval("");
    setTab("log");
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
  // The host's summary is authoritative while no live receipt has arrived; otherwise the rows are summed.
  const useSummary = summary !== undefined && summary.calls === receipts.length;
  const cost = useSummary ? summary.costUsd : totals.costUsd;
  const saved = useSummary ? summary.savedUsd : totals.savedUsd;

  // Swarm reviews: fetched once per approval request seen in the log, kept fresh by the subscription.
  const approvalIds = useMemo(() => ordered.flatMap((e) => (e.type === "approval_request" ? [e.approvalId] : [])), [ordered]);
  useEffect(() => {
    const b = bridge ?? getBridge();
    return b.subscribe("swarms.review.subscribe", {}, (r) => setReviews((cur) => new Map(cur).set(r.approvalId, r)));
  }, [bridge]);
  useEffect(() => {
    const b = bridge ?? getBridge();
    for (const id of approvalIds) {
      if (reviewAsked.current.has(id)) continue;
      reviewAsked.current.add(id);
      b.request("swarms.review.get", { approvalId: id })
        .then((r) => r && setReviews((cur) => (cur.has(id) ? cur : new Map(cur).set(id, r))))
        .catch(() => undefined); // a review is optional: no badge when it cannot be read
    }
  }, [bridge, approvalIds]);

  // Auto-scroll stays pinned to the bottom until the user scrolls up; "N NEW" returns.
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastCount = useRef(0);
  const [unseen, setUnseen] = useState(0);
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (pinned.current) setUnseen(0);
  };
  const jumpToBottom = () => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setUnseen(0);
  };
  useEffect(() => {
    pinned.current = true;
    lastCount.current = 0;
    setUnseen(0);
  }, [sessionId]);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    const added = ordered.length - lastCount.current;
    lastCount.current = ordered.length;
    if (!el || tab !== "log") return;
    if (pinned.current) {
      el.scrollTop = el.scrollHeight;
      setUnseen(0);
    } else if (added > 0) {
      setUnseen((n) => n + added);
    }
  }, [ordered.length, tab]);

  const refreshList = () => {
    if (Date.now() - listAt.current > 1000) loadList();
  };
  const retry = <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>RETRY</Button>;
  if (!sessionId) {
    if (listError) {
      return (
        <div className="session-app">
          <StatusLine tone="error">{listError} {retry}</StatusLine>
        </div>
      );
    }
    return (
      <div className="session-app">
        {list ? <EmptyState message="no agent session yet · make a task from a Slack thread" /> : <StatusLine>… loading</StatusLine>}
      </div>
    );
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
    const sid = sessionId;
    const here = () => sidRef.current === sid;
    b.request("agent.cancel", { sessionId: sid })
      .then(() => here() && setCancelled({ atSeq }))
      .catch((e) => here() && setError(friendlyError(e, "session")))
      .finally(() => here() && setCancelling(false));
  };
  const resolve = (approvalId: string, decision: "approved" | "rejected") => {
    const sid = sessionId;
    const here = () => sidRef.current === sid;
    setBusyApproval(approvalId);
    const settle = async () => {
      try {
        const a = await b.request("approvals.resolve", { approvalId, decision });
        if (here()) setApprovals((cur) => putApproval(cur, a));
      } catch (e) {
        // Someone else decided first: the host answers "conflict" without the winner, so fetch it.
        if (!(e instanceof BridgeError && e.code === "conflict")) throw e;
        const list = await b.request("approvals.list", { sessionId: sid });
        if (!here()) return;
        setApprovals((cur) => list.reduce(putApproval, cur));
        if (!list.some((a) => a.id === approvalId && a.decision)) setError("already decided elsewhere");
      }
    };
    settle()
      .catch((e) => here() && setError(friendlyError(e, "approvals")))
      .finally(() => here() && setBusyApproval(""));
  };

  // Latest diff per path, in order of first appearance.
  const diffs = new Map<string, string>();
  for (const e of ordered) if (e.type === "file_edit") diffs.set(e.path, e.diff);
  const resolvedIds = new Map<string, "approved" | "rejected">();
  for (const e of ordered) if (e.type === "approval_resolved") resolvedIds.set(e.approvalId, e.decision);
  const tests = ordered.filter((e): e is Extract<AgentEvent, { type: "test_output" }> => e.type === "test_output");

  const badge = status ? statusBadge(status) : undefined;
  const live = status === "running" || status === "awaiting_approval";
  const startMs = session ? Date.parse(session.startedAt) : NaN;
  const lastMs = ordered.length ? Date.parse(ordered[ordered.length - 1].at) : startMs;
  const endMs = session?.endedAt ? Date.parse(session.endedAt) : live ? now : lastMs;
  const costText = receipts.length || useSummary ? `$${usd(cost)}${saved > 0 ? ` (saved ${usd(saved)})` : ""}` : "$—";
  const strip = session
    ? [session.branch, session.model.modelId, tPlus(session.startedAt), elapsedLabel(endMs - startMs), costText]
    : [];

  return (
    <div className="session-app">
      <StoreStatusLine bridge={bridge} />
      <Region flush className="sv-head" aria-label="agent session">
        <div className="sv-head-row">
          <Select
            aria-label="session"
            value={sessionId}
            onMouseDown={loadList}
            onFocus={refreshList}
            onKeyDown={refreshList}
            onChange={(e) => setSessionId(e.target.value)}
            options={switcherOptions(list, session, titles, status)}
          />
          <span data-testid="session-status" className="sv-badge">
            {badge ? <Badge kind={badge.kind}>{badge.label}</Badge> : null}
          </span>
          <Button variant="danger" size="sm" disabled={!canCancel} onClick={cancel}>CANCEL</Button>
        </div>
        <div className="sv-strip" title={strip.join(" · ")}>
          <span className="sv-strip-in nx-data">
            {strip.length ? strip.map((part, i) => (
              <span key={i}>{i ? " · " : ""}<span>{part}</span></span>
            )) : "…"}
          </span>
        </div>
      </Region>
      {!session && !loadError ? <StatusLine>… loading</StatusLine> : null}
      {loadError ? <StatusLine tone="error">{loadError} {retry}</StatusLine> : null}
      {listError ? <StatusLine tone="error">{listError} {retry}</StatusLine> : null}
      {approvalsError ? <StatusLine tone="error">{approvalsError} {retry}</StatusLine> : null}
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      {gaps.length ? <StatusLine tone="pending">missing events {gaps.join(", ")}</StatusLine> : null}
      <Tabs
        aria-label="agent view"
        tabs={[
          { id: "log", label: "LOG", count: ordered.length },
          { id: "diff", label: "DIFF", count: diffs.size },
          { id: "tests", label: "TESTS", count: tests.length },
          { id: "receipts", label: "RECEIPTS", count: receipts.length },
        ]}
        active={tab}
        onChange={(id) => {
          pinned.current = true;
          setTab(id);
        }}
      />
      <div className="session-main">
        <div className="session-body" ref={bodyRef} onScroll={onScroll}>
          {tab === "log" ? (
            ordered.length ? (
              ordered.map((e) => (
                <LogRow
                  key={e.seq}
                  e={e}
                  card={
                    e.type === "approval_request" ? (
                      <Approval
                        approval={approvals.get(e.approvalId)}
                        resolved={resolvedIds.get(e.approvalId)}
                        review={reviews.get(e.approvalId)}
                        fallback={e.approvalId}
                        busy={busyApproval === e.approvalId}
                        now={now}
                        onResolve={(d) => resolve(e.approvalId, d)}
                      />
                    ) : undefined
                  }
                />
              ))
            ) : (
              <EmptyState message="no events yet" />
            )
          ) : null}
          {tab === "diff" ? (
            diffs.size ? [...diffs].map(([path, diff]) => <DiffFile key={path} path={path} diff={diff} />) : <EmptyState message="no diffs yet" />
          ) : null}
          {tab === "tests" ? (
            tests.length ? (
              tests.map((t) => (
                <div className="sv-test" key={t.seq}>
                  <div className="sv-test-head">
                    <span className="sv-mono-line nx-data" title={t.command}>{t.command}</span>
                    <Badge kind={t.exitCode === 0 ? "ok" : "error"}>{`exit ${t.exitCode}`}</Badge>
                  </div>
                  <MonoBlock label="OUTPUT" count={lineCount(t.tail)}>{t.tail}</MonoBlock>
                </div>
              ))
            ) : (
              <EmptyState message="no test output yet" />
            )
          ) : null}
          {tab === "receipts" ? (
            <>
              {receiptsError ? <StatusLine tone="error">{receiptsError} {retry}</StatusLine> : null}
              <Receipts receipts={receipts} totals={totals} cost={cost} saved={saved} />
            </>
          ) : null}
        </div>
        {tab === "log" && unseen > 0 ? (
          <div className="sv-new">
            <Button variant="ghost" size="sm" onClick={jumpToBottom}>{`↓ ${unseen} NEW`}</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function lineCount(text: string): string {
  const n = text.split("\n").length;
  return `${n} line${n === 1 ? "" : "s"}`;
}

function diffClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-meta";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "";
}

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
  }
  return { added, removed };
}

function DiffFile({ path, diff }: { path: string; diff: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const { added, removed } = diffStats(diff);
  return (
    <Region
      flush
      className="sv-diff"
      header={{
        title: "",
        children: (
          <>
            <span className="sv-path nx-data" data-testid="diff-path" title={path}>{path}</span>
            <span className="sv-stat nx-data"><span className="nx-tone-ok">{`+${added}`}</span> <span className="nx-tone-error">{`−${removed}`}</span></span>
          </>
        ),
        actions: <Button size="sm" variant="ghost" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>{collapsed ? "EXPAND" : "COLLAPSE"}</Button>,
      }}
    >
      {collapsed ? null : (
        <pre className="diff-pre">
          {diff.split("\n").map((line, i) => (
            <span key={i} className={`diff-line ${diffClass(line)}`}>{line}</span>
          ))}
        </pre>
      )}
    </Region>
  );
}

/** One line of the transcript. Messages and approval cards are full-width; everything else is a 22 px grid row. */
function LogRow({ e, card }: { e: AgentEvent; card: ReactNode }) {
  const head = (
    <>
      <span className="log-seq">{e.seq}</span>
      <span className="log-at">{tPlus(e.at)}</span>
    </>
  );
  const row = (cls: string, body: ReactNode) => (
    <div className={`log-row ${cls}`} data-testid="log-row" data-seq={e.seq}>
      {body}
    </div>
  );
  const line = (glyph: ReactNode, tool: string, summary: string, tone?: string) => (
    <div className="sv-line" title={`${tool} ${summary}`}>
      <span className={`sv-glyph ${tone ?? ""}`}>{glyph}</span>
      <span className="sv-tool nx-data">{tool}</span>
      <span className="sv-summary nx-data">{summary}</span>
    </div>
  );
  switch (e.type) {
    case "message":
      return row("log-row--block", <div className="log-text">{e.text}<ModelWritten /></div>);
    case "approval_request":
      return row("log-row--block", card);
    case "tool_call":
      return row("", <>{head}{line("›", e.tool, short(e.args))}</>);
    case "tool_result":
      return row("", <>{head}{line(<span role="img" aria-label={e.ok ? "ok" : "failed"}>{e.ok ? "✓" : "✗"}</span>, e.tool, e.summary, e.ok ? "nx-tone-ok" : "nx-tone-error")}</>);
    case "file_edit":
      return row("", <>{head}{line("±", "edit", e.path)}</>);
    case "approval_resolved":
      return row("", <>{head}{line(e.decision === "approved" ? "✓" : "✗", "approval", `${e.approvalId} ${e.decision}`, e.decision === "approved" ? "nx-tone-ok" : "nx-tone-error")}</>);
    case "test_output":
      return row("", <>{head}{line(e.exitCode === 0 ? "✓" : "✗", "test", `${e.command} · exit ${e.exitCode}`, e.exitCode === 0 ? "nx-tone-ok" : "nx-tone-error")}</>);
    case "receipt":
      return row("", <>{head}{line("$", "receipt", `${e.receipt.requestedModel} → ${e.receipt.servedModel} · $${usd(e.receipt.costUsd)}`)}</>);
    case "status":
      return row("", <>{head}<StatusLine>{`status ${e.status}`}</StatusLine></>);
    case "commit":
      return row("", <>{head}<StatusLine tone="ok">{`commit ${e.sha.slice(0, 12)}`}</StatusLine></>);
    case "error":
      return row("", <>{head}<StatusLine tone="error">{e.message}</StatusLine></>);
  }
}

function Receipts({ receipts, totals, cost, saved }: { receipts: readonly ModelCallReceipt[]; totals: Totals; cost: number; saved: number }) {
  if (!receipts.length) return <EmptyState message="no receipts yet" />;
  const columns: readonly TableColumn<ModelCallReceipt>[] = [
    { key: "role", header: "ROLE", truncate: true, title: (r) => `${r.role} · ${r.optimizations.join(", ") || "no optimizations"}` },
    {
      key: "model",
      header: "MODEL",
      mono: true,
      truncate: true,
      title: (r) => (r.servedModel === r.requestedModel ? `${r.servedModel} (requested = served)` : `${r.requestedModel} → ${r.servedModel}`),
      // Same model: one name (requested = served). Routed elsewhere: both, the served one flagged.
      render: (r) =>
        r.servedModel === r.requestedModel ? (
          <span>{r.servedModel}</span>
        ) : (
          <>
            <span>{r.requestedModel}</span> → <span className="nx-tone-pending">{r.servedModel}</span>
          </>
        ),
    },
    { key: "cost", header: "COST", mono: true, align: "right", render: (r) => usd(r.costUsd) },
    { key: "base", header: "BASE", mono: true, align: "right", render: (r) => (r.baselineCostUsd === undefined ? "—" : usd(r.baselineCostUsd)) },
    {
      key: "receipt",
      header: "RECEIPT",
      mono: true,
      render: (r) => (
        <span className="sv-receipt">
          <span title={r.pruneReceiptId}>{r.pruneReceiptId}</span>
          <Button size="sm" disabled title={OPEN_RECEIPT_HINT}>OPEN</Button>
        </span>
      ),
    },
  ];
  return (
    <Table
      columns={columns}
      rows={receipts}
      rowKey={(r) => r.callId}
      aria-label="model call receipts"
      footer={{ role: `TOTAL ${totals.calls}`, model: `saved ${usd(saved)}`, cost: usd(cost), base: usd(totals.baselineUsd) }}
    />
  );
}

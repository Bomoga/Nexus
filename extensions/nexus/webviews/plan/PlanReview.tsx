import { useEffect, useState } from "react";
import type { TaskPlan } from "../../src/contracts";
import { Badge, Button, Chip, MonoBlock, Region, StatusLine, Table, friendlyError, getBridge } from "../shared";
import type { BadgeKind, BridgeClient, TableColumn } from "../shared";
import "./plan.css";

type Subtask = TaskPlan["subtasks"][number];
type Row = Subtask & { index: number };

const STATUS_BADGE: Record<TaskPlan["status"], { kind: BadgeKind; label: string }> = {
  proposed: { kind: "pending", label: "PROPOSED" },
  accepted: { kind: "ok", label: "ACCEPTED" },
  rejected: { kind: "error", label: "REJECTED" },
};

export interface PlanReviewProps {
  /** Loaded with tasks.plan.get when no `plan` is given. */
  planId?: string;
  plan?: TaskPlan;
  bridge?: BridgeClient;
  /** Title of the task the plan was made from, when the caller has it; the header falls back to the task id. */
  sourceTitle?: string;
}

/** Review a swarm-written TaskPlan: nothing becomes a Task until a human accepts it. All plan text is rendered as plain text. */
export function PlanReview({ planId, plan: given, bridge, sourceTitle }: PlanReviewProps) {
  const [plan, setPlan] = useState<TaskPlan | undefined>(given);
  const [failure, setFailure] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setPlan(given);
  }, [given]);

  const loadId = given ? undefined : planId;
  useEffect(() => {
    if (!loadId) return;
    let live = true;
    setFailure("");
    (bridge ?? getBridge())
      .request("tasks.plan.get", { planId: loadId })
      .then((p) => live && setPlan(p))
      .catch((e) => live && setFailure(friendlyError(e, "plan")));
    return () => {
      live = false;
    };
  }, [bridge, loadId, attempt]);

  if (!plan && !loadId) return <StatusLine tone="error">no plan id</StatusLine>;
  if (failure) {
    return (
      <StatusLine tone="error">
        {failure} <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>RETRY</Button>
      </StatusLine>
    );
  }
  if (!plan) return <StatusLine>… loading plan</StatusLine>;

  const decide = (name: "tasks.plan.accept" | "tasks.plan.reject") => {
    if (busy) return;
    setBusy(true);
    setError("");
    const client = bridge ?? getBridge();
    const settle = async () => {
      try {
        setPlan(await client.request(name, { planId: plan.id }));
      } catch (e) {
        // Someone may have decided first (Lane 1 refuses a plan that is no longer proposed): show the stored decision.
        const current = await client.request("tasks.plan.get", { planId: plan.id }).catch(() => undefined);
        if (current && current.status !== "proposed") setPlan(current);
        else setError(friendlyError(e, "plan"));
      }
    };
    settle().finally(() => setBusy(false));
  };

  const toggle = (i: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  const rows: Row[] = plan.subtasks.map((s, index) => ({ ...s, index }));
  const columns: TableColumn<Row>[] = [
    { key: "n", header: "#", mono: true, align: "right", render: (r) => String(r.index + 1) },
    {
      key: "title",
      header: "TITLE",
      render: (r) => {
        const expanded = open.has(r.index);
        return (
          <div className="plan-subtask">
            <div className="plan-subtask-head">
              <Button
                size="sm"
                aria-label={`${expanded ? "collapse" : "expand"} brief ${r.index + 1}`}
                aria-expanded={expanded}
                onClick={() => toggle(r.index)}
              >
                {expanded ? "▾" : "▸"}
              </Button>
              <span>{r.title}</span>
            </div>
            {expanded ? (
              <MonoBlock label={`BRIEF ${r.index + 1} (MODEL-WRITTEN)`}>{r.brief}</MonoBlock>
            ) : (
              <span className="plan-brief-line" title={r.brief}>{r.brief}</span>
            )}
          </div>
        );
      },
    },
    { key: "after", header: "DEPENDS ON", mono: true, render: (r) => (r.dependsOn.length ? r.dependsOn.map((d) => d + 1).join(", ") : "") },
  ];

  const created = plan.createdTaskIds?.length ?? 0;
  const badge = STATUS_BADGE[plan.status];

  return (
    <Region
      className="plan-review"
      aria-label="plan review"
      header={{
        title: "PLAN",
        children: (
          <span className="plan-meta">
            <span className="plan-source" title={sourceTitle ?? plan.sourceTaskId}>{sourceTitle ?? plan.sourceTaskId}</span>
            <Badge kind={badge.kind}>{badge.label}</Badge>
          </span>
        ),
        actions: <span className="nx-count">{`${plan.subtasks.length} subtasks`}</span>,
      }}
      pad
    >
      <div className="plan-meta">
        <span className="nx-data">{plan.id.slice(0, 12)}</span>
        <span className="nx-data">{plan.swarmType}</span>
        <span className="nx-label">model-written · left machine</span>
      </div>
      <Table columns={columns} rows={rows} rowKey={(r) => String(r.index)} aria-label="subtasks" />
      {plan.status === "accepted" ? <StatusLine tone="ok">{`created ${created} draft tasks`}</StatusLine> : null}
      {plan.status === "accepted" && created > 0 ? (
        <div className="plan-ids">
          {plan.createdTaskIds?.map((id) => (
            <Chip key={id} className="nx-data">{id}</Chip>
          ))}
        </div>
      ) : null}
      {plan.status === "proposed" ? (
        <div className="plan-actions">
          <Button variant="primary" disabled={busy} onClick={() => decide("tasks.plan.accept")}>ACCEPT</Button>
          <Button variant="danger" disabled={busy} onClick={() => decide("tasks.plan.reject")}>REJECT</Button>
        </div>
      ) : null}
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
    </Region>
  );
}

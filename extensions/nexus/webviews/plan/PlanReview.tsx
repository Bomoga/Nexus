import { useEffect, useState } from "react";
import type { TaskPlan } from "../../src/contracts";
import { Button, Chip, StatusLine, Table, friendlyError, getBridge } from "../shared";
import type { BridgeClient, TableColumn, Tone } from "../shared";
import "./plan.css";

type Subtask = TaskPlan["subtasks"][number];
type Row = Subtask & { index: number };

const STATUS_TONE: Record<TaskPlan["status"], Tone> = { proposed: "pending", accepted: "ok", rejected: "error" };

export interface PlanReviewProps {
  /** Loaded with tasks.plan.get when no `plan` is given. */
  planId?: string;
  plan?: TaskPlan;
  bridge?: BridgeClient;
}

/** Review a swarm-written TaskPlan: nothing becomes a Task until a human accepts it. All plan text is rendered as plain text. */
export function PlanReview({ planId, plan: given, bridge }: PlanReviewProps) {
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
        {failure} <Button onClick={() => setAttempt((n) => n + 1)}>RETRY</Button>
      </StatusLine>
    );
  }
  if (!plan) return <StatusLine>loading plan</StatusLine>;

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
    { key: "n", header: "#", data: true, render: (r) => String(r.index + 1) },
    { key: "title", header: "TITLE", render: (r) => r.title },
    {
      key: "brief",
      header: "BRIEF",
      render: (r) => {
        const expanded = open.has(r.index);
        return (
          <div className="plan-brief">
            <Button
              aria-label={`${expanded ? "collapse" : "expand"} brief ${r.index + 1}`}
              aria-expanded={expanded}
              onClick={() => toggle(r.index)}
            >
              {expanded ? "▾" : "▸"}
            </Button>
            {expanded ? <pre className="plan-brief-full">{r.brief}</pre> : <span className="plan-brief-line">{r.brief}</span>}
          </div>
        );
      },
    },
    {
      key: "after",
      header: "DEPENDS",
      data: true,
      render: (r) => (r.dependsOn.length ? `after: ${r.dependsOn.map((d) => d + 1).join(", ")}` : ""),
    },
  ];

  const created = plan.createdTaskIds?.length ?? 0;

  return (
    <div className="plan-review">
      <div className="plan-head">
        <span className="plan-data">{plan.id.slice(0, 12)}</span>
        <span className="plan-data">{plan.swarmType}</span>
        <Chip tone={STATUS_TONE[plan.status]}>{plan.status}</Chip>
        <Chip>model-written · left machine</Chip>
      </div>
      <Table columns={columns} rows={rows} rowKey={(r) => String(r.index)} />
      {plan.status === "accepted" ? <StatusLine tone="ok">{`created ${created} draft tasks`}</StatusLine> : null}
      {plan.status === "proposed" ? (
        <div className="plan-actions">
          <Button variant="primary" disabled={busy} onClick={() => decide("tasks.plan.accept")}>ACCEPT</Button>
          <Button disabled={busy} onClick={() => decide("tasks.plan.reject")}>REJECT</Button>
        </div>
      ) : null}
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
    </div>
  );
}

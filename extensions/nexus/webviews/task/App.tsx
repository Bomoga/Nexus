import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo, OptimizerSetting, ProviderAccount, Task, TaskPlan } from "../../src/contracts";
import { Badge, Button, Chip, EmptyState, Input, Region, Select, StatusLine, friendlyError, getBridge } from "../shared";
import type { BadgeKind, ChipKind } from "../shared";
import type { BridgeClient } from "../shared";
import { PlanReview } from "../plan/PlanReview";
import { composeBrief, splitBrief } from "./brief";

export const SUBTASK_THRESHOLD = 1200;

const DATA_USE_LABEL = {
  not_used_for_training: "not used for training",
  may_be_used_for_training: "may be used for training",
  unknown: "data use unknown",
} as const;

export function modelLabel(m: ModelInfo, account: ProviderAccount | undefined, viaPrune: boolean): string {
  // Through Prune (all_roles) the payload also goes to the Prune service, whatever the provider says (CLAUDE.md section 14).
  const use = viaPrune ? DATA_USE_LABEL.unknown : DATA_USE_LABEL[account?.dataUse ?? "unknown"];
  // No account means we cannot say the data stays local, so assume it leaves.
  const leaves = viaPrune || !account || account.dataLeavesMachine;
  return `${m.displayName} | ${m.provider} | ${use}${leaves ? " | LEAVES MACHINE" : ""}`;
}

/** Data-use chips for the chosen model; same facts as modelLabel, so the picker line and the chips never disagree. */
export function dataUseChips(account: ProviderAccount | undefined, viaPrune: boolean): { kind: ChipKind; label: string }[] {
  const chips: { kind: ChipKind; label: string }[] = [];
  if (viaPrune || !account || account.dataLeavesMachine) chips.push({ kind: "pending", label: "LEAVES MACHINE" });
  const use = viaPrune ? "unknown" : (account?.dataUse ?? "unknown");
  if (use === "not_used_for_training") chips.push({ kind: "ok", label: "NOT USED FOR TRAINING" });
  else if (use === "may_be_used_for_training") chips.push({ kind: "error", label: "MAY BE USED FOR TRAINING" });
  else chips.push({ kind: "default", label: "UNKNOWN" });
  return chips;
}

const TASK_BADGE: Record<Task["status"], { kind: BadgeKind; label: string }> = {
  draft: { kind: "muted", label: "DRAFT" },
  running: { kind: "accent", label: "RUNNING" },
  awaiting_approval: { kind: "pending", label: "AWAITING" },
  done: { kind: "ok", label: "DONE" },
  failed: { kind: "error", label: "FAILED" },
  cancelled: { kind: "muted", label: "CANCELLED" },
};

const modelKey = (m: { provider: string; modelId: string }) => `${m.provider}/${m.modelId}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface AppProps {
  bridge?: BridgeClient;
  /** Undefined when the host gave no task id: the panel shows an error and makes no requests. */
  taskId: string | undefined;
}

export function App({ bridge, taskId }: AppProps) {
  const [task, setTask] = useState<Task | undefined>();
  const [title, setTitle] = useState("");
  const [rest, setRest] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [optimizer, setOptimizer] = useState<OptimizerSetting | undefined>();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<"" | "starting" | "decomposing">("");
  const [error, setError] = useState("");
  const [titleEmpty, setTitleEmpty] = useState(false);
  const [note, setNote] = useState("");
  const [plan, setPlan] = useState<TaskPlan | undefined>();
  const [failure, setFailure] = useState("");
  const [modelsError, setModelsError] = useState("");
  // RETRY of each load re-runs only that load, so edits already typed into the task are never reset.
  const [taskAttempt, setTaskAttempt] = useState(0);
  const [modelsAttempt, setModelsAttempt] = useState(0);
  // Latest values for persist(), which START awaits after the user's last keystroke.
  const saved = useRef<Task | undefined>(undefined);
  const titleRef = useRef("");
  const restRef = useRef("");
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const starting = useRef(false);
  titleRef.current = title;
  restRef.current = rest;

  useEffect(() => {
    if (!taskId) return;
    let live = true;
    setFailure("");
    const b = bridge ?? getBridge();
    b.request("tasks.get", { taskId })
      .then((t) => {
        if (!live) return;
        saved.current = t;
        setTask(t);
        setTitle(t.title);
        setRest(splitBrief(t.brief, t.source.kind === "thread").rest);
      })
      .catch((e) => live && setFailure(friendlyError(e, "task")));
    b.request("accounts.list", {})
      .then((a) => live && setAccounts(a))
      .catch(() => undefined); // labels fall back to "data use unknown" + leaves machine
    b.request("optimizer.get", {})
      .then((o) => live && setOptimizer(o))
      .catch(() => undefined); // the chip stays "Prune: ?"
    return () => {
      live = false;
    };
  }, [bridge, taskId, taskAttempt]);

  useEffect(() => {
    if (!taskId) return;
    let live = true;
    setModelsError("");
    (bridge ?? getBridge())
      .request("models.list", { role: "agent" })
      .then((m) => live && setModels(m))
      .catch((e) => live && setModelsError(friendlyError(e, "models")));
    return () => {
      live = false;
    };
  }, [bridge, taskId, modelsAttempt]);

  // §14: while the optimizer state is unknown (loading or failed), calls might go through Prune,
  // so labels say "unknown" + leaves machine rather than guessing in the user's favour.
  const viaPrune = optimizer === undefined || (optimizer.enabled === true && optimizer.scope === "all_roles");
  const options = useMemo(
    () => [
      { value: "", label: "SELECT MODEL" },
      ...models.map((m) => ({ value: modelKey(m), label: modelLabel(m, accounts.find((a) => a.provider === m.provider), viaPrune) })),
    ],
    [models, accounts, viaPrune],
  );

  if (!taskId) return <div className="task-app"><StatusLine tone="error">no task id</StatusLine></div>;
  if (failure) {
    return (
      <div className="task-app">
        <StatusLine tone="error">
          {failure} <Button size="sm" onClick={() => setTaskAttempt((n) => n + 1)}>RETRY</Button>
        </StatusLine>
      </div>
    );
  }
  if (!task) return <div className="task-app"><StatusLine>… loading task</StatusLine></div>;

  const b = bridge ?? getBridge();
  const isThread = task.source.kind === "thread";
  const { quote } = splitBrief(task.brief, isThread);
  const fullBrief = composeBrief(quote, rest);
  const editable = task.status === "draft";
  const chosen = models.find((m) => modelKey(m) === selected);

  /** Saves any unsaved title/brief edit, after any save already in flight. Resolves false when nothing may start on it. */
  const persist = (): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      const cur = saved.current;
      if (!cur) return false;
      const nextTitle = titleRef.current.trim();
      setTitleEmpty(!nextTitle);
      if (!nextTitle) return false;
      const patch: { title?: string; brief?: string } = {};
      if (nextTitle !== cur.title) patch.title = nextTitle;
      const brief = composeBrief(splitBrief(cur.brief, cur.source.kind === "thread").quote, restRef.current);
      if (brief !== cur.brief) patch.brief = brief;
      if (patch.title === undefined && patch.brief === undefined) return true;
      try {
        const u = await b.request("tasks.update", { taskId, ...patch });
        saved.current = { ...cur, title: u.title, brief: u.brief };
        setTask(saved.current);
        setError("");
        return true;
      } catch (e) {
        setError(`save failed: ${message(e)}`);
        return false;
      }
    };
    const p = chain.current.then(run);
    chain.current = p;
    return p;
  };

  const start = () => {
    if (!chosen || busy || starting.current || !editable) return;
    starting.current = true;
    setBusy("starting");
    setError("");
    persist()
      .then(async (ok) => {
        if (!ok) return; // never start on a brief that was not saved
        const s = await b.request("agent.start", { taskId, model: { provider: chosen.provider, modelId: chosen.modelId } });
        saved.current = { ...(saved.current as Task), status: "running", sessionId: s.id };
        setTask(saved.current);
        await b.request("ui.openTarget", { type: "session", sessionId: s.id });
      })
      .catch((e) => setError(friendlyError(e, "task")))
      .finally(() => {
        starting.current = saved.current?.status !== "draft"; // stays locked once started
        setBusy("");
      });
  };

  const decompose = () => {
    setBusy("decomposing");
    setError("");
    setNote("");
    persist()
      .then(async (ok) => {
        if (!ok) return;
        const p = await b.request("tasks.decompose", { taskId });
        setNote(`plan ${p.id} proposed: ${p.subtasks.length} subtasks`);
        setPlan(p);
      })
      .catch((e) => setError(friendlyError(e, "task")))
      .finally(() => setBusy(""));
  };

  const prune = optimizer ? (optimizer.enabled ? "ON" : "OFF") : "?";
  const badge = TASK_BADGE[task.status];
  const lineCount = rest.length === 0 ? 0 : rest.split("\n").length;
  const chosenAccount = chosen ? accounts.find((a) => a.provider === chosen.provider) : undefined;
  const locked = !editable || busy === "starting";

  return (
    <div className="task-app">
      <Region header={{ title: "TASK" }} pad>
        <div className="task-meta">
          <Badge kind={badge.kind}>{badge.label}</Badge>
          <span className="nx-data task-source">{isThread ? "source: slack thread" : "source: manual"}</span>
        </div>
        <Input
          id="task-title"
          prefix="TITLE"
          wrapClassName="task-title-wrap"
          aria-label="title"
          value={title}
          disabled={locked}
          onChange={(e) => {
            setTitle(e.target.value);
            if (e.target.value.trim()) setTitleEmpty(false);
          }}
          onBlur={() => void persist()}
        />
        {titleEmpty ? <StatusLine tone="error">title can't be empty</StatusLine> : null}
        <div className="task-row">
          <span className="nx-caption">CODE REFS</span>
          {task.codeRefs.length === 0 ? <Chip>none</Chip> : null}
          {task.codeRefs.map((r) => (
            <Chip key={`${r.path}:${r.startLine}-${r.endLine}:${r.commit}`}>{`${r.path}:${r.startLine}-${r.endLine}`}</Chip>
          ))}
        </div>
      </Region>

      {quote ? (
        <Region header={{ title: "SOURCE", children: <span className="nx-label">UNTRUSTED / QUOTED / READ-ONLY</span> }} pad>
          <div data-testid="quoted-block" role="note" aria-label="quoted thread, read-only">
            <pre className="nx-quote">{quote}</pre>
          </div>
        </Region>
      ) : null}

      <Region header={{ title: "BRIEF", actions: <span className="nx-count">{`${lineCount} lines · ${rest.length} chars`}</span> }} pad>
        <textarea
          className="nx-textarea task-brief"
          aria-label="brief"
          value={rest}
          disabled={locked}
          spellCheck={false}
          onChange={(e) => setRest(e.target.value)}
          onBlur={() => void persist()}
        />
        <div className="nx-caption task-hint">{'lines starting with "> " are treated as quoted data by the agent'}</div>
      </Region>

      <Region header={{ title: "MODEL" }} pad>
        <div className="task-actions">
          <Select id="task-model" aria-label="model" className="task-model" options={options} value={selected} disabled={locked} onChange={(e) => setSelected(e.target.value)} />
          <Chip>{`Prune: ${prune}`}</Chip>
        </div>
        {chosen ? (
          <div className="task-row" aria-label="data use of the chosen model">
            {dataUseChips(chosenAccount, viaPrune).map((c) => (
              <Chip key={c.label} kind={c.kind}>{c.label}</Chip>
            ))}
          </div>
        ) : null}
        {modelsError ? (
          <StatusLine tone="error">
            {modelsError} <Button size="sm" onClick={() => setModelsAttempt((n) => n + 1)}>RETRY</Button>
          </StatusLine>
        ) : models.length === 0 ? (
          <EmptyState message="no agent models available" />
        ) : null}
      </Region>

      <Region pad>
        <div className="task-actions">
          <Button variant="primary" disabled={!editable || !chosen || busy !== ""} onClick={start}>START</Button>
          {fullBrief.length > SUBTASK_THRESHOLD ? (
            <Button disabled={!editable || busy !== ""} onClick={decompose}>BREAK INTO SUBTASKS</Button>
          ) : null}
        </div>
        {!editable ? <StatusLine>{`task ${task.status}: editing and start are locked`}</StatusLine> : null}
        {error ? <StatusLine tone="error">{error}</StatusLine> : null}
        {note ? <StatusLine>{note}</StatusLine> : null}
      </Region>

      {plan ? <PlanReview key={plan.id} plan={plan} bridge={b} sourceTitle={task.title} /> : null}
    </div>
  );
}

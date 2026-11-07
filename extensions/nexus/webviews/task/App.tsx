import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo, OptimizerSetting, ProviderAccount, Task, TaskPlan } from "../../src/contracts";
import { Button, Chip, EmptyState, Input, Select, StatusLine, friendlyError, getBridge } from "../shared";
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

  if (!taskId) return <StatusLine tone="error">no task id</StatusLine>;
  if (failure) {
    return (
      <StatusLine tone="error">
        {failure} <Button onClick={() => setTaskAttempt((n) => n + 1)}>RETRY</Button>
      </StatusLine>
    );
  }
  if (!task) return <StatusLine>loading task</StatusLine>;

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

  return (
    <div className="task-app">
      <div className="task-field">
        <label className="task-label" htmlFor="task-title">title</label>
        <Input
          id="task-title"
          aria-label="title"
          value={title}
          disabled={!editable || busy === "starting"}
          onChange={(e) => {
            setTitle(e.target.value);
            if (e.target.value.trim()) setTitleEmpty(false);
          }}
          onBlur={() => void persist()}
        />
        {titleEmpty ? <StatusLine tone="error">title can't be empty</StatusLine> : null}
      </div>

      <div className="task-field">
        <span className="task-label">brief</span>
        {quote ? (
          <div data-testid="quoted-block" role="note" aria-label="quoted thread, read-only">
            <div className="task-quote-tag">quoted thread (untrusted, read-only)</div>
            <pre className="task-quote">{quote}</pre>
          </div>
        ) : null}
        <textarea
          className="task-brief"
          aria-label="brief"
          value={rest}
          disabled={!editable || busy === "starting"}
          spellCheck={false}
          onChange={(e) => setRest(e.target.value)}
          onBlur={() => void persist()}
        />
        <div className="task-quote-tag">{'lines starting with "> " are treated as quoted data by the agent'}</div>
      </div>

      <div className="task-field">
        <span className="task-label">code refs</span>
        <div className="task-row">
          {task.codeRefs.length === 0 ? <Chip>none</Chip> : null}
          {task.codeRefs.map((r) => (
            <Chip key={`${r.path}:${r.startLine}-${r.endLine}:${r.commit}`}>{`${r.path}:${r.startLine}-${r.endLine}`}</Chip>
          ))}
        </div>
      </div>

      <div className="task-field">
        <label className="task-label" htmlFor="task-model">model</label>
        <div className="task-actions">
          <Select id="task-model" aria-label="model" className="task-model" options={options} value={selected} disabled={!editable || busy === "starting"} onChange={(e) => setSelected(e.target.value)} />
          <Chip>{`Prune: ${prune}`}</Chip>
        </div>
        {modelsError ? (
          <StatusLine tone="error">
            {modelsError} <Button onClick={() => setModelsAttempt((n) => n + 1)}>RETRY</Button>
          </StatusLine>
        ) : models.length === 0 ? (
          <EmptyState message="no agent models available" />
        ) : null}
      </div>

      <div className="task-actions">
        <Button variant="primary" disabled={!editable || !chosen || busy !== ""} onClick={start}>START</Button>
        {fullBrief.length > SUBTASK_THRESHOLD ? (
          <Button disabled={!editable || busy !== ""} onClick={decompose}>BREAK INTO SUBTASKS</Button>
        ) : null}
      </div>

      {!editable ? <StatusLine>{`task ${task.status}: editing and start are locked`}</StatusLine> : null}
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      {note ? <StatusLine>{note}</StatusLine> : null}
      {plan ? <PlanReview key={plan.id} plan={plan} bridge={b} /> : null}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import type { ModelInfo, OptimizerSetting, ProviderAccount, Task } from "../../src/contracts";
import { Button, Chip, EmptyState, Input, Select, StatusLine, getBridge } from "../shared";
import type { BridgeClient } from "../shared";
import { composeBrief, splitBrief } from "./brief";

export const SUBTASK_THRESHOLD = 1200;

const DATA_USE_LABEL = {
  not_used_for_training: "not used for training",
  may_be_used_for_training: "may be used for training",
  unknown: "data use unknown",
} as const;

export function modelLabel(m: ModelInfo, account: ProviderAccount | undefined): string {
  const use = DATA_USE_LABEL[account?.dataUse ?? "unknown"];
  // No account means we cannot say the data stays local, so assume it leaves.
  const leaves = account ? account.dataLeavesMachine : true;
  return `${m.displayName} | ${m.provider} | ${use}${leaves ? " | LEAVES MACHINE" : ""}`;
}

const modelKey = (m: { provider: string; modelId: string }) => `${m.provider}/${m.modelId}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface AppProps {
  bridge?: BridgeClient;
  taskId: string;
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
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const b = bridge ?? getBridge();
    b.request("tasks.get", { taskId })
      .then((t) => {
        if (!live) return;
        setTask(t);
        setTitle(t.title);
        setRest(splitBrief(t.brief).rest);
      })
      .catch(() => live && setFailed(true));
    b.request("models.list", { role: "agent" })
      .then((m) => live && setModels(m))
      .catch((e) => live && setError(message(e)));
    b.request("accounts.list", {})
      .then((a) => live && setAccounts(a))
      .catch(() => undefined); // labels fall back to "data use unknown" + leaves machine
    b.request("optimizer.get", {})
      .then((o) => live && setOptimizer(o))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bridge, taskId]);

  const options = useMemo(
    () => [
      { value: "", label: "SELECT MODEL" },
      ...models.map((m) => ({ value: modelKey(m), label: modelLabel(m, accounts.find((a) => a.provider === m.provider)) })),
    ],
    [models, accounts],
  );

  if (failed) return <StatusLine tone="error">task unavailable</StatusLine>;
  if (!task) return <StatusLine>loading task</StatusLine>;

  const b = bridge ?? getBridge();
  const { quote } = splitBrief(task.brief);
  const fullBrief = composeBrief(quote, rest);
  const editable = task.status === "draft";
  const chosen = models.find((m) => modelKey(m) === selected);

  const save = (patch: { title?: string; brief?: string }) => {
    setError("");
    b.request("tasks.update", { taskId, ...patch })
      .then((t) => setTask((cur) => (cur ? { ...cur, title: t.title, brief: t.brief } : t)))
      .catch((e) => setError(message(e)));
  };

  const onTitleBlur = () => {
    const next = title.trim();
    if (next && next !== task.title) save({ title: next });
  };
  const onBriefBlur = () => {
    if (fullBrief !== task.brief) save({ brief: fullBrief });
  };

  const start = () => {
    if (!chosen || busy) return;
    setBusy("starting");
    setError("");
    b.request("agent.start", { taskId, model: { provider: chosen.provider, modelId: chosen.modelId } })
      .then((s) => b.request("ui.openTarget", { type: "session", sessionId: s.id }))
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(""));
  };

  const decompose = () => {
    setBusy("decomposing");
    setError("");
    setNote("");
    b.request("tasks.decompose", { taskId })
      .then((p) => setNote(`plan ${p.id} proposed: ${p.subtasks.length} subtasks`))
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(""));
  };

  return (
    <div className="task-app">
      <div className="task-field">
        <label className="task-label" htmlFor="task-title">title</label>
        <Input id="task-title" aria-label="title" value={title} disabled={!editable} onChange={(e) => setTitle(e.target.value)} onBlur={onTitleBlur} />
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
          disabled={!editable}
          spellCheck={false}
          onChange={(e) => setRest(e.target.value)}
          onBlur={onBriefBlur}
        />
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
          <Select id="task-model" aria-label="model" className="task-model" options={options} value={selected} onChange={(e) => setSelected(e.target.value)} />
          <Chip tone={optimizer?.enabled ? "ok" : "muted"}>{`Prune: ${optimizer?.enabled ? "ON" : "OFF"}`}</Chip>
        </div>
        {models.length === 0 ? <EmptyState message="no agent models available" /> : null}
      </div>

      <div className="task-actions">
        <Button variant="primary" disabled={!editable || !chosen || busy !== ""} onClick={start}>START</Button>
        {fullBrief.length > SUBTASK_THRESHOLD ? (
          <Button disabled={!editable || busy !== ""} onClick={decompose}>BREAK INTO SUBTASKS</Button>
        ) : null}
      </div>

      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      {note ? <StatusLine>{note}</StatusLine> : null}
    </div>
  );
}

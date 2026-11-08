import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSession, ModelInfo, OptimizerSetting, ProviderAccount } from "../../src/contracts";
import { Button, Select, StatusLine, friendlyError, getBridge, modelLabel } from "../shared";
import type { BridgeClient } from "../shared";

// The agent view's empty state is a composer, laid out like an editor's chat side bar: one bordered box at the top
// with the brief and, along its bottom edge, the model picker (left) and START (right), then a one-line caption. The
// mark and the past sessions below it are App's. Type what the agent should do, pick a model, START. It creates a manual Task (tasks.create) and starts a session on it (agent.start); the Slack
// "Make task" flow is the other way in, not the only one.

const modelKey = (m: { provider: string; modelId: string }) => `${m.provider}/${m.modelId}`;
export const TITLE_MAX = 80;

/** The task's title is the brief's first non-empty line, cut at a word boundary past TITLE_MAX characters. */
export function titleFromBrief(brief: string): string {
  const line = brief.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${space > TITLE_MAX / 2 ? cut.slice(0, space) : cut}…`;
}

export interface ComposerProps {
  bridge?: BridgeClient;
  /** Called once the session exists; the view then shows it. */
  onStarted: (session: AgentSession) => void;
}

export function Composer({ bridge, onStarted }: ComposerProps) {
  const [brief, setBrief] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [optimizer, setOptimizer] = useState<OptimizerSetting | undefined>();
  const [selected, setSelected] = useState("");
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const starting = useRef(false);

  useEffect(() => {
    let live = true;
    setModelsError("");
    const b = bridge ?? getBridge();
    b.request("models.list", { role: "agent" })
      .then((m) => {
        if (!live) return;
        setModels(m);
        setModelsLoaded(true);
        // The first agent model is preselected so one START is enough; the line still says where the data goes.
        setSelected((cur) => (cur && m.some((x) => modelKey(x) === cur) ? cur : m[0] ? modelKey(m[0]) : ""));
      })
      .catch((e) => live && setModelsError(friendlyError(e, "models")));
    b.request("accounts.list", {})
      .then((a) => live && setAccounts(a))
      .catch(() => undefined); // labels fall back to "data use unknown" + leaves machine
    b.request("optimizer.get", {})
      .then((o) => live && setOptimizer(o))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bridge, attempt]);

  // While the optimizer state is unknown, calls might go through Prune, so labels say "unknown" + leaves machine (section 14).
  const viaPrune = optimizer === undefined || (optimizer.enabled === true && optimizer.scope === "all_roles");
  const options = useMemo(
    () => [
      { value: "", label: "SELECT MODEL" },
      ...models.map((m) => ({ value: modelKey(m), label: modelLabel(m, accounts.find((a) => a.provider === m.provider), viaPrune) })),
    ],
    [models, accounts, viaPrune],
  );
  const chosen = models.find((m) => modelKey(m) === selected);
  const text = brief.trim();
  const canStart = text.length > 0 && chosen !== undefined && !busy;

  const start = () => {
    if (!canStart || starting.current) return;
    starting.current = true;
    setBusy(true);
    setError("");
    const b = bridge ?? getBridge();
    (async () => {
      const task = await b.request("tasks.create", { title: titleFromBrief(text), brief: text });
      const session = await b.request("agent.start", { taskId: task.id, model: { provider: chosen.provider, modelId: chosen.modelId } });
      onStarted(session);
    })()
      .catch((e) => setError(friendlyError(e, "task")))
      .finally(() => {
        starting.current = false;
        setBusy(false);
      });
  };

  return (
    <div className="sv-compose" aria-label="new agent task">
      <div className="sv-compose-box">
        <textarea
          className="nx-textarea sv-compose-brief"
          aria-label="what should the agent do?"
          placeholder="what should the agent do? · enter starts, shift+enter for a new line"
          value={brief}
          disabled={busy}
          spellCheck={false}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              start();
            }
          }}
        />
        <div className="sv-compose-row">
          <Select aria-label="model" options={options} value={selected} disabled={busy || models.length === 0} onChange={(e) => setSelected(e.target.value)} />
          <Button variant="primary" size="sm" disabled={!canStart} onClick={start} kbd="⏎">{busy ? "STARTING" : "START"}</Button>
        </div>
      </div>
      <div className="sv-compose-strip">
        {modelsError ? (
          <StatusLine tone="error">
            {modelsError} <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>RETRY</Button>
          </StatusLine>
        ) : null}
        {modelsLoaded && models.length === 0 ? <StatusLine tone="pending">no agent model: run Nexus: Connect provider, then RETRY</StatusLine> : null}
        {error ? <StatusLine tone="error">{error}</StatusLine> : null}
        <div className="nx-caption">the agent works on its own branch and asks before running commands or committing</div>
      </div>
    </div>
  );
}

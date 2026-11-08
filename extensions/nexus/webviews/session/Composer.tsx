import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSession, ModelInfo, OptimizerSetting, ProviderAccount } from "../../src/contracts";
import { Button, Select, StatusLine, friendlyError, getBridge, modelLabel } from "../shared";
import type { BridgeClient } from "../shared";

// The agent view's empty state is a composer, the way an editor's chat side bar is: type what the agent should do, pick
// a model, START. It creates a manual Task (tasks.create) and starts a session on it (agent.start); the Slack
// "Make task" flow is the other way in, not the only one. The model picker here is the status bar's picker: it starts
// on the remembered choice (models.selected) and a pick here is remembered the same way (models.select).

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

export const NO_REPO = "no git repository open: use File > Open Folder on a repository, then RETRY";
export const NO_MODEL = "no agent model yet: connect Anthropic or Gemini with the command Nexus: Connect provider, then RETRY";

export interface ComposerProps {
  bridge?: BridgeClient;
  /** Called once the session exists; the view then shows it. */
  onStarted: (session: AgentSession) => void;
}

type Repo = "unknown" | "ok" | "missing";

export function Composer({ bridge, onStarted }: ComposerProps) {
  const [brief, setBrief] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [optimizer, setOptimizer] = useState<OptimizerSetting | undefined>();
  const [selected, setSelected] = useState("");
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [repo, setRepo] = useState<Repo>("unknown");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const starting = useRef(false);
  // The status bar's remembered model, once known; it wins over "the first model" until the user picks here.
  const preferred = useRef<string | undefined>(undefined);
  const userPicked = useRef(false);

  useEffect(() => {
    let live = true;
    setModelsError("");
    setRepo("unknown");
    const b = bridge ?? getBridge();
    // Default choice: what the user picked here, else the status bar's remembered model, else the first model listed.
    const settle = (list: ModelInfo[]) =>
      setSelected((cur) => {
        const has = (k: string | undefined) => !!k && list.some((x) => modelKey(x) === k);
        if (userPicked.current && has(cur)) return cur;
        if (has(preferred.current)) return preferred.current as string;
        if (has(cur)) return cur;
        return list[0] ? modelKey(list[0]) : "";
      });
    const loadModels = () =>
      b.request("models.list", { role: "agent" }).then((m) => {
        if (!live) return;
        setModels(m);
        setModelsLoaded(true);
        settle(m);
      });
    loadModels().catch((e) => live && setModelsError(friendlyError(e, "models")));
    b.request("models.selected", { role: "agent" })
      .then((sel) => {
        if (!live || !sel) return;
        preferred.current = modelKey(sel);
        setModels((cur) => {
          settle(cur);
          return cur;
        });
      })
      .catch(() => undefined); // no remembered model: the first listed one is used
    b.request("accounts.list", {})
      .then((a) => {
        if (!live) return;
        setAccounts(a);
        // accounts.list is what verifies keys on a cold host; if a provider came back connected after an empty models
        // answer, ask for the models again instead of leaving the picker empty.
        if (a.some((x) => x.status === "connected")) {
          setModels((cur) => {
            if (cur.length === 0) void loadModels().catch(() => undefined);
            return cur;
          });
        }
      })
      .catch(() => undefined); // labels fall back to "data use unknown" + leaves machine
    b.request("optimizer.get", {})
      .then((o) => live && setOptimizer(o))
      .catch(() => undefined);
    // An agent needs a repository to work in (its own worktree and branch); without one START would only fail later.
    b.request("git.branches", {})
      .then(() => live && setRepo("ok"))
      .catch(() => live && setRepo("missing"));
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
  const canStart = text.length > 0 && chosen !== undefined && !busy && repo !== "missing";

  const pick = (key: string) => {
    userPicked.current = true;
    setSelected(key);
    const m = models.find((x) => modelKey(x) === key);
    if (!m) return;
    // Remembered like a pick in the status bar, which updates to match.
    void (bridge ?? getBridge()).request("models.select", { role: "agent", provider: m.provider, modelId: m.modelId }).catch(() => undefined);
  };

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

  const retry = <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>RETRY</Button>;

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
          <Select aria-label="model" options={options} value={selected} disabled={busy || models.length === 0} onChange={(e) => pick(e.target.value)} />
          <Button variant="primary" size="sm" disabled={!canStart} onClick={start} kbd="⏎">{busy ? "STARTING" : "START"}</Button>
        </div>
      </div>
      <div className="sv-compose-strip">
        {modelsError ? <StatusLine tone="error">{modelsError} {retry}</StatusLine> : null}
        {modelsLoaded && models.length === 0 ? <StatusLine tone="pending">{NO_MODEL} {retry}</StatusLine> : null}
        {repo === "missing" ? <StatusLine tone="pending">{NO_REPO} {retry}</StatusLine> : null}
        {error ? <StatusLine tone="error">{error}</StatusLine> : null}
        <div className="nx-caption">the agent works on its own branch and asks before running commands or committing</div>
      </div>
    </div>
  );
}

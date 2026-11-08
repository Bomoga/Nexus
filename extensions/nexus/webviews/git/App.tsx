// Git view (design-night §5.5): BRANCHES, AGENT BRANCHES (merge with an inline confirm), RECENT COMMITS (last 24 h).
// Everything is served by the bridge; the view never touches git itself. Repo text (branch names, commit subjects) is
// untrusted and rendered as text only.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { NexusEvent } from "../../src/contracts";
import { Badge, Chip, Confirm, EmptyState, Region, StatusLine, StoreStatusLine, Table, friendlyError, getBridge } from "../shared";
import type { BridgeClient, Tone } from "../shared";
import { formatEventTime } from "../globe/model/picking";

export interface Branch {
  name: string;
  head: string;
  isCurrent: boolean;
  isAgent: boolean;
}

const AGENT_BRANCH = /^nexus\/agent-(?<id>[A-Za-z0-9_-]{1,128})$/;

/** The session id an agent branch belongs to ("nexus/agent-<id>"), or undefined for any other branch. */
export function sessionIdOf(branch: string): string | undefined {
  return AGENT_BRANCH.exec(branch)?.groups?.id;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const short = (sha: string) => sha.slice(0, 7);

interface MergeState {
  tone: Tone;
  text: string;
}

export function App({ bridge, now = Date.now() }: { bridge?: BridgeClient; now?: number }) {
  const b = useMemo(() => bridge ?? getBridge(), [bridge]);
  const [branches, setBranches] = useState<readonly Branch[] | undefined>();
  const [branchesError, setBranchesError] = useState<string | undefined>();
  const [commits, setCommits] = useState<readonly NexusEvent[] | undefined>();
  const [commitsError, setCommitsError] = useState<string | undefined>();
  const [merge, setMerge] = useState<Record<string, MergeState>>({});
  const [busy, setBusy] = useState<string | undefined>();

  const loadBranches = useCallback(() => {
    setBranchesError(undefined);
    b.request("git.branches", {}).then(setBranches, (e) => setBranchesError(friendlyError(e, "branches")));
  }, [b]);

  const loadCommits = useCallback(() => {
    setCommitsError(undefined);
    b.request("events.query", { from: new Date(now - DAY_MS).toISOString(), to: new Date(now + 60_000).toISOString(), kinds: ["commit", "merge"], limit: 200 }).then(
      (events) => setCommits([...events].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0))),
      (e) => setCommitsError(friendlyError(e, "recent commits")),
    );
  }, [b, now]);

  useEffect(() => {
    loadBranches();
    loadCommits();
  }, [loadBranches, loadCommits]);

  const doMerge = async (branch: Branch) => {
    const sessionId = sessionIdOf(branch.name);
    if (!sessionId) return;
    setBusy(branch.name);
    try {
      const r = await b.request("git.mergeAgentBranch", { sessionId });
      setMerge((m) => ({ ...m, [branch.name]: r.ok ? { tone: "ok", text: r.mergeSha ? `merged as ${short(r.mergeSha)}` : r.message } : { tone: "error", text: r.message } }));
      loadBranches();
      loadCommits();
    } catch (e) {
      setMerge((m) => ({ ...m, [branch.name]: { tone: "error", text: friendlyError(e, "merge") } }));
    } finally {
      setBusy(undefined);
    }
  };

  const plain = branches?.filter((x) => !x.isAgent) ?? [];
  const agents = branches?.filter((x) => x.isAgent) ?? [];
  const nameCell = (row: Branch) => (
    <span className="git-branch-name" title={row.name}>
      <span className="nx-data">{row.name}</span>
      {row.isCurrent ? <Badge kind="accent" dot={false}>CURRENT</Badge> : null}
    </span>
  );

  return (
    <div className="git-app">
      <Region header={{ title: "Branches", count: branches?.length }} flush aria-label="branches">
        {branchesError ? (
          <StatusLine tone="error">
            {branchesError}
            <button type="button" className="nx-button nx-button--sm" onClick={loadBranches}>
              RETRY
            </button>
          </StatusLine>
        ) : branches === undefined ? (
          <StatusLine>… loading</StatusLine>
        ) : plain.length === 0 ? (
          <EmptyState message="no branches" />
        ) : (
          <Table
            aria-label="branches"
            columns={[
              { key: "name", header: "BRANCH", render: nameCell, truncate: true, title: (r) => r.name },
              { key: "head", header: "HEAD", mono: true, render: (r) => short(r.head) },
            ]}
            rows={plain}
            rowKey={(r) => r.name}
          />
        )}
      </Region>
      <Region header={{ title: "Agent branches", count: branches ? agents.length : undefined }} flush aria-label="agent branches">
        {branches !== undefined && !branchesError ? (
          agents.length === 0 ? (
            <EmptyState message="no agent branches · a session creates nexus/agent-<id>" />
          ) : (
            <>
              <Table
                aria-label="agent branches"
                columns={[
                  {
                    key: "name",
                    header: "BRANCH",
                    truncate: true,
                    title: (r) => r.name,
                    render: (r) => (
                      <span className="git-branch-name" title={r.name}>
                        <span className="nx-data">{r.name}</span>
                        <Chip kind="accent">AGENT</Chip>
                      </span>
                    ),
                  },
                  { key: "head", header: "HEAD", mono: true, render: (r) => short(r.head) },
                  {
                    key: "merge",
                    header: "",
                    align: "right",
                    render: (r) => <Confirm label="MERGE" size="sm" disabled={busy !== undefined || !sessionIdOf(r.name)} onConfirm={() => void doMerge(r)} />,
                  },
                ]}
                rows={agents}
                rowKey={(r) => r.name}
              />
              {agents.map((r) => {
                const m = merge[r.name];
                return m ? (
                  <StatusLine key={r.name} tone={m.tone}>
                    <span className="nx-data">{r.name}</span> · {m.text}
                  </StatusLine>
                ) : null;
              })}
            </>
          )
        ) : null}
      </Region>
      <Region header={{ title: "Recent commits", count: commits?.length }} flush fill aria-label="recent commits" footer={<StoreStatusLine bridge={bridge} />}>
        {commitsError ? (
          <StatusLine tone="error">
            {commitsError}
            <button type="button" className="nx-button nx-button--sm" onClick={loadCommits}>
              RETRY
            </button>
          </StatusLine>
        ) : commits === undefined ? (
          <StatusLine>… loading</StatusLine>
        ) : commits.length === 0 ? (
          <EmptyState message="no commits in the last 24 h" />
        ) : (
          <div role="list" aria-label="commits in the last 24 hours">
            {commits.map((e) => {
              const sha = e.target.type === "commit" ? short(e.target.sha) : "";
              const open = () => void b.request("ui.openTarget", e.target).catch(() => undefined);
              return (
                <div
                  key={e.id}
                  role="listitem"
                  tabIndex={0}
                  className="git-commit-row"
                  title={e.title}
                  onClick={open}
                  onKeyDown={(k) => {
                    if (k.key === "Enter" || k.key === " ") {
                      k.preventDefault();
                      open();
                    }
                  }}
                >
                  <span className="nx-data nx-tone-muted">{formatEventTime(Date.parse(e.at))}</span>
                  <span className="nx-data">{sha || <span className="git-commit-kind">{e.kind}</span>}</span>
                  <span className="git-commit-title">{e.title}</span>
                  <span className="git-commit-actor">{e.actor.name}</span>
                </div>
              );
            })}
          </div>
        )}
      </Region>
    </div>
  );
}

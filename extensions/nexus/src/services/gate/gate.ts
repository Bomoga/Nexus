// The agent gate (PLAN 5.2 L2-13). Every tool request from an agent session passes through here: paths are confined to the
// session worktree, commands run without a shell, and anything risky waits for a human with no timeout.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants as osc } from "node:os";
import type { AgentSession } from "../../contracts";
import type { GitService } from "../git/types";
import { isAllowlisted, splitCommand, tail } from "./commands";
import { listTree, readCapped, resolveIn, writeFileAt } from "./fs";
import type { ApprovalsHook, Gate, GateRequest, GateRequestName, GateResponse } from "./types";

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface GateDeps {
  git: GitService;
  approvals: ApprovalsHook;
  /** nexus.agent.allowedCommands: read on every request so a setting change applies at once. */
  allowlist: () => string[];
  /** Applied to everything that leaves the gate toward a model, a card or a log. Production passes shared/redact. */
  redact: (text: string) => string;
  /** Test seam; defaults to child_process.spawn. */
  spawn?: SpawnFn;
}

export const OUTPUT_TAIL_CHARS = 8000;
const MAX_CAPTURE_CHARS = 64_000;

export function createGate(deps: GateDeps): Gate {
  const spawn: SpawnFn = deps.spawn ?? nodeSpawn;

  async function ask(session: AgentSession, action: Parameters<ApprovalsHook["create"]>[0]["action"], reason: string, diffPreview?: string) {
    const outcome = await deps.approvals.create({ session, action, reason, ...(diffPreview === undefined ? {} : { diffPreview }) });
    if (outcome.decision !== "approved") throw new Error(`rejected by a human: ${action.kind}`);
    return outcome.approvalId;
  }

  async function run(session: AgentSession, argv: string[], timeoutMs: number): Promise<{ exitCode: number; stdoutTail: string; stderrTail: string }> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME"]) if (process.env[key] !== undefined) env[key] = process.env[key];
    return new Promise(resolve => {
      let out = "", err = "", done = false;
      const finish = (exitCode: number) => {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve({ exitCode, stdoutTail: tail(deps.redact(out), OUTPUT_TAIL_CHARS), stderrTail: tail(deps.redact(err), OUTPUT_TAIL_CHARS) });
      };
      let child: ChildProcess;
      try { child = spawn(argv[0]!, argv.slice(1), { cwd: session.worktreePath, env, shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { err = String((e as Error).message); finish(127); return; }
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
      const keep = (cur: string, chunk: Buffer | string) => (cur + chunk.toString()).slice(-MAX_CAPTURE_CHARS);
      child.stdout?.on("data", c => { out = keep(out, c); });
      child.stderr?.on("data", c => { err = keep(err, c); });
      child.on("error", e => { err = keep(err, String(e.message)); finish(127); });
      child.on("close", (code, signal) => {
        const signum = signal ? osc.signals[signal] : undefined;
        finish(Number.isInteger(code) ? (code as number) : signum ? 128 + signum : -1);
      });
    });
  }

  const handlers = {
    "fs.read": async (session: AgentSession, body: GateRequest<"fs.read">): Promise<GateResponse<"fs.read">> => {
      const r = await resolveIn(session.worktreePath, body.path);
      if (!r.inside) throw new Error("path is outside the session worktree");
      return readCapped(r.target);
    },
    "fs.list": async (session: AgentSession, body: GateRequest<"fs.list">): Promise<GateResponse<"fs.list">> => {
      const r = await resolveIn(session.worktreePath, body.path);
      if (!r.inside) throw new Error("path is outside the session worktree");
      return { entries: await listTree(r.root, r.target, Math.max(1, Math.min(body.depth, 4))) };
    },
    "fs.write": async (session: AgentSession, body: GateRequest<"fs.write">): Promise<GateResponse<"fs.write">> => {
      const r = await resolveIn(session.worktreePath, body.path);
      // The human sees the real destination, not the model's spelling of it.
      if (!r.inside) await ask(session, { kind: "write_outside_scope", path: r.target }, "The agent wants to write a file outside its worktree.");
      return { bytes: await writeFileAt(r.target, body.content) };
    },
    "git.diff": async (session: AgentSession): Promise<GateResponse<"git.diff">> => ({
      diff: deps.redact(await deps.git.diff(session.worktreePath, session.baseCommit)),
    }),
    "cmd.run": async (session: AgentSession, body: GateRequest<"cmd.run">): Promise<GateResponse<"cmd.run">> => {
      const argv = splitCommand(body.command);
      let approvalId: string | undefined;
      if (!isAllowlisted(argv, deps.allowlist())) approvalId = await ask(session, { kind: "run_command", command: body.command }, "The agent wants to run a command that is not on the allowlist.");
      return { ...(await run(session, argv, body.timeoutMs)), ...(approvalId === undefined ? {} : { approvalId }) };
    },
    "git.commit": async (session: AgentSession, body: GateRequest<"git.commit">): Promise<GateResponse<"git.commit">> => {
      const diffPreview = deps.redact(await deps.git.diff(session.worktreePath, session.baseCommit));
      const approvalId = await ask(session, { kind: "commit", message: body.message }, "The agent wants to commit its changes.", diffPreview);
      return { sha: await deps.git.commitIn(session.worktreePath, body.message, session.id), approvalId };
    },
  };

  return {
    async request<K extends GateRequestName>(session: AgentSession, name: K, body: GateRequest<K>): Promise<GateResponse<K>> {
      const handler = handlers[name] as unknown as (s: AgentSession, b: GateRequest<K>) => Promise<GateResponse<K>>;
      if (!handler) throw new Error(`unknown gate request ${name}`);
      return handler(session, body);
    },
  };
}

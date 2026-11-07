// The agent gate (PLAN 5.2 L2-13). Every tool request from an agent session passes through here: paths are confined to the
// session worktree, commands run without a shell, and anything risky waits for a human with no timeout.
import { existsSync } from "node:fs";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants as osc } from "node:os";
import type { AgentSession } from "../../contracts";
import type { GitService } from "../git/types";
import { binaryPathsInDiff } from "../git/worktrees";
import { absolutePath, isAllowlisted, isGitBinary, splitCommand, tail, trimCutStart, trimCutEnd, windowsPlan } from "./commands";
import { listTree, readCapped, resolveIn, writeFileAt } from "./fs";
import type { ApprovalsHook, Gate, GateRequest, GateRequestName, GateResponse } from "./types";

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface GateDeps {
  git: GitService;
  approvals: ApprovalsHook;
  /** nexus.agent.allowedCommands: read on every request so a setting change applies at once. */
  allowlist: () => string[];
  /** Applied to everything that leaves the gate toward a model, an approval card or a log: file reads, command output, diffs. Production passes shared/redact. */
  redact: (text: string) => string;
  /** Test seams. */
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (file: string) => boolean;
  /** How long to wait for taskkill before giving up on it (Windows). Default 3000. */
  taskkillTimeoutMs?: number;
}

export const OUTPUT_TAIL_CHARS = 8000;
const MAX_CAPTURE_CHARS = 64_000;
const DRAIN_MS = 50;
const TASKKILL_MS = 3000;
const WRITE_PREVIEW_CHARS = 4000;

export function createGate(deps: GateDeps): Gate {
  const spawn: SpawnFn = deps.spawn ?? nodeSpawn;
  const platform = deps.platform ?? process.platform;
  const hostEnv = deps.env ?? process.env;
  const win = platform === "win32";

  async function ask(session: AgentSession, action: Parameters<ApprovalsHook["create"]>[0]["action"], reason: string, diffPreview?: string) {
    const outcome = await deps.approvals.create({ session, action, reason, ...(diffPreview === undefined ? {} : { diffPreview }) });
    if (outcome.decision !== "approved") throw new Error(`rejected by a human: ${action.kind}`);
    return outcome.approvalId;
  }

  /**
   * Kills the child and everything it started: the process group on POSIX (synchronous), taskkill /T on Windows. The returned promise
   * settles once taskkill has exited, or after TASKKILL_MS if it hangs, so a run is never reported while its tree is still dying.
   * Known limit: a descendant that calls setsid() leaves the group and survives; that needs an allowlisted or approved command.
   */
  function killTree(child: ChildProcess): Promise<void> {
    if (child.pid === undefined) return Promise.resolve();
    if (win) {
      return new Promise<void>(resolve => {
        let killer: ChildProcess | undefined;
        const end = () => { clearTimeout(limit); resolve(); };
        const limit = setTimeout(() => { try { killer?.kill(); } catch { /* best effort */ } resolve(); }, deps.taskkillTimeoutMs ?? TASKKILL_MS);
        try {
          killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          killer.on("error", end);
          killer.on("exit", end);
        } catch { end(); }
      });
    }
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    return Promise.resolve();
  }

  function childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { PATH: absolutePath(hostEnv.PATH ?? hostEnv.Path, platform) };
    const keys = win ? ["HOME", "SystemRoot", "PATHEXT", "ComSpec"] : ["HOME"];
    for (const key of keys) if (hostEnv[key] !== undefined) env[key] = hostEnv[key];
    return env;
  }

  async function run(session: AgentSession, argv: string[], timeoutMs: number): Promise<{ exitCode: number; stdoutTail: string; stderrTail: string }> {
    const env = childEnv();
    const plan = win ? windowsPlan(argv, env, deps.fileExists ?? existsSync) : { file: argv[0]!, args: argv.slice(1), verbatim: false };
    return new Promise(resolve => {
      let out = "", err = "", done = false, exitCode: number | undefined, drain: NodeJS.Timeout | undefined, force: NodeJS.Timeout | undefined;
      let child: ChildProcess | undefined, killing: Promise<void> = Promise.resolve();
      const kill = (c: ChildProcess) => { killing = Promise.all([killing, killTree(c)]).then(() => undefined); };
      const finish = (code: number) => {
        if (done) return;
        done = true; clearTimeout(timer); clearTimeout(drain); clearTimeout(force);
        if (child) { child.stdout?.destroy(); child.stderr?.destroy(); }
        // Not reported until a kill in progress has completed.
        void killing.then(() => resolve({ exitCode: code, stdoutTail: tail(deps.redact(out), OUTPUT_TAIL_CHARS), stderrTail: tail(deps.redact(err), OUTPUT_TAIL_CHARS) }));
      };
      // A timeout kills the tree. If the child is still not gone once the kill has settled (taskkill failed or hit its cap on
      // Windows), stop waiting for it after a short grace and report it as killed, so the agent never waits forever.
      const timer = setTimeout(() => {
        if (!child) return;
        const c = child;
        kill(c);
        void killing.then(() => {
          if (done) return;
          force = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* best effort */ } finish(exitCode ?? (win ? 1 : 137)); }, DRAIN_MS);
        });
      }, timeoutMs);
      try {
        child = spawn(plan.file, plan.args, { cwd: session.worktreePath, env, shell: false, detached: !win, windowsHide: true, windowsVerbatimArguments: plan.verbatim, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) { err = String((e as Error).message); finish(127); return; }
      const c = child;
      // When the capture window overflows, drop the cut-off first line so a secret cut in half is not returned unredacted.
      const keep = (cur: string, chunk: Buffer | string) => {
        const next = cur + chunk.toString();
        if (next.length <= MAX_CAPTURE_CHARS) return next;
        return trimCutStart(next.slice(next.length - MAX_CAPTURE_CHARS));
      };
      c.stdout?.on("data", d => { out = keep(out, d); });
      c.stderr?.on("data", d => { err = keep(err, d); });
      c.on("error", e => { err = keep(err, String(e.message)); finish(127); });
      c.on("exit", (code, signal) => {
        if (done) return;
        const signum = signal ? osc.signals[signal] : undefined;
        exitCode = typeof code === "number" ? code : signum ? 128 + signum : -1;
        // Streams normally close right after exit. If a grandchild still holds them, give a short drain, then kill the tree and stop waiting.
        drain = setTimeout(() => { kill(c); finish(exitCode!); }, DRAIN_MS);
      });
      c.on("close", () => finish(exitCode ?? -1));
    });
  }

  const handlers = {
    "fs.read": async (session: AgentSession, body: GateRequest<"fs.read">): Promise<GateResponse<"fs.read">> => {
      const r = await resolveIn(session.worktreePath, body.path);
      if (!r.inside) throw new Error("path is outside the session worktree");
      const { content, truncated } = await readCapped(r.target);
      return { content: deps.redact(truncated ? trimCutEnd(content) : content), truncated };
    },
    "fs.list": async (session: AgentSession, body: GateRequest<"fs.list">): Promise<GateResponse<"fs.list">> => {
      const r = await resolveIn(session.worktreePath, body.path);
      if (!r.inside) throw new Error("path is outside the session worktree");
      return { entries: await listTree(r.root, r.target, Math.max(1, Math.min(body.depth, 4))) };
    },
    "fs.write": async (session: AgentSession, body: GateRequest<"fs.write">): Promise<GateResponse<"fs.write">> => {
      const r = await resolveIn(session.worktreePath, body.path);
      // The human sees the real destination, not the model's spelling of it.
      if (!r.inside) {
        const preview = deps.redact(body.content);
        await ask(session, { kind: "write_outside_scope", path: r.target }, "The agent wants to write a file outside its worktree.",
          preview.length > WRITE_PREVIEW_CHARS ? `${preview.slice(0, WRITE_PREVIEW_CHARS)}\n[... ${preview.length - WRITE_PREVIEW_CHARS} more chars]` : preview);
      }
      return { bytes: await writeFileAt(r.target, body.content) };
    },
    "git.diff": async (session: AgentSession): Promise<GateResponse<"git.diff">> => ({
      diff: deps.redact(await deps.git.diff(session.worktreePath, session.baseCommit)),
    }),
    "cmd.run": async (session: AgentSession, body: GateRequest<"cmd.run">): Promise<GateResponse<"cmd.run">> => {
      const argv = splitCommand(body.command);
      if (isGitBinary(argv[0]!)) throw new Error("the agent does not run git; commits go through git.commit");
      let approvalId: string | undefined;
      if (!isAllowlisted(argv, deps.allowlist())) approvalId = await ask(session, { kind: "run_command", command: body.command }, "The agent wants to run a command that is not on the allowlist.");
      return { ...(await run(session, argv, body.timeoutMs)), ...(approvalId === undefined ? {} : { approvalId }) };
    },
    "git.commit": async (session: AgentSession, body: GateRequest<"git.commit">): Promise<GateResponse<"git.commit">> => {
      const before = await deps.git.diff(session.worktreePath, session.baseCommit);
      const binary = binaryPathsInDiff(before);
      const preview = deps.redact(before) + (binary.length ? `\nbinary files: ${deps.redact(binary.join(", "))}\n` : "");
      const approvalId = await ask(session, { kind: "commit", message: body.message }, "The agent wants to commit its changes.", preview);
      // The human approved this diff: commit only if it is still the diff.
      if ((await deps.git.diff(session.worktreePath, session.baseCommit)) !== before) throw new Error("the worktree changed during approval; the commit was refused");
      return { sha: await deps.git.commitIn(session.worktreePath, body.message, session.id, before), approvalId };
    },
  };

  return {
    async request<K extends GateRequestName>(session: AgentSession, name: K, body: GateRequest<K>): Promise<GateResponse<K>> {
      if (!Object.hasOwn(handlers, name)) throw new Error(`unknown gate request ${String(name)}`);
      const handler = handlers[name] as unknown as (s: AgentSession, b: GateRequest<K>) => Promise<GateResponse<K>>;
      return handler(session, body);
    },
  };
}

import { z } from "zod";
import type { AgentReqIn, AgentResOut } from "./channel";
import type { AgentRequestName } from "../contracts";
import type { ToolDef } from "../models/provider";

// The tools the model sees, and how each maps onto a gate request (PLAN L1-09). The agent process never touches
// files, commands or git itself: every tool is a request to the host's gate (CLAUDE.md §14).

/** What the runtime needs from the host side. AgentChannel satisfies it; FakeGate implements it for tests. */
export interface Gate {
  request<K extends AgentRequestName>(name: K, body: AgentReqIn<K>): Promise<AgentResOut<K>>;
}

export const MAX_TOOL_RESULT_BYTES = 32 * 1024;

export function truncateResult(text: string, max = MAX_TOOL_RESULT_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  // Cut on a character boundary: decoding a partial multi-byte tail yields U+FFFD, which we drop.
  const cut = buf.subarray(0, max).toString("utf8").replace(/�+$/, "");
  return `${cut}\n[truncated: ${buf.length - Buffer.byteLength(cut, "utf8")} more bytes]`;
}

interface Tool {
  def: ToolDef;
  args: z.ZodType;
  run(gate: Gate, args: never): Promise<string>;
}

const pathArg = z.string().min(1);

function tool<S extends z.ZodType>(def: ToolDef, args: S, run: (gate: Gate, a: z.output<S>) => Promise<string>): Tool {
  return { def, args, run: run as Tool["run"] };
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export const TOOLS: Record<string, Tool> = {
  read_file: tool(
    { name: "read_file", description: "Read a text file inside the session worktree.", inputSchema: obj({ path: { type: "string", description: "Path relative to the worktree" } }, ["path"]) },
    z.object({ path: pathArg }).strict(),
    async (gate, a) => {
      const r = await gate.request("fs.read", { path: a.path });
      return r.truncated ? `${r.content}\n[file truncated by the host]` : r.content;
    },
  ),
  write_file: tool(
    { name: "write_file", description: "Create or overwrite a file inside the session worktree with the full new content.", inputSchema: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]) },
    z.object({ path: pathArg, content: z.string() }).strict(),
    async (gate, a) => `wrote ${(await gate.request("fs.write", { path: a.path, content: a.content })).bytes} bytes to ${a.path}`,
  ),
  list_files: tool(
    { name: "list_files", description: "List files under a directory of the worktree.", inputSchema: obj({ path: { type: "string" }, depth: { type: "integer", minimum: 1, maximum: 4 } }) },
    z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(4).optional() }).strict(),
    async (gate, a) => (await gate.request("fs.list", { path: a.path ?? ".", depth: a.depth ?? 2 })).entries.join("\n"),
  ),
  run_command: tool(
    { name: "run_command", description: "Run a shell command in the worktree. Commands not on the allowlist wait for a human to approve.", inputSchema: obj({ command: { type: "string" }, timeoutMs: { type: "integer", maximum: 300000 } }, ["command"]) },
    z.object({ command: z.string().min(1), timeoutMs: z.number().int().max(300000).optional() }).strict(),
    async (gate, a) => {
      const r = await gate.request("cmd.run", { command: a.command, timeoutMs: a.timeoutMs ?? 120000 });
      return [`exit code: ${r.exitCode}`, r.stdoutTail && `stdout:\n${r.stdoutTail}`, r.stderrTail && `stderr:\n${r.stderrTail}`].filter(Boolean).join("\n");
    },
  ),
  get_diff: tool(
    { name: "get_diff", description: "Show the current uncommitted changes (git diff) of the worktree.", inputSchema: obj({}) },
    z.object({}).strict(),
    async gate => (await gate.request("git.diff", {})).diff || "(no changes)",
  ),
  commit: tool(
    { name: "commit", description: "Commit the current changes on the session branch. A human must approve; this waits for them.", inputSchema: obj({ message: { type: "string" } }, ["message"]) },
    z.object({ message: z.string().min(1) }).strict(),
    async (gate, a) => `committed ${(await gate.request("git.commit", { message: a.message })).sha}`,
  ),
  post_progress: tool(
    { name: "post_progress", description: "Update the single progress message in the Slack thread for this task.", inputSchema: obj({ text: { type: "string" } }, ["text"]) },
    z.object({ text: z.string().min(1) }).strict(),
    async (gate, a) => ((await gate.request("slack.progress", { text: a.text })).ok ? "progress updated" : "progress update failed"),
  ),
  ask_approval: tool(
    { name: "ask_approval", description: "Ask a human to approve something not covered by the other tools. Waits for the answer.", inputSchema: obj({ description: { type: "string" }, reason: { type: "string" } }, ["description", "reason"]) },
    z.object({ description: z.string().min(1), reason: z.string().min(1) }).strict(),
    async (gate, a) => `human decision: ${(await gate.request("approval.request", { kind: "other", description: a.description, reason: a.reason })).decision}`,
  ),
};

export const TOOL_DEFS: ToolDef[] = Object.values(TOOLS).map(t => t.def);

export interface ToolOutcome {
  ok: boolean;
  /** Text fed back to the model (already truncated, not yet framed). */
  content: string;
}

/** Validates the model's arguments, runs the tool through the gate, and never throws: errors become tool results. */
export async function executeTool(gate: Gate, name: string, rawArgs: unknown): Promise<ToolOutcome> {
  const t = TOOLS[name];
  if (!t) return { ok: false, content: `unknown tool "${name}"` };
  const parsed = t.args.safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, content: `invalid arguments for ${name}: ${parsed.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
  try {
    return { ok: true, content: truncateResult(await t.run(gate, parsed.data as never)) };
  } catch (e) {
    return { ok: false, content: truncateResult(e instanceof Error ? e.message : "tool failed") };
  }
}

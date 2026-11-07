// Scripted, deterministic streams (PLAN §2.12) so the globe and session views can be tested at any size.
import type { NexusEvent } from "../events";
import type { AgentEvent } from "../tasks";
import type { ModelCallReceipt } from "../prune";
import { MACHINE_ID, T0, WORKSPACE_ID } from "./index";

const HOUR = 3_600_000;
const ORBITS = ["main", "lane-1", "lane-2", "feature/checkout"] as const;
const ORBIT_START_H: Record<(typeof ORBITS)[number], number> = { "main": 0, "lane-1": 0.5, "lane-2": 1, "feature/checkout": 3 };
const MERGES: { hour: number; from: (typeof ORBITS)[number] }[] = [
  { hour: 6, from: "lane-1" }, { hour: 12, from: "lane-2" }, { hour: 18, from: "feature/checkout" },
  { hour: 24, from: "lane-1" }, { hour: 30, from: "lane-2" },
];
const SESSIONS = [ { hour: 8, orbit: "lane-1", id: "ses_01" }, { hour: 16, orbit: "lane-2", id: "ses_02" }, { hour: 26, orbit: "lane-1", id: "ses_03" } ];
const SLACK_TASKS = [ { hour: 7.5, orbit: "lane-1", threadTs: "1762485300.000100" }, { hour: 15.5, orbit: "lane-2", threadTs: "1762514100.000300" } ];
const HUMANS = ["Adrian", "Brandon", "Elkin"];
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// mulberry32: small seeded PRNG, identical output on every machine.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha = (rand: () => number) => Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");

// Deterministic ULID: 10 chars of time, 16 chars from the PRNG.
function ulid(ms: number, rand: () => number): string {
  let time = "";
  for (let i = 0, t = ms; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  return time + Array.from({ length: 16 }, () => CROCKFORD[Math.floor(rand() * 32)]).join("");
}

export function scriptedNexusEvents(opts = { hours: 36, perHour: 4, seed: 7 }): NexusEvent[] {
  const rand = prng(opts.seed);
  const start = Date.parse(T0);
  const iso = (h: number) => new Date(start + h * HOUR).toISOString();
  const base = { workspaceId: WORKSPACE_ID, machineId: MACHINE_ID };
  const human = () => ({ name: HUMANS[Math.floor(rand() * HUMANS.length)], kind: "human" as const });
  const git = (kind: "commit" | "merge" | "branch" | "tag", h: number, orbit: string, title: string, extra: Partial<NexusEvent> = {}): NexusEvent => {
    const s = sha(rand);
    return { id: `${WORKSPACE_ID}:${kind}:${s}`, kind, at: iso(h), orbit, title, actor: human(), target: { type: "commit", sha: s }, ...base, ...extra };
  };

  const out: NexusEvent[] = [];
  for (const orbit of ORBITS) {
    if (ORBIT_START_H[orbit] < opts.hours) out.push(git("branch", ORBIT_START_H[orbit], orbit, `create ${orbit}`));
  }
  const step = 1 / opts.perHour;
  for (let h = step / 2, n = 1; h < opts.hours; h += step, n++) {
    const live = ORBITS.filter(o => ORBIT_START_H[o] <= h);
    const orbit = live[Math.floor(rand() * live.length)];
    const jitter = (rand() - 0.5) * step * 0.5;
    out.push(git("commit", h + jitter, orbit, `${orbit}: change ${n}`));
  }
  for (const m of MERGES) {
    if (m.hour < opts.hours) out.push(git("merge", m.hour, "main", `merge ${m.from} into main`, { fromOrbit: m.from }));
  }
  if (24 < opts.hours) out.push(git("tag", 24, "main", "cp-2"));
  for (const s of SESSIONS) {
    if (s.hour >= opts.hours) continue;
    const ms = start + s.hour * HOUR;
    out.push({ id: ulid(ms, rand), kind: "agent_session", at: iso(s.hour), orbit: s.orbit, title: `agent session ${s.id}`, actor: { name: "Nexus agent", kind: "agent" }, target: { type: "session", sessionId: s.id }, ...base });
  }
  for (const t of SLACK_TASKS) {
    if (t.hour >= opts.hours) continue;
    const ms = start + t.hour * HOUR;
    out.push({ id: ulid(ms, rand), kind: "slack_task", at: iso(t.hour), orbit: t.orbit, title: "task from #nexus-demo thread", actor: human(), target: { type: "thread", channelId: "C_DEMO", threadTs: t.threadTs }, ...base });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

const S = "ses_01";
const COMMIT_SHA = "9d4e1b7c2a5f8e3d6c0b9a8f7e6d5c4b3a2f1e0d";
const at = (seq: number) => new Date(Date.parse(T0) + seq * 20_000).toISOString();
const DIFF = "--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -42,7 +42,7 @@\n-  return price * qty - discount;\n+  return (price - discount) * qty;";

export const scriptedAgentEvents: AgentEvent[] = [
  { type: "status", status: "running" },
  { type: "message", text: "Reading src/cart.ts" },
  { type: "tool_call", tool: "fs.read", args: { path: "src/cart.ts" } },
  { type: "tool_result", tool: "fs.read", ok: true, summary: "read 96 lines" },
  { type: "tool_call", tool: "fs.write", args: { path: "src/cart.ts", content: "<edited file>" } },
  { type: "tool_result", tool: "fs.write", ok: true, summary: "wrote 1 file" },
  { type: "file_edit", path: "src/cart.ts", diff: DIFF },
  { type: "tool_call", tool: "cmd.run", args: { command: "npm test" } },
  { type: "approval_request", approvalId: "apr_01" },
  { type: "approval_resolved", approvalId: "apr_01", decision: "approved" },
  { type: "test_output", command: "npm test", exitCode: 0, tail: "Tests  12 passed (12)" },
  { type: "tool_call", tool: "git.commit", args: { message: "fix cart discount for qty > 1" } },
  { type: "approval_request", approvalId: "apr_02" },
  { type: "approval_resolved", approvalId: "apr_02", decision: "approved" },
  { type: "commit", sha: COMMIT_SHA },
  { type: "status", status: "done" },
].map((e, seq) => ({ sessionId: S, seq, at: at(seq), ...e }) as AgentEvent);

export const scriptedReceipts: ModelCallReceipt[] = [
  { callId: "call_01", sessionId: S, role: "brief", requestedModel: "claude-sonnet-4-5", servedModel: "claude-sonnet-4-5", costUsd: 0.0042, baselineCostUsd: 0.0071, optimizations: ["prompt_trimmed", "output_cap"], pruneReceiptId: "rcpt_fixture_01", at: at(0) },
  { callId: "call_02", sessionId: S, role: "agent", requestedModel: "claude-sonnet-4-5", servedModel: "claude-sonnet-4-5", costUsd: 0.0110, baselineCostUsd: 0.0150, optimizations: ["prompt_trimmed"], pruneReceiptId: "rcpt_fixture_02", at: at(2) },
  { callId: "call_03", sessionId: S, role: "agent", requestedModel: "claude-sonnet-4-5", servedModel: "claude-sonnet-4-5", costUsd: 0.0016, baselineCostUsd: 0.0150, optimizations: ["cache_hit"], pruneReceiptId: "rcpt_fixture_03", at: at(7) },
  { callId: "call_04", sessionId: S, role: "summary", requestedModel: "claude-sonnet-4-5", servedModel: "claude-sonnet-4-5", costUsd: 0.0009, baselineCostUsd: 0.0060, optimizations: ["cache_hit", "output_cap"], pruneReceiptId: "rcpt_fixture_04", at: at(15) },
];

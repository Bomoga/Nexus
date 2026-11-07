# Nexus — docs/PLAN.md

*Produced by the planning agent from `CLAUDE.md` (the single source of truth). Nothing here changes a decision recorded there; disagreements are in section 1. Times are T+hh:mm from the official start. Every technology claim not confirmed against official docs during planning is marked **(verify)** and has a smoke-test task.*

Sections, in the order `CLAUDE.md` §2 requires:
1. Questions for the team · 2. Contracts draft · 3. Extension layout · 4. Pre-event and hour-0 checklists · 5. Per-lane task lists · 6. Wave plans · 7. Critical path · 8. Checkpoint acceptance · 9. Fallbacks · 10. Demo prep

---

## 1. Questions for the team

Only real conflicts or gaps. Each has a recommendation; the plan below assumes the recommendation unless the team says otherwise at hour 0.

**Q1. Lane 1 carries more work than its nominal worker capacity — all of it stays in the plan.**
Counting S=0.75 h, M=1.5 h, L=3 h: Lane 1 = 26 tasks / 42.75 wh, Lane 2 = 16 tasks / 32.25 wh, Lane 3 = 16 tasks / 33 wh. Nominal worker capacity ≈ 26 productive wall-hours (T+2→T+30 minus the T+22–24 window) × max concurrent workers × 0.6 utilisation: Lane 1 (Adrian, 8 GB, max 2 workers) ≈ 31 wh; Lanes 2 and 3 (if 16 GB, 3 workers) ≈ 47 wh each. The team's decision is that **every feature discussed ships in the plan** (Tier 1–3 and all four sponsor challenges), so nothing below is cut or deferred past its checkpoint.
*Recommendation (rebalance only, no cuts):* (a) move **L1-13 Slack progress message** to Lane 2, whose Slack service already owns bot posts and `chat.update` → L2-17; (b) move the **"Nexus Dark" theme JSON** (half of L1-22) to Lane 3 → L3-17; (c) Lane 2 and Lane 3 each keep ~14 wh of slack, so after cp-1 either lead may take a Lane 1 extension-side task that touches only extension code (candidates: L1-21 optimizer totals, L1-16 CIBA polling, L1-19 scheduler half) — recorded in both progress files per §12; (d) Lane 1's lead does L1-S1, L1-02 and L1-22 itself in the main checkout so both workers stay on extension tasks. With (a)+(b) Lane 1 is ~39 wh against ~31 nominal, which is covered by (c) and by the lead's own hands-on hours. The plan below is written with (a) and (b) applied **as proposals** (tasks stay listed under Lane 1 with a "proposed move" note so nothing in `CLAUDE.md` §9 is changed by me).

**Q2. Prune's gateway shape differs from §16's assumption.** `CLAUDE.md` plans "one OpenAI-compatible base URL `https://api.withprune.com/v1`". Prune's published SDK routes Anthropic to `/v1/proxy/anthropic/messages`, OpenAI to `/v1/proxy/openai/chat/completions`, and Gemini to `/v1/proxy/gemini/chat/completions`, authenticates with an `X-Prune-Key` header, passes the provider key as `user_api_key` in the body (or from Prune's vault), returns Ed25519-signed receipts verifiable against a public-key URL, and notes Anthropic **streaming bypasses Prune** [source: pypi.org/project/prune-sdk 0.3.x README]. *Recommendation:* keep §16's intent (one adapter in `src/models`), but implement it as a **per-provider proxy adapter** (`/v1/proxy/<provider>/…`), non-streaming while Prune is on, and confirm header, pinning and receipt location in smoke test L1-S4 before T+6. Contracts are unaffected.

**Q3. Does the Auth0 Guardian app (not a custom app) receive CIBA push?** Auth0's CIBA docs describe the push arriving in a mobile app that embeds the Guardian SDK [source: auth0.com CIBA docs]. `CLAUDE.md` assumes the stock Guardian app. *Recommendation:* smoke test at T+1:30 (H0-A7); if the stock app does not show the consent, approvals stay Slack + in-app (already the §17 fallback) and Auth0's story is sign-in + Token Vault.

**Q4. Which machines are 8 GB?** Assumed: Adrian's is 8 GB (confirmed in §3). Brandon's and Elkin's RAM must be written into `progress/` at hour 0; the wave plans in section 6 give both variants.

**Q5. Swarms API request shape for multi-agent runs.** The TypeScript client `swarms-ts` exists on npm ("official TypeScript library for the Swarms Client API", Apache-2.0, very low download count) but its multi-agent call signature and the REST payload for `swarm_type: "CouncilAsAJudge" | "HierarchicalSwarm"` were not confirmed from official docs during planning. *Recommendation:* plan on **plain REST** with a Zod-validated response (no SDK dependency), confirm in L1-S5 by T+5; the review council and task breakdown can be emulated with a single-agent completion if the swarm types are unavailable (fallback F-T2-3).

**Q6. Tiger Cloud `LISTEN/NOTIFY`.** Not confirmed from Tiger docs during planning (the docs confirm TimescaleDB, continuous aggregates and hypertables on Tiger Cloud; nothing seen on NOTIFY). *Recommendation:* L2-11 ships polling (2 s) as the default path and switches to NOTIFY only if H0-B6 passes.

**Q7. Where does the auth service live?** §16 says Vercel or Cloudflare Workers. *Recommendation:* Cloudflare Workers (no cold start on the free plan; one `wrangler deploy`), code under `extensions/nexus/auth-service/` so workers can edit it without leaving the extension tree.

**Q8. Slack user-token posting.** Posting "as you" needs user scope `chat:write` and reading needs user scopes `channels:history`, `channels:read`, `groups:*`, `users:read`; the live-event path needs the bot in the channel **(verify)** — only community sources were found during planning, not Slack's own scope reference. *Recommendation:* H0-A4 installs the app with the scope set in section 4 and the first smoke test is "post with xoxp appears as me".

---

## 2. Contracts draft — `extensions/nexus/src/contracts`

Expands `CLAUDE.md` §5 without changing any semantics note. Committed by Adrian at cp-0 after Brandon and Elkin review it; frozen after that. Every file is plain TypeScript + Zod; no `vscode` import anywhere under `src/contracts` (webviews and the agent process import it too).

```
src/contracts/
  index.ts            re-exports everything
  common.ts           IsoTime, Sha, Id helpers
  accounts.ts         ProviderAccount, ModelInfo
  prune.ts            OptimizerSetting, ModelCallReceipt
  coderef.ts          CodeRef, nexus:// URI codec
  chat.ts             SlackUser, Channel, ChatMessage, Thread
  tasks.ts            Task, AgentSession, AgentEvent, ApprovalRequest
  swarms.ts           SwarmReview, TaskPlan
  events.ts           NexusEvent, ActivityBucket
  protocol.ts         webview <-> extension message map (requests + subscriptions)
  agent-protocol.ts   agent process <-> extension message map
  commands.ts         the frozen nexus.* command list
  fixtures/
    index.ts          one valid example of every type
    stream.ts         scripted NexusEvent and AgentEvent streams
    scenario.ts       the demo-thread scenario (channel, thread, task, session, approval, review)
```

### 2.1 `common.ts`

```ts
import { z } from "zod";

export const IsoTime = z.string().datetime({ offset: true });          // ISO 8601 with offset or Z
export const Sha = z.string().regex(/^[0-9a-f]{40}$/, "full 40-char lowercase SHA");
export const Id = z.string().min(1);
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);     // ids are ULIDs (time-sortable)
export type IsoTime = z.infer<typeof IsoTime>;
export type Sha = z.infer<typeof Sha>;
```

### 2.2 `accounts.ts` (Lane 1)

```ts
import { z } from "zod";
import { Id } from "./common";

export const KnownProvider = z.enum(["anthropic", "google", "swarms", "openai", "ollama"]);
export const Provider = z.union([KnownProvider, z.string().min(1)]);  // open set, as §5

export const DataUse = z.enum(["not_used_for_training", "may_be_used_for_training", "unknown"]);

export const ProviderAccount = z.object({
  id: Id,
  provider: Provider,
  label: z.string(),                       // "Anthropic (API key)", "Google Gemini (API key)", "Swarms (API key)"
  status: z.enum(["connected", "invalid", "missing"]),
  dataLeavesMachine: z.boolean(),          // false only for local providers (ollama)
  dataUse: DataUse,
  // Never a key or token value. Semantics §5: status comes from a real listModels call.
}).strict();

export const ModelInfo = z.object({
  provider: Provider,
  modelId: z.string().min(1),              // exact provider model ID
  displayName: z.string(),
  supportsTools: z.boolean(),
  contextWindow: z.number().int().positive().optional(),
  // Role eligibility is derived, not stored: Swarms is never offered for role "agent" (§6 Tier 2).
}).strict();

export const ModelRole = z.enum(["agent", "brief", "summary", "approval_wording", "swarm_input"]);

export type ProviderAccount = z.infer<typeof ProviderAccount>;
export type ModelInfo = z.infer<typeof ModelInfo>;
export type ModelRole = z.infer<typeof ModelRole>;
export type DataUse = z.infer<typeof DataUse>;
```

### 2.3 `prune.ts` (Lane 1)

```ts
import { z } from "zod";
import { Id, IsoTime } from "./common";

export const OptimizerSetting = z.object({
  enabled: z.boolean(),                                  // off by default (§14)
  scope: z.enum(["text_roles", "all_roles"]),            // all_roles only once tool-calling passthrough is verified
  allowModelRouting: z.boolean(),                        // always false for role "agent"; enforced in the adapter
}).strict();
export const DEFAULT_OPTIMIZER: OptimizerSetting = { enabled: false, scope: "text_roles", allowModelRouting: false };

export const ModelCallReceipt = z.object({
  callId: Id,
  sessionId: Id.optional(),
  role: z.union([z.enum(["agent", "brief", "summary", "approval_wording", "swarm_input"]), z.string()]),
  requestedModel: z.string(),
  servedModel: z.string(),
  costUsd: z.number().nonnegative(),
  baselineCostUsd: z.number().nonnegative().optional(),
  optimizations: z.array(z.string()),                    // as reported: "cache_hit", "prompt_trimmed", "routed", "output_cap"
  pruneReceiptId: z.string(),                            // verifiable at Prune's /verify
  at: IsoTime,
}).strict();

export const SpendSummary = z.object({                   // status bar totals (derived from receipts)
  sessionId: Id.optional(),
  calls: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  savedUsd: z.number().nonnegative(),                    // sum(baseline - cost) where baseline is known
}).strict();

export type OptimizerSetting = z.infer<typeof OptimizerSetting>;
export type ModelCallReceipt = z.infer<typeof ModelCallReceipt>;
export type SpendSummary = z.infer<typeof SpendSummary>;
```

### 2.4 `coderef.ts` (Lane 2 resolves, Lane 3 renders)

```ts
import { z } from "zod";
import { Sha } from "./common";

export const CodeRef = z.object({
  workspaceId: z.string().min(1),          // stable per repo: sha1 of the root commit, set by the git service
  commit: Sha,                             // full SHA, never a branch name
  path: z.string().min(1).refine(p => !p.startsWith("/") && !p.includes(".."), "relative, no .."),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
}).strict().refine(r => r.endLine >= r.startLine, "endLine >= startLine");
export type CodeRef = z.infer<typeof CodeRef>;

// nexus://coderef/<workspaceId>/<commit>/<startLine>-<endLine>/<url-encoded path>
export const CODEREF_SCHEME = "nexus";
export function encodeCodeRef(r: CodeRef): string {
  return `${CODEREF_SCHEME}://coderef/${encodeURIComponent(r.workspaceId)}/${r.commit}/${r.startLine}-${r.endLine}/${encodeURIComponent(r.path)}`;
}
export function decodeCodeRef(uri: string): CodeRef | null {
  const m = /^nexus:\/\/coderef\/([^/]+)\/([0-9a-f]{40})\/(\d+)-(\d+)\/(.+)$/.exec(uri);
  if (!m) return null;
  const parsed = CodeRef.safeParse({ workspaceId: decodeURIComponent(m[1]), commit: m[2],
    startLine: Number(m[3]), endLine: Number(m[4]), path: decodeURIComponent(m[5]) });
  return parsed.success ? parsed.data : null;
}
// Other nexus:// routes (frozen): nexus://auth/callback?code=&state=   nexus://session/<sessionId>   nexus://approval/<approvalId>
```

### 2.5 `chat.ts` (Lane 2 serves, Lane 3 renders)

```ts
import { z } from "zod";
import { CodeRef } from "./coderef";

export const SlackUser = z.object({
  id: z.string(), name: z.string(), displayName: z.string(),
  avatarUrl: z.string().url().optional(), isBot: z.boolean(),
}).strict();

export const Channel = z.object({
  id: z.string(), name: z.string(), isPrivate: z.boolean(),
  isMember: z.boolean(), botIsMember: z.boolean(), unreadCount: z.number().int().nonnegative().optional(),
}).strict();

export const SlackTs = z.string().regex(/^\d+\.\d+$/);

export const ChatMessage = z.object({
  id: z.string(),                          // `${channelId}:${ts}`
  channelId: z.string(),
  ts: SlackTs,
  threadTs: SlackTs.optional(),
  author: z.object({ id: z.string(), name: z.string(), isBot: z.boolean() }).strict(),
  text: z.string(),                        // UNTRUSTED (§14): never executed, only quoted into prompts
  codeRefs: z.array(CodeRef),
  replyCount: z.number().int().nonnegative().optional(),
  sentVia: z.enum(["user", "bot"]),
  pending: z.boolean().optional(),
  failed: z.boolean().optional(),          // a pending send Slack rejected; UI offers retry
  blocks: z.unknown().optional(),          // raw Block Kit for agent/approval messages (rendered by Lane 3, never executed)
}).strict();

export const Thread = z.object({ channelId: z.string(), threadTs: SlackTs, messages: z.array(ChatMessage) }).strict();

export const SlackStatus = z.object({
  connected: z.boolean(),                  // Socket Mode up
  postsAs: z.object({ userId: z.string(), name: z.string() }).nullable(),   // null => would post as app (fallback warning)
  userTokenSource: z.enum(["token_vault", "manual", "none"]),
  botName: z.string(),
}).strict();

export type SlackUser = z.infer<typeof SlackUser>; export type Channel = z.infer<typeof Channel>;
export type ChatMessage = z.infer<typeof ChatMessage>; export type Thread = z.infer<typeof Thread>;
export type SlackStatus = z.infer<typeof SlackStatus>;
```

### 2.6 `tasks.ts` (Lane 1)

```ts
import { z } from "zod";
import { Id, IsoTime, Sha } from "./common";
import { CodeRef } from "./coderef";

export const TaskSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), channelId: z.string(), threadTs: z.string() }).strict(),
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("plan"), planId: Id, subtaskIndex: z.number().int().nonnegative() }).strict(), // Tier 3 breakdown
]);

export const TaskStatus = z.enum(["draft", "running", "awaiting_approval", "done", "failed", "cancelled"]);

export const Task = z.object({
  id: Id, title: z.string().min(1), brief: z.string(),
  source: TaskSource, workspaceId: z.string(), status: TaskStatus,
  sessionId: Id.optional(), createdAt: IsoTime,
  codeRefs: z.array(CodeRef).default([]),  // resolved from the source thread; the brief quotes them
  createdBy: z.object({ userId: z.string(), auth0UserId: z.string().optional() }).optional(),
}).strict();

export const SessionStatus = z.enum(["running", "awaiting_approval", "done", "failed", "cancelled"]);

export const AgentSession = z.object({
  id: Id, taskId: Id,
  model: z.object({ provider: z.string(), modelId: z.string() }).strict(),
  branch: z.string().regex(/^nexus\/agent-[A-Za-z0-9_-]+$/),
  worktreePath: z.string().min(1),
  baseCommit: Sha,
  status: SessionStatus,
  startedAt: IsoTime, endedAt: IsoTime.optional(),
  machineId: z.string(),                   // writer machine (dedupe in the shared store)
  optimizer: z.object({ enabled: z.boolean(), scope: z.enum(["text_roles","all_roles"]) }).optional(),
  slackProgress: z.object({ channelId: z.string(), threadTs: z.string(), messageTs: z.string() }).optional(), // the one progress message
}).strict();

const Base = { sessionId: Id, seq: z.number().int().nonnegative(), at: IsoTime };
export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ ...Base, type: z.literal("status"), status: SessionStatus }).strict(),
  z.object({ ...Base, type: z.literal("message"), text: z.string() }).strict(),                 // model-written, label it
  z.object({ ...Base, type: z.literal("tool_call"), tool: z.string(), args: z.unknown() }).strict(),
  z.object({ ...Base, type: z.literal("tool_result"), tool: z.string(), ok: z.boolean(), summary: z.string() }).strict(),
  z.object({ ...Base, type: z.literal("file_edit"), path: z.string(), diff: z.string() }).strict(), // from git diff, never model prose
  z.object({ ...Base, type: z.literal("approval_request"), approvalId: Id }).strict(),
  z.object({ ...Base, type: z.literal("approval_resolved"), approvalId: Id, decision: z.enum(["approved","rejected"]) }).strict(),
  z.object({ ...Base, type: z.literal("commit"), sha: Sha }).strict(),
  z.object({ ...Base, type: z.literal("error"), message: z.string() }).strict(),
  z.object({ ...Base, type: z.literal("test_output"), command: z.string(), exitCode: z.number().int(), tail: z.string() }).strict(), // last 200 lines, redacted
  z.object({ ...Base, type: z.literal("receipt"), receipt: z.lazy(() => require("./prune").ModelCallReceipt) }).strict(),           // Prune receipt for a call in this session
]);

export const ApprovalAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run_command"), command: z.string() }).strict(),
  z.object({ kind: z.literal("write_outside_scope"), path: z.string() }).strict(),
  z.object({ kind: z.literal("commit"), message: z.string() }).strict(),
  z.object({ kind: z.literal("other"), description: z.string() }).strict(),
]);

export const Decision = z.enum(["approved", "rejected"]);
export const DecidedBy = z.object({
  via: z.enum(["slack", "app", "auth0_push"]),
  userId: z.string(),                      // Slack user ID for "slack"; OS/VS Code identity label for "app"; Auth0 sub for "auth0_push"
  auth0UserId: z.string().optional(),
}).strict();

export const ApprovalRequest = z.object({
  id: Id, sessionId: Id, action: ApprovalAction,
  reason: z.string(),                      // model-written, shown verbatim, labeled
  requestedAt: IsoTime,
  decision: Decision.optional(),
  decidedBy: DecidedBy.optional(),
  decidedAt: IsoTime.optional(),
  slackMessage: z.object({ channelId: z.string(), ts: z.string() }).optional(),   // the Block Kit message with buttons
  cibaAuthReqId: z.string().optional(),   // set when an auth0_push request was started
  diffPreview: z.string().optional(),      // redacted git diff for commit approvals (what the council and the card show)
}).strict();

export type Task = z.infer<typeof Task>; export type AgentSession = z.infer<typeof AgentSession>;
export type AgentEvent = z.infer<typeof AgentEvent>; export type ApprovalRequest = z.infer<typeof ApprovalRequest>;
export type ApprovalAction = z.infer<typeof ApprovalAction>; export type DecidedBy = z.infer<typeof DecidedBy>;
```

*Note:* the `receipt` variant's `z.lazy(require(...))` is written that way only to avoid a circular import in this sketch; in the committed file import `ModelCallReceipt` from `./prune` normally (prune.ts does not import tasks.ts).

### 2.7 `swarms.ts` (Lane 1)

```ts
import { z } from "zod";
import { Id, IsoTime } from "./common";

export const Verdict = z.enum(["looks_good", "concerns", "do_not_merge"]);

export const SwarmReview = z.object({
  id: Id, sessionId: Id, approvalId: Id,
  swarmType: z.union([z.literal("CouncilAsAJudge"), z.string()]),
  status: z.enum(["running", "done", "unavailable"]),
  verdict: Verdict.optional(),
  summary: z.string().optional(),          // model-written, labeled
  judges: z.array(z.object({ modelId: z.string(), verdict: Verdict, notes: z.string() }).strict()).optional(),
  at: IsoTime,
  durationMs: z.number().int().nonnegative().optional(),
  dataLeftMachine: z.literal(true).default(true),   // Swarms always runs remotely; the card says so
}).strict();

export const TaskPlan = z.object({
  id: Id, sourceTaskId: Id,
  swarmType: z.union([z.literal("HierarchicalSwarm"), z.string()]),
  status: z.enum(["proposed", "accepted", "rejected"]),
  subtasks: z.array(z.object({ title: z.string(), brief: z.string(), dependsOn: z.array(z.number().int().nonnegative()) }).strict()).min(2).max(4),
  createdTaskIds: z.array(Id).optional(),  // only after a human accepts
  at: IsoTime,
}).strict().refine(p => p.subtasks.every((s, i) => s.dependsOn.every(d => d < p.subtasks.length && d !== i)), "dependsOn indices valid");

export type SwarmReview = z.infer<typeof SwarmReview>; export type TaskPlan = z.infer<typeof TaskPlan>;
```

### 2.8 `events.ts` (Lane 2 writes, Lane 3 renders)

```ts
import { z } from "zod";
import { Id, IsoTime, Sha } from "./common";

export const EventKind = z.enum(["commit", "merge", "branch", "tag", "agent_session", "slack_task"]);
export const EventTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("commit"), sha: Sha }).strict(),
  z.object({ type: z.literal("session"), sessionId: Id }).strict(),
  z.object({ type: z.literal("thread"), channelId: z.string(), threadTs: z.string() }).strict(),
]);

export const NexusEvent = z.object({
  id: Id,                                  // git: `${workspaceId}:${kind}:${sha}`; others: ULID → same event never stored twice
  kind: EventKind,
  at: IsoTime,                             // committer date for git events
  orbit: z.string().min(1),                // branch family: "main", "lane-1", "feature/x"
  fromOrbit: z.string().optional(),        // merges only
  title: z.string(),
  actor: z.object({ name: z.string(), kind: z.enum(["human", "agent"]) }).strict(),
  target: EventTarget,
  workspaceId: z.string(),
  machineId: z.string(),                   // writer
  auth0UserId: z.string().optional(),
}).strict();

export function orbitOf(branch: string): string {       // frozen rule from §5 semantics
  if (branch === "main") return "main";
  const m = /^(lane-\d+)(\/.*)?$/.exec(branch); if (m) return m[1];
  if (branch.startsWith("nexus/agent-")) return "main";  // caller overrides with the session's base branch family
  return branch.split("/").slice(0, 2).join("/");         // "feature/x/y" -> "feature/x"
}

export const TimeWindow = z.enum(["24h", "36h", "7d", "30d"]);
export const EventQuery = z.object({ from: IsoTime, to: IsoTime, orbits: z.array(z.string()).optional(), kinds: z.array(EventKind).optional(), limit: z.number().int().max(5000).default(2000) }).strict();
export const EventSearchHit = z.object({ event: NexusEvent, score: z.number() }).strict();
export const ActivityBucket = z.object({ bucketStart: IsoTime, orbit: z.string(), count: z.number().int().nonnegative() }).strict(); // 15-minute buckets (continuous aggregate)

export type NexusEvent = z.infer<typeof NexusEvent>; export type EventQuery = z.infer<typeof EventQuery>;
export type ActivityBucket = z.infer<typeof ActivityBucket>; export type TimeWindow = z.infer<typeof TimeWindow>;
```

### 2.9 `protocol.ts` — webview ↔ extension

One typed map. Envelope over `postMessage`:

```ts
import { z } from "zod";
import * as A from "./accounts"; import * as P from "./prune"; import * as C from "./chat"; import * as T from "./tasks";
import * as S from "./swarms"; import * as E from "./events"; import { CodeRef } from "./coderef"; import { Id } from "./common";

export const Envelope = z.discriminatedUnion("t", [
  z.object({ t: z.literal("req"),   id: z.string(), name: z.string(), body: z.unknown() }).strict(),  // webview -> ext
  z.object({ t: z.literal("res"),   id: z.string(), ok: z.literal(true), body: z.unknown() }).strict(),
  z.object({ t: z.literal("res"),   id: z.string(), ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }).strict(),
  z.object({ t: z.literal("sub"),   id: z.string(), name: z.string(), body: z.unknown() }).strict(),  // subscribe; id = subscription id
  z.object({ t: z.literal("unsub"), id: z.string() }).strict(),
  z.object({ t: z.literal("evt"),   id: z.string(), body: z.unknown() }).strict(),                    // ext -> webview, per subscription
]);

const Empty = z.object({}).strict();
export const Requests = {
  "app.ping":            { req: Empty, res: z.object({ pong: z.literal(true), machineId: z.string(), tPlus: z.string() }) },
  "auth.status":         { req: Empty, res: z.object({ signedIn: z.boolean(), auth0UserId: z.string().optional(), name: z.string().optional(), slackViaTokenVault: z.boolean() }) },
  "store.status":        { req: Empty, res: z.object({ online: z.boolean(), outboxDepth: z.number().int(), lastSyncAt: z.string().optional() }) },
  "accounts.list":       { req: Empty, res: z.array(A.ProviderAccount) },
  "accounts.test":       { req: z.object({ accountId: Id }), res: A.ProviderAccount },               // re-runs listModels
  "models.list":         { req: z.object({ role: A.ModelRole.optional() }), res: z.array(A.ModelInfo) }, // role filters out Swarms for "agent"
  "optimizer.get":       { req: Empty, res: P.OptimizerSetting },
  "optimizer.set":       { req: P.OptimizerSetting, res: P.OptimizerSetting },
  "receipts.list":       { req: z.object({ sessionId: Id.optional(), limit: z.number().int().max(500).default(100) }), res: z.object({ receipts: z.array(P.ModelCallReceipt), summary: P.SpendSummary }) },
  "slack.status":        { req: Empty, res: C.SlackStatus },
  "slack.channels":      { req: Empty, res: z.array(C.Channel) },
  "slack.history":       { req: z.object({ channelId: z.string(), cursor: z.string().optional(), limit: z.number().int().max(200).default(50) }), res: z.object({ messages: z.array(C.ChatMessage), nextCursor: z.string().optional(), fromCache: z.boolean() }) },
  "slack.thread":        { req: z.object({ channelId: z.string(), threadTs: z.string() }), res: C.Thread },
  "slack.users":         { req: z.object({ ids: z.array(z.string()).optional() }), res: z.array(C.SlackUser) },
  "slack.post":          { req: z.object({ channelId: z.string(), text: z.string().min(1), threadTs: z.string().optional(), clientId: z.string() }), res: C.ChatMessage },   // as the USER; clientId matches the pending echo
  "tasks.createFromThread": { req: z.object({ channelId: z.string(), threadTs: z.string() }), res: T.Task },  // status "draft"
  "tasks.get":           { req: z.object({ taskId: Id }), res: T.Task },
  "tasks.list":          { req: z.object({ status: T.TaskStatus.optional() }), res: z.array(T.Task) },
  "tasks.update":        { req: z.object({ taskId: Id, title: z.string().optional(), brief: z.string().optional() }), res: T.Task }, // only while draft
  "agent.start":         { req: z.object({ taskId: Id, model: z.object({ provider: z.string(), modelId: z.string() }) }), res: T.AgentSession },
  "agent.cancel":        { req: z.object({ sessionId: Id }), res: T.AgentSession },
  "sessions.get":        { req: z.object({ sessionId: Id }), res: T.AgentSession },
  "sessions.list":       { req: z.object({ status: T.SessionStatus.optional() }), res: z.array(T.AgentSession) },
  "approvals.list":      { req: z.object({ sessionId: Id.optional(), pendingOnly: z.boolean().default(false) }), res: z.array(T.ApprovalRequest) },
  "approvals.resolve":   { req: z.object({ approvalId: Id, decision: T.Decision }), res: T.ApprovalRequest },   // via "app"; conditional write, returns the winner
  "swarms.review.get":   { req: z.object({ approvalId: Id }), res: S.SwarmReview.nullable() },
  "swarms.review.rerun": { req: z.object({ approvalId: Id }), res: S.SwarmReview },
  "tasks.decompose":     { req: z.object({ taskId: Id }), res: S.TaskPlan },                          // status "proposed"
  "tasks.plan.get":      { req: z.object({ planId: Id }), res: S.TaskPlan },
  "tasks.plan.accept":   { req: z.object({ planId: Id }), res: S.TaskPlan },                         // creates Tasks, sets createdTaskIds
  "tasks.plan.reject":   { req: z.object({ planId: Id }), res: S.TaskPlan },
  "events.query":        { req: E.EventQuery, res: z.array(E.NexusEvent) },
  "events.search":       { req: z.object({ q: z.string().min(1), limit: z.number().int().max(50).default(20) }), res: z.array(E.EventSearchHit) }, // whole store
  "events.activity":     { req: z.object({ from: z.string(), to: z.string() }), res: z.array(E.ActivityBucket) },
  "git.commit.show":     { req: z.object({ sha: z.string() }), res: z.object({ sha: z.string(), subject: z.string(), body: z.string(), author: z.string(), at: z.string(), parents: z.array(z.string()), files: z.array(z.object({ path: z.string(), status: z.enum(["A","M","D","R"]), additions: z.number().int(), deletions: z.number().int() })) }) },
  "git.branches":        { req: Empty, res: z.array(z.object({ name: z.string(), head: z.string(), isCurrent: z.boolean(), isAgent: z.boolean() })) },
  "git.mergeAgentBranch":{ req: z.object({ sessionId: Id }), res: z.object({ ok: z.boolean(), mergeSha: z.string().optional(), message: z.string() }) }, // aborts cleanly on conflict
  "coderef.create":      { req: z.object({ path: z.string(), startLine: z.number().int(), endLine: z.number().int() }), res: z.object({ ref: CodeRef, link: z.string(), snippet: z.string() }) },
  "coderef.open":        { req: z.object({ ref: CodeRef }), res: z.object({ opened: z.enum(["at_commit", "current"]), stale: z.boolean() }) },
  "ui.openTarget":       { req: E.EventTarget, res: Empty },
  "ui.setTimeWindow":    { req: z.object({ window: E.TimeWindow }), res: Empty },
} as const;

export const Subscriptions = {
  "slack.subscribe":          { req: z.object({ channelIds: z.array(z.string()) }), evt: z.discriminatedUnion("type", [
                                 z.object({ type: z.literal("message"), message: C.ChatMessage }),
                                 z.object({ type: z.literal("message_changed"), message: C.ChatMessage }),
                                 z.object({ type: z.literal("status"), status: C.SlackStatus }) ]) },
  "agent.subscribe":          { req: z.object({ sessionId: Id, fromSeq: z.number().int().nonnegative().default(0) }), evt: T.AgentEvent }, // replays from fromSeq, then live
  "approvals.subscribe":      { req: Empty, evt: T.ApprovalRequest },                                 // every create/resolve, any machine
  "swarms.review.subscribe":  { req: z.object({ approvalId: Id.optional() }), evt: S.SwarmReview },
  "events.subscribe":         { req: Empty, evt: E.NexusEvent },
  "receipts.subscribe":       { req: z.object({ sessionId: Id.optional() }), evt: P.ModelCallReceipt },
  "store.subscribe":          { req: Empty, evt: z.object({ online: z.boolean(), outboxDepth: z.number().int() }) },
  "tasks.subscribe":          { req: Empty, evt: T.Task },
} as const;

export type RequestName = keyof typeof Requests;
export type Req<N extends RequestName> = z.infer<(typeof Requests)[N]["req"]>;
export type Res<N extends RequestName> = z.infer<(typeof Requests)[N]["res"]>;
export type SubscriptionName = keyof typeof Subscriptions;
export type SubEvt<N extends SubscriptionName> = z.infer<(typeof Subscriptions)[N]["evt"]>;
```

Rules (frozen): unknown `name` → dropped and logged (no error reply); every `req`/`res`/`evt` body is parsed with the schema on both sides; `error.code` is one of `invalid_request | not_found | unauthorized | offline | provider_error | conflict | cancelled | internal`; `conflict` is what `approvals.resolve` returns when another human already decided (body carries the winner).

### 2.10 `agent-protocol.ts` — agent process ↔ extension host

```ts
import { z } from "zod";
import { Id, IsoTime, Sha } from "./common";
import { Task } from "./tasks";

export const AgentEnvelope = z.discriminatedUnion("t", [
  z.object({ t: z.literal("req"), id: z.string(), name: z.string(), body: z.unknown() }).strict(),
  z.object({ t: z.literal("res"), id: z.string(), ok: z.boolean(), body: z.unknown().optional(), error: z.string().optional() }).strict(),
  z.object({ t: z.literal("evt"), name: z.string(), body: z.unknown() }).strict(),
]);

// agent -> extension (every one of these goes through the GATE; §14)
export const AgentRequests = {
  "fs.read":   { req: z.object({ path: z.string() }), res: z.object({ content: z.string(), truncated: z.boolean() }) },
  "fs.write":  { req: z.object({ path: z.string(), content: z.string() }), res: z.object({ bytes: z.number().int() }) },   // outside worktree => ApprovalRequest write_outside_scope
  "fs.list":   { req: z.object({ path: z.string().default("."), depth: z.number().int().max(4).default(2) }), res: z.object({ entries: z.array(z.string()) }) },
  "cmd.run":   { req: z.object({ command: z.string(), timeoutMs: z.number().int().max(300000).default(120000) }), res: z.object({ exitCode: z.number().int(), stdoutTail: z.string(), stderrTail: z.string(), approvalId: Id.optional() }) }, // not allowlisted => waits on an ApprovalRequest
  "git.diff":  { req: z.object({}), res: z.object({ diff: z.string() }) },                                                    // git diff in the worktree, produced by the host
  "git.commit":{ req: z.object({ message: z.string() }), res: z.object({ sha: Sha, approvalId: Id }) },                      // always an ApprovalRequest(commit); resolves after a human approves
  "approval.request": { req: z.object({ kind: z.literal("other"), description: z.string(), reason: z.string() }), res: z.object({ approvalId: Id, decision: z.enum(["approved","rejected"]) }) },
  "slack.progress":   { req: z.object({ text: z.string() }), res: z.object({ ok: z.boolean() }) },                          // edits the session's single bot message in place
  "credentials.get":  { req: z.object({ provider: z.string(), callId: Id }), res: z.object({ apiKey: z.string(), baseUrl: z.string().optional(), prune: z.object({ enabled: z.boolean(), apiKey: z.string().optional(), allowModelRouting: z.literal(false) }).optional() }) }, // per call; never persisted by the agent
  "event.emit":       { req: z.object({ type: z.enum(["message", "tool_call", "tool_result", "error", "receipt"]), payload: z.unknown() }), res: z.object({ seq: z.number().int() }) }, // host assigns seq
} as const;

// extension -> agent
export const HostRequests = {
  "session.start":  { req: z.object({ session: z.object({ id: Id, taskId: Id, branch: z.string(), worktreePath: z.string(), baseCommit: Sha, model: z.object({ provider: z.string(), modelId: z.string() }) }), task: Task, systemRules: z.string(), untrustedBlocks: z.array(z.object({ label: z.string(), text: z.string() })) }), res: z.object({ accepted: z.literal(true) }) },
  "session.cancel": { req: z.object({ sessionId: Id }), res: z.object({ cancelled: z.literal(true) }) },
  "health":         { req: z.object({}), res: z.object({ ok: z.literal(true), pid: z.number().int() }) },
} as const;
// Host events to the agent: "approval.resolved" { approvalId, decision }  (wakes a waiting cmd.run / git.commit)
```

Frozen semantics: the agent never receives a path outside its worktree back from `fs.*`; the host resolves and checks every path; `cmd.run` for a command not on the workspace allowlist blocks until a human decides (no timeout); `credentials.get` is answered per `callId` and the agent must discard the key after the call; the model layer runs **in the agent process** (so a hung model call never blocks the host), but the key arrives per call from the host.

### 2.11 `commands.ts` — the frozen `nexus.*` list

```ts
export const COMMANDS = {
  // §5 list
  "nexus.openHome": "Nexus: Open Home",                     "nexus.connectProvider": "Nexus: Connect provider",
  "nexus.pickModel": "Nexus: Pick model",                   "nexus.shareSelectionToSlack": "Nexus: Share to Slack",
  "nexus.makeTaskFromThread": "Nexus: Make task from thread", "nexus.openSession": "Nexus: Open session",
  "nexus.approve": "Nexus: Approve",                        "nexus.reject": "Nexus: Reject",
  "nexus.openCommit": "Nexus: Open commit",                 "nexus.mergeAgentBranch": "Nexus: Merge agent branch",
  "nexus.searchEvents": "Nexus: Search events",             "nexus.decomposeTask": "Nexus: Break into subtasks",
  "nexus.rerunSwarmReview": "Nexus: Re-run swarm review",
  // completed by the planning agent
  "nexus.signIn": "Nexus: Sign in (Auth0)",                 "nexus.signOut": "Nexus: Sign out",
  "nexus.connectSlack": "Nexus: Connect Slack",             // Token Vault first, manual token fallback
  "nexus.openSlack": "Nexus: Open Slack",                   "nexus.openApprovals": "Nexus: Open approvals",
  "nexus.openTimeline": "Nexus: Open timeline (globe fallback)",
  "nexus.toggleOptimizer": "Nexus: Toggle Optimize with Prune", "nexus.openReceipt": "Nexus: Open Prune receipt",
  "nexus.cancelSession": "Nexus: Cancel agent session",     "nexus.openCodeRef": "Nexus: Open code reference",
  "nexus.setTimeWindow": "Nexus: Set globe time window",    "nexus.showIdentity": "Nexus: Show Slack posting identity",
  "nexus.dev.reseedDemoRepo": "Nexus (dev): Re-seed demo repo",
} as const;
export type CommandId = keyof typeof COMMANDS;
export const COMMAND_OWNER: Record<CommandId, "lane-1" | "lane-2" | "lane-3"> = {
  "nexus.openHome": "lane-3", "nexus.connectProvider": "lane-1", "nexus.pickModel": "lane-1", "nexus.shareSelectionToSlack": "lane-3",
  "nexus.makeTaskFromThread": "lane-1", "nexus.openSession": "lane-3", "nexus.approve": "lane-1", "nexus.reject": "lane-1",
  "nexus.openCommit": "lane-3", "nexus.mergeAgentBranch": "lane-3", "nexus.searchEvents": "lane-3", "nexus.decomposeTask": "lane-1",
  "nexus.rerunSwarmReview": "lane-1", "nexus.signIn": "lane-1", "nexus.signOut": "lane-1", "nexus.connectSlack": "lane-2",
  "nexus.openSlack": "lane-3", "nexus.openApprovals": "lane-3", "nexus.openTimeline": "lane-3", "nexus.toggleOptimizer": "lane-1",
  "nexus.openReceipt": "lane-3", "nexus.cancelSession": "lane-1", "nexus.openCodeRef": "lane-2", "nexus.setTimeWindow": "lane-3",
  "nexus.showIdentity": "lane-2", "nexus.dev.reseedDemoRepo": "lane-1",
};
```

Each command is declared in its owner's `contributes/lane-N.json`; the merge script fails on a command declared in two fragments or missing from `COMMANDS`.

### 2.12 Fixtures (`fixtures/`)

`fixtures/index.ts` exports one valid object per type, all parsing under `.strict()` in a test (`src/contracts/contracts.test.ts` iterates them). Shared constants: `WORKSPACE_ID = "ws_demo"`, `MACHINE_ID = "m_adrian"`, `T0 = "2026-11-07T03:15:00Z"` (T+0 as UTC; the real value is filled at hour 0).

```ts
export const fx = {
  providerAccounts: [
    { id: "acc_anthropic", provider: "anthropic", label: "Anthropic (API key)", status: "connected", dataLeavesMachine: true, dataUse: "not_used_for_training" },
    { id: "acc_google",    provider: "google",    label: "Google Gemini (API key)", status: "connected", dataLeavesMachine: true, dataUse: "not_used_for_training" }, // billing-enabled demo project; dev keys => "may_be_used_for_training"
    { id: "acc_swarms",    provider: "swarms",    label: "Swarms (API key)", status: "connected", dataLeavesMachine: true, dataUse: "unknown" },
  ],
  models: [
    { provider: "anthropic", modelId: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", supportsTools: true, contextWindow: 200000 },   // fixture only; real IDs from listModels at hour 0
    { provider: "google", modelId: "gemini-3-flash-preview", displayName: "Gemini 3 Flash (preview)", supportsTools: true },
    { provider: "swarms", modelId: "swarms:single-agent", displayName: "Swarms (text only)", supportsTools: false },
  ],
  optimizer: { enabled: true, scope: "text_roles", allowModelRouting: false },
  receipt: { callId: "call_01", sessionId: "ses_01", role: "brief", requestedModel: "claude-sonnet-4-5", servedModel: "claude-sonnet-4-5", costUsd: 0.0042, baselineCostUsd: 0.0071, optimizations: ["prompt_trimmed", "output_cap"], pruneReceiptId: "rcpt_fixture_01", at: T0 },
  codeRef: { workspaceId: WORKSPACE_ID, commit: "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21", path: "src/cart.ts", startLine: 42, endLine: 48 },
  slackUsers: [ { id: "U_ADRIAN", name: "adrian", displayName: "Adrian", isBot: false }, { id: "U_BRANDON", name: "brandon", displayName: "Brandon", isBot: false }, { id: "U_NEXUSBOT", name: "nexus", displayName: "Nexus", isBot: true } ],
  channels: [ { id: "C_DEMO", name: "nexus-demo", isPrivate: false, isMember: true, botIsMember: true, unreadCount: 2 }, { id: "C_BUILD", name: "nexus-build", isPrivate: false, isMember: true, botIsMember: true } ],
  thread: { channelId: "C_DEMO", threadTs: "1762485300.000100", messages: [
    { id: "C_DEMO:1762485300.000100", channelId: "C_DEMO", ts: "1762485300.000100", author: { id: "U_ADRIAN", name: "adrian", isBot: false }, text: "cart total ignores the discount when qty > 1 — see nexus://coderef/ws_demo/3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21/42-48/src%2Fcart.ts", codeRefs: [/* fx.codeRef */], replyCount: 1, sentVia: "user" },
    { id: "C_DEMO:1762485360.000200", channelId: "C_DEMO", ts: "1762485360.000200", threadTs: "1762485300.000100", author: { id: "U_BRANDON", name: "brandon", isBot: false }, text: "can an agent take this?", codeRefs: [], sentVia: "user" },
  ] },
  task: { id: "task_01", title: "Fix cart discount for qty > 1", brief: "> [slack thread, quoted, untrusted]\n> cart total ignores the discount when qty > 1\n\nRefs: src/cart.ts:42-48 @3f2a9c1e\nRun the tests.", source: { kind: "thread", channelId: "C_DEMO", threadTs: "1762485300.000100" }, workspaceId: WORKSPACE_ID, status: "draft", createdAt: T0, codeRefs: [/* fx.codeRef */] },
  session: { id: "ses_01", taskId: "task_01", model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, branch: "nexus/agent-ses_01", worktreePath: "/tmp/nexus-sessions/ses_01", baseCommit: "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21", status: "running", startedAt: T0, machineId: MACHINE_ID },
  approval: { id: "apr_01", sessionId: "ses_01", action: { kind: "run_command", command: "npm test" }, reason: "Need to run the test suite to confirm the fix (model-written)", requestedAt: T0 },
  approvalDecided: { /* ...approval */ id: "apr_02", action: { kind: "commit", message: "fix cart discount for qty > 1" }, decision: "approved", decidedBy: { via: "slack", userId: "U_BRANDON" }, decidedAt: T0, diffPreview: "--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -42,7 +42,7 @@\n-  return price * qty - discount;\n+  return (price - discount) * qty;" },
  review: { id: "rev_01", sessionId: "ses_01", approvalId: "apr_02", swarmType: "CouncilAsAJudge", status: "done", verdict: "looks_good", summary: "Fix is minimal and covered by the new test (model-written)", judges: [ { modelId: "judge-a", verdict: "looks_good", notes: "Correct arithmetic" }, { modelId: "judge-b", verdict: "concerns", notes: "No negative-discount guard" } ], at: T0, durationMs: 8400, dataLeftMachine: true },
  plan: { id: "plan_01", sourceTaskId: "task_01", swarmType: "HierarchicalSwarm", status: "proposed", subtasks: [ { title: "Add failing test", brief: "...", dependsOn: [] }, { title: "Fix discount math", brief: "...", dependsOn: [0] }, { title: "Update CHANGELOG", brief: "...", dependsOn: [1] } ], at: T0 },
  event: { id: "ws_demo:commit:3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21", kind: "commit", at: T0, orbit: "main", title: "add cart module", actor: { name: "Adrian", kind: "human" }, target: { type: "commit", sha: "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21" }, workspaceId: WORKSPACE_ID, machineId: MACHINE_ID },
  activity: [ { bucketStart: T0, orbit: "main", count: 3 } ],
  slackStatus: { connected: true, postsAs: { userId: "U_ADRIAN", name: "Adrian" }, userTokenSource: "token_vault", botName: "Nexus" },
};
```

`fixtures/stream.ts` — **scripted streams**, deterministic, generated by a function so the globe can be tested at any size:

```ts
export function scriptedNexusEvents(opts = { hours: 36, perHour: 4, seed: 7 }): NexusEvent[]
// Produces, across 4 orbits ("main", "lane-1", "lane-2", "feature/checkout"), commits every ~15 min with a seeded PRNG,
// one branch event when each orbit starts, 5 merges into main (fromOrbit set) at hours 6, 12, 18, 24, 30,
// one tag at hour 24 ("cp-2"), 3 agent_session events on lane orbits and 2 slack_task events, ids deterministic.
export const scriptedAgentEvents: AgentEvent[] = [ /* seq 0..14 for ses_01 */
  status running → message "Reading src/cart.ts" → tool_call fs.read → tool_result ok → tool_call fs.write → tool_result ok →
  file_edit (unified diff) → tool_call cmd.run "npm test" → approval_request apr_01 → approval_resolved approved →
  test_output exit 0 → tool_call git.commit → approval_request apr_02 → approval_resolved approved → commit sha → status done ];
export const scriptedReceipts: ModelCallReceipt[]  // 4 receipts for ses_01, two with cache_hit
```

`fixtures/scenario.ts` ties them together as `demoScenario` (channel, thread, task, session, approvals, review, events) so every lane's fakes (`FakeSlackService`, `FakeEventStore`, `FakeGate`, `FakeProvider`, `FakeBridge`) load the same world. Each fake lives in the owning lane's folder under `src/**/fake-*.ts` or `webviews/shared/fakeBridge.ts` and **reads only fixtures**.

---

## 3. Extension layout and owning lanes

```
nexus/                                  (repo root = Code-OSS 1.145.2 import)
├─ product.json, src/, build/, resources/      LANE 1 ONLY (branding, startup defaults, tab-less home, build registration)
├─ CLAUDE.md, docs/PLAN.md, docs/reference/globe-prototype.html, .github/   lane 1 (integrator)
├─ progress/lane-1.md | lane-2.md | lane-3.md   each lane its own
├─ demo/                                 lane 1 (seed script, planted-bug repo template, demo-script.md, recording notes)
└─ extensions/nexus/
   ├─ package.json, package-lock.json, tsconfig.json, vitest.config.ts, vitest.int.config.ts, vite.config.ts, .eslintrc.cjs
   │                                     lane 1 (integrator). package.json#contributes is GENERATED — never hand-edited.
   ├─ contributes/
   │  ├─ lane-1.json  lane-2.json  lane-3.json      each lane its own fragment (commands, views, menus, keybindings, config, themes)
   │  └─ base.json                                  lane 1: viewsContainers (the "Nexus" activity bar container), customEditors (nexus.home), uri handler activation
   ├─ scripts/
   │  ├─ merge-contributes.mjs           lane 1: fragments -> package.json#contributes + activationEvents (deterministic order, fails on dup IDs / unknown command)
   │  ├─ check-contributes.mjs           lane 1: CI check = run merge, `git diff --exit-code package.json`
   │  └─ build-webviews.mjs              lane 3: vite build of every webviews/* entry into media/
   ├─ media/                             build output (gitignored except media/.gitkeep); CSP-allowed local root
   ├─ auth-service/                      lane 1: Cloudflare Worker (CIBA start/poll), its own package.json; never bundled into the extension
   ├─ sql/
   │  ├─ 001_schema.sql  002_aggregates.sql  003_notify.sql     lane 2 (Tiger Cloud migrations, run once at hour 0)
   ├─ src/
   │  ├─ extension.ts                    lane 1: activate() calls registerLane1/2/3(ctx, deps); nothing else
   │  ├─ contracts/**                    FROZEN at cp-0, CODEOWNERS = all three
   │  ├─ shared/
   │  │  ├─ redact.ts                    lane 1 (secret-pattern redaction used by Swarms, Prune, Tiger writes, test_output) — delivered wave 1, then treated like a contract
   │  │  ├─ ids.ts, time.ts, log.ts      lane 1 (ULID, T+ formatting, logger that redacts)
   │  ├─ models/                         lane 1: provider.ts (interface), fake-provider.ts, anthropic.ts, gemini.ts, swarms-provider.ts, prune-adapter.ts, listing-cache.ts
   │  ├─ agent/                          lane 1 (extension side): process-host.ts, session-controller.ts, brief-builder.ts, prompt-framing.ts
   │  ├─ agent-process/                  lane 1 (child process): main.ts, runtime.ts (tool loop), tools.ts (gate requests), fake-gate.ts
   │  ├─ features/
   │  │  ├─ accounts/                    lane 1: accounts-service.ts, connect-provider.ts, model-picker.ts (status bar + quick pick), optimizer.ts
   │  │  ├─ tasks/                       lane 1: tasks-controller.ts, decompose.ts (Tier 3)
   │  │  ├─ sessions/                    lane 1: sessions-controller.ts, scheduler.ts (plan sessions, max 2 / 1 on 8 GB)
   │  │  ├─ approvals/                   lane 1: approvals-controller.ts, notifications.ts, ciba.ts
   │  │  ├─ auth/                        lane 1: auth0-signin.ts (PKCE), session-store.ts
   │  │  └─ swarms/                      lane 1: swarms-client.ts, review.ts, task-plan.ts
   │  ├─ services/
   │  │  ├─ slack/                       lane 2: web-client.ts (user token), socket.ts (Bolt), bot.ts (posts, chat.update, Block Kit), cache.ts, interactivity.ts, token-vault.ts, fake-slack.ts, progress-message.ts (if Q1(a) accepted)
   │  │  ├─ git/                         lane 2: git-api.ts (built-in ext), git-cli.ts, worktrees.ts, watcher.ts, merge.ts, fake-git.ts
   │  │  ├─ events/                      lane 2: store.ts (interface), local-store.ts (JSONL + outbox), tiger-store.ts (pg), sync.ts (NOTIFY/poll), search.ts, activity.ts, fake-store.ts
   │  │  ├─ coderef/                     lane 2: create.ts, resolve.ts, uri-handler.ts, slack-format.ts
   │  │  └─ gate/                        lane 2: gate.ts (paths, allowlist, approvals hook), commands.ts (cmd.run), fs.ts
   │  ├─ bridge/                         lane 2: host.ts (WebviewPanel/View wrapper, CSP nonce), router.ts (Requests/Subscriptions dispatch), fake-bridge-server.ts
   │  └─ register/                       lane-1.ts | lane-2.ts | lane-3.ts  — each lane's wiring of its own commands/views/handlers (one file per lane, owned by that lane)
   └─ webviews/                          lane 3 (UI only)
      ├─ shared/                         kit: components/, theme.css, bridgeClient.ts, fakeBridge.ts (fixtures), format.ts
      ├─ globe/   chat/   session/   approvals/   plan/   git/   timeline/
      └─ (each: index.html, main.tsx, App.tsx, *.test.tsx with vitest + jsdom)
```

**Disjointness rule applied:** a Lane 1 task that needs a Lane 2 service in wave 1 imports its **interface** (`services/events/store.ts`, `services/slack/types.ts`, `services/gate/types.ts`) and uses the Lane 2-owned `fake-*.ts`; the interfaces themselves are tiny and are committed by Lane 2 in its first wave-1 commits (tasks L2-01/02/08/13 each start by committing the interface file within the first 30 minutes, listed as a "T+2:30 interface drop" in their briefs). Until then Lane 1 codes against the contracts' Zod types directly.

### 3.1 Fragment merge — `scripts/merge-contributes.mjs`

Input: `contributes/base.json` + `contributes/lane-{1,2,3}.json`. Each fragment is a partial `contributes` object plus an optional `activationEvents` array. Merge rules:

1. For each key in `contributes` (`commands`, `views`, `viewsContainers`, `menus`, `keybindings`, `configuration`, `themes`, `customEditors`, `colors`), arrays are concatenated in lane order (base, 1, 2, 3); `menus` and `views` (objects of arrays) are merged per sub-key; `configuration.properties` objects are merged, duplicate property → **error**.
2. Every `commands[].command` must exist in `src/contracts/commands.ts#COMMANDS` and must be declared only once across fragments (owner check against `COMMAND_OWNER`) → else **error** with both fragment names.
3. Every `views[*][].id` and `customEditors[].viewType` must start with `nexus.`; duplicates → error.
4. `activationEvents` = union, sorted, always including `onStartupFinished`, `onUri`, `onCustomEditor:nexus.home`, and `onView:<every nexus view>`.
5. Output is written into `package.json` under `contributes` and `activationEvents` with 2-space JSON and a top comment field `"x-generated": "scripts/merge-contributes.mjs — do not edit contributes by hand"`.

`npm run contributes` runs it; `npm run contributes:check` (CI) runs it and fails if `package.json` changed. Workers never run it against `package.json`; they edit their lane fragment only and the **lead** regenerates at merge time (so `package.json` edits come only from leads, consistent with §11).

### 3.2 `extensions/nexus/package.json` scripts (lane 1 owns)

```
"scripts": {
  "build": "npm run contributes && tsc -p tsconfig.json && npm run build:webviews",
  "build:webviews": "node scripts/build-webviews.mjs",
  "watch": "concurrently \"tsc -w -p tsconfig.json\" \"vite build --watch\"",
  "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p webviews/tsconfig.json",
  "lint": "eslint src webviews --ext .ts,.tsx",
  "test": "vitest run",                       // unit: no network, no keys; fails if any *.int.test.ts is picked up
  "test:int": "vitest run --config vitest.int.config.ts",   // only *.int.test.ts; needs env keys; never in CI/Routine
  "contributes": "node scripts/merge-contributes.mjs",
  "contributes:check": "node scripts/check-contributes.mjs",
  "ci": "npm ci && npm run contributes:check && npm run typecheck && npm run lint && npm test && npm run build"
}
```

Dependencies (lane 1 adds at cp-0 so no worker needs a dependency change): `zod`, `@anthropic-ai/sdk`, `@google/genai` (**verify** ≥2.0.0 for `interactions`), `@slack/bolt`, `@slack/web-api`, `pg`, `ulid`, `react`, `react-dom`, `three`, `@react-three/fiber`, `@react-three/drei`; dev: `typescript`, `vitest`, `jsdom`, `@testing-library/react`, `vite`, `@vitejs/plugin-react`, `eslint`, `concurrently`, `@types/vscode` (matching 1.145), `@types/node`, `@types/pg`. The fork's own build must treat `extensions/nexus` like other built-ins: add `'extensions/nexus/tsconfig.json'` to the `compilations` list in `build/gulpfile.extensions.*` (**verify** file extension and that webview assets in `media/` are packaged — smoke test L1-S1).

### 3.3 CODEOWNERS (`.github/CODEOWNERS`, lane 1 writes at hour 0)

```
/extensions/nexus/src/contracts/   @adrian @brandon @<elkin-github>
/src/ /build/ /product.json /resources/   @adrian
/extensions/nexus/package.json /extensions/nexus/package-lock.json /extensions/nexus/src/extension.ts   @adrian
```
Branch protection requires CODEOWNERS review only when a PR touches those paths (GitHub behaviour), which is exactly §10's rule.

---

## 4. Pre-event and hour-0 checklists

### 4.1 Pre-event (before T+0; nothing Nexus-specific is written)

| ID | Owner | Task | Done when |
|---|---|---|---|
| PE-1 | All | Build prerequisites per the VS Code "How to Contribute" page; Node from `.nvmrc` (v24.22.1 via fnm), Python, VS Build Tools C++ workload on Windows | `node -v` prints v24.22.1 on the event machine |
| PE-2 | All | Shallow clone upstream at `1.145.2` into a short, non-synced path (`C:\dev\nexus`) | `git describe --tags` prints 1.145.2 |
| PE-3 | All | `npm install`, `npm run watch` to "Finished compilation", launch `scripts\code.bat` | Window opens; first/incremental build times written down |
| PE-4 | All | Hello-world extension outside the checkout opens the globe prototype in a webview via `--extensionDevelopmentPath` | Globe spins inside the fork |
| PE-5 | All | Record RAM, first build time, incremental time → sent to Adrian for §3's table | Table has three rows |
| PE-6 | Adrian | Confirm event rules: fork of open source allowed; whether the Slack workspace/app may pre-exist | Yes/no written in `progress/lane-1.md` at hour 0 |
| PE-7 | Adrian | Decision by 9:15 PM ET: all three pass → fork; any fails → Electron plan | Decision messaged to the team |
| PE-8 | All | Claude Code signed in (`claude doctor` green); `git config user.name/user.email` real identity | Both commands clean |
| PE-9 | All | Accounts exist (no project created): GitHub, Slack, Anthropic Console, Google AI Studio (+ one billing-enabled GCP project for Adrian), Auth0, Tiger Cloud, Cloudflare, Prune, Swarms; phones have Auth0 Guardian installed | Each person can log in to each console |
| PE-10 | Adrian | Read this plan end to end; print section 4.3 (the hour-0 schedule) | — |

### 4.2 cp-0 definition (minimal)

cp-0 is **only** what every lane needs to start on fixtures at T+2:00:
`CLAUDE.md`, `docs/PLAN.md`, `docs/reference/globe-prototype.html`, `.gitignore` (+`.env*`, `CLAUDE.local.md`), `product.json` with name/app/data-folder/`nexus` protocol, `extensions/nexus` skeleton (package.json with all deps, tsconfig, vitest, vite config, `scripts/merge-contributes.mjs`, three empty fragments + `base.json`, `src/extension.ts` calling three empty `register` functions, `src/contracts/**` with fixtures and the fixture test green, `webviews/shared/` placeholder entry, `progress/lane-*.md` headings), `.github/workflows/ci.yml` (extension-only), CODEOWNERS, branch protection on. **Not** in cp-0: branding icons, theme, build registration, Auth0, Tiger, Prune, Swarms, demo repo — all wave 1.

### 4.3 Hour 0 — minute-by-minute (T+0:00 → T+2:00), three people in parallel

The schedule is a guide, not a stopwatch: if a row runs long, finish it and shift the rest; cp-0 is tagged when 4.2 is true, not when the clock says 2:00. Legend: **A** = Adrian, **B** = Brandon, **N** = Elkin. Items in *italics* are smoke tests from `CLAUDE.md`'s *verify* list, ordered by how much depends on them. ⏩ = does not fit; moved to wave 1 (listed in 4.4).

| T+ | A — Adrian | B — Brandon | N — Elkin |
|---|---|---|---|
| 0:00–0:10 | All three: confirm exact T+0 minute, write it in `progress/`; read §8; agree the demo script line by line (10 min, no edits beyond names/channels). Sponsor challenges confirmed (§18). Elkin's GitHub handle (for CODEOWNERS) into §9 + CODEOWNERS. | ← | ← |
| 0:10–0:25 | **H0-A1** Team repo: empty GitHub repo; orphan `main`, `import code-oss 1.145.2`, remote rename, push (LFS retry if needed). *verify: orphan import + push.* | **H0-B1** Create the Slack workspace + Nexus app from the manifest in 4.5 (Socket Mode on, `xapp-` token, bot + user scopes, interactivity on). Create `#nexus-demo`, `#nexus-build`, invite the bot. (Moved from A: A is blocked on the repo push.) | **H0-N1** Webview skeleton in the hello-world folder: Vite React build, theme vars, `app.ping` echo through a hand-rolled bridge, globe prototype in a **webview view** (sidebar) not only a panel. *verify: WebGL in a webview view.* |
| 0:25–0:40 | **H0-A2** Switch helpers: send B and N the remote-switch commands; `gh repo set-default`. Copy `CLAUDE.md`, `docs/`, `.gitignore` entries, `progress/` into the checkout. | **H0-B2** Switch checkout to team repo (`remote rename`, `fetch`, `switch -C main origin/main`); confirm `npm run watch` still incremental. Then *verify: Socket Mode receives one message from a Node script run in the extension host context* (start with a plain Node script; the ext-host run is in L2-S1). | **H0-N2** Switch checkout to team repo; `npm run watch` still incremental. Keep building the skeleton (kit folder structure, `fakeBridge.ts` reading fixtures stub). |
| 0:40–1:05 | **H0-A3** Extension skeleton: `extensions/nexus` package.json (all deps), tsconfig, vitest/vite config, `scripts/merge-contributes.mjs` + fragments, `src/extension.ts`, `src/register/lane-*.ts` stubs, CI workflow, CODEOWNERS. `npm install` inside `extensions/nexus`. | **H0-B3** *verify: built-in git extension API returns branches* from a scratch extension (`vscode.extensions.getExtension('vscode.git').exports.getAPI(1)`) **(verify API version)**; *verify: child process round trip* (`child_process.fork` + JSON lines) from the same scratch extension. Write results in `progress/lane-2.md`. | **H0-N3** Each person authorizes the Slack app → own `xoxp-` (when B finishes H0-B1 at ~0:25). *Smoke: post with user token shows as you.* Then continue skeleton: `webviews/shared/theme.css` with the §6 geometry tokens. |
| 1:05–1:30 | **H0-A4** Contracts review **in person** (B and N read `docs/PLAN.md` §2 for 10 min while A pastes the files in); fix names/typos only; commit `src/contracts/**` + fixtures + fixture test green (`npx vitest run src/contracts`). `product.json`: name, `applicationName`, `dataFolderName`, `urlProtocol: nexus` **(verify field names)**. | **H0-B4** Tiger Cloud: create the free service, run `sql/001_schema.sql` and `002_aggregates.sql` (B writes them now from §16's table list; hypertables on `at`), hand connection string in person. *verify: `LISTEN/NOTIFY`* (`psql`: `LISTEN nexus;` in one session, `NOTIFY nexus,'x'` in another). ⏩ continuous-aggregate refresh policy → L2-12. | **H0-N4** Review contracts with A (10 min). Then *smoke: Anthropic + Gemini dev keys* — one `listModels` + one tool-calling turn each from a Node script (N's own keys), note working model IDs in `progress/lane-3.md`. ⏩ demo-key spend limit → A in wave 1. |
| 1:30–1:45 | **H0-A5** Commit cp-0 set; enable branch protection + auto-merge; push; **tag `cp-0`**; create `lane-1/2/3`. Create the hourly merge-check Routine (minimal bot token, scratch clone, extension CI steps, one line per lane to `#nexus-build`). | **H0-B5** Fetch `cp-0`; create first sparse worktree with §11's sequence. *verify: sparse worktree + `npm install` inside it.* If it misbehaves: full worktrees, 2 workers. Report in `#nexus-build`. | **H0-N5** Fetch `cp-0`; same sparse-worktree check on N's machine; write RAM into `progress/lane-3.md` (decides 2 vs 3 workers). Launch the fork with `--extensionDevelopmentPath=<repo>\extensions\nexus` → the skeleton activates (`app.ping` in a webview). |
| 1:45–2:00 | **H0-A6** Launch check on A's machine (skeleton activates, no errors). Auth0: create tenant + **Native app** (PKCE, callback `nexus://auth/callback`) + Slack connection with Connected Accounts for Token Vault **only** (CIBA, Guardian, confidential app, auth service ⏩ L1-S6/L1-15/L1-16). *verify: Auth0 for AI Agents add-on lists asynchronous authorization (CIBA)* — read the plan page, 3 min, record yes/no. | **H0-B6** Brief and dispatch Lane 2 wave 1 (L2-01, L2-02, L2-08). | **H0-N6** Brief and dispatch Lane 3 wave 1 (L3-01 first; L3-02/L3-08 at T+2:30 once the kit's component stubs land). |
| 2:00 | **All:** every machine launches the fork with the Nexus skeleton; cp-0 tagged; lane branches exist; wave 1 dispatched. A dispatches L1-S1, L1-03, L1-08. | | |

### 4.4 What did **not** fit in hour 0 → wave 1 (T+2–T+6), in dependency order

| Moved item | Becomes | Owner | By |
|---|---|---|---|
| Register `extensions/nexus` with the fork's build + bundle as built-in (**verify**) | **L1-S1** | A | T+4 (launch check) |
| Tab-less home core prototype (**verify**) | **L1-02** (starts T+2) | A | T+6 |
| Branding icons, "Nexus Dark" theme, switch off built-in chat/agent/Copilot (**verify** settings/product fields) | **L1-22** (+ L3-17 if Q1(b)) | A / N | T+8 |
| Slack Socket Mode **from the extension host** (**verify**) + interactivity button round trip | **L2-S1** (inside L2-03) | B | T+5 |
| Token Vault Slack exchange (**verify** Connected Accounts flow) | **L2-15** | B | T+8 |
| Auth0 native callback through `nexus://` (**verify**), CIBA plan check follow-up, Guardian enrolment ×3, confidential app, auth service deploy | **L1-S6** (callback, T+6), **L1-14** (sign-in, T+8); CIBA items **L1-15/L1-16** in T+22–24 | A | see IDs |
| Prune: auth header, model pinning, tool-calling/streaming passthrough, receipt format (**verify**) | **L1-S4** | A | T+6 |
| Swarms: TS multi-agent call / REST shape, `CouncilAsAJudge` + `HierarchicalSwarm` availability, latency, tools-off (**verify**) | **L1-S5** | A | T+5 |
| Gemini: tool-calling API path (Interactions vs generateContent), model list (**verify**) | **L1-S3** (inside L1-05) | A | T+6 |
| Demo repo seed + planted bug; demo-key spend limits | **L1-26** | A | T+9 (needed for cp-1) |
| Tiger continuous aggregate refresh policy + activity query (**verify**) | **L2-12** | B | T+14 |
| Per-person Guardian enrolment, Auth0 sign-in once each + Slack through Token Vault ("All" row in §3) | **H0-ALL-LATE** at T+8–T+9 (10 min each) | All | T+9 |

### 4.5 Slack app manifest (H0-B1) — scopes **(verify against Slack's scope reference at install time)**

```yaml
display_information: { name: Nexus }
features:
  bot_user: { display_name: Nexus, always_online: true }
oauth_config:
  scopes:
    bot:  [chat:write, chat:write.customize, channels:history, channels:read, groups:history, groups:read, users:read, app_mentions:read]
    user: [chat:write, channels:history, channels:read, groups:history, groups:read, users:read]
settings:
  event_subscriptions: { bot_events: [message.channels, message.groups, app_mention] }
  interactivity: { is_enabled: true }
  socket_mode_enabled: true
  org_deploy_enabled: false
```
App-level token with `connections:write`. The user token (`xoxp-`) each person gets from the install flow lives only in that person's env/`SecretStorage` (§14); Token Vault replaces the manual step once L2-15 works.

---

## 5. Per-lane task lists

Format per task: **ID — title** · tier · checkpoint · size · depends on · owns · contracts used · acceptance (run from `extensions/nexus`, no network/keys/fork build unless marked `*.int.test.ts` or **launch check**) · then the ready-to-send brief. Common brief lines are not repeated: every brief's `READ FIRST` includes `CLAUDE.md §5, §6 (UI style), §11, §14` and `src/contracts/index.ts`; every `CONSTRAINTS` includes "no network in unit tests; never log or store a key/token; webview code never imports `vscode` or Node; commit messages `lane-N: …`". `STOP WHEN` budget is the task's size unless stated. All acceptance test files are the first commit (red), then implementation (green).

Sizes: S < 1 wh, M 1–2 wh, L 2–4 wh. Worker-hour totals: **Lane 1 = 42.75 wh (26 tasks)**, **Lane 2 = 32.25 wh (16; 33.75 with L2-17)**, **Lane 3 = 33 wh (16; 33.75 with L3-17)**.

### 5.1 Lane 1 — Adrian (agents, models, fork, Swarms, Prune, Auth0 sign-in/CIBA, integration)

**L1-S1 — Register `extensions/nexus` with the fork's build and bundle it as a built-in** · T1 · cp-1 · M · depends: cp-0 · owns: `build/gulpfile.extensions.*` (core, lead-only), `extensions/nexus/tsconfig.json`, `extensions/nexus/.vscodeignore` · contracts: none · acceptance: **launch check** — `npm run watch` in the fork compiles `extensions/nexus`; `.\scripts\code.bat` **without** `--extensionDevelopmentPath` shows the Nexus container and `app.ping` works; record the result in `progress/lane-1.md`.
```
TASK L1-S1: Register extensions/nexus with the fork build and prove built-in bundling
LANE: lane-1   BRANCH: lane-1/L1-S1   WORKTREE: main checkout (lead task; touches core build)
GOAL: The fork's own watch task compiles extensions/nexus and the extension loads as a built-in without
      --extensionDevelopmentPath. media/ (webview assets) is included in the bundled extension.
OWNS: build/gulpfile.extensions.*, extensions/nexus/tsconfig.json, extensions/nexus/.vscodeignore
READ FIRST: build/gulpfile.extensions.* ("compilations" array), build/lib/extensions.*, extensions/git/tsconfig.json as a model
CONTRACTS: none
ACCEPTANCE: launch check as above; plus `npm run typecheck` in extensions/nexus exits 0
CONSTRAINTS: (verify) whether the file is .js or .ts at tag 1.145.2; do not change any other extension's entry;
             if webviews are not picked up by the fork's pipeline, keep building them with our vite script into media/ and
             make sure .vscodeignore does not exclude media/.
STOP WHEN: acceptance passes OR 90 min without a built-in load → fall back to --extensionDevelopmentPath for cp-1 and note it.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-02 — Tab-less home: core change hiding tabs and title for the `nexus.home` editor** · T1 · cp-1 · L · depends: L1-S1 · owns: `src/vs/workbench/browser/parts/editor/**` (minimal), `src/vs/workbench/contrib/nexusHome/**` (new) · contracts: `COMMANDS["nexus.openHome"]` · acceptance: **launch check** — with the `nexus.home` custom editor active, no tab strip or title bar shows; `Ctrl+W`, split and drag-to-group do nothing to it; opening a file shows tabs again; closing the last file brings the home back without a tab.
```
TASK L1-02: Hide the tab strip/title area while nexus.home is the active editor and make it unclosable
LANE: lane-1   BRANCH: lane-1/L1-02   WORKTREE: main checkout (core change; Lane 1 lead or one worker with full checkout)
GOAL: The Nexus home (custom editor viewType "nexus.home", contributed by the extension) fills the editor area with no tab,
      cannot be closed/split/dragged, and tabs reappear for normal editors. Not acceptable: workbench.editor.showTabs globally.
OWNS: src/vs/workbench/contrib/nexusHome/** (new contribution: a workbench contribution that toggles a CSS class on the
      editor part when the active editor's typeId/resource is nexus.home and vetoes close for it), plus the smallest edit
      to the editor title control to respect that class.
READ FIRST: src/vs/workbench/browser/parts/editor/editorPart.ts, editorGroupView.ts, the "showTabs" handling, AGENTS.md under src/vs
CONTRACTS: nexus.openHome (extension side opens the editor via vscode.commands.executeCommand('vscode.openWith', uri, 'nexus.home'))
ACCEPTANCE: launch check (above). Also `npm run compile` for the core passes with 0 errors.
CONSTRAINTS: One CSS class + one close veto; no new settings; reopening on "last editor closed" is extension code (L1-22), not core.
STOP WHEN: acceptance passes OR 3 h → report; the fallback is a normal (closable) webview editor tab for cp-1.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-03 — Provider interface, fake provider, model-listing cache** · T1 · cp-1 · M · depends: contracts · owns: `src/models/provider.ts`, `src/models/fake-provider.ts`, `src/models/listing-cache.ts`, `src/models/*.test.ts` · contracts: `ModelInfo`, `ProviderAccount`, `ModelRole` · acceptance: `npx vitest run src/models/provider.test.ts`
```
TASK L1-03: Define the provider interface, a deterministic fake provider, and the model-listing cache
LANE: lane-1   BRANCH: lane-1/L1-03   WORKTREE: ../nexus-wt/L1-03 (sparse: extensions/nexus)
GOAL: `Provider` = { id, listModels(key): Promise<ModelInfo[]>, turn(req, key): AsyncIterable<TurnEvent> } where TurnEvent is
      text_delta | tool_call{id,name,args} | done{usage} | error. FakeProvider replays a scripted turn (reads src/cart.ts, writes a fix,
      asks to run tests, commits) so the agent loop and UI can run end to end with no network. ListingCache stores the last
      listModels result per account with its timestamp; status "connected" only after a successful real listing.
OWNS: src/models/provider.ts, src/models/fake-provider.ts, src/models/listing-cache.ts, src/models/provider.test.ts
CONTRACTS: ModelInfo, ProviderAccount, ModelRole; roleEligible(model, role) => false for provider "swarms" when role === "agent"
ACCEPTANCE: npx vitest run src/models/provider.test.ts  (fake provider yields the scripted tool calls in order; roleEligible rules; cache)
CONSTRAINTS: no SDK imports here; keys are parameters, never fields.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-04 — Anthropic provider (list models, tool-calling turn, streaming)** · T1 · cp-1 · M · depends: L1-03 · owns: `src/models/anthropic.ts`, `src/models/anthropic.test.ts`, `src/models/anthropic.int.test.ts` · contracts: `ModelInfo`, provider interface · acceptance: `npx vitest run src/models/anthropic.test.ts` (SDK mocked); int: `npm run test:int -- anthropic` with `ANTHROPIC_API_KEY`.
```
TASK L1-04: Implement the Anthropic provider on the official TypeScript SDK
LANE: lane-1   BRANCH: lane-1/L1-04   WORKTREE: ../nexus-wt/L1-04
GOAL: listModels maps the SDK's models list to ModelInfo (supportsTools true, contextWindow when reported). turn() streams a
      messages request with Nexus's function tools and yields text_delta / tool_call / done. dataUse for API-key accounts is
      "not_used_for_training" ONLY if the committed mapping file says so for Anthropic API; otherwise "unknown" (never a guess in the user's favor).
OWNS: src/models/anthropic.ts, src/models/anthropic.test.ts, src/models/anthropic.int.test.ts, src/models/data-use.ts
READ FIRST: src/models/provider.ts, src/models/fake-provider.ts
CONTRACTS: ModelInfo, ProviderAccount.dataUse
ACCEPTANCE: npx vitest run src/models/anthropic.test.ts  (SDK client injected/mocked: a tool_use block becomes one tool_call event with parsed args)
CONSTRAINTS: key passed per call; no retries that resend on 4xx; model IDs are the SDK's exact ids.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-05 — Gemini provider via `@google/genai` (includes smoke L1-S3)** · T1 · cp-1 · M · depends: L1-03 · owns: `src/models/gemini.ts`, `src/models/gemini.test.ts`, `src/models/gemini.int.test.ts` · contracts: as L1-04 · acceptance: `npx vitest run src/models/gemini.test.ts`; int: `npm run test:int -- gemini` with `GEMINI_API_KEY` must complete one tool-calling round trip and list models — **this is smoke L1-S3**; record which API path worked.
```
TASK L1-05: Implement the Gemini provider and confirm the tool-calling path (smoke L1-S3)
LANE: lane-1   BRANCH: lane-1/L1-05   WORKTREE: ../nexus-wt/L1-05
GOAL: listModels via the SDK's models list. turn() prefers the Interactions API (client.interactions.create with tools of type "function";
      a step of type "function_call" {id,name,arguments} becomes tool_call; results go back as input [{type:"function_result", name, call_id, result}]
      with previous_interaction_id) — (verify) needs @google/genai >= 2.0.0; fall back to models.generateContent with functionDeclarations
      if interactions is missing. Server-side tools (google_search, code_execution) are NEVER sent. dataUse: "not_used_for_training" only when the
      account is flagged billing-enabled by the user at connect time; else "may_be_used_for_training".
OWNS: src/models/gemini.ts, src/models/gemini.test.ts, src/models/gemini.int.test.ts
CONTRACTS: ModelInfo, ProviderAccount.dataUse
ACCEPTANCE: npx vitest run src/models/gemini.test.ts (mocked client; both API paths map to the same TurnEvents)
CONSTRAINTS: no server tools; free keys only ever see the fake demo repo (§14).
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions (which path worked live, model IDs seen)
```

**L1-06 — Accounts service: SecretStorage keys, `nexus.connectProvider`, status from real listing** · T1 · cp-1 · M · depends: L1-03 · owns: `src/features/accounts/accounts-service.ts`, `src/features/accounts/connect-provider.ts`, `src/features/accounts/*.test.ts` · contracts: `ProviderAccount`, `accounts.list`, `accounts.test`, `models.list`, `COMMANDS["nexus.connectProvider"]` · acceptance: `npx vitest run src/features/accounts/accounts-service.test.ts`
```
TASK L1-06: Accounts service and the Connect provider command
LANE: lane-1   BRANCH: lane-1/L1-06   WORKTREE: ../nexus-wt/L1-06
GOAL: `Nexus: Connect provider` quick-picks Anthropic (API key) | Google Gemini (API key) | Swarms (API key) | Prune (API key), asks for the key
      with password input, stores it in SecretStorage under nexus.key.<provider>, runs listModels, and records ProviderAccount with status from
      that call ("invalid" on auth error, "missing" when no key). For Gemini, one extra yes/no: "Is this key's project billing-enabled?" → dataUse.
      accounts.list / accounts.test / models.list(role) handlers implemented against a SecretStorage interface (in-memory in tests).
OWNS: src/features/accounts/accounts-service.ts, connect-provider.ts, accounts-service.test.ts, src/register/lane-1.ts (only the lines registering these)
CONTRACTS: ProviderAccount, ModelInfo, accounts.list, accounts.test, models.list, nexus.connectProvider (declared in contributes/lane-1.json)
ACCEPTANCE: npx vitest run src/features/accounts/accounts-service.test.ts
CONSTRAINTS: no key value ever appears in a ProviderAccount, log line, or error message; the dev env var NEXUS_<PROVIDER>_KEY is read only when SecretStorage is empty.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-07 — Model picker: status bar item + grouped quick pick with data-use labels** · T1 · cp-1 · M · depends: L1-06 · owns: `src/features/accounts/model-picker.ts`, `model-picker.test.ts` · contracts: `models.list`, `nexus.pickModel`, `OptimizerSetting` (read-only here) · acceptance: `npx vitest run src/features/accounts/model-picker.test.ts`
```
TASK L1-07: Status bar model picker
LANE: lane-1   BRANCH: lane-1/L1-07   WORKTREE: ../nexus-wt/L1-07
GOAL: A status bar item "⬡ <provider> · <modelId>" opens a quick pick grouped by provider; each item shows the data-use label
      ("not used for training" / "may be used for training" / "unknown") and "leaves machine" when dataLeavesMachine. Picking sets the default
      model for role "agent" (only supportsTools models; never Swarms) and remembers per-role choices in workspaceState. A final separator row
      "Optimize with Prune: ON/OFF" toggles via nexus.toggleOptimizer (handler in L1-21; here just the command call).
OWNS: src/features/accounts/model-picker.ts, model-picker.test.ts
CONTRACTS: models.list, nexus.pickModel, nexus.toggleOptimizer (call only)
ACCEPTANCE: npx vitest run src/features/accounts/model-picker.test.ts (quick pick items built from fixtures: grouping, labels, Swarms excluded for agent)
CONSTRAINTS: only models the connected account returned; built-in QuickPick, no custom webview.
STOP WHEN: acceptance passes OR 1.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-08 — Agent process host: spawn, JSON-lines framing, `session.start/cancel`, per-call credentials** · T1 · cp-1 · M · depends: contracts, L1-23 · owns: `src/agent/process-host.ts`, `src/agent/process-host.test.ts`, `src/agent-process/main.ts` (entry only) · contracts: `agent-protocol.ts` (all), `credentials.get` · acceptance: `npx vitest run src/agent/process-host.test.ts`
```
TASK L1-08: Host side of the agent child process
LANE: lane-1   BRANCH: lane-1/L1-08   WORKTREE: ../nexus-wt/L1-08
GOAL: ProcessHost forks out/agent-process/main.js, frames AgentEnvelope as JSON lines over stdio, validates every inbound message with Zod
      (unknown → dropped + logged), routes AgentRequests to injected handlers (gate, store, slack, credentials), answers credentials.get with the
      key for that callId from SecretStorage and never logs it, restarts a crashed process at most once per session and emits an "error" AgentEvent.
      The test spawns the real child with a tiny echo runtime.
OWNS: src/agent/process-host.ts, process-host.test.ts, src/agent-process/main.ts (bootstrap that calls runtime.run()), src/agent-process/echo-runtime.ts (test only)
CONTRACTS: AgentEnvelope, AgentRequests, HostRequests, "approval.resolved" host event
ACCEPTANCE: npx vitest run src/agent/process-host.test.ts
CONSTRAINTS: the host never awaits the child synchronously; every request has a timeout except cmd.run/git.commit/approval.request (they wait for humans).
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-09 — Agent runtime: the tool loop in the child process (fake provider + fake gate)** · T1 · cp-1 · L · depends: L1-03, L1-08, L1-24 · owns: `src/agent-process/runtime.ts`, `src/agent-process/tools.ts`, `src/agent-process/fake-gate.ts`, `src/agent-process/*.test.ts` · contracts: `AgentRequests`, `HostRequests`, `AgentEvent` (via `event.emit`) · acceptance: `npx vitest run src/agent-process/runtime.test.ts`
```
TASK L1-09: The provider-neutral tool loop
LANE: lane-1   BRANCH: lane-1/L1-09   WORKTREE: ../nexus-wt/L1-09
GOAL: runtime.run(sessionStart) builds the system prompt from systemRules + framed untrusted blocks (L1-24), loops: provider.turn → for each tool_call
      send the matching AgentRequest to the host (fs.read/fs.write/fs.list/cmd.run/git.diff/git.commit/slack.progress/approval.request) → feed results back,
      until the model stops or 40 turns or cancel. Emits message/tool_call/tool_result/error through event.emit; never writes files itself; asks
      credentials.get before every provider call and drops the key after. Tools exposed to the model: read_file, write_file, list_files, run_command,
      get_diff, commit, post_progress, ask_approval. FakeGate answers in-process for tests.
OWNS: src/agent-process/runtime.ts, tools.ts, fake-gate.ts, runtime.test.ts
CONTRACTS: AgentRequests, HostRequests, AgentEvent types message|tool_call|tool_result|error
ACCEPTANCE: npx vitest run src/agent-process/runtime.test.ts (FakeProvider script drives: read → write → run_command (waits for approval.resolved) → commit → done; cancel mid-loop stops within one turn)
CONSTRAINTS: no fs/child_process imports in the agent process; a tool result larger than 32 KB is truncated with a marker.
STOP WHEN: acceptance passes OR 4 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-10 — Sessions controller: lifecycle, `seq` assignment, store writes, `agent.start/cancel/subscribe`** · T1 · cp-1 · M · depends: L1-08, Lane 2 store interface (fake until cp-1) · owns: `src/features/sessions/sessions-controller.ts`, `sessions-controller.test.ts` · contracts: `AgentSession`, `AgentEvent`, `agent.start`, `agent.cancel`, `agent.subscribe`, `sessions.get/list` · acceptance: `npx vitest run src/features/sessions/sessions-controller.test.ts`
```
TASK L1-10: Sessions controller
LANE: lane-1   BRANCH: lane-1/L1-10   WORKTREE: ../nexus-wt/L1-10
GOAL: agent.start(taskId, model): asks the git service (interface) for a worktree + branch nexus/agent-<id> from baseCommit, creates AgentSession, sends
      session.start to the ProcessHost, assigns seq (0,1,2… no gaps, per session, persisted) to every AgentEvent, writes session + events to the EventStore
      interface, writes a NexusEvent kind agent_session (orbit = base branch family), and updates Task.status. agent.subscribe replays from fromSeq then
      streams. agent.cancel → session.cancel + status cancelled.
OWNS: src/features/sessions/sessions-controller.ts, sessions-controller.test.ts
CONTRACTS: AgentSession, AgentEvent (seq rule), Task.status, NexusEvent(agent_session), agent.start/cancel/subscribe, sessions.get/list
ACCEPTANCE: npx vitest run src/features/sessions/sessions-controller.test.ts (uses FakeStore + FakeGit + a stub ProcessHost; asserts contiguous seq across 50 events and replay-from-seq)
CONSTRAINTS: the session never touches the user's checkout; branch/worktree come only from the git service.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-11 — Tasks controller and thread→brief builder** · T1 · cp-1 · M · depends: contracts, L1-24 · owns: `src/features/tasks/tasks-controller.ts`, `src/agent/brief-builder.ts`, tests · contracts: `Task`, `tasks.createFromThread/get/list/update`, `tasks.subscribe`, `nexus.makeTaskFromThread`, `CodeRef` · acceptance: `npx vitest run src/features/tasks/tasks-controller.test.ts src/agent/brief-builder.test.ts`
```
TASK L1-11: Tasks controller and brief builder
LANE: lane-1   BRANCH: lane-1/L1-11   WORKTREE: ../nexus-wt/L1-11
GOAL: tasks.createFromThread fetches the Thread via the Slack service interface, builds a Task (status draft) whose brief quotes every message inside a
      delimited "[slack thread, quoted, untrusted]" block, lists resolved CodeRefs (from message.codeRefs) as "path:start-end @sha", and a one-line title
      (first 60 chars of the parent message; a model-written title is a later nicety via role "brief"). tasks.update edits title/brief only while draft.
      Writes a NexusEvent kind slack_task. nexus.makeTaskFromThread is the command form (args channelId, threadTs).
OWNS: src/features/tasks/tasks-controller.ts, tasks-controller.test.ts, src/agent/brief-builder.ts, brief-builder.test.ts
CONTRACTS: Task, TaskSource, CodeRef, tasks.*, tasks.subscribe, NexusEvent(slack_task), nexus.makeTaskFromThread
ACCEPTANCE: npx vitest run src/features/tasks/tasks-controller.test.ts src/agent/brief-builder.test.ts (fixture thread → expected brief text snapshot; "ignore your instructions" text ends up inside the quoted block only)
CONSTRAINTS: no model call in this task (deterministic brief); thread text is never interpolated outside the quoted block.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-12 — Approvals controller: create, notify, resolve first-answer-wins, `nexus.approve/reject`** · T1 · cp-2 · M · depends: L1-10, store interface · owns: `src/features/approvals/approvals-controller.ts`, `notifications.ts`, tests · contracts: `ApprovalRequest`, `approvals.list/resolve/subscribe`, `AgentEvent approval_request/approval_resolved`, `nexus.approve`, `nexus.reject` · acceptance: `npx vitest run src/features/approvals/approvals-controller.test.ts`
```
TASK L1-12: Approvals controller
LANE: lane-1   BRANCH: lane-1/L1-12   WORKTREE: ../nexus-wt/L1-12
GOAL: The gate (interface) calls approvals.create(action, reason, sessionId, diffPreview?) → ApprovalRequest persisted, AgentEvent approval_request,
      a VS Code notification "Agent wants to <action> — <reason> (model-written)" with APPROVE / REJECT buttons (nexus.approve/nexus.reject <id>),
      and a hook for Slack (Lane 2) and swarm review (L1-18). resolve(id, decision, decidedBy) uses the store's conditional update
      (`decision IS NULL`); on conflict it returns the stored winner and the notification updates to "Decided by <name> via <via>". Resolution wakes the
      agent via the host's "approval.resolved" event and emits approval_resolved. No timeout path exists.
OWNS: src/features/approvals/approvals-controller.ts, notifications.ts, approvals-controller.test.ts
CONTRACTS: ApprovalRequest, DecidedBy, approvals.list/resolve/subscribe, approval_request/approval_resolved, nexus.approve, nexus.reject
ACCEPTANCE: npx vitest run src/features/approvals/approvals-controller.test.ts (two concurrent resolves → exactly one winner; decidedBy.via "app"; rejected → agent receives rejected)
CONSTRAINTS: decision is set only through resolve() with a human DecidedBy; the agent process has no code path to it.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-13 — Session progress message in Slack (one bot message, edited in place, final summary with code refs)** · T1 · cp-2 · M · depends: L1-10, Slack service interface (`postAsBot`, `updateBotMessage`) · **Proposed move to Lane 2 as L2-17 (Q1a)** · owns: `src/agent/progress-message.ts`, test · contracts: `AgentSession.slackProgress`, `slack.progress` (agent request), `ChatMessage.sentVia "bot"`, `CodeRef` link format · acceptance: `npx vitest run src/agent/progress-message.test.ts`
```
TASK L1-13: The session's single Slack progress message
LANE: lane-1 (or lane-2 if Q1a accepted)   BRANCH: lane-1/L1-13   WORKTREE: ../nexus-wt/L1-13
GOAL: On session start, post ONE bot message in the task's thread ("⬡ Nexus agent started on <branch> · <model>"), store its ts on the session, and from
      then on every slack.progress request and every status change edits that same message (debounced 2 s). On done: a final summary (model-written, labeled)
      plus nexus:// code-ref links + snippets for every file_edit. Never posts with a user token.
OWNS: src/agent/progress-message.ts, progress-message.test.ts
CONTRACTS: AgentSession.slackProgress, slack.progress, ChatMessage.sentVia, encodeCodeRef
ACCEPTANCE: npx vitest run src/agent/progress-message.test.ts (FakeSlack records exactly one postAsBot and N updateBotMessage calls)
CONSTRAINTS: bot token only; text passes redact() before posting.
STOP WHEN: acceptance passes OR 1.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-14 — Auth0 sign-in: PKCE in the system browser, `nexus://auth/callback`, refresh token in SecretStorage (includes smoke L1-S6)** · T2 (sponsor) · cp-2 · M · depends: Lane 2 URI handler route registration (`coderef/uri-handler.ts` delegates `nexus://auth/*` to an injected handler — interface in L2-14's first commit) · owns: `src/features/auth/**` · contracts: `auth.status`, `nexus.signIn`, `nexus.signOut`, `DecidedBy.auth0UserId` · acceptance: `npx vitest run src/features/auth/auth0-signin.test.ts` (PKCE verifier/challenge, state check, token response parsing, mocked fetch); int: `src/features/auth/auth0.int.test.ts` opens the browser once and completes the loop — **smoke L1-S6** (custom-scheme callback on Windows (verify)).
```
TASK L1-14: Auth0 sign-in for the desktop app
LANE: lane-1   BRANCH: lane-1/L1-14   WORKTREE: ../nexus-wt/L1-14
GOAL: nexus.signIn builds an Authorization Code + PKCE URL for the Native app (scopes openid profile offline_access, audience per tenant config,
      redirect nexus://auth/callback, random state), opens it with vscode.env.openExternal, receives the callback through the URI handler, exchanges
      the code at /oauth/token, stores ONLY the refresh token in SecretStorage (nexus.auth0.refresh) and keeps the access token in memory; auth.status reports
      sub/name. nexus.signOut clears both. The flow is honest Auth0 identity, never a consumer AI login.
OWNS: src/features/auth/auth0-signin.ts, session-store.ts, auth0-signin.test.ts, auth0.int.test.ts, src/register/lane-1.ts (registration lines)
CONTRACTS: auth.status, nexus.signIn, nexus.signOut, nexus://auth/callback route (coderef.ts comment)
ACCEPTANCE: npx vitest run src/features/auth/auth0-signin.test.ts
CONSTRAINTS: tenant domain/client id from settings (nexus.auth0.domain/clientId), never a secret; a state mismatch is rejected and logged without the code.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-15 — Nexus auth service (Cloudflare Worker): start CIBA, poll result** · T2 (sponsor) · cp-2 window (T+22–24) · M · depends: L1-14, H0-A6 CIBA yes · owns: `extensions/nexus/auth-service/**` · contracts: `ApprovalRequest.cibaAuthReqId`, `DecidedBy.via "auth0_push"` · acceptance: `cd auth-service && npx vitest run` (handlers with mocked Auth0: `/ciba/start` → `{authReqId, expiresIn, interval}`, `/ciba/poll` → `pending|approved|rejected|expired`; rejects a request without a valid Nexus access token); deploy is a **launch-check-class** step by the lead.
```
TASK L1-15: The Nexus auth service function
LANE: lane-1   BRANCH: lane-1/L1-15   WORKTREE: ../nexus-wt/L1-15
GOAL: Two endpoints. POST /ciba/start {approvalId, sessionId, actionLabel, approverAuth0UserId} → verifies the caller's Auth0 access token (JWKS),
      calls https://<tenant>/bc-authorize with client_id/secret (confidential app), scope "openid", login_hint {format:"iss_sub", iss, sub},
      binding_message = "NX <approvalId-8> <action-20>" (≤64 chars, only [A-Za-z0-9 +-_.,:#]), request_expiry 300 → returns {authReqId, expiresIn, interval}.
      POST /ciba/poll {authReqId} → calls /oauth/token with grant_type urn:openid:params:grant-type:ciba → maps authorization_pending/slow_down to
      "pending" (echo Retry-After), access_denied to "rejected", expired_token to "expired", success to "approved" + the approver's sub from the id_token.
      Stores nothing.
OWNS: extensions/nexus/auth-service/** (wrangler.toml, src/index.ts, src/*.test.ts, package.json)
CONTRACTS: ApprovalRequest.cibaAuthReqId, DecidedBy {via:"auth0_push", userId, auth0UserId}
ACCEPTANCE: cd auth-service && npm test
CONSTRAINTS: client secret only in the Worker's secret binding; per-user rate limit is 5 CIBA requests/min (Auth0) — never start two for one approval.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-16 — CIBA approvals in the app: start push on approval create, poll, resolve as `auth0_push`** · T2 (sponsor) · cp-2 window · M · depends: L1-12, L1-15 · owns: `src/features/approvals/ciba.ts`, `ciba.test.ts` · contracts: `ApprovalRequest.cibaAuthReqId`, `DecidedBy.via "auth0_push"`, `approvals.resolve` semantics · acceptance: `npx vitest run src/features/approvals/ciba.test.ts`
```
TASK L1-16: Phone approvals through CIBA
LANE: lane-1   BRANCH: lane-1/L1-16   WORKTREE: ../nexus-wt/L1-16
GOAL: When an ApprovalRequest is created and the signed-in user has nexus.approvals.pushTo set (an Auth0 user id of the approver), call the auth service
      /ciba/start, store cibaAuthReqId, poll at the returned interval until approved/rejected/expired or until the approval is decided elsewhere (then stop
      polling). approved → approvals.resolve(id, "approved", {via:"auth0_push", userId: sub, auth0UserId: sub}); rejected → "rejected"; expired → leave
      pending (no timeout decision, §14) and show "push expired — approve in app or Slack".
OWNS: src/features/approvals/ciba.ts, ciba.test.ts
CONTRACTS: ApprovalRequest, DecidedBy, approvals.resolve (conflict handling)
ACCEPTANCE: npx vitest run src/features/approvals/ciba.test.ts (mocked fetch; a Slack decision arriving first stops the poll and leaves decidedBy.via "slack")
CONSTRAINTS: the app never holds the Auth0 client secret; binding message never contains secrets or paths.
STOP WHEN: acceptance passes OR 1.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-17 — Swarms client (REST, text-only, time limit, budget) + Swarms as a text-role provider (includes smoke L1-S5)** · T2 · cp-2 · M · depends: L1-03, L1-23 · owns: `src/features/swarms/swarms-client.ts`, `src/models/swarms-provider.ts`, tests · contracts: `ProviderAccount(provider "swarms")`, `ModelRole`, `SwarmReview.swarmType`, `TaskPlan.swarmType` · acceptance: `npx vitest run src/features/swarms/swarms-client.test.ts src/models/swarms-provider.test.ts`; int: `swarms.int.test.ts` runs one single-agent completion and one `CouncilAsAJudge` run — **smoke L1-S5**, records shape + latency.
```
TASK L1-17: Swarms client and provider
LANE: lane-1   BRANCH: lane-1/L1-17   WORKTREE: ../nexus-wt/L1-17
GOAL: SwarmsClient.run({swarmType, task, agents?, maxLoops?}) POSTs to https://api.swarms.world (x-api-key) with tools/MCP/code-execution left off
      ((verify) exact path — expected /v1/swarm/completions — and response shape; validate with a permissive Zod schema and keep the raw text), aborts at
      timeoutMs (default 45 s), and counts calls per session against a budget (default 6). SwarmsProvider implements Provider for text roles only:
      supportsTools false, listModels returns one entry "swarms:single-agent", roleEligible(agent) false, dataLeavesMachine true, dataUse unknown.
OWNS: src/features/swarms/swarms-client.ts, swarms-client.test.ts, swarms.int.test.ts, src/models/swarms-provider.ts, swarms-provider.test.ts
CONTRACTS: ProviderAccount, ModelInfo, ModelRole, SwarmReview.swarmType, TaskPlan.swarmType
ACCEPTANCE: npx vitest run src/features/swarms/swarms-client.test.ts src/models/swarms-provider.test.ts (mocked fetch; timeout → status unavailable; budget exhausted → no call)
CONSTRAINTS: every outbound text passes redact(); nothing returned is executed.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions (REST shape, latency, whether CouncilAsAJudge/HierarchicalSwarm are accepted)
```

**L1-18 — Swarm review on commit/diff approvals (`CouncilAsAJudge`), advisory only** · T2 · cp-2 · M · depends: L1-12, L1-17 · owns: `src/features/swarms/review.ts`, `review.test.ts` · contracts: `SwarmReview`, `swarms.review.get/rerun/subscribe`, `nexus.rerunSwarmReview`, `ApprovalRequest.diffPreview` · acceptance: `npx vitest run src/features/swarms/review.test.ts`
```
TASK L1-18: Swarm review
LANE: lane-1   BRANCH: lane-1/L1-18   WORKTREE: ../nexus-wt/L1-18
GOAL: On ApprovalRequest create with action.kind "commit" (or any approval carrying diffPreview), create SwarmReview{status running} and run a CouncilAsAJudge
      swarm on {task brief, redacted diff, last test_output tail}; parse verdict/summary/judges from the text with a strict format instruction (JSON block) and a
      tolerant fallback (verdict "concerns" when unparseable but text returned); write status done; on timeout/error/budget → status unavailable. Never calls
      approvals.resolve. swarms.review.get/subscribe serve it; nexus.rerunSwarmReview re-runs for a still-pending approval.
OWNS: src/features/swarms/review.ts, review.test.ts
CONTRACTS: SwarmReview, swarms.review.*, nexus.rerunSwarmReview, ApprovalRequest.diffPreview
ACCEPTANCE: npx vitest run src/features/swarms/review.test.ts (mocked client; unavailable path; the approval stays pending/undecided in every case)
CONSTRAINTS: advisory only; labeled model-written; dataLeftMachine true.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-19 — Swarm task breakdown (`HierarchicalSwarm` → `TaskPlan` → tasks → scheduled sessions)** · T3 · cp-3 (in the plan in full; splits into decompose+accept and scheduler if a second pair of hands takes it, Q1c) · L · depends: L1-11, L1-10, L1-17 · owns: `src/features/tasks/decompose.ts`, `src/features/sessions/scheduler.ts`, tests · contracts: `TaskPlan`, `tasks.decompose`, `tasks.plan.get/accept/reject`, `nexus.decomposeTask`, `TaskSource kind "plan"` · acceptance: `npx vitest run src/features/tasks/decompose.test.ts src/features/sessions/scheduler.test.ts`
```
TASK L1-19: Break a task into subtasks with a swarm, then run them in order
LANE: lane-1   BRANCH: lane-1/L1-19   WORKTREE: ../nexus-wt/L1-19
GOAL: tasks.decompose runs a HierarchicalSwarm on the brief and parses a TaskPlan of 2–4 subtasks with dependsOn (status proposed). tasks.plan.accept creates
      one Task per subtask (source kind "plan"), sets createdTaskIds, and the Scheduler starts sessions in dependency order with max 2 concurrent
      (1 when os.totalmem() < 10 GB), each with its own branch/worktree/approvals. reject just marks rejected.
OWNS: src/features/tasks/decompose.ts, decompose.test.ts, src/features/sessions/scheduler.ts, scheduler.test.ts
CONTRACTS: TaskPlan, tasks.decompose, tasks.plan.*, nexus.decomposeTask, TaskSource(plan), agent.start
ACCEPTANCE: npx vitest run src/features/tasks/decompose.test.ts src/features/sessions/scheduler.test.ts (mocked swarm; 3-subtask fixture plan runs 1→2→3 respecting concurrency)
CONSTRAINTS: nothing starts before accept; swarm text is never executed.
STOP WHEN: acceptance passes OR 3 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-20 — Prune adapter: proxy routing per provider, pinning, receipts, one direct retry (includes smoke L1-S4)** · T2 · cp-2 · L · depends: L1-04, L1-05, L1-23 · owns: `src/models/prune-adapter.ts`, `prune-receipt.ts`, tests · contracts: `OptimizerSetting`, `ModelCallReceipt`, `AgentEvent receipt` · acceptance: `npx vitest run src/models/prune-adapter.test.ts`; int: `prune.int.test.ts` — **smoke L1-S4**: header, pinning, non-stream text call for Anthropic and Gemini, where the receipt appears, whether a tool-calling turn passes through; result decides `scope`.
```
TASK L1-20: Prune gateway adapter
LANE: lane-1   BRANCH: lane-1/L1-20   WORKTREE: ../nexus-wt/L1-20
GOAL: wrapProvider(provider, optimizer, pruneKey) returns a Provider that, when optimizer.enabled and the role is in scope, sends the call to Prune's proxy
      route for that provider ((verify) https://api.withprune.com/v1/proxy/anthropic/messages and /v1/proxy/gemini/chat/completions, header X-Prune-Key,
      provider key as user_api_key or from Prune's vault), non-streaming, with the exact model id and no routing for role "agent" (allowModelRouting forced
      false). Parses Prune's signed receipt into ModelCallReceipt (servedModel from the receipt, never assumed) and emits it; a blocked request is a clear
      error, never resent; on 5xx/timeout retries ONCE directly against the provider and marks the session note. Off → untouched provider.
OWNS: src/models/prune-adapter.ts, prune-receipt.ts, prune-adapter.test.ts, prune.int.test.ts
CONTRACTS: OptimizerSetting, ModelCallReceipt, AgentEvent(receipt)
ACCEPTANCE: npx vitest run src/models/prune-adapter.test.ts (mocked fetch: receipt parsed; agent role never routed; 5xx → one direct retry; blocked → error)
CONSTRAINTS: text passes redact() before leaving; receipt verification URL kept for nexus.openReceipt.
STOP WHEN: acceptance passes OR 3 h.
REPORT: Changed / Commits / Acceptance / Open questions (fill in the (verify) items)
```

**L1-21 — Optimizer toggle, status bar spend/savings, receipts to the store** · T2 · cp-2 · M · depends: L1-20, L1-07 · owns: `src/features/accounts/optimizer.ts`, test · contracts: `optimizer.get/set`, `receipts.list/subscribe`, `SpendSummary`, `nexus.toggleOptimizer`, `nexus.openReceipt` · acceptance: `npx vitest run src/features/accounts/optimizer.test.ts`
```
TASK L1-21: Optimize with Prune — toggle, totals, receipts
LANE: lane-1   BRANCH: lane-1/L1-21   WORKTREE: ../nexus-wt/L1-21
GOAL: optimizer.get/set persist OptimizerSetting in globalState (default DEFAULT_OPTIMIZER); nexus.toggleOptimizer flips enabled; every ModelCallReceipt is
      written to the EventStore (model_call_receipts) and broadcast on receipts.subscribe; a second status bar item shows "PRUNE $<cost> · saved $<saved>"
      for the current session; nexus.openReceipt opens Prune's verify URL for a receipt id in the browser. The picker label shows Prune's data use as
      "unknown" and "leaves machine" while on.
OWNS: src/features/accounts/optimizer.ts, optimizer.test.ts
CONTRACTS: OptimizerSetting, ModelCallReceipt, SpendSummary, optimizer.*, receipts.*, nexus.toggleOptimizer, nexus.openReceipt
ACCEPTANCE: npx vitest run src/features/accounts/optimizer.test.ts
CONSTRAINTS: default off; scope "all_roles" is settable only if a flag file written by L1-S4's int test says tool passthrough passed.
STOP WHEN: acceptance passes OR 1.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-22 — Startup defaults: home at startup and when the last editor closes; built-in AI chat/agent/Copilot off; theme default** · T1 · cp-1 · M · depends: L1-02 · owns: `src/features/home/open-home.ts`, test; core: `product.json` + `src/vs/workbench/browser/workbench.contribution.ts` defaults (lead) · contracts: `nexus.openHome` · acceptance: `npx vitest run src/features/home/open-home.test.ts` (editor-close tracker logic with a fake API); **launch check**: fresh user-data dir → opens on the home; no Chat view, no GitHub sign-in prompt; theme is Nexus Dark.
```
TASK L1-22: Startup defaults
LANE: lane-1   BRANCH: lane-1/L1-22   WORKTREE: main checkout for the core part; ../nexus-wt/L1-22 for the extension part
GOAL: Extension: on activate open nexus.home (custom editor over an untitled nexus:home URI) if no editor is open, and whenever
      onDidChangeVisibleTextEditors/tab groups report zero editors, reopen it (debounced 150 ms). Core/product: (verify) which product.json fields or
      default settings hide the built-in Chat view, agent host, and Copilot prompts at 1.145.2 (candidates: `chat.*`, `workbench.startupEditor`,
      removing the chat/copilot built-ins from the extension gallery/defaults); set workbench.colorTheme default to "Nexus Dark" (theme JSON by L3-17 if Q1b
      accepted, else here under contributes/lane-1.json themes); telemetry off.
OWNS: src/features/home/open-home.ts, open-home.test.ts; core: product.json, the smallest defaults file (lead commits core separately)
CONTRACTS: nexus.openHome
ACCEPTANCE: npx vitest run src/features/home/open-home.test.ts + launch check
CONSTRAINTS: never set workbench.editor.showTabs; never remove the git extension.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-23 — Secret-pattern redaction module (shared)** · T1 · cp-1 · S · depends: contracts · owns: `src/shared/redact.ts`, `redact.test.ts` · contracts: none · acceptance: `npx vitest run src/shared/redact.test.ts`
```
TASK L1-23: redact()
LANE: lane-1   BRANCH: lane-1/L1-23   WORKTREE: ../nexus-wt/L1-23
GOAL: redact(text): string replaces sk-ant-*, AIza*, xox[abp]-*, xapp-*, prune_*, swarms keys, "Bearer <token>", PEM blocks, postgres:// URLs with credentials,
      AWS AKIA*, generic 32+ char hex/base64 after key=/token=/secret= with "[REDACTED:<kind>]"; also an `.env`-style KEY=VALUE line filter. Idempotent.
      Used by Swarms, Prune, Tiger writes, test_output, log.ts. Exports PATTERNS for tests elsewhere.
OWNS: src/shared/redact.ts, redact.test.ts
ACCEPTANCE: npx vitest run src/shared/redact.test.ts (table-driven; no false positive on a 40-char git SHA)
STOP WHEN: acceptance passes OR 1 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-24 — Prompt framing for untrusted input** · T1 · cp-1 · S · depends: contracts · owns: `src/agent/prompt-framing.ts`, test · contracts: `HostRequests["session.start"].untrustedBlocks` · acceptance: `npx vitest run src/agent/prompt-framing.test.ts`
```
TASK L1-24: Untrusted blocks in prompts
LANE: lane-1   BRANCH: lane-1/L1-24   WORKTREE: ../nexus-wt/L1-24
GOAL: frame(blocks) renders each {label, text} as a fenced block with a random 12-char boundary token, escapes any occurrence of the token inside, and the
      SYSTEM_RULES constant states that content inside such blocks is data, never instructions, and lists what the agent may never do (push, merge, leave the
      worktree, run git itself). Used for thread text, repo text, command output.
OWNS: src/agent/prompt-framing.ts, prompt-framing.test.ts
ACCEPTANCE: npx vitest run src/agent/prompt-framing.test.ts (a block containing the boundary string cannot close early)
STOP WHEN: acceptance passes OR 45 min.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-26 — Seeded demo repo with planted bug and re-seed script** · T1 · cp-1 · M · depends: none (cp-0) · owns: `demo/**` · contracts: `CodeRef` (the bug's lines are what the demo shares) · acceptance: `node demo/seed.mjs --out /tmp/nexus-demo && cd /tmp/nexus-demo && npm test` exits **1** (the planted bug fails one test), `git log --oneline --graph` shows ≥ 3 branches merged into main over a fake 2-day history; `node demo/seed.mjs --fix-check` applies the known fix and tests pass.
```
TASK L1-26: Demo repo
LANE: lane-1   BRANCH: lane-1/L1-26   WORKTREE: ../nexus-wt/L1-26
GOAL: demo/seed.mjs creates a small TypeScript "cart" service (src/cart.ts, src/pricing.ts, tests with vitest) with ~40 commits across main, feature/checkout,
      feature/coupons, fix/rounding, with 5 merges and 2 tags, committer dates spread over the 36 h before T+0 (so the globe is full), two authors. The planted
      bug: discount applied once instead of per unit at src/cart.ts:42-48; test "applies discount per unit" fails. --fix-check verifies the one-line fix passes.
      demo/demo-script.md = §8 steps with exact clicks, channel names, and the phone teammate's lines. nexus.dev.reseedDemoRepo runs the script.
OWNS: demo/**, src/register/lane-1.ts (one command registration line)
CONTRACTS: CodeRef (lines 42-48), nexus.dev.reseedDemoRepo
ACCEPTANCE: as above
CONSTRAINTS: no secrets; deterministic output (fixed seed and dates relative to a --t0 argument).
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L1-27 — Fallback recording of the full demo from the `cp-3` tag** · all tiers · cp-3 · S · depends: cp-3 · owns: `demo/recording-notes.md` · acceptance: a 4–6 minute screen recording file exists (outside the repo), named in `progress/lane-1.md`, covering §8 steps 0–8 with the phone shown via a second camera or screen mirror. Human task; no brief.

### 5.2 Lane 2 — Brandon (extension backend: Slack, git, events/TigerData, code refs, bridge, gate, Token Vault)

**L2-01 — Webview bridge: host wrapper, CSP, router over the typed protocol, `app.ping`** · T1 · cp-1 · L · depends: contracts · owns: `src/bridge/**` · contracts: `Envelope`, `Requests`, `Subscriptions`, `app.ping` · acceptance: `npx vitest run src/bridge/router.test.ts src/bridge/host.test.ts`. **Interface drop by T+2:30:** `src/bridge/types.ts` (`BridgeRouter.handle(name, fn)`, `BridgeRouter.publish(sub, evt)`) so Lanes 1 and 3 can code against it.
```
TASK L2-01: The webview bridge
LANE: lane-2   BRANCH: lane-2/L2-01   WORKTREE: ../nexus-wt/L2-01
GOAL: createWebviewHost(ctx, viewId, entry) builds a WebviewView/Panel with a strict CSP (default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…' plus
      theme vars; img-src vscode-resource/data; connect-src 'none'), localResourceRoots = [media/], and HTML that loads media/<entry>.js. Router: parses every
      inbound Envelope with Zod, validates req bodies against Requests[name].req, calls the registered handler, validates res against .res before posting;
      unknown names dropped + logged; subscriptions tracked per webview and disposed with it; errors mapped to the frozen error codes. app.ping implemented
      here (machineId from globalState, tPlus from progress T0 setting).
OWNS: src/bridge/host.ts, router.ts, types.ts, fake-bridge-server.ts (in-memory transport for tests), router.test.ts, host.test.ts
CONTRACTS: Envelope, Requests, Subscriptions, error codes, app.ping
ACCEPTANCE: npx vitest run src/bridge/router.test.ts src/bridge/host.test.ts (invalid body → invalid_request; unknown → dropped; sub/unsub lifecycle; CSP string contains the nonce and no remote source)
CONSTRAINTS: a webview never receives a secret — add a dev assertion that res bodies never match redact PATTERNS.
STOP WHEN: acceptance passes OR 3 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-02 — Slack Web API with the user token: channels, history (paginated), thread, users, post as user** · T1 · cp-1 · L · depends: contracts · owns: `src/services/slack/web-client.ts`, `types.ts`, `fake-slack.ts`, tests · contracts: `Channel`, `ChatMessage`, `Thread`, `SlackUser`, `SlackStatus`, `slack.status/channels/history/thread/users/post` · acceptance: `npx vitest run src/services/slack/web-client.test.ts`. **Interface drop by T+2:30:** `src/services/slack/types.ts` (`SlackService` with `postAsUser`, `postAsBot`, `updateBotMessage`, `channels`, `history`, `thread`, `users`, `status`, `onMessage`) + `fake-slack.ts` seeded from fixtures.
```
TASK L2-02: Slack reads and posting as the user
LANE: lane-2   BRANCH: lane-2/L2-02   WORKTREE: ../nexus-wt/L2-02
GOAL: Using @slack/web-api with the user's xoxp token (from SecretStorage nexus.slack.user, or the Token Vault provider in L2-15, or env in dev): conversations.list
      (member channels; botIsMember via conversations.members or a cached bot-membership check (verify)), conversations.history with cursor paging, conversations.replies,
      users.info batched, chat.postMessage as the user (sentVia "user"). Maps Slack payloads to contracts; extracts nexus:// links into codeRefs via decodeCodeRef;
      text kept verbatim (untrusted). slack.status reports postsAs from auth.test and userTokenSource.
OWNS: src/services/slack/web-client.ts, types.ts, fake-slack.ts, web-client.test.ts, src/register/lane-2.ts (registration lines)
CONTRACTS: Channel, ChatMessage, Thread, SlackUser, SlackStatus, slack.status/channels/history/thread/users/post
ACCEPTANCE: npx vitest run src/services/slack/web-client.test.ts (WebClient injected/mocked with recorded JSON; paging; codeRef extraction; postsAs)
CONSTRAINTS: user token never used for anything the agent says; never poll history.
STOP WHEN: acceptance passes OR 3 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-03 — Socket Mode (Bolt) live events, bot posts + `chat.update`, Block Kit approval buttons, human-only interactivity (includes smoke L2-S1)** · T1 · cp-1 (events) / cp-2 (buttons) · L · depends: L2-02 · owns: `src/services/slack/socket.ts`, `bot.ts`, `interactivity.ts`, tests, `slack.int.test.ts` · contracts: `slack.subscribe`, `ChatMessage.sentVia "bot"`, `ApprovalRequest.slackMessage`, `approvals.resolve` (via "slack") · acceptance: `npx vitest run src/services/slack/socket.test.ts src/services/slack/bot.test.ts src/services/slack/interactivity.test.ts`; int **L2-S1**: `slack.int.test.ts` from a real extension-host run receives one message and one button click (run via the lead's launch, documented in `progress/lane-2.md`).
```
TASK L2-03: Live Slack: Socket Mode, bot posts, approval buttons
LANE: lane-2   BRANCH: lane-2/L2-03   WORKTREE: ../nexus-wt/L2-03
GOAL: Bolt App in socketMode with the xapp token, bot token xoxb: message / message_changed events → ChatMessage → slack.subscribe publish + cache write. bot.ts:
      postAsBot(channel, text|blocks, threadTs) and updateBotMessage(channel, ts, text|blocks). interactivity.ts: the approval message is Block Kit with
      APPROVE/REJECT buttons (action_id nexus.approve / nexus.reject, value approvalId); on block_actions, verify body.user is a human member (users.info
      is_bot false, not the app's bot user), then call the injected approvals.resolve(id, decision, {via:"slack", userId}) and update the message to
      "Decided by @name" (or the real winner on conflict). Swarm verdict section rendered when a SwarmReview is passed (L1-18 hook).
OWNS: src/services/slack/socket.ts, bot.ts, interactivity.ts, socket.test.ts, bot.test.ts, interactivity.test.ts, slack.int.test.ts
CONTRACTS: slack.subscribe, ChatMessage(sentVia bot, blocks), ApprovalRequest.slackMessage, DecidedBy(via slack), SwarmReview (render only)
ACCEPTANCE: npx vitest run src/services/slack/socket.test.ts src/services/slack/bot.test.ts src/services/slack/interactivity.test.ts (bot-user click rejected; human click resolves once)
CONSTRAINTS: Socket Mode runs in the extension host but every handler is async and short; reconnect with backoff; (verify) events need the bot in the channel.
STOP WHEN: acceptance passes OR 3.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-04 — Local Slack message cache (serve-first, append on live events)** · T1 · cp-2 · M · depends: L2-02 · owns: `src/services/slack/cache.ts`, test · contracts: `slack.history.fromCache`, `ChatMessage` · acceptance: `npx vitest run src/services/slack/cache.test.ts`
```
TASK L2-04: Slack cache
LANE: lane-2   BRANCH: lane-2/L2-04   WORKTREE: ../nexus-wt/L2-04
GOAL: JSONL per channel under globalStorageUri/slack/<channelId>.jsonl, in-memory index by ts; history() serves from cache first (fromCache true) and fetches only
      the gap newer than the latest cached ts; live events append; message_changed replaces; pending echo (clientId) is replaced by Slack's confirmed copy.
OWNS: src/services/slack/cache.ts, cache.test.ts
CONTRACTS: slack.history (fromCache, nextCursor), ChatMessage.pending/failed
ACCEPTANCE: npx vitest run src/services/slack/cache.test.ts (tmp dir; reopen = same messages; gap fetch logic with a fake client)
STOP WHEN: acceptance passes OR 1.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-05 — Git service: built-in git API + CLI (log, show, branches, commit detail, workspaceId)** · T1 · cp-1 · M · depends: contracts · owns: `src/services/git/git-api.ts`, `git-cli.ts`, `types.ts`, `fake-git.ts`, tests · contracts: `git.commit.show`, `git.branches`, `CodeRef.workspaceId`, `Sha` · acceptance: `npx vitest run src/services/git/git-cli.test.ts` (runs real `git` against a temp repo created in the test — local binary, no network). **Interface drop by T+2:30:** `types.ts` (`GitService`: `log`, `show`, `branches`, `headOf`, `createWorktree`, `removeWorktree`, `diff`, `commitIn`, `merge`, `workspaceId`).
```
TASK L2-05: Git service
LANE: lane-2   BRANCH: lane-2/L2-05   WORKTREE: ../nexus-wt/L2-05
GOAL: git-api.ts gets vscode.git exports (getAPI(1), (verify) version) for repo discovery and branch list; git-cli.ts shells `git` with explicit args (never a shell
      string) for: log --format with %H %P %an %cI %s --all, show --stat, branches, workspaceId = sha1 of `git rev-list --max-parents=0 HEAD` first root. git.commit.show
      and git.branches handlers.
OWNS: src/services/git/git-api.ts, git-cli.ts, types.ts, fake-git.ts, git-cli.test.ts, src/register/lane-2.ts (lines)
CONTRACTS: git.commit.show, git.branches, Sha, CodeRef.workspaceId
ACCEPTANCE: npx vitest run src/services/git/git-cli.test.ts
CONSTRAINTS: execFile only; cwd always the repo root or a worktree path we created.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-06 — Session worktrees, gated commit, merge agent branch (clean abort on conflict)** · T1 (worktree/commit) · T3 (merge) · cp-1 / cp-3 · M · depends: L2-05 · owns: `src/services/git/worktrees.ts`, `merge.ts`, tests · contracts: `AgentSession.branch/worktreePath/baseCommit`, `AgentEvent commit`, `git.mergeAgentBranch`, `nexus.mergeAgentBranch` (handler; UI in L3-15) · acceptance: `npx vitest run src/services/git/worktrees.test.ts src/services/git/merge.test.ts` (temp repos)
```
TASK L2-06: Worktrees, commits, merges for agent sessions
LANE: lane-2   BRANCH: lane-2/L2-06   WORKTREE: ../nexus-wt/L2-06
GOAL: createWorktree(sessionId, baseCommit) → `git worktree add <globalStorage>/sessions/<id> -b nexus/agent-<id> <baseCommit>`; diff(worktree) → unified diff;
      commitIn(worktree, message, author = the human's git identity + trailer "Nexus-Agent: <sessionId>") → sha; removeWorktree. merge.ts: mergeAgentBranch(sessionId)
      in the USER's repo: `git merge --no-ff nexus/agent-<id>`; on conflict `git merge --abort` and return {ok:false, message}. Never push.
OWNS: src/services/git/worktrees.ts, merge.ts, worktrees.test.ts, merge.test.ts
CONTRACTS: AgentSession fields, AgentEvent(commit), git.mergeAgentBranch
ACCEPTANCE: npx vitest run src/services/git/worktrees.test.ts src/services/git/merge.test.ts (conflict case leaves the repo clean: `git status --porcelain` empty)
CONSTRAINTS: the user's checkout is only touched by merge(), and only its index/HEAD by a clean merge.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-07 — Git watcher → `NexusEvent`s (commit, merge, branch, tag; orbit mapping)** · T1 · cp-1 · M · depends: L2-05, L2-08 interface · owns: `src/services/git/watcher.ts`, test · contracts: `NexusEvent`, `orbitOf`, `events.subscribe` · acceptance: `npx vitest run src/services/git/watcher.test.ts`
```
TASK L2-07: Git watcher
LANE: lane-2   BRANCH: lane-2/L2-07   WORKTREE: ../nexus-wt/L2-07
GOAL: On activation and on changes under .git/refs, .git/packed-refs, .git/HEAD (FileSystemWatcher + 500 ms debounce): diff the known ref→sha map, walk new commits
      (`git log --all` bounded to the last 30 days) and emit NexusEvents: commit (title = subject, actor from author, kind agent if trailer Nexus-Agent), merge
      (2+ parents: fromOrbit from the second parent's branch family via `git name-rev`/branch --contains heuristic), branch (new ref), tag. ids are
      `${workspaceId}:${kind}:${sha}` so re-walks never duplicate. Force pushes only add.
OWNS: src/services/git/watcher.ts, watcher.test.ts
CONTRACTS: NexusEvent, orbitOf, EventStore.write (interface), events.subscribe (publish)
ACCEPTANCE: npx vitest run src/services/git/watcher.test.ts (temp repo: commit, branch, merge, tag produce exactly 4 new events with right orbits; a second scan adds 0)
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-08 — Event store interface + local JSONL store + outbox + query/search/subscribe** · T1 · cp-1 · L · depends: contracts · owns: `src/services/events/store.ts`, `local-store.ts`, `search.ts`, `fake-store.ts`, tests · contracts: `NexusEvent`, `EventQuery`, `events.query/search/subscribe`, `store.status/subscribe`, plus write/read of `AgentSession`, `AgentEvent`, `ApprovalRequest`, `SwarmReview`, `TaskPlan`, `Task`, `ModelCallReceipt` · acceptance: `npx vitest run src/services/events/local-store.test.ts src/services/events/search.test.ts`. **Interface drop by T+2:30:** `store.ts` + `fake-store.ts` seeded with `scriptedNexusEvents()` and `demoScenario`.
```
TASK L2-08: The store interface and the local copy
LANE: lane-2   BRANCH: lane-2/L2-08   WORKTREE: ../nexus-wt/L2-08
GOAL: EventStore interface: putEvent, queryEvents, searchEvents, subscribeEvents, putSession/getSession/listSessions, appendAgentEvent (returns seq)/replayAgentEvents,
      putApproval, resolveApproval(id, decision, decidedBy) → {won:boolean, approval} (conditional), listApprovals, subscribeApprovals, putReview/getReview,
      putPlan/getPlan, putTask/getTask/listTasks, putReceipt/listReceipts, status(). LocalStore: append-only JSONL per workspace in globalStorage
      (events.jsonl, sessions.jsonl, …) + outbox.jsonl of writes not yet confirmed remotely; in-memory indexes; search = case-insensitive substring over
      title/sha/orbit/actor + simple ranking (newest first, title match > sha match). Every write passes redact() on free text.
OWNS: src/services/events/store.ts, local-store.ts, search.ts, fake-store.ts, local-store.test.ts, search.test.ts
CONTRACTS: all stored types; events.query/search/subscribe; store.status/subscribe
ACCEPTANCE: npx vitest run src/services/events/local-store.test.ts src/services/events/search.test.ts (10k scripted events: query window < 50 ms; conditional resolve wins once; reopen from disk equals in-memory)
STOP WHEN: acceptance passes OR 3.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-09 — Tiger Cloud schema SQL (hypertables, tables, indexes) run at hour 0** · T2 (sponsor) · cp-1 · M · depends: contracts · owns: `sql/001_schema.sql`, `sql/README.md`, `src/services/events/schema.int.test.ts` · contracts: every stored type · acceptance: int only: `npm run test:int -- schema` with `TIGER_URL` applies the SQL idempotently and round-trips one row per table. (Written during H0-B4; this task finishes it.)
```
TASK L2-09: Tiger Cloud schema
LANE: lane-2   BRANCH: lane-2/L2-09   WORKTREE: ../nexus-wt/L2-09
GOAL: CREATE EXTENSION IF NOT EXISTS timescaledb; tables events(id text, at timestamptz, kind, orbit, from_orbit, title, actor_name, actor_kind, target jsonb,
      workspace_id, machine_id, auth0_user_id, PRIMARY KEY(id, at)) → create_hypertable('events','at'); agent_events(session_id, seq, at, type, payload jsonb,
      PK(session_id, seq, at)) hypertable; model_call_receipts(call_id, at, …) hypertable; sessions, approvals(decision nullable, decided_by jsonb, decided_at),
      swarm_reviews, task_plans, tasks (plain tables, PK id). Indexes on (orbit, at desc), (workspace_id, at desc), approvals(decision) WHERE decision IS NULL.
      All text columns are expected pre-redacted. One team role (§6 out of scope: per-user roles).
OWNS: sql/001_schema.sql, sql/README.md, src/services/events/schema.int.test.ts
ACCEPTANCE: int test above (idempotent re-run)
STOP WHEN: acceptance passes OR 1.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-10 — Tiger store adapter (`pg` over TLS): writes for all tables, dedupe, conditional approval update, read-through with local fallback** · T2 (sponsor) · cp-2 · L · depends: L2-08, L2-09 · owns: `src/services/events/tiger-store.ts`, `combined-store.ts`, tests, `tiger.int.test.ts` · contracts: as L2-08 · acceptance: `npx vitest run src/services/events/tiger-store.test.ts src/services/events/combined-store.test.ts` (pg client mocked; SQL text snapshot-tested); int: `tiger.int.test.ts` against the team service.
```
TASK L2-10: Tiger Cloud adapter and the combined store
LANE: lane-2   BRANCH: lane-2/L2-10   WORKTREE: ../nexus-wt/L2-10
GOAL: TigerStore implements EventStore with parameterised SQL: INSERT … ON CONFLICT DO NOTHING for events/agent_events/receipts (same id from two machines → one
      row); UPSERT sessions/tasks/reviews/plans; resolveApproval = `UPDATE approvals SET decision=$2, decided_by=$3, decided_at=now() WHERE id=$1 AND decision IS NULL
      RETURNING *` → won = rowCount 1, else SELECT the winner. CombinedStore: write local first, enqueue outbox, write remote async; reads go remote with a 1.5 s
      budget, else local; status() online/outboxDepth. Connection string from SecretStorage nexus.tiger.url; TLS required.
OWNS: src/services/events/tiger-store.ts, combined-store.ts, tiger-store.test.ts, combined-store.test.ts, tiger.int.test.ts
CONTRACTS: EventStore (all), ApprovalRequest first-answer-wins semantics
ACCEPTANCE: npx vitest run src/services/events/tiger-store.test.ts src/services/events/combined-store.test.ts (remote down → reads local, writes queue; conflict path)
CONSTRAINTS: `pg` only (no native module); never log the URL.
STOP WHEN: acceptance passes OR 3.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-11 — Live sync: `LISTEN/NOTIFY` with 2-second polling fallback, outbox flush on reconnect** · T2 (sponsor) · cp-2 · M · depends: L2-10 · owns: `src/services/events/sync.ts`, `sql/003_notify.sql`, tests · contracts: `events.subscribe`, `approvals.subscribe`, `agent.subscribe` (remote events), `store.subscribe` · acceptance: `npx vitest run src/services/events/sync.test.ts`
```
TASK L2-11: Cross-machine sync
LANE: lane-2   BRANCH: lane-2/L2-11   WORKTREE: ../nexus-wt/L2-11
GOAL: 003_notify.sql adds AFTER INSERT/UPDATE triggers doing pg_notify('nexus', json {table, id, session_id?}) on events, agent_events, approvals, swarm_reviews,
      sessions, receipts. sync.ts: if H0-B4 marked NOTIFY ok (setting nexus.tiger.notify=true), hold one LISTEN connection and fetch the changed rows; otherwise
      poll every 2 s with `WHERE updated_at > $since` (add updated_at columns in 003). Incoming rows from OTHER machines are written to the local store and published
      on the subscriptions. On reconnect, flush the outbox in order. Backoff on errors; status() flips online/offline.
OWNS: src/services/events/sync.ts, sync.test.ts, sql/003_notify.sql
CONTRACTS: subscriptions above, store.subscribe
ACCEPTANCE: npx vitest run src/services/events/sync.test.ts (fake remote: a session's agent events written on "machine B" appear on "machine A" in order with seq intact; outbox flushes after an outage)
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-12 — Continuous aggregate (events per orbit per 15 min) + `events.activity`** · T3 (sponsor) · cp-3 · M · depends: L2-10 · owns: `sql/002_aggregates.sql`, `src/services/events/activity.ts`, tests · contracts: `ActivityBucket`, `events.activity` · acceptance: `npx vitest run src/services/events/activity.test.ts` (local fallback buckets computed from JSONL; SQL text snapshot); int: aggregate returns rows on the team service (**verify** refresh policy on Tiger Cloud free plan).
```
TASK L2-12: Activity strip data
LANE: lane-2   BRANCH: lane-2/L2-12   WORKTREE: ../nexus-wt/L2-12
GOAL: CREATE MATERIALIZED VIEW events_15m WITH (timescaledb.continuous) AS SELECT time_bucket('15 minutes', at) bucket, orbit, count(*) FROM events GROUP BY 1,2;
      add_continuous_aggregate_policy(start_offset 2 days, end_offset 1 minute, schedule 1 minute). events.activity(from,to) reads the view with
      real-time aggregation; offline it buckets the local store the same way so the strip never disappears.
OWNS: sql/002_aggregates.sql, src/services/events/activity.ts, activity.test.ts
CONTRACTS: ActivityBucket, events.activity
ACCEPTANCE: npx vitest run src/services/events/activity.test.ts
STOP WHEN: acceptance passes OR 1.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-13 — Agent gate: path resolution, fs tools, command allowlist, approval hooks, `cmd.run`** · T1 · cp-1 · L · depends: contracts, L2-06 interface · owns: `src/services/gate/**` · contracts: `AgentRequests fs.*, cmd.run, git.diff, git.commit, approval.request`, `ApprovalAction`, `AgentEvent file_edit/test_output` · acceptance: `npx vitest run src/services/gate/gate.test.ts`. **Interface drop by T+2:30:** `src/services/gate/types.ts` (`Gate.handle(sessionCtx, request)`; `ApprovalsHook.create(...)`).
```
TASK L2-13: The gate
LANE: lane-2   BRANCH: lane-2/L2-13   WORKTREE: ../nexus-wt/L2-13
GOAL: Every AgentRequest from a session is handled here with its sessionCtx {worktreePath, allowlist}. fs.read/list: path.resolve inside worktree else
      error; fs.write outside worktree → ApprovalRequest(write_outside_scope) and wait; after any fs.write, run `git diff` and emit AgentEvent file_edit with the
      real diff. cmd.run: command on the workspace allowlist (setting nexus.agent.allowedCommands, starts empty; `nexus.approve` for a run_command offers
      "Approve and allow next time") → spawn in the worktree with timeout, capture tails (redacted), emit test_output; else ApprovalRequest(run_command) and wait,
      no timeout. git.commit → ApprovalRequest(commit, diffPreview = redacted diff) and on approval commitIn(). approval.request(other) likewise.
      The agent never gets a shell string interpreted by the host beyond `cmd.run`'s argv split with shell-quote.
OWNS: src/services/gate/gate.ts, fs.ts, commands.ts, types.ts, gate.test.ts
CONTRACTS: AgentRequests, ApprovalAction, AgentEvent(file_edit, test_output), ApprovalsHook (Lane 1's controller behind an interface)
ACCEPTANCE: npx vitest run src/services/gate/gate.test.ts (temp worktree; "../x" write → approval; allowlisted echo runs; non-allowlisted waits until the test resolves it; diff comes from git)
STOP WHEN: acceptance passes OR 3.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-14 — Code refs: create from selection, `nexus://` URI handler, open at commit (stale → read-only), Slack snippet** · T2 · cp-2 · M · depends: L2-05 · owns: `src/services/coderef/**` · contracts: `CodeRef`, `encode/decodeCodeRef`, `coderef.create/open`, `nexus.openCodeRef`, URI routes `auth/*`, `session/*`, `approval/*` (delegated) · acceptance: `npx vitest run src/services/coderef/resolve.test.ts src/services/coderef/uri-handler.test.ts`. **Interface drop by T+2:30:** `uri-handler.ts` with `registerRoute(prefix, handler)` so L1-14 can register `auth/callback`.
```
TASK L2-14: Code references and the URI handler
LANE: lane-2   BRANCH: lane-2/L2-14   WORKTREE: ../nexus-wt/L2-14
GOAL: coderef.create(path, start, end) → CodeRef at HEAD's full SHA (error if the file is dirty: offer "commit first"), link = encodeCodeRef, snippet = the lines
      (≤ 12, fenced). coderef.open: if HEAD contains commit and the file is unchanged since → open the live file and reveal the lines; else open a read-only
      document from `git show <commit>:<path>` (virtual document provider nexus-git:) with an information message "open current version". vscode.window.registerUriHandler:
      validate with decodeCodeRef / route table; unknown → ignored. Slack text: "<link> ```snippet```".
OWNS: src/services/coderef/create.ts, resolve.ts, uri-handler.ts, slack-format.ts, *.test.ts, src/register/lane-2.ts (lines)
CONTRACTS: CodeRef, encode/decodeCodeRef, coderef.create/open, nexus.openCodeRef, routes
ACCEPTANCE: npx vitest run src/services/coderef/resolve.test.ts src/services/coderef/uri-handler.test.ts (temp repo; stale and fresh cases; malformed URIs ignored)
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-15 — Slack user token from Auth0 Token Vault (refresh-token exchange), in memory only, manual fallback** · T2 (sponsor) · cp-2 · M · depends: L2-02, L1-14 (refresh token available) · owns: `src/services/slack/token-vault.ts`, test, `token-vault.int.test.ts` · contracts: `SlackStatus.userTokenSource`, `nexus.connectSlack` · acceptance: `npx vitest run src/services/slack/token-vault.test.ts` (mocked fetch); int completes a real exchange — **verify** Connected Accounts flow for Slack.
```
TASK L2-15: Token Vault for Slack
LANE: lane-2   BRANCH: lane-2/L2-15   WORKTREE: ../nexus-wt/L2-15
GOAL: nexus.connectSlack: if signed in (auth.status), POST https://<tenant>/oauth/token with grant_type urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token,
      client_id, subject_token = the Auth0 refresh token, subject_token_type urn:ietf:params:oauth:token-type:refresh_token, connection = the Slack connection name,
      requested_token_type http://auth0.com/oauth/token-type/federated-connection-access-token → the Slack user access token, held in memory, re-exchanged on 401/expiry.
      If the user has not connected Slack in Auth0 yet, open the Connected Accounts flow URL (verify) in the browser and retry. Fallback: paste an xoxp token into
      SecretStorage (userTokenSource "manual"). SlackService picks token-vault first.
OWNS: src/services/slack/token-vault.ts, token-vault.test.ts, token-vault.int.test.ts
CONTRACTS: SlackStatus.userTokenSource, nexus.connectSlack
ACCEPTANCE: npx vitest run src/services/slack/token-vault.test.ts
CONSTRAINTS: the Slack token never touches disk; the Auth0 refresh token is read from SecretStorage through Lane 1's session-store interface.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-16 — `ui.openTarget` routing + `nexus.openSession/openCommit` handlers' backend** · T1 · cp-1 · S · depends: L2-05, L2-14 · owns: `src/services/coderef/open-target.ts`, test · contracts: `ui.openTarget`, `EventTarget` · acceptance: `npx vitest run src/services/coderef/open-target.test.ts`
```
TASK L2-16: ui.openTarget
LANE: lane-2   BRANCH: lane-2/L2-16   WORKTREE: ../nexus-wt/L2-16
GOAL: commit → vscode.commands.executeCommand('nexus.openCommit', sha) (Lane 3's command opens the diff view); session → 'nexus.openSession' sessionId; thread →
      reveal the Slack view and post a focus message on its bridge ("chat.focusThread"). Unknown → invalid_request.
OWNS: src/services/coderef/open-target.ts, open-target.test.ts
ACCEPTANCE: npx vitest run src/services/coderef/open-target.test.ts (commands recorded via an injected executor)
STOP WHEN: acceptance passes OR 45 min.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L2-17 — (only if Q1a accepted) Session progress message** · = L1-13 moved; owns `src/services/slack/progress-message.ts`; brief identical to L1-13 with LANE lane-2.

### 5.3 Lane 3 — Elkin (every webview UI)

Every Lane 3 acceptance also runs `npm run build:webviews` (the entry must build) and the kit's style test (`webviews/shared/style.test.tsx`: computed `border-radius` 0, control height 22/20 px, no `box-shadow`, purple accent var) against the view's root.

**L3-01 — Shared webview kit: Vite build, theme tokens, sharp components, typed bridge client, fixture bridge** · T1 · cp-1 · L · depends: contracts · owns: `webviews/shared/**`, `scripts/build-webviews.mjs`, `webviews/tsconfig.json`, `vite.config.ts` (Lane 3 writes the initial; Lane 1 owns afterwards) · contracts: `Envelope`, `Requests`, `Subscriptions` (client side) · acceptance: `npx vitest run webviews/shared && npm run build:webviews`. **Drop by T+2:30:** component stubs + `fakeBridge.ts` so L3-02/L3-08 can start.
```
TASK L3-01: The kit
LANE: lane-3   BRANCH: lane-3/L3-01   WORKTREE: ../nexus-wt/L3-01
GOAL: theme.css maps VS Code theme vars (--vscode-foreground, -editor-background, -focusBorder, …) to kit tokens and fixes geometry per §6: --nx-radius:0;
      --nx-control-h:22px; --nx-toolbar-h:20px; --nx-font-ui:11px/12px; data in var(--vscode-editor-font-family) with font-variant-numeric: tabular-nums;
      --nx-accent: purple (#8b5cf6 family, derived once, not from the theme). Components: Button (uppercase label, optional kbd hint), Input, Select, Tabs, Table,
      StatusLine, KeyValueRow, Chip, Toolbar, EmptyState (one line + one action). bridgeClient.ts: request<N>(name, body) with Zod validation of responses,
      subscribe<N>(name, body, cb) → unsubscribe; fakeBridge.ts answers every request/subscription from fixtures and scripted streams (with a timer for live
      events) so any view runs in a browser via `vite` dev server with ?fake=1. build-webviews.mjs builds each webviews/<name>/index.html to media/<name>/.
OWNS: webviews/shared/**, scripts/build-webviews.mjs, webviews/tsconfig.json, vite.config.ts (initial), webviews/shared/style.test.tsx
CONTRACTS: Envelope, Requests, Subscriptions (client side)
ACCEPTANCE: npx vitest run webviews/shared && npm run build:webviews
CONSTRAINTS: no third-party component library; no imports of vscode/node; no shadows/gradients/animation.
STOP WHEN: acceptance passes OR 3.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L3-02 — Globe core: r3f wireframe planet, one orbit per family, angle = time, time window** · T1 · cp-1 · L · depends: L3-01 · owns: `webviews/globe/scene/**`, `webviews/globe/model/**`, tests · contracts: `NexusEvent`, `events.query`, `TimeWindow`, `ui.setTimeWindow` · acceptance: `npx vitest run webviews/globe/model` (pure layout math: `angleFor(at, now, window)`, `orbitLayout(families)` radii/tilts share one axis; now-line alignment) + build.
```
TASK L3-02: Globe core
LANE: lane-3   BRANCH: lane-3/L3-02   WORKTREE: ../nexus-wt/L3-02
GOAL: Port docs/reference/globe-prototype.html to react-three-fiber: wireframe sphere (lat rings + meridians, purple, slow rotation), orbits = one ring per orbit family
      from events.query over the window (main innermost untilted, others at increasing radius and tilt around ONE shared axis so all "now" points sit on the now line),
      commits as small spheres at angle = (now - at)/window × 2π measured back from the now line; events older than the window hidden; window selector 24h/36h/7d/30d.
      model/ holds pure functions tested with vitest; scene/ holds r3f components. Instanced meshes when visible events > 2,000.
OWNS: webviews/globe/scene/**, webviews/globe/model/**, webviews/globe/model/*.test.ts, webviews/globe/index.html, main.tsx, App.tsx
CONTRACTS: NexusEvent, orbit, events.query, TimeWindow
ACCEPTANCE: npx vitest run webviews/globe/model && npm run build:webviews
CONSTRAINTS: globe stays purple regardless of theme; text/chrome use theme vars; runs against fakeBridge with scriptedNexusEvents(36h) at 60 fps on an integrated GPU.
STOP WHEN: acceptance passes OR 4 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L3-03 — Merge arcs, activity rings (cubes/diamonds), live insert at the now line** · T1 · cp-1 · M · depends: L3-02 · owns: `webviews/globe/scene/arcs.tsx`, `rings.tsx`, `live.ts`, tests in model · contracts: `NexusEvent kind merge/agent_session/slack_task`, `fromOrbit`, `events.subscribe` · acceptance: `npx vitest run webviews/globe/model/arcs.test.ts` + build.
```
TASK L3-03: Arcs, rings, live
LANE: lane-3   BRANCH: lane-3/L3-03   WORKTREE: ../nexus-wt/L3-03
GOAL: merge → a bezier arc from fromOrbit's ring to orbit's ring at the merge angle; agent_session → cube and slack_task → diamond on an outer activity ring just
      outside that orbit's ring (per family); events.subscribe inserts a new marker at the now line with a <100 ms scale-in; markers drift as time passes (angle recomputed per frame).
OWNS: webviews/globe/scene/arcs.tsx, rings.tsx, live.ts, webviews/globe/model/arcs.ts, arcs.test.ts
CONTRACTS: NexusEvent(merge, agent_session, slack_task), events.subscribe
ACCEPTANCE: npx vitest run webviews/globe/model/arcs.test.ts && npm run build:webviews
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L3-04 — Click → `ui.openTarget`, detail strip, drag to rotate** · T1 · cp-1 · M · depends: L3-02 · owns: `webviews/globe/scene/picking.tsx`, `webviews/globe/DetailStrip.tsx`, tests · contracts: `ui.openTarget`, `EventTarget` · acceptance: `npx vitest run webviews/globe/DetailStrip.test.tsx` + build.
```
TASK L3-04: Picking and detail
LANE: lane-3   BRANCH: lane-3/L3-04   WORKTREE: ../nexus-wt/L3-04
GOAL: Raycast pick on markers and arcs; selected event shown in a one-row detail strip under the globe (kind · title · orbit · T+hh:mm · sha/short id · actor) with an
      OPEN button and Enter → ui.openTarget(event.target). Drag rotates freely; pause/speed only behind ?debug=1.
OWNS: webviews/globe/scene/picking.tsx, webviews/globe/DetailStrip.tsx, DetailStrip.test.tsx
CONTRACTS: ui.openTarget, EventTarget
ACCEPTANCE: npx vitest run webviews/globe/DetailStrip.test.tsx && npm run build:webviews
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L3-05 — Event search bar with tracking** · T1 · cp-2 · L · depends: L3-02, L3-04 · owns: `webviews/globe/Search.tsx`, `webviews/globe/model/tracking.ts`, tests · contracts: `events.search`, `nexus.searchEvents`, `ui.setTimeWindow` · acceptance: `npx vitest run webviews/globe/Search.test.tsx webviews/globe/model/tracking.test.ts` + build.
```
TASK L3-05: Search and track
LANE: lane-3   BRANCH: lane-3/L3-05   WORKTREE: ../nexus-wt/L3-05
GOAL: Input above the globe → events.search (debounced 150 ms, whole store) → dropdown newest first: title · kind · orbit · T+ · sha. Enter picks the top, Escape
      closes. Choosing tracks: if the event is outside the window, widen/move the window first; then rotate the globe so the event faces the camera, zoom in ~15%,
      draw a ring around it, keep it centred as it drifts; drag or STOP TRACKING releases. nexus.searchEvents focuses the input (message "globe.focusSearch").
OWNS: webviews/globe/Search.tsx, Search.test.tsx, webviews/globe/model/tracking.ts, tracking.test.ts
CONTRACTS: events.search, nexus.searchEvents, ui.setTimeWindow
ACCEPTANCE: npx vitest run webviews/globe/Search.test.tsx webviews/globe/model/tracking.test.ts && npm run build:webviews
STOP WHEN: acceptance passes OR 3.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L3-06 — Activity strip histogram (per orbit, 15-minute buckets, click moves "now")** · T3 (sponsor) · cp-3 · M · depends: L3-02 · owns: `webviews/globe/ActivityStrip.tsx`, test · contracts: `events.activity`, `ActivityBucket` · acceptance: `npx vitest run webviews/globe/ActivityStrip.test.tsx` + build.

**L3-07 — Timeline fallback view (horizontal lanes, same data, same search/click)** · T1 (fallback) · cp-2 · M · depends: L3-01, L3-05 model · owns: `webviews/timeline/**` · contracts: `events.query/search/subscribe`, `ui.openTarget`, `nexus.openTimeline` · acceptance: `npx vitest run webviews/timeline` + build.

**L3-08 — Slack view: channel list, history with paging and cache badge, avatars/names** · T1 · cp-1 · L · depends: L3-01 · owns: `webviews/chat/**` except files owned by L3-09/L3-10 · contracts: `slack.status/channels/history/users`, `Channel`, `ChatMessage` · acceptance: `npx vitest run webviews/chat/ChannelList.test.tsx webviews/chat/History.test.tsx` + build.
```
TASK L3-08: Slack view, part 1
LANE: lane-3   BRANCH: lane-3/L3-08   WORKTREE: ../nexus-wt/L3-08
GOAL: Two-pane view in the Nexus container: left a 20-px-row channel list (name, unread count, a dot when botIsMember is false → tooltip "invite @Nexus for live
      updates"); right the history as dense rows (avatar 16 px, name, time, text, reply count "↳ 3") loading newest page first and older pages on scroll-top;
      a status line at the bottom: "posting as <name> via token vault|manual" or a warning when postsAs is null. Thread opening and the composer are L3-09.
OWNS: webviews/chat/ChannelList.tsx, History.tsx, MessageRow.tsx, StatusBar.tsx, App.tsx, index.html, main.tsx, *.test.tsx for these
CONTRACTS: slack.status/channels/history/users, Channel, ChatMessage, SlackStatus
ACCEPTANCE: npx vitest run webviews/chat/ChannelList.test.tsx webviews/chat/History.test.tsx && npm run build:webviews
CONSTRAINTS: message text rendered as text (no HTML), links detected and opened via the bridge only.
STOP WHEN: acceptance passes OR 3.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L3-09 — Slack view: threads, composer posting as you with pending echo, live updates** · T1 · cp-1 · L · depends: L3-08 · owns: `webviews/chat/ThreadPane.tsx`, `Composer.tsx`, `live.ts`, tests · contracts: `slack.thread/post/subscribe`, `ChatMessage.pending/failed/sentVia` · acceptance: `npx vitest run webviews/chat/ThreadPane.test.tsx webviews/chat/Composer.test.tsx` + build.
```
TASK L3-09: Slack view, part 2
LANE: lane-3   BRANCH: lane-3/L3-09   WORKTREE: ../nexus-wt/L3-09
GOAL: Clicking a parent opens the thread pane (slack.thread) with a MAKE TASK button (calls nexus.makeTaskFromThread through the bridge command path; the editor is
      L3-13). Composer (22 px input + SEND, Enter sends, Shift+Enter newline) posts top-level or as a reply with a clientId; the message appears immediately as pending
      (dim) and is replaced by Slack's copy from slack.subscribe; failed → red "RETRY". Live: new messages in the open channel/thread append without scroll jump unless at bottom.
OWNS: webviews/chat/ThreadPane.tsx, Composer.tsx, live.ts, their tests
CONTRACTS: slack.thread, slack.post, slack.subscribe, ChatMessage.pending/failed
ACCEPTANCE: npx vitest run webviews/chat/ThreadPane.test.tsx webviews/chat/Composer.test.tsx && npm run build:webviews
STOP WHEN: acceptance passes OR 3.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L3-10 — Code-ref chips, agent/bot message styling with approval buttons, "Share to Slack" editor command** · T2 · cp-2 · M · depends: L3-08 · owns: `webviews/chat/CodeRefChip.tsx`, `BotMessage.tsx`, `src/features/share/share-selection.ts` (lane 3's one extension-side file), `contributes/lane-3.json` (editor/context menu entry) · contracts: `CodeRef`, `coderef.create/open`, `nexus.shareSelectionToSlack`, `ChatMessage.blocks`, `nexus.approve/reject` (buttons call commands) · acceptance: `npx vitest run webviews/chat/CodeRefChip.test.tsx src/features/share/share-selection.test.ts` + build.
```
TASK L3-10: Code refs in chat and Share to Slack
LANE: lane-3   BRANCH: lane-3/L3-10   WORKTREE: ../nexus-wt/L3-10
GOAL: CodeRefChip: square chip "cart.ts:42-48 @3f2a9c1" → coderef.open; stale refs get an outline style. BotMessage: messages with sentVia "bot" get a left purple rule
      and the label "NEXUS · model-written"; approval blocks render APPROVE/REJECT (bridge → nexus.approve/reject) and show "decided by …" once resolved.
      nexus.shareSelectionToSlack (editor context menu, when a selection exists): coderef.create for the selection → quick pick a channel (and optional thread) →
      slack.post as the user with "<link>\n```snippet```"; shows the message in the view.
OWNS: webviews/chat/CodeRefChip.tsx, BotMessage.tsx, their tests, src/features/share/share-selection.ts, share-selection.test.ts, contributes/lane-3.json
CONTRACTS: CodeRef, coderef.create/open, slack.post, nexus.shareSelectionToSlack, ChatMessage.blocks, nexus.approve/reject
ACCEPTANCE: npx vitest run webviews/chat/CodeRefChip.test.tsx src/features/share/share-selection.test.ts && npm run build:webviews
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L3-11 — Session view panel: replay from seq 0, messages, tool calls, growing diff, test output, receipts** · T1 · cp-2 · L · depends: L3-01 · owns: `webviews/session/**` · contracts: `agent.subscribe`, `sessions.get`, `AgentEvent` (all variants), `ModelCallReceipt`, `receipts.list`, `nexus.openSession`, `nexus.cancelSession`, `nexus.openReceipt` · acceptance: `npx vitest run webviews/session` + build.
```
TASK L3-11: Session view
LANE: lane-3   BRANCH: lane-3/L3-11   WORKTREE: ../nexus-wt/L3-11
GOAL: A webview panel opened by nexus.openSession(sessionId). Header status line: task title · model (requested) · branch · status (amber awaiting_approval, green done, red
      failed) · CANCEL. Tabs: LOG (every AgentEvent as a dense row; model-written text labeled), DIFF (file_edit diffs accumulated per path, unified, monospace),
      TESTS (test_output tails), RECEIPTS (table: role, requested → served, cost, baseline, optimizations, OPEN → nexus.openReceipt; totals row). agent.subscribe
      fromSeq 0 → replay then live; a gap in seq shows a one-line warning. Approval requests render inline with APPROVE/REJECT.
OWNS: webviews/session/**
CONTRACTS: agent.subscribe, sessions.get, AgentEvent, ModelCallReceipt, receipts.list, nexus.cancelSession, nexus.openReceipt, nexus.approve/reject
ACCEPTANCE: npx vitest run webviews/session && npm run build:webviews (scriptedAgentEvents replay renders 15 rows in order; receipts totals correct)
STOP WHEN: acceptance passes OR 3.5 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L3-12 — Approvals view with swarm verdict card** · T1 (view) / T2 (verdict) · cp-2 · M · depends: L3-01 · owns: `webviews/approvals/**` · contracts: `approvals.list/resolve/subscribe`, `swarms.review.get/subscribe`, `SwarmReview`, `nexus.rerunSwarmReview`, `nexus.openApprovals` · acceptance: `npx vitest run webviews/approvals` + build.
```
TASK L3-12: Approvals view
LANE: lane-3   BRANCH: lane-3/L3-12   WORKTREE: ../nexus-wt/L3-12
GOAL: Sidebar view listing pending first: action (run_command shows the command in monospace; commit shows message + diffPreview collapsed), reason labeled
      "model-written", requested T+, APPROVE / REJECT (approvals.resolve; on conflict show the winner), decided rows show "decided by <name> via slack|app|auth0 push".
      Swarm card under a commit approval: status running (spinner-free text "council reviewing…"), done (verdict chip: green looks_good / amber concerns / red
      do_not_merge, one-line summary, per-judge rows expandable, "left machine · model-written"), unavailable (one line + RE-RUN). The card never disables the buttons.
OWNS: webviews/approvals/**
CONTRACTS: ApprovalRequest, approvals.*, SwarmReview, swarms.review.*, nexus.rerunSwarmReview
ACCEPTANCE: npx vitest run webviews/approvals && npm run build:webviews
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L3-13 — Task editor: brief review/edit, model choice, START** · T1 · cp-1 · M · depends: L3-01 · owns: `webviews/task/**` · contracts: `tasks.get/update`, `models.list(role agent)`, `agent.start`, `optimizer.get` · acceptance: `npx vitest run webviews/task` + build.
```
TASK L3-13: Make task → edit brief → start
LANE: lane-3   BRANCH: lane-3/L3-13   WORKTREE: ../nexus-wt/L3-13
GOAL: Panel opened after tasks.createFromThread: title input, brief textarea (monospace, the quoted thread block visibly delimited and read-only-styled), code refs as chips,
      model select from models.list(agent) with data-use labels, a "Prune: ON/OFF" status chip (read-only), START → agent.start then nexus.openSession. BREAK INTO SUBTASKS
      button only when the brief > 1,200 chars (Tier 3, L3-14).
OWNS: webviews/task/**
CONTRACTS: Task, tasks.get/update, models.list, agent.start, optimizer.get, nexus.decomposeTask
ACCEPTANCE: npx vitest run webviews/task && npm run build:webviews
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L3-14 — Task-plan review (accept/reject a `TaskPlan`)** · T3 · cp-3 · M · depends: L3-13 · owns: `webviews/plan/**` · contracts: `TaskPlan`, `tasks.plan.get/accept/reject` · acceptance: `npx vitest run webviews/plan` + build.

**L3-15 — Git views: `nexus.openCommit` diff view and `nexus.mergeAgentBranch` UI** · T3 · cp-3 · M · depends: L3-01 · owns: `webviews/git/**`, `src/features/gitviews/open-commit.ts`, test · contracts: `git.commit.show`, `git.mergeAgentBranch`, `sessions.list`, `nexus.openCommit`, `nexus.mergeAgentBranch` · acceptance: `npx vitest run webviews/git src/features/gitviews` + build.
```
TASK L3-15: Git views
LANE: lane-3   BRANCH: lane-3/L3-15   WORKTREE: ../nexus-wt/L3-15
GOAL: nexus.openCommit(sha): a small webview listing the commit's files (status, +/-) where clicking a file runs the BUILT-IN diff editor (vscode.diff of nexus-git:<parent>:<path>
      vs nexus-git:<sha>:<path>); header shows subject/author/time/parents. nexus.mergeAgentBranch: quick pick of done sessions → git.mergeAgentBranch → info message
      "merged as <sha>" or the clean-abort message.
OWNS: webviews/git/**, src/features/gitviews/open-commit.ts, open-commit.test.ts
CONTRACTS: git.commit.show, git.mergeAgentBranch, sessions.list, nexus.openCommit, nexus.mergeAgentBranch
ACCEPTANCE: npx vitest run webviews/git src/features/gitviews && npm run build:webviews
CONSTRAINTS: use the built-in diff editor; no custom diff renderer.
STOP WHEN: acceptance passes OR 2 h.
REPORT: Changed / Commits / Acceptance / Open questions
```

**L3-16 — Error/empty states, offline status line, approval "still pending" UI, keyboard hints** · T1 polish · cp-3 · M · depends: L3-08, L3-11, L3-12 · owns: the `EmptyState`/`StatusLine` usages in each view (one commit per view, sequential after their owners finish) · contracts: `store.status/subscribe`, `slack.status` · acceptance: `npx vitest run webviews` + build.

**L3-17 — (only if Q1b accepted) "Nexus Dark" color theme JSON** · T1 · cp-1 · S · owns: `themes/nexus-dark.json`, `contributes/lane-3.json` (themes entry) · acceptance: `node -e "JSON.parse(require('fs').readFileSync('themes/nexus-dark.json'))"` and the launch check shows purple accents in the chrome.

---

## 6. Wave plans per lane

Max 3 workers per lane; **max 2 on 8 GB machines** (Adrian's is 8 GB; Brandon's and Elkin's are set at H0-B5/H0-N5 — if 8 GB, use the "(8 GB)" column by dropping the third worker and shifting its task to the next wave). Leads do launch checks, merges and small edits themselves. T+22–24 is unplanned except cp-2 and sponsor tasks already listed.

### Lane 1 (Adrian, 8 GB → 2 workers; lead does core tasks in the main checkout)

| Wave | Window | Worker A | Worker B | Lead (main checkout) |
|---|---|---|---|---|
| 1 | T+2–T+5 | L1-03 → L1-23 → L1-24 | L1-08 → L1-26 | L1-S1 (build registration, launch check), then L1-02 prototype |
| 2 | T+5–T+8 | L1-09 (L) | L1-04 → L1-06 | L1-02 finish; L1-S6 callback check inside L1-14 prep; run L1-S5/L1-S4 int tests by hand (keys) |
| 3 | T+8–T+10 | L1-10 → L1-11 | L1-05 → L1-07 | L1-22; wire real Lane 2 store/gate/slack (merge `main`); **cp-1 launch check** |
| 4 | T+12–T+16 | L1-12 → L1-13* | L1-17 → L1-18 | L1-14 (sign-in) |
| 5 | T+16–T+22 | L1-20 (L) → L1-21 | L1-18 finish → polish approvals/notifications | merge `main` hourly; demo-script dry run on the demo repo |
| cp-2 | T+22–T+24 | L1-15 → L1-16 (CIBA, only if H0-A6 said yes) | — | **cp-2 acceptance**, globe-fallback decision, Lane 3 pickup if behind |
| 6 | T+24–T+30 | L1-19 (Tier 3: decompose + plan accept) | L1-19 scheduler half (or a Lane 2/3 lead per Q1c) → rough edges from cp-2 | integration fixes; `cp-3` prep |
| 7 | T+30–T+33 | fixes only | fixes only | **cp-3**, L1-27 recording |

\*L1-13 runs in Lane 2 wave 3 if Q1a is accepted.

### Lane 2 (Brandon)

| Wave | Window | Worker A | Worker B | Worker C (16 GB only) |
|---|---|---|---|---|
| 1 | T+2–T+5 | L2-01 (bridge, L) | L2-02 (slack web, L) | L2-08 (store, L) — on 8 GB: lead starts L2-08 interface + fake, worker takes it in wave 2 |
| 2 | T+5–T+8 | L2-13 (gate, L) | L2-03 (socket/bot, L; L2-S1 int by the lead) | L2-05 → L2-07 |
| 3 | T+8–T+10 | L2-06 | L2-09 (int, needs TIGER_URL) → L2-16 | L2-04 |
| cp-1 | T+10–T+12 | — | — | lead: launch check, PR to `main` |
| 4 | T+12–T+16 | L2-10 (L) | L2-14 | L2-17* (progress message) or L2-15 |
| 5 | T+16–T+22 | L2-11 | L2-15 | polish: Slack reconnect, cache edge cases |
| cp-2 | T+22–T+24 | — | — | cp-2 support; Tiger shared-live beat rehearsal |
| 6 | T+24–T+30 | L2-12 (activity aggregate) | fixes | fixes |

### Lane 3 (Elkin)

| Wave | Window | Worker A | Worker B | Worker C (16 GB only) |
|---|---|---|---|---|
| 1 | T+2–T+5 | L3-01 (kit, L) | L3-02 starts at T+2:30 on the kit stubs (L) | L3-08 starts at T+2:30 (L) |
| 2 | T+5–T+8 | L3-03 → L3-04 | L3-02 finish | L3-09 (L) |
| 3 | T+8–T+10 | L3-13 | L3-17* | L3-09 finish |
| cp-1 | T+10–T+12 | — | — | lead: launch check, PR |
| 4 | T+12–T+16 | L3-05 (search/track, L) | L3-11 (session view, L) | L3-10 |
| 5 | T+16–T+22 | L3-12 | L3-07 (timeline fallback) | L3-11 finish → L3-15 |
| cp-2 | T+22–T+24 | — | — | globe vs timeline decision |
| 6 | T+24–T+30 | L3-06 | L3-14 | L3-16 |

---

## 7. Critical path and earliest end-to-end point per Tier 1 feature

**Critical path (longest dependency chain to the demo):**
cp-0 (T+2) → L2-01 bridge interface drop (T+2:30) → L2-13 gate (T+8) + L1-09 runtime (T+8) → L1-10 sessions (T+10) → **cp-1 real agent edit through the gate (T+10–12)** → L1-12 approvals (T+14) + L2-03 buttons (T+8, wired T+12) + L2-10 Tiger adapter (T+16) → L1-18 swarm review (T+18) → L3-12 approvals view (T+18) → **cp-2 full demo run (T+22–24)** → L1-20/21 Prune receipts visible (T+22) → cp-3 (T+30–33).
The single most loaded node is **Lane 1 T+5–T+10** (runtime + sessions + providers with 2 workers); if it slips, cp-1 uses the FakeProvider's scripted turn against the real gate (still a real file edit and commit on the demo repo) and real providers land by T+14.

| Tier 1 feature | Needs | Earliest end-to-end (real services) |
|---|---|---|
| In-app Slack client | L2-01, L2-02, L2-03 (events), L3-08, L3-09 | **T+9** (channel list, history, thread, post as you, live) |
| Model picker | L1-03, L1-04, L1-05, L1-06, L1-07 | **T+9** (both providers listed with data-use labels) |
| Thread to task | L1-11, L1-10, L1-09, L2-13, L2-06, L3-13 (+ L1-13 progress message) | **T+11** (task from thread → agent edits a file in its worktree); progress message in Slack T+14 |
| Shared agent session | L1-10, L3-11, L2-10, L2-11 | local T+13; **shared across machines T+17** |
| Approval from chat | L1-12, L2-03 (buttons), L3-12, L2-10 (conditional update) | in-app T+14; **from Slack on a phone T+15**; first-answer-wins across machines T+17 |
| Globe home | L1-S1, L1-02, L1-22, L3-02, L3-03, L3-04, L2-07, L2-08; search needs L3-05 | tab-less globe on real events **T+10**; search + tracking T+15 |
| Tier 2: code refs | L2-14, L3-10 | T+15 |
| Tier 2: Swarms provider / review | L1-17, L1-18, L3-12, L2-03 (verdict in Slack) | T+18 |
| Tier 2: Prune | L1-20, L1-21, L3-11 receipts tab | T+22 |
| Sponsor: Auth0 sign-in + Token Vault | L1-14, L2-15 | T+16; CIBA T+24 |
| Sponsor: TigerData shared store + activity strip | L2-10, L2-11; L2-12 + L3-06 | T+17; strip T+27 |

---

## 8. Checkpoint acceptance — runnable steps

Run by Lane 1 on a **fresh build** (`git switch main && git pull`, `npm run watch` finished, `cd extensions/nexus && npm ci && npm run ci`). Each checkpoint ends with a **launch check of the full fork** (`.\scripts\code.bat` with no `--extensionDevelopmentPath`, fresh `--user-data-dir`, the demo repo open) and the tag.

### cp-1 (T+10–T+12) — first real slice
1. `cd extensions/nexus && npm run ci` → exit 0.
2. Launch check: window title "Nexus"; the home fills the editor area with no tab (or, if L1-02 slipped, a globe tab — record which).
3. The globe shows the demo repo's history (≥ 30 commits on ≥ 3 orbits, 5 merge arcs). Click a commit → `nexus.openCommit` opens (or the built-in diff if L3-15 is not in yet).
4. Slack view: `#nexus-demo` listed; post "cp-1 ping" from the composer → it appears in Slack **as the presenter** (phone check) and in the view without reload; a reply from the phone appears live.
5. `Nexus: Connect provider` for Anthropic with the dev key → status bar shows a model; picker lists Anthropic and Gemini models with data-use labels.
6. In the thread, MAKE TASK → task editor shows the quoted brief with the code-ref chip → START → session view opens, shows tool calls; `git -C <demo> worktree list` shows the session worktree; `git -C <demo> log nexus/agent-* -1` shows a commit after approving (in-app notification is enough at cp-1); the session's cube appears at the now line on the globe.
7. Tag `cp-1`, post in `#nexus-build`.

### cp-2 (T+22–T+24) — first full demo-script run, teammate on the phone
1. Steps 1–2 of cp-1.
2. **Step 0:** `Nexus: Sign in` → browser → back in Nexus via `nexus://`; `Nexus: Connect Slack` reports "via token vault" (fallback "manual" is allowed but recorded as a miss).
3. **Steps 1–7 of §8 exactly as written**, timed: must complete in ≤ 8 minutes with at most one retry. Required observations: approval reaches the phone as a Slack message with buttons **and** (if CIBA is in) as a Guardian push; tapping on the phone resolves it; the app and the session view show "decided by <teammate> via slack|auth0 push"; the swarm card shows a verdict or `unavailable` within 45 s; Prune toggle on → RECEIPTS tab has ≥ 1 receipt with requested = served for the agent role; status bar shows cost and saved.
4. **Step 7b:** a session started on Brandon's machine is visible on the presenter's globe within 5 s (or the offline line shows and the beat is marked skipped).
5. **Globe decision:** if any of (a) < 30 fps with the demo repo, (b) a crash in two runs, (c) search/tracking not working → the timeline becomes the home (`nexus.openTimeline` default) and the globe stays as a view that the demo still opens once; the globe work continues in wave 6 (it is not dropped). Record the decision in all three progress files.
6. Tag `cp-2`.

### cp-3 (T+30–T+33) — feature freeze
1. `npm run ci` green on `main`; every `progress/lane-N.md` lists no "In flight".
2. Full §8 run twice back to back from a fresh user-data dir and a re-seeded demo repo (`nexus.dev.reseedDemoRepo`), no retries needed on the second run.
3. Error paths checked once each: Tiger unreachable (block the host) → offline line, demo still works; Swarms key removed → `unavailable` card; Prune key removed → calls go direct and the status bar says "Prune: off (error)"; Slack socket dropped → reconnects within 30 s.
4. Launch check from the **built-in** bundle, plus `--extensionDevelopmentPath` is no longer needed on any machine.
5. Tag `cp-3`; record the fallback video (L1-27) from this tag.

---

## 9. Fallbacks

### Tier 1 and Tier 2 items

| Item | If not ready by its checkpoint | What is shown instead |
|---|---|---|
| In-app Slack client (T1) | by cp-1: history read-only from the user token; posting via bot only | The view still shows the real channel; the presenter posts from Slack's own client on a second screen and the message appears in Nexus live |
| Thread to task (T1) | by cp-1: no brief builder | "Make task" opens the task editor with the thread pasted by hand; the agent still runs |
| Shared agent session (T1) | by cp-2: no Tiger sync | Local session view only; step 7b is skipped and the phone follows the Slack progress message |
| Approval from chat (T1) | by cp-2: no Slack buttons | In-app notification buttons; the teammate approves on the presenter's laptop; if CIBA is missing, no push beat |
| Model picker (T1) | by cp-1: one provider | Anthropic only, picker still shows the data-use label; say Gemini is next |
| Globe home (T1) | by cp-2: not solid | **Timeline view becomes the home**, globe is a tab opened once in the demo if it renders; tab-less core change failing → closable home tab |
| Live code references (T2) | by cp-2 | Share to Slack posts the snippet without a `nexus://` link; the chip opens the current file |
| Swarms as a provider (T2) | by cp-2 | Picker shows "Swarms (API key)" greyed with "text roles only — not connected"; briefs are deterministic |
| Swarm review (T2) | by cp-2 | Approval card shows "council review unavailable"; the presenter says it is advisory and shows the fixture card in the recording |
| Optimize with Prune (T2) | by cp-2 | Toggle present but disabled with tooltip "gateway check failed at hour 0"; receipts tab shows the fixture receipt labeled "sample" |

### Sponsor challenges

| Challenge | Hour-0/wave-1 check fails or integration late | What still gets shown |
|---|---|---|
| **Auth0** | Native callback fails (L1-S6) → sign-in via a loopback `http://127.0.0.1:<port>/callback` instead of `nexus://` **(verify allowed for native apps)**; Token Vault fails → manual `xoxp` with the UI saying "manual token"; CIBA not in plan (H0-A6) → no push | Universal Login round trip + "connected to Slack through Auth0" status line; approvals from Slack buttons; the judges see Auth0 sign-in and, if any one of Token Vault/CIBA works, that one |
| **TigerData** | NOTIFY fails → 2 s polling; Tiger unreachable on venue Wi-Fi → local copy | Step 7b with polling latency ≤ 3 s is still "live"; worst case: the activity strip from the local store and a sentence that the shared store is where every machine syncs, with the Tiger console open on the schema |
| **Prune** | Proxy shape differs (Q2) / tool passthrough fails → `text_roles` only; receipts not parseable → cost shown from Prune's dashboard | Toggle on for the brief/summary roles only; one receipt opened on Prune's verify page; status bar savings from receipts that did parse |
| **Swarms** | REST shape unknown / council type unavailable → single-agent completion emulating three judges in one prompt (labeled "single-agent review") ; API down → `unavailable` | The verdict card (real or emulated) on the approval; task breakdown shows the fixture `TaskPlan` through the same accept flow if the swarm is unavailable, so the optional step-4 beat still runs locally |

---

## 10. Demo prep

| ID | Owner | Task | Done when |
|---|---|---|---|
| D-1 | Adrian | Seeded demo repo (L1-26) opened on the demo machine; `nexus.dev.reseedDemoRepo` tested twice | Globe shows the seeded history; `npm test` fails on the planted bug |
| D-2 | Adrian | `#nexus-demo` cleaned: pinned message with the thread the demo starts from; bot invited; the teammate's phone signed in to Slack as themselves | Phone posts in the thread appear in Nexus live |
| D-3 | All | Demo roles: presenter (Adrian), phone teammate (Brandon), second-laptop session for step 7b (Elkin) | Roles in `demo/demo-script.md` |
| D-4 | Adrian | Fallback recording from `cp-3` (L1-27), plus three 20-second clips: swarm verdict, phone approval, Prune receipt | Files named in `progress/lane-1.md` |
| D-5 | Adrian | Demo keys: Anthropic with spend limit, Gemini on the billing-enabled project, Swarms team key, Prune key with the two provider keys in Prune's vault; all in SecretStorage on the demo machine, none in env | `accounts.list` shows all connected with correct data-use labels |
| D-6 | All | Rehearse the demo as a task twice at T+33–T+36; no architecture narration; opt into the four sponsor tracks | Two clean runs timed under 8 minutes |

### Sponsor demo-script steps (what the judges see)

| Challenge | Exact step | What the judges see |
|---|---|---|
| **Auth0** | **Step 0:** click "Sign in" → Auth0 Universal Login in the browser → back in Nexus; the Slack status line reads "posting as Adrian · via Token Vault". **Step 6:** when the agent asks to commit, Brandon's phone buzzes with an Auth0 Guardian request "NX apr_… commit" and he taps Approve; the approval card flips to "decided by Brandon via auth0 push". | A real identity login with no token pasting, Slack access brokered by Token Vault, and a risky agent action confirmed on a phone through Auth0 — the app and the Slack message both show who approved |
| **TigerData** | **Step 7b:** the presenter's globe already has a cube orbiting `lane-2` labeled with Elkin's session started on another laptop; clicking it opens that session's replay from `seq` 0. The activity strip under the globe shows the night's 15-minute buckets; clicking the busiest bar moves "now" there. | Every teammate's agents, approvals and events in one shared TimescaleDB store, live across machines, with a continuous aggregate driving the strip |
| **Prune** | **Step 2:** flip "Optimize with Prune" on in the picker (data-use label changes to "unknown · leaves machine"). **After step 6:** status bar reads "PRUNE $0.0xx · saved $0.0yy"; open the session's RECEIPTS tab: each call shows requested model = served model for the agent, cost, optimizations; click OPEN on one → Prune's verify page confirms the receipt | One toggle routes Nexus's model calls through Prune with signed, verifiable receipts, and the code-editing agent provably stayed on the chosen model |
| **Swarms** | **Step 6:** the approval card shows "Council review · looks_good — Fix is minimal and covered by the new test (model-written)" with three judge rows; the same verdict is in the Slack approval message. **Optional step 4b:** on the long thread, "Break into subtasks" → a 3-subtask plan → ACCEPT → two cubes start orbiting | A multi-agent council reviewing every diff before a human decides, labeled advisory, and a swarm planning work that local gated agents then execute |

---

*End of plan. Totals: Lane 1 — 26 tasks, 42.75 wh (~31 nominal; rebalanced, nothing cut: see Q1). Lane 2 — 16 tasks, 32.25 wh. Lane 3 — 16 tasks, 33 wh. Smoke tests: L1-S1 (build registration), L1-02 prototype (tab-less home), H0-N1 (WebGL), L2-S1 (Socket Mode from the ext host), L1-S6 (`nexus://` callback), H0-A6 (CIBA in plan), L2-15 int (Token Vault), H0-B4 (LISTEN/NOTIFY), L1-S4 (Prune), L1-S5 (Swarms), L1-S3 (Gemini path), H0-B5/N5 (sparse worktrees).*

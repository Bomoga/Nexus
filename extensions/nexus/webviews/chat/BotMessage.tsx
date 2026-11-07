import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";
import type { ApprovalRequest, ChatMessage } from "../../src/contracts";
import { BridgeError, Button, Chip, getBridge } from "../shared";
import type { BridgeClient } from "../shared";

// ChatMessage.blocks is raw, untrusted Block Kit. Only this narrow shape is understood; everything else is ignored.
const SectionBlock = z.object({ type: z.literal("section"), text: z.object({ text: z.string() }) });
const ButtonEl = z.object({ type: z.literal("button"), action_id: z.string(), value: z.string().min(1) });
const ActionsBlock = z.object({ type: z.literal("actions"), elements: z.array(z.unknown()) });

export interface ParsedBlocks {
  /** Plain-text section texts (never rendered as markup). */
  sections: string[];
  /** Set only when both an approve and a reject button agree on the approval id. */
  approvalId?: string;
}

export function parseBlocks(blocks: unknown): ParsedBlocks {
  const out: ParsedBlocks = { sections: [] };
  if (!Array.isArray(blocks)) return out;
  let approve: string | undefined;
  let reject: string | undefined;
  for (const b of blocks) {
    const section = SectionBlock.safeParse(b);
    if (section.success) {
      out.sections.push(section.data.text.text);
      continue;
    }
    const actions = ActionsBlock.safeParse(b);
    if (!actions.success) continue;
    for (const el of actions.data.elements) {
      const btn = ButtonEl.safeParse(el);
      if (!btn.success) continue;
      if (btn.data.action_id === "nexus.approve") approve ??= btn.data.value;
      else if (btn.data.action_id === "nexus.reject") reject ??= btn.data.value;
    }
  }
  if (approve && approve === reject) out.approvalId = approve;
  return out;
}

/** The approval as the store has it; undefined when the store has no such approval. */
async function lookup(client: BridgeClient, approvalId: string): Promise<ApprovalRequest | undefined> {
  const list = await client.request("approvals.list", { pendingOnly: false });
  return list.find((a) => a.id === approvalId);
}

function Approval({ approvalId, bridge }: { approvalId: string; bridge?: BridgeClient }) {
  const [decided, setDecided] = useState<ApprovalRequest | undefined>();
  // Buttons only for an approval the store knows: a block's approval id is untrusted (any bot could post one).
  const [known, setKnown] = useState<"checking" | "yes" | "no">("checking");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const client = bridge ?? getBridge();
    let live = true;
    lookup(client, approvalId).then(
      (a) => {
        if (!live) return;
        // Never downgrade: a live event may already have shown this approval while the list was in flight.
        setKnown((k) => (a || k === "yes" ? "yes" : "no"));
        if (a?.decision) setDecided(a);
      },
      (e: unknown) => {
        if (!live) return;
        setKnown((k) => (k === "yes" ? "yes" : "no"));
        setError(e instanceof Error ? e.message : String(e));
      },
    );
    const unsub = client.subscribe("approvals.subscribe", {}, (a) => {
      if (a.id !== approvalId) return;
      setKnown("yes");
      setError(undefined);
      if (a.decision) setDecided(a);
    });
    return () => {
      live = false;
      unsub();
    };
  }, [bridge, approvalId]);

  const resolve = (decision: "approved" | "rejected") => {
    const client = bridge ?? getBridge();
    setBusy(true);
    setError(undefined);
    const settle = async () => {
      try {
        const a = await client.request("approvals.resolve", { approvalId, decision });
        if (a.decision) setDecided(a);
      } catch (e) {
        // Someone else decided first: the host answers "conflict" without the winner, so fetch it.
        if (!(e instanceof BridgeError && e.code === "conflict")) throw e;
        const a = await lookup(client, approvalId);
        if (a?.decision) setDecided(a);
        else setError("already decided elsewhere");
      }
    };
    settle()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (decided?.decision) {
    const by = decided.decidedBy;
    return (
      <div className="chat-approval">
        <Chip tone={decided.decision === "approved" ? "ok" : "error"}>{decided.decision.toUpperCase()}</Chip>
        <span className="nx-data">{by ? `decided by ${by.userId} via ${by.via}` : "decided"}</span>
      </div>
    );
  }
  if (known !== "yes") {
    return (
      <div className="chat-approval">
        <span className="nx-data">{known === "checking" ? "checking approval…" : "approval not known on this machine"}</span>
        {error ? <span className="chat-approval-error">{error}</span> : null}
      </div>
    );
  }
  return (
    <div className="chat-approval">
      <Button variant="primary" disabled={busy} onClick={() => resolve("approved")}>
        APPROVE
      </Button>
      <Button disabled={busy} onClick={() => resolve("rejected")}>
        REJECT
      </Button>
      {error ? <span className="chat-approval-error">{error}</span> : null}
    </div>
  );
}

export interface BotMessageProps {
  message: ChatMessage;
  /** The rendered message body (text with links, code ref chips). */
  children: ReactNode;
  bridge?: BridgeClient;
}

/** A message the Nexus bot posted: left purple rule, model-written label, optional approval buttons. */
export function BotMessage({ message, children, bridge }: BotMessageProps) {
  const parsed = parseBlocks(message.blocks);
  const extra = parsed.sections.filter((s) => s !== message.text);
  return (
    <div className="chat-text chat-bot">
      <div className="chat-bot-label">NEXUS · model-written</div>
      {children}
      {extra.map((s, i) => (
        <div key={i} className="chat-bot-section">
          {s}
        </div>
      ))}
      {parsed.approvalId ? <Approval approvalId={parsed.approvalId} bridge={bridge} /> : null}
    </div>
  );
}

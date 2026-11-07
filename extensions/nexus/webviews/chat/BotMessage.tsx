import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";
import type { ApprovalRequest, ChatMessage } from "../../src/contracts";
import { Button, Chip, getBridge } from "../shared";
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

function Approval({ approvalId, bridge }: { approvalId: string; bridge?: BridgeClient }) {
  const [decided, setDecided] = useState<ApprovalRequest | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const client = bridge ?? getBridge();
    return client.subscribe("approvals.subscribe", {}, (a) => {
      if (a.id === approvalId && a.decision) setDecided(a);
    });
  }, [bridge, approvalId]);

  const resolve = (decision: "approved" | "rejected") => {
    setBusy(true);
    setError(undefined);
    (bridge ?? getBridge())
      .request("approvals.resolve", { approvalId, decision })
      .then((a) => {
        if (a.decision) setDecided(a);
      })
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

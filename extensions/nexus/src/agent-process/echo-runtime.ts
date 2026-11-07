import type { AgentChannel } from "./channel";

// Test-only runtime (PLAN L1-08): proves the protocol end to end without a model.
// On session.start it fetches a credential and emits two events through the host, then accepts.
export async function run(channel: AgentChannel): Promise<void> {
  channel.onHostRequest(async (name, body) => {
    if (name === "session.start") {
      const start = body as { session: { id: string; model: { provider: string } }; task: { title: string } };
      const cred = await channel.request("credentials.get", { provider: start.session.model.provider, callId: `call_${start.session.id}` });
      await channel.request("event.emit", { type: "message", payload: { text: `echo: ${start.task.title}`, hasKey: cred.apiKey.length > 0 } });
      return { accepted: true } as never;
    }
    if (name === "session.cancel") return { cancelled: true } as never;
    return { ok: true, pid: process.pid } as never;
  });
  channel.onHostEvent("approval.resolved", e => {
    void channel.request("event.emit", { type: "message", payload: { text: `echo: approval ${e.approvalId} ${e.decision}` } });
  });
}

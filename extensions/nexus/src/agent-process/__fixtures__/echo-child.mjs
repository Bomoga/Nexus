// Minimal real child process for process-host.test.ts: speaks the agent JSON-lines protocol with no dependencies.
// CRASH_ON_START=1 makes it exit(3) right after accepting session.start.
import { createInterface } from "node:readline";

const out = obj => process.stdout.write(JSON.stringify(obj) + "\n");
const waiting = new Map();
let n = 0;

function ask(name, body) {
  const id = `c${++n}`;
  return new Promise(resolve => { waiting.set(id, resolve); out({ t: "req", id, name, body }); });
}

createInterface({ input: process.stdin }).on("line", async line => {
  const msg = JSON.parse(line);
  if (msg.t === "res") { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); return; }
  if (msg.t !== "req") return;
  if (msg.name === "health") return out({ t: "res", id: msg.id, ok: true, body: { ok: true, pid: process.pid } });
  if (msg.name === "session.cancel") return out({ t: "res", id: msg.id, ok: true, body: { cancelled: true } });
  if (msg.name === "session.start") {
    const cred = await ask("credentials.get", { provider: msg.body.session.model.provider, callId: "call_1" });
    const emitted = await ask("event.emit", { type: "message", payload: { text: "hello", gotKey: cred.ok && cred.body.apiKey.length > 0, electronAsNode: process.env.ELECTRON_RUN_AS_NODE } });
    out({ t: "res", id: msg.id, ok: emitted.ok, body: { accepted: true } });
    if (process.env.CRASH_ON_START === "1") setTimeout(() => process.exit(3), 10);
  }
});

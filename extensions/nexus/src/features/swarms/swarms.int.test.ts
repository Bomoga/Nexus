// Integration test (smoke L1-S5): hits the real Swarms API. Run by hand with `npm run test:int -- swarms`; never in CI.
// Records the real response shape and latency of one single-agent completion and one CouncilAsAJudge run, so the
// parsing in swarms-client.ts and review.ts can be checked against the live API.
import { describe, expect, it } from "vitest";
import { SwarmsClient, lastTurnText } from "./swarms-client";

const key = process.env.SWARMS_API_KEY;

describe.skipIf(!key)("swarms (live)", () => {
  const client = new SwarmsClient({ timeoutMs: 120_000 });

  it("accepts the key", async () => {
    await client.checkKey(key!);
  });

  it("completes one single-agent request", async () => {
    const t0 = Date.now();
    const r = await client.complete({ apiKey: key!, system: "Answer in one sentence.", task: "What is a git worktree?", maxTokens: 200 });
    console.log(`swarms single-agent: ${Date.now() - t0} ms, ${r.text.length} chars, cost ${r.costUsd}`);
    expect(r.text.length).toBeGreaterThan(0);
  }, 150_000);

  it("runs a CouncilAsAJudge review and records the output shape", async () => {
    const t0 = Date.now();
    const run = await client.run({
      apiKey: key!, swarmType: "CouncilAsAJudge", name: "Nexus smoke review", maxLoops: 1,
      task: 'Review this diff and reply with JSON {"verdict":"looks_good|concerns|do_not_merge","summary":"..."}.\n--- a/src/cart.ts\n+++ b/src/cart.ts\n-  sum += price * qty - discount;\n+  sum += (price - discount) * qty;',
    });
    console.log(`swarms council: ${Date.now() - t0} ms, output is ${Array.isArray(run.output) ? `a list of ${run.output.length}` : typeof run.output}, cost ${run.costUsd}`);
    console.log("last turn:", lastTurnText(run.output).slice(0, 300));
    expect(run.text.length).toBeGreaterThan(0);
  }, 200_000);
});

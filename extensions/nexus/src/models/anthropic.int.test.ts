// Integration test: hits the real Anthropic API. Run by hand with `npm run test:int -- anthropic`; never in CI.
import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "./anthropic";
import { collectTurn } from "./provider";

const key = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!key)("anthropic (live)", () => {
  const provider = createAnthropicProvider();

  it("lists models with tool support", async () => {
    const models = await provider.listModels(key!);
    expect(models.length).toBeGreaterThan(0);
    console.log("anthropic models:", models.map(m => m.modelId).join(", "));
  });

  it("completes one tool-calling turn", async () => {
    const models = await provider.listModels(key!);
    const r = await collectTurn(provider.turn({
      modelId: process.env.ANTHROPIC_MODEL ?? models[0].modelId, role: "agent", system: "Use the tool.", maxTokens: 256,
      messages: [{ role: "user", content: "Read the file src/cart.ts." }],
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    }, key!));
    expect(r.error).toBeUndefined();
    expect(r.toolCalls[0]).toMatchObject({ name: "read_file" });
  }, 60_000);
});

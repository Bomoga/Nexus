// Integration test (smoke L1-S3): hits the real Gemini API. Run by hand with `npm run test:int -- gemini`; never in CI.
// Records which models list and whether one tool-calling round trip completes through generateContentStream.
import { describe, expect, it } from "vitest";
import { createGeminiProvider } from "./gemini";
import { collectTurn, type TurnMessage } from "./provider";

const key = process.env.GEMINI_API_KEY;
const tools = [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

describe.skipIf(!key)("gemini (live)", () => {
  const provider = createGeminiProvider();

  it("lists Gemini models", async () => {
    const models = await provider.listModels(key!);
    expect(models.length).toBeGreaterThan(0);
    console.log("gemini models:", models.map(m => m.modelId).join(", "));
  });

  it("completes a tool-calling round trip (call, result, answer)", async () => {
    const models = await provider.listModels(key!);
    const modelId = process.env.GEMINI_MODEL ?? models[0].modelId;
    const messages: TurnMessage[] = [{ role: "user", content: "Read the file src/cart.ts, then tell me in one sentence what it is." }];
    const first = await collectTurn(provider.turn({ modelId, role: "agent", system: "Use the tool.", messages, tools, maxTokens: 512 }, key!));
    expect(first.error).toBeUndefined();
    expect(first.toolCalls[0]).toMatchObject({ name: "read_file" });
    messages.push({ role: "assistant", content: first.text, toolCalls: first.toolCalls });
    messages.push({ role: "tool", toolCallId: first.toolCalls[0].id, content: "export const total = () => 1;" });
    const second = await collectTurn(provider.turn({ modelId, role: "agent", system: "Use the tool.", messages, tools, maxTokens: 512 }, key!));
    expect(second.error).toBeUndefined();
    expect(second.text.length).toBeGreaterThan(0);
    console.log(`gemini path: generateContentStream, model ${modelId}`);
  }, 90_000);
});

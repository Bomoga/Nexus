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

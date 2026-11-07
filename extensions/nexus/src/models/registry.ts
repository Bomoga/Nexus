import { SwarmsClient } from "../features/swarms/swarms-client";
import { createAnthropicProvider } from "./anthropic";
import { FakeProvider } from "./fake-provider";
import { createGeminiProvider } from "./gemini";
import { createSwarmsProvider } from "./swarms-provider";
import type { Provider } from "./provider";

// One Swarms client per process, so the text-role provider, the swarm review and the task breakdown share the same
// request budgets instead of each counting separately.
let swarmsClient: SwarmsClient | undefined;
export function sharedSwarmsClient(): SwarmsClient {
  swarmsClient ??= new SwarmsClient();
  return swarmsClient;
}

// The providers available in a process, by ProviderAccount.provider id. Real providers are added here as they land.
// NEXUS_FAKE_PROVIDER=1 swaps every id for the scripted FakeProvider: the cp-1 fallback and the way to exercise the
// whole agent path with no network and no key.
export function createProviders(env: NodeJS.ProcessEnv = process.env): Record<string, Provider> {
  if (env.NEXUS_FAKE_PROVIDER === "1") {
    const fake = new FakeProvider();
    return { anthropic: fake, google: fake, fake };
  }
  return { anthropic: createAnthropicProvider(), google: createGeminiProvider(), swarms: createSwarmsProvider(sharedSwarmsClient()) };
}

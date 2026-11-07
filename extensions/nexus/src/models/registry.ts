import { createAnthropicProvider } from "./anthropic";
import { FakeProvider } from "./fake-provider";
import type { Provider } from "./provider";

// The providers available inside the agent process, by ProviderAccount.provider id. Real providers are added here as
// they land (Gemini: L1-05). NEXUS_FAKE_PROVIDER=1 swaps every id for the scripted FakeProvider: the cp-1 fallback and
// the way to exercise the whole agent path with no network and no key.
export function createProviders(env: NodeJS.ProcessEnv = process.env): Record<string, Provider> {
  if (env.NEXUS_FAKE_PROVIDER === "1") {
    const fake = new FakeProvider();
    return { anthropic: fake, google: fake, fake };
  }
  return { anthropic: createAnthropicProvider() };
}

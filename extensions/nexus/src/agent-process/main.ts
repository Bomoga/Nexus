import { AgentChannel } from "./channel";

// Entry point of the agent child process (PLAN L1-08). Wires stdio to an AgentChannel and hands it to the runtime.
// The runtime module is chosen by NEXUS_AGENT_RUNTIME (tests use echo-runtime); the default is ./runtime (L1-09).

export async function main(): Promise<void> {
  const channel = new AgentChannel(process.stdin, process.stdout);
  const runtimePath = process.env.NEXUS_AGENT_RUNTIME ?? "./runtime";
  // CommonJS output: require() resolves "./runtime" next to this file; a dynamic import() would need an extension.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtime = require(runtimePath) as { run(channel: AgentChannel): Promise<void> };
  await runtime.run(channel);
}

if (require.main === module) {
  main().catch(err => {
    // stderr is read by the host and passed through redact() before it is logged.
    process.stderr.write(`agent process failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

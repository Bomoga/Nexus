// Test double for the Bolt slice (BoltLike). Not a test file; imported by the slack tests.
import { vi } from "vitest";
import type { BoltActionArgs, BoltLike, SlackEventMessage } from "./socket";
import type { SlackUserInfo } from "./web-client";

export const BOT_USER = "U_BOT";
export const TEAM = "T1";
export const identity = { userId: BOT_USER, name: "nexus", botId: "B1", teamId: TEAM };
export const getIdentity = async () => identity;
export const users: Record<string, SlackUserInfo> = {
  U_ADRIAN: { id: "U_ADRIAN", team_id: TEAM, name: "adrian", is_bot: false, profile: { display_name: "Adrian" } },
  U_BRANDON: { id: "U_BRANDON", team_id: TEAM, name: "brandon", is_bot: false, profile: { display_name: "Brandon" } },
  U_BOT: { id: "U_BOT", name: "nexus", is_bot: true, profile: { display_name: "Nexus" } },
  U_OTHERBOT: { id: "U_OTHERBOT", name: "ci", is_bot: true },
};

export function makeFakeBolt() {
  let messageHandler: ((a: { event: SlackEventMessage }) => Promise<void>) | undefined;
  const actions = new Map<string, (a: BoltActionArgs) => Promise<void>>();
  let connection: ((up: boolean) => void) | undefined;
  const deadListeners: (() => void)[] = [];
  const info = vi.fn(async (a: { user: string }) => (users[a.user] ? { user: users[a.user] } : Promise.reject(new Error("user_not_found xoxb-secret"))));
  const app = {
    event: vi.fn((_n: "message", h: (a: { event: SlackEventMessage }) => Promise<void>) => { messageHandler = h; }),
    action: vi.fn((id: string, h: (a: BoltActionArgs) => Promise<void>) => { actions.set(id, h); }),
    error: vi.fn(),
    onConnection: vi.fn((cb: (up: boolean) => void) => { connection = cb; }),
    onDead: vi.fn((cb: () => void) => { deadListeners.push(cb); }),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    client: { users: { info } },
  };
  return {
    app: app as unknown as BoltLike & typeof app,
    info,
    message: (event: SlackEventMessage) => messageHandler!({ event }),
    click: (actionId: string, args: Partial<BoltActionArgs> & { ack?: () => Promise<unknown> }) =>
      actions.get(actionId)!({ ack: args.ack ?? (async () => undefined), body: args.body ?? {}, action: args.action ?? {} }),
    connection: (up: boolean) => connection!(up),
    die: () => deadListeners.forEach(cb => cb()),
  };
}

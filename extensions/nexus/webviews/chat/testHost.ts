// Test support: a scripted host for the chat view. Everything but slack.post and slack.subscribe is
// answered by the kit's fake transport, and the client still validates every body with the contract.
import { createBridgeClient } from "../shared";
import { createFakeTransport } from "../shared/fakeBridge";
import type { BridgeClient, Transport } from "../shared";
import type { ChatMessage, Envelope } from "../../src/contracts";

export interface PostBody { channelId: string; text: string; threadTs?: string; clientId: string }

export interface TestHost {
  client: BridgeClient;
  posts: PostBody[];
  subscribed: string[][];
  /** Answers the next slack.post with an error; later ones succeed. */
  failNextPost(): void;
  /** Holds slack.post replies until release() so a pending echo can be observed. */
  holdPosts(): void;
  release(): void;
  /** Delivers a slack.subscribe event to every open subscription. */
  emit(evt: { type: "message" | "message_changed"; message: ChatMessage }): void;
  slackTs(n: number): string;
}

export function createTestHost(): TestHost {
  const inner = createFakeTransport({ liveIntervalMs: 0 });
  const listeners = new Set<(env: Envelope) => void>();
  const send = (env: Envelope) => queueMicrotask(() => listeners.forEach((l) => l(env)));
  inner.listen(send);
  const subs = new Map<string, string[]>();
  const posts: PostBody[] = [];
  const subscribed: string[][] = [];
  let failNext = false;
  let hold = false;
  let held: Array<() => void> = [];
  let counter = 0;

  const transport: Transport = {
    post(env) {
      if (env.t === "sub" && env.name === "slack.subscribe") {
        const channelIds = (env.body as { channelIds: string[] }).channelIds;
        subs.set(env.id, channelIds);
        subscribed.push(channelIds);
      } else if (env.t === "unsub" && subs.has(env.id)) {
        subs.delete(env.id);
      } else if (env.t === "req" && env.name === "slack.post") {
        const body = env.body as PostBody;
        posts.push(body);
        const reply = () => {
          if (failNext) {
            failNext = false;
            send({ t: "res", id: env.id, ok: false, error: { code: "provider_error", message: "slack said no" } });
            return;
          }
          const ts = `1762490000.${String(++counter).padStart(6, "0")}`;
          const message: ChatMessage = {
            id: `${body.channelId}:${ts}`, channelId: body.channelId, ts, threadTs: body.threadTs,
            author: { id: "U_ADRIAN", name: "adrian", isBot: false }, text: body.text, codeRefs: [], sentVia: "user",
          };
          send({ t: "res", id: env.id, ok: true, body: message });
        };
        if (hold) held.push(reply);
        else reply();
      } else {
        inner.post(env);
      }
    },
    listen(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };

  return {
    client: createBridgeClient(transport),
    posts,
    subscribed,
    failNextPost: () => {
      failNext = true;
    },
    holdPosts: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      const fns = held;
      held = [];
      fns.forEach((f) => f());
    },
    emit: (evt) => subs.forEach((_ids, id) => send({ t: "evt", id, body: evt })),
    slackTs: (n) => `1762491000.${String(n).padStart(6, "0")}`,
  };
}

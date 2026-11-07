// Test support: a scripted host for the chat view. Everything but slack.post and slack.subscribe is
// answered by the kit's fake transport, and the client still validates every body with the contract.
import { createBridgeClient } from "../shared";
import { createFakeTransport } from "../shared/fakeBridge";
import type { BridgeClient, Transport } from "../shared";
import type { ChatMessage, Envelope, ErrorCode } from "../../src/contracts";

export interface PostBody { channelId: string; text: string; threadTs?: string; clientId: string }

/** A slack.post the host has not answered yet (see holdPosts). */
export interface HeldPost {
  body: PostBody;
  ok(): void;
  fail(code?: ErrorCode): void;
}

export interface TestHost {
  client: BridgeClient;
  posts: PostBody[];
  subscribed: string[][];
  /** The next slack.post received is answered with an error (default provider_error); later ones succeed. */
  failNextPost(code?: ErrorCode): void;
  /** Holds slack.post replies until release() so a pending echo can be observed. */
  holdPosts(): void;
  /** Answers every held post as decided when it arrived (see failNextPost), and stops holding. */
  release(): void;
  /** Answers every held post with "offline" (what the bridge also reports when a request times out), and stops holding. */
  releaseOffline(): void;
  /** The posts still held, oldest first. */
  held(): HeldPost[];
  /** Delivers a slack.subscribe event to every open subscription. */
  emit(evt: { type: "message" | "message_changed"; message: ChatMessage }): void;
  /** Slack's copy of a post (the ts its reply carries); without clientId when the host does not echo it. */
  copyOf(post: PostBody, opts?: { clientId?: boolean }): ChatMessage;
  slackTs(n: number): string;
}

export interface HistoryPage { messages: ChatMessage[]; nextCursor?: string; fromCache: boolean }

export interface HostOptions {
  /** Scripts slack.history; may return a promise to hold the reply, or throw to fail it. */
  history?: (body: { channelId: string; cursor?: string; limit?: number }) => HistoryPage | Promise<HistoryPage>;
  /** Scripts slack.users. */
  users?: (body: { ids?: string[] }) => unknown[] | Promise<unknown[]>;
  /** Whether the slack.post reply carries the clientId back (the contract's target; Lane 2's host does not yet). Default true. */
  echoClientId?: boolean;
  /** Bridge timeout for slack.post, so a held post times out like a slow host. */
  postTimeoutMs?: number;
}

export function createTestHost(opts: HostOptions = {}): TestHost {
  const inner = createFakeTransport({ liveIntervalMs: 0 });
  const listeners = new Set<(env: Envelope) => void>();
  const send = (env: Envelope) => queueMicrotask(() => listeners.forEach((l) => l(env)));
  inner.listen(send);
  const subs = new Map<string, string[]>();
  const posts: PostBody[] = [];
  const subscribed: string[][] = [];
  const tsOf = new Map<PostBody, string>();
  let failNext: ErrorCode | undefined;
  let hold = false;
  let held: Array<HeldPost & { decided?: ErrorCode }> = [];
  let counter = 0;
  const echo = opts.echoClientId ?? true;

  const copyOf = (body: PostBody, o: { clientId?: boolean } = {}): ChatMessage => {
    const ts = tsOf.get(body) ?? "1762490000.999999";
    return {
      id: `${body.channelId}:${ts}`, channelId: body.channelId, ts, ...(body.threadTs ? { threadTs: body.threadTs } : {}),
      author: { id: "U_ADRIAN", name: "adrian", isBot: false }, text: body.text, codeRefs: [], sentVia: "user",
      ...((o.clientId ?? echo) ? { clientId: body.clientId } : {}),
    };
  };

  const scripted = (id: string, run: () => unknown) => {
    Promise.resolve()
      .then(run)
      .then(
        (body) => send({ t: "res", id, ok: true, body }),
        () => send({ t: "res", id, ok: false, error: { code: "offline", message: "scripted failure" } }),
      );
  };

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
        tsOf.set(body, `1762490000.${String(++counter).padStart(6, "0")}`);
        const decided = failNext;
        failNext = undefined;
        let answered = false;
        const answer = (code?: ErrorCode) => {
          if (answered) return;
          answered = true;
          if (code) send({ t: "res", id: env.id, ok: false, error: { code, message: "slack said no" } });
          else send({ t: "res", id: env.id, ok: true, body: copyOf(body) });
        };
        const h = { body, decided, ok: () => answer(), fail: (code: ErrorCode = "provider_error") => answer(code) };
        if (hold) held.push(h);
        else answer(decided);
      } else if (env.t === "req" && env.name === "slack.history" && opts.history) {
        scripted(env.id, () => opts.history!(env.body as never));
      } else if (env.t === "req" && env.name === "slack.users" && opts.users) {
        scripted(env.id, () => opts.users!(env.body as never));
      } else {
        inner.post(env);
      }
    },
    listen(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };

  const base = createBridgeClient(transport);
  const client: BridgeClient = opts.postTimeoutMs
    ? {
        ...base,
        request: ((name, body, o) =>
          base.request(name, body, name === "slack.post" ? { ...o, timeoutMs: opts.postTimeoutMs } : o)) as BridgeClient["request"],
      }
    : base;

  const drain = (fn: (h: HeldPost & { decided?: ErrorCode }) => void) => {
    hold = false;
    const fns = held;
    held = [];
    fns.forEach(fn);
  };

  return {
    client,
    posts,
    subscribed,
    failNextPost: (code = "provider_error") => {
      failNext = code;
    },
    holdPosts: () => {
      hold = true;
    },
    release: () => drain((h) => (h.decided ? h.fail(h.decided) : h.ok())),
    releaseOffline: () => drain((h) => h.fail("offline")),
    held: () => [...held],
    emit: (evt) => subs.forEach((_ids, id) => send({ t: "evt", id, body: evt })),
    copyOf,
    slackTs: (n) => `1762491000.${String(n).padStart(6, "0")}`,
  };
}

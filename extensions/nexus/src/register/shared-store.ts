// The team's shared store (Tiger Cloud) put together: the local copy behind a CombinedStore over TigerStore, plus live sync.
// vscode-free so it is unit-tested; register/lane-2.ts supplies the connection string (SecretStorage or env), never logged.
import { Client } from "pg";
import { CombinedStore } from "../services/events/combined-store";
import type { LocalStore } from "../services/events/local-store";
import { createSync, type ListenFn, type Sync } from "../services/events/sync";
import { createTigerPool, tigerConnectionString, TigerStore, type PoolConstructor, type TigerClient } from "../services/events/tiger-store";

/** The pg.Client shape the LISTEN connection needs (injectable for tests). */
export type ListenClientConstructor = new (config: { connectionString: string; ssl: { rejectUnauthorized: boolean }; connectionTimeoutMillis: number; keepAlive: boolean }) => {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "notification", listener: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
};

/**
 * One dedicated LISTEN connection over TLS. `onClose` is called once when it drops, so sync falls back to polling; a connection
 * that cannot be opened rejects (sync then polls and retries).
 */
export function createTigerListen(connectionString: string, ClientCtor: ListenClientConstructor = Client as unknown as ListenClientConstructor): ListenFn {
  const url = tigerConnectionString(connectionString);
  return async (channel, onPayload, onClose) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error("invalid LISTEN channel");
    const client = new ClientCtor({ connectionString: url, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 5000, keepAlive: true });
    let closed = false, opening = true;
    // While opening, a drop is reported by the rejection below, never also through onClose (pg can emit "end" before connect settles).
    const close = (err?: unknown) => { if (!closed && !opening) { closed = true; onClose?.(err); } };
    client.on("error", err => close(err));
    client.on("end", () => close());
    client.on("notification", msg => { if (!closed && msg.channel === channel && typeof msg.payload === "string") onPayload(msg.payload); });
    try {
      await client.connect();
      await client.query(`LISTEN ${channel}`);
      opening = false;
    } catch (err) {
      closed = true;   // a failed open is reported by rejecting, not through onClose
      try { await client.end(); } catch { /* already gone */ }
      throw err;
    }
    return async () => { closed = true; try { await client.end(); } catch { /* already gone */ } };
  };
}

export interface SharedStoreInputs {
  connectionString: string;
  local: LocalStore;
  /** This install's id (the same one its sessions carry): it decides which approvals this machine owns. */
  machineId: string;
  redact: (text: string) => string;
  log: (message: string) => void;
  /**
   * Shows the person something they should know: a write the shared store refused for good (it stays on this machine only),
   * or this machine's decision replacing someone else's. At most one per kind per minute. Ids and codes only.
   */
  notify?: (message: string) => void;
  now?: () => number;
  /** Test seams. */
  client?: TigerClient & { end?(): Promise<unknown> };
  PoolCtor?: PoolConstructor;
  listen?: ListenFn;
}

export interface SharedStore {
  store: CombinedStore;
  sync: Sync;
  /** Stops sync and closes the pool. */
  dispose(): Promise<void>;
}

/** Builds the combined store and its sync; nothing connects until `sync.start()` (and the first remote call). */
export function createSharedStore(i: SharedStoreInputs): SharedStore {
  const client = i.client ?? (createTigerPool(i.connectionString, i.PoolCtor) as TigerClient & { end?(): Promise<unknown> });
  const store = new CombinedStore({ machineId: i.machineId, local: i.local, remote: new TigerStore({ client, redact: i.redact }) });
  // Ids and codes only: a dropped write or an overwritten decision must leave a trace, never record contents.
  const now = i.now ?? (() => Date.now());
  const lastShown = new Map<string, number>();
  const tell = (kind: string, message: string) => {
    const at = now();
    if (at - (lastShown.get(kind) ?? -Infinity) < 60_000) return;
    lastShown.set(kind, at);
    try { i.notify?.(message); } catch { /* showing a notice never breaks the store */ }
  };
  store.onDeadLetter(d => {
    i.log(`shared store refused a ${d.table} ${d.op} for good (${d.reason})`);
    tell(`dead:${d.table}`, `Nexus: the shared store refused a ${d.table} change for good (${d.reason}). It stays on this machine only; teammates will not see it.`);
  });
  store.onOverride(o => {
    i.log(`the decision on ${o.approvalId} was ${o.from}; this machine runs its agent, so it is now ${o.to}`);
    tell("override", `Nexus: approval ${o.approvalId} was ${o.from} in the shared store, but this machine's agent already acted on "${o.to}", so ${o.to} now stands for everyone.`);
  });
  const sync = createSync({
    client, local: i.local, machineId: i.machineId,
    listen: i.listen ?? createTigerListen(i.connectionString),
    flushOutbox: () => store.flushOutbox(),
    setOnline: online => i.local.setOnline(online),
    log: i.log,
  });
  return {
    store, sync,
    dispose: async () => {
      await sync.stop();
      try { await client.end?.(); } catch { /* best effort */ }
    },
  };
}

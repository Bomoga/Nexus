import type { Auth0Session } from "./auth0-signin";

// The route Lane 2's `nexus://` URI handler calls for `nexus://auth/*` (PLAN L1-14). The extension has one URI handler,
// owned by Lane 2; it hands the auth callback to this function, which passes it to the running Auth0 session.

let current: Auth0Session | undefined;

export function setCurrentAuth(session: Auth0Session | undefined): void {
  current = session;
}

export function getCurrentAuth(): Auth0Session | undefined {
  return current;
}

/** Delegate target for `nexus://auth/callback?code=…&state=…`. Returns false when no sign-in session is running. */
export async function handleAuthUri(uri: string): Promise<boolean> {
  if (!current) return false;
  await current.handleCallback(uri);
  return true;
}

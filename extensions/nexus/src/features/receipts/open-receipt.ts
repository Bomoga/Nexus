// "Nexus: Open Prune receipt" (nexus.openReceipt, Lane 3's command). Lane 1's OptimizerService.openReceipt knows where to
// verify a receipt and what to paste there; this command copies the signed receipt to the clipboard, opens Prune's
// verify page in the system browser, and says what to do. Written against injected deps; src/register/lane-3.ts wires them.
import { plainNotificationText } from "../../shared/plain-text";

/** What Lane 1's OptimizerService.openReceipt returns (src/features/accounts/optimizer.ts ReceiptLink). */
export interface ReceiptLink {
  verifyUrl: string;
  metadataJson?: string;
  message: string;
}

export interface ReceiptSource {
  openReceipt(receiptId: string, sessionId?: string): Promise<ReceiptLink>;
}

export interface OpenReceiptDeps {
  /** Lane 1's optimizer; undefined until extension.ts passes it to registerLane3. */
  receipts: ReceiptSource | undefined;
  askReceiptId(): Promise<string | undefined>;
  copy(text: string): Promise<void>;
  openExternal(url: string): Promise<boolean>;
  info(message: string): void;
  error(message: string): void;
}

/** Prune receipt ids are short opaque tokens; anything else is refused before it reaches the store. */
export const RECEIPT_ID = /^[A-Za-z0-9:_.-]{1,200}$/;

/** Only an https URL is ever opened. */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export async function openReceipt(deps: OpenReceiptDeps, receiptId?: unknown, sessionId?: unknown): Promise<void> {
  if (!deps.receipts) {
    deps.error("Nexus: Prune receipts aren't connected yet in this build.");
    return;
  }
  const id = typeof receiptId === "string" && receiptId ? receiptId : (await deps.askReceiptId())?.trim();
  if (!id) return;
  if (!RECEIPT_ID.test(id)) {
    deps.error("Nexus: that doesn't look like a Prune receipt id.");
    return;
  }
  try {
    const link = await deps.receipts.openReceipt(id, typeof sessionId === "string" && sessionId ? sessionId : undefined);
    if (link.metadataJson) await deps.copy(link.metadataJson);
    if (!isHttpsUrl(link.verifyUrl)) {
      deps.error("Nexus: the receipt's verify address isn't a secure web address, so it wasn't opened.");
      return;
    }
    await deps.openExternal(link.verifyUrl);
    deps.info(plainNotificationText(`Nexus: ${link.message}`));
  } catch (e) {
    deps.error(plainNotificationText(`Nexus: could not open the receipt: ${e instanceof Error ? e.message : String(e)}`));
  }
}

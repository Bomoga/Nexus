import { plainNotificationText } from "../shared/plain-text";
import type { NotifyPort } from "./approvals/approvals-controller";
import type { CommandUi } from "./commands";

// The one place notification text is sanitised before it reaches vscode.window. VS Code turns [label](command:...)
// in notification text into a clickable link that runs the command, so the adapters wrap their ports with these and a
// new caller cannot reintroduce the injection. Callers already cut their text at 300 characters; the adapter's cap is
// larger so a second pass never adds a second "…" (sanitising is idempotent on already-sanitised text).

const ADAPTER_MAX = 1000;
const clean = (text: string) => plainNotificationText(text, ADAPTER_MAX);

/** For a single vscode.window.show*Message call that is not wrapped by a port. */
export const safeText = clean;

export function safeNotifyPort(inner: NotifyPort): NotifyPort {
  return {
    show: (approval, text, onChoice) => inner.show(approval, clean(text), onChoice),
    update: (approvalId, text) => inner.update(approvalId, clean(text)),
  };
}

export function safeMessageUi<T extends { info(message: string): void; error(message: string): void }>(inner: T): T {
  // Spread keeps every other member (prompts, pickers) untouched; only the two message sinks are wrapped.
  return Object.assign(Object.create(Object.getPrototypeOf(inner)) as T, inner, {
    info: (message: string) => inner.info(clean(message)),
    error: (message: string) => inner.error(clean(message)),
  });
}

export function safeCommandUi(inner: CommandUi): CommandUi {
  const safe = safeMessageUi(inner);
  return {
    info: safe.info,
    error: safe.error,
    ...(inner.openSession ? { openSession: (id: string) => inner.openSession?.(id) } : {}),
    pickApproval: items => inner.pickApproval(items.map(i => ({ id: i.id, label: clean(i.label), detail: clean(i.detail) }))),
  };
}

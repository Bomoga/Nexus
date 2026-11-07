import { describe, expect, it } from "vitest";
import { encodeCodeRef, decodeCodeRef } from "../../contracts";
import { plainNotificationText } from "../../shared/plain-text";

/** The shared helper's default cap. */
const MAX_NOTIFICATION_TEXT = 300;

// The fork's notification link syntax, copied from src/vs/base/common/linkedText.ts (LINK_REGEX).
// eslint-disable-next-line no-useless-escape -- kept byte-for-byte as in the fork
const NOTIFICATION_LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/gi;

// Pins the shared helper against the fork's real notification link syntax, for the code-ref and Slack text Lane 2 shows.
describe("plainNotificationText", () => {
  it("keeps a path from a crafted link from becoming a clickable command in a notification", () => {
    const path = "[Open the current version](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22echo%5Cn%22%7D)";
    // the path is a valid code ref: this is what reaches the "does not exist" message
    const ref = decodeCodeRef(encodeCodeRef({ workspaceId: "w", commit: "a".repeat(40), path, startLine: 1, endLine: 1 }));
    expect(ref?.path).toBe(path);
    const shown = plainNotificationText(`${ref!.path} does not exist at aaaaaaaa`);
    expect(shown.match(NOTIFICATION_LINK)).toBeNull();
    expect(shown).not.toMatch(/[[\]]/);
    expect(shown.startsWith("［Open the current version］(command:")).toBe(true);
  });
  it("replaces control characters and cuts long text on code points", () => {
    expect(plainNotificationText("a\nb\tc")).toBe("a b c");
    expect(plainNotificationText("a\u202eb\u200bc\u2028d\u0085e")).toBe("a b c d e");
    const long = plainNotificationText("😀".repeat(MAX_NOTIFICATION_TEXT + 5));
    expect(Array.from(long)).toHaveLength(MAX_NOTIFICATION_TEXT + 1);
    expect(long.endsWith("😀…")).toBe(true);
  });
  it("leaves ordinary text alone", () => {
    expect(plainNotificationText("src/a.ts has uncommitted changes: commit first")).toBe("src/a.ts has uncommitted changes: commit first");
  });
});

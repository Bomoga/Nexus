// Text from untrusted sources (a file path from a nexus:// link or a commit) on its way into a VS Code notification.
// Notifications from extensions turn [label](command:...) into a clickable link that runs the command, so square brackets
// never reach one as themselves.

/** The most characters of untrusted text a notification shows. */
export const MAX_NOTIFICATION_TEXT = 300;

/** Square brackets become their full-width look-alikes, control characters spaces, and the text is cut on code points. */
export function plainNotificationText(text: string, max = MAX_NOTIFICATION_TEXT): string {
  const points = Array.from(text.replace(/\p{Cc}/gu, " ").replace(/\[/g, "［").replace(/\]/g, "］"));
  return points.length > max ? `${points.slice(0, max).join("")}…` : points.join("");
}

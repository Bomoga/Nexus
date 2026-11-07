/**
 * Makes untrusted text (model output, Slack text, command lines, error messages) safe to put in a VS Code notification.
 * VS Code renders [label](command:...) in notification text as a clickable link that runs the command, so square
 * brackets become their full-width look-alikes; control and invisible format characters (newlines, the RTL override) become spaces.
 */
export function plainNotificationText(text: string, max = 300): string {
  const clean = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］");
  const points = Array.from(clean);
  return points.length > max ? points.slice(0, max).join("") + "…" : clean;
}

// Command parsing for cmd.run. The model's command string is untrusted: it is split into argv here and never reaches a shell.

/** Thrown for a command the gate refuses outright. A refusal is an error, never an approval. */
export class CommandRefused extends Error {}

const OPERATORS = new Set(["|", ";", "&", ">", "<", "`", "\n", "\r"]);

/** Splits a command into argv with shell-style quoting (single, double, backslash) and no expansion. Refuses shell operators. */
export function splitCommand(command: string): string[] {
  const argv: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\0") throw new CommandRefused("command contains a NUL byte");
    if (quote === "'") {
      if (c === "'") quote = undefined; else cur += c;
      continue;
    }
    if (c === "`" || (c === "$" && command[i + 1] === "(")) throw new CommandRefused("command substitution is not allowed");
    if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\")) cur += command[++i];
      else cur += c;
      continue;
    }
    if (OPERATORS.has(c)) throw new CommandRefused(`shell operator ${JSON.stringify(c)} is not allowed`);
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === "\\") {
      if (i + 1 >= command.length) throw new CommandRefused("trailing backslash");
      cur += command[++i]; inWord = true; continue;
    }
    if (c === " " || c === "\t") {
      if (inWord) { argv.push(cur); cur = ""; inWord = false; }
      continue;
    }
    cur += c; inWord = true;
  }
  if (quote) throw new CommandRefused("unterminated quote");
  if (inWord) argv.push(cur);
  if (argv.length === 0) throw new CommandRefused("empty command");
  return argv;
}

/** True when argv equals the argv of some allowlist entry exactly. Unparseable entries never match. */
export function isAllowlisted(argv: string[], allowlist: string[]): boolean {
  return allowlist.some(entry => {
    try {
      const allowed = splitCommand(entry);
      return allowed.length === argv.length && allowed.every((a, i) => a === argv[i]);
    } catch { return false; }
  });
}

/** Keeps the last `max` characters, noting how much was dropped. */
export function tail(text: string, max: number): string {
  return text.length <= max ? text : `[... ${text.length - max} chars dropped]\n${text.slice(text.length - max)}`;
}

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

/**
 * True when argv[0] names git or one of its own commands (git, git-push, git-status.exe, any directory, any case). Windows
 * ignores trailing dots and spaces and accepts an NTFS stream suffix, so those are stripped first. The agent never runs git
 * itself; commits go through git.commit.
 */
export function isGitBinary(argv0: string): boolean {
  const base = argv0.split(/[\\/]/).pop()!.replace(/:.*$/, "").replace(/[. ]+$/, "").toLowerCase();
  return /^git(?:-.*)?(?:\.exe)?$/.test(base);
}

const PEM_BEGIN = /-----BEGIN [^-\n]*-----/;
const PEM_END = /-----END [^-\n]*-----[^\n]*\n?/;

/**
 * After text was cut at its START: drop the partial first word, and anything up to an END marker whose BEGIN was cut off,
 * so the redactor (which needs whole tokens and whole PEM blocks) never sees half a secret.
 */
export function trimCutStart(text: string): string {
  const ws = text.search(/\s/);
  let out = ws < 0 ? "" : text.slice(ws + 1);
  const end = PEM_END.exec(out);
  if (end && !PEM_BEGIN.test(out.slice(0, end.index))) out = out.slice(end.index + end[0].length);
  return out;
}

/** After text was cut at its END: drop the partial last word, and a PEM block whose END was cut off. Tokens never contain whitespace. */
export function trimCutEnd(text: string): string {
  const m = /\s(?=\S*$)/.exec(text);
  let out = m ? text.slice(0, m.index + 1) : "";
  const begins = [...out.matchAll(new RegExp(PEM_BEGIN.source, "g"))];
  const last = begins.at(-1);
  if (last && !PEM_END.test(out.slice(last.index))) out = out.slice(0, last.index);
  return out;
}

/** Keeps only absolute PATH entries, so an empty entry or "." cannot let a binary in the worktree shadow an allowlisted one. */
export function absolutePath(value: string | undefined, platform: NodeJS.Platform): string {
  const win = platform === "win32";
  const kept = (value ?? "").split(win ? ";" : ":").filter(e => (win ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(e) : e.startsWith("/")));
  return kept.length > 0 ? kept.join(win ? ";" : ":") : win ? "" : "/usr/bin:/bin";
}

export interface SpawnPlan { file: string; args: string[]; verbatim: boolean }

/**
 * Quotes one argument for a .cmd or .bat shim run by `cmd.exe /d /s /c`. cmd.exe has no escape for `%` or `!` on a /c line,
 * so they are refused along with every character cmd would interpret. Quotes and backslashes follow the
 * CommandLineToArgvW rules the shim's program (node, through %*) splits with, so the program sees the same arguments.
 */
export function cmdQuote(arg: string): string {
  if (/[\^&|<>%!\r\n\0]/.test(arg)) throw new CommandRefused("argument contains a character cmd.exe would interpret");
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") { slashes++; continue; }
    if (ch === '"') { out += "\\".repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/**
 * What to hand to spawn on win32. Node refuses to spawn .cmd and .bat without a shell, so argv[0] is resolved through
 * PATH and PATHEXT and a shim runs via `cmd.exe /d /s /c "<line>"` with every argument escaped. Pure: `exists` and `env` are injected.
 */
export function windowsPlan(argv: string[], env: Record<string, string | undefined>, exists: (file: string) => boolean): SpawnPlan {
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (env.PATH ?? "").split(";").filter(Boolean);
  const name = argv[0]!;
  const hasDir = /[\\/]/.test(name);
  const hasExt = exts.some(e => name.toLowerCase().endsWith(e.toLowerCase()));
  const candidates: string[] = [];
  for (const d of hasDir ? [""] : dirs) {
    const base = d ? `${d.replace(/[\\/]+$/, "")}\\${name}` : name;
    if (hasExt) candidates.push(base);
    for (const e of exts) candidates.push(base + e);
  }
  // A bare name not found on PATH is refused: Windows would otherwise also search the working directory, the worktree.
  const found = candidates.find(exists);
  if (!found) throw new CommandRefused(`${name} was not found on PATH`);
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(found)) throw new CommandRefused(`${name} did not resolve to an absolute path`);
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args: argv.slice(1), verbatim: false };
  const line = [found, ...argv.slice(1)].map(cmdQuote).join(" ");
  const comspec = env.ComSpec ?? (env.SystemRoot ? `${env.SystemRoot}\\System32\\cmd.exe` : undefined);
  if (!comspec) throw new CommandRefused("cannot run a .cmd or .bat shim: ComSpec and SystemRoot are unset");
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

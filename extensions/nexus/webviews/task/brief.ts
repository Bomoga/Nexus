// The brief's leading quoted block (untrusted Slack text) is kept apart from what the user edits, so an
// edit can never rewrite or blur the quote. The quote is the leading run of lines that start with ">"
// (the same rule the agent's system rules use). Only thread tasks have one.
export interface SplitBrief {
  quote: string;
  rest: string;
}

export function splitBrief(brief: string, isThread: boolean): SplitBrief {
  if (!isThread || !brief.startsWith(">")) return { quote: "", rest: brief };
  const lines = brief.split("\n");
  let n = 0;
  while (n < lines.length && lines[n].startsWith(">")) n++;
  return { quote: lines.slice(0, n).join("\n"), rest: lines.slice(n).join("\n").replace(/^\n+/, "") };
}

export function composeBrief(quote: string, rest: string): string {
  if (!quote) return rest;
  return rest ? `${quote}\n\n${rest}` : quote;
}

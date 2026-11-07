// The brief's leading quoted block (untrusted Slack text) is kept apart from what the user edits,
// so an edit can never rewrite or blur the quote. The quote ends at the first blank line.
export interface SplitBrief {
  quote: string;
  rest: string;
}

export function splitBrief(brief: string): SplitBrief {
  if (!brief.startsWith(">")) return { quote: "", rest: brief };
  const end = brief.indexOf("\n\n");
  if (end < 0) return { quote: brief, rest: "" };
  return { quote: brief.slice(0, end), rest: brief.slice(end + 2) };
}

export function composeBrief(quote: string, rest: string): string {
  if (!quote) return rest;
  return rest ? `${quote}\n\n${rest}` : quote;
}

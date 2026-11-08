import { describe, expect, it } from "vitest";
import { mentionedUserIds, toDisplayText } from "./mrkdwn";
import { escapeUserText } from "./web-client";

const names = {
  user: (id: string) => (id === "U123" ? "Ada" : undefined),
  channel: (id: string) => (id === "C123" ? "random" : undefined),
};

describe("toDisplayText", () => {
  it("leaves plain text, code fences, newlines and emoji shortcodes alone", () => {
    const t = "hi :tada:\n```\nconst a = 1\n```\n*bold*";
    expect(toDisplayText(t)).toBe(t);
  });
  it("converts user mentions", () => {
    expect(toDisplayText("<@U123>", names)).toBe("@Ada");
    expect(toDisplayText("<@U999>", names)).toBe("@U999");
    expect(toDisplayText("<@U999>")).toBe("@U999");
    expect(toDisplayText("<@U123|bob>", names)).toBe("@bob");
    expect(toDisplayText("<@W77>")).toBe("@W77");
  });
  it("converts channels", () => {
    expect(toDisplayText("<#C123|general>", names)).toBe("#general");
    expect(toDisplayText("<#C123>", names)).toBe("#random");
    expect(toDisplayText("<#C999>", names)).toBe("#C999");
  });
  it("converts special mentions", () => {
    expect(toDisplayText("<!here> <!channel> <!everyone>")).toBe("@here @channel @everyone");
    expect(toDisplayText("<!here|here>")).toBe("@here");
    expect(toDisplayText("<!subteam^S1|@team>")).toBe("@team");
    expect(toDisplayText("<!subteam^S1>")).toBe("@S1");
    expect(toDisplayText("<!date^1700000000^{date}|Nov 14>")).toBe("Nov 14");
    expect(toDisplayText("<!foo|label>")).toBe("label");
    expect(toDisplayText("<!foo>")).toBe("foo");
  });
  it("reduces nexus code-ref links to their label", () => {
    expect(toDisplayText("see <nexus://nexus.nexus/coderef/abc?x=1|src/a.ts:3-5> ok")).toBe("see src/a.ts:3-5 ok");
    expect(toDisplayText("<nexus://coderef/abc|src/a.ts:3-5>")).toBe("src/a.ts:3-5");
    expect(toDisplayText("<nexus://nexus.nexus/coderef/abc>")).toBe("nexus://nexus.nexus/coderef/abc");
  });
  it("shows where a labeled link goes", () => {
    expect(toDisplayText("<https://evil.example/x|https://bank.example>")).toBe("bank.example (https://evil.example/x)");
    expect(toDisplayText("<https://x.com|label>")).toBe("label (https://x.com)");
    expect(toDisplayText("<https://x.com|https://x.com>")).toBe("https://x.com");
    expect(toDisplayText("<https://x.com|x.com>")).toBe("https://x.com");
    expect(toDisplayText("<https://x.com/|x.com>")).toBe("https://x.com/");
    expect(toDisplayText("<http://x.com>")).toBe("http://x.com");
    expect(toDisplayText("<https://x.com/?a=1&amp;b=2|a &amp; b>")).toBe("a & b (https://x.com/?a=1&b=2)");
  });
  it("handles mailto and other schemes", () => {
    expect(toDisplayText("<mailto:a@b.c|a@b.c>")).toBe("a@b.c");
    expect(toDisplayText("<mailto:a@b.c|Ann>")).toBe("Ann (a@b.c)");
    expect(toDisplayText("<mailto:a@b.c>")).toBe("a@b.c");
    expect(toDisplayText("<tel:123|call>")).toBe("call (tel:123)");
    expect(toDisplayText("<tel:123>")).toBe("tel:123");
  });
  it("keeps lone angle brackets literal", () => {
    expect(toDisplayText("a < b > c")).toBe("a < b > c");
    expect(toDisplayText("<@U1")).toBe("<@U1");
    expect(toDisplayText("x <<@U123>", names)).toBe("x <@Ada");
  });
  it("decodes only amp/lt/gt, once", () => {
    expect(toDisplayText("Map&lt;string&gt; &amp; &quot;")).toBe("Map<string> & &quot;");
    expect(toDisplayText("&amp;lt;")).toBe("&lt;");
  });
  it("never treats an escaped mention as a mention", () => {
    expect(toDisplayText("&lt;@U123&gt;", names)).toBe("<@U123>");
    expect(toDisplayText("&lt;!channel&gt;")).toBe("<!channel>");
  });
  it("round-trips what a person typed through escapeUserText", () => {
    for (const typed of ["Map<string> & <@U1> https://x.com", "<!channel> & <b>", "a<b>c"]) {
      expect(toDisplayText(escapeUserText(typed))).toBe(typed);
    }
  });
  it("is fast on adversarial input", () => {
    for (const unit of ["<", "<@", "&amp;", "<<<<", "<@U1|", "<a|"]) {
      const s = unit.repeat(Math.ceil(40_000 / unit.length));
      const t0 = performance.now();
      toDisplayText(s, names);
      mentionedUserIds(s);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });
});

// A copy of the chat view's linkifier (webviews/chat/MessageRow.tsx), kept here so the service never imports the webview.
const URL_RE = /https?:\/\/[^\s<>]+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}"']+$/;
function linkified(text: string): string[] {
  return [...text.matchAll(URL_RE)].map(m => m[0].replace(TRAILING_PUNCT, ""));
}
const hostOf = (u: string): string => new URL(u).host;

describe("urls survive the chat view's linkifier", () => {
  const bank = "https://bank.example";
  const prefixes = ["", "see ", "https://evil.example/", "x", "(", "evil.example/"];
  const suffixes = ["", "@evil.example/x", ".evil.example", "evil.example", "/path", ":8080", "?q=1", "#frag", ")x", " ok", "https://evil.example/y", ".", ",", ")", ".)", ".@evil.example", "'s"];
  const labels = [undefined, "Sign in", "https://evil.example/x", "evil.example", "bank.example", "hthttps://tps://evil.example/login",
    "httphttps://s://evil.example", "HTTPS://evil.example", "https://", "Sign in https://evil.example", "s://evil.example"];
  it("links exactly the host Slack's link goes to", () => {
    for (const pre of prefixes) for (const suf of suffixes) for (const label of labels) {
      const seq = label === undefined ? `<${bank}>` : `<${bank}|${label}>`;
      const out = toDisplayText(pre + seq + suf);
      const hosts = linkified(out).map(hostOf);
      const own = linkified(pre).concat(linkified(suf)).map(hostOf);   // urls the person typed themselves
      expect(hosts, out).toContain("bank.example");
      expect([...hosts].sort(), out).toEqual(["bank.example", ...own].sort());
    }
  });
  it("keeps the known phishing shapes apart", () => {
    expect(toDisplayText("<https://bank.example|Sign in>@evil.example/login")).toBe("Sign in (https://bank.example) @evil.example/login");
    expect(toDisplayText("<https://bank.example>.evil.example")).toBe("https://bank.example .evil.example");
    expect(toDisplayText("https://evil.example/<https://bank.example>")).toBe("https://evil.example/ https://bank.example");
  });
});

describe("labels and punctuation around links", () => {
  const evilHosts = (text: string): string[] => linkified(toDisplayText(text)).map(hostOf).filter(h => h !== "bank.example");
  it("leaves ordinary punctuation after a link alone", () => {
    expect(toDisplayText("see <https://x.com>.")).toBe("see https://x.com.");
    expect(toDisplayText("(<https://x.com>)")).toBe("(https://x.com)");
    expect(toDisplayText("<https://x.com>, thanks")).toBe("https://x.com, thanks");
    expect(toDisplayText("<https://x.com|docs>.")).toBe("docs (https://x.com).");
    expect(toDisplayText("\"<https://x.com>\"!")).toBe("\"https://x.com\"!");
    for (const t of ["see <https://x.com>.", "(<https://x.com>)", "<https://x.com>, thanks", "<https://x.com|docs>."]) {
      expect(linkified(toDisplayText(t))).toEqual(["https://x.com"]);
    }
  });
  it("round-trips what a person typed: escapeUserText, Slack's copy (it wraps typed urls in <>), then display text", () => {
    const cases: [typed: string, slackWraps: (escaped: string) => string][] = [
      ["see https://x.com.", e => e.replace("https://x.com", "<https://x.com>")],
      ["(https://x.com)", e => e.replace("https://x.com", "<https://x.com>")],
      ["https://x.com, thanks", e => e.replace("https://x.com", "<https://x.com>")],
      ["Map<string> & <@U1> https://x.com!", e => e.replace("https://x.com", "<https://x.com>")],
    ];
    for (const [typed, wrap] of cases) expect(toDisplayText(wrap(escapeUserText(typed)))).toBe(typed);
  });
  it("never lets a label rebuild a scheme, on any kind of sequence", () => {
    const tricks = ["hthttps://tps://evil.example/login", "httphttps://s://evil.example", "HTTPS://evil.example", "hTtPhttps://s://evil.example"];
    for (const t of tricks) {
      for (const seq of [`<https://bank.example|${t}>`, `<nexus://nexus.nexus/coderef/abc|${t}>`, `<@U1|${t}>`, `<#C1|${t}>`, `<!subteam^S1|${t}>`, `<!date^1|${t}>`, `<mailto:a@b.c|${t}>`, `<ftp://f|${t}>`]) {
        for (const suf of ["", "@evil.example", "/x"]) expect(evilHosts(seq + suf), seq + suf).toEqual([]);
      }
    }
    expect(toDisplayText("<https://bank.example|hthttps://tps://evil.example/login>")).toBe("evil.example/login (https://bank.example)");
    expect(toDisplayText("<nexus://nexus.nexus/coderef/abc|https://bank.example>@evil.example")).toBe("bank.example@evil.example");
  });
  it("never spells a scheme across a piece boundary", () => {
    expect(evilHosts("http<!x|s://evil.example>")).toEqual([]);
    expect(evilHosts("htt<!x|ps://evil.example>")).toEqual([]);
    expect(evilHosts("https:<!x|//evil.example>")).toEqual([]);
    expect(evilHosts("<https://bank.example>.<!x|@evil.example>")).toEqual([]);
    expect(evilHosts("<https://bank.example>)<@U1|@evil.example>")).toEqual([]);
  });
  it("lowercases an uppercase scheme so the view still links it, and shows the url alone for an empty label", () => {
    expect(toDisplayText("<HTTPS://bank.example|Sign in>")).toBe("Sign in (https://bank.example)");
    expect(linkified(toDisplayText("<HTTPS://bank.example>"))).toEqual(["https://bank.example"]);
    expect(toDisplayText("<https://bank.example|https://>")).toBe("https://bank.example");
    expect(toDisplayText("<@U1|https://>", { user: () => "ann" })).toBe("@ann");
  });
});

describe("mentionedUserIds", () => {
  it("lists user ids from real mentions only", () => {
    expect(mentionedUserIds("<@U1> hi <@W2|bob> <#C1> &lt;@U3&gt; <@U1>")).toEqual(["U1", "W2"]);
    expect(mentionedUserIds("none")).toEqual([]);
  });
});

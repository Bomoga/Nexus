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
    expect(toDisplayText("<https://evil.example/x|https://bank.example>")).toBe("https://bank.example (https://evil.example/x)");
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

describe("mentionedUserIds", () => {
  it("lists user ids from real mentions only", () => {
    expect(mentionedUserIds("<@U1> hi <@W2|bob> <#C1> &lt;@U3&gt; <@U1>")).toEqual(["U1", "W2"]);
    expect(mentionedUserIds("none")).toEqual([]);
  });
});

// @vitest-environment jsdom
// Mechanical check of CLAUDE.md §6 (PLAN §5.3 L3-01): every view's acceptance runs this.
// Renders kit components with theme.css loaded and asserts what the engine computes, resolving
// the kit's var(--nx-*) tokens (jsdom does not substitute custom properties itself).
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import themeCss from "./theme.css?raw";
import { Button, Chip, EmptyState, Input, KeyValueList, KeyValueRow, Select, StatusLine, Table, Tabs, Toolbar } from "./index";

/** Custom properties declared in the :root block of theme.css. */
function rootTokens(css: string): Map<string, string> {
  const root = /:root\s*\{(?<body>[^}]*)\}/.exec(css)?.groups?.body ?? "";
  const tokens = new Map<string, string>();
  for (const m of root.matchAll(/(?<name>--nx-[\w-]+)\s*:\s*(?<value>[^;]+);/g)) {
    tokens.set(m.groups!.name, m.groups!.value.trim());
  }
  return tokens;
}

const tokens = rootTokens(themeCss);

/** Resolve var(--nx-*) references (recursively) to their literal values. */
function resolve(value: string, depth = 0): string {
  if (depth > 10) {
    throw new Error(`token cycle while resolving ${value}`);
  }
  return value
    .replace(/var\((?<name>--nx-[\w-]+)(?:\s*,\s*[^)]*)?\)/g, (_m, name: string) => {
      const token = tokens.get(name);
      if (token === undefined) {
        throw new Error(`undefined token ${name}`);
      }
      return resolve(token, depth + 1);
    })
    .trim();
}

function computed(el: Element, property: string): string {
  return resolve(getComputedStyle(el).getPropertyValue(property));
}

/** "#AbC123" or "rgb(171, 193, 35)" -> "#abc123". */
function toHex(color: string): string {
  const rgb = /^rgba?\((?<r>\d+),\s*(?<g>\d+),\s*(?<b>\d+)/.exec(color);
  if (!rgb) {
    return color.toLowerCase();
  }
  return "#" + [rgb.groups!.r, rgb.groups!.g, rgb.groups!.b].map((c) => Number(c).toString(16).padStart(2, "0")).join("");
}

const isZero = (v: string) => /^0(px)?$/.test(v);
const isNoShadow = (v: string) => v === "" || v === "none";

/** Hue in degrees of a #rrggbb color. */
function hue(hex: string): number {
  const m = /^#(?<r>[0-9a-f]{2})(?<g>[0-9a-f]{2})(?<b>[0-9a-f]{2})$/i.exec(hex);
  if (!m) {
    throw new Error(`not a #rrggbb color: ${hex}`);
  }
  const [r, g, b] = [m.groups!.r, m.groups!.g, m.groups!.b].map((c) => parseInt(c, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) {
    return 0;
  }
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = themeCss;
  document.head.appendChild(style);
});

afterEach(cleanup);

describe("theme tokens (CLAUDE.md §6)", () => {
  test("geometry tokens are fixed, not taken from the theme", () => {
    expect({
      radius: tokens.get("--nx-radius"),
      control: tokens.get("--nx-control-h"),
      toolbar: tokens.get("--nx-toolbar-h"),
      row: tokens.get("--nx-row-h"),
      uiSmall: tokens.get("--nx-font-ui-sm"),
      ui: tokens.get("--nx-font-ui"),
    }).toEqual({ radius: "0", control: "22px", toolbar: "20px", row: "20px", uiSmall: "11px", ui: "12px" });
  });

  test("the accent is one fixed purple", () => {
    const accent = tokens.get("--nx-accent")!;
    expect(accent).toMatch(/^#[0-9a-f]{6}$/i);
    const h = hue(accent);
    expect(h >= 250 && h <= 290, `hue ${h.toFixed(0)} is not purple`).toBe(true);
  });

  test("data uses the editor font with tabular numbers", () => {
    expect(tokens.get("--nx-font-data")).toContain("var(--vscode-editor-font-family");
    const { container } = render(<span className="nx-data">1234</span>);
    expect(getComputedStyle(container.firstElementChild!).getPropertyValue("font-variant-numeric")).toBe("tabular-nums");
  });

  test("the stylesheet has no rounded corners, shadows, gradients or animation", () => {
    const declarations = [...themeCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?<prop>[\w-]+)\s*:\s*(?<value>[^;{}]+);/g)].map((m) => ({
      prop: m.groups!.prop,
      value: m.groups!.value.trim(),
    }));
    const offending = declarations.filter(
      ({ prop, value }) =>
        (prop === "border-radius" && value !== "var(--nx-radius)" && !isZero(value)) ||
        (prop === "box-shadow" && value !== "none") ||
        (prop === "animation" && value !== "none") ||
        (prop === "transition" && value !== "none") ||
        /gradient\(/.test(value) ||
        prop === "filter" ||
        prop === "backdrop-filter",
    );
    expect(offending).toEqual([]);
  });
});

describe("Button", () => {
  test("is square, 22 px, uppercase 11 px, without a shadow", () => {
    const { getByRole } = render(<Button>Approve</Button>);
    const btn = getByRole("button");
    expect({
      radius: isZero(computed(btn, "border-radius")),
      height: computed(btn, "height"),
      shadow: isNoShadow(computed(btn, "box-shadow")),
      transform: computed(btn, "text-transform"),
      fontSize: computed(btn, "font-size"),
    }).toEqual({ radius: true, height: "22px", shadow: true, transform: "uppercase", fontSize: "11px" });
  });

  test("is 20 px inside a toolbar", () => {
    const { getByRole } = render(
      <Toolbar>
        <Button>Refresh</Button>
      </Toolbar>,
    );
    expect(computed(getByRole("button"), "height")).toBe("20px");
  });

  test("primary uses the accent and shows its keyboard hint", () => {
    const { getByRole, getByText } = render(
      <Button variant="primary" kbd="ESC">
        Untrack
      </Button>,
    );
    expect(toHex(computed(getByRole("button"), "background-color"))).toBe(tokens.get("--nx-accent")!.toLowerCase());
    expect(getByText("ESC").className).toBe("nx-kbd");
  });
});

describe("Input and Select", () => {
  test("are square, 22 px, 12 px monospace", () => {
    const { getByRole } = render(
      <>
        <Input aria-label="name" />
        <Select aria-label="model" options={[{ value: "a", label: "A" }]} />
      </>,
    );
    for (const el of [getByRole("textbox"), getByRole("combobox")]) {
      expect(isZero(computed(el, "border-radius"))).toBe(true);
      expect(computed(el, "height")).toBe("22px");
      expect(computed(el, "font-size")).toBe("12px");
    }
  });
});

describe("Table, KeyValueRow, Chip, StatusLine, Tabs, EmptyState", () => {
  test("table cells are 20 px rows and square", () => {
    const { container } = render(<Table columns={[{ key: "sha", header: "SHA", data: true }]} rows={[{ sha: "3f2a9c1" }]} rowKey={(r) => r.sha} />);
    const td = container.querySelector("td")!;
    expect(computed(td, "height")).toBe("20px");
    expect(td.className).toBe("nx-data");
  });

  test("key-value labels are uppercase", () => {
    const { getByText } = render(
      <KeyValueList>
        <KeyValueRow label="Branch">main</KeyValueRow>
      </KeyValueList>,
    );
    expect(computed(getByText("Branch"), "text-transform")).toBe("uppercase");
  });

  test("chip is square and status line is a 20 px row", () => {
    const { getByText } = render(
      <>
        <Chip>claude</Chip>
        <StatusLine>ready</StatusLine>
      </>,
    );
    expect(isZero(computed(getByText("claude"), "border-radius"))).toBe(true);
    expect(computed(getByText("ready"), "height")).toBe("20px");
  });

  test("the active tab is marked with the accent", () => {
    const { getByRole } = render(<Tabs tabs={[{ id: "a", label: "A" }, { id: "b", label: "B" }]} active="a" onChange={() => undefined} />);
    expect(toHex(computed(getByRole("tab", { selected: true }), "border-bottom-color"))).toBe(tokens.get("--nx-accent")!.toLowerCase());
  });

  test("empty state is one line and one action", () => {
    const { container, getAllByRole } = render(<EmptyState message="No events yet" action={{ label: "Refresh", onClick: () => undefined }} />);
    expect(container.querySelectorAll(".nx-empty-message")).toHaveLength(1);
    expect(getAllByRole("button")).toHaveLength(1);
  });
});

// ---- Design system v2 (docs/playbooks/design-night.md §3) ----

/** The literal #rrggbb a token falls back to when no --vscode-* variable is set (the last hex in its resolved value). */
function fallbackHex(token: string): string {
  const value = resolve(tokens.get(token) ?? "");
  const hexes = value.match(/#[0-9a-f]{6}\b/gi);
  if (!hexes) {
    throw new Error(`${token} has no hex fallback: ${value}`);
  }
  return hexes[hexes.length - 1].toLowerCase();
}

/** WCAG 2.x relative luminance of #rrggbb. */
function luminance(hex: string): number {
  const m = /^#(?<r>[0-9a-f]{2})(?<g>[0-9a-f]{2})(?<b>[0-9a-f]{2})$/i.exec(hex);
  if (!m) {
    throw new Error(`not a #rrggbb color: ${hex}`);
  }
  const [r, g, b] = [m.groups!.r, m.groups!.g, m.groups!.b].map((c) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Every foreground/background pairing the kit paints, with the WCAG floor it must clear (4.5 text, 3 UI). */
const CONTRAST: { fg: string; bg: string; min: number; where: string }[] = [
  { fg: "--nx-accent-fg", bg: "--nx-accent", min: 4.5, where: "primary button label" },
  { fg: "--nx-accent-fg", bg: "--nx-accent-hi", min: 4.5, where: "primary button hover" },
  { fg: "--nx-accent-fg", bg: "--nx-error", min: 4.5, where: "danger button hover" },
  { fg: "--nx-fg", bg: "--nx-accent-deep", min: 4.5, where: "pressed button" },
  { fg: "--nx-fg", bg: "--nx-bg", min: 4.5, where: "body text" },
  { fg: "--nx-fg", bg: "--nx-surface", min: 4.5, where: "text on side regions" },
  { fg: "--nx-fg", bg: "--nx-surface-2", min: 4.5, where: "input text" },
  { fg: "--nx-fg", bg: "--nx-hover-bg", min: 4.5, where: "hovered row" },
  { fg: "--nx-muted", bg: "--nx-bg", min: 4.5, where: "labels" },
  { fg: "--nx-muted", bg: "--nx-surface", min: 4.5, where: "panel headers" },
  { fg: "--nx-muted", bg: "--nx-surface-2", min: 4.5, where: "placeholders, mono block captions" },
  { fg: "--nx-accent-hi", bg: "--nx-bg", min: 4.5, where: "accent text, links, active tab" },
  { fg: "--nx-accent-hi", bg: "--nx-surface", min: 4.5, where: "accent text on side regions" },
  { fg: "--nx-accent-glow", bg: "--nx-bg", min: 4.5, where: "LIVE badge" },
  { fg: "--nx-ok", bg: "--nx-bg", min: 4.5, where: "ok status" },
  { fg: "--nx-pending", bg: "--nx-bg", min: 4.5, where: "pending status" },
  { fg: "--nx-error", bg: "--nx-bg", min: 4.5, where: "error status" },
  { fg: "--nx-focus", bg: "--nx-bg", min: 3, where: "focus ring" },
  { fg: "--nx-focus", bg: "--nx-surface", min: 3, where: "focus ring on side regions" },
  { fg: "--nx-accent", bg: "--nx-bg", min: 3, where: "selected rule, active segment" },
  { fg: "--nx-accent-lo", bg: "--nx-bg", min: 3, where: "accent chip border" },
  { fg: "--nx-border-strong", bg: "--nx-bg", min: 1.5, where: "scrollbar thumb (decorative)" },
];

describe("design system v2 tokens (design-night §3)", () => {
  test("the purple ramp is Nexus Dark's and text on an accent fill is dark, never white", () => {
    expect({
      accent: tokens.get("--nx-accent"),
      hi: tokens.get("--nx-accent-hi"),
      lo: tokens.get("--nx-accent-lo"),
      deep: tokens.get("--nx-accent-deep"),
      glow: tokens.get("--nx-accent-glow"),
      tint: tokens.get("--nx-accent-tint"),
      fg: tokens.get("--nx-accent-fg"),
    }).toEqual({ accent: "#9d6bff", hi: "#b794ff", lo: "#7f77dd", deep: "#5b3fb3", glow: "#d9caff", tint: "#9d6bff22", fg: "#0b0b0e" });
    expect(luminance(fallbackHex("--nx-accent-fg"))).toBeLessThan(0.05);
    for (const t of ["--nx-accent-lo", "--nx-accent-deep", "--nx-accent-glow"]) {
      const h = hue(fallbackHex(t));
      expect(h >= 240 && h <= 290, `${t} hue ${h.toFixed(0)} is not purple`).toBe(true);
    }
  });

  test("surface ladder and type tokens are declared with Nexus Dark fallbacks", () => {
    expect({
      bg: fallbackHex("--nx-bg"),
      surface: fallbackHex("--nx-surface"),
      surface2: fallbackHex("--nx-surface-2"),
      hover: fallbackHex("--nx-hover-bg"),
      border: fallbackHex("--nx-border"),
      borderStrong: fallbackHex("--nx-border-strong"),
      fg: fallbackHex("--nx-fg"),
      muted: fallbackHex("--nx-muted"),
    }).toEqual({ bg: "#0e0e11", surface: "#0b0b0e", surface2: "#14141a", hover: "#17171c", border: "#2e2e36", borderStrong: "#3a3a46", fg: "#d4d4d8", muted: "#8b8b96" });
    expect(tokens.get("--nx-border")).toContain("var(--vscode-contrastBorder");
    expect(tokens.get("--nx-font-ui-family")).toMatch(/^var\(--vscode-font-family,.*Inter/);
    expect(tokens.get("--nx-font-data")).toMatch(/^var\(--vscode-editor-font-family,.*Cascadia Mono.*JetBrains Mono/);
    expect({ xs: tokens.get("--nx-font-xs"), lhSm: tokens.get("--nx-lh-sm"), lhUi: tokens.get("--nx-lh-ui"), listRow: tokens.get("--nx-list-row-h") }).toEqual({
      xs: "10px",
      lhSm: "14px",
      lhUi: "16px",
      listRow: "22px",
    });
  });

  test.each(CONTRAST)("$where: $fg on $bg clears $min:1", ({ fg, bg, min }) => {
    const ratio = contrast(fallbackHex(fg), fallbackHex(bg));
    expect(ratio, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
  });

  test("white on either purple would fail, which is why primary text is dark", () => {
    expect(contrast("#ffffff", fallbackHex("--nx-accent"))).toBeLessThan(4.5);
    expect(contrast("#ffffff", "#8b5cf6")).toBeLessThan(4.5);
  });

  test("primary button text resolves to --nx-accent-fg and the pressed fill to --nx-accent-deep", () => {
    const { getByRole } = render(<Button variant="primary">Approve</Button>);
    const btn = getByRole("button");
    expect(toHex(computed(btn, "color"))).toBe(fallbackHex("--nx-accent-fg"));
    const sheet = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const active = /\.nx-button:active\s*\{(?<body>[^}]*)\}/.exec(sheet)?.groups?.body ?? "";
    expect(active).toContain("background-color: var(--nx-accent-deep)");
    const primaryHover = /\.nx-button--primary:hover\s*\{(?<body>[^}]*)\}/.exec(sheet)?.groups?.body ?? "";
    expect(primaryHover).toContain("color: var(--nx-accent-fg)");
    const dangerHover = /\.nx-button--danger:hover\s*\{(?<body>[^}]*)\}/.exec(sheet)?.groups?.body ?? "";
    expect(dangerHover).toContain("color: var(--nx-accent-fg)");
  });

  test("numerals are tabular with a slashed zero wherever data is shown", () => {
    const { container } = render(
      <>
        <span className="nx-data">0123</span>
        <Table columns={[{ key: "n", header: "N", data: true }]} rows={[{ n: "10" }]} rowKey={(r) => r.n} />
      </>,
    );
    const data = container.querySelector(".nx-data")!;
    const td = container.querySelector("td")!;
    for (const el of [data, td]) {
      const features = getComputedStyle(el).getPropertyValue("font-feature-settings");
      expect(features).toContain('"tnum"');
      expect(features).toContain('"zero"');
      expect(getComputedStyle(el).getPropertyValue("font-variant-numeric")).toBe("tabular-nums");
    }
  });

  test("every interactive kit control carries a 1 px focus ring with a 1 px offset, outside the control", () => {
    const sheet = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const focusRules = [...sheet.matchAll(/(?<selector>[^{}]*:focus(?:-visible|-within)?[^{}]*)\{(?<body>[^}]*)\}/g)];
    expect(focusRules.length).toBeGreaterThan(3);
    const withRing = focusRules.filter((m) => /outline:\s*var\(--nx-border-w\)\s+solid\s+var\(--nx-focus\)/.test(m.groups!.body));
    for (const m of withRing) {
      const offset = /outline-offset:\s*(?<v>[^;]+);/.exec(m.groups!.body)?.groups?.v;
      // Segments sit inside a shared 1 px box, so their ring is drawn inside; everything else is outside (WCAG 2.4.11).
      const inside = /nx-segment/.test(m.groups!.selector);
      expect(offset, m.groups!.selector.trim()).toBe(inside ? "-1px" : "1px");
    }
  });

  test("scrollbars are thin, square and painted with the strong border color", () => {
    const sheet = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/::-webkit-scrollbar\s*\{[^}]*width:\s*8px/.test(sheet)).toBe(true);
    expect(/::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--nx-border-strong\)/.test(sheet)).toBe(true);
  });
});

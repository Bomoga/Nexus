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

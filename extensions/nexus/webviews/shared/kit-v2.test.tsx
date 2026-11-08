// @vitest-environment jsdom
// Render tests for kit v2 (design-night §3.5): every new component and every new prop on an existing one.
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, act } from "@testing-library/react";
import themeCss from "./theme.css?raw";
import { Badge, Button, Chip, Confirm, Input, ListRow, MonoBlock, PanelHeader, Region, SegmentedControl, Table, Tabs, Toolbar, statusBadge } from "./index";

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = themeCss;
  document.head.appendChild(style);
});

afterEach(cleanup);

describe("Button v2", () => {
  test("variants and sizes pick their classes", () => {
    const { getAllByRole } = render(
      <>
        <Button>Default</Button>
        <Button variant="primary">Primary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button size="sm">Small</Button>
      </>,
    );
    expect(getAllByRole("button").map((b) => b.className)).toEqual(["nx-button", "nx-button nx-button--primary", "nx-button nx-button--ghost", "nx-button nx-button--danger", "nx-button nx-button--sm"]);
  });

  test("small buttons are 20 px", () => {
    const { getByRole } = render(<Button size="sm">Small</Button>);
    expect(getComputedStyle(getByRole("button")).getPropertyValue("height")).toBe("20px");
  });
});

describe("Input prefix", () => {
  test("draws the prefix label inside one box and keeps the field accessible", () => {
    const { getByRole, container } = render(<Input prefix="SEARCH" aria-label="search events" placeholder="events" />);
    const wrap = container.querySelector(".nx-input-wrap")!;
    expect(wrap.querySelector(".nx-input-prefix")!.textContent).toBe("SEARCH");
    expect(getByRole("textbox", { name: "search events" }).className).toBe("nx-input");
  });

  test("without a prefix it is a bare input", () => {
    const { container } = render(<Input aria-label="plain" />);
    expect(container.firstElementChild!.tagName).toBe("INPUT");
  });
});

describe("Tabs count", () => {
  test("shows a mono count after the label", () => {
    const { getByRole } = render(<Tabs tabs={[{ id: "log", label: "LOG", count: 12 }, { id: "diff", label: "DIFF" }]} active="log" onChange={() => undefined} />);
    const log = getByRole("tab", { name: /LOG/ });
    expect(log.querySelector(".nx-count")!.textContent).toBe("12");
    expect(getByRole("tab", { name: "DIFF" }).querySelector(".nx-count")).toBeNull();
  });
});

describe("Table v2", () => {
  const rows = [
    { sha: "3f2a9c1", cost: "0.12", path: "src/very/long/path/to/cart.ts" },
    { sha: "9b1d2e0", cost: "1.05", path: "src/b.ts" },
  ];
  test("right-aligns numerics, marks mono columns, truncates with a title, and renders a footer", () => {
    const { container } = render(
      <Table
        columns={[
          { key: "sha", header: "SHA", mono: true },
          { key: "path", header: "PATH", truncate: true },
          { key: "cost", header: "COST", align: "right", data: true },
        ]}
        rows={rows}
        rowKey={(r) => r.sha}
        footer={{ sha: "total", cost: "1.17" }}
      />,
    );
    const firstRow = container.querySelectorAll("tbody tr")[0];
    const cells = firstRow.querySelectorAll("td");
    expect(cells[0].className).toBe("nx-data");
    expect(cells[1].className).toBe("nx-truncate");
    expect(cells[1].getAttribute("title")).toBe("src/very/long/path/to/cart.ts");
    expect(cells[2].className).toBe("nx-data nx-right");
    expect(container.querySelector("thead th.nx-right")!.textContent).toBe("COST");
    const foot = container.querySelectorAll("tfoot td");
    expect([foot[0].textContent, foot[2].textContent]).toEqual(["total", "1.17"]);
  });

  test("clickable rows are keyboard reachable and selected rows are marked", () => {
    const onRowClick = vi.fn();
    const { container } = render(<Table columns={[{ key: "sha", header: "SHA" }]} rows={rows} rowKey={(r) => r.sha} onRowClick={onRowClick} selected={(r) => r.sha === "9b1d2e0"} />);
    const trs = container.querySelectorAll("tbody tr");
    expect(trs[0].getAttribute("tabindex")).toBe("0");
    expect(trs[1].className).toContain("is-selected");
    expect(trs[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(trs[0], { key: "Enter" });
    fireEvent.click(trs[1]);
    expect(onRowClick.mock.calls.map((c) => c[0].sha)).toEqual(["3f2a9c1", "9b1d2e0"]);
  });
});

describe("Chip kinds", () => {
  test("picks a kind class, dashed for stale, and becomes a button with onClick", () => {
    const onClick = vi.fn();
    const { getByText, getByRole } = render(
      <>
        <Chip kind="accent">cart.ts:42-48</Chip>
        <Chip kind="stale">old</Chip>
        <Chip kind="ok">PASS</Chip>
        <Chip onClick={onClick}>open</Chip>
        <Chip tone="error">legacy</Chip>
      </>,
    );
    expect(getByText("cart.ts:42-48").className).toBe("nx-chip nx-chip--accent");
    expect(getByText("old").className).toBe("nx-chip nx-chip--stale");
    expect(getComputedStyle(getByText("old")).getPropertyValue("border-style")).toBe("dashed");
    expect(getByText("PASS").className).toBe("nx-chip nx-chip--ok");
    expect(getByText("legacy").className).toBe("nx-chip nx-tone-error");
    fireEvent.click(getByRole("button", { name: "open" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Toolbar right group", () => {
  test("renders the right group after the left controls", () => {
    const { getByRole, container } = render(
      <Toolbar aria-label="globe" right={<Button size="sm">BACK TO LIVE</Button>}>
        <Button size="sm">24H</Button>
      </Toolbar>,
    );
    expect(getByRole("toolbar", { name: "globe" })).toBeTruthy();
    expect(container.querySelector(".nx-toolbar-right")!.textContent).toContain("BACK TO LIVE");
  });
});

describe("PanelHeader and Region", () => {
  test("header is 22 px, uppercase, with a mono count and right-aligned actions", () => {
    const { getByRole, container } = render(
      <PanelHeader title="Channels" count={4} actions={<Button size="sm">REFRESH</Button>}>
        <Badge kind="live">LIVE</Badge>
      </PanelHeader>,
    );
    const title = getByRole("heading", { level: 2 });
    expect(title.textContent).toBe("Channels");
    expect(title.className).toBe("nx-panel-header-title"); // the heading role is on the title, never on the strip that holds controls
    const header = container.querySelector(".nx-panel-header")!;
    expect(getComputedStyle(header).getPropertyValue("height")).toBe("22px");
    expect(getComputedStyle(header).getPropertyValue("text-transform")).toBe("uppercase");
    expect(header.getAttribute("role")).toBeNull();
    expect(container.querySelector(".nx-count")!.textContent).toBe("4");
    expect(container.querySelector(".nx-panel-header-actions button")!.className).toContain("nx-button--sm");
    expect(container.querySelector(".nx-panel-header-meta .nx-badge")).toBeTruthy();
  });

  test("region wraps header, body and footer, with fill and flush modifiers", () => {
    const { container } = render(
      <Region header="Branches" fill flush pad footer={<div className="nx-status-line">ready</div>} aria-label="branches">
        <span>body</span>
      </Region>,
    );
    const region = container.querySelector("section.nx-region")!;
    expect(region.className).toBe("nx-region nx-region--fill nx-region--flush");
    expect(region.querySelector(".nx-panel-header-title")!.textContent).toBe("Branches");
    expect(region.querySelector(".nx-region-body")!.className).toBe("nx-region-body nx-region-body--pad");
    expect(region.querySelector(".nx-status-line")!.textContent).toBe("ready");
    expect(getComputedStyle(region).getPropertyValue("border-radius")).toBe("0px");
  });

  test("a region header can carry a count and actions", () => {
    const { container } = render(<Region header={{ title: "Approval", count: "run_command", actions: <Button size="sm">X</Button> }} />);
    expect(container.querySelector(".nx-count")!.textContent).toBe("run_command");
    expect(container.querySelector(".nx-panel-header-actions")).toBeTruthy();
  });
});

describe("SegmentedControl", () => {
  test("marks the active segment with aria-pressed and reports changes", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <SegmentedControl aria-label="time window" options={[{ value: "24h", label: "24H" }, { value: "36h", label: "36H" }]} value="36h" onChange={onChange} />,
    );
    expect(getByRole("group", { name: "time window" })).toBeTruthy();
    expect(getByRole("button", { name: "36H" }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: "24H" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(getByRole("button", { name: "24H" }));
    expect(onChange).toHaveBeenCalledWith("24h");
    expect(getComputedStyle(getByRole("group")).getPropertyValue("height")).toBe("22px");
  });
});

describe("Badge", () => {
  test("renders a dot and a kind class, and maps session statuses", () => {
    const { getByText, container } = render(
      <>
        <Badge kind="live">LIVE</Badge>
        <Badge dot={false}>VIEWING</Badge>
      </>,
    );
    expect(getByText("LIVE").className).toBe("nx-badge nx-badge--live");
    expect(container.querySelectorAll(".nx-badge-dot")).toHaveLength(1);
    expect(getByText("VIEWING").className).toBe("nx-badge");
    expect(
      (["running", "awaiting_approval", "done", "failed", "cancelled"] as const).map((s) => statusBadge(s)),
    ).toEqual([
      { kind: "accent", label: "RUNNING" },
      { kind: "pending", label: "AWAITING" },
      { kind: "ok", label: "DONE" },
      { kind: "error", label: "FAILED" },
      { kind: "muted", label: "CANCELLED" },
    ]);
  });
});

describe("ListRow", () => {
  test("is a 22 px grid row with four slots; small rows are 20 px; clickable rows are buttons", () => {
    const onClick = vi.fn();
    const { getByRole, container } = render(
      <>
        <ListRow leading="#" title="nexus-demo" titleText="nexus-demo" meta="2" trailing={<Badge>LIVE</Badge>} selected onClick={onClick} />
        <ListRow title="plain" small />
      </>,
    );
    const row = getByRole("button");
    expect(row.className).toBe("nx-list-row nx-clickable is-selected");
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(getComputedStyle(row).getPropertyValue("height")).toBe("22px");
    expect(row.querySelector(".nx-list-row-title")!.getAttribute("title")).toBe("nexus-demo");
    fireEvent.keyDown(row, { key: " " });
    expect(onClick).toHaveBeenCalledTimes(1);
    const small = container.querySelectorAll(".nx-list-row")[1];
    expect(small.className).toBe("nx-list-row nx-list-row--sm");
    expect(getComputedStyle(small).getPropertyValue("height")).toBe("20px");
  });
});

describe("MonoBlock", () => {
  test("renders a labelled pre that wraps, with a count and a select-all header", () => {
    const { getByText, container } = render(
      <MonoBlock label="Brief" count="3 lines">
        {"line 1\nline 2\nline 3"}
      </MonoBlock>,
    );
    const pre = container.querySelector("pre")!;
    expect(pre.getAttribute("aria-label")).toBe("Brief");
    expect(getComputedStyle(pre).getPropertyValue("white-space")).toBe("pre-wrap");
    expect(getByText("3 lines").className).toBe("nx-count");
    const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
    vi.spyOn(window, "getSelection").mockReturnValue(selection as unknown as Selection);
    fireEvent.doubleClick(container.querySelector(".nx-mono-block-head")!);
    expect(selection.addRange).toHaveBeenCalledTimes(1);
  });
});

describe("Confirm", () => {
  test("arms on the first click, confirms on the second, cancels, and reverts after the timeout", () => {
    vi.useFakeTimers();
    try {
      const onConfirm = vi.fn();
      const { getByRole, queryByRole } = render(<Confirm label="MERGE" onConfirm={onConfirm} revertMs={5000} />);
      fireEvent.click(getByRole("button", { name: "MERGE" }));
      expect(getByRole("button", { name: /CONFIRM MERGE/ })).toBeTruthy();
      fireEvent.click(getByRole("button", { name: /CANCEL/ }));
      expect(onConfirm).not.toHaveBeenCalled();
      expect(getByRole("button", { name: "MERGE" })).toBeTruthy();

      fireEvent.click(getByRole("button", { name: "MERGE" }));
      act(() => {
        vi.advanceTimersByTime(5001);
      });
      expect(queryByRole("button", { name: /CONFIRM MERGE/ })).toBeNull();

      fireEvent.click(getByRole("button", { name: "MERGE" }));
      fireEvent.click(getByRole("button", { name: /CONFIRM MERGE/ }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(getByRole("button", { name: "MERGE" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

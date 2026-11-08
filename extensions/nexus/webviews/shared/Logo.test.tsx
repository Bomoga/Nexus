// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Logo } from "./Logo";

describe("Logo", () => {
  test("is the real mark: 68 stroked segments, two end dots, no background tile, all in currentColor", () => {
    const { container } = render(<Logo data-testid="nexus-logo" className="x" size={72} />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("data-testid")).toBe("nexus-logo");
    expect(svg.getAttribute("width")).toBe("72");
    expect(svg.getAttribute("class")).toContain("nx-logo");
    expect(svg.getAttribute("class")).toContain("x");
    expect(container.querySelectorAll("path").length).toBe(68);
    const dots = [...container.querySelectorAll("circle")].filter((c) => c.getAttribute("fill") === "currentColor");
    expect(dots.length).toBe(2);
    expect(dots.every((c) => c.getAttribute("r") === "16")).toBe(true);
    // The tile is gone: the only rect is the mask's full-view one, never painted.
    expect(container.querySelectorAll("rect:not(mask rect)").length).toBe(0);
    expect(container.querySelector("g")?.getAttribute("stroke")).toBe("currentColor");
    expect(svg.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}/); // no hard-coded colour
  });

  test("keeps each orbit segment's own taper", () => {
    const { container } = render(<Logo />);
    const widths = new Set([...container.querySelectorAll("path[stroke-opacity]")].map((p) => p.getAttribute("stroke-width")));
    expect(widths.size).toBeGreaterThan(10);
    const first = container.querySelector("path") as SVGPathElement;
    expect(first.getAttribute("stroke-width")).toBeTruthy();
    expect(first.getAttribute("stroke-opacity")).toBeTruthy();
  });
});

import { describe, expect, test } from "vitest";
import { ACTIVITY_OFFSET } from "./arcs";
import { BASE_DISTANCE, CAMERA_FAR, MAX_FIT_DISTANCE, fitDistance, outerRadius } from "./fit";
import { orbitLayout } from "./index";

describe("camera fit", () => {
  test("outer radius is the last orbit plus its activity ring", () => {
    const layout = orbitLayout(["main", "feature", "fix", "docs", "chore", "lane-1"]);
    expect(outerRadius(layout)).toBeCloseTo(Math.max(...layout.map((o) => o.radius)) + ACTIVITY_OFFSET, 9);
  });

  test("a small globe keeps the base distance; six families move the camera back until the outer ring fits", () => {
    const small = fitDistance(outerRadius(orbitLayout(["main"])), 40, 1.6);
    const six = fitDistance(outerRadius(orbitLayout(["main", "feature", "fix", "docs", "chore", "lane-1"])), 40, 1.6);
    expect(small).toBe(BASE_DISTANCE);
    expect(six).toBeGreaterThan(BASE_DISTANCE);
    // At that distance the outer ring's top is inside the vertical half-height of the view.
    const halfHeight = six * Math.tan((20 * Math.PI) / 180);
    expect(halfHeight).toBeGreaterThan(outerRadius(orbitLayout(["main", "feature", "fix", "docs", "chore", "lane-1"])));
  });

  test("a view narrower than tall fits by its width", () => {
    const r = 4;
    expect(fitDistance(r, 40, 0.5)).toBeGreaterThan(fitDistance(r, 40, 1));
  });

  test("a very narrow pane is capped well inside the camera's far plane; a bad aspect falls back to square", () => {
    const d = fitDistance(7, 40, 100 / 600);
    expect(d).toBe(MAX_FIT_DISTANCE);
    expect(MAX_FIT_DISTANCE * 1.3).toBeLessThan(CAMERA_FAR);
    expect(fitDistance(4, 40, 0)).toBe(fitDistance(4, 40, 1));
  });
});

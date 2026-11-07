// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { resolvePlanId } from "./planId";

afterEach(() => {
  delete document.body.dataset.planId;
  history.replaceState(null, "", "/");
});

describe("resolvePlanId", () => {
  test("body data attribute wins over the query", async () => {
    document.body.dataset.planId = "plan_host";
    history.replaceState(null, "", "/?planId=plan_query&fake=1");
    expect(await resolvePlanId()).toBe("plan_host");
  });

  test("?planId= works as a dev convenience", async () => {
    history.replaceState(null, "", "/?planId=plan_query");
    expect(await resolvePlanId()).toBe("plan_query");
  });

  test("the fixture plan only in fake mode", async () => {
    expect(await resolvePlanId()).toBeUndefined();
    history.replaceState(null, "", "/?fake=1");
    expect(await resolvePlanId()).toBe("plan_01");
  });
});

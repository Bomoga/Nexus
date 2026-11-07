// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { resolveTaskId } from "./taskId";

afterEach(() => {
  delete document.body.dataset.taskId;
  history.replaceState(null, "", "/");
});

describe("resolveTaskId", () => {
  test("host-injected body data attribute wins over the query", () => {
    document.body.dataset.taskId = "task_host";
    history.replaceState(null, "", "/?taskId=task_query&fake=1");
    expect(resolveTaskId()).toBe("task_host");
  });

  test("?taskId= works as a dev convenience", () => {
    history.replaceState(null, "", "/?taskId=task_query");
    expect(resolveTaskId()).toBe("task_query");
  });

  test("the demo fallback exists only in fake mode", () => {
    history.replaceState(null, "", "/?fake=1");
    expect(resolveTaskId()).toBeTruthy();
    history.replaceState(null, "", "/");
    expect(resolveTaskId()).toBeUndefined();
  });
});

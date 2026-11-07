// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(cleanup);

function Boom(): never {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  test("renders children when nothing throws", () => {
    render(<ErrorBoundary><span>fine</span></ErrorBoundary>);
    expect(screen.getByText("fine")).toBeTruthy();
  });

  test("RELOAD remounts the children, which render when they no longer throw", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let throws = true;
    function Once() {
      if (throws) throw new Error("once");
      return <span>recovered</span>;
    }
    render(<ErrorBoundary><Once /></ErrorBoundary>);
    expect(screen.getByText("this view hit an error")).toBeTruthy();
    throws = false;
    fireEvent.click(screen.getByRole("button", { name: /RELOAD/ }));
    expect(screen.getByText("recovered")).toBeTruthy();
  });

  test("a throwing child shows one line and RELOAD, which calls onReload", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reload = vi.fn();
    render(<ErrorBoundary onReload={reload}><Boom /></ErrorBoundary>);
    expect(screen.getByText("this view hit an error")).toBeTruthy();
    expect(screen.queryByText(/kaboom/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /RELOAD/ }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

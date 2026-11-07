// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BridgeClient } from "../shared";
import type { ApprovalRequest, ChatMessage } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { MessageRow } from "./MessageRow";

afterEach(cleanup);

const base: ChatMessage = {
  id: "C1:1762485300.000100",
  channelId: "C1",
  ts: "1762485300.000100",
  author: { id: "B1", name: "nexus", isBot: true },
  text: "agent wants to run npm test",
  codeRefs: [],
  sentVia: "bot",
};
const buttons = (id = "apr_01") => [
  { type: "section", text: { type: "mrkdwn", text: "Run npm test? <script>alert(1)</script>" } },
  {
    type: "actions",
    elements: [
      { type: "button", action_id: "nexus.approve", value: id, text: { type: "plain_text", text: "Approve" } },
      { type: "button", action_id: "nexus.reject", value: id, text: { type: "plain_text", text: "Reject" } },
    ],
  },
];

function bridge(resolve: (b: { approvalId: string; decision: string }) => ApprovalRequest) {
  let push: ((a: ApprovalRequest) => void) | undefined;
  const client = {
    request: vi.fn(async (name: string, body: never) => {
      if (name === "approvals.resolve") return resolve(body);
      throw new Error(name);
    }),
    subscribe: vi.fn((_n: string, _b: unknown, cb: (a: ApprovalRequest) => void) => {
      push = cb;
      return () => undefined;
    }),
  } as unknown as BridgeClient;
  return { client, push: (a: ApprovalRequest) => push?.(a) };
}

describe("MessageRow", () => {
  test("user message has no bot rule or label and renders code ref chips", () => {
    const { container } = render(<MessageRow message={{ ...fx.thread.messages[0], text: "see this" }} />);
    expect(container.querySelector(".chat-bot")).toBeNull();
    expect(screen.getByRole("button", { name: /cart\.ts:42-48 @3f2a9c1/ })).toBeTruthy();
  });

  test("bot message gets the rule and the model-written label", () => {
    const { container } = render(<MessageRow message={base} />);
    expect(container.querySelector(".chat-bot")).toBeTruthy();
    expect(screen.getByText("NEXUS · model-written")).toBeTruthy();
  });

  test("approve/reject buttons only for the valid block shape; text stays literal", () => {
    const { client } = bridge(() => fx.approvalDecided);
    render(<MessageRow message={{ ...base, blocks: buttons() }} bridge={client} />);
    expect(screen.getByRole("button", { name: "APPROVE" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "REJECT" })).toBeTruthy();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
  });

  test.each([
    ["undefined", undefined],
    ["string", "nope"],
    ["unknown block", [{ type: "weird", x: 1 }]],
    ["missing value", [{ type: "actions", elements: [{ type: "button", action_id: "nexus.approve" }] }]],
    ["other action ids", [{ type: "actions", elements: [{ type: "button", action_id: "x", value: "a" }, { type: "button", action_id: "y", value: "a" }] }]],
    ["mismatched ids", [{ type: "actions", elements: [{ type: "button", action_id: "nexus.approve", value: "a" }, { type: "button", action_id: "nexus.reject", value: "b" }] }]],
  ])("malformed blocks are ignored: %s", (_n, blocks) => {
    const { client } = bridge(() => fx.approval);
    render(<MessageRow message={{ ...base, blocks }} bridge={client} />);
    expect(screen.queryByRole("button", { name: "APPROVE" })).toBeNull();
    expect(screen.queryByRole("button", { name: "REJECT" })).toBeNull();
  });

  test("buttons resolve via the bridge and show the winner", async () => {
    const { client } = bridge((b) => ({ ...fx.approval, id: b.approvalId, decision: "rejected", decidedBy: { via: "slack", userId: "U_BRANDON" } }));
    render(<MessageRow message={{ ...base, blocks: buttons() }} bridge={client} />);
    fireEvent.click(screen.getByRole("button", { name: "REJECT" }));
    await waitFor(() => expect(client.request).toHaveBeenCalledWith("approvals.resolve", { approvalId: "apr_01", decision: "rejected" }));
    await screen.findByText(/decided by U_BRANDON via slack/);
    expect(screen.queryByRole("button", { name: "APPROVE" })).toBeNull();
  });

  test("a decision from another surface arrives by subscription (filtered by id)", async () => {
    const { client, push } = bridge(() => fx.approval);
    render(<MessageRow message={{ ...base, blocks: buttons() }} bridge={client} />);
    push({ ...fx.approvalDecided, id: "apr_other" });
    expect(screen.queryByText(/decided by/)).toBeNull();
    push({ ...fx.approvalDecided, id: "apr_01" });
    await screen.findByText(/decided by U_BRANDON via slack/);
  });
});

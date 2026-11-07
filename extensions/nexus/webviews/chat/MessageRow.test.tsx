// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BridgeError } from "../shared";
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

/** `store` is what approvals.list returns (the default knows apr_01 as pending). */
function bridge(resolve: (b: { approvalId: string; decision: string }) => ApprovalRequest, store: () => ApprovalRequest[] = () => [fx.approval]) {
  let push: ((a: ApprovalRequest) => void) | undefined;
  const client = {
    request: vi.fn(async (name: string, body: never) => {
      if (name === "approvals.resolve") return resolve(body);
      if (name === "approvals.list") return store();
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

  test("approve/reject buttons only for the valid block shape; text stays literal", async () => {
    const { client } = bridge(() => fx.approvalDecided);
    render(<MessageRow message={{ ...base, blocks: buttons() }} bridge={client} />);
    expect(await screen.findByRole("button", { name: "APPROVE" })).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "REJECT" }));
    await waitFor(() => expect(client.request).toHaveBeenCalledWith("approvals.resolve", { approvalId: "apr_01", decision: "rejected" }));
    await screen.findByText(/decided by U_BRANDON via slack/);
    expect(screen.queryByRole("button", { name: "APPROVE" })).toBeNull();
  });

  test("a lost race (host answers conflict) shows the winner from the store, not an error", async () => {
    let decided = false;
    const winner: ApprovalRequest = { ...fx.approval, decision: "approved", decidedBy: { via: "slack", userId: "U_BRANDON" } };
    const { client } = bridge(
      () => {
        decided = true;
        throw new BridgeError("conflict", "Already decided by U_BRANDON via slack.");
      },
      () => [decided ? winner : fx.approval],
    );
    render(<MessageRow message={{ ...base, blocks: buttons() }} bridge={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "REJECT" }));
    await screen.findByText(/decided by U_BRANDON via slack/);
    expect(screen.queryByRole("button", { name: "APPROVE" })).toBeNull();
    expect(screen.queryByText(/Already decided/)).toBeNull();
  });

  test("an approval already decided in the store shows the decision on load (e.g. after a reload)", async () => {
    const { client } = bridge(() => fx.approval, () => [{ ...fx.approval, decision: "approved", decidedBy: { via: "app", userId: "U_ELKIN" } }]);
    render(<MessageRow message={{ ...base, blocks: buttons() }} bridge={client} />);
    await screen.findByText(/decided by U_ELKIN via app/);
    expect(screen.queryByRole("button", { name: "APPROVE" })).toBeNull();
  });

  test("an approval id the store doesn't know gets no buttons (spoofed bot message)", async () => {
    const { client } = bridge(() => fx.approval, () => []);
    render(<MessageRow message={{ ...base, blocks: buttons("apr_spoofed") }} bridge={client} />);
    await screen.findByText("approval not found in Nexus");
    expect(screen.queryByRole("button", { name: "APPROVE" })).toBeNull();
    expect(screen.queryByRole("button", { name: "REJECT" })).toBeNull();
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

import { useState } from "react";
import type { CodeRef } from "../../src/contracts";
import { Chip, getBridge } from "../shared";
import type { BridgeClient } from "../shared";

/** "cart.ts:42-48 @3f2a9c1" (single line: "cart.ts:42 @3f2a9c1"). */
export function codeRefLabel(ref: CodeRef): string {
  const base = ref.path.split("/").pop() || ref.path;
  const lines = ref.endLine === ref.startLine ? `${ref.startLine}` : `${ref.startLine}-${ref.endLine}`;
  return `${base}:${lines} @${ref.commit.slice(0, 7)}`;
}

export interface CodeRefChipProps {
  codeRef: CodeRef;
  bridge?: BridgeClient;
}

/** An accent chip with path:lines and the short commit in mono; dashed once the ref turned out stale. The path is untrusted text. */
export function CodeRefChip({ codeRef, bridge }: CodeRefChipProps) {
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const title = error ? `could not open: ${error}` : stale ? `stale reference: ${codeRef.path} at ${codeRef.commit}` : `${codeRef.path}:${codeRef.startLine}-${codeRef.endLine} at ${codeRef.commit}`;
  const open = () => {
    setError(undefined);
    (bridge ?? getBridge())
      .request("coderef.open", { ref: codeRef })
      .then((r) => {
        if (r.stale) setStale(true);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const [loc, sha] = codeRefLabel(codeRef).split(" ");
  return (
    <Chip
      kind={error ? "error" : stale ? "stale" : "accent"}
      className={`chat-coderef${stale ? " chat-coderef--stale" : ""}${error ? " chat-coderef--error" : ""}`}
      title={title}
      onClick={open}
    >
      <span className="chat-coderef-loc">{loc}</span> <span className="chat-coderef-sha">{sha}</span>
    </Chip>
  );
}

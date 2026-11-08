import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Button } from "../shared";

export interface ComposerProps {
  /** Called with the trimmed text; the owner of the message list does the posting. */
  onSend: (text: string) => void;
  placeholder?: string;
  /** The saved draft of this target (the owner keys the composer by target, so it is read once). */
  initialText?: string;
  /** Every change of the draft, including the clear on send. */
  onDraftChange?: (text: string) => void;
}

const MIN_H = 22;
const MAX_H = 88;

export function Composer({ onSend, placeholder = "message", initialText = "", onDraftChange }: ComposerProps) {
  const [text, setText] = useState(initialText);
  // The live value, cleared synchronously on send so a double Enter or double click sends once.
  const latest = useRef(initialText);
  const box = useRef<HTMLTextAreaElement>(null);

  // Grows with the text (Shift+Enter lines) up to a few rows; one row is the kit's 22 px control height.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = `${MIN_H}px`;
    el.style.height = `${Math.min(MAX_H, Math.max(MIN_H, el.scrollHeight))}px`;
  }, [text]);

  const submit = () => {
    const trimmed = latest.current.trim();
    if (!trimmed) return;
    latest.current = "";
    setText("");
    onDraftChange?.("");
    onSend(trimmed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  return (
    <div className="chat-composer">
      <textarea
        ref={box}
        className="nx-input chat-composer-input"
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => {
          latest.current = e.target.value;
          setText(e.target.value);
          onDraftChange?.(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <Button variant="primary" kbd="↵" onClick={submit} disabled={text.trim().length === 0}>
        SEND
      </Button>
    </div>
  );
}

/**
 * One 20 px line under a send that is not confirmed: red "not sent" when the host said no, amber "not confirmed"
 * when no answer came in time (it may still have posted; RETRY re-sends with the same clientId; DISMISS drops it).
 */
export function EchoBar({ state, onRetry, onDismiss }: { state: "failed" | "unconfirmed"; onRetry: () => void; onDismiss?: () => void }) {
  const unconfirmed = state === "unconfirmed";
  return (
    <div className={unconfirmed ? "chat-failed-bar chat-failed-bar--unconfirmed" : "chat-failed-bar"}>
      <span className="chat-failed-text">{unconfirmed ? "not confirmed: may have posted, check before retrying" : "not sent"}</span>
      <Button size="sm" onClick={onRetry}>
        RETRY
      </Button>
      {onDismiss ? (
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          DISMISS
        </Button>
      ) : null}
    </div>
  );
}

/** The wrapper class of a row: red edge for a rejected send, amber for an unconfirmed one. */
export function echoClass(state: string | undefined): string | undefined {
  if (state === "failed") return "chat-failed";
  if (state === "unconfirmed") return "chat-unconfirmed";
  return undefined;
}

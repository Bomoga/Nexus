import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Button } from "../shared";

export interface ComposerProps {
  /** Called with the trimmed text; the owner of the message list does the posting. */
  onSend: (text: string) => void;
  placeholder?: string;
}

const MIN_H = 22;
const MAX_H = 88;

export function Composer({ onSend, placeholder = "message" }: ComposerProps) {
  const [text, setText] = useState("");
  // The live value, cleared synchronously on send so a double Enter or double click sends once.
  const latest = useRef("");
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
        }}
        onKeyDown={onKeyDown}
      />
      <Button variant="primary" onClick={submit} disabled={text.trim().length === 0}>
        SEND
      </Button>
    </div>
  );
}

/** One red line under a message whose send was rejected. */
export function FailedBar({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="chat-failed-bar">
      <span>not sent</span>
      <button type="button" className="chat-retry" onClick={onRetry}>
        RETRY
      </button>
    </div>
  );
}

import type { ReactNode } from "react";
import type { ChatMessage } from "../../src/contracts";
import { Chip } from "../shared";
import type { BridgeClient } from "../shared";
import { BotMessage } from "./BotMessage";
import { CodeRefChip } from "./CodeRefChip";

/** HH:MM in the viewer's locale, from a Slack ts ("1762485300.000100"). */
export function formatTime(ts: string): string {
  return new Date(parseFloat(ts) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Only inline images that cannot reach the network are allowed (the webview CSP forbids the rest). */
export function safeAvatarSrc(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^data:image\/(png|jpeg|gif|webp);/i.test(url)) return url;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && u.hostname.endsWith(".vscode-cdn.net")) return url;
  } catch {
    // not a URL
  }
  return undefined;
}

const URL_RE = /https?:\/\/[^\s<>]+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}"']+$/;

interface Part { text: string; link?: boolean }

/** Splits plain text into text and link parts; trailing punctuation stays out of the link. */
export function splitLinks(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const url = m[0].replace(TRAILING_PUNCT, "");
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, link: true });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export interface MessageRowProps {
  message: ChatMessage;
  /** Display name resolved from slack.users; falls back to the author's name. */
  displayName?: string;
  avatarUrl?: string;
  onOpenLink?: (url: string) => void;
  /** Provided by the thread pane (L3-09); without it the reply count is plain text. */
  onOpenThread?: (message: ChatMessage) => void;
  /** Overrides the page bridge (tests). */
  bridge?: BridgeClient;
}

export function MessageRow({ message, displayName, avatarUrl, onOpenLink, onOpenThread, bridge }: MessageRowProps) {
  const name = displayName ?? message.author.name;
  const src = safeAvatarSrc(avatarUrl);
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  const body: ReactNode[] = splitLinks(message.text).map((p, i) =>
    p.link ? (
      <button key={i} type="button" className="chat-link" onClick={() => onOpenLink?.(p.text)}>
        {p.text}
      </button>
    ) : (
      p.text
    ),
  );
  const chips = message.codeRefs.length ? (
    <span className="chat-coderefs">
      {message.codeRefs.map((r, i) => (
        <CodeRefChip key={`${r.commit}:${r.path}:${r.startLine}-${r.endLine}:${i}`} codeRef={r} bridge={bridge} />
      ))}
    </span>
  ) : null;
  const count = message.replyCount ?? 0;
  const replies = count ? `${count} ${count === 1 ? "REPLY" : "REPLIES"}` : undefined;
  return (
    <div className={`chat-row${message.pending ? " chat-row--pending" : ""}`} data-ts={message.ts}>
      <span className="chat-time nx-data">{formatTime(message.ts)}</span>
      <span className="chat-who">
        {src ? (
          <img className="chat-avatar" src={src} alt="" width={16} height={16} />
        ) : (
          <span className="chat-avatar chat-avatar--initial" aria-hidden="true">
            {initial}
          </span>
        )}
        <span className="chat-name" title={name}>
          {name}
        </span>
      </span>
      {message.sentVia === "bot" ? (
        <BotMessage message={message} bridge={bridge}>
          {body}
          {chips}
        </BotMessage>
      ) : (
        <span className="chat-text">
          {body}
          {chips}
        </span>
      )}
      {replies ? (
        <span className="chat-replies-cell">
          {onOpenThread ? (
            <Chip kind="accent" className="chat-replies" onClick={() => onOpenThread(message)} title="open thread">
              {replies}
            </Chip>
          ) : (
            <Chip kind="accent" className="chat-replies">
              {replies}
            </Chip>
          )}
        </span>
      ) : null}
    </div>
  );
}

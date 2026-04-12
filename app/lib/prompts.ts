/**
 * Prompt text generators for the copy-to-clipboard feature.
 *
 * These produce natural-language prompt fragments designed to be pasted
 * into an agent CLI conversation, giving the model everything it needs
 * to call Rewind's API and understand the referenced OpenCode context.
 */

import type { Session } from "../../src/types";

/** Base URL for the local Rewind app. */
function getBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "http://localhost:3838";
}

// ---------------------------------------------------------------------------
// Level 1: Top-level API reference
// ---------------------------------------------------------------------------

export function buildApiReferencePrompt(): string {
  const base = getBaseUrl();
  return `You have access to Rewind, a local API for inspecting OpenCode sessions.

## Endpoints

### Aggregate overview
GET ${base}/api/dashboard
  Parameters: after, before
  Returns aggregate stats across OpenCode sessions, including models, tools, subagents, compactions, activity by day, and time-of-day usage.

### List sessions
GET ${base}/api/sessions
  Parameters: project, after, before, limit, includeSubagents
  Returns OpenCode session summaries.

### Get session
GET ${base}/api/session/<sessionId>
  Optional: startMessage, endMessage (0-based indices, inclusive) to get a specific range of messages.

## Usage tips
- Use the dashboard to understand filtered aggregate behavior over time.
- Use the session list endpoint to find candidate sessions by date/project.
- Use the session endpoint to inspect message-level tool calls, compactions, subagents, and token usage.
- Use startMessage/endMessage to fetch specific sections of long conversations.`;
}

// ---------------------------------------------------------------------------
// Level 2: Session reference
// ---------------------------------------------------------------------------

export function buildSessionReferencePrompt(session: Session): string {
  const base = getBaseUrl();
  const date = new Date(session.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const msgCount = session.messages.length;

  return `Retrieve this conversation for context:
GET ${base}/api/session/${encodeURIComponent(session.id)}

Title: "${session.title || "Untitled"}"
OpenCode session | ${msgCount} messages | ${date}${session.projectPath ? `\nProject: ${session.projectPath}` : ""}`;
}

// ---------------------------------------------------------------------------
// Level 3: Message range reference
// ---------------------------------------------------------------------------

export function buildRangeReferencePrompt(
  session: Session,
  startIndex: number,
  endIndex: number,
): string {
  const base = getBaseUrl();
  const date = new Date(session.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const totalMessages = session.messages.length;

  // Build a brief description of the range from the first user message in it
  const rangeMessages = session.messages.slice(startIndex, endIndex + 1);
  let rangeDescription = "";
  for (const msg of rangeMessages) {
    if (msg.role === "user") {
      for (const block of msg.content) {
        if (block.type === "text" && block.text.length > 0) {
          rangeDescription = block.text.slice(0, 120).replace(/\n/g, " ").trim();
          break;
        }
      }
      if (rangeDescription) break;
    }
  }
  if (!rangeDescription) {
    // Fall back to first text content from any role
    for (const msg of rangeMessages) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text.length > 0) {
          rangeDescription = block.text.slice(0, 120).replace(/\n/g, " ").trim();
          break;
        }
      }
      if (rangeDescription) break;
    }
  }

  return `Retrieve this section of a conversation for context:
GET ${base}/api/session/${encodeURIComponent(session.id)}?startMessage=${startIndex}&endMessage=${endIndex}

Title: "${session.title || "Untitled"}"
OpenCode session | Messages ${startIndex}-${endIndex} of ${totalMessages} | ${date}${rangeDescription ? `\nContext: "${rangeDescription}${rangeDescription.length >= 120 ? "..." : ""}"` : ""}${session.projectPath ? `\nProject: ${session.projectPath}` : ""}`;
}

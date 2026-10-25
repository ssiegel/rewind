"use client";

import { memo } from "react";
import type { Message, MessageContent, ToolResultContent } from "../../src/types";
import { ToolCallBlock } from "./ToolCallBlock";
import { SubagentCallBlock } from "./SubagentCallBlock";
import { CompactionBlock } from "./CompactionBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { formatTimestamp, formatTokens, formatDuration } from "../lib/format";
import { cn } from "../lib/cn";
import { User, Bot, Zap, AlertTriangle, Timer } from "lucide-react";
import Markdown from "react-markdown";

function ContentBlock({
  block,
  onNavigateSubagent,
  toolResultMap,
  pairedResultIds,
}: {
  block: MessageContent;
  onNavigateSubagent?: (sessionId: string) => void;
  toolResultMap?: Map<string, ToolResultContent>;
  pairedResultIds?: Set<string>;
}) {
  switch (block.type) {
    case "text":
      if (!block.text) return null;
      return (
        <div className="prose-message text-[13px] leading-relaxed text-text-primary">
          <Markdown>{block.text}</Markdown>
        </div>
      );
    case "tool_use": {
      // Look up the paired result
      const pairedResult = block.toolCallId
        ? toolResultMap?.get(block.toolCallId)
        : undefined;

      // Subagent task calls get their own component
      if (block.subagentSessionId) {
        return (
          <SubagentCallBlock
            block={block}
            onNavigate={onNavigateSubagent}
            pairedResult={pairedResult}
          />
        );
      }
      return <ToolCallBlock block={block} pairedResult={pairedResult} />;
    }
    case "tool_result": {
      // Skip if this result was already paired with its tool_use
      if (block.toolCallId && pairedResultIds?.has(block.toolCallId)) {
        return null;
      }
      // Orphan result — render standalone. V2 renamed `task` to `subagent`.
      if (block.toolName === "task" || block.toolName === "subagent") {
        return <SubagentCallBlock block={block} />;
      }
      return <ToolCallBlock block={block} />;
    }
    case "thinking":
      return <ThinkingBlock text={block.text} durationMs={block.durationMs} />;
    case "compaction":
      return <CompactionBlock block={block} />;
    default:
      return null;
  }
}

export const MessageBubble = memo(function MessageBubble({
  message,
  sessionProjectPath,
  onNavigateSubagent,
  toolResultMap,
  pairedResultIds,
}: {
  message: Message;
  sessionProjectPath?: string;
  onNavigateSubagent?: (sessionId: string) => void;
  toolResultMap?: Map<string, ToolResultContent>;
  pairedResultIds?: Set<string>;
}) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const isSystem = message.role === "system";
  const isTool = message.role === "tool";

  const metadataPills: string[] = [];
  if (message.mode) metadataPills.push(`mode:${message.mode}`);
  if (message.stopReason) metadataPills.push(`stop:${message.stopReason}`);
  if (message.apiProvider) metadataPills.push(`api:${message.apiProvider}`);
  if (message.cwd && message.cwd !== sessionProjectPath) metadataPills.push(`cwd:${message.cwd}`);

  const tokenPills: Array<{ label: string; value: number }> = [];
  if (message.usage?.inputTokens != null && message.usage.inputTokens > 0) {
    tokenPills.push({ label: "in", value: message.usage.inputTokens });
  }
  if (message.usage?.outputTokens != null && message.usage.outputTokens > 0) {
    tokenPills.push({ label: "out", value: message.usage.outputTokens });
  }
  if (message.usage?.reasoningTokens != null && message.usage.reasoningTokens > 0) {
    tokenPills.push({ label: "reasoning", value: message.usage.reasoningTokens });
  }
  if (message.usage?.cacheReadTokens != null && message.usage.cacheReadTokens > 0) {
    tokenPills.push({ label: "cache-read", value: message.usage.cacheReadTokens });
  }
  if (message.usage?.cacheCreationTokens != null && message.usage.cacheCreationTokens > 0) {
    tokenPills.push({ label: "cache-write", value: message.usage.cacheCreationTokens });
  }

  // System messages with compaction are rendered inline (no bubble wrapper needed)
  const isCompactionOnly = message.content.every((c) => c.type === "compaction");
  if (isCompactionOnly) {
    return (
      <div className="space-y-2">
        {message.content.map((block, i) => (
          <ContentBlock
            key={i}
            block={block}
            onNavigateSubagent={onNavigateSubagent}
            toolResultMap={toolResultMap}
            pairedResultIds={pairedResultIds}
          />
        ))}
      </div>
    );
  }

  // Check if this message is purely tool content (no text)
  const hasOnlyToolContent = message.content.every(
    (c) => c.type === "tool_use" || c.type === "tool_result",
  );

  // Check if all content blocks in this message would be skipped (all paired results)
  const allBlocksSkipped = message.content.every((c) => {
    if (c.type === "tool_result" && c.toolCallId && pairedResultIds?.has(c.toolCallId)) {
      return true;
    }
    return false;
  });
  if (allBlocksSkipped) return null;

  // Skip rendering empty messages
  const hasContent = message.content.some((c) => {
    if (c.type === "text") return c.text.length > 0;
    return true;
  });
  if (!hasContent && !message.error) return null;

  return (
    <div
      className={cn(
        "group relative flex gap-3 rounded-md px-3 py-2.5",
        "transition-colors duration-100",
        isUser && !message.isCompactSummary && "bg-surface-2",
        isUser && message.isCompactSummary && "bg-surface-2/50 border border-border-dim",
        isAssistant && message.isCompactSummary && "bg-surface-2/50 border border-border-dim",
        isAssistant && !message.isCompactSummary && !hasOnlyToolContent && "bg-transparent",
        isSystem && "bg-transparent",
        (isTool || hasOnlyToolContent) && "bg-transparent py-1",
      )}
    >
      {/* Avatar */}
      {!hasOnlyToolContent && !isTool && !isSystem && (
        <div
          className={cn(
            "flex size-6 flex-shrink-0 items-center justify-center rounded mt-0.5",
            isUser && "bg-surface-3",
          )}
          style={
            isAssistant
              ? { backgroundColor: "color-mix(in srgb, var(--color-accent-opencode) 10%, transparent)" }
              : undefined
          }
        >
          {isUser ? (
            <User size={12} className="text-text-secondary" aria-hidden="true" />
          ) : (
            <Bot
              size={12}
              className="text-accent-opencode"
              aria-hidden="true"
            />
          )}
        </div>
      )}

      {/* Content */}
      <div className={cn("min-w-0 flex-1", (hasOnlyToolContent || isTool || isSystem) && "ml-9")}>
        {/* Role + timestamp header */}
        {!hasOnlyToolContent && !isTool && !isSystem && (
          <div className="mb-1 flex items-center gap-2">
            <span
              className={cn(
                "text-[10px] font-semibold uppercase tracking-wider",
                isUser && "text-text-primary",
              )}
              style={isAssistant ? { color: "var(--color-accent-opencode)" } : undefined}
            >
              {isUser ? "You" : "Assistant"}
            </span>
            {message.isCompactSummary && (
              <span className="rounded bg-border-dim px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-text-secondary">
                Summary
              </span>
            )}
            <time
              dateTime={message.timestamp}
              className="font-mono text-[10px] tabular-nums text-text-secondary"
            >
              {formatTimestamp(message.timestamp)}
            </time>
            {message.model && (
              <span className="font-mono text-[10px] text-text-secondary">
                {message.model}
              </span>
            )}
            {isAssistant && message.durationMs != null && (
              <span className="inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-secondary">
                <Timer size={9} aria-hidden="true" />
                {formatDuration(message.durationMs)}
              </span>
            )}
            {tokenPills.length > 0 && (
              <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
                {tokenPills.map((pill) => (
                  <span
                    key={pill.label}
                    className="inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-text-secondary"
                    title={`${pill.label} tokens for this message`}
                  >
                    {pill.label === "in" || pill.label === "out" ? <Zap size={8} aria-hidden="true" /> : null}
                    <span className="text-text-secondary">{pill.label}</span>
                    <span className="text-text-primary">{formatTokens(pill.value)}</span>
                  </span>
                ))}
              </span>
            )}
          </div>
        )}

        {metadataPills.length > 0 && !hasOnlyToolContent && !isTool && !isSystem && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {metadataPills.map((pill) => (
              <span
                key={pill}
                className="rounded border border-border-default bg-surface-1 px-1.5 py-0.5 font-mono text-[9px] text-text-secondary"
              >
                {pill}
              </span>
            ))}
          </div>
        )}

        {/* Error banner */}
        {message.error && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-semantic-error/20 bg-semantic-error/5 px-3 py-2">
            <AlertTriangle size={12} className="flex-shrink-0 text-semantic-error" aria-hidden="true" />
            <span className="font-mono text-[11px] text-semantic-error">
              {message.error.message ?? message.error.name}
            </span>
          </div>
        )}

        {/* Content blocks */}
        <div className="space-y-2">
          {message.content.map((block, i) => (
            <ContentBlock
              key={i}
              block={block}
              onNavigateSubagent={onNavigateSubagent}
              toolResultMap={toolResultMap}
              pairedResultIds={pairedResultIds}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

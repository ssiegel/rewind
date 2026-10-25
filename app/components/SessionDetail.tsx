"use client";

import { memo, useMemo, useState, useCallback, useRef } from "react";
import type { Session, Message, MessageContent, ToolResultContent } from "../../src/types";
import { MessageBubble } from "./MessageBubble";
import { ConversationMinimap } from "./ConversationMinimap";
import { CopyButton } from "./CopyButton";
import { formatTimestamp, formatTokens, formatNumber, formatDuration, formatCost } from "../lib/format";
import { buildSessionReferencePrompt, buildRangeReferencePrompt } from "../lib/prompts";
import { cn } from "../lib/cn";
import * as Popover from "@radix-ui/react-popover";
import {
  Zap,
  ArrowDownToLine,
  Wrench,
  Clock,
  FolderOpen,
  Brain,
  Search,
  X,
  MessageSquare,
  Terminal,
  Workflow,
  Scissors,
  AlertTriangle,
  MousePointerClick,
  XCircle,
  ChevronDown,
  Timer,
  AlertCircle,
  Hash,
} from "lucide-react";

interface ToolCallDetail {
  /** Index of the message containing this tool call. */
  messageIndex: number;
  /** Short description of what the call did. */
  summary: string;
  /** Tool name. */
  toolName: string;
  /** Duration in ms, if available. */
  durationMs?: number;
  /** Whether the result was an error. */
  isError?: boolean;
  /** Whether the call was interrupted. */
  interrupted?: boolean;
}

interface SubagentInfo {
  sessionId: string;
  description: string;
  subagentType: string;
  /** Duration in ms, if available. */
  durationMs?: number;
  /** Index of the message containing this subagent call. */
  messageIndex: number;
}

interface MessageDetail {
  /** Index of the message in the session. */
  messageIndex: number;
  /** Short preview of the message text. */
  preview: string;
  /** Timestamp. */
  timestamp: string;
}

interface SessionStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalTokens: number;
  peakInputTokens: number;
  toolCallCount: number;
  toolBreakdown: Map<string, number>;
  /** Individual tool call details, keyed by tool name. */
  toolCallDetails: Map<string, ToolCallDetail[]>;
  thinkingBlocks: number;
  subagentCalls: number;
  subagents: SubagentInfo[];
  compactions: number;
  errors: number;
  overflowErrors: number;
  models: Set<string>;
  /** Wall-clock duration (first message → last message). */
  wallClockDuration: string;
  /** Total model working time from per-turn durationMs, formatted. */
  modelDuration: string | null;
  /** Raw totalDurationMs for the session. */
  totalDurationMs: number | null;
  /** Cost in USD, if available. */
  cost: number | null;
  /** User messages with text (human-typed, not tool results). */
  userMessages: MessageDetail[];
  /** Assistant messages with visible text (not tool-use-only). */
  assistantMessages: MessageDetail[];
  /** Number of visually rendered messages (excluding paired tool results). */
  visibleMessageCount: number;
}

function formatModelLabel(model: string): string {
  const parts = model.split("/");
  if (parts.length <= 1) return model;

  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  if (last.startsWith("gpt-") || last.startsWith("claude-") || last.startsWith("glm-")) {
    return last;
  }

  return `${prev}/${last}`;
}

function isContextOverflowError(message: Message): boolean {
  const text = `${message.error?.message ?? ""} ${message.stopReason ?? ""}`.toLowerCase();
  return (
    text.includes("prompt is too long") ||
    text.includes("context") ||
    text.includes("maximum context") ||
    text.includes("too many tokens")
  );
}

function getToolCallSummary(block: MessageContent): string {
  if (block.type !== "tool_use") return "";
  const input = block.input as Record<string, unknown> | undefined;
  if (!input) return block.toolName;

  // Try common fields for a useful one-liner
  const desc = input.description ?? input.command ?? input.prompt ?? input.query ?? input.pattern ?? input.filePath ?? input.path ?? input.url ?? "";
  const str = typeof desc === "string" ? desc : JSON.stringify(desc);
  return str.slice(0, 80).replace(/\n/g, " ") || block.toolName;
}

function computeStats(session: Session): SessionStats {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let peakInputTokens = 0;
  let toolCallCount = 0;
  let thinkingBlocks = 0;
  let subagentCalls = 0;
  let compactions = 0;
  let errors = 0;
  let overflowErrors = 0;
  const subagents: SubagentInfo[] = [];
  const toolBreakdown = new Map<string, number>();
  const toolCallDetails = new Map<string, ToolCallDetail[]>();
  const models = new Set<string>();
  const userMessages: MessageDetail[] = [];
  const assistantMessages: MessageDetail[] = [];

  // Build a quick toolCallId → result lookup for pairing durations/errors
  const resultLookup = new Map<string, ToolResultContent>();
  const pairedIds = new Set<string>();
  for (const msg of session.messages) {
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.toolCallId) {
        resultLookup.set(block.toolCallId, block);
      }
    }
  }
  for (const msg of session.messages) {
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.toolCallId && resultLookup.has(block.toolCallId)) {
        pairedIds.add(block.toolCallId);
      }
    }
  }

  for (let msgIdx = 0; msgIdx < session.messages.length; msgIdx++) {
    const msg = session.messages[msgIdx];
    if (msg.usage) {
      const turnInput = msg.usage.inputTokens ?? 0;
      totalInputTokens += turnInput;
      totalOutputTokens += msg.usage.outputTokens ?? 0;
      totalCacheRead += msg.usage.cacheReadTokens ?? 0;
      totalCacheCreation += msg.usage.cacheCreationTokens ?? 0;
      if (turnInput > peakInputTokens) peakInputTokens = turnInput;
    }
    if (msg.model) models.add(msg.model);
    if (msg.error) {
      errors++;
      if (isContextOverflowError(msg)) overflowErrors++;
    }

    // Collect user messages with human-typed text (not tool results)
    if (msg.role === "user") {
      const hasText = msg.content.some((b) => b.type === "text" && b.text.trim().length > 0);
      const isToolResult = msg.content.every((b) => b.type === "tool_result");
      if (hasText && !isToolResult) {
        const textBlock = msg.content.find((b) => b.type === "text" && b.type === "text");
        const preview = textBlock && textBlock.type === "text" ? textBlock.text.slice(0, 80).replace(/\n/g, " ") : "";
        userMessages.push({ messageIndex: msgIdx, preview, timestamp: msg.timestamp });
      }
    }

    // Collect assistant messages with visible text (not tool-use-only)
    if (msg.role === "assistant") {
      const hasText = msg.content.some((b) => b.type === "text" && b.text.trim().length > 0);
      if (hasText) {
        const textBlock = msg.content.find((b) => b.type === "text" && b.type === "text");
        const preview = textBlock && textBlock.type === "text" ? textBlock.text.slice(0, 80).replace(/\n/g, " ") : "";
        assistantMessages.push({ messageIndex: msgIdx, preview, timestamp: msg.timestamp });
      }
    }

    for (const block of msg.content) {
      if (block.type === "tool_use") {
        const name = block.toolName;
        toolBreakdown.set(name, (toolBreakdown.get(name) ?? 0) + 1);

        // Find the paired result for duration/error info
        const result = block.toolCallId ? resultLookup.get(block.toolCallId) : undefined;
        const durationMs = result?.durationMs ?? block.durationMs;

        if (block.subagentSessionId) {
          subagentCalls++;
          const input = block.input as Record<string, unknown> | undefined;
          subagents.push({
            sessionId: block.subagentSessionId,
            description: (input?.description as string) ?? (input?.prompt as string)?.slice(0, 80) ?? block.toolName,
            subagentType: (input?.agent as string) ?? (input?.subagent_type as string) ?? "agent",
            durationMs,
            messageIndex: msgIdx,
          });
        } else {
          toolCallCount++;
        }

        // Collect individual call detail
        const detail: ToolCallDetail = {
          messageIndex: msgIdx,
          summary: getToolCallSummary(block),
          toolName: name,
          durationMs,
          isError: result?.isError,
          interrupted: result?.interrupted,
        };
        const details = toolCallDetails.get(name) ?? [];
        details.push(detail);
        toolCallDetails.set(name, details);
      }
      if (block.type === "thinking") {
        thinkingBlocks++;
      }
      if (block.type === "compaction") {
        compactions++;
      }
    }
  }

  const totalTokens = totalInputTokens + totalOutputTokens;

  // Visible message count: exclude paired tool-result user messages
  let visibleMessageCount = 0;
  for (const msg of session.messages) {
    const allPaired = msg.content.every(
      (c) => c.type === "tool_result" && c.toolCallId && pairedIds.has(c.toolCallId),
    );
    if (allPaired && msg.content.length > 0) continue;
    const hasContent = msg.content.some((c) => {
      if (c.type === "text") return c.text.length > 0;
      return true;
    });
    if (!hasContent && !msg.error) continue;
    visibleMessageCount++;
  }

  // Wall-clock duration (first → last message)
  let wallClockDuration = "";
  if (session.messages.length >= 2) {
    const first = new Date(session.messages[0].timestamp).getTime();
    const last = new Date(
      session.messages[session.messages.length - 1].timestamp,
    ).getTime();
    const diffMs = last - first;
    wallClockDuration = formatDuration(diffMs);
  }

  // Model working time (sum of per-turn durations)
  let computedDurationMs = 0;
  let hasTiming = false;
  for (const msg of session.messages) {
    if (msg.durationMs != null) {
      computedDurationMs += msg.durationMs;
      hasTiming = true;
    }
  }
  const totalDurationMs = session.totalDurationMs ?? (hasTiming ? computedDurationMs : null);
  const modelDuration = totalDurationMs != null ? formatDuration(totalDurationMs) : null;

  // Cost
  const cost = session.cost ?? null;

  return {
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead,
    totalCacheCreation,
    totalTokens,
    peakInputTokens,
    toolCallCount,
    toolBreakdown,
    toolCallDetails,
    thinkingBlocks,
    subagentCalls,
    subagents,
    compactions,
    errors,
    overflowErrors,
    models,
    wallClockDuration,
    modelDuration,
    totalDurationMs,
    cost,
    userMessages,
    assistantMessages,
    visibleMessageCount,
  };
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
  details,
}: {
  icon: React.ComponentType<{ size: number; className?: string }>;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  details?: React.ReactNode[];
}) {
  const visibleDetails = details?.filter(Boolean) ?? [];

  return (
    <div className="rounded-md border border-border-dim bg-surface-2 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <div className="mt-px flex size-6 flex-shrink-0 items-center justify-center rounded bg-surface-3">
          <Icon size={12} className="text-text-tertiary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
            {label}
          </p>
          <div className="mt-1 font-mono text-sm font-semibold text-text-primary tabular-nums break-words">
            {value}
          </div>
          {sub && (
            <div className="mt-0.5 font-mono text-[10px] text-text-secondary">
              {sub}
            </div>
          )}
          {visibleDetails.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {visibleDetails.map((detail, index) => (
                <span
                  key={index}
                  className="inline-flex items-center rounded-md border border-border-default bg-surface-1 px-1.5 py-0.5 font-mono text-[9px] text-text-secondary"
                >
                  {detail}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content type filter chips
// ---------------------------------------------------------------------------

type ContentTypeFilter = "text" | "tool" | "subagent" | "thinking" | "compaction" | "error";

const SessionMessageRow = memo(function SessionMessageRow({
  msg,
  idx,
  msgIdPrefix,
  rangeSelecting,
  isInRange,
  isRangeAnchor,
  rangeLabel,
  isPreamble,
  onMessageClick,
  sessionProjectPath,
  onNavigateSubagent,
  toolResultMap,
  pairedResultIds,
}: {
  msg: Message;
  idx: number;
  msgIdPrefix: string;
  rangeSelecting: boolean;
  isInRange: boolean;
  isRangeAnchor: boolean;
  rangeLabel?: "START" | "END";
  isPreamble: boolean;
  onMessageClick: (index: number) => void;
  sessionProjectPath?: string;
  onNavigateSubagent?: (sessionId: string) => void;
  toolResultMap: Map<string, ToolResultContent>;
  pairedResultIds: Set<string>;
}) {
  return (
    <div
      id={`${msgIdPrefix}${idx}`}
      data-msg-idx={idx}
      onClick={rangeSelecting ? () => onMessageClick(idx) : undefined}
      className={cn(
        "relative rounded-md transition-colors duration-100",
        rangeSelecting && "cursor-pointer",
        rangeSelecting && !isInRange && "hover:ring-1 hover:ring-accent-opencode/20",
        isInRange && "bg-accent-opencode/[0.04] ring-1 ring-accent-opencode/15",
        isRangeAnchor && "ring-2 ring-accent-opencode/30",
        isPreamble && "opacity-40",
      )}
    >
      {isRangeAnchor && rangeLabel && (
        <div className="absolute -left-1 top-2 z-10 rounded bg-accent-opencode px-1.5 py-0.5 font-mono text-[9px] font-semibold text-white">
          {rangeLabel}
        </div>
      )}
      <MessageBubble
        message={msg}
        sessionProjectPath={sessionProjectPath}
        onNavigateSubagent={onNavigateSubagent}
        toolResultMap={toolResultMap}
        pairedResultIds={pairedResultIds}
      />
    </div>
  );
});

function ChatFilterBar({
  chatFilter,
  onFilterChange,
  activeTypeFilters,
  onToggleTypeFilter,
  matchCount,
  totalCount,
  hasSubagents,
  hasThinking,
  hasCompactions,
  hasErrors,
}: {
  chatFilter: string;
  onFilterChange: (v: string) => void;
  activeTypeFilters: Set<ContentTypeFilter>;
  onToggleTypeFilter: (f: ContentTypeFilter) => void;
  matchCount: number;
  totalCount: number;
  hasSubagents: boolean;
  hasThinking: boolean;
  hasCompactions: boolean;
  hasErrors: boolean;
}) {
  const isFiltering = chatFilter.length > 0 || activeTypeFilters.size > 0;

  const typeChips: Array<{ id: ContentTypeFilter; label: string; icon: React.ComponentType<{ size: number; className?: string }>; show: boolean }> = [
    { id: "text", label: "Text", icon: MessageSquare, show: true },
    { id: "tool", label: "Tools", icon: Terminal, show: true },
    { id: "subagent", label: "Subagents", icon: Workflow, show: hasSubagents },
    { id: "thinking", label: "Thinking", icon: Brain, show: hasThinking },
    { id: "compaction", label: "Compaction", icon: Scissors, show: hasCompactions },
    { id: "error", label: "Errors", icon: AlertTriangle, show: hasErrors },
  ];

  return (
    <div className="flex-shrink-0 border-b border-border-dim bg-surface-0/50 px-4 py-2">
      <div className="flex items-center gap-2">
        {/* Search input */}
        <div className="relative flex-1 max-w-72">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
          <input
            type="text"
            value={chatFilter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filter messages..."
            className={cn(
              "w-full rounded-md border border-border-dim bg-surface-2 py-1.5 pl-7 pr-7",
              "font-mono text-xs text-text-primary placeholder:text-text-tertiary/50",
              "transition-colors duration-100 focus:border-border-bright focus:outline-none focus:ring-1 focus:ring-border-bright",
            )}
          />
          {chatFilter && (
            <button
              type="button"
              onClick={() => onFilterChange("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Type filter chips */}
        <div className="flex items-center gap-1">
          {typeChips.filter((c) => c.show).map((chip) => {
            const Icon = chip.icon;
            const active = activeTypeFilters.has(chip.id);
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => onToggleTypeFilter(chip.id)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] transition-colors duration-100",
                  active
                    ? "border-accent-opencode/30 bg-accent-opencode/8 text-accent-opencode"
                    : "border-border-dim bg-transparent text-text-tertiary hover:border-border-bright hover:text-text-secondary",
                )}
                aria-pressed={active}
              >
                <Icon size={10} aria-hidden="true" />
                {chip.label}
              </button>
            );
          })}
        </div>

        {/* Match count */}
        {isFiltering && (
          <span className="font-mono text-[10px] tabular-nums text-text-tertiary ml-auto">
            {matchCount}/{totalCount}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pill Popovers — tool & subagent breakdowns
// ---------------------------------------------------------------------------

function ToolPillPopover({
  name,
  count,
  details,
  onFilter,
  onScrollToMessage,
}: {
  name: string;
  count: number;
  details: ToolCallDetail[];
  onFilter: (name: string) => void;
  onScrollToMessage: (index: number) => void;
}) {
  const errorCount = details.filter((d) => d.isError).length;
  const interruptedCount = details.filter((d) => d.interrupted).length;
  const timedCalls = details.filter((d) => d.durationMs != null);
  const totalDuration = timedCalls.reduce((s, d) => s + (d.durationMs ?? 0), 0);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] transition-colors duration-100",
            "border-border-default bg-surface-1 text-text-primary hover:border-border-bright hover:bg-surface-2",
          )}
        >
          <span className="text-text-primary">{name}</span>
          <span className="font-semibold tabular-nums text-text-primary">{count}</span>
          <ChevronDown size={8} className="text-text-secondary" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 w-72 rounded-lg border border-border-dim bg-surface-0 shadow-lg",
            "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border-dim px-3 py-2">
            <div className="flex items-center gap-2">
              <Terminal size={11} className="text-text-secondary" />
              <span className="font-mono text-[11px] font-semibold text-text-primary">{name}</span>
            </div>
            <div className="flex items-center gap-2">
              {timedCalls.length > 0 && (
                <span className="inline-flex items-center gap-1 font-mono text-[9px] tabular-nums text-text-secondary">
                  <Timer size={9} />
                  {formatDuration(totalDuration)}
                </span>
              )}
              <button
                type="button"
                onClick={() => onFilter(name)}
                className="font-mono text-[9px] text-accent-opencode hover:underline"
              >
                Filter
              </button>
            </div>
          </div>

          {/* Summary row if there are errors or interruptions */}
          {(errorCount > 0 || interruptedCount > 0) && (
            <div className="flex items-center gap-2 border-b border-border-dim px-3 py-1.5">
              {errorCount > 0 && (
                <span className="inline-flex items-center gap-1 font-mono text-[9px] text-semantic-error">
                  <AlertCircle size={9} />
                  {errorCount} error{errorCount > 1 ? "s" : ""}
                </span>
              )}
              {interruptedCount > 0 && (
                <span className="inline-flex items-center gap-1 font-mono text-[9px] text-accent-opencode">
                  <XCircle size={9} />
                  {interruptedCount} interrupted
                </span>
              )}
            </div>
          )}

          {/* Call list */}
          <div className="max-h-64 overflow-y-auto overscroll-contain">
            {details.map((detail, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onScrollToMessage(detail.messageIndex)}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors duration-75",
                  "hover:bg-surface-2",
                  i < details.length - 1 && "border-b border-border-dim/50",
                )}
              >
                <span className="mt-px flex-shrink-0 font-mono text-[9px] tabular-nums text-text-secondary w-4 text-right">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn(
                    "font-mono text-[10px] leading-snug truncate",
                    detail.isError ? "text-semantic-error" : "text-text-primary",
                  )}>
                    {detail.summary}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  {detail.interrupted && (
                    <XCircle size={9} className="text-accent-opencode/60" />
                  )}
                  {detail.isError && (
                    <AlertCircle size={9} className="text-semantic-error/60" />
                  )}
                  {detail.durationMs != null && (
                    <span className="font-mono text-[9px] tabular-nums text-text-secondary">
                      {formatDuration(detail.durationMs)}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SubagentPillPopover({
  subagents,
  onNavigateSubagent,
  onScrollToMessage,
}: {
  subagents: SubagentInfo[];
  onNavigateSubagent?: (sessionId: string) => void;
  onScrollToMessage: (index: number) => void;
}) {
  // Group by subagent type
  const byType = new Map<string, SubagentInfo[]>();
  for (const sa of subagents) {
    const list = byType.get(sa.subagentType) ?? [];
    list.push(sa);
    byType.set(sa.subagentType, list);
  }

  const totalDuration = subagents.reduce((s, sa) => s + (sa.durationMs ?? 0), 0);
  const timedCount = subagents.filter((sa) => sa.durationMs != null).length;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] transition-colors duration-100",
            "border-accent-opencode/20 bg-accent-opencode/[0.06] text-accent-opencode hover:border-accent-opencode/40 hover:bg-accent-opencode/[0.1]",
          )}
        >
          <Workflow size={10} className="flex-shrink-0" aria-hidden="true" />
          <span>Subagents</span>
          <span className="font-semibold tabular-nums">{subagents.length}</span>
          <ChevronDown size={8} className="opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 w-80 rounded-lg border border-border-dim bg-surface-0 shadow-lg",
            "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border-dim px-3 py-2">
            <div className="flex items-center gap-2">
              <Workflow size={11} className="text-accent-opencode" />
              <span className="font-mono text-[11px] font-semibold text-text-primary">
                Subagents
              </span>
              <span className="font-mono text-[10px] tabular-nums text-text-tertiary">
                ({subagents.length})
              </span>
            </div>
            {timedCount > 0 && (
              <span className="inline-flex items-center gap-1 font-mono text-[9px] tabular-nums text-text-tertiary">
                <Timer size={9} />
                {formatDuration(totalDuration)}
              </span>
            )}
          </div>

          {/* Grouped list */}
          <div className="max-h-72 overflow-y-auto overscroll-contain">
            {Array.from(byType.entries()).map(([type, agents]) => (
              <div key={type}>
                {byType.size > 1 && (
                  <div className="sticky top-0 bg-surface-1 px-3 py-1 border-b border-border-dim/50">
                    <span className="font-mono text-[9px] font-medium uppercase tracking-wider text-text-tertiary">
                      {type}
                    </span>
                  </div>
                )}
                {agents.map((sa, i) => (
                  <div
                    key={`${sa.sessionId}-${i}`}
                    className={cn(
                      "flex items-start gap-2 px-3 py-2",
                      i < agents.length - 1 && "border-b border-border-dim/50",
                    )}
                  >
                    <Hash size={9} className="mt-0.5 flex-shrink-0 text-accent-opencode/40" />
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-[10px] leading-snug text-text-secondary line-clamp-2">
                        {sa.description}
                      </p>
                      <div className="mt-0.5 flex items-center gap-2">
                        <span className="font-mono text-[9px] text-text-tertiary/60 capitalize">
                          {sa.subagentType}
                        </span>
                        {sa.durationMs != null && (
                          <span className="inline-flex items-center gap-0.5 font-mono text-[9px] tabular-nums text-text-tertiary">
                            <Timer size={8} />
                            {formatDuration(sa.durationMs)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onScrollToMessage(sa.messageIndex)}
                        className="font-mono text-[9px] text-text-tertiary hover:text-text-secondary hover:underline"
                      >
                        Jump
                      </button>
                      {onNavigateSubagent && (
                        <button
                          type="button"
                          onClick={() => onNavigateSubagent(sa.sessionId)}
                          className="font-mono text-[9px] text-accent-opencode hover:underline"
                        >
                          Open
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------------------
// Message filtering logic
// ---------------------------------------------------------------------------

function messageMatchesFilter(msg: Message, query: string): boolean {
  const q = query.toLowerCase();
  for (const block of msg.content) {
    if (block.type === "text" && block.text.toLowerCase().includes(q)) return true;
    if (block.type === "tool_use") {
      if (block.toolName.toLowerCase().includes(q)) return true;
      const inputStr = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? "");
      if (inputStr.toLowerCase().includes(q)) return true;
    }
    if (block.type === "tool_result" && block.output.toLowerCase().includes(q)) return true;
    if (block.type === "thinking" && block.text.toLowerCase().includes(q)) return true;
  }
  if (msg.model?.toLowerCase().includes(q)) return true;
  if (msg.error?.message?.toLowerCase().includes(q)) return true;
  return false;
}

function messageMatchesTypeFilter(msg: Message, filters: Set<ContentTypeFilter>): boolean {
  if (filters.size === 0) return true;

  for (const filter of filters) {
    switch (filter) {
      case "text":
        if (msg.content.some((b) => b.type === "text" && b.text.length > 0)) return true;
        break;
      case "tool":
        if (msg.content.some((b) => (b.type === "tool_use" && !b.subagentSessionId) || b.type === "tool_result")) return true;
        break;
      case "subagent":
        if (msg.content.some((b) => b.type === "tool_use" && b.subagentSessionId)) return true;
        break;
      case "thinking":
        if (msg.content.some((b) => b.type === "thinking")) return true;
        break;
      case "compaction":
        if (msg.content.some((b) => b.type === "compaction") || msg.isCompactSummary) return true;
        break;
      case "error":
        if (msg.error) return true;
        break;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// SessionDetail component
// ---------------------------------------------------------------------------

export function SessionDetail({
  session,
  onNavigateSubagent,
}: {
  session: Session;
  onNavigateSubagent?: (sessionId: string) => void;
}) {
  const stats = useMemo(() => computeStats(session), [session]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const msgIdPrefix = "msg-";

  // Chat filter state
  const [chatFilter, setChatFilter] = useState("");
  const [activeTypeFilters, setActiveTypeFilters] = useState<Set<ContentTypeFilter>>(new Set());

  // Range selection state
  const [rangeSelecting, setRangeSelecting] = useState(false);
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [rangeEnd, setRangeEnd] = useState<number | null>(null);

  const hasRange = rangeStart !== null && rangeEnd !== null;
  const rangeMin = hasRange ? Math.min(rangeStart, rangeEnd) : null;
  const rangeMax = hasRange ? Math.max(rangeStart, rangeEnd) : null;

  // Pre-build index map to avoid O(n^2) indexOf in render
  const messageIndexMap = useMemo(() => {
    const map = new Map<Message, number>();
    session.messages.forEach((msg, i) => map.set(msg, i));
    return map;
  }, [session.messages]);

  const handleMessageClick = useCallback((originalIndex: number) => {
    if (!rangeSelecting) return;
    if (rangeStart === null) {
      setRangeStart(originalIndex);
    } else if (rangeEnd === null) {
      setRangeEnd(originalIndex);
    } else {
      // Reset: start new selection
      setRangeStart(originalIndex);
      setRangeEnd(null);
    }
  }, [rangeSelecting, rangeStart, rangeEnd]);

  const clearRange = useCallback(() => {
    setRangeStart(null);
    setRangeEnd(null);
    setRangeSelecting(false);
  }, []);

  const scrollToMessage = useCallback((messageIndex: number) => {
    const el = document.getElementById(`${msgIdPrefix}${messageIndex}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [msgIdPrefix]);

  const toggleTypeFilter = useCallback((f: ContentTypeFilter) => {
    setActiveTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }, []);

  // Build tool result lookup map: toolCallId -> ToolResultContent
  // Also track which result IDs have been paired so MessageBubble can skip them
  const { toolResultMap, pairedResultIds } = useMemo(() => {
    const resultMap = new Map<string, ToolResultContent>();
    const pairedIds = new Set<string>();

    // First pass: collect all tool_result blocks with a toolCallId
    for (const msg of session.messages) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.toolCallId) {
          resultMap.set(block.toolCallId, block);
        }
      }
    }

    // Second pass: mark which results are paired (have a matching tool_use)
    for (const msg of session.messages) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.toolCallId && resultMap.has(block.toolCallId)) {
          pairedIds.add(block.toolCallId);
        }
      }
    }

    return { toolResultMap: resultMap, pairedResultIds: pairedIds };
  }, [session.messages]);

  // Detect "preamble" messages at the start of a session — orphan tool results,
  // interruption notices, etc. that precede the first real user-typed prompt.
  // These get visually de-emphasized.
  const preambleEndIndex = useMemo(() => {
    for (let i = 0; i < session.messages.length; i++) {
      const msg = session.messages[i];
      if (msg.role !== "user") return i; // assistant/system = conversation started
      // Check if this is a "real" user message (has substantial text, not just a tool_result or interrupt notice)
      const hasToolResult = msg.content.some((b) => b.type === "tool_result");
      const textBlocks = msg.content.filter((b) => b.type === "text");
      const textContent = textBlocks.map((b) => b.type === "text" ? b.text : "").join("");
      const isInterruptNotice = textContent.includes("[Request interrupted");
      if (!hasToolResult && !isInterruptNotice && textContent.trim().length > 0) {
        return i; // This is the first real user prompt
      }
    }
    return 0;
  }, [session.messages]);

  // Filter messages
  const filteredMessages = useMemo(() => {
    const hasTextFilter = chatFilter.length > 0;
    const hasTypeFilter = activeTypeFilters.size > 0;
    if (!hasTextFilter && !hasTypeFilter) return session.messages;

    return session.messages.filter((msg) => {
      if (hasTypeFilter && !messageMatchesTypeFilter(msg, activeTypeFilters)) return false;
      if (hasTextFilter && !messageMatchesFilter(msg, chatFilter)) return false;
      return true;
    });
  }, [session.messages, chatFilter, activeTypeFilters]);

  // Top tool names for the breakdown
  const topTools = useMemo(() => {
    return Array.from(stats.toolBreakdown.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [stats.toolBreakdown]);

  const models = useMemo(() => Array.from(stats.models), [stats.models]);
  const primaryModel = session.primaryModel ?? models[0] ?? null;
  const cacheReadShare = stats.totalInputTokens > 0 ? stats.totalCacheRead / stats.totalInputTokens : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border-dim px-5 py-3.5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="rounded border border-border-default bg-surface-1 px-1.5 py-0.5 font-mono text-[10px] text-text-primary">
                {session.id}
              </span>
            </div>
            <h2 className="truncate text-[15px] font-semibold text-text-primary text-balance">
              {session.title || "Untitled Session"}
            </h2>
            <div className="mt-1 flex items-center gap-3 text-[10px] text-text-secondary">
              {session.projectPath && (
                <span className="inline-flex items-center gap-1 font-mono min-w-0 truncate">
                  <FolderOpen size={10} aria-hidden="true" />
                  {session.projectPath}
                </span>
              )}
              <time dateTime={session.createdAt} className="tabular-nums">
                {formatTimestamp(session.createdAt)}
              </time>
              {stats.modelDuration && (
                <span className="inline-flex items-center gap-1 tabular-nums" title="Model working time">
                  <Clock size={10} aria-hidden="true" />
                  {stats.modelDuration}
                </span>
              )}
              {stats.wallClockDuration && (
                <span className="inline-flex items-center gap-1 tabular-nums text-text-tertiary/60" title="Wall-clock session duration">
                  ({stats.wallClockDuration} wall)
                </span>
              )}
              {stats.cost != null && (
                <span className="inline-flex items-center gap-1 tabular-nums font-mono">
                  {formatCost(stats.cost)}
                </span>
              )}
            </div>
          </div>
          {/* Actions + Model badges */}
          <div className="flex flex-shrink-0 flex-col items-end gap-2">
            <div className="flex items-center gap-1.5">
              <CopyButton
                getText={() => buildSessionReferencePrompt(session)}
                label="Copy Session Prompt"
                size="sm"
              />
              <button
                type="button"
                onClick={() => {
                  if (rangeSelecting) {
                    clearRange();
                  } else {
                    setRangeSelecting(true);
                  }
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border font-mono text-[10px] px-2 py-1 transition-colors duration-100",
                  rangeSelecting
                    ? "border-accent-opencode/30 bg-accent-opencode/8 text-accent-opencode"
                    : "border-border-dim bg-surface-2 text-text-secondary hover:border-border-bright hover:text-text-primary",
                )}
              >
                <MousePointerClick size={11} className="flex-shrink-0" />
                {rangeSelecting ? "Selecting..." : "Select Range"}
              </button>
            </div>
            <div className="flex flex-wrap justify-end gap-1">
              {models.map((model) => (
                <span
                  key={model}
                  className="rounded border border-border-default bg-surface-1 px-1.5 py-0.5 font-mono text-[10px] text-text-primary"
                >
                  {formatModelLabel(model)}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-5">
          <SummaryCard
            icon={ArrowDownToLine}
            label="Peak Prompt"
            value={
              stats.peakInputTokens > 0
                ? formatTokens(stats.peakInputTokens)
                : "n/a"
            }
            sub="Largest single input turn"
            details={[
              stats.compactions > 0 ? `${stats.compactions} compaction${stats.compactions > 1 ? "s" : ""}` : "No compactions",
              stats.overflowErrors > 0
                ? <span className="text-semantic-error">{stats.overflowErrors} overflow</span>
                : null,
            ]}
          />
          <SummaryCard
            icon={Zap}
            label="Tokens"
            value={formatTokens(stats.totalTokens)}
            sub={`${formatTokens(stats.totalInputTokens)} in / ${formatTokens(stats.totalOutputTokens)} out`}
            details={[
              stats.totalCacheRead > 0 ? `${formatTokens(stats.totalCacheRead)} cache read` : null,
              stats.totalCacheCreation > 0 ? `${formatTokens(stats.totalCacheCreation)} cache write` : null,
              cacheReadShare != null && stats.totalCacheRead > 0
                ? `${Math.round(cacheReadShare * 100)}% cached input`
                : null,
            ]}
          />
          <SummaryCard
            icon={Wrench}
            label="Execution"
            value={formatNumber(stats.toolCallCount)}
            sub="tool calls"
            details={[
              stats.subagentCalls > 0 ? `${stats.subagentCalls} subagent${stats.subagentCalls > 1 ? "s" : ""}` : null,
              stats.thinkingBlocks > 0 ? `${stats.thinkingBlocks} thinking` : null,
              stats.errors > 0
                ? <span className="text-semantic-error">{stats.errors} error{stats.errors > 1 ? "s" : ""}</span>
                : null,
            ]}
          />
          <SummaryCard
            icon={MessageSquare}
            label="Conversation"
            value={formatNumber(stats.visibleMessageCount)}
            sub="visible messages"
            details={[
              `${stats.userMessages.length} user`,
              `${stats.assistantMessages.length} assistant`,
              session.messages.length !== stats.visibleMessageCount
                ? `${session.messages.length} total stored`
                : null,
            ]}
          />
          <SummaryCard
            icon={Clock}
            label="Time & Cost"
            value={stats.modelDuration ?? "n/a"}
            sub="model time"
            details={[
              stats.wallClockDuration ? `${stats.wallClockDuration} wall` : null,
              stats.cost != null ? formatCost(stats.cost) : "No cost data",
              primaryModel ? formatModelLabel(primaryModel) : null,
            ]}
          />
        </div>

        {/* Tool breakdown pills */}
        {(topTools.length > 0 || stats.subagents.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="font-mono text-[9px] font-medium uppercase tracking-wider text-text-tertiary/50 mr-0.5">Tools</span>
            {topTools.map(([name, count]) => (
              <ToolPillPopover
                key={`tool-${name}`}
                name={name}
                count={count}
                details={stats.toolCallDetails.get(name) ?? []}
                onFilter={setChatFilter}
                onScrollToMessage={scrollToMessage}
              />
            ))}
            {stats.subagents.length > 0 && (
              <SubagentPillPopover
                subagents={stats.subagents}
                onNavigateSubagent={onNavigateSubagent}
                onScrollToMessage={scrollToMessage}
              />
            )}
          </div>
        )}
      </div>

      {/* Range selection hint */}
      {rangeSelecting && !hasRange && (
        <div className="flex-shrink-0 border-b border-accent-opencode/20 bg-accent-opencode/[0.04] px-4 py-1.5">
          <p className="font-mono text-[11px] text-accent-opencode">
            {rangeStart === null
              ? "Click a message to set the start of your range"
              : "Click another message to set the end of your range"}
          </p>
        </div>
      )}

      {/* Chat filter bar */}
      <ChatFilterBar
        chatFilter={chatFilter}
        onFilterChange={setChatFilter}
        activeTypeFilters={activeTypeFilters}
        onToggleTypeFilter={toggleTypeFilter}
        matchCount={filteredMessages.length}
        totalCount={stats.visibleMessageCount}
        hasSubagents={stats.subagentCalls > 0}
        hasThinking={stats.thinkingBlocks > 0}
        hasCompactions={stats.compactions > 0}
        hasErrors={stats.errors > 0}
      />

      {/* Messages + Minimap */}
      <div className="flex flex-1 overflow-hidden">
        {/* Messages scroll area */}
        <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-5 py-3 space-y-1">
            {filteredMessages.map((msg, i) => {
              // Use pre-built index map instead of O(n) indexOf
              const originalIndex = messageIndexMap.get(msg) ?? i;
              const idx = originalIndex;

              // Range selection visual state
              const isInRange = rangeMin !== null && rangeMax !== null && idx >= rangeMin && idx <= rangeMax;
              const isRangeAnchor = idx === rangeStart || idx === rangeEnd;
              const rangeLabel = idx === rangeStart ? "START" : idx === rangeEnd ? "END" : undefined;

              return (
                <SessionMessageRow
                  key={msg.id || i}
                  msg={msg}
                  idx={idx}
                  msgIdPrefix={msgIdPrefix}
                  rangeSelecting={rangeSelecting}
                  isInRange={isInRange}
                  isRangeAnchor={isRangeAnchor}
                  rangeLabel={rangeLabel}
                  isPreamble={idx < preambleEndIndex}
                  onMessageClick={handleMessageClick}
                  sessionProjectPath={session.projectPath}
                  onNavigateSubagent={onNavigateSubagent}
                  toolResultMap={toolResultMap}
                  pairedResultIds={pairedResultIds}
                />
              );
            })}
            {filteredMessages.length === 0 && (chatFilter || activeTypeFilters.size > 0) && (
              <div className="flex flex-col items-center justify-center py-16 text-text-tertiary">
                <Search size={20} className="mb-2 opacity-30" />
                <p className="text-sm">No messages match your filter</p>
                <button
                  type="button"
                  onClick={() => { setChatFilter(""); setActiveTypeFilters(new Set()); }}
                  className="mt-2 text-xs text-accent-opencode hover:underline"
                >
                  Clear filters
                </button>
              </div>
            )}
            <div className="h-6" />
          </div>

          {/* Floating range action bar */}
          {hasRange && rangeMin !== null && rangeMax !== null && (
            <div className="sticky bottom-3 z-20 flex justify-center pointer-events-none">
              <div className="pointer-events-auto inline-flex items-center gap-2 rounded-lg border border-accent-opencode/20 bg-surface-0/95 px-3.5 py-2 shadow-lg backdrop-blur-sm">
                <span className="font-mono text-[11px] text-text-secondary tabular-nums">
                  Messages {rangeMin}–{rangeMax}
                  <span className="text-text-tertiary"> ({rangeMax - rangeMin + 1} selected)</span>
                </span>
                <CopyButton
                  getText={() => buildRangeReferencePrompt(session, rangeMin!, rangeMax!)}
                  label="Copy Range Prompt"
                  size="md"
                />
                <button
                  type="button"
                  onClick={clearRange}
                  className="inline-flex items-center gap-1 rounded-md border border-border-dim bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-tertiary transition-colors duration-100 hover:border-border-bright hover:text-text-secondary"
                >
                  <XCircle size={12} />
                  Clear
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Minimap */}
        <ConversationMinimap
          messages={session.messages}
          scrollContainerRef={scrollRef}
        />
      </div>
    </div>
  );
}

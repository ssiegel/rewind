"use client";

import { useState } from "react";
import type { ToolUseContent, ToolResultContent } from "../../src/types";
import { cn } from "../lib/cn";
import {
  ChevronRight,
  Workflow,
  ExternalLink,
  CheckCircle2,
  XCircle,
} from "lucide-react";

function formatInput(input: unknown): string {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return input;
    }
  }
  if (typeof input === "object" && input !== null) {
    return JSON.stringify(input, null, 2);
  }
  return String(input ?? "");
}

// ---------------------------------------------------------------------------
// Result section — reusable for both paired and standalone rendering
// ---------------------------------------------------------------------------

function SubagentResultSection({
  result,
  standalone,
}: {
  result: ToolResultContent;
  standalone?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const isError = result.isError;
  const output = result.output ?? "";
  const lines = output.split("\n");
  const isLong = lines.length > 8 || output.length > 500;

  // Strip the "task_id: ..." prefix line from the output display
  const displayOutput = output.replace(/^task_id:.*\n\n?/, "");
  // Also strip <task_result> wrapper if present
  const cleanOutput = displayOutput
    .replace(/<task_result>\n?/, "")
    .replace(/\n?<\/task_result>/, "")
    .trim();

  const StatusIcon = isError ? XCircle : CheckCircle2;

  return (
    <div
      className={cn(
        standalone && "rounded-md border overflow-hidden",
        standalone && (isError
          ? "border-semantic-error/20 bg-semantic-error/5"
          : "border-accent-opencode/15 bg-accent-opencode/[0.03]"),
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left",
          "transition-colors duration-100 touch-manipulation",
          "hover:bg-surface-3/30",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-bright",
        )}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} subagent result`}
      >
        <ChevronRight
          size={11}
          className={cn(
            "flex-shrink-0 text-text-tertiary transition-transform duration-150",
            expanded && "rotate-90",
          )}
          aria-hidden="true"
        />
        <StatusIcon
          size={12}
          className={cn(
            "flex-shrink-0",
            isError ? "text-semantic-error" : "text-semantic-success",
          )}
          aria-hidden="true"
        />
        <span
          className={cn(
            "font-mono text-[11px]",
            isError ? "text-semantic-error" : "text-text-secondary",
          )}
        >
          {isError ? "Error" : "Result"}
        </span>
        {!expanded && !isLong && (
          <span className="truncate font-mono text-[11px] text-text-tertiary min-w-0">
            {cleanOutput.split("\n")[0]?.slice(0, 60)}
          </span>
        )}
        {isLong && !expanded && (
          <span className="font-mono text-[10px] tabular-nums text-text-tertiary">
            {cleanOutput.split("\n").length} lines
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border-dim bg-surface-1 px-3 py-2 max-h-96 overflow-y-auto">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text-secondary break-words">
            {cleanOutput}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified SubagentCallBlock
// ---------------------------------------------------------------------------

export function SubagentCallBlock({
  block,
  onNavigate,
  pairedResult,
}: {
  block: ToolUseContent | ToolResultContent;
  onNavigate?: (sessionId: string) => void;
  pairedResult?: ToolResultContent;
}) {
  const [callExpanded, setCallExpanded] = useState(false);

  // Standalone tool_result (no paired call) — render just the result
  if (block.type === "tool_result") {
    return <SubagentResultSection result={block} standalone />;
  }

  // tool_use — unified box with optional result section
  const input = block.input as Record<string, unknown> | undefined;
  const description = (input?.description as string) ?? block.toolName;
  const subagentType = (input?.subagent_type as string) ?? "agent";
  const hasResult = !!pairedResult;
  const isError = pairedResult?.isError;

  return (
    <div
      className={cn(
        "rounded-md border overflow-hidden",
        isError
          ? "border-semantic-error/20 bg-accent-opencode/[0.04]"
          : "border-accent-opencode/20 bg-accent-opencode/[0.04]",
      )}
    >
      {/* Call section */}
      <div className="flex w-full items-center gap-0">
        <button
          type="button"
          onClick={() => setCallExpanded(!callExpanded)}
          className={cn(
            "flex flex-1 items-center gap-2 px-3 py-1.5 text-left min-w-0",
            "transition-colors duration-100 touch-manipulation",
            "hover:bg-accent-opencode/[0.06]",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-bright",
          )}
          aria-expanded={callExpanded}
          aria-label={`${callExpanded ? "Collapse" : "Expand"} subagent call`}
        >
          <ChevronRight
            size={11}
            className={cn(
              "flex-shrink-0 text-accent-opencode transition-transform duration-150",
              callExpanded && "rotate-90",
            )}
            aria-hidden="true"
          />
          <Workflow size={12} className="flex-shrink-0 text-accent-opencode" aria-hidden="true" />
          <span className="font-mono text-[11px] font-medium text-accent-opencode">
            {subagentType}
          </span>
          <span className="truncate text-[11px] text-text-secondary min-w-0">
            {description}
          </span>
          {/* Status indicator when collapsed */}
          {hasResult && !callExpanded && (
            <span className="ml-auto flex-shrink-0">
              {isError ? (
                <XCircle size={11} className="text-semantic-error" aria-hidden="true" />
              ) : (
                <CheckCircle2 size={11} className="text-semantic-success" aria-hidden="true" />
              )}
            </span>
          )}
        </button>
        {block.subagentSessionId && onNavigate && (
          <button
            type="button"
            onClick={() => onNavigate(block.subagentSessionId!)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 flex-shrink-0",
              "text-[10px] font-mono text-accent-opencode/70",
              "transition-colors duration-100 touch-manipulation",
              "hover:text-accent-opencode hover:bg-accent-opencode/[0.08]",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-bright",
            )}
            aria-label={`Open subagent session: ${description}`}
          >
            <span>Open</span>
            <ExternalLink size={10} aria-hidden="true" />
          </button>
        )}
      </div>
      {callExpanded && (
        <div className="border-t border-accent-opencode/10 bg-surface-1 px-3 py-2">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text-secondary">
            {formatInput(block.input)}
          </pre>
        </div>
      )}

      {/* Result section — inside the same box */}
      {hasResult && (
        <div className="border-t border-accent-opencode/10">
          <SubagentResultSection result={pairedResult} />
        </div>
      )}
    </div>
  );
}

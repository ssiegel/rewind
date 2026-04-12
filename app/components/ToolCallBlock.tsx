"use client";

import { useState } from "react";
import type { ToolUseContent, ToolResultContent } from "../../src/types";
import { cn } from "../lib/cn";
import { formatDuration } from "../lib/format";
import {
  ChevronRight,
  Terminal,
  FileEdit,
  Search,
  Eye,
  Pencil,
  Globe,
  FolderSearch,
  CheckCircle2,
  XCircle,
  Timer,
} from "lucide-react";

const toolIcons: Record<string, React.ComponentType<{ size: number; className?: string }>> = {
  Bash: Terminal,
  Edit: FileEdit,
  Write: Pencil,
  Read: Eye,
  Grep: Search,
  Glob: FolderSearch,
  WebFetch: Globe,
  WebSearch: Globe,
  shell: Terminal,
  bash: Terminal,
};

function getToolIcon(name?: string) {
  if (!name) return Terminal;
  return toolIcons[name] ?? Terminal;
}

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

function ResultSection({
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
  const isLong = lines.length > 5 || output.length > 300;
  const StatusIcon = isError ? XCircle : CheckCircle2;

  return (
    <div
      className={cn(
        standalone && "rounded-md border overflow-hidden",
        standalone && (isError
          ? "border-semantic-error/20 bg-semantic-error/5"
          : "border-border-dim bg-semantic-tool-dim"),
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
        aria-label={`${expanded ? "Collapse" : "Expand"} tool result`}
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
          {result.toolName && standalone && ` from ${result.toolName}`}
        </span>
        {!expanded && !isLong && (
          <span className="truncate font-mono text-[11px] text-text-tertiary min-w-0">
            {lines[0]?.slice(0, 60)}
          </span>
        )}
        {isLong && !expanded && (
          <span className="font-mono text-[10px] tabular-nums text-text-tertiary">
            {lines.length} lines
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border-dim bg-surface-1 px-3 py-2 max-h-96 overflow-y-auto">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text-secondary break-words">
            {output}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified ToolCallBlock
// ---------------------------------------------------------------------------

export function ToolCallBlock({
  block,
  pairedResult,
}: {
  block: ToolUseContent | ToolResultContent;
  pairedResult?: ToolResultContent;
}) {
  const [callExpanded, setCallExpanded] = useState(false);

  // Standalone tool_result (no paired call) — render just the result
  if (block.type === "tool_result") {
    return <ResultSection result={block} standalone />;
  }

  // tool_use — unified box with optional result section
  const Icon = getToolIcon(block.toolName);
  const inputStr = formatInput(block.input);
  const preview = inputStr.split("\n")[0]?.slice(0, 80) ?? "";
  const hasResult = !!pairedResult;
  const isError = pairedResult?.isError;
  const toolDurationMs = pairedResult?.durationMs ?? block.durationMs;

  return (
    <div
      className={cn(
        "rounded-md border overflow-hidden",
        isError
          ? "border-semantic-error/20 bg-semantic-tool-dim"
          : "border-border-dim bg-semantic-tool-dim",
      )}
    >
      {/* Call section */}
      <button
        type="button"
        onClick={() => setCallExpanded(!callExpanded)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left",
          "transition-colors duration-100 touch-manipulation",
          "hover:bg-surface-3/30",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-bright",
        )}
        aria-expanded={callExpanded}
        aria-label={`${callExpanded ? "Collapse" : "Expand"} ${block.toolName} tool call`}
      >
        <ChevronRight
          size={11}
          className={cn(
            "flex-shrink-0 text-semantic-tool transition-transform duration-150",
            callExpanded && "rotate-90",
          )}
          aria-hidden="true"
        />
        <Icon size={12} className="flex-shrink-0 text-semantic-tool" aria-hidden="true" />
        <span className="font-mono text-[11px] font-medium text-semantic-tool">
          {block.toolName}
        </span>
        {toolDurationMs != null && (
          <span className="inline-flex items-center gap-0.5 font-mono text-[10px] tabular-nums text-text-tertiary">
            <Timer size={9} aria-hidden="true" />
            {formatDuration(toolDurationMs)}
          </span>
        )}
        {!callExpanded && preview && (
          <span className="truncate font-mono text-[11px] text-text-tertiary min-w-0">
            {preview}
          </span>
        )}
        {/* Status indicator on the right when collapsed */}
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
      {callExpanded && (
        <div className="border-t border-border-dim bg-surface-1 px-3 py-2">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text-secondary">
            {inputStr}
          </pre>
        </div>
      )}

      {/* Result section — inside the same box */}
      {hasResult && (
        <div className="border-t border-border-dim">
          <ResultSection result={pairedResult} />
        </div>
      )}
    </div>
  );
}

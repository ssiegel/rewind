"use client";

import { useState } from "react";
import { cn } from "../lib/cn";
import { formatDuration } from "../lib/format";
import { Brain, ChevronRight, Timer } from "lucide-react";

export function ThinkingBlock({ text, durationMs }: { text: string; durationMs?: number }) {
  const [expanded, setExpanded] = useState(false);

  if (!text) return null;

  return (
    <div className="rounded-md border border-semantic-thinking/15 bg-semantic-thinking-dim overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left",
          "transition-colors duration-100 touch-manipulation",
          "hover:bg-surface-3/20",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-bright",
        )}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} reasoning`}
      >
        <ChevronRight
          size={11}
          className={cn(
            "flex-shrink-0 text-semantic-thinking transition-transform duration-150",
            expanded && "rotate-90",
          )}
          aria-hidden="true"
        />
        <Brain size={12} className="flex-shrink-0 text-semantic-thinking" aria-hidden="true" />
        <span className="font-mono text-[11px] font-medium text-semantic-thinking">
          Reasoning
        </span>
        {durationMs != null && (
          <span className="inline-flex items-center gap-0.5 font-mono text-[10px] tabular-nums text-semantic-thinking/60">
            <Timer size={9} aria-hidden="true" />
            {formatDuration(durationMs)}
          </span>
        )}
        {!expanded && (
          <span className="truncate font-mono text-[11px] text-text-tertiary/60 min-w-0">
            {text.slice(0, 60)}{text.length > 60 ? "\u2026" : ""}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-semantic-thinking/10 bg-surface-1/50 px-3 py-2.5 max-h-96 overflow-y-auto">
          <p className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text-secondary/80 italic">
            {text}
          </p>
        </div>
      )}
    </div>
  );
}

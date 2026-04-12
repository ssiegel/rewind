"use client";

import type { SessionSummary } from "../../src/types";
import { relativeTime, formatTokens, formatDuration } from "../lib/format";
import { cn } from "../lib/cn";
import { Zap, Clock } from "lucide-react";

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

export function SessionList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (session: SessionSummary) => void;
}) {
  return (
    <div className="divide-y divide-border-dim" role="list">
      {sessions.map((session) => {
        const compositeId = session.id;
        const isSelected = compositeId === selectedId;

        return (
          <button
            key={compositeId}
            type="button"
            role="listitem"
            onClick={() => onSelect(session)}
            className={cn(
              "group flex w-full flex-col gap-1.5 px-4 py-3 text-left",
              "transition-colors duration-100 touch-manipulation",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-bright",
              isSelected
                ? "bg-surface-2"
                : "hover:bg-surface-1",
            )}
            style={
              isSelected
                ? { borderLeft: "2px solid var(--color-accent-opencode)" }
                : { borderLeft: "2px solid transparent" }
            }
          >
            {/* Title + time */}
            <div className="flex items-start justify-between gap-3">
              <p
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px] font-medium leading-snug",
                  "text-text-primary",
                )}
              >
                {session.title || "Untitled session"}
              </p>
              <time
                dateTime={session.updatedAt}
                className="flex-shrink-0 font-mono text-[10px] tabular-nums text-text-secondary"
              >
                {relativeTime(session.updatedAt)}
              </time>
            </div>

            {/* Project path */}
            {session.projectPath && (
              <div className="text-[10px] text-text-secondary">
                <span className="block truncate font-mono min-w-0" title={session.projectPath}>
                  {session.projectPath}
                </span>
              </div>
            )}

            {/* Model + stats */}
            <div className="flex items-center justify-between gap-3 text-[10px] text-text-secondary">
              <div className="min-w-0 flex-1">
                {session.primaryModel && (
                  <span
                    className="inline-flex max-w-full truncate rounded border border-border-default bg-surface-1 px-1.5 py-0.5 font-mono text-[9px] text-text-primary"
                    title={session.primaryModel}
                  >
                    {formatModelLabel(session.primaryModel)}
                  </span>
                )}
              </div>
              <span className="flex items-center gap-3 flex-shrink-0">
                {session.usage?.totalTokens != null && session.usage.totalTokens > 0 && (
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <Zap size={10} aria-hidden="true" />
                    {formatTokens(session.usage.totalTokens)}
                  </span>
                )}
                {session.totalDurationMs != null && (
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <Clock size={10} aria-hidden="true" />
                    {formatDuration(session.totalDurationMs)}
                  </span>
                )}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

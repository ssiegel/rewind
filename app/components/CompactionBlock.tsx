"use client";

import type { CompactionContent } from "../../src/types";
import { formatTokens } from "../lib/format";
import { Scissors } from "lucide-react";

export function CompactionBlock({ block }: { block: CompactionContent }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="h-px flex-1 bg-border-bright/30" />
      <div className="flex items-center gap-1.5 rounded-full border border-border-bright/30 bg-surface-2 px-2.5 py-0.5">
        <Scissors size={11} className="text-text-tertiary" aria-hidden="true" />
        <span className="font-mono text-[10px] text-text-tertiary">
          Context window compacted
          {block.auto ? " (auto)" : " (manual)"}
        </span>
        {block.preTokens != null && (
          <span className="font-mono text-[10px] tabular-nums text-text-tertiary/60">
            {formatTokens(block.preTokens)} tokens
          </span>
        )}
      </div>
      <div className="h-px flex-1 bg-border-bright/30" />
    </div>
  );
}

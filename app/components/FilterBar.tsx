"use client";

import { Search } from "lucide-react";
import { cn } from "../lib/cn";

export function FilterBar({
  searchQuery,
  onSearchChange,
  dateAfter,
  dateBefore,
  onDateAfterChange,
  onDateBeforeChange,
}: {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  dateAfter: string;
  dateBefore: string;
  onDateAfterChange: (value: string) => void;
  onDateBeforeChange: (value: string) => void;
}) {
  return (
    <div className="border-b border-border-dim px-3 py-2.5 space-y-2.5">
      {/* Search */}
      <div className="relative">
        <Search
          size={13}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
          aria-hidden="true"
        />
        <input
          type="text"
          placeholder="Search sessions…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className={cn(
            "w-full rounded-md border border-border-dim bg-surface-2 py-1.5 pl-8 pr-3",
            "font-mono text-xs text-text-primary placeholder:text-text-tertiary",
            "transition-colors duration-100",
            "focus-visible:border-border-bright focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-bright",
          )}
          aria-label="Search sessions"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">From</span>
          <input
            type="date"
            value={dateAfter}
            onChange={(e) => onDateAfterChange(e.target.value)}
            className={cn(
              "w-full rounded-md border border-border-dim bg-surface-2 px-2.5 py-1.5",
              "font-mono text-[11px] text-text-primary",
              "focus-visible:border-border-bright focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-bright",
            )}
          />
        </label>
        <label className="space-y-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">To</span>
          <input
            type="date"
            value={dateBefore}
            onChange={(e) => onDateBeforeChange(e.target.value)}
            className={cn(
              "w-full rounded-md border border-border-dim bg-surface-2 px-2.5 py-1.5",
              "font-mono text-[11px] text-text-primary",
              "focus-visible:border-border-bright focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-bright",
            )}
          />
        </label>
      </div>
    </div>
  );
}

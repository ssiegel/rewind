"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { SessionSummary, Session } from "../src/types";
import { SessionList } from "./components/SessionList";
import { SessionDetail } from "./components/SessionDetail";
import { FilterBar } from "./components/FilterBar";
import { DashboardPanel } from "./components/DashboardPanel";
import { Rewind as RewindIcon, ArrowLeft } from "lucide-react";
import { CopyButton } from "./components/CopyButton";
import { buildApiReferencePrompt } from "./lib/prompts";

function startOfDayIso(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T00:00:00`).toISOString();
}

function endOfDayIso(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T23:59:59.999`).toISOString();
}

export default function Home() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sessionStack, setSessionStack] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState("");

  // Load sessions
  useEffect(() => {
    async function load() {
      try {
        const params = new URLSearchParams({ limit: "500" });
        const after = startOfDayIso(dateAfter);
        const before = endOfDayIso(dateBefore);
        if (after) params.set("after", after);
        if (before) params.set("before", before);
        const res = await fetch(`/api/sessions?${params.toString()}`);
        const data: SessionSummary[] = await res.json();
        setSessions(data);
      } catch {
        // silently fail
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [dateAfter, dateBefore]);

  // Restore selected session from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("session");
    if (id) {
      setSelectedId(id);
      loadSession(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSession = useCallback(async (id: string) => {
    setDetailLoading(true);
    setSelectedId(id);
    setSelectedSession(null);

    // Update URL
    const url = new URL(window.location.href);
    url.searchParams.set("session", id);
    window.history.replaceState({}, "", url.toString());

    try {
      const res = await fetch(`/api/session/${encodeURIComponent(id)}`);
      if (res.ok) {
        const data: Session = await res.json();
        setSelectedSession(data);
      }
    } catch {
      // silently fail
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleSelect = useCallback(
    (session: SessionSummary) => {
      setSessionStack([]); // clear subagent stack on new session pick
      loadSession(session.id);
    },
    [loadSession],
  );

  const handleNavigateSubagent = useCallback(
    (subagentSessionId: string) => {
      if (!selectedSession) return;
      setSessionStack((prev) => [...prev, selectedSession.id]);
      loadSession(subagentSessionId);
    },
    [selectedSession, loadSession],
  );

  const handleNavigateBack = useCallback(() => {
    const prev = sessionStack[sessionStack.length - 1];
    if (!prev) return;
    setSessionStack((s) => s.slice(0, -1));
    loadSession(prev);
  }, [sessionStack, loadSession]);

  // Filter sessions
  const filtered = sessions.filter((s) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const title = (s.title ?? "").toLowerCase();
      const project = (s.projectPath ?? "").toLowerCase();
      return title.includes(q) || project.includes(q);
    }
    return true;
  });

  const handleShowDashboard = useCallback(() => {
    setSelectedId(null);
    setSelectedSession(null);
    setSessionStack([]);
    setDetailLoading(false);
  }, []);

  return (
    <div className="flex h-dvh w-screen overflow-hidden">
      {/* Left panel: session list */}
      <div className="flex w-80 min-w-72 flex-shrink-0 flex-col border-r border-border-dim bg-surface-0">
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-border-dim px-4 py-3">
          <Link
            href="/"
            onClick={handleShowDashboard}
            className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-bright"
          >
            <div className="flex size-7 items-center justify-center rounded bg-accent-opencode-dim">
              <RewindIcon
                size={14}
                className="text-accent-opencode"
              />
            </div>
            <h1 className="text-sm font-semibold tracking-tight text-text-primary">
              Rewind
            </h1>
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <CopyButton
              getText={buildApiReferencePrompt}
              label="Copy API Prompt"
              size="sm"
            />
          </div>
        </div>

        {/* Filters */}
        <FilterBar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          dateAfter={dateAfter}
          dateBefore={dateBefore}
          onDateAfterChange={setDateAfter}
          onDateBeforeChange={setDateBefore}
        />

        {/* Session list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="size-4 animate-spin rounded-full border-2 border-border-bright border-t-accent-opencode" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-16 text-center text-sm text-text-tertiary">
              No OpenCode sessions found
            </div>
          ) : (
            <SessionList
              sessions={filtered}
              selectedId={selectedId}
              onSelect={handleSelect}
            />
          )}
        </div>
      </div>

      {/* Right panel: session detail */}
      <div className="flex flex-1 flex-col overflow-hidden bg-surface-1">
        {/* Back button when viewing subagent session */}
        {sessionStack.length > 0 && !detailLoading && selectedSession && (
          <button
            type="button"
            onClick={handleNavigateBack}
            className="flex items-center gap-2 border-b border-border-dim bg-surface-2/50 px-4 py-2 text-left transition-colors duration-100 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-bright"
          >
            <ArrowLeft size={13} className="text-text-tertiary" />
            <span className="font-mono text-xs text-text-secondary">
              Back to parent
            </span>
            {selectedSession.parentSessionId && (
              <span className="rounded bg-accent-opencode/10 px-1.5 py-0.5 font-mono text-[10px] text-accent-opencode">
                subagent
              </span>
            )}
          </button>
        )}
        {detailLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="size-4 animate-spin rounded-full border-2 border-border-bright border-t-accent-opencode" />
          </div>
        ) : selectedSession ? (
          <SessionDetail
            session={selectedSession}
            onNavigateSubagent={handleNavigateSubagent}
          />
        ) : (
            <DashboardPanel
              after={startOfDayIso(dateAfter)}
              before={endOfDayIso(dateBefore)}
            />
          )}
        </div>
      </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { formatNumber, formatTokens, formatDuration, formatCost } from "../lib/format";
import {
  Activity,
  MessageSquare,
  Zap,
  Clock,
  FolderOpen,
  ArrowDownToLine,
  ArrowUpFromLine,
  TrendingUp,
  Calendar,
  BarChart3,
  Timer,
  Wrench,
  Workflow,
  Scissors,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardData {
  totals: {
    sessions: number;
    messages: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    durationMs: number;
    cost: number;
  };
  activity: {
    toolCalls: number;
    subagents: number;
    compactions: number;
  };
  byModel: Record<string, { sessions: number; messages: number; tokens: number; durationMs: number; cost: number }>;
  byTool: Record<string, number>;
  topProjects: Array<{
    path: string;
    shortName: string;
    sessions: number;
    messages: number;
    tokens: number;
    durationMs: number;
    cost: number;
    lastActive: string;
  }>;
  byDay: Record<string, { sessions: number; messages: number; tokens: number; durationMs: number; cost: number }>;
  byHour: number[];
  dateRange: { first: string | null; last: string | null };
}

function formatCompactDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Activity Heatmap
// ---------------------------------------------------------------------------

function ActivityHeatmap({ byDay }: { byDay: Record<string, { sessions: number; tokens: number }> }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 363);
  startDate.setDate(startDate.getDate() - startDate.getDay());

  const days: Array<{ date: string; count: number; tokens: number }> = [];
  const cursor = new Date(startDate);
  while (cursor <= today) {
    const key = cursor.toISOString().slice(0, 10);
    const data = byDay[key];
    days.push({ date: key, count: data?.sessions ?? 0, tokens: data?.tokens ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const weeks: typeof days[] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }

  const maxCount = Math.max(1, ...days.map((d) => d.count));

  function getLevel(count: number): number {
    if (count === 0) return 0;
    const ratio = count / maxCount;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  }

  const levelColors = [
    "bg-surface-2",
    "bg-accent-opencode/20",
    "bg-accent-opencode/40",
    "bg-accent-opencode/60",
    "bg-accent-opencode/80",
  ];

  const monthLabels: Array<{ label: string; weekIndex: number }> = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks.length; w++) {
    const firstDay = weeks[w][0];
    if (firstDay) {
      const month = new Date(firstDay.date).getMonth();
      if (month !== lastMonth) {
        monthLabels.push({
          label: new Intl.DateTimeFormat("en-US", { month: "short" }).format(new Date(firstDay.date)),
          weekIndex: w,
        });
        lastMonth = month;
      }
    }
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex mb-1" style={{ paddingLeft: 28 }}>
        {monthLabels.map((m, i) => (
          <span
            key={i}
            className="font-mono text-[9px] text-text-tertiary"
            style={{
              position: "relative",
              left: m.weekIndex * 13,
              ...(i > 0 ? { marginLeft: -(monthLabels[i - 1].weekIndex * 13 + monthLabels[i - 1].label.length * 5.5) } : {}),
            }}
          >
            {m.label}
          </span>
        ))}
      </div>
      <div className="flex gap-0.5">
        <div className="flex flex-col gap-0.5 mr-1 justify-start">
          {["", "Mon", "", "Wed", "", "Fri", ""].map((label, i) => (
            <div key={i} className="h-[11px] flex items-center">
              <span className="font-mono text-[8px] text-text-tertiary w-5 text-right">{label}</span>
            </div>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-0.5">
            {week.map((day, di) => (
              <div
                key={di}
                className={cn(
                  "h-[11px] w-[11px] rounded-[2px] transition-colors duration-100",
                  levelColors[getLevel(day.count)],
                )}
                title={`${day.date}: ${day.count} session${day.count !== 1 ? "s" : ""}${day.tokens > 0 ? `, ${formatTokens(day.tokens)} tokens` : ""}`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5 mt-2 justify-end">
        <span className="font-mono text-[9px] text-text-tertiary">Less</span>
        {levelColors.map((c, i) => (
          <div key={i} className={cn("h-[11px] w-[11px] rounded-[2px]", c)} />
        ))}
        <span className="font-mono text-[9px] text-text-tertiary">More</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token Timeline (SVG)
// ---------------------------------------------------------------------------

function TokenTimeline({ byDay }: { byDay: Record<string, { tokens: number; sessions: number }> }) {
  const sortedDays = Object.entries(byDay)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, data]) => ({ date, ...data }));

  if (sortedDays.length === 0) return null;

  const width = 800;
  const height = 120;
  const padX = 0;
  const padY = 10;
  const chartW = width - padX * 2;
  const chartH = height - padY * 2;

  const maxTokens = Math.max(1, ...sortedDays.map((d) => d.tokens));
  const n = sortedDays.length;

  const points = sortedDays.map((d, i) => ({
    x: padX + (n > 1 ? (i / (n - 1)) * chartW : chartW / 2),
    y: padY + chartH - (d.tokens / maxTokens) * chartH,
    ...d,
  }));

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

  const areaD = pathD + ` L ${points[points.length - 1].x.toFixed(1)} ${height} L ${points[0].x.toFixed(1)} ${height} Z`;

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" preserveAspectRatio="none">
        <defs>
          <linearGradient id="tokenGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent-opencode)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="var(--color-accent-opencode)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#tokenGrad)" />
        <path d={pathD} fill="none" stroke="var(--color-accent-opencode)" strokeWidth="1.5" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={3}
            fill="var(--color-accent-opencode)"
            opacity={0}
            className="hover:opacity-100 transition-opacity"
          >
            <title>{`${p.date}: ${formatTokens(p.tokens)} tokens, ${p.sessions} sessions`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex justify-between mt-1 px-0.5">
        <span className="font-mono text-[9px] text-text-tertiary">{formatCompactDate(sortedDays[0].date)}</span>
        {sortedDays.length > 2 && (
          <span className="font-mono text-[9px] text-text-tertiary">
            {formatCompactDate(sortedDays[Math.floor(sortedDays.length / 2)].date)}
          </span>
        )}
        <span className="font-mono text-[9px] text-text-tertiary">{formatCompactDate(sortedDays[sortedDays.length - 1].date)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hourly Distribution
// ---------------------------------------------------------------------------

function HourlyDistribution({ byHour }: { byHour: number[] }) {
  const max = Math.max(1, ...byHour);
  return (
    <div className="space-y-2">
      <div className="flex items-end gap-[3px] h-20">
        {byHour.map((count, hour) => {
          const pct = (count / max) * 100;
          return (
            <div key={hour} className="flex-1 h-full flex items-end">
              <div
                className="w-full rounded-t-[2px] bg-accent-opencode/60 hover:bg-accent-opencode/80 transition-colors duration-100"
                style={{ height: `${Math.max(count > 0 ? 8 : 2, pct)}%` }}
                title={`${hour.toString().padStart(2, "0")}:00 — ${count} sessions`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between px-0.5 font-mono text-[9px] text-text-tertiary">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic Breakdown List
// ---------------------------------------------------------------------------

function BreakdownList({
  entries,
  formatRight,
}: {
  entries: Array<{ label: string; value: number; sub?: string }>;
  formatRight: (entry: { label: string; value: number; sub?: string }) => string;
}) {
  if (entries.length === 0) return null;
  const maxValue = Math.max(1, ...entries.map((entry) => entry.value));

  return (
    <div className="space-y-1">
      {entries.map((entry) => (
        <div
          key={entry.label}
          className="group relative flex items-center gap-3 rounded-md px-3 py-1.5 hover:bg-surface-2 transition-colors duration-100"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-md bg-accent-opencode/[0.08] transition-all duration-300"
            style={{ width: `${(entry.value / maxValue) * 100}%` }}
          />
          <span className="relative z-10 flex-1 truncate font-mono text-[11px] font-medium text-text-primary min-w-0">
            {entry.label}
          </span>
          <span className="relative z-10 font-mono text-[10px] tabular-nums text-text-secondary font-semibold text-right">
            {formatRight(entry)}
          </span>
          {entry.sub && (
            <span className="relative z-10 font-mono text-[10px] tabular-nums text-text-tertiary">
              {entry.sub}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function ProjectTable({ projects }: { projects: DashboardData["topProjects"] }) {
  if (projects.length === 0) return null;
  const maxTokens = Math.max(1, ...projects.map((p) => p.tokens));

  return (
    <div className="space-y-1">
      {projects.map((p) => (
        <div
          key={p.path}
          className="group relative flex items-center gap-3 rounded-md px-3 py-1.5 hover:bg-surface-2 transition-colors duration-100"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-md bg-accent-opencode/[0.04] transition-all duration-300"
            style={{ width: `${(p.tokens / maxTokens) * 100}%` }}
          />
          <FolderOpen size={11} className="relative z-10 flex-shrink-0 text-text-tertiary" />
          <span className="relative z-10 flex-1 truncate font-mono text-[11px] font-medium text-text-primary min-w-0">
            {p.shortName}
          </span>
          <span className="relative z-10 font-mono text-[10px] tabular-nums text-text-tertiary">
            {p.sessions} sessions
          </span>
          <span className="relative z-10 font-mono text-[10px] tabular-nums text-text-secondary font-semibold w-16 text-right">
            {formatTokens(p.tokens)}
          </span>
          {p.durationMs > 0 && (
            <span className="relative z-10 font-mono text-[10px] tabular-nums text-text-tertiary w-14 text-right">
              {formatDuration(p.durationMs)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat Card
// ---------------------------------------------------------------------------

function BigStat({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ComponentType<{ size: number; className?: string; style?: React.CSSProperties }>;
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border-dim bg-surface-0 px-4 py-3">
      <div className="flex items-center gap-2">
        <div
          className="flex size-6 items-center justify-center rounded-md"
          style={{ backgroundColor: accent ? `color-mix(in srgb, ${accent} 10%, transparent)` : "var(--color-surface-3)" }}
        >
          <Icon size={12} style={accent ? { color: accent } : undefined} className={accent ? "" : "text-text-tertiary"} />
        </div>
        <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-text-tertiary">{label}</span>
      </div>
      <p className="font-mono text-xl font-bold tabular-nums tracking-tight text-text-primary">{value}</p>
      {sub && (
        <p className="font-mono text-[10px] tabular-nums text-text-tertiary leading-tight">{sub}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Panel — used as right panel when no session is selected
// ---------------------------------------------------------------------------

export function DashboardPanel({ after, before }: { after?: string; before?: string }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (after) params.set("after", after);
      if (before) params.set("before", before);
      const res = await fetch(`/api/dashboard?${params.toString()}`);
      const json: DashboardData = await res.json();
      setData(json);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [after, before]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const totals = data?.totals;
  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-surface-1">
      {/* Panel header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-dim bg-surface-1/90 backdrop-blur-sm px-6 py-3">
        <div className="flex items-center gap-2">
          <BarChart3 size={13} className="text-text-tertiary" />
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
            Dashboard
          </h2>
        </div>
        {(after || before) && (
          <span className="font-mono text-[10px] text-text-tertiary">Filtered by date</span>
        )}
      </div>

      {/* Content */}
      <div className="px-6 py-5">
        {loading && !data ? (
          <div className="flex items-center justify-center py-32">
            <div className="size-5 animate-spin rounded-full border-2 border-border-bright border-t-accent-opencode" />
          </div>
        ) : data ? (
          <div className="space-y-5">
            {/* Date range context */}
            {data.dateRange.first && (
              <div className="flex items-center gap-2">
                <Calendar size={11} className="text-text-tertiary" />
                <span className="font-mono text-[10px] text-text-tertiary">
                  {formatCompactDate(data.dateRange.first)} — {formatCompactDate(data.dateRange.last!)}
                </span>
              </div>
            )}

            {/* Top-level stats */}
            <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
              <BigStat
                icon={Activity}
                label="Sessions"
                value={formatNumber(totals!.sessions)}
                accent="var(--color-accent-opencode)"
              />
              <BigStat
                icon={MessageSquare}
                label="Messages"
                value={formatNumber(totals!.messages)}
                sub={totals!.sessions > 0 ? `~${Math.round(totals!.messages / totals!.sessions)} per session` : undefined}
              />
              <BigStat
                icon={Zap}
                label="Total Tokens"
                value={formatTokens(totals!.totalTokens)}
                sub={`${formatTokens(totals!.inputTokens)} in / ${formatTokens(totals!.outputTokens)} out`}
                accent="var(--color-semantic-tool)"
              />
              <BigStat
                icon={Timer}
                label="Model Time"
                value={totals!.durationMs > 0 ? formatDuration(totals!.durationMs) : "n/a"}
                sub={totals!.sessions > 0 && totals!.durationMs > 0
                  ? `~${formatDuration(totals!.durationMs / totals!.sessions)} per session`
                  : undefined}
                accent="var(--color-accent-opencode)"
              />
              <BigStat
                icon={Wrench}
                label="Tool Calls"
                value={formatNumber(data.activity.toolCalls)}
                sub={data.activity.toolCalls > 0 && totals!.sessions > 0 ? `~${Math.round(data.activity.toolCalls / totals!.sessions)} per session` : undefined}
              />
              <BigStat
                icon={Workflow}
                label="Subagents"
                value={formatNumber(data.activity.subagents)}
                sub={data.activity.subagents > 0 && totals!.sessions > 0 ? `~${(data.activity.subagents / totals!.sessions).toFixed(1)} per session` : undefined}
                accent="var(--color-accent-opencode)"
              />
              <BigStat
                icon={Scissors}
                label="Compactions"
                value={formatNumber(data.activity.compactions)}
                sub={data.activity.compactions > 0 && totals!.sessions > 0 ? `~${(data.activity.compactions / totals!.sessions).toFixed(1)} per session` : undefined}
              />
              <BigStat
                icon={TrendingUp}
                label="Cost"
                value={totals!.cost > 0 ? formatCost(totals!.cost) : "n/a"}
                sub={totals!.cost > 0 && totals!.sessions > 0
                  ? `~${formatCost(totals!.cost / totals!.sessions)} per session`
                  : undefined}
              />
            </div>

            {/* Activity heatmap */}
            <div className="rounded-lg border border-border-dim bg-surface-0 p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                  Activity
                </h2>
                <span className="font-mono text-[10px] tabular-nums text-text-tertiary">
                  {Object.values(data.byDay).reduce((a, d) => a + d.sessions, 0)} sessions across {Object.keys(data.byDay).length} days
                </span>
              </div>
              <ActivityHeatmap byDay={data.byDay} />
            </div>

            {/* Model mix + hourly */}
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-border-dim bg-surface-0 p-4">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-secondary mb-3">
                  Models
                </h2>
                <BreakdownList
                  entries={Object.entries(data.byModel)
                    .sort((a, b) => b[1].tokens - a[1].tokens)
                    .slice(0, 10)
                    .map(([label, value]) => ({
                      label,
                      value: value.tokens,
                      sub: `${value.sessions} sessions`,
                    }))}
                  formatRight={(entry) => formatTokens(entry.value)}
                />
              </div>
              <div className="rounded-lg border border-border-dim bg-surface-0 p-4">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-secondary mb-3">
                  Time of Day
                </h2>
                <HourlyDistribution byHour={data.byHour} />
                <div className="flex justify-between mt-1">
                  <span className="font-mono text-[8px] text-text-tertiary">12am</span>
                  <span className="font-mono text-[8px] text-text-tertiary">6am</span>
                  <span className="font-mono text-[8px] text-text-tertiary">12pm</span>
                  <span className="font-mono text-[8px] text-text-tertiary">6pm</span>
                  <span className="font-mono text-[8px] text-text-tertiary">12am</span>
                </div>
              </div>
            </div>

            {/* Token timeline */}
            <div className="rounded-lg border border-border-dim bg-surface-0 p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                  Token Usage Over Time
                </h2>
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-text-tertiary">
                    <ArrowDownToLine size={10} />
                    Input {formatTokens(totals!.inputTokens)}
                  </span>
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-text-tertiary">
                    <ArrowUpFromLine size={10} />
                    Output {formatTokens(totals!.outputTokens)}
                  </span>
                </div>
              </div>
              <TokenTimeline byDay={data.byDay} />
            </div>

            {Object.keys(data.byTool).length > 0 && (
              <div className="rounded-lg border border-border-dim bg-surface-0 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                    Tool Mix
                  </h2>
                  <span className="font-mono text-[10px] text-text-tertiary">across filtered sessions</span>
                </div>
                <BreakdownList
                  entries={Object.entries(data.byTool)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 12)
                    .map(([label, value]) => ({ label, value }))}
                  formatRight={(entry) => formatNumber(entry.value)}
                />
              </div>
            )}

            {/* Projects */}
            {data.topProjects.length > 0 && (
              <div className="rounded-lg border border-border-dim bg-surface-0 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                    Top Projects
                  </h2>
                  <span className="font-mono text-[10px] text-text-tertiary">by token usage</span>
                </div>
                <ProjectTable projects={data.topProjects} />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-32 gap-3">
            <BarChart3 size={32} className="text-text-tertiary" />
            <p className="font-mono text-sm text-text-tertiary">No OpenCode sessions in this range</p>
          </div>
        )}
      </div>
    </div>
  );
}

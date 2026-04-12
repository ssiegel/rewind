import { NextResponse, type NextRequest } from "next/server";
import { getRewind } from "../../lib/rewind-server";

/**
 * GET /api/dashboard
 *
 * Returns pre-aggregated dashboard data from OpenCode session summaries.
 * Query params:
 *   after  - ISO date string (inclusive)
 *   before - ISO date string (inclusive)
 */
export async function GET(request: NextRequest) {
  const rw = getRewind();
  const { searchParams } = request.nextUrl;
  const after = searchParams.get("after");
  const before = searchParams.get("before");

  const options: { after?: string; before?: string } = {};
  if (after) options.after = after;
  if (before) options.before = before;

  // Get all OpenCode sessions in the requested date range, including subagents.
  let sessions = await rw.listSessions({ ...options, includeSubagents: true });

  // --- Aggregate ---

  let totalSessions = 0;
  let totalMessages = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalTokens = 0;
  let totalDurationMs = 0;
  let totalCost = 0;

  const byModel: Record<string, { sessions: number; messages: number; tokens: number; durationMs: number; cost: number }> = {};
  const byTool: Record<string, number> = {};
  const byProject: Record<string, { sessions: number; messages: number; tokens: number; durationMs: number; cost: number; lastActive: string }> = {};
  const byDay: Record<string, { sessions: number; messages: number; tokens: number; durationMs: number; cost: number }> = {};
  const byHour: number[] = new Array(24).fill(0);
  let totalToolCalls = 0;
  let totalSubagents = 0;
  let totalCompactions = 0;

  for (const s of sessions) {
    totalSessions++;
    totalMessages += s.messageCount ?? 0;

    // Usage
    if (s.usage) {
      totalInputTokens += s.usage.inputTokens ?? 0;
      totalOutputTokens += s.usage.outputTokens ?? 0;
      totalCacheRead += s.usage.cacheReadTokens ?? 0;
      totalCacheCreation += s.usage.cacheCreationTokens ?? 0;
      totalTokens += s.usage.totalTokens ?? 0;
    }

    // Duration
    if (s.totalDurationMs) {
      totalDurationMs += s.totalDurationMs;
    }

    // Cost
    if (s.cost) {
      totalCost += s.cost;
    }

    const model = s.primaryModel ?? s.models?.[0] ?? "unknown";
    if (!byModel[model]) {
      byModel[model] = { sessions: 0, messages: 0, tokens: 0, durationMs: 0, cost: 0 };
    }
    byModel[model].sessions++;
    byModel[model].messages += s.messageCount ?? 0;
    byModel[model].tokens += s.usage?.totalTokens ?? 0;
    byModel[model].durationMs += s.totalDurationMs ?? 0;
    byModel[model].cost += s.cost ?? 0;

    totalToolCalls += s.toolCallCount ?? 0;
    totalSubagents += s.subagentCount ?? 0;
    totalCompactions += s.compactionCount ?? 0;
    for (const tool of s.topTools ?? []) {
      byTool[tool.name] = (byTool[tool.name] ?? 0) + tool.count;
    }

    // By project
    const project = s.projectPath ?? "(no project)";
    if (!byProject[project]) {
      byProject[project] = { sessions: 0, messages: 0, tokens: 0, durationMs: 0, cost: 0, lastActive: "" };
    }
    byProject[project].sessions++;
    byProject[project].messages += s.messageCount ?? 0;
    byProject[project].tokens += s.usage?.totalTokens ?? 0;
    byProject[project].durationMs += s.totalDurationMs ?? 0;
    byProject[project].cost += s.cost ?? 0;
    if (s.updatedAt > byProject[project].lastActive) {
      byProject[project].lastActive = s.updatedAt;
    }

    // By day (use last activity date)
    const day = s.updatedAt?.slice(0, 10);
    if (day) {
      if (!byDay[day]) {
        byDay[day] = { sessions: 0, messages: 0, tokens: 0, durationMs: 0, cost: 0 };
      }
      byDay[day].sessions++;
      byDay[day].messages += s.messageCount ?? 0;
      byDay[day].tokens += s.usage?.totalTokens ?? 0;
      byDay[day].durationMs += s.totalDurationMs ?? 0;
      byDay[day].cost += s.cost ?? 0;
    }

    // By hour (use local time of last activity)
    try {
      const hour = new Date(s.updatedAt || s.createdAt).getHours();
      byHour[hour]++;
    } catch {
      // ignore
    }
  }

  // Sort projects by tokens desc, take top 15
  const topProjects = Object.entries(byProject)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 15)
    .map(([path, data]) => ({
      path,
      shortName: path === "(no project)" ? "(no project)" : path.split("/").slice(-2).join("/"),
      ...data,
    }));

  // Wall clock range
  const firstSession = sessions.length > 0
    ? sessions.reduce((a, b) => (a.createdAt < b.createdAt ? a : b)).createdAt
    : null;
  const lastSession = sessions.length > 0
    ? sessions.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b)).updatedAt
    : null;

  return NextResponse.json({
    totals: {
      sessions: totalSessions,
      messages: totalMessages,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation,
      totalTokens,
      durationMs: totalDurationMs,
      cost: totalCost,
    },
    activity: {
      toolCalls: totalToolCalls,
      subagents: totalSubagents,
      compactions: totalCompactions,
    },
    byModel,
    byTool,
    topProjects,
    byDay,
    byHour,
    dateRange: { first: firstSession, last: lastSession },
  });
}

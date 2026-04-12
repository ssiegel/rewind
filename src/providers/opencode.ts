import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ListSessionsOptions,
  Message,
  MessageContent,
  MessageError,
  OpenCodeConfig,
  OpenCodeSessionDiff,
  OpenCodeTodo,
  PermissionRule,
  Session,
  SessionSummary,
  TokenUsage,
} from "../types";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Raw types – what OpenCode stores
// ---------------------------------------------------------------------------

export interface OpenCodeRawSession {
  id: string;
  slug?: string;
  version?: string;
  projectID: string;
  directory?: string;
  parentID?: string;
  title?: string;
  time: { created: number; updated: number };
  summary?: { additions: number; deletions: number; files: number };
  permission?: Array<{ type: string; glob?: string; description?: string }>;
}

export interface OpenCodeRawMessage {
  id: string;
  sessionID: string;
  role: string;
  time: { created: number; completed?: number };
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  agent?: string;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    total?: number;
    cache?: { read: number; write: number };
  };
  finish?: string;
  model?: { providerID: string; modelID: string };
  summary?: { title?: string; diffs?: unknown[] };
  path?: { cwd?: string; root?: string };
  tools?: Record<string, unknown>;
  /** API error, present when the model call failed (e.g. context overflow). */
  error?: {
    name: string;
    data?: {
      message?: string;
      statusCode?: number;
      isRetryable?: boolean;
    };
  };
  /** Parts loaded from disk/db and attached during reading */
  _parts?: OpenCodePart[];
}

export type OpenCodePart =
  | OpenCodeTextPart
  | OpenCodeReasoningPart
  | OpenCodeToolPart
  | OpenCodeCompactionPart
  | OpenCodePatchPart
  | OpenCodeStepStartPart
  | OpenCodeStepFinishPart;

export interface OpenCodeTextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  time?: { start: number; end: number };
}

export interface OpenCodeReasoningPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text: string;
  time?: { start: number; end: number };
}

export interface OpenCodeToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: {
    status: string;
    input: unknown;
    output?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: { start: number; end: number };
  };
}

export interface OpenCodeCompactionPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "compaction";
  /** Whether compaction was triggered automatically. */
  auto: boolean;
}

export interface OpenCodePatchPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "patch";
  hash: string;
  files: string[];
}

export interface OpenCodeStepStartPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-start";
  snapshot?: string;
}

export interface OpenCodeStepFinishPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-finish";
  reason?: string;
  snapshot?: string;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache?: { read: number; write: number };
  };
}

export interface OpenCodeProject {
  id: string;
  worktree: string;
  vcs?: string;
  time?: { created: number; updated: number };
  sandboxes?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultDataDir(): string {
  const dataHome = process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share");
  return join(dataHome, "opencode");
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Safely read and parse a JSON file. Returns null on any error. */
async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(/* turbopackIgnore: true */ path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Content conversion
// ---------------------------------------------------------------------------

/** Compute duration from a start/end pair, returning undefined if not available. */
function partDurationMs(time?: { start: number; end: number }): number | undefined {
  if (!time || time.end <= time.start) return undefined;
  return time.end - time.start;
}

function partsToContent(parts: OpenCodePart[]): MessageContent[] {
  const content: MessageContent[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text) {
          content.push({ type: "text", text: part.text });
        }
        break;
      case "reasoning": {
        const dur = partDurationMs(part.time);
        content.push({
          type: "thinking",
          text: part.text,
          ...(dur != null ? { durationMs: dur } : {}),
        });
        break;
      }
      case "tool": {
        // Tool parts represent both the call and result in one.
        // We emit a tool_use and (if output exists) a tool_result.
        // Task tools carry the subagent session ID in metadata.
        const subagentSessionId =
          part.tool === "task"
            ? (part.state.metadata?.sessionId as string | undefined)
            : undefined;

        const toolDur = partDurationMs(part.state.time);
        content.push({
          type: "tool_use",
          toolName: part.tool,
          toolCallId: part.callID,
          input: part.state.input,
          ...(subagentSessionId ? { subagentSessionId } : {}),
          ...(toolDur != null ? { durationMs: toolDur } : {}),
          ...(part.state.title ? { title: part.state.title } : {}),
        });
        if (part.state.output !== undefined) {
          content.push({
            type: "tool_result",
            toolCallId: part.callID,
            toolName: part.tool,
            output: part.state.output ?? "",
            isError: part.state.status === "error",
            status: part.state.status,
            ...(toolDur != null ? { durationMs: toolDur } : {}),
          });
        }
        break;
      }
      case "compaction":
        content.push({
          type: "compaction",
          auto: part.auto,
        });
        break;
      case "patch":
        content.push({
          type: "patch",
          hash: part.hash,
          files: part.files,
        });
        break;
      // step-start, step-finish – internal bookkeeping, skip
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  return content;
}

function messageTokenUsage(raw: OpenCodeRawMessage): TokenUsage | undefined {
  if (!raw.tokens) return undefined;
  const t = raw.tokens;
  const cacheRead = t.cache?.read ?? 0;
  const cacheWrite = t.cache?.write ?? 0;
  // inputTokens = total prompt tokens (non-cached + cache read + cache write)
  const inputTokens = t.input + cacheRead + cacheWrite;
  const outputTokens = t.output;
  const reasoningTokens = t.reasoning || 0;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: reasoningTokens || undefined,
    cacheReadTokens: cacheRead || undefined,
    cacheCreationTokens: cacheWrite || undefined,
    totalTokens: inputTokens + outputTokens + reasoningTokens,
  };
}

// ---------------------------------------------------------------------------
// Shared message conversion
// ---------------------------------------------------------------------------

function resolveModel(raw: OpenCodeRawMessage): string | undefined {
  if (raw.modelID) return raw.modelID;
  if (raw.model?.modelID) return raw.model.modelID;
  return undefined;
}

function rawErrorToMessageError(raw: OpenCodeRawMessage): MessageError | undefined {
  if (!raw.error) return undefined;
  return {
    name: raw.error.name,
    message: raw.error.data?.message,
    statusCode: raw.error.data?.statusCode,
    isRetryable: raw.error.data?.isRetryable,
  };
}

function getPartTime(part: OpenCodePart): number | null {
  if (part.type === "text" || part.type === "reasoning") {
    return part.time?.start ?? null;
  }
  if (part.type === "tool") {
    return part.state.time?.start ?? null;
  }
  // compaction, step-start, step-finish have no sortable time
  return null;
}

function sortParts(parts: OpenCodePart[]): void {
  parts.sort((a, b) => {
    const aTime = getPartTime(a);
    const bTime = getPartTime(b);
    if (aTime && bTime) return aTime - bTime;
    return a.id.localeCompare(b.id);
  });
}

async function rawToMessage(
  raw: OpenCodeRawMessage,
  loadPartsFn: (messageId: string) => Promise<OpenCodePart[]>,
  isCompactSummary?: boolean,
): Promise<Message<OpenCodeRawMessage>> {
  const parts = raw._parts ?? await loadPartsFn(raw.id);

  // Compute timing from time.completed (available on assistant messages)
  const completedAt = raw.time.completed ? msToIso(raw.time.completed) : undefined;
  const durationMs =
    raw.time.completed && raw.time.created
      ? raw.time.completed - raw.time.created
      : undefined;

  const msg: Message<OpenCodeRawMessage> = {
    id: raw.id,
    role: raw.role as Message["role"],
    content: partsToContent(parts),
    timestamp: msToIso(raw.time.created),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs != null && durationMs > 0 ? { durationMs } : {}),
    model: resolveModel(raw),
    usage: messageTokenUsage(raw),
    parentId: raw.parentID,
    ...(isCompactSummary ? { isCompactSummary: true } : {}),
    error: rawErrorToMessageError(raw),
    raw: { ...raw, _parts: parts },
  };

  if (raw.finish) msg.stopReason = raw.finish;
  if (raw.mode) msg.mode = raw.mode;
  if (raw.cost != null) msg.cost = raw.cost;
  if (raw.providerID) msg.apiProvider = raw.providerID;
  if (raw.path?.cwd) msg.cwd = raw.path.cwd;
  if (raw.summary) msg.summary = raw.summary;

  return msg;
}

/**
 * Convert a sorted array of raw messages, detecting compaction boundaries.
 * When a user message contains a compaction part, the next assistant message
 * is marked as a compact summary.
 */
async function convertMessages(
  rawMessages: OpenCodeRawMessage[],
  loadPartsFn: (messageId: string) => Promise<OpenCodePart[]>,
): Promise<Message<OpenCodeRawMessage>[]> {
  const messages: Message<OpenCodeRawMessage>[] = [];
  let nextIsSummary = false;

  for (const raw of rawMessages) {
    const parts = raw._parts ?? [];
    const hasCompaction = parts.some((p) => p.type === "compaction");

    if (hasCompaction) {
      messages.push(await rawToMessage(raw, loadPartsFn));
      nextIsSummary = true;
    } else if (nextIsSummary && raw.role === "assistant") {
      messages.push(await rawToMessage(raw, loadPartsFn, true));
      nextIsSummary = false;
    } else {
      messages.push(await rawToMessage(raw, loadPartsFn));
      nextIsSummary = false;
    }
  }

  return messages;
}

function rawSessionToSummary(
  raw: OpenCodeRawSession,
  projectWorktrees: Map<string, string>,
  messageCount?: number,
  aggregatedUsage?: TokenUsage,
  aggregatedCost?: number,
  extras?: {
    primaryModel?: string;
    models?: string[];
    toolCallCount?: number;
    subagentCount?: number;
    compactionCount?: number;
    topTools?: Array<{ name: string; count: number }>;
  },
): SessionSummary {
  const worktree = projectWorktrees.get(raw.projectID);
  return {
    id: raw.id,
    provider: "opencode",
    title: raw.title ?? raw.slug,
    slug: raw.slug,
    createdAt: msToIso(raw.time.created),
    updatedAt: msToIso(raw.time.updated),
    messageCount,
    projectPath: raw.directory ?? worktree,
    usage: aggregatedUsage,
    cost: aggregatedCost,
    parentSessionId: raw.parentID,
    cliVersion: raw.version,
    primaryModel: extras?.primaryModel,
    models: extras?.models,
    toolCallCount: extras?.toolCallCount,
    subagentCount: extras?.subagentCount,
    compactionCount: extras?.compactionCount,
    topTools: extras?.topTools,
    codeChanges: raw.summary
      ? { additions: raw.summary.additions, deletions: raw.summary.deletions, files: raw.summary.files }
      : undefined,
    permissions: raw.permission?.length
      ? raw.permission.map((p): PermissionRule => ({ type: p.type, glob: p.glob, description: p.description }))
      : undefined,
  };
}

/** Aggregate token usage and cost from raw messages. */
function aggregateUsage(rawMessages: OpenCodeRawMessage[]): {
  usage: TokenUsage | undefined;
  cost: number | undefined;
  totalDurationMs: number | undefined;
} {
  let tInput = 0;
  let tOutput = 0;
  let tReasoning = 0;
  let tCacheRead = 0;
  let tCacheWrite = 0;
  let tCost = 0;
  let pInput = 0;
  let hasTokens = false;
  let tDuration = 0;
  let hasDuration = false;

  for (const msg of rawMessages) {
    if (msg.tokens) {
      hasTokens = true;
      const cr = msg.tokens.cache?.read || 0;
      const cw = msg.tokens.cache?.write || 0;
      const turnIn = (msg.tokens.input || 0) + cr + cw;
      tInput += turnIn;
      tOutput += msg.tokens.output || 0;
      tReasoning += msg.tokens.reasoning || 0;
      tCacheRead += cr;
      tCacheWrite += cw;
      if (turnIn > pInput) pInput = turnIn;
    }
    if (msg.cost) tCost += msg.cost;
    if (msg.time.completed && msg.time.created) {
      const dur = msg.time.completed - msg.time.created;
      if (dur > 0) {
        tDuration += dur;
        hasDuration = true;
      }
    }
  }

  return {
    usage: hasTokens
      ? {
          inputTokens: tInput,
          outputTokens: tOutput,
          reasoningTokens: tReasoning || undefined,
          cacheReadTokens: tCacheRead || undefined,
          cacheCreationTokens: tCacheWrite || undefined,
          totalTokens: tInput + tOutput + tReasoning,
          peakInputTokens: pInput || undefined,
        }
      : undefined,
    cost: tCost > 0 ? tCost : undefined,
    totalDurationMs: hasDuration ? tDuration : undefined,
  };
}

function aggregateSummaryExtras(rawMessages: OpenCodeRawMessage[]): {
  primaryModel?: string;
  models?: string[];
  toolCallCount?: number;
  subagentCount?: number;
  compactionCount?: number;
  topTools?: Array<{ name: string; count: number }>;
} {
  const modelCounts = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  let toolCallCount = 0;
  let subagentCount = 0;
  let compactionCount = 0;

  for (const raw of rawMessages) {
    const model = resolveModel(raw);
    if (model) {
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
    }

    for (const part of raw._parts ?? []) {
      if (part.type === "tool") {
        toolCounts.set(part.tool, (toolCounts.get(part.tool) ?? 0) + 1);
        const isSubagent = part.tool === "task" && Boolean(part.state.metadata?.sessionId);
        if (isSubagent) subagentCount++;
        else toolCallCount++;
      }
      if (part.type === "compaction") compactionCount++;
    }
  }

  const models = Array.from(modelCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([model]) => model);
  const topTools = Array.from(toolCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  return {
    primaryModel: models[0],
    ...(models.length > 0 ? { models } : {}),
    ...(toolCallCount > 0 ? { toolCallCount } : {}),
    ...(subagentCount > 0 ? { subagentCount } : {}),
    ...(compactionCount > 0 ? { compactionCount } : {}),
    ...(topTools.length > 0 ? { topTools } : {}),
  };
}

// ---------------------------------------------------------------------------
// SQLite backend
// ---------------------------------------------------------------------------

interface SqliteBackend {
  loadProjectWorktrees(): Map<string, string>;
  loadAllSessions(): OpenCodeRawSession[];
  loadRawMessages(sessionId: string): OpenCodeRawMessage[];
  loadParts(messageId: string): OpenCodePart[];
  loadPartsBySession(sessionId: string): Map<string, OpenCodePart[]>;
  loadTodos(sessionId: string): OpenCodeTodo[];
  close(): void;
}

function createSqliteBackend(dbPath: string): SqliteBackend {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });

  // Prepare statements for reuse
  const stmtProjects = db.prepare("SELECT id, worktree FROM project");

  const stmtSessions = db.prepare(`
    SELECT id, project_id, parent_id, slug, directory, title, version,
           summary_additions, summary_deletions, summary_files,
           permission, time_created, time_updated
    FROM session
    WHERE time_archived IS NULL
    ORDER BY time_updated DESC
  `);

  const stmtMessages = db.prepare(`
    SELECT id, session_id, time_created, time_updated, data
    FROM message
    WHERE session_id = ?
    ORDER BY time_created ASC
  `);

  const stmtParts = db.prepare(`
    SELECT id, message_id, session_id, time_created, time_updated, data
    FROM part
    WHERE message_id = ?
    ORDER BY time_created ASC
  `);

  const stmtPartsBySession = db.prepare(`
    SELECT id, message_id, session_id, time_created, time_updated, data
    FROM part
    WHERE session_id = ?
    ORDER BY time_created ASC
  `);

  const stmtTodos = db.prepare(`
    SELECT session_id, content, status, priority, position, time_created, time_updated
    FROM todo
    WHERE session_id = ?
    ORDER BY position ASC
  `);

  function rowToSession(row: Record<string, unknown>): OpenCodeRawSession {
    const session: OpenCodeRawSession = {
      id: row.id as string,
      projectID: row.project_id as string,
      slug: (row.slug as string) || undefined,
      directory: (row.directory as string) || undefined,
      parentID: (row.parent_id as string) || undefined,
      title: (row.title as string) || undefined,
      version: (row.version as string) || undefined,
      time: {
        created: row.time_created as number,
        updated: row.time_updated as number,
      },
    };

    // Reconstruct summary if data exists
    if (row.summary_additions != null || row.summary_deletions != null || row.summary_files != null) {
      session.summary = {
        additions: (row.summary_additions as number) ?? 0,
        deletions: (row.summary_deletions as number) ?? 0,
        files: (row.summary_files as number) ?? 0,
      };
    }

    // Parse permission JSON if present
    if (row.permission) {
      try {
        session.permission = JSON.parse(row.permission as string);
      } catch {
        // ignore malformed permission
      }
    }

    return session;
  }

  function rowToRawMessage(row: Record<string, unknown>): OpenCodeRawMessage {
    const id = row.id as string;
    const sessionID = row.session_id as string;
    const data = JSON.parse(row.data as string) as Record<string, unknown>;

    // Reconstruct OpenCodeRawMessage from the row + embedded data.
    const msg: OpenCodeRawMessage = {
      id,
      sessionID,
      role: data.role as string,
      time: data.time as { created: number; completed?: number },
      parentID: data.parentID as string | undefined,
      modelID: data.modelID as string | undefined,
      providerID: data.providerID as string | undefined,
      mode: data.mode as string | undefined,
      agent: data.agent as string | undefined,
      cost: data.cost as number | undefined,
      tokens: data.tokens as OpenCodeRawMessage["tokens"],
      finish: data.finish as string | undefined,
      model: data.model as { providerID: string; modelID: string } | undefined,
      summary: data.summary as { title?: string; diffs?: unknown[] } | undefined,
      path: data.path as { cwd?: string; root?: string } | undefined,
      tools: data.tools as Record<string, unknown> | undefined,
      error: data.error as OpenCodeRawMessage["error"],
    };

    return msg;
  }

  function rowToPart(row: Record<string, unknown>): OpenCodePart {
    const id = row.id as string;
    const messageID = row.message_id as string;
    const sessionID = row.session_id as string;
    const data = JSON.parse(row.data as string) as Record<string, unknown>;

    // Re-attach row metadata stripped from the JSON payload.
    return { ...data, id, messageID, sessionID } as unknown as OpenCodePart;
  }

  return {
    loadProjectWorktrees(): Map<string, string> {
      const map = new Map<string, string>();
      const rows = stmtProjects.all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        map.set(row.id as string, row.worktree as string);
      }
      return map;
    },

    loadAllSessions(): OpenCodeRawSession[] {
      const rows = stmtSessions.all() as Array<Record<string, unknown>>;
      return rows.map(rowToSession);
    },

    loadRawMessages(sessionId: string): OpenCodeRawMessage[] {
      const rows = stmtMessages.all(sessionId) as Array<Record<string, unknown>>;
      return rows.map(rowToRawMessage);
    },

    loadParts(messageId: string): OpenCodePart[] {
      const rows = stmtParts.all(messageId) as Array<Record<string, unknown>>;
      const parts = rows.map(rowToPart);
      sortParts(parts);
      return parts;
    },

    loadPartsBySession(sessionId: string): Map<string, OpenCodePart[]> {
      const rows = stmtPartsBySession.all(sessionId) as Array<Record<string, unknown>>;
      const map = new Map<string, OpenCodePart[]>();
      for (const row of rows) {
        const part = rowToPart(row);
        const msgId = row.message_id as string;
        let arr = map.get(msgId);
        if (!arr) {
          arr = [];
          map.set(msgId, arr);
        }
        arr.push(part);
      }
      // Sort parts within each message
      for (const parts of map.values()) {
        sortParts(parts);
      }
      return map;
    },

    loadTodos(sessionId: string): OpenCodeTodo[] {
      const rows = stmtTodos.all(sessionId) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: `todo-${row.session_id}-${row.position}`,
        sessionID: row.session_id as string,
        content: row.content as string,
        status: row.status as string | undefined,
        priority: row.priority as string | undefined,
        time: {
          created: row.time_created as number,
          updated: row.time_updated as number,
        },
      }));
    },

    close() {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export interface OpenCodeProvider {
  id: "opencode";
  name: string;
  basePath: string;
  listSessions(options?: ListSessionsOptions): Promise<SessionSummary[]>;
  getSession(sessionId: string): Promise<Session<OpenCodeRawMessage> | null>;
  getMessages(sessionId: string): Promise<Message<OpenCodeRawMessage>[]>;
  close(): void;
}

export function createOpenCodeProvider(
  config: OpenCodeConfig = {},
): OpenCodeProvider {
  // Resolve the base data directory and SQLite database path.
  //
  // Path resolution strategy:
  //   1. No config → use default data dir (~/.local/share/opencode)
  //   2. Config basePath provided:
  //      a. If <basePath>/opencode.db exists → basePath is the data dir
  //      b. If <basePath>/storage/ exists → basePath is the data dir
  //      c. Otherwise → treat basePath as the storage dir and use ../opencode.db

  let dataDir: string;
  let storageDir: string;
  let dbPath: string;

  if (config?.basePath) {
    const bp = config.basePath;
    if (existsSync(join(/* turbopackIgnore: true */ bp, "opencode.db"))) {
      dataDir = bp;
      storageDir = join(/* turbopackIgnore: true */ bp, "storage");
      dbPath = join(/* turbopackIgnore: true */ bp, "opencode.db");
    } else if (existsSync(join(/* turbopackIgnore: true */ bp, "storage"))) {
      dataDir = bp;
      storageDir = join(/* turbopackIgnore: true */ bp, "storage");
      dbPath = join(/* turbopackIgnore: true */ bp, "opencode.db");
    } else {
      dataDir = join(/* turbopackIgnore: true */ bp, "..");
      storageDir = bp;
      dbPath = join(/* turbopackIgnore: true */ dataDir, "opencode.db");
    }
  } else {
    dataDir = defaultDataDir();
    storageDir = join(/* turbopackIgnore: true */ dataDir, "storage");
    dbPath = join(/* turbopackIgnore: true */ dataDir, "opencode.db");
  }

  const hasSqlite = existsSync(/* turbopackIgnore: true */ dbPath);
  const sessionDiffDir = join(/* turbopackIgnore: true */ storageDir, "session_diff");

  // Lazily initialized SQLite backend
  let _sqlite: SqliteBackend | null = null;
  function getSqlite(): SqliteBackend {
    if (!_sqlite) {
      _sqlite = createSqliteBackend(dbPath);
    }
    return _sqlite;
  }

  // ---- Session diff helper ----

  async function loadSessionDiffsFromStorage(sessionId: string): Promise<OpenCodeSessionDiff[]> {
    const filePath = join(sessionDiffDir, `${sessionId}.json`);
    const data = await readJson<Array<OpenCodeSessionDiff & { path?: string }>>(filePath);
    if (!data || !Array.isArray(data)) return [];
    return data
      .map(({ path: _path, ...diff }) => ({ ...diff, file: diff.file ?? _path }))
      .filter((diff): diff is OpenCodeSessionDiff => Boolean(diff.file));
  }

  // ---- SQLite-backed data access ----

  async function loadProjectWorktrees(): Promise<Map<string, string>> {
    return hasSqlite ? getSqlite().loadProjectWorktrees() : new Map<string, string>();
  }

  async function loadAllSessions(): Promise<OpenCodeRawSession[]> {
    return hasSqlite ? getSqlite().loadAllSessions() : [];
  }

  async function loadRawMessages(sessionId: string): Promise<OpenCodeRawMessage[]> {
    return hasSqlite ? getSqlite().loadRawMessages(sessionId) : [];
  }

  async function loadParts(messageId: string): Promise<OpenCodePart[]> {
    return hasSqlite ? getSqlite().loadParts(messageId) : [];
  }

  async function loadAndAttachParts(rawMessages: OpenCodeRawMessage[], sessionId: string): Promise<void> {
    if (!hasSqlite) return;
    const partsByMessage = getSqlite().loadPartsBySession(sessionId);
    for (const msg of rawMessages) {
      msg._parts = partsByMessage.get(msg.id) ?? [];
    }
  }

  async function loadSessionDiffs(sessionId: string): Promise<OpenCodeSessionDiff[]> {
    return loadSessionDiffsFromStorage(sessionId);
  }

  async function loadSessionTodos(sessionId: string): Promise<OpenCodeTodo[]> {
    return hasSqlite ? getSqlite().loadTodos(sessionId) : [];
  }

  // ---- Provider API ----

  const reportedBasePath = dataDir;

  return {
    id: "opencode",
    name: "OpenCode",
    basePath: reportedBasePath,

    async listSessions(
      options?: ListSessionsOptions,
    ): Promise<SessionSummary[]> {
      const projectWorktrees = await loadProjectWorktrees();
      let sessions = await loadAllSessions();

      // Filter subagent sessions (excluded by default)
      if (!options?.includeSubagents) {
        sessions = sessions.filter((s) => !s.parentID);
      }

      // Apply filters
      if (options?.projectPath) {
        const pp = options.projectPath;
        sessions = sessions.filter((s) => {
          if (s.directory === pp) return true;
          // Also check project worktree
          const worktree = projectWorktrees.get(s.projectID);
          return worktree === pp;
        });
      }
      if (options?.after) {
        const afterMs = new Date(options.after).getTime();
        sessions = sessions.filter((s) => s.time.updated >= afterMs);
      }
      if (options?.before) {
        const beforeMs = new Date(options.before).getTime();
        sessions = sessions.filter((s) => s.time.updated <= beforeMs);
      }

      // Sort by updated DESC
      sessions.sort((a, b) => b.time.updated - a.time.updated);

      // Apply limit
      if (options?.limit && options.limit > 0) {
        sessions = sessions.slice(0, options.limit);
      }

      const results: SessionSummary[] = [];
      for (const raw of sessions) {
        const rawMessages = await loadRawMessages(raw.id);
        await loadAndAttachParts(rawMessages, raw.id);
        const { usage, cost, totalDurationMs } = aggregateUsage(rawMessages);
        const extras = aggregateSummaryExtras(rawMessages);

        const summary = rawSessionToSummary(raw, projectWorktrees, rawMessages.length, usage, cost, extras);
        if (totalDurationMs != null) summary.totalDurationMs = totalDurationMs;
        results.push(summary);
      }
      return results;
    },

    async getSession(
      sessionId: string,
    ): Promise<Session<OpenCodeRawMessage> | null> {
      const projectWorktrees = await loadProjectWorktrees();
      const allSessions = await loadAllSessions();
      const rawSession = allSessions.find((s) => s.id === sessionId);

      if (!rawSession) return null;

      const rawMessages = await loadRawMessages(sessionId);
      await loadAndAttachParts(rawMessages, sessionId);

      const messages = await convertMessages(rawMessages, loadParts);

      const { usage, cost } = aggregateUsage(rawMessages);

      const summary = rawSessionToSummary(
        rawSession,
        projectWorktrees,
        messages.length,
        usage,
        cost,
      );

      // Compute totalDurationMs from per-message timing
      let totalDuration = 0;
      let hasTiming = false;
      for (const m of messages) {
        if (m.durationMs != null) {
          totalDuration += m.durationMs;
          hasTiming = true;
        }
      }

      // Load session diffs and todos
      const diffs = await loadSessionDiffs(sessionId);
      const todos = await loadSessionTodos(sessionId);

      return {
        ...summary,
        ...(hasTiming ? { totalDurationMs: totalDuration } : {}),
        messages,
        ...(diffs.length > 0 ? { diffs } : {}),
        ...(todos.length > 0 ? { todos } : {}),
      };
    },

    async getMessages(sessionId: string): Promise<Message<OpenCodeRawMessage>[]> {
      const rawMessages = await loadRawMessages(sessionId);
      await loadAndAttachParts(rawMessages, sessionId);
      return await convertMessages(rawMessages, loadParts);
    },

    close() {
      if (_sqlite) {
        _sqlite.close();
        _sqlite = null;
      }
    },
  };
}

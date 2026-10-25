import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
} from "../types.js";

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
  /** V2 only: session this one was forked from. */
  forkSessionID?: string;
  /** V2 only: agent the session last ran with. */
  agent?: string;
  /** V2 only: model the session last ran with. */
  model?: { id?: string; providerID?: string; variant?: string };
}

export interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning: number;
  total?: number;
  cache?: { read: number; write: number };
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
  tokens?: OpenCodeTokens;
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
// Raw types – OpenCode V2 (`session_v2` / `session_message`)
// ---------------------------------------------------------------------------

/**
 * V2 message kind, taken from the `session_message.type` column. It replaces
 * V1's `role` and adds kinds that V1 modelled as parts or not at all.
 */
export type OpenCodeV2MessageType =
  | "user"
  | "assistant"
  | "system"
  | "synthetic"
  | "compaction"
  | "idle";

export interface OpenCodeV2TextContent {
  type: "text";
  text: string;
}

export interface OpenCodeV2ReasoningContent {
  type: "reasoning";
  text: string;
  time?: { created: number; completed?: number };
}

/** Body of a tool result. Text blocks carry output, file blocks carry attachments. */
export type OpenCodeV2ToolResultBlock =
  | { type: "text"; text: string }
  | { type: "file"; uri?: string; mime?: string };

export interface OpenCodeV2ToolContent {
  type: "tool";
  /** Provider tool-call id, V1's `callID`. */
  id: string;
  name: string;
  executed?: boolean;
  state: {
    status: string;
    input?: unknown;
    /** Result body, replacing V1's flat `state.output` string. */
    content?: OpenCodeV2ToolResultBlock[] | null;
    metadata?: Record<string, unknown>;
    error?: { type?: string; message?: string };
  };
  time?: { created: number; completed?: number; ran?: number };
}

export type OpenCodeV2Content =
  | OpenCodeV2TextContent
  | OpenCodeV2ReasoningContent
  | OpenCodeV2ToolContent;

export interface OpenCodeV2Message {
  id: string;
  sessionID: string;
  /** Message kind from the `type` column. */
  type: OpenCodeV2MessageType;
  /** Canonical ordering within the session. */
  seq: number;
  time: { created: number; completed?: number; streamed?: number };
  /** Set on user, system and synthetic messages. */
  text?: string;
  /** Set on assistant messages. */
  content?: OpenCodeV2Content[];
  agent?: string;
  model?: { id?: string; providerID?: string; variant?: string };
  cost?: number;
  tokens?: OpenCodeTokens;
  finish?: string;
  rawFinish?: unknown;
  snapshot?: { start?: string; end?: string; files?: unknown };
  files?: unknown[];
  agents?: unknown[];
  /** Set on compaction messages. */
  status?: string;
  reason?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  /** Set on idle messages. */
  outcome?: string;
  /** V2 errors are flat, unlike V1's nested `error.data`. */
  error?: { type?: string; message?: string; statusCode?: number; isRetryable?: boolean };
}

/** Raw payload attached to a normalized message, from either schema. */
export type OpenCodeMessageRaw = OpenCodeRawMessage | OpenCodeV2Message;

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

function parseJsonColumn<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
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

/** Compute duration from a V2 created/completed pair. */
function spanDurationMs(time?: { created?: number; completed?: number }): number | undefined {
  if (!time?.created || !time.completed || time.completed <= time.created) return undefined;
  return time.completed - time.created;
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

/** Flatten a V2 tool result body into the normalized flat output string. */
function v2ToolOutput(blocks: OpenCodeV2ToolResultBlock[]): string {
  const chunks: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      chunks.push(block.text);
    } else if (block.type === "file") {
      chunks.push(`[file${block.mime ? `: ${block.mime}` : ""}]`);
    }
  }
  return chunks.join("\n");
}

function v2ContentToContent(blocks: OpenCodeV2Content[]): MessageContent[] {
  const content: MessageContent[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text) {
          content.push({ type: "text", text: block.text });
        }
        break;
      case "reasoning": {
        const dur = spanDurationMs(block.time);
        content.push({
          type: "thinking",
          text: block.text,
          ...(dur != null ? { durationMs: dur } : {}),
        });
        break;
      }
      case "tool": {
        const state = block.state ?? { status: "unknown" };
        // Any tool that spawns a child session records it here, which covers
        // both the V1 `task` name and the V2 `subagent` rename.
        const subagentSessionId = state.metadata?.["sessionId"] as string | undefined;
        const toolDur = spanDurationMs(block.time);

        content.push({
          type: "tool_use",
          toolName: block.name,
          toolCallId: block.id,
          input: state.input,
          ...(subagentSessionId ? { subagentSessionId } : {}),
          ...(toolDur != null ? { durationMs: toolDur } : {}),
        });

        const hasBody = Array.isArray(state.content) && state.content.length > 0;
        if (hasBody || state.error) {
          const output = hasBody
            ? v2ToolOutput(state.content as OpenCodeV2ToolResultBlock[])
            : (state.error?.message ?? "");
          content.push({
            type: "tool_result",
            toolCallId: block.id,
            toolName: block.name,
            output,
            isError: state.status === "error",
            status: state.status,
            ...(toolDur != null ? { durationMs: toolDur } : {}),
          });
        }
        break;
      }
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  return content;
}

function tokensToUsage(tokens?: OpenCodeTokens): TokenUsage | undefined {
  if (!tokens) return undefined;
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  // inputTokens = total prompt tokens (non-cached + cache read + cache write)
  const inputTokens = tokens.input + cacheRead + cacheWrite;
  const outputTokens = tokens.output;
  const reasoningTokens = tokens.reasoning || 0;
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

function v2ErrorToMessageError(raw: OpenCodeV2Message): MessageError | undefined {
  if (!raw.error) return undefined;
  return {
    name: raw.error.type ?? "Error",
    message: raw.error.message,
    statusCode: raw.error.statusCode,
    isRetryable: raw.error.isRetryable,
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

function rawToMessage(
  raw: OpenCodeRawMessage,
  isCompactSummary?: boolean,
): Message<OpenCodeMessageRaw> {
  const parts = raw._parts ?? [];

  // Compute timing from time.completed (available on assistant messages)
  const completedAt = raw.time.completed ? msToIso(raw.time.completed) : undefined;
  const durationMs =
    raw.time.completed && raw.time.created
      ? raw.time.completed - raw.time.created
      : undefined;

  const msg: Message<OpenCodeMessageRaw> = {
    id: raw.id,
    role: raw.role as Message["role"],
    content: partsToContent(parts),
    timestamp: msToIso(raw.time.created),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs != null && durationMs > 0 ? { durationMs } : {}),
    model: resolveModel(raw),
    usage: tokensToUsage(raw.tokens),
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
function convertMessages(rawMessages: OpenCodeRawMessage[]): Message<OpenCodeMessageRaw>[] {
  const messages: Message<OpenCodeMessageRaw>[] = [];
  let nextIsSummary = false;

  for (const raw of rawMessages) {
    const parts = raw._parts ?? [];
    const hasCompaction = parts.some((p) => p.type === "compaction");

    if (hasCompaction) {
      messages.push(rawToMessage(raw));
      nextIsSummary = true;
    } else if (nextIsSummary && raw.role === "assistant") {
      messages.push(rawToMessage(raw, true));
      nextIsSummary = false;
    } else {
      messages.push(rawToMessage(raw));
      nextIsSummary = false;
    }
  }

  return messages;
}

/**
 * Map a V2 message kind onto a normalized role. `synthetic` messages are
 * OpenCode-injected narration rather than human input, so they are surfaced as
 * system messages. `idle` messages are bookkeeping and are dropped by the caller.
 */
function v2TypeToRole(type: OpenCodeV2MessageType): Message["role"] {
  switch (type) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    default:
      return "system";
  }
}

function v2ToMessage(raw: OpenCodeV2Message): Message<OpenCodeMessageRaw> {
  let content: MessageContent[];
  if (raw.type === "compaction") {
    // V2 stores the summary on the compaction message itself, where V1 put it
    // on the following assistant message.
    content = [{ type: "compaction", auto: raw.reason === "auto" }];
    if (raw.summary) content.push({ type: "text", text: raw.summary });
  } else if (raw.content) {
    content = v2ContentToContent(raw.content);
  } else {
    content = [{ type: "text", text: raw.text ?? "" }];
  }

  const completedAt = raw.time.completed ? msToIso(raw.time.completed) : undefined;
  const durationMs = spanDurationMs(raw.time);

  const msg: Message<OpenCodeMessageRaw> = {
    id: raw.id,
    role: v2TypeToRole(raw.type),
    content,
    timestamp: msToIso(raw.time.created),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    model: raw.model?.id,
    usage: tokensToUsage(raw.tokens),
    ...(raw.type === "compaction" && raw.summary ? { isCompactSummary: true } : {}),
    error: v2ErrorToMessageError(raw),
    raw,
  };

  if (raw.finish) msg.stopReason = raw.finish;
  if (raw.agent) msg.mode = raw.agent;
  if (raw.cost != null) msg.cost = raw.cost;
  if (raw.model?.providerID) msg.apiProvider = raw.model.providerID;

  return msg;
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
    primaryModel: extras?.primaryModel ?? raw.model?.id,
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

/**
 * Aggregate usage, cost, timing and content statistics from normalized
 * messages, so both storage schemas share one implementation.
 */
function aggregateMessages(messages: Message<OpenCodeMessageRaw>[]): {
  usage: TokenUsage | undefined;
  cost: number | undefined;
  totalDurationMs: number | undefined;
  extras: {
    primaryModel?: string;
    models?: string[];
    toolCallCount?: number;
    subagentCount?: number;
    compactionCount?: number;
    topTools?: Array<{ name: string; count: number }>;
  };
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

  const modelCounts = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  let toolCallCount = 0;
  let subagentCount = 0;
  let compactionCount = 0;

  for (const msg of messages) {
    if (msg.usage) {
      hasTokens = true;
      const turnIn = msg.usage.inputTokens ?? 0;
      tInput += turnIn;
      tOutput += msg.usage.outputTokens ?? 0;
      tReasoning += msg.usage.reasoningTokens ?? 0;
      tCacheRead += msg.usage.cacheReadTokens ?? 0;
      tCacheWrite += msg.usage.cacheCreationTokens ?? 0;
      if (turnIn > pInput) pInput = turnIn;
    }
    if (msg.cost) tCost += msg.cost;
    if (msg.durationMs != null && msg.durationMs > 0) {
      tDuration += msg.durationMs;
      hasDuration = true;
    }
    if (msg.model) {
      modelCounts.set(msg.model, (modelCounts.get(msg.model) ?? 0) + 1);
    }

    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolCounts.set(block.toolName, (toolCounts.get(block.toolName) ?? 0) + 1);
        if (block.subagentSessionId) subagentCount++;
        else toolCallCount++;
      }
      if (block.type === "compaction") compactionCount++;
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
    extras: {
      primaryModel: models[0],
      ...(models.length > 0 ? { models } : {}),
      ...(toolCallCount > 0 ? { toolCallCount } : {}),
      ...(subagentCount > 0 ? { subagentCount } : {}),
      ...(compactionCount > 0 ? { compactionCount } : {}),
      ...(topTools.length > 0 ? { topTools } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite backends
// ---------------------------------------------------------------------------

interface SqliteBackend {
  loadProjectWorktrees(): Map<string, string>;
  loadAllSessions(): OpenCodeRawSession[];
  loadMessages(sessionId: string): Message<OpenCodeMessageRaw>[];
  loadTodos(sessionId: string): OpenCodeTodo[];
  close(): void;
}

function rowToTodo(row: Record<string, unknown>): OpenCodeTodo {
  return {
    id: `todo-${row.session_id}-${row.position}`,
    sessionID: row.session_id as string,
    content: row.content as string,
    status: row.status as string | undefined,
    priority: row.priority as string | undefined,
    time: {
      created: row.time_created as number,
      updated: row.time_updated as number,
    },
  };
}

function rowToProjectWorktrees(rows: Array<Record<string, unknown>>): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.id as string, row.worktree as string);
  }
  return map;
}

/** Shared session column decoding; both schemas use the same column names. */
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

  if (row.summary_additions != null || row.summary_deletions != null || row.summary_files != null) {
    session.summary = {
      additions: (row.summary_additions as number) ?? 0,
      deletions: (row.summary_deletions as number) ?? 0,
      files: (row.summary_files as number) ?? 0,
    };
  }

  const permission = parseJsonColumn<OpenCodeRawSession["permission"]>(row.permission);
  if (permission) session.permission = permission;

  if (row.fork_session_id) session.forkSessionID = row.fork_session_id as string;
  if (row.agent) session.agent = row.agent as string;
  const model = parseJsonColumn<OpenCodeRawSession["model"]>(row.model);
  if (model) session.model = model;

  return session;
}

/** Backend for the V1 layout: `session` plus separate `message` and `part` tables. */
function createLegacyBackend(db: DatabaseSync): SqliteBackend {
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

  function rowToRawMessage(row: Record<string, unknown>): OpenCodeRawMessage {
    const data = JSON.parse(row.data as string) as Record<string, unknown>;

    // Reconstruct OpenCodeRawMessage from the row + embedded data.
    return {
      id: row.id as string,
      sessionID: row.session_id as string,
      role: data.role as string,
      time: data.time as { created: number; completed?: number },
      parentID: data.parentID as string | undefined,
      modelID: data.modelID as string | undefined,
      providerID: data.providerID as string | undefined,
      mode: data.mode as string | undefined,
      agent: data.agent as string | undefined,
      cost: data.cost as number | undefined,
      tokens: data.tokens as OpenCodeTokens | undefined,
      finish: data.finish as string | undefined,
      model: data.model as { providerID: string; modelID: string } | undefined,
      summary: data.summary as { title?: string; diffs?: unknown[] } | undefined,
      path: data.path as { cwd?: string; root?: string } | undefined,
      tools: data.tools as Record<string, unknown> | undefined,
      error: data.error as OpenCodeRawMessage["error"],
    };
  }

  function rowToPart(row: Record<string, unknown>): OpenCodePart {
    const data = JSON.parse(row.data as string) as Record<string, unknown>;
    // Re-attach row metadata stripped from the JSON payload.
    return {
      ...data,
      id: row.id as string,
      messageID: row.message_id as string,
      sessionID: row.session_id as string,
    } as unknown as OpenCodePart;
  }

  return {
    loadProjectWorktrees() {
      return rowToProjectWorktrees(stmtProjects.all() as Array<Record<string, unknown>>);
    },

    loadAllSessions() {
      return (stmtSessions.all() as Array<Record<string, unknown>>).map(rowToSession);
    },

    loadMessages(sessionId) {
      const rawMessages = (stmtMessages.all(sessionId) as Array<Record<string, unknown>>).map(
        rowToRawMessage,
      );

      const partsByMessage = new Map<string, OpenCodePart[]>();
      for (const row of stmtPartsBySession.all(sessionId) as Array<Record<string, unknown>>) {
        const msgId = row.message_id as string;
        let arr = partsByMessage.get(msgId);
        if (!arr) {
          arr = [];
          partsByMessage.set(msgId, arr);
        }
        arr.push(rowToPart(row));
      }
      for (const parts of partsByMessage.values()) {
        sortParts(parts);
      }
      for (const msg of rawMessages) {
        msg._parts = partsByMessage.get(msg.id) ?? [];
      }

      return convertMessages(rawMessages);
    },

    loadTodos(sessionId) {
      return (stmtTodos.all(sessionId) as Array<Record<string, unknown>>).map(rowToTodo);
    },

    close() {
      db.close();
    },
  };
}

/**
 * Backend for the V2 layout: `session_v2` plus `session_message`, which inlines
 * what V1 stored as separate `part` rows.
 */
function createV2Backend(db: DatabaseSync): SqliteBackend {
  const stmtProjects = db.prepare("SELECT id, worktree FROM project");

  const stmtSessions = db.prepare(`
    SELECT id, project_id, parent_id, fork_session_id, slug, directory, title, version,
           summary_additions, summary_deletions, summary_files,
           permission, agent, model, time_created, time_updated
    FROM session_v2
    WHERE time_archived IS NULL
    ORDER BY time_updated DESC
  `);

  const stmtMessages = db.prepare(`
    SELECT id, session_id, type, seq, time_created, time_updated, data
    FROM session_message
    WHERE session_id = ?
    ORDER BY seq ASC
  `);

  const stmtTodos = db.prepare(`
    SELECT session_id, content, status, priority, position, time_created, time_updated
    FROM todo
    WHERE session_id = ?
    ORDER BY position ASC
  `);

  function rowToV2Message(row: Record<string, unknown>): OpenCodeV2Message {
    const data = JSON.parse(row.data as string) as Record<string, unknown>;
    const time = (data.time as OpenCodeV2Message["time"]) ?? {
      created: row.time_created as number,
    };

    return {
      ...data,
      id: row.id as string,
      sessionID: row.session_id as string,
      type: row.type as OpenCodeV2MessageType,
      seq: row.seq as number,
      time,
    } as OpenCodeV2Message;
  }

  return {
    loadProjectWorktrees() {
      return rowToProjectWorktrees(stmtProjects.all() as Array<Record<string, unknown>>);
    },

    loadAllSessions() {
      return (stmtSessions.all() as Array<Record<string, unknown>>).map(rowToSession);
    },

    loadMessages(sessionId) {
      const messages: Message<OpenCodeMessageRaw>[] = [];
      for (const row of stmtMessages.all(sessionId) as Array<Record<string, unknown>>) {
        const raw = rowToV2Message(row);
        // Idle markers are lifecycle bookkeeping with no conversation content.
        if (raw.type === "idle") continue;
        messages.push(v2ToMessage(raw));
      }
      return messages;
    },

    loadTodos(sessionId) {
      return (stmtTodos.all(sessionId) as Array<Record<string, unknown>>).map(rowToTodo);
    },

    close() {
      db.close();
    },
  };
}

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row != null;
}

function createSqliteBackend(dbPath: string): SqliteBackend {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // OpenCode V2 migrates sessions into `session_v2`/`session_message` and
  // backfills existing ones, so prefer it whenever present.
  const isV2 = hasTable(db, "session_v2") && hasTable(db, "session_message");
  return isV2 ? createV2Backend(db) : createLegacyBackend(db);
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export interface OpenCodeProvider {
  id: "opencode";
  name: string;
  basePath: string;
  listSessions(options?: ListSessionsOptions): Promise<SessionSummary[]>;
  getSession(sessionId: string): Promise<Session<OpenCodeMessageRaw> | null>;
  getMessages(sessionId: string): Promise<Message<OpenCodeMessageRaw>[]>;
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

  async function loadMessages(sessionId: string): Promise<Message<OpenCodeMessageRaw>[]> {
    return hasSqlite ? getSqlite().loadMessages(sessionId) : [];
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
        const messages = await loadMessages(raw.id);
        const { usage, cost, totalDurationMs, extras } = aggregateMessages(messages);

        const summary = rawSessionToSummary(raw, projectWorktrees, messages.length, usage, cost, extras);
        if (totalDurationMs != null) summary.totalDurationMs = totalDurationMs;
        results.push(summary);
      }
      return results;
    },

    async getSession(
      sessionId: string,
    ): Promise<Session<OpenCodeMessageRaw> | null> {
      const projectWorktrees = await loadProjectWorktrees();
      const allSessions = await loadAllSessions();
      const rawSession = allSessions.find((s) => s.id === sessionId);

      if (!rawSession) return null;

      const messages = await loadMessages(sessionId);
      const { usage, cost, totalDurationMs, extras } = aggregateMessages(messages);

      const summary = rawSessionToSummary(
        rawSession,
        projectWorktrees,
        messages.length,
        usage,
        cost,
        extras,
      );

      // Load session diffs and todos
      const diffs = await loadSessionDiffs(sessionId);
      const todos = await loadSessionTodos(sessionId);

      return {
        ...summary,
        ...(totalDurationMs != null ? { totalDurationMs } : {}),
        messages,
        ...(diffs.length > 0 ? { diffs } : {}),
        ...(todos.length > 0 ? { todos } : {}),
      };
    },

    async getMessages(sessionId: string): Promise<Message<OpenCodeMessageRaw>[]> {
      return await loadMessages(sessionId);
    },

    close() {
      if (_sqlite) {
        _sqlite.close();
        _sqlite = null;
      }
    },
  };
}

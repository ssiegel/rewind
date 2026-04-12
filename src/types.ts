/**
 * Normalized OpenCode session model used by the library and web app.
 */

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface TextContent {
  type: "text";
  text: string;
  textType?: string;
}

export interface ToolUseContent {
  type: "tool_use";
  toolName: string;
  toolCallId?: string;
  input: unknown;
  subagentSessionId?: string;
  durationMs?: number;
  title?: string;
}

export interface ToolResultContent {
  type: "tool_result";
  toolCallId?: string;
  toolName?: string;
  output: string;
  isError?: boolean;
  durationMs?: number;
  interrupted?: boolean;
  status?: string;
}

export interface ThinkingContent {
  type: "thinking";
  text: string;
  durationMs?: number;
  signature?: string;
}

export interface CompactionContent {
  type: "compaction";
  auto: boolean;
  preTokens?: number;
}

export interface PatchContent {
  type: "patch";
  hash: string;
  files: string[];
}

export type MessageContent =
  | TextContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent
  | CompactionContent
  | PatchContent;

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  peakInputTokens?: number;
}

export interface MessageError {
  name: string;
  message?: string;
  statusCode?: number;
  isRetryable?: boolean;
}

export interface Message<TRaw = unknown> {
  id: string;
  role: MessageRole;
  content: MessageContent[];
  timestamp: string;
  completedAt?: string;
  durationMs?: number;
  model?: string;
  usage?: TokenUsage;
  cost?: number;
  parentId?: string;
  isCompactSummary?: boolean;
  error?: MessageError;
  stopReason?: string;
  cwd?: string;
  apiProvider?: string;
  mode?: string;
  summary?: { title?: string; diffs?: unknown[] };
  raw: TRaw;
}

export interface CodeChangeSummary {
  additions: number;
  deletions: number;
  files: number;
}

export interface PermissionRule {
  type: string;
  glob?: string;
  description?: string;
}

export interface SessionSummary {
  id: string;
  provider: "opencode";
  title?: string;
  slug?: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  projectPath?: string;
  usage?: TokenUsage;
  cost?: number;
  totalDurationMs?: number;
  parentSessionId?: string;
  cliVersion?: string;
  codeChanges?: CodeChangeSummary;
  permissions?: PermissionRule[];
  primaryModel?: string;
  models?: string[];
  toolCallCount?: number;
  subagentCount?: number;
  compactionCount?: number;
  topTools?: Array<{ name: string; count: number }>;
}

export interface OpenCodeSessionDiff {
  id: string;
  sessionID: string;
  file: string;
  status?: string;
  additions?: number;
  deletions?: number;
  diff?: string;
  before?: string;
  after?: string;
  time?: { created: number };
}

export interface OpenCodeTodo {
  id: string;
  sessionID: string;
  content: string;
  status?: string;
  priority?: string;
  time?: { created: number; updated: number };
}

export interface Session<TRawMessage = unknown> extends SessionSummary {
  messages: Message<TRawMessage>[];
  diffs?: OpenCodeSessionDiff[];
  todos?: OpenCodeTodo[];
}

export interface OpenCodeConfig {
  /**
   * Base OpenCode data directory.
   * Defaults to `~/.local/share/opencode`.
   */
  basePath?: string;
}

export interface ListSessionsOptions {
  projectPath?: string;
  after?: string;
  before?: string;
  limit?: number;
  includeSubagents?: boolean;
}

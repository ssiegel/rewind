/**
 * rewind – OpenCode session viewer and analytics library.
 *
 * @example
 * ```ts
 * import { createRewind } from "opencode-rewind";
 *
 * const rewind = createRewind();
 * const sessions = await rewind.listSessions({ limit: 20 });
 * const session = await rewind.getSession(sessions[0].id);
 * ```
 */

export { default, plugin, rewindPlugin, server } from "./opencode-plugin.js";
export type { RewindPluginOptions } from "./opencode-plugin.js";

export type {
  MessageRole,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,
  CompactionContent,
  PatchContent,
  MessageContent,
  TokenUsage,
  MessageError,
  Message,
  CodeChangeSummary,
  PermissionRule,
  SessionSummary,
  Session,
  OpenCodeSessionDiff,
  OpenCodeTodo,
  OpenCodeConfig,
  ListSessionsOptions,
} from "./types.js";

export { createOpenCodeProvider } from "./providers/opencode.js";

export type {
  OpenCodeRawSession,
  OpenCodeRawMessage,
  OpenCodePart,
  OpenCodeTextPart,
  OpenCodeReasoningPart,
  OpenCodeToolPart,
  OpenCodeCompactionPart,
  OpenCodeStepStartPart,
  OpenCodeStepFinishPart,
  OpenCodePatchPart,
  OpenCodeProject,
} from "./providers/opencode.js";

import type { ListSessionsOptions, Message, OpenCodeConfig, Session, SessionSummary } from "./types.js";
import { createOpenCodeProvider } from "./providers/opencode.js";

export interface Rewind {
  listSessions(options?: ListSessionsOptions): Promise<SessionSummary[]>;
  getSession(sessionId: string): Promise<Session | null>;
  getMessages(sessionId: string): Promise<Message[]>;
  close(): void;
}

export function createRewind(config: OpenCodeConfig = {}): Rewind {
  const provider = createOpenCodeProvider(config);

  return {
    listSessions(options) {
      return provider.listSessions(options);
    },

    getSession(sessionId) {
      return provider.getSession(sessionId);
    },

    getMessages(sessionId) {
      return provider.getMessages(sessionId);
    },

    close() {
      provider.close();
    },
  };
}

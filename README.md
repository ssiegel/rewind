# rewind

Local viewer and analytics dashboard for OpenCode sessions.

## Why

OpenCode stores rich local session state, but the raw SQLite data is awkward to inspect directly.
Rewind turns it into a purpose-built tool for:

- browsing sessions
- drilling into tool calls and subagents
- inspecting compactions and token usage
- understanding how you use OpenCode over time

## Storage

Rewind reads the current OpenCode storage layout directly:

```ts
import { createRewind } from "rewind";

const rewind = createRewind({ basePath: "/custom/path/to/opencode-data-dir" });
```

By default it reads:

- `~/.local/share/opencode/opencode.db`
- `~/.local/share/opencode/storage/session_diff/*.json`

On systems that set `XDG_DATA_HOME`, Rewind follows that base directory instead of `~/.local/share`.

## Data model

### Session

```ts
interface SessionSummary {
  id: string;
  provider: "opencode";
  title?: string;
  createdAt: string;           // ISO-8601
  updatedAt: string;
  messageCount?: number;
  projectPath?: string;
  usage?: TokenUsage;
  cost?: number;
  parentSessionId?: string;    // set on subagent sessions
}
```

### Message

```ts
interface Message<TRaw = unknown> {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: MessageContent[];
  timestamp: string;
  completedAt?: string;
  durationMs?: number;
  model?: string;
  usage?: TokenUsage;
  cost?: number;
  parentId?: string;
  isCompactSummary?: boolean;  // true on compaction summary messages
  error?: MessageError;        // present when the API call failed
  stopReason?: string;
  cwd?: string;
  apiProvider?: string;
  mode?: string;
  raw: TRaw;                   // original OpenCode-stored data
}
```

### Content blocks

```ts
type MessageContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolName: string; toolCallId?: string; input: unknown; subagentSessionId?: string; durationMs?: number; title?: string }
  | { type: "tool_result"; toolCallId?: string; toolName?: string; output: string; isError?: boolean; durationMs?: number; status?: string }
  | { type: "thinking"; text: string; durationMs?: number }
  | { type: "compaction"; auto: boolean; preTokens?: number }
  | { type: "patch"; hash: string; files: string[] }
```

### Token usage

```ts
interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  peakInputTokens?: number;
}
```

## Filtering

```ts
// By date range
await rw.listSessions({
  after: "2025-01-01T00:00:00Z",
  before: "2025-02-01T00:00:00Z",
});

// By project directory
await rw.listSessions({ projectPath: "/Users/me/myproject" });

// Include subagent sessions (excluded by default)
await rw.listSessions({ includeSubagents: true });

// Limit results
await rw.listSessions({ limit: 10 });
```

## Subagent sessions

OpenCode spawns subagent sessions for parallel work like exploration and research. These are excluded from `listSessions()` by default to avoid cluttering results.

Subagent sessions have `parentSessionId` set to the ID of the session that spawned them. Pass `includeSubagents: true` to include them.

## Compaction

When a conversation hits the context window limit, agents compact (summarize) the conversation. Rewind surfaces these events:

- A message with `{ type: "compaction", auto: boolean }` content marks where compaction occurred
- The next message has `isCompactSummary: true` and contains the generated summary
- Messages that failed due to context overflow have an `error` field with the API error details

## Raw data

Every message still carries a `.raw` field with the original OpenCode message payload.

## Diffs and todos

`getSession()` also includes:

- `diffs` from `storage/session_diff/<sessionId>.json`
- `todos` from the SQLite `todo` table

## Web viewer

Rewind also includes a Next.js web app for browsing and analyzing OpenCode sessions.

```bash
# Development (hot reload)
pnpm dev        # http://localhost:3838

# Production
pnpm build:app
pnpm serve      # http://localhost:3838
```

### REST API

The web app exposes a REST API:

```
GET /api/sessions                               # List all sessions
GET /api/sessions?project=/path/to/project      # Filter by project
GET /api/sessions?after=2025-01-01&before=2025-02-01
GET /api/sessions?includeSubagents=true         # Include subagent sessions
GET /api/session/:sessionId                     # Get full session with messages
GET /api/dashboard                              # Aggregate overview for filtered date range
```

## Development

```bash
pnpm install
pnpm test          # run tests (vitest)
pnpm test:watch    # watch mode
pnpm build         # build library to dist/
pnpm typecheck     # type check without emitting
```

## License

MIT

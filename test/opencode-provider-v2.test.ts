import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createOpenCodeProvider, type OpenCodeProvider } from "../src/providers/opencode";
import { createRewind } from "../src/lib";
import type { OpenCodeSessionDiff } from "../src/types";

interface V2Fixture {
  dataDir: string;
  storageDir: string;
  db: DatabaseSync;
  createProvider(basePath?: string): OpenCodeProvider;
  insertProject(input?: { id?: string; worktree?: string }): void;
  insertSession(input: {
    id: string;
    projectID?: string;
    parentID?: string;
    directory?: string;
    title?: string;
    slug?: string;
    version?: string;
    agent?: string;
    model?: unknown;
    created?: number;
    updated?: number;
    summary?: { additions: number; deletions: number; files: number };
    permission?: unknown;
  }): void;
  insertMessage(input: {
    id: string;
    sessionID: string;
    type: string;
    seq: number;
    created: number;
    updated?: number;
    data: Record<string, unknown>;
  }): void;
  insertTodo(input: {
    sessionID: string;
    content: string;
    status?: string;
    priority?: string;
    position: number;
    created: number;
    updated?: number;
  }): void;
  writeSessionDiffs(sessionID: string, diffs: Array<OpenCodeSessionDiff & { path?: string }>): void;
  dispose(): void;
}

let fixture: V2Fixture;

function createV2Fixture(): V2Fixture {
  const dataDir = join(tmpdir(), `rewind-opencode-v2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const storageDir = join(dataDir, "storage");
  mkdirSync(storageDir, { recursive: true });

  const db = new DatabaseSync(join(dataDir, "opencode.db"));
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL
    );

    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      fork_session_id TEXT,
      slug TEXT,
      directory TEXT,
      title TEXT,
      version TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      permission TEXT,
      agent TEXT,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );

    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER,
      data TEXT NOT NULL
    );

    CREATE TABLE todo (
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT,
      priority TEXT,
      position INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
  `);

  const providers: OpenCodeProvider[] = [];

  return {
    dataDir,
    storageDir,
    db,

    createProvider(basePath = dataDir) {
      const provider = createOpenCodeProvider({ basePath });
      providers.push(provider);
      return provider;
    },

    insertProject({ id = "proj-main", worktree = "/Users/test/project" } = {}) {
      db.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run(id, worktree);
    },

    insertSession({
      id,
      projectID = "proj-main",
      parentID,
      directory = "/Users/test/project",
      title,
      slug,
      version = "2.1.4",
      agent,
      model,
      created = 1_700_000_000_000,
      updated = created,
      summary,
      permission,
    }) {
      db.prepare(`
        INSERT INTO session_v2 (
          id, project_id, parent_id, fork_session_id, slug, directory, title, version,
          summary_additions, summary_deletions, summary_files,
          permission, agent, model, time_created, time_updated, time_archived
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        id,
        projectID,
        parentID ?? null,
        slug ?? null,
        directory ?? null,
        title ?? null,
        version,
        summary?.additions ?? null,
        summary?.deletions ?? null,
        summary?.files ?? null,
        permission ? JSON.stringify(permission) : null,
        agent ?? null,
        model ? JSON.stringify(model) : null,
        created,
        updated,
      );
    },

    insertMessage({ id, sessionID, type, seq, created, updated = created, data }) {
      db.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, sessionID, type, seq, created, updated, JSON.stringify(data));
    },

    insertTodo({ sessionID, content, status, priority, position, created, updated = created }) {
      db.prepare(
        "INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(sessionID, content, status ?? null, priority ?? null, position, created, updated);
    },

    writeSessionDiffs(sessionID, diffs) {
      const dir = join(storageDir, "session_diff");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sessionID}.json`), JSON.stringify(diffs), "utf-8");
    },

    dispose() {
      for (const provider of providers) {
        provider.close();
      }
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

beforeEach(() => {
  fixture = createV2Fixture();
});

afterEach(() => {
  fixture.dispose();
});

describe("OpenCode SQLite provider (V2 session_v2/session_message schema)", () => {
  it("lists top-level sessions and aggregates summary fields from inlined content", async () => {
    fixture.insertProject();
    fixture.insertSession({
      id: "ses-root",
      title: "Main session",
      slug: "main-session",
      updated: 1_700_000_010_000,
      summary: { additions: 12, deletions: 3, files: 2 },
      permission: [{ type: "allow", glob: "src/**", description: "Source" }],
    });
    fixture.insertSession({
      id: "ses-child",
      title: "Subagent session",
      parentID: "ses-root",
      updated: 1_700_000_020_000,
    });

    fixture.insertMessage({
      id: "msg-user",
      sessionID: "ses-root",
      type: "user",
      seq: 0,
      created: 1_700_000_000_000,
      data: { time: { created: 1_700_000_000_000 }, text: "Inspect this project" },
    });

    fixture.insertMessage({
      id: "msg-assistant",
      sessionID: "ses-root",
      type: "assistant",
      seq: 1,
      created: 1_700_000_001_000,
      data: {
        time: { created: 1_700_000_001_000, completed: 1_700_000_006_000 },
        agent: "build",
        model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
        cost: 0.0125,
        tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 30, write: 20 } },
        content: [
          {
            type: "tool",
            id: "toolu-grep",
            name: "grep",
            state: {
              status: "completed",
              input: { pattern: "TODO" },
              content: [{ type: "text", text: "src/app.ts:1: TODO" }],
            },
            time: { created: 1_700_000_001_500, completed: 1_700_000_002_000 },
          },
          {
            type: "tool",
            id: "toolu-task",
            name: "task",
            state: {
              status: "completed",
              input: { description: "Explore app", subagent_type: "explore" },
              content: [{ type: "text", text: "done" }],
              metadata: { sessionId: "ses-child" },
            },
            time: { created: 1_700_000_002_500, completed: 1_700_000_003_000 },
          },
        ],
      },
    });

    fixture.insertMessage({
      id: "msg-compaction",
      sessionID: "ses-root",
      type: "compaction",
      seq: 2,
      created: 1_700_000_007_000,
      data: {
        time: { created: 1_700_000_007_000 },
        status: "completed",
        reason: "auto",
        summary: "## Summary\nConversation compacted.",
      },
    });

    const provider = fixture.createProvider();
    const sessions = await provider.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "ses-root",
      provider: "opencode",
      title: "Main session",
      slug: "main-session",
      parentSessionId: undefined,
      cliVersion: "2.1.4",
      messageCount: 3,
      projectPath: "/Users/test/project",
      primaryModel: "claude-sonnet-4-5",
      models: ["claude-sonnet-4-5"],
      toolCallCount: 1,
      subagentCount: 1,
      compactionCount: 1,
      topTools: [
        { name: "grep", count: 1 },
        { name: "task", count: 1 },
      ],
      codeChanges: { additions: 12, deletions: 3, files: 2 },
      permissions: [{ type: "allow", glob: "src/**", description: "Source" }],
      cost: 0.0125,
      totalDurationMs: 5000,
      usage: {
        inputTokens: 150,
        outputTokens: 40,
        reasoningTokens: 10,
        cacheReadTokens: 30,
        cacheCreationTokens: 20,
        totalTokens: 200,
        peakInputTokens: 150,
      },
    });
  });

  it("supports date, project, subagent, and storage-directory filtering", async () => {
    fixture.insertProject({ id: "proj-a", worktree: "/Users/test/a" });
    fixture.insertProject({ id: "proj-b", worktree: "/Users/test/b" });

    fixture.insertSession({ id: "ses-a", projectID: "proj-a", directory: "/Users/test/a", updated: 1_700_000_000_000 });
    fixture.insertSession({ id: "ses-b", projectID: "proj-b", directory: "/Users/test/b", updated: 1_700_100_000_000 });
    fixture.insertSession({ id: "ses-sub", projectID: "proj-a", directory: "/Users/test/a", parentID: "ses-a", updated: 1_700_200_000_000 });

    const provider = fixture.createProvider(fixture.storageDir);

    expect((await provider.listSessions()).map((session) => session.id)).toEqual(["ses-b", "ses-a"]);
    expect((await provider.listSessions({ includeSubagents: true })).map((session) => session.id)).toEqual([
      "ses-sub",
      "ses-b",
      "ses-a",
    ]);
    expect((await provider.listSessions({ projectPath: "/Users/test/a", includeSubagents: true })).map((session) => session.id)).toEqual([
      "ses-sub",
      "ses-a",
    ]);
    expect((await provider.listSessions({ after: new Date(1_700_050_000_000).toISOString() })).map((session) => session.id)).toEqual([
      "ses-b",
    ]);
  });

  it("normalizes inlined content, compactions, diffs, todos, and flat error payloads", async () => {
    fixture.insertProject();
    fixture.insertSession({ id: "ses-detail", title: "Detail session", updated: 1_700_000_020_000 });

    fixture.insertMessage({
      id: "msg-1",
      sessionID: "ses-detail",
      type: "user",
      seq: 0,
      created: 1_700_000_000_000,
      data: { time: { created: 1_700_000_000_000 }, text: "Please inspect the tool output." },
    });

    fixture.insertMessage({
      id: "msg-2",
      sessionID: "ses-detail",
      type: "assistant",
      seq: 1,
      created: 1_700_000_001_000,
      data: {
        time: { created: 1_700_000_001_000, completed: 1_700_000_005_000 },
        agent: "architect",
        model: { id: "claude-opus-4-6", providerID: "anthropic" },
        finish: "stop",
        cost: 0.02,
        tokens: { input: 250, output: 90, reasoning: 25, cache: { read: 50, write: 10 } },
        content: [
          {
            type: "reasoning",
            text: "Need to read the tool output first.",
            time: { created: 1_700_000_001_100, completed: 1_700_000_001_600 },
          },
          { type: "text", text: "Here is what I found." },
          {
            type: "tool",
            id: "toolu-shell",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "pnpm test" },
              content: [{ type: "text", text: "All tests passed" }],
            },
            time: { created: 1_700_000_001_800, completed: 1_700_000_004_300 },
          },
        ],
      },
    });

    fixture.insertMessage({
      id: "msg-3",
      sessionID: "ses-detail",
      type: "compaction",
      seq: 2,
      created: 1_700_000_006_000,
      data: {
        time: { created: 1_700_000_006_000 },
        status: "completed",
        reason: "manual",
        summary: "## Summary\nConversation compacted.",
      },
    });

    fixture.insertMessage({
      id: "msg-4",
      sessionID: "ses-detail",
      type: "assistant",
      seq: 3,
      created: 1_700_000_008_000,
      data: {
        time: { created: 1_700_000_008_000, completed: 1_700_000_008_200 },
        error: { type: "aborted", message: "Aborted" },
      },
    });

    fixture.insertMessage({
      id: "msg-5",
      sessionID: "ses-detail",
      type: "idle",
      seq: 4,
      created: 1_700_000_009_500,
      data: { time: { created: 1_700_000_009_500 }, outcome: "succeeded" },
    });

    fixture.insertTodo({
      sessionID: "ses-detail",
      content: "Follow up on the failing branch",
      status: "pending",
      priority: "high",
      position: 0,
      created: 1_700_000_009_000,
    });
    fixture.writeSessionDiffs("ses-detail", [
      {
        id: "diff-1",
        sessionID: "ses-detail",
        path: "src/app.ts",
        status: "modified",
        additions: 10,
        deletions: 2,
        diff: "@@ -1 +1 @@",
      },
    ]);

    const provider = fixture.createProvider();
    const session = await provider.getSession("ses-detail");

    expect(session).not.toBeNull();
    expect(session!.totalDurationMs).toBe(4200);
    expect(session!.diffs).toEqual([
      {
        id: "diff-1",
        sessionID: "ses-detail",
        file: "src/app.ts",
        status: "modified",
        additions: 10,
        deletions: 2,
        diff: "@@ -1 +1 @@",
      },
    ]);
    expect(session!.todos).toEqual([
      {
        id: "todo-ses-detail-0",
        sessionID: "ses-detail",
        content: "Follow up on the failing branch",
        status: "pending",
        priority: "high",
        time: { created: 1_700_000_009_000, updated: 1_700_000_009_000 },
      },
    ]);

    // Idle bookkeeping messages are dropped.
    expect(session!.messages.map((message) => message.id)).toEqual(["msg-1", "msg-2", "msg-3", "msg-4"]);

    expect(session!.messages[1]).toMatchObject({
      durationMs: 4000,
      completedAt: new Date(1_700_000_005_000).toISOString(),
      model: "claude-opus-4-6",
      apiProvider: "anthropic",
      mode: "architect",
      stopReason: "stop",
      cost: 0.02,
      usage: {
        inputTokens: 310,
        outputTokens: 90,
        reasoningTokens: 25,
        cacheReadTokens: 50,
        cacheCreationTokens: 10,
        totalTokens: 425,
      },
    });
    expect(session!.messages[1].content).toMatchObject([
      { type: "thinking", text: "Need to read the tool output first.", durationMs: 500 },
      { type: "text", text: "Here is what I found." },
      {
        type: "tool_use",
        toolName: "shell",
        toolCallId: "toolu-shell",
        input: { command: "pnpm test" },
        durationMs: 2500,
      },
      {
        type: "tool_result",
        toolCallId: "toolu-shell",
        toolName: "shell",
        output: "All tests passed",
        status: "completed",
        durationMs: 2500,
      },
    ]);

    // V2 carries the compaction summary on the compaction message itself.
    expect(session!.messages[2].content).toEqual([
      { type: "compaction", auto: false },
      { type: "text", text: "## Summary\nConversation compacted." },
    ]);
    expect(session!.messages[2].isCompactSummary).toBe(true);

    expect(session!.messages[3].error).toEqual({
      name: "aborted",
      message: "Aborted",
      statusCode: undefined,
      isRetryable: undefined,
    });
  });

  it("surfaces failed tool calls with their error message as output", async () => {
    fixture.insertProject();
    fixture.insertSession({ id: "ses-err", title: "Tool error" });

    fixture.insertMessage({
      id: "msg-err",
      sessionID: "ses-err",
      type: "assistant",
      seq: 0,
      created: 1_700_000_000_000,
      data: {
        time: { created: 1_700_000_000_000, completed: 1_700_000_000_500 },
        model: { id: "claude-opus-4-6", providerID: "anthropic" },
        content: [
          {
            type: "tool",
            id: "toolu-read",
            name: "read",
            state: {
              status: "error",
              input: { path: "/missing.go" },
              content: null,
              error: { type: "tool.execution", message: "File not found" },
            },
            time: { created: 1_700_000_000_100, completed: 1_700_000_000_200 },
          },
        ],
      },
    });

    const provider = fixture.createProvider();
    const messages = await provider.getMessages("ses-err");

    expect(messages[0].content).toMatchObject([
      { type: "tool_use", toolName: "read", toolCallId: "toolu-read" },
      {
        type: "tool_result",
        toolCallId: "toolu-read",
        toolName: "read",
        output: "File not found",
        isError: true,
        status: "error",
      },
    ]);
  });

  it("orders messages by sequence and maps system and synthetic kinds", async () => {
    fixture.insertProject();
    fixture.insertSession({ id: "ses-order", title: "Ordering" });

    fixture.insertMessage({
      id: "msg-late",
      sessionID: "ses-order",
      type: "synthetic",
      seq: 2,
      created: 30,
      data: { time: { created: 30 }, text: "late" },
    });
    fixture.insertMessage({
      id: "msg-early",
      sessionID: "ses-order",
      type: "user",
      seq: 0,
      created: 10,
      data: { time: { created: 10 }, text: "early" },
    });
    fixture.insertMessage({
      id: "msg-middle",
      sessionID: "ses-order",
      type: "system",
      seq: 1,
      created: 20,
      data: { time: { created: 20 }, text: "middle" },
    });

    const provider = fixture.createProvider();
    const messages = await provider.getMessages("ses-order");

    expect(messages.map((message) => message.id)).toEqual(["msg-early", "msg-middle", "msg-late"]);
    expect(messages.map((message) => message.role)).toEqual(["user", "system", "system"]);
    expect(messages.map((message) => message.content)).toEqual([
      [{ type: "text", text: "early" }],
      [{ type: "text", text: "middle" }],
      [{ type: "text", text: "late" }],
    ]);
  });

  it("prefers the V2 schema when legacy tables are also present", async () => {
    fixture.db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT,
        directory TEXT,
        title TEXT,
        version TEXT,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        permission TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER
      );

      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER,
        data TEXT NOT NULL
      );

      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER,
        data TEXT NOT NULL
      );
    `);

    fixture.insertProject();
    // Same session in both layouts, with a V2-only title to prove which won.
    fixture.insertSession({ id: "ses-dual", title: "V2 title" });
    fixture.db
      .prepare(`
        INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
      `)
      .run("ses-dual", "proj-main", "/Users/test/project", "legacy title", "1.2.3", 1_700_000_000_000, 1_700_000_000_000);

    fixture.insertMessage({
      id: "msg-v2",
      sessionID: "ses-dual",
      type: "user",
      seq: 0,
      created: 1_700_000_000_000,
      data: { time: { created: 1_700_000_000_000 }, text: "from v2" },
    });

    const provider = fixture.createProvider();
    const sessions = await provider.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "ses-dual", title: "V2 title", cliVersion: "2.1.4" });

    const messages = await provider.getMessages("ses-dual");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([{ type: "text", text: "from v2" }]);
  });

  it("exposes the same API through createRewind with a direct basePath config", async () => {
    fixture.insertProject();
    fixture.insertSession({ id: "ses-root-api", title: "Root API session" });

    const rewind = createRewind({ basePath: fixture.dataDir });
    const sessions = await rewind.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("ses-root-api");
    rewind.close();
  });
});

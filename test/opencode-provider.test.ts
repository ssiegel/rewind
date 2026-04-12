import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpenCodeProvider, type OpenCodeProvider } from "../src/providers/opencode";
import { createRewind } from "../src/index";
import type { OpenCodeSessionDiff } from "../src/types";

interface Fixture {
  dataDir: string;
  storageDir: string;
  db: Database.Database;
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
    created?: number;
    updated?: number;
    summary?: { additions: number; deletions: number; files: number };
    permission?: unknown;
  }): void;
  insertMessage(input: {
    id: string;
    sessionID: string;
    created: number;
    updated?: number;
    data: Record<string, unknown>;
  }): void;
  insertPart(input: {
    id: string;
    sessionID: string;
    messageID: string;
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

let fixture: Fixture;

function createFixture(): Fixture {
  const dataDir = join(tmpdir(), `rewind-opencode-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const storageDir = join(dataDir, "storage");
  mkdirSync(storageDir, { recursive: true });

  const db = new Database(join(dataDir, "opencode.db"));
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL
    );

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
      version = "1.2.3",
      created = 1_700_000_000_000,
      updated = created,
      summary,
      permission,
    }) {
      db.prepare(`
        INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version,
          summary_additions, summary_deletions, summary_files,
          permission, time_created, time_updated, time_archived
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
        created,
        updated,
      );
    },

    insertMessage({ id, sessionID, created, updated = created, data }) {
      db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      ).run(id, sessionID, created, updated, JSON.stringify(data));
    },

    insertPart({ id, sessionID, messageID, created, updated = created, data }) {
      db.prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, messageID, sessionID, created, updated, JSON.stringify(data));
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
  fixture = createFixture();
});

afterEach(() => {
  fixture.dispose();
});

describe("OpenCode SQLite provider", () => {
  it("lists top-level sessions and aggregates OpenCode-specific summary fields", async () => {
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
      created: 1_700_000_000_000,
      data: { role: "user", time: { created: 1_700_000_000_000 } },
    });
    fixture.insertPart({
      id: "part-user-text",
      sessionID: "ses-root",
      messageID: "msg-user",
      created: 1_700_000_000_001,
      data: { type: "text", text: "Inspect this project" },
    });

    fixture.insertMessage({
      id: "msg-assistant",
      sessionID: "ses-root",
      created: 1_700_000_001_000,
      updated: 1_700_000_006_000,
      data: {
        role: "assistant",
        time: { created: 1_700_000_001_000, completed: 1_700_000_006_000 },
        modelID: "claude-sonnet-4-5",
        providerID: "anthropic",
        cost: 0.0125,
        tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 30, write: 20 } },
      },
    });
    fixture.insertPart({
      id: "part-tool",
      sessionID: "ses-root",
      messageID: "msg-assistant",
      created: 1_700_000_001_500,
      data: {
        type: "tool",
        callID: "toolu-grep",
        tool: "grep",
        state: {
          status: "completed",
          input: { pattern: "TODO" },
          output: "src/app.ts:1: TODO",
          time: { start: 1_700_000_001_500, end: 1_700_000_002_000 },
        },
      },
    });
    fixture.insertPart({
      id: "part-task",
      sessionID: "ses-root",
      messageID: "msg-assistant",
      created: 1_700_000_002_500,
      data: {
        type: "tool",
        callID: "toolu-task",
        tool: "task",
        state: {
          status: "completed",
          input: { description: "Explore app", subagent_type: "explore" },
          output: "done",
          metadata: { sessionId: "ses-child" },
          time: { start: 1_700_000_002_500, end: 1_700_000_003_000 },
        },
      },
    });

    fixture.insertMessage({
      id: "msg-compaction",
      sessionID: "ses-root",
      created: 1_700_000_007_000,
      data: { role: "user", time: { created: 1_700_000_007_000 } },
    });
    fixture.insertPart({
      id: "part-compaction",
      sessionID: "ses-root",
      messageID: "msg-compaction",
      created: 1_700_000_007_001,
      data: { type: "compaction", auto: true },
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
      cliVersion: "1.2.3",
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

  it("normalizes messages, compactions, diffs, todos, and error payloads", async () => {
    fixture.insertProject();
    fixture.insertSession({ id: "ses-detail", title: "Detail session", updated: 1_700_000_020_000 });

    fixture.insertMessage({
      id: "msg-1",
      sessionID: "ses-detail",
      created: 1_700_000_000_000,
      data: { role: "user", time: { created: 1_700_000_000_000 } },
    });
    fixture.insertPart({
      id: "part-1",
      sessionID: "ses-detail",
      messageID: "msg-1",
      created: 1_700_000_000_001,
      data: { type: "text", text: "Please inspect the tool output." },
    });

    fixture.insertMessage({
      id: "msg-2",
      sessionID: "ses-detail",
      created: 1_700_000_001_000,
      updated: 1_700_000_005_000,
      data: {
        role: "assistant",
        time: { created: 1_700_000_001_000, completed: 1_700_000_005_000 },
        modelID: "claude-opus-4-6",
        providerID: "anthropic",
        mode: "architect",
        finish: "end_turn",
        cost: 0.02,
        summary: { title: "Investigated output" },
        path: { cwd: "/Users/test/project/packages/app" },
        tokens: { input: 250, output: 90, reasoning: 25, cache: { read: 50, write: 10 } },
      },
    });
    fixture.insertPart({
      id: "part-2a",
      sessionID: "ses-detail",
      messageID: "msg-2",
      created: 1_700_000_001_100,
      data: {
        type: "reasoning",
        text: "Need to read the tool output first.",
        time: { start: 1_700_000_001_100, end: 1_700_000_001_600 },
      },
    });
    fixture.insertPart({
      id: "part-2b",
      sessionID: "ses-detail",
      messageID: "msg-2",
      created: 1_700_000_001_700,
      data: { type: "text", text: "Here is what I found." },
    });
    fixture.insertPart({
      id: "part-2c",
      sessionID: "ses-detail",
      messageID: "msg-2",
      created: 1_700_000_001_800,
      data: {
        type: "tool",
        callID: "toolu-bash",
        tool: "bash",
        state: {
          status: "completed",
          title: "Run test suite",
          input: { command: "pnpm test" },
          output: "All tests passed",
          time: { start: 1_700_000_001_800, end: 1_700_000_004_300 },
        },
      },
    });

    fixture.insertMessage({
      id: "msg-3",
      sessionID: "ses-detail",
      created: 1_700_000_006_000,
      data: { role: "user", time: { created: 1_700_000_006_000 } },
    });
    fixture.insertPart({
      id: "part-3",
      sessionID: "ses-detail",
      messageID: "msg-3",
      created: 1_700_000_006_001,
      data: { type: "compaction", auto: false },
    });

    fixture.insertMessage({
      id: "msg-4",
      sessionID: "ses-detail",
      created: 1_700_000_007_000,
      data: { role: "assistant", time: { created: 1_700_000_007_000 } },
    });
    fixture.insertPart({
      id: "part-4",
      sessionID: "ses-detail",
      messageID: "msg-4",
      created: 1_700_000_007_001,
      data: { type: "text", text: "## Summary\nConversation compacted." },
    });

    fixture.insertMessage({
      id: "msg-5",
      sessionID: "ses-detail",
      created: 1_700_000_008_000,
      updated: 1_700_000_008_200,
      data: {
        role: "assistant",
        time: { created: 1_700_000_008_000, completed: 1_700_000_008_200 },
        error: {
          name: "APIError",
          data: {
            message: "prompt is too long",
            statusCode: 400,
            isRetryable: false,
          },
        },
      },
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

    expect(session!.messages[1]).toMatchObject({
      durationMs: 4000,
      completedAt: new Date(1_700_000_005_000).toISOString(),
      model: "claude-opus-4-6",
      apiProvider: "anthropic",
      mode: "architect",
      stopReason: "end_turn",
      cwd: "/Users/test/project/packages/app",
      cost: 0.02,
      summary: { title: "Investigated output" },
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
        toolName: "bash",
        toolCallId: "toolu-bash",
        input: { command: "pnpm test" },
        title: "Run test suite",
        durationMs: 2500,
      },
      {
        type: "tool_result",
        toolCallId: "toolu-bash",
        toolName: "bash",
        output: "All tests passed",
        status: "completed",
        durationMs: 2500,
      },
    ]);
    expect(session!.messages[2].content).toEqual([{ type: "compaction", auto: false }]);
    expect(session!.messages[3].isCompactSummary).toBe(true);
    expect(session!.messages[4].error).toEqual({
      name: "APIError",
      message: "prompt is too long",
      statusCode: 400,
      isRetryable: false,
    });
  });

  it("returns messages in chronological order", async () => {
    fixture.insertProject();
    fixture.insertSession({ id: "ses-order", title: "Ordering" });

    fixture.insertMessage({
      id: "msg-late",
      sessionID: "ses-order",
      created: 30,
      data: { role: "user", time: { created: 30 } },
    });
    fixture.insertPart({ id: "part-late", sessionID: "ses-order", messageID: "msg-late", created: 31, data: { type: "text", text: "late" } });

    fixture.insertMessage({
      id: "msg-early",
      sessionID: "ses-order",
      created: 10,
      data: { role: "user", time: { created: 10 } },
    });
    fixture.insertPart({ id: "part-early", sessionID: "ses-order", messageID: "msg-early", created: 11, data: { type: "text", text: "early" } });

    fixture.insertMessage({
      id: "msg-middle",
      sessionID: "ses-order",
      created: 20,
      data: { role: "assistant", time: { created: 20 } },
    });
    fixture.insertPart({ id: "part-middle", sessionID: "ses-order", messageID: "msg-middle", created: 21, data: { type: "text", text: "middle" } });

    const provider = fixture.createProvider();
    const messages = await provider.getMessages("ses-order");

    expect(messages.map((message) => message.id)).toEqual(["msg-early", "msg-middle", "msg-late"]);
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

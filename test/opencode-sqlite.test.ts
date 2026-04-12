import { describe, expect, it } from "vitest";
import { createOpenCodeProvider } from "../src/providers/opencode";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const dataDir = join(
  process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"),
  "opencode"
);
const dbPath = join(dataDir, "opencode.db");

describe.skipIf(!existsSync(dbPath))("OpenCode SQLite backend (real data)", () => {
  it("lists sessions from SQLite", async () => {
    const provider = createOpenCodeProvider();
    const sessions = await provider.listSessions({ limit: 5 });
    console.log(`Found ${sessions.length} sessions`);
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) {
      expect(s.provider).toBe("opencode");
      expect(s.id).toBeTruthy();
      console.log(`  [${s.id}] "${s.title}" — ${s.messageCount} msgs`);
    }
  });

  it("loads a full session with messages", async () => {
    const provider = createOpenCodeProvider();
    const sessions = await provider.listSessions({ limit: 1 });
    expect(sessions.length).toBeGreaterThan(0);

    const session = await provider.getSession(sessions[0].id);
    expect(session).not.toBeNull();
    expect(session!.messages.length).toBeGreaterThan(0);
    console.log(`Session "${session!.title}" has ${session!.messages.length} messages`);

    // Check first message has expected structure
    const msg = session!.messages[0];
    expect(msg.id).toBeTruthy();
    expect(msg.role).toBeTruthy();
    expect(msg.content.length).toBeGreaterThan(0);
    expect(msg.timestamp).toBeTruthy();
    expect(msg.raw).toBeTruthy();
    
    // Check content blocks
    for (const block of msg.content) {
      expect(["text", "tool_use", "tool_result", "thinking", "compaction", "patch"].includes(block.type)).toBe(true);
    }
    
    console.log(`  First message: [${msg.role}] ${msg.content.map(c => c.type).join(", ")}`);
  });
});

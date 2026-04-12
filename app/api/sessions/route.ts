import { NextResponse, type NextRequest } from "next/server";
import { getRewind } from "../../lib/rewind-server";

export async function GET(request: NextRequest) {
  const rw = getRewind();
  const { searchParams } = request.nextUrl;

  const options: {
    projectPath?: string;
    after?: string;
    before?: string;
    limit?: number;
    includeSubagents?: boolean;
  } = {};

  const project = searchParams.get("project");
  const after = searchParams.get("after");
  const before = searchParams.get("before");
  const limit = searchParams.get("limit");
  const includeSubagents = searchParams.get("includeSubagents");

  if (project) options.projectPath = project;
  if (after) options.after = after;
  if (before) options.before = before;
  if (limit) options.limit = parseInt(limit, 10);
  if (includeSubagents === "true") options.includeSubagents = true;

  const sessions = await rw.listSessions(options);
  return NextResponse.json(sessions);
}

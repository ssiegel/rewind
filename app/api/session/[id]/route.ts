import { NextResponse, type NextRequest } from "next/server";
import { getRewind } from "../../../lib/rewind-server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rw = getRewind();
  const session = await rw.getSession(decodeURIComponent(id));

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const searchParams = request.nextUrl.searchParams;
  const startStr = searchParams.get("startMessage");
  const endStr = searchParams.get("endMessage");

  if (startStr !== null || endStr !== null) {
    const totalMessages = session.messages.length;
    const start = Math.max(0, parseInt(startStr ?? "0", 10));
    const end = Math.min(totalMessages - 1, parseInt(endStr ?? String(totalMessages - 1), 10));

    if (start > end || start >= totalMessages) {
      return NextResponse.json(
        { error: `Invalid range: startMessage=${start}, endMessage=${end}, total=${totalMessages}` },
        { status: 400 },
      );
    }

    return NextResponse.json({
      ...session,
      messages: session.messages.slice(start, end + 1),
      messageRange: {
        start,
        end,
        total: totalMessages,
      },
    });
  }

  return NextResponse.json(session);
}

import { NextResponse } from "next/server";
import { manualBreakSchema } from "@/features/attendance/break-schemas";
import { createManualBreak } from "@/features/attendance/service";
import { auth } from "@/server/auth";

/** POST /api/breaks — create a manual (backfilled) break entry. */
export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = await request.json().catch(() => null);
  const parsed = manualBreakSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: issue ? issue.message : "Invalid input" },
      { status: 400 },
    );
  }

  try {
    const breakItem = await createManualBreak(
      session.user.id,
      session.user.timezone,
      {
        workDate: parsed.data.workDate,
        startedAt: new Date(parsed.data.startedAt),
        endedAt: new Date(parsed.data.endedAt),
      },
    );
    return NextResponse.json(breakItem, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not create break";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { clockOut } from "@/features/attendance/service";
import { autoSyncAfterClose } from "@/features/sheets-sync/auto-sync-server";
import { auth } from "@/server/auth";

const EmptyBody = z.object({});

/** POST /api/attendance/stop — clock out the open attendance & auto-sync if configured. */
export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: userId, timezone } = session.user;
  try {
    const raw = await req.json().catch(() => null);
    EmptyBody.parse(raw ?? {});

    const attendance = await clockOut(userId, timezone);

    const autoSyncResult = await autoSyncAfterClose(
      userId,
      attendance.workDate,
      timezone,
      {
        accessToken: session.accessToken,
        resetStateOnFailure: "draft",
        logLabel: "Auto-sync on clock-out failed:",
      },
    );

    return NextResponse.json({
      ...attendance,
      autoSync: autoSyncResult,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bad request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

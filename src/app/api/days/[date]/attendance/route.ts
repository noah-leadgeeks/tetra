import { NextResponse } from "next/server";
import { z } from "zod";
import { updateAttendanceTimes } from "@/features/attendance/service";
import {
  autoSyncAfterClose,
  type CloseAutoSyncResult,
} from "@/features/sheets-sync/auto-sync-server";
import { auth } from "@/server/auth";

const dateParamSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Invalid date");

const sessionUserSchema = z.object({
  id: z.string().min(1),
  timezone: z.string().min(1),
});

const bodySchema = z.object({
  action: z.enum(["clock_in", "clock_out", "update"]).optional(),
  clockInAt: z.string().optional().nullable(),
  clockOutAt: z.string().optional().nullable(),
  status: z.enum(["open", "closed"]).optional(),
});

/**
 * POST /api/days/[date]/attendance
 * Updates or sets attendance times (clock-in, clock-out, status) for a specific day.
 * Auto-syncs to Google Sheets if autoSyncOnClockOut is configured.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ date: string }> },
) {
  const { date } = await params;
  const parsedDate = dateParamSchema.safeParse(date);
  if (!parsedDate.success) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const session = await auth();
  const parsedUser = sessionUserSchema.safeParse(session?.user);
  if (!parsedUser.success) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = await request.json().catch(() => ({}));
  const parsedBody = bodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid body parameters" },
      { status: 400 },
    );
  }

  const { id: userId, timezone } = parsedUser.data;
  const workDate = parsedDate.data;

  try {
    const attendance = await updateAttendanceTimes(
      userId,
      workDate,
      timezone,
      parsedBody.data,
    );

    // Auto-sync if closing attendance and autoSyncOnClockOut is enabled
    const autoSyncResult: CloseAutoSyncResult =
      attendance.status === "closed"
        ? await autoSyncAfterClose(userId, workDate, timezone, {
            accessToken: session?.accessToken,
            resetStateOnFailure: "ready",
            logLabel: "Auto-sync on attendance update failed:",
          })
        : { attempted: false };

    return NextResponse.json({
      attendance,
      autoSync: autoSyncResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update attendance";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

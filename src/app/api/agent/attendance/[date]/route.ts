import { NextResponse } from "next/server";
import { withAgentAuth } from "@/features/agent-api/http";
import {
  auditedWriteWithId,
  parseAgentBody,
  recordSyncOutcome,
  safeAutoSyncAfterClose,
} from "@/features/agent-api/writes";
import { agentAttendancePatchSchema } from "@/features/attendance/attendance-schemas";
import { updateAttendanceTimes } from "@/features/attendance/service";
import type { CloseAutoSyncResult } from "@/features/sheets-sync/auto-sync-server";
import { isoDate } from "@/lib/zod-time";

/**
 * PATCH /api/agent/attendance/[date] — set clock-in/out times or status for a
 * day. When the day ends up `closed`, it is auto-synced like the UI route
 * (failure resets it to `ready`); a sync error never fails the update.
 */
export const PATCH = withAgentAuth<{ date: string }>("write", async (ctx, req, params) => {
  const date = isoDate.safeParse(params.date);
  if (!date.success) {
    return NextResponse.json({ error: "Invalid date, expected YYYY-MM-DD", code: "bad_request" }, { status: 400 });
  }
  const body = await parseAgentBody(req, agentAttendancePatchSchema);

  const { value: attendance, auditId } = await auditedWriteWithId(
    ctx,
    {
      kind: "attendance.update",
      targetType: "attendance",
      summary: { label: date.data, request: body },
    },
    // updateAttendanceTimes mutates its input; pass a copy so the audit row keeps the original body.
    () => updateAttendanceTimes(ctx.userId, date.data, ctx.timezone, structuredClone(body)),
    (a) => ({ targetId: a.id }),
  );

  const autoSync: CloseAutoSyncResult =
    attendance.status === "closed"
      ? await safeAutoSyncAfterClose(ctx, date.data, "ready")
      : { attempted: false };
  if (attendance.status === "closed") await recordSyncOutcome(auditId, { autoSync });
  return NextResponse.json({ attendance, autoSync });
});

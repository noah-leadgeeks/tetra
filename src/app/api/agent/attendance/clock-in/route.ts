import { NextResponse } from "next/server";
import { z } from "zod";
import { withAgentAuth } from "@/features/agent-api/http";
import {
  auditedWriteWithId,
  parseAgentBody,
  recordSyncOutcome,
  safeSyncClockIn,
} from "@/features/agent-api/writes";
import { clockIn } from "@/features/attendance/service";

/** POST /api/agent/attendance/clock-in — clock in for today, then sync the clock-in cell. */
export const POST = withAgentAuth("write", async (ctx, req) => {
  await parseAgentBody(req, z.object({}));
  const { value: attendance, auditId } = await auditedWriteWithId(
    ctx,
    { kind: "attendance.clock_in", targetType: "attendance", summary: {} },
    () => clockIn(ctx.userId, ctx.timezone),
    (a) => ({ targetId: a.id }),
  );
  const autoSync = await safeSyncClockIn(ctx, attendance.workDate, attendance.clockInAt);
  await recordSyncOutcome(auditId, { autoSync });
  return NextResponse.json({ attendance, autoSync });
});

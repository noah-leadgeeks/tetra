import { NextResponse } from "next/server";
import { z } from "zod";
import { withAgentAuth } from "@/features/agent-api/http";
import {
  auditedWriteWithId,
  parseAgentBody,
  recordSyncOutcome,
  safeAutoSyncAfterClose,
} from "@/features/agent-api/writes";
import { clockOut } from "@/features/attendance/service";

/**
 * POST /api/agent/attendance/clock-out — clock out, then auto-sync the closed
 * day (failure resets it to `draft`). A sync error never fails the clock-out:
 * it is reported as `autoSync.success = false`.
 */
export const POST = withAgentAuth("write", async (ctx, req) => {
  await parseAgentBody(req, z.object({}));
  const { value: attendance, auditId } = await auditedWriteWithId(
    ctx,
    { kind: "attendance.clock_out", targetType: "attendance", summary: {} },
    () => clockOut(ctx.userId, ctx.timezone),
    (a) => ({ targetId: a.id }),
  );
  const autoSync = await safeAutoSyncAfterClose(ctx, attendance.workDate, "draft");
  await recordSyncOutcome(auditId, { autoSync });
  return NextResponse.json({ attendance, autoSync });
});

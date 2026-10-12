import { NextResponse } from "next/server";
import { z } from "zod";
import { withAgentAuth } from "@/features/agent-api/http";
import { auditedWriteWithId, parseAgentBody, recordSyncOutcome } from "@/features/agent-api/writes";
import { endBreak } from "@/features/attendance/service";
import { syncDaysAfterChange } from "@/features/sheets-sync/auto-sync-server";

/** POST /api/agent/breaks/stop — end the open break, then sync its day. */
export const POST = withAgentAuth("write", async (ctx, req) => {
  await parseAgentBody(req, z.object({}));
  const { value: attendance, auditId } = await auditedWriteWithId(
    ctx,
    { kind: "break.stop", targetType: "break", summary: {} },
    () => endBreak(ctx.userId, ctx.timezone),
  );
  const sheetSync = await syncDaysAfterChange(ctx.userId, [attendance.workDate]);
  await recordSyncOutcome(auditId, { sheetSync });
  return NextResponse.json({ attendance, sheetSync });
});

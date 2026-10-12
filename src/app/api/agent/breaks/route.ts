import { NextResponse } from "next/server";
import { withAgentAuth } from "@/features/agent-api/http";
import { auditedWriteWithId, parseAgentBody, recordSyncOutcome } from "@/features/agent-api/writes";
import { agentManualBreakSchema } from "@/features/attendance/break-schemas";
import { createManualBreak } from "@/features/attendance/service";
import { syncDaysAfterChange } from "@/features/sheets-sync/auto-sync-server";

/** POST /api/agent/breaks — manual (backfilled) break on `workDate`, then sync that day. */
export const POST = withAgentAuth("write", async (ctx, req) => {
  const body = await parseAgentBody(req, agentManualBreakSchema);
  const { value: created, auditId } = await auditedWriteWithId(
    ctx,
    { kind: "break.create", targetType: "break", summary: { label: body.workDate, request: body } },
    () =>
      createManualBreak(ctx.userId, ctx.timezone, {
        workDate: body.workDate,
        startedAt: new Date(body.startedAt),
        endedAt: new Date(body.endedAt),
      }),
    (b) => ({ targetId: b.id }),
  );
  const sheetSync = await syncDaysAfterChange(ctx.userId, [body.workDate]);
  await recordSyncOutcome(auditId, { sheetSync });
  return NextResponse.json({ break: created, sheetSync }, { status: 201 });
});

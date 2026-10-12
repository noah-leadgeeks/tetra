import { NextResponse } from "next/server";
import { stopTimer } from "@/features/activities/timer-operations";
import { withAgentAuth } from "@/features/agent-api/http";
import { toEntryItem } from "@/features/agent-api/read-models";
import { auditedWriteWithId, recordSyncOutcome, syncSpans } from "@/features/agent-api/writes";

/** POST /api/agent/time-entries/stop — stop the current entry and sync its days. */
export const POST = withAgentAuth("write", async (ctx) => {
  const { value: entry, auditId } = await auditedWriteWithId(
    ctx,
    { kind: "time_entry.stop", targetType: "time_entry", summary: {} },
    () => stopTimer(ctx.userId, ctx.timezone),
    (stopped) => ({ targetId: stopped.id }),
  );
  const sheetSync = await syncSpans(ctx, [entry]);
  await recordSyncOutcome(auditId, { sheetSync });
  return NextResponse.json({ entry: toEntryItem(entry), sheetSync });
});

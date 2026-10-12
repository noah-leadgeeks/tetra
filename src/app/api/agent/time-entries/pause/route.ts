import { NextResponse } from "next/server";
import { pauseTimer } from "@/features/activities/timer-operations";
import { withAgentAuth } from "@/features/agent-api/http";
import { toEntryItem } from "@/features/agent-api/read-models";
import { auditedWrite } from "@/features/agent-api/writes";

/** POST /api/agent/time-entries/pause — pause the current entry (no sheet sync, UI parity). */
export const POST = withAgentAuth("write", async (ctx) => {
  const entry = await auditedWrite(
    ctx,
    { kind: "time_entry.pause", targetType: "time_entry", summary: {} },
    () => pauseTimer(ctx.userId),
    (e) => ({ targetId: e.id }),
  );
  return NextResponse.json({ entry: toEntryItem(entry) });
});

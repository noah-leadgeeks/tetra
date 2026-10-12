import { NextResponse } from "next/server";
import { resumeTimer } from "@/features/activities/timer-operations";
import { withAgentAuth } from "@/features/agent-api/http";
import { toEntryItem } from "@/features/agent-api/read-models";
import { auditedWrite } from "@/features/agent-api/writes";

/** POST /api/agent/time-entries/resume — resume the current entry (no sheet sync, UI parity). */
export const POST = withAgentAuth("write", async (ctx) => {
  const entry = await auditedWrite(
    ctx,
    { kind: "time_entry.resume", targetType: "time_entry", summary: {} },
    () => resumeTimer(ctx.userId),
    (e) => ({ targetId: e.id }),
  );
  return NextResponse.json({ entry: toEntryItem(entry) });
});

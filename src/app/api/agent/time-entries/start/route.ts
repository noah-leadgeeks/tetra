import { NextResponse } from "next/server";
import { getActiveEntry } from "@/features/activities/entry-queries";
import { agentStartSchema } from "@/features/activities/entry-schemas";
import { startTimer } from "@/features/activities/timer-operations";
import { resolveCategoryId, withAgentAuth } from "@/features/agent-api/http";
import { toEntryItem } from "@/features/agent-api/read-models";
import {
  assertCategoryGiven,
  auditedWriteWithId,
  parseAgentBody,
  recordSyncOutcome,
  syncSpans,
} from "@/features/agent-api/writes";

/**
 * POST /api/agent/time-entries/start — start a timer. `startTimer` auto-stops
 * any running entry; only that closed entry's days are synced (starting never syncs).
 */
export const POST = withAgentAuth("write", async (ctx, req) => {
  const body = await parseAgentBody(req, agentStartSchema);
  assertCategoryGiven(body);

  const previous = await getActiveEntry(ctx.userId);
  const { value: entry, auditId } = await auditedWriteWithId(
    ctx,
    {
      kind: "time_entry.start",
      targetType: "time_entry",
      summary: { label: body.taskName, request: body, stoppedEntryId: previous?.id ?? null },
    },
    async () =>
      startTimer(ctx.userId, ctx.timezone, {
        taskName: body.taskName,
        categoryId: await resolveCategoryId(body),
        notes: body.notes,
      }),
    (started) => ({ targetId: started.id }),
  );

  // The previous entry was closed at the new entry's start instant.
  const sheetSync = previous
    ? await syncSpans(ctx, [{ startedAt: previous.startedAt, endedAt: entry.startedAt }])
    : null;
  if (sheetSync) await recordSyncOutcome(auditId, { sheetSync });
  return NextResponse.json({ entry: toEntryItem(entry), sheetSync });
});

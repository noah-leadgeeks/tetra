import { NextResponse } from "next/server";
import { createManualEntry } from "@/features/activities/entry-mutations";
import { getDayEntries } from "@/features/activities/entry-queries";
import { agentManualEntrySchema } from "@/features/activities/entry-schemas";
import { dayParam, resolveCategoryId, withAgentAuth } from "@/features/agent-api/http";
import { toEntryItem } from "@/features/agent-api/read-models";
import {
  assertCategoryGiven,
  auditedWriteWithId,
  parseAgentBody,
  recordSyncOutcome,
  syncSpans,
} from "@/features/agent-api/writes";

/** GET /api/agent/time-entries?date=YYYY-MM-DD (default: today in the user's timezone) */
export const GET = withAgentAuth("read", async (ctx, req) => {
  const date = dayParam(new URL(req.url), ctx.timezone);
  const entries = await getDayEntries(ctx.userId, date, ctx.timezone);
  return NextResponse.json({ date, timeEntries: entries.map(toEntryItem) });
});

/**
 * POST /api/agent/time-entries — manual (backfilled) entry; 409 on overlap.
 * Syncs every user-local day the entry spans.
 */
export const POST = withAgentAuth("write", async (ctx, req) => {
  const body = await parseAgentBody(req, agentManualEntrySchema);
  assertCategoryGiven(body);
  const { value: entry, auditId } = await auditedWriteWithId(
    ctx,
    {
      kind: "time_entry.create",
      targetType: "time_entry",
      summary: { label: body.taskName, request: body },
    },
    async () =>
      createManualEntry(ctx.userId, ctx.timezone, {
        startedAt: new Date(body.startedAt),
        endedAt: new Date(body.endedAt),
        taskName: body.taskName,
        categoryId: await resolveCategoryId(body),
        notes: body.notes,
      }),
    (created) => ({ targetId: created.id }),
  );
  const sheetSync = await syncSpans(ctx, [entry]);
  await recordSyncOutcome(auditId, { sheetSync });
  return NextResponse.json({ entry: toEntryItem(entry), sheetSync }, { status: 201 });
});

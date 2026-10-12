import { agentDeleteHandler } from "@/features/agent-api/delete-route";
import { NextResponse } from "next/server";
import { updateEntry } from "@/features/activities/entry-mutations";
import { agentEntryPatchSchema } from "@/features/activities/entry-schemas";
import { parseIdParam, withAgentAuth } from "@/features/agent-api/http";
import { toEntryItem } from "@/features/agent-api/read-models";
import {
  auditedWriteWithId,
  findUserEntrySpan,
  optionalCategoryId,
  parseAgentBody,
  recordSyncOutcome,
  syncSpans,
} from "@/features/agent-api/writes";

/**
 * PATCH /api/agent/time-entries/[id] — edit an entry; 409 on overlap.
 * Syncs the union of the entry's day keys before and after the edit.
 */
export const PATCH = withAgentAuth<{ id: string }>("write", async (ctx, req, params) => {
  const parsed = parseIdParam(params.id);
  if (!parsed.ok) return parsed.response;
  const body = await parseAgentBody(req, agentEntryPatchSchema);

  const {
    value: { before, entry },
    auditId,
  } = await auditedWriteWithId(
    ctx,
    {
      kind: "time_entry.update",
      targetType: "time_entry",
      targetId: parsed.id,
      summary: { request: body },
    },
    async () => {
      const before = await findUserEntrySpan(ctx.userId, parsed.id);
      const entry = await updateEntry(
        ctx.userId,
        parsed.id,
        {
          startedAt: body.startedAt !== undefined ? new Date(body.startedAt) : undefined,
          endedAt: body.endedAt !== undefined ? new Date(body.endedAt) : undefined,
          notes: body.notes,
          categoryId: await optionalCategoryId(body),
          taskName: body.taskName,
        },
        ctx.timezone,
      );
      return { before, entry };
    },
  );
  const sheetSync = await syncSpans(ctx, [before, entry]);
  await recordSyncOutcome(auditId, { sheetSync });
  return NextResponse.json({ entry: toEntryItem(entry), sheetSync });
});

/** DELETE — registers a pending delete for in-app approval (202); never deletes directly. */
export const DELETE = agentDeleteHandler("time_entry");

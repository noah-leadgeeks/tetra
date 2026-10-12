import { agentDeleteHandler } from "@/features/agent-api/delete-route";
import { NextResponse } from "next/server";
import { parseIdParam, withAgentAuth } from "@/features/agent-api/http";
import {
  auditedWriteWithId,
  findUserBreakWorkDate,
  parseAgentBody,
  recordSyncOutcome,
} from "@/features/agent-api/writes";
import { breakPatchSchema } from "@/features/attendance/break-schemas";
import { updateBreak } from "@/features/attendance/service";
import { syncDaysAfterChange } from "@/features/sheets-sync/auto-sync-server";

/**
 * PATCH /api/agent/breaks/[id] — edit a break's span. User-scoped lookup of the
 * break's attendance day first (foreign or unknown ids are 404), then sync that day.
 */
export const PATCH = withAgentAuth<{ id: string }>("write", async (ctx, req, params) => {
  const parsed = parseIdParam(params.id);
  if (!parsed.ok) return parsed.response;
  const body = await parseAgentBody(req, breakPatchSchema);

  const {
    value: { workDate, updated },
    auditId,
  } = await auditedWriteWithId(
    ctx,
    { kind: "break.update", targetType: "break", targetId: parsed.id, summary: { request: body } },
    async () => {
      const workDate = await findUserBreakWorkDate(ctx.userId, parsed.id);
      const updated = await updateBreak(ctx.userId, parsed.id, ctx.timezone, {
        startedAt: body.startedAt !== undefined ? new Date(body.startedAt) : undefined,
        endedAt: body.endedAt !== undefined ? new Date(body.endedAt) : undefined,
      });
      return { workDate, updated };
    },
  );
  const sheetSync = await syncDaysAfterChange(ctx.userId, [workDate]);
  await recordSyncOutcome(auditId, { sheetSync });
  return NextResponse.json({ break: updated, sheetSync });
});

/** DELETE — registers a pending delete for in-app approval (202); never deletes directly. */
export const DELETE = agentDeleteHandler("break");

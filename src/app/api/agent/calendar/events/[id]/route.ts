import { agentDeleteHandler } from "@/features/agent-api/delete-route";
import { NextResponse } from "next/server";
import { parseIdParam, resolveCategoryId, withAgentAuth } from "@/features/agent-api/http";
import { auditedWrite, parseAgentBody } from "@/features/agent-api/writes";
import { agentUpdateEventSchema } from "@/features/calendar-sync/event-schemas";
import { updateCalendarEvent } from "@/features/calendar-sync/service";

/**
 * PATCH /api/agent/calendar/events/[id] — update an event (user-scoped in the
 * service; foreign or unknown ids are 404). `google` reports the Google write. No sheet sync.
 */
export const PATCH = withAgentAuth<{ id: string }>("write", async (ctx, req, params) => {
  const parsed = parseIdParam(params.id);
  if (!parsed.ok) return parsed.response;
  const body = await parseAgentBody(req, agentUpdateEventSchema);

  const { event, google } = await auditedWrite(
    ctx,
    {
      kind: "calendar_event.update",
      targetType: "calendar_event",
      targetId: parsed.id,
      summary: { request: body },
    },
    async () => {
      // Unknown category is a 404, not an FK violation (500) at update time.
      if (body.categoryId) await resolveCategoryId({ categoryId: body.categoryId });
      return updateCalendarEvent(ctx.userId, parsed.id, body, ctx.timezone);
    },
    (res) => ({ result: { google: res.google } }),
  );
  return NextResponse.json({ event, google });
});

/** DELETE — registers a pending delete for in-app approval (202); never deletes directly. */
export const DELETE = agentDeleteHandler("calendar_event");

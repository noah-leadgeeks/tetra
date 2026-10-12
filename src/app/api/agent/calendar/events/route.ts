import { NextResponse } from "next/server";
import { BadRequestError } from "@/features/agent-api/errors";
import { dayParam, resolveCategoryId, withAgentAuth } from "@/features/agent-api/http";
import { instantParam } from "@/features/agent-api/read-models";
import { auditedWrite, parseAgentBody } from "@/features/agent-api/writes";
import { agentCreateEventSchema } from "@/features/calendar-sync/event-schemas";
import { createCalendarEvent, listCalendarEvents } from "@/features/calendar-sync/service";
import { zonedDayEnd, zonedDayStart } from "@/lib/time";

/**
 * GET /api/agent/calendar/events?date=|from=&to=&sync=
 * `from`/`to` are ISO instants with an offset; otherwise `date` (default: today
 * in the user's timezone) selects a zoned day. Google is only queried when sync=true.
 */
export const GET = withAgentAuth("read", async (ctx, req) => {
  const url = new URL(req.url);
  const fromParam = instantParam(url, "from");
  const toParam = instantParam(url, "to");
  if ((fromParam === undefined) !== (toParam === undefined)) {
    throw new BadRequestError("Provide both from and to, or neither");
  }

  let from: string;
  let to: string;
  let date: string | null = null;
  if (fromParam !== undefined && toParam !== undefined) {
    if (new Date(fromParam) > new Date(toParam)) throw new BadRequestError("from must not be after to");
    from = fromParam;
    to = toParam;
  } else {
    date = dayParam(url, ctx.timezone);
    from = zonedDayStart(date, ctx.timezone).toISOString();
    to = zonedDayEnd(date, ctx.timezone).toISOString();
  }

  const events = await listCalendarEvents(ctx.userId, {
    from,
    to,
    syncWithGoogle: url.searchParams.get("sync") === "true",
    timeZone: ctx.timezone,
  });
  return NextResponse.json({ date, from, to, events });
});

/**
 * POST /api/agent/calendar/events — create an event. `google` reports whether
 * Google Calendar was updated (the local row is written either way). No sheet sync.
 */
export const POST = withAgentAuth("write", async (ctx, req) => {
  const body = await parseAgentBody(req, agentCreateEventSchema);
  const { event, google } = await auditedWrite(
    ctx,
    {
      kind: "calendar_event.create",
      targetType: "calendar_event",
      summary: { label: body.title, request: body },
    },
    async () => {
      // Unknown category is a 404, not an FK violation (500) at insert time.
      if (body.categoryId) await resolveCategoryId({ categoryId: body.categoryId });
      return createCalendarEvent(ctx.userId, body, ctx.timezone);
    },
    (res) => ({ targetId: res.event.id, result: { google: res.google } }),
  );
  return NextResponse.json({ event, google }, { status: 201 });
});

import { NextResponse } from "next/server";
import { dayParam, withAgentAuth } from "@/features/agent-api/http";
import { toEntryItem } from "@/features/agent-api/read-models";
import { listCalendarEvents } from "@/features/calendar-sync/service";
import { getDaySummary } from "@/features/daily-summary/service";
import { zonedDayEnd, zonedDayStart } from "@/lib/time";

/** GET /api/agent/schedule?date=YYYY-MM-DD (default: today in the user's timezone) */
export const GET = withAgentAuth("read", async (ctx, req) => {
  const url = new URL(req.url);
  const date = dayParam(url, ctx.timezone);
  const [summary, events] = await Promise.all([
    getDaySummary(ctx.userId, date, ctx.timezone),
    listCalendarEvents(ctx.userId, {
      from: zonedDayStart(date, ctx.timezone).toISOString(),
      to: zonedDayEnd(date, ctx.timezone).toISOString(),
      timeZone: ctx.timezone,
    }),
  ]);
  return NextResponse.json({
    date,
    attendance: summary.attendance,
    breaks: summary.attendance?.breaks ?? [],
    timeEntries: summary.timeEntries.map(toEntryItem),
    events,
    totals: summary.totals,
    warnings: summary.warnings,
    reviewState: summary.reviewState,
    needsSync: summary.needsSync,
  });
});

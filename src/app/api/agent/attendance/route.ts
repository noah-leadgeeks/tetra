import { NextResponse } from "next/server";
import { dayParam, withAgentAuth } from "@/features/agent-api/http";
import { getDaySummary } from "@/features/daily-summary/service";

/** GET /api/agent/attendance?date=YYYY-MM-DD (default: today in the user's timezone) */
export const GET = withAgentAuth("read", async (ctx, req) => {
  const date = dayParam(new URL(req.url), ctx.timezone);
  const summary = await getDaySummary(ctx.userId, date, ctx.timezone);
  return NextResponse.json({ date, attendance: summary.attendance });
});

import { NextResponse } from "next/server";
import { getActiveEntry, listAllTasks } from "@/features/activities/entry-queries";
import { withAgentAuth } from "@/features/agent-api/http";
import { toTaskItem } from "@/features/agent-api/read-models";
import { listCalendarEvents } from "@/features/calendar-sync/service";
import { getDaySummary } from "@/features/daily-summary/service";
import { filterTasks } from "@/lib/task-dates";
import { todayKey, zonedDayEnd, zonedDayStart } from "@/lib/time";

/** GET /api/agent/summary?sync=true — "what's my day" in the user's timezone. */
export const GET = withAgentAuth("read", async (ctx, req) => {
  const url = new URL(req.url);
  const tz = ctx.timezone;
  const date = todayKey(tz);

  const [day, active, allTasks, events] = await Promise.all([
    getDaySummary(ctx.userId, date, tz),
    getActiveEntry(ctx.userId),
    listAllTasks(ctx.userId),
    listCalendarEvents(ctx.userId, {
      from: zonedDayStart(date, tz).toISOString(),
      to: zonedDayEnd(date, tz).toISOString(),
      syncWithGoogle: url.searchParams.get("sync") === "true",
      timeZone: tz,
    }),
  ]);

  const bucket = (f: "in_progress" | "today" | "overdue" | "upcoming") =>
    filterTasks(allTasks, f, date).map(toTaskItem);
  const att = day.attendance;

  return NextResponse.json({
    date,
    timezone: tz,
    now: new Date().toISOString(),
    attendance: att
      ? {
          status: att.status,
          clockInAt: att.clockInAt,
          clockOutAt: att.clockOutAt,
          breakMinutes: att.breakMinutes,
          activeBreak: att.activeBreak,
        }
      : null,
    activeEntry: active
      ? {
          id: active.id,
          taskName: active.taskName,
          categoryKey: active.categoryKey,
          startedAt: active.startedAt,
          status: active.status,
        }
      : null,
    totals: day.totals,
    tasks: {
      inProgress: bucket("in_progress"),
      dueToday: bucket("today"),
      overdue: bucket("overdue"),
      upcoming: bucket("upcoming"),
    },
    schedule: events.map((e) => ({
      id: e.id,
      title: e.title,
      startAt: e.startAt,
      endAt: e.endAt,
      allDay: e.allDay,
      meetUrl: e.meetUrl,
    })),
    warnings: day.warnings.map(({ type, message }) => ({ type, message })),
    needsSync: day.needsSync,
  });
});

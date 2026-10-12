import { NextResponse } from "next/server";

import { createEventSchema } from "@/features/calendar-sync/event-schemas";
import {
  createCalendarEvent,
  getCalendarSchedule,
  listCalendarEvents,
} from "@/features/calendar-sync/service";
import { todayKey } from "@/lib/time";
import { auth } from "@/server/auth";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const timeZone = session.user.timezone || "Asia/Jakarta";
  const mode = searchParams.get("mode");
  const dateParam = searchParams.get("date");
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const syncWithGoogle = searchParams.get("sync") === "true";

  // If explicitly requesting suggestions OR if date param is given without mode=events/from/to
  if (mode === "suggestions" || (dateParam && !fromParam && !toParam && mode !== "events")) {
    const dayKey =
      dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
        ? dateParam
        : todayKey(timeZone);

    try {
      const result = await getCalendarSchedule(session.user.id, dayKey, timeZone);
      return NextResponse.json(result);
    } catch (err) {
      console.error("Failed to load calendar schedule:", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to load calendar schedule" },
        { status: 500 },
      );
    }
  }

  try {
    const events = await listCalendarEvents(session.user.id, {
      from: fromParam || undefined,
      to: toParam || undefined,
      syncWithGoogle,
      timeZone,
    });
    return NextResponse.json({ events });
  } catch (err) {
    console.error("Failed to list calendar events:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list calendar events" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const timeZone = session.user.timezone || "Asia/Jakarta";

  try {
    const body = await request.json();
    const parsed = createEventSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid request payload",
          details: parsed.error.format(),
        },
        { status: 400 },
      );
    }

    const { event, google } = await createCalendarEvent(session.user.id, parsed.data, timeZone);
    return NextResponse.json({ event, google }, { status: 201 });
  } catch (err) {
    console.error("Failed to create calendar event:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create calendar event" },
      { status: 500 },
    );
  }
}


import { NextResponse } from "next/server";

import { updateEventSchema } from "@/features/calendar-sync/event-schemas";
import {
  deleteCalendarEvent,
  updateCalendarEvent,
} from "@/features/calendar-sync/service";
import { auth } from "@/server/auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing event ID" }, { status: 400 });
  }

  const timeZone = session.user.timezone || "Asia/Jakarta";

  try {
    const body = await request.json();
    const parsed = updateEventSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid request payload",
          details: parsed.error.format(),
        },
        { status: 400 },
      );
    }

    const { event, google } = await updateCalendarEvent(session.user.id, id, parsed.data, timeZone);
    return NextResponse.json({ event, google });
  } catch (err) {
    console.error("Failed to update calendar event:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update calendar event" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing event ID" }, { status: 400 });
  }

  try {
    const { deleted, google } = await deleteCalendarEvent(session.user.id, id);
    if (!deleted) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, google });
  } catch (err) {
    console.error("Failed to delete calendar event:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete calendar event" },
      { status: 500 },
    );
  }
}

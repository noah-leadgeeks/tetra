import { NextResponse } from "next/server";
import { z } from "zod";
import { todayKey } from "@/lib/time";
import {
  badRequest,
  errorResponse,
  firstIssueMessage,
  getAuthContext,
  parseJsonBody,
  unauthorized,
} from "@/features/activities/api";
import { manualEntrySchema } from "@/features/activities/entry-schemas";
import { createManualEntry, getDayEntries } from "@/features/activities/service";

const dayParamSchema = z.iso.date();

/** GET /api/time-entries?day=YYYY-MM-DD — entries for the user's day. */
export async function GET(request: Request) {
  const authCtx = await getAuthContext();
  if (!authCtx) return unauthorized();
  const dayParam =
    new URL(request.url).searchParams.get("day") ??
    todayKey(authCtx.timezone);
  const day = dayParamSchema.safeParse(dayParam);
  if (!day.success) return badRequest("Invalid day: expected YYYY-MM-DD");
  const entries = await getDayEntries(authCtx.userId, day.data, authCtx.timezone);
  return NextResponse.json(entries);
}

/** POST /api/time-entries — manual (backfilled) entry; 409 on overlap. */
export async function POST(request: Request) {
  const authCtx = await getAuthContext();
  if (!authCtx) return unauthorized();
  const parsed = manualEntrySchema.safeParse(await parseJsonBody(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  try {
    const entry = await createManualEntry(authCtx.userId, authCtx.timezone, {
      startedAt: new Date(parsed.data.startedAt),
      endedAt: new Date(parsed.data.endedAt),
      taskName: parsed.data.taskName,
      categoryId: parsed.data.categoryId,
      notes: parsed.data.notes,
    });
    return NextResponse.json(entry, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

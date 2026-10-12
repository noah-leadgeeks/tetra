import { NextResponse } from "next/server";
import {
  badRequest,
  errorResponse,
  firstIssueMessage,
  getAuthContext,
  parseJsonBody,
  unauthorized,
} from "@/features/activities/api";
import { startSchema } from "@/features/activities/entry-schemas";
import { startTimer } from "@/features/activities/service";

/** POST /api/time-entries/start — start a timer (auto-stops any running one). */
export async function POST(request: Request) {
  const authCtx = await getAuthContext();
  if (!authCtx) return unauthorized();
  const parsed = startSchema.safeParse(await parseJsonBody(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  try {
    const entry = await startTimer(authCtx.userId, authCtx.timezone, parsed.data);
    return NextResponse.json(entry);
  } catch (error) {
    return errorResponse(error);
  }
}

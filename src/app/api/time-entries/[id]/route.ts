import { NextResponse } from "next/server";
import { z } from "zod";
import {
  badRequest,
  errorResponse,
  firstIssueMessage,
  getAuthContext,
  parseJsonBody,
  unauthorized,
} from "@/features/activities/api";
import { entryPatchSchema as patchSchema } from "@/features/activities/entry-schemas";
import { deleteEntry, updateEntry } from "@/features/activities/service";

const idSchema = z.uuid();

/** PATCH /api/time-entries/:id — edit an entry; 409 on overlap. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authCtx = await getAuthContext();
  if (!authCtx) return unauthorized();
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return badRequest("Invalid entry id");
  const parsed = patchSchema.safeParse(await parseJsonBody(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  try {
    const entry = await updateEntry(authCtx.userId, id, {
      startedAt:
        parsed.data.startedAt !== undefined
          ? new Date(parsed.data.startedAt)
          : undefined,
      endedAt:
        parsed.data.endedAt !== undefined
          ? new Date(parsed.data.endedAt)
          : undefined,
      notes: parsed.data.notes,
      categoryId: parsed.data.categoryId,
      taskName: parsed.data.taskName,
    }, authCtx.timezone);
    return NextResponse.json(entry);
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/time-entries/:id — remove an entry. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authCtx = await getAuthContext();
  if (!authCtx) return unauthorized();
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return badRequest("Invalid entry id");
  try {
    await deleteEntry(authCtx.userId, id, authCtx.timezone);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

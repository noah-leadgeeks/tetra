import { NextResponse } from "next/server";
import { z } from "zod";
import { breakPatchSchema as patchSchema } from "@/features/attendance/break-schemas";
import { deleteBreak, updateBreak } from "@/features/attendance/service";
import { auth } from "@/server/auth";

const idSchema = z.uuid();

/** PATCH /api/breaks/:id — edit a break entry. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid break id" }, { status: 400 });
  }

  const raw = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: issue ? issue.message : "Invalid input" },
      { status: 400 },
    );
  }

  try {
    const breakItem = await updateBreak(
      session.user.id,
      id,
      session.user.timezone,
      {
        startedAt:
          parsed.data.startedAt !== undefined
            ? new Date(parsed.data.startedAt)
            : undefined,
        endedAt:
          parsed.data.endedAt !== undefined
            ? new Date(parsed.data.endedAt)
            : undefined,
      },
    );
    return NextResponse.json(breakItem);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not update break";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** DELETE /api/breaks/:id — remove a break entry. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid break id" }, { status: 400 });
  }

  try {
    await deleteBreak(session.user.id, id, session.user.timezone);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not delete break";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

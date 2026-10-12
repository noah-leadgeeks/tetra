import { NextResponse } from "next/server";

import {
  badRequest,
  getAuthContext,
  unauthorized,
} from "@/features/activities/api";
import { createTaskSchema } from "@/features/activities/task-schemas";
import { createTask, listAllTasks } from "@/features/activities/service";

/** GET /api/tasks — returns all tasks for user. */
export async function GET() {
  const authCtx = await getAuthContext();
  if (!authCtx) return unauthorized();

  try {
    const tasks = await listAllTasks(authCtx.userId);
    return NextResponse.json(tasks);
  } catch (err) {
    console.error("Failed to list tasks:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list tasks" },
      { status: 500 },
    );
  }
}

/** POST /api/tasks — create a new task. */
export async function POST(request: Request) {
  const authCtx = await getAuthContext();
  if (!authCtx) return unauthorized();

  try {
    const body = await request.json();
    const parsed = createTaskSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message || "Invalid payload");
    }

    const task = await createTask(authCtx.userId, parsed.data);
    return NextResponse.json(task, { status: 201 });
  } catch (err) {
    console.error("Failed to create task:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create task" },
      { status: 500 },
    );
  }
}

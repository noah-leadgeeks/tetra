import { agentDeleteHandler } from "@/features/agent-api/delete-route";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { updateTask } from "@/features/activities/entry-mutations";
import { agentUpdateTaskSchema } from "@/features/activities/task-schemas";
import { parseIdParam, withAgentAuth } from "@/features/agent-api/http";
import { toTaskItem } from "@/features/agent-api/read-models";
import { auditedWrite, optionalCategoryId, parseAgentBody } from "@/features/agent-api/writes";
import { dueDateKey } from "@/lib/task-dates";
import { dueAtFromDate } from "@/lib/zod-time";
import { db } from "@/server/db";
import { categories, tasks } from "@/server/db/schema";

/** GET /api/agent/tasks/[id] — user-scoped lookup; foreign or unknown ids are 404. */
export const GET = withAgentAuth<{ id: string }>("read", async (ctx, _req, params) => {
  const parsed = parseIdParam(params.id);
  if (!parsed.ok) return parsed.response;

  const [row] = await db
    .select({
      id: tasks.id,
      name: tasks.name,
      status: tasks.status,
      priority: tasks.priority,
      description: tasks.description,
      isFavorite: tasks.isFavorite,
      dueAt: tasks.dueAt,
      startedAt: tasks.startedAt,
      completedAt: tasks.completedAt,
      createdAt: tasks.createdAt,
      categoryId: tasks.categoryId,
      categoryKey: categories.key,
      categoryName: categories.name,
    })
    .from(tasks)
    .leftJoin(categories, eq(tasks.categoryId, categories.id))
    .where(and(eq(tasks.id, parsed.id), eq(tasks.userId, ctx.userId)))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  return NextResponse.json({
    task: {
      id: row.id,
      name: row.name,
      status: row.status,
      priority: row.priority,
      description: row.description,
      isFavorite: row.isFavorite,
      categoryId: row.categoryId,
      categoryKey: row.categoryKey,
      categoryName: row.categoryName,
      dueAt: row.dueAt?.toISOString() ?? null,
      dueDate: row.dueAt ? dueDateKey(row.dueAt.toISOString()) : null,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    },
  });
});

/**
 * PATCH /api/agent/tasks/[id] — update a task (user-scoped in `updateTask`;
 * foreign or unknown ids are 404). `dueDate: null` clears the due date. No sheet sync.
 */
export const PATCH = withAgentAuth<{ id: string }>("write", async (ctx, req, params) => {
  const parsed = parseIdParam(params.id);
  if (!parsed.ok) return parsed.response;
  const body = await parseAgentBody(req, agentUpdateTaskSchema);

  const task = await auditedWrite(
    ctx,
    { kind: "task.update", targetType: "task", targetId: parsed.id, summary: { request: body } },
    async () => {
      const { categoryKey, categoryId: rawCategoryId, dueDate, ...rest } = body;
      const categoryId = await optionalCategoryId({ categoryId: rawCategoryId, categoryKey });
      return updateTask(
        ctx.userId,
        parsed.id,
        {
          ...rest,
          categoryId,
          dueAt: dueDate === undefined ? undefined : dueDate ? new Date(dueAtFromDate(dueDate)) : null,
        },
        ctx.timezone,
      );
    },
  );
  return NextResponse.json({ task: toTaskItem(task) });
});

/** DELETE — registers a pending delete for in-app approval (202); never deletes directly. */
export const DELETE = agentDeleteHandler("task");

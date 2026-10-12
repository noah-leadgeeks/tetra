import { NextResponse } from "next/server";
import { createTask } from "@/features/activities/entry-mutations";
import { listAllTasks } from "@/features/activities/entry-queries";
import { agentCreateTaskSchema } from "@/features/activities/task-schemas";
import { resolveCategoryId, withAgentAuth } from "@/features/agent-api/http";
import { parseTaskListQuery, toTaskItem } from "@/features/agent-api/read-models";
import { auditedWrite, assertCategoryGiven, parseAgentBody } from "@/features/agent-api/writes";
import { filterTasks } from "@/lib/task-dates";
import { todayKey } from "@/lib/time";
import { dueAtFromDate } from "@/lib/zod-time";

/** GET /api/agent/tasks?filter=today|overdue|in_progress|upcoming|open|all&days=7&limit=50 */
export const GET = withAgentAuth("read", async (ctx, req) => {
  const { filter, days, limit } = parseTaskListQuery(new URL(req.url));
  const date = todayKey(ctx.timezone);
  const all = await listAllTasks(ctx.userId);
  const tasks = filterTasks(all, filter, date, days).slice(0, limit).map(toTaskItem);
  return NextResponse.json({ date, filter, tasks });
});

/**
 * POST /api/agent/tasks — create a task. Category by `categoryId` or
 * `categoryKey`; `dueDate` (YYYY-MM-DD) maps to the stored `dueAt`. No sheet sync.
 */
export const POST = withAgentAuth("write", async (ctx, req) => {
  const body = await parseAgentBody(req, agentCreateTaskSchema);
  assertCategoryGiven(body);
  const task = await auditedWrite(
    ctx,
    { kind: "task.create", targetType: "task", summary: { label: body.name, request: body } },
    async () => {
      const { categoryKey, categoryId: rawCategoryId, dueDate, ...rest } = body;
      const categoryId = await resolveCategoryId({ categoryId: rawCategoryId, categoryKey });
      return createTask(ctx.userId, {
        ...rest,
        categoryId,
        dueAt: dueDate ? new Date(dueAtFromDate(dueDate)) : null,
      });
    },
    (created) => ({ targetId: created.id }),
  );
  return NextResponse.json({ task: toTaskItem(task) }, { status: 201 });
});

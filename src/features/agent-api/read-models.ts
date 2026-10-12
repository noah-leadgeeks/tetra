/**
 * Compact response shapes and query-param parsers shared by the agent read
 * endpoints.
 */
import { z } from "zod";
import { BadRequestError } from "./errors";
import { dueDateKey, type TaskFilter } from "@/lib/task-dates";
import type { TaskDTO, TimeEntryDTO } from "@/lib/types";

export interface AgentTaskItem {
  id: string;
  name: string;
  status: TaskDTO["status"];
  priority: NonNullable<TaskDTO["priority"]>;
  categoryKey: string | null;
  dueDate: string | null;
  description: string | null;
}

export function toTaskItem(task: TaskDTO): AgentTaskItem {
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    priority: task.priority ?? "medium",
    categoryKey: task.categoryKey ?? null,
    dueDate: task.dueAt ? dueDateKey(task.dueAt) : null,
    description: task.description ?? null,
  };
}

export interface AgentEntryItem {
  id: string;
  taskId: string;
  taskName: string;
  categoryKey: string;
  startedAt: string;
  endedAt: string | null;
  status: TimeEntryDTO["status"];
  durationMinutes: number | null;
  notes: string | null;
}

export function toEntryItem(e: TimeEntryDTO): AgentEntryItem {
  return {
    id: e.id,
    taskId: e.taskId,
    taskName: e.taskName,
    categoryKey: e.categoryKey,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    status: e.status,
    durationMinutes: e.durationMinutes,
    notes: e.notes,
  };
}

const taskListQuerySchema = z.object({
  filter: z.enum(["today", "overdue", "in_progress", "upcoming", "open", "all"]).default("open"),
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function parseTaskListQuery(url: URL): { filter: TaskFilter; days: number; limit: number } {
  const get = (k: string) => url.searchParams.get(k) ?? undefined;
  return taskListQuerySchema.parse({ filter: get("filter"), days: get("days"), limit: get("limit") });
}

const instantSchema = z.iso.datetime({ offset: true });

/** Parses an optional ISO instant query param; throws ZodError (-> 400) when malformed. */
export function instantParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const parsed = instantSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestError(`Invalid ${name}, expected an ISO 8601 instant with offset`);
  return parsed.data;
}

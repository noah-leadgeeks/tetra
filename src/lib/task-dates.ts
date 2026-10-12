/**
 * Pure due-date helpers. Task due dates are written by the task dialog as
 * `${date}T23:59:59Z`, so they are compared by their date part only (never
 * converted to a zoned instant, which would shift them a day in UTC+ zones).
 */
import { addDaysISO } from "@/lib/time";
import type { TaskDTO, TaskPriority, TaskStatus } from "@/lib/types";

/** The YYYY-MM-DD part of a stored due date. */
export function dueDateKey(dueAt: string): string {
  return dueAt.slice(0, 10);
}

/** True when the due date is before today and the task is still open. */
export function isOverdue(
  dueAt: string | null | undefined,
  status: TaskStatus,
  todayKey: string,
): boolean {
  return Boolean(
    dueAt && status !== "done" && status !== "cancelled" && dueDateKey(dueAt) < todayKey,
  );
}

/** True when the due date is today (status-agnostic, as the Kanban card has always been). */
export function isDueToday(dueAt: string | null | undefined, todayKey: string): boolean {
  return Boolean(dueAt && dueDateKey(dueAt) === todayKey);
}

export type TaskFilter = "today" | "overdue" | "in_progress" | "upcoming" | "open" | "all";

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function isOpen(status: TaskStatus): boolean {
  return status !== "done" && status !== "cancelled";
}

function matchesFilter(
  task: TaskDTO,
  filter: TaskFilter,
  todayKey: string,
  upcomingDays: number,
): boolean {
  switch (filter) {
    case "today":
      return isDueToday(task.dueAt, todayKey);
    case "overdue":
      return isOverdue(task.dueAt, task.status, todayKey);
    case "in_progress":
      return task.status === "in_progress";
    case "upcoming": {
      if (!task.dueAt || !isOpen(task.status)) return false;
      const key = dueDateKey(task.dueAt);
      return key > todayKey && key <= addDaysISO(todayKey, upcomingDays);
    }
    case "open":
      return isOpen(task.status);
    case "all":
      return true;
  }
}

/** Filter tasks by due-date bucket/status, sorted by priority, due date, then name. */
export function filterTasks(
  tasks: TaskDTO[],
  filter: TaskFilter,
  todayKey: string,
  upcomingDays = 7,
): TaskDTO[] {
  return tasks
    .filter((t) => matchesFilter(t, filter, todayKey, upcomingDays))
    .sort((a, b) => {
      const pa = PRIORITY_RANK[a.priority ?? "medium"];
      const pb = PRIORITY_RANK[b.priority ?? "medium"];
      if (pa !== pb) return pa - pb;
      // Tasks without a due date sort after dated ones.
      const da = a.dueAt ? dueDateKey(a.dueAt) : "9999-99-99";
      const db = b.dueAt ? dueDateKey(b.dueAt) : "9999-99-99";
      if (da !== db) return da < db ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

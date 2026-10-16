"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  CheckSquare,
  Loader2,
  Play,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { dueDateKey, isOverdue } from "@/lib/task-dates";
import { TaskModalDialog } from "@/components/tasks/task-dialog";
import {
  DueDateBadge,
  FavoriteBadge,
  PriorityBadge,
} from "@/components/tasks/task-meta-badges";
import { todayKey, zonedDayKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { CategoryDTO, TaskDTO, TaskPriority } from "@/lib/types";

interface TodayTasksCardProps {
  timezone: string;
  onRefreshToday?: () => void;
  /** Bump to refetch tasks (e.g. after the active task was edited elsewhere). */
  refreshKey?: number;
  /** Task of the running or paused time entry; always pinned first in the focus list. */
  trackedTaskId?: string | null;
  /** Distinct task ids with a time entry today; these join the focus list. */
  workedTodayTaskIds?: string[];
  className?: string;
}

/** Max open rows in the focus list; further worked-today / due-today tasks fold into the footer. */
export const MAX_FOCUS_TASKS = 7;
/** Max "done today" rows; the rest collapse into a "+N more done today" line. */
export const MAX_DONE_ROWS = 3;

export interface TodaySummaryCounts {
  /** Open, non-cancelled, past-due tasks not shown as rows. */
  overdue: number;
  /** In-progress tasks not shown as rows and not already counted as overdue. */
  inProgress: number;
  /** Capped focus overflow that is neither overdue nor in progress. */
  other: number;
}

export interface TodayTasksGrouped {
  /** Open rows: tracked task, then worked on today, then due today (deduplicated, capped). */
  focusTasks: TaskDTO[];
  /** Done-today rows, newest first, capped at MAX_DONE_ROWS. */
  completedTodayTasks: TaskDTO[];
  /** Done-today tasks beyond the shown rows. */
  moreCompletedCount: number;
  /** Header denominator: shown open focus items + all tasks completed today. */
  totalCount: number;
  /** Header numerator: all tasks completed today. */
  completedCount: number;
  summary: TodaySummaryCounts;
}

function isOpenTask(t: TaskDTO): boolean {
  return t.status !== "done" && t.status !== "cancelled";
}

export function filterTodayTasks(
  tasks: TaskDTO[],
  timezone: string,
  todayStr: string,
  trackedTaskId?: string | null,
  workedTodayTaskIds: readonly string[] = [],
): TodayTasksGrouped {
  const candidates: TaskDTO[] = [];
  const seen = new Set<string>();
  const add = (t: TaskDTO) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    candidates.push(t);
  };

  const tracked = trackedTaskId
    ? tasks.find((t) => t.id === trackedTaskId && isOpenTask(t))
    : undefined;
  if (tracked) add(tracked);
  const workedToday = new Set(workedTodayTaskIds);
  for (const t of tasks) if (isOpenTask(t) && workedToday.has(t.id)) add(t);
  // Due dates are date-only (`...T23:59:59Z` from the task dialog): never zone-convert.
  for (const t of tasks) {
    if (isOpenTask(t) && t.dueAt && dueDateKey(t.dueAt) === todayStr) add(t);
  }

  const focusTasks = candidates.slice(0, MAX_FOCUS_TASKS);
  const shownIds = new Set(focusTasks.map((t) => t.id));
  const overflowIds = new Set(candidates.slice(MAX_FOCUS_TASKS).map((t) => t.id));

  const summary: TodaySummaryCounts = { overdue: 0, inProgress: 0, other: 0 };
  for (const t of tasks) {
    if (shownIds.has(t.id)) continue;
    // Overdue wins over in progress so a task is never counted twice.
    if (isOverdue(t.dueAt, t.status, todayStr)) summary.overdue += 1;
    else if (t.status === "in_progress") summary.inProgress += 1;
    else if (overflowIds.has(t.id)) summary.other += 1;
  }

  const completedAll = tasks
    .filter(
      (t) =>
        t.status === "done" &&
        t.completedAt &&
        zonedDayKey(new Date(t.completedAt), timezone) === todayStr,
    )
    .sort(
      (a, b) =>
        new Date(b.completedAt ?? 0).getTime() -
        new Date(a.completedAt ?? 0).getTime(),
    );

  return {
    focusTasks,
    completedTodayTasks: completedAll.slice(0, MAX_DONE_ROWS),
    moreCompletedCount: Math.max(0, completedAll.length - MAX_DONE_ROWS),
    totalCount: focusTasks.length + completedAll.length,
    completedCount: completedAll.length,
    summary,
  };
}

export function TodayTasksCard({
  timezone,
  onRefreshToday,
  refreshKey,
  trackedTaskId,
  workedTodayTaskIds,
  className,
}: TodayTasksCardProps) {
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionTaskId, setActionTaskId] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [openTask, setOpenTask] = useState<TaskDTO | null>(null);

  // New task form state
  const [newTaskName, setNewTaskName] = useState("");
  const [newCategoryId, setNewCategoryId] = useState("");
  const [newPriority, setNewPriority] = useState<TaskPriority>("medium");
  const [creating, setCreating] = useState(false);

  const todayStr = useMemo(() => todayKey(timezone), [timezone]);

  const refreshData = useCallback(async () => {
    try {
      const [tasksRes, catsRes] = await Promise.all([
        fetch("/api/tasks", { cache: "no-store" }),
        fetch("/api/categories", { cache: "no-store" }),
      ]);

      if (tasksRes.ok) {
        const data: TaskDTO[] = await tasksRes.json();
        setTasks(data);
      }
      if (catsRes.ok) {
        const catData: CategoryDTO[] = await catsRes.json();
        setCategories(catData);
      }
    } catch (err) {
      console.error("Failed to refresh today tasks:", err);
    }
  }, []);

  useEffect(() => {
    // refreshData only sets state after awaiting the fetches; refetch on parent request.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (refreshKey) void refreshData();
  }, [refreshKey, refreshData]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch("/api/tasks", { cache: "no-store" }).then((r) =>
        r.ok ? (r.json() as Promise<TaskDTO[]>) : [],
      ),
      fetch("/api/categories", { cache: "no-store" }).then((r) =>
        r.ok ? (r.json() as Promise<CategoryDTO[]>) : [],
      ),
    ])
      .then(([taskData, catData]) => {
        if (cancelled) return;
        setTasks(taskData);
        setCategories(catData);
        if (catData.length > 0) {
          setNewCategoryId((prev) => prev || catData[0]?.id || "");
        }
      })
      .catch((err) => {
        console.error("Failed to load today tasks:", err);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const {
    focusTasks,
    completedTodayTasks,
    moreCompletedCount,
    totalCount,
    completedCount,
    summary,
  } = useMemo(
    () =>
      filterTodayTasks(tasks, timezone, todayStr, trackedTaskId, workedTodayTaskIds),
    [tasks, timezone, todayStr, trackedTaskId, workedTodayTaskIds],
  );

  const hasSummary =
    summary.overdue + summary.inProgress + summary.other > 0;

  async function handleToggleDone(task: TaskDTO) {
    const isCompleted = task.status === "done";
    const newStatus = isCompleted ? "todo" : "done";
    setActionTaskId(task.id);

    // Optimistic local update
    setTasks((prev) =>
      prev.map((t) =>
        t.id === task.id
          ? {
              ...t,
              status: newStatus,
              completedAt: isCompleted ? null : new Date().toISOString(),
            }
          : t,
      ),
    );

    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!res.ok) {
        throw new Error("Failed to update status");
      }

      toast.success(
        isCompleted
          ? `Reopened "${task.name}"`
          : `Marked "${task.name}" as completed`,
      );
      void refreshData();
      onRefreshToday?.();
    } catch {
      toast.error("Failed to update task");
      void refreshData();
    } finally {
      setActionTaskId(null);
    }
  }

  async function handleStartTimer(task: TaskDTO) {
    setActionTaskId(task.id);
    try {
      const res = await fetch("/api/time-entries/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskName: task.name,
          categoryId: task.categoryId,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to start timer");
      }

      toast.success(`Tracking "${task.name}"`);
      void refreshData();
      onRefreshToday?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to start tracking",
      );
    } finally {
      setActionTaskId(null);
    }
  }

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTaskName.trim() || !newCategoryId) return;

    setCreating(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newTaskName.trim(),
          categoryId: newCategoryId,
          priority: newPriority,
          status: "todo",
          dueAt: `${todayStr}T23:59:59Z`,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to create task");
      }

      toast.success(`Task added for today: "${newTaskName.trim()}"`);
      setNewTaskName("");
      setAddDialogOpen(false);
      void refreshData();
      onRefreshToday?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create task",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card
      data-testid="today-tasks-card"
      className={cn("overflow-hidden border border-border/70 shadow-xs", className)}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CheckSquare className="size-4" />
          </div>
          <div>
            <h2 className="font-heading text-sm font-semibold tracking-tight text-foreground">
              Today&apos;s Focus
            </h2>
            <p className="text-xs text-muted-foreground">
              {totalCount === 0
                ? "No tasks scheduled for today"
                : `${completedCount} of ${totalCount} completed`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAddDialogOpen(true)}
            className="h-8 gap-1.5 text-xs font-medium"
          >
            <Plus className="size-3.5" />
            <span className="hidden sm:inline">Add Task</span>
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            asChild
            className="h-8 gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <Link href="/tasks" title="Go to Tasks Kanban">
              <span>Kanban</span>
              <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading today&apos;s tasks...
          </div>
        ) : totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 py-7 text-center">
            <CheckCircle2 className="size-7 text-muted-foreground/50 mb-2" />
            <p className="text-sm font-medium text-foreground">
              Nothing in focus today
            </p>
            <p className="text-xs text-muted-foreground max-w-xs mt-1">
              Start a timer or set a due date for today to pin a task here.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAddDialogOpen(true)}
              className="mt-4 h-8 gap-1.5 text-xs"
            >
              <Plus className="size-3.5" />
              Add Task for Today
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {focusTasks.map((task) => (
              <TaskRowItem
                key={task.id}
                task={task}
                isTracked={task.id === trackedTaskId}
                actionLoading={actionTaskId === task.id}
                onToggleDone={() => void handleToggleDone(task)}
                onStartTimer={() => void handleStartTimer(task)}
                onOpenTask={() => setOpenTask(task)}
                timezone={timezone}
              />
            ))}

            {completedTodayTasks.map((task) => (
              <TaskRowItem
                key={task.id}
                task={task}
                isTracked={false}
                actionLoading={actionTaskId === task.id}
                onToggleDone={() => void handleToggleDone(task)}
                onStartTimer={() => void handleStartTimer(task)}
                onOpenTask={() => setOpenTask(task)}
                timezone={timezone}
              />
            ))}

            {moreCompletedCount > 0 ? (
              <p
                data-testid="today-more-done"
                className="px-2 text-xs text-muted-foreground"
              >
                +{moreCompletedCount} more done today
              </p>
            ) : null}
          </div>
        )}

        {!loading && hasSummary ? (
          <div
            data-testid="today-focus-summary"
            className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/50 pt-3 text-xs text-muted-foreground"
          >
            {summary.overdue > 0 ? (
              <span className="inline-flex items-center gap-1 font-medium text-destructive">
                <AlertTriangle className="size-3 shrink-0" aria-hidden />
                {summary.overdue} overdue
              </span>
            ) : null}
            {summary.overdue > 0 && summary.inProgress > 0 ? (
              <span aria-hidden>·</span>
            ) : null}
            {summary.inProgress > 0 ? (
              <span>{summary.inProgress} more in progress</span>
            ) : null}
            {summary.overdue + summary.inProgress > 0 && summary.other > 0 ? (
              <span aria-hidden>·</span>
            ) : null}
            {summary.other > 0 ? <span>{summary.other} more</span> : null}
            <span aria-hidden>·</span>
            <Link
              href="/tasks"
              className="inline-flex min-h-10 items-center gap-1 font-medium text-foreground hover:underline sm:min-h-0"
            >
              View all
              <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>
        ) : null}
      </CardContent>

      <TaskModalDialog
        open={openTask !== null}
        onOpenChange={(o) => {
          if (!o) setOpenTask(null);
        }}
        task={openTask}
        defaultColumn="todo"
        categories={categories}
        existingTasks={tasks}
        onSaved={() => {
          setOpenTask(null);
          void refreshData();
          onRefreshToday?.();
        }}
        onDeleted={() => {
          setOpenTask(null);
          void refreshData();
          onRefreshToday?.();
        }}
      />

      {/* Add Task for Today Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-md max-h-[90vh] flex flex-col p-0 overflow-hidden">
          <form onSubmit={(e) => void handleCreateTask(e)} className="flex flex-col flex-1 min-h-0 overflow-hidden">
            <div className="px-6 pt-5 pb-3 shrink-0 border-b border-border/40">
              <DialogHeader>
                <DialogTitle>Add Task for Today</DialogTitle>
                <DialogDescription>
                  Create a task scheduled with today&apos;s due date to keep your day focused.
                </DialogDescription>
              </DialogHeader>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0">
              <div className="grid gap-2">
                <Label htmlFor="task-name">Task Name</Label>
                <Input
                  id="task-name"
                  placeholder="e.g. Prepare presentation, Fix login bug"
                  value={newTaskName}
                  onChange={(e) => setNewTaskName(e.target.value)}
                  autoFocus
                  required
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="category">Category</Label>
                <Select
                  value={newCategoryId}
                  onValueChange={setNewCategoryId}
                >
                  <SelectTrigger id="category">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((cat) => (
                      <SelectItem key={cat.id} value={cat.id}>
                        {cat.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="priority">Priority</Label>
                <Select
                  value={newPriority}
                  onValueChange={(v) => setNewPriority(v as TaskPriority)}
                >
                  <SelectTrigger id="priority">
                    <SelectValue placeholder="Priority" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="urgent">Urgent</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <DialogFooter className="px-6 py-3.5 border-t border-border/60 bg-muted/20 mt-auto shrink-0 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-10 px-4 text-xs"
                onClick={() => setAddDialogOpen(false)}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-10 px-5 text-xs"
                disabled={creating || !newTaskName.trim() || !newCategoryId}
              >
                {creating ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Plus className="mr-1.5 size-4" />
                )}
                Add to Today
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

interface TaskRowItemProps {
  task: TaskDTO;
  /** True for the task of the running or paused time entry. */
  isTracked: boolean;
  actionLoading: boolean;
  onToggleDone: () => void;
  onStartTimer: () => void;
  onOpenTask: () => void;
  timezone: string;
}

function TaskRowItem({
  task,
  isTracked,
  actionLoading,
  onToggleDone,
  onStartTimer,
  onOpenTask,
  timezone,
}: TaskRowItemProps) {
  const isDone = task.status === "done";
  const isInProgress = task.status === "in_progress" || isTracked;

  return (
    // Stretched-link row: the title button's ::after covers the row, controls sit above it (z-10).
    <div
      className={cn(
        "group relative flex min-h-11 items-center gap-1 rounded-lg border border-border/60 bg-card pr-1 pl-0.5 transition-colors hover:bg-muted/40",
        isDone && "bg-muted/20 border-border/40 opacity-75",
        isInProgress && "border-blue-500/40 bg-blue-50/30 dark:bg-blue-950/20",
      )}
    >
      {/* Tactile accessible checkbox; the button is the 40px touch target */}
      <button
        type="button"
        role="checkbox"
        aria-checked={isDone}
        aria-label={isDone ? `Mark "${task.name}" as incomplete` : `Mark "${task.name}" as complete`}
        onClick={onToggleDone}
        disabled={actionLoading}
        className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:size-9"
      >
        <span
          className={cn(
            "flex size-5 items-center justify-center rounded border transition-all group-active:scale-95",
            isDone
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/40 hover:border-primary",
          )}
        >
          {isDone ? <Check className="size-3.5 stroke-[2.5]" /> : null}
        </span>
      </button>

      <button
        type="button"
        data-testid="today-task-open"
        onClick={onOpenTask}
        title={`Open "${task.name}"`}
        className={cn(
          "min-w-0 flex-1 cursor-pointer truncate rounded-sm py-2 text-left text-sm font-medium leading-snug after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          isDone ? "line-through text-muted-foreground" : "text-foreground",
        )}
      >
        {task.name}
      </button>

      <div className="flex shrink-0 items-center gap-1.5">
        <span className="hidden sm:inline-flex">
          <PriorityBadge priority={task.priority ?? "medium"} />
        </span>
        {isDone ? null : (
          <span className="whitespace-nowrap">
            <DueDateBadge dueAt={task.dueAt} status={task.status} timezone={timezone} />
          </span>
        )}
        <FavoriteBadge isFavorite={task.isFavorite} />
      </div>

      {!isDone ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={actionLoading}
          onClick={onStartTimer}
          className={cn(
            "relative z-10 size-10 shrink-0 transition-all active:scale-95 sm:size-9",
            isInProgress && "bg-blue-500/15 text-blue-700 dark:text-blue-300",
          )}
          title={isInProgress ? "Timer already active" : `Start tracking "${task.name}"`}
          aria-label={isInProgress ? `Tracking "${task.name}"` : `Start tracking "${task.name}"`}
        >
          {actionLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4 fill-current" />
          )}
        </Button>
      ) : null}
    </div>
  );
}

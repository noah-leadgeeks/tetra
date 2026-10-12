"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  CheckSquare,
  Clock,
  Loader2,
  Play,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CategoryBadge } from "@/components/ui/category-badge";
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
import { dueDateKey } from "@/lib/task-dates";
import { TaskModalDialog } from "@/components/tasks/task-dialog";
import {
  DueDateBadge,
  FavoriteBadge,
  PRIORITY_BADGES,
} from "@/components/tasks/task-meta-badges";
import { TaskNotes } from "@/components/tasks/task-notes";
import { todayKey, zonedDayKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { CategoryDTO, TaskDTO, TaskPriority } from "@/lib/types";

interface TodayTasksCardProps {
  timezone: string;
  onRefreshToday?: () => void;
  /** Bump to refetch tasks (e.g. after the active task was edited elsewhere). */
  refreshKey?: number;
  className?: string;
}

export interface TodayTasksGrouped {
  inProgressTasks: TaskDTO[];
  overdueTasks: TaskDTO[];
  dueTodayTasks: TaskDTO[];
  completedTodayTasks: TaskDTO[];
  allTodayTasks: TaskDTO[];
}

export function filterTodayTasks(
  tasks: TaskDTO[],
  timezone: string,
  todayStr: string,
): TodayTasksGrouped {
  const inProgressTasks: TaskDTO[] = [];
  const overdueTasks: TaskDTO[] = [];
  const dueTodayTasks: TaskDTO[] = [];
  const completedTodayTasks: TaskDTO[] = [];
  const allTodayTasks: TaskDTO[] = [];

  for (const t of tasks) {
    let isToday = false;
    // Due dates are date-only (`...T23:59:59Z` from the task dialog): never zone-convert.
    const dueDay = t.dueAt ? dueDateKey(t.dueAt) : null;
    const completedDay = t.completedAt
      ? zonedDayKey(new Date(t.completedAt), timezone)
      : null;

    if (t.status === "done") {
      if (completedDay === todayStr) {
        completedTodayTasks.push(t);
        isToday = true;
      }
    } else if (t.status === "in_progress") {
      inProgressTasks.push(t);
      isToday = true;
    } else {
      if (dueDay === todayStr) {
        dueTodayTasks.push(t);
        isToday = true;
      } else if (dueDay && dueDay < todayStr && t.status !== "cancelled") {
        overdueTasks.push(t);
        isToday = true;
      }
    }

    if (isToday) {
      allTodayTasks.push(t);
    }
  }

  return {
    inProgressTasks,
    overdueTasks,
    dueTodayTasks,
    completedTodayTasks,
    allTodayTasks,
  };
}

export function TodayTasksCard({
  timezone,
  onRefreshToday,
  refreshKey,
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
    inProgressTasks,
    overdueTasks,
    dueTodayTasks,
    completedTodayTasks,
    allTodayTasks,
  } = useMemo(
    () => filterTodayTasks(tasks, timezone, todayStr),
    [tasks, timezone, todayStr],
  );

  const totalCount = allTodayTasks.length;
  const completedCount = completedTodayTasks.length;

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
        ) : allTodayTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 py-7 text-center">
            <CheckCircle2 className="size-7 text-muted-foreground/50 mb-2" />
            <p className="text-sm font-medium text-foreground">
              All caught up for today!
            </p>
            <p className="text-xs text-muted-foreground max-w-xs mt-1">
              No tasks currently in progress or due today. Add a task or pull one from your Kanban backlog.
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
          <div className="flex flex-col gap-2">
            {/* 1. In Progress Tasks */}
            {inProgressTasks.map((task) => (
              <TaskRowItem
                key={task.id}
                task={task}
                badgeLabel="In Progress"
                badgeClass="border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                actionLoading={actionTaskId === task.id}
                onToggleDone={() => void handleToggleDone(task)}
                onStartTimer={() => void handleStartTimer(task)}
                onOpenTask={() => setOpenTask(task)}
                timezone={timezone}
              />
            ))}

            {/* 2. Overdue Tasks */}
            {overdueTasks.map((task) => (
              <TaskRowItem
                key={task.id}
                task={task}
                badgeLabel="Overdue"
                badgeIcon={<AlertCircle className="size-3" />}
                badgeClass="border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
                actionLoading={actionTaskId === task.id}
                onToggleDone={() => void handleToggleDone(task)}
                onStartTimer={() => void handleStartTimer(task)}
                onOpenTask={() => setOpenTask(task)}
                timezone={timezone}
              />
            ))}

            {/* 3. Due Today Tasks */}
            {dueTodayTasks.map((task) => (
              <TaskRowItem
                key={task.id}
                task={task}
                badgeLabel="Due Today"
                badgeIcon={<Clock className="size-3" />}
                badgeClass="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                actionLoading={actionTaskId === task.id}
                onToggleDone={() => void handleToggleDone(task)}
                onStartTimer={() => void handleStartTimer(task)}
                onOpenTask={() => setOpenTask(task)}
                timezone={timezone}
              />
            ))}

            {/* 4. Completed Today Tasks */}
            {completedTodayTasks.map((task) => (
              <TaskRowItem
                key={task.id}
                task={task}
                badgeLabel="Completed"
                badgeClass="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                actionLoading={actionTaskId === task.id}
                onToggleDone={() => void handleToggleDone(task)}
                onStartTimer={() => void handleStartTimer(task)}
                onOpenTask={() => setOpenTask(task)}
                timezone={timezone}
              />
            ))}
          </div>
        )}
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
  badgeLabel: string;
  badgeIcon?: React.ReactNode;
  badgeClass: string;
  actionLoading: boolean;
  onToggleDone: () => void;
  onStartTimer: () => void;
  onOpenTask: () => void;
  timezone: string;
}

function TaskRowItem({
  task,
  badgeLabel,
  badgeIcon,
  badgeClass,
  actionLoading,
  onToggleDone,
  onStartTimer,
  onOpenTask,
  timezone,
}: TaskRowItemProps) {
  const isDone = task.status === "done";
  const isInProgress = task.status === "in_progress";
  const priority = task.priority ?? "medium";
  const priorityInfo = PRIORITY_BADGES[priority] ?? PRIORITY_BADGES.medium;

  return (
    <div
      className={cn(
        "group flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card p-3 transition-colors hover:bg-muted/40",
        isDone && "bg-muted/20 border-border/40 opacity-75",
        isInProgress && "border-blue-500/40 bg-blue-50/30 dark:bg-blue-950/20",
      )}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {/* Tactile accessible checkbox */}
        <button
          type="button"
          role="checkbox"
          aria-checked={isDone}
          aria-label={isDone ? `Mark "${task.name}" as incomplete` : `Mark "${task.name}" as complete`}
          onClick={onToggleDone}
          disabled={actionLoading}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded border transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:scale-95",
            isDone
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/40 hover:border-primary hover:bg-muted/30",
          )}
        >
          {isDone ? <Check className="size-3.5 stroke-[2.5]" /> : null}
        </button>

        {/* Task name and metadata */}
        <div className="flex flex-col min-w-0 flex-1">
          <button
            type="button"
            data-testid="today-task-open"
            onClick={onOpenTask}
            title={`Open "${task.name}"`}
            className={cn(
              "text-left text-sm font-medium leading-snug truncate hover:underline cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
              isDone ? "line-through text-muted-foreground" : "text-foreground",
            )}
          >
            {task.name}
          </button>
          <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[11px]">
            {task.categoryName ? (
              <CategoryBadge
                categoryName={task.categoryName}
                categoryKey={task.categoryKey}
                className="text-[10px] px-1.5 py-0"
              />
            ) : null}

            {task.priority !== "medium" ? (
              <span
                className={cn(
                  "inline-flex items-center rounded-sm px-1.5 py-0 border",
                  priorityInfo.class,
                )}
              >
                {priorityInfo.label}
              </span>
            ) : null}

            <DueDateBadge dueAt={task.dueAt} status={task.status} timezone={timezone} />
            <FavoriteBadge isFavorite={task.isFavorite} />

            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-sm px-1.5 py-0 border",
                badgeClass,
              )}
            >
              {badgeIcon}
              {badgeLabel}
            </span>
          </div>
          {task.description ? (
            <TaskNotes
              variant="clamp"
              clampLines={1}
              text={task.description}
              onOpen={onOpenTask}
              className="mt-1.5"
            />
          ) : null}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1 shrink-0">
        {!isDone ? (
          <Button
            type="button"
            variant={isInProgress ? "secondary" : "outline"}
            size="sm"
            disabled={actionLoading}
            onClick={onStartTimer}
            className={cn(
              "h-7 px-2.5 gap-1 text-xs font-medium transition-all active:scale-98",
              isInProgress &&
                "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
            )}
            title={isInProgress ? "Timer already active" : `Start tracking "${task.name}"`}
          >
            {actionLoading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Play className="size-3 fill-current" />
            )}
            <span className="hidden sm:inline">
              {isInProgress ? "Tracking" : "Start"}
            </span>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

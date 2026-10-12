"use client";

import {
  AlertTriangle,
  Calendar,
  Flame,
  MoreVertical,
  Pencil,
  Play,
  Star,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CategoryBadge } from "@/components/ui/category-badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isDueToday, isOverdue, dueDateKey } from "@/lib/task-dates";
import { PRIORITY_CONFIG, type CardDensity } from "@/components/tasks/task-constants";
import { getCategoryTheme } from "@/lib/categories";
import type { TaskDTO, TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

interface TaskCardProps {
  task: TaskDTO;
  columnId: TaskStatus;
  favoriteTestId: string;
  cardDensity: CardDensity;
  categoryNames: Record<string, string>;
  currentTodayKey: string;
  startingId: string | null;
  handleDragStart: (e: React.DragEvent, taskId: string) => void;
  handleToggleFavorite: (task: TaskDTO) => Promise<void>;
  handleStart: (task: TaskDTO) => Promise<void>;
  handleOpenEdit: (task: TaskDTO) => void;
  handleDeleteTask: (taskId: string) => Promise<void>;
  handleMoveStatus: (taskId: string, newStatus: TaskStatus) => Promise<void>;
}

export function TaskCard({
  task,
  columnId,
  favoriteTestId,
  cardDensity,
  categoryNames,
  currentTodayKey,
  startingId,
  handleDragStart,
  handleToggleFavorite,
  handleStart,
  handleOpenEdit,
  handleDeleteTask,
  handleMoveStatus,
}: TaskCardProps) {
  const categoryName = categoryNames[task.categoryId] ?? "Uncategorized";
  const theme = getCategoryTheme(categoryName);
  const priorityInfo = PRIORITY_CONFIG[task.priority || "medium"];

  // Check due status
  const overdue = isOverdue(task.dueAt, task.status, currentTodayKey);
  const dueToday = isDueToday(task.dueAt, currentTodayKey);

  // Compact Mode
  if (cardDensity === "compact") {
    return (
      <div
        draggable
        onDragStart={(e) => handleDragStart(e, task.id)}
        className={cn(
          "group flex items-center justify-between gap-1.5 rounded-lg border border-border/70 bg-card px-2.5 py-1.5 shadow-2xs hover:shadow-xs hover:border-border transition-all cursor-grab active:cursor-grabbing select-none relative",
          theme.borderClass,
          "border-l-4",
          task.isFavorite && "bg-amber-500/[0.02]",
        )}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span
            className={cn("size-2 rounded-full shrink-0", theme.dotClass)}
            title={categoryName}
          />
          <h4 className="text-xs font-medium text-foreground truncate" title={task.name}>
            {task.name}
          </h4>
          {overdue && (
            <span className="text-[10px] text-destructive font-semibold shrink-0">!</span>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => void handleToggleFavorite(task)}
            className="p-1 rounded-md text-muted-foreground hover:text-amber-500 transition-colors"
            title="Toggle favorite"
            data-testid={favoriteTestId}
            aria-label={`Toggle favorite for ${task.name}`}
            aria-pressed={task.isFavorite}
          >
            <Star
              className={cn(
                "size-3 transition-colors",
                task.isFavorite
                  ? "fill-amber-500 text-amber-500"
                  : "text-muted-foreground hover:text-amber-500",
              )}
            />
          </button>

          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => void handleStart(task)}
            disabled={startingId !== null}
            className="size-5 text-primary hover:text-primary hover:bg-primary/10 rounded"
            title="Start timer"
          >
            <Play className="size-2.5 fill-primary text-primary" />
          </Button>

          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
              >
                <MoreVertical className="size-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" className="w-36 p-1 text-xs">
              <button
                type="button"
                onClick={() => handleOpenEdit(task)}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left hover:bg-muted transition-colors text-foreground"
              >
                <Pencil className="size-3 text-muted-foreground" />
                <span>Edit Task</span>
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteTask(task.id)}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left hover:bg-destructive/10 text-destructive transition-colors"
              >
                <Trash2 className="size-3 text-destructive" />
                <span>Delete</span>
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    );
  }

  // Comfortable Mode (Default)
  return (
    <div
      draggable
      onDragStart={(e) => handleDragStart(e, task.id)}
      className={cn(
        "group rounded-xl border border-border/70 bg-card p-3 shadow-2xs hover:shadow-xs hover:border-border transition-all cursor-grab active:cursor-grabbing select-none relative space-y-2 min-w-0",
        theme.borderClass,
        "border-l-4",
        task.isFavorite && "bg-amber-500/[0.015]",
      )}
    >
      {/* Card Top: Category, Priority, Star, Menu */}
      <div className="flex items-center justify-between gap-1.5 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
          <CategoryBadge
            categoryName={categoryName}
            size="sm"
            showIcon={false}
            className="max-w-[115px] sm:max-w-[130px] truncate text-[10px] px-2 py-0.5"
          />
          {task.priority && task.priority !== "medium" && (
            <Badge
              variant="outline"
              className={cn("text-[9px] px-1 py-0 shrink-0", priorityInfo.badgeClass)}
            >
              {task.priority === "urgent" && <Flame className="size-2.5 mr-0.5 inline shrink-0" />}
              <span className="truncate">{priorityInfo.label}</span>
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0 ml-1">
          <button
            type="button"
            onClick={() => void handleToggleFavorite(task)}
            className="p-1 rounded-md text-muted-foreground hover:text-amber-500 transition-colors shrink-0"
            title="Toggle favorite"
            data-testid={favoriteTestId}
            aria-label={`Toggle favorite for ${task.name}`}
            aria-pressed={task.isFavorite}
          >
            <Star
              className={cn(
                "size-3.5 transition-colors",
                task.isFavorite
                  ? "fill-amber-500 text-amber-500"
                  : "text-muted-foreground hover:text-amber-500",
              )}
            />
          </button>

          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                <MoreVertical className="size-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" className="w-36 p-1 text-xs">
              <button
                type="button"
                onClick={() => handleOpenEdit(task)}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left hover:bg-muted transition-colors text-foreground"
              >
                <Pencil className="size-3 text-muted-foreground shrink-0" />
                <span>Edit Task</span>
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteTask(task.id)}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left hover:bg-destructive/10 text-destructive transition-colors"
              >
                <Trash2 className="size-3 text-destructive shrink-0" />
                <span>Delete</span>
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Card Title & Description */}
      <div className="min-w-0">
        <h4 className="text-xs font-semibold text-foreground leading-snug break-words" title={task.name}>
          {task.name}
        </h4>
        {task.description && (
          <div className="mt-2 rounded-md bg-muted/40 border border-border/40 px-2 py-1.5 text-[11px] text-foreground/85 leading-relaxed font-normal break-words line-clamp-3">
            {task.description}
          </div>
        )}
      </div>

      {/* Due Date / Overdue Indicator */}
      {task.dueAt && (
        <div className="flex items-center gap-1 text-[10px] min-w-0">
          {overdue ? (
            <span className="flex items-center gap-1 text-destructive font-medium truncate">
              <AlertTriangle className="size-2.5 shrink-0" />
              <span>Overdue ({dueDateKey(task.dueAt).slice(5)})</span>
            </span>
          ) : dueToday ? (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium truncate">
              <Calendar className="size-2.5 shrink-0" />
              <span>Due today</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-muted-foreground truncate">
              <Calendar className="size-2.5 shrink-0" />
              <span>Due {dueDateKey(task.dueAt).slice(5)}</span>
            </span>
          )}
        </div>
      )}

      {/* Card Footer: Start & Quick Move Controls */}
      <div className="pt-2 border-t border-border/40 flex items-center justify-between gap-1 min-w-0">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void handleStart(task)}
          disabled={startingId !== null}
          className="h-6 text-[11px] px-2 gap-1 text-primary hover:text-primary font-medium border-primary/30 hover:bg-primary/10 shrink-0"
        >
          <Play className="size-2.5 fill-primary text-primary" />
          {startingId === task.id ? "…" : "Start"}
        </Button>

        {/* Quick Status Mover Pills */}
        <div className="flex items-center gap-1 shrink-0">
          {columnId === "backlog" && (
            <button
              type="button"
              onClick={() => void handleMoveStatus(task.id, "todo")}
              className="text-[9px] px-1.5 py-0.5 rounded border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
              title="Move to To Do"
            >
              To Do
            </button>
          )}
          {columnId !== "in_progress" && columnId !== "done" && (
            <button
              type="button"
              onClick={() => void handleMoveStatus(task.id, "in_progress")}
              className="text-[9px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-colors shrink-0"
              title="Move to In Progress"
            >
              Doing
            </button>
          )}
          {columnId === "in_progress" && (
            <>
              <button
                type="button"
                onClick={() => void handleMoveStatus(task.id, "blocked")}
                className="text-[9px] px-1.5 py-0.5 rounded border border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300 hover:bg-rose-500/20 transition-colors shrink-0"
                title="Mark Blocked"
              >
                Block
              </button>
              <button
                type="button"
                onClick={() => void handleMoveStatus(task.id, "done")}
                className="text-[9px] px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 transition-colors shrink-0"
                title="Mark Done"
              >
                Done
              </button>
            </>
          )}
          {columnId === "blocked" && (
            <button
              type="button"
              onClick={() => void handleMoveStatus(task.id, "in_progress")}
              className="text-[9px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-colors shrink-0"
              title="Resume task"
            >
              Resume
            </button>
          )}
          {columnId === "todo" && (
            <button
              type="button"
              onClick={() => void handleMoveStatus(task.id, "done")}
              className="text-[9px] px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 transition-colors shrink-0"
              title="Mark Done"
            >
              Done
            </button>
          )}
          {columnId === "done" && (
            <button
              type="button"
              onClick={() => void handleMoveStatus(task.id, "todo")}
              className="text-[9px] px-1.5 py-0.5 rounded border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
              title="Reopen task"
            >
              Reopen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

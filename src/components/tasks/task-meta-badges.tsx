"use client";

import { AlertTriangle, Calendar, Star } from "lucide-react";

import { dueDateKey, isDueToday, isOverdue } from "@/lib/task-dates";
import { todayKey } from "@/lib/time";
import type { EntryTaskDetailsDTO, TaskPriority, TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export const PRIORITY_BADGES: Record<TaskPriority, { label: string; class: string }> = {
  urgent: {
    label: "Urgent",
    class: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 font-medium",
  },
  high: {
    label: "High",
    class: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium",
  },
  medium: {
    label: "Medium",
    class: "border-border/60 bg-muted/30 text-muted-foreground",
  },
  low: {
    label: "Low",
    class: "border-border/40 bg-muted/20 text-muted-foreground/80",
  },
};

/** Status chips are shown only for these statuses. */
export const STATUS_CHIPS: Partial<Record<TaskStatus, { label: string; class: string }>> = {
  blocked: {
    label: "Blocked",
    class: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
  review: {
    label: "Review",
    class: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  done: {
    label: "Done",
    class: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
};

export type DueTone = "overdue" | "today" | "upcoming";

/** Label and tone for a due date; mirrors the Kanban card wording. */
export function dueBadgeInfo(
  dueAt: string,
  status: TaskStatus,
  today: string,
): { label: string; tone: DueTone } {
  if (isOverdue(dueAt, status, today)) {
    return { label: `Overdue (${dueDateKey(dueAt).slice(5)})`, tone: "overdue" };
  }
  if (isDueToday(dueAt, today)) return { label: "Due today", tone: "today" };
  return { label: `Due ${dueDateKey(dueAt).slice(5)}`, tone: "upcoming" };
}

const BADGE_BASE = "inline-flex items-center gap-1 rounded-sm px-1.5 py-0 border text-[11px]";

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  if (priority === "medium") return null;
  const info = PRIORITY_BADGES[priority];
  return (
    <span data-testid="task-priority-badge" className={cn(BADGE_BASE, info.class)}>
      {info.label}
    </span>
  );
}

export function DueDateBadge({
  dueAt,
  status,
  timezone,
}: {
  dueAt: string | null | undefined;
  status: TaskStatus;
  timezone: string;
}) {
  if (!dueAt) return null;
  const { label, tone } = dueBadgeInfo(dueAt, status, todayKey(timezone));
  return (
    <span
      data-testid="task-due-badge"
      className={cn(
        "inline-flex items-center gap-1 text-[11px] font-medium",
        tone === "overdue" && "text-destructive",
        tone === "today" && "text-amber-600 dark:text-amber-400",
        tone === "upcoming" && "text-muted-foreground",
      )}
    >
      {tone === "overdue" ? (
        <AlertTriangle className="size-3 shrink-0" aria-hidden />
      ) : (
        <Calendar className="size-3 shrink-0" aria-hidden />
      )}
      <span>{label}</span>
    </span>
  );
}

export function FavoriteBadge({ isFavorite }: { isFavorite: boolean }) {
  if (!isFavorite) return null;
  return (
    <span data-testid="task-favorite-badge" title="Favorite" className="inline-flex">
      <Star className="size-3 fill-amber-500 text-amber-500" aria-label="Favorite task" />
    </span>
  );
}

export function TaskMetaBadges({
  details,
  timezone,
  className,
}: {
  details: EntryTaskDetailsDTO | undefined;
  timezone: string;
  className?: string;
}) {
  if (!details) return null;
  const chip = STATUS_CHIPS[details.status];
  const hasAny =
    details.priority !== "medium" || details.dueAt || details.isFavorite || chip;
  if (!hasAny) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <PriorityBadge priority={details.priority} />
      <DueDateBadge dueAt={details.dueAt} status={details.status} timezone={timezone} />
      <FavoriteBadge isFavorite={details.isFavorite} />
      {chip ? (
        <span data-testid="task-status-badge" className={cn(BADGE_BASE, chip.class)}>
          {chip.label}
        </span>
      ) : null}
    </div>
  );
}

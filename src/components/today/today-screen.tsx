"use client";

import { useMemo, useState } from "react";
import { Coffee, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ActiveTaskCard } from "@/components/today/active-task-card";
import { EntryTaskDialog } from "@/components/tasks/entry-task-dialog";
import { EmptyStateCard } from "@/components/today/empty-state-card";
import { StartTaskDialog } from "@/components/today/start-task-dialog";
import { TodayOverviewPanel } from "@/components/today/today-overview-panel";
import { TodayTasksCard } from "@/components/today/today-tasks-card";
import { CalendarScheduleCard } from "@/components/calendar/calendar-schedule-card";
import { QuickStart } from "@/components/today/quick-start";
import { StickyTaskBar } from "@/components/today/sticky-task-bar";
import { StopTaskConfirmDialog } from "@/components/today/stop-task-confirm-dialog";
import { StopWorkConfirmDialog } from "@/components/today/stop-work-confirm-dialog";
import { SwitchTaskDialog } from "@/components/today/switch-task-dialog";
import { useTodayGuards } from "@/components/today/use-today-guards";
import { useTodayShortcuts } from "@/components/today/use-today-shortcuts";
import { useTodayState } from "@/components/today/use-today-state";
import { useOutOfView } from "@/components/today/use-out-of-view";
import { useTour } from "@/components/guide-tour/tour-provider";
import { cn } from "@/lib/utils";
import { zonedClock } from "@/lib/time";
import type { TimeEntryDTO } from "@/lib/types";

interface TodayScreenProps {
  timezone: string;
  /** Server timestamp — the client timer starts from server truth. */
  nowIso: string;
}

type StatusTone = "working" | "paused" | "break" | "off";

const STATUS_STYLES: Record<StatusTone, { label: string; dot: string }> = {
  working: { label: "Working", dot: "bg-emerald-500" },
  paused: { label: "Paused", dot: "bg-amber-500" },
  break: { label: "On Break", dot: "bg-sky-500" },
  off: { label: "Not clocked in", dot: "bg-muted-foreground/40" },
};

/**
 * Today screen (DESIGN.md): date, status, the active task with a live timer
 * as the visual focus, calm totals, and the work-day controls.
 */
export function TodayScreen({ timezone, nowIso }: TodayScreenProps) {
  const initialNowMs = useMemo(() => Date.parse(nowIso), [nowIso]);

  const {
    summary,
    categories,
    loadState,
    pending,
    refresh,
    clockIn,
    clockOut,
    startBreak,
    endBreak,
    startTask,
    stopTask,
    pauseTask,
    resumeTask,
  } = useTodayState(timezone);
  const { openTour } = useTour();
  // Sticky bar shows only once the active card has scrolled under the 56px header.
  const [activeCardRef, activeCardOutOfView] = useOutOfView({
    rootMargin: "-56px 0px 0px 0px",
  });

  const [taskDialogEntry, setTaskDialogEntry] = useState<TimeEntryDTO | null>(null);
  const [tasksRefreshKey, setTasksRefreshKey] = useState(0);
  const [logActivityOpen, setLogActivityOpen] = useState(false);
  const [switchTaskOpen, setSwitchTaskOpen] = useState(false);
  const [stopWorkConfirmOpen, setStopWorkConfirmOpen] = useState(false);
  const [stopTaskConfirmOpen, setStopTaskConfirmOpen] = useState(false);

  const attendance = summary?.attendance ?? null;
  const isWorking = attendance?.status === "open";
  const onBreak = attendance?.activeBreak != null;

  const activeEntry = useMemo<TimeEntryDTO | null>(() => {
    const entries = summary?.timeEntries ?? [];
    return (
      entries.find(
        (entry) => entry.status === "active" || entry.status === "paused",
      ) ?? null
    );
  }, [summary]);

  // Distinct tasks with a time entry today; they join Today's Focus.
  const workedTodayTaskIds = useMemo(
    () => [...new Set((summary?.timeEntries ?? []).map((entry) => entry.taskId))],
    [summary],
  );

  useTodayGuards({ activeEntry, isWorking, onBreak, attendance });

  const status: StatusTone = !isWorking
    ? "off"
    : onBreak
      ? "break"
      : activeEntry?.status === "paused"
        ? "paused"
        : "working";

  /**
   * "End Break & Resume" path: one click ends the break and resumes the
   * paused task. Paused here means the task was paused before the break —
   * the natural flow when stepping away.
   */
  const breakResumeTarget =
    onBreak && activeEntry?.status === "paused" ? activeEntry : null;

  async function handleEndBreak() {
    if (await endBreak()) {
      if (breakResumeTarget) await resumeTask();
    }
  }

  const dateLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: timezone,
      }).format(new Date(initialNowMs)),
    [timezone, initialNowMs],
  );

  const busy = pending !== null;
  const showSkeleton = loadState === "loading" && summary === null;
  const showError = loadState === "error" && summary === null;

  useTodayShortcuts({
    attendanceOpen: isWorking,
    canClockIn: attendance === null,
    hasActiveEntry: activeEntry !== null,
    isRunning: activeEntry?.status === "active",
    isPaused: activeEntry?.status === "paused",
    onBreak,
    busy,
    clockIn,
    openLogActivity: () => setLogActivityOpen(true),
    toggleBreak: () => void (onBreak ? handleEndBreak() : startBreak()),
    togglePauseResume: () =>
      void (activeEntry?.status === "paused" ? resumeTask() : pauseTask()),
  });

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {dateLabel}
          </h1>
          <p className="flex items-center gap-2.5 text-sm font-medium mt-1">
            <span
              aria-hidden
              className={cn(
                "inline-block size-2.5 shrink-0 rounded-full transition-all",
                STATUS_STYLES[status].dot,
                status === "working" && "animate-pulse ring-4 ring-emerald-500/20",
                status === "paused" && "ring-4 ring-amber-500/20",
                status === "break" && "ring-4 ring-sky-500/20",
              )}
            />
            {STATUS_STYLES[status].label}
          </p>
        </div>
      </header>

      {showSkeleton ? <LoadingCard /> : null}

      {showError ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-4">
            <div className="flex flex-col gap-1.5">
              <p className="text-base font-medium">Couldn&apos;t load today</p>
              <p className="text-sm text-muted-foreground">
                Check your connection, then try again.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => void refresh()}
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {!showSkeleton && !showError ? (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left Column: Active Task / Empty State + Actions + Quick Start */}
            <div className="lg:col-span-7 flex flex-col gap-6">
              <div data-tour="today-hero" className="flex flex-col gap-6">
                {activeEntry ? (
                  <div ref={activeCardRef}>
                    <ActiveTaskCard
                      key={activeEntry.id}
                      entry={activeEntry}
                      initialNowMs={initialNowMs}
                      timezone={timezone}
                      busy={busy}
                      pending={pending}
                      onPauseTask={pauseTask}
                      onResumeTask={resumeTask}
                      onStopTask={() => setStopTaskConfirmOpen(true)}
                      onSwitchTask={() => setSwitchTaskOpen(true)}
                      onOpenTask={() => setTaskDialogEntry(activeEntry)}
                    />
                  </div>
                ) : (
                  <EmptyStateCard
                    mode={
                      attendance === null
                        ? "not-clocked-in"
                        : attendance.status === "closed"
                          ? "done"
                          : "no-task"
                    }
                    clockOutLabel={
                      attendance?.clockOutAt
                        ? zonedClock(new Date(attendance.clockOutAt), timezone)
                        : null
                    }
                    busy={busy}
                    clockInPending={pending === "clock-in"}
                    onClockIn={() => void clockIn()}
                    onLogActivity={() => setLogActivityOpen(true)}
                    onOpenTour={openTour}
                  />
                )}

                {/* Day-level actions: one quiet row under the hero card */}
                {activeEntry || isWorking ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {activeEntry ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-11 px-3 font-medium sm:h-9"
                        data-testid="log-activity"
                        disabled={busy}
                        onClick={() => setLogActivityOpen(true)}
                      >
                        <Plus aria-hidden />
                        Log Activity
                      </Button>
                    ) : null}

                    {isWorking ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-11 px-3 font-medium sm:h-9"
                          data-testid={onBreak ? "break-end" : "break-start"}
                          disabled={busy}
                          onClick={() =>
                            void (onBreak ? handleEndBreak() : startBreak())
                          }
                        >
                          {pending === "break-start" || pending === "break-end" ? (
                            <Loader2 aria-hidden className="animate-spin" />
                          ) : (
                            <Coffee aria-hidden />
                          )}
                          {breakResumeTarget
                            ? `End Break & Resume ${truncateTask(breakResumeTarget.taskName)}`
                            : onBreak
                              ? "End Break"
                              : "Break"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="ml-auto h-11 border-destructive/30 px-3 font-medium text-destructive hover:bg-destructive/10 hover:text-destructive sm:h-9"
                          data-testid="clock-out"
                          disabled={busy}
                          onClick={() => setStopWorkConfirmOpen(true)}
                        >
                          Stop Work
                        </Button>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {/* Today's Focus: Tasks relevant to today */}
              <TodayTasksCard
                timezone={timezone}
                onRefreshToday={() => void refresh()}
                refreshKey={tasksRefreshKey}
                trackedTaskId={activeEntry?.taskId ?? null}
                workedTodayTaskIds={workedTodayTaskIds}
              />

              {/* Google Calendar Today's Schedule */}
              <CalendarScheduleCard
                timezone={timezone}
                syncAfterImport
                onImportSuccess={() => void refresh()}
              />

              {/* Quick Start Recents */}
              <QuickStart timeZone={timezone} refresh={() => void refresh()} />
            </div>

            {/* Right Column: Today Overview Panel */}
            <div className="lg:col-span-5 flex flex-col gap-6">
              <TodayOverviewPanel
                summary={summary}
                attendance={attendance}
                activeEntry={activeEntry}
                timezone={timezone}
                initialNowMs={initialNowMs}
              />
            </div>
          </div>

          {activeEntry && activeCardOutOfView ? (
            <StickyTaskBar
              key={`sticky-${activeEntry.id}`}
              entry={activeEntry}
              initialNowMs={initialNowMs}
              busy={busy}
              onPause={pauseTask}
              onResume={resumeTask}
              onStop={() => setStopTaskConfirmOpen(true)}
            />
          ) : null}
        </>
      ) : null}

      <StartTaskDialog
        open={logActivityOpen}
        onOpenChange={setLogActivityOpen}
        onStart={startTask}
      />

      {activeEntry ? (
        <SwitchTaskDialog
          open={switchTaskOpen}
          onOpenChange={setSwitchTaskOpen}
          currentTaskName={activeEntry.taskName}
          onSwitch={startTask}
        />
      ) : null}

      <EntryTaskDialog
        entry={taskDialogEntry}
        categories={categories}
        onOpenChange={(o) => {
          if (!o) setTaskDialogEntry(null);
        }}
        onSaved={() => {
          setTaskDialogEntry(null);
          void refresh();
          setTasksRefreshKey((k) => k + 1);
        }}
      />

      <StopTaskConfirmDialog
        stopTaskConfirmOpen={stopTaskConfirmOpen}
        setStopTaskConfirmOpen={setStopTaskConfirmOpen}
        activeEntry={activeEntry}
        busy={busy}
        pending={pending}
        stopTask={stopTask}
      />

      <StopWorkConfirmDialog
        stopWorkConfirmOpen={stopWorkConfirmOpen}
        setStopWorkConfirmOpen={setStopWorkConfirmOpen}
        onBreak={onBreak}
        busy={busy}
        pending={pending}
        clockOut={clockOut}
      />
    </div>
  );
}

function LoadingCard() {
  return (
    <Card data-loading="true">
      <CardContent className="flex flex-col gap-4">
        <div className="h-5 w-1/3 animate-pulse rounded-md bg-muted" />
        <div className="h-12 w-2/5 animate-pulse rounded-md bg-muted" />
        <p className="text-sm text-muted-foreground">Loading your day…</p>
      </CardContent>
    </Card>
  );
}

/** Button-friendly task name: keep the first 18 chars plus an ellipsis. */
function truncateTask(name: string): string {
  return name.length > 20 ? `${name.slice(0, 18)}…` : name;
}

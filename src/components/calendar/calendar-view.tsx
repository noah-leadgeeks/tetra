"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Users,
  Video,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryBadge } from "@/components/ui/category-badge";
import { Input } from "@/components/ui/input";
import { EventDialog } from "@/components/calendar/event-dialog";
import type { CalendarEventDTO } from "@/features/calendar-sync/types";
import {
  addDaysISO,
  getDayOfWeek,
  todayKey,
  zonedClock,
  zonedDayKey,
} from "@/lib/time";
import { isAbortError, isNetworkError, withRetry } from "@/lib/retry";
import { cn } from "@/lib/utils";

interface CalendarViewProps {
  timezone?: string;
  hasGoogleAuth?: boolean;
}

const RETRY_DELAYS_MS = [1000, 3000];

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const FULL_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function CalendarView({ timezone = "Asia/Jakarta", hasGoogleAuth = true }: CalendarViewProps) {
  const currentTodayKey = useMemo(() => todayKey(timezone), [timezone]);
  const [selectedDayKey, setSelectedDayKey] = useState<string>(currentTodayKey);

  const [events, setEvents] = useState<CalendarEventDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"day" | "week">("day");

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEventDTO | null>(null);

  // Calculate Monday of the selected week
  const weekDays = useMemo(() => {
    const dayOfWeek = getDayOfWeek(selectedDayKey); // 0 = Sun, 1 = Mon ...
    const diffToMonday = (dayOfWeek + 6) % 7; // Monday = 0
    const mondayKey = addDaysISO(selectedDayKey, -diffToMonday);

    return Array.from({ length: 7 }, (_, i) => {
      const key = addDaysISO(mondayKey, i);
      const dow = getDayOfWeek(key);
      const parts = key.split("-");
      return {
        key,
        dayNumber: parts[2],
        shortName: DAY_NAMES[dow],
        fullName: FULL_DAY_NAMES[dow],
        isToday: key === currentTodayKey,
        isSelected: key === selectedDayKey,
      };
    });
  }, [selectedDayKey, currentTodayKey]);

  // Formatted Month and Year (e.g. "September 2026")
  const monthYearLabel = useMemo(() => {
    const [y, m] = selectedDayKey.split("-");
    const d = new Date(Number(y), Number(m) - 1, 1);
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: timezone,
    }).format(d);
  }, [selectedDayKey, timezone]);

  const hasSyncedInitialRef = useRef(false);
  // Monotonic id so only the latest load/refresh may touch state.
  const refreshSeqRef = useRef(0);
  const lastLoadFailedRef = useRef(false);

  // Load events on mount and when selectedDayKey changes
  useEffect(() => {
    const controller = new AbortController();
    // Invalidate any in-flight manual refresh for a previous day.
    const seq = ++refreshSeqRef.current;

    async function fetchEvents() {
      try {
        const fromDate = addDaysISO(selectedDayKey, -35);
        const toDate = addDaysISO(selectedDayKey, 45);
        const shouldSync = !hasSyncedInitialRef.current;
        const url = `/api/calendar/events?from=${fromDate}&to=${toDate}&mode=events${
          shouldSync ? "&sync=true" : ""
        }`;

        const data = await withRetry(
          async () => {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body.error || "Failed to load events");
            }
            return await res.json();
          },
          {
            delaysMs: RETRY_DELAYS_MS,
            shouldRetry: (err) =>
              isNetworkError(err) && !controller.signal.aborted,
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) return;
        setEvents(data.events || []);
        setError(null);
        lastLoadFailedRef.current = false;
        hasSyncedInitialRef.current = true;
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) return;
        console.error("Load calendar events error:", err);
        lastLoadFailedRef.current = true;
        setError(err instanceof Error ? err.message : "Failed to load events");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          // A manual refresh started after this load owns the spinner.
          if (seq === refreshSeqRef.current) setSyncing(false);
        }
      }
    }

    void fetchEvents();
    return () => {
      controller.abort();
    };
  }, [selectedDayKey]);

  // Refresh / Sync events on demand
  const refreshEvents = useCallback(
    async (syncWithGoogle = false) => {
      const seq = ++refreshSeqRef.current;
      if (syncWithGoogle) {
        setSyncing(true);
      } else {
        setLoading(true);
      }
      setError(null);

      try {
        const fromDate = addDaysISO(selectedDayKey, -35);
        const toDate = addDaysISO(selectedDayKey, 45);

        const url = `/api/calendar/events?from=${fromDate}&to=${toDate}&mode=events${
          syncWithGoogle ? "&sync=true" : ""
        }`;

        const data = await withRetry(
          async () => {
            const res = await fetch(url);
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body.error || "Failed to load events");
            }
            return await res.json();
          },
          {
            delaysMs: RETRY_DELAYS_MS,
            shouldRetry: (err) =>
              isNetworkError(err) && seq === refreshSeqRef.current,
          },
        );
        if (seq !== refreshSeqRef.current) return;
        setEvents(data.events || []);
        lastLoadFailedRef.current = false;

        if (syncWithGoogle) {
          toast.success("Synchronized with Google Calendar");
        }
      } catch (err) {
        if (seq !== refreshSeqRef.current) return;
        console.error("Load calendar events error:", err);
        lastLoadFailedRef.current = true;
        const msg = err instanceof Error ? err.message : "Failed to load events";
        setError(msg);
        if (syncWithGoogle) {
          toast.error("Google Calendar sync failed: " + msg);
        }
      } finally {
        if (seq === refreshSeqRef.current) {
          setLoading(false);
          setSyncing(false);
        }
      }
    },
    [selectedDayKey],
  );

  // Reload automatically when the browser comes back online after a failure
  useEffect(() => {
    const handler = () => {
      if (lastLoadFailedRef.current) void refreshEvents(false);
    };
    window.addEventListener("online", handler);
    return () => window.removeEventListener("online", handler);
  }, [refreshEvents]);

  // Group events by day key
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEventDTO[]>();
    for (const ev of events) {
      const s = new Date(ev.startAt);
      const k = zonedDayKey(s, timezone);
      const list = map.get(k) || [];
      list.push(ev);
      map.set(k, list);
    }
    return map;
  }, [events, timezone]);

  // Filtered events for the selected day
  const selectedDayEvents = useMemo(() => {
    const dayList = eventsByDay.get(selectedDayKey) || [];
    if (!searchQuery.trim()) return dayList;
    const q = searchQuery.toLowerCase();
    return dayList.filter(
      (ev) =>
        ev.title.toLowerCase().includes(q) ||
        (ev.description && ev.description.toLowerCase().includes(q)) ||
        (ev.categoryName && ev.categoryName.toLowerCase().includes(q)) ||
        (ev.guests && ev.guests.some((g) => g.email.toLowerCase().includes(q))),
    );
  }, [eventsByDay, selectedDayKey, searchQuery]);

  function handleOpenCreate() {
    setEditingEvent(null);
    setDialogOpen(true);
  }

  function handleOpenEdit(ev: CalendarEventDTO) {
    setEditingEvent(ev);
    setDialogOpen(true);
  }

  function handlePrevWeek() {
    setSelectedDayKey((prev) => addDaysISO(prev, -7));
  }

  function handleNextWeek() {
    setSelectedDayKey((prev) => addDaysISO(prev, 7));
  }

  function handleJumpToday() {
    setSelectedDayKey(currentTodayKey);
  }

  return (
    <div className="space-y-6">
      {/* Top Header & Navigation Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/60 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Calendar</h1>
            <Badge variant="outline" className="text-xs font-mono font-medium">
              {timezone}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Schedule meetings, manage Google Meet links, and synchronize with Google Calendar.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => refreshEvents(true)}
            disabled={syncing || loading}
            className="text-xs gap-1.5 h-9"
            title="Pull latest events from Google Calendar"
          >
            <RefreshCw className={cn("size-3.5", syncing && "animate-spin text-primary")} />
            {syncing ? "Syncing..." : "Sync Google"}
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={handleOpenCreate}
            className="text-xs gap-1.5 h-9 font-medium shadow-xs"
          >
            <Plus className="size-4" />
            New Event
          </Button>
        </div>
      </div>

      {/* Week Navigator Card (User ASCII Mockup) */}
      <Card className="border-border/70 shadow-xs bg-card/60 backdrop-blur-xs">
        <CardHeader className="pb-3 pt-4 px-4 sm:px-6 flex flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base font-semibold tracking-tight">
              {monthYearLabel}
            </CardTitle>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleJumpToday}
              className="text-xs h-7 px-2.5 text-primary hover:text-primary hover:bg-primary/10"
            >
              Today
            </Button>
          </div>

          {/* View mode toggle & Week arrows */}
          <div className="flex items-center gap-1.5">
            <div className="inline-flex rounded-lg border border-border/70 p-0.5 bg-muted/40 mr-2">
              <button
                type="button"
                onClick={() => setViewMode("day")}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
                  viewMode === "day"
                    ? "bg-background text-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Day
              </button>
              <button
                type="button"
                onClick={() => setViewMode("week")}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
                  viewMode === "week"
                    ? "bg-background text-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Week
              </button>
            </div>

            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={handlePrevWeek}
              className="size-8"
              aria-label="Previous week"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={handleNextWeek}
              className="size-8"
              aria-label="Next week"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="px-3 sm:px-6 pb-4">
          {/* Week Strip Pills */}
          <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
            {weekDays.map((day) => {
              const dayEventCount = (eventsByDay.get(day.key) || []).length;
              return (
                <button
                  key={day.key}
                  type="button"
                  onClick={() => setSelectedDayKey(day.key)}
                  className={cn(
                    "flex flex-col items-center justify-center py-2.5 sm:py-3 rounded-xl border transition-all text-center cursor-pointer select-none",
                    day.isSelected
                      ? "bg-primary text-primary-foreground border-primary shadow-xs font-semibold ring-2 ring-primary/30"
                      : day.isToday
                      ? "bg-primary/10 border-primary/40 text-foreground hover:border-primary/60 font-semibold"
                      : "bg-muted/20 border-border/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "text-[10px] sm:text-xs tracking-wider",
                      day.isSelected
                        ? "text-primary-foreground/90 font-medium"
                        : "text-muted-foreground",
                    )}
                  >
                    {day.shortName}
                  </span>
                  <span
                    className={cn(
                      "text-base sm:text-lg font-bold mt-0.5",
                      day.isSelected ? "text-primary-foreground" : "text-foreground",
                    )}
                  >
                    {day.dayNumber}
                  </span>

                  {/* Indicator dot */}
                  <div className="h-1.5 flex items-center justify-center mt-1">
                    {dayEventCount > 0 && (
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          day.isSelected ? "bg-primary-foreground" : "bg-primary",
                        )}
                        title={`${dayEventCount} event${dayEventCount > 1 ? "s" : ""}`}
                      />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3.5 text-xs text-destructive flex items-center justify-between">
          <span>{error}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => refreshEvents(false)}
            className="h-7 text-xs border-destructive/30 hover:bg-destructive/10"
          >
            Retry
          </Button>
        </div>
      )}

      {/* Main Content Area */}
      {viewMode === "day" ? (
        <div className="space-y-4">
          {/* Day Header & Search */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-1">
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                {new Intl.DateTimeFormat("en-US", {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                  timeZone: timezone,
                }).format(new Date(`${selectedDayKey}T12:00:00Z`))}
              </h2>
              <Badge variant="secondary" className="text-xs">
                {selectedDayEvents.length} {selectedDayEvents.length === 1 ? "event" : "events"}
              </Badge>
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Filter events..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 text-xs h-8"
              />
            </div>
          </div>

          {/* Events List */}
          {loading ? (
            <div className="p-12 flex flex-col items-center justify-center text-muted-foreground gap-2">
              <Loader2 className="size-6 animate-spin text-primary" />
              <p className="text-xs">Loading calendar events...</p>
            </div>
          ) : selectedDayEvents.length === 0 ? (
            <Card className="border-dashed border-border/80 bg-muted/10 p-8 text-center">
              <div className="size-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto mb-3">
                <CalendarIcon className="size-6" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">No events scheduled</h3>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto mt-1 mb-4">
                You have no events on this day. Schedule a task, meeting, or sync with your Google Calendar.
              </p>
              <div className="flex items-center justify-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => refreshEvents(true)}
                  className="text-xs h-8 gap-1"
                >
                  <RefreshCw className="size-3.5" />
                  Sync Google
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleOpenCreate}
                  className="text-xs h-8 gap-1 font-medium"
                >
                  <Plus className="size-3.5" />
                  New Event
                </Button>
              </div>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {selectedDayEvents.map((ev) => {
                const sDate = new Date(ev.startAt);
                const eDate = new Date(ev.endAt);
                const timeLabel = ev.allDay
                  ? "All Day"
                  : `${zonedClock(sDate, timezone)} – ${zonedClock(eDate, timezone)}`;

                return (
                  <Card
                    key={ev.id}
                    className="border-border/70 hover:border-primary/40 hover:shadow-xs transition-all overflow-hidden flex flex-col justify-between"
                  >
                    <div className="p-4 space-y-2.5">
                      {/* Top Bar: Time & Category */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                          <Clock className="size-3.5 text-primary" />
                          <span>{timeLabel}</span>
                        </div>
                        {ev.categoryName && (
                          <CategoryBadge
                            categoryKey={ev.categoryKey}
                            categoryName={ev.categoryName}
                            size="sm"
                            showIcon
                          />
                        )}
                      </div>

                      {/* Title & Description */}
                      <div>
                        <h4 className="text-sm font-semibold text-foreground leading-snug line-clamp-2">
                          {ev.title}
                        </h4>
                        {ev.description && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                            {ev.description}
                          </p>
                        )}
                      </div>

                      {/* Guests & Status */}
                      {ev.guests && ev.guests.length > 0 && (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-1">
                          <Users className="size-3.5 text-muted-foreground/80" />
                          <span>
                            {ev.guests.length} {ev.guests.length === 1 ? "Guest" : "Guests"}
                          </span>
                          <span className="text-[11px] text-muted-foreground/60 truncate max-w-[200px]">
                            ({ev.guests.map((g) => g.displayName || g.email.split("@")[0]).join(", ")})
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Bottom Actions Card Bar */}
                    <div className="bg-muted/30 border-t border-border/50 px-4 py-2.5 flex items-center justify-between gap-2">
                      <div>
                        {ev.meetUrl ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="default"
                            onClick={() => window.open(ev.meetUrl!, "_blank")}
                            className="text-xs h-7 gap-1.5 px-3 bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs font-medium"
                          >
                            <Video className="size-3.5" />
                            Join Meeting
                          </Button>
                        ) : ev.htmlLink ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => window.open(ev.htmlLink!, "_blank")}
                            className="text-xs h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="size-3" />
                            Google Cal
                          </Button>
                        ) : null}
                      </div>

                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleOpenEdit(ev)}
                        className="text-xs h-7 px-2.5"
                      >
                        Edit Event
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* Week View Grid */
        <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
          {weekDays.map((day) => {
            const dayList = eventsByDay.get(day.key) || [];
            return (
              <div
                key={day.key}
                className={cn(
                  "rounded-xl border p-3 flex flex-col min-h-[360px]",
                  day.isSelected
                    ? "border-primary/60 bg-primary/[0.02]"
                    : "border-border/60 bg-card/40",
                )}
              >
                <div className="flex items-center justify-between pb-2 border-b border-border/40 mb-2">
                  <div className="text-xs font-bold text-foreground">
                    {day.shortName}{" "}
                    <span className="text-muted-foreground font-normal">{day.dayNumber}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedDayKey(day.key);
                      handleOpenCreate();
                    }}
                    className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-muted transition-colors"
                    title={`Add event for ${day.shortName}`}
                  >
                    <Plus className="size-3.5" />
                  </button>
                </div>

                <div className="space-y-2 flex-1 overflow-y-auto max-h-[450px]">
                  {dayList.length === 0 ? (
                    <div className="text-[11px] text-muted-foreground/60 text-center py-6">
                      No events
                    </div>
                  ) : (
                    dayList.map((ev) => {
                      const sDate = new Date(ev.startAt);
                      const timeStr = ev.allDay ? "All day" : zonedClock(sDate, timezone);
                      return (
                        <div
                          key={ev.id}
                          onClick={() => handleOpenEdit(ev)}
                          className="p-2 rounded-lg border border-border/70 hover:border-primary/50 bg-background/80 hover:bg-background transition-all cursor-pointer select-none space-y-1"
                        >
                          <div className="flex items-center justify-between text-[10px] text-muted-foreground font-medium">
                            <span>{timeStr}</span>
                            {ev.meetUrl && (
                              <span className="text-emerald-500" title="Google Meet">
                                <Video className="size-3" />
                              </span>
                            )}
                          </div>
                          <div className="text-xs font-semibold text-foreground line-clamp-2 leading-tight">
                            {ev.title}
                          </div>
                          {ev.categoryName && (
                            <div className="text-[10px] text-muted-foreground truncate">
                              {ev.categoryName}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create / Edit Event Dialog */}
      <EventDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        event={editingEvent}
        initialDate={selectedDayKey}
        hasGoogleAuth={hasGoogleAuth}
        onSaved={() => refreshEvents(false)}
        onDeleted={() => refreshEvents(false)}
      />
    </div>
  );
}

import type {
  NotificationSeverity,
  NotificationType,
  TetraNotification,
} from "./types";

export function formatRelativeTime(
  isoString: string,
  now: Date = new Date(),
): string {
  const date = new Date(isoString);
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function calculateUnreadCount(
  notifications: readonly TetraNotification[],
): number {
  return notifications.filter((n) => !n.read).length;
}

export function filterNotifications(
  notifications: readonly TetraNotification[],
  tab: "all" | "unread",
): TetraNotification[] {
  if (tab === "unread") {
    return notifications.filter((n) => !n.read);
  }
  return [...notifications];
}

export function markNotificationRead(
  notifications: readonly TetraNotification[],
  id: string,
): TetraNotification[] {
  return notifications.map((n) => (n.id === id ? { ...n, read: true } : n));
}

export function markAllNotificationsRead(
  notifications: readonly TetraNotification[],
): TetraNotification[] {
  return notifications.map((n) => ({ ...n, read: true }));
}

export function removeNotificationById(
  notifications: readonly TetraNotification[],
  id: string,
): TetraNotification[] {
  return notifications.filter((n) => n.id !== id);
}

export function createNotification(
  input: {
    type: NotificationType;
    severity: NotificationSeverity;
    title: string;
    message: string;
    href?: string;
    actionLabel?: string;
  },
  now: Date = new Date(),
): TetraNotification {
  return {
    id: `notif-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
    type: input.type,
    severity: input.severity,
    title: input.title,
    message: input.message,
    timestamp: now.toISOString(),
    read: false,
    href: input.href,
    actionLabel: input.actionLabel,
  };
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export interface CompanionAlertContext {
  todayKey: string;
  now?: Date;
  daySummary: {
    workDate: string;
    attendance: {
      clockInAt?: string;
      clockOutAt?: string | null;
      startedAt?: string;
      endedAt?: string | null;
      activeBreak?: { startedAt: string; endedAt?: string | null } | null;
      breaks?: Array<{ startedAt: string; endedAt?: string | null }>;
    } | null;
    breaks?: Array<{
      startedAt: string;
      endedAt?: string | null;
    }>;
    timeEntries: Array<{
      id: string;
      taskName: string;
      status: string;
      startedAt: string;
      endedAt: string | null;
      pausedSeconds: number;
    }>;
    warnings: Array<{
      type: string;
      message: string;
    }>;
    reviewState: string;
  };
  weekSummary?: {
    from: string;
    to: string;
    days: Array<{
      workDate: string;
      workMinutes: number;
      hasData: boolean;
    }>;
    totals: {
      workMinutes: number;
      daysTracked: number;
    };
  } | null;
  calendarEvents?: Array<{
    id: string;
    title: string;
    startedAt: string;
    endedAt: string;
    isImported: boolean;
  }>;
  hasUnsyncedYesterday?: boolean;
  yesterdayKey?: string;
}

/**
 * Generates proactive, actionable companion alerts for time gaps, missed meetings,
 * missing work days, weekly target deficit (<40h), forgotten timers, and extended breaks.
 */
export function generateCompanionAlerts(context: CompanionAlertContext): TetraNotification[] {
  const alerts: TetraNotification[] = [];
  const now = context.now ?? new Date();

  const isAttendanceOpen = Boolean(
    context.daySummary.attendance &&
      !context.daySummary.attendance.clockOutAt &&
      !context.daySummary.attendance.endedAt,
  );

  // 1. Unaccounted Time Gap Alerts
  if (isAttendanceOpen) {
    const gapWarnings = context.daySummary.warnings.filter((w) => w.type === "gap");
    for (const w of gapWarnings) {
      alerts.push({
        id: `alert-gap-${context.daySummary.workDate}-${w.message.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`,
        type: "gap",
        severity: "warning",
        title: "Unaccounted Time Gap",
        message: `${w.message}. Log an activity or break to keep your report accurate.`,
        timestamp: now.toISOString(),
        read: false,
        href: "/",
        actionLabel: "Log Activity",
      });
    }
  }

  // 2. Missed / Unlogged Meeting Alerts
  if (context.calendarEvents) {
    for (const event of context.calendarEvents) {
      const endMs = new Date(event.endedAt).getTime();
      if (!event.isImported && endMs < now.getTime()) {
        const minutesAgo = Math.max(1, Math.floor((now.getTime() - endMs) / 60_000));
        if (minutesAgo <= 1440) {
          alerts.push({
            id: `alert-meeting-${event.id}`,
            type: "meeting",
            severity: "warning",
            title: "Unlogged Meeting",
            message: `Meeting "${event.title}" ended ${minutesAgo}m ago and has not been logged on your timeline.`,
            timestamp: now.toISOString(),
            read: false,
            href: "/",
            actionLabel: "Import Meeting",
          });
        }
      }
    }
  }

  // 3. Missing Work Day Alerts (Past weekdays Mon-Fri in current week)
  if (context.weekSummary) {
    for (const day of context.weekSummary.days) {
      if (day.workDate < context.todayKey) {
        // Parse date for day of week: 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
        const d = new Date(`${day.workDate}T12:00:00Z`);
        const dow = d.getUTCDay();
        if (dow >= 1 && dow <= 5 && !day.hasData && day.workMinutes === 0) {
          const dayName = WEEKDAY_NAMES[dow];
          alerts.push({
            id: `alert-missing-day-${day.workDate}`,
            type: "missing_day",
            severity: "warning",
            title: "Missing Work Day",
            message: `No work or attendance recorded for ${dayName} (${day.workDate}). Review and backfill before weekly submission.`,
            timestamp: now.toISOString(),
            read: false,
            href: `/reports?date=${day.workDate}`,
            actionLabel: "Review Day",
          });
        }
      }
    }
  }

  // 4. Weekly Target Deficit (< 40h)
  if (context.weekSummary) {
    const todayDate = new Date(`${context.todayKey}T12:00:00Z`);
    const currentDow = todayDate.getUTCDay();
    const isLateWeekOrEnded = currentDow >= 5 || currentDow === 0 || context.weekSummary.to < context.todayKey;
    const weeklyMinutes = context.weekSummary.totals.workMinutes;

    if (isLateWeekOrEnded && weeklyMinutes < 2400) {
      const loggedHours = (weeklyMinutes / 60).toFixed(1);
      const remainingHours = ((2400 - weeklyMinutes) / 60).toFixed(1);
      alerts.push({
        id: `alert-weekly-target-${context.weekSummary.from}`,
        type: "weekly_target",
        severity: "warning",
        title: "Weekly Target Behind (< 40h)",
        message: `Weekly logged time is ${loggedHours}h of 40h goal (${remainingHours}h remaining). Review your week to meet company target.`,
        timestamp: now.toISOString(),
        read: false,
        href: "/reports/week",
        actionLabel: "Weekly Report",
      });
    }
  }

  // 5. Forgotten Running Timer (> 3h)
  const activeEntry = context.daySummary.timeEntries.find((e) => e.status === "active");
  if (activeEntry) {
    const runningMs = now.getTime() - new Date(activeEntry.startedAt).getTime() - (activeEntry.pausedSeconds * 1000);
    const runningMinutes = Math.floor(runningMs / 60_000);
    if (runningMinutes >= 180) {
      const h = Math.floor(runningMinutes / 60);
      const m = runningMinutes % 60;
      alerts.push({
        id: `alert-long-timer-${activeEntry.id}`,
        type: "timer",
        severity: "reminder",
        title: "Running Timer Reminder",
        message: `Timer for "${activeEntry.taskName}" has been running for ${h}h ${m}m. Did you step away or take a break?`,
        timestamp: now.toISOString(),
        read: false,
        href: "/",
        actionLabel: "Check Timer",
      });
    }
  }

  // 6. Extended Break Reminder (> 60m)
  if (isAttendanceOpen) {
    const activeBreak =
      context.daySummary.attendance?.activeBreak ??
      (context.daySummary.attendance?.breaks ?? context.daySummary.breaks ?? []).find(
        (b) => !b.endedAt,
      );
    if (activeBreak) {
      const breakMinutes = Math.floor((now.getTime() - new Date(activeBreak.startedAt).getTime()) / 60_000);
      if (breakMinutes >= 60) {
        const h = Math.floor(breakMinutes / 60);
        const m = breakMinutes % 60;
        alerts.push({
          id: `alert-long-break-${context.daySummary.workDate}`,
          type: "attendance",
          severity: "reminder",
          title: "Extended Break Reminder",
          message: `You have been on break for ${h}h ${m}m. Remember to resume your shift when back.`,
          timestamp: now.toISOString(),
          read: false,
          href: "/",
          actionLabel: "Resume Shift",
        });
      }
    }
  }

  // 7. Unsynced Yesterday Report
  if (context.hasUnsyncedYesterday && context.yesterdayKey) {
    alerts.push({
      id: `alert-unsynced-${context.yesterdayKey}`,
      type: "sync",
      severity: "warning",
      title: "Unsynced Daily Report",
      message: `Yesterday's daily summary (${context.yesterdayKey}) has not been synced to the official Google Sheet.`,
      timestamp: now.toISOString(),
      read: false,
      href: `/reports?date=${context.yesterdayKey}`,
      actionLabel: "Review & Sync",
    });
  }

  return alerts;
}

/** Minimal shape of a pending agent action needed to build its approval alert. */
export interface PendingAgentActionInput {
  id: string;
  status: string;
  reason: string | null;
  expiresAt: string | null;
  summary: { label?: string; impact?: Record<string, unknown> } & Record<string, unknown>;
  live?: { label: string; impact: Record<string, unknown> } | null;
}

function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function describeAgentImpact(impact: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (typeof impact.entryCount === "number") {
    const n = impact.entryCount;
    let text = `${n} ${n === 1 ? "entry" : "entries"}`;
    if (typeof impact.totalMinutes === "number") text += `, ${formatMinutes(impact.totalMinutes)}`;
    parts.push(text);
  } else if (typeof impact.minutes === "number") {
    parts.push(formatMinutes(impact.minutes));
  }
  if (impact.activeEntry === true) parts.push("includes the running timer");
  if (impact.googleLinked === true) parts.push("linked to Google");
  if (impact.notifiesGuests === true && typeof impact.guestCount === "number") {
    parts.push(`notifies ${impact.guestCount} guest${impact.guestCount === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function describeExpiry(expiresAt: string | null, now: Date): string | null {
  if (!expiresAt) return null;
  const minutes = Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 60_000);
  if (Number.isNaN(minutes)) return null;
  return minutes <= 0 ? "expires now" : `expires in ${formatMinutes(minutes)}`;
}

/**
 * Builds one `alert-agent-action-<id>` warning per pending agent delete.
 * Alerts are regenerated per fetch, so resolved actions disappear on their own.
 */
export function buildAgentApprovalAlerts(
  actions: readonly PendingAgentActionInput[],
  now: Date = new Date(),
): TetraNotification[] {
  return actions
    .filter((a) => a.status === "pending")
    .map((a) => {
      const label = a.live?.label ?? a.summary.label ?? "an item";
      const impact = describeAgentImpact(a.live?.impact ?? a.summary.impact ?? {});
      const parts = [impact, describeExpiry(a.expiresAt, now)].filter(
        (p): p is string => p !== null,
      );
      let message = parts.join("; ");
      if (a.reason) message += `${message ? ". " : ""}agent says: ${a.reason}`;
      return {
        id: `alert-agent-action-${a.id}`,
        type: "agent_approval" as const,
        severity: "warning" as const,
        title: `Agent wants to delete ${label}`,
        message,
        timestamp: now.toISOString(),
        read: false,
        href: "/settings/agent",
        actionLabel: "Review",
      };
    });
}

/** Pins the id format produced by `generateCompanionAlerts` for missing days. */
export const MISSING_DAY_ALERT_ID_PATTERN = /^alert-missing-day-(\d{4}-\d{2}-\d{2})$/;

const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatMissingDayLabel(dayKey: string): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  return `${SHORT_WEEKDAYS[d.getUTCDay()]} ${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** One banner slot: a single alert, or several alerts collapsed into one. */
export interface BannerEntry {
  ids: string[];
  alert: TetraNotification;
}

/**
 * Collapses every `missing_day` alert into one "Backfill N days" entry that
 * links to `/reports?date=<oldest>&backfill=<d1,d2,...>` (days sorted
 * ascending). The collapsed entry takes the position of the first missing-day
 * alert; all other alerts pass through unchanged as single-id entries.
 */
export function collapseMissingDayAlerts(
  alerts: readonly TetraNotification[],
): BannerEntry[] {
  const missing: Array<{ id: string; day: string; alert: TetraNotification }> = [];
  for (const alert of alerts) {
    const match = alert.type === "missing_day" ? MISSING_DAY_ALERT_ID_PATTERN.exec(alert.id) : null;
    if (match) missing.push({ id: alert.id, day: match[1], alert });
  }

  if (missing.length === 0) {
    return alerts.map((alert) => ({ ids: [alert.id], alert }));
  }

  const days = [...new Set(missing.map((m) => m.day))].sort();
  const count = days.length;
  const noun = count === 1 ? "day" : "days";
  const label = `Backfill ${count} ${noun}`;
  const first = missing[0].alert;
  const collapsed: BannerEntry = {
    ids: missing.map((m) => m.id),
    alert: {
      ...first,
      id: `alert-missing-days-${days.join(",")}`,
      title: label,
      message: `${days.map(formatMissingDayLabel).join(", ")} ${count === 1 ? "has" : "have"} no work or attendance recorded.`,
      timestamp: missing.reduce(
        (latest, m) => (m.alert.timestamp > latest ? m.alert.timestamp : latest),
        first.timestamp,
      ),
      actionLabel: label,
      href: `/reports?date=${days[0]}&backfill=${days.join(",")}`,
    },
  };

  const missingIds = new Set(collapsed.ids);
  const entries: BannerEntry[] = [];
  let inserted = false;
  for (const alert of alerts) {
    if (missingIds.has(alert.id)) {
      if (!inserted) {
        entries.push(collapsed);
        inserted = true;
      }
      continue;
    }
    entries.push({ ids: [alert.id], alert });
  }
  return entries;
}

/**
 * Merges server-generated alerts with existing user notifications.
 * Preserves user read state and dismissals without duplicating active alerts.
 */
export function mergeCompanionAlerts(
  existing: readonly TetraNotification[],
  newAlerts: readonly TetraNotification[],
): TetraNotification[] {
  const existingMap = new Map(existing.map((n) => [n.id, n]));
  const result: TetraNotification[] = [];

  for (const alert of newAlerts) {
    const prev = existingMap.get(alert.id);
    if (prev) {
      result.push({
        ...alert,
        read: prev.read,
        timestamp: prev.read ? prev.timestamp : alert.timestamp,
      });
      existingMap.delete(alert.id);
    } else {
      result.push(alert);
    }
  }

  for (const [id, item] of existingMap) {
    if (!id.startsWith("alert-")) {
      result.push(item);
    }
  }

  return result;
}

/**
 * Determines whether the startup notification banner overlay should be suppressed
 * for the given calendar day key (e.g. "YYYY-MM-DD").
 */
export function isBannerSuppressedForDate(
  suppressedDate: string | null | undefined,
  currentDayKey: string,
): boolean {
  if (!suppressedDate || !currentDayKey) return false;
  return suppressedDate.trim() === currentDayKey.trim();
}


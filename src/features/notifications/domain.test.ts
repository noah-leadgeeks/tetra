import { describe, expect, it } from "vitest";

import {
  buildAgentApprovalAlerts,
  calculateUnreadCount,
  collapseMissingDayAlerts,
  createNotification,
  filterNotifications,
  formatRelativeTime,
  generateCompanionAlerts,
  isBannerSuppressedForDate,
  markAllNotificationsRead,
  markNotificationRead,
  mergeCompanionAlerts,
  MISSING_DAY_ALERT_ID_PATTERN,
  removeNotificationById,
} from "./domain";
import type { TetraNotification } from "./types";

describe("Notifications domain logic", () => {
  describe("formatRelativeTime", () => {
    const baseNow = new Date("2026-09-10T12:00:00Z");

    it("formats just now for events less than a minute ago", () => {
      const recent = new Date("2026-09-10T11:59:30Z").toISOString();
      expect(formatRelativeTime(recent, baseNow)).toBe("Just now");
    });

    it("formats minutes ago", () => {
      const fiveAgo = new Date("2026-09-10T11:55:00Z").toISOString();
      expect(formatRelativeTime(fiveAgo, baseNow)).toBe("5m ago");
    });

    it("formats hours ago", () => {
      const threeHoursAgo = new Date("2026-09-10T09:00:00Z").toISOString();
      expect(formatRelativeTime(threeHoursAgo, baseNow)).toBe("3h ago");
    });

    it("formats yesterday", () => {
      const yesterday = new Date("2026-09-09T10:00:00Z").toISOString();
      expect(formatRelativeTime(yesterday, baseNow)).toBe("Yesterday");
    });
  });

  describe("calculateUnreadCount", () => {
    it("returns 0 when all are read", () => {
      const list: TetraNotification[] = [
        {
          id: "1",
          type: "system",
          severity: "info",
          title: "A",
          message: "A",
          timestamp: "",
          read: true,
        },
      ];
      expect(calculateUnreadCount(list)).toBe(0);
    });

    it("counts unread notifications accurately", () => {
      const list: TetraNotification[] = [
        {
          id: "1",
          type: "system",
          severity: "info",
          title: "A",
          message: "A",
          timestamp: "",
          read: false,
        },
        {
          id: "2",
          type: "attendance",
          severity: "reminder",
          title: "B",
          message: "B",
          timestamp: "",
          read: true,
        },
        {
          id: "3",
          type: "sync",
          severity: "success",
          title: "C",
          message: "C",
          timestamp: "",
          read: false,
        },
      ];
      expect(calculateUnreadCount(list)).toBe(2);
    });
  });

  describe("filterNotifications", () => {
    const list: TetraNotification[] = [
      {
        id: "1",
        type: "system",
        severity: "info",
        title: "A",
        message: "A",
        timestamp: "",
        read: false,
      },
      {
        id: "2",
        type: "attendance",
        severity: "reminder",
        title: "B",
        message: "B",
        timestamp: "",
        read: true,
      },
    ];

    it("returns all items when tab is all", () => {
      expect(filterNotifications(list, "all")).toHaveLength(2);
    });

    it("filters only unread items when tab is unread", () => {
      const unread = filterNotifications(list, "unread");
      expect(unread).toHaveLength(1);
      expect(unread[0].id).toBe("1");
    });
  });

  describe("markNotificationRead & markAllNotificationsRead", () => {
    const list: TetraNotification[] = [
      {
        id: "1",
        type: "system",
        severity: "info",
        title: "A",
        message: "A",
        timestamp: "",
        read: false,
      },
      {
        id: "2",
        type: "attendance",
        severity: "reminder",
        title: "B",
        message: "B",
        timestamp: "",
        read: false,
      },
    ];

    it("marks single notification as read without mutating original", () => {
      const updated = markNotificationRead(list, "1");
      expect(updated[0].read).toBe(true);
      expect(updated[1].read).toBe(false);
      expect(list[0].read).toBe(false);
    });

    it("marks all notifications as read", () => {
      const updated = markAllNotificationsRead(list);
      expect(updated.every((n) => n.read)).toBe(true);
    });
  });

  describe("removeNotificationById", () => {
    const list: TetraNotification[] = [
      {
        id: "1",
        type: "system",
        severity: "info",
        title: "A",
        message: "A",
        timestamp: "",
        read: false,
      },
      {
        id: "2",
        type: "attendance",
        severity: "reminder",
        title: "B",
        message: "B",
        timestamp: "",
        read: false,
      },
    ];

    it("removes specified notification by id", () => {
      const updated = removeNotificationById(list, "1");
      expect(updated).toHaveLength(1);
      expect(updated[0].id).toBe("2");
    });
  });

  describe("createNotification", () => {
    it("generates a new notification with unique id, ISO timestamp and unread status", () => {
      const now = new Date("2026-09-10T12:00:00Z");
      const notif = createNotification(
        {
          type: "sync",
          severity: "success",
          title: "Google Sheet Synced",
          message: "All 5 cells updated successfully.",
          href: "/timeline",
          actionLabel: "View",
        },
        now,
      );

      expect(notif.id).toMatch(/^notif-\d+/);
      expect(notif.type).toBe("sync");
      expect(notif.severity).toBe("success");
      expect(notif.title).toBe("Google Sheet Synced");
      expect(notif.timestamp).toBe(now.toISOString());
      expect(notif.read).toBe(false);
      expect(notif.href).toBe("/timeline");
      expect(notif.actionLabel).toBe("View");
    });
  });

  describe("generateCompanionAlerts & mergeCompanionAlerts", () => {
    const baseNow = new Date("2026-09-18T15:00:00Z"); // Friday 15:00 UTC (22:00 Jakarta)
    const todayKey = "2026-09-18";

    it("generates time gap alert during active attendance", () => {
      const alerts = generateCompanionAlerts({
        todayKey,
        now: baseNow,
        daySummary: {
          workDate: todayKey,
          attendance: { startedAt: "2026-09-18T08:00:00Z", endedAt: null },
          timeEntries: [],
          warnings: [{ type: "gap", message: "45m gap between Standup and API Task" }],
          reviewState: "ready",
        },
      });

      const gapAlert = alerts.find((a) => a.type === "gap");
      expect(gapAlert).toBeDefined();
      expect(gapAlert!.title).toBe("Unaccounted Time Gap");
      expect(gapAlert!.message).toContain("45m gap");
      expect(gapAlert!.actionLabel).toBe("Log Activity");
    });

    it("generates missed/unlogged meeting alert when calendar event ended without import", () => {
      const alerts = generateCompanionAlerts({
        todayKey,
        now: baseNow,
        daySummary: {
          workDate: todayKey,
          attendance: { startedAt: "2026-09-18T08:00:00Z", endedAt: null },
          timeEntries: [],
          warnings: [],
          reviewState: "ready",
        },
        calendarEvents: [
          {
            id: "meet-smart-goals",
            title: "IT Department 2026 SMART Goals",
            startedAt: "2026-09-18T13:00:00Z",
            endedAt: "2026-09-18T14:00:00Z", // ended 1 hour ago
            isImported: false,
          },
          {
            id: "meet-imported",
            title: "Team Sync",
            startedAt: "2026-09-18T10:00:00Z",
            endedAt: "2026-09-18T11:00:00Z",
            isImported: true,
          },
        ],
      });

      const meetingAlert = alerts.find((a) => a.type === "meeting");
      expect(meetingAlert).toBeDefined();
      expect(meetingAlert!.title).toBe("Unlogged Meeting");
      expect(meetingAlert!.message).toContain("IT Department 2026 SMART Goals");
      expect(meetingAlert!.actionLabel).toBe("Import Meeting");
      // Should not alert for already imported meeting
      expect(alerts.filter((a) => a.type === "meeting")).toHaveLength(1);
    });

    it("generates missing work day alert for unrecorded past weekdays", () => {
      const alerts = generateCompanionAlerts({
        todayKey, // Friday 2026-09-18
        now: baseNow,
        daySummary: {
          workDate: todayKey,
          attendance: { startedAt: "2026-09-18T08:00:00Z", endedAt: null },
          timeEntries: [],
          warnings: [],
          reviewState: "ready",
        },
        weekSummary: {
          from: "2026-09-14",
          to: "2026-09-20",
          days: [
            { workDate: "2026-09-14", workMinutes: 480, hasData: true }, // Mon
            { workDate: "2026-09-15", workMinutes: 480, hasData: true }, // Tue
            { workDate: "2026-09-16", workMinutes: 0, hasData: false },  // Wed (missing!)
            { workDate: "2026-09-17", workMinutes: 480, hasData: true }, // Thu
            { workDate: "2026-09-18", workMinutes: 240, hasData: true }, // Fri (today)
            { workDate: "2026-09-19", workMinutes: 0, hasData: false },  // Sat (future/weekend)
            { workDate: "2026-09-20", workMinutes: 0, hasData: false },  // Sun
          ],
          totals: {
            workMinutes: 1680,
            daysTracked: 4,
          },
        },
      });

      const missingAlert = alerts.find((a) => a.type === "missing_day");
      expect(missingAlert).toBeDefined();
      expect(missingAlert!.title).toBe("Missing Work Day");
      expect(missingAlert!.message).toContain("2026-09-16");
      expect(missingAlert!.actionLabel).toBe("Review Day");
      expect(missingAlert!.id).toBe("alert-missing-day-2026-09-16");
      expect(missingAlert!.href).toBe("/reports?date=2026-09-16");
    });

    it("links the unsynced-yesterday alert to the Reports review page", () => {
      const alerts = generateCompanionAlerts({
        todayKey,
        now: baseNow,
        daySummary: {
          workDate: todayKey,
          attendance: null,
          timeEntries: [],
          warnings: [],
          reviewState: "draft",
        },
        hasUnsyncedYesterday: true,
        yesterdayKey: "2026-09-17",
      });

      const syncAlert = alerts.find((a) => a.type === "sync");
      expect(syncAlert).toBeDefined();
      expect(syncAlert!.href).toBe("/reports?date=2026-09-17");
      expect(alerts.some((a) => a.href?.startsWith("/days/"))).toBe(false);
    });

    it("generates weekly target deficit alert when hours < 40 on late week", () => {
      const alerts = generateCompanionAlerts({
        todayKey, // Friday
        now: baseNow,
        daySummary: {
          workDate: todayKey,
          attendance: { startedAt: "2026-09-18T08:00:00Z", endedAt: null },
          timeEntries: [],
          warnings: [],
          reviewState: "ready",
        },
        weekSummary: {
          from: "2026-09-14",
          to: "2026-09-20",
          days: [],
          totals: {
            workMinutes: 1920, // 32 hours (deficit of 8h)
            daysTracked: 4,
          },
        },
      });

      const weeklyAlert = alerts.find((a) => a.type === "weekly_target");
      expect(weeklyAlert).toBeDefined();
      expect(weeklyAlert!.title).toBe("Weekly Target Behind (< 40h)");
      expect(weeklyAlert!.message).toContain("32.0h");
      expect(weeklyAlert!.actionLabel).toBe("Weekly Report");
    });

    it("generates running timer reminder for timers > 3 hours", () => {
      const fourHoursAgo = new Date(baseNow.getTime() - 4 * 60 * 60 * 1000).toISOString();
      const alerts = generateCompanionAlerts({
        todayKey,
        now: baseNow,
        daySummary: {
          workDate: todayKey,
          attendance: { startedAt: "2026-09-18T08:00:00Z", endedAt: null },
          timeEntries: [
            {
              id: "t-runaway",
              taskName: "Long Running Refactor",
              status: "active",
              startedAt: fourHoursAgo,
              endedAt: null,
              pausedSeconds: 0,
            },
          ],
          warnings: [],
          reviewState: "ready",
        },
      });

      const timerAlert = alerts.find((a) => a.type === "timer");
      expect(timerAlert).toBeDefined();
      expect(timerAlert!.title).toBe("Running Timer Reminder");
      expect(timerAlert!.message).toContain("Long Running Refactor");
      expect(timerAlert!.message).toContain("4h 0m");
    });

    it("merges alerts preserving user read status and removing resolved alerts", () => {
      const existing: TetraNotification[] = [
        {
          id: "alert-gap-1",
          type: "gap",
          severity: "warning",
          title: "Unaccounted Time Gap",
          message: "Gap message",
          timestamp: "2026-09-18T10:00:00Z",
          read: true, // user already marked read!
        },
        {
          id: "alert-meeting-old",
          type: "meeting",
          severity: "warning",
          title: "Unlogged Meeting",
          message: "Old meeting",
          timestamp: "2026-09-18T11:00:00Z",
          read: false, // will be pruned if condition resolved
        },
      ];

      const newAlerts: TetraNotification[] = [
        {
          id: "alert-gap-1", // same gap
          type: "gap",
          severity: "warning",
          title: "Unaccounted Time Gap",
          message: "Updated gap message",
          timestamp: "2026-09-18T12:00:00Z",
          read: false,
        },
        {
          id: "alert-missing-day-1", // new missing day
          type: "missing_day",
          severity: "warning",
          title: "Missing Work Day",
          message: "Missing day",
          timestamp: "2026-09-18T12:00:00Z",
          read: false,
        },
      ];

      const merged = mergeCompanionAlerts(existing, newAlerts);
      expect(merged).toHaveLength(2);

      const gap = merged.find((m) => m.id === "alert-gap-1");
      expect(gap).toBeDefined();
      expect(gap!.read).toBe(true); // preserved read state!

      const missing = merged.find((m) => m.id === "alert-missing-day-1");
      expect(missing).toBeDefined();
      expect(missing!.read).toBe(false);

      // Resolved alert is pruned
      expect(merged.find((m) => m.id === "alert-meeting-old")).toBeUndefined();
    });
  });

  describe("isBannerSuppressedForDate", () => {
    it("returns true when suppressed date matches the current calendar day", () => {
      expect(isBannerSuppressedForDate("2026-09-18", "2026-09-18")).toBe(true);
      expect(isBannerSuppressedForDate(" 2026-09-18 ", "2026-09-18")).toBe(true);
    });

    it("returns false when suppressed date is from a previous or different day", () => {
      expect(isBannerSuppressedForDate("2026-09-17", "2026-09-18")).toBe(false);
      expect(isBannerSuppressedForDate("2026-09-19", "2026-09-18")).toBe(false);
    });

    it("returns false when suppressed date is null, undefined, or empty", () => {
      expect(isBannerSuppressedForDate(null, "2026-09-18")).toBe(false);
      expect(isBannerSuppressedForDate(undefined, "2026-09-18")).toBe(false);
      expect(isBannerSuppressedForDate("", "2026-09-18")).toBe(false);
    });
  });

  describe("collapseMissingDayAlerts", () => {
    function alert(id: string, type: TetraNotification["type"], timestamp = "2026-09-18T15:00:00.000Z"): TetraNotification {
      return {
        id,
        type,
        severity: "warning",
        title: type === "missing_day" ? "Missing Work Day" : "Other",
        message: "msg",
        timestamp,
        read: false,
        href: type === "missing_day" ? `/reports?date=${id.slice(-10)}` : "/",
        actionLabel: type === "missing_day" ? "Review Day" : "Open",
      };
    }

    it("pins the missing-day id pattern used to derive day keys", () => {
      expect(MISSING_DAY_ALERT_ID_PATTERN.source).toBe("^alert-missing-day-(\\d{4}-\\d{2}-\\d{2})$");
      expect(MISSING_DAY_ALERT_ID_PATTERN.exec("alert-missing-day-2026-09-16")?.[1]).toBe("2026-09-16");
      expect(MISSING_DAY_ALERT_ID_PATTERN.test("alert-missing-day-2026-09-16x")).toBe(false);
      expect(MISSING_DAY_ALERT_ID_PATTERN.test("alert-missing-days-2026-09-16")).toBe(false);
    });

    it("passes alerts through untouched when there are no missing days", () => {
      const input = [alert("alert-gap-1", "gap"), alert("alert-meeting-1", "meeting")];
      const entries = collapseMissingDayAlerts(input);
      expect(entries).toEqual([
        { ids: ["alert-gap-1"], alert: input[0] },
        { ids: ["alert-meeting-1"], alert: input[1] },
      ]);
      expect(collapseMissingDayAlerts([])).toEqual([]);
    });

    it("collapses a single missing day into a singular backfill entry", () => {
      const entries = collapseMissingDayAlerts([alert("alert-missing-day-2026-09-16", "missing_day")]);
      expect(entries).toHaveLength(1);
      expect(entries[0].ids).toEqual(["alert-missing-day-2026-09-16"]);
      expect(entries[0].alert.title).toBe("Backfill 1 day");
      expect(entries[0].alert.actionLabel).toBe("Backfill 1 day");
      expect(entries[0].alert.message).toBe("Wed Sep 16 has no work or attendance recorded.");
      expect(entries[0].alert.href).toBe("/reports?date=2026-09-16&backfill=2026-09-16");
      expect(entries[0].alert.type).toBe("missing_day");
    });

    it("collapses three missing days sorted ascending, oldest first, preserving order of other alerts", () => {
      const gap = alert("alert-gap-1", "gap");
      const weekly = alert("alert-weekly-target-2026-09-14", "weekly_target");
      const input = [
        gap,
        alert("alert-missing-day-2026-09-17", "missing_day"),
        alert("alert-missing-day-2026-09-14", "missing_day"),
        weekly,
        alert("alert-missing-day-2026-09-15", "missing_day"),
      ];
      const entries = collapseMissingDayAlerts(input);

      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual({ ids: ["alert-gap-1"], alert: gap });
      expect(entries[2]).toEqual({ ids: ["alert-weekly-target-2026-09-14"], alert: weekly });

      const collapsed = entries[1];
      expect(collapsed.ids.slice().sort()).toEqual([
        "alert-missing-day-2026-09-14",
        "alert-missing-day-2026-09-15",
        "alert-missing-day-2026-09-17",
      ]);
      expect(collapsed.alert.title).toBe("Backfill 3 days");
      expect(collapsed.alert.actionLabel).toBe("Backfill 3 days");
      expect(collapsed.alert.message).toBe(
        "Mon Sep 14, Tue Sep 15, Thu Sep 17 have no work or attendance recorded.",
      );
      expect(collapsed.alert.href).toBe(
        "/reports?date=2026-09-14&backfill=2026-09-14,2026-09-15,2026-09-17",
      );
    });

    it("leaves a missing_day alert with a non-matching id as its own entry", () => {
      const odd = alert("alert-missing-day-1", "missing_day");
      expect(collapseMissingDayAlerts([odd])).toEqual([{ ids: ["alert-missing-day-1"], alert: odd }]);
    });
  });
});

describe("buildAgentApprovalAlerts", () => {
  const now = new Date("2026-09-10T12:00:00Z");

  it("builds a warning alert for a pending task delete", () => {
    const [alert] = buildAgentApprovalAlerts(
      [
        {
          id: "abc",
          status: "pending",
          reason: "duplicate task",
          expiresAt: "2026-09-10T14:10:00Z",
          summary: { label: "Old task" },
          live: { label: "Old task", impact: { entryCount: 3, totalMinutes: 130 } },
        },
      ],
      now,
    );
    expect(alert).toMatchObject({
      id: "alert-agent-action-abc",
      type: "agent_approval",
      severity: "warning",
      title: "Agent wants to delete Old task",
      href: "/settings/agent",
      actionLabel: "Review",
      read: false,
    });
    expect(alert.message).toBe("3 entries, 2h 10m; expires in 2h 10m. agent says: duplicate task");
  });

  it("falls back to the request summary and skips non-pending actions", () => {
    const alerts = buildAgentApprovalAlerts(
      [
        { id: "a", status: "pending", reason: null, expiresAt: null, summary: { label: "X", impact: { minutes: 45 } }, live: null },
        { id: "b", status: "executed", reason: null, expiresAt: null, summary: { label: "Y" } },
      ],
      now,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toBe("45m");
  });
});

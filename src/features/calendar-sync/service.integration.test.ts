import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/server/db";
import { seedBasics, testDb, setupTestDb } from "@/test/pglite-db";

const google = vi.hoisted(() => ({
  listUserCalendars: vi.fn(),
  fetchCalendarEvents: vi.fn(),
  createGoogleCalendarEvent: vi.fn(),
  patchGoogleCalendarEvent: vi.fn(),
  deleteGoogleCalendarEvent: vi.fn(),
}));

vi.mock("@/server/db", async () => (await import("@/test/pglite-db")).dbModuleMock());
vi.mock("./google", () => google);

import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarConfig,
  getCalendarSchedule,
  importCalendarEvents,
  listCalendarEvents,
  updateCalendarConfig,
  updateCalendarEvent,
} from "./service";
import { getDaySummary } from "@/features/daily-summary/service";
import { markSynced } from "@/features/sheets-sync/service";

const { calendarConfigs, calendarEvents, dailyAttendance, tasks, timeEntries, users } = schema;
const TZ = "Asia/Jakarta";

setupTestDb();

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

async function giveGoogleAuth(userId: string) {
  await testDb.update(users).set({ googleRefreshToken: "refresh", googleScopes: "openid https://www.googleapis.com/auth/calendar.events" }).where(eq(users.id, userId));
}

describe("calendar config", () => {
  it("returns defaults with no row, and reports hasGoogleAuth from tokens", async () => {
    const { userId } = await seedBasics();
    const before = await getCalendarConfig(userId);
    expect(before).toMatchObject({ id: "", calendarId: "primary", syncEnabled: false, hasGoogleAuth: false });
    await giveGoogleAuth(userId);
    expect((await getCalendarConfig(userId)).hasGoogleAuth).toBe(true);
  });

  it("updateCalendarConfig inserts then updates only the given fields", async () => {
    const { userId } = await seedBasics();
    const created = await updateCalendarConfig(userId, { calendarId: "work", calendarName: "Work" });
    expect(created).toMatchObject({ calendarId: "work", calendarName: "Work", syncEnabled: true });
    const updated = await updateCalendarConfig(userId, { syncEnabled: false, categoryRules: [{ k: 1 }] });
    expect(updated).toMatchObject({ calendarId: "work", syncEnabled: false, categoryRules: [{ k: 1 }] });
    expect(updated.id).toBe(created.id);
    expect(await testDb.select().from(calendarConfigs)).toHaveLength(1);
  });
});

describe("local event CRUD without Google auth", () => {
  const input = { title: "Standup", startAt: "2026-01-05T02:00:00Z", endAt: "2026-01-05T02:30:00Z" };

  it("create persists locally and never calls Google", async () => {
    const { userId, categoryId } = await seedBasics();
    const { event: dto } = await createCalendarEvent(userId, { ...input, categoryId, guests: ["a@x.com"] }, TZ);
    expect(google.createGoogleCalendarEvent).not.toHaveBeenCalled();
    expect(dto).toMatchObject({ title: "Standup", googleEventId: null, categoryId, status: "confirmed" });
    expect(dto.categoryName).toBe("Development");
    expect(dto.guests).toEqual([{ email: "a@x.com", displayName: null, responseStatus: null }]);
    expect(await testDb.select().from(calendarEvents)).toHaveLength(1);
  });

  it("create validates dates", async () => {
    const { userId } = await seedBasics();
    await expect(createCalendarEvent(userId, { ...input, startAt: "nope" }, TZ)).rejects.toThrow("Invalid start or end date format");
    await expect(createCalendarEvent(userId, { ...input, endAt: input.startAt }, TZ)).rejects.toThrow("End time must be after start time");
    expect(await testDb.select().from(calendarEvents)).toHaveLength(0);
  });

  it("update changes provided fields, keeps others, and rejects bad ranges / foreign events", async () => {
    const a = await seedBasics();
    const b = await seedBasics();
    const { event: dto } = await createCalendarEvent(a.userId, input, TZ);
    const { event: updated } = await updateCalendarEvent(a.userId, dto.id, { title: "Retro" }, TZ);
    expect(updated.title).toBe("Retro");
    expect(updated.startAt).toBe(dto.startAt);
    await expect(
      updateCalendarEvent(a.userId, dto.id, { endAt: "2026-01-05T01:00:00Z" }, TZ),
    ).rejects.toThrow("End time must be after start time");
    await expect(updateCalendarEvent(b.userId, dto.id, { title: "x" }, TZ)).rejects.toThrow("Event not found");
    expect(google.patchGoogleCalendarEvent).not.toHaveBeenCalled();
  });

  it("delete removes own event, returns false for unknown/foreign", async () => {
    const a = await seedBasics();
    const b = await seedBasics();
    const { event: dto } = await createCalendarEvent(a.userId, input, TZ);
    expect((await deleteCalendarEvent(b.userId, dto.id)).deleted).toBe(false);
    expect(await testDb.select().from(calendarEvents)).toHaveLength(1);
    expect((await deleteCalendarEvent(a.userId, dto.id)).deleted).toBe(true);
    expect(await testDb.select().from(calendarEvents)).toHaveLength(0);
    expect(google.deleteGoogleCalendarEvent).not.toHaveBeenCalled();
  });
});

describe("Google-connected event CRUD (Google layer mocked)", () => {
  it("create stores Google ids/meet link/guests returned by the API", async () => {
    const { userId } = await seedBasics();
    await giveGoogleAuth(userId);
    google.createGoogleCalendarEvent.mockResolvedValue({
      googleEventId: "g1",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      htmlLink: "https://cal/g1",
      status: "confirmed",
      guests: [{ email: "a@x.com", displayName: "A", responseStatus: "needsAction" }],
    });
    const { event: dto } = await createCalendarEvent(
      userId,
      { title: "Sync", startAt: "2026-01-05T02:00:00Z", endAt: "2026-01-05T03:00:00Z", createMeet: true, guests: ["a@x.com"] },
      TZ,
    );
    expect(google.createGoogleCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId, title: "Sync", sendUpdates: "all", createMeet: true }),
    );
    expect(dto.googleEventId).toBe("g1");
    expect(dto.meetUrl).toBe("https://meet.google.com/abc-defg-hij");
    const [row] = await testDb.select().from(calendarEvents);
    expect(row.googleEventId).toBe("g1");
    expect(row.guests).toEqual([{ email: "a@x.com", displayName: "A", responseStatus: "needsAction" }]);
  });

  it("create still saves locally when the Google call fails", async () => {
    const { userId } = await seedBasics();
    await giveGoogleAuth(userId);
    google.createGoogleCalendarEvent.mockRejectedValue(new Error("boom"));
    const { event: dto } = await createCalendarEvent(userId, { title: "X", startAt: "2026-01-05T02:00:00Z", endAt: "2026-01-05T03:00:00Z" }, TZ);
    expect(dto.googleEventId).toBeNull();
    expect(await testDb.select().from(calendarEvents)).toHaveLength(1);
  });

  it("update patches Google for linked events and keeps local data when it fails", async () => {
    const { userId } = await seedBasics();
    await giveGoogleAuth(userId);
    const [evt] = await testDb
      .insert(calendarEvents)
      .values({ userId, googleEventId: "g1", title: "Old", startAt: new Date("2026-01-05T02:00:00Z"), endAt: new Date("2026-01-05T03:00:00Z") })
      .returning();
    google.patchGoogleCalendarEvent.mockResolvedValueOnce({
      googleEventId: "g1", meetUrl: "https://meet.google.com/aaa-bbbb-ccc", htmlLink: "https://cal/g1", status: "confirmed", guests: [],
    });
    const { event: updated } = await updateCalendarEvent(userId, evt.id, { title: "New" }, TZ);
    expect(google.patchGoogleCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({ googleEventId: "g1", title: "New" }));
    expect(updated.meetUrl).toBe("https://meet.google.com/aaa-bbbb-ccc");
    google.patchGoogleCalendarEvent.mockRejectedValueOnce(new Error("down"));
    const { event: again } = await updateCalendarEvent(userId, evt.id, { title: "Newer" }, TZ);
    expect(again.title).toBe("Newer");
  });

  it("delete calls Google for linked events and still deletes locally on Google failure", async () => {
    const { userId } = await seedBasics();
    await giveGoogleAuth(userId);
    const [evt] = await testDb
      .insert(calendarEvents)
      .values({ userId, googleEventId: "g1", title: "T", startAt: new Date(), endAt: new Date() })
      .returning();
    google.deleteGoogleCalendarEvent.mockRejectedValue(new Error("down"));
    expect((await deleteCalendarEvent(userId, evt.id)).deleted).toBe(true);
    expect(google.deleteGoogleCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({ googleEventId: "g1" }));
    expect(await testDb.select().from(calendarEvents)).toHaveLength(0);
  });
});

describe("listCalendarEvents", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    id: "g1",
    summary: "Planning",
    start: { dateTime: "2026-01-05T02:00:00Z" },
    end: { dateTime: "2026-01-05T03:00:00Z" },
    ...over,
  });

  it("without syncWithGoogle only reads the DB, filtered by range and ordered", async () => {
    const { userId } = await seedBasics();
    const mk = (title: string, s: string, e: string) =>
      testDb.insert(calendarEvents).values({ userId, title, startAt: new Date(s), endAt: new Date(e) });
    await mk("late", "2026-01-05T10:00:00Z", "2026-01-05T11:00:00Z");
    await mk("early", "2026-01-05T01:00:00Z", "2026-01-05T02:00:00Z");
    await mk("other-day", "2026-01-09T01:00:00Z", "2026-01-09T02:00:00Z");
    const list = await listCalendarEvents(userId, { from: "2026-01-05T00:00:00Z", to: "2026-01-05T23:59:59Z" });
    expect(list.map((e) => e.title)).toEqual(["early", "late"]);
    expect(google.fetchCalendarEvents).not.toHaveBeenCalled();
  });

  it("sync inserts new Google events with rule-based category and sets lastSyncAt", async () => {
    const { userId } = await seedBasics();
    await giveGoogleAuth(userId);
    await updateCalendarConfig(userId, { syncEnabled: true });
    google.fetchCalendarEvents.mockResolvedValue([raw()]);
    const list = await listCalendarEvents(userId, { syncWithGoogle: true, from: "2026-01-05T00:00:00Z", to: "2026-01-06T00:00:00Z" });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ googleEventId: "g1", title: "Planning", allDay: false });
    const [cfg] = await testDb.select().from(calendarConfigs);
    expect(cfg.lastSyncAt).not.toBeNull();
  });

  it("sync is idempotent and updates existing rows instead of duplicating (unique user+googleEventId)", async () => {
    const { userId } = await seedBasics();
    await giveGoogleAuth(userId);
    await updateCalendarConfig(userId, { syncEnabled: true });
    const opts = { syncWithGoogle: true, from: "2026-01-05T00:00:00Z", to: "2026-01-06T00:00:00Z" };
    google.fetchCalendarEvents.mockResolvedValueOnce([raw()]);
    await listCalendarEvents(userId, opts);
    google.fetchCalendarEvents.mockResolvedValueOnce([raw({ summary: "Renamed", end: { dateTime: "2026-01-05T04:00:00Z" } })]);
    const list = await listCalendarEvents(userId, opts);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Renamed");
    expect(list[0].endAt).toBe("2026-01-05T04:00:00.000Z");
  });

  it("all-day Google events are stored with allDay=true", async () => {
    const { userId } = await seedBasics();
    await giveGoogleAuth(userId);
    await updateCalendarConfig(userId, { syncEnabled: true });
    google.fetchCalendarEvents.mockResolvedValue([
      raw({ id: "g2", summary: "Holiday", start: { date: "2026-01-05" }, end: { date: "2026-01-06" } }),
    ]);
    const list = await listCalendarEvents(userId, { syncWithGoogle: true });
    expect(list.find((e) => e.googleEventId === "g2")?.allDay).toBe(true);
  });

  it("a Google fetch failure is swallowed and DB contents are still returned", async () => {
    const { userId } = await seedBasics();
    await giveGoogleAuth(userId);
    await updateCalendarConfig(userId, { syncEnabled: true });
    await testDb.insert(calendarEvents).values({ userId, title: "Local", startAt: new Date(), endAt: new Date() });
    google.fetchCalendarEvents.mockRejectedValue(new Error("network"));
    const list = await listCalendarEvents(userId, { syncWithGoogle: true });
    expect(list.map((e) => e.title)).toEqual(["Local"]);
  });
});

describe("getCalendarSchedule", () => {
  it("falls back to locally stored events when sync is off", async () => {
    const { userId } = await seedBasics();
    await testDb.insert(calendarEvents).values({
      userId, title: "Design review", startAt: new Date("2026-01-05T02:00:00Z"), endAt: new Date("2026-01-05T03:00:00Z"),
    });
    const res = await getCalendarSchedule(userId, "2026-01-05", TZ);
    expect(google.fetchCalendarEvents).not.toHaveBeenCalled();
    expect(res.events).toHaveLength(1);
    expect(res.events[0].title).toBe("Design review");
  });

  it("returns no events and no Google call when nothing is stored", async () => {
    const { userId } = await seedBasics();
    const res = await getCalendarSchedule(userId, "2026-01-05", TZ);
    expect(res.events).toEqual([]);
    expect(res.hasGoogleAuth).toBe(false);
  });

  it("uses the Google layer when connected and returns [] if it throws", async () => {
    const { userId } = await seedBasics();
    await giveGoogleAuth(userId);
    await updateCalendarConfig(userId, { syncEnabled: true });
    google.fetchCalendarEvents.mockResolvedValueOnce([
      { id: "g1", summary: "Call", start: { dateTime: "2026-01-05T02:00:00Z" }, end: { dateTime: "2026-01-05T03:00:00Z" } },
    ]);
    const ok = await getCalendarSchedule(userId, "2026-01-05", TZ);
    expect(ok.events).toHaveLength(1);
    google.fetchCalendarEvents.mockRejectedValueOnce(new Error("x"));
    const failed = await getCalendarSchedule(userId, "2026-01-05", TZ);
    expect(failed.events).toEqual([]);
  });
});

describe("importCalendarEvents", () => {
  it("creates tasks, completed manual entries and attendance bounds", async () => {
    const { userId, categoryId } = await seedBasics();
    const [cat] = await testDb.select().from(schema.categories);
    const res = await importCalendarEvents(userId, {
      events: [
        { title: " Standup ", categoryKey: cat.key, startedAt: "2026-01-05T02:00:00Z", endedAt: "2026-01-05T02:30:00Z", notes: " n " },
        { title: "Planning", categoryKey: "unknown", startedAt: "2026-01-05T04:00:00Z", endedAt: "2026-01-05T05:00:00Z" },
      ],
    } as never);
    expect(res.importedCount).toBe(2);
    expect(res.createdTaskIds).toHaveLength(2);
    const entries = await testDb.select().from(timeEntries);
    expect(entries.every((e) => e.status === "completed" && e.source === "manual" && e.categoryId === categoryId)).toBe(true);
    expect(entries.find((e) => e.notes === "n")).toBeDefined();
    expect((await testDb.select().from(tasks)).map((t) => t.name).sort()).toEqual(["Planning", "Standup"]);
    const [att] = await testDb.select().from(dailyAttendance);
    expect(att.workDate).toBe("2026-01-05");
    expect(att.status).toBe("closed");
    expect(att.clockInAt).toEqual(new Date("2026-01-05T02:00:00Z"));
    expect(att.clockOutAt).toEqual(new Date("2026-01-05T05:00:00Z"));
  });

  it("reuses an existing task of the same name", async () => {
    const { userId, categoryId } = await seedBasics();
    await testDb.insert(tasks).values({ userId, name: "Standup", categoryId });
    const [cat] = await testDb.select().from(schema.categories);
    const res = await importCalendarEvents(userId, {
      events: [{ title: "Standup", categoryKey: cat.key, startedAt: "2026-01-05T02:00:00Z", endedAt: "2026-01-05T02:30:00Z" }],
    } as never);
    expect(res.createdTaskIds).toHaveLength(0);
    expect(await testDb.select().from(tasks)).toHaveLength(1);
    expect(await testDb.select().from(timeEntries)).toHaveLength(1);
  });

  it("empty import is a no-op", async () => {
    const { userId } = await seedBasics();
    const res = await importCalendarEvents(userId, { events: [] } as never);
    expect(res.importedCount).toBe(0);
    expect(await testDb.select().from(dailyAttendance)).toHaveLength(0);
  });

  describe("idempotency and day bookkeeping", () => {
    const item = (over: Record<string, unknown> = {}) => ({
      eventId: "evt-1",
      title: "Standup",
      categoryKey: "unknown",
      startedAt: "2026-01-05T02:00:00Z",
      endedAt: "2026-01-05T02:30:00Z",
      ...over,
    });
    const run = (userId: string, events: Record<string, unknown>[]) =>
      importCalendarEvents(userId, { events } as never);

    it("re-importing the same payload skips it and keeps one entry", async () => {
      const { userId } = await seedBasics();
      const first = await run(userId, [item()]);
      expect(first).toMatchObject({ importedCount: 1, skippedCount: 0, skippedEventIds: [] });
      const second = await run(userId, [item()]);
      expect(second).toMatchObject({ importedCount: 0, skippedCount: 1, skippedEventIds: ["evt-1"] });
      expect(second.createdEntryIds).toEqual([]);
      expect(await testDb.select().from(timeEntries)).toHaveLength(1);
    });

    it("the schedule still reports the imported event as isImported", async () => {
      const { userId } = await seedBasics();
      await testDb.insert(calendarEvents).values({
        userId, title: "Standup", startAt: new Date("2026-01-05T02:00:00Z"), endAt: new Date("2026-01-05T02:30:00Z"),
      });
      await run(userId, [item()]);
      const res = await getCalendarSchedule(userId, "2026-01-05", TZ);
      expect(res.events).toHaveLength(1);
      expect(res.events[0].isImported).toBe(true);
    });

    it("same title with an end time 3 minutes different is imported", async () => {
      const { userId } = await seedBasics();
      await run(userId, [item()]);
      const res = await run(userId, [item({ eventId: "evt-2", endedAt: "2026-01-05T02:33:00Z" })]);
      expect(res).toMatchObject({ importedCount: 1, skippedCount: 0 });
      expect(await testDb.select().from(timeEntries)).toHaveLength(2);
    });

    it("an identical entry of another user does not cause a skip", async () => {
      const a = await seedBasics();
      const b = await seedBasics();
      await run(a.userId, [item()]);
      const res = await run(b.userId, [item()]);
      expect(res).toMatchObject({ importedCount: 1, skippedCount: 0 });
      const entries = await testDb.select().from(timeEntries);
      expect(entries).toHaveLength(2);
      expect(entries.filter((e) => e.userId === b.userId)).toHaveLength(1);
    });

    it("two identical items in one request insert one row", async () => {
      const { userId } = await seedBasics();
      const res = await run(userId, [item(), item({ eventId: "evt-dup" })]);
      expect(res).toMatchObject({ importedCount: 1, skippedCount: 1, skippedEventIds: ["evt-dup"] });
      expect(await testDb.select().from(timeEntries)).toHaveLength(1);
    });

    it("concurrent identical imports produce exactly one entry and one task", async () => {
      // PGlite serialises transactions: this proves the dedupe + task upsert path,
      // not the FOR NO KEY UPDATE row lock (verified by code review).
      const { userId } = await seedBasics();
      const results = await Promise.all([run(userId, [item()]), run(userId, [item()])]);
      expect(results.map((r) => r.importedCount).sort()).toEqual([0, 1]);
      expect(await testDb.select().from(timeEntries)).toHaveLength(1);
      expect(await testDb.select().from(tasks)).toHaveLength(1);
    });

    it("an existing task keeps its status and startedAt (no upsertTask side effects)", async () => {
      const { userId, categoryId } = await seedBasics();
      await testDb.insert(tasks).values({ userId, name: "Standup", categoryId, status: "todo" });
      const res = await run(userId, [item()]);
      expect(res.createdTaskIds).toEqual([]);
      const [task] = await testDb.select().from(tasks);
      expect(task.status).toBe("todo");
      expect(task.startedAt).toBeNull();
      expect(task.lastUsedAt).not.toBeNull();
    });

    it("a synced day becomes changed_after_sync after an import", async () => {
      const { userId } = await seedBasics();
      await testDb.insert(dailyAttendance).values({
        userId,
        workDate: "2026-01-05",
        clockInAt: new Date("2026-01-05T01:00:00Z"),
        clockOutAt: new Date("2026-01-05T10:00:00Z"),
        status: "closed",
        reviewState: "synced",
      });
      await run(userId, [item()]);
      const [att] = await testDb.select().from(dailyAttendance);
      expect(att.reviewState).toBe("changed_after_sync");
    });

    it("a fully skipped import leaves attendance untouched", async () => {
      const { userId } = await seedBasics();
      await run(userId, [item()]);
      // Narrow the bounds so any expandAttendanceBounds call would widen them again.
      const clockInAt = new Date("2026-01-05T02:10:00Z");
      const clockOutAt = new Date("2026-01-05T02:20:00Z");
      await testDb
        .update(dailyAttendance)
        .set({ clockInAt, clockOutAt, reviewState: "synced" })
        .where(eq(dailyAttendance.userId, userId));
      const res = await run(userId, [item()]);
      expect(res.skippedCount).toBe(1);
      const [att] = await testDb.select().from(dailyAttendance);
      expect(att.clockInAt).toEqual(clockInAt);
      expect(att.clockOutAt).toEqual(clockOutAt);
      expect(att.reviewState).toBe("synced");
    });

    it("an edited title is skipped when sourceTitle matches an existing entry", async () => {
      const { userId } = await seedBasics();
      await run(userId, [item({ title: "Sync" })]);
      const res = await run(userId, [item({ title: "Weekly planning", sourceTitle: "Sync" })]);
      expect(res).toMatchObject({ importedCount: 0, skippedCount: 1 });
      expect(await testDb.select().from(timeEntries)).toHaveLength(1);
    });

    it("an edited title without sourceTitle is imported (known limitation)", async () => {
      const { userId } = await seedBasics();
      await run(userId, [item({ title: "Sync" })]);
      const res = await run(userId, [item({ title: "Weekly planning" })]);
      expect(res).toMatchObject({ importedCount: 1, skippedCount: 0 });
      expect(await testDb.select().from(timeEntries)).toHaveLength(2);
    });

    it("an empty sourceTitle is treated as absent", async () => {
      const { userId } = await seedBasics();
      await run(userId, [item({ title: "Sync" })]);
      const res = await run(userId, [item({ title: "Weekly planning", sourceTitle: "" })]);
      expect(res).toMatchObject({ importedCount: 1, skippedCount: 0 });
    });
  });
});

describe("importCalendarEvents and day needsSync", () => {
  // Future instants so DB-side `now()` defaults (real clock) are older than
  // every faked app timestamp.
  const DAY = "2030-03-04";
  const T1 = new Date("2030-03-04T06:00:00Z");
  const T2 = new Date("2030-03-04T07:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-03-04T05:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an import after markSynced flags the day as needing sync", async () => {
    const { userId } = await seedBasics();
    const event = (eventId: string, startedAt: string, endedAt: string) => ({
      eventId, title: `Meeting ${eventId}`, categoryKey: "unknown", startedAt, endedAt,
    });
    await importCalendarEvents(userId, {
      events: [event("evt-1", "2030-03-04T02:00:00Z", "2030-03-04T02:30:00Z")],
    } as never);

    vi.setSystemTime(T1);
    await markSynced(userId, DAY, { syncedAt: T1 });
    expect((await getDaySummary(userId, DAY, TZ)).needsSync).toBe(false);

    vi.setSystemTime(T2);
    const res = await importCalendarEvents(userId, {
      events: [event("evt-2", "2030-03-04T03:00:00Z", "2030-03-04T03:30:00Z")],
    } as never);
    expect(res.importedCount).toBe(1);
    const summary = await getDaySummary(userId, DAY, TZ);
    expect(summary.needsSync).toBe(true);
    expect(summary.lastSyncedAt).toBe(T1.toISOString());
  });
});

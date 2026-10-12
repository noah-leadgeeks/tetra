import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/server/db";
import { seedBasics, setupTestDb, testDb } from "@/test/pglite-db";

// Only the googleapis client is mocked; the real google.ts helpers run.
const events = vi.hoisted(() => ({
  insert: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/server/db", async () => (await import("@/test/pglite-db")).dbModuleMock());
vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        setCredentials: vi.fn(),
        on: vi.fn(),
        refreshAccessToken: vi.fn(),
      })),
    },
    calendar: vi.fn().mockImplementation(() => ({ events })),
  },
}));

import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarConfig,
  hasCalendarWriteScope,
  updateCalendarEvent,
} from "./service";

const { calendarEvents, users } = schema;
const TZ = "Asia/Jakarta";
const READONLY = "openid email https://www.googleapis.com/auth/calendar.readonly";
const WRITE = `${READONLY} https://www.googleapis.com/auth/calendar.events`;
const input = { title: "Sync", startAt: "2026-01-05T02:00:00Z", endAt: "2026-01-05T03:00:00Z" };

setupTestDb();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

async function link(userId: string, scopes: string | null) {
  await testDb
    .update(users)
    .set({
      googleAccessToken: "at",
      googleRefreshToken: "rt",
      googleTokenExpiresAt: new Date(Date.now() + 3600_000),
      googleScopes: scopes,
    })
    .where(eq(users.id, userId));
}

async function linkedEvent(userId: string) {
  const [evt] = await testDb
    .insert(calendarEvents)
    .values({ userId, googleEventId: "g1", title: "Old", startAt: new Date("2026-01-05T02:00:00Z"), endAt: new Date("2026-01-05T03:00:00Z") })
    .returning();
  return evt;
}

describe("hasCalendarWriteScope", () => {
  it("matches exact scopes only", () => {
    expect(hasCalendarWriteScope(READONLY)).toBe(false);
    expect(hasCalendarWriteScope(WRITE)).toBe(true);
    expect(hasCalendarWriteScope("https://www.googleapis.com/auth/calendar")).toBe(true);
    expect(hasCalendarWriteScope(null)).toBe(false);
  });

  it("getCalendarConfig derives canWriteGoogle from stored scopes", async () => {
    const { userId } = await seedBasics();
    expect((await getCalendarConfig(userId)).canWriteGoogle).toBe(false);
    await link(userId, null);
    expect((await getCalendarConfig(userId)).canWriteGoogle).toBe(false);
    await link(userId, READONLY);
    expect((await getCalendarConfig(userId)).canWriteGoogle).toBe(false);
    await link(userId, WRITE);
    expect((await getCalendarConfig(userId)).canWriteGoogle).toBe(true);
  });
});

describe("missing_scope: no Google call", () => {
  it("create/update/delete write locally and report missing_scope", async () => {
    const { userId } = await seedBasics();
    await link(userId, READONLY);

    const created = await createCalendarEvent(userId, input, TZ);
    expect(created.google).toEqual({ synced: false, error: "missing_scope" });
    expect(created.event.googleEventId).toBeNull();

    const evt = await linkedEvent(userId);
    const updated = await updateCalendarEvent(userId, evt.id, { title: "New" }, TZ);
    expect(updated.google).toEqual({ synced: false, error: "missing_scope" });
    expect(updated.event.title).toBe("New");

    const deleted = await deleteCalendarEvent(userId, evt.id);
    expect(deleted).toEqual({ deleted: true, google: { synced: false, error: "missing_scope" } });
    expect(await testDb.select().from(calendarEvents).where(eq(calendarEvents.id, evt.id))).toHaveLength(0);

    expect(events.insert).not.toHaveBeenCalled();
    expect(events.patch).not.toHaveBeenCalled();
    expect(events.delete).not.toHaveBeenCalled();
  });

  it("unlinked users report not_linked", async () => {
    const { userId } = await seedBasics();
    const created = await createCalendarEvent(userId, input, TZ);
    expect(created.google).toEqual({ synced: false, error: "not_linked" });
  });
});

describe("with calendar.events scope", () => {
  it("create success is synced and stores Google ids", async () => {
    const { userId } = await seedBasics();
    await link(userId, WRITE);
    events.insert.mockResolvedValue({ data: { id: "g9", htmlLink: "https://cal/g9", status: "confirmed" } });
    const res = await createCalendarEvent(userId, input, TZ);
    expect(events.insert).toHaveBeenCalledTimes(1);
    expect(res.google).toEqual({ synced: true, error: null });
    expect(res.event.googleEventId).toBe("g9");
  });

  it("create failure keeps the local row and carries the message", async () => {
    const { userId } = await seedBasics();
    await link(userId, WRITE);
    events.insert.mockRejectedValue(new Error("Insufficient Permission"));
    const res = await createCalendarEvent(userId, input, TZ);
    expect(res.google).toEqual({ synced: false, error: "Insufficient Permission" });
    expect(await testDb.select().from(calendarEvents)).toHaveLength(1);
  });

  it("update success and failure", async () => {
    const { userId } = await seedBasics();
    await link(userId, WRITE);
    const evt = await linkedEvent(userId);
    events.patch.mockResolvedValueOnce({ data: { id: "g1", status: "confirmed" } });
    expect((await updateCalendarEvent(userId, evt.id, { title: "A" }, TZ)).google).toEqual({ synced: true, error: null });
    events.patch.mockRejectedValueOnce(new Error("down"));
    const failed = await updateCalendarEvent(userId, evt.id, { title: "B" }, TZ);
    expect(failed.google).toEqual({ synced: false, error: "down" });
    expect(failed.event.title).toBe("B");
  });

  it("update and delete honour the stored sendUpdates for guest notifications", async () => {
    const { userId } = await seedBasics();
    await link(userId, WRITE);
    const evt = await linkedEvent(userId);
    await testDb.update(calendarEvents).set({ sendUpdates: "none" }).where(eq(calendarEvents.id, evt.id));

    events.patch.mockResolvedValue({ data: { id: "g1", status: "confirmed" } });
    await updateCalendarEvent(userId, evt.id, { title: "A" }, TZ);
    expect(events.patch).toHaveBeenLastCalledWith(expect.objectContaining({ sendUpdates: "none" }));

    // An explicit value on the request still wins.
    await updateCalendarEvent(userId, evt.id, { title: "B", sendUpdates: "all" }, TZ);
    expect(events.patch).toHaveBeenLastCalledWith(expect.objectContaining({ sendUpdates: "all" }));

    await testDb.update(calendarEvents).set({ sendUpdates: "none" }).where(eq(calendarEvents.id, evt.id));
    events.delete.mockResolvedValue({});
    await deleteCalendarEvent(userId, evt.id);
    expect(events.delete).toHaveBeenLastCalledWith(expect.objectContaining({ sendUpdates: "none" }));

    const evt2 = await linkedEvent(userId);
    await testDb.update(calendarEvents).set({ sendUpdates: "all" }).where(eq(calendarEvents.id, evt2.id));
    await deleteCalendarEvent(userId, evt2.id);
    expect(events.delete).toHaveBeenLastCalledWith(expect.objectContaining({ sendUpdates: "all" }));
  });

  it("delete: success, gone (404/410) and failure", async () => {
    const { userId } = await seedBasics();
    await link(userId, WRITE);

    events.delete.mockResolvedValueOnce({});
    let evt = await linkedEvent(userId);
    expect((await deleteCalendarEvent(userId, evt.id)).google).toEqual({ synced: true, error: null });

    for (const code of [404, 410]) {
      events.delete.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { code }));
      evt = await linkedEvent(userId);
      const res = await deleteCalendarEvent(userId, evt.id);
      expect(res.google).toEqual({ synced: true, error: null });
      expect(res.deleted).toBe(true);
    }

    events.delete.mockRejectedValueOnce(new Error("boom"));
    evt = await linkedEvent(userId);
    const failed = await deleteCalendarEvent(userId, evt.id);
    expect(failed).toEqual({ deleted: true, google: { synced: false, error: "boom" } });
    expect(await testDb.select().from(calendarEvents).where(eq(calendarEvents.id, evt.id))).toHaveLength(0);
  });
});

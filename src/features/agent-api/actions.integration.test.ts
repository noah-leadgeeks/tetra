import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { schema } from "@/server/db";
import { seedBasics, setupTestDb, testDb } from "@/test/pglite-db";

const mocks = vi.hoisted(() => ({
  syncDaysAfterChange: vi.fn(),
  executeSync: vi.fn(),
  deleteGoogleCalendarEvent: vi.fn(),
}));

vi.mock("@/server/db", async () => (await import("@/test/pglite-db")).dbModuleMock());
vi.mock("@/server/auth", () => ({
  isAuthBypassActive: () =>
    process.env.DISABLE_AUTH === "true" || process.env.NEXT_PUBLIC_DISABLE_AUTH === "true",
}));
// Nothing may reach Google Sheets or Calendar.
vi.mock("@/features/sheets-sync/auto-sync-server", () => ({
  syncDaysAfterChange: mocks.syncDaysAfterChange,
}));
vi.mock("@/features/sheets-sync/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/sheets-sync/service")>()),
  executeSync: mocks.executeSync,
}));
vi.mock("@/features/calendar-sync/google", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/calendar-sync/google")>()),
  deleteGoogleCalendarEvent: mocks.deleteGoogleCalendarEvent,
}));
// Real delete services, wrapped so calls can be counted.
vi.mock("@/features/activities/entry-mutations", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/features/activities/entry-mutations")>();
  return { ...m, deleteTask: vi.fn(m.deleteTask), deleteEntry: vi.fn(m.deleteEntry) };
});
vi.mock("@/features/attendance/service", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/features/attendance/service")>();
  return { ...m, deleteBreak: vi.fn(m.deleteBreak) };
});
vi.mock("@/features/calendar-sync/service", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/features/calendar-sync/service")>();
  return { ...m, deleteCalendarEvent: vi.fn(m.deleteCalendarEvent) };
});

import { deleteEntry, deleteTask } from "@/features/activities/entry-mutations";
import { deleteBreak } from "@/features/attendance/service";
import { deleteCalendarEvent } from "@/features/calendar-sync/service";
import {
  approveAction,
  deepEqual,
  getAction,
  listActions,
  rejectAction,
  requestDelete,
  type RequestDeleteContext,
} from "./actions";
import { mapAgentError } from "./http";
import { createApiToken, revokeApiToken } from "./tokens";

const { agentActions, breakEntries, calendarEvents, dailyAttendance, tasks, timeEntries } = schema;

setupTestDb();

const TZ = "Asia/Jakarta";
const OLD = new Date("2026-01-01T00:00:00Z");
// Jakarta (UTC+7) local days 2026-10-10 and 2026-10-11.
const DAY1 = "2026-10-10";
const DAY2 = "2026-10-11";

let userId: string;
let categoryId: string;
let ctx: RequestDeleteContext;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.syncDaysAfterChange.mockImplementation(async (_u: string, days: string[]) =>
    Object.fromEntries(
      days.map((d) => [d, { attempted: true, success: true, idempotent: false, changedCount: 1 }]),
    ),
  );
  ({ userId, categoryId } = await seedBasics({ timezone: TZ }));
  const token = await createApiToken(userId, { name: "openclaw", scopes: ["delete"] });
  ctx = { userId, timezone: TZ, tokenId: token.id };
});

afterEach(() => {
  delete process.env.DISABLE_AUTH;
});

async function seedTask(name = "Write report") {
  const [task] = await testDb.insert(tasks).values({ userId, name, categoryId }).returning();
  return task;
}

async function seedEntry(taskId: string, startIso: string, endIso: string | null) {
  const [entry] = await testDb
    .insert(timeEntries)
    .values({
      userId,
      taskId,
      categoryId,
      startedAt: new Date(startIso),
      endedAt: endIso ? new Date(endIso) : null,
      status: endIso ? "completed" : "active",
      source: "manual",
    })
    .returning();
  return entry;
}

async function seedAttendance(workDate: string, clockInIso: string) {
  const [att] = await testDb
    .insert(dailyAttendance)
    .values({ userId, workDate, clockInAt: new Date(clockInIso), updatedAt: OLD })
    .returning();
  return att;
}

/** Task with one entry on each of DAY1 and DAY2, plus attendance rows for both days. */
async function seedTaskWithTwoDays() {
  const task = await seedTask();
  await seedAttendance(DAY1, "2026-10-10T01:00:00Z");
  await seedAttendance(DAY2, "2026-10-11T01:00:00Z");
  await seedEntry(task.id, "2026-10-10T02:00:00Z", "2026-10-10T03:00:00Z");
  await seedEntry(task.id, "2026-10-11T02:00:00Z", "2026-10-11T02:30:00Z");
  return task;
}

async function seedEvent(over: Partial<typeof calendarEvents.$inferInsert> = {}) {
  const [ev] = await testDb
    .insert(calendarEvents)
    .values({
      userId,
      title: "Standup",
      startAt: new Date("2026-10-12T02:00:00Z"),
      endAt: new Date("2026-10-12T02:15:00Z"),
      googleEventId: "g-123",
      htmlLink: "https://calendar.google.com/x",
      ...over,
    })
    .returning();
  return ev;
}

async function rowById(id: string) {
  const [r] = await testDb.select().from(agentActions).where(eq(agentActions.id, id));
  return r;
}

async function statusOf(err: unknown): Promise<number> {
  return mapAgentError(err).status;
}

async function expectStatus(p: Promise<unknown>, status: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "expected rejection").not.toBeNull();
  expect(await statusOf(err)).toBe(status);
  return err as Error & { action?: unknown };
}

describe("requestDelete", () => {
  it("creates a pending row and leaves the target in place", async () => {
    const task = await seedTaskWithTwoDays();
    const action = await requestDelete(ctx, { targetType: "task", targetId: task.id, reason: "dup" });

    expect(action.status).toBe("pending");
    expect(action.kind).toBe("task.delete");
    expect(action.tokenName).toBe("openclaw");
    expect(action.reason).toBe("dup");
    expect(action.summary.label).toBe("Write report");
    expect(action.summary.dayKeys).toEqual([DAY1, DAY2]);
    expect(action.summary.impact).toEqual({ entryCount: 2, totalMinutes: 90, activeEntry: false });
    expect(action.summary.fingerprint).toEqual({
      name: "Write report",
      completedMinutes: 90,
      activeEntryId: null,
    });
    expect(await testDb.select().from(tasks).where(eq(tasks.id, task.id))).toHaveLength(1);
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("defaults expiry to 24 h and honours expiresInMinutes", async () => {
    const task = await seedTask();
    const ev = await seedEvent();
    const before = Date.now();
    const a = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    const b = await requestDelete(ctx, { targetType: "calendar_event", targetId: ev.id, expiresInMinutes: 30 });
    const ttlA = new Date(a.expiresAt!).getTime() - before;
    const ttlB = new Date(b.expiresAt!).getTime() - before;
    expect(Math.abs(ttlA - 24 * 60 * 60_000)).toBeLessThan(10_000);
    expect(Math.abs(ttlB - 30 * 60_000)).toBeLessThan(10_000);
  });

  it.each([0, -5, 1441, 1.5])("rejects expiresInMinutes=%s with 400", async (ttl) => {
    const task = await seedTask();
    await expectStatus(
      requestDelete(ctx, { targetType: "task", targetId: task.id, expiresInMinutes: ttl }),
      400,
    );
    expect(await testDb.select().from(agentActions)).toHaveLength(0);
  });

  it("dedupes concurrent duplicate requests into one row", async () => {
    const task = await seedTask();
    const [a, b] = await Promise.all([
      requestDelete(ctx, { targetType: "task", targetId: task.id }),
      requestDelete(ctx, { targetType: "task", targetId: task.id }),
    ]);
    expect(a.id).toBe(b.id);
    expect(await testDb.select().from(agentActions)).toHaveLength(1);
  });

  it("retries once when the conflicting pending row has expired", async () => {
    const task = await seedTask();
    const first = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    // Still `pending` (not swept) but past expires_at: insert conflicts, the
    // re-select finds no live row, the single retry inserts a new one.
    await testDb.execute(
      sql`UPDATE agent_actions SET expires_at = now() - interval '1 minute' WHERE id = ${first.id}`,
    );
    const second = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending");
    const old = await rowById(first.id);
    expect(old.status).toBe("expired");
    expect(old.result).toEqual({ code: "expired" });
  });

  it("404s for a missing or foreign target", async () => {
    const task = await seedTask();
    const other = await seedBasics({ timezone: "UTC" });
    await expectStatus(
      requestDelete(
        { userId: other.userId, timezone: "UTC", tokenId: null },
        { targetType: "task", targetId: task.id },
      ),
      404,
    );
    await expectStatus(
      requestDelete(ctx, { targetType: "time_entry", targetId: "00000000-0000-4000-8000-000000000000" }),
      404,
    );
  });

  it("refuses with 403 auth_bypass while DISABLE_AUTH is on", async () => {
    const task = await seedTask();
    process.env.DISABLE_AUTH = "true";
    const err = await expectStatus(requestDelete(ctx, { targetType: "task", targetId: task.id }), 403);
    expect(await mapAgentError(err).json()).toMatchObject({ code: "auth_bypass" });
    expect(await testDb.select().from(agentActions)).toHaveLength(0);
  });
});

describe("approveAction", () => {
  it("deletes a time entry, marks it executed and syncs its day", async () => {
    const task = await seedTask();
    await seedAttendance(DAY1, "2026-10-10T01:00:00Z");
    const entry = await seedEntry(task.id, "2026-10-10T02:00:00Z", "2026-10-10T03:00:00Z");
    const pending = await requestDelete(ctx, { targetType: "time_entry", targetId: entry.id });
    expect(pending.summary.dayKeys).toEqual([DAY1]);

    const done = await approveAction(userId, pending.id);
    expect(done.status).toBe("executed");
    expect(done.resolvedAt).not.toBeNull();
    expect(done.result).toEqual({
      sheetSync: { [DAY1]: { attempted: true, success: true, idempotent: false, changedCount: 1 } },
    });
    expect(await testDb.select().from(timeEntries).where(eq(timeEntries.id, entry.id))).toHaveLength(0);
    expect(mocks.syncDaysAfterChange).toHaveBeenCalledWith(userId, [DAY1]);
    expect(mocks.executeSync).not.toHaveBeenCalled();
  });

  it("deletes a task without syncing, reports needsSync and bumps both days", async () => {
    const task = await seedTaskWithTwoDays();
    const pending = await requestDelete(ctx, { targetType: "task", targetId: task.id });

    const done = await approveAction(userId, pending.id);
    expect(done.status).toBe("executed");
    expect(done.result).toEqual({ needsSync: [DAY1, DAY2] });
    expect(await testDb.select().from(tasks).where(eq(tasks.id, task.id))).toHaveLength(0);
    expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
    const days = await testDb.select().from(dailyAttendance).where(eq(dailyAttendance.userId, userId));
    expect(days).toHaveLength(2);
    for (const d of days) expect(d.updatedAt.getTime()).toBeGreaterThan(OLD.getTime());

    // Idempotent re-approve: same row, no second delete.
    const again = await approveAction(userId, pending.id);
    expect(again).toEqual(done);
    expect(deleteTask).toHaveBeenCalledTimes(1);
  });

  it("deletes a break and syncs its work date", async () => {
    const att = await seedAttendance(DAY1, "2026-10-10T01:00:00Z");
    const [brk] = await testDb
      .insert(breakEntries)
      .values({
        userId,
        attendanceId: att.id,
        startedAt: new Date("2026-10-10T05:00:00Z"),
        endedAt: new Date("2026-10-10T05:30:00Z"),
      })
      .returning();
    const pending = await requestDelete(ctx, { targetType: "break", targetId: brk.id });
    expect(pending.summary.dayKeys).toEqual([DAY1]);
    expect(pending.summary.impact).toEqual({ minutes: 30 });

    const done = await approveAction(userId, pending.id);
    expect(done.status).toBe("executed");
    expect(deleteBreak).toHaveBeenCalledTimes(1);
    expect(mocks.syncDaysAfterChange).toHaveBeenCalledWith(userId, [DAY1]);
    expect(await testDb.select().from(breakEntries)).toHaveLength(0);
  });

  it("returns 409 while executing, and the sweep fails it after 5 minutes", async () => {
    const task = await seedTask();
    const pending = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    await testDb.execute(
      sql`UPDATE agent_actions SET status = 'executing', claimed_at = now() WHERE id = ${pending.id}`,
    );
    const err = await expectStatus(approveAction(userId, pending.id), 409);
    expect(err.message).toBe("Already executing");
    expect(deleteTask).not.toHaveBeenCalled();

    await testDb.execute(
      sql`UPDATE agent_actions SET claimed_at = now() - interval '6 minutes' WHERE id = ${pending.id}`,
    );
    const swept = await getAction(userId, pending.id);
    expect(swept.status).toBe("failed");
    expect(swept.result).toEqual({ code: "timeout", error: "execution timed out" });
    expect(await testDb.select().from(tasks)).toHaveLength(1);
  });

  it("expires overdue actions on poll and refuses to approve them", async () => {
    const task = await seedTask();
    const pending = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    await testDb.execute(
      sql`UPDATE agent_actions SET expires_at = now() - interval '1 second' WHERE id = ${pending.id}`,
    );
    const polled = await getAction(userId, pending.id);
    expect(polled.status).toBe("expired");
    expect(polled.result).toEqual({ code: "expired" });
    await expectStatus(approveAction(userId, pending.id), 409);
    expect(await testDb.select().from(tasks)).toHaveLength(1);
  });

  it("handles the race where the row is still pending but past expiry at claim time", async () => {
    const task = await seedTask();
    const pending = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    await testDb.execute(
      sql`UPDATE agent_actions SET expires_at = now() - interval '1 second' WHERE id = ${pending.id}`,
    );
    // Make the sweep's expiry UPDATE miss this row once, as if it ran just
    // before the deadline; the claim then finds the row pending-but-overdue.
    for (const stmt of [
      `CREATE TABLE test_skip_sweep (n int NOT NULL)`,
      `INSERT INTO test_skip_sweep VALUES (1)`,
      `CREATE FUNCTION test_skip_sweep_fn() RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'pending' AND NEW.status = 'expired'
           AND (SELECT n FROM test_skip_sweep) > 0 THEN
          UPDATE test_skip_sweep SET n = n - 1;
          RETURN NULL;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`,
      `CREATE TRIGGER test_skip_sweep_trg BEFORE UPDATE ON agent_actions
        FOR EACH ROW EXECUTE FUNCTION test_skip_sweep_fn()`,
    ]) {
      await testDb.execute(sql.raw(stmt));
    }
    try {
      const err = await expectStatus(approveAction(userId, pending.id), 409);
      expect(err.message).toBe("Action expired");
      const row = await rowById(pending.id);
      expect(row.status).toBe("expired");
      const [{ n }] = (await testDb.execute(sql`SELECT n FROM test_skip_sweep`)).rows as { n: number }[];
      expect(n).toBe(0); // the sweep really was skipped
      expect(await testDb.select().from(tasks)).toHaveLength(1);
    } finally {
      await testDb.execute(sql.raw(`DROP TRIGGER test_skip_sweep_trg ON agent_actions`));
      await testDb.execute(sql.raw(`DROP FUNCTION test_skip_sweep_fn()`));
      await testDb.execute(sql.raw(`DROP TABLE test_skip_sweep`));
    }
  });

  it("fails with gone when the target was deleted before approval", async () => {
    const task = await seedTask();
    const entry = await seedEntry(task.id, "2026-10-10T02:00:00Z", "2026-10-10T03:00:00Z");
    const pending = await requestDelete(ctx, { targetType: "time_entry", targetId: entry.id });
    await deleteEntry(userId, entry.id, TZ); // deleted via the UI path
    const done = await approveAction(userId, pending.id);
    expect(done.status).toBe("failed");
    expect(done.result).toEqual({ code: "gone", error: "Target no longer exists" });
    expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
  });

  it("fails with stale when the task was renamed", async () => {
    const task = await seedTask();
    const pending = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    await testDb.update(tasks).set({ name: "Renamed" }).where(eq(tasks.id, task.id));
    const done = await approveAction(userId, pending.id);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({
      code: "stale",
      error: "Target changed since you reviewed it",
      live: { name: "Renamed" },
    });
    expect(await testDb.select().from(tasks)).toHaveLength(1);
  });

  it("fails with stale when the entry was edited", async () => {
    const task = await seedTask();
    const entry = await seedEntry(task.id, "2026-10-10T02:00:00Z", "2026-10-10T03:00:00Z");
    const pending = await requestDelete(ctx, { targetType: "time_entry", targetId: entry.id });
    await testDb
      .update(timeEntries)
      .set({ endedAt: new Date("2026-10-10T03:30:00Z"), updatedAt: new Date() })
      .where(eq(timeEntries.id, entry.id));
    const done = await approveAction(userId, pending.id);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ code: "stale" });
    expect(await testDb.select().from(timeEntries)).toHaveLength(1);
  });

  it("fails with stale when entries were only added to the task", async () => {
    const task = await seedTask();
    await seedEntry(task.id, "2026-10-10T02:00:00Z", "2026-10-10T03:00:00Z");
    const pending = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    await seedEntry(task.id, "2026-10-10T04:00:00Z", "2026-10-10T04:20:00Z");
    const done = await approveAction(userId, pending.id);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ code: "stale", live: { completedMinutes: 80 } });
  });

  it("compares against expectedFingerprint when provided", async () => {
    const task = await seedTask();
    const pending = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    await testDb.update(tasks).set({ name: "Renamed" }).where(eq(tasks.id, task.id));

    // The user saw (and approved) the live, renamed task.
    const live = (await getAction(userId, pending.id)).live!;
    expect(live.fingerprint).not.toEqual(pending.summary.fingerprint);
    const done = await approveAction(userId, pending.id, { expectedFingerprint: live.fingerprint });
    expect(done.status).toBe("executed");
    expect(await testDb.select().from(tasks)).toHaveLength(0);
  });

  it("is stale when expectedFingerprint differs from the live target", async () => {
    const task = await seedTask();
    const pending = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    const done = await approveAction(userId, pending.id, {
      expectedFingerprint: { name: "Something else", completedMinutes: 0, activeEntryId: null },
    });
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ code: "stale" });
    expect(await testDb.select().from(tasks)).toHaveLength(1);
  });

  it("does not treat a Google re-sync (updated_at/html_link) as stale; never syncs the sheet", async () => {
    const ev = await seedEvent({ guests: [{ email: "a@example.com" }], sendUpdates: "all" });
    const pending = await requestDelete(ctx, { targetType: "calendar_event", targetId: ev.id });
    expect(pending.summary.impact).toEqual({
      googleLinked: true,
      guestCount: 1,
      notifiesGuests: true,
      canWriteGoogle: false,
    });
    await testDb
      .update(calendarEvents)
      .set({ updatedAt: new Date(), htmlLink: "https://calendar.google.com/y" })
      .where(eq(calendarEvents.id, ev.id));

    const done = await approveAction(userId, pending.id);
    expect(done.status).toBe("executed");
    // No Google tokens on the user: local delete only, reported truthfully.
    expect(done.result).toEqual({ google: { synced: false, error: "not_linked" } });
    expect(deleteCalendarEvent).toHaveBeenCalledTimes(1);
    expect(mocks.deleteGoogleCalendarEvent).not.toHaveBeenCalled();
    expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
    expect(await testDb.select().from(calendarEvents)).toHaveLength(0);
  });

  it("is stale when guest impact (sendUpdates or guests) changes after the request", async () => {
    const ev = await seedEvent({ guests: [{ email: "a@example.com" }], sendUpdates: "none" });
    const pending = await requestDelete(ctx, { targetType: "calendar_event", targetId: ev.id });
    expect(pending.summary.fingerprint).toMatchObject({ sendUpdates: "none", guestCount: 1 });

    await testDb.update(calendarEvents).set({ sendUpdates: "all" }).where(eq(calendarEvents.id, ev.id));
    const live = (await getAction(userId, pending.id)).live!;
    expect(live.fingerprint).toMatchObject({ sendUpdates: "all", guestCount: 1 });
    const staleSend = await approveAction(userId, pending.id, {
      expectedFingerprint: pending.summary.fingerprint,
    });
    expect(staleSend.status).toBe("failed");
    expect(staleSend.result).toMatchObject({ code: "stale" });
    expect(await testDb.select().from(calendarEvents)).toHaveLength(1);

    const ev2 = await seedEvent({ googleEventId: "g-456", guests: [{ email: "a@example.com" }], sendUpdates: "all" });
    const pending2 = await requestDelete(ctx, { targetType: "calendar_event", targetId: ev2.id });
    await testDb
      .update(calendarEvents)
      .set({ guests: [{ email: "a@example.com" }, { email: "b@example.com" }] })
      .where(eq(calendarEvents.id, ev2.id));
    const staleGuests = await approveAction(userId, pending2.id);
    expect(staleGuests.status).toBe("failed");
    expect(staleGuests.result).toMatchObject({ code: "stale" });
  });

  it("404s for another user's action", async () => {
    const task = await seedTask();
    const pending = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    const other = await seedBasics({ timezone: "UTC" });
    await expectStatus(approveAction(other.userId, pending.id), 404);
    await expectStatus(rejectAction(other.userId, pending.id), 404);
    await expectStatus(getAction(other.userId, pending.id), 404);
    expect((await rowById(pending.id)).status).toBe("pending");
    expect(deleteTask).not.toHaveBeenCalled();
  });
});

describe("rejectAction", () => {
  it("rejects, is idempotent, and blocks a later approve", async () => {
    const task = await seedTask();
    const pending = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    const rejected = await rejectAction(userId, pending.id);
    expect(rejected.status).toBe("rejected");
    expect(rejected.resolvedAt).not.toBeNull();
    expect(await testDb.select().from(tasks)).toHaveLength(1);

    const again = await rejectAction(userId, pending.id);
    expect(again).toEqual(rejected);

    const err = await expectStatus(approveAction(userId, pending.id), 409);
    expect(err.action).toMatchObject({ id: pending.id, status: "rejected" });
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("409s for executed or expired actions", async () => {
    const task = await seedTask();
    const a = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    await approveAction(userId, a.id);
    await expectStatus(rejectAction(userId, a.id), 409);

    const t2 = await seedTask("Other");
    const b = await requestDelete(ctx, { targetType: "task", targetId: t2.id });
    await testDb.execute(sql`UPDATE agent_actions SET expires_at = now() - interval '1 second' WHERE id = ${b.id}`);
    await expectStatus(rejectAction(userId, b.id), 409);
  });
});

describe("listActions / getAction / revoke", () => {
  it("lists pending rows with live target and staleness", async () => {
    const task = await seedTask();
    const t2 = await seedTask("Second");
    const a = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    await requestDelete(ctx, { targetType: "task", targetId: t2.id });
    await testDb.update(tasks).set({ name: "Changed" }).where(eq(tasks.id, t2.id));

    const list = await listActions(userId, { status: "pending" });
    expect(list).toHaveLength(2);
    const byTarget = Object.fromEntries(list.map((x) => [x.targetId, x]));
    expect(byTarget[task.id].stale).toBe(false);
    expect(byTarget[task.id].live?.label).toBe("Write report");
    expect(byTarget[task.id].tokenName).toBe("openclaw");
    expect(byTarget[t2.id].stale).toBe(true);

    await rejectAction(userId, a.id);
    const all = await listActions(userId);
    const rejected = all.find((x) => x.id === a.id)!;
    expect(rejected.status).toBe("rejected");
    expect(rejected.live).toBeUndefined();
  });

  it("revoking the token expires its pending action with token_revoked", async () => {
    const task = await seedTask();
    const pending = await requestDelete(ctx, { targetType: "task", targetId: task.id });
    expect(await revokeApiToken(userId, ctx.tokenId!)).toBe(true);
    const row = await getAction(userId, pending.id);
    expect(row.status).toBe("expired");
    expect(row.result).toEqual({ code: "token_revoked" });
    await expectStatus(approveAction(userId, pending.id), 409);
  });
});

describe("deepEqual", () => {
  it("ignores key order and distinguishes values", () => {
    expect(deepEqual({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: "1" })).toBe(false);
    expect(deepEqual({ a: null }, {})).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});

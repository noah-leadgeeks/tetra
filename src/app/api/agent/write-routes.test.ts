import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttendanceDTO, TimeEntryDTO } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  authenticateToken: vi.fn(),
  isAuthBypassActive: vi.fn(),
  recordAgentAction: vi.fn(),
  recordSyncOutcome: vi.fn(),
  dbRows: vi.fn(),
  dbWhere: vi.fn(),
  listCategories: vi.fn(),
  getActiveEntry: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  createManualEntry: vi.fn(),
  updateEntry: vi.fn(),
  startTimer: vi.fn(),
  stopTimer: vi.fn(),
  pauseTimer: vi.fn(),
  resumeTimer: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  clockIn: vi.fn(),
  clockOut: vi.fn(),
  updateAttendanceTimes: vi.fn(),
  startBreak: vi.fn(),
  endBreak: vi.fn(),
  createManualBreak: vi.fn(),
  updateBreak: vi.fn(),
  syncDaysAfterChange: vi.fn(),
  autoSyncAfterClose: vi.fn(),
  syncClockIn: vi.fn(),
}));

vi.mock("@/features/agent-api/tokens", async (orig) => ({
  ...(await orig<typeof import("@/features/agent-api/tokens")>()),
  authenticateToken: mocks.authenticateToken,
}));
vi.mock("@/features/agent-api/http", async (orig) => ({
  ...(await orig<typeof import("@/features/agent-api/http")>()),
  recordAgentAction: mocks.recordAgentAction,
}));
vi.mock("@/features/agent-api/writes", async (orig) => ({
  ...(await orig<typeof import("@/features/agent-api/writes")>()),
  recordSyncOutcome: mocks.recordSyncOutcome,
}));
vi.mock("@/server/auth", () => ({ isAuthBypassActive: mocks.isAuthBypassActive }));

// Chainable select(): from/innerJoin/leftJoin/where/limit; `limit` resolves to dbRows().
vi.mock("@/server/db", () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.innerJoin = () => chain;
  chain.leftJoin = () => chain;
  chain.where = (cond: unknown) => {
    mocks.dbWhere(cond);
    return chain;
  };
  chain.limit = () => mocks.dbRows();
  return { db: { select: () => chain } };
});
vi.mock("@/features/activities/entry-queries", () => ({
  listCategories: mocks.listCategories,
  getActiveEntry: mocks.getActiveEntry,
  listAllTasks: vi.fn(),
  getDayEntries: vi.fn(),
}));
vi.mock("@/features/activities/entry-mutations", () => ({
  createTask: mocks.createTask,
  updateTask: mocks.updateTask,
  createManualEntry: mocks.createManualEntry,
  updateEntry: mocks.updateEntry,
}));
vi.mock("@/features/activities/timer-operations", () => ({
  startTimer: mocks.startTimer,
  stopTimer: mocks.stopTimer,
  pauseTimer: mocks.pauseTimer,
  resumeTimer: mocks.resumeTimer,
}));
vi.mock("@/features/calendar-sync/service", () => ({
  createCalendarEvent: mocks.createCalendarEvent,
  updateCalendarEvent: mocks.updateCalendarEvent,
  listCalendarEvents: vi.fn(),
}));
vi.mock("@/features/attendance/service", () => ({
  clockIn: mocks.clockIn,
  clockOut: mocks.clockOut,
  updateAttendanceTimes: mocks.updateAttendanceTimes,
  startBreak: mocks.startBreak,
  endBreak: mocks.endBreak,
  createManualBreak: mocks.createManualBreak,
  updateBreak: mocks.updateBreak,
}));
vi.mock("@/features/sheets-sync/auto-sync-server", () => ({
  syncDaysAfterChange: mocks.syncDaysAfterChange,
  autoSyncAfterClose: mocks.autoSyncAfterClose,
}));
vi.mock("@/features/sheets-sync/service", () => ({ syncClockIn: mocks.syncClockIn }));

import { OverlapError } from "@/features/activities/domain";
import { PATCH as patchAttendance } from "./attendance/[date]/route";
import { POST as clockInRoute } from "./attendance/clock-in/route";
import { POST as clockOutRoute } from "./attendance/clock-out/route";
import { PATCH as patchBreak } from "./breaks/[id]/route";
import { POST as createBreak } from "./breaks/route";
import { POST as startBreakRoute } from "./breaks/start/route";
import { POST as stopBreakRoute } from "./breaks/stop/route";
import { PATCH as patchEvent } from "./calendar/events/[id]/route";
import { POST as createEvent } from "./calendar/events/route";
import { PATCH as patchTask } from "./tasks/[id]/route";
import { POST as createTaskRoute } from "./tasks/route";
import { PATCH as patchEntry } from "./time-entries/[id]/route";
import { POST as pauseRoute } from "./time-entries/pause/route";
import { POST as resumeRoute } from "./time-entries/resume/route";
import { POST as createEntry } from "./time-entries/route";
import { POST as startRoute } from "./time-entries/start/route";
import { POST as stopRoute } from "./time-entries/stop/route";

const TZ = "Asia/Jakarta";
const TOKEN = "tetra_secret_token_value";
const ID = "3f2b8c1e-7a4d-4e8a-9b1c-2d3e4f5a6b7c";
const CAT_ID = "0b6f5c1e-1a2b-4c3d-8e9f-a0b1c2d3e4f5";

// `Promise<never>` is assignable to every route's params promise type.
type Handler = (req: Request, ctx?: { params: Promise<never> }) => Promise<Response>;

const call = (
  handler: Handler,
  body?: unknown,
  params: Record<string, string> = {},
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
) =>
  handler(
    new Request("http://localhost/api/agent/x", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) as Promise<never> },
  );

const entry = (over: Partial<TimeEntryDTO> = {}): TimeEntryDTO => ({
  id: ID,
  taskId: "task-1",
  taskName: "Write report",
  categoryId: CAT_ID,
  categoryKey: "dev",
  categoryName: "Dev",
  startedAt: "2026-10-12T02:00:00.000Z",
  endedAt: "2026-10-12T03:00:00.000Z",
  status: "completed",
  notes: null,
  source: "manual",
  durationMinutes: 60,
  pausedSeconds: 0,
  pausedAt: null,
  ...over,
});

const attendance = (over: Partial<AttendanceDTO> = {}): AttendanceDTO => ({
  id: "att-1",
  workDate: "2026-10-12",
  clockInAt: "2026-10-12T01:00:00.000Z",
  clockOutAt: null,
  status: "open",
  activeBreak: null,
  breaks: [],
  breakMinutes: 0,
  ...over,
});

const task = {
  id: ID,
  name: "Ship it",
  categoryId: CAT_ID,
  categoryKey: "dev",
  status: "todo",
  priority: "medium",
  isFavorite: false,
  lastUsedAt: null,
  description: null,
  dueAt: "2026-10-20T23:59:59.000Z",
};

const SYNC_OK = { attempted: true, success: true, idempotent: false, changedCount: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAuthBypassActive.mockReturnValue(false);
  mocks.authenticateToken.mockResolvedValue({
    userId: "u1",
    timezone: TZ,
    tokenId: "tok-1",
    tokenName: "openclaw",
    scopes: ["write"],
  });
  mocks.recordAgentAction.mockResolvedValue("action-1");
  mocks.listCategories.mockResolvedValue([
    { id: CAT_ID, key: "dev", name: "Dev" },
  ]);
  mocks.getActiveEntry.mockResolvedValue(null);
  mocks.dbRows.mockResolvedValue([]);
  mocks.syncDaysAfterChange.mockImplementation(async (_u: string, keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, SYNC_OK])),
  );
});

function expectAuditedOnce(kind: string, status: "executed" | "failed" = "executed") {
  expect(mocks.recordAgentAction).toHaveBeenCalledTimes(1);
  const [ctx, input] = mocks.recordAgentAction.mock.calls[0];
  expect(ctx.tokenId).toBe("tok-1");
  expect(input.kind).toBe(kind);
  expect(input.status).toBe(status);
  const serialized = JSON.stringify(input);
  expect(serialized).not.toContain(TOKEN);
  expect(serialized.toLowerCase()).not.toContain("authorization");
  return input;
}

describe("scope and auth", () => {
  const routes: Array<[string, Handler, Record<string, string>?]> = [
    ["POST tasks", createTaskRoute],
    ["PATCH tasks/[id]", patchTask, { id: ID }],
    ["POST time-entries", createEntry],
    ["PATCH time-entries/[id]", patchEntry, { id: ID }],
    ["POST time-entries/start", startRoute],
    ["POST time-entries/stop", stopRoute],
    ["POST time-entries/pause", pauseRoute],
    ["POST time-entries/resume", resumeRoute],
    ["POST calendar/events", createEvent],
    ["PATCH calendar/events/[id]", patchEvent, { id: ID }],
    ["POST attendance/clock-in", clockInRoute],
    ["POST attendance/clock-out", clockOutRoute],
    ["PATCH attendance/[date]", patchAttendance, { date: "2026-10-12" }],
    ["POST breaks", createBreak],
    ["POST breaks/start", startBreakRoute],
    ["POST breaks/stop", stopBreakRoute],
    ["PATCH breaks/[id]", patchBreak, { id: ID }],
  ];

  it.each(routes)("%s → 403 for a read-only token", async (_name, handler, params) => {
    mocks.authenticateToken.mockResolvedValue({
      userId: "u1",
      timezone: TZ,
      tokenId: "tok-1",
      tokenName: "ro",
      scopes: ["read"],
    });
    const res = await call(handler, {}, params);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("insufficient_scope");
    expect(mocks.recordAgentAction).not.toHaveBeenCalled();
  });

  it.each(routes)("%s → 401 without a token", async (_name, handler, params) => {
    const res = await call(handler, {}, params, {});
    expect(res.status).toBe(401);
  });

  it.each(
    routes.filter(([name]) => name.includes("[id]")),
  )("%s → 400 for a non-uuid id, no audit", async (_name, handler) => {
    const res = await call(handler, {}, { id: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid id" });
    expect(mocks.recordAgentAction).not.toHaveBeenCalled();
  });
});

describe("tasks", () => {
  it("POST resolves categoryKey and maps dueDate to dueAt", async () => {
    mocks.createTask.mockResolvedValue(task);
    const res = await call(createTaskRoute, { name: "Ship it", categoryKey: "dev", dueDate: "2026-10-20" });
    expect(res.status).toBe(201);
    expect(mocks.createTask).toHaveBeenCalledWith("u1", {
      name: "Ship it",
      categoryId: CAT_ID,
      dueAt: new Date("2026-10-20T23:59:59Z"),
    });
    expect((await res.json()).task).toMatchObject({ id: ID, dueDate: "2026-10-20", categoryKey: "dev" });
    const audit = expectAuditedOnce("task.create");
    expect(audit.targetId).toBe(ID);
    expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
  });

  it("POST rejects dueAt with 400 and does not audit", async () => {
    const res = await call(createTaskRoute, { name: "x", categoryKey: "dev", dueAt: "2026-10-20T00:00:00Z" });
    expect(res.status).toBe(400);
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(mocks.recordAgentAction).not.toHaveBeenCalled();
  });

  it("POST without any category → 400, no audit", async () => {
    const res = await call(createTaskRoute, { name: "x" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/categoryId or categoryKey/);
    expect(mocks.recordAgentAction).not.toHaveBeenCalled();
  });

  it("POST with an unknown categoryKey → 404, audited as failed", async () => {
    const res = await call(createTaskRoute, { name: "x", categoryKey: "nope" });
    expect(res.status).toBe(404);
    expect(mocks.createTask).not.toHaveBeenCalled();
    expectAuditedOnce("task.create", "failed");
  });

  it("PATCH maps dueDate null to a cleared dueAt", async () => {
    mocks.updateTask.mockResolvedValue({ ...task, dueAt: null });
    const res = await call(patchTask, { dueDate: null, status: "in_progress" }, { id: ID });
    expect(res.status).toBe(200);
    expect(mocks.updateTask).toHaveBeenCalledWith(
      "u1",
      ID,
      { status: "in_progress", categoryId: undefined, dueAt: null },
      TZ,
    );
    expectAuditedOnce("task.update");
  });

  it("PATCH on a missing or foreign task → 404", async () => {
    mocks.updateTask.mockRejectedValue(new Error("Task not found"));
    const res = await call(patchTask, { name: "y" }, { id: ID });
    expect(res.status).toBe(404);
    expectAuditedOnce("task.update", "failed");
  });
});

describe("time entries", () => {
  it("POST rejects a naive timestamp", async () => {
    const res = await call(createEntry, {
      startedAt: "2026-10-12T09:00:00",
      endedAt: "2026-10-12T10:00:00",
      taskName: "x",
      categoryKey: "dev",
    });
    expect(res.status).toBe(400);
    expect(mocks.createManualEntry).not.toHaveBeenCalled();
    expect(mocks.recordAgentAction).not.toHaveBeenCalled();
  });

  it("POST accepts +07:00 and syncs both local days of a cross-midnight entry", async () => {
    mocks.createManualEntry.mockResolvedValue(
      entry({ startedAt: "2026-10-12T16:00:00.000Z", endedAt: "2026-10-12T18:00:00.000Z" }),
    );
    const res = await call(createEntry, {
      startedAt: "2026-10-12T23:00:00+07:00",
      endedAt: "2026-10-13T01:00:00+07:00",
      taskName: "Late work",
      categoryKey: "dev",
    });
    expect(res.status).toBe(201);
    expect(mocks.createManualEntry).toHaveBeenCalledWith("u1", TZ, {
      startedAt: new Date("2026-10-12T16:00:00Z"),
      endedAt: new Date("2026-10-12T18:00:00Z"),
      taskName: "Late work",
      categoryId: CAT_ID,
      notes: undefined,
    });
    expect(mocks.syncDaysAfterChange).toHaveBeenCalledWith("u1", ["2026-10-12", "2026-10-13"]);
    const json = await res.json();
    expect(json.sheetSync["2026-10-13"]).toEqual(SYNC_OK);
    expect(json.entry.id).toBe(ID);
    expectAuditedOnce("time_entry.create");
  });

  it("POST maps OverlapError to 409", async () => {
    mocks.createManualEntry.mockRejectedValue(
      new OverlapError([{ message: "Overlaps another entry" } as never]),
    );
    const res = await call(createEntry, {
      startedAt: "2026-10-12T09:00:00Z",
      endedAt: "2026-10-12T10:00:00Z",
      taskName: "x",
      categoryId: CAT_ID,
    });
    expect(res.status).toBe(409);
    expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
    expectAuditedOnce("time_entry.create", "failed");
  });

  it("PATCH on a missing or foreign entry → 404 without calling updateEntry", async () => {
    mocks.dbRows.mockResolvedValue([]);
    const res = await call(patchEntry, { notes: "n" }, { id: ID });
    expect(res.status).toBe(404);
    expect(mocks.updateEntry).not.toHaveBeenCalled();
    expect(mocks.dbWhere).toHaveBeenCalledTimes(1);
    expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
  });

  it("PATCH that moves an entry to another day syncs both days", async () => {
    mocks.dbRows.mockResolvedValue([
      { startedAt: new Date("2026-10-10T02:00:00Z"), endedAt: new Date("2026-10-10T03:00:00Z") },
    ]);
    mocks.updateEntry.mockResolvedValue(entry());
    const res = await call(
      patchEntry,
      { startedAt: "2026-10-12T09:00:00+07:00", endedAt: "2026-10-12T10:00:00+07:00" },
      { id: ID },
    );
    expect(res.status).toBe(200);
    expect(mocks.updateEntry).toHaveBeenCalledWith(
      "u1",
      ID,
      expect.objectContaining({ startedAt: new Date("2026-10-12T02:00:00Z") }),
      TZ,
    );
    expect(mocks.syncDaysAfterChange).toHaveBeenCalledWith("u1", ["2026-10-10", "2026-10-12"]);
    expectAuditedOnce("time_entry.update");
  });

  it("start without a running entry does not sync", async () => {
    mocks.startTimer.mockResolvedValue(entry({ status: "active", endedAt: null }));
    const res = await call(startRoute, { taskName: "x", categoryKey: "dev" });
    expect(res.status).toBe(200);
    expect(mocks.startTimer).toHaveBeenCalledWith("u1", TZ, { taskName: "x", categoryId: CAT_ID, notes: undefined });
    expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
    expect((await res.json()).sheetSync).toBeNull();
    expectAuditedOnce("time_entry.start");
  });

  it("start that auto-stops a running entry syncs the closed entry's days", async () => {
    mocks.getActiveEntry.mockResolvedValue(
      entry({ id: "prev", status: "active", startedAt: "2026-10-11T16:30:00.000Z", endedAt: null }),
    );
    mocks.startTimer.mockResolvedValue(
      entry({ status: "active", startedAt: "2026-10-11T17:30:00.000Z", endedAt: null }),
    );
    const res = await call(startRoute, { taskName: "x", categoryId: CAT_ID });
    expect(res.status).toBe(200);
    // 23:30 → 00:30 Jakarta: both local days.
    expect(mocks.syncDaysAfterChange).toHaveBeenCalledWith("u1", ["2026-10-11", "2026-10-12"]);
  });

  it("stop syncs the stopped entry's day keys", async () => {
    mocks.stopTimer.mockResolvedValue(entry());
    const res = await call(stopRoute);
    expect(res.status).toBe(200);
    expect(mocks.stopTimer).toHaveBeenCalledWith("u1", TZ);
    expect(mocks.syncDaysAfterChange).toHaveBeenCalledWith("u1", ["2026-10-12"]);
    expectAuditedOnce("time_entry.stop");
    // The sync outcome is merged into the audit row ("action-1" from recordAgentAction).
    expect(mocks.recordSyncOutcome).toHaveBeenCalledWith("action-1", {
      sheetSync: await mocks.syncDaysAfterChange.mock.results[0].value,
    });
  });

  it("stop with nothing running → 400, audited as failed, no sync", async () => {
    mocks.stopTimer.mockRejectedValue(new Error("No active task"));
    const res = await call(stopRoute);
    expect(res.status).toBe(400);
    expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
    expectAuditedOnce("time_entry.stop", "failed");
  });

  it("pause and resume never sync", async () => {
    mocks.pauseTimer.mockResolvedValue(entry({ status: "paused", endedAt: null }));
    mocks.resumeTimer.mockResolvedValue(entry({ status: "active", endedAt: null }));
    expect((await call(pauseRoute)).status).toBe(200);
    expect((await call(resumeRoute)).status).toBe(200);
    expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
    expect(mocks.recordAgentAction.mock.calls.map((c) => c[1].kind)).toEqual([
      "time_entry.pause",
      "time_entry.resume",
    ]);
  });
});

describe("calendar events", () => {
  const event = { id: ID, title: "Standup" };

  it("POST returns google.synced and stores it in the audit result", async () => {
    const google = { synced: false, error: "missing_scope" };
    mocks.createCalendarEvent.mockResolvedValue({ event, google });
    const res = await call(createEvent, {
      title: "Standup",
      startAt: "2026-10-12T09:00:00+07:00",
      endAt: "2026-10-12T09:15:00+07:00",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ event, google });
    const audit = expectAuditedOnce("calendar_event.create");
    expect(audit.result).toEqual({ google });
    expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
  });

  it("POST rejects naive timestamps", async () => {
    const res = await call(createEvent, {
      title: "Standup",
      startAt: "2026-10-12T09:00:00",
      endAt: "2026-10-12T09:15:00",
    });
    expect(res.status).toBe(400);
    expect(mocks.createCalendarEvent).not.toHaveBeenCalled();
  });

  it("POST with an unknown categoryId → 404 and no write; known categoryId is accepted", async () => {
    const body = {
      title: "Standup",
      startAt: "2026-10-12T09:00:00+07:00",
      endAt: "2026-10-12T09:15:00+07:00",
    };
    const unknown = await call(createEvent, { ...body, categoryId: "9a8b7c6d-1111-4222-8333-444455556666" });
    expect(unknown.status).toBe(404);
    expect(mocks.createCalendarEvent).not.toHaveBeenCalled();
    expectAuditedOnce("calendar_event.create", "failed");

    vi.clearAllMocks();
    mocks.recordAgentAction.mockResolvedValue("action-1");
    mocks.createCalendarEvent.mockResolvedValue({ event, google: { synced: true, error: null } });
    const ok = await call(createEvent, { ...body, categoryId: CAT_ID });
    expect(ok.status).toBe(201);
    expect(mocks.createCalendarEvent).toHaveBeenCalledTimes(1);
  });

  it("PATCH with an unknown categoryId → 404 and no write; null clears without lookup", async () => {
    const unknown = await call(
      patchEvent,
      { categoryId: "9a8b7c6d-1111-4222-8333-444455556666" },
      { id: ID },
    );
    expect(unknown.status).toBe(404);
    expect(mocks.updateCalendarEvent).not.toHaveBeenCalled();

    mocks.updateCalendarEvent.mockResolvedValueOnce({ event, google: { synced: true, error: null } });
    const cleared = await call(patchEvent, { categoryId: null }, { id: ID });
    expect(cleared.status).toBe(200);
    expect(mocks.updateCalendarEvent).toHaveBeenCalledTimes(1);
  });

  it("PATCH returns google.synced; missing event → 404", async () => {
    mocks.updateCalendarEvent.mockResolvedValueOnce({ event, google: { synced: true, error: null } });
    const ok = await call(patchEvent, { title: "New" }, { id: ID });
    expect(ok.status).toBe(200);
    expect((await ok.json()).google.synced).toBe(true);

    mocks.updateCalendarEvent.mockRejectedValueOnce(new Error("Event not found"));
    const missing = await call(patchEvent, { title: "New" }, { id: ID });
    expect(missing.status).toBe(404);
  });
});

describe("attendance", () => {
  it("clock-in syncs the clock-in cell", async () => {
    mocks.clockIn.mockResolvedValue(attendance());
    mocks.syncClockIn.mockResolvedValue({ attempted: false });
    const res = await call(clockInRoute);
    expect(res.status).toBe(200);
    expect(mocks.syncClockIn).toHaveBeenCalledWith("u1", "2026-10-12", "2026-10-12T01:00:00.000Z", {});
    expectAuditedOnce("attendance.clock_in");
  });

  it("clock-out uses the draft reset and returns autoSync", async () => {
    mocks.clockOut.mockResolvedValue(attendance({ status: "closed" }));
    mocks.autoSyncAfterClose.mockResolvedValue({ attempted: true, success: true, idempotent: true, changedCount: 0 });
    const res = await call(clockOutRoute);
    expect(res.status).toBe(200);
    expect(mocks.autoSyncAfterClose).toHaveBeenCalledWith(
      "u1",
      "2026-10-12",
      TZ,
      expect.objectContaining({ resetStateOnFailure: "draft" }),
    );
    expect((await res.json()).autoSync.success).toBe(true);
    expectAuditedOnce("attendance.clock_out");
  });

  it("clock-out returns 200 with autoSync.success=false when autoSyncAfterClose throws", async () => {
    mocks.clockOut.mockResolvedValue(attendance({ status: "closed" }));
    mocks.autoSyncAfterClose.mockRejectedValue(new Error("Sheets client exploded"));
    const res = await call(clockOutRoute);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.attendance.status).toBe("closed");
    expect(json.autoSync).toMatchObject({ success: false, message: "Sheets client exploded" });
    expectAuditedOnce("attendance.clock_out");
  });

  it("PATCH closing a day syncs with the ready reset; a throw is reported, not raised", async () => {
    mocks.updateAttendanceTimes.mockResolvedValue(attendance({ status: "closed" }));
    mocks.autoSyncAfterClose.mockRejectedValue(new Error("boom"));
    const res = await call(
      patchAttendance,
      { clockOutAt: "2026-10-12T17:00:00+07:00", status: "closed" },
      { date: "2026-10-12" },
    );
    expect(res.status).toBe(200);
    expect(mocks.updateAttendanceTimes).toHaveBeenCalledWith("u1", "2026-10-12", TZ, {
      clockOutAt: "2026-10-12T17:00:00+07:00",
      status: "closed",
    });
    expect(mocks.autoSyncAfterClose).toHaveBeenCalledWith(
      "u1",
      "2026-10-12",
      TZ,
      expect.objectContaining({ resetStateOnFailure: "ready" }),
    );
    expect((await res.json()).autoSync.success).toBe(false);
    expectAuditedOnce("attendance.update");
  });

  it("PATCH audits the original body even when the service mutates its input", async () => {
    mocks.updateAttendanceTimes.mockImplementation(async (_u, _d, _tz, input: Record<string, unknown>) => {
      for (const key of Object.keys(input)) delete input[key];
      return attendance();
    });
    const body = { clockInAt: "2026-10-12T08:00:00+07:00" };
    const res = await call(patchAttendance, body, { date: "2026-10-12" });
    expect(res.status).toBe(200);
    expect(mocks.recordAgentAction.mock.calls[0][1].summary.request).toEqual(body);
  });

  it("PATCH leaving a day open does not sync", async () => {
    mocks.updateAttendanceTimes.mockResolvedValue(attendance());
    const res = await call(
      patchAttendance,
      { clockInAt: "2026-10-12T08:00:00+07:00" },
      { date: "2026-10-12" },
    );
    expect(res.status).toBe(200);
    expect(mocks.autoSyncAfterClose).not.toHaveBeenCalled();
    expect((await res.json()).autoSync).toEqual({ attempted: false });
  });

  it("PATCH rejects a bad date and a naive clock time", async () => {
    expect((await call(patchAttendance, {}, { date: "12-10-2026" })).status).toBe(400);
    expect(
      (await call(patchAttendance, { clockInAt: "2026-10-12T08:00:00" }, { date: "2026-10-12" }))
        .status,
    ).toBe(400);
    expect(mocks.updateAttendanceTimes).not.toHaveBeenCalled();
    expect(mocks.recordAgentAction).not.toHaveBeenCalled();
  });
});

describe("breaks", () => {
  const brk = { id: ID, startedAt: "2026-10-12T05:00:00.000Z", endedAt: "2026-10-12T05:30:00.000Z", durationMinutes: 30 };

  it("start does not sync", async () => {
    mocks.startBreak.mockResolvedValue(attendance({ activeBreak: { ...brk, endedAt: null, durationMinutes: null } }));
    const res = await call(startBreakRoute);
    expect(res.status).toBe(200);
    expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
    const audit = expectAuditedOnce("break.start");
    expect(audit.targetId).toBe(ID);
  });

  it("stop syncs the attendance day", async () => {
    mocks.endBreak.mockResolvedValue(attendance());
    const res = await call(stopBreakRoute);
    expect(res.status).toBe(200);
    expect(mocks.syncDaysAfterChange).toHaveBeenCalledWith("u1", ["2026-10-12"]);
    expectAuditedOnce("break.stop");
  });

  it("POST creates a manual break and syncs its workDate", async () => {
    mocks.createManualBreak.mockResolvedValue(brk);
    const res = await call(createBreak, {
      workDate: "2026-10-12",
      startedAt: "2026-10-12T12:00:00+07:00",
      endedAt: "2026-10-12T12:30:00+07:00",
    });
    expect(res.status).toBe(201);
    expect(mocks.syncDaysAfterChange).toHaveBeenCalledWith("u1", ["2026-10-12"]);
    expect((await res.json()).break).toEqual(brk);
    expectAuditedOnce("break.create");
  });

  it("POST rejects a naive timestamp", async () => {
    const res = await call(createBreak, {
      workDate: "2026-10-12",
      startedAt: "2026-10-12T12:00:00",
      endedAt: "2026-10-12T12:30:00",
    });
    expect(res.status).toBe(400);
    expect(mocks.createManualBreak).not.toHaveBeenCalled();
  });

  it("PATCH on a missing or foreign break → 404", async () => {
    mocks.dbRows.mockResolvedValue([]);
    const res = await call(patchBreak, { endedAt: "2026-10-12T13:00:00+07:00" }, { id: ID });
    expect(res.status).toBe(404);
    expect(mocks.updateBreak).not.toHaveBeenCalled();
    expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
  });

  it("PATCH updates the break and syncs the looked-up workDate", async () => {
    mocks.dbRows.mockResolvedValue([{ workDate: "2026-10-11" }]);
    mocks.updateBreak.mockResolvedValue(brk);
    const res = await call(patchBreak, { endedAt: "2026-10-11T13:00:00+07:00" }, { id: ID });
    expect(res.status).toBe(200);
    expect(mocks.updateBreak).toHaveBeenCalledWith("u1", ID, TZ, {
      startedAt: undefined,
      endedAt: new Date("2026-10-11T06:00:00Z"),
    });
    expect(mocks.syncDaysAfterChange).toHaveBeenCalledWith("u1", ["2026-10-11"]);
    expectAuditedOnce("break.update");
  });
});

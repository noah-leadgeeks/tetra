import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDTO } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  authenticateToken: vi.fn(),
  isAuthBypassActive: vi.fn(),
  getDaySummary: vi.fn(),
  getActiveEntry: vi.fn(),
  getDayEntries: vi.fn(),
  listAllTasks: vi.fn(),
  listCategories: vi.fn(),
  listCalendarEvents: vi.fn(),
  dbRows: vi.fn(),
  dbWhere: vi.fn(),
  dbInsert: vi.fn(),
}));

vi.mock("@/features/agent-api/tokens", async (orig) => ({
  ...(await orig<typeof import("@/features/agent-api/tokens")>()),
  authenticateToken: mocks.authenticateToken,
}));
vi.mock("@/server/auth", () => ({ isAuthBypassActive: mocks.isAuthBypassActive }));
vi.mock("@/server/db", () => ({
  db: {
    insert: mocks.dbInsert,
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: (cond: unknown) => {
            mocks.dbWhere(cond);
            return { limit: () => mocks.dbRows() };
          },
        }),
      }),
    }),
  },
}));
vi.mock("@/features/daily-summary/service", () => ({ getDaySummary: mocks.getDaySummary }));
vi.mock("@/features/activities/entry-queries", () => ({
  getActiveEntry: mocks.getActiveEntry,
  getDayEntries: mocks.getDayEntries,
  listAllTasks: mocks.listAllTasks,
  listCategories: mocks.listCategories,
}));
vi.mock("@/features/calendar-sync/service", () => ({
  listCalendarEvents: mocks.listCalendarEvents,
}));

import { GET as getAttendance } from "./attendance/route";
import { GET as getEvents } from "./calendar/events/route";
import { GET as getCategories } from "./categories/route";
import { GET as getSchedule } from "./schedule/route";
import { GET as getSummary } from "./summary/route";
import { GET as getTask } from "./tasks/[id]/route";
import { GET as getTasks } from "./tasks/route";
import { GET as getEntries } from "./time-entries/route";
import { GET as getActive } from "./time-entries/active/route";

const TZ = "Asia/Jakarta";
const ID = "3f2b8c1e-7a4d-4e8a-9b1c-2d3e4f5a6b7c";

const task = (over: Partial<TaskDTO>): TaskDTO => ({
  id: "t",
  name: "t",
  categoryId: "c",
  categoryKey: "dev",
  status: "todo",
  priority: "medium",
  isFavorite: false,
  lastUsedAt: null,
  dueAt: null,
  ...over,
});

const emptyDay = {
  workDate: "2026-10-13",
  attendance: null,
  timeEntries: [],
  totals: { attendanceMinutes: 0, breakMinutes: 0, workMinutes: 0 },
  byCategory: [],
  warnings: [],
  reviewState: "draft",
  needsSync: false,
  lastSyncedAt: null,
};

function req(path: string, auth = true) {
  return new Request(`http://localhost${path}`, {
    headers: auth ? { authorization: "Bearer tetra_token" } : {},
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isAuthBypassActive.mockReturnValue(false);
  mocks.authenticateToken.mockResolvedValue({
    userId: "user-1",
    timezone: TZ,
    tokenId: "tok-1",
    tokenName: "n",
    scopes: ["read"],
  });
  mocks.getDaySummary.mockResolvedValue(emptyDay);
  mocks.getActiveEntry.mockResolvedValue(null);
  mocks.listAllTasks.mockResolvedValue([]);
  mocks.listCalendarEvents.mockResolvedValue([]);
  mocks.getDayEntries.mockResolvedValue([]);
  mocks.listCategories.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("agent read routes: auth", () => {
  const routes: Array<[string, () => Promise<Response>]> = [
    ["summary", () => getSummary(req("/api/agent/summary", false))],
    ["tasks", () => getTasks(req("/api/agent/tasks", false))],
    ["schedule", () => getSchedule(req("/api/agent/schedule", false))],
    ["time-entries", () => getEntries(req("/api/agent/time-entries", false))],
    ["active", () => getActive(req("/api/agent/time-entries/active", false))],
    ["events", () => getEvents(req("/api/agent/calendar/events", false))],
    ["attendance", () => getAttendance(req("/api/agent/attendance", false))],
    ["categories", () => getCategories(req("/api/agent/categories", false))],
    [
      "task by id",
      () => getTask(req(`/api/agent/tasks/${ID}`, false), { params: Promise.resolve({ id: ID }) }),
    ],
  ];
  it.each(routes)("%s returns 401 without a token", async (_n, call) => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("never writes audit rows from read routes", async () => {
    await getSummary(req("/api/agent/summary"));
    await getSchedule(req("/api/agent/schedule"));
    await getCategories(req("/api/agent/categories"));
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/agent/summary", () => {
  it("groups tasks by the user's timezone day with the clock pinned", async () => {
    vi.useFakeTimers();
    // 20:00Z on the 12th is already the 13th in Jakarta.
    vi.setSystemTime(new Date("2026-10-12T20:00:00Z"));
    mocks.listAllTasks.mockResolvedValue([
      task({ id: "a", name: "a", dueAt: "2026-10-12T23:59:59Z" }),
      task({ id: "b", name: "b", dueAt: "2026-10-13T23:59:59Z" }),
      task({ id: "c", name: "c", dueAt: "2026-10-15T23:59:59Z" }),
      task({ id: "d", name: "d", status: "in_progress" }),
    ]);
    const res = await getSummary(req("/api/agent/summary"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.date).toBe("2026-10-13");
    expect(body.timezone).toBe(TZ);
    expect(body.tasks.overdue.map((t: { id: string }) => t.id)).toEqual(["a"]);
    expect(body.tasks.dueToday.map((t: { id: string }) => t.id)).toEqual(["b"]);
    expect(body.tasks.upcoming.map((t: { id: string }) => t.id)).toEqual(["c"]);
    expect(body.tasks.inProgress.map((t: { id: string }) => t.id)).toEqual(["d"]);
    expect(body.tasks.dueToday[0].dueDate).toBe("2026-10-13");
    expect(mocks.getDaySummary).toHaveBeenCalledWith("user-1", "2026-10-13", TZ);
    const opts = mocks.listCalendarEvents.mock.calls[0][1];
    expect(opts.from).toBe("2026-10-12T17:00:00.000Z");
    expect(opts.to).toBe("2026-10-13T16:59:59.999Z");
    expect(opts.syncWithGoogle).toBe(false);
  });

  it("only syncs Google when sync=true", async () => {
    await getSummary(req("/api/agent/summary?sync=true"));
    expect(mocks.listCalendarEvents.mock.calls[0][1].syncWithGoogle).toBe(true);
  });
});

describe("GET /api/agent/schedule", () => {
  it("defaults to the user's today, not the server date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T20:00:00Z"));
    const res = await getSchedule(req("/api/agent/schedule"));
    expect((await res.json()).date).toBe("2026-10-13");
    expect(mocks.getDaySummary).toHaveBeenCalledWith("user-1", "2026-10-13", TZ);
  });

  it("returns 400 for a bad date", async () => {
    const res = await getSchedule(req("/api/agent/schedule?date=13-10-2026"));
    expect(res.status).toBe(400);
    expect(mocks.getDaySummary).not.toHaveBeenCalled();
  });
});

describe("other date-driven reads", () => {
  it.each([
    ["time-entries", () => getEntries(req("/api/agent/time-entries?date=nope"))],
    ["attendance", () => getAttendance(req("/api/agent/attendance?date=2026-02-30x"))],
    ["events", () => getEvents(req("/api/agent/calendar/events?date=nope"))],
    ["events from only", () => getEvents(req("/api/agent/calendar/events?from=2026-10-12T00:00:00Z"))],
    ["events naive from/to", () => getEvents(req("/api/agent/calendar/events?from=2026-10-12T00:00:00&to=2026-10-13T00:00:00"))],
  ])("%s rejects bad input with 400", async (_n, call) => {
    expect((await call()).status).toBe(400);
  });

  it("calendar events default to today's zoned bounds without Google sync", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T20:00:00Z"));
    const res = await getEvents(req("/api/agent/calendar/events"));
    expect(res.status).toBe(200);
    expect(mocks.listCalendarEvents).toHaveBeenCalledWith("user-1", {
      from: "2026-10-12T17:00:00.000Z",
      to: "2026-10-13T16:59:59.999Z",
      syncWithGoogle: false,
      timeZone: TZ,
    });
  });

  it("active entry route returns null when idle", async () => {
    const res = await getActive(req("/api/agent/time-entries/active"));
    expect(await res.json()).toEqual({ activeEntry: null });
  });
});

describe("GET /api/agent/tasks", () => {
  it("applies filter and limit, and rejects invalid filters", async () => {
    mocks.listAllTasks.mockResolvedValue([
      task({ id: "1", name: "a" }),
      task({ id: "2", name: "b", status: "done" }),
      task({ id: "3", name: "c" }),
    ]);
    const res = await getTasks(req("/api/agent/tasks?filter=open&limit=1"));
    const body = await res.json();
    expect(body.filter).toBe("open");
    expect(body.tasks).toHaveLength(1);
    expect((await getTasks(req("/api/agent/tasks?filter=bogus"))).status).toBe(400);
  });
});

describe("GET /api/agent/tasks/[id]", () => {
  const call = (id: string) =>
    getTask(req(`/api/agent/tasks/${id}`), { params: Promise.resolve({ id }) });

  it("returns 400 for a non-uuid id", async () => {
    expect((await call("abc")).status).toBe(400);
    expect(mocks.dbWhere).not.toHaveBeenCalled();
  });

  it("returns 404 with the documented body when the user-scoped select is empty", async () => {
    mocks.dbRows.mockResolvedValue([]);
    const res = await call(ID);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Task not found" });
    expect(mocks.dbWhere).toHaveBeenCalledTimes(1);
  });

  it("returns the task when found", async () => {
    mocks.dbRows.mockResolvedValue([
      {
        id: ID,
        name: "x",
        status: "todo",
        priority: "high",
        description: null,
        isFavorite: false,
        dueAt: new Date("2026-10-13T23:59:59Z"),
        startedAt: null,
        completedAt: null,
        createdAt: new Date("2026-10-01T00:00:00Z"),
        categoryId: "c",
        categoryKey: "dev",
        categoryName: "Dev",
      },
    ]);
    const body = await (await call(ID)).json();
    expect(body.task).toMatchObject({ id: ID, dueDate: "2026-10-13", categoryKey: "dev" });
  });
});

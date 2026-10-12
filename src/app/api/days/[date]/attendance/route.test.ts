import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  updateAttendanceTimes: vi.fn(),
  setReviewed: vi.fn(),
  getSheetsClient: vi.fn(),
  executeSync: vi.fn(),
  getSyncConfig: vi.fn(),
  dbSet: vi.fn(),
  dbWhere: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));
vi.mock("@/features/attendance/service", () => ({
  updateAttendanceTimes: mocks.updateAttendanceTimes,
}));
vi.mock("@/features/daily-summary/service", () => ({
  setReviewed: mocks.setReviewed,
}));
vi.mock("@/features/sheets-sync/google", () => ({
  getSheetsClient: mocks.getSheetsClient,
}));
vi.mock("@/features/sheets-sync/service", () => ({
  executeSync: mocks.executeSync,
  getSyncConfig: mocks.getSyncConfig,
}));
vi.mock("@/server/db", () => ({
  db: {
    update: () => ({
      set: (v: unknown) => {
        mocks.dbSet(v);
        return { where: mocks.dbWhere };
      },
    }),
  },
}));

import { POST } from "./route";

const closed = {
  id: "att-1",
  workDate: "2026-10-12",
  status: "closed",
  clockInAt: "2026-10-12T01:00:00.000Z",
  clockOutAt: "2026-10-12T10:00:00.000Z",
};

function post(body: unknown, date = "2026-10-12") {
  return POST(
    new Request(`http://localhost/api/days/${date}/attendance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ date }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.auth.mockResolvedValue({
    user: { id: "user-1", timezone: "Asia/Jakarta" },
    accessToken: "tok",
  });
  mocks.updateAttendanceTimes.mockResolvedValue(closed);
  mocks.getSyncConfig.mockResolvedValue({
    spreadsheetId: "sheet-1",
    mapping: {},
  });
  mocks.getSheetsClient.mockResolvedValue({});
  mocks.setReviewed.mockResolvedValue({ reviewState: "reviewed" });
  mocks.executeSync.mockResolvedValue({
    status: "success",
    changedCells: [],
    idempotent: true,
  });
  mocks.dbWhere.mockResolvedValue(undefined);
});

describe("POST /api/days/[date]/attendance", () => {
  it("returns 400 for an invalid date", async () => {
    const res = await post({}, "2026-13-99");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON.stringify({ error: "Invalid date" }));
  });

  it("returns 401 without a session", async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await post({});
    expect(res.status).toBe(401);
  });

  it("does not sync when the attendance stays open", async () => {
    mocks.updateAttendanceTimes.mockResolvedValue({ ...closed, status: "open" });
    const res = await post({ action: "update" });
    expect(await res.text()).toBe(
      JSON.stringify({
        attendance: { ...closed, status: "open" },
        autoSync: { attempted: false },
      }),
    );
    expect(mocks.getSyncConfig).not.toHaveBeenCalled();
  });

  it("syncs a closed day and wraps the attendance", async () => {
    const res = await post({ status: "closed" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      JSON.stringify({
        attendance: closed,
        autoSync: {
          attempted: true,
          success: true,
          idempotent: true,
          changedCount: 0,
        },
      }),
    );
    expect(mocks.setReviewed).toHaveBeenCalledWith(
      "user-1",
      "2026-10-12",
      "Asia/Jakarta",
    );
    expect(mocks.executeSync).toHaveBeenCalledWith("user-1", "2026-10-12", {
      accessToken: "tok",
    });
  });

  it("does not attempt when autoSyncOnClockOut is false or client missing", async () => {
    mocks.getSyncConfig.mockResolvedValue({
      spreadsheetId: "sheet-1",
      mapping: { autoSyncOnClockOut: false },
    });
    expect((await (await post({})).json()).autoSync).toEqual({
      attempted: false,
    });
    mocks.getSyncConfig.mockResolvedValue({ spreadsheetId: "s", mapping: {} });
    mocks.getSheetsClient.mockResolvedValue(null);
    expect((await (await post({})).json()).autoSync).toEqual({
      attempted: false,
    });
    expect(mocks.executeSync).not.toHaveBeenCalled();
  });

  it("resets the day to ready on failure", async () => {
    mocks.executeSync.mockRejectedValue(new Error("Sheets 500"));
    const res = await post({});
    expect(await res.text()).toBe(
      JSON.stringify({
        attendance: closed,
        autoSync: { attempted: true, success: false, message: "Sheets 500" },
      }),
    );
    expect(mocks.dbSet).toHaveBeenCalledWith({
      reviewState: "ready",
      reviewedAt: null,
      updatedAt: expect.any(Date),
    });
  });

  it("returns 400 when the update fails", async () => {
    mocks.updateAttendanceTimes.mockRejectedValue(new Error("bad times"));
    const res = await post({});
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON.stringify({ error: "bad times" }));
  });
});
